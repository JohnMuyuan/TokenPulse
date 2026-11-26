import { randomUUID } from "crypto";
import { dataFile, readJson, writeJson } from "./paths";
import type { AccountKind } from "./quota";
import type { RequestRow } from "./request-log";
import { confidenceOf, FIVE_HOUR_MS, robustRecencyEstimate, weightedMedian, WEEK_MS, windowSegments, RESET_STYLE, type CapacityHistory, type CapacityPoint, type WindowSegment } from "./quota-monitor";
import { observeQuotaIntervals } from "./quota-attribution";
import type { QuotaSample } from "./quota-history";

/**
 * 本机以外的额度消耗（0.3.9）。
 *
 * 官方的已用百分比是整个账号的：网页 / App 聊天、别的电脑也在用。以前要么把这些全算成本机 Code（容量算小），
 * 要么干脆不折算容量（要用户做「本机专用校准」）。现在按采样区间自动分开：
 * - 额度涨了、同期本机没有任何 Code 请求（前后 5 分钟也没有）→ 本机以外的消耗，不进容量折算，时间线上标出来；
 * - 额度涨了、同期本机有请求 → 按本机用量折算；同窗口、同模型和思考等级有稳定对照时，可排除明显偏高的上涨；
 * - 用户在时间线上标注过的时段（「这段时间我在网页上用 Opus 聊天」）→ 可能是混用，整段不进折算；
 *   标注的模型和思考等级用来把这段涨幅换算成等价的 Token。
 * - 长缺口里的变化不进折算，回落反弹只计高水位以上的新涨幅。
 */

export type OffMachineSource = "chat" | "device" | "other";
/**
 * model 为空 = 用户分割出来、还没标注的一段（0.3.13）；ignored = 用户「删除」的一段：不算本机以外，不进汇总，可以恢复。
 */
export type OffMachineMark = { id: string; kind: AccountKind; accountId: string; from: number; to: number; model: string; effort: string; source: OffMachineSource; note: string; updatedAt: number; ignored?: boolean };
type Store = { version: 1; marks: OffMachineMark[] };

/** 只有这一家的模型才吃这一家的订阅额度（经 CC Switch 把 Claude Code 指到别家模型的请求不算）。 */
export const FAMILY: Record<AccountKind, RegExp> = { chatgpt: /^(gpt|codex|o\d)/i, claude: /^claude/i, grok: /^grok/i };
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "adaptive", "auto", "unknown"]);
const GAP_MS = 30 * 60000;
/** 一段干净区间至少要累计这么多个百分点，容量才算得出来（和以前 2% 的门槛一致）。 */
export const MIN_CLEAN_POINTS = 2;
const file = () => dataFile("quota-offmachine.json");

function valid(m: OffMachineMark) {
  return Boolean(m && typeof m.id === "string" && m.id.length <= 100 && ["claude", "chatgpt", "grok"].includes(m.kind) && typeof m.accountId === "string" && m.accountId.startsWith(m.kind + ":")
    && Number.isFinite(m.from) && Number.isFinite(m.to) && m.to > m.from && m.to - m.from <= 8 * 86400000 && typeof m.model === "string" && m.model.length <= 120 && EFFORTS.has(m.effort)
    && ["chat", "device", "other"].includes(m.source) && typeof m.note === "string" && m.note.length <= 300 && (m.ignored === undefined || typeof m.ignored === "boolean"));
}
export function readMarks(kind?: AccountKind, accountId?: string): OffMachineMark[] {
  const stored = readJson<Store | null>(file(), null);
  const marks = stored?.version === 1 && Array.isArray(stored.marks) ? stored.marks.filter(valid) : [];
  return marks.filter((m) => (!kind || m.kind === kind) && (!accountId || m.accountId === accountId)).sort((a, b) => a.from - b.from);
}
/**
 * 新建 / 修改 / 删除一条标注，返回这个账号的全部标注。
 * 0.3.13 起还有像剪视频一样的操作（本机以外的时段由用户自己切，软件不替用户切）：
 * - split：在 at 处把一段切成两段。给了 id 就切那条标注（后一段复制它的模型 / 等级 / 来源）；
 *   没给 id 就是切检测到的一段（from → to），切出两条「待标注」（model 为空）；
 * - ignore：删除这一段（给 id 就把那条标成 ignored，没给 id 就新建一条 ignored 盖住 from → to）；
 * - restore：恢复删除的一段（去掉 ignored）。
 */
export function updateMark(value: unknown, now = Date.now()) {
  const q = (value && typeof value === "object" ? value : {}) as Partial<OffMachineMark> & { action?: string; at?: number };
  if (!q.kind || !["claude", "chatgpt", "grok"].includes(q.kind) || typeof q.accountId !== "string" || !q.accountId.startsWith(q.kind + ":") || q.accountId.length > 300) throw new Error("标注参数无效。");
  const all = readMarks();
  const save = () => { writeJson(file(), { version: 1, marks: all.slice(-2000) }); return readMarks(q.kind, q.accountId); };
  const own = () => { const i = all.findIndex((m) => m.id === q.id && m.accountId === q.accountId); if (i < 0) throw new Error("找不到这条标注。"); return i; };
  const range = (from: number, to: number) => {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error("结束时间要晚于开始时间。");
    if (to - from > 8 * 86400000) throw new Error("一段标注最长 8 天。");
    if (from > now + 60000) throw new Error("不能标注还没发生的时间。");
  };
  const pending = (from: number, to: number, extra: Partial<OffMachineMark> = {}): OffMachineMark => ({ id: randomUUID(), kind: q.kind!, accountId: q.accountId!, from, to, model: "", effort: "unknown", source: "other", note: "", updatedAt: now, ...extra });
  if (q.action === "delete") {
    own();
    writeJson(file(), { version: 1, marks: all.filter((m) => m.id !== q.id) });
    return readMarks(q.kind, q.accountId);
  }
  if (q.action === "split") {
    const at = Number(q.at);
    if (q.id) {
      const i = own(), m = all[i];
      if (!(at > m.from && at < m.to)) throw new Error("分割点要在这一段中间。");
      all.push({ ...m, id: randomUUID(), from: at, updatedAt: now });
      all[i] = { ...m, to: at, updatedAt: now };
      return save();
    }
    const from = Number(q.from), to = Number(q.to);
    range(from, to);
    if (!(at > from && at < to)) throw new Error("分割点要在这一段中间。");
    all.push(pending(from, at), pending(at, to));
    return save();
  }
  if (q.action === "ignore") {
    if (q.id) { const i = own(); all[i] = { ...all[i], ignored: true, updatedAt: now }; return save(); }
    const from = Number(q.from), to = Number(q.to);
    range(from, to);
    all.push(pending(from, to, { ignored: true }));
    return save();
  }
  if (q.action === "restore") {
    const i = own(); const { ignored: _drop, ...rest } = all[i];
    all[i] = { ...rest, updatedAt: now };
    return save();
  }
  const from = Number(q.from), to = Number(q.to);
  const mark: OffMachineMark = {
    id: typeof q.id === "string" && q.id ? q.id : randomUUID(),
    kind: q.kind, accountId: q.accountId, from, to,
    model: String(q.model || "").trim().slice(0, 120), effort: EFFORTS.has(String(q.effort)) ? String(q.effort) : "unknown",
    source: q.source === "device" || q.source === "other" ? q.source : "chat", note: String(q.note || "").trim().slice(0, 300), updatedAt: now,
  };
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error("结束时间要晚于开始时间。");
  if (to - from > 8 * 86400000) throw new Error("一段标注最长 8 天。");
  if (from > now + 60000) throw new Error("不能标注还没发生的时间。");
  if (!mark.model) throw new Error("请选择或填写用了什么模型。");
  const existing = all.findIndex((m) => m.id === mark.id);
  if (existing >= 0 && all[existing].accountId !== mark.accountId) throw new Error("找不到这条标注。");
  if (existing >= 0) all[existing] = mark; else all.push(mark);
  writeJson(file(), { version: 1, marks: all.slice(-2000) });
  return readMarks(q.kind, q.accountId);
}
export function forgetMarks(accountId: string) {
  const all = readMarks();
  if (all.some((m) => m.accountId === accountId)) writeJson(file(), { version: 1, marks: all.filter((m) => m.accountId !== accountId) });
}
/** 标注过（含待标注的分段）的时段：不进容量折算。删除（ignored）的不算。 */
export function overlapsMark(marks: OffMachineMark[], from: number, to: number) {
  return marks.some((m) => !m.ignored && m.from < to && m.to > from);
}
/** 用户删除（ignored）的时段：不算本机以外。 */
export function overlapsIgnored(marks: OffMachineMark[], from: number, to: number) {
  return marks.some((m) => m.ignored && m.from < to && m.to > from);
}

export type OffInterval = { from: number; to: number; points: number };
type Observation = ReturnType<typeof observeQuotaIntervals>[number];
type Measurement = Omit<Observation, "issue"> & {
  issue?: Observation["issue"] | "marked" | "ignored" | "planChange" | "suspected";
  cost: number;
  priced: boolean;
};
export function quotaPlans(samples: QuotaSample[]) {
  return new Map(samples.map(sample => [sample.at, typeof sample.plan === "string" ? sample.plan.trim().toLowerCase() || undefined : undefined]));
}

/** 同一窗口内只比较同模型、同等级且费用完整的请求。异常段整体退出折算，避免估造外部占用。 */
export function cleanSegment(segment: WindowSegment, rows: RequestRow[], marks: OffMachineMark[], now: number, plans: ReturnType<typeof quotaPlans>, detectMixed = true) {
  let plan: string | undefined;
  let changedPlanAt = -Infinity;
  for (const point of segment.points) {
    const nextPlan = plans.get(point.at);
    if (!nextPlan) continue;
    if (plan && nextPlan !== plan) changedPlanAt = point.at;
    plan = nextPlan;
  }
  const measurements: Measurement[] = observeQuotaIntervals(segment, rows, now).map((observation) => {
    const { from, to } = observation.interval;
    const cost = observation.rows.reduce((sum, row) => sum + row.costUsd, 0);
    const priced = observation.rows.length > 0 && observation.rows.every(row => row.priced);
    let issue: Measurement["issue"] = observation.issue;
    if (!issue && from < changedPlanAt) issue = "planChange";
    if (!issue && overlapsMark(marks, from, to)) issue = "marked";
    if (!issue && overlapsIgnored(marks, from, to)) issue = "ignored";
    return { ...observation, cost, priced, issue };
  });
  if (detectMixed) {
    const cohorts = new Map<string, Measurement[]>();
    for (const measurement of measurements) {
      const { issue, interval, rows: part, priced, cost } = measurement;
      if (issue || interval.kind !== "local_present" || !priced || cost <= 0 || interval.points < 2) continue;
      const { model, effort } = part[0];
      if (!effort || effort === "unknown" || effort === "enabled" || !part.every(row => row.model === model && row.effort === effort)) continue;
      const key = `${model}\u0000${effort}`;
      const cohort = cohorts.get(key) ?? [];
      cohort.push(measurement);
      cohorts.set(key, cohort);
    }
    for (const cohort of cohorts.values()) {
      if (cohort.length < 4) continue;
      const rates = cohort.map(measurement => measurement.cost / measurement.interval.points);
      const reference = weightedMedian(rates.map(rate => [rate, 1]));
      // 至少三个接近的参照区间，分歧较大时继续保留观测，不猜测混用。
      if (rates.filter(rate => rate >= reference * 0.75 && rate <= reference * 1.33).length < 3) continue;
      for (const measurement of cohort) {
        const expected = measurement.cost / reference;
        if (expected >= measurement.interval.points * 0.4 || measurement.interval.points - expected < 2) continue;
        measurement.issue = "suspected";
        measurement.interval.kind = "uncertain";
        measurement.interval.suspected = true;
      }
    }
  }
  const offIntervals: OffInterval[] = [];
  let points = 0, tokens = 0, cost = 0, offPoints = 0, markedPoints = 0, suspectedPoints = 0, priced = true;
  for (const measurement of measurements) {
    const { interval, issue } = measurement;
    if (issue === "marked") markedPoints += interval.points;
    if (issue === "suspected") suspectedPoints += interval.points;
    if (issue) continue;
    if (interval.kind === "unmatched") {
      offPoints += interval.points;
      offIntervals.push({ from: interval.from, to: interval.to, points: interval.points });
    }
    if (interval.kind !== "local_present") continue;
    points += interval.points;
    tokens += interval.localTokens;
    cost += measurement.cost;
    priced &&= measurement.priced;
  }
  return { plan, measurements, points, tokens, cost, priced, offIntervals, offPoints, markedPoints, suspectedPoints };
}

const RECENCY = { week: { count: 3, decay: 0.55, length: WEEK_MS }, five: { count: 6, decay: 0.85, length: FIVE_HOUR_MS } };

export function recentQuotaWindows<T extends { at: number }>(windows: T[], window: "week" | "five", now: number) {
  const { count, length } = RECENCY[window];
  return windows.filter(item => item.at >= now - (count + 1) * length).slice(-count);
}

export function quotaCapacityEstimate(items: { value: number; weight: number }[], window: "week" | "five") {
  // 限制单个窗口的权重，避免一个消耗特别多的旧窗口压住近期窗口。
  return robustRecencyEstimate(items.map(item => ({ ...item, weight: Math.min(item.weight, 20) })), RECENCY[window].decay);
}

/**
 * 本机以外的区间合成一段，时间线上一段一个色块。0.3.13 起软件不替用户切：只要中间**没有本机请求**，
 * 相隔 6 小时以内的都算同一段（用户在时间线上自己分割）；没给 rows 时按以前的 30 分钟。
 */
const MERGE_MAX_MS = 6 * 3600000;
export function mergeOff(intervals: OffInterval[], rows?: RequestRow[]) {
  const merged: OffInterval[] = [];
  const quietBetween = (a: number, b: number) => !rows || !rows.some((r) => r.at > a && r.at < b);
  for (const item of [...intervals].sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    const gap = item.from - last?.to!;
    if (last && (gap <= GAP_MS || (rows && gap <= MERGE_MAX_MS && quietBetween(last.to, item.from)))) { last.to = Math.max(last.to, item.to); last.points += item.points; }
    else merged.push({ ...item });
  }
  return merged;
}

/**
 * 按干净区间折算的历史容量和当前窗口容量（额度详情的「额度容量趋势」「整窗容量折算」用）。
 * 容量 = 干净区间里的本机用量 ÷ 这些区间的官方涨幅 × 100；本机以外和标注过的涨幅都不参与。
 */
export function cleanCapacity(kind: AccountKind, samples: QuotaSample[], rows: RequestRow[], marks: OffMachineMark[], window: "week" | "five", now: number) {
  const sorted = samples.filter(sample => Number.isFinite(sample.at) && sample.at <= now).sort((a, b) => a.at - b.at);
  const plans = quotaPlans(sorted);
  const segments = windowSegments(sorted, window, RESET_STYLE[kind] ?? "keeps");
  const history: CapacityHistory & { basis: "clean" } = { points: [], skipped: { tooLow: 0, noLocal: 0 }, basis: "clean" };
  const measured: { at: number; point: CapacityPoint; weight: number; plan?: string; priced: boolean }[] = [];
  let active: ReturnType<typeof cleanSegment> | undefined;
  for (const [index, segment] of segments.entries()) {
    const final = segment.points.at(-1);
    if (!final) continue;
    const clean = cleanSegment(segment, rows, marks, now, plans);
    const isCurrent = index === segments.length - 1 && segment.endAt > now;
    if (isCurrent) active = clean;
    if (final.pct <= 0) continue;
    if (clean.points < MIN_CLEAN_POINTS || clean.tokens <= 0) {
      if (final.pct < MIN_CLEAN_POINTS) history.skipped.tooLow += 1;
      else history.skipped.noLocal += 1;
      continue;
    }
    const scale = 100 / clean.points;
    const point: CapacityPoint = {
      startAt: segment.startAt, resetAt: segment.resetAt, endAt: segment.endAt, at: final.at, pct: final.pct,
      tokens: clean.tokens, costUsd: clean.cost, capacityTokens: clean.tokens * scale, capacityCostUsd: clean.cost * scale,
      confidence: confidenceOf(clean.points), current: isCurrent,
      offPoints: clean.offPoints, markedPoints: clean.markedPoints, cleanPoints: clean.points, suspectedPoints: clean.suspectedPoints,
      ...(segment.endedByReset ? { endedByReset: segment.endedByReset } : {}),
      ...(segment.startedByReset ? { startedByReset: segment.startedByReset } : {}),
    };
    history.points.push(point);
    measured.push({ at: final.at, point, weight: clean.points, plan: clean.plan, priced: clean.priced });
  }
  const recent = active ? recentQuotaWindows(measured.filter(item => item.plan === active?.plan), window, now) : [];
  const current = active && recent.length ? {
    tokens: quotaCapacityEstimate(recent.map(item => ({ value: item.point.capacityTokens, weight: item.weight })), window),
    costUsd: quotaCapacityEstimate(recent.map(item => ({ value: item.priced ? item.point.capacityCostUsd : 0, weight: item.weight })), window),
    confidence: recent.at(-1)!.point.current ? recent.at(-1)!.point.confidence : "low" as const,
    offPoints: active.offPoints,
    suspectedPoints: active.suspectedPoints,
    basis: recent.length > 1 || !recent[0].point.current ? "recent" as const : "current" as const,
  } : undefined;
  return { history, current };
}

/** 这个账号这一家的官方请求，按时间排好（容量折算用）。 */
export function accountRows(rows: RequestRow[], kind: AccountKind, accountId: string) {
  return rows.filter((r) => r.account?.id === accountId && r.official === true && FAMILY[kind].test(r.model) && Number.isFinite(r.tokens) && Number.isFinite(r.costUsd)).sort((a, b) => a.at - b.at);
}
