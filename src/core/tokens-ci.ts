/*
 * tokens.ci 自动上传（0.3.38）：TokenPulse 定时替用户跑一次 tokens.ci 官方命令行工具的 submit。
 *
 * - 不自己实现上传：tokens.ci 的提交接口没有公开文档，排行榜上的数字也是它自己的工具扫出来的，
 *   我们按自己的口径算一份传上去会和别人的对不上。所以只负责「按时运行官方工具」。
 * - 不碰它的登录凭据：只看凭据文件在不在，不读内容；登录走它自己的设备码流程（打印网址和一次性码、自动开浏览器）。
 * - 定时完全由 TokenPulse 管（main/tokens-ci.ts），不往系统里加计划任务。
 *
 * 这个文件只放不依赖 Electron 的部分：设置的规整、命令怎么拼、输出怎么读。
 */
import fs from "fs";
import os from "os";
import path from "path";

export const PACKAGE = "tokens-cli";
export const MIN_INTERVAL_MIN = 10;
export const MAX_INTERVAL_MIN = 24 * 60;
export const DEFAULT_INTERVAL_MIN = 60;

/** pinned：固定一个版本（推荐，不会每次自动换成新代码）；latest：每次用最新版；installed：本机装好的 tokens 命令。 */
export type Channel = "pinned" | "latest" | "installed";
export type TokensSettings = {
  /** 用户走完了设置流程、打开了定时上传。 */
  enabled: boolean;
  intervalMin: number;
  /** 每次打开 TokenPulse 时先上传一次。 */
  onLaunch: boolean;
  channel: Channel;
  /** channel 为 pinned 时用的版本。 */
  version: string;
  /** 用户点了「不需要」：用量明细里不再出现介绍卡。 */
  dismissed: boolean;
  /** 登录时工具说的用户名（不是凭据，只用来显示）。 */
  username: string;
  lastRunAt: number;
};

export function defaultSettings(): TokensSettings {
  return { enabled: false, intervalMin: DEFAULT_INTERVAL_MIN, onLaunch: true, channel: "pinned", version: "", dismissed: false, username: "", lastRunAt: 0 };
}

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,40})?$/;
export const validVersion = (value: unknown): value is string => typeof value === "string" && VERSION.test(value);

/** 读回来的设置可能是旧的、坏的或者被手改过：每一项都规整一遍。 */
export function normalizeSettings(raw: unknown, base: TokensSettings = defaultSettings()): TokensSettings {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const minutes = Math.round(Number(value.intervalMin));
  const channel = value.channel === "latest" || value.channel === "installed" || value.channel === "pinned" ? value.channel : base.channel;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : base.enabled,
    intervalMin: Number.isFinite(minutes) && value.intervalMin !== undefined ? Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, minutes)) : base.intervalMin,
    onLaunch: typeof value.onLaunch === "boolean" ? value.onLaunch : base.onLaunch,
    channel,
    version: validVersion(value.version) ? value.version : base.version,
    dismissed: typeof value.dismissed === "boolean" ? value.dismissed : base.dismissed,
    username: typeof value.username === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(value.username) ? value.username : base.username,
    lastRunAt: Number.isFinite(Number(value.lastRunAt)) && Number(value.lastRunAt) >= 0 ? Number(value.lastRunAt) : base.lastRunAt,
  };
}

/** tokens.ci 工具放配置的地方（和它自己的 paths.rs 一致）：TOKENS_CONFIG_DIR，否则 Windows 是 %APPDATA%\tokens。 */
export function tokensConfigDir(env: NodeJS.ProcessEnv = process.env) {
  if (env.TOKENS_CONFIG_DIR) return env.TOKENS_CONFIG_DIR;
  if (process.platform === "win32") return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "tokens");
  if (process.platform === "darwin") return path.join(os.homedir(), ".config", "tokens");
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "tokens");
}
/** 登录过没有：只看凭据文件在不在，不读里面的内容。旧版本放在 ~/.config/tokens 的也算。 */
export function loggedIn(env: NodeJS.ProcessEnv = process.env) {
  const files = [path.join(tokensConfigDir(env), "credentials.json")];
  if (!env.TOKENS_CONFIG_DIR) files.push(path.join(os.homedir(), ".config", "tokens", "credentials.json"));
  return files.some((file) => { try { return fs.statSync(file).size > 0; } catch { return false; } });
}

/**
 * 要跑的命令（交给 shell 执行的一行）。只由固定的词和校验过的版本号拼成，没有用户输入。
 * TOKENPULSE_TOKENS_CLI：测试用，指向一个模拟 tokens 工具的脚本。
 */
export function commandLine(settings: Pick<TokensSettings, "channel" | "version">, args: string[], env: NodeJS.ProcessEnv = process.env, node = process.execPath) {
  for (const arg of args) if (!/^(?:--)?[a-z][a-z-]*$/.test(arg)) throw new Error("不支持的参数");
  const tail = args.join(" ");
  if (env.TOKENPULSE_TOKENS_CLI) return `"${node}" "${env.TOKENPULSE_TOKENS_CLI}" ${tail}`;
  if (settings.channel === "installed") return `tokens ${tail}`;
  const version = settings.channel === "pinned" && validVersion(settings.version) ? settings.version : "latest";
  return `npx --yes ${PACKAGE}@${version} ${tail}`;
}

/** 终端颜色、光标控制之类的转义序列去掉，只留文字。 */
export function plain(text: string) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r(?!\n)/g, "\n");
}

/** 输出里可能出现的令牌（只读令牌 tkr_…、提交令牌之类）：存下来、显示出来之前一律遮掉。 */
export function redact(text: string) {
  return text.replace(/\btk[a-z]{0,2}_[A-Za-z0-9_-]{6,}/g, (token) => token.slice(0, 4) + "…");
}

/** 只留最后 max 个字符（从整行开始）。 */
export function tail(text: string, max: number) {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  const line = cut.indexOf("\n");
  return line >= 0 && line < 200 ? cut.slice(line + 1) : cut;
}

/** 登录时工具打印的东西：授权网址、一次性码、（隐私模式）只读令牌、用户名。 */
export function readLogin(output: string) {
  const text = plain(output);
  const url = /https:\/\/[^\s"'<>]+/.exec(text)?.[0] || "";
  const code = /Enter this code:?\s*\n?\s*([A-Z0-9][A-Z0-9-]{3,15})\b/i.exec(text)?.[1] || "";
  const readToken = /\btkr_[A-Za-z0-9_-]{6,}/.exec(text)?.[0] || "";
  const username = /(?:Logged in as|Signed in as|Welcome,?)\s+@?([A-Za-z0-9_.-]{1,60})/i.exec(text)?.[1] || "";
  return { url, code, readToken, username };
}

/** 失败是不是因为没登录 / 登录失效：是的话定时上传先停下，等用户重新登录，免得一直失败一直提醒。 */
export function authProblem(output: string) {
  return /not logged in|run ['`]?tokens login|unauthori[sz]ed|\b401\b|invalid (?:api )?token|token (?:is )?(?:expired|revoked)/i.test(plain(output));
}

/** 一次上传的结果说成一句话：取输出里最后一行有内容的话。 */
export function summaryOf(output: string) {
  const lines = plain(output).split("\n").map((line) => line.trim()).filter((line) => line && !/^[─━=\-–—\s]+$/.test(line));
  return redact(lines.at(-1) || "").slice(0, 200);
}

/** 下一次该什么时候传。没打开、或者在等重新登录：不传。 */
export function nextDue(settings: TokensSettings, paused: boolean) {
  if (!settings.enabled || paused) return null;
  return (settings.lastRunAt || 0) + settings.intervalMin * 60_000;
}
