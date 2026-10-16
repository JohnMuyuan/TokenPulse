/** 每周小结的触发时间、状态文件与通知文案。 */
import type { UsageDetail } from "./report";
import { isWeek, weekReport, weekStartOf, type WeekReport } from "./share-report";
import { dataFile, readJson, writeJson } from "./paths";

export type WeeklySummaryState = { week: string; at: number; sent: boolean };
export type WeeklyNotice = { title: string; body: string; onClick: () => void };
export type OpenPageTarget = { page: "share"; tab: "week"; pick: string };

function localDay(week: string) { const [y, m, d] = week.split("-").map(Number); return new Date(y, m - 1, d, 12); }
function shiftWeek(week: string, days: number) { const date = localDay(week); date.setDate(date.getDate() + days); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function stateFile() { return dataFile("weekly-summary.json"); }

export function weeklyDue(now: Date | number, state: WeeklySummaryState | null, enabled: boolean): string | null {
  if (!enabled) return null;
  const at = new Date(now);
  if (!Number.isFinite(at.getTime())) return null;
  const currentMonday = weekStartOf(at);
  const dueAt = localDay(currentMonday); dueAt.setHours(9, 0, 0, 0);
  if (at.getTime() < dueAt.getTime()) return null;
  const week = shiftWeek(currentMonday, -7);
  return state?.week === week ? null : week;
}

export function readWeeklyState(): WeeklySummaryState | null {
  const value = readJson<unknown>(stateFile(), null);
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<WeeklySummaryState>;
  if (!isWeek(state.week) || !Number.isFinite(state.at) || typeof state.sent !== "boolean") return null;
  return { week: state.week, at: state.at!, sent: state.sent };
}

export function writeWeeklyState(state: WeeklySummaryState) {
  writeJson(stateFile(), state);
}

function formatTokens(value: number) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}
function money(value: number) { return Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function weekRange(week: string) {
  const start = localDay(week), end = localDay(shiftWeek(week, 6));
  const short = (date: Date) => `${date.getMonth() + 1}/${date.getDate()}`;
  return start.getFullYear() === end.getFullYear()
    ? `${short(start)}–${short(end)}`
    : `${start.getFullYear()}/${short(start)}–${end.getFullYear()}/${short(end)}`;
}

export function describeWeekly(report: WeekReport): { title: string; body: string } {
  const change = report.previousTokens ? Math.round((report.tokens / report.previousTokens - 1) * 100) : null;
  const first = change == null
    ? `用了 ${formatTokens(report.tokens)} tokens，参考费用 $${money(report.costUsd)}`
    : `用了 ${formatTokens(report.tokens)} tokens，比前一周${change >= 0 ? "多" : "少"} ${Math.abs(change)}%，参考费用 $${money(report.costUsd)}`;
  const top = report.models[0];
  const lines = [first];
  if (top) lines.push(`用得最多：${top.model}（${Math.round(top.share * 100)}%）· 活跃 ${report.activeDays} 天`);
  if (report.cacheSavingsAvailable && (report.cacheRead > 0 || report.cacheSavingsUsd < 0) && report.cacheHitRate != null) {
    lines.push(report.cacheSavingsUsd < 0
      ? `缓存命中 ${Math.round(report.cacheHitRate * 100)}%，缓存写入多花约 $${money(report.cacheSavingsUsd)}`
      : `缓存命中 ${Math.round(report.cacheHitRate * 100)}%，净省下约 $${money(report.cacheSavingsUsd)}`);
  }
  return { title: `上周小结 · ${weekRange(report.week)}`, body: lines.slice(0, 3).join("\n") };
}

let inFlight = false;
/** 同步处理状态后再交给通知函数，避免同一轮扫描重入时重复发送。 */
export function maybeWeeklySummary(input: {
  now: Date | number; usage: UsageDetail[]; enabled: boolean;
  notify: (notice: WeeklyNotice) => void; openPage: (target: OpenPageTarget) => void;
}) {
  if (inFlight) return null;
  inFlight = true;
  try {
    const state = readWeeklyState();
    const week = weeklyDue(input.now, state, input.enabled);
    if (!week) return null;
    const report = weekReport({ usage: input.usage, week });
    const sent = report.tokens > 0;
    const at = input.now instanceof Date ? input.now.getTime() : input.now;
    writeWeeklyState({ week, at, sent });
    if (sent) {
      const { title, body } = describeWeekly(report);
      input.notify({ title, body, onClick: () => input.openPage({ page: "share", tab: "week", pick: week }) });
    }
    return { week, sent };
  } finally {
    inFlight = false;
  }
}
