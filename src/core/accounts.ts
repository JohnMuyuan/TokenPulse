import { dataFile, readJson, writeJson } from "./paths";
import { refreshCredential, type RefreshResult } from "./token-refresh";
import {
  OFFICIAL_KINDS,
  isExpired,
  readCliAccounts,
  type CliAccount,
  type OfficialAccountKind,
  type OfficialCredential,
} from "./credentials";

export type { OfficialAccountKind, OfficialCredential };

/**
 * 官方账号库 `~/.tokenpulse/official-accounts.json`：一个服务商可以登记多个账号，没隐藏的都会查额度。
 *
 * 凭据只存 **TokenPulse 自己登录进来的**账号 —— 它们的 CLI 临时目录登录完就删了，这里是唯一一份，
 * 快过期时由 renewStoredCredentials 用它自己的 refresh token 续期。
 * CLI 自己正在用的账号只记名字：凭据每次现读 CLI 的文件，CLI 刷新 token 后这边自动跟上，
 * 复制一份反而会过期，还多一处泄露面；也绝不拿它去续期（会把 CLI 登出，见 credentials.ts）。
 *
 * 凭据永远不经过 IPC 到 renderer（见 main/oauth.ts 的 AccountView）。
 */

export type StoredOfficialAccount = {
  id: string;
  kind: OfficialAccountKind;
  ref: string;
  email: string;
  label: string;
  /** 用户在设置里起的名字。有它就显示它（首页、额度页、请求记录、托盘），没有就显示邮箱。 */
  alias?: string;
  /** 只有 TokenPulse 登录进来的账号才有。 */
  credential?: OfficialCredential;
  /** 续期被官方拒绝（refresh token 失效）时的原因。有它就不再重试，等用户重新登录。 */
  renewFailed?: string;
  /**
   * 在设置里删掉的 CLI 账号：CLI 还登录着它，每次读 CLI 都会重新登记回来，真删不掉，只能藏起来 ——
   * 不查额度、不在首页和额度页显示。在 TokenPulse 里重新登录这个账号，或者在设置里点「恢复」就回来。
   */
  hidden?: boolean;
  createdAt: number;
  lastSeenAt: number;
};

export type OfficialAccountStore = {
  /**
   * 2：身份改为 Claude accountUuid / ChatGPT 用户 + 工作区；凭据字段收窄。
   * 1 版的 Claude 账号全都叫 `claude:default`（互相覆盖），读到直接丢弃，按 CLI 当前登录重新识别。
   */
  version: 2;
  /** 数组顺序就是显示顺序（同一家之内）：设置里上移 / 下移改的就是它。 */
  accounts: StoredOfficialAccount[];
  /** 0.3.3 以前「只查一个账号」时选中的那个。现在所有账号都查，额度查询不再看它。 */
  active: Partial<Record<OfficialAccountKind, string>>;
  /** 删掉的账号 id：额度采样历史还留着（删了找不回来），报表里跳过它们。重新登录同一个账号就撤销。 */
  removed?: string[];
};

function file() {
  return dataFile("official-accounts.json");
}

export function accountIdOf(kind: OfficialAccountKind, ref: string) {
  return `${kind}:${ref}`;
}

function validAccount(item: any): item is StoredOfficialAccount {
  return Boolean(
    item &&
      typeof item.id === "string" &&
      OFFICIAL_KINDS.includes(item.kind) &&
      typeof item.ref === "string" &&
      typeof item.email === "string" &&
      typeof item.label === "string" &&
      typeof item.createdAt === "number" &&
      typeof item.lastSeenAt === "number" &&
      (item.alias === undefined || typeof item.alias === "string") &&
      (item.credential === undefined || typeof item.credential?.token === "string"),
  );
}

export function readOfficialAccountStore(): OfficialAccountStore {
  const parsed = readJson<any>(file(), null);
  if (parsed?.version !== 2 || !Array.isArray(parsed.accounts)) return { version: 2, accounts: [], active: {} };
  const accounts = parsed.accounts.filter(validAccount);
  const active: OfficialAccountStore["active"] = {};
  for (const kind of OFFICIAL_KINDS) {
    const id = parsed.active?.[kind];
    if (typeof id === "string" && accounts.some((item: StoredOfficialAccount) => item.id === id && item.kind === kind)) active[kind] = id;
  }
  const removed = Array.isArray(parsed.removed) ? parsed.removed.filter((id: unknown) => typeof id === "string") : [];
  return { version: 2, accounts, active, ...(removed.length ? { removed } : {}) };
}

export function writeOfficialAccountStore(store: OfficialAccountStore) {
  writeJson(file(), store);
  return store;
}

/**
 * 登记一个账号。`keepCredential` 为 true 表示这是 TokenPulse 自己登录进来的，要保存凭据；
 * 为 false（CLI 当前账号）时只更新名字，已存的凭据不动。
 */
export function rememberOfficialAccount(account: CliAccount, keepCredential: boolean, now = Date.now()) {
  const store = readOfficialAccountStore();
  const id = accountIdOf(account.kind, account.ref);
  const found = store.accounts.find((item) => item.id === id);
  const email = account.email || found?.email || "";
  const meta = { email, label: account.label, lastSeenAt: now };
  // 只读 CLI 的时候，删掉过的账号不再登记回来；在 TokenPulse 里重新登录才算用户要它回来
  if (!keepCredential && !found && store.removed?.includes(id)) return id;
  if (found) {
    // 额度每 5 分钟查一轮，CLI 登录没变也进来登记一次。名字和邮箱都没变就别写盘：
    // 这份文件里有 refresh token，没变化也整份重写只会增加和设置里拖动排序撞在一起的机会。
    if (!keepCredential && found.email === email && found.label === account.label) return id;
    Object.assign(found, meta);
    if (keepCredential) {
      found.credential = account.credential;
      delete found.renewFailed;
      delete found.hidden;
    }
  } else {
    store.accounts.push({
      id,
      kind: account.kind,
      ref: account.ref,
      ...meta,
      ...(keepCredential ? { credential: account.credential } : {}),
      createdAt: now,
    });
  }
  if (keepCredential && store.removed?.includes(id)) store.removed = store.removed.filter((item) => item !== id);
  writeOfficialAccountStore(store);
  return id;
}

/** 这一家要显示、要查额度的账号，按设置里排好的顺序。 */
export function visibleAccounts(kind: OfficialAccountKind, store: OfficialAccountStore = readOfficialAccountStore()) {
  return store.accounts.filter((item) => item.kind === kind && !item.hidden);
}

/**
 * 拖拽排序：给出这一家账号的新顺序（id 列表）。数组里三家混在一起放，只重排这一家占的那几个位置，别家不动。
 * 列表对不上（期间有账号被加 / 删）就报错，让界面重新读一遍，不去猜。
 */
export function reorderOfficialAccounts(kind: OfficialAccountKind, ids: string[]) {
  const store = readOfficialAccountStore();
  const slots = store.accounts.map((item, index) => (item.kind === kind ? index : -1)).filter((index) => index >= 0);
  const current = slots.map((index) => store.accounts[index]);
  if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every((id) => current.some((item) => item.id === id))) {
    throw new Error("账号列表已经变了，请重新打开设置再排");
  }
  ids.forEach((id, i) => {
    store.accounts[slots[i]] = current.find((item) => item.id === id)!;
  });
  return writeOfficialAccountStore(store);
}

/** 起名字 / 改名字。空的就是去掉名字，回到显示邮箱。 */
export const MAX_ALIAS = 40;
export function renameOfficialAccount(id: string, alias: string) {
  const store = readOfficialAccountStore();
  const target = store.accounts.find((item) => item.id === id);
  if (!target) throw new Error("找不到这个官方账号");
  const clean = alias.replace(/\s+/g, " ").trim().slice(0, MAX_ALIAS);
  if (clean && clean !== target.email) target.alias = clean;
  else delete target.alias;
  return writeOfficialAccountStore(store);
}

/**
 * 删除账号。`inCli`：CLI 现在还登录着它 —— 真删了下次读 CLI 又会登记回来，所以只藏起来（见 hidden）。
 * 不管哪种，TokenPulse 保存的凭据都删掉：用户说不要这个账号了，就别再留着它的 token。
 * 额度采样历史不删（官方不给历史，删了找不回来），记进 removed，报表跳过。
 */
export function removeOfficialAccount(id: string, inCli: boolean) {
  const store = readOfficialAccountStore();
  const target = store.accounts.find((item) => item.id === id);
  if (!target) throw new Error("找不到这个官方账号");
  if (inCli) {
    target.hidden = true;
    delete target.credential;
    delete target.renewFailed;
  } else {
    store.accounts = store.accounts.filter((item) => item.id !== id);
    store.removed = [...new Set([...(store.removed ?? []), id])];
  }
  if (store.active[target.kind] === id) delete store.active[target.kind];
  return writeOfficialAccountStore(store);
}

export function restoreOfficialAccount(id: string) {
  const store = readOfficialAccountStore();
  const target = store.accounts.find((item) => item.id === id);
  if (!target) throw new Error("找不到这个官方账号");
  delete target.hidden;
  return writeOfficialAccountStore(store);
}

/**
 * 某一个账号现在能用的凭据：CLI 正登录着它时，CLI 文件里的和 TokenPulse 存的哪份新用哪份（见 fresherCredential）；
 * 否则只能用 TokenPulse 存的。
 */
export function resolveAccountCredential(
  account: StoredOfficialAccount,
  now = Date.now(),
  live: CliAccount[] = readCliAccounts(account.kind),
) {
  const liveHit = live.find((item) => accountIdOf(account.kind, item.ref) === account.id);
  const credential = fresherCredential(liveHit?.credential, account.credential, now);
  return { credential, inCli: Boolean(liveHit), expired: isExpired(credential, now) };
}

export function setActiveOfficialAccount(kind: OfficialAccountKind, id: string) {
  const store = readOfficialAccountStore();
  if (!store.accounts.some((item) => item.kind === kind && item.id === id)) throw new Error("找不到这个官方账号");
  store.active[kind] = id;
  writeOfficialAccountStore(store);
  return store;
}

export type ActiveAccount = {
  id?: string;
  email?: string;
  credential?: OfficialCredential;
  /** cli：CLI 当前登录（凭据现读，最新）；stored：TokenPulse 保存的；none：没有可用账号。 */
  source: "cli" | "stored" | "none";
  expired: boolean;
};

/**
 * 同一个账号的两份凭据挑新的：`cli` 是 CLI 文件里的，`stored` 是 TokenPulse 登录时存的。
 * 没过期的优先；都没过期（或都过期）取过期时间更晚的；有一份没写过期时间就比不出来，用 CLI 的。
 *
 * 不能无条件信 CLI 的：CLI 只在自己被使用时才续期。实测 Grok CLI 的凭据已过期 34 小时，
 * 用户在 TokenPulse 里重新登录了同一个账号，存下的新凭据还有 6 小时 —— 以前一律取 CLI 那份，
 * 设置页一直显示「凭据已过期」，额度也不查。
 */
export function fresherCredential(cli: OfficialCredential | undefined, stored: OfficialCredential | undefined, now = Date.now()) {
  if (!cli || !stored) return cli ?? stored;
  const cliOk = !isExpired(cli, now), storedOk = !isExpired(stored, now);
  if (cliOk !== storedOk) return cliOk ? cli : stored;
  if (cli.expiresAt == null || stored.expiresAt == null) return cli;
  return stored.expiresAt > cli.expiresAt ? stored : cli;
}

/**
 * 额度查询该用哪个账号、哪份凭据。唯一的决策点，quota.ts 和设置页都走这里。
 *
 * - 没选过活动账号：用 CLI 当前登录的那个（和 0.2 行为一致）；
 * - 选了、而且 CLI 现在正登录着它：CLI 文件里的和 TokenPulse 存的，哪份新用哪份；
 * - 选了、但 CLI 已经换成别的账号：用 TokenPulse 保存的凭据，没有或已过期就如实报告，
 *   **不回退到 CLI 当前账号** —— 那样额度会悄悄变成另一个人的。
 */
export function resolveActiveAccount(
  kind: OfficialAccountKind,
  now = Date.now(),
  live: CliAccount[] = readCliAccounts(kind),
  store: OfficialAccountStore = readOfficialAccountStore(),
): ActiveAccount {
  const activeId = store.active[kind];
  const liveHit = activeId ? live.find((item) => accountIdOf(kind, item.ref) === activeId) : live[0];
  const id = liveHit ? accountIdOf(kind, liveHit.ref) : activeId;
  const stored = id ? store.accounts.find((item) => item.id === id) : undefined;
  if (liveHit) {
    const credential = fresherCredential(liveHit.credential, stored?.credential, now);
    return { id, email: liveHit.email, credential, source: credential === liveHit.credential ? "cli" : "stored", expired: isExpired(credential, now) };
  }
  if (!stored) return { source: "none", expired: false };
  return { id: stored.id, email: stored.email, credential: stored.credential, source: stored.credential ? "stored" : "none", expired: isExpired(stored.credential, now) };
}

/** 离过期不到这么久就续期。额度每 5 分钟查一次，留足几轮重试的余地。 */
export const RENEW_BEFORE_MS = 30 * 60_000;

let renewing: Promise<number> | null = null;

/**
 * 给快过期的 **TokenPulse 登录的账号**续期，返回续期成功的个数。查额度前、打开账号列表前都会调。
 *
 * - 同一时间只跑一轮：两轮同时拿同一个 refresh token 去换，后一个会让前一个换到的新 token 作废；
 * - 每成功一个就立刻写盘：新的 refresh token 只有这一份，进程这时候被杀就再也续不上；
 * - 写之前重读账号库，只改这一个账号：续期要走网络，这期间用户可能刚添加 / 切换了账号。
 */
export function renewStoredCredentials(now = Date.now(), refresh: typeof refreshCredential = refreshCredential): Promise<number> {
  if (!renewing) {
    renewing = (async () => {
      let renewed = 0;
      const due = readOfficialAccountStore().accounts.filter(
        (item) => item.credential?.refreshToken && !item.renewFailed && item.credential.expiresAt != null && item.credential.expiresAt - now < RENEW_BEFORE_MS,
      );
      for (const account of due) {
        const result: RefreshResult = await refresh(account.kind, account.credential!, now);
        if (!result.ok && !result.permanent) continue;
        const store = readOfficialAccountStore();
        const target = store.accounts.find((item) => item.id === account.id);
        // 这期间用户重新登录过这个账号：以新登录的为准，这次续期的结果丢掉。
        if (!target || target.credential?.refreshToken !== account.credential!.refreshToken) continue;
        if (result.ok) {
          target.credential = result.credential;
          delete target.renewFailed;
          renewed += 1;
        } else {
          target.renewFailed = result.error;
        }
        writeOfficialAccountStore(store);
      }
      return renewed;
    })().finally(() => {
      renewing = null;
    });
  }
  return renewing;
}
