import { curlJson, curlPost } from "./curl";
import { jwtClaims, type OfficialAccountKind, type OfficialCredential } from "./credentials";

/**
 * 用 refresh token 给 TokenPulse 自己登录的账号换新的 access token，走的是官方 CLI 同一个接口。
 *
 * 接口和 client id 都是从本机官方 CLI 里核对出来的（用假 refresh token 探测过，都回 invalid_grant）：
 * - Claude：`platform.claude.com/v1/oauth/token`，client id 取自 claude.exe 里 BASE_API_URL=api.anthropic.com
 *   那组生产配置。必须带 claude-cli 的 User-Agent，curl 默认 UA 直接 429；
 * - ChatGPT：`auth.openai.com/oauth/token`，client id 取自 codex.exe；
 * - Grok：标准 OIDC，签发方和 client id 就在 auth.json 里，token endpoint 从发现文档读。
 *
 * **Claude / ChatGPT 的 refresh token 用一次就换新**：换到的新 refresh token 必须马上存下来，
 * 否则下次就续不上了（见 accounts.ts 的 renewStoredCredentials）。
 */

const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export type RefreshResult =
  | { ok: true; credential: OfficialCredential; /** 官方原样返回的内容（Codex 的 id_token 在这里）。 */ raw?: any }
  /** permanent：refresh token 被官方拒了（撤销、过期、已被用过），只能重新登录；否则下一轮再试。 */
  | { ok: false; permanent: boolean; error: string; /** HTTP 状态码，没连上时没有。 */ status?: number; /** 官方返回的错误类型（invalid_grant 之类），续期日志用。 */ code?: string };

/** 官方返回的新 token → 新凭据。没给新 refresh token 的（不轮换的实现）沿用旧的。 */
export function credentialFromTokenResponse(old: OfficialCredential, json: any, now = Date.now()): OfficialCredential | undefined {
  const token = typeof json?.access_token === "string" ? json.access_token : "";
  if (!token) return undefined;
  const exp = jwtClaims(token).exp;
  const expiresAt =
    typeof exp === "number" ? exp * 1000 : typeof json.expires_in === "number" ? now + json.expires_in * 1000 : undefined;
  return {
    ...old,
    token,
    expiresAt,
    refreshToken: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : old.refreshToken,
  };
}

/** 官方错误响应里的错误类型：OAuth 标准是 `{error: "invalid_grant"}`，OpenAI / Anthropic 也有 `{error: {code | type}}`。 */
export function errorCodeOf(json: any): string {
  const raw = typeof json?.error === "string" ? json.error : json?.error?.code ?? json?.error?.type ?? json?.code ?? "";
  return String(raw).slice(0, 80);
}

/**
 * 400 / 401 且官方**明确说 refresh token 不行了**（invalid_grant、已被用过、已过期 / 撤销）才算永久失败。
 * 0.3.54 之前任何 401、带 invalid_request 的 400 都直接判死、以后再也不试，一次偶发的拒绝就得重新登录；
 * 现在别的 4xx 先当这一轮不行，连续被拒够久才判死（见 accounts.ts 的 RENEW_GIVE_UP）。429、5xx、网络错误只是这一轮不行。
 */
export function isPermanentFailure(status: number, json: any) {
  if (status !== 400 && status !== 401) return false;
  return /^(invalid_grant|token_expired|token_revoked|refresh_token_(reused|expired|invalidated|revoked))$/i.test(errorCodeOf(json));
}

const discovery = new Map<string, Promise<string>>();
function grokTokenEndpoint(issuer: string) {
  let hit = discovery.get(issuer);
  if (!hit) {
    hit = curlJson(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, ["Accept: application/json"]).then((json) => {
      if (typeof json.token_endpoint !== "string") throw new Error("发现文档里没有 token_endpoint");
      return json.token_endpoint;
    });
    // 失败不缓存，下一轮重新发现。
    hit.catch(() => discovery.delete(issuer));
    discovery.set(issuer, hit);
  }
  return hit;
}

function request(kind: OfficialAccountKind, credential: OfficialCredential) {
  const refresh = credential.refreshToken!;
  if (kind === "claude") {
    return Promise.resolve({
      url: CLAUDE_TOKEN_URL,
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refresh, client_id: CLAUDE_CLIENT_ID }),
      headers: ["Content-Type: application/json", "Accept: application/json", "User-Agent: claude-cli/2.1.0 (external, cli)"],
    });
  }
  if (kind === "chatgpt") {
    return Promise.resolve({
      url: OPENAI_TOKEN_URL,
      body: JSON.stringify({ client_id: OPENAI_CLIENT_ID, grant_type: "refresh_token", refresh_token: refresh, scope: "openid profile email" }),
      headers: ["Content-Type: application/json", "Accept: application/json"],
    });
  }
  if (!credential.issuer || !credential.clientId) throw new Error("Grok 凭据里缺少 oidc_issuer / oidc_client_id");
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: credential.clientId });
  return grokTokenEndpoint(credential.issuer).then((url) => ({
    url,
    body: form.toString(),
    headers: ["Content-Type: application/x-www-form-urlencoded", "Accept: application/json"],
  }));
}

export async function refreshCredential(kind: OfficialAccountKind, credential: OfficialCredential, now = Date.now()): Promise<RefreshResult> {
  if (!credential.refreshToken) return { ok: false, permanent: true, error: "没有 refresh token" };
  try {
    const { url, body, headers } = await request(kind, credential);
    const { status, json } = await curlPost(url, body, headers);
    if (status >= 200 && status < 300) {
      const next = credentialFromTokenResponse(credential, json, now);
      return next ? { ok: true, credential: next, raw: json } : { ok: false, permanent: false, error: "续期响应里没有 access_token" };
    }
    const code = errorCodeOf(json);
    return { ok: false, permanent: isPermanentFailure(status, json), error: `HTTP ${status}${code ? ` ${code}` : ""}`, status, ...(code ? { code } : {}) };
  } catch (error) {
    return { ok: false, permanent: false, error: error instanceof Error ? error.message : String(error) };
  }
}
