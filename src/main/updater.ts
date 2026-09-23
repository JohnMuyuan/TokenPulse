import { app, type BrowserWindow } from "electron";
import fs from "fs";
import path from "path";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import { dataFile, readJson, writeJson } from "../core/paths";

/**
 * 自动更新：GitHub Releases（package.json 的 build.publish）+ electron-updater。
 *
 * 「无感」的做法：
 * 1. 定时在后台检查，发现新版本就静默下载；
 * 2. 下载好了不打断用户：等窗口收进托盘 / 最小化（= 没在看）时静默安装（NSIS /S）并自动重启；
 *    原来在托盘里的，重启后仍然只在托盘（见 RELAUNCH_FILE）；
 * 3. 一直等不到这个时机，就在退出时顺带装上（autoInstallOnAppQuit）。
 *
 * 只有安装版能更新：便携版每次解压到临时目录运行、免安装目录版不在安装位置，都没法原地替换，
 * 界面上提示去 GitHub 下载。发布时 Release 里必须带上 electron-builder 生成的 latest.yml
 * 和 Setup.exe（及 .blockmap，差量下载用），否则已安装的版本查不到更新。
 */

/** available：发现新版本但自动更新关着，等用户点下载。 */
export type UpdateStatus = "unsupported" | "idle" | "checking" | "available" | "downloading" | "downloaded" | "latest" | "error";
export type UpdateState = {
  status: UpdateStatus;
  currentVersion: string;
  /** 发现的新版本号。 */
  version?: string;
  /** 下载进度 0–100。 */
  progress?: number;
  /** 最后一次检查完成的时间。 */
  checkedAt?: number;
  error?: string;
  /** unsupported 的原因。 */
  reason?: string;
  autoUpdate: boolean;
};

const FIRST_CHECK_MS = 3 * 60_000;
const CHECK_EVERY_MS = 4 * 60 * 60_000;
/** 下载好之后，窗口收起多久再装：给「刚点了关闭又马上打开」留点余地。 */
const INSTALL_DELAY_MS = 20_000;
const RELAUNCH_FILE = "update-relaunch.json";

let state: UpdateState = { status: "idle", currentVersion: app.getVersion(), autoUpdate: true };
let getWindow: () => BrowserWindow | null = () => null;
let installTimer: NodeJS.Timeout | null = null;
let checking: Promise<UpdateState> | null = null;

function publish(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  // 退出途中窗口已销毁，下载 / 校验的事件还可能回来，send 会抛 "Object has been destroyed"
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send("update-state", state);
  return state;
}

/** 为什么不能自动更新；能的话返回空。 */
export function unsupportedReason(env = process.env, execPath = process.execPath, packaged = app.isPackaged) {
  if (!packaged) return "开发模式不检查更新";
  if (env.PORTABLE_EXECUTABLE_FILE) return "便携版不支持自动更新，请到 GitHub 下载新版本";
  // NSIS 安装版在程序旁边放了卸载程序；免安装目录版（win-unpacked）没有，装上去会多出一份安装版。
  const dir = path.dirname(execPath);
  const installed = fs.existsSync(dir) && fs.readdirSync(dir).some((name) => /^Uninstall .*\.exe$/i.test(name));
  if (!installed) return "免安装版不支持自动更新，请到 GitHub 下载新版本";
  return "";
}

/** 上次是「在托盘里」被更新重启的：这次也别弹窗口。读过就删。 */
export function consumeRelaunchHidden(now = Date.now()) {
  const file = dataFile(RELAUNCH_FILE);
  const marker = readJson<{ hidden?: boolean; at?: number } | null>(file, null);
  if (!marker) return false;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // 删不掉最多下次启动再被读一次；有 10 分钟的时效兜着
  }
  return Boolean(marker.hidden) && typeof marker.at === "number" && now - marker.at < 10 * 60_000;
}

function windowAway(win: BrowserWindow | null) {
  return !win || win.isDestroyed() || !win.isVisible() || win.isMinimized();
}

/** 静默安装并重启。窗口原本收着的，重启后也收着。 */
function installNow() {
  if (state.status !== "downloaded") return;
  const win = getWindow();
  try {
    writeJson(dataFile(RELAUNCH_FILE), { hidden: windowAway(win), at: Date.now() });
  } catch {
    // 写不进去最多就是重启后弹一下窗口
  }
  // isSilent：NSIS 不弹安装界面；isForceRunAfter：装完自动启动。before-quit 会把托盘程序的 quitting 置上。
  autoUpdater.quitAndInstall(true, true);
}

/** 下载好了：用户不在看窗口就装，否则等窗口收起来。 */
function scheduleInstall() {
  if (!state.autoUpdate || state.status !== "downloaded") return;
  if (installTimer) clearTimeout(installTimer);
  installTimer = null;
  if (windowAway(getWindow())) installTimer = setTimeout(() => (windowAway(getWindow()) ? installNow() : undefined), INSTALL_DELAY_MS);
}

/** force 只给测试用：跳过「只有安装版能更新」的判断，好在开发环境里把整条流程跑一遍（见 scripts/test-updater.cjs）。 */
export function initUpdater(options: { window: () => BrowserWindow | null; autoUpdate: boolean; force?: boolean }) {
  getWindow = options.window;
  const reason = options.force ? "" : unsupportedReason();
  state = { ...state, autoUpdate: options.autoUpdate, ...(reason ? { status: "unsupported", reason } : {}) };
  if (reason) return;

  autoUpdater.autoDownload = options.autoUpdate;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;
  autoUpdater.on("checking-for-update", () => publish({ status: "checking", error: undefined }));
  autoUpdater.on("update-available", (info: UpdateInfo) => publish({ status: state.autoUpdate ? "downloading" : "available", version: info.version, progress: 0 }));
  autoUpdater.on("update-not-available", () => publish({ status: "latest", version: undefined, checkedAt: Date.now() }));
  autoUpdater.on("download-progress", (p) => publish({ status: "downloading", progress: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    publish({ status: "downloaded", version: info.version, progress: 100, checkedAt: Date.now() });
    scheduleInstall();
  });
  autoUpdater.on("error", (error: Error) => publish({ status: "error", error: friendlyError(error), checkedAt: Date.now() }));

  if (options.force) return;
  setTimeout(() => void checkForUpdates(false), FIRST_CHECK_MS);
  setInterval(() => void checkForUpdates(false), CHECK_EVERY_MS);
}

/** 窗口收起来 / 最小化时调：下载好了就趁这个时候装。 */
export function onWindowAway() {
  scheduleInstall();
}

export function updateState() {
  return state;
}

export function friendlyError(error: Error) {
  const text = String(error?.message || error);
  if (/latest\.yml|Cannot find .*\.yml|404/i.test(text)) return "发布页上还没有可用的更新信息";
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::|network|socket/i.test(text)) return "网络不通，稍后会自动重试";
  if (/rate limit|403/i.test(text)) return "GitHub 访问太频繁，稍后会自动重试";
  return "检查更新失败，稍后会自动重试";
}

/** manual：用户点了「检查更新」。自动更新关着时也允许手动检查（发现了只提示，不下载）。 */
export function checkForUpdates(manual: boolean): Promise<UpdateState> {
  if (state.status === "unsupported") return Promise.resolve(state);
  if (!manual && !state.autoUpdate) return Promise.resolve(state);
  if (state.status === "downloading" || state.status === "downloaded") return Promise.resolve(state);
  if (!checking) {
    checking = autoUpdater
      .checkForUpdates()
      .then(() => state)
      .catch((error) => publish({ status: "error", error: friendlyError(error), checkedAt: Date.now() }))
      .finally(() => {
        checking = null;
      });
  }
  return checking;
}

/** 手动下载（自动更新关着、但用户想装这个版本）。 */
export function downloadUpdate() {
  if (state.status === "unsupported" || !state.version) return Promise.resolve(state);
  publish({ status: "downloading", progress: 0 });
  return autoUpdater
    .downloadUpdate()
    .then(() => state)
    .catch((error) => publish({ status: "error", error: friendlyError(error) }));
}

/** 用户点「立即重启并更新」。 */
export function installUpdate() {
  installNow();
}

export function setAutoUpdate(on: boolean) {
  publish({ autoUpdate: on });
  if (state.status === "unsupported") return;
  autoUpdater.autoDownload = on;
  if (on) {
    if (state.status === "downloaded") scheduleInstall();
    else void checkForUpdates(false);
  } else if (installTimer) {
    clearTimeout(installTimer);
    installTimer = null;
  }
}
