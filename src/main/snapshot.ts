import path from "path";
import { Worker } from "worker_threads";
import type { Snapshot } from "../core/report";

/** 一次任务一个 worker，完成后自动退出；失败会传回调用方，不留下悬空的 IPC。 */
export function loadSnapshot(scan: boolean): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "..", "core", "report-worker.js"), {
      workerData: { scan },
    });
    let received = false;
    worker.once("message", (snapshot: Snapshot) => {
      received = true;
      resolve(snapshot);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!received) reject(new Error(`统计线程提前退出 (${code})`));
    });
  });
}
