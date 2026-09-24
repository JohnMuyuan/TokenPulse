// 会话管理：三家会话文件的解析、注入内容过滤、子会话跳过、索引缓存，以及「在 TokenPulse 里回复」的命令行和流式事件解析。
// 会话文件的格式照着本机真实文件抄的（字段名、嵌套位置），内容换成假的。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-sessions-'));
const claudeDir = path.join(root, 'claude');
const codexDir = path.join(root, 'codex');
const grokDir = path.join(root, 'grok');
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.CODEX_HOME = codexDir;
process.env.GROK_HOME = grokDir;
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
const write = (file, rows) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n'); };
const project = path.join(root, 'Demo');
fs.mkdirSync(project);

/* ---------------- Claude Code ---------------- */
write(path.join(claudeDir, 'projects', 'D--Demo', 'claude-1.jsonl'), [
  { type: 'user', uuid: 'm0', isMeta: true, timestamp: '2026-09-24T09:59:00Z', sessionId: 'claude-1', cwd: project, message: { content: 'Caveat: meta line' } },
  { type: 'user', uuid: 'u0', timestamp: '2026-09-24T09:59:30Z', sessionId: 'claude-1', cwd: project, message: { content: '<command-name>/model</command-name><command-args>opus</command-args>' } },
  { type: 'user', uuid: 'u1', timestamp: '2026-09-24T10:00:00Z', sessionId: 'claude-1', cwd: project, message: { content: '<system-reminder>别显示我</system-reminder>检查项目状态' } },
  // 一次回复拆成两行写：同一个 message.id，文字要拼回一条
  { type: 'assistant', uuid: 'a1', timestamp: '2026-09-24T10:00:02Z', message: { id: 'msg_1', model: 'claude-opus-5', content: [{ type: 'text', text: '正在检查。' }] } },
  { type: 'assistant', uuid: 'a2', timestamp: '2026-09-24T10:00:03Z', message: { id: 'msg_1', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'dir' } }] } },
  { type: 'user', uuid: 'u2', timestamp: '2026-09-24T10:00:04Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file.txt' }] } },
  { type: 'assistant', uuid: 'a3', isSidechain: true, timestamp: '2026-09-24T10:00:05Z', message: { id: 'msg_side', content: [{ type: 'text', text: '旁支不显示' }] } },
  { type: 'assistant', uuid: 'a4', timestamp: '2026-09-24T10:00:06Z', message: { id: 'msg_2', model: 'claude-opus-5', content: [{ type: 'text', text: '只有 file.txt。' }] } },
  { type: 'ai-title', aiTitle: '检查 Demo 项目' },
  'not json {',
]);
// 子代理的记录：属于主会话，不单独列
write(path.join(claudeDir, 'projects', 'D--Demo', 'claude-1', 'subagents', 'agent-x.jsonl'), [
  { type: 'user', uuid: 's1', timestamp: '2026-09-24T10:00:00Z', sessionId: 'agent-x', cwd: project, message: { content: '子代理任务' } },
  { type: 'assistant', uuid: 's2', timestamp: '2026-09-24T10:00:01Z', message: { id: 'x', content: [{ type: 'text', text: '好' }] } },
]);
// 只有 CLI 自己加的内容、没有真正对话的会话：不列
write(path.join(claudeDir, 'projects', 'D--Demo', 'claude-empty.jsonl'), [
  { type: 'user', uuid: 'e1', timestamp: '2026-09-24T08:00:00Z', sessionId: 'claude-empty', cwd: project, message: { content: '<local-command-stdout>ok</local-command-stdout>' } },
]);

/* ---------------- Codex ---------------- */
const codexFile = path.join(codexDir, 'sessions', '2026', '09', '24', 'rollout-2026-09-24T11-00-00-codex-1.jsonl');
write(codexFile, [
  { type: 'session_meta', timestamp: '2026-09-24T11:00:00Z', payload: { id: 'codex-1', cwd: project } },
  { type: 'turn_context', timestamp: '2026-09-24T11:00:00Z', payload: { model: 'gpt-6' } },
  { type: 'response_item', timestamp: '2026-09-24T11:00:00Z', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>…</permissions instructions>' }] } },
  { type: 'response_item', timestamp: '2026-09-24T11:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for D:\\Demo\n\n<INSTRUCTIONS>…</INSTRUCTIONS>' }] } },
  { type: 'response_item', timestamp: '2026-09-24T11:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>D:\\Demo</cwd>\n</environment_context>' }] } },
  // AllAi 拿 Codex 当聊天后端时拼进来的系统提示和历史
  { type: 'response_item', timestamp: '2026-09-24T11:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'You are a helpful chat assistant.\n\n用户：以前的问题\n\n【以上是历史。用户此刻的问题】\n列出文件' }] } },
  // event_msg 是同一句话的重复，不能再算一次
  { type: 'event_msg', timestamp: '2026-09-24T11:00:01Z', payload: { type: 'user_message', message: '列出文件' } },
  { type: 'response_item', timestamp: '2026-09-24T11:00:02Z', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"dir"}', call_id: 'call-1' } },
  { type: 'response_item', timestamp: '2026-09-24T11:00:03Z', payload: { type: 'function_call_output', call_id: 'call-1', output: 'file.txt' } },
  { type: 'response_item', timestamp: '2026-09-24T11:00:04Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已完成。' }] } },
  { type: 'event_msg', timestamp: '2026-09-24T11:00:04Z', payload: { type: 'agent_message', message: '已完成。' } },
  { type: 'response_item', timestamp: '2026-09-24T11:00:05Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<turn_aborted>\nThe user interrupted.\n</turn_aborted>' }] } },
]);
write(path.join(codexDir, 'session_index.jsonl'), [{ id: 'codex-1', thread_name: '列出 Demo 文件' }]);
// Codex 自己派的审查子会话：不列
write(path.join(codexDir, 'sessions', '2026', '09', '24', 'rollout-2026-09-24T11-05-00-codex-sub.jsonl'), [
  { type: 'session_meta', timestamp: '2026-09-24T11:05:00Z', payload: { id: 'codex-sub', cwd: project, parent_thread_id: 'codex-1', source: { subagent: 'review' } } },
  { type: 'response_item', timestamp: '2026-09-24T11:05:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'The following is the Codex agent history' }] } },
  { type: 'response_item', timestamp: '2026-09-24T11:05:02Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } },
]);

/* ---------------- Grok Build ---------------- */
const grokSession = path.join(grokDir, 'sessions', encodeURIComponent(project), 'grok-1');
write(path.join(grokSession, 'updates.jsonl'), [
  { timestamp: '2026-09-24T12:00:00Z', params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '你' } } } },
  { params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '好' } } } },
  { params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好，' } } } },
  { params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '需要我做什么？' } } } },
  { params: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read_file', rawInput: { path: 'a.txt' } } } },
  { params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed', rawOutput: 'not found' } } },
  { params: { update: { sessionUpdate: 'turn_completed' } } },
]);
fs.writeFileSync(path.join(grokSession, 'summary.json'), JSON.stringify({ generated_title: '打个招呼', current_model_id: 'grok-4.6' }));

const sessions = require('../build/core/sessions.js');
const list = sessions.listSessions();
assert.deepStrictEqual(list.map(item => item.key).sort(), ['claude:claude-1', 'codex:codex-1', 'grok:grok-1'], '子代理、子会话、空会话都不该出现在列表里');

const byKind = Object.fromEntries(list.map(item => [item.kind, item]));
assert.strictEqual(byKind.claude.title, '检查 Demo 项目', 'Claude 用 CLI 生成的标题');
assert.strictEqual(byKind.codex.title, '列出 Demo 文件', 'Codex 用 session_index 里的标题');
assert.strictEqual(byKind.grok.title, '打个招呼', 'Grok 用 summary.json 的标题');
for (const item of list) {
  assert.strictEqual(item.cwd, project);
  assert.strictEqual(item.project, 'Demo');
  assert.strictEqual(item.turns, 1, `${item.kind} 只有一轮用户提问`);
  assert(item.resumeCommand.includes(item.id));
  assert(!('messages' in item), '列表里不带整段对话');
}
assert.deepStrictEqual(byKind.claude.models, ['claude-opus-5']);
assert.deepStrictEqual(byKind.codex.models, ['gpt-6']);
assert.deepStrictEqual(byKind.grok.models, ['grok-4.6']);

// Claude：meta / sidechain / system-reminder 过滤，斜杠命令变事件，同 id 的文字拼成一条，工具结果挂到工具上
const claude = sessions.getSession('claude', 'claude-1');
const talk = m => m.filter(x => x.role === 'user' || x.role === 'assistant').map(x => `${x.role}:${x.text}`);
assert.deepStrictEqual(talk(claude.messages), ['user:检查项目状态', 'assistant:正在检查。', 'assistant:只有 file.txt。']);
assert(claude.messages.some(m => m.role === 'event' && m.text === '命令 /model opus'));
const bash = claude.messages.find(m => m.role === 'tool');
assert.strictEqual(bash.name, 'Bash');
assert(bash.output.includes('file.txt') && !bash.error);
assert.strictEqual(claude.truncated, 0);

// Codex：developer / AGENTS.md / environment_context 不算用户说的；AllAi 的前缀剥掉；event_msg 不重复；中断变事件
const codex = sessions.getSession('codex', 'codex-1');
assert.deepStrictEqual(talk(codex.messages), ['user:列出文件', 'assistant:已完成。']);
assert(codex.messages.some(m => m.role === 'tool' && m.name === 'shell' && m.output.includes('file.txt')));
assert(codex.messages.some(m => m.role === 'event' && m.text === '已中断'));

// Grok：分块拼回整句；失败的工具标出来
const grok = sessions.getSession('grok', 'grok-1');
assert.deepStrictEqual(talk(grok.messages), ['user:你好', 'assistant:你好，需要我做什么？']);
const readFile = grok.messages.find(m => m.role === 'tool');
assert(readFile && readFile.name === 'read_file' && readFile.error && readFile.output.includes('not found'));

// 参数检查
assert.strictEqual(sessions.getSession('claude', 'missing'), null);
assert.strictEqual(sessions.getSession('bogus', 'claude-1'), null);
assert.strictEqual(sessions.getSession('claude', 'x'.repeat(201)), null);

// 索引缓存：没变的文件不重读；改了的文件会重读
const indexFile = path.join(process.env.TOKENPULSE_DATA_DIR, 'sessions-index.json');
const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
assert(Object.keys(index.files).length >= 4, '空会话、子会话也记进索引，下次不再解析');
const before = fs.statSync(indexFile).mtimeMs;
sessions.listSessions();
assert.strictEqual(fs.statSync(indexFile).mtimeMs, before, '什么都没变时不重写索引');
fs.appendFileSync(codexFile, JSON.stringify({ type: 'response_item', timestamp: '2026-09-24T11:10:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '再来一次' }] } }) + '\n');
const again = sessions.listSessions().find(item => item.kind === 'codex');
assert.strictEqual(again.turns, 2, '会话文件变了要重新解析');

/* ---------------- 在 TokenPulse 里回复 ---------------- */
const reply = require('../build/main/session-reply.js');
const claudeArgs = reply.replyArgs('claude', 'abc', 'readonly');
assert.deepStrictEqual(claudeArgs.slice(claudeArgs.indexOf('--resume'), claudeArgs.indexOf('--resume') + 2), ['--resume', 'abc']);
assert(claudeArgs.includes('-p') && claudeArgs.includes('dontAsk') && !claudeArgs.includes('acceptEdits'));
assert(reply.replyArgs('claude', 'abc', 'edit').includes('acceptEdits'));
const codexArgs = reply.replyArgs('codex', 'abc', 'readonly');
assert.deepStrictEqual(codexArgs.slice(0, 3), ['exec', 'resume', 'abc']);
assert(codexArgs.includes('sandbox_mode="read-only"') && codexArgs.includes('approval_policy="never"') && codexArgs.at(-1) === '-');
assert(reply.replyArgs('codex', 'abc', 'edit').includes('sandbox_mode="workspace-write"'));
const grokArgs = reply.replyArgs('grok', 'abc', 'readonly', 'C:\\tmp\\p.txt');
assert(grokArgs.includes('dontAsk') && grokArgs.at(-1) === 'C:\\tmp\\p.txt' && grokArgs[grokArgs.indexOf('--resume') + 1] === 'abc');
// 提示词绝不进命令行
for (const args of [claudeArgs, codexArgs, grokArgs]) assert(!args.some(arg => arg.includes('提示词')));

// 在终端里继续：进项目目录；PATH 上没有 CLI 时退到找到的 exe；单引号按 PowerShell 规则加倍
const script = reply.terminalScript('grok', "a'b", "D:\\临时\\it's here", 'C:\\Users\\x\\.grok\\bin\\grok.exe');
assert(script.startsWith("Set-Location -LiteralPath 'D:\\临时\\it''s here'"));
assert(script.includes("Get-Command grok") && script.includes("'C:\\Users\\x\\.grok\\bin\\grok.exe'"));
assert(script.endsWith("& $cli '--resume' 'a''b'"));
assert(reply.terminalScript('codex', 'abc').endsWith("& $cli 'resume' 'abc'"));
assert(!reply.terminalScript('codex', 'abc').includes('Set-Location'), '没有项目目录就不切');

// 从 Claude Code 里启动时继承的会话标记要去掉（否则 Claude 不存对话记录、终端没颜色）；用户自己配的 CLAUDE_CODE_* 留着
const cleaned = reply.cleanAgentEnv({ CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: '1', NO_COLOR: '1', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\git\\bash.exe', PATH: 'p' });
assert.deepStrictEqual(cleaned, { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\git\\bash.exe', PATH: 'p' });

const ev = (kind, row, streamed = false) => reply.readEvent(kind, JSON.stringify(row), streamed);
// Claude：增量、工具、整段（没收到增量时才用）、出错
assert.deepStrictEqual(ev('claude', { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } } }), { delta: '你' });
assert.deepStrictEqual(ev('claude', { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '…' } } }), {});
assert.deepStrictEqual(ev('claude', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }), { tool: 'Read' });
assert.deepStrictEqual(ev('claude', { type: 'assistant', message: { content: [{ type: 'text', text: '整段' }] } }), { delta: '整段' });
assert.deepStrictEqual(ev('claude', { type: 'assistant', message: { content: [{ type: 'text', text: '整段' }] } }, true), {});
assert.deepStrictEqual(ev('claude', { type: 'result', is_error: true, result: '额度用完了' }), { error: '额度用完了' });
assert.deepStrictEqual(reply.readEvent('claude', 'not json', false), {});
// Codex：每段 agent_message 是完整的，第二段前面空一行；命令；出错；「事件流滞后」不算出错
assert.deepStrictEqual(ev('codex', { type: 'item.completed', item: { type: 'agent_message', text: '第一段' } }), { delta: '第一段' });
assert.deepStrictEqual(ev('codex', { type: 'item.completed', item: { type: 'agent_message', text: '第二段' } }, true), { delta: '\n\n第二段' });
assert.deepStrictEqual(ev('codex', { type: 'item.started', item: { type: 'command_execution', command: 'dir' } }), { tool: 'dir' });
assert.deepStrictEqual(ev('codex', { type: 'turn.failed', error: { message: 'usage limit' } }), { error: 'usage limit' });
assert.deepStrictEqual(ev('codex', { type: 'error', message: 'in-process app-server event stream lagged; dropped 3 events' }), {});
// Grok：ACP 的 sessionUpdate 分块
assert.deepStrictEqual(ev('grok', { params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } } } }), { delta: '好' });
assert.deepStrictEqual(ev('grok', { update: { sessionUpdate: 'tool_call', title: 'read_file', _meta: { 'x.ai/tool': { name: 'Read' } } } }), { tool: 'Read' });
assert.deepStrictEqual(ev('grok', { params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '我说的' } } } }), {}, '自己发的那句不当成回复');

fs.rmSync(root, { recursive: true, force: true });
console.log(`session tests passed (${list.length} sessions, reply args + stream events)`);
