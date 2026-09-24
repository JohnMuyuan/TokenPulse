import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * 读三家官方 CLI 自己存的登录凭据，识别「这是哪个账号」。
 *
 * 额度查询（quota.ts）和账号管理（main/oauth.ts）共用这一份：以前这段写在 oauth.ts 里，
 * 额度查询够不着，结果「切换活动账号」只对 Grok 生效，Claude / ChatGPT 仍然查 CLI 当前那个。
 *
 * 身份（ref）必须每个账号唯一，否则第二个账号会把第一个覆盖掉：
 * - Claude：`.credentials.json` 里**没有邮箱**，身份在 `.claude.json` 的 `oauthAccount.accountUuid`；
 * - ChatGPT：`tokens.account_id` 是**工作区** id，Team 里的成员共用，要再拼上 id_token 里的 `chatgpt_user_id`；
 * - Grok：`auth.json` 本身按账号分键，键就是身份。
 * 实在认不出时用 token 的哈希兜底 —— 宁可同一个账号多出一条，也不能两个账号撞成一条。
 */

export type OfficialAccountKind = "claude" | "chatgpt" | "grok";
export const OFFICIAL_KINDS: OfficialAccountKind[] = ["claude", "chatgpt", "grok"];

export type OfficialCredential = {
  /** Grok 的 key，或 Claude / ChatGPT 的 access token。 */
  token: string;
  /** ChatGPT 的工作区 id，查额度时要带上。 */
  accountId?: string;
  /** 毫秒时间戳。过期的凭据不拿去查额度。 */
  expiresAt?: number;
  /**
   * 续期用（见 token-refresh.ts）。**只有 TokenPulse 自己登录的账号会存下来并使用**：
   * CLI 自己的登录绝不能拿来续期 —— Claude / ChatGPT 的 refresh token 用一次就换新，
   * TokenPulse 用掉之后 CLI 手里那份作废，CLI 会被登出。
   */
  refreshToken?: string;
  /** Grok（OIDC）续期要用的签发方和 client id，auth.json 里就有。 */
  issuer?: string;
  clientId?: string;
};

export type CliAccount = {
  kind: OfficialAccountKind;
  ref: string;
  email: string;
  label: string;
  credential: OfficialCredential;
};

/** 各家 CLI 的配置目录。读本机真实登录时尊重用户自己设的环境变量。 */
export function cliDir(kind: OfficialAccountKind, home = os.homedir()) {
  const own = home === os.homedir();
  if (kind === "claude") return (own && process.env.CLAUDE_CONFIG_DIR) || path.join(home, ".claude");
  if (kind === "chatgpt") return (own && process.env.CODEX_HOME) || path.join(home, ".codex");
  return (own && process.env.GROK_HOME) || path.join(home, ".grok");
}

export function authFile(kind: OfficialAccountKind, home = os.homedir()) {
  const dir = cliDir(kind, home);
  if (kind === "claude") return path.join(dir, ".credentials.json");
  return path.join(dir, "auth.json");
}

function readJsonFile(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function str(value: unknown) {
  return typeof value === "string" ? value : "";
}

/** 只解出 JWT 的声明部分拿身份和过期时间，不校验签名（token 是本机 CLI 自己存的）。 */
export function jwtClaims(token: string): Record<string, any> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) || {};
  } catch {
    return {};
  }
}

/** Grok 账号的用户 ID：auth.json 的 user_id，没有就取 token（JWT）的 sub —— 本机实测两者相同。 */
export function grokUserOf(token: string, userId?: unknown) {
  return str(userId) || str(jwtClaims(token).sub);
}

/** 0.3.3 之前 Grok 账号的 ref 是 auth.json 的键（「https://auth.x.ai::client id」），不分用户。 */
export function isLegacyGrokRef(ref: string) {
  return ref.includes("::");
}

export function tokenRef(token: string) {
  return "token:" + createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function claudeAccounts(home: string): CliAccount[] {
  const oauth = readJsonFile(authFile("claude", home))?.claudeAiOauth;
  const token = str(oauth?.accessToken);
  if (!token) return [];
  // 默认在 ~/.claude.json；设了 CLAUDE_CONFIG_DIR 时在那个目录里。
  const profile =
    readJsonFile(path.join(cliDir("claude", home), ".claude.json"))?.oauthAccount ??
    readJsonFile(path.join(home, ".claude.json"))?.oauthAccount;
  const email = str(profile?.emailAddress);
  const ref = str(profile?.accountUuid) || tokenRef(str(oauth?.refreshToken) || token);
  const expiresAt = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined;
  const refreshToken = str(oauth?.refreshToken) || undefined;
  return [{ kind: "claude", ref, email, label: email || "Claude 账号", credential: { token, expiresAt, refreshToken } }];
}

function chatgptAccounts(home: string): CliAccount[] {
  const auth = readJsonFile(authFile("chatgpt", home));
  const tokens = auth?.tokens;
  const token = str(tokens?.access_token);
  if (!token) return [];
  const id = jwtClaims(str(tokens?.id_token));
  const openai = id["https://api.openai.com/auth"] ?? {};
  const workspace = str(tokens?.account_id) || str(openai.chatgpt_account_id);
  const user = str(openai.chatgpt_user_id) || str(openai.user_id) || str(id.sub);
  const email = str(id.email);
  const ref = user && workspace ? `${user}@${workspace}` : user || workspace || tokenRef(str(tokens?.refresh_token) || token);
  const exp = jwtClaims(token).exp;
  return [{
    kind: "chatgpt",
    ref,
    email,
    label: email || "ChatGPT 账号",
    credential: {
      token,
      accountId: workspace || undefined,
      expiresAt: typeof exp === "number" ? exp * 1000 : undefined,
      refreshToken: str(tokens?.refresh_token) || undefined,
    },
  }];
}

function grokAccounts(home: string): CliAccount[] {
  const parsed = readJsonFile(authFile("grok", home));
  if (!parsed || typeof parsed !== "object") return [];
  const out: CliAccount[] = [];
  for (const row of Object.values<any>(parsed)) {
    const token = str(row?.key);
    if (!token) continue;
    const email = str(row.email);
    // 身份用用户 ID。auth.json 的键是「签发方::客户端 ID」（https://auth.x.ai::<Grok CLI 的 client id>），
    // 谁登录都一样 —— 0.3.3 之前拿它当身份，第二个 Grok 账号一登录就把第一个顶掉了。
    const ref = grokUserOf(token, row.user_id) || tokenRef(str(row.refresh_token) || token);
    const expires = Date.parse(str(row.expires_at));
    out.push({
      kind: "grok",
      ref,
      email,
      label: email || "Grok 账号",
      credential: {
        token,
        expiresAt: Number.isFinite(expires) ? expires : undefined,
        refreshToken: str(row.refresh_token) || undefined,
        issuer: str(row.oidc_issuer) || undefined,
        clientId: str(row.oidc_client_id) || undefined,
      },
    });
  }
  return out;
}

/** 某个 home 下该 CLI 当前登录的账号。默认读本机真实登录；OAuth 登录时传隔离的临时目录。 */
export function readCliAccounts(kind: OfficialAccountKind, home = os.homedir()): CliAccount[] {
  if (kind === "claude") return claudeAccounts(home);
  if (kind === "chatgpt") return chatgptAccounts(home);
  return grokAccounts(home);
}

export function isExpired(credential: OfficialCredential | undefined, now = Date.now()) {
  return !credential || (credential.expiresAt != null && credential.expiresAt < now + 30_000);
}
