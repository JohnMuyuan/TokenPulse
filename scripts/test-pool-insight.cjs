/*
 * 额度详情的号池页（0.3.44）：src/core/pool-insight.ts。
 * 用合成的转发记录和额度采样核对每一块数字（都能手算）：哪些行算这个号池（poolId、旧记录按前缀认、透明转发和别的号池不算）、
 * Token 口径（Anthropic 的 input 不含缓存读取）、用了多久、成员分摊、限流、总额度折算、时间线和曲线、速度；以及 poolDef 不带凭据。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-pool-insight-'));
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.AGENT_SWITCH_HOME = path.join(root, 'home');
process.env.AGENT_SWITCH_CC_DB = path.join(root, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.AGENT_SWITCH_HOME, { recursive: true });

const insight = require('../build/core/pool-insight');
const { estimateCost } = require('../build/core/model-pricing');

const MIN = 60_000, H = 3_600_000, D = 86_400_000;
const now = Date.now();
const startOfToday = (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); })();
const iso = ms => new Date(ms).toISOString();
const data = process.env.TOKENPULSE_DATA_DIR;
let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };

// 转发记录：按本地月份写进 route-log/YYYY-MM.jsonl（和 appendRouteLog 一样）
const logDir = path.join(data, 'route-log');
fs.mkdirSync(logDir, { recursive: true });
const write = row => {
  const d = new Date(row.at), name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`;
  fs.appendFileSync(path.join(logDir, name), JSON.stringify(row) + '\n');
};
const base = { app: 'claude', pool: true, account: '', client: 'claude' };
const t0 = now - 5 * MIN, t4 = now - 3 * D;
const rows = [
  // 1 官方账号 a：Anthropic 的 input 不含缓存读取，算的时候加回去 → 100 + 900 + 50 = 1050
  { ...base, at: t0, poolId: 'pool1', providerId: 'pool1@claude:a', provider: '主力号池 · a', status: 200, ms: 2000, input: 100, cacheRead: 900, output: 50, upstream: 'anthropic', requestModel: 'claude-sonnet-4-5', returnedModel: 'claude-sonnet-4-5', effort: 'high', attempt: 1, tokensPerSec: 40, firstTokenMs: 500 },
  // 2 账号 b 回 429：算尝试、算限流，不算 Token
  { ...base, at: t0 + MIN, poolId: 'pool1', providerId: 'pool1@claude:b', provider: '主力号池 · b', status: 429, ms: 300, input: 0, output: 0, upstream: 'anthropic', requestModel: 'claude-sonnet-4-5', attempt: 1, error: 'rate_limit' },
  // 3 换到 API Key 成员：OpenAI 的 prompt_tokens 已经含缓存，不再加 → 300 + 100 = 400
  { ...base, at: t0 + MIN + 1000, poolId: 'pool1', providerId: 'prov-k', provider: '主力号池 · Key K', status: 200, ms: 1000, input: 300, cacheRead: 100, output: 100, upstream: 'openai-chat', requestModel: 'claude-sonnet-4-5', returnedModel: 'gpt-5.1', effort: 'medium', attempt: 2, tokensPerSec: 60, firstTokenMs: 300 },
  // 4 旧记录（0.3.44 以前没有 poolId）：官方账号成员按「号池id@」认
  { ...base, at: t4, providerId: 'pool1@claude:b', provider: '主力号池 · b', status: 200, ms: 3000, input: 500, output: 500, upstream: 'anthropic', requestModel: 'claude-opus-4-1', attempt: 1 },
  // 5 旧记录：API Key 成员只能按名字前缀认
  { ...base, at: t4 + 10 * MIN, providerId: 'prov-k', provider: '主力号池 · Key K', status: 200, ms: 0, input: 200, output: 0, upstream: 'openai-chat', requestModel: 'gpt-5.1', attempt: 1 },
  // 不算：别的号池、透明转发、别的号池的旧记录、太早的、别的工具同名前缀
  { ...base, at: t0, poolId: 'pool2', providerId: 'pool2@claude:a', provider: '备用 · a', status: 200, input: 999, output: 999, upstream: 'anthropic', requestModel: 'x' },
  { ...base, at: t0, poolId: 'pool1', pass: true, providerId: 'pool1@claude:a', status: 200, input: 999, output: 999, upstream: 'anthropic', requestModel: 'x' },
  { ...base, at: t4, providerId: 'prov-k', provider: '另一个号池 · Key K', status: 200, input: 999, output: 999, upstream: 'openai-chat', requestModel: 'x' },
  { ...base, at: now - 40 * D, poolId: 'pool1', providerId: 'pool1@claude:a', status: 200, input: 999, output: 999, upstream: 'anthropic', requestModel: 'x' },
  { ...base, app: 'codex', at: t4, providerId: 'pool1@chatgpt:z', provider: '主力号池 · z', status: 200, input: 999, output: 999, upstream: 'openai-responses', requestModel: 'x' },
];
for (const row of rows) write(row);

// 额度采样（百分比是已用）：a 一周里从 10% 涨到 30%；b 8 天前那个周期 50%，重置后从 5% 涨到 25%
const R0 = iso(now - 7 * D), R1 = iso(now + D), R2 = iso(now + 3 * D);
fs.writeFileSync(path.join(data, 'quota-history.json'), JSON.stringify({ version: 1, accounts: { claude: [
  { at: now - 8 * D, week: 50, weekReset: R0, account: 'claude:b' },
  { at: now - 6 * D, week: 10, weekReset: R1, account: 'claude:a' },
  { at: now - 2 * D, week: 5, weekReset: R2, account: 'claude:b' },
  { at: now - D, week: 30, weekReset: R1, account: 'claude:a' },
  { at: now - H, week: 25, weekReset: R2, account: 'claude:b' },
  { at: now - H, week: 99, weekReset: R2, account: 'claude:other' },
] } }));
fs.writeFileSync(path.join(data, 'quota-checked.json'), JSON.stringify({ accounts: { 'claude:a': now - 30_000, 'claude:b': now - 30_000 } }));

const pool = { id: 'pool1', name: '主力号池', app: 'claude', strategy: 'most-left', members: [
  { key: 'pool1@claude:a', type: 'account', id: 'claude:a', name: 'a' },
  { key: 'pool1@claude:b', type: 'account', id: 'claude:b', name: 'b' },
  { key: 'prov-k', type: 'provider', id: 'prov-k', name: 'Key K' },
] };

{
  const got = insight.poolRows(pool, now - 30 * D, now);
  assert.deepEqual(got.map(row => row.at), [t4, t4 + 10 * MIN, t0, t0 + MIN, t0 + MIN + 1000], '只有这个号池的 5 行，按时间排');
  assert.deepEqual(got.map(row => row.tokens), [1000, 200, 1050, 0, 400]);
  assert.equal(got[2].input, 1000, 'Anthropic 的 input 加回缓存读取');
  assert.equal(got[4].input, 300, 'OpenAI 的 prompt_tokens 已经含缓存');
  assert.equal(got[4].model, 'gpt-5.1', '型号按实际回复的');
  assert.equal(got[1].memberName, 'Key K');
  pass('pool insight: rows are picked by poolId, legacy rows by id or name prefix; pass-through, other pools and other tools are left out; input tokens are normalized');
}

const summary = insight.queryPool({ op: 'summary', pool });
{
  const t = summary.totals;
  assert.equal(t.requests, 4); assert.equal(t.attempts, 5); assert.equal(t.failed, 1); assert.equal(t.limited, 1);
  assert.equal(t.tokens, 2650);
  const cost = estimateCost('claude-sonnet-4-5', { input: 1000, output: 50, cacheRead: 900, cacheWrite: 0 }) + estimateCost('gpt-5.1', { input: 300, output: 100, cacheRead: 100, cacheWrite: 0 })
    + estimateCost('claude-opus-4-1', { input: 500, output: 500, cacheRead: 0, cacheWrite: 0 }) + estimateCost('gpt-5.1', { input: 200, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.ok(Math.abs(t.costUsd - cost) < 1e-9, '参考费用按 estimateCost 加起来');
  // 用了多久：1 和 3 隔了一分钟连成一段（t0-2s → t0+61s = 63 秒）；4、5 隔了 10 分钟分开（3 秒 + 0）；429 那次不算
  assert.equal(t.activeMs, 63_000 + 3_000);
  const todayTokens = [[t0, 1050], [t0 + MIN + 1000, 400]].filter(([at]) => at > startOfToday).reduce((sum, [, v]) => sum + v, 0);
  assert.equal(t.today.tokens, todayTokens);
  assert.equal(t.d7.tokens, 2650);
  pass('pool insight: totals count successful requests, attempts, failures, 429s, tokens, reference cost and active time (gaps under 5 minutes join)');
}

{
  const by = Object.fromEntries(summary.members.map(member => [member.key, member]));
  assert.deepEqual(summary.members.map(member => member.key), ['pool1@claude:a', 'pool1@claude:b', 'prov-k'], '设置里的成员顺序');
  assert.equal(by['pool1@claude:a'].tokens, 1050); assert.equal(by['pool1@claude:b'].tokens, 1000); assert.equal(by['prov-k'].tokens, 600);
  assert.equal(by['pool1@claude:b'].attempts, 2); assert.equal(by['pool1@claude:b'].limited, 1); assert.equal(by['prov-k'].requests, 2);
  assert.ok(Math.abs(by['pool1@claude:a'].share - 1050 / 2650) < 1e-12);
  assert.equal(by['pool1@claude:a'].quota.weekLeft, 70); assert.equal(by['pool1@claude:b'].quota.weekLeft, 75); assert.equal(by['prov-k'].quota, null);
  assert.equal(by['pool1@claude:a'].weekUsed7, 20, '同一个周期里涨的');
  assert.equal(by['pool1@claude:b'].weekUsed7, 20, '重置之后从头算，跨周期的下降不算');
  const removed = insight.analyzePool({ ...pool, members: pool.members.slice(0, 2) }, insight.poolRows(pool, now - 30 * D, now), now).members.find(member => member.key === 'prov-k');
  assert.equal(removed.removed, true, '已经移出号池的成员还在转发记录里：排在后面，标出来');
  pass('pool insight: members split tokens, requests, 429s and share; account members carry their quota and weekly growth; removed members still show');
}

{
  const q = summary.quota;
  assert.equal(q.accounts, 2); assert.equal(q.measured, 2);
  assert.ok(Math.abs(q.left - 1.45) < 1e-12, '70% + 75% = 相当于 1.45 个号的周额度');
  assert.ok(Math.abs(q.used7 - 0.4) < 1e-12, '7 天用掉 20 + 20 个百分点');
  assert.ok(Math.abs(q.perDay - 0.4 / 7) < 1e-12);
  assert.ok(Math.abs(q.daysLeft - 1.45 / (0.4 / 7)) < 1e-9);
  assert.deepEqual(q.tracks.map(track => track.points.map(point => point.used)), [[10, 30], [5, 25]], '7 天以内的采样');
  assert.equal(summary.daily.length, 30); assert.equal(summary.hourly.length, 24);
  assert.equal(summary.daily.reduce((sum, day) => sum + day.tokens, 0), 2650);
  assert.equal(summary.daily.at(-1).byMember['pool1@claude:a'] || 0, t0 > startOfToday ? 1050 : 0);
  assert.equal(summary.hourly.reduce((sum, hour) => sum + hour.tokens, 0), 1450, '最近 24 小时只有 1 和 3');
  assert.deepEqual(summary.models.map(model => [model.model, model.effort, model.tokens]), [['claude-sonnet-4-5', 'high', 1050], ['claude-opus-4-1', '', 1000], ['gpt-5.1', 'medium', 400], ['gpt-5.1', '', 200]]);
  assert.equal(summary.recent.length, 5); assert.equal(summary.recent[0].attempt, 2, '最近的在前');
  pass('pool insight: pool quota adds the members\' weekly remainder, projects days left from 7-day growth; hourly, daily and model breakdowns add up');
}

{
  const tl = insight.queryPool({ op: 'timeline', pool });
  assert.equal(tl.kind, 'pool'); assert.equal(tl.labels.five, '单日');
  const week = tl.week;
  assert.equal(week.query.kind, 'pool'); assert.equal(week.brand, 'claude'); assert.equal(week.source, 'Claude Code');
  assert.equal(week.selected.active, true);
  assert.equal(week.selected.endAt - week.selected.startAt >= 7 * D - H && week.selected.endAt - week.selected.startAt <= 7 * D + H, true, '7 天（夏令时差一小时也算）');
  assert.equal(week.totals.tokens, 2650); assert.equal(week.totals.calls, 4);
  assert.deepEqual(week.track.map(point => point.pct), [50, 30, 7.5, 17.5, 27.5], '各成员最近一笔的平均；段前的最后一笔带上，别的账号不算');
  assert.equal(week.attribution.intervals.length, 0); assert.equal(week.offMachine.marks.length, 0);
  assert.equal(tl.five.totals.tokens, [[t0, 1050], [t0 + MIN + 1000, 400]].filter(([at]) => at > startOfToday).reduce((sum, [, v]) => sum + v, 0));
  const older = week.cycles[1];
  const back = insight.queryPool({ op: 'timeline', pool, cycles: { week: older?.id } }).week;
  if (older) assert.equal(back.selected.id, older.id, '可以往前翻');
  pass('pool insight: the timeline splits by day and 7 days, carries the members\' average weekly used curve and no off-machine marks');
}

{
  const speed = insight.queryPool({ op: 'speed', pool, days: 30 });
  assert.deepEqual(speed.models.map(model => [model.model, model.count, model.tokensPerSec]).sort(), [['claude-sonnet-4-5', 1, 40], ['gpt-5.1', 1, 60]], '量到速度的两次，按实际回复的型号');
  assert.equal(speed.total, 2);
  pass('pool insight: speed series come from the pool\'s measured requests');
}

{
  // poolDef：主进程从供应商数据取号池定义，只有名字和 id，不带凭据
  const sw = require('../build/core/agent-switch');
  const t = Date.now();
  const account = ref => ({ id: `claude:${ref}`, kind: 'claude', ref, email: `${ref}@example.com`, label: ref, createdAt: t, lastSeenAt: t, credential: { token: 'secret-' + ref, expiresAt: t + H } });
  fs.writeFileSync(path.join(data, 'official-accounts.json'), JSON.stringify({ version: 2, active: {}, accounts: [account('qa-a')] }));
  const key = sw.saveProvider({ app: 'claude', name: 'Key Q', baseUrl: 'https://relay.example/v1', apiKey: 'sk-test-should-not-leak', model: 'claude-sonnet-5', upstream: 'anthropic' });
  const id = sw.saveProvider({ app: 'claude', name: '测试号池', pool: { strategy: 'reset-first', members: [{ type: 'account', id: 'claude:qa-a' }, { type: 'provider', id: key }] } });
  const def = sw.poolDef(id);
  assert.deepEqual(def, { id, name: '测试号池', app: 'claude', strategy: 'reset-first', members: [
    { key: `${id}@claude:qa-a`, type: 'account', id: 'claude:qa-a', name: 'qa-a@example.com' },
    { key, type: 'provider', id: key, name: 'Key Q' },
  ] });
  assert.ok(!/secret|sk-test/.test(JSON.stringify(def)), '不带凭据');
  assert.equal(sw.poolDef(key), null, '不是号池');
  assert.equal(sw.poolDef('nope'), null);
  sw.releaseAgentSwitch();
  pass('pool insight: poolDef returns names and ids only');
}

{
  const midnightPool = { ...pool, id: 'midnight', name: 'Midnight' };
  write({ ...base, at: startOfToday, poolId: 'midnight', providerId: 'prov-k', status: 200, input: 123, output: 7, upstream: 'openai-chat', requestModel: 'gpt-5.1' });
  const line = insight.queryPool({ op: 'timeline', pool: midnightPool });
  assert.equal(line.five.totals.tokens, 130, '零点整的请求属于当天');
  assert.equal(line.five.cycles.length, 1, '不能把零点整的请求算到昨天');
  pass('pool timeline assigns midnight requests to the new day');
}
{
  const make = (samples, share = 1) => ({ key: 'a', name: 'Test', samples, share, checkedAt: now });
  const sample = (ago, week) => ({ at: now - ago * D, week, weekReset: iso(now + 10 * D) });
  const single = insight.survivalOf([make([sample(0, 30)])], now);
  assert.equal(single.projection, null, '单个采样不能预测');
  const samples = Array.from({ length: 9 }, (_, i) => sample(8 - i, i === 0 ? 0 : 70));
  const result = insight.survivalOf([make(samples)], now);
  assert.ok(Math.abs(result.perDay - 0.1) < 1e-9, '集中一天用掉70%，最近7天平均10%，不能用中位数抹掉');
  assert.ok(result.curve.length && result.danger && result.projection.points.length === 84);
  assert.equal(result.confidence.of, 7);
  assert.equal(insight.survivalOf([make(samples), { key: 'unknown', name: 'Unknown', samples: [], share: 0 }], now).projection, null, '缺一个账号的采样不能保证全池撑住');
  assert.equal(insight.survivalOf([{ ...make(samples), checkedAt: now - H }], now).projection, null, '陈旧采样不生成预测');
  const old = insight.survivalOf([make([sample(12, 0), sample(10, 20), sample(9, 30), sample(0, 30)])], now);
  assert.equal(old.perDay, null, '旧日期的用量不能填进最近7天平均');
  const many = [10, 2, .5, .2, 100].map((left, i) => ({ key: String(i), name: 'Test ' + i, checkedAt: now, share: [.9, .09, .009, .0009, .0001][i], samples: [sample(8, 0), sample(7, 100 - left), sample(0, 100 - left)] }));
  assert.ok(insight.survivalOf(many, now).projection.outAt > now + H, '五个账号逐个用完时继续分摊到还有额度的账号，不能因为只循环三轮就误报断粮');
  pass('survival uses 7-day average, handles missing and stale quotas, and reports curve and simulated confidence');
}
fs.rmSync(root, { recursive: true, force: true });
console.log(`test-pool-insight: ${checks} checks passed`);
