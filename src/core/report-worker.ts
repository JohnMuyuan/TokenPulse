import { queryModelStudy } from "./model-study";
import { queryDeepSeek } from "./deepseek-insight";
import { queryPool } from "./pool-insight";
import { parentPort, workerData } from "worker_threads";
import { buildSnapshot } from "./report";
import { queryRequests, recentAlerts } from "./request-log";
import { scanLocalUsage } from "./usage-scan";
import { ccSwitchEnabled, syncCcSwitch } from "./cc-switch";
import { recordCliLogins } from "./login-timeline";
import { recordPiLogins } from "./pi-accounts";
import { getSession, hasCurrentSessionIndex, listSessions } from "./sessions";
import { searchSessions } from "./session-search";

// 扫描、JSON 解析和汇总都含同步 CPU / 文件操作，不能占用 Electron 的窗口事件循环。
// 同时支持 Electron utilityProcess（独立短命 OS 进程，退出即 100% 归还内存、不在主进程留堆碎片）与 Node worker_threads。
function runTask(data: Record<string, any>) {
  if (data.deepseek) {
    // DeepSeek 账号页的分析（余额历史 + DeepSeek Harness 的流水）
    return queryDeepSeek(data.deepseek);
  }
  if (data.pool) {
    // 额度详情的号池页（0.3.44）：读转发记录和额度采样
    return queryPool(data.pool);
  }
  if (data.modelStudy) {
    return queryModelStudy(data.modelStudy);
  }
  if (data.sessions === "list") {
    return listSessions();
  }
  if (data.sessions === "detail") {
    return getSession(data.kind, data.id);
  }
  if (data.sessions === "search") {
    return searchSessions(data.query, data.kind);
  }
  if (data.query) {
    // 请求流水查询：按月读文件、现算核验，同样放在 worker 里
    return queryRequests(data.query);
  }
  if (data.scan) {
    try {
      // 先记下各 CLI 现在登录的是谁，再扫：这一轮新请求按它对账号
      recordCliLogins();
    } catch (error) {
      console.error("[TokenPulse] 读取 CLI 登录失败", error);
    }
    try {
      recordPiLogins();
    } catch (error) {
      console.error("[TokenPulse] 读取 pi 登录失败", error);
    }
  }
  const scanned = data.scan ? scanLocalUsage() : null;
  if ((data.scan || data.ccSwitch) && ccSwitchEnabled()) {
    try {
      syncCcSwitch(Boolean(data.ccSwitch));
    } catch (error) {
      // 读不了 CC Switch 的库不影响自己的统计
      console.error("[TokenPulse] CC Switch 同步失败", error);
    }
  }
  const snapshot = buildSnapshot();
  if (scanned?.records.length) snapshot.requestAlerts = recentAlerts(scanned.records, snapshot.now);
  // 侧栏红点：最近 7 天型号不一致 / 响应存疑的次数。只读最近一两个月的流水，几十毫秒。
  const week = queryRequests({
    from: snapshot.daily.at(-7)!.day,
    to: snapshot.daily.at(-1)!.day,
    source: "all",
    status: "all",
    search: "",
    sort: "time",
    page: 0,
    pageSize: 1,
    skipSessionMeta: true,
  });
  snapshot.requestFlags = { flagged: week.counts.mismatch + week.counts.suspect, mismatch: week.counts.mismatch, suspect: week.counts.suspect, latest: week.latestFlagAt || 0 };
  if (data.scan && !hasCurrentSessionIndex()) {
    try {
      // 仅在尚未建索引或索引版本升级时预热一次，避免每分钟后台扫描重读活跃大库导致主进程水位升高
      listSessions();
    } catch (error) {
      console.error("[TokenPulse] 预读会话索引失败", error);
    }
  }
  return snapshot;
}

type UtilityParentPort = {
  on: (event: string, listener: (ev: { data: Record<string, any> }) => void) => void;
  postMessage: (message: unknown) => void;
  start?: () => void;
};
const utilityPort = (process as unknown as { parentPort?: UtilityParentPort }).parentPort;

if (parentPort) {
  parentPort.postMessage(runTask((workerData ?? {}) as Record<string, any>));
} else if (utilityPort) {
  // Electron utilityProcess 的 process.parentPort 不会自动 ref libuv 事件循环：
  // 保持 ref 直到父进程在空闲超时后发送 shutdown 或 kill()，兼顾连续查询低延迟与空闲 100% 内存回收。
  const keepAlive = setInterval(() => {}, 60_000);
  utilityPort.on("message", (event) => {
    const packet = (event?.data ?? {}) as { id?: number; data?: Record<string, any>; shutdown?: boolean };
    if (packet.shutdown) {
      clearInterval(keepAlive);
      process.exit(0);
    }
    const id = packet.id;
    const payload = packet.data ?? (packet as Record<string, any>);
    try {
      const result = runTask(payload);
      utilityPort.postMessage({ id, ok: true, result });
    } catch (error) {
      utilityPort.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  utilityPort.start?.();
}
