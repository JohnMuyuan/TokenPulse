import { estimateCost, priceOf } from "./model-pricing";
import { analyzeAccount, ACCOUNT_KINDS, type AccountKind, type AccountReport, type HourRow } from "./quota-monitor";
import { readQuotaChecks, readQuotaHistory } from "./quota-history";
import { readRollups, emptyBucket, addUsage, type DayBuckets, type UsageBucket } from "./usage-scan";

/**
 * 把散落在各个文件状态里的账汇总成界面要的一份快照。
 *
 * 账本是**按文件分开记**的（见 usage-scan.ts），全局合计 = 所有文件相加。
 * 这里做三件事：
 * 1. 合并出「按天 / 按来源 / 按型号」的用量，给统计页；
 * 2. 挑出走官方账号的那部分、按小时摊平，给额度监控当「这个窗口用了多少 token」；
 * 3. 配上官方额度的采样历史，算出每个账号的速度和预测。
 */

const HOUR_MS = 3_600_000;

export type Totals = UsageBucket & { tokens: number };
export type UsageDetail = Totals & { day: string; source: string; model: string; priced: boolean };

export type Snapshot = {
  now: number;
  scannedAt?: number;
  /** 按日 / 工具 / 型号的聚合明细，可筛选、比较和导出；不包含会话正文或路径。 */
  usage: UsageDetail[];
  fileCount: number;
  /** 各时间范围的合计。 */
  totals: { today: Totals; week: Totals; month: Totals; all: Totals };
  /** 最近 60 天，每天一条，最早的在前。 */
  daily: { day: string; tokens: number; costUsd: number; requests: number }[];
  /** 全部历史里各来源的合计。 */
  sources: { source: string; tokens: number; costUsd: number; requests: number }[];
  /** 全部历史里各型号的合计，按花费排序。 */
  models: { model: string; source: string; tokens: number; costUsd: number; requests: number }[];
  /** 官方账号的额度监控。没采到过额度的账号不在里面。 */
  accounts: AccountReport[];
  /** 每家算进来 / 因为走中转被排除的会话数，界面上照实说。 */
  sessions: Record<AccountKind, { included: number; excluded: number }>;
};

function toTotals(bucket: UsageBucket): Totals {
  return { ...bucket, tokens: bucket.input + bucket.output };
}

function mergeDays(into: DayBuckets, from: DayBuckets | undefined) {
  if (!from) return;
  for (const [day, bySource] of Object.entries(from)) {
    const target = (into[day] ??= {});
    for (const [source, byModel] of Object.entries(bySource)) {
      const models = (target[source] ??= {});
      for (const [model, bucket] of Object.entries(byModel)) addUsage((models[model] ??= emptyBucket()), bucket);
    }
  }
}

function dayKey(at: number) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function relativeDay(now: number, offset: number) {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return dayKey(d.getTime());
}

/** 花费：自己报过的优先，没有的按型号估（Claude / Codex 的会话文件里没有钱）。 */
function costOf(model: string, bucket: UsageBucket) {
  return bucket.costUsd || estimateCost(model, bucket);
}

const ACCOUNT_OF_KIND: Record<string, AccountKind> = {
  "claude-code": "claude",
  codex: "chatgpt",
  "grok-build": "grok",
};

export function buildSnapshot(now = Date.now()): Snapshot {
  const rollups = readRollups();
  const history = readQuotaHistory();
  const checks = readQuotaChecks();

  /* ---- 1. 全量：按天 / 来源 / 型号 ---- */
  const days: DayBuckets = {};
  for (const file of Object.values(rollups.files)) mergeDays(days, file.days);

  const totals = {
    today: emptyBucket(),
    week: emptyBucket(),
    month: emptyBucket(),
    all: emptyBucket(),
  };
  const bySource = new Map<string, { tokens: number; costUsd: number; requests: number }>();
  const byModel = new Map<string, { model: string; source: string; tokens: number; costUsd: number; requests: number }>();
  const byDay = new Map<string, { tokens: number; costUsd: number; requests: number }>();
  const usage: UsageDetail[] = [];

  const today = dayKey(now);
  const weekFrom = relativeDay(now, -6);
  const monthFrom = relativeDay(now, -29);

  for (const [day, sources] of Object.entries(days)) {
    for (const [source, models] of Object.entries(sources)) {
      for (const [model, bucket] of Object.entries(models)) {
        // 估价一次，后面所有口径共用。
        const priced: UsageBucket = { ...bucket, costUsd: costOf(model, bucket) };
        const tokens = priced.input + priced.output;
        usage.push({ day, source, model, ...toTotals(priced), priced: bucket.costUsd > 0 || priceOf(model) !== null });

        addUsage(totals.all, priced);
        if (day === today) addUsage(totals.today, priced);
        if (day >= weekFrom && day <= today) addUsage(totals.week, priced);
        if (day >= monthFrom && day <= today) addUsage(totals.month, priced);

        const s = bySource.get(source) ?? { tokens: 0, costUsd: 0, requests: 0 };
        s.tokens += tokens;
        s.costUsd += priced.costUsd;
        s.requests += priced.requests;
        bySource.set(source, s);

        const key = `${source}\u0000${model}`;
        const m = byModel.get(key) ?? { model, source, tokens: 0, costUsd: 0, requests: 0 };
        m.tokens += tokens;
        m.costUsd += priced.costUsd;
        m.requests += priced.requests;
        byModel.set(key, m);

        const d = byDay.get(day) ?? { tokens: 0, costUsd: 0, requests: 0 };
        d.tokens += tokens;
        d.costUsd += priced.costUsd;
        d.requests += priced.requests;
        byDay.set(day, d);
      }
    }
  }

  // 最近 60 天补齐空日，折线图才不会把没用的那天跳过去。
  const daily: Snapshot["daily"] = [];
  for (let i = 59; i >= 0; i--) {
    const day = relativeDay(now, -i);
    const hit = byDay.get(day);
    daily.push({ day, tokens: hit?.tokens ?? 0, costUsd: hit?.costUsd ?? 0, requests: hit?.requests ?? 0 });
  }

  /* ---- 2. 官方账号的用量，按小时（全部历史：额度容量的历史折线要用） ---- */
  const rows: Record<AccountKind, HourRow[]> = { claude: [], chatgpt: [], grok: [] };
  const sessions: Snapshot["sessions"] = {
    claude: { included: 0, excluded: 0 },
    chatgpt: { included: 0, excluded: 0 },
    grok: { included: 0, excluded: 0 },
  };
  for (const file of Object.values(rollups.files)) {
    const account = file.kind ? ACCOUNT_OF_KIND[file.kind] : undefined;
    if (!account) continue;
    if (file.official !== true) {
      if (file.official === false) sessions[account].excluded += 1;
      continue;
    }
    sessions[account].included += 1;
    for (const [key, models] of Object.entries(file.hours ?? {})) {
      const hour = Number(key);
      if (!Number.isFinite(hour)) continue;
      for (const [model, bucket] of Object.entries(models)) {
        rows[account].push({
          hour,
          model,
          // 口径同统计页：input 已含缓存读写
          tokens: bucket.input + bucket.output,
          costUsd: costOf(model, bucket),
          requests: bucket.requests,
        });
      }
    }
  }

  /* ---- 3. 额度监控 ---- */
  // 没采到过额度的账号不显示：没有百分比，就谈不上监控。
  const accounts = ACCOUNT_KINDS.map((kind) =>
    analyzeAccount(kind, Array.isArray(history.accounts[kind]) ? history.accounts[kind] : [], rows[kind], now, checks[kind]),
  ).filter((report) => report.sampleCount > 0);

  return {
    now,
    scannedAt: rollups.scannedAt,
    usage: usage.sort((a, b) => b.day.localeCompare(a.day) || b.tokens - a.tokens),
    fileCount: Object.keys(rollups.files).length,
    totals: {
      today: toTotals(totals.today),
      week: toTotals(totals.week),
      month: toTotals(totals.month),
      all: toTotals(totals.all),
    },
    daily,
    sources: [...bySource.entries()]
      .map(([source, value]) => ({ source, ...value }))
      .sort((a, b) => b.tokens - a.tokens),
    models: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens),
    accounts,
    sessions,
  };
}
