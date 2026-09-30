import fs from "node:fs";
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
  /** 声明「只在本机用 Code，不聊天」的官方账号 id（见 core/quota-calibration.ts 的 localOnlyAccounts）。 */
  localOnlyAccounts: string[];
  /** 看过「新版本有什么」的版本号（0.3.9 起）。和当前版本不同、且有这版的说明时，启动后弹一次。 */
  seenVersion: string;
  /** 新手引导：pending = 全新安装、还没走过；done = 走完或跳过。老用户升级上来是空的，不自动弹（更新说明里可以打开）。 */
  onboarding: "" | "pending" | "done";
  /** 供应商「只读保护」：打开后 TokenPulse 不改动 Claude / Codex / Grok 的配置文件（关闭路由、还原备份这类放回去的操作除外）。 */
  agentReadOnly: boolean;
  /** 自己加进「换一种模型，整窗能用多少」的型号（0.3.12），按家分开；model-catalog.ts 的 readStudyModels 在 worker 里直接读。 */
  studyModels: Partial<Record<"claude" | "chatgpt" | "grok", { model: string; efforts: string[] }[]>>;
};

const DEFAULTS: Prefs = { autoLaunch: true, closeToTray: true, startMinimized: false, notifyAt: 85, theme: "light", autoUpdate: true, notifyMismatch: true, ccSwitch: true, language: "system", localOnlyAccounts: [], seenVersion: "", onboarding: "", agentReadOnly: false, studyModels: {} };

function file() {
  return dataFile("prefs.json");
}

/** prefs.json 还不存在 = 全新安装（以前的版本每次启动都会写一次开机自启，老用户一定有这个文件）。 */
export function prefsExist(): boolean {
  return fs.existsSync(file());
}

export function readPrefs(): Prefs {
  return { ...DEFAULTS, ...readJson<Partial<Prefs>>(file(), {}) };
}

export function writePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...readPrefs(), ...patch };
  writeJson(file(), next);
  return next;
}
