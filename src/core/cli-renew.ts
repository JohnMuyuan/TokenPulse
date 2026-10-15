import { execFile } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { accountIdOf, RENEW_BEFORE_MS } from "./accounts";
import { writeAtomic } from "./cli-switch";
import { authFile, cliDir, readCliAccounts } from "./credentials";
import { logRenew } from "./renew-log";
import { refreshCredential } from "./token-refresh";

/**
 * 0.3.54：Claude Code 没在运行时，替它续期 CLI 里登录着的那个账号。
 *
 * 「切到 CLI」之后，那个账号的凭据交给了 Claude Code，TokenPulse 不再自己续期（refresh token 一次一换，两边各留一份迟早互相顶掉）。
 * Claude Code 只在发请求时才续，所以它超过 8 小时没用（晚上、刚开机），TokenPulse 读到的就是过期凭据：
 * 额度查不了、提示「登录已失效」、号池跳过这个号，等 Claude Code 发一条消息又自己好了。
 *
 * 规则：
 * - 只在凭据快过期（RENEW_BEFORE_MS 内）或已过期时动手；
 * - **确认没有 Claude Code 进程**才续：没人同时拿同一个 refresh token 去换，不会互相顶掉。Claude Code 下次启动会直接读到新的；
 *   检查进程失败、或者 Claude Code 自己的续期锁（`.oauth_refresh.lock`）在，就当它在运行，不动；
 * - 续完再读一遍文件，refresh token 被别人改过（期间 Claude Code 启动续了、或者用户重新登录了）就不写；
 * - 只改 `claudeAiOauth` 里的 accessToken / refreshToken / expiresAt（官方给了才写 refreshTokenExpiresAt），其它字段原样保留；
 * - 官方明确拒绝的 refresh token 记住，不反复去试（Claude Code 自己会提示重新登录）。
 */

export type CliRenewState =
  /** CLI 没登录 / 没有 refresh token / 文件不是我们认识的样子。 */
  | "none"
  /** 还新，不用续。 */
  | "fresh"
  /** 续上了，已写回 CLI 的凭据文件。 */
  | "renewed"
  /** 过期了，但 Claude Code 在运行（或查不清楚），等它自己下次请求时续。 */
  | "waiting"
  /** 这次没续上（网络 / 官方拒绝 / 期间文件被改）。 */
  | "failed";

/** dead：官方明确拒绝了这个 refresh token，只能在 Claude Code 里重新登录。 */
export type CliRenewResult = { state: CliRenewState; accountId?: string; error?: string; dead?: boolean };

type Deps = {
  home?: string;
  refresh?: typeof refreshCredential;
  /** Claude Code 是否在运行。查不清楚时要返回 true。 */
  running?: () => Promise<boolean>;
};

const dead = new Set<string>();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
let inflight: Promise<CliRenewResult> | null = null;

/** 只续 Claude：Codex / Grok 的 CLI 凭据有效期长得多，目前没有这个问题。 */
export function renewCliCredential(now = Date.now(), deps: Deps = {}): Promise<CliRenewResult> {
  if (!inflight) inflight = run(now, deps).finally(() => { inflight = null; });
  return inflight;
}

async function run(now: number, deps: Deps): Promise<CliRenewResult> {
  const home = deps.home ?? os.homedir();
  const file = authFile("claude", home);
  const before = readText(file);
  const oauth = parse(before)?.claudeAiOauth;
  const refreshToken = typeof oauth?.refreshToken === "string" ? oauth.refreshToken : "";
  if (!oauth || !refreshToken || typeof oauth.accessToken !== "string") return { state: "none" };
  const live = readCliAccounts("claude", home)[0];
  const accountId = live ? accountIdOf("claude", live.ref) : undefined;
  if (typeof oauth.expiresAt !== "number" || oauth.expiresAt - now > RENEW_BEFORE_MS) return { state: "fresh", accountId };
  if (dead.has(hash(refreshToken))) return { state: "failed", accountId, error: "refresh token 已被官方拒绝", dead: true };
  if (fs.existsSync(path.join(cliDir("claude", home), ".oauth_refresh.lock"))) return { state: "waiting", accountId };
  if (await (deps.running ?? claudeCodeRunning)()) return { state: "waiting", accountId };

  const result = await (deps.refresh ?? refreshCredential)("claude", { token: oauth.accessToken, expiresAt: oauth.expiresAt, refreshToken }, now);
  const log = (ok: boolean, extra: Record<string, unknown> = {}) => logRenew({ at: now, kind: "claude", accountId: accountId ?? "claude:?", source: "cli", ok, ...extra });
  if (!result.ok) {
    if (result.permanent) dead.add(hash(refreshToken));
    log(false, { status: result.status, code: result.code, error: result.error, permanent: result.permanent });
    return { state: "failed", accountId, error: result.error, dead: result.permanent };
  }
  // 走网络这段时间文件变了：Claude Code 启动后自己续过，或者用户重新登录了。以文件为准，不覆盖。
  const latest = readText(file);
  const current = parse(latest);
  if (latest !== before || current?.claudeAiOauth?.refreshToken !== refreshToken) {
    log(true, { note: "续期期间 CLI 凭据被改过，没有写回" });
    return { state: "failed", accountId, error: "续期期间 CLI 凭据被改过" };
  }
  const expiresIn = Number(result.raw?.refresh_token_expires_in);
  current.claudeAiOauth = {
    ...current.claudeAiOauth,
    accessToken: result.credential.token,
    refreshToken: result.credential.refreshToken,
    expiresAt: result.credential.expiresAt,
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { refreshTokenExpiresAt: now + expiresIn * 1000 } : {}),
  };
  try {
    writeAtomic(file, before.includes("\n") ? JSON.stringify(current, null, 2) : JSON.stringify(current));
  } catch (error) {
    // 新 refresh token 没写进去，旧的已经作废：只能让用户在 Claude Code 里重新登录。如实记下来。
    const message = error instanceof Error ? error.message : String(error);
    log(true, { note: "续上了但写回 CLI 凭据文件失败", error: message });
    return { state: "failed", accountId, error: "写回 CLI 凭据文件失败：" + message };
  }
  log(true);
  return { state: "renewed", accountId };
}

function readText(file: string) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}
function parse(text: string): any {
  try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * 有没有 Claude Code 在跑：原生版是 claude.exe（Claude 桌面版的主程序也叫 claude.exe，按安装位置排除），
 * npm 装的是 node 跑 @anthropic-ai/claude-code。桌面版自带的 Claude Code 也算在运行（宁可不续）。
 * 命令行只在内存里匹配，不记录。
 */
export async function claudeCodeRunning(): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const script = "Get-CimInstance Win32_Process -Filter \"Name='claude.exe' or Name='node.exe' or Name='bun.exe'\" | ForEach-Object { [string]$_.Name + [char]9 + [string]$_.ExecutablePath + [char]9 + [string]$_.CommandLine }";
      const out = await execText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
      return out.split(/\r?\n/).some((line) => {
        const [name = "", exe = "", cmd = ""] = line.split("\t");
        return isClaudeCodeProcess(name, exe, cmd);
      });
    }
    const out = await execText("ps", ["-axo", "args="]);
    return out.split("\n").some((line) => {
      if (/Claude\.app\/Contents\/MacOS\/Claude(\s|$)/.test(line)) return false;
      return /(^|\/)claude(\s|$)/.test(line.trim().split(/\s+/)[0] ?? "") || /claude-code|@anthropic-ai\/claude/.test(line);
    });
  } catch {
    return true;
  }
}

/** Windows 上的一个进程是不是 Claude Code。路径为空（查不到，比如管理员权限的进程）的 claude.exe 也算。 */
export function isClaudeCodeProcess(name: string, exe: string, cmd: string) {
  if (/^claude\.exe$/i.test(name)) return !/\\WindowsApps\\Claude_|\\AnthropicClaude\\/i.test(exe);
  return /claude-code|@anthropic-ai[\\/]claude/i.test(cmd);
}

function execText(cmd: string, args: string[]) {
  return new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout)))),
  );
}
