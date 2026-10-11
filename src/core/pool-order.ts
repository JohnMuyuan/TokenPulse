/**
 * 号池按额度排成员（0.3.44）：「快重置优先」和「剩余最多」两种轮换方式。
 *
 * 额度来自 quota-history.ts 记下的最近一次采样（每个官方账号按设置里的查询间隔查一次，默认 1 分钟）。
 * 两次查询之间用完了，上游回 429，路由照旧换下一个成员；这里再把回过 429 的账号记一下，
 * 下一次查到它的额度之前（最多 10 分钟）先排到后面，免得每个请求都先撞一次 429。
 *
 * 排序分四段：有额度数据、没用完的（按方式排）→ 没有额度数据的官方账号（查不到、出口被拦）→ API Key 供应商（没有额度可看，当后备）
 * → 已经用完的（谁先恢复谁在前）。各段里分数相同的保持设置里的顺序。
 */
import fs from "fs";
import { dataFile } from "./paths";
import { readQuotaChecks, readQuotaHistory } from "./quota-history";

export type QuotaStrategy = "reset-first" | "most-left";
/** left：剩余百分比（0–100）；resetAt：什么时候重置（毫秒），不知道是 null。 */
export type QuotaWindow = { left: number; resetAt: number | null };
/** at：这份额度是什么时候查到的。 */
export type MemberQuota = { five: QuotaWindow | null; week: QuotaWindow | null; at: number };
export type PoolCandidate = { id: string; type: "account" | "provider"; quota: MemberQuota | null; limitedAt?: number };

/** 剩余不到 1% 算用完。 */
const SPENT = 1;
/** 回过 429 的账号在这之内、又还没查到新额度时先排后面。 */
export const LIMIT_HOLD_MS = 10 * 60_000;
/** 额度采样超过这么久没更新就当没有数据（查询一直失败、出口被拦）。 */
const STALE_MS = 30 * 60_000;
/** 快重置优先：当前在用的号分数不低于最高分的这个比例就继续用。 */
const KEEP_RATIO = 0.8;
/** 剩余最多：别的号要多出这么多个百分点才换过去。 */
const KEEP_MARGIN = 5;
const WEEK_MS = 7 * 24 * 3600_000;

function windowOf(pct: number | undefined, reset: string | undefined, now: number): QuotaWindow | null {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  const at = reset ? Date.parse(reset) : NaN;
  const resetAt = Number.isFinite(at) ? at : null;
  // 已经过了重置时间：这个窗口重新开始了，按满的算
  if (resetAt != null && resetAt <= now) return { left: 100, resetAt: null };
  return { left: Math.max(0, Math.min(100, 100 - pct)), resetAt };
}

/** 一个账号的两个窗口里剩得少的那个（Grok 只有每周）。 */
export function leftOf(quota: MemberQuota | null) {
  const list = quota ? [quota.five, quota.week].filter((item): item is QuotaWindow => !!item) : [];
  return list.length ? Math.min(...list.map((item) => item.left)) : null;
}

/** 快重置优先的分数：每周剩余 ÷ 离每周重置还有几小时。到期前最可能浪费掉的号分数最高。 */
export function resetScore(quota: MemberQuota, now = Date.now()) {
  const window = quota.week ?? quota.five;
  if (!window) return 0;
  const hours = Math.max(0.25, ((window.resetAt ?? now + WEEK_MS) - now) / 3600_000);
  return window.left / hours;
}

function spent(item: PoolCandidate, now: number) {
  if (item.limitedAt && now - item.limitedAt < LIMIT_HOLD_MS && (!item.quota || item.quota.at <= item.limitedAt)) return true;
  const left = leftOf(item.quota);
  return left != null && left < SPENT;
}

/** 用完的号什么时候能再用：最早一个用完的窗口重置的时间；回过 429 的按标记过期的时间。 */
function recoverAt(item: PoolCandidate, now: number) {
  const times: number[] = [];
  for (const window of item.quota ? [item.quota.five, item.quota.week] : []) if (window && window.left < SPENT) times.push(window.resetAt ?? now + WEEK_MS);
  if (!times.length && item.limitedAt) times.push(item.limitedAt + LIMIT_HOLD_MS);
  return times.length ? Math.max(...times) : Infinity;
}

/**
 * 排一次。current 是这个号池上一次成功用的成员：分数差得不多就继续用它，
 * 换号会让上游的提示词缓存失效，来回跳反而更费额度。
 */
export function orderPool(strategy: QuotaStrategy, list: PoolCandidate[], current?: string, now = Date.now()): PoolCandidate[] {
  const ready: PoolCandidate[] = [], unknown: PoolCandidate[] = [], keys: PoolCandidate[] = [], used: PoolCandidate[] = [];
  for (const item of list) {
    if (item.type === "provider") keys.push(item);
    else if (spent(item, now)) used.push(item);
    else if (leftOf(item.quota) == null) unknown.push(item);
    else ready.push(item);
  }
  const score = (item: PoolCandidate) => (strategy === "reset-first" ? resetScore(item.quota!, now) : leftOf(item.quota)!);
  ready.sort((a, b) => score(b) - score(a));
  const held = ready.find((item) => item.id === current);
  if (held && ready[0] !== held) {
    const best = score(ready[0]), mine = score(held);
    const keep = strategy === "reset-first" ? mine >= best * KEEP_RATIO : best - mine <= KEEP_MARGIN;
    if (keep) ready.splice(0, 0, ...ready.splice(ready.indexOf(held), 1));
  }
  used.sort((a, b) => recoverAt(a, now) - recoverAt(b, now));
  return [...ready, ...unknown, ...keys, ...used];
}

/*
 * 最近一次额度：每个账号取 quota-history 里最后一条采样，查到的时间用 quota-checked.json 里的（数值没变时采样 15 分钟才记一条，
 * 但每次查询成功都会更新这个时间）。两个文件按修改时间缓存，转发时每个请求都会问，不能每次都读整份历史。
 */
let cached: { key: string; quotas: Map<string, { sample: { five?: number; fiveReset?: string; week?: number; weekReset?: string }; at: number }> } | null = null;
function mtime(file: string) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}
export function accountQuota(accountId: string, now = Date.now()): MemberQuota | null {
  const key = `${mtime(dataFile("quota-history.json"))}:${mtime(dataFile("quota-checked.json"))}`;
  if (cached?.key !== key) {
    const quotas = new Map<string, { sample: { five?: number; fiveReset?: string; week?: number; weekReset?: string }; at: number }>();
    const checks = readQuotaChecks().accounts || {};
    for (const list of Object.values(readQuotaHistory().accounts)) {
      for (const sample of Array.isArray(list) ? list : []) {
        if (!sample?.account) continue;
        const at = Math.max(sample.at || 0, Number(checks[sample.account]) || 0);
        quotas.set(sample.account, { sample, at });
      }
    }
    cached = { key, quotas };
  }
  const row = cached.quotas.get(accountId);
  if (!row || now - row.at > STALE_MS) return null;
  return { five: windowOf(row.sample.five, row.sample.fiveReset, now), week: windowOf(row.sample.week, row.sample.weekReset, now), at: row.at };
}
