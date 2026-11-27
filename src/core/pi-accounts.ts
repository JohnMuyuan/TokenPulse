import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { readOfficialAccountStore } from "./accounts";
import { readAgyAccountStore } from "./antigravity-accounts";
import { errorText, log } from "./app-log";
import { jwtClaims, type OfficialAccountKind } from "./credentials";
import { curlJson, HttpError } from "./curl";
import { dataFile, piDir, readJson, writeJson } from "./paths";

/**
 * pi (`~/.pi/agent/auth.json`) 全量 OAuth 账号只读识别、登录时间线、官方账号联动与本地别名管理。
 *
 * 设计约束：
 * - 严格只读 `~/.pi/agent/auth.json`，绝不改写文件，也不触碰 `refresh` / `dpopKey` 发 OAuth 刷新请求
 *   （避免破坏 `google-ai-plan` 的 DPoP nonce 或导致轮换型 `refresh_token` 失效把 pi 登出）；
 * - `pi-logins.json` 只保存单向 SHA-256 指纹与解析出的非敏感身份（邮箱、用户名、账号 ID、别名、时间线），
 *   绝不落盘任何 `access` / `refresh` / `dpopKey` / API Key 原始凭据；
 * - 覆盖 pi-ai 全部内置 OAuth 订阅 provider：`google-ai-plan`、`anthropic`、`openai-codex`、`openai`
 *   （ChatGPT 订阅）、`xai`、`github-copilot`、`kimi-coding`、`meta`（并兼容旧别名 `openai-chatgpt`），
 *   同时明确把 `openrouter`（OAuth 换取按量 API Key）排除在订阅制之外；
 * - 按时间线记录各 provider 的认证模式（`oauth` / `api_key` / `none` 登出），防止切换 API Key ↔ OAuth
 *   或登出后改用环境变量 API Key 时回溯污染历史账单归属；
 * - 对共享同一官方订阅池的 `anthropic` / `openai-codex` / `openai` / `xai`，在能确切匹配到 TokenPulse
 *   官方账号（按 UUID / userId@accountId / sub / 同家族邮箱）时自动联动归属，让 pi 消耗并入官方额度容量折算。
 */

export const PI_GOOGLE_AI_PLAN = "google-ai-plan";
export const PI_GOOGLE_OIDC_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const PI_GOOGLE_V2_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
export const PI_ANTHROPIC_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
export const PI_GITHUB_USER_URL = "https://api.github.com/user";
export const PI_OPENAI_USERINFO_URL = "https://auth.openai.com/userinfo";
export const PI_XAI_USERINFO_URL = "https://auth.x.ai/oauth2/userinfo";

/** 明确属于订阅制（isSubscription: true）的 pi 内置 OAuth provider。 */
const SUBSCRIPTION_PROVIDERS = new Set([
  PI_GOOGLE_AI_PLAN,
  "anthropic",
  "openai-codex",
  "openai",
  "openai-chatgpt",
  "xai",
  "github-copilot",
  "kimi-coding",
  "meta",
]);

/** 仅支持 OAuth 订阅登录、不存在按量 API Key 模式的 pi 内置 provider。 */
const OAUTH_ONLY_SUBSCRIPTION_PROVIDERS = new Set([
  PI_GOOGLE_AI_PLAN,
  "openai-codex",
]);

/** 虽然在 auth.json 中存为 type: "oauth"，但实质换取的是按量计费 API Key 的 provider。 */
const API_KEY_OAUTH_PROVIDERS = new Set([
  "openrouter",
]);

/** 刷新 token 时可能轮换 refresh_token 且没有 dpopKey 的 provider（无离线身份时平滑复用占位段防裂变）。 */
const ROTATING_REFRESH_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "openai-chatgpt",
  "openai-codex",
  "xai",
  "kimi-coding",
  "meta",
]);

/** 支持在线只读查询用户资料的 pi OAuth provider。 */
const ONLINE_PROFILE_PROVIDERS = new Set([
  PI_GOOGLE_AI_PLAN,
  "anthropic",
  "github-copilot",
  "openai",
  "openai-codex",
  "openai-chatgpt",
  "xai",
]);

export const PI_PROVIDER_FALLBACK_LABEL: Record<string, string> = {
  [PI_GOOGLE_AI_PLAN]: "Google AI Plan 账号",
  anthropic: "Anthropic 账号",
  "openai-codex": "OpenAI Codex 账号",
  openai: "OpenAI ChatGPT 账号",
  "openai-chatgpt": "OpenAI ChatGPT 账号",
  xai: "xAI 账号",
  "github-copilot": "GitHub Copilot 账号",
  "kimi-coding": "Kimi Code 账号",
  meta: "Meta 账号",
};

export const PI_PROVIDER_DISPLAY_NAME: Record<string, string> = {
  [PI_GOOGLE_AI_PLAN]: "Google AI Plan",
  anthropic: "Anthropic",
  "openai-codex": "OpenAI Codex",
  openai: "OpenAI ChatGPT",
  "openai-chatgpt": "OpenAI ChatGPT",
  xai: "xAI",
  "github-copilot": "GitHub Copilot",
  "kimi-coding": "Kimi Code",
  meta: "Meta",
  tokenpulse_route: "TokenPulse 路由",
  openrouter: "OpenRouter",
};

const MAX_SPANS_PER_PROVIDER = 500;
const MAX_IDENTITIES = 200;

export type PiCachedIdentity = {
  provider: string;
  email: string;
  login?: string;
  name?: string;
  sub?: string;
  accountId?: string;
  userId?: string;
  orgId?: string;
  label: string;
  updatedAt: number;
};

export type PiSpanMode = "oauth" | "api_key" | "none";

export type PiLoginSpan = {
  from: number;
  /** 空串表示非 OAuth 登录状态（已退出登录或切换为 api_key）。 */
  id: string;
  email: string;
  label: string;
  /** 该时段的认证模式；老数据省略时非空 id 视为 oauth、空 id 视为 none。 */
  mode?: PiSpanMode;
  /** 单向凭据指纹（不含原始凭据），用于首次过期占位后、access 刷新时原地升级为真实邮箱。 */
  fingerprint?: string;
  /** 可选的非敏感身份元数据，用于与三家官方账号安全联动。 */
  login?: string;
  sub?: string;
  accountId?: string;
  userId?: string;
  orgId?: string;
};

export type PiLoginStore = {
  version: 1;
  providers: Record<string, PiLoginSpan[]>;
  identities: Record<string, PiCachedIdentity>;
  providerTypes: Record<string, "oauth" | "api_key">;
  /** 用户在设置页为独立 pi:* 账号设置的自定义别名。 */
  aliases?: Record<string, string>;
};

type RawAuthEntry = Record<string, unknown>;

type OfflineIdentity = {
  email: string;
  login: string;
  name: string;
  sub: string;
  accountId: string;
  userId: string;
  orgId: string;
};

type ParsedOAuthEntry = {
  provider: string;
  access: string;
  refresh: string;
  expires?: number;
  enterpriseUrl?: string;
  fingerprint: string;
  accessHash: string;
  offline: OfflineIdentity;
};

export type PiSyncDeps = {
  now?: number;
  force?: boolean;
  /** 向 Anthropic / OpenAI / xAI 发只读资料请求前的出口白名单门控。 */
  gate?: (kind: OfficialAccountKind) => Promise<boolean>;
  getJson?: (url: string, headers: string[]) => Promise<Record<string, unknown>>;
};

export type OfficialAccountIndex = {
  byId: Set<string>;
  byEmail: Map<string, string>;
  byWorkspace: Map<string, string>;
  bySub: Map<string, string>;
};

export type PiAccountStatusRow = {
  id: string;
  provider: string;
  providerName: string;
  email: string;
  login?: string;
  label: string;
  alias?: string;
  inAuth: boolean;
  status: "resolved" | "provisional" | "expired" | "logged_out";
  expiresAt?: number;
  linkedOfficialId?: string;
  linkedKind?: OfficialAccountKind;
  lastSeenAt: number;
};

export type PiAccountStatus = {
  installed: boolean;
  hasAuthFile: boolean;
  accounts: PiAccountStatusRow[];
};

const storeFile = () => dataFile("pi-logins.json");
const authFile = () => path.join(piDir(), "auth.json");

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function shaHex(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function normalizePiProvider(provider: unknown): string {
  return typeof provider === "string" ? provider.trim().toLowerCase() : "";
}

/** 将 pi 的订阅 provider 映射到 TokenPulse 的三家官方账号家族（用于共享订阅额度联动）。 */
export function piOfficialKindOf(provider: string | undefined): OfficialAccountKind | undefined {
  const p = normalizePiProvider(provider);
  if (p === "anthropic") return "claude";
  if (p === "openai-codex" || p === "openai" || p === "openai-chatgpt") return "chatgpt";
  if (p === "xai") return "grok";
  return undefined;
}

export function piProviderDisplayName(provider: string | undefined): string {
  const p = normalizePiProvider(provider);
  if (!p) return "";
  return PI_PROVIDER_DISPLAY_NAME[p] ?? String(provider ?? "").trim();
}

export function piAccountIdOf(provider: string, email?: string, sub?: string, fingerprint?: string): string {
  const p = normalizePiProvider(provider);
  const normEmail = str(email).toLowerCase();
  if (normEmail) return `pi:${p}:${shaHex("email:" + normEmail, 16)}`;
  const normSub = str(sub);
  if (normSub) return `pi:${p}:${shaHex("sub:" + normSub, 16)}`;
  const fp = str(fingerprint) || shaHex(String(Date.now()), 16);
  return `pi:${p}:fp:${fp.slice(0, 16)}`;
}

function fallbackLabelOf(provider: string): string {
  const p = normalizePiProvider(provider);
  return PI_PROVIDER_FALLBACK_LABEL[p] ?? `${provider} 账号`;
}

function isProvisionalId(provider: string, id: string): boolean {
  return id.startsWith(`pi:${normalizePiProvider(provider)}:fp:`);
}

function emptyStore(): PiLoginStore {
  return { version: 1, providers: {}, identities: {}, providerTypes: {} };
}

export function readPiLoginStore(): PiLoginStore {
  const parsed = readJson<Partial<PiLoginStore> | null>(storeFile(), null);
  if (!parsed || parsed.version !== 1 || typeof parsed !== "object") return emptyStore();
  const providers: Record<string, PiLoginSpan[]> = {};
  if (parsed.providers && typeof parsed.providers === "object") {
    for (const [k, list] of Object.entries(parsed.providers)) {
      if (!Array.isArray(list)) continue;
      const clean = list
        .filter(
          (item): item is PiLoginSpan =>
            Boolean(item && typeof item === "object" && typeof item.from === "number" && typeof item.id === "string" && typeof item.email === "string" && typeof item.label === "string"),
        )
        .map((item) => ({
          from: item.from,
          id: item.id,
          email: item.email,
          label: item.label,
          ...(item.mode === "oauth" || item.mode === "api_key" || item.mode === "none" ? { mode: item.mode } : {}),
          ...(typeof item.fingerprint === "string" && item.fingerprint ? { fingerprint: item.fingerprint } : {}),
          ...(typeof item.login === "string" && item.login ? { login: item.login } : {}),
          ...(typeof item.sub === "string" && item.sub ? { sub: item.sub } : {}),
          ...(typeof item.accountId === "string" && item.accountId ? { accountId: item.accountId } : {}),
          ...(typeof item.userId === "string" && item.userId ? { userId: item.userId } : {}),
          ...(typeof item.orgId === "string" && item.orgId ? { orgId: item.orgId } : {}),
        }));
      if (clean.length) providers[normalizePiProvider(k)] = clean;
    }
  }
  const identities: Record<string, PiCachedIdentity> = {};
  if (parsed.identities && typeof parsed.identities === "object") {
    for (const [fp, item] of Object.entries(parsed.identities)) {
      if (!item || typeof item !== "object") continue;
      const row = item as Partial<PiCachedIdentity>;
      if (typeof row.provider === "string" && typeof row.email === "string" && typeof row.label === "string") {
        identities[fp] = {
          provider: normalizePiProvider(row.provider),
          email: row.email,
          ...(typeof row.login === "string" && row.login ? { login: row.login } : {}),
          ...(typeof row.name === "string" && row.name ? { name: row.name } : {}),
          ...(typeof row.sub === "string" && row.sub ? { sub: row.sub } : {}),
          ...(typeof row.accountId === "string" && row.accountId ? { accountId: row.accountId } : {}),
          ...(typeof row.userId === "string" && row.userId ? { userId: row.userId } : {}),
          ...(typeof row.orgId === "string" && row.orgId ? { orgId: row.orgId } : {}),
          label: row.label,
          updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
        };
      }
    }
  }
  const providerTypes: Record<string, "oauth" | "api_key"> = {};
  if (parsed.providerTypes && typeof parsed.providerTypes === "object") {
    for (const [k, v] of Object.entries(parsed.providerTypes)) {
      if (v === "oauth" || v === "api_key") providerTypes[normalizePiProvider(k)] = v;
    }
  }
  const aliases: Record<string, string> = {};
  if (parsed.aliases && typeof parsed.aliases === "object") {
    for (const [k, v] of Object.entries(parsed.aliases)) {
      if (typeof k === "string" && k.startsWith("pi:") && typeof v === "string" && v.trim()) {
        aliases[k] = v.trim().slice(0, 40);
      }
    }
  }
  return {
    version: 1,
    providers,
    identities,
    providerTypes,
    ...(Object.keys(aliases).length ? { aliases } : {}),
  };
}

export function writePiLoginStore(store: PiLoginStore): PiLoginStore {
  const trimmedIdentities: Record<string, PiCachedIdentity> = {};
  const sortedIds = Object.entries(store.identities).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)).slice(0, MAX_IDENTITIES);
  for (const [k, v] of sortedIds) trimmedIdentities[k] = v;
  const trimmedProviders: Record<string, PiLoginSpan[]> = {};
  for (const [k, spans] of Object.entries(store.providers)) {
    if (spans.length) trimmedProviders[k] = spans.slice(-MAX_SPANS_PER_PROVIDER);
  }
  const cleanAliases: Record<string, string> = {};
  for (const [k, v] of Object.entries(store.aliases ?? {})) {
    const trimmed = str(v).slice(0, 40);
    if (k.startsWith("pi:") && trimmed) cleanAliases[k] = trimmed;
  }
  const out: PiLoginStore = {
    version: 1,
    providers: trimmedProviders,
    identities: trimmedIdentities,
    providerTypes: store.providerTypes,
    ...(Object.keys(cleanAliases).length ? { aliases: cleanAliases } : {}),
  };
  writeJson(storeFile(), out);
  return out;
}

type AuthReadResult =
  | { status: "ok"; doc: Record<string, RawAuthEntry> }
  | { status: "missing" }
  | { status: "error" };

function readPiAuthRaw(): AuthReadResult {
  const file = authFile();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" ? { status: "missing" } : { status: "error" };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "error" };
    return { status: "ok", doc: parsed as Record<string, RawAuthEntry> };
  } catch {
    return { status: "error" };
  }
}

function extractOfflineIdentity(entry: RawAuthEntry): OfflineIdentity {
  let email = str(entry.email);
  let login = str(entry.login) || str(entry.username);
  let name = str(entry.name);
  let sub = str(entry.sub);
  let accountId = str(entry.accountId) || str(entry.account_id);
  let userId = str(entry.userId) || str(entry.user_id);
  let orgId = str(entry.orgId) || str(entry.org_id);

  for (const tokenField of ["id_token", "idToken", "access"] as const) {
    const rawToken = str(entry[tokenField]);
    if (!rawToken || rawToken.split(".").length !== 3) continue;
    const claims = jwtClaims(rawToken);
    if (!claims || typeof claims !== "object") continue;
    const profile = claims["https://api.openai.com/profile"] as Record<string, unknown> | undefined;
    const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    if (!email) email = str(claims.email) || str(profile?.email);
    if (!login) login = str(claims.preferred_username) || str(claims.login);
    if (!name) name = str(claims.name) || str(profile?.name);
    if (!sub) sub = str(claims.sub);
    if (!accountId) accountId = str(auth?.chatgpt_account_id) || str(claims.account_id);
    if (!userId) userId = str(auth?.chatgpt_user_id) || str(auth?.user_id) || str(claims.user_id);
    if (!orgId) orgId = str(auth?.organization_id) || str(claims.org_id);
  }
  return { email, login, name, sub, accountId, userId, orgId };
}

function fingerprintOf(provider: string, entry: RawAuthEntry, offline: OfflineIdentity): string {
  const refresh = str(entry.refresh);
  const access = str(entry.access);
  const dpop = entry.dpopKey && typeof entry.dpopKey === "object" ? (entry.dpopKey as Record<string, unknown>) : null;
  const pubCoord = dpop && str(dpop.x) && str(dpop.y) ? `${str(dpop.x)}.${str(dpop.y)}` : "";
  const stableOffline =
    offline.email.toLowerCase() ||
    (offline.userId && offline.accountId ? `${offline.userId}@${offline.accountId}` : "") ||
    offline.sub ||
    offline.accountId ||
    offline.login.toLowerCase();
  // 优先用不随 token 刷新轮换的稳定身份：离线稳定 ID > DPoP 公钥坐标 > refresh > access
  const material = stableOffline || pubCoord || refresh || access;
  return material ? shaHex(`pi:${provider}:${material}`, 24) : "";
}

function parseOAuthEntries(doc: Record<string, RawAuthEntry>): { oauth: ParsedOAuthEntry[]; types: Record<string, "oauth" | "api_key"> } {
  const oauth: ParsedOAuthEntry[] = [];
  const types: Record<string, "oauth" | "api_key"> = {};
  for (const [rawKey, rawVal] of Object.entries(doc)) {
    if (!rawVal || typeof rawVal !== "object" || Array.isArray(rawVal)) continue;
    const provider = normalizePiProvider(rawKey);
    if (!provider) continue;
    const type = str(rawVal.type).toLowerCase();
    if (type === "api_key" || type === "apikey") {
      types[provider] = "api_key";
      continue;
    }
    if (type !== "oauth") continue;
    // OpenRouter 的 OAuth 实质换取按量计费 API Key，不算订阅制 OAuth 账号
    if (API_KEY_OAUTH_PROVIDERS.has(provider)) {
      types[provider] = "api_key";
      continue;
    }
    types[provider] = "oauth";
    const access = str(rawVal.access);
    const refresh = str(rawVal.refresh);
    const expires = typeof rawVal.expires === "number" && Number.isFinite(rawVal.expires) ? rawVal.expires : undefined;
    const enterpriseUrl = str(rawVal.enterpriseUrl) || undefined;
    const offline = extractOfflineIdentity(rawVal);
    const fingerprint = fingerprintOf(provider, rawVal, offline);
    if (!fingerprint) continue;
    oauth.push({
      provider,
      access,
      refresh,
      expires,
      enterpriseUrl,
      fingerprint,
      accessHash: access ? shaHex(access, 16) : "",
      offline,
    });
  }
  return { oauth, types };
}

type ResolvedIdentityInput = {
  email: string;
  login?: string;
  name?: string;
  sub?: string;
  accountId?: string;
  userId?: string;
  orgId?: string;
};

function labelForIdentity(provider: string, id: ResolvedIdentityInput): string {
  const email = str(id.email);
  const login = str(id.login);
  const name = str(id.name);
  const accountId = str(id.accountId);
  if (email) return email;
  if (login) return provider === "github-copilot" ? `@${login.replace(/^@/, "")}` : login;
  if (name) return name;
  if (accountId) return accountId;
  return fallbackLabelOf(provider);
}

function sameSpanMeta(span: PiLoginSpan, next: { id: string; email: string; label: string; login: string; sub: string; accountId: string; userId: string; orgId: string }): boolean {
  return (
    span.id === next.id &&
    span.email === next.email &&
    span.label === next.label &&
    (span.login || "") === next.login &&
    (span.sub || "") === next.sub &&
    (span.accountId || "") === next.accountId &&
    (span.userId || "") === next.userId &&
    (span.orgId || "") === next.orgId &&
    span.mode === "oauth"
  );
}

function assignSpanMeta(span: PiLoginSpan, next: { id: string; email: string; label: string; login: string; sub: string; accountId: string; userId: string; orgId: string }, fingerprint: string) {
  span.id = next.id;
  span.email = next.email;
  span.label = next.label;
  span.mode = "oauth";
  span.fingerprint = fingerprint;
  if (next.login) span.login = next.login; else delete span.login;
  if (next.sub) span.sub = next.sub; else delete span.sub;
  if (next.accountId) span.accountId = next.accountId; else delete span.accountId;
  if (next.userId) span.userId = next.userId; else delete span.userId;
  if (next.orgId) span.orgId = next.orgId; else delete span.orgId;
}

/** 合并相邻同 id 的重复登录段（例如轮换型 refresh 刷新先记了临时占位段，随后解析证实仍是同一账号）。 */
function collapseDuplicateTailSpans(spans: PiLoginSpan[]): boolean {
  let collapsed = false;
  while (spans.length >= 2) {
    const last = spans[spans.length - 1];
    const prev = spans[spans.length - 2];
    if (last.id && prev.id === last.id) {
      prev.email = last.email || prev.email;
      prev.label = last.label || prev.label;
      prev.mode = "oauth";
      if (last.fingerprint) prev.fingerprint = last.fingerprint;
      if (last.login) prev.login = last.login;
      if (last.sub) prev.sub = last.sub;
      if (last.accountId) prev.accountId = last.accountId;
      if (last.userId) prev.userId = last.userId;
      if (last.orgId) prev.orgId = last.orgId;
      spans.pop();
      collapsed = true;
    } else {
      break;
    }
  }
  return collapsed;
}

function applyResolvedIdentityToStore(
  store: PiLoginStore,
  provider: string,
  fingerprint: string,
  identity: ResolvedIdentityInput,
  now: number,
): boolean {
  let changed = false;
  const email = str(identity.email);
  const login = str(identity.login);
  const name = str(identity.name);
  const sub = str(identity.sub);
  const accountId = str(identity.accountId);
  const userId = str(identity.userId);
  const orgId = str(identity.orgId);
  const label = labelForIdentity(provider, { email, login, name, sub, accountId, userId, orgId });
  const stableSub = sub || (userId && accountId ? `${userId}@${accountId}` : accountId) || login.toLowerCase();
  const id = piAccountIdOf(provider, email, stableSub, fingerprint);
  const meta = { id, email, label, login, sub, accountId, userId, orgId };

  if (email || login || sub || accountId || userId) {
    const prev = store.identities[fingerprint];
    if (
      !prev ||
      prev.email !== email ||
      prev.label !== label ||
      (prev.login || "") !== login ||
      (prev.sub || "") !== sub ||
      (prev.accountId || "") !== accountId ||
      (prev.userId || "") !== userId ||
      (prev.orgId || "") !== orgId
    ) {
      store.identities[fingerprint] = {
        provider,
        email,
        ...(login ? { login } : {}),
        ...(name ? { name } : {}),
        ...(sub ? { sub } : {}),
        ...(accountId ? { accountId } : {}),
        ...(userId ? { userId } : {}),
        ...(orgId ? { orgId } : {}),
        label,
        updatedAt: now,
      };
      changed = true;
    }
  }

  const spans = (store.providers[provider] ??= []);
  // 将同一指纹的历史占位段一并原地升级为真实身份（不改 from 时间戳）
  for (const span of spans) {
    if (span.fingerprint && span.fingerprint === fingerprint) {
      if (!sameSpanMeta(span, meta)) {
        assignSpanMeta(span, meta, fingerprint);
        changed = true;
      }
    }
  }
  const last = spans.at(-1);
  if (last && (last.id === id || (last.fingerprint && last.fingerprint === fingerprint))) {
    if (!sameSpanMeta(last, meta) || last.fingerprint !== fingerprint) {
      assignSpanMeta(last, meta, fingerprint);
      changed = true;
    }
  } else if (
    // 对无离线身份且会轮换 refresh_token 的 provider，连续处于未解析占位态时原地延续，避免每次刷新裂变出新账号
    last &&
    !email &&
    !login &&
    !sub &&
    !accountId &&
    !userId &&
    ROTATING_REFRESH_PROVIDERS.has(provider) &&
    isProvisionalId(provider, last.id)
  ) {
    if (last.fingerprint !== fingerprint || last.mode !== "oauth") {
      last.fingerprint = fingerprint;
      last.mode = "oauth";
      changed = true;
    }
  } else {
    const span: PiLoginSpan = { from: now, id, email, label, mode: "oauth", fingerprint };
    assignSpanMeta(span, meta, fingerprint);
    spans.push(span);
    changed = true;
  }

  if (collapseDuplicateTailSpans(spans)) changed = true;
  return changed;
}

/**
 * 同步扫描 `~/.pi/agent/auth.json` 并更新 `pi-logins.json` 时间线（纯本地、无网络）。
 * 在 worker 扫描会话前调用，与 `recordCliLogins()` 保持相同职责。
 */
export function recordPiLogins(now = Date.now()): PiLoginStore {
  const store = readPiLoginStore();
  const read = readPiAuthRaw();
  if (read.status === "error") return store;

  let changed = false;
  const activeOAuthProviders = new Set<string>();
  const activeApiKeyProviders = new Set<string>();

  if (read.status === "ok") {
    const { oauth, types } = parseOAuthEntries(read.doc);
    for (const [provider, kind] of Object.entries(types)) {
      if (store.providerTypes[provider] !== kind) {
        store.providerTypes[provider] = kind;
        changed = true;
      }
      if (kind === "api_key") activeApiKeyProviders.add(provider);
    }
    // 已被从 auth.json 移除的 provider：清除旧 providerTypes，避免登出后改用环境变量 API Key 被永久误判为 oauth
    for (const provider of Object.keys(store.providerTypes)) {
      if (!Object.hasOwn(types, provider)) {
        delete store.providerTypes[provider];
        changed = true;
      }
    }
    for (const entry of oauth) {
      activeOAuthProviders.add(entry.provider);
      const cached = store.identities[entry.fingerprint];
      const email = entry.offline.email || cached?.email || "";
      const login = entry.offline.login || cached?.login || "";
      const name = entry.offline.name || cached?.name || "";
      const sub = entry.offline.sub || cached?.sub || "";
      const accountId = entry.offline.accountId || cached?.accountId || "";
      const userId = entry.offline.userId || cached?.userId || "";
      const orgId = entry.offline.orgId || cached?.orgId || "";
      if (applyResolvedIdentityToStore(store, entry.provider, entry.fingerprint, { email, login, name, sub, accountId, userId, orgId }, now)) {
        changed = true;
      }
    }
    // 双模订阅 provider（如 anthropic / openai / xai）在 auth.json 中切成了 api_key：记一段 api_key 模式便于按时间分账
    for (const provider of activeApiKeyProviders) {
      if (!SUBSCRIPTION_PROVIDERS.has(provider)) continue;
      const spans = (store.providers[provider] ??= []);
      const last = spans.at(-1);
      if (!last || last.id || last.mode !== "api_key") {
        spans.push({ from: now, id: "", email: "", label: "", mode: "api_key" });
        changed = true;
      }
    }
  } else if (read.status === "missing" && fs.existsSync(piDir())) {
    if (Object.keys(store.providerTypes).length) {
      store.providerTypes = {};
      changed = true;
    }
  }

  // auth.json 存在但某个 provider 已移除，或 auth.json 已删（且 .pi/agent 目录存在）：标记退出登录
  const shouldMarkLogout = read.status === "ok" || (read.status === "missing" && fs.existsSync(piDir()));
  if (shouldMarkLogout) {
    for (const [provider, spans] of Object.entries(store.providers)) {
      if (activeOAuthProviders.has(provider) || activeApiKeyProviders.has(provider)) continue;
      const last = spans.at(-1);
      if (last && last.id) {
        spans.push({ from: now, id: "", email: "", label: "", mode: "none" });
        changed = true;
      }
    }
  }

  if (changed) {
    try {
      writePiLoginStore(store);
    } catch { /* 只读时跳过 */ }
  }
  return store;
}

/** 失败过的凭据哈希（仅内存态，防止过期/失效/不支持端点每分钟反复发请求）。 */
const failedAccess = new Map<string, { hash: string; at: number; sticky: boolean }>();
let syncInFlight: Promise<{ changed: boolean; resolved: string[] }> | null = null;

export function resetPiSyncCache(): void {
  failedAccess.clear();
  syncInFlight = null;
}

/**
 * 过期宽限余量：anthropic/xai/openai 在 auth.json 存 expires 时提前扣了 3–5 分钟，
 * google-ai-plan 存真实过期时间（提前 5 分钟由 pi 刷新）；此处留 5 分钟宽限兼顾提前扣量与轻微时钟偏差，
 * 若遇 401 立即记入 failedAccess 不再重复请求。
 */
const PI_EXPIRY_GRACE_MS = 5 * 60_000;

function entryHasResolvedIdentity(entry: ParsedOAuthEntry, store: PiLoginStore): boolean {
  const cached = store.identities[entry.fingerprint];
  if (entry.offline.email || cached?.email) return true;
  if (entry.provider === "github-copilot" && (entry.offline.login || cached?.login)) return true;
  return false;
}

function tokenHashForProbe(entry: ParsedOAuthEntry): string {
  if (entry.provider === "github-copilot") return entry.refresh ? shaHex(entry.refresh, 16) : "";
  return entry.accessHash;
}

function canProbeEntry(entry: ParsedOAuthEntry, store: PiLoginStore, now: number, force = false): boolean {
  if (!ONLINE_PROFILE_PROVIDERS.has(entry.provider)) return false;
  if (entryHasResolvedIdentity(entry, store)) return false;
  const probeHash = tokenHashForProbe(entry);
  if (!probeHash) return false;
  // github-copilot 用长期 GitHub OAuth refresh token 调 /user，不受短期 Copilot access 过期影响
  if (entry.provider !== "github-copilot") {
    const expired = entry.expires != null && entry.expires > 0 && entry.expires <= now - PI_EXPIRY_GRACE_MS;
    if (expired && !force) return false;
  }
  const prevFail = failedAccess.get(entry.fingerprint);
  if (prevFail && prevFail.hash === probeHash) {
    if (prevFail.sticky) return false;
    if (!force && now - prevFail.at < 5 * 60_000) return false;
  }
  return true;
}

/** 是否存在尚未拿到真实邮箱/用户名、且当前有可用令牌的 pi OAuth 登录。 */
export function hasUnresolvedPiOAuth(now = Date.now()): boolean {
  const read = readPiAuthRaw();
  if (read.status !== "ok") return false;
  const store = readPiLoginStore();
  const { oauth } = parseOAuthEntries(read.doc);
  return oauth.some((entry) => canProbeEntry(entry, store, now, false));
}

async function fetchGoogleUserInfo(
  accessToken: string,
  getJson: (url: string, headers: string[]) => Promise<Record<string, unknown>>,
): Promise<ResolvedIdentityInput | null> {
  const headers = [`Authorization: Bearer ${accessToken}`, "Accept: application/json"];
  let lastError: unknown = null;
  for (const url of [PI_GOOGLE_OIDC_USERINFO_URL, PI_GOOGLE_V2_USERINFO_URL]) {
    try {
      const info = await getJson(url, headers);
      const email = str(info?.email);
      const name = str(info?.name);
      const sub = str(info?.sub) || str(info?.id);
      if (email || sub) return { email, name, sub };
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message === "auth") throw error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function fetchAnthropicProfile(
  accessToken: string,
  getJson: (url: string, headers: string[]) => Promise<Record<string, unknown>>,
): Promise<ResolvedIdentityInput | null> {
  const info = await getJson(PI_ANTHROPIC_PROFILE_URL, [
    `Authorization: Bearer ${accessToken}`,
    "Accept: application/json",
    "anthropic-beta: oauth-2025-04-20",
    "anthropic-version: 2023-06-01",
  ]);
  const account = (info?.account && typeof info.account === "object" ? info.account : {}) as Record<string, unknown>;
  const org = (info?.organization && typeof info.organization === "object" ? info.organization : {}) as Record<string, unknown>;
  const email = str(account.email) || str(account.email_address) || str(info?.email);
  const name = str(account.display_name) || str(account.full_name) || str(info?.name);
  const sub = str(account.uuid) || str(account.id) || str(info?.sub);
  const orgId = str(org.uuid) || str(org.id);
  return email || sub ? { email, name, sub, orgId } : null;
}

function githubUserApiUrl(enterpriseUrl?: string): string {
  if (!enterpriseUrl) return PI_GITHUB_USER_URL;
  try {
    const parsed = new URL(enterpriseUrl.includes("://") ? enterpriseUrl : `https://${enterpriseUrl}`);
    if (parsed.protocol !== "https:" || !parsed.hostname) return PI_GITHUB_USER_URL;
    if (parsed.hostname.toLowerCase() === "github.com") return PI_GITHUB_USER_URL;
    return `https://${parsed.hostname}/api/v3/user`;
  } catch {
    return PI_GITHUB_USER_URL;
  }
}

async function fetchGitHubUser(
  githubToken: string,
  enterpriseUrl: string | undefined,
  getJson: (url: string, headers: string[]) => Promise<Record<string, unknown>>,
): Promise<ResolvedIdentityInput | null> {
  const url = githubUserApiUrl(enterpriseUrl);
  const info = await getJson(url, [
    `Authorization: Bearer ${githubToken}`,
    "Accept: application/vnd.github+json",
    "User-Agent: TokenPulse",
  ]);
  const email = str(info?.email);
  const login = str(info?.login);
  const name = str(info?.name);
  const sub = typeof info?.id === "number" || typeof info?.id === "string" ? String(info.id).trim() : "";
  return email || login || sub ? { email, login, name, sub } : null;
}

async function fetchOidcUserInfo(
  url: string,
  accessToken: string,
  getJson: (url: string, headers: string[]) => Promise<Record<string, unknown>>,
): Promise<ResolvedIdentityInput | null> {
  const info = await getJson(url, [`Authorization: Bearer ${accessToken}`, "Accept: application/json"]);
  const email = str(info?.email);
  const name = str(info?.name);
  const sub = str(info?.sub) || str(info?.id);
  return email || sub ? { email, name, sub } : null;
}

async function fetchPiProviderProfile(
  entry: ParsedOAuthEntry,
  getJson: (url: string, headers: string[]) => Promise<Record<string, unknown>>,
): Promise<ResolvedIdentityInput | null> {
  if (entry.provider === PI_GOOGLE_AI_PLAN) return fetchGoogleUserInfo(entry.access, getJson);
  if (entry.provider === "anthropic") return fetchAnthropicProfile(entry.access, getJson);
  if (entry.provider === "github-copilot") return fetchGitHubUser(entry.refresh, entry.enterpriseUrl, getJson);
  if (entry.provider === "openai" || entry.provider === "openai-codex" || entry.provider === "openai-chatgpt") {
    return fetchOidcUserInfo(PI_OPENAI_USERINFO_URL, entry.access, getJson);
  }
  if (entry.provider === "xai") return fetchOidcUserInfo(PI_XAI_USERINFO_URL, entry.access, getJson);
  return null;
}

/**
 * 异步同步 pi OAuth 账号身份（主进程在刷新前或 auth.json 变更时调用）：
 * - 对支持只读资料查询的 OAuth provider（Google AI Plan / Anthropic / GitHub Copilot / OpenAI / xAI），
 *   在尚未缓存邮箱（或 GitHub 用户名）且令牌可用时查询并缓存，再原地升级 `pi-logins.json`；
 * - 遵守出口白名单 `gate`；已命中缓存时零网络请求；网络/401 错误静默降级并退避。
 */
export function syncPiAccounts(deps: PiSyncDeps = {}): Promise<{ changed: boolean; resolved: string[] }> {
  if (!deps.getJson && syncInFlight) return syncInFlight;
  const run = (async (): Promise<{ changed: boolean; resolved: string[] }> => {
    const now = deps.now ?? Date.now();
    const store = recordPiLogins(now);
    const read = readPiAuthRaw();
    if (read.status !== "ok") return { changed: false, resolved: [] };

    const { oauth } = parseOAuthEntries(read.doc);
    const getJson = deps.getJson ?? ((url: string, headers: string[]) => curlJson(url, headers, 10_000));
    let changed = false;
    const resolved: string[] = [];

    for (const entry of oauth) {
      if (!canProbeEntry(entry, store, now, Boolean(deps.force))) continue;
      const officialKind = piOfficialKindOf(entry.provider);
      if (officialKind && deps.gate) {
        const allowed = await deps.gate(officialKind).catch(() => false);
        if (!allowed) continue;
      }
      const probeHash = tokenHashForProbe(entry);
      try {
        const info = await fetchPiProviderProfile(entry, getJson);
        if (info && (info.email || info.login || info.sub)) {
          failedAccess.delete(entry.fingerprint);
          const merged: ResolvedIdentityInput = {
            email: info.email || entry.offline.email,
            login: info.login || entry.offline.login,
            name: info.name || entry.offline.name,
            sub: info.sub || entry.offline.sub,
            accountId: info.accountId || entry.offline.accountId,
            userId: info.userId || entry.offline.userId,
            orgId: info.orgId || entry.offline.orgId,
          };
          if (applyResolvedIdentityToStore(store, entry.provider, entry.fingerprint, merged, now)) {
            changed = true;
          }
          resolved.push(merged.email || merged.login || merged.sub || entry.provider);
        } else {
          // 返回成功但不含任何身份字段：同令牌不再重复探测
          failedAccess.set(entry.fingerprint, { hash: probeHash, at: now, sticky: true });
        }
      } catch (error) {
        const authFailed = error instanceof Error && error.message === "auth";
        const notFound = error instanceof HttpError && (error.status === 404 || error.status === 405);
        failedAccess.set(entry.fingerprint, { hash: probeHash, at: now, sticky: authFailed || notFound });
        log.warn(
          "auth",
          `pi ${entry.provider} 账号识别暂未成功（${authFailed ? "access 令牌已过期，待 pi 刷新" : notFound ? "服务端不支持该资料接口" : errorText(error)}）`,
        );
      }
    }

    if (changed) {
      try {
        writePiLoginStore(store);
      } catch { /* 只读时跳过 */ }
    }
    return { changed, resolved };
  })();

  if (!deps.getJson) {
    syncInFlight = run.finally(() => {
      if (syncInFlight === run) syncInFlight = null;
    });
    return syncInFlight;
  }
  return run;
}

/**
 * 构建三家官方账号（Claude / ChatGPT / Grok）的只读索引，供 pi 账号安全联动归属。
 * 仅在精确 ID / 唯一邮箱 / 唯一工作区匹配时联动，遇到多账号共享同邮箱或同工作区时不猜。
 */
export function buildOfficialAccountIndex(): OfficialAccountIndex {
  const byId = new Set<string>();
  const byEmail = new Map<string, string>();
  const byWorkspace = new Map<string, string>();
  const bySub = new Map<string, string>();

  const putUnique = (map: Map<string, string>, key: string, id: string) => {
    if (!key) return;
    const prev = map.get(key);
    if (prev === undefined) map.set(key, id);
    else if (prev !== id) map.set(key, ""); // 多个账号冲突时不猜
  };

  const register = (kind: OfficialAccountKind, id: string, email?: string) => {
    if (!id || !id.startsWith(`${kind}:`)) return;
    byId.add(id);
    const ref = id.slice(kind.length + 1);
    if (email) putUnique(byEmail, `${kind}:${email.trim().toLowerCase()}`, id);
    if (kind === "claude" || kind === "grok") {
      if (ref && !ref.startsWith("token:") && !ref.startsWith("email:")) putUnique(bySub, `${kind}:${ref}`, id);
    } else if (kind === "chatgpt") {
      const at = ref.indexOf("@");
      if (at > 0 && at < ref.length - 1) {
        putUnique(byWorkspace, `chatgpt:${ref.slice(at + 1)}`, id);
      } else if (ref && !ref.startsWith("token:") && !ref.startsWith("email:")) {
        putUnique(byWorkspace, `chatgpt:${ref}`, id);
      }
    }
  };

  const official = readOfficialAccountStore();
  for (const account of official.accounts) {
    if (account.hidden) continue;
    register(account.kind, account.id, account.email);
  }
  const cliTimeline = readJson<{ version?: number; kinds?: Partial<Record<OfficialAccountKind, { id?: string; email?: string }[]>> } | null>(
    dataFile("cli-logins.json"),
    null,
  );
  if (cliTimeline?.version === 1 && cliTimeline.kinds) {
    for (const kind of ["claude", "chatgpt", "grok"] as const) {
      for (const span of cliTimeline.kinds[kind] ?? []) {
        if (span?.id) register(kind, span.id, span.email);
      }
    }
  }
  return { byId, byEmail, byWorkspace, bySub };
}

/** 查找某个 pi OAuth 身份是否对应本机已登记的 Claude / ChatGPT / Grok 官方账号。 */
export function linkedOfficialAccountId(
  provider: string | undefined,
  identity: { email?: string; sub?: string; accountId?: string; userId?: string },
  index: OfficialAccountIndex = buildOfficialAccountIndex(),
): string | undefined {
  const kind = piOfficialKindOf(provider);
  if (!kind) return undefined;
  const sub = str(identity.sub);
  const accountId = str(identity.accountId);
  const userId = str(identity.userId);
  const email = str(identity.email).toLowerCase();

  if (kind === "claude" && sub) {
    const exact = `claude:${sub}`;
    if (index.byId.has(exact)) return exact;
    const hit = index.bySub.get(`claude:${sub}`);
    if (hit) return hit;
  }
  if (kind === "chatgpt" && userId && accountId) {
    const exact = `chatgpt:${userId}@${accountId}`;
    if (index.byId.has(exact)) return exact;
  }
  if (kind === "grok" && sub) {
    const exact = `grok:${sub}`;
    if (index.byId.has(exact)) return exact;
    const hit = index.bySub.get(`grok:${sub}`);
    if (hit) return hit;
  }
  if (email) {
    const hit = index.byEmail.get(`${kind}:${email}`);
    if (hit) return hit;
  }
  if (kind === "chatgpt" && accountId) {
    const hit = index.byWorkspace.get(`chatgpt:${accountId}`);
    if (hit) return hit;
  }
  return undefined;
}

/** 判断某条 pi 请求的 provider 当前是否属于官方订阅登录（true）、API Key/中转（false）或未知（undefined）。 */
export function isPiProviderOfficial(provider: string | undefined, store: PiLoginStore = readPiLoginStore()): boolean | undefined {
  const p = normalizePiProvider(provider);
  if (!p) return undefined;
  if (p === "tokenpulse_route" || API_KEY_OAUTH_PROVIDERS.has(p)) return false;
  if (OAUTH_ONLY_SUBSCRIPTION_PROVIDERS.has(p)) return true;
  const knownType = store.providerTypes[p];
  if (knownType === "api_key") return false;
  if (knownType === "oauth") return SUBSCRIPTION_PROVIDERS.has(p) ? true : undefined;
  const spans = store.providers[p];
  if (spans?.length) {
    const last = spans.at(-1);
    if (last?.id) return SUBSCRIPTION_PROVIDERS.has(p) ? true : undefined;
    if (last?.mode === "api_key") return false;
    // 已登出的双模订阅 provider（例如退出 OAuth 后改用环境变量 API Key）：不再当成订阅
    if (SUBSCRIPTION_PROVIDERS.has(p)) return false;
  }
  return undefined;
}

/**
 * 按请求时间点 `at` 判断 pi 的 provider 归属（时间线感知，防止 API Key ↔ OAuth 切换或登出回溯污染历史）。
 */
export function isPiProviderOfficialAt(
  provider: string | undefined,
  at: number,
  store: PiLoginStore = readPiLoginStore(),
): boolean | undefined {
  const p = normalizePiProvider(provider);
  if (!p) return undefined;
  if (p === "tokenpulse_route" || API_KEY_OAUTH_PROVIDERS.has(p)) return false;
  if (OAUTH_ONLY_SUBSCRIPTION_PROVIDERS.has(p)) return true;
  if (!SUBSCRIPTION_PROVIDERS.has(p)) return isPiProviderOfficial(p, store);

  const spans = store.providers[p];
  if (!spans?.length) return isPiProviderOfficial(p, store);
  let hit: PiLoginSpan | undefined;
  for (const span of spans) {
    if (span.from <= at) hit = span;
    else break;
  }
  if (hit) {
    if (hit.id) return true;
    // 明确切换成了 api_key 或已退出 OAuth（之后若仍有请求，属于环境变量/自定义 API Key）
    return false;
  }
  // 时间线开始前的历史请求：看首段模式，避免后来切 API Key 或 OAuth 反向覆写
  const first = spans[0];
  if (first.mode === "api_key") return false;
  if (first.id) return true;
  return isPiProviderOfficial(p, store);
}

/** 按时间线把一条 pi 请求（provider + 时间戳 at）解析到对应的登录账号（含三家官方账号自动联动）。 */
export function resolvePiAccount(
  provider: string | undefined,
  at: number,
  store: PiLoginStore,
  labels: Map<string, string>,
  officialIndex?: OfficialAccountIndex,
): { id: string; label: string; basis: "timeline" | "inferred" } | null {
  const p = normalizePiProvider(provider);
  if (!p || API_KEY_OAUTH_PROVIDERS.has(p)) return null;
  const spans = store.providers[p];
  if (!spans?.length) return null;
  let hit: PiLoginSpan | undefined;
  for (const span of spans) {
    if (span.from <= at) hit = span;
    else break;
  }
  const chosen = hit ?? spans.find((span) => span.id);
  const basis: "timeline" | "inferred" = hit ? "timeline" : "inferred";
  if (!chosen || !chosen.id) return null;

  const cached = chosen.fingerprint ? store.identities[chosen.fingerprint] : undefined;
  const linked = linkedOfficialAccountId(
    p,
    {
      email: chosen.email || cached?.email,
      sub: chosen.sub || cached?.sub,
      accountId: chosen.accountId || cached?.accountId,
      userId: chosen.userId || cached?.userId,
    },
    officialIndex,
  );
  if (linked) {
    return {
      id: linked,
      label: labels.get(linked) ?? (chosen.email || chosen.label || linked),
      basis,
    };
  }
  const alias = store.aliases?.[chosen.id];
  return {
    id: chosen.id,
    label: alias || labels.get(chosen.id) || chosen.email || chosen.label || chosen.id,
    basis,
  };
}

/** 给设置页展示的 pi OAuth 账号只读视图（不含任何凭据）。 */
export function listPiAccountStatus(now = Date.now()): PiAccountStatus {
  const installed = fs.existsSync(piDir());
  const read = readPiAuthRaw();
  const hasAuthFile = read.status === "ok";
  const store = recordPiLogins(now);
  const officialIndex = buildOfficialAccountIndex();

  const sharedAliasByEmail = new Map<string, string>();
  for (const acc of readOfficialAccountStore().accounts) {
    if (acc.email && acc.alias) sharedAliasByEmail.set(acc.email.toLowerCase(), acc.alias);
  }
  for (const acc of readAgyAccountStore().accounts) {
    if (acc.email && acc.alias) sharedAliasByEmail.set(acc.email.toLowerCase(), acc.alias);
  }

  const activeByProvider = new Map<string, ParsedOAuthEntry>();
  if (read.status === "ok") {
    for (const entry of parseOAuthEntries(read.doc).oauth) {
      activeByProvider.set(entry.provider, entry);
    }
  }

  const rowsById = new Map<string, PiAccountStatusRow>();

  for (const [provider, spans] of Object.entries(store.providers)) {
    if (API_KEY_OAUTH_PROVIDERS.has(provider)) continue;
    const activeEntry = activeByProvider.get(provider);
    const lastSpan = spans.at(-1);
    const activeId = activeEntry && lastSpan?.id ? lastSpan.id : "";

    for (const span of spans) {
      if (!span.id) continue;
      const cached = span.fingerprint ? store.identities[span.fingerprint] : undefined;
      const email = span.email || cached?.email || "";
      const login = span.login || cached?.login || undefined;
      const label = span.label || cached?.label || fallbackLabelOf(provider);
      const inAuth = Boolean(activeEntry && span.id === activeId);
      const isProvisional = isProvisionalId(provider, span.id) && !email && !login;
      const expiresAt = inAuth ? activeEntry?.expires : undefined;
      const expired = Boolean(
        inAuth &&
        provider !== "github-copilot" &&
        expiresAt != null &&
        expiresAt > 0 &&
        expiresAt <= now - PI_EXPIRY_GRACE_MS,
      );
      const status: PiAccountStatusRow["status"] = !inAuth
        ? "logged_out"
        : isProvisional
          ? expired ? "expired" : "provisional"
          : "resolved";
      const linkedOfficialId = linkedOfficialAccountId(
        provider,
        {
          email,
          sub: span.sub || cached?.sub,
          accountId: span.accountId || cached?.accountId,
          userId: span.userId || cached?.userId,
        },
        officialIndex,
      );
      const ownAlias = store.aliases?.[span.id];
      const sharedAlias = email ? sharedAliasByEmail.get(email.toLowerCase()) : undefined;
      const prev = rowsById.get(span.id);
      rowsById.set(span.id, {
        id: span.id,
        provider,
        providerName: piProviderDisplayName(provider),
        email,
        ...(login ? { login } : {}),
        label,
        ...(ownAlias || sharedAlias ? { alias: ownAlias || sharedAlias } : {}),
        inAuth: Boolean(prev?.inAuth || inAuth),
        status: prev?.inAuth ? prev.status : status,
        ...(expiresAt ? { expiresAt } : prev?.expiresAt ? { expiresAt: prev.expiresAt } : {}),
        ...(linkedOfficialId ? { linkedOfficialId, linkedKind: piOfficialKindOf(provider) } : {}),
        lastSeenAt: Math.max(prev?.lastSeenAt ?? 0, span.from, cached?.updatedAt ?? 0),
      });
    }
  }

  const accounts = [...rowsById.values()].sort((a, b) => Number(b.inAuth) - Number(a.inAuth) || b.lastSeenAt - a.lastSeenAt || a.provider.localeCompare(b.provider));
  return { installed, hasAuthFile, accounts };
}

/** 为独立的 pi 账号起别名（留空则清除别名）。绝不修改 auth.json。 */
export function renamePiAccount(id: string, alias: string): PiAccountStatus {
  if (typeof id !== "string" || !id.startsWith("pi:") || id.length > 200) throw new Error("pi 账号参数无效");
  const store = readPiLoginStore();
  const next = str(alias).slice(0, 40);
  store.aliases ??= {};
  if (next) store.aliases[id] = next;
  else delete store.aliases[id];
  writePiLoginStore(store);
  return listPiAccountStatus();
}

/**
 * 清理一条 pi 账号本地记录（绝不修改 ~/.pi/agent/auth.json）：
 * - 对已登出的历史账号：从时间线与身份缓存中移除；
 * - 对当前仍在 auth.json 登录的账号：清除其身份缓存和失败退避，便于重新识别。
 */
export function removePiAccount(id: string): PiAccountStatus {
  if (typeof id !== "string" || !id.startsWith("pi:") || id.length > 200) throw new Error("pi 账号参数无效");
  const store = readPiLoginStore();
  if (store.aliases) delete store.aliases[id];
  const dropFingerprints = new Set<string>();
  for (const [provider, spans] of Object.entries(store.providers)) {
    const kept: PiLoginSpan[] = [];
    for (const span of spans) {
      if (span.id === id) {
        if (span.fingerprint) dropFingerprints.add(span.fingerprint);
        continue;
      }
      kept.push(span);
    }
    // 清理开头的孤立登出段
    while (kept.length && !kept[0].id && kept[0].mode !== "api_key") kept.shift();
    if (kept.length) store.providers[provider] = kept;
    else delete store.providers[provider];
  }
  for (const fp of dropFingerprints) {
    delete store.identities[fp];
    failedAccess.delete(fp);
  }
  writePiLoginStore(store);
  return listPiAccountStatus();
}
