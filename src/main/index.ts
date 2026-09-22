import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell, Tray } from "electron";
import fs from "fs/promises";
import path from "path";
import { dataDir } from "../core/paths";
import { fetchOfficialQuota } from "../core/quota";
import type { Snapshot } from "../core/report";
import { loadSnapshot } from "./snapshot";
import { readPrefs, writePrefs, type Prefs } from "./prefs";
import { trayIcon, windowIcon } from "./icon";

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
let tray: Tray | null = null;
let quitting = false;
/** 已经就这个窗口提醒过一次了，别每 5 分钟弹一遍。窗口重置后清掉。 */
const notified = new Set<string>();

/* ---------------- 窗口 ---------------- */

function createWindow() {
  const next = new BrowserWindow({
    width: 1380,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#09090b",
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
    if (!process.argv.includes("--hidden") && !readPrefs().startMinimized) next.show();
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
 * 按「账号 + 窗口 + 这个窗口的重置时间」去重 —— 窗口一重置，键就变了，
 * 下个窗口再过线会重新提醒，但同一个窗口里不会反复吵。
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
      const key = `${account.kind}:${label}:${report.resetAt ?? 0}`;
      if (notified.has(key)) continue;
      notified.add(key);
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
async function refresh(withQuota: boolean): Promise<Snapshot> {
  // 同一时间只跑一轮，重入的调用共用这一次的结果。
  if (refreshing) return refreshing;
  refreshing = (async () => {
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
    }
    if (withQuota) maybeNotify(snapshot);
    return snapshot;
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

/* ---------------- 设置 ---------------- */

function applyPrefs(patch: Partial<Prefs>): Prefs {
  const next = writePrefs(patch);
  /*
   * 只有打好包的版本才去动开机启动项。
   * 开发时（`npm start`）跑的是 node_modules 里的 electron.exe，把它登记进启动项，
   * 开机会启动一个空的 Electron 而不是 TokenPulse —— 既没用又难找。
   */
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

    initTray();
    createWindow();

    ipcMain.handle("snapshot", () => getInitialSnapshot());
    ipcMain.handle("refresh", async () => refresh(true));
    ipcMain.handle("prefs:read", () => readPrefs());
    ipcMain.handle("prefs:write", (_event, patch: Partial<Prefs>) => applyPrefs(patch));
    ipcMain.handle("open-data-dir", () => shell.openPath(dataDir()));
    ipcMain.handle("export-csv", async (_event, content: unknown) => {
      if (typeof content !== "string" || Buffer.byteLength(content) > 10 * 1024 * 1024) {
        throw new Error("导出内容无效或过大");
      }
      const options = { title: "导出用量明细", defaultPath: `TokenPulse-${new Date().toISOString().slice(0, 10)}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] };
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

  // 窗口全关了也不退出：这是个常驻托盘的工具。
  app.on("window-all-closed", () => {
    if (quitting) app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
  });
}
