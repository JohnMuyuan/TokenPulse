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
 * 官方账号库 `~/.tokenpulse/official-accounts.json`：一个服务商可以登记多个账号，只有「活动」的那个参与额度查询。
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
  /** 只有 TokenPulse 登录进来的账号才有。 */
  credential?: OfficialCredential;
  /** 续期被官方拒绝（refresh token 失效）时的原因。有它就不再重试，等用户重新登录。 */
  renewFailed?: string;
  createdAt: number;
  lastSeenAt: number;
};

export type OfficialAccountStore = {
  /**
   * 2：身份改为 Claude accountUuid / ChatGPT 用户 + 工作区；凭据字段收窄。
   * 1 版的 Claude 账号全都叫 `claude:default`（互相覆盖），读到直接丢弃，按 CLI 当前登录重新识别。
   */
  version: 2;
  accounts: StoredOfficialAccount[];
  active: Partial<Record<OfficialAccountKind, string>>;
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
  return { version: 2, accounts, active };
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
  const meta = { email: account.email || found?.email || "", label: account.label, lastSeenAt: now };
  if (found) {
    Object.assign(found, meta);
    if (keepCredential) {
      found.credential = account.credential;
      delete found.renewFailed;
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
  writeOfficialAccountStore(store);
  return id;
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
