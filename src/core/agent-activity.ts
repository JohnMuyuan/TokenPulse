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
 */

export type TaskStatus = "thinking" | "tool" | "waiting" | "done";
export type TaskKind = "claude" | "codex";
export type AgentTask = { key: string; kind: TaskKind; agent: string; id: string; title: string; project: string; status: TaskStatus; tool?: string; since: number; updatedAt: number; doneAt?: number };
/** finished：上一次看还在跑、这一次结束了的任务（桌宠据此庆祝一下）。第一次扫描不算，免得一启动就庆祝。 */
export type ActivityState = { at: number; running: AgentTask[]; recent: AgentTask[]; finished: string[] };
export type Inferred = { status: TaskStatus; since: number; at: number; tool?: string; doneAt?: number };

/** 一轮没结束、文件却这么久没动：多半是终端关了或者进程崩了，不再算在跑。 */
export const STALE_MS = 10 * 60_000;
/** 工具调用发出去这么久还没结果：可能在等用户确认，也可能只是工具跑得久，界面上写「可能在等你」。 */
export const WAITING_MS = 90_000;
/** 任务列表里「刚完成」保留多久。 */
export const RECENT_MS = 10 * 60_000;
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

/** Claude Code：按文件结尾的若干行推出这一轮的状态。读不出任何对话行返回 null。 */
export function inferClaude(lines: string[]): Inferred | null {
  let status = null as TaskStatus | null, since = 0, at = 0, first = 0, tool: string | undefined, doneAt: number | undefined;
  for (const row of rows(lines)) {
    if (row.isSidechain || row.isMeta) continue;
    const t = stamp(row.timestamp) || at;
    if (row.type === "system") {
      if ((row.subtype === "turn_duration" || row.subtype === "stop_hook_summary") && status && status !== "done") { status = "done"; doneAt = t; tool = undefined; }
      continue;
    }
    if (row.type !== "user" && row.type !== "assistant") continue;
    if (t) { at = t; first ||= t; }
    const message = (row.message ?? {}) as Row;
    const content = message.content ?? row.content;
    const blocks = (Array.isArray(content) ? content : [{ type: "text", text: str(content) }]) as Row[];
    if (row.type === "user") {
      if (blocks.some((block) => block?.type === "tool_result")) {
        if (status !== "done") { status = "thinking"; tool = undefined; }
        continue;
      }
      for (const block of blocks) {
        if (block?.type !== "text") continue;
        const cleaned = claudeUserText(str(block.text));
        if (cleaned.event === "已中断") { status = "done"; doneAt = t; tool = undefined; }
        else if (cleaned.text) { status = "thinking"; since = t; tool = undefined; doneAt = undefined; }
      }
      continue;
    }
    if (DONE_STOPS.has(str(message.stop_reason))) { status = "done"; doneAt = t; tool = undefined; continue; }
    // 这一轮的提问在读到的范围之前：以第一条回复为准
    if (status === null || status === "done") { status = "thinking"; since = t; doneAt = undefined; }
    const use = blocks.filter((block) => block?.type === "tool_use").at(-1);
    if (use) { status = "tool"; tool = str(use.name) || undefined; }
    else if (status === "tool") { status = "thinking"; tool = undefined; }
  }
  if (!status) return null;
  return { status, since: since || first, at, tool, doneAt };
}

/** Codex：task_started / task_complete 之间算在跑；有没回结果的工具调用就是在跑工具。 */
export function inferCodex(lines: string[]): Inferred | null {
  let status: TaskStatus | null = null, since = 0, at = 0, first = 0, tool: string | undefined, doneAt: number | undefined;
  const pending = new Map<string, string>();
  for (const row of rows(lines)) {
    const t = stamp(row.timestamp) || at;
    if (t) { at = t; first ||= t; }
    const payload = (row.payload ?? {}) as Row;
    if (row.type === "event_msg") {
      if (payload.type === "task_started") { status = "thinking"; since = t; tool = undefined; doneAt = undefined; pending.clear(); }
      else if (payload.type === "task_complete" || payload.type === "turn_aborted") { status = "done"; doneAt = t; tool = undefined; pending.clear(); }
      continue;
    }
    if (row.type !== "response_item" || status === "done") continue;
    if (status === null) status = "thinking";
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      pending.set(str(payload.call_id), str(payload.name));
      status = "tool"; tool = str(payload.name) || undefined;
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      pending.delete(str(payload.call_id));
      if (!pending.size) { status = "thinking"; tool = undefined; }
      else { status = "tool"; tool = [...pending.values()].at(-1) || undefined; }
    }
  }
  if (!status) return null;
  return { status, since: since || first, at, tool, doneAt };
}

/** 推出来的状态再看文件多久没动：太久没动的不算在跑；工具调用卡太久写成「可能在等你」。 */
export function liveStatus(inferred: Inferred, mtimeMs: number, now: number): TaskStatus | null {
  if (inferred.status === "done") return "done";
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

type Entry = { file: string; kind: TaskKind; size: number; mtimeMs: number; task: AgentTask | null; inferred: Inferred | null; read: boolean; last?: TaskStatus | null };
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
    const running: AgentTask[] = [], recent: AgentTask[] = [], finished: string[] = [];
    for (const entry of [...this.entries.values()]) {
      let stat;
      try { stat = await fs.stat(entry.file); } catch { this.entries.delete(entry.file); continue; }
      if (!entry.read || stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs) {
        entry.size = stat.size; entry.mtimeMs = stat.mtimeMs;
        try { await this.load(entry); } catch { entry.inferred = null; entry.task = null; }
      }
      const status = entry.inferred ? liveStatus(entry.inferred, entry.mtimeMs, now) : null;
      if (entry.task && entry.inferred && status) {
        const task: AgentTask = { ...entry.task, status, tool: status === "done" ? undefined : entry.inferred.tool, since: entry.inferred.since, updatedAt: entry.mtimeMs, doneAt: entry.inferred.doneAt };
        if (status !== "done") running.push(task);
        else if (task.doneAt && now - task.doneAt <= RECENT_MS) recent.push(task);
        if (status === "done" && entry.last && entry.last !== "done") finished.push(task.key);
      }
      entry.last = status;
      if (now - entry.mtimeMs > KEEP_MS) this.entries.delete(entry.file);
    }
    // 同一个会话可能有几份文件（Claude 续接旧会话）：只留最新的那份
    const unique = (tasks: AgentTask[]) => [...new Map(tasks.sort((a, b) => a.updatedAt - b.updatedAt).map((task) => [task.key, task])).values()];
    const live = unique(running).sort((a, b) => b.updatedAt - a.updatedAt);
    const busy = new Set(live.map((task) => task.key));
    return { at: now, running: live, recent: unique(recent).filter((task) => !busy.has(task.key)).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)).slice(0, 3), finished: [...new Set(finished)].filter((key) => !busy.has(key)) };
  }
}
