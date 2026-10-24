import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { errorText, log, logUrl } from "./app-log";
import { curlProxyArgs } from "./upstream-proxy";

/**
 * 走系统 curl 发请求。为什么不用 Node 的 fetch：这几家官方接口对 TLS 指纹和 HTTP/2 比较挑，
 * fetch 经常被挡；curl 在 Windows 10+ 和 macOS 自带。额度查询和 OAuth 续期共用。
 *
 * 代理：curl 自己读环境变量（HTTPS_PROXY 等），但不读 Windows 的系统代理。环境变量里没有时，
 * 由 curlProxyArgs 按系统代理补一个 --proxy（见 upstream-proxy.ts），不然「只开了系统代理」的机器上这些请求全是直连。
 *
 * 每个请求在统一日志（app-log.ts）里记一行：方法、域名+路径、状态码、耗时；失败记 curl 自己的报错。不记请求头和请求体。
 */

const execFileAsync = promisify(execFile);

export function curlBin() {
  return process.platform === "win32" ? "curl.exe" : "curl";
}

/**
 * 官方回了 4xx / 5xx（401 / 403 另算登录失效，抛 "auth"）。message 保持 `http 状态码`，老代码按它判断。
 * 429 时 retryAfterMs 是官方 Retry-After 要求等的毫秒数（没给就没有）。
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
    /** 官方 JSON 里的错误类型，比如 rate_limit_error。 */
    readonly errorType?: string,
  ) {
    super(`http ${status}`);
  }
}

/** Retry-After 是秒数或 HTTP 日期。 */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  const text = (value || "").trim();
  if (!text) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * `-D -` 把响应头写在正文前面。经代理时前面还有一段 CONNECT 的「200 Connection established」，
 * 所以一段一段剥，留最后一段的头。
 */
export function splitHeaders(raw: string): { headers: Record<string, string>; body: string } {
  let rest = raw;
  let headers: Record<string, string> = {};
  while (/^HTTP\/[\d.]+ \d{3}/.test(rest)) {
    const end = rest.search(/\r?\n\r?\n/);
    if (end < 0) break;
    const block = rest.slice(0, end);
    rest = rest.slice(end).replace(/^\r?\n\r?\n/, "");
    headers = {};
    for (const line of block.split(/\r?\n/).slice(1)) {
      const cut = line.indexOf(":");
      if (cut > 0) headers[line.slice(0, cut).trim().toLowerCase()] = line.slice(cut + 1).trim();
    }
  }
  return { headers, body: rest };
}

function errorTypeOf(json: unknown): string | undefined {
  const row = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  const nested = row?.error && typeof row.error === "object" ? (row.error as Record<string, unknown>) : null;
  const type = nested?.type ?? nested?.code ?? (typeof row?.error === "string" ? row.error : undefined);
  return typeof type === "string" ? type.slice(0, 40) : undefined;
}

export async function curlJson(url: string, headers: string[], timeout = 15000) {
  const args = ["-sS", "-m", "12", "--http1.1", ...(await curlProxyArgs(url)), "-D", "-", "-w", "\n%{http_code}", url];
  for (const header of headers) args.push("-H", header);
  const started = Date.now();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(curlBin(), args, {
      timeout,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    }));
  } catch (error) {
    log.warn("net", `GET ${logUrl(url)} 失败（${Date.now() - started} ms）：${errorText(error)}`);
    throw error;
  }
  const ms = Date.now() - started;
  const cut = stdout.lastIndexOf("\n");
  const status = Number(cut >= 0 ? stdout.slice(cut + 1).trim() : "");
  const { headers: got, body } = splitHeaders(cut >= 0 ? stdout.slice(0, cut) : stdout);
  const text = body.trim();
  const isJson = text.startsWith("{") || text.startsWith("[");
  let json: Record<string, unknown> | undefined;
  try {
    if (isJson) json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 下面按「不是 JSON」处理
  }
  const type = errorTypeOf(json);
  const retryAfterMs = parseRetryAfter(got["retry-after"]);
  const note = [type, retryAfterMs != null ? `Retry-After ${Math.round(retryAfterMs / 1000)} 秒` : "", json || !text ? "" : `返回的不是 JSON（${got["content-type"] || "没有类型"}，${text.length} 字节）`]
    .filter(Boolean)
    .join("，");
  const line = `GET ${logUrl(url)} → ${Number.isFinite(status) ? status : "?"}（${ms} ms）${note ? ` ${note}` : ""}`;
  if (Number.isFinite(status) && status >= 400) log.warn("net", line);
  else log.info("net", line);
  if (status === 401 || status === 403) throw new Error("auth");
  if (Number.isFinite(status) && status >= 400) throw new HttpError(status, retryAfterMs, type);
  if (!json) throw new Error("not json");
  return json;
}

/**
 * POST 一段请求体，返回 HTTP 状态码和解析后的 JSON。
 * 请求体从 stdin 喂给 curl（`--data-binary @-`），不放进命令行参数：
 * 里面是 refresh token，命令行对本机其它进程是可见的。
 */
export async function curlPost(url: string, body: string, headers: string[], timeoutMs = 25_000): Promise<{ status: number; json: any }> {
  const proxyArgs = await curlProxyArgs(url);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const args = ["-sS", "-m", "20", "--http1.1", ...proxyArgs, "-X", "POST", url, "--data-binary", "@-", "-w", "\n%{http_code}"];
    for (const header of headers) args.push("-H", header);
    const proc = spawn(curlBin(), args, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const fail = (error: Error) => {
      log.warn("net", `POST ${logUrl(url)} 失败（${Date.now() - started} ms）：${errorText(error)}`);
      reject(error);
    };
    proc.stdout.on("data", (chunk) => { out += chunk; });
    proc.stderr.on("data", (chunk) => { err += chunk; });
    proc.once("error", (error) => { clearTimeout(timer); fail(error); });
    proc.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { fail(new Error(err.trim() || `curl 退出码 ${code}`)); return; }
      const cut = out.lastIndexOf("\n");
      const status = Number(out.slice(cut + 1));
      let json: any = null;
      try { json = JSON.parse(out.slice(0, cut)); } catch { /* 非 JSON 响应按 null 处理 */ }
      const type = errorTypeOf(json);
      const line = `POST ${logUrl(url)} → ${status}（${Date.now() - started} ms）${type ? ` ${type}` : ""}`;
      if (status >= 400) log.warn("net", line);
      else log.info("net", line);
      resolve({ status, json });
    });
    proc.stdin.end(body);
  });
}
