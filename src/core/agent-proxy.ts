/**
 * 本地路由。
 *
 * 各工具的请求先打到 127.0.0.1，TokenPulse 按当前供应商换成真实地址和密钥再转发出去。
 * 协议相同就原样流式转发；不同才转换。一个供应商返回 429 / 5xx 时，按备用队列试下一家，
 * 响应头还没写给客户端才能换。
 */
import http from "http";
import https from "https";
import zlib from "zlib";
import { URL } from "url";
import type { Duplex } from "stream";
import { clientError, convertJsonResponse, convertRequest, StreamBridge } from "./agent-convert";
import { NATIVE_UPSTREAM, type AgentApp, type ProxyTarget, type Upstream } from "./agent-types";
import { describeNetError, proxyFor, upstreamRequest } from "./upstream-proxy";
import { Grab, WsReader } from "./ws-sniff";

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
  /** 透明转发（见 forwardPass）：这一条是原样转给官方的，没有选供应商、没有换凭据。 */
  pass?: boolean;
  /** 透明转发才有：从发出请求到收到回复第一个字节用了多久。 */
  firstByteMs?: number;
  /** 透明转发才有：从发出请求到回复里第一段内容（文字、思考或工具调用的增量）出现用了多久。 */
  firstTokenMs?: number;
  /** 透明转发才有：输出 Token ÷ 出字用的时间（结束 − 第一个字节），每秒多少 Token。输出太少或读不到用量时没有。 */
  tokensPerSec?: number;
  responseBytes?: number;
  /*
   * 型号核验用（0.3.35）：从上游回复里读到的响应 ID 和它实际用的型号。
   * 请求记录靠响应 ID 把 CLI 会话里的那次请求和这一条对上（见 route-ledger.ts 的 routeReturned）——
   * Codex 的会话文件不记返回型号，只有这里能补上。接口格式转换过的转发没有（工具收到的 ID 不是上游的）。
   */
  responseId?: string;
  returnedModel?: string;
  /*
   * 请求里要的服务档位（0.3.35）：Codex 的「快速模式」是 service_tier = "priority"（配置里写 fast），Claude 的是 speed = "fast"。
   * 快速模式出字明显更快，和普通模式混在一起算速度没有意义，所以记下来、汇总时分开。默认档（default / auto / 没写）不记。
   */
  tier?: string;
};
/** 请求里的服务档位：只留不是默认的。 */
function tierOf(value: unknown) {
  const tier = typeof value === "string" ? value.trim().toLowerCase().slice(0, 20) : "";
  return tier && tier !== "default" && tier !== "auto" && tier !== "standard" ? tier : "";
}
/** 回复里读到了响应 ID 才算数：没有 ID 的（模型列表之类）里面的 model 不是「返回型号」。 */
const returnedOf = (grab: { responseId?: string; model?: string }) => (grab.responseId ? { responseId: grab.responseId, ...(grab.model ? { returnedModel: grab.model.slice(0, 120) } : {}) } : {});

type Options = {
  host: string;
  port: number;
  targets: (app: AgentApp) => ProxyTarget[];
  log: (entry: ProxyLog) => void;
  fail: (id: string) => void;
  succeed: (id: string) => void;
  open: (id: string) => boolean;
  /** 透明转发：这个工具开着的话，返回官方接口的地址；没开返回 null（这时 /pass/… 一律 404）。请求头只用来分辨该去哪个官方地址。 */
  pass?: (app: AgentApp, headers: http.IncomingHttpHeaders) => string | null;
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
function requestFacts(body: Buffer): { model?: string; effort?: string; tier?: string } {
  if (!body.length || !looksJson(body)) return {};
  try {
    const json = JSON.parse(body.toString("utf8")) as { model?: unknown; reasoning?: { effort?: unknown }; reasoning_effort?: unknown; service_tier?: unknown; speed?: unknown };
    const effort = json?.reasoning?.effort ?? json?.reasoning_effort;
    const tier = tierOf(json?.service_tier) || tierOf(json?.speed);
    return { ...(typeof json?.model === "string" ? { model: json.model.slice(0, 120) } : {}), ...(typeof effort === "string" ? { effort: effort.slice(0, 20) } : {}), ...(tier ? { tier } : {}) };
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
    // 透明转发：/pass/<工具>/… 原样转给官方，不选供应商、不换凭据（见 forwardPass）
    const passed = PASS_PATH.exec(url.pathname);
    if (passed) {
      const app = passed[1] as AgentApp, base = options.pass?.(app, req.headers) ?? null;
      if (!base) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "TokenPulse pass-through is off for this tool" } })); return; }
      stats.active += 1; stats.requests += 1;
      try { const entry = await forwardPass(req, res, app, (passed[2] || "/") + url.search, base, await readBody(req)); if (entry.status < 400 && !entry.error) stats.ok += 1; options.log(entry); }
      finally { stats.active = Math.max(0, stats.active - 1); }
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
        ...(facts.model ? { requestModel: facts.model } : {}), ...(facts.tier ? { tier: facts.tier } : {}), ...(target.reasoningEffort && routed.app === "grok" && !facts.effort ? { effort: target.reasoningEffort } : facts.effort ? { effort: facts.effort } : {}) };
    };
    try {
      for (const target of targets) {
        attempt += 1;
        if (res.destroyed) return;
        const outcome = await forward(req, res, routed.app, routed.rest + url.search, client, target, body);
        if (outcome.kind === "done") {
          options.succeed(target.id);
          stats.ok += 1;
          options.log({ at: Date.now(), app: routed.app, providerId: target.id, provider: target.name, model: target.model, status: outcome.status, ms: Date.now() - started, input: outcome.input, output: outcome.output, ...(outcome.cacheRead != null ? { cacheRead: outcome.cacheRead } : {}), ...returnedOf({ responseId: outcome.responseId, model: outcome.returnedModel }), ...(target.officialAccount ? { account: target.officialAccount } : {}), ...detail(target) });
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

  // 透明转发的长连接（Codex 用官方登录时走 WebSocket）：两头之间原样搬运字节，见 tunnelPass
  const tunnels = new Set<Duplex>();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const passed = PASS_PATH.exec(url.pathname);
    const app = passed ? passed[1] as AgentApp : null, base = app ? options.pass?.(app, req.headers) ?? null : null;
    if (!app || !base) { socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n"); return; }
    tunnels.add(socket);
    socket.once("close", () => tunnels.delete(socket));
    socket.on("error", () => undefined);
    void tunnelPass(req, socket, head, app, (passed![2] || "/") + url.search, base, (entry) => {
      stats.requests += 1; if (entry.status < 400 && !entry.error) stats.ok += 1;
      options.log(entry);
    }).catch(() => socket.destroy());
  });

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
      for (const socket of tunnels) socket.destroy();
    }),
  };
}

function sendError(res: http.ServerResponse, client: Upstream, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(clientError(client, message)));
}

type Outcome = { kind: "done"; status: number; input?: number; output?: number; cacheRead?: number; responseId?: string; returnedModel?: string } | { kind: "fail"; status: number; error: string };

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
      const grab = new Grab();
      upstreamRes.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        keepEdges(seen, text);
        grab.feed(text);
        res.write(chunk);
      });
      upstreamRes.on("end", () => {
        res.end();
        const usage = grab.usage ?? sniffUsage(seen.head.length < SNIFF_EDGE ? seen.head : seen.head + "\n" + seen.tail);
        resolve({ kind: "done", status, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, ...(grab.responseId ? { responseId: grab.responseId, returnedModel: grab.model || undefined } : {}) });
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

/*
 * 透明转发（0.3.35）：用户想知道模型有多快（首字延迟、每秒输出多少 Token），所以让官方 CLI 的请求在本机过一道。
 * 这里只做三件事：原样转发、计时、读回复里的 Token 数。
 * - 请求头原样带过去，只去掉逐跳的那几个（connection、host、content-length 之类，转发时本来就要重新生成）；
 *   凭据就是工具自己带的那份，这里不读、不存、不换；请求正文一个字节都不动。
 * - 回复的状态码、头、正文原样送回工具（压缩的也不解开）。另外旁路解压一份，只用来找用量数字，不落盘。
 * - 不重试、不换成员：上游报什么错就把什么错还给工具。
 * 和号池 / 供应商转发（forward）是两条路，互不影响。
 */
const PASS_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "trailers", "transfer-encoding", "upgrade", "host", "content-length"]);
const PASS_PATH = /^\/pass\/(claude|codex|grok)(\/.*)?$/;
const PASS_NAME = "官方登录（透明转发）";
const SPEED_MIN_OUTPUT = 20;
/** 回复里第一段内容：Claude 的 content_block_delta，OpenAI Responses 的 response.….delta。 */
const FIRST_TOKEN = /content_block_delta|"response\.[a-z_.]+\.delta"/;
/*
 * 模型从什么时候开始出字：
 * - Claude：回复的第一个字节（message_start）就是，官方处理完输入才会发它；
 * - OpenAI Responses（Codex）：response.created 一收到请求就发，这时还没开始算；第一个 response.output_item.added 才是开始出字
 *   （真机量过：created 在 0.4 秒，output_item.added 和第一段文字在 1.9 秒）。
 * 所以回复里出现过 output_item.added 就从它算起，没有就从第一个字节算起。
 */
const GEN_START = /"response\.output_item\.added"/;
/** 速度 = 输出 Token ÷ 出字用的时间。输出太少或时间太短时算出来的数没有意义，不算。 */
function speedOf(output: number | undefined, writingMs: number) {
  return output != null && output >= SPEED_MIN_OUTPUT && writingMs >= 200 ? { tokensPerSec: Math.round(output / (writingMs / 1000) * 10) / 10 } : {};
}
function passDecoder(encoding: string): zlib.Gunzip | null {
  const maker = (zlib as unknown as Record<string, (() => zlib.Gunzip) | undefined>);
  try {
    if (encoding === "gzip" || encoding === "x-gzip") return zlib.createGunzip();
    if (encoding === "deflate") return zlib.createInflate();
    if (encoding === "br") return zlib.createBrotliDecompress();
    if (encoding === "zstd" && maker.createZstdDecompress) return maker.createZstdDecompress();
  } catch { /* 这个运行环境不支持：读不到用量，转发不受影响 */ }
  return null;
}
export async function forwardPass(req: http.IncomingMessage, res: http.ServerResponse, app: AgentApp, rest: string, base: string, body: Buffer): Promise<ProxyLog> {
  const started = Date.now();
  const facts = requestFacts(body);
  let host = "";
  const entry = (extra: Partial<ProxyLog>): ProxyLog => ({ at: Date.now(), app, providerId: "pass-" + app, provider: PASS_NAME, model: facts.model || "", status: 0, ms: Date.now() - started, pass: true,
    method: req.method || "POST", path: rest.split("?")[0].slice(0, 200), attempt: 1, pool: false, host, stream: wantsStream(body, rest), requestBytes: body.length,
    ...(facts.model ? { requestModel: facts.model } : {}), ...(facts.effort ? { effort: facts.effort } : {}), ...(facts.tier ? { tier: facts.tier } : {}), ...extra });
  let upstream: URL;
  try { upstream = joinUpstream(base, rest); host = upstream.host; }
  catch { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "TokenPulse pass-through: bad upstream address" } })); return entry({ status: 502, error: "官方接口地址无效" }); }
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) if (value != null && !PASS_HOP.has(key.toLowerCase())) headers[key] = value;
  if (body.length || !["GET", "HEAD"].includes(req.method || "")) headers["content-length"] = String(body.length);
  const proxy = await proxyFor(upstream);
  return new Promise((resolve) => {
    let done = false;
    const finish = (extra: Partial<ProxyLog>) => { if (done) return; done = true; resolve(entry(extra)); };
    const clientClosed = () => { upstreamReq.destroy(); finish({ status: 499, error: "客户端连接已关闭" }); };
    res.once("close", clientClosed);
    const upstreamReq: http.ClientRequest = upstreamRequest(upstream, proxy, { method: req.method || "POST", headers: headers as http.OutgoingHttpHeaders, timeout: 600_000 }, (upstreamRes) => {
      const status = upstreamRes.statusCode || 502;
      const out: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) if (value != null && !PASS_HOP.has(key.toLowerCase())) out[key] = value;
      res.writeHead(status, out);
      let firstAt = 0, firstTokenAt = 0, genAt = 0, bytes = 0;
      const seen = { head: "", tail: "" };
      const grab = new Grab();
      const look = (text: string) => { grab.feed(text); if (!genAt && GEN_START.test(text)) genAt = Date.now(); if (!firstTokenAt && FIRST_TOKEN.test(text)) firstTokenAt = Date.now(); keepEdges(seen, text); };
      const decoder = passDecoder(String(upstreamRes.headers["content-encoding"] || "").trim().toLowerCase());
      decoder?.on("data", (chunk: Buffer) => look(chunk.toString("utf8")));
      decoder?.on("error", () => undefined);
      const plain = !upstreamRes.headers["content-encoding"];
      upstreamRes.on("data", (chunk: Buffer) => {
        if (!firstAt) firstAt = Date.now();
        bytes += chunk.length;
        res.write(chunk);
        if (plain) look(chunk.toString("utf8")); else decoder?.write(chunk);
      });
      upstreamRes.on("end", () => {
        // 回复已经完整送回去了：这之后工具关连接是正常收尾，不算「客户端中途关闭」
        res.off("close", clientClosed);
        res.end();
        const endAt = Date.now();
        const settle = () => {
          const usage = grab.usage ?? sniffUsage(seen.head.length < SNIFF_EDGE ? seen.head : seen.head + "\n" + seen.tail);
          const writing = firstAt ? endAt - (genAt || firstAt) : 0;
          finish({ status, responseBytes: bytes, ...(firstAt ? { firstByteMs: firstAt - started } : {}), ...(firstTokenAt ? { firstTokenMs: firstTokenAt - started } : {}), input: usage.input, output: usage.output, ...(usage.cacheRead != null ? { cacheRead: usage.cacheRead } : {}),
            ...(status < 400 ? { ...speedOf(usage.output, writing), ...returnedOf(grab) } : {}),
            ...(status >= 400 ? { error: (seen.head || `HTTP ${status}`).slice(0, 300) } : {}) });
        };
        if (decoder && !plain) { decoder.once("end", settle); decoder.once("error", settle); decoder.end(); setTimeout(settle, 1000); } else settle();
      });
      upstreamRes.on("error", () => { res.destroy(); finish({ status: 502, error: "回复中途断开", responseBytes: bytes, ...(firstAt ? { firstByteMs: firstAt - started } : {}) }); });
    });

    upstreamReq.once("close", () => res.off("close", clientClosed));
    const fail = (status: number, message: string) => {
      if (!res.headersSent) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "TokenPulse pass-through: " + message } })); }
      else res.destroy();
      finish({ status, error: message });
    };
    upstreamReq.on("error", (error) => fail(502, describeNetError(error, Boolean(proxy))));
    upstreamReq.on("timeout", () => { upstreamReq.destroy(); fail(504, "上游超时"); });
    upstreamReq.end(body.length ? body : undefined);
  });
}

/*
 * 透明转发的长连接。Codex 用官方登录时，对话走一条 WebSocket：握手请求原样转给官方（头一个不少，只有 host 换成官方的），
 * 官方的握手回复原样还给工具，之后两头的字节原样对搬——帧不解开、不重组、不改。
 * 旁路用 WsReader 看一眼搬过去的帧：工具发 response.create 算一次请求的开始，官方回 response.completed 算结束，
 * 从里面读型号、用量，记首字延迟和速度。一条连接上可以先后有很多次请求，每次记一条。
 */
const TUNNEL_DROP = new Set(["host", "content-length", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "trailers", "transfer-encoding"]);
const jsonField = (text: string, key: string) => new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]{1,200})"`).exec(text)?.[1] || "";
export async function tunnelPass(req: http.IncomingMessage, socket: Duplex, head: Buffer, app: AgentApp, rest: string, base: string, log: (entry: ProxyLog) => void) {
  const refuse = (status: number, text: string) => { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`); };
  let upstream: URL;
  try { upstream = joinUpstream(base, rest); } catch { refuse(502, "Bad Gateway"); return; }
  const path = rest.split("?")[0].slice(0, 200);
  const entry = (extra: Partial<ProxyLog>): ProxyLog => ({ at: Date.now(), app, providerId: "pass-" + app, provider: PASS_NAME, model: "", status: 0, ms: 0, pass: true, method: "WS", path, attempt: 1, pool: false, host: upstream.host, stream: true, ...extra });
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) if (value != null && !TUNNEL_DROP.has(key.toLowerCase())) headers[key] = value;
  const proxy = await proxyFor(upstream);
  const opened = Date.now();
  let settled = false;
  const upstreamReq = upstreamRequest(upstream, proxy, { method: "GET", headers: headers as http.OutgoingHttpHeaders, timeout: 30_000 });
  const rawHead = (res: http.IncomingMessage, drop?: Set<string>) => {
    let text = `HTTP/1.1 ${res.statusCode} ${res.statusMessage || ""}\r\n`;
    for (let index = 0; index + 1 < res.rawHeaders.length; index += 2) if (!drop?.has(res.rawHeaders[index].toLowerCase())) text += `${res.rawHeaders[index]}: ${res.rawHeaders[index + 1]}\r\n`;
    return text;
  };
  // 官方没有同意升级（没登录、限流……）：把它的回复原样还给工具
  upstreamReq.on("response", (res) => {
    settled = true;
    const status = res.statusCode || 502;
    let seen = "";
    socket.write(rawHead(res, new Set(["transfer-encoding", "connection", "keep-alive"])) + "connection: close\r\n\r\n");
    res.on("data", (chunk: Buffer) => { if (seen.length < 300 && !res.headers["content-encoding"]) seen += chunk.toString("utf8"); socket.write(chunk); });
    res.on("end", () => { socket.end(); log(entry({ status, ms: Date.now() - opened, ...(status >= 400 ? { error: (seen || `HTTP ${status}`).slice(0, 300) } : {}) })); });
    res.on("error", () => socket.destroy());
  });
  upstreamReq.on("upgrade", (res, up, upHead) => {
    settled = true;
    up.setTimeout(0);
    up.setNoDelay?.(true);
    (socket as Duplex & { setNoDelay?: (on: boolean) => void }).setNoDelay?.(true);
    socket.write(rawHead(res) + "\r\n");
    const deflate = /permessage-deflate/i.test(String(res.headers["sec-websocket-extensions"] || ""));
    type Turn = { started: number; requestBytes: number; model: string; effort: string; firstAt: number; firstTokenAt: number; genAt: number; bytes: number; responseId: string; returned: string; tier: string };
    let turn: Turn | null = null;
    const whole = (message: { head: string; tail: string }) => (message.head.length < SNIFF_EDGE ? message.head : message.head + "\n" + message.tail);
    const fromClient = new WsReader(deflate, (message) => {
      if (!message.text) return;
      const text = whole(message);
      if (!/"type"\s*:\s*"response\.create"/.test(text)) return;
      turn = { started: message.endAt, requestBytes: message.bytes, model: jsonField(text, "model").slice(0, 120), effort: jsonField(text, "effort").slice(0, 20), firstAt: 0, firstTokenAt: 0, genAt: 0, bytes: 0, responseId: "", returned: "", tier: tierOf(jsonField(text, "service_tier")) };
    });
    const closeTurn = (status: number, endAt: number, extra: Partial<ProxyLog>) => {
      const current = turn;
      if (!current) return;
      turn = null;
      log(entry({ at: endAt, model: current.model, status, ms: endAt - current.started, requestBytes: current.requestBytes, responseBytes: current.bytes,
        ...(current.model ? { requestModel: current.model } : {}), ...(current.effort ? { effort: current.effort } : {}), ...(current.tier ? { tier: current.tier } : {}),
        ...(current.firstAt ? { firstByteMs: current.firstAt - current.started } : {}), ...(current.firstTokenAt ? { firstTokenMs: current.firstTokenAt - current.started } : {}), ...returnedOf({ responseId: current.responseId, model: current.returned }), ...extra }));
    };
    const fromServer = new WsReader(deflate, (message) => {
      const current = turn;
      if (!current) return;
      current.bytes += message.bytes;
      if (!current.firstAt) current.firstAt = message.startAt;
      if (!message.text) return;
      const type = /"type"\s*:\s*"([A-Za-z_.]+)"/.exec(message.head.slice(0, 400))?.[1] || "";
      // 响应 ID 和实际用的型号：response.created / response.completed 里都带着整个 response 对象
      if (!current.responseId && message.responseId && /^response\.(created|in_progress|completed|failed|incomplete)$/.test(type)) { current.responseId = message.responseId; current.returned = message.model || ""; }
      if (!current.genAt && type === "response.output_item.added") current.genAt = message.startAt;
      if (!current.firstTokenAt && /\.delta$/.test(type)) current.firstTokenAt = message.startAt;
      if (!/^(response\.(completed|failed|incomplete)|error)$/.test(type)) return;
      // 用量优先用边收边找到的那一整段（见 ws-sniff.ts 的 Grab）；没有再退回到从开头结尾那一截里找
      const text = whole(message), usage = message.usage ?? sniffUsage(text);
      const counts = { input: usage.input, output: usage.output, ...(usage.cacheRead != null ? { cacheRead: usage.cacheRead } : {}) };
      if (type === "response.completed") closeTurn(200, message.endAt, { ...counts, ...speedOf(usage.output, message.endAt - (current.genAt || current.firstAt)) });
      else closeTurn(Number(/"status"\s*:\s*([45]\d\d)\b/.exec(text)?.[1]) || 500, message.endAt, { ...counts, error: (jsonField(text, "message") || type).slice(0, 300) });
    }, true);
    if (head.length) { up.write(head); fromClient.push(head); }
    if (upHead.length) { socket.write(upHead); fromServer.push(upHead); }
    socket.on("data", (chunk: Buffer) => fromClient.push(chunk));
    up.on("data", (chunk: Buffer) => fromServer.push(chunk));
    socket.pipe(up);
    up.pipe(socket);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      // 让已经到了、还在解压的最后一条消息有机会记下来
      setTimeout(() => { closeTurn(499, Date.now(), { error: "连接在回复完成前关闭" }); fromClient.stop(); fromServer.stop(); }, 200);
      up.destroy(); socket.destroy();
    };
    for (const side of [socket, up]) { side.on("close", close); side.on("error", close); }
  });
  const fail = (status: number, message: string) => {
    if (settled) return;
    settled = true;
    refuse(status, status === 504 ? "Gateway Timeout" : "Bad Gateway");
    log(entry({ status, ms: Date.now() - opened, error: message }));
  };
  upstreamReq.on("error", (error) => fail(502, describeNetError(error, Boolean(proxy))));
  upstreamReq.on("timeout", () => { if (!settled) { upstreamReq.destroy(); fail(504, "上游超时"); } });
  socket.once("close", () => { if (!settled) upstreamReq.destroy(); });
  upstreamReq.end();
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
