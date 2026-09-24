import fs from "fs";
import os from "os";
import path from "path";
import { dataFile, readJson, writeJson } from "./paths";
import type { DayBuckets } from "./usage-scan";

/**
 * 从 CC Switch 导入用量（**只读**它的库 `~/.cc-switch/cc-switch.db`，不写、不改它任何文件）。
 *
 * CC Switch 的账分两处（本机实测）：
 * - `usage_daily_rollups`：每天 × 应用 × 供应商 × 型号的汇总，存的是**较早**的（2026-06-03 ~ 08-24）；
 * - `proxy_request_logs`：逐条请求，存的是**最近**的（08-25 起），老的会被它卷进汇总表。
 * `provider_id` 以 `_` 开头（`_session` / `_codex_session` / `_grok_session` / `_opencode_session`）的是它扫 CLI 会话文件得来的，
 * 和 TokenPulse 自己扫的是同一批请求；其它（UUID）是走它本地代理的请求。
 *
 * 价值有两块：
 * 1. **补历史 / 补工具**：CLI 早把 6~8 月的会话文件清掉了，CC Switch 的汇总表里还有；OpenCode 等 TokenPulse 不扫的工具也在里面。
 *    去重规则按「天 × 工具」：TokenPulse 自己那天那个工具有账，就不用 CC Switch 的（见 report.ts）。
 * 2. **型号核验**：走它代理的请求，它记了 `request_model`（客户端要的）和 `model`（上游回的）——
 *    和 sub2api 读上游响应里 `response.model` 的做法一样。Codex 的会话文件不记返回型号，只有这里能补上。
 *
 * 口径：CC Switch 的 `input_tokens` 是**不含缓存**的新增输入（实测 Codex 汇总 1.39 亿输入对 24.5 亿缓存读），
 * TokenPulse 的 input 含缓存读写，导入时补齐。
 *
 * node:sqlite 要 Node 22.5+（Electron 44）；在 worker 里跑，不卡界面。
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadSqlite = () => require("node:sqlite") as {
  DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => {
    prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
    close: () => void;
  };
};

/** CC Switch 的 app_type → 来源名（和 TokenPulse 自己的来源名一致，才能按「天 × 工具」去重）。 */
export const CC_SOURCES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  grokbuild: "Grok Build",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  copilot: "Copilot CLI",
  hermes: "Hermes",
};

export type CcDayRow = { day: string; source: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; requests: number };

/** 一条逐条请求。字段名压短：这份文件可能有上万条。 */
export type CcRequest = {
  id: string;
  at: number;
  source: string;
  model: string;
  /** 客户端请求的型号。 */
  requested?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  /** true = 走 CC Switch 代理（上游响应里的型号可信）；false = 它扫 CLI 会话文件得来的。 */
  proxy: boolean;
  status: number;
};

export type CcSwitchStore = {
  version: 1;
  path: string;
  found: boolean;
  syncedAt?: number;
  /** 上次读库时 db + wal 的修改时间，没变就不重读。 */
  stamp?: string;
  days: CcDayRow[];
  requests: CcRequest[];
  error?: string;
};

export function ccSwitchDbPath() {
  return path.join(os.homedir(), ".cc-switch", "cc-switch.db");
}

function storeFile() {
  return dataFile("cc-switch.json");
}

export function readCcSwitch(): CcSwitchStore | null {
  const store = readJson<CcSwitchStore | null>(storeFile(), null);
  return store?.version === 1 ? store : null;
}

/** 设置里的开关，默认开。worker 里读不到主进程的 prefs 模块，直接读文件。 */
export function ccSwitchEnabled() {
  return readJson<{ ccSwitch?: boolean }>(dataFile("prefs.json"), {}).ccSwitch !== false;
}

function localDay(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

function stampOf(file: string) {
  return [file, `${file}-wal`].map((name) => fs.statSync(name, { throwIfNoEntry: false })?.mtimeMs ?? 0).join(":");
}

/** 最少隔多久重读一次：CC Switch 开着时库几乎每分钟都在变，没必要每分钟重写一份几 MB 的副本。 */
const MIN_SYNC_MS = 10 * 60_000;

/**
 * 需要的话从 CC Switch 的库同步一份到 `~/.tokenpulse/cc-switch.json`。
 * force：设置里点了「立即同步」。
 */
export function syncCcSwitch(force = false, now = Date.now()): CcSwitchStore {
  const file = ccSwitchDbPath();
  const previous = readCcSwitch();
  if (!fs.existsSync(file)) {
    const store: CcSwitchStore = { version: 1, path: file, found: false, syncedAt: now, days: [], requests: [] };
    if (previous?.found !== false) writeJson(storeFile(), store);
    return store;
  }
  const stamp = stampOf(file);
  if (!force && previous?.found && previous.stamp === stamp) return previous;
  if (!force && previous?.found && previous.syncedAt && now - previous.syncedAt < MIN_SYNC_MS) return previous;

  let store: CcSwitchStore;
  try {
    store = { version: 1, path: file, found: true, syncedAt: now, stamp, ...readDatabase(file) };
  } catch (error) {
    // 库被锁、表结构变了……保留上一份能用的数据，只记下错误
    store = { ...(previous ?? { version: 1, path: file, days: [], requests: [] }), found: true, syncedAt: now, error: String((error as Error)?.message || error).slice(0, 200) };
  }
  writeJson(storeFile(), store);
  return store;
}

function readDatabase(file: string): Pick<CcSwitchStore, "days" | "requests"> {
  const { DatabaseSync } = loadSqlite();
  // 只读打开：CC Switch 正开着也不会互相干扰；WAL 里还没合并进主库的也读得到。
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((row) => row.name));
    const days: CcDayRow[] = [];
    if (tables.has("usage_daily_rollups")) {
      for (const row of db
        .prepare("SELECT date, app_type, model, request_count, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_cost_usd FROM usage_daily_rollups")
        .all() as Record<string, unknown>[]) {
        const day = String(row.date || "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        const cacheRead = num(row.cache_read_tokens);
        const cacheWrite = num(row.cache_creation_tokens);
        days.push({
          day,
          source: CC_SOURCES[String(row.app_type)] ?? String(row.app_type || "CC Switch"),
          model: String(row.model || "") || "未知模型",
          input: num(row.input_tokens) + cacheRead + cacheWrite,
          output: num(row.output_tokens),
          cacheRead,
          cacheWrite,
          costUsd: num(row.total_cost_usd),
          requests: num(row.request_count),
        });
      }
    }
    const requests: CcRequest[] = [];
    if (tables.has("proxy_request_logs")) {
      for (const row of db
        .prepare(
          `SELECT request_id, provider_id, app_type, model, request_model, input_tokens, output_tokens, cache_read_tokens,
                  cache_creation_tokens, total_cost_usd, status_code, created_at FROM proxy_request_logs`,
        )
        .all() as Record<string, unknown>[]) {
        const at = num(row.created_at) * 1000;
        if (!at) continue;
        const cacheRead = num(row.cache_read_tokens);
        const cacheWrite = num(row.cache_creation_tokens);
        requests.push({
          id: String(row.request_id),
          at,
          source: CC_SOURCES[String(row.app_type)] ?? String(row.app_type || "CC Switch"),
          model: String(row.model || "") || "未知模型",
          requested: row.request_model ? String(row.request_model) : undefined,
          input: num(row.input_tokens) + cacheRead + cacheWrite,
          output: num(row.output_tokens),
          cacheRead,
          cacheWrite,
          costUsd: num(row.total_cost_usd),
          proxy: !String(row.provider_id || "").startsWith("_"),
          status: num(row.status_code),
        });
      }
    }
    return { days, requests };
  } finally {
    db.close();
  }
}

/**
 * CC Switch 的账摊成「天 × 工具 × 型号」。汇总表和逐条表按天是错开的（老的卷进汇总），
 * 保险起见同一天同一工具两边都有时只用汇总表。失败的请求（非 2xx）不算。
 */
export function ccSwitchDays(store: CcSwitchStore | null): CcDayRow[] {
  if (!store?.found) return [];
  const rolled = new Set(store.days.map((row) => `${row.day}\u0000${row.source}`));
  const merged = new Map<string, CcDayRow>();
  const add = (row: CcDayRow) => {
    const key = `${row.day}\u0000${row.source}\u0000${row.model}`;
    const hit = merged.get(key);
    if (!hit) {
      merged.set(key, { ...row });
      return;
    }
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "costUsd", "requests"] as const) hit[field] += row[field];
  };
  for (const row of store.days) add(row);
  for (const request of store.requests) {
    if (request.status < 200 || request.status >= 300) continue;
    const day = localDay(request.at);
    if (rolled.has(`${day}\u0000${request.source}`)) continue;
    add({ day, source: request.source, model: request.model, input: request.input, output: request.output, cacheRead: request.cacheRead, cacheWrite: request.cacheWrite, costUsd: request.costUsd, requests: 1 });
  }
  return [...merged.values()];
}

/** 「天 × 工具」键。 */
export const coverKey = (day: string, source: string) => `${day}\u0000${source}`;

/** TokenPulse 自己有账（请求数 > 0）的「天 × 工具」。 */
export function coveredDays(days: DayBuckets) {
  const covered = new Set<string>();
  for (const [day, bySource] of Object.entries(days)) {
    for (const [source, byModel] of Object.entries(bySource)) {
      if (Object.values(byModel).some((bucket) => bucket.requests > 0)) covered.add(coverKey(day, source));
    }
  }
  return covered;
}

/**
 * 摊成 DayBuckets，跳过 TokenPulse 自己已经有账的「天 × 工具」。
 * 返回补进来的账和被跳过的天数（界面上照实说）。
 */
export function ccSwitchBuckets(store: CcSwitchStore | null, covered: Set<string>) {
  const days: DayBuckets = {};
  const importedDays = new Set<string>();
  const skipped = new Set<string>();
  const sources = new Map<string, number>();
  for (const row of ccSwitchDays(store)) {
    const key = coverKey(row.day, row.source);
    if (covered.has(key)) {
      skipped.add(key);
      continue;
    }
    importedDays.add(key);
    const bucket = (((days[row.day] ??= {})[row.source] ??= {})[row.model] ??= {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      costUsd: 0,
      requests: 0,
    });
    bucket.input += row.input;
    bucket.output += row.output;
    bucket.cacheRead += row.cacheRead;
    bucket.cacheWrite += row.cacheWrite;
    bucket.costUsd += row.costUsd;
    bucket.requests += row.requests;
    sources.set(row.source, (sources.get(row.source) ?? 0) + row.requests);
  }
  return { days, imported: importedDays.size, skipped: skipped.size, sources };
}

export type CcSwitchStatus = {
  enabled: boolean;
  found: boolean;
  path: string;
  syncedAt?: number;
  error?: string;
  /** 补进统计的「天 × 工具」数 / 因为 TokenPulse 自己有账而跳过的数。 */
  importedDays: number;
  skippedDays: number;
  /** 补进来的请求数，按工具。 */
  sources: { source: string; requests: number }[];
  /** 走 CC Switch 代理的请求数（型号核验能用上的）。 */
  proxyRequests: number;
};
