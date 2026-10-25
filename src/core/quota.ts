import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { accountIdOf, rememberOfficialAccount, renewStoredCredentials, visibleAccounts } from "./accounts";
import { log, errorText, logUrl } from "./app-log";
import { renewCliCredential, type CliRenewResult } from "./cli-renew";
import { curlBin, curlJson, HttpError } from "./curl";
import { curlProxyArgs } from "./upstream-proxy";
import { isExpired, readCliAccounts, type OfficialAccountKind } from "./credentials";
import { recordQuotaSamples } from "./quota-history";

/**
 * 问各家官方接口：这个账号的 5 小时 / 周额度用了多少。
 *
 * 每个账号使用它自己的凭据：
 * - TokenPulse 登录的账号：使用 TokenPulse 账号库里保存、并由本软件续期的凭据；
 * - 只从 CLI 发现的账号：使用对应 CLI 配置文件里的凭据。
 * 额度查询不依赖 CLI 当前 provider，也不写回 CLI 配置。
 *
 * 为什么走 curl 而不是 fetch：这几个接口对 TLS 指纹和 HTTP/2 比较挑，
 * Node 的 fetch 经常被挡；curl 在 Windows 10+ 是系统自带的。
 */

const execFileAsync = promisify(execFile);

export type OfficialQuota = {
  kind?: AccountKind;
  name: string;
  fiveHourPct?: number;
  weekPct?: number;
  weekReset?: string;
  /** 官方发放的手动重置次数。 */
  resetCredits?: number;
  /** 5 小时窗口什么时候重置（ISO）。Claude 这个窗口还没开始用时接口给 null。 */
  fiveHourReset?: string;
  /** 周窗口从什么时候开始（ISO）。只有 Grok 直接给；别家用 weekReset - 7 天推。 */
  weekStart?: string;
  /** 订阅档位（plus / pro …），目前只有 ChatGPT 给。 */
  plan?: string;
  /** 查的是哪个账号（accounts.ts 的 id）。采样历史按它分开，切换账号不会把两个人的百分比连成一条线。 */
  accountId?: string;
};

export type AccountKind = OfficialAccountKind;
/**
 * 每家一份（该家排第一的账号，老代码和测试按家取）+ all：所有账号的，按设置里的顺序。
 * 0.3.3 起一家可以同时查好几个账号。
 */
export type OfficialQuotaMap = Partial<Record<AccountKind, OfficialQuota>> & { all?: OfficialQuota[] };

/** 这一轮某个官方账号的额度没查到。刷新按钮要说出来，不能当成成功。 */
export type QuotaIssue = {
  kind: AccountKind;
  accountId?: string;
  who: string;
  /**
   * cli-wait（0.3.54）：账号登录在 CLI 里，CLI 的凭据过期了，等 CLI 下次发请求时自己续（不用重新登录）。
   * rate-limited：官方回了 429，或者还在上次 429 之后的冷却里（冷却期间不发请求）。
   */
  reason: "expired" | "auth" | "blocked" | "empty" | "error" | "cli-wait" | "rate-limited";
  detail?: string;
  /** rate-limited：冷却到什么时候，之后的定时查询才会再问。 */
  retryAt?: number;
};

const CLI_NAME: Record<AccountKind, string> = { claude: "Claude Code", chatgpt: "Codex", grok: "Grok CLI" };

export type QuotaFetchResult = OfficialQuotaMap & { issues: QuotaIssue[] };

const KIND_LABEL: Record<AccountKind, string> = { claude: "Claude", chatgpt: "ChatGPT", grok: "Grok" };

function whoOf(kind: AccountKind, accountId?: string): string {
  if (accountId) {
    const account = visibleAccounts(kind).find((item) => item.id === accountId);
    if (account) return account.alias || account.email || account.label || KIND_LABEL[kind];
  }
  return KIND_LABEL[kind];
}

/** 提示里写清哪家、哪个账号，例如「Claude 的 7ipnyt@gmail.com」。 */
export function quotaAccountTitle(kind: AccountKind, who?: string): string {
  const brand = KIND_LABEL[kind] || kind;
  const name = (who || "").trim();
  if (!name || name === brand) return brand;
  if (name.startsWith(`${brand} `) || name.startsWith(`${brand}的`)) return name;
  return `${brand} 的 ${name}`;
}

function isAuthFailure(raw?: string): boolean {
  const text = (raw || "").toLowerCase();
  return (
    text === "auth" ||
    text.includes("401") ||
    text.includes("403") ||
    text.includes("unauthor") ||
    text.includes("authentication") ||
    text.includes("invalid_token") ||
    text.includes("invalid grant") ||
    text.includes("token_expired")
  );
}

function quotaAuthFailed(json: Record<string, unknown> | null | undefined): boolean {
  if (!json || typeof json !== "object") return false;
  const nested = json.error && typeof json.error === "object" ? (json.error as Record<string, unknown>) : null;
  const bits = [json.type, json.error, json.message, json.code, nested?.type, nested?.code, nested?.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return /unauthor|forbidden|authentication|invalid.?token|invalid.?api.?key|invalid.?grant|token.?expired|not.?logged|unauthenticated/.test(bits);
}

function isNetworkFailure(raw?: string): boolean {
  const text = (raw || "").toLowerCase();
  return (
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("enotfound") ||
    text.includes("econn") ||
    text.includes("exit") ||
    text.includes("curl") ||
    text.includes("超时") ||
    text.includes("命令失败")
  );
}

function clock(at: number) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const LOG_HINT = "详细原因已记在日志（设置 →「数据」→「打开日志」）。";

/** 给刷新按钮 / 托盘刷新用的整句。没有问题就没有这句话。 */
export function quotaIssueNotice(issues: QuotaIssue[] | undefined): string | undefined {
  if (!issues?.length) return undefined;
  let hint = false;
  const text = issues
    .map((issue) => {
      const who = quotaAccountTitle(issue.kind, issue.who);
      if (issue.reason === "expired" || issue.reason === "auth" || isAuthFailure(issue.detail)) {
        return `${who} 登录已失效，请重新登录。`;
      }
      if (issue.reason === "blocked") return `${who} 的额度没查：出口 IP 不在允许列表。`;
      if (issue.reason === "cli-wait") return `${who} 登录在 ${CLI_NAME[issue.kind]} 里，凭据过期了，${CLI_NAME[issue.kind]} 下次发请求时会自动续上，不用重新登录。`;
      if (issue.reason === "rate-limited") {
        const when = issue.retryAt ? `约 ${clock(issue.retryAt)} ` : "过几分钟";
        return `${who} 被官方限流了（HTTP 429），${when}再自动查，先显示上次的数字。`;
      }
      hint = true;
      const status = Number(/^http (\d{3})/.exec(issue.detail || "")?.[1]);
      if (status >= 500) return `${who} 的额度没查到：官方服务器出错（HTTP ${status}），先显示上次的数字。`;
      if (status >= 400) return `${who} 的额度没查到：官方返回 HTTP ${status}，先显示上次的数字。`;
      if (issue.detail === "not json") return `${who} 的额度没查到：官方返回的不是额度数据，可能被代理或网络拦截了，先显示上次的数字。`;
      if (issue.reason === "empty") return `${who} 的额度没查到：官方返回里没有额度数字，先显示上次的数字。`;
      if (isNetworkFailure(issue.detail)) return `${who} 的官方额度没查到，没连上官方。`;
      return `${who} 这次没问到最新额度，还是显示上次的数字。`;
    })
    .join("");
  return hint ? `${text}${LOG_HINT}` : text;
}

/** 登录失效用红色；问不到数字、没连上、出口被拦用黄色，不是额度没变。 */
export function quotaIssueTone(issues: QuotaIssue[] | undefined): "warning" | "error" {
  if (!issues?.length) return "warning";
  if (issues.some((issue) => issue.reason === "expired" || issue.reason === "auth" || isAuthFailure(issue.detail))) return "error";
  return "warning";
}

/** 刷新前后各账号 5 小时 / 周额度的已用百分比，用来写「变了多少」。 */
export type QuotaGlance = { id: string; who: string; kind?: AccountKind; five?: number; week?: number };

const CHANGE_EPS = 0.05;

function fmtPct(n: number) {
  return `${n.toFixed(1)}%`;
}

function moved(from: number | undefined, to: number | undefined) {
  if (to == null || !Number.isFinite(to)) return false;
  if (from == null || !Number.isFinite(from)) return true;
  return Math.abs(to - from) >= CHANGE_EPS;
}

function windowLine(who: string, label: string, from: number | undefined, to: number) {
  if (from == null || !Number.isFinite(from)) return `${who} ${label}已用 ${fmtPct(to)}。`;
  const delta = to - from;
  const sign = delta > 0 ? "+" : "";
  return `${who} ${label} ${fmtPct(from)} → ${fmtPct(to)}（${sign}${delta.toFixed(1)}%）。`;
}

/** 手动刷新成功时右上角那句：已刷新，以及哪一项额度变了、变了多少。 */
export function quotaRefreshSummary(before: QuotaGlance[], after: QuotaGlance[]): string {
  const prev = new Map(before.map((item) => [item.id, item]));
  const lines: string[] = [];
  for (const item of after) {
    const old = prev.get(item.id);
    const who = item.kind ? quotaAccountTitle(item.kind, item.who) : item.who || "账号";
    if (moved(old?.five, item.five) && item.five != null) lines.push(windowLine(who, "5 小时", old?.five, item.five));
    if (moved(old?.week, item.week) && item.week != null) lines.push(windowLine(who, "周额度", old?.week, item.week));
  }
  if (!after.length) return "已刷新。本机用量已更新。";
  if (!lines.length) return "已刷新。官方额度没有变化。";
  const shown = lines.slice(0, 4);
  const extra = lines.length - shown.length;
  return `已刷新。${shown.join("")}${extra > 0 ? `另外 ${extra} 项也变了。` : ""}`;
}

let cache: { at: number; value: OfficialQuotaMap } | null = null;
const CACHE_MS = 120_000;

function tmpName(prefix: string) {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
}

async function curlBinary(url: string, headers: string[], bodyFile: string) {
  const out = tmpName("tokenpulse-quota");
  const args = ["-sS", "-m", "15", ...(await curlProxyArgs(url)), "-X", "POST", "-o", out, "-w", "%{http_code}", "--data-binary", `@${bodyFile}`, url];
  for (const header of headers) args.push("-H", header);
  const started = Date.now();
  try {
    const { stdout } = await execFileAsync(curlBin(), args, { timeout: 18000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const status = Number(String(stdout).trim());
    const buf = fs.readFileSync(out);
    const line = `POST ${logUrl(url)} → ${Number.isFinite(status) ? status : "?"}（${Date.now() - started} ms，${buf.length} 字节）`;
    if (status >= 400) log.warn("net", line);
    else log.info("net", line);
    return buf;
  } catch (error) {
    log.warn("net", `POST ${logUrl(url)} 失败（${Date.now() - started} ms）：${errorText(error)}`);
    throw error;
  } finally {
    fs.unlink(out, () => undefined);
  }
}

function windowPct(raw: unknown): { pct: number; reset?: string } | null {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!row) return null;
  const pct = typeof row.utilization === "number" ? row.utilization : null;
  if (pct == null || !Number.isFinite(pct)) return null;
  return { pct, reset: typeof row.resets_at === "string" ? row.resets_at : undefined };
}

/* ---------------- protobuf / grpc-web（Grok 用） ---------------- */

function readVarint(buf: Buffer, i: number): [number, number] {
  let n = 0n;
  let s = 0n;
  while (i < buf.length) {
    const b = BigInt(buf[i++]);
    n |= (b & 0x7fn) << s;
    if ((b & 0x80n) === 0n) break;
    s += 7n;
  }
  return [Number(n), i];
}

type ProtoField = { field: number; wire: number; varint?: number; bytes?: Buffer; float?: number };

function readFields(chunk: Buffer): ProtoField[] {
  const out: ProtoField[] = [];
  let i = 0;
  while (i < chunk.length) {
    const [tag, ni] = readVarint(chunk, i);
    i = ni;
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const [v, nj] = readVarint(chunk, i);
      i = nj;
      out.push({ field, wire, varint: v });
    } else if (wire === 2) {
      const [n, nj] = readVarint(chunk, i);
      const bytes = chunk.subarray(nj, nj + n);
      i = nj + n;
      out.push({ field, wire, bytes });
    } else if (wire === 5) {
      out.push({ field, wire, float: chunk.readFloatLE(i) });
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      break;
    }
  }
  return out;
}

function grpcPayload(buf: Buffer): Buffer | undefined {
  if (buf.length < 5) return undefined;
  const len = buf.readUInt32BE(1);
  return buf.subarray(5, Math.min(buf.length, 5 + len));
}

function timestampSeconds(msg: Buffer): number | undefined {
  const seconds = readFields(msg).find((item) => item.field === 1 && item.varint != null)?.varint;
  return seconds != null && seconds > 1_600_000_000 && seconds < 2_100_000_000 ? seconds : undefined;
}

/** grpc-web 空 unary：flag + 4 字节长度 + 空 protobuf。 */
function emptyGrpcWeb() {
  const file = tmpName("tokenpulse-grpc-empty");
  fs.writeFileSync(file, Buffer.from([0, 0, 0, 0, 0]));
  return file;
}

function grokAuthHeaders(key: string) {
  return [`Authorization: Bearer ${key}`, "Content-Type: application/grpc-web+proto", "X-Grpc-Web: 1"];
}

function parseGrokCredits(buf: Buffer): { weekPct: number; weekReset?: string; weekStart?: string } | undefined {
  const payload = grpcPayload(buf);
  if (!payload || payload.length === 0) return undefined;
  const root = readFields(payload);
  const config = root.find((item) => item.field === 1 && item.bytes)?.bytes ?? payload;
  const fields = readFields(config);
  const pct = fields.find((item) => item.field === 1 && item.float != null)?.float;
  const startMsg = fields.find((item) => item.field === 4 && item.bytes)?.bytes;
  const start = startMsg ? timestampSeconds(startMsg) : undefined;
  const endMsg = fields.find((item) => item.field === 5 && item.bytes)?.bytes;
  const end = endMsg ? timestampSeconds(endMsg) : undefined;
  const hasPeriod = fields.some((item) => item.field === 4 || item.field === 5);
  if (pct == null && !hasPeriod) return undefined;
  return {
    weekPct: pct != null && Number.isFinite(pct) ? pct : 0,
    weekReset: end ? new Date(end * 1000).toISOString() : undefined,
    weekStart: start ? new Date(start * 1000).toISOString() : undefined,
  };
}

function parseGrokResets(buf: Buffer): number | undefined {
  const payload = grpcPayload(buf);
  if (!payload) return undefined;
  const now = Date.now() / 1000;
  let count = 0;
  for (const item of readFields(payload)) {
    if (item.field !== 10 || !item.bytes) continue;
    const endField = readFields(item.bytes).find((row) => row.field === 30 && row.bytes);
    const end = endField?.bytes ? timestampSeconds(endField.bytes) : undefined;
    if (end == null || end >= now) count += 1;
  }
  return count;
}

/* ---------------- 三家 ---------------- */

/** 查一个账号要用的：token、ChatGPT 的工作区、账号 id（采样历史按它分开）。 */
type Target = { token: string; workspace?: string; accountId: string };

/**
 * TokenPulse 账号库里这一家的所有可查询账号，按设置顺序返回。
 * TokenPulse 登录的账号优先使用自己保存的凭据；只有 CLI 读入、没有 stored credential 的账号才读 CLI 凭据。
 * 这条路径不看 CLI 当前 provider，也不会改写 CLI 配置。
 */
function targetsOf(kind: AccountKind, now = Date.now()): Target[] {
  const live = readCliAccounts(kind);
  for (const account of live) {
    try {
      rememberOfficialAccount(account, false, now);
    } catch {
      // 数据目录只读：照样查，只是记不住名字
    }
  }
  const liveById = new Map(live.map((account) => [`${account.kind}:${account.ref}`, account]));
  const out: Target[] = [];
  for (const account of visibleAccounts(kind)) {
    const credential = account.credential ?? liveById.get(account.id)?.credential;
    if (!credential || isExpired(credential, now)) continue;
    out.push({ token: credential.token, workspace: credential.accountId, accountId: account.id });
  }
  return out;
}

async function grokCreditsConfig(key: string) {
  try {
    const json = await curlJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", [
      `Authorization: Bearer ${key}`,
      "Accept: application/json",
      "x-xai-token-auth: xai-grok-cli",
      "User-Agent: xai-grok-cli",
    ]);
    if (quotaAuthFailed(json)) throw new Error("auth");
    const config = json.config && typeof json.config === "object" ? (json.config as Record<string, unknown>) : null;
    if (config) {
      const pct = config.creditUsagePercent;
      const period =
        config.currentPeriod && typeof config.currentPeriod === "object"
          ? (config.currentPeriod as Record<string, unknown>)
          : null;
      const end =
        (typeof period?.end === "string" && period.end) ||
        (typeof config.billingPeriodEnd === "string" && config.billingPeriodEnd) ||
        undefined;
      const start =
        (typeof period?.start === "string" && period.start) ||
        (typeof config.billingPeriodStart === "string" && config.billingPeriodStart) ||
        undefined;
      if (typeof pct === "number" || end) {
        return {
          weekPct: typeof pct === "number" && Number.isFinite(pct) ? pct : 0,
          weekReset: end,
          weekStart: start,
        };
      }
    }
  } catch {
    // 退回 protobuf
  }
  const empty = emptyGrpcWeb();
  try {
    const buf = await curlBinary(
      "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig",
      grokAuthHeaders(key),
      empty,
    );
    return parseGrokCredits(buf);
  } finally {
    fs.unlink(empty, () => undefined);
  }
}

async function grokResetCount(key: string) {
  const empty = emptyGrpcWeb();
  try {
    const buf = await curlBinary(
      "https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets",
      grokAuthHeaders(key),
      empty,
    );
    return parseGrokResets(buf);
  } finally {
    fs.unlink(empty, () => undefined);
  }
}

async function grokQuota(active: Target): Promise<OfficialQuota | undefined> {
  const key = active.token;
  const [config, resets] = await Promise.all([grokCreditsConfig(key), grokResetCount(key).catch(() => undefined)]);
  if (!config && resets == null) return undefined;
  return {
    name: "Grok 账号",
    weekPct: config?.weekPct,
    weekReset: config?.weekReset,
    weekStart: config?.weekStart,
    resetCredits: resets,
    accountId: active.accountId,
  };
}

async function chatgptQuota(active: Target): Promise<OfficialQuota | undefined> {
  const token = active.token;
  const account = active.workspace;
  const headers = [`Authorization: Bearer ${token}`, "Accept: application/json"];
  if (account) headers.push(`ChatGPT-Account-Id: ${account}`);
  const [usage, resets] = await Promise.all([
    curlJson("https://chatgpt.com/backend-api/wham/usage", headers),
    curlJson("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", headers).catch(
      () => null as Record<string, unknown> | null,
    ),
  ]);
  if (quotaAuthFailed(usage)) throw new Error("auth");
  const limit = usage.rate_limit as Record<string, unknown> | undefined;
  const primary = limit?.primary_window as Record<string, unknown> | undefined;
  const secondary = limit?.secondary_window as Record<string, unknown> | undefined;
  const five = typeof primary?.used_percent === "number" ? primary.used_percent : undefined;
  const week = typeof secondary?.used_percent === "number" ? secondary.used_percent : undefined;
  const nested = usage.rate_limit_reset_credits as Record<string, unknown> | undefined;
  const resetCredits =
    typeof resets?.available_count === "number"
      ? resets.available_count
      : typeof nested?.available_count === "number"
        ? nested.available_count
        : undefined;
  if (five == null && week == null && resetCredits == null) return undefined;
  const resetAt = typeof secondary?.reset_at === "number" ? secondary.reset_at : undefined;
  const fiveResetAt = typeof primary?.reset_at === "number" ? primary.reset_at : undefined;
  return {
    name: "ChatGPT 账号",
    fiveHourPct: five,
    weekPct: week,
    weekReset: resetAt ? new Date(resetAt * 1000).toISOString() : undefined,
    fiveHourReset: fiveResetAt ? new Date(fiveResetAt * 1000).toISOString() : undefined,
    plan: typeof usage.plan_type === "string" ? usage.plan_type : undefined,
    resetCredits,
    accountId: active.accountId,
  };
}

async function claudeQuota(active: Target): Promise<OfficialQuota | undefined> {
  // 过期判断在 targetsOf 里：Claude Code 只在自己被使用时才刷新 token，太久没用就会过期。
  const token = active.token;
  const json = await curlJson("https://api.anthropic.com/api/oauth/usage", [
    `Authorization: Bearer ${token}`,
    "anthropic-beta: oauth-2025-04-20",
    "anthropic-version: 2023-06-01",
  ]);
  if (quotaAuthFailed(json)) throw new Error("auth");
  const five = windowPct(json.five_hour);
  const week = windowPct(json.seven_day);
  if (!five && !week) return undefined;
  return {
    name: "Claude 账号",
    fiveHourPct: five?.pct ?? 0,
    weekPct: week?.pct ?? 0,
    weekReset: week?.reset,
    fiveHourReset: five?.reset,
    accountId: active.accountId,
  };
}

/**
 * 问一轮三家的额度。`force` 跳过缓存。
 * 真的问过接口才记历史（走缓存的不算）—— 额度监控的速度/预测全靠那份历史。
 */
/**
 * 向官方发请求之前的放行检查（出口监控里设了 IP 白名单的那家，出口 IP 不在白名单里就不查，见 egress-monitor.ts 的 gateQuota）。
 * 返回 false 的那家这一轮不续期、不查额度。
 */
export type QuotaGate = (kind: AccountKind) => Promise<boolean>;

/**
 * 限流冷却：官方回 429 后，到 until 之前这个账号不再发请求（手动刷新也不发，发了只会把限流拖得更久）。
 * 等多久：官方 Retry-After 和自己的退避取大的；退避从 2 分钟起，连续 429 每次翻倍，封顶 15 分钟。查到一次就清零。
 * 以前每分钟照问不误，撞上限流就一直「没问到最新额度」。
 */
const cooldowns = new Map<string, { until: number; strikes: number }>();
const COOLDOWN_BASE_MS = 2 * 60_000;
const COOLDOWN_MAX_MS = 15 * 60_000;
const RETRY_AFTER_MAX_MS = 60 * 60_000;

export function rateLimitWaitMs(strikes: number, retryAfterMs?: number) {
  const backoff = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** Math.max(0, strikes - 1));
  return Math.max(backoff, Math.min(RETRY_AFTER_MAX_MS, retryAfterMs ?? 0));
}

/** 测试用：清掉所有冷却。 */
export function resetQuotaCooldowns() {
  cooldowns.clear();
}

function quotaLine(quota: OfficialQuota) {
  const bits = [
    quota.fiveHourPct != null ? `5 小时 ${quota.fiveHourPct.toFixed(1)}%` : "",
    quota.weekPct != null ? `周 ${quota.weekPct.toFixed(1)}%` : "",
    quota.resetCredits != null ? `重置次数 ${quota.resetCredits}` : "",
  ].filter(Boolean);
  return bits.join("，") || "有数据";
}

/** 这一轮查不查这个账号（「后台账号少查一点」，见 quota-quiet.ts）。没传就全查；不查的账号这一轮不发请求、也不报问题。 */
export type QuotaPick = (kind: AccountKind, accountId: string) => boolean;

export async function fetchOfficialQuota(force = false, gate?: QuotaGate, pick?: QuotaPick): Promise<QuotaFetchResult> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return { ...cache.value, issues: [] };
  const picked = new Map<string, boolean>();
  const wanted = (kind: AccountKind, id: string) => {
    if (!pick) return true;
    if (!picked.has(id)) picked.set(id, pick(kind, id));
    return picked.get(id)!;
  };
  const kinds: AccountKind[] = ["claude", "chatgpt", "grok"];
  const issues: QuotaIssue[] = [];
  // 检查本身出错也按「不放行」处理：宁可这一轮没有额度，也不从没确认过的出口去问官方
  const passed = gate ? await Promise.all(kinds.map((kind) => gate(kind).catch(() => false))) : kinds.map(() => true);
  const allowed = kinds.filter((_, i) => passed[i]);
  for (let i = 0; i < kinds.length; i++) {
    if (passed[i] || !visibleAccounts(kinds[i]).length) continue;
    issues.push({ kind: kinds[i], who: KIND_LABEL[kinds[i]], reason: "blocked" });
  }
  // TokenPulse 自己登录的账号需要由本软件负责续期，额度查询仍只使用各账号自己的凭据。
  await renewStoredCredentials(Date.now(), undefined, allowed).catch(() => 0);
  // 登录在 Claude Code 里的账号：Claude Code 没在运行时替它续（见 cli-renew.ts）
  const cliRenew: CliRenewResult | undefined = allowed.includes("claude") ? await renewCliCredential().catch(() => undefined) : undefined;
  const value: OfficialQuotaMap = {};
  const query = { claude: claudeQuota, chatgpt: chatgptQuota, grok: grokQuota };
  const jobs: Promise<OfficialQuota | undefined>[] = [];
  for (const kind of allowed) {
    const targets = targetsOf(kind);
    const queryable = new Set(targets.map((target) => target.accountId));
    const inCli = new Set(readCliAccounts(kind).filter((item) => item.credential.refreshToken).map((item) => accountIdOf(kind, item.ref)));
    for (const account of visibleAccounts(kind)) {
      if (queryable.has(account.id) || !wanted(kind, account.id)) continue;
      const dead = kind === "claude" && cliRenew?.dead && cliRenew.accountId === account.id;
      const reason = inCli.has(account.id) && !dead ? "cli-wait" : "expired";
      issues.push({ kind, accountId: account.id, who: whoOf(kind, account.id), reason });
    }
    for (const target of targets) {
      if (!wanted(kind, target.accountId)) continue;
      const who = whoOf(kind, target.accountId);
      const cooling = cooldowns.get(target.accountId);
      if (cooling && Date.now() < cooling.until) {
        issues.push({ kind, accountId: target.accountId, who, reason: "rate-limited", retryAt: cooling.until, detail: "冷却中" });
        continue;
      }
      jobs.push(
        query[kind](target).then(
          (quota) => {
            cooldowns.delete(target.accountId);
            if (quota) return { ...quota, kind };
            issues.push({ kind, accountId: target.accountId, who, reason: "empty" });
            return undefined;
          },
          (error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            if (error instanceof HttpError && error.status === 429) {
              const strikes = (cooldowns.get(target.accountId)?.strikes ?? 0) + 1;
              const until = Date.now() + rateLimitWaitMs(strikes, error.retryAfterMs);
              cooldowns.set(target.accountId, { until, strikes });
              issues.push({ kind, accountId: target.accountId, who, reason: "rate-limited", retryAt: until, detail: detail.slice(0, 80) });
              return undefined;
            }
            issues.push({
              kind,
              accountId: target.accountId,
              who,
              reason: isAuthFailure(detail) ? "auth" : "error",
              // execFile 的 message 是整条命令行（带 token），取 curl 自己的报错
              detail: errorText(error).slice(0, 80),
            });
            return undefined;
          },
        ),
      );
    }
  }
  const all: OfficialQuota[] = [];
  for (const quota of await Promise.all(jobs)) if (quota) all.push(quota);
  for (const quota of all) log.info("quota", `${quotaAccountTitle(quota.kind || "claude", quota.accountId ? whoOf(quota.kind || "claude", quota.accountId) : undefined)}：${quotaLine(quota)}`);
  for (const issue of issues) {
    const until = issue.retryAt ? `，冷却到 ${clock(issue.retryAt)}` : "";
    log.warn("quota", `${quotaAccountTitle(issue.kind, issue.who)}：没查到（${issue.reason}${issue.detail ? `：${issue.detail}` : ""}${until}）`);
  }
  value.all = all;
  for (const quota of all) if (quota.kind && !value[quota.kind]) value[quota.kind] = quota;
  cache = { at: Date.now(), value };
  try {
    recordQuotaSamples(value);
  } catch {
    // 写不进去只是少一个采样点
  }
  return { ...value, issues };
}
