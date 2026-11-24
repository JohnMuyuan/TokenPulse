/*
 * Google Antigravity 的会话管理（core/sessions.ts 的 parseAntigravity、core/antigravity.ts 的 readAntigravityConversation / deleteAntigravityConversation）。
 * 对话库用 node:sqlite 造（字段号照 2026-11 真实文件：step_payload 19.2 用户输入、20.1 回复、20.3 思考、20.7 工具调用、5.4 工具执行、140.2.1 工具输出），
 * 本机 language server 用假的 http 服务器。一次性目录，不碰真实的 ~/.gemini 和 ~/.tokenpulse。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-agy-sessions-'));
const agy = path.join(root, 'antigravity'), home = path.join(root, 'home');
Object.assign(process.env, { TOKENPULSE_DATA_DIR: path.join(root, 'data'), TOKENPULSE_ANTIGRAVITY_DIR: agy, USERPROFILE: home, HOME: home, PI_CODING_AGENT_DIR: path.join(root, 'pi'), TOKENPULSE_DSH_HOME: path.join(root, 'dsh'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), GROK_HOME: path.join(root, 'grok') });
for (const dir of [path.join(agy, 'conversations'), path.join(agy, 'daemon'), home, path.join(root, 'data')]) fs.mkdirSync(dir, { recursive: true });
const { DatabaseSync } = require('node:sqlite');
const sessions = require('../build/core/sessions');
const a = require('../build/core/antigravity');

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const varint = n => { const out = []; let x = BigInt(n); do { let b = Number(x & 0x7fn); x >>= 7n; if (x) b |= 0x80; out.push(b); } while (x); return Buffer.from(out); };
const num = (no, n) => Buffer.concat([varint(no * 8), varint(n)]);
const bytes = (no, buf) => Buffer.concat([varint(no * 8 + 2), varint(buf.length), buf]);
const str = (no, s) => bytes(no, Buffer.from(s, 'utf8'));
const msg = (no, ...parts) => bytes(no, Buffer.concat(parts));
const time = (no, ms) => msg(no, num(1, Math.floor(ms / 1000)), num(2, 0));
const T0 = Date.UTC(2026, 10, 5, 3, 0, 0);
const meta = (at, extra = []) => msg(5, time(1, at), ...extra);
const userStep = (at, text) => Buffer.concat([num(1, 14), num(4, 3), meta(at), msg(19, str(2, text), msg(3, str(1, text)))]);
const replyStep = (at, { text = '', thinking = '', tools = [], gen = 0, usage = null }) => Buffer.concat([num(1, 15), num(4, 3), meta(at, [
  ...(usage ? [msg(9, num(1, 1417), num(2, usage.input || 0), num(3, usage.output || 0), ...(usage.cacheWrite ? [num(4, usage.cacheWrite)] : []), num(5, usage.cacheRead || 0), num(9, usage.thinking || 0))] : []),
  num(11, 1417), msg(20, num(3, gen)),
]),
  msg(20, ...(text ? [str(1, text)] : []), ...(thinking ? [str(3, thinking)] : []), str(6, 'bot-x'), ...tools.map(t => msg(7, str(1, t.id), str(2, t.name), str(3, t.args))))]);
const toolStep = (at, id, name, args, output) => Buffer.concat([num(1, 132), num(4, 3), meta(at, [msg(4, str(1, id), str(2, name), str(3, args))]), msg(140, msg(1, str(1, 'toolSummary'), str(2, 'x')), msg(2, str(1, output)))]);
const incomingStep = (at, text, { senderId = '00000000-0000-4000-8000-000000000000', recipientId = '00000000-0000-4000-8000-000000000001', kind = 'agent_message' } = {}) =>
  Buffer.concat([num(1, 101), num(4, 3), meta(at), msg(114, str(1, `[Message] content=${text}`), ...(kind ? [str(3, kind)] : []), msg(4, str(1, 'msg-uuid'), str(2, recipientId), str(3, senderId), str(4, text)))]);

let convRev = 0;
function conversation(id, steps) {
  const file = path.join(agy, 'conversations', id + '.db');
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('create table steps (idx integer primary key, step_type integer, status integer, metadata blob, step_payload blob); create table gen_metadata (idx integer primary key, data blob, size integer);');
    steps.forEach(([type, status, payload, colMeta], idx) => db.prepare('insert into steps (idx, step_type, status, metadata, step_payload) values (?, ?, ?, ?, ?)').run(idx, type, status, colMeta ?? null, payload ?? null));
    const duration = (no, ms) => msg(no, num(1, Math.floor(ms / 1000)), num(2, Math.floor((ms % 1000) * 1e6)));
    const gen = msg(1, str(19, 'gemini-4-argon-b'), msg(20, str(1, 'model_enum'), str(2, 'MODEL_PLACEHOLDER_M417')), duration(11, 450), duration(12, 1550));
    db.prepare('insert into gen_metadata values (?, ?, ?)').run(0, gen, gen.length);
  } finally {
    db.close();
  }
  // Ensure distinct mtime across rapid same-millisecond rewrites in tests (4KB SQLite page size stays identical).
  convRev += 1;
  const stamp = new Date(Date.now() - 2000 + convRev * 100);
  fs.utimesSync(file, stamp, stamp);
}
const summaries = new DatabaseSync(path.join(agy, 'conversation_summaries.db'));
summaries.exec('create table conversation_summaries (conversation_id text primary key, parent_conversation_id text, title text, workspace_uris text, status text, nesting_depth integer, agent_name text, not_fully_idle integer, killed integer, last_modified_time datetime, last_user_input_time datetime); create table conversation_parents (conversation_id text primary key, parent_id text);');
const summary = (id, title, nesting = 0, parentId = '', opts = {}) => summaries.prepare('insert or replace into conversation_summaries values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
  id,
  parentId,
  title,
  JSON.stringify([pathToFileURL(path.join(root, 'demo-app')).href]),
  opts.status ?? 'CASCADE_RUN_STATUS_IDLE',
  nesting,
  opts.agentName ?? '',
  opts.notFullyIdle ? 1 : 0,
  opts.killed ? 1 : 0,
  opts.modified ?? '2026-11-05 03:10:00.0000000+00:00',
  opts.userInput ?? '2026-11-05 03:00:00.0000000+00:00',
);

(async () => {
  try {
    const A = 'aaaaaaaa-2222-4000-8000-000000000001', SUB = 'bbbbbbbb-2222-4000-8000-000000000002', GONE = 'cccccccc-2222-4000-8000-000000000003';
    conversation(A, [
      [14, 3, userStep(T0, '把首页的额度卡片改成分组显示')],
      [15, 3, replyStep(T0 + 2000, { thinking: '先看看卡片现在怎么画的……', tools: [{ id: 'call_1', name: 'view_file', args: JSON.stringify({ AbsolutePath: 'D:\\demo-app\\card.js' }) }, { id: 'call_2', name: 'run_command', args: JSON.stringify({ CommandLine: 'npm test' }) }], usage: { input: 2000, output: 400, cacheRead: 8000, thinking: 150 } })],
      [132, 3, toolStep(T0 + 3000, 'call_1', 'view_file', JSON.stringify({ AbsolutePath: 'D:\\demo-app\\card.js' }), 'function card() {}')],
      [132, 7, toolStep(T0 + 4000, 'call_2', 'run_command', JSON.stringify({ CommandLine: 'npm test' }), '1 failing')],
      [23, 3, Buffer.concat([num(1, 23), num(4, 3), meta(T0 + 4500)])],
      [15, 3, replyStep(T0 + 5000, { text: '改好了：两组额度各占一行。', usage: { input: 1000, output: 600, cacheRead: 9000, thinking: 50 } })],
    ]);
    summary(A, '额度卡片分组');
    conversation(SUB, [[101, 3, incomingStep(T0, '子代理的任务', { recipientId: SUB })], [15, 3, replyStep(T0 + 1000, { text: '好' })]]);
    summary(SUB, '', 1, '', { agentName: 'explorer' });
    conversation(GONE, [[14, 3, userStep(T0, '删掉的')], [15, 3, replyStep(T0 + 1000, { text: '好' })]]);
    a.rememberModelLabels({ MODEL_PLACEHOLDER_M417: 'Gemini 4 Argon (High)' });

    const list = sessions.listSessions().filter(s => s.kind === 'antigravity');
    assert.deepEqual(list.map(s => s.id).sort(), [A, SUB], '主对话和子代理均入索引；已删掉的不列');
    const item = list.find(s => s.id === A);
    const subItem = list.find(s => s.id === SUB);
    assert.deepEqual([subItem.isSubagent, subItem.agentName, subItem.resumable, subItem.resumeCommand, subItem.canDelete], [true, 'explorer', false, '', false]);
    assert.equal(subItem.title, 'explorer · 子代理的任务');
    assert.deepEqual([item.key, item.title, item.project, item.cwd, item.turns, item.messageCount, item.toolCount, item.models, item.resumeCommand, item.createdAt],
      [`antigravity:${A}`, '额度卡片分组', 'demo-app', path.join(root, 'demo-app'), 1, 2, 2, ['gemini-4-argon'], `agy.exe --conversation ${A}`, T0]);
    assert.equal(item.preview, '改好了：两组额度各占一行。');
    assert.strictEqual(item.avgRoundDurationMs, 2000);
    assert.deepEqual(item.usage, {
      requests: 2,
      input: 20000,
      output: 1000,
      cacheRead: 17000,
      cacheWrite: 0,
      reasoning: 200,
      tokens: 21000,
      cacheHitRate: 85,
      costUsd: 0.019,
      uncachedCostUsd: 0.035,
      cacheSavedUsd: 0.016,
      models: [{
        model: 'gemini-4-argon',
        requests: 2,
        input: 20000,
        output: 1000,
        cacheRead: 17000,
        cacheWrite: 0,
        reasoning: 200,
        tokens: 21000,
        cacheHitRate: 85,
        costUsd: 0.019,
        uncachedCostUsd: 0.035,
        cacheSavedUsd: 0.016,
        tokenShare: 100,
        requestShare: 100,
        costShare: 100,
        avgRoundDurationMs: 2000,
      }],
      avgRoundDurationMs: 2000,
      totalActiveDurationMs: 2000,
      avgTokensPerSec: 500,
    });
    pass('antigravity sessions: listed from the summary database with title, project, turns, tools, model labels and session usage');

    const detail = sessions.getSession('antigravity', A);
    assert.deepEqual(detail.usage, item.usage);
    assert.deepEqual(detail.messages.map(m => [m.role, m.role === 'tool' ? m.name : m.text]), [
      ['user', '把首页的额度卡片改成分组显示'], ['tool', 'view_file'], ['tool', 'run_command'], ['assistant', '改好了：两组额度各占一行。'],
    ], '思考过程不展示；工具调用挂上结果');
    const [, view, run, replyMsg] = detail.messages;
    assert.deepEqual([view.summary, view.output, view.error], ['D:\\demo-app\\card.js', 'function card() {}', undefined]);
    assert.deepEqual([run.summary, run.output, run.error], ['npm test', '1 failing', true], '出错的工具步骤标出来');
    assert.strictEqual(replyMsg.durationMs, 2000, 'Antigravity totalMs parsed from protobuf metadata');
    assert.strictEqual(replyMsg.firstTokenMs, 450, 'Antigravity TTFT parsed from gen_metadata field 11');
    assert.strictEqual(replyMsg.latencyEstimated, false, 'Direct measured flag is false');
    assert.strictEqual(replyMsg.model, 'gemini-4-argon');
    assert.strictEqual(replyMsg.tokensPerSec, 354.8, 'Generation speed tokensPerSec uses pure streaming phase (550 visible tokens in 1.55s = 354.8 T/s)');
    const subDetail = sessions.getSession('antigravity', SUB);
    assert.ok(subDetail && subDetail.isSubagent);
    assert.deepEqual(subDetail.messages.map(m => [m.role, m.text]), [['user', '子代理的任务'], ['assistant', '好']], '子代理的 step_type=101 指令正常展开');
    pass('antigravity sessions: the detail shows user messages, replies and tool calls with their output (thinking hidden, failed tools marked)');

    // 多步带长排队耗时的轮次以极短文本收尾时，沿用本轮实测流式速度而非除以含排队总时长
    const SHORT_END = '11111111-2222-4000-8000-000000000009';
    {
      const db = new DatabaseSync(path.join(agy, 'conversations', SHORT_END + '.db'));
      db.exec('create table steps (idx integer primary key, step_type integer, status integer, metadata blob, step_payload blob); create table gen_metadata (idx integer primary key, data blob, size integer);');
      const duration = (no, ms) => msg(no, num(1, Math.floor(ms / 1000)), num(2, Math.floor((ms % 1000) * 1e6)));
      db.prepare('insert into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)').run(0, 14, 3, userStep(T0 + 20000, '跑一下简短确认'));
      db.prepare('insert into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)').run(1, 15, 3, replyStep(T0 + 21000, { gen: 0, tools: [{ id: 'c1', name: 'run_command', args: '{}' }], usage: { input: 1000, output: 400 } }));
      db.prepare('insert into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)').run(2, 132, 3, toolStep(T0 + 48000, 'c1', 'run_command', '{}', 'ok'));
      db.prepare('insert into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)').run(3, 15, 3, replyStep(T0 + 49000, { gen: 1, text: '好，已完成。', usage: { input: 1000, output: 10 } }));
      const g0 = msg(1, str(19, 'gemini-4-argon-b'), msg(20, str(1, 'model_enum'), str(2, 'MODEL_PLACEHOLDER_M417')), duration(11, 25000), duration(12, 2000));
      const g1 = msg(1, str(19, 'gemini-4-argon-b'), msg(20, str(1, 'model_enum'), str(2, 'MODEL_PLACEHOLDER_M417')), duration(11, 12000), duration(12, 100));
      db.prepare('insert into gen_metadata values (?, ?, ?)').run(0, g0, g0.length);
      db.prepare('insert into gen_metadata values (?, ?, ?)').run(1, g1, g1.length);
      db.close();
      summary(SHORT_END, '短回复测试');
      const shortDetail = sessions.getSession('antigravity', SHORT_END);
      const finalMsg = shortDetail.messages.find(m => m.role === 'assistant');
      assert.strictEqual(finalMsg.tokensPerSec, 200, '短尾步回退到本轮工具步实测流式速度 200 T/s，不被 37s 排队耗时拉低');
      summaries.prepare('delete from conversation_summaries where conversation_id = ?').run(SHORT_END);
      fs.rmSync(path.join(agy, 'conversations', SHORT_END + '.db'), { force: true });
    }
    pass('antigravity sessions: short final reply in multi-step turn inherits measured streaming speed without queue-wait dilution');

    // 多层嵌套子代理：各自保留自身 usage，主对话汇总 subagentCount 与 subtreeUsage
    const SUB1 = 'eeeeeeee-2222-4000-8000-000000000005';
    const SUB2 = 'ffffffff-2222-4000-8000-000000000006';
    conversation(SUB1, [[101, 3, incomingStep(T0 + 6000, '子代理 1 任务', { senderId: A, recipientId: SUB1 })], [15, 3, replyStep(T0 + 7000, { text: '子代理 1 完成', usage: { input: 3000, output: 500, cacheRead: 2000, thinking: 100 } })]]);
    summary(SUB1, '', 1, A, { agentName: 'teamwork_orchestrator' });
    conversation(SUB2, [[101, 3, incomingStep(T0 + 8000, '子代理 2 任务', { senderId: SUB1, recipientId: SUB2 })], [15, 3, replyStep(T0 + 9000, { text: '子代理 2 完成', usage: { input: 1000, output: 500, cacheRead: 4000, thinking: 50 } })]]);
    summary(SUB2, '', 2, SUB1, { agentName: 'teamwork_worker' });
    const listWithSubs = sessions.listSessions().filter(s => s.kind === 'antigravity');
    const byId = Object.fromEntries(listWithSubs.map(s => [s.id, s]));
    assert.equal(byId[A].usage.requests, 2, '主对话自身 usage 只算自己的 2 次调用（不重复计数）');
    assert.equal(byId[A].usage.tokens, 21000);
    assert.equal(byId[A].subagentCount, 2, '主对话挂载两层共 2 个子代理');
    assert.equal(byId[A].subtreeUsage.requests, 4, 'subtreeUsage 归集主对话 2 + 一级 1 + 二级 1 = 4 次');
    assert.equal(byId[A].subtreeUsage.tokens, 32000, 'subtreeUsage = 21000 + 5500 + 5500 = 32000');
    assert.equal(byId[SUB1].parentKey, `antigravity:${A}`);
    assert.equal(byId[SUB1].rootKey, `antigravity:${A}`);
    assert.equal(byId[SUB1].depth, 1);
    assert.equal(byId[SUB1].usage.tokens, 5500);
    assert.equal(byId[SUB2].parentKey, `antigravity:${SUB1}`);
    assert.equal(byId[SUB2].rootKey, `antigravity:${A}`);
    assert.equal(byId[SUB2].depth, 2);
    assert.equal(byId[SUB2].usage.tokens, 5500);
    assert.equal(sessions.getSession('antigravity', A).subtreeUsage.tokens, 32000, '详情页同样带出 subtreeUsage');
    pass('antigravity sessions: nested subagents have own usage and roll up subagentCount + subtreeUsage to root');

    // 原生 Swarm：仅有 step_type=101 通知/任务 + 纯工具调用（无纯文本回复）的 Swarm worker 不被丢弃，且带 swarmTitle / hasSwarm
    const COORD = '11111111-aaaa-4000-8000-000000000010';
    const WORKER = '22222222-aaaa-4000-8000-000000000011';
    const PARKED = '33333333-aaaa-4000-8000-000000000012';
    const ORPHAN_P = '44444444-aaaa-4000-8000-000000000013';
    conversation(COORD, [
      [14, 3, userStep(T0 + 30_000, '开启 Swarm 审查')],
      [15, 3, replyStep(T0 + 32_000, { text: '已派出 worker。', usage: { input: 1000, output: 100 } })],
    ]);
    summary(COORD, 'Swarm 主会话', 0, '', { status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: true });
    // Tool-only Swarm worker: 0 step_type=14, 0 assistant plain text, only step_type=101 + post_message tool call!
    conversation(WORKER, [
      [101, 3, incomingStep(T0 + 33_000, '[swarm] new board message #1', { senderId: COORD, recipientId: WORKER, kind: '' })],
      [101, 3, incomingStep(T0 + 33_500, 'You have just started. Your assignment (recorded on the board as #1 for @audit-worker):\n\n审查会话解析模块', { senderId: COORD, recipientId: WORKER, kind: 'agent_message' })],
      [15, 3, replyStep(T0 + 35_000, { tools: [{ id: 'pm_1', name: 'post_message', args: JSON.stringify({ text: '@coordinator [done] ok' }) }], usage: { input: 2000, output: 300, cacheRead: 1000 } })],
      [132, 3, toolStep(T0 + 36_000, 'pm_1', 'post_message', JSON.stringify({ text: '@coordinator [done] ok' }), '{"status":"posted"}')],
    ]);
    summary(WORKER, '', 1, COORD, { agentName: 'audit-worker', status: 'CASCADE_RUN_STATUS_IDLE', modified: '0001-01-01 00:00:00+00:00', userInput: '0001-01-01 00:00:00+00:00' });
    const swarmDir = path.join(agy, 'brain', COORD, '.system_generated', 'swarm');
    fs.mkdirSync(swarmDir, { recursive: true });
    fs.writeFileSync(path.join(swarmDir, 'members.json'), JSON.stringify({
      title: '会话子代理审查蜂群',
      members: {
        coordinator: { conversation_id: COORD, role: 'coordinator', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
        'audit-worker': { conversation_id: WORKER, role: 'worker', phase: 'RUNNING', wake_mode: 'working', killed: false },
        monitor: { conversation_id: PARKED, role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
      },
    }));
    const subDescDir = path.join(agy, 'brain', COORD, '.system_generated', 'subagents');
    fs.mkdirSync(subDescDir, { recursive: true });
    fs.writeFileSync(path.join(subDescDir, `${WORKER}.json`), JSON.stringify({
      conversationId: WORKER,
      subagentDescriptor: { typeName: 'worker', role: 'worker' },
      state: 'SUBAGENT_STATE_ALIVE',
      spawnStepIndex: 1,
    }));

    const swarmList = sessions.listSessions().filter(s => s.kind === 'antigravity');
    const sById = Object.fromEntries(swarmList.map(s => [s.id, s]));
    assert.ok(sById[WORKER], '纯工具输出且无 step_type=14 的 Swarm worker 正常入索引');
    assert.equal(sById[WORKER].isSubagent, true);
    assert.equal(sById[WORKER].subagentKind, 'swarm');
    assert.equal(sById[WORKER].agentName, 'audit-worker');
    assert.equal(sById[WORKER].subagentRole, 'worker');
    assert.equal(sById[WORKER].parentKey, `antigravity:${COORD}`);
    assert.equal(sById[WORKER].rootKey, `antigravity:${COORD}`);
    assert.equal(sById[WORKER].swarmTitle, '会话子代理审查蜂群');
    assert.equal(sById[WORKER].title, 'audit-worker · 审查会话解析模块');
    assert.equal(sById[WORKER].turns, 1, '[swarm] 通知归入 event，任务指派归入 user');
    assert.equal(sById[WORKER].toolCount, 1);
    assert.equal(sById[WORKER].usage.tokens, 3300);
    assert.equal(sById[COORD].hasSwarm, true);
    assert.equal(sById[COORD].swarmTitle, '会话子代理审查蜂群');
    assert.equal(sById[COORD].subagentCount, 1);
    assert.equal(sById[COORD].subtreeUsage.tokens, 4400);
    const workerDetail = sessions.getSession('antigravity', WORKER);
    assert.ok(workerDetail.messages.some(m => m.role === 'event' && m.text.includes('[swarm]')));
    assert.ok(workerDetail.messages.some(m => m.role === 'user' && m.text.includes('审查会话解析模块')));
    assert.ok(workerDetail.messages.some(m => m.role === 'tool' && m.name === 'post_message'));
    pass('antigravity swarm sessions: step_type=101 brief + tool-only swarm worker parsed with swarmTitle, hasSwarm, and non-empty detail');

    // Antigravity 桌宠活跃探测（readAntigravityActivity）：
    // 1. 0001-01-01 + WAL 滞后 Swarm worker 正在跑工具 -> 协调器（IDLE + not_fully_idle=1）识别为 tool 并挂上 children
    const now = Date.now();
    const liveRunMeta = msg(4, str(1, 'call_live_1'), str(2, 'run_command'), str(3, '{"CommandLine":"npm test"}'));
    conversation(WORKER, [
      [101, 3, incomingStep(now - 5000, '跑测试', { senderId: COORD, recipientId: WORKER })],
      [132, 2, null, Buffer.concat([time(1, now - 2000), liveRunMeta])],
    ]);
    conversation(PARKED, [[101, 3, incomingStep(now - 5000, 'monitor')], [15, 3, replyStep(now - 4000, { text: 'waiting' })]]);
    summary(PARKED, '', 1, COORD, { agentName: 'monitor', status: 'CASCADE_RUN_STATUS_IDLE', modified: '2026-11-05 03:10:00.0000000+00:00' });
    // 同时验证 conversation_parents 中的孤儿子库也能挂到协调器
    conversation(ORPHAN_P, [[132, 2, null, Buffer.concat([time(1, now - 1500), msg(4, str(1, 'call_o'), str(2, 'grep_search'), str(3, '{}'))])]]);
    summaries.prepare('insert or replace into conversation_parents values (?, ?)').run(ORPHAN_P, COORD);
    // 环路保护测试：自环/互环不死循环
    summaries.prepare('insert or replace into conversation_parents values (?, ?)').run('55555555-aaaa-4000-8000-000000000014', '66666666-aaaa-4000-8000-000000000015');
    summaries.prepare('insert or replace into conversation_parents values (?, ?)').run('66666666-aaaa-4000-8000-000000000015', '55555555-aaaa-4000-8000-000000000014');

    const act1 = a.readAntigravityActivity(now - 60_000, agy, now);
    const coordAct1 = act1.find(x => x.id === COORD);
    assert.ok(coordAct1 && coordAct1.running, '0001-01-01 WAL 滞后 worker 激活空闲 Swarm 协调器');
    assert.equal(coordAct1.swarm, true);
    assert.equal(coordAct1.swarmTitle, '会话子代理审查蜂群');
    assert.equal(coordAct1.phase, 'tool');
    assert.equal(coordAct1.tool, 'run_command');
    assert.equal(coordAct1.subagents, 2, '同时识别到 Swarm worker 和 conversation_parents 里的活跃子库');
    assert.ok(coordAct1.children.some(c => c.id === WORKER && c.name === 'audit-worker' && c.tool === 'run_command' && c.swarm === true));

    // 2. Worker 触发 ask_question / WAITING -> 协调器优先提升为 waiting 并透传 ask
    const askMeta = Buffer.concat([time(1, now - 1000), msg(4, str(1, 'call_ask_w'), str(2, 'ask_question'), str(3, JSON.stringify({ questions: [{ question: '继续合并吗？', options: ['是', '否'] }] })))]);
    conversation(WORKER, [
      [101, 3, incomingStep(now - 5000, '跑测试', { senderId: COORD, recipientId: WORKER })],
      [132, 9, null, askMeta],
    ]);
    const act2 = a.readAntigravityActivity(now - 60_000, agy, now);
    const coordAct2 = act2.find(x => x.id === COORD);
    assert.equal(coordAct2.phase, 'waiting');
    assert.equal(coordAct2.tool, 'ask_question');
    assert.equal(coordAct2.ask?.name, 'ask_question');
    assert.equal(coordAct2.children[0].id, WORKER);
    assert.equal(coordAct2.children[0].status, 'waiting');
    assert.equal(coordAct2.children[0].ask, 'ask_question');

    // 3. 所有 worker 均休眠（wake_mode=mentions、步骤完成）且无活跃子库 -> IDLE + not_fully_idle=1 的协调器不再误报 running/thinking
    summaries.prepare('delete from conversation_parents where conversation_id = ?').run(ORPHAN_P);
    conversation(WORKER, [[101, 3, incomingStep(now - 5000, '跑测试')], [15, 3, replyStep(now - 4000, { text: 'done' })]]);
    fs.writeFileSync(path.join(swarmDir, 'members.json'), JSON.stringify({
      title: '会话子代理审查蜂群',
      members: {
        coordinator: { conversation_id: COORD, role: 'coordinator', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
        'audit-worker': { conversation_id: WORKER, role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
        monitor: { conversation_id: PARKED, role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
      },
    }));
    const act3 = a.readAntigravityActivity(now - 60_000, agy, now);
    const coordAct3 = act3.find(x => x.id === COORD);
    assert.equal(coordAct3?.running ?? false, false, '所有 worker 休眠后，IDLE + not_fully_idle=1 的 Swarm 协调器不再卡在 running/thinking');
    // 清理测试用的 Swarm 夹具以免干扰下方删除测试
    for (const tid of [COORD, WORKER, PARKED, ORPHAN_P, SUB, SUB1, SUB2]) {
      summaries.prepare('delete from conversation_summaries where conversation_id = ?').run(tid);
      fs.rmSync(path.join(agy, 'conversations', tid + '.db'), { force: true });
    }
    summaries.exec('delete from conversation_parents');
    fs.rmSync(path.join(agy, 'brain', COORD), { recursive: true, force: true });
    pass('antigravity activity: WAL/0001-01-01 swarm worker, conversation_parents, ask propagation, cycle guard, and idle coordinator fix');

    // 删除：没开着就拒绝，不碰文件；开着就请它自己删（DeleteCascadeTrajectory），删完清掉 TokenPulse 的索引
    const reply = require('../build/main/session-reply');
    await assert.rejects(reply.deleteSession('antigravity', A), /Antigravity 没有在运行/);
    assert.ok(fs.existsSync(path.join(agy, 'conversations', A + '.db')));
    const hits = [];
    const server = http.createServer((req, res) => { let body = ''; req.on('data', c => body += c); req.on('end', () => {
      hits.push({ url: req.url, csrf: req.headers['x-codeium-csrf-token'], body: JSON.parse(body || '{}') });
      // 假装 Antigravity 删掉了：对话列表里去掉这一行
      summaries.prepare('delete from conversation_summaries where conversation_id = ?').run(JSON.parse(body).cascadeId);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
    }); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      fs.writeFileSync(path.join(agy, 'daemon', 'hub_9.json'), JSON.stringify({ pid: process.pid, httpPort: server.address().port, csrfToken: 'csrf-sessions' }));
      await assert.rejects(a.deleteAntigravityConversation('../x'), /对话 ID 不对/);
      await reply.deleteSession('antigravity', A);
      assert.deepEqual(hits.map(h => [h.url, h.csrf, h.body]), [['/exa.language_server_pb.LanguageServerService/DeleteCascadeTrajectory', 'csrf-sessions', { cascadeId: A }]]);
      assert.deepEqual(sessions.listSessions().filter(s => s.kind === 'antigravity'), [], '删掉以后列表里没有了');
      assert.equal(sessions.getSession('antigravity', A), null);
    } finally { server.close(); }
    pass('antigravity sessions: deleting asks the running Antigravity (DeleteCascadeTrajectory) and refuses when it is closed, without touching files');

    // Antigravity CLI（~/.gemini/antigravity-cli）：无头模式的 0001-01-01 时间戳回退到文件 mtime；无需打开 IDE 即可直接删本地文件；CLI 回复与终端命令解析
    const agyCli = a.antigravityCliDir();
    for (const dir of [path.join(agyCli, 'conversations'), path.join(agyCli, 'brain'), path.join(agyCli, 'annotations')]) fs.mkdirSync(dir, { recursive: true });
    const cliId = 'dddddddd-2222-4000-8000-000000000004';
    const cliDbFile = path.join(agyCli, 'conversations', cliId + '.db');
    const cliDb = new DatabaseSync(cliDbFile);
    cliDb.exec('create table steps (idx integer primary key, step_type integer, status integer, metadata blob, step_payload blob); create table gen_metadata (idx integer primary key, data blob, size integer);');
    cliDb.prepare('insert into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)').run(0, 14, 3, userStep(T0 + 10000, '在 CLI 里跑一次检查'));
    cliDb.prepare('insert into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)').run(1, 15, 3, replyStep(T0 + 12000, { text: 'CLI 检查通过。', usage: { input: 500, output: 100 } }));
    cliDb.close();
    fs.mkdirSync(path.join(agyCli, 'brain', cliId), { recursive: true });
    fs.writeFileSync(path.join(agyCli, 'annotations', cliId + '.pbtxt'), 'last_user_view_time {}');
    const cliSummaries = new DatabaseSync(path.join(agyCli, 'conversation_summaries.db'));
    try {
      cliSummaries.exec('create table conversation_summaries (conversation_id text primary key, title text, workspace_uris text, status text, nesting_depth integer, last_modified_time datetime)');
      cliSummaries.prepare('insert into conversation_summaries values (?, ?, ?, ?, ?, ?)').run(cliId, '', JSON.stringify([pathToFileURL(path.join(root, 'cli-proj')).href]), 'CASCADE_RUN_STATUS_IDLE', 0, '0001-01-01 00:00:00+00:00');
    } finally {
      cliSummaries.close();
    }
    const cliList = sessions.listSessions().filter(s => s.kind === 'antigravity');
    assert.deepEqual(cliList.map(s => [s.id, s.title, s.project, s.resumeCommand]), [[cliId, '在 CLI 里跑一次检查', 'cli-proj', `agy.exe --conversation ${cliId}`]]);
    await reply.deleteSession('antigravity', cliId);
    assert.equal(fs.existsSync(cliDbFile), false, 'CLI 会话无需打开 IDE 即可直接删掉本地 .db');
    assert.equal(fs.existsSync(path.join(agyCli, 'brain', cliId)), false, '同名的 brain 目录一并清理');
    assert.equal(fs.existsSync(path.join(agyCli, 'annotations', cliId + '.pbtxt')), false, 'annotations 一并清理');
    assert.deepEqual(sessions.listSessions().filter(s => s.kind === 'antigravity'), []);

    assert.deepEqual(reply.replyArgs('antigravity', A, 'readonly'), ['--conversation', A, '--output-format', 'stream-json', '--mode', 'plan']);
    assert.deepEqual(reply.replyArgs('antigravity', A, 'edit'), ['--conversation', A, '--output-format', 'stream-json', '--mode', 'accept-edits']);
    assert.match(reply.terminalScript('antigravity', A, 'D:\\demo-app'), /Get-Command agy\.exe[\s\S]*'--conversation' 'aaaaaaaa-2222-4000-8000-000000000001'/);
    assert.deepEqual(reply.readEvent('antigravity', JSON.stringify({ event: 'step_update', step_update: { text_delta: '你好' } }), false), { delta: '你好' });
    assert.deepEqual(reply.readEvent('antigravity', JSON.stringify({ event: 'step_update', step_update: { tool: { name: 'run_command', detail: 'npm test' } } }), true), { tool: 'run_command npm test' });
    assert.deepEqual(reply.readEvent('antigravity', JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '完整回复' } }), false), { final: '完整回复' });
    assert.deepEqual(reply.readEvent('antigravity', JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '完整回复' } }), true), {});
    assert.deepEqual(reply.readEvent('antigravity', JSON.stringify({ event: 'error', error: '连接中断' }), false), { error: '连接中断' });
    pass('antigravity CLI sessions: scanned from antigravity-cli, deleted locally without IDE, and stream-json reply/terminal commands work');

    // Antigravity 子代理实际使用 Claude Opus 4.6（gen_metadata 1.19 = claude-opus-4-6-medium），但 model_enum / label 沿用父会话 Opus 5.5 时，会话管理正确标为 claude-opus-4-6
    const AGY_P55 = '77777777-2222-4000-8000-000000000016';
    const AGY_S46 = '88888888-2222-4000-8000-000000000017';
    a.rememberModelLabels({ MODEL_PLACEHOLDER_M401: 'Claude Opus 5.5 (Medium)' });
    const writeCustomAgyConv = (id, rawModel, enumName, label) => {
      const file = path.join(agy, 'conversations', id + '.db');
      const db = new DatabaseSync(file);
      try {
        db.exec('create table steps (idx integer primary key, step_type integer, status integer, metadata blob, step_payload blob); create table gen_metadata (idx integer primary key, data blob, size integer);');
        db.prepare('insert into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)').run(0, 14, 3, userStep(T0 + 20_000, '核查型号'));
        db.prepare('insert into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)').run(1, 15, 3, replyStep(T0 + 22_000, { text: '已核查', usage: { input: 2000, output: 300 } }));
        const gen = msg(1, str(19, rawModel), msg(20, str(1, 'model_enum'), str(2, enumName)), str(21, label));
        db.prepare('insert into gen_metadata values (?, ?, ?)').run(0, gen, gen.length);
      } finally { db.close(); }
    };
    writeCustomAgyConv(AGY_P55, 'claude-opus-5-5-medium', 'MODEL_PLACEHOLDER_M401', 'Claude Opus 5.5 (Medium)');
    writeCustomAgyConv(AGY_S46, 'claude-opus-4-6-medium', 'MODEL_PLACEHOLDER_M401', 'Claude Opus 5.5 (Medium)');
    summary(AGY_P55, '主对话 Opus 5.5', 0);
    summary(AGY_S46, '子代理 Opus 4.6', 1, AGY_P55, { agentName: 'researcher' });
    const agyOpusList = sessions.listSessions().filter(s => s.kind === 'antigravity');
    const p55 = agyOpusList.find(s => s.id === AGY_P55);
    const s46 = agyOpusList.find(s => s.id === AGY_S46);
    assert.deepEqual(p55?.models, ['claude-opus-5-5']);
    assert.deepEqual(s46?.models, ['claude-opus-4-6'], 'Antigravity 子代理实际为 Opus 4.6 时不被 Opus 5.5 标签覆盖');
    assert.equal(s46?.usage?.models?.[0]?.model, 'claude-opus-4-6');
    const s46Detail = sessions.getSession('antigravity', AGY_S46);
    assert.equal(s46Detail?.messages.find(m => m.role === 'assistant')?.model, 'claude-opus-4-6');
    pass('antigravity subagent sessions: Opus 4.6 subagent under Opus 5.5 parent is labeled claude-opus-4-6 even when model_enum/label inherits Opus 5.5');

    console.log(`${checks}/${checks} antigravity session checks passed`);
  } finally {
    summaries.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error('FAIL', error); process.exit(1); });
