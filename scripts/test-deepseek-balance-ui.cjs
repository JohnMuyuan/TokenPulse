/*
 * DeepSeek 余额监控的界面（0.3.42，renderer/deepseek-balance.js）。
 * 余额接口用本机的假服务器（TOKENPULSE_DEEPSEEK_BASE），Key 是测试用的假 Key；不联网、不碰真实的 ~/.tokenpulse 和 ~/.dsh。
 * 走一遍：装过 DeepSeek Harness 没填 Key 时的入口（总览一条 + 额度详情一个标签）→ 填错 / 无效 Key 的提示 →
 * 加第一个账号：额度详情顶上有它自己的标签，点进去只有余额（没有额度窗口、容量排行、时间线），别的账号那一页里没有 DeepSeek →
 * 加第二个账号：两个标签各一页，总览列出两行 → 低于提醒线变色 → 接口出错时保留之前的余额 → 改名 / 删除一个账号。
 * 账号页的其余部分（消耗、预测、本机用量、消耗趋势、24 小时用量、余额走势、时间线、速度、模型换算）用写进临时目录的
 * 余额历史和 DeepSeek Harness 流水来验证：数字都是这里编的，能手算出来。
 * TOKENPULSE_SHOT_DIR 设了的话顺便截几张图（只有测试数据）。
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), http = require('node:http'), os = require('node:os'), path = require('node:path');
const { app } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-dsbal-ui-'));
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) delete process.env[key];
app.setPath('userData', path.join(root, 'electron')); app.commandLine.appendSwitch('lang', 'zh-CN');
const appRoot = process.env.TOKENPULSE_TEST_APP || path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'data'), { recursive: true }); fs.mkdirSync(path.join(root, 'home', '.dsh'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'prefs.json'), JSON.stringify({ seenVersion: require(path.join(appRoot, 'package.json')).version, onboarding: 'done' }));
require(path.join(appRoot, 'build/core/quota.js')).fetchOfficialQuota = async () => ({});
const shots = process.env.TOKENPULSE_SHOT_DIR;
/*
 * 编的数据。余额（元）：9 天前 68.00，一路往下，4 天前充了 50，40 分钟前到 110.00（和假服务器现在回的一样）。
 * 每次减少之前本机有 6 条请求（参考费用 = 减少的钱 ÷ 7.14），只有 5 天前（0.8）和 26 小时前（0.7）那两次本机没有请求。
 * 所以：最近 7 天花了 6.50，30 天 8.00；本机 6.50，本机以外 1.50；折算率 7.14；日均 6.5 ÷ 7，110 ÷ 它 ≈ 118 天。
 */
const NOW = Date.now(), H = 3600000, D = 24 * H;
const STEPS = [[9 * D, 68.0, false], [8 * D, 66.5, true], [6 * D, 64.0, true], [5 * D, 63.2, false], [4 * D, 113.2, false], [3 * D, 112.4, true], [2 * D, 111.9, true], [26 * H, 111.2, false], [5 * H, 110.9, true], [3 * H, 110.4, true], [40 * 60000, 110.0, true]];
const seedHistory = id => fs.writeFileSync(path.join(root, 'data', 'deepseek-balance-history.json'), JSON.stringify({ v: 1, accounts: { [id]: STEPS.map(([ago, total]) => [NOW - ago, 'CNY', total, 10, Math.round((total - 10) * 100) / 100]) } }));
{
  const byMonth = new Map();
  STEPS.forEach(([ago, total, local], i) => {
    if (!local) return;
    const drop = STEPS[i - 1][1] - total;
    for (let n = 0; n < 6; n++) {
      const at = NOW - ago - 20 * 60000 - (5 - n) * 180000, day = new Date(at), month = day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0');
      const pro = i === 2;
      const record = { id: 'seed-' + i + '-' + n, at, kind: 'deepseek-harness', file: path.join(root, 'home', '.dsh', 'sessions', 'demo', 'session-' + i, 'session.v4.jsonl.zstd'), cwd: 'D:\\demo', model: pro ? 'DeepSeek-V4-Pro' : 'DeepSeek-V4.1-Flash', effort: pro ? 'max' : 'high',
        requested: pro ? 'DeepSeek-V4-Pro' : 'DeepSeek-V4.1-Flash', input: 60000, output: 900, cacheRead: 50000, cacheWrite: 0, reasoning: 0, costUsd: drop / 7.14 / 6, calls: 1, timing: { stream: true, firstTokenMs: 1500 + n * 60, tokensPerSec: (pro ? 80 : 170) + n * 6 + i } };
      byMonth.set(month, [...(byMonth.get(month) || []), JSON.stringify(record)]);
    }
  });
  fs.mkdirSync(path.join(root, 'data', 'requests'), { recursive: true });
  for (const [month, lines] of byMonth) fs.writeFileSync(path.join(root, 'data', 'requests', month + '.jsonl'), lines.join('\n') + '\n');
}
const ONE = 'sk-' + 'test'.repeat(7) + '9z8y', TWO = 'sk-' + 'demo'.repeat(7) + '4k2m', BAD = 'sk-' + 'wrong'.repeat(6);
const totals = { [ONE]: '110.00', [TWO]: '23.40' };
const RELAY = 'rk_' + 'relaykey'.repeat(4) + 'x7q2';
let broken = false, hits = 0;
const server = http.createServer((request, response) => {
  hits++;
  // 同一个假服务器也当一个 sub2api 的中转站：/v1/usage 认 RELAY 这个 Key，回一份带额度、限速窗口和每天用量的数据
  if (request.method === 'GET' && request.url.startsWith('/v1/usage')) {
    if (String(request.headers.authorization || '') !== 'Bearer ' + RELAY) { response.writeHead(401, { 'content-type': 'application/json' }).end('{}'); return; }
    const day = ago => { const d = new Date(Date.now() - ago * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'quota_limited', isValid: true, status: 'active', remaining: 37.5, unit: 'USD', quota: { limit: 50, used: 12.5, remaining: 37.5, unit: 'USD' },
      rate_limits: [{ window: '5h', limit: 10, used: 4, remaining: 6, reset_at: new Date(Date.now() + 2 * 3600000).toISOString() }, { window: '7d', limit: 30, used: 28.5, remaining: 1.5 }], expires_at: new Date(Date.now() + 40 * 86400000).toISOString(),
      usage: { today: { requests: 12, total_tokens: 345000, cost: 1.5, actual_cost: 1.25 }, total: { requests: 480, total_tokens: 9800000, cost: 15, actual_cost: 12.5 } },
      daily_usage: [6, 5, 4, 3, 2, 1, 0].map(ago => ({ date: day(ago), requests: 10 + ago, total_tokens: 100000 * (8 - ago), cost: 1, actual_cost: 0.5 + ago / 10 })) }));
    return;
  }
  if (request.url !== '/user/balance' || request.method !== 'GET') { response.writeHead(404).end(); return; }
  if (broken) { response.writeHead(503).end('down'); return; }
  const total = totals[String(request.headers.authorization || '').replace(/^Bearer /, '')];
  if (!total) { response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"Authentication Fails"}}'); return; }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: total, granted_balance: '10.00', topped_up_balance: (Number(total) - 10).toFixed(2) }] }));
});
const watchdog = setTimeout(() => { console.error('FAIL deepseek balance UI timed out'); app.exit(1); }, 330000);

app.on('web-contents-created', (_, contents) => contents.once('did-finish-load', async () => {
  const evaluate = code => contents.executeJavaScript(code).catch(e => { throw new Error(e.message + ' ← ' + String(code).slice(0, 160)); }), delay = ms => new Promise(r => setTimeout(r, ms));
  const until = async (code, ms = 15000) => { const end = Date.now() + ms; while (!await evaluate('Promise.resolve(' + code + ').then(v=>!!v)')) { assert.ok(Date.now() < end, 'Timed out: ' + code); await delay(80); } };
  const click = sel => evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const text = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
  const fill = (name, value) => evaluate(`(() => { const input = document.querySelector('#ds-balance-dialog [name="${name}"]'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const shot = async name => { if (!shots) return; await delay(450); fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, 'deepseek-balance-' + name + '.png'), (await contents.capturePage()).toPNG()); };
  const STRIP = '#page-overview [data-ds-balance]', TABS = '#account-tabs button[data-deepseek]', DETAIL = '#quota-detail';
  const tabTexts = () => evaluate(`[...document.querySelectorAll('${TABS}')].map(b => b.textContent.replace(/\\s+/g, ' ').trim())`);
  const saved = () => { try { return fs.readFileSync(path.join(root, 'data', 'deepseek-balance.json'), 'utf8'); } catch { return ''; } };
  try {
    await until("document.querySelector('#tiles')");
    // 装过 DeepSeek Harness（~/.dsh 存在）但没填 Key：总览一条介绍，额度详情一个空标签
    await until(`document.querySelector('${STRIP}')`);
    assert.match(await text(STRIP), /DeepSeek\s*按量付费\s*还没填 Key.*DeepSeek 余额监控.*没有订阅额度.*填写 API Key/);
    // 和别家一样是「官方额度」那一排里的一张卡片，排在最后，用的是同一套卡片样式
    assert.deepEqual(await evaluate(`(() => { const card = document.querySelector('${STRIP}'), host = document.getElementById('quota-cards'); return [card.parentElement === host, host.lastElementChild === card, card.classList.contains('quota-card'), host.querySelectorAll('.quota-card').length >= 4, card.querySelector('.account-avatar.deepseek path').getAttribute('fill'), Math.abs(card.getBoundingClientRect().width - host.firstElementChild.getBoundingClientRect().width) < 2]; })()`), [true, true, true, true, '#4D6BFE', true]);
    assert.equal(await evaluate("document.querySelectorAll('[data-ds-balance]').length"), 1, '额度详情里不再有常驻的 DeepSeek 卡片');
    await evaluate("navigate('quota')");
    await until(`document.querySelectorAll('${TABS}').length === 1`);
    assert.deepEqual(await tabTexts(), ['DeepSeek']);
    assert.equal(await evaluate(`document.querySelector('${TABS} .brand-svg path').getAttribute('fill')`), '#4D6BFE', '标签上是 DeepSeek 的图标');
    assert.equal(await evaluate(`/DeepSeek/.test(document.querySelector('${DETAIL}').textContent)`), false, '别的账号那一页里没有 DeepSeek');
    assert.equal(await evaluate("document.getElementById('page-quota').classList.contains('ds-mode')"), false);
    await click(TABS);
    await until(`document.querySelector('${DETAIL} [data-action="ds-setup"]')`);
    assert.match(await text(DETAIL), /DeepSeek 余额监控.*有几个 DeepSeek 账号就可以填几个 Key/);
    assert.equal(await evaluate("getComputedStyle(document.getElementById('quota-model-study')).display"), 'none');
    await shot('1-empty-tab');
    pass('with DeepSeek Harness installed and no key: an intro strip on Overview and one DeepSeek tab in Quota details');

    await click(`${DETAIL} [data-action="ds-setup"]`);
    await until("document.getElementById('ds-balance-dialog')");
    assert.equal(await text('#ds-balance-title'), '添加 DeepSeek 账号');
    assert.equal(await evaluate("document.querySelector('#ds-balance-dialog [name=ds-balance-key]').type"), 'password');
    assert.equal(await evaluate("document.querySelector('#ds-balance-dialog [data-action=remove]')"), null);
    await click('#ds-balance-dialog [data-action="save"]');
    assert.equal(await text('.ds-balance-error'), '请先填 API Key');
    await fill('ds-balance-key', 'hello');
    await click('#ds-balance-dialog [data-action="save"]');
    assert.match(await text('.ds-balance-error'), /sk- 开头/);
    assert.equal(hits, 0, '格式不对的 Key 不会发出去');
    await fill('ds-balance-key', BAD);
    await click('#ds-balance-dialog [data-action="save"]');
    await until("document.querySelector('.ds-balance-error') && !document.querySelector('.ds-balance-error').hidden && /无效/.test(document.querySelector('.ds-balance-error').textContent)");
    assert.equal(await text('.ds-balance-error'), 'API Key 无效或已被删除，请换一个');
    assert.equal(saved().includes(BAD), false, '无效的 Key 没有被保存');
    await shot('2-invalid-key');
    pass('key format is checked locally; an invalid key is explained in the dialog and not kept');

    // 第一个账号：自己的标签，自己的一页
    await fill('ds-balance-key', ONE);
    await fill('ds-balance-label', '个人');
    await click('#ds-balance-dialog [data-action="save"]');
    await until("!document.getElementById('ds-balance-dialog')");
    await until(`/¥110\\.00/.test(document.querySelector('${DETAIL}').textContent)`);
    assert.deepEqual(await tabTexts(), ['DeepSeek个人']);
    assert.equal(await evaluate(`document.querySelector('${TABS}').classList.contains('on')`), true);
    assert.match(await text(DETAIL), /DeepSeek\s*个人.*按量付费，没有订阅额度窗口.*¥110\.00\s*总余额.*充值余额\s*¥100\.00.*赠送余额\s*¥10\.00.*没有设提醒线.*sk-…9z8y/);
    assert.equal(await evaluate(`/5 小时窗口|周额度窗口/.test(document.querySelector('${DETAIL}').textContent)`), false, 'DeepSeek 那一页没有 5 小时 / 周额度窗口');
    assert.equal(await evaluate(`document.querySelector('${DETAIL} .quota-context .account-avatar.deepseek path').getAttribute('fill')`), '#4D6BFE');
    assert.equal(await evaluate("getComputedStyle(document.getElementById('quota-model-study')).display"), 'none');
    assert.equal(await evaluate(`document.body.innerHTML.includes(${JSON.stringify(ONE)})`), false, '页面里没有 Key 本身');
    await shot('3-account-page');

    // 账号页的其余部分：写进余额历史（流水在启动前已经写好），等过了手动刷新的间隔再刷新一次
    const firstId = JSON.parse(saved()).accounts[0].id;
    assert.equal(JSON.parse(saved()).accounts[0].harness, true, '第一个账号默认就是本机 Harness 用的那个');
    seedHistory(firstId);
    await delay(5200);
    await click(`${DETAIL} [data-action="ds-refresh"]`);
    await until(`/¥6\\.50/.test(document.querySelector('${DETAIL} .ds-window')?.textContent || '')`, 30000);
    const windowText = await text(`${DETAIL} .ds-window`), localText = await text(`${DETAIL} .ds-local`);
    assert.match(windowText, /按最近 7 天的速度，大约还能用\s*118 天.*最近 7 天\s*¥6\.50.*最近 30 天\s*¥8\.00.*平均每天\s*¥0\.93.*还能用\s*118 天/);
    assert.match(localText, /本机用量\s*DeepSeek Harness.*最近 7 天有一部分是本机以外花的：\s*¥1\.50.*参考 1 美元实际扣\s*¥7\.14\s*按实际扣费校准.*本机花的\s*¥6\.50.*本机以外花的\s*¥1\.50/);
    // 最近 30 天：7 组 × 6 条 × 60,900 Tokens
    assert.match(localText, /最近 30 天\s*2,557,800/);
    // 余额记录是 9 天前开始的：只有那之后的天有柱子，更早的空着
    await until(`document.querySelectorAll('${DETAIL} .ds-trend .col').length === 10`);
    assert.equal(await evaluate(`document.querySelectorAll('${DETAIL} .ds-trend .ds-topup-dot').length`), 1, '充值的那一天有标记');
    assert.ok(await evaluate(`[...document.querySelectorAll('${DETAIL} .ds-trend .col')].filter(r => Number(r.getAttribute('height')) > 0).length`) >= 6);
    await click(`${DETAIL} .ds-trend [data-value="tokens"]`);
    await until(`/本机 DeepSeek Harness 每天用的 Tokens/.test(document.querySelector('${DETAIL} .ds-trend .sample-caption').textContent)`);
    await click(`${DETAIL} .ds-trend [data-value="spent"]`);
    assert.equal(await evaluate(`document.querySelectorAll('${DETAIL} .quota-history-grid .chart .col').length`), 24, '最近 24 小时用量');
    assert.ok(await evaluate(`document.querySelector('${DETAIL} .quota-history-grid .quota-trend .trend-line')?.getAttribute('d').length`) > 40, '余额走势');
    // 时间线：和官方账号用同一块，曲线是余额，没有「本机以外」的标注
    await until(`document.querySelectorAll('${DETAIL} #quota-model-timeline .ms-cycle').length === 2 && document.querySelector('${DETAIL} #quota-model-timeline .ms-cycle.week .ms-lane[data-key]')`, 30000);
    const timelineText = await text(`${DETAIL} #quota-model-timeline`);
    assert.match(timelineText, /模型与思考等级 · 时间线\s*按天 \/ 按 7 天.*上方曲线是这个账号的余额.*单日.*7 天/);
    assert.equal(/本机以外|官方/.test(timelineText), false, '时间线里没有官方额度那一套说法');
    assert.match(await text(`${DETAIL} #quota-model-timeline .ms-cycle.week`), /DeepSeek-V4\.1-Flash/);
    assert.equal(await evaluate(`document.querySelector('${DETAIL} #quota-model-timeline .ms-cycle.week .ms-lane-logo path').getAttribute('fill')`), '#4D6BFE');
    // 模型速度：从流水里的出字时间来，不提透明转发
    await until(`document.querySelectorAll('${DETAIL} .speed-panel .speed-row:not(.speed-axis)').length === 2`, 30000);
    const speedText = await text(`${DETAIL} .speed-panel`);
    assert.match(speedText, /模型速度\s*DeepSeek Harness.*自己在日志里记了每次回复的出字时间.*DeepSeek-V4\.1-Flash.*DeepSeek-V4-Pro/);
    assert.equal(/去打开透明转发/.test(speedText), false);
    // 换一种模型，余额能用多少：两个型号 × 高峰 / 闲时
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${DETAIL} .ds-models .ds-row')].map(r => r.dataset.model + '|' + r.dataset.period).sort()`), ['DeepSeek-V4-Pro|offpeak', 'DeepSeek-V4-Pro|peak', 'DeepSeek-V4.1-Flash|offpeak', 'DeepSeek-V4.1-Flash|peak']);
    const modelsText = await text(`${DETAIL} .ds-models`);
    assert.match(modelsText, /换一种模型，余额能用多少.*现在的余额\s*¥110\.00.*照现在的用法大约还能用.*按实际扣费校准\s*\$1 ≈ ¥7\.14/);
    assert.equal(await evaluate(`document.querySelector('${DETAIL} .ds-models .ds-row').dataset.period`), 'offpeak', '最耐用的是闲时');
    assert.ok(await evaluate(`[...document.querySelectorAll('${DETAIL} .ds-models .ds-row .ms-cap-num b')].every(b => b.textContent !== '—')`));
    if (shots) {
      for (const [name, sel] of [['3b-windows', '.quota-window-grid'], ['3c-trend', '.ds-trend'], ['3d-timeline', '#quota-model-timeline'], ['3e-speed', '.speed-panel'], ['3f-models', '.ds-models']]) {
        await evaluate(`document.querySelector('${DETAIL} ${sel}').scrollIntoView({ block: 'start' })`); await shot(name);
      }
      await evaluate("document.documentElement.dataset.theme = 'dark'");
      await evaluate(`document.querySelector('${DETAIL} .quota-window-grid').scrollIntoView({ block: 'start' })`); await shot('3g-windows-dark');
      await evaluate(`document.querySelector('${DETAIL} .ds-models').scrollIntoView({ block: 'start' })`); await shot('3h-models-dark');
      await evaluate("document.documentElement.dataset.theme = 'light'");
    }
    pass('the account page shows spend, forecast, local usage, trend, 24h usage, timeline, speed and what the balance buys per model');

    // 切到别的账号：那一页里没有 DeepSeek，容量排行回来了
    await click('#account-tabs button:not([data-deepseek])');
    await until("!document.getElementById('page-quota').classList.contains('ds-mode')");
    assert.equal(await evaluate(`/DeepSeek/.test(document.querySelector('${DETAIL}').textContent)`), false);
    assert.notEqual(await evaluate("getComputedStyle(document.getElementById('quota-model-study')).display"), 'none');
    pass('a DeepSeek account gets its own tab and page; pages of other accounts no longer contain a DeepSeek card');

    // 第二个账号：带提醒线，余额在线下面
    await click(TABS);
    await until(`document.querySelector('${DETAIL} [data-action="ds-add"]')`);
    await click(`${DETAIL} [data-action="ds-add"]`);
    await until("document.getElementById('ds-balance-dialog')");
    await fill('ds-balance-key', ONE);
    await click('#ds-balance-dialog [data-action="save"]');
    await until("!document.querySelector('.ds-balance-error').hidden");
    assert.equal(await text('.ds-balance-error'), '这个 API Key 已经添加过了');
    await fill('ds-balance-key', TWO);
    await fill('ds-balance-label', '公司');
    await fill('ds-balance-alert', '50');
    await click('#ds-balance-dialog [data-action="save"]');
    await until("!document.getElementById('ds-balance-dialog')");
    await until(`document.querySelectorAll('${TABS}').length === 2 && /¥23\\.40/.test(document.querySelector('${DETAIL}').textContent)`);
    assert.deepEqual(await tabTexts(), ['DeepSeek个人', 'DeepSeek公司']);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${TABS}')].map(b => b.classList.contains('on'))`), [false, true], '新加的账号直接选中');
    assert.match(await text(DETAIL), /DeepSeek\s*公司.*已低于提醒线\s*¥50\.00.*¥23\.40\s*总余额.*余额低于\s*¥50\.00\s*时提醒一次.*sk-…4k2m/);
    assert.equal(await evaluate(`document.querySelector('${DETAIL} .ds-window').classList.contains('low')`), true);
    // 第二个账号没有本机用量：说明算在哪个账号上，没有时间线和速度
    assert.match(await text(`${DETAIL} .ds-local`), /本机 DeepSeek Harness 的用量现在算在另一个账号上：\s*个人.*本机 Harness 用的是这个账号/);
    assert.equal(await evaluate(`document.querySelector('${DETAIL} .speed-panel')`), null);
    assert.equal(await evaluate("(() => { const node = document.getElementById('quota-model-timeline'); return !node || getComputedStyle(node).display === 'none'; })()"), true, '没有本机用量的账号下面不显示时间线');
    await shot('4-second-account-low');
    // 两个 DeepSeek 账号可以像官方账号一样拖动调整顺序：标签认得出是同一家，顺序存得下来，总览跟着变
    assert.equal(await evaluate("document.getElementById('account-tabs').dataset.scrollHint"), 'reorder');
    assert.deepEqual(await evaluate(`accountTabButtons('deepseek').map(b => b.dataset.account.startsWith('deepseek:'))`), [true, true]);
    const keys = await evaluate(`accountTabButtons('deepseek').map(b => b.dataset.account)`);
    await evaluate(`saveQuotaTabOrder('deepseek', ${JSON.stringify([...keys].reverse())})`);
    await until(`document.querySelector('${TABS}').textContent.includes('公司')`);
    assert.deepEqual(await tabTexts(), ['DeepSeek公司', 'DeepSeek个人']);
    assert.deepEqual(JSON.parse(saved()).accounts.map(a => a.label), ['公司', '个人']);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${TABS}')].map(b => b.classList.contains('on'))`), [true, false], '选中的还是原来那个账号');
    await evaluate(`saveQuotaTabOrder('deepseek', ${JSON.stringify(keys)})`);
    await until(`document.querySelector('${TABS}').textContent.includes('个人')`);
    assert.deepEqual(JSON.parse(saved()).accounts.map(a => [a.label, a.harness]), [['个人', true], ['公司', false]]);
    // 跨家拖动：把最后一个标签（DeepSeek 公司）拖到整行最前面，排到别家账号的前面；重画、重新打开额度详情之后还在那里
    const allTabs = () => evaluate("[...document.querySelectorAll('#account-tabs > button')].map(b => b.dataset.account)");
    const beforeDrag = await allTabs();
    assert.ok(beforeDrag.length >= 3 && !beforeDrag[0].startsWith('deepseek'), '一开始 DeepSeek 排在官方账号后面：' + beforeDrag.join(','));
    await evaluate(`(() => {
      const tabs = document.getElementById('account-tabs'), buttons = [...tabs.querySelectorAll(':scope > button')];
      const last = buttons.at(-1), from = last.getBoundingClientRect(), to = buttons[0].getBoundingClientRect();
      const pointer = (type, target, clientX) => target.dispatchEvent(new PointerEvent(type, { clientX, clientY: from.top + 8, button: 0, pointerId: 9, bubbles: true }));
      pointer('pointerdown', last, from.left + 10);
      pointer('pointermove', last, from.left - 30);
      pointer('pointermove', last, to.left - 40);
      pointer('pointerup', last, to.left - 40);
    })()`);
    const moved = [beforeDrag.at(-1), ...beforeDrag.slice(0, -1)];
    assert.deepEqual(await allTabs(), moved, 'DeepSeek 的账号拖到了别家账号的前面');
    // 公司越过了同一家的个人：DeepSeek 两个账号之间的先后也跟着变，存回账号列表
    const labels = () => JSON.parse(saved()).accounts.map(a => a.label).join(',');
    { const end = Date.now() + 8000; while (labels() !== '公司,个人') { assert.ok(Date.now() < end, '账号列表的顺序没有跟着变：' + labels()); await delay(80); } }
    await evaluate("renderQuota()");
    assert.deepEqual(await allTabs(), moved);
    await evaluate("navigate('overview')"); await evaluate("navigate('quota')");
    await until(`document.querySelectorAll('${TABS}').length === 2`);
    assert.deepEqual(await allTabs(), moved, '切走再回来还是拖完的排列');
    assert.deepEqual(await tabTexts(), ['DeepSeek公司', 'DeepSeek个人']);
    // 复原，后面的检查按原来的排列写的
    // tabDragged：拖完之后紧跟着的那次 click 会被吃掉，真实操作里下一次按下鼠标就清了；测试里的 click() 没有按下这一步，手动清
    await evaluate("tabDragged = false; localStorage.removeItem('tokenpulse-quota-tabs')");
    await evaluate(`saveQuotaTabOrder('deepseek', ${JSON.stringify(keys)})`);
    { const end = Date.now() + 8000; while (labels() !== '个人,公司') { assert.ok(Date.now() < end, '顺序没有复原'); await delay(80); } }
    await evaluate("renderQuota()");
    assert.deepEqual(await allTabs(), beforeDrag);
    await click(TABS);
    await until(`/¥110\\.00/.test(document.querySelector('${DETAIL}').textContent)`);
    assert.equal(await evaluate(`/¥23\\.40/.test(document.querySelector('${DETAIL}').textContent)`), false, '两个账号各一页，互不混在一起');
    pass('a second account gets its own tab and page; duplicates are refused; the low balance is highlighted');

    // 总览：一条里列出两个账号，点一行去那个账号的页
    await evaluate("navigate('overview')");
    // 卡片的主角是指定了本机用量的那个账号（个人），另一个排在下面的队列里
    await until(`document.querySelectorAll('${STRIP} .ds-balance-row').length === 1 && /¥6\\.50/.test(document.querySelector('${STRIP}').textContent)`, 30000);
    assert.match(await text(STRIP), /DeepSeek\s*个人\s*余额充足.*118\s*天.*总余额\s*¥110\.00\s*充值\s*¥100\.00 ·\s*赠送\s*¥10\.00.*最近 7 天花了\s*¥6\.50.*按这个速度还能用\s*118 天.*本机今天用了.*Tokens.*其他 DeepSeek 账号\s*2\s*个账号\s*公司\s*余额偏低\s*¥23\.40/);
    assert.ok(Number(await evaluate(`document.querySelector('${STRIP} .ring-value').getAttribute('stroke-dashoffset')`)) < 1, '能用 30 天以上：圆环画满');
    assert.equal(await evaluate(`document.querySelector('${STRIP}').classList.contains('low')`), true);
    await evaluate(`document.querySelector('${STRIP}').scrollIntoView({ block: 'center' })`);
    await shot('5-overview');
    await evaluate("document.documentElement.dataset.theme = 'dark'");
    await shot('6-overview-dark');
    await click(`${STRIP} .ds-balance-row.low`);
    await until(`!document.getElementById('page-quota').hidden && /公司/.test(document.querySelector('${DETAIL} .context-who')?.textContent || '')`);
    await shot('7-account-page-dark');
    await evaluate("document.documentElement.dataset.theme = 'light'");
    pass('Overview lists every account; clicking a row opens that account in Quota details');

    // 接口出错：保留之前的余额并说明
    broken = true;
    await delay(5200);
    await click(`${DETAIL} [data-action="ds-refresh"]`);
    await until(`/HTTP 503/.test(document.querySelector('${DETAIL}').textContent)`);
    assert.match(await text(DETAIL), /DeepSeek 返回了 HTTP 503.*下面显示的是之前查到的余额.*¥23\.40\s*总余额/);
    await shot('8-error');
    broken = false;
    pass('a failed query keeps the earlier balance and says why');

    // 设置一个账号：已保存的 Key 只显示后四位；改名；删除这个账号，另一个还在
    await click(`${DETAIL} [data-action="ds-settings"]`);
    await until("document.getElementById('ds-balance-dialog')");
    assert.equal(await text('#ds-balance-title'), '设置 DeepSeek 账号');
    assert.equal(await evaluate("document.querySelector('#ds-balance-dialog [name=ds-balance-key]').placeholder"), '已保存 sk-…4k2m，不换就留空');
    assert.deepEqual(await evaluate("['ds-balance-key','ds-balance-label','ds-balance-alert'].map(n => document.querySelector('#ds-balance-dialog [name=' + n + ']').value)"), ['', '公司', '50']);
    assert.equal(await evaluate("document.querySelector('#ds-balance-dialog [name=ds-balance-harness]').checked"), false, '第二个账号默认不算本机用量');
    await shot('9-settings');
    await fill('ds-balance-label', '团队');
    await click('#ds-balance-dialog [name=ds-balance-harness]');
    await click('#ds-balance-dialog [data-action="save"]');
    await until("!document.getElementById('ds-balance-dialog')");
    await until(`[...document.querySelectorAll('${TABS}')].some(b => /团队/.test(b.textContent))`);
    // 勾了「本机 Harness 用的是这个账号」：本机用量换到这个账号下面，原来那个账号取消
    await until(`document.querySelector('${DETAIL} .speed-panel')`);
    assert.deepEqual(JSON.parse(saved()).accounts.map(a => a.harness), [false, true]);
    assert.notEqual(await evaluate("getComputedStyle(document.getElementById('quota-model-timeline')).display"), 'none');
    await click(`${DETAIL} [data-action="ds-settings"]`);
    await until("document.getElementById('ds-balance-dialog')");
    await click('#ds-balance-dialog [data-action="remove"]');
    await until("!document.getElementById('ds-balance-dialog')");
    await until(`document.querySelectorAll('${TABS}').length === 1`);
    assert.deepEqual(await tabTexts(), ['DeepSeek个人']);
    await until(`/¥110\\.00/.test(document.querySelector('${DETAIL}').textContent)`);
    // 删掉的那个账号带着本机用量：剩下的账号不会自动接手，页面上给一个按钮
    await until(`document.querySelector('${DETAIL} [data-action="ds-own"]')`);
    assert.match(await text(`${DETAIL} .ds-local`), /现在没有算在任何账号上/);
    await click(`${DETAIL} [data-action="ds-own"]`);
    await until(`document.querySelector('${DETAIL} .speed-panel')`);
    assert.equal(JSON.parse(saved()).accounts[0].harness, true);
    assert.equal(fs.readFileSync(path.join(root, 'data', 'deepseek-balance-history.json'), 'utf8').includes(firstId), true);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'data', 'deepseek-balance-history.json'), 'utf8')).accounts).length, 1, '删掉的账号的余额历史也删了');
    assert.deepEqual([saved().includes(TWO), saved().includes(ONE)], [false, true]);
    assert.equal(await evaluate("!!document.getElementById('open-deepseek-balance')"), true);
    pass('an account can be renamed or deleted on its own; the saved key shows only its last four characters');

    // 第三方中转站的 Key：设置里的入口 → 填站点地址和 Key → 自己的标签、自己的一页、总览里自己的一张卡片
    const site = process.env.TOKENPULSE_DEEPSEEK_BASE;
    await evaluate("navigate('quota')");
    // 额度详情右上角的「添加账号」：三种账号的入口都在这里
    const menuTexts = () => evaluate("[...document.querySelectorAll('#option-menu .option-item b')].map(b => b.textContent)");
    await click('#quota-add-account');
    await until("!document.getElementById('option-menu').hidden");
    assert.deepEqual(await menuTexts(), ['ChatGPT / Claude / Grok 官方账号', 'DeepSeek', '第三方中转站的 Key']);
    assert.equal(await evaluate("(() => { const b = document.getElementById('quota-add-account').getBoundingClientRect(), bar = document.querySelector('.quota-toolbar').getBoundingClientRect(); return bar.right - b.right < 4 && b.width > 60; })()"), true, '按钮在这一行的最右边');
    await shot('9b-add-menu');
    await click('#option-menu .option-item[data-value="deepseek"]');
    await until("document.getElementById('ds-balance-dialog')");
    assert.equal(await text('#ds-balance-title'), '添加 DeepSeek 账号');
    await click('#ds-balance-dialog [data-action="cancel"]');
    await click('#quota-add-account');
    await until("!document.getElementById('option-menu').hidden");
    await click('#option-menu .option-item[data-value="official"]');
    await until("!document.getElementById('settings').hidden && document.querySelector('[data-settings-tab=accounts]').classList.contains('on')");
    assert.equal(await evaluate("document.querySelector('.settings-panel[data-panel=accounts]')?.hidden ?? null"), false, '设置直接开在「官方账号」那一栏');
    await click('#settings-close');
    await until("document.getElementById('settings').hidden");
    await click('#quota-add-account');
    await until("!document.getElementById('option-menu').hidden");
    await click('#option-menu .option-item[data-value="relay"]');
    await until("document.getElementById('ds-balance-dialog')");
    assert.equal(await text('#ds-balance-title'), '添加第三方 Key');
    assert.deepEqual(await evaluate("['ds-balance-url','ds-balance-harness'].map(n => { const node = document.querySelector('#ds-balance-dialog [name=' + n + ']'); return getComputedStyle(node.closest('label')).display !== 'none'; })"), [true, false], '中转站要填站点地址，没有「本机 Harness」那一项');
    await click('#ds-balance-dialog [data-kind-pick="deepseek"]');
    assert.equal(await text('#ds-balance-title'), '添加 DeepSeek 账号');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#ds-balance-dialog [name=ds-balance-url]').closest('label')).display"), 'none');
    await click('#ds-balance-dialog [data-kind-pick="relay"]');
    await fill('ds-balance-key', RELAY);
    await click('#ds-balance-dialog [data-action="save"]');
    assert.equal(await text('.ds-balance-error'), '请先填站点地址');
    await fill('ds-balance-url', 'http://example.com');
    await click('#ds-balance-dialog [data-action="save"]');
    await until("!document.querySelector('.ds-balance-error').hidden && /https/.test(document.querySelector('.ds-balance-error').textContent)");
    assert.match(await text('.ds-balance-error'), /站点地址要用 https/);
    await fill('ds-balance-url', site + '/v1/');
    await fill('ds-balance-key', 'rk_' + 'wrongkey'.repeat(4));
    await click('#ds-balance-dialog [data-action="save"]');
    await until("!document.querySelector('.ds-balance-error').hidden && /无效/.test(document.querySelector('.ds-balance-error').textContent)");
    await fill('ds-balance-key', RELAY);
    await fill('ds-balance-label', '我的中转站');
    await fill('ds-balance-alert', '40');
    // 图标：默认自动匹配（认不出来就用首字母），可以从预设里挑
    const LOOK = '#ds-balance-dialog .ds-balance-look';
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('${LOOK}')).display !== 'none' && document.querySelectorAll('${LOOK} .pv-avatar-tile').length > 10`), true, '第三方 Key 可以选图标');
    assert.match(await text(`${LOOK} .pv-avatar-now`), /图标\s*自动匹配：没认出来，先用首字母/);
    assert.equal(await evaluate(`document.querySelector('${LOOK} .pv-avatar-tile.on').dataset.icon`), '');
    const preset = await evaluate("window.PulseAvatars.PRESETS[0].id");
    await click(`${LOOK} .pv-avatar-tile[data-icon="${preset}"]`);
    assert.deepEqual(await evaluate(`[document.querySelector('${LOOK} .pv-avatar-tile.on').dataset.icon, !!document.querySelector('${LOOK} .pv-avatar-now img'), document.querySelector('${LOOK} .pv-avatar-now small').textContent === window.PulseAvatars.PRESETS[0].label]`), [preset, true, true]);
    await shot('9c-relay-dialog');
    await click('#ds-balance-dialog [data-action="save"]');
    await until("!document.getElementById('ds-balance-dialog')");
    await until(`document.querySelector('#account-tabs button[data-relay]')`);
    assert.equal(await evaluate("document.querySelector('#account-tabs button[data-relay]').textContent.replace(/\\s+/g, ' ').trim()"), '我的中转站');
    assert.deepEqual(await evaluate(`[document.querySelector('#account-tabs button[data-relay] .brand-glyph img')?.getAttribute('src') === window.PulseAvatars.PRESETS[0].src, document.querySelector('${DETAIL} .quota-context .account-avatar.relay img')?.getAttribute('src') === window.PulseAvatars.PRESETS[0].src]`), [true, true], '标签和页面上都是选的那个图标');
    assert.deepEqual(await evaluate("[document.querySelector('#account-tabs button[data-relay]').dataset.kind, document.querySelector('#account-tabs button[data-relay]').classList.contains('on')]"), ['relay', true], '新加的 Key 直接选中');
    await until(`/\\$37\\.50/.test(document.querySelector('${DETAIL}').textContent)`);
    const host = new URL(site).host;
    const relayText = await text(DETAIL);
    assert.match(relayText, /我的中转站.*第三方中转站的 Key.*已低于提醒线\s*\$40\.00.*余额.*\$37\.50\s*还能用的额度.*接口\s*sub2api.*这个 Key 在站点上\s*sub2api\s*\$1\.25\s*这个 Key 今天花了\s*12\s*次请求\s*345\.0K Tokens/);
    assert.match(relayText, /Key 总额度\s*\$12\.50 \/ \$50\.00.*5 小时\s*\$4\.00 \/ \$10\.00.*后重置.*7 天\s*\$28\.50 \/ \$30\.00.*这个 Key 累计.*\$12\.50.*480.*9,800,000.*到期时间/);
    assert.match(relayText, new RegExp('每天的用量 · 站点统计.*余额走势.*站点地址\\s*' + site.replace(/[.:/]/g, '\\$&') + '\\s*Key 只发给这个地址'));
    assert.equal(relayText.includes(host), true);
    assert.deepEqual(await evaluate(`[document.querySelectorAll('${DETAIL} .ds-limit').length, document.querySelectorAll('${DETAIL} .quota-history-grid .chart .col').length, document.querySelector('${DETAIL} .speed-panel'), document.querySelector('${DETAIL} .ds-models'), document.querySelector('${DETAIL} [data-window="7d"] .warn-text') !== null]`), [3, 7, null, null, true], '三条限额、七天的用量；没有速度和模型换算');
    assert.equal(await evaluate("(() => { const node = document.getElementById('quota-model-timeline'); return !node || getComputedStyle(node).display === 'none'; })()"), true);
    assert.equal(await evaluate(`document.body.innerHTML.includes(${JSON.stringify(RELAY)})`), false, '页面里没有 Key 本身');
    const stored = JSON.parse(saved()).accounts.find(a => a.kind === 'relay');
    assert.deepEqual([stored.baseUrl, stored.flavor, stored.label, stored.alertBelow, stored.harness, stored.icon], [site, 'sub2api', '我的中转站', 40, false, preset]);
    await shot('10-relay-page');
    await evaluate(`document.querySelector('${DETAIL} .ds-site').scrollIntoView({ block: 'center' })`); await shot('10b-relay-limits');
    // 设置里站点地址不能改
    await click(`${DETAIL} [data-action="ds-settings"]`);
    await until("document.getElementById('ds-balance-dialog')");
    assert.deepEqual(await evaluate("[document.getElementById('ds-balance-title').textContent, document.querySelector('#ds-balance-dialog [name=ds-balance-url]').disabled, document.querySelector('#ds-balance-dialog [name=ds-balance-url]').value, document.querySelector('#ds-balance-dialog .ds-balance-kind')]"), ['设置第三方 Key', true, site, null]);
    await shot('11-relay-settings');
    // 设置里换成首字母：标签上变回字母，存盘的也跟着变
    assert.equal(await evaluate("document.querySelector('#ds-balance-dialog .ds-balance-look .pv-avatar-tile.on').dataset.icon"), preset);
    await click('#ds-balance-dialog .ds-balance-look .pv-avatar-tile[data-icon="letter"]');
    await click('#ds-balance-dialog [data-action="save"]');
    await until("!document.getElementById('ds-balance-dialog')");
    await until("document.querySelector('#account-tabs button[data-relay] .brand-glyph.ds-letter')");
    assert.equal(await evaluate("document.querySelector('#account-tabs button[data-relay]').textContent.replace(/\\s+/g, ' ').trim()"), '我我的中转站');
    assert.equal(JSON.parse(saved()).accounts.find(a => a.kind === 'relay').icon, 'letter');
    await click(`${DETAIL} [data-action="ds-settings"]`);
    await until("document.getElementById('ds-balance-dialog')");
    await click(`#ds-balance-dialog .ds-balance-look .pv-avatar-tile[data-icon="${preset}"]`);
    await click('#ds-balance-dialog [data-action="save"]');
    await until("!document.getElementById('ds-balance-dialog')");
    await until("document.querySelector('#account-tabs button[data-relay] .brand-glyph img')");
    // 总览：DeepSeek 一张卡片，中转站另一张
    await evaluate("navigate('overview')");
    await until("document.querySelector('#quota-cards [data-ds-balance=relay]')");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#quota-cards [data-ds-balance]')].map(card => card.dataset.dsBalance)"), ['deepseek', 'relay']);
    assert.equal(await evaluate("document.querySelector('#quota-cards [data-ds-balance=relay] .account-avatar.relay img')?.getAttribute('src') === window.PulseAvatars.PRESETS[0].src"), true, '总览的卡片上也是选的图标');
    assert.match(await text('#quota-cards [data-ds-balance=relay]'), /我的中转站\s*第三方 Key\s*余额偏低.*余额\s*\$37\.50.*已低于提醒线\s*\$40\.00.*这个 Key 今天用了\s*345\.0K Tokens/);
    await evaluate("document.querySelector('#quota-cards [data-ds-balance=relay]').scrollIntoView({ block: 'center' })");
    await shot('12-relay-card');
    await click('#quota-cards [data-ds-balance=relay] [data-action="detail"]');
    await until(`!document.getElementById('page-quota').hidden && /我的中转站/.test(document.querySelector('${DETAIL} .quota-context')?.textContent || '')`);
    // 删掉之后标签和卡片都没了，DeepSeek 的还在
    await click(`${DETAIL} [data-action="ds-settings"]`);
    await until("document.getElementById('ds-balance-dialog')");
    await click('#ds-balance-dialog [data-action="remove"]');
    await until("!document.getElementById('ds-balance-dialog') && !document.querySelector('#account-tabs button[data-relay]')");
    assert.deepEqual([JSON.parse(saved()).accounts.map(a => a.kind), await tabTexts()], [['deepseek'], ['DeepSeek个人']]);
    pass('a third-party relay key gets its own tab, page (balance, key quota, rate-limit windows, site-reported usage) and Overview card');

    console.log('deepseek balance UI checks passed');
    clearTimeout(watchdog); server.close(); app.exit(0);
  } catch (e) { console.error('FAIL', e.message); clearTimeout(watchdog); server.close(); app.exit(1); }
}));
function pass(name) { console.log('PASS ' + name); }
app.on('will-quit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 进程还占着就留给系统清 */ } });
server.listen(0, '127.0.0.1', () => {
  process.env.TOKENPULSE_DEEPSEEK_BASE = 'http://127.0.0.1:' + server.address().port;
  require(path.join(appRoot, 'build/main/index.js'));
});
