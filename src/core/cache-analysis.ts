import { cacheSavings, priceOf, type TokenCounts } from "./model-pricing";
import type { RequestRow } from "./request-log";

export type CacheCause = "compaction" | "model" | "account" | "idle" | "unknown";
export type RetentionBucketId = "lt1m" | "1to3m" | "3to5m" | "5to10m" | "10to30m" | "gt30m";
export type RetentionBucket = {
  id: RetentionBucketId;
  minMs: number;
  maxMs: number | null;
  total: number;
  hits: number;
  keepRate: number | null;
};
export type RetentionStatus =
  | "estimated"
  | "at-least"
  | "short-gaps-only"
  | "volatile"
  | "no-cache"
  | "insufficient";
export type ModelCacheRetention = {
  model: string;
  source: string;
  sources: string[];
  samples: number;
  retained: number;
  broken: number;
  status: RetentionStatus;
  ttlMinMs: number | null;
  ttlMaxMs: number | null;
  maxHitGapMs: number | null;
  opportunistic: boolean;
  buckets: RetentionBucket[];
};

type CacheTotals = { input: number; cacheRead: number; cacheWrite: number; fresh: number; hitRate: number | null; savingsUsd: number; unpricedTokens: number };
type CacheGroup = { input: number; cacheRead: number; cacheWrite: number; savingsUsd: number };
type BreakCauseTotal = { count: number; lostTokens: number; extraUsd: number };
type CacheBreak = { at: number; source: string; session: string; sessionKey?: string; project: string; model: string; cause: CacheCause; gapMs: number; lostTokens: number; extraUsd: number };

export type CacheAnalysis = {
  totals: CacheTotals;
  daily: (CacheGroup & { day: string; hitRate: number | null })[];
  bySource: (CacheGroup & { source: string; hitRate: number | null })[];
  byModel: (CacheGroup & { model: string; hitRate: number | null })[];
  retention: ModelCacheRetention[];
  coldStarts: { count: number; tokens: number; costUsd: number };
  breaks: { count: number; lostTokens: number; extraUsd: number; byCause: Record<CacheCause, BreakCauseTotal> };
  sessions: {
    source: string;
    session: string;
    sessionKey?: string;
    title?: string;
    isSubagent?: boolean;
    parentKey?: string;
    agentName?: string;
    subagentKind?: "swarm" | "subagent" | "review";
    swarmTitle?: string;
    project: string;
    firstAt: number;
    lastAt: number;
    requests: number;
    hitRate: number | null;
    breaks: number;
    lostTokens: number;
    extraUsd: number;
  }[];
  recentBreaks: CacheBreak[];
};

const RETENTION_DEFS: { id: RetentionBucketId; minMs: number; maxMs: number | null }[] = [
  { id: "lt1m", minMs: 0, maxMs: 60_000 },
  { id: "1to3m", minMs: 60_000, maxMs: 3 * 60_000 },
  { id: "3to5m", minMs: 3 * 60_000, maxMs: 5 * 60_000 },
  { id: "5to10m", minMs: 5 * 60_000, maxMs: 10 * 60_000 },
  { id: "10to30m", minMs: 10 * 60_000, maxMs: 30 * 60_000 },
  { id: "gt30m", minMs: 30 * 60_000, maxMs: null },
];

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
  const modelTrials = new Map<string, { sourceCounts: Map<string, number>; pairs: { gapMs: number; kept: boolean }[] }>();

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
        const prevModel = prev.returned || prev.model;
        const curModel = row.returned || row.model;
        const sameAccount = !(prev.account?.id && row.account?.id && prev.account.id !== row.account.id);
        if (!compactionSincePrev && prevModel === curModel && sameAccount && base >= 4096) {
          const gapMs = Math.max(0, row.at - prev.at);
          const kept = row.cacheRead >= base * 0.5;
          let entry = modelTrials.get(curModel);
          if (!entry) modelTrials.set(curModel, (entry = { sourceCounts: new Map(), pairs: [] }));
          entry.sourceCounts.set(source, (entry.sourceCounts.get(source) ?? 0) + 1);
          entry.pairs.push({ gapMs, kept });
        }
        if (base >= 4096 && row.cacheRead < base * 0.5) {
          const lostTokens = Math.max(0, base - row.cacheRead);
          const cause = breakCause(prev, row, compactionSincePrev);
          const price = priceOf(row.model);
          const extraUsd = price
            ? lostTokens * ((price.cacheWrite > 0 ? price.cacheWrite : price.input) - price.cacheRead) / 1_000_000
            : 0;
          const detail: CacheBreak = {
            at: row.at,
            source,
            session,
            ...(row.sessionKey ? { sessionKey: row.sessionKey } : {}),
            project: projectOf(row.cwd),
            model: row.returned || row.model,
            cause,
            gapMs: row.at - prev.at,
            lostTokens,
            extraUsd,
          };
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
    if (requestCount) {
      const metaRow = sessionRows.find(row => !row.compaction) ?? sessionRows[0];
      const sessionKey = sessionRows.find(row => row.sessionKey)?.sessionKey;
      const title = sessionRows.find(row => row.sessionTitle)?.sessionTitle;
      const isSubagent = sessionRows.some(row => row.isSubagent);
      const parentKey = sessionRows.find(row => row.parentKey)?.parentKey;
      const agentName = sessionRows.find(row => row.agentName)?.agentName;
      const subagentKind = sessionRows.find(row => row.subagentKind)?.subagentKind;
      const swarmTitle = sessionRows.find(row => row.swarmTitle)?.swarmTitle;
      sessions.push({
        source,
        session,
        ...(sessionKey ? { sessionKey } : {}),
        ...(title ? { title } : {}),
        ...(isSubagent ? { isSubagent: true } : {}),
        ...(parentKey ? { parentKey } : {}),
        ...(agentName ? { agentName } : {}),
        ...(subagentKind ? { subagentKind } : {}),
        ...(swarmTitle ? { swarmTitle } : {}),
        project: projectOf(metaRow?.cwd),
        firstAt,
        lastAt,
        requests: requestCount,
        hitRate: hitRate(sessionInput, sessionRead),
        breaks: sessionBreaks,
        lostTokens: sessionLost,
        extraUsd: sessionExtra,
      });
    }
  }

  const retention: ModelCacheRetention[] = [...modelTrials.entries()]
    .map(([model, entry]): ModelCacheRetention => {
      const { pairs, sourceCounts } = entry;
      const orderedSources = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
      const buckets: RetentionBucket[] = RETENTION_DEFS.map(def => ({ id: def.id, minMs: def.minMs, maxMs: def.maxMs, total: 0, hits: 0, keepRate: null }));
      let retained = 0;
      let maxHitGapMs: number | null = null;
      let under5mTotal = 0;
      let under5mMisses = 0;
      for (const p of pairs) {
        const b = buckets.find(item => p.gapMs >= item.minMs && (item.maxMs === null || p.gapMs < item.maxMs)) ?? buckets[buckets.length - 1];
        b.total++;
        if (p.kept) {
          b.hits++;
          retained++;
          if (maxHitGapMs === null || p.gapMs > maxHitGapMs) maxHitGapMs = p.gapMs;
        }
        if (p.gapMs < 5 * 60_000) {
          under5mTotal++;
          if (!p.kept) under5mMisses++;
        }
      }
      for (const b of buckets) b.keepRate = b.total > 0 ? b.hits / b.total : null;
      const samples = pairs.length;
      const broken = samples - retained;
      const opportunistic = retained > 0 && under5mTotal >= 3 && under5mMisses >= 2 && under5mMisses / under5mTotal >= 0.25;

      let status: RetentionStatus = "insufficient";
      let ttlMinMs: number | null = null;
      let ttlMaxMs: number | null = null;

      if (samples < 3) {
        status = "insufficient";
      } else if (retained === 0) {
        status = "no-cache";
      } else {
        let lastHoldIdx = -1;
        let firstDropIdx = -1;
        for (let i = 0; i < buckets.length; i++) {
          const b = buckets[i];
          if (b.total === 0) continue;
          if ((b.keepRate ?? 0) >= 0.5) {
            lastHoldIdx = i;
            continue;
          }
          // 若当前桶只有 1 个失败样本（可能是偶然改了系统提示词），但后面紧跟着 >=2 样本且命中率 >=50% 的桶，不把这 1 次当成过期断崖
          const strongerLater = b.total === 1 && buckets.slice(i + 1).some(nb => nb.total >= 2 && (nb.keepRate ?? 0) >= 0.5);
          if (strongerLater) continue;
          firstDropIdx = i;
          break;
        }
        if (lastHoldIdx < 0) {
          status = "volatile";
          ttlMinMs = 0;
          ttlMaxMs = 60_000;
        } else if (firstDropIdx < 0) {
          if ((maxHitGapMs ?? 0) < 60_000) {
            status = "short-gaps-only";
          } else {
            status = "at-least";
            ttlMinMs = maxHitGapMs;
          }
        } else {
          status = "estimated";
          const holdDef = buckets[lastHoldIdx];
          const dropDef = buckets[firstDropIdx];
          const holdHits = pairs.filter(p => p.kept && p.gapMs >= holdDef.minMs && (holdDef.maxMs === null || p.gapMs < holdDef.maxMs));
          const dropMisses = pairs.filter(p => !p.kept && p.gapMs >= dropDef.minMs && (dropDef.maxMs === null || p.gapMs < dropDef.maxMs));
          const holdMax = holdHits.length ? holdHits.reduce((max, p) => Math.max(max, p.gapMs), -Infinity) : holdDef.minMs;
          const dropMin = dropMisses.length ? dropMisses.reduce((min, p) => Math.min(min, p.gapMs), Infinity) : dropDef.minMs;
          const lowMin = Math.max(1, Math.round(Math.max(holdDef.minMs, holdMax) / 60_000));
          const highMin = Math.max(lowMin, Math.round(Math.max(dropDef.minMs, dropMin) / 60_000));
          ttlMinMs = lowMin * 60_000;
          ttlMaxMs = highMin * 60_000;
        }
      }

      return {
        model,
        source: orderedSources[0] || "",
        sources: orderedSources,
        samples,
        retained,
        broken,
        status,
        ttlMinMs,
        ttlMaxMs,
        maxHitGapMs,
        opportunistic,
        buckets,
      };
    })
    .sort((a, b) => b.samples - a.samples || b.retained - a.retained || a.model.localeCompare(b.model));

  totals.hitRate = hitRate(totals.input, totals.cacheRead);
  const dailyRows = [...daily].map(([day, group]) => ({ day, ...group, hitRate: hitRate(group.input, group.cacheRead) })).sort((a, b) => a.day.localeCompare(b.day));
  const bySource = [...sources].map(([source, group]) => ({ source, ...group, hitRate: hitRate(group.input, group.cacheRead) })).sort((a, b) => b.input - a.input);
  const byModel = [...models].map(([model, group]) => ({ model, ...group, hitRate: hitRate(group.input, group.cacheRead) })).sort((a, b) => b.input - a.input);
  sessions.sort((a, b) => b.breaks - a.breaks || b.extraUsd - a.extraUsd || b.lostTokens - a.lostTokens);
  recentBreaks.sort((a, b) => b.at - a.at);
  return { totals, daily: dailyRows, bySource, byModel, retention, coldStarts, breaks, sessions: sessions.filter(item => item.breaks).slice(0, 10), recentBreaks: recentBreaks.slice(0, 20) };
}
