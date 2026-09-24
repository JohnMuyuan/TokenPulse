/**
 * 每一次请求的「型号核验」：客户端要的型号，和上游真正回的是不是同一个。
 *
 * 只用 CLI 自己写进会话文件的东西，不额外发请求、不花额度。能核对的是：
 *
 * 1. **请求型号 vs 返回型号**：
 *    - Claude Code：请求型号在 `attachment.identity.modelId`（`claude-opus-5[1m]`），返回型号是响应里的 `message.model`；
 *    - Grok Build：请求型号在用户消息的 `_meta.modelId`，返回型号是 `turn_completed` 里 `modelUsage` 的键；
 *    - Codex：会话文件**不记返回型号**（`token_usage_record` 只有 response_id），只能核对响应格式。
 * 2. **响应特征**（参考中转站检测的通行做法）：Anthropic 官方的响应 ID 是 `msg_` + 24 位、
 *    请求 ID 是 `req_011…`（本机实测 11559 条全部如此）；经 Bedrock 是 `msg_bdrk_…`、Vertex 是 `msg_vrtx_…`。
 *    号称 Claude、ID 却是 `resp_…`（OpenAI Responses）、`chatcmpl-…` 或一串 UUID，就是被别家接口转换过来的。
 *
 * 局限要照实说：中转站完全可以把型号名和 ID 格式都伪造成官方的样子，「一致」只说明没露馅，
 * 不等于验明正身；反过来「不一致」和「存疑」是实打实的证据。
 *
 * 纯函数：规则改了不用重扫会话文件，查询时现算。
 */

import { aliasRules } from "./knowledge";

export type VerifyStatus = "match" | "mismatch" | "suspect" | "unverified";

export type VerifyInput = {
  kind: "claude-code" | "codex" | "grok-build" | "cc-switch";
  /** 客户端请求的型号。undefined = 会话里没记下来。 */
  requested?: string;
  /** 上游返回的型号。undefined = 这家 CLI 不记。 */
  returned?: string;
  responseId?: string;
  requestId?: string;
  /** 这个会话走不走官方登录账号（false = API Key / 中转站，undefined = 判断不出来）。 */
  official?: boolean;
  /** cc-switch：是不是走它本地代理的请求。 */
  viaProxy?: boolean;
  /** 同一次请求在 CC Switch 代理里的记录：它从上游响应里读到的型号。 */
  proxy?: { requested?: string; returned: string };
};

export type VerifyResult = {
  status: VerifyStatus;
  /** 一句话说明，按严重程度排，第一条放在表格里。 */
  reasons: string[];
  /** 从响应特征看出来的通道，例如「Anthropic 官方格式」「OpenAI 格式」。 */
  channel: string;
};

/**
 * 比较前把「同一个型号的不同写法」抹平：
 * - `[1m]` / `[1M]`：Claude Code 标记 1M 上下文，请求里有、响应里没有；
 * - 日期后缀：`claude-opus-4-8-20260315`、`gpt-5.4-2026-03-05`；
 * - 云厂商前缀 / 后缀：`us.anthropic.claude-…-v1:0`（Bedrock）、`claude-…@20260315`（Vertex）；
 * - Grok Build 的 `-build`：请求 `grok-4.6`、响应 `grok-4.6-build`，是 xAI 给 Grok Build 用的同一型号（本机 45 轮全是这样）。
 */
export function normalizeModel(model: string) {
  let out = model.trim().toLowerCase();
  // 规则在 knowledge/models.json 的 aliases 里，能在线更新
  for (const rule of aliasRules()) out = out.replace(rule.test, rule.replace);
  return out;
}

const isClaude = (model?: string) => Boolean(model && /claude/i.test(model));
const ANTHROPIC_MESSAGE = /^msg_[A-Za-z0-9]{24}$/;
const ANTHROPIC_REQUEST = /^req_[A-Za-z0-9]{20,}$/;
const OPENAI_RESPONSE = /^resp_[0-9a-f]{40,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ID 长什么样，给界面看的：把字母数字换成占位，不泄露具体值也能看出格式。 */
export function idShape(id?: string) {
  if (!id) return "（无）";
  const prefix = id.match(/^[a-z]+[_-](?:[a-z]+_)?/i)?.[0] ?? "";
  return `${prefix}…，共 ${id.length} 位`;
}

/** 从响应 ID 看是哪种接口回的。 */
export function channelOf(kind: VerifyInput["kind"], responseId?: string) {
  const id = responseId || "";
  if (!id) return kind === "grok-build" ? "xAI（Grok Build）" : "未知";
  if (/^msg_bdrk_/.test(id)) return "AWS Bedrock";
  if (/^msg_vrtx_/.test(id)) return "Google Vertex";
  if (ANTHROPIC_MESSAGE.test(id)) return "Anthropic 官方格式";
  if (OPENAI_RESPONSE.test(id)) return "OpenAI Responses 格式";
  if (/^resp_/.test(id)) return "类 OpenAI Responses 格式";
  if (/^chatcmpl-/.test(id)) return "OpenAI Chat 格式";
  if (/^msg_/.test(id)) return "非标准 msg_ 格式";
  if (UUID.test(id)) return "UUID（第三方接口）";
  return "其他格式";
}

export function verifyRequest(input: VerifyInput): VerifyResult {
  const { kind, responseId, requestId, official, proxy } = input;
  // Codex 的会话文件不记返回型号；同一次请求经过 CC Switch 代理的话，用代理从上游响应里读到的
  const requested = input.requested ?? proxy?.requested;
  const returned = input.returned ?? proxy?.returned;
  const channel = kind === "cc-switch" ? (input.viaProxy ? "CC Switch 代理" : "CC Switch 导入") : channelOf(kind, responseId);
  const problems: string[] = [];
  const notes: string[] = [];

  let mismatch = false;
  if (requested && returned && normalizeModel(requested) !== normalizeModel(returned)) {
    mismatch = true;
    problems.push(`请求的是 ${requested}，上游返回的是 ${returned}`);
  }
  // 会话文件和代理记录都有返回型号、却对不上：CLI 记的是它以为的，代理看到的才是上游真回的
  if (!mismatch && proxy && input.returned && normalizeModel(proxy.returned) !== normalizeModel(input.returned)) {
    mismatch = true;
    problems.push(`会话文件记的返回型号是 ${input.returned}，CC Switch 代理从上游响应里读到的是 ${proxy.returned}`);
  }

  if (kind === "claude-code") {
    const bedrockOrVertex = /^msg_(bdrk|vrtx)_/.test(responseId || "");
    // 号称 Claude，响应却是别家接口的格式：请求被转到了别的模型上，再把型号名改回 Claude。
    if (isClaude(returned) && !bedrockOrVertex && !ANTHROPIC_MESSAGE.test(responseId || "")) {
      problems.push(`返回型号是 ${returned}，但响应 ID 是 ${channel}（${idShape(responseId)}），不是 Anthropic 的 msg_ + 24 位`);
    }
    /*
     * 走官方还是中转，Claude Code 这边是按全局 settings.json 判断的；别的程序（比如 AllAi）
     * 会给单个进程另配环境变量去接 gpt / grok —— 这种会话的响应本来就不是 Claude，不算问题。
     */
    if (returned && !isClaude(returned)) notes.push(`这次请求接的是第三方模型（响应是 ${channel}），不是 Anthropic`);
    // 官方直连：Anthropic 每个响应都带 request-id 头，Claude Code 会记下来
    else if (official === true && ANTHROPIC_MESSAGE.test(responseId || "") && !ANTHROPIC_REQUEST.test(requestId || "")) {
      problems.push("这个会话走官方账号，响应却没有 Anthropic 的 request-id");
    }
    if (!requested) notes.push("这段会话没记下请求的型号（旧版 Claude Code，或会话刚恢复还没写入），只核对了响应格式");
    if (bedrockOrVertex) notes.push(`经 ${channel} 转发，属于官方云渠道`);
  } else if (kind === "cc-switch") {
    notes.push(
      input.viaProxy
        ? "来自 CC Switch 代理：型号是它从上游响应里读到的"
        : "来自 CC Switch 的导入（TokenPulse 这天没有这个工具的记录）",
    );
  } else if (kind === "codex") {
    if (proxy) notes.push("经 CC Switch 代理：返回型号是代理从上游响应里读到的");
    else notes.push("Codex 会话文件不记录上游返回的型号，只能核对响应格式");
    if (responseId && !OPENAI_RESPONSE.test(responseId)) {
      problems.push(`响应 ID 是 ${channel}（${idShape(responseId)}），不是 OpenAI 的 resp_ + 十六进制`);
    }
  } else {
    if (!returned) notes.push("这一轮没有返回按型号拆分的用量，无法核对返回型号");
    else if (!requested) notes.push("这一轮没记下请求的型号");
    else if (!mismatch && normalizeModel(returned) !== returned.toLowerCase().trim()) notes.push(`${returned} 是 ${requested} 在 Grok Build 里的官方变体`);
  }

  if (official === false && !mismatch && !problems.length) {
    notes.push("走的是 API Key / 中转站：中转可以原样回显型号名，一致只代表没露馅");
  }

  let status: VerifyStatus;
  if (mismatch) status = "mismatch";
  else if (problems.length) status = "suspect";
  else if (requested && returned) status = "match";
  else status = "unverified";
  return { status, reasons: [...problems, ...notes], channel };
}

export const STATUS_LABELS: Record<VerifyStatus, string> = {
  match: "型号一致",
  mismatch: "型号不一致",
  suspect: "响应存疑",
  unverified: "无法核验",
};
