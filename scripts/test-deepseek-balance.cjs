/*
 * DeepSeek 余额监控（0.3.42，src/main/deepseek-balance.ts）和 DeepSeek 的型号名 / 单价。
 * 查询用假的 fetcher，不联网；数据目录是一次性的，不碰真实的 ~/.tokenpulse。
 * 覆盖：解析余额、Key 不外泄（界面只拿到后四位）、Key 格式校验、多个账号各查各的、401 / 断网时保留上次的余额并说明原因、
 * 低余额只提醒一次 / 回升后重新计、手动刷新的间隔、换 Key、删除账号、重启后读回、旧的单 Key 格式；
 * deepseek-flash 显示成 DeepSeek-V4.1-Flash、官方单价、高峰 / 闲时。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-dsbal-'));
process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });
const build = path.join(__dirname, '..', 'build');
const { DeepSeekBalance, parseBalance } = require(path.join(build, 'main', 'deepseek-balance.js'));
const { displayModel } = require(path.join(build, 'core', 'knowledge.js'));
const { priceOf, estimateCost } = require(path.join(build, 'core', 'model-pricing.js'));
const { deepseekPeak } = require(path.join(build, 'core', 'usage-scan.js'));

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const KEY = 'sk-' + 'q'.repeat(28) + 'a1b2', KEY2 = 'sk-' + 'w'.repeat(28) + 'c3d4', KEY3 = 'sk-' + 'e'.repeat(28) + 'e5f6';
const body = (total, extra = {}) => JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: String(total), granted_balance: '1.50', topped_up_balance: String(total - 1.5) }], ...extra });

(async () => {
  try {
    assert.deepEqual(parseBalance(body(110)), { available: true, infos: [{ currency: 'CNY', total: 110, granted: 1.5, toppedUp: 108.5 }] });
    assert.equal(parseBalance('<html>'), null);
    assert.equal(parseBalance('{"ok":true}'), null);
    assert.deepEqual(parseBalance(JSON.stringify({ is_available: false, balance_infos: [{ currency: 'usd!', total_balance: '1' }, { currency: 'USD', total_balance: 'x' }] })), { available: false, infos: [] });
    pass('balance replies are parsed; malformed ones are rejected');

    let now = 1_000_000, calls = 0;
    // 每个 Key 各有各的回复
    const replies = new Map();
    const alerts = [], published = [];
    const make = () => new DeepSeekBalance({ now: () => now, fetcher: async key => { calls++; const reply = replies.get(key) ?? { status: 401, body: '{}' }; if (reply instanceof Error) throw reply; return reply; }, notify: (info, below, label) => alerts.push([label, info.total, below]), publish: state => published.push(state) });
    const file = path.join(process.env.TOKENPULSE_DATA_DIR, 'deepseek-balance.json');
    const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    let service = make();
    assert.deepEqual([service.state().accounts, service.state().detected], [[], false]);
    await assert.rejects(() => service.add({ key: 'not-a-key' }), /sk- 开头/);
    await assert.rejects(() => service.add({ key: 'sk-short' }), /sk- 开头/);
    assert.equal(calls, 0);
    replies.set(KEY, { status: 200, body: body(110) });
    let state = await service.add({ key: '  ' + KEY + '\n', label: '  个人\n', alertBelow: null });
    const first = state.id;
    assert.match(first, /^[a-f0-9]{12}$/);
    assert.deepEqual(state.accounts.map(a => [a.id, a.label, a.keyHint, a.last.ok, a.last.infos[0].total, a.loading, a.alertBelow]), [[first, '个人', 'sk-…a1b2', true, 110, false, null]]);
    assert.equal(JSON.stringify(state).includes(KEY) || JSON.stringify(published).includes(KEY), false, '给界面的状态里没有 Key 本身');
    assert.equal(published.some(item => item.accounts.some(a => a.loading)), true);
    // DeepSeek 说 Key 不对：不保存
    await assert.rejects(() => service.add({ key: 'sk-' + 'z'.repeat(30) }), /无效或已被删除/);
    await assert.rejects(() => service.add({ key: KEY }), /已经添加过了/);
    assert.equal(service.state().accounts.length, 1);
    assert.deepEqual(onDisk().accounts.map(a => a.apiKey), [KEY]);
    pass('the key is validated, used for the query, and never sent back to the renderer; a rejected or duplicate key is not kept');

    // 第二个账号：各查各的，各有各的余额
    replies.set(KEY2, { status: 200, body: body(8) });
    state = await service.add({ key: KEY2, label: '公司', alertBelow: 20 });
    const second = state.id;
    assert.deepEqual(state.accounts.map(a => [a.label, a.keyHint, a.last.infos[0].total, a.alertBelow]), [['个人', 'sk-…a1b2', 110, null], ['公司', 'sk-…c3d4', 8, 20]]);
    assert.deepEqual(alerts, [['公司', 8, 20]], '加进来就低于提醒线：提醒一次');
    calls = 0; now += 6000;
    await service.refreshAll(true); assert.equal(calls, 2);
    await service.refreshAll(true); assert.equal(calls, 2, '手动刷新每个账号至少隔 5 秒');
    await service.refresh(first, false); assert.equal(calls, 3, '定时的不受限');
    now += 6000; replies.set(KEY, { status: 200, body: body(42) });
    state = await service.refresh(first, true);
    assert.deepEqual(state.accounts.map(a => a.last.infos[0].total), [42, 8]);
    pass('several accounts are tracked independently; manual refreshes are rate limited per account');

    // 提醒：低于才提醒，只提醒一次；回升后再跌才会再提醒
    alerts.length = 0;
    await service.update(first, { alertBelow: 50 }); assert.deepEqual(alerts, [['个人', 42, 50]]);
    now += 6000; await service.refresh(first, true); assert.equal(alerts.length, 1);
    replies.set(KEY, { status: 200, body: body(80) }); now += 6000; await service.refresh(first, true); assert.equal(alerts.length, 1);
    replies.set(KEY, { status: 200, body: body(12) }); now += 6000; await service.refresh(first, true); assert.deepEqual(alerts[1], ['个人', 12, 50]);
    await assert.rejects(() => service.update(first, { alertBelow: -1 }), /0 到 1000000/);
    assert.equal((await service.update(first, { alertBelow: 0 })).accounts[0].alertBelow, null);
    state = await service.update(first, { alertBelow: 50, label: '我的' });
    assert.deepEqual([state.accounts[0].alertBelow, state.accounts[0].label, alerts.length], [50, '我的', 3]);
    assert.equal(alerts.filter(item => item[0] === '公司').length, 0, '别的账号不受影响');
    pass('low-balance alert fires once per account and re-arms after the balance recovers');

    // 出错：保留上次的余额，说明原因，不提醒
    replies.set(KEY, { status: 401, body: '{"error":{"message":"Authentication Fails"}}' }); now += 6000;
    state = await service.refresh(first, true);
    assert.deepEqual([state.accounts[0].last.ok, state.accounts[0].last.infos[0].total, state.accounts[0].last.error], [false, 12, 'API Key 无效或已被删除，请换一个']);
    replies.set(KEY, new Error('getaddrinfo ENOTFOUND')); now += 6000;
    state = await service.refresh(first, true); assert.match(state.accounts[0].last.error, /^没连上 DeepSeek：getaddrinfo ENOTFOUND/);
    replies.set(KEY, { status: 200, body: 'oops' }); now += 6000;
    assert.equal((await service.refresh(first, true)).accounts[0].last.error, 'DeepSeek 返回的内容看不懂');
    assert.equal(alerts.length, 3);
    assert.equal(state.accounts[1].last.ok, true);
    // 换 Key：新的不对就保持原样；对了才换
    await assert.rejects(() => service.update(second, { key: 'sk-' + 'y'.repeat(30) }), /无效或已被删除/);
    assert.deepEqual([service.state().accounts[1].keyHint, service.state().accounts[1].last.infos[0].total], ['sk-…c3d4', 8]);
    await assert.rejects(() => service.update(second, { key: KEY }), /已经添加过了/);
    replies.set(KEY3, { status: 200, body: body(300) });
    state = await service.update(second, { key: KEY3 });
    assert.deepEqual([state.accounts[1].keyHint, state.accounts[1].last.infos[0].total, state.accounts[1].label], ['sk-…e5f6', 300, '公司']);
    await assert.rejects(() => service.update('nope', {}), /找不到这个 DeepSeek 账号/);
    pass('errors keep the last known balance and explain what went wrong; replacing a key is verified first');

    // 重启后读回；删除一个不影响另一个
    service.stop(); service = make();
    assert.deepEqual(service.state().accounts.map(a => [a.id, a.label, a.alertBelow, a.last.infos[0].total]), [[first, '我的', 50, 12], [second, '公司', 20, 300]]);
    state = service.remove(first);
    assert.deepEqual(state.accounts.map(a => a.id), [second]);
    assert.equal(fs.readFileSync(file, 'utf8').includes(KEY), false, '删除后文件里不再有这个 Key');
    const before = calls; await service.refresh(first, true); assert.equal(calls, before);
    fs.mkdirSync(path.join(process.env.HOME, '.dsh'));
    assert.equal(service.state().detected, true);
    service.stop();
    // 第一个测试版的格式（只能存一个 Key）：读进来当成第一个账号
    fs.writeFileSync(file, JSON.stringify({ apiKey: KEY, alertBelow: 30, last: { at: 5, ok: true, available: true, infos: [{ currency: 'CNY', total: 66, granted: 0, toppedUp: 66 }] } }));
    service = make();
    assert.deepEqual(service.state().accounts.map(a => [a.label, a.keyHint, a.alertBelow, a.last.infos[0].total]), [['', 'sk-…a1b2', 30, 66]]);
    service.stop();
    pass('state survives a restart; deleting one account leaves the others; the single-key format from the first test build is migrated');

    // 型号名和单价
    assert.equal(displayModel('deepseek-flash'), 'DeepSeek-V4.1-Flash');
    assert.equal(displayModel('deepseek-v4-pro'), 'DeepSeek-V4-Pro');
    assert.equal(displayModel('gpt-5.6-sol'), 'gpt-5.6-sol');
    for (const id of ['deepseek-flash', 'DeepSeek-V4.1-Flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) assert.deepEqual([priceOf(id).input, priceOf(id).output, priceOf(id).cacheRead], [0.3, 1.2, 0.006], id);
    for (const id of ['deepseek-v4-pro', 'DeepSeek-V4-Pro']) assert.deepEqual([priceOf(id).input, priceOf(id).output, priceOf(id).cacheRead], [1.32, 3.96, 0.044], id);
    assert.equal(priceOf('deepseek-chat').output, 0.42, '别的 DeepSeek 型号还是走原来那条');
    assert.ok(Math.abs(estimateCost('DeepSeek-V4.1-Flash', { input: 1_000_000, output: 1_000_000, cacheRead: 500_000, cacheWrite: 0 }) - (0.15 + 1.2 + 0.003)) < 1e-9);
    const utc = (day, hour) => Date.UTC(2026, 9, day, hour, 30);   // 2026-10-12 是周一
    assert.deepEqual([utc(12, 0), utc(12, 1), utc(12, 3), utc(12, 4), utc(12, 5), utc(12, 6), utc(12, 9), utc(12, 10), utc(16, 2), utc(17, 2), utc(18, 7)].map(deepseekPeak), [false, true, true, false, false, true, true, false, true, false, false]);
    pass('deepseek-flash is shown as DeepSeek-V4.1-Flash and priced at the official peak / off-peak rates');

    console.log(`${checks}/${checks} deepseek balance checks passed`);
  } catch (error) {
    console.error('FAIL', error);
    process.exitCode = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
