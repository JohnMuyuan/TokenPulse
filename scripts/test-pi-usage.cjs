/*
 * pi 的用量（src/core/usage-scan.ts 的 piRow）。会话文件是 ~/.pi/agent/sessions/<项目>/<时间>_<会话>.jsonl，字段照本机真实文件。
 * 覆盖：口径和 pi 自己的 getSessionStats 一致（回复、工具里的嵌套调用、usage 条目、压缩、分支摘要），输入把缓存加回去，
 * 自己算的费用 / 路由模型按单价估，型号、思考等级、工作目录、会话 ID，追加只读新增、半行先不读，
 * 分叉复制来的记录不重复算（原文件删了也一样），不同会话的条目 id 撞车不丢账。
 * 用一次性的 HOME 和数据目录，不碰真实的 ~/.pi 和 ~/.tokenpulse。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-pi-usage-'));
process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'PI_CODING_AGENT_DIR', 'AGENT_SWITCH_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
const build = path.join(__dirname, '..', 'build', 'core');
const { scanLocalUsage, readRollups } = require(path.join(build, 'usage-scan.js'));
const { queryRequests } = require(path.join(build, 'request-log.js'));
const { displayModel } = require(path.join(build, 'knowledge.js'));

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const base = Date.now() - 3600_000;
const iso = seconds => new Date(base + seconds * 1000).toISOString();
const usage = (input, output, cacheRead = 0, cacheWrite = 0, total = 0, extra = {}) => ({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total }, ...extra });
const reply = (id, seconds, model, value, extra = {}) => ({ type: 'message', id, parentId: null, timestamp: iso(seconds), message: { role: 'assistant', content: [{ type: 'text', text: 'secret-reply-text' }], provider: 'anthropic', model, usage: value, stopReason: 'stop', ...extra } });
const header = (id, seconds, extra = {}) => ({ type: 'session', version: 3, id, timestamp: iso(seconds), cwd: 'D:\\qa\\project', ...extra });
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const dir = path.join(process.env.HOME, '.pi', 'agent', 'sessions', '--D--qa-project--');
const fileOf = (seconds, id) => path.join(dir, `${iso(seconds).replace(/[:.]/g, '-')}_${id}.jsonl`);
const query = (source = 'pi') => queryRequests({ from: '2000-01-01', to: '2999-01-01', source, status: 'all', search: '', sort: 'time', page: 0, pageSize: 100, all: true }).rows.sort((a, b) => a.at - b.at);
const piTotals = () => {
  const out = { tokens: 0, requests: 0 };
  for (const state of Object.values(readRollups().files)) for (const bySource of Object.values(state.days)) for (const row of Object.values(bySource.pi ?? {})) {
    out.tokens += row.input + row.output; out.requests += row.requests;
  }
  return out;
};

try {
  fs.mkdirSync(dir, { recursive: true });
  const fable = 'claude-fable-5-1';
  const main = fileOf(0, 'sess-main');
  fs.writeFileSync(main, lines([
    header('sess-main', 0),
    { type: 'model_change', id: 'mc', parentId: null, timestamp: iso(1), provider: 'anthropic', modelId: fable },
    { type: 'message', id: 'u1', parentId: 'mc', timestamp: iso(2), message: { role: 'user', content: [{ type: 'text', text: 'secret-user-text' }] } },
    // 普通回复：输入不含缓存，要加回去；费用用 pi 自己算的；思考等级和用时
    reply('a1', 10, fable, usage(10, 200, 1000, 500, 1.5, { reasoning: 40 }), { thinkingLevel: 'medium', responseId: 'msg_0123456789abcdefghijkl', durationMs: 4000 }),
    // 自定义供应商的模型没配单价：pi 记 0，按单价表估
    reply('a2', 20, 'deepseek-flash', usage(100, 50, 2000), { provider: 'tokenpulse_route', responseId: 'route-resp-1' }),
    // 工具里又调了模型：用量记在工具结果上，型号沿用当前的
    { type: 'message', id: 't1', parentId: 'a2', timestamp: iso(30), message: { role: 'toolResult', toolCallId: 'c1', content: [], usage: usage(7, 3, 0, 0, 0.01) } },
    // 扩展记的、不进上下文的调用
    { type: 'usage', id: 'x1', parentId: 't1', timestamp: iso(40), kind: 'extension', provider: 'anthropic', model: 'claude-haiku-4-5', usage: usage(11, 9, 0, 0, 0.02) },
    // 压缩和分支摘要：有真实用量
    { type: 'compaction', id: 'k1', parentId: 'x1', timestamp: iso(50), summary: 'secret-summary', firstKeptEntryId: 'a2', tokensBefore: 9000, usage: usage(800, 100, 0, 0, 0.03) },
    { type: 'branch_summary', id: 'b1', parentId: 'k1', timestamp: iso(60), fromId: 'a1', summary: 'secret-summary', usage: usage(70, 30, 0, 0, 0.04) },
    // 没有 usage 的摘要、出错没有用量的回复：不算
    { type: 'compaction', id: 'k2', parentId: 'b1', timestamp: iso(70), summary: 'x', firstKeptEntryId: 'a2', tokensBefore: 1 },
    reply('a3', 80, fable, usage(0, 0), { stopReason: 'error', errorMessage: 'boom' }),
    // 被放弃的分支还留在文件里，这次请求确实发过
    { ...reply('a4', 90, fable, usage(5, 5, 0, 0, 0.05)), parentId: 'u1' },
  ]));
  let scan = scanLocalUsage();
  assert.equal(scan.records.length, 7);
  let rows = query();
  assert.deepEqual(rows.map(row => [row.source, row.input, row.output, row.cacheRead, row.cacheWrite]), [
    ['pi', 1510, 200, 1000, 500], ['pi', 2100, 50, 2000, 0], ['pi', 7, 3, 0, 0], ['pi', 11, 9, 0, 0], ['pi', 800, 100, 0, 0], ['pi', 70, 30, 0, 0], ['pi', 5, 5, 0, 0],
  ], '输入含缓存，回复、工具结果、usage、压缩、分支摘要都算，出错的和没 usage 的不算');
  const flash = displayModel('deepseek-flash');
  assert.deepEqual(rows.map(row => row.model), [fable, flash, flash, 'claude-haiku-4-5', flash, flash, fable], '自己带型号的用自己的，工具结果和摘要沿用当前型号');
  assert.ok(rows.every(row => row.session === 'sess-main' && row.cwd === 'D:\\qa\\project'), '会话 ID 和工作目录来自文件');
  assert.equal(rows[0].effort, 'medium');
  assert.equal(rows[1].effort ?? null, null, '没带思考等级的不沿用上一条');
  assert.equal(rows[0].costUsd, 1.5, 'pi 自己算的费用优先');
  assert.ok(rows[1].costUsd > 0, '费用记 0 的 DeepSeek 型号按单价表估');
  assert.equal(rows[0].responseId, 'msg_0123456789abcdefghijkl');
  assert.equal(rows[0].estimate?.tokensPerSec, 50, '用它记的 durationMs 算速度');
  assert.deepEqual([rows[0].requested, rows[0].returned ?? null, rows[0].status], [fable, null, 'unverified'], '文件里没有上游返回的型号，不判定一致');
  assert.ok(rows.every(row => row.account === null || row.account === undefined), 'pi 不归到任何官方账号');
  const piStates = Object.entries(readRollups().files).filter(([name]) => name.includes('.pi'));
  assert.ok(piStates.every(([, state]) => !Object.keys(state.accountHours ?? {}).length), '不进官方额度的账');
  const saved = fs.readdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true }).filter(name => /\.jsonl?$|\.json$/.test(String(name))).map(name => fs.readFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, String(name)), 'utf8')).join('');
  assert.equal(/secret-(reply|user|summary)/.test(saved), false, '不保存对话内容');
  pass('usage matches pi session stats: replies, nested tool calls, usage entries, compaction and branch summaries; cache added to input; cost, model, effort, speed, cwd and session id; nothing of the conversation stored');

  // 追加：只读新增的；最后一行没写完先不读；写完了不丢不重
  const next = lines([reply('a5', 100, fable, usage(1, 2, 0, 0, 0.06))]);
  const half = JSON.stringify(reply('a6', 110, fable, usage(3, 4, 0, 0, 0.07)));
  fs.appendFileSync(main, next + half.slice(0, 40));
  assert.deepEqual(scanLocalUsage().records.map(record => record.id), [`${path.basename(main, '.jsonl')}:a5`], '只读新增的完整行');
  fs.appendFileSync(main, half.slice(40) + '\n');
  assert.deepEqual(scanLocalUsage().records.map(record => record.id), [`${path.basename(main, '.jsonl')}:a6`], '写完了再读');
  assert.equal(scanLocalUsage().records.length, 0, '没变不重读');
  pass('appended lines are read incrementally; a half-written line waits; no double counting');

  // 分叉：旧记录原样复制进新文件（时间戳不变），只有新发生的算；原文件删掉账也不变
  const before = piTotals();
  const forked = fileOf(120, 'sess-fork');
  fs.writeFileSync(forked, lines([
    header('sess-fork', 120, { parentSession: main }),
    reply('a1', 10, fable, usage(10, 200, 1000, 500, 1.5), { responseId: 'msg_0123456789abcdefghijkl' }),
    { type: 'compaction', id: 'k1', parentId: 'a1', timestamp: iso(50), summary: 'x', firstKeptEntryId: 'a1', tokensBefore: 9000, usage: usage(800, 100, 0, 0, 0.03) },
    reply('n1', 130, fable, usage(20, 10, 0, 0, 0.08)),
  ]));
  assert.deepEqual(scanLocalUsage().records.map(record => record.id), [`${path.basename(forked, '.jsonl')}:n1`], '复制来的不算，分叉之后的算');
  fs.rmSync(main);
  scanLocalUsage();
  assert.deepEqual(piTotals(), { tokens: before.tokens + 30, requests: before.requests + 1 }, '原文件删了，分叉里复制的记录也不会补算，已记的账还在');
  assert.equal(readRollups().files[forked].piForkAt, Date.parse(iso(120)));
  pass('a fork counts only what happened after it, even when the original session file is deleted');

  // 条目 id 只在一个会话里唯一：另一个会话用同样的 id，两条都要留下
  const other = fileOf(200, 'sess-other');
  fs.writeFileSync(other, lines([header('sess-other', 200), reply('n1', 210, fable, usage(30, 20, 0, 0, 0.09))]));
  scanLocalUsage();
  assert.equal(query().filter(row => row.input === 30 && row.output === 20).length, 1);
  assert.equal(query().filter(row => row.input === 20 && row.output === 10).length, 1, '不同会话同一个条目 id 不互相覆盖');
  pass('entry ids from different sessions never collide');

  // 文件变小（被 pi 重写）：这个文件自己的账清掉重读，别的不动
  const sizes = piTotals();
  fs.writeFileSync(other, lines([header('sess-other', 200)]));
  scanLocalUsage();
  assert.deepEqual(piTotals(), { tokens: sizes.tokens - 50, requests: sizes.requests - 1 });
  pass('a rewritten file is recounted on its own');

  // 只看 pi 的筛选不混别家；别家的筛选里也没有 pi
  assert.equal(query('Claude Code').length, 0);
  assert.ok(query('all').some(row => row.source === 'pi'));
  pass('pi shows up as its own source in the request filter');

  console.log(`${checks}/${checks} pi usage checks passed`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
