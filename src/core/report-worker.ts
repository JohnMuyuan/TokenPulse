import { parentPort, workerData } from "worker_threads";
import { buildSnapshot } from "./report";
import { queryRequests, recentAlerts } from "./request-log";
import { scanLocalUsage } from "./usage-scan";
import { ccSwitchEnabled, syncCcSwitch } from "./cc-switch";
import { recordCliLogins } from "./login-timeline";
import { getSession, listSessions } from "./sessions";

function localDay(at: number) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 扫描、JSON 解析和汇总都含同步 CPU / 文件操作，不能占用 Electron 的窗口事件循环。
if (workerData.sessions === "list") {
  parentPort!.postMessage(listSessions());
} else if (workerData.sessions === "detail") {
  parentPort!.postMessage(getSession(workerData.kind, workerData.id));
} else if (workerData.query) {
  // 请求流水查询：按月读文件、现算核验，同样放在 worker 里
  parentPort!.postMessage(queryRequests(workerData.query));
} else {
  if (workerData.scan) {
    try {
      // 先记下各 CLI 现在登录的是谁，再扫：这一轮新请求按它对账号
      recordCliLogins();
    } catch (error) {
      console.error("[TokenPulse] 读取 CLI 登录失败", error);
    }
  }
  const scanned = workerData.scan ? scanLocalUsage() : null;
  if ((workerData.scan || workerData.ccSwitch) && ccSwitchEnabled()) {
    try {
      syncCcSwitch(Boolean(workerData.ccSwitch));
    } catch (error) {
      // 读不了 CC Switch 的库不影响自己的统计
      console.error("[TokenPulse] CC Switch 同步失败", error);
    }
  }
  const snapshot = buildSnapshot();
  if (scanned?.records.length) snapshot.requestAlerts = recentAlerts(scanned.records, snapshot.now);
  // 侧栏红点：最近 7 天型号不一致 / 响应存疑的次数。只读最近一两个月的流水，几十毫秒。
  const week = queryRequests({
    from: localDay(snapshot.now - 6 * 86_400_000),
    to: localDay(snapshot.now),
    source: "all",
    status: "all",
    search: "",
    sort: "time",
    page: 0,
    pageSize: 1,
  });
  snapshot.requestFlags = { flagged: week.counts.mismatch + week.counts.suspect, mismatch: week.counts.mismatch, suspect: week.counts.suspect };
  parentPort!.postMessage(snapshot);
  if (workerData.scan) {
    try {
      // 快照已经发出去了，顺手把会话索引更新一下：第一次打开会话页从 3~5 秒变成几十毫秒
      listSessions();
    } catch (error) {
      console.error("[TokenPulse] 预读会话索引失败", error);
    }
  }
}
