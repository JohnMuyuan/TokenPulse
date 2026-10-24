import fs from "fs";
import os from "os";
import path from "path";
import { dataDir } from "./paths";

/**
 * 统一运行日志：`~/.tokenpulse/logs/tokenpulse.log`，纯文本，一行一件事。
 *
 * 用户机器上出问题时（额度刷不出、登录失败、路由不通…），界面上只有一句提示，原因事后查不到。
 * 这里记 TokenPulse 自己发的每个请求（方法、域名+路径、状态码、耗时、curl 报错）、界面上的操作、登录过程、
 * 每轮额度查询的结果和主进程的报错。日志是给用户发出来排查用的：
 * **不记请求头、请求体、token、会话正文，链接参数去掉，邮箱打码，家目录换成 ~**，≥32 字符的长串一律隐藏。
 * 超过 MAX_BYTES 轮换成 tokenpulse.1.log / tokenpulse.2.log，最多留 KEEP 份旧的。写日志失败不影响任何功能。
 */

export type LogLevel = "INFO" | "WARN" | "ERROR";

const MAX_BYTES = 4 * 1024 * 1024;
const KEEP = 2;
const MAX_LINE = 600;

export function appLogDir() {
  return path.join(dataDir(), "logs");
}

export function appLogFile() {
  return path.join(appLogDir(), "tokenpulse.log");
}

/** 去掉终端颜色 / 光标控制符。 */
function stripAnsi(text: string) {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export function redactLogText(text: string, home = os.homedir()) {
  let out = stripAnsi(String(text ?? ""));
  if (home) out = out.split(home).join("~").split(home.replace(/\\/g, "/")).join("~");
  return out
    // 授权链接的参数里有 state / code_challenge，回调链接里有授权码；有的接口把 key 放在参数里
    .replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, "$1?…")
    .replace(/(authorization|x-api-key|api-key|cookie)(["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',;]+/gi, "$1$2[已隐藏]")
    .replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g, "$1***@$2")
    // token、refresh token、API key、JWT 之类的长串
    .replace(/[A-Za-z0-9_\-+=.]{32,}/g, (hit) => `[已隐藏 ${hit.length} 字符]`)
    .slice(0, MAX_LINE);
}

/** 只留协议、域名和路径：参数里可能有 key。 */
export function logUrl(url: string | URL) {
  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return redactLogText(String(url)).replace(/[?#].*$/, "");
  }
}

function pad(n: number, width = 2) {
  return String(n).padStart(width, "0");
}

function stamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** 本进程写过的字节数估计：每行都 stat 一次没必要。null＝还没看过文件多大。 */
let size: number | null = null;

function rotate(file: string) {
  for (let i = KEEP; i >= 1; i--) {
    const from = i === 1 ? file : file.replace(/\.log$/, `.${i - 1}.log`);
    const to = file.replace(/\.log$/, `.${i}.log`);
    try {
      if (i === KEEP) fs.rmSync(to, { force: true });
      if (fs.existsSync(from)) fs.renameSync(from, to);
    } catch {
      // 别的进程正开着它：这次不轮换，下次再试
    }
  }
}

/** 测试换数据目录时清掉大小缓存。 */
export function resetAppLogState() {
  size = null;
}

export function appLog(level: LogLevel, category: string, message: string) {
  const lines = String(message).split(/\r?\n/).map((line) => redactLogText(line)).filter((line) => line.trim());
  if (!lines.length) return;
  const head = `${stamp()} ${level.padEnd(5)} [${category}]`;
  const text = lines.map((line) => `${head} ${line}\n`).join("");
  const bytes = Buffer.byteLength(text);
  try {
    const file = appLogFile();
    if (size == null) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try { size = fs.statSync(file).size; } catch { size = 0; }
    }
    if (size + bytes > MAX_BYTES) {
      rotate(file);
      try { size = fs.statSync(file).size; } catch { size = 0; }
    }
    fs.appendFileSync(file, text, { mode: 0o600 });
    size += bytes;
  } catch {
    // 数据目录被删了或只读：下次重新建目录、重新看大小
    size = null;
  }
}

export const log = {
  info: (category: string, message: string) => appLog("INFO", category, message),
  warn: (category: string, message: string) => appLog("WARN", category, message),
  error: (category: string, message: string) => appLog("ERROR", category, message),
};

/** 错误对象转一行可读的话：execFile 的错误把整条命令行塞进 message（里面有 token），优先取 curl 自己的报错。 */
export function errorText(error: unknown): string {
  if (error && typeof error === "object") {
    const row = error as { stderr?: unknown; message?: unknown; code?: unknown; killed?: unknown };
    const stderr = typeof row.stderr === "string" ? row.stderr.trim() : "";
    if (stderr) return stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
    if (row.killed) return "超时被结束";
    if (typeof row.message === "string") {
      const message = row.message.startsWith("Command failed:") ? `命令失败${row.code != null ? `（退出码 ${row.code}）` : ""}` : row.message;
      return message.split(/\r?\n/)[0];
    }
  }
  return String(error);
}
