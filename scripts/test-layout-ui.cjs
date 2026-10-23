/*
 * 编辑布局（0.3.43；0.3.49 重做）：侧栏页面、每张卡片（总览的官方额度按家拆开）、额度详情的账号标签都能单独隐藏，
 * 隐藏的在编辑时留在原处成虚线占位、点「显示」加回来；右边的布局面板按页面分组列出全部；卡片和页面能拖动 / 用方向键换位置；
 * 隐藏后能撤销；能按页 / 全部恢复默认；0.3.43 的旧设置能读。
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
const watchdog = setTimeout(() => { console.error('FAIL layout UI timed out'); app.exit(1); }, 60000);
const ORDER = ['overview', 'quota', 'usage', 'egress', 'concurrency', 'sessions', 'providers', 'health', 'pet'];
app.on('web-contents-created', (_event, wc) => wc.once('did-finish-load', async () => {
  const e = async code => { try { return await wc.executeJavaScript(code); } catch (error) { console.error('UI expression:', code); throw error; } };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async code => { const end = Date.now() + 8000; while (!await e(code)) { assert.ok(Date.now() < end, code); await pause(40); } };
  const frame = () => e('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const visible = "JSON.stringify([...document.querySelectorAll('#nav .nav-slot')].filter(s => !s.hidden).map(s => s.querySelector('[data-page]').dataset.page))";
  const card = key => `document.querySelector('[data-layout="${key}"]')`;
  const click = selector => e(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const edit = async on => { if (await e("document.documentElement.dataset.layoutEdit === 'on'") !== on) await click('#layout-edit'); await frame(); };
  const stored = () => e("JSON.parse(localStorage.getItem('tokenpulse-layout'))");
  try {
    await until("typeof navigate === 'function' && document.body.dataset.page === 'overview'");
    await until(`${card('overview:quota:claude')} && ${card('overview:quota:grok')}`);
    assert.equal(await e(visible), JSON.stringify(ORDER), '默认九个页面都在（0.3.61 加了桌宠）');
    assert.equal(await e(`getComputedStyle(${card('overview:trend')}.querySelector('.layout-tools')).display`), 'none', '没进编辑时不出现工具条');
    assert.equal(await e("document.getElementById('layout-add')"), null, '旧的「添加」菜单没有了');

    // 进编辑：右边出面板，每张卡片和侧栏每一页都有把手 + 隐藏
    await edit(true);
    assert.equal(await e("document.getElementById('layout-panel').hidden"), false);
    assert.equal(await e(`getComputedStyle(${card('overview:quota:claude')}.querySelector('.layout-tools')).display`), 'flex', '官方额度每一家一张卡，各有工具条');
    assert.equal(await e("document.querySelectorAll('#nav .nav-slot > .layout-tools [data-layout-grip]').length"), ORDER.length);
    const regions = await e("[...document.querySelectorAll('#layout-panel .layout-group')].slice(0, 2).map(g => [g.querySelector('h3').textContent, ...[...g.querySelectorAll('.layout-region')].map(r => r.textContent)])");
    assert.deepEqual(regions, [['侧栏页面'], ['总览', '官方额度', '统计小卡', '图表']], '面板按页面、区域分组');

    // 官方额度里单独藏一家：编辑时原处是占位条，退出编辑才真的不见；别的家不受影响
    await click('[data-layout-hide="overview:quota:grok"]');
    await frame();
    assert.equal(await e(`${card('overview:quota:grok')}.classList.contains('layout-ghost')`), true);
    assert.equal(await e(`${card('overview:quota:grok')}.hidden`), false);
    assert.match(await e(`${card('overview:quota:grok')}.querySelector('.layout-ghost-bar').textContent`), /已隐藏：Grok 额度/);
    await until("document.querySelector('.tp-toast')?.textContent.includes('已隐藏「Grok 额度」')");
    await edit(false);
    assert.equal(await e(`${card('overview:quota:grok')}.hidden`), true);
    assert.equal(await e(`${card('overview:quota:claude')}.hidden`), false);
    // 原处加回来
    await edit(true);
    await click('[data-layout-show="overview:quota:grok"]');
    await frame();
    assert.equal(await e(`${card('overview:quota:grok')}.classList.contains('layout-ghost')`), false);
    pass('each provider quota card on the overview hides on its own; edit mode leaves a placeholder that brings it back in place');

    // 撤销
    await click('[data-layout-hide="overview:trend"]');
    await until("[...document.querySelectorAll('.tp-toast button')].some(b => b.textContent === '撤销')");
    await e("[...document.querySelectorAll('.tp-toast button')].find(b => b.textContent === '撤销').click()");
    await frame();
    assert.equal(await e(`${card('overview:trend')}.classList.contains('layout-ghost')`), false, '撤销后回来');
    pass('hiding from the page offers undo');

    // 侧栏：藏一页，编辑时是占位、退出才不见；不能把最后一页也藏了
    await click('#nav [data-layout-hide="nav:egress"]');
    await frame();
    assert.equal(await e("document.querySelector('#nav [data-page=egress]').closest('.nav-slot').classList.contains('layout-ghost')"), true);
    await edit(false);
    assert.equal(await e(visible), JSON.stringify(ORDER.filter(id => id !== 'egress')));
    assert.equal(await e("document.body.dataset.page"), 'overview');
    await edit(true);
    await click('#nav [data-layout-show="nav:egress"]');
    await frame();
    assert.equal(await e(visible), JSON.stringify(ORDER), '加回原来的位置');
    for (const page of ORDER.slice(1)) await click(`#nav [data-layout-hide="nav:${page}"]`);
    await click('#nav [data-layout-hide="nav:overview"]');
    await until("document.querySelector('.tp-toast')?.textContent.includes('侧栏至少要留一个页面')");
    await edit(false);
    assert.equal(await e(visible), JSON.stringify(['overview']));
    await edit(true);
    for (const page of ORDER.slice(1)) await e(`document.querySelector('#layout-panel [data-layout-toggle="nav:${page}"]').click()`);
    await frame();
    await edit(false);
    assert.equal(await e(visible), JSON.stringify(ORDER), '面板里的开关也能加回来');
    pass('sidebar pages hide with an in-place placeholder, come back in their original slot, the last page cannot be hidden, and the panel switches work');

    // 拖动 / 方向键换位置：侧栏、统计小卡
    await edit(true);
    await e("document.querySelector('#nav [data-layout-grip=\"nav:providers\"]').focus()");
    for (let i = 0; i < 6; i++) await e("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))");
    await frame();
    assert.equal(await e(visible), JSON.stringify(['providers', ...ORDER.slice(0, 6), 'health', 'pet']), '方向键把供应商挪到最上面');
    await e("document.getElementById('tiles').scrollIntoView({ block: 'center', behavior: 'instant' })");
    await frame();
    const grip = await e("(() => { const r = document.querySelector('#tiles [data-layout-grip=\"overview:cache\"]').getBoundingClientRect(); const t = document.querySelector('[data-layout=\"overview:tokens\"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, tx: t.left + 8, ty: t.top + t.height / 2 }; })()");
    wc.sendInputEvent({ type: 'mouseDown', x: Math.round(grip.x), y: Math.round(grip.y), button: 'left', clickCount: 1 });
    for (let i = 1; i <= 6; i++) { wc.sendInputEvent({ type: 'mouseMove', x: Math.round(grip.x + (grip.tx - grip.x) * i / 6), y: Math.round(grip.y + (grip.ty - grip.y) * i / 6), button: 'left' }); await pause(30); }
    wc.sendInputEvent({ type: 'mouseUp', x: Math.round(grip.tx), y: Math.round(grip.ty), button: 'left', clickCount: 1 });
    await frame();
    const tiles = () => e("[...document.querySelectorAll('#tiles > [data-layout]')].map(n => n.dataset.layout)");
    assert.equal((await tiles())[0], 'overview:cache', '拖动把缓存读取挪到第一张 ' + JSON.stringify(grip) + ' ' + await e('innerWidth + "x" + innerHeight'));
    pass('cards and sidebar pages reorder by dragging the handle or with arrow keys');

    // 面板：按页恢复默认（只动这一页，不动侧栏）
    await e("document.querySelector('#layout-panel [data-layout-toggle=\"overview:sources\"]').click()");
    await frame();
    assert.equal(await e(`${card('overview:sources')}.classList.contains('layout-ghost')`), true);
    await e("document.querySelector('#layout-panel [data-layout-reset=\"overview\"]').click()");
    await frame();
    assert.equal(await e(`${card('overview:sources')}.classList.contains('layout-ghost')`), false);
    assert.equal((await tiles())[0], 'overview:tokens', '这一页的顺序也恢复');
    assert.equal(await e(visible), JSON.stringify(['providers', ...ORDER.slice(0, 6), 'health', 'pet']), '按页恢复不动侧栏');
    pass('the panel resets one page without touching the sidebar order');

    // 额度详情的账号标签：能藏；退出编辑后选中的那个被藏了就换到别的；最后一个不能藏
    await e("navigate('quota')");
    await until("document.querySelectorAll('#account-tabs > button').length === 3 && document.querySelectorAll('#account-tabs .tab-layout').length === 3");
    const first = await e("document.querySelector('#account-tabs > button.on').dataset.account");
    await e(`document.querySelector('#account-tabs [data-tab-toggle="${first}"]').click()`);
    await until(`document.querySelector('#account-tabs > button[data-account="${first}"]').classList.contains('tab-ghost')`);
    await edit(false);
    await until(`!document.querySelector('#account-tabs > button[data-account="${first}"]') && document.querySelectorAll('#account-tabs > button').length === 2`);
    assert.notEqual(await e("document.querySelector('#account-tabs > button.on')?.dataset.account"), first, '选中的标签藏了，换到下一个');
    await edit(true);
    const regionNames = await e("[...document.querySelectorAll('#layout-panel .layout-group')].find(g => g.querySelector('h3').textContent === '额度详情').textContent");
    assert.match(regionNames, /账号标签/);
    const rest = await e("[...document.querySelectorAll('#account-tabs > button:not(.tab-ghost)')].map(b => b.dataset.account)");
    await e(`document.querySelector('#account-tabs [data-tab-toggle="${rest[0]}"]').click()`);
    await frame();
    await e(`document.querySelector('#account-tabs [data-tab-toggle="${rest[1]}"]').click()`);
    await until("document.querySelector('.tp-toast')?.textContent.includes('至少要留一个账号标签')");
    pass('quota account tabs hide individually, the selected one moves on, the last one stays');

    // 记住：刷新后藏的、排的都还在；编辑状态不记
    await e("document.querySelector('#layout-panel [data-layout-reset=\"quota\"]').click()");
    await e("navigate('overview')");
    await click('[data-layout-hide="overview:rhythm"]');
    await edit(false);
    assert.equal((await stored()).v, 2);
    const loaded = new Promise(resolve => wc.once('did-finish-load', resolve));
    wc.reload();
    await loaded;
    await until(`typeof navigate === 'function' && ${card('overview:rhythm')}`);
    assert.equal(await e("document.documentElement.hasAttribute('data-layout-edit')"), false, '编辑状态不记住');
    assert.equal(await e(`${card('overview:rhythm')}.hidden`), true);
    assert.equal(await e(visible), JSON.stringify(['providers', ...ORDER.slice(0, 6), 'health', 'pet']));
    pass('hidden items and order survive a reload; edit mode does not');

    // 0.3.43 的旧设置：「官方额度」整块藏 = 每家都藏
    await e("localStorage.setItem('tokenpulse-layout', JSON.stringify({ hiddenNav: ['egress'], hiddenCards: ['quota', 'trend'] }))");
    const legacy = new Promise(resolve => wc.once('did-finish-load', resolve));
    wc.reload();
    await legacy;
    await until(`typeof navigate === 'function' && ${card('overview:quota:claude')}`);
    assert.equal(await e(`['claude', 'chatgpt', 'grok'].every(k => document.querySelector('[data-layout="overview:quota:' + k + '"]').hidden)`), true);
    assert.equal(await e("document.getElementById('page-overview').hidden"), true, '每家都藏了，官方额度这一块也收起');
    assert.equal(await e(`${card('overview:trend')}.hidden`), true);
    assert.equal(await e(visible), JSON.stringify(ORDER.filter(id => id !== 'egress')));
    // 全部恢复默认
    await edit(true);
    await e("document.querySelector('#layout-panel [data-layout-reset=\"\"]').click()");
    await edit(false);
    assert.equal(await e(visible), JSON.stringify(ORDER));
    assert.equal(await e("document.getElementById('page-overview').hidden"), false);
    pass('0.3.43 settings are read (whole official quota block = every provider); reset everything restores defaults');

    const english = new Promise(resolve => wc.once('did-finish-load', resolve));
    await e("PulseI18n.setMode('en')");
    await english;
    await until("document.getElementById('layout-edit').textContent === 'Edit layout'");
    await click('#layout-edit');
    await until("document.querySelector('#layout-panel h2')?.textContent === 'Edit layout' && document.querySelector('#layout-panel .layout-group h3').textContent === 'Sidebar pages'");

    clearTimeout(watchdog);
    console.log(`PASS layout UI: ${checks} groups`);
    app.exit(0);
  } catch (error) {
    clearTimeout(watchdog);
    console.error('FAIL', error);
    app.exit(1);
  }
}));
let checks = 0;
function pass(name) { checks++; console.log('PASS layout UI: ' + name); }
require('../build/main/index.js');
