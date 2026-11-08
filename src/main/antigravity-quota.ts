import fs from "fs";
import path from "path";
import {
  antigravityConversationFiles,
  antigravityDir,
  antigravityDirs,
  antigravityHub,
  fetchAntigravityStatus,
  splitModelLabel,
  type AgyCredits,
  type AgyModelQuotaItem,
  type AgyQuotaGroup,
  type AgyStatus,
  type AgyWindowQuota,
} from "../core/antigravity";
import { errorText, log } from "../core/app-log";
import { loadKnowledge, type PriceRule } from "../core/knowledge";
import { comboKey } from "../core/model-catalog";
import { estimateCost, priceOf } from "../core/model-pricing";
import { speedSeriesOf, type SpeedSeries } from "../core/pass-speed";
import { dataFile, readJson, writeJson } from "../core/paths";
import { queryRequests, type RequestRow } from "../core/request-log";

/**
 * Google Antigravity 的额度监控与深度分析。
 *
 * 额度通过本机的 Antigravity language server 查询（见 core/antigravity.ts）：
 * - GetUserStatus：返回套餐（plan / tier / credits）和各型号配置（5 小时额度与 model_enum 显示名标签）；
 * - RetrieveUserQuotaSummary：返回分组的 5 小时（5h）与周额度（weekly）双窗口剩余比例和重置时间。
 *
 * 存盘（antigravity-quota.json）：最后一次结果 + 最近 30 天的采样 + 每组提醒过的窗口。不存令牌、邮箱、名字。
 */

export type AgyGroupState = AgyQuotaGroup & { key: string };
export type AgyLast = {
  at: number;
  ok: boolean;
  error?: string;
  plan?: string;
  tier?: string;
  groups: AgyGroupState[];
  models?: AgyModelQuotaItem[];
  credits?: AgyCredits;
};
export type AgySampleGroup = {
  key: string;
  used: number;
  resetAt?: string;
  weekUsed?: number;
  weekResetAt?: string;
};
export type AgySample = { at: number; groups: AgySampleGroup[] };

export type AgyUsageSummary = {
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  costUsd: number;
  requests: number;
};

export type AgyResetStyle = "moved" | "kept";

export type AgyWindowSegment = {
  startAt: number;
  endAt: number;
  resetAt: number;
  points: { at: number; used: number }[];
  startedByReset?: AgyResetStyle;
  endedByReset?: AgyResetStyle;
};

export type AgyWindowCapacity = {
  fullTokens: number | null;
  fullCostUsd: number | null;
  remainingTokens: number | null;
  remainingCostUsd: number | null;
  basis: "measured" | "current" | null;
  confidence: "medium" | "low" | "current" | "insufficient";
  points: number;
  intervals: number;
};

export type AgyWindowInsight = {
  window: "five" | "week";
  used: number;
  remaining: number;
  resetAt?: string;
  startAt: number;
  endAt: number;
  ended: boolean;
  startedByReset?: AgyResetStyle;
  ratePerHour: number | null;
  recentRatePerHour: number | null;
  ratePerDay: number | null;
  projected: number | null;
  etaAt: number | null;
  local: AgyUsageSummary;
  capacity: AgyWindowCapacity;
};

export type AgyGroupModelItem = {
  label: string;
  family: string;
  model: string;
  effort?: string;
  used: number;
  remaining: number;
  resetAt?: string;
  weekUsed?: number;
  weekRemaining?: number;
  weekResetAt?: string;
  d7: AgyUsageSummary;
  d30: AgyUsageSummary;
};

export type AgyCapacityPoint = {
  at: number;
  startAt: number;
  endAt: number;
  resetAt: number;
  usedPct: number;
  tokens: number;
  costUsd: number;
  fullTokens: number;
  fullCostUsd: number;
  startedByReset?: AgyResetStyle;
  endedByReset?: AgyResetStyle;
};

export type AgyGroupInsight = {
  key: string;
  title: string;
  models: string[];
  five: AgyWindowInsight;
  week: AgyWindowInsight | null;
  items: AgyGroupModelItem[];
  capacityHistory: {
    five: AgyCapacityPoint[];
    week: AgyCapacityPoint[];
  };
};

export type AgyModelCapacityRow = {
  key: string;
  model: string;
  family: string;
  effort: string;
  groupKey: string;
  groupTitle: string;
  listPrice: { input: number; output: number; cacheRead: number; cacheWrite: number; note: string } | null;
  usdPerMTokens: number | null;
  tokensPerCall: number | null;
  mixBasis: "model" | "group" | "default";
  recentTokens: number;
  recentCalls: number;
  recentCostUsd: number;
  fiveTokens: number | null;
  fiveCalls: number | null;
  fiveRemainingTokens: number | null;
  weekTokens: number | null;
  weekCalls: number | null;
  weekRemainingTokens: number | null;
  relative: number | null;
};

export type AgyRecentRequest = {
  id: string;
  at: number;
  model: string;
  effort?: string;
  requested?: string;
  returned?: string;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  costUsd: number;
  priced: boolean;
  cwd?: string;
  verify: { status: string; label: string; channel: string; reasons: string[] };
  timing?: { ms?: number; firstTokenMs?: number; tokensPerSec?: number; stream?: boolean; provider?: string };
  estimate?: { ms: number; tokensPerSec: number };
};

export type AgyInsight = {
  now: number;
  conversations: number;
  sampleCount: number;
  groups: AgyGroupInsight[];
  localUsage: {
    today: AgyUsageSummary;
    d7: AgyUsageSummary;
    d30: AgyUsageSummary;
    lastAt: number | null;
    hourly: { hour: number; tokens: number; costUsd: number; requests: number; byModel: Record<string, number> }[];
    models: {
      model: string;
      effort?: string;
      tokens: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      costUsd: number;
      requests: number;
      avgSpeed: number | null;
      avgFirstMs: number | null;
      lastAt: number;
    }[];
    recentRequests: AgyRecentRequest[];
    verifySummary: { match: number; mismatch: number; suspect: number; unverified: number; total: number };
  };
  modelCapacities: AgyModelCapacityRow[];
  priceSource: { version: string | number; updatedAt: string };
};

export type AgyQuotaState = {
  /** 本机装了 Antigravity（有它的数据目录）。没装的话界面上不出现。 */
  installed: boolean;
  /** 上一次查的时候 Antigravity 开着。 */
  running: boolean;
  loading: boolean;
  conversations?: number;
  last?: AgyLast;
  /** 最近 7 天的采样，画走势用。 */
  history: AgySample[];
  /** 窗口折算、本机用量、模型换算与最近请求。 */
  insight?: AgyInsight;
};

type Stored = { last?: AgyLast; history: AgySample[]; notified: Record<string, number> };

const HOUR = 3_600_000;
const DAY = 86_400_000;
const FIVE_MS = 5 * HOUR;
const WEEK_MS = 7 * DAY;
const KEEP_MS = 30 * DAY;
const SHOW_MS = 7 * DAY;
/** 一样的结果最多隔这么久记一条采样，免得一直开着时一分钟一条。 */
const SAMPLE_EVERY_MS = 10 * 60_000;
/** 同一个窗口：重置时间相差不到这么多就算一个（各次返回的时间会有一点抖动）。 */
const SAME_WINDOW_MS = 15 * 60_000;

const DEFAULT_MIX = { input: 1_000_000, cacheRead: 850_000, cacheWrite: 0, output: 30_000 };
const EFFORT_SCALE: Record<string, number> = { minimal: 0.45, low: 0.62, medium: 1, high: 1.55, xhigh: 2.4, max: 3.6 };

export const groupKey = (models: string[]) => [...models].sort().join("|");

function isMixedPoolModels(modelsOrKey: string[] | string): boolean {
  const text = Array.isArray(modelsOrKey) ? modelsOrKey.join("|") : String(modelsOrKey || "");
  return /gemini/i.test(text) && /claude|gpt/i.test(text);
}

function sanitizeStored(raw: Partial<Stored> | null): Stored {
  const history = (Array.isArray(raw?.history) ? raw.history : [])
    .map((sample) => ({
      ...sample,
      groups: Array.isArray(sample.groups) ? sample.groups.filter((g) => !isMixedPoolModels(g.key)) : [],
    }))
    .filter((sample) => sample.groups.length > 0);
  const rawLast = raw?.last;
  let last = rawLast;
  if (rawLast && Array.isArray(rawLast.groups) && rawLast.groups.some((g) => isMixedPoolModels(g.models))) {
    const cleanGroups = rawLast.groups.filter((g) => !isMixedPoolModels(g.models));
    if (cleanGroups.length) {
      last = { ...rawLast, groups: cleanGroups };
    } else if (history.length) {
      const prev = history[history.length - 1];
      last = {
        ...rawLast,
        groups: prev.groups.map((g) => ({
          key: g.key,
          models: g.key.split("|").filter(Boolean),
          used: g.used,
          ...(g.resetAt ? { resetAt: g.resetAt } : {}),
          ...(g.weekUsed != null ? { week: { used: g.weekUsed, ...(g.weekResetAt ? { resetAt: g.weekResetAt } : {}) } } : {}),
        })),
      };
    } else {
      last = undefined;
    }
  }
  const rawNotified = raw?.notified && typeof raw.notified === "object" ? raw.notified : {};
  const notified: Record<string, number> = {};
  for (const [k, v] of Object.entries(rawNotified)) {
    if (!isMixedPoolModels(k)) notified[k] = v;
  }
  return { last, history, notified };
}

function dayStr(at: number) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfDay(at: number) {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function shiftDay(at: number, days: number) {
  const d = new Date(at);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function summarizeRows(rows: RequestRow[]): AgyUsageSummary {
  let tokens = 0, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, reasoning = 0, costUsd = 0, requests = 0;
  for (const r of rows) {
    tokens += r.tokens || 0;
    input += r.input || 0;
    output += r.output || 0;
    cacheRead += r.cacheRead || 0;
    cacheWrite += r.cacheWrite || 0;
    reasoning += r.reasoning || 0;
    costUsd += r.costUsd || 0;
    requests += r.calls || 1;
  }
  return { tokens, input, output, cacheRead, cacheWrite, reasoning, costUsd: Math.round(costUsd * 10000) / 10000, requests };
}

function groupMatchesModel(group: { models: string[]; title?: string }, model: string): boolean {
  const norm = model.toLowerCase().trim();
  for (const family of group.models) {
    const id = splitModelLabel(family).model;
    if (norm === id || norm.startsWith(id + "-")) return true;
  }
  const isGeminiGroup = group.models.some((m) => /gemini/i.test(m)) || /gemini/i.test(group.title || "");
  if (isGeminiGroup && /gemini/i.test(norm)) return true;
  const is3pGroup = group.models.some((m) => /claude|gpt/i.test(m)) || /claude|gpt|3p/i.test(group.title || "");
  if (is3pGroup && /claude|gpt|o[134]/i.test(norm)) return true;
  return false;
}

/**
 * 至少用掉这么多百分比，才拿这一段去折算「整窗 100% 能用多少」（与 quota-monitor.ts 一致）。
 * 0.2%–1% 时接口四舍五入或时间差一点点就会把整窗容量放大几十到几百倍。
 */
const MIN_CAPACITY_PCT = 2;

/**
 * 把某一组在 5 小时窗口或周额度窗口下的历史采样切成连续的窗口段（对标 quota-monitor.ts 的 windowSegments）：
 * 1. 按官方 resetAt 分组（容忍 SAME_WINDOW_MS 抖动）；若窗口处于 0% 空闲状态导致 resetAt 随当前时间顺延，合并进同一组；
 * 2. 若上一段已有消耗，且还未到上一段的 resetAt 就开启了新的 resetAt 周期（Google 提前重置 / 重置卡顺延）：
 *    把上一段的 endAt 截断在重置发生处（标 endedByReset = "moved"），新一段标 startedByReset = "moved"，且起点不早于上一段末次采样；
 * 3. 若同一个 resetAt 周期内已用百分比大幅回落（归零或回落 >= 3 个百分点，非普通浮点抖动）：
 *    在回落前切开，前段标 endedByReset = "kept"，后段标 startedByReset = "kept"。
 */
export function agyWindowSegments(
  windowKind: "five" | "week",
  groupKeyStr: string,
  history: AgySample[],
  currentQuota: AgyWindowQuota,
  now: number,
): AgyWindowSegment[] {
  const periodMs = windowKind === "five" ? FIVE_MS : WEEK_MS;
  const pickSample = (item: AgySampleGroup) =>
    windowKind === "five"
      ? { used: item.used, resetAt: item.resetAt }
      : item.weekUsed != null
        ? { used: item.weekUsed, resetAt: item.weekResetAt }
        : null;

  const rawPoints: { at: number; used: number; resetAt: number }[] = [];
  for (const sample of history) {
    if (!Number.isFinite(sample.at) || sample.at > now) continue;
    for (const item of sample.groups) {
      if (item.key !== groupKeyStr) continue;
      const picked = pickSample(item);
      if (!picked || !Number.isFinite(picked.used)) continue;
      const rMs = picked.resetAt ? Date.parse(picked.resetAt) || 0 : 0;
      if (rMs > 0 && sample.at > rMs) continue;
      rawPoints.push({
        at: sample.at,
        used: Math.min(100, Math.max(0, Number(picked.used) || 0)),
        resetAt: rMs > 0 ? rMs : Math.floor(sample.at / periodMs) * periodMs + periodMs,
      });
    }
  }

  const currentResetMs = currentQuota.resetAt ? Date.parse(currentQuota.resetAt) || 0 : 0;
  const currentEnded = Boolean(currentResetMs && currentResetMs <= now);
  const currentUsed = currentEnded ? 0 : Math.min(100, Math.max(0, Number(currentQuota.used) || 0));
  if (!currentEnded && currentResetMs > 0) {
    const lastPt = rawPoints[rawPoints.length - 1];
    if (
      !lastPt ||
      Math.abs(lastPt.resetAt - currentResetMs) >= SAME_WINDOW_MS ||
      Math.abs(lastPt.used - currentUsed) >= 0.05
    ) {
      rawPoints.push({ at: now, used: currentUsed, resetAt: currentResetMs });
    }
  }

  rawPoints.sort((a, b) => a.at - b.at);

  const groups: { resetAt: number; startAt: number; firstAt: number; list: { at: number; used: number }[] }[] = [];
  for (const pt of rawPoints) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.resetAt - pt.resetAt) < SAME_WINDOW_MS) {
      last.resetAt = pt.resetAt;
      last.startAt = pt.resetAt - periodMs;
      last.list.push({ at: pt.at, used: pt.used });
      continue;
    }
    if (last && last.list.every((p) => p.used <= 0) && pt.resetAt - last.resetAt < periodMs) {
      last.resetAt = pt.resetAt;
      last.startAt = pt.resetAt - periodMs;
      last.list = [...last.list.filter((p) => p.at >= last.startAt - SAME_WINDOW_MS), { at: pt.at, used: pt.used }];
      continue;
    }
    groups.push({
      resetAt: pt.resetAt,
      startAt: pt.resetAt - periodMs,
      firstAt: pt.at,
      list: [{ at: pt.at, used: pt.used }],
    });
  }

  const segments: AgyWindowSegment[] = [];
  for (const group of groups) {
    const previous = segments[segments.length - 1];
    const firstListAt = group.list[0]?.at ?? group.firstAt;
    let startAt = Math.max(group.startAt - SAME_WINDOW_MS, Math.min(group.startAt, firstListAt));
    let startedByReset: AgyResetStyle | undefined;
    if (previous) {
      const prevLastAt = previous.points[previous.points.length - 1].at;
      const prevHasUsage = previous.points.some((p) => p.used > 0);
      if (prevHasUsage && group.firstAt < previous.endAt - SAME_WINDOW_MS) {
        const cutAt = group.startAt >= prevLastAt ? Math.min(group.startAt, group.firstAt) : group.firstAt;
        previous.endAt = Math.max(prevLastAt, Math.min(previous.endAt, cutAt));
        previous.endedByReset = "moved";
        startedByReset = "moved";
        startAt = Math.max(startAt, previous.endAt);
      } else {
        startAt = Math.max(startAt, prevLastAt);
      }
    }

    let part: { at: number; used: number }[] = [];
    let partStart = startAt;
    let partStarted = startedByReset;
    for (let i = 0; i < group.list.length; i += 1) {
      const point = group.list[i];
      if (i > 0) {
        const prev = group.list[i - 1];
        const isInPlaceReset =
          (prev.used >= 2 && point.used <= 1 && prev.used - point.used >= 1.5) ||
          point.used < prev.used - 3;
        if (isInPlaceReset) {
          const cut = prev.at;
          segments.push({
            startAt: partStart,
            endAt: cut,
            resetAt: group.resetAt,
            points: part,
            endedByReset: "kept",
            ...(partStarted ? { startedByReset: partStarted } : {}),
          });
          part = [];
          partStart = cut;
          partStarted = "kept";
        }
      }
      part.push(point);
    }
    segments.push({
      startAt: partStart,
      endAt: group.resetAt,
      resetAt: group.resetAt,
      points: part,
      ...(partStarted ? { startedByReset: partStarted } : {}),
    });
  }
  return segments;
}

function buildWindowInsight(
  windowKind: "five" | "week",
  quota: AgyWindowQuota,
  groupKeyStr: string,
  history: AgySample[],
  groupRows: RequestRow[],
  now: number,
): { insight: AgyWindowInsight; capacityHistory: AgyCapacityPoint[] } {
  const periodMs = windowKind === "five" ? FIVE_MS : WEEK_MS;
  const resetMs = quota.resetAt ? Date.parse(quota.resetAt) || 0 : 0;
  const ended = Boolean(resetMs && resetMs <= now);
  const endAt = resetMs > 0 ? resetMs : now;
  const used = ended ? 0 : Math.min(100, Math.max(0, Number(quota.used) || 0));
  const remaining = ended ? 100 : Math.max(0, Math.round((100 - used) * 10) / 10);

  const segments = agyWindowSegments(windowKind, groupKeyStr, history, quota, now);
  const curSeg =
    !ended && resetMs > 0
      ? [...segments].reverse().find((s) => Math.abs(s.resetAt - resetMs) < SAME_WINDOW_MS && !s.endedByReset)
      : !ended && !resetMs
        ? segments[segments.length - 1]
        : undefined;

  const startAt = curSeg ? curSeg.startAt : ended && resetMs > 0 ? resetMs : resetMs > 0 ? resetMs - periodMs : now - periodMs;
  const startedByReset = !ended ? curSeg?.startedByReset : undefined;
  const currentPoints = curSeg ? curSeg.points : [];

  let ratePerHour: number | null = null;
  let recentRatePerHour: number | null = null;
  let projected: number | null = null;
  let etaAt: number | null = null;

  if (!ended && currentPoints.length >= 2) {
    const first = currentPoints[0];
    const lastPt = currentPoints[currentPoints.length - 1];
    const hours = (lastPt.at - first.at) / HOUR;
    if (hours >= 1 / 6) {
      ratePerHour = Math.max(0, (lastPt.used - first.used) / hours);
      const leftHours = Math.max(0, (endAt - now) / HOUR);
      projected = Math.min(200, used + ratePerHour * leftHours);
      const rawEta = ratePerHour > 0 ? now + ((100 - used) / ratePerHour) * HOUR : null;
      etaAt = rawEta && rawEta < endAt ? Math.round(rawEta) : null;
    }
    const recentAnchor = [...currentPoints].reverse().find((p) => lastPt.at - p.at >= 15 * 60_000 && lastPt.at - p.at <= 2 * HOUR) ?? first;
    const recentH = (lastPt.at - recentAnchor.at) / HOUR;
    if (recentH >= 1 / 6) {
      recentRatePerHour = Math.max(0, (lastPt.used - recentAnchor.used) / recentH);
    }
  }

  const windowRows = ended ? [] : groupRows.filter((r) => r.at >= startAt && r.at <= Math.min(endAt, now));
  const local = summarizeRows(windowRows);

  const capacityHistory: AgyCapacityPoint[] = [];
  let sumPoints = 0;
  let sumTokens = 0;
  let sumCost = 0;
  let intervals = 0;

  for (const segment of segments) {
    if (!segment.points.length) continue;
    const first = segment.points[0];
    const final = segment.points[segment.points.length - 1];
    const maxPt = segment.points.reduce((best, p) => (p.used >= best.used ? p : best), final);
    const targetPt = final.used >= maxPt.used - 0.5 ? final : maxPt;
    if (targetPt.used <= 0) continue;

    const endBound = Math.min(segment.endAt, targetPt.at + 60_000, now);
    // 若窗口半途才开始采样（first.used >= 1.5），检查 first.at 之前是否有本机对话记录：
    // - 有本机记录：说明本机日志从窗口起点就有完整覆盖，分子用 [segment.startAt, endBound] 全部用量，分母用 targetPt.used；
    // - 无本机记录：说明采样前的消耗不在本机日志中，分子只取 [first.at, endBound] 用量，分母取采样区间增量 (targetPt.used - first.used)。
    const preRows =
      first.used >= 1.5 && first.at > segment.startAt
        ? groupRows.filter((r) => r.at >= segment.startAt && r.at < first.at)
        : [];
    const useDeltaOnly = first.used >= 1.5 && first.at > segment.startAt && preRows.length === 0;
    const usedPct = useDeltaOnly ? targetPt.used - first.used : targetPt.used;
    if (usedPct < MIN_CAPACITY_PCT) continue;

    const rowStart = useDeltaOnly ? first.at : segment.startAt;
    const cRows = groupRows.filter((r) => r.at >= rowStart && r.at <= endBound);
    const cSum = summarizeRows(cRows);
    if (cSum.tokens <= 0) continue;

    const fullTokens = Math.round((cSum.tokens / usedPct) * 100);
    const fullCostUsd = Math.round(((cSum.costUsd / usedPct) * 100) * 100) / 100;
    capacityHistory.push({
      at: targetPt.at,
      startAt: rowStart,
      endAt: segment.endAt,
      resetAt: segment.resetAt,
      usedPct: Math.round(usedPct * 10) / 10,
      tokens: cSum.tokens,
      costUsd: cSum.costUsd,
      fullTokens,
      fullCostUsd,
      ...(segment.startedByReset ? { startedByReset: segment.startedByReset } : {}),
      ...(segment.endedByReset ? { endedByReset: segment.endedByReset } : {}),
    });
    sumPoints += usedPct;
    sumTokens += cSum.tokens;
    sumCost += cSum.costUsd;
    intervals += 1;
  }

  let fullTokens: number | null = null;
  let fullCostUsd: number | null = null;
  let basis: AgyWindowCapacity["basis"] = null;
  let confidence: AgyWindowCapacity["confidence"] = "insufficient";

  if (sumPoints >= MIN_CAPACITY_PCT && sumTokens > 0) {
    fullTokens = Math.round((sumTokens / sumPoints) * 100);
    fullCostUsd = sumCost > 0 ? Math.round(((sumCost / sumPoints) * 100) * 100) / 100 : null;
    basis = intervals >= 2 && sumPoints >= 5 ? "measured" : "current";
    confidence = intervals >= 3 && sumPoints >= 15 ? "medium" : sumPoints >= 5 ? "low" : "current";
  } else if (!ended && used >= MIN_CAPACITY_PCT && local.tokens > 0) {
    fullTokens = Math.round((local.tokens / used) * 100);
    fullCostUsd = local.costUsd > 0 ? Math.round(((local.costUsd / used) * 100) * 100) / 100 : null;
    basis = "current";
    confidence = "current";
    sumPoints = used;
    intervals = 1;
  }

  const remainingShare = Math.max(0, 100 - used) / 100;
  const capacity: AgyWindowCapacity = {
    fullTokens,
    fullCostUsd,
    remainingTokens: fullTokens != null ? Math.round(fullTokens * remainingShare) : null,
    remainingCostUsd: fullCostUsd != null ? Math.round(fullCostUsd * remainingShare * 100) / 100 : null,
    basis,
    confidence,
    points: Math.round(sumPoints * 10) / 10,
    intervals,
  };

  return {
    insight: {
      window: windowKind,
      used,
      remaining,
      ...(quota.resetAt ? { resetAt: quota.resetAt } : {}),
      startAt,
      endAt,
      ended,
      ...(startedByReset ? { startedByReset } : {}),
      ratePerHour: ratePerHour != null ? Math.round(ratePerHour * 100) / 100 : null,
      recentRatePerHour: recentRatePerHour != null ? Math.round(recentRatePerHour * 100) / 100 : null,
      ratePerDay: ratePerHour != null ? Math.round(ratePerHour * 24 * 100) / 100 : null,
      projected: projected != null ? Math.round(projected * 10) / 10 : null,
      etaAt,
      local,
      capacity,
    },
    capacityHistory: capacityHistory.slice(-30),
  };
}

function buildModelCapacities(
  groupInsights: AgyGroupInsight[],
  lastModels: AgyModelQuotaItem[] | undefined,
  rows30: RequestRow[],
): AgyModelCapacityRow[] {
  type Candidate = { model: string; family: string; effort: string; group: AgyGroupInsight };
  const candidates = new Map<string, Candidate>();

  const defaultGroup = groupInsights[0];
  const findGroup = (family: string, model: string): AgyGroupInsight | undefined =>
    groupInsights.find((g) => groupMatchesModel(g, model) || groupMatchesModel(g, family)) ?? defaultGroup;

  for (const item of lastModels ?? []) {
    const effort = item.effort || "medium";
    const g = findGroup(item.family, item.model);
    if (!g) continue;
    const key = comboKey(item.model, effort);
    if (!candidates.has(key)) {
      candidates.set(key, { model: item.model, family: item.family, effort, group: g });
    }
  }

  for (const g of groupInsights) {
    for (const family of g.models) {
      const { model } = splitModelLabel(family);
      const hasAny = [...candidates.values()].some((c) => c.model === model);
      if (!hasAny) {
        const defaultEfforts = /gemini-4-argon/i.test(model)
          ? ["high", "low"]
          : /gemini.*flash/i.test(model)
            ? ["high", "medium"]
            : /claude/i.test(model)
              ? ["high", "low"]
              : ["medium"];
        for (const effort of defaultEfforts) {
          const key = comboKey(model, effort);
          if (!candidates.has(key)) candidates.set(key, { model, family, effort, group: g });
        }
      }
    }
  }

  for (const row of rows30) {
    const effort = row.effort && row.effort !== "unknown" ? row.effort : "medium";
    const key = comboKey(row.model, effort);
    if (!candidates.has(key)) {
      const g = findGroup(row.model, row.model);
      if (g) candidates.set(key, { model: row.model, family: row.model, effort, group: g });
    }
  }

  const out: AgyModelCapacityRow[] = [];
  for (const [key, cand] of candidates) {
    const modelRows = rows30.filter((r) => r.model === cand.model);
    const comboRows = modelRows.filter((r) => (r.effort || "medium") === cand.effort);
    const groupRows = rows30.filter((r) => groupMatchesModel(cand.group, r.model));

    const rule = priceOf(cand.model) as PriceRule | null;
    const listPrice = rule
      ? { input: rule.input, output: rule.output, cacheRead: rule.cacheRead, cacheWrite: rule.cacheWrite, note: rule.note || "" }
      : null;

    const basePool = modelRows.length >= 3 ? modelRows : groupRows.length >= 3 ? groupRows : [];
    const mixBasis: AgyModelCapacityRow["mixBasis"] = modelRows.length >= 3 ? "model" : groupRows.length >= 3 ? "group" : "default";
    const baseSummary = basePool.length ? summarizeRows(basePool) : { ...DEFAULT_MIX, tokens: DEFAULT_MIX.input + DEFAULT_MIX.output, reasoning: 0, costUsd: 0, requests: 22 };

    // 按思考档位缩放输出部分
    const anchorEffort = modelRows[0]?.effort && EFFORT_SCALE[modelRows[0].effort] ? modelRows[0].effort : "medium";
    const ratio = (EFFORT_SCALE[cand.effort] ?? 1) / (EFFORT_SCALE[anchorEffort] ?? 1);
    const scaledMix = {
      input: baseSummary.input,
      output: Math.round(baseSummary.output * ratio),
      cacheRead: baseSummary.cacheRead,
      cacheWrite: baseSummary.cacheWrite,
    };
    const scaledTotal = scaledMix.input + scaledMix.output;
    const costForMix = scaledTotal > 0 ? estimateCost(cand.model, scaledMix) : 0;
    const usdPerMTokens = costForMix > 0 && scaledTotal > 0 ? Math.round(((costForMix / scaledTotal) * 1e6) * 1000) / 1000 : null;

    const comboSum = summarizeRows(comboRows);
    const tokensPerCall = comboSum.requests >= 2
      ? Math.round(comboSum.tokens / comboSum.requests)
      : baseSummary.requests > 0
        ? Math.round(scaledTotal / baseSummary.requests)
        : 45_000;

    const fiveBudgetUsd = cand.group.five.capacity.fullCostUsd;
    const fiveDirectTokens = cand.group.five.capacity.fullTokens;
    const fiveTokens = fiveBudgetUsd != null && usdPerMTokens
      ? Math.round((fiveBudgetUsd / usdPerMTokens) * 1e6)
      : fiveDirectTokens != null && cand.model === modelRows[0]?.model
        ? Math.round(fiveDirectTokens / ratio)
        : null;
    const fiveCalls = fiveTokens != null && tokensPerCall > 0 ? Math.max(1, Math.round(fiveTokens / tokensPerCall)) : null;
    const fiveRemainingTokens = fiveTokens != null ? Math.round((fiveTokens * cand.group.five.remaining) / 100) : null;

    const weekCap = cand.group.week?.capacity;
    const weekBudgetUsd = weekCap?.fullCostUsd ?? null;
    const weekDirectTokens = weekCap?.fullTokens ?? null;
    const weekTokens = weekBudgetUsd != null && usdPerMTokens
      ? Math.round((weekBudgetUsd / usdPerMTokens) * 1e6)
      : weekDirectTokens != null && cand.model === modelRows[0]?.model
        ? Math.round(weekDirectTokens / ratio)
        : null;
    const weekCalls = weekTokens != null && tokensPerCall > 0 ? Math.max(1, Math.round(weekTokens / tokensPerCall)) : null;
    const weekRemainingTokens = weekTokens != null && cand.group.week ? Math.round((weekTokens * cand.group.week.remaining) / 100) : null;

    out.push({
      key,
      model: cand.model,
      family: cand.family,
      effort: cand.effort,
      groupKey: cand.group.key,
      groupTitle: cand.group.title,
      listPrice,
      usdPerMTokens,
      tokensPerCall,
      mixBasis,
      recentTokens: comboSum.tokens,
      recentCalls: comboSum.requests,
      recentCostUsd: comboSum.costUsd,
      fiveTokens,
      fiveCalls,
      fiveRemainingTokens,
      weekTokens,
      weekCalls,
      weekRemainingTokens,
      relative: null,
    });
  }

  const ref = [...out].filter((r) => r.usdPerMTokens && r.usdPerMTokens > 0).sort((a, b) => b.recentTokens - a.recentTokens || a.usdPerMTokens! - b.usdPerMTokens!)[0];
  if (ref?.usdPerMTokens) {
    for (const row of out) {
      if (row.usdPerMTokens && row.usdPerMTokens > 0) {
        row.relative = Math.round((ref.usdPerMTokens / row.usdPerMTokens) * 100) / 100;
      }
    }
  }

  return out;
}

type Cycle = { id: string; startAt: number; endAt: number; resetAt: number; used: number; sampleAt: number; active: boolean; resetCard: boolean };

function buildTimelineWindow(
  windowKind: "five" | "week",
  cycleId: string | undefined,
  last: AgyLast | undefined,
  history: AgySample[],
  rows: RequestRow[],
  now: number,
) {
  const periodMs = windowKind === "five" ? FIVE_MS : WEEK_MS;
  const cycles: Cycle[] = [];

  // 当前进行中的周期：优先按 agyWindowSegments 切出的实际窗口段（含提前重置分段）生成周期列表
  const primaryGroup =
    last?.groups?.find((g) => (windowKind === "five" ? g.used : (g.week?.used ?? g.used)) > 0) ?? last?.groups?.[0];
  const primaryQuota = primaryGroup
    ? windowKind === "five"
      ? { used: primaryGroup.used, resetAt: primaryGroup.resetAt }
      : primaryGroup.week ?? { used: primaryGroup.used, resetAt: primaryGroup.resetAt }
    : { used: 0 };
  const segments = primaryGroup ? agyWindowSegments(windowKind, primaryGroup.key, history, primaryQuota, now) : [];

  for (let idx = segments.length - 1; idx >= 0; idx--) {
    const seg = segments[idx];
    const start = Math.round(seg.startAt);
    const end = Math.round(seg.endAt);
    if (end <= now - KEEP_MS || end <= start) continue;
    const active = idx === segments.length - 1 && !seg.endedByReset && end > now;
    const lastPt = seg.points[seg.points.length - 1];
    const used = active
      ? Math.max(0, ...(last?.groups ?? []).map((g) => (windowKind === "five" ? g.used : (g.week?.used ?? g.used)) || 0))
      : lastPt?.used ?? 0;
    cycles.push({
      id: `${start}:${end}`,
      startAt: start,
      endAt: end,
      resetAt: Math.round(seg.resetAt),
      used,
      sampleAt: lastPt?.at ?? last?.at ?? now,
      active,
      resetCard: Boolean(seg.startedByReset || seg.endedByReset),
    });
  }

  const activeResetIso = windowKind === "five" ? primaryGroup?.resetAt : (primaryGroup?.week?.resetAt ?? primaryGroup?.resetAt);
  const activeResetMs = activeResetIso ? Date.parse(activeResetIso) || 0 : 0;
  const earliestStart = cycles.length ? cycles[cycles.length - 1].startAt : (activeResetMs > now ? activeResetMs : (windowKind === "five" ? Math.ceil(now / HOUR) * HOUR : shiftDay(startOfDay(now), 1)));

  for (let i = 0; i < 36; i++) {
    const end = Math.round(earliestStart - i * periodMs);
    const start = Math.round(end - periodMs);
    if (end <= now - KEEP_MS) break;
    if (cycles.some((c) => Math.abs(c.startAt - start) < SAME_WINDOW_MS || (start < c.endAt && end > c.startAt + SAME_WINDOW_MS))) continue;
    const active = cycles.length === 0 && i === 0 && now >= start && now <= end;
    const hasRows = rows.some((r) => r.at >= start && r.at < end);
    const hasSamples = history.some((s) => s.at >= start && s.at <= end);
    if (!active && !hasRows && !hasSamples) continue;
    const used = active
      ? Math.max(0, ...(last?.groups ?? []).map((g) => (windowKind === "five" ? g.used : (g.week?.used ?? g.used)) || 0))
      : 0;
    cycles.push({
      id: `${start}:${end}`,
      startAt: start,
      endAt: end,
      resetAt: end,
      used,
      sampleAt: last?.at ?? now,
      active,
      resetCard: false,
    });
  }

  const selected = (cycleId ? cycles.find((c) => c.id === cycleId) : null) ?? cycles[0] ?? null;
  const observed = selected ? rows.filter((r) => r.at >= selected.startAt && r.at < selected.endAt && r.at <= now) : [];
  const binMs = 60_000;
  const bins = new Map<string, { key: string; model: string; effort: string; startAt: number; endAt: number; firstAt: number; lastAt: number; count: number; calls: number; tokens: number; costUsd: number | null }>();
  for (const row of observed) {
    const effort = row.effort || "unknown";
    const key = comboKey(row.model, effort);
    const start = selected!.startAt + Math.floor((row.at - selected!.startAt) / binMs) * binMs;
    const id = `${key}|${start}`;
    const bin = bins.get(id) ?? {
      key,
      model: row.model,
      effort,
      startAt: start,
      endAt: Math.min(start + binMs, selected!.endAt),
      firstAt: row.at,
      lastAt: row.at,
      count: 0,
      calls: 0,
      tokens: 0,
      costUsd: 0,
    };
    bin.firstAt = Math.min(bin.firstAt, row.at);
    bin.lastAt = Math.max(bin.lastAt, row.at);
    bin.count += 1;
    bin.calls += row.calls || 1;
    bin.tokens += row.tokens;
    bin.costUsd = (bin.costUsd ?? 0) + (row.costUsd || 0);
    bins.set(id, bin);
  }

  const pickPct = (s: AgySample) => {
    const vals = s.groups.map((g) => (windowKind === "five" ? g.used : (g.weekUsed ?? g.used))).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return vals.length ? Math.max(...vals) : null;
  };
  const track: { at: number; pct: number }[] = [];
  if (selected) {
    for (const s of history) {
      if (s.at > selected.endAt) break;
      const pct = pickPct(s);
      if (pct == null) continue;
      if (s.at < selected.startAt) {
        track.length = 0;
        track.push({ at: s.at, pct });
        continue;
      }
      track.push({ at: s.at, pct });
    }
    if (selected.active && last?.groups?.length) {
      const currentPct = Math.max(0, ...last.groups.map((g) => (windowKind === "five" ? g.used : (g.week?.used ?? g.used)) || 0));
      if (!track.length || track[track.length - 1].at < (last.at || now)) {
        track.push({ at: last.at || now, pct: currentPct });
      }
    }
  }

  const unknown = (r: RequestRow) => !r.effort || r.effort === "unknown";
  return {
    query: { kind: "antigravity", accountId: "antigravity", window: windowKind, cycle: cycleId },
    brand: "antigravity",
    source: "Antigravity",
    now,
    cycles,
    selected,
    quotaStale: false,
    timeline: [...bins.values()].sort((a, b) => a.startAt - b.startAt),
    binMs,
    track,
    curve: { label: windowKind === "five" ? "5 小时额度已用（最高组）" : "周额度已用（最高组）" },
    attribution: { intervals: [] as never[] },
    offMachine: { points: 0, markedPoints: 0, detected: [] as never[], marks: [] as never[] },
    totals: {
      tokens: observed.reduce((s, r) => s + r.tokens, 0),
      calls: observed.reduce((s, r) => s + (r.calls || 1), 0),
      records: observed.length,
      unknownEffort: observed.filter(unknown).length,
    },
  };
}

export class AntigravityQuota {
  private stored: Stored;
  private loading = false;
  private running = false;
  private pending?: Promise<AgyQuotaState>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private readonly file = dataFile("antigravity-quota.json");
  private readonly fetcher: () => Promise<AgyStatus | null>;
  private readonly now: () => number;
  private rowCache?: { rollupMtime: number; at: number; rows: RequestRow[] };
  private insightCache?: { stamp: string; at: number; insight: AgyInsight };

  constructor(private options: {
    publish?: (state: AgyQuotaState) => void;
    /** 一组额度过了提醒线（百分比）：title 用的型号名、已用、重置时间。 */
    notify?: (models: string[], used: number, resetAt?: string) => void;
    notifyAt?: () => number;
    fetcher?: () => Promise<AgyStatus | null>;
    now?: () => number;
  } = {}) {
    this.fetcher = options.fetcher ?? fetchAntigravityStatus;
    this.now = options.now ?? Date.now;
    const raw = readJson<Partial<Stored> | null>(this.file, null);
    this.stored = sanitizeStored(raw);
    this.running = Boolean(antigravityHub());
  }

  installed() {
    return antigravityDirs().some((dir) => fs.existsSync(dir)) || Boolean(this.stored.last);
  }

  private recentRows(now = this.now()): RequestRow[] {
    let rollupMtime = 0;
    try {
      rollupMtime = fs.statSync(dataFile("usage-rollups.json")).mtimeMs;
    } catch { /* 还没生成账本 */ }
    if (this.rowCache && this.rowCache.rollupMtime === rollupMtime && now - this.rowCache.at < 15_000) {
      return this.rowCache.rows;
    }
    const since = now - KEEP_MS;
    try {
      const res = queryRequests({
        from: dayStr(since),
        to: dayStr(now),
        since,
        until: now + 60_000,
        source: "Antigravity",
        status: "all",
        search: "",
        sort: "time",
        page: 0,
        pageSize: 1,
        all: true,
      });
      const rows = [...res.rows].sort((a, b) => a.at - b.at);
      this.rowCache = { rollupMtime, at: now, rows };
      return rows;
    } catch {
      return [];
    }
  }

  private buildInsight(now = this.now()): AgyInsight {
    let rollupMtime = 0;
    try {
      rollupMtime = fs.statSync(dataFile("usage-rollups.json")).mtimeMs;
    } catch { /* 还没生成账本 */ }
    const stamp = `${rollupMtime}|${this.stored.last?.at ?? 0}|${this.stored.history.length}|${(this.stored.last?.groups ?? []).map((g) => `${g.key}:${g.used}:${g.week?.used ?? ""}`).join(",")}`;
    if (this.insightCache && this.insightCache.stamp === stamp && now >= this.insightCache.at && now - this.insightCache.at < 15_000) {
      return this.insightCache.insight;
    }
    const rows30 = this.recentRows(now);
    const todayStart = startOfDay(now);
    const d7Start = now - 7 * DAY;
    const rowsToday = rows30.filter((r) => r.at >= todayStart);
    const rows7 = rows30.filter((r) => r.at >= d7Start);

    // 24 小时分桶
    const thisHour = Math.floor(now / HOUR) * HOUR;
    const hourly = Array.from({ length: 24 }, (_, i) => {
      const hour = thisHour - (23 - i) * HOUR;
      const list = rows30.filter((r) => r.at >= hour && r.at < hour + HOUR);
      const byModel: Record<string, number> = {};
      let tokens = 0, costUsd = 0;
      for (const r of list) {
        tokens += r.tokens || 0;
        costUsd += r.costUsd || 0;
        byModel[r.model] = (byModel[r.model] || 0) + (r.tokens || 0);
      }
      return { hour, tokens, costUsd: Math.round(costUsd * 10000) / 10000, requests: list.length, byModel };
    });

    // 本机按模型汇总（最近 7 天为主，若 7 天为空则用 30 天）
    const activeRows = rows7.length ? rows7 : rows30;
    const byModelMap = new Map<string, RequestRow[]>();
    for (const r of activeRows) {
      const list = byModelMap.get(r.model) ?? [];
      list.push(r);
      byModelMap.set(r.model, list);
    }
    const models = [...byModelMap.entries()]
      .map(([model, list]) => {
        const sum = summarizeRows(list);
        const speeds = list.map((r) => r.timing?.tokensPerSec || r.estimate?.tokensPerSec || 0).filter((v) => v > 0);
        const firsts = list.map((r) => r.timing?.firstTokenMs || 0).filter((v) => v > 0);
        const avgSpeed = speeds.length ? Math.round((speeds.reduce((a, b) => a + b, 0) / speeds.length) * 10) / 10 : null;
        const avgFirstMs = firsts.length ? Math.round(firsts.reduce((a, b) => a + b, 0) / firsts.length) : null;
        const lastEffort = [...list].reverse().find((r) => r.effort && r.effort !== "unknown")?.effort;
        return {
          model,
          ...(lastEffort ? { effort: lastEffort } : {}),
          ...sum,
          avgSpeed,
          avgFirstMs,
          lastAt: list[list.length - 1]?.at ?? 0,
        };
      })
      .sort((a, b) => b.tokens - a.tokens || b.lastAt - a.lastAt);

    // 核验汇总 + 最近 25 条请求
    const verifySummary = { match: 0, mismatch: 0, suspect: 0, unverified: 0, total: rows30.length };
    for (const r of rows30) {
      const st = r.status;
      if (st === "match") verifySummary.match++;
      else if (st === "mismatch") verifySummary.mismatch++;
      else if (st === "suspect") verifySummary.suspect++;
      else verifySummary.unverified++;
    }
    const recentRequests: AgyRecentRequest[] = rows30
      .slice(-25)
      .reverse()
      .map((r) => ({
        id: r.key,
        at: r.at,
        model: r.model,
        ...(r.effort ? { effort: r.effort } : {}),
        ...(r.requested ? { requested: r.requested } : {}),
        ...(r.returned ? { returned: r.returned } : {}),
        tokens: r.tokens,
        input: r.input,
        output: r.output,
        cacheRead: r.cacheRead,
        cacheWrite: r.cacheWrite || 0,
        reasoning: r.reasoning,
        costUsd: r.costUsd,
        priced: r.priced,
        ...(r.cwd ? { cwd: r.cwd } : {}),
        verify: { status: r.status, label: r.statusLabel, reasons: r.reasons, channel: r.channel },
        ...(r.timing ? { timing: r.timing } : {}),
        ...(r.estimate ? { estimate: r.estimate } : {}),
      }));

    // 各组双窗口分析
    const lastGroups = this.stored.last?.groups ?? [];
    const lastModels = this.stored.last?.models ?? [];
    const groups: AgyGroupInsight[] = lastGroups.map((group) => {
      const gRows = rows30.filter((r) => groupMatchesModel(group, r.model));
      const fiveRes = buildWindowInsight("five", { used: group.used, resetAt: group.resetAt }, group.key, this.stored.history, gRows, now);
      const weekQuota = group.week ?? (() => {
        // 如果历史采样里记过周额度，也兜底读出来
        const latestWeek = [...this.stored.history].reverse().flatMap((s) => s.groups).find((g) => g.key === group.key && g.weekUsed != null);
        return latestWeek ? { used: latestWeek.weekUsed!, resetAt: latestWeek.weekResetAt } : undefined;
      })();
      const weekRes = weekQuota ? buildWindowInsight("week", weekQuota, group.key, this.stored.history, gRows, now) : null;

      const rawItems = lastModels.filter((m) => group.models.includes(m.family));
      const itemSource: AgyModelQuotaItem[] = rawItems.length
        ? rawItems
        : group.models.map((family) => {
            const { model, effort } = splitModelLabel(family);
            return {
              label: family,
              family,
              model,
              ...(effort ? { effort } : {}),
              used: group.used,
              resetAt: group.resetAt,
              ...(weekQuota ? { weekUsed: weekQuota.used, weekResetAt: weekQuota.resetAt } : {}),
            };
          });

      const items: AgyGroupModelItem[] = itemSource.map((item) => {
        const matchRow = (r: RequestRow) =>
          r.model === item.model && (!item.effort || !r.effort || r.effort === "unknown" || r.effort === item.effort);
        const itemRows30 = gRows.filter(matchRow);
        const itemRows7 = itemRows30.filter((r) => r.at >= d7Start);
        const wUsed = item.weekUsed ?? weekQuota?.used;
        return {
          label: item.label,
          family: item.family,
          model: item.model,
          ...(item.effort ? { effort: item.effort } : {}),
          used: item.used,
          remaining: Math.max(0, Math.round((100 - item.used) * 10) / 10),
          ...(item.resetAt ? { resetAt: item.resetAt } : {}),
          ...(wUsed != null ? { weekUsed: wUsed, weekRemaining: Math.max(0, Math.round((100 - wUsed) * 10) / 10) } : {}),
          ...(item.weekResetAt || weekQuota?.resetAt ? { weekResetAt: item.weekResetAt ?? weekQuota?.resetAt } : {}),
          d7: summarizeRows(itemRows7),
          d30: summarizeRows(itemRows30),
        };
      });

      const defaultTitle = group.models.some((m) => /gemini/i.test(m)) ? "Gemini Models" : "Claude and GPT models";
      return {
        key: group.key,
        title: group.title || defaultTitle,
        models: group.models,
        five: fiveRes.insight,
        week: weekRes ? weekRes.insight : null,
        items,
        capacityHistory: {
          five: fiveRes.capacityHistory,
          week: weekRes ? weekRes.capacityHistory : [],
        },
      };
    });

    const kb = loadKnowledge();
    const modelCapacities = buildModelCapacities(groups, lastModels, rows30);

    const insight: AgyInsight = {
      now,
      conversations: antigravityConversationFiles().length,
      sampleCount: this.stored.history.length,
      groups,
      localUsage: {
        today: summarizeRows(rowsToday),
        d7: summarizeRows(rows7),
        d30: summarizeRows(rows30),
        lastAt: rows30.at(-1)?.at ?? null,
        hourly,
        models,
        recentRequests,
        verifySummary,
      },
      modelCapacities,
      priceSource: { version: kb.knowledge.version, updatedAt: kb.knowledge.updatedAt },
    };
    this.insightCache = { stamp, at: now, insight };
    return insight;
  }

  state(): AgyQuotaState {
    const now = this.now();
    const since = now - SHOW_MS;
    const insight = this.buildInsight(now);
    return {
      installed: this.installed(),
      running: this.running,
      loading: this.loading,
      conversations: insight.conversations,
      ...(this.stored.last ? { last: this.stored.last } : {}),
      history: this.stored.history.filter((sample) => sample.at >= since),
      insight,
    };
  }

  timeline(query?: unknown) {
    const now = this.now();
    const q = (query && typeof query === "object" ? query : {}) as { cycles?: { five?: unknown; week?: unknown } };
    const cycle = (v: unknown) => (typeof v === "string" && /^\d{1,16}:\d{1,16}$/.test(v) ? v : undefined);
    const rows = this.recentRows(now);
    return {
      kind: "antigravity",
      accountId: "antigravity",
      labels: { five: "5 小时", week: "周额度" },
      five: buildTimelineWindow("five", cycle(q.cycles?.five), this.stored.last, this.stored.history, rows, now),
      week: buildTimelineWindow("week", cycle(q.cycles?.week), this.stored.last, this.stored.history, rows, now),
    };
  }

  speed(days: number): SpeedSeries {
    const now = this.now();
    const since = days > 0 ? now - days * DAY : 0;
    const rows = days <= 30 ? this.recentRows(now) : (() => {
      try {
        return queryRequests({
          from: dayStr(since || now - 365 * DAY),
          to: dayStr(now),
          since,
          until: now + 60_000,
          source: "Antigravity",
          status: "all",
          search: "",
          sort: "time",
          page: 0,
          pageSize: 1,
          all: true,
        }).rows;
      } catch { return this.recentRows(now); }
    })();
    const measured = rows
      .filter((row) => row.at >= since && row.at <= now && ((row.timing && (row.timing.tokensPerSec || row.timing.firstTokenMs)) || row.estimate?.tokensPerSec))
      .map((row) => {
        const hasTiming = Boolean(row.timing && (row.timing.tokensPerSec || row.timing.firstTokenMs));
        return {
          at: row.at,
          model: row.model,
          fast: false,
          speed: (hasTiming ? row.timing!.tokensPerSec : row.estimate?.tokensPerSec) || 0,
          first: (hasTiming ? row.timing!.firstTokenMs : 0) || 0,
          output: row.output,
          ...(hasTiming ? {} : { estimated: true }),
        };
      });
    return speedSeriesOf(measured, since, now);
  }

  start() { this.stopped = false; }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  reschedule(everyMs: number) {
    if (this.timer) clearInterval(this.timer);
    const ms = Math.max(30_000, everyMs);
    this.timer = setInterval(() => { void this.refresh(false); }, ms);
    this.timer.unref?.();
  }

  private publish() { if (!this.stopped) this.options.publish?.(this.state()); }
  private save() { try { writeJson(this.file, this.stored); } catch { /* 存不下来：这次的结果还在内存里 */ } }

  /** 查一次。同时只跑一个；没装 Antigravity 的不查。manual：用户点了刷新，查不到也要把原因告诉界面。 */
  refresh(manual: boolean): Promise<AgyQuotaState> {
    if (this.pending) return this.pending;
    if (!manual && !antigravityDirs().some((dir) => fs.existsSync(dir))) return Promise.resolve(this.state());
    this.pending = this.refreshNow(manual).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async refreshNow(manual: boolean): Promise<AgyQuotaState> {
    this.loading = true;
    if (manual) this.publish();
    const at = this.now();
    let nextState!: AgyQuotaState;
    try {
      const status = await this.fetcher();
      this.running = Boolean(status);
      if (!status) {
        // Antigravity 没开：留着上一次的数，只在手动刷新时记一条「没开」
        if (manual) this.stored.last = { ...(this.stored.last ?? { groups: [] }), at: this.stored.last?.at ?? at, ok: this.stored.last?.ok ?? false, error: "Antigravity 没有在运行，打开它之后才能查到额度" };
      } else {
        const groups = status.groups.map((group) => ({ ...group, key: groupKey(group.models) }));
        this.stored.last = {
          at,
          ok: true,
          plan: status.plan || undefined,
          tier: status.tier,
          groups,
          ...(status.models?.length ? { models: status.models } : {}),
          ...(status.credits ? { credits: status.credits } : {}),
        };
        this.record(at, groups);
        this.check(groups);
      }
    } catch (error) {
      this.running = Boolean(antigravityHub());
      log.warn("antigravity", "额度查询失败：" + errorText(error));
      this.stored.last = { ...(this.stored.last ?? { groups: [] }), at: this.stored.last?.ok ? this.stored.last.at : at, ok: false, error: error instanceof Error ? error.message : "查询失败" };
    } finally {
      this.loading = false;
      this.save();
      nextState = this.state();
      if (!this.stopped) this.options.publish?.(nextState);
    }
    // 在 finally 之后取状态：界面拿这个返回值覆盖自己的，不能还带着「正在查询」
    return nextState;
  }

  /** 记一条采样：和上一条不一样、或者隔了 10 分钟以上才记。 */
  private record(at: number, groups: AgyGroupState[]) {
    const sample: AgySample = {
      at,
      groups: groups.map((group) => ({
        key: group.key,
        used: group.used,
        ...(group.resetAt ? { resetAt: group.resetAt } : {}),
        ...(group.week ? {
          weekUsed: group.week.used,
          ...(group.week.resetAt ? { weekResetAt: group.week.resetAt } : {}),
        } : {}),
      })),
    };
    const previous = this.stored.history.at(-1);
    const same = previous && JSON.stringify(previous.groups.map((g) => [g.key, g.used, g.weekUsed ?? null])) === JSON.stringify(sample.groups.map((g) => [g.key, g.used, g.weekUsed ?? null]));
    if (same && at - previous.at < SAMPLE_EVERY_MS) return;
    this.stored.history.push(sample);
    const since = at - KEEP_MS;
    this.stored.history = this.stored.history.filter((item) => item.at >= since).slice(-5000);
  }

  /** 一组过了提醒线：每个窗口提醒一次（含 5 小时窗口和周窗口）。 */
  private check(groups: AgyGroupState[]) {
    const limit = this.options.notifyAt?.() ?? 0;
    if (!limit) return;
    for (const group of groups) {
      if (group.used >= limit) {
        const resetAt = group.resetAt ? Date.parse(group.resetAt) || 0 : 0;
        const previous = this.stored.notified[group.key];
        if (previous == null || Math.abs(resetAt - previous) >= SAME_WINDOW_MS) {
          this.stored.notified[group.key] = resetAt;
          this.options.notify?.(group.models, group.used, group.resetAt);
        }
      }
      if (group.week && group.week.used >= limit) {
        const weekKey = `${group.key}:week`;
        const resetAt = group.week.resetAt ? Date.parse(group.week.resetAt) || 0 : 0;
        const previous = this.stored.notified[weekKey];
        if (previous == null || Math.abs(resetAt - previous) >= SAME_WINDOW_MS) {
          this.stored.notified[weekKey] = resetAt;
          this.options.notify?.(group.models, group.week.used, group.week.resetAt);
        }
      }
    }
  }
}

/** 测试用：存盘的位置。 */
export const antigravityQuotaFile = () => path.join(dataFile("antigravity-quota.json"));
