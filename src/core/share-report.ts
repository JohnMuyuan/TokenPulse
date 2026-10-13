/**
 * 分享卡片的数据（0.3.51）：月报和里程碑。
 *
 * 都从快照里那份「按日 / 工具 / 型号」的用量（report.ts 的 usage）算，口径和总览、用量明细一样：
 * Tokens = 输入 + 输出（输入含缓存读写），费用 = 会话自报的或按官方标价估的。
 * 月报另外用逐条流水按小时的汇总（夜猫子指数）和转发记录的速度（最快的模型）。
 * 卡片上不放邮箱、账号名、项目路径；模型名和工具名照常放（这正是大家想晒的）。
 */
import type { UsageDetail } from "./report";
import type { HourAggregate } from "./request-log";
import type { SpeedLines } from "./pass-speed";
import { priceOf } from "./model-pricing";

const DAY = 86_400_000;

export type MonthReport = {
  month: string; label: string; days: number;
  tokens: number; costUsd: number; requests: number; input: number; cacheRead: number;
  /** 上个月的 Tokens；没有用量是 null。 */
  previousTokens: number | null;
  activeDays: number; longestStreak: number;
  daily: { day: string; tokens: number }[];
  best: { day: string; tokens: number } | null;
  models: { model: string; source: string; tokens: number; share: number }[];
  tools: { source: string; tokens: number; share: number }[];
  /** 每个整点小时（0–23）的 Tokens；夜里 = 22 点到早上 6 点之前。 */
  hours: number[]; nightShare: number | null;
  fastest: { model: string; effort: string; tokensPerSec: number; firstTokenMs: number | null; samples: number }[];
  routes: string[];
  /** 缓存读按输入价算本来要多花的钱（只算有标价的型号）。 */
  cacheSavingsUsd: number;
  analogy: Analogy | null;
};

/* ---------------- 人话换算 ---------------- */

/**
 * 「相当于……」：几种参照物轮换着用，挑一个让次数落在好读的范围里的。
 * 每样东西的 Token 数是粗估（中文大约一字一个 Token，英文大约一词 1.3 个），卡片上写「粗略换算」。
 */
const ANALOGIES: { id: string; tokens: number; text: (n: string) => string }[] = [
  { id: "three-body", tokens: 1_000_000, text: (n) => `相当于把《三体》三部曲读了 ${n} 遍` },
  { id: "red-chamber", tokens: 800_000, text: (n) => `相当于把《红楼梦》从头到尾读了 ${n} 遍` },
  { id: "harry-potter", tokens: 1_400_000, text: (n) => `相当于把《哈利·波特》全七册读了 ${n} 遍` },
  { id: "code", tokens: 10, text: (n) => `大约是 ${n} 行代码的量` },
  { id: "thesis", tokens: 60_000, text: (n) => `相当于写了 ${n} 篇硕士论文` },
];
export type Analogy = { id: string; count: number; text: string };
export function analogyOf(tokens: number, seed = 0): Analogy | null {
  if (!(tokens > 0)) return null;
  const fits = ANALOGIES.filter((item) => { const n = tokens / item.tokens; return n >= 3 && n < 100_000; });
  if (!fits.length) return null;
  const pick = fits[Math.abs(Math.floor(seed)) % fits.length];
  const count = Math.round(tokens / pick.tokens);
  return { id: pick.id, count, text: pick.text(count.toLocaleString("en-US")) };
}

/* ---------------- 月报 ---------------- */

function monthDays(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}
function shiftMonth(month: string, n: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
export function isMonth(value: unknown): value is string { return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value); }

export function monthReport(input: { usage: UsageDetail[]; month: string; hours?: HourAggregate[]; speed?: SpeedLines | null }): MonthReport {
  const { usage, month } = input;
  const days = monthDays(month);
  const rows = usage.filter((row) => row.day.startsWith(month + "-"));
  const prev = shiftMonth(month, -1);
  const prevTokens = usage.filter((row) => row.day.startsWith(prev + "-")).reduce((sum, row) => sum + row.tokens, 0);
  const sum = (list: UsageDetail[], key: "tokens" | "costUsd" | "requests" | "input" | "cacheRead") => list.reduce((total, row) => total + (row[key] || 0), 0);

  const byDay = new Map<string, number>();
  for (const row of rows) byDay.set(row.day, (byDay.get(row.day) || 0) + row.tokens);
  const daily = Array.from({ length: days }, (_, i) => { const day = `${month}-${String(i + 1).padStart(2, "0")}`; return { day, tokens: byDay.get(day) || 0 }; });
  let longest = 0, run = 0;
  for (const item of daily) { run = item.tokens > 0 ? run + 1 : 0; longest = Math.max(longest, run); }
  const best = daily.reduce<{ day: string; tokens: number } | null>((top, item) => (item.tokens > 0 && (!top || item.tokens > top.tokens) ? item : top), null);

  const tokens = sum(rows, "tokens");
  const group = (key: (row: UsageDetail) => string) => {
    const map = new Map<string, { tokens: number; row: UsageDetail }>();
    for (const row of rows) { const k = key(row); const hit = map.get(k) ?? { tokens: 0, row }; hit.tokens += row.tokens; map.set(k, hit); }
    return [...map.values()].sort((a, b) => b.tokens - a.tokens);
  };
  const models = group((row) => row.model).slice(0, 5).map(({ tokens: t, row }) => ({ model: row.model, source: row.source, tokens: t, share: tokens ? t / tokens : 0 }));
  const tools = group((row) => row.source).map(({ tokens: t, row }) => ({ source: row.source, tokens: t, share: tokens ? t / tokens : 0 }));

  // 夜猫子：按本地时间的整点
  const hours = Array.from({ length: 24 }, () => 0);
  for (const row of input.hours ?? []) if (row.hour >= Date.parse(`${month}-01T00:00:00`) && row.hour < Date.parse(`${shiftMonth(month, 1)}-01T00:00:00`)) hours[new Date(row.hour).getHours()] += row.tokens;
  const hourTotal = hours.reduce((a, b) => a + b, 0);
  const night = hours.reduce((total, value, hour) => total + (hour >= 22 || hour < 6 ? value : 0), 0);

  // 最快的模型：这个月里量到的速度（每条线按桶的中位数、按次数加权），至少 20 次才算
  const from = Date.parse(`${month}-01T00:00:00`), to = Date.parse(`${shiftMonth(month, 1)}-01T00:00:00`);
  const fastest = (input.speed?.lines ?? []).map((line) => {
    const buckets = line.buckets.filter((bucket) => bucket.at >= from && bucket.at < to && bucket.tokensPerSec != null && bucket.speedCount > 0);
    const samples = buckets.reduce((total, bucket) => total + bucket.speedCount, 0);
    const speed = samples ? buckets.reduce((total, bucket) => total + bucket.tokensPerSec! * bucket.speedCount, 0) / samples : 0;
    const firsts = buckets.filter((bucket) => bucket.firstTokenMs != null && bucket.firstCount > 0);
    const firstCount = firsts.reduce((total, bucket) => total + bucket.firstCount, 0);
    return { model: line.model, effort: line.effort, tokensPerSec: Math.round(speed), firstTokenMs: firstCount ? Math.round(firsts.reduce((total, bucket) => total + bucket.firstTokenMs! * bucket.firstCount, 0) / firstCount) : null, samples };
  }).filter((item) => item.samples >= 20).sort((a, b) => b.tokensPerSec - a.tokensPerSec)
    // 同一个型号 × 等级经不同的路线只留最快的一条
    .filter((item, i, list) => list.findIndex((other) => other.model === item.model && other.effort === item.effort) === i).slice(0, 3);

  const cacheSavingsUsd = rows.reduce((total, row) => { const price = priceOf(row.model); return price ? total + row.cacheRead * Math.max(0, price.input - price.cacheRead) / 1_000_000 : total; }, 0);
  const [y, m] = month.split("-").map(Number);
  return {
    month, label: `${y} 年 ${m} 月`, days,
    tokens, costUsd: sum(rows, "costUsd"), requests: sum(rows, "requests"), input: sum(rows, "input"), cacheRead: sum(rows, "cacheRead"),
    previousTokens: prevTokens > 0 ? prevTokens : null,
    activeDays: daily.filter((item) => item.tokens > 0).length, longestStreak: longest,
    daily, best, models, tools,
    hours, nightShare: hourTotal > 0 ? night / hourTotal : null,
    fastest, cacheSavingsUsd, analogy: analogyOf(tokens, y * 12 + m),
    routes: [...new Set((input.speed?.lines ?? []).filter(line => line.via && line.buckets.some(bucket => bucket.at >= from && bucket.at < to)).map(line => line.via))],
  };
}

/** 有用量的月份，新的在前（月报里可以选）。 */
export function reportMonths(usage: UsageDetail[]) {
  return [...new Set(usage.filter((row) => row.tokens > 0).map((row) => row.day.slice(0, 7)))].sort().reverse();
}

/* ---------------- 里程碑 ---------------- */

export type Milestone = { id: string; icon: string; label: string; group: "tokens" | "day" | "streak" | "value" | "requests"; target: number; achievedAt: string | null };
const MILESTONES: Omit<Milestone, "achievedAt">[] = [
  { id: "tokens-1e8", icon: "🌱", label: "第一个 1 亿", group: "tokens", target: 1e8 },
  { id: "tokens-5e8", icon: "🌿", label: "5 亿 Tokens", group: "tokens", target: 5e8 },
  { id: "tokens-1e9", icon: "🏅", label: "10 亿 Tokens", group: "tokens", target: 1e9 },
  { id: "tokens-5e9", icon: "🏆", label: "50 亿 Tokens", group: "tokens", target: 5e9 },
  { id: "tokens-1e10", icon: "👑", label: "100 亿 Tokens", group: "tokens", target: 1e10 },
  { id: "tokens-3e10", icon: "🚀", label: "300 亿 Tokens", group: "tokens", target: 3e10 },
  { id: "tokens-1e11", icon: "🌌", label: "1000 亿 Tokens", group: "tokens", target: 1e11 },
  { id: "day-1e8", icon: "💯", label: "单日 1 亿", group: "day", target: 1e8 },
  { id: "streak-7", icon: "🔥", label: "连续 7 天", group: "streak", target: 7 },
  { id: "streak-30", icon: "⚡", label: "连续 30 天", group: "streak", target: 30 },
  { id: "streak-100", icon: "🗓️", label: "连续 100 天", group: "streak", target: 100 },
  { id: "value-1000", icon: "💰", label: "API 价值 $1,000", group: "value", target: 1000 },
  { id: "value-10000", icon: "💎", label: "API 价值 $10,000", group: "value", target: 10000 },
  { id: "value-50000", icon: "🏦", label: "API 价值 $50,000", group: "value", target: 50000 },
  { id: "requests-1e5", icon: "💬", label: "10 万次请求", group: "requests", target: 100_000 },
  { id: "streak-365", icon: "🎂", label: "连续 365 天", group: "streak", target: 365 },
];
export type MilestoneState = {
  analogy: Analogy | null;
  list: Milestone[];
  firstDay: string | null; days: number;
  totals: { tokens: number; costUsd: number; requests: number };
  /** 累计 Tokens 按天（画「一路走来」）。 */
  cumulative: { day: string; tokens: number }[];
  /** 陪你最久的型号：用过的天数最多的那个。 */
  companion: { model: string; days: number; share: number } | null;
  /** 最近 30 天每天平均 / 第一个月每天平均。 */
  speedup: number | null;
  /** 下一个累计 Tokens 目标，和照最近 30 天的速度大约几天后达成。 */
  next: { id: string; label: string; target: number; etaDays: number | null } | null;
};

function nextDay(day: string) { const d = new Date(day + "T12:00:00"); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function dayOf(at: number) { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

export function milestoneState(usage: UsageDetail[], now = Date.now()): MilestoneState {
  const byDay = new Map<string, { tokens: number; costUsd: number; requests: number }>();
  const modelDays = new Map<string, Set<string>>(), modelTokens = new Map<string, number>();
  for (const row of usage) {
    if (!(row.tokens > 0) && !(row.requests > 0)) continue;
    const day = byDay.get(row.day) ?? { tokens: 0, costUsd: 0, requests: 0 };
    day.tokens += row.tokens; day.costUsd += row.costUsd; day.requests += row.requests;
    byDay.set(row.day, day);
    if (row.tokens > 0) { (modelDays.get(row.model) ?? modelDays.set(row.model, new Set()).get(row.model)!).add(row.day); modelTokens.set(row.model, (modelTokens.get(row.model) || 0) + row.tokens); }
  }
  const days = [...byDay.keys()].sort();
  const reached = new Map<string, string>();
  let tokens = 0, costUsd = 0, requests = 0, streak = 0, prevDay = "";
  const cumulative: { day: string; tokens: number }[] = [];
  for (const day of days) {
    const today = byDay.get(day)!;
    tokens += today.tokens; costUsd += today.costUsd; requests += today.requests;
    streak = today.tokens > 0 ? (prevDay && nextDay(prevDay) === day ? streak + 1 : 1) : 0;
    if (today.tokens > 0) prevDay = day;
    cumulative.push({ day, tokens });
    for (const item of MILESTONES) {
      if (reached.has(item.id)) continue;
      const value = item.group === "tokens" ? tokens : item.group === "day" ? today.tokens : item.group === "streak" ? streak : item.group === "value" ? costUsd : requests;
      if (value >= item.target) reached.set(item.id, day);
    }
  }
  const total = [...modelTokens.values()].reduce((a, b) => a + b, 0);
  const companionModel = [...modelDays.entries()].sort((a, b) => b[1].size - a[1].size || (modelTokens.get(b[0]) || 0) - (modelTokens.get(a[0]) || 0))[0];
  const firstDay = days[0] ?? null;
  const today = dayOf(now);
  const spanDays = firstDay ? Math.max(1, Math.round((Date.parse(today + "T12:00:00") - Date.parse(firstDay + "T12:00:00")) / DAY) + 1) : 0;
  const sumRange = (from: string, to: string) => days.filter((day) => day >= from && day <= to).reduce((total, day) => total + byDay.get(day)!.tokens, 0);
  const recentFrom = dayOf(now - 29 * DAY);
  const recentRate = sumRange(recentFrom, today) / 30;
  const firstRate = firstDay ? sumRange(firstDay, dayOf(Date.parse(firstDay + "T12:00:00") + 29 * DAY)) / 30 : 0;
  const nextToken = MILESTONES.find((item) => item.group === "tokens" && !reached.has(item.id));
  return {
    analogy: analogyOf(tokens, spanDays),
    list: MILESTONES.map((item) => ({ ...item, achievedAt: reached.get(item.id) ?? null })),
    firstDay, days: spanDays, totals: { tokens, costUsd, requests }, cumulative,
    companion: companionModel ? { model: companionModel[0], days: companionModel[1].size, share: total ? (modelTokens.get(companionModel[0]) || 0) / total : 0 } : null,
    speedup: spanDays >= 45 && firstRate > 0 ? recentRate / firstRate : null,
    next: nextToken ? { id: nextToken.id, label: nextToken.label, target: nextToken.target, etaDays: recentRate > 0 ? Math.ceil((nextToken.target - tokens) / recentRate) : null } : null,
  };
}
