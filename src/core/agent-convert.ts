/**
 * 本地路由的协议转换。
 *
 * 客户端协议和供应商协议相同时不经过这里，原样流式转发。
 * 不同时，先收成同一种对话（文本 + 函数调用），再写成上游的请求，响应再写回客户端的协议。
 */
import type { Upstream } from "./agent-types";

type ToolDef = { name: string; description: string; schema: unknown };
type ToolCall = { id: string; name: string; args: string };
type Turn = { role: "user" | "assistant" | "tool"; text: string; calls?: ToolCall[]; callId?: string };
type Norm = { system: string; turns: Turn[]; tools: ToolDef[]; stream: boolean; maxTokens: number };

export type Delta =
  | { kind: "text"; text: string }
  | { kind: "tool-start"; id: string; name: string }
  | { kind: "tool-args"; id: string; args: string }
  | { kind: "stop"; reason: string }
  | { kind: "usage"; input: number; output: number };

type Obj = Record<string, unknown>;

const asObj = (value: unknown): Obj => (value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});
const asArr = (value: unknown) => (Array.isArray(value) ? value : []);
const textOf = (value: unknown) => (typeof value === "string" ? value : "");

function textBlocks(value: unknown) {
  if (typeof value === "string") return value;
  return asArr(value)
    .map((block) => {
      const item = asObj(block);
      return textOf(item.text) || textOf(item.content);
    })
    .filter(Boolean)
    .join("");
}

function normFrom(client: Upstream, raw: unknown): Norm {
  const body = asObj(raw);
  const norm: Norm = { system: "", turns: [], tools: [], stream: body.stream === true, maxTokens: 8192 };
  const max = Number(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens);
  if (Number.isFinite(max) && max > 0) norm.maxTokens = max;

  if (client === "anthropic") {
    norm.system = textBlocks(body.system);
    for (const message of asArr(body.messages)) {
      const item = asObj(message);
      const role = item.role === "assistant" ? "assistant" : "user";
      const calls: ToolCall[] = [];
      const texts: string[] = [];
      const tools: Turn[] = [];
      if (typeof item.content === "string") texts.push(item.content);
      for (const block of asArr(item.content)) {
        const part = asObj(block);
        if (part.type === "text") texts.push(textOf(part.text));
        else if (part.type === "tool_use") calls.push({ id: textOf(part.id) || "tool", name: textOf(part.name), args: JSON.stringify(part.input ?? {}) });
        else if (part.type === "tool_result") tools.push({ role: "tool", text: textBlocks(part.content), callId: textOf(part.tool_use_id) });
      }
      if (texts.join("").trim() || calls.length) norm.turns.push({ role, text: texts.join(""), calls });
      norm.turns.push(...tools);
    }
    norm.tools = asArr(body.tools).map((tool) => {
      const item = asObj(tool);
      return { name: textOf(item.name), description: textOf(item.description), schema: item.input_schema ?? { type: "object", properties: {} } };
    });
    return norm;
  }

  if (client === "openai-chat") {
    for (const message of asArr(body.messages)) {
      const item = asObj(message);
      if (item.role === "system") {
        norm.system = textBlocks(item.content);
        continue;
      }
      const calls = asArr(item.tool_calls).map((call) => {
        const row = asObj(call);
        const fn = asObj(row.function);
        return { id: textOf(row.id) || "tool", name: textOf(fn.name), args: textOf(fn.arguments) || "{}" };
      });
      const role = item.role === "assistant" ? "assistant" : item.role === "tool" ? "tool" : "user";
      norm.turns.push({ role, text: textBlocks(item.content), calls, callId: textOf(item.tool_call_id) });
    }
    norm.tools = asArr(body.tools).map((tool) => {
      const fn = asObj(asObj(tool).function);
      return { name: textOf(fn.name), description: textOf(fn.description), schema: fn.parameters ?? { type: "object", properties: {} } };
    });
    return norm;
  }

  if (client === "openai-responses") {
    norm.system = textOf(body.instructions);
    const input = body.input;
    if (typeof input === "string") norm.turns.push({ role: "user", text: input });
    for (const item of asArr(input)) {
      const row = asObj(item);
      if (row.type === "function_call") norm.turns.push({ role: "assistant", text: "", calls: [{ id: textOf(row.call_id) || "tool", name: textOf(row.name), args: textOf(row.arguments) || "{}" }] });
      else if (row.type === "function_call_output") norm.turns.push({ role: "tool", text: textOf(row.output), callId: textOf(row.call_id) });
      else {
        const role = row.role === "assistant" ? "assistant" : "user";
        norm.turns.push({ role, text: textBlocks(row.content) || textOf(row.text) });
      }
    }
    norm.tools = asArr(body.tools)
      .map((tool) => asObj(tool))
      .filter((tool) => tool.type === "function" || tool.name)
      .map((tool) => ({ name: textOf(tool.name), description: textOf(tool.description), schema: tool.parameters ?? { type: "object", properties: {} } }));
    return norm;
  }

  return norm;
}

function anthropicBody(norm: Norm, model: string) {
  const messages: Obj[] = [];
  for (const turn of norm.turns) {
    if (turn.role === "tool") {
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: turn.callId || "tool", content: turn.text }] });
      continue;
    }
    const content: Obj[] = [];
    if (turn.text) content.push({ type: "text", text: turn.text });
    for (const call of turn.calls ?? []) {
      let input: unknown = {};
      try { input = JSON.parse(call.args || "{}"); } catch { input = { raw: call.args }; }
      content.push({ type: "tool_use", id: call.id, name: call.name, input });
    }
    if (content.length) messages.push({ role: turn.role === "assistant" ? "assistant" : "user", content });
  }
  if (!messages.length) messages.push({ role: "user", content: [{ type: "text", text: " " }] });
  const body: Obj = { model, max_tokens: norm.maxTokens, messages, stream: norm.stream };
  if (norm.system) body.system = norm.system;
  if (norm.tools.length) body.tools = norm.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.schema }));
  return body;
}

function chatBody(norm: Norm, model: string) {
  const messages: Obj[] = [];
  if (norm.system) messages.push({ role: "system", content: norm.system });
  for (const turn of norm.turns) {
    if (turn.role === "tool") {
      messages.push({ role: "tool", tool_call_id: turn.callId || "tool", content: turn.text });
      continue;
    }
    const message: Obj = { role: turn.role, content: turn.text || "" };
    if (turn.calls?.length) {
      message.tool_calls = turn.calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.args || "{}" } }));
    }
    messages.push(message);
  }
  const body: Obj = { model, messages, stream: norm.stream };
  if (norm.tools.length) body.tools = norm.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.schema } }));
  return body;
}

function responsesBody(norm: Norm, model: string) {
  const input: Obj[] = [];
  for (const turn of norm.turns) {
    if (turn.role === "tool") input.push({ type: "function_call_output", call_id: turn.callId || "tool", output: turn.text });
    else if (turn.calls?.length) {
      if (turn.text) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: turn.text }] });
      for (const call of turn.calls) input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.args || "{}" });
    } else {
      const assistant = turn.role === "assistant";
      input.push({ type: "message", role: assistant ? "assistant" : "user", content: [{ type: assistant ? "output_text" : "input_text", text: turn.text }] });
    }
  }
  const body: Obj = { model, input, stream: norm.stream, max_output_tokens: norm.maxTokens };
  if (norm.system) body.instructions = norm.system;
  if (norm.tools.length) body.tools = norm.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.schema }));
  return body;
}

/** 把客户端请求写成上游的 JSON，并给出要拼到供应商地址后面的路径。 */
export function convertRequest(client: Upstream, upstream: Upstream, raw: string, model: string): { path: string; json: Obj } {
  const parsed = JSON.parse(raw) as unknown;
  const norm = normFrom(client, parsed);
  if (upstream === "anthropic") return { path: "/v1/messages", json: anthropicBody(norm, model) };
  if (upstream === "openai-chat") return { path: "/v1/chat/completions", json: chatBody(norm, model) };
  return { path: "/v1/responses", json: responsesBody(norm, model) };
}

function stopOf(value: string) {
  if (value === "tool_calls" || value === "tool_use") return "tool_use";
  if (value === "length" || value === "max_tokens") return "max_tokens";
  return "end_turn";
}

/** 从上游的一条 JSON 里取出增量。非流式的整段响应也走这里。 */
export function deltasOf(upstream: Upstream, event: string, payload: unknown): Delta[] {
  const body = asObj(payload);
  const out: Delta[] = [];
  if (upstream === "openai-chat") {
    const choice = asObj(asArr(body.choices)[0]);
    const message = asObj(choice.delta ?? choice.message);
    if (typeof message.content === "string" && message.content) out.push({ kind: "text", text: message.content });
    for (const call of asArr(message.tool_calls)) {
      const row = asObj(call);
      const fn = asObj(row.function);
      const id = textOf(row.id) || `call_${textOf(row.index) || "0"}`;
      if (fn.name) out.push({ kind: "tool-start", id, name: textOf(fn.name) });
      if (typeof fn.arguments === "string" && fn.arguments) out.push({ kind: "tool-args", id, args: fn.arguments });
    }
    if (typeof choice.finish_reason === "string") out.push({ kind: "stop", reason: stopOf(choice.finish_reason) });
    const usage = asObj(body.usage);
    if (Object.keys(usage).length) out.push({ kind: "usage", input: Number(usage.prompt_tokens) || 0, output: Number(usage.completion_tokens) || 0 });
    return out;
  }
  if (upstream === "openai-responses") {
    const type = textOf(body.type) || event;
    if (type === "response.output_text.delta") out.push({ kind: "text", text: textOf(body.delta) });
    const item = asObj(body.item);
    if (type === "response.output_item.added" && item.type === "function_call") out.push({ kind: "tool-start", id: textOf(item.call_id) || "tool", name: textOf(item.name) });
    if (type === "response.function_call_arguments.delta") out.push({ kind: "tool-args", id: textOf(body.item_id) || textOf(item.call_id) || "", args: textOf(body.delta) });
    if (Array.isArray(body.output)) {
      for (const part of asArr(body.output)) {
        const row = asObj(part);
        if (row.type === "function_call") out.push({ kind: "tool-start", id: textOf(row.call_id) || "tool", name: textOf(row.name) }, { kind: "tool-args", id: textOf(row.call_id) || "tool", args: textOf(row.arguments) });
        else {
          const text = textBlocks(row.content);
          if (text) out.push({ kind: "text", text });
        }
      }
      out.push({ kind: "stop", reason: "end_turn" });
      const usage = asObj(body.usage);
      if (Object.keys(usage).length) out.push({ kind: "usage", input: Number(usage.input_tokens) || 0, output: Number(usage.output_tokens) || 0 });
      return out;
    }
    if (type === "response.completed") {
      const usage = asObj(asObj(body.response).usage);
      out.push({ kind: "stop", reason: "end_turn" });
      if (Object.keys(usage).length) out.push({ kind: "usage", input: Number(usage.input_tokens) || 0, output: Number(usage.output_tokens) || 0 });
    }
    return out.filter((delta) => delta.kind !== "text" || delta.text);
  }
  const type = textOf(body.type) || event;
  if (type === "content_block_start" && asObj(body.content_block).type === "tool_use") {
    const block = asObj(body.content_block);
    out.push({ kind: "tool-start", id: textOf(block.id) || "tool", name: textOf(block.name) });
  } else if (type === "content_block_delta") {
    const delta = asObj(body.delta);
    if (delta.type === "text_delta") out.push({ kind: "text", text: textOf(delta.text) });
    if (delta.type === "input_json_delta") out.push({ kind: "tool-args", id: "", args: textOf(delta.partial_json) });
  } else if (type === "message_delta") {
    out.push({ kind: "stop", reason: stopOf(textOf(asObj(body.delta).stop_reason) || "end_turn") });
    const usage = asObj(body.usage);
    if (Object.keys(usage).length) out.push({ kind: "usage", input: Number(usage.input_tokens) || 0, output: Number(usage.output_tokens) || 0 });
  } else if (type === "message" || Array.isArray(body.content)) {
    for (const block of asArr(body.content)) {
      const row = asObj(block);
      if (row.type === "text") out.push({ kind: "text", text: textOf(row.text) });
      if (row.type === "tool_use") out.push({ kind: "tool-start", id: textOf(row.id) || "tool", name: textOf(row.name) }, { kind: "tool-args", id: textOf(row.id) || "tool", args: JSON.stringify(row.input ?? {}) });
    }
    if (body.stop_reason) out.push({ kind: "stop", reason: stopOf(textOf(body.stop_reason)) });
    const usage = asObj(body.usage);
    if (Object.keys(usage).length) out.push({ kind: "usage", input: Number(usage.input_tokens) || 0, output: Number(usage.output_tokens) || 0 });
  }
  return out;
}

class Emitter {
  private started = false;
  private index = -1;
  private open: "text" | "tool" | null = null;
  private text = "";
  private calls: { id: string; name: string; args: string }[] = [];
  private usage = { input: 0, output: 0 };
  private stop = "end_turn";
  private currentId = "";

  constructor(private readonly client: Upstream, private readonly model: string) {}

  push(delta: Delta): string {
    if (delta.kind === "usage") {
      this.usage = { input: delta.input, output: delta.output };
      return "";
    }
    if (delta.kind === "stop") {
      this.stop = delta.reason;
      return "";
    }
    if (delta.kind === "text") this.text += delta.text;
    if (delta.kind === "tool-start") {
      this.currentId = delta.id || `tool_${this.calls.length}`;
      this.calls.push({ id: this.currentId, name: delta.name, args: "" });
    }
    if (delta.kind === "tool-args") {
      const id = delta.id || this.currentId;
      const call = [...this.calls].reverse().find((item) => item.id === id) ?? this.calls[this.calls.length - 1];
      if (call) call.args += delta.args;
    }
    if (this.client === "anthropic") return this.anthropic(delta);
    if (this.client === "openai-responses") return this.responses(delta);
    return this.chat(delta);
  }

  end(): string {
    if (this.client === "anthropic") return this.anthropicEnd();
    if (this.client === "openai-responses") return this.responsesEnd();
    return this.chatEnd();
  }

  readUsage() {
    return { input: this.usage.input, output: this.usage.output };
  }

  json(): Obj {
    if (this.client === "anthropic") {
      const content: Obj[] = [];
      if (this.text) content.push({ type: "text", text: this.text });
      for (const call of this.calls) {
        let input: unknown = {};
        try { input = JSON.parse(call.args || "{}"); } catch { input = {}; }
        content.push({ type: "tool_use", id: call.id, name: call.name, input });
      }
      return { id: "msg_tokenpulse", type: "message", role: "assistant", model: this.model, stop_reason: this.calls.length ? "tool_use" : this.stop, content, usage: { input_tokens: this.usage.input, output_tokens: this.usage.output } };
    }
    if (this.client === "openai-chat") {
      const message: Obj = { role: "assistant", content: this.text || null };
      if (this.calls.length) message.tool_calls = this.calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.args || "{}" } }));
      return { id: "chatcmpl_tokenpulse", object: "chat.completion", model: this.model, choices: [{ index: 0, message, finish_reason: this.calls.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: this.usage.input, completion_tokens: this.usage.output, total_tokens: this.usage.input + this.usage.output } };
    }
    if (this.client === "openai-responses") {
      const output: Obj[] = [];
      if (this.text) output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: this.text }] });
      for (const call of this.calls) output.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.args || "{}" });
      return { id: "resp_tokenpulse", object: "response", model: this.model, output, usage: { input_tokens: this.usage.input, output_tokens: this.usage.output } };
    }
    const parts: Obj[] = [];
    if (this.text) parts.push({ text: this.text });
    for (const call of this.calls) {
      let args: unknown = {};
      try { args = JSON.parse(call.args || "{}"); } catch { args = {}; }
      parts.push({ functionCall: { name: call.name, args } });
    }
    return { candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: this.usage.input, candidatesTokenCount: this.usage.output } };
  }

  private sse(event: string, data: unknown) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private anthropic(delta: Delta) {
    let out = "";
    if (!this.started) {
      this.started = true;
      out += this.sse("message_start", { type: "message_start", message: { id: "msg_tokenpulse", type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, usage: { input_tokens: this.usage.input, output_tokens: 0 } } });
    }
    if (delta.kind === "text") {
      if (this.open !== "text") {
        if (this.open) out += this.sse("content_block_stop", { type: "content_block_stop", index: this.index });
        this.index += 1;
        this.open = "text";
        out += this.sse("content_block_start", { type: "content_block_start", index: this.index, content_block: { type: "text", text: "" } });
      }
      out += this.sse("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "text_delta", text: delta.text } });
    }
    if (delta.kind === "tool-start") {
      if (this.open) out += this.sse("content_block_stop", { type: "content_block_stop", index: this.index });
      this.index += 1;
      this.open = "tool";
      out += this.sse("content_block_start", { type: "content_block_start", index: this.index, content_block: { type: "tool_use", id: delta.id || this.currentId, name: delta.name, input: {} } });
    }
    if (delta.kind === "tool-args" && this.open === "tool") {
      out += this.sse("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "input_json_delta", partial_json: delta.args } });
    }
    return out;
  }

  private anthropicEnd() {
    if (!this.started) this.started = true;
    let out = this.open ? this.sse("content_block_stop", { type: "content_block_stop", index: Math.max(this.index, 0) }) : "";
    if (!this.open && this.index < 0) {
      out += this.sse("message_start", { type: "message_start", message: { id: "msg_tokenpulse", type: "message", role: "assistant", model: this.model, content: [], usage: { input_tokens: 0, output_tokens: 0 } } });
    }
    out += this.sse("message_delta", { type: "message_delta", delta: { stop_reason: this.calls.length ? "tool_use" : this.stop }, usage: { output_tokens: this.usage.output } });
    out += this.sse("message_stop", { type: "message_stop" });
    return out;
  }

  private chat(delta: Delta) {
    if (delta.kind === "text") return `data: ${JSON.stringify({ id: "chatcmpl_tokenpulse", object: "chat.completion.chunk", model: this.model, choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }] })}\n\n`;
    if (delta.kind === "tool-start") return `data: ${JSON.stringify({ id: "chatcmpl_tokenpulse", object: "chat.completion.chunk", model: this.model, choices: [{ index: 0, delta: { tool_calls: [{ index: Math.max(this.calls.length - 1, 0), id: delta.id, type: "function", function: { name: delta.name, arguments: "" } }] }, finish_reason: null }] })}\n\n`;
    if (delta.kind === "tool-args") return `data: ${JSON.stringify({ id: "chatcmpl_tokenpulse", object: "chat.completion.chunk", model: this.model, choices: [{ index: 0, delta: { tool_calls: [{ index: Math.max(this.calls.length - 1, 0), function: { arguments: delta.args } }] }, finish_reason: null }] })}\n\n`;
    return "";
  }

  private chatEnd() {
    return `data: ${JSON.stringify({ id: "chatcmpl_tokenpulse", object: "chat.completion.chunk", model: this.model, choices: [{ index: 0, delta: {}, finish_reason: this.calls.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: this.usage.input, completion_tokens: this.usage.output } })}\n\ndata: [DONE]\n\n`;
  }

  private responses(delta: Delta) {
    if (!this.started) {
      this.started = true;
    }
    if (delta.kind === "text") return this.sse("response.output_text.delta", { type: "response.output_text.delta", delta: delta.text });
    if (delta.kind === "tool-start") return this.sse("response.output_item.added", { type: "response.output_item.added", item: { type: "function_call", call_id: delta.id, name: delta.name, arguments: "" } });
    if (delta.kind === "tool-args") return this.sse("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", delta: delta.args });
    return "";
  }

  private responsesEnd() {
    return this.sse("response.completed", { type: "response.completed", response: this.json() });
  }
}

/** 把上游的一条完整 JSON 响应写成客户端要的 JSON。 */
export function convertJsonResponse(client: Upstream, upstream: Upstream, payload: unknown, model: string): Obj {
  const emitter = new Emitter(client, model);
  for (const delta of deltasOf(upstream, "", payload)) emitter.push(delta);
  return emitter.json();
}

/**
 * 流式转换。喂上游的 SSE 文本，吐出客户端的 SSE 文本。
 * end() 补上收尾事件。
 */
export class StreamBridge {
  private readonly buffer = new SseBuffer();
  private readonly emitter: Emitter;

  constructor(private readonly upstream: Upstream, client: Upstream, model: string) {
    this.emitter = new Emitter(client, model);
  }

  push(chunk: string): string {
    let out = "";
    for (const frame of this.buffer.push(chunk)) {
      if (frame.data === "[DONE]") continue;
      let payload: unknown = frame.data;
      try { payload = JSON.parse(frame.data); } catch { continue; }
      for (const delta of deltasOf(this.upstream, frame.event, payload)) out += this.emitter.push(delta);
    }
    return out;
  }

  end(): string {
    return this.emitter.end();
  }

  usage() {
    return this.emitter.readUsage();
  }
}

class SseBuffer {
  private buf = "";

  push(chunk: string) {
    this.buf += chunk.replace(/\r\n/g, "\n");
    const frames: { event: string; data: string }[] = [];
    let split = this.buf.indexOf("\n\n");
    while (split >= 0) {
      const raw = this.buf.slice(0, split);
      this.buf = this.buf.slice(split + 2);
      let event = "";
      const data: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) frames.push({ event, data: data.join("\n") });
      split = this.buf.indexOf("\n\n");
    }
    return frames;
  }
}

/** 按客户端协议包一层错误，让 CLI 能把这句话显示出来。 */
export function clientError(client: Upstream, message: string): Obj {
  if (client === "anthropic") return { type: "error", error: { type: "api_error", message } };
  return { error: { message, type: "api_error" } };
}
