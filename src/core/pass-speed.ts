/*
 * 某个官方账号、各个模型的速度走势（0.3.35，额度详情里那张图用）。
 *
 * 数据来自永久保存的转发记录（route-log/，见 route-ledger.ts）：透明转发的每次请求都记了型号和每秒 Token 数。
 * 记录里没有账号——转发时不读登录凭据——所以和请求记录一样，按「CLI 当时登录的是哪个账号」归属（login-timeline.ts）。
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
  return { median: round1(quantile(sorted, 0.5)), low: round1(quantile(sorted, 0.25)), high: round1(quantile(sorted, 0.75)), count: sorted.length, firstTokenMs: delays.length ? Math.round(quantile(delays, 0.5)) : null };
}
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
      if (!line || !line.includes('"tokensPerSec"')) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line); } catch { continue; }
      const at = Number(row.at), speed = Number(row.tokensPerSec);
      if (row.pass !== true || !(at >= since) || at > now + 60_000 || !(speed > 0) || Number(row.status) >= 400 || row.error) continue;
      if (KIND_OF_APP[String(row.app)] !== kind) continue;
      const model = String(row.requestModel || row.model || "");
      if (!model) continue;
      if (account && resolveAccount(kind, at, {}, timeline, labels)?.id !== account) continue;
      rows.push({ at, model, fast: isFastTier(row.tier), speed, first: Number(row.firstTokenMs ?? row.firstByteMs) || 0, output: Number(row.output) || 0 });
    }
  }
  if (!rows.length) return { from: since || now - 7 * DAY, to: now, bucketMs: DAY, models: [], max: 0, total: 0 };
  const from = since || Math.min(...rows.map((row) => row.at));
  const span = now - from;
  // 两天以内按小时看，三个月以内按天，再长按周
  const bucketMs = span <= 2 * DAY ? HOUR : span <= 92 * DAY ? DAY : 7 * DAY;
  const groups = new Map<string, typeof rows>();
  for (const row of rows) { const key = row.model + (row.fast ? "\nfast" : ""); const list = groups.get(key) ?? []; list.push(row); groups.set(key, list); }
  const models = [...groups.values()].map((list): SpeedModel => {
    const { model, fast } = list[0];
    const byBucket = new Map<number, typeof rows>();
    for (const row of list) { const start = bucketStart(row.at, bucketMs); const bucket = byBucket.get(start) ?? []; bucket.push(row); byBucket.set(start, bucket); }
    const buckets = [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([at, bucket]) => ({ at, ...summary(bucket.map((row) => row.speed), bucket.map((row) => row.first).filter((value) => value > 0)) }));
    const all = summary(list.map((row) => row.speed), list.map((row) => row.first).filter((value) => value > 0));
    return { model, fast, count: all.count, tokensPerSec: all.median, low: all.low, high: all.high, firstTokenMs: all.firstTokenMs, output: list.reduce((sum, row) => sum + row.output, 0), lastAt: Math.max(...list.map((row) => row.at)), buckets };
  }).sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
  const max = Math.max(...models.flatMap((model) => [model.high, ...model.buckets.map((bucket) => bucket.high)]));
  return { from: bucketStart(from, bucketMs), to: now, bucketMs, models, max, total: rows.length };
}
