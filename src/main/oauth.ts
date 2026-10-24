import { forgetCalibrations } from "../core/quota-calibration";
import { forgetMarks } from "../core/quota-offmachine";
import { execFile, spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import {
  accountIdOf,
  readOfficialAccountStore,
  adoptCliAccount, rememberOfficialAccount,
  removeOfficialAccount,
  purgeOfficialAccount,
  renameOfficialAccount,
  renewStoredCredentials,
  reorderOfficialAccounts,
  resolveAccountCredential,
  restoreOfficialAccount,
  writeOfficialAccountStore,
} from "../core/accounts";
import { OFFICIAL_KINDS, authFile, claudeProfileFile, cliDir, isExpired, readCliAccounts, type OfficialAccountKind } from "../core/credentials";
import { pipeToLoginLog, startLoginLog } from "../core/login-log";
import { systemProxyEnv } from "../core/upstream-proxy";
import { readCliSnapshot, switchCliAccount } from "../core/cli-switch";
import { renewCliCredential } from "../core/cli-renew";
import { describeAutoSwitch, normalizeRule, readAutoSwitchEvents } from "../core/cli-auto-switch";
import { usesOfficialLogin } from "../core/agent-switch";
import { readPrefs } from "./prefs";
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
  /** 0.3.54：登录在 CLI 里、CLI 的凭据过期了，等 CLI 下次请求时自己续（不用重新登录）。 */
  waitCli: boolean;
  /** 0.3.54：最近一次续期为什么没成（需重新登录的原因，或还在重试的被拒原因）。不含凭据。 */
  renewError?: string;
  /** 删掉了、但 CLI 还登录着，只是藏起来（见 accounts.ts 的 hidden）。 */
  hidden: boolean;
};
export type OfficialOAuthStatus = {
  kind: OfficialAccountKind;
  label: string;
  installed: boolean;
  accounts: AccountView[];
  /** 0.3.55：额度用满自动切 CLI 登录。idle：开着但这会儿不起作用的原因；last：最近一次动作的说法。 */
  autoSwitch: { on: boolean; at: number; idle?: string; last?: { at: number; result: string; title: string; body: string } };
};

const AUTO_APP = { claude: "claude", chatgpt: "codex", grok: "grok" } as const;
const CLI_NAME = { claude: "Claude Code", chatgpt: "Codex", grok: "Grok CLI" } as const;
function autoSwitchView(kind: OfficialAccountKind): OfficialOAuthStatus["autoSwitch"] {
  const prefs = readPrefs();
  const rule = normalizeRule(prefs.cliAutoSwitch?.[kind]);
  let idle: string | undefined;
  if (rule.on && prefs.agentReadOnly) idle = "供应商「只读保护」开着，不会自动切换";
  else if (rule.on) {
    let official = false;
    try { official = usesOfficialLogin(AUTO_APP[kind]); } catch { /* 读不了供应商数据就当不是 */ }
    if (!official) idle = `${CLI_NAME[kind]} 现在用的不是官方登录（第三方供应商或号池），切 CLI 登录没有用，先不切`;
  }
  const event = readAutoSwitchEvents().filter((item) => item.kind === kind).pop();
  const last = event ? { at: event.at, result: event.result, ...describeAutoSwitch(event) } : undefined;
  return { ...rule, ...(idle ? { idle } : {}), ...(last ? { last } : {}) };
}

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
  return readCliAccounts(kind, home, true).map((item) => `${item.ref}:${item.credential.token.slice(-12)}`).sort().join("|");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 各家 CLI 拿授权码换 token 的地址：按它判断登录子进程要不要补系统代理（见 upstream-proxy.ts 的 systemProxyEnv）。 */
const TOKEN_URL: Record<OfficialAccountKind, string> = {
  claude: "https://platform.claude.com/v1/oauth/token",
  chatgpt: "https://auth.openai.com/oauth/token",
  grok: "https://auth.x.ai/",
};
const PROXY_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"];
/** 日志里的代理只记地址，去掉账号密码。 */
const proxyHost = (value: string) => value.replace(/\/\/[^@/]*@/, "//***@");

function appVersion() {
  try { return String(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")).version || "?"); } catch { return "?"; }
}

/**
 * 临时目录里 CLI 写了什么（给登录日志用）：文件名和大小、凭据文件能不能解析、有没有 token、Claude 有没有账号资料。
 * 只看结构，不读出任何值。
 */
export function describeLoginDir(kind: OfficialAccountKind, tempHome: string) {
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= 40) return;
      const full = path.join(dir, entry.name), rel = path.relative(tempHome, full).replace(/\\/g, "/");
      if (entry.isDirectory()) { if (depth < 3) walk(full, depth + 1); continue; }
      let size = -1;
      try { size = fs.statSync(full).size; } catch { /* 正在写 */ }
      files.push(`${rel}(${size})`);
    }
  };
  walk(tempHome, 0);
  const auth = authFile(kind, tempHome);
  let authState = "不存在";
  if (fs.existsSync(auth)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(auth, "utf8"));
      const hasToken = kind === "claude" ? Boolean(parsed?.claudeAiOauth?.accessToken)
        : kind === "chatgpt" ? Boolean(parsed?.tokens?.access_token)
        : Object.values<any>(parsed || {}).some((row) => typeof row?.key === "string" && row.key);
      authState = `可解析，${hasToken ? "有" : "没有"} token，顶层字段 ${Object.keys(parsed || {}).slice(0, 8).join("/") || "无"}`;
    } catch { authState = "存在但不是有效 JSON"; }
  }
  let profile = "";
  if (kind === "claude") {
    try { profile = `；账号资料 oauthAccount：${JSON.parse(fs.readFileSync(claudeProfileFile(tempHome, true), "utf8"))?.oauthAccount ? "有" : "没有"}`; } catch { profile = "；账号资料 .claude.json：读不到"; }
  }
  return `凭据文件 ${path.relative(tempHome, auth).replace(/\\/g, "/")}：${authState}${profile}；临时目录文件：${files.join(", ") || "（空）"}`;
}

type LoginResult = { ok: true; statuses: OfficialOAuthStatus[] } | { ok: false; error: string };

const LOG_HINT = "详细过程已记在登录日志（设置 →「数据」→「打开登录日志」）。";

async function runLogin(kind: OfficialAccountKind, replaceId?: string): Promise<LoginResult> {
  const log = startLoginLog(kind);
  const started = Date.now();
  log.write(`开始登录 ${LABELS[kind]}${replaceId ? "（重新授权已有账号）" : ""}；TokenPulse ${appVersion()}，${process.platform} ${os.release()} ${process.arch}`);
  const command = await resolveCli(kind);
  if (!command) {
    log.write(`没有找到 CLI（找过：${CANDIDATES[kind].join("、")}）`);
    return { ok: false, error: `没有找到 ${LABELS[kind]} CLI，请先安装官方命令行。` };
  }
  // 放在数据目录下而不是系统 Temp：Codex 拒绝在 Temp 下建辅助程序，会打一串警告。
  fs.mkdirSync(dataDir(), { recursive: true });
  const tempHome = fs.mkdtempSync(path.join(dataDir(), "oauth-login-"));
  let proc: ChildProcess | undefined;
  const fail = (error: string, why: string): LoginResult => {
    log.write(`失败（${Math.round((Date.now() - started) / 1000)} 秒）：${why}`);
    log.write(describeLoginDir(kind, tempHome));
    return { ok: false, error: `${error}${LOG_HINT}` };
  };
  try {
    for (const k of OFFICIAL_KINDS) fs.mkdirSync(cliDir(k, tempHome), { recursive: true });
    const before = signature(kind, tempHome);
    const env = isolatedEnv(tempHome);
    const added = await systemProxyEnv(TOKEN_URL[kind], env).catch(() => ({} as Record<string, string>));
    if (added.NO_PROXY) delete env.no_proxy;
    Object.assign(env, added);
    const proxyNote = added.HTTPS_PROXY ? `按系统代理补上 HTTPS_PROXY=${added.HTTPS_PROXY}`
      : PROXY_KEYS.filter((key) => env[key] || env[key.toLowerCase()]).map((key) => `${key}=${proxyHost(String(env[key] || env[key.toLowerCase()]))}`).join("，") || "没有代理，直连（环境变量里没设；系统代理没开，或者不是 HTTP 代理）";
    log.write(`CLI：${command}；代理：${proxyNote}`);
    const inv = invocation(command, loginArgs(kind));
    // 版本号单独问一次，只为写进日志，不等它。用另一个空目录：别和登录抢着写同一份 .claude.json
    const ver = invocation(command, ["--version"]);
    const probeHome = path.join(tempHome, "version-probe");
    for (const k of OFFICIAL_KINDS) fs.mkdirSync(cliDir(k, probeHome), { recursive: true });
    execFile(ver.file, ver.args, { env: { ...isolatedEnv(probeHome), ...added }, cwd: probeHome, windowsHide: true, timeout: 15_000, windowsVerbatimArguments: ver.windowsVerbatimArguments }, (error, stdout) => {
      log.write(`CLI 版本：${error ? `读不到（${error.message}）` : String(stdout).trim() || "（空）"}`);
    });
    proc = spawn(inv.file, inv.args, {
      cwd: tempHome,
      env,
      windowsHide: true,
      // 输出只进日志；stdin 仍然关着，CLI 要用户粘贴授权码时直接失败而不是卡住
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: inv.windowsVerbatimArguments,
    });
    log.write(`已启动登录命令：${[path.basename(command), ...loginArgs(kind)].join(" ")}（pid ${proc.pid ?? "?"}）`);
    pipeToLoginLog(log, "CLI 输出", proc.stdout);
    pipeToLoginLog(log, "CLI 报错", proc.stderr);
    let exited = false;
    proc.once("exit", (code, signal) => { exited = true; log.write(`CLI 退出：code ${code}${signal ? `，signal ${signal}` : ""}`); });
    proc.once("error", (error) => { exited = true; log.write(`CLI 启动失败：${error.message}`); });

    // 凭据文件出现变化就算成功；CLI 退出后再多等 3 秒，有的 CLI 退出时才落盘。
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let graceUntil = Infinity;
    while (Date.now() < Math.min(deadline, graceUntil)) {
      const current = signature(kind, tempHome);
      if (current && current !== before) {
        log.write("检测到新凭据");
        // CLI 写完凭据一般马上自己退出：等它退（最多 3 秒），免得杀在它收尾的半路，日志里也有真实的退出码。
        // Claude 的账号资料（邮箱、accountUuid）在凭据之后才写：没写好就最多等到 10 秒，不然身份会退回 token 哈希
        const settle = Date.now();
        while (!exited && Date.now() - settle < 10_000) {
          if (Date.now() - settle >= 3_000 && (kind !== "claude" || readCliAccounts(kind, tempHome, true).every((account) => account.email))) break;
          await sleep(200);
        }
        const accounts = readCliAccounts(kind, tempHome, true);
        if (replaceId && !accounts.some((account) => accountIdOf(kind, account.ref) === replaceId)) {
          return fail("重新授权登录的账号与目标账号不一致，原账号没有改变。", "登录进来的不是要重新授权的那个账号");
        }
        // 登录进来的账号排在这一家的最后；以前删过 / 藏过的同一个账号会恢复。
        for (const account of accounts) rememberOfficialAccount(account, true);
        // 记下切换 CLI 登录时要一起写回的资料（scopes、oauthAccount、id_token 等，不含 token）
        const snapshot = readCliSnapshot(kind, tempHome, true);
        if (snapshot) {
          const store = readOfficialAccountStore();
          for (const account of accounts) { const found = store.accounts.find((item) => item.id === accountIdOf(kind, account.ref)); if (found) found.cliAuth = snapshot; }
          writeOfficialAccountStore(store);
        }
        log.write(`成功（${Math.round((Date.now() - started) / 1000)} 秒）：${accounts.length} 个账号，${accounts.map((account) => (account.email ? "有邮箱" : "没有邮箱") + (account.ref.startsWith("token:") ? "、身份取自 token" : "")).join("；")}`);
        return { ok: true, statuses: await listOfficialOAuthStatus() };
      }
      if (exited && graceUntil === Infinity) graceUntil = Date.now() + 3_000;
      await sleep(exited ? 500 : 1_000);
    }
    return exited
      ? fail("没有检测到 OAuth 登录成功，请完成浏览器授权后再试一次。", "CLI 已退出，临时目录里没有读到新凭据")
      : fail("OAuth 登录等待超时，请回到浏览器完成授权后再试一次。", `等了 ${LOGIN_TIMEOUT_MS / 1000} 秒 CLI 还没完成`);
  } catch (error) {
    log.write(`出错：${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    if (proc && proc.exitCode == null && proc.pid != null) log.write("登录命令还在运行，结束它");
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
  const [installed, , cliRenew] = await Promise.all([
    Promise.all(OFFICIAL_KINDS.map(resolveCli)),
    renewStoredCredentials(now).catch(() => 0),
    renewCliCredential(now).catch(() => undefined),
  ]);
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
        const usable = !isExpired(credential, now);
        const cliDead = kind === "claude" && cliRenew?.dead && cliRenew.accountId === item.id;
        return {
          id: item.id,
          email: item.email,
          label: item.label,
          alias: item.alias ?? "",
          inCli,
          usable,
          autoRenew: Boolean(item.credential?.refreshToken) && !item.renewFailed,
          needsLogin: (Boolean(item.renewFailed) && !inCli) || Boolean(cliDead && !usable),
          waitCli: inCli && !usable && !cliDead && Boolean(live.find((one) => accountIdOf(kind, one.ref) === item.id)?.credential.refreshToken),
          ...(item.renewFailed || item.renewTrouble ? { renewError: item.renewFailed || item.renewTrouble!.error } : cliDead ? { renewError: cliRenew!.error } : {}),
          hidden: Boolean(item.hidden),
        };
      });
    return { kind, label: LABELS[kind], installed: Boolean(installed[index]), accounts, autoSwitch: autoSwitchView(kind) };
  });
}

/**
 * 添加本机 CLI 已经登录的账号（0.3.18）：不走登录流程、不保存凭据，只把 CLI 现在登录的那个（些）账号登记进来。
 * 之后查额度、统计用量时凭据每次现读 CLI 的文件；CLI 换了账号或退出登录，这个账号就查不了了（记录还在）。
 */
export async function addCliAccounts(kind: OfficialAccountKind) {
  const live = readCliAccounts(kind);
  if (!live.length) throw new Error(`本机的 ${LABELS[kind]} CLI 还没有登录账号。请先在终端里用它的 CLI 登录，或者改用「登录一个新账号」。`);
  let added = 0;
  for (const account of live) if (adoptCliAccount(account).added) added += 1;
  return { ok: true as const, added, total: live.length, statuses: await listOfficialOAuthStatus() };
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
    forgetCalibrations(id);
    forgetMarks(id);
  } else removeOfficialAccount(id, readCliAccounts(target.kind).some((item) => accountIdOf(target.kind, item.ref) === id));
  return listOfficialOAuthStatus();
}

/** 一键把 CLI 的登录切到这个账号（0.3.49，见 cli-switch.ts）。 */
export async function switchCliLogin(id: string) {
  const result = await switchCliAccount(id);
  return { ...result, statuses: await listOfficialOAuthStatus() };
}

/** 拖拽排序：这一家账号的新顺序。 */
export async function reorderOfficialAccountsOf(kind: OfficialAccountKind, ids: string[]) {
  reorderOfficialAccounts(kind, ids);
  return listOfficialOAuthStatus();
}
