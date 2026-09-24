import { app } from "electron";
import { readPrefs } from "./prefs";

/**
 * 主进程自己画的界面（托盘菜单、托盘提示、系统通知、保存对话框）也要跟着界面语言走。
 * 词典只有一份，在 renderer/i18n.js 里 —— 这里直接 require 它，不另抄一份。
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { translate } = require("../../renderer/i18n.js") as { translate: (text: string) => string };

export function uiLanguage(): "zh" | "en" {
  const mode = readPrefs().language;
  if (mode === "zh" || mode === "en") return mode;
  return app.getLocale().toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function tr(text: string) {
  return uiLanguage() === "en" ? translate(text) : text;
}
