import { createHash, randomBytes } from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import {
  antigravityDirs,
  antigravityHub,
  fetchAntigravityLocalSession,
  matchSummaryGroup,
  modelFamily,
  parseSummaryGroups,
  poolCategory,
  readModelLabels,
  rememberModelLabels,
  splitModelLabel,
  summaryPoolCategory,
  type AgyCredits,
  type AgyModelQuotaItem,
  type AgyQuotaGroup,
  type AgyStatus,
} from "./antigravity";
import { errorText, log } from "./app-log";
import { isExpired, jwtClaims } from "./credentials";
import { curlJson, curlPost } from "./curl";
import { startLoginLog } from "./login-log";
import { dataFile, readJson, writeJson } from "./paths";
import { getRawFs } from "./raw-fs";
import { logRenew } from "./renew-log";
import { errorCodeOf, isPermanentFailure } from "./token-refresh";

/**
 * Google Antigravity 多账号管理、Google OAuth PKCE 授权续期、本机登录时间线与 Cloud Code 直连配额拉取。
 *
 * 设计原则（与 Claude Code / Codex 的 accounts.ts + oauth.ts 一致）：
 * 1. 「登录一个新账号」走官方 Antigravity OAuth 桌面客户端（PKCE S256 + 本机回环回调），
 *    客户端 OAuth 参数在运行期直接从用户本机安装的 Antigravity（`app.asar` 或 `agy` CLI）只读提取，仓库内不硬编码任何客户端密钥；
 *    凭据存在 TokenPulse 自己的 `antigravity-accounts.json`，由本软件自动续期并直连 Google Cloud Code
 *    接口查询 5 小时与周额度 —— 完全不触碰本机 Antigravity IDE / CLI 的系统钥匙串登录，关掉客户端也能查额度；
 * 2. 「用本机 Antigravity 当前登录的账号」只登记身份（不保存 token），在 Antigravity 运行且登录着该账号时
 *    通过本机 language server 查询；同一邮箱后续点「重新授权」会原位补齐独立 OAuth 凭据，身份 ID 保持不变；
 * 3. 凭据永远不离开主进程，发往渲染进程的状态仅含脱敏展示信息。
 */

export const AGY_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const AGY_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const AGY_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
export const AGY_CLOUDCODE_ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
] as const;

export type AgyOAuthClient = {
  clientId: string;
  clientSecret: string;
  candidateSecrets?: string[];
};

/**
 * Antigravity 客户端二进制内同时包含 3 套 Google OAuth 客户端配置：
 * - Google Cloud 企业账号客户端（未注册 `auth/aicode`，用于个人授权会报 `403 restricted_client`）
 * - Google Antigravity 个人账号客户端（注册有 `https://www.googleapis.com/auth/aicode`）
 * - Google Drive 集成客户端
 * 以下仅保留单向 SHA-256 前 8 位摘要以区分三套客户端，仓库内不含任何明文 client_id / client_secret。
 */
const PERSONAL_CLIENT_ID_SHA8 = "bf00c418";
const PERSONAL_CLIENT_SECRET_SHA8 = "1d2f0410";
const NON_PERSONAL_CLIENT_ID_SHA8 = new Set(["69dee430", "1705e6c6"]);
const NON_PERSONAL_CLIENT_SECRET_SHA8 = new Set(["a2ddedc8", "9a015b93"]);

function sha8(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

let cachedOAuthClient: AgyOAuthClient | null = null;

export function clearCachedAgyOAuthClient(): void {
  cachedOAuthClient = null;
}

function antigravityOAuthBinaryCandidates(): string[] {
  const home = os.homedir();
  const out: string[] = [];
  if (process.env.TOKENPULSE_AGY_OAUTH_BINARY) out.push(process.env.TOKENPULSE_AGY_OAUTH_BINARY);
  if (process.env.TOKENPULSE_AGY_CLI) out.push(process.env.TOKENPULSE_AGY_CLI);
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const pf = process.env.PROGRAMFILES || "C:\\Program Files";
    // 从 agy.cmd 启动脚本反推自定义盘符安装目录（如 D:\Antigravity\resources\app.asar）
    const cmdWrapper = path.join(roaming, "Antigravity", "bin", "agy.cmd");
    try {
      const rawFs = getRawFs();
      if (rawFs.existsSync(cmdWrapper)) {
        const cmdText = rawFs.readFileSync(cmdWrapper, "utf8");
        const exeMatch = cmdText.match(/"([^"]+Antigravity\.exe)"/i);
        if (exeMatch?.[1]) {
          const ideRoot = path.dirname(exeMatch[1]);
          out.push(
            path.join(ideRoot, "resources", "bin", "language_server.exe"),
            path.join(ideRoot, "resources", "app.asar"),
          );
        }
      }
    } catch { /* ignore */ }
    out.push(
      path.join(local, "Programs", "antigravity", "resources", "bin", "language_server.exe"),
      path.join(pf, "Antigravity", "resources", "bin", "language_server.exe"),
      path.join(local, "agy", "bin", "agy.exe"),
      path.join(home, ".local", "bin", "agy.exe"),
      path.join(local, "Programs", "antigravity", "resources", "app.asar"),
      path.join(pf, "Antigravity", "resources", "app.asar"),
    );
  } else if (process.platform === "darwin") {
    out.push(
      "/Applications/Antigravity.app/Contents/Resources/bin/language_server",
      path.join(home, "Applications", "Antigravity.app", "Contents", "Resources", "bin", "language_server"),
      "/Applications/Antigravity.app/Contents/Resources/app.asar",
      path.join(home, "Applications", "Antigravity.app", "Contents", "Resources", "app.asar"),
      path.join(home, ".local", "bin", "agy"),
      "/opt/homebrew/bin/agy",
      "/usr/local/bin/agy",
    );
  } else {
    out.push(
      "/usr/share/antigravity/resources/bin/language_server",
      "/opt/Antigravity/resources/bin/language_server",
      "/usr/share/antigravity/resources/app.asar",
      "/opt/Antigravity/resources/app.asar",
      path.join(home, ".local", "bin", "agy"),
      "/usr/local/bin/agy",
      "/usr/bin/agy",
    );
  }
  return [...new Set(out)];
}

function findAicodeClientIdInText(text: string, hostSuffix: string): string {
  const propIdRe = new RegExp(`clientId\\s*:\\s*["'](\\d{10,}-[A-Za-z0-9_]{20,}\\.${hostSuffix})["']`, "g");
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const idx = text.indexOf("auth/aicode", searchFrom);
    if (idx < 0) break;
    searchFrom = idx + 11;
    const before = text.slice(Math.max(0, idx - 360), idx);
    const beforeMatches = [...before.matchAll(propIdRe)];
    const lastBefore = beforeMatches.at(-1);
    if (lastBefore && lastBefore.index !== undefined) {
      const between = before.slice(lastBefore.index + lastBefore[0].length);
      if (!between.includes("{") && !between.includes("}")) {
        return lastBefore[1];
      }
    }
    const after = text.slice(idx, Math.min(text.length, idx + 260));
    propIdRe.lastIndex = 0;
    const firstAfter = propIdRe.exec(after);
    if (firstAfter && firstAfter.index !== undefined) {
      const between = after.slice(0, firstAfter.index);
      if (!between.includes("{") && !between.includes("}")) {
        return firstAfter[1];
      }
    }
  }
  return "";
}

export function extractPersonalClientIdFromFile(filePath: string): string {
  const rawFs = getRawFs();
  let fd: number | null = null;
  try {
    fd = rawFs.openSync(filePath, "r");
    const stat = rawFs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 400 * 1024 * 1024) return "";
    const CHUNK = 4 * 1024 * 1024;
    const OVERLAP = 16 * 1024;
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, stat.size));
    const hostSuffix = ["apps", "googleusercontent", "com"].join("\\.");
    let pos = 0;
    let tail = "";
    while (pos < stat.size) {
      const toRead = Math.min(buf.length, stat.size - pos);
      const bytesRead = rawFs.readSync(fd, buf, 0, toRead, pos);
      if (bytesRead <= 0) break;
      const text = tail + buf.subarray(0, bytesRead).toString("latin1");
      const found = findAicodeClientIdInText(text, hostSuffix);
      if (found) return found;
      tail = text.slice(Math.max(0, text.length - OVERLAP));
      pos += bytesRead;
    }
    return "";
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        rawFs.closeSync(fd);
      } catch { /* ignore */ }
    }
  }
}

export function extractAgyOAuthClientFromFile(filePath: string, preferredClientId = ""): AgyOAuthClient | null {
  const rawFs = getRawFs();
  let fd: number | null = null;
  try {
    fd = rawFs.openSync(filePath, "r");
    const stat = rawFs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 400 * 1024 * 1024) return null;
    const CHUNK = 4 * 1024 * 1024;
    const OVERLAP = 16 * 1024;
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, stat.size));
    const hostSuffix = ["apps", "googleusercontent", "com"].join("\\.");
    const secretPrefix = "GOC" + "SPX-";
    const quotedIdRe = new RegExp(`["'](\\d{10,}-[A-Za-z0-9_]{20,}\\.${hostSuffix})["']`, "g");
    const quotedSecretRe = new RegExp(`["'](${secretPrefix}[A-Za-z0-9_-]{20,48})["']`, "g");
    const rawIdRe = new RegExp(`(\\d{10,}-[A-Za-z0-9_]{20,}\\.${hostSuffix})`, "g");
    // Go 二进制字符串表无引号与 \0 分隔，GOCSPX 桌面客户端密钥固定为前缀 7 字符 + 28 位 base64url（共 35 字符）
    const rawSecretRe = new RegExp(`(?<!["'])(${secretPrefix}[A-Za-z0-9_-]{28})`, "g");

    const ids: string[] = [];
    const seenIds = new Set<string>();
    const addId = (id: string) => {
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        ids.push(id);
      }
    };

    const secrets: string[] = [];
    const seenSecrets = new Set<string>();
    const addSecret = (sec: string) => {
      if (sec && !seenSecrets.has(sec)) {
        seenSecrets.add(sec);
        secrets.push(sec);
      }
    };

    let inlinePreferredId = "";
    const directPairSecret = new Map<string, string>();

    let pos = 0;
    let tail = "";
    while (pos < stat.size) {
      const toRead = Math.min(buf.length, stat.size - pos);
      const bytesRead = rawFs.readSync(fd, buf, 0, toRead, pos);
      if (bytesRead <= 0) break;
      const text = tail + buf.subarray(0, bytesRead).toString("latin1");

      if (!inlinePreferredId) {
        inlinePreferredId = findAicodeClientIdInText(text, hostSuffix);
      }

      for (const m of text.matchAll(quotedSecretRe)) {
        const sec = m[1];
        addSecret(sec);
        if (m.index !== undefined) {
          const win = text.slice(Math.max(0, m.index - 512), Math.min(text.length, m.index + 512));
          quotedIdRe.lastIndex = 0;
          const nearIds = [...win.matchAll(quotedIdRe)];
          if (nearIds.length === 1) {
            directPairSecret.set(nearIds[0][1], sec);
          }
        }
      }
      for (const m of text.matchAll(rawSecretRe)) {
        addSecret(m[1]);
      }
      for (const m of text.matchAll(quotedIdRe)) {
        addId(m[1]);
      }
      const activePreferred = preferredClientId || inlinePreferredId;
      for (const m of text.matchAll(rawIdRe)) {
        const raw = m[1];
        // 防御 Go 字符串表紧邻前一项末尾恰好为数字时把前缀数字拼进项目编号，同时保持文件内原始下标顺序
        let normalized = raw;
        if (activePreferred && raw !== activePreferred && raw.endsWith(activePreferred)) {
          normalized = activePreferred;
        } else {
          for (let trim = 1; trim <= 8 && raw.length - trim > 35; trim += 1) {
            const sub = raw.slice(trim);
            if (!/^\d{10,}-/.test(sub)) break;
            if (sha8(sub) === PERSONAL_CLIENT_ID_SHA8) {
              normalized = sub;
              break;
            }
          }
        }
        addId(normalized);
      }

      tail = text.slice(Math.max(0, text.length - OVERLAP));
      pos += bytesRead;
    }

    if (ids.length === 0 || secrets.length === 0) return null;

    const targetPreferred = preferredClientId || inlinePreferredId;
    const clientId =
      (targetPreferred && ids.includes(targetPreferred) ? targetPreferred : "") ||
      ids.find((id) => sha8(id) === PERSONAL_CLIENT_ID_SHA8) ||
      ids.find((id) => !NON_PERSONAL_CLIENT_ID_SHA8.has(sha8(id))) ||
      ids[0];

    const orderedSecrets: string[] = [];
    const pushSecret = (sec: string | undefined) => {
      if (sec && !orderedSecrets.includes(sec)) orderedSecrets.push(sec);
    };

    pushSecret(directPairSecret.get(clientId));
    pushSecret(secrets.find((sec) => sha8(sec) === PERSONAL_CLIENT_SECRET_SHA8));
    const idIdx = ids.indexOf(clientId);
    if (idIdx >= 0 && idIdx < secrets.length && !NON_PERSONAL_CLIENT_SECRET_SHA8.has(sha8(secrets[idIdx]))) {
      pushSecret(secrets[idIdx]);
    }
    for (const sec of secrets) {
      if (!NON_PERSONAL_CLIENT_SECRET_SHA8.has(sha8(sec))) pushSecret(sec);
    }
    for (const sec of secrets) {
      pushSecret(sec);
    }

    if (orderedSecrets.length === 0) return null;
    return {
      clientId,
      clientSecret: orderedSecrets[0],
      ...(orderedSecrets.length > 1 ? { candidateSecrets: orderedSecrets } : {}),
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        rawFs.closeSync(fd);
      } catch { /* ignore */ }
    }
  }
}

export function resolveAntigravityOAuthClient(deps: AgyNetDeps = {}): AgyOAuthClient | null {
  if (deps.oauthClient?.clientId && deps.oauthClient.clientSecret) return deps.oauthClient;
  const envId = str(process.env.TOKENPULSE_AGY_CLIENT_ID);
  const envSecret = str(process.env.TOKENPULSE_AGY_CLIENT_SECRET);
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret };
  if (cachedOAuthClient) return cachedOAuthClient;

  const candidates = antigravityOAuthBinaryCandidates();
  const asarCandidates: string[] = [];
  for (const candidate of candidates) {
    if (/\.asar$/i.test(candidate)) {
      asarCandidates.push(candidate);
    } else {
      asarCandidates.push(
        path.resolve(path.dirname(candidate), "..", "app.asar"),
        path.resolve(path.dirname(candidate), "app.asar"),
      );
    }
  }

  let preferredClientId = "";
  for (const asarPath of [...new Set(asarCandidates)]) {
    preferredClientId = extractPersonalClientIdFromFile(asarPath);
    if (preferredClientId) break;
  }

  for (const candidate of candidates) {
    const found = extractAgyOAuthClientFromFile(candidate, preferredClientId);
    if (found) {
      cachedOAuthClient = found;
      return found;
    }
  }
  return null;
}

export const AGY_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "https://www.googleapis.com/auth/aicode",
] as const;

/**
 * 额度归因模式：
 * - auto（默认）：自动剔除本机无请求区间的外部消耗 + 同期多人共用防偏移滤波，并在多账号同重置窗口时自动识别家庭组；
 * - family：显式声明处于 Google One 家庭组共享额度池（始终开启家庭组徽标、多人并发防偏移与双速率拆分）；
 * - solo：显式声明仅在这台电脑单独使用（不与其他家庭成员或其他设备共用），按整窗本机用量直接折算容量。
 */
export type AgyShareMode = "auto" | "family" | "solo";

export type AgyCredential = {
  token: string;
  refreshToken?: string;
  expiresAt?: number;
  projectId?: string;
};

export type StoredAgyAccount = {
  id: string;
  ref: string;
  email: string;
  label: string;
  alias?: string;
  credential?: AgyCredential;
  renewFailed?: string;
  renewTrouble?: { since: number; count: number; error: string };
  hidden?: boolean;
  shareMode?: AgyShareMode;
  createdAt: number;
  lastSeenAt: number;
};

export type AgyAccountStore = {
  version: 1;
  accounts: StoredAgyAccount[];
  removed?: string[];
};

export type AgyAccountView = {
  id: string;
  email: string;
  label: string;
  alias: string;
  /** 本机当前运行中的 Antigravity 正登录着该账号。 */
  inCli: boolean;
  inLocal: boolean;
  /** 已保存有效独立 OAuth 凭据（关着客户端也能直连查询）。 */
  cloudAuth: boolean;
  usable: boolean;
  autoRenew: boolean;
  needsLogin: boolean;
  /** 仅登记了本机账号、未保存独立 OAuth 凭据，且当前本机未运行或登录着别的账号。 */
  waitLocal: boolean;
  renewError?: string;
  expiresAt?: number;
  hidden: boolean;
  shareMode: AgyShareMode;
};

export type AgyOAuthStatus = {
  kind: "antigravity";
  label: "Antigravity";
  installed: boolean;
  running: boolean;
  accounts: AgyAccountView[];
};

const MAX_ALIAS = 40;
const RENEW_BEFORE_MS = 30 * 60_000;
const RENEW_GIVE_UP = 6;
const RENEW_GIVE_UP_MS = 60 * 60_000;
const LOGIN_TIMEOUT_MS = 180_000;

const storeFile = () => dataFile("antigravity-accounts.json");
const loginTimelineFile = () => dataFile("antigravity-logins.json");

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeAgyEmail(email: string): string {
  return str(email).toLowerCase();
}

export function agyRefFromIdentity(email?: string, sub?: string, fallbackToken?: string): string {
  const normEmail = normalizeAgyEmail(email || "");
  if (normEmail) return createHash("sha256").update("email:" + normEmail).digest("hex").slice(0, 16);
  const normSub = str(sub);
  if (normSub) return createHash("sha256").update("sub:" + normSub).digest("hex").slice(0, 16);
  return "tok:" + createHash("sha256").update(str(fallbackToken) || String(Date.now())).digest("hex").slice(0, 16);
}

export function agyAccountIdOf(ref: string): string {
  return ref.startsWith("antigravity:") ? ref : `antigravity:${ref}`;
}

export function normalizeShareMode(value: unknown): AgyShareMode {
  return value === "family" || value === "solo" ? value : "auto";
}

function validAccount(item: unknown): item is StoredAgyAccount {
  const row = item as StoredAgyAccount | null;
  return Boolean(
    row &&
      typeof row.id === "string" &&
      row.id.startsWith("antigravity:") &&
      typeof row.ref === "string" &&
      typeof row.email === "string" &&
      typeof row.label === "string" &&
      typeof row.createdAt === "number" &&
      typeof row.lastSeenAt === "number" &&
      (row.alias === undefined || typeof row.alias === "string") &&
      (row.credential === undefined || typeof row.credential?.token === "string"),
  );
}

export function readAgyAccountStore(): AgyAccountStore {
  const parsed = readJson<Partial<AgyAccountStore> | null>(storeFile(), null);
  if (parsed?.version !== 1 || !Array.isArray(parsed.accounts)) return { version: 1, accounts: [] };
  const accounts = parsed.accounts.filter(validAccount).map((acc) => ({
    ...acc,
    shareMode: normalizeShareMode(acc.shareMode),
  }));
  const removed = Array.isArray(parsed.removed) ? parsed.removed.filter((id): id is string => typeof id === "string") : [];
  return { version: 1, accounts, ...(removed.length ? { removed } : {}) };
}

export function writeAgyAccountStore(store: AgyAccountStore): AgyAccountStore {
  writeJson(storeFile(), store);
  return store;
}

export function visibleAgyAccounts(store: AgyAccountStore = readAgyAccountStore()): StoredAgyAccount[] {
  return store.accounts.filter((item) => !item.hidden);
}

/**
 * 给账号列表与卡片生成简短显示名（对齐 report.ts 的 displayNames）：
 * - 用户起了别名优先用别名；
 * - 只有一个账号且没起别名时返回空串（卡片/标签沿用套餐名，不在单账号界面暴露裸邮箱）；
 * - 多个账号时取邮箱 @ 前缀，前缀重名时才退回完整邮箱。
 */
export function agyDisplayNames(accounts: { alias?: string; email?: string; label?: string }[]): string[] {
  const multi = accounts.length > 1;
  const raw = accounts.map((row) => {
    if (row.alias) return row.alias;
    if (!multi) return "";
    const source = row.email || row.label || "";
    return source.replace(/@.*$/, "").trim() || "账号";
  });
  const counts = new Map<string, number>();
  for (const name of raw) if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  return raw.map((name, idx) => {
    if (!name || (counts.get(name) ?? 0) < 2) return name;
    const full = accounts[idx].email || accounts[idx].label || "";
    return full && full !== name ? full : name;
  });
}

export function rememberAgyAccount(
  input: { ref?: string; email?: string; label?: string; credential?: AgyCredential },
  keepCredential: boolean,
  now = Date.now(),
): string {
  const store = readAgyAccountStore();
  const normEmail = normalizeAgyEmail(input.email || "");
  const ref = input.ref || agyRefFromIdentity(normEmail, undefined, input.credential?.refreshToken || input.credential?.token);
  const id = agyAccountIdOf(ref);
  const found =
    store.accounts.find((item) => item.id === id) ||
    (normEmail ? store.accounts.find((item) => normalizeAgyEmail(item.email) === normEmail) : undefined);
  const targetId = found?.id || id;

  if (!keepCredential && !found && store.removed?.includes(targetId)) return targetId;

  const email = str(input.email) || found?.email || "";
  const label = str(input.label) || email || found?.label || "Antigravity 账号";
  if (found) {
    if (!keepCredential && found.email === email && found.label === label) return found.id;
    found.email = email;
    found.label = label;
    found.lastSeenAt = now;
    if (keepCredential && input.credential) {
      found.credential = {
        ...input.credential,
        ...(input.credential.projectId || found.credential?.projectId
          ? { projectId: input.credential.projectId || found.credential?.projectId }
          : {}),
      };
      delete found.renewFailed;
      delete found.renewTrouble;
      delete found.hidden;
    }
  } else {
    store.accounts.push({
      id: targetId,
      ref: targetId.replace(/^antigravity:/, ""),
      email,
      label,
      shareMode: "auto",
      ...(keepCredential && input.credential ? { credential: input.credential } : {}),
      createdAt: now,
      lastSeenAt: now,
    });
  }
  if (keepCredential && store.removed?.includes(targetId)) {
    store.removed = store.removed.filter((item) => item !== targetId);
  }
  writeAgyAccountStore(store);
  return targetId;
}

export function adoptLocalAgyIdentity(identity: { email: string; name?: string }, now = Date.now()): { id: string; added: boolean } {
  const store = readAgyAccountStore();
  const normEmail = normalizeAgyEmail(identity.email);
  const ref = agyRefFromIdentity(normEmail || undefined, identity.name || "local");
  const id = agyAccountIdOf(ref);
  const found =
    store.accounts.find((item) => item.id === id) ||
    (normEmail ? store.accounts.find((item) => normalizeAgyEmail(item.email) === normEmail) : undefined);
  const added = !found || Boolean(found.hidden);
  const email = str(identity.email) || found?.email || "";
  const label = email || str(identity.name) || found?.label || "本机 Antigravity 账号";
  if (found) {
    found.email = email;
    found.label = label;
    found.lastSeenAt = now;
    delete found.hidden;
  } else {
    store.accounts.push({
      id,
      ref,
      email,
      label,
      shareMode: "auto",
      createdAt: now,
      lastSeenAt: now,
    });
  }
  const finalId = found?.id || id;
  if (store.removed?.includes(finalId)) store.removed = store.removed.filter((item) => item !== finalId);
  writeAgyAccountStore(store);
  return { id: finalId, added };
}

export function reorderAgyAccounts(ids: string[]): AgyAccountStore {
  const store = readAgyAccountStore();
  const current = store.accounts;
  if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every((id) => current.some((item) => item.id === id))) {
    throw new Error("账号列表已经变了，请重新打开设置再排");
  }
  store.accounts = ids.map((id) => current.find((item) => item.id === id)!);
  return writeAgyAccountStore(store);
}

export function renameAgyAccount(id: string, alias: string): AgyAccountStore {
  const store = readAgyAccountStore();
  const target = store.accounts.find((item) => item.id === id);
  if (!target) throw new Error("找不到这个 Antigravity 账号");
  const clean = alias.replace(/\s+/g, " ").trim().slice(0, MAX_ALIAS);
  if (clean && clean !== target.email) target.alias = clean;
  else delete target.alias;
  return writeAgyAccountStore(store);
}

export function setAgyShareMode(id: string, mode: AgyShareMode): AgyAccountStore {
  const store = readAgyAccountStore();
  const target = store.accounts.find((item) => item.id === id);
  if (!target) throw new Error("找不到这个 Antigravity 账号");
  target.shareMode = normalizeShareMode(mode);
  return writeAgyAccountStore(store);
}

export function removeAgyAccount(id: string, inLocal: boolean): AgyAccountStore {
  const store = readAgyAccountStore();
  const target = store.accounts.find((item) => item.id === id);
  if (!target) throw new Error("找不到这个 Antigravity 账号");
  if (inLocal) {
    target.hidden = true;
    delete target.credential;
    delete target.renewFailed;
    delete target.renewTrouble;
  } else {
    store.accounts = store.accounts.filter((item) => item.id !== id);
    store.removed = [...new Set([...(store.removed ?? []), id])];
  }
  return writeAgyAccountStore(store);
}

export function purgeAgyAccount(id: string): AgyAccountStore {
  const store = readAgyAccountStore();
  const target = store.accounts.find((item) => item.id === id);
  if (!target) throw new Error("找不到这个 Antigravity 账号");
  store.accounts = store.accounts.filter((item) => item.id !== id);
  store.removed = [...new Set([...(store.removed ?? []), id])];
  return writeAgyAccountStore(store);
}

export function restoreAgyAccount(id: string): AgyAccountStore {
  const store = readAgyAccountStore();
  const target = store.accounts.find((item) => item.id === id);
  if (!target) throw new Error("找不到这个 Antigravity 账号");
  delete target.hidden;
  return writeAgyAccountStore(store);
}

export function updateAgyProjectId(id: string, projectId: string) {
  if (!projectId) return;
  const store = readAgyAccountStore();
  const target = store.accounts.find((item) => item.id === id);
  if (!target?.credential || target.credential.projectId === projectId) return;
  target.credential.projectId = projectId;
  writeAgyAccountStore(store);
}

/* ---------------- 本机 Antigravity 登录时间线（按时间把本地对话归到当时登录的账号） ---------------- */

export type AgyLoginSpan = { from: number; id: string };
type AgyLoginTimeline = { version: 1; spans: AgyLoginSpan[] };

export function readAgyLoginTimeline(): AgyLoginSpan[] {
  const raw = readJson<AgyLoginTimeline | null>(loginTimelineFile(), null);
  return raw?.version === 1 && Array.isArray(raw.spans)
    ? raw.spans
        .filter((s) => s && typeof s.from === "number" && typeof s.id === "string")
        .sort((a, b) => a.from - b.from)
    : [];
}

export function recordAgyLocalLogin(email: string, now = Date.now()): string {
  const norm = normalizeAgyEmail(email);
  if (!norm) return "";
  const store = readAgyAccountStore();
  const matched = store.accounts.find((a) => normalizeAgyEmail(a.email) === norm);
  const id = matched?.id || agyAccountIdOf(agyRefFromIdentity(norm));
  const raw = [...readAgyLoginTimeline(), { from: now, id }].sort((a, b) => a.from - b.from);
  const spans: AgyLoginSpan[] = [];
  for (const s of raw) {
    const prev = spans.at(-1);
    if (prev && prev.id === s.id) continue;
    spans.push(s);
  }
  if (spans.length !== readAgyLoginTimeline().length || JSON.stringify(spans) !== JSON.stringify(readAgyLoginTimeline())) {
    try {
      writeJson(loginTimelineFile(), { version: 1, spans: spans.slice(-500) });
    } catch { /* 只读时跳过 */ }
  }
  return id;
}

/** 判断一条本机 Antigravity 请求（时间戳 at）属于哪个账号 ID。若没有多账号时间线则返回空串（由调用方按单账号兼容处理）。 */
export function resolveAgyLocalOwner(at: number, spans: AgyLoginSpan[] = readAgyLoginTimeline()): string {
  if (!spans.length) return "";
  let hit: AgyLoginSpan | undefined;
  for (const s of spans) {
    if (s.from <= at) hit = s;
    else break;
  }
  return (hit ?? spans[0])?.id || "";
}

/* ---------------- OAuth 续期 ---------------- */

export type AgyRefreshResult =
  | { ok: true; credential: AgyCredential }
  | { ok: false; permanent: boolean; error: string; status?: number; code?: string };

export type AgyNetDeps = {
  oauthClient?: AgyOAuthClient;
  postForm?: (url: string, body: string, headers: string[]) => Promise<{ status: number; json: any }>;
  postJson?: (url: string, body: string, headers: string[]) => Promise<{ status: number; json: any }>;
  getJson?: (url: string, headers: string[]) => Promise<Record<string, unknown>>;
  openExternal?: (url: string) => Promise<void> | void;
};

function secretListOf(oauthClient: AgyOAuthClient): string[] {
  const list = [oauthClient.clientSecret, ...(oauthClient.candidateSecrets ?? [])].filter(Boolean);
  return [...new Set(list)];
}

async function postTokenFormWithClient(
  oauthClient: AgyOAuthClient,
  params: Record<string, string>,
  post: (url: string, body: string, headers: string[]) => Promise<{ status: number; json: any }>,
): Promise<{ status: number; json: any }> {
  const secrets = secretListOf(oauthClient);
  let last: { status: number; json: any } = { status: 0, json: null };
  for (const secret of secrets) {
    const form = new URLSearchParams({
      ...params,
      client_id: oauthClient.clientId,
      client_secret: secret,
    }).toString();
    last = await post(AGY_OAUTH_TOKEN_URL, form, [
      "Content-Type: application/x-www-form-urlencoded",
      "Accept: application/json",
    ]);
    const code = errorCodeOf(last.json);
    const invalidClient = last.status === 401 || code === "invalid_client" || code === "unauthorized_client";
    if (!invalidClient) {
      if (secret !== oauthClient.clientSecret) {
        oauthClient.clientSecret = secret;
        if (cachedOAuthClient && cachedOAuthClient.clientId === oauthClient.clientId) {
          cachedOAuthClient = { clientId: oauthClient.clientId, clientSecret: secret };
        }
      }
      return last;
    }
  }
  return last;
}

export async function refreshAgyCredential(
  credential: AgyCredential,
  now = Date.now(),
  deps: AgyNetDeps = {},
): Promise<AgyRefreshResult> {
  if (!credential.refreshToken) return { ok: false, permanent: true, error: "没有 refresh token" };
  const oauthClient = resolveAntigravityOAuthClient(deps);
  if (!oauthClient) return { ok: false, permanent: false, error: "未找到本机 Antigravity 客户端配置" };
  const post = deps.postForm ?? ((url, body, headers) => curlPost(url, body, headers));
  try {
    const { status, json } = await postTokenFormWithClient(
      oauthClient,
      {
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
      },
      post,
    );
    if (status >= 200 && status < 300) {
      const token = str(json?.access_token);
      if (!token) return { ok: false, permanent: false, error: "续期响应里没有 access_token" };
      const expiresIn = Number(json?.expires_in);
      const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : now + 3600_000;
      const nextRefresh = str(json?.refresh_token) || credential.refreshToken;
      return {
        ok: true,
        credential: {
          ...credential,
          token,
          refreshToken: nextRefresh,
          expiresAt,
        },
      };
    }
    const code = errorCodeOf(json);
    return {
      ok: false,
      permanent: isPermanentFailure(status, json),
      error: `HTTP ${status}${code ? ` ${code}` : ""}`,
      status,
      ...(code ? { code } : {}),
    };
  } catch (error) {
    return { ok: false, permanent: false, error: error instanceof Error ? error.message : String(error) };
  }
}

let renewingAgy: Promise<number> | null = null;

export function renewAgyCredentials(
  now = Date.now(),
  refresh: typeof refreshAgyCredential = refreshAgyCredential,
): Promise<number> {
  if (!renewingAgy) {
    renewingAgy = (async () => {
      let renewed = 0;
      const due = readAgyAccountStore().accounts.filter(
        (item) =>
          !item.hidden &&
          item.credential?.refreshToken &&
          !item.renewFailed &&
          (item.credential.expiresAt == null || item.credential.expiresAt - now < RENEW_BEFORE_MS),
      );
      for (const account of due) {
        const result = await refresh(account.credential!, now);
        const rejected =
          !result.ok &&
          !result.permanent &&
          result.status != null &&
          result.status >= 400 &&
          result.status < 500 &&
          result.status !== 429;
        if (!result.ok && !result.permanent && !rejected) {
          logRenew({
            at: now,
            kind: "antigravity",
            accountId: account.id,
            source: "stored",
            ok: false,
            status: result.status,
            code: result.code,
            error: result.error,
          });
          continue;
        }
        const store = readAgyAccountStore();
        const target = store.accounts.find((item) => item.id === account.id);
        if (!target || target.credential?.refreshToken !== account.credential!.refreshToken) {
          logRenew({
            at: now,
            kind: "antigravity",
            accountId: account.id,
            source: "stored",
            ok: result.ok,
            note: "续期期间重新登录过，结果丢弃",
          });
          continue;
        }
        let note: string | undefined;
        if (result.ok) {
          target.credential = result.credential;
          delete target.renewFailed;
          delete target.renewTrouble;
          renewed += 1;
        } else if (result.permanent) {
          target.renewFailed = result.error;
          delete target.renewTrouble;
        } else {
          const trouble = target.renewTrouble ?? { since: now, count: 0, error: result.error };
          target.renewTrouble = { since: trouble.since, count: trouble.count + 1, error: result.error };
          if (target.renewTrouble.count >= RENEW_GIVE_UP && now - target.renewTrouble.since >= RENEW_GIVE_UP_MS) {
            target.renewFailed = `${result.error}（连续 ${target.renewTrouble.count} 次被拒）`;
            note = "连续被拒，判为需要重新登录";
            delete target.renewTrouble;
          }
        }
        logRenew({
          at: now,
          kind: "antigravity",
          accountId: account.id,
          source: "stored",
          ok: result.ok,
          ...(result.ok
            ? {}
            : { status: result.status, code: result.code, error: result.error, permanent: Boolean(target.renewFailed), note }),
        });
        writeAgyAccountStore(store);
      }
      return renewed;
    })().finally(() => {
      renewingAgy = null;
    });
  }
  return renewingAgy;
}

/* ---------------- Google OAuth 2.0 PKCE 浏览器登录 ---------------- */

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function callbackHtml(ok: boolean, title: string, detail: string): string {
  const accent = ok ? "#10a37f" : "#dc2626";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} - TokenPulse</title><style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f8fa;color:#181b20}@media(prefers-color-scheme:dark){body{background:#15181c;color:#eef1f5}.card{background:#1e2228;border-color:#2e343d}}.card{max-width:420px;padding:28px 32px;border-radius:16px;background:#fff;border:1px solid #e4e7ec;box-shadow:0 10px 30px rgba(0,0,0,.06);text-align:center}h1{font-size:18px;margin:12px 0 8px}p{font-size:14px;opacity:.78;line-height:1.6;margin:0}.dot{display:inline-grid;place-items:center;width:40px;height:40px;border-radius:50%;background:${accent}1a;color:${accent};font-size:20px;font-weight:700}</style></head><body><div class="card"><div class="dot">${ok ? "✓" : "!"}</div><h1>${title}</h1><p>${detail}</p></div></body></html>`;
}

async function startOAuthLoopback(expectedState: string, timeoutMs = LOGIN_TIMEOUT_MS): Promise<{
  port: number;
  waitForCode: () => Promise<{ ok: true; code: string } | { ok: false; error: string }>;
  close: () => Promise<void>;
}> {
  const servers: http.Server[] = [];
  let settled = false;
  let resolveWait!: (res: { ok: true; code: string } | { ok: false; error: string }) => void;
  const waitPromise = new Promise<{ ok: true; code: string } | { ok: false; error: string }>((r) => {
    resolveWait = r;
  });

  const close = async () => {
    await Promise.all(
      servers.map(
        (srv) =>
          new Promise<void>((r) => {
            try {
              srv.close(() => r());
            } catch {
              r();
            }
          }),
      ),
    );
  };

  const handler: http.RequestListener = (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method !== "GET" || url.pathname !== "/auth/callback") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
        res.end("Not Found");
        return;
      }
      const errParam = url.searchParams.get("error");
      const stateParam = url.searchParams.get("state");
      const codeParam = url.searchParams.get("code");
      if (errParam) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
        res.end(callbackHtml(false, "Google 授权未完成", "你在浏览器里取消或拒绝了授权，请回到 TokenPulse 重试。"));
        if (!settled) {
          settled = true;
          resolveWait({ ok: false, error: `浏览器授权未通过（${errParam}）` });
        }
        return;
      }
      if (!stateParam || stateParam !== expectedState || !codeParam) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
        res.end(callbackHtml(false, "授权回调校验失败", "状态参数不匹配或缺少授权码，请回到 TokenPulse 重新发起登录。"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(callbackHtml(true, "Antigravity 账号授权成功", "可以关掉这个浏览器标签页，回到 TokenPulse 查看额度。"));
      if (!settled) {
        settled = true;
        resolveWait({ ok: true, code: codeParam });
      }
    } catch {
      res.writeHead(500, { Connection: "close" });
      res.end();
    }
  };

  const v4 = http.createServer(handler);
  const port = await new Promise<number>((resolve, reject) => {
    v4.once("error", reject);
    v4.listen(0, "127.0.0.1", () => {
      const addr = v4.address();
      if (!addr || typeof addr === "string") reject(new Error("无法分配本机回调端口"));
      else resolve(addr.port);
    });
  });
  servers.push(v4);

  // Windows 下 localhost 可能优先解析到 ::1，同时监听 ::1 同端口以保证回调直达
  const v6 = http.createServer(handler);
  await new Promise<void>((resolve) => {
    v6.once("error", () => resolve());
    v6.listen(port, "::1", () => {
      servers.push(v6);
      resolve();
    });
  });

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      resolveWait({ ok: false, error: "OAuth 登录等待超时，请回到浏览器完成授权后再试一次。" });
    }
  }, timeoutMs);
  timer.unref?.();

  return {
    port,
    waitForCode: async () => {
      try {
        return await waitPromise;
      } finally {
        clearTimeout(timer);
        await close();
      }
    },
    close: async () => {
      clearTimeout(timer);
      await close();
    },
  };
}

let inflightAgyLogin: Promise<{ ok: true; status: AgyOAuthStatus } | { ok: false; error: string }> | null = null;

export async function loginAntigravityOAuth(
  replaceId?: string,
  deps: AgyNetDeps = {},
): Promise<{ ok: true; status: AgyOAuthStatus } | { ok: false; error: string }> {
  if (inflightAgyLogin) return inflightAgyLogin;
  inflightAgyLogin = runAntigravityLogin(replaceId, deps).finally(() => {
    inflightAgyLogin = null;
  });
  return inflightAgyLogin;
}

async function runAntigravityLogin(
  replaceId?: string,
  deps: AgyNetDeps = {},
): Promise<{ ok: true; status: AgyOAuthStatus } | { ok: false; error: string }> {
  const loginLog = startLoginLog("antigravity");
  const started = Date.now();
  loginLog.write(`开始登录 Google Antigravity${replaceId ? "（重新授权已有账号）" : ""}；${process.platform} ${os.release()} ${process.arch}`);
  const oauthClient = resolveAntigravityOAuthClient(deps);
  if (!oauthClient) {
    const msg = "未在本机找到 Antigravity 客户端（IDE 或 agy CLI），请先安装 Antigravity 后再登录账号。";
    loginLog.write(`失败：${msg}`);
    return { ok: false, error: msg };
  }
  const state = randomBytes(24).toString("base64url");
  const { verifier, challenge } = pkcePair();
  const loopback = await startOAuthLoopback(state);
  const redirectUri = `http://localhost:${loopback.port}/auth/callback`;
  const authUrl = `${AGY_OAUTH_AUTH_URL}?${new URLSearchParams({
    access_type: "offline",
    client_id: oauthClient.clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "consent",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: AGY_OAUTH_SCOPES.join(" "),
    state,
  }).toString()}`;

  try {
    if (deps.openExternal) {
      await deps.openExternal(authUrl);
    } else {
      const { shell } = require("electron") as typeof import("electron");
      await shell.openExternal(authUrl);
    }
    loginLog.write(`已在系统浏览器打开授权页（回调端口 ${loopback.port}）`);

    const callback = await loopback.waitForCode();
    if (!callback.ok) {
      loginLog.write(`失败（${Math.round((Date.now() - started) / 1000)} 秒）：${callback.error}`);
      return { ok: false, error: callback.error };
    }

    const post = deps.postForm ?? ((url, body, headers) => curlPost(url, body, headers));
    const { status: tokenHttp, json: tokenJson } = await postTokenFormWithClient(
      oauthClient,
      {
        code: callback.code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      },
      post,
    );
    if (tokenHttp < 200 || tokenHttp >= 300 || !str(tokenJson?.access_token)) {
      const code = errorCodeOf(tokenJson);
      const why = `换取 OAuth 令牌失败（HTTP ${tokenHttp}${code ? ` ${code}` : ""}）`;
      loginLog.write(`失败：${why}`);
      return { ok: false, error: `${why}。请检查系统代理或网络后重试。` };
    }

    const accessToken = str(tokenJson.access_token);
    const refreshToken = str(tokenJson.refresh_token) || undefined;
    const expiresIn = Number(tokenJson.expires_in);
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : Date.now() + 3600_000;

    const claims = jwtClaims(str(tokenJson.id_token));
    let email = str(claims.email);
    let sub = str(claims.sub);
    let name = str(claims.name);
    if (!email) {
      const get = deps.getJson ?? ((url, headers) => curlJson(url, headers));
      const info = await get(AGY_USERINFO_URL, [`Authorization: Bearer ${accessToken}`, "Accept: application/json"]).catch(() => null);
      if (info) {
        email = str(info.email) || email;
        sub = str(info.id) || sub;
        name = str(info.name) || name;
      }
    }

    const ref = agyRefFromIdentity(email, sub, refreshToken || accessToken);
    const candidateId = agyAccountIdOf(ref);
    if (replaceId) {
      const existing = readAgyAccountStore().accounts.find((a) => a.id === replaceId);
      const sameEmail = Boolean(existing?.email && email && normalizeAgyEmail(existing.email) === normalizeAgyEmail(email));
      if (candidateId !== replaceId && !sameEmail) {
        loginLog.write("失败：重新授权登录的 Google 账号与目标账号不一致");
        return { ok: false, error: "重新授权登录的 Google 账号与目标账号不一致，原账号没有改变。" };
      }
    }

    if (!replaceId && !deps.openExternal && antigravityHub()) {
      // 若本机 Antigravity 正登录着另一个账号且尚未进入账号列表，先记下它的只读身份再加入新号，避免历史统计与顺位被新号顶替
      const local = await fetchAntigravityLocalSession().catch(() => null);
      if (local?.email && normalizeAgyEmail(local.email) !== normalizeAgyEmail(email)) {
        try {
          recordAgyLocalLogin(local.email);
          rememberAgyAccount({ email: local.email, label: local.email || local.name }, false);
        } catch { /* ignore */ }
      }
    }

    const savedId = rememberAgyAccount(
      {
        ref: replaceId ? replaceId.replace(/^antigravity:/, "") : ref,
        email,
        label: email || name || "Antigravity 账号",
        credential: { token: accessToken, ...(refreshToken ? { refreshToken } : {}), expiresAt },
      },
      true,
    );
    loginLog.write(`成功（${Math.round((Date.now() - started) / 1000)} 秒）：账号 ${savedId}（${email ? "有邮箱" : "无邮箱"}，${refreshToken ? "含续期令牌" : "无续期令牌"}）`);
    return { ok: true, status: await listAgyAccountStatus() };
  } catch (error) {
    await loopback.close();
    const msg = error instanceof Error ? error.message : String(error);
    loginLog.write(`出错：${msg}`);
    return { ok: false, error: `Antigravity OAuth 登录失败：${msg}` };
  }
}

/* ---------------- Google Cloud Code 直连配额查询（无需打开 Antigravity 客户端） ---------------- */

function cloudPlatformName(): string {
  if (process.platform === "win32") return "WINDOWS_AMD64";
  if (process.platform === "darwin") return process.arch === "arm64" ? "DARWIN_ARM64" : "DARWIN_AMD64";
  if (process.platform === "linux") return process.arch === "arm64" ? "LINUX_ARM64" : "LINUX_AMD64";
  return "PLATFORM_UNSPECIFIED";
}

function extractProjectId(loadJson: Record<string, unknown> | null | undefined): string {
  if (!loadJson || typeof loadJson !== "object") return "";
  const raw = loadJson.cloudaicompanionProject ?? loadJson.cloudaicompanion_project;
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object") return str((raw as Record<string, unknown>).id);
  return "";
}

function extractCreditsFromLoad(loadJson: Record<string, unknown> | null | undefined): AgyCredits | undefined {
  if (!loadJson || typeof loadJson !== "object") return undefined;
  const paid = loadJson.paidTier as Record<string, unknown> | undefined;
  const current = loadJson.currentTier as Record<string, unknown> | undefined;
  const list = [
    ...(Array.isArray(paid?.availableCredits) ? paid.availableCredits : []),
    ...(Array.isArray(current?.availableCredits) ? current.availableCredits : []),
  ] as Record<string, unknown>[];
  for (const item of list) {
    const amount = Number(item?.creditAmount ?? item?.credit_amount ?? 0);
    if (Number.isFinite(amount) && amount > 0) {
      return { availablePromptCredits: amount, monthlyPromptCredits: amount };
    }
  }
  return undefined;
}

function formatAgyCloudPlan(rawPlan: string, tier?: string): string {
  const cleaned = rawPlan.replace(/^g1-|-tier$/gi, "").replace(/[-_]+/g, " ").trim();
  if (!cleaned) return tier ? "Pro" : "";
  return cleaned
    .split(/\s+/)
    .map((word) => (word.length ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(" ");
}

function isCloudResponseDegraded(modelsJson: unknown, summaryJson: unknown): boolean {
  const mRoot = (modelsJson && typeof modelsJson === "object" ? modelsJson : null) as Record<string, unknown> | null;
  const modelsMap = (mRoot?.models && typeof mRoot.models === "object" && !Array.isArray(mRoot.models)
    ? mRoot.models
    : null) as Record<string, Record<string, unknown>> | null;
  if (!modelsMap) return false;
  let hasGeminiModel = false;
  let has3pModel = false;
  for (const [k, detail] of Object.entries(modelsMap)) {
    if (!detail || typeof detail !== "object" || detail.disabled === true) continue;
    const label = str(detail.displayName ?? detail.display_name ?? detail.label);
    if (!label) continue;
    const cat = poolCategory(`${k} ${label}`);
    if (cat === "gemini") hasGeminiModel = true;
    else if (cat === "3p") has3pModel = true;
  }
  const sgs = parseSummaryGroups(summaryJson);
  if (!sgs.length) return false;
  const hasGeminiSg = sgs.some((sg) => summaryPoolCategory(sg) === "gemini");
  const has3pSg = sgs.some((sg) => summaryPoolCategory(sg) === "3p");
  return (hasGeminiModel && !hasGeminiSg) || (has3pModel && !has3pSg);
}

export function parseAntigravityCloudQuota(
  loadJson: unknown,
  modelsJson: unknown,
  summaryJson?: unknown,
): { status: AgyStatus; projectId: string } | null {
  const load = (loadJson && typeof loadJson === "object" ? loadJson : {}) as Record<string, unknown>;
  const paidTier = load.paidTier as Record<string, unknown> | undefined;
  const currentTier = load.currentTier as Record<string, unknown> | undefined;
  const tier = str(paidTier?.name) || str(currentTier?.name) || undefined;
  const g1Tier = str(load.g1Tier ?? load.g1_tier);
  const rawPlan = g1Tier || str(paidTier?.id) || str(currentTier?.id) || "";
  const plan = formatAgyCloudPlan(rawPlan, tier);
  const projectId = extractProjectId(load);
  const credits = extractCreditsFromLoad(load);

  const summaryGroups = parseSummaryGroups(summaryJson);
  const mRoot = (modelsJson && typeof modelsJson === "object" ? modelsJson : null) as Record<string, unknown> | null;
  const modelsMap = (mRoot?.models && typeof mRoot.models === "object" && !Array.isArray(mRoot.models)
    ? mRoot.models
    : null) as Record<string, Record<string, unknown>> | null;

  const labels: Record<string, string> = {};
  const groups = new Map<string, AgyQuotaGroup>();
  const matchedSummaryIdx = new Set<number>();
  const modelBySignature = new Map<string, { item: AgyModelQuotaItem; exactKeyMatch: boolean }>();

  if (modelsMap) {
    const knownLabels = readModelLabels();
    const sortedKeys: string[] = [];
    const seen = new Set<string>();
    const sorts = Array.isArray(mRoot?.agentModelSorts) ? (mRoot!.agentModelSorts as Record<string, unknown>[]) : [];
    for (const sort of sorts) {
      const sGroups = Array.isArray(sort?.groups) ? (sort.groups as Record<string, unknown>[]) : [];
      for (const g of sGroups) {
        const ids = Array.isArray(g?.modelIds) ? g.modelIds : Array.isArray(g?.model_ids) ? g.model_ids : [];
        for (const rawId of ids) {
          const k = str(rawId);
          if (k && modelsMap[k] && !seen.has(k)) {
            seen.add(k);
            sortedKeys.push(k);
          }
        }
      }
    }

    // 先收集全量标签（含旧型号 / 内部型号），保证历史对话扫描依旧能识别旧 model_enum
    for (const mapKey of Object.keys(modelsMap)) {
      const detail = modelsMap[mapKey];
      if (!detail || typeof detail !== "object") continue;
      const rawLabel = str(detail.displayName ?? detail.display_name ?? detail.label);
      const modelEnum = str(detail.model) || mapKey;
      if (rawLabel && modelEnum) labels[modelEnum] = rawLabel;
    }

    // 服务端返回了 agentModelSorts 时，只按活跃选择器列表展示，避免把未列出的旧版/内部模型（Gemini 2.5 Pro / 3 Flash / Image 等）塞进组内档位
    const displayKeys = sortedKeys.length > 0 ? sortedKeys : Object.keys(modelsMap);

    for (const mapKey of displayKeys) {
      const detail = modelsMap[mapKey];
      if (!detail || typeof detail !== "object") continue;
      if (detail.disabled === true || detail.isInternal === true || detail.deprecated === true) continue;
      const modelEnum = str(detail.model) || mapKey;
      const rawLabel = str(detail.displayName ?? detail.display_name ?? detail.label);
      const label = rawLabel || (sortedKeys.length > 0 ? knownLabels[modelEnum] || knownLabels[mapKey] || "" : "");
      if (label && modelEnum) labels[modelEnum] = label;
      const quota = (detail.quotaInfo ?? detail.quota_info) as Record<string, unknown> | undefined;
      if (!label || !quota || typeof quota !== "object") continue;

      const rawRem = quota.remainingFraction ?? quota.remaining_fraction;
      const remaining = Math.min(1, Math.max(0, Number(rawRem ?? 0) || 0));
      const used = Math.round((1 - remaining) * 1000) / 10;
      const resetAt = str(quota.resetTime ?? quota.reset_time) || undefined;
      const { model, family, effort } = splitModelLabel(label);
      const groupFamily = modelFamily(label);
      const matched = matchSummaryGroup(groupFamily, used, resetAt, summaryGroups);
      if (matched) matchedSummaryIdx.add(matched.idx);
      const key = matched ? `sg:${matched.idx}` : `${poolCategory(groupFamily)}|${remaining}|${resetAt ?? ""}`;
      const groupUsed = matched?.five ? matched.five.used : used;
      const groupResetAt = matched?.five?.resetAt ?? resetAt;
      const group = groups.get(key) ?? {
        ...(matched?.title ? { title: matched.title } : {}),
        models: [],
        used: groupUsed,
        ...(groupResetAt ? { resetAt: groupResetAt } : {}),
        ...(matched?.week ? { week: matched.week } : {}),
      };
      if (!group.models.includes(groupFamily)) group.models.push(groupFamily);
      groups.set(key, group);

      const sig = `${model}|${effort ?? ""}|${family}`;
      const exactKeyMatch = mapKey === (effort ? `${model}-${effort}` : model);
      const prev = modelBySignature.get(sig);
      const item: AgyModelQuotaItem = {
        label,
        family,
        model,
        ...(effort ? { effort } : {}),
        ...(modelEnum ? { modelEnum } : {}),
        used: groupUsed,
        ...(groupResetAt ? { resetAt: groupResetAt } : {}),
        ...(matched?.week ? { weekUsed: matched.week.used, ...(matched.week.resetAt ? { weekResetAt: matched.week.resetAt } : {}) } : {}),
      };
      if (!prev || (!prev.exactKeyMatch && exactKeyMatch)) {
        modelBySignature.set(sig, { item, exactKeyMatch });
      }
    }
  }

  // 补齐 RetrieveUserQuotaSummary 有但 fetchAvailableModels 未列出任何属于它的型号的分组（例如仅返回摘要桶的场景）
  for (const sg of summaryGroups) {
    if (matchedSummaryIdx.has(sg.idx) || groups.has(`sg:${sg.idx}`)) continue;
    const cat = summaryPoolCategory(sg);
    const fallbackModels =
      cat === "gemini"
        ? ["Gemini Models"]
        : cat === "3p"
          ? ["Claude and GPT models"]
          : [sg.title || `Group ${sg.idx + 1}`];
    groups.set(`sg:${sg.idx}`, {
      ...(sg.title ? { title: sg.title } : {}),
      models: fallbackModels,
      used: sg.five?.used ?? sg.week?.used ?? 0,
      ...(sg.five?.resetAt ? { resetAt: sg.five.resetAt } : {}),
      ...(sg.week ? { week: sg.week } : {}),
    });
  }

  const orderedGroups = [...groups.entries()]
    .sort(([ka, ga], [kb, gb]) => {
      const rank = (k: string, g: AgyQuotaGroup) => {
        const hay = `${g.title || ""} ${g.models.join(" ")}`;
        if (/gemini|orchestrator/i.test(hay)) return 0;
        if (/claude|gpt|3p/i.test(hay)) return 1;
        return k.startsWith("sg:") ? 2 : 3;
      };
      return rank(ka, ga) - rank(kb, gb);
    })
    .map(([, g]) => g);

  const models = [...modelBySignature.values()].map((entry) => entry.item);
  if (!orderedGroups.length && !tier && !plan) return null;
  return {
    projectId,
    status: {
      plan,
      ...(tier ? { tier } : {}),
      groups: orderedGroups,
      labels,
      ...(models.length ? { models } : {}),
      ...(credits ? { credits } : {}),
    },
  };
}

const DEFAULT_AGY_IDE_VERSION = "2.35.0";

function detectAntigravityIdeVersion(): string {
  let best = DEFAULT_AGY_IDE_VERSION;
  const cmp = (a: string, b: string) => {
    const pa = a.split(".").map((n) => Number(n) || 0);
    const pb = b.split(".").map((n) => Number(n) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  };
  for (const root of antigravityDirs()) {
    const dir = path.join(root, "daemon");
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => /^hub_\d+\.json$/.test(n));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Record<string, unknown>;
        const ver = str(raw.lsVersion);
        if (/^\d+\.\d+\.\d+/.test(ver) && cmp(ver, best) > 0) best = ver;
      } catch { /* ignore */ }
    }
  }
  return best;
}

function cloudUserAgent(ideVersion: string): string {
  const plat = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return `antigravity/${ideVersion} ${plat}/${arch}`;
}

export async function fetchAntigravityCloudStatus(
  credential: AgyCredential,
  deps: AgyNetDeps = {},
): Promise<{ status: AgyStatus; projectId?: string }> {
  const post = deps.postJson ?? ((url, body, headers) => curlPost(url, body, headers));
  const ideVersion = detectAntigravityIdeVersion();
  const headers = [
    `Authorization: Bearer ${credential.token}`,
    "Content-Type: application/json",
    "Accept: application/json",
    `User-Agent: ${cloudUserAgent(ideVersion)}`,
  ];
  const loadPayload = JSON.stringify({
    ...(credential.projectId ? { cloudaicompanionProject: credential.projectId } : {}),
    metadata: {
      ideType: "ANTIGRAVITY",
      ideVersion,
      platform: cloudPlatformName(),
      pluginType: "GEMINI",
    },
  });

  let lastErr: Error | undefined;
  let fallbackCandidate: { status: AgyStatus; projectId?: string } | null = null;
  for (const base of AGY_CLOUDCODE_ENDPOINTS) {
    try {
      const loadRes = await post(`${base}/v1internal:loadCodeAssist`, loadPayload, headers);
      if (loadRes.status === 401 || loadRes.status === 403) {
        throw new Error(`登录凭据已失效或无权访问（HTTP ${loadRes.status}）`);
      }
      if (loadRes.status === 429) {
        throw new Error("请求过于频繁（HTTP 429），稍后自动重试");
      }
      if (loadRes.status >= 500) {
        lastErr = new Error(`Cloud Code 服务暂时不可用（HTTP ${loadRes.status}）`);
        continue;
      }
      const projectId = extractProjectId(loadRes.json) || credential.projectId || "";
      const quotaReqBody = JSON.stringify(projectId ? { project: projectId } : {});
      const [modelsRes, summaryRes] = await Promise.all([
        post(`${base}/v1internal:fetchAvailableModels`, quotaReqBody, headers),
        post(`${base}/v1internal:retrieveUserQuotaSummary`, quotaReqBody, headers).catch(() => ({ status: 0, json: null })),
      ]);
      if (modelsRes.status === 401 || modelsRes.status === 403) {
        throw new Error(`登录凭据已失效（HTTP ${modelsRes.status}）`);
      }
      const okModels = modelsRes.status >= 200 && modelsRes.status < 300 ? modelsRes.json : null;
      const okSummary = summaryRes.status >= 200 && summaryRes.status < 300 ? summaryRes.json : null;
      const parsed = parseAntigravityCloudQuota(loadRes.json, okModels, okSummary);
      if (parsed) {
        const result = { status: parsed.status, ...(parsed.projectId ? { projectId: parsed.projectId } : {}) };
        if (Object.keys(parsed.status.labels).length) rememberModelLabels(parsed.status.labels);
        if (isCloudResponseDegraded(okModels, okSummary)) {
          if (!fallbackCandidate || result.status.groups.length > fallbackCandidate.status.groups.length) {
            fallbackCandidate = result;
          }
          continue;
        }
        return result;
      }
      lastErr = new Error("Cloud Code 返回的数据里没有识别出额度分组");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/401|403|429/.test(msg)) throw error;
      lastErr = error instanceof Error ? error : new Error(msg);
    }
  }
  if (fallbackCandidate) return fallbackCandidate;
  log.warn("antigravity", "Cloud Code 额度直连失败：" + errorText(lastErr));
  throw lastErr ?? new Error("Cloud Code 额度查询失败");
}

/* ---------------- 给设置页展示的脱敏账号状态 ---------------- */

export async function listAgyAccountStatus(now = Date.now(), localEmail?: string): Promise<AgyOAuthStatus> {
  await renewAgyCredentials(now).catch(() => 0);
  const running = Boolean(antigravityHub());
  const installed = running || antigravityDirs().some((dir) => fs.existsSync(dir));
  let activeLocalEmail = localEmail !== undefined ? normalizeAgyEmail(localEmail) : "";
  if (localEmail === undefined && running) {
    const local = await fetchAntigravityLocalSession().catch(() => null);
    if (local?.email) {
      activeLocalEmail = normalizeAgyEmail(local.email);
      recordAgyLocalLogin(local.email, now);
      try {
        rememberAgyAccount({ email: local.email, label: local.email || local.name }, false, now);
      } catch { /* 只读时跳过，遵循 removed/hidden 规则 */ }
    }
  }

  const store = readAgyAccountStore();
  const accounts: AgyAccountView[] = store.accounts.map((item) => {
    const inCli = Boolean(activeLocalEmail && normalizeAgyEmail(item.email) === activeLocalEmail);
    const hasValidStored = Boolean(item.credential && !isExpired(item.credential, now) && !item.renewFailed);
    const usable = hasValidStored || inCli;
    const autoRenew = Boolean(item.credential?.refreshToken) && !item.renewFailed;
    const needsLogin = Boolean(item.renewFailed) && !inCli;
    const waitLocal = !item.credential && !inCli;
    return {
      id: item.id,
      email: item.email,
      label: item.label,
      alias: item.alias ?? "",
      inCli,
      inLocal: inCli,
      cloudAuth: hasValidStored,
      usable,
      autoRenew,
      needsLogin,
      waitLocal,
      ...(item.renewFailed || item.renewTrouble ? { renewError: item.renewFailed || item.renewTrouble!.error } : {}),
      ...(item.credential?.expiresAt != null ? { expiresAt: item.credential.expiresAt } : {}),
      hidden: Boolean(item.hidden),
      shareMode: normalizeShareMode(item.shareMode),
    };
  });

  return {
    kind: "antigravity",
    label: "Antigravity",
    installed: installed || accounts.length > 0,
    running,
    accounts,
  };
}

export async function addLocalAgyAccount(now = Date.now()): Promise<{ ok: true; added: boolean; status: AgyOAuthStatus }> {
  const local = await fetchAntigravityLocalSession();
  if (!local) {
    throw new Error("本机 Antigravity 没有在运行。请先打开 Antigravity 并完成登录，或者直接选「登录一个新账号」在浏览器里授权。");
  }
  if (!local.email && !local.name) {
    throw new Error("没有从本机 Antigravity 读到当前登录账号，请改用「登录一个新账号」在浏览器里授权。");
  }
  if (local.email) recordAgyLocalLogin(local.email, now);
  const { added } = adoptLocalAgyIdentity({ email: local.email, name: local.name }, now);
  return { ok: true, added, status: await listAgyAccountStatus(now, local.email) };
}

export async function manageAgyAccount(
  action: "remove" | "purge" | "restore" | "rename" | "share-mode",
  id: string,
  value = "",
  now = Date.now(),
): Promise<AgyOAuthStatus> {
  const local = antigravityHub() ? await fetchAntigravityLocalSession().catch(() => null) : null;
  const activeEmail = normalizeAgyEmail(local?.email || "");
  const store = readAgyAccountStore();
  const target = store.accounts.find((a) => a.id === id);
  if (!target) throw new Error("找不到这个 Antigravity 账号");
  const inLocal = Boolean(activeEmail && normalizeAgyEmail(target.email) === activeEmail);

  if (action === "rename") renameAgyAccount(id, value);
  else if (action === "share-mode") setAgyShareMode(id, normalizeShareMode(value));
  else if (action === "restore") restoreAgyAccount(id);
  else if (action === "purge") purgeAgyAccount(id);
  else removeAgyAccount(id, inLocal);

  return listAgyAccountStatus(now, local?.email || "");
}
