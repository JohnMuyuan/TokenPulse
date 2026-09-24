import path from "path";
import { Worker } from "worker_threads";
import type { Snapshot } from "../core/report";
import type { RequestPage, RequestQuery } from "../core/request-log";
import type { SessionDetail, SessionSummary } from "../core/sessions";

/** 一次任务一个 worker，完成后自动退出；失败会传回调用方，不留下悬空的 IPC。 */
function runWorker<T>(workerData: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "..", "core", "report-worker.js"), { workerData });
    let received = false;
    worker.once("message", (result: T) => {
      received = true;
      resolve(result);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!received) reject(new Error(`统计线程提前退出 (${code})`));
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
