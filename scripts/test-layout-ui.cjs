/*
 * 0.3.43：侧栏页面和总览卡片可以在编辑布局里藏起来，再加回原来的位置。
 * 临时数据目录，不碰真实的 ~/.tokenpulse。
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { app } = require('electron');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-layout-ui-'));
process.env.TOKENPULSE_DATA_DIR = path.join(dir, 'data');
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(dir, 'home');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.AGENT_SWITCH_HOME, { recursive: true });
const version = require('../package.json').version;
fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'prefs.json'), JSON.stringify({ autoLaunch: false, autoUpdate: false, closeToTray: true, startMinimized: true, language: 'zh', notifyAt: 0, notifyMismatch: false, ccSwitch: false, seenVersion: version, onboarding: 'done', theme: 'light' }));
app.setPath('userData', path.join(dir, 'electron'));
app.commandLine.appendSwitch('lang', 'zh-CN');
process.argv.push('--hidden');
require('../build/core/quota.js').fetchOfficialQuota = async () => ({});
const watchdog = setTimeout(() => { console.error('FAIL layout UI timed out'); app.exit(1); }, 45000);
const ORDER = ['overview', 'quota', 'usage', 'egress', 'concurrency', 'sessions', 'providers'];
app.on('web-contents-created', (_event, wc) => wc.once('did-finish-load', async () => {
  const e = async code => { try { return await wc.executeJavaScript(code); } catch (error) { console.error('UI expression:', code); throw error; } };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async code => { const end = Date.now() + 8000; while (!await e(code)) { assert.ok(Date.now() < end, code); await pause(40); } };
  const visible = "JSON.stringify([...document.querySelectorAll('#nav .nav-slot')].filter(s => !s.hidden).map(s => s.querySelector('[data-page]').dataset.page))";
  try {
    await until("typeof navigate === 'function' && document.body.dataset.page === 'overview'");
    assert.equal(await e(visible), JSON.stringify(ORDER), '默认七个页面都在');
    assert.equal(await e("document.getElementById('layout-edit').getAttribute('aria-pressed')"), 'false');
    assert.equal(await e("getComputedStyle(document.querySelector('.layout-remove')).display"), 'none', '没进编辑时不出现删除');
    assert.equal(await e("document.querySelector('#settings-open .layout-remove, #sidebar-toggle .layout-remove')"), null);
    assert.equal(await e("document.getElementById('layout-add').hidden"), true);

    await e("document.getElementById('layout-edit').click()");
    assert.equal(await e("document.documentElement.dataset.layoutEdit"), 'on');
    assert.equal(await e("getComputedStyle(document.querySelector('[data-layout-id=egress].layout-remove')).display"), 'grid');
    await e("document.querySelector('[data-layout-remove=nav][data-layout-id=egress]').click()");
    assert.equal(await e("document.querySelector('#nav [data-page=egress]').closest('.nav-slot').hidden"), true);
    assert.equal(await e(visible), JSON.stringify(ORDER.filter(id => id !== 'egress')));
    assert.equal(await e("document.body.dataset.page"), 'overview', '藏掉别的页面时留在当前页');
    await e("document.querySelector('[data-layout-remove=card][data-layout-id=\"overview:trend\"]').click()");
    assert.equal(await e("document.querySelector('[data-layout=\"overview:trend\"]').hidden"), true);
    assert.equal(await e("document.querySelector('[data-layout=\"overview:rhythm\"]').hidden"), false);
    await e("document.querySelector('[data-layout-remove=card][data-layout-id=\"overview:tokens\"]').click()");
    assert.equal(await e("document.querySelector('[data-layout=\"overview:tokens\"]').hidden"), true, '总览的统计小卡可以单独藏');
    assert.equal(await e("document.querySelector('[data-layout=\"overview:cost\"]').hidden"), false);
    assert.equal(await e("document.getElementById('usage-filters').hidden"), false, '还有别的卡片在用时间范围');

    for (const id of ['overview:cost', 'overview:requests', 'overview:cache', 'overview:rhythm', 'overview:sources', 'overview:ranking']) await e(`document.querySelector('[data-layout-remove=card][data-layout-id="${id}"]').click()`);
    assert.equal(await e("document.getElementById('usage-filters').hidden"), true, '总览只剩官方额度时收起时间范围');
    assert.equal(await e("document.getElementById('page-overview').hidden"), false);
    assert.equal(await e("document.getElementById('overview-layout-empty').hidden"), true);
    await e("navigate('usage')");
    assert.equal(await e("document.getElementById('usage-summary').hidden"), false, '用量明细仍显示统计');
    assert.equal(await e("document.querySelector('#tiles .stat').hidden"), false, '总览藏起的小卡不跟着用量明细消失');
    assert.equal(await e("getComputedStyle(document.querySelector('[data-layout=\"usage:breakdown\"] > .layout-remove')).display"), 'grid', '用量明细的卡片也能删');
    assert.equal(await e("document.getElementById('usage-filters').hidden"), false);
    await e("navigate('overview')");
    assert.equal(await e("document.getElementById('usage-summary').hidden"), true, '总览上的统计仍然藏着');

    await e("document.getElementById('layout-add').click()");
    await until("!document.getElementById('option-menu').hidden");
    const menu = await e("[...document.querySelectorAll('#option-menu .option-menu-label, #option-menu .option-item')].map(n => n.textContent)");
    assert.deepEqual(menu, ['页面', '出口监控', '总览', '总 Tokens', '参考费用', '请求次数', '缓存读取占比', '用量趋势', '使用节奏', '工具分布', '模型用量排行']);
    await e("[...document.querySelectorAll('#option-menu .option-item')].find(n => n.textContent === '出口监控').click()");
    await until("document.getElementById('option-menu').hidden");
    assert.equal(await e(visible), JSON.stringify(ORDER), '加回原来的位置，不是接到末尾');

    await e("document.querySelector('[data-layout-remove=nav][data-layout-id=quota]').click()");
    assert.equal(await e("document.querySelector('[data-go=quota]').hidden"), true, '跳向已藏页面的按钮一起藏');
    await e("navigate('quota', { force: true })");
    assert.equal(await e("document.body.dataset.page"), 'quota');
    assert.equal(await e("document.getElementById('layout-hidden-note').hidden"), false);
    assert.equal(await e("document.querySelector('#nav [data-page=quota]').closest('.nav-slot').hidden"), true, '通知打开这一页时不自动加回侧栏');
    await e("document.getElementById('layout-restore-page').click()");
    assert.equal(await e("document.querySelector('#nav [data-page=quota]').closest('.nav-slot').hidden"), false);
    assert.equal(await e("document.getElementById('layout-hidden-note').hidden"), true);

    await e("navigate('quota')");
    assert.equal(await e("getComputedStyle(document.querySelector('[data-layout=\"quota:study\"] > .layout-remove')).display"), 'grid', '额度详情的卡片也能删');
    await e("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    assert.equal(await e("document.documentElement.hasAttribute('data-layout-edit')"), false);
    await e("document.getElementById('layout-edit').click()");
    await e("document.querySelector('[data-layout-remove=card][data-layout-id=\"quota:study\"]').click()");
    assert.equal(await e("document.getElementById('quota-model-study').hidden"), true);
    await e("navigate('overview')");
    assert.equal(await e("JSON.parse(localStorage.getItem('tokenpulse-layout')).hiddenCards.includes('overview:trend')"), true);

    const loaded = new Promise(resolve => wc.once('did-finish-load', resolve));
    wc.reload();
    await loaded;
    await until("typeof navigate === 'function' && document.body.dataset.page === 'overview'");
    assert.equal(await e("document.documentElement.hasAttribute('data-layout-edit')"), false, '编辑状态不记住');
    assert.equal(await e("document.querySelector('[data-layout=\"overview:trend\"]').hidden"), true, '刷新后卡片仍然藏着');
    assert.equal(await e("document.querySelector('#nav [data-page=egress]').closest('.nav-slot').hidden"), false);

    await e("document.getElementById('layout-edit').click()");
    for (const id of ORDER) await e(`document.querySelector('[data-layout-remove=nav][data-layout-id=${id}]').click()`);
    assert.equal(await e("document.getElementById('layout-empty').hidden"), false);
    assert.equal(await e("document.getElementById('page-title').textContent"), '侧栏是空的');
    await e("document.getElementById('layout-add').click()");
    await until("!document.getElementById('option-menu').hidden");
    await e("[...document.querySelectorAll('#option-menu .option-item')].find(n => n.textContent === '总览').click()");
    await until("document.body.dataset.page === 'overview' && document.getElementById('layout-empty').hidden");
    assert.equal(await e(visible), JSON.stringify(['overview']));

    const english = new Promise(resolve => wc.once('did-finish-load', resolve));
    await e("PulseI18n.setMode('en')");
    await english;
    await until("document.getElementById('layout-edit').textContent === 'Edit layout' && document.getElementById('layout-hidden-note').textContent.includes('Put back in the sidebar')");

    clearTimeout(watchdog);
    console.log('PASS layout UI: edit mode hides sidebar pages and overview cards, add restores original order, usage page keeps its totals, hidden-page notice, empty sidebar, reload, English');
    app.exit(0);
  } catch (error) {
    clearTimeout(watchdog);
    console.error('FAIL', error);
    app.exit(1);
  }
}));
require('../build/main/index.js');
