/*
 * 号池按额度排（0.3.44）：快重置优先、剩余最多。
 * 先测 pool-order.ts 的纯排序（分段、分数、防抖、用完 / 没数据 / API Key 的位置、过了重置时间算满、429 标记），
 * 再起一个假上游，经本地路由真的发请求：额度从 quota-history.json 读，回 429 的账号换下一个并先排后面，转发记录带上号池 id。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-pool-order-'));
const home = path.join(root, 'home');
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
  // 快重置优先：分数 = 每周剩余 ÷ 离重置的小时数
  const list = [acc('far', q(90, 120)), acc('soon', q(20, 2)), acc('mid', q(60, 24))];
  assert.equal(order.resetScore(list[0].quota, now), 90 / 120);
  assert.deepEqual(ids(order.orderPool('reset-first', list, undefined, now)), ['soon', 'mid', 'far'], '20%/2h=10 > 60%/24h=2.5 > 90%/120h=0.75');
  // 不知道重置时间按 7 天算
  assert.equal(order.resetScore(q(84, null), now), 84 / 168);
  // 剩余最多：两个窗口里少的那个
  const most = [acc('a', q(80, 100, 30)), acc('b', q(50, 100, 90)), acc('c', q(70, 100))];
  assert.equal(order.leftOf(most[0].quota), 30);
  assert.deepEqual(ids(order.orderPool('most-left', most, undefined, now)), ['c', 'b', 'a']);
  pass('pool order: reset-first scores remaining ÷ hours to weekly reset; most-left uses the smaller window');
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
  // 防抖：剩余最多要多出 5 个百分点才换；快重置优先在 80% 以内继续用
  const most = [acc('a', q(60, 100)), acc('b', q(64, 100))];
  assert.deepEqual(ids(order.orderPool('most-left', most, 'a', now)), ['a', 'b'], '多 4 个点不换');
  assert.deepEqual(ids(order.orderPool('most-left', [acc('a', q(60, 100)), acc('b', q(65.5, 100))], 'a', now)), ['b', 'a'], '多 5.5 个点就换');
  assert.deepEqual(ids(order.orderPool('most-left', most, undefined, now)), ['b', 'a'], '没有在用的就直接挑最多的');
  const reset = [acc('a', q(45, 50)), acc('b', q(50, 50))];
  assert.deepEqual(ids(order.orderPool('reset-first', reset, 'a', now)), ['a', 'b'], '0.9 ≥ 0.8 继续用');
  assert.deepEqual(ids(order.orderPool('reset-first', [acc('a', q(30, 50)), acc('b', q(50, 50))], 'a', now)), ['b', 'a'], '0.6 < 0.8 换');
  // 在用的号已经用完：不保留
  assert.deepEqual(ids(order.orderPool('most-left', [acc('a', q(0, 100)), acc('b', q(10, 100))], 'a', now)), ['b', 'a']);
  pass('pool order: the member in use is kept unless another has 5 points more (most-left) or scores over 1.25× (reset-first)');
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
  let limit = '';
  const fake = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      hits.push(auth.replace('Bearer ', ''));
      if (auth === 'Bearer ' + limit) { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":"rate_limit"}'); return; }
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
    // 转发记录带上号池 id
    const logDir = path.join(process.env.TOKENPULSE_DATA_DIR, 'route-log');
    const rows = fs.readdirSync(logDir).flatMap(name => fs.readFileSync(path.join(logDir, name), 'utf8').trim().split('\n')).map(line => JSON.parse(line));
    assert.ok(rows.length >= 5 && rows.every(row => row.poolId === pool), '每一次转发都记了号池 id');
    assert.ok(rows.some(row => row.status === 429 && row.providerId === `${pool}@claude:qa-b`));
    pass('pool order: through the local route, reset-first and most-left pick members from saved quota, a 429 moves on and holds that account back, the view shows the next member, the route log records the pool id');
  } finally {
    delete process.env.AGENT_SWITCH_POOL_BASE;
    sw.releaseAgentSwitch();
    await sw.setAppProxy('claude', false);
    await sw.waitAgentProxyClosed?.();
    fake.server.close();
  }
  console.log(`test-pool-strategy: ${checks} checks passed`);
})().catch(error => { console.error(error); process.exit(1); });
