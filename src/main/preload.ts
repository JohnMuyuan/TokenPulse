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
  openDataDir: () => ipcRenderer.invoke("open-data-dir"),
  exportCsv: (content: string) => ipcRenderer.invoke("export-csv", content),
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
