import { randomBytes } from "crypto";
import { appLog, appLogFile, redactLogText } from "./app-log";

/**
 * 官方账号 OAuth 登录日志。0.3.62 是单独的 `login-log.txt`，现在并进统一运行日志（app-log.ts），分类是 `login 家#编号`。
 *
 * 以前登录子进程的输出全丢（stdio: "ignore"），失败时界面只能说「没有检测到 OAuth 登录成功」，
 * 用户机器上到底是 CLI 报错、换 token 被拒还是凭据落在了别处，事后无从查起。这里记：
 * 每次登录的 CLI 路径和版本、代理怎么补的、CLI 的输出（脱敏）、退出码、临时目录里有哪些文件（只记名字和大小）、最后的判定。
 * 脱敏规则同统一日志：**不记 token、授权码、链接参数，邮箱打码，家目录换成 ~**。
 */

export function loginLogFile() {
  return appLogFile();
}

export const redactLoginText = redactLogText;

/** 一次登录尝试的记录器。写日志失败不影响登录本身。 */
export function startLoginLog(kind: string) {
  const id = `${kind}#${randomBytes(2).toString("hex")}`;
  const write = (message: string) => appLog("INFO", `login ${id}`, message);
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
