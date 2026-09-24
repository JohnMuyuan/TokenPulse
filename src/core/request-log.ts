import fs from "fs";
import path from "path";
import { estimateCost, priceOf } from "./model-pricing";
import { dataFile, readJson } from "./paths";
import { STATUS_LABELS, verifyRequest, type VerifyStatus } from "./request-verify";
import { ccSwitchEnabled, coverKey, readCcSwitch, type CcRequest } from "./cc-switch";
import { accountLabels, KIND_OF_SOURCE, readLoginTimeline, resolveAccount, type LoginTimeline, type RequestAccount } from "./login-timeline";

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
  /** 查询时附上的：同一次请求在 CC Switch 代理里的记录（见 matchProxy）。不落盘。 */
  proxy?: { requested?: string; returned: string };
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
};

export type RequestRow = {
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
};

export type RequestPage = {
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
    hours: { hour: number; tokens: number; costUsd: number; requests: number }[];
  };
  /** 当前时间 / 工具 / 搜索条件下各账号的请求（不受账号和核验筛选影响）。id 为 "none" 的是没对上账号的。 */
  accounts: { id: string; label: string; source: string; requests: number; tokens: number; costUsd: number; lastAt: number; inferred: number }[];
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

function toRow(record: RequestRecord, official: boolean | undefined, accounts: AccountContext = accountContext()): RequestRow {
  // 走中转 / API Key 的不是官方账号发的；CC Switch 导入的走它代理的也一样
  const account =
    official === false || (record.kind === "cc-switch" && record.viaProxy)
      ? null
      : resolveAccount(KIND_OF_SOURCE[sourceOf(record)], record.at, { ref: record.accountRef, email: record.accountEmail }, accounts.timeline, accounts.labels);
  const verdict = verifyRequest({
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
  const hours = new Map<number, { hour: number; tokens: number; costUsd: number; requests: number }>();
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
      const record = raw.kind === "cc-switch" ? raw : cc.matchProxy(raw);
      const row = toRow(record, official.get(record.file), accountCtx);
      if (query.aggregate) {
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
        const hour = hours.get(hourAt) ?? { hour: hourAt, tokens: 0, costUsd: 0, requests: 0 };
        hour.tokens += row.tokens;
        hour.costUsd += row.costUsd;
        hour.requests += row.calls;
        hours.set(hourAt, hour);
      }
      if (q) {
        const haystack = [row.model, row.requested, row.returned, row.source, row.cwd, row.session, row.responseId, row.requestId, row.statusLabel, row.channel, row.account?.label]
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
      matched.push(row);
    }
  }

  matched.sort((a, b) =>
    query.sort === "tokens" ? b.tokens - a.tokens || b.at - a.at : query.sort === "cost" ? b.costUsd - a.costUsd || b.at - a.at : b.at - a.at,
  );
  const pageSize = Math.max(1, query.pageSize || 20);
  const pages = Math.max(1, Math.ceil(matched.length / pageSize));
  const page = Math.min(Math.max(0, query.page || 0), pages - 1);
  return {
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
  return fresh.map((record) => toRow(record, official.get(record.file), accounts)).filter((row) => row.status === "mismatch" || row.status === "suspect");
}
