import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { errorText, log } from "./app-log";
import { jwtClaims } from "./credentials";
import { curlJson } from "./curl";
import { dataFile, piDir, readJson, writeJson } from "./paths";

/**
 * pi (`~/.pi/agent/auth.json`) OAuth 账号识别与登录时间线。
 *
 * 重点适配 Google AI Ultra plan（earendil-works/pi PR #12614，provider = `google-ai-plan`）：
 * - pi 登录后把 `{ type: "oauth", access, refresh, expires, dpopKey, dpopNonce? }` 写进 `~/.pi/agent/auth.json`，
 *   不保存 `id_token` 或邮箱，且 `access` 是 Google OAuth2 不透明访问令牌（含 `openid email profile` 权限）；
 * - TokenPulse 严格只读 `auth.json`、绝不触碰 `dpopKey` / `refresh` 也不发 token 刷新请求，避免破坏 pi 的 DPoP nonce；
 * - 对单向 SHA-256 指纹（`refresh` / `dpopKey` 公钥坐标派生，不落盘任何原始凭据）缓存 Google UserInfo 返回的邮箱与姓名，
 *   access 过期后仍可命中缓存；首次遇到已过期 token 时先记下占位段，等 pi 下次自动刷新 access 后原地补齐真实邮箱；
 * - 同时离线解析 `openai-codex` / `openai-chatgpt` / `xai` 等带 JWT 或 `email`/`accountId` 字段的 pi OAuth 凭据。
 */

export const PI_GOOGLE_AI_PLAN = "google-ai-plan";
export const PI_GOOGLE_OIDC_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const PI_GOOGLE_V2_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

/** 明确属于订阅制（而非按量 API Key）的 pi 内置 OAuth provider。 */
const SUBSCRIPTION_PROVIDERS = new Set([
  PI_GOOGLE_AI_PLAN,
  "anthropic",
  "openai-codex",
  "openai-chatgpt",
  "xai",
  "github-copilot",
]);

const PROVIDER_FALLBACK_LABEL: Record<string, string> = {
  [PI_GOOGLE_AI_PLAN]: "Google AI Plan 账号",
  anthropic: "Anthropic 账号",
  "openai-codex": "OpenAI Codex 账号",
  "openai-chatgpt": "OpenAI ChatGPT 账号",
  xai: "xAI 账号",
  "github-copilot": "GitHub Copilot 账号",
};

const MAX_SPANS_PER_PROVIDER = 500;
const MAX_IDENTITIES = 200;

export type PiCachedIdentity = {
  provider: string;
  email: string;
  name?: string;
  sub?: string;
  accountId?: string;
  label: string;
  updatedAt: number;
};

export type PiLoginSpan = {
  from: number;
  /** 空串表示已退出登录。 */
  id: string;
  email: string;
  label: string;
  /** 单向凭据指纹（不含原始凭据），用于首次过期占位后、access 刷新时原地升级为真实邮箱。 */
  fingerprint?: string;
};

export type PiLoginStore = {
  version: 1;
  providers: Record<string, PiLoginSpan[]>;
  identities: Record<string, PiCachedIdentity>;
  providerTypes: Record<string, "oauth" | "api_key">;
};

type RawAuthEntry = Record<string, unknown>;

type ParsedOAuthEntry = {
  provider: string;
  access: string;
  refresh: string;
  expires?: number;
  fingerprint: string;
  accessHash: string;
  offline: { email: string; name: string; sub: string; accountId: string };
};

export type PiSyncDeps = {
  now?: number;
  force?: boolean;
  getJson?: (url: string, headers: string[]) => Promise<Record<string, unknown>>;
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
  return PROVIDER_FALLBACK_LABEL[p] ?? `${provider} 账号`;
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
      const clean = list.filter(
        (item): item is PiLoginSpan =>
          Boolean(item && typeof item === "object" && typeof item.from === "number" && typeof item.id === "string" && typeof item.email === "string" && typeof item.label === "string"),
      );
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
          ...(typeof row.name === "string" && row.name ? { name: row.name } : {}),
          ...(typeof row.sub === "string" && row.sub ? { sub: row.sub } : {}),
          ...(typeof row.accountId === "string" && row.accountId ? { accountId: row.accountId } : {}),
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
  return { version: 1, providers, identities, providerTypes };
}

export function writePiLoginStore(store: PiLoginStore): PiLoginStore {
  const trimmedIdentities: Record<string, PiCachedIdentity> = {};
  const sortedIds = Object.entries(store.identities).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)).slice(0, MAX_IDENTITIES);
  for (const [k, v] of sortedIds) trimmedIdentities[k] = v;
  const trimmedProviders: Record<string, PiLoginSpan[]> = {};
  for (const [k, spans] of Object.entries(store.providers)) {
    if (spans.length) trimmedProviders[k] = spans.slice(-MAX_SPANS_PER_PROVIDER);
  }
  const out: PiLoginStore = {
    version: 1,
    providers: trimmedProviders,
    identities: trimmedIdentities,
    providerTypes: store.providerTypes,
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

function extractOfflineIdentity(entry: RawAuthEntry): { email: string; name: string; sub: string; accountId: string } {
  let email = str(entry.email);
  let name = str(entry.name);
  let sub = str(entry.sub);
  let accountId = str(entry.accountId) || str(entry.account_id);

  for (const tokenField of ["id_token", "idToken", "access"] as const) {
    const rawToken = str(entry[tokenField]);
    if (!rawToken || rawToken.split(".").length !== 3) continue;
    const claims = jwtClaims(rawToken);
    if (!claims || typeof claims !== "object") continue;
    const profile = claims["https://api.openai.com/profile"] as Record<string, unknown> | undefined;
    const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    if (!email) email = str(claims.email) || str(profile?.email);
    if (!name) name = str(claims.name) || str(profile?.name);
    if (!sub) sub = str(claims.sub);
    if (!accountId) accountId = str(auth?.chatgpt_account_id) || str(claims.account_id);
  }
  return { email, name, sub, accountId };
}

function fingerprintOf(provider: string, entry: RawAuthEntry, offline: { email: string; sub: string; accountId: string }): string {
  const refresh = str(entry.refresh);
  const access = str(entry.access);
  const dpop = entry.dpopKey && typeof entry.dpopKey === "object" ? (entry.dpopKey as Record<string, unknown>) : null;
  // 优先用不随 access 刷新变化的稳定标识：DPoP 公钥坐标 / refresh / accountId / sub / email / access
  const pubCoord = dpop && str(dpop.x) && str(dpop.y) ? `${str(dpop.x)}.${str(dpop.y)}` : "";
  const material = pubCoord || refresh || offline.accountId || offline.sub || offline.email.toLowerCase() || access;
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
    types[provider] = "oauth";
    const access = str(rawVal.access);
    const refresh = str(rawVal.refresh);
    const expires = typeof rawVal.expires === "number" && Number.isFinite(rawVal.expires) ? rawVal.expires : undefined;
    const offline = extractOfflineIdentity(rawVal);
    const fingerprint = fingerprintOf(provider, rawVal, offline);
    if (!fingerprint) continue;
    oauth.push({
      provider,
      access,
      refresh,
      expires,
      fingerprint,
      accessHash: access ? shaHex(access, 16) : "",
      offline,
    });
  }
  return { oauth, types };
}

function applyResolvedIdentityToStore(
  store: PiLoginStore,
  provider: string,
  fingerprint: string,
  identity: { email: string; name?: string; sub?: string; accountId?: string },
  now: number,
): boolean {
  let changed = false;
  const email = str(identity.email);
  const name = str(identity.name);
  const sub = str(identity.sub);
  const accountId = str(identity.accountId);
  const label = email || name || accountId || fallbackLabelOf(provider);
  const id = piAccountIdOf(provider, email, sub || accountId, fingerprint);

  if (email || sub || accountId) {
    const prev = store.identities[fingerprint];
    if (!prev || prev.email !== email || prev.label !== label || prev.sub !== (sub || undefined) || prev.accountId !== (accountId || undefined)) {
      store.identities[fingerprint] = {
        provider,
        email,
        ...(name ? { name } : {}),
        ...(sub ? { sub } : {}),
        ...(accountId ? { accountId } : {}),
        label,
        updatedAt: now,
      };
      changed = true;
    }
  }

  const spans = (store.providers[provider] ??= []);
  // 将同一指纹的历史占位段一并原地升级为真实邮箱（不改 from 时间戳）
  for (const span of spans) {
    if (span.fingerprint && span.fingerprint === fingerprint) {
      if (span.id !== id || span.email !== email || span.label !== label) {
        span.id = id;
        span.email = email;
        span.label = label;
        changed = true;
      }
    }
  }
  const last = spans.at(-1);
  if (last && (last.id === id || (last.fingerprint && last.fingerprint === fingerprint))) {
    if (last.id !== id || last.email !== email || last.label !== label || last.fingerprint !== fingerprint) {
      last.id = id;
      last.email = email;
      last.label = label;
      last.fingerprint = fingerprint;
      changed = true;
    }
  } else {
    spans.push({ from: now, id, email, label, fingerprint });
    changed = true;
  }
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

  if (read.status === "ok") {
    const { oauth, types } = parseOAuthEntries(read.doc);
    for (const [provider, kind] of Object.entries(types)) {
      if (store.providerTypes[provider] !== kind) {
        store.providerTypes[provider] = kind;
        changed = true;
      }
    }
    for (const entry of oauth) {
      activeOAuthProviders.add(entry.provider);
      const cached = store.identities[entry.fingerprint];
      const email = entry.offline.email || cached?.email || "";
      const name = entry.offline.name || cached?.name || "";
      const sub = entry.offline.sub || cached?.sub || "";
      const accountId = entry.offline.accountId || cached?.accountId || "";
      if (applyResolvedIdentityToStore(store, entry.provider, entry.fingerprint, { email, name, sub, accountId }, now)) {
        changed = true;
      }
    }
  }

  // auth.json 存在但某个 provider 已移除，或 auth.json 已删（且 .pi/agent 目录存在）：标记退出登录
  const shouldMarkLogout = read.status === "ok" || (read.status === "missing" && fs.existsSync(piDir()));
  if (shouldMarkLogout) {
    for (const [provider, spans] of Object.entries(store.providers)) {
      if (activeOAuthProviders.has(provider)) continue;
      const last = spans.at(-1);
      if (last && last.id) {
        spans.push({ from: now, id: "", email: "", label: "" });
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

/** 失败过的 access token 哈希（仅内存态，防止过期/失效 token 每分钟反复请求 Google UserInfo）。 */
const failedAccess = new Map<string, { hash: string; at: number; authFailed: boolean }>();
let syncInFlight: Promise<{ changed: boolean; resolved: string[] }> | null = null;

export function resetPiSyncCache(): void {
  failedAccess.clear();
  syncInFlight = null;
}

/** pi 存 expires 时会提前扣 5 分钟安全余量，过 expires 后 5 分钟内实际令牌往往仍有效。 */
const PI_EXPIRY_GRACE_MS = 5 * 60_000;

/** 是否存在尚未拿到真实邮箱、且当前有可用 access token 的 pi Google AI Plan 登录。 */
export function hasUnresolvedPiOAuth(now = Date.now()): boolean {
  const read = readPiAuthRaw();
  if (read.status !== "ok") return false;
  const store = readPiLoginStore();
  const { oauth } = parseOAuthEntries(read.doc);
  for (const entry of oauth) {
    if (entry.provider !== PI_GOOGLE_AI_PLAN) continue;
    if (entry.offline.email || store.identities[entry.fingerprint]?.email) continue;
    if (!entry.access) continue;
    if (entry.expires != null && entry.expires > 0 && entry.expires <= now - PI_EXPIRY_GRACE_MS) continue;
    const prevFail = failedAccess.get(entry.fingerprint);
    if (prevFail && prevFail.hash === entry.accessHash && (prevFail.authFailed || now - prevFail.at < 5 * 60_000)) continue;
    return true;
  }
  return false;
}

async function fetchGoogleUserInfo(
  accessToken: string,
  getJson: (url: string, headers: string[]) => Promise<Record<string, unknown>>,
): Promise<{ email: string; name: string; sub: string } | null> {
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

/**
 * 异步同步 pi OAuth 账号身份（主进程在刷新前调用）：
 * - 对 `google-ai-plan`（Google AI Ultra plan），在尚未缓存该凭据指纹的邮箱且 access token 未过期时，
 *   调用 Google OIDC UserInfo 解析邮箱并缓存，再原地升级 `pi-logins.json` 中的登录段。
 * - 已命中缓存时零网络请求（<1 ms）；遇到网络或 401 错误时静默降级不抛错。
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
      if (entry.provider !== PI_GOOGLE_AI_PLAN) continue;
      if (entry.offline.email || store.identities[entry.fingerprint]?.email) continue;
      if (!entry.access) continue;
      const expired = entry.expires != null && entry.expires > 0 && entry.expires <= now - PI_EXPIRY_GRACE_MS;
      if (expired && !deps.force) continue;
      const prevFail = failedAccess.get(entry.fingerprint);
      if (prevFail && prevFail.hash === entry.accessHash) {
        if (prevFail.authFailed) continue;
        if (!deps.force && now - prevFail.at < 5 * 60_000) continue;
      }
      try {
        const info = await fetchGoogleUserInfo(entry.access, getJson);
        if (info && (info.email || info.sub)) {
          failedAccess.delete(entry.fingerprint);
          if (applyResolvedIdentityToStore(store, entry.provider, entry.fingerprint, info, now)) {
            changed = true;
          }
          resolved.push(info.email || info.sub);
        }
      } catch (error) {
        const authFailed = error instanceof Error && error.message === "auth";
        failedAccess.set(entry.fingerprint, { hash: entry.accessHash, at: now, authFailed });
        log.warn("auth", `pi google-ai-plan 账号识别暂未成功（${authFailed ? "access 令牌已过期，待 pi 刷新" : errorText(error)}）`);
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

/** 判断某条 pi 请求的 provider 是否属于官方订阅登录（true）、API Key/中转（false）或未知（undefined）。 */
export function isPiProviderOfficial(provider: string | undefined, store: PiLoginStore = readPiLoginStore()): boolean | undefined {
  const p = normalizePiProvider(provider);
  if (!p) return undefined;
  if (p === "tokenpulse_route") return false;
  if (p === PI_GOOGLE_AI_PLAN) return true;
  const knownType = store.providerTypes[p];
  if (knownType === "api_key") return false;
  if (knownType === "oauth") return SUBSCRIPTION_PROVIDERS.has(p) ? true : undefined;
  if (store.providers[p]?.length) return SUBSCRIPTION_PROVIDERS.has(p) ? true : undefined;
  return undefined;
}

/** 按时间线把一条 pi 请求（provider + 时间戳 at）解析到对应的登录账号。 */
export function resolvePiAccount(
  provider: string | undefined,
  at: number,
  store: PiLoginStore,
  labels: Map<string, string>,
): { id: string; label: string; basis: "timeline" | "inferred" } | null {
  const p = normalizePiProvider(provider);
  if (!p) return null;
  const spans = store.providers[p];
  if (!spans?.length) return null;
  let hit: PiLoginSpan | undefined;
  for (const span of spans) {
    if (span.from <= at) hit = span;
    else break;
  }
  if (hit) {
    return hit.id ? { id: hit.id, label: labels.get(hit.id) ?? (hit.email || hit.label || hit.id), basis: "timeline" } : null;
  }
  const first = spans.find((span) => span.id);
  return first ? { id: first.id, label: labels.get(first.id) ?? (first.email || first.label || first.id), basis: "inferred" } : null;
}
