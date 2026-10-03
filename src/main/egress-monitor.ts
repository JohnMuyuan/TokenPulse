import { dataFile, readJson, writeJson } from "../core/paths";
import { defaults, DOMAINS, EgressTracker, INTERVAL_MS, probeExit, PROVIDERS, ruleFor, validateConfig, type EgressConfig, type EgressEvent, type Probe, type Provider } from "../core/egress";
import { isFresh, lookupIp, readIntelCache, storeIntel, type IpIntel } from "../core/ip-intel";

type Options = { probe?: typeof probeExit; lookup?: (ip: string) => Promise<IpIntel>; publish?: (snapshot: unknown) => void; notify?: (event: EgressEvent) => void; now?: () => number };
/** 同一个 IP 手动「重新查询」至少隔这么久：几家免费数据库都有每日额度。 */
const INTEL_MANUAL_GAP_MS = 60_000;
export class ExitMonitor {
  private config = defaults();
  private trackers = new Map(PROVIDERS.map(p => [p, new EgressTracker()]));
  private events: EgressEvent[] = [];
  private configError = "";
  private storageError = false;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private abort?: AbortController;
  private epoch = 0;
  private lastStarted = -Infinity;
  private stopped = false;
  private now: () => number;
  /** 出口 IP 的归属 / 类型 / 风险（见 ip-intel.ts），按 IP 缓存，跨重启保留。 */
  private intel = new Map<string, IpIntel>();
  private intelLoading = new Set<string>();
  private intelManualAt = new Map<string, number>();
  /** 额度查询被拦下来的那几家（出口 IP 不在白名单里 / 确认不了出口）。界面上额度卡片据此提示。 */
  private quotaBlocks = new Map<Provider, { at: number; host: string; ip?: string; region?: string; reason: "ip_mismatch" | "probe_failed"; key: string }>();
  constructor(private options: Options = {}) {
    this.now = options.now ?? Date.now;
    for (const entry of Object.values(readIntelCache().entries)) this.intel.set(entry.ip, entry);
    const stored = readJson<unknown>(dataFile("egress-settings.json"), null);
    if (stored) { try { this.config = validateConfig(stored); } catch { this.configError = "保存的配置无效，已暂停监控，请重新保存。"; } }
    const history = readJson<unknown>(dataFile("egress-history.json"), []);
    if (Array.isArray(history)) this.events = history.filter(e => e && PROVIDERS.includes(e.provider) && typeof e.at === "number" && typeof e.message === "string").slice(0, 50);
  }
  snapshot() {
    // 只把当前卡片上用得到的 IP 发给界面（当前出口和「上次有效出口」）
    const ips = new Set<string>();
    for (const tracker of this.trackers.values()) for (const ip of [tracker.row?.ip, tracker.row?.lastGood?.ip]) if (ip) ips.add(ip);
    const intel = Object.fromEntries([...ips].filter((ip) => this.intel.has(ip)).map((ip) => [ip, this.intel.get(ip)!]));
    const quotaBlocks = Object.fromEntries([...this.quotaBlocks].map(([p, { key: _key, ...block }]) => [p, block]));
    return { now: this.now(), intervalMs: this.config.intervalSeconds * 1000, checking: Boolean(this.running), intel, quotaBlocks, intelLoading: [...this.intelLoading].filter((ip) => ips.has(ip)), nextCheckAt: this.config.enabled && Number.isFinite(this.lastStarted) ? this.lastStarted + this.config.intervalSeconds * 1000 : null, config: structuredClone(this.config), configError: this.configError, storageError: this.storageError,
      providers: PROVIDERS.map(provider => ({ provider, ...DOMAINS[provider], ...this.config.providers[provider], policy: ruleFor(provider, this.config.providers[provider].host), row: this.trackers.get(provider)!.row ?? null })), events: this.events.slice() };
  }
  private publish() { this.options.publish?.(this.snapshot()); }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.schedule();
    if (this.config.enabled) void this.check();
  }
  /** 按设置的间隔定时检测；间隔改了重新定时。 */
  private schedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { if (this.config.enabled) void this.check(); }, this.config.intervalSeconds * 1000);
    this.timer.unref();
  }
  stop() { this.stopped = true; this.epoch++; this.abort?.abort(); if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  save(value: unknown) {
    const next = validateConfig(value);
    writeJson(dataFile("egress-settings.json"), next);
    this.epoch++; this.abort?.abort();
    for (const p of PROVIDERS) if (next.enabled !== this.config.enabled || JSON.stringify(next.providers[p]) !== JSON.stringify(this.config.providers[p])) this.trackers.set(p, new EgressTracker());
    const retime = next.intervalSeconds !== this.config.intervalSeconds;
    this.config = next; this.configError = ""; this.lastStarted = -Infinity;
    if (retime && this.timer) this.schedule();
    this.publish();
    if (next.enabled) { if (this.running) void this.running.then(() => this.check()); else void this.check(); }
    return this.snapshot();
  }
  /**
   * 新出现的出口 IP 拿去查归属和风险。不阻塞探测：查完再推一次界面。
   * 已经查过、还没过期的不查（proxycheck 不带 Key 每天约 100 次，出口在几个 IP 之间来回跳也不会刷爆）。
   */
  private lookupNew(rows: Probe[], force = false) {
    // 关掉了就不自动查；用户点「重新查询」是明确要查（force）
    if (!this.config.ipIntel && !force) return;
    const ips = new Set(rows.filter((row) => !row.error && row.ip).map((row) => row.ip!));
    for (const ip of ips) {
      if (this.intelLoading.has(ip) || (!force && isFresh(this.intel.get(ip), this.now()))) continue;
      this.intelLoading.add(ip);
      void (this.options.lookup ?? lookupIp)(ip)
        .then((entry) => {
          this.intel.set(ip, entry);
          try { storeIntel(entry); } catch { /* 写不进缓存下次再查，不影响显示 */ }
        })
        .catch(() => { /* 几家都查不到：界面照样显示探测结果，只是没有归属信息 */ })
        .finally(() => { this.intelLoading.delete(ip); if (!this.stopped) this.publish(); });
    }
    if (ips.size) this.publish();
  }
  /**
   * 向官方问额度之前的放行检查（quota.ts 的 QuotaGate）。
   * - 这一家没设 IP 白名单：放行（没有规则可比）；
   * - 设了：用 10 秒内的探测结果，没有就现探一次；出口 IP 在白名单里才放行。
   *   探测失败也不放行 —— 确认不了从哪儿出去，就别拿账号去问官方。
   * 不管监控开没开都检查：白名单是用户定的规矩。被拦时记一条告警、按设置弹通知（同一种情况只弹一次），放行后记一条恢复。
   */
  async gateQuota(provider: Provider): Promise<boolean> {
    const config = this.config.providers[provider];
    if (!config?.allowedIps.length) { this.quotaBlocks.delete(provider); return true; }
    const row = this.trackers.get(provider)?.row;
    const recent = row && !row.error && row.host === config.host && this.now() - row.checkedAt < 10_000;
    let probe: Probe;
    try { probe = recent ? row! : await (this.options.probe ?? probeExit)(provider, config.host); }
    catch { probe = { provider, host: config.host, checkedAt: this.now(), latencyMs: 0, error: "network" }; }
    const ok = !probe.error && probe.ip != null && config.allowedIps.includes(probe.ip);
    const previous = this.quotaBlocks.get(provider);
    if (ok) {
      if (previous) {
        this.quotaBlocks.delete(provider);
        this.record({ at: this.now(), provider, host: config.host, type: "recovery", message: "出口 IP 已回到允许列表，额度查询恢复", ip: probe.ip, region: probe.region }, true);
      }
      return true;
    }
    const reason = probe.error ? "probe_failed" : "ip_mismatch";
    const key = `${reason}|${probe.ip ?? ""}`;
    this.quotaBlocks.set(provider, { at: this.now(), host: config.host, ip: probe.ip, region: probe.region, reason, key });
    if (previous?.key !== key) {
      this.record({ at: this.now(), provider, host: config.host, type: "warning", message: reason === "probe_failed" ? "已拦截额度查询：无法确认出口 IP" : "已拦截额度查询：出口 IP 不在允许列表内", ip: probe.ip, region: probe.region }, true);
    } else this.publish();
    return false;
  }
  /**
   * 启动这一家的 CLI 之前要核对的出口规则（0.3.16）。返回 null 就是不检测、直接启动：
   * - 出口监控没开：不检测（用户定的：监控关着就不核对出口）；
   * - 开着，但这一家两个白名单都没设：不检测；
   * - 开着，设了 IP 白名单：只看 IP；没设 IP、设了地区白名单：看地区。
   * 注意和额度查询的放行（gateQuota）不一样：那边只看白名单，不看监控开没开。
   */
  launchRule(provider: Provider): { host: string; allowedIps: string[]; allowedRegions: string[] } | null {
    if (!this.config.enabled) return null;
    const config = this.config.providers[provider];
    return config && (config.allowedIps.length || config.allowedRegions.length) ? { host: config.host, allowedIps: [...config.allowedIps], allowedRegions: [...config.allowedRegions] } : null;
  }
  /**
   * TokenPulse 自己直接启动 CLI（在软件里回复对话）之前的放行检查（0.3.16）：
   * 没有规则放行；有就现测一次（不用旧结果），符合才放行，测不出来也不放行。
   * 这里的 curl 和接下来启动的 CLI 用的是同一份环境变量，走的是同一条路。被拦时记一条告警。
   */
  async gateLaunch(provider: Provider, what: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const rule = this.launchRule(provider);
    if (!rule) return { ok: true };
    const byIp = rule.allowedIps.length > 0;
    let probe: Probe;
    try { probe = await (this.options.probe ?? probeExit)(provider, rule.host); }
    catch { probe = { provider, host: rule.host, checkedAt: this.now(), latencyMs: 0, error: "network" }; }
    const seen = probe.error ? undefined : byIp ? probe.ip : probe.region;
    if (seen != null && (byIp ? rule.allowedIps : rule.allowedRegions).includes(seen)) return { ok: true };
    const subject = byIp ? "出口 IP" : "出口地区";
    const message = seen == null ? `没能确认${subject}，已拒绝启动 ${what}。请检查网络或代理后重试。` : `${subject} ${seen} 不在${byIp ? "" : "地区"}白名单里，已拒绝启动 ${what}。`;
    this.record({ at: this.now(), provider, host: rule.host, type: "warning", message: seen == null ? `已拒绝启动 CLI：无法确认${subject}` : byIp ? "已拒绝启动 CLI：出口 IP 不在允许列表内" : "已拒绝启动 CLI：出口地区不在允许列表内", ip: probe.ip, region: probe.region }, false);
    return { ok: false, message };
  }
  /** 记一条变化 / 告警：进历史、按设置弹通知、推给界面。 */
  private record(event: EgressEvent, notify: boolean) {
    this.events.unshift(event);
    this.events = this.events.slice(0, 50);
    try { writeJson(dataFile("egress-history.json"), this.events); this.storageError = false; } catch { this.storageError = true; }
    if (notify && this.config.notifications) { try { this.options.notify?.(event); } catch { /* 系统通知不可用，页内记录仍保留 */ } }
    this.publish();
  }
  /** 界面上的「重新查询」：同一个 IP 一分钟一次。 */
  refreshIntel(ip: unknown) {
    if (typeof ip !== "string" || ip.length > 64) throw new Error("IP 无效");
    const known = [...this.trackers.values()].some((tracker) => tracker.row?.ip === ip || tracker.row?.lastGood?.ip === ip);
    if (!known) throw new Error("只能查询当前检测到的出口 IP");
    if (this.now() - (this.intelManualAt.get(ip) ?? -Infinity) < INTEL_MANUAL_GAP_MS) throw new Error("刚查过，请一分钟后再试");
    this.intelManualAt.set(ip, this.now());
    this.lookupNew([{ provider: "chatgpt", host: "", checkedAt: this.now(), latencyMs: 0, ip }], true);
    return this.snapshot();
  }
  clearHistory() { writeJson(dataFile("egress-history.json"), []); this.events = []; this.storageError = false; this.publish(); return this.snapshot(); }
  async check(manual = false) {
    if (this.running) { await this.running; return this.snapshot(); }
    if (this.stopped || (!this.config.enabled && !manual) || this.now() - this.lastStarted < INTERVAL_MS) return this.snapshot();
    const epoch = this.epoch, config = structuredClone(this.config);
    this.lastStarted = this.now(); this.abort = new AbortController();
    const signal = this.abort.signal;
    this.running = (async () => {
      const rows = await Promise.all(PROVIDERS.map(async p => {
        try { return await (this.options.probe ?? probeExit)(p, config.providers[p].host, signal); }
        catch { return { provider: p, host: config.providers[p].host, checkedAt: this.now(), latencyMs: 0, error: "network" } as Probe; }
      }));
      if (epoch !== this.epoch || this.stopped) return;
      let changed = false;
      for (const probe of rows) {
        const result = this.trackers.get(probe.provider)!.accept(probe, config.providers[probe.provider]);
        for (const event of result.events) {
          this.events.unshift(event); changed = true;
          if (config.notifications && event.type !== "change") { try { this.options.notify?.(event); } catch { /* 系统通知不可用，页内记录仍保留 */ } }
        }
      }
      if (changed) {
        this.events = this.events.slice(0, 50);
        try { writeJson(dataFile("egress-history.json"), this.events); this.storageError = false; } catch { this.storageError = true; }
      }
      this.lookupNew(rows);
    })().finally(() => { this.running = undefined; if (!this.stopped) this.publish(); });
    this.publish();
    await this.running;
    return this.snapshot();
  }
}
