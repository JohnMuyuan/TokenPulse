import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { renewStoredCredentials, resolveActiveAccount } from "./accounts";
import { curlBin, curlJson } from "./curl";
import type { OfficialAccountKind } from "./credentials";
import { recordQuotaSamples } from "./quota-history";

/**
 * 问各家官方接口：这个账号的 5 小时 / 周额度用了多少。
 *
 * 全部用**本机 CLI 自己存的登录凭据**，不需要用户再登一次：
 * - Claude   `~/.claude/.credentials.json` 的 OAuth token
 * - ChatGPT  `~/.codex/auth.json` 的 access_token
 * - Grok     `~/.grok/auth.json` 的 key
 *
 * 为什么走 curl 而不是 fetch：这几个接口对 TLS 指纹和 HTTP/2 比较挑，
 * Node 的 fetch 经常被挡；curl 在 Windows 10+ 是系统自带的。
 */

const execFileAsync = promisify(execFile);

export type OfficialQuota = {
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
export type OfficialQuotaMap = Partial<Record<AccountKind, OfficialQuota>>;

let cache: { at: number; value: OfficialQuotaMap } | null = null;
const CACHE_MS = 120_000;

function tmpName(prefix: string) {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
}

async function curlBinary(url: string, headers: string[], bodyFile: string) {
  const out = tmpName("tokenpulse-quota");
  const args = ["-sS", "-m", "15", "-X", "POST", "-o", out, "--data-binary", `@${bodyFile}`, url];
  for (const header of headers) args.push("-H", header);
  try {
    await execFileAsync(curlBin(), args, { timeout: 18000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    return fs.readFileSync(out);
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

/**
 * 活动账号的可用凭据。没有、或已过期就返回 undefined（该账号这轮不显示），
 * 不回退到 CLI 当前那个账号 —— 否则切换之后额度会悄悄变成另一个人的。
 */
function activeCredential(kind: AccountKind) {
  const account = resolveActiveAccount(kind);
  if (!account.credential || account.expired) return undefined;
  return { ...account.credential, accountId: account.id, workspace: account.credential.accountId };
}

async function grokCreditsConfig(key: string) {
  try {
    const json = await curlJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", [
      `Authorization: Bearer ${key}`,
      "Accept: application/json",
      "x-xai-token-auth: xai-grok-cli",
      "User-Agent: xai-grok-cli",
    ]);
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

async function grokQuota(): Promise<OfficialQuota | undefined> {
  const active = activeCredential("grok");
  if (!active) return undefined;
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

async function chatgptQuota(): Promise<OfficialQuota | undefined> {
  const active = activeCredential("chatgpt");
  if (!active) return undefined;
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

async function claudeQuota(): Promise<OfficialQuota | undefined> {
  // 过期判断在 activeCredential 里：Claude Code 只在自己被使用时才刷新 token，太久没用就会过期。
  const active = activeCredential("claude");
  if (!active) return undefined;
  const token = active.token;
  const json = await curlJson("https://api.anthropic.com/api/oauth/usage", [
    `Authorization: Bearer ${token}`,
    "anthropic-beta: oauth-2025-04-20",
    "anthropic-version: 2023-06-01",
  ]);
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
export async function fetchOfficialQuota(force = false): Promise<OfficialQuotaMap> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  // 先给快过期的 TokenPulse 账号续期，再查额度；续期失败不影响别的账号。
  await renewStoredCredentials().catch(() => 0);
  const value: OfficialQuotaMap = {};
  const jobs: Array<() => Promise<void>> = [
    async () => {
      const claude = await claudeQuota();
      if (claude) value.claude = claude;
    },
    async () => {
      const chatgpt = await chatgptQuota();
      if (chatgpt) value.chatgpt = chatgpt;
    },
    async () => {
      const grok = await grokQuota();
      if (grok) value.grok = grok;
    },
  ];
  await Promise.all(
    jobs.map((job) =>
      job().catch(() => {
        // 额度接口不是每次都能通（没登录、token 过期、网络不好）：这家就没有，别影响别家。
      }),
    ),
  );
  cache = { at: Date.now(), value };
  try {
    recordQuotaSamples(value);
  } catch {
    // 写不进去只是少一个采样点
  }
  return value;
}
