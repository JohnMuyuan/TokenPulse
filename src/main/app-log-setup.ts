import { app, ipcMain, type WebContents } from "electron";
import os from "os";
import { format } from "util";
import { errorText, log } from "../core/app-log";
import { proxyFor } from "../core/upstream-proxy";

/**
 * 主进程接进统一运行日志（core/app-log.ts）。index.ts 第一个 import 它，后面注册的 IPC 才都会被包上。
 *
 * - 界面上的操作：ipcMain.handle 统一包一层，记通道名、耗时、失败原因。**不记参数**（里面可能有 API key、提示词）；
 *   参数里只有像 "claude" 这样的短标识才带上。界面轮询的只读通道（QUIET）只在失败或特别慢时记。
 * - console.error / console.warn、没人接的 Promise 拒绝、没接住的异常（只旁观，不改变崩溃行为）。
 * - 各窗口的界面进程崩溃、卡死、界面里的报错。
 */

const QUIET = /^(snapshot|theme)$|:(state|data|size|list|query|insight|timeline|speed|series|summary|last|usage|drift|backups|status|accounts|packs|pack-images|bubble-data|bubble-size|month|week|milestones|render|calibration|offmachine|study|candidates|detail|search|startup-notice|version|route-log|models|intel|ready|read|clis|preview|account)$/;
const SLOW_MS = 5000;

function argsNote(channel: string, args: unknown[]) {
  if (channel === "prefs:write" && args[0] && typeof args[0] === "object") {
    // 设置项：只记改了哪些、开关和数字的值，文字类的值不记
    const parts = Object.entries(args[0] as Record<string, unknown>).map(([key, value]) =>
      typeof value === "boolean" || typeof value === "number" ? `${key}=${value}` : key,
    );
    return parts.length ? `（${parts.join("，").slice(0, 200)}）` : "";
  }
  const short = args.filter((arg): arg is string => typeof arg === "string" && /^[a-z][a-z0-9-]{0,23}$/.test(arg));
  return short.length ? `（${short.join("，")}）` : "";
}

let installed = false;

export function installAppLog() {
  if (installed) return;
  installed = true;

  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]) =>
    handle(channel, async (event, ...args) => {
      const started = Date.now();
      const quiet = QUIET.test(channel);
      try {
        const result = await listener(event, ...args);
        const ms = Date.now() - started;
        if (!quiet || ms > SLOW_MS) log.info("ui", `${channel}${argsNote(channel, args)} 完成（${ms} ms）`);
        return result;
      } catch (error) {
        log.error("ui", `${channel}${argsNote(channel, args)} 失败（${Date.now() - started} ms）：${errorText(error)}`);
        throw error;
      }
    });

  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      const text = args.map((arg) => (arg instanceof Error ? `${arg.message}${arg.stack ? `\n${arg.stack.split("\n").slice(1, 4).join("\n")}` : ""}` : arg));
      (level === "error" ? log.error : log.warn)("main", format(...text));
    };
  }
  process.on("uncaughtExceptionMonitor", (error) => log.error("main", `没接住的异常：${error?.stack || errorText(error)}`));
  process.on("unhandledRejection", (reason) => console.warn(`[TokenPulse] 没人处理的 Promise 拒绝：${reason instanceof Error ? reason.stack || reason.message : errorText(reason)}`));

  app.on("web-contents-created", (_event, contents) => watchContents(contents));
  app.on("child-process-gone", (_event, details) => log.warn("main", `子进程退出：${details.type} ${details.reason}（退出码 ${details.exitCode}）`));
  app.on("will-quit", () => log.info("app", "TokenPulse 退出"));
}

function watchContents(contents: WebContents) {
  const page = () => {
    try {
      const url = new URL(contents.getURL());
      return url.pathname.split("/").pop() || url.protocol;
    } catch {
      return "窗口";
    }
  };
  contents.on("render-process-gone", (_event, details) => log.error("window", `${page()} 的界面进程退出：${details.reason}（退出码 ${details.exitCode}）`));
  contents.on("unresponsive", () => log.warn("window", `${page()} 没有响应`));
  contents.on("responsive", () => log.info("window", `${page()} 恢复响应`));
  contents.on("preload-error", (_event, _file, error) => log.error("window", `${page()} 的 preload 出错：${errorText(error)}`));
  // Electron 35 起参数合成一个事件对象；老写法是 (event, level, message, line, sourceId)
  contents.on("console-message", (...raw: unknown[]) => {
    const event = raw[0] as { level?: unknown; message?: unknown; lineNumber?: unknown; sourceId?: unknown };
    const level = event?.level ?? raw[1];
    if (level !== "error" && level !== 3) return;
    const message = String(event?.message ?? raw[2] ?? "");
    const line = event?.lineNumber ?? raw[3];
    const source = String(event?.sourceId ?? raw[4] ?? "").split("/").pop();
    log.error("window", `${page()} 报错：${message}${source ? `（${source}:${line}）` : ""}`);
  });
}

/** 启动时记一行环境：版本、系统、代理。排查网络问题时第一眼要看的。 */
export async function logAppStart(version: string) {
  const offset = -new Date().getTimezoneOffset() / 60;
  log.info("app", `TokenPulse ${version} 启动（Electron ${process.versions.electron}，${os.platform()} ${os.release()} ${os.arch()}，${app.isPackaged ? "安装版" : "开发版"}，时区 UTC${offset >= 0 ? "+" : ""}${offset}）`);
  for (const url of ["https://api.anthropic.com/", "https://chatgpt.com/"]) {
    try {
      const proxy = await proxyFor(new URL(url));
      log.info("app", `去 ${new URL(url).host} ${proxy ? `走代理 ${proxy.host}:${proxy.port}` : "直连"}`);
    } catch (error) {
      log.warn("app", `看不出去 ${new URL(url).host} 走不走代理：${errorText(error)}`);
    }
  }
}

// index.ts 第一个 import 本文件：加载时就装好，之后各模块注册的 IPC 都会被包上
installAppLog();
