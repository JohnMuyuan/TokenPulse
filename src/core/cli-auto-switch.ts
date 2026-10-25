import { readOfficialAccountStore, accountIdOf, type OfficialAccountKind } from "./accounts";
import { readCliAccounts } from "./credentials";
import { accountQuota, leftOf, type MemberQuota } from "./pool-order";
import { dataFile, readJson, writeJson } from "./paths";

/**
 * 额度用满自动切 CLI 登录（0.3.55）。
 *
 * 号池要走本地路由才会自动换号；直接用官方 CLI 登录时，5 小时 / 每周额度用满了还得自己去设置里点「切到 CLI」。
 * 这里在每轮额度查询之后看一眼：CLI 现在登录的账号，两个窗口里剩得少的那个已用到设定比例（rule.at），
 * 就切到 TokenPulse 托管的、剩余最多的另一个账号（照样走 cli-switch.ts 的 switchCliAccount）。
 *
 * 规则：
 * - 每家单独开关，默认关；供应商「只读保护」开着时不动；这家工具现在用的不是官方登录（第三方供应商 / 号池）时不动 —— 换 CLI 登录没意义；
 * - 只切到能切的账号：TokenPulse 存着能续期的登录、没隐藏、额度采样是新的（30 分钟内），剩余比当前账号的触发线多 MIN_GAIN 个百分点
 *   （「后台账号少查一点」开着时，切之前先临时查一次候选账号，见 autoSwitchStale）；
 * - 一家切过之后 COOLDOWN_MS 内不再切（等新账号的额度查回来，也避免来回跳）；切换失败同样冷却；
 * - 没有能切的号：只提醒一次，直到当前账号回到触发线以下或换了账号。
 * 每次动作记进 `cli-auto-switch.json`（最近 MAX_EVENTS 条），不含凭据。
 */

export type AutoSwitchKind = OfficialAccountKind;
export type AutoSwitchRule = { on: boolean; /** 已用到这个百分比就切。 */ at: number };
export const AUTO_SWITCH_LEVELS = [90, 95, 99] as const;
export const AUTO_SWITCH_DEFAULT_AT = 95;

export type AutoSwitchEvent = {
  at: number;
  kind: AutoSwitchKind;
  result: "switched" | "no-target" | "failed";
  from: string;
  /** 触发的是哪个窗口、当时已用多少。 */
  window: "five" | "week";
  used: number;
  to?: string;
  /** 切过去的账号当时剩多少（两个窗口里少的那个）。 */
  toLeft?: number;
  error?: string;
};

export const COOLDOWN_MS = 10 * 60_000;
/** 目标账号至少要比触发线多剩这么多个百分点，不然切过去马上又满。 */
export const MIN_GAIN = 10;
const MAX_EVENTS = 50;

export type AutoSwitchDeps = {
  now?: number;
  rules: Partial<Record<AutoSwitchKind, AutoSwitchRule>>;
  /** 供应商只读保护开着。 */
  readOnly?: boolean;
  /** 这家工具现在用的是不是官方登录。 */
  usesOfficial: (kind: AutoSwitchKind) => boolean;
  switchTo: (id: string) => Promise<unknown>;
  quota?: (id: string, now: number) => MemberQuota | null;
  current?: (kind: AutoSwitchKind) => string | undefined;
};

export function normalizeRule(raw: unknown): AutoSwitchRule {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const at = Number(value.at);
  return { on: value.on === true, at: (AUTO_SWITCH_LEVELS as readonly number[]).includes(at) ? at : AUTO_SWITCH_DEFAULT_AT };
}

function eventsFile() {
  return dataFile("cli-auto-switch.json");
}
export function readAutoSwitchEvents(): AutoSwitchEvent[] {
  const list = readJson<{ events?: AutoSwitchEvent[] }>(eventsFile(), {}).events;
  return Array.isArray(list) ? list : [];
}
function remember(event: AutoSwitchEvent) {
  try { writeJson(eventsFile(), { events: [...readAutoSwitchEvents(), event].slice(-MAX_EVENTS) }); } catch { /* 记不下不影响切换 */ }
}

function currentCliAccount(kind: AutoSwitchKind) {
  const live = readCliAccounts(kind)[0];
  return live ? accountIdOf(kind, live.ref) : undefined;
}

/** 两个窗口里剩得少的那个是哪个窗口、已用多少。 */
function tightest(quota: MemberQuota) {
  const windows = (["five", "week"] as const).filter((name) => quota[name]).map((name) => ({ name, used: 100 - quota[name]!.left }));
  return windows.sort((a, b) => b.used - a.used)[0];
}

/** 能切过去的账号：TokenPulse 存着能续期的登录、没隐藏、不是现在这个。 */
function candidatesOf(kind: AutoSwitchKind, from: string) {
  return readOfficialAccountStore().accounts
    .filter((item) => item.kind === kind && item.id !== from && !item.hidden && item.credential?.refreshToken && !item.renewFailed)
    .map((item) => item.id);
}

/** 这家现在该切号了吗：开了、用的是官方登录、CLI 当前账号已用到触发线。返回当前账号和触发的窗口。 */
function dueOf(kind: AutoSwitchKind, deps: AutoSwitchDeps, now: number) {
  const rule = normalizeRule(deps.rules[kind]);
  if (!rule.on) return null;
  let official = false;
  try { official = deps.usesOfficial(kind); } catch { official = false; }
  if (!official) return null;
  const from = (deps.current ?? currentCliAccount)(kind);
  const quota = from ? (deps.quota ?? accountQuota)(from, now) : null;
  const hit = quota ? tightest(quota) : undefined;
  return from && hit ? { rule, from, hit, due: hit.used >= rule.at } : null;
}

/** 候选账号的额度要在这之内查到过，才不用先临时查。 */
export const FRESH_MS = 5 * 60_000;

/**
 * 「后台账号少查一点」开着时，后台账号半小时才查一次：哪家这一轮该切号了、候选账号的额度又不够新（FRESH_MS 内没查到），
 * 返回这些候选账号，调用方先临时查一次再切（切号只认 30 分钟内的额度，旧了会误报「没有能切的号」）。
 */
export function autoSwitchStale(deps: AutoSwitchDeps): string[] {
  const now = deps.now ?? Date.now();
  const quotaOf = deps.quota ?? accountQuota;
  const out: string[] = [];
  if (deps.readOnly) return out;
  for (const kind of ["claude", "chatgpt", "grok"] as const) {
    const state = dueOf(kind, deps, now);
    if (!state?.due || now - (lastSwitchAt.get(kind) ?? 0) < COOLDOWN_MS) continue;
    for (const id of candidatesOf(kind, state.from)) {
      const quota = quotaOf(id, now);
      if (!quota || now - quota.at > FRESH_MS) out.push(id);
    }
  }
  return out;
}

/** 冷却和「没有能切的号只提醒一次」记在内存里：重启后重新判断，最多多提醒一次。 */
const lastSwitchAt = new Map<AutoSwitchKind, number>();
const stuckOn = new Map<AutoSwitchKind, string>();
let running: Promise<AutoSwitchEvent[]> | null = null;

/** 每轮额度查询之后调一次。返回这一轮发生的事（给通知用）。 */
export function autoSwitchCli(deps: AutoSwitchDeps): Promise<AutoSwitchEvent[]> {
  if (!running) running = run(deps).finally(() => { running = null; });
  return running;
}

async function run(deps: AutoSwitchDeps): Promise<AutoSwitchEvent[]> {
  const now = deps.now ?? Date.now();
  const quotaOf = deps.quota ?? accountQuota;
  const events: AutoSwitchEvent[] = [];
  if (deps.readOnly) return events;
  for (const kind of ["claude", "chatgpt", "grok"] as const) {
    const state = dueOf(kind, deps, now);
    if (!state?.due) {
      stuckOn.delete(kind);
      continue;
    }
    const { rule, from, hit } = state;
    if (now - (lastSwitchAt.get(kind) ?? 0) < COOLDOWN_MS) continue;

    const need = 100 - rule.at + MIN_GAIN;
    const candidates = candidatesOf(kind, from)
      .map((id) => ({ id, left: leftOf(quotaOf(id, now)) }))
      .filter((item): item is { id: string; left: number } => item.left != null && item.left >= need);
    // 剩余最多的先；一样多的保持设置里的顺序（sort 是稳定的）
    candidates.sort((a, b) => b.left - a.left);
    const target = candidates[0];
    const base = { at: now, kind, from, window: hit.name, used: Math.round(hit.used * 10) / 10 };
    if (!target) {
      if (stuckOn.get(kind) === from) continue;
      stuckOn.set(kind, from);
      const event: AutoSwitchEvent = { ...base, result: "no-target" };
      remember(event);
      events.push(event);
      continue;
    }
    lastSwitchAt.set(kind, now);
    stuckOn.delete(kind);
    let event: AutoSwitchEvent;
    try {
      await deps.switchTo(target.id);
      event = { ...base, result: "switched", to: target.id, toLeft: Math.round(target.left * 10) / 10 };
    } catch (error) {
      event = { ...base, result: "failed", to: target.id, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
    }
    remember(event);
    events.push(event);
  }
  return events;
}

const CLI_NAME: Record<AutoSwitchKind, string> = { claude: "Claude Code", chatgpt: "Codex", grok: "Grok CLI" };
function nameOf(id: string | undefined) {
  const account = id ? readOfficialAccountStore().accounts.find((item) => item.id === id) : undefined;
  return account?.alias || account?.email || account?.label || id || "";
}
/** 通知和设置页共用的说法。 */
export function describeAutoSwitch(event: AutoSwitchEvent) {
  const cli = CLI_NAME[event.kind];
  const windowName = event.window === "five" ? "5 小时" : "每周";
  const from = nameOf(event.from);
  if (event.result === "switched") {
    return { title: `已把 ${cli} 切到 ${nameOf(event.to)}`, body: `${from} 的${windowName}额度已用 ${event.used}%，新账号剩 ${event.toLeft}%。已经开着的会话要重新打开才会用新账号。` };
  }
  if (event.result === "no-target") {
    return { title: `${cli} 的账号快用完了，没有能切的号`, body: `${from} 的${windowName}额度已用 ${event.used}%，其他托管账号剩得也不多，或者还没查到额度。` };
  }
  return { title: `${cli} 没能自动切换账号`, body: `想从 ${from} 切到 ${nameOf(event.to)}：${event.error || "切换失败"}` };
}

/** 测试用：清掉内存里的冷却和提醒记录。 */
export function resetAutoSwitchForTests() {
  lastSwitchAt.clear();
  stuckOn.clear();
}
