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
 * - **耗尽预测以最近趋势为主**：从最近 24 小时（5 小时窗口取最近 1 小时）的多个采样跨度
 *   计算加权中位数，降低单次采样抖动和突然跳点的影响。窗口平均速度只在近期采样跨度还不够时兜底。
 *   这样长时间空闲不会继续沿用旧平均值，刚恢复使用也不会等整窗平均慢慢追上。
 * - **最近没有增长就不输出耗尽时间**。已经用掉的百分比仍然是真实历史，但没有证据说明接下来会以
 *   什么速度继续消耗，显示「暂不估计」比给一个看似精确的日期更可靠。
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
  /** 整个窗口的墙钟平均：已用 ÷ 窗口已过时间。近期跨度不足时作为兜底。 */
  averagePerH?: number;
  /** 预测用的速度（优先 recentPerH，没有足够近期跨度时退回 averagePerH）。 */
  ratePerH?: number;
  /** 近期跨度中较快的估计，用于显示一个保守上界。 */
  fastPerH?: number;
  /** 按较快近期趋势推到重置时的百分比。 */
  projectedHigh?: number;
  /** 按 fastPerH 什么时候到 100%。 */
  etaFastAt?: number;
  /** 这个窗口里真正有用量的小时占比。有的话界面可以写成「大约每天用 n 小时」。 */
  activeShare?: number;
  /** 按当前预测速度什么时候到 100%。已经用完、或者速度为 0 时没有。 */
  etaAt?: number;
  /** 按当前预测速度到重置那一刻会是多少。可以超过 100。 */
  projectedAtReset?: number;
  /** 已经用完，或者 ETA 早于当前窗口重置时间。 */
  runsOutBeforeReset: boolean;
  usedTokens: number;
  usedCostUsd: number;
  /** 整个窗口（100%）大约折合多少。 */
  capacity?: { tokens: number; costUsd: number; confidence: Confidence };
};

export type Confidence = "low" | "medium" | "high";

/**
 * 一个（已结束或进行中的）额度窗口折算出的「整窗能用多少」。画历史折线用。
 * 以窗口里最后一次采样为准：tokens 是窗口开始到那次采样之间本机官方会话的用量，pct 是那次采样的已用百分比。
 */
export type CapacityPoint = {
  startAt: number;
  resetAt: number;
  /** 最后一次采样的时间。 */
  at: number;
  pct: number;
  tokens: number;
  costUsd: number;
  capacityTokens: number;
  capacityCostUsd: number;
  confidence: Confidence;
  /** 当前还没结束的窗口。 */
  current: boolean;
};

export type CapacityHistory = {
  points: CapacityPoint[];
  /** 没法估、不计入折线的窗口数：已用不到 2%，或者本机在这个窗口里没有用量（可能用在别的设备上）。 */
  skipped: { tooLow: number; noLocal: number };
};

export type HealthLevel = "good" | "warning" | "serious" | "critical" | "unknown";
export type HealthReason = "no-data" | "exhausted" | "runs-out-soon" | "runs-out" | "tight" | "five-hour-high" | "ok";

export type AccountReport = {
  kind: AccountKind;
  sampleCount: number;
  firstSampleAt?: number;
  lastSampleAt?: number;
  /**
   * 最后一次查询成功的时间（≥ lastSampleAt）。数值没变时采样历史 15 分钟才记一条，
   * 判断「采样过期」要用这个，否则额度一不动就误报过期。
   */
  lastCheckedAt?: number;
  resetCredits?: number;
  plan?: string;
  /** 这份额度是哪个账号的（TokenPulse 里「当前使用」的那个，= 最后一条采样的账号）。 */
  accountId?: string;
  /** 这个账号的名字（邮箱），report.ts 从账号登记里补上。 */
  accountLabel?: string;
  week: WindowReport | null;
  five: WindowReport | null;
  /** 当前周窗口里的采样点，画曲线用。 */
  trend: { at: number; pct: number }[];
  /** 最近 24 个整点小时，最早的在前。pctDelta = 这一小时里周额度涨了几个点。 */
  hourly: { hour: number; tokens: number; costUsd: number; requests: number; pctDelta?: number }[];
  /** 当前周窗口里各型号的用量。firstHour 用来给颜色排座次（颜色跟着型号走，不跟排名走）。 */
  models: { model: string; tokens: number; costUsd: number; requests: number; firstHour: number }[];
  health: { level: HealthLevel; reason: HealthReason };
  /** 历史上每个窗口折算的整窗容量，看总额度有没有变。 */
  capacityHistory: { week: CapacityHistory; five: CapacityHistory };
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

/**
 * 用多个「最后一个采样点 - 更早采样点」的速度做加权中位数。
 * 短跨度权重更高，能跟上当前节奏；中位数又不会被某一次异常跳点带跑。
 */
function robustRecentRate(points: Point[], lookbackMs: number, minSpanMs: number) {
  const last = points.at(-1);
  if (!last) return undefined;
  const cutoff = last.at - lookbackMs;
  const candidates = points
    .filter((point) => point.at >= cutoff && last.at - point.at >= minSpanMs)
    .map((point) => {
      const spanH = (last.at - point.at) / HOUR_MS;
      return { rate: Math.max(0, last.pct - point.pct) / spanH, weight: 1 / spanH };
    })
    .filter((item) => Number.isFinite(item.rate) && item.rate >= 0);
  if (!candidates.length) return undefined;
  const sorted = [...candidates].sort((a, b) => a.rate - b.rate);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  let cumulative = 0;
  let rate = sorted.at(-1)!.rate;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= total / 2) { rate = item.rate; break; }
  }
  return { rate, high: sorted[Math.max(0, Math.ceil(sorted.length * 0.8) - 1)].rate };
}

/**
 * [from, to] 之间的用量。用量是按整点小时记的，窗口边界不在整点时按重叠时长折算
 * （假设一小时内均匀使用）：以前整小时都算进去，5 小时窗口从 04:44 开始会多算 04:00–04:44，
 * 两头加起来误差能到两成。当前这一小时只到 now 为止，所以它的「时长」按到 now 算。
 */
export function sumRows(rows: HourRow[], from: number, to: number, now = to) {
  let tokens = 0;
  let costUsd = 0;
  for (const row of rows) {
    const end = Math.min(row.hour + HOUR_MS, Math.max(now, to));
    const overlap = Math.min(end, to) - Math.max(row.hour, from);
    if (overlap <= 0 || end <= row.hour) continue;
    const share = Math.min(1, overlap / (end - row.hour));
    tokens += row.tokens * share;
    costUsd += row.costUsd * share;
  }
  return { tokens, costUsd };
}

export function confidenceOf(pct: number): Confidence {
  return pct < 5 ? "low" : pct < 20 ? "medium" : "high";
}

/** 折算整窗容量至少要已用这么多：Claude 的百分比是整数，1% 时误差能放大几十倍。 */
export const MIN_CAPACITY_PCT = 2;

/**
 * 把采样历史按窗口分组，每个窗口折算一次「整窗能用多少」。
 *
 * - 同一个窗口的采样按重置时间归组（容忍 10 分钟抖动：Claude 每次返回的重置时间都差几百毫秒）；
 * - 窗口里百分比掉下来过（手动重置）的，前后用量混在一起说不清，不计入；
 * - 已用不到 2%，或者本机在这个窗口里没有用量（用在了别的设备上）：没法估，不计入，只计数；
 * - 0% 的窗口是没用过，直接忽略。
 */
export function capacityHistory(
  samples: QuotaSample[],
  rows: HourRow[],
  kind: "week" | "five",
  now: number,
): CapacityHistory {
  const length = kind === "week" ? WEEK_MS : FIVE_HOUR_MS;
  const groups: { resetAt: number; startAt: number; list: { at: number; pct: number }[] }[] = [];
  for (const sample of samples) {
    const pct = kind === "week" ? sample.week : sample.five;
    const resetAt = time(kind === "week" ? sample.weekReset : sample.fiveReset);
    if (pct == null || !Number.isFinite(pct) || resetAt == null) continue;
    // 采样时窗口其实已经过了重置点（接口还没来得及更新），这条不属于任何完整窗口。
    if (sample.at > resetAt) continue;
    const last = groups.at(-1);
    if (last && Math.abs(last.resetAt - resetAt) < 10 * 60_000) {
      last.list.push({ at: sample.at, pct });
      continue;
    }
    const startAt = (kind === "week" ? time(sample.weekStart) : undefined) ?? resetAt - length;
    groups.push({ resetAt, startAt, list: [{ at: sample.at, pct }] });
  }
  const points: CapacityPoint[] = [];
  const skipped = { tooLow: 0, noLocal: 0 };
  for (const group of groups) {
    const dropped = group.list.some((point, i) => i > 0 && point.pct < group.list[i - 1].pct - 0.5);
    if (dropped) continue;
    const final = group.list.at(-1)!;
    /*
     * 0% 的不算「用得太少」：窗口根本没开始用。ChatGPT 的 5 小时窗口没用时，接口每次都把重置时间
     * 往后挪（= 现在 + 5 小时），会凑出几十个「窗口」，计进跳过数只会误导人。
     */
    if (final.pct <= 0) continue;
    if (final.pct < MIN_CAPACITY_PCT) { skipped.tooLow += 1; continue; }
    const used = sumRows(rows, group.startAt, final.at, now);
    if (used.tokens <= 0) { skipped.noLocal += 1; continue; }
    const scale = 100 / final.pct;
    points.push({
      startAt: group.startAt,
      resetAt: group.resetAt,
      at: final.at,
      pct: final.pct,
      tokens: used.tokens,
      costUsd: used.costUsd,
      capacityTokens: used.tokens * scale,
      capacityCostUsd: used.costUsd * scale,
      confidence: confidenceOf(final.pct),
      current: group.resetAt > now,
    });
  }
  return { points, skipped };
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
  let recentHighPerH: number | undefined;
  const last = points.at(-1);
  if (last) {
    const recent = robustRecentRate(points, lookbackMs, minSpanMs);
    recentPerH = recent?.rate;
    recentHighPerH = recent?.high;
  }
  /*
   * 墙钟平均：已用百分比是窗口累计值，除以窗口真正过去的时间。
   * 关机、睡觉这些没有采样的时间也留在分母里 —— 额度按墙钟重置，它们本来就该算。
   */
  const averagePerH =
    elapsedH != null && elapsedH * HOUR_MS >= minElapsedMs && elapsedH > 0 ? current / elapsedH : undefined;
  // 防止「最近一小段突然跳高」把整个窗口直接判成必然耗尽；最多放大到整窗平均的 2 倍。
  // 但近期明确没有增长时保持 0，不拿旧平均速度制造一个虚假的 ETA。
  const ratePerH = recentPerH == null
    ? averagePerH
    : recentPerH === 0 || averagePerH == null
      ? recentPerH
      : Math.min(recentPerH, averagePerH * 2);
  const fastPerH = recentHighPerH != null && recentPerH != null ? Math.max(recentHighPerH, recentPerH) : undefined;
  const activeShare = activeShareOf(rows, startAt, now);

  const exhausted = current >= 100;
  const etaOf = (rate?: number) =>
    !exhausted && rate != null && rate > 0 ? now + ((100 - current) / rate) * HOUR_MS : undefined;
  const etaAt = etaOf(ratePerH);
  const etaFastAt = fastPerH != null && fastPerH > (ratePerH ?? 0) ? etaOf(fastPerH) : undefined;
  const projectedAtReset = ratePerH != null && leftH != null ? current + ratePerH * leftH : undefined;
  const projectedHigh = fastPerH != null && leftH != null ? current + fastPerH * leftH : undefined;
  // 只有 ETA 早于当前窗口重置时间才标记为重置前会达到上限。
  const runsOutBeforeReset = exhausted || (etaAt != null && resetAt != null && etaAt < resetAt);

  const used = startAt != null ? sumRows(rows, startAt, now, now) : { tokens: 0, costUsd: 0 };
  let capacity: WindowReport["capacity"];
  if (startAt != null && current >= 2 && used.tokens > 0) {
    const scale = 100 / current;
    capacity = {
      tokens: used.tokens * scale,
      costUsd: used.costUsd * scale,
      confidence: confidenceOf(current),
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

export function analyzeAccount(
  kind: AccountKind,
  input: QuotaSample[],
  rows: HourRow[],
  now: number,
  checked?: { at: number; account?: string },
): AccountReport {
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
  // rows 是全部历史（画容量折线要用），按小时建个索引，别 24 格每格都把全部历史扫一遍。
  const byHour = new Map<number, { tokens: number; costUsd: number; requests: number }>();
  for (const row of rows) {
    if (row.hour < base - 23 * HOUR_MS || row.hour > base) continue;
    const hit = byHour.get(row.hour) ?? { tokens: 0, costUsd: 0, requests: 0 };
    hit.tokens += row.tokens;
    hit.costUsd += row.costUsd;
    hit.requests += row.requests;
    byHour.set(row.hour, hit);
  }
  for (let i = 23; i >= 0; i--) {
    const hour = base - i * HOUR_MS;
    const { tokens, costUsd, requests } = byHour.get(hour) ?? { tokens: 0, costUsd: 0, requests: 0 };
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
    accountId: latest?.account,
    // 查询成功时间只认同一个账号的：切换账号后，上一个账号的查询时间不能让新账号显得「刚更新」。
    lastCheckedAt:
      latest && checked && checked.at <= now && (!checked.account || !latest.account || checked.account === latest.account)
        ? Math.max(latest.at, checked.at)
        : latest?.at,
    resetCredits: latest?.resetCredits,
    plan: latest?.plan,
    week,
    five,
    trend,
    hourly,
    models,
    health: healthOf(week, five, now),
    capacityHistory: { week: capacityHistory(samples, rows, "week", now), five: capacityHistory(samples, rows, "five", now) },
  };
}
