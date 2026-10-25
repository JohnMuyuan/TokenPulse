import { accountIdOf } from "./accounts";
import { OFFICIAL_KINDS, readCliAccounts, type OfficialAccountKind } from "./credentials";

/**
 * 「后台账号少查一点」（prefs.quotaQuietBackground，默认关）。
 *
 * 有用户担心同一台电脑定时轮询一堆官方账号，想让没在用的账号安静点。开了以后，只有定时的那轮额度查询这样挑：
 * - 在用的账号照常每轮查：各家 CLI 当前登录的、号池里的、桌宠固定看的；
 * - 其他账号（后台账号）离上次查满 QUIET_EVERY_MS 才查一次；
 * 手动刷新、登录 / 切换账号之后那轮照常全查；自动切号要用候选账号的额度时先临时查一次（见 cli-auto-switch.ts 的 autoSwitchStale）。
 * 它只是少发请求：官方限流大多按账号算，不能防止在用的账号被限流（那个靠 quota.ts 的冷却退避）。
 */

export const QUIET_EVERY_MS = 30 * 60_000;
/** 后台账号的额度多久没更新才算过期：间隔加上余量（定时器最长 10 分钟一轮）。 */
export const QUIET_STALE_MS = 45 * 60_000;

/** 现在在用的官方账号 id：各家 CLI 当前登录的，再加上调用方给的（号池成员、桌宠固定看的）。 */
export function foregroundAccounts(extra: Iterable<string> = [], cli: (kind: OfficialAccountKind) => string[] = cliAccountIds): Set<string> {
  const out = new Set<string>();
  for (const id of extra) if (id) out.add(id);
  for (const kind of OFFICIAL_KINDS) {
    try {
      for (const id of cli(kind)) out.add(id);
    } catch {
      // 读不了 CLI 的登录文件：当作没登录
    }
  }
  return out;
}

function cliAccountIds(kind: OfficialAccountKind) {
  return readCliAccounts(kind).map((item) => accountIdOf(kind, item.ref));
}

/**
 * 后台账号上次去查的时间（不管查没查到）。只记在内存里：查失败（网络、出错）也要等满间隔再试，
 * 不然一直查不到的后台账号每轮都会再问一次；重启后从头算，最多多查一次。
 */
const tried = new Map<string, number>();

/**
 * 这一轮要不要查这个账号：在用的照查；后台的离上次查到（checks，quota-checked.json 里每个账号的时间）
 * 或上次去查都满 QUIET_EVERY_MS 才查。返回 true 时记下这次去查的时间。
 */
export function quietPick(foreground: Set<string>, checks: Record<string, number> = {}, now = Date.now()) {
  return (_kind: OfficialAccountKind, id: string) => {
    if (foreground.has(id)) return true;
    const last = Math.max(checks[id] ?? 0, tried.get(id) ?? 0);
    if (now - last < QUIET_EVERY_MS) return false;
    tried.set(id, now);
    return true;
  };
}

/** 测试用：清掉内存里的「上次去查」。 */
export function resetQuietForTests() {
  tried.clear();
}
