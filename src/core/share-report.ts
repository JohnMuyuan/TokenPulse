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
  /** 每一枚已达成的里程碑在达成那天的样子（0.3.53）：分享卡片的下半部分照这个画，不用今天的数字。 */
  moments: Record<string, MilestoneMoment>;
};

export type ModelShare = { model: string; source: string; tokens: number; costUsd: number; share: number };
export type MilestoneMoment = {
  day: string;
  /** 从第一条记录算起第几天达成。 */
  dayIndex: number;
  /** 截至达成那天的累计。 */
  totals: { tokens: number; costUsd: number; requests: number };
  /** 截至那天用过天数最多的型号。 */
  companion: { model: string; days: number; share: number } | null;
  /** 同一组上一枚：哪天达成、隔了几天。 */
  previous: { id: string; label: string; day: string; gapDays: number } | null;
  /** 同一组下一枚：当时的进度，和后来哪天达成（还没达成是 null）。 */
  next: { id: string; label: string; target: number; progress: number; reachedAt: string | null } | null;
  analogy: Analogy | null;
  /** 各组自己的数字，见 momentFocus。 */
  focus: {
    perDay: { tokens: number; costUsd: number; requests: number };
    models: ModelShare[];
    /** 单日：那一天的用量，和那天之前平均每天的倍数。 */
    theDay?: { tokens: number; costUsd: number; requests: number; vsAverage: number | null };
    /** 连续：这一段从哪天到哪天、一共用了多少、最拼的一天。 */
    streak?: { from: string; to: string; tokens: number; costUsd: number; requests: number; best: { day: string; tokens: number } | null };
    /** 请求最多的一天（请求次数那一组）。 */
    busiest?: { day: string; requests: number } | null;
  };
  /** 下半部分的图：累计曲线（tokens / value / requests）或每天的柱子（day / streak）。 */
  series: { kind: "cumulative" | "daily"; unit: "tokens" | "usd" | "requests"; points: { day: string; value: number }[]; highlight: { from: string; to: string } | null; marks: { label: string; day: string; value: number; current: boolean }[] };
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
    moments: momentsOf(usage, reached),
  };
}

/*
 * 每一枚已达成的里程碑在达成那天的样子（0.3.53）。以前分享卡片的上半部分是那一枚，下半部分却是今天的累计，
 * 选一枚很早的成就时「标题和内容对不上」。这里按天往前走一遍，到达成那天就把当时的数字记下来：
 * 累计、当时陪你最久的模型、同组上一枚隔了几天、同组下一枚当时的进度（后来哪天达成），以及各组自己要画的图。
 */
function momentsOf(usage: UsageDetail[], reached: Map<string, string>): Record<string, MilestoneMoment> {
  type Day = { tokens: number; costUsd: number; requests: number; models: Map<string, ModelShare> };
  const byDay = new Map<string, Day>();
  for (const row of usage) {
    if (!(row.tokens > 0) && !(row.requests > 0)) continue;
    const day = byDay.get(row.day) ?? { tokens: 0, costUsd: 0, requests: 0, models: new Map() };
    day.tokens += row.tokens; day.costUsd += row.costUsd; day.requests += row.requests;
    if (row.tokens > 0) { const m = day.models.get(row.model) ?? { model: row.model, source: row.source, tokens: 0, costUsd: 0, share: 0 }; m.tokens += row.tokens; m.costUsd += row.costUsd; day.models.set(row.model, m); }
    byDay.set(row.day, day);
  }
  const days = [...byDay.keys()].sort();
  if (!days.length) return {};
  const firstDay = days[0];
  const index = (day: string) => Math.round((Date.parse(day + "T12:00:00") - Date.parse(firstDay + "T12:00:00")) / DAY) + 1;
  // 达成那天的下标（同一天达成好几枚都用这一天）
  const wanted = new Map<string, string[]>();
  for (const [id, day] of reached) wanted.set(day, [...(wanted.get(day) ?? []), id]);
  const out: Record<string, MilestoneMoment> = {};
  let tokens = 0, costUsd = 0, requests = 0;
  const modelDays = new Map<string, number>(), modelTotals = new Map<string, ModelShare>();
  const cumulative: { day: string; tokens: number; costUsd: number; requests: number }[] = [];
  let streakFrom = "", prevActive = "";
  const share = (list: ModelShare[], by: "tokens" | "costUsd") => { const total = list.reduce((sum, item) => sum + item[by], 0); return list.sort((a, b) => b[by] - a[by]).slice(0, 3).map((item) => ({ ...item, share: total ? item[by] / total : 0 })); };
  for (const day of days) {
    const today = byDay.get(day)!;
    tokens += today.tokens; costUsd += today.costUsd; requests += today.requests;
    for (const m of today.models.values()) {
      modelDays.set(m.model, (modelDays.get(m.model) || 0) + 1);
      const total = modelTotals.get(m.model) ?? { model: m.model, source: m.source, tokens: 0, costUsd: 0, share: 0 };
      total.tokens += m.tokens; total.costUsd += m.costUsd; modelTotals.set(m.model, total);
    }
    if (today.tokens > 0) { if (!(prevActive && nextDay(prevActive) === day)) streakFrom = day; prevActive = day; }
    cumulative.push({ day, tokens, costUsd, requests });
    for (const id of wanted.get(day) ?? []) {
      const item = MILESTONES.find((m) => m.id === id);
      if (!item) continue;
      const group = MILESTONES.filter((m) => m.group === item.group);
      const at = group.indexOf(item);
      const prev = group.slice(0, at).reverse().find((m) => reached.has(m.id));
      const next = group.slice(at + 1).find((m) => m.target > item.target);
      const span = index(day);
      const companion = [...modelDays.entries()].sort((a, b) => b[1] - a[1] || (modelTotals.get(b[0])!.tokens - modelTotals.get(a[0])!.tokens))[0];
      const progressOf = (target: number) => Math.min(1, (item.group === "tokens" ? tokens : item.group === "value" ? costUsd : item.group === "requests" ? requests : 0) / target);
      const moment: MilestoneMoment = {
        day, dayIndex: span, totals: { tokens, costUsd, requests },
        companion: companion ? { model: companion[0], days: companion[1], share: tokens ? modelTotals.get(companion[0])!.tokens / tokens : 0 } : null,
        previous: prev ? { id: prev.id, label: prev.label, day: reached.get(prev.id)!, gapDays: index(day) - index(reached.get(prev.id)!) } : null,
        next: next ? { id: next.id, label: next.label, target: next.target, progress: item.group === "streak" ? Math.min(1, item.target / next.target) : item.group === "day" ? today.tokens / next.target : progressOf(next.target), reachedAt: reached.get(next.id) ?? null } : null,
        analogy: analogyOf(item.group === "day" ? today.tokens : tokens, span),
        focus: { perDay: { tokens: tokens / span, costUsd: costUsd / span, requests: requests / span }, models: share([...modelTotals.values()].map((m) => ({ ...m })), item.group === "value" ? "costUsd" : "tokens") },
        series: { kind: "cumulative", unit: "tokens", points: [], highlight: null, marks: [] },
      };
      const sameGroupMarks = (value: (point: typeof cumulative[number]) => number) => group.filter((m) => reached.has(m.id) && reached.get(m.id)! <= day).map((m) => { const point = cumulative.find((p) => p.day >= reached.get(m.id)!) ?? cumulative[cumulative.length - 1]; return { label: m.label, day: point.day, value: value(point), current: m.id === item.id }; });
      if (item.group === "day") {
        const before = cumulative.slice(0, -1);
        const avg = before.length ? (tokens - today.tokens) / Math.max(1, index(day) - 1) : null;
        moment.focus.theDay = { tokens: today.tokens, costUsd: today.costUsd, requests: today.requests, vsAverage: avg ? today.tokens / avg : null };
        moment.focus.models = share([...today.models.values()].map((m) => ({ ...m })), "tokens");
        const from = dayOf(Date.parse(day + "T12:00:00") - 29 * DAY);
        moment.series = { kind: "daily", unit: "tokens", points: daysBetween(from, day).map((d) => ({ day: d, value: byDay.get(d)?.tokens ?? 0 })), highlight: { from: day, to: day }, marks: [] };
      } else if (item.group === "streak") {
        const list = daysBetween(streakFrom, day).map((d) => ({ day: d, ...(byDay.get(d) ?? { tokens: 0, costUsd: 0, requests: 0, models: new Map() }) }));
        const best = list.reduce<{ day: string; tokens: number } | null>((top, d) => (!top || d.tokens > top.tokens ? { day: d.day, tokens: d.tokens } : top), null);
        const models = new Map<string, ModelShare>();
        for (const d of list) for (const m of d.models.values()) { const hit = models.get(m.model) ?? { ...m, tokens: 0, costUsd: 0 }; hit.tokens += m.tokens; hit.costUsd += m.costUsd; models.set(m.model, hit); }
        moment.focus.streak = { from: streakFrom, to: day, tokens: list.reduce((s, d) => s + d.tokens, 0), costUsd: list.reduce((s, d) => s + d.costUsd, 0), requests: list.reduce((s, d) => s + d.requests, 0), best };
        moment.focus.models = share([...models.values()], "tokens");
        moment.series = { kind: "daily", unit: "tokens", points: list.map((d) => ({ day: d.day, value: d.tokens })), highlight: { from: streakFrom, to: day }, marks: [] };
      } else if (item.group === "value") {
        moment.series = { kind: "cumulative", unit: "usd", points: cumulative.map((p) => ({ day: p.day, value: p.costUsd })), highlight: null, marks: sameGroupMarks((p) => p.costUsd) };
      } else if (item.group === "requests") {
        const busiest = days.filter((d) => d <= day).reduce<{ day: string; requests: number } | null>((top, d) => (!top || byDay.get(d)!.requests > top.requests ? { day: d, requests: byDay.get(d)!.requests } : top), null);
        moment.focus.busiest = busiest;
        moment.series = { kind: "cumulative", unit: "requests", points: cumulative.map((p) => ({ day: p.day, value: p.requests })), highlight: null, marks: sameGroupMarks((p) => p.requests) };
      } else {
        moment.series = { kind: "cumulative", unit: "tokens", points: cumulative.map((p) => ({ day: p.day, value: p.tokens })), highlight: null, marks: sameGroupMarks((p) => p.tokens) };
      }
      out[id] = moment;
    }
  }
  return out;
}
function daysBetween(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = nextDay(d)) out.push(d);
  return out;
}
