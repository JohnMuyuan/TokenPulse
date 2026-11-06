/*
 * Google Antigravity 的用量和额度（src/core/antigravity.ts、usage-scan.ts 的 scanAntigravity）。
 * 用 node:sqlite 造假的对话库（字段号照 2026-11 真实文件：steps.metadata 1 开始时间、6 完成时间、9 用量、11 型号 id、20.3 生成序号；
 * gen_metadata 1.19 型号名、1.20 键值对 model_enum），一次性数据目录，不碰真实的 ~/.gemini 和 ~/.tokenpulse。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-agy-'));
const agy = path.join(root, 'antigravity');
const home = path.join(root, 'home');
Object.assign(process.env, { TOKENPULSE_DATA_DIR: path.join(root, 'data'), TOKENPULSE_ANTIGRAVITY_DIR: agy, USERPROFILE: home, HOME: home, PI_CODING_AGENT_DIR: path.join(root, 'pi') });
for (const dir of [agy, home, path.join(agy, 'conversations'), path.join(agy, 'daemon')]) fs.mkdirSync(dir, { recursive: true });
const { DatabaseSync } = require('node:sqlite');
const a = require('../build/core/antigravity');
const scan = require('../build/core/usage-scan');

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };

/* ---------- 最小的 protobuf 编码 ---------- */
const varint = n => { const out = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return Buffer.from(out); };
const num = (no, n) => Buffer.concat([varint(no * 8), varint(n)]);
const bytes = (no, buf) => Buffer.concat([varint(no * 8 + 2), varint(buf.length), buf]);
const str = (no, s) => bytes(no, Buffer.from(s, 'utf8'));
const msg = (no, ...parts) => bytes(no, Buffer.concat(parts));
const time = (no, ms) => msg(no, num(1, Math.floor(ms / 1000)), num(2, (ms % 1000) * 1e6));

const T0 = Date.UTC(2026, 10, 5, 2, 0, 0);
/** 一步模型回复的 metadata。 */
function stepMeta({ start, end, modelId, gen, input, output, cacheRead = 0, cacheWrite = 0, thinking = 0, response = 'resp' }) {
  return Buffer.concat([
    time(1, start), num(3, 2), ...(end ? [time(6, end), time(7, end + 50), time(8, end + 50)] : []),
    msg(9, num(1, modelId), num(2, input), num(3, output), ...(cacheWrite ? [num(4, cacheWrite)] : []), num(5, cacheRead), num(6, 24), str(7, 'bot-x'), num(9, thinking), num(10, output - thinking), str(11, response)),
    num(11, modelId), msg(20, str(1, 'traj'), num(2, 0), num(3, gen), str(4, 'conv')),
  ]);
}
const genMeta = (name, modelEnum) => Buffer.concat([str(2, 'xx'), str(4, 'uuid'), msg(1, str(19, name), msg(20, str(1, 'model_enum'), str(2, modelEnum)), msg(20, str(1, 'request_id'), str(2, 'r')))]);

function makeConversation(id, steps, gens) {
  const file = path.join(agy, 'conversations', id + '.db');
  const db = new DatabaseSync(file);
  db.exec('create table steps (idx integer primary key, step_type integer, status integer, has_subtrajectory numeric, metadata blob, step_payload blob); create table gen_metadata (idx integer primary key, data blob, size integer);');
  const put = db.prepare('insert or replace into steps (idx, step_type, status, metadata) values (?, ?, ?, ?)');
  for (const s of steps) put.run(s.idx, s.type, s.status, s.meta ?? null);
  const gm = db.prepare('insert or replace into gen_metadata (idx, data, size) values (?, ?, ?)');
  for (const [idx, data] of gens) gm.run(idx, data, data.length);
  db.close();
  return file;
}
function addSteps(file, steps) {
  const db = new DatabaseSync(file);
  const put = db.prepare('insert or replace into steps (idx, step_type, status, metadata) values (?, ?, ?, ?)');
  for (const s of steps) put.run(s.idx, s.type, s.status, s.meta ?? null);
  db.close();
  const later = new Date(Date.now() + 5000); fs.utimesSync(file, later, later);
}

(async () => {
  try {
    // 对话 A：用户提问 → 回复（Flash Medium）→ 工具 → 回复（Flash Medium）→ 正在生成（还没完成）
    const conv = 'aaaaaaaa-0000-4000-8000-000000000001';
    const fileA = makeConversation(conv, [
      { idx: 0, type: 14, status: 3 },
      { idx: 1, type: 15, status: 3, meta: stepMeta({ start: T0, end: T0 + 4000, modelId: 1319, gen: 0, input: 1000, output: 600, cacheRead: 9000, thinking: 100, response: 'r1' }) },
      { idx: 2, type: 132, status: 3 },
      { idx: 3, type: 15, status: 3, meta: stepMeta({ start: T0 + 5000, end: T0 + 7000, modelId: 1319, gen: 1, input: 500, output: 10, cacheRead: 10000, cacheWrite: 200 }) },
      { idx: 4, type: 15, status: 1, meta: stepMeta({ start: Date.now() - 1000, end: 0, modelId: 1417, gen: 2, input: 0, output: 0 }) },
    ], [[0, genMeta('gemini-3.8-flash', 'MODEL_PLACEHOLDER_M319')], [1, genMeta('', 'MODEL_PLACEHOLDER_M319')], [2, genMeta('gemini-4-argon-b', 'MODEL_PLACEHOLDER_M417')]]);
    // 工作区：对话列表库
    const sum = new DatabaseSync(path.join(agy, 'conversation_summaries.db'));
    sum.exec('create table conversation_summaries (conversation_id text, title text, workspace_uris text, status text)');
    sum.prepare('insert into conversation_summaries values (?, ?, ?, ?)').run(conv, '标题', JSON.stringify([require('node:url').pathToFileURL(path.join(root, 'proj')).href]), 'CASCADE_RUN_STATUS_RUNNING');
    sum.close();

    let r = scan.scanLocalUsage();
    assert.equal(r.records.length, 2, '还在生成的那一步不算');
    const [first, second] = r.records;
    assert.deepEqual([first.kind, first.id, first.at, first.model, first.requested], ['antigravity', conv + ':1', T0 + 4000, 'gemini-3.8-flash', 'gemini-3.8-flash']);
    assert.deepEqual([first.input, first.output, first.cacheRead, first.cacheWrite, first.reasoning, first.calls, first.responseId], [10000, 600, 9000, 0, 100, 1, 'r1'], '输入含缓存，输出含思考');
    assert.deepEqual([second.input, second.cacheRead, second.cacheWrite], [10700, 10000, 200], '缓存写入也算进输入');
    assert.equal(first.cwd, path.join(root, 'proj'), '项目目录取对话的工作区');
    assert.deepEqual(first.estimate, { ms: 4000, tokensPerSec: 150 }, '用时 = 完成 − 开始');
    assert.equal(second.estimate, undefined, '输出太少不估速度');
    pass('antigravity usage: finished model replies become requests (input incl. cache, output incl. thinking), the one still generating waits, workspace and speed');

    // 增量：没变就不读；正在生成的那一步完成了再记
    assert.equal(scan.scanLocalUsage().records.length, 0);
    addSteps(fileA, [{ idx: 4, type: 15, status: 3, meta: stepMeta({ start: T0 + 8000, end: T0 + 9000, modelId: 1417, gen: 2, input: 300, output: 50 }) }]);
    r = scan.scanLocalUsage();
    assert.deepEqual(r.records.map(x => [x.id, x.model]), [[conv + ':4', 'gemini-4-argon-b']], '只读新完成的那一步；没有标签时用内部名');
    pass('antigravity usage: incremental by step, a reply is counted once it finishes');

    // 额度接口给了标签：之前的记录整份重算成显示名 + 档位，流水去重后不重复
    a.rememberModelLabels({ MODEL_PLACEHOLDER_M319: 'Gemini 3.8 Flash (Medium)', MODEL_PLACEHOLDER_M417: 'Gemini 4 Argon (High)', MODEL_PLACEHOLDER_M400: 'Claude Opus 5.5 (Low)' });
    r = scan.scanLocalUsage();
    assert.deepEqual(r.records.map(x => [x.model, x.effort]), [['gemini-3.8-flash', 'medium'], ['gemini-3.8-flash', 'medium'], ['gemini-4-argon', 'high']]);
    assert.equal(a.resolveModel({ model: 'claude-x', enum: 'MODEL_PLACEHOLDER_M400' }, a.readModelLabels()).model, 'claude-opus-5-5', 'Claude 的型号写成 Claude Code 的样子');
    const all = fs.readdirSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'requests')).flatMap(f => fs.readFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'requests', f), 'utf8').trim().split('\n')).map(JSON.parse).filter(x => x.kind === 'antigravity');
    assert.deepEqual(all.map(x => [x.id, x.model]), [[conv + ':1', 'gemini-3.8-flash'], [conv + ':3', 'gemini-3.8-flash'], [conv + ':4', 'gemini-4-argon']], '流水里只留重算后的');
    const days = Object.values(scan.readRollups().files).filter(f => f.kind === 'antigravity')[0].days;
    assert.deepEqual(Object.keys(days['2026-11-04'] ?? days['2026-11-05'] ?? {}), ['Antigravity']);
    const models = Object.values(days).flatMap(d => Object.entries(d.Antigravity));
    assert.deepEqual(models.map(([m, b]) => [m, b.requests]).sort(), [['gemini-3.8-flash', 2], ['gemini-4-argon', 1]], '按天的账也重算了，没有旧名字');
    assert.equal(scan.scanLocalUsage().records.length, 0, '重算过一次就不再重算');
    pass('antigravity usage: model labels from the quota API rename models and effort once, rescanning without duplicates');

    // 卡住很久的一步（崩溃、被杀）不挡住后面的
    const conv2 = 'bbbbbbbb-0000-4000-8000-000000000002';
    makeConversation(conv2, [
      { idx: 0, type: 15, status: 1, meta: stepMeta({ start: T0, end: 0, modelId: 1319, gen: 0, input: 0, output: 0 }) },
      { idx: 1, type: 15, status: 3, meta: stepMeta({ start: T0 + 1000, end: T0 + 2000, modelId: 1319, gen: 0, input: 10, output: 5 }) },
    ], [[0, genMeta('gemini-3.8-flash', 'MODEL_PLACEHOLDER_M319')]]);
    r = scan.scanLocalUsage();
    assert.deepEqual(r.records.map(x => x.id), [conv2 + ':1']);
    assert.equal(r.records[0].cwd, undefined, '对话列表里没有的就没有项目目录');
    pass('antigravity usage: a step stuck for over an hour does not block later replies');

    // 取消（6）、出错（7）的生成是结束了的：不挡住后面；被打断之前写了用量的照算。生成中（8）、等批准（9）的要等
    const conv3 = 'dddddddd-0000-4000-8000-000000000004';
    const now = Date.now();
    const file3 = makeConversation(conv3, [
      { idx: 0, type: 15, status: 6, meta: stepMeta({ start: now - 60000, end: now - 59000, modelId: 1319, gen: 0, input: 0, output: 0 }) },
      { idx: 1, type: 15, status: 7, meta: stepMeta({ start: now - 50000, end: now - 49000, modelId: 1319, gen: 0, input: 400, output: 30 }) },
      { idx: 2, type: 15, status: 3, meta: stepMeta({ start: now - 40000, end: now - 39000, modelId: 1319, gen: 0, input: 100, output: 20 }) },
      { idx: 3, type: 15, status: 9, meta: stepMeta({ start: now - 30000, end: 0, modelId: 1319, gen: 0, input: 0, output: 0 }) },
      { idx: 4, type: 15, status: 3, meta: stepMeta({ start: now - 20000, end: now - 19000, modelId: 1319, gen: 0, input: 1, output: 1 }) },
    ], [[0, genMeta('gemini-3.8-flash', 'MODEL_PLACEHOLDER_M319')]]);
    r = scan.scanLocalUsage();
    assert.deepEqual(r.records.map(x => [x.id, x.input]), [[conv3 + ':1', 400], [conv3 + ':2', 100]], '取消的没用量不记，出错前的用量照记；停在等批准的那一步');
    addSteps(file3, [{ idx: 3, type: 15, status: 3, meta: stepMeta({ start: now - 30000, end: now - 25000, modelId: 1319, gen: 0, input: 7, output: 2 }) }]);
    assert.deepEqual(scan.scanLocalUsage().records.map(x => x.id), [conv3 + ':3', conv3 + ':4'], '批准之后接着读');
    pass('antigravity usage: canceled and failed replies are finished (partial usage counted), generating and waiting-for-approval ones wait');

    // 额度：GetUserStatus 按剩余比例 + 重置时间分组；用完的那组没有 remainingFraction
    const status = { userStatus: { name: 'QA', email: 'qa@example.com', planStatus: { planInfo: { planName: 'Pro' } }, userTier: { name: 'Google AI Ultra' }, cascadeModelConfigData: { clientModelConfigs: [
      { label: 'Gemini 4 Argon (High)', modelOrAlias: { model: 'M417' }, quotaInfo: { remainingFraction: 0.75, resetTime: '2026-11-06T09:00:00Z' } },
      { label: 'Gemini 4 Argon (Low)', modelOrAlias: { model: 'M419' }, quotaInfo: { remainingFraction: 0.75, resetTime: '2026-11-06T09:00:00Z' } },
      { label: 'Gemini 3.8 Flash (High)', modelOrAlias: { model: 'M318' }, quotaInfo: { remainingFraction: 0.75, resetTime: '2026-11-06T09:00:00Z' } },
      { label: 'Claude Opus 5.5 (Low)', modelOrAlias: { model: 'M400' }, quotaInfo: { resetTime: '2026-11-06T10:00:00Z' } },
      { label: 'GPT-OSS 120B (Medium)', modelOrAlias: { model: 'M500' }, quotaInfo: { resetTime: '2026-11-06T10:00:00Z' } },
    ] } } };
    const parsed = a.parseAntigravityStatus(status);
    assert.deepEqual(parsed.groups, [
      { models: ['Gemini 4 Argon', 'Gemini 3.8 Flash'], used: 25, resetAt: '2026-11-06T09:00:00Z' },
      { models: ['Claude Opus 5.5', 'GPT-OSS 120B'], used: 100, resetAt: '2026-11-06T10:00:00Z' },
    ]);
    assert.deepEqual([parsed.plan, parsed.tier, parsed.labels.M400], ['Pro', 'Google AI Ultra', 'Claude Opus 5.5 (Low)']);
    assert.equal(JSON.stringify(parsed).includes('qa@example.com'), false, '不带邮箱');
    assert.equal(a.parseAntigravityStatus({}), null);
    pass('antigravity quota: models sharing a quota are grouped, an exhausted group (no remainingFraction) is 100% used, no email kept');

    // 本机接口：从 daemon/hub_*.json 找端口和令牌，带 CSRF 头问；Antigravity 没开（没有 hub、进程不在）返回 null
    assert.equal(await a.fetchAntigravityStatus(), null);
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = ''; req.on('data', c => body += c); req.on('end', () => {
        seen.push({ url: req.url, csrf: req.headers['x-codeium-csrf-token'], connect: req.headers['connect-protocol-version'], body });
        if (req.headers['x-codeium-csrf-token'] !== 'csrf-qa') { res.writeHead(403); res.end('{}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(status));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      fs.writeFileSync(path.join(agy, 'daemon', 'hub_1.json'), JSON.stringify({ pid: 999999, httpPort: 1, csrfToken: 'stale' }));
      assert.equal(await a.fetchAntigravityStatus(), null, '进程已经不在的 hub 文件不用');
      fs.writeFileSync(path.join(agy, 'daemon', 'hub_2.json'), JSON.stringify({ pid: process.pid, httpPort: server.address().port, httpsPort: 1, lsVersion: '2.29.0', csrfToken: 'csrf-qa' }));
      const live = await a.fetchAntigravityStatus();
      assert.deepEqual(live.groups.map(g => g.used), [25, 100]);
      assert.deepEqual([seen[0].url, seen[0].csrf, seen[0].connect], ['/exa.language_server_pb.LanguageServerService/GetUserStatus', 'csrf-qa', '1']);
      assert.equal(a.readModelLabels().M417, 'Gemini 4 Argon (High)', '标签存下来给扫描用');
      assert.equal(fs.readFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'antigravity-models.json'), 'utf8').includes('csrf'), false, '令牌不存盘');
    } finally { server.close(); }
    pass('antigravity quota: the local language server is found through its hub file, asked with the CSRF header, labels remembered, token never stored');

    console.log(`${checks}/${checks} antigravity checks passed`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error('FAIL', error); process.exit(1); });
