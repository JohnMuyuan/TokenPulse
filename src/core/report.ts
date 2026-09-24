import { estimateCost, priceOf } from "./model-pricing";
import { analyzeAccount, ACCOUNT_KINDS, type AccountKind, type AccountReport, type HourRow } from "./quota-monitor";
import { readQuotaChecks, readQuotaHistory } from "./quota-history";
import type { RequestRow } from "./request-log";
import { accountLabels } from "./login-timeline";
import { readOfficialAccountStore } from "./accounts";
import type { QuotaSample } from "./quota-history";
import { ccSwitchBuckets, ccSwitchEnabled, coveredDays, readCcSwitch, type CcSwitchStatus } from "./cc-switch";
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
  /** 这一轮新扫到、最近 15 分钟内型号不一致或响应存疑的请求（发系统通知用）。 */
  requestAlerts?: RequestRow[];
  /** CC Switch 导入的状态（设置 → 数据）。 */
  ccSwitch: CcSwitchStatus;
  /** 最近 7 天型号不一致 / 响应存疑的次数（侧栏红点）。 */
  requestFlags?: { flagged: number; mismatch: number; suspect: number };
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

/**
 * 一家的额度采样按账号分组，按设置里的账号顺序排。
 * - 设置里删掉 / 藏起来的账号不出现（采样历史还在）；
 * - 没记账号的老采样（0.3 以前）只可能来自 CLI 当时登录的那一个：归给最早出现的那个账号；一个带账号的都没有就单独一组；
 * - 账号库里没有、但历史里有的账号（账号库被删过）排在最后，照样显示。
 */
/**
 * 卡片和托盘上的短名字。别名优先；没别名且这一家有多个账号时用邮箱 @ 前面那段。
 * 短名字重复就改用完整邮箱，否则 ada@one.com 和 ada@two.com 在首页上是同一行字。
 */
function displayNames(rows: { alias?: string; email?: string; label?: string; multi: boolean }[]) {
  const raw = rows.map((row) => {
    if (row.alias) return row.alias;
    if (!row.multi) return "";
    const source = row.email || row.label || "";
    return source.replace(/@.*$/, "").trim() || "未命名账号";
  });
  const counts = new Map<string, number>();
  for (const name of raw) if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  return raw.map((name, index) => {
    if (!name || (counts.get(name) ?? 0) < 2) return name;
    const full = rows[index].email || rows[index].label || "";
    return full && full !== name ? full : name;
  });
}

function samplesByAccount(samples: QuotaSample[], kind: AccountKind, store: ReturnType<typeof readOfficialAccountStore>) {
  const skip = new Set([...(store.removed ?? []), ...store.accounts.filter((item) => item.hidden).map((item) => item.id)]);
  const firstLabelled = samples.filter((sample) => sample.account).sort((a, b) => a.at - b.at)[0]?.account;
  const groups = new Map<string, QuotaSample[]>();
  for (const sample of samples) {
    const id = sample.account || firstLabelled || "";
    let list = groups.get(id);
    if (!list) groups.set(id, (list = []));
    list.push(sample);
  }
  const order = store.accounts.filter((item) => item.kind === kind).map((item) => item.id);
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return [...groups.entries()]
    .filter(([id]) => !skip.has(id))
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([id, list]) => ({ id: id || undefined, samples: list }));
}

export function buildSnapshot(now = Date.now()): Snapshot {
  const rollups = readRollups();
  const history = readQuotaHistory();
  const checks = readQuotaChecks();

  /* ---- 1. 全量：按天 / 来源 / 型号 ---- */
  const days: DayBuckets = {};
  for (const file of Object.values(rollups.files)) mergeDays(days, file.days);
  // CC Switch 只补 TokenPulse 自己没有账的「天 × 工具」（CLI 已经清掉的老会话、OpenCode 这类不扫的工具）
  const ccEnabled = ccSwitchEnabled();
  const ccStore = ccEnabled ? readCcSwitch() : null;
  const cc = ccSwitchBuckets(ccStore, coveredDays(days));
  mergeDays(days, cc.days);
  const ccSwitch: CcSwitchStatus = {
    enabled: ccEnabled,
    found: Boolean(ccStore?.found),
    path: ccStore?.path ?? "",
    syncedAt: ccStore?.syncedAt,
    error: ccStore?.error,
    importedDays: cc.imported,
    skippedDays: cc.skipped,
    sources: [...cc.sources].map(([source, requests]) => ({ source, requests })).sort((a, b) => b.requests - a.requests),
    proxyRequests: ccStore?.requests.filter((request) => request.proxy && request.status >= 200 && request.status < 300).length ?? 0,
  };

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
    const addHours = (hours: Record<string, Record<string, UsageBucket>> | undefined, accountId?: string) => {
      for (const [key, models] of Object.entries(hours ?? {})) {
        const hour = Number(key);
        if (!Number.isFinite(hour)) continue;
        for (const [model, bucket] of Object.entries(models)) {
          /*
           * Claude Code 的归属看的是全局 settings.json，可别的程序（AllAi）会给单个进程另配环境变量，
           * 让 Claude Code 去接 gpt / grok（本机实测 grok-4.6 186 次、gpt-5.6-sol 75 次）。
           * 这些不占 Claude 订阅额度，算进来会把「整窗容量」估大。
           */
          if (account === "claude" && !/claude/i.test(model)) continue;
          rows[account].push({
            hour,
            model,
            // 口径同统计页：input 已含缓存读写
            tokens: bucket.input + bucket.output,
            costUsd: costOf(model, bucket),
            requests: bucket.requests,
            ...(accountId ? { account: accountId } : {}),
          });
        }
      }
    };
    // 0.3.3 以后重扫出的小时账按账号拆开；旧账本没有该字段，先保留未标注的兼容行。
    if (file.accountHours && Object.keys(file.accountHours).length) {
      for (const [accountId, hours] of Object.entries(file.accountHours)) addHours(hours, accountId || undefined);
    } else {
      addHours(file.hours);
    }
  }

  /* ---- 3. 额度监控 ---- */
  const labels = accountLabels();
  const store = readOfficialAccountStore();
  // 没采到过额度的账号不显示：没有百分比，就谈不上监控。
  const accounts = ACCOUNT_KINDS.flatMap((kind) => {
    const groups = samplesByAccount(Array.isArray(history.accounts[kind]) ? history.accounts[kind] : [], kind, store);
    const reports = groups
      .map(({ id, samples }) => {
        const checked = id && checks.accounts?.[id] != null ? { at: checks.accounts[id], account: id } : checks[kind]?.account === id ? checks[kind] : undefined;
        return analyzeAccount(kind, samples, rows[kind], now, checked);
      })
      .filter((report) => report.sampleCount > 0)
      .map((report) => ({
        ...report,
        key: report.accountId ?? kind,
        accountLabel: report.accountId ? labels.get(report.accountId) : undefined,
        // 用户起过名字：只有一个账号也要写出来（名字就是为了认它）
        accountAlias: report.accountId ? store.accounts.find((item) => item.id === report.accountId)?.alias : undefined,
      }));
    const names = displayNames(reports.map((report) => {
      const stored = report.accountId ? store.accounts.find((item) => item.id === report.accountId) : undefined;
      return {
        alias: report.accountAlias,
        email: (report.accountId && labels.emails?.get(report.accountId)) || stored?.email || "",
        label: stored?.label || report.accountLabel,
        multi: reports.length > 1,
      };
    }));
    return reports.map((report, index) => ({ ...report, siblings: reports.length, displayName: names[index] || undefined }));
  });

  return {
    now,
    scannedAt: rollups.scannedAt,
    usage: usage.sort((a, b) => b.day.localeCompare(a.day) || b.tokens - a.tokens),
    fileCount: Object.keys(rollups.files).length,
    ccSwitch,
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
