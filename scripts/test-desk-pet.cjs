'use strict';
/*
 * 桌宠（0.3.61）里不依赖窗口的部分：
 * - core/agent-activity.ts：从 Claude Code / Codex 会话文件推断任务状态，扫描器找最近的会话、发现「刚做完」；
 * - core/desk-pet-model.ts：设置项的收口、宠物跟的额度、睡觉判断、宠物和对话气泡放在哪；
 * - core/pet-pack.ts：自定义宠物文件夹的校验、导入、列表、删除。
 * 宠物窗口和对话气泡的界面在 test-desk-pet-ui.cjs（Electron）。全部在临时目录里跑，不碰真实的 ~/.claude、~/.codex、~/.tokenpulse。
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-desk-pet-'));
assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
const activity = require('../build/core/agent-activity');
const model = require('../build/core/desk-pet-model');
const packs = require('../build/core/pet-pack');
const { readPrefs } = require('../build/main/prefs');

const T0 = Date.parse('2026-10-22T10:00:00Z');
const at = s => new Date(T0 + s * 1000).toISOString();
const line = value => JSON.stringify(value);
const claudeUser = (s, text, extra = {}) => line({ type: 'user', timestamp: at(s), sessionId: 'c-1', cwd: 'D:\\work\\demo-app', message: { role: 'user', content: text }, ...extra });
const claudeAsst = (s, blocks, stop, extra = {}) => line({ type: 'assistant', timestamp: at(s), message: { role: 'assistant', stop_reason: stop, content: blocks }, ...extra });
const toolResult = s => line({ type: 'user', timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });

let failed = false;
const check = (name, fn) => { try { fn(); console.log('PASS', name); } catch (error) { failed = true; console.error('FAIL', name, '\n', error.stack || error.message); } };
const checkAsync = async (name, fn) => { try { await fn(); console.log('PASS', name); } catch (error) { failed = true; console.error('FAIL', name, '\n', error.stack || error.message); } };

check('desk pet: Claude Code turn states from the session tail', () => {
  const prompt = claudeUser(0, '把额度卡片改成分级提示');
  assert.deepEqual(activity.inferClaude([prompt]), { status: 'thinking', since: T0, at: T0, tool: undefined, doneAt: undefined });
  const tool = claudeAsst(5, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], 'tool_use');
  assert.equal(activity.inferClaude([prompt, claudeAsst(3, [{ type: 'thinking', thinking: '…' }], 'tool_use'), tool]).status, 'tool');
  assert.equal(activity.inferClaude([prompt, tool]).tool, 'Bash');
  assert.equal(activity.inferClaude([prompt, tool, toolResult(9)]).status, 'thinking', '工具有结果了：模型接着想');
  const done = activity.inferClaude([prompt, tool, toolResult(9), claudeAsst(20, [{ type: 'text', text: '改好了' }], 'end_turn')]);
  assert.equal(done.status, 'done'); assert.equal(done.doneAt, T0 + 20000); assert.equal(done.since, T0);
  // stop_hook_summary / turn_duration 也算这一轮结束（有的版本 end_turn 行在读到的范围之前）
  assert.equal(activity.inferClaude([prompt, tool, toolResult(9), line({ type: 'system', subtype: 'turn_duration', timestamp: at(30) })]).status, 'done');
  // 用户中断
  assert.equal(activity.inferClaude([prompt, tool, claudeUser(12, '[Request interrupted by user for tool use]')]).status, 'done');
  // 斜杠命令、CLI 自己塞进来的东西不算新一轮
  assert.equal(activity.inferClaude([prompt, claudeAsst(4, [{ type: 'text', text: 'hi' }], 'end_turn'), claudeUser(8, '<command-name>/clear</command-name>'), claudeUser(9, '<local-command-stdout></local-command-stdout>')]).status, 'done');
  // 子代理、meta 行不影响主会话
  assert.equal(activity.inferClaude([prompt, claudeAsst(4, [{ type: 'text', text: 'x' }], 'end_turn'), claudeUser(6, 'sub task', { isSidechain: true }), claudeAsst(7, [{ type: 'tool_use', name: 'Read' }], 'tool_use', { isSidechain: true })]).status, 'done');
  // 读到的尾巴从一轮中间开始：以第一条回复为准
  // 读子代理自己的文件：每行都是 isSidechain，要照常推
  const sub = [claudeUser(6, 'sub task', { isSidechain: true }), claudeAsst(7, [{ type: 'tool_use', name: 'Read' }], 'tool_use', { isSidechain: true })];
  assert.equal(activity.inferClaude(sub), null, '平时跳过子代理的行');
  assert.equal(activity.inferClaude(sub, { sidechain: true }).status, 'tool');
  const ended = line({ type: 'user', timestamp: at(9), isSidechain: true, toolEndsTurn: true, message: { content: [{ type: 'tool_result', tool_use_id: 't9', content: 'final' }] } });
  assert.deepEqual([activity.inferClaude([...sub, ended], { sidechain: true }).status, activity.inferClaude([...sub, ended], { sidechain: true }).ended], ['done', 'ok'], '交了结果这一轮就结束的工具（toolEndsTurn）');
  const mid = activity.inferClaude([toolResult(1), claudeAsst(2, [{ type: 'tool_use', name: 'Edit' }], 'tool_use')]);
  assert.equal(mid.status, 'tool'); assert.equal(mid.since, T0 + 1000);
  assert.equal(activity.inferClaude(['not json', '{"broken"', line({ type: 'mode' })]), null, '没有对话行');
  // 下一轮开始：since 换成新的提问时间
  const next = activity.inferClaude([prompt, claudeAsst(4, [{ type: 'text', text: 'a' }], 'end_turn'), claudeUser(60, '再加个测试')]);
  assert.equal(next.status, 'thinking'); assert.equal(next.since, T0 + 60000); assert.equal(next.doneAt, undefined);
  assert.equal(next.ended, undefined, '还在跑：没有结束方式');
  // 这一轮怎么结束的：做完、用户中断、API 报错（提示音按这个分）
  assert.equal(done.ended, 'ok');
  assert.equal(activity.inferClaude([prompt, tool, claudeUser(12, '[Request interrupted by user for tool use]')]).ended, 'interrupted');
  const apiError = activity.inferClaude([prompt, tool, toolResult(9), claudeAsst(10, [{ type: 'text', text: 'API Error: 529 overloaded' }], 'stop_sequence', { isApiErrorMessage: true })]);
  assert.deepEqual([apiError.status, apiError.ended, apiError.doneAt], ['done', 'error', T0 + 10000]);
  assert.equal(activity.inferClaude([prompt, claudeAsst(10, [], 'stop_sequence', { isApiErrorMessage: true }), claudeUser(30, '重试一下')]).ended, undefined, '出错后又问了一轮：重新算');
});

check('desk pet: Codex turn states from task_started / task_complete and pending tool calls', () => {
  const ev = (s, type) => line({ type: 'event_msg', timestamp: at(s), payload: { type } });
  const item = (s, payload) => line({ type: 'response_item', timestamp: at(s), payload });
  const started = ev(0, 'task_started');
  assert.equal(activity.inferCodex([started]).status, 'thinking');
  const call = (s, id, name) => item(s, { type: 'function_call', call_id: id, name, arguments: '{}' });
  const out = (s, id) => item(s, { type: 'function_call_output', call_id: id, output: 'ok' });
  assert.deepEqual(activity.inferCodex([started, call(2, 'a', 'shell')]), { status: 'tool', since: T0, at: T0 + 2000, tool: 'shell', doneAt: undefined });
  assert.equal(activity.inferCodex([started, call(2, 'a', 'shell'), call(3, 'b', 'apply_patch'), out(4, 'b')]).tool, 'shell', '并行调用：还有没回来的就仍在跑工具');
  assert.equal(activity.inferCodex([started, call(2, 'a', 'shell'), out(4, 'a')]).status, 'thinking');
  assert.equal(activity.inferCodex([started, call(2, 'a', 'shell'), out(4, 'a'), ev(9, 'task_complete')]).status, 'done');
  assert.equal(activity.inferCodex([started, ev(5, 'turn_aborted')]).doneAt, T0 + 5000);
  assert.equal(activity.inferCodex([started, ev(5, 'task_complete'), item(6, { type: 'message', role: 'assistant', content: [] })]).status, 'done', '结束之后的零碎行不重新算在跑');
  assert.equal(activity.inferCodex([item(1, { type: 'reasoning' })]).status, 'thinking', '尾巴从一轮中间开始');
  assert.equal(activity.inferCodex([line({ type: 'session_meta', payload: {} })]), null);
  // 结束方式：做完、中断、出错（出错后跟着的 task_complete 仍算出错；stream_error 只是在重试）
  assert.equal(activity.inferCodex([started, ev(9, 'task_complete')]).ended, 'ok');
  assert.equal(activity.inferCodex([started, ev(5, 'turn_aborted')]).ended, 'interrupted');
  const failed = activity.inferCodex([started, call(2, 'a', 'shell'), ev(4, 'error'), ev(5, 'task_complete')]);
  assert.deepEqual([failed.status, failed.ended, failed.doneAt], ['done', 'error', T0 + 4000]);
  assert.equal(activity.inferCodex([started, ev(3, 'stream_error'), call(4, 'a', 'shell')]).status, 'tool', 'stream_error 不算结束');
  assert.equal(activity.inferCodex([started, ev(4, 'error'), ev(5, 'task_complete'), ev(9, 'task_started')]).ended, undefined, '下一轮开始：重新算');
});

check('desk pet: live status — stale turns drop out, long tool calls may be waiting for the user', () => {
  const now = T0 + 3600_000;
  assert.equal(activity.liveStatus({ status: 'thinking', since: 0, at: 0 }, now - 5000, now), 'thinking');
  assert.equal(activity.liveStatus({ status: 'tool', since: 0, at: 0 }, now - 60_000, now), 'tool');
  assert.equal(activity.liveStatus({ status: 'tool', since: 0, at: 0 }, now - activity.WAITING_MS - 1, now), 'waiting');
  assert.equal(activity.liveStatus({ status: 'thinking', since: 0, at: 0 }, now - activity.STALE_MS - 1, now), null, '一轮没结束却 10 分钟没动：多半退出了');
  assert.equal(activity.liveStatus({ status: 'done', since: 0, at: 0 }, now - 86400_000, now), 'done');
});

check('desk pet: session heads give the title, project and subagent flag', () => {
  const head = activity.claudeHead([line({ type: 'ai-title', aiTitle: '额度卡片分级' }), claudeUser(0, '<system-reminder>x</system-reminder>帮我改额度卡片')]);
  assert.deepEqual(head, { id: 'c-1', cwd: 'D:\\work\\demo-app', title: '额度卡片分级', prompt: '帮我改额度卡片', side: false });
  assert.equal(activity.claudeHead([claudeUser(0, 'x', { isSidechain: true })]).side, true);
  const codex = activity.codexHead([line({ type: 'session_meta', payload: { id: 'x-9', cwd: '/home/me/proj' } }), line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>env</environment_context>' }, { type: 'input_text', text: '补单元测试' }] } })]);
  assert.deepEqual(codex, { id: 'x-9', cwd: '/home/me/proj', prompt: '补单元测试', side: false });
  assert.equal(activity.codexHead([line({ type: 'session_meta', payload: { id: 's', parent_thread_id: 'p' } })]).side, true);
});

check('desk pet: questions the agent is waiting on — Claude AskUserQuestion / ExitPlanMode, Codex request_user_input', () => {
  const prompt = claudeUser(0, '额度卡片怎么提示');
  const question = { question: '用哪种方式提示？', header: '方案', multiSelect: false, options: [{ label: '分级颜色', description: '按剩余额度变色' }, { label: '弹通知', description: '' }] };
  const asking = claudeAsst(5, [{ type: 'text', text: '先确认一下' }, { type: 'tool_use', id: 'ask-1', name: 'AskUserQuestion', input: { questions: [question] } }], 'tool_use');
  const pending = activity.inferClaude([prompt, asking]);
  assert.equal(pending.status, 'tool');
  assert.deepEqual(pending.ask, { id: 'ask-1', tool: 'AskUserQuestion', at: T0 + 5000, questions: [{ header: '方案', question: '用哪种方式提示？', multi: false, options: [{ label: '分级颜色', description: '按剩余额度变色' }, { label: '弹通知', description: '' }] }] });
  const answered = line({ type: 'user', timestamp: at(30), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ask-1', content: '用户选了分级颜色' }] } });
  assert.equal(activity.inferClaude([prompt, asking, answered]).ask, undefined, '回答了就不算在问');
  assert.equal(activity.inferClaude([prompt, asking, toolResult(9)]).ask?.id, 'ask-1', '别的工具的结果不算回答');
  assert.equal(activity.inferClaude([prompt, asking, claudeUser(12, '[Request interrupted by user for tool use]')]).ask, undefined, '中断了：这一轮结束');
  assert.equal(activity.inferClaude([prompt, asking, claudeUser(40, '换个问题')]).ask, undefined, '新的一轮');
  const plan = activity.inferClaude([prompt, claudeAsst(6, [{ type: 'tool_use', id: 'plan-1', name: 'ExitPlanMode', input: { plan: '# 计划\n1. 改卡片\n2. 补测试' } }], 'tool_use')]);
  assert.deepEqual([plan.ask.tool, plan.ask.plan, plan.ask.questions], ['ExitPlanMode', '# 计划\n1. 改卡片\n2. 补测试', []]);
  assert.equal(activity.inferClaude([prompt, claudeAsst(6, [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } }], 'tool_use')]).ask, undefined, '普通工具不是提问');
  // 不像样的输入不算提问；长文字截短、个数有上限
  assert.equal(activity.askOf('AskUserQuestion', { questions: [{ header: 'x' }] }, 'a', 0), null);
  assert.equal(activity.askOf('request_user_input', '{not json', 'a', 0), null);
  const big = activity.askOf('AskUserQuestion', { questions: Array(9).fill({ question: '问'.repeat(500), multiSelect: true, options: Array(12).fill({ label: '选\u0007项' }) }) }, 'a', 0);
  assert.deepEqual([big.questions.length, big.questions[0].question.length, big.questions[0].options.length, big.questions[0].options[0].label, big.questions[0].multi], [4, 300, 6, '选项', true]);
  // Codex：request_user_input 的参数是 JSON 字符串；有了 output 就回答了
  const ev = (s, type) => line({ type: 'event_msg', timestamp: at(s), payload: { type } });
  const call = line({ type: 'response_item', timestamp: at(3), payload: { type: 'function_call', call_id: 'q1', name: 'request_user_input', arguments: JSON.stringify({ questions: [{ id: 'mode', header: '模式', question: '先做哪个？', options: [{ label: '前端', description: '先改界面' }] }] }) } });
  const codexAsk = activity.inferCodex([ev(0, 'task_started'), call]);
  assert.deepEqual([codexAsk.ask.id, codexAsk.ask.tool, codexAsk.ask.questions[0].question, codexAsk.ask.questions[0].options[0].label], ['q1', 'request_user_input', '先做哪个？', '前端']);
  assert.equal(activity.inferCodex([ev(0, 'task_started'), call, line({ type: 'response_item', timestamp: at(9), payload: { type: 'function_call_output', call_id: 'q1', output: '{}' } })]).ask, undefined);
  // 在问你：马上算「在等你」；文件一小时没动才当终端关了
  const now = T0 + 3600_000;
  assert.equal(activity.liveStatus({ status: 'tool', since: 0, at: 0, ask: pending.ask }, now - 5000, now), 'waiting');
  assert.equal(activity.liveStatus({ status: 'tool', since: 0, at: 0, ask: pending.ask }, now - activity.STALE_MS - 1, now), 'waiting', '人走开一会儿：还在等');
  assert.equal(activity.liveStatus({ status: 'tool', since: 0, at: 0, ask: pending.ask }, now - activity.ASK_STALE_MS - 1, now), null);
});

(async () => {
  await checkAsync('desk pet: scanner finds recent sessions, skips subagents and old files, reports turns that just finished', async () => {
    const home = path.join(root, 'home'), claude = path.join(home, '.claude', 'projects'), codex = path.join(home, '.codex', 'sessions');
    const now = new Date();
    const day = path.join(codex, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
    fs.mkdirSync(path.join(claude, 'D--work-demo-app'), { recursive: true }); fs.mkdirSync(day, { recursive: true });
    const recent = s => new Date(Date.now() - s * 1000).toISOString();
    const running = path.join(claude, 'D--work-demo-app', 'c-1.jsonl');
    fs.writeFileSync(running, [line({ type: 'ai-title', aiTitle: '额度卡片分级' }), line({ type: 'user', timestamp: recent(120), sessionId: 'c-1', cwd: 'D:\\work\\demo-app', message: { content: '改额度卡片' } }), line({ type: 'assistant', timestamp: recent(5), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } })].join('\n') + '\n');
    const finished = path.join(claude, 'D--work-demo-app', 'c-2.jsonl');
    fs.writeFileSync(finished, [line({ type: 'user', timestamp: recent(200), sessionId: 'c-2', cwd: 'D:\\work\\demo-app', message: { content: '写说明' } }), line({ type: 'assistant', timestamp: recent(100), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } })].join('\n') + '\n');
    const old = path.join(claude, 'D--work-demo-app', 'c-old.jsonl');
    fs.writeFileSync(old, line({ type: 'user', timestamp: recent(9000), sessionId: 'c-old', message: { content: '很久以前' } }) + '\n');
    const longAgo = new Date(Date.now() - 3 * 3600_000); fs.utimesSync(old, longAgo, longAgo);
    // 子代理文件在 <会话>/subagents/ 下：不算单独的任务（已经做完的这个也不算在跑的子代理）
    fs.mkdirSync(path.join(claude, 'D--work-demo-app', 'c-1', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(claude, 'D--work-demo-app', 'c-1', 'subagents', 'agent-a.jsonl'), [line({ type: 'user', timestamp: recent(3), isSidechain: true, message: { content: 'sub' } }), line({ type: 'assistant', timestamp: recent(2), isSidechain: true, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } })].join('\n') + '\n');
    const codexFile = path.join(day, 'rollout-2026-10-22T10-00-00-x-1.jsonl');
    fs.writeFileSync(codexFile, [line({ type: 'session_meta', timestamp: recent(60), payload: { id: 'x-1', cwd: '/home/me/tokenpulse' } }), line({ type: 'event_msg', timestamp: recent(60), payload: { type: 'task_started' } }), line({ type: 'response_item', timestamp: recent(50), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '补单元测试' }] } })].join('\n') + '\n');
    fs.writeFileSync(path.join(day, 'rollout-2026-10-22T10-00-01-x-2.jsonl'), [line({ type: 'session_meta', payload: { id: 'x-2', parent_thread_id: 'x-1' } }), line({ type: 'event_msg', timestamp: recent(5), payload: { type: 'task_started' } })].join('\n') + '\n');
    fs.writeFileSync(path.join(home, '.codex', 'session_index.jsonl'), line({ id: 'x-1', thread_name: '会话解析单元测试' }) + '\n');

    const scanner = new activity.ActivityScanner({ claude, codex, codexIndex: path.join(home, '.codex', 'session_index.jsonl') });
    const first = await scanner.scan();
    assert.deepEqual(first.running.map(t => [t.key, t.status, t.title, t.project, t.tool ?? '']).sort(), [['claude:c-1', 'tool', '额度卡片分级', 'demo-app', 'Bash'], ['codex:x-1', 'thinking', '会话解析单元测试', 'tokenpulse', '']]);
    assert.deepEqual(first.recent.map(t => t.key), ['claude:c-2'], '十分钟内做完的放在「刚完成」');
    assert.deepEqual(first.finished, [], '第一次扫描不算刚做完，免得一启动就庆祝');
    // c-1 这一轮结束：下一次扫描报出来
    fs.appendFileSync(running, line({ type: 'assistant', timestamp: new Date().toISOString(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '好了' }] } }) + '\n');
    const second = await scanner.scan();
    assert.deepEqual(second.finished, ['claude:c-1']);
    assert.deepEqual(second.running.map(t => t.key), ['codex:x-1']);
    assert.deepEqual(second.recent.map(t => t.key), ['claude:c-1', 'claude:c-2'], '最近做完的在前');
    const third = await scanner.scan();
    assert.deepEqual(third.finished, [], '只报一次');
    assert.deepEqual([third.failed, third.needsYou], [[], []]);
    // Codex 这一轮出错停下：报在 failed 里，不算做完（不庆祝）
    fs.appendFileSync(codexFile, line({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'error', message: 'stream disconnected' } }) + '\n');
    const fourth = await scanner.scan();
    assert.deepEqual([fourth.finished, fourth.failed], [[], ['codex:x-1']]);
    assert.deepEqual((await scanner.scan()).failed, [], '出错也只报一次');
    // 大文件只读两头：标题在开头、状态在结尾
    const big = path.join(claude, 'D--work-demo-app', 'c-3.jsonl');
    const filler = line({ type: 'progress', data: 'x'.repeat(2000) });
    fs.writeFileSync(big, [line({ type: 'user', timestamp: recent(30), sessionId: 'c-3', cwd: '/w/big', message: { content: '很长的会话' } }), ...Array(200).fill(filler), line({ type: 'assistant', timestamp: recent(1), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Grep' }] } })].join('\n') + '\n');
    const fresh = new activity.ActivityScanner({ claude, codex, codexIndex: path.join(home, '.codex', 'session_index.jsonl') });
    const scanned = await fresh.scan();
    const bigTask = scanned.running.find(t => t.key === 'claude:c-3');
    assert.ok(bigTask, '大文件也认出来'); assert.equal(bigTask.title, '很长的会话'); assert.equal(bigTask.tool, 'Grep');
    // 工具调用卡了 90 秒以上：刚变成「可能在等你」报一次
    const stuck = new Date(Date.now() - activity.WAITING_MS - 10_000); fs.utimesSync(big, stuck, stuck);
    const waiting = await fresh.scan();
    assert.deepEqual(waiting.needsYou, ['claude:c-3']);
    assert.equal(waiting.running.find(t => t.key === 'claude:c-3').status, 'waiting');
    assert.deepEqual((await fresh.scan()).needsYou, [], '只报一次');
    // 问你问题：刚问的报在 asked 里（不在 needsYou 里）、任务带着问题；同一个问题只报一次；回答了问题就没了
    fs.appendFileSync(big, line({ type: 'assistant', timestamp: new Date().toISOString(), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'ask-9', name: 'AskUserQuestion', input: { questions: [{ question: '要不要顺便补测试？', options: [{ label: '要' }, { label: '不要' }] }] } }] } }) + '\n');
    const asked = await fresh.scan();
    assert.deepEqual([asked.asked, asked.needsYou], [['claude:c-3'], []]);
    const askTask = asked.running.find(t => t.key === 'claude:c-3');
    assert.deepEqual([askTask.status, askTask.ask.id, askTask.ask.questions[0].question], ['waiting', 'ask-9', '要不要顺便补测试？']);
    assert.deepEqual((await fresh.scan()).asked, [], '只报一次');
    fs.appendFileSync(big, line({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'ask-9', content: '要' }] } }) + '\n');
    const replied = await fresh.scan();
    assert.equal(replied.running.find(t => t.key === 'claude:c-3').ask, undefined);
    assert.equal(replied.running.find(t => t.key === 'claude:c-3').status, 'thinking');
    // 启动时已经在问的：第一次扫描不报（不一启动就响），但任务上带着问题（卡片照样弹）
    const restart = await new activity.ActivityScanner({ claude, codex, codexIndex: path.join(home, '.codex', 'session_index.jsonl') }).scan();
    assert.deepEqual(restart.asked, []);
    // 目录不存在不报错
    assert.deepEqual((await new activity.ActivityScanner({ claude: path.join(root, 'none'), codex: path.join(root, 'none'), codexIndex: path.join(root, 'none.jsonl') }).scan()).running, []);
  });

  await checkAsync('desk pet: running Claude subagents count on their session and keep it from looking stuck', async () => {
    const home = path.join(root, 'home-sub'), claude = path.join(home, '.claude', 'projects'), project = path.join(claude, 'D--work-sub');
    const subDir = path.join(project, 's-1', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    const recent = s => new Date(Date.now() - s * 1000).toISOString();
    const ago = (file, s) => { const t = new Date(Date.now() - s * 1000); fs.utimesSync(file, t, t); };
    const main = path.join(project, 's-1.jsonl');
    // 主会话派了个子代理（Agent 调用还没结果），主文件三分钟没动
    fs.writeFileSync(main, [line({ type: 'user', timestamp: recent(300), sessionId: 's-1', cwd: 'D:\\work\\sub', message: { content: '查一下全仓库' } }), line({ type: 'assistant', timestamp: recent(180), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'ag-1', name: 'Agent', input: {} }] } })].join('\n') + '\n');
    ago(main, 180);
    const subA = path.join(subDir, 'agent-a.jsonl');
    fs.writeFileSync(subA, [line({ type: 'user', timestamp: recent(170), isSidechain: true, message: { content: '找用法' } }), line({ type: 'assistant', timestamp: recent(2), isSidechain: true, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Grep' }] } })].join('\n') + '\n');
    // 早就停掉的子代理（没有结束行，但十分钟没动了）不算
    const dead = path.join(subDir, 'agent-dead.jsonl');
    fs.writeFileSync(dead, line({ type: 'user', timestamp: recent(700), isSidechain: true, message: { content: 'old' } }) + '\n');
    ago(dead, 700);
    const scanner = new activity.ActivityScanner({ claude, codex: path.join(home, 'none'), codexIndex: path.join(home, 'none.jsonl') });
    const first = await scanner.scan();
    assert.deepEqual(first.running.map(t => [t.key, t.status, t.tool, t.subagents]), [['claude:s-1', 'tool', 'Agent', 1]], '子代理在动：不是「可能在等你」');
    assert.ok(Date.now() - first.running[0].updatedAt < 60_000, '最近的动静按子代理算');
    // 子代理做完了（交了结果这一轮结束）：主会话又只看自己，三分钟没动的工具调用是「可能在等你」
    fs.appendFileSync(subA, line({ type: 'user', timestamp: new Date().toISOString(), isSidechain: true, toolEndsTurn: true, message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'done' }] } }) + '\n');
    const second = await scanner.scan();
    assert.deepEqual(second.running.map(t => [t.status, t.subagents]), [['waiting', undefined]]);
    // 这一轮结束了，但又开了一个后台子代理：照样算在跑（新文件要先重扫目录，poke 之后下一次就找到）
    fs.appendFileSync(main, [line({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'ag-1', content: 'ok' }] } }), line({ type: 'assistant', timestamp: new Date().toISOString(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '后台在查' }] } })].join('\n') + '\n');
    const subB = path.join(subDir, 'agent-b.jsonl');
    fs.writeFileSync(subB, line({ type: 'user', timestamp: new Date().toISOString(), isSidechain: true, message: { content: '后台任务' } }) + '\n');
    scanner.poke();
    const fourth = await scanner.scan();
    assert.deepEqual(fourth.running.map(t => [t.key, t.status, t.tool, t.subagents]), [['claude:s-1', 'tool', 'Agent', 1]], '后台子代理还在跑');
    fs.appendFileSync(subB, line({ type: 'assistant', timestamp: new Date().toISOString(), isSidechain: true, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '查完了' }] } }) + '\n');
    const fifth = await scanner.scan();
    assert.deepEqual([fifth.running.length, fifth.finished], [0, ['claude:s-1']], '后台子代理也做完了：这时才算做完');
    assert.deepEqual(scanner.watchRoots(), [claude, path.join(home, 'none')]);
  });

  check('desk pet: settings are normalized, defaults keep the pet off', () => {
    const prefs = readPrefs();
    assert.equal(prefs.deskPet, false, '默认关闭');
    assert.deepEqual([prefs.deskPetKind, prefs.deskPetScale, prefs.deskPetOpacity, prefs.deskPetOnTop, prefs.deskPetAccount, prefs.deskPetFidget, prefs.deskPetBadge, prefs.deskPetPos], ['squirrel', 2, 100, true, '', true, true, null]);
    assert.deepEqual(model.normalizeDeskPet({ deskPet: 'yes', deskPetKind: '../evil', deskPetScale: 7, deskPetOpacity: 5, deskPetOnTop: 0, deskPetAccount: 42, deskPetFidget: false, deskPetBadge: undefined, deskPetPos: { x: 'a', y: 1 } }),
      { deskPet: false, deskPetKind: 'squirrel', deskPetScale: 2, deskPetOpacity: 30, deskPetOnTop: true, deskPetAccount: '', deskPetFidget: false, deskPetBadge: true, deskPetPos: null });
    assert.deepEqual(model.normalizeDeskPet({ deskPetKind: 'pet-0a1b2c3d', deskPetScale: '3', deskPetOpacity: 85.4, deskPetPos: { x: 100.6, y: -200.2 } }), { deskPetKind: 'pet-0a1b2c3d', deskPetScale: 3, deskPetOpacity: 85, deskPetPos: { x: 101, y: -200 } });
    assert.deepEqual(model.normalizeDeskPet({ theme: 'dark' }), {}, '不认识的字段不动');
    assert.equal(prefs.deskPetMini, false, '极简模式默认关');
    assert.equal(prefs.deskPetSound, true, '提示音默认开');
    assert.deepEqual(model.normalizeDeskPet({ deskPetSound: 0 }), { deskPetSound: true }, '只有明确的 false 才算关');
    assert.deepEqual(model.normalizeDeskPet({ deskPetSound: false }), { deskPetSound: false });
    assert.deepEqual(model.normalizeDeskPet({ deskPetMini: 'true' }), { deskPetMini: false });
    assert.deepEqual(model.normalizeDeskPet({ deskPetMini: true }), { deskPetMini: true });
    // 音量、单独关掉的提示音、问题卡片
    assert.deepEqual([prefs.deskPetVolume, prefs.deskPetMute, prefs.deskPetAsk], [70, [], true]);
    assert.deepEqual(model.normalizeDeskPet({ deskPetVolume: 140, deskPetMute: ['ask', 'nope', 'done', 'ask'], deskPetAsk: 0 }), { deskPetVolume: 100, deskPetMute: ['done', 'ask'], deskPetAsk: true });
    assert.deepEqual(model.normalizeDeskPet({ deskPetVolume: 'x', deskPetMute: 'done', deskPetAsk: false }), { deskPetVolume: 70, deskPetMute: [], deskPetAsk: false });
    assert.deepEqual(model.normalizeDeskPet({ deskPetVolume: -3.4 }), { deskPetVolume: 0 });
  });

  check('desk pet: the question card sits in the bottom-right corner and steps around the pet', () => {
    const work = { x: 0, y: 0, width: 1920, height: 1040 }, box = { width: 332, height: 200 };
    assert.deepEqual(model.askBounds(box, work, null), { x: 1576, y: 828, width: 332, height: 200 }, '右下角，留 12 像素');
    assert.deepEqual(model.askBounds(box, work, { x: 100, y: 900, width: 144, height: 112 }), { x: 1576, y: 828, width: 332, height: 200 }, '宠物在别处：不动');
    // 宠物就在右下角：挪到它头顶
    assert.deepEqual(model.askBounds(box, work, { x: 1700, y: 900, width: 144, height: 112 }), { x: 1576, y: 692, width: 332, height: 200 });
    // 头顶放不下（卡片很高）：放到宠物左边
    assert.deepEqual(model.askBounds({ width: 332, height: 990 }, work, { x: 1700, y: 300, width: 144, height: 112 }), { x: 1360, y: 38, width: 332, height: 990 });
    // 副屏、卡片比屏幕还大：收进屏幕
    assert.deepEqual(model.askBounds({ width: 900, height: 900 }, { x: 1920, y: 0, width: 800, height: 600 }, null), { x: 1932, y: 12, width: 776, height: 576 });
  });

  check('desk pet: custom sounds — audio files are recognized by their header, copied in, listed and removed', () => {
    const sounds = require('../build/core/pet-sound-file');
    const hex = text => Buffer.from(text, 'hex');
    assert.equal(sounds.audioType(Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1')), 'wav');
    assert.equal(sounds.audioType(Buffer.from('ID3\x04\x00', 'latin1')), 'mp3');
    assert.equal(sounds.audioType(hex('fffb9064')), 'mp3', '没有 ID3 的 MP3 帧');
    assert.equal(sounds.audioType(Buffer.from('OggS\x00\x02', 'latin1')), 'ogg');
    assert.equal(sounds.audioType(Buffer.from('fLaC\x00\x00', 'latin1')), 'flac');
    assert.equal(sounds.audioType(Buffer.from('\x00\x00\x00\x20ftypM4A \x00', 'latin1')), 'm4a');
    assert.equal(sounds.audioType(Buffer.from('<html><script>', 'latin1')), null);
    assert.equal(sounds.audioType(hex('89504e470d0a1a0a')), null, '图片不算');
    const dir = path.join(root, 'sound-src'); fs.mkdirSync(dir, { recursive: true });
    const wav = path.join(dir, 'ding.wav'), fake = path.join(dir, 'fake.mp3'), huge = path.join(dir, 'huge.wav');
    fs.writeFileSync(wav, Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1'), Buffer.alloc(64)]));
    fs.writeFileSync(fake, 'not audio at all');
    fs.writeFileSync(huge, Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WAVE', 'latin1'), Buffer.alloc(sounds.SOUND_FILE_MAX)]));
    assert.deepEqual(sounds.SOUND_KINDS, ['done', 'ask', 'waiting', 'error', 'empty']);
    assert.deepEqual(sounds.listPetSounds(), {});
    assert.throws(() => sounds.importPetSound('done', fake), /不是 WAV、MP3、OGG、FLAC 或 M4A 音频/);
    assert.throws(() => sounds.importPetSound('done', huge), /超过 2 MB/);
    assert.throws(() => sounds.importPetSound('../x', wav), /不认识的提示音/);
    assert.throws(() => sounds.importPetSound('done', dir), /不是普通文件/);
    const item = sounds.importPetSound('ask', wav);
    assert.deepEqual([item.name, item.type, item.size], ['ding.wav', 'wav', 80]);
    fs.rmSync(wav);
    const data = sounds.petSoundData('ask');
    assert.equal(data.type, 'audio/wav'); assert.equal(data.data.length, 80, '用的是复制进来的那份，原文件删了也能放');
    assert.deepEqual(Object.keys(sounds.listPetSounds()), ['ask']);
    assert.ok(fs.existsSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'pet-sounds', 'ask.wav')));
    // 同一种换成别的格式：旧文件删掉
    const ogg = path.join(dir, 'b.ogg'); fs.writeFileSync(ogg, Buffer.from('OggS\x00\x02rest', 'latin1'));
    assert.equal(sounds.importPetSound('ask', ogg).type, 'ogg');
    assert.equal(fs.existsSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'pet-sounds', 'ask.wav')), false);
    assert.equal(sounds.petSoundData('done'), null, '没换过的');
    assert.equal(sounds.petSoundData('nope'), null);
    assert.equal(sounds.removePetSound('ask'), true);
    assert.equal(sounds.removePetSound('ask'), false);
    assert.deepEqual(sounds.listPetSounds(), {});
  });

  check('desk pet: flinging, the right-edge mini mode and the jump into it', () => {
    const work = { x: 0, y: 0, width: 1920, height: 1040 }, size = model.petWindowSize(2), sprite = { width: 144, height: 112 };
    // 松手速度：最后一个点和它之前 40～120 毫秒的点
    const trail = [{ x: 0, y: 0, t: 0 }, { x: 40, y: 0, t: 20 }, { x: 100, y: 10, t: 50 }, { x: 160, y: 20, t: 80 }];
    const v = model.releaseVelocity(trail, 90);
    assert.ok(Math.abs(v.x - 2) < 1e-9 && Math.abs(v.y - 1 / 3) < 1e-9, `用 t=80 和 t=20 的点算，实际 ${JSON.stringify(v)}`);
    assert.deepEqual(model.releaseVelocity(trail, 200), { x: 0, y: 0 }, '停了一会儿才松手：只是放下');
    assert.deepEqual(model.releaseVelocity([{ x: 0, y: 0, t: 0 }, { x: 10, y: 0, t: 50 }], 55), { x: 0, y: 0 }, '太慢不算甩');
    assert.deepEqual(model.releaseVelocity([{ x: 0, y: 0, t: 0 }], 5), { x: 0, y: 0 }, '只有一个点');
    const fast = model.releaseVelocity([{ x: 0, y: 0, t: 0 }, { x: 0, y: 1000, t: 50 }], 50);
    assert.ok(Math.abs(Math.hypot(fast.x, fast.y) - 4) < 1e-9, '太快的按上限算');
    // 甩出去：越来越慢、停在屏幕里；碰边弹回来；用力撞右边就停在右边
    const box = { minX: 0, maxX: work.width - size.width, minY: 0, maxY: work.height - size.height };
    const slide = model.flingPath({ x: 500, y: 400 }, { x: 1, y: 0 }, box);
    assert.equal(slide.hitRight, false);
    assert.ok(slide.points.length > 5 && slide.points.length <= 150);
    const steps = slide.points.map((p, i) => p.x - (i ? slide.points[i - 1].x : 500));
    for (let i = 1; i < steps.length; i++) assert.ok(steps[i] <= steps[i - 1] + 1, '一帧比一帧慢（取整差一像素）');
    assert.ok(steps[steps.length - 1] < steps[0] / 4, '最后慢下来');
    const bounce = model.flingPath({ x: 100, y: 400 }, { x: -2, y: 0 }, box);
    assert.ok(bounce.points.some(p => p.x === 0), '碰到左边');
    assert.ok(bounce.points[bounce.points.length - 1].x > 0, '弹回来一点');
    for (const p of model.flingPath({ x: 900, y: 500 }, { x: 0.5, y: 3 }, box).points) assert.ok(p.y >= box.minY && p.y <= box.maxY, '一直在屏幕里');
    const hit = model.flingPath({ x: 1500, y: 400 }, { x: 3, y: 0 }, box);
    assert.equal(hit.hitRight, true); assert.equal(hit.points[hit.points.length - 1].x, box.maxX);
    assert.equal(model.flingPath({ x: 1200, y: 400 }, { x: 0, y: 0 }, box).points.length, 0, '没有速度不动');
    // 极简模式：窗口贴屏幕右边（整个窗口还在这块屏幕里），高度跟着原来的位置
    const mini = model.miniBounds({ x: 500, y: 600 }, size, work);
    assert.deepEqual(mini, { x: 1920 - 240, y: 600 - 142, width: 240, height: 142 });
    assert.equal(model.miniBounds(null, size, work).x, 1680);
    assert.equal(model.miniSpriteCenter(work, sprite), 1920 - 36, '气泡对着探出来的那截');
    const { tuck, peek } = model.MINI_POSE;
    assert.ok(tuck.show < peek.show && peek.show < 1, '平时只探出头，鼠标移上来探出更多，但不整个出来');
    assert.ok(tuck.tilt > peek.tilt && peek.tilt > 0, '躲着的时候歪得多（只有头探出来），探出来时身子直一些');
    assert.equal(model.reachesRightEdge(model.petBounds(null, size, work), sprite, work), false, '默认位置不算贴边');
    assert.equal(model.reachesRightEdge({ x: 1920 - 240 + 40, y: 0, width: 240, height: 142 }, sprite, work), true, '拖得伸出屏幕右边：贴边');
    assert.equal(model.reachesRightEdge({ x: 1920 - 240 + 4, y: 0, width: 240, height: 142 }, sprite, work), false, '离右边还远');
    // 跳过去：两头准、中间高
    const from = { x: 100, y: 500 }, to = { x: 400, y: 500 };
    assert.deepEqual(model.jumpPoint(from, to, 0, 80), from); assert.deepEqual(model.jumpPoint(from, to, 1, 80), to);
    assert.deepEqual(model.jumpPoint(from, to, 0.5, 80), { x: 250, y: 420 }, '最高处比两头高 arc');
    assert.deepEqual(model.jumpPoint(from, to, 3, 80), to, 'u 超出范围按 1 算');
  });

  check('desk pet: which quota the pet shows, and when it sleeps', () => {
    const title = a => 'T-' + a.kind;
    const snapshot = { accounts: [
      { kind: 'claude', key: 'acc-a', five: { used: 30, pressure: 'none' }, week: { used: 62, pressure: 'none' } },
      { kind: 'chatgpt', key: 'acc-b', five: { used: 5, pressure: 'high' }, week: { used: 20, pressure: 'none' } },
      { kind: 'grok', key: 'acc-c', five: null, week: { used: 140 } },
      { kind: 'claude', key: 'acc-d', five: null, week: null },
    ] };
    assert.deepEqual(model.petQuota(snapshot, '', title), { quota: 38, mood: 'ok', account: 'T-claude', accountId: 'acc-a' }, '默认第一个账号；剩余按用得多的那个窗口');
    assert.deepEqual(model.petQuota(snapshot, 'acc-b', title), { quota: 80, mood: 'tight', account: 'T-chatgpt', accountId: 'acc-b' }, '压力高就紧张，哪怕还剩很多');
    assert.equal(model.petQuota(snapshot, 'acc-c', title).mood, 'empty');
    assert.equal(model.petQuota(snapshot, 'acc-c', title).quota, 0, '超过 100% 按 100 算');
    assert.equal(model.petQuota(snapshot, 'acc-d', title).accountId, 'acc-a', '指定的账号没有额度数据：回到第一个');
    assert.deepEqual(model.petQuota({ accounts: [{ kind: 'claude', week: { used: 88, pressure: 'none' } }] }, '', title).mood, 'tight', '剩不到 15% 也算紧张');
    assert.deepEqual(model.petQuota(null, '', title), { quota: null, mood: 'ok', account: '', accountId: '' });
    // 没指定账号：跟着正在用的——有任务在跑的那家、它的 CLI 当前登录的账号
    const many = { accounts: [
      { kind: 'claude', key: 'k-c1', accountId: 'claude:one', five: { used: 10 }, week: { used: 10 } },
      { kind: 'claude', key: 'k-c2', accountId: 'claude:two', five: { used: 50 }, week: { used: 20 } },
      { kind: 'chatgpt', key: 'k-g1', accountId: 'chatgpt:one', five: { used: 70 }, week: { used: 30 } },
      { kind: 'chatgpt', key: 'k-g2', accountId: 'chatgpt:two', five: null, week: null },
    ] };
    const pick = (pickId, using) => model.pickPetAccount(many.accounts, pickId, using)?.key;
    assert.equal(pick('', { kinds: ['claude'], current: { claude: 'claude:two' } }), 'k-c2', 'Claude Code 在跑：用 Claude 当前登录的账号');
    assert.equal(pick('', { kinds: ['chatgpt', 'claude'], current: { claude: 'claude:two', chatgpt: 'chatgpt:one' } }), 'k-g1', 'Codex 最近有动静：用 ChatGPT 当前登录的');
    assert.equal(pick('', { kinds: ['chatgpt'], current: { chatgpt: 'chatgpt:two' } }), 'k-g1', '当前登录的那个没有额度数据：用那家第一个有数据的');
    assert.equal(pick('', { kinds: ['chatgpt'], current: {} }), 'k-g1', '不知道谁登录着：用那家第一个');
    assert.equal(pick('', { kinds: [], current: { claude: 'claude:two' } }), 'k-c2', '没有任务：排第一的那家，优先它当前登录的');
    assert.equal(pick('', undefined), 'k-c1', '什么都不知道：排第一的账号');
    assert.equal(pick('k-g1', { kinds: ['claude'], current: { claude: 'claude:two' } }), 'k-g1', '手动指定的优先');
    assert.equal(pick('k-g2', { kinds: ['claude'], current: { claude: 'claude:two' } }), 'k-c2', '指定的没有额度数据：回到跟着正在用的');
    assert.equal(model.petQuota(many, '', title, { kinds: ['chatgpt'], current: { chatgpt: 'chatgpt:one' } }).accountId, 'k-g1');
    assert.equal(model.pickPetAccount([], '', { kinds: ['claude'], current: {} }), undefined);
    const busy = { running: [{}], recent: [], finished: [], at: 0 };
    assert.equal(model.petMode(busy, 9999), 'work', '有任务在跑就干活，不睡');
    assert.equal(model.petMode(null, model.SLEEP_AFTER_SECONDS - 1), 'idle');
    assert.equal(model.petMode({ running: [], recent: [], finished: [], at: 0 }, model.SLEEP_AFTER_SECONDS), 'sleep');
  });

  check('desk pet: window placement keeps the pet on screen; the speech bubble sits above it (or beside it at the top edge)', () => {
    assert.deepEqual(model.petWindowSize(2), { width: 240, height: 142 });
    assert.deepEqual(model.petWindowSize(3), { width: 240, height: 198 });
    assert.deepEqual(model.petWindowSize(1), { width: 240, height: 86 });
    const work = { x: 0, y: 0, width: 1920, height: 1040 }, size = model.petWindowSize(2);
    const home = model.petBounds(null, size, work);
    assert.deepEqual(home, { x: 1920 - 240 - 12, y: 1040 - 142 - 4, width: 240, height: 142 }, '默认右下角');
    assert.deepEqual(model.anchorOf(model.petBounds({ x: 500, y: 600 }, size, work)), { x: 500, y: 600 }, '脚下中点放回原处');
    assert.deepEqual(model.petBounds({ x: 99999, y: -50 }, size, work), { x: 1680, y: 0, width: 240, height: 142 }, '拖出屏幕外的拉回来');
    assert.deepEqual(model.petBounds({ x: -1000, y: 500 }, size, { x: -1920, y: 0, width: 1920, height: 1080 }), { x: -1120, y: 358, width: 240, height: 142 }, '左边的副屏是负坐标');
    const sprite = { width: 144, height: 112 }, box = { width: 236, height: 130 };
    // 气泡外沿每边 6 像素（描边和投影），尾巴那一边再加 12
    assert.deepEqual(model.bubbleBounds(home, sprite, box, work), { x: 1664, y: 787, width: 248, height: 154, side: 'down', at: 124 }, '默认在宠物头顶，尾巴朝下指着宠物中间');
    const edge = model.bubbleBounds({ x: 1680, y: 600, width: 240, height: 142 }, sprite, box, work);
    assert.deepEqual([edge.x, edge.side, edge.at], [1668, 'down', 132], '贴着屏幕右边：气泡收进屏幕，尾巴还是对着宠物');
    const top = model.bubbleBounds({ x: 900, y: 0, width: 240, height: 142 }, sprite, box, work);
    assert.deepEqual(top, { x: 1078, y: 4, width: 260, height: 142, side: 'left', at: 65 }, '贴着屏幕顶：放到宠物右边，尾巴在气泡左边');
    const corner = model.bubbleBounds({ x: 1680, y: 0, width: 240, height: 142 }, sprite, box, work);
    assert.deepEqual([corner.x, corner.side], [1482, 'right'], '右上角：放到左边，尾巴在气泡右边');
    assert.ok(model.bubbleBounds(home, sprite, { width: 236, height: 5000 }, work).height <= 1040 - 8, '比屏幕还高就收在可用区域里');
  });

  check('desk pet: custom pet folders are validated, imported as copies, listed and removed', () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082', 'hex');
    const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
    const folder = path.join(root, 'my-cat');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'idle.png'), png); fs.writeFileSync(path.join(folder, 'work.gif'), gif);
    const write = manifest => fs.writeFileSync(path.join(folder, 'pet.json'), JSON.stringify(manifest));
    assert.equal(packs.imageType(png), 'png'); assert.equal(packs.imageType(gif), 'gif');
    assert.equal(packs.imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'webp'); assert.equal(packs.imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
    assert.equal(packs.imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null);
    assert.throws(() => packs.readPetFolder(path.join(root, 'nothing')), /没有 pet\.json/);
    write({ name: '我的猫', states: { work: 'work.gif' } }); assert.throws(() => packs.readPetFolder(folder), /至少要有 idle/);
    write({ name: '', states: { idle: 'idle.png' } }); assert.throws(() => packs.readPetFolder(folder), /名字/);
    write({ name: '我的猫', states: { idle: '../idle.png' } }); assert.throws(() => packs.readPetFolder(folder), /同一个文件夹/);
    write({ name: '我的猫', states: { idle: 'missing.png' } }); assert.throws(() => packs.readPetFolder(folder), /找不到/);
    fs.writeFileSync(path.join(folder, 'evil.png'), '<svg onload="alert(1)"></svg>');
    write({ name: '我的猫', states: { idle: 'evil.png' } }); assert.throws(() => packs.readPetFolder(folder), /不是 PNG、GIF、WebP 或 JPEG/, '扩展名是 png 也要看文件头');
    fs.writeFileSync(path.join(folder, 'huge.png'), Buffer.concat([png, Buffer.alloc(packs.PET_FILE_MAX)]));
    write({ name: '我的猫', states: { idle: 'huge.png' } }); assert.throws(() => packs.readPetFolder(folder), /超过 5 MB/);
    fs.writeFileSync(path.join(folder, 'pet.json'), '{nope'); assert.throws(() => packs.readPetFolder(folder), /不是有效的 JSON/);
    write({ name: '我的猫', author: '小明', states: { idle: 'idle.png', work: 'work.gif', dance: 'idle.png' } });
    const pack = packs.importPetPack(folder);
    assert.match(pack.id, /^pet-[a-f0-9]{8}$/);
    assert.deepEqual([pack.name, pack.author, pack.states], ['我的猫', '小明', { idle: 'idle.png', work: 'work.gif' }], '不认识的状态不收');
    assert.ok(path.resolve(packs.petsDir()).startsWith(path.resolve(root)), '复制到数据目录里');
    fs.rmSync(folder, { recursive: true, force: true });
    assert.deepEqual(packs.listPetPacks().map(p => p.id), [pack.id], '原文件夹删了照样能用');
    const images = packs.petPackImages(pack.id);
    assert.equal(images.name, '我的猫'); assert.match(images.images.idle, /^data:image\/png;base64,/); assert.match(images.images.work, /^data:image\/gif;base64,/);
    assert.equal(packs.petPackImages('../../etc'), null); assert.equal(packs.removePetPack('../data'), false); assert.equal(packs.removePetPack('pet-ffffffff'), false);
    assert.equal(packs.removePetPack(pack.id), true); assert.deepEqual(packs.listPetPacks(), []);
  });

  check('desk pet: when quota is tight the pets only sweat now and then, not all the time', () => {
    require('../renderer/pet-engine.js');
    const Pet = globalThis.PulsePet;
    const sweaty = g => g.c.includes('#9AD8FF');
    // 每秒 10 帧跑两分钟，记下每一段紧张的开始和长度
    const run = (name, ctx, ms = 120_000) => {
      const ctl = new Pet.Controller(name), spans = [];
      let on = null, frames = 0, sweatFrames = 0;
      for (let now = 1_000_000; now < 1_000_000 + ms; now += 100) {
        ctl.tick({ ...ctx, fidget: false }, now);
        const n = ctl.nervous;
        if (n && !on) on = { from: now }; else if (!n && on) { spans.push({ from: on.from, ms: now - on.from }); on = null; }
        frames++; if (sweaty(ctl.frame({ ...ctx, fidget: false }))) sweatFrames++;
      }
      return { spans, share: sweatFrames / frames };
    };
    for (const name of ['squirrel', 'hamster', 'octopus']) for (const state of ['idle', 'work']) {
      const ctx = { state, quota: 20, mood: 'tight', tasks: state === 'work' ? 1 : 0 };
      const { spans, share } = run(name, ctx);
      assert.ok(spans.length >= 3 && spans.length <= 6, `${name}/${state}：两分钟里紧张 3～6 次，实际 ${spans.length}`);
      assert.ok(spans[0].from - 1_000_000 <= 2600, '刚变紧张时很快来一次，让人看得出来');
      for (const span of spans) assert.ok(span.ms >= 2000 && span.ms <= 3100, `每次 2～3 秒，实际 ${span.ms}`);
      for (let i = 1; i < spans.length; i++) assert.ok(spans[i].from - spans[i - 1].from >= 22_000, '两次之间至少隔 20 秒');
      assert.ok(share > 0.03 && share < 0.16, `${name}/${state}：冒汗的帧只占一小部分，实际 ${(share * 100).toFixed(1)}%`);
      // 不紧张的时候：皱眉，但不冒汗
      const calm = new Pet.Controller(name);
      assert.equal(sweaty(calm.frame({ ...ctx, t: 0, nervous: false })), false, `${name}/${state} 平时不冒汗`);
      assert.equal(sweaty(calm.frame({ ...ctx, t: 0, nervous: true })), true, `${name}/${state} 紧张时冒汗`);
    }
    const low = run('squirrel', { state: 'idle', quota: 6, mood: 'tight', tasks: 0 }, 300_000).spans;
    for (let i = 1; i < low.length; i++) assert.ok(low[i].from - low[i - 1].from <= 28_100, '剩不到 10%：隔 15～25 秒一次');
    assert.ok(low.length >= 10, '剩不到 10% 更频繁一些');
    assert.equal(run('squirrel', { state: 'idle', quota: 60, mood: 'ok', tasks: 0 }).spans.length, 0, '额度够用：不紧张');
    assert.equal(run('squirrel', { state: 'sleep', quota: 20, mood: 'tight', tasks: 0 }).spans.length, 0, '睡觉时不紧张');
    assert.equal(run('squirrel', { state: 'idle', quota: 0, mood: 'empty', tasks: 0 }).share, 0, '额度用完：累趴着，不冒汗');
  });

  check('desk pet: sleep sequence (yawn, doze, flop) and waking up', () => {
    const Pet = globalThis.PulsePet;
    const ctx = { state: 'idle', quota: 70, mood: 'ok', tasks: 0, fidget: false };
    const play = (ctl, frames, now, c = ctx) => { for (let i = 0; i < frames; i++) ctl.tick(c, now + i * 100); };
    const ctl = new Pet.Controller('squirrel');
    ctl.setMode('idle'); ctl.idle(5);
    play(ctl, 5, 0);
    assert.equal(ctl.action, null); assert.equal(ctl.stateOf(ctx), 'idle');
    ctl.idle(Pet.DOZE_AFTER);
    ctl.tick(ctx, 1000);
    assert.equal(ctl.action, 'yawn', '一分钟没人动：打哈欠'); assert.equal(ctl.stateOf(ctx), 'doze');
    play(ctl, 30, 1100);
    assert.equal(ctl.action, null, '哈欠打完接着打盹'); assert.equal(ctl.stateOf(ctx), 'doze');
    ctl.idle(Pet.DOZE_AFTER + 20); ctl.tick(ctx, 1000 + Pet.DOZE_MS - 100);
    assert.equal(ctl.stateOf(ctx), 'doze', '打盹还没满半分钟');
    ctl.idle(Pet.DOZE_AFTER + 30); ctl.tick(ctx, 1000 + Pet.DOZE_MS);
    assert.equal(ctl.action, 'flop', '一头栽倒'); assert.equal(ctl.stateOf(ctx), 'sleep');
    play(ctl, 20, 40_000);
    assert.equal(ctl.action, null); assert.equal(ctl.stateOf(ctx), 'sleep', '主进程还说 idle，宠物自己已经睡着了');
    ctl.idle(0);
    assert.equal(ctl.action, 'startle', '睡熟了被吵醒：先吓一跳');
    play(ctl, Pet.durOf('squirrel', 'startle'), 50_000);
    assert.equal(ctl.action, 'wake', '然后揉眼睛'); assert.equal(ctl.stateOf(ctx), 'idle');
    // 打盹时有人动：揉揉眼睛就醒
    const doze = new Pet.Controller('hamster');
    doze.setMode('idle'); doze.idle(70); doze.tick(ctx, 0);
    assert.equal(doze.stateOf(ctx), 'doze');
    doze.idle(2);
    assert.equal(doze.action, 'wake'); assert.equal(doze.stateOf(ctx), 'idle');
    // 有任务在跑、极简模式贴边时不犯困
    const busy = new Pet.Controller('octopus'), work = { ...ctx, state: 'work', tasks: 1 };
    busy.setMode('work'); busy.idle(200); play(busy, 50, 0, work);
    assert.equal(busy.stateOf(work), 'work'); assert.notEqual(busy.action, 'yawn');
    const edge = new Pet.Controller('squirrel'), mini = { ...ctx, mini: true };
    edge.setMode('idle'); edge.idle(200); play(edge, 50, 0, mini);
    assert.equal(edge.stateOf(mini), 'idle');
    // 主进程说睡了（5 分钟没人动）：没睡的先打哈欠；醒来吓一跳
    const main = new Pet.Controller('squirrel');
    main.setMode('idle'); main.setMode('sleep');
    assert.equal(main.action, 'yawn'); assert.equal(main.stateOf({ ...ctx, state: 'sleep' }), 'sleep');
    main.setMode('idle');
    assert.equal(main.action, 'startle');
    // 打开窗口时已经在睡：直接睡着，不打哈欠
    const late = new Pet.Controller('squirrel');
    late.setMode('sleep');
    assert.equal(late.action, null); assert.equal(late.drowse, 'asleep');
  });

  check('desk pet: alert sounds are short synthesized tunes, each kind with its own notes', () => {
    // 假的 Web Audio：记下每个音的频率、开始和停止时间
    const notes = [];
    class FakeContext {
      constructor() { this.currentTime = 10; this.state = 'running'; this.destination = {}; }
      createGain() { return { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
      createOscillator() { const o = { type: '', frequency: { value: 0 }, connect() {}, start(at) { o.at = at; }, stop(end) { o.end = end; notes.push(o); } }; return o; }
    }
    const saved = globalThis.AudioContext;
    globalThis.AudioContext = FakeContext;
    try {
      delete require.cache[require.resolve('../renderer/pet-sound.js')];
      require('../renderer/pet-sound.js');
      const Sound = globalThis.PulsePetSound;
      assert.deepEqual(Sound.KINDS, ['done', 'ask', 'waiting', 'error', 'empty']);
      const tune = kind => { notes.length = 0; assert.equal(Sound.play(kind), true); return notes.map(n => [Math.round(n.frequency.value), n.type]); };
      const done = tune('done');
      assert.ok(done.length >= 3 && done.filter(n => n[1] === 'sine').length === done.length, '做完：正弦波小铃铛');
      const base = done.filter((_, i) => i % 2 === 0).map(n => n[0]);
      assert.deepEqual(base, [...base].sort((a, b) => a - b), '做完：往上走');
      const error = tune('error').map(n => n[0]);
      assert.ok(error[0] > error[1], '出错：往下走');
      assert.ok(Math.max(...notes.map(n => n.end)) - 10 < 0.8, '都很短');
      assert.notDeepEqual(tune('waiting'), tune('empty'));
      const ask = tune('ask').filter((_, i) => i % 2 === 0).map(n => n[0]);
      assert.ok(ask.length === 2 && ask[0] < ask[1], '在问你：一低一高');
      assert.notDeepEqual(tune('ask'), tune('waiting'));
      assert.equal(Sound.play('nope'), false, '不认识的不响');
      globalThis.AudioContext = undefined;
      delete require.cache[require.resolve('../renderer/pet-sound.js')];
      require('../renderer/pet-sound.js');
      assert.equal(globalThis.PulsePetSound.play('done'), false, '没有 Web Audio：不响也不报错');
    } finally { globalThis.AudioContext = saved; }
  });

  await checkAsync('desk pet: a custom sound plays instead of the tune, at the chosen volume, cut off with a fade after 5 seconds', async () => {
    const played = [];
    class FakeContext {
      constructor() { this.currentTime = 10; this.state = 'running'; this.destination = {}; }
      createGain() { const g = { ramps: [], gain: { value: 1, setValueAtTime(v, t) { g.ramps.push(['set', v, t]); }, linearRampToValueAtTime(v, t) { g.ramps.push(['ramp', v, t]); }, exponentialRampToValueAtTime() {} }, connect() {} }; return g; }
      createOscillator() { const o = { frequency: {}, connect() {}, start() {}, stop() { played.push('tone'); } }; return o; }
      createBufferSource() { const s = { connect: out => { s.out = out; }, start(at) { s.at = at; }, stop(end) { s.end = end; played.push(s); } }; return s; }
      async decodeAudioData(buffer) { const bytes = new Uint8Array(buffer); if (bytes[0] !== 0x52) throw new Error('bad'); return { duration: bytes[1] }; }
    }
    const saved = globalThis.AudioContext;
    globalThis.AudioContext = FakeContext;
    try {
      delete require.cache[require.resolve('../renderer/pet-sound.js')];
      require('../renderer/pet-sound.js');
      const Sound = globalThis.PulsePetSound;
      const bytes = new Uint8Array([0x52, 2, 0, 0]);
      assert.equal(await Sound.setCustom('ask', bytes), true);
      assert.equal(bytes.length, 4, '交进去的字节不被占用');
      assert.equal(Sound.hasCustom('ask'), true);
      assert.equal(Sound.play('ask', 0.5), true);
      const short = played.pop();
      assert.equal(typeof short, 'object', '放的是自己的音频，不是合成的调子');
      assert.deepEqual([short.end - short.at, short.out.ramps], [2, [['set', 0.5, short.at]]], '短的原样放完、按音量');
      await Sound.setCustom('done', new Uint8Array([0x52, 9]));
      Sound.play('done', 1);
      const long = played.pop();
      assert.equal(Math.round((long.end - long.at) * 10) / 10, Sound.CUSTOM_MAX_S, '太长的只放 5 秒');
      assert.deepEqual(long.out.ramps.at(-1)[0], 'ramp', '最后淡出');
      assert.equal(await Sound.setCustom('error', new Uint8Array([1, 2])), false, '解不出来：返回 false');
      Sound.play('error'); assert.equal(played.pop(), 'tone', '仍用默认的');
      await Sound.setCustom('ask', null);
      Sound.play('ask'); assert.equal(played.pop(), 'tone', '恢复默认');
      assert.equal(await Sound.setCustom('nope', bytes), false);
    } finally { globalThis.AudioContext = saved; delete require.cache[require.resolve('../renderer/pet-sound.js')]; }
  });

  check('desk pet: clicks — one opens the bubble after the double-click gap, two pokes, four look around', () => {
    const Pet = globalThis.PulsePet;
    const clicks = new Pet.Clicks(300);
    assert.equal(clicks.press(1000), 1);
    assert.equal(clicks.settle(1200), 0, '还没过 300 毫秒：可能是双击');
    assert.equal(clicks.settle(1301), 1, '单击');
    assert.equal(clicks.settle(1400), 0, '读过就清零');
    assert.equal(clicks.press(2000), 1); assert.equal(clicks.press(2250), 2, '双击');
    assert.equal(clicks.settle(2400), 0); assert.equal(clicks.settle(2600), 2);
    for (const [t, n] of [[3000, 1], [3200, 2], [3400, 3], [3600, 4]]) assert.equal(clicks.press(t), n);
    assert.equal(clicks.settle(4000), 4);
    assert.equal(clicks.press(5000), 1); assert.equal(clicks.press(5400), 1, '隔太久：重新数');
  });

  check('desk pet: the new actions and states draw for every built-in pet', () => {
    const Pet = globalThis.PulsePet;
    const base = { quota: 70, mood: 'ok', tasks: 0, t: 5, look: { x: 0, y: 0 }, from: 0 };
    for (const name of ['squirrel', 'hamster', 'octopus']) {
      const key = g => g.c.join(',');
      const idle = key(Pet.drawPet(name, { ...base, state: 'idle', action: null, at: 0 }));
      assert.notEqual(key(Pet.drawPet(name, { ...base, state: 'doze', action: null, at: 0 })), idle, `${name} 打盹和平时不一样`);
      for (const action of ['poke', 'lookaround', 'flop', 'wave']) {
        const frames = new Set();
        for (let at = 0; at < Pet.durOf(name, action); at += 3) frames.add(key(Pet.drawPet(name, { ...base, state: action === 'flop' ? 'sleep' : 'idle', action, at, t: at })));
        assert.ok(frames.size >= 2, `${name}/${action} 是会动的`);
        assert.ok(![...frames].includes(idle), `${name}/${action} 看得出在做动作`);
        assert.ok(Pet.LABELS[action], `${name}/${action} 有名字`);
      }
      // 影子：平时有，被拎着、贴边时没有
      assert.notEqual(key(Pet.drawPet(name, { ...base, state: 'idle', action: null, at: 0, mini: true })), idle, `${name} 贴边时不画影子`);
    }
  });

  /* ---------- 主题包（Clawd on Desk 格式）：消毒、导入、画法 ---------- */
  const sanitize = require('../build/core/svg-sanitize');
  const themes = require('../build/core/pet-theme');

  check('desk pet themes: SVG sanitizer keeps the drawing and drops scripts, handlers, external links and DOCTYPE', () => {
    const clean = sanitize.sanitizeSvg('<?xml version="1.0"?>\n<!-- hi --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="500" onload="alert(1)" xmlns:inkscape="x" inkscape:label="l">'
      + '<defs><style>.a { fill: red; animation: b 1s infinite } @import url(http://x/y.css); .c { background: url("http://evil/x.png") } .d { fill: url(#g) } :host { display: none } @keyframes b { to { opacity: .5 } }</style>'
      + '<linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>'
      + '<script>alert(1)</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'
      + '<g id="eyes-js" class="a" style="fill: blue; background-image: url(http://evil)"><rect x="1" y="1" width="2" height="2" onclick="x()"/></g>'
      + '<a href="http://evil"><rect width="1" height="1"/></a>'
      + '<use href="#g"/><use xlink:href="http://evil/#x"/><image href="data:image/png;base64,AAAA"/><image href="http://evil/a.png"/><image href="data:text/html;base64,AAAA"/>'
      + '<rect fill="url(http://evil/#x)" width="3" height="3"/><rect filter="url(#g)" width="1" height="1"/>'
      + '<animate attributeName="href" values="javascript:alert(1)"/><set attributeName="onclick" to="alert(1)"/><animate attributeName="opacity" values="0;1" dur="1s"/>'
      + '<text>a &amp; b &lt; c &#106;</text><![CDATA[ x ]]></svg>');
    assert.match(clean, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" xmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink" viewBox="0 0 10 10" width="500">/);
    for (const bad of [/onload|onclick/, /<script/i, /foreignObject|xhtml/, /evil/, /<a[\s>]/, /@import/, /javascript/i, /inkscape/, /:host/, /data:text/]) assert.doesNotMatch(clean, bad);
    assert.match(clean, /<g id="eyes-js" class="a" style="fill: blue; background-image: none">/, 'style 属性里的外部地址换成 none');
    assert.match(clean, /\.d \{ fill: url\(#g\) \}/); assert.match(clean, /@keyframes b/);
    assert.match(clean, /<use href="#g"><\/use>/); assert.match(clean, /<image href="data:image\/png;base64,AAAA"><\/image>/);
    assert.equal((clean.match(/<image/g) || []).length, 3, '外部图片的 href 去掉了（元素本身留着也什么都不画）');
    assert.match(clean, /<rect filter="url\(#g\)"/); assert.doesNotMatch(clean, /fill="url\(http/);
    assert.equal((clean.match(/<animate|<set/g) || []).length, 1, '改 href / 事件属性的动画整个不要');
    assert.match(clean, /<text>a &amp; b &lt; c j<\/text>/, '实体解开再转义');
    assert.equal(sanitize.sanitizeSvg(clean), clean, '消毒过的再消毒不变');
    assert.throws(() => sanitize.sanitizeSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>'), /DOCTYPE/);
    assert.throws(() => sanitize.sanitizeSvg('<html><svg/></html>'), /不是 SVG/);
    assert.throws(() => sanitize.sanitizeSvg('<svg><g></svg>'), /写坏了/);
    assert.throws(() => sanitize.sanitizeSvg('<svg></svg><svg></svg>'), /一个根元素/);
    assert.throws(() => sanitize.sanitizeSvg('x'.repeat(sanitize.SVG_FILE_MAX + 1)), /2 MB/);
    assert.match(sanitize.sanitizeSvg('﻿<svg/>'), /^<svg xmlns=[^>]+><\/svg>$/);
    assert.equal(sanitize.sanitizeCss('a{b:u\\72l(http://x)}'), 'a{b:u72l(http://x)}', '反斜杠去掉，转义拼不出 url(');
  });

  // 测试用的小主题：自己画的方块小人（不是任何别人的素材）
  const box = (body, eyes = '', extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -10 40 40"><defs><style>#eyes-js { transition: transform .2s }</style></defs>${extra}<g id="shadow-js"><rect x="2" y="18" width="16" height="1" opacity=".4"/></g><g id="body-js"><rect x="2" y="6" width="16" height="12" fill="${body}"/>${eyes}</g></svg>`;
  const eyes = '<g id="eyes-js"><rect x="6" y="10" width="2" height="2"/><rect x="12" y="10" width="2" height="2"/></g>';
  const makeTheme = (dir, theme, files) => {
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name.endsWith('.png') ? name : path.join('assets', name)), content);
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(theme));
  };
  const testTheme = {
    schemaVersion: 1, name: '方块', author: 'QA', viewBox: { x: -10, y: -10, width: 40, height: 40 },
    layout: { contentBox: { x: 0, y: 4, width: 20, height: 16 }, centerX: 10, baselineY: 19 },
    eyeTracking: { enabled: true, states: ['idle'], maxOffset: 2, bodyScale: 0.5, shadowStretch: 0.2, shadowShift: 0.5, ids: { eyes: 'eyes-js', body: 'body-js', shadow: 'shadow-js' } },
    states: { idle: ['idle.svg'], thinking: ['think.svg'], working: ['work.svg'], notification: ['ask.svg'], attention: ['happy.svg'], error: ['oops.svg'], dizzy: ['dizzy.svg'], sleeping: ['sleep.png'], roam: ['roam.svg'], bogus: ['x.svg'] },
    workingTiers: [{ minSessions: 2, file: 'busy.svg' }, { minSessions: 1, files: ['work.svg'] }],
    reactions: { drag: { file: 'drag.svg' }, double: { files: ['poke.svg', 'missing.svg'], duration: 2500 }, clickLeft: { file: '../evil.svg', duration: 1000 } },
    timings: { autoReturn: { dizzy: 3000, attention: 2000 } },
    hitBoxes: { default: { x: 2, y: 6, w: 16, h: 12 } }, fileHitBoxes: { 'work.svg': { x: 0, y: 0, w: 20, h: 20 } },
    miniMode: { supported: true, states: { 'mini-idle': ['idle.svg'] } }, petTint: true, idleEasterEggs: [{ file: 'egg.svg' }],
  };
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082', 'hex');
  const themeFolder = path.join(root, 'cube-theme');
  makeTheme(themeFolder, testTheme, {
    'idle.svg': box('#e9a', eyes), 'think.svg': box('#9ae', eyes), 'work.svg': box('#9e9'), 'busy.svg': box('#ee9'), 'ask.svg': box('#fc6'), 'happy.svg': box('#fd6'),
    'oops.svg': box('#f66', '', '<script>alert(1)</script>'), 'dizzy.svg': box('#c9f'), 'drag.svg': box('#aaa'), 'poke.svg': box('#f9c'), 'sleep.png': png,
  });

  check('desk pet themes: theme.json is read into the fields TokenPulse uses; unknown ones are dropped', () => {
    const t = themes.normalizeTheme(testTheme);
    assert.deepEqual(Object.keys(t.states), ['idle', 'thinking', 'working', 'error', 'attention', 'notification', 'sleeping', 'dizzy'], '不认识的状态（roam、bogus）不要');
    assert.deepEqual(t.workingTiers, [{ minSessions: 2, files: ['busy.svg'] }, { minSessions: 1, files: ['work.svg'] }], 'file / files 都认，按会话数从多到少');
    assert.deepEqual(t.reactions, { drag: { files: ['drag.svg'], duration: 0 }, double: { files: ['poke.svg', 'missing.svg'], duration: 2500 } }, '带路径的文件名不收');
    assert.equal(t.eyeTracking.maxOffset, 2); assert.equal(t.eyeTracking.ids.dozeEyes, 'eyes-doze', '没写的用默认');
    assert.deepEqual(t.miniMode, { states: { 'mini-idle': ['idle.svg'] }, offsetRatio: 0.5, peek: { offsetRatio: 0.12 }, timings: { autoReturn: {} } });
    assert.equal('petTint' in t || 'idleEasterEggs' in t, false);
    assert.deepEqual(themes.normalizeTheme(t), t, '收过的再收一次不变');
    assert.throws(() => themes.normalizeTheme({ states: { working: ['a.svg'] } }), /至少要有 idle/);
    assert.equal(themes.normalizeTheme({ states: { idle: 'a.svg' }, eyeTracking: { enabled: false } }).eyeTracking, null);
  });

  check('desk pet themes: importing a theme folder copies sanitized SVGs, skips missing files and lists it', () => {
    const pack = packs.importPetPack(themeFolder);
    assert.equal(pack.kind, 'theme'); assert.equal(pack.name, '方块'); assert.equal(pack.author, 'QA');
    assert.match(pack.warning, /1 个动画文件没找到/, 'missing.svg 没找到：提醒一下');
    const dir = path.join(packs.petsDir(), pack.id);
    assert.equal(fs.readFileSync(path.join(dir, 'oops.svg'), 'utf8').includes('script'), false, '存的是消毒后的');
    assert.ok(fs.readFileSync(path.join(dir, 'sleep.png')).equals(png), '位图原样复制（在文件夹根上也找得到）');
    assert.equal(fs.existsSync(path.join(dir, 'missing.svg')), false);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8'));
    assert.equal(stored.kind, 'theme'); assert.deepEqual(stored.theme.reactions.double.files, ['poke.svg'], '没找到的从反应里去掉');
    assert.deepEqual(packs.listPetPacks().find(p => p.id === pack.id), { id: pack.id, name: '方块', author: 'QA', states: { idle: 'idle.svg' }, kind: 'theme' });
    const data = packs.petPackImages(pack.id);
    assert.equal(data.kind, 'theme'); assert.match(data.images.idle, /^data:image\/svg\+xml;base64,/, '设置页预览用 idle');
    assert.match(data.files['idle.svg'].svg, /id="eyes-js"/); assert.match(data.files['sleep.png'].src, /^data:image\/png;base64,/);
    assert.equal(Object.keys(data.files).length, 11);
    // 数据目录里的文件被人改了：读的时候再消毒一遍
    fs.writeFileSync(path.join(dir, 'happy.svg'), box('#fd6', '', '<script>bad()</script><rect onclick="x()" width="1" height="1"/>'));
    assert.doesNotMatch(packs.petPackImages(pack.id).files['happy.svg'].svg, /script|onclick/);
    fs.writeFileSync(path.join(dir, 'idle.svg'), '<html></html>');
    assert.equal(packs.petPackImages(pack.id), null, 'idle 坏了：整个读不出来');
    assert.equal(packs.removePetPack(pack.id), true);
  });

  check('desk pet themes: bad theme folders are refused with a reason', () => {
    const bad = path.join(root, 'bad-theme');
    const reset = () => fs.rmSync(bad, { recursive: true, force: true });
    reset(); fs.mkdirSync(bad); assert.throws(() => packs.importPetPack(bad), /没有 pet\.json 或 theme\.json/);
    reset(); makeTheme(bad, { states: { idle: ['gone.svg'] } }, {}); assert.throws(() => packs.importPetPack(bad), /找不到 idle/);
    reset(); makeTheme(bad, { states: { idle: ['idle.svg'] } }, { 'idle.svg': '<!DOCTYPE svg><svg/>' }); assert.throws(() => packs.importPetPack(bad), /idle\.svg」SVG 里不能有 DOCTYPE/);
    reset(); makeTheme(bad, { states: { idle: ['idle.png'] } }, { 'idle.png': 'not a png' }); assert.throws(() => packs.importPetPack(bad), /不是 SVG、PNG/);
    reset(); fs.mkdirSync(bad); fs.writeFileSync(path.join(bad, 'theme.json'), '{nope'); assert.throws(() => packs.importPetPack(bad), /theme\.json 不是有效的 JSON/);
    reset(); makeTheme(bad, { schemaVersion: 2, states: { idle: ['idle.svg'] } }, { 'idle.svg': box('#fff') });
    const newer = packs.importPetPack(bad);
    assert.match(newer.warning, /格式比 TokenPulse 认识的新/); assert.equal(newer.name, 'bad-theme', '没写名字用文件夹名');
    packs.removePetPack(newer.id);
    assert.equal(fs.readdirSync(packs.petsDir()).length, 0, '导入失败不留半截文件夹');
    reset();
  });

  check('desk pet themes: which animation shows for each action and state, and theme timings', () => {
    require('../renderer/pet-theme.js');
    const PT = globalThis.PulsePetTheme, t = themes.normalizeTheme(testTheme);
    const v = s => PT.visualOf(t, { serial: 0, state: 'idle', mode: 'idle', phase: null, asking: 0, tasks: 0, ...s }).file;
    assert.equal(v({}), 'idle.svg');
    assert.equal(v({ mode: 'work', state: 'work', phase: 'thinking', tasks: 1 }), 'think.svg', '在想');
    assert.equal(v({ mode: 'work', state: 'work', phase: 'tool', tasks: 1 }), 'work.svg', '跑工具：一个任务');
    assert.equal(v({ mode: 'work', state: 'work', phase: 'tool', tasks: 3 }), 'busy.svg', '两个以上换更忙的姿势');
    assert.equal(v({ mode: 'work', state: 'work', phase: 'waiting', tasks: 1 }), 'work.svg', '「可能在等你」不算明确在问');
    assert.equal(v({ mode: 'work', state: 'work', phase: 'waiting', tasks: 1, asking: 1 }), 'ask.svg', '明确在问你');
    assert.equal(v({ action: 'dizzy' }), 'dizzy.svg'); assert.equal(v({ action: 'error' }), 'oops.svg'); assert.equal(v({ action: 'celebrate' }), 'happy.svg');
    assert.equal(v({ action: 'drag' }), 'drag.svg'); assert.equal(v({ action: 'poke' }), 'poke.svg');
    assert.equal(v({ action: 'wave' }), 'ask.svg', '挥手叫你 = notification');
    assert.equal(v({ action: 'tapLeft' }), 'idle.svg', '主题没有的反应退回 idle');
    assert.equal(v({ state: 'sleep' }), 'sleep.png'); assert.equal(v({ state: 'doze' }), 'sleep.png', '没有打盹用睡觉');
    assert.equal(PT.visualOf(t, { action: 'poke', serial: 3 }).once, true, '一次性的要从头放');
    assert.deepEqual(PT.durations(t), { poke: 25, dizzy: 30, celebrate: 20, miniEnter: 15 }, '毫秒换成帧（每秒 10 帧）');
  });

  check('desk pet themes (phase 2): theme fields for idle animations, mini mode and timings are kept', () => {
    const t = themes.normalizeTheme({
      states: { idle: ['idle.svg'] },
      idleAnimations: [{ file: 'look.svg', duration: 6500 }, { file: 'bubble.svg', duration: 13500, mirrorOnRightSide: true }, { file: '../x.svg' }],
      timings: { mouseIdleTimeout: 15000 },
      miniMode: { supported: true, offsetRatio: 0.486, peek: { offsetRatio: 0.2 }, timings: { autoReturn: { 'mini-alert': 4000, 'mini-peek': 1500 } }, states: { 'mini-idle': ['mi.svg'], 'mini-peek-hold': ['mph.svg'], 'mini-sleep-peek': ['msp.svg'], 'mini-bogus': ['b.svg'] } },
    });
    assert.deepEqual(t.idleAnimations, [{ file: 'look.svg', duration: 6500 }, { file: 'bubble.svg', duration: 13500, mirrorOnRightSide: true }]);
    assert.equal(t.timings.mouseIdleTimeout, 15000);
    assert.deepEqual(t.miniMode, { states: { 'mini-idle': ['mi.svg'], 'mini-peek-hold': ['mph.svg'], 'mini-sleep-peek': ['msp.svg'] }, offsetRatio: 0.486, peek: { offsetRatio: 0.2 }, timings: { autoReturn: { 'mini-alert': 4000, 'mini-peek': 1500 } } });
    assert.deepEqual(themes.normalizeTheme(t), t, '收过一次的再收一次不变');
    assert.equal(themes.normalizeTheme({ states: { idle: ['i.svg'] } }).timings.mouseIdleTimeout, 20000, '没写按 20 秒');
    assert.equal(themes.normalizeTheme({ states: { idle: ['i.svg'] }, miniMode: { states: { 'mini-alert': ['a.svg'] } } }).miniMode, null, '没有 mini-idle 不算支持极简');
    assert.equal(themes.normalizeTheme({ states: { idle: ['i.svg'] }, timings: { mouseIdleTimeout: 10 } }).timings.mouseIdleTimeout, 3000, '太短的按 3 秒');
  });

  check('desk pet themes (phase 2): session tiers, subagents, random idle animations and mini mode pick the right animation', () => {
    const PT = globalThis.PulsePetTheme;
    const t = themes.normalizeTheme({
      states: { idle: ['idle.svg'], thinking: ['think.svg'], working: ['work.svg'], juggling: ['juggle.svg'], notification: ['ask.svg'], attention: ['happy.svg'], sleeping: ['sleep.svg'] },
      workingTiers: [{ minSessions: 3, files: ['build-a.svg', 'build-b.svg'] }, { minSessions: 2, file: 'phones.svg' }, { minSessions: 1, file: 'type.svg' }],
      jugglingTiers: [{ minSessions: 2, file: 'juggle2.svg' }, { minSessions: 1, file: 'juggle1.svg' }],
      idleAnimations: [{ file: 'look.svg', duration: 6500 }, { file: 'bubble.svg', duration: 13500, mirrorOnRightSide: true }],
      miniMode: { offsetRatio: 0.486, timings: { autoReturn: { 'mini-enter': 2500 } }, states: { 'mini-idle': ['mi.svg'], 'mini-alert': ['ma.svg'], 'mini-happy': ['mh.svg'], 'mini-enter': ['me.svg'], 'mini-peek': ['mp.svg'], 'mini-sleep': ['ms.svg'], 'mini-enter-sleep': ['mes.svg'] } },
    });
    const pick = s => PT.visualOf(t, { serial: 0, state: 'idle', mode: 'idle', phase: null, asking: 0, tasks: 0, subagents: 0, seed: 0, ...s });
    const v = s => pick(s).file;
    const work = s => v({ mode: 'work', state: 'work', phase: 'tool', ...s });
    assert.deepEqual([work({ tasks: 1 }), work({ tasks: 2 }), work({ tasks: 5 })], ['type.svg', 'phones.svg', 'build-a.svg'], '按任务数换档');
    assert.equal(work({ tasks: 3, seed: 1 }), 'build-b.svg', '一档有好几个：按 seed 挑');
    assert.equal(work({ tasks: 3, seed: 1, serial: 7 }), 'build-b.svg', '同一段干活里做别的动作不换');
    assert.equal(work({ tasks: 1, phase: 'thinking' }), 'think.svg');
    assert.deepEqual([work({ tasks: 1, subagents: 1 }), work({ tasks: 1, subagents: 4, phase: 'thinking' })], ['juggle1.svg', 'juggle2.svg'], '有子代理：同时忙好几件，比思考优先');
    assert.equal(work({ tasks: 1, subagents: 2, asking: 1 }), 'ask.svg', '在问你最优先');
    const noJuggleTiers = themes.normalizeTheme({ states: { idle: ['idle.svg'], juggling: ['juggle.svg'], working: ['work.svg'] } });
    assert.equal(PT.visualOf(noJuggleTiers, { mode: 'work', state: 'work', tasks: 1, subagents: 1 }).file, 'juggle.svg', '没写 jugglingTiers 用 states.juggling');
    assert.equal(PT.visualOf(noJuggleTiers, { mode: 'work', state: 'work', tasks: 1, subagents: 0 }).file, 'work.svg');
    // 随机待机：idle:N 是第几个；写了 mirrorOnRightSide 的在屏幕右半边翻过来
    assert.deepEqual(pick({ action: 'idle:0' }), { file: 'look.svg', once: true, mirror: false });
    assert.deepEqual(pick({ action: 'idle:1', right: true }), { file: 'bubble.svg', once: true, mirror: true });
    assert.deepEqual(pick({ action: 'idle:1', right: false }).mirror, false);
    assert.equal(v({ action: 'idle:9' }), 'idle.svg', '没有这一个：待着');
    const d = PT.durations(t);
    assert.deepEqual([d['idle:0'], d['idle:1'], d.miniEnter], [65, 135, 25]);
    // 极简模式
    const mini = s => v({ mini: true, ...s });
    assert.equal(mini({}), 'mi.svg');
    assert.equal(mini({ action: 'miniEnter' }), 'me.svg');
    assert.equal(mini({ action: 'miniEnter', state: 'sleep' }), 'mes.svg', '睡着进来');
    assert.deepEqual([mini({ action: 'celebrate' }), mini({ action: 'wave' }), mini({ action: 'error' })], ['mh.svg', 'ma.svg', 'ma.svg']);
    assert.equal(mini({ peek: true }), 'mp.svg');
    assert.equal(mini({ peek: true, peekHold: true }), 'mi.svg', '没有 mini-peek-hold：探头放完回 mini-idle');
    assert.equal(mini({ state: 'sleep' }), 'ms.svg'); assert.equal(mini({ state: 'sleep', peek: true }), 'ms.svg', '没有 mini-sleep-peek 用 mini-sleep');
    assert.equal(mini({ mode: 'work', state: 'work', tasks: 2 }), 'mi.svg', '没有 mini-working 用 mini-idle');
    assert.equal(mini({ action: 'idle:0' }), 'mi.svg', '极简模式不放随机待机');
    assert.equal(PT.visualOf(noJuggleTiers, { mini: true, state: 'idle', mode: 'idle' }).file, 'idle.svg', '主题没有极简动画：照平时的挑');
    assert.equal(PT.peekHoldMs(t), 2000);
  });

  check('desk pet: the controller can take a theme\'s idle animations as its fidgets, only after the mouse rests', () => {
    const Pet = globalThis.PulsePet, c = new Pet.Controller('squirrel');
    c.fidgets = ['idle:0', 'idle:1']; c.fidgetGap = [3, 3]; c.fidgetIn = 2; c.fidgetIdx = 0; c.dur = { 'idle:0': 4, 'idle:1': 4 };
    const ctx = { state: 'idle', quota: 80, mood: 'ok', tasks: 0, mini: false, fidget: true, fidgetAfter: 20000 };
    c.aim(10, 10, 1000);
    for (let i = 0; i < 10; i++) c.tick(ctx, 2000 + i * 100);
    assert.equal(c.action, null, '鼠标刚动过：不放');
    c.tick(ctx, 21000); c.tick(ctx, 21100);
    assert.equal(c.action, 'idle:0', '鼠标 20 秒没动：开始轮着放');
    for (let i = 0; i < 4; i++) c.tick(ctx, 21200 + i * 100);
    assert.equal(c.action, null, '按主题写的时长放完');
    for (let i = 0; i < 3; i++) c.tick(ctx, 21700 + i * 100);
    assert.equal(c.action, 'idle:1', '下一个');
    const plain = new Pet.Controller('squirrel'); plain.fidgetIn = 1;
    plain.tick({ ...ctx, fidgetAfter: 0 }, 5000);
    assert.ok(Pet.FIDGETS.squirrel.includes(plain.action), '内置宠物照旧');
  });

  check('desk pet: circling the mouse twice the same way makes it dizzy; wiggling, pauses and the cooldown do not', () => {
    const Pet = globalThis.PulsePet;
    const around = (spin, turns, from = 0, step = Math.PI / 8, r = 60, t0 = 0, dt = 40, dir = 1) => {
      let hit = false, t = t0;
      for (let a = 0; a <= turns * 2 * Math.PI + 1e-9; a += step) { t += dt; hit = spin.add(Math.cos(from + dir * a) * r, Math.sin(from + dir * a) * r, t) || hit; }
      return { hit, t };
    };
    let spin = new Pet.Spin();
    assert.equal(around(spin, 1.8).hit, false, '不到两圈不晕');
    spin = new Pet.Spin();
    assert.equal(around(spin, 2.05).hit, true, '两圈晕');
    spin = new Pet.Spin();
    assert.equal(around(spin, 2.05, 0, Math.PI / 8, 60, 0, 40, -1).hit, true, '反方向转也晕');
    // 左右来回晃：一会儿顺时针一会儿逆时针，加起来抵消
    spin = new Pet.Spin(); let t = 0, wiggle = false;
    for (let k = 0; k < 80; k++) { t += 40; const a = Math.sin(k / 2) * 1.2; wiggle = spin.add(Math.cos(a) * 60, Math.sin(a) * 60, t) || wiggle; }
    assert.equal(wiggle, false, '左右晃不晕');
    // 中间停了超过半秒：从头算
    spin = new Pet.Spin(); const first = around(spin, 1.2); assert.equal(around(spin, 1.2, 0, Math.PI / 8, 60, first.t + 800).hit, false, '停顿后重来');
    // 离得太近（角度乱跳）不算
    spin = new Pet.Spin(); assert.equal(around(spin, 3, 0, Math.PI / 8, 10).hit, false, '贴着身体中心转不算');
    // 晕过 12 秒内不再晕
    spin = new Pet.Spin(); const once = around(spin, 2.05); assert.equal(once.hit, true);
    assert.equal(around(spin, 2.05, 0, Math.PI / 8, 60, once.t).hit, false, '冷却中');
    assert.equal(around(spin, 2.05, 0, Math.PI / 8, 60, once.t + 13000).hit, true, '冷却过了又能晕');
  });

  check('desk pet: built-in pets draw a dizzy pose and a thought bubble while the agent is thinking', () => {
    const Pet = globalThis.PulsePet;
    const base = { quota: 70, mood: 'ok', tasks: 1, t: 5, look: { x: 0, y: 0 }, from: 0, at: 0 };
    const key = g => g.c.join(',');
    for (const name of ['squirrel', 'hamster', 'octopus']) {
      const idle = key(Pet.drawPet(name, { ...base, state: 'idle', action: null }));
      const frames = new Set();
      for (let at = 0; at < Pet.durOf(name, 'dizzy'); at += 4) frames.add(key(Pet.drawPet(name, { ...base, state: 'idle', action: 'dizzy', at, t: at })));
      assert.ok(frames.size >= 3 && !frames.has(idle), `${name} 晕的时候会动、和平时不一样`);
      const work = Pet.drawPet(name, { ...base, state: 'work', phase: 'tool', action: null }), think = Pet.drawPet(name, { ...base, state: 'work', phase: 'thinking', action: null });
      assert.equal(work.c[2 * Pet.W + 63], null, `${name} 跑工具时右上角空着`);
      assert.equal(think.c[2 * Pet.W + 63], '#FFFFFF', `${name} 在想：右上角有个想法泡泡`);
      assert.equal(Pet.drawPet(name, { ...base, state: 'work', phase: 'thinking', action: 'celebrate', at: 3 }).c[2 * Pet.W + 63] === '#FFFFFF', false, `${name} 做动作时不画泡泡`);
    }
    // 主题写的动作时长：Controller 按它算
    const ctl = new Pet.Controller('squirrel'); ctl.dur = { poke: 3 };
    ctl.trigger('poke'); const serial = ctl.serial;
    for (let i = 0; i < 3; i++) ctl.tick({ state: 'idle', quota: 50, fidget: false });
    assert.equal(ctl.action, null, '按主题的时长做完'); assert.equal(serial, 1);
    // 眼睛跟鼠标：鼠标一动直接看过去，不等下一帧慢慢挪；鼠标几秒不动后的东张西望才是慢慢转的
    const eye = new Pet.Controller('squirrel'), now = Date.now();
    eye.aim(400, -300, now);
    assert.deepEqual(eye.look, { x: 2, y: -1.5 }, '立刻看向鼠标');
    eye.aim(-55, 0, now + 16);
    assert.deepEqual(eye.look, { x: -0.5, y: 0 });
    eye.target = { x: 1.5, y: 0 };
    eye.tick({ state: 'idle', quota: 50, fidget: false }, now + 5000);
    assert.ok(eye.look.x > -0.5 && eye.look.x < 1.5, `自己东张西望是慢慢转的 ${eye.look.x}`);
  });

  check('desk pet: phase — tool beats thinking beats waiting', () => {
    const task = status => ({ status });
    assert.equal(model.petPhase(null), null);
    assert.equal(model.petPhase({ running: [task('waiting'), task('thinking')] }), 'thinking');
    assert.equal(model.petPhase({ running: [task('thinking'), task('tool')] }), 'tool');
    assert.equal(model.petPhase({ running: [task('waiting')] }), 'waiting');
  });

  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响结果 */ }
  if (failed) process.exit(1);
})();
