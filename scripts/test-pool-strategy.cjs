/*
 * 号池按额度排（0.3.44）：快重置优先、剩余最多。
 * 先测 pool-order.ts 的纯函数（重置时间排序、预排、速度、防抖、用完 / 没数据 / API Key 的位置、429 标记），
 * 再起一个假上游，经本地路由真的发请求：额度从 quota-history.json 读，回 429 的账号换下一个并先排后面，转发记录带上号池 id。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-pool-order-'));
const home = path.join(root, 'home');
process.env.HOME = process.env.USERPROFILE = home;
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.AGENT_SWITCH_HOME = home;
process.env.AGENT_SWITCH_CC_DB = path.join(root, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
fs.mkdirSync(home, { recursive: true });

const order = require('../build/core/pool-order');
const sw = require('../build/core/agent-switch');

const H = 3600_000;
const now = Date.UTC(2026, 9, 11, 12);
const q = (week, weekInHours, five = null, fiveInHours = 3) => ({ five: five == null ? null : { left: five, resetAt: now + fiveInHours * H }, week: week == null ? null : { left: week, resetAt: weekInHours == null ? null : now + weekInHours * H }, at: now - 60_000 });
const acc = (id, quota, limitedAt) => ({ id, type: 'account', quota, ...(limitedAt ? { limitedAt } : {}) });
const key = id => ({ id, type: 'provider', quota: null });
const ids = list => list.map(item => item.id);

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };

{
  // EDF：最早重置先用；即使 B 剩 100%、A 只剩 20%，也先用 A。
  const list = [acc('B', q(100, 5)), acc('A', q(20, 2)), acc('far', q(90, 120))];
  assert.deepEqual(ids(order.orderPool('reset-first', list, undefined, now)), ['A', 'B', 'far']);
  const unknownReset = [acc('unknown-reset', q(40, null)), acc('known-reset', q(10, 120))];
  assert.deepEqual(ids(order.orderPool('reset-first', unknownReset, undefined, now)), ['known-reset', 'unknown-reset'], '不知道重置时间按 7 天后');
  const noWeeklyWindow = [acc('five-only', q(null, null, 40)), acc('weekly', q(20, 120))];
  assert.deepEqual(ids(order.orderPool('reset-first', noWeeklyWindow, undefined, now)), ['weekly', 'five-only'], '没有每周窗口的账号排在可预排账号后面');
  const sameReset = [acc('less', q(20, 24)), acc('more', q(80, 24))];
  assert.deepEqual(ids(order.orderPool('reset-first', sameReset, undefined, now)), ['more', 'less'], '同时重置时剩得多的在前');
  // 剩余最多：两个窗口里少的那个
  const most = [acc('a', q(80, 100, 30)), acc('b', q(50, 100, 90)), acc('c', q(70, 100))];
  assert.equal(order.leftOf(most[0].quota), 30);
  assert.deepEqual(ids(order.orderPool('most-left', most, undefined, now)), ['c', 'b', 'a']);
  pass('pool order: reset-first follows earliest reset, then remaining quota and configured order; most-left uses the smaller window');
}

{
  // 分段：能用的 → 没数据的 → API Key → 用完的（先恢复的在前）
  const list = [key('key1'), acc('spentLate', q(0.5, 100)), acc('unknown', null), acc('ok', q(40, 50)), acc('spentSoon', q(50, 100, 0, 1)), key('key2')];
  assert.deepEqual(ids(order.orderPool('most-left', list, undefined, now)), ['ok', 'unknown', 'key1', 'key2', 'spentSoon', 'spentLate']);
  assert.deepEqual(ids(order.orderPool('reset-first', list, undefined, now)), ['ok', 'unknown', 'key1', 'key2', 'spentSoon', 'spentLate']);
  // 已经过了重置时间的窗口按满的算（windowOf 在 accountQuota 里处理，这里直接给满的）
  // 回过 429、之后还没查到新额度：先排后面；查到新额度（at 比标记晚）就照额度排
  const limited = [acc('x', q(90, 50), now - 60_000 + 1), acc('y', q(30, 50))];
  assert.deepEqual(ids(order.orderPool('most-left', limited, undefined, now)), ['y', 'x']);
  const refreshed = [acc('x', { ...q(90, 50), at: now - 1000 }, now - 5000), acc('y', q(30, 50))];
  assert.deepEqual(ids(order.orderPool('most-left', refreshed, undefined, now)), ['x', 'y']);
  const expired = [acc('x', q(90, 50), now - order.LIMIT_HOLD_MS - 1), acc('y', q(30, 50))];
  assert.deepEqual(ids(order.orderPool('most-left', expired, undefined, now)), ['x', 'y'], '标记过了 10 分钟就不管了');
  pass('pool order: ready → no data → API keys → spent (soonest recovery first); a 429 holds an account back until fresher quota or 10 minutes');
}

{
  // 防抖：剩余最多要多出 5 个百分点才换。
  const most = [acc('a', q(60, 100)), acc('b', q(64, 100))];
  assert.deepEqual(ids(order.orderPool('most-left', most, 'a', now)), ['a', 'b'], '多 4 个点不换');
  assert.deepEqual(ids(order.orderPool('most-left', [acc('a', q(60, 100)), acc('b', q(65.5, 100))], 'a', now)), ['b', 'a'], '多 5.5 个点就换');
  assert.deepEqual(ids(order.orderPool('most-left', most, undefined, now)), ['b', 'a'], '没有在用的就直接挑最多的');
  const close = [acc('first', q(100, 2)), acc('current', q(99, 2))];
  assert.deepEqual(ids(order.orderPool('reset-first', close, 'current', now, 0.1)), ['current', 'first'], '已知速度，继续当前号不会多作废 2 个百分点');
  const wasteful = [acc('first', q(80, 2)), acc('current', q(80, 20))];
  assert.deepEqual(ids(order.orderPool('reset-first', wasteful, 'current', now, 10)), ['first', 'current'], '已知速度，继续当前号会多作废就切换');
  assert.deepEqual(ids(order.orderPool('reset-first', [acc('first', q(50, 4)), acc('current', q(60, 8))], 'current', now)), ['current', 'first'], '速度未知且重置相差 6 小时内，继续当前号');
  assert.deepEqual(ids(order.orderPool('reset-first', [acc('first', q(50, 4)), acc('current', q(60, 12))], 'current', now)), ['first', 'current'], '速度未知且重置相差超过 6 小时，切换');
  assert.deepEqual(ids(order.orderPool('reset-first', [acc('five-only', q(null, null, 40)), acc('weekly', q(20, 120))], 'five-only', now, 10)), ['weekly', 'five-only'], '有速度但当前账号没有周额度窗口时不把 5 小时额度当周额度推演');
  // 在用的号已经用完：不保留
  assert.deepEqual(ids(order.orderPool('most-left', [acc('a', q(0, 100)), acc('b', q(10, 100))], 'a', now)), ['b', 'a']);
  pass('pool order: most-left keeps its 5-point margin; reset-first keeps current only when simulated waste is close or reset times are within 6 hours');
}

{
  const at = Date.UTC(2026, 9, 11, 12), day = 24 * H;
  const member = (id, left, hours) => ({ id, left, resetAt: at + hours * H, period: 7 * day });
  const early = member('early', 20, 2), later = member('later', 100, 5);
  const reset = order.planPool('reset-first', [later, early], 0.5, at);
  assert.deepEqual(reset.order.slice(0, 2), ['early', 'later']);
  assert.deepEqual(reset.segments.slice(0, 2).map(s => [s.id, s.from, s.to]), [['early', at, at + 2 * H], ['later', at + 2 * H, at + 5 * H]]);
  assert.equal(reset.members.find(m => m.id === 'early').waste, 19);
  assert.equal(reset.members.find(m => m.id === 'later').waste, 98.5);
  assert.equal(reset.outAt, null);

  const fill = order.planPool('fill-first', [member('a', 10, 2), member('b', 100, 6 * 24)], 1, at);
  assert.equal(fill.segments[0].id, 'a');
  assert.equal(fill.members.find(m => m.id === 'a').waste, 8, '重置时记下剩余并回满');
  assert.equal(fill.members.find(m => m.id === 'a').drainAt, at + 102 * H);

  const most = order.planPool('most-left', [member('a', 50, 6 * 24), member('b', 100, 6 * 24)], 10, at);
  assert.equal(most.segments[0].id, 'b');
  assert.ok(most.segments.some(s => s.id === 'a'), '另一个号多出 5 个百分点后会切换');

  const round = order.planPool('round-robin', [member('a', 2, 100), member('b', 100, 120)], 2, at);
  assert.deepEqual(round.segments.slice(0, 2).map(s => s.id), ['a', 'b'], '轮询平均分给还有额度的号');
  assert.equal(round.members.find(m => m.id === 'a').drainAt, at + 2 * H);
  assert.equal(round.outAt, at + 51 * H, '所有账号都见底时记录最早见底时刻');
  const still = order.planPool('reset-first', [member('late', 20, 5), member('soon', 10, 2), { id: 'unknown', left: 30, resetAt: null, period: 7 * day }], null, at);
  assert.deepEqual(still.order, ['soon', 'late', 'unknown']); assert.deepEqual(still.segments, []);
  assert.ok(still.members.every(m => m.waste === null)); assert.equal(still.outAt, null);
  assert.equal(still.members.find(m => m.id === 'soon').resetAt, at + 2 * H, '静态计划保留已知重置时间');
  assert.equal(still.members.find(m => m.id === 'unknown').resetAt, at + 7 * 24 * H, '静态计划把未知重置时间按一个周期后展示');
  pass('planPool: four policies allocate the week, record segments and first reset waste, detect drains, and return static order without a rate');
}

{
  const t = Date.UTC(2026, 9, 11, 12), reset1 = new Date(t + 4 * H).toISOString(), reset2 = new Date(t + 8 * H).toISOString();
  const rate = order.weeklyRateOf([
    { at: t - 48 * H, week: 20, weekReset: reset1 }, { at: t - 36 * H, week: 30, weekReset: reset1 },
    { at: t - 12 * H, week: 10, weekReset: reset2 }, { at: t - 6 * H, week: 25, weekReset: reset2 },
  ], t);
  assert.ok(Math.abs(rate - 25 / 42) < 1e-12, '同一重置周期里的上涨累加，跨周期下降不计');
  assert.equal(order.weeklyRateOf([{ at: t - 12 * H, week: 5 }, { at: t - H, week: 8 }], t), null, '覆盖不足 24 小时返回 null');
  pass('pool order: weekly percentage rate only counts same-reset increases and requires 24 hours of coverage');
}

{
  // accountQuota：读 quota-history.json 最后一条 + quota-checked.json 的时间；过了重置时间算满；太旧当没数据
  const t = Date.now();
  const iso = ms => new Date(ms).toISOString();
  fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'quota-history.json'), JSON.stringify({ version: 1, accounts: {
    claude: [
      { at: t - 20 * 60_000, five: 10, fiveReset: iso(t + 2 * H), week: 10, weekReset: iso(t + 100 * H), account: 'claude:old' },
      { at: t - 10 * 60_000, five: 80, fiveReset: iso(t - 60_000), week: 40, weekReset: iso(t + 30 * H), account: 'claude:old' },
      { at: t - 2 * H, five: 5, week: 5, weekReset: iso(t + 10 * H), account: 'claude:stale' },
    ],
  } }));
  fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'quota-checked.json'), JSON.stringify({ accounts: { 'claude:old': t - 30_000 } }));
  const got = order.accountQuota('claude:old', t);
  assert.equal(got.at, t - 30_000, '时间取最后一次查询成功');
  assert.deepEqual(got.five, { left: 100, resetAt: null }, '5 小时窗口已经重置');
  assert.equal(got.week.left, 60);
  assert.equal(order.accountQuota('claude:stale', t), null, '两小时没查到当没有数据');
  assert.equal(order.accountQuota('claude:none', t), null);
  pass('pool order: account quota comes from the last sample and the last successful check; past resets count as full; stale data is ignored');
}

function listen(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

(async () => {
  const t = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const account = (ref, token) => ({ id: `claude:${ref}`, kind: 'claude', ref, email: `${ref}@example.com`, label: ref, createdAt: t, lastSeenAt: t, credential: { token, expiresAt: t + H } });
  fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'official-accounts.json'), JSON.stringify({ version: 2, active: {}, accounts: [account('qa-a', 'oauth-a'), account('qa-b', 'oauth-b'), account('qa-c', 'oauth-c')] }));
  // a：每周剩 90%、5 天后重置；b：剩 30%、3 小时后重置；c：剩 60%、2 天后重置
  const sample = (ref, week, hours) => ({ at: t - 60_000, five: 0, week, weekReset: iso(t + hours * H), account: `claude:${ref}` });
  fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'quota-history.json'), JSON.stringify({ version: 1, accounts: { claude: [sample('qa-a', 10, 120), sample('qa-b', 70, 3), sample('qa-c', 40, 48)] } }));
  fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'quota-checked.json'), JSON.stringify({ accounts: { 'claude:qa-a': t, 'claude:qa-b': t, 'claude:qa-c': t } }));
  const hits = [];
  let limit = '', limitStatus = 429;
  const fake = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      hits.push(auth.replace('Bearer ', ''));
      if (auth === 'Bearer ' + limit) { res.writeHead(limitStatus, { 'content-type': 'application/json' }); res.end('{"error":"rate_limit"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }));
    });
  });
  process.env.AGENT_SWITCH_POOL_BASE = `http://127.0.0.1:${fake.port}`;
  try {
    const free = await listen(() => {}); const port = free.port; await new Promise(r => free.server.close(r));
    await sw.setProxyPort(port);
    const members = ['qa-a', 'qa-b', 'qa-c'].map(ref => ({ type: 'account', id: `claude:${ref}` }));
    const pool = sw.saveProvider({ app: 'claude', name: 'Quota Pool', pool: { strategy: 'reset-first', members } });
    assert.equal(sw.agentView().providers.find(p => p.id === pool).pool.strategy, 'reset-first', '新的轮换方式能存');
    await sw.activateProvider(pool);
    const send = () => fetch(`http://127.0.0.1:${sw.agentView().proxy.port}/claude/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'PROXY_MANAGED' }, body: JSON.stringify({ model: 'claude-qa', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }) });
    const view = () => sw.agentView().providers.find(p => p.id === pool).pool;
    assert.equal(view().next, 'claude:qa-b', '界面上标出下一个：3 小时后重置的 b（30/3=10）');
    assert.deepEqual(view().members.map(m => m.quota && Math.round(m.quota.weekLeft)), [90, 30, 60]);
    for (let i = 0; i < 2; i++) assert.equal((await send()).status, 200);
    assert.deepEqual(hits, ['oauth-b', 'oauth-b'], '快重置优先：一直用 b');
    // b 回 429：这次换 c（60/48=1.25 > 90/120=0.75），之后 b 先排后面，不再每次先撞一次
    hits.length = 0; limit = 'oauth-b';
    assert.equal((await send()).status, 200);
    assert.deepEqual(hits, ['oauth-b', 'oauth-c']);
    hits.length = 0; limit = '';
    await send();
    assert.deepEqual(hits, ['oauth-c'], '回过 429 的号在查到新额度之前不先用');
    assert.equal(view().members.find(m => m.id === 'claude:qa-b').quota.limited, true);
    // 剩余最多：a 剩 90% 最多
    sw.saveProvider({ id: pool, app: 'claude', name: 'Quota Pool', pool: { strategy: 'most-left', members } });
    hits.length = 0;
    await send();
    assert.deepEqual(hits, ['oauth-a']);
    assert.equal(view().next, 'claude:qa-a');
    // 0.3.48：轮询也跳过用完的号。c 额度查到只剩 0.5%；a 回 402（Grok 额度用完就回这个）换下一个，之后也排后面
    sw.saveProvider({ id: pool, app: 'claude', name: 'Quota Pool', pool: { strategy: 'round-robin', members } });
    fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'quota-history.json'), JSON.stringify({ version: 1, accounts: { claude: [sample('qa-a', 10, 120), sample('qa-b', 20, 100), sample('qa-c', 99.5, 48)] } }));
    fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'quota-checked.json'), JSON.stringify({ accounts: { 'claude:qa-a': t, 'claude:qa-b': t + 1, 'claude:qa-c': t } }));
    hits.length = 0; limit = 'oauth-a'; limitStatus = 402;
    for (let i = 0; i < 4; i++) assert.equal((await send()).status, 200, '402 换下一个成员，不把错误交给工具');
    assert.ok(!hits.includes('oauth-c'), '额度用完的 c 不再轮到');
    assert.equal(hits.filter(h => h === 'oauth-a').length, 1, '回过 402 的 a 只撞一次，之后排后面');
    assert.ok(hits.filter(h => h === 'oauth-b').length >= 3);
    limit = ''; limitStatus = 429;
    pass('pool order: round robin skips accounts whose quota is spent; a 402 moves on and holds that account back');
    // 转发记录带上号池 id
    const logDir = path.join(process.env.TOKENPULSE_DATA_DIR, 'route-log');
    const rows = fs.readdirSync(logDir).flatMap(name => fs.readFileSync(path.join(logDir, name), 'utf8').trim().split('\n')).map(line => JSON.parse(line));
    assert.ok(rows.length >= 9 && rows.every(row => row.poolId === pool), '每一次转发都记了号池 id');
    assert.ok(rows.some(row => row.status === 429 && row.providerId === `${pool}@claude:qa-b`));
    pass('pool order: through the local route, reset-first and most-left pick members from saved quota, a 429 moves on and holds that account back, the view shows the next member, the route log records the pool id');
  } finally {
    delete process.env.AGENT_SWITCH_POOL_BASE;
    sw.releaseAgentSwitch();
    await sw.setAppProxy('claude', false);
    await sw.waitAgentProxyClosed?.();
    fake.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`test-pool-strategy: ${checks} checks passed`);
})().catch(error => { console.error(error); process.exit(1); });
