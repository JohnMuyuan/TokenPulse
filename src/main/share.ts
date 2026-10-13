/**
 * 分享卡片（0.3.51）：月报、里程碑的数据，把卡片画成 PNG，保存 / 复制。
 *
 * 卡片在一个看不见的窗口里画（renderer/share-card.html），和软件界面同一套颜色和字体；
 * 画完截图成 PNG，界面上预览的就是最后保存的那张。窗口用完就关，不留着。
 */
import { BrowserWindow, ClipboardItem, clipboard, dialog, nativeImage } from "electron";
import fs from "fs/promises";
import path from "path";
import type { Snapshot } from "../core/report";
import type { HourAggregate } from "../core/request-log";
import { isMonth, milestoneState, monthReport, reportMonths } from "../core/share-report";
import { speedSeries } from "../core/pass-speed";
import { loadRequests } from "./snapshot";
import { tr } from "./i18n";

type SnapshotSource = () => Promise<Snapshot>;

function lastDayOf(month: string) {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
}

export async function shareMonth(snapshot: SnapshotSource, month: unknown) {
  const snap = await snapshot();
  const months = reportMonths(snap.usage);
  const pick = isMonth(month) ? month : months[0];
  if (!pick) return { months, report: null };
  let hours: HourAggregate[] = [];
  try {
    const page = await loadRequests({ from: `${pick}-01`, to: lastDayOf(pick), source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 1, aggregate: true });
    hours = page.aggregate?.hours ?? [];
  } catch { /* 流水读不了：月报里不画夜猫子那一块 */ }
  let speed = null;
  const [year, number] = pick.split("-").map(Number);
  // 月报只读附近一个月，保持按天分桶，避免全历史的周桶跨过月份边界。
  try { speed = speedSeries(35, Math.min(Date.now(), new Date(year, number, 1).getTime() - 60_001)); } catch { /* 没有转发记录 */ }
  return { months, report: monthReport({ usage: snap.usage, month: pick, hours, speed }) };
}

export async function shareMilestones(snapshot: SnapshotSource) {
  const snap = await snapshot();
  return milestoneState(snap.usage, snap.now);
}

/** 画一张卡片，返回 PNG 的 data URL。kind：month / milestone。 */
let rendering: Promise<string> = Promise.resolve("");
export function renderShareCard(kind: unknown, data: unknown, options: unknown): Promise<string> {
  if (kind !== "month" && kind !== "milestone") return Promise.reject(new Error("卡片类型无效"));
  // 一次只画一张：连点两下不会开两个窗口
  rendering = rendering.catch(() => "").then(() => render(kind, data, options));
  return rendering;
}
async function render(kind: string, data: unknown, options: unknown) {
  const win = new BrowserWindow({ width: 1160, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
  try {
    await win.loadFile(path.join(__dirname, "..", "..", "renderer", "share-card.html"));
    const height = await win.webContents.executeJavaScript(`window.renderShareCard(${JSON.stringify(kind)}, ${JSON.stringify(data)}, ${JSON.stringify(options ?? {})})`);
    win.setContentSize(1160, Math.max(400, Math.min(4000, Math.ceil(Number(height) || 900))));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const rect = await win.webContents.executeJavaScript(`(() => { const r = document.querySelector('.share-card').getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.left) - 24), y: Math.max(0, Math.floor(r.top) - 24), width: Math.ceil(r.width) + 48, height: Math.ceil(r.height) + 48 }; })()`);
    const image = await win.webContents.capturePage(rect);
    return image.toDataURL();
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

function imageOf(dataUrl: unknown) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,") || dataUrl.length > 40_000_000) throw new Error("图片无效");
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) throw new Error("图片无效");
  return image;
}

export async function saveShareCard(win: BrowserWindow | null, dataUrl: unknown, name: unknown) {
  const image = imageOf(dataUrl);
  const safe = (typeof name === "string" ? name : "TokenPulse").replace(/[\\/:*?"<>|]/g, "").slice(0, 80) || "TokenPulse";
  const options = { title: tr("保存分享卡片"), defaultPath: `${safe}.png`, filters: [{ name: tr("PNG 图片"), extensions: ["png"] }] };
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { saved: false };
  await fs.writeFile(result.filePath, image.toPNG());
  return { saved: true, file: path.basename(result.filePath) };
}

/** Electron 44 的剪贴板改成了 W3C 那一套：写一个 image/png 的 ClipboardItem。 */
export async function copyShareCard(dataUrl: unknown) {
  const png = imageOf(dataUrl).toPNG();
  await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(png)], { type: "image/png" }) })]);
  return { copied: true };
}
