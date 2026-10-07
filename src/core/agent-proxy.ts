/**
 * 本地路由。
 *
 * 各工具的请求先打到 127.0.0.1，TokenPulse 按当前供应商换成真实地址和密钥再转发出去。
 * 协议相同就原样流式转发；不同才转换。一个供应商返回 429 / 5xx 时，按备用队列试下一家，
 * 响应头还没写给客户端才能换。
 */
import http from "http";
import https from "https";
import { URL } from "url";
import { clientError, convertJsonResponse, convertRequest, StreamBridge } from "./agent-convert";
import { NATIVE_UPSTREAM, type AgentApp, type ProxyTarget, type Upstream } from "./agent-types";
import { describeNetError, proxyFor, upstreamRequest } from "./upstream-proxy";

export type ProxyLog = {
  at: number;
  app: AgentApp;
  providerId: string;
  provider: string;
  model: string;
  status: number;
  ms: number;
  input?: number;
  output?: number;
  error?: string;
  /** 号池把这次请求交给了哪个官方账号（只有成功的、成员是官方账号的才有）。 */
  account?: string;
  /*
   * 下面是给永久保存的转发记录用的细节（0.3.34，见 route-ledger.ts 的 appendRouteLog）。都不含请求 / 回复的内容和任何凭据。
   * attempt：这个请求的第几次尝试（前面的成员失败了才会有第 2、3 次）；requestModel：工具请求里写的型号；
   * client / upstream：工具用的接口格式和上游的接口格式（不一样就是做了转换）；effort：转发出去的请求里的思考等级。
   */
  method?: string;
  path?: string;
  attempt?: number;
  pool?: boolean;
  requestModel?: string;
  client?: string;
  upstream?: string;
  host?: string;
  stream?: boolean;
  effort?: string;
  requestBytes?: number;
  cacheRead?: number;
};

type Options = {
  host: string;
  port: number;
  targets: (app: AgentApp) => ProxyTarget[];
  log: (entry: ProxyLog) => void;
  fail: (id: string) => void;
  succeed: (id: string) => void;
  open: (id: string) => boolean;
};

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length"]);

function readBody(req: http.IncomingMessage) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function appOfPath(pathname: string): { app: AgentApp; rest: string } | null {
  const parts = pathname.split("/").filter(Boolean);
  const head = parts[0];
  if (head !== "claude" && head !== "desktop" && head !== "codex" && head !== "grok") return null;
  return { app: head, rest: `/${parts.slice(1).join("/")}` };
}

/** 供应商地址已经带了 /v1 时，不再把客户端路径里的 /v1 拼第二次。 */
export function joinUpstream(base: string, pathAndQuery: string) {
  const root = new URL(base.includes("://") ? base : `https://${base}`);
  const extra = new URL(pathAndQuery, "http://local");
  let path = extra.pathname;
  const basePath = root.pathname.replace(/\/$/, "");
  if (basePath.endsWith("/v1") && (path === "/v1" || path.startsWith("/v1/"))) path = path.slice(3) || "/";
  root.pathname = `${basePath}${path.startsWith("/") ? path : `/${path}`}`.replace(/\/{2,}/g, "/");
  root.search = extra.search;
  return root;
}

/** 从回复里读 Token 数。流式回复的用量在最后才出现，所以取最后一次出现的。 */
function sniffUsage(text: string) {
  const last = (pattern: RegExp) => { let found: string | undefined; for (const match of text.matchAll(pattern)) found = match[1]; return found ? Number(found) : undefined; };
  return {
    input: last(/"(?:input_tokens|prompt_tokens|promptTokenCount)"\s*:\s*(\d+)/g),
    output: last(/"(?:output_tokens|completion_tokens|candidatesTokenCount)"\s*:\s*(\d+)/g),
    cacheRead: last(/"(?:cached_tokens|cache_read_input_tokens|cached_input_tokens)"\s*:\s*(\d+)/g),
  };
}
/** 回复可能很长：只留开头和结尾各一段给 sniffUsage（用量不在开头就在结尾）。 */
const SNIFF_EDGE = 20000;
function keepEdges(seen: { head: string; tail: string }, text: string) {
  if (seen.head.length < SNIFF_EDGE) seen.head += text.slice(0, SNIFF_EDGE - seen.head.length);
  seen.tail = (seen.tail + text).slice(-SNIFF_EDGE);
}
/** 请求里写的型号和思考等级（只为了写进转发记录；读不出来就算了）。 */
function requestFacts(body: Buffer): { model?: string; effort?: string } {
  if (!body.length || !looksJson(body)) return {};
  try {
    const json = JSON.parse(body.toString("utf8")) as { model?: unknown; reasoning?: { effort?: unknown }; reasoning_effort?: unknown };
    const effort = json?.reasoning?.effort ?? json?.reasoning_effort;
    return { ...(typeof json?.model === "string" ? { model: json.model.slice(0, 120) } : {}), ...(typeof effort === "string" ? { effort: effort.slice(0, 20) } : {}) };
  } catch { return {}; }
}

export function startAgentProxy(options: Options) {
  const stats = { requests: 0, ok: 0, active: 0, startedAt: Date.now() };
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : "proxy failed" } }));
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "tokenpulse-route" }));
      return;
    }
    const routed = appOfPath(url.pathname);
    if (!routed) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("TokenPulse 本地路由不认识这个地址");
      return;
    }
    const client = NATIVE_UPSTREAM[routed.app];
    const targets = options.targets(routed.app).filter((target) => target.baseUrl && !options.open(target.id));
    if (!targets.length) {
      sendError(res, client, 503, "这一家还没有可转发的供应商");
      return;
    }
    const body = await readBody(req);
    const started = Date.now();
    stats.active += 1;
    stats.requests += 1;
    let last = "上游没有响应";
    // 转发记录里的细节：这一个请求里各次尝试共用的部分只算一次
    const facts = requestFacts(body);
    let attempt = 0;
    const detail = (target: ProxyTarget) => {
      let host = "";
      try { host = new URL(target.baseUrl).host; } catch { /* 地址不合法：下面转发时会报错 */ }
      return { method: req.method || "POST", path: routed.rest.slice(0, 200), attempt, pool: !!target.pool, client, upstream: target.upstream, host, stream: wantsStream(body, routed.rest), requestBytes: body.length,
        ...(facts.model ? { requestModel: facts.model } : {}), ...(target.reasoningEffort && routed.app === "grok" && !facts.effort ? { effort: target.reasoningEffort } : facts.effort ? { effort: facts.effort } : {}) };
    };
    try {
      for (const target of targets) {
        attempt += 1;
        if (res.destroyed) return;
        const outcome = await forward(req, res, routed.app, routed.rest + url.search, client, target, body);
        if (outcome.kind === "done") {
          options.succeed(target.id);
          stats.ok += 1;
          options.log({ at: Date.now(), app: routed.app, providerId: target.id, provider: target.name, model: target.model, status: outcome.status, ms: Date.now() - started, input: outcome.input, output: outcome.output, ...(outcome.cacheRead != null ? { cacheRead: outcome.cacheRead } : {}), ...(target.officialAccount ? { account: target.officialAccount } : {}), ...detail(target) });
          return;
        }
        options.fail(target.id);
        last = outcome.error;
        options.log({ at: Date.now(), app: routed.app, providerId: target.id, provider: target.name, model: target.model, status: outcome.status, ms: Date.now() - started, error: outcome.error, ...detail(target) });
      }
      if (!res.headersSent) sendError(res, client, 502, last);
    } finally {
      stats.active = Math.max(0, stats.active - 1);
    }
  }

  function listen() {
    return new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.off("error", reject);
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : options.port);
      });
    });
  }

  return {
    listen,
    stats: () => ({ ...stats }),
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

function sendError(res: http.ServerResponse, client: Upstream, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(clientError(client, message)));
}

type Outcome = { kind: "done"; status: number; input?: number; output?: number; cacheRead?: number } | { kind: "fail"; status: number; error: string };

async function forward(req: http.IncomingMessage, res: http.ServerResponse, app: AgentApp, rest: string, client: Upstream, target: ProxyTarget, body: Buffer): Promise<Outcome> {
  const same = client === target.upstream;
  const stream = wantsStream(body, rest);
  let upstreamPath = rest || "/";
  let payload = body;
  // ChatGPT 的 Codex 接口没有 /v1 前缀：…/backend-api/codex/responses
  if (target.auth === "codex-oauth") upstreamPath = upstreamPath.replace(/^\/v1(?=\/|$)/, "") || "/";
  if (!same && body.length && looksJson(body)) {
    if (rest.includes("count_tokens")) {
      const estimate = Math.max(1, Math.round(body.length / 4));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(client === "anthropic" ? { input_tokens: estimate } : { input_tokens: estimate }));
      return { kind: "done", status: 200 };
    }
    try {
      const converted = convertRequest(client, target.upstream, body.toString("utf8"), resolvedModel(body, target));
      upstreamPath = converted.path;
      if (stream) converted.json.stream = true;
      payload = Buffer.from(JSON.stringify(converted.json));
    } catch (error) {
      return { kind: "fail", status: 400, error: error instanceof Error ? error.message : "无法转换请求" };
    }
  } else if (same && body.length && looksJson(body) && (target.model || target.modelMap)) {
    payload = Buffer.from(rewriteModel(body.toString("utf8"), resolvedModel(body, target)));
  }
  let upstream: URL;
  try {
    upstream = joinUpstream(target.baseUrl, upstreamPath);
  } catch {
    return { kind: "fail", status: 400, error: "供应商地址不是有效的网址" };
  }
  if (target.auth === "codex-oauth") payload = codexBackendBody(payload);
  if (app === "grok" && target.reasoningEffort) payload = applyReasoningEffort(payload, target.reasoningEffort);
  payload = applyRequestBodyOverrides(payload, target.requestBody);
  const headers = forwardHeaders(req, target, payload.length);
  // 上游走代理（环境变量 / 系统代理，见 upstream-proxy.ts）。以前一律直连，需要代理的机器上每个成员都连接超时、记成 502
  const proxy = await proxyFor(upstream);
  return new Promise((resolve) => {
    const upstreamReq = upstreamRequest(upstream, proxy, { method: req.method || "POST", headers, timeout: 120_000 }, (upstreamRes) => {
      const status = upstreamRes.statusCode || 502;
      // 号池成员：401 / 403 多半是这个账号的登录失效或没权限，换下一个成员
      if (status === 429 || status >= 500 || (target.pool && (status === 401 || status === 403))) {
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk) => {
          if (chunks.reduce((sum, item) => sum + item.length, 0) < 8000) chunks.push(Buffer.from(chunk));
        });
        upstreamRes.on("end", () => {
          const detail = chunks.join("") || `HTTP ${status}`;
          resolve({ kind: "fail", status, error: detail.slice(0, 300) });
        });
        return;
      }
      const contentType = String(upstreamRes.headers["content-type"] || "");
      if (!same && (stream || contentType.includes("text/event-stream") || contentType.includes("application/json"))) {
        void pipeConverted(upstreamRes, res, client, target, stream || contentType.includes("event-stream")).then(resolve);
        return;
      }
      res.writeHead(status, { "content-type": contentType || "application/json" });
      const seen = { head: "", tail: "" };
      upstreamRes.on("data", (chunk) => {
        keepEdges(seen, chunk.toString("utf8"));
        res.write(chunk);
      });
      upstreamRes.on("end", () => {
        res.end();
        const usage = sniffUsage(seen.head.length < SNIFF_EDGE ? seen.head : seen.head + "\n" + seen.tail);
        resolve({ kind: "done", status, input: usage.input, output: usage.output, cacheRead: usage.cacheRead });
      });
    });
    const clientClosed = () => {
      upstreamReq.destroy();
      resolve({ kind: 'fail', status: 499, error: '客户端连接已关闭' });
    };
    res.once('close', clientClosed);
    upstreamReq.once('close', () => res.off('close', clientClosed));
    upstreamReq.on("error", (error) => resolve({ kind: "fail", status: 502, error: describeNetError(error, Boolean(proxy)) }));
    upstreamReq.on("timeout", () => {
      upstreamReq.destroy();
      resolve({ kind: "fail", status: 504, error: "上游超时" });
    });
    if (payload.length && req.method !== "GET" && req.method !== "HEAD") upstreamReq.write(payload);
    upstreamReq.end();
  });
}

function wantsStream(body: Buffer, rest: string) {
  if (!looksJson(body)) return false;
  try {
    return JSON.parse(body.toString("utf8")).stream === true;
  } catch {
    return false;
  }
}

function looksJson(body: Buffer) {
  const start = body.toString("utf8", 0, 1);
  return start === "{" || start === "[";
}

function resolvedModel(body: Buffer, target: ProxyTarget) {
  let requested = "";
  try {
    const json = JSON.parse(body.toString("utf8")) as { model?: string };
    requested = typeof json.model === "string" ? json.model : "";
  } catch { /* 非 JSON 请求用默认模型 */ }
  if (requested && target.modelMap?.[requested]) return target.modelMap[requested];
  if (requested && !target.modelMap) return requested;
  return target.model || requested || "model";
}

function rewriteModel(raw: string, model: string) {
  try {
    const json = JSON.parse(raw) as { model?: string };
    if (json && typeof json === "object") json.model = model;
    return JSON.stringify(json);
  } catch {
    return raw;
  }
}

/**
 * 请求里没带思考等级时补上（已经带了的不动）。Responses 格式是 reasoning.effort，保留里面别的键（如 summary）；
 * Chat Completions 格式是 reasoning_effort。只处理带 model 的 JSON 请求。
 */
export function applyReasoningEffort(payload: Buffer, effort: string) {
  if (!payload.length || !looksJson(payload)) return payload;
  try {
    const json = JSON.parse(payload.toString("utf8"));
    if (!json || typeof json !== "object" || Array.isArray(json) || typeof json.model !== "string") return payload;
    if (Array.isArray(json.messages)) { if (json.reasoning_effort != null) return payload; json.reasoning_effort = effort; }
    else {
      const reasoning = json.reasoning && typeof json.reasoning === "object" && !Array.isArray(json.reasoning) ? json.reasoning : {};
      if (reasoning.effort != null) return payload;
      json.reasoning = { ...reasoning, effort };
    }
    return Buffer.from(JSON.stringify(json));
  } catch { return payload; }
}

function applyRequestBodyOverrides(payload: Buffer, overrides?: Record<string, unknown>) {
  if (!overrides || !Object.keys(overrides).length || !looksJson(payload)) return payload;
  try { const json = JSON.parse(payload.toString("utf8")); if (!json || typeof json !== "object" || Array.isArray(json)) return payload; return Buffer.from(JSON.stringify({ ...json, ...overrides })); } catch { return payload; }
}

function forwardHeaders(req: http.IncomingMessage, target: ProxyTarget, length: number) {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value || HOP.has(key.toLowerCase())) continue;
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key" || lower === "x-goog-api-key") continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  // 覆盖的请求头统一小写，免得和转发来的同名头（Node 给的都是小写）变成两份；连接层和长度相关的头不让覆盖
  for (const [key, value] of Object.entries(target.requestHeaders || {})) {
    const lower = key.toLowerCase();
    if (!key || value == null || HOP.has(lower) || lower === "host" || lower === "content-length") continue;
    headers[lower] = String(value);
  }
  if (target.auth) applyOfficialAuth(headers, target);
  else if (target.apiKey) {
    if (target.upstream === "anthropic") {
      headers["x-api-key"] = target.apiKey;
      headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
    } else headers.authorization = `Bearer ${target.apiKey}`;
  }
  if (length) headers["content-length"] = String(length);
  headers["content-type"] = headers["content-type"] || "application/json";
  return headers;
}

/**
 * 号池里的官方账号：请求是真的 CLI 发的（格式本来就对），这里只换认证。
 * - Claude：Bearer + anthropic-beta 里补上 oauth-2025-04-20（CLI 在 API Key 模式下不会带它）；
 * - Codex：Bearer + Chatgpt-Account-Id（工作区 id）+ Originator；
 * - Grok：Bearer（CLI 登录用的就是这把 key）。
 * 不改 User-Agent、不伪造设备或账号标识。
 */
function applyOfficialAuth(headers: Record<string, string>, target: ProxyTarget) {
  delete headers["x-api-key"];
  headers.authorization = `Bearer ${target.apiKey}`;
  if (target.auth === "claude-oauth") {
    const betas = (headers["anthropic-beta"] || "").split(",").map((item) => item.trim()).filter(Boolean);
    if (!betas.includes("oauth-2025-04-20")) betas.push("oauth-2025-04-20");
    headers["anthropic-beta"] = betas.join(",");
    headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
  } else if (target.auth === "codex-oauth") {
    if (target.accountId) headers["chatgpt-account-id"] = target.accountId;
    headers.originator = headers.originator || "codex_cli_rs";
  }
}

/** ChatGPT 的 Codex 接口：只收流式、不存储；API 模式才有的几个字段它不认。 */
export function codexBackendBody(payload: Buffer) {
  if (!looksJson(payload)) return payload;
  try {
    const json = JSON.parse(payload.toString("utf8"));
    if (!json || typeof json !== "object" || Array.isArray(json)) return payload;
    json.stream = true;
    json.store = false;
    if (json.instructions == null) json.instructions = "";
    for (const key of ["previous_response_id", "prompt_cache_retention", "safety_identifier", "stream_options", "max_output_tokens"]) delete json[key];
    return Buffer.from(JSON.stringify(json));
  } catch {
    return payload;
  }
}

function pipeConverted(upstream: http.IncomingMessage, res: http.ServerResponse, client: Upstream, target: ProxyTarget, stream: boolean) {
  return new Promise<Outcome>((resolve) => {
    const chunks: Buffer[] = [];
    const bridge = stream ? new StreamBridge(target.upstream, client, target.model || "model") : null;
    if (stream) res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    upstream.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (bridge) res.write(bridge.push(text));
      else chunks.push(Buffer.from(chunk));
    });
    upstream.on("end", () => {
      if (bridge) {
        res.write(bridge.end());
        res.end();
        const usage = bridge.usage();
        resolve({ kind: "done", status: upstream.statusCode || 200, input: usage.input, output: usage.output });
        return;
      }
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        const json = convertJsonResponse(client, target.upstream, payload, target.model || "model");
        const encoded = JSON.stringify(json);
        res.writeHead(upstream.statusCode || 200, { "content-type": "application/json; charset=utf-8" });
        res.end(encoded);
        const usage = sniffUsage(encoded);
        resolve({ kind: "done", status: upstream.statusCode || 200, input: usage.input, output: usage.output });
      } catch (error) {
        const message = error instanceof Error ? error.message : "无法转换响应";
        if (!res.headersSent) sendError(res, client, 502, message);
        else res.end();
        resolve({ kind: "done", status: 502 });
      }
    });
    upstream.on("error", (error) => {
      if (!res.headersSent) sendError(res, client, 502, error.message);
      else res.end();
      resolve({ kind: "done", status: 502 });
    });
  });
}

export async function fetchUpstreamModels(baseUrl: string, apiKey: string) {
  let url: URL;
  try { url = joinUpstream(baseUrl, "/v1/models"); } catch { throw new Error("地址不是有效的网址"); }
  const proxy = await proxyFor(url);
  return new Promise<string[]>((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const request = upstreamRequest(url, proxy, { method: "GET", timeout: 8000, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(`获取模型失败，HTTP ${response.statusCode || 0}`));
          return;
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data?: { id?: string; name?: string }[]; models?: { id?: string; name?: string }[] };
          const rows = body.data || body.models || [];
          resolve([...new Set(rows.map((item) => item.id || item.name || "").filter(Boolean))]);
        } catch {
          reject(new Error("供应商没有返回可识别的模型列表"));
        }
      });
    });
    request.on("timeout", () => { request.destroy(); reject(new Error("获取模型超时")); });
    request.on("error", (error) => reject(new Error(describeNetError(error, Boolean(proxy)))));
    request.end();
  });
}

export async function probeUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "地址不是有效的网址" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "只接受 http 或 https" };
  const proxy = await proxyFor(url);
  return new Promise<{ ok: boolean; status?: number; error?: string }>((resolve) => {
    const request = upstreamRequest(url, proxy, { method: "GET", timeout: 8000 }, (response) => {
      response.resume();
      const status = response.statusCode || 0;
      resolve({ ok: status > 0 && status < 500, status });
    });
    request.on("timeout", () => {
      request.destroy();
      resolve({ ok: false, error: "连接超时" });
    });
    request.on("error", (error) => resolve({ ok: false, error: describeNetError(error, Boolean(proxy)) }));
    request.end();
  });
}
