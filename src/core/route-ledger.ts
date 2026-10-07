/*
 * 路由账本（0.3.34）：号池把每个请求交给了哪个官方账号。
 *
 * 用量是从各家 CLI 自己写的日志里读的，那里只知道「这是 Grok / Claude / Codex 发的」，不知道号池把它转给了哪个账号；
 * 而且用号池时工具的配置里填的是本地路由的地址，这些用量会被当成第三方中转站，不归到任何官方账号名下。
 * 本地路由转发成功时在这里记一笔（时间、哪家、哪个账号），统计用量时按时间对上：
 * - usage-scan.ts 算「按账号的小时账」（额度折算、本机以外的判断都靠它）；
 * - request-log.ts 给请求记录、用量明细、按项目配上账号。
 *
 * 只记账号 id 和时间，不记请求内容、不记凭据。一行一条，追加写；超过 RETAIN_DAYS 的在追加时顺手清掉。
 * 统计在另一个线程里跑，所以靠文件传，不靠内存。
 */
import fs from "fs";
import path from "path";
import { dataFile } from "./paths";
import type { OfficialAccountKind } from "./credentials";

export type RouteEntry = { at: number; kind: OfficialAccountKind; account: string };

/** CLI 日志里那条用量的时间和路由记下的时间差多少以内算同一次请求。 */
const MATCH_MS = 30_000;
const RETAIN_DAYS = 45;
const DAY_MS = 86_400_000;
const PRUNE_EVERY = 500;
const file = () => dataFile("route-ledger.jsonl");

let appended = 0;
/** 本地路由把一个请求成功交给了号池里的官方账号。写失败不影响转发。 */
export function appendRoute(entry: RouteEntry) {
  if (!entry.account || !entry.account.startsWith(entry.kind + ":") || !Number.isFinite(entry.at)) return;
  try {
    fs.appendFileSync(file(), `${Math.round(entry.at)}\t${entry.kind}\t${entry.account}\n`);
    cache = null;
    if (++appended % PRUNE_EVERY === 0) prune();
  } catch { /* 账本写不了：这次请求照常转发，只是统计时对不上账号 */ }
}

function prune() {
  try {
    const keep = Date.now() - RETAIN_DAYS * DAY_MS;
    const lines = fs.readFileSync(file(), "utf8").split("\n").filter((line) => Number(line.split("\t")[0]) >= keep);
    const temp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(temp, lines.length ? lines.join("\n") + "\n" : "");
    fs.renameSync(temp, file());
    cache = null;
  } catch { /* 清不掉就下次再清 */ }
}

type Index = Partial<Record<OfficialAccountKind, { at: number[]; account: string[] }>>;
let cache: { size: number; mtimeMs: number; index: Index } | null = null;

function load(): Index {
  let stat: fs.Stats;
  try { stat = fs.statSync(file()); } catch { return {}; }
  if (cache && cache.size === stat.size && cache.mtimeMs === stat.mtimeMs) return cache.index;
  const rows: RouteEntry[] = [];
  try {
    for (const line of fs.readFileSync(file(), "utf8").split("\n")) {
      const [at, kind, account] = line.split("\t");
      const time = Number(at);
      if (!account || !Number.isFinite(time) || (kind !== "claude" && kind !== "chatgpt" && kind !== "grok")) continue;
      rows.push({ at: time, kind, account });
    }
  } catch { return {}; }
  rows.sort((a, b) => a.at - b.at);
  const index: Index = {};
  for (const row of rows) { const list = (index[row.kind] ??= { at: [], account: [] }); list.at.push(row.at); list.account.push(row.account); }
  cache = { size: stat.size, mtimeMs: stat.mtimeMs, index };
  return index;
}

/**
 * 这一刻（CLI 日志里那条用量的时间）前后，号池把请求交给了哪个账号。对不上返回 null。
 * 取时间最近的一条；几个请求同时在跑时可能对到相邻的那个成员，它们本来就是同一个号池里轮着用的。
 */
export function routeAccount(kind: OfficialAccountKind | undefined, at: number): string | null {
  if (!kind) return null;
  const list = load()[kind];
  if (!list || !list.at.length) return null;
  let low = 0, high = list.at.length;
  while (low < high) { const mid = (low + high) >> 1; if (list.at[mid] < at) low = mid + 1; else high = mid; }
  let best = -1, gap = MATCH_MS + 1;
  for (const index of [low - 1, low]) {
    if (index < 0 || index >= list.at.length) continue;
    const distance = Math.abs(list.at[index] - at);
    if (distance < gap) { gap = distance; best = index; }
  }
  return best >= 0 ? list.account[best] : null;
}

/*
 * 转发记录（永久保存）：本地路由转发的每一次请求一行 JSON，按月分文件放在数据目录的 route-log/ 下，不清理。
 * 用来事后看当时是怎么转发的、出了问题好查。只记转发的情况（时间、交给谁、型号、状态、耗时、大小、Token 数、报错），
 * 不记请求和回复的内容，不记密钥和登录凭据。写失败不影响转发。
 */
export function routeLogDir() { return dataFile("route-log"); }
export function appendRouteLog(entry: object & { at: number }) {
  try {
    const day = new Date(entry.at);
    const dir = routeLogDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}.jsonl`), JSON.stringify(entry) + "\n");
  } catch { /* 记不下来就算了 */ }
}

/**
 * 从保存的转发记录里往回读：时间早于 before 的最新 limit 条，新的在前。more 表示更早的还有。
 * 按月份文件从新到旧读，读够就停。
 */
export function readRouteLog(options: { limit?: number; before?: number } = {}): { rows: Record<string, unknown>[]; more: boolean } {
  const limit = Math.max(1, Math.min(500, Math.round(options.limit ?? 100)));
  const before = Number.isFinite(options.before) ? Number(options.before) : Infinity;
  const rows: Record<string, unknown>[] = [];
  let files: string[];
  try { files = fs.readdirSync(routeLogDir()).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort().reverse(); } catch { return { rows, more: false }; }
  for (const name of files) {
    let lines: string[];
    try { lines = fs.readFileSync(path.join(routeLogDir(), name), "utf8").split("\n"); } catch { continue; }
    for (let index = lines.length - 1; index >= 0; index--) {
      if (!lines[index]) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(lines[index]); } catch { continue; }
      if (typeof row?.at !== "number" || row.at >= before) continue;
      if (rows.length >= limit) return { rows, more: true };
      rows.push(row);
    }
  }
  return { rows, more: false };
}

/*
 * 透明转发量到的模型速度（0.3.35）：从保存的转发记录里取最近 days 天、带速度的那些（pass = true、成功、量到了每秒 Token 数），
 * 按「工具 + 型号」汇总。用中位数：个别特别慢或特别快的请求（排队、只回了一两句）不会把数字带偏。
 */
export type PassSpeedRow = { app: string; model: string; count: number; tokensPerSec: number; fastest: number; slowest: number; firstTokenMs: number | null; output: number; lastAt: number };
export function passSpeed(days = 7, now = Date.now()): PassSpeedRow[] {
  const since = now - Math.max(1, Math.min(90, days)) * DAY_MS;
  const groups = new Map<string, { app: string; model: string; speeds: number[]; firsts: number[]; output: number; lastAt: number }>();
  let files: string[];
  try { files = fs.readdirSync(routeLogDir()).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort().reverse(); } catch { return []; }
  const oldest = new Date(since), oldestName = `${oldest.getFullYear()}-${String(oldest.getMonth() + 1).padStart(2, "0")}.jsonl`;
  for (const name of files) {
    if (name < oldestName) break;
    let lines: string[];
    try { lines = fs.readFileSync(path.join(routeLogDir(), name), "utf8").split("\n"); } catch { continue; }
    for (const line of lines) {
      if (!line || !line.includes('"tokensPerSec"')) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line); } catch { continue; }
      const at = Number(row.at), speed = Number(row.tokensPerSec);
      if (row.pass !== true || !(at >= since) || !(speed > 0) || Number(row.status) >= 400 || row.error) continue;
      const app = String(row.app || ""), plain = String(row.requestModel || row.model || "");
      if (!plain) continue;
      // 快速模式（Codex 的 priority / fast、Claude 的 fast）单独算，不和普通模式混在一起
      const model = plain + (row.tier === "priority" || row.tier === "fast" ? " · 快速" : "");
      const group = groups.get(app + "\n" + model) ?? { app, model, speeds: [], firsts: [], output: 0, lastAt: 0 };
      group.speeds.push(speed);
      const first = Number(row.firstTokenMs ?? row.firstByteMs);
      if (first > 0) group.firsts.push(first);
      group.output += Number(row.output) || 0;
      group.lastAt = Math.max(group.lastAt, at);
      groups.set(app + "\n" + model, group);
    }
  }
  const median = (values: number[]) => { const sorted = values.slice().sort((a, b) => a - b), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
  return [...groups.values()].map((group) => ({ app: group.app, model: group.model, count: group.speeds.length, tokensPerSec: Math.round(median(group.speeds) * 10) / 10,
    fastest: Math.max(...group.speeds), slowest: Math.min(...group.speeds), firstTokenMs: group.firsts.length ? Math.round(median(group.firsts)) : null, output: group.output, lastAt: group.lastAt }))
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

/*
 * 型号核验用（0.3.35）：经 TokenPulse 转发（本地路由 / 透明转发）的请求，转发时从上游回复里读到了响应 ID 和实际用的型号，
 * 记在转发记录里。请求记录那边拿 CLI 会话文件里的响应 ID 来这里查，对上了就知道上游真回的是哪个型号——
 * Codex 的会话文件不记返回型号，只有这样能核验。
 * 按月份文件建索引（响应 ID → 请求的型号、返回的型号），文件没变就用缓存；查的时候看请求所在的那个月和前后各一个月。
 */
export type RouteReturned = { requested?: string; returned: string };
const returnedCache = new Map<string, { size: number; mtimeMs: number; index: Map<string, RouteReturned> }>();
function returnedIndex(name: string): Map<string, RouteReturned> | null {
  const file = path.join(routeLogDir(), name);
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return null; }
  const cached = returnedCache.get(name);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.index;
  const index = new Map<string, RouteReturned>();
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"returnedModel"')) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line); } catch { continue; }
      if (typeof row.responseId !== "string" || typeof row.returnedModel !== "string" || !row.returnedModel) continue;
      index.set(row.responseId, { ...(typeof row.requestModel === "string" && row.requestModel ? { requested: row.requestModel } : {}), returned: row.returnedModel });
    }
  } catch { return null; }
  returnedCache.set(name, { size: stat.size, mtimeMs: stat.mtimeMs, index });
  return index;
}
const monthName = (at: number, shift: number) => { const day = new Date(at); const moved = new Date(day.getFullYear(), day.getMonth() + shift, 1); return `${moved.getFullYear()}-${String(moved.getMonth() + 1).padStart(2, "0")}.jsonl`; };
/** 这个响应 ID 的请求，转发时从上游回复里读到的型号。没经过 TokenPulse 转发、或者没读到，返回 null。 */
export function routeReturned(responseId: string | undefined, at: number): RouteReturned | null {
  if (!responseId) return null;
  for (const shift of [0, -1, 1]) {
    const hit = returnedIndex(monthName(at, shift))?.get(responseId);
    if (hit) return hit;
  }
  return null;
}

/** 测试用：丢掉内存里的缓存。 */
export function resetRouteLedgerCache() { cache = null; appended = 0; returnedCache.clear(); }
