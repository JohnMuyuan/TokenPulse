import { execFile, spawn, spawnSync, type ChildProcess } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { dataDir, readJson, writeJson } from "./paths";
import { proxyFor } from "./upstream-proxy";

/**
 * Prism 桥（0.3.19）：管理随软件带的 Prism Bridge（vendor/prism-bridge/bridge.py，作者 yyyllllming，MIT）。
 *
 * 它用真实的 Chromium 登录用户自己的 Prism 账号，在本机开一个 OpenAI 兼容接口。这里只负责：
 * - 准备运行环境：找 Python（没有就试 winget 装），在 TokenPulse 数据目录里建一个独立的虚拟环境，装 playwright 和 Chromium；
 * - 起「登录」和「服务」两种子进程，收日志，退出时把自己起的进程树结束掉；
 * - 只监听 127.0.0.1，并且总是带一个随机密钥，本机别的程序不知道密钥就用不了。
 *
 * 登录凭据（cookie）留在数据目录的 prism-bridge/profile 里，只由 bridge.py 自己读写；这里只读账号 id、套餐和过期时间。
 */
export const PRISM_ORIGIN = "https://prism.openai.com";
export const PRISM_PROVIDER_NAME = "Prism 桥";
/** bridge.py 认的模型（2026-10 的目录）。第一个是默认。 */
export const PRISM_MODELS: [string, string][] = [["gpt-6.1-sol", "GPT-6.1 Sol"], ["gpt-5.6-sol", "GPT-5.6 Sol"], ["gpt-5.6-terra", "GPT-5.6 Terra"], ["gpt-6-luna", "GPT-6 Luna"]];
const DEFAULT_PORT = 18765;
const LOG_MAX = 300;
const READY_MARK = "服务已就绪";
const LOGIN_WAIT_MS = 20 * 60_000;
const PIP_MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple";
const BROWSER_MIRROR = "https://cdn.npmmirror.com/binaries/playwright";

export type PrismPhase = "stopped" | "starting" | "running";
export type PrismTask = "" | "install" | "login";
export type PrismState = {
  /** 软件里带着 bridge.py（开发环境在 vendor，安装版在 resources）。 */
  available: boolean;
  /** 运行环境装好了（虚拟环境 + playwright + Chromium）。 */
  deps: boolean;
  login: { userId: string; plan: string; expiresAt: number; expired: boolean } | null;
  phase: PrismPhase;
  task: PrismTask;
  port: number;
  autoStart: boolean;
  error: string;
  logs: string[];
};

type Config = { port: number; key: string; autoStart: boolean };

const home = () => path.join(dataDir(), "prism-bridge");
const configFile = () => path.join(home(), "config.json");
const profileDir = () => path.join(home(), "profile");
/** 登录窗口单独一份浏览器数据：它用的是系统里的 Chrome / Edge，和服务用的 Chromium 版本不同，不能共用一份。 */
const loginProfileDir = () => path.join(home(), "login-profile");
const venvDir = () => path.join(home(), "venv");
const readyFile = () => path.join(home(), "deps.json");
const venvPython = () => path.join(venvDir(), process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
/** 测试用：直接指定解释器，跳过虚拟环境。 */
const pythonOverride = () => process.env.TOKENPULSE_PRISM_PYTHON || "";

function scriptPath() {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const candidates = [process.env.TOKENPULSE_PRISM_SCRIPT, resources && path.join(resources, "prism-bridge", "bridge.py"), path.join(__dirname, "..", "..", "vendor", "prism-bridge", "bridge.py")];
  return candidates.find((file): file is string => !!file && fs.existsSync(file)) || "";
}

/** 密钥第一次真正要用时才生成并存下来；只看状态不会写文件。 */
function config(needKey = true): Config {
  const raw = readJson<Partial<Config>>(configFile(), {});
  const port = Number.isInteger(raw.port) && raw.port! >= 1024 && raw.port! <= 65535 ? raw.port! : DEFAULT_PORT;
  const key = typeof raw.key === "string" && /^[A-Za-z0-9_-]{20,}$/.test(raw.key) ? raw.key : "";
  const value = { port, key: key || (needKey ? crypto.randomBytes(24).toString("base64url") : ""), autoStart: raw.autoStart === true };
  if (!key && needKey) writeJson(configFile(), value);
  return value;
}

let server: ChildProcess | null = null;
let worker: ChildProcess | null = null;
let phase: PrismPhase = "stopped";
let task: PrismTask = "";
let lastError = "";
let stopping = false;
let logs: string[] = [];
let listener: (() => void) | null = null;
let timer: NodeJS.Timeout | null = null;

function emit() {
  if (!listener || timer) return;
  timer = setTimeout(() => { timer = null; listener?.(); }, 150);
}
function log(line: string) {
  const text = line.replace(/\s+$/, "");
  if (!text) return;
  logs.push(text.slice(0, 600));
  if (logs.length > LOG_MAX) logs = logs.slice(-LOG_MAX);
  emit();
}

/** 状态变了就调（日志会合并，最多每 150 毫秒一次）。 */
export function onPrismChange(handler: (() => void) | null) { listener = handler; }

function depsReady() {
  if (pythonOverride()) return true;
  return fs.existsSync(venvPython()) && fs.existsSync(readyFile());
}

function loginInfo(): PrismState["login"] {
  const raw = readJson<{ cookie?: unknown; user_id?: unknown; plan?: unknown; expires_at?: unknown }>(path.join(profileDir(), "auth.json"), {});
  if (!raw.cookie) return null;
  const expiresAt = Number(raw.expires_at) * 1000 || 0;
  return { userId: typeof raw.user_id === "string" ? raw.user_id : "", plan: typeof raw.plan === "string" ? raw.plan : "", expiresAt, expired: !!expiresAt && expiresAt < Date.now() };
}

export function prismState(): PrismState {
  const cfg = config(false);
  return { available: !!scriptPath(), deps: depsReady(), login: loginInfo(), phase, task, port: cfg.port, autoStart: cfg.autoStart, error: lastError, logs: logs.slice() };
}

/** 给 Codex 加供应商用的地址和密钥。密钥只在主进程里用，不交给界面。 */
export function prismEndpoint() {
  const cfg = config();
  return { baseUrl: `http://127.0.0.1:${cfg.port}/v1`, apiKey: cfg.key };
}

export function setPrismAutoStart(on: boolean) {
  writeJson(configFile(), { ...config(), autoStart: on });
  emit();
}

/**
 * 登录窗口用哪个浏览器：系统默认浏览器是 Chrome / Edge 就用它；默认是别的（Playwright 只能驱动这两种），
 * 装了 Chrome 用 Chrome，否则用 Edge。都没有（或不是 Windows）返回空，用 Playwright 自带的 Chromium。
 */
type LoginBrowser = { channel: string; exe: string };
async function loginBrowser(): Promise<LoginBrowser> {
  const none = { channel: "", exe: "" };
  if (process.env.TOKENPULSE_PRISM_BROWSER) return { channel: "chrome", exe: process.env.TOKENPULSE_PRISM_BROWSER };
  if (process.platform !== "win32" || pythonOverride()) return none;
  const installed = (...parts: string[]) => [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].map((dir) => (dir ? path.join(dir, ...parts) : "")).find((file) => !!file && fs.existsSync(file)) || "";
  const chrome = installed("Google", "Chrome", "Application", "chrome.exe"), edge = installed("Microsoft", "Edge", "Application", "msedge.exe");
  const preferred = await new Promise<string>((resolve) => {
    execFile("reg", ["query", "HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice", "/v", "ProgId"], { windowsHide: true, timeout: 5000 }, (error, stdout) => resolve(error ? "" : String(stdout)));
  });
  const asChrome = { channel: "chrome", exe: chrome }, asEdge = { channel: "msedge", exe: edge };
  if (/ChromeHTML/i.test(preferred) && chrome) return asChrome;
  if (/MSEdgeHTM/i.test(preferred) && edge) return asEdge;
  return chrome ? asChrome : edge ? asEdge : none;
}

async function childEnv(login: LoginBrowser | null = null): Promise<NodeJS.ProcessEnv> {
  const cfg = config();
  const proxy = await proxyFor(new URL(PRISM_ORIGIN)).catch(() => null);
  const proxyUrl = proxy ? `http://${proxy.host}:${proxy.port}` : "";
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" };
  // 会让桥对外开放、换上游或换凭据文件的开关，一律不从外面的环境继承
  for (const name of Object.keys(env)) if (/^PRISM_/i.test(name)) delete env[name];
  // pip 和 playwright 下载浏览器认环境变量里的代理；只开了系统代理的机器上替它们补上
  if (proxyUrl && !env.HTTPS_PROXY && !env.https_proxy) { env.HTTPS_PROXY = proxyUrl; env.HTTP_PROXY = env.HTTP_PROXY || proxyUrl; }
  const channel = login?.channel || "";
  // 登录把凭据写到服务那份数据目录的 auth.json，服务启动时从那里读（bridge.py 本来就支持凭据文件和浏览器数据分开）
  const browser = login ? { PRISM_PROFILE_DIR: loginProfileDir(), PRISM_AUTH_FILE: path.join(profileDir(), "auth.json"), ...(channel ? { PRISM_LOGIN_CHANNEL: channel } : {}) } : { PRISM_PROFILE_DIR: profileDir() };
  return { ...env, PRISM_HOST: "127.0.0.1", PRISM_PORT: String(cfg.port), PRISM_BRIDGE_API_KEY: cfg.key, ...browser, ...(proxyUrl ? { PRISM_PROXY: proxyUrl } : {}) };
}

function pipe(child: ChildProcess, onLine?: (line: string) => void) {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let rest = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const lines = (rest + chunk).split(/\r?\n|\r/);
      rest = lines.pop() || "";
      for (const line of lines) { log(line); onLine?.(line); }
    });
    stream.on("end", () => { if (rest) { log(rest); onLine?.(rest); } });
  }
}

/** 跑一步并等它结束；输出进日志。退出码不是 0 就报错。 */
function step(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    worker = child;
    pipe(child);
    child.on("error", (error) => { if (worker === child) worker = null; reject(error); });
    child.on("exit", (code) => { if (worker === child) worker = null; code === 0 ? resolve() : reject(new Error(`${path.basename(command)} 退出代码 ${code}`)); });
  });
}

type Python = { command: string; args: string[] };
/** 本机的 Python 3.10+：PATH 里的 python、py 启动器、默认安装目录（刚用 winget 装完时 PATH 还没更新）。 */
async function findPython(): Promise<Python | null> {
  const candidates: Python[] = [{ command: "python", args: [] }, { command: "py", args: ["-3"] }, { command: "python3", args: [] }];
  const local = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Python");
  if (local) {
    try {
      for (const name of fs.readdirSync(local).filter((item) => /^Python3\d+$/i.test(item)).sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)))) candidates.push({ command: path.join(local, name, "python.exe"), args: [] });
    } catch { /* 没有这个目录 */ }
  }
  for (const item of candidates) {
    const version = await new Promise<number>((resolve) => {
      execFile(item.command, [...item.args, "-c", "import sys;print(sys.version_info[0]*100+sys.version_info[1])"], { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve(error ? 0 : Number(String(stdout).trim()) || 0));
    });
    if (version >= 310) return item;
  }
  return null;
}

function busy() {
  if (task) throw new Error(task === "install" ? "正在安装运行环境，请等它完成" : "正在登录，请先完成或关掉登录窗口");
}
function fail(error: unknown): never {
  lastError = error instanceof Error ? error.message : String(error);
  log("[TokenPulse] " + lastError);
  throw new Error(lastError);
}

/** 准备运行环境：Python → 虚拟环境 → playwright → Chromium。已经装过的步骤很快就过。 */
export async function installPrism() {
  busy();
  if (!scriptPath()) throw new Error("这个版本里没有带 Prism 桥的程序文件");
  task = "install"; lastError = ""; emit();
  try {
    const env = await childEnv();
    fs.mkdirSync(home(), { recursive: true });
    if (!fs.existsSync(venvPython())) {
      let python = await findPython();
      if (!python && process.platform === "win32") {
        log("[TokenPulse] 没有找到 Python 3.10 以上，正在用 winget 安装 Python 3.13…");
        await step("winget", ["install", "-e", "--id", "Python.Python.3.13", "--scope", "user", "--silent", "--accept-package-agreements", "--accept-source-agreements"], env).catch((error) => log("[TokenPulse] winget 安装没有成功：" + (error instanceof Error ? error.message : error)));
        python = await findPython();
      }
      if (!python) throw new Error("没有找到 Python 3.10 以上。请先到 python.org 安装 Python（安装时勾选 Add python.exe to PATH），再点一次「安装运行环境」。");
      log("[TokenPulse] 正在创建独立的 Python 环境…");
      await step(python.command, [...python.args, "-m", "venv", venvDir()], env);
    }
    log("[TokenPulse] 正在安装 playwright…");
    // 官方源在一些网络下很慢、会超时：失败后换国内镜像再试一次
    const pip = ["-m", "pip", "install", "--disable-pip-version-check", "--progress-bar", "off", "--timeout", "60", "--retries", "3", "playwright>=1.49"];
    await step(venvPython(), pip, env).catch(() => {
      log("[TokenPulse] 官方源没有装成功，换清华镜像再试…");
      return step(venvPython(), [...pip, "-i", PIP_MIRROR], env);
    });
    log("[TokenPulse] 正在下载 Chromium（一百多 MB，只下载一次）…");
    const browser = ["-m", "playwright", "install", "chromium"];
    await step(venvPython(), browser, env).catch(() => {
      log("[TokenPulse] 官方地址没有下载成功，换 npmmirror 镜像再试…");
      return step(venvPython(), browser, { ...env, PLAYWRIGHT_DOWNLOAD_HOST: BROWSER_MIRROR });
    });
    writeJson(readyFile(), { at: Date.now() });
    log("[TokenPulse] 运行环境已经装好。");
  } catch (error) {
    fail(error);
  } finally {
    task = ""; emit();
  }
}

function interpreter() {
  if (!scriptPath()) throw new Error("这个版本里没有带 Prism 桥的程序文件");
  if (!depsReady()) throw new Error("请先安装运行环境");
  return pythonOverride() || venvPython();
}

/** 弹出浏览器登录 Prism。服务开着时先停（两者共用一份浏览器数据），登录完再启动。 */
export async function loginPrism() {
  busy();
  const python = interpreter();
  const restart = phase !== "stopped";
  if (restart) await stopPrism();
  task = "login"; lastError = ""; emit();
  try {
    const before = loginInfo()?.expiresAt || 0;
    const browser = await loginBrowser();
    const env = await childEnv(browser);
    if (browser.exe) {
      /*
       * 用正常方式启动的 Chrome / Edge 登录，登录过程中没有任何程序控制它：被自动化控制的浏览器过不了登录页的真人验证，会一直转圈。
       * 用户登录完把窗口关掉，再从这份浏览器数据里读出登录结果（collect_login.py，不打开任何网页）。
       */
      log(`[TokenPulse] 正在打开 ${browser.channel === "msedge" ? "Edge" : "Chrome"}。请在里面登录你的 OpenAI 账号，看到 Prism 的界面后把这个浏览器窗口关掉。`);
      fs.mkdirSync(loginProfileDir(), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const child = spawn(browser.exe, [`--user-data-dir=${loginProfileDir()}`, "--no-first-run", "--no-default-browser-check", ...(env.PRISM_PROXY ? [`--proxy-server=${env.PRISM_PROXY}`] : []), PRISM_ORIGIN + "/"], { windowsHide: false, stdio: "ignore" });
        worker = child;
        const limit = setTimeout(() => killTree(child), LOGIN_WAIT_MS);
        const done = (error?: Error) => { clearTimeout(limit); if (worker === child) worker = null; error ? reject(error) : resolve(); };
        child.on("error", (error) => done(error));
        child.on("exit", () => done());
      });
      log("[TokenPulse] 浏览器已关闭，正在读取登录结果…");
      await step(python, ["-u", path.join(path.dirname(scriptPath()), "collect_login.py")], env).catch(() => undefined);
    } else {
      log("[TokenPulse] 正在打开浏览器，请在弹出的窗口里登录你的 OpenAI 账号…");
      await step(python, ["-u", scriptPath(), "login"], env);
    }
    const now = loginInfo();
    if (!now || now.expired) throw new Error(browser.exe ? "没有检测到登录。请再点一次「登录」，在浏览器里登录到能看到 Prism 的界面后，再关掉那个窗口。" : "没有检测到登录完成。请再试一次，并在 5 分钟内登录完。");
    if (now.expiresAt === before) log("[TokenPulse] 登录没有变化，沿用原来的会话。");
  } catch (error) {
    fail(error);
  } finally {
    task = ""; emit();
  }
  if (restart) await startPrism();
}

/** 启动服务，等到它说就绪（唤醒 Chromium 和 Prism 工作区，通常 15 到 25 秒）。 */
export async function startPrism() {
  busy();
  if (phase !== "stopped") return;
  const python = interpreter();
  const login = loginInfo();
  if (!login) throw new Error("请先登录 Prism");
  if (login.expired) throw new Error("Prism 登录已经过期，请重新登录");
  const env = await childEnv();
  if (phase !== "stopped") return;
  lastError = ""; stopping = false; phase = "starting"; emit();
  const child = spawn(python, ["-u", scriptPath(), "serve"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  server = child;
  let reason = "";
  return new Promise<void>((resolve, reject) => {
    pipe(child, (line) => {
      if (/\[fatal\]|\[错误\]|端口 \d+ 已有服务|timeout/i.test(line)) reason = line.trim();
      if (phase === "starting" && line.includes(READY_MARK)) { phase = "running"; emit(); resolve(); }
    });
    const ended = (message: string) => {
      if (server !== child) return;
      server = null;
      const wasStarting = phase === "starting";
      phase = "stopped";
      if (!stopping) { lastError = message; log("[TokenPulse] " + message); }
      emit();
      if (wasStarting) reject(new Error(stopping ? "已停止" : message));
    };
    child.on("error", (error) => ended("启动失败：" + error.message));
    child.on("exit", (code) => ended(reason ? "服务已退出：" + reason : `服务已退出（退出代码 ${code}）`));
  });
}

/** 只结束自己起的那个进程和它带起来的 Chromium。 */
function killTree(child: ChildProcess, sync = false) {
  if (!child.pid || child.exitCode != null) return;
  if (process.platform !== "win32") { child.kill(); return; }
  const args = ["/PID", String(child.pid), "/T", "/F"];
  if (sync) spawnSync("taskkill", args, { windowsHide: true, timeout: 10_000 });
  else execFile("taskkill", args, { windowsHide: true }, () => undefined);
}

export function stopPrism() {
  const child = server;
  if (!child) return Promise.resolve();
  stopping = true;
  return new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    killTree(child);
  });
}

/** 退出 TokenPulse 时：把服务和没做完的安装 / 登录都结束掉，不留进程。 */
export function releasePrism() {
  stopping = true;
  for (const child of [server, worker]) if (child) killTree(child, true);
  if (timer) { clearTimeout(timer); timer = null; }
}

/** 启动 TokenPulse 时：开了「跟着启动」、环境和登录都在，就把服务起起来。失败只记在状态里。 */
export function resumePrism() {
  const state = prismState();
  if (!state.autoStart || !state.available || !state.deps || !state.login || state.login.expired) return;
  void startPrism().catch(() => undefined);
}
