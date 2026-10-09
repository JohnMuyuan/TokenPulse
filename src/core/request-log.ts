import fs from "fs";
import path from "path";
import { estimateCost, priceOf } from "./model-pricing";
import { dataFile, readJson } from "./paths";
import { STATUS_LABELS, verifyRequest, type VerifyStatus } from "./request-verify";
import { ccSwitchEnabled, coverKey, readCcSwitch, type CcRequest } from "./cc-switch";
import { routeReturned, type RouteTiming } from "./route-ledger";
import { accountLabels, KIND_OF_SOURCE, readLoginTimeline, resolveAccount, routedAccount, type LoginTimeline, type RequestAccount } from "./login-timeline";
import { quotaAttribution } from "./quota-attribution";
import { readQuotaHistory } from "./quota-history";
import { windowSegments } from "./quota-monitor";

/**
 * 每一次请求的流水：`~/.tokenpulse/requests/<年-月>.jsonl`，一行一次。
 *
 * 为什么不塞进 usage-rollups.json：那份账本每分钟整份重写，本机两个月就有六千多次请求，
 * 放进去每分钟要多写好几 MB。流水只追加、按月分文件，查的时候只读涉及的月份。
 *
 * 只记元数据（时间、型号、token、ID、工作目录），**不记会话正文**。
 * 核验结论不落盘，查询时用 request-verify.ts 现算 —— 规则改了不用重扫。
 */

/** cc-switch：从 CC Switch 导入的（TokenPulse 自己那天没有这个工具的记录，或者是它不扫的工具）。 */
export type RequestKind = "claude-code" | "codex" | "grok-build" | "cc-switch";

export type RequestRecord = {
  /** 去重键，同一家 CLI 内唯一：Claude 的 requestId、Codex 的 response_id、Grok 的 prompt_id + 型号。 */
  id: string;
  at: number;
  kind: RequestKind;
  /** 会话文件。查归属（官方 / 中转）和显示会话用。 */
  file: string;
  /** 工作目录。 */
  cwd?: string;
  /** 统计用的型号（= 返回型号，Codex 没有就用请求型号）。 */
  model: string;
  /** 日志明确记录的思考等级；缺失时保持未知，不使用当前设置回填历史。 */
  effort?: string;
  /** 等级来源只保存元数据字段路径，不保存正文。 */
  effortSource?: string;
  /** 客户端请求的型号。 */
  requested?: string;
  /** 上游返回的型号。Codex 不记。 */
  returned?: string;
  responseId?: string;
  requestId?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** 自报花费（只有 Grok 有）。 */
  costUsd: number;
  /** 这一条里含几次模型调用。Claude / Codex 一条就是一次；Grok 一轮会调好几次。 */
  calls: number;
  /** cc-switch 的来源名（OpenCode、Claude Code…）。 */
  source?: string;
  /** cc-switch：是不是走它本地代理的请求（型号是从上游响应里读的）。 */
  viaProxy?: boolean;
  /** 会话里直接记下的账号（Claude Code 部分会话有）。 */
  accountRef?: string;
  accountEmail?: string;
  /** 经 TokenPulse 号池发出去的：扫描时按路由账本对上的号池成员（官方账号 id）。记在流水里，账本过期清掉之后仍然知道。 */
  routedAccount?: string;
  /** 新归属已用共同响应 ID 核验；旧的时间猜测不能继续当成确证。 */
  routedAccountBasis?: "response-id";
  /** 压缩上下文那一次调用：CLI 没写 usage，按压缩前的上下文和摘要长度估的（见 usage-scan.ts）。 */
  compaction?: boolean;
  /** 查询时附上的：同一次请求在代理里的记录——TokenPulse 自己转发时读到的（见 withRoute），或 CC Switch 代理的（见 matchProxy）。不落盘。 */
  proxy?: { requested?: string; returned: string; declared?: string; via?: "tokenpulse" };
  /** 查询时附上的：经 TokenPulse 转发时量到的延迟和速度（见 withRoute）。不落盘。 */
  timing?: RouteTiming;
};

const SOURCE_NAMES: Record<RequestKind, string> = { "claude-code": "Claude Code", codex: "Codex CLI", "grok-build": "Grok Build", "cc-switch": "CC Switch" };
const sourceOf = (record: RequestRecord) => record.source ?? SOURCE_NAMES[record.kind] ?? record.kind;

export function requestDir() {
  return dataFile("requests");
}

function monthOf(at: number) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function dayOf(at: number) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const keyOf = (record: Pick<RequestRecord, "kind" | "id">) => `${record.kind}\u0000${record.id}`;

/** 追加一批，按月落到各自的文件里。 */
export function appendRequests(records: RequestRecord[]) {
  if (!records.length) return;
  const byMonth = new Map<string, string[]>();
  for (const record of records) {
    const month = monthOf(record.at);
    const lines = byMonth.get(month) ?? [];
    lines.push(JSON.stringify(record));
    byMonth.set(month, lines);
  }
  fs.mkdirSync(requestDir(), { recursive: true });
  for (const [month, lines] of byMonth) fs.appendFileSync(path.join(requestDir(), `${month}.jsonl`), lines.join("\n") + "\n");
}

function monthFiles() {
  try {
    return fs
      .readdirSync(requestDir())
      .filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

function readMonth(name: string) {
  const out: RequestRecord[] = [];
  let text = "";
  try {
    text = fs.readFileSync(path.join(requestDir(), name), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      out.push(JSON.parse(line) as RequestRecord);
    } catch {
      // 追加到一半被杀进程留下的半行：跳过，下次整理时会被丢掉
    }
  }
  return out;
}

/**
 * 去重整理。会话文件被重写 / 截断、或者账本结构升级时，那个文件会从头重读，
 * 已经记过的请求会被再追加一遍 —— 这时整理一次，同一个键只留最后一条。
 */
export function compactRequests() {
  for (const name of monthFiles()) {
    const records = readMonth(name);
    const unique = new Map<string, RequestRecord>();
    for (const record of records) unique.set(keyOf(record), record);
    if (unique.size === records.length) continue;
    const file = path.join(requestDir(), name);
    const tmp = `${file}.${process.pid}.tmp`;
    const sorted = [...unique.values()].sort((a, b) => a.at - b.at);
    fs.writeFileSync(tmp, sorted.map((record) => JSON.stringify(record)).join("\n") + "\n");
    fs.renameSync(tmp, file);
  }
}

/* ---------------- 查询（在 worker 里跑） ---------------- */

export type HourAggregate = { hour: number; tokens: number; costUsd: number; requests: number; sources: Record<string, { tokens: number; costUsd: number; requests: number }> };

export type RequestQuery = {
  /** 本地日期 YYYY-MM-DD，含两端。 */
  from: string;
  to: string;
  /** 「全部」或来源名（Claude Code / Codex CLI / Grok Build）。 */
  source: string;
  status: "all" | VerifyStatus;
  search: string;
  sort: "time" | "tokens" | "cost";
  page: number;
  pageSize: number;
  /** 导出用：不分页，返回全部匹配。 */
  all?: boolean;
  /** 只看某个账号的（账号 id；"none" = 没对上账号的，比如走中转的）。 */
  account?: string;
  /** 精确到毫秒的时间范围（额度详情里按窗口看、「一天」= 过去 24 小时），和 from / to 同时生效。 */
  since?: number;
  until?: number;
  /**
   * 顺便按「天 × 工具 × 型号」和按小时汇总（不受搜索 / 账号 / 核验筛选影响）。
   * 「一天」跨了两个自然日，按天记的账切不出精确的 24 小时，这时统计卡片、图表都从逐条流水汇总。
   */
  aggregate?: boolean;
  /** 明细页汇总跟随全部筛选；旧额度/总览调用保持原口径。 */
  filteredAggregate?: boolean;
  models?: string[];
  project?: string;
  channel?: "all" | "official" | "api" | "unknown";
  /** 顺便按项目文件夹汇总（跟随全部筛选），给用量明细的「按项目」视图用。 */
  projects?: boolean;
};

/** 一个项目里某个「型号 × 思考等级 × 工具」组合的用量。effort 没记录的为 "unknown"。 */
export type ProjectCombo = { model: string; effort: string; source: string; tokens: number; input: number; output: number; cacheRead: number; requests: number; records: number; costUsd: number; priced: boolean };

export type ProjectAggregate = {
  /** 归并用的键（Windows 路径不分大小写、去掉末尾斜杠）；没记录工作目录的是空串。 */
  key: string;
  cwd: string;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  costUsd: number;
  priced: boolean;
  /** 模型调用次数（Grok 一轮算好几次）。 */
  requests: number;
  /** 流水条数。 */
  records: number;
  /** 多少个 Agent 对话（会话文件）碰过这个项目。 */
  sessions: number;
  firstAt: number;
  lastAt: number;
  agents: { source: string; sessions: number; tokens: number; requests: number }[];
  combos: ProjectCombo[];
  /** 其中压缩上下文的估算（见 usage-scan.ts）。 */
  compaction: { count: number; tokens: number };
  /**
   * 周额度占用（官方百分点，跨几周累加）：官方周额度采样里「涨了、同期本机有请求」的区间，
   * 涨幅按区间内各项目的 API 等价费用分摊（见 projectQuota）。同期若在聊天或别的设备上用，会偏高；
   * 同期本机没有请求的涨幅（unmatched / uncertain）不分给任何项目。
   */
  quota: { week: number; officialTokens: number; attributedTokens: number };
};

type OfficialPart = { account: string; at: number; tokens: number; costUsd: number };

/** 按官方周额度采样把涨幅分给各项目，见 ProjectAggregate.quota。accountRows 是同一账号全部官方请求（不受筛选影响），分摊的分母用它。 */
function projectQuota(parts: Map<string, OfficialPart[]>, accountRows: Map<string, RequestRow[]>, now: number) {
  const history = readQuotaHistory();
  const intervalsOf = new Map<string, { from: number; to: number; points: number; cost: number; tokens: number }[]>();
  for (const [account, rows] of accountRows) {
    const kind = account.split(":")[0];
    const samples = (history.accounts[kind] ?? []).filter((sample) => sample.account === account).sort((a, b) => a.at - b.at);
    if (!samples.length) continue;
    const sorted = rows.slice().sort((a, b) => a.at - b.at);
    const upper = (at: number) => { let low = 0, high = sorted.length; while (low < high) { const mid = (low + high) >>> 1; if (sorted[mid].at <= at) low = mid + 1; else high = mid; } return low; };
    const segments = windowSegments(samples, "week", kind === "chatgpt" ? "moves" : "keeps");
    intervalsOf.set(account, quotaAttribution(segments, sorted, now)
      .filter((interval) => interval.kind === "local_present" && interval.points > 0)
      .map((interval) => {
        const inside = sorted.slice(upper(interval.from), upper(interval.to));
        return { from: interval.from, to: interval.to, points: interval.points, cost: inside.reduce((n, r) => n + r.costUsd, 0), tokens: inside.reduce((n, r) => n + r.tokens, 0) };
      })
      .sort((a, b) => a.from - b.from));
  }
  const out = new Map<string, ProjectAggregate["quota"]>();
  for (const [key, list] of parts) {
    const quota = { week: 0, officialTokens: 0, attributedTokens: 0 };
    for (const part of list) {
      quota.officialTokens += part.tokens;
      const intervals = intervalsOf.get(part.account);
      if (!intervals?.length) continue;
      // 区间按起点排好、互不重叠：二分找起点 < at 的最后一个，再看 at 落不落在 (from, to]
      let low = 0, high = intervals.length;
      while (low < high) { const mid = (low + high) >>> 1; if (intervals[mid].from < part.at) low = mid + 1; else high = mid; }
      const interval = intervals[low - 1];
      if (!interval || part.at > interval.to) continue;
      const share = interval.cost > 0 ? part.costUsd / interval.cost : interval.tokens > 0 ? part.tokens / interval.tokens : 0;
      quota.week += interval.points * share;
      quota.attributedTokens += part.tokens;
    }
    out.set(key, quota);
  }
  return out;
}

export function projectKey(cwd?: string) {
  const trimmed = (cwd || "").trim().replace(/[\\/]+$/, "");
  return /^[a-z]:|\\/i.test(trimmed) ? trimmed.replace(/\//g, "\\").toLowerCase() : trimmed;
}

export type RequestRow = {
  effort?: string;
  effortSource?: string;
  key: string;
  at: number;
  source: string;
  model: string;
  requested?: string;
  returned?: string;
  cwd?: string;
  /** 会话 ID（从文件名来）。 */
  session: string;
  responseId?: string;
  requestId?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  tokens: number;
  costUsd: number;
  priced: boolean;
  calls: number;
  /** true = 走官方账号，false = API Key / 中转，undefined = 判断不出来。 */
  official?: boolean;
  /** 发出这次请求的账号。走中转 / API Key 的、或者对不上的为 null。 */
  account: RequestAccount | null;
  status: VerifyStatus;
  statusLabel: string;
  reasons: string[];
  channel: string;
  /** 压缩上下文的估算行。 */
  compaction?: boolean;
  /** 经 TokenPulse 转发（透明转发 / 本地路由）时量到的延迟和速度；没经过的没有。 */
  timing?: RouteTiming;
};

export type RequestPage = {
  facets: { models: string[]; projects: string[] };
  total: number;
  page: number;
  pages: number;
  rows: RequestRow[];
  /** 当前时间 / 工具 / 搜索条件下各核验结论的次数（不受「核验」筛选影响，给顶部卡片用）。 */
  counts: Record<"all" | VerifyStatus, number>;
  /** 同上条件下 token 和花费的合计。 */
  tokens: number;
  costUsd: number;
  /** 流水里最早一条的时间：「全部」从这天算起。 */
  firstAt?: number;
  /** aggregate 为 true 时才有。rows 的形状和快照里的 usage 一样，界面上可以直接复用同一套统计。 */
  aggregate?: {
    rows: { day: string; source: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; tokens: number; costUsd: number; requests: number; priced: boolean }[];
    /** 每个整点小时；sources 是这一小时里各工具各占多少（用量明细的分工具趋势图用）。 */
    hours: HourAggregate[];
  };
  /** 当前时间 / 工具 / 搜索条件下各账号的请求（不受账号和核验筛选影响）。id 为 "none" 的是没对上账号的。 */
  accounts: { id: string; label: string; source: string; requests: number; tokens: number; costUsd: number; lastAt: number; inferred: number }[];
  /** projects 为 true 时才有，按 Token 从多到少。 */
  projects?: ProjectAggregate[];
};

function sessionOf(record: RequestRecord) {
  if (record.kind === "cc-switch") return record.id;
  const base = path.basename(record.file, ".jsonl");
  // Grok 的文件都叫 updates.jsonl，会话 ID 是上一级目录
  return record.kind === "grok-build" ? path.basename(path.dirname(record.file)) : base.replace(/^rollout-[\dT:-]+-/, "");
}

/** 对账号要用到的：登录时间线和账号名，一次查询读一次。 */
type AccountContext = { timeline: LoginTimeline; labels: Map<string, string> };
function accountContext(): AccountContext {
  return { timeline: readLoginTimeline(), labels: accountLabels() };
}

const COMPACTION_REASON = "压缩上下文的那次调用：CLI 没写用量，按压缩前的上下文大小和摘要长度估算";

function toRow(record: RequestRecord, fileOfficial: boolean | undefined, accounts: AccountContext = accountContext()): RequestRow {
  // 经 TokenPulse 号池发出去的（0.3.34）：这一条实际用的是号池里的官方账号，按路由账本归到它名下、算官方用量
  const routed: RequestAccount | null = record.kind === "cc-switch" ? null
    : record.routedAccount && record.routedAccountBasis === "response-id" && record.responseId ? { id: record.routedAccount, label: accounts.labels.get(record.routedAccount) ?? record.routedAccount, basis: "route" }
    : routedAccount(KIND_OF_SOURCE[sourceOf(record)], record.at, accounts.labels, record.responseId);
  const official = routed ? true : fileOfficial;
  // 走中转 / API Key 的不是官方账号发的；CC Switch 导入的走它代理的也一样
  const account = routed ? routed :
    official === false || (record.kind === "cc-switch" && record.viaProxy)
      ? null
      : resolveAccount(KIND_OF_SOURCE[sourceOf(record)], record.at, { ref: record.accountRef, email: record.accountEmail }, accounts.timeline, accounts.labels);
  const verdict: { status: VerifyStatus; reasons: string[]; channel: string } = record.compaction
    ? { status: "unverified", reasons: [COMPACTION_REASON], channel: "压缩上下文（估算）" }
    : verifyRequest({
    kind: record.kind,
    requested: record.requested,
    returned: record.returned,
    responseId: record.responseId,
    requestId: record.requestId,
    official,
    viaProxy: record.viaProxy,
    proxy: record.proxy,
  });
  const usage = { input: record.input, output: record.output, cacheRead: record.cacheRead, cacheWrite: record.cacheWrite };
  return {
    key: keyOf(record),
    at: record.at,
    source: sourceOf(record),
    model: record.model,
    effort: record.effort,
    effortSource: record.effortSource,
    requested: record.requested ?? record.proxy?.requested,
    returned: record.returned ?? record.proxy?.returned,
    cwd: record.cwd,
    session: sessionOf(record),
    responseId: record.responseId,
    requestId: record.requestId,
    ...usage,
    reasoning: record.reasoning,
    tokens: record.input + record.output,
    costUsd: record.costUsd || estimateCost(record.model, usage),
    priced: record.costUsd > 0 || priceOf(record.model) !== null,
    calls: record.calls || 1,
    official,
    account,
    status: verdict.status,
    statusLabel: STATUS_LABELS[verdict.status],
    reasons: verdict.reasons,
    channel: verdict.channel,
    ...(record.compaction ? { compaction: true } : {}),
    ...(record.timing ? { timing: record.timing } : {}),
  };
}

/** 各会话文件的归属（官方 / 中转），以及 TokenPulse 自己有账的「天 × 工具」，都从用量账本里读。 */
function attribution() {
  const rollups = readJson<{ files?: Record<string, { official?: boolean; days?: Record<string, Record<string, Record<string, { requests: number }>>> }> } | null>(
    dataFile("usage-rollups.json"),
    null,
  );
  const map = new Map<string, boolean | undefined>();
  const covered = new Set<string>();
  for (const [file, state] of Object.entries(rollups?.files ?? {})) {
    map.set(file, state.official);
    for (const [day, bySource] of Object.entries(state.days ?? {})) {
      for (const [source, byModel] of Object.entries(bySource)) {
        if (Object.values(byModel).some((bucket) => bucket.requests > 0)) covered.add(coverKey(day, source));
      }
    }
  }
  return Object.assign(map, { covered });
}

/**
 * CC Switch 那边的请求分两种用法：
 * - TokenPulse 自己那天没有这个工具的账（CLI 清掉的老会话、OpenCode 这类不扫的工具）→ 作为独立的一行显示；
 * - 走它代理的、TokenPulse 自己也记了的 → 不另起一行，作为「同一次请求在代理里的记录」挂到自己那行上，
 *   用它记的上游返回型号来核验（sub2api 的做法；Codex 的会话文件不记返回型号，只有这里能补上）。
 * 对应关系：同一工具、输出 token 相同、时间差 10 分钟以内，一条代理记录只配一次。
 */
function ccSwitchRecords(covered: Set<string>) {
  const store = ccSwitchEnabled() ? readCcSwitch() : null;
  const own: RequestRecord[] = [];
  const proxies = new Map<string, CcRequest[]>();
  for (const request of store?.found ? store.requests : []) {
    if (request.status < 200 || request.status >= 300) continue;
    if (!covered.has(coverKey(dayOf(request.at), request.source))) {
      own.push({
        id: `cc:${request.id}`,
        at: request.at,
        kind: "cc-switch",
        file: "cc-switch",
        source: request.source,
        model: request.model,
        requested: request.requested,
        returned: request.model,
        requestId: request.id,
        input: request.input,
        output: request.output,
        cacheRead: request.cacheRead,
        cacheWrite: request.cacheWrite,
        reasoning: 0,
        costUsd: request.costUsd,
        calls: 1,
        viaProxy: request.proxy,
      });
    } else if (request.proxy) {
      const list = proxies.get(request.source) ?? [];
      list.push(request);
      proxies.set(request.source, list);
    }
  }
  const used = new Set<string>();
  const matchProxy = (record: RequestRecord) => {
    const list = proxies.get(sourceOf(record));
    if (!list) return record;
    const hit = list.find((request) => !used.has(request.id) && request.output === record.output && Math.abs(request.at - record.at) <= 10 * 60_000);
    if (!hit) return record;
    used.add(hit.id);
    return { ...record, proxy: { requested: hit.requested, returned: hit.model } };
  };
  return { own, matchProxy };
}

/**
 * 这次请求经 TokenPulse 转发过（本地路由 / 透明转发）的话，附上转发时从上游回复里读到的型号（0.3.35）。
 * 靠响应 ID 对应，是同一次请求才对得上；没对上返回 null，再去试 CC Switch 的代理记录。
 */
function withRoute(record: RequestRecord): RequestRecord | null {
  if (record.kind === "cc-switch" || !record.responseId) return null;
  const hit = routeReturned(record.responseId, record.at);
  return hit ? { ...record, proxy: { ...(hit.requested ? { requested: hit.requested } : {}), returned: hit.returned, ...(hit.declared ? { declared: hit.declared } : {}), via: "tokenpulse" }, ...(hit.timing ? { timing: hit.timing } : {}) } : null;
}

export function queryRequests(query: RequestQuery): RequestPage {
  const fromMonth = query.from.slice(0, 7);
  const toMonth = query.to.slice(0, 7);
  const names = monthFiles();
  const firstName = names[0];
  const official = attribution();
  const cc = ccSwitchRecords(official.covered);
  const accountCtx = accountContext();
  const byAccount = new Map<string, RequestPage["accounts"][number]>();
  const groups = new Map<string, NonNullable<RequestPage["aggregate"]>["rows"][number]>();
  const hours = new Map<number, HourAggregate>();
  const aggregateRow = (row: RequestRow, day: string, at: number) => {
    const groupKey = `${day}\u0000${row.source}\u0000${row.model}`;
    const group = groups.get(groupKey) ?? { day, source: row.source, model: row.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, tokens: 0, costUsd: 0, requests: 0, priced: true };
    group.input += row.input;
    group.output += row.output;
    group.cacheRead += row.cacheRead;
    group.cacheWrite += row.cacheWrite;
    group.reasoning += row.reasoning;
    group.tokens += row.tokens;
    group.costUsd += row.costUsd;
    // 和统计页一个口径：请求数算模型调用次数（Grok 一轮会调好几次）
    group.requests += row.calls;
    group.priced &&= row.priced;
    groups.set(groupKey, group);
    const hourAt = Math.floor(row.at / 3_600_000) * 3_600_000;
    const hour = hours.get(hourAt) ?? { hour: hourAt, tokens: 0, costUsd: 0, requests: 0, sources: {} };
    hour.tokens += row.tokens;
    hour.costUsd += row.costUsd;
    hour.requests += row.calls;
    const bySource = (hour.sources[row.source] ??= { tokens: 0, costUsd: 0, requests: 0 });
    bySource.tokens += row.tokens;
    bySource.costUsd += row.costUsd;
    bySource.requests += row.calls;
    hours.set(hourAt, hour);
  };
  const projects = new Map<string, Omit<ProjectAggregate, "quota"> & { sessionSet: Set<string>; agentMap: Map<string, { source: string; sessionSet: Set<string>; tokens: number; requests: number }>; comboMap: Map<string, ProjectCombo> }>();
  const officialParts = new Map<string, OfficialPart[]>();
  const accountRows = new Map<string, RequestRow[]>();
  const projectRow = (row: RequestRow) => {
    const key = projectKey(row.cwd);
    let project = projects.get(key);
    if (!project) {
      project = { key, cwd: (row.cwd || "").trim().replace(/[\\/]+$/, "") || "", tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, priced: true, requests: 0, records: 0, sessions: 0, firstAt: row.at, lastAt: row.at, agents: [], combos: [], compaction: { count: 0, tokens: 0 }, sessionSet: new Set(), agentMap: new Map(), comboMap: new Map() };
      projects.set(key, project);
    }
    project.tokens += row.tokens;
    project.input += row.input;
    project.output += row.output;
    project.cacheRead += row.cacheRead;
    project.cacheWrite += row.cacheWrite;
    project.reasoning += row.reasoning;
    project.costUsd += row.costUsd;
    project.priced &&= row.priced;
    project.requests += row.calls;
    project.records += 1;
    project.firstAt = Math.min(project.firstAt, row.at);
    project.lastAt = Math.max(project.lastAt, row.at);
    const session = `${row.source}\u0000${row.session}`;
    project.sessionSet.add(session);
    const agent = project.agentMap.get(row.source) ?? { source: row.source, sessionSet: new Set<string>(), tokens: 0, requests: 0 };
    agent.sessionSet.add(session);
    agent.tokens += row.tokens;
    agent.requests += row.calls;
    project.agentMap.set(row.source, agent);
    const effort = row.effort || "unknown";
    const comboKey = `${row.model}\u0000${effort}\u0000${row.source}`;
    const combo = project.comboMap.get(comboKey) ?? { model: row.model, effort, source: row.source, tokens: 0, input: 0, output: 0, cacheRead: 0, requests: 0, records: 0, costUsd: 0, priced: true };
    combo.tokens += row.tokens;
    combo.input += row.input;
    combo.output += row.output;
    combo.cacheRead += row.cacheRead;
    combo.requests += row.calls;
    combo.records += 1;
    combo.costUsd += row.costUsd;
    combo.priced &&= row.priced;
    project.comboMap.set(comboKey, combo);
    if (row.compaction) {
      project.compaction.count += 1;
      project.compaction.tokens += row.tokens;
    }
    if (row.official === true && row.account) {
      const list = officialParts.get(key) ?? [];
      list.push({ account: row.account.id, at: row.at, tokens: row.tokens, costUsd: row.costUsd });
      officialParts.set(key, list);
    }
  };
  const facets = { models: new Set<string>(), projects: new Set<string>() };
  const q = query.search.trim().toLowerCase();
  const seen = new Set<string>();
  const counts: RequestPage["counts"] = { all: 0, match: 0, mismatch: 0, suspect: 0, unverified: 0 };
  let tokens = 0;
  let costUsd = 0;
  const matched: RequestRow[] = [];
  let firstAt: number | undefined;
  if (firstName) firstAt = readMonth(firstName).reduce<number | undefined>((min, r) => (min == null || r.at < min ? r.at : min), undefined);

  const inMonths = function* () {
    for (const name of names) {
      const month = name.slice(0, 7);
      if (month < fromMonth || month > toMonth) continue;
      yield* readMonth(name);
    }
    yield* cc.own;
  };
  for (const raw of inMonths()) {
    {
      const key = keyOf(raw);
      if (seen.has(key)) continue; // 还没整理的重复行
      seen.add(key);
      const day = dayOf(raw.at);
      if (day < query.from || day > query.to) continue;
      if (query.since != null && raw.at < query.since) continue;
      if (query.until != null && raw.at > query.until) continue;
      if (query.source !== "all" && sourceOf(raw) !== query.source) continue;
      const record = raw.kind === "cc-switch" ? raw : withRoute(raw) ?? cc.matchProxy(raw);
      const row = toRow(record, official.get(record.file), accountCtx);
      facets.models.add(row.model);
      facets.projects.add(row.cwd || "");
      // 分摊周额度涨幅的分母：同一账号同期的全部官方请求，不受下面的模型 / 项目 / 搜索筛选影响
      if (query.projects && row.official === true && row.account) {
        const list = accountRows.get(row.account.id) ?? [];
        list.push(row);
        accountRows.set(row.account.id, list);
      }
      if (query.aggregate && !query.filteredAggregate) aggregateRow(row, day, raw.at);
      if (query.models?.length && !query.models.includes(row.model)) continue;
      if (query.project && (query.project === "__missing__" ? Boolean(row.cwd) : projectKey(row.cwd) !== projectKey(query.project))) continue;
      if (query.channel === "official" && row.official !== true) continue;
      if (query.channel === "api" && row.official !== false) continue;
      if (query.channel === "unknown" && row.official !== undefined) continue;
      if (q) {
        const haystack = [row.model, row.effort, row.requested, row.returned, row.source, row.cwd, row.session, row.responseId, row.requestId, row.statusLabel, row.channel, row.account?.label]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) continue;
      }
      const accountId = row.account?.id ?? "none";
      const bucket = byAccount.get(accountId) ?? { id: accountId, label: row.account?.label ?? "", source: row.source, requests: 0, tokens: 0, costUsd: 0, lastAt: 0, inferred: 0 };
      bucket.requests += 1;
      bucket.tokens += row.tokens;
      bucket.costUsd += row.costUsd;
      bucket.lastAt = Math.max(bucket.lastAt, row.at);
      if (row.account?.basis === "inferred") bucket.inferred += 1;
      byAccount.set(accountId, bucket);
      if (query.account && accountId !== query.account) continue;
      counts.all += 1;
      counts[row.status] += 1;
      tokens += row.tokens;
      costUsd += row.costUsd;
      if (query.status !== "all" && row.status !== query.status) continue;
      if (query.aggregate && query.filteredAggregate) aggregateRow(row, day, raw.at);
      if (query.projects) projectRow(row);
      matched.push(row);
    }
  }

  matched.sort((a, b) =>
    query.sort === "tokens" ? b.tokens - a.tokens || b.at - a.at : query.sort === "cost" ? b.costUsd - a.costUsd || b.at - a.at : b.at - a.at,
  );
  const projectQuotas = query.projects ? projectQuota(officialParts, accountRows, Date.now()) : null;
  const pageSize = Math.max(1, query.pageSize || 20);
  const pages = Math.max(1, Math.ceil(matched.length / pageSize));
  const page = Math.min(Math.max(0, query.page || 0), pages - 1);
  return {
    facets: { models: [...facets.models].sort(), projects: [...facets.projects].sort() },
    total: matched.length,
    page,
    pages,
    rows: query.all ? matched : matched.slice(page * pageSize, (page + 1) * pageSize),
    counts,
    tokens,
    costUsd,
    firstAt,
    accounts: [...byAccount.values()].sort((a, b) => b.requests - a.requests),
    ...(query.aggregate ? { aggregate: { rows: [...groups.values()], hours: [...hours.values()].sort((a, b) => a.hour - b.hour) } } : {}),
    ...(query.projects
      ? {
          projects: [...projects.values()]
            .map(({ sessionSet, agentMap, comboMap, ...project }) => ({
              ...project,
              sessions: sessionSet.size,
              agents: [...agentMap.values()].map(({ sessionSet: set, ...agent }) => ({ ...agent, sessions: set.size })).sort((a, b) => b.tokens - a.tokens),
              combos: [...comboMap.values()].sort((a, b) => b.tokens - a.tokens),
              quota: projectQuotas?.get(project.key) ?? { week: 0, officialTokens: 0, attributedTokens: 0 },
            }))
            .sort((a, b) => b.tokens - a.tokens || b.lastAt - a.lastAt),
        }
      : {}),
  };
}

/**
 * 这一轮新扫到的请求里，最近一段时间内「型号不一致 / 响应存疑」的，给系统通知用。
 * 只看最近的：第一次运行会把历史请求整批补进来，不能对着几个月前的事弹一串通知。
 */
export function recentAlerts(records: RequestRecord[], now = Date.now(), windowMs = 15 * 60_000): RequestRow[] {
  const fresh = records.filter((record) => record.at >= now - windowMs && record.at <= now + 60_000);
  if (!fresh.length) return [];
  const official = attribution();
  const accounts = accountContext();
  return fresh.map((record) => toRow(withRoute(record) ?? record, official.get(record.file), accounts)).filter((row) => row.status === "mismatch" || row.status === "suspect");
}
