import { app, utilityProcess, type UtilityProcess } from "electron";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * 新手引导的演示数据（0.3.9）。
 *
 * 第一次用的人没有登录账号、也没有用量，引导里的「额度容量趋势」「换一种模型」「时间线」全是空的，看不出是干什么的。
 * 引导期间界面改读一份虚构的演示账号（src/core/demo-data.ts），由一个单独的 utilityProcess 计算：
 * - 每个进程单独使用系统临时目录下的 tokenpulse-demo-<pid>-<后缀>，和用户真实数据完全隔开；
 * - 这个进程只读算，不扫描、不查额度、不改 CLI 配置；主进程这边也不把演示结果写进任何缓存；
 * - 引导结束（或退出程序）就结束进程、删掉临时目录。
 */
type DemoProcess = {
  proc: UtilityProcess;
  root: string;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
};
let child: DemoProcess | null = null;
let seq = 0;

function removeDemoRoot(root: string) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 下次启动演示时再清 */ }
}

/** 上次异常退出（崩溃、被结束进程）留下的演示目录：目录名里的 pid 已经不在了就删掉。 */
function sweepStale() {
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      const pid = Number(/^tokenpulse-demo-(\d+)(?:-[a-z0-9]{6})?$/i.exec(name)?.[1]);
      if (!pid || pid === process.pid) continue;
      try { process.kill(pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") removeDemoRoot(path.join(os.tmpdir(), name));
      }
    }
  } catch { /* 临时目录读不了就算了 */ }
}

function spawn(): DemoProcess {
  if (child) return child;
  sweepStale();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tokenpulse-demo-${process.pid}-`));
  const env: Record<string, string> = {};
  const stripKeys = new Set([
    "codex_home",
    "claude_config_dir",
    "grok_home",
    "tokenpulse_dsh_home",
    "pi_coding_agent_dir",
    "tokenpulse_antigravity_dir",
    "tokenpulse_data_dir",
    "home",
    "userprofile",
    "agent_switch_home",
    "appdata",
    "localappdata",
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null && !stripKeys.has(key.toLowerCase())) env[key] = value;
  }
  Object.assign(env, {
    TOKENPULSE_DATA_DIR: path.join(root, "data"),
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    AGENT_SWITCH_HOME: path.join(root, "home"),
    APPDATA: path.join(root, "home", "AppData", "Roaming"),
    LOCALAPPDATA: path.join(root, "home", "AppData", "Local"),
  });
  let proc: UtilityProcess;
  try {
    fs.mkdirSync(env.HOME, { recursive: true });
    proc = utilityProcess.fork(path.join(__dirname, "..", "core", "demo-worker.js"), [], { env, serviceName: "TokenPulse Demo", stdio: "ignore" });
  } catch (error) {
    removeDemoRoot(root);
    throw error;
  }
  const instance: DemoProcess = { proc, root, pending: new Map() };
  const { pending } = instance;
  proc.on("message", (message: { id: number; result?: unknown; error?: string }) => {
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    if (message.error) job.reject(new Error(message.error));
    else job.resolve(message.result);
  });
  proc.on("exit", () => {
    // 引导结束时主动停掉的：还没回来的请求给空结果（界面已经不要了），不当成错误
    const stopped = child !== instance;
    if (!stopped) child = null;
    for (const job of pending.values()) stopped ? job.resolve(null) : job.reject(new Error("演示进程已退出"));
    pending.clear();
    removeDemoRoot(root);
  });
  child = instance;
  return instance;
}

export function demoCall(op: "snapshot" | "study" | "requests", query?: unknown): Promise<unknown> {
  const { proc, pending } = spawn();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try { proc.postMessage({ id, op, query }); } catch (error) { pending.delete(id); reject(error); }
  });
}

/** 结束演示：停掉进程、删掉临时目录。可以重复调用。 */
export function endDemo() {
  const instance = child;
  child = null;
  if (!instance) return;
  try { instance.proc.kill(); } catch { /* ignore */ }
  removeDemoRoot(instance.root);
}

export function demoRunning() {
  return Boolean(child);
}

app.on("will-quit", endDemo);
