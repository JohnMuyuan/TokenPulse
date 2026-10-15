import fs from "fs";
import path from "path";
import { dataFile, readJson, writeJson } from "./paths";
import { parseSessionFile, sessionFiles, sessionTextFile, type AgentKind } from "./sessions";

/**
 * 会话全文搜索（0.3.55）：在 Claude Code / Codex / Grok Build / DeepSeek Harness 的所有会话里搜对话内容。
 *
 * - 文字从会话管理同一套解析器来（sessions.ts），所以搜到的消息 id 和打开详情时的一致，能直接跳过去；
 * - 每个会话文件抽出的纯文字缓存在 `~/.tokenpulse/session-text/`（只重抽大小或修改时间变了的），
 *   一行一条消息：`消息 id \t 角色 \t 文字`。用户和 AI 说的话全文都进；工具调用只进名字和那一行概要（命令、文件路径），
 *   工具的输出不进（太大，也不是「聊过什么」）；
 * - 几个词用空格隔开 = 这些词都要在同一段会话里出现（不必在同一条消息里）。不分大小写；
 * - 只读本机文件，在 worker 里跑。缓存只在本机，会话在 CLI 里删掉之后，下次搜索时一起清掉。
 */

export type SearchSnippet = { id: string; role: "user" | "assistant" | "tool"; text: string };
export type SearchHit = {
  key: string;
  kind: AgentKind;
  id: string;
  /** 命中的消息条数。 */
  count: number;
  /** 最多 3 条片段，含词最多的优先。 */
  snippets: SearchSnippet[];
  /** 命中的消息 id（按对话顺序，最多 MAX_IDS 个），详情里「上一处 / 下一处」用。 */
  ids: string[];
};
export type SearchResult = { query: string; terms: string[]; hits: SearchHit[]; ms: number; /** 这次新抽了多少个文件的文字。 */ indexed: number };

const VERSION = 1;
const MAX_TERMS = 8;
const MAX_HITS = 500;
const MAX_IDS = 500;
const BEFORE = 36;
const AFTER = 110;

type CacheIndex = { version: number; files: Record<string, { size: number; mtimeMs: number }> };

function cacheIndexFile() {
  return dataFile(path.join("session-text", "index.json"));
}

/** 搜索词：按空白切开、去重、转小写。 */
export function searchTerms(query: string) {
  return [...new Set(String(query || "").toLowerCase().split(/\s+/).filter(Boolean))].slice(0, MAX_TERMS);
}

function flat(text: string) {
  return text.replace(/[\t\r\n]+/g, " ").trim();
}

/** 一个会话文件 → 缓存文字。 */
function extract(kind: AgentKind, file: string) {
  const parsed = parseSessionFile(kind, file);
  if (!parsed) return "";
  const lines: string[] = [];
  for (const message of parsed.messages) {
    if (message.role === "user" || message.role === "assistant") lines.push(`${message.id}\t${message.role}\t${flat(message.text)}`);
    else if (message.role === "tool") lines.push(`${message.id}\ttool\t${flat(`${message.name} ${message.summary}`)}`);
  }
  return lines.join("\n");
}

/** 片段：第一个出现的词前面留一点、后面多留一些。 */
function snippetOf(text: string, lower: string, terms: string[]) {
  const at = Math.min(...terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0));
  const start = Math.max(0, at - BEFORE);
  const end = Math.min(text.length, at + AFTER);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function searchSessions(query: unknown, kind?: unknown): SearchResult {
  const started = Date.now();
  const text = typeof query === "string" ? query.slice(0, 200) : "";
  const terms = searchTerms(text);
  if (!terms.length || terms.join("").length < 2) return { query: text, terms, hits: [], ms: 0, indexed: 0 };

  const all = sessionFiles();
  const files = all.filter((item) => !kind || kind === "all" || item.summary.kind === kind);
  const stored = readJson<CacheIndex | null>(cacheIndexFile(), null);
  const cache: CacheIndex = stored?.version === VERSION ? stored : { version: VERSION, files: {} };
  let changed = stored?.version !== VERSION;
  let indexed = 0;
  for (const item of files) {
    const hit = cache.files[item.file];
    const target = sessionTextFile(item.file);
    if (hit && hit.size === item.size && hit.mtimeMs === item.mtimeMs && fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, extract(item.summary.kind, item.file), { mode: 0o600 });
    cache.files[item.file] = { size: item.size, mtimeMs: item.mtimeMs };
    changed = true;
    indexed += 1;
  }
  // 会话文件已经没了（在 CLI 里删掉了）：缓存的文字一起删
  const alive = new Set(all.map((item) => item.file));
  for (const file of Object.keys(cache.files)) {
    if (alive.has(file)) continue;
    fs.rmSync(sessionTextFile(file), { force: true });
    delete cache.files[file];
    changed = true;
  }
  if (changed) writeJson(cacheIndexFile(), cache);

  const byKey = new Map<string, SearchHit & { updatedAt: number }>();
  for (const item of files) {
    let body: string;
    try { body = fs.readFileSync(sessionTextFile(item.file), "utf8"); } catch { continue; }
    const lowerBody = body.toLowerCase();
    if (!terms.every((term) => lowerBody.includes(term))) continue;
    const ids: string[] = [];
    const scored: { score: number; order: number; snippet: SearchSnippet }[] = [];
    let count = 0;
    body.split("\n").forEach((line, order) => {
      const first = line.indexOf("\t"), second = line.indexOf("\t", first + 1);
      if (first < 0 || second < 0) return;
      const message = line.slice(second + 1);
      const lower = message.toLowerCase();
      const found = terms.filter((term) => lower.includes(term));
      if (!found.length) return;
      count += 1;
      const id = line.slice(0, first);
      if (ids.length < MAX_IDS) ids.push(id);
      scored.push({ score: found.length, order, snippet: { id, role: line.slice(first + 1, second) as SearchSnippet["role"], text: snippetOf(message, lower, found) } });
    });
    const snippets = scored.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, 3).sort((a, b) => a.order - b.order).map((entry) => entry.snippet);
    const updatedAt = item.summary.updatedAt ?? 0;
    const previous = byKey.get(item.summary.key);
    // 同一个会话有几份文件（Codex 续过的会话）：片段和跳转用最新那份（详情读的就是它），条数加起来
    if (previous && previous.updatedAt >= updatedAt) { previous.count += count; continue; }
    byKey.set(item.summary.key, { key: item.summary.key, kind: item.summary.kind, id: item.summary.id, count: count + (previous?.count ?? 0), snippets, ids, updatedAt });
  }
  const hits = [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_HITS).map(({ updatedAt: _updatedAt, ...hit }) => hit);
  return { query: text, terms, hits, ms: Date.now() - started, indexed };
}
