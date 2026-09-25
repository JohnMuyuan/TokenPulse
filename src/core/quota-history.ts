import { dataFile, readJson, writeJson } from "./paths";
import type { AccountKind, OfficialQuota, OfficialQuotaMap } from "./quota";

/**
 * 官方额度的历史采样，额度监控靠它算「消耗速度」「预计什么时候用完」。
 *
 * 官方接口只给**这一刻**的已用百分比，不给历史 —— 不自己记，就永远只有一个点。
 * 所以每次真的去问了接口（`fetchOfficialQuota` 没走缓存的那次），就在这里记一笔。
 *
 * 存 `~/.tokenpulse/quota-history.json`：
 * - 永久保留：官方不给历史，删了就再也找不回来；
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
  /** 哪个账号的采样（0.3 起）。更早的采样没有这一项，都来自 CLI 当时登录的账号。 */
  account?: string;
};

export type QuotaHistory = { version: 1; accounts: Record<string, QuotaSample[]> };

const FLAT_EVERY_MS = 15 * 60_000;
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
    a.resetCredits === b.resetCredits &&
    a.account === b.account
  );
}

/**
 * 每家最后一次**查询成功**的时间，和采样历史分开记。
 *
 * 采样历史为了不膨胀，数值没变时 15 分钟才记一条；界面以前拿「最后一条采样」判断过期（阈值也是 15 分钟），
 * 于是额度一不动（= 用户没在用），最后一条采样就落后 15–20 分钟，明明每 5 分钟都查成功了却显示「采样已过期」。
 * 过期要看的是「最后一次查询成功」，这里每次都更新；单独一个小文件，免得每 5 分钟重写整份历史。
 */
export type QuotaChecks = Partial<Record<AccountKind, { at: number; account?: string }>> & {
  /** 0.3.3 起一家可以同时查好几个账号：每个账号各自最后一次查询成功的时间。 */
  accounts?: Record<string, number>;
};

function checksFile() {
  return dataFile("quota-checked.json");
}

export function readQuotaChecks(): QuotaChecks {
  const parsed = readJson<QuotaChecks | null>(checksFile(), null);
  return parsed && typeof parsed === "object" ? parsed : {};
}

/** 这一轮查到的所有账号：有 all 用 all（0.3.3 起），否则按家各取一份（老调用方式、测试）。 */
function quotasOf(map: OfficialQuotaMap): Array<OfficialQuota & { kind: AccountKind }> {
  const list = map.all ?? KINDS.map((kind) => (map[kind] ? { ...map[kind]!, kind } : undefined));
  return list.filter((quota): quota is OfficialQuota & { kind: AccountKind } =>
    Boolean(quota?.kind && KINDS.includes(quota.kind) && (quota.weekPct != null || quota.fiveHourPct != null)),
  );
}

/** 完全删除一个 TokenPulse 账号的额度采样与查询检查记录。 */
export function forgetQuotaAccount(accountId: string) {
  if (!accountId) return;
  const history = readQuotaHistory();
  let historyChanged = false;
  for (const kind of KINDS) {
    const list = history.accounts[kind];
    if (!list) continue;
    const next = list.filter((sample) => sample.account !== accountId);
    if (next.length !== list.length) {
      historyChanged = true;
      if (next.length) history.accounts[kind] = next;
      else delete history.accounts[kind];
    }
  }
  if (historyChanged) writeJson(historyFile(), history);

  const checks = readQuotaChecks();
  let checksChanged = false;
  if (checks.accounts?.[accountId] != null) {
    delete checks.accounts[accountId];
    checksChanged = true;
    if (!Object.keys(checks.accounts).length) delete checks.accounts;
  }
  for (const kind of KINDS) {
    if (checks[kind]?.account !== accountId) continue;
    delete checks[kind];
    checksChanged = true;
  }
  if (checksChanged) writeJson(checksFile(), checks);
}
/** 记一轮采样。返回有没有真的写（采样历史）文件；查询成功时间每次都更新。 */
export function recordQuotaSamples(map: OfficialQuotaMap, now = Date.now()) {
  const quotas = quotasOf(map);
  const checks = readQuotaChecks();
  for (const quota of quotas) {
    // 按家那一项留给老版本读：记排在最前的那个账号
    if (!checks[quota.kind] || checks[quota.kind]!.at !== now) checks[quota.kind] = { at: now, account: quota.accountId };
    if (quota.accountId) (checks.accounts ??= {})[quota.accountId] = now;
  }
  if (quotas.length) writeJson(checksFile(), checks);

  const history = readQuotaHistory();
  let changed = false;
  for (const quota of quotas) {
    const kind = quota.kind;
    const sample: QuotaSample = {
      at: now,
      five: quota.fiveHourPct,
      fiveReset: quota.fiveHourReset,
      week: quota.weekPct,
      weekReset: quota.weekReset,
      weekStart: quota.weekStart,
      resetCredits: quota.resetCredits,
      plan: quota.plan,
      account: quota.accountId,
    };
    const list = (history.accounts[kind] ??= []);
    // 同一家好几个账号的采样交错排在一起：去重要和**同一个账号**的上一条比
    let last: QuotaSample | undefined;
    for (let i = list.length - 1; i >= 0 && !last; i--) if (list[i].account === sample.account) last = list[i];
    if (last && now <= last.at) continue;
    if (last && same(last, sample) && now - last.at < FLAT_EVERY_MS) continue;
    list.push(sample);
    changed = true;
  }
  if (!changed) return false;
  writeJson(historyFile(), history);
  return true;
}
