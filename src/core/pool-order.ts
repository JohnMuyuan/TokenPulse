/**
 * 号池按额度排成员（0.3.44）：「快重置优先」和「剩余最多」两种轮换方式。
 *
 * 额度来自 quota-history.ts 记下的最近一次采样（每个官方账号按设置里的查询间隔查一次，默认 1 分钟）。
 * 两次查询之间用完了，上游回 429（Grok 额度用完回 402），路由照旧换下一个成员；这里再把回过 429 的账号记一下，
 * 下一次查到它的额度之前（最多 10 分钟）先排到后面，免得每个请求都先撞一次 429。
 *
 * 排序分四段：有额度数据、没用完的（按方式排）→ 没有额度数据的官方账号（查不到、出口被拦）→ API Key 供应商（没有额度可看，当后备）
 * → 已经用完的（谁先恢复谁在前）。各段里分数相同的保持设置里的顺序。
 */
import fs from "fs";
import type { PoolStrategy } from "./agent-types";
import { dataFile } from "./paths";
import { readQuotaChecks, readQuotaHistory, sameReset, type QuotaSample } from "./quota-history";

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
/** 剩余最多：别的号要多出这么多个百分点才换过去。 */
const KEEP_MARGIN = 5;
const WEEK_MS = 7 * 24 * 3600_000;
const HOUR_MS = 3600_000;

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

export function spent(item: PoolCandidate, now = Date.now()) {
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

/** 最近 7 天的周额度上涨换算成每小时百分点；覆盖不足 24 小时不估。 */
export function weeklyRateOf(samples: QuotaSample[], now = Date.now()): number | null {
  const from = now - WEEK_MS;
  const rows = samples.filter((sample) => sample.at <= now && Number.isFinite(sample.week)).sort((a, b) => a.at - b.at);
  if (rows.length < 2 || rows.at(-1)!.at <= from) return null;
  const first = rows.find((sample) => sample.at >= from) ?? rows.at(-1)!;
  const coveredFrom = Math.max(from, first.at);
  const coveredHours = (rows.at(-1)!.at - coveredFrom) / HOUR_MS;
  if (coveredHours < 24) return null;
  let used = 0;
  let prev: QuotaSample | null = rows.filter((sample) => sample.at <= coveredFrom).at(-1) ?? null;
  for (const sample of rows) {
    if (sample.at <= coveredFrom) continue;
    if (prev && sameReset(prev.weekReset, sample.weekReset) && sample.week! > prev.week!) used += sample.week! - prev.week!;
    prev = sample;
  }
  return used / coveredHours;
}

export type PlanInput = { id: string; left: number; resetAt: number | null; period?: number };
export type PlanMember = { id: string; resetAt: number | null; left: number; drainAt: number | null; waste: number | null };
export type PoolPlan = { order: string[]; segments: { id: string; from: number; to: number }[]; members: PlanMember[]; outAt: number | null; totalWaste: number | null };

/** 以每小时百分点为输入，最多按一小时步长推演 7 天。只推周额度，不模拟 5 小时窗口和限流；速度取最近 7 天平均。 */
export function planPool(strategy: PoolStrategy, members: PlanInput[], rate: number | null, now = Date.now(), options: { firstId?: string } = {}): PoolPlan {
  const periodOf = (member: PlanInput) => member.period && member.period > 0 ? member.period : WEEK_MS;
  const resetOf = (member: PlanInput) => member.resetAt != null && member.resetAt > now ? member.resetAt : now + periodOf(member);
  const staticSort = (a: PlanInput, b: PlanInput) => {
    if (strategy === "reset-first") return resetOf(a) - resetOf(b) || b.left - a.left || members.indexOf(a) - members.indexOf(b);
    if (strategy === "most-left") return b.left - a.left || members.indexOf(a) - members.indexOf(b);
    return members.indexOf(a) - members.indexOf(b);
  };
  const ordered = [...members].sort(staticSort);
  const result: PoolPlan = {
    order: ordered.map((member) => member.id), segments: [],
    members: members.map((member) => ({ id: member.id, resetAt: resetOf(member), left: member.left, drainAt: null, waste: null })),
    outAt: null, totalWaste: null,
  };
  if (rate == null || !Number.isFinite(rate) || rate <= 0 || !members.length) return result;

  type State = { id: string; left: number; resetAt: number; period: number; drainAt: number | null; waste: number | null; firstUse: number | null };
  const state: State[] = members.map((member) => ({ id: member.id, left: Math.max(0, Math.min(100, member.left)), resetAt: resetOf(member), period: periodOf(member), drainAt: null, waste: null, firstUse: null }));
  const lastSegments = new Map<string, { id: string; from: number; to: number }>();
  let activeMostId: string | undefined;
  const addSegment = (id: string, from: number, to: number) => {
    if (to <= from) return;
    const last = lastSegments.get(id);
    if (last && Math.abs(last.to - from) < 1) last.to = to;
    else { const segment = { id, from, to }; result.segments.push(segment); lastSegments.set(id, segment); }
  };
  const available = () => state.map((item, i) => ({ item, i })).filter(({ item }) => item.left > 1e-9);
  let at = now;
  const end = now + WEEK_MS;
  const choose = (alive: { item: State; i: number }[]) => {
    if (options.firstId) {
      const first = alive.find(({ item }) => item.id === options.firstId && item.drainAt == null);
      if (first) return first;
    }
    if (strategy === "reset-first") return alive.reduce((best, item) => item.item.resetAt < best.item.resetAt || (item.item.resetAt === best.item.resetAt && (item.item.left > best.item.left || (item.item.left === best.item.left && item.i < best.i))) ? item : best);
    if (strategy === "most-left") {
      const sorted = [...alive].sort((a, b) => b.item.left - a.item.left || a.i - b.i);
      const current = alive.find(({ item }) => item.id === activeMostId);
      return current && sorted[0].item.left - current.item.left <= KEEP_MARGIN ? current : sorted[0];
    }
    return alive[0];
  };
  while (at < end) {
    for (const item of state) while (item.resetAt <= at) { item.waste ??= item.left; item.left = 100; item.resetAt += item.period; }
    const nextReset = Math.min(...state.map((item) => item.resetAt));
    const until = Math.min(end, at + HOUR_MS, nextReset);
    const hours = (until - at) / HOUR_MS;
    let demand = rate * hours, cursor = at;
    if (strategy === "round-robin") {
      while (demand > 1e-9) {
        const alive = available();
        if (!alive.length) { result.outAt ??= cursor; break; }
        const eachRate = rate / alive.length;
        const spanHours = Math.min(demand / rate, ...alive.map(({ item }) => item.left / eachRate));
        const to = cursor + spanHours * HOUR_MS;
        for (const { item } of alive) {
          const take = Math.min(item.left, eachRate * spanHours);
          if (take > 0) { item.firstUse ??= cursor; addSegment(item.id, cursor, to); item.left -= take; if (item.left <= 1e-9) { item.left = 0; item.drainAt ??= to; } }
        }
        demand -= rate * spanHours;
        cursor = to;
      }
    } else {
      while (demand > 1e-9) {
        const alive = available();
        if (!alive.length) { result.outAt ??= cursor; break; }
        const chosen = choose(alive)!;
        const take = Math.min(chosen.item.left, demand);
        const to = cursor + take / rate * HOUR_MS;
        if (take > 0) { chosen.item.firstUse ??= cursor; activeMostId = chosen.item.id; addSegment(chosen.item.id, cursor, to); chosen.item.left -= take; demand -= take; cursor = to; }
        if (chosen.item.left <= 1e-9) { chosen.item.left = 0; chosen.item.drainAt ??= cursor; }
      }
    }
    at = until;
    for (const item of state) if (item.resetAt <= at) { item.waste ??= item.left; item.left = 100; item.resetAt += item.period; }
  }
  result.order = [...state].sort((a, b) => (a.firstUse ?? Infinity) - (b.firstUse ?? Infinity) || members.findIndex((m) => m.id === a.id) - members.findIndex((m) => m.id === b.id)).map((item) => item.id);
  result.members = state.map((item, i) => ({ id: item.id, resetAt: resetOf(members[i]), left: members[i].left, drainAt: item.drainAt, waste: item.waste }));
  result.totalWaste = state.reduce((sum, item) => sum + (item.waste ?? 0), 0);
  return result;
}

/** 排一次。current 是这个号池上一次成功用的成员；会多作废时才换，尽量少打断提示词缓存。 */
export function orderPool(strategy: QuotaStrategy, list: PoolCandidate[], current?: string, now = Date.now(), rate: number | null = null): PoolCandidate[] {
  const ready: PoolCandidate[] = [], unknown: PoolCandidate[] = [], keys: PoolCandidate[] = [], used: PoolCandidate[] = [];
  for (const item of list) {
    if (item.type === "provider") keys.push(item);
    else if (spent(item, now)) used.push(item);
    else if (leftOf(item.quota) == null) unknown.push(item);
    else ready.push(item);
  }
  const resetAt = (item: PoolCandidate) => {
    const value = item.quota?.week?.resetAt;
    return value != null && value > now ? value : now + WEEK_MS;
  };
  if (strategy === "reset-first") ready.sort((a, b) => resetAt(a) - resetAt(b) || (b.quota!.week?.left ?? leftOf(b.quota) ?? 0) - (a.quota!.week?.left ?? leftOf(a.quota) ?? 0) || list.indexOf(a) - list.indexOf(b));
  else ready.sort((a, b) => leftOf(b.quota)! - leftOf(a.quota)! || list.indexOf(a) - list.indexOf(b));
  const held = ready.find((item) => item.id === current);
  if (held && ready[0] !== held) {
    let keep: boolean;
    if (strategy === "reset-first") {
      if (rate != null && rate > 0) {
        const weekly = ready.filter((item) => item.quota?.week != null);
        if (!weekly.some((item) => item.id === held.id)) keep = false;
        else {
          const planMembers = weekly.map((item) => ({ id: item.id, left: item.quota!.week!.left, resetAt: item.quota!.week!.resetAt, period: WEEK_MS }));
          const baseline = planPool("reset-first", planMembers, rate, now);
          const currentFirst = planPool("reset-first", planMembers, rate, now, { firstId: held.id });
          keep = currentFirst.totalWaste! <= baseline.totalWaste! + 2;
        }
      } else keep = Math.abs(resetAt(held) - resetAt(ready[0])) <= 6 * HOUR_MS;
    } else keep = leftOf(ready[0].quota)! - leftOf(held.quota)! <= KEEP_MARGIN;
    if (keep) ready.splice(0, 0, ...ready.splice(ready.indexOf(held), 1));
  }
  used.sort((a, b) => recoverAt(a, now) - recoverAt(b, now));
  return [...ready, ...unknown, ...keys, ...used];
}

/*
 * 最近一次额度：每个账号取 quota-history 里最后一条采样，查到的时间用 quota-checked.json 里的（数值没变时采样 15 分钟才记一条，
 * 但每次查询成功都会更新这个时间）。两个文件按修改时间缓存，转发时每个请求都会问，不能每次都读整份历史。
 */
let cached: { key: string; rateHour: number; quotas: Map<string, { sample: { five?: number; fiveReset?: string; week?: number; weekReset?: string }; at: number }>; samples: Map<string, QuotaSample[]>; rates: Map<string, number | null> } | null = null;
function mtime(file: string) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}
export function accountQuota(accountId: string, now = Date.now()): MemberQuota | null {
  const key = `${mtime(dataFile("quota-history.json"))}:${mtime(dataFile("quota-checked.json"))}`;
  if (cached?.key !== key) {
    const quotas = new Map<string, { sample: { five?: number; fiveReset?: string; week?: number; weekReset?: string }; at: number }>();
    const samples = new Map<string, QuotaSample[]>();
    const checks = readQuotaChecks().accounts || {};
    for (const list of Object.values(readQuotaHistory().accounts)) {
      for (const sample of Array.isArray(list) ? list : []) {
        if (!sample?.account) continue;
        const history = samples.get(sample.account) ?? [];
        history.push(sample);
        samples.set(sample.account, history);
        const at = Math.max(sample.at || 0, Number(checks[sample.account]) || 0);
        quotas.set(sample.account, { sample, at });
      }
    }
    const rates = new Map([...samples].map(([id, history]) => [id, weeklyRateOf(history, now)]));
    cached = { key, rateHour: Math.floor(now / HOUR_MS), quotas, samples, rates };
  } else if (cached.rateHour !== Math.floor(now / HOUR_MS)) {
    cached.rates = new Map([...cached.samples].map(([id, history]) => [id, weeklyRateOf(history, now)]));
    cached.rateHour = Math.floor(now / HOUR_MS);
  }
  const row = cached.quotas.get(accountId);
  if (!row || now - row.at > STALE_MS) return null;
  return { five: windowOf(row.sample.five, row.sample.fiveReset, now), week: windowOf(row.sample.week, row.sample.weekReset, now), at: row.at };
}

/** 账号周额度速度，和 accountQuota 共用文件 mtime 缓存。 */
export function accountWeekRate(accountId: string, now = Date.now()): number | null {
  const key = `${mtime(dataFile("quota-history.json"))}:${mtime(dataFile("quota-checked.json"))}`;
  if (cached?.key !== key || cached.rateHour !== Math.floor(now / HOUR_MS)) accountQuota(accountId, now);
  return cached?.rates.get(accountId) ?? null;
}

/** 号池官方成员速度；所有成员都有足够采样时才给完整速度。 */
export function poolWeekRate(accountIds: string[], now = Date.now()): number | null {
  if (!accountIds.length) return null;
  const rates = accountIds.map((id) => accountWeekRate(id, now));
  return rates.every((value): value is number => value != null) ? rates.reduce((sum, value) => sum + value, 0) : null;
}
