import fs from "node:fs";
import { dataFile, readJson, writeJson } from "../core/paths";
import { PRESSURE_DEFAULTS, type PressureLevel } from "../core/quota-pressure";

export type Prefs = {
  /** 开机自启。默认开 —— 这个工具的意义就是「电脑开着就一直记」。 */
  autoLaunch: boolean;
  /** 关窗口时收进托盘而不是退出。 */
  closeToTray: boolean;
  /** 启动时不弹窗口，直接进托盘。 */
  startMinimized: boolean;
  /** 额度过线就弹通知的阈值（百分比），0 = 不提醒。 */
  notifyAt: number;
  /** 周一 9 点后通知上周用量；软件没开时在本周首次运行补发。 */
  weeklySummary: boolean;
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
  /**
   * 额度自动查询间隔（秒），只按整分钟。官方订阅额度、DeepSeek 余额、第三方 Key 余额共用这一个数。
   * 默认 60。界面滑块是 1 到 10 分钟，保存后主进程才改定时器。
   */
  quotaEverySeconds: number;
  /** 额度用满自动切 CLI 登录（0.3.55），按家分开，见 core/cli-auto-switch.ts。没有就是关。 */
  cliAutoSwitch: Partial<Record<"claude" | "chatgpt" | "grok", { on: boolean; at: number }>>;
  /** 额度预测「达到上限」什么时候变色（0.3.59），周窗口 / 5 小时窗口分开；见 core/quota-pressure.ts，worker 直接读。 */
  pressureWeek: PressureLevel;
  pressureFive: PressureLevel;
};

/** 额度查询间隔的边界（秒）。界面滑块和主进程校验用同一组数：1 到 10 分钟。 */
export const QUOTA_EVERY_MIN_SECONDS = 60;
export const QUOTA_EVERY_MAX_SECONDS = 10 * 60;
export const QUOTA_EVERY_DEFAULT_SECONDS = 60;

/** 把读到的间隔收成 1 到 10 的整分钟。空的、不是数的，用默认 1 分钟。 */
export function quotaEverySeconds(value: unknown): number {
  if (value == null || value === "") return QUOTA_EVERY_DEFAULT_SECONDS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return QUOTA_EVERY_DEFAULT_SECONDS;
  const minutes = Math.min(10, Math.max(1, Math.round(seconds / 60)));
  return minutes * 60;
}

const DEFAULTS: Prefs = { autoLaunch: true, closeToTray: true, startMinimized: false, notifyAt: 85, weeklySummary: true, theme: "light", autoUpdate: true, notifyMismatch: true, ccSwitch: true, language: "system", localOnlyAccounts: [], seenVersion: "", onboarding: "", agentReadOnly: false, studyModels: {}, quotaEverySeconds: QUOTA_EVERY_DEFAULT_SECONDS, cliAutoSwitch: {}, pressureWeek: PRESSURE_DEFAULTS.week, pressureFive: PRESSURE_DEFAULTS.five };

function file() {
  return dataFile("prefs.json");
}

/** prefs.json 还不存在 = 全新安装（以前的版本每次启动都会写一次开机自启，老用户一定有这个文件）。 */
export function prefsExist(): boolean {
  return fs.existsSync(file());
}

export function readPrefs(): Prefs {
  const raw = readJson<Partial<Prefs>>(file(), {});
  return { ...DEFAULTS, ...raw, quotaEverySeconds: quotaEverySeconds(raw.quotaEverySeconds) };
}

export function writePrefs(patch: Partial<Prefs>): Prefs {
  const current = readPrefs();
  const next = { ...current, ...patch, quotaEverySeconds: quotaEverySeconds("quotaEverySeconds" in patch ? patch.quotaEverySeconds : current.quotaEverySeconds) };
  writeJson(file(), next);
  return next;
}
