import { parentPort, workerData } from "worker_threads";
import { buildSnapshot } from "./report";
import { scanLocalUsage } from "./usage-scan";

// 扫描、JSON 解析和汇总都含同步 CPU / 文件操作，不能占用 Electron 的窗口事件循环。
if (workerData.scan) scanLocalUsage();
parentPort!.postMessage(buildSnapshot());
