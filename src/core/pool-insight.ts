/*
 * 额度详情的号池页（0.3.44）：一个号池（供应商页里建的，同一工具的几个官方账号 / API Key 轮流用）整体用了多少。
 *
 * 数据都来自永久保存的转发记录（route-log/，见 route-ledger.ts）：号池的每一次转发都有一行，带成员、型号、思考等级、
 * Token、用时和速度。0.3.44 起每行记着 poolId；更早的记录，官方账号成员靠 providerId 的「号池id@」前缀认，
 * API Key 成员只能靠名字前缀「号池名 · 」认（号池改过名的那部分认不出来）。
 * 官方账号成员的额度来自 quota-history.json（每个账号自己的采样），是整个账号的，网页聊天和别的设备用的也在里面。
 * 这里都在 worker 里跑（report-worker.ts）。号池的定义（名字、成员）由主进程从供应商数据里取好传进来，不带凭据。
 */
import fs from "fs";
import path from "path";
import { comboKey } from "./model-catalog";
import { estimateCost } from "./model-pricing";
import { isFastTier, speedSeriesOf, type SpeedSeries } from "./pass-speed";
import { accountQuota } from "./pool-order";
import { readQuotaHistory, sameReset, type QuotaSample } from "./quota-history";
import { routeLogDir } from "./route-ledger";

export type PoolMemberDef = { key: string; type: "account" | "provider"; id: string; name: string };
export type PoolDef = { id: string; name: string; app: string; strategy: string; members: PoolMemberDef[] };

const HOUR = 3_600_000, DAY = 86_400_000;
export const POOL_DAYS = 30;
/** 两次请求隔得比这近就算同一段在用（算「用了多久」）。 */
const ACTIVE_GAP_MS = 5 * 60_000;
const KIND_OF_APP: Record<string, string> = { claude: "claude", codex: "chatgpt", grok: "grok" };
/** 时间线上的图标和工具名（renderer/app.js 的 BRAND_OF_SOURCE）。 */
const BRAND_OF_APP: Record<string, string> = { claude: "claude", codex: "openai", grok: "grok", deepseek: "deepseek" };
const SOURCE_OF_APP: Record<string, string> = { claude: "Claude Code", codex: "Codex CLI", grok: "Grok Build", deepseek: "DeepSeek Harness" };

const dayKey = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const startOfDay = (at: number) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };
const shiftDay = (at: number, days: number) => { const d = new Date(at); d.setDate(d.getDate() + days); return d.getTime(); };
const sum = <T>(rows: T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

export type PoolRow = {
  at: number; start: number; member: string; memberName: string; model: string; effort: string; status: number; ok: boolean; limited: boolean; attempt: number;
  input: number; output: number; cacheRead: number; tokens: number; costUsd: number; speed: number; first: number; fast: boolean; ms: number;
};

/** 这条转发记录是不是这个号池的。 */
function belongs(row: Record<string, unknown>, pool: PoolDef) {
  if (row.pass === true) return false;
  if (row.poolId != null) return row.poolId === pool.id;
  if (row.pool !== true || row.app !== pool.app) return false;
  const id = String(row.providerId || ""), name = String(row.provider || "");
  return id.startsWith(pool.id + "@") || (!!pool.name && name.startsWith(pool.name + " · "));
}

/** 号池在 since 之后的转发（每一次尝试一行，包括失败后换下一个成员的那次），按时间从早到晚。 */
export function poolRows(pool: PoolDef, since: number, now = Date.now()): PoolRow[] {
  const rows: PoolRow[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(routeLogDir()).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort(); } catch { /* 还没有转发记录 */ }
  const oldest = new Date(since), oldestName = `${oldest.getFullYear()}-${String(oldest.getMonth() + 1).padStart(2, "0")}.jsonl`;
  const names = new Map(pool.members.map((member) => [member.key, member.name]));
  for (const name of files) {
    if (since && name < oldestName) continue;
    let lines: string[];
    try { lines = fs.readFileSync(path.join(routeLogDir(), name), "utf8").split("\n"); } catch { continue; }
    for (const line of lines) {
      if (!line || !line.includes('"pool":true')) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line); } catch { continue; }
      const at = Number(row.at);
      if (!(at >= since) || at > now + 60_000 || !belongs(row, pool)) continue;
      const status = Number(row.status) || 0, ok = status > 0 && status < 400 && !row.error;
      const output = num(row.output), cacheRead = num(row.cacheRead);
      // Anthropic 的 input_tokens 不含缓存读取，OpenAI 的 prompt_tokens 含：统一成含缓存的口径（同 usage-scan.ts）
      const input = num(row.input) + (row.upstream === "anthropic" ? cacheRead : 0);
      const model = String(row.returnedModel || row.requestModel || row.model || "").slice(0, 120) || "未知模型";
      const member = String(row.providerId || "");
      const label = names.get(member) || String(row.provider || "").replace(pool.name + " · ", "") || member;
      const ms = num(row.ms);
      rows.push({
        at, start: at - ms, member, memberName: label, model, effort: typeof row.effort === "string" ? row.effort.slice(0, 20) : "", status, ok, limited: status === 429, attempt: Number(row.attempt) || 1,
        input, output, cacheRead, tokens: ok ? input + output : 0, costUsd: ok ? estimateCost(model, { input, output, cacheRead, cacheWrite: 0 }) : 0,
        speed: ok ? num(row.tokensPerSec) : 0, first: ok ? num(row.firstTokenMs ?? row.firstByteMs) : 0, fast: isFastTier(row.tier), ms,
      });
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

/** 用了多久：每次请求从发出到结束算一段，隔得不到 5 分钟的连成一段。 */
export function activeMs(rows: { start: number; at: number }[]) {
  const spans = rows.map((row) => [Math.min(row.start, row.at), row.at] as const).sort((a, b) => a[0] - b[0]);
  let total = 0, from = -1, to = -1;
  for (const [a, b] of spans) {
    if (from < 0) { from = a; to = b; continue; }
    if (a - to <= ACTIVE_GAP_MS) { to = Math.max(to, b); continue; }
    total += to - from; from = a; to = b;
  }
  return from < 0 ? 0 : total + (to - from);
}
const usage = (rows: PoolRow[]) => {
  const ok = rows.filter((row) => row.ok);
  return { requests: ok.length, attempts: rows.length, failed: rows.length - ok.length, limited: rows.filter((row) => row.limited).length, tokens: sum(ok, (r) => r.tokens), input: sum(ok, (r) => r.input), output: sum(ok, (r) => r.output), cacheRead: sum(ok, (r) => r.cacheRead), costUsd: sum(ok, (r) => r.costUsd), activeMs: activeMs(ok) };
};

/** 官方账号成员 7 天里每周额度涨了多少个百分点（同一个周期里上涨的部分；重置后从头算）。 */
function weekUsed(samples: QuotaSample[], from: number) {
  let used = 0, prev: QuotaSample | null = null;
  for (const sample of samples) {
    if (sample.week == null) continue;
    if (prev && sample.at > from && sameReset(prev.weekReset, sample.weekReset) && sample.week > prev.week!) used += sample.week - prev.week!;
    prev = sample;
  }
  return used;
}

export function analyzePool(pool: PoolDef, rows: PoolRow[], now = Date.now()) {
  const today = startOfDay(now);
  const recent = rows.filter((row) => row.at > now - POOL_DAYS * DAY);
  const inRange = (from: number, to: number) => recent.filter((row) => row.at > from && row.at <= to);
  const history = readQuotaHistory();
  const kind = KIND_OF_APP[pool.app];
  const samplesOf = (account: string) => (kind ? history.accounts[kind] ?? [] : []).filter((sample) => sample.account === account).sort((a, b) => a.at - b.at);

  // 成员：设置里现在的成员在前，转发记录里有、已经移出号池的排在后面
  const keys = [...pool.members.map((member) => member.key), ...new Set(recent.map((row) => row.member).filter((key) => !pool.members.some((member) => member.key === key)))];
  const total = usage(recent);
  const members = keys.map((key) => {
    const def = pool.members.find((member) => member.key === key);
    const mine = recent.filter((row) => row.member === key);
    const quota = def?.type === "account" ? accountQuota(def.id, now) : null;
    const used = usage(mine);
    return {
      key, id: def?.id ?? key, type: def?.type ?? (key.startsWith(pool.id + "@") ? "account" : "provider"), name: def?.name ?? mine.at(-1)?.memberName ?? key, removed: !def,
      ...used, share: total.tokens > 0 ? used.tokens / total.tokens : 0, lastAt: mine.at(-1)?.at ?? null,
      today: usage(mine.filter((row) => row.at > today)), d7: usage(mine.filter((row) => row.at > now - 7 * DAY)),
      quota: quota ? { fiveLeft: quota.five?.left ?? null, fiveResetAt: quota.five?.resetAt ?? null, weekLeft: quota.week?.left ?? null, weekResetAt: quota.week?.resetAt ?? null, at: quota.at } : null,
      weekUsed7: def?.type === "account" ? weekUsed(samplesOf(def.id), now - 7 * DAY) : null,
    };
  });

  // 号池总额度：官方成员的每周剩余加起来，折成「相当于几个号的周额度」；按最近 7 天每天用掉多少算还能用几天（不算之后的重置）
  const withQuota = members.filter((member) => !member.removed && member.quota && (member.quota.weekLeft ?? member.quota.fiveLeft) != null);
  const left = sum(withQuota, (member) => member.quota!.weekLeft ?? member.quota!.fiveLeft ?? 0) / 100;
  const firstSample = Math.min(...pool.members.filter((m) => m.type === "account").map((m) => samplesOf(m.id)[0]?.at ?? now));
  const span = Math.min(7, Math.max(0, (now - firstSample) / DAY));
  const used7 = sum(members, (member) => member.weekUsed7 ?? 0) / 100;
  const perDay = span >= 0.25 && used7 > 0 ? used7 / Math.max(1, span) : null;
  const tracks = pool.members.filter((m) => m.type === "account").map((m) => ({
    key: m.key, name: m.name,
    points: samplesOf(m.id).filter((sample) => sample.at > now - 7 * DAY && sample.week != null).map((sample) => ({ at: sample.at, used: sample.week! })),
  }));

  // 最近 24 小时（含没过完的这个小时）和最近 30 天，按成员分开
  const byMember = (list: PoolRow[]) => { const out: Record<string, number> = {}; for (const row of list) if (row.ok) out[row.member] = (out[row.member] || 0) + row.tokens; return out; };
  const thisHour = Math.floor(now / HOUR) * HOUR;
  const hourly = Array.from({ length: 24 }, (_, i) => { const hour = thisHour - (23 - i) * HOUR; const list = inRange(hour - 1, hour + HOUR - 1); return { hour, tokens: sum(list.filter((r) => r.ok), (r) => r.tokens), requests: list.filter((r) => r.ok).length, byMember: byMember(list) }; });
  const daily = Array.from({ length: POOL_DAYS }, (_, i) => { const from = shiftDay(today, i - POOL_DAYS + 1), to = shiftDay(from, 1); const list = inRange(from, to); return { day: dayKey(from), from, tokens: sum(list.filter((r) => r.ok), (r) => r.tokens), costUsd: sum(list, (r) => r.costUsd), requests: list.filter((r) => r.ok).length, byMember: byMember(list) }; });

  // 模型 × 思考等级：用了多少、用了多久
  const combos = new Map<string, PoolRow[]>();
  for (const row of recent) if (row.ok) { const key = comboKey(row.model, row.effort); const list = combos.get(key) ?? []; list.push(row); combos.set(key, list); }
  const models = [...combos.values()].map((list) => ({ model: list[0].model, effort: list[0].effort, ...usage(list), lastAt: list.at(-1)!.at })).sort((a, b) => b.tokens - a.tokens || b.lastAt - a.lastAt);

  return {
    pool: { id: pool.id, name: pool.name, app: pool.app, strategy: pool.strategy }, now,
    since: recent[0]?.at ?? null, lastAt: recent.at(-1)?.at ?? null,
    totals: { ...total, today: usage(recent.filter((row) => row.at > today)), d7: usage(recent.filter((row) => row.at > now - 7 * DAY)) },
    members, models, hourly, daily,
    quota: { accounts: pool.members.filter((m) => m.type === "account").length, measured: withQuota.length, left, used7, perDay, daysLeft: perDay ? left / perDay : null, tracks },
    recent: recent.slice(-60).reverse().map((row) => ({ at: row.at, member: row.member, memberName: row.memberName, model: row.model, effort: row.effort, status: row.status, ok: row.ok, attempt: row.attempt, tokens: row.tokens, costUsd: row.costUsd, ms: row.ms, speed: row.speed || null })),
  };
}
export type PoolInsight = ReturnType<typeof analyzePool>;

/*
 * 时间线：和官方账号、DeepSeek 用同一套画法（renderer/model-study.js），结构照 model-study.ts。
 * 号池没有自己的额度周期：一条按自然日，一条按 7 天；上方曲线是官方账号成员每周额度已用的平均值（只有 API Key 成员时没有曲线）。
 */
type Cycle = { id: string; startAt: number; endAt: number; resetAt: number; used: number; sampleAt: number; active: boolean; resetCard: boolean };
function timelineStudy(pool: PoolDef, window: "five" | "week", cycleId: string | undefined, rows: PoolRow[], now: number) {
  const today = startOfDay(now), length = window === "five" ? 1 : 7;
  const ok = rows.filter((row) => row.ok);
  const cycles: Cycle[] = [];
  for (let end = shiftDay(today, 1); cycles.length < 40; end = shiftDay(end, -length)) {
    const start = shiftDay(end, -length);
    if (end <= now - POOL_DAYS * DAY) break;
    const active = now >= start && now < end;
    if (active || ok.some((row) => row.at >= start && row.at < end)) cycles.push({ id: `${start}:${end}`, startAt: start, endAt: end, resetAt: end, used: 0, sampleAt: now, active, resetCard: false });
  }
  const selected = (cycleId ? cycles.find((cycle) => cycle.id === cycleId) : null) ?? cycles[0] ?? null;
  const observed = selected ? ok.filter((row) => row.at >= selected.startAt && row.at < selected.endAt && row.at <= now) : [];
  const binMs = 60_000;
  const bins = new Map<string, { key: string; model: string; effort: string; startAt: number; endAt: number; firstAt: number; lastAt: number; count: number; calls: number; tokens: number; costUsd: number | null }>();
  for (const row of observed) {
    const key = comboKey(row.model, row.effort), start = selected!.startAt + Math.floor((row.at - selected!.startAt) / binMs) * binMs, id = key + "|" + start;
    const bin = bins.get(id) ?? { key, model: row.model, effort: row.effort || "unknown", startAt: start, endAt: Math.min(start + binMs, selected!.endAt), firstAt: row.at, lastAt: row.at, count: 0, calls: 0, tokens: 0, costUsd: 0 };
    bin.firstAt = Math.min(bin.firstAt, row.at); bin.lastAt = Math.max(bin.lastAt, row.at); bin.count++; bin.calls++; bin.tokens += row.tokens; bin.costUsd = (bin.costUsd ?? 0) + row.costUsd;
    bins.set(id, bin);
  }
  // 曲线：每次任一成员有新采样时，按各成员最近一笔算平均已用（这段之前最后一笔也带上，曲线从左边接上）
  const history = readQuotaHistory(), kind = KIND_OF_APP[pool.app];
  const accounts = pool.members.filter((m) => m.type === "account").map((m) => m.id);
  const samples = (kind ? history.accounts[kind] ?? [] : []).filter((sample) => sample.account && accounts.includes(sample.account) && sample.week != null).sort((a, b) => a.at - b.at);
  const latest = new Map<string, number>();
  const track: { at: number; pct: number }[] = [];
  for (const sample of samples) {
    latest.set(sample.account!, sample.week!);
    if (!selected || sample.at > selected.endAt) break;
    const pct = sum([...latest.values()], (v) => v) / latest.size;
    if (sample.at < selected.startAt) { track.length = 0; track.push({ at: sample.at, pct }); continue; }
    track.push({ at: sample.at, pct });
  }
  const unknown = (row: PoolRow) => !row.effort || row.effort === "unknown";
  return {
    query: { kind: "pool", accountId: pool.id, window, cycle: cycleId }, brand: BRAND_OF_APP[pool.app] ?? pool.app, source: SOURCE_OF_APP[pool.app] ?? "", now, cycles, selected, quotaStale: false,
    timeline: [...bins.values()].sort((a, b) => a.startAt - b.startAt), binMs,
    track, curve: { label: "成员平均周额度已用" },
    attribution: { intervals: [] as never[] }, offMachine: { points: 0, markedPoints: 0, detected: [] as never[], marks: [] as never[] },
    totals: { tokens: sum(observed, (r) => r.tokens), calls: observed.length, records: observed.length, unknownEffort: observed.filter(unknown).length },
  };
}

export type PoolQuery =
  | { op: "summary"; pool: PoolDef }
  | { op: "speed"; pool: PoolDef; days: number }
  | { op: "timeline"; pool: PoolDef; cycles?: { five?: string; week?: string } };

export function queryPool(query: PoolQuery) {
  const now = Date.now();
  if (query.op === "speed") {
    const since = query.days > 0 ? now - query.days * DAY : 0;
    const measured = poolRows(query.pool, since, now).filter((row) => row.ok && (row.speed || row.first)).map((row) => ({ at: row.at, model: row.model, fast: row.fast, speed: row.speed, first: row.first, output: row.output }));
    return speedSeriesOf(measured, since, now) as SpeedSeries;
  }
  const rows = poolRows(query.pool, now - POOL_DAYS * DAY, now);
  if (query.op === "summary") return analyzePool(query.pool, rows, now);
  const one = (window: "five" | "week") => timelineStudy(query.pool, window, query.cycles?.[window], rows, now);
  return { kind: "pool", accountId: query.pool.id, labels: { five: "单日", week: "7 天" }, five: one("five"), week: one("week") };
}
