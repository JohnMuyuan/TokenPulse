import type { RequestRow } from "./request-log";
import type { WindowSegment } from "./quota-monitor";
export type QuotaInterval = { from: number; to: number; points: number; kind: "local_present" | "unmatched" | "uncertain"; localTokens: number; cycleId: string };
const GAP = 30 * 60000, LAG = 5 * 60000;
/** 只描述同步观测，不能把有本机请求的区间当成“全部来自本机”，也不能断定缺失日志一定是聊天。 */
export function quotaAttribution(segments: WindowSegment[], records: RequestRow[], now: number) {
  const rows = records.slice().sort((a, b) => a.at - b.at);
  const upper = (at: number) => { let l = 0, h = rows.length; while (l < h) { const m = (l + h) >>> 1; if (rows[m].at <= at) l = m + 1; else h = m; } return l; };
  const intervals: QuotaInterval[] = [];
  for (const segment of segments) {
    let anchor = segment.points[0], previous = anchor;
    for (const point of segment.points.slice(1)) {
      if (!anchor) { anchor = previous = point; continue; }
      const delta = point.pct - anchor.pct, step = point.at - previous.at; previous = point;
      if (point.at <= anchor.at) continue;
      if (delta < -0.01) { anchor = point; continue; }
      if (step > GAP) { if (delta > 0) intervals.push({ from: anchor.at, to: point.at, points: delta, kind: "uncertain", localTokens: 0, cycleId: `${segment.startAt}:${segment.endAt}:${segment.resetAt}` }); anchor = point; continue; }
      if (delta < 1) continue;
      const part = rows.slice(upper(anchor.at), upper(point.at));
      const adjacent = rows.slice(upper(anchor.at - LAG), upper(Math.min(point.at + LAG, now)));
      const localTokens = part.reduce((s, r) => s + r.tokens, 0);
      const uncertain = part.some(r => r.account?.basis === "inferred");
      const kind = localTokens > 0 && !uncertain ? "local_present" : adjacent.length || point.at + LAG > now || uncertain ? "uncertain" : "unmatched";
      intervals.push({ from: anchor.at, to: point.at, points: delta, kind, localTokens, cycleId: `${segment.startAt}:${segment.endAt}:${segment.resetAt}` }); anchor = point;
    }
  }
  return intervals;
}
export function summarizeAttribution(intervals: QuotaInterval[]) {
  const sum = (kind?: QuotaInterval["kind"]) => intervals.filter(i => !kind || i.kind === kind).reduce((s, i) => s + i.points, 0);
  return { sampledPoints: sum(), unmatchedPoints: sum("unmatched"), uncertainPoints: sum("uncertain"), localCoincidentPoints: sum("local_present"), intervals };
}
