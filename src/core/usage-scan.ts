import fs from "fs";
import os from "os";
import path from "path";
import { dataFile, readJson, writeJson } from "./paths";
import { appendRequests, compactRequests, type RequestRecord } from "./request-log";
import { accountLabels, KIND_OF_SOURCE, readLoginTimeline, resolveAccount, type LoginTimeline } from "./login-timeline";

/**
 * 统计**这台电脑上所有** AI CLI 的 token 消耗 —— 不管那一轮是在终端里跑的、
 * IDE 插件跑的、还是别的壳子跑的。
 *
 * 做法：**增量读各家 CLI 自己的会话文件**。那些文件里每次 API 请求都留了一条 usage，
 * 这是本机唯一一份「全都算上」的账，不用改用户的 Base URL、不用挂代理。
 *
 * 三家的格式（都对着真实文件核过）：
 *
 * | CLI | 文件 | 那一条 | 去重键 |
 * |-----|------|--------|--------|
 * | Claude Code | `~/.claude/projects/<项目>/<会话>.jsonl` | `type:"assistant"` 的 `message.usage` | `requestId` |
 * | Codex | `~/.codex/sessions/<日期>/rollout-….jsonl` | `type:"token_usage_record"` 的 `payload.usage` | `payload.response_id` |
 * | Grok Build | `~/.grok/sessions/<目录>/<会话>/updates.jsonl` | `turn_completed` 的 `update.usage` | `prompt_id` |
 *
 * 别家 CLI（Gemini / Qwen / iFlow / Copilot）目前不往本地写 per-request usage，
 * 没法统计 —— 等它们写了，在 roots() 和解析函数那儿加一档就行。
 *
 * 几百兆的会话文件不可能每次全读，所以按**字节偏移**增量读。
 * 而且每个文件的账单独记（`files[路径].days`），全局合计 = 所有文件相加：
 * 这样一个文件被重写/截断时，把它自己那份清掉重读就行，不会重复计数。
 */

export type UsageBucket = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  costUsd: number;
  requests: number;
};

/**
 * 一天一个来源一个型号一格：`days[日期][来源][型号]`。
 * 分三层而不是把来源和型号拼成一个键 —— 来源名里本来就有空格（"Claude Code"），
 * 拼起来再切会切错。
 */
export type DayBuckets = Record<string, Record<string, Record<string, UsageBucket>>>;

export type Kind = "claude-code" | "codex" | "grok-build";

export const SOURCES: Record<Kind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex CLI",
  "grok-build": "Grok Build",
};

type FileState = {
  size: number;
  mtimeMs: number;
  /** 已经读到哪个字节。下次从这里接着读。 */
  offset: number;
  /** 这个文件自己贡献的账。文件被重写时整份丢掉重算。 */
  days: DayBuckets;
  /** Codex 的型号写在前面的 turn_context / thread_settings_applied 里，跨批次要记住。 */
  model?: string;
  /**
   * 上一条 Claude 用量行的 requestId。
   *
   * Claude Code 把**一次 API 响应的多个内容块拆成多行**写，每行都带同一份 usage ——
   * 按行累加就把同一次请求算了好几遍（实测能虚高 1.8 倍）。这些重复行永远相邻、
   * usage 完全相同，记住上一条的 id 就够去重了。跨批次也要记住：一组重复行
   * 可能正好被增量读的边界切开。
   */
  lastId?: string;
  /** 哪家 CLI 的会话。额度监控按它把用量对到官方账号上。 */
  kind?: Kind;
  /** 会话头里的 `model_provider` —— 也就是 config.toml 里那个配置块的名字。 */
  provider?: string;
  /**
   * 这个会话是不是走官方登录账号（而不是 API Key / 中转站）。额度监控只算这种。
   * undefined = 还没判断出来。
   */
  official?: boolean;
  /** 按小时的账：`hours[整点时间戳][型号]`。额度监控用，和按天的账一样永久保留。 */
  hours?: Record<string, Record<string, UsageBucket>>;
  /**
   * 官方会话按账号拆开的小时账：`accountHours[账号][整点时间戳][型号]`。
   * 空账号键表示流水无法归属到某个登录账号，不能拿去给某个账号折算容量。
   */
  accountHours?: Record<string, Record<string, Record<string, UsageBucket>>>;
  /**
   * 客户端**请求**的型号，给请求流水做型号核验（见 request-verify.ts）。跨批次要记住：
   * - Claude Code：`attachment.identity.modelId`，会话开头写一次、换型号时再写；
   *   `session_context` 带 `changed`（reason = session_start）说明进程重新接上了这个会话，
   *   可能换了型号却还没写新的 identity —— 这时清掉，宁可「无法核验」也别误报不一致；
   * - Grok：每条用户消息的 `_meta.modelId`；
   * - Codex：就是上面的 `model`（turn_context）。
   */
  requested?: string;
  /** 工作目录（Codex 在 session_meta 里；Claude 每行都有；Grok 在目录名里）。 */
  cwd?: string;
  /**
   * 会话里直接记下的账号（只有 Claude Code 有，而且只是部分会话）：
   * `bridge-session.ownerAccountUuid`（= 凭据里的 accountUuid）和 `session_context.context.userEmail`。
   * 没有的按登录时间线对（login-timeline.ts）。
   */
  accountRef?: string;
  accountEmail?: string;
  /** 账本结构版本，见 STATE_VERSION。 */
  v?: number;
};

export type UsageRollups = {
  version: 1;
  files: Record<string, FileState>;
  /**
   * 见过的 Codex provider 判定（名字 → 是不是官方订阅）。
   * 配置块删掉或改名之后，历史会话就只剩一个名字了 —— 记着当时的结论，
   * 免得一个中转站的旧会话在配置消失后被当成官方额度算进去。
   */
  codexProviders?: Record<string, boolean>;
  /** 上次扫完的时间，界面上显示「刚刚更新」。 */
  scannedAt?: number;
  /**
   * 请求流水整理过一遍的标记（0.3.4）。以前被杀进程留下的重复行不会自己消失（见 scanLocalUsage 里的 pending），
   * 没有这个标记的账本先整体整理一次。
   */
  requestsCompacted?: number;
};

/**
 * 账本结构版本，改了解析逻辑或 bucket 结构就 +1（老账本自动重扫）。
 * 2：Codex 型号改为同时认 turn_context（旧账本里第一轮都是「未知模型」）。
 * 3：按小时的账不再只留 40 天，重扫一遍把已经裁掉的小时账从会话文件里补回来。
 * 4：开始记每一次请求的流水（requests/*.jsonl），重扫一遍把历史请求补进去。
 * 5：流水里记下 Claude 会话自带的账号（accountRef / accountEmail），重扫补上。
 * 6：官方小时账按账号拆分，修复多个账号的额度容量互相污染。
 */
const STATE_VERSION = 6;
const HOUR_MS = 3_600_000;
/** 一次最多读多少字节，免得单个超大文件把内存吃满。剩下的下一轮接着读。 */
const MAX_CHUNK = 32 * 1024 * 1024;

function rollupFile() {
  return dataFile("usage-rollups.json");
}

export function emptyRollups(): UsageRollups {
  return { version: 1, files: {}, codexProviders: {} };
}

export function readRollups(): UsageRollups {
  const parsed = readJson<UsageRollups | null>(rollupFile(), null);
  if (parsed?.version !== 1) return emptyRollups();
  return {
    version: 1,
    files: parsed.files ?? {},
    codexProviders: parsed.codexProviders ?? {},
    scannedAt: parsed.scannedAt,
    requestsCompacted: parsed.requestsCompacted,
  };
}

export function writeRollups(value: UsageRollups) {
  writeJson(rollupFile(), value);
}

export function emptyBucket(): UsageBucket {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, requests: 0 };
}

function bucket(days: DayBuckets, day: string, source: string, model: string): UsageBucket {
  const bySource = (days[day] ??= {});
  const byModel = (bySource[source] ??= {});
  return (byModel[model] ??= emptyBucket());
}

export function addUsage(into: UsageBucket, usage: UsageBucket) {
  into.input += usage.input;
  into.output += usage.output;
  into.cacheRead += usage.cacheRead;
  into.cacheWrite += usage.cacheWrite;
  into.reasoning += usage.reasoning;
  into.costUsd += usage.costUsd;
  into.requests += usage.requests;
}

function dayOf(ms: number) {
  const d = new Date(ms);
  // 本地日期：统计页是按用户当地的「今天」分组的。
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const num = (value: unknown) => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
};

/* ---------------- 归属：官方账号还是中转站 ---------------- */

/**
 * 终端里的 CLI 走官方账号还是中转站，看它自己的全局配置：
 * - Claude Code：`~/.claude/settings.json` 的 env 里配了中转地址或 Key 就不是官方；
 * - Grok：`~/.grok/config.toml` 里有生效的 base_url 就不是官方。
 * Codex 不看这个 —— 它每个会话自己记了 model_provider。
 */


function configOfficial(): Record<Kind, boolean | undefined> {
  const home = os.homedir();
  let claude = true;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")) as {
      env?: Record<string, unknown>;
    };
    const env = settings.env ?? {};
    claude = !["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"].some(
      (key) => typeof env[key] === "string" && String(env[key]).trim(),
    );
  } catch {
    // 没有 settings.json 就是默认的官方登录
  }
  let grok = true;
  try {
    const toml = fs.readFileSync(path.join(home, ".grok", "config.toml"), "utf8");
    grok = !/^\s*base_url\s*=\s*["'][^"']+["']/m.test(toml);
  } catch {
    // 没有 config.toml 同上
  }
  return { "claude-code": claude, codex: undefined, "grok-build": grok };
}

type CodexProviderRule = { official: boolean };

/**
 * 解析 `~/.codex/config.toml` 里的 provider 配置块。
 *
 * **不能只看 `model_provider` 的字面值** —— 那是配置块的名字，用户完全可以把
 * 官方登录的那一套叫 `custom`：
 *
 *     [model_providers.custom]
 *     name = "OpenAI"
 *     requires_openai_auth = true      ← 走 OAuth，吃订阅额度
 *
 * 只认 openai / chatgpt 这类名字的话，这种会话会全被判成中转，「周额度折合」永远算不出来。
 */
function parseCodexProviders(toml: string) {
  const rules = new Map<string, CodexProviderRule>();
  let current = "";
  let block: Record<string, string> = {};
  const flush = () => {
    if (!current) return;
    const base = block.base_url || "";
    const host = (base.match(/^https?:\/\/([^/]+)/i) || [])[1] || "";
    const openaiHost = /(^|\.)openai\.com$|(^|\.)chatgpt\.com$/i.test(host);
    const official =
      !block.env_key &&
      (block.requires_openai_auth === "true"
        ? true
        : !base
          ? /openai|chatgpt/i.test(block.name || current)
          : openaiHost);
    rules.set(current.toLowerCase(), { official });
    current = "";
    block = {};
  };
  for (const raw of toml.split(String.fromCharCode(10))) {
    const line = raw.trim();
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      flush();
      const name = section[1].match(/^model_providers\.\s*"?([^"]+)"?\s*$/);
      current = name ? name[1].trim() : "";
      continue;
    }
    if (!current) continue;
    const pair = line.match(/^([a-z_]+)\s*=\s*(.*)$/i);
    if (pair) block[pair[1].toLowerCase()] = pair[2].trim().replace(/^["']|["'],?$/g, "");
  }
  flush();
  return rules;
}

/** 本机 Codex 是不是 ChatGPT 登录（而不是 API Key）。 */
function codexUsesChatGptLogin() {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codex", "auth.json"), "utf8")) as {
      auth_mode?: string;
      OPENAI_API_KEY?: string | null;
      tokens?: { access_token?: string };
    };
    if (auth.OPENAI_API_KEY) return false;
    if (typeof auth.auth_mode === "string" && /api.?key/i.test(auth.auth_mode)) return false;
    return Boolean(auth.tokens?.access_token);
  } catch {
    return false;
  }
}

type CodexAuth = {
  rules: Map<string, CodexProviderRule>;
  /** 以前扫描时记下的判定，配置里已经没有的名字靠它。 */
  remembered: Record<string, boolean>;
  chatgptLogin: boolean;
};

function codexAuthContext(remembered: Record<string, boolean>): CodexAuth {
  let rules = new Map<string, CodexProviderRule>();
  try {
    rules = parseCodexProviders(fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8"));
  } catch {
    // 没有 config.toml：按记住的判定 + 内置名字 + 登录方式来
  }
  // 配置里现在写的才算数，顺手更新记忆
  for (const [name, rule] of rules) remembered[name] = rule.official;
  return { rules, remembered, chatgptLogin: codexUsesChatGptLogin() };
}

function isOfficialCodexProvider(value: string, codex: CodexAuth) {
  const provider = value.trim().toLowerCase();
  if (!provider) return false;
  // 用 API Key 跑的账记在 API 上，不占订阅额度
  if (!codex.chatgptLogin) return false;
  const rule = codex.rules.get(provider);
  if (rule) return rule.official;
  const known = codex.remembered[provider];
  if (typeof known === "boolean") return known;
  /*
   * 配置块已经不在了（换过配置、甚至整个重置过 ~/.codex）。既然本机是 ChatGPT 登录、
   * 也没有 API Key，这类历史会话最可能就是吃的订阅额度。
   */
  return true;
}

/**
 * Codex 的 `session_meta` 在会话文件最前面。只读文件头，不重扫 token 账 ——
 * 保证已经扫过、但当时没记下 provider 的文件也能被重新归类。
 */
function readCodexProvider(file: string) {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, read).toString("utf8").split(String.fromCharCode(10))) {
      if (!line.trim().startsWith("{")) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj.type !== "session_meta") continue;
        const payload = obj.payload as Record<string, unknown> | undefined;
        if (typeof payload?.model_provider === "string") return payload.model_provider;
      } catch {
        // 文件头可能正好落在一条没写完的 JSON 行上，后面的完整行仍然能判断
      }
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return undefined;
}

/**
 * 判定这个会话归谁。**每次扫描都要重来一遍**，而且要在「文件没变就跳过」之前做：
 * 用户改配置、重新登录、把中转换成官方，这些都不会碰会话文件本身 ——
 * 只在文件变动时才更新归属的话，历史会话会一直挂着旧结论。
 */
function applyAttribution(
  file: string,
  kind: Kind,
  state: FileState,
  official: Record<Kind, boolean | undefined>,
  codex: CodexAuth,
) {
  state.kind = kind;
  if (kind !== "codex") {
    state.official = official[kind];
    return;
  }
  const provider = state.provider || readCodexProvider(file);
  if (!provider) return;
  state.provider = provider;
  state.official = isOfficialCodexProvider(provider, codex);
}

/* ---------------- 找文件 ---------------- */

function walkJsonl(dir: string, out: string[] = [], depth = 0) {
  if (depth > 6) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(full, out, depth + 1);
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function roots(): { kind: Kind; dir: string }[] {
  const home = os.homedir();
  return [
    { kind: "claude-code", dir: path.join(home, ".claude", "projects") },
    { kind: "codex", dir: path.join(home, ".codex", "sessions") },
    { kind: "grok-build", dir: path.join(home, ".grok", "sessions") },
  ];
}

/* ---------------- 解析一行 ---------------- */

type Row = {
  at: number;
  model: string;
  usage: UsageBucket;
  id?: string;
  /** 上游返回的型号（响应里写的那个）。Codex 不记。 */
  returned?: string;
  responseId?: string;
  requestId?: string;
  cwd?: string;
};

function claudeRow(obj: Record<string, unknown>): Row | null {
  if (obj.type !== "assistant") return null;
  const message = obj.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!usage) return null;
  const at = Date.parse(String(obj.timestamp || "")) || 0;
  if (!at) return null;
  const details = usage.output_tokens_details as Record<string, unknown> | undefined;
  return {
    at,
    id: String(obj.requestId || message?.id || ""),
    model: String(message?.model || "") || "未知模型",
    returned: message?.model ? String(message.model) : undefined,
    responseId: message?.id ? String(message.id) : undefined,
    requestId: obj.requestId ? String(obj.requestId) : undefined,
    cwd: typeof obj.cwd === "string" ? obj.cwd : undefined,
    usage: {
      /*
       * **口径统一**：`input` 一律表示「这一轮送进去的全部输入」，缓存读和缓存写是其中的明细。
       * Anthropic 把三者分开报，只取 input 的话缓存那几十万 token 会凭空消失。
       * Codex 和 Grok 的 input 本来就含缓存读，不用动。
       */
      input: num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
      reasoning: num(details?.thinking_tokens),
      costUsd: 0,
      requests: 1,
    },
  };
}

function codexRow(obj: Record<string, unknown>): Row | null {
  if (obj.type !== "token_usage_record") return null;
  const payload = obj.payload as Record<string, unknown> | undefined;
  const usage = payload?.usage as Record<string, unknown> | undefined;
  if (!usage) return null;
  const at = Date.parse(String(obj.timestamp || "")) || 0;
  if (!at) return null;
  // Codex 的 input_tokens **已经含**缓存读，别再加一次。
  return {
    at,
    id: String(payload?.response_id || ""),
    model: "",
    responseId: payload?.response_id ? String(payload.response_id) : undefined,
    usage: {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cached_input_tokens),
      cacheWrite: num(usage.cache_write_input_tokens),
      reasoning: num(usage.reasoning_output_tokens),
      costUsd: 0,
      requests: 1,
    },
  };
}

function grokRows(obj: Record<string, unknown>): Row[] {
  const params = obj.params as Record<string, unknown> | undefined;
  const update = params?.update as Record<string, unknown> | undefined;
  if (!update || update.sessionUpdate !== "turn_completed") return [];
  const usage = update.usage as Record<string, unknown> | undefined;
  if (!usage) return [];
  const at = num(obj.timestamp) * 1000 || 0;
  if (!at) return [];
  const perModel = usage.modelUsage as Record<string, Record<string, unknown>> | undefined;
  // 有按型号拆分就用它，没有就整轮记成一条。
  const entries: [string, Record<string, unknown>][] = perModel && Object.keys(perModel).length ? Object.entries(perModel) : [["", usage]];
  const prompt = String(update.prompt_id || "");
  return entries.map(([model, row]) => ({
    at,
    id: prompt ? `${prompt}:${model}` : "",
    model: model || "未知模型",
    returned: model || undefined,
    usage: {
      input: num(row.inputTokens),
      output: num(row.outputTokens),
      cacheRead: num(row.cachedReadTokens),
      cacheWrite: num(row.cacheCreationTokens),
      reasoning: num(row.reasoningTokens),
      // Grok 自己报了花费，单位是「tick」：128479200 tick ≈ $0.128，即 1e-9 美元。
      costUsd: num(row.costUsdTicks) / 1e9,
      requests: num(row.modelCalls) || 1,
    },
  }));
}

/* ---------------- 扫一个文件 ---------------- */

/** 一轮扫描里攒下的请求流水。rescanned：有文件从头重读过，流水里会有重复，扫完要整理。 */
type ScanOutput = { records: RequestRecord[]; rescanned: boolean };

/** Grok 的会话目录是 `<工作目录 URL 编码>/<会话 ID>/updates.jsonl`。 */
function grokCwd(file: string) {
  try {
    return decodeURIComponent(path.basename(path.dirname(path.dirname(file))));
  } catch {
    return undefined;
  }
}

type AccountContext = { timeline: LoginTimeline; labels: Map<string, string> };

function scanFile(
  file: string,
  kind: Kind,
  state: FileState,
  out: ScanOutput = { records: [], rescanned: false },
  accountContext: AccountContext = { timeline: readLoginTimeline(), labels: accountLabels() },
) {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  const reset = () => {
    if (state.offset > 0) out.rescanned = true;
    state.offset = 0;
    state.days = {};
    state.hours = {};
    state.accountHours = {};
    state.model = undefined;
    state.lastId = undefined;
    state.requested = undefined;
    state.accountRef = undefined;
    state.accountEmail = undefined;
  };
  if (state.v !== STATE_VERSION) {
    state.v = STATE_VERSION;
    reset();
  }
  // 变小了 = 被重写/截断过，之前记的账对不上了：整份清掉重读。
  if (stat.size < state.offset) reset();
  if (stat.size === state.offset) {
    state.size = stat.size;
    state.mtimeMs = stat.mtimeMs;
    return false;
  }
  const end = Math.min(stat.size, state.offset + MAX_CHUNK);
  let text = "";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const length = end - state.offset;
      const buffer = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buffer, 0, length, state.offset);
      text = buffer.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  // 最后一行可能只读了一半：留到下次，偏移只推进到最后一个完整换行。
  const lastBreak = text.lastIndexOf(String.fromCharCode(10));
  if (lastBreak < 0) return false;
  const consumed = Buffer.byteLength(text.slice(0, lastBreak + 1), "utf8");
  const source = SOURCES[kind];
  let touched = false;
  for (const line of text.slice(0, lastBreak).split(String.fromCharCode(10))) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (kind === "claude-code" && obj.type === "bridge-session" && typeof obj.ownerAccountUuid === "string" && obj.ownerAccountUuid) {
      state.accountRef = obj.ownerAccountUuid;
    }
    if (kind === "claude-code" && obj.type === "attachment") {
      const context = (obj.attachment as Record<string, unknown> | undefined)?.context as Record<string, unknown> | undefined;
      // 这个字段后面还跟着一句说明（实测「xxx@gmail.com. Use it only to identify the user…」），只取邮箱本身
      const email = typeof context?.userEmail === "string" ? context.userEmail.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0] : undefined;
      if (email) state.accountEmail = email.replace(/\.$/, "");
    }
    if (kind === "claude-code" && obj.type === "attachment") {
      const attachment = obj.attachment as Record<string, unknown> | undefined;
      if (attachment?.type === "session_context" && attachment.changed) state.requested = undefined;
      const identity = attachment?.identity as Record<string, unknown> | undefined;
      if (typeof identity?.modelId === "string" && identity.modelId) state.requested = identity.modelId;
    }
    if (kind === "grok-build") {
      const update = (obj.params as Record<string, unknown> | undefined)?.update as Record<string, unknown> | undefined;
      const meta = update?._meta as Record<string, unknown> | undefined;
      if (update?.sessionUpdate === "user_message_chunk" && typeof meta?.modelId === "string" && meta.modelId) state.requested = meta.modelId;
    }
    if (kind === "codex") {
      const payload = obj.payload as Record<string, unknown> | undefined;
      if (obj.type === "session_meta" && typeof payload?.model_provider === "string") {
        state.provider = payload.model_provider;
      }
      if (obj.type === "session_meta" && typeof payload?.cwd === "string") state.cwd = payload.cwd;
      /*
       * usage 行自己不带型号，得从前面的记录里记下来。两处都有：
       * - `turn_context`：每一轮开头都写，**一定在这一轮的 usage 之前**，以它为准；
       * - `thread_settings_applied`：只在设置变化时写，而且会话第一轮它排在第一条 usage **之后**
       *   （实测 01a06b8a…：turn_context → usage → thread_settings_applied）。
       *   只认它的话每个会话第一轮都落成「未知模型」，还有的会话压根没有这一条。
       */
      if (obj.type === "turn_context" && typeof payload?.model === "string" && payload.model) {
        state.model = payload.model;
      }
      if (payload?.type === "thread_settings_applied") {
        const settings = payload.thread_settings as Record<string, unknown> | undefined;
        const model = String(settings?.model || "");
        if (model) state.model = model;
      }
    }
    const one = kind === "claude-code" ? claudeRow(obj) : kind === "codex" ? codexRow(obj) : null;
    const rows = kind === "grok-build" ? grokRows(obj) : one ? [one] : [];
    for (const row of rows) {
      const model = row.model || state.model || "未知模型";
      // Claude Code 内部占位的那种，不是真的 API 请求，别算进去。
      if (model === "<synthetic>") continue;
      // 同一次响应被拆成多行、每行都带同一份 usage：只认第一行（见 FileState.lastId）。
      if (kind === "claude-code") {
        if (row.id && row.id === state.lastId) continue;
        state.lastId = row.id;
      }
      addUsage(bucket(state.days, dayOf(row.at), source, model), row.usage);
      const byModel = ((state.hours ??= {})[String(Math.floor(row.at / HOUR_MS) * HOUR_MS)] ??= {});
      addUsage((byModel[model] ??= emptyBucket()), row.usage);
      if (state.official === true) {
        const account = resolveAccount(
          KIND_OF_SOURCE[source],
          row.at,
          { ref: state.accountRef, email: state.accountEmail },
          accountContext.timeline,
          accountContext.labels,
        );
        const accountKey = account?.id ?? "";
        const byAccount = ((state.accountHours ??= {})[accountKey] ??= {});
        const byAccountHour = (byAccount[String(Math.floor(row.at / HOUR_MS) * HOUR_MS)] ??= {});
        addUsage((byAccountHour[model] ??= emptyBucket()), row.usage);
      }
      if (row.cwd) state.cwd = row.cwd;
      out.records.push({
        // 没有 ID 的（极少）用时间 + 型号 + token 凑一个，重读时还是同一个键
        id: row.id || `${row.at}:${model}:${row.usage.input}:${row.usage.output}`,
        at: row.at,
        kind,
        file,
        cwd: state.cwd ?? (kind === "grok-build" ? grokCwd(file) : undefined),
        model,
        requested: kind === "codex" ? state.model : state.requested,
        returned: row.returned,
        responseId: row.responseId,
        requestId: row.requestId,
        input: row.usage.input,
        output: row.usage.output,
        cacheRead: row.usage.cacheRead,
        cacheWrite: row.usage.cacheWrite,
        reasoning: row.usage.reasoning,
        costUsd: row.usage.costUsd,
        calls: row.usage.requests,
        accountRef: state.accountRef,
        accountEmail: state.accountEmail,
      });
      touched = true;
    }
  }
  state.offset += consumed;
  state.size = stat.size;
  state.mtimeMs = stat.mtimeMs;
  return touched;
}

function safeStat(file: string) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/* ---------------- 对外 ---------------- */

let scanning = false;

/**
 * 扫一遍本机所有 CLI 会话文件，把新增的部分记进账里。
 * 同一时间只跑一个（启动时、定时都会叫它）。
 */
export function scanLocalUsage(): { files: number; changed: number; skipped: boolean; records: RequestRecord[] } {
  if (scanning) return { files: 0, changed: 0, skipped: true, records: [] };
  scanning = true;
  try {
    const rollups = readRollups();
    // 上一轮写了流水、没写完账本就被杀了（见文末的说明）
    const pendingFile = dataFile("requests-pending");
    const interrupted = fs.existsSync(pendingFile);
    const alive = new Set<string>();
    const official = configOfficial();
    const codex = codexAuthContext((rollups.codexProviders ??= {}));
    const accountContext: AccountContext = { timeline: readLoginTimeline(), labels: accountLabels() };
    let changed = 0;
    let files = 0;
    const out: ScanOutput = { records: [], rescanned: false };
    for (const { kind, dir } of roots()) {
      for (const file of walkJsonl(dir)) {
        alive.add(file);
        files += 1;
        const state = (rollups.files[file] ??= { size: 0, mtimeMs: 0, offset: 0, days: {} });
        applyAttribution(file, kind, state, official, codex);
        // 大小和改动时间都没变就跳过（新文件记的是 0，不会误判成没变）。
        const stat = safeStat(file);
        const needsAccountHours =
          state.official === true &&
          (!state.accountHours || (Object.keys(state.accountHours).length === 0 && Object.keys(state.hours ?? {}).length > 0));
        if (stat && state.v === STATE_VERSION && stat.size === state.size && stat.mtimeMs === state.mtimeMs && !needsAccountHours) continue;
        // 缺按账号的小时账：得从头重读这个文件才补得出来。只把它交给 scanFile 的话，偏移没变它直接返回，永远补不上
        if (needsAccountHours) state.v = 0;
        if (scanFile(file, kind, state, out, accountContext)) changed += 1;
      }
    }
    // CLI 自己清掉的老会话：账留着（那些 token 确实花过），只是不会再更新。
    for (const key of Object.keys(rollups.files)) {
      if (!alive.has(key) && !Object.keys(rollups.files[key].days).length) delete rollups.files[key];
    }
    /*
     * 先写流水再写账本：反过来的话偏移已经推进，这一段请求就永远补不回来了。
     * 代价是写完流水、账本还没写就被杀进程时，下次从旧偏移重读会把这一段再追加一遍 —— 这不是「重读」（rescanned），
     * 以前不会触发整理，重复行就一直留着（实测强制关掉程序后当天流水 749 行里 234 行是重复的）。
     * 所以追加前留一个 pending 标记、账本写完再删；开扫时发现它还在，说明上一轮死在中间，这轮扫完整理一遍。
     */
    if (interrupted || rollups.requestsCompacted !== 1) out.rescanned = true;
    if (out.records.length) {
      // 第一次运行时数据目录可能还不存在
      fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
      fs.writeFileSync(pendingFile, String(Date.now()));
    }
    appendRequests(out.records);
    if (out.rescanned) {
      compactRequests();
      rollups.requestsCompacted = 1;
    }
    rollups.scannedAt = Date.now();
    writeRollups(rollups);
    fs.rmSync(pendingFile, { force: true });
    return { files, changed, skipped: false, records: out.records };
  } finally {
    scanning = false;
  }
}
