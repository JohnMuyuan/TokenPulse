import { readQuotaHistory, type QuotaSample } from "./quota-history";
import { windowSegments, type WindowSegment } from "./quota-monitor";
import { queryRequests, type RequestRow } from "./request-log";
import { modelCatalog, comboKey, type CatalogEntry } from "./model-catalog";
import { estimateCost } from "./model-pricing";
import { readOfficialAccountStore } from "./accounts";
import type { AccountKind } from "./quota";

/*
 * 模型 × 思考等级：一个五小时 / 周周期全用一种组合，大约能用多少 Token；以及周期里用了哪些组合。
 *
 * 换算分两层：
 * 1. 整窗预算（API 等价费用）：同账号的采样区间里，本机官方请求的参考费用 ÷ 官方已用百分点 × 100。
 *    费用可以跨模型相加，所以混用模型 / 等级的区间也能用 —— 样本比「纯区间」多得多。
 *    实测（2026-09 用户数据）：同一账号不同模型的纯区间折算出的整窗费用很接近，Token 数却差很多，
 *    说明官方额度大体按 API 等价费用消耗。
 * 2. 每个组合：整窗预算 ÷ 这个组合每 Token 的参考费用。单价优先用这个组合自己最近 30 天的实际费用
 *    （带着它自己的缓存 / 输出比例），没用过就用同模型其他等级的，再没有就用价格表 × 本账号的用量结构。
 *    纯区间（整段只用这一个组合）样本足够时，直接用实测值。
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
  costPerMTokens: number | null; priceBasis: "combo" | "model" | "price" | null;
  /** 最近 30 天平均每次模型调用多少 Token（思考等级主要影响这个）。 */
  tokensPerCall: number | null;
  /** 纯区间实测。 */
  calibrationCacheShare: number | null; intervals: number; quotaPoints: number; cycleCount: number;
  estimatedTokens: number | null; estimatedCostUsd: number | null;
  observedMinTokens: number | null; observedMaxTokens: number | null; confidence: Confidence; lastAt?: number;
  /** 按整窗预算换算。 */
  derivedTokens: number | null;
  /** 最终展示的整窗容量：实测样本较充分用实测，否则用换算。 */
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
export const FAMILY: Record<AccountKind, RegExp> = { chatgpt: /^(gpt|codex|o\d)/i, claude: /^claude/i, grok: /^grok/i };
/** 组合自己的请求少于这么多条时，缓存比例偶然性太大，单价改用同模型全部等级的。 */
const MIN_COMBO_ROWS = 30;
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
export function analyzeModelStudy(q: WindowStudyQuery, samples: QuotaSample[], records: RequestRow[], catalog: CatalogEntry[], now = Date.now()) {
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

  const stats = new Map<string, { input: number; cacheRead: number; tokens: number; cost: number; priced: boolean; points: number; intervals: number; cycles: Set<string>; rates: number[]; lastAt: number }>();
  const pool = { cost: 0, points: 0, intervals: 0, cycles: new Set<string>() };
  const excluded = { mixed: 0, unknownEffort: 0, empty: 0, gap: 0, accountUncertain: 0, planChange: 0 };
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
      const plans = [sampleAt.get(anchor.at)?.plan, sampleAt.get(point.at)?.plan];
      anchor = point;
      if (plans.some(p => p && currentPlan && p !== currentPlan)) { excluded.planChange++; continue; }
      if (!part.length) { excluded.empty++; continue; }
      if (part.some(r => r.account?.basis === "inferred")) { excluded.accountUncertain++; continue; }
      if (delta > 100) continue;
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
  const budgetConfidence: Confidence = pool.points >= 15 && pool.cycles.size >= 2 ? "medium" : pool.points >= 5 && pool.intervals >= 3 ? "low" : "insufficient";
  const budget: Budget = { costUsd: budgetConfidence === "insufficient" || pool.cost <= 0 ? null : pool.cost / pool.points * 100, points: pool.points, intervals: pool.intervals, cycles: pool.cycles.size, confidence: budgetConfidence };

  // 单价：组合自己 → 同模型 → 价格表 × 本账号用量结构（输入 / 缓存 / 输出的比例）。
  const pricedRows = rows.filter(r => r.priced && r.tokens > 0);
  const ownMix = { input: sum(rows, r => r.input), output: sum(rows, r => r.output), cacheRead: sum(rows, r => r.cacheRead), cacheWrite: sum(rows, r => r.cacheWrite || 0) };
  const mix = ownMix.input + ownMix.output > 0 ? ownMix : DEFAULT_MIX, mixTokens = mix.input + mix.output;
  const perToken = (list: RequestRow[]) => { const t = sum(list, r => r.tokens); return t > 0 ? sum(list, r => r.costUsd) / t : null; };
  const unitCost = (model: string, key: string): [number | null, ModelCapacity["priceBasis"]] => {
    const combo = pricedRows.filter(r => comboKey(r.model, r.effort) === key);
    const own = combo.length >= MIN_COMBO_ROWS ? perToken(combo) : null;
    if (own) return [own, "combo"];
    const sameModel = perToken(pricedRows.filter(r => r.model === model));
    if (sameModel) return [sameModel, "model"];
    const listed = mixTokens > 0 ? estimateCost(model, mix) / mixTokens : 0;
    return listed > 0 ? [listed, "price"] : [null, null];
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
    const [unit, priceBasis] = entry.effort === "unknown" ? [null, null] : unitCost(entry.model, key);
    const derivedTokens = budget.costUsd != null && unit ? budget.costUsd / unit : null;
    const measured = estimatedTokens != null && (confidence === "medium" || derivedTokens == null);
    const capacityTokens = measured ? estimatedTokens : derivedTokens;
    const recentCalls = sum(recent, r => r.calls), recentTokens = sum(recent, r => r.tokens);
    const tokensPerCall = recentCalls > 0 ? recentTokens / recentCalls : null;
    return { ...entry, key,
      tokens: sum(actual, r => r.tokens), inputTokens: sum(actual, r => r.input), outputTokens: sum(actual, r => r.output), cacheReadTokens: sum(actual, r => r.cacheRead), calls: sum(actual, r => r.calls), costUsd: actual.every(r => r.priced) ? sum(actual, r => r.costUsd) : null,
      recentTokens, recentCalls, costPerMTokens: unit == null ? null : unit * 1e6, priceBasis, tokensPerCall,
      calibrationCacheShare: stat?.input ? stat.cacheRead / stat.input : null, intervals: stat?.intervals ?? 0, quotaPoints: stat?.points ?? 0, cycleCount: stat?.cycles.size ?? 0,
      estimatedTokens, estimatedCostUsd, observedMinTokens: enough ? Math.min(...stat!.rates) : null, observedMaxTokens: enough ? Math.max(...stat!.rates) : null, confidence, lastAt: stat?.lastAt,
      derivedTokens, capacityTokens, capacityCostUsd: measured ? estimatedCostUsd : derivedTokens != null ? budget.costUsd : null, capacityBasis: capacityTokens == null ? null : measured ? "measured" : "cost",
      callsPerWindow: capacityTokens != null && tokensPerCall ? capacityTokens / tokensPerCall : null,
      remainingTokens: capacityTokens != null && remainingShare != null ? capacityTokens * remainingShare : null, relative: null };
  });
  // 相对容量：以最常用的组合为 1×。没有整窗预算（本机没有这个账号的用量）时，排行至少还能比出谁更耐用。
  const reference = capacities.filter(c => c.costPerMTokens).sort((a, b) => b.recentTokens - a.recentTokens || a.costPerMTokens! - b.costPerMTokens!)[0];
  for (const c of capacities) if (reference && c.costPerMTokens) c.relative = reference.costPerMTokens! / c.costPerMTokens;

  const bins = new Map<string, TimelineBin>();
  const binMs = selected ? Math.max(60000, Math.ceil((selected.endAt - selected.startAt) / 240 / 60000) * 60000) : 60000;
  for (const r of observed) {
    const key = comboKey(r.model, r.effort), start = selected!.startAt + Math.floor((r.at - selected!.startAt) / binMs) * binMs;
    const k = key + "|" + start;
    const bin = bins.get(k) ?? { key, model: r.model, effort: r.effort || "unknown", startAt: start, endAt: Math.min(start + binMs, selected!.endAt), firstAt: r.at, lastAt: r.at, count: 0, calls: 0, tokens: 0, costUsd: 0 };
    bin.firstAt = Math.min(bin.firstAt, r.at); bin.lastAt = Math.max(bin.lastAt, r.at); bin.count++; bin.calls += r.calls; bin.tokens += r.tokens; bin.costUsd = bin.costUsd != null && r.priced ? bin.costUsd + r.costUsd : null; bins.set(k, bin);
  }
  return { query: q, now, trainingSince: since, trainingDays: TRAINING_DAYS, cycles, selected, quotaStale, partialCycle: Boolean(selected && selected.startAt < since), budget, capacities, timeline: [...bins.values()].sort((a, b) => a.startAt - b.startAt), binMs, excluded,
    /** 所选周期的额度采样（画在时间轴上方）。 */
    track: (selectedSegment?.points ?? []).map(p => ({ at: p.at, pct: p.pct })),
    totals: { tokens: sum(observed, r => r.tokens), calls: sum(observed, r => r.calls), records: observed.length, unknownEffort: observed.filter(unknownEffort).length },
    coverage: { firstRecordAt: rows[0]?.at ?? null, latestRecordAt: rows.at(-1)?.at ?? null, quotaSampleAt: ownSamples.at(-1)?.at ?? null } };
}
export type ModelStudy = ReturnType<typeof analyzeModelStudy>;
export type ModelStudies = { kind: AccountKind; accountId: string; five: ModelStudy; week: ModelStudy };

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
  const one = (window: ModelStudyWindow) => analyzeModelStudy({ kind: q.kind, accountId: q.accountId, window, cycle: q.cycles?.[window] }, samples, rows, catalog, now);
  return { kind: q.kind, accountId: q.accountId, five: one("five"), week: one("week") };
}
