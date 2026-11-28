import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { dataFile, readJson, writeJson } from "./paths";
import { pbDurationMs, pbFields, pbMessage, pbNumber, pbString, pbTime } from "./protobuf-lite";
import { normalizeModel } from "./request-verify";

/**
 * Google Antigravity 的本地数据（2026-11 对着 Antigravity 2.29 / language server 2.29.0 的真实文件核过）。
 *
 * - `~/.gemini/antigravity/conversations/<对话 ID>.db`：每个对话一个 SQLite（WAL 模式，Antigravity 开着时一直在写）。
 *   - `steps`：对话里的每一步。`step_type = 15` 是一次模型回复；状态见 STEP（3 完成，8 生成中，9 等批准……）。
 *     `metadata`（protobuf）：1 创建时间、6 生成完成时间（Timestamp）；9 用量；11 模型的数字 id；20.3 对应 gen_metadata 的 idx。
 *     用量：1 模型数字 id、2 输入（不含缓存）、3 输出（= 9 思考 + 10 回复）、4 缓存写入、5 缓存读取、7 消息 id、11 响应 id。
 *   - `gen_metadata`：每次生成一条（protobuf，带完整提示词，很大）。只从这里取型号名：1.19 型号（如 gemini-3.8-flash），
 *     1.20 键值对里有 model_enum（如 MODEL_PLACEHOLDER_M417）。同一个数字 id 的型号固定，读一次就记住。
 *     内部型号名带着看不懂的后缀（gemini-4-argon-b），档位也不在里面；显示名和档位用额度接口给的标签对（见 modelLabels）。
 * - `~/.gemini/antigravity/conversation_summaries.db`：对话列表（标题、工作区、状态）。这里只取工作区当项目目录。
 *
 * 只读打开，读完立刻关掉；Antigravity 正在写的时候读不到（SQLITE_BUSY 等）就跳过这一轮，下次再读。
 */

export function antigravityDir() {
  return process.env.TOKENPULSE_ANTIGRAVITY_DIR || path.join(os.homedir(), ".gemini", "antigravity");
}

export function antigravityCliDir() {
  if (process.env.TOKENPULSE_ANTIGRAVITY_CLI_DIR) return process.env.TOKENPULSE_ANTIGRAVITY_CLI_DIR;
  if (process.env.TOKENPULSE_ANTIGRAVITY_DIR) return path.join(path.dirname(process.env.TOKENPULSE_ANTIGRAVITY_DIR), "antigravity-cli");
  return path.join(os.homedir(), ".gemini", "antigravity-cli");
}

export function antigravityDirs(): string[] {
  return [...new Set([antigravityDir(), antigravityCliDir()])];
}

type Statement = { all: (...args: unknown[]) => unknown[]; get: (...args: unknown[]) => unknown; iterate: (...args: unknown[]) => IterableIterator<unknown> };
type Database = { prepare: (sql: string) => Statement; exec?: (sql: string) => void; close: () => void };
const openDb = (file: string): Database => {
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => Database };
  const db = new DatabaseSync(file, { readOnly: true });
  try { db.exec?.("PRAGMA busy_timeout = 200; PRAGMA cache_size = -2000; PRAGMA temp_store = MEMORY;"); } catch { /* 只读或旧版不支持时跳过 */ }
  return db;
};
function toBuf(u8: Uint8Array | null | undefined): Buffer | null {
  return u8 ? Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength) : null;
}
/** 表可能不存在（老版本、刚建的对话）：没有就是 null。 */
function prepareOptional(db: Database, sql: string): Statement | null {
  try { return db.prepare(sql); } catch { return null; }
}
function withDb<T>(file: string, fn: (db: Database) => T): T {
  const db = openDb(file);
  try { return fn(db); } finally { db.close(); }
}

/**
 * 有上限的 LRU 缓存（Map 保持插入顺序）：命中时挪到队尾，超出上限只淘汰最久没用的几条。
 * 不能「满了就整表 clear()」：条目数一旦多于上限（比如两小时内动过的对话有几百个），每轮扫描都会把缓存清空重来，命中率归零，
 * 每轮都要把所有对话库重新打开一遍（2026-11-28 用户反馈主进程持续 85%+ 单核、100 MB/s 读盘）。
 */
export function lruGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key);
  if (value !== undefined) { map.delete(key); map.set(key, value); }
  return value;
}
export function lruSet<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/** 对话库文件：只要 <UUID>.db（同时扫描 Antigravity IDE 与 Antigravity CLI 数据目录，同名 UUID 取最近修改的一份）。 */
export function antigravityConversationFiles(): string[] {
  const byName = new Map<string, { file: string; mtimeMs: number }>();
  for (const root of antigravityDirs()) {
    const dir = path.join(root, "conversations");
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.db$/i.test(name)) continue;
      const file = path.join(dir, name);
      const mtimeMs = antigravityStamp(file)?.mtimeMs ?? 0;
      const key = name.toLowerCase();
      const prev = byName.get(key);
      if (!prev || mtimeMs > prev.mtimeMs) byName.set(key, { file, mtimeMs });
    }
  }
  return [...byName.values()].map((item) => item.file);
}

/** 对话库连同 -wal 的大小和改动时间：WAL 模式下新内容先写进 -wal，主库要等合并才变。 */
export function antigravityStamp(file: string): { size: number; mtimeMs: number } | null {
  let size = 0, mtimeMs = 0, found = false;
  for (const part of [file, file + "-wal"]) {
    // 没有 -wal 是正常的：throwIfNoEntry 让「不存在」直接返回 undefined，不必每次构造异常（每轮扫描要对几百个对话库各查两次）
    let stat: fs.Stats | undefined;
    try { stat = fs.statSync(part, { throwIfNoEntry: false }); } catch { stat = undefined; }
    if (!stat) continue;
    size += stat.size; mtimeMs = Math.max(mtimeMs, stat.mtimeMs); found ||= part === file;
  }
  return found ? { size, mtimeMs } : null;
}

/** 对话 ID → 工作区目录（第一个）。读不到就是空的。 */
export function antigravityWorkspaces(): Map<string, string> {
  const out = new Map<string, string>();
  for (const root of antigravityDirs()) {
    const file = path.join(root, "conversation_summaries.db");
    if (!fs.existsSync(file)) continue;
    try {
      withDb(file, (db) => {
        for (const row of db.prepare("select conversation_id, workspace_uris from conversation_summaries").all() as { conversation_id: string; workspace_uris: string | null }[]) {
          const first = workspacePath(row.workspace_uris);
          if (row.conversation_id && first) out.set(row.conversation_id, first);
        }
      });
    } catch { /* 正在写或者格式变了：没有项目目录也照样统计 */ }
  }
  return out;
}

export function workspacePath(uris: string | null | undefined): string | undefined {
  let list: unknown;
  try { list = JSON.parse(uris || "[]"); } catch { return undefined; }
  const first = Array.isArray(list) ? list.find((item) => typeof item === "string" && item.startsWith("file:")) : undefined;
  if (typeof first !== "string") return undefined;
  try { return fileURLToPath(first); } catch { return undefined; }
}

export type AgyModel = { model: string; enum?: string; label?: string };

export type AgyGenMeta = {
  model?: string;
  rawModel?: string;
  enum?: string;
  label?: string;
  requestId?: string;
  firstTokenMs?: number;
  streamingMs?: number;
};

export type AgyGeneration = {
  /** steps 表里这一步的 idx。 */
  step: number;
  /** 生成完成的时间。 */
  at: number;
  /** 这一步开始的时间（发出请求）。 */
  startAt: number;
  modelId: number;
  /** 这一步自身 gen_metadata 里记录的型号信息（优先于按 modelId 缓存的共享条目）。 */
  genModel?: AgyModel;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  responseId?: string;
  requestId?: string;
  returned?: string;
  firstTokenMs?: number;
  totalMs?: number;
  tokensPerSec?: number;
  avgTokensPerSec?: number;
  thinkingMs?: number;
  /** 同一条用户指令下无人工介入的第几次模型调用（>= 2 时记录）。 */
  autoStep?: number;
};

/** 一条 gen_metadata 里的型号、档位标签、请求 ID 和流式耗时（首字 + 生成时长）。 */
export function parseGenerationMeta(data: Buffer): AgyGenMeta | null {
  const request = pbMessage(data, 1);
  if (!request) return null;
  const rawModel = pbString(request, 19).trim();
  const label = pbString(request, 21).trim();
  let modelEnum = "", requestId = "";
  for (const field of pbFields(request) ?? []) {
    if (field.no === 20 && field.bytes) {
      const key = pbString(field.bytes, 1);
      if (key === "model_enum") modelEnum = pbString(field.bytes, 2).trim();
      else if (key === "request_id") requestId = pbString(field.bytes, 2).trim();
    }
  }
  const firstTokenMs = pbDurationMs(pbMessage(request, 11));
  const streamingMs = pbDurationMs(pbMessage(request, 12));
  const model = rawModel || modelEnum;
  if (!model && !label && !requestId && !firstTokenMs && !streamingMs) return null;
  return {
    ...(model ? { model } : {}),
    ...(rawModel ? { rawModel } : {}),
    ...(modelEnum ? { enum: modelEnum } : {}),
    ...(label ? { label } : {}),
    ...(requestId ? { requestId } : {}),
    ...(firstTokenMs > 0 ? { firstTokenMs } : {}),
    ...(streamingMs > 0 ? { streamingMs } : {}),
  };
}

/** 一条 gen_metadata 里的型号名和 model_enum。 */
export function generationModel(data: Buffer): AgyModel | null {
  const parsed = parseGenerationMeta(data);
  if (!parsed?.model) return null;
  return {
    model: parsed.model,
    ...(parsed.enum ? { enum: parsed.enum } : {}),
    ...(parsed.label ? { label: parsed.label } : {}),
  };
}

/*
 * 型号的显示名：Antigravity 的额度接口（GetUserStatus）按 model_enum 给标签，如「Gemini 4 Argon (High)」；
 * gen_metadata 的 1.21 也直接存了同款显示名。
 * 每次查额度时存一份（antigravity-models.json），扫描时拿来对：型号按标签转成 ID 的写法（gemini-4-argon、claude-opus-5-5），
 * 括号里的是思考档位。还没查过额度、或者标签里没有的，用库里的内部型号名。
 */
const labelFile = () => dataFile("antigravity-models.json");
export function readModelLabels(): Record<string, string> {
  const raw = readJson<{ labels?: Record<string, string> } | null>(labelFile(), null);
  return raw?.labels && typeof raw.labels === "object" ? raw.labels : {};
}
/** 记下新的标签（只加不删：旧型号下线了，老对话照样要能对上）。有变化才写。 */
export function rememberModelLabels(labels: Record<string, string>) {
  const before = readModelLabels();
  const merged = { ...before, ...labels };
  if (JSON.stringify(merged) !== JSON.stringify(before)) writeJson(labelFile(), { labels: merged });
}
const LABEL_EFFORTS = new Set([
  "thinking", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
  "none", "auto", "adaptive", "enabled", "disabled",
]);
const splitLabelMemo = new Map<string, { model: string; family: string; effort?: string }>();
export function splitModelLabel(label: string): { model: string; family: string; effort?: string } {
  const cached = splitLabelMemo.get(label);
  if (cached) return cached;
  const trimmed = label.trim();
  const match = trimmed.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  const rawParen = match?.[2].trim().toLowerCase();
  const isEffort = Boolean(rawParen && LABEL_EFFORTS.has(rawParen));
  let family: string;
  let id: string;
  let effort: string | undefined;
  if (match && isEffort) {
    family = match[1].trim();
    id = family.toLowerCase().replace(/\s+/g, "-");
    effort = rawParen === "thinking" ? "high" : rawParen;
  } else if (match) {
    // 括号里不是思考档位（如 Orchestrator (Carbon) / Orchestrator (Argon)）：属于子型号变体，不记思考等级
    family = trimmed;
    const baseId = match[1].trim().toLowerCase().replace(/\s+/g, "-");
    const subId = rawParen!.replace(/\s+/g, "-");
    id = `${baseId}-${subId}`;
  } else {
    family = trimmed;
    id = family.toLowerCase().replace(/\s+/g, "-");
  }
  // Anthropic 的型号 ID 用短横线分版本（claude-opus-5-5），和 Claude Code 记的对上
  if (id.startsWith("claude-")) id = id.replace(/\./g, "-");
  const out = { model: id, family, ...(effort ? { effort } : {}) };
  if (splitLabelMemo.size > 256) splitLabelMemo.clear();
  splitLabelMemo.set(label, out);
  return out;
}
/**
 * 识别明确带版本号的真实模型 ID（如 claude-opus-4-6、claude-opus-4-6-medium、gemini-2.5-flash），
 * 排除 MODEL_PLACEHOLDER_* 占位符、无版本号内部代号（gemini-pro-orchestrator / gemini-flash-worker-agy）及测试假名（claude-x）。
 */
const EXPLICIT_VERSIONED_MODEL = /^(?:claude-(?:opus|sonnet|haiku|fable|mythos)-\d+(?:[.-]\d+)*|gemini-\d+(?:\.\d+)*-[a-z][\w.-]*|gpt-\d+(?:[.-][\w]+)*|gpt-oss-\d+b|grok-\d+(?:\.\d+)*)(?:-[a-z0-9._-]+)*$/i;
const RAW_EFFORT_TAIL = /^(.*?)(?:-(?:tiered-)?(thinking|minimal|low|medium|high|xhigh|max|ultra|adaptive|auto|dynamic))+$/i;

function parseExplicitRawModel(raw: string): { model: string; effort?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed || !EXPLICIT_VERSIONED_MODEL.test(trimmed)) return null;
  let base = trimmed.toLowerCase();
  let effort: string | undefined;
  const m = base.match(RAW_EFFORT_TAIL);
  if (m && m[1] && EXPLICIT_VERSIONED_MODEL.test(m[1])) {
    base = m[1];
    const rawEff = m[2].toLowerCase();
    effort = rawEff === "thinking" ? "high" : rawEff;
  }
  if (base.startsWith("claude-")) base = base.replace(/\./g, "-");
  return { model: base, ...(effort ? { effort } : {}) };
}

function stepModelFromGen(genParsed: AgyGenMeta | null, existing?: AgyModel): AgyModel | undefined {
  if (!genParsed?.model) return undefined;
  if (genParsed.rawModel) {
    const inheritLabel = !genParsed.label && existing?.label && (!genParsed.enum || !existing.enum || genParsed.enum === existing.enum)
      ? existing.label
      : undefined;
    return {
      model: genParsed.rawModel,
      ...(genParsed.enum ? { enum: genParsed.enum } : {}),
      ...(genParsed.label ? { label: genParsed.label } : inheritLabel ? { label: inheritLabel } : {}),
    };
  }
  if (existing && (!genParsed.enum || !existing.enum || genParsed.enum === existing.enum)) {
    return {
      ...existing,
      ...(genParsed.enum && !existing.enum ? { enum: genParsed.enum } : {}),
      ...(genParsed.label ? { label: genParsed.label } : {}),
    };
  }
  return {
    model: genParsed.model,
    ...(genParsed.enum ? { enum: genParsed.enum } : {}),
    ...(genParsed.label ? { label: genParsed.label } : {}),
  };
}

export function resolveModel(found: AgyModel | undefined, labels: Record<string, string>): { model: string; effort?: string; labeled: boolean } {
  const stepLabel = found?.label?.trim() || "";
  const enumLabel = (found?.enum ? labels[found.enum] : undefined)?.trim() || "";
  const label = stepLabel || enumLabel;
  if (!label) return { model: found?.model || "未知模型", labeled: false };
  const { model: labelModel, effort: labelEffort } = splitModelLabel(label);
  const rawParsed = found?.model ? parseExplicitRawModel(found.model) : null;
  if (rawParsed && normalizeModel(rawParsed.model) !== normalizeModel(labelModel)) {
    // gen_metadata 1.19 明确记录了真实执行的带版本号模型（如子代理实际走 claude-opus-4-6），
    // 而 label / model_enum 沿用了父会话或被重映射的占位标签（如 Claude Opus 5.5）：以实际模型为准。
    return { model: rawParsed.model, ...(rawParsed.effort ? { effort: rawParsed.effort } : {}), labeled: true };
  }
  return { model: labelModel, ...(labelEffort ? { effort: labelEffort } : {}), labeled: true };
}

/*
 * 步骤状态（CortexStepStatus，从 language server 里的 protobuf 描述读出来的编号）：
 * 0 未指定、1 PENDING、2 RUNNING、3 DONE、4 INVALID、5 CLEARED、6 CANCELED、7 ERROR、8 GENERATING、9 WAITING（等用户批准）、11 QUEUED、12 INTERRUPTED。
 */
export const STEP = { PENDING: 1, RUNNING: 2, DONE: 3, CANCELED: 6, ERROR: 7, GENERATING: 8, WAITING: 9, QUEUED: 11, INTERRUPTED: 12 } as const;
/** 还没结束的状态：生成到一半、排队、等批准。 */
export const STEP_OPEN = new Set<number>([0, STEP.PENDING, STEP.RUNNING, STEP.GENERATING, STEP.WAITING, STEP.QUEUED]);
export const MODEL_REPLY = 15;
/** 一步卡在「没完成」超过这么久，就当它不会再完成了，接着往后读（不然后面的都算不上）。 */
const STUCK_MS = 60 * 60_000;

export type AgyStreamMetricsOpts = {
  /** step_payload.body field 11（thinking_duration，从开始到最后一个思考块结束的毫秒数）。 */
  thinkingMs?: number;
  hasText?: boolean;
  hasThought?: boolean;
  hasTool?: boolean;
};

export type AgyStreamMetrics = {
  firstTokenMs: number;
  tokensPerSec: number;
  /** 未算出纯流式速度但输出与总耗时够长时的整包均速（供明细页展示 ≈，不计入速度走势曲线）。 */
  avgTokensPerSec: number;
};

/** 从 steps.step_payload（只读元数据，不提取正文）中解析思考耗时与回复形态。 */
function parseReplyBodyHints(payload: Buffer | null | undefined): AgyStreamMetricsOpts {
  if (!payload) return {};
  const body = pbMessage(payload, 20);
  if (!body) return {};
  let hasText = false, hasThought = false, hasTool = false, thinkingMs = 0;
  for (const field of pbFields(body) ?? []) {
    if (field.no === 1 && field.bytes && field.bytes.length > 0) hasText = true;
    else if (field.no === 3 && field.bytes && field.bytes.length > 0) hasThought = true;
    else if (field.no === 7 && field.bytes && field.bytes.length > 0) hasTool = true;
    else if (field.no === 11 && field.bytes) thinkingMs = pbDurationMs(field.bytes);
  }
  return {
    ...(thinkingMs > 0 ? { thinkingMs } : {}),
    ...(hasText ? { hasText } : {}),
    ...(hasThought ? { hasThought } : {}),
    ...(hasTool ? { hasTool } : {}),
  };
}

/**
 * 计算一步生成的真实首字延迟、流式输出速度与整包均速（与 agent-proxy 透明转发的「扣掉首包排队等待」口径对齐）：
 * - 服务端整包缓冲的工具调用（服务端拼完 JSON 一次性返回）：
 *   field 11 (time_to_first_token = viewable_at - created_at) 吞入了排队、思考与整段生成耗时，
 *   field 12 (streaming_duration) 只剩几十到两百多毫秒收尾（可见输出表观速度 > 500 T/s，或流式段 < 300ms 且总输出表观速度 > 500 T/s / 纯工具包）。
 *   此类不记首字延迟；仅在输出够长（>= 300 Token，生成耗时占主导）时用总耗时算 tokensPerSec，短整包记入 avgTokensPerSec（明细标 ≈，不污染速度走势）。
 * - 正常流式回复（streamingMs >= 300ms）：
 *   优先依据 step_payload 原生 thinking_duration（field 11）精准区分思考阶段：
 *   1. 纯文本回复且思考结束后仍有 >= 500ms / >= 30 Token 的正文流式段：直接按「可见输出 ÷ 思考后流式时长」计速，完全剥离思考偏差；
 *   2. 思考在首字前静默完成（thinkingDuration - rawFirstTokenMs < 200ms）：按「可见输出 ÷ streamingMs」计速；
 *   3. 思考在首字后仍在 streamingMs 内持续流式推送：按「总输出 ÷ streamingMs」计速，避免误扣 reasoning 导致速度腰斩。
 */
export function antigravityStreamMetrics(
  output: number,
  reasoning: number,
  rawFirstTokenMs: number,
  streamingMs: number,
  totalMs: number,
  opts?: AgyStreamMetricsOpts,
): AgyStreamMetrics {
  const outNoThink = Math.max(0, output - reasoning);
  const thinkingMs = opts?.thinkingMs ?? 0;
  const hasText = Boolean(opts?.hasText);
  const hasThought = Boolean(opts?.hasThought);
  const hasTool = Boolean(opts?.hasTool);

  const visRate = streamingMs > 0 ? outNoThink / (streamingMs / 1000) : Infinity;
  const allRate = streamingMs > 0 ? output / (streamingMs / 1000) : Infinity;
  const isBufferedToolCall =
    rawFirstTokenMs > 0 && (
      (outNoThink >= 20 && (streamingMs <= 0 || visRate > 500)) ||
      (output >= 20 && streamingMs > 0 && streamingMs < 300 && (allRate > 500 || (hasTool && !hasText && !hasThought)))
    );

  const firstTokenMs = isBufferedToolCall || rawFirstTokenMs <= 0 ? 0 : rawFirstTokenMs;
  let tokensPerSec = 0;

  if (!isBufferedToolCall && streamingMs >= 300 && streamingMs <= 30 * 60_000) {
    const sec = streamingMs / 1000;
    const allStreamTps = output / sec;
    const visStreamTps = outNoThink / sec;
    if (reasoning > 0 && thinkingMs > 0) {
      const thinkInStreamMs = Math.max(0, Math.min(streamingMs, thinkingMs - rawFirstTokenMs));
      const postThinkMs = Math.max(0, totalMs - thinkingMs);
      if (hasText && !hasTool && outNoThink >= 30 && postThinkMs >= 500) {
        const postTps = outNoThink / (postThinkMs / 1000);
        if (postTps <= 500) tokensPerSec = Math.round(postTps * 10) / 10;
      }
      if (!tokensPerSec) {
        if (thinkInStreamMs < 200) {
          if (outNoThink >= 20 && visStreamTps <= 500) tokensPerSec = Math.round(visStreamTps * 10) / 10;
          else if (output >= 20 && allStreamTps <= 500) tokensPerSec = Math.round(allStreamTps * 10) / 10;
        } else {
          if (output >= 20 && allStreamTps <= 500) tokensPerSec = Math.round(allStreamTps * 10) / 10;
          else if (outNoThink >= 20 && visStreamTps <= 500) tokensPerSec = Math.round(visStreamTps * 10) / 10;
        }
      }
    } else if (
      reasoning > 0 &&
      outNoThink >= 20 &&
      (allStreamTps > 260 || (rawFirstTokenMs >= 2000 && streamingMs <= 3000 && visStreamTps >= 25 && allStreamTps > visStreamTps * 2.2))
    ) {
      if (visStreamTps <= 500) tokensPerSec = Math.round(visStreamTps * 10) / 10;
    } else if (output >= 20 && allStreamTps <= 500) {
      tokensPerSec = Math.round(allStreamTps * 10) / 10;
    }
  } else if (output >= 300 && totalMs >= 500 && totalMs <= 30 * 60_000) {
    const tps = output / (totalMs / 1000);
    if (tps <= 500) tokensPerSec = Math.round(tps * 10) / 10;
  }

  let avgTokensPerSec = 0;
  if (!tokensPerSec && output >= 20 && totalMs >= 500 && totalMs <= 30 * 60_000) {
    const avg = output / (totalMs / 1000);
    if (avg > 0 && avg <= 500) avgTokensPerSec = Math.round(avg * 10) / 10;
  }

  return { firstTokenMs, tokensPerSec, avgTokensPerSec };
}

/**
 * 读一个对话库里 from（含）之后完成了的模型回复。
 * next：下次从哪一步接着读——停在第一步还没完成的回复上，等它写完再算。
 * models：这次遇到、known 里还没有的数字 id 的型号。
 */
export function readAntigravityGenerations(file: string, from: number, known: Record<string, AgyModel>, now = Date.now()): { rows: AgyGeneration[]; next: number; total: number; models: Record<string, AgyModel> } {
  return withDb(file, (db) => {
    const stepStmt = db.prepare("select idx, step_type, status, metadata from steps where idx >= ? order by idx");
    const total = (db.prepare("select coalesce(max(idx), -1) + 1 as n from steps").get() as { n: number }).n;
    const rows: AgyGeneration[] = [];
    const models: Record<string, AgyModel> = {};
    const genModel = prepareOptional(db, "select data from gen_metadata where idx = ?");
    const stepPayloadStmt = prepareOptional(db, "select step_payload from steps where idx = ?");
    let autoStep = 0;
    if (from > 0) {
      try {
        const lastUser = (db.prepare("select coalesce(max(idx), -1) as u from steps where step_type = 14 and idx < ?").get(from) as { u: number }).u;
        autoStep = (db.prepare("select count(*) as c from steps where step_type = 15 and idx > ? and idx < ?").get(lastUser, from) as { c: number }).c;
      } catch { /* 旧表结构缺失时从 0 起算 */ }
    }
    let next = from;
    for (const rawStep of stepStmt.iterate(from)) {
      const step = rawStep as { idx: number; step_type: number; status: number; metadata: Uint8Array | null };
      if (step.step_type === 14) {
        autoStep = 0;
        next = step.idx + 1;
        continue;
      }
      const meta = toBuf(step.metadata);
      if (step.step_type === MODEL_REPLY && STEP_OPEN.has(step.status)) {
        const startedAt = pbTime(pbMessage(meta, 1));
        // 还在生成：停在这里。很久以前就卡住的（崩溃、被杀）跳过
        if (!startedAt || now - startedAt < STUCK_MS) break;
      }
      next = step.idx + 1;
      // 完成的、中途取消 / 出错的都看：被打断之前已经生成的那部分也写了用量，确实花掉了
      if (step.step_type !== MODEL_REPLY || STEP_OPEN.has(step.status) || !meta) continue;
      const usage = pbMessage(meta, 9);
      const input = pbNumber(usage, 2), output = pbNumber(usage, 3), cacheRead = pbNumber(usage, 5), cacheWrite = pbNumber(usage, 4);
      if (!usage || (!input && !output && !cacheRead && !cacheWrite)) continue;
      const modelId = pbNumber(usage, 1) || pbNumber(meta, 11);
      const key = String(modelId);
      const genInfo = pbMessage(meta, 20);
      // Protobuf3 中 gen_idx = 0（对话第 1 次生成，对应 gen_metadata.idx = 0）属于默认标量值，序列化时省略 field 3；
      // 只要 genInfo 子消息存在，pbNumber(genInfo, 3) 读出的 0 就是合法的 gen_idx = 0。
      const genIdx = genInfo ? pbNumber(genInfo, 3) : -1;
      const genData = genIdx >= 0 ? (genModel?.get(genIdx) as { data?: Uint8Array } | undefined)?.data : undefined;
      const genBuf = toBuf(genData);
      const genParsed = genBuf ? parseGenerationMeta(genBuf) : null;
      const existingModel = modelId ? (models[key] ?? known[key]) : undefined;
      const stepModel = stepModelFromGen(genParsed, existingModel);
      if (modelId && !known[key] && !models[key] && stepModel) {
        models[key] = stepModel;
      } else if (modelId && genParsed?.label && existingModel && !existingModel.label && (!genParsed.enum || !existingModel.enum || genParsed.enum === existingModel.enum)) {
        models[key] = { ...existingModel, label: genParsed.label };
      }
      const startAt = pbTime(pbMessage(meta, 1));
      const viewableAt = pbTime(pbMessage(meta, 6));
      const finishedAt = pbTime(pbMessage(meta, 7));
      const completedAt = pbTime(pbMessage(meta, 8));
      const rawFirstTokenMs = genParsed?.firstTokenMs ?? 0;
      const streamingMs = genParsed?.streamingMs ?? 0;
      const hasStreamTiming = rawFirstTokenMs > 0 || streamingMs > 0;
      const at = hasStreamTiming
        ? (finishedAt || completedAt || viewableAt || startAt)
        : (viewableAt || finishedAt || completedAt || startAt);
      if (!at) continue;
      const totalMs = hasStreamTiming
        ? (rawFirstTokenMs > 0 && streamingMs > 0
            ? rawFirstTokenMs + streamingMs
            : finishedAt && startAt && finishedAt > startAt
              ? finishedAt - startAt
              : completedAt && startAt && completedAt > startAt
                ? completedAt - startAt
                : rawFirstTokenMs || streamingMs)
        : 0;
      const reasoning = pbNumber(usage, 9);
      const rawPayload = hasStreamTiming
        ? (stepPayloadStmt?.get(step.idx) as { step_payload?: Uint8Array } | undefined)?.step_payload
        : undefined;
      const bodyHints = parseReplyBodyHints(toBuf(rawPayload));
      const { firstTokenMs, tokensPerSec, avgTokensPerSec } = antigravityStreamMetrics(
        output,
        reasoning,
        rawFirstTokenMs,
        streamingMs,
        totalMs,
        bodyHints,
      );
      const thinkingMs = bodyHints.thinkingMs && bodyHints.thinkingMs > 0 ? bodyHints.thinkingMs : 0;
      const responseId = pbString(usage, 11);
      const messageId = pbString(usage, 7);
      const requestId = genParsed?.requestId || messageId;
      const returned = genParsed?.rawModel || (stepModel ?? known[key] ?? models[key])?.model;
      autoStep += 1;
      rows.push({
        step: step.idx, at, startAt, modelId,
        ...(stepModel ? { genModel: stepModel } : {}),
        input: input + cacheRead + cacheWrite, output, cacheRead, cacheWrite, reasoning,
        ...(responseId ? { responseId } : {}),
        ...(requestId ? { requestId } : {}),
        ...(returned ? { returned } : {}),
        ...(firstTokenMs > 0 ? { firstTokenMs } : {}),
        ...(totalMs > 0 ? { totalMs } : {}),
        ...(tokensPerSec > 0 ? { tokensPerSec } : {}),
        ...(avgTokensPerSec > 0 ? { avgTokensPerSec } : {}),
        ...(thinkingMs > 0 ? { thinkingMs } : {}),
        ...(autoStep >= 2 ? { autoStep } : {}),
      });
    }
    return { rows, next, total, models };
  });
}

/* ---------------- 会话管理：对话内容 ---------------- */

/*
 * steps.step_payload（protobuf）：1 步骤类型、4 状态、5 同 metadata 列，再加按类型不同的一段：
 * - 14 用户输入：19.2 是用户说的话；
 * - 15 模型回复：20.1 回复正文（只在给文字时有）、20.3 思考过程（不展示）、20.7 工具调用（可重复：1 调用 id、2 工具名、3 参数 JSON）；
 * - 101 系统/子代理消息（子代理与 Swarm worker 的任务分配与消息板通知，无 14）：114.4.4 净正文（回退 114.1），114.4.3 发送方 ID，114.3 消息类型；
 * - 132 工具执行：5.4.1 调用 id、5.4.2 工具名、5.4.3 参数；140.2.1 是交给模型的工具输出。
 * 其他类型（检查点、摘要之类）不展示。
 */
export type AgyStepUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
};

export type AgyStep =
  | { kind: "user"; at: number; text: string }
  | { kind: "incoming"; at: number; text: string; senderId?: string; messageKind?: string }
  | {
      kind: "reply";
      at: number;
      text: string;
      modelId: number;
      genModel?: AgyModel;
      tools: { id: string; name: string; args: string }[];
      usage?: AgyStepUsage;
      durationMs?: number;
      firstTokenMs?: number;
      tokensPerSec?: number;
      avgTokensPerSec?: number;
      thinkingMs?: number;
      isMeasured?: boolean;
    }
  | { kind: "result"; at: number; id: string; name: string; args: string; output: string; error: boolean };

export const USER_INPUT = 14, INCOMING_MSG = 101, TOOL_STEP = 132;

/** models：回复里用到的型号（数字 id → 型号名和 model_enum，从 gen_metadata 读，每个型号读一条）。 */
export function readAntigravityConversation(
  file: string,
  opts?: { includeIncoming?: boolean },
): { steps: AgyStep[]; models: Record<string, AgyModel> } {
  return withDb(file, (db) => {
    const out: AgyStep[] = [];
    const models: Record<string, AgyModel> = {};
    const genModel = prepareOptional(db, "select data from gen_metadata where idx = ?");
    const sql = opts?.includeIncoming
      ? "select idx, step_type, status, metadata, step_payload from steps where step_type in (14, 15, 101, 132) order by idx"
      : "select idx, step_type, status, metadata, step_payload from steps where step_type in (14, 15, 132) order by idx";
    const stepStmt = db.prepare(sql);
    for (const rawRow of stepStmt.iterate()) {
      const row = rawRow as { idx: number; step_type: number; status: number; metadata: Uint8Array | null; step_payload: Uint8Array | null };
      if (!row.step_payload && !row.metadata) continue;
      const payload = toBuf(row.step_payload) ?? undefined;
      const payloadMeta = pbMessage(payload, 5);
      const colMeta = toBuf(row.metadata) ?? undefined;
      const meta = payloadMeta ?? colMeta;
      const at = pbTime(pbMessage(payloadMeta, 1)) || pbTime(pbMessage(colMeta, 1));
      if (row.step_type === USER_INPUT) {
        if (!payload) continue;
        const text = pbString(pbMessage(payload, 19), 2);
        if (text.trim()) out.push({ kind: "user", at, text });
      } else if (row.step_type === INCOMING_MSG) {
        if (!payload) continue;
        const body = pbMessage(payload, 114);
        const structured = pbMessage(body, 4);
        const text = pbString(structured, 4) || pbString(body, 1);
        const senderId = pbString(structured, 3) || undefined;
        const messageKind = pbString(body, 3) || undefined;
        if (text.trim()) {
          out.push({
            kind: "incoming",
            at,
            text,
            ...(senderId ? { senderId } : {}),
            ...(messageKind ? { messageKind } : {}),
          });
        }
      } else if (row.step_type === MODEL_REPLY) {
        const body = pbMessage(payload, 20);
        const tools = (pbFields(body ?? Buffer.alloc(0)) ?? []).filter((field) => field.no === 7 && field.bytes).map((field) => ({ id: pbString(field.bytes, 1), name: pbString(field.bytes, 2), args: pbString(field.bytes, 3) }));
        const text = pbString(body, 1);
        const u = pbMessage(payloadMeta, 9) ?? pbMessage(colMeta, 9);
        const rawInput = pbNumber(u, 2), output = pbNumber(u, 3), cacheWrite = pbNumber(u, 4), cacheRead = pbNumber(u, 5), reasoning = pbNumber(u, 9);
        const input = rawInput + cacheRead + cacheWrite;
        const usage: AgyStepUsage | undefined = u && (input > 0 || output > 0) ? { input, output, cacheRead, cacheWrite, reasoning } : undefined;
        const modelId = pbNumber(u, 1) || pbNumber(payloadMeta, 11) || pbNumber(colMeta, 11);

        const genInfo = pbMessage(payloadMeta, 20) ?? pbMessage(colMeta, 20);
        const genIdx = genInfo ? pbNumber(genInfo, 3) : -1;
        const genData = genIdx >= 0 ? (genModel?.get(genIdx) as { data?: Uint8Array } | undefined)?.data : undefined;
        const genBuf = toBuf(genData);
        const genParsed = genBuf ? parseGenerationMeta(genBuf) : null;
        const existingModel = modelId ? models[String(modelId)] : undefined;
        const stepModel = stepModelFromGen(genParsed, existingModel);

        if (modelId) {
          const key = String(modelId);
          if (!models[key] && stepModel) {
            models[key] = stepModel;
          } else if (genParsed?.label && models[key] && !models[key].label && (!genParsed.enum || !models[key].enum || genParsed.enum === models[key].enum)) {
            models[key].label = genParsed.label;
          }
        }

        const startAt = pbTime(pbMessage(payloadMeta, 1)) || pbTime(pbMessage(colMeta, 1));
        const viewableAt = pbTime(pbMessage(payloadMeta, 6)) || pbTime(pbMessage(colMeta, 6));
        const finishedAt = pbTime(pbMessage(payloadMeta, 7)) || pbTime(pbMessage(colMeta, 7));
        const completedAt = pbTime(pbMessage(payloadMeta, 8)) || pbTime(pbMessage(colMeta, 8));

        const rawFirstTokenMs = genParsed?.firstTokenMs ?? 0;
        const streamingMs = genParsed?.streamingMs ?? 0;
        const hasStreamTiming = rawFirstTokenMs > 0 || streamingMs > 0;
        const replyAt = hasStreamTiming
          ? (finishedAt || completedAt || viewableAt || startAt)
          : (viewableAt || finishedAt || completedAt || startAt);

        const totalMs = hasStreamTiming
          ? (rawFirstTokenMs > 0 && streamingMs > 0
              ? rawFirstTokenMs + streamingMs
              : finishedAt && startAt && finishedAt > startAt
                ? finishedAt - startAt
                : completedAt && startAt && completedAt > startAt
                  ? completedAt - startAt
                  : rawFirstTokenMs || streamingMs)
          : (finishedAt && startAt && finishedAt > startAt
              ? finishedAt - startAt
              : completedAt && startAt && completedAt > startAt
                ? completedAt - startAt
                : 0);

        const bodyHints = parseReplyBodyHints(payload);
        const metrics = antigravityStreamMetrics(output, reasoning, rawFirstTokenMs, streamingMs, totalMs, bodyHints);
        const firstTokenMs = metrics.firstTokenMs > 0 ? metrics.firstTokenMs : undefined;
        const tokensPerSec = metrics.tokensPerSec > 0 ? metrics.tokensPerSec : undefined;
        const avgTokensPerSec = metrics.avgTokensPerSec > 0 ? metrics.avgTokensPerSec : undefined;
        const thinkingMs = bodyHints.thinkingMs && bodyHints.thinkingMs > 0 ? bodyHints.thinkingMs : undefined;

        if (text.trim() || tools.length || usage) {
          out.push({
            kind: "reply",
            at: replyAt || at,
            text,
            modelId,
            ...(stepModel ? { genModel: stepModel } : {}),
            tools,
            ...(usage ? { usage } : {}),
            ...(totalMs > 0 ? { durationMs: totalMs, isMeasured: true } : {}),
            ...(firstTokenMs != null ? { firstTokenMs } : {}),
            ...(tokensPerSec != null ? { tokensPerSec } : {}),
            ...(avgTokensPerSec != null ? { avgTokensPerSec } : {}),
            ...(thinkingMs != null ? { thinkingMs } : {}),
          });
        }
      } else if (row.step_type === TOOL_STEP) {
        if (!payload) continue;
        const call = pbMessage(meta, 4);
        const id = pbString(call, 1);
        if (!id) continue;
        out.push({ kind: "result", at, id, name: pbString(call, 2), args: pbString(call, 3), output: pbString(pbMessage(pbMessage(payload, 140), 2), 1), error: row.status === STEP.ERROR });
      }
    }
    return { steps: out, models };
  });
}

export type AgySummary = {
  id: string;
  title: string;
  workspace?: string;
  nested: boolean;
  parentId?: string;
  nestingDepth?: number;
  agentName?: string;
  status?: string;
  killed?: boolean;
  at: number;
};

export type AgySwarmMember = {
  name: string;
  conversationId: string;
  coordinatorId: string;
  role: string;
  phase?: string;
  wakeMode?: string;
  desiredState?: string;
  workspaceMode?: string;
  killed?: boolean;
  model?: string;
  updatedAt?: number;
};

export type AgySubagentDescriptor = {
  conversationId: string;
  parentId: string;
  typeName?: string;
  role?: string;
  state?: string;
  spawnStepIndex?: number;
};

export type AgySwarmMeta = {
  swarmsByCoordinator: Map<string, { id: string; title: string; members: AgySwarmMember[]; updatedAt: number }>;
  workerById: Map<string, { coordinatorId: string; swarmTitle: string; member: AgySwarmMember }>;
  descriptorsById: Map<string, AgySubagentDescriptor>;
};

const jsonStatCache = new Map<string, { size: number; mtimeMs: number; value: unknown }>();
function readJsonCached(file: string): { value: unknown; mtimeMs: number } | null {
  let stat: fs.Stats | undefined;
  try { stat = fs.statSync(file, { throwIfNoEntry: false }); } catch { return null; }
  if (!stat) return null;
  const hit = lruGet(jsonStatCache, file);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return { value: hit.value, mtimeMs: stat.mtimeMs };
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    lruSet(jsonStatCache, file, { size: stat.size, mtimeMs: stat.mtimeMs, value }, 2048);
    return { value, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/** 缓存各 brain 目录下实际包含 swarm 或 subagents 的子目录清单，避免每次扫描遍历数百个普通对话目录。 */
const brainIndexCache = new Map<string, { mtimeMs: number; scannedAt: number; activeIds: string[] }>();
const BRAIN_INDEX_TTL_MS = 30_000;

/** 缓存各 conversations 目录的文件名集合与陈旧历史 DB 的上次检查时间，避免每次扫描对上百个历史子库反复 existsSync/statSync。 */
const convFilesCache = new Map<string, { mtimeMs: number; scannedAt: number; files: Set<string> }>();
const staleDbCache = new Map<string, { mtimeMs: number; checkedAt: number }>();
const CONV_FILES_TTL_MS = 5_000;
const STALE_DB_TTL_MS = 30_000;
/**
 * 两小时窗口里「早已停下」的对话库：摘要行的 last_modified_time 没变、库本身也 COLD_STAMP_AGE_MS 以上没动时，
 * COLD_STAMP_TTL_MS 内直接复用上次的大小/改动时间，不再每轮对库和 -wal 各 stat 一次（几百个对话时每轮要上千次 stat）。
 * 桌宠的 fs.watch 看到对应 .db / .db-wal 变了会立刻调用 noteAntigravityFileChanged 让这一条失效；在跑的对话永远现查。
 * key 用小写路径（Windows 路径不分大小写，摘要里的 id 和文件名大小写可能不一致）。
 */
const coldStampCache = new Map<string, { stamp: { size: number; mtimeMs: number }; sumAt: number; checkedAt: number }>();
const COLD_STAMP_TTL_MS = 15_000;
const COLD_STAMP_AGE_MS = 10 * 60_000;

/** 当 fs.watch 捕捉到 swarm/members.json 或 subagents/*.json 变动时立刻清空缓存。 */
export function invalidateAntigravitySwarmCache(): void {
  brainIndexCache.clear();
  convFilesCache.clear();
  staleDbCache.clear();
  coldStampCache.clear();
}

/** fs.watch 看到某个对话库（.db / .db-wal / .db-shm）变了：丢掉它的冷 stamp 与陈旧标记，下一轮扫描现查。 */
export function noteAntigravityFileChanged(file: string): void {
  const db = file.replace(/-(wal|shm)$/i, "");
  if (!/\.db$/i.test(db)) return;
  coldStampCache.delete(db.toLowerCase());
  staleDbCache.delete(db);
}

function convFileSet(dir: string, now: number): Set<string> | null {
  const convDir = path.join(dir, "conversations");
  let stat: fs.Stats;
  try { stat = fs.statSync(convDir); } catch { return null; }
  const hit = convFilesCache.get(convDir);
  if (hit && hit.mtimeMs === stat.mtimeMs && now - hit.scannedAt < CONV_FILES_TTL_MS) return hit.files;
  let names: string[];
  try { names = fs.readdirSync(convDir); } catch { return null; }
  const files = new Set<string>();
  for (const name of names) if (name.endsWith(".db")) files.add(name.toLowerCase());
  if (convFilesCache.size > 16) convFilesCache.clear();
  convFilesCache.set(convDir, { mtimeMs: stat.mtimeMs, scannedAt: now, files });
  return files;
}

function activeBrainIds(brainDir: string, now: number): string[] {
  let dirStat: fs.Stats;
  try { dirStat = fs.statSync(brainDir); } catch { return []; }
  const cached = brainIndexCache.get(brainDir);
  if (cached && cached.mtimeMs === dirStat.mtimeMs && now - cached.scannedAt < BRAIN_INDEX_TTL_MS) {
    return cached.activeIds;
  }
  let entries: string[];
  try { entries = fs.readdirSync(brainDir); } catch { return []; }
  const activeIds: string[] = [];
  for (const bid of entries) {
    const sysDir = path.join(brainDir, bid, ".system_generated");
    if (fs.existsSync(path.join(sysDir, "swarm", "members.json")) || fs.existsSync(path.join(sysDir, "subagents"))) {
      activeIds.push(bid);
    }
  }
  if (brainIndexCache.size > 16) brainIndexCache.clear();
  brainIndexCache.set(brainDir, { mtimeMs: dirStat.mtimeMs, scannedAt: now, activeIds });
  return activeIds;
}

/**
 * 读取 Antigravity 的 Swarm 成员清单（`brain/<coord>/.system_generated/swarm/members.json`）
 * 与子代理描述（`brain/<parent>/.system_generated/subagents/<id>.json`）。按目录 mtime + 文件 size/mtime 多级缓存。
 */
export function antigravitySwarmMeta(dir: string | string[] = antigravityDirs(), filterRoots?: Set<string>): AgySwarmMeta {
  const dirs = Array.isArray(dir) ? dir : [dir];
  const now = Date.now();
  const swarmsByCoordinator = new Map<string, { id: string; title: string; members: AgySwarmMember[]; updatedAt: number }>();
  const workerById = new Map<string, { coordinatorId: string; swarmTitle: string; member: AgySwarmMember }>();
  const descriptorsById = new Map<string, AgySubagentDescriptor>();

  const filterLower = filterRoots ? new Set([...filterRoots].map((s) => s.toLowerCase())) : undefined;
  for (const root of dirs) {
    const brainDir = path.join(root, "brain");
    const entries = filterRoots ? [...filterRoots] : activeBrainIds(brainDir, now);
    for (const bid of entries) {
      const bidLower = bid.toLowerCase();
      if (filterLower && !filterLower.has(bidLower)) continue;
      const sysDir = path.join(brainDir, bid, ".system_generated");
      const membersFile = path.join(sysDir, "swarm", "members.json");
      const parsedMembers = readJsonCached(membersFile);
      if (parsedMembers && parsedMembers.value && typeof parsedMembers.value === "object") {
        const obj = parsedMembers.value as Record<string, unknown>;
        const title = typeof obj.title === "string" ? obj.title.trim() : "";
        const rawMembers = obj.members;
        const memberEntries: [string, Record<string, unknown>][] = Array.isArray(rawMembers)
          ? rawMembers.flatMap((item, idx) => (item && typeof item === "object" ? [[String((item as Record<string, unknown>).name || idx), item as Record<string, unknown>]] : []))
          : rawMembers && typeof rawMembers === "object"
            ? Object.entries(rawMembers as Record<string, unknown>).flatMap(([k, v]) => (v && typeof v === "object" ? [[k, v as Record<string, unknown>]] : []))
            : [];
        const members: AgySwarmMember[] = [];
        for (const [nameKey, m] of memberEntries) {
          const cid = typeof m.conversation_id === "string" && m.conversation_id.trim()
            ? m.conversation_id.trim()
            : typeof m.conversationId === "string" && m.conversationId.trim()
              ? m.conversationId.trim()
              : "";
          if (!cid) continue;
          const name = typeof m.name === "string" && m.name.trim() ? m.name.trim() : nameKey;
          const role = typeof m.role === "string" && m.role.trim() ? m.role.trim() : (cid.toLowerCase() === bidLower ? "coordinator" : "worker");
          const member: AgySwarmMember = {
            name,
            conversationId: cid,
            coordinatorId: bid,
            role,
            ...(typeof m.phase === "string" && m.phase ? { phase: m.phase } : {}),
            ...(typeof m.wake_mode === "string" && m.wake_mode ? { wakeMode: m.wake_mode } : {}),
            ...(typeof m.desired_state === "string" && m.desired_state ? { desiredState: m.desired_state } : {}),
            ...(typeof m.workspace_mode === "string" && m.workspace_mode ? { workspaceMode: m.workspace_mode } : {}),
            ...(m.killed === true ? { killed: true } : {}),
            ...(typeof m.model === "string" && m.model ? { model: m.model } : {}),
            updatedAt: parsedMembers.mtimeMs,
          };
          members.push(member);
          if (cid.toLowerCase() !== bidLower) {
            const prevWorker = workerById.get(cid.toLowerCase());
            if (!prevWorker || parsedMembers.mtimeMs >= (prevWorker.member.updatedAt ?? 0)) {
              workerById.set(cid.toLowerCase(), { coordinatorId: bid, swarmTitle: title, member });
            }
          }
        }
        const prevSwarm = swarmsByCoordinator.get(bidLower);
        if (!prevSwarm || parsedMembers.mtimeMs >= prevSwarm.updatedAt) {
          swarmsByCoordinator.set(bidLower, { id: bid, title, members, updatedAt: parsedMembers.mtimeMs });
        }
      }

      const subDir = path.join(sysDir, "subagents");
      let subNames: string[];
      try { subNames = fs.readdirSync(subDir); } catch { continue; }
      for (const name of subNames) {
        if (!name.endsWith(".json")) continue;
        const parsedSub = readJsonCached(path.join(subDir, name));
        if (!parsedSub || !parsedSub.value || typeof parsedSub.value !== "object") continue;
        const sObj = parsedSub.value as Record<string, unknown>;
        const cid = typeof sObj.conversationId === "string" && sObj.conversationId.trim()
          ? sObj.conversationId.trim()
          : name.slice(0, -".json".length);
        if (!cid) continue;
        const desc = (sObj.subagentDescriptor && typeof sObj.subagentDescriptor === "object"
          ? sObj.subagentDescriptor
          : null) as Record<string, unknown> | null;
        descriptorsById.set(cid.toLowerCase(), {
          conversationId: cid,
          parentId: bid,
          ...(typeof desc?.typeName === "string" && desc.typeName.trim() ? { typeName: desc.typeName.trim() } : {}),
          ...(typeof desc?.role === "string" && desc.role.trim() ? { role: desc.role.trim() } : {}),
          ...(typeof sObj.state === "string" && sObj.state.trim() ? { state: sObj.state.trim() } : {}),
          ...(typeof sObj.spawnStepIndex === "number" ? { spawnStepIndex: sObj.spawnStepIndex } : {}),
        });
      }
    }
  }

  return { swarmsByCoordinator, workerById, descriptorsById };
}

/** 对话列表库里的标题、工作区（合并 Antigravity IDE 与 Antigravity CLI 两个目录的摘要库）。删掉的对话不在这里。读不到返回 null。 */
export function antigravitySummaries(dir: string | string[] = antigravityDirs()): Map<string, AgySummary> | null {
  const dirs = Array.isArray(dir) ? dir : [dir];
  const merged = new Map<string, AgySummary>();
  let anyLoaded = false;
  for (const root of dirs) {
    const file = path.join(root, "conversation_summaries.db");
    if (!fs.existsSync(file)) continue;
    try {
      withDb(file, (db) => {
        const parentLinks = new Map<string, string>();
        const parentStmt = prepareOptional(db, "select conversation_id, parent_id from conversation_parents");
        if (parentStmt) {
          for (const pRow of parentStmt.all() as { conversation_id?: string; parent_id?: string }[]) {
            const cid = typeof pRow.conversation_id === "string" ? pRow.conversation_id.trim() : "";
            const pid = typeof pRow.parent_id === "string" ? pRow.parent_id.trim() : "";
            if (cid && pid) parentLinks.set(cid.toLowerCase(), pid);
          }
        }
        const summaryRows = db.prepare("select * from conversation_summaries").all() as Record<string, unknown>[];
        // 必须等 conversation_summaries 查询成功后才标记 anyLoaded，防止 SQLITE_BUSY 返回空 Map 误清空全部会话
        anyLoaded = true;
        for (const row of summaryRows) {
          const id = typeof row.conversation_id === "string" ? row.conversation_id : "";
          if (!id) continue;
          const rawParent = typeof row.parent_conversation_id === "string" && row.parent_conversation_id.trim()
            ? row.parent_conversation_id.trim()
            : parentLinks.get(id.toLowerCase());
          const parentId = rawParent || undefined;
          const nestingDepth = Number(row.nesting_depth || 0);
          const agentName = typeof row.agent_name === "string" && row.agent_name.trim() ? row.agent_name.trim() : undefined;
          const status = typeof row.status === "string" && row.status.trim() ? row.status.trim() : undefined;
          const killed = Number(row.killed || 0) !== 0;
          const item: AgySummary = {
            id,
            title: typeof row.title === "string" ? row.title : "",
            workspace: workspacePath(typeof row.workspace_uris === "string" ? row.workspace_uris : null),
            nested: nestingDepth > 0 || Boolean(parentId),
            ...(parentId ? { parentId } : {}),
            ...(nestingDepth > 0 ? { nestingDepth } : {}),
            ...(agentName ? { agentName } : {}),
            ...(status ? { status } : {}),
            ...(killed ? { killed: true } : {}),
            at: sqliteTime(row.last_modified_time),
          };
          const prev = merged.get(id);
          if (!prev) {
            merged.set(id, item);
          } else {
            const newer = item.at >= prev.at;
            const nextParent = newer ? (item.parentId || prev.parentId) : (prev.parentId || item.parentId);
            const nextDepth = Math.max(prev.nestingDepth ?? 0, item.nestingDepth ?? 0);
            const nextAgent = newer ? (item.agentName || prev.agentName) : (prev.agentName || item.agentName);
            const nextStatus = newer ? (item.status || prev.status) : (prev.status || item.status);
            const nextKilled = newer ? (item.killed ?? prev.killed) : (prev.killed ?? item.killed);
            merged.set(id, {
              id,
              title: newer ? (item.title || prev.title) : (prev.title || item.title),
              workspace: newer ? (item.workspace || prev.workspace) : (prev.workspace || item.workspace),
              nested: prev.nested || item.nested,
              ...(nextParent ? { parentId: nextParent } : {}),
              ...(nextDepth > 0 ? { nestingDepth: nextDepth } : {}),
              ...(nextAgent ? { agentName: nextAgent } : {}),
              ...(nextStatus ? { status: nextStatus } : {}),
              ...(nextKilled ? { killed: true } : {}),
              at: Math.max(prev.at, item.at),
            });
          }
        }
      });
    } catch { /* 某个库正在写时跳过 */ }
  }
  return anyLoaded ? merged : null;
}

/** 按主对话 ID 归集所有子代（含多层嵌套子代理，如 teamwork 协调器再派出的子代理）的 .db 文件路径。 */
export function antigravitySubagentFilesByRoot(
  summaries: Map<string, AgySummary> | null = antigravitySummaries(),
  convFiles: string[] = antigravityConversationFiles(),
): Map<string, string[]> {
  const byRoot = new Map<string, string[]>();
  if (!summaries || !summaries.size) return byRoot;
  const fileById = new Map<string, string>();
  for (const file of convFiles) {
    fileById.set(path.basename(file, ".db").toLowerCase(), file);
  }
  const rootOf = (id: string): string => {
    let cur = id;
    const seen = new Set<string>([cur]);
    for (let depth = 0; depth < 8; depth++) {
      const parentId = summaries.get(cur)?.parentId;
      if (!parentId || seen.has(parentId)) break;
      seen.add(parentId);
      cur = parentId;
    }
    return cur;
  };
  for (const [id, sum] of summaries) {
    if (!sum.nested && !sum.parentId) continue;
    const rootId = rootOf(id);
    if (!rootId || rootId === id) continue;
    const file = fileById.get(id.toLowerCase());
    if (!file) continue;
    const list = byRoot.get(rootId) ?? [];
    list.push(file);
    byRoot.set(rootId, list);
  }
  return byRoot;
}

export type AgySubagentUsageRow = {
  at: number;
  modelId: number;
  genModel?: AgyModel;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  durationMs?: number;
};

const subagentUsageCache = new Map<string, { size: number; mtimeMs: number; rows: AgySubagentUsageRow[]; models: Record<string, AgyModel> }>();

/**
 * 轻量读取子代（subagent）对话库中的模型调用用量与耗时：
 * 只扫 steps.metadata，同型号数字 ID 仅查一次 gen_metadata，避免反序列化数百兆完整提示词。
 */
export function readAntigravitySubagentUsage(file: string, known: Record<string, AgyModel>): AgySubagentUsageRow[] {
  const stamp = antigravityStamp(file);
  if (stamp) {
    const hit = lruGet(subagentUsageCache, file);
    if (hit && hit.size === stamp.size && hit.mtimeMs === stamp.mtimeMs) {
      for (const [k, v] of Object.entries(hit.models)) {
        if (!known[k]) known[k] = v;
        else if (v.label && !known[k].label) known[k] = { ...known[k], label: v.label };
      }
      return hit.rows;
    }
  }
  const localModels: Record<string, AgyModel> = {};
  const rows = withDb(file, (db) => {
    const out: AgySubagentUsageRow[] = [];
    const genModel = prepareOptional(db, "select data from gen_metadata where idx = ?");
    const stepStmt = db.prepare("select status, metadata, case when metadata is null then step_payload else null end as step_payload from steps where step_type = 15 order by idx");
    for (const rawRow of stepStmt.iterate()) {
      const row = rawRow as { status: number; metadata: Uint8Array | null; step_payload: Uint8Array | null };
      const meta = toBuf(row.metadata) ?? pbMessage(toBuf(row.step_payload), 5);
      if (!meta) continue;
      const usage = pbMessage(meta, 9);
      if (!usage) continue;
      const rawInput = pbNumber(usage, 2);
      const output = pbNumber(usage, 3);
      const cacheWrite = pbNumber(usage, 4);
      const cacheRead = pbNumber(usage, 5);
      const reasoning = pbNumber(usage, 9);
      const input = rawInput + cacheRead + cacheWrite;
      if (input <= 0 && output <= 0) continue;
      const modelId = pbNumber(usage, 1) || pbNumber(meta, 11);
      const key = modelId ? String(modelId) : "";
      const cur = key ? (localModels[key] ?? known[key]) : undefined;
      const genInfo = pbMessage(meta, 20);
      const genIdx = genInfo ? pbNumber(genInfo, 3) : -1;
      const genData = genIdx >= 0 ? (genModel?.get(genIdx) as { data?: Uint8Array } | undefined)?.data : undefined;
      const genBuf = toBuf(genData);
      const genParsed = genBuf ? parseGenerationMeta(genBuf) : null;
      const stepModel = stepModelFromGen(genParsed, cur);
      if (key) {
        if (stepModel && !cur) {
          localModels[key] = stepModel;
          known[key] = stepModel;
        } else if (genParsed?.label && cur && !cur.label && (!genParsed.enum || !cur.enum || genParsed.enum === cur.enum)) {
          const entry: AgyModel = { ...cur, label: genParsed.label };
          localModels[key] = entry;
          known[key] = entry;
        } else if (cur && !localModels[key]) {
          localModels[key] = cur;
        }
      }
      const startAt = pbTime(pbMessage(meta, 1));
      const viewableAt = pbTime(pbMessage(meta, 6));
      const finishedAt = pbTime(pbMessage(meta, 7));
      const completedAt = pbTime(pbMessage(meta, 8));
      const at = finishedAt || completedAt || viewableAt || startAt;
      const endAt = finishedAt || completedAt || viewableAt;
      const durationMs = endAt && startAt && endAt > startAt && endAt - startAt <= 30 * 60_000
        ? endAt - startAt
        : undefined;
      out.push({
        at,
        modelId,
        ...(stepModel ? { genModel: stepModel } : {}),
        input,
        output,
        cacheRead,
        cacheWrite,
        reasoning,
        ...(durationMs ? { durationMs } : {}),
      });
    }
    return out;
  });
  if (stamp) {
    lruSet(subagentUsageCache, file, { size: stamp.size, mtimeMs: stamp.mtimeMs, rows, models: localModels }, 1024);
  }
  return rows;
}

function removeCliConversationLocal(dir: string, id: string): boolean {
  let removed = false;
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = path.join(dir, "conversations", `${id}.db${suffix}`);
    if (fs.existsSync(file)) {
      try { fs.rmSync(file, { force: true }); if (!suffix) removed = true; } catch { /* 忽略 */ }
    }
  }
  for (const target of [
    path.join(dir, "brain", id),
    path.join(dir, "annotations", `${id}.pbtxt`),
    path.join(dir, "presence", `${id}.lock`),
  ]) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  return removed;
}

function removeSummaryRow(dir: string, id: string) {
  const file = path.join(dir, "conversation_summaries.db");
  if (!fs.existsSync(file)) return;
  try {
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (file: string) => Database };
    const db = new DatabaseSync(file);
    try {
      db.exec?.("PRAGMA busy_timeout = 500;");
      (db.prepare("delete from conversation_summaries where conversation_id = ?") as Statement & { run?: (...args: unknown[]) => unknown }).run?.(id);
    } finally {
      db.close();
    }
  } catch { /* 正在写或只读时跳过 */ }
}

/** 请开着的 Antigravity 删掉一段对话（或直接清理 Antigravity CLI 的本机对话记录）。 */
export async function deleteAntigravityConversation(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("对话 ID 不对");
  const ideRoot = antigravityDir();
  const cliRoot = antigravityCliDir();
  const inCli = fs.existsSync(path.join(cliRoot, "conversations", `${id}.db`));
  // 从桌面端导入 CLI 的对话两边都有：只删 CLI 那份的话，桌面端那份还会出现在列表里
  const sameRoot = path.resolve(cliRoot).toLowerCase() === path.resolve(ideRoot).toLowerCase();
  const inIde = !sameRoot && fs.existsSync(path.join(ideRoot, "conversations", `${id}.db`));
  const needIde = inIde || !inCli;
  const ideHub = needIde ? antigravityHub([ideRoot]) : null;
  if (needIde && !ideHub) throw new Error("Antigravity 没有在运行。请先打开 Antigravity，再删除这段对话（由它自己删，它的对话列表才不会留下坏掉的记录）");
  if (ideHub) {
    await postLocal(ideHub.httpPort, ideHub.csrfToken, "DeleteCascadeTrajectory", { cascadeId: id });
  }
  if (inCli) {
    const cliHub = !sameRoot ? antigravityHub([cliRoot]) : ideHub ? null : antigravityHub([cliRoot]);
    if (cliHub && (!ideHub || cliHub.httpPort !== ideHub.httpPort)) {
      try {
        await postLocal(cliHub.httpPort, cliHub.csrfToken, "DeleteCascadeTrajectory", { cascadeId: id });
      } catch { /* CLI 对话下面会兜底本地清理 */ }
    }
    const subFiles = antigravitySubagentFilesByRoot().get(id) ?? [];
    const targetIds = new Set<string>([id, ...subFiles.map((f) => path.basename(f, ".db"))]);
    for (const targetId of targetIds) {
      removeCliConversationLocal(cliRoot, targetId);
      removeSummaryRow(cliRoot, targetId);
    }
  }
  forgetCliImport(id);
}

/* ---------------- 桌面端对话交给 Antigravity CLI 继续 ---------------- */

/*
 * 桌面端（~/.gemini/antigravity）和 CLI（~/.gemini/antigravity-cli）各用各的数据目录。
 * `agy.exe --conversation <桌面端对话 ID>` 只在 CLI 自己的目录里找对话库，找不到就开一个同 ID 的空白对话：
 * 「在终端里继续」「回复对话」都看不到历史（2026-11-09 用 agy acp 的 session/load 核过：默认目录 0 条历史，
 * 把对话库快照进 CLI 目录后能回放全部消息和工具调用）。
 * `--app-data-dir antigravity` 虽然也能读到，但 CLI 会往桌面端目录写自己的状态文件和日志，所以不用。
 *
 * 做法：启动 CLI 前用 SQLite 在线备份把桌面端对话库快照成 CLI 目录里的同名对话库（桌面端开着、正在写也能拿到一致的快照），
 * 顺带复制 brain/<id>（计划、产物）和 annotations/<id>.pbtxt。导入记录在 TokenPulse 数据目录里：
 * - CLI 那份还没有新步骤、桌面端又往前走了 → 重新导入；
 * - CLI 那份已经有新步骤（用户在 CLI 里接着聊过）→ 保留 CLI 那份，不覆盖；
 * - CLI 里有同 ID、但不是 TokenPulse 导入的对话库，步数比桌面端少（多半是之前恢复出来的空白对话）→ 先备份到
 *   TokenPulse 数据目录，再导入。
 */
type CliImportMark = { steps: number; ide: { size: number; mtimeMs: number }; at: number };
const cliImportFile = () => dataFile("antigravity-cli-imports.json");

function forgetCliImport(id: string) {
  const marks = readJson<Record<string, CliImportMark>>(cliImportFile(), {});
  if (!marks[id]) return;
  delete marks[id];
  try { writeJson(cliImportFile(), marks); } catch { /* 记录写不进去不影响删除 */ }
}

function stepCount(file: string): number {
  return withDb(file, (db) => Number((db.prepare("SELECT COUNT(*) AS c FROM steps").get() as { c?: number } | undefined)?.c ?? 0));
}

function busyError(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

export type CliImportResult = "native" | "current" | "kept" | "imported";
const cliImportsInFlight = new Map<string, Promise<CliImportResult>>();

/**
 * 让 Antigravity CLI 能接着这段对话：桌面端的对话导入（或刷新）到 CLI 目录。
 * native：CLI 自己的对话或桌面端没有这段，什么都不用做；current：CLI 里已经是最新导入；
 * kept：CLI 里那份已经接着聊过，保留它；imported：刚导入/刷新。
 */
export async function prepareAntigravityCliConversation(id: string): Promise<CliImportResult> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("对话 ID 不对");
  const key = id.toLowerCase();
  const existing = cliImportsInFlight.get(key);
  if (existing) return existing;
  const pending = importCliConversation(id);
  cliImportsInFlight.set(key, pending);
  try {
    return await pending;
  } finally {
    cliImportsInFlight.delete(key);
  }
}

async function importCliConversation(id: string): Promise<CliImportResult> {
  const ideRoot = antigravityDir();
  const cliRoot = antigravityCliDir();
  if (path.resolve(ideRoot) === path.resolve(cliRoot)) return "native";
  const ideFile = path.join(ideRoot, "conversations", `${id}.db`);
  const cliFile = path.join(cliRoot, "conversations", `${id}.db`);
  const ideStamp = antigravityStamp(ideFile);
  if (!ideStamp) return "native";

  const marks = readJson<Record<string, CliImportMark>>(cliImportFile(), {});
  const mark = marks[id];
  const ideSteps = stepCount(ideFile);
  let backup = false;
  if (fs.existsSync(cliFile)) {
    let cliSteps: number;
    try { cliSteps = stepCount(cliFile); } catch { cliSteps = -1; /* 坏掉或不是对话库：当成需要导入 */ }
    if (mark) {
      if (cliSteps > mark.steps) return "kept";
      const ideMoved = ideSteps !== mark.steps || ideStamp.size !== mark.ide.size || ideStamp.mtimeMs !== mark.ide.mtimeMs;
      if (!ideMoved && cliSteps === mark.steps) return "current";
    } else {
      if (cliSteps >= ideSteps) return "kept";
      backup = cliSteps > 0;
    }
  }

  const tmp = path.join(cliRoot, "conversations", `${id}.db.tokenpulse-${process.pid}.tmp`);
  fs.mkdirSync(path.dirname(cliFile), { recursive: true });
  const sqlite = require("node:sqlite") as { DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => Database; backup: (db: Database, file: string) => Promise<number> };
  let importedSteps: number;
  try {
    const src = new sqlite.DatabaseSync(ideFile, { readOnly: true });
    try { await sqlite.backup(src, tmp); } finally { src.close(); }
    // 以快照里的步数为准：读步数到做快照之间桌面端可能又写了几步
    importedSteps = stepCount(tmp);
    const sidecars = ["-wal", "-shm"];
    const staged: { from: string; to: string }[] = [];
    try {
      if (fs.existsSync(cliFile)) {
        if (backup) {
          const archive = path.join(dataFile("antigravity-cli-backup"), `${id}-${Date.now()}.db`);
          fs.mkdirSync(path.dirname(archive), { recursive: true });
          for (const suffix of ["", ...sidecars]) if (fs.existsSync(cliFile + suffix)) fs.copyFileSync(cliFile + suffix, archive + suffix);
        }
        for (const suffix of sidecars) {
          const from = cliFile + suffix;
          const to = `${cliFile}.tokenpulse-old-${process.pid}${suffix}`;
          if (!fs.existsSync(from)) continue;
          fs.renameSync(from, to);
          staged.push({ from, to });
        }
      }
      // 保留旧主库，直至新快照原子替换成功。
      fs.renameSync(tmp, cliFile);
    } catch (error) {
      let restoreFailed = false;
      for (const { from, to } of staged.reverse()) {
        try { fs.renameSync(to, from); } catch { restoreFailed = true; }
      }
      if (restoreFailed) throw new Error("导入失败且无法恢复对话库的附属文件，原文件保存在对话目录的 tokenpulse-old 副本中", { cause: error });
      if (busyError(error)) throw new Error("这段对话正在 Antigravity CLI 里打开，请先关掉那个终端再试", { cause: error });
      throw error;
    }
    for (const { to } of staged) {
      try { fs.rmSync(to, { force: true }); } catch { /* 新库已安装，旧附属文件不影响读取 */ }
    }
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
  }

  // 计划、产物等附件：CLI 里没有就复制；重新导入时用桌面端的新版本覆盖
  const brain = path.join(ideRoot, "brain", id);
  if (fs.existsSync(brain)) {
    try { fs.cpSync(brain, path.join(cliRoot, "brain", id), { recursive: true, force: true, errorOnExist: false }); } catch { /* 附件复制失败不影响继续对话 */ }
  }
  const note = path.join(ideRoot, "annotations", `${id}.pbtxt`);
  const cliNote = path.join(cliRoot, "annotations", `${id}.pbtxt`);
  if (fs.existsSync(note) && !fs.existsSync(cliNote)) {
    try { fs.mkdirSync(path.dirname(cliNote), { recursive: true }); fs.copyFileSync(note, cliNote); } catch { /* 同上 */ }
  }

  const updated = readJson<Record<string, CliImportMark>>(cliImportFile(), {});
  updated[id] = { steps: importedSteps, ide: ideStamp, at: Date.now() };
  writeJson(cliImportFile(), updated);
  return "imported";
}

/* ---------------- 桌宠：哪些对话在跑 ---------------- */

/*
 * conversation_summaries 每个对话一行：status 是运行状态（CascadeRunStatus：IDLE 空闲、RUNNING 在跑、CANCELING 正在停、BUSY 忙），
 * not_fully_idle、last_modified_time、last_user_input_time、title、workspace_uris、nesting_depth（> 0 是派出去的子代理）。
 * 在跑的对话再看最后几步：有一步在等批准（WAITING）就是在等你；最后一步是别的步骤（工具、命令）在跑就是在跑工具；否则在想。
 * 空闲了看最后一次模型回复的状态：出错（ERROR）、被停（CANCELED / INTERRUPTED）、正常。
 */
export type AgyChildActivity = {
  id: string;
  name: string;
  status: string;
  running: boolean;
  phase?: "thinking" | "tool" | "waiting";
  tool?: string;
  ask?: string;
  updatedAt: number;
  swarm?: boolean;
};

export type AgyActivity = {
  id: string; title: string; workspace?: string;
  running: boolean; nested: boolean;
  /** 顶层会话自身是否在运行（区别于仅靠子代理 / Swarm worker 拉起）。 */
  ownRunning?: boolean;
  /** 这个主对话下正在跑的子代理个数。 */
  subagents?: number;
  agentName?: string;
  swarm?: boolean;
  swarmTitle?: string;
  /** Swarm 协调器最近一步是已完成的 swarm_wait（正在等蜂群消息，尚未完成总目标回复用户）。 */
  swarmWaiting?: boolean;
  /** 最近一步仍是工具/脚本完成、后台任务唤醒（step_type=101）或仅含工具调用的模型回复，任务尚未产出最终回复。 */
  pendingContinuation?: boolean;
  /** Swarm 中尚未被 kill 的非 monitor 工作子代理个数。 */
  swarmAliveWorkers?: number;
  children?: AgyChildActivity[];
  /** 最后改动的时间（毫秒）；since：最后一次用户输入。 */
  at: number; since: number;
  phase?: "thinking" | "tool" | "waiting";
  ended?: "ok" | "interrupted" | "error";
  tool?: string;
  ask?: { id: string; name: string; args: string; at: number };
};

/** 「2026-11-06 04:52:41.2188695+00:00」这种：空格换 T，秒的小数留三位。0001-01-01 等无效零值按 0 算。 */
export function sqliteTime(value: unknown): number {
  if (typeof value !== "string" || !value) return 0;
  const text = value.trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
  const parsed = Date.parse(text);
  return parsed > 0 ? parsed : 0;
}

type PhaseResult = Pick<AgyActivity, "phase" | "ended" | "tool" | "ask" | "swarmWaiting" | "pendingContinuation"> & { open?: boolean };
const phaseCache = new Map<string, { size: number; mtimeMs: number; value: PhaseResult }>();
/** 阶段缓存上限：要盖住「两小时内动过」的全部对话（实测有人同时有 400+ 个），留足余量。每条只是几个短字段。 */
const PHASE_CACHE_MAX = 2048;
/**
 * 空闲的主对话多久没动就不再读它最后几步：比桌宠「刚完成」列表保留的 10 分钟（agent-activity 的 RECENT_MS）多留 5 分钟。
 * 更早停下的对话，phase / ended 不会再被用到（不在「刚完成」里，也不会再从在跑变成完成）。
 */
const PHASE_IDLE_MS = 15 * 60_000;
/** 最近还在跑的对话（小写 id → 最后一次看到在跑的时间）：它停下的那一轮一定要读最后几步，才能分出正常完成 / 出错 / 中断。 */
const recentRunning = new Map<string, number>();
const RECENT_RUNNING_MAX = 4096;
const summaryRowsCache = new Map<string, { size: number; mtimeMs: number; rows: Record<string, unknown>[]; parentRows: { conversation_id?: string; parent_id?: string }[] }>();
const LIGHT_SUMMARY_SQL = "select conversation_id, title, last_modified_time, workspace_uris, status, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed, last_user_input_time from conversation_summaries";

/** 一个对话最后几步：在跑的时候分出在想 / 工具 / 等你；空闲了看最后一次回复怎么结束的，并识别脚本/工具刚结束等待续跑的中间态。 */
export function conversationPhase(file: string, knownStamp?: { size: number; mtimeMs: number } | null): PhaseResult {
  const stamp = knownStamp !== undefined ? knownStamp : antigravityStamp(file);
  if (!stamp) return {};
  const hit = lruGet(phaseCache, file);
  if (hit && hit.size === stamp.size && hit.mtimeMs === stamp.mtimeMs) return hit.value;
  try {
    const value = withDb(file, (db) => {
      const stmt = prepareOptional(db, "select step_type, status, metadata, case when step_type = 15 then step_payload else null end as step_payload from steps order by idx desc limit 12")
        ?? db.prepare("select step_type, status, metadata from steps order by idx desc limit 12");
      const tail = stmt.all() as { step_type: number; status: number; metadata?: Uint8Array | null; step_payload?: Uint8Array | null }[];
      if (!tail.length) return {};
      const open = tail.some((step) => STEP_OPEN.has(step.status));
      let tool: string | undefined;
      let ask: AgyActivity["ask"] | undefined;
      for (const step of tail) {
        if (step.step_type !== TOOL_STEP || !STEP_OPEN.has(step.status)) continue;
        const meta = toBuf(step.metadata);
        const call = pbMessage(meta, 4);
        const id = pbString(call, 1);
        const name = pbString(call, 2);
        const args = pbString(call, 3);
        if (name && !tool) tool = name;
        if (name === "ask_question" || name === "ask_user_question" || name === "exit_plan_mode") {
          ask = { id: id || "ask", name, args, at: pbTime(pbMessage(meta, 1)) || stamp.mtimeMs };
          break;
        }
      }
      const phase = (ask || tail.some((step) => step.status === STEP.WAITING)) ? "waiting" as const
        : tail.some((step) => step.step_type === MODEL_REPLY && STEP_OPEN.has(step.status)) ? "thinking" as const
        : tail.some((step) => step.step_type !== MODEL_REPLY && STEP_OPEN.has(step.status)) ? "tool" as const
        : "thinking" as const;
      const reply = tail.find((step) => step.step_type === MODEL_REPLY && !STEP_OPEN.has(step.status));
      const ended = reply?.status === STEP.ERROR ? "error" as const : reply && (reply.status === STEP.CANCELED || reply.status === STEP.INTERRUPTED) ? "interrupted" as const : "ok" as const;
      let swarmWaiting = false;
      let pendingContinuation = false;
      if (!open) {
        const latestSignal = tail.find((step) => step.step_type === TOOL_STEP || step.step_type === MODEL_REPLY || step.step_type === USER_INPUT || step.step_type === INCOMING_MSG);
        if (latestSignal) {
          const stopped = latestSignal.status === STEP.CANCELED || latestSignal.status === STEP.INTERRUPTED;
          if (latestSignal.step_type === TOOL_STEP && !stopped) {
            const latestName = pbString(pbMessage(toBuf(latestSignal.metadata), 4), 2);
            if (latestName === "swarm_wait" && latestSignal.status !== STEP.ERROR) swarmWaiting = true;
            else pendingContinuation = true; // 脚本/工具刚完成，模型尚未接着输出给用户的最终回复
          } else if ((latestSignal.step_type === INCOMING_MSG || latestSignal.step_type === USER_INPUT) && !stopped) {
            pendingContinuation = true; // 后台脚本/子代理完成通知或用户提问刚写入，即将唤醒下一轮模型调用
          } else if (latestSignal.step_type === MODEL_REPLY && !stopped && latestSignal.status !== STEP.ERROR) {
            const hints = parseReplyBodyHints(toBuf(latestSignal.step_payload));
            if (hints.hasTool) pendingContinuation = true; // 模型发起了工具调用（即使附带过渡文字），不是最终回复
          }
        }
      }
      return {
        phase, ended, open,
        ...(tool ? { tool } : {}),
        ...(ask ? { ask } : {}),
        ...(swarmWaiting ? { swarmWaiting: true } : {}),
        ...(pendingContinuation ? { pendingContinuation: true } : {}),
      };
    });
    lruSet(phaseCache, file, { size: stamp.size, mtimeMs: stamp.mtimeMs, value }, PHASE_CACHE_MAX);
    return value;
  } catch { return {}; }
}

function readSingleDirActivity(since: number, dir: string, allDirs: string[], now: number, sharedSwarmMeta?: AgySwarmMeta): AgyActivity[] {
  const file = path.join(dir, "conversation_summaries.db");
  const sumStamp = antigravityStamp(file);
  if (!sumStamp) return [];
  let rows: Record<string, unknown>[] = [];
  let parentRows: { conversation_id?: string; parent_id?: string }[] = [];
  const cachedSum = summaryRowsCache.get(file);
  if (cachedSum && cachedSum.size === sumStamp.size && cachedSum.mtimeMs === sumStamp.mtimeMs) {
    rows = cachedSum.rows;
    parentRows = cachedSum.parentRows;
  } else {
    try {
      withDb(file, (db) => {
        const lightStmt = prepareOptional(db, LIGHT_SUMMARY_SQL);
        rows = (lightStmt ? lightStmt.all() : db.prepare("select * from conversation_summaries").all()) as Record<string, unknown>[];
        const pStmt = prepareOptional(db, "select conversation_id, parent_id from conversation_parents");
        if (pStmt) parentRows = pStmt.all() as { conversation_id?: string; parent_id?: string }[];
      });
      if (summaryRowsCache.size > 8) summaryRowsCache.clear();
      summaryRowsCache.set(file, { size: sumStamp.size, mtimeMs: sumStamp.mtimeMs, rows, parentRows });
    } catch { return []; }
  }

  const swarmMeta = sharedSwarmMeta ?? antigravitySwarmMeta(allDirs);
  const parentOf = new Map<string, string>();
  const canonicalId = new Map<string, string>();
  const rawById = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = typeof row.conversation_id === "string" ? row.conversation_id : "";
    if (!id) continue;
    const lower = id.toLowerCase();
    canonicalId.set(lower, id);
    rawById.set(lower, row);
    const parentId = typeof row.parent_conversation_id === "string" ? row.parent_conversation_id.trim() : "";
    if (parentId) parentOf.set(lower, parentId);
  }
  for (const pRow of parentRows) {
    const cid = typeof pRow.conversation_id === "string" ? pRow.conversation_id.trim() : "";
    const pid = typeof pRow.parent_id === "string" ? pRow.parent_id.trim() : "";
    if (!cid || !pid) continue;
    const lower = cid.toLowerCase();
    if (!canonicalId.has(lower)) canonicalId.set(lower, cid);
    if (!parentOf.has(lower)) parentOf.set(lower, pid);
  }
  for (const [wid, info] of swarmMeta.workerById) {
    if (!canonicalId.has(wid)) canonicalId.set(wid, info.member.conversationId);
    if (!parentOf.has(wid)) parentOf.set(wid, info.coordinatorId);
  }
  for (const [sid, desc] of swarmMeta.descriptorsById) {
    if (!canonicalId.has(sid)) canonicalId.set(sid, desc.conversationId);
    if (!parentOf.has(sid)) parentOf.set(sid, desc.parentId);
  }

  const rootOf = (id: string) => {
    let cur = id;
    const seen = new Set<string>([cur.toLowerCase()]);
    for (let depth = 0; depth < 8; depth++) {
      const next = parentOf.get(cur.toLowerCase());
      if (!next || seen.has(next.toLowerCase())) break;
      seen.add(next.toLowerCase());
      cur = canonicalId.get(next.toLowerCase()) ?? next;
    }
    return cur;
  };
  const dirFileSets = new Map<string, Set<string> | null>();
  const hasConvFile = (baseDir: string, id: string) => {
    let set = dirFileSets.get(baseDir);
    if (set === undefined) {
      set = convFileSet(baseDir, now);
      dirFileSets.set(baseDir, set);
    }
    return set ? set.has(id.toLowerCase() + ".db") : false;
  };
  const resolveConvDb = (id: string) => {
    if (hasConvFile(dir, id)) return path.join(dir, "conversations", id + ".db");
    for (const other of allDirs) {
      if (other === dir) continue;
      if (hasConvFile(other, id)) return path.join(other, "conversations", id + ".db");
    }
    return "";
  };
  /** coldSumAt：传了就允许对「摘要行没变、库也很久没动」的空闲对话复用冷 stamp（见 coldStampCache）；在跑的对话不传，永远现查。 */
  const stampFor = (db: string, skipStaleCheck: boolean, coldSumAt?: number): { size: number; mtimeMs: number } | null => {
    if (!db) return null;
    if (!skipStaleCheck) {
      const stale = lruGet(staleDbCache, db);
      if (stale && now - stale.checkedAt < STALE_DB_TTL_MS && stale.mtimeMs < since - 30 * 60_000) return null;
    }
    const coldKey = coldSumAt !== undefined ? db.toLowerCase() : "";
    if (coldKey) {
      const cold = lruGet(coldStampCache, coldKey);
      if (cold && cold.sumAt === coldSumAt && cold.checkedAt <= now && now - cold.checkedAt < COLD_STAMP_TTL_MS && now - cold.stamp.mtimeMs > COLD_STAMP_AGE_MS) return cold.stamp;
    }
    const stamp = antigravityStamp(db);
    if (stamp && stamp.mtimeMs < since - 30 * 60_000) {
      lruSet(staleDbCache, db, { mtimeMs: stamp.mtimeMs, checkedAt: now }, 8192);
    } else if (stamp) {
      staleDbCache.delete(db);
    }
    if (coldKey) {
      if (stamp) lruSet(coldStampCache, coldKey, { stamp, sumAt: coldSumAt as number, checkedAt: now }, 8192);
      else coldStampCache.delete(coldKey);
    }
    return stamp;
  };

  // Synthesize rows for active/recent nested DBs present in conversation_parents or swarm/members.json but not yet in conversation_summaries.
  const allRows: Record<string, unknown>[] = [...rows];
  for (const [lower, parentId] of parentOf) {
    if (rawById.has(lower)) continue;
    const cid = canonicalId.get(lower) ?? lower;
    const swarmWorker = swarmMeta.workerById.get(lower);
    const desc = swarmMeta.descriptorsById.get(lower);
    const swarmWorking = Boolean(
      swarmWorker &&
      !swarmWorker.member.killed &&
      swarmWorker.member.wakeMode === "working" &&
      swarmWorker.member.phase !== "STOPPED" &&
      swarmWorker.member.phase !== "KILLED" &&
      now - (swarmWorker.member.updatedAt ?? 0) <= 5 * 60_000,
    );
    const db = resolveConvDb(cid);
    const stamp = stampFor(db, swarmWorking);
    if (!swarmWorking && (!stamp || stamp.mtimeMs < since)) continue;
    const synthetic: Record<string, unknown> = {
      conversation_id: cid,
      parent_conversation_id: parentId,
      nesting_depth: 1,
      agent_name: swarmWorker?.member.name || desc?.typeName || "",
      status: "",
      killed: swarmWorker?.member.killed ? 1 : 0,
      last_modified_time: "",
      last_user_input_time: "",
    };
    rawById.set(lower, synthetic);
    allRows.push(synthetic);
  }

  // Count known children per root so IDLE coordinators with not_fully_idle=1 only stay running when children are actually active.
  const knownChildrenByRoot = new Map<string, number>();
  for (const [lower] of parentOf) {
    const rootId = rootOf(canonicalId.get(lower) ?? lower).toLowerCase();
    if (rootId && rootId !== lower) {
      knownChildrenByRoot.set(rootId, (knownChildrenByRoot.get(rootId) ?? 0) + 1);
    }
  }

  const byId = new Map<string, AgyActivity>();
  const ownActiveById = new Map<string, boolean>();
  const activeSubs = new Map<string, { items: AgyActivity[]; at: number }>();

  const buildItem = (row: Record<string, unknown>, forceKeep = false): AgyActivity | null => {
    const id = typeof row.conversation_id === "string" ? row.conversation_id : "";
    if (!id) return null;
    const lower = id.toLowerCase();
    const sumAt = sqliteTime(row.last_modified_time);
    const status = String(row.status ?? "");
    const parentId = parentOf.get(lower) || "";
    const nested = Number(row.nesting_depth || 0) > 0 || Boolean(parentId);
    const swarmWorker = swarmMeta.workerById.get(lower);
    const swarmCoord = !nested ? swarmMeta.swarmsByCoordinator.get(lower) : undefined;
    const desc = swarmMeta.descriptorsById.get(lower);
    const killed = Number(row.killed || 0) !== 0 || swarmWorker?.member.killed === true;
    const notFullyIdle = Number(row.not_fully_idle || 0) !== 0;
    const statusRunning = !killed && /RUNNING|BUSY|CANCELING/.test(status);
    // Antigravity Swarm 的 swarm_wait(mentions_only=false) 会写入 wake_mode="anything"（如内置 monitor）
    const swarmParked = Boolean(
      swarmWorker &&
      !killed &&
      (swarmWorker.member.wakeMode === "mentions" || swarmWorker.member.wakeMode === "all" || swarmWorker.member.wakeMode === "anything"),
    );
    const swarmWorking = Boolean(
      swarmWorker &&
      !killed &&
      swarmWorker.member.wakeMode === "working" &&
      swarmWorker.member.phase !== "STOPPED" &&
      swarmWorker.member.phase !== "KILLED",
    );
    const sumRunning = !killed && (statusRunning || (notFullyIdle && !swarmParked));

    const needStamp =
      forceKeep ||
      sumRunning ||
      swarmWorking ||
      sumAt >= since ||
      (!killed && sumAt === 0) ||
      Boolean(swarmWorker) ||
      Boolean(swarmCoord);
    const db = needStamp ? resolveConvDb(id) : "";
    // 在跑 / Swarm 相关 / 强制保留的对话现查；其余空闲对话允许复用冷 stamp
    const hot = forceKeep || statusRunning || sumRunning || swarmWorking || notFullyIdle || Boolean(swarmWorker) || Boolean(swarmCoord);
    const stamp = needStamp ? stampFor(db, forceKeep || sumRunning || swarmWorking || sumAt >= since, hot ? undefined : sumAt) : null;
    if (!forceKeep && !sumRunning && !swarmWorking && sumAt < since && (!stamp || stamp.mtimeMs < since)) return null;

    // 主对话：在跑、刚动过（PHASE_IDLE_MS 内）或上一轮还在跑的才读最后几步；两小时窗口里早已停下的历史对话不再每轮打开对话库
    const lastRunAt = recentRunning.get(lower) ?? 0;
    const shouldReadPhase = Boolean(
      stamp && (
        statusRunning ||
        sumRunning ||
        swarmWorking ||
        (!killed && now - stamp.mtimeMs <= 5 * 60_000) ||
        (!nested && (
          forceKeep ||
          notFullyIdle ||
          Boolean(swarmCoord) ||
          now - Math.max(sumAt, stamp.mtimeMs) <= PHASE_IDLE_MS ||
          now - lastRunAt <= PHASE_IDLE_MS
        ))
      ),
    );
    const info = shouldReadPhase ? conversationPhase(db, stamp) : {};
    const dbOpen = !killed && !!info.open && !!stamp && (
      ((sumAt === 0 || stamp.mtimeMs > sumAt + 1000) && now - stamp.mtimeMs < 60_000) ||
      (info.phase === "tool" && (notFullyIdle || sumAt === 0 || stamp.mtimeMs >= sumAt - 5000) && now - stamp.mtimeMs < 10 * 60_000)
    );

    let running: boolean;
    let ownActive = false;
    if (!nested) {
      ownActive = statusRunning || dbOpen || (!killed && notFullyIdle && Boolean(info.open));
      const hasManagedChildren = Boolean(swarmCoord) || (knownChildrenByRoot.get(lower) ?? 0) > 0;
      if (!statusRunning && !killed && notFullyIdle && !info.open && hasManagedChildren) {
        // IDLE coordinator with not_fully_idle=1: stays idle unless an active child/worker wakes it below.
        running = false;
      } else {
        running = sumRunning || dbOpen;
      }
    } else {
      const swarmAt = Math.max(sumAt, stamp?.mtimeMs ?? 0, swarmWorker?.member.updatedAt ?? 0);
      const swarmActive = swarmWorking && swarmAt > 0 && now - swarmAt <= 5 * 60_000;
      running = statusRunning || dbOpen || swarmActive || (!swarmParked && sumRunning);
      ownActive = running;
    }

    const at = running
      ? Math.max(sumAt, stamp?.mtimeMs ?? 0, swarmWorker && swarmWorking ? (swarmWorker.member.updatedAt ?? 0) : 0)
      : (sumAt || stamp?.mtimeMs || 0);
    if (!forceKeep && !running && at < since && !swarmCoord) return null;

    const agentName = (typeof row.agent_name === "string" && row.agent_name.trim()) || swarmWorker?.member.name || desc?.typeName || undefined;
    const swarmAliveWorkers = !nested && swarmCoord
      ? swarmCoord.members.filter((m) =>
        m.conversationId.toLowerCase() !== lower &&
        m.role !== "coordinator" &&
        m.name.toLowerCase() !== "monitor" &&
        !m.killed &&
        m.phase !== "KILLED" &&
        m.phase !== "STOPPED" &&
        m.desiredState !== "KILLED",
      ).length
      : undefined;
    const { open: _open, swarmWaiting: rawSwarmWaiting, pendingContinuation: rawPendingCont, ...phase } = info;
    const swarmWaiting = !nested && Boolean(swarmCoord) && Boolean(rawSwarmWaiting);
    const pendingContinuation = !nested && !running && Boolean(rawPendingCont);
    ownActiveById.set(lower, ownActive);
    return {
      id,
      at,
      since: sqliteTime(row.last_user_input_time) || sumAt || at,
      running,
      ...(!nested ? { ownRunning: ownActive } : {}),
      title: typeof row.title === "string" ? row.title : "",
      workspace: workspacePath(typeof row.workspace_uris === "string" ? row.workspace_uris : null),
      nested,
      ...(agentName ? { agentName } : {}),
      ...(swarmCoord || swarmWorker ? { swarm: true } : {}),
      ...(swarmCoord?.title ? { swarmTitle: swarmCoord.title } : swarmWorker?.swarmTitle ? { swarmTitle: swarmWorker.swarmTitle } : {}),
      ...(swarmWaiting ? { swarmWaiting: true } : {}),
      ...(pendingContinuation ? { pendingContinuation: true } : {}),
      ...(swarmAliveWorkers !== undefined ? { swarmAliveWorkers } : {}),
      ...phase,
    };
  };

  const isSwarmMonitor = (lowerId: string) => {
    const w = swarmMeta.workerById.get(lowerId);
    return Boolean(w && w.member.role !== "coordinator" && w.member.name.toLowerCase() === "monitor");
  };

  for (const row of allRows) {
    const item = buildItem(row);
    if (!item) continue;
    byId.set(item.id.toLowerCase(), item);
    if (item.nested && item.running && now - item.at <= 5 * 60_000) {
      // Swarm 内置 monitor 每 ~3 分钟按定时器/板消息醒来巡检：不单独唤醒空闲协调器、不触发假完成音（仅明确提问时保留）
      if (isSwarmMonitor(item.id.toLowerCase()) && !item.ask && item.phase !== "waiting") continue;
      const rootId = rootOf(item.id);
      const rootLower = rootId.toLowerCase();
      if (rootId && rootLower !== item.id.toLowerCase()) {
        const prev = activeSubs.get(rootLower) ?? { items: [], at: 0 };
        prev.items.push(item);
        prev.at = Math.max(prev.at, item.at);
        activeSubs.set(rootLower, prev);
      }
    }
  }

  for (const [rootLower, sub] of activeSubs) {
    let root = byId.get(rootLower);
    if (!root) {
      const rawRoot = rawById.get(rootLower);
      if (rawRoot) {
        root = buildItem(rawRoot, true) ?? undefined;
        if (root) byId.set(rootLower, root);
      }
    }
    if (root && !root.nested) {
      const sortedSubs = [...sub.items].sort((a, b) => {
        const aw = a.phase === "waiting" || a.ask ? 1 : 0;
        const bw = b.phase === "waiting" || b.ask ? 1 : 0;
        return bw - aw || b.at - a.at;
      });
      const children: AgyChildActivity[] = sortedSubs.map((child) => ({
        id: child.id,
        name: child.agentName || child.title || child.id.slice(0, 8),
        status: child.phase === "waiting" || child.ask ? "waiting" : child.running ? "working" : "idle",
        running: child.running,
        ...(child.phase ? { phase: child.phase } : {}),
        ...(child.tool ? { tool: child.tool } : {}),
        ...(child.ask ? { ask: child.ask.name } : {}),
        updatedAt: child.at,
        ...(child.swarm ? { swarm: true } : {}),
      }));
      root.subagents = children.length;
      root.children = children;
      root.at = Math.max(root.at, sub.at);
      if (!root.swarm && children.some((c) => c.swarm)) root.swarm = true;
      if (!root.swarmTitle) {
        const swarmTitle = sortedSubs.find((c) => c.swarmTitle)?.swarmTitle;
        if (swarmTitle) root.swarmTitle = swarmTitle;
      }

      const waitingChild = sortedSubs.find((c) => c.phase === "waiting" || c.ask);
      const toolChild = sortedSubs.find((c) => c.phase === "tool");
      const rootOwnActive = ownActiveById.get(rootLower) === true;

      if (!rootOwnActive) {
        root.running = true;
        root.ended = undefined;
        if (waitingChild) {
          root.phase = "waiting";
          if (waitingChild.tool) root.tool = waitingChild.tool;
          if (!root.ask && waitingChild.ask) root.ask = waitingChild.ask;
        } else if (toolChild) {
          root.phase = "tool";
          if (toolChild.tool) root.tool = toolChild.tool;
        } else {
          // Idle Swarm coordinator propagates worker thinking; non-swarm root waiting on a background subagent reports tool.
          root.phase = root.swarm ? "thinking" : "tool";
        }
      } else if (waitingChild?.ask && !root.ask) {
        root.ask = waitingChild.ask;
        root.phase = "waiting";
        if (waitingChild.tool) root.tool = waitingChild.tool;
      }
    }
  }

  for (const [lower, item] of byId) if (item.running) { recentRunning.delete(lower); recentRunning.set(lower, now); }
  for (const [lower, at] of recentRunning) if (now - at > PHASE_IDLE_MS || recentRunning.size > RECENT_RUNNING_MAX) recentRunning.delete(lower);

  // Drop idle swarm coordinators whose last update is older than `since` when no workers are active.
  return [...byId.values()].filter((item) => item.running || item.at >= since);
}

/** 最近 since 之后动过的对话（支持同时扫描 Antigravity IDE 与 Antigravity CLI 目录并按会话合并）。读不到返回空的。 */
export function readAntigravityActivity(since: number, dir: string | string[] = antigravityDirs(), now = Date.now()): AgyActivity[] {
  const dirs = Array.isArray(dir) ? dir : [dir];
  const sharedSwarm = antigravitySwarmMeta(dirs);
  if (dirs.length === 1) return readSingleDirActivity(since, dirs[0], dirs, now, sharedSwarm);
  const merged = new Map<string, AgyActivity>();
  for (const d of dirs) {
    for (const item of readSingleDirActivity(since, d, dirs, now, sharedSwarm)) {
      const prev = merged.get(item.id);
      if (!prev) {
        merged.set(item.id, item);
        continue;
      }
      const preferItem = item.running !== prev.running ? item.running : item.at >= prev.at;
      const pri = preferItem ? item : prev;
      const sec = preferItem ? prev : item;
      const childMap = new Map<string, AgyChildActivity>();
      for (const c of [...(sec.children ?? []), ...(pri.children ?? [])]) {
        const old = childMap.get(c.id);
        if (!old || c.updatedAt >= old.updatedAt || (c.running && !old.running)) childMap.set(c.id, c);
      }
      const children = childMap.size ? [...childMap.values()].sort((a, b) => (b.status === "waiting" ? 1 : 0) - (a.status === "waiting" ? 1 : 0) || b.updatedAt - a.updatedAt) : undefined;
      const subagents = Math.max(prev.subagents ?? 0, item.subagents ?? 0, children?.length ?? 0) || undefined;
      const agentName = pri.agentName || sec.agentName;
      const swarm = prev.swarm || item.swarm || undefined;
      const swarmTitle = pri.swarmTitle || sec.swarmTitle;
      const hasOwnRunning = prev.ownRunning !== undefined || item.ownRunning !== undefined;
      const ownRunning = hasOwnRunning ? Boolean(prev.ownRunning || item.ownRunning) : undefined;
      const swarmWaiting = (!ownRunning && pri.swarmWaiting) || undefined;
      const pendingContinuation = (!(prev.running || item.running) && pri.pendingContinuation) || undefined;
      const swarmAliveWorkers = (prev.swarmAliveWorkers !== undefined || item.swarmAliveWorkers !== undefined)
        ? Math.max(prev.swarmAliveWorkers ?? 0, item.swarmAliveWorkers ?? 0)
        : undefined;
      const { swarmWaiting: _sw, pendingContinuation: _pc, ...priRest } = pri;
      merged.set(item.id, {
        ...priRest,
        running: prev.running || item.running,
        ...(ownRunning !== undefined ? { ownRunning } : {}),
        nested: prev.nested || item.nested,
        at: Math.max(prev.at, item.at),
        since: Math.max(prev.since, item.since),
        title: pri.title || sec.title,
        workspace: pri.workspace || sec.workspace,
        ...(agentName ? { agentName } : {}),
        ...(swarm ? { swarm } : {}),
        ...(swarmTitle ? { swarmTitle } : {}),
        ...(swarmWaiting ? { swarmWaiting } : {}),
        ...(pendingContinuation ? { pendingContinuation } : {}),
        ...(swarmAliveWorkers !== undefined ? { swarmAliveWorkers } : {}),
        ...(children ? { children } : {}),
        ...(subagents ? { subagents } : {}),
      });
    }
  }
  return [...merged.values()];
}

/* ---------------- 额度（本机 language server） ---------------- */

/*
 * Antigravity 开着时，language server 在本机监听一个端口，地址和 CSRF 令牌写在 daemon/hub_<端口>.json 里。
 * 问它 GetUserStatus（Connect 协议，JSON）就拿到套餐和每个型号的额度：quotaInfo.remainingFraction（剩余比例）、
 * quotaInfo.resetTime。几个型号共用一份额度时，剩余比例和重置时间一模一样，按这两个值分组。
 * 只连 127.0.0.1，不走代理；令牌只在内存里用，不写日志、不存盘。返回里的邮箱和名字不往外传。
 */

export type AgyWindowQuota = {
  /** 已用百分比（0–100）。 */
  used: number;
  resetAt?: string;
};

export type AgyModelQuotaItem = {
  label: string;
  family: string;
  model: string;
  effort?: string;
  modelEnum?: string;
  used: number;
  resetAt?: string;
  weekUsed?: number;
  weekResetAt?: string;
};

export type AgyCredits = {
  monthlyPromptCredits?: number;
  availablePromptCredits?: number;
  monthlyFlowCredits?: number;
  availableFlowCredits?: number;
};

export type AgyQuotaGroup = {
  /** 分组标题（如 "Gemini Models" / "Claude and GPT models"）。 */
  title?: string;
  /** 这一组里的型号（显示名，不带档位），按 Antigravity 给的顺序去重。 */
  models: string[];
  /** 5 小时窗口已用百分比（0–100）。 */
  used: number;
  resetAt?: string;
  /** 周额度窗口（来自 RetrieveUserQuotaSummary）。 */
  week?: AgyWindowQuota;
};
export type AgyStatus = {
  plan: string;
  tier?: string;
  groups: AgyQuotaGroup[];
  labels: Record<string, string>;
  models?: AgyModelQuotaItem[];
  credits?: AgyCredits;
};

type Hub = { pid: number; httpPort: number; csrfToken: string; at: number };

/** 还活着的 language server。hub 文件可能是上次没删掉的，按进程还在不在挑最新的一个。 */
export function antigravityHub(dirs: string[] = antigravityDirs()): Hub | null {
  const hubs: Hub[] = [];
  for (const root of dirs) {
    const dir = path.join(root, "daemon");
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((name) => /^hub_\d+\.json$/.test(name)); } catch { continue; }
    for (const name of names) {
      try {
        const file = path.join(dir, name);
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        const pid = Number(raw.pid), httpPort = Number(raw.httpPort), csrfToken = typeof raw.csrfToken === "string" ? raw.csrfToken : "";
        if (!pid || !httpPort || !csrfToken) continue;
        try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") continue; }
        hubs.push({ pid, httpPort, csrfToken, at: fs.statSync(file).mtimeMs });
      } catch { /* 写到一半、格式不对：跳过 */ }
    }
  }
  return hubs.sort((a, b) => b.at - a.at)[0] ?? null;
}

function countLiveHubsInDir(root: string): number {
  const dir = path.join(root, "daemon");
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((name) => /^hub_\d+\.json$/.test(name)); } catch { return 0; }
  const pids = new Set<number>();
  for (const name of names) {
    try {
      const file = path.join(dir, name);
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      const pid = Number(raw.pid), httpPort = Number(raw.httpPort), csrfToken = typeof raw.csrfToken === "string" ? raw.csrfToken : "";
      if (!pid || !httpPort || !csrfToken) continue;
      try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") continue; }
      pids.add(pid);
    } catch { /* 忽略 */ }
  }
  return pids.size;
}

function countDirLiveConcurrency(dir: string, allDirs: string[], now: number): { requests: number; clients: number; upstream: number } {
  const hubs = countLiveHubsInDir(dir);
  const items = readSingleDirActivity(now - 5 * 60_000, dir, allDirs, now);
  const activeRoots = items.filter((item) => !item.nested && item.running && now - item.at <= 5 * 60_000);
  let requests = 0;
  for (const root of activeRoots) {
    if (root.phase === "waiting") continue;
    requests += Math.max(1, root.subagents ?? 0);
  }
  const clients = Math.max(activeRoots.length, hubs);
  return { requests, clients, upstream: requests };
}

/** 统计 Antigravity IDE 与 Antigravity CLI 当前本机实时并发（活跃 AI 请求、客户端连接、上游流式请求）。 */
export function readAntigravityLiveConcurrency(now = Date.now()): {
  ide: { requests: number; clients: number; upstream: number };
  cli: { requests: number; clients: number; upstream: number };
} {
  const ideDir = antigravityDir();
  const cliDir = antigravityCliDir();
  const allDirs = antigravityDirs();
  const ide = countDirLiveConcurrency(ideDir, allDirs, now);
  const cli = path.resolve(cliDir).toLowerCase() === path.resolve(ideDir).toLowerCase()
    ? { requests: 0, clients: 0, upstream: 0 }
    : countDirLiveConcurrency(cliDir, allDirs, now);
  return { ide, cli };
}

function postLocal(port: number, token: string, method: string, body: unknown, timeoutMs = 8000): Promise<unknown> {
  const http = require("http") as typeof import("http");
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = (val: unknown) => { if (settled) return; settled = true; resolve(val); };
    const rejectOnce = (err: unknown) => { if (settled) return; settled = true; reject(err instanceof Error ? err : new Error(String(err))); };
    const req = http.request({
      // 不复用连接：Antigravity 重启、端口换了以后，留着的长连接会让下一次请求挂到超时
      host: "127.0.0.1", port, method: "POST", path: `/exa.language_server_pb.LanguageServerService/${method}`, timeout: timeoutMs, agent: false,
      headers: { "content-type": "application/json", "connect-protocol-version": "1", "x-codeium-csrf-token": token, "content-length": Buffer.byteLength(data) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", rejectOnce);
      res.on("aborted", () => rejectOnce(new Error("Antigravity 本机接口连接中断")));
      res.on("close", () => { if (!res.complete) rejectOnce(new Error("Antigravity 本机接口响应中断")); });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 0) >= 400) { rejectOnce(new Error(`Antigravity 本机接口返回 HTTP ${res.statusCode}`)); return; }
        try { resolveOnce(JSON.parse(text)); } catch { rejectOnce(new Error("Antigravity 本机接口返回的不是 JSON")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Antigravity 本机接口超时")));
    req.on("error", rejectOnce);
    req.end(data);
  });
}

/** 标签去掉括号里的档位：「Gemini 4 Argon (High)」→「Gemini 4 Argon」。 */
export function modelFamily(label: string) {
  return label.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

export type ParsedSummaryGroup = {
  idx: number;
  title: string;
  description: string;
  bucketIds: string[];
  five?: AgyWindowQuota;
  week?: AgyWindowQuota;
};

export function poolCategory(family: string): string {
  if (/gemini|orchestrator/i.test(family)) return "gemini";
  if (/claude|gpt|anthropic|openai/i.test(family)) return "3p";
  return family.toLowerCase();
}

export function parseSummaryGroups(summaryJson: unknown): ParsedSummaryGroup[] {
  const root = summaryJson as {
    response?: { groups?: unknown; quotaSummaryGroups?: unknown; quota_summary_groups?: unknown };
    command?: { data?: { groups?: unknown; quotaSummaryGroups?: unknown } };
    groups?: unknown;
    quotaSummaryGroups?: unknown;
    quota_summary_groups?: unknown;
  } | null;
  const rawGroups = (
    root?.response?.groups ??
    root?.response?.quotaSummaryGroups ??
    root?.response?.quota_summary_groups ??
    root?.command?.data?.groups ??
    root?.command?.data?.quotaSummaryGroups ??
    root?.groups ??
    root?.quotaSummaryGroups ??
    root?.quota_summary_groups
  ) as Record<string, unknown>[] | undefined;
  if (!Array.isArray(rawGroups) || !rawGroups.length) return [];
  const parseDirectWin = (w: unknown): AgyWindowQuota | undefined => {
    if (!w || typeof w !== "object") return undefined;
    const obj = w as Record<string, unknown>;
    const rawRem = obj.remainingFraction ?? obj.remaining_fraction;
    if (rawRem === undefined && !obj.resetTime && !obj.reset_time) return undefined;
    const remaining = Math.min(1, Math.max(0, Number(rawRem ?? 0) || 0));
    const used = Math.round((1 - remaining) * 1000) / 10;
    const rawReset = obj.resetTime ?? obj.reset_time;
    const resetAt = typeof rawReset === "string" && rawReset ? rawReset : undefined;
    return { used, ...(resetAt ? { resetAt } : {}) };
  };
  const out: ParsedSummaryGroup[] = [];
  rawGroups.forEach((raw, idx) => {
    if (!raw || typeof raw !== "object") return;
    const title = typeof raw.displayName === "string" && raw.displayName.trim()
      ? raw.displayName.trim()
      : typeof raw.display_name === "string" && raw.display_name.trim()
        ? raw.display_name.trim()
        : typeof raw.groupName === "string" && raw.groupName.trim()
          ? raw.groupName.trim()
          : typeof raw.group_name === "string" && raw.group_name.trim()
            ? raw.group_name.trim()
            : typeof raw.title === "string" && raw.title.trim()
              ? raw.title.trim()
              : typeof raw.name === "string"
                ? raw.name.trim()
                : "";
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    const buckets = Array.isArray(raw.buckets) ? (raw.buckets as Record<string, unknown>[]) : [];
    const bucketIds: string[] = [];
    let five: AgyWindowQuota | undefined = parseDirectWin(raw.fiveHourQuota ?? raw.five_hour_quota);
    let week: AgyWindowQuota | undefined = parseDirectWin(raw.weeklyQuota ?? raw.weekly_quota);
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== "object") continue;
      const id = typeof bucket.bucketId === "string" && bucket.bucketId
        ? bucket.bucketId
        : typeof bucket.bucket_id === "string" && bucket.bucket_id
          ? bucket.bucket_id
          : typeof bucket.id === "string"
            ? bucket.id
            : "";
      const bTitle = typeof bucket.displayName === "string" && bucket.displayName
        ? bucket.displayName
        : typeof bucket.display_name === "string" && bucket.display_name
          ? bucket.display_name
          : typeof bucket.title === "string" && bucket.title
            ? bucket.title
            : typeof bucket.name === "string"
              ? bucket.name
              : "";
      const win = typeof bucket.window === "string" ? bucket.window : "";
      if (id) bucketIds.push(id);
      const rawRem = bucket.remainingFraction ?? bucket.remaining_fraction;
      const remaining = Math.min(1, Math.max(0, Number(rawRem ?? 0) || 0));
      const used = Math.round((1 - remaining) * 1000) / 10;
      const rawReset = bucket.resetTime ?? bucket.reset_time;
      const resetAt = typeof rawReset === "string" && rawReset ? rawReset : undefined;
      const quota: AgyWindowQuota = { used, ...(resetAt ? { resetAt } : {}) };
      if (win === "weekly" || /weekly/i.test(id) || /week/i.test(bTitle)) week = quota;
      else if (win === "5h" || /5h/i.test(id) || /5-?hour|five\s+hour/i.test(bTitle)) five = quota;
    }
    if (title || five || week) out.push({ idx, title, description, bucketIds, ...(five ? { five } : {}), ...(week ? { week } : {}) });
  });
  return out;
}

function sameResetTime(a?: string, b?: string, maxDiffMs = 10_000): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) <= maxDiffMs;
}

export function summaryPoolCategory(sg: ParsedSummaryGroup): string {
  const hay = `${sg.title} ${sg.description} ${sg.bucketIds.join(" ")}`;
  if (/gemini|orchestrator/i.test(hay)) return "gemini";
  if (/claude|gpt|3p|anthropic|openai/i.test(hay)) return "3p";
  return "";
}

export function matchSummaryGroup(family: string, used: number, resetAt: string | undefined, summaryGroups: ParsedSummaryGroup[]): ParsedSummaryGroup | undefined {
  if (!summaryGroups.length) return undefined;
  const familyPool = poolCategory(family);
  if (familyPool === "gemini") {
    const byFamily = summaryGroups.find((sg) => summaryPoolCategory(sg) === "gemini");
    if (byFamily) return byFamily;
  } else if (familyPool === "3p") {
    const byFamily = summaryGroups.find((sg) => summaryPoolCategory(sg) === "3p");
    if (byFamily) return byFamily;
  }
  const compatible = (sg: ParsedSummaryGroup) => {
    const sgPool = summaryPoolCategory(sg);
    if (!sgPool) return true;
    return sgPool === familyPool;
  };
  const exact = summaryGroups.find((sg) => compatible(sg) && sg.five && sameResetTime(sg.five.resetAt, resetAt) && Math.abs(sg.five.used - used) <= 0.2);
  if (exact) return exact;
  return summaryGroups.find((sg) => compatible(sg) && sg.five && sameResetTime(sg.five.resetAt, resetAt));
}

/** 把 GetUserStatus（以及可选的 RetrieveUserQuotaSummary）的返回整理成套餐 + 额度分组（含 5h 与周额度）+ 型号标签。认不出来返回 null。 */
export function parseAntigravityStatus(json: unknown, summaryJson?: unknown): AgyStatus | null {
  const status = (json as { userStatus?: Record<string, unknown> } | null)?.userStatus;
  if (!status) return null;
  const planStatus = status.planStatus as Record<string, unknown> | undefined;
  const planInfo = planStatus?.planInfo as Record<string, unknown> | undefined;
  const plan = String(planInfo?.planName ?? "");
  const tier = String((status.userTier as Record<string, unknown> | undefined)?.name ?? "") || undefined;
  const monthlyPromptCredits = Number(planInfo?.monthlyPromptCredits ?? 0) || 0;
  const availablePromptCredits = Number(planStatus?.availablePromptCredits ?? 0) || 0;
  const monthlyFlowCredits = Number(planInfo?.monthlyFlowCredits ?? 0) || 0;
  const availableFlowCredits = Number(planStatus?.availableFlowCredits ?? 0) || 0;
  const credits: AgyCredits | undefined = (monthlyPromptCredits || availablePromptCredits || monthlyFlowCredits || availableFlowCredits)
    ? {
        ...(monthlyPromptCredits ? { monthlyPromptCredits, availablePromptCredits } : {}),
        ...(monthlyFlowCredits ? { monthlyFlowCredits, availableFlowCredits } : {}),
      }
    : undefined;
  const summaryGroups = parseSummaryGroups(summaryJson);
  const configs = ((status.cascadeModelConfigData as Record<string, unknown> | undefined)?.clientModelConfigs ?? []) as Record<string, unknown>[];
  const labels: Record<string, string> = {};
  const groups = new Map<string, AgyQuotaGroup>();
  const models: AgyModelQuotaItem[] = [];
  for (const config of Array.isArray(configs) ? configs : []) {
    const label = typeof config.label === "string" ? config.label.trim() : "";
    const modelEnum = (config.modelOrAlias as Record<string, unknown> | undefined)?.model;
    if (label && typeof modelEnum === "string" && modelEnum) labels[modelEnum] = label;
    const quota = config.quotaInfo as Record<string, unknown> | undefined;
    if (!label || !quota) continue;
    // 用完的时候 remainingFraction 不出现（protobuf 的 0 不写），当成 0
    const remaining = Math.min(1, Math.max(0, Number(quota.remainingFraction ?? 0) || 0));
    const used = Math.round((1 - remaining) * 1000) / 10;
    const resetAt = typeof quota.resetTime === "string" && quota.resetTime ? quota.resetTime : undefined;
    const { model, family, effort } = splitModelLabel(label);
    const groupFamily = modelFamily(label);
    const matched = matchSummaryGroup(groupFamily, used, resetAt, summaryGroups);
    const key = matched ? `sg:${matched.idx}` : `${poolCategory(groupFamily)}|${remaining}|${resetAt ?? ""}`;
    const groupUsed = matched?.five ? matched.five.used : used;
    const groupResetAt = matched?.five?.resetAt ?? resetAt;
    const group = groups.get(key) ?? {
      ...(matched?.title ? { title: matched.title } : {}),
      models: [],
      used: groupUsed,
      ...(groupResetAt ? { resetAt: groupResetAt } : {}),
      ...(matched?.week ? { week: matched.week } : {}),
    };
    if (!group.models.includes(groupFamily)) group.models.push(groupFamily);
    groups.set(key, group);
    models.push({
      label,
      family,
      model,
      ...(effort ? { effort } : {}),
      ...(typeof modelEnum === "string" && modelEnum ? { modelEnum } : {}),
      used: groupUsed,
      ...(groupResetAt ? { resetAt: groupResetAt } : {}),
      ...(matched?.week ? { weekUsed: matched.week.used, ...(matched.week.resetAt ? { weekResetAt: matched.week.resetAt } : {}) } : {}),
    });
  }
  return {
    plan,
    ...(tier ? { tier } : {}),
    groups: [...groups.values()],
    labels,
    ...(models.length ? { models } : {}),
    ...(credits ? { credits } : {}),
  };
}

export type AgyLocalSession = {
  status: AgyStatus;
  email: string;
  name: string;
};

export function parseAntigravityIdentity(json: unknown): { email: string; name: string } {
  const status = (json as { userStatus?: Record<string, unknown> } | null)?.userStatus;
  const email = typeof status?.email === "string" ? status.email.trim() : "";
  const name = typeof status?.name === "string" ? status.name.trim() : "";
  return { email, name };
}

/** 问一次本机运行中的 Antigravity（含当前登录身份，仅供多账号管理与归属时间线内部使用，不直接发给界面）。 */
export async function fetchAntigravityLocalSession(): Promise<AgyLocalSession | null> {
  const hub = antigravityHub();
  if (!hub) return null;
  const meta = { metadata: { ideName: "antigravity", extensionName: "antigravity" } };
  const json = await postLocal(hub.httpPort, hub.csrfToken, "GetUserStatus", meta);
  const summaryJson = await postLocal(hub.httpPort, hub.csrfToken, "RetrieveUserQuotaSummary", meta).catch(() => null);
  const status = parseAntigravityStatus(json, summaryJson);
  if (!status) throw new Error("Antigravity 本机接口的返回认不出来");
  if (Object.keys(status.labels).length) rememberModelLabels(status.labels);
  const { email, name } = parseAntigravityIdentity(json);
  return { status, email, name };
}

/** 问一次额度（同时拉 GetUserStatus 和 RetrieveUserQuotaSummary 拿到 5 小时与周额度）。Antigravity 没开返回 null。 */
export async function fetchAntigravityStatus(): Promise<AgyStatus | null> {
  const session = await fetchAntigravityLocalSession();
  return session ? session.status : null;
}
