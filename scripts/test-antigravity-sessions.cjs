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

function conversation(id, steps) {
  const db = new DatabaseSync(path.join(agy, 'conversations', id + '.db'));
  db.exec('create table steps (idx integer primary key, step_type integer, status integer, metadata blob, step_payload blob); create table gen_metadata (idx integer primary key, data blob, size integer);');
  steps.forEach(([type, status, payload], idx) => db.prepare('insert into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)').run(idx, type, status, payload));
  const duration = (no, ms) => msg(no, num(1, Math.floor(ms / 1000)), num(2, Math.floor((ms % 1000) * 1e6)));
  const gen = msg(1, str(19, 'gemini-4-argon-b'), msg(20, str(1, 'model_enum'), str(2, 'MODEL_PLACEHOLDER_M417')), duration(11, 450), duration(12, 1550));
  db.prepare('insert into gen_metadata values (?, ?, ?)').run(0, gen, gen.length);
  db.close();
}
const summaries = new DatabaseSync(path.join(agy, 'conversation_summaries.db'));
summaries.exec('create table conversation_summaries (conversation_id text primary key, parent_conversation_id text, title text, workspace_uris text, status text, nesting_depth integer, last_modified_time datetime)');
const summary = (id, title, nesting = 0, parentId = '') => summaries.prepare('insert or replace into conversation_summaries values (?, ?, ?, ?, ?, ?, ?)').run(id, parentId, title, JSON.stringify([pathToFileURL(path.join(root, 'demo-app')).href]), 'CASCADE_RUN_STATUS_IDLE', nesting, '2026-11-05 03:10:00.0000000+00:00');

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
    conversation(SUB, [[14, 3, userStep(T0, '子代理的任务')], [15, 3, replyStep(T0 + 1000, { text: '好' })]]);
    summary(SUB, '子代理', 1);
    conversation(GONE, [[14, 3, userStep(T0, '删掉的')], [15, 3, replyStep(T0 + 1000, { text: '好' })]]);
    a.rememberModelLabels({ MODEL_PLACEHOLDER_M417: 'Gemini 4 Argon (High)' });

    const list = sessions.listSessions().filter(s => s.kind === 'antigravity');
    assert.deepEqual(list.map(s => s.id), [A], '子代理、对话列表里已经没有的不列');
    const item = list[0];
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
    assert.strictEqual(replyMsg.tokensPerSec, 300, 'Generation speed tokensPerSec is calculated (600 output tokens in 2s = 300 T/s)');
    assert.equal(sessions.getSession('antigravity', SUB), null);
    pass('antigravity sessions: the detail shows user messages, replies and tool calls with their output (thinking hidden, failed tools marked)');

    // 子代（含多层嵌套子代理）消耗的 Token 归入主对话统计，但子代理自己不单独出现在列表里
    const SUB1 = 'eeeeeeee-2222-4000-8000-000000000005';
    const SUB2 = 'ffffffff-2222-4000-8000-000000000006';
    conversation(SUB1, [[14, 3, userStep(T0 + 6000, '子代理 1 任务')], [15, 3, replyStep(T0 + 7000, { text: '子代理 1 完成', usage: { input: 3000, output: 500, cacheRead: 2000, thinking: 100 } })]]);
    summary(SUB1, '子代理 1', 1, A);
    conversation(SUB2, [[14, 3, userStep(T0 + 8000, '子代理 2 任务')], [15, 3, replyStep(T0 + 9000, { text: '子代理 2 完成', usage: { input: 1000, output: 500, cacheRead: 4000, thinking: 50 } })]]);
    summary(SUB2, '子代理 2', 2, SUB1);
    const listWithSubs = sessions.listSessions().filter(s => s.kind === 'antigravity');
    assert.deepEqual(listWithSubs.map(s => s.id), [A], '嵌套子代仍不单独成行');
    assert.equal(listWithSubs[0].usage.requests, 4, '主对话 2 次 + 一级子代 1 次 + 二级子代 1 次 = 4 次模型调用');
    assert.equal(listWithSubs[0].usage.tokens, 32000, '主对话 21000 + 子代1 (3000+2000+500=5500) + 子代2 (1000+4000+500=5500) = 32000');
    assert.equal(sessions.getSession('antigravity', A).usage.tokens, 32000, '详情页用量同样归集子代 Token');
    pass('antigravity sessions: nested subagent usage (including multi-level children) is aggregated into the root session');

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

    console.log(`${checks}/${checks} antigravity session checks passed`);
  } finally {
    summaries.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error('FAIL', error); process.exit(1); });
