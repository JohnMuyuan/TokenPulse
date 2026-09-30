import { randomUUID } from "crypto";
import { dataFile, readJson, writeJson } from "./paths";
import type { AccountKind } from "./quota";
import type { RequestRow } from "./request-log";
import { confidenceOf, windowSegments, RESET_STYLE, type CapacityHistory, type CapacityPoint, type WindowSegment } from "./quota-monitor";
import type { QuotaSample } from "./quota-history";

/**
 * 本机以外的额度消耗（0.3.9）。
 *
 * 官方的已用百分比是整个账号的：网页 / App 聊天、别的电脑也在用。以前要么把这些全算成本机 Code（容量算小），
 * 要么干脆不折算容量（要用户做「本机专用校准」）。现在按采样区间自动分开：
 * - 额度涨了、同期本机没有任何 Code 请求（前后 5 分钟也没有）→ 本机以外的消耗，不进容量折算，时间线上标出来；
 * - 额度涨了、同期本机有请求 → 按本机用量折算（同一时刻也在聊天的话没法分辨，会让容量略微偏小）；
 * - 用户在时间线上标注过的时段（「这段时间我在网页上用 Opus 聊天」）→ 可能是混用，整段不进折算；
 *   标注的模型和思考等级用来把这段涨幅换算成等价的 Token。
 * - 采样间隔超过 30 分钟、或者百分比回落的区间说不清，跳过。
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
const LAG_MS = 5 * 60000;
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
export type CleanSegment = { cost: number; tokens: number; points: number; priced: boolean; offPoints: number; markedPoints: number; offIntervals: OffInterval[] };

/**
 * 把一个窗口段按相邻采样切成区间，分出干净的本机区间和本机以外的涨幅。rows 必须按时间排好、只含这个账号这一家的官方请求。
 * 周额度常常半小时以上才涨 1 个点：不到 1 点的变化先累积，避免把最后一小段请求除以 1%。
 */
export function cleanSegment(segment: WindowSegment, rows: RequestRow[], marks: OffMachineMark[], now: number): CleanSegment {
  const upper = (at: number) => { let low = 0, high = rows.length; while (low < high) { const mid = (low + high) >>> 1; if (rows[mid].at <= at) low = mid + 1; else high = mid; } return low; };
  const out: CleanSegment = { cost: 0, tokens: 0, points: 0, priced: true, offPoints: 0, markedPoints: 0, offIntervals: [] };
  let anchor = segment.points[0], prev = anchor;
  for (const point of segment.points.slice(1)) {
    if (!anchor) { anchor = prev = point; continue; }
    const step = point.at - prev.at, delta = point.pct - anchor.pct;
    prev = point;
    if (point.at <= anchor.at) continue;
    if (step > GAP_MS || delta < -0.01) { anchor = point; continue; }
    if (delta < 1) continue;
    const from = anchor.at, to = point.at;
    anchor = point;
    if (delta > 100) continue;
    if (overlapsMark(marks, from, to)) { out.markedPoints += delta; continue; }
    const part = rows.slice(upper(from), upper(to));
    if (!part.length) {
      // 前后 5 分钟也没有本机请求才算本机以外（统计延迟、采样刚好卡在请求边上的不算）；还没过 5 分钟的最新区间先不下结论
      const near = rows.slice(upper(from - LAG_MS), upper(Math.min(to + LAG_MS, now))).length;
      if (!near && to + LAG_MS <= now && !overlapsIgnored(marks, from, to)) { out.offPoints += delta; out.offIntervals.push({ from, to, points: delta }); }
      continue;
    }
    if (part.some((r) => r.account?.basis === "inferred")) continue;
    if (!part.every((r) => r.priced)) out.priced = false;
    out.cost += part.reduce((s, r) => s + r.costUsd, 0);
    out.tokens += part.reduce((s, r) => s + r.tokens, 0);
    out.points += delta;
  }
  return out;
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
  const segments = windowSegments(samples, window, RESET_STYLE[kind] ?? "keeps");
  const history: CapacityHistory & { basis: "clean" } = { points: [], skipped: { tooLow: 0, noLocal: 0 }, basis: "clean" };
  let current: { tokens: number; costUsd: number; confidence: CapacityPoint["confidence"]; offPoints: number } | undefined;
  segments.forEach((segment, index) => {
    const final = segment.points.at(-1);
    if (!final || final.pct <= 0) return;
    const clean = cleanSegment(segment, rows, marks, now);
    const isCurrent = index === segments.length - 1 && segment.endAt > now;
    if (clean.points < MIN_CLEAN_POINTS || clean.tokens <= 0) { if (clean.points < MIN_CLEAN_POINTS && final.pct < MIN_CLEAN_POINTS) history.skipped.tooLow += 1; else history.skipped.noLocal += 1; return; }
    const scale = 100 / clean.points;
    const point: CapacityPoint & { offPoints: number; markedPoints: number; cleanPoints: number } = {
      startAt: segment.startAt, resetAt: segment.resetAt, endAt: segment.endAt, at: final.at, pct: final.pct,
      tokens: clean.tokens, costUsd: clean.cost, capacityTokens: clean.tokens * scale, capacityCostUsd: clean.cost * scale,
      confidence: confidenceOf(clean.points), current: isCurrent,
      offPoints: clean.offPoints, markedPoints: clean.markedPoints, cleanPoints: clean.points,
      ...(segment.endedByReset ? { endedByReset: segment.endedByReset } : {}),
      ...(segment.startedByReset ? { startedByReset: segment.startedByReset } : {}),
    };
    history.points.push(point);
    if (isCurrent) current = { tokens: point.capacityTokens, costUsd: point.capacityCostUsd, confidence: point.confidence, offPoints: clean.offPoints };
  });
  return { history, current };
}

/** 这个账号这一家的官方请求，按时间排好（容量折算用）。 */
export function accountRows(rows: RequestRow[], kind: AccountKind, accountId: string) {
  return rows.filter((r) => r.account?.id === accountId && r.official === true && FAMILY[kind].test(r.model) && Number.isFinite(r.tokens) && Number.isFinite(r.costUsd)).sort((a, b) => a.at - b.at);
}
