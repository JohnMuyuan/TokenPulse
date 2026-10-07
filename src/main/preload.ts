import { contextBridge, ipcRenderer } from "electron";

/**
 * 渲染进程唯一的对外口子。只暴露这几个方法 —— 没有 nodeIntegration，
 * 界面碰不到文件系统，也就不用担心图表库之类的东西乱来。
 */
/*
 * 新手引导的演示模式：打开后，读数据的几个方法（快照、模型换算、请求流水）改走演示进程（main/demo.ts），
 * 主进程推过来的真实快照先不交给界面；会改数据的操作一律拒绝。关掉后界面重新读一次真实快照。
 */
let demo = false;
const blocked = () => Promise.reject(new Error("演示数据不能修改"));

contextBridge.exposeInMainWorld("tokenpulse", {
  /** 打开演示模式并返回演示快照；关掉时结束演示进程。 */
  demo: (on: boolean) => {
    demo = Boolean(on);
    return on ? ipcRenderer.invoke("demo:snapshot") : ipcRenderer.invoke("demo:end");
  },
  isDemo: () => demo,
  egressState: () => ipcRenderer.invoke("egress:state"),
  saveEgress: (config: unknown) => ipcRenderer.invoke("egress:save", config),
  checkEgress: () => ipcRenderer.invoke("egress:check"),
  clearEgressHistory: () => ipcRenderer.invoke("egress:clear"),
  /** 出口 IP 的归属 / 风险重新查一次（同一个 IP 一分钟一次）。 */
  refreshEgressIntel: (ip: string) => ipcRenderer.invoke("egress:intel", ip),
  onEgressState: (handler: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => handler(state);
    ipcRenderer.on("egress-state", listener);
    return () => ipcRenderer.off("egress-state", listener);
  },
  snapshot: () => ipcRenderer.invoke(demo ? "demo:snapshot" : "snapshot"),
  refresh: () => ipcRenderer.invoke(demo ? "demo:snapshot" : "refresh"),
  readPrefs: () => ipcRenderer.invoke("prefs:read"),
  writePrefs: (patch: Record<string, unknown>) => ipcRenderer.invoke("prefs:write", patch),
  officialAccounts: () => ipcRenderer.invoke("accounts:list"),
  loginOfficialAccount: (kind: string, replaceId?: string) => ipcRenderer.invoke("accounts:login", kind, replaceId),
  /** 添加本机 CLI 已经登录的账号（0.3.18）：不保存凭据，每次现读 CLI 的登录。 */
  addCliAccount: (kind: string) => ipcRenderer.invoke("accounts:add-cli", kind),
  /** 账号管理：remove 隐藏 / 普通删除，purge 完全删除 TokenPulse 记录，restore 恢复，rename 改名。 */
  manageOfficialAccount: (action: "remove" | "purge" | "restore" | "rename", id: string, alias?: string) => ipcRenderer.invoke("accounts:manage", action, id, alias),
  /** 拖拽排序：这一家账号的新顺序。 */
  reorderOfficialAccounts: (kind: string, ids: string[]) => ipcRenderer.invoke("accounts:reorder", kind, ids),
  openDataDir: () => ipcRenderer.invoke("open-data-dir"),
  /** 版本号从 package.json 来，界面上不再手写（以前每次发版都要记得改 index.html）。 */
  version: () => ipcRenderer.invoke("app:version"),
  /* 托盘小面板（tray-panel.html） */
  trayPanelData: () => ipcRenderer.invoke("tray-panel:data"),
  trayPanelSize: (height: number) => ipcRenderer.send("tray-panel:size", height),
  trayPanelAction: (action: "open" | "refresh" | "quit" | "close") => ipcRenderer.send("tray-panel:action", action),
  trayPanelActivate: (id: string) => ipcRenderer.send("tray-panel:activate", id),
  onTrayPanel: (handler: (data: unknown) => void) => {
    const listener = (_event: unknown, data: unknown) => handler(data);
    ipcRenderer.on("tray-panel", listener);
    return () => ipcRenderer.off("tray-panel", listener);
  },
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
  exportCsv: (content: string, kind?: "requests") => (demo ? blocked() : ipcRenderer.invoke("export-csv", content, kind)),
  /** 请求流水：按时间 / 工具 / 核验结论 / 关键词查询，分页返回，核验结论现算。 */
  modelCalibration: (query: unknown) => ipcRenderer.invoke("models:calibration", query),
  /** 「添加模型」的候选（知识库里这一家有单价的型号，带已知的思考等级）。 */
  modelCandidates: (kind: string) => ipcRenderer.invoke("models:candidates", kind),
  modelStudy: (query: unknown) => ipcRenderer.invoke(demo ? "demo:study" : "models:study", query),
  modelOffMachine: (value: unknown) => (demo ? blocked() : ipcRenderer.invoke("models:offmachine", value)),
  requests: (query: Record<string, unknown>) => ipcRenderer.invoke(demo ? "demo:requests" : "requests:query", query),
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
  /** 新对话 / 新项目（0.3.16）：装了哪些 CLI、选文件夹、在文件夹里用某个 CLI 开新对话。 */
  sessionClis: () => ipcRenderer.invoke("sessions:clis"),
  pickProjectFolder: (start?: string) => (demo ? Promise.resolve(null) : ipcRenderer.invoke("sessions:pick-folder", start)),
  startSession: (kind: string, folder: string) => (demo ? blocked() : ipcRenderer.invoke("sessions:new", kind, folder)),
  deleteSession: (kind: string, id: string) => ipcRenderer.invoke("sessions:delete", kind, id),
  /** 模型知识库（型号单价和等价规则）：当前版本、上次检查；手动检查更新。 */
  knowledgeState: () => ipcRenderer.invoke("knowledge:state"),
  checkKnowledge: () => ipcRenderer.invoke("knowledge:check"),
  /** 立刻从 CC Switch 的库同步一次，返回新快照。 */
  syncCcSwitch: () => ipcRenderer.invoke("ccswitch:sync"),
  /** 供应商切换和本地路由。列表里的密钥已打码。 */
  /** Prism 桥（0.3.19）：随软件带的 Prism Bridge，装环境、登录、启动 / 停止、加成 Codex 供应商。 */
  prismState: () => ipcRenderer.invoke("prism:state"),
  prismInstall: () => ipcRenderer.invoke("prism:install"),
  prismLogin: () => ipcRenderer.invoke("prism:login"),
  prismStart: () => ipcRenderer.invoke("prism:start"),
  prismStop: () => ipcRenderer.invoke("prism:stop"),
  prismAutoStart: (on: boolean) => ipcRenderer.invoke("prism:auto-start", on),
  prismProvider: () => ipcRenderer.invoke("prism:provider"),
  prismFixProxy: () => ipcRenderer.invoke("prism:fix-proxy"),
  prismOpenLog: () => ipcRenderer.invoke("prism:open-log"),
  prismUsage: () => ipcRenderer.invoke("prism:usage"),
  prismRemove: () => ipcRenderer.invoke("prism:remove"),
  onPrism: (handler: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => handler(state);
    ipcRenderer.on("prism-bridge", listener);
    return () => ipcRenderer.off("prism-bridge", listener);
  },
  agentState: () => ipcRenderer.invoke("agent:state"),
  agentSave: (input: unknown) => ipcRenderer.invoke("agent:save", input),
  agentDelete: (id: string) => ipcRenderer.invoke("agent:delete", id),
  agentActivate: (id: string) => ipcRenderer.invoke("agent:activate", id),
  agentProxy: (app: string, on: boolean) => ipcRenderer.invoke("agent:proxy", app, on),
  agentPort: (port: number) => ipcRenderer.invoke("agent:port", port),
  agentFailover: (id: string, on: boolean) => ipcRenderer.invoke("agent:failover", id, on),
  agentReorder: (app: string, ids: string[]) => ipcRenderer.invoke("agent:reorder", app, ids),
  agentImportCc: () => ipcRenderer.invoke("agent:import-cc"),
  agentImportLive: (app: string) => ipcRenderer.invoke("agent:import-live", app),
  agentProbe: (id: string) => ipcRenderer.invoke("agent:probe", id),
  agentModels: (input: unknown) => ipcRenderer.invoke("agent:models", input),
  /** 确认预览过的改动（agentSave / agentActivate 等返回 confirm 时）。 */
  agentConfirm: (token: string) => ipcRenderer.invoke("agent:confirm", token),
  agentBackups: () => ipcRenderer.invoke("agent:backups"),
  agentRestore: (kind: "history" | "original", id: string) => ipcRenderer.invoke("agent:restore", kind, id),
  agentReadOnly: (on: boolean) => ipcRenderer.invoke("agent:readonly", on),
  /** 工具配置被改走了（0.3.10）：现在的情况，和之后新出现的。 */
  agentDriftNow: () => ipcRenderer.invoke("agent:drift"),
  /** 启动时自动修复了什么（0.3.15）：只返回一次。 */
  agentStartupNotice: () => (demo ? Promise.resolve("") : ipcRenderer.invoke("agent:startup-notice")),
  onAgentDrift: (handler: (drifts: unknown) => void) => {
    const listener = (_event: unknown, drifts: unknown) => handler(drifts);
    ipcRenderer.on("agent-drift", listener);
    return () => ipcRenderer.off("agent-drift", listener);
  },
  /** 托盘里点了切换：交给供应商页走确认流程。 */
  onAgentActivateRequest: (handler: (id: string) => void) => {
    const listener = (_event: unknown, id: string) => handler(id);
    ipcRenderer.on("agent-activate-request", listener);
    return () => ipcRenderer.off("agent-activate-request", listener);
  },
  onAgentSwitch: (handler: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => handler(state);
    ipcRenderer.on("agent-switch", listener);
    return () => ipcRenderer.off("agent-switch", listener);
  },
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
    // 演示期间真实快照不交给界面（演示结束后界面会自己重读一次）
    const listener = (_event: unknown, snapshot: unknown) => { if (!demo) handler(snapshot); };
    ipcRenderer.on("snapshot", listener);
    return () => ipcRenderer.off("snapshot", listener);
  },
});
