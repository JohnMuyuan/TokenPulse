/*
 * Codex 降智检测（0.3.41）：用户手动点一次才测一次，不做自动。
 *
 * 起因：ChatGPT 账号被官方降到更低的模型时，回复里报的型号名仍然是请求的那个（开头、结束两次都是，本机实测），
 * 靠型号名核验查不出来。这里用的是 sub2api 项目实测总结的「门票」判据（它的 openai_codex_state_probe.go）：
 *   1. 不带门票发一个极小的请求，官方在响应头 x-codex-turn-state 里发一张门票，同时给两枚路由 Cookie（__cflb / __oailb）；
 *   2. 带上这张门票和 Cookie 再发一个：官方回了一张不一样的新门票 → 降智；没回或回的是原票 → 正常。
 * 两发都必须是 HTTP 200 且回复完整结束才下结论，否则一律「无法判断」，不误报。
 *
 * 要照实说的局限：
 * - 这是经验规律，不是官方公开的规则，官方一改就可能失效；sub2api 只在门票长度 780 的请求上验证过；
 * - 每测一次是两个真实请求，会花一点额度；
 * - 请求由 TokenPulse 发出，网络特征和真的 Codex 客户端不完全一样，结论可能受影响，也不能保证官方不在意。
 * 所以只在用户明确点击时运行；门票和 Cookie 只在内存里用这一次，不保存、不进日志。
 */
import crypto from "crypto";
import type http from "http";
import { describeNetError, proxyFor, upstreamRequest } from "./upstream-proxy";
import { Grab } from "./ws-sniff";

export type ProbeVerdict = "healthy" | "degraded" | "inconclusive";
export type ProbeResult = {
  at: number; ms: number; model: string; verdict: ProbeVerdict;
  /** 一句话结论 / 没测成的原因。 */
  reason: string;
  /** 没测成时的分类：account_error / rate_limited / model_unsupported / upstream_error / network_error / stream_error / no_ticket。 */
  failure?: string;
  mintStatus: number; continueStatus: number;
  /** 第一发拿到的门票有多长（判据只在 780 上验证过）；不保存门票本身。 */
  ticketLength: number; continueTicketLength: number;
  newTicket: boolean;
  /** 官方回复里报的型号，只作展示，不作判据。 */
  reportedModel?: string;
};
export type ProbeCredential = { token: string; accountId?: string };

export const PROBE_TICKET_LENGTH = 780;
const TURN_STATE = "x-codex-turn-state";
const SHOT_TIMEOUT_MS = 45_000;
const MAX_BODY = 1 << 20;
/** 和真的 Codex CLI 一致的身份头。版本太旧官方会降低优先级，所以跟着本机在用的版本写。 */
const CLIENT_VERSION = "0.162.0";
const USER_AGENT = `codex_cli_rs/${CLIENT_VERSION} (Windows 10.0.26200; x86_64) WindowsTerminal`;

type Shot = { status: number; state: string; cookies: string[]; model: string; streamError: string; detail: string };

const REASONS: Record<ProbeVerdict, string> = {
  degraded: "带着第一张门票再发时，官方换了一张新门票：符合降智的特征，这个账号很可能被降到了更低的模型。",
  healthy: "带着第一张门票再发时，官方没有换新门票：门票延续正常，这个账号目前没有降智的迹象。",
  inconclusive: "没有拿到有效的检测结果，无法判断。",
};

function fire(base: string, credential: ProbeCredential, model: string, turnState: string, cookie: string): Promise<Shot> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const url = new URL(base.replace(/\/+$/, "") + "/responses");
      const body = Buffer.from(JSON.stringify({ model, instructions: "Reply with OK.", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Reply with OK." }] }],
        stream: true, store: false, parallel_tool_calls: true, include: ["reasoning.encrypted_content"] }));
      const headers: Record<string, string> = {
        authorization: `Bearer ${credential.token}`, accept: "text/event-stream", "content-type": "application/json", "content-length": String(body.length),
        "openai-beta": "responses=experimental", originator: "codex_cli_rs", version: CLIENT_VERSION, "user-agent": USER_AGENT, session_id: crypto.randomUUID(),
        ...(credential.accountId ? { "chatgpt-account-id": credential.accountId } : {}),
        ...(turnState ? { [TURN_STATE]: turnState } : {}), ...(cookie ? { cookie } : {}),
      };
      const proxy = await proxyFor(url);
      let settled = false;
      const done = (shot: Shot | null, error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); if (shot) resolve(shot); else reject(error); };
      const request: http.ClientRequest = upstreamRequest(url, proxy, { method: "POST", headers, agent: false }, (response) => {
        const chunks: Buffer[] = []; let size = 0, tooLarge = false;
        response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_BODY) { tooLarge = true; request.destroy(); return; } chunks.push(chunk); });
        const finish = (incomplete: boolean) => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode || 0;
          const cookies: string[] = [];
          for (const line of ([] as string[]).concat(response.headers["set-cookie"] || [])) {
            const hit = /^(__cflb|__oailb)=([^;]+)/.exec(line);
            if (hit && hit[2] && !/max-age=-|max-age=0\b/i.test(line) && !cookies.some((item) => item.startsWith(hit[1] + "="))) cookies.push(`${hit[1]}=${hit[2]}`);
          }
          const grab = new Grab(); grab.feed(text);
          const completed = /"type"\s*:\s*"response\.(?:completed|done)"/.test(text) && !/"type"\s*:\s*"(?:response\.(?:failed|incomplete)|error)"/.test(text);
          const message = /"message"\s*:\s*"((?:[^"\\]|\\.){1,300})/.exec(text)?.[1] || "";
          done({ status, state: String(response.headers[TURN_STATE] || "").trim(), cookies, model: grab.model,
            streamError: status !== 200 ? "" : tooLarge ? "回复太大" : incomplete ? "回复没有收完" : completed ? "" : "回复没有正常结束",
            detail: status === 200 && completed ? "" : message.slice(0, 200) });
        };
        response.on("end", () => finish(false));
        response.on("error", () => finish(true));
        response.on("aborted", () => finish(true));
      });
      const timer = setTimeout(() => { request.destroy(); done(null, new Error("timeout")); }, SHOT_TIMEOUT_MS);
      request.on("error", (error) => done(null, new Error(describeNetError(error, Boolean(proxy)))));
      request.end(body);
    })().catch(reject);
  });
}

/** 一发算不算干净跑通；没跑通时返回原因分类和说明。 */
function unusable(step: string, shot: Shot): { failure: string; reason: string } | null {
  if (shot.status === 200) return shot.streamError ? { failure: "stream_error", reason: `${step}返回了 200，但${shot.streamError}（官方过载或额度用尽时会这样），这次无法判断` + (shot.detail ? `：${shot.detail}` : "") } : null;
  if (shot.status === 401 || shot.status === 403) return { failure: "account_error", reason: `${step}被官方拒绝（HTTP ${shot.status}）：登录可能已失效，请重新登录这个账号` };
  if (shot.status === 429) return { failure: "rate_limited", reason: `${step}被官方限流（HTTP 429），请稍后再试` };
  if (shot.status === 400 && /not supported/i.test(shot.detail)) return { failure: "model_unsupported", reason: `这个账号的套餐不支持用来检测的型号（HTTP 400）` };
  return { failure: "upstream_error", reason: `${step}返回了异常状态（HTTP ${shot.status}）` + (shot.detail ? `：${shot.detail}` : "") };
}

export async function probeCodexState(credential: ProbeCredential, model: string, options: { base?: string; now?: () => number } = {}): Promise<ProbeResult> {
  const now = options.now ?? Date.now, started = now();
  const base = options.base || process.env.TOKENPULSE_CODEX_PROBE_BASE || "https://chatgpt.com/backend-api/codex";
  const result: ProbeResult = { at: started, ms: 0, model, verdict: "inconclusive", reason: REASONS.inconclusive, mintStatus: 0, continueStatus: 0, ticketLength: 0, continueTicketLength: 0, newTicket: false };
  const fail = (failure: string, reason: string) => { result.verdict = "inconclusive"; result.failure = failure; result.reason = reason; };
  try {
    if (!credential.token) { fail("account_error", "这个账号没有可用的登录凭据，请先登录"); return result; }
    const mint = await fire(base, credential, model, "", "");
    result.mintStatus = mint.status; result.ticketLength = mint.state.length; result.reportedModel = mint.model || undefined;
    const mintProblem = unusable("第一发请求", mint);
    if (mintProblem) { fail(mintProblem.failure, mintProblem.reason); return result; }
    if (!mint.state) { fail("no_ticket", "第一发请求成功了，但官方没有发门票，无法用这个方法判断"); return result; }
    const next = await fire(base, credential, model, mint.state, mint.cookies.join("; "));
    result.continueStatus = next.status; result.continueTicketLength = next.state.length;
    if (next.model) result.reportedModel = next.model;
    const nextProblem = unusable("第二发请求", next);
    if (nextProblem) { fail(nextProblem.failure, nextProblem.reason); return result; }
    result.newTicket = Boolean(next.state) && next.state !== mint.state;
    result.verdict = result.newTicket ? "degraded" : "healthy";
    result.reason = REASONS[result.verdict];
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    fail("network_error", message === "timeout" ? `请求超时（${SHOT_TIMEOUT_MS / 1000} 秒内没有完成）` : `请求没有发成功（网络或代理异常）${message ? "：" + message.slice(0, 200) : ""}`);
    return result;
  } finally {
    result.ms = now() - started;
  }
}
