import { app, utilityProcess, type UtilityProcess } from "electron";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * 新手引导的演示数据（0.3.9）。
 *
 * 第一次用的人没有登录账号、也没有用量，引导里的「额度容量趋势」「换一种模型」「时间线」全是空的，看不出是干什么的。
 * 引导期间界面改读一份虚构的演示账号（src/core/demo-data.ts），由一个单独的 utilityProcess 计算：
 * - 数据目录和主目录都指向系统临时目录下的 tokenpulse-demo-<pid>，和用户真实数据完全隔开；
 * - 这个进程只读算，不扫描、不查额度、不改 CLI 配置；主进程这边也不把演示结果写进任何缓存；
 * - 引导结束（或退出程序）就结束进程、删掉临时目录。
 */
let child: UtilityProcess | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function demoRoot() {
  return path.join(os.tmpdir(), `tokenpulse-demo-${process.pid}`);
}

/** 上次异常退出（崩溃、被结束进程）留下的演示目录：目录名里的 pid 已经不在了就删掉。 */
function sweepStale() {
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      const pid = Number(/^tokenpulse-demo-(\d+)$/.exec(name)?.[1]);
      if (!pid || pid === process.pid) continue;
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      if (!alive) fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
    }
  } catch { /* 临时目录读不了就算了 */ }
}

function spawn(): UtilityProcess {
  if (child) return child;
  sweepStale();
  const root = demoRoot();
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value != null) env[key] = value;
  for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME"]) delete env[key];
  Object.assign(env, {
    TOKENPULSE_DATA_DIR: path.join(root, "data"),
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    AGENT_SWITCH_HOME: path.join(root, "home"),
    APPDATA: path.join(root, "home", "AppData", "Roaming"),
    LOCALAPPDATA: path.join(root, "home", "AppData", "Local"),
  });
  const proc = utilityProcess.fork(path.join(__dirname, "..", "core", "demo-worker.js"), [], { env, serviceName: "TokenPulse Demo", stdio: "ignore" });
  proc.on("message", (message: { id: number; result?: unknown; error?: string }) => {
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    if (message.error) job.reject(new Error(message.error));
    else job.resolve(message.result);
  });
  proc.on("exit", () => {
    // 引导结束时主动停掉的：还没回来的请求给空结果（界面已经不要了），不当成错误
    const stopped = child !== proc;
    if (child === proc) child = null;
    for (const job of pending.values()) stopped ? job.resolve(null) : job.reject(new Error("演示进程已退出"));
    pending.clear();
  });
  child = proc;
  return proc;
}

export function demoCall(op: "snapshot" | "study" | "requests", query?: unknown): Promise<unknown> {
  const proc = spawn();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.postMessage({ id, op, query });
  });
}

/** 结束演示：停掉进程、删掉临时目录。可以重复调用。 */
export function endDemo() {
  const proc = child;
  child = null;
  if (proc) {
    proc.once("exit", () => fs.rmSync(demoRoot(), { recursive: true, force: true }));
    proc.kill();
  } else {
    fs.rmSync(demoRoot(), { recursive: true, force: true });
  }
}

export function demoRunning() {
  return Boolean(child);
}

app.on("will-quit", () => {
  child?.kill();
  child = null;
  try { fs.rmSync(demoRoot(), { recursive: true, force: true }); } catch { /* 进程还没完全退出时删不掉，系统临时目录会自己清 */ }
});
