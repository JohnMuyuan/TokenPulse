import type { ModelStudies, ModelStudyQuery } from "../core/model-study";
import type { DeepSeekQuery } from "../core/deepseek-insight";
import type { PoolQuery } from "../core/pool-insight";
import path from "path";
import { Worker } from "worker_threads";
import type { Snapshot } from "../core/report";
import type { RequestPage, RequestQuery } from "../core/request-log";
import type { SessionDetail, SessionSummary } from "../core/sessions";
import type { SearchResult } from "../core/session-search";

/**
 * 扫描与查询隔离执行器：
 *
 * 在 Electron 运行时使用单个短空闲复用的 `utilityProcess`（独立 OS 进程）：
 * - 连续查询/刷新复用同一进程，免去反复冷启动开销，并天然串行化并发大查询（避免多份 40 MB 流水同时拉高峰值）；
 * - 空闲 3 秒无在途任务即自动退出，由操作系统 100% 回收全部内存，绝不在主进程残留 V8/原生堆碎片。
 * - 非 Electron 环境（如 Node 单测）回退到一次性 `worker_threads.Worker`。
 */
const UTILITY_IDLE_MS = 3_000;
type PendingTask = { resolve: (value: unknown) => void; reject: (error: Error) => void };
let utilityChild: Electron.UtilityProcess | null = null;
let utilityEnvSig = "";
let utilityNextId = 1;
let utilityIdleTimer: ReturnType<typeof setTimeout> | null = null;
let utilityQuitHooked = false;
const utilityPending = new Map<number, PendingTask>();

function envSignature() {
  return [
    process.env.TOKENPULSE_DATA_DIR || "",
    process.env.HOME || "",
    process.env.USERPROFILE || "",
    process.env.AGENT_SWITCH_HOME || "",
    process.env.TOKENPULSE_ANTIGRAVITY_DIR || "",
    process.env.TOKENPULSE_DSH_HOME || "",
    process.env.PI_CODING_AGENT_DIR || "",
    process.env.TZ || "",
  ].join("\u0000");
}

function clearUtilityIdleTimer() {
  if (utilityIdleTimer) {
    clearTimeout(utilityIdleTimer);
    utilityIdleTimer = null;
  }
}

function shutdownUtilityProcess() {
  clearUtilityIdleTimer();
  const child = utilityChild;
  utilityChild = null;
  utilityEnvSig = "";
  if (!child) return;
  try { child.postMessage({ shutdown: true }); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
}

function scheduleUtilityIdleShutdown() {
  clearUtilityIdleTimer();
  if (!utilityChild || utilityPending.size > 0) return;
  utilityIdleTimer = setTimeout(() => {
    utilityIdleTimer = null;
    if (utilityPending.size === 0) shutdownUtilityProcess();
  }, UTILITY_IDLE_MS);
  utilityIdleTimer.unref?.();
}

function runInUtilityProcess<T>(workerPath: string, workerData: Record<string, unknown>): Promise<T> | null {
  if (!process.versions.electron || process.env.TOKENPULSE_USE_WORKER_THREADS === "1") return null;
  let electronMod: typeof import("electron") | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    electronMod = require("electron") as typeof import("electron");
  } catch {
    return null;
  }
  if (!electronMod?.app?.isReady?.() || !electronMod.utilityProcess?.fork) return null;
  if (!utilityQuitHooked) {
    utilityQuitHooked = true;
    electronMod.app.once("before-quit", shutdownUtilityProcess);
  }

  const sig = envSignature();
  if (utilityChild && utilityEnvSig !== sig && utilityPending.size === 0) {
    shutdownUtilityProcess();
  }
  clearUtilityIdleTimer();

  if (!utilityChild) {
    const child = electronMod.utilityProcess.fork(workerPath, [], {
      env: { ...process.env },
      serviceName: "TokenPulse Scan Worker",
    });
    utilityChild = child;
    utilityEnvSig = sig;
    child.on("message", (msg: unknown) => {
      const packet = msg as { id?: number; ok?: boolean; result?: unknown; error?: string } | null;
      if (!packet || typeof packet !== "object" || typeof packet.id !== "number") return;
      const task = utilityPending.get(packet.id);
      if (!task) return;
      utilityPending.delete(packet.id);
      if (packet.ok) task.resolve(packet.result);
      else task.reject(new Error(packet.error || "统计进程执行失败"));
      if (utilityPending.size === 0) scheduleUtilityIdleShutdown();
    });
    child.once("exit", (code) => {
      if (utilityChild === child) {
        clearUtilityIdleTimer();
        utilityChild = null;
        utilityEnvSig = "";
      }
      if (utilityPending.size > 0) {
        const err = new Error(`统计进程提前退出 (${code})`);
        for (const task of utilityPending.values()) task.reject(err);
        utilityPending.clear();
      }
    });
  }

  return new Promise<T>((resolve, reject) => {
    const id = utilityNextId++;
    utilityPending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    try {
      utilityChild!.postMessage({ id, data: workerData });
    } catch (error) {
      utilityPending.delete(id);
      shutdownUtilityProcess();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function runWorker<T>(workerData: Record<string, unknown>): Promise<T> {
  const workerPath = path.join(__dirname, "..", "core", "report-worker.js");
  const isolated = runInUtilityProcess<T>(workerPath, workerData);
  if (isolated) return isolated;

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData });
    let settled = false;

    const cleanup = () => {
      if (!settled) settled = true;
      worker.terminate().catch(() => {});
    };

    worker.once("message", (result: T) => {
      cleanup();
      resolve(result);
    });
    worker.once("error", (err) => {
      cleanup();
      reject(err);
    });
    worker.once("exit", (code) => {
      const wasSettled = settled;
      cleanup();
      if (!wasSettled) reject(new Error(`统计线程提前退出 (${code})`));
    });
  });
}

/** ccSwitch：不管 10 分钟的间隔，立刻重读一次 CC Switch 的库（设置里点了「立即同步」）。 */
export function loadSnapshot(scan: boolean, ccSwitch = false): Promise<Snapshot> {
  return runWorker<Snapshot>({ scan, ccSwitch });
}

/** 请求流水查询。流水按月分文件，读几个月的量在主线程上会卡界面。 */
export function loadRequests(query: RequestQuery): Promise<RequestPage> {
  return runWorker<RequestPage>({ query });
}

/** 会话列表和详情也放到 worker，读取几十个 Agent 会话文件时不阻塞窗口。 */
export function loadSessions(): Promise<SessionSummary[]> {
  return runWorker<SessionSummary[]>({ sessions: "list" });
}

export function loadSessionDetail(kind: string, id: string): Promise<SessionDetail | null> {
  return runWorker<SessionDetail | null>({ sessions: "detail", kind, id });
}

/** 会话全文搜索（0.3.55）：第一次要把所有会话抽成文字，可能要几秒。 */
export function searchSessionText(query: string, kind: string): Promise<SearchResult> {
  return runWorker<SearchResult>({ sessions: "search", query, kind });
}

/** DeepSeek 账号页的分析：读余额历史和 DeepSeek Harness 的流水，同样放在 worker 里。 */
export function loadDeepSeek<T = unknown>(query: DeepSeekQuery): Promise<T> {
  return runWorker<T>({ deepseek: query });
}

/** 额度详情的号池页（0.3.44）：读转发记录和额度采样，放在 worker 里。 */
export function loadPool<T = unknown>(query: PoolQuery): Promise<T> {
  return runWorker<T>({ pool: query });
}

/** 模型容量校准和周期时间轴在 worker 计算，不占用窗口事件循环。 */
export function loadModelStudy(query: ModelStudyQuery): Promise<ModelStudies> {
  return runWorker<ModelStudies>({ modelStudy: query });
}
