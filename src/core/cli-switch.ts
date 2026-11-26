import fs from "fs";
import path from "path";
import os from "os";
import { recordCliLogins } from "./login-timeline";
import { accountIdOf, fresherCredential, readOfficialAccountStore, renewStoredCredentials, runWithKindRenewalLock, writeOfficialAccountStore, type StoredOfficialAccount } from "./accounts";
import { authFile, claudeProfileFile, isExpired, readCliAccounts, type OfficialAccountKind, type OfficialCredential } from "./credentials";
import { setClaudeCliSwitching, waitCliRenewIdle } from "./cli-renew";
import { dataDir } from "./paths";
import { refreshCredential } from "./token-refresh";

/**
 * 一键切换 CLI 的登录账号（0.3.49）：把 TokenPulse 保存的某个账号的登录写进官方 CLI 的凭据文件，省得用户自己去 CLI 里登出再登录。
 *
 * refresh token 同一时间只能有一个主人（Claude / ChatGPT 用一次就换新，见 credentials.ts）：
 * - 切进 CLI 的账号：凭据交给 CLI，TokenPulse 删掉自己存的那份，之后跟 CLI 账号一样现读 CLI 的文件，不再自己续期；
 * - 被换下来的账号：先把 CLI 手里最新的那份凭据收进 TokenPulse，之后由 TokenPulse 续期，下次还能切回去。
 * 写之前把 CLI 原来的文件备份一份（数据目录 backups/cli-switch，只留最近 10 次），写完读回来核对，不对就原样放回去。
 *
 * cliAuth 是 CLI 凭据文件里除 token 以外、切回去时要一起写回的部分（Claude 的 scopes / 套餐和 .claude.json 的 oauthAccount，
 * Codex 的 id_token，Grok 那一行的用户资料）。在 TokenPulse 里登录、或者被换下来时记下。
 */
export type CliAuthSnapshot = Record<string, unknown>;

function readJsonFile(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return undefined; }
}
const WIN_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
function sleepSync(ms: number) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* fallback */ }
  }
}
export function writeAtomic(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tokenpulse-${process.pid}-${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    const maxAttempts = process.platform === "win32" ? 6 : 1;
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | null)?.code ?? "";
        if (attempt + 1 < maxAttempts && WIN_RETRY_CODES.has(code)) {
          if (code === "EPERM" || code === "EACCES") {
            try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
          }
          sleepSync(15 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}
const without = (obj: Record<string, unknown> | undefined, keys: string[]) => Object.fromEntries(Object.entries(obj || {}).filter(([key]) => !keys.includes(key)));

function grokRow(home: string) {
  const parsed = readJsonFile(authFile("grok", home));
  if (!parsed || typeof parsed !== "object") return undefined;
  return Object.entries<any>(parsed).find(([, row]) => typeof row?.key === "string" && row.key);
}

/** CLI 当前登录的 cliAuth（不含 access / refresh token）。isolated 见 credentials.ts 的 claudeProfileFile。 */
export function readCliSnapshot(kind: OfficialAccountKind, home = os.homedir(), isolated = false): CliAuthSnapshot | undefined {
  if (kind === "claude") {
    const oauth = readJsonFile(authFile("claude", home))?.claudeAiOauth;
    if (!oauth) return undefined;
    return { oauth: without(oauth, ["accessToken", "refreshToken", "expiresAt", "refreshTokenExpiresAt"]), account: readJsonFile(claudeProfileFile(home, isolated))?.oauthAccount };
  }
  if (kind === "chatgpt") {
    const auth = readJsonFile(authFile("chatgpt", home));
    if (!auth?.tokens) return undefined;
    return { auth_mode: auth.auth_mode, id_token: auth.tokens.id_token, account_id: auth.tokens.account_id };
  }
  const hit = grokRow(home);
  return hit ? { rowKey: hit[0], row: without(hit[1], ["key", "refresh_token", "expires_at"]) } : undefined;
}

export type SwitchResult = { ok: true; message: string };

function backup(kind: OfficialAccountKind, files: string[]) {
  const root = path.join(dataDir(), "backups", "cli-switch");
  const dir = path.join(root, `${Date.now()}-${kind}`);
  fs.mkdirSync(dir, { recursive: true });
  const saved = files.map((file, index) => {
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (text !== null) fs.writeFileSync(path.join(dir, `${index}-${path.basename(file)}`), text, { mode: 0o600 });
    return { file, text };
  });
  try {
    const all = fs.readdirSync(root).sort();
    for (const name of all.slice(0, Math.max(0, all.length - 10))) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  } catch { /* 清不掉旧备份不影响切换 */ }
  return saved;
}

/** 要写的 CLI 文件及新内容。 */
function plan(kind: OfficialAccountKind, account: StoredOfficialAccount, credential: OfficialCredential, snap: CliAuthSnapshot | undefined, home: string) {
  if (kind === "claude") {
    if (account.ref.startsWith("token:")) throw new Error("这个 Claude 账号认不出账号 ID，不能切换。请在设置里重新登录它一次。");
    const credFile = authFile("claude", home), profileFile = claudeProfileFile(home);
    const creds = readJsonFile(credFile) || {};
    const current = creds.claudeAiOauth || {};
    const kept = (snap?.oauth as Record<string, unknown>) || { scopes: current.scopes || ["user:inference", "user:profile", "user:sessions:claude_code"] };
    creds.claudeAiOauth = { ...kept, accessToken: credential.token, refreshToken: credential.refreshToken, expiresAt: credential.expiresAt };
    const profile = readJsonFile(profileFile);
    if (fs.existsSync(profileFile) && !profile) throw new Error(".claude.json 读不出来，没有切换");
    const known = snap?.account as Record<string, unknown> | undefined;
    // 没记下完整资料时只写身份：Claude Code 发现资料不全会自己去官方再取一次
    const oauthAccount = known?.accountUuid === account.ref ? known : { accountUuid: account.ref, emailAddress: account.email };
    return [
      { file: credFile, text: JSON.stringify(creds, null, 2) },
      { file: profileFile, text: JSON.stringify({ ...(profile || {}), oauthAccount }, null, 2) },
    ];
  }
  if (kind === "chatgpt") {
    const file = authFile("chatgpt", home);
    const auth = readJsonFile(file) || {};
    if (!snap?.id_token) throw new Error("缺少 Codex 的身份信息");
    auth.auth_mode = snap.auth_mode || auth.auth_mode || "chatgpt";
    auth.OPENAI_API_KEY = null;
    auth.tokens = { id_token: snap.id_token, access_token: credential.token, refresh_token: credential.refreshToken, account_id: credential.accountId || snap.account_id };
    auth.last_refresh = new Date().toISOString();
    return [{ file, text: JSON.stringify(auth, null, 2) }];
  }
  const file = authFile("grok", home);
  const auth = readJsonFile(file) || {};
  const existing = grokRow(home);
  if (!credential.issuer || !credential.clientId) throw new Error("这个 Grok 账号的登录缺少签发方信息，请在设置里重新登录它一次。");
  const key = (snap?.rowKey as string) || `${credential.issuer}::${credential.clientId}`;
  const profile = (snap?.row as Record<string, unknown>) || { auth_mode: existing?.[1]?.auth_mode || "oidc", user_id: account.ref, email: account.email, oidc_issuer: credential.issuer, oidc_client_id: credential.clientId };
  // 同一个签发方只放一个账号：Grok 按这个键认当前登录
  for (const [other, row] of Object.entries<any>(auth)) if (other !== key && row?.oidc_issuer === credential.issuer) delete auth[other];
  auth[key] = { ...profile, key: credential.token, refresh_token: credential.refreshToken, expires_at: credential.expiresAt ? new Date(credential.expiresAt).toISOString() : undefined };
  return [{ file, text: JSON.stringify(auth, null, 2) }];
}

let running: Promise<SwitchResult> | null = null;
export function switchCliAccount(id: string, home = os.homedir()): Promise<SwitchResult> {
  if (running) return Promise.reject(new Error("上一次切换还没完成，请稍候"));
  running = doSwitch(id, home).finally(() => { running = null; });
  return running;
}

async function doSwitch(id: string, home: string): Promise<SwitchResult> {
  const first = readOfficialAccountStore().accounts.find((item) => item.id === id);
  if (!first) throw new Error("找不到这个官方账号");
  const kind = first.kind;
  if (kind === "claude") setClaudeCliSwitching(true);
  try {
    if (kind === "claude") await waitCliRenewIdle();
    if (readCliAccounts(kind, home).some((item) => accountIdOf(kind, item.ref) === id)) return { ok: true, message: "CLI 现在登录的就是这个账号" };
    // 先把快过期的续上，免得写进 CLI 的是一份马上作废的
    await renewStoredCredentials(Date.now(), undefined, [kind]).catch(() => 0);
    let store = readOfficialAccountStore();
    let target = store.accounts.find((item) => item.id === id);
    if (!target) throw new Error("找不到这个官方账号");
    let credential = target.credential;
    if (!credential?.refreshToken || target.renewFailed || isExpired(credential)) {
      throw new Error("TokenPulse 里没有这个账号可用的登录（只是读过 CLI 的账号，或者登录已失效）。请先在设置里点「登录一个新账号」登录它一次，之后就能一键切换。");
    }
    let snap = target.cliAuth as CliAuthSnapshot | undefined;
    if (kind === "chatgpt" && !snap?.id_token) {
      // 没记下 Codex 要的 id_token：在同 kind 续期互斥锁内换一次，防止与 renewStoredCredentials 并发消费单次 refresh token
      await runWithKindRenewalLock(kind, async () => {
        store = readOfficialAccountStore();
        target = store.accounts.find((item) => item.id === id);
        if (!target || target.hidden) throw new Error("找不到这个官方账号");
        credential = target.credential;
        snap = target.cliAuth as CliAuthSnapshot | undefined;
        if (snap?.id_token) return;
        if (!credential?.refreshToken || target.renewFailed) {
          throw new Error("TokenPulse 里没有这个账号可用的登录（只是读过 CLI 的账号，或者登录已失效）。请先在设置里点「登录一个新账号」登录它一次，之后就能一键切换。");
        }
        const beforeRt = credential.refreshToken;
        const result = await refreshCredential(kind, credential);
        store = readOfficialAccountStore();
        target = store.accounts.find((item) => item.id === id);
        const tokenMatched = Boolean(target && !target.hidden && target.credential?.refreshToken === beforeRt);
        const idToken = result.ok && typeof result.raw?.id_token === "string" && result.raw.id_token ? result.raw.id_token : "";
        if (result.ok && tokenMatched && target) {
          // 单次 refresh token 已轮换：无论 id_token 是否存在都必须立刻落盘，避免丢失新 refresh token
          target.credential = credential = result.credential;
          delete target.renewFailed;
          delete target.renewTrouble;
          if (idToken) {
            snap = { ...(snap || {}), id_token: idToken };
            target.cliAuth = snap;
          }
          writeOfficialAccountStore(store);
        } else if (!result.ok && result.permanent && tokenMatched && target) {
          target.renewFailed = result.error;
          delete target.renewTrouble;
          writeOfficialAccountStore(store);
        }
        if (!target || target.hidden) throw new Error("找不到这个官方账号");
        if (!tokenMatched) throw new Error("切换期间账号凭据已更新，请重试切换");
        if (!result.ok || !idToken) throw new Error("没有拿到 Codex 需要的身份信息，请稍后再试，或在设置里重新登录这个账号。");
      });
    }

    if (!credential) throw new Error("TokenPulse 里没有这个账号可用的登录");
    const activeCredential = credential;
    const writes = plan(kind, target, activeCredential, snap, home);
    const saved = backup(kind, writes.map((item) => item.file));
    const before = JSON.stringify(readOfficialAccountStore());
    const readLogin: typeof readCliAccounts = (which) => readCliAccounts(which, home);
    // 在同一个同步写入阶段记录换号边界，不能等下一轮扫描才发现已经换号。
    recordCliLogins(Date.now(), readLogin, [kind]);

    // 换下来的账号：收下 CLI 手里最新的凭据和资料，之后由 TokenPulse 续期
    store = readOfficialAccountStore();
    const removedSet = new Set(store.removed ?? []);
    const outgoingSnap = kind === "grok" ? undefined : readCliSnapshot(kind, home);
    const grokAuthBefore = kind === "grok" ? (readJsonFile(authFile("grok", home)) as Record<string, any> | undefined) : undefined;
    const grokTargetKey = kind === "grok" ? ((snap?.rowKey as string) || `${activeCredential.issuer}::${activeCredential.clientId}`) : "";
    const now = Date.now();
    for (const live of readCliAccounts(kind, home)) {
      const outId = accountIdOf(kind, live.ref);
      // Grok 多行 auth.json 里只有同 issuer / 同 rowKey 会被 plan() 覆盖；别的行仍留在 CLI 里，不能把凭据抄进 TokenPulse 造成双主续期
      let rowSnap = outgoingSnap;
      if (kind === "grok") {
        const hitEntry = grokAuthBefore && typeof grokAuthBefore === "object"
          ? Object.entries<any>(grokAuthBefore).find(([k, row]) => row?.key === live.credential.token && (k === grokTargetKey || row?.oidc_issuer === activeCredential.issuer))
          : undefined;
        if (!hitEntry) continue;
        rowSnap = { rowKey: hitEntry[0], row: without(hitEntry[1], ["key", "refresh_token", "expires_at"]) };
      }
      if (removedSet.has(outId)) continue;
      const found = store.accounts.find((item) => item.id === outId);
      if (found) {
        if (found.hidden) continue;
        const best = fresherCredential(live.credential, found.credential, now);
        const tookLive = best === live.credential;
        if (best) found.credential = best;
        if (rowSnap && (tookLive || !found.cliAuth)) found.cliAuth = rowSnap;
        if (live.orgId && !found.orgId) found.orgId = live.orgId;
        if (tookLive) {
          delete found.renewFailed;
          delete found.renewTrouble;
        }
      } else {
        store.accounts.push({
          id: outId, kind, ref: live.ref, email: live.email, label: live.label,
          ...(live.orgId ? { orgId: live.orgId } : {}),
          credential: live.credential,
          ...(rowSnap ? { cliAuth: rowSnap } : {}),
          createdAt: now, lastSeenAt: now,
        });
      }
    }
    // 切进去的账号：凭据归 CLI
    const incoming = store.accounts.find((item) => item.id === id);
    if (!incoming) throw new Error("找不到这个官方账号");
    delete incoming.credential;
    incoming.cliAuth = snap ?? incoming.cliAuth;
    writeOfficialAccountStore(store);

    try {
      for (const item of writes) writeAtomic(item.file, item.text);
      if (!readCliAccounts(kind, home).some((item) => accountIdOf(kind, item.ref) === id)) throw new Error("写入后读回来的账号不对");
      recordCliLogins(Date.now(), readLogin, [kind]);
    } catch (error) {
      for (const item of saved) {
        try { if (item.text === null) fs.rmSync(item.file, { force: true }); else writeAtomic(item.file, item.text); } catch { /* 尽量放回 */ }
      }
      writeOfficialAccountStore(JSON.parse(before));
      throw new Error("切换失败，CLI 的登录已恢复原样：" + (error instanceof Error ? error.message : String(error)));
    }
    const name = target.alias || target.email || target.label;
    return { ok: true, message: `已把 CLI 的登录切换到 ${name}。已经开着的会话要重新打开才会用新账号。` };
  } finally {
    if (kind === "claude") setClaudeCliSwitching(false);
  }
}
