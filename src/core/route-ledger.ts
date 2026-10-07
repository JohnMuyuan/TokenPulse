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

/** 测试用：丢掉内存里的缓存。 */
export function resetRouteLedgerCache() { cache = null; appended = 0; }
