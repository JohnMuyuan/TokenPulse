import { dataFile, readJson, writeJson } from "../core/paths";

export type Prefs = {
  /** 开机自启。默认开 —— 这个工具的意义就是「电脑开着就一直记」。 */
  autoLaunch: boolean;
  /** 关窗口时收进托盘而不是退出。 */
  closeToTray: boolean;
  /** 启动时不弹窗口，直接进托盘。 */
  startMinimized: boolean;
  /** 额度过线就弹通知的阈值（百分比），0 = 不提醒。 */
  notifyAt: number;
  /** 界面主题。界面自己用 localStorage 记，这里再存一份给主进程：建窗口时要用它定底色。 */
  theme: "light" | "dark";
  /** 自动更新：后台下载新版本，在窗口收起时静默安装并重启。默认开。 */
  autoUpdate: boolean;
  /** 发现请求的型号和上游返回的对不上（或响应存疑）时发系统通知。默认开。 */
  notifyMismatch: boolean;
  /** 从 CC Switch 导入缺的用量（core/cc-switch.ts 在 worker 里直接读这个字段）。默认开。 */
  ccSwitch: boolean;
  /** 界面语言。界面自己用 localStorage 记（加载前就要知道），这里再存一份给托盘菜单和通知。 */
  language: "system" | "zh" | "en";
};

const DEFAULTS: Prefs = { autoLaunch: true, closeToTray: true, startMinimized: false, notifyAt: 85, theme: "light", autoUpdate: true, notifyMismatch: true, ccSwitch: true, language: "system" };

function file() {
  return dataFile("prefs.json");
}

export function readPrefs(): Prefs {
  return { ...DEFAULTS, ...readJson<Partial<Prefs>>(file(), {}) };
}

export function writePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...readPrefs(), ...patch };
  writeJson(file(), next);
  return next;
}
