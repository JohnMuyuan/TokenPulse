import { cacheSavings, priceOf, type TokenCounts } from "./model-pricing";
import type { RequestRow } from "./request-log";

export type CacheCause = "compaction" | "model" | "account" | "idle" | "unknown";
type CacheTotals = { input: number; cacheRead: number; cacheWrite: number; fresh: number; hitRate: number | null; savingsUsd: number; unpricedTokens: number };
type CacheGroup = { input: number; cacheRead: number; cacheWrite: number; savingsUsd: number };
type BreakCauseTotal = { count: number; lostTokens: number; extraUsd: number };
type CacheBreak = { at: number; source: string; session: string; project: string; model: string; cause: CacheCause; gapMs: number; lostTokens: number; extraUsd: number };

export type CacheAnalysis = {
  totals: CacheTotals;
  daily: (CacheGroup & { day: string; hitRate: number | null })[];
  bySource: (CacheGroup & { source: string; hitRate: number | null })[];
  byModel: (CacheGroup & { model: string; hitRate: number | null })[];
  coldStarts: { count: number; tokens: number; costUsd: number };
  breaks: { count: number; lostTokens: number; extraUsd: number; byCause: Record<CacheCause, BreakCauseTotal> };
  sessions: { source: string; session: string; project: string; firstAt: number; lastAt: number; requests: number; hitRate: number | null; breaks: number; lostTokens: number; extraUsd: number }[];
  recentBreaks: CacheBreak[];
};

const CAUSES: CacheCause[] = ["compaction", "model", "account", "idle", "unknown"];
const EMPTY_CAUSE = (): BreakCauseTotal => ({ count: 0, lostTokens: 0, extraUsd: 0 });
const emptyGroup = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, savingsUsd: 0 });
const hitRate = (input: number, cacheRead: number) => input > 0 ? cacheRead / input : null;
const dayOf = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const projectOf = (cwd?: string) => (cwd || "").trim().replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || "";
const tokenCounts = (row: RequestRow): TokenCounts => ({ input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite });

function addGroup(target: CacheGroup, row: RequestRow) {
  target.input += row.input;
  target.cacheRead += row.cacheRead;
  target.cacheWrite += row.cacheWrite;
  const savings = cacheSavings(row.model, tokenCounts(row));
  if (savings !== null) target.savingsUsd += savings;
}

function breakCause(prev: RequestRow, cur: RequestRow, compactionSincePrev: boolean): CacheCause {
  if (compactionSincePrev) return "compaction";
  if ((prev.returned || prev.model) !== (cur.returned || cur.model)) return "model";
  if (prev.account?.id && cur.account?.id && prev.account.id !== cur.account.id) return "account";
  if (cur.at - prev.at > 5 * 60_000) return "idle";
  return "unknown";
}

/**
 * 按已筛选的请求行分析缓存；不读文件，也不保留会话正文。
 * 合计、按天 / 工具 / 型号的口径和其他页面一样（压缩估算行、CC Switch 导入的行都算进去）；
 * 断档和冷启动只看能排成会话的行：压缩估算行跳过（下一条记为「压缩」），CC Switch 导入的一行一个 id、排不成会话。
 * Claude 解析器目前只读 `cache_creation_input_tokens`，无法区分 5 分钟与 1 小时缓存；本轮不改解析器或 STATE_VERSION。
 * Grok 一行代表一轮，可能包含多次模型调用，因此会话请求数按行数统计。
 * 会话的第一条按冷启动算；筛选的时间范围从会话中途切进来时，范围内的第一条也算冷启动。
 */
export function analyzeCache(rows: RequestRow[]): CacheAnalysis {
  const totals: CacheTotals = { input: 0, cacheRead: 0, cacheWrite: 0, fresh: 0, hitRate: null, savingsUsd: 0, unpricedTokens: 0 };
  const daily = new Map<string, CacheGroup>();
  const sources = new Map<string, CacheGroup>();
  const models = new Map<string, CacheGroup>();
  const grouped = new Map<string, RequestRow[]>();
  for (const row of rows) {
    const saving = cacheSavings(row.model, tokenCounts(row));
    totals.input += row.input;
    totals.cacheRead += row.cacheRead;
    totals.cacheWrite += row.cacheWrite;
    totals.fresh += Math.max(0, row.input - row.cacheRead - row.cacheWrite);
    if (saving === null) totals.unpricedTokens += row.input + row.output;
    else totals.savingsUsd += saving;
    const day = dayOf(row.at);
    const dayGroup = daily.get(day) ?? emptyGroup();
    addGroup(dayGroup, row);
    daily.set(day, dayGroup);
    const sourceGroup = sources.get(row.source) ?? emptyGroup();
    addGroup(sourceGroup, row);
    sources.set(row.source, sourceGroup);
    const modelGroup = models.get(row.model) ?? emptyGroup();
    addGroup(modelGroup, row);
    models.set(row.model, modelGroup);
    if (row.key.startsWith("cc-switch\u0000")) continue;
    const key = `${row.source}\u0000${row.session}`;
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }

  const coldStarts = { count: 0, tokens: 0, costUsd: 0 };
  const breaks = { count: 0, lostTokens: 0, extraUsd: 0, byCause: Object.fromEntries(CAUSES.map(cause => [cause, EMPTY_CAUSE()])) as Record<CacheCause, BreakCauseTotal> };
  const sessions: CacheAnalysis["sessions"] = [];
  const recentBreaks: CacheBreak[] = [];

  for (const [groupKey, sessionRows] of grouped) {
    sessionRows.sort((a, b) => a.at - b.at);
    let prev: RequestRow | null = null;
    let compactionSincePrev = false;
    let requestCount = 0;
    let sessionInput = 0, sessionRead = 0, sessionBreaks = 0, sessionLost = 0, sessionExtra = 0;
    let firstAt = 0, lastAt = 0;
    const [source, session] = groupKey.split("\u0000");

    for (const row of sessionRows) {
      if (row.compaction) {
        compactionSincePrev = true;
        continue;
      }
      requestCount++;
      sessionInput += row.input;
      sessionRead += row.cacheRead;
      if (!firstAt) firstAt = row.at;
      lastAt = row.at;

      if (!prev) {
        coldStarts.count++;
        coldStarts.tokens += row.cacheWrite;
        const price = priceOf(row.model);
        if (price) coldStarts.costUsd += row.cacheWrite * (price.cacheWrite > 0 ? price.cacheWrite : price.input) / 1_000_000;
      } else {
        const base = Math.min(prev.input, row.input);
        if (base >= 4096 && row.cacheRead < base * 0.5) {
          const lostTokens = Math.max(0, base - row.cacheRead);
          const cause = breakCause(prev, row, compactionSincePrev);
          const price = priceOf(row.model);
          const extraUsd = price
            ? lostTokens * ((price.cacheWrite > 0 ? price.cacheWrite : price.input) - price.cacheRead) / 1_000_000
            : 0;
          const detail: CacheBreak = { at: row.at, source, session, project: projectOf(row.cwd), model: row.returned || row.model, cause, gapMs: row.at - prev.at, lostTokens, extraUsd };
          breaks.count++;
          breaks.lostTokens += lostTokens;
          breaks.extraUsd += extraUsd;
          breaks.byCause[cause].count++;
          breaks.byCause[cause].lostTokens += lostTokens;
          breaks.byCause[cause].extraUsd += extraUsd;
          sessionBreaks++;
          sessionLost += lostTokens;
          sessionExtra += extraUsd;
          recentBreaks.push(detail);
        }
      }
      prev = row;
      compactionSincePrev = false;
    }
    if (requestCount) sessions.push({ source, session, project: projectOf(sessionRows.find(row => !row.compaction)?.cwd), firstAt, lastAt, requests: requestCount, hitRate: hitRate(sessionInput, sessionRead), breaks: sessionBreaks, lostTokens: sessionLost, extraUsd: sessionExtra });
  }

  totals.hitRate = hitRate(totals.input, totals.cacheRead);
  const dailyRows = [...daily].map(([day, group]) => ({ day, ...group, hitRate: hitRate(group.input, group.cacheRead) })).sort((a, b) => a.day.localeCompare(b.day));
  const bySource = [...sources].map(([source, group]) => ({ source, ...group, hitRate: hitRate(group.input, group.cacheRead) })).sort((a, b) => b.input - a.input);
  const byModel = [...models].map(([model, group]) => ({ model, ...group, hitRate: hitRate(group.input, group.cacheRead) })).sort((a, b) => b.input - a.input);
  sessions.sort((a, b) => b.breaks - a.breaks || b.extraUsd - a.extraUsd || b.lostTokens - a.lostTokens);
  recentBreaks.sort((a, b) => b.at - a.at);
  return { totals, daily: dailyRows, bySource, byModel, coldStarts, breaks, sessions: sessions.filter(item => item.breaks).slice(0, 10), recentBreaks: recentBreaks.slice(0, 20) };
}
