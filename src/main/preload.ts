import { contextBridge, ipcRenderer } from "electron";

/**
 * 渲染进程唯一的对外口子。只暴露这几个方法 —— 没有 nodeIntegration，
 * 界面碰不到文件系统，也就不用担心图表库之类的东西乱来。
 */
contextBridge.exposeInMainWorld("tokenpulse", {
  snapshot: () => ipcRenderer.invoke("snapshot"),
  refresh: () => ipcRenderer.invoke("refresh"),
  readPrefs: () => ipcRenderer.invoke("prefs:read"),
  writePrefs: (patch: Record<string, unknown>) => ipcRenderer.invoke("prefs:write", patch),
  officialAccounts: () => ipcRenderer.invoke("accounts:list"),
  loginOfficialAccount: (kind: string, replaceId?: string) => ipcRenderer.invoke("accounts:login", kind, replaceId),
  /** 账号管理：remove 隐藏 / 普通删除，purge 完全删除 TokenPulse 记录，restore 恢复，rename 改名。 */
  manageOfficialAccount: (action: "remove" | "purge" | "restore" | "rename", id: string, alias?: string) => ipcRenderer.invoke("accounts:manage", action, id, alias),
  /** 拖拽排序：这一家账号的新顺序。 */
  reorderOfficialAccounts: (kind: string, ids: string[]) => ipcRenderer.invoke("accounts:reorder", kind, ids),
  openDataDir: () => ipcRenderer.invoke("open-data-dir"),
  /** 版本号从 package.json 来，界面上不再手写（以前每次发版都要记得改 index.html）。 */
  version: () => ipcRenderer.invoke("app:version"),
  updateState: () => ipcRenderer.invoke("update:state"),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateState: (handler: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => handler(state);
    ipcRenderer.on("update-state", listener);
    return () => ipcRenderer.off("update-state", listener);
  },
  /** 自绘标题栏的三个按钮（窗口是 frame: false）。 */
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowToggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  windowState: () => ipcRenderer.invoke("window:state"),
  onWindowState: (handler: (state: { maximized: boolean }) => void) => {
    const listener = (_event: unknown, state: { maximized: boolean }) => handler(state);
    ipcRenderer.on("window-state", listener);
    return () => ipcRenderer.off("window-state", listener);
  },
  setTheme: (theme: "light" | "dark") => ipcRenderer.invoke("theme", theme),
  exportCsv: (content: string, kind?: "requests") => ipcRenderer.invoke("export-csv", content, kind),
  /** 请求流水：按时间 / 工具 / 核验结论 / 关键词查询，分页返回，核验结论现算。 */
  requests: (query: Record<string, unknown>) => ipcRenderer.invoke("requests:query", query),
  /** 会话管理：列表、详情（只读本机 CLI 的会话文件）。 */
  sessions: () => ipcRenderer.invoke("sessions:list"),
  sessionDetail: (kind: string, id: string) => ipcRenderer.invoke("sessions:detail", kind, id),
  copySessionProject: (kind: string, id: string) => ipcRenderer.invoke("sessions:copy-project", kind, id),
  copyText: (text: string) => ipcRenderer.invoke("sessions:copy-text", text),
  /** 在 TokenPulse 里直接回复：返回 runId，过程通过 onSessionReply 推回来。 */
  replySession: (kind: string, id: string, prompt: string, mode: "readonly" | "edit") => ipcRenderer.invoke("sessions:reply", kind, id, prompt, mode),
  stopSessionReply: (runId: string) => ipcRenderer.invoke("sessions:reply-stop", runId),
  onSessionReply: (handler: (event: unknown) => void) => {
    const listener = (_event: unknown, event: unknown) => handler(event);
    ipcRenderer.on("session-reply", listener);
    return () => ipcRenderer.off("session-reply", listener);
  },
  openSessionTerminal: (kind: string, id: string) => ipcRenderer.invoke("sessions:terminal", kind, id),
  deleteSession: (kind: string, id: string) => ipcRenderer.invoke("sessions:delete", kind, id),
  /** 模型知识库（型号单价和等价规则）：当前版本、上次检查；手动检查更新。 */
  knowledgeState: () => ipcRenderer.invoke("knowledge:state"),
  checkKnowledge: () => ipcRenderer.invoke("knowledge:check"),
  /** 立刻从 CC Switch 的库同步一次，返回新快照。 */
  syncCcSwitch: () => ipcRenderer.invoke("ccswitch:sync"),
  /** 主进程让界面跳到某一页（点了型号不一致的通知）。 */
  onOpenPage: (handler: (target: { page: string; status?: string }) => void) => {
    const listener = (_event: unknown, target: { page: string; status?: string }) => handler(target);
    ipcRenderer.on("open-page", listener);
    return () => ipcRenderer.off("open-page", listener);
  },
  onError: (handler: (message: string) => void) => {
    const listener = (_event: unknown, message: string) => handler(message);
    ipcRenderer.on("refresh-error", listener);
    return () => ipcRenderer.off("refresh-error", listener);
  },
  /** 主进程每轮刷新完会主动推一份，界面不用自己轮询。 */
  onSnapshot: (handler: (snapshot: unknown) => void) => {
    const listener = (_event: unknown, snapshot: unknown) => handler(snapshot);
    ipcRenderer.on("snapshot", listener);
    return () => ipcRenderer.off("snapshot", listener);
  },
});
