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
    num(11, modelId), msg(20, str(1, 'traj'), ...(gen > 0 ? [num(3, gen)] : []), str(4, 'conv')),
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
    assert.deepEqual(first.estimate, { ms: 4000, tokensPerSec: 150 }, '未带 gen_metadata 流式计时时：用时 = 完成 − 开始');
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

    // gen_metadata 里的首字延迟（11）、流式耗时（12）与显示名标签（21）
    const conv4 = 'eeeeeeee-0000-4000-8000-000000000005';
    const richGen = Buffer.concat([msg(1,
      time(11, 1500),
      time(12, 2500),
      str(19, 'gemini-4-argon-b'),
      msg(20, str(1, 'model_enum'), str(2, 'MODEL_PLACEHOLDER_UNKNOWN')),
      msg(20, str(1, 'request_id'), str(2, 'req-rich-1')),
      str(21, 'Gemini 4 Argon (High)'),
    )]);
    const bufferedGen = Buffer.concat([msg(1,
      time(11, 129000),
      time(12, 48),
      str(19, 'gemini-4-argon-b'),
      msg(20, str(1, 'model_enum'), str(2, 'MODEL_PLACEHOLDER_UNKNOWN')),
      msg(20, str(1, 'request_id'), str(2, 'req-buffered-1')),
      str(21, 'Gemini 4 Argon (High)'),
    )]);
    const shortBufferedGen = Buffer.concat([msg(1,
      time(11, 32000),
      time(12, 45),
      str(19, 'gemini-4-argon-b'),
      msg(20, str(1, 'model_enum'), str(2, 'MODEL_PLACEHOLDER_UNKNOWN')),
      msg(20, str(1, 'request_id'), str(2, 'req-buffered-short')),
      str(21, 'Gemini 4 Argon (High)'),
    )]);
    makeConversation(conv4, [
      { idx: 0, type: 15, status: 3, meta: stepMeta({ start: now - 10000, end: now - 6000, modelId: 1999, gen: 0, input: 800, output: 200 }) },
      { idx: 1, type: 15, status: 3, meta: stepMeta({ start: now - 150000, end: now - 20952, modelId: 1999, gen: 1, input: 120000, output: 16155, thinking: 35 }) },
      { idx: 2, type: 15, status: 3, meta: stepMeta({ start: now - 40000, end: now - 7955, modelId: 1999, gen: 2, input: 5000, output: 130, thinking: 20 }) },
    ], [[0, richGen], [1, bufferedGen], [2, shortBufferedGen]]);
    r = scan.scanLocalUsage();
    assert.equal(r.records.length, 3);
    assert.deepEqual([r.records[0].model, r.records[0].effort, r.records[0].returned, r.records[0].requestId], ['gemini-4-argon', 'high', 'gemini-4-argon-b', 'req-rich-1']);
    assert.deepEqual(r.records[0].timing, { stream: true, ms: 4000, firstTokenMs: 1500, tokensPerSec: 80, provider: 'Antigravity' }, '流式回复按纯出字阶段（200 Token ÷ 2.5s = 80）计速，不把 1.5s 首包等待算进分母');
    assert.deepEqual(r.records[1].timing, { stream: false, ms: 129048, tokensPerSec: 125.2, provider: 'Antigravity' }, '服务端整包缓冲的大工具调用不把 129 秒总生成时间误记成首字延迟');
    assert.deepEqual(r.records[2].timing, { stream: false, ms: 32045, provider: 'Antigravity' }, '整包缓冲的短工具调用既不误记 32s 首字延迟，也不把排队等待算成 4 Token/秒');
    assert.equal(r.records[2].estimate, undefined, '跳过计速的短工具调用不回退写入 estimate');
    pass('antigravity usage: gen_metadata streaming timing (TTFT + duration), buffered tool-call TTFT guard, and fallback model_display_name are extracted');

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
    const summary = {
      groups: [
        { title: 'Gemini Models', buckets: [{ id: 'gemini_5h', window: '5h', remainingFraction: 0.75, resetTime: '2026-11-06T09:00:00Z' }, { id: 'gemini_weekly', window: 'weekly', remainingFraction: 0.8, resetTime: '2026-11-12T09:00:00Z' }] },
        { title: 'Claude and GPT models', buckets: [{ id: '3p_5h', window: '5h', remainingFraction: 0, resetTime: '2026-11-06T10:00:00Z' }, { id: '3p_weekly', window: 'weekly', remainingFraction: 0.65, resetTime: '2026-11-12T10:00:00Z' }] },
      ],
    };
    const parsedWithSummary = a.parseAntigravityStatus(status, summary);
    assert.deepEqual(parsedWithSummary.groups.map(g => [g.title, g.used, g.week?.used, g.week?.resetAt]), [
      ['Gemini Models', 25, 20, '2026-11-12T09:00:00Z'],
      ['Claude and GPT models', 100, 35, '2026-11-12T10:00:00Z'],
    ]);
    // 窗口刚重置时（Gemini 0.1% 与 Claude/GPT 0% 相差 <= 0.2%，且未用池的 resetTime 在两次 RPC 间差 1 秒）仍严格保持两个独立池
    const resetStatus = { userStatus: { planStatus: { planInfo: { planName: 'Pro' } }, cascadeModelConfigData: { clientModelConfigs: [
      { label: 'Gemini 4 Argon (High)', modelOrAlias: { model: 'M417' }, quotaInfo: { remainingFraction: 0.9991438, resetTime: '2026-11-06T19:17:55Z' } },
      { label: 'Gemini 3.8 Flash (High)', modelOrAlias: { model: 'M318' }, quotaInfo: { remainingFraction: 0.9991438, resetTime: '2026-11-06T19:17:55Z' } },
      { label: 'Claude Opus 5.5 (Thinking)', modelOrAlias: { model: 'M400' }, quotaInfo: { remainingFraction: 1, resetTime: '2026-11-06T19:20:22Z' } },
      { label: 'GPT-OSS 120B (Medium)', modelOrAlias: { model: 'M500' }, quotaInfo: { remainingFraction: 1, resetTime: '2026-11-06T19:20:22Z' } },
    ] } } };
    const realSummary = {
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.96119565, resetTime: '2026-11-13T04:17:55Z' },
              { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.9991438, resetTime: '2026-11-06T19:17:55Z' },
            ],
          },
          {
            displayName: 'Claude and GPT models',
            description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
            buckets: [
              { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 1, resetTime: '2026-11-13T14:21:39Z' },
              { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1, resetTime: '2026-11-06T19:21:39Z' },
            ],
          },
        ],
      },
    };
    const parsedAfterReset = a.parseAntigravityStatus(resetStatus, realSummary);
    assert.deepEqual(parsedAfterReset.groups.map(g => [g.title, g.models, g.used, g.week?.used]), [
      ['Gemini Models', ['Gemini 4 Argon', 'Gemini 3.8 Flash'], 0.1, 3.9],
      ['Claude and GPT models', ['Claude Opus 5.5', 'GPT-OSS 120B'], 0, 0],
    ], '窗口重置后即使两边都接近 0% 也不会合并成一个池');
    pass('antigravity quota: models sharing a quota are grouped, weekly quota buckets from RetrieveUserQuotaSummary are merged, an exhausted group is 100% used, reset windows never merge across pools');

    // 本机接口：从 daemon/hub_*.json 找端口和令牌，带 CSRF 头问；Antigravity 没开（没有 hub、进程不在）返回 null
    assert.equal(await a.fetchAntigravityStatus(), null);
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = ''; req.on('data', c => body += c); req.on('end', () => {
        seen.push({ url: req.url, csrf: req.headers['x-codeium-csrf-token'], connect: req.headers['connect-protocol-version'], body });
        if (req.headers['x-codeium-csrf-token'] !== 'csrf-qa') { res.writeHead(403); res.end('{}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.url.endsWith('/RetrieveUserQuotaSummary') ? summary : status));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      fs.writeFileSync(path.join(agy, 'daemon', 'hub_1.json'), JSON.stringify({ pid: 999999, httpPort: 1, csrfToken: 'stale' }));
      assert.equal(await a.fetchAntigravityStatus(), null, '进程已经不在的 hub 文件不用');
      fs.writeFileSync(path.join(agy, 'daemon', 'hub_2.json'), JSON.stringify({ pid: process.pid, httpPort: server.address().port, httpsPort: 1, lsVersion: '2.29.0', csrfToken: 'csrf-qa' }));
      const live = await a.fetchAntigravityStatus();
      assert.deepEqual(live.groups.map(g => [g.used, g.week?.used]), [[25, 20], [100, 35]]);
      assert.deepEqual(seen.map(s => s.url).sort(), [
        '/exa.language_server_pb.LanguageServerService/GetUserStatus',
        '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
      ]);
      assert.deepEqual([seen[0].csrf, seen[0].connect], ['csrf-qa', '1']);
      assert.equal(a.readModelLabels().M417, 'Gemini 4 Argon (High)', '标签存下来给扫描用');
      assert.equal(fs.readFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'antigravity-models.json'), 'utf8').includes('csrf'), false, '令牌不存盘');
    } finally { server.close(); }
    pass('antigravity quota: the local language server is found through its hub file, asked with the CSRF header, labels remembered, token never stored');

    // 提前重置（moved / kept）与半途采样折算校验：防止把整窗前段用量除以半途增量导致估算翻数倍（如 80 亿假象）
    const aqMod = require('../build/main/antigravity-quota.js');
    const DAY = 86400000, HOUR = 3600000;
    const baseT = Date.parse('2026-11-06T04:00:00Z');
    const weekReset1 = new Date(baseT + 7 * DAY).toISOString();
    const weekReset2 = new Date(baseT + 22 * HOUR + 7 * DAY).toISOString();
    const gKey = 'Gemini 3.8 Flash|Gemini 4 Argon';
    const mockHistory = [
      { at: baseT + 8 * HOUR, groups: [{ key: gKey, used: 3.4, resetAt: new Date(baseT + 10 * HOUR).toISOString(), weekUsed: 3.4, weekResetAt: weekReset1 }] },
      { at: baseT + 13 * HOUR, groups: [{ key: gKey, used: 4.7, resetAt: new Date(baseT + 15 * HOUR).toISOString(), weekUsed: 4.7, weekResetAt: weekReset1 }] },
      // 距离原定周重置还有 6 天时，Google 提前重置周额度为 0% 并顺延重置日期
      { at: baseT + 22 * HOUR, groups: [{ key: gKey, used: 0, resetAt: new Date(baseT + 27 * HOUR).toISOString(), weekUsed: 0, weekResetAt: weekReset2 }] },
      { at: baseT + 23 * HOUR, groups: [{ key: gKey, used: 1.2, resetAt: new Date(baseT + 27 * HOUR).toISOString(), weekUsed: 0.4, weekResetAt: weekReset2 }] },
    ];
    const segs = aqMod.agyWindowSegments('week', gKey, mockHistory, { used: 0.4, resetAt: weekReset2 }, baseT + 23 * HOUR);
    assert.equal(segs.length, 2, '提前重置将周窗口切分为前后两个独立周期段');
    assert.equal(segs[0].endedByReset, 'moved', '第一段标记为被顺延式提前重置结束');
    assert.equal(segs[0].endAt, baseT + 22 * HOUR, '第一段结束时间截断在重置发生点而非 7 天后');
    assert.equal(segs[1].startedByReset, 'moved', '第二段标记为从顺延式提前重置开始');
    assert.equal(segs[1].startAt, baseT + 22 * HOUR, '第二段起点不早于重置点，不会吞入重置前 Token');
    pass('antigravity quota: agyWindowSegments splits early resets (moved/kept) and clamps segment boundaries');

    // Antigravity CLI（~/.gemini/antigravity-cli）：CLI 会话同样被扫描入账，并识别 snake_case 的 RetrieveUserQuotaSummary
    const agyCli = a.antigravityCliDir();
    fs.mkdirSync(path.join(agyCli, 'conversations'), { recursive: true });
    const convCli = 'ffffffff-0000-4000-8000-000000000006';
    const cliFile = path.join(agyCli, 'conversations', convCli + '.db');
    const cliDb = new DatabaseSync(cliFile);
    cliDb.exec('create table steps (idx integer primary key, step_type integer, status integer, has_subtrajectory numeric, metadata blob, step_payload blob); create table gen_metadata (idx integer primary key, data blob, size integer);');
    cliDb.prepare('insert into steps (idx, step_type, status, metadata) values (?, ?, ?, ?)').run(0, 15, 3, stepMeta({ start: now - 5000, end: now - 3000, modelId: 1319, gen: 0, input: 1200, output: 300 }));
    const cliGen = genMeta('gemini-3.8-flash', 'MODEL_PLACEHOLDER_M319');
    cliDb.prepare('insert into gen_metadata (idx, data, size) values (?, ?, ?)').run(0, cliGen, cliGen.length);
    cliDb.close();
    const cliSum = new DatabaseSync(path.join(agyCli, 'conversation_summaries.db'));
    cliSum.exec('create table conversation_summaries (conversation_id text, title text, workspace_uris text, status text)');
    cliSum.prepare('insert into conversation_summaries values (?, ?, ?, ?)').run(convCli, '', JSON.stringify([require('node:url').pathToFileURL(path.join(root, 'cli-proj')).href]), 'CASCADE_RUN_STATUS_IDLE');
    cliSum.close();
    const rCli = scan.scanLocalUsage();
    assert.deepEqual(rCli.records.map(x => [x.id, x.model, x.cwd, x.input, x.output]), [[convCli + ':0', 'gemini-3.8-flash', path.join(root, 'cli-proj'), 1200, 300]]);
    const snakeSummary = {
      groups: [
        { name: 'Gemini Models', buckets: [{ id: 'gemini_weekly', window: 'weekly', remaining_fraction: 0.7, reset_time: '2026-11-12T09:00:00Z' }] },
      ],
    };
    const parsedSnake = a.parseAntigravityStatus(status, snakeSummary);
    assert.deepEqual([parsedSnake.groups[0].title, parsedSnake.groups[0].week?.used], ['Gemini Models', 30]);
    pass('antigravity CLI usage: scans antigravity-cli conversations with workspace cwd and parses snake_case quota summary');

    // Orchestrator 模式（Orchestrator (Carbon) / (Argon) + gemini-pro-orchestrator + gemini-flash-worker-agy）
    assert.deepEqual(a.splitModelLabel('Orchestrator (Carbon)'), { model: 'orchestrator-carbon', family: 'Orchestrator (Carbon)' });
    assert.deepEqual(a.splitModelLabel('Orchestrator (Argon)'), { model: 'orchestrator-argon', family: 'Orchestrator (Argon)' });
    assert.equal(a.modelFamily('Orchestrator (Carbon)'), 'Orchestrator');
    const orchStatus = {
      userStatus: {
        planStatus: { planInfo: { planName: 'Pro' } },
        cascadeModelConfigData: {
          clientModelConfigs: [
            { label: 'Gemini 4 Argon (High)', modelOrAlias: { model: 'M417' }, quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-06T09:00:00Z' } },
            { label: 'Orchestrator (Carbon)', modelOrAlias: { model: 'M667' }, quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-06T09:00:00Z' } },
            { label: 'Orchestrator (Argon)', modelOrAlias: { model: 'M681' }, quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-06T09:00:00Z' } },
          ],
        },
      },
    };
    const parsedOrch = a.parseAntigravityStatus(orchStatus, summary);
    assert.deepEqual(parsedOrch.groups[0].models, ['Gemini 4 Argon', 'Orchestrator'], '分组 models 保留 Orchestrator，不破坏历史 group.key');
    const orchItems = parsedOrch.models.filter(m => m.model.startsWith('orchestrator-'));
    assert.deepEqual(orchItems.map(m => [m.family, m.model, m.effort]), [
      ['Orchestrator (Carbon)', 'orchestrator-carbon', undefined],
      ['Orchestrator (Argon)', 'orchestrator-argon', undefined],
    ]);
    const convOrch = 'eeeeeeee-1111-4000-8000-000000000007';
    makeConversation(convOrch, [
      { idx: 0, type: 15, status: 3, meta: stepMeta({ start: now - 4000, end: now - 2000, modelId: 1667, gen: 0, input: 1000, output: 200 }) },
      { idx: 1, type: 15, status: 3, meta: stepMeta({ start: now - 2000, end: now - 1000, modelId: 1669, gen: 1, input: 500, output: 100 }) },
    ], [
      [0, Buffer.concat([msg(1, str(19, 'gemini-pro-orchestrator'), msg(20, str(1, 'model_enum'), str(2, 'MODEL_PLACEHOLDER_M667')), str(21, 'Orchestrator (Carbon)'))])],
      [1, Buffer.concat([msg(1, str(19, 'gemini-flash-worker-agy'), msg(20, str(1, 'model_enum'), str(2, 'MODEL_PLACEHOLDER_M669')), str(21, 'Gemini Flash'))])],
    ]);
    const rOrch = scan.scanLocalUsage();
    assert.deepEqual(rOrch.records.map(x => [x.model, x.requested, x.returned, x.effort]), [
      ['orchestrator-carbon', 'orchestrator-carbon', 'gemini-pro-orchestrator', undefined],
      ['gemini-flash', 'gemini-flash', 'gemini-flash-worker-agy', undefined],
    ]);
    const pricing = require('../build/core/model-pricing');
    assert.ok(pricing.priceOf('orchestrator-carbon')?.input > 0 && pricing.priceOf('orchestrator')?.input > 0, 'orchestrator 有单价兜底');
    pass('antigravity orchestrator: Carbon/Argon split without fake effort, group.key preserved as Orchestrator, planner/worker scanned cleanly and priced');

    // Antigravity 额度详情（avgSpeed / speed / recentRequests）也不回退读取历史遗留或跳过计速的 estimate
    const reqDir = path.join(process.env.TOKENPULSE_DATA_DIR, 'requests');
    const nowFile = path.join(reqDir, fs.readdirSync(reqDir).sort().at(-1));
    fs.appendFileSync(nowFile, [
      { id: conv4 + ':2', at: now - 7955, kind: 'antigravity', file: nowFile, model: 'gemini-4-argon', effort: 'high', timing: { stream: false, ms: 32045, provider: 'Antigravity' }, estimate: { ms: 32045, tokensPerSec: 4.1 }, input: 5000, output: 130, cacheRead: 0, cacheWrite: 0, reasoning: 20, costUsd: 0, calls: 1 },
      { id: 'legacy:est', at: now - 5000, kind: 'antigravity', file: nowFile, model: 'gemini-4-argon', effort: 'high', estimate: { ms: 5000, tokensPerSec: 12 }, input: 500, output: 60, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, calls: 1 },
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    const agyQuota = new aqMod.AntigravityQuota({ now: () => now });
    try {
      const agySpeed = agyQuota.speed(7);
      assert.equal(agySpeed.models.some(m => m.estimated), false, 'Antigravity 额度速度走势不再出现 ≈ 估算线');
      const argonSpeedModel = agySpeed.models.find(m => m.model === 'gemini-4-argon');
      assert.deepEqual([argonSpeedModel.tokensPerSec, argonSpeedModel.count], [102.6, 2], '仅平均两条带 timing.tokensPerSec 的记录（80 与 125.2），不混入 4.1 / 12 估算值');
      const agyInsight = agyQuota.state().insight;
      const argonSummary = agyInsight.localUsage.models.find(m => m.model === 'gemini-4-argon');
      assert.equal(argonSummary.avgSpeed, 102.6, 'Antigravity 模型均速不被短工具调用的 estimate 拉低');
      assert.equal(agyInsight.localUsage.recentRequests.length > 0, true);
      assert.equal(agyInsight.localUsage.recentRequests.every(req => req.estimate === undefined), true, 'Antigravity 最近请求不附带 estimate');
    } finally {
      agyQuota.stop();
    }
    pass('antigravity quota speed: avgSpeed and speed() ignore estimate fallbacks on skipped or legacy records');

    console.log(`${checks}/${checks} antigravity checks passed`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error('FAIL', error); process.exit(1); });
