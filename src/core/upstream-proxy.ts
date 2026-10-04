import http from "http";
import https from "https";
import tls from "tls";
import type { Duplex } from "stream";

/*
 * 本地路由（和「获取模型列表」「检测地址」）往上游发请求时走代理。
 *
 * 起因：需要代理才能访问官方接口的机器上，CLI 自己和 TokenPulse 查额度（curl）都会走代理，
 * 而本地路由用的是 Node 的 https.request——它**不看** HTTPS_PROXY 这类环境变量，也不看系统代理，一律直连。
 * 结果号池 / 本地路由的每个成员都是连接超时（约 21 秒一个），转发记录里一排 502，看起来像账号坏了。
 *
 * 取代理的顺序：
 * 1. 环境变量（和 curl 一样）：https 目标看 HTTPS_PROXY / ALL_PROXY，http 目标看 HTTP_PROXY / ALL_PROXY；NO_PROXY 里列的不走；
 * 2. 没有就问系统代理（主进程用 Electron 的 session.resolveProxy 注入，见 setSystemProxyResolver）；
 * 3. 都没有：直连。本机地址（127.0.0.1 / localhost）永远直连。
 * 只支持 HTTP 代理（http://host:port，可带用户名密码）：https 目标用 CONNECT 建隧道，TLS 仍然是和上游端到端的，代理看不到内容。
 * SOCKS 代理暂不支持（按直连处理）。不引入第三方依赖。
 */
export type UpstreamProxy = { host: string; port: number; auth?: string };
type Resolver = (url: string) => Promise<string>;

let systemResolver: Resolver | null = null;
const systemCache = new Map<string, { at: number; proxy: UpstreamProxy | null }>();
const SYSTEM_TTL_MS = 30_000;

/** 主进程注入：问系统代理（返回 PAC 风格的字符串，如 "PROXY 127.0.0.1:7890; DIRECT"）。传 null 取消。 */
export function setSystemProxyResolver(resolver: Resolver | null) { systemResolver = resolver; systemCache.clear(); }

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i;

function parseProxy(value: string | undefined): UpstreamProxy | null {
  const raw = (value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    if (url.protocol !== "http:") return null; // https:// 和 socks 代理暂不支持
    const port = Number(url.port) || 80;
    const auth = url.username ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}` : undefined;
    return url.hostname ? { host: url.hostname, port, ...(auth ? { auth } : {}) } : null;
  } catch { return null; }
}

/** NO_PROXY：逗号分隔的主机名 / 后缀（.example.com、example.com、*.example.com），`*` 表示全部不走代理。端口写了就要对上。 */
function bypassed(target: URL, noProxy: string | undefined) {
  const host = target.hostname.toLowerCase(), port = target.port || (target.protocol === "https:" ? "443" : "80");
  for (const item of (noProxy || "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean)) {
    if (item === "*") return true;
    const [name, itemPort] = item.replace(/^\*?\./, "").split(":");
    if (itemPort && itemPort !== port) continue;
    if (host === name || host.endsWith("." + name)) return true;
  }
  return false;
}

/** 按环境变量选代理（大小写两种写法都认，和 curl 一致）。 */
export function envProxyFor(target: URL, env: NodeJS.ProcessEnv = process.env): UpstreamProxy | null {
  if (LOOPBACK.test(target.hostname)) return null;
  const pick = (...names: string[]) => names.map((name) => env[name] || env[name.toLowerCase()]).find(Boolean);
  if (bypassed(target, pick("NO_PROXY"))) return null;
  return parseProxy(target.protocol === "https:" ? pick("HTTPS_PROXY", "ALL_PROXY") : pick("HTTP_PROXY", "ALL_PROXY"));
}

/** 系统代理返回的 "PROXY h:p; DIRECT" 里第一个能用的。 */
export function parsePacResult(result: string): UpstreamProxy | null {
  for (const part of String(result || "").split(";").map((item) => item.trim())) {
    if (/^DIRECT$/i.test(part)) return null;
    const hit = /^(?:PROXY|HTTP)\s+(.+)$/i.exec(part);
    if (hit) { const proxy = parseProxy(hit[1]); if (proxy) return proxy; }
  }
  return null;
}

/** 环境变量里有没有给这种目标设代理（不管是什么类型的代理）。 */
export function envHasProxy(target: URL, env: NodeJS.ProcessEnv = process.env) {
  const has = (...names: string[]) => names.some((name) => (env[name] || env[name.toLowerCase()] || "").trim());
  return target.protocol === "https:" ? has("HTTPS_PROXY", "ALL_PROXY") : has("HTTP_PROXY", "ALL_PROXY");
}

/** 问系统代理（带缓存）。NO_PROXY 里列的不问。 */
async function systemProxy(target: URL): Promise<UpstreamProxy | null> {
  if (bypassed(target, process.env.NO_PROXY || process.env.no_proxy) || !systemResolver) return null;
  const key = `${target.protocol}//${target.host}`, cached = systemCache.get(key);
  if (cached && Date.now() - cached.at < SYSTEM_TTL_MS) return cached.proxy;
  let proxy: UpstreamProxy | null = null;
  try { proxy = parsePacResult(await systemResolver(key + "/")); } catch { proxy = null; }
  if (systemCache.size > 64) systemCache.clear();
  systemCache.set(key, { at: Date.now(), proxy });
  return proxy;
}

/** 这个上游地址该走哪个代理（null = 直连）：先环境变量，再系统代理。给 Node 自己发的请求用。 */
export async function proxyFor(target: URL): Promise<UpstreamProxy | null> {
  if (LOOPBACK.test(target.hostname)) return null;
  return envProxyFor(target) ?? (envHasProxy(target) ? null : systemProxy(target));
}

/**
 * 给 curl 用：curl 自己会读环境变量里的代理，但**不读 Windows 的系统代理**。
 * 环境变量里没设代理、而系统代理开着时，返回要加的 `--proxy` 参数；其余情况返回空数组（让 curl 按自己的规则来）。
 * 这样「只开了系统代理」的机器上，查额度、续期登录、出口检测、IP 数据库查询也都走代理。
 */
export async function curlProxyArgs(url: string): Promise<string[]> {
  let target: URL;
  try { target = new URL(url); } catch { return []; }
  if (LOOPBACK.test(target.hostname) || envHasProxy(target)) return [];
  const proxy = await systemProxy(target);
  return proxy ? ["--proxy", `http://${proxy.host}:${proxy.port}`] : [];
}

/** 经 HTTP 代理的 CONNECT 隧道连 https 上游。每个请求一条连接（不复用），和原来直连时的行为一致。 */
class TunnelAgent extends https.Agent {
  constructor(private readonly proxy: UpstreamProxy) { super({ keepAlive: false }); }
  createConnection(options: { host?: string | null; port?: number | string | null; servername?: string }, callback?: (error: Error | null, socket: Duplex) => void): Duplex | null | undefined {
    const host = String(options.host || ""), authority = `${host}:${options.port || 443}`;
    const done = callback as (error: Error | null, socket?: Duplex) => void;
    const connect = http.request({ host: this.proxy.host, port: this.proxy.port, method: "CONNECT", path: authority, headers: { host: authority, ...(this.proxy.auth ? { "proxy-authorization": this.proxy.auth } : {}) }, timeout: 15_000 });
    connect.once("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); done(new Error(`代理 ${this.proxy.host}:${this.proxy.port} 拒绝了连接（HTTP ${res.statusCode}）`)); return; }
      const secure = tls.connect({ socket, servername: options.servername || host, ALPNProtocols: ["http/1.1"] });
      done(null, secure);
    });
    connect.once("timeout", () => connect.destroy(new Error(`连接代理 ${this.proxy.host}:${this.proxy.port} 超时`)));
    connect.once("error", (error) => done(new Error(`连不上代理 ${this.proxy.host}:${this.proxy.port}：${describeNetError(error)}`)));
    connect.end();
    return undefined;
  }
}

/**
 * 发上游请求：有代理就走代理，没有就直连。用法和 http(s).request(url, options, callback) 一样。
 */
export function upstreamRequest(target: URL, proxy: UpstreamProxy | null, options: http.RequestOptions, callback?: (res: http.IncomingMessage) => void): http.ClientRequest {
  if (!proxy) return (target.protocol === "https:" ? https : http).request(target, options, callback);
  if (target.protocol === "https:") return https.request(target, { ...options, agent: new TunnelAgent(proxy) }, callback);
  // 明文 http 上游：把完整地址交给代理
  return http.request({ ...options, host: proxy.host, port: proxy.port, path: target.href, headers: { ...(options.headers as http.OutgoingHttpHeaders), host: target.host, ...(proxy.auth ? { "proxy-authorization": proxy.auth } : {}) } }, callback);
}

/**
 * 网络错误说人话。Node 同时试 IPv4 / IPv6 都失败时抛的是 AggregateError，message 是空的——
 * 以前转发记录里的错误原因就是一片空白。
 */
export function describeNetError(error: unknown, viaProxy = false): string {
  const e = error as { message?: string; code?: string; errors?: Array<{ code?: string; message?: string }> } | null;
  const code = e?.code || e?.errors?.find((item) => item?.code)?.code || "";
  const hint = viaProxy ? "" : "（没有走代理；需要代理的话，请打开系统代理或设置 HTTPS_PROXY 环境变量后重启 TokenPulse）";
  if (code === "ETIMEDOUT" || code === "ENETUNREACH" || code === "EHOSTUNREACH") return `连接上游超时${hint}`;
  if (code === "ECONNREFUSED") return `上游拒绝了连接${hint}`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `找不到上游的地址（DNS 解析失败）${hint}`;
  if (code === "ECONNRESET") return "上游中途断开了连接";
  return e?.message || e?.errors?.map((item) => item?.message).filter(Boolean).join("；") || code || "上游连接失败";
}
