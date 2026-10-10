/*
 * DeepSeek 账号页的分析（0.3.42）。
 *
 * 官方账号的额度详情看的是「窗口用了百分之几」，DeepSeek 按量付费，对应的东西是余额：
 * - 余额历史：每次查到余额记一笔（deepseek-balance.ts 调 appendBalanceSamples），余额掉了多少就是花了多少；
 * - 本机用量：DeepSeek Harness 的请求流水（usage-scan.ts 扫的），带型号、思考等级、Token、参考费用，以及它自己日志里的出字时间；
 * - 两边对起来：余额掉的时候本机有没有请求 → 本机花的 / 本机以外花的；本机那部分的「余额实际扣了多少 ÷ 参考费用」
 *   就是这个账号的实际折算率，拿来算「余额换成每个模型能用多少」。
 *
 * 余额是整个 DeepSeek 账号的，其他设备和其他程序的消耗也在里面；本机流水只有 DeepSeek Harness。
 * Harness 是账号授权登录的，和 API Key 对不上号，所以哪个账号算本机用量由用户指定（deepseek-balance.ts 的 harness）。
 * 这里都在 worker 里跑（report-worker.ts）。
 */
import { dataFile, readJson, writeJson } from "./paths";
import { loadKnowledge } from "./knowledge";
import { comboKey } from "./model-catalog";
import { estimateCost, priceOf } from "./model-pricing";
import { speedSeriesOf, type SpeedSeries } from "./pass-speed";
import { queryRequests, type RequestRow } from "./request-log";
import { deepseekPeak } from "./usage-scan";

export type BalanceSample = { at: number; currency: string; total: number; granted: number; toppedUp: number };
type StoredSample = [number, string, number, number, number];
type HistoryFile = { v: 1; accounts: Record<string, StoredSample[]> };

const HOUR = 3_600_000, DAY = 86_400_000;
const KEEP_MS = 400 * DAY, KEEP_MAX = 40_000;
export const DEEPSEEK_SOURCE = "DeepSeek Harness";
export const DEEPSEEK_DAYS = 30;
/** 还没有实际扣费可以对照时，参考费用（美元）换成余额币种用的粗略比例。 */
const REFERENCE_RATE: Record<string, number> = { USD: 1, CNY: 7.2 };
/** 实测折算率超出这个范围多半是别处也在用同一个账号（或者赠金过期），不采用。 */
const RATE_RANGE: Record<string, [number, number]> = { USD: [0.4, 2.5], CNY: [3, 18] };
/** 没有本机用量时，按典型的 CLI 编程用量结构折算（输入里约 85% 是缓存读取）。 */
const DEFAULT_MIX = { input: 1_000_000, cacheRead: 850_000, cacheWrite: 0, output: 30_000 };
const MIN_MODEL_ROWS = 30;

const historyFile = () => dataFile("deepseek-balance-history.json");
const cents = (value: number) => Math.round(value * 100) / 100;
const dayKey = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const startOfDay = (at: number) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };
const shiftDay = (at: number, days: number) => { const d = new Date(at); d.setDate(d.getDate() + days); return d.getTime(); };
const sum = <T>(rows: T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);

function readHistory(): HistoryFile {
  const raw = readJson<HistoryFile | null>(historyFile(), null);
  return raw && raw.v === 1 && raw.accounts && typeof raw.accounts === "object" ? raw : { v: 1, accounts: {} };
}
export function readBalanceHistory(id: string): BalanceSample[] {
  const list = readHistory().accounts[id];
  if (!Array.isArray(list)) return [];
  return list.filter((item) => Array.isArray(item) && Number.isFinite(item[0]) && typeof item[1] === "string" && Number.isFinite(item[2]))
    .map(([at, currency, total, granted, toppedUp]) => ({ at, currency, total, granted: Number(granted) || 0, toppedUp: Number(toppedUp) || 0 })).sort((a, b) => a.at - b.at);
}
/**
 * 记一次查到的余额。数字没变的连续几次只留头尾两笔（尾巴那一笔的时间跟着往后挪）：
 * 既不让文件每 10 分钟长一行，又留得住「到几点为止余额还没动」。
 */
export function appendBalanceSamples(id: string, at: number, infos: { currency: string; total: number; granted: number; toppedUp: number }[]) {
  if (!infos.length) return;
  const file = readHistory();
  const list = (file.accounts[id] ??= []);
  for (const info of infos) {
    const same = list.filter((item) => item[1] === info.currency);
    const last = same.at(-1), before = same.at(-2);
    const equal = (item?: StoredSample) => Boolean(item && item[2] === info.total && item[3] === info.granted && item[4] === info.toppedUp);
    if (last && at <= last[0]) continue;
    if (equal(last) && equal(before)) last![0] = at;
    else list.push([at, info.currency, info.total, info.granted, info.toppedUp]);
  }
  const kept = list.filter((item) => item[0] >= at - KEEP_MS).sort((a, b) => a[0] - b[0]);
  file.accounts[id] = kept.length > KEEP_MAX ? kept.slice(-KEEP_MAX) : kept;
  writeJson(historyFile(), file);
}
export function removeBalanceHistory(id: string) {
  const file = readHistory();
  if (!(id in file.accounts)) return;
  delete file.accounts[id];
  writeJson(historyFile(), file);
}

/** 最近 30 天 DeepSeek Harness 的请求流水，按时间从早到晚。days = 0 读全部（速度走势看「全部」时用）。 */
export function deepseekRows(days: number, now = Date.now()): RequestRow[] {
  const since = days > 0 ? now - days * DAY : 0;
  const page = queryRequests({ from: days > 0 ? dayKey(since) : "2000-01-01", to: dayKey(now), ...(since ? { since } : {}), until: now, source: DEEPSEEK_SOURCE, status: "all", search: "", sort: "time", page: 0, pageSize: 1, all: true });
  return page.rows.filter((row) => Number.isFinite(row.tokens) && row.tokens >= 0).sort((a, b) => a.at - b.at);
}

type Step = { from: number; to: number; spent: number; added: number };
/** 相邻两次余额之间的变化：掉了算花掉的，涨了算充值（或新的赠金）。 */
function stepsOf(samples: BalanceSample[]): Step[] {
  const steps: Step[] = [];
  for (let i = 1; i < samples.length; i++) {
    const delta = cents(samples[i].total - samples[i - 1].total);
    if (Math.abs(delta) < 0.005) continue;
    steps.push({ from: samples[i - 1].at, to: samples[i].at, spent: delta < 0 ? -delta : 0, added: delta > 0 ? delta : 0 });
  }
  return steps;
}
type Mix = { input: number; output: number; cacheRead: number; cacheWrite: number };
const mixOf = (rows: RequestRow[]): Mix => ({ input: sum(rows, (r) => r.input), output: sum(rows, (r) => r.output), cacheRead: sum(rows, (r) => r.cacheRead), cacheWrite: sum(rows, (r) => r.cacheWrite || 0) });
const usage = (rows: RequestRow[]) => ({ tokens: sum(rows, (r) => r.tokens), costUsd: sum(rows, (r) => r.costUsd), requests: sum(rows, (r) => r.calls || 1) });

export type DeepSeekModelRow = {
  key: string; model: string; period: "peak" | "offpeak";
  listPrice: { input: number; output: number; cacheRead: number } | null;
  /** 按你的 Token 结构算出来的综合单价：每百万 Token 多少参考美元 / 多少余额。 */
  usdPerM: number | null; balancePerM: number | null;
  capacityTokens: number | null; calls: number | null; tokensPerCall: number | null;
  recentTokens: number; recentCalls: number; relative: number | null;
  mixBasis: "model" | "account" | "default";
};

export function analyzeDeepSeek(input: { accountId: string; local: boolean; samples: BalanceSample[]; rows: RequestRow[]; now: number }) {
  const { now } = input;
  const latest = input.samples.at(-1);
  const currency = latest?.currency ?? "";
  // 一个账号可能同时有人民币和美元余额：分析最近查到的第一种，另一种只在上面的卡片里显示数字
  const primary = input.samples.filter((sample) => sample.currency === currency);
  const samples = primary.filter((sample) => sample.at >= now - 366 * DAY && sample.at <= now + 60_000);
  const rows = input.local ? input.rows.filter((row) => row.at >= now - DEEPSEEK_DAYS * DAY && row.at <= now) : [];
  const steps = stepsOf(samples);
  const firstAt = samples[0]?.at ?? null;
  const spentIn = (from: number, to: number) => cents(sum(steps.filter((step) => step.to > from && step.to <= to), (step) => step.spent));
  const rowsIn = (from: number, to: number) => rows.filter((row) => row.at > from && row.at <= to);
  const today = startOfDay(now);

  // 每天：余额花了多少、充了多少、当天结束时的余额，以及本机用了多少
  const days = Array.from({ length: DEEPSEEK_DAYS }, (_, i) => {
    const from = shiftDay(today, i - DEEPSEEK_DAYS + 1), to = shiftDay(from, 1);
    const inside = steps.filter((step) => step.to > from && step.to <= to);
    const end = [...samples].reverse().find((sample) => sample.at <= to);
    return { day: dayKey(from), from, covered: firstAt != null && firstAt < to, spent: cents(sum(inside, (s) => s.spent)), added: cents(sum(inside, (s) => s.added)), balance: end ? end.total : null, ...usage(rowsIn(from, to)) };
  });

  // 日均：最近 7 天（记录不满 7 天就按有记录的天数，至少按 1 天）
  const weekFrom = Math.max(firstAt ?? now, now - 7 * DAY);
  const coveredDays = firstAt == null ? 0 : (now - weekFrom) / DAY;
  const spent7 = spentIn(now - 7 * DAY, now);
  const perDay = coveredDays >= 0.25 && spent7 > 0 ? spent7 / Math.max(1, coveredDays) : null;
  const daysLeft = perDay && latest ? latest.total / perDay : null;

  // 余额掉的那些区间里本机有没有请求。费用从上一次余额变化算起：单次请求不到一分钱，要攒几次余额才动一下
  let costFrom = firstAt ?? now, localDrop = 0, localCost = 0, localSteps = 0, offDrop7 = 0, offDrop30 = 0;
  const off: { from: number; to: number; spent: number }[] = [];
  for (const step of steps) {
    if (step.to < now - DEEPSEEK_DAYS * DAY) { costFrom = step.to; continue; }
    if (step.added > 0) { costFrom = step.to; continue; }
    const part = rowsIn(costFrom - 60_000, step.to);
    if (input.local && part.length) { localDrop += step.spent; localCost += sum(part, (r) => r.costUsd); localSteps++; }
    else if (input.local) { offDrop30 += step.spent; if (step.to > now - 7 * DAY) offDrop7 += step.spent; off.push({ from: costFrom, to: step.to, spent: step.spent }); }
    costFrom = step.to;
  }
  const range = RATE_RANGE[currency], reference = REFERENCE_RATE[currency] ?? null;
  const measuredRate = localSteps >= 3 && localCost >= 0.02 ? localDrop / localCost : null;
  const measuredOk = measuredRate != null && (!range || (measuredRate >= range[0] && measuredRate <= range[1]));
  const rate = {
    /** 1 美元参考费用 = 多少余额。 */
    perUsd: measuredOk ? measuredRate : reference,
    basis: (measuredOk ? "measured" : reference != null ? "reference" : "none") as "measured" | "reference" | "none",
    measured: measuredRate, steps: localSteps, drop: cents(localDrop), costUsd: localCost, reference,
  };

  // 余额换成每个模型能用多少：型号来自知识库里 DeepSeek 的名字和本机用过的，每个型号高峰 / 闲时各一行
  const kb = loadKnowledge();
  const names = new Set<string>();
  for (const item of kb.knowledge.displayNames ?? []) if (/deepseek/i.test(item.name)) names.add(item.name);
  for (const row of rows) if (row.model && row.model !== "未知模型") names.add(row.model);
  const total = latest?.total ?? null;
  const allMix = rows.length ? mixOf(rows) : DEFAULT_MIX;
  const allCalls = sum(rows, (r) => r.calls || 1);
  const models: DeepSeekModelRow[] = [];
  for (const model of names) {
    const rule = priceOf(model);
    const own = rows.filter((row) => row.model === model);
    const representative = own.length >= MIN_MODEL_ROWS || (own.length > 0 && own.length * 5 >= rows.length);
    const mix = representative ? mixOf(own) : allMix, mixTokens = mix.input + mix.output;
    const mixBasis = representative ? "model" : rows.length ? "account" : "default";
    const perCallRows = representative ? own : rows;
    const tokensPerCall = perCallRows.length ? sum(perCallRows, (r) => r.tokens) / Math.max(1, representative ? sum(own, (r) => r.calls || 1) : allCalls) : null;
    const peakUnit = rule && mixTokens > 0 ? estimateCost(model, mix) / mixTokens : 0;
    for (const period of ["peak", "offpeak"] as const) {
      const factor = period === "peak" ? 1 : 0.5;
      const unit = peakUnit > 0 ? peakUnit * factor : null;
      const mine = own.filter((row) => deepseekPeak(row.at) === (period === "peak"));
      const balancePerM = unit != null && rate.perUsd != null ? unit * 1e6 * rate.perUsd : null;
      const capacityTokens = balancePerM && total != null ? total / balancePerM * 1e6 : null;
      models.push({
        key: `${model}|${period}`, model, period,
        listPrice: rule ? { input: rule.input * factor, output: rule.output * factor, cacheRead: rule.cacheRead * factor } : null,
        usdPerM: unit == null ? null : unit * 1e6, balancePerM, capacityTokens,
        calls: capacityTokens != null && tokensPerCall ? capacityTokens / tokensPerCall : null, tokensPerCall,
        recentTokens: sum(mine, (r) => r.tokens), recentCalls: sum(mine, (r) => r.calls || 1), relative: null, mixBasis,
      });
    }
  }
  // 照现在的用法：最近 30 天实际的型号搭配和高峰 / 闲时比例
  const recent = usage(rows);
  const currentUnit = recent.tokens > 0 && recent.costUsd > 0 ? recent.costUsd / recent.tokens : null;
  const currentTokens = currentUnit && rate.perUsd != null && total != null ? total / (currentUnit * rate.perUsd) : null;
  const current = {
    usdPerM: currentUnit == null ? null : currentUnit * 1e6,
    balancePerM: currentUnit != null && rate.perUsd != null ? currentUnit * 1e6 * rate.perUsd : null,
    capacityTokens: currentTokens,
    calls: currentTokens != null && allCalls > 0 ? currentTokens / (recent.tokens / allCalls) : null,
    peakShare: recent.tokens > 0 ? sum(rows.filter((row) => deepseekPeak(row.at)), (r) => r.tokens) / recent.tokens : null,
  };
  const base = current.usdPerM ?? models.filter((m) => m.usdPerM).sort((a, b) => b.recentTokens - a.recentTokens || b.usdPerM! - a.usdPerM!)[0]?.usdPerM ?? null;
  for (const model of models) if (base && model.usdPerM) model.relative = base / model.usdPerM;

  // 最近 24 小时：含当前没过完的这个小时
  const thisHour = Math.floor(now / HOUR) * HOUR;
  const hourly = Array.from({ length: 24 }, (_, i) => { const hour = thisHour - (23 - i) * HOUR; return { hour, ...usage(rowsIn(hour - 1, hour + HOUR - 1)) }; });

  // 余额走势：最近 30 天，点太多时每小时留最后一个
  const recentSamples = samples.filter((sample) => sample.at >= now - DEEPSEEK_DAYS * DAY);
  const before = [...samples].reverse().find((sample) => sample.at < now - DEEPSEEK_DAYS * DAY);
  const byHour = new Map<number, BalanceSample>();
  for (const sample of recentSamples) byHour.set(recentSamples.length > 800 ? Math.floor(sample.at / HOUR) : sample.at, sample);
  const track = [...(before ? [{ at: now - DEEPSEEK_DAYS * DAY, total: before.total }] : []), ...[...byHour.values()].map((sample) => ({ at: sample.at, total: sample.total }))];

  const topUps = steps.filter((step) => step.added > 0 && step.to >= now - 90 * DAY).map((step) => ({ at: step.to, amount: step.added })).reverse().slice(0, 12);
  return {
    accountId: input.accountId, now, local: input.local, currency,
    balance: latest ? { at: latest.at, total: latest.total, granted: latest.granted, toppedUp: latest.toppedUp } : null,
    since: firstAt, sampleCount: samples.length,
    spend: {
      today: spentIn(today, now), yesterday: spentIn(shiftDay(today, -1), today), d7: spent7, d30: spentIn(now - DEEPSEEK_DAYS * DAY, now),
      perDay, coveredDays, daysLeft, emptyAt: daysLeft != null ? now + daysLeft * DAY : null,
      offMachine7: cents(offDrop7), offMachine30: cents(offDrop30),
    },
    days, track, topUps, off: off.slice(-200),
    localUsage: { today: usage(rowsIn(today, now)), d7: usage(rowsIn(now - 7 * DAY, now)), d30: recent, lastAt: rows.at(-1)?.at ?? null },
    hourly, rate, models, current,
    priceSource: { version: kb.knowledge.version, updatedAt: kb.knowledge.updatedAt },
  };
}
export type DeepSeekInsight = ReturnType<typeof analyzeDeepSeek>;

/** 速度走势：出字时间是 DeepSeek Harness 自己记在日志里的（扫描时算成每秒 Token 数和首字延迟），不需要经过 TokenPulse 转发。 */
export function deepseekSpeed(rows: RequestRow[], days: number, now: number): SpeedSeries {
  const since = days > 0 ? now - days * DAY : 0;
  const measured = rows.filter((row) => row.at >= since && row.at <= now && row.timing && (row.timing.tokensPerSec || row.timing.firstTokenMs))
    .map((row) => ({ at: row.at, model: row.model, fast: false, speed: row.timing!.tokensPerSec || 0, first: row.timing!.firstTokenMs || 0, output: row.output }));
  return speedSeriesOf(measured, since, now);
}

/*
 * 时间线：和官方账号用同一套画法（renderer/model-study.js），所以返回的结构也照着 model-study.ts 的来。
 * 官方账号按额度周期翻页，DeepSeek 没有周期：一条按自然日，一条按 7 天；上方的曲线是余额。
 */
type Cycle = { id: string; startAt: number; endAt: number; resetAt: number; used: number; sampleAt: number; active: boolean; resetCard: boolean };
function timelineStudy(accountId: string, window: "five" | "week", cycleId: string | undefined, rows: RequestRow[], samples: BalanceSample[], now: number) {
  const today = startOfDay(now), length = window === "five" ? 1 : 7;
  const cycles: Cycle[] = [];
  for (let end = shiftDay(today, 1); cycles.length < 40; end = shiftDay(end, -length)) {
    const start = shiftDay(end, -length);
    if (end <= now - DEEPSEEK_DAYS * DAY) break;
    const active = now >= start && now < end;
    if (active || rows.some((row) => row.at > start && row.at <= end)) cycles.push({ id: `${start}:${end}`, startAt: start, endAt: end, resetAt: end, used: 0, sampleAt: now, active, resetCard: false });
  }
  const selected = (cycleId ? cycles.find((cycle) => cycle.id === cycleId) : null) ?? cycles[0] ?? null;
  const observed = selected ? rows.filter((row) => row.at > selected.startAt && row.at <= Math.min(selected.endAt, now)) : [];
  const binMs = 60_000;
  const bins = new Map<string, { key: string; model: string; effort: string; startAt: number; endAt: number; firstAt: number; lastAt: number; count: number; calls: number; tokens: number; costUsd: number | null }>();
  for (const row of observed) {
    const key = comboKey(row.model, row.effort), start = selected!.startAt + Math.floor((row.at - selected!.startAt) / binMs) * binMs, id = key + "|" + start;
    const bin = bins.get(id) ?? { key, model: row.model, effort: row.effort || "unknown", startAt: start, endAt: Math.min(start + binMs, selected!.endAt), firstAt: row.at, lastAt: row.at, count: 0, calls: 0, tokens: 0, costUsd: 0 };
    bin.firstAt = Math.min(bin.firstAt, row.at); bin.lastAt = Math.max(bin.lastAt, row.at); bin.count++; bin.calls += row.calls || 1; bin.tokens += row.tokens; bin.costUsd = (bin.costUsd ?? 0) + row.costUsd;
    bins.set(id, bin);
  }
  // 余额曲线：这段时间里的采样，加上开始之前的最后一笔（曲线从左边接上）。纵轴按这段时间里的最高余额
  const inside = selected ? samples.filter((sample) => sample.at >= selected.startAt && sample.at <= selected.endAt) : [];
  const lead = selected ? [...samples].reverse().find((sample) => sample.at < selected.startAt) : undefined;
  const points = [...(lead ? [lead] : []), ...inside];
  // 花掉的那一点和余额比起来很小：纵轴只取这段时间里的范围，从 0 画起的话曲线就是一条平线
  const low = points.length ? Math.min(...points.map((sample) => sample.total)) : 0, high = Math.max(0, ...points.map((sample) => sample.total));
  const pad = Math.max((high - low) * 0.15, high * 0.002, 0.01);
  const min = Math.max(0, low - pad), max = high + pad;
  const unknown = (row: RequestRow) => !row.effort || row.effort === "unknown";
  return {
    query: { kind: "deepseek", accountId, window, cycle: cycleId }, now, cycles, selected, quotaStale: false,
    timeline: [...bins.values()].sort((a, b) => a.startAt - b.startAt), binMs,
    track: points.map((sample) => ({ at: sample.at, pct: (sample.total - min) / (max - min) * 100, value: sample.total })),
    balance: { currency: points.at(-1)?.currency ?? "", min, max },
    attribution: { intervals: [] as never[] }, offMachine: { points: 0, markedPoints: 0, detected: [] as never[], marks: [] as never[] },
    totals: { tokens: sum(observed, (r) => r.tokens), calls: sum(observed, (r) => r.calls || 1), records: observed.length, unknownEffort: observed.filter(unknown).length },
  };
}

export type DeepSeekQuery =
  | { op: "insight"; accountId: string; local: boolean }
  | { op: "speed"; days: number }
  | { op: "timeline"; accountId: string; local: boolean; cycles?: { five?: string; week?: string } };

export function queryDeepSeek(query: DeepSeekQuery) {
  const now = Date.now();
  if (query.op === "speed") return deepseekSpeed(deepseekRows(query.days, now), query.days, now);
  const samples = readBalanceHistory(query.accountId);
  const rows = query.local ? deepseekRows(DEEPSEEK_DAYS, now) : [];
  if (query.op === "insight") return analyzeDeepSeek({ accountId: query.accountId, local: query.local, samples, rows, now });
  const currency = samples.at(-1)?.currency ?? "";
  const primary = samples.filter((sample) => sample.currency === currency);
  const one = (window: "five" | "week") => timelineStudy(query.accountId, window, query.cycles?.[window], rows, primary, now);
  return { kind: "deepseek", accountId: query.accountId, labels: { five: "单日", week: "7 天" }, five: one("five"), week: one("week") };
}
