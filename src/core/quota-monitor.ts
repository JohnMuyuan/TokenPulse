/**
 * 额度监控的计算。纯函数：界面、API、测试都直接用。
 *
 * 为什么要两份数据对着看：官方接口**只给百分比**，不告诉你额度到底是多少 token；
 * 本机会话文件**只有 token**，不知道占了额度的几成。同一个窗口里两边一比 ——
 * 「这周用了 3.1 亿 token，官方说已用 62%」—— 就能倒推出整周额度大约 5 亿 token。
 *
 * 口径（改之前先看 scripts/test-quota-monitor.cjs）：
 * - **窗口起点**：周窗口优先用接口直接给的 weekStart（Grok 有），否则 weekReset - 7 天；
 *   5 小时窗口 = fiveReset - 5 小时。
 * - **窗口里百分比掉下来之前的样本不算**：到点重置、或者用了一次手动重置，前面的点就不属于这个窗口了。
 * - **预测用「墙上时钟」的平均速度：已用百分比 ÷ 窗口已经过去的时间**。额度是按墙钟重置的，
 *   你睡觉、开会、关机的时间照样在走，所以这些时间必须留在分母里。
 *   0.17.6 的做法是只挑「涨了的区间」取中位数，等于假设你 24 小时不停地按爆发速度跑 ——
 *   实测把 9% 的真实用量外推成重置时 135%（真实约 53%），这就是「提前两天用完」的由来。
 *   已用百分比是窗口累计值，中间没采到样也不会丢，所以关机、断电都不影响这个算法。
 * - **同时给出「最近 24 小时」的速度，两者构成一个区间**。平均值用来预测，较快的那个只用来
 *   提示「最快可能什么时候用完」，不拿它当结论。
 * - **折算整窗额度要求已用 >= 2%**：Claude 的 utilization 是整数，1% 的时候误差能放大几十倍。
 *   已用越多越准，界面上把可信度标出来。
 * - 采样之后已经到点重置、接口还没再问过：按新窗口从 0 算，不拿上个窗口的百分比吓人。
 */

import type { AccountKind } from "./quota";
import type { QuotaSample } from "./quota-history";

export type { AccountKind, QuotaSample };
export const ACCOUNT_KINDS: AccountKind[] = ["claude", "chatgpt", "grok"];

/** 一小时一个型号一条。tokens = 全部输入（含缓存）+ 输出。 */
export type HourRow = { hour: number; model: string; tokens: number; costUsd: number; requests: number };

export type WindowReport = {
  used: number;
  startAt?: number;
  resetAt?: number;
  elapsedH?: number;
  leftH?: number;
  /** 最近一段（周 24 小时 / 5 小时窗口 1 小时）每小时涨几个百分点。采样跨度不够时没有。 */
  recentPerH?: number;
  /** 整个窗口的墙钟平均：已用 ÷ 窗口已过时间。预测就用它。 */
  averagePerH?: number;
  /** 预测用的速度（= averagePerH，没有它时退回 recentPerH）。 */
  ratePerH?: number;
  /** 平均和最近里较快的那个，用来说「最快可能什么时候用完」。 */
  fastPerH?: number;
  /** 按 fastPerH 推到重置时的百分比。 */
  projectedHigh?: number;
  /** 按 fastPerH 什么时候到 100%。 */
  etaFastAt?: number;
  /** 这个窗口里真正有用量的小时占比。有的话界面可以写成「大约每天用 n 小时」。 */
  activeShare?: number;
  /** 按 ratePerH 什么时候到 100%。已经用完、或者速度为 0 时没有。 */
  etaAt?: number;
  /** 按 ratePerH 到重置那一刻会是多少。可以超过 100（表示会提前用完）。 */
  projectedAtReset?: number;
  /** 已经用完，或者预计在重置前用完。 */
  runsOutBeforeReset: boolean;
  usedTokens: number;
  usedCostUsd: number;
  /** 整个窗口（100%）大约折合多少。 */
  capacity?: { tokens: number; costUsd: number; confidence: "low" | "medium" | "high" };
};

export type HealthLevel = "good" | "warning" | "serious" | "critical" | "unknown";
export type HealthReason = "no-data" | "exhausted" | "runs-out-soon" | "runs-out" | "tight" | "five-hour-high" | "ok";

export type AccountReport = {
  kind: AccountKind;
  sampleCount: number;
  firstSampleAt?: number;
  lastSampleAt?: number;
  resetCredits?: number;
  plan?: string;
  week: WindowReport | null;
  five: WindowReport | null;
  /** 当前周窗口里的采样点，画曲线用。 */
  trend: { at: number; pct: number }[];
  /** 最近 24 个整点小时，最早的在前。pctDelta = 这一小时里周额度涨了几个点。 */
  hourly: { hour: number; tokens: number; costUsd: number; requests: number; pctDelta?: number }[];
  /** 当前周窗口里各型号的用量。firstHour 用来给颜色排座次（颜色跟着型号走，不跟排名走）。 */
  models: { model: string; tokens: number; costUsd: number; requests: number; firstHour: number }[];
  health: { level: HealthLevel; reason: HealthReason };
};

export const HOUR_MS = 3_600_000;
export const WEEK_MS = 7 * 24 * HOUR_MS;
export const FIVE_HOUR_MS = 5 * HOUR_MS;

function time(value?: string) {
  if (!value) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

type Point = { at: number; pct: number };

/** 窗口内、最后一次百分比回落之后的点。 */
function pointsOf(samples: QuotaSample[], pick: (sample: QuotaSample) => number | undefined, startAt?: number) {
  const list: Point[] = [];
  for (const sample of samples) {
    const pct = pick(sample);
    if (pct == null || !Number.isFinite(pct)) continue;
    if (startAt != null && sample.at < startAt) continue;
    list.push({ at: sample.at, pct });
  }
  let from = 0;
  // 0.5 的余量：Grok 给的是浮点，偶尔会有 65.99 → 65.98 这种抖动，不算重置。
  for (let i = 1; i < list.length; i++) if (list[i].pct < list[i - 1].pct - 0.5) from = i;
  return list.slice(from);
}

function sumRows(rows: HourRow[], from: number, to: number) {
  let tokens = 0;
  let costUsd = 0;
  for (const row of rows) {
    if (row.hour + HOUR_MS <= from || row.hour > to) continue;
    tokens += row.tokens;
    costUsd += row.costUsd;
  }
  return { tokens, costUsd };
}

/** 窗口里真正有 token 的小时 / 墙上时钟小时。不足半天或完全没用量就不报。 */
function activeShareOf(rows: HourRow[], startAt: number | undefined, now: number) {
  if (startAt == null) return undefined;
  const elapsedH = (now - startAt) / HOUR_MS;
  if (elapsedH < 12) return undefined;
  const hours = new Set<number>();
  for (const row of rows) {
    if (row.tokens > 0 && row.hour + HOUR_MS > startAt && row.hour < now) hours.add(row.hour);
  }
  if (!hours.size) return undefined;
  return Math.min(1, hours.size / elapsedH);
}

/** 采样之后已经过了重置点：换到新窗口、从 0 算。 */
function rollWindow(current: number, startAt: number | undefined, resetAt: number | undefined, length: number, now: number) {
  if (resetAt == null || resetAt > now) return { current, startAt, resetAt, stale: false };
  let next = resetAt;
  while (next <= now) next += length;
  return { current: 0, startAt: next - length, resetAt: next, stale: true };
}

export function analyzeWindow(
  input: {
    current: number;
    startAt?: number;
    resetAt?: number;
    points: Point[];
    lookbackMs: number;
    minSpanMs: number;
    /** 窗口至少走过这么久，才拿平均速度去预测（太早算出来全是噪声）。 */
    minElapsedMs: number;
  },
  rows: HourRow[],
  now: number,
): WindowReport {
  const { current, startAt, resetAt, points, lookbackMs, minSpanMs, minElapsedMs } = input;
  const elapsedH = startAt != null ? Math.max(0, (now - startAt) / HOUR_MS) : undefined;
  const leftH = resetAt != null ? Math.max(0, (resetAt - now) / HOUR_MS) : undefined;

  let recentPerH: number | undefined;
  const last = points.at(-1);
  if (last) {
    const first = points.find((point) => point.at >= last.at - lookbackMs);
    if (first && last.at - first.at >= minSpanMs) {
      recentPerH = Math.max(0, last.pct - first.pct) / ((last.at - first.at) / HOUR_MS);
    }
  }
  /*
   * 墙钟平均：已用百分比是窗口累计值，除以窗口真正过去的时间。
   * 关机、睡觉这些没有采样的时间也留在分母里 —— 额度按墙钟重置，它们本来就该算。
   */
  const averagePerH =
    elapsedH != null && elapsedH * HOUR_MS >= minElapsedMs && elapsedH > 0 ? current / elapsedH : undefined;
  const ratePerH = averagePerH ?? recentPerH;
  const fastPerH =
    averagePerH != null && recentPerH != null ? Math.max(averagePerH, recentPerH) : undefined;
  const activeShare = activeShareOf(rows, startAt, now);

  const exhausted = current >= 100;
  const etaOf = (rate?: number) =>
    !exhausted && rate != null && rate > 0 ? now + ((100 - current) / rate) * HOUR_MS : undefined;
  const etaAt = etaOf(ratePerH);
  const etaFastAt = fastPerH != null && fastPerH > (ratePerH ?? 0) ? etaOf(fastPerH) : undefined;
  const projectedAtReset = ratePerH != null && leftH != null ? current + ratePerH * leftH : undefined;
  const projectedHigh = fastPerH != null && leftH != null ? current + fastPerH * leftH : undefined;
  // 只有「按平均也会超」才算会提前用完；一次爆发只体现在 projectedHigh 上。
  const runsOutBeforeReset = exhausted || (projectedAtReset != null && projectedAtReset >= 100);

  const used = startAt != null ? sumRows(rows, startAt, now) : { tokens: 0, costUsd: 0 };
  let capacity: WindowReport["capacity"];
  if (startAt != null && current >= 2 && used.tokens > 0) {
    const scale = 100 / current;
    capacity = {
      tokens: used.tokens * scale,
      costUsd: used.costUsd * scale,
      confidence: current < 5 ? "low" : current < 20 ? "medium" : "high",
    };
  }

  return {
    used: current,
    startAt,
    resetAt,
    elapsedH,
    leftH,
    recentPerH,
    averagePerH,
    ratePerH,
    fastPerH,
    activeShare,
    etaAt,
    etaFastAt,
    projectedAtReset,
    projectedHigh,
    runsOutBeforeReset,
    usedTokens: used.tokens,
    usedCostUsd: used.costUsd,
    capacity,
  };
}

function healthOf(week: WindowReport | null, five: WindowReport | null, now: number): AccountReport["health"] {
  const main = week ?? five;
  if (!main) return { level: "unknown", reason: "no-data" };
  if ((week && week.used >= 100) || (five && five.used >= 100)) return { level: "critical", reason: "exhausted" };
  if (main.runsOutBeforeReset) {
    const soon = main === week ? 24 * HOUR_MS : HOUR_MS;
    if (main.etaAt != null && main.etaAt - now < soon) return { level: "critical", reason: "runs-out-soon" };
    return { level: "serious", reason: "runs-out" };
  }
  if ((main.projectedAtReset ?? 0) >= 85 || (main.projectedHigh ?? 0) >= 100) {
    return { level: "warning", reason: "tight" };
  }
  if (week && five && five.used >= 80) return { level: "warning", reason: "five-hour-high" };
  return { level: "good", reason: "ok" };
}

export function analyzeAccount(kind: AccountKind, input: QuotaSample[], rows: HourRow[], now: number): AccountReport {
  const sorted = input.filter((sample) => Number.isFinite(sample.at) && sample.at <= now).sort((a, b) => a.at - b.at);
  /*
   * 只看当前账号的采样。切换账号后，A 的 80% 和 B 的 10% 连成一条线：
   * 从 B 切回 A 时像是一小时涨了 70 个点，预测直接报警。
   * 没记账号的老采样（0.3 以前）只可能来自 CLI 当时登录的那一个，算作同一个。
   */
  const current = sorted.at(-1)?.account;
  const samples = current ? sorted.filter((sample) => !sample.account || sample.account === current) : sorted;
  const latest = samples.at(-1);

  let week: WindowReport | null = null;
  let trend: Point[] = [];
  if (latest?.week != null) {
    const resetAt = time(latest.weekReset);
    const startAt = time(latest.weekStart) ?? (resetAt != null ? resetAt - WEEK_MS : undefined);
    const rolled = rollWindow(latest.week, startAt, resetAt, WEEK_MS, now);
    trend = rolled.stale ? [] : pointsOf(samples, (sample) => sample.week, rolled.startAt);
    week = analyzeWindow(
      {
        current: rolled.current,
        startAt: rolled.startAt,
        resetAt: rolled.resetAt,
        points: trend,
        // 最近一天的节奏比最近 6 小时稳，够盖住一个作息周期
        lookbackMs: 24 * HOUR_MS,
        minSpanMs: 2 * HOUR_MS,
        minElapsedMs: 4 * HOUR_MS,
      },
      rows,
      now,
    );
  }

  let five: WindowReport | null = null;
  if (latest?.five != null) {
    const resetAt = time(latest.fiveReset);
    const startAt = resetAt != null ? resetAt - FIVE_HOUR_MS : undefined;
    const rolled = rollWindow(latest.five, startAt, resetAt, FIVE_HOUR_MS, now);
    const points = rolled.stale ? [] : pointsOf(samples, (sample) => sample.five, rolled.startAt);
    five = analyzeWindow(
      {
        current: rolled.current,
        startAt: rolled.startAt,
        resetAt: rolled.resetAt,
        points,
        lookbackMs: HOUR_MS,
        minSpanMs: 15 * 60_000,
        minElapsedMs: 30 * 60_000,
      },
      rows,
      now,
    );
  }

  // 每小时额度涨了几个点：阶梯函数 —— 某一刻的值 = 那一刻之前最后一次采样。
  const weekSamples = samples.filter((sample) => sample.week != null);
  const pctAt = (at: number) => {
    let value: number | undefined;
    for (const sample of weekSamples) {
      if (sample.at > at) break;
      value = sample.week;
    }
    return value;
  };
  const base = Math.floor(now / HOUR_MS) * HOUR_MS;
  const hourly: AccountReport["hourly"] = [];
  for (let i = 23; i >= 0; i--) {
    const hour = base - i * HOUR_MS;
    let tokens = 0;
    let costUsd = 0;
    let requests = 0;
    for (const row of rows) {
      if (row.hour !== hour) continue;
      tokens += row.tokens;
      costUsd += row.costUsd;
      requests += row.requests;
    }
    const from = pctAt(hour);
    const to = pctAt(Math.min(now, hour + HOUR_MS));
    // 变小了说明中间重置过，这一小时的涨幅说不清，宁可不给。
    const pctDelta = from != null && to != null && to >= from ? to - from : undefined;
    hourly.push({ hour, tokens, costUsd, requests, pctDelta });
  }

  const modelsFrom = week?.startAt ?? now - WEEK_MS;
  const byModel = new Map<string, AccountReport["models"][number]>();
  for (const row of rows) {
    if (row.hour + HOUR_MS <= modelsFrom || row.hour > now) continue;
    const hit = byModel.get(row.model) ?? { model: row.model, tokens: 0, costUsd: 0, requests: 0, firstHour: row.hour };
    hit.tokens += row.tokens;
    hit.costUsd += row.costUsd;
    hit.requests += row.requests;
    hit.firstHour = Math.min(hit.firstHour, row.hour);
    byModel.set(row.model, hit);
  }
  const models = [...byModel.values()]
    .filter((item) => item.tokens > 0 || item.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);

  return {
    kind,
    sampleCount: samples.length,
    firstSampleAt: samples[0]?.at,
    lastSampleAt: latest?.at,
    resetCredits: latest?.resetCredits,
    plan: latest?.plan,
    week,
    five,
    trend,
    hourly,
    models,
    health: healthOf(week, five, now),
  };
}
