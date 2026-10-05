import { calibrationContains, calibrationStatus, localOnlyAccounts, readCalibrations, type CalibrationSession } from "./quota-calibration";
import { cleanSegment, FAMILY, mergeOff, overlapsMark, readMarks, type OffMachineMark } from "./quota-offmachine";
import { quotaAttribution, summarizeAttribution } from "./quota-attribution";
import { readQuotaHistory, type QuotaSample } from "./quota-history";
import { windowSegments, type WindowSegment } from "./quota-monitor";
import { queryRequests, type RequestRow } from "./request-log";
import { modelCatalog, comboKey, readStudyModels, type CatalogEntry } from "./model-catalog";
import { estimateCost } from "./model-pricing";
import { benchmarkEffortRatio, loadKnowledge, priceNotes, type PriceNotes, type PriceRule } from "./knowledge";
import { priceOf } from "./model-pricing";
import { readOfficialAccountStore } from "./accounts";
import type { AccountKind } from "./quota";

/*
 * 官方百分比属于整个账号池（含聊天、其他设备）。0.3.9 起按采样区间分开：同期没有本机请求的涨幅是「本机以外」，
 * 用户在时间线上标注过的时段可能混用，都不进折算；只用同期有本机请求、没标注的区间（见 quota-offmachine.ts）。
 * 同一时刻本机在跑、网页也在聊的情况分不出来，会让容量略偏小。
 * API 费用的可加性不证明官方按 API 价格扣额度；跨模型换算仍只是费用情景参考。
 */

export type ModelStudyWindow = "five" | "week";
export type ModelStudyQuery = { kind: AccountKind; accountId: string; cycles?: { five?: string; week?: string } };
export type WindowStudyQuery = { kind: AccountKind; accountId: string; window: ModelStudyWindow; cycle?: string };
export type Cycle = { id: string; startAt: number; endAt: number; resetAt: number; used: number; sampleAt: number; active: boolean; resetCard: boolean };
export type Confidence = "insufficient" | "low" | "medium";
export type ModelCapacity = CatalogEntry & {
  key: string;
  /** 所选周期里的实际用量。 */
  tokens: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; calls: number; costUsd: number | null;
  /** 最近 30 天的用量（排序「常用」、单价和单次请求大小用）。 */
  recentTokens: number; recentCalls: number;
  /** 每百万 Token 的参考费用，以及它从哪来：组合自己的实际费用 / 同模型其他等级 / 价格表。 */
  costPerMTokens: number | null; priceBasis: "combo" | "model" | "price" | "effort" | null;
  /** 0.3.12：思考等级换算。effortRatio 是从 effortAnchor 档换到这一档的输出倍数；basis：own 本机实测 / benchmark 基准同型号 / family 家族平均。 */
  /** 0.3.13：这个型号单价的说明（优惠价 / 标价不同 / 单价刚更新）。 */
  priceNotes: PriceNotes | null;
  /**
   * 0.3.14：标价（每百万 Token 的输入 / 输出 / 缓存读 / 缓存写，cacheWrite 为 0 表示按输入价收）和它从哪条规则来；
   * auto = 自动同步的型号 id（LiteLLM，和 OpenRouter 交叉核对）；没有 auto 的是手动维护的规则（note 写着是哪条）。
   */
  listPrice: { input: number; output: number; cacheRead: number; cacheWrite: number; auto: string | null; note: string; match: string } | null;
  /**
   * 0.3.14：综合单价用的 Token 结构（未命中缓存的输入 / 缓存读 / 缓存写 / 输出，各多少 Token）。
   * basis：combo 这个组合自己的请求 / model 同模型的请求 / account 本账号全部请求 / default 没有用量时的默认结构 / effort 起点那一档按等级倍数换算输出后的结构。
   */
  priceMix: { fresh: number; cacheRead: number; cacheWrite: number; output: number; basis: "combo" | "model" | "account" | "default" | "effort"; requests: number } | null;
  effortRatio: number | null; effortBasis: "own" | "benchmark" | "family" | null; effortSource: string | null; effortAnchor: string | null; tokensPerCallBasis: "own" | "scaled" | null;
  /** 最近 30 天平均每次模型调用多少 Token（思考等级主要影响这个）。 */
  tokensPerCall: number | null;
  /** 纯区间实测。 */
  calibrationCacheShare: number | null; intervals: number; quotaPoints: number; cycleCount: number;
  estimatedTokens: number | null; estimatedCostUsd: number | null;
  observedMinTokens: number | null; observedMaxTokens: number | null; confidence: Confidence; lastAt?: number;
  /** 按整窗预算换算。 */
  derivedTokens: number | null;
  /** 最终参考：有合格同组合样本优先用样本外推，否则仅作按价情景模拟。 */
  capacityTokens: number | null; capacityCostUsd: number | null; capacityBasis: "measured" | "cost" | null;
  /** 整窗大约能调用多少次（容量 ÷ 单次调用 Token）。 */
  callsPerWindow: number | null;
  /** 当前周期剩余部分全用这个组合，大约还能用多少。 */
  remainingTokens: number | null;
  /** 相对最常用组合的容量倍数（同样的额度，能多用几倍 Token）。 */
  relative: number | null;
};
export type TimelineBin = { key: string; model: string; effort: string; startAt: number; endAt: number; firstAt: number; lastAt: number; count: number; calls: number; tokens: number; costUsd: number | null };
export type Budget = { costUsd: number | null; points: number; intervals: number; cycles: number; confidence: Confidence };

const DAY = 86400000;
const GAP_MS = 30 * 60000;
/**
 * 只有这一家的模型才吃这一家的订阅额度。经 CC Switch 等把 Claude Code 指到别家模型（deepseek、gpt…）的请求，
 * 即使会话被判成官方，也不能算进 Claude 的额度：既不进排行，也不进整窗预算。
 */
export { FAMILY };
/** 组合自己的请求少于这么多条时，缓存比例偶然性太大，单价改用同模型全部等级的。 */
const MIN_COMBO_ROWS = 30;
/** 本机实测的等级倍数：同型号两档各至少这么多次调用才算数。 */
const OWN_EFFORT_CALLS = 20;
type EffortRatio = { ratio: number; basis: "own" | "benchmark" | "family" | null; source: string | null };
/** 本账号完全没有用量时，价格表按典型的 CLI 编程用量结构折算（输入里约 85% 是缓存读取）。 */
const DEFAULT_MIX = { input: 1_000_000, cacheRead: 850_000, cacheWrite: 0, output: 30_000 };
export const TRAINING_DAYS = 30;
function day(at: number) { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
const cycleId = (value: unknown) => value == null || (typeof value === "string" && value.length <= 80);

export function parseModelStudyQuery(value: unknown): ModelStudyQuery {
  const q = value as ModelStudyQuery;
  if (!q || !["chatgpt", "claude", "grok"].includes(q.kind) || typeof q.accountId !== "string" || !q.accountId.startsWith(q.kind + ":") || q.accountId.length > 300) throw new Error("模型周期查询参数无效。");
  if (q.cycles != null && (typeof q.cycles !== "object" || !cycleId(q.cycles.five) || !cycleId(q.cycles.week))) throw new Error("模型周期查询参数无效。");
  const cycles = { ...(q.cycles?.five ? { five: q.cycles.five } : {}), ...(q.cycles?.week ? { week: q.cycles.week } : {}) };
  return { kind: q.kind, accountId: q.accountId, cycles };
}
const idOf = (s: WindowSegment) => `${s.startAt}:${s.endAt}:${s.resetAt}`;
const unknownEffort = (r: RequestRow) => !r.effort || r.effort === "unknown" || r.effort === "enabled";
const sum = (rows: RequestRow[], pick: (r: RequestRow) => number) => rows.reduce((s, r) => s + pick(r), 0);

/** 用确定归属的本机请求校准；长缺口、跨重置、套餐变化、账号推断的区间不用。 */
export function analyzeModelStudy(q: WindowStudyQuery, samples: QuotaSample[], records: RequestRow[], catalog: CatalogEntry[], now = Date.now(), sessions: CalibrationSession[] = [], localOnly = false, marks: OffMachineMark[] = []) {
  const since = now - TRAINING_DAYS * DAY;
  const ownSamples = samples.filter(s => s.account === q.accountId && s.at >= since && s.at <= now).sort((a, b) => a.at - b.at);
  const segments = windowSegments(ownSamples, q.window, q.kind === "chatgpt" ? "moves" : "keeps");
  const rows = records.filter(r => r.account?.id === q.accountId && r.official === true && FAMILY[q.kind].test(r.model) && r.at >= since && r.at <= now && Number.isFinite(r.tokens) && r.tokens >= 0 && Number.isFinite(r.costUsd) && r.costUsd >= 0 && Number.isFinite(r.input) && Number.isFinite(r.output)).sort((a, b) => a.at - b.at);
  // 一点没用过的周期不列：ChatGPT 的 5 小时窗口闲着时重置时间一直往后挪，会凑出上百个空「周期」。进行中的那个始终保留。
  const cycles: Cycle[] = segments.map((s, i) => ({ id: idOf(s), startAt: s.startAt, endAt: s.endAt, resetAt: s.resetAt, used: s.points.at(-1)?.pct ?? 0, sampleAt: s.points.at(-1)?.at ?? 0, active: i === segments.length - 1 && now >= s.startAt && now < s.endAt, resetCard: Boolean(s.startedByReset || s.endedByReset) }))
    .filter(c => c.active || c.used > 0).reverse();
  const selected = q.cycle ? cycles.find(s => s.id === q.cycle) ?? null : cycles[0] ?? null;
  const selectedSegment = selected ? segments.find(s => idOf(s) === selected.id) : undefined;
  const observed = selected ? rows.filter(r => r.at > selected.startAt && r.at <= Math.min(selected.endAt, now)) : [];
  const quotaStale = Boolean(selected && now - selected.sampleAt > GAP_MS);
  const upperBound = (at: number) => { let low = 0, high = rows.length; while (low < high) { const mid = (low + high) >>> 1; if (rows[mid].at <= at) low = mid + 1; else high = mid; } return low; };

  const attributions = quotaAttribution(segments, rows, now);
  const otherSegments = windowSegments(ownSamples, q.window === "week" ? "five" : "week", q.kind === "chatgpt" ? "moves" : "keeps");
  const allAttributions = [...attributions, ...quotaAttribution(otherSegments, rows, now)];
  const blockedSessionIds = sessions.filter(s => allAttributions.some(i => i.kind === "unmatched" && calibrationContains(s, q.accountId, i.from, i.to, now))).map(s => s.id);
  const eligibleSessions = sessions.filter(s => s.kind === q.kind && s.accountId === q.accountId && !blockedSessionIds.includes(s.id));
  const attribution = { ...summarizeAttribution(attributions.filter(i => !selected || i.cycleId === selected.id)), scope: "account_total" as const, simultaneousUsageUnknown: true, blockedSessionIds };
  const stats = new Map<string, { input: number; cacheRead: number; tokens: number; cost: number; priced: boolean; points: number; intervals: number; cycles: Set<string>; rates: number[]; lastAt: number }>();
  const pool = { cost: 0, points: 0, intervals: 0, cycles: new Set<string>() };
  const excluded = { mixed: 0, unknownEffort: 0, empty: 0, gap: 0, accountUncertain: 0, planChange: 0, unverifiedScope: 0, offMachine: 0 };
  const sampleAt = new Map(ownSamples.map(s => [s.at, s]));
  const currentPlan = ownSamples.at(-1)?.plan;
  for (const segment of segments) {
    let anchor = segment.points[0], prev = anchor;
    for (const point of segment.points.slice(1)) {
      if (!anchor) { anchor = prev = point; continue; }
      // 缺口看相邻两次采样：周额度涨 1 个点常常要半小时以上，按锚点算会把连续采样的慢速区间误判成缺口。
      const step = point.at - prev.at, elapsed = point.at - anchor.at, delta = point.pct - anchor.pct;
      prev = point;
      if (elapsed <= 0) continue;
      if (step > GAP_MS || delta < -0.01) { excluded.gap++; anchor = point; continue; }
      // 百分比可能按整数报告：0 点变化先累积，避免只把最后一小段 token 除以 1%。
      if (delta < 1) continue;
      const part = rows.slice(upperBound(anchor.at), upperBound(point.at));
      const from = anchor.at;
      const plans = [sampleAt.get(anchor.at)?.plan, sampleAt.get(point.at)?.plan];
      anchor = point;
      if (plans.some(p => p && currentPlan && p !== currentPlan)) { excluded.planChange++; continue; }
      if (!part.length) { excluded.empty++; continue; }
      if (part.some(r => r.account?.basis === "inferred")) { excluded.accountUncertain++; continue; }
      if (delta > 100) continue;
      // 用户标注过「这段时间在别处用了」的区间可能混用，不进折算。
      // 同期没有本机请求的涨幅在上面的 empty 里已经排除（那就是本机以外的消耗）；以前还要求有校准时段，0.3.9 起不再需要
      if (overlapsMark(marks, from, point.at)) { excluded.offMachine++; continue; }
      // 整窗预算：费用跨模型可加，混用区间也算；有没定价的请求就不算（费用会偏低）。
      if (part.every(r => r.priced)) { pool.cost += sum(part, r => r.costUsd); pool.points += delta; pool.intervals++; pool.cycles.add(idOf(segment)); }
      if (part.some(unknownEffort)) { excluded.unknownEffort++; continue; }
      const keys = new Set(part.map(r => comboKey(r.model, r.effort)));
      if (keys.size !== 1) { excluded.mixed++; continue; }
      const key = [...keys][0], tokens = sum(part, r => r.tokens);
      if (tokens <= 0) continue;
      const stat = stats.get(key) ?? { input: 0, cacheRead: 0, tokens: 0, cost: 0, priced: true, points: 0, intervals: 0, cycles: new Set(), rates: [], lastAt: 0 };
      stat.input += sum(part, r => r.input); stat.cacheRead += sum(part, r => r.cacheRead);
      stat.tokens += tokens; stat.cost += sum(part, r => r.costUsd); stat.priced &&= part.every(r => r.priced);
      stat.points += delta; stat.intervals++; stat.cycles.add(idOf(segment)); stat.rates.push(tokens / delta * 100); stat.lastAt = point.at;
      stats.set(key, stat);
    }
  }
  const budgetEnough = pool.points >= 5 && pool.intervals >= 3;
  const budgetConfidence: Confidence = !budgetEnough ? "insufficient" : pool.intervals >= 6 && pool.points >= 15 && pool.cycles.size >= 2 ? "medium" : "low";
  const budget: Budget = { costUsd: budgetConfidence === "insufficient" || pool.cost <= 0 ? null : pool.cost / pool.points * 100, points: pool.points, intervals: pool.intervals, cycles: pool.cycles.size, confidence: budgetConfidence };

  // 单价：组合自己 → 同模型 → 价格表 × 本账号用量结构（输入 / 缓存 / 输出的比例）。
  const pricedRows = rows.filter(r => r.priced && r.tokens > 0);
  const ownMix = { input: sum(rows, r => r.input), output: sum(rows, r => r.output), cacheRead: sum(rows, r => r.cacheRead), cacheWrite: sum(rows, r => r.cacheWrite || 0) };
  const mix = ownMix.input + ownMix.output > 0 ? ownMix : DEFAULT_MIX, mixTokens = mix.input + mix.output;
  const perToken = (list: RequestRow[]) => { const t = sum(list, r => r.tokens); return t > 0 ? sum(list, r => r.costUsd) / t : null; };

  /*
   * 思考等级（0.3.12）：等级越高，推理 / 输出 token 越多，同样的预算能用的 token 和调用次数都会变。
   * 没用够的组合从一个真实的起点推算：同型号用得最多的那一档（没用过这个型号就用本账号用得最多的那一档），
   * 把输出部分乘上「从那一档换到这一档」的倍数。倍数的来源按优先级：
   *   ① 本机实测：同型号两档各有 ≥ OWN_EFFORT_CALLS 次调用，按每次调用的平均输出算；
   *   ② Epoch AI 基准（知识库 effortUsage）里这个型号自己的数据；③ 同家族平均。都没有就不调整。
   * 有足够整段区间的组合仍然直接按实测折算（capacityBasis = measured），不受这里影响。
   */
  const kind = q.kind as "claude" | "chatgpt" | "grok";
  /*
   * 样本够不够代表平时的用法：至少 MIN_COMBO_ROWS 条，或者占本账号这 30 天请求的两成以上。
   * 只试过一两句的型号不算：冷启动的请求几乎全是缓存写入，按它算单价会高出好几倍，单次调用也小得多。
   */
  const representative = (list: RequestRow[]) => list.length >= MIN_COMBO_ROWS || (list.length > 0 && list.length * 5 >= rows.length);
  const knownEffort = (r: RequestRow) => !unknownEffort(r);
  const dominant = (list: RequestRow[]) => {
    const by = new Map<string, number>();
    for (const r of list) if (knownEffort(r)) by.set(r.effort!, (by.get(r.effort!) ?? 0) + r.output + 1);
    return [...by].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const effortRatio = (model: string, from: string, to: string): EffortRatio => {
    if (from === to) return { ratio: 1, basis: null, source: null };
    const a = rows.filter(r => r.model === model && r.effort === from), b = rows.filter(r => r.model === model && r.effort === to);
    const ca = sum(a, r => r.calls), cb = sum(b, r => r.calls);
    if (ca >= OWN_EFFORT_CALLS && cb >= OWN_EFFORT_CALLS) {
      const oa = sum(a, r => r.output) / ca, ob = sum(b, r => r.output) / cb;
      if (oa > 0 && ob > 0) return { ratio: ob / oa, basis: "own", source: null };
    }
    const bench = benchmarkEffortRatio(kind, model, from, to);
    return bench ? { ratio: bench.ratio, basis: bench.basis === "model" ? "benchmark" : "family", source: bench.source } : { ratio: 1, basis: null, source: null };
  };
  const baseFor = (model: string) => {
    // 同型号的样本不够就按本账号的整体用量算
    const sameAll = rows.filter(r => r.model === model && knownEffort(r));
    const same = representative(sameAll) ? sameAll : [];
    const pool = same.length ? same : rows.filter(knownEffort);
    const anchor = dominant(pool);
    if (!anchor) return { anchor: "medium", mix: DEFAULT_MIX, calls: 0, sameModel: false };
    const at = pool.filter(r => r.effort === anchor);
    return { anchor, mix: { input: sum(at, r => r.input), output: sum(at, r => r.output), cacheRead: sum(at, r => r.cacheRead), cacheWrite: sum(at, r => r.cacheWrite || 0) }, calls: sum(at, r => r.calls), sameModel: same.length > 0 };
  };
  // 综合单价用的 Token 结构：输入里含缓存读 / 缓存写，拆成「未命中缓存的输入」单独列
  type Mix = { input: number; output: number; cacheRead: number; cacheWrite: number };
  const mixOf = (list: RequestRow[]): Mix => ({ input: sum(list, r => r.input), output: sum(list, r => r.output), cacheRead: sum(list, r => r.cacheRead), cacheWrite: sum(list, r => r.cacheWrite || 0) });
  const shape = (m: Mix, basis: NonNullable<ModelCapacity["priceMix"]>["basis"], requests: number): ModelCapacity["priceMix"] =>
    m.input + m.output > 0 ? { fresh: Math.max(0, m.input - m.cacheRead - m.cacheWrite), cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, output: m.output, basis, requests } : null;
  const unitCost = (model: string, key: string, effort: string): [number | null, ModelCapacity["priceBasis"], EffortRatio, ReturnType<typeof baseFor>, ModelCapacity["priceMix"]] => {
    const base = baseFor(model), none: EffortRatio = { ratio: 1, basis: null, source: null };
    const combo = pricedRows.filter(r => comboKey(r.model, r.effort) === key);
    const own = combo.length >= MIN_COMBO_ROWS ? perToken(combo) : null;
    if (own) return [own, "combo", none, base, shape(mixOf(combo), "combo", combo.length)];
    const er = effortRatio(model, base.anchor, effort);
    const modelRows = pricedRows.filter(r => r.model === model);
    if (er.ratio === 1) {
      const sameModel = representative(modelRows) ? perToken(modelRows) : null;
      if (sameModel) return [sameModel, "model", er, base, shape(mixOf(modelRows), "model", modelRows.length)];
      const listed = mixTokens > 0 ? estimateCost(model, mix) / mixTokens : 0;
      return [listed > 0 ? listed : null, listed > 0 ? "price" : null, er, base, listed > 0 ? shape(mix, mix === DEFAULT_MIX ? "default" : "account", mix === DEFAULT_MIX ? 0 : rows.length) : null];
    }
    const scaled = { ...base.mix, output: base.mix.output * er.ratio };
    const scaledTokens = scaled.input + scaled.output;
    const listed = scaledTokens > 0 ? estimateCost(model, scaled) / scaledTokens : 0;
    if (listed > 0) return [listed, "effort", er, base, shape(scaled, base.mix === DEFAULT_MIX ? "default" : "effort", 0)];
    // 价格表里没有这个型号（中转自定义名等）：拆不开输入 / 输出单价，单价沿用同模型的实际费用；等级倍数只用来推算单次调用
    const sameModel = perToken(modelRows);
    return [sameModel, sameModel ? "model" : null, er, base, sameModel ? shape(mixOf(modelRows), "model", modelRows.length) : null];
  };
  const listPriceOf = (model: string): ModelCapacity["listPrice"] => {
    const rule = priceOf(model) as PriceRule | null;
    return rule ? { input: rule.input, output: rule.output, cacheRead: rule.cacheRead, cacheWrite: rule.cacheWrite, auto: rule.auto ?? null, note: rule.note || "", match: rule.match } : null;
  };

  const entries = new Map(catalog.filter(c => FAMILY[q.kind].test(c.model)).map(c => [comboKey(c.model, c.effort), c]));
  for (const row of rows) { const key = comboKey(row.model, row.effort); if (!entries.has(key)) entries.set(key, { model: row.model, effort: row.effort || "unknown", origins: ["observed"] }); }
  const remainingShare = selected?.active && !quotaStale ? Math.max(0, 100 - selected.used) / 100 : null;
  const capacities: ModelCapacity[] = [...entries].map(([key, entry]) => {
    const actual = observed.filter(r => comboKey(r.model, r.effort) === key), recent = rows.filter(r => comboKey(r.model, r.effort) === key), stat = stats.get(key);
    const enough = Boolean(stat && stat.intervals >= 3 && stat.points >= 5);
    const confidence: Confidence = !enough ? "insufficient" : stat!.intervals >= 6 && stat!.points >= 15 && stat!.cycles.size >= 2 ? "medium" : "low";
    const estimatedTokens = enough ? stat!.tokens / stat!.points * 100 : null;
    const estimatedCostUsd = enough && stat!.priced ? stat!.cost / stat!.points * 100 : null;
    // 未知等级没法说「全用这一档」；不换算，只在时间轴和用量里出现。
    const [unit, priceBasis, effortInfo, base, priceMix] = entry.effort === "unknown" ? [null, null, { ratio: 1, basis: null, source: null } as EffortRatio, null, null] : unitCost(entry.model, key, entry.effort);
    const derivedTokens = budget.costUsd != null && unit ? budget.costUsd / unit : null;
    // 有合格的同组合样本就优先用它；不能让混合 API 价格假设盖过真实百分点样本。
    const measured = estimatedTokens != null;
    const capacityTokens = measured ? estimatedTokens : derivedTokens;
    const recentCalls = sum(recent, r => r.calls), recentTokens = sum(recent, r => r.tokens);
    // 单次调用大小：自己用过就按自己的（实测优先）；没用过按起点那一档的每次调用，输出部分乘等级倍数
    const scaledPerCall = base && base.calls > 0 ? (base.mix.input + base.mix.output * effortInfo.ratio) / base.calls : null;
    const ownPerCall = recentCalls > 0 && (representative(recent) || scaledPerCall == null);
    const tokensPerCall = ownPerCall ? recentTokens / recentCalls : scaledPerCall;
    const tokensPerCallBasis = ownPerCall ? "own" : scaledPerCall != null ? "scaled" : null;
    return { ...entry, key,
      tokens: sum(actual, r => r.tokens), inputTokens: sum(actual, r => r.input), outputTokens: sum(actual, r => r.output), cacheReadTokens: sum(actual, r => r.cacheRead), calls: sum(actual, r => r.calls), costUsd: actual.every(r => r.priced) ? sum(actual, r => r.costUsd) : null,
      recentTokens, recentCalls, costPerMTokens: unit == null ? null : unit * 1e6, priceBasis, tokensPerCall, tokensPerCallBasis,
      priceNotes: priceNotes(entry.model, priceOf(entry.model) as never), listPrice: listPriceOf(entry.model), priceMix,
      effortRatio: effortInfo.basis ? effortInfo.ratio : null, effortBasis: effortInfo.basis, effortSource: effortInfo.source, effortAnchor: effortInfo.basis ? base?.anchor ?? null : null,
      calibrationCacheShare: stat?.input ? stat.cacheRead / stat.input : null, intervals: stat?.intervals ?? 0, quotaPoints: stat?.points ?? 0, cycleCount: stat?.cycles.size ?? 0,
      estimatedTokens, estimatedCostUsd, observedMinTokens: enough ? Math.min(...stat!.rates) : null, observedMaxTokens: enough ? Math.max(...stat!.rates) : null, confidence, lastAt: stat?.lastAt,
      derivedTokens, capacityTokens, capacityCostUsd: measured ? estimatedCostUsd : derivedTokens != null ? budget.costUsd : null, capacityBasis: capacityTokens == null ? null : measured ? "measured" : "cost",
      callsPerWindow: capacityTokens != null && tokensPerCall ? capacityTokens / tokensPerCall : null,
      remainingTokens: capacityTokens != null && remainingShare != null ? capacityTokens * remainingShare : null, relative: null };
  });
  // 相对容量：以最常用的组合为 1×。没有整窗预算（本机没有这个账号的用量）时，排行至少还能比出谁更耐用。
  const reference = capacities.filter(c => c.costPerMTokens).sort((a, b) => b.recentTokens - a.recentTokens || a.costPerMTokens! - b.costPerMTokens!)[0];
  for (const c of capacities) if (reference && c.costPerMTokens) c.relative = reference.costPerMTokens! / c.costPerMTokens;

  // 本机以外的时段：所选周期里「额度涨了、本机没有请求」的区间合并成段，再加上用户的标注。
  // 标注按容量表换算：这段涨了几个点 × 这个模型 × 等级的整窗容量 = 大约相当于多少 Token。
  const offClean = selectedSegment ? cleanSegment(selectedSegment, rows, marks, now) : null;
  const pctAt = (at: number) => { let value = 0; for (const p of selectedSegment?.points ?? []) { if (p.at > at) break; value = p.pct; } return value; };
  const cycleMarks = selected ? marks.filter(m => m.from < Math.min(selected.endAt, now) && m.to > selected.startAt) : [];
  const offMachine = {
    points: offClean?.offPoints ?? 0,
    markedPoints: offClean?.markedPoints ?? 0,
    // 用户切过 / 标过 / 删过的部分不再算「检测到」：只把没被任何标注盖住的区间合并成段
    detected: mergeOff((offClean?.offIntervals ?? []).filter(i => !cycleMarks.some(m => m.from < i.to && m.to > i.from)), rows),
    marks: cycleMarks.map(m => {
      const points = Math.max(0, pctAt(Math.min(m.to, selected!.endAt)) - pctAt(Math.max(m.from, selected!.startAt)));
      const capacity = capacities.find(c => c.key === comboKey(m.model, m.effort)) ?? capacities.find(c => c.model === m.model && c.capacityTokens != null);
      return { ...m, points, equivalentTokens: capacity?.capacityTokens != null ? capacity.capacityTokens * points / 100 : null, equivalentCostUsd: budget.costUsd != null ? budget.costUsd * points / 100 : null };
    }),
  };

  const bins = new Map<string, TimelineBin>();
  // 一分钟一格：时间线可以放大到几分钟的范围看；格子只按有请求的分钟生成，数量不超过请求条数
  const binMs = 60000;
  for (const r of observed) {
    const key = comboKey(r.model, r.effort), start = selected!.startAt + Math.floor((r.at - selected!.startAt) / binMs) * binMs;
    const k = key + "|" + start;
    const bin = bins.get(k) ?? { key, model: r.model, effort: r.effort || "unknown", startAt: start, endAt: Math.min(start + binMs, selected!.endAt), firstAt: r.at, lastAt: r.at, count: 0, calls: 0, tokens: 0, costUsd: 0 };
    bin.firstAt = Math.min(bin.firstAt, r.at); bin.lastAt = Math.max(bin.lastAt, r.at); bin.count++; bin.calls += r.calls; bin.tokens += r.tokens; bin.costUsd = bin.costUsd != null && r.priced ? bin.costUsd + r.costUsd : null; bins.set(k, bin);
  }
  const kb = loadKnowledge();
  return { query: q, now, localOnly, trainingSince: since,
    /** 0.3.14：单价来自哪一版模型知识库（内置 / 在线更新）。 */
    priceSource: { version: kb.knowledge.version, updatedAt: kb.knowledge.updatedAt, source: kb.source }, trainingDays: TRAINING_DAYS, cycles, selected, quotaStale, partialCycle: Boolean(selected && selected.startAt < since), attribution, budget, capacities, timeline: [...bins.values()].sort((a, b) => a.startAt - b.startAt), binMs, excluded, offMachine,
    /** 所选周期的额度采样（画在时间轴上方）。 */
    track: (selectedSegment?.points ?? []).map(p => ({ at: p.at, pct: p.pct })),
    totals: { tokens: sum(observed, r => r.tokens), calls: sum(observed, r => r.calls), records: observed.length, unknownEffort: observed.filter(unknownEffort).length },
    coverage: { firstRecordAt: rows[0]?.at ?? null, latestRecordAt: rows.at(-1)?.at ?? null, quotaSampleAt: ownSamples.at(-1)?.at ?? null } };
}
export type ModelStudy = ReturnType<typeof analyzeModelStudy>;
export type ModelStudies = { kind: AccountKind; accountId: string; calibration: ReturnType<typeof calibrationStatus>; localOnly: boolean; catalog: CatalogEntry[]; five: ModelStudy; week: ModelStudy };

/** 一次算出五小时和周两个窗口：两边共用同一份 30 天请求流水，只读一次。 */
export function queryModelStudy(value: ModelStudyQuery): ModelStudies {
  const q = parseModelStudyQuery(value), now = Date.now(), history = readQuotaHistory(), store = readOfficialAccountStore();
  const samples = Array.isArray(history.accounts[q.kind]) ? history.accounts[q.kind] : [];
  const stored = store.accounts.find(a => a.id === q.accountId && a.kind === q.kind);
  if (stored?.hidden || store.removed?.includes(q.accountId) || (!stored && !samples.some(s => s.account === q.accountId))) throw new Error("找不到可分析的官方账号。");
  const source = { chatgpt: "Codex CLI", claude: "Claude Code", grok: "Grok Build" }[q.kind];
  const all = queryRequests({ from: day(now - TRAINING_DAYS * DAY), to: day(now), since: now - TRAINING_DAYS * DAY, until: now, source, account: q.accountId, status: "all", search: "", sort: "time", page: 0, pageSize: 1, all: true, channel: "official" });
  const rows = all.rows.filter(r => FAMILY[q.kind].test(r.model));
  const catalog = modelCatalog(q.kind, rows);
  // 用户自己加的型号：同名同等级已经在目录里的，只补上「你添加的」来源
  for (const added of readStudyModels(q.kind)) for (const effort of added.efforts) {
    const hit = catalog.find(c => c.model === added.model && c.effort === effort);
    if (hit) { if (!hit.origins.includes("user")) hit.origins.push("user"); }
    else catalog.push({ model: added.model, effort, origins: ["user"] });
  }
  const sessions = readCalibrations().filter(s => s.accountId === q.accountId && s.kind === q.kind);
  const localOnly = localOnlyAccounts().includes(q.accountId);
  const marks = readMarks(q.kind, q.accountId);
  const one = (window: ModelStudyWindow) => analyzeModelStudy({ kind: q.kind, accountId: q.accountId, window, cycle: q.cycles?.[window] }, samples, rows, catalog, now, sessions, localOnly, marks);
  return { kind: q.kind, accountId: q.accountId, calibration: calibrationStatus(q.kind, q.accountId, now), localOnly, catalog: catalog.filter(c => FAMILY[q.kind].test(c.model)), five: one("five"), week: one("week") };
}
