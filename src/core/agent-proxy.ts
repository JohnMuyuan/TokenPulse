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
import { StringDecoder } from "string_decoder";
import type { Duplex } from "stream";
import { clientError, convertJsonResponse, convertRequest, StreamBridge } from "./agent-convert";
import { NATIVE_UPSTREAM, type AgentApp, type ProxyTarget, type Upstream } from "./agent-types";
import { describeNetError, proxyFor, staleReuse, uncertainDelivery, upstreamRequest } from "./upstream-proxy";
import { Grab } from "./ws-sniff";
import { concurrencyMonitor, isInference, providerScopes, transparentScopes } from './concurrency';
import WebSocket, { WebSocketServer } from 'ws';
import { websocketAgent } from './upstream-proxy';
import type { Socket } from 'net';

export type ProxyLog = {
  id?: string;
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
  /*
   * 速度（0.3.35 透明转发先有，0.3.36 起本地路由——第三方供应商、号池——也量：这些请求本来就经过 TokenPulse）。
   * firstByteMs：从把请求发给上游到收到回复第一个字节；firstTokenMs：到回复里第一段内容（文字、思考或工具调用的增量）出现；
   * tokensPerSec：输出 Token ÷ 出字用的时间，每秒多少 Token，输出太少或读不到用量时没有。
   * 本地路由里一个请求换了几个成员时，每次尝试各算各的（从这次尝试发出去算起）。
   */
  firstByteMs?: number;
  firstTokenMs?: number;
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
    const json = JSON.parse(body.toString("utf8")) as { model?: unknown; reasoning?: { effort?: unknown }; reasoning_effort?: unknown; output_config?: { effort?: unknown }; service_tier?: unknown; speed?: unknown };
    // OpenAI 的 reasoning.effort / reasoning_effort；Anthropic Messages 的 output_config.effort（Claude Code 的 /effort）
    const effort = json?.reasoning?.effort ?? json?.reasoning_effort ?? json?.output_config?.effort;
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
  // Count physical client connections from accept, before a request body or
  // WebSocket upgrade arrives. Later request attribution reuses this entry.
  server.on('connection', socket => concurrencyMonitor.trackSocket(socket, 'clients', []));

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
      concurrencyMonitor.trackSocket(req.socket, 'clients', transparentScopes(app, req.headers));
      stats.active += 1; stats.requests += 1;
      try {
        const entry = await forwardPass(req, res, app, (passed[2] || "/") + url.search, base, await readBody(req));
        const ok = entry.status < 400 && !entry.error;
        if (ok) stats.ok += 1;
        // Grok 每轮还有十几个附带请求（/storage、/signals、/settings…），成功的不记，免得淹没对话请求
        if (!ok || app !== "grok" || GROK_INFERENCE.test(entry.path || "")) options.log(entry);
      }
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
    concurrencyMonitor.trackSocket(req.socket, 'clients', []);
    const body = await readBody(req);
    if (res.destroyed) return;
    const inference = isInference(req.method, routed.rest);
    const admission = inference ? concurrencyMonitor.admit([]) : null;
    if (admission && 'error' in admission) { sendError(res, client, 429, `TokenPulse concurrency limit: ${admission.error.label} (${admission.error.limit})`); return; }
    const releaseGlobal = () => admission && 'release' in admission && admission.release();
    res.once('close', releaseGlobal);
    const started = Date.now();
    stats.active += 1;
    stats.requests += 1;
    let last = "上游没有响应";
    let limiting: import('./concurrency').ConcurrencyAlert | undefined;
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
        if (res.destroyed) return;
        const scopes = providerScopes(routed.app, target);
        const member = inference ? concurrencyMonitor.admit(scopes, false, false) : null;
        if (member && 'error' in member) { limiting = member.error; last = `TokenPulse concurrency limit: ${member.error.label} (${member.error.limit})`; continue; }
        limiting = undefined;
        concurrencyMonitor.trackSocket(req.socket, 'clients', scopes);
        const releaseMember = () => member && 'release' in member && member.release();
        res.once('close', releaseMember);
        attempt += 1;
        let outcome: Outcome;
        try { outcome = await forward(req, res, routed.app, routed.rest + url.search, client, target, body); }
        finally { res.off('close', releaseMember); releaseMember(); }
        if (outcome.kind === "done") {
          options.succeed(target.id);
          stats.ok += 1;
          options.log({ at: Date.now(), app: routed.app, providerId: target.id, provider: target.name, model: target.model, status: outcome.status, ms: (outcome.endAt ?? Date.now()) - started, input: outcome.input, output: outcome.output, ...(outcome.cacheRead != null ? { cacheRead: outcome.cacheRead } : {}), ...returnedOf({ responseId: outcome.responseId, model: outcome.returnedModel }), ...(outcome.timing ?? {}), ...(target.officialAccount ? { account: target.officialAccount } : {}), ...detail(target) });
          return;
        }
        options.fail(target.id);
        last = outcome.error;
        options.log({ at: Date.now(), app: routed.app, providerId: target.id, provider: target.name, model: target.model, status: outcome.status, ms: Date.now() - started, error: outcome.error, ...detail(target) });
        if (outcome.terminal || res.headersSent || res.destroyed) {
          if (!res.headersSent && !res.destroyed) sendError(res, client, outcome.status, outcome.error);
          return;
        }
      }
      if (!res.headersSent && !res.destroyed) { if (limiting) concurrencyMonitor.recordRejectedRequest(limiting); sendError(res, client, limiting ? 429 : 502, last); }
    } finally {
      res.off('close', releaseGlobal); releaseGlobal();
      stats.active = Math.max(0, stats.active - 1);
    }
  }

  // Message-aware transparent relay; authentication and application payloads are preserved.
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
      concurrencyMonitor.closeSockets();
      server.close(() => { concurrencyMonitor.clear(); resolve(); });
      server.closeAllConnections();
      for (const socket of tunnels) socket.destroy();
    }),
  };
}

function sendError(res: http.ServerResponse, client: Upstream, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(clientError(client, message)));
}

type Timing = { firstByteMs?: number; firstTokenMs?: number; tokensPerSec?: number };
type Outcome = { kind: "done"; status: number; input?: number; output?: number; cacheRead?: number; responseId?: string; returnedModel?: string; timing?: Timing; endAt?: number } | { kind: "fail"; status: number; error: string; terminal?: boolean };

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
      return { kind: "fail", status: 400, error: "无法转换请求" };
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
  if (res.destroyed) return { kind: 'fail', status: 499, error: '客户端连接已关闭', terminal: true };
  const watch = stopwatch();
  return new Promise((resolve) => {
    let done = false;
    let observer: ReturnType<typeof bodyObserver> | null = null;
    const finish = (outcome: Outcome) => {
      if (done) return;
      done = true;
      res.off('close', clientClosed);
      observer?.destroy();
      resolve(outcome);
    };
    const incomplete = (status: number, error: string, uncertain = false) => {
      finish({ kind: "fail", status, error, terminal: uncertain || res.headersSent });
      if (res.headersSent && !res.writableEnded) res.destroy();
    };
    const clientClosed = () => {
      // 转换 / 解压的完成回调可能晚于 res.end() 触发的正常 close。
      if (res.writableEnded) return;
      finish({ kind: 'fail', status: 499, error: '客户端连接已关闭', terminal: true });
      upstreamReq.destroy();
    };
    let upstreamReq: http.ClientRequest, responded = false, resent = false;
    const onResponse = (upstreamRes: http.IncomingMessage) => {
      responded = true;
      const status = upstreamRes.statusCode || 502;
      upstreamRes.once("aborted", () => incomplete(502, "回复中途断开"));
      upstreamRes.on("error", () => incomplete(502, "回复中途断开"));
      // 号池成员：401 / 403 多半是这个账号的登录失效或没权限，换下一个成员
      if (status === 429 || status >= 500 || (target.pool && (status === 401 || status === 403))) {
        // 错误正文可能回显提示词 / 凭据，不进日志，也不用为了重试保存在内存。
        upstreamRes.resume();
        upstreamRes.on("end", () => finish({ kind: "fail", status, error: `HTTP ${status}` }));
        return;
      }
      const contentType = String(upstreamRes.headers["content-type"] || "");
      if (!same && (stream || contentType.includes("text/event-stream") || contentType.includes("application/json"))) {
        void pipeConverted(upstreamRes, res, client, target, stream || contentType.includes("event-stream"), watch).then(finish).catch(() => incomplete(502, "无法转换响应"));
        return;
      }
      const out: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) if (value != null && !PASS_HOP.has(key.toLowerCase())) out[key] = value;
      out["content-type"] = contentType || "application/json";
      res.writeHead(status, out);
      const seen = { head: "", tail: "" };
      const grab = new Grab();
      observer = bodyObserver(String(upstreamRes.headers["content-encoding"] || ""), (text) => {
        watch.see(text); keepEdges(seen, text); grab.feed(text);
      });
      upstreamRes.on("data", (chunk) => {
        observer?.write(chunk);
        res.write(chunk);
      });
      upstreamRes.on("end", () => {
        res.off('close', clientClosed);
        res.end();
        // 总耗时到回复收完为止，不含旁路解压收尾的时间
        const endAt = Date.now();
        observer!.end(() => {
          if (status >= 400) { finish({ kind: "fail", status, error: `HTTP ${status}`, terminal: true }); return; }
          const usage = grab.usage ?? sniffUsage(seen.head.length < SNIFF_EDGE ? seen.head : seen.head + "\n" + seen.tail);
          finish({ kind: "done", status, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, ...(grab.responseId ? { responseId: grab.responseId, returnedModel: grab.model || undefined } : {}), timing: watch.result(usage.output, status, endAt), endAt });
        });
      });
    };
    const send = () => {
      const sent = upstreamReq = upstreamRequest(upstream, proxy, { method: req.method || "POST", headers, timeout: 120_000 }, onResponse);
      concurrencyMonitor.observeRequest(sent, providerScopes(app, target));
      sent.on("error", (error) => {
        // 复用的连接已经被关掉：换条新连接再发一次（见 staleReuse）
        if (!resent && !responded && !done && staleReuse(sent, error)) { resent = true; send(); return; }
        incomplete(502, describeNetError(error, Boolean(proxy)), uncertainDelivery(sent, error));
      });
      sent.on("timeout", () => {
        incomplete(504, "上游超时", sent.method !== "GET" && sent.method !== "HEAD");
        sent.destroy();
      });
      if (payload.length && req.method !== "GET" && req.method !== "HEAD") sent.write(payload);
      sent.end();
    };
    res.once('close', clientClosed);
    send();
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
const GROK_INFERENCE = /\/(responses|chat\/completions|messages)$/;
const PASS_NAME = "官方登录（透明转发）";
const SPEED_MIN_OUTPUT = 20;
/** 回复里第一段内容：Claude 的 content_block_delta，OpenAI Responses 的 response.….delta。 */
const FIRST_TOKEN = /content_block_delta|"response\.[a-z_.]+\.delta"|"delta"\s*:\s*\{/;
/*
 * 模型从什么时候开始出字：
 * - Claude：回复的第一个字节（message_start）就是，官方处理完输入才会发它；
 * - OpenAI Responses（Codex）：response.created 一收到请求就发，这时还没开始算；第一个 response.output_item.added 才是开始出字
 *   （真机量过：created 在 0.4 秒，output_item.added 和第一段文字在 1.9 秒）。
 * 所以回复里出现过 output_item.added 就从它算起，没有就从第一个字节算起。
 */
const GEN_START = /"response\.output_item\.added"/;
/** 一次转发的计时：从现在（请求马上要发给上游）算起，每收到一段回复看一眼。本地路由用；透明转发的两条路各自内联了同样的逻辑。 */
function stopwatch() {
  const started = Date.now();
  let firstAt = 0, genAt = 0, firstTokenAt = 0;
  return {
    see(text: string) {
      const now = Date.now();
      if (!firstAt) firstAt = now;
      if (!genAt && GEN_START.test(text)) genAt = now;
      if (!firstTokenAt && FIRST_TOKEN.test(text)) firstTokenAt = now;
    },
    result(output: number | undefined, status: number, end = Date.now()): Timing {
      return { ...(firstAt ? { firstByteMs: firstAt - started } : {}), ...(firstTokenAt ? { firstTokenMs: firstTokenAt - started } : {}), ...(firstAt && status < 400 ? speedOf(output, end - (genAt || firstAt)) : {}) };
    },
  };
}
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
/** 解压只用于旁路统计；结束 / 失败 / 取消都释放解压器和超时句柄。 */
function bodyObserver(encoding: string, look: (text: string) => void) {
  const decoder = passDecoder(encoding.trim().toLowerCase());
  const utf8 = new StringDecoder("utf8");
  const plain = !encoding;
  let failed = false, settled = false;
  let timer: NodeJS.Timeout | null = null;
  let callback: (() => void) | null = null;
  const settle = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    timer = null;
    look(utf8.end());
    callback?.();
  };
  decoder?.on("data", (chunk: Buffer) => look(utf8.write(chunk)));
  decoder?.on("error", () => { failed = true; if (callback) settle(); });
  return {
    write(chunk: Buffer) { if (plain) look(utf8.write(chunk)); else if (!failed) decoder?.write(chunk); },
    end(done: () => void) {
      callback = done;
      if (!decoder || failed) { settle(); return; }
      decoder.once("end", settle);
      timer = setTimeout(settle, 1000);
      decoder.end();
    },
    destroy() { if (timer) clearTimeout(timer); timer = null; decoder?.destroy(); callback = null; },
  };
}
export async function forwardPass(req: http.IncomingMessage, res: http.ServerResponse, app: AgentApp, rest: string, base: string, body: Buffer): Promise<ProxyLog> {
  const scopes = transparentScopes(app, req.headers);
  concurrencyMonitor.trackSocket(req.socket, 'clients', scopes);
  const admission = isInference(req.method, rest) ? concurrencyMonitor.admit(scopes) : null;
  if (admission && 'error' in admission) {
    const message = `TokenPulse concurrency limit: ${admission.error.label} (${admission.error.limit})`;
    res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'concurrency_limit', message } }));
    return { at: Date.now(), app, providerId: 'pass-' + app, provider: '透明转发', model: '', status: 429, ms: 0, pass: true, error: message };
  }
  const release = () => admission && 'release' in admission && admission.release();
  res.once('close', release);
  try { return await forwardPassBody(req, res, app, rest, base, body); }
  finally { res.off('close', release); release(); }
}
async function forwardPassBody(req: http.IncomingMessage, res: http.ServerResponse, app: AgentApp, rest: string, base: string, body: Buffer): Promise<ProxyLog> {
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
  if (res.destroyed) return entry({ status: 499, error: '客户端连接已关闭' });
  return new Promise((resolve) => {
    let done = false;
    let observer: ReturnType<typeof bodyObserver> | null = null;
    const finish = (extra: Partial<ProxyLog>) => { if (done) return; done = true; res.off("close", clientClosed); observer?.destroy(); resolve(entry(extra)); };
    const clientClosed = () => { upstreamReq.destroy(); finish({ status: 499, error: "客户端连接已关闭" }); };
    res.once("close", clientClosed);
    let upstreamReq: http.ClientRequest, responded = false, resent = false;
    const onResponse = (upstreamRes: http.IncomingMessage) => {
      responded = true;
      const status = upstreamRes.statusCode || 502;
      const out: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) if (value != null && !PASS_HOP.has(key.toLowerCase())) out[key] = value;
      res.writeHead(status, out);
      let firstAt = 0, firstTokenAt = 0, genAt = 0, bytes = 0;
      const seen = { head: "", tail: "" };
      const grab = new Grab();
      const look = (text: string) => { grab.feed(text); if (!genAt && GEN_START.test(text)) genAt = Date.now(); if (!firstTokenAt && FIRST_TOKEN.test(text)) firstTokenAt = Date.now(); keepEdges(seen, text); };
      observer = bodyObserver(String(upstreamRes.headers["content-encoding"] || ""), look);
      upstreamRes.on("data", (chunk: Buffer) => {
        if (!firstAt) firstAt = Date.now();
        bytes += chunk.length;
        res.write(chunk);
        observer?.write(chunk);
      });
      upstreamRes.on("end", () => {
        // 回复已经完整送回去了：这之后工具关连接是正常收尾，不算「客户端中途关闭」
        res.off("close", clientClosed);
        res.end();
        const endAt = Date.now();
        const settle = () => {
          const usage = grab.usage ?? sniffUsage(seen.head.length < SNIFF_EDGE ? seen.head : seen.head + "\n" + seen.tail);
          const writing = firstAt ? endAt - (genAt || firstAt) : 0;
          finish({ status, ms: endAt - started, responseBytes: bytes, ...(firstAt ? { firstByteMs: firstAt - started } : {}), ...(firstTokenAt ? { firstTokenMs: firstTokenAt - started } : {}), input: usage.input, output: usage.output, ...(usage.cacheRead != null ? { cacheRead: usage.cacheRead } : {}),
            ...(status < 400 ? { ...speedOf(usage.output, writing), ...returnedOf(grab) } : {}),
            ...(status >= 400 ? { error: `HTTP ${status}` } : {}) });
        };
        observer!.end(settle);
      });
      upstreamRes.on("error", () => { res.destroy(); finish({ status: 502, error: "回复中途断开", responseBytes: bytes, ...(firstAt ? { firstByteMs: firstAt - started } : {}) }); });
    };

    const fail = (status: number, message: string) => {
      if (!res.headersSent) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "TokenPulse pass-through: " + message } })); }
      else res.destroy();
      finish({ status, error: message });
    };
    // 仅 GET / HEAD 的失效复用连接可重发；POST 的交付状态未知，照常返回错误。
    const send = () => {
      const sent = upstreamReq = upstreamRequest(upstream, proxy, { method: req.method || "POST", headers: headers as http.OutgoingHttpHeaders, timeout: 600_000 }, onResponse);
      concurrencyMonitor.observeRequest(sent, transparentScopes(app, req.headers));
      sent.on("error", (error) => {
        if (!resent && !responded && !done && staleReuse(sent, error)) { resent = true; send(); return; }
        fail(502, describeNetError(error, Boolean(proxy)));
      });
      sent.on("timeout", () => { sent.destroy(); fail(504, "上游超时"); });
      sent.end(body.length ? body : undefined);
    };
    send();
  });
}

/* Each WebSocket peer owns its compression context. Admission can drop one
 * create event without invalidating subsequent compressed messages. Ordered
 * lanes include warm-ups for correlation, but only inference turns reserve
 * capacity or contribute usage/speed logs. */
const TUNNEL_DROP = new Set(["host", "content-length", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "trailers", "transfer-encoding"]);
export async function tunnelPass(req: http.IncomingMessage, socket: Duplex, head: Buffer, app: AgentApp, rest: string, base: string, log: (entry: ProxyLog) => void) {
  const refuse = (status: number, text: string) => { if (!socket.destroyed) socket.end('HTTP/1.1 ' + status + ' ' + text + '\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); };
  let upstream: URL;
  try { upstream = joinUpstream(base, rest); } catch { refuse(502, 'Bad Gateway'); return; }
  const scopes = transparentScopes(app, req.headers);
  concurrencyMonitor.trackSocket(socket as Socket, 'clients', scopes);
  const path = rest.split('?')[0].slice(0, 200);
  const entry = (extra: Partial<ProxyLog>): ProxyLog => ({ at: Date.now(), app, providerId: 'pass-' + app, provider: PASS_NAME, model: '', status: 0, ms: 0, pass: true, method: 'WS', path, attempt: 1, pool: false, host: upstream.host, stream: true, ...extra });
  const headers: Record<string, string | string[]> = {};
  const owned = new Set([...TUNNEL_DROP, 'connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol']);
  for (const [key, value] of Object.entries(req.headers)) if (value != null && !owned.has(key.toLowerCase())) headers[key] = value;
  const proxy = await proxyFor(upstream);
  if (socket.destroyed) return;
  const compressed = /permessage-deflate/i.test(String(req.headers['sec-websocket-extensions'] || ''));
  const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim()).filter(Boolean);
  const options: WebSocket.ClientOptions = { headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])), perMessageDeflate: compressed, handshakeTimeout: 30_000, maxPayload: 100 * 1024 * 1024, followRedirects: false,
    finishRequest: request => {
      concurrencyMonitor.observeRequest(request, scopes);
      if (proxy && upstream.protocol === 'http:') {
        request.path = upstream.href;
        request.setHeader('host', upstream.host);
        if (proxy.auth) request.setHeader('proxy-authorization', proxy.auth);
      }
      request.end();
    }
  };
  if (proxy && upstream.protocol === 'https:') options.agent = websocketAgent(proxy);
  const address = proxy && upstream.protocol === 'http:' ? 'ws://' + proxy.host + ':' + proxy.port : upstream.href;
  const remote = new WebSocket(address, protocols, options);
  let response: http.IncomingMessage | undefined;
  let local: WebSocket | undefined, server: WebSocketServer | undefined;
  let opened = false, ended = false;
  type Turn = { lane: string; id: string; event: string; inference: boolean; model: string; effort: string; tier: string; started: number; firstAt: number; firstTokenAt: number; genAt: number; bytes: number; requestBytes: number; release: () => void; grab: Grab };
  const lanes = new Map<string, Turn[]>(), byId = new Map<string, Turn>(), byEvent = new Map<string, Turn>();
  const closeTurn = (turn: Turn, status: number, extra: Partial<ProxyLog> = {}) => {
    const queue = lanes.get(turn.lane);
    if (!queue?.includes(turn)) return;
    queue.splice(queue.indexOf(turn), 1); if (!queue.length) lanes.delete(turn.lane);
    if (turn.id) byId.delete(turn.id);
    if (turn.event) byEvent.delete(turn.event);
    turn.release();
    if (!turn.inference) return;
    const endAt = Date.now(), usage = turn.grab.usage;
    log(entry({ at: endAt, model: turn.model, status, ms: endAt - turn.started, requestBytes: turn.requestBytes, responseBytes: turn.bytes,
      ...(turn.model ? { requestModel: turn.model } : {}), ...(turn.effort ? { effort: turn.effort } : {}), ...(turn.tier ? { tier: turn.tier } : {}),
      ...(turn.firstAt ? { firstByteMs: turn.firstAt - turn.started } : {}), ...(turn.firstTokenAt ? { firstTokenMs: turn.firstTokenAt - turn.started } : {}),
      ...(usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, ...(status < 400 ? speedOf(usage.output, endAt - (turn.genAt || turn.firstAt || turn.started)) : {}) } : {}),
      ...returnedOf(turn.grab), ...extra }));
  };
  const close = () => {
    if (ended) return; ended = true;
    for (const queue of [...lanes.values()]) for (const turn of [...queue]) closeTurn(turn, 499, { error: '连接在回复完成前关闭' });
    local?.terminate(); remote.terminate(); server?.close(); socket.destroy();
  };
  socket.once('close', close);
  socket.once('error', close);
  remote.on('error', error => {
    if (!opened && !ended) { refuse(502, 'Bad Gateway'); log(entry({ status: 502, error: describeNetError(error, Boolean(proxy)) })); }
    close();
  });
  remote.once('close', close);
  remote.once('upgrade', res => { response = res; });
  remote.once('unexpected-response', (_request, res) => {
    if (ended) { res.destroy(); return; }
    const status = res.statusCode || 502;
    let raw = 'HTTP/1.1 ' + status + ' ' + res.statusMessage + '\r\n';
    for (let i = 0; i < res.rawHeaders.length; i += 2) if (!['transfer-encoding', 'connection', 'keep-alive'].includes(res.rawHeaders[i].toLowerCase())) raw += res.rawHeaders[i] + ': ' + res.rawHeaders[i + 1] + '\r\n';
    socket.write(raw + 'connection: close\r\n\r\n');
    res.on('data', chunk => socket.write(chunk));
    res.once('end', () => { log(entry({ status, error: 'HTTP ' + status })); socket.end(); });
    res.once('error', close);
  });
  remote.once('open', () => {
    if (ended || socket.destroyed) { close(); return; }
    opened = true;
    server = new WebSocketServer({ noServer: true, perMessageDeflate: compressed, maxPayload: 100 * 1024 * 1024, handleProtocols: () => remote.protocol || false });
    server.on('headers', generated => {
      // Preserve upstream custom headers/casing, but each peer has its own key,
      // negotiated compression context and protocol handshake.
      const replacements = new Map(generated.slice(1).map(line => [line.split(':')[0].toLowerCase(), line]));
      const result = [generated[0]];
      for (let i = 0; i < (response?.rawHeaders.length || 0); i += 2) {
        const name = response!.rawHeaders[i], key = name.toLowerCase();
        if (['sec-websocket-accept', 'sec-websocket-extensions', 'sec-websocket-protocol'].includes(key)) {
          if (replacements.has(key)) result.push(replacements.get(key)!);
        } else result.push(name + ': ' + response!.rawHeaders[i + 1]);
        replacements.delete(key);
      }
      for (const [key, line] of replacements) if (key.startsWith('sec-websocket-')) result.push(line);
      generated.splice(0, generated.length, ...result);
    });
    server.handleUpgrade(req, socket, head, peer => {
      local = peer;
      peer.on('error', close); peer.once('close', close);
      peer.on('message', (data, binary) => {
        if (ended || remote.readyState !== WebSocket.OPEN) return;
        let json: Record<string, any> | null = null;
        if (!binary) { try { json = JSON.parse(data.toString()); } catch { /* non-inference application message */ } }
        if (json?.type === 'response.create') {
          const inference = json.generate !== false;
          const admission = inference ? concurrencyMonitor.admit(scopes) : { release: () => {} };
          if ('error' in admission) {
            const message = 'TokenPulse concurrency limit: ' + admission.error.label + ' (' + admission.error.limit + ')';
            peer.send(JSON.stringify({ type: 'error', status: 429, ...(typeof json.stream_id === 'string' ? { stream_id: json.stream_id } : {}), ...(typeof json.event_id === 'string' ? { event_id: json.event_id } : {}), error: { type: 'concurrency_limit', code: 'tokenpulse_concurrency_limit', message } }));
            log(entry({ status: 429, error: message })); return;
          }
          const lane = typeof json.stream_id === 'string' ? json.stream_id : '';
          const event = typeof json.event_id === 'string' ? json.event_id : '';
          const turn: Turn = { lane, id: '', event, inference, model: String(json.model || '').slice(0, 120), effort: String(json.reasoning?.effort || '').slice(0, 20), tier: tierOf(json.service_tier), started: Date.now(), firstAt: 0, firstTokenAt: 0, genAt: 0, bytes: 0, requestBytes: Buffer.byteLength(data.toString()), release: admission.release, grab: new Grab() };
          const queue = lanes.get(lane) || []; queue.push(turn); lanes.set(lane, queue);
          if (event) byEvent.set(event, turn);
        }
        remote.send(data, { binary }, error => { if (error) close(); });
      });
    });
  });
  remote.on('message', (data, binary) => {
    if (!local || ended) return;
    let json: Record<string, any> | null = null;
    if (!binary) { try { json = JSON.parse(data.toString()); } catch { /* preserve payload */ } }
    const lane = typeof json?.stream_id === 'string' ? json.stream_id : '';
    const id = json?.response?.id || json?.response_id || '';
    const event = json?.error?.event_id || json?.event_id;
    const turn = (id && byId.get(id)) || (event && byEvent.get(event)) || lanes.get(lane)?.[0];
    if (turn && json) {
      const at = Date.now(), text = data.toString(), type = String(json.type || '');
      if (!turn.firstAt) turn.firstAt = at;
      turn.bytes += Buffer.byteLength(data.toString()); turn.grab.feed(text);
      if (id && !turn.id) { turn.id = id; byId.set(id, turn); }
      if (!turn.genAt && type === 'response.output_item.added') turn.genAt = at;
      if (!turn.firstTokenAt && /\.delta$/.test(type)) turn.firstTokenAt = at;
      if (/^response\.(completed|failed|incomplete|cancelled|canceled)$/.test(type) || type === 'error') {
        const status = type === 'response.completed' ? 200 : Number(json.status) || (type.includes('cancel') ? 499 : 500);
        closeTurn(turn, status, status >= 400 ? { error: 'HTTP ' + status + ' · ' + type } : {});
      }
    }
    local.send(data, { binary }, error => { if (error) close(); });
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

function pipeConverted(upstream: http.IncomingMessage, res: http.ServerResponse, client: Upstream, target: ProxyTarget, stream: boolean, watch: ReturnType<typeof stopwatch>) {
  return new Promise<Outcome>((resolve) => {
    const chunks: Buffer[] = [];
    const status = upstream.statusCode || 502;
    const encoding = String(upstream.headers["content-encoding"] || "").trim().toLowerCase();
    const decoder = passDecoder(encoding);
    const input = decoder || upstream;
    let done = false;
    const finish = (outcome: Outcome) => { if (done) return; done = true; decoder?.destroy(); resolve(outcome); };
    const failed = () => {
      if (!res.headersSent) sendError(res, client, 502, "上游回复中途断开或无法解压"); else res.destroy();
      finish({ kind: "fail", status: 502, error: "上游回复中途断开或无法解压", terminal: true });
    };
    upstream.once("aborted", failed);
    upstream.on("error", failed);
    if (decoder) { decoder.on("error", failed); upstream.pipe(decoder); }
    else if (encoding) { upstream.resume(); failed(); return; }
    // 流式客户端也可能收到 JSON 错误，必须先按原状态发错误，而不是无条件开始 200 SSE。
    if (status >= 400) {
      let size = 0;
      input.on("data", (chunk: Buffer) => { if (size < 8000) { const part = chunk.subarray(0, 8000 - size); chunks.push(part); size += part.length; } });
      input.on("end", () => {
        let message = `HTTP ${status}`;
        try { const json = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (typeof json?.error?.message === "string") message = json.error.message; } catch { /* 非 JSON 错误只显示状态 */ }
        // 详细错误只送回发请求的工具；日志里只保留状态，防止错误回显包含内容 / 凭据。
        if (!res.headersSent && !res.destroyed) sendError(res, client, status, message);
        finish({ kind: "fail", status, error: `HTTP ${status}`, terminal: true });
      });
      return;
    }
    const bridge = stream ? new StreamBridge(target.upstream, client, target.model || "model") : null;
    const utf8 = new StringDecoder("utf8");
    if (stream) res.writeHead(status, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    input.on("data", (chunk) => {
      if (done || res.destroyed) return;
      const text = utf8.write(chunk);
      watch.see(text);
      if (bridge) res.write(bridge.push(text));
      else chunks.push(Buffer.from(chunk));
    });
    input.on("end", () => {
      if (done || res.destroyed) return;
      if (bridge) {
        res.write(bridge.push(utf8.end()));
        res.write(bridge.end());
        res.end();
        const usage = bridge.usage();
        finish({ kind: "done", status, input: usage.input, output: usage.output, timing: watch.result(usage.output, status) });
        return;
      }
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        const json = convertJsonResponse(client, target.upstream, payload, target.model || "model");
        const encoded = JSON.stringify(json);
        res.writeHead(upstream.statusCode || 200, { "content-type": "application/json; charset=utf-8" });
        res.end(encoded);
        const usage = sniffUsage(encoded);
        finish({ kind: "done", status, input: usage.input, output: usage.output });
      } catch (error) {
        const message = "无法转换响应";
        if (!res.headersSent) sendError(res, client, 502, message);
        else res.end();
        finish({ kind: "fail", status: 502, error: message, terminal: true });
      }
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
