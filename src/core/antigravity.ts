import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { dataFile, readJson, writeJson } from "./paths";
import { pbDurationMs, pbFields, pbMessage, pbNumber, pbString, pbTime } from "./protobuf-lite";

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

type Statement = { all: (...args: unknown[]) => unknown[]; get: (...args: unknown[]) => unknown };
type Database = { prepare: (sql: string) => Statement; close: () => void };
const openDb = (file: string): Database => {
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => Database };
  return new DatabaseSync(file, { readOnly: true });
};
/** 表可能不存在（老版本、刚建的对话）：没有就是 null。 */
function prepareOptional(db: Database, sql: string): Statement | null {
  try { return db.prepare(sql); } catch { return null; }
}
function withDb<T>(file: string, fn: (db: Database) => T): T {
  const db = openDb(file);
  try { return fn(db); } finally { db.close(); }
}

/** 对话库文件：只要 <UUID>.db。 */
export function antigravityConversationFiles(): string[] {
  const dir = path.join(antigravityDir(), "conversations");
  try {
    return fs.readdirSync(dir).filter((name) => /^[0-9a-f-]{36}\.db$/i.test(name)).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** 对话库连同 -wal 的大小和改动时间：WAL 模式下新内容先写进 -wal，主库要等合并才变。 */
export function antigravityStamp(file: string): { size: number; mtimeMs: number } | null {
  let size = 0, mtimeMs = 0, found = false;
  for (const part of [file, file + "-wal"]) {
    try { const stat = fs.statSync(part); size += stat.size; mtimeMs = Math.max(mtimeMs, stat.mtimeMs); found ||= part === file; } catch { /* 没有 -wal 是正常的 */ }
  }
  return found ? { size, mtimeMs } : null;
}

/** 对话 ID → 工作区目录（第一个）。读不到就是空的。 */
export function antigravityWorkspaces(): Map<string, string> {
  const out = new Map<string, string>();
  const file = path.join(antigravityDir(), "conversation_summaries.db");
  if (!fs.existsSync(file)) return out;
  try {
    withDb(file, (db) => {
      for (const row of db.prepare("select conversation_id, workspace_uris from conversation_summaries").all() as { conversation_id: string; workspace_uris: string | null }[]) {
        const first = workspacePath(row.workspace_uris);
        if (row.conversation_id && first) out.set(row.conversation_id, first);
      }
    });
  } catch { /* 正在写或者格式变了：没有项目目录也照样统计 */ }
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
export function splitModelLabel(label: string): { model: string; family: string; effort?: string } {
  const match = label.trim().match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  const family = (match ? match[1] : label).trim();
  let id = family.toLowerCase().replace(/\s+/g, "-");
  // Anthropic 的型号 ID 用短横线分版本（claude-opus-5-5），和 Claude Code 记的对上
  if (id.startsWith("claude-")) id = id.replace(/\./g, "-");
  const rawEffort = match?.[2].trim().toLowerCase();
  const effort = rawEffort === "thinking" ? "high" : rawEffort;
  return { model: id, family, ...(effort ? { effort } : {}) };
}
export function resolveModel(found: AgyModel | undefined, labels: Record<string, string>): { model: string; effort?: string; labeled: boolean } {
  const label = (found?.enum ? labels[found.enum] : undefined) || found?.label;
  if (!label) return { model: found?.model || "未知模型", labeled: false };
  const { model, effort } = splitModelLabel(label);
  return { model, ...(effort ? { effort } : {}), labeled: true };
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

/**
 * 读一个对话库里 from（含）之后完成了的模型回复。
 * next：下次从哪一步接着读——停在第一步还没完成的回复上，等它写完再算。
 * models：这次遇到、known 里还没有的数字 id 的型号。
 */
export function readAntigravityGenerations(file: string, from: number, known: Record<string, AgyModel>, now = Date.now()): { rows: AgyGeneration[]; next: number; total: number; models: Record<string, AgyModel> } {
  return withDb(file, (db) => {
    const steps = db.prepare("select idx, step_type, status, metadata from steps where idx >= ? order by idx").all(from) as { idx: number; step_type: number; status: number; metadata: Uint8Array | null }[];
    const total = (db.prepare("select coalesce(max(idx), -1) + 1 as n from steps").get() as { n: number }).n;
    const rows: AgyGeneration[] = [];
    const models: Record<string, AgyModel> = {};
    const genModel = prepareOptional(db, "select data from gen_metadata where idx = ?");
    let next = from;
    for (const step of steps) {
      const meta = step.metadata ? Buffer.from(step.metadata) : null;
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
      if (!usage || (!input && !output && !cacheRead)) continue;
      const modelId = pbNumber(meta, 11) || pbNumber(usage, 1);
      const key = String(modelId);
      const genInfo = pbMessage(meta, 20);
      const hasGenIdx = genInfo ? (pbFields(genInfo)?.some((f) => f.no === 3) ?? false) : false;
      const genIdx = hasGenIdx ? pbNumber(genInfo, 3) : -1;
      const genData = genIdx >= 0 ? (genModel?.get(genIdx) as { data?: Uint8Array } | undefined)?.data : undefined;
      const genParsed = genData ? parseGenerationMeta(Buffer.from(genData)) : null;
      if (modelId && !known[key] && !models[key] && genParsed?.model) {
        models[key] = {
          model: genParsed.model,
          ...(genParsed.enum ? { enum: genParsed.enum } : {}),
          ...(genParsed.label ? { label: genParsed.label } : {}),
        };
      } else if (modelId && genParsed?.label) {
        const existing = models[key] ?? known[key];
        if (existing && !existing.label) models[key] = { ...existing, label: genParsed.label };
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
            : finishedAt > startAt
              ? finishedAt - startAt
              : completedAt > startAt
                ? completedAt - startAt
                : rawFirstTokenMs || streamingMs)
        : 0;
      const reasoning = pbNumber(usage, 9);
      const outNoThink = Math.max(0, output - reasoning);
      // 服务端整包缓冲的工具调用（如直接调 write_file / edit_file 且无流式正文或可见思考块）：
      // Gemini 在服务端拼完整个工具 JSON 后才一次性返回，导致 field 11 (viewableAt - startAt) 吞入了整段生成耗时（甚至长达 20s–129s），
      // 而 field 12 (streamingMs) 只剩几十毫秒的收尾时间（表观流式速度 > 500 Token/秒）。此类不把整段生成耗时误记为「首字延迟」。
      const isBufferedToolCall =
        rawFirstTokenMs > 0 &&
        outNoThink >= 150 &&
        (streamingMs <= 0 || outNoThink / (streamingMs / 1000) > 500);
      const firstTokenMs = isBufferedToolCall ? 0 : rawFirstTokenMs;
      const tokensPerSec = totalMs >= 200 && totalMs <= 30 * 60_000 && output > 0
        ? Math.round((output / (totalMs / 1000)) * 10) / 10
        : 0;
      const responseId = pbString(usage, 11);
      const messageId = pbString(usage, 7);
      const requestId = genParsed?.requestId || messageId;
      const returned = genParsed?.rawModel || (known[key] ?? models[key])?.model;
      rows.push({
        step: step.idx, at, startAt, modelId,
        input: input + cacheRead + cacheWrite, output, cacheRead, cacheWrite, reasoning,
        ...(responseId ? { responseId } : {}),
        ...(requestId ? { requestId } : {}),
        ...(returned ? { returned } : {}),
        ...(firstTokenMs > 0 ? { firstTokenMs } : {}),
        ...(totalMs > 0 ? { totalMs } : {}),
        ...(tokensPerSec > 0 ? { tokensPerSec } : {}),
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
  | {
      kind: "reply";
      at: number;
      text: string;
      modelId: number;
      tools: { id: string; name: string; args: string }[];
      usage?: AgyStepUsage;
      durationMs?: number;
      firstTokenMs?: number;
      tokensPerSec?: number;
      isMeasured?: boolean;
    }
  | { kind: "result"; at: number; id: string; name: string; args: string; output: string; error: boolean };

export const USER_INPUT = 14, TOOL_STEP = 132;

/** models：回复里用到的型号（数字 id → 型号名和 model_enum，从 gen_metadata 读，每个型号读一条）。 */
export function readAntigravityConversation(file: string): { steps: AgyStep[]; models: Record<string, AgyModel> } {
  return withDb(file, (db) => {
    const out: AgyStep[] = [];
    const models: Record<string, AgyModel> = {};
    const genModel = prepareOptional(db, "select data from gen_metadata where idx = ?");
    for (const row of db.prepare("select idx, step_type, status, metadata, step_payload from steps order by idx").all() as { idx: number; step_type: number; status: number; metadata: Uint8Array | null; step_payload: Uint8Array | null }[]) {
      if (!row.step_payload && !row.metadata) continue;
      const payload = row.step_payload ? Buffer.from(row.step_payload) : undefined;
      const payloadMeta = pbMessage(payload, 5);
      const colMeta = row.metadata ? Buffer.from(row.metadata) : undefined;
      const meta = payloadMeta ?? colMeta;
      const at = pbTime(pbMessage(payloadMeta, 1)) || pbTime(pbMessage(colMeta, 1));
      if (row.step_type === USER_INPUT) {
        if (!payload) continue;
        const text = pbString(pbMessage(payload, 19), 2);
        if (text.trim()) out.push({ kind: "user", at, text });
      } else if (row.step_type === MODEL_REPLY) {
        const body = pbMessage(payload, 20);
        const tools = (pbFields(body ?? Buffer.alloc(0)) ?? []).filter((field) => field.no === 7 && field.bytes).map((field) => ({ id: pbString(field.bytes, 1), name: pbString(field.bytes, 2), args: pbString(field.bytes, 3) }));
        const text = pbString(body, 1);
        const u = pbMessage(payloadMeta, 9) ?? pbMessage(colMeta, 9);
        const rawInput = pbNumber(u, 2), output = pbNumber(u, 3), cacheWrite = pbNumber(u, 4), cacheRead = pbNumber(u, 5), reasoning = pbNumber(u, 9);
        const input = rawInput + cacheRead + cacheWrite;
        const usage: AgyStepUsage | undefined = u && (input > 0 || output > 0) ? { input, output, cacheRead, cacheWrite, reasoning } : undefined;
        const modelId = pbNumber(payloadMeta, 11) || pbNumber(colMeta, 11) || pbNumber(u, 1);

        const genInfo = pbMessage(payloadMeta, 20) ?? pbMessage(colMeta, 20);
        const hasGenIdx = genInfo ? (pbFields(genInfo)?.some((f) => f.no === 3) ?? false) : false;
        const genIdx = hasGenIdx ? pbNumber(genInfo, 3) : -1;
        const genData = genIdx >= 0 ? (genModel?.get(genIdx) as { data?: Uint8Array } | undefined)?.data : undefined;
        const genParsed = genData ? parseGenerationMeta(Buffer.from(genData)) : null;

        if (modelId) {
          const key = String(modelId);
          if (!models[key] && genParsed?.model) {
            models[key] = {
              model: genParsed.model,
              ...(genParsed.enum ? { enum: genParsed.enum } : {}),
              ...(genParsed.label ? { label: genParsed.label } : {}),
            };
          } else if (genParsed?.label && models[key] && !models[key].label) {
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

        const outNoThink = Math.max(0, output - reasoning);
        const isBufferedToolCall =
          rawFirstTokenMs > 0 &&
          outNoThink >= 150 &&
          (streamingMs <= 0 || outNoThink / (streamingMs / 1000) > 500);

        const firstTokenMs = isBufferedToolCall || rawFirstTokenMs <= 0 ? undefined : rawFirstTokenMs;
        const tokensPerSec = totalMs >= 200 && totalMs <= 30 * 60_000 && output > 0
          ? Math.round((output / (totalMs / 1000)) * 10) / 10
          : undefined;

        if (text.trim() || tools.length || usage) {
          out.push({
            kind: "reply",
            at: replyAt || at,
            text,
            modelId,
            tools,
            ...(usage ? { usage } : {}),
            ...(totalMs > 0 ? { durationMs: totalMs, isMeasured: true } : {}),
            ...(firstTokenMs != null ? { firstTokenMs } : {}),
            ...(tokensPerSec != null ? { tokensPerSec } : {}),
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

export type AgySummary = { id: string; title: string; workspace?: string; nested: boolean; at: number };
/** 对话列表库里的标题、工作区。删掉的对话不在这里（Antigravity 删除时会把这一行去掉）。读不到返回 null。 */
export function antigravitySummaries(dir = antigravityDir()): Map<string, AgySummary> | null {
  const file = path.join(dir, "conversation_summaries.db");
  if (!fs.existsSync(file)) return null;
  try {
    return withDb(file, (db) => new Map((db.prepare("select * from conversation_summaries").all() as Record<string, unknown>[]).flatMap((row) => {
      const id = typeof row.conversation_id === "string" ? row.conversation_id : "";
      return id ? [[id, { id, title: typeof row.title === "string" ? row.title : "", workspace: workspacePath(typeof row.workspace_uris === "string" ? row.workspace_uris : null), nested: Number(row.nesting_depth || 0) > 0, at: sqliteTime(row.last_modified_time) }] as [string, AgySummary]] : [];
    })));
  } catch { return null; }
}

/** 请开着的 Antigravity 删掉一段对话（和它自己的对话列表里删除一样）。没开着就报错，不碰文件。 */
export async function deleteAntigravityConversation(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("对话 ID 不对");
  const hub = antigravityHub();
  if (!hub) throw new Error("Antigravity 没有在运行。请先打开 Antigravity，再删除这段对话（由它自己删，它的对话列表才不会留下坏掉的记录）");
  await postLocal(hub.httpPort, hub.csrfToken, "DeleteCascadeTrajectory", { cascadeId: id });
}

/* ---------------- 桌宠：哪些对话在跑 ---------------- */

/*
 * conversation_summaries 每个对话一行：status 是运行状态（CascadeRunStatus：IDLE 空闲、RUNNING 在跑、CANCELING 正在停、BUSY 忙），
 * not_fully_idle、last_modified_time、last_user_input_time、title、workspace_uris、nesting_depth（> 0 是派出去的子代理）。
 * 在跑的对话再看最后几步：有一步在等批准（WAITING）就是在等你；最后一步是别的步骤（工具、命令）在跑就是在跑工具；否则在想。
 * 空闲了看最后一次模型回复的状态：出错（ERROR）、被停（CANCELED / INTERRUPTED）、正常。
 */
export type AgyActivity = {
  id: string; title: string; workspace?: string;
  running: boolean; nested: boolean;
  /** 最后改动的时间（毫秒）；since：最后一次用户输入。 */
  at: number; since: number;
  phase?: "thinking" | "tool" | "waiting";
  ended?: "ok" | "interrupted" | "error";
};

/** 「2026-11-06 04:52:41.2188695+00:00」这种：空格换 T，秒的小数留三位。 */
export function sqliteTime(value: unknown): number {
  if (typeof value !== "string" || !value) return 0;
  const text = value.trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
  return Date.parse(text) || 0;
}

/** 一个对话最后几步：在跑的时候分出在想 / 工具 / 等你；空闲了看最后一次回复怎么结束的。 */
export function conversationPhase(file: string): Pick<AgyActivity, "phase" | "ended"> {
  try {
    return withDb(file, (db) => {
      const tail = db.prepare("select step_type, status from steps order by idx desc limit 6").all() as { step_type: number; status: number }[];
      if (!tail.length) return {};
      const phase = tail.some((step) => step.status === STEP.WAITING) ? "waiting" as const
        : tail[0].step_type !== MODEL_REPLY && STEP_OPEN.has(tail[0].status) ? "tool" as const : "thinking" as const;
      const reply = tail.find((step) => step.step_type === MODEL_REPLY && !STEP_OPEN.has(step.status));
      const ended = reply?.status === STEP.ERROR ? "error" as const : reply && (reply.status === STEP.CANCELED || reply.status === STEP.INTERRUPTED) ? "interrupted" as const : "ok" as const;
      return { phase, ended };
    });
  } catch { return {}; }
}

/** 最近 since 之后动过的对话。读不到（没装、正在写）返回空的。 */
export function readAntigravityActivity(since: number, dir = antigravityDir()): AgyActivity[] {
  const file = path.join(dir, "conversation_summaries.db");
  if (!fs.existsSync(file)) return [];
  let rows: Record<string, unknown>[] = [];
  try {
    rows = withDb(file, (db) => db.prepare("select * from conversation_summaries").all() as Record<string, unknown>[]);
  } catch { return []; }
  const out: AgyActivity[] = [];
  for (const row of rows) {
    const id = typeof row.conversation_id === "string" ? row.conversation_id : "";
    const at = sqliteTime(row.last_modified_time);
    if (!id || at < since) continue;
    const status = String(row.status ?? "");
    const running = /RUNNING|BUSY|CANCELING/.test(status) && Number(row.killed || 0) === 0;
    const db = path.join(dir, "conversations", id + ".db");
    out.push({
      id, at, since: sqliteTime(row.last_user_input_time) || at, running,
      title: typeof row.title === "string" ? row.title : "",
      workspace: workspacePath(typeof row.workspace_uris === "string" ? row.workspace_uris : null),
      nested: Number(row.nesting_depth || 0) > 0,
      ...(fs.existsSync(db) ? conversationPhase(db) : {}),
    });
  }
  return out;
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
export function antigravityHub(): Hub | null {
  const dir = path.join(antigravityDir(), "daemon");
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((name) => /^hub_\d+\.json$/.test(name)); } catch { return null; }
  const hubs: Hub[] = [];
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
  return hubs.sort((a, b) => b.at - a.at)[0] ?? null;
}

function postLocal(port: number, token: string, method: string, body: unknown, timeoutMs = 8000): Promise<unknown> {
  const http = require("http") as typeof import("http");
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      // 不复用连接：Antigravity 重启、端口换了以后，留着的长连接会让下一次请求挂到超时
      host: "127.0.0.1", port, method: "POST", path: `/exa.language_server_pb.LanguageServerService/${method}`, timeout: timeoutMs, agent: false,
      headers: { "content-type": "application/json", "connect-protocol-version": "1", "x-codeium-csrf-token": token, "content-length": Buffer.byteLength(data) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 0) >= 400) { reject(new Error(`Antigravity 本机接口返回 HTTP ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(text)); } catch { reject(new Error("Antigravity 本机接口返回的不是 JSON")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Antigravity 本机接口超时")));
    req.on("error", reject);
    req.end(data);
  });
}

/** 标签去掉括号里的档位：「Gemini 4 Argon (High)」→「Gemini 4 Argon」。 */
export function modelFamily(label: string) {
  return label.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

type ParsedSummaryGroup = {
  idx: number;
  title: string;
  description: string;
  bucketIds: string[];
  five?: AgyWindowQuota;
  week?: AgyWindowQuota;
};

function poolCategory(family: string): string {
  if (/gemini/i.test(family)) return "gemini";
  if (/claude|gpt|anthropic|openai/i.test(family)) return "3p";
  return family.toLowerCase();
}

function parseSummaryGroups(summaryJson: unknown): ParsedSummaryGroup[] {
  const root = (summaryJson as { response?: { groups?: unknown }; groups?: unknown } | null);
  const rawGroups = (root?.response?.groups ?? root?.groups) as Record<string, unknown>[] | undefined;
  if (!Array.isArray(rawGroups) || !rawGroups.length) return [];
  const out: ParsedSummaryGroup[] = [];
  rawGroups.forEach((raw, idx) => {
    if (!raw || typeof raw !== "object") return;
    const title = typeof raw.displayName === "string" && raw.displayName.trim()
      ? raw.displayName.trim()
      : typeof raw.title === "string"
        ? raw.title.trim()
        : "";
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    const buckets = Array.isArray(raw.buckets) ? (raw.buckets as Record<string, unknown>[]) : [];
    const bucketIds: string[] = [];
    let five: AgyWindowQuota | undefined;
    let week: AgyWindowQuota | undefined;
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== "object") continue;
      const id = typeof bucket.bucketId === "string" && bucket.bucketId
        ? bucket.bucketId
        : typeof bucket.id === "string"
          ? bucket.id
          : "";
      const bTitle = typeof bucket.displayName === "string" && bucket.displayName
        ? bucket.displayName
        : typeof bucket.title === "string"
          ? bucket.title
          : "";
      const win = typeof bucket.window === "string" ? bucket.window : "";
      if (id) bucketIds.push(id);
      const remaining = Math.min(1, Math.max(0, Number(bucket.remainingFraction ?? 0) || 0));
      const used = Math.round((1 - remaining) * 1000) / 10;
      const resetAt = typeof bucket.resetTime === "string" && bucket.resetTime ? bucket.resetTime : undefined;
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

function matchSummaryGroup(family: string, used: number, resetAt: string | undefined, summaryGroups: ParsedSummaryGroup[]): ParsedSummaryGroup | undefined {
  if (!summaryGroups.length) return undefined;
  if (/gemini/i.test(family)) {
    const byFamily = summaryGroups.find(
      (sg) => /gemini/i.test(sg.title) || /gemini/i.test(sg.description) || sg.bucketIds.some((id) => /gemini/i.test(id)),
    );
    if (byFamily) return byFamily;
  }
  if (/claude|gpt|anthropic|openai/i.test(family)) {
    const byFamily = summaryGroups.find(
      (sg) =>
        /claude|gpt|3p|anthropic|openai/i.test(sg.title)
        || /claude|gpt|3p|anthropic|openai/i.test(sg.description)
        || sg.bucketIds.some((id) => /3p|claude|gpt/i.test(id)),
    );
    if (byFamily) return byFamily;
  }
  const exact = summaryGroups.find((sg) => sg.five && sameResetTime(sg.five.resetAt, resetAt) && Math.abs(sg.five.used - used) <= 0.2);
  if (exact) return exact;
  return summaryGroups.find((sg) => sg.five && sameResetTime(sg.five.resetAt, resetAt));
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
    const matched = matchSummaryGroup(family, used, resetAt, summaryGroups);
    const key = matched ? `sg:${matched.idx}` : `${poolCategory(family)}|${remaining}|${resetAt ?? ""}`;
    const groupUsed = matched?.five ? matched.five.used : used;
    const groupResetAt = matched?.five?.resetAt ?? resetAt;
    const group = groups.get(key) ?? {
      ...(matched?.title ? { title: matched.title } : {}),
      models: [],
      used: groupUsed,
      ...(groupResetAt ? { resetAt: groupResetAt } : {}),
      ...(matched?.week ? { week: matched.week } : {}),
    };
    if (!group.models.includes(family)) group.models.push(family);
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

/** 问一次额度（同时拉 GetUserStatus 和 RetrieveUserQuotaSummary 拿到 5 小时与周额度）。Antigravity 没开返回 null。 */
export async function fetchAntigravityStatus(): Promise<AgyStatus | null> {
  const hub = antigravityHub();
  if (!hub) return null;
  const meta = { metadata: { ideName: "antigravity", extensionName: "antigravity" } };
  const json = await postLocal(hub.httpPort, hub.csrfToken, "GetUserStatus", meta);
  const summaryJson = await postLocal(hub.httpPort, hub.csrfToken, "RetrieveUserQuotaSummary", meta).catch(() => null);
  const status = parseAntigravityStatus(json, summaryJson);
  if (!status) throw new Error("Antigravity 本机接口的返回认不出来");
  if (Object.keys(status.labels).length) rememberModelLabels(status.labels);
  return status;
}
