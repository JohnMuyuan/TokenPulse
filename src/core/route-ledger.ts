/*
 * 路由账本（0.3.34）：号池把每个请求交给了哪个官方账号。
 *
 * 用量是从各家 CLI 自己写的日志里读的，那里只知道「这是 Grok / Claude / Codex 发的」，不知道号池把它转给了哪个账号；
 * 而且用号池时工具的配置里填的是本地路由的地址，这些用量会被当成第三方中转站，不归到任何官方账号名下。
 * 本地路由转发成功时在这里记一笔（时间、哪家、哪个账号、响应 ID），统计用量时按共同响应 ID 对上：
 * - usage-scan.ts 算「按账号的小时账」（额度折算、本机以外的判断都靠它）；
 * - request-log.ts 给请求记录、用量明细、按项目配上账号。
 *
 * 不记请求内容、不记凭据。一行一条，追加写；超过 RETAIN_DAYS 的在追加时顺手清掉。
 * 统计在另一个线程里跑，所以靠文件传，不靠内存。
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { dataFile } from "./paths";
import type { OfficialAccountKind } from "./credentials";

export type RouteEntry = { at: number; kind: OfficialAccountKind; account: string; responseId?: string };

const RETAIN_DAYS = 45;
const DAY_MS = 86_400_000;
const PRUNE_EVERY = 500;
const file = () => dataFile("route-ledger.jsonl");

let appended = 0;
/** 本地路由把一个请求成功交给了号池里的官方账号。写失败不影响转发。 */
export function appendRoute(entry: RouteEntry) {
  if (!entry.account || !entry.account.startsWith(entry.kind + ":") || !Number.isFinite(entry.at)) return;
  try {
    const responseId = entry.responseId && /^[A-Za-z0-9_-]{1,160}$/.test(entry.responseId) ? entry.responseId : "";
    fs.appendFileSync(file(), `${Math.round(entry.at)}\t${entry.kind}\t${entry.account}${responseId ? "\t" + responseId : ""}\n`);
    cache = null;
    seen.clear();
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
    seen.clear();
  } catch { /* 清不掉就下次再清 */ }
}

/*
 * 文件变没变：同一个文件 1 秒内只看一次（0.3.38）。
 * 统计时每条请求都要来这里查账本和转发记录，以前每查一次都 stat 好几个文件（还有不存在的月份），
 * 几万条请求光这一项就要两三秒，打开软件时要干等。本进程自己写文件时会立刻作废，不用等 1 秒。
 */
const CHECK_MS = 1000;
type Seen = { size: number; mtimeMs: number } | null;
const seen = new Map<string, { at: number; stat: Seen }>();
/** key 是文件的简称；完整路径要拼，拼路径本身在这里也算贵的，所以只在真去看文件时才拼。 */
function peek(key: string, where: () => string): Seen {
  const now = Date.now(), hit = seen.get(key);
  if (hit && now - hit.at < CHECK_MS) return hit.stat;
  let stat: Seen = null;
  try { const info = fs.statSync(where()); stat = { size: info.size, mtimeMs: info.mtimeMs }; } catch { stat = null; }
  if (seen.size > 256) seen.clear();
  seen.set(key, { at: now, stat });
  return stat;
}

type Index = Partial<Record<OfficialAccountKind, Map<string, string | null>>>;
let cache: { size: number; mtimeMs: number; index: Index } | null = null;

function load(): Index {
  const stat = peek("ledger", file);
  if (!stat) return {};
  if (cache && cache.size === stat.size && cache.mtimeMs === stat.mtimeMs) return cache.index;
  const rows: RouteEntry[] = [];
  try {
    for (const line of fs.readFileSync(file(), "utf8").split("\n")) {
      const [at, kind, account, responseId] = line.split("\t");
      const time = Number(at);
      if (!account || !Number.isFinite(time) || (kind !== "claude" && kind !== "chatgpt" && kind !== "grok")) continue;
      rows.push({ at: time, kind, account, responseId });
    }
  } catch { return {}; }
  rows.sort((a, b) => a.at - b.at);
  const index: Index = {};
  for (const row of rows) {
    if (!row.responseId) continue;
    const list = (index[row.kind] ??= new Map());
    // 响应 ID 若被不同账号复用，归属存在歧义，不猜。
    if (list.has(row.responseId) && list.get(row.responseId) !== row.account) list.set(row.responseId, null);
    else if (!list.has(row.responseId)) list.set(row.responseId, row.account);
  }
  cache = { size: stat.size, mtimeMs: stat.mtimeMs, index };
  return index;
}

/**
 * 只凭 CLI 和上游共同记录的响应 ID 归属。不再用时间邻近猜测：并发与直连请求会被配错。
 * 旧三列账本、Grok 整轮汇总和没有响应 ID 的记录返回 null。
 */
export function routeAccount(kind: OfficialAccountKind | undefined, at: number, responseId?: string): string | null {
  if (!kind || !responseId) return null;
  const recent = load()[kind];
  if (recent?.has(responseId)) return recent.get(responseId) ?? null;
  // 旧三列账本没有 ID；永久日志若留有共同 ID 和账号，仍可精确找回历史归属。
  for (const shift of [0, -1, 1]) {
    const hit = accountIndex(monthName(at, shift)).get(kind + "\n" + responseId);
    if (hit !== undefined) return hit;
  }
  return null;
}

const accountCache = new Map<string, { size: number; mtimeMs: number; index: Map<string, string | null> }>();
function accountIndex(name: string): Map<string, string | null> {
  const stat = peek("log:" + name, () => path.join(routeLogDir(), name));
  if (!stat) return new Map();
  const cached = accountCache.get(name);
  if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.index;
  const index = new Map<string, string | null>();
  try {
    for (const line of fs.readFileSync(path.join(routeLogDir(), name), "utf8").split("\n")) {
      if (!line.includes('"account"') || !line.includes('"responseId"')) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line); } catch { continue; }
      const kind = row.app === "codex" ? "chatgpt" : row.app === "claude" ? "claude" : row.app === "grok" ? "grok" : "";
      if (!kind || !(Number(row.status) < 400) || row.error || typeof row.account !== "string" || !row.account.startsWith(kind + ":") || typeof row.responseId !== "string") continue;
      const key = kind + "\n" + row.responseId;
      if (index.has(key) && index.get(key) !== row.account) index.set(key, null);
      else if (!index.has(key)) index.set(key, row.account);
    }
  } catch { return new Map(); }
  accountCache.set(name, { size: stat.size, mtimeMs: stat.mtimeMs, index });
  return index;
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
    fs.appendFileSync(path.join(dir, `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}.jsonl`), JSON.stringify({ id: crypto.randomUUID(), ...entry }) + "\n");
    seen.clear();
  } catch { /* 记不下来就算了 */ }
}

/** 转发记录一共有多少条（0.3.39，翻页时显示「第几页 / 共几页」用）。只数行，不解析。 */
export function countRouteLog(): number {
  let files: string[], total = 0;
  try { files = fs.readdirSync(routeLogDir()).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)); } catch { return 0; }
  for (const name of files) {
    try { total += fs.readFileSync(path.join(routeLogDir(), name), "utf8").split("\n").filter((line) => line.includes('"at":')).length; } catch { /* 读不了的月份不算 */ }
  }
  return total;
}

/**
 * 初次读取可按 before 限定时间；后续以月份文件 + 行位置作为游标，同毫秒的记录也能完整翻页。
 * 按月份文件从新到旧读，读够就停。
 */
export function readRouteLog(options: { limit?: number; before?: number; cursor?: string } = {}): { rows: Record<string, unknown>[]; more: boolean; nextCursor: string | null } {
  const limit = Math.max(1, Math.min(500, Math.round(options.limit ?? 100)));
  const before = Number.isFinite(options.before) ? Number(options.before) : Infinity;
  const rows: Record<string, unknown>[] = [];
  let nextCursor: string | null = null;
  const cursor = options.cursor ? /^(\d{4}-\d{2}\.jsonl):(\d+)$/.exec(options.cursor) : null;
  if (options.cursor && !cursor) throw new Error("转发记录分页游标无效");
  let files: string[];
  try { files = fs.readdirSync(routeLogDir()).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort().reverse(); } catch { return { rows, more: false, nextCursor }; }
  for (const name of files) {
    if (cursor && name > cursor[1]) continue;
    let lines: string[];
    try { lines = fs.readFileSync(path.join(routeLogDir(), name), "utf8").split("\n"); } catch { continue; }
    for (let index = lines.length - 1; index >= 0; index--) {
      if (cursor && name === cursor[1] && index >= Number(cursor[2])) continue;
      if (!lines[index]) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(lines[index]); } catch { continue; }
      if (typeof row?.at !== "number" || (!cursor && row.at >= before)) continue;
      if (rows.length >= limit) return { rows, more: true, nextCursor };
      // 旧记录没有 UUID，文件位置提供稳定且唯一的身份，不改写历史文件。
      rows.push({ ...row, id: typeof row.id === "string" && row.id ? row.id : `legacy:${name}:${index}` });
      nextCursor = `${name}:${index}`;
    }
  }
  return { rows, more: false, nextCursor };
}

/*
 * 量到的模型速度（0.3.35 透明转发，0.3.36 起本地路由也量）：从保存的转发记录里取最近 days 天（0 = 全部，记录永久保存）、成功并且量到了每秒 Token 数的，
 * 按「工具 + 型号 + 快速模式 + 思考等级 + 经谁转的」汇总：透明转发是官方登录；本地路由的写供应商 / 号池成员的名字——同一个型号在不同的中转站速度不一样，不能混着算。
 * 思考等级（0.3.39）单独分开：真机记录里同一个型号不同等级的每秒 Token 数差不多，但首字延迟差很多（想得越久，第一段内容出来得越晚），混在一起中位数就看不出来了。
 * 用中位数和四分位：个别特别慢或特别快的请求（排队、只回了一两句）不会把数字带偏。
 */
export type PassSpeedRow = {
  app: string; model: string; fast: boolean; /** 请求里带的思考等级，没带是空的。 */ effort: string;
  /** 经谁转的：透明转发是空的，本地路由是供应商 / 号池成员的名字。 */ via: string;
  count: number; tokensPerSec: number; low: number; high: number; fastest: number; slowest: number; firstTokenMs: number | null; output: number; lastAt: number;
};
export function passSpeed(days = 7, now = Date.now()): PassSpeedRow[] {
  const since = days > 0 ? now - days * DAY_MS : 0;
  const groups = new Map<string, { app: string; model: string; fast: boolean; effort: string; via: string; speeds: number[]; firsts: number[]; output: number; lastAt: number }>();
  let files: string[];
  try { files = fs.readdirSync(routeLogDir()).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort().reverse(); } catch { return []; }
  const oldest = new Date(since), oldestName = since ? `${oldest.getFullYear()}-${String(oldest.getMonth() + 1).padStart(2, "0")}.jsonl` : "";
  for (const name of files) {
    if (name < oldestName) break;
    let lines: string[];
    try { lines = fs.readFileSync(path.join(routeLogDir(), name), "utf8").split("\n"); } catch { continue; }
    for (const line of lines) {
      if (!line || !line.includes('"tokensPerSec"')) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line); } catch { continue; }
      const at = Number(row.at), speed = Number(row.tokensPerSec);
      if (!(at >= since) || at > now + 60_000 || !(speed > 0) || Number(row.status) >= 400 || row.error) continue;
      const via = row.pass === true ? "" : String(row.provider || "").slice(0, 80);
      const app = String(row.app || ""), model = String(row.requestModel || row.model || "").slice(0, 120);
      if (!model) continue;
      // 快速模式（Codex 的 priority / fast、Claude 的 fast）单独算，不和普通模式混在一起
      const fast = row.tier === "priority" || row.tier === "fast";
      const effort = typeof row.effort === "string" ? row.effort.slice(0, 20) : "";
      const key = [app, model, fast ? "fast" : "", effort, via].join("\n");
      const group = groups.get(key) ?? { app, model, fast, effort, via, speeds: [], firsts: [], output: 0, lastAt: 0 };
      group.speeds.push(speed);
      const first = Number(row.firstTokenMs ?? row.firstByteMs);
      if (first > 0) group.firsts.push(first);
      group.output += Number(row.output) || 0;
      group.lastAt = Math.max(group.lastAt, at);
      groups.set(key, group);
    }
  }
  const quantile = (values: number[], q: number) => { const sorted = values.slice().sort((a, b) => a - b), at = (sorted.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at); return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo); };
  const round1 = (value: number) => Math.round(value * 10) / 10;
  return [...groups.values()].map((group) => ({ app: group.app, model: group.model, fast: group.fast, effort: group.effort, via: group.via, count: group.speeds.length,
    tokensPerSec: round1(quantile(group.speeds, 0.5)), low: round1(quantile(group.speeds, 0.25)), high: round1(quantile(group.speeds, 0.75)),
    fastest: group.speeds.reduce((value, speed) => Math.max(value, speed), 0), slowest: group.speeds.reduce((value, speed) => Math.min(value, speed), Infinity), firstTokenMs: group.firsts.length ? Math.round(quantile(group.firsts, 0.5)) : null, output: group.output, lastAt: group.lastAt }))
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

/*
 * 型号核验用（0.3.35）：经 TokenPulse 转发（本地路由 / 透明转发）的请求，转发时从上游回复里读到了响应 ID 和实际用的型号，
 * 记在转发记录里。请求记录那边拿 CLI 会话文件里的响应 ID 来这里查，对上了就知道上游真回的是哪个型号——
 * Codex 的会话文件不记返回型号，只有这样能核验。
 * 按月份文件建索引（响应 ID → 请求的型号、返回的型号），文件没变就用缓存；查的时候看请求所在的那个月和前后各一个月。
 */
/** 转发时量到的：首字延迟、总耗时、速度，以及这一次是怎么转的。用量明细里每条请求旁边显示（0.3.38）。 */
export type RouteTiming = { ms?: number; firstByteMs?: number; firstTokenMs?: number; tokensPerSec?: number; stream?: boolean; path?: string; pass?: boolean; provider?: string; fast?: boolean };
export type RouteReturned = { requested?: string; returned: string; /** 回复开头报的型号，和结束时报的不一样才有（0.3.41）。 */ declared?: string; timing?: RouteTiming };
const returnedCache = new Map<string, { size: number; mtimeMs: number; index: Map<string, RouteReturned> }>();
function returnedIndex(name: string): Map<string, RouteReturned> | null {
  const stat = peek("log:" + name, () => path.join(routeLogDir(), name));
  if (!stat) return null;
  const cached = returnedCache.get(name);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.index;
  const index = new Map<string, RouteReturned>();
  try {
    for (const line of fs.readFileSync(path.join(routeLogDir(), name), "utf8").split("\n")) {
      if (!line.includes('"returnedModel"')) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line); } catch { continue; }
      if (typeof row.responseId !== "string" || typeof row.returnedModel !== "string" || !row.returnedModel) continue;
      const num = (key: string) => (typeof row[key] === "number" && Number.isFinite(row[key] as number) && (row[key] as number) >= 0 ? { [key]: row[key] as number } : {});
      const timing: RouteTiming = { ...num("ms"), ...num("firstByteMs"), ...num("firstTokenMs"), ...num("tokensPerSec"), ...(typeof row.stream === "boolean" ? { stream: row.stream } : {}),
        ...(typeof row.path === "string" ? { path: row.path.slice(0, 200) } : {}), ...(row.pass === true ? { pass: true } : {}), ...(typeof row.provider === "string" ? { provider: row.provider.slice(0, 120) } : {}),
        ...(row.tier === "priority" || row.tier === "fast" ? { fast: true } : {}) };
      index.set(row.responseId, { ...(typeof row.requestModel === "string" && row.requestModel ? { requested: row.requestModel } : {}), returned: row.returnedModel, ...(typeof row.declaredModel === "string" && row.declaredModel ? { declared: row.declaredModel.slice(0, 120) } : {}), timing });
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
export function resetRouteLedgerCache() { cache = null; appended = 0; returnedCache.clear(); accountCache.clear(); seen.clear(); }
