import { dataFile, readJson } from "./paths";

/**
 * 额度预测「达到上限」提示的宽松程度（0.3.59）。
 * 用户反馈只要按趋势会在重置前用完就把进度条变黄太敏感：现在只有按趋势用完后到重置之间会「断档」
 * 足够长的时间才变色（见 quota-monitor.ts 的 pressure）。断档多长算长，按窗口分别交给用户选；没选就用默认值。
 * 存在 prefs.json（主进程设置页写，worker 直接读）。
 */
export type PressureLevel = "strict" | "default" | "relaxed" | "off";
export type PressureRule = {
  /** 断档占剩余时间的比例达到这个值才变色；Infinity = 只有已用完才变色。 */
  lockoutShare: number;
  /** 已用不到这个百分比时预测只作文字参考。 */
  minUsed: number;
};
export type PressurePrefs = { week: PressureLevel; five: PressureLevel };

export const PRESSURE_LEVELS: readonly PressureLevel[] = ["strict", "default", "relaxed", "off"];
/** 周窗口断档影响大，默认 1/4 就提醒；5 小时窗口本来就是拿来用完的，默认放宽到一半。 */
export const PRESSURE_DEFAULTS: PressurePrefs = { week: "default", five: "relaxed" };

const RULES: Record<PressureLevel, PressureRule> = {
  // 严格 = 以前的行为：按趋势会在重置前用完就变色
  strict: { lockoutShare: 0, minUsed: 0 },
  default: { lockoutShare: 0.25, minUsed: 10 },
  relaxed: { lockoutShare: 0.5, minUsed: 10 },
  off: { lockoutShare: Infinity, minUsed: 0 },
};

export function pressureRule(level: PressureLevel | undefined, fallback: PressureLevel): PressureRule {
  return RULES[isPressureLevel(level) ? level : fallback];
}

export function isPressureLevel(value: unknown): value is PressureLevel {
  return typeof value === "string" && (PRESSURE_LEVELS as readonly string[]).includes(value);
}

/** 从 prefs.json 读两个窗口的宽松程度；缺的、不认识的用默认值。 */
export function readPressurePrefs(): PressurePrefs {
  const prefs = readJson<{ pressureWeek?: unknown; pressureFive?: unknown }>(dataFile("prefs.json"), {});
  return {
    week: isPressureLevel(prefs.pressureWeek) ? prefs.pressureWeek : PRESSURE_DEFAULTS.week,
    five: isPressureLevel(prefs.pressureFive) ? prefs.pressureFive : PRESSURE_DEFAULTS.five,
  };
}
