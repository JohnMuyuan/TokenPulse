import fs from "node:fs/promises";
import path from "node:path";
import { cliDir } from "./credentials";
import { piDir } from "./paths";
import { claudeUserText, codexUserText, dshRoot } from "./sessions";
import { zstdFrames } from "./zstd-frames";

/**
 * 桌宠用的「本机 Agent 现在在干什么」（0.3.61）。只读会话文件，不改任何 CLI 的配置。
 *
 * | CLI | 一轮开始 | 在跑工具 | 一轮结束 |
 * |-----|---------|---------|---------|
 * | Claude Code | user 行里真正的提问 | assistant 行有 tool_use（stop_reason=tool_use），之后还没有 tool_result | assistant stop_reason=end_turn，或 system 行 turn_duration / stop_hook_summary；用户中断 |
 * | Codex | event_msg task_started | response_item function_call / custom_tool_call 还没有对应的 *_output | event_msg task_complete / turn_aborted |
 * | Grok Build | user_message_chunk | tool_call 还没有 status=completed/failed 的 tool_call_update | turn_completed（stop_reason end_turn / cancelled / error） |
 * | DeepSeek Harness | turn/start | tool/call 还没有 tool/result；approval/asked 没有 approval/decided 就是在等你批准 | turn/end |
 * | pi | message role=user | assistant stopReason=toolUse，还没有 toolResult | assistant stopReason=stop / length / error / aborted |
 *
 * 只读文件开头（会话 id、工作目录、是不是子会话、第一句提问）和结尾（最近的状态、Claude 的 ai-title），各 64 KB。
 * DeepSeek 的会话文件是一帧帧追加的 zstd，没法只读结尾，变了就整份解开（文件不大）。
 * 目录 30 秒全扫一次，记下两小时内动过的文件；之间每次只 stat 这些文件，变了才重读。
 * 子代理（Claude 的 subagents/、isSidechain；Codex 带 parent_thread_id 的子会话；Grok summary.json 里 session_kind=subagent 的；
 * DeepSeek delegationDepth > 0 的）不算单独的任务。
 * Claude 的子代理记在主会话旁边的 <会话 id>/subagents/agent-*.jsonl；Grok 的子代理是同一工作目录下的另一个会话，
 * 主会话里 subagent_spawned 写着它的 id（subagent_finished 之后就不算了）。没结束、SUB_STALE_MS 内动过的算在跑，
 * 记到主会话的 subagents 上（桌宠按它换「同时忙好几件」的姿势）。子代理在跑时主文件可能很久不动，主会话按两边最近的动静算，
 * 不会被当成「可能在等你」或过期；主会话这一轮已经结束、后台子代理还在跑的，也算在跑。
 *
 * 在问你（askOf）：Claude 的 AskUserQuestion（选择题）、ExitPlanMode（计划等你批准），Codex 的 request_user_input，
 * Grok 的 ask_user_question / exit_plan_mode，调用已经写进会话文件、还没有结果，就是在等你回答。只拿来显示，回答还是在终端里。
 */

export type TaskStatus = "thinking" | "tool" | "waiting" | "done";
export type TaskKind = "claude" | "codex" | "grok" | "deepseek" | "pi";
export type AskQuestion = { header: string; question: string; options: { label: string; description: string }[]; multi: boolean };
/** 一个等你回答的提问。id 是那次工具调用的 id，回答了（有了结果）就没了。 */
export type AgentAsk = { id: string; tool: string; at: number; questions: AskQuestion[]; plan?: string };
/** subagents：这个会话下正在跑的子代理个数（没有就不写）。 */
export type AgentTask = { key: string; kind: TaskKind; agent: string; id: string; title: string; project: string; status: TaskStatus; tool?: string; since: number; updatedAt: number; doneAt?: number; ask?: AgentAsk; subagents?: number };
/** 一轮是怎么结束的：正常做完、用户自己中断、出错（API 报错之类）。 */
export type TurnEnd = "ok" | "interrupted" | "error";
/**
 * 和上一次看相比的变化（第一次扫描都不算，免得一启动就庆祝、响提示音）：
 * finished 正常做完的任务（桌宠庆祝一下）；failed 出错结束的；needsYou 刚变成「可能在等你」的；asked 刚问了你新问题的（不再算进 needsYou）。
 * 用户自己中断的哪边都不算。
 */
export type ActivityState = { at: number; running: AgentTask[]; recent: AgentTask[]; finished: string[]; failed: string[]; needsYou: string[]; asked: string[] };
/** children：Grok 这一轮开出去、还没结束的子代理会话 id。status=waiting 只有 DeepSeek 在等你批准时直接给。 */
export type Inferred = { status: TaskStatus; since: number; at: number; tool?: string; doneAt?: number; ended?: TurnEnd; ask?: AgentAsk; children?: string[] };

/** 一轮没结束、文件却这么久没动：多半是终端关了或者进程崩了，不再算在跑。 */
export const STALE_MS = 10 * 60_000;
/** 工具调用发出去这么久还没结果：可能在等用户确认，也可能只是工具跑得久，界面上写「可能在等你」。 */
export const WAITING_MS = 90_000;
/** 问了你问题、文件这么久没动还算在等（人可能走开了一会儿）；再久就当终端关了。 */
export const ASK_STALE_MS = 60 * 60_000;
/** 任务列表里「刚完成」保留多久。 */
export const RECENT_MS = 10 * 60_000;
/** 子代理没结束、文件却这么久没动：多半是被停掉了（停掉的子代理不写结束行），不再算在跑。 */
export const SUB_STALE_MS = 5 * 60_000;
const FULL_SCAN_MS = 30_000;
const KEEP_MS = 2 * 60 * 60_000;
const CHUNK = 64 * 1024;
const AGENT: Record<TaskKind, string> = { claude: "Claude Code", codex: "Codex", grok: "Grok Build", deepseek: "DeepSeek Harness", pi: "pi" };

type Row = Record<string, any>;
function rows(lines: string[]): Row[] {
  const out: Row[] = [];
  for (const line of lines) {
    if (!line || line[0] !== "{") continue;
    try { const value = JSON.parse(line); if (value && typeof value === "object") out.push(value); } catch { /* 截断的行跳过 */ }
  }
  return out;
}
function stamp(value: unknown): number {
  // Grok 的 timestamp 是秒
  const at = typeof value === "number" ? (value < 10_000_000_000 ? value * 1000 : value) : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : 0;
}
const str = (value: unknown) => (typeof value === "string" ? value : "");
const DONE_STOPS = new Set(["end_turn", "max_tokens", "stop_sequence", "refusal"]);

const ASK_LIMITS = { questions: 4, options: 6, header: 40, question: 300, label: 80, description: 160, plan: 1200 };
const cut = (value: unknown, max: number) => { const text = str(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim(); return text.length > max ? text.slice(0, max - 1) + "…" : text; };
/** 工具调用是不是在问你；是的话收成要显示的样子（字数、个数都有上限）。不是返回 null。 */
export function askOf(name: string, input: unknown, id: string, at: number): AgentAsk | null {
  // Grok 的同名工具按 Claude 的样子显示
  const tool = name === "exit_plan_mode" ? "ExitPlanMode" : name === "ask_user_question" ? "AskUserQuestion" : name;
  let value = input;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return null; } }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Row;
  if (tool === "ExitPlanMode") return { id, tool, at, questions: [], plan: cut(raw.plan, ASK_LIMITS.plan) };
  if (tool !== "AskUserQuestion" && tool !== "request_user_input") return null;
  const questions: AskQuestion[] = [];
  for (const item of (Array.isArray(raw.questions) ? raw.questions.slice(0, ASK_LIMITS.questions) : []) as Row[]) {
    if (!item || typeof item !== "object") continue;
    const question = cut(item.question, ASK_LIMITS.question);
    if (!question) continue;
    const options = ((Array.isArray(item.options) ? item.options.slice(0, ASK_LIMITS.options) : []) as Row[])
      .map((option) => ({ label: cut(option?.label, ASK_LIMITS.label), description: cut(option?.description, ASK_LIMITS.description) }))
      .filter((option) => option.label);
    questions.push({ header: cut(item.header, ASK_LIMITS.header), question, options, multi: item.multiSelect === true });
  }
  return questions.length ? { id, tool, at, questions } : null;
}

/**
 * Claude Code：按文件结尾的若干行推出这一轮的状态。读不出任何对话行返回 null。
 * sidechain：读的是子代理的文件（每行都带 isSidechain），不跳过这些行。
 */
export function inferClaude(lines: string[], options: { sidechain?: boolean } = {}): Inferred | null {
  let status = null as TaskStatus | null, since = 0, at = 0, first = 0, tool: string | undefined, doneAt: number | undefined, ended: TurnEnd | undefined, ask: AgentAsk | undefined;
  for (const row of rows(lines)) {
    if ((row.isSidechain && !options.sidechain) || row.isMeta) continue;
    const t = stamp(row.timestamp) || at;
    if (row.type === "system") {
      if ((row.subtype === "turn_duration" || row.subtype === "stop_hook_summary") && status && status !== "done") { status = "done"; doneAt = t; tool = undefined; ended = "ok"; }
      continue;
    }
    if (row.type !== "user" && row.type !== "assistant") continue;
    if (t) { at = t; first ||= t; }
    const message = (row.message ?? {}) as Row;
    const content = message.content ?? row.content;
    const blocks = (Array.isArray(content) ? content : [{ type: "text", text: str(content) }]) as Row[];
    if (row.type === "user") {
      if (blocks.some((block) => block?.type === "tool_result")) {
        if (ask && blocks.some((block) => block?.type === "tool_result" && block.tool_use_id === ask!.id)) ask = undefined;
        // 有的工具交了结果这一轮就结束（子代理交最终结果那种），这一行带 toolEndsTurn
        if (row.toolEndsTurn === true && status !== "done") { status = "done"; doneAt = t; tool = undefined; ended = "ok"; continue; }
        if (status !== "done") { status = "thinking"; tool = undefined; }
        continue;
      }
      for (const block of blocks) {
        if (block?.type !== "text") continue;
        const cleaned = claudeUserText(str(block.text));
        if (cleaned.event === "已中断") { status = "done"; doneAt = t; tool = undefined; ended = "interrupted"; }
        else if (cleaned.text) { status = "thinking"; since = t; tool = undefined; doneAt = undefined; ended = undefined; ask = undefined; }
      }
      continue;
    }
    // API 报错（限流、过载、额度用完……）：Claude Code 写一条 isApiErrorMessage 的回复，这一轮就停了
    if (row.isApiErrorMessage === true) { status = "done"; doneAt = t; tool = undefined; ended = "error"; continue; }
    if (DONE_STOPS.has(str(message.stop_reason))) { status = "done"; doneAt = t; tool = undefined; ended = "ok"; continue; }
    // 这一轮的提问在读到的范围之前：以第一条回复为准
    if (status === null || status === "done") { status = "thinking"; since = t; doneAt = undefined; ended = undefined; ask = undefined; }
    const uses = blocks.filter((block) => block?.type === "tool_use");
    for (const block of uses) ask = askOf(str(block.name), block.input, str(block.id), t) ?? ask;
    const use = uses.at(-1);
    if (use) { status = "tool"; tool = str(use.name) || undefined; }
    else if (status === "tool") { status = "thinking"; tool = undefined; }
  }
  if (!status) return null;
  return { status, since: since || first, at, tool, doneAt, ...(status === "done" && ended ? { ended } : {}), ...(status !== "done" && ask ? { ask } : {}) };
}

/** Codex：task_started / task_complete 之间算在跑；有没回结果的工具调用就是在跑工具。 */
export function inferCodex(lines: string[]): Inferred | null {
  let status: TaskStatus | null = null, since = 0, at = 0, first = 0, tool: string | undefined, doneAt: number | undefined, ended: TurnEnd | undefined, ask: AgentAsk | undefined;
  const pending = new Map<string, string>();
  for (const row of rows(lines)) {
    const t = stamp(row.timestamp) || at;
    if (t) { at = t; first ||= t; }
    const payload = (row.payload ?? {}) as Row;
    if (row.type === "event_msg") {
      if (payload.type === "task_started") { status = "thinking"; since = t; tool = undefined; doneAt = undefined; ended = undefined; ask = undefined; pending.clear(); }
      // error 是这一轮出错停下（stream_error 只是在重试，不算）；出错后可能还会跟一条 task_complete，仍算出错
      else if (payload.type === "error" && status && status !== "done") { status = "done"; doneAt = t; tool = undefined; ended = "error"; pending.clear(); }
      else if (payload.type === "task_complete" || payload.type === "turn_aborted") {
        if (status !== "done" || ended !== "error") ended = payload.type === "turn_aborted" ? "interrupted" : "ok";
        status = "done"; doneAt ||= t; tool = undefined; pending.clear();
      }
      continue;
    }
    if (row.type !== "response_item" || status === "done") continue;
    if (status === null) status = "thinking";
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      pending.set(str(payload.call_id), str(payload.name));
      status = "tool"; tool = str(payload.name) || undefined;
      ask = askOf(str(payload.name), payload.arguments, str(payload.call_id), t) ?? ask;
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      pending.delete(str(payload.call_id));
      if (ask && ask.id === str(payload.call_id)) ask = undefined;
      if (!pending.size) { status = "thinking"; tool = undefined; }
      else { status = "tool"; tool = [...pending.values()].at(-1) || undefined; }
    }
  }
  if (!status) return null;
  return { status, since: since || first, at, tool, doneAt, ...(status === "done" && ended ? { ended } : {}), ...(status !== "done" && ask ? { ask } : {}) };
}

/** 工具调用都有结果了回到思考，否则显示最后一个还在跑的。 */
function settle(pending: Map<string, string>) {
  return pending.size ? { status: "tool" as const, tool: [...pending.values()].at(-1) || undefined } : { status: "thinking" as const, tool: undefined };
}

/** Grok Build：updates.jsonl 里的 session/update。用户的话、回复都是一小块一小块的，连着的几块算一条。 */
export function inferGrok(lines: string[]): Inferred | null {
  let status: TaskStatus | null = null, since = 0, at = 0, first = 0, tool: string | undefined, doneAt: number | undefined, ended: TurnEnd | undefined, ask: AgentAsk | undefined;
  const pending = new Map<string, string>(), children = new Set<string>();
  const start = (t: number) => { status = "thinking"; since = t; tool = undefined; doneAt = undefined; ended = undefined; ask = undefined; pending.clear(); };
  for (const row of rows(lines)) {
    const t = stamp(row.timestamp) || at;
    if (t) { at = t; first ||= t; }
    const update = (row.params?.update ?? {}) as Row;
    const kind = str(update.sessionUpdate);
    if (kind === "subagent_spawned") children.add(str(update.child_session_id));
    else if (kind === "subagent_finished") children.delete(str(update.child_session_id));
    else if (kind === "user_message_chunk") { if (status === null || status === "done") start(t); }
    else if (kind === "turn_completed") {
      const stop = str(update.stop_reason);
      status = "done"; doneAt = t; tool = undefined; ask = undefined; pending.clear();
      ended = stop === "cancelled" ? "interrupted" : stop === "error" ? "error" : "ok";
    } else if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "tool_call") {
      // 这一轮的提问在读到的范围之前：以第一条回复为准
      if (status === null || status === "done") start(t);
      if (kind !== "tool_call") continue;
      const id = str(update.toolCallId), name = str(update._meta?.["x.ai/tool"]?.name) || str(update.title);
      pending.set(id, name);
      ({ status, tool } = settle(pending));
      ask = askOf(name, update.rawInput, id, t) ?? ask;
    } else if (kind === "tool_call_update" && (update.status === "completed" || update.status === "failed") && status !== "done") {
      const id = str(update.toolCallId);
      pending.delete(id);
      if (ask && ask.id === id) ask = undefined;
      if (status !== null) ({ status, tool } = settle(pending));
    }
  }
  if (!status) return null;
  const done = status === "done";
  return { status, since: since || first, at, tool, doneAt, ...(done && ended ? { ended } : {}), ...(!done && ask ? { ask } : {}), ...(children.size ? { children: [...children].filter(Boolean) } : {}) };
}

/** DeepSeek Harness：turn/start 到 turn/end 之间算在跑；要你批准（approval/asked）还没决定就是在等你。 */
export function inferDeepseek(lines: string[]): Inferred | null {
  let status: TaskStatus | null = null, since = 0, at = 0, first = 0, tool: string | undefined, doneAt: number | undefined, ended: TurnEnd | undefined;
  const pending = new Map<string, string>(), approvals = new Set<string>();
  for (const row of rows(lines)) {
    const t = stamp(row.time) || at;
    if (t) { at = t; first ||= t; }
    const data = (row.data ?? {}) as Row;
    if (row.type === "turn/start") { status = "thinking"; since = t; tool = undefined; doneAt = undefined; ended = undefined; pending.clear(); approvals.clear(); continue; }
    if (row.type === "turn/end") {
      const reason = str(data.reason?.kind).toLowerCase();
      ended = /cancel|interrupt|abort/.test(reason) ? "interrupted" : /error|fail/.test(reason) ? "error" : "ok";
      status = "done"; doneAt = t; tool = undefined; pending.clear(); approvals.clear();
      continue;
    }
    if (status === "done") continue;
    if (row.type === "assistant/message" || row.type === "tool/call") status ??= "thinking";
    if (row.type === "tool/call") pending.set(str(data.callId), str(data.name));
    else if (row.type === "tool/result") pending.delete(str(data.message?.toolCallId));
    else if (row.type === "approval/asked") approvals.add(str(data.id));
    else if (row.type === "approval/decided") approvals.delete(str(data.id));
    else continue;
    if (status === null) continue;
    ({ status, tool } = settle(pending));
    if (approvals.size) status = "waiting";
  }
  if (!status) return null;
  return { status, since: since || first, at, tool, doneAt, ...(status === "done" && ended ? { ended } : {}) };
}

/** pi：用户说话开始一轮，assistant 的 stopReason 说明这一步之后是去跑工具还是这一轮结束了。 */
export function inferPi(lines: string[]): Inferred | null {
  let status: TaskStatus | null = null, since = 0, at = 0, first = 0, tool: string | undefined, doneAt: number | undefined, ended: TurnEnd | undefined;
  const pending = new Map<string, string>();
  for (const row of rows(lines)) {
    if (row.type !== "message" || !row.message || typeof row.message !== "object") continue;
    const message = row.message as Row, t = stamp(row.timestamp) || stamp(message.timestamp) || at;
    if (t) { at = t; first ||= t; }
    if (message.role === "user") { status = "thinking"; since = t; tool = undefined; doneAt = undefined; ended = undefined; pending.clear(); continue; }
    if (message.role === "toolResult") {
      pending.delete(str(message.toolCallId));
      if (status !== null && status !== "done") ({ status, tool } = settle(pending));
      continue;
    }
    if (message.role !== "assistant") continue;
    const stop = str(message.stopReason);
    if (stop === "toolUse") {
      if (status === null || status === "done") { since = t; doneAt = undefined; ended = undefined; pending.clear(); }
      for (const part of (Array.isArray(message.content) ? message.content : []) as Row[]) if (part?.type === "toolCall") pending.set(str(part.id), str(part.name));
      ({ status, tool } = settle(pending));
    } else if (stop) {
      status = "done"; doneAt = t; tool = undefined; pending.clear();
      ended = stop === "aborted" ? "interrupted" : stop === "error" ? "error" : "ok";
    }
  }
  if (!status) return null;
  return { status, since: since || first, at, tool, doneAt, ...(status === "done" && ended ? { ended } : {}) };
}

/** 推出来的状态再看文件多久没动：太久没动的不算在跑；工具调用卡太久写成「可能在等你」；在问你的马上就是在等你。 */
export function liveStatus(inferred: Inferred, mtimeMs: number, now: number): TaskStatus | null {
  if (inferred.status === "done") return "done";
  if (inferred.ask || inferred.status === "waiting") return now - mtimeMs > ASK_STALE_MS ? null : "waiting";
  if (now - mtimeMs > STALE_MS) return null;
  if (inferred.status === "tool" && now - mtimeMs > WAITING_MS) return "waiting";
  return inferred.status;
}

const clip = (text: string, max = 60) => { const one = text.replace(/\s+/g, " ").trim(); return one.length > max ? one.slice(0, max - 1) + "…" : one; };

/** 文件开头：会话 id、工作目录、第一句提问；是不是子代理。Claude 的 ai-title 取开头和结尾里最后出现的那个。 */
export function claudeHead(lines: string[]) {
  let id = "", cwd = "", title = "", prompt = "", side = false;
  for (const row of rows(lines)) {
    if (row.type === "ai-title" && typeof row.aiTitle === "string") title = row.aiTitle;
    if (row.type !== "user" && row.type !== "assistant") continue;
    if (row.isSidechain) side = true;
    if (!id && typeof row.sessionId === "string") id = row.sessionId;
    if (!cwd && typeof row.cwd === "string") cwd = row.cwd;
    if (prompt || row.type !== "user" || row.isMeta) continue;
    const content = row.message?.content ?? row.content;
    for (const block of (Array.isArray(content) ? content : [{ type: "text", text: str(content) }]) as Row[]) {
      if (block?.type === "text" && !prompt) prompt = claudeUserText(str(block.text)).text;
    }
  }
  return { id, cwd, title, prompt, side };
}

export function codexHead(lines: string[]) {
  let id = "", cwd = "", prompt = "", side = false;
  for (const row of rows(lines)) {
    const payload = (row.payload ?? {}) as Row;
    if (row.type === "session_meta") {
      if (payload.parent_thread_id || (payload.source && typeof payload.source === "object" && "subagent" in payload.source)) side = true;
      id ||= str(payload.id) || str(payload.session_id);
      cwd ||= str(payload.cwd);
    }
    if (prompt || row.type !== "response_item" || payload.type !== "message" || payload.role !== "user") continue;
    for (const item of Array.isArray(payload.content) ? payload.content : []) {
      if (item?.type === "input_text" && !prompt) prompt = codexUserText(str(item.text)).text;
    }
  }
  return { id, cwd, prompt, side };
}

const textOf = (content: unknown) => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((block) => (block?.type === "text" ? str(block.text) : "")).join("")
  : content && typeof content === "object" ? str((content as Row).text) : "";

/** Grok：updates.jsonl 开头第一句用户的话（分块的，拼到下一条别的更新为止）。 */
export function grokHead(lines: string[]) {
  let prompt = "", reading = false;
  for (const row of rows(lines)) {
    const update = (row.params?.update ?? {}) as Row;
    if (update.sessionUpdate === "user_message_chunk") { reading = true; prompt += textOf(update.content); }
    else if (reading) break;
  }
  return { prompt: prompt.trim() };
}

/** DeepSeek：session 行里的 id、工作目录、是不是委派出去的子会话；session/title 取最后一个。 */
export function deepseekHead(lines: string[]) {
  let id = "", cwd = "", title = "", prompt = "", side = false;
  for (const row of rows(lines)) {
    if (row.type === "session") { id ||= str(row.id); cwd ||= str(row.cwd); if (Number(row.delegationDepth) > 0) side = true; }
    else if (row.type === "session/title" && typeof row.data?.title === "string") title = row.data.title;
    else if (row.type === "user/message" && !prompt) prompt = textOf(row.data?.content);
  }
  return { id, cwd, title, prompt, side };
}

/** pi：session 行里的 id、工作目录；session_info 里的名字取最后一个。 */
export function piHead(lines: string[]) {
  let id = "", cwd = "", title = "", prompt = "";
  for (const row of rows(lines)) {
    if (row.type === "session") { id ||= str(row.id); cwd ||= str(row.cwd); }
    else if (row.type === "session_info" && typeof row.name === "string") title = row.name;
    else if (row.type === "message" && row.message?.role === "user" && !prompt) prompt = textOf(row.message.content);
  }
  return { id, cwd, title, prompt };
}

type Entry = { file: string; kind: TaskKind; size: number; mtimeMs: number; task: AgentTask | null; inferred: Inferred | null; read: boolean; last?: TaskStatus | null; lastAsk?: string };
/** 子代理的会话文件（Claude 的 subagents/、Grok 的子会话）；parent 是主会话文件。 */
type SubEntry = { file: string; kind: "claude" | "grok"; parent: string; size: number; mtimeMs: number; inferred: Inferred | null; read: boolean };
/** grok / deepseek / pi 不给就不扫（测试只给前三个）。 */
export type ActivityRoots = { claude: string; codex: string; codexIndex: string; grok?: string; deepseek?: string; pi?: string };
export function defaultRoots(): ActivityRoots {
  return {
    claude: path.join(cliDir("claude"), "projects"), codex: path.join(cliDir("chatgpt"), "sessions"), codexIndex: path.join(cliDir("chatgpt"), "session_index.jsonl"),
    grok: path.join(cliDir("grok"), "sessions"), deepseek: path.join(dshRoot(), "sessions"), pi: path.join(piDir(), "sessions"),
  };
}
const DEEPSEEK_FILE = "session.v4.jsonl.zstd";

async function readEnds(file: string, size: number) {
  const handle = await fs.open(file, "r");
  try {
    const part = async (start: number, length: number) => { const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, start); return buffer.subarray(0, bytesRead).toString("utf8"); };
    if (size <= CHUNK * 2) { const all = (await part(0, size)).split(/\r?\n/); return { head: all, tail: all }; }
    const head = (await part(0, CHUNK)).split(/\r?\n/).slice(0, -1);
    const tail = (await part(size - CHUNK, CHUNK)).split(/\r?\n/).slice(1);
    return { head, tail };
  } finally { await handle.close(); }
}

async function list(dir: string) { try { return await fs.readdir(dir, { withFileTypes: true }); } catch { return []; } }

export class ActivityScanner {
  private entries = new Map<string, Entry>();
  private subs = new Map<string, SubEntry>();
  private lastFull = 0;
  private titles = { mtimeMs: -1, map: new Map<string, string>() };
  constructor(private roots: ActivityRoots = defaultRoots(), private now: () => number = Date.now) {}

  /** 两小时内动过的会话文件。Claude 只看 projects/<项目>/ 下直接的 .jsonl；Codex 只看最近 7 天的日期目录。 */
  private async discover(now: number) {
    const found: { file: string; kind: TaskKind }[] = [];
    for (const project of await list(this.roots.claude)) {
      if (!project.isDirectory()) continue;
      const dir = path.join(this.roots.claude, project.name);
      for (const item of await list(dir)) if (item.isFile() && item.name.endsWith(".jsonl")) found.push({ file: path.join(dir, item.name), kind: "claude" });
    }
    const since = new Date(now - 7 * 86_400_000);
    const floor = since.getFullYear() * 10000 + (since.getMonth() + 1) * 100 + since.getDate();
    for (const year of await list(this.roots.codex)) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name) || +year.name < since.getFullYear()) continue;
      for (const month of await list(path.join(this.roots.codex, year.name))) {
        if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
        for (const day of await list(path.join(this.roots.codex, year.name, month.name))) {
          if (!day.isDirectory() || !/^\d{2}$/.test(day.name) || +year.name * 10000 + +month.name * 100 + +day.name < floor) continue;
          const dir = path.join(this.roots.codex, year.name, month.name, day.name);
          for (const item of await list(dir)) if (item.isFile() && item.name.endsWith(".jsonl")) found.push({ file: path.join(dir, item.name), kind: "codex" });
        }
      }
    }
    // Grok：sessions/<工作目录>/<会话 id>/updates.jsonl；DeepSeek：sessions/<项目>/session-<id>/session.v4.jsonl.zstd；pi：sessions/<项目>/*.jsonl
    const nested = async (root: string | undefined, kind: TaskKind, name: string) => {
      if (!root) return;
      for (const project of await list(root)) {
        if (!project.isDirectory()) continue;
        for (const session of await list(path.join(root, project.name))) if (session.isDirectory()) found.push({ file: path.join(root, project.name, session.name, name), kind });
      }
    };
    await nested(this.roots.grok, "grok", "updates.jsonl");
    await nested(this.roots.deepseek, "deepseek", DEEPSEEK_FILE);
    if (this.roots.pi) {
      for (const project of await list(this.roots.pi)) {
        if (!project.isDirectory()) continue;
        const dir = path.join(this.roots.pi, project.name);
        for (const item of await list(dir)) if (item.isFile() && item.name.endsWith(".jsonl")) found.push({ file: path.join(dir, item.name), kind: "pi" });
      }
    }
    for (const { file, kind } of found) {
      if (this.entries.has(file)) continue;
      try {
        const stat = await fs.stat(file);
        if (now - stat.mtimeMs <= KEEP_MS) this.entries.set(file, { file, kind, size: -1, mtimeMs: stat.mtimeMs, task: null, inferred: null, read: false });
      } catch { /* 刚好被删了 */ }
    }
    // 子代理：主会话旁边的 <会话 id>/subagents/，只收最近还在动的
    for (const entry of this.entries.values()) {
      if (entry.kind !== "claude") continue;
      const dir = path.join(entry.file.slice(0, -".jsonl".length), "subagents");
      for (const item of await list(dir)) {
        if (!item.isFile() || !item.name.endsWith(".jsonl")) continue;
        const file = path.join(dir, item.name);
        if (this.subs.has(file)) continue;
        try {
          const stat = await fs.stat(file);
          if (now - stat.mtimeMs <= SUB_STALE_MS) this.subs.set(file, { file, kind: "claude", parent: entry.file, size: -1, mtimeMs: stat.mtimeMs, inferred: null, read: false });
        } catch { /* 刚好被删了 */ }
      }
    }
  }

  /** 下一次 scan 先把目录全扫一遍（会话目录里有文件变了：可能是新会话、新子代理）。 */
  poke() { this.lastFull = 0; }
  /** 值得盯着的目录（里面的 .jsonl 变了就该看一次）。 */
  watchRoots() { return [this.roots.claude, this.roots.codex, this.roots.grok, this.roots.deepseek, this.roots.pi].filter((dir): dir is string => !!dir); }

  /** 各主会话下正在跑的子代理：个数、最近一次动静。 */
  private async scanSubs(now: number) {
    const out = new Map<string, { count: number; at: number }>();
    for (const sub of [...this.subs.values()]) {
      let stat;
      try { stat = await fs.stat(sub.file); } catch { this.subs.delete(sub.file); continue; }
      if (!sub.read || stat.size !== sub.size || stat.mtimeMs !== sub.mtimeMs) {
        sub.size = stat.size; sub.mtimeMs = stat.mtimeMs; sub.read = true;
        try {
          const { tail } = await readEnds(sub.file, sub.size);
          sub.inferred = sub.kind === "grok" ? inferGrok(tail) : inferClaude(tail, { sidechain: true });
        } catch { sub.inferred = null; }
      }
      if (now - sub.mtimeMs > SUB_STALE_MS) { this.subs.delete(sub.file); continue; }
      if (!sub.inferred || sub.inferred.status === "done") continue;
      const hit = out.get(sub.parent) ?? { count: 0, at: 0 };
      out.set(sub.parent, { count: hit.count + 1, at: Math.max(hit.at, sub.mtimeMs) });
    }
    return out;
  }

  private async codexTitle(id: string) {
    try {
      const stat = await fs.stat(this.roots.codexIndex);
      if (stat.mtimeMs !== this.titles.mtimeMs) {
        const map = new Map<string, string>();
        for (const row of rows((await fs.readFile(this.roots.codexIndex, "utf8")).split(/\r?\n/))) if (typeof row.id === "string" && typeof row.thread_name === "string") map.set(row.id, row.thread_name);
        this.titles = { mtimeMs: stat.mtimeMs, map };
      }
    } catch { /* 没有索引就用第一句提问 */ }
    return this.titles.map.get(id) ?? "";
  }

  private async load(entry: Entry) {
    if (entry.kind === "deepseek") {
      const lines = zstdFrames(await fs.readFile(entry.file)).text.split("\n");
      entry.read = true;
      const top = deepseekHead(lines);
      if (top.side) { entry.inferred = null; entry.task = null; return; }
      const id = top.id || path.basename(path.dirname(entry.file)).replace(/^session-/, "");
      entry.inferred = inferDeepseek(lines);
      entry.task = { key: `deepseek:${id}`, kind: "deepseek", agent: AGENT.deepseek, id, title: clip(top.title || top.prompt || "未命名会话"), project: path.basename(top.cwd), status: "thinking", since: 0, updatedAt: 0 };
      return;
    }
    const { head, tail } = await readEnds(entry.file, entry.size);
    entry.read = true;
    if (entry.kind === "grok") {
      const dir = path.dirname(entry.file);
      let summary: Row = {};
      try { summary = JSON.parse(await fs.readFile(path.join(dir, "summary.json"), "utf8")) ?? {}; } catch { /* 刚建的会话还没有 */ }
      if (summary.session_kind === "subagent") { entry.inferred = null; entry.task = null; return; }
      let cwd = str(summary.info?.cwd);
      try { cwd ||= decodeURIComponent(path.basename(path.dirname(dir))); } catch { /* 目录名不是编码过的路径 */ }
      const id = path.basename(dir);
      entry.inferred = inferGrok(tail);
      entry.task = { key: `grok:${id}`, kind: "grok", agent: AGENT.grok, id, title: clip(str(summary.generated_title) || grokHead(head).prompt || "未命名会话"), project: path.basename(cwd), status: "thinking", since: 0, updatedAt: 0 };
      // 子代理是同一工作目录下的另一个会话
      for (const child of entry.inferred?.children ?? []) {
        const file = path.join(path.dirname(dir), child, "updates.jsonl");
        if (!this.subs.has(file)) this.subs.set(file, { file, kind: "grok", parent: entry.file, size: -1, mtimeMs: 0, inferred: null, read: false });
      }
      return;
    }
    if (entry.kind === "pi") {
      const top = piHead(head), end = piHead(tail);
      const id = top.id || path.basename(entry.file, ".jsonl").replace(/^[\dT:.Z-]+_/, "");
      entry.inferred = inferPi(tail);
      entry.task = { key: `pi:${id}`, kind: "pi", agent: AGENT.pi, id, title: clip(end.title || top.title || top.prompt || "未命名会话"), project: path.basename(top.cwd), status: "thinking", since: 0, updatedAt: 0 };
      return;
    }
    if (entry.kind === "claude") {
      const top = claudeHead(head), end = claudeHead(tail);
      if (top.side) { entry.inferred = null; entry.task = null; return; }
      const id = top.id || end.id || path.basename(entry.file, ".jsonl");
      entry.inferred = inferClaude(tail);
      entry.task = { key: `claude:${id}`, kind: "claude", agent: AGENT.claude, id, title: clip(end.title || top.title || top.prompt || end.prompt || "未命名会话"), project: path.basename(top.cwd || end.cwd || ""), status: "thinking", since: 0, updatedAt: 0 };
    } else {
      const top = codexHead(head);
      if (top.side) { entry.inferred = null; entry.task = null; return; }
      const id = top.id || path.basename(entry.file, ".jsonl").replace(/^rollout-[\dT:-]+-/, "");
      entry.inferred = inferCodex(tail);
      entry.task = { key: `codex:${id}`, kind: "codex", agent: AGENT.codex, id, title: clip((await this.codexTitle(id)) || top.prompt || "未命名会话"), project: path.basename(top.cwd || ""), status: "thinking", since: 0, updatedAt: 0 };
    }
  }

  async scan(): Promise<ActivityState> {
    const now = this.now();
    if (now - this.lastFull >= FULL_SCAN_MS) { this.lastFull = now; await this.discover(now); }
    const running: AgentTask[] = [], recent: AgentTask[] = [], finished: string[] = [], failed: string[] = [], needsYou: string[] = [], asked: string[] = [];
    const subs = await this.scanSubs(now);
    for (const entry of [...this.entries.values()]) {
      let stat;
      try { stat = await fs.stat(entry.file); } catch { this.entries.delete(entry.file); continue; }
      if (!entry.read || stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs) {
        entry.size = stat.size; entry.mtimeMs = stat.mtimeMs;
        try { await this.load(entry); } catch { entry.inferred = null; entry.task = null; }
      }
      // 有子代理在跑：按两边最近的动静算；这一轮已经结束的（后台子代理还在跑）当作在跑子代理
      const sub = entry.task ? subs.get(entry.file) : undefined, seen = Math.max(entry.mtimeMs, sub?.at ?? 0);
      const inferred = sub && entry.inferred?.status === "done" ? { ...entry.inferred, status: "tool" as const, tool: "Agent", doneAt: undefined, ended: undefined } : entry.inferred;
      const status = inferred ? liveStatus(inferred, seen, now) : null;
      if (entry.task && inferred && status) {
        const ask = status === "done" ? undefined : inferred.ask;
        const task: AgentTask = { ...entry.task, status, tool: status === "done" ? undefined : inferred.tool, since: inferred.since, updatedAt: seen, doneAt: inferred.doneAt, ...(ask ? { ask } : {}), ...(sub && status !== "done" ? { subagents: sub.count } : {}) };
        if (status !== "done") running.push(task);
        else if (task.doneAt && now - task.doneAt <= RECENT_MS) recent.push(task);
        if (status === "done" && entry.last && entry.last !== "done") {
          if (inferred.ended === "error") failed.push(task.key);
          else if (inferred.ended !== "interrupted") finished.push(task.key);
        }
        // 第一次扫描（entry.last 还是 undefined）不算：免得一启动就响
        if (ask && entry.last !== undefined && entry.lastAsk !== ask.id) asked.push(task.key);
        else if (!ask && status === "waiting" && entry.last && entry.last !== "waiting") needsYou.push(task.key);
      }
      entry.last = status;
      entry.lastAsk = status && status !== "done" ? inferred?.ask?.id : undefined;
      if (now - entry.mtimeMs > KEEP_MS) this.entries.delete(entry.file);
    }
    // 同一个会话可能有几份文件（Claude 续接旧会话）：只留最新的那份
    const unique = (tasks: AgentTask[]) => [...new Map(tasks.sort((a, b) => a.updatedAt - b.updatedAt).map((task) => [task.key, task])).values()];
    const live = unique(running).sort((a, b) => b.updatedAt - a.updatedAt);
    const busy = new Set(live.map((task) => task.key));
    return { at: now, running: live, recent: unique(recent).filter((task) => !busy.has(task.key)).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)).slice(0, 3), finished: [...new Set(finished)].filter((key) => !busy.has(key)), failed: [...new Set(failed)].filter((key) => !busy.has(key)), needsYou: [...new Set(needsYou)], asked: [...new Set(asked)] };
  }
}
