import { ExitMonitor } from "./egress-monitor";
import { DOMAINS } from "../core/egress";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, session, shell, Tray } from "electron";
import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import { dataDir } from "../core/paths";
import { fetchOfficialQuota } from "../core/quota";
import type { Snapshot } from "../core/report";
import { updateCalibration } from "../core/quota-calibration";
import { updateMark } from "../core/quota-offmachine";
import { parseModelStudyQuery } from "../core/model-study";
import { modelCandidates, parseStudyModels } from "../core/model-catalog";
import { FAMILY as STUDY_FAMILY } from "../core/quota-offmachine";
import { loadModelStudy, loadRequests, loadSessionDetail, loadSessions, loadSnapshot } from "./snapshot";
import { sessionCommand, type AgentKind } from "../core/sessions";
import { cleanAgentEnv, deleteSession as deleteAgentSession, guardMode, openTerminal, resolveCli, startReply, stopAllReplies, stopReply, type ReplyMode } from "./session-reply";
import { checkKnowledge, knowledgeState, scheduleKnowledgeChecks } from "./knowledge-update";
import type { RequestQuery } from "../core/request-log";
import { prefsExist, readPrefs, writePrefs, type Prefs } from "./prefs";
import { demoCall, endDemo } from "./demo";
import { envProxyFor, setSystemProxyResolver } from "../core/upstream-proxy";
import { tr } from "./i18n";
import { trayIcon, windowIcon } from "./icon";
import { checkForUpdates, consumeRelaunchHidden, downloadUpdate, initUpdater, installUpdate, onWindowAway, setAutoUpdate, updateState } from "./updater";
import { listOfficialOAuthStatus, loginOfficialOAuth, manageOfficialAccount, reorderOfficialAccountsOf } from "./oauth";
import { migrateLegacyGrokAccounts } from "../core/grok-migrate";
import { OFFICIAL_KINDS, type OfficialAccountKind } from "../core/credentials";
import { activateProvider, agentDrift, agentView as coreAgentView, deleteProvider, importCcProviders, importCurrent, listProviderModels, probeProvider, releaseAgentSwitch, restoreConfigBackup, waitAgentProxyClosed, reorderProviders, resumeAgentProxy, saveProvider, setAppProxy, setFailover, setProxyPort } from "../core/agent-switch";
import { configExpect, configPreview, configReason, configureReadOnly } from "../core/agent-config";
import { changeSignature, fileDiff, listHistory, listOriginals, type FileChange } from "../core/agent-history";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { AGENT_APPS, AGENT_LABEL, isAgentApp } from "../core/agent-types";

/**
 * TokenPulse 的主进程。
 *
 * 它是个**常驻后台的托盘程序**：窗口关掉照样在跑，因为这个工具的全部意义
 * 就是「电脑开着的时候一直记」。真要退出得从托盘菜单走。
 *
 * 两个定时器，节奏不一样：
 * - 扫本机会话文件：1 分钟一次。纯本地读文件，增量扫（只读新增的字节），很便宜。
 * - 问官方额度接口：5 分钟一次。这是网络请求，而且额度本身也就几分钟才动一格，
 *   问太勤没意义还容易被限流。
 */

const SCAN_EVERY_MS = 60_000;
const QUOTA_EVERY_MS = 5 * 60_000;

let win: BrowserWindow | null = null;
/** 上次是在托盘里被自动更新重启的：这次启动也只进托盘，别弹窗口打扰用户。 */
let relaunchHidden = false;
let tray: Tray | null = null;
let quitting = false;
const exitMonitor = new ExitMonitor({
  publish: snapshot => { if (win && !win.isDestroyed()) win.webContents.send("egress-state", snapshot); },
  notify: event => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: tr("出口监控") + " · " + DOMAINS[event.provider].name, body: tr(event.message) + (event.ip ? " · " + event.ip : "") + (event.region ? " · " + event.region : ""), icon: windowIcon() });
    notification.on("click", () => { revealWindow(); win?.webContents.send("open-page", { page: "egress" }); });
    notification.show();
  },
});
/** 「账号:窗口」→ 已经提醒过的那个窗口的重置时间。同一个窗口只提醒一次。 */
const notified = new Map<string, number>();
/** 两次重置时间差不到这么多，就当是同一个窗口（接口返回的时间有抖动，见 maybeNotify）。 */
const SAME_WINDOW_MS = 30 * 60_000;

const BACKGROUND = { light: "#f7f8fa", dark: "#15181c" } as const;

/* ---------------- 窗口 ---------------- */

function createWindow() {
  const next = new BrowserWindow({
    width: 1380,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // 跟界面主题一致，否则拉大窗口、首帧没画完时会闪一下反色的底。
    backgroundColor: BACKGROUND[readPrefs().theme],
    /*
     * 自己画标题栏（renderer 的 #titlebar）：系统那条跟着 Windows 的主题色走，
     * 软件切到夜间时顶上还是一条白的，关闭按钮那一行和界面对不上。
     */
    frame: false,
    title: "TokenPulse",
    icon: windowIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win = next;
  // Windows 有时会忽略 BrowserWindow options 里的 PNG 图标，显式设置 ICO 可避免任务栏回退到 Electron 图标。
  if (process.platform === "win32") next.setIcon(windowIcon());
  next.loadFile(path.join(__dirname, "..", "..", "renderer", "index.html"));
  next.once("ready-to-show", () => {
    if (!process.argv.includes("--hidden") && !readPrefs().startMinimized && !relaunchHidden) next.show();
  });
  // 外链走系统浏览器，别在应用里开一个没有地址栏的窗口。
  next.webContents.setWindowOpenHandler(({ url }) => {
    // 只放行网页链接：别让页面里的内容拿 file: / 自定义协议去启动本机程序
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  next.on("close", (event) => {
    if (quitting || !readPrefs().closeToTray) return;
    event.preventDefault();
    next.hide();
  });
  next.on("closed", () => {
    if (win === next) win = null;
  });
  // 用户不在看窗口了：下载好的更新趁这个时候静默装上（见 updater.ts）。
  next.on("hide", onWindowAway);
  next.on("minimize", onWindowAway);
  const sendState = () => next.webContents.send("window-state", { maximized: next.isMaximized() });
  next.on("maximize", sendState);
  next.on("unmaximize", sendState);
  return next;
}

function revealWindow() {
  if (!win) {
    // 窗口已经被销毁过（关窗口即退出关掉了、或者 macOS 上全关了）：重新建一个。
    const next = createWindow();
    next.once("ready-to-show", () => next.show());
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ---------------- 托盘 ---------------- */

function buildTrayMenu() {
  const prefs = readPrefs();
  return Menu.buildFromTemplate([
    { label: tr("打开 TokenPulse"), click: revealWindow },
    { type: "separator" },
    ...agentTrayItems(),
    { type: "separator" },
    {
      label: tr("立即刷新"),
      click: () => {
        backgroundRefresh(true);
      },
    },
    {
      label: tr("开机自启"),
      type: "checkbox",
      checked: prefs.autoLaunch,
      click: (item) => applyPrefs({ autoLaunch: item.checked }),
    },
    { label: tr("打开数据目录"), click: () => shell.openPath(dataDir()) },
    { type: "separator" },
    {
      label: tr("退出"),
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function agentTrayItems() {
  try {
    const view = agentView();
    return AGENT_APPS.map((app) => {
      const rows = view.providers.filter((item) => item.app === app && !item.locked);
      const current = rows.find((item) => item.active);
      return {
        label: (current ? `${AGENT_LABEL[app]} · ${current.name}` : AGENT_LABEL[app]) + (view.readOnly ? tr("（只读保护）") : ""),
        submenu: rows.length
          ? rows.map((item) => ({
              label: item.active ? `${item.name}  ✓` : item.name,
              enabled: !view.readOnly || item.active,
              // 切换会改工具配置：打开窗口，在供应商页里看过改动对比、确认后才写（只读保护开着时不能切）
              click: () => {
                revealWindow();
                win?.webContents.send("agent-activate-request", item.id);
              },
            }))
          : [{ label: tr("还没有供应商"), enabled: false }],
      };
    });
  } catch {
    return [];
  }
}

function publishAgent() {
  tray?.setContextMenu(buildTrayMenu());
  if (win && !win.isDestroyed()) win.webContents.send("agent-switch", agentView());
}

/**
 * Electron 内核（自动更新、知识库更新用的 net）只认系统代理，不认 HTTPS_PROXY 这类环境变量。
 * 系统代理没开、环境变量里有 HTTP 代理（不带用户名密码）时，把它设成这个会话的代理；系统代理开着就不动，照系统的走。
 */
async function alignElectronProxy() {
  const probe = new URL("https://github.com/");
  const proxy = envProxyFor(probe);
  if (!proxy || proxy.auth) return;
  const system = await session.defaultSession.resolveProxy(probe.href);
  if (!/^\s*DIRECT\s*$/i.test(system)) return;
  const bypass = (process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((item) => item.trim()).filter((item) => item && item !== "*");
  await session.defaultSession.setProxy({ proxyRules: `http=${proxy.host}:${proxy.port};https=${proxy.host}:${proxy.port}`, proxyBypassRules: ["<local>", ...bypass].join(",") });
}

/** 界面上的供应商状态：多带一个「只读保护」开关。 */
function agentView() {
  return { ...coreAgentView(), readOnly: readPrefs().agentReadOnly === true };
}

async function agentCall<T>(work: () => T | Promise<T>, reason = "") {
  configReason(reason);
  try {
    const result = await work();
    publishAgent();
    return { ok: true as const, result, state: agentView() };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "操作失败" };
  } finally {
    configReason("");
  }
}

/*
 * 会改工具配置的操作先「预览」：同样的操作跑一遍，只收集改动、不写文件（agent-config.ts 的 configPreview）。
 * - 只改 TokenPulse 自己的供应商列表 → 直接做；
 * - 要改 Claude / Codex / Grok 的配置文件 → 把逐行对比（密钥打码）交给界面，用户确认后按 token 执行；
 *   执行时核对改动和确认时一模一样，中间文件被别的程序改过就不写。
 */
const confirms = new Map<string, { work: () => unknown; reason: string; signature: string; at: number }>();
async function agentWrite(reason: string, work: () => unknown, restoring = false) {
  let changes: FileChange[];
  configReason(reason);
  try { changes = await configPreview(work); }
  catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "操作失败" }; }
  finally { configReason(""); }
  if (!changes.length) return agentCall(work, reason);
  // 只读保护只拦「接管」：关闭路由、还原备份这类把配置放回去的操作照常（仍要确认）
  if (readPrefs().agentReadOnly && !restoring) return { ok: false as const, error: "只读保护已开启：这个操作要改动工具的配置文件，已拦下。需要切换时，先在供应商页关闭只读保护。" };
  for (const [key, item] of confirms) if (Date.now() - item.at > 10 * 60000) confirms.delete(key);
  const token = randomUUID();
  confirms.set(token, { work, reason, signature: changeSignature(changes), at: Date.now() });
  return { ok: false as const, confirm: { token, reason, files: changes.map(fileDiff) } };
}
async function agentConfirm(token: unknown) {
  const item = typeof token === "string" ? confirms.get(token) : undefined;
  if (!item) return { ok: false as const, error: "这次确认已经过期，请重新操作" };
  confirms.delete(token as string);
  configExpect(item.signature);
  try { return await agentCall(item.work, item.reason); } finally { configExpect(null); }
}

/*
 * 配置被改走的提醒（0.3.10）：每 5 秒看一眼 TokenPulse 切换过的工具，配置不再指向设好的供应商 / 本地路由时提醒一次。
 * 同一次改动只提醒一次（按配置内容的指纹）；恢复正常后清掉记录，下次再被改走会再提醒。
 * 窗口开着：界面右上角弹窗（带「切回」按钮）；窗口在托盘里：系统通知，点开进供应商页。
 */
const driftSeen = new Map<string, string>();
function checkDrift() {
  let drifts: ReturnType<typeof agentDrift>;
  try { drifts = agentDrift(); } catch { return; }
  for (const app of [...driftSeen.keys()]) if (!drifts.some((d) => d.app === app)) driftSeen.delete(app);
  const fresh = drifts.filter((d) => driftSeen.get(d.app) !== d.key);
  if (!fresh.length) return;
  for (const d of fresh) driftSeen.set(d.app, d.key);
  win?.webContents.send("agent-drift", fresh);
  const away = !win || win.isDestroyed() || !win.isVisible() || win.isMinimized();
  if (away && Notification.isSupported()) for (const d of fresh) {
    const note = new Notification({ title: `${AGENT_LABEL[d.app]} · ${tr("没在用 TokenPulse 设好的供应商")}`, body: `${tr("现在连的是")}「${d.liveName}」${tr("，不是")}「${d.expectedName}」${tr("。点这里打开 TokenPulse 切回。")}`, icon: windowIcon() });
    note.on("click", () => { revealWindow(); win?.webContents.send("open-page", { page: "providers" }); win?.webContents.send("agent-drift", [d]); });
    note.show();
  }
}

/** 配置备份列表：历史每一次修改（前后对比），和接管前的原件（和现在的文件对比）。都打码。 */
function agentBackups() {
  const read = (file: string) => { try { return readFileSync(file, "utf8"); } catch { return null; } };
  return {
    readOnly: readPrefs().agentReadOnly === true,
    entries: listHistory().map((entry) => ({ id: entry.id, at: entry.at, reason: entry.reason, files: entry.files.map(fileDiff) })),
    originals: listOriginals().map((item) => ({ id: item.id, at: item.at, ...fileDiff({ file: item.file, before: read(item.file), after: item.content }) })),
  };
}

function initTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("TokenPulse — Your AI usage, at a glance.");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", revealWindow);
  tray.on("double-click", revealWindow);
}

const KIND_NAMES: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", grok: "Grok" };

/** 一家不止一个账号、或起过名字时带上短名，否则只写家名。短名在报表里算好。 */
function accountTitle(account: Snapshot["accounts"][number]) {
  const name = KIND_NAMES[account.kind] ?? account.kind;
  return account.displayName ? `${name} · ${account.displayName}` : name;
}

/**
 * 托盘悬停时显示各账号当前的额度，不用开窗口就能看一眼。
 * Windows 的托盘提示最多 127 个字符，多出来的直接被切掉。先翻译再按这个上限收：
 * 放得下的按原来的顺序留着，剩下的收成一行「还有 n 个」。
 */
const TRAY_TIP_MAX = process.platform === "win32" ? 127 : 1000;
function clipTip(text: string, max: number) {
  if (text.length <= max) return text;
  return max < 2 ? "" : `${text.slice(0, max - 1)}…`;
}
function updateTrayTip(snapshot: Snapshot) {
  if (!tray) return;
  const head = tr(`TokenPulse · 今日 ${formatTokens(snapshot.totals.today.tokens)} tokens`);
  const lines = snapshot.accounts.map((account) => {
    const week = account.week ? tr(`周 ${Math.round(account.week.used)}%`) : "";
    const five = account.five ? `5h ${Math.round(account.five.used)}%` : "";
    return [accountTitle(account), [five, week].filter(Boolean).join("  ")].filter(Boolean).join("  ");
  });
  const kept: string[] = [];
  let used = head.length;
  for (let i = 0; i < lines.length; i++) {
    const omitted = lines.length - i - 1;
    const reserve = omitted > 0 ? 1 + tr(`还有 ${omitted} 个`).length : 0;
    const extra = 1 + lines[i].length;
    if (used + extra + reserve <= TRAY_TIP_MAX) {
      kept.push(lines[i]);
      used += extra;
      continue;
    }
    if (!kept.length) {
      const clipped = clipTip(lines[i], TRAY_TIP_MAX - used - 1 - reserve);
      if (clipped) kept.push(clipped);
    }
    break;
  }
  const omitted = lines.length - kept.length;
  const body = omitted > 0 ? [...kept, tr(`还有 ${omitted} 个`)] : kept;
  tray.setToolTip([head, ...body].join(String.fromCharCode(10)));
}

function formatTokens(value: number) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

/* ---------------- 提醒 ---------------- */

/**
 * 额度过线弹一次通知。
 * 按「账号 + 窗口」记住提醒过的那个重置时间 —— 窗口一重置，重置时间往后跳，
 * 下个窗口再过线会重新提醒，但同一个窗口里不会反复吵。
 *
 * 不能拿重置时间原样当去重键：Claude 每次返回的 resets_at 都有几百毫秒抖动，
 * 键每次都不一样，过线之后就变成每 5 分钟弹一次。
 */
function maybeNotify(snapshot: Snapshot) {
  const limit = readPrefs().notifyAt;
  if (!limit || !Notification.isSupported()) return;
  const fresh: { title: string; body: string }[] = [];
  for (const account of snapshot.accounts) {
    for (const [label, report] of [
      ["5 小时", account.five],
      ["周", account.week],
    ] as const) {
      if (!report || report.used < limit) continue;
      const key = `${account.key ?? account.kind}:${label}`;
      const resetAt = report.resetAt ?? 0;
      const previous = notified.get(key);
      if (previous != null && Math.abs(resetAt - previous) < SAME_WINDOW_MS) continue;
      notified.set(key, resetAt);
      fresh.push({
        title: `${accountTitle(account)} ${label}额度已用 ${Math.round(report.used)}%`,
        body: report.resetAt ? `${new Date(report.resetAt).toLocaleString()} 重置` : "注意节奏",
      });
    }
  }
  if (!fresh.length) return;
  // 一家好几个账号同时过线时，每个窗口各弹一条会叠成一串。同一次刷新里多条合成一条。
  if (fresh.length === 1) {
    new Notification({ title: tr(fresh[0].title), body: tr(fresh[0].body), icon: windowIcon() }).show();
    return;
  }
  const shown = fresh.slice(0, 4);
  const rest = fresh.length - shown.length;
  new Notification({
    title: tr(`${fresh.length} 个额度窗口已过提醒线`),
    body: [...shown.map((item) => tr(item.title)), rest > 0 ? tr(`还有 ${rest} 个`) : ""].filter(Boolean).join(String.fromCharCode(10)),
    icon: windowIcon(),
  }).show();
}

/** 已经通知过的请求，免得同一条在下一轮扫描里又弹一次。 */
const notifiedRequests = new Set<string>();

/**
 * 型号核验出问题的请求，弹一条通知。一轮里有好几条就合成一条，点开直接跳到请求记录。
 * 扫描那边只交最近 15 分钟的，第一次运行补历史时不会刷屏。
 */
function notifyRequests(snapshot: Snapshot) {
  const alerts = (snapshot.requestAlerts ?? []).filter((row) => !notifiedRequests.has(row.key));
  if (!alerts.length || !readPrefs().notifyMismatch || !Notification.isSupported()) return;
  for (const row of alerts) notifiedRequests.add(row.key);
  const mismatch = alerts.filter((row) => row.status === "mismatch");
  const first = mismatch[0] ?? alerts[0];
  const title = mismatch.length
    ? `${mismatch.length} 次请求的返回型号和请求的不一致`
    : `${alerts.length} 次请求的响应存疑`;
  const notification = new Notification({
    title: tr(title),
    body: tr(`${first.source}：${first.reasons[0] ?? first.statusLabel}`),
    icon: windowIcon(),
  });
  notification.on("click", () => {
    revealWindow();
    win?.webContents.send("open-page", { page: "requests", status: mismatch.length ? "mismatch" : "suspect" });
  });
  notification.show();
}

/** 界面传来的查询条件：只收认识的字段，日期格式不对就拒绝。 */
function parseRequestQuery(value: unknown): RequestQuery {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const from = day(input.from);
  const to = day(input.to);
  if (!from || !to) throw new Error("查询日期无效");
  const status = ["all", "match", "mismatch", "suspect", "unverified"].includes(String(input.status)) ? (input.status as RequestQuery["status"]) : "all";
  const sort = ["time", "tokens", "cost"].includes(String(input.sort)) ? (input.sort as RequestQuery["sort"]) : "time";
  return {
    from,
    to,
    source: typeof input.source === "string" ? input.source.slice(0, 40) : "all",
    status,
    search: typeof input.search === "string" ? input.search.slice(0, 200) : "",
    sort,
    page: Math.max(0, Math.floor(Number(input.page) || 0)),
    pageSize: Math.min(200, Math.max(1, Math.floor(Number(input.pageSize) || 20))),
    all: input.all === true,
    account: typeof input.account === "string" && input.account ? input.account.slice(0, 300) : undefined,
    since: Number.isFinite(input.since) ? Number(input.since) : undefined,
    aggregate: input.aggregate === true,
    filteredAggregate: input.filteredAggregate === true,
    models: Array.isArray(input.models) ? [...new Set(input.models.filter((v): v is string => typeof v === "string" && v.length <= 300))].slice(0, 200) : undefined,
    project: typeof input.project === "string" ? input.project.slice(0, 4096) : undefined,
    channel: ["official", "api", "unknown"].includes(String(input.channel)) ? input.channel as RequestQuery["channel"] : "all",
    until: Number.isFinite(input.until) ? Number(input.until) : undefined,
    projects: input.projects === true,
  };
}

/* ---------------- 刷新 ---------------- */

let lastSnapshot: Snapshot | null = null;
let refreshing: Promise<Snapshot> | null = null;
let initialSnapshot: Promise<Snapshot> | null = null;

function publishSnapshot(snapshot: Snapshot): Snapshot {
  lastSnapshot = snapshot;
  updateTrayTip(snapshot);
  win?.webContents.send("snapshot", snapshot);
  return snapshot;
}

function getInitialSnapshot(): Promise<Snapshot> {
  if (lastSnapshot) return Promise.resolve(lastSnapshot);
  if (!initialSnapshot) {
    initialSnapshot = loadSnapshot(false).then(publishSnapshot).finally(() => {
      initialSnapshot = null;
    });
  }
  return initialSnapshot;
}

function backgroundRefresh(withQuota: boolean) {
  void refresh(withQuota).catch((error) => {
    console.error("[TokenPulse] 刷新失败", error);
    win?.webContents.send("refresh-error", "刷新失败，请重试并检查数据目录是否可写。");
  });
}

/**
 * 跑一轮：扫会话文件 +（需要时）问官方额度，然后把新快照推给窗口。
 * `withQuota` 为 false 时只扫本地，用于那个 1 分钟的快节奏定时器。
 */
async function runRefresh(withQuota: boolean): Promise<Snapshot> {
  // 先展示已有统计，再更新本地文件；网络慢或断网时仍然可以使用界面。
  await getInitialSnapshot();
  let snapshot = publishSnapshot(await loadSnapshot(true));
  notifyRequests(snapshot);
  if (withQuota) {
    try {
      // 设了出口 IP 白名单的那家，出口不对就不去问官方（见 egress-monitor.ts 的 gateQuota）
      await fetchOfficialQuota(true, (kind) => exitMonitor.gateQuota(kind));
      snapshot = publishSnapshot(await loadSnapshot(false));
    } catch (error) {
      console.error("[TokenPulse] 额度接口失败", error);
    }
    maybeNotify(snapshot);
  }
  return snapshot;
}

let refreshingQuota = false;
let queuedQuota: Promise<Snapshot> | null = null;

/**
 * 同一时间只跑一轮，重入的调用共用这一次的结果 ——
 * 但正在跑的那轮只扫本地、而这次要问额度时不能共用：手动「刷新数据」
 * 正好撞上 1 分钟的本地扫描，就会拿回一份没问过额度的快照。这种情况排一轮在后面。
 */
function refresh(withQuota: boolean): Promise<Snapshot> {
  if (refreshing) {
    if (!withQuota || refreshingQuota) return refreshing;
    queuedQuota ??= refreshing
      .catch(() => undefined)
      .then(() => {
        queuedQuota = null;
        return refresh(true);
      });
    return queuedQuota;
  }
  refreshingQuota = withQuota;
  // finally 里清状态，排在后面的那轮挂在它之后，看到的一定是已经空出来的 refreshing。
  refreshing = runRefresh(withQuota).finally(() => {
    refreshing = null;
    refreshingQuota = false;
  });
  return refreshing;
}

/* ---------------- 设置 ---------------- */

function appVersion(): string {
  return (require("../../package.json") as { version: string }).version;
}

function applyPrefs(patch: Partial<Prefs>): Prefs {
  if ("agentReadOnly" in patch) patch = { ...patch, agentReadOnly: patch.agentReadOnly === true };
  if ("studyModels" in patch) {
    const raw = patch.studyModels && typeof patch.studyModels === "object" ? patch.studyModels as Record<string, unknown> : {};
    patch = { ...patch, studyModels: Object.fromEntries((["claude", "chatgpt", "grok"] as const).map((kind) => [kind, parseStudyModels(raw[kind])]).filter(([, list]) => (list as unknown[]).length)) };
  }
  if ("seenVersion" in patch) patch = { ...patch, seenVersion: typeof patch.seenVersion === "string" && /^\d+\.\d+\.\d+[\w.-]{0,20}$/.test(patch.seenVersion) ? patch.seenVersion : "" };
  if ("onboarding" in patch && !["", "pending", "done"].includes(patch.onboarding as string)) patch = { ...patch, onboarding: "done" };
  if ("localOnlyAccounts" in patch) {
    const list = Array.isArray(patch.localOnlyAccounts) ? patch.localOnlyAccounts : [];
    patch = { ...patch, localOnlyAccounts: [...new Set(list.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 400))].slice(0, 100) };
  }
  const next = writePrefs(patch);
  // 容量怎么折算变了：不重新查额度，只按新的口径重算一遍快照
  if ("localOnlyAccounts" in patch) backgroundRefresh(false);
  /*
   * 只有打好包的版本才去动开机启动项。
   * 开发时（`npm start`）跑的是 node_modules 里的 electron.exe，把它登记进启动项，
   * 开机会启动一个空的 Electron 而不是 TokenPulse —— 既没用又难找。
   */
  if ("autoUpdate" in patch) setAutoUpdate(next.autoUpdate);
  if ("autoLaunch" in patch && app.isPackaged && process.platform !== "linux") {
    app.setLoginItemSettings({
      openAtLogin: next.autoLaunch,
      /*
       * 免安装版（portable）每次运行都把自己解压到一个临时目录再启动，
       * process.execPath 指的是那个临时副本 —— 关机就没了，登记进启动项等于登记了个死路径。
       * electron-builder 把真正那个 .exe 的位置放在这个环境变量里，有就用它。
       */
      path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
      // 自启的那次直接进托盘，别开机就糊一个窗口在脸上。
      args: ["--hidden"],
    });
  }
  tray?.setContextMenu(buildTrayMenu());
  return next;
}

function isOfficialAccountKind(value: unknown): value is OfficialAccountKind {
  return OFFICIAL_KINDS.includes(value as OfficialAccountKind);
}

function isAgentKind(value: unknown): value is AgentKind {
  return value === "claude" || value === "codex" || value === "grok";
}

/** 找到会话并确认参数：id 来自界面，只收三家之一、长度有限的字符串。 */
async function sessionOf(kind: unknown, id: unknown) {
  if (!isAgentKind(kind) || typeof id !== "string" || !id || id.length > 200) throw new Error("会话参数无效");
  const session = await loadSessionDetail(kind, id);
  if (!session) throw new Error("找不到这个会话");
  return { kind, id, session };
}

/** 在 TokenPulse 里直接回复（见 session-reply.ts）。必须在原项目目录里跑：Agent 读写的是这个目录。 */
async function replyInApp(kind: unknown, id: unknown, prompt: unknown, mode: unknown) {
  const hit = await sessionOf(kind, id);
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("回复内容是空的");
  if (prompt.length > 100_000) throw new Error("回复内容太长");
  const cwd = hit.session.cwd;
  if (!cwd || !fsSync.existsSync(cwd)) throw new Error("这个会话的项目目录已经不在了，没法在原目录里继续");
  // 0.3.16：凡是 TokenPulse 启动的 CLI，设了出口 IP 白名单就先测出口，不在白名单不启动
  const gate = await exitMonitor.gateLaunch(CLI_PROVIDER[hit.kind], CLI_NAME[hit.kind]);
  if (!gate.ok) throw new Error(gate.message);
  const runId = startReply({ kind: hit.kind, id: hit.id, cwd, prompt, mode: (mode === "edit" ? "edit" : "readonly") as ReplyMode }, (event) => {
    if (win && !win.isDestroyed()) win.webContents.send("session-reply", event);
  });
  return { runId };
}

/** 在终端里接着这段会话（交互模式，能看到 CLI 自己的界面）。 */
async function openInTerminal(kind: unknown, id: unknown) {
  const hit = await sessionOf(kind, id);
  const session = hit.session;
  const cwd = session.cwd && fsSync.existsSync(session.cwd) ? session.cwd : undefined;
  // 终端里的 CLI 走的是那个 PowerShell 的网络环境：出口检测放在终端里做（见 session-reply.ts 的 exitGuardScript）
  const guard = exitMonitor.launchRule(CLI_PROVIDER[hit.kind]);
  openTerminal(hit.kind, hit.id, cwd, guard);
  return { ok: true, command: sessionCommand(hit.kind, hit.id), guarded: guardMode(guard) };
}
/** CLI 对应出口监控里的哪一家。 */
const CLI_PROVIDER = { claude: "claude", codex: "chatgpt", grok: "grok" } as const;
const CLI_NAME = { claude: "Claude Code", codex: "Codex", grok: "Grok" } as const;
/** 本机装了哪几家的 CLI（新对话只能用装了的）；guarded：哪几家设了出口 IP 白名单（启动前会先测出口）。 */
function installedClis() {
  const kinds = ["claude", "codex", "grok"] as const;
  return { ...Object.fromEntries(kinds.map((kind) => [kind, resolveCli(kind) !== null])), guarded: Object.fromEntries(kinds.map((kind) => [kind, guardMode(exitMonitor.launchRule(CLI_PROVIDER[kind]))])) };
}
/** 项目文件夹：必须是已经存在的目录的绝对路径。 */
function projectFolder(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 1000 || !path.isAbsolute(value)) throw new Error("请选择一个项目文件夹");
  const folder = path.resolve(value);
  let stat: fsSync.Stats;
  try { stat = fsSync.statSync(folder); } catch { throw new Error("这个文件夹不存在：" + folder); }
  if (!stat.isDirectory()) throw new Error("这不是一个文件夹：" + folder);
  return folder;
}
/** 开一个新对话（0.3.16）：在项目文件夹里打开终端，启动选的那个 CLI。新会话由 CLI 自己建，之后会出现在会话列表里。 */
function startConversation(kind: unknown, folder: unknown) {
  if (!isAgentKind(kind)) throw new Error("请选择一个工具");
  const cwd = projectFolder(folder);
  if (!resolveCli(kind)) throw new Error("没有找到这个工具的命令行程序，请先安装它的 CLI");
  const guard = exitMonitor.launchRule(CLI_PROVIDER[kind]);
  openTerminal(kind, null, cwd, guard);
  return { ok: true, cwd, guarded: guardMode(guard) };
}
/** 选（或者新建）一个项目文件夹。系统的选文件夹对话框里可以直接新建文件夹。 */
async function pickProjectFolder(start: unknown) {
  const defaultPath = typeof start === "string" && start && fsSync.existsSync(start) ? start : app.getPath("documents");
  const options: Electron.OpenDialogOptions = { title: "选择或新建项目文件夹", buttonLabel: "用这个文件夹", defaultPath, properties: ["openDirectory", "createDirectory", "promptToCreate"] };
  const result = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}
/** 永久删除一段对话：先由主进程弹确认框，再调用各家 CLI（Claude 走本地文件回退）。 */
async function deleteConversation(kind: unknown, id: unknown) {
  const hit = await sessionOf(kind, id);
  const method = hit.kind === "claude"
    ? "Claude Code 没有普通对话删除命令；TokenPulse 会删除本机的会话记录文件和同名附属目录。此操作无法撤销。"
    : hit.kind === "codex"
      ? "将调用 codex delete <会话 ID> 永久删除这段对话。此操作无法撤销。"
      : "将调用 grok sessions delete <会话 ID> 永久删除这段对话。此操作无法撤销。";
  const options = {
    type: "warning" as const,
    title: tr("删除对话"),
    message: tr("永久删除这段对话？"),
    detail: `${hit.session.title}\n\n${tr(method)}`,
    buttons: [tr("取消"), tr("删除")],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (result.response !== 1) return { ok: false, cancelled: true };
  await deleteAgentSession(hit.kind, hit.id);
  return { ok: true, cancelled: false };
}

/* ---------------- 启动 ---------------- */

// 从某个 Agent 的终端里启动（比如在 Claude Code 里跑的命令）会继承它的会话变量和 NO_COLOR，
// TokenPulse 再起的 CLI 就不存对话记录、没有颜色。进程一开始就清掉，之后起的所有子进程都干净。
const cleanEnv = cleanAgentEnv();
for (const key of Object.keys(process.env)) if (!(key in cleanEnv)) delete process.env[key];

// 只允许一个实例：两个进程同时往同一个账本里写会互相覆盖。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", revealWindow);

  app.whenReady().then(() => {
    /*
     * 任务栏按这个 ID 分组，图标取「开始」菜单里带同一个 ID 的快捷方式的图标。Electron 为了发通知，
     * 发现没有这样的快捷方式就自己建一个，指向当前的 exe。开发 / 测试时跑的是 node_modules 里的 electron.exe，
     * 用同一个 ID 就会建出指向它的「Electron.lnk」，正式版的任务栏图标从此变成 Electron 的原子图标。
     * 所以没打包时换一个 ID，和正式版互不影响。
     */
    if (process.platform === "win32") app.setAppUserModelId(app.isPackaged ? "com.tokenpulse.app" : "com.tokenpulse.app.dev");
    // 0.3.3：Grok 账号改用用户 ID 当身份，旧数据搬一次（见 grok-migrate.ts）。必须在读账号、刷新之前。
    try {
      migrateLegacyGrokAccounts();
    } catch (error) {
      console.error("[TokenPulse] 迁移 Grok 账号失败", error);
    }
    // 必须在第一次写 prefs.json 之前判断：全新安装要走新手引导，而且不用再看「这版有什么新东西」
    configureReadOnly(() => readPrefs().agentReadOnly === true);
    const fresh = !prefsExist();
    const prefs = readPrefs();
    // --hidden 只影响本次自启，不能永久改掉用户手动启动时的偏好。
    applyPrefs(fresh ? { autoLaunch: prefs.autoLaunch, seenVersion: appVersion(), onboarding: "pending" } : { autoLaunch: prefs.autoLaunch });

    relaunchHidden = consumeRelaunchHidden();
    initTray();
    createWindow();
    initUpdater({ window: () => win, autoUpdate: readPrefs().autoUpdate });
    // 知识库更新了（新型号的单价）：重算一遍，界面上的费用跟着变
    scheduleKnowledgeChecks(() => backgroundRefresh(false));

    ipcMain.handle("egress:state", () => exitMonitor.snapshot());
    ipcMain.handle("egress:save", (_event, value: unknown) => exitMonitor.save(value));
    ipcMain.handle("egress:check", () => exitMonitor.check(true));
    ipcMain.handle("egress:clear", () => exitMonitor.clearHistory());
    ipcMain.handle("egress:intel", (_event, ip: unknown) => exitMonitor.refreshIntel(ip));
    exitMonitor.start();
    ipcMain.handle("snapshot", () => getInitialSnapshot());
    ipcMain.handle("refresh", async () => refresh(true));
    ipcMain.handle("prefs:read", () => readPrefs());
    ipcMain.handle("prefs:write", (_event, patch: Partial<Prefs>) => applyPrefs(patch));
    ipcMain.handle("accounts:list", () => listOfficialOAuthStatus());
    ipcMain.handle("accounts:login", async (_event, kind: unknown, replaceId: unknown) => {
      if (!isOfficialAccountKind(kind)) throw new Error("官方账号类型无效");
      if (replaceId !== undefined && (typeof replaceId !== "string" || replaceId.length > 400)) throw new Error("官方账号参数无效");
      const result = await loginOfficialOAuth(kind, typeof replaceId === "string" ? replaceId : undefined);
      if (result.ok) backgroundRefresh(true);
      return result;
    });
    ipcMain.handle("accounts:manage", async (_event, action: unknown, id: unknown, alias: unknown) => {
      if (!["remove", "purge", "restore", "rename"].includes(action as string) || typeof id !== "string" || id.length > 400) throw new Error("官方账号参数无效");
      if (action === "rename" && (typeof alias !== "string" || alias.length > 200)) throw new Error("名字无效");
      const statuses = await manageOfficialAccount(action as "remove" | "purge" | "restore" | "rename", id, typeof alias === "string" ? alias : "");
      // 名字、显示哪些账号都会变：重新汇总；删除 / 恢复还要重新查一轮额度
      backgroundRefresh(action !== "rename");
      return statuses;
    });
    ipcMain.handle("accounts:reorder", async (_event, kind: unknown, ids: unknown) => {
      if (!isOfficialAccountKind(kind) || !Array.isArray(ids) || ids.length > 50 || !ids.every((id) => typeof id === "string" && id.length <= 400)) throw new Error("官方账号参数无效");
      const statuses = await reorderOfficialAccountsOf(kind, ids as string[]);
      backgroundRefresh(false);
      return statuses;
    });
    ipcMain.handle("theme", (_event, theme: unknown) => {
      if (theme !== "light" && theme !== "dark") return;
      win?.setBackgroundColor(BACKGROUND[theme]);
      if (readPrefs().theme !== theme) writePrefs({ theme });
    });
    ipcMain.handle("open-data-dir", () => shell.openPath(dataDir()));
    ipcMain.handle("window:minimize", () => win?.minimize());
    ipcMain.handle("window:toggle-maximize", () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
    // 走 close() 而不是 destroy()：「关闭窗口时」的设置（收进托盘 / 直接退出）在 close 事件里处理。
    ipcMain.handle("window:close", () => win?.close());
    ipcMain.handle("window:state", () => ({ maximized: Boolean(win?.isMaximized()) }));
    // 直接读 package.json：app.getVersion() 在测试 / 截图脚本里（electron 加载的不是本应用目录）返回的是 Electron 自己的版本。
    ipcMain.handle("update:state", () => updateState());
    ipcMain.handle("update:check", () => checkForUpdates(true));
    ipcMain.handle("update:download", () => downloadUpdate());
    ipcMain.handle("update:install", () => installUpdate());
    ipcMain.handle("app:version", () => appVersion());
    ipcMain.handle("knowledge:state", () => knowledgeState());
    ipcMain.handle("knowledge:check", () => checkKnowledge(() => backgroundRefresh(false)));
    ipcMain.handle("ccswitch:sync", async () => publishSnapshot(await loadSnapshot(false, true)));
    ipcMain.handle("agent:state", () => agentView());
    const providerName = (id: unknown) => coreAgentView().providers.find((item) => item.id === id)?.name || "";
    ipcMain.handle("agent:save", (_event, input: unknown) => agentWrite(`保存供应商「${String((input as { name?: unknown })?.name || "").slice(0, 60)}」`, () => saveProvider(input)));
    ipcMain.handle("agent:delete", (_event, id: unknown) => agentWrite(`删除供应商「${providerName(id)}」`, () => deleteProvider(String(id || ""))));
    ipcMain.handle("agent:activate", (_event, id: unknown) => agentWrite(`切换到「${providerName(id)}」`, () => activateProvider(String(id || ""))));
    ipcMain.handle("agent:proxy", (_event, app: unknown, on: unknown) => agentWrite(`${on === true ? "启用" : "关闭"}本地路由（${isAgentApp(app) ? AGENT_LABEL[app] : ""}）`, () => {
      if (!isAgentApp(app)) throw new Error("不认识这个工具");
      return setAppProxy(app, on === true);
    }, on !== true));
    ipcMain.handle("agent:port", (_event, port: unknown) => agentWrite("修改本地路由端口", () => setProxyPort(Number(port))));
    ipcMain.handle("agent:failover", (_event, id: unknown, on: unknown) => agentWrite("修改备用队列", () => setFailover(String(id || ""), on === true)));
    ipcMain.handle("agent:reorder", (_event, app: unknown, ids: unknown) => agentWrite("调整供应商顺序", () => {
      if (!isAgentApp(app) || !Array.isArray(ids)) throw new Error("排序参数不正确");
      return reorderProviders(app, ids.map(String));
    }));
    ipcMain.handle("agent:import-cc", () => agentWrite("从 CC Switch 导入", () => importCcProviders()));
    ipcMain.handle("agent:import-live", (_event, app: unknown) => agentWrite("导入当前配置", () => {
      if (!isAgentApp(app)) throw new Error("不认识这个工具");
      return importCurrent(app);
    }));
    ipcMain.handle("agent:confirm", (_event, token: unknown) => agentConfirm(token));
    ipcMain.handle("agent:backups", () => agentBackups());
    ipcMain.handle("agent:restore", (_event, kind: unknown, id: unknown) => {
      if ((kind !== "history" && kind !== "original") || typeof id !== "string" || id.length > 100) return { ok: false, error: "备份参数无效" };
      return agentWrite(kind === "original" ? "恢复到 TokenPulse 接管前" : "还原配置备份", () => restoreConfigBackup(kind, id), true);
    });
    ipcMain.handle("agent:drift", () => { try { return agentDrift(); } catch { return []; } });
    setInterval(checkDrift, 5000);
    ipcMain.handle("agent:readonly", (_event, on: unknown) => { applyPrefs({ agentReadOnly: on === true }); publishAgent(); return agentView(); });
    ipcMain.handle("agent:models", (_event, input: unknown) => agentCall(() => listProviderModels(input)));
    ipcMain.handle("agent:probe", async (_event, id: unknown) => {
      try {
        return { ok: true, result: await probeProvider(String(id || "")) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "检测失败" };
      }
    });
    /*
     * 代理：让软件里所有往外发的请求走同一套规则（环境变量里的代理优先，没有就用系统代理）。
     * - Node 自己发的（本地路由转发、获取模型列表、检测地址）和 curl 发的（查额度、续期、出口检测、IP 数据库）：
     *   通过下面这个解析器问系统代理（见 upstream-proxy.ts）；
     * - Electron 内核发的（自动更新、模型知识库更新）：本来只认系统代理、不认环境变量。只设了环境变量、系统代理没开的机器上，
     *   把环境变量里的代理告诉它（alignElectronProxy）。
     */
    setSystemProxyResolver((url) => session.defaultSession.resolveProxy(url));
    void alignElectronProxy().catch(() => undefined);
    configReason("启动时恢复本地路由");
    // 0.3.15：启动时会顺手修复旧版本留下的坏配置（见 repairAgentConfigs）。修复说明等界面来取，免得界面还没加载好就发过去丢了
    let startupNotice = "";
    const resumed = resumeAgentProxy().finally(() => configReason("")).then(() => {
      const notice = agentView().notice || "";
      if (/已自动修复|发现需要修复/.test(notice)) startupNotice = notice;
      publishAgent();
    }).catch((error) => console.error("[TokenPulse] 本地路由没有恢复", error));
    ipcMain.handle("agent:startup-notice", async () => { await resumed; const notice = startupNotice; startupNotice = ""; return notice; });
    ipcMain.handle("models:calibration", (_event, value: unknown) => updateCalibration(value));
    // 时间线上标注「本机以外的使用」：改了之后容量要重算，不用重新查额度
    ipcMain.handle("models:offmachine", (_event, value: unknown) => { const marks = updateMark(value); backgroundRefresh(false); return marks; });
    ipcMain.handle("models:study", (_event, value: unknown) => loadModelStudy(parseModelStudyQuery(value)));
    ipcMain.handle("models:candidates", (_event, kind: unknown) => {
      if (kind !== "claude" && kind !== "chatgpt" && kind !== "grok") return [];
      return modelCandidates(kind, STUDY_FAMILY[kind]);
    });
    ipcMain.handle("requests:query", (_event, query: unknown) => loadRequests(parseRequestQuery(query)));
    // 新手引导的演示数据：单独的进程、单独的临时目录（demo.ts），查询参数照样在这里校验
    ipcMain.handle("demo:snapshot", () => demoCall("snapshot"));
    ipcMain.handle("demo:study", (_event, value: unknown) => demoCall("study", parseModelStudyQuery(value)));
    ipcMain.handle("demo:requests", (_event, query: unknown) => demoCall("requests", parseRequestQuery(query)));
    ipcMain.handle("demo:end", () => endDemo());

    ipcMain.handle("sessions:list", () => loadSessions());
    ipcMain.handle("sessions:detail", (_event, kind: unknown, id: unknown) => {
      if (!isAgentKind(kind) || typeof id !== "string") throw new Error("会话参数无效");
      return loadSessionDetail(kind, id);
    });
    ipcMain.handle("sessions:copy-project", async (_event, kind: unknown, id: unknown) => {
      const { session } = await sessionOf(kind, id);
      if (!session.cwd) throw new Error("这个会话没有记录项目地址");
      clipboard.writeText(session.cwd);
      return { ok: true, cwd: session.cwd };
    });
    ipcMain.handle("sessions:copy-text", (_event, text: unknown) => {
      if (typeof text !== "string" || text.length > 200_000) throw new Error("内容无效");
      clipboard.writeText(text);
      return true;
    });
    ipcMain.handle("sessions:reply", (_event, kind: unknown, id: unknown, prompt: unknown, mode: unknown) => replyInApp(kind, id, prompt, mode));
    ipcMain.handle("sessions:reply-stop", (_event, runId: unknown) => typeof runId === "string" && stopReply(runId));
    ipcMain.handle("sessions:terminal", (_event, kind: unknown, id: unknown) => openInTerminal(kind, id));
    ipcMain.handle("sessions:clis", () => installedClis());
    ipcMain.handle("sessions:new", (_event, kind: unknown, folder: unknown) => startConversation(kind, folder));
    ipcMain.handle("sessions:pick-folder", (_event, start: unknown) => pickProjectFolder(start));
    ipcMain.handle("sessions:delete", (_event, kind: unknown, id: unknown) => deleteConversation(kind, id));
    ipcMain.handle("export-csv", async (_event, content: unknown, kind: unknown) => {
      if (typeof content !== "string" || Buffer.byteLength(content) > 10 * 1024 * 1024) {
        throw new Error("导出内容无效或过大");
      }
      // 文件名用本地日期：toISOString 是 UTC，东八区早上 8 点前导出会标成前一天。
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const requests = kind === "requests";
      const options = {
        title: tr(requests ? "导出请求记录" : "导出用量明细"),
        defaultPath: requests ? `TokenPulse-${tr("请求记录") === "请求记录" ? "请求记录" : "requests"}-${today}.csv` : `TokenPulse-${today}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      };
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return false;
      await fs.writeFile(result.filePath, "\uFEFF" + content, "utf8");
      return true;
    });

    backgroundRefresh(true);
    setInterval(() => backgroundRefresh(false), SCAN_EVERY_MS);
    setInterval(() => backgroundRefresh(true), QUOTA_EVERY_MS);

    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) createWindow();
    });
  });

  /*
   * 「关闭窗口时收进托盘」开着，close 事件里已经拦下改成隐藏，走不到这里。
   * 走到这里说明用户关掉了这个选项、明确要「关窗口就退出」：以前这里不退，
   * 进程带着托盘继续跑，那个开关等于没用。
   */
  app.on("window-all-closed", () => {
    if (quitting || !readPrefs().closeToTray) app.quit();
  });

  let agentQuitReady = false, agentQuitPending = false;
  app.on('before-quit', event => {
    if (agentQuitReady) { quitting = true; exitMonitor.stop(); stopAllReplies(); return; }
    event.preventDefault();
    if (agentQuitPending) return;
    agentQuitPending = true;
    const failed = (error: unknown) => {
      agentQuitPending = false; quitting = false;
      console.error('[TokenPulse] 配置恢复失败，取消退出', error);
      dialog.showErrorBox('暂不能安全退出', error instanceof Error ? error.message : '请先解决配置恢复问题，再退出 TokenPulse。');
    };
    configReason("退出时恢复工具配置");
    try { releaseAgentSwitch(); } catch (error) { configReason(""); failed(error); return; }
    configReason("");
    void waitAgentProxyClosed().then(() => { agentQuitReady = true; app.quit(); }).catch(failed);
  });
}
