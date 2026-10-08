/*
 * 某个官方账号、各个模型的速度走势（0.3.35，额度详情里那张图用）。
 *
 * 数据来自永久保存的转发记录（route-log/，见 route-ledger.ts），两种请求都记了型号和每秒 Token 数：
 * - 透明转发的：记录里没有账号（转发时不读登录凭据），和请求记录一样按「CLI 当时登录的是哪个账号」归属（login-timeline.ts）；
 * - 号池交给官方账号的（0.3.36）：记录里就写着交给了哪个账号，直接用。
 * 经本地路由转给第三方供应商的不是官方账号的用量，不算在这里（供应商页的汇总里有）。
 * 转发记录不清理，所以走势想看多久以前的都行。
 *
 * 按时间分桶（一小时 / 一天 / 一周，看选的范围有多长），每个桶取中位数和四分位——
 * 个别特别快（只回了一两句）或特别慢（排队）的请求不把线带偏。
 */
import fs from "fs";
import path from "path";
import type { OfficialAccountKind } from "./credentials";
import { accountLabels, readLoginTimeline, resolveAccount } from "./login-timeline";
import { routeLogDir } from "./route-ledger";

export type SpeedBucket = { at: number; median: number; low: number; high: number; count: number; firstTokenMs: number | null };
/** fast：快速模式（Codex 的 priority / fast、Claude 的 fast）的请求单独一行，不和普通模式混着算。 */
export type SpeedModel = { model: string; fast: boolean; count: number; tokensPerSec: number; low: number; high: number; firstTokenMs: number | null; output: number; lastAt: number; buckets: SpeedBucket[] };
export type SpeedSeries = { from: number; to: number; bucketMs: number; models: SpeedModel[]; max: number; total: number };

/** 透明转发记录里的工具名 → 官方账号是哪一家。 */
const KIND_OF_APP: Record<string, OfficialAccountKind> = { claude: "claude", codex: "chatgpt", grok: "grok" };
const HOUR = 3_600_000, DAY = 86_400_000;
/** 转发记录里的 tier 是不是快速模式。 */
export const isFastTier = (tier: unknown) => tier === "priority" || tier === "fast";

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return 0;
  const at = (sorted.length - 1) * q, low = Math.floor(at), high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}
const round1 = (value: number) => Math.round(value * 10) / 10;
function summary(speeds: number[], firsts: number[]) {
  const sorted = speeds.slice().sort((a, b) => a - b), delays = firsts.slice().sort((a, b) => a - b);
  return { median: round1(quantile(sorted, 0.5)), low: round1(quantile(sorted, 0.25)), high: round1(quantile(sorted, 0.75)), count: sorted.length, firstCount: delays.length, firstTokenMs: delays.length ? Math.round(quantile(delays, 0.5)) : null };
}
const earliest = (rows: { at: number }[]) => rows.reduce((at, row) => Math.min(at, row.at), Infinity);
const latest = (rows: { at: number }[]) => rows.reduce((at, row) => Math.max(at, row.at), 0);
const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
/** 桶的起点：小时和天按本地时间对齐，周从周一开始。 */
function bucketStart(at: number, bucketMs: number) {
  const day = new Date(at);
  if (bucketMs === HOUR) { day.setMinutes(0, 0, 0); return day.getTime(); }
  day.setHours(0, 0, 0, 0);
  if (bucketMs > DAY) day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day.getTime();
}

/**
 * days：看最近多少天；0 = 全部。account 为空 = 这一家不分账号。
 */
export function accountSpeed(kind: OfficialAccountKind, account: string, days: number, now = Date.now()): SpeedSeries {
  const since = days > 0 ? now - days * DAY : 0;
  const timeline = readLoginTimeline(), labels = accountLabels();
  const rows: { at: number; model: string; fast: boolean; speed: number; first: number; output: number }[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(routeLogDir()).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort(); } catch { /* 还没有转发记录 */ }
  const oldest = new Date(since), oldestName = `${oldest.getFullYear()}-${String(oldest.getMonth() + 1).padStart(2, "0")}.jsonl`;
  for (const name of files) {
    if (since && name < oldestName) continue;
    let lines: string[];
    try { lines = fs.readFileSync(path.join(routeLogDir(), name), "utf8").split("\n"); } catch { continue; }
    for (const line of lines) {
      if (!line || !/"(?:tokensPerSec|firstTokenMs|firstByteMs)"/.test(line)) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line); } catch { continue; }
      const at = Number(row.at), speed = positive(row.tokensPerSec), first = positive(row.firstTokenMs ?? row.firstByteMs);
      if (!(at >= since) || at > now + 60_000 || (!speed && !first) || Number(row.status) >= 400 || row.error) continue;
      if (KIND_OF_APP[String(row.app)] !== kind) continue;
      const pooled = typeof row.account === "string" && row.account.startsWith(kind + ":") ? row.account : "";
      if (row.pass !== true && !pooled) continue;
      const model = String(row.requestModel || row.model || "");
      if (!model) continue;
      if (account && (pooled || resolveAccount(kind, at, {}, timeline, labels)?.id) !== account) continue;
      rows.push({ at, model, fast: isFastTier(row.tier), speed, first, output: Number(row.output) || 0 });
    }
  }
  // 账号图只画速度；首字摘要包含同组的短回复，速度次数 / 输出保持独立。
  const measured = rows.filter(row => row.speed > 0);
  if (!measured.length) return { from: since || now - 7 * DAY, to: now, bucketMs: DAY, models: [], max: 0, total: 0 };
  const from = since || earliest(measured);
  const span = now - from;
  // 两天以内按小时看，三个月以内按天，再长按周
  const bucketMs = span <= 2 * DAY ? HOUR : span <= 92 * DAY ? DAY : 7 * DAY;
  const groups = new Map<string, typeof rows>();
  for (const row of rows) { const key = row.model + (row.fast ? "\nfast" : ""); const list = groups.get(key) ?? []; list.push(row); groups.set(key, list); }
  const models = [...groups.values()].map((list): SpeedModel => {
    const { model, fast } = list[0];
    const byBucket = new Map<number, typeof rows>();
    for (const row of list) { const start = bucketStart(row.at, bucketMs); const bucket = byBucket.get(start) ?? []; bucket.push(row); byBucket.set(start, bucket); }
    const buckets = [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([at, bucket]) => ({ at, ...summary(bucket.map((row) => row.speed).filter(value => value > 0), bucket.map((row) => row.first).filter((value) => value > 0)) })).filter(bucket => bucket.count > 0);
    const all = summary(list.map((row) => row.speed).filter(value => value > 0), list.map((row) => row.first).filter((value) => value > 0));
    return { model, fast, count: all.count, tokensPerSec: all.median, low: all.low, high: all.high, firstTokenMs: all.firstTokenMs, output: list.reduce((sum, row) => sum + (row.speed > 0 ? row.output : 0), 0), lastAt: latest(list), buckets };
  }).filter(model => model.count > 0).sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
  const max = models.reduce((high, model) => model.buckets.reduce((value, bucket) => Math.max(value, bucket.high), Math.max(high, model.high)), 0);
  return { from: bucketStart(from, bucketMs), to: now, bucketMs, models, max, total: measured.length };
}

/*
 * 全部模型的速度走势（0.3.39，用量明细里的折线图）：不分账号，透明转发和本地路由量到的都算。
 * 一条线 = 工具 + 型号 + 快速模式 + 思考等级 + 经由（官方登录 / 供应商 / 号池成员）：
 * 同一个型号不同等级每秒 Token 数差不多，但首字差很多；不同中转站的速度也不一样，所以分开。
 * 按时间分桶（同 accountSpeed：两天以内按小时，三个月以内按天，再长按周），每个桶取速度和首字的中位数。
 */
export type SpeedLine = { app: string; model: string; fast: boolean; effort: string; via: string; count: number; speedCount: number; firstCount: number; tokensPerSec: number | null; firstTokenMs: number | null; lastAt: number;
  buckets: { at: number; tokensPerSec: number | null; firstTokenMs: number | null; count: number; speedCount: number; firstCount: number }[] };
export type SpeedLines = { from: number; to: number; bucketMs: number; lines: SpeedLine[]; total: number };
export function speedSeries(days: number, now = Date.now()): SpeedLines {
  const since = days > 0 ? now - days * DAY : 0;
  type Row = { at: number; key: string; app: string; model: string; fast: boolean; effort: string; via: string; speed: number; first: number };
  const rows: Row[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(routeLogDir()).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort(); } catch { /* 还没有转发记录 */ }
  const oldest = new Date(since), oldestName = `${oldest.getFullYear()}-${String(oldest.getMonth() + 1).padStart(2, "0")}.jsonl`;
  for (const name of files) {
    if (since && name < oldestName) continue;
    let lines: string[];
    try { lines = fs.readFileSync(path.join(routeLogDir(), name), "utf8").split("\n"); } catch { continue; }
    for (const line of lines) {
      if (!line || !/"(?:tokensPerSec|firstTokenMs|firstByteMs)"/.test(line)) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line); } catch { continue; }
      const at = Number(row.at), speed = positive(row.tokensPerSec), first = positive(row.firstTokenMs ?? row.firstByteMs);
      if (!(at >= since) || at > now + 60_000 || (!speed && !first) || Number(row.status) >= 400 || row.error) continue;
      const app = String(row.app || ""), model = String(row.requestModel || row.model || "").slice(0, 120);
      if (!model) continue;
      const fast = isFastTier(row.tier), effort = typeof row.effort === "string" ? row.effort.slice(0, 20) : "";
      const via = row.pass === true ? "" : String(row.provider || "").slice(0, 80);
      rows.push({ at, key: [app, model, fast ? "fast" : "", effort, via].join("|"), app, model, fast, effort, via, speed, first });
    }
  }
  if (!rows.length) return { from: since || now - 7 * DAY, to: now, bucketMs: DAY, lines: [], total: 0 };
  const from = since || earliest(rows);
  const span = now - from;
  const bucketMs = span <= 2 * DAY ? HOUR : span <= 92 * DAY ? DAY : 7 * DAY;
  const groups = new Map<string, Row[]>();
  for (const row of rows) { const list = groups.get(row.key) ?? []; list.push(row); groups.set(row.key, list); }
  const lines = [...groups.values()].map((list): SpeedLine => {
    const { app, model, fast, effort, via } = list[0];
    const byBucket = new Map<number, Row[]>();
    for (const row of list) { const start = bucketStart(row.at, bucketMs); const bucket = byBucket.get(start) ?? []; bucket.push(row); byBucket.set(start, bucket); }
    const buckets = [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([at, bucket]) => {
      const s = summary(bucket.map((row) => row.speed).filter(value => value > 0), bucket.map((row) => row.first).filter((value) => value > 0));
      return { at, tokensPerSec: s.count ? s.median : null, firstTokenMs: s.firstTokenMs, count: bucket.length, speedCount: s.count, firstCount: s.firstCount };
    });
    const all = summary(list.map((row) => row.speed).filter(value => value > 0), list.map((row) => row.first).filter((value) => value > 0));
    return { app, model, fast, effort, via, count: list.length, speedCount: all.count, firstCount: all.firstCount, tokensPerSec: all.count ? all.median : null, firstTokenMs: all.firstTokenMs, lastAt: latest(list), buckets };
  }).sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
  return { from: bucketStart(from, bucketMs), to: now, bucketMs, lines, total: rows.length };
}
