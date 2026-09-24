import fs from "fs";
import path from "path";
import { cliDir } from "./credentials";
import { dataFile, readJson, writeJson } from "./paths";

/**
 * 会话管理：把本机各家 CLI 的会话文件读成「一段段对话」。
 *
 * 三家的格式（都对着本机真实文件核过）：
 *
 * | CLI | 文件 | 用户 / AI | 工具 | 标题 |
 * |-----|------|-----------|------|------|
 * | Claude Code | `~/.claude/projects/<项目>/<会话>.jsonl` | `type:user/assistant` 的 `message.content` | `tool_use` 块 + 下一条 user 里的 `tool_result` | `ai-title` 行的 `aiTitle` |
 * | Codex | `~/.codex/sessions/<日期>/rollout-*.jsonl` | `response_item` 里 `role:user/assistant` 的 message | `custom_tool_call` / `function_call` + 对应的 `*_output` | `~/.codex/session_index.jsonl` 的 `thread_name` |
 * | Grok Build | `~/.grok/sessions/<工作目录>/<会话>/updates.jsonl` | `user_message_chunk` / `agent_message_chunk`（分块，要拼） | `tool_call` + `tool_call_update` | 同目录 `summary.json` 的 `generated_title` |
 *
 * **CLI 自己塞进对话的东西不能当成用户说的话**（上一版直接拿来当标题，列表里一片 `<environment_context>`）：
 * - Codex：`<environment_context>`、`# AGENTS.md instructions`、`<turn_aborted>` 等；贴了文件的消息，真正的请求在 `## My request for Codex:` 后面；
 *   `developer` 角色整条不要。同一句话 `event_msg` 里还会再记一遍，只认 `response_item`，不然每句话出现两次。
 * - Claude：`isMeta` 行、`<system-reminder>`、`<command-name>`（斜杠命令，改成一条事件）、`<local-command-stdout>`、
 *   压缩后续上的摘要（改成一条事件）；子代理的记录在 `subagents/` 目录里，不算单独的会话。
 *
 * 速度：上一版每次打开列表、每次点开一个会话都把几百个文件全部重读一遍（本机实测列表 7.6 秒、详情 4 秒），
 * 而且在 worker 里做的内存缓存每次都是新进程、根本用不上。现在摘要按「文件大小 + 修改时间」缓存到
 * `~/.tokenpulse/sessions-index.json`，只重读变了的文件；点开详情只读那一个文件。
 *
 * 只读，不改 CLI 的任何文件。
 */

export type AgentKind = "claude" | "codex" | "grok";

export type SessionMessage =
  | { id: string; role: "user" | "assistant"; text: string; at?: number }
  /** 工具调用：summary 是一行概要（命令 / 文件路径），input / output 展开后看。 */
  | { id: string; role: "tool"; name: string; summary: string; input?: string; output?: string; error?: boolean; at?: number }
  /** 斜杠命令、中断、上下文压缩这类不是对话本身的事件。 */
  | { id: string; role: "event"; text: string; at?: number };

export type SessionSummary = {
  key: string;
  id: string;
  kind: AgentKind;
  title: string;
  project: string;
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
  /** 用户说了几句（一问一答算一轮）。 */
  turns: number;
  messageCount: number;
  toolCount: number;
  models: string[];
  preview: string;
  resumeCommand: string;
};

export type SessionDetail = SessionSummary & { messages: SessionMessage[]; truncated: number };

const MAX_TEXT = 40_000;
const MAX_TOOL_TEXT = 6_000;
/** 详情最多带回这么多条（超长会话只给最后这些，前面标出省略了多少）。 */
const MAX_MESSAGES = 4_000;
const INDEX_VERSION = 2;

type Parsed = Omit<SessionDetail, "truncated"> & { file: string };
type IndexEntry = { size: number; mtimeMs: number; summary: SessionSummary | null };
type SessionIndex = { version: number; files: Record<string, IndexEntry> };

/* ---------------- 小工具 ---------------- */

function timestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === "string") {
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : undefined;
  }
  return undefined;
}

const str = (value: unknown) => (typeof value === "string" ? value : "");
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…（已截断 ${value.length - max} 个字符）` : value);

function clean(value: string) {
  return value.replace(/\u0000/g, "").replace(/\r\n/g, "\n").trim();
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const item = value as Record<string, unknown>;
  for (const key of ["text", "output_text", "input_text", "content", "output", "message"]) {
    const text = textOf(item[key]);
    if (text) return text;
  }
  return "";
}

function stringify(value: unknown) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 工具调用的一行概要：命令、文件路径、搜索词…… 认不出就取第一个字符串参数。 */
function toolSummary(name: string, input: unknown) {
  let args: Record<string, unknown> = {};
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
      else return input.split("\n")[0].slice(0, 160);
    } catch {
      return input.split("\n")[0].slice(0, 160);
    }
  } else if (input && typeof input === "object") args = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "file_path", "path", "filePath", "pattern", "query", "url", "description", "prompt", "skill"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim().slice(0, 160);
    if (Array.isArray(value) && value.length) return value.map(String).join(" ").slice(0, 160);
  }
  const first = Object.values(args).find((value) => typeof value === "string" && value.trim());
  return typeof first === "string" ? first.replace(/\s+/g, " ").slice(0, 160) : name;
}

function projectName(cwd: string | undefined, fallback: string) {
  if (!cwd) return fallback;
  return path.basename(cwd.replace(/[\\/]+$/, "")) || cwd;
}

function commandOf(kind: AgentKind, id: string) {
  return kind === "codex" ? `codex resume ${id}` : `${kind === "claude" ? "claude" : "grok"} --resume ${id}`;
}

const AGENT_NAMES: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex CLI", grok: "Grok Build" };

function readLines(file: string) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

function parseLine(line: string): Record<string, any> | null {
  if (!line || line[0] !== "{") return null;
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** 收消息：同一个角色连着的文字（同一条回复被拆成几块）合并；工具结果按 id 挂回调用上。 */
class Builder {
  messages: SessionMessage[] = [];
  private tools = new Map<string, Extract<SessionMessage, { role: "tool" }>>();
  models = new Set<string>();
  private seq = 0;

  text(role: "user" | "assistant", raw: string, at?: number, mergeKey?: string) {
    const text = clean(raw);
    if (!text) return;
    const last = this.messages.at(-1);
    if (mergeKey && last && last.role === role && (last as { mergeKey?: string }).mergeKey === mergeKey) {
      (last as { text: string }).text = clip(`${(last as { text: string }).text}\n\n${text}`, MAX_TEXT);
      return;
    }
    const message = { id: `m${this.seq++}`, role, text: clip(text, MAX_TEXT), at } as SessionMessage & { mergeKey?: string };
    if (mergeKey) message.mergeKey = mergeKey;
    this.messages.push(message);
  }

  /** Grok 的消息是一小块一小块流出来的，直接接在后面，不加空行。 */
  chunk(role: "user" | "assistant", raw: string, at?: number) {
    if (!raw) return;
    const last = this.messages.at(-1);
    if (last && last.role === role && (last as { open?: boolean }).open) {
      (last as { text: string }).text = clip((last as { text: string }).text + raw, MAX_TEXT);
      return;
    }
    const message = { id: `m${this.seq++}`, role, text: raw, at, open: true } as SessionMessage & { open?: boolean };
    this.messages.push(message);
  }

  close() {
    const last = this.messages.at(-1) as { open?: boolean; text?: string } | undefined;
    if (last?.open) {
      delete last.open;
      if (typeof last.text === "string") last.text = clean(last.text);
    }
  }

  tool(callId: string, name: string, input: unknown, at?: number) {
    this.close();
    const message: Extract<SessionMessage, { role: "tool" }> = {
      id: `m${this.seq++}`,
      role: "tool",
      name: name || "工具",
      summary: toolSummary(name, input),
      input: clip(stringify(input), MAX_TOOL_TEXT) || undefined,
      at,
    };
    this.messages.push(message);
    if (callId) this.tools.set(callId, message);
  }

  toolResult(callId: string, output: unknown, error = false) {
    const hit = this.tools.get(callId);
    if (!hit) return;
    const text = clean(textOf(output) || stringify(output));
    if (text) hit.output = clip(text, MAX_TOOL_TEXT);
    if (error) hit.error = true;
  }

  event(text: string, at?: number) {
    this.close();
    const last = this.messages.at(-1);
    if (last?.role === "event" && last.text === text) return;
    this.messages.push({ id: `m${this.seq++}`, role: "event", text, at });
  }

  finish() {
    this.close();
    for (const message of this.messages) {
      delete (message as { mergeKey?: string }).mergeKey;
      delete (message as { open?: boolean }).open;
      if (message.role !== "tool" && !message.text) message.text = "";
    }
    return this.messages.filter((message) => message.role === "tool" || message.text);
  }
}

/* ---------------- Claude Code ---------------- */

/** 用户那条里 CLI 自己加的东西去掉；整条都是 CLI 加的返回空。 */
function claudeUserText(raw: string): { text: string; event?: string } {
  let text = raw;
  const command = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (command) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
    return { text: "", event: `命令 ${command[1].trim()}${args ? ` ${args}` : ""}` };
  }
  if (/^\s*<local-command-(stdout|stderr|caveat)>/.test(text) || /^\s*Caveat: The messages below/.test(text)) return { text: "" };
  if (/^\s*This session is being continued from a previous conversation/.test(text)) return { text: "", event: "上下文已压缩，从摘要继续" };
  if (/^\s*\[Request interrupted by user/.test(text)) return { text: "", event: "已中断" };
  text = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<(task-notification|user-prompt-submit-hook|bash-stdout|bash-stderr)>[\s\S]*?<\/\1>/g, "")
    .replace(/<bash-input>([\s\S]*?)<\/bash-input>/g, "! $1");
  return { text: text.trim() };
}

function parseClaude(file: string): Parsed | null {
  const b = new Builder();
  let cwd: string | undefined;
  let id = path.basename(file, ".jsonl");
  let title = "";
  for (const line of readLines(file)) {
    const row = parseLine(line);
    if (!row) continue;
    if (row.type === "ai-title" && typeof row.aiTitle === "string") title = row.aiTitle;
    if (row.type !== "user" && row.type !== "assistant") continue;
    if (row.isSidechain || row.isMeta) continue;
    const at = timestamp(row.timestamp);
    if (typeof row.sessionId === "string" && row.sessionId) id = row.sessionId;
    if (typeof row.cwd === "string" && row.cwd) cwd = row.cwd;
    const message = (row.message ?? {}) as Record<string, unknown>;
    const content = message.content ?? row.content;
    if (row.type === "user") {
      if (row.isCompactSummary) {
        b.event("上下文已压缩，从摘要继续", at);
        continue;
      }
      const blocks = Array.isArray(content) ? content : [{ type: "text", text: str(content) }];
      for (const block of blocks as Record<string, unknown>[]) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_result") b.toolResult(str(block.tool_use_id), block.content, block.is_error === true);
        else if (block.type === "image") b.text("user", "[图片]", at, str(row.uuid));
        else if (block.type === "text") {
          const cleaned = claudeUserText(str(block.text));
          if (cleaned.event) b.event(cleaned.event, at);
          if (cleaned.text) b.text("user", cleaned.text, at, str(row.promptId) || str(row.uuid));
        }
      }
    } else {
      if (typeof message.model === "string" && message.model !== "<synthetic>") b.models.add(message.model);
      // 一次回复被拆成多行写（每行一个块），同一个 message.id 的文字拼回一条
      const mergeKey = str(message.id) || str(row.requestId) || str(row.uuid);
      for (const block of (Array.isArray(content) ? content : [{ type: "text", text: str(content) }]) as Record<string, unknown>[]) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text") b.text("assistant", str(block.text), at, mergeKey);
        else if (block.type === "tool_use") b.tool(str(block.id), str(block.name), block.input, at);
      }
    }
  }
  return summarize("claude", id, b, cwd, title, file);
}

/* ---------------- Codex ---------------- */

/** Codex 塞进 user 角色的环境、指令、中断标记。 */
function codexUserText(raw: string): { text: string; event?: string } {
  const text = raw.trim();
  if (/^<turn_aborted>/.test(text)) return { text: "", event: "已中断" };
  if (/^# AGENTS\.md instructions/.test(text)) return { text: "" };
  // AllAi 拿 Codex 当聊天后端时，把自己的系统提示和历史拼在用户这句话前面（electron/chat-run.ts）
  if (/^You are a helpful chat assistant/.test(text)) {
    const now = text.split("【以上是历史。用户此刻的问题】");
    return codexUserText(now.length > 1 ? now.at(-1)! : text.replace(/^[^\n]*\n+/, ""));
  }
  // `<environment_context>…</environment_context>`、`<recommended_plugins>…`、`<image …>` 这类：
  // 开头一个或几个成对的标签块都是 Codex 自己加的，剥掉；剩下的才是用户写的（通常什么都不剩）
  const stripped = text.replace(/^(\s*<([a-z_]+)(\s[^>]*)?>[\s\S]*?<\/\2>\s*)+/i, "").replace(/^\s*<\/?[a-z_]+(\s[^>]*)?>\s*$/i, "").trim();
  if (stripped !== text) return codexUserText(stripped);
  // 贴了文件的消息：前面是文件清单，真正的请求在这句后面
  const request = text.split(/^## My request for Codex:\s*$/m);
  if (request.length > 1) return { text: request.at(-1)!.trim() };
  return { text };
}

let codexTitles: Map<string, string> | null = null;
function codexTitle(id: string) {
  if (!codexTitles) {
    codexTitles = new Map();
    for (const line of readLines(path.join(cliDir("chatgpt"), "session_index.jsonl"))) {
      const row = parseLine(line);
      if (row && typeof row.id === "string" && typeof row.thread_name === "string") codexTitles.set(row.id, row.thread_name);
    }
  }
  return codexTitles.get(id) ?? "";
}

function parseCodex(file: string): Parsed | null {
  const b = new Builder();
  let cwd: string | undefined;
  let id = "";
  for (const line of readLines(file)) {
    const row = parseLine(line);
    if (!row) continue;
    const at = timestamp(row.timestamp);
    const payload = (row.payload ?? {}) as Record<string, any>;
    if (row.type === "session_meta") {
      // Codex 自己派出去的子会话（审查 guardian_review、子任务）：带 parent_thread_id / source.subagent，
      // 第一句是「The following is the Codex agent history…」。和 Claude 的 subagents 一样，不单独列。
      if (payload.parent_thread_id || (payload.source && typeof payload.source === "object" && "subagent" in payload.source)) return null;
      id = str(payload.id) || str(payload.session_id) || id;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      continue;
    }
    if (row.type === "turn_context" && typeof payload.model === "string") b.models.add(payload.model);
    if (row.type === "compacted") b.event("上下文已压缩", at);
    if (row.type !== "response_item") continue;
    if (payload.type === "message") {
      if (payload.role === "user") {
        const parts: string[] = [];
        for (const item of Array.isArray(payload.content) ? payload.content : []) {
          if (item?.type === "input_image") parts.push("[图片]");
          if (item?.type !== "input_text") continue;
          const cleaned = codexUserText(str(item.text));
          if (cleaned.event) b.event(cleaned.event, at);
          if (cleaned.text) parts.push(cleaned.text);
        }
        const text = parts.join("\n\n").trim();
        if (text && text !== "[图片]") b.text("user", text, at);
      } else if (payload.role === "assistant") {
        b.text("assistant", textOf(payload.content), at);
      }
    } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      b.tool(str(payload.call_id), str(payload.name), payload.arguments ?? payload.input, at);
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      b.toolResult(str(payload.call_id), payload.output);
    }
  }
  if (!id) id = path.basename(file, ".jsonl").replace(/^rollout-[\dT:-]+-/, "");
  return summarize("codex", id, b, cwd, codexTitle(id), file);
}

/* ---------------- Grok Build ---------------- */

function parseGrok(file: string): Parsed | null {
  const b = new Builder();
  const sessionDir = path.dirname(file);
  const id = path.basename(sessionDir);
  let cwd: string | undefined;
  try {
    cwd = decodeURIComponent(path.basename(path.dirname(sessionDir)));
  } catch {
    cwd = undefined;
  }
  const summary = readJson<Record<string, unknown> | null>(path.join(sessionDir, "summary.json"), null);
  if (typeof summary?.current_model_id === "string") b.models.add(summary.current_model_id);
  let at: number | undefined;
  for (const line of readLines(file)) {
    const row = parseLine(line);
    if (!row) continue;
    at = timestamp(row.timestamp) ?? at;
    const update = (row.params?.update ?? {}) as Record<string, any>;
    const kind = str(update.sessionUpdate);
    if (kind === "user_message_chunk") b.chunk("user", textOf(update.content), at);
    else if (kind === "agent_message_chunk") b.chunk("assistant", textOf(update.content), at);
    else if (kind === "tool_call") b.tool(str(update.toolCallId), str(update.title) || str(update.kind), update.rawInput, at);
    else if (kind === "tool_call_update" && (update.status === "completed" || update.status === "failed")) {
      b.toolResult(str(update.toolCallId), update.rawOutput ?? update.content, update.status === "failed");
    } else if (kind === "turn_completed") b.close();
  }
  return summarize("grok", id, b, cwd, str(summary?.generated_title), file);
}

/* ---------------- 汇总 ---------------- */

function summarize(kind: AgentKind, id: string, b: Builder, cwd: string | undefined, cliTitle: string, file: string): Parsed | null {
  const messages = b.finish();
  const talk = messages.filter((message) => message.role === "user" || message.role === "assistant");
  if (!talk.length) return null;
  const firstUser = messages.find((message) => message.role === "user") as { text: string } | undefined;
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  const project = projectName(cwd, AGENT_NAMES[kind]);
  const title = oneLine(cliTitle) || (firstUser ? oneLine(firstUser.text).slice(0, 80) : `${project} · ${AGENT_NAMES[kind]}`);
  const times = messages.map((message) => message.at).filter((at): at is number => typeof at === "number");
  let updatedAt = times.length ? Math.max(...times) : undefined;
  try {
    // 会话文件最后写入的时间比最后一条消息的时间更准（Grok 的分块没有时间戳）
    updatedAt = Math.max(updatedAt ?? 0, fs.statSync(file).mtimeMs);
  } catch {
    // 用消息时间
  }
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant") as { text: string } | undefined;
  return {
    key: `${kind}:${id}`,
    id,
    kind,
    title,
    project,
    cwd,
    createdAt: times.length ? Math.min(...times) : undefined,
    updatedAt,
    turns: messages.filter((message) => message.role === "user").length,
    messageCount: talk.length,
    toolCount: messages.filter((message) => message.role === "tool").length,
    models: [...b.models].slice(0, 6),
    preview: oneLine((lastAssistant ?? firstUser)?.text ?? "").slice(0, 140),
    resumeCommand: commandOf(kind, id),
    messages,
    file,
  };
}

/* ---------------- 找文件、索引 ---------------- */

function walk(dir: string, match: (file: string) => boolean, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // Claude 子代理的记录：属于主会话的一部分，不单独列
    if (entry.isDirectory()) {
      if (entry.name !== "subagents") walk(full, match, out, depth + 1);
    } else if (entry.isFile() && match(full)) out.push(full);
  }
  return out;
}

function sources(): { kind: AgentKind; files: string[] }[] {
  return [
    { kind: "claude", files: walk(path.join(cliDir("claude"), "projects"), (file) => file.endsWith(".jsonl")) },
    { kind: "codex", files: walk(path.join(cliDir("chatgpt"), "sessions"), (file) => file.endsWith(".jsonl")) },
    { kind: "grok", files: walk(path.join(cliDir("grok"), "sessions"), (file) => path.basename(file) === "updates.jsonl") },
  ];
}

function parseFile(kind: AgentKind, file: string) {
  return kind === "claude" ? parseClaude(file) : kind === "codex" ? parseCodex(file) : parseGrok(file);
}

function stripFile(parsed: Parsed): SessionSummary {
  const { file: _file, messages: _messages, ...summary } = parsed;
  return summary;
}

function indexFile() {
  return dataFile("sessions-index.json");
}

/** 列表。只重读大小或修改时间变了的会话文件。 */
export function listSessions(): SessionSummary[] {
  const stored = readJson<SessionIndex | null>(indexFile(), null);
  const previous = stored?.version === INDEX_VERSION ? stored.files : {};
  const next: SessionIndex = { version: INDEX_VERSION, files: {} };
  let changed = !stored || stored.version !== INDEX_VERSION;
  for (const { kind, files } of sources()) {
    for (const file of files) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      const hit = previous[file];
      if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
        next.files[file] = hit;
        continue;
      }
      const parsed = parseFile(kind, file);
      next.files[file] = { size: stat.size, mtimeMs: stat.mtimeMs, summary: parsed ? stripFile(parsed) : null };
      changed = true;
    }
  }
  if (Object.keys(previous).some((file) => !(file in next.files))) changed = true;
  if (changed) writeJson(indexFile(), next);
  // 同一个会话被拆到多个文件里（Codex 续过的会话）：留最近那份
  const byKey = new Map<string, SessionSummary>();
  for (const entry of Object.values(next.files)) {
    const summary = entry.summary;
    if (!summary) continue;
    const other = byKey.get(summary.key);
    if (!other || (summary.updatedAt ?? 0) > (other.updatedAt ?? 0)) byKey.set(summary.key, summary);
  }
  return [...byKey.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function fileOf(kind: AgentKind, id: string) {
  const index = readJson<SessionIndex | null>(indexFile(), null);
  const candidates = Object.entries(index?.files ?? {})
    .filter(([, entry]) => entry.summary?.kind === kind && entry.summary.id === id)
    .sort((a, b) => (b[1].summary?.updatedAt ?? 0) - (a[1].summary?.updatedAt ?? 0));
  return candidates[0]?.[0];
}

/** 详情：只读这一个会话文件。索引里没有（新会话）就先刷新一遍列表。 */
export function getSession(kind: unknown, id: unknown): SessionDetail | null {
  if ((kind !== "claude" && kind !== "codex" && kind !== "grok") || typeof id !== "string" || !id || id.length > 200) return null;
  let file = fileOf(kind, id);
  if (!file || !fs.existsSync(file)) {
    listSessions();
    file = fileOf(kind, id);
  }
  if (!file) return null;
  const parsed = parseFile(kind, file);
  if (!parsed) return null;
  const { file: _file, ...detail } = parsed;
  const truncated = Math.max(0, detail.messages.length - MAX_MESSAGES);
  return { ...detail, messages: truncated ? detail.messages.slice(-MAX_MESSAGES) : detail.messages, truncated };
}

export function sessionCommand(kind: AgentKind, id: string) {
  return commandOf(kind, id);
}
