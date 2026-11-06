import fs from "fs";
import path from "path";
import { antigravityDir, antigravityHub, fetchAntigravityStatus, type AgyQuotaGroup, type AgyStatus } from "../core/antigravity";
import { errorText, log } from "../core/app-log";
import { dataFile, readJson, writeJson } from "../core/paths";

/**
 * Google Antigravity 的额度监控。
 *
 * 额度只能问本机的 Antigravity（language server，见 core/antigravity.ts），所以 Antigravity 开着时才查得到；
 * 关着的时候显示最后一次查到的，并说明是什么时候的。和官方订阅、DeepSeek 余额共用 prefs 里的查询间隔。
 *
 * Antigravity 的额度不是「5 小时 + 周」两个窗口，而是按型号分组：几个型号共用一份，各自重置（目前约 5 小时）。
 * 一组一个键（组里的型号名排序后拼起来），历史按组记，提醒也按组。
 *
 * 存盘（antigravity-quota.json）：最后一次结果 + 最近 30 天的采样 + 每组提醒过的那个窗口。不存令牌、邮箱、名字。
 */

export type AgyGroupState = AgyQuotaGroup & { key: string };
export type AgyLast = { at: number; ok: boolean; error?: string; plan?: string; tier?: string; groups: AgyGroupState[] };
export type AgySample = { at: number; groups: { key: string; used: number; resetAt?: string }[] };
export type AgyQuotaState = {
  /** 本机装了 Antigravity（有它的数据目录）。没装的话界面上不出现。 */
  installed: boolean;
  /** 上一次查的时候 Antigravity 开着。 */
  running: boolean;
  loading: boolean;
  last?: AgyLast;
  /** 最近 7 天的采样，画走势用。 */
  history: AgySample[];
};
type Stored = { last?: AgyLast; history: AgySample[]; notified: Record<string, number> };

const KEEP_MS = 30 * 86_400_000;
const SHOW_MS = 7 * 86_400_000;
/** 一样的结果最多隔这么久记一条采样，免得一直开着时一分钟一条。 */
const SAMPLE_EVERY_MS = 10 * 60_000;
/** 同一个窗口：重置时间相差不到这么多就算一个（各次返回的时间会有一点抖动）。 */
const SAME_WINDOW_MS = 10 * 60_000;

export const groupKey = (models: string[]) => [...models].sort().join("|");

export class AntigravityQuota {
  private stored: Stored;
  private loading = false;
  private running = false;
  private pending?: Promise<AgyQuotaState>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private readonly file = dataFile("antigravity-quota.json");
  private readonly fetcher: () => Promise<AgyStatus | null>;
  private readonly now: () => number;

  constructor(private options: {
    publish?: (state: AgyQuotaState) => void;
    /** 一组额度过了提醒线（百分比）：title 用的型号名、已用、重置时间。 */
    notify?: (models: string[], used: number, resetAt?: string) => void;
    notifyAt?: () => number;
    fetcher?: () => Promise<AgyStatus | null>;
    now?: () => number;
  } = {}) {
    this.fetcher = options.fetcher ?? fetchAntigravityStatus;
    this.now = options.now ?? Date.now;
    const raw = readJson<Partial<Stored> | null>(this.file, null);
    this.stored = { last: raw?.last, history: Array.isArray(raw?.history) ? raw.history : [], notified: raw?.notified && typeof raw.notified === "object" ? raw.notified : {} };
    this.running = Boolean(antigravityHub());
  }

  installed() {
    return fs.existsSync(antigravityDir()) || Boolean(this.stored.last);
  }

  state(): AgyQuotaState {
    const since = this.now() - SHOW_MS;
    return { installed: this.installed(), running: this.running, loading: this.loading, ...(this.stored.last ? { last: this.stored.last } : {}), history: this.stored.history.filter((sample) => sample.at >= since) };
  }

  start() { this.stopped = false; }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  reschedule(everyMs: number) {
    if (this.timer) clearInterval(this.timer);
    const ms = Math.max(30_000, everyMs);
    this.timer = setInterval(() => { void this.refresh(false); }, ms);
    this.timer.unref?.();
  }

  private publish() { if (!this.stopped) this.options.publish?.(this.state()); }
  private save() { try { writeJson(this.file, this.stored); } catch { /* 存不下来：这次的结果还在内存里 */ } }

  /** 查一次。同时只跑一个；没装 Antigravity 的不查。manual：用户点了刷新，查不到也要把原因告诉界面。 */
  refresh(manual: boolean): Promise<AgyQuotaState> {
    if (this.pending) return this.pending;
    if (!manual && !fs.existsSync(antigravityDir())) return Promise.resolve(this.state());
    this.pending = this.refreshNow(manual).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async refreshNow(manual: boolean): Promise<AgyQuotaState> {
    this.loading = true;
    if (manual) this.publish();
    const at = this.now();
    try {
      const status = await this.fetcher();
      this.running = Boolean(status);
      if (!status) {
        // Antigravity 没开：留着上一次的数，只在手动刷新时记一条「没开」
        if (manual) this.stored.last = { ...(this.stored.last ?? { groups: [] }), at: this.stored.last?.at ?? at, ok: this.stored.last?.ok ?? false, error: "Antigravity 没有在运行，打开它之后才能查到额度" };
      } else {
        const groups = status.groups.map((group) => ({ ...group, key: groupKey(group.models) }));
        this.stored.last = { at, ok: true, plan: status.plan || undefined, tier: status.tier, groups };
        this.record(at, groups);
        this.check(groups);
      }
    } catch (error) {
      this.running = Boolean(antigravityHub());
      log.warn("antigravity", "额度查询失败：" + errorText(error));
      this.stored.last = { ...(this.stored.last ?? { groups: [] }), at: this.stored.last?.ok ? this.stored.last.at : at, ok: false, error: error instanceof Error ? error.message : "查询失败" };
    } finally {
      this.loading = false;
      this.save();
      this.publish();
    }
    // 在 finally 之后取状态：界面拿这个返回值覆盖自己的，不能还带着「正在查询」
    return this.state();
  }

  /** 记一条采样：和上一条不一样、或者隔了 10 分钟以上才记。 */
  private record(at: number, groups: AgyGroupState[]) {
    const sample: AgySample = { at, groups: groups.map((group) => ({ key: group.key, used: group.used, ...(group.resetAt ? { resetAt: group.resetAt } : {}) })) };
    const previous = this.stored.history.at(-1);
    const same = previous && JSON.stringify(previous.groups.map((g) => [g.key, g.used])) === JSON.stringify(sample.groups.map((g) => [g.key, g.used]));
    if (same && at - previous.at < SAMPLE_EVERY_MS) return;
    this.stored.history.push(sample);
    const since = at - KEEP_MS;
    this.stored.history = this.stored.history.filter((item) => item.at >= since).slice(-5000);
  }

  /** 一组过了提醒线：每个窗口提醒一次。 */
  private check(groups: AgyGroupState[]) {
    const limit = this.options.notifyAt?.() ?? 0;
    if (!limit) return;
    for (const group of groups) {
      if (group.used < limit) continue;
      const resetAt = group.resetAt ? Date.parse(group.resetAt) || 0 : 0;
      const previous = this.stored.notified[group.key];
      if (previous != null && Math.abs(resetAt - previous) < SAME_WINDOW_MS) continue;
      this.stored.notified[group.key] = resetAt;
      this.options.notify?.(group.models, group.used, group.resetAt);
    }
  }
}

/** 测试用：存盘的位置。 */
export const antigravityQuotaFile = () => path.join(dataFile("antigravity-quota.json"));
