/*
 * 第三方中转站的余额查询（0.3.42）。用户自己买的 Key，填站点地址和 Key，TokenPulse 帮着看余额。
 *
 * 查余额没有统一的接口，这里认两种最常见的：
 * - sub2api：GET <站点>/v1/usage（专门给这类工具查余额用的，只校验 Key、不计费）。回复里有余额或订阅 / Key 自己的额度、
 *   限速窗口、到期时间，还有这个 Key 今天 / 累计 / 每天的用量。格式按 sub2api 的 gateway_handler.go（Usage）写的，实测过钱包余额模式。
 * - new-api / one-api：兼容 OpenAI 老的账单接口，GET <站点>/v1/dashboard/billing/subscription（总额度）和
 *   /v1/dashboard/billing/usage（已用，单位是美分）。这一种是照它们的公开实现写的，**没有拿真实站点测过**。
 *
 * 先试上次认出来的那种，认不出来再试另一种；两种都不是就说明这个站不支持用 Key 查余额，不编数字。
 * Key 只发给用户填的那个地址。这里不联网：发请求的函数由调用方给（deepseek-balance.ts）。
 */

export type RelayFlavor = "sub2api" | "newapi";
export type RelayWindow = { name: string; limit: number; used: number; remaining: number; resetAt?: number };
export type RelayUsage = { requests: number; tokens: number; cost: number };
export type RelayExtra = {
  flavor: RelayFlavor;
  /** 站点给的套餐名（「钱包余额」、订阅分组的名字）。 */
  plan?: string;
  /** 订阅没有配任何上限，或者 Key 是不限额的。 */
  unlimited?: boolean;
  /** Key 自己的总额度。 */
  quota?: { limit: number; used: number; remaining: number };
  /** 有上限的窗口：Key 的限速（5h / 1d / 7d）或订阅的日 / 周 / 月限额（daily / weekly / monthly）。 */
  windows?: RelayWindow[];
  expiresAt?: number;
  /** 站点自己统计的这个 Key 的用量。 */
  today?: RelayUsage; total?: RelayUsage;
  daily?: ({ date: string } & RelayUsage)[];
};
export type RelayBalance = { available: boolean; remaining: number | null; currency: string; extra: RelayExtra };
export type HttpGet = (url: string, key: string) => Promise<{ status: number; body: string }>;

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null);
const time = (value: unknown) => { const at = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : NaN; return Number.isFinite(at) && at > 0 ? at : undefined; };
const text = (value: unknown, max = 60) => (typeof value === "string" ? value.replace(/\p{Cc}/gu, " ").trim().slice(0, max) : "");
const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const usageOf = (value: unknown): RelayUsage | undefined => {
  const row = record(value);
  if (!row) return undefined;
  return { requests: num(row.requests) ?? 0, tokens: num(row.total_tokens) ?? 0, cost: num(row.actual_cost) ?? num(row.cost) ?? 0 };
};

/** 站点地址：去掉结尾的斜杠和 /v1（很多人会把接口地址连 /v1 一起贴过来）。只认 https；http 只允许本机（自己搭的、测试用的）。 */
export function relayBase(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); } catch { throw new Error("站点地址不对，应该像 https://example.com"); }
  if (!raw || !url.hostname.includes(".") && url.hostname !== "localhost") throw new Error("站点地址不对，应该像 https://example.com");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("站点地址要用 https（Key 会发到这个地址，不能明文传）");
  if (url.username || url.password) throw new Error("站点地址里不要带用户名和密码");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
  return url.origin + path;
}

/** sub2api 的 /v1/usage。不是这种格式返回 null。 */
export function parseSub2api(body: string): RelayBalance | null {
  let json: Record<string, unknown> | null;
  try { json = record(JSON.parse(body)); } catch { return null; }
  if (!json || typeof json.isValid !== "boolean" || typeof json.mode !== "string") return null;
  const extra: RelayExtra = { flavor: "sub2api" };
  const plan = text(json.planName);
  if (plan) extra.plan = plan;
  const quota = record(json.quota);
  if (quota && num(quota.limit) != null) extra.quota = { limit: num(quota.limit)!, used: num(quota.used) ?? 0, remaining: Math.max(0, num(quota.remaining) ?? 0) };
  const windows: RelayWindow[] = [];
  for (const raw of Array.isArray(json.rate_limits) ? json.rate_limits.slice(0, 8) : []) {
    const row = record(raw), limit = num(row?.limit);
    if (!row || !limit || limit <= 0 || !text(row.window, 12)) continue;
    const used = num(row.used) ?? 0;
    windows.push({ name: text(row.window, 12), limit, used, remaining: Math.max(0, num(row.remaining) ?? limit - used), ...(time(row.reset_at) ? { resetAt: time(row.reset_at) } : {}) });
  }
  const subscription = record(json.subscription);
  if (subscription) {
    for (const name of ["daily", "weekly", "monthly"]) {
      const limit = num(subscription[name + "_limit_usd"]);
      if (!limit || limit <= 0) continue;
      const used = num(subscription[name + "_usage_usd"]) ?? 0;
      windows.push({ name, limit, used, remaining: Math.max(0, limit - used) });
    }
    if (time(subscription.expires_at)) extra.expiresAt = time(subscription.expires_at);
  }
  if (windows.length) extra.windows = windows;
  if (time(json.expires_at)) extra.expiresAt = time(json.expires_at);
  const usage = record(json.usage);
  if (usage) { extra.today = usageOf(usage.today); extra.total = usageOf(usage.total); }
  if (Array.isArray(json.daily_usage)) {
    const daily = json.daily_usage.slice(-90).map((raw) => { const row = record(raw), usageRow = usageOf(raw); return row && usageRow && /^\d{4}-\d{2}-\d{2}/.test(text(row.date, 10)) ? { date: text(row.date, 10), ...usageRow } : null; });
    extra.daily = daily.filter((row): row is { date: string } & RelayUsage => row !== null);
  }
  // remaining：钱包余额 / Key 剩余额度 / 订阅里最紧的那个限额还剩多少；-1 = 订阅没有配上限
  const remaining = num(json.remaining) ?? num(json.balance);
  if (remaining != null && remaining < 0) extra.unlimited = true;
  const left = remaining != null && remaining >= 0 ? remaining : null;
  return { available: json.isValid === true && left !== 0, remaining: left, currency: /^[A-Z]{3}$/.test(text(json.unit, 3)) ? text(json.unit, 3) : "USD", extra };
}

/** new-api / one-api 的账单接口：subscription 给总额度，usage 给已用（美分）。 */
export function parseNewApi(subscription: string, usage: string | null): RelayBalance | null {
  let sub: Record<string, unknown> | null, used: Record<string, unknown> | null = null;
  try { sub = record(JSON.parse(subscription)); } catch { return null; }
  const limit = num(sub?.hard_limit_usd);
  if (!sub || limit == null) return null;
  if (usage) { try { used = record(JSON.parse(usage)); } catch { used = null; } }
  const spent = num(used?.total_usage) != null ? num(used!.total_usage)! / 100 : null;
  const extra: RelayExtra = { flavor: "newapi" };
  // 不限额的 Key 这类站会报一个一亿美元的总额度
  if (limit >= 100_000_000) { extra.unlimited = true; return { available: true, remaining: null, currency: "USD", extra }; }
  if (spent == null) return null;
  const remaining = Math.max(0, limit - spent);
  extra.quota = { limit, used: spent, remaining };
  if (time(typeof sub.access_until === "number" && sub.access_until > 0 ? sub.access_until * 1000 : undefined)) extra.expiresAt = (sub.access_until as number) * 1000;
  return { available: remaining > 0, remaining, currency: "USD", extra };
}

export type RelayQuery = { ok: true; balance: RelayBalance } | { ok: false; error: string; invalidKey?: boolean };
export const RELAY_INVALID_KEY = "API Key 无效或已被删除，请换一个";
export const RELAY_UNSUPPORTED = "这个站点不支持用 Key 查余额（试过 sub2api 和 new-api 两种接口）";

/** 查一次。prefer：上次认出来的那种，先试它。 */
export async function queryRelay(base: string, key: string, get: HttpGet, prefer?: RelayFlavor): Promise<RelayQuery> {
  let denied = false, limited = false, serverError = 0;
  const note = (status: number) => { if (status === 401 || status === 403) denied = true; else if (status === 429) limited = true; else if (status >= 500) serverError = status; };
  const sub2api = async (): Promise<RelayBalance | null> => {
    const reply = await get(base + "/v1/usage?days=30", key);
    note(reply.status);
    return reply.status === 200 ? parseSub2api(reply.body) : null;
  };
  const newapi = async (): Promise<RelayBalance | null> => {
    const sub = await get(base + "/v1/dashboard/billing/subscription", key);
    note(sub.status);
    if (sub.status !== 200) return null;
    const used = await get(base + "/v1/dashboard/billing/usage", key);
    note(used.status);
    return parseNewApi(sub.body, used.status === 200 ? used.body : null);
  };
  for (const attempt of prefer === "newapi" ? [newapi, sub2api] : [sub2api, newapi]) {
    const balance = await attempt();
    if (balance) return { ok: true, balance };
  }
  if (denied) return { ok: false, error: RELAY_INVALID_KEY, invalidKey: true };
  if (limited) return { ok: false, error: "查得太频繁了，稍后会自动再查" };
  if (serverError) return { ok: false, error: `站点返回了 HTTP ${serverError}` };
  return { ok: false, error: RELAY_UNSUPPORTED };
}
