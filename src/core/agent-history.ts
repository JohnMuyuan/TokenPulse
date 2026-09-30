/**
 * 供应商配置的版本历史（0.3.9）。
 *
 * TokenPulse 每次真正改动 Claude / Codex / Grok / Claude 桌面端的配置文件，都在这里记一份「改之前 / 改之后」：
 * - 存在 ~/.tokenpulse/backups/agent-history/<id>.json，只留最近 KEEP 次；文件权限 600（里面有 API Key，和工具自己的配置文件一样只在本机）。
 * - 还有一份「接管前的原件」：TokenPulse 第一次改某个文件前的样子（agent-config.ts 的 live-first-write），永久保留。
 * 界面上看到的对比一律经过 maskSecrets，不把密钥原文送到界面。
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { dataDir } from "./paths";

export type FileChange = { file: string; before: string | null; after: string | null };
export type HistoryEntry = { version: 1; id: string; at: number; reason: string; files: FileChange[] };
export type DiffLine = { kind: " " | "+" | "-" | "…"; text: string };
export type FileDiff = { file: string; name: string; tool: string; created: boolean; removed: boolean; added: number; deleted: number; lines: DiffLine[] };

const KEEP = 50;
const historyDir = () => path.join(dataDir(), "backups", "agent-history");
const originalsDir = () => path.join(dataDir(), "backups", "live-first-write");

function writePrivate(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  try {
    fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

/** 记一次提交。写失败不影响配置本身（配置已经有事务保护），只在控制台留一句。 */
export function recordHistory(reason: string, files: FileChange[], now = Date.now()) {
  if (!files.length) return null;
  const id = `${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const entry: HistoryEntry = { version: 1, id, at: now, reason: reason || "修改供应商配置", files };
  try {
    writePrivate(path.join(historyDir(), id + ".json"), JSON.stringify(entry));
    const all = fs.readdirSync(historyDir()).filter((name) => name.endsWith(".json")).sort();
    for (const name of all.slice(0, Math.max(0, all.length - KEEP))) fs.rmSync(path.join(historyDir(), name), { force: true });
  } catch (error) {
    console.error("[TokenPulse] 记录配置历史失败", error);
  }
  return id;
}

export function readHistory(id: string): HistoryEntry | null {
  if (!/^[a-z0-9]+-[0-9a-f]{6}$/.test(id)) return null;
  try {
    const entry = JSON.parse(fs.readFileSync(path.join(historyDir(), id + ".json"), "utf8")) as HistoryEntry;
    return entry?.version === 1 && Array.isArray(entry.files) ? entry : null;
  } catch { return null; }
}

export function listHistory(): HistoryEntry[] {
  let names: string[] = [];
  try { names = fs.readdirSync(historyDir()).filter((name) => name.endsWith(".json")); } catch { return []; }
  return names.map((name) => readHistory(name.slice(0, -5))).filter((e): e is HistoryEntry => Boolean(e)).sort((a, b) => b.at - a.at);
}

/** 接管前的原件：{ file: 原路径, content, at }。 */
export function listOriginals(): Array<{ id: string; file: string; content: string; at: number }> {
  let names: string[] = [];
  try { names = fs.readdirSync(originalsDir()).filter((name) => name.endsWith(".ok")); } catch { return []; }
  const out: Array<{ id: string; file: string; content: string; at: number }> = [];
  for (const marker of names) {
    const id = marker.slice(0, -3);
    try {
      const file = fs.readFileSync(path.join(originalsDir(), marker), "utf8").trim();
      const copy = path.join(originalsDir(), id + "-" + path.basename(file));
      out.push({ id, file, content: fs.readFileSync(copy, "utf8"), at: fs.statSync(copy).mtimeMs });
    } catch { /* 缺了一半的备份不列出来 */ }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/* ---------------- 界面用：打码和对比 ---------------- */

const SECRET_KEY = /(api[_-]?key|apikey|token|secret|password|passwd|authorization|auth[_-]?header|bearer|credential|access[_-]?key|private[_-]?key)/i;
function maskValue(value: string) {
  if (!value) return value;
  return value.length <= 8 ? "••••" : value.slice(0, 4) + "••••" + value.slice(-2);
}
/** 把一行里的密钥换成 sk-a••••9z：JSON "xxx_key": "..."、TOML xxx_key = "..."、环境变量 XXX_TOKEN=...、裸的 sk- / Bearer 串。 */
export function maskSecrets(line: string) {
  let out = line.replace(/("([^"]*)"\s*:\s*")([^"]*)(")/g, (all, head, key, value, tail) => (SECRET_KEY.test(key) ? head + maskValue(value) + tail : all));
  out = out.replace(/^(\s*(?:export\s+)?([A-Za-z0-9_.-]+)\s*=\s*)(["']?)([^"'\s#]+)(\3)/, (all, head, key, quote, value, tail) => (SECRET_KEY.test(key) ? head + quote + maskValue(value) + tail : all));
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{6,}|xai-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{8,})/g, (value) => maskValue(value));
  return out;
}

/** 行级对比（LCS），只留改动前后各 3 行上下文。文件太大时退化成「整份替换」。 */
export function lineDiff(before: string | null, after: string | null, context = 3): { lines: DiffLine[]; added: number; deleted: number } {
  const a = before === null ? [] : before.replace(/\r\n/g, "\n").split("\n");
  const b = after === null ? [] : after.replace(/\r\n/g, "\n").split("\n");
  if (a.length && a[a.length - 1] === "") a.pop();
  if (b.length && b[b.length - 1] === "") b.pop();
  let ops: DiffLine[];
  if (a.length * b.length > 4_000_000) {
    ops = [...a.map((text) => ({ kind: "-" as const, text })), ...b.map((text) => ({ kind: "+" as const, text }))];
  } else {
    const n = a.length, m = b.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ kind: " ", text: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ kind: "-", text: a[i++] });
      else ops.push({ kind: "+", text: b[j++] });
    }
    while (i < n) ops.push({ kind: "-", text: a[i++] });
    while (j < m) ops.push({ kind: "+", text: b[j++] });
  }
  const keep = ops.map((op, index) => op.kind !== " " || ops.slice(Math.max(0, index - context), index + context + 1).some((near) => near.kind !== " "));
  const lines: DiffLine[] = [];
  ops.forEach((op, index) => {
    if (keep[index]) lines.push({ kind: op.kind, text: maskSecrets(op.text) });
    else if (lines.length && lines[lines.length - 1].kind !== "…") lines.push({ kind: "…", text: "" });
  });
  if (lines[0]?.kind === "…") lines.shift();
  return { lines, added: ops.filter((op) => op.kind === "+").length, deleted: ops.filter((op) => op.kind === "-").length };
}

export function toolOf(file: string) {
  const normalized = file.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/claude-3p/")) return "Claude 桌面端";
  if (normalized.includes("/.claude") || normalized.endsWith("/settings.json")) return "Claude Code";
  if (normalized.includes("/.codex") || normalized.includes("codex")) return "Codex";
  if (normalized.includes("/.grok") || normalized.includes("grok")) return "Grok CLI";
  return "工具配置";
}

export function fileDiff(change: FileChange): FileDiff {
  const { lines, added, deleted } = lineDiff(change.before, change.after);
  return { file: change.file, name: path.basename(change.file), tool: toolOf(change.file), created: change.before === null, removed: change.after === null, added, deleted, lines };
}

/** 同一个文件在一次操作里可能被改了几次（几个事务）：合并成「最早的 before → 最后的 after」。 */
export function mergeChanges(changes: FileChange[]): FileChange[] {
  const merged = new Map<string, FileChange>();
  for (const change of changes) {
    const key = path.resolve(change.file);
    const seen = merged.get(key);
    if (seen) seen.after = change.after; else merged.set(key, { ...change });
  }
  return [...merged.values()].filter((change) => change.before !== change.after);
}

export function changeSignature(changes: FileChange[]) {
  const rows = mergeChanges(changes).map((c) => [path.resolve(c.file), c.before, c.after]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
