/*
 * 托盘小面板：在托盘图标上点右键，弹出一张小卡片，列出各个官方账号的 5 小时 / 周额度。
 * 不用打开主窗口就能看一眼；失去焦点自动收起。原来的右键菜单收进面板底部的「菜单」按钮。
 *
 * 窗口只在第一次用到时才建，收起两分钟后销毁（多一个渲染进程要占几十 MB，平时不留着）。
 */
import { BrowserWindow, screen, type Rectangle, type Tray } from "electron";
import path from "path";
import type { Snapshot } from "../core/report";

export type TrayPanelAccount = {
  kind: string;
  name: string;
  plan: string;
  /** 最后一次查到额度的时间；太久没查到（额度可能已经变了）界面上会标出来。 */
  checkedAt: number;
  five: TrayPanelWindow | null;
  week: TrayPanelWindow | null;
};
/** pace：这个窗口的时间已经过了百分之几（没法算时是 -1）。已用比它多，就是用得比时间走得快。 */
export type TrayPanelWindow = { used: number; resetAt: number; etaAt: number; runsOut: boolean; pace: number };
/** 一个工具现在用的是哪家供应商，以及能换成哪些。 */
export type TrayPanelAgent = { app: string; label: string; current: string; readOnly: boolean; providers: { id: string; name: string; active: boolean }[] };
export type TrayPanelData = { now: number; theme: "light" | "dark"; today: { tokens: number; costUsd: number }; accounts: TrayPanelAccount[]; agents: TrayPanelAgent[] };

type Options = {
  tray: () => Tray | null;
  data: () => TrayPanelData;
  background: () => string;
  preload: string;
};

const WIDTH = 340;
const MARGIN = 10;
const IDLE_DESTROY_MS = 2 * 60_000;
let panel: BrowserWindow | null = null;
let options: Options | null = null;
let hiddenAt = 0;
let height = 260;
let destroyTimer: NodeJS.Timeout | null = null;

export function setupTrayPanel(next: Options) { options = next; }

/** 从快照里挑出面板要用的那几项；不带邮箱以外的任何账号信息。 */
export function trayPanelData(snapshot: Snapshot | null, theme: "light" | "dark", title: (account: Snapshot["accounts"][number]) => string, agents: TrayPanelAgent[] = []): TrayPanelData {
  const pick = (window: Snapshot["accounts"][number]["five"]): TrayPanelWindow | null => window
    ? { used: Math.max(0, Math.min(100, window.used)), resetAt: window.resetAt ?? 0, etaAt: window.etaAt ?? 0, runsOut: !!window.runsOutBeforeReset,
        pace: window.elapsedH != null && window.leftH != null && window.elapsedH + window.leftH > 0 ? Math.max(0, Math.min(100, window.elapsedH / (window.elapsedH + window.leftH) * 100)) : -1 }
    : null;
  return {
    now: Date.now(), theme, agents,
    today: { tokens: snapshot?.totals.today.tokens ?? 0, costUsd: snapshot?.totals.today.costUsd ?? 0 },
    accounts: (snapshot?.accounts ?? []).filter((account) => account.five || account.week).map((account) => ({
      kind: account.kind, name: title(account), plan: account.plan ?? "", checkedAt: account.lastCheckedAt ?? account.lastSampleAt ?? 0,
      five: pick(account.five), week: pick(account.week),
    })),
  };
}

/** 面板放在托盘图标旁边：任务栏在下面就放在图标上方，在别的边同理，并且不超出屏幕的可用区域。 */
export function panelBounds(icon: Rectangle, work: Rectangle, size: { width: number; height: number }): Rectangle {
  const width = Math.min(size.width, work.width - MARGIN * 2), tall = Math.min(size.height, work.height - MARGIN * 2);
  const centerX = icon.x + icon.width / 2, centerY = icon.y + icon.height / 2;
  let x = Math.round(centerX - width / 2), y: number;
  if (centerY >= work.y + work.height) y = work.y + work.height - tall - MARGIN;            // 任务栏在下
  else if (centerY <= work.y) y = work.y + MARGIN;                                           // 在上
  else { y = Math.round(centerY - tall / 2); x = centerX <= work.x ? work.x + MARGIN : work.x + work.width - width - MARGIN; } // 在左 / 右
  x = Math.max(work.x + MARGIN, Math.min(x, work.x + work.width - width - MARGIN));
  y = Math.max(work.y + MARGIN, Math.min(y, work.y + work.height - tall - MARGIN));
  return { x, y, width, height: tall };
}

function place() {
  const tray = options?.tray();
  if (!panel || panel.isDestroyed() || !tray) return;
  const icon = tray.getBounds();
  const work = screen.getDisplayNearestPoint({ x: Math.round(icon.x + icon.width / 2), y: Math.round(icon.y + icon.height / 2) }).workArea;
  const bounds = panelBounds(icon, work, { width: WIDTH, height });
  // 自动化测试里面板照常「显示」，但挪到屏幕外面，免得测试时在用户眼前闪一下
  panel.setBounds(process.env.TOKENPULSE_TRAY_PANEL_OFFSCREEN ? { ...bounds, x: -20000, y: -20000 } : bounds);
}

function create() {
  if (!options) return null;
  const next = new BrowserWindow({
    width: WIDTH, height, show: false, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, backgroundColor: options.background(), title: "TokenPulse",
    webPreferences: { preload: options.preload, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  next.setMenuBarVisibility(false);
  next.loadFile(path.join(__dirname, "..", "..", "renderer", "tray-panel.html"), { query: { theme: options.data().theme } });
  next.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  next.on("blur", () => hideTrayPanel());
  next.on("closed", () => { if (panel === next) panel = null; });
  panel = next;
  return next;
}

export function trayPanelVisible() { return !!panel && !panel.isDestroyed() && panel.isVisible(); }

export function hideTrayPanel() {
  if (!panel || panel.isDestroyed() || !panel.isVisible()) return;
  hiddenAt = Date.now();
  panel.hide();
  if (destroyTimer) clearTimeout(destroyTimer);
  destroyTimer = setTimeout(() => { if (panel && !panel.isDestroyed() && !panel.isVisible()) panel.destroy(); }, IDLE_DESTROY_MS);
}

/** 右键托盘图标：开着就收起，收着就打开。点图标本身会先让面板失焦收起，紧跟着的这一下不能又把它打开。 */
export function toggleTrayPanel() {
  if (trayPanelVisible()) { hideTrayPanel(); return; }
  if (Date.now() - hiddenAt < 300) return;
  if (destroyTimer) { clearTimeout(destroyTimer); destroyTimer = null; }
  const fresh = !panel || panel.isDestroyed();
  const target = fresh ? create() : panel;
  if (!target) return;
  const show = () => { if (target.isDestroyed()) return; place(); target.show(); target.focus(); pushTrayPanel(); };
  if (fresh) target.once("ready-to-show", show);
  else show();
}

/** 有新快照、或者设置变了：面板开着就把最新的数据送过去。 */
export function pushTrayPanel() {
  if (!options || !panel || panel.isDestroyed()) return;
  panel.webContents.send("tray-panel", options.data());
}

/** 界面量出内容有多高，窗口跟着调。 */
export function resizeTrayPanel(next: number) {
  if (!Number.isFinite(next)) return;
  height = Math.max(140, Math.min(900, Math.round(next)));
  if (trayPanelVisible()) place();
}

export function destroyTrayPanel() {
  if (destroyTimer) { clearTimeout(destroyTimer); destroyTimer = null; }
  if (panel && !panel.isDestroyed()) panel.destroy();
  panel = null;
}
