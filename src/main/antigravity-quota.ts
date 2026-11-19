import fs from "fs";
import path from "path";
import {
  antigravityConversationFiles,
  antigravityDirs,
  antigravityHub,
  fetchAntigravityLocalSession,
  fetchAntigravityStatus,
  modelFamily,
  splitModelLabel,
  type AgyCredits,
  type AgyModelQuotaItem,
  type AgyQuotaGroup,
  type AgyStatus,
  type AgyWindowQuota,
} from "../core/antigravity";
import {
  agyAccountIdOf,
  agyDisplayNames,
  agyRefFromIdentity,
  fetchAntigravityCloudStatus,
  normalizeAgyEmail,
  normalizeShareMode,
  readAgyAccountStore,
  readAgyLoginTimeline,
  recordAgyLocalLogin,
  rememberAgyAccount,
  renewAgyCredentials,
  resolveAgyLocalOwner,
  updateAgyProjectId,
  visibleAgyAccounts,
  type AgyNetDeps,
  type AgyShareMode,
  type StoredAgyAccount,
} from "../core/antigravity-accounts";
import { errorText, log } from "../core/app-log";
import { isExpired } from "../core/credentials";
import { loadKnowledge, type PriceRule } from "../core/knowledge";
import { comboKey } from "../core/model-catalog";
import { estimateCost, priceOf } from "../core/model-pricing";
import { speedSeriesOf, type SpeedSeries } from "../core/pass-speed";
import { dataFile, readJson, writeJson } from "../core/paths";
import type { PetAccount, PetQuotaWindow } from "../core/desk-pet-model";
import { pressureRule, readPressurePrefs, type PressurePrefs, type PressureRule } from "../core/quota-pressure";
import { queryRequests, type RequestRow } from "../core/request-log";

/**
 * Google Antigravity 的多账号额度监控、家庭组共享额度归因与深度防偏移分析。
 *
 * 支持两种来源协同工作：
 * 1. TokenPulse 独立登录的多个 Google OAuth 账号（`antigravity-accounts.json`）：
 *    自动续期并直连 Google Cloud Code 接口（`loadCodeAssist` / `fetchAvailableModels` / `retrieveUserQuotaSummary`），
 *    即使本机 Antigravity 客户端未打开也能定时查询各账号的 5 小时与周额度；
 * 2. 本机运行中的 Antigravity language server（`GetUserStatus` + `RetrieveUserQuotaSummary`）：
 *    零配置单账号兼容，或为「仅登记本机登录」的账号提供实时数据，并记录本机账号切换时间线。
 *
 * 针对 Google One 家庭组共享额度导致的估算偏移，内置四重防偏移机制：
 * - 区间级干净归因（`cleanAgyWindow`）：剥离本机无请求时段由家庭成员或其他设备产生的额度上涨（`offPoints`）；
 * - 同期多人并发防偏移滤波（`coUsedPoints`）：当同一采样区间内本机与家庭成员同时使用、导致单点表观容量异常坍缩时，
 *   按近期独享基准剥离并发外部涨幅，防止整窗容量与模型换算被拉低数倍；
 * - 多账号同家庭组共享池自动指纹识别（`detectFamilyLinks`）：识别同秒级重置时间与同步消耗比例的账号，
 *   避免多账号余量重复计池，并自动合并本机同家庭组成员的对话记录参与同一共享池校准；
 * - 双速率用尽预测：拆分「本机消耗速率」与「家庭组/他端速率」，外部突发停止后不再按峰值线性误报耗尽时间。
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

export type AgyOffInterval = {
  from: number;
  to: number;
  points: number;
  kind: "off" | "co-used";
};

export type AgySharedBreakdown = {
  mode: AgyShareMode;
  familyShared: boolean;
  familyPeers: string[];
  localUsedPct: number;
  externalUsedPct: number;
  offPoints: number;
  coUsedPoints: number;
  localRatePerHour: number | null;
  externalRatePerHour: number | null;
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
  shared: AgySharedBreakdown;
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
  /** 剔除前的窗口总涨幅（用于浮层对比说明）。 */
  rawUsedPct?: number;
  /** 该窗口内被剔除的家庭组 / 其他设备涨幅（offPoints + coUsedPoints）。 */
  excludedPct?: number;
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

export type AgyAccountQuotaState = {
  id: string;
  displayName: string;
  accountHint: string;
  inLocal: boolean;
  /** 已保存独立 OAuth 凭据（关掉 Antigravity 客户端也能直连查询）。 */
  cloudAuth: boolean;
  usable: boolean;
  autoRenew: boolean;
  waitLocal: boolean;
  needsLogin: boolean;
  shareMode: AgyShareMode;
  familyGroupId?: string;
  familyShared: boolean;
  familyPeers: string[];
  loading: boolean;
  last?: AgyLast;
  history: AgySample[];
  insight?: AgyInsight;
};

export type AgyQuotaState = {
  /** 本机装了 Antigravity 或已登录 Antigravity 账号。 */
  installed: boolean;
  /** 上一次查的时候本机 Antigravity 开着。 */
  running: boolean;
  loading: boolean;
  conversations?: number;
  /** 兼容单账号结构：指向当前排在首位（或唯一）的账号状态。 */
  last?: AgyLast;
  history: AgySample[];
  insight?: AgyInsight;
  /** 已登记的可见账号数量（0 表示传统零配置本机单槽模式）。 */
  registeredCount: number;
  multiAccount: boolean;
  accounts: AgyAccountQuotaState[];
};

type AccountSlot = { last?: AgyLast; history: AgySample[]; notified: Record<string, number> };
type Stored = AccountSlot & { accounts?: Record<string, AccountSlot> };

const HOUR = 3_600_000;
const DAY = 86_400_000;
const FIVE_MS = 5 * HOUR;
const WEEK_MS = 7 * DAY;
const KEEP_MS = 30 * DAY;
const SHOW_MS = 7 * DAY;
const SAMPLE_EVERY_MS = 10 * 60_000;
const SAME_WINDOW_MS = 15 * 60_000;
const LAG_MS = 5 * 60_000;
/** 连续两次采样超过 6 小时且期间涨了点：视作长离线缺口，不冒充精确单段，但也不误标成家庭组。 */
const MAX_INTERVAL_GAP_MS = 6 * HOUR;

const DEFAULT_MIX = { input: 1_000_000, cacheRead: 850_000, cacheWrite: 0, output: 30_000 };
const EFFORT_SCALE: Record<string, number> = { minimal: 0.45, low: 0.62, medium: 1, high: 1.55, xhigh: 2.4, max: 3.6 };

export const groupKey = (models: string[]) => [...models].sort().join("|");

export function quotaPoolId(modelsOrKey: string[] | string, title?: string): string {
  const text = Array.isArray(modelsOrKey) ? modelsOrKey.join("|") : String(modelsOrKey || "");
  const hasGemini = /gemini|orchestrator/i.test(text) || /gemini/i.test(title || "");
  const has3p = /claude|gpt|openai|anthropic/i.test(text) || /claude|gpt|3p/i.test(title || "");
  if (hasGemini && !has3p) return "pool:gemini";
  if (has3p && !hasGemini) return "pool:3p";
  return Array.isArray(modelsOrKey) ? groupKey(modelsOrKey) : text;
}

export function pickPoolSampleGroup(
  groups: AgySampleGroup[],
  targetKey: string,
  targetTitle?: string,
): AgySampleGroup | null {
  if (!Array.isArray(groups) || !groups.length) return null;
  const exact = groups.find((g) => g.key === targetKey);
  if (exact) return exact;
  const pool = quotaPoolId(targetKey, targetTitle);
  const matches = groups.filter((g) => quotaPoolId(g.key) === pool);
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  return [...matches].sort(
    (a, b) => Number(b.weekUsed != null) - Number(a.weekUsed != null) || b.key.length - a.key.length,
  )[0];
}

function isMixedPoolModels(modelsOrKey: string[] | string): boolean {
  const text = Array.isArray(modelsOrKey) ? modelsOrKey.join("|") : String(modelsOrKey || "");
  return /gemini|orchestrator/i.test(text) && /claude|gpt/i.test(text);
}

function cleanMixedGroup(g: AgyGroupState): AgyGroupState | null {
  if (!isMixedPoolModels(g.models)) return g;
  const title = g.title || "";
  if (/claude|gpt|3p|anthropic|openai/i.test(title) && !/gemini/i.test(title)) {
    const models = g.models.filter((m) => /claude|gpt|anthropic|openai/i.test(m));
    if (models.length) return { ...g, models, key: groupKey(models) };
  }
  if (/gemini|orchestrator/i.test(title) && !/claude|gpt/i.test(title)) {
    const models = g.models.filter((m) => /gemini|orchestrator/i.test(m));
    if (models.length) return { ...g, models, key: groupKey(models) };
  }
  return null;
}

function sanitizeSlotHistoryAndNotified(raw: Partial<AccountSlot> | null | undefined): AccountSlot {
  const history = (Array.isArray(raw?.history) ? raw!.history : [])
    .map((sample) => ({
      ...sample,
      groups: Array.isArray(sample.groups) ? sample.groups.filter((g) => !isMixedPoolModels(g.key)) : [],
    }))
    .filter((sample) => sample.groups.length > 0);
  const rawNotified = raw?.notified && typeof raw.notified === "object" ? raw.notified : {};
  const notified: Record<string, number> = {};
  for (const [k, v] of Object.entries(rawNotified)) {
    if (!isMixedPoolModels(k)) notified[k] = v;
  }
  return { ...(raw?.last ? { last: raw.last } : {}), history, notified };
}

function sanitizeSlotLast(slot: AccountSlot): AccountSlot {
  const rawLast = slot.last;
  if (!rawLast || !Array.isArray(rawLast.groups)) return slot;
  if (!rawLast.groups.some((g) => isMixedPoolModels(g.models))) return slot;
  const cleanGroups = rawLast.groups
    .map((g) => cleanMixedGroup(g))
    .filter((g): g is AgyGroupState => Boolean(g));
  if (cleanGroups.length) {
    return { ...slot, last: { ...rawLast, groups: cleanGroups } };
  }
  if (slot.history.length) {
    const prev = slot.history[slot.history.length - 1];
    return {
      ...slot,
      last: {
        ...rawLast,
        groups: prev.groups.map((g) => ({
          key: g.key,
          models: g.key.split("|").filter(Boolean),
          used: g.used,
          ...(g.resetAt ? { resetAt: g.resetAt } : {}),
          ...(g.weekUsed != null ? { week: { used: g.weekUsed, ...(g.weekResetAt ? { resetAt: g.weekResetAt } : {}) } } : {}),
        })),
      },
    };
  }
  // 即使分组暂时缺失也保留 tier / plan / at，避免升级或重开后套餐信息与账号状态一同清空
  return {
    ...slot,
    last: {
      ...rawLast,
      ok: false,
      groups: [],
      error: rawLast.error || "等待重新拉取分组额度",
    },
  };
}

function mergeSampleLists(lists: AgySample[][]): AgySample[] {
  const byAt = new Map<number, AgySample>();
  for (const list of lists) {
    for (const s of list) {
      if (s && Number.isFinite(s.at) && Array.isArray(s.groups) && s.groups.length) {
        byAt.set(s.at, s);
      }
    }
  }
  return [...byAt.values()].sort((a, b) => a.at - b.at).slice(-5000);
}

function reconcileLegacyHistory(base: AccountSlot, accounts: Record<string, AccountSlot>): void {
  const store = readAgyAccountStore();
  if (!store.accounts.length) return;
  const spans = readAgyLoginTimeline();
  const ownerId = spans[0]?.id;
  if (!ownerId || !accounts[ownerId]) return;

  const accById = new Map(store.accounts.map((a) => [a.id, a]));
  const earliestCreated = Math.min(...store.accounts.map((a) => a.createdAt || Infinity));
  if (!Number.isFinite(earliestCreated)) return;

  const ownerSlot = accounts[ownerId];
  const ownerHasPreHistory = ownerSlot.history.some((s) => s.at < earliestCreated - 60_000);
  if (ownerHasPreHistory) return;

  const rescued: AgySample[] = [];
  let movedFromAny = false;
  for (const [id, slot] of Object.entries(accounts)) {
    if (id === ownerId) continue;
    const acc = accById.get(id);
    if (!acc?.createdAt) continue;
    const cutoff = acc.createdAt - 60_000;
    const pre = slot.history.filter((s) => s.at < cutoff);
    if (!pre.length) continue;
    movedFromAny = true;
    rescued.push(...pre);
    slot.history = slot.history.filter((s) => s.at >= cutoff);
    if (slot.last && slot.last.at < cutoff) {
      slot.last = { ...slot.last, ok: false, groups: [], error: slot.last.error || "等待刷新该账号最新额度" };
    }
  }

  const basePre = base.history.filter((s) => s.at < earliestCreated - 60_000);
  if (!movedFromAny && !basePre.length) return;
  rescued.push(...basePre);
  ownerSlot.history = mergeSampleLists([rescued, ownerSlot.history]);
}

function sanitizeStored(raw: Partial<Stored> | null): Stored {
  const base = sanitizeSlotHistoryAndNotified(raw);
  const accounts: Record<string, AccountSlot> = {};
  if (raw?.accounts && typeof raw.accounts === "object") {
    for (const [id, slot] of Object.entries(raw.accounts)) {
      if (typeof id === "string" && id.startsWith("antigravity:")) {
        accounts[id] = sanitizeSlotHistoryAndNotified(slot);
      }
    }
  }
  if (Object.keys(accounts).length) {
    reconcileLegacyHistory(base, accounts);
    for (const [id, slot] of Object.entries(accounts)) {
      accounts[id] = sanitizeSlotLast(slot);
    }
  }
  const cleanBase = sanitizeSlotLast(base);
  return { ...cleanBase, ...(Object.keys(accounts).length ? { accounts } : {}) };
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

function rowEffectiveCost(r: RequestRow): number {
  if (r.costUsd && r.costUsd > 0) return r.costUsd;
  return estimateCost(r.model, {
    input: r.input || 0,
    output: r.output || 0,
    cacheRead: r.cacheRead || 0,
    cacheWrite: r.cacheWrite || 0,
  });
}

function groupMatchesModel(group: { models: string[]; title?: string }, model: string): boolean {
  const norm = model.toLowerCase().trim();
  for (const family of group.models) {
    const id = splitModelLabel(family).model;
    if (norm === id || norm.startsWith(id + "-")) return true;
  }
  const isGeminiGroup = group.models.some((m) => /gemini|orchestrator/i.test(m)) || /gemini/i.test(group.title || "");
  if (isGeminiGroup && /gemini|orchestrator/i.test(norm)) return true;
  const is3pGroup = group.models.some((m) => /claude|gpt/i.test(m)) || /claude|gpt|3p/i.test(group.title || "");
  if (is3pGroup && /claude|gpt|o[134]/i.test(norm)) return true;
  return false;
}

const MIN_CAPACITY_PCT = 2;
const RECENT_CAPACITY_FIVE = 6;
const RECENT_CAPACITY_WEEK = 3;

export function weightedMedian(pairs: [number, number][]): number {
  const list = pairs.filter(([value, weight]) => Number.isFinite(value) && weight > 0).sort((a, b) => a[0] - b[0]);
  if (!list.length) return 0;
  const half = list.reduce((sum, [, weight]) => sum + weight, 0) / 2;
  let acc = 0;
  for (let i = 0; i < list.length; i++) {
    acc += list[i][1];
    if (Math.abs(acc - half) < 1e-9 && i + 1 < list.length) return (list[i][0] + list[i + 1][0]) / 2;
    if (acc > half) return list[i][0];
  }
  return list[list.length - 1][0];
}

/** 加权分位数（q ∈ [0,1]）：在存在家庭组并发下拉噪声时，用偏高分位锚定纯本机独享成本基准。 */
function weightedQuantile(pairs: [number, number][], q: number): number {
  const list = pairs.filter(([value, weight]) => Number.isFinite(value) && weight > 0).sort((a, b) => a[0] - b[0]);
  if (!list.length) return 0;
  const target = list.reduce((sum, [, weight]) => sum + weight, 0) * Math.min(1, Math.max(0, q));
  let acc = 0;
  for (let i = 0; i < list.length; i++) {
    acc += list[i][1];
    if (acc >= target) return list[i][0];
  }
  return list[list.length - 1][0];
}

/**
 * 稳健近期加权平均（抗离群窗口 + 随当前窗口平滑更新）：
 * - 越新的窗口权重越高（周窗口每往前一周期 ×0.55，5 小时窗口 ×0.85），避免新周期长时间被旧周期钉死；
 * - 先以近期加权中位数确定稳健锚点，剔除偏离超过 2.5 倍的极端离群历史窗口（如早先全用低价 Flash 的窗口）；
 * - 对保留窗口做加权平均，使当前进行中的窗口每次产生新用量时整窗折算都能平滑实时跟进。
 */
export function robustRecencyEstimate(
  items: { value: number; weight: number }[],
  decay: number,
): number {
  const valid = items
    .map((item, idx) => ({
      value: item.value,
      weight: item.weight * Math.pow(decay, items.length - 1 - idx),
    }))
    .filter((item) => Number.isFinite(item.value) && item.value > 0 && item.weight > 0);
  if (!valid.length) return 0;
  if (valid.length === 1) return valid[0].value;
  const anchor = weightedMedian(valid.map((item) => [item.value, item.weight]));
  if (anchor <= 0) return valid[valid.length - 1].value;
  const kept = valid.filter((item) => {
    const ratio = item.value / anchor;
    return ratio >= 0.4 && ratio <= 2.5;
  });
  const pool = kept.length ? kept : valid;
  const sumW = pool.reduce((s, item) => s + item.weight, 0);
  if (sumW <= 0) return anchor;
  return pool.reduce((s, item) => s + item.value * item.weight, 0) / sumW;
}

/**
 * 自动识别处于同一 Google One 家庭组共享池的多账号：
 * 当两个账号在同一额度池上已有实际消耗（>= 0.5%），且 5 小时或周窗口的官方 resetAt 秒级一致（相差 <= 10 秒）、
 * 已用百分比同步（相差 <= 1.2%），即可确认它们背后连接的是同一个家庭组共享配额桶。
 */
export function detectFamilyLinks(
  items: { id: string; shareMode: AgyShareMode; last?: AgyLast }[],
): Map<string, { familyGroupId?: string; peers: string[]; detected: boolean }> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let cur = x;
    while (parent.get(cur) && parent.get(cur) !== cur) cur = parent.get(cur)!;
    return cur;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const item of items) parent.set(item.id, item.id);

  const sameBucket = (
    a: { used?: number; resetAt?: string } | undefined,
    b: { used?: number; resetAt?: string } | undefined,
  ): boolean => {
    if (!a || !b || !a.resetAt || !b.resetAt) return false;
    const ua = Number(a.used ?? 0), ub = Number(b.used ?? 0);
    if (ua < 0.5 && ub < 0.5) return false;
    const ta = Date.parse(a.resetAt), tb = Date.parse(b.resetAt);
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
    return Math.abs(ta - tb) <= 10_000 && Math.abs(ua - ub) <= 1.2;
  };

  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a.shareMode === "solo" || !a.last?.ok) continue;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (b.shareMode === "solo" || !b.last?.ok) continue;
      if (Math.abs((a.last.at || 0) - (b.last.at || 0)) > 20 * 60_000) continue;
      let shared = false;
      for (const ga of a.last.groups) {
        const pool = quotaPoolId(ga.models, ga.title);
        const gb = b.last.groups.find((g) => quotaPoolId(g.models, g.title) === pool);
        if (!gb) continue;
        if (sameBucket(ga, gb) || sameBucket(ga.week, gb.week)) {
          shared = true;
          break;
        }
      }
      if (shared) union(a.id, b.id);
    }
  }

  const byRoot = new Map<string, string[]>();
  for (const item of items) {
    const r = find(item.id);
    const list = byRoot.get(r) ?? [];
    list.push(item.id);
    byRoot.set(r, list);
  }

  const out = new Map<string, { familyGroupId?: string; peers: string[]; detected: boolean }>();
  let seq = 0;
  const rootGroupId = new Map<string, string>();
  for (const [root, members] of byRoot) {
    if (members.length > 1) {
      seq += 1;
      rootGroupId.set(root, `family:${seq}`);
    }
  }
  for (const item of items) {
    const r = find(item.id);
    const members = byRoot.get(r) ?? [item.id];
    const peers = members.filter((id) => id !== item.id);
    out.set(item.id, {
      ...(rootGroupId.has(r) ? { familyGroupId: rootGroupId.get(r) } : {}),
      peers,
      detected: peers.length > 0,
    });
  }
  return out;
}

export function agyWindowSegments(
  windowKind: "five" | "week",
  groupKeyStr: string,
  history: AgySample[],
  currentQuota: AgyWindowQuota,
  now: number,
  groupTitle?: string,
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
    const item = pickPoolSampleGroup(sample.groups, groupKeyStr, groupTitle);
    if (!item) continue;
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

  const GLITCH_SPAN_MS = 45 * 60_000;
  const groups: { resetAt: number; startAt: number; firstAt: number; list: { at: number; used: number }[] }[] = [];
  for (const pt of rawPoints) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.resetAt - pt.resetAt) < SAME_WINDOW_MS) {
      last.resetAt = pt.resetAt;
      last.startAt = pt.resetAt - periodMs;
      last.list.push({ at: pt.at, used: pt.used });
      continue;
    }
    // 仅合并 0% 空闲等待期向前顺滑推进的 resetAt（严格要求 pt.resetAt >= last.resetAt，防止把回跳到旧窗口的正常点吸附进瞬时 0% 脏点）
    if (last && last.list.every((p) => p.used <= 0) && pt.resetAt >= last.resetAt && pt.resetAt - last.resetAt < periodMs) {
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

  // 剔除夹在同一个窗口（或连续 0% 空闲期）之间的短暂瞬时脏组（如备用端点闪回 0%/旧缓存 1~3 帧后立刻恢复），
  // 防止单次接口抖动把进行中的窗口拦腰切出「窗口已提前重置」假提示并炸毁消耗速度预测。
  const cleanedGroups: typeof groups = [];
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const prev = cleanedGroups[cleanedGroups.length - 1];
    const next = groups[i + 1];
    const spanMs = group.list[group.list.length - 1].at - group.list[0].at;
    const isShortGlitch = group.list.length <= 3 && spanMs < GLITCH_SPAN_MS;
    if (prev && next && Math.abs(prev.resetAt - next.resetAt) < SAME_WINDOW_MS && isShortGlitch) {
      continue;
    }
    if (
      prev &&
      next &&
      prev.list.every((p) => p.used <= 0) &&
      next.list.every((p) => p.used <= 0) &&
      next.resetAt >= prev.resetAt &&
      next.resetAt - prev.resetAt < periodMs &&
      group.list.length <= 2 &&
      spanMs < 15 * 60_000 &&
      Math.max(...group.list.map((p) => p.used)) < 1
    ) {
      continue;
    }
    if (prev && Math.abs(prev.resetAt - group.resetAt) < SAME_WINDOW_MS) {
      prev.resetAt = group.resetAt;
      prev.startAt = group.resetAt - periodMs;
      prev.list.push(...group.list);
      continue;
    }
    if (
      prev &&
      prev.list.every((p) => p.used <= 0) &&
      group.resetAt >= prev.resetAt &&
      group.resetAt - prev.resetAt < periodMs
    ) {
      prev.resetAt = group.resetAt;
      prev.startAt = group.resetAt - periodMs;
      prev.list = [...prev.list.filter((p) => p.at >= prev.startAt - SAME_WINDOW_MS), ...group.list];
      continue;
    }
    cleanedGroups.push(group);
  }

  const segments: AgyWindowSegment[] = [];
  for (const group of cleanedGroups) {
    const previous = segments[segments.length - 1];
    const firstListAt = group.list[0]?.at ?? group.firstAt;
    let startAt = Math.max(group.startAt - SAME_WINDOW_MS, Math.min(group.startAt, firstListAt));
    let startedByReset: AgyResetStyle | undefined;
    if (previous) {
      const prevLastAt = previous.points[previous.points.length - 1].at;
      const prevHasUsage = previous.points.some((p) => p.used > 0);
      const currAllZero = group.list.every((p) => p.used <= 0);
      if (prevHasUsage && !(currAllZero && previous.points.length <= 1) && group.firstAt < previous.endAt - SAME_WINDOW_MS) {
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
      const prev = part[part.length - 1];
      if (prev) {
        const isInPlaceReset =
          (prev.used >= 2 && point.used <= 1 && prev.used - point.used >= 1.5) ||
          point.used < prev.used - 3;
        if (isInPlaceReset) {
          const rebound = group.list
            .slice(i + 1, i + 3)
            .some((p) => p.at - point.at < 30 * 60_000 && p.used >= prev.used - 1.5);
          if (rebound) continue;
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

type LocalIntervalSample = {
  from: number;
  to: number;
  deltaPct: number;
  tokens: number;
  costUsd: number;
  effectiveCostUsd: number;
};

type SegmentAttribution = {
  localIntervals: LocalIntervalSample[];
  offIntervals: AgyOffInterval[];
  uncertainIntervals: { from: number; to: number; points: number }[];
  rawUsedPct: number;
  offPoints: number;
};

/**
 * 对单个窗口段按相邻采样切分出「本机活跃区间」与「家庭组/他端无本机请求区间（offIntervals）」。
 * 支持服务端配额计数延迟吸附：若当前区间无请求但前 5 分钟内刚结束过本机请求，将滞后的点数并回上一段本机区间。
 */
function analyzeSegmentIntervals(
  segment: AgyWindowSegment,
  sortedGroupRows: RequestRow[],
  now: number,
): SegmentAttribution {
  const out: SegmentAttribution = {
    localIntervals: [],
    offIntervals: [],
    uncertainIntervals: [],
    rawUsedPct: 0,
    offPoints: 0,
  };
  if (!segment.points.length) return out;

  const upper = (at: number) => {
    let low = 0, high = sortedGroupRows.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (sortedGroupRows[mid].at <= at) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  const sliceRows = (fromExcl: number, toIncl: number) =>
    toIncl > fromExcl ? sortedGroupRows.slice(upper(fromExcl), upper(toIncl)) : [];

  const first = segment.points[0];
  const preRows = first.at > segment.startAt ? sliceRows(segment.startAt - 1, first.at) : [];
  const hasOrigin = first.at > segment.startAt && (first.used < 1.5 || preRows.length > 0);
  const pts = hasOrigin ? [{ at: segment.startAt, used: 0 }, ...segment.points] : [...segment.points];

  let anchor = pts[0];
  let prev = pts[0];
  let peakUsed = anchor.used;
  // 单调消费游标：保证每一条本机请求至多被归入一次本机区间（绝不因尾包吸附或回落等待而重复累加 Token）
  let consumedRowAt = segment.startAt - 1;

  for (let i = 1; i < pts.length; i++) {
    const pt = pts[i];
    if (pt.at <= anchor.at) continue;
    const stepMs = pt.at - prev.at;
    const stepDelta = pt.used - prev.used;
    // 同一窗口未发生真正重置时，后端多副本/滚动窗口可能小幅回落再回弹（如 3.1% → 2.6% → 3.1%）。
    // 使用单调高水位 peakUsed 兜底，仅对真正突破高水位的净涨幅记账，防止把抖动回弹重复累计成本机或家庭组消耗。
    const delta = pt.used - peakUsed;
    prev = pt;

    // 超过 6 小时未采样且期间净涨了点（例如电脑关机一整晚期间家人用过）：标为缺口不确定区间，不混入容量分母
    if (stepMs > MAX_INTERVAL_GAP_MS && delta >= 0.5 && stepDelta >= 0.5) {
      const gapRows = sliceRows(Math.max(anchor.at, consumedRowAt), pt.at);
      if (!gapRows.length) {
        out.offPoints += delta;
        out.offIntervals.push({ from: anchor.at, to: pt.at, points: Math.round(delta * 10) / 10, kind: "off" });
      } else {
        out.uncertainIntervals.push({ from: anchor.at, to: pt.at, points: Math.round(delta * 10) / 10 });
      }
      consumedRowAt = Math.max(consumedRowAt, pt.at);
      peakUsed = pt.used;
      anchor = { at: pt.at, used: peakUsed };
      continue;
    }

    const isLast = i === pts.length - 1;
    if (delta <= 0.05) {
      if (isLast) {
        // 末尾尚未再创高点但可能有刚产生的本地请求：若有上一条紧邻本机区间则吸附未消费过的尾包 Token
        const tailFrom = Math.max(anchor.at, consumedRowAt);
        const tailTo = Math.min(segment.endAt, pt.at + 60_000, now);
        const tailRows = sliceRows(tailFrom, tailTo);
        const lastLocal = out.localIntervals.at(-1);
        if (tailRows.length && lastLocal && anchor.at >= lastLocal.to - LAG_MS && anchor.at - lastLocal.to <= LAG_MS) {
          const sum = summarizeRows(tailRows);
          lastLocal.to = Math.max(lastLocal.to, pt.at);
          lastLocal.tokens += sum.tokens;
          lastLocal.costUsd += sum.costUsd;
          lastLocal.effectiveCostUsd += tailRows.reduce((s, r) => s + rowEffectiveCost(r), 0);
          consumedRowAt = Math.max(consumedRowAt, tailTo);
        }
      } else if (pt.at - anchor.at > LAG_MS) {
        // 平稳或短暂回落且超过延迟窗口：仅消费一次紧挨上一轮采样的尾包，且仅在闲置时推进时间锚点，绝不拉低高水位 peakUsed
        const trailFrom = Math.max(anchor.at, consumedRowAt);
        const trailTo = anchor.at + LAG_MS;
        const lastLocal = out.localIntervals.at(-1);
        if (lastLocal && lastLocal.to <= anchor.at && anchor.at - lastLocal.to <= LAG_MS && trailTo > trailFrom) {
          const trailing = sliceRows(trailFrom, trailTo);
          if (trailing.length) {
            const sum = summarizeRows(trailing);
            lastLocal.to = trailTo;
            lastLocal.tokens += sum.tokens;
            lastLocal.costUsd += sum.costUsd;
            lastLocal.effectiveCostUsd += trailing.reduce((s, r) => s + rowEffectiveCost(r), 0);
            consumedRowAt = Math.max(consumedRowAt, trailTo);
          }
        }
        if (!sliceRows(Math.max(anchor.at + LAG_MS, consumedRowAt), pt.at).length) {
          anchor = { at: pt.at, used: peakUsed };
        }
      }
      continue;
    }
    // 微小正向抖动（0.05% < delta < 0.4%）先累积到下一次采样
    if (delta < 0.4 && !isLast) continue;

    const from = anchor.at;
    const to = pt.at;
    const baseFrom = anchor === pts[0] && hasOrigin ? segment.startAt - 1 : from;
    const rowFrom = Math.max(baseFrom, consumedRowAt);
    const rowTo = isLast ? Math.min(segment.endAt, to + 60_000, now) : to;
    const part = sliceRows(rowFrom, rowTo);
    peakUsed = pt.used;
    anchor = { at: pt.at, used: peakUsed };
    out.rawUsedPct += delta;

    if (part.length > 0) {
      const sum = summarizeRows(part);
      const effCost = part.reduce((s, r) => s + rowEffectiveCost(r), 0);
      consumedRowAt = Math.max(consumedRowAt, rowTo);
      out.localIntervals.push({
        from,
        to,
        deltaPct: delta,
        tokens: sum.tokens,
        costUsd: sum.costUsd,
        effectiveCostUsd: effCost,
      });
      continue;
    }

    // 当前区间 (from, to] 内没有本机请求：检查是否属于前一段本机请求的配额滞后刷新
    const nearBefore = sliceRows(from - LAG_MS, from);
    const lastLocal = out.localIntervals.at(-1);
    if (nearBefore.length > 0 && lastLocal && from - lastLocal.to <= LAG_MS) {
      lastLocal.to = to;
      lastLocal.deltaPct += delta;
      continue;
    }

    const nearAfter = sliceRows(to, Math.min(to + LAG_MS, now));
    if (!nearBefore.length && !nearAfter.length) {
      out.offPoints += delta;
      const prevOff = out.offIntervals.at(-1);
      if (prevOff && prevOff.kind === "off" && from - prevOff.to <= 30 * 60_000 && !sliceRows(prevOff.to, from).length) {
        prevOff.to = to;
        prevOff.points = Math.round((prevOff.points + delta) * 10) / 10;
      } else {
        out.offIntervals.push({ from, to, points: Math.round(delta * 10) / 10, kind: "off" });
      }
    } else {
      out.uncertainIntervals.push({ from, to, points: Math.round(delta * 10) / 10 });
    }
  }

  return out;
}

type ShareContext = {
  mode: AgyShareMode;
  familyShared: boolean;
  familyPeers: string[];
};

const DEFAULT_SHARE_CONTEXT: ShareContext = {
  mode: "auto",
  familyShared: false,
  familyPeers: [],
};

function buildWindowInsight(
  windowKind: "five" | "week",
  quota: AgyWindowQuota,
  groupKeyStr: string,
  history: AgySample[],
  groupRows: RequestRow[],
  now: number,
  groupTitle?: string,
  shareCtx: ShareContext = DEFAULT_SHARE_CONTEXT,
): {
  insight: AgyWindowInsight;
  capacityHistory: AgyCapacityPoint[];
  currentAttribution?: SegmentAttribution & { coUsedPoints: number; coUsedIntervals: AgyOffInterval[] };
} {
  const periodMs = windowKind === "five" ? FIVE_MS : WEEK_MS;
  const resetMs = quota.resetAt ? Date.parse(quota.resetAt) || 0 : 0;
  const ended = Boolean(resetMs && resetMs <= now);
  const endAt = resetMs > 0 ? resetMs : now;
  const used = ended ? 0 : Math.min(100, Math.max(0, Number(quota.used) || 0));
  const remaining = ended ? 100 : Math.max(0, Math.round((100 - used) * 10) / 10);

  const sortedRows = [...groupRows].sort((a, b) => a.at - b.at);
  const segments = agyWindowSegments(windowKind, groupKeyStr, history, quota, now, groupTitle);
  const curSeg =
    !ended && resetMs > 0
      ? [...segments].reverse().find((s) => Math.abs(s.resetAt - resetMs) < SAME_WINDOW_MS && !s.endedByReset)
      : !ended && !resetMs
        ? segments[segments.length - 1]
        : undefined;

  const startAt = curSeg ? curSeg.startAt : ended && resetMs > 0 ? resetMs : resetMs > 0 ? resetMs - periodMs : now - periodMs;
  const startedByReset = !ended ? curSeg?.startedByReset : undefined;
  const currentPoints = curSeg ? curSeg.points : [];

  const windowRows = ended ? [] : sortedRows.filter((r) => r.at >= startAt && r.at <= Math.min(endAt, now));
  const local = summarizeRows(windowRows);
  const soloMode = shareCtx.mode === "solo";

  // 第 1 步：对所有窗口段提取区间级归因
  const segAnalyses = segments.map((segment) => ({
    segment,
    attr: soloMode ? null : analyzeSegmentIntervals(segment, sortedRows, now),
  }));

  // 第 2 步：确定近期独享等效整窗成本基准 B_ref（用于识别「同一时段本机与家庭成员并发使用」导致的单点坍缩）
  const recentLimit = windowKind === "five" ? RECENT_CAPACITY_FIVE : RECENT_CAPACITY_WEEK;
  const recentAnalyses = segAnalyses.slice(-Math.max(recentLimit + 2, 4));
  const candidateCostRates: [number, number][] = [];
  if (!soloMode) {
    for (const { attr } of recentAnalyses) {
      if (!attr) continue;
      for (const iv of attr.localIntervals) {
        if (iv.deltaPct >= 0.5 && iv.effectiveCostUsd > 0) {
          candidateCostRates.push([(iv.effectiveCostUsd / iv.deltaPct) * 100, iv.deltaPct]);
        }
      }
    }
  }
  // 家庭组并发只会向下压低 apparentCostRate（分母多了家人的消耗），用 P65 分位数稳健锚定纯本机独享成本率
  const soloRefFullCost =
    candidateCostRates.length >= 2
      ? weightedQuantile(candidateCostRates, shareCtx.familyShared || shareCtx.mode === "family" ? 0.7 : 0.6)
      : 0;

  const capacityHistory: AgyCapacityPoint[] = [];
  let curAttrResult: (SegmentAttribution & { coUsedPoints: number; coUsedIntervals: AgyOffInterval[] }) | undefined;

  for (const { segment, attr } of segAnalyses) {
    if (!segment.points.length) continue;
    const first = segment.points[0];
    const final = segment.points[segment.points.length - 1];
    const maxPt = segment.points.reduce((best, p) => (p.used >= best.used ? p : best), final);
    const targetPt = final.used >= maxPt.used - 0.5 ? final : maxPt;

    if (soloMode || !attr) {
      if (targetPt.used <= 0) continue;
      const endBound = Math.min(segment.endAt, targetPt.at + 60_000, now);
      const preRows =
        first.used >= 1.5 && first.at > segment.startAt
          ? sortedRows.filter((r) => r.at >= segment.startAt && r.at < first.at)
          : [];
      const useDeltaOnly = first.used >= 1.5 && first.at > segment.startAt && preRows.length === 0;
      const usedPct = useDeltaOnly ? targetPt.used - first.used : targetPt.used;
      if (usedPct < MIN_CAPACITY_PCT) continue;
      const rowStart = useDeltaOnly ? first.at : segment.startAt;
      const cRows = sortedRows.filter((r) => r.at >= rowStart && r.at <= endBound);
      const cSum = summarizeRows(cRows);
      if (cSum.tokens <= 0) continue;
      capacityHistory.push({
        at: targetPt.at,
        startAt: rowStart,
        endAt: segment.endAt,
        resetAt: segment.resetAt,
        usedPct: Math.round(usedPct * 10) / 10,
        tokens: cSum.tokens,
        costUsd: cSum.costUsd,
        fullTokens: Math.round((cSum.tokens / usedPct) * 100),
        fullCostUsd: Math.round(((cSum.costUsd / usedPct) * 100) * 100) / 100,
        ...(segment.startedByReset ? { startedByReset: segment.startedByReset } : {}),
        ...(segment.endedByReset ? { endedByReset: segment.endedByReset } : {}),
      });
      continue;
    }

    // 共享 / 家庭组防偏移模式：逐个本机区间检验是否存在「同期家庭成员并发高消耗」
    let cleanPct = 0;
    let cleanTokens = 0;
    let cleanCost = 0;
    let coUsedPoints = 0;
    const coUsedIntervals: AgyOffInterval[] = [];

    for (const iv of attr.localIntervals) {
      const impliedFullCost = iv.deltaPct > 0 && iv.effectiveCostUsd > 0 ? (iv.effectiveCostUsd / iv.deltaPct) * 100 : 0;
      const isCoUsedOutlier =
        soloRefFullCost > 0 &&
        impliedFullCost > 0 &&
        impliedFullCost < soloRefFullCost * 0.45 &&
        iv.deltaPct - (iv.effectiveCostUsd / soloRefFullCost) * 100 >= 1.0;

      if (isCoUsedOutlier) {
        const expectedLocalPct = Math.max(0.1, (iv.effectiveCostUsd / soloRefFullCost) * 100);
        const excessPct = Math.max(0, iv.deltaPct - expectedLocalPct);
        coUsedPoints += excessPct;
        coUsedIntervals.push({
          from: iv.from,
          to: iv.to,
          points: Math.round(excessPct * 10) / 10,
          kind: "co-used",
        });
        // 剥离并发外部涨幅后，若本机自身估计消耗够明显仍可按还原后的净点数温和计入，否则直接跳过污染区间
        if (expectedLocalPct >= 1.5) {
          cleanPct += expectedLocalPct;
          cleanTokens += iv.tokens;
          cleanCost += iv.costUsd;
        }
      } else {
        cleanPct += iv.deltaPct;
        cleanTokens += iv.tokens;
        cleanCost += iv.costUsd;
      }
    }

    if (segment === curSeg) {
      curAttrResult = { ...attr, coUsedPoints, coUsedIntervals };
    }

    // 若只有单次采样（尚无相邻采样点差值），且窗口起始本机就有完整记录，退回整段观察值
    if (cleanPct < MIN_CAPACITY_PCT && segment.points.length === 1 && targetPt.used >= MIN_CAPACITY_PCT) {
      const endBound = Math.min(segment.endAt, targetPt.at + 60_000, now);
      const cRows = sortedRows.filter((r) => r.at >= segment.startAt && r.at <= endBound);
      const cSum = summarizeRows(cRows);
      if (cSum.tokens > 0 && (first.used < 1.5 || sortedRows.some((r) => r.at >= segment.startAt && r.at < first.at))) {
        cleanPct = targetPt.used;
        cleanTokens = cSum.tokens;
        cleanCost = cSum.costUsd;
      }
    }

    if (cleanPct < MIN_CAPACITY_PCT || cleanTokens <= 0) continue;
    const excludedPct = Math.round((attr.offPoints + coUsedPoints) * 10) / 10;
    const rawUsedPct = Math.round(Math.max(cleanPct + excludedPct, targetPt.used) * 10) / 10;
    capacityHistory.push({
      at: targetPt.at,
      startAt: segment.startAt,
      endAt: segment.endAt,
      resetAt: segment.resetAt,
      usedPct: Math.round(cleanPct * 10) / 10,
      ...(excludedPct >= 0.5 ? { rawUsedPct, excludedPct } : {}),
      tokens: cleanTokens,
      costUsd: Math.round(cleanCost * 10000) / 10000,
      fullTokens: Math.round((cleanTokens / cleanPct) * 100),
      fullCostUsd: Math.round(((cleanCost / cleanPct) * 100) * 100) / 100,
      ...(segment.startedByReset ? { startedByReset: segment.startedByReset } : {}),
      ...(segment.endedByReset ? { endedByReset: segment.endedByReset } : {}),
    });
  }

  const recent = capacityHistory.slice(windowKind === "five" ? -RECENT_CAPACITY_FIVE : -RECENT_CAPACITY_WEEK);
  let sumPoints = recent.reduce((sum, point) => sum + point.usedPct, 0);
  const sumTokens = recent.reduce((sum, point) => sum + point.tokens, 0);
  const sumCost = recent.reduce((sum, point) => sum + point.costUsd, 0);
  let intervals = recent.length;

  let fullTokens: number | null = null;
  let fullCostUsd: number | null = null;
  let basis: AgyWindowCapacity["basis"] = null;
  let confidence: AgyWindowCapacity["confidence"] = "insufficient";

  if (sumPoints >= MIN_CAPACITY_PCT && sumTokens > 0) {
    const decay = windowKind === "week" ? 0.55 : 0.85;
    fullTokens = Math.round(
      robustRecencyEstimate(
        recent.map((point) => ({ value: point.fullTokens, weight: point.usedPct })),
        decay,
      ),
    );
    fullCostUsd = sumCost > 0
      ? Math.round(
          robustRecencyEstimate(
            recent.map((point) => ({ value: point.fullCostUsd, weight: point.usedPct })),
            decay,
          ) * 100,
        ) / 100
      : null;
    basis = intervals >= 2 && sumPoints >= 5 ? "measured" : "current";
    confidence = intervals >= 3 && sumPoints >= 15 ? "medium" : sumPoints >= 5 ? "low" : "current";
  } else if (!ended && used >= MIN_CAPACITY_PCT && local.tokens > 0) {
    const extNow = !soloMode && curAttrResult ? curAttrResult.offPoints + curAttrResult.coUsedPoints : 0;
    const netUsed = Math.max(0, used - extNow);
    if (netUsed >= MIN_CAPACITY_PCT) {
      fullTokens = Math.round((local.tokens / netUsed) * 100);
      fullCostUsd = local.costUsd > 0 ? Math.round(((local.costUsd / netUsed) * 100) * 100) / 100 : null;
      basis = "current";
      confidence = "current";
      sumPoints = netUsed;
      intervals = 1;
    }
  }

  // 第 3 步：计算当前窗口的本机 vs 家庭组/他端占比与双速率预测
  let ratePerHour: number | null = null;
  let recentRatePerHour: number | null = null;
  let localRatePerHour: number | null = null;
  let externalRatePerHour: number | null = null;
  let projected: number | null = null;
  let etaAt: number | null = null;

  const rawOffPoints = !ended && !soloMode && curAttrResult ? curAttrResult.offPoints : 0;
  const rawCoUsedPoints = !ended && !soloMode && curAttrResult ? curAttrResult.coUsedPoints : 0;
  // 若窗口半途才开始采样且前序无本机记录，采样前的初始已用同样计入外部/历史已用，不扣在本机头上
  const preInitialExt =
    !ended && !soloMode && curSeg && curSeg.points.length > 0 && curSeg.points[0].used >= 1.5 &&
    !windowRows.some((r) => r.at < curSeg.points[0].at)
      ? curSeg.points[0].used
      : 0;
  const externalUsedPct = ended
    ? 0
    : Math.min(used, Math.round((preInitialExt + rawOffPoints + rawCoUsedPoints) * 10) / 10);
  const localUsedPct = ended
    ? 0
    : local.tokens <= 0 && !soloMode
      ? 0
      : Math.max(0, Math.round((used - externalUsedPct) * 10) / 10);

  if (!ended && currentPoints.length >= 2) {
    const first = currentPoints[0];
    const lastPt = currentPoints[currentPoints.length - 1];
    const hours = (lastPt.at - first.at) / HOUR;
    if (hours >= 1 / 6) {
      ratePerHour = Math.max(0, (lastPt.used - first.used) / hours);
      const extSpanPct = Math.min(Math.max(0, lastPt.used - first.used), rawOffPoints + rawCoUsedPoints);
      const locSpanPct = Math.max(0, lastPt.used - first.used - extSpanPct);
      localRatePerHour = Math.round((locSpanPct / hours) * 100) / 100;
      externalRatePerHour = Math.round((extSpanPct / hours) * 100) / 100;
    }
    const recentAnchor =
      [...currentPoints].reverse().find((p) => lastPt.at - p.at >= 15 * 60_000 && lastPt.at - p.at <= 2 * HOUR) ?? first;
    const recentH = (lastPt.at - recentAnchor.at) / HOUR;
    if (recentH >= 1 / 6) {
      recentRatePerHour = Math.max(0, (lastPt.used - recentAnchor.used) / recentH);
    }

    if (ratePerHour != null) {
      // 防预测偏移：若早些时候有家庭成员突发消耗，但最近 >= 20 分钟已回落平稳，优先按近期稳态速率预测剩余时长
      const allExtIntervals = curAttrResult ? [...curAttrResult.offIntervals, ...curAttrResult.coUsedIntervals] : [];
      const lastExtAt = allExtIntervals.reduce((m, iv) => Math.max(m, iv.to), 0);
      const extBurstQuieted =
        !soloMode &&
        rawOffPoints + rawCoUsedPoints >= 3 &&
        lastExtAt > 0 &&
        now - lastExtAt >= 20 * 60_000 &&
        recentRatePerHour != null &&
        recentRatePerHour < ratePerHour * 0.75;
      const forecastRate = extBurstQuieted ? recentRatePerHour! : ratePerHour;
      const leftHours = Math.max(0, (endAt - now) / HOUR);
      projected = Math.min(200, used + forecastRate * leftHours);
      const rawEta = forecastRate > 0 ? now + ((100 - used) / forecastRate) * HOUR : null;
      etaAt = rawEta && rawEta < endAt ? Math.round(rawEta) : null;
      if (extBurstQuieted) {
        ratePerHour = forecastRate;
      }
    }
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

  const shared: AgySharedBreakdown = {
    mode: shareCtx.mode,
    familyShared: shareCtx.familyShared || shareCtx.mode === "family",
    familyPeers: shareCtx.familyPeers,
    localUsedPct,
    externalUsedPct,
    offPoints: Math.round(rawOffPoints * 10) / 10,
    coUsedPoints: Math.round(rawCoUsedPoints * 10) / 10,
    localRatePerHour,
    externalRatePerHour,
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
      shared,
    },
    capacityHistory: capacityHistory.slice(-30),
    ...(curAttrResult ? { currentAttribution: curAttrResult } : {}),
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
  const isEffortless = (model: string) => /orchestrator|^gemini-flash$/i.test(model);
  const findGroup = (family: string, model: string): AgyGroupInsight | undefined =>
    groupInsights.find((g) => groupMatchesModel(g, model) || groupMatchesModel(g, family)) ?? defaultGroup;

  for (const item of lastModels ?? []) {
    const effort = item.effort || (isEffortless(item.model) ? "" : "medium");
    const g = findGroup(item.family, item.model);
    if (!g) continue;
    const key = comboKey(item.model, effort || "default");
    if (!candidates.has(key)) {
      candidates.set(key, { model: item.model, family: item.family, effort, group: g });
    }
  }

  for (const g of groupInsights) {
    for (const family of g.models) {
      const { model } = splitModelLabel(family);
      const hasAny = [...candidates.values()].some((c) => c.model === model || c.model.startsWith(model + "-"));
      if (!hasAny) {
        const defaultEfforts = /gemini-4-argon/i.test(model)
          ? ["high", "low"]
          : isEffortless(model)
            ? [""]
            : /gemini.*flash/i.test(model)
              ? ["high", "medium"]
              : /claude/i.test(model)
                ? ["high", "low"]
                : ["medium"];
        for (const effort of defaultEfforts) {
          const key = comboKey(model, effort || "default");
          if (!candidates.has(key)) candidates.set(key, { model, family, effort, group: g });
        }
      }
    }
  }

  for (const row of rows30) {
    const hasKnownEffort = Boolean(row.effort && row.effort !== "unknown");
    if (!hasKnownEffort && [...candidates.values()].some((c) => c.model === row.model)) continue;
    const effort = hasKnownEffort ? row.effort! : "";
    const key = comboKey(row.model, effort || "default");
    if (!candidates.has(key)) {
      const g = findGroup(row.model, row.model);
      if (g) candidates.set(key, { model: row.model, family: row.model, effort, group: g });
    }
  }

  const out: AgyModelCapacityRow[] = [];
  for (const [key, cand] of candidates) {
    const modelRows = rows30.filter((r) => r.model === cand.model);
    const comboRows = cand.effort
      ? modelRows.filter((r) => (r.effort || "medium") === cand.effort)
      : modelRows.filter((r) => !r.effort || r.effort === "unknown");
    const groupRows = rows30.filter((r) => groupMatchesModel(cand.group, r.model));

    const rule = priceOf(cand.model) as PriceRule | null;
    const listPrice = rule
      ? { input: rule.input, output: rule.output, cacheRead: rule.cacheRead, cacheWrite: rule.cacheWrite, note: rule.note || "" }
      : null;

    const basePool = modelRows.length >= 3 ? modelRows : groupRows.length >= 3 ? groupRows : [];
    const mixBasis: AgyModelCapacityRow["mixBasis"] = modelRows.length >= 3 ? "model" : groupRows.length >= 3 ? "group" : "default";
    const baseSummary = basePool.length
      ? summarizeRows(basePool)
      : { ...DEFAULT_MIX, tokens: DEFAULT_MIX.input + DEFAULT_MIX.output, reasoning: 0, costUsd: 0, requests: 22 };

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

  const ref = [...out]
    .filter((r) => r.usdPerMTokens && r.usdPerMTokens > 0)
    .sort((a, b) => b.recentTokens - a.recentTokens || a.usdPerMTokens! - b.usdPerMTokens!)[0];
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
  accountId: string,
  last: AgyLast | undefined,
  group: AgyGroupState | undefined,
  history: AgySample[],
  rows: RequestRow[],
  now: number,
  soloMode = false,
) {
  const periodMs = windowKind === "five" ? FIVE_MS : WEEK_MS;
  const cycles: Cycle[] = [];
  const groups = group ? [group] : (last?.groups ?? []);
  const usedOf = (g: AgyGroupState) => (windowKind === "five" ? g.used : (g.week?.used ?? g.used)) || 0;
  const currentUsed = () => Math.max(0, ...groups.map(usedOf));

  const primaryGroup = group ?? groups.find((g) => usedOf(g) > 0) ?? groups[0];
  const primaryQuota = primaryGroup
    ? windowKind === "five"
      ? { used: primaryGroup.used, resetAt: primaryGroup.resetAt }
      : primaryGroup.week ?? { used: primaryGroup.used, resetAt: primaryGroup.resetAt }
    : { used: 0 };
  const segments = primaryGroup ? agyWindowSegments(windowKind, primaryGroup.key, history, primaryQuota, now, primaryGroup.title) : [];

  for (let idx = segments.length - 1; idx >= 0; idx--) {
    const seg = segments[idx];
    const start = Math.round(seg.startAt);
    const end = Math.round(seg.endAt);
    if (end <= now - KEEP_MS || end <= start) continue;
    const active = idx === segments.length - 1 && !seg.endedByReset && end > now;
    const lastPt = seg.points[seg.points.length - 1];
    const used = active ? currentUsed() : lastPt?.used ?? 0;
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
  const earliestStart = cycles.length
    ? cycles[cycles.length - 1].startAt
    : activeResetMs > now
      ? activeResetMs
      : windowKind === "five"
        ? Math.ceil(now / HOUR) * HOUR
        : shiftDay(startOfDay(now), 1);

  for (let i = 0; i < 36; i++) {
    const end = Math.round(earliestStart - i * periodMs);
    const start = Math.round(end - periodMs);
    if (end <= now - KEEP_MS) break;
    if (cycles.some((c) => Math.abs(c.startAt - start) < SAME_WINDOW_MS || (start < c.endAt && end > c.startAt + SAME_WINDOW_MS))) continue;
    const active = cycles.length === 0 && i === 0 && now >= start && now <= end;
    const hasRows = rows.some((r) => r.at >= start && r.at < end);
    const hasSamples = history.some((s) => s.at >= start && s.at <= end);
    if (!active && !hasRows && !hasSamples) continue;
    const used = active ? currentUsed() : 0;
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
  const sortedRows = [...rows].sort((a, b) => a.at - b.at);
  const observed = selected ? sortedRows.filter((r) => r.at >= selected.startAt && r.at < selected.endAt && r.at <= now) : [];
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
    if (group) {
      const matched = pickPoolSampleGroup(s.groups, group.key, group.title);
      if (!matched) return null;
      const v = windowKind === "five" ? matched.used : (matched.weekUsed ?? matched.used);
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    }
    const vals = s.groups
      .map((g) => (windowKind === "five" ? g.used : (g.weekUsed ?? g.used)))
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
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
    if (selected.active && last && groups.length) {
      if (!track.length || track[track.length - 1].at < (last.at || now)) {
        track.push({ at: last.at || now, pct: currentUsed() });
      }
    }
  }

  // 把选中周期内「家庭组其他成员 / 本机以外」的上涨区间传给时间线渲染橙色带与轨道
  const matchedSeg = selected
    ? segments.find((s) => Math.round(s.startAt) === selected.startAt && Math.round(s.endAt) === selected.endAt)
    : undefined;
  const segAttr = matchedSeg && !soloMode ? analyzeSegmentIntervals(matchedSeg, sortedRows, now) : null;
  const attributionIntervals = segAttr
    ? [
        ...segAttr.offIntervals.map((iv) => ({ from: iv.from, to: iv.to, points: iv.points, kind: "unmatched" as const })),
        ...segAttr.uncertainIntervals.map((iv) => ({ from: iv.from, to: iv.to, points: iv.points, kind: "uncertain" as const })),
      ].sort((a, b) => a.from - b.from)
    : [];
  const offDetected = segAttr
    ? segAttr.offIntervals.map((iv) => ({ from: iv.from, to: iv.to, points: iv.points }))
    : [];

  const curveLabel = windowKind === "five" ? "5 小时额度已用" : "周额度已用";
  const unknown = (r: RequestRow) => !r.effort || r.effort === "unknown";
  return {
    query: { kind: "antigravity", accountId, window: windowKind, cycle: cycleId },
    brand: "antigravity",
    source: "Antigravity",
    now,
    cycles,
    selected,
    quotaStale: false,
    timeline: [...bins.values()].sort((a, b) => a.startAt - b.startAt),
    binMs,
    track,
    curve: { label: group ? `${group.title || "这一组"} · ${curveLabel}` : `${curveLabel}（最高组）` },
    ...(group ? { group: { key: group.key, title: group.title || "", models: group.models } } : {}),
    attribution: { intervals: attributionIntervals },
    offMachine: {
      points: segAttr ? Math.round(segAttr.offPoints * 10) / 10 : 0,
      markedPoints: 0,
      detected: offDetected,
      marks: [] as never[],
    },
    totals: {
      tokens: observed.reduce((s, r) => s + r.tokens, 0),
      calls: observed.reduce((s, r) => s + (r.calls || 1), 0),
      records: observed.length,
      unknownEffort: observed.filter(unknown).length,
    },
  };
}

function mergeLocalAndCloudStatus(local: AgyStatus, cloud: AgyStatus): AgyStatus {
  const pickPrimary = local.groups.length >= cloud.groups.length ? local : cloud;
  const tier = cloud.tier || local.tier;
  const plan =
    (cloud.plan && (!local.plan || (local.plan === "Pro" && cloud.plan !== "Pro")))
      ? cloud.plan
      : local.plan || cloud.plan;
  const credits = local.credits ?? cloud.credits;
  const labels = { ...cloud.labels, ...local.labels };
  const models = pickPrimary.models ?? local.models ?? cloud.models;
  return {
    plan,
    ...(tier ? { tier } : {}),
    groups: pickPrimary.groups,
    labels,
    ...(models?.length ? { models } : {}),
    ...(credits ? { credits } : {}),
  };
}

export class AntigravityQuota {
  private stored: Stored;
  private loading = false;
  private loadingAccounts = new Set<string>();
  private running = false;
  private activeLocalEmail = "";
  private activeLocalAccountId = "";
  private pending?: Promise<AgyQuotaState>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private readonly file = dataFile("antigravity-quota.json");
  private readonly fetcher: () => Promise<AgyStatus | null>;
  private readonly cloudFetcher: (account: StoredAgyAccount) => Promise<{ status: AgyStatus; projectId?: string }>;
  private readonly now: () => number;
  private rowCache?: { rollupMtime: number; at: number; rows: RequestRow[] };
  private insightCache = new Map<string, { stamp: string; at: number; insight: AgyInsight }>();

  constructor(
    private options: {
      publish?: (state: AgyQuotaState) => void;
      notify?: (models: string[], used: number, resetAt?: string, accountLabel?: string) => void;
      notifyAt?: () => number;
      fetcher?: () => Promise<AgyStatus | null>;
      cloudFetcher?: (account: StoredAgyAccount, deps?: AgyNetDeps) => Promise<{ status: AgyStatus; projectId?: string }>;
      now?: () => number;
    } = {},
  ) {
    this.fetcher = options.fetcher ?? fetchAntigravityStatus;
    this.cloudFetcher =
      options.cloudFetcher ??
      ((account) => fetchAntigravityCloudStatus(account.credential!));
    this.now = options.now ?? Date.now;
    const raw = readJson<Partial<Stored> | null>(this.file, null);
    this.stored = sanitizeStored(raw);
    this.running = Boolean(antigravityHub());
    if (this.running) {
      this.activeLocalAccountId = readAgyLoginTimeline().at(-1)?.id || "";
    }
  }

  installed() {
    return (
      antigravityDirs().some((dir) => fs.existsSync(dir)) ||
      Boolean(this.stored.last) ||
      visibleAgyAccounts().length > 0
    );
  }

  /** 判断零配置时期积攒的顶层历史采样真正属于哪个账号，防止先添加了另一个账号后被误继承。 */
  private legacyOwnerId(visible: StoredAgyAccount[]): string {
    if (!visible.length) return "";
    const spans = readAgyLoginTimeline();
    const visibleIds = new Set(visible.map((a) => a.id));
    const spanOwner = spans.find((s) => visibleIds.has(s.id))?.id || spans[0]?.id || "";
    if (spanOwner) return spanOwner;
    if (this.activeLocalEmail) {
      const localId = agyAccountIdOf(agyRefFromIdentity(this.activeLocalEmail));
      if (localId) return localId;
    }
    if (this.activeLocalAccountId) return this.activeLocalAccountId;
    return visible.length === 1 ? visible[0].id : "";
  }

  /** 获取或初始化某个登记账号的存储槽；仅把零配置时期的顶层历史精确继承给它的原主账号。 */
  private slotOf(accountId?: string, allowSeedFromLegacy = false): AccountSlot {
    if (!accountId || accountId === "antigravity") return this.stored;
    this.stored.accounts ??= {};
    let slot = this.stored.accounts[accountId];
    if (!slot) {
      const hasLegacyData = this.stored.history.length > 0 || Boolean(this.stored.last);
      const canSeedHere = allowSeedFromLegacy && !Object.values(this.stored.accounts).some((s) => s.history.length > 0);
      if (canSeedHere && hasLegacyData) {
        slot = {
          ...(this.stored.last ? { last: JSON.parse(JSON.stringify(this.stored.last)) } : {}),
          history: JSON.parse(JSON.stringify(this.stored.history)),
          notified: { ...this.stored.notified },
        };
      } else {
        slot = { history: [], notified: {} };
      }
      this.stored.accounts[accountId] = slot;
    }
    return slot;
  }

  forgetAccount(accountId: string) {
    if (this.stored.accounts?.[accountId]) {
      delete this.stored.accounts[accountId];
      this.insightCache.delete(accountId);
      this.save();
      this.publish();
    }
  }

  recentRows(now = this.now()): RequestRow[] {
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

  /**
   * 筛选归属于目标账号（或本机同一家庭组关联账号）的本地 Antigravity 请求记录：
   * - 零配置单槽或仅登记了 1 个账号且无切换记录：全部本机 Antigravity 请求归它；
   * - 多账号模式：按 `antigravity-logins.json` 时间线切分；若目标账号与其它本机账号同属一个家庭组共享池，
   *   它们在这台电脑上的消耗共同扣减同一份配额，合并计入以保证容量折算准确。
   */
  private rowsForAccount(
    allRows: RequestRow[],
    accountId: string | undefined,
    visibleCount: number,
    familyMemberIds: Set<string>,
    inLocal: boolean,
  ): RequestRow[] {
    if (!accountId || accountId === "antigravity") return allRows;
    const spans = readAgyLoginTimeline();
    if (!spans.length) {
      if (visibleCount <= 1 || inLocal) return allRows;
      return [];
    }
    const accepted = new Set<string>([accountId, ...familyMemberIds]);
    return allRows.filter((row) => {
      const owner = resolveAgyLocalOwner(row.at, spans);
      return owner ? accepted.has(owner) : inLocal;
    });
  }

  buildInsight(
    now = this.now(),
    accountId = "antigravity",
    slot: AccountSlot = this.slotOf(accountId),
    scopedRows?: RequestRow[],
    shareCtx: ShareContext = DEFAULT_SHARE_CONTEXT,
  ): AgyInsight {
    let rollupMtime = 0;
    try {
      rollupMtime = fs.statSync(dataFile("usage-rollups.json")).mtimeMs;
    } catch { /* 还没生成账本 */ }
    const rows30 = scopedRows ?? this.recentRows(now);
    const stamp = [
      accountId,
      rollupMtime,
      rows30.length,
      rows30.at(-1)?.at ?? 0,
      slot.last?.at ?? 0,
      slot.history.length,
      shareCtx.mode,
      shareCtx.familyShared ? 1 : 0,
      shareCtx.familyPeers.join(","),
      (slot.last?.groups ?? []).map((g) => `${g.key}:${g.used}:${g.week?.used ?? ""}`).join(","),
    ].join("|");

    const cached = this.insightCache.get(accountId);
    if (cached && cached.stamp === stamp && now >= cached.at && now - cached.at < 15_000) {
      return cached.insight;
    }

    const todayStart = startOfDay(now);
    const d7Start = now - 7 * DAY;
    const rowsToday = rows30.filter((r) => r.at >= todayStart);
    const rows7 = rows30.filter((r) => r.at >= d7Start);

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
        const speeds = list.map((r) => r.timing?.tokensPerSec || 0).filter((v) => v > 0);
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
      }));

    const lastGroups = slot.last?.groups ?? [];
    const lastModels = (slot.last?.models ?? []).map((m) => {
      if (!m.label) return m;
      const split = splitModelLabel(m.label);
      const { effort: _oldEffort, ...rest } = m;
      return {
        ...rest,
        family: split.family,
        model: split.model,
        ...(split.effort ? { effort: split.effort } : {}),
      };
    });

    const groups: AgyGroupInsight[] = lastGroups.map((group) => {
      const gRows = rows30.filter((r) => groupMatchesModel(group, r.model));
      const fiveRes = buildWindowInsight(
        "five",
        { used: group.used, resetAt: group.resetAt },
        group.key,
        slot.history,
        gRows,
        now,
        group.title,
        shareCtx,
      );
      const weekQuota =
        group.week ??
        (() => {
          for (let i = slot.history.length - 1; i >= 0; i--) {
            const matched = pickPoolSampleGroup(slot.history[i].groups, group.key, group.title);
            if (matched && matched.weekUsed != null) {
              return { used: matched.weekUsed, resetAt: matched.weekResetAt };
            }
          }
          return undefined;
        })();
      const weekRes = weekQuota
        ? buildWindowInsight("week", weekQuota, group.key, slot.history, gRows, now, group.title, shareCtx)
        : null;

      const rawItems = lastModels.filter(
        (m) => group.models.includes(m.family) || group.models.includes(modelFamily(m.label || m.family)),
      );
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

      const defaultTitle = group.models.some((m) => /gemini|orchestrator/i.test(m)) ? "Gemini Models" : "Claude and GPT models";
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
      sampleCount: slot.history.length,
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
    this.insightCache.set(accountId, { stamp, at: now, insight });
    return insight;
  }

  state(): AgyQuotaState {
    const now = this.now();
    const since = now - SHOW_MS;
    const allRows = this.recentRows(now);
    const visible = visibleAgyAccounts();

    if (!visible.length) {
      const insight = this.buildInsight(now, "antigravity", this.stored, allRows, DEFAULT_SHARE_CONTEXT);
      return {
        installed: this.installed(),
        running: this.running,
        loading: this.loading,
        conversations: insight.conversations,
        ...(this.stored.last ? { last: this.stored.last } : {}),
        history: this.stored.history.filter((sample) => sample.at >= since),
        insight,
        registeredCount: 0,
        multiAccount: false,
        accounts: [],
      };
    }

    const legacyOwner = this.legacyOwnerId(visible);
    const names = agyDisplayNames(visible);
    const linkInput = visible.map((acc) => ({
      id: acc.id,
      shareMode: normalizeShareMode(acc.shareMode),
      last: this.slotOf(acc.id, acc.id === legacyOwner).last,
    }));
    const familyLinks = detectFamilyLinks(linkInput);
    const nameById = new Map<string, string>();
    visible.forEach((acc, i) => {
      nameById.set(acc.id, names[i] || acc.alias || acc.email.replace(/@.*$/, "") || "账号");
    });

    const accountStates: AgyAccountQuotaState[] = visible.map((acc, index) => {
      const slot = this.slotOf(acc.id, acc.id === legacyOwner);
      const inLocal = this.activeLocalEmail
        ? normalizeAgyEmail(acc.email) === this.activeLocalEmail
        : Boolean(this.running && this.activeLocalAccountId && acc.id === this.activeLocalAccountId);
      const cloudAuth = Boolean(acc.credential && !isExpired(acc.credential, now) && !acc.renewFailed);
      const usable = cloudAuth || inLocal;
      const autoRenew = Boolean(acc.credential?.refreshToken) && !acc.renewFailed;
      const needsLogin = Boolean(acc.renewFailed) && !inLocal;
      const waitLocal = !acc.credential && !inLocal;
      const shareMode = normalizeShareMode(acc.shareMode);
      const link = familyLinks.get(acc.id);
      const peerIds = link?.peers ?? [];
      const peerNames = peerIds.map((id) => nameById.get(id) || id);
      const familyShared = shareMode === "family" || Boolean(link?.detected);
      const scopedRows = this.rowsForAccount(allRows, acc.id, visible.length, new Set(peerIds), inLocal);
      const shareCtx: ShareContext = {
        mode: shareMode,
        familyShared,
        familyPeers: peerNames,
      };
      const insight = this.buildInsight(now, acc.id, slot, scopedRows, shareCtx);
      const displayName = names[index] || "";
      const accountHint = acc.alias || (visible.length > 1 ? acc.email || acc.label : "");
      return {
        id: acc.id,
        displayName,
        accountHint,
        inLocal,
        cloudAuth,
        usable,
        autoRenew,
        waitLocal,
        needsLogin,
        shareMode,
        ...(link?.familyGroupId ? { familyGroupId: link.familyGroupId } : {}),
        familyShared,
        familyPeers: peerNames,
        loading: this.loading || this.loadingAccounts.has(acc.id),
        ...(slot.last ? { last: slot.last } : {}),
        history: slot.history.filter((sample) => sample.at >= since),
        insight,
      };
    });

    const lead = accountStates[0];
    return {
      installed: this.installed(),
      running: this.running || accountStates.some((a) => a.cloudAuth || a.inLocal),
      loading: this.loading || this.loadingAccounts.size > 0,
      conversations: lead?.insight?.conversations ?? antigravityConversationFiles().length,
      ...(lead?.last ? { last: lead.last } : {}),
      history: lead?.history ?? [],
      ...(lead?.insight ? { insight: lead.insight } : {}),
      registeredCount: accountStates.length,
      multiAccount: accountStates.length > 1,
      accounts: accountStates,
    };
  }

  timeline(query?: unknown) {
    const now = this.now();
    const q = (query && typeof query === "object" ? query : {}) as {
      accountId?: unknown;
      cycles?: Record<string, unknown>;
    };
    const cycles = q.cycles && typeof q.cycles === "object" ? q.cycles : {};
    const cycle = (id: string) => {
      const v = cycles[id];
      return typeof v === "string" && /^\d{1,16}:\d{1,16}$/.test(v) ? v : undefined;
    };

    const visible = visibleAgyAccounts();
    const rawAccountId = typeof q.accountId === "string" && q.accountId ? q.accountId : "antigravity";
    const matchedAcc = visible.find((a) => a.id === rawAccountId);
    const effectiveId = matchedAcc ? matchedAcc.id : visible[0]?.id ?? "antigravity";
    const legacyOwner = this.legacyOwnerId(visible);
    const slot = matchedAcc || visible.length ? this.slotOf(effectiveId, effectiveId === legacyOwner) : this.stored;
    const soloMode = matchedAcc ? normalizeShareMode(matchedAcc.shareMode) === "solo" : false;

    const allRows = this.recentRows(now);
    let rows = allRows;
    if (visible.length && effectiveId !== "antigravity") {
      const linkInput = visible.map((acc) => ({
        id: acc.id,
        shareMode: normalizeShareMode(acc.shareMode),
        last: this.slotOf(acc.id, true).last,
      }));
      const links = detectFamilyLinks(linkInput).get(effectiveId);
      const targetAcc = matchedAcc ?? visible[0];
      const inLocal = Boolean(this.activeLocalEmail && targetAcc && normalizeAgyEmail(targetAcc.email) === this.activeLocalEmail);
      rows = this.rowsForAccount(allRows, effectiveId, visible.length, new Set(links?.peers ?? []), inLocal);
    }

    const last = slot.last;
    const history = slot.history;
    const groups = last?.groups ?? [];
    const outAccountId = rawAccountId.startsWith("antigravity:") ? rawAccountId : "antigravity";

    if (!groups.length) {
      return {
        kind: "antigravity",
        accountId: outAccountId,
        labels: { five: "5 小时", week: "周额度" },
        windows: [
          { id: "five", kind: "five", label: "5 小时" },
          { id: "week", kind: "week", label: "周额度" },
        ],
        five: buildTimelineWindow("five", cycle("five"), outAccountId, last, undefined, history, rows, now, soloMode),
        week: buildTimelineWindow("week", cycle("week"), outAccountId, last, undefined, history, rows, now, soloMode),
      };
    }

    const owner = new Map<RequestRow, number>();
    for (const row of rows) {
      const index = groups.findIndex((g) => groupMatchesModel(g, row.model || ""));
      owner.set(row, index < 0 ? 0 : index);
    }
    const out: Record<string, unknown> = { kind: "antigravity", accountId: outAccountId, labels: {} };
    const windows: { id: string; kind: "five" | "week"; label: string; group: string }[] = [];
    groups.forEach((group, index) => {
      const groupRows = rows.filter((row) => owner.get(row) === index);
      const title = group.title || group.models.join(" / ") || `第 ${index + 1} 组`;
      const kinds: ("five" | "week")[] = ["five", ...(group.week ? (["week"] as const) : [])];
      for (const kind of kinds) {
        const id = `g${index}-${kind}`;
        const label = `${title} · ${kind === "five" ? "5 小时" : "周额度"}`;
        windows.push({ id, kind, label, group: group.key });
        (out.labels as Record<string, string>)[id] = label;
        out[id] = buildTimelineWindow(kind, cycle(id), outAccountId, last, group, history, groupRows, now, soloMode);
      }
    });
    out.windows = windows;
    return out;
  }

  speed(days: number, accountId?: string): SpeedSeries {
    const now = this.now();
    const since = days > 0 ? now - days * DAY : 0;
    const baseRows =
      days <= 30
        ? this.recentRows(now)
        : (() => {
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
            } catch {
              return this.recentRows(now);
            }
          })();

    const visible = visibleAgyAccounts();
    let rows = baseRows;
    if (accountId && accountId.startsWith("antigravity:") && visible.length > 1) {
      const target = visible.find((a) => a.id === accountId);
      const inLocal = Boolean(this.activeLocalEmail && target && normalizeAgyEmail(target.email) === this.activeLocalEmail);
      const links = detectFamilyLinks(
        visible.map((acc) => ({ id: acc.id, shareMode: normalizeShareMode(acc.shareMode), last: this.slotOf(acc.id, true).last })),
      ).get(accountId);
      rows = this.rowsForAccount(baseRows, accountId, visible.length, new Set(links?.peers ?? []), inLocal);
    }

    const measured = rows
      .filter((row) => row.at >= since && row.at <= now && row.timing && (row.timing.tokensPerSec || row.timing.firstTokenMs))
      .map((row) => ({
        at: row.at,
        model: row.model,
        fast: false,
        speed: row.timing!.tokensPerSec || 0,
        first: row.timing!.firstTokenMs || 0,
        output: row.output,
      }));
    return speedSeriesOf(measured, since, now);
  }

  start() {
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  reschedule(everyMs: number) {
    if (this.timer) clearInterval(this.timer);
    const ms = Math.max(30_000, everyMs);
    this.timer = setInterval(() => {
      void this.refresh(false);
    }, ms);
    this.timer.unref?.();
  }

  publish() {
    if (!this.stopped) this.options.publish?.(this.state());
  }
  private save() {
    try {
      writeJson(this.file, this.stored);
    } catch { /* 存不下来：这次的结果还在内存里 */ }
  }

  /** 快速同步本机正在运行的 Antigravity IDE 登录态到时间线（供刷新前调用，Antigravity 未开时零开销）。 */
  async syncLocalLogin(): Promise<void> {
    if (this.options.fetcher || !antigravityHub()) return;
    const sess = await fetchAntigravityLocalSession().catch(() => null);
    if (!sess) return;
    this.running = true;
    const at = this.now();
    if (sess.email) {
      this.activeLocalEmail = normalizeAgyEmail(sess.email);
      this.activeLocalAccountId = recordAgyLocalLogin(sess.email, at);
      if (visibleAgyAccounts().length > 0) {
        try {
          rememberAgyAccount({ email: sess.email, label: sess.email || sess.name }, false, at);
        } catch { /* 尊重 removed / hidden */ }
      }
    }
  }

  refresh(manual: boolean, targetAccountId?: string): Promise<AgyQuotaState> {
    if (this.pending) return this.pending;
    const hasAccounts = visibleAgyAccounts().length > 0;
    if (!manual && !hasAccounts && !antigravityDirs().some((dir) => fs.existsSync(dir))) {
      return Promise.resolve(this.state());
    }
    this.pending = this.refreshNow(manual, targetAccountId).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private applyStatusToSlot(slot: AccountSlot, status: AgyStatus, at: number, accountLabel?: string) {
    const groups = status.groups.map((group) => ({ ...group, key: groupKey(group.models) }));
    slot.last = {
      at,
      ok: true,
      plan: status.plan || undefined,
      tier: status.tier,
      groups,
      ...(status.models?.length ? { models: status.models } : {}),
      ...(status.credits ? { credits: status.credits } : {}),
    };
    this.record(at, groups, slot);
    this.check(groups, slot, accountLabel);
  }

  private async refreshNow(manual: boolean, targetAccountId?: string): Promise<AgyQuotaState> {
    this.loading = true;
    if (manual) this.publish();
    const at = this.now();
    let nextState!: AgyQuotaState;

    try {
      const visible = visibleAgyAccounts();
      if (!visible.length) {
        // 传统零配置单账号模式：优先读取本地完整会话，顺带记下本机当时登录的账号时间线，日后切多账号时不丢失归属
        let status: AgyStatus | null = null;
        if (this.options.fetcher) {
          status = await this.fetcher();
        } else {
          const sess = await fetchAntigravityLocalSession().catch(() => null);
          if (sess) {
            status = sess.status;
            if (sess.email) {
              this.activeLocalEmail = normalizeAgyEmail(sess.email);
              this.activeLocalAccountId = recordAgyLocalLogin(sess.email, at);
            }
          }
        }
        this.running = Boolean(status);
        if (!status) {
          if (manual) {
            this.stored.last = {
              ...(this.stored.last ?? { groups: [] }),
              at: this.stored.last?.at ?? at,
              ok: this.stored.last?.ok ?? false,
              error: "Antigravity 没有在运行，打开它之后才能查到额度",
            };
          }
        } else {
          this.applyStatusToSlot(this.stored, status, at);
        }
      } else {
        // 多账号模式：先自动续期快过期的 OAuth 账号，并顺带探一次本机运行中的 Antigravity
        await renewAgyCredentials(at).catch(() => 0);
        const refreshedVisible = visibleAgyAccounts();
        const legacyOwner = this.legacyOwnerId(refreshedVisible);
        const names = agyDisplayNames(refreshedVisible);

        let localSession: { status: AgyStatus; email: string } | null = null;
        if (this.options.fetcher) {
          const st = await this.fetcher().catch(() => null);
          this.running = Boolean(st);
          if (st) localSession = { status: st, email: this.activeLocalEmail };
        } else {
          const sess = await fetchAntigravityLocalSession().catch(() => null);
          this.running = Boolean(sess);
          if (sess) {
            this.activeLocalEmail = normalizeAgyEmail(sess.email);
            if (sess.email) this.activeLocalAccountId = recordAgyLocalLogin(sess.email, at);
            localSession = { status: sess.status, email: sess.email };
          } else {
            this.activeLocalEmail = "";
            this.activeLocalAccountId = "";
          }
        }

        const targets = targetAccountId
          ? refreshedVisible.filter((a) => a.id === targetAccountId)
          : refreshedVisible;

        await Promise.all(
          targets.map(async (account) => {
            const idx = refreshedVisible.findIndex((a) => a.id === account.id);
            const slot = this.slotOf(account.id, account.id === legacyOwner);
            const label = names[idx] || account.alias || "";
            const inLocal = Boolean(
              localSession?.email && normalizeAgyEmail(account.email) === normalizeAgyEmail(localSession.email),
            );
            const hasCloudCred = Boolean(account.credential && !isExpired(account.credential, at) && !account.renewFailed);

            this.loadingAccounts.add(account.id);
            try {
              if (hasCloudCred) {
                try {
                  const res = await this.cloudFetcher(account);
                  if (res.projectId) updateAgyProjectId(account.id, res.projectId);
                  let finalStatus = res.status;
                  if (inLocal && localSession?.status) {
                    finalStatus = mergeLocalAndCloudStatus(localSession.status, res.status);
                  }
                  this.applyStatusToSlot(slot, finalStatus, at, label);
                  return;
                } catch (cloudErr) {
                  // 若 Cloud Code 暂时网络波动，且本机正好开着同一个账号，回退本机接口不中断
                  if (inLocal && localSession) {
                    this.applyStatusToSlot(slot, localSession.status, at, label);
                    return;
                  }
                  throw cloudErr;
                }
              }

              if (inLocal && localSession) {
                this.applyStatusToSlot(slot, localSession.status, at, label);
                return;
              }

              if (manual) {
                const reason = account.renewFailed
                  ? `登录已失效（${account.renewFailed}），请在「设置 → 官方账号」点「重新授权」`
                  : account.credential
                    ? "登录凭据已过期，等待自动续期或在设置里点「重新授权」"
                    : "该账号仅登记了本机登录（未保存独立凭据）；打开 Antigravity 切到该账号，或在设置里点「重新授权」后关掉客户端也能查额度";
                slot.last = {
                  ...(slot.last ?? { groups: [] }),
                  at: slot.last?.at ?? at,
                  ok: slot.last?.ok ?? false,
                  error: reason,
                };
              }
            } catch (err) {
              log.warn("antigravity", `账号 ${account.id} 额度查询失败：` + errorText(err));
              slot.last = {
                ...(slot.last ?? { groups: [] }),
                at: slot.last?.ok ? slot.last.at : at,
                ok: false,
                error: err instanceof Error ? err.message : "查询失败",
              };
            } finally {
              this.loadingAccounts.delete(account.id);
            }
          }),
        );

        // 仅当顶层历史已经落入对应账号（或无待归属的原主账号）时同步兼容槽，防止先加别的号时把老采样洗掉
        const firstAcc = refreshedVisible[0];
        const waitingLegacyOwner = Boolean(legacyOwner && !this.stored.accounts?.[legacyOwner]);
        if (firstAcc && !waitingLegacyOwner) {
          const firstSlot = this.slotOf(firstAcc.id, firstAcc.id === legacyOwner);
          this.stored.last = firstSlot.last;
          this.stored.history = firstSlot.history;
        }
      }
    } catch (error) {
      this.running = Boolean(antigravityHub());
      log.warn("antigravity", "额度查询失败：" + errorText(error));
      this.stored.last = {
        ...(this.stored.last ?? { groups: [] }),
        at: this.stored.last?.ok ? this.stored.last.at : at,
        ok: false,
        error: error instanceof Error ? error.message : "查询失败",
      };
    } finally {
      this.loading = false;
      this.loadingAccounts.clear();
      this.save();
      nextState = this.state();
      if (!this.stopped) this.options.publish?.(nextState);
    }
    return nextState;
  }

  private record(at: number, groups: AgyGroupState[], slot: AccountSlot = this.stored) {
    const sample: AgySample = {
      at,
      groups: groups.map((group) => ({
        key: group.key,
        used: group.used,
        ...(group.resetAt ? { resetAt: group.resetAt } : {}),
        ...(group.week
          ? {
              weekUsed: group.week.used,
              ...(group.week.resetAt ? { weekResetAt: group.week.resetAt } : {}),
            }
          : {}),
      })),
    };
    const previous = slot.history.at(-1);
    const same =
      previous &&
      JSON.stringify(previous.groups.map((g) => [g.key, g.used, g.weekUsed ?? null])) ===
        JSON.stringify(sample.groups.map((g) => [g.key, g.used, g.weekUsed ?? null]));
    if (same && at - previous.at < SAMPLE_EVERY_MS) return;
    slot.history.push(sample);
    const since = at - KEEP_MS;
    slot.history = slot.history.filter((item) => item.at >= since).slice(-5000);
  }

  /** 一组过了提醒线：每个窗口提醒一次（兼容测试直接调用 q.check(groups)）。 */
  check(groups: AgyGroupState[], slot: AccountSlot = this.stored, accountLabel?: string) {
    const limit = this.options.notifyAt?.() ?? 0;
    if (!limit) return;
    for (const group of groups) {
      const poolKey = quotaPoolId(group.models, group.title);
      if (group.used >= limit) {
        const resetAt = group.resetAt ? Date.parse(group.resetAt) || 0 : 0;
        const previous = slot.notified[poolKey] ?? slot.notified[group.key];
        if (previous == null || Math.abs(resetAt - previous) >= SAME_WINDOW_MS) {
          slot.notified[poolKey] = resetAt;
          slot.notified[group.key] = resetAt;
          this.options.notify?.(group.models, group.used, group.resetAt, accountLabel);
        }
      }
      if (group.week && group.week.used >= limit) {
        const weekPoolKey = `${poolKey}:week`;
        const weekKey = `${group.key}:week`;
        const resetAt = group.week.resetAt ? Date.parse(group.week.resetAt) || 0 : 0;
        const previous = slot.notified[weekPoolKey] ?? slot.notified[weekKey];
        if (previous == null || Math.abs(resetAt - previous) >= SAME_WINDOW_MS) {
          slot.notified[weekPoolKey] = resetAt;
          slot.notified[weekKey] = resetAt;
          this.options.notify?.(group.models, group.week.used, group.week.resetAt, accountLabel);
        }
      }
    }
  }
}

export const antigravityQuotaFile = () => path.join(dataFile("antigravity-quota.json"));

function calcAgyPressure(
  used: number,
  etaAt: number | null | undefined,
  resetAt: number | undefined,
  now: number,
  rule: PressureRule,
): "none" | "watch" | "high" {
  if (used >= 100) return "high";
  if (!etaAt || !resetAt || etaAt >= resetAt) return "none";
  if (used < rule.minUsed) return "watch";
  const remaining = Math.max(1, resetAt - now);
  return (resetAt - etaAt) / remaining >= rule.lockoutShare ? "high" : "watch";
}

function clampPct(value: number) {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function parseIsoMs(iso?: string): number | undefined {
  if (!iso) return undefined;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function slotToPetAccount(
  id: string,
  displayName: string,
  last: AgyLast | undefined,
  insight: AgyInsight | undefined,
  now: number,
  prefs: PressurePrefs,
): PetAccount | null {
  const groups = last?.groups ?? [];
  if (!groups.length) return null;
  const insightGroups = insight?.groups ?? [];
  const findInsight = (group: AgyGroupState) =>
    insightGroups.find((item) => item.key === group.key) ??
    insightGroups.find((item) => quotaPoolId(item.models, item.title) === quotaPoolId(group.models, group.title));

  const pickWindow = (kind: "five" | "week"): PetQuotaWindow | null => {
    const entries: { used: number; resetAt?: number; etaAt?: number; startAt?: number; endAt?: number }[] = [];
    for (const group of groups) {
      const ig = findInsight(group);
      if (kind === "five") {
        const w = ig?.five;
        const resetAt = parseIsoMs(group.resetAt);
        entries.push({
          used: clampPct(w?.used ?? group.used),
          resetAt,
          etaAt: w?.etaAt ?? undefined,
          startAt: w?.startAt,
          endAt: w?.endAt ?? resetAt,
        });
      } else if (group.week) {
        const w = ig?.week;
        const resetAt = parseIsoMs(group.week.resetAt);
        entries.push({
          used: clampPct(w?.used ?? group.week.used),
          resetAt,
          etaAt: w?.etaAt ?? undefined,
          startAt: w?.startAt,
          endAt: w?.endAt ?? resetAt,
        });
      }
    }
    if (!entries.length) return null;
    entries.sort((a, b) => b.used - a.used || (a.resetAt ?? Infinity) - (b.resetAt ?? Infinity));
    const chosen = entries[0];
    const spanMs = kind === "five" ? FIVE_MS : WEEK_MS;
    const endAt = chosen.endAt ?? chosen.resetAt;
    const startAt = chosen.startAt ?? (endAt != null ? endAt - spanMs : undefined);
    const rule = pressureRule(kind === "five" ? prefs.five : prefs.week, kind === "five" ? "relaxed" : "default");
    return {
      used: chosen.used,
      ...(chosen.resetAt != null ? { resetAt: chosen.resetAt } : {}),
      ...(chosen.etaAt != null ? { etaAt: chosen.etaAt } : {}),
      ...(startAt != null && endAt != null && endAt > startAt
        ? {
            elapsedH: Math.max(0, Math.min(now, endAt) - startAt) / HOUR,
            leftH: Math.max(0, endAt - now) / HOUR,
          }
        : {}),
      pressure: calcAgyPressure(chosen.used, chosen.etaAt, chosen.resetAt, now, rule),
    };
  };

  const five = pickWindow("five");
  const week = pickWindow("week");
  if (!five && !week) return null;
  return {
    kind: "antigravity",
    accountId: id,
    key: id,
    displayName,
    plan: last?.tier || last?.plan || "",
    lastCheckedAt: last?.at ?? 0,
    five,
    week,
  };
}

/** 把 Antigravity 额度状态转换成托盘面板、托盘悬停提示与桌宠共用的轻量账号摘要。 */
export function agyQuotaAccounts(
  state: AgyQuotaState,
  now = Date.now(),
  pressurePrefs = readPressurePrefs(),
): PetAccount[] {
  if (state.accounts.length) {
    return state.accounts
      .map((acc) => slotToPetAccount(acc.id, acc.displayName, acc.last, acc.insight, now, pressurePrefs))
      .filter((item): item is PetAccount => item !== null);
  }
  const single = slotToPetAccount("antigravity", "", state.last, state.insight, now, pressurePrefs);
  return single ? [single] : [];
}
