import { dataFile, readJson, writeJson } from "./paths";
import type { AccountKind, OfficialQuotaMap } from "./quota";

/**
 * 官方额度的历史采样，额度监控靠它算「消耗速度」「预计什么时候用完」。
 *
 * 官方接口只给**这一刻**的已用百分比，不给历史 —— 不自己记，就永远只有一个点。
 * 所以每次真的去问了接口（`fetchOfficialQuota` 没走缓存的那次），就在这里记一笔。
 *
 * 存 `~/.tokenpulse/quota-history.json`：
 * - 只留 45 天（额度监控最多看一周，多留点给以后画长期曲线）；
 * - 百分比和重置时间都没变的，15 分钟内只记一次 —— 否则一晚上不用也要写几百条一样的；
 *   但也不能完全不记：隔一段时间记一笔「还是这么多」，曲线上才看得出这段时间确实没涨。
 */

export type QuotaSample = {
  at: number;
  five?: number;
  fiveReset?: string;
  week?: number;
  weekReset?: string;
  weekStart?: string;
  resetCredits?: number;
  plan?: string;
};

export type QuotaHistory = { version: 1; accounts: Record<string, QuotaSample[]> };

const KEEP_MS = 45 * 86_400_000;
const FLAT_EVERY_MS = 15 * 60_000;
/** 5 分钟一条、45 天也就一万出头，这个上限只防意外（比如时钟乱跳）。 */
const MAX_PER_ACCOUNT = 20_000;
const KINDS: AccountKind[] = ["claude", "chatgpt", "grok"];

function historyFile() {
  return dataFile("quota-history.json");
}

export function readQuotaHistory(): QuotaHistory {
  const parsed = readJson<QuotaHistory | null>(historyFile(), null);
  if (parsed?.version === 1 && parsed.accounts && typeof parsed.accounts === "object") return parsed;
  return { version: 1, accounts: {} };
}

/**
 * 重置时间在一分钟内算同一个。
 * Claude 每次返回的 resets_at 都带着几百毫秒的抖动（实测 `08:19:59.398` / `08:20:00.474`
 * 交替出现），逐字比较的话「没变化」永远不成立，15 分钟去重形同虚设。
 */
export function sameReset(a?: string, b?: string) {
  if (a === b) return true;
  if (!a || !b) return false;
  const diff = Math.abs(Date.parse(a) - Date.parse(b));
  return Number.isFinite(diff) && diff < 60_000;
}

function same(a: QuotaSample, b: QuotaSample) {
  return (
    a.five === b.five &&
    a.week === b.week &&
    sameReset(a.fiveReset, b.fiveReset) &&
    sameReset(a.weekReset, b.weekReset) &&
    a.resetCredits === b.resetCredits
  );
}

/** 记一轮采样。返回有没有真的写文件。 */
export function recordQuotaSamples(map: OfficialQuotaMap, now = Date.now()) {
  const history = readQuotaHistory();
  let changed = false;
  for (const kind of KINDS) {
    const quota = map[kind];
    if (!quota || (quota.weekPct == null && quota.fiveHourPct == null)) continue;
    const sample: QuotaSample = {
      at: now,
      five: quota.fiveHourPct,
      fiveReset: quota.fiveHourReset,
      week: quota.weekPct,
      weekReset: quota.weekReset,
      weekStart: quota.weekStart,
      resetCredits: quota.resetCredits,
      plan: quota.plan,
    };
    const list = (history.accounts[kind] ??= []);
    const last = list.at(-1);
    if (last && now <= last.at) continue;
    if (last && same(last, sample) && now - last.at < FLAT_EVERY_MS) continue;
    list.push(sample);
    const cutoff = now - KEEP_MS;
    const firstKept = list.findIndex((item) => item.at >= cutoff);
    if (firstKept > 0) list.splice(0, firstKept);
    if (list.length > MAX_PER_ACCOUNT) list.splice(0, list.length - MAX_PER_ACCOUNT);
    changed = true;
  }
  if (!changed) return false;
  writeJson(historyFile(), history);
  return true;
}
