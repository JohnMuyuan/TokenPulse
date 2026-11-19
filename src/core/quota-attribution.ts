import type { RequestRow } from "./request-log";
import type { WindowSegment } from "./quota-monitor";
export type QuotaInterval = { from: number; to: number; points: number; kind: "local_present" | "unmatched" | "uncertain"; localTokens: number; cycleId: string; suspected?: boolean };
const GAP = 30 * 60000, LAG = 5 * 60000;
type Observation = { interval: QuotaInterval; rows: RequestRow[]; issue?: "gap" | "baseline" | "accountUncertain" };

/** rows 已按时间排序。每次只计入超出窗口高水位的净涨幅，请求只落入一个 (from, to]。 */
export function observeQuotaIntervals(segment: WindowSegment, rows: RequestRow[], now: number, requireAlignedBaseline = true): Observation[] {
  const start = segment.points[0];
  if (!start) return [];
  const cycleId = `${segment.startAt}:${segment.endAt}:${segment.resetAt}`;
  const upper = (at: number) => { let l = 0, h = rows.length; while (l < h) { const m = (l + h) >>> 1; if (rows[m].at <= at) l = m + 1; else h = m; } return l; };
  const observations: Observation[] = [];
  let aligned = start.pct <= 0.01;
  let from = aligned ? segment.startAt : Math.max(start.at, segment.startAt);
  let peak = Math.max(0, Math.min(100, start.pct));
  let previous = start;
  for (const point of segment.points.slice(1)) {
    if (point.at > now || point.at > segment.endAt || point.at <= previous.at) continue;
    const pct = Math.max(0, Math.min(100, point.pct));
    const gap = point.at - previous.at > GAP && pct - previous.pct > 0.01;
    previous = point;
    const points = pct - peak;
    if (point.at <= from) {
      if (points > 0.01) { peak = pct; aligned = false; }
      continue;
    }
    // 整数上报的额度必须累计到一次完整跳点。相邻采样持平的长空档可以继续累计。
    if (points <= 0 || (points < 1 - 1e-9 && (!gap || points <= 0.01))) continue;
    const part = rows.slice(upper(from), upper(point.at));
    const localTokens = part.reduce((sum, row) => sum + row.tokens, 0);
    const inferred = part.some(row => row.account?.basis === "inferred");
    const issue = gap ? "gap" : requireAlignedBaseline && !aligned ? "baseline" : inferred ? "accountUncertain" : undefined;
    const near = upper(Math.min(point.at + LAG, now)) > upper(from - LAG);
    const kind = issue ? "uncertain" : localTokens > 0 ? "local_present" : near || point.at + LAG > now ? "uncertain" : "unmatched";
    observations.push({ interval: { from, to: point.at, points, kind, localTokens, cycleId }, rows: part, issue });
    from = point.at;
    peak = pct;
    aligned = !gap;
  }
  return observations;
}

/** 项目分摊只使用可见的同步观测。 */
export function quotaAttribution(segments: WindowSegment[], records: RequestRow[], now: number) {
  const rows = records.slice().sort((a, b) => a.at - b.at);
  return segments.flatMap(segment => observeQuotaIntervals(segment, rows, now, false).map(observation => observation.interval));
}
export function summarizeAttribution(intervals: QuotaInterval[]) {
  const sum = (kind?: QuotaInterval["kind"]) => intervals.filter(i => !kind || i.kind === kind).reduce((s, i) => s + i.points, 0);
  return { sampledPoints: sum(), unmatchedPoints: sum("unmatched"), uncertainPoints: sum("uncertain"), localCoincidentPoints: sum("local_present"), intervals };
}
