import { randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { dataFile } from "./paths";

/**
 * 官方账号 OAuth 登录日志：`~/.tokenpulse/login-log.txt`，纯文本，一行一件事。
 *
 * 以前登录子进程的输出全丢（stdio: "ignore"），失败时界面只能说「没有检测到 OAuth 登录成功」，
 * 用户机器上到底是 CLI 报错、换 token 被拒还是凭据落在了别处，事后无从查起。这里记：
 * 每次登录的 CLI 路径和版本、代理怎么补的、CLI 的输出（脱敏）、退出码、临时目录里有哪些文件（只记名字和大小）、最后的判定。
 * 日志是给用户发出来排查用的，**不记 token、授权码、链接参数，邮箱打码，家目录换成 ~**。超过 MAX_BYTES 只留后一半。
 */

const MAX_BYTES = 512 * 1024;
const MAX_LINE = 400;

export function loginLogFile() {
  return dataFile("login-log.txt");
}

/** 去掉终端颜色 / 光标控制符。 */
function stripAnsi(text: string) {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export function redactLoginText(text: string, home = os.homedir()) {
  let out = stripAnsi(String(text ?? ""));
  if (home) out = out.split(home).join("~").split(home.replace(/\\/g, "/")).join("~");
  return out
    // 授权链接的参数里有 state / code_challenge，回调链接里有授权码
    .replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, "$1?…")
    .replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g, "$1***@$2")
    // token、refresh token、API key、JWT 之类的长串
    .replace(/[A-Za-z0-9_\-+=.]{32,}/g, (hit) => `[已隐藏 ${hit.length} 字符]`)
    .slice(0, MAX_LINE);
}

/** 一次登录尝试的记录器。写日志失败不影响登录本身。 */
export function startLoginLog(kind: string) {
  const id = `${kind}#${randomBytes(2).toString("hex")}`;
  const write = (message: string) => {
    const stamp = new Date().toISOString().replace("T", " ").replace("Z", "");
    const lines = String(message).split(/\r?\n/).map((line) => redactLoginText(line)).filter((line) => line.trim());
    if (!lines.length) return;
    try {
      const file = loginLogFile();
      // 刚装好、第一次登录时数据目录可能还没建
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, lines.map((line) => `${stamp} [${id}] ${line}\n`).join(""), { mode: 0o600 });
      if (fs.statSync(file).size > MAX_BYTES) {
        const text = fs.readFileSync(file, "utf8");
        fs.writeFileSync(file, text.slice(text.indexOf("\n", text.length - MAX_BYTES / 2) + 1));
      }
    } catch {
      // 数据目录不可写时照样登录
    }
  };
  return { id, write };
}

export type LoginLog = ReturnType<typeof startLoginLog>;

/** 把子进程的输出流按行转进日志。行数有上限，免得进度条之类的刷屏。 */
export function pipeToLoginLog(log: LoginLog, label: string, stream: NodeJS.ReadableStream | null | undefined, maxLines = 200) {
  if (!stream) return;
  let rest = "", count = 0;
  const emit = (line: string) => {
    if (!line.trim() || count > maxLines) return;
    count += 1;
    log.write(count > maxLines ? `${label}: …（后面的输出不再记录）` : `${label}: ${line}`);
  };
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk: string | Buffer) => {
    const parts = (rest + String(chunk)).split(/\r?\n|\r/);
    rest = parts.pop() ?? "";
    parts.forEach(emit);
    if (rest.length > 4096) { emit(rest); rest = ""; }
  });
  stream.on("end", () => { if (rest) emit(rest); rest = ""; });
  stream.on("error", () => undefined);
}
