import { execFile } from "child_process";
import { promisify } from "util";
import { isIP } from "net";
import fs from "fs";
import path from "path";
import { curlBin } from "./curl";
import { curlProxyArgs } from "./upstream-proxy";

export const PROVIDERS = ["chatgpt", "claude", "grok"] as const;
export type Provider = typeof PROVIDERS[number];
/** 两轮检测至少隔这么久（手动「立即检测」也一样）。 */
export const INTERVAL_MS = 5000;
/** 自动检测的间隔（0.3.16 起可以自己定）：最少 5 秒、最多 60 秒，默认 10 秒。 */
export const INTERVAL_SECONDS = { min: 5, max: 60, default: 10 } as const;
export type ProviderConfig = { host: string; allowedIps: string[]; allowedRegions: string[] };
/** ipIntel：出口 IP 变了时，拿去几个公开的 IP 数据库查归属、类型和风险评分（会把出口 IP 发给它们，见 ip-intel.ts）。 */
export type EgressConfig = { enabled: boolean; notifications: boolean; ipIntel: boolean; /** 每隔多少秒自动检测一轮。 */ intervalSeconds: number; providers: Record<Provider, ProviderConfig> };
export type DomainInfo = { name: string; hosts: string[]; defaultHost: string; rules: string[]; ruleSource: string };
export const DOMAINS: Record<Provider, DomainInfo> = JSON.parse(fs.readFileSync(path.join(__dirname, "../../knowledge/egress-domains.json"), "utf8"));
export type RegionRule = { status: "verified" | "unverified"; source: string; checkedAt?: string; countries?: string[]; partialCountries?: string[]; scope?: string };
export const REGION_RULES: Record<string, RegionRule> = JSON.parse(fs.readFileSync(path.join(__dirname, "../../knowledge/egress-regions.json"), "utf8"));
export type Probe = { provider: Provider; host: string; checkedAt: number; latencyMs: number; ip?: string; region?: string; error?: string };
export type EgressEvent = { at: number; provider: Provider; host: string; type: "warning" | "recovery" | "change"; message: string; ip?: string; region?: string; previousIp?: string };
export type RegionStatus = "supported" | "unsupported" | "partial" | "unknown";
export type EgressRow = Probe & { status: "checking" | "ok" | "unconfigured" | "warning" | "unknown"; reasons: string[]; regionStatus: RegionStatus; streak: number; confirmed: boolean; lastGood?: Probe };

export function defaults(): EgressConfig {
  const provider = (p: Provider): ProviderConfig => ({ host: DOMAINS[p].defaultHost, allowedIps: [], allowedRegions: [] });
  return { enabled: false, notifications: true, ipIntel: true, intervalSeconds: INTERVAL_SECONDS.default, providers: { chatgpt: provider("chatgpt"), claude: provider("claude"), grok: provider("grok") } };
}
export function normalizeIp(value: string) {
  const ip = value.trim();
  if (!isIP(ip) || ip.includes("%")) throw new Error("请输入有效的 IPv4 或 IPv6 地址，不支持域名或 CIDR。");
  return isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase() : ip;
}
/** IPC 信任边界：仅允许随包检测域名，不能把它变成任意 URL 请求器。 */
export function validateConfig(value: unknown): EgressConfig {
  const input = value as EgressConfig;
  if (!input || typeof input.enabled !== "boolean" || typeof input.notifications !== "boolean" || !input.providers) throw new Error("出口监控配置无效。");
  if (input.ipIntel !== undefined && typeof input.ipIntel !== "boolean") throw new Error("出口监控配置无效。");
  // 0.3.7 的配置没有这一项：默认开
  const next = defaults(); next.enabled = input.enabled; next.notifications = input.notifications; next.ipIntel = input.ipIntel !== false;
  // 0.3.15 及以前的配置没有这一项：用默认的 10 秒
  if (input.intervalSeconds !== undefined) {
    if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds < INTERVAL_SECONDS.min || input.intervalSeconds > INTERVAL_SECONDS.max) throw new Error(`检测间隔请填 ${INTERVAL_SECONDS.min} 到 ${INTERVAL_SECONDS.max} 之间的整数（秒）。`);
    next.intervalSeconds = input.intervalSeconds;
  }
  for (const p of PROVIDERS) {
    const row = input.providers[p];
    if (!row || !DOMAINS[p].hosts.includes(row.host) || !Array.isArray(row.allowedIps) || !Array.isArray(row.allowedRegions) || row.allowedIps.length > 64 || row.allowedRegions.length > 64) throw new Error("检测域名或白名单无效（每项最多 64 条）。");
    if (row.allowedIps.some(ip => typeof ip !== "string" || ip.length > 64)) throw new Error("IP 白名单无效。");
    const regions = row.allowedRegions.map(code => {
      if (typeof code !== "string" || !/^[a-z]{2}$/i.test(code) || ["XX", "ZZ", "EU", "UN"].includes(code.toUpperCase())) throw new Error("地区请使用两位代码，例如 US、JP。");
      const normalized = code.toUpperCase();
      if (new Intl.DisplayNames(["en"], { type: "region" }).of(normalized) === normalized) throw new Error("地区代码无效。");
      return normalized;
    });
    next.providers[p] = { host: row.host, allowedIps: [...new Set(row.allowedIps.map(normalizeIp))], allowedRegions: [...new Set(regions)] };
  }
  return next;
}
export function ruleFor(provider: Provider, host: string) { return REGION_RULES[provider === "chatgpt" && host === "api.openai.com" ? "openai_api" : provider]; }
export function regionStatus(provider: Provider, host: string, region: string | undefined, now: number): RegionStatus {
  const rule = ruleFor(provider, host);
  if (!region || ["XX", "ZZ", "EU"].includes(region) || !rule || rule.status !== "verified" || !rule.checkedAt || !rule.countries?.length) return "unknown";
  const age = now - Date.parse(rule.checkedAt + "T00:00:00Z");
  if (!Number.isFinite(age) || age < -86400000 || age > 90 * 86400000) return "unknown";
  if (rule.partialCountries?.includes(region)) return "partial";
  return rule.countries.includes(region) ? "supported" : "unsupported";
}
/** 只接受目标域名自己的 trace；拒绝 HTML 挑战、跳转、畸形响应和 IP 检测站替代结果。 */
export function parseTrace(text: string, host: string) {
  if (text.length > 16384) throw new Error("invalid_trace");
  const values = new Map<string, string>();
  for (const line of text.trim().split(/\r?\n/)) {
    const i = line.indexOf("="); if (i < 1) continue;
    const key = line.slice(0, i), value = line.slice(i + 1).trim();
    if (values.has(key)) throw new Error("invalid_trace");
    values.set(key, value);
  }
  if (values.get("h")?.toLowerCase() !== host || !values.get("ip")) throw new Error("invalid_trace");
  let ip: string; try { ip = normalizeIp(values.get("ip")!); } catch { throw new Error("invalid_trace"); }
  const loc = values.get("loc");
  return { ip, region: loc && /^[A-Z]{2}$/.test(loc) && !["XX", "ZZ", "EU"].includes(loc) ? loc : undefined };
}
const exec = promisify(execFile);
export async function probeExit(provider: Provider, host: string, signal?: AbortSignal): Promise<Probe> {
  const start = Date.now();
  const base = () => ({ provider, host, checkedAt: Date.now(), latencyMs: Date.now() - start });
  if (!DOMAINS[provider].hosts.includes(host)) return { ...base(), error: "invalid_host" };
  try {
    // 和查额度的请求走同一条路（环境变量里的代理；没有就按系统代理），这样「出口不对就不查额度」的判断才对得上
    const url = `https://${host}/cdn-cgi/trace?tokenpulse=${start}`;
    const { stdout } = await exec(curlBin(), ["-sS", "--max-time", "4", "--http1.1", "--max-filesize", "16384", ...(await curlProxyArgs(url)), "-H", "Cache-Control: no-cache", "-w", "\n%{http_code}", url], { timeout: 4500, windowsHide: true, maxBuffer: 32768, signal });
    const cut = stdout.lastIndexOf("\n"), status = Number(stdout.slice(cut + 1));
    if (status !== 200) return { ...base(), error: `http_${status}` };
    return { ...base(), ...parseTrace(stdout.slice(0, cut), host) };
  } catch (e) {
    const error = e as { code?: number | string; killed?: boolean; message?: string };
    return { ...base(), error: error.message === "invalid_trace" ? "invalid_trace" : error.code === 28 || error.killed ? "timeout" : error.code === 35 || error.code === 60 ? "tls" : "network" };
  }
}

/** 每家独立去抖：连续两次风险才通知，连续两次恢复才解除；失败不会被当成 IP 变化。 */
export class EgressTracker {
  row?: EgressRow;
  private candidate = "";
  private streak = 0;
  private alerted = "";
  private lastGood?: Probe;
  accept(probe: Probe, config: ProviderConfig): { row: EgressRow; events: EgressEvent[] } {
    const events: EgressEvent[] = [];
    const region = probe.error ? "unknown" : regionStatus(probe.provider, probe.host, probe.region, probe.checkedAt);
    const reasons: string[] = [];
    if (probe.error) reasons.push("probe_failed");
    else {
      if (config.allowedIps.length && (!probe.ip || !config.allowedIps.includes(probe.ip))) reasons.push("ip_mismatch");
      if (region === "unsupported") reasons.push("unsupported_region");
      if (region === "partial") reasons.push("partial_region");
      if (region === "unknown" && ruleFor(probe.provider, probe.host)?.status === "verified") reasons.push("region_unknown");
      if (config.allowedRegions.length && (!probe.region || !config.allowedRegions.includes(probe.region)) && !reasons.includes("region_unknown")) reasons.push(probe.region ? "region_mismatch" : "region_unknown");
    }
    const fingerprint = reasons.length ? reasons.join(",") + (probe.error ? "" : `|${probe.ip}|${probe.region}`) : "safe";
    this.streak = this.candidate === fingerprint ? this.streak + 1 : 1;
    this.candidate = fingerprint;
    const confirmed = this.streak >= 2;
    const event = (type: EgressEvent["type"], message: string): EgressEvent => ({ at: probe.checkedAt, provider: probe.provider, host: probe.host, type, message, ip: probe.ip, region: probe.region });
    if (!probe.error && probe.ip) {
      if (this.lastGood?.ip && this.lastGood.ip !== probe.ip) events.push({ ...event("change", "出口 IP 已变化"), previousIp: this.lastGood.ip });
      this.lastGood = probe;
    }
    if (confirmed && reasons.length && this.alerted !== fingerprint) {
      this.alerted = fingerprint;
      events.push(event("warning", probe.error ? "连续两次检测失败，暂时无法确认出口" : reasons.includes("unsupported_region") ? "出口地区不在已核实的支持清单内" : reasons.includes("ip_mismatch") ? "出口 IP 不在允许列表内" : reasons.includes("partial_region") ? "该国家存在地区限制，无法确认具体位置" : reasons.includes("region_unknown") ? "出口地区或地区规则无法确认，请检查" : "出口地区不符合自定义允许列表"));
    } else if (confirmed && !reasons.length && this.alerted) {
      this.alerted = ""; events.push(event("recovery", "出口检测已恢复，当前配置的告警条件已解除"));
    }
    const status: EgressRow["status"] = probe.error || (reasons.length === 1 && reasons[0] === "region_unknown") ? "unknown" : reasons.length ? "warning" : !config.allowedIps.length ? "unconfigured" : "ok";
    this.row = { ...probe, status, reasons, regionStatus: region, streak: this.streak, confirmed, lastGood: this.lastGood };
    return { row: this.row, events };
  }
}
