import { execFile, spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import {
  accountIdOf,
  readOfficialAccountStore,
  rememberOfficialAccount,
  removeOfficialAccount,
  purgeOfficialAccount,
  renameOfficialAccount,
  renewStoredCredentials,
  reorderOfficialAccounts,
  resolveAccountCredential,
  restoreOfficialAccount,
} from "../core/accounts";
import { OFFICIAL_KINDS, cliDir, isExpired, readCliAccounts, type OfficialAccountKind } from "../core/credentials";
import { dataDir } from "../core/paths";
import { forgetQuotaAccount } from "../core/quota-history";
import { cleanAgentEnv } from "./session-reply";

/**
 * 设置页的官方账号管理：探测 CLI、调用官方 CLI 做 OAuth 登录、给界面一份**不含凭据**的账号列表。
 *
 * 登录流程：在临时目录里跑官方 CLI 的登录命令（浏览器授权），等临时目录里出现新凭据，
 * 读出来存进账号库，然后删掉临时目录。用户自己 CLI 的登录一点都不碰。
 */

const execFileAsync = promisify(execFile);
const LABELS: Record<OfficialAccountKind, string> = { claude: "Claude", chatgpt: "ChatGPT", grok: "Grok" };
const LOGIN_TIMEOUT_MS = 180_000;

export type AccountView = {
  id: string;
  email: string;
  label: string;
  /** 用户起的名字（没有就是空）。 */
  alias: string;
  /** CLI 当前正登录着它。 */
  inCli: boolean;
  /** 有可用（未过期）的凭据，能查额度。 */
  usable: boolean;
  /** TokenPulse 登录的账号，会在过期前自动续期。 */
  autoRenew: boolean;
  /** 续期被官方拒绝，只能重新登录。 */
  needsLogin: boolean;
  /** 删掉了、但 CLI 还登录着，只是藏起来（见 accounts.ts 的 hidden）。 */
  hidden: boolean;
};
export type OfficialOAuthStatus = {
  kind: OfficialAccountKind;
  label: string;
  installed: boolean;
  accounts: AccountView[];
};

const CANDIDATES: Record<OfficialAccountKind, string[]> = {
  grok: [path.join(os.homedir(), ".grok", "bin", "grok.exe"), "grok"],
  claude: [path.join(os.homedir(), ".local", "bin", "claude.exe"), "claude"],
  chatgpt: [path.join(process.env.APPDATA || "", "npm", "codex.cmd"), "codex"],
};

async function where(name: string) {
  try {
    const { stdout } = await execFileAsync(process.platform === "win32" ? "where.exe" : "which", [name], {
      windowsHide: true,
      timeout: 5_000,
    });
    // where 会同时列出无扩展名的 shell 脚本和 .ps1，都不能直接 spawn。
    return stdout.split(/\r?\n/).map((item) => item.trim()).find((item) => /\.(exe|cmd|bat)$/i.test(item) || (item && process.platform !== "win32")) || "";
  } catch {
    return "";
  }
}

/** CLI 路径不会在程序运行期间变来变去，探测一次缓存住：以前每次打开设置都要跑好几轮 where.exe。 */
const cliCache = new Map<OfficialAccountKind, Promise<string>>();
function resolveCli(kind: OfficialAccountKind) {
  let found = cliCache.get(kind);
  if (!found) {
    found = (async () => {
      for (const candidate of CANDIDATES[kind]) {
        if (path.isAbsolute(candidate)) {
          if (fs.existsSync(candidate)) return candidate;
        } else {
          const hit = await where(candidate);
          if (hit) return hit;
        }
      }
      return "";
    })();
    cliCache.set(kind, found);
    // 没找到不缓存：用户可能刚装好 CLI，下次打开设置应该能看到。
    void found.then((hit) => { if (!hit) cliCache.delete(kind); });
  }
  return found;
}

function quoteWin(value: string) {
  return /[\s&<>^|()"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** .cmd / .bat 不能直接 spawn，要经 cmd.exe。 */
function invocation(command: string, args: string[]) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", [quoteWin(command), ...args.map(quoteWin)].join(" ")],
      windowsVerbatimArguments: true,
    };
  }
  return { file: command, args, windowsVerbatimArguments: false };
}

function loginArgs(kind: OfficialAccountKind) {
  if (kind === "grok") return ["login", "--oauth"];
  if (kind === "claude") return ["auth", "login"];
  return ["login"];
}

/**
 * 把登录关进临时目录的环境变量：只改三家各自的配置目录变量（CODEX_HOME / CLAUDE_CONFIG_DIR / GROK_HOME）。
 *
 * - **只改 USERPROFILE / HOME 关不住 Codex**：它是 Rust 写的，Windows 上用 SHGetKnownFolderPath 找家目录。
 *   实测只改 USERPROFILE 时 `codex login status` 仍报告已登录，`codex login` 会覆盖用户真实的 ~/.codex。
 * - **也不能改 USERPROFILE / APPDATA / LOCALAPPDATA**：CLI 打开的浏览器会继承这些变量，
 *   Chrome / Edge 按 LOCALAPPDATA 找用户配置 —— 结果开出一个全新的空白浏览器配置，
 *   用户平时浏览器里已登录的账号全都用不上，只能重新输密码验证。
 * 实测只设这三个变量，三家都读不到真实登录，真实的 ~/.claude.json 也不会被改。
 */
export function isolatedEnv(tempHome: string, base: NodeJS.ProcessEnv = process.env) {
  // 从别的 Agent 终端里启动时继承的会话标记也去掉（见 session-reply.ts 的 cleanAgentEnv）
  const env: NodeJS.ProcessEnv = cleanAgentEnv(base);
  // 官方登录不能被用户环境里的 API Key / 中转地址带偏。
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "XAI_API_KEY", "XAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) delete env[key];
  env.CLAUDE_CONFIG_DIR = cliDir("claude", tempHome);
  env.CODEX_HOME = cliDir("chatgpt", tempHome);
  env.GROK_HOME = cliDir("grok", tempHome);
  return env;
}

/** Windows 上 proc.kill() 只杀 cmd.exe，里面的 codex 登录服务会活下来、继续占着回调端口。 */
function killTree(proc: ChildProcess) {
  if (proc.exitCode != null || proc.pid == null) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
  } else {
    proc.kill();
  }
}

function signature(kind: OfficialAccountKind, home: string) {
  return readCliAccounts(kind, home).map((item) => `${item.ref}:${item.credential.token.slice(-12)}`).sort().join("|");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type LoginResult = { ok: true; statuses: OfficialOAuthStatus[] } | { ok: false; error: string };

async function runLogin(kind: OfficialAccountKind, replaceId?: string): Promise<LoginResult> {
  const command = await resolveCli(kind);
  if (!command) return { ok: false, error: `没有找到 ${LABELS[kind]} CLI，请先安装官方命令行。` };
  // 放在数据目录下而不是系统 Temp：Codex 拒绝在 Temp 下建辅助程序，会打一串警告。
  fs.mkdirSync(dataDir(), { recursive: true });
  const tempHome = fs.mkdtempSync(path.join(dataDir(), "oauth-login-"));
  let proc: ChildProcess | undefined;
  try {
    for (const k of OFFICIAL_KINDS) fs.mkdirSync(cliDir(k, tempHome), { recursive: true });
    const before = signature(kind, tempHome);
    const inv = invocation(command, loginArgs(kind));
    proc = spawn(inv.file, inv.args, {
      cwd: tempHome,
      env: isolatedEnv(tempHome),
      windowsHide: true,
      stdio: "ignore",
      windowsVerbatimArguments: inv.windowsVerbatimArguments,
    });
    let exited = false;
    proc.once("exit", () => { exited = true; });
    proc.once("error", () => { exited = true; });

    // 凭据文件出现变化就算成功；CLI 退出后再多等 3 秒，有的 CLI 退出时才落盘。
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let graceUntil = Infinity;
    while (Date.now() < Math.min(deadline, graceUntil)) {
      const current = signature(kind, tempHome);
      if (current && current !== before) {
        const accounts = readCliAccounts(kind, tempHome);
        if (replaceId && !accounts.some((account) => accountIdOf(kind, account.ref) === replaceId)) {
          return { ok: false, error: "重新授权登录的账号与目标账号不一致，原账号没有改变。" };
        }
        // 登录进来的账号排在这一家的最后；以前删过 / 藏过的同一个账号会恢复。
        for (const account of accounts) rememberOfficialAccount(account, true);
        return { ok: true, statuses: await listOfficialOAuthStatus() };
      }
      if (exited && graceUntil === Infinity) graceUntil = Date.now() + 3_000;
      await sleep(exited ? 500 : 1_000);
    }
    return {
      ok: false,
      error: exited ? "没有检测到 OAuth 登录成功，请完成浏览器授权后再试一次。" : "OAuth 登录等待超时，请回到浏览器完成授权后再试一次。",
    };
  } finally {
    if (proc) killTree(proc);
    // 临时目录里是明文 token，不管成功失败都要删。CLI 进程刚被杀时文件可能还占着，重试几次。
    fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }, () => undefined);
  }
}

/** 同一家同时只跑一个登录：连点两下会起两个 CLI 抢同一个回调端口。 */
const inflight = new Map<string, Promise<LoginResult>>();
export function loginOfficialOAuth(kind: OfficialAccountKind, replaceId?: string): Promise<LoginResult> {
  const key = `${kind}:${replaceId || ""}`;
  let running = inflight.get(key);
  if (!running) {
    running = runLogin(kind, replaceId).finally(() => inflight.delete(key));
    inflight.set(key, running);
  }
  return running;
}

export async function listOfficialOAuthStatus(now = Date.now()): Promise<OfficialOAuthStatus[]> {
  // 列表上的「可用 / 已过期」要反映续期之后的状态。
  const [installed] = await Promise.all([Promise.all(OFFICIAL_KINDS.map(resolveCli)), renewStoredCredentials(now).catch(() => 0)]);
  return OFFICIAL_KINDS.map((kind, index) => {
    const live = readCliAccounts(kind);
    for (const account of live) {
      try {
        rememberOfficialAccount(account, false, now);
      } catch {
        // 数据目录只读时照样显示 CLI 的真实登录，下次可写时再登记。
      }
    }
    const store = readOfficialAccountStore();
    const accounts = store.accounts
      .filter((item) => item.kind === kind)
      .map((item) => {
        const { credential, inCli } = resolveAccountCredential(item, now, live);
        return {
          id: item.id,
          email: item.email,
          label: item.label,
          alias: item.alias ?? "",
          inCli,
          usable: !isExpired(credential, now),
          autoRenew: Boolean(item.credential?.refreshToken) && !item.renewFailed,
          needsLogin: Boolean(item.renewFailed) && !inCli,
          hidden: Boolean(item.hidden),
        };
      });
    return { kind, label: LABELS[kind], installed: Boolean(installed[index]), accounts };
  });
}

/**
 * 设置里的账号管理：删除、完全删除、恢复、改名。返回新的账号列表。
 * 删除时要知道 CLI 现在是不是还登录着它（那样只能藏起来），这个由这里现读，不信界面传来的。
 */
export async function manageOfficialAccount(action: "remove" | "purge" | "restore" | "rename", id: string, alias = "") {
  const store = readOfficialAccountStore();
  const target = store.accounts.find((item) => item.id === id);
  if (!target) throw new Error("找不到这个官方账号");
  if (action === "rename") renameOfficialAccount(id, alias);
  else if (action === "restore") restoreOfficialAccount(id);
  else if (action === "purge") {
    purgeOfficialAccount(id);
    forgetQuotaAccount(id);
  } else removeOfficialAccount(id, readCliAccounts(target.kind).some((item) => accountIdOf(target.kind, item.ref) === id));
  return listOfficialOAuthStatus();
}

/** 拖拽排序：这一家账号的新顺序。 */
export async function reorderOfficialAccountsOf(kind: OfficialAccountKind, ids: string[]) {
  reorderOfficialAccounts(kind, ids);
  return listOfficialOAuthStatus();
}
