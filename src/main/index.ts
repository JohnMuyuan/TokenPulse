import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell, Tray } from "electron";
import fs from "fs/promises";
import path from "path";
import { dataDir } from "../core/paths";
import { fetchOfficialQuota } from "../core/quota";
import type { Snapshot } from "../core/report";
import { loadSnapshot } from "./snapshot";
import { readPrefs, writePrefs, type Prefs } from "./prefs";
import { trayIcon, windowIcon } from "./icon";
import { checkForUpdates, consumeRelaunchHidden, downloadUpdate, initUpdater, installUpdate, onWindowAway, setAutoUpdate, updateState } from "./updater";
import { listOfficialOAuthStatus, loginOfficialOAuth } from "./oauth";
import { setActiveOfficialAccount } from "../core/accounts";
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
    { label: "打开 TokenPulse", click: revealWindow },
    { type: "separator" },
    {
      label: "立即刷新",
      click: () => {
        backgroundRefresh(true);
      },
    },
    {
      label: "开机自启",
      type: "checkbox",
      checked: prefs.autoLaunch,
      click: (item) => applyPrefs({ autoLaunch: item.checked }),
    },
    { label: "打开数据目录", click: () => shell.openPath(dataDir()) },
    { type: "separator" },
    {
      label: "退出",
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

/** 托盘悬停时显示各账号当前的额度，不用开窗口就能看一眼。 */
function updateTrayTip(snapshot: Snapshot) {
  if (!tray) return;
  const names: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", grok: "Grok" };
  const lines = snapshot.accounts.map((account) => {
    const week = account.week ? `周 ${Math.round(account.week.used)}%` : "";
    const five = account.five ? `5h ${Math.round(account.five.used)}%` : "";
    return `${names[account.kind] ?? account.kind}  ${[five, week].filter(Boolean).join("  ")}`.trim();
  });
  const head = `TokenPulse · 今日 ${formatTokens(snapshot.totals.today.tokens)} tokens`;
  tray.setToolTip([head, ...lines].join(String.fromCharCode(10)));
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
  const names: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", grok: "Grok" };
  for (const account of snapshot.accounts) {
    for (const [label, report] of [
      ["5 小时", account.five],
      ["周", account.week],
    ] as const) {
      if (!report || report.used < limit) continue;
      const key = `${account.kind}:${label}`;
      const resetAt = report.resetAt ?? 0;
      const previous = notified.get(key);
      if (previous != null && Math.abs(resetAt - previous) < SAME_WINDOW_MS) continue;
      notified.set(key, resetAt);
      new Notification({
        title: `${names[account.kind] ?? account.kind} ${label}额度已用 ${Math.round(report.used)}%`,
        body: report.resetAt
          ? `${new Date(report.resetAt).toLocaleString()} 重置`
          : "注意节奏",
        icon: windowIcon(),
      }).show();
    }
  }
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

/* ---------------- 启动 ---------------- */

// 只允许一个实例：两个进程同时往同一个账本里写会互相覆盖。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", revealWindow);

  app.whenReady().then(() => {
    if (process.platform === "win32") app.setAppUserModelId("com.tokenpulse.app");
    const prefs = readPrefs();
    // --hidden 只影响本次自启，不能永久改掉用户手动启动时的偏好。
    applyPrefs({ autoLaunch: prefs.autoLaunch });

    relaunchHidden = consumeRelaunchHidden();
    initTray();
    createWindow();
    initUpdater({ window: () => win, autoUpdate: readPrefs().autoUpdate });

    ipcMain.handle("snapshot", () => getInitialSnapshot());
    ipcMain.handle("refresh", async () => refresh(true));
    ipcMain.handle("prefs:read", () => readPrefs());
    ipcMain.handle("prefs:write", (_event, patch: Partial<Prefs>) => applyPrefs(patch));
    ipcMain.handle("accounts:list", () => listOfficialOAuthStatus());
    ipcMain.handle("accounts:login", async (_event, kind: unknown) => {
      if (!isOfficialAccountKind(kind)) throw new Error("官方账号类型无效");
      const result = await loginOfficialOAuth(kind);
      if (result.ok) backgroundRefresh(true);
      return result;
    });
    ipcMain.handle("accounts:activate", async (_event, kind: unknown, id: unknown) => {
      if (!isOfficialAccountKind(kind) || typeof id !== "string") throw new Error("官方账号参数无效");
      setActiveOfficialAccount(kind, id);
      backgroundRefresh(true);
      return listOfficialOAuthStatus();
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
    ipcMain.handle("export-csv", async (_event, content: unknown) => {
      if (typeof content !== "string" || Buffer.byteLength(content) > 10 * 1024 * 1024) {
        throw new Error("导出内容无效或过大");
      }
      // 文件名用本地日期：toISOString 是 UTC，东八区早上 8 点前导出会标成前一天。
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const options = { title: "导出用量明细", defaultPath: `TokenPulse-${today}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] };
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
  });
}
