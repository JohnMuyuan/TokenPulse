/*
 * 额度详情的号池页（0.3.44，renderer/pool-quota.js）。
 * 一次性的 HOME / 数据目录：两个假的官方账号 + 一个假的 API Key 供应商组成号池，转发记录和额度采样都是这里编的，不联网。
 * 走一遍：号池在额度详情顶上有自己的标签 → 点进去：总额度（相当于几个号）、用量和用了多久、成员分摊、按成员叠起来的 24 小时 / 30 天、
 * 时间线（按天 / 7 天，成员平均已用曲线）、模型速度、用过的模型、最近的请求 → 编辑布局能收起号池的卡片 → 两个号池拖动排序 → 切回官方账号恢复原样。
 * TOKENPULSE_SHOT_DIR 设了的话截几张图（只有测试数据）。
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { app } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-pool-quota-ui-'));
const home = path.join(root, 'home'), data = path.join(root, 'data');
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = home;
process.env.TOKENPULSE_DATA_DIR = data;
process.env.AGENT_SWITCH_CC_DB = path.join(root, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) delete process.env[key];
app.setPath('userData', path.join(root, 'electron')); app.commandLine.appendSwitch('lang', 'zh-CN');
const appRoot = process.env.TOKENPULSE_TEST_APP || path.resolve(__dirname, '..');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
write(path.join(data, 'prefs.json'), { seenVersion: require(path.join(appRoot, 'package.json')).version, onboarding: 'done', ccSwitch: false });
require(path.join(appRoot, 'build/core/quota.js')).fetchOfficialQuota = async () => ({});
const shots = process.env.TOKENPULSE_SHOT_DIR;

const NOW = Date.now(), MIN = 60000, H = 60 * MIN, D = 24 * H;
const iso = ms => new Date(ms).toISOString();
const account = ref => ({ id: `claude:${ref}`, kind: 'claude', ref, email: `${ref}@example.com`, label: ref, createdAt: NOW, lastSeenAt: NOW, credential: { token: 'fake-oauth-' + ref, expiresAt: NOW + H } });
write(path.join(data, 'official-accounts.json'), { version: 2, active: {}, accounts: [account('qa-a'), account('qa-b')] });
// 额度（已用）：a 一周里 10% → 30%；b 重置后 5% → 20%。剩余 70% + 80% = 相当于 1.5 个号
const R1 = iso(NOW + D), R2 = iso(NOW + 3 * D);
write(path.join(data, 'quota-history.json'), { version: 1, accounts: { claude: [
  { at: NOW - 6 * D, five: 0, week: 10, weekReset: R1, account: 'claude:qa-a' },
  { at: NOW - 2 * D, five: 0, week: 5, weekReset: R2, account: 'claude:qa-b' },
  { at: NOW - D, five: 20, fiveReset: iso(NOW + 2 * H), week: 30, weekReset: R1, account: 'claude:qa-a' },
  { at: NOW - H, five: 0, week: 20, weekReset: R2, account: 'claude:qa-b' },
] } });
write(path.join(data, 'quota-checked.json'), { accounts: { 'claude:qa-a': NOW - 30000, 'claude:qa-b': NOW - 30000 } });

// 号池：先存好（和主进程用的是同一个模块），再按号池 id 编转发记录
const sw = require(path.join(appRoot, 'build/core/agent-switch.js'));
const keyId = sw.saveProvider({ app: 'claude', name: 'Key K', baseUrl: 'https://relay.example/v1', apiKey: 'sk-fake-test-key', model: 'claude-sonnet-5', upstream: 'anthropic' });
const poolId = sw.saveProvider({ app: 'claude', name: '主力号池', pool: { strategy: 'most-left', members: [{ type: 'account', id: 'claude:qa-a' }, { type: 'account', id: 'claude:qa-b' }, { type: 'provider', id: keyId }] } });
const otherId = sw.saveProvider({ app: 'claude', name: '备用号池', pool: { strategy: 'round-robin', members: [{ type: 'account', id: 'claude:qa-b' }] } });
{
  const rows = [];
  const add = (at, providerId, extra) => rows.push({ at, app: 'claude', pool: true, poolId, providerId, provider: '主力号池 · x', status: 200, upstream: 'anthropic', attempt: 1, ...extra });
  // 最近 24 小时：a 三次（sonnet high）、b 一次 429 之后换 Key K 成功
  for (const [ago, tokens] of [[50, 1000], [40, 2000], [30, 3000]]) add(NOW - ago * MIN, `${poolId}@claude:qa-a`, { ms: 4000, input: tokens, output: 200, requestModel: 'claude-sonnet-5', returnedModel: 'claude-sonnet-5', effort: 'high', tokensPerSec: 50 + ago / 10, firstTokenMs: 800 });
  add(NOW - 20 * MIN, `${poolId}@claude:qa-b`, { status: 429, ms: 200, input: 0, output: 0, requestModel: 'claude-sonnet-5', error: 'rate_limit' });
  add(NOW - 20 * MIN + 1000, keyId, { ms: 3000, input: 500, output: 500, requestModel: 'claude-sonnet-5', returnedModel: 'claude-sonnet-5', effort: 'medium', attempt: 2, tokensPerSec: 70, firstTokenMs: 600 });
  // 3 天前：b 用 opus 两次
  for (const ago of [3 * D, 3 * D - 2 * MIN]) add(NOW - ago, `${poolId}@claude:qa-b`, { ms: 5000, input: 4000, output: 1000, requestModel: 'claude-opus-5', returnedModel: 'claude-opus-5', effort: 'max', tokensPerSec: 30 });
  for (const row of rows) { const d = new Date(row.at); fs.mkdirSync(path.join(data, 'route-log'), { recursive: true }); fs.appendFileSync(path.join(data, 'route-log', `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`), JSON.stringify(row) + '\n'); }
}
const watchdog = setTimeout(() => { console.error('FAIL pool quota UI timed out'); app.exit(1); }, 180000);

app.on('web-contents-created', (_, contents) => contents.once('did-finish-load', async () => {
  const evaluate = code => contents.executeJavaScript(code).catch(e => { throw new Error(e.message + ' ← ' + String(code).slice(0, 160)); }), delay = ms => new Promise(r => setTimeout(r, ms));
  const until = async (code, ms = 15000) => { const end = Date.now() + ms; while (!await evaluate('Promise.resolve(' + code + ').then(v=>!!v)')) { assert.ok(Date.now() < end, 'Timed out: ' + code); await delay(80); } };
  const text = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
  const shot = async name => { if (!shots) return; await delay(500); fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, 'pool-quota-' + name + '.png'), (await contents.capturePage()).toPNG()); };
  const TABS = '#account-tabs button[data-pool]', DETAIL = '#quota-detail';
  const tabTexts = () => evaluate(`[...document.querySelectorAll('${TABS}')].map(b => b.textContent.replace(/\\s+/g, ' ').trim())`);
  try {
    if (!await evaluate("Boolean(document.querySelector('#tiles'))")) return;
    await evaluate("navigate('quota')");
    await until(`document.querySelectorAll('${TABS}').length === 2`);
    assert.deepEqual(await tabTexts(), ['号池主力号池', '号池备用号池']);
    assert.equal(await evaluate(`document.querySelector('${TABS}').title`), '主力号池 · Claude Code 的号池');
    assert.equal(await evaluate("document.getElementById('page-quota').classList.contains('pool-mode')"), false);
    pass('each pool gets its own tab in Quota details, next to the official accounts');

    await evaluate(`document.querySelector('${TABS}[data-account="pool:${poolId}"]').click()`);
    await until(`document.querySelector('${DETAIL} .pq-quota .window-number strong')?.textContent === '1.5'`);
    assert.equal(await evaluate("document.getElementById('page-quota').classList.contains('pool-mode')"), true);
    assert.equal(await evaluate("getComputedStyle(document.getElementById('quota-model-study')).display"), 'none', '整窗容量排行不适用于号池');
    assert.match(await text(`${DETAIL} .pq-context`), /号池\s*主力号池.*Claude Code · 剩余最多 · 2 个官方账号、1 个 API Key/);
    assert.match(await text(`${DETAIL} .pq-quota`), /1\.5\s*个号的周额度还剩下.*2 \/ 2\s*个账号查到了额度/);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${DETAIL} .pq-ring-row')].map(row => row.querySelector('.quota-remaining').textContent)`), ['70%', '80%']);
    assert.match(await text(`${DETAIL} .pq-quota .prediction-line`), /大约还能用/);
    assert.match(await text(`${DETAIL} .pq-quota .quota-footnote`), /整个账号的消耗/);
    pass('pool quota adds the members\' weekly remainder (70% + 80% = 1.5 accounts), one ring per account member, and projects days left');

    // 用量：今天的 Token = 最近 24 小时那几次里今天的部分；成员分摊三行
    const today = await evaluate("(() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })()");
    const expectToday = [[50, 1200], [40, 2200], [30, 3200], [20, 1000]].filter(([ago]) => NOW - ago * MIN > today).reduce((sum, [, v]) => sum + v, 0);
    assert.equal(await evaluate(`document.querySelector('${DETAIL} .pq-usage .window-number strong').textContent`), await evaluate(`tokens(${expectToday})`));
    assert.match(await text(`${DETAIL} .pq-usage`), /用了多久/);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${DETAIL} .pq-member .pq-member-name b')].map(b => b.textContent)`), ['qa-a@example.com', 'qa-b@example.com', 'Key K']);
    assert.match(await evaluate(`document.querySelectorAll('${DETAIL} .pq-member')[1].textContent`), /限流 1 次/);
    pass('usage, active time and the member split are shown; the 429 is counted on the member that returned it');

    // 24 小时 / 30 天：按成员叠起来，有图例
    await until(`document.querySelectorAll('${DETAIL} .quota-history-grid .pq-seg').length >= 3`);
    assert.deepEqual(await evaluate(`[...document.querySelector('${DETAIL} .quota-history-grid .pq-legend').querySelectorAll('span > span')].map(s => s.textContent)`), ['qa-a@example.com', 'qa-b@example.com', 'Key K']);
    assert.ok(await evaluate(`new Set([...document.querySelectorAll('${DETAIL} .quota-history-grid .pq-seg')].map(r => r.style.fill)).size >= 2`), '不同成员不同颜色');
    pass('24-hour and 30-day charts stack by member with a legend');

    // 时间线：挪进号池页，按天 / 7 天，上方曲线是成员平均已用，没有「本机以外」
    await until(`document.querySelector('${DETAIL} #quota-model-timeline .ms-cycle.week .ms-lane')`);
    assert.match(await text(`${DETAIL} #quota-model-timeline .ms-head`), /按天 \/ 按 7 天.*经过这个号池转发的请求/);
    assert.equal(await evaluate(`document.querySelector('${DETAIL} #quota-model-timeline .ms-cycle.five .ms-cycle-title b').textContent`), '单日');
    assert.match(await text(`${DETAIL} #quota-model-timeline .ms-cycle.week .ms-cycle-stats`), /号池用了/);
    assert.ok(await evaluate(`[...document.querySelectorAll('${DETAIL} #quota-model-timeline .ms-cycle.week .ms-lane-name')].some(t => t.textContent === '成员平均已用')`));
    assert.ok(await evaluate(`document.querySelector('${DETAIL} #quota-model-timeline .ms-cycle.week .ms-quota-line')`), '有曲线');
    assert.equal(await evaluate(`document.querySelectorAll('${DETAIL} #quota-model-timeline .ms-off-lane').length`), 0);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${DETAIL} #quota-model-timeline .ms-cycle.week .ms-lane:not(.ms-off-lane) .ms-lane-name')].map(t => t.firstChild.textContent).sort()`), ['claude-opus-5', 'claude-sonnet-5', 'claude-sonnet-5'].sort());
    pass('the timeline moves into the pool page: by day and 7 days, members\' average weekly used curve, no off-machine lane');

    // 速度、模型、请求
    await until(`document.querySelector('${DETAIL} .speed-panel .speed-plot')`);
    assert.match(await text(`${DETAIL} .speed-panel .section-tag`), /号池 · 主力号池/);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${DETAIL} .pq-models .rank-name')].map(n => n.textContent)`), ['claude-opus-5 · max', 'claude-sonnet-5 · high', 'claude-sonnet-5 · medium'], '按 Token 从多到少：opus 2 × 5000，sonnet high 1200 + 2200 + 3200');
    assert.equal(await evaluate(`document.querySelectorAll('${DETAIL} .pq-req:not(.head)').length`), 7);
    assert.match(await text(`${DETAIL} .pq-req:nth-child(2)`), /Key K.*成功 · 第 2 次/);
    assert.match(await text(`${DETAIL} .pq-req:nth-child(3)`), /qa-b@example\.com.*限流 429/);
    await shot('1-page');
    // 截下半部分：窗口在后台时滚动后截不到新画面，临时把目标前面的卡片藏起来
    if (shots) for (const [name, sel] of [['2-members', '.pq-members'], ['3-timeline', '#quota-model-timeline'], ['4-models', '.pq-models']]) {
      await evaluate(`(() => { const host = document.querySelector('${DETAIL}'), target = host.querySelector('${sel}'); for (const node of host.children) node.hidden = node !== target && !!(node.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING); })()`);
      await shot(name);
      await evaluate(`for (const node of document.querySelector('${DETAIL}').children) node.hidden = false`);
    }
    pass('speed, models and recent requests (including the switch after a 429) are listed');

    // 编辑布局：号池的卡片都有布局标记
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${DETAIL} [data-layout^="quota:pool-"]')].map(n => n.dataset.layout).sort()`),
      ['quota:pool-daily', 'quota:pool-hourly', 'quota:pool-members', 'quota:pool-models', 'quota:pool-quota', 'quota:pool-requests', 'quota:pool-usage']);
    pass('every pool card can be hidden in layout editing');

    // 只有官方账号成员的另一个号池、拖动排序（只记在本机）
    await evaluate(`saveQuotaTabOrder('pool', ['pool:${otherId}', 'pool:${poolId}'])`);
    await until(`document.querySelector('${TABS}').dataset.account === 'pool:${otherId}'`);
    assert.deepEqual(await tabTexts(), ['号池备用号池', '号池主力号池']);
    assert.deepEqual(JSON.parse(await evaluate("localStorage.getItem('tokenpulse-pool-tabs')")), [otherId, poolId]);
    assert.deepEqual(sw.agentView().providers.filter(p => p.pool).map(p => p.id), [poolId, otherId], '供应商页的顺序不动');
    pass('pool tabs can be reordered; the order is kept on this computer only');

    // 切回官方账号：恢复原样
    await evaluate("document.querySelector('#account-tabs button:not([data-pool]):not([data-deepseek])').click()");
    await until("!document.getElementById('page-quota').classList.contains('pool-mode')");
    assert.equal(await evaluate(`document.querySelectorAll('${DETAIL} .pq-quota').length`), 0);
    pass('switching back to an official account restores the normal page');

    console.log('pool quota UI checks passed');
    clearTimeout(watchdog); app.exit(0);
  } catch (e) { console.error('FAIL', e.message); clearTimeout(watchdog); app.exit(1); }
}));
function pass(name) { console.log('PASS ' + name); }
app.on('will-quit', () => { try { sw.releaseAgentSwitch(); } catch { /* 已经释放了 */ } try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 进程还占着就留给系统清 */ } });
require(path.join(appRoot, 'build/main/index.js'));
