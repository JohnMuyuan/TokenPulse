/*
 * 第三方中转站的余额查询（0.3.42，src/core/relay-balance.ts 和 src/main/deepseek-balance.ts 里 kind: relay 的账号）。
 * 覆盖：站点地址的整理和拒绝（http、带密码）；sub2api /v1/usage 的三种回复（钱包余额、订阅限额、Key 自己的额度和限速窗口）；
 * new-api / one-api 的账单接口（总额度 − 已用，不限额）；先试上次认出来的那种；Key 不对 / 站点不支持时怎么说；
 * 服务里：加账号要带站点地址、认出来的接口类型记下来、不支持的站不留、Key 不发给界面、同一个 Key 在不同站点可以各加一次、
 * 和 DeepSeek 账号混在一起时互不影响（本机用量只能指定给 DeepSeek 的账号）。
 * 不联网：请求都由这里的假函数回答。Key 是测试用的假 Key。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-relay-'));
process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
const relay = require(path.join(__dirname, '..', 'build', 'core', 'relay-balance.js'));
const { DeepSeekBalance } = require(path.join(__dirname, '..', 'build', 'main', 'deepseek-balance.js'));

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const KEY = 'sk-' + 'relay'.repeat(6) + '7q2w', OTHER = 'rk_' + 'abc123'.repeat(4), DS = 'sk-' + 'test'.repeat(7) + '9z8y';
const wallet = { balance: 42.5, daily_usage: [{ date: '2026-10-08', requests: 3, total_tokens: 9000, cost: 0.2, actual_cost: 0.1 }, { date: '2026-10-09', requests: 5, total_tokens: 20000, cost: 0.5, actual_cost: 0.25 }], isValid: true, mode: 'unrestricted', planName: '钱包余额', remaining: 42.5, unit: 'USD',
  usage: { today: { requests: 2, total_tokens: 5000, cost: 0.2, actual_cost: 0.12 }, total: { requests: 40, total_tokens: 900000, cost: 9, actual_cost: 7.5 }, rpm: 0, tpm: 0 } };

(async () => {
  // 1. 站点地址
  assert.equal(relay.relayBase(' https://Example.com/v1/ '), 'https://example.com');
  assert.equal(relay.relayBase('relay.example.com/api/'), 'https://relay.example.com/api');
  assert.equal(relay.relayBase('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  for (const bad of ['', 'http://example.com', 'https://user:pw@example.com', 'https://nodot', 'ftp://example.com']) assert.throws(() => relay.relayBase(bad), /站点地址/, bad);
  pass('site addresses are tidied (trailing /v1 dropped); plain http and embedded credentials are refused');

  // 2. sub2api
  const a = relay.parseSub2api(JSON.stringify(wallet));
  assert.deepEqual([a.available, a.remaining, a.currency, a.extra.flavor, a.extra.plan, a.extra.unlimited, a.extra.windows], [true, 42.5, 'USD', 'sub2api', '钱包余额', undefined, undefined]);
  assert.deepEqual([a.extra.today, a.extra.total, a.extra.daily], [{ requests: 2, tokens: 5000, cost: 0.12 }, { requests: 40, tokens: 900000, cost: 7.5 }, [{ date: '2026-10-08', requests: 3, tokens: 9000, cost: 0.1 }, { date: '2026-10-09', requests: 5, tokens: 20000, cost: 0.25 }]]);
  const limited = relay.parseSub2api(JSON.stringify({ mode: 'quota_limited', isValid: true, status: 'active', quota: { limit: 50, used: 12.5, remaining: 37.5, unit: 'USD' }, remaining: 37.5, unit: 'USD', expires_at: '2026-12-01T00:00:00Z',
    rate_limits: [{ window: '5h', limit: 10, used: 4, remaining: 6, reset_at: '2026-10-10T12:00:00Z' }, { window: '7d', limit: 30, used: 31, remaining: 0 }, { window: 'bad', limit: 0 }] }));
  assert.deepEqual([limited.remaining, limited.extra.quota, limited.extra.expiresAt], [37.5, { limit: 50, used: 12.5, remaining: 37.5 }, Date.parse('2026-12-01T00:00:00Z')]);
  assert.deepEqual(limited.extra.windows, [{ name: '5h', limit: 10, used: 4, remaining: 6, resetAt: Date.parse('2026-10-10T12:00:00Z') }, { name: '7d', limit: 30, used: 31, remaining: 0 }]);
  const plan = relay.parseSub2api(JSON.stringify({ mode: 'unrestricted', isValid: true, planName: 'Pro', unit: 'USD', remaining: 3, subscription: { daily_usage_usd: 7, weekly_usage_usd: 20, monthly_usage_usd: 20, daily_limit_usd: 10, weekly_limit_usd: null, monthly_limit_usd: 200, expires_at: '2026-11-01T00:00:00Z' } }));
  assert.deepEqual([plan.remaining, plan.extra.plan, plan.extra.windows, plan.extra.expiresAt], [3, 'Pro', [{ name: 'daily', limit: 10, used: 7, remaining: 3 }, { name: 'monthly', limit: 200, used: 20, remaining: 180 }], Date.parse('2026-11-01T00:00:00Z')]);
  const open = relay.parseSub2api(JSON.stringify({ mode: 'unrestricted', isValid: true, planName: 'Max', unit: 'USD', remaining: -1 }));
  assert.deepEqual([open.remaining, open.extra.unlimited, open.available], [null, true, true]);
  assert.equal(relay.parseSub2api(JSON.stringify({ mode: 'unrestricted', isValid: true, remaining: 0, unit: 'USD' })).available, false, '余额是 0：不能调用了');
  for (const junk of ['<html>', '{}', '{"data":[]}', JSON.stringify({ object: 'list', data: [] })]) assert.equal(relay.parseSub2api(junk), null);
  pass('sub2api replies: wallet balance, subscription limits, key quota and rate-limit windows, unlimited plans; other JSON is not mistaken for it');

  // 3. new-api / one-api
  const billed = relay.parseNewApi(JSON.stringify({ object: 'billing_subscription', hard_limit_usd: 20, access_until: 1800000000 }), JSON.stringify({ object: 'list', total_usage: 512.5 }));
  assert.deepEqual([billed.remaining, billed.extra.flavor, billed.extra.quota, billed.extra.expiresAt, billed.available], [14.875, 'newapi', { limit: 20, used: 5.125, remaining: 14.875 }, 1800000000000, true]);
  assert.deepEqual([relay.parseNewApi(JSON.stringify({ hard_limit_usd: 100000000 }), null).extra.unlimited, relay.parseNewApi(JSON.stringify({ hard_limit_usd: 20 }), null), relay.parseNewApi('{"error":"x"}', '{}')], [true, null, null]);
  pass('new-api billing endpoints: total minus used; an unlimited key is reported as such; a missing usage figure is not guessed');

  // 4. 先试哪一种、失败时怎么说
  const calls = [];
  const site = routes => async (url, key) => { calls.push(new URL(url).pathname); const hit = routes[new URL(url).pathname]; return hit ? (typeof hit === 'function' ? hit(key) : hit) : { status: 404, body: 'not found' }; };
  const ok = body => ({ status: 200, body: JSON.stringify(body) });
  let found = await relay.queryRelay('https://a.example', KEY, site({ '/v1/usage': ok(wallet) }));
  assert.deepEqual([found.ok, found.balance.extra.flavor, calls], [true, 'sub2api', ['/v1/usage']]);
  calls.length = 0;
  const newapiSite = { '/v1/dashboard/billing/subscription': ok({ hard_limit_usd: 20 }), '/v1/dashboard/billing/usage': ok({ total_usage: 500 }) };
  found = await relay.queryRelay('https://b.example', KEY, site(newapiSite));
  assert.deepEqual([found.ok, found.balance.remaining, calls], [true, 15, ['/v1/usage', '/v1/dashboard/billing/subscription', '/v1/dashboard/billing/usage']]);
  calls.length = 0;
  await relay.queryRelay('https://b.example', KEY, site(newapiSite), 'newapi');
  assert.deepEqual(calls, ['/v1/dashboard/billing/subscription', '/v1/dashboard/billing/usage'], '上次认出来是 new-api：直接问它');
  assert.deepEqual(await relay.queryRelay('https://c.example', KEY, site({ '/v1/usage': { status: 401, body: '{}' } })), { ok: false, error: 'API Key 无效或已被删除，请换一个', invalidKey: true });
  assert.deepEqual(await relay.queryRelay('https://d.example', KEY, site({})), { ok: false, error: relay.RELAY_UNSUPPORTED });
  assert.deepEqual(await relay.queryRelay('https://e.example', KEY, site({ '/v1/usage': { status: 502, body: '' } })), { ok: false, error: '站点返回了 HTTP 502' });
  pass('the last recognised interface is tried first; wrong keys, unsupported sites and server errors each get their own explanation');

  // 5. 服务：和 DeepSeek 账号一起管
  const seen = [];
  let relayReply = { '/v1/usage': ok(wallet) };
  let now = 1_800_000_000_000;
  const alerts = [];
  const make = () => new DeepSeekBalance({ now: () => now, notify: (info, below, label, kind) => alerts.push([label, kind, info.total, below]),
    fetcher: async () => ({ status: 200, body: JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }] }) }),
    relayGet: async (url, key) => { seen.push([url, key]); const hit = relayReply[new URL(url).pathname]; return hit || { status: 404, body: '' }; } });
  let service = make();
  await assert.rejects(service.add({ kind: 'relay', key: KEY }), /站点地址/);
  await assert.rejects(service.add({ kind: 'relay', key: 'has space in it', baseUrl: 'https://relay.example' }), /不像 API Key/);
  let state = await service.add({ kind: 'relay', key: KEY, baseUrl: 'https://relay.example/v1', label: '', alertBelow: 50 });
  const first = state.id;
  assert.deepEqual(seen[0], ['https://relay.example/v1/usage?days=30', KEY], 'Key 只发给填的那个站点');
  let account = state.accounts[0];
  assert.deepEqual([account.kind, account.host, account.baseUrl, account.flavor, account.keyHint, account.harness, account.last.infos, account.last.extra.plan], ['relay', 'relay.example', 'https://relay.example', 'sub2api', 'sk-…7q2w', false, [{ currency: 'USD', total: 42.5, granted: 0, toppedUp: 42.5 }], '钱包余额']);
  assert.equal(JSON.stringify(state).includes(KEY), false, '给界面的数据里没有 Key 本身');
  assert.deepEqual(alerts, [['relay.example', 'relay', 42.5, 50]], '没起名字的中转站，提醒里用域名');
  await assert.rejects(service.add({ kind: 'relay', key: KEY, baseUrl: 'https://relay.example' }), /已经添加过了/);
  // 同一个 Key 在另一个站点可以再加；格式不是 sk- 的 Key 也行
  relayReply = { '/v1/dashboard/billing/subscription': ok({ hard_limit_usd: 20 }), '/v1/dashboard/billing/usage': ok({ total_usage: 500 }) };
  state = await service.add({ kind: 'relay', key: OTHER, baseUrl: 'https://other.example', label: '备用站' });
  assert.deepEqual([state.accounts[1].flavor, state.accounts[1].keyHint, state.accounts[1].last.infos[0].total, state.accounts[1].last.extra.quota.limit], ['newapi', '…c123', 15, 20]);
  // 不支持的站、Key 不对的：不留
  relayReply = {};
  await assert.rejects(service.add({ kind: 'relay', key: KEY, baseUrl: 'https://nothing.example' }), /不支持用 Key 查余额/);
  relayReply = { '/v1/usage': { status: 401, body: '{}' } };
  await assert.rejects(service.add({ kind: 'relay', key: KEY, baseUrl: 'https://denied.example' }), /无效/);
  assert.equal(service.state().accounts.length, 2);
  // DeepSeek 的账号照常；第一个 DeepSeek 账号默认带本机用量，中转站不能带
  state = await service.add({ key: DS, label: '个人' });
  assert.deepEqual(state.accounts.map(a => [a.kind, a.harness]), [['relay', false], ['relay', false], ['deepseek', true]]);
  state = await service.update(first, { harness: true, label: '主力站' });
  assert.deepEqual(state.accounts.map(a => [a.label, a.harness]), [['主力站', false], ['备用站', false], ['个人', true]], '本机 Harness 的用量指定不到中转站头上');
  assert.deepEqual([service.kindOf(first), service.kindOf('nope'), service.owner(first)], ['relay', null, { id: first, local: false }]);
  // 图标：预设的 id 或上传的图片（data URL）；别的东西不收；DeepSeek 的账号没有这一项
  const PIC = 'data:image/png;base64,' + 'A'.repeat(64);
  state = await service.update(first, { icon: 'openrouter', avatar: '' });
  assert.deepEqual([state.accounts[0].icon, state.accounts[0].avatar], ['openrouter', '']);
  state = await service.update(first, { icon: '', avatar: PIC });
  assert.deepEqual([state.accounts[0].icon, state.accounts[0].avatar], ['', PIC]);
  state = await service.update(first, { icon: '../x', avatar: 'javascript:alert(1)' });
  assert.deepEqual([state.accounts[0].icon, state.accounts[0].avatar], ['', ''], '不是预设 id、不是图片的都不收');
  state = await service.update(first, { icon: 'letter', avatar: 'data:image/png;base64,' + 'A'.repeat(500000) });
  assert.deepEqual([state.accounts[0].icon, state.accounts[0].avatar], ['letter', ''], '太大的图片不收');
  state = await service.update(state.accounts[2].id, { icon: 'openrouter', avatar: PIC });
  assert.deepEqual([state.accounts[2].icon, state.accounts[2].avatar], ['', '']);
  // 站点出错：留着上次的余额和限额信息
  relayReply = { '/v1/usage': { status: 503, body: '' } }; now += 6000;
  state = await service.refresh(first, true);
  assert.deepEqual([state.accounts[0].last.ok, state.accounts[0].last.error, state.accounts[0].last.infos[0].total, state.accounts[0].last.extra.plan], [false, '站点返回了 HTTP 503', 42.5, '钱包余额']);
  // 重启之后都还在，Key 存在本机的文件里；调整顺序
  service.stop(); service = make();
  assert.deepEqual(service.state().accounts.map(a => [a.kind, a.label, a.host, a.flavor, a.icon]), [['relay', '主力站', 'relay.example', 'sub2api', 'letter'], ['relay', '备用站', 'other.example', 'newapi', ''], ['deepseek', '个人', '', null, '']]);
  const ids = service.state().accounts.map(a => a.id);
  assert.deepEqual(service.reorder([ids[2], ids[1], ids[0]]).accounts.map(a => a.label), ['个人', '备用站', '主力站']);
  service.stop();
  pass('relay keys live next to DeepSeek accounts: the site address is required, the recognised interface is remembered, unsupported sites are not kept, keys never reach the renderer');

  console.log(`${checks}/5 relay balance checks passed`);
})().catch(error => { console.error('FAIL', error.stack || error.message); process.exitCode = 1; }).finally(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 留给系统清 */ } });
