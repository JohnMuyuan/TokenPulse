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
};

const DEFAULTS: Prefs = { autoLaunch: true, closeToTray: true, startMinimized: false, notifyAt: 85, theme: "light" };

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
