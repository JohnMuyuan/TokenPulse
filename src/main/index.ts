import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, shell, Tray } from "electron";
import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import { dataDir } from "../core/paths";
import { fetchOfficialQuota } from "../core/quota";
import type { Snapshot } from "../core/report";
import { loadRequests, loadSessionDetail, loadSessions, loadSnapshot } from "./snapshot";
import { sessionCommand, type AgentKind } from "../core/sessions";
import { cleanAgentEnv, deleteSession as deleteAgentSession, openTerminal, startReply, stopAllReplies, stopReply, type ReplyMode } from "./session-reply";
import { checkKnowledge, knowledgeState, scheduleKnowledgeChecks } from "./knowledge-update";
import type { RequestQuery } from "../core/request-log";
import { readPrefs, writePrefs, type Prefs } from "./prefs";
import { tr } from "./i18n";
import { trayIcon, windowIcon } from "./icon";
import { checkForUpdates, consumeRelaunchHidden, downloadUpdate, initUpdater, installUpdate, onWindowAway, setAutoUpdate, updateState } from "./updater";
import { listOfficialOAuthStatus, loginOfficialOAuth, manageOfficialAccount, reorderOfficialAccountsOf } from "./oauth";
import { migrateLegacyGrokAccounts } from "../core/grok-migrate";
import { OFFICIAL_KINDS, type OfficialAccountKind } from "../core/credentials";

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
    shell.openExternal(url);
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
    until: Number.isFinite(input.until) ? Number(input.until) : undefined,
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
      await fetchOfficialQuota(true);
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

function applyPrefs(patch: Partial<Prefs>): Prefs {
  const next = writePrefs(patch);
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
  openTerminal(hit.kind, hit.id, cwd);
  return { ok: true, command: sessionCommand(hit.kind, hit.id) };
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
    const prefs = readPrefs();
    // --hidden 只影响本次自启，不能永久改掉用户手动启动时的偏好。
    applyPrefs({ autoLaunch: prefs.autoLaunch });

    relaunchHidden = consumeRelaunchHidden();
    initTray();
    createWindow();
    initUpdater({ window: () => win, autoUpdate: readPrefs().autoUpdate });
    // 知识库更新了（新型号的单价）：重算一遍，界面上的费用跟着变
    scheduleKnowledgeChecks(() => backgroundRefresh(false));

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
    ipcMain.handle("app:version", () => (require("../../package.json") as { version: string }).version);
    ipcMain.handle("knowledge:state", () => knowledgeState());
    ipcMain.handle("knowledge:check", () => checkKnowledge(() => backgroundRefresh(false)));
    ipcMain.handle("ccswitch:sync", async () => publishSnapshot(await loadSnapshot(false, true)));
    ipcMain.handle("requests:query", (_event, query: unknown) => loadRequests(parseRequestQuery(query)));
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

  app.on("before-quit", () => {
    quitting = true;
    // 还在跑的回复一起结束，别留下没人管的 CLI 进程
    stopAllReplies();
  });
}
