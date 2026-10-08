/*
 * tokens.ci 自动上传的调度和执行（0.3.38），规则见 core/tokens-ci.ts。
 *
 * - 计时完全在 TokenPulse 里：每 30 秒看一眼到没到点，不用一个长长的 setTimeout（电脑睡眠醒来后也不会错过太久）；
 *   打开软件时可以先传一次（设置里可关）。上一次（不管成功失败）之后隔够设定的间隔再传，失败不会连着重试。
 * - 同一时间只跑一个官方工具进程；上传和预览最多 5 分钟、登录最多 10 分钟，超时连同子进程一起结束；退出软件时也一样。
 * - 只保存设置、上一次的时间和结果、输出的最后一小段（令牌已遮掉）。隐私模式的只读令牌只在内存里交给界面显示一次。
 */
import { spawn } from "child_process";
import { dataFile, readJson, writeJson } from "../core/paths";
import { authProblem, commandLine, defaultSettings, loggedIn, nextDue, normalizeSettings, plain, readLogin, redact, summaryOf, tail, validVersion, type TokensSettings } from "../core/tokens-ci";
import { envHasProxy, proxyFor } from "../core/upstream-proxy";

type Exit = { code: number | null; output: string; timedOut: boolean; error?: string };
export type Runner = (line: string, options: { env: NodeJS.ProcessEnv; timeoutMs: number; onData?: (text: string) => void }) => { done: Promise<Exit>; kill: () => void };
type Trigger = "launch" | "schedule" | "manual";
type RunRecord = { at: number; trigger: Trigger; ok: boolean; ms: number; summary: string; error?: string; output: string };
type Job = "submit" | "preview" | "login" | "check";
type LoginState = { privacy: "public" | "private"; startedAt: number; url: string; code: string; done: boolean; ok: boolean; error?: string; readToken?: string };

const RUN_TIMEOUT_MS = 5 * 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const CHECK_TIMEOUT_MS = 60_000;
const TICK_MS = 30_000;
const KEEP_OUTPUT = 6000;
const KEEP_PREVIEW = 60_000;

/** 默认的执行方式：交给 shell（Windows 上 npx / tokens 都是 .cmd，必须经 cmd 才能跑），不弹窗口；结束时连子进程一起结束。 */
export const defaultRunner: Runner = (line, { env, timeoutMs, onData }) => {
  let output = "", timedOut = false;
  const child = spawn(line, { shell: true, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
  const kill = () => {
    if (child.exitCode != null || child.signalCode != null || !child.pid) return;
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
    else child.kill("SIGTERM");
  };
  const take = (chunk: Buffer) => { const text = chunk.toString("utf8"); output = tail(output + text, 200_000); onData?.(output); };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  const done = new Promise<Exit>((resolve) => {
    child.once("error", (error) => { clearTimeout(timer); resolve({ code: null, output, timedOut, error: error.message }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, output, timedOut }); });
  });
  return { done, kill };
};

export class TokensUploader {
  private settings: TokensSettings = defaultSettings();
  private last: RunRecord | null = null;
  private preview: { at: number; ok: boolean; output: string } | null = null;
  private loginState: LoginState | null = null;
  private job: { kind: Job; kill: () => void } | null = null;
  private paused = false;
  private failures = 0;
  private tools: { checked: boolean; npx: boolean; installed: boolean; latest: string; error: string } = { checked: false, npx: false, installed: false, latest: "", error: "" };
  private timer?: ReturnType<typeof setInterval>;
  private launchTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly runner: Runner;
  private readonly now: () => number;
  private readonly file = dataFile("tokens-ci.json");

  constructor(private options: { publish?: (state: unknown) => void; runner?: Runner; now?: () => number; launchDelayMs?: number; tickMs?: number } = {}) {
    this.runner = options.runner ?? defaultRunner;
    this.now = options.now ?? Date.now;
    const stored = readJson<Record<string, unknown>>(this.file, {});
    this.settings = normalizeSettings(stored.settings);
    const last = stored.last as RunRecord | undefined;
    if (last && typeof last.at === "number" && typeof last.ok === "boolean") this.last = { at: last.at, trigger: last.trigger, ok: last.ok, ms: Number(last.ms) || 0, summary: String(last.summary || "").slice(0, 200), ...(last.error ? { error: String(last.error).slice(0, 300) } : {}), output: tail(String(last.output || ""), KEEP_OUTPUT) };
    this.paused = stored.paused === true;
    this.failures = Number(stored.failures) || 0;
  }

  state() {
    const signedIn = loggedIn();
    return {
      settings: this.settings,
      loggedIn: signedIn,
      paused: this.paused,
      failures: this.failures,
      running: this.job?.kind ?? null,
      last: this.last,
      nextAt: signedIn ? nextDue(this.settings, this.paused) : null,
      preview: this.preview,
      login: this.loginState,
      tools: this.tools,
      command: commandLine(this.settings, ["submit"]).replace(/^"[^"]*" "[^"]*"/, "tokens"),
    };
  }
  private publish() { if (!this.stopped) this.options.publish?.(this.state()); }
  private persist() {
    try { writeJson(this.file, { settings: this.settings, last: this.last, paused: this.paused, failures: this.failures }); } catch { /* 写不了就算了，下次启动从默认开始 */ }
  }

  start() {
    this.timer = setInterval(() => this.tick(), this.options.tickMs ?? TICK_MS);
    this.timer.unref?.();
    if (this.settings.enabled && this.settings.onLaunch && !this.paused && loggedIn()) {
      // 等界面和第一份统计先出来再传，不和启动抢资源
      this.launchTimer = setTimeout(() => { void this.upload("launch"); }, this.options.launchDelayMs ?? 20_000);
      this.launchTimer.unref?.();
    }
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.launchTimer) clearTimeout(this.launchTimer);
    this.job?.kill();
  }
  tick() {
    if (this.job || this.stopped || !loggedIn()) return;
    const due = nextDue(this.settings, this.paused);
    if (due != null && this.now() >= due) void this.upload("schedule");
  }

  /** 设置页改了什么。enabled 从关到开时不立刻传（界面上「开启并立即上传」会接着调 upload）。 */
  save(patch: unknown) {
    const before = this.settings;
    this.settings = normalizeSettings({ ...before, ...(patch && typeof patch === "object" ? patch : {}), lastRunAt: before.lastRunAt, username: before.username });
    if (!this.settings.enabled) this.paused = false;
    this.persist();
    this.publish();
    return this.state();
  }

  /** 设置流程第一步：有没有 npx / 本机装好的 tokens，tokens-cli 现在最新是哪个版本。 */
  async check() {
    if (this.job) return this.state();
    this.job = { kind: "check", kill: () => undefined };
    this.publish();
    try {
      const env = await this.env();
      const where = process.platform === "win32" ? "where" : "command -v";
      const [npx, installed] = await Promise.all([
        this.runner(`${where} npx`, { env, timeoutMs: 10_000 }).done,
        this.runner(`${where} tokens`, { env, timeoutMs: 10_000 }).done,
      ]);
      const hasNpx = npx.code === 0 || Boolean(env.TOKENPULSE_TOKENS_CLI);
      let latest = "", error = "";
      if (hasNpx) {
        const view = env.TOKENPULSE_TOKENS_CLI ? await this.runner(commandLine(this.settings, ["version"]), { env, timeoutMs: CHECK_TIMEOUT_MS }).done : await this.runner("npm view tokens-cli version", { env, timeoutMs: CHECK_TIMEOUT_MS }).done;
        latest = plain(view.output).split(/\s+/).find(validVersion) || "";
        if (!latest) error = view.timedOut ? "查询 tokens-cli 的版本超时（可能需要代理）" : "查不到 tokens-cli 的版本（npm 连不上？）";
      } else error = "这台电脑上没有 npx：需要先安装 Node.js";
      this.tools = { checked: true, npx: hasNpx, installed: installed.code === 0, latest, error };
      if (latest && !this.settings.version) this.settings = { ...this.settings, version: latest };
      this.persist();
    } finally {
      this.job = null;
      this.publish();
    }
    return this.state();
  }

  /** 固定版本换成刚查到的最新版。 */
  useLatestVersion() {
    if (validVersion(this.tools.latest)) { this.settings = { ...this.settings, version: this.tools.latest }; this.persist(); }
    this.publish();
    return this.state();
  }

  async upload(trigger: Trigger) {
    if (this.job) return this.state();
    if (trigger !== "manual" && (!this.settings.enabled || this.paused)) return this.state();
    const started = this.now();
    const result = await this.run("submit", ["submit"], RUN_TIMEOUT_MS);
    if (!result) return this.state();
    const ok = result.code === 0 && !result.timedOut;
    const output = tail(redact(plain(result.output)), KEEP_OUTPUT);
    const error = ok ? undefined : result.timedOut ? "超过 5 分钟还没传完，已经停下" : result.error ? `没能运行 tokens.ci 的工具：${result.error}` : !loggedIn() || authProblem(result.output) ? "tokens.ci 登录已失效，请重新登录" : summaryOf(result.output) || `上传失败（退出码 ${result.code}）`;
    this.last = { at: started, trigger, ok, ms: this.now() - started, summary: ok ? summaryOf(result.output) : "", ...(error ? { error } : {}), output };
    this.settings = { ...this.settings, lastRunAt: started };
    this.failures = ok ? 0 : this.failures + 1;
    if (!ok && (!loggedIn() || authProblem(result.output))) this.paused = true;
    if (ok) this.paused = false;
    this.persist();
    this.publish();
    return this.state();
  }

  /** 预览：工具的 --dry-run，只看会传什么，不上传。 */
  async dryRun() {
    if (this.job) return this.state();
    const result = await this.run("preview", ["submit", "--dry-run"], RUN_TIMEOUT_MS);
    if (!result) return this.state();
    const ok = result.code === 0 && !result.timedOut;
    this.preview = { at: this.now(), ok, output: tail(redact(plain(result.output)), KEEP_PREVIEW) || (result.error ? `没能运行 tokens.ci 的工具：${result.error}` : "") };
    this.publish();
    return this.state();
  }

  /** 登录（设备码流程）：工具打印网址和一次性码、自己打开浏览器，然后等用户在浏览器里授权。 */
  async login(privacy: unknown) {
    if (this.job) return this.state();
    const mode = privacy === "private" ? "private" : privacy === "public" ? "public" : null;
    if (!mode) throw new Error("请先选公开上榜还是隐私模式");
    this.loginState = { privacy: mode, startedAt: this.now(), url: "", code: "", done: false, ok: false };
    const result = await this.run("login", mode === "private" ? ["login", "--private"] : ["login"], LOGIN_TIMEOUT_MS, (output) => {
      const seen = readLogin(output);
      if (this.loginState && (seen.url !== this.loginState.url || seen.code !== this.loginState.code)) { this.loginState = { ...this.loginState, url: seen.url, code: seen.code }; this.publish(); }
    });
    if (!result || !this.loginState) return this.state();
    const seen = readLogin(result.output);
    const ok = result.code === 0 && !result.timedOut && loggedIn();
    if (ok && seen.username) this.settings = { ...this.settings, username: seen.username };
    if (ok) { this.paused = false; this.failures = 0; }
    this.loginState = { ...this.loginState, done: true, ok, ...(ok && mode === "private" && seen.readToken ? { readToken: seen.readToken } : {}),
      ...(ok ? {} : { error: result.timedOut ? "10 分钟内没有完成授权，已经停下" : result.code === null && !result.error ? "已取消登录" : summaryOf(result.output) || result.error || "登录没有成功" }) };
    this.persist();
    this.publish();
    return this.state();
  }
  cancelJob() { this.job?.kill(); return this.state(); }
  /** 界面看过登录结果（和只读令牌）了：从内存里清掉。 */
  clearLogin() { this.loginState = null; this.publish(); return this.state(); }
  clearPreview() { this.preview = null; this.publish(); return this.state(); }
  /** 「重试」：从等待重新登录的状态里出来（比如用户在终端里自己登录过了）。 */
  resume() { this.paused = false; this.persist(); this.publish(); return this.state(); }

  private async run(kind: Job, args: string[], timeoutMs: number, onData?: (text: string) => void) {
    let line: string;
    try { line = commandLine(this.settings, args); } catch { return null; }
    const env = await this.env();
    if (this.job || this.stopped) return null;
    const handle = this.runner(line, { env, timeoutMs, onData });
    let cancelled = false;
    this.job = { kind, kill: () => { cancelled = true; handle.kill(); } };
    this.publish();
    try {
      const result = await handle.done;
      return cancelled && !result.timedOut ? { ...result, code: null } : result;
    } finally {
      this.job = null;
    }
  }

  /** 子进程的环境：不要颜色；环境变量里没设代理、系统代理开着时补上（tokens.ci 和 npm 都认 HTTPS_PROXY）。 */
  private async env(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };
    if (env.TOKENPULSE_TOKENS_CLI) env.ELECTRON_RUN_AS_NODE = "1";
    const target = new URL("https://tokens.ci/");
    if (!envHasProxy(target)) {
      const proxy = await proxyFor(target).catch(() => null);
      if (proxy) {
        let auth = "";
        if (proxy.auth) { try { auth = Buffer.from(proxy.auth.replace(/^Basic\s+/i, ""), "base64").toString("utf8").split(":").map(encodeURIComponent).join(":") + "@"; } catch { auth = ""; } }
        env.HTTPS_PROXY = env.HTTP_PROXY = `http://${auth}${proxy.host}:${proxy.port}`;
      }
    }
    return env;
  }
}
