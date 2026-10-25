import fs from "node:fs/promises";
import path from "node:path";
import { cliDir } from "./credentials";
import { claudeUserText, codexUserText } from "./sessions";

/**
 * 桌宠用的「本机 Agent 现在在干什么」（0.3.61）。只读会话文件，不改任何 CLI 的配置。
 *
 * | CLI | 一轮开始 | 在跑工具 | 一轮结束 |
 * |-----|---------|---------|---------|
 * | Claude Code | user 行里真正的提问 | assistant 行有 tool_use（stop_reason=tool_use），之后还没有 tool_result | assistant stop_reason=end_turn，或 system 行 turn_duration / stop_hook_summary；用户中断 |
 * | Codex | event_msg task_started | response_item function_call / custom_tool_call 还没有对应的 *_output | event_msg task_complete / turn_aborted |
 *
 * 只读文件开头（会话 id、工作目录、是不是子会话、第一句提问）和结尾（最近的状态、Claude 的 ai-title），各 64 KB。
 * 目录 30 秒全扫一次，记下两小时内动过的文件；之间每次只 stat 这些文件，变了才重读。
 * 子代理（Claude 的 subagents/、isSidechain；Codex 带 parent_thread_id 的子会话）不算单独的任务。
 * Claude 的子代理记在主会话旁边的 <会话 id>/subagents/agent-*.jsonl：没结束、SUB_STALE_MS 内动过的算在跑，
 * 记到主会话的 subagents 上（桌宠按它换「同时忙好几件」的姿势）。子代理在跑时主文件可能很久不动，主会话按两边最近的动静算，
 * 不会被当成「可能在等你」或过期；主会话这一轮已经结束、后台子代理还在跑的，也算在跑。
 *
 * 在问你（askOf）：Claude 的 AskUserQuestion（选择题）、ExitPlanMode（计划等你批准），Codex 的 request_user_input，
 * 调用已经写进会话文件、还没有结果，就是在等你回答。只拿来显示，回答还是在终端里。
 */

export type TaskStatus = "thinking" | "tool" | "waiting" | "done";
export type TaskKind = "claude" | "codex";
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
export type Inferred = { status: TaskStatus; since: number; at: number; tool?: string; doneAt?: number; ended?: TurnEnd; ask?: AgentAsk };

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
const AGENT: Record<TaskKind, string> = { claude: "Claude Code", codex: "Codex" };

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
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : 0;
}
const str = (value: unknown) => (typeof value === "string" ? value : "");
const DONE_STOPS = new Set(["end_turn", "max_tokens", "stop_sequence", "refusal"]);

const ASK_LIMITS = { questions: 4, options: 6, header: 40, question: 300, label: 80, description: 160, plan: 1200 };
const cut = (value: unknown, max: number) => { const text = str(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim(); return text.length > max ? text.slice(0, max - 1) + "…" : text; };
/** 工具调用是不是在问你；是的话收成要显示的样子（字数、个数都有上限）。不是返回 null。 */
export function askOf(tool: string, input: unknown, id: string, at: number): AgentAsk | null {
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

/** 推出来的状态再看文件多久没动：太久没动的不算在跑；工具调用卡太久写成「可能在等你」；在问你的马上就是在等你。 */
export function liveStatus(inferred: Inferred, mtimeMs: number, now: number): TaskStatus | null {
  if (inferred.status === "done") return "done";
  if (inferred.ask) return now - mtimeMs > ASK_STALE_MS ? null : "waiting";
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

type Entry = { file: string; kind: TaskKind; size: number; mtimeMs: number; task: AgentTask | null; inferred: Inferred | null; read: boolean; last?: TaskStatus | null; lastAsk?: string };
/** Claude 子代理的会话文件；parent 是主会话文件。 */
type SubEntry = { file: string; parent: string; size: number; mtimeMs: number; inferred: Inferred | null; read: boolean };
export type ActivityRoots = { claude: string; codex: string; codexIndex: string };
export function defaultRoots(): ActivityRoots {
  return { claude: path.join(cliDir("claude"), "projects"), codex: path.join(cliDir("chatgpt"), "sessions"), codexIndex: path.join(cliDir("chatgpt"), "session_index.jsonl") };
}

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
          if (now - stat.mtimeMs <= SUB_STALE_MS) this.subs.set(file, { file, parent: entry.file, size: -1, mtimeMs: stat.mtimeMs, inferred: null, read: false });
        } catch { /* 刚好被删了 */ }
      }
    }
  }

  /** 下一次 scan 先把目录全扫一遍（会话目录里有文件变了：可能是新会话、新子代理）。 */
  poke() { this.lastFull = 0; }
  /** 值得盯着的目录（里面的 .jsonl 变了就该看一次）。 */
  watchRoots() { return [this.roots.claude, this.roots.codex]; }

  /** 各主会话下正在跑的子代理：个数、最近一次动静。 */
  private async scanSubs(now: number) {
    const out = new Map<string, { count: number; at: number }>();
    for (const sub of [...this.subs.values()]) {
      let stat;
      try { stat = await fs.stat(sub.file); } catch { this.subs.delete(sub.file); continue; }
      if (!sub.read || stat.size !== sub.size || stat.mtimeMs !== sub.mtimeMs) {
        sub.size = stat.size; sub.mtimeMs = stat.mtimeMs; sub.read = true;
        try { sub.inferred = inferClaude((await readEnds(sub.file, sub.size)).tail, { sidechain: true }); } catch { sub.inferred = null; }
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
    const { head, tail } = await readEnds(entry.file, entry.size);
    entry.read = true;
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
