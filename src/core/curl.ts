import { execFile, spawn } from "child_process";
import { promisify } from "util";

/**
 * 走系统 curl 发请求。为什么不用 Node 的 fetch：这几家官方接口对 TLS 指纹和 HTTP/2 比较挑，
 * fetch 经常被挡；curl 在 Windows 10+ 和 macOS 自带。额度查询和 OAuth 续期共用。
 */

const execFileAsync = promisify(execFile);

export function curlBin() {
  return process.platform === "win32" ? "curl.exe" : "curl";
}

export async function curlJson(url: string, headers: string[], timeout = 15000) {
  const args = ["-sS", "-m", "12", "--http1.1", url];
  for (const header of headers) args.push("-H", header);
  const { stdout } = await execFileAsync(curlBin(), args, {
    timeout,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  const text = stdout.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) throw new Error("not json");
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * POST 一段请求体，返回 HTTP 状态码和解析后的 JSON。
 * 请求体从 stdin 喂给 curl（`--data-binary @-`），不放进命令行参数：
 * 里面是 refresh token，命令行对本机其它进程是可见的。
 */
export function curlPost(url: string, body: string, headers: string[], timeoutMs = 25_000): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const args = ["-sS", "-m", "20", "--http1.1", "-X", "POST", url, "--data-binary", "@-", "-w", "\n%{http_code}"];
    for (const header of headers) args.push("-H", header);
    const proc = spawn(curlBin(), args, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    proc.stdout.on("data", (chunk) => { out += chunk; });
    proc.stderr.on("data", (chunk) => { err += chunk; });
    proc.once("error", (error) => { clearTimeout(timer); reject(error); });
    proc.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(err.trim() || `curl 退出码 ${code}`)); return; }
      const cut = out.lastIndexOf("\n");
      const status = Number(out.slice(cut + 1));
      let json: any = null;
      try { json = JSON.parse(out.slice(0, cut)); } catch { /* 非 JSON 响应按 null 处理 */ }
      resolve({ status, json });
    });
    proc.stdin.end(body);
  });
}
