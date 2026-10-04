// Run with Electron. Quota requests deliberately stay pending while we exercise the real UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, ipcMain, nativeImage, dialog, BrowserWindow } = require('electron');
let failRequestQueries = false;
const registerHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => registerHandler(channel, channel === 'requests:query' ? (event, query) => {
  if (failRequestQueries) throw new Error('Simulated request query failure');
  return handler(event, query);
} : handler);
const appRoot = process.env.TOKENPULSE_TEST_APP || path.resolve(__dirname, '..');
let egressNow = Date.now(), egressIp = '203.0.113.10', egressRegion = 'US';
const egressNotifications = [], egressLookups = [];
const egressModule = require(path.join(appRoot, 'build/main/egress-monitor.js'));
const RealExitMonitor = egressModule.ExitMonitor;
egressModule.ExitMonitor = class extends RealExitMonitor {
  // IP 数据库查询也换成假的：测试不能把地址发给真实的第三方服务
  constructor(options) { super({ ...options, now: () => egressNow, notify: event => egressNotifications.push(event), probe: async (provider, host) => ({ provider, host, ip: egressIp, region: egressRegion, checkedAt: egressNow, latencyMs: 20 }), lookup: async ip => { egressLookups.push(ip); return { ip, fetchedAt: egressNow, countryCode: egressRegion, city: 'Testville', asn: 'AS64500', asName: 'TEST-NET', isp: 'Example ISP', type: 'hosting', sources: [{ id: 'proxycheck', name: 'proxycheck.io', url: 'https://proxycheck.io/threats/' + ip, ok: true, risk: 66, flags: { vpn: true, proxy: false } }, { id: 'ipapicom', name: 'ip-api.com', url: '', ok: true, flags: { hosting: true, proxy: false, mobile: false } }] }; } }); }
};
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-ui-'));
process.env.TOKENPULSE_DATA_DIR = path.join(temp, 'data');
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(temp, 'home');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
app.setPath('userData', path.join(temp, 'electron'));
// Synthetic rows are confined to the test data directory, never to the real ledger.
const fixtureNow = Date.now(), hour = 3600000;
const iso = at => new Date(at).toISOString();
const dayKey = require('../renderer/data.js').dayKey;
const dataPath = process.env.TOKENPULSE_DATA_DIR;
fs.mkdirSync(dataPath, { recursive: true });
// 老用户升级、看过这版说明：不弹「新版本有什么」和新手引导（这两样在 test-intro-ui.cjs 里单独测）
fs.writeFileSync(path.join(dataPath, 'prefs.json'), JSON.stringify({ seenVersion: require('../package.json').version, onboarding: 'done' }));
const modelRows = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`QA-model-${String(i).padStart(2, '0')}`, { input: 1000 + i, output: 100, cacheRead: 500, cacheWrite: 0, reasoning: 20, costUsd: 0.1, requests: 1 }]));
fs.writeFileSync(path.join(dataPath, 'usage-rollups.json'), JSON.stringify({ version: 1, files: { 'ui-test-fixture': { kind: 'codex', official: true, days: { [dayKey(fixtureNow)]: { 'Codex CLI': modelRows } } } } }));
fs.writeFileSync(path.join(dataPath, 'quota-history.json'), JSON.stringify({ version: 1, accounts: {
  chatgpt: Array.from({ length: 5 }, (_, i) => ({ at: fixtureNow - (4 - i) * hour, five: 20, fiveReset: iso(fixtureNow + 3 * hour), week: 46 + i, weekReset: iso(fixtureNow + 72 * hour), plan: 'plus', resetCredits: 1 })),
  grok: [{ at: fixtureNow - 2 * hour, week: 95, weekReset: iso(fixtureNow - hour) }]
} }));
// 请求流水：一条型号不一致、一条一致、一条 Codex（无法核验）。型号名带 QA 前缀，和真实会话区分开。
const requestMonth = (() => { const d = new Date(fixtureNow); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
fs.mkdirSync(path.join(dataPath, 'requests'), { recursive: true });
const qaRequest = (id, minutesAgo, extra) => ({ id, at: fixtureNow - minutesAgo * 60000, kind: 'claude-code', file: 'ui-test-claude', cwd: 'D:\\qa\\tp-ui-fixture', input: 1200, output: 80, cacheRead: 900, cacheWrite: 10, reasoning: 0, costUsd: 0, calls: 1, ...extra });
fs.writeFileSync(path.join(dataPath, 'requests', `${requestMonth}.jsonl`), [
  ...Object.entries(modelRows).map(([model, usage], i) => qaRequest('qa-model-' + i, 1, { ...usage, model, requested: model, kind: 'codex', file: 'ui-test-fixture', cwd: 'D:\\qa\\model-fixture' })),
  qaRequest('qa-1', 3, { model: 'claude-QA-sonnet', requested: 'claude-QA-opus[1m]', returned: 'claude-QA-sonnet', responseId: 'msg_01' + 'A'.repeat(22), requestId: 'req_011C' + 'B'.repeat(20) }),
  qaRequest('qa-2', 2, { model: 'claude-QA-opus', requested: 'claude-QA-opus[1m]', returned: 'claude-QA-opus', responseId: 'msg_01' + 'C'.repeat(22), requestId: 'req_011C' + 'D'.repeat(20) }),
  qaRequest('qa-3', 1, { kind: 'codex', file: 'ui-test-codex', model: 'gpt-QA', requested: 'gpt-QA', responseId: 'resp_' + 'e'.repeat(50) })
].map(row => JSON.stringify(row)).join('\n') + '\n');
const exportPath = path.join(temp, 'export.csv');
dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath });
let finishQuota;
let pendingQuota = true;
require(path.join(appRoot, 'build/core/quota.js')).fetchOfficialQuota = () => new Promise(resolve => {
  finishQuota = () => { pendingQuota = false; resolve({}); };
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let maxGap = 0;
let previous = Date.now();
const heartbeat = setInterval(() => {
  maxGap = Math.max(maxGap, Date.now() - previous);
  previous = Date.now();
}, 50);
const watchdog = setTimeout(() => { console.error('FAIL UI timed out'); app.exit(1); }, 30000);
app.on('web-contents-created', (_, contents) => {
  contents.on('did-finish-load', async () => {
    try {
      const evaluate = async code => { try { return await contents.executeJavaScript(code); } catch (error) { throw new Error(code + '\n' + error.message); } };
      const until = async (code) => {
        const deadline = Date.now() + 10000;
        while (!(await evaluate(code))) {
          assert.ok(Date.now() < deadline, `Timed out: ${code}`);
          await delay(50);
        }
      };
      await until("document.querySelectorAll('#tiles .stat').length === 4");
      assert.equal(pendingQuota, true, 'Local statistics must render before quota completes');
      console.log('PASS local statistics render while quota is pending');
      assert.match(await evaluate("document.getElementById('quota-cards').textContent"), /50.0/);
      assert.equal(await evaluate("document.querySelectorAll('.quota-card').length"), 3);
      assert.equal(await evaluate("document.querySelectorAll('.quota-card.chatgpt .ring-value').length"), 2);
      assert.equal(await evaluate("document.querySelectorAll('.quota-card.chatgpt .ring-value.ring-five').length"), 1);
      assert.equal(await evaluate("document.querySelectorAll('.quota-card.chatgpt .ring-value.ring-week').length"), 1);
      assert.equal(await evaluate("document.querySelectorAll('.quota-card.grok .ring-track').length"), 1);
      assert.doesNotMatch(await evaluate("document.getElementById('quota-cards').textContent"), /可能提前耗尽/);
      // 「已用」的预警橙色不能被标题行的样式盖掉
      await evaluate("document.querySelector('.quota-card .quota-mini-head').insertAdjacentHTML('beforeend', '<span class=\"mini-used\"><span class=\"num warn-text\" id=\"warn-probe\">x</span></span>')");
      assert.equal(await evaluate("getComputedStyle(document.getElementById('warn-probe')).color === getComputedStyle(document.documentElement).getPropertyValue('--warn').trim() || getComputedStyle(document.getElementById('warn-probe')).fontWeight === '600'"), true);
      await evaluate("document.getElementById('warn-probe').parentElement.remove()");
      assert.match(await evaluate("document.querySelectorAll('.quota-card')[2].textContent"), /等待新采样/);
      await evaluate("document.getElementById('settings-open').click()");
      await until("!document.getElementById('settings').hidden");
      // 设置按 AllAi 的布局：顶部标签页、每项「标题 + 说明 + 选择器」。
      assert.equal(await evaluate("document.querySelectorAll('#settings-tabs [data-settings-tab]').length"), 5);
      assert.equal(await evaluate("document.querySelector('[data-panel=general]').hidden"), false);
      assert.match(await evaluate("document.getElementById('pref-theme').textContent"), /日间|夜间|跟随系统/);
      await evaluate("document.getElementById('pref-notifyAt').click()");
      await until("!document.getElementById('option-menu').hidden");
      await evaluate("document.querySelector('#option-menu [data-value=\"90\"]').click()");
      // 0.3.9：保存成功改成右上角可关闭的提示，设置页底部那行不再插入成功文字
      await until("[...document.querySelectorAll('#toast-stack .tp-toast')].some(t => t.textContent.includes('设置已保存'))");
      assert.equal(await evaluate("document.getElementById('prefs-status').textContent"), '');
      assert.equal(await evaluate("getComputedStyle(document.querySelector('#toast-stack .tp-toast')).position"), 'relative', '进度线要贴在每条提示自己的底部');
      assert.equal(await evaluate("window.tokenpulse.readPrefs().then(p => p.notifyAt)"), 90);
      assert.match(await evaluate("document.getElementById('pref-notifyAt').textContent"), /90%/);
      await evaluate("document.querySelector('[data-settings-tab=accounts]').click()");
      assert.equal(await evaluate("document.querySelector('[data-panel=general]').hidden"), true);
      // 账号列表在设置窗口打开后才异步加载（要探测 CLI），先等它出来。
      await until("document.querySelectorAll('#official-accounts .oauth-card').length === 3");
      assert.match(await evaluate("document.getElementById('official-accounts').textContent"), /添加账号|未检测到官方 CLI/);
      // 0.3.18：「添加账号」有两种——用本机 CLI 已登录的（不保存凭据），或者登录一个新账号。主进程通道换成假的，不真的读 CLI、不真的登录
      if (await evaluate("Boolean(document.querySelector('#official-accounts [data-account-action=add]'))")) {
        const added = [];
        const realList = await evaluate("window.tokenpulse.officialAccounts ? window.tokenpulse.officialAccounts() : window.tokenpulse.listOfficialAccounts()");
        ipcMain.removeHandler('accounts:add-cli');
        ipcMain.handle('accounts:add-cli', (_event, kind) => { added.push(kind); if (added.length === 2) throw new Error('本机的 Claude CLI 还没有登录账号。请先在终端里用它的 CLI 登录，或者改用「登录一个新账号」。'); return { ok: true, added: 1, total: 1, statuses: realList }; });
        const kind = await evaluate("document.querySelector('#official-accounts [data-account-action=add]').dataset.accountKind");
        await evaluate("document.querySelector('#official-accounts [data-account-action=add]').click()");
        await until("!document.getElementById('option-menu').hidden");
        assert.deepEqual(await evaluate("[...document.querySelectorAll('#option-menu .option-item')].map(n => n.dataset.value + ':' + n.querySelector('b').textContent)"), ['add-cli:用本机 CLI 已登录的账号', 'login:登录一个新账号']);
        assert.match(await evaluate("document.querySelector('#option-menu .option-item[data-value=add-cli] small').textContent"), /不在 TokenPulse 里保存凭据/);
        await evaluate("document.querySelector('#option-menu .option-item[data-value=add-cli]').click()");
        await until("/已添加 CLI 登录的账号（不保存凭据）/.test(document.getElementById('prefs-status').textContent + [...document.querySelectorAll('#toast-stack .tp-toast')].map(t => t.textContent).join(' '))");
        assert.deepEqual(added, [kind]);
        // CLI 没登录：把原因告诉用户，列表不变
        await evaluate("document.querySelector('#official-accounts [data-account-action=add]').click()");
        await until("!document.getElementById('option-menu').hidden");
        await evaluate("document.querySelector('#option-menu .option-item[data-value=add-cli]').click()");
        await until("/CLI 还没有登录账号/.test(document.getElementById('prefs-status').textContent)");
        assert.equal(await evaluate("document.querySelectorAll('#official-accounts .oauth-card').length"), 3);
        assert.equal(await evaluate("document.querySelector('#official-accounts [data-account-action=add]').disabled"), false, '出错后按钮恢复可用');
        ipcMain.removeHandler('accounts:add-cli');
        console.log('PASS 0.3.18 add account menu: use the local CLI login (no credentials stored) or sign in, success and not-logged-in messages');
      }
      // 账号列表里不能出现凭据：字段名或 JWT 形状的值。不能只搜「token / refresh」这两个词 ——
      // 「完全删除 TokenPulse 记录」和重新授权按钮的 #i-refresh 图标本来就含这两个词，会误报
      assert.doesNotMatch(await evaluate("document.getElementById('official-accounts').innerHTML"), /access_?token|refresh_?token|id_?token|accessToken|refreshToken|\beyJ[\w-]{10,}/i);
      await evaluate("document.querySelector('[data-settings-tab=about]').click()");
      assert.ok((await evaluate("document.querySelector('.about-name').textContent")).includes('v' + require(path.join(appRoot, 'package.json')).version));
      // 软件更新区：开发环境不检查更新，要说明原因、不显示开关
      await until("document.getElementById('update-card').textContent.length > 0");
      assert.match(await evaluate("document.getElementById('update-card').textContent"), /当前版本 v\d+\.\d+\.\d+/);
      assert.match(await evaluate("document.getElementById('update-card').textContent"), /开发模式不检查更新/);
      assert.equal(await evaluate("document.getElementById('pref-autoUpdate')"), null);
      // 当前版本来自 package.json，不是 Electron 自己的版本号
      assert.ok((await evaluate("document.getElementById('update-card').textContent")).includes('v' + require(path.join(appRoot, 'package.json')).version));
      // 模型知识库：版本、规则数、检查按钮
      await until("document.getElementById('knowledge-card').textContent.includes('知识库 v')");
      assert.match(await evaluate("document.getElementById('knowledge-card').textContent"), /条定价规则.*条型号等价规则/);
      assert.equal(await evaluate("Boolean(document.getElementById('knowledge-check'))"), true);
      // 数据页：CC Switch 导入的状态卡片和开关
      await evaluate("document.querySelector('[data-settings-tab=data]').click()");
      assert.ok((await evaluate("document.getElementById('cc-switch-card').textContent")).length > 0);
      assert.equal(await evaluate("Boolean(document.getElementById('pref-ccSwitch'))"), true);
      // 通用页：语言切换（中文 / English / 跟随系统），词典已加载
      await evaluate("document.querySelector('[data-settings-tab=general]').click()");
      assert.match(await evaluate("document.getElementById('pref-language').textContent"), /跟随系统|简体中文|English/);
      assert.equal(await evaluate("window.PulseI18n.t('请求记录')"), 'Requests');
      await evaluate("document.querySelector('[data-settings-tab=about]').click()");
      // 这一版去掉的：关于里的「本机 CLI」、侧栏「本机持续记录」、总览「数据只保存在本机」；「偏好设置」改叫「设置」。
      // 「本机 CLI」只查关于页：0.3.18 起官方账号页有「用本机 CLI 已登录的账号」这个选项
      assert.equal(await evaluate("document.querySelector('[data-panel=about]').textContent.includes('本机 CLI') || document.body.textContent.includes('本机持续记录') || document.body.textContent.includes('数据只保存在本机')"), false);
      assert.equal(await evaluate("document.getElementById('settings-open').textContent.trim()"), '设置');
      // 自绘标题栏：三个窗口按钮都在，颜色跟着主题变量走
      assert.equal(await evaluate("document.querySelectorAll('#titlebar .titlebar-buttons button').length"), 3);
      await evaluate("document.getElementById('settings-close').click()");
      assert.equal(await evaluate("getComputedStyle(document.getElementById('settings')).display"), 'none');
      // 页脚「统计口径」直接打开设置的「数据」页。
      await evaluate("document.getElementById('methodology-open').click()");
      await until("!document.getElementById('settings').hidden && !document.querySelector('[data-panel=data]').hidden");
      await evaluate("document.getElementById('settings-close').click()");
      await evaluate("document.querySelector('[data-days=\"30\"]').click()");
      assert.equal(await evaluate("document.querySelectorAll('#daily-chart rect.col').length"), 30);
      console.log('PASS settings and chart buttons respond while quota is pending');
      await evaluate("document.getElementById('refresh').click()");
      assert.equal(await evaluate("document.getElementById('refresh').disabled"), true);
      const quotaDeadline = Date.now() + 15000;
      while (!finishQuota && Date.now() < quotaDeadline) await delay(50);
      assert.ok(finishQuota, 'Quota request started');
      finishQuota();
      await until("!document.getElementById('refresh').disabled");
      assert.equal(await evaluate("window.tokenpulse.snapshot().then(s => Boolean(s.scannedAt))"), true);
      assert.ok(maxGap < 1000, `Main process blocked for ${maxGap} ms`);
      console.log(`PASS refresh completes; maximum main event-loop gap ${maxGap} ms`);
      await evaluate("document.querySelector('[data-page=quota]').click()");
      assert.equal(await evaluate("document.querySelectorAll('.quota-window-grid .panel').length"), 2);
      assert.match(await evaluate("document.getElementById('quota-detail').textContent"), /122.0%/);
      assert.equal(await evaluate("document.querySelectorAll('#quota-detail rect.col').length"), 24);
      // Token / 费用预测：剩余可用、重置时预计用量、整窗容量都换算成 Token 和费用
      assert.match(await evaluate("document.getElementById('quota-detail').textContent"), /剩余可用（估算）[\s\S]*整窗容量折算/);
      assert.match(await evaluate("document.getElementById('quota-detail').textContent"), /重置时预计用量/);
      assert.equal(await evaluate("byCapacity({ capacity: { tokens: 1000, costUsd: 10 } }, 150).tokens"), 1000, '预计超过 100% 时按整窗容量封顶');
      assert.equal(await evaluate("byCapacity({ capacity: { tokens: 1000, costUsd: 10 } }, 25).costUsd"), 2.5);
      assert.equal(await evaluate("byCapacity({}, 50)"), null, '没有容量折算时不给数');
      // 历史容量折线：周 / 5 小时、Tokens / 费用可以切换
      assert.equal(await evaluate("document.querySelectorAll('.capacity-panel').length"), 1);
      // 0.3.9：共享额度（默认）下模块还在、标题不变，只是给出打开「只在本机用 Code」的入口；打开后才有折线和切换
      assert.match(await evaluate("document.querySelector('.capacity-panel h2').textContent"), /额度容量趋势/);
      if (await evaluate("!!document.querySelector('.capacity-panel.protected')")) {
        assert.ok(await evaluate("!!document.querySelector('.capacity-panel .capacity-locked button')"), '共享额度下给出去设置的入口');
        assert.equal(await evaluate("document.querySelector('.capacity-panel [data-cap-window]')"), null, '没有可折算的数据时不显示空的切换按钮');
        // 这个测试账号是老式采样（没有账号 id），不能单独标成只在本机用 Code；切换按钮在 test-model-study-ui 的带 id 账号上覆盖
      } else {
        await evaluate("document.querySelector('[data-cap-window=five]').click(); document.querySelector('[data-cap-metric=costUsd]').click()");
        assert.equal(await evaluate("state.capWindow + '/' + state.capMetric"), 'five/costUsd');
        assert.equal(await evaluate("Boolean(document.querySelector('.capacity-chart svg, .capacity-chart .empty'))"), true);
        await evaluate("document.querySelector('[data-cap-window=week]').click(); document.querySelector('[data-cap-metric=tokens]').click()");
      }
      // 定时刷新（onSnapshot / 30 秒重绘）不能把页面拉回顶部
      // 滚动的是工作区，不是整个窗口
      assert.equal(await evaluate("getComputedStyle(document.body).overflow"), 'hidden');
      await evaluate("scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' })");
      const scrolled = await evaluate("scroller.scrollTop");
      assert.ok(scrolled > 300, `test page should be scrollable, got ${scrolled}`);
      await evaluate("render({ ...current, now: Date.now() })");
      assert.equal(await evaluate("scroller.scrollTop"), scrolled, '刷新后滚动位置不变');
      // 指标小卡片：三组、每组都有卡片
      assert.equal(await evaluate("document.querySelectorAll('.quota-window-grid .window-panel')[0].querySelectorAll('.metric-group').length"), 3);
      await evaluate("scroller.scrollTo({ top: 0, behavior: 'instant' })");
      await evaluate("document.querySelector('[data-account=grok]').click()");
      assert.match(await evaluate("document.getElementById('quota-detail').textContent"), /历史记录/);
      await evaluate("document.querySelector('[data-account=claude]').click()");
      assert.match(await evaluate("document.getElementById('quota-detail').textContent"), /暂时还没有/);
      console.log('PASS quota predictions, reset confirmation, stale and missing accounts');
      await evaluate("document.querySelector('[data-page=overview]').click(); window.tokenpulse.snapshot().then(s => { const sample = structuredClone(s); const a = sample.accounts.find(a => a.kind === 'chatgpt'); a.five.used = 100; a.five.projectedAtReset = 235; render(sample); })");
      assert.match(await evaluate("document.querySelector('.quota-card .quota-card-foot').textContent"), /额度已用完，等待重置/);
      assert.doesNotMatch(await evaluate("document.querySelector('.quota-card .quota-card-foot').textContent"), /235/);
      console.log('PASS exhausted quota shows a reset instruction instead of a projection');
      // 用量明细默认是逐条请求；按日汇总是另一个视图
      await evaluate("document.querySelector('[data-page=usage]').click()");
      assert.equal(await evaluate("document.getElementById('view-requests').hidden"), false, 'per-request view is the default');
      assert.equal(await evaluate("document.querySelectorAll('[data-page=requests]').length"), 0, 'request log merged into usage');
      await evaluate("document.querySelector('#usage-view [data-view=daily]').click()");
      assert.equal(await evaluate("document.getElementById('view-daily').hidden"), false);
      assert.equal(await evaluate("document.getElementById('view-requests').hidden"), true);
      // 0.3.16：内容变短时页面不往上跳。滚到底，把一大块内容藏掉（切分类、换筛选、列表变成「加载中」都是这种情况），滚动位置保持不动
      {
        const frames = () => evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))");
        await evaluate("(() => { const w = document.querySelector('.workspace'); const tall = document.createElement('div'); tall.id = 'qa-tall'; tall.style.height = '1600px'; document.getElementById('main').append(tall); /* 像用户那样滚：先有滚轮事件 */ w.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 })); w.scrollTo({ top: w.scrollHeight, behavior: 'instant' }); })()");
        // 等进场动画（位移）放完再量位置
        await evaluate("Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))"); await new Promise(r => setTimeout(r, 700));
        await frames();
        const before = await evaluate("(() => { const w = document.querySelector('.workspace'); return { top: w.scrollTop, anchor: document.getElementById('usage-view').getBoundingClientRect().top }; })()");
        assert.ok(before.top > 800, '先滚到了下面：' + before.top);
        // 当场读一次布局（脚本里读 scrollTop 会让浏览器立刻夹住位置）——这是最难的情况
        await evaluate("(() => { document.getElementById('qa-tall').style.height = '40px'; return document.querySelector('.workspace').scrollTop; })()");
        await frames(); await frames();
        const after = await evaluate("(() => { const w = document.querySelector('.workspace'); return { top: w.scrollTop, anchor: document.getElementById('usage-view').getBoundingClientRect().top, pad: document.getElementById('scroll-floor').offsetHeight }; })()");
        assert.ok(Math.abs(after.top - before.top) <= 1, `内容变短后滚动位置不变：${before.top} → ${after.top}`);
        assert.ok(Math.abs(after.anchor - before.anchor) <= 1, '分类按钮还在原来的位置');
        assert.ok(after.pad > 1000, '末尾垫了空白：' + after.pad);
        // 不读布局、等下一帧排版时才夹住的情况（恢复高度再缩一次）
        await evaluate("document.getElementById('qa-tall').style.height = '1600px'"); await frames();
        await evaluate("document.getElementById('qa-tall').style.height = '40px'"); await frames(); await frames();
        assert.ok(Math.abs(await evaluate("document.querySelector('.workspace').scrollTop") - before.top) <= 1, '下一帧才排版的情况也不跳');
        // 切换分类：分类按钮不动
        await evaluate("document.querySelector('#usage-view [data-view=requests]').click()"); await frames(); await frames();
        { const now = await evaluate("(() => { const w = document.querySelector('.workspace'); return { anchor: document.getElementById('usage-view').getBoundingClientRect().top, top: w.scrollTop, limit: w.scrollHeight - w.clientHeight, pad: document.getElementById('scroll-floor').offsetHeight }; })()");
          assert.ok(Math.abs(now.anchor - before.anchor) <= 1, '切换分类后按钮还在原位：' + JSON.stringify({ before, now })); }
        await evaluate("document.querySelector('#usage-view [data-view=daily]').click()"); await frames(); await frames();
        assert.ok(Math.abs(await evaluate("document.getElementById('usage-view').getBoundingClientRect().top") - before.anchor) <= 1);
        // 用户自己往上滚：空白跟着缩掉，滚到顶就没有了
        await evaluate("(() => { const w = document.querySelector('.workspace'); w.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 })); w.scrollTo({ top: 300, behavior: 'instant' }); })()"); await frames(); await frames();
        const mid = await evaluate("({ top: document.querySelector('.workspace').scrollTop, pad: document.getElementById('scroll-floor').offsetHeight })");
        assert.equal(Math.round(mid.top), 300, '用户往上滚不会被拉回去'); assert.ok(mid.pad < after.pad, '空白缩小了');
        await evaluate("(() => { const w = document.querySelector('.workspace'); w.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 })); w.scrollTo({ top: 0, behavior: 'instant' }); })()"); await frames(); await frames();
        assert.equal(await evaluate("document.getElementById('scroll-floor').offsetHeight"), 0, '回到顶部后不留空白');
        await evaluate("document.getElementById('qa-tall').remove()");
        // 换页：回到顶部，不带着上一页的位置
        await evaluate("document.querySelector('.workspace').scrollTo({ top: 200, behavior: 'instant' })"); await frames();
        await evaluate("navigate('overview')"); await frames(); await frames();
        assert.equal(await evaluate("document.querySelector('.workspace').scrollTop"), 0, '换页后在顶部');
        await evaluate("navigate('usage')"); await frames();
        await evaluate("document.querySelector('#usage-view [data-view=daily]').click()");
        console.log('PASS 0.3.16 scroll guard: shrinking content keeps the scroll position (sync and next-frame clamps, view switch), padding shrinks as the user scrolls up, navigation resets');
      }
      await evaluate("document.getElementById('request-search').value='QA-model'; document.getElementById('request-search').dispatchEvent(new Event('input'))");
      await until("!analysis.loading && filteredRecords.length === 22");
      assert.equal(await evaluate("document.querySelectorAll('#records tr').length"), 15);
      assert.match(await evaluate("document.getElementById('record-count').textContent"), /22/);
      await evaluate("document.getElementById('next-page').click()");
      assert.equal(await evaluate("document.querySelectorAll('#records tr').length"), 7);
      await evaluate("document.getElementById('record-sort').value='tokens'; document.getElementById('record-sort').dispatchEvent(new Event('change'))");
      assert.match(await evaluate("document.querySelector('#records tr').textContent"), /QA-model-21/);
      await evaluate("document.getElementById('export-csv').click()");
      await until("!document.getElementById('export-csv').disabled");
      const exported = fs.readFileSync(exportPath, 'utf8');
      assert.equal(exported.charCodeAt(0), 0xfeff); assert.equal(exported.trim().split('\r\n').length, 23);
      assert.ok(exported.includes('QA-model-00') && exported.includes('QA-model-21'));
      await evaluate("document.getElementById('source-filter').value='Claude Code'; document.getElementById('source-filter').dispatchEvent(new Event('change'))");
      await until("!analysis.loading");
      assert.match(await evaluate("document.getElementById('records').textContent"), /没有匹配/);
      assert.equal(await evaluate("document.getElementById('export-csv').disabled"), true);
      await evaluate("document.getElementById('source-filter').value='all'; document.getElementById('source-filter').dispatchEvent(new Event('change')); document.getElementById('request-search').value=''; document.getElementById('request-search').dispatchEvent(new Event('input')); document.querySelector('[data-page=overview]').click()");
      console.log('PASS search, sorting, pagination, source filtering and complete CSV export');
      // 请求记录：逐条列出、核验结论、展开详情、按结论筛选、导出。只看 QA 的三条。
      // 以前的「请求记录」入口（通知、额度详情的链接）会跳到用量明细的逐条请求视图
      await evaluate("navigate('requests'); document.getElementById('request-search').value='tp-ui-fixture'; document.getElementById('request-search').dispatchEvent(new Event('input'))");
      assert.equal(await evaluate("state.page + '/' + state.usageView"), 'usage/requests');
      await until("document.querySelectorAll('#request-rows .request-row').length === 3");
      assert.equal(await evaluate("document.getElementById('usage-summary').hidden"), false, 'usage tiles stay on the merged page');
      assert.equal(await evaluate("document.querySelectorAll('#verify-tiles .verify-chip').length"), 5);
      assert.match(await evaluate("document.querySelector('.request-table thead').textContent"), /额度占用/);
      assert.equal(await evaluate("document.querySelectorAll('.request-row .quota-share').length"), 3);
      // 账号：表头有「账号」列、有账号筛选，每行都有账号格
      assert.match(await evaluate("document.querySelector('.request-table thead').textContent"), /账号/);
      assert.equal(await evaluate("document.querySelectorAll('.request-row .account-cell').length"), 3);
      assert.ok(await evaluate("document.getElementById('request-account').options.length >= 1"));
      assert.match(await evaluate("document.querySelector('[data-verify=mismatch] b').textContent"), /1/);
      assert.match(await evaluate("document.querySelector('.request-row.mismatch').textContent"), /claude-QA-sonnet.*请求的是 claude-QA-opus\[1m\].*型号不一致/);
      assert.match(await evaluate("document.querySelector('.request-row.unverified').textContent"), /返回型号未记录.*无法核验/);
      assert.match(await evaluate("document.querySelector('.request-row.mismatch .project-name').textContent"), /^tp-ui-fixture$/);
      await evaluate("document.querySelector('.request-row.mismatch').click()");
      await until("document.querySelector('.request-detail')");
      assert.match(await evaluate("document.querySelector('.request-detail').textContent"), /msg_01A+.*req_011CB+.*请求的是 claude-QA-opus\[1m\]，上游返回的是 claude-QA-sonnet/);
      assert.equal(await evaluate("document.querySelectorAll('.request-detail .problem').length"), 1);
      await evaluate("document.querySelector('.request-row.mismatch').click()");
      await until("!document.querySelector('.request-detail')");
      await evaluate("document.querySelector('[data-verify=mismatch]').click()");
      await until("document.querySelectorAll('#request-rows .request-row').length === 1");
      assert.equal(await evaluate("document.getElementById('request-status').value"), 'mismatch');
      assert.equal(await evaluate("document.querySelectorAll('#verify-tiles .verify-chip').length"), 5, 'chip counts stay while filtering');
      await evaluate("document.getElementById('verify-help').click()");
      assert.equal(await evaluate("document.getElementById('verify-method').hidden"), false);
      await evaluate("document.getElementById('export-requests').click()");
      for (const deadline = Date.now() + 5000; !(fs.existsSync(exportPath) && fs.readFileSync(exportPath, 'utf8').includes('请求型号')); await delay(50)) assert.ok(Date.now() < deadline, 'request export timed out');
      const requestCsv = fs.readFileSync(exportPath, 'utf8');
      assert.match(requestCsv, /请求型号.*返回型号.*核验/);
      assert.equal(requestCsv.trim().split('\r\n').length, 2);
      assert.match(requestCsv, /claude-QA-opus\[1m\].*claude-QA-sonnet.*型号不一致/);
      assert.match(await evaluate("document.getElementById('nav-request-alert').textContent"), /^\d+$/);
      await evaluate("document.querySelector('[data-verify=mismatch]').click(); document.getElementById('request-search').value=''; document.getElementById('request-search').dispatchEvent(new Event('input')); document.querySelector('[data-page=overview]').click()");
      assert.equal(await evaluate("document.getElementById('usage-summary').hidden"), false);
      console.log('PASS request log lists every request, flags model mismatches, expands details and exports');
      // 0.3.7：通过实际 DOM 控件查询，验证 IPC、worker 与统计都使用相同条件。
      await evaluate("navigate('usage'); document.getElementById('clear-detail-filters').click(); document.getElementById('request-search').value='tp-ui-fixture'; document.getElementById('request-search').dispatchEvent(new Event('input'))");
      await until("!analysis.loading && analysis.total.tokens === 3840 && requestPage?.total === 3");
      await until("[...document.querySelectorAll('#model-options input')].some(i => i.value === 'claude-QA-opus')");
      await evaluate("document.getElementById('model-picker').open=true; document.querySelector('#model-options input[value=claude-QA-opus]').click()");
      await until("!analysis.loading && analysis.total.tokens === 1280 && requestPage?.total === 1");
      assert.equal(await evaluate("requestPage.rows[0].model"), 'claude-QA-opus', '按统计型号精确查，不混入请求型号相同的 sonnet');
      await evaluate("document.getElementById('model-option-search').value='SONNET'; document.getElementById('model-option-search').dispatchEvent(new Event('input'))");
      assert.equal(await evaluate("document.querySelector('#model-options input[value=claude-QA-opus]').closest('label').hidden"), true);
      assert.equal(await evaluate("getComputedStyle(document.querySelector('#model-options input[value=claude-QA-opus]').closest('label')).display"), 'none');
      assert.equal(await evaluate("document.querySelector('#model-options input[value=claude-QA-opus]').checked"), true, '搜索候选项不会取消已选模型');
      await evaluate("document.querySelector('#model-options input[value=claude-QA-sonnet]').click()");
      await until("!analysis.loading && analysis.total.tokens === 2560 && requestPage?.total === 2");
      await evaluate("document.querySelector('#usage-view [data-view=daily]').click()");
      await until("!analysis.loading && filteredRecords.length === 2");
      assert.equal(await evaluate("filteredRecords.reduce((n,r)=>n+r.tokens,0)"), 2560);
      await evaluate("document.getElementById('export-csv').click()");
      await until("!document.getElementById('export-csv').disabled");
      const filteredCsv = fs.readFileSync(exportPath, 'utf8');
      assert.equal(filteredCsv.trim().split('\r\n').length, 3);
      assert.ok(filteredCsv.includes('claude-QA-opus') && filteredCsv.includes('claude-QA-sonnet'));
      await evaluate("document.querySelector('.more-filters').open=true; document.getElementById('request-project').value='D:\\\\qa\\\\tp-ui-fixture'; document.getElementById('request-project').dispatchEvent(new Event('change'))");
      await until("!analysis.loading && analysis.total.tokens === 2560");
      await evaluate("document.getElementById('request-channel').value='unknown'; document.getElementById('request-channel').dispatchEvent(new Event('change'))");
      await until("!analysis.loading && requestPage?.rows.every(r => r.official === undefined)");
      assert.equal(await evaluate("analysis.total.tokens"), 2560);
      await evaluate("document.getElementById('request-channel').value='official'; document.getElementById('request-channel').dispatchEvent(new Event('change'))");
      await until("!analysis.loading && requestPage?.total === 0");
      assert.equal(await evaluate("analysis.total.tokens"), 0);
      assert.equal(await evaluate("document.getElementById('export-csv').disabled"), true);
      // 清除渠道筛选标签；其余筛选仍保留。
      await evaluate("[...document.querySelectorAll('#detail-filter-chips button')].find(b=>b.textContent.includes('官方订阅')).click()");
      await until("!analysis.loading && analysis.total.tokens === 2560");
      assert.equal(await evaluate("state.models.length"), 2);
      if (!process.env.TOKENPULSE_TEST_APP) {
        await evaluate("document.documentElement.dataset.theme='light'; document.getElementById('model-picker').open=true");
        await delay(150);
        assert.equal(await evaluate("getComputedStyle(document.querySelector('.model-options')).display !== 'none'"), true);
        await evaluate("document.documentElement.dataset.theme='dark'");
        assert.equal(await evaluate("getComputedStyle(document.querySelector('.model-options')).backgroundColor"), 'rgb(22, 25, 31)');
        assert.equal(await evaluate("document.querySelector('.model-options').getBoundingClientRect().width <= innerWidth"), true);
      }
      await evaluate("document.documentElement.dataset.theme='light'; document.getElementById('model-picker').open=false; document.querySelector('.more-filters').open=false; document.getElementById('clear-detail-filters').click(); navigate('overview')");
      assert.equal(await evaluate("Boolean(hasDetailFilters())"), false);
      assert.equal(await evaluate("document.getElementById('detail-filters').hidden"), true);
      console.log('PASS v0.3.7 model multi-select, exact attribution, linked totals, daily export, project, channel, empty results and themes');

      await evaluate("document.getElementById('model-option-search').value='no-such-candidate'; document.getElementById('model-option-search').dispatchEvent(new Event('input'))");
      assert.equal(await evaluate("document.getElementById('model-options-empty').hidden"), false);
      await evaluate("document.getElementById('model-option-search').value=''; document.getElementById('model-option-search').dispatchEvent(new Event('input'))");
      // 动效只读 DOM/CSS/WAAPI；不生成截图。真实媒体查询通过 CDP 验证。
      await evaluate("document.dispatchEvent(new PointerEvent('pointerdown')); navigate('usage'); document.getElementById('model-picker').open=false");
      await delay(220);
      assert.equal(await evaluate("CSS.supports('interpolate-size', 'allow-keywords')"), true);
      await evaluate("document.querySelector('#model-picker summary').click()");
      await delay(30);
      assert.equal(await evaluate("document.querySelector('.model-options').getAnimations().length > 0"), true, '模型菜单应有真实过渡');
      await until("getComputedStyle(document.querySelector('.model-options')).opacity === '1'");
      await evaluate("document.querySelector('#model-picker summary').click(); document.querySelector('#model-picker summary').click()");
      await until("getComputedStyle(document.querySelector('.model-options')).opacity === '1'");
      assert.equal(await evaluate("document.getElementById('model-picker').open"), true);
      await evaluate("document.querySelector('#model-picker summary').click()");
      await delay(220);
      assert.equal(await evaluate("getComputedStyle(document.getElementById('model-picker'), '::details-content').contentVisibility"), 'hidden');
      await evaluate("document.querySelector('.more-filters summary').click()");
      await delay(220);
      assert.equal(await evaluate("parseFloat(getComputedStyle(document.querySelector('.more-filters'), '::details-content').height) > 0"), true);
      await evaluate("document.querySelector('.more-filters summary').click()");
      await delay(220);
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.more-filters'), '::details-content').height"), '0px');
      await until("[...document.querySelectorAll('#model-options input')].some(i => i.value === 'claude-QA-opus')");
      await evaluate("document.querySelector('#model-options input[value=claude-QA-opus]').click()");
      await until("!analysis.loading && requestPage?.total === 1");
      await delay(220);
      await evaluate("window.motionChip = [...document.querySelectorAll('#detail-filter-chips button')].find(n => n.dataset.key === 'model:claude-QA-opus'); motionChip.focus(); render(current)");
      assert.equal(await evaluate("motionChip === document.activeElement && motionChip.isConnected"), true, '刷新保留标签节点与焦点');
      assert.equal(await evaluate("detailAnimations.size"), 0, '后台重绘不重播筛选动画');
      await evaluate("document.querySelector('#model-options input[value=claude-QA-opus]').click(); document.querySelector('#model-options input[value=claude-QA-opus]').click()");
      await until("!analysis.loading && requestPage?.total === 1");
      await delay(220);
      assert.equal(await evaluate("motionChip.isConnected && !motionChip.disabled && !motionChip.dataset.leaving"), true, '离场中重新选择必须保留标签');
      await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab'})); document.querySelector('#model-picker summary').click()");
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.model-options')).transitionDuration"), '0s');
      assert.equal(await evaluate("detailAnimations.size"), 0);
      contents.debugger.attach('1.3');
      try {
        await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        await until("reducedMotion.matches");
        await evaluate("document.dispatchEvent(new PointerEvent('pointerdown')); document.querySelector('#model-options input[value=claude-QA-opus]').click()");
        assert.equal(await evaluate("detailAnimations.size"), 0);
        assert.equal(await evaluate("getComputedStyle(document.querySelector('.model-options')).transitionDuration"), '0s');
      } finally {
        await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
        contents.debugger.detach();
      }
      await evaluate("delete window.motionChip; document.getElementById('model-picker').open=false; document.getElementById('clear-detail-filters').click(); navigate('overview')");
      console.log('PASS filter motion, native details exit, rapid reversal, stable focus, quiet refresh, keyboard and reduced motion');

      // 查询故障不能伪装成零用量；保留筛选，恢复后点击重试。
      failRequestQueries = true;
      await evaluate("navigate('usage'); state.reqSearch='req_011CBBBB'; document.getElementById('request-search').value='req_011CBBBB'; requeryRequests()");
      await until("analysis.error && requestError && !document.getElementById('retry-detail-query').hidden");
      assert.equal(await evaluate("[...document.querySelectorAll('#tiles .stat-value')].every(n => n.textContent === '—')"), true);
      assert.equal(await evaluate("document.getElementById('export-csv').disabled && document.getElementById('export-requests').disabled"), true);
      assert.match(await evaluate("document.getElementById('request-rows').textContent"), /读取失败/);
      failRequestQueries = false;
      await evaluate("document.getElementById('retry-detail-query').click()");
      await until("!analysis.loading && !analysis.error && !requestError && requestPage?.total === 1");
      assert.equal(await evaluate("analysis.total.tokens"), 1280);
      assert.equal(await evaluate("document.getElementById('retry-detail-query').hidden"), true);
      assert.equal(await evaluate("state.reqSearch"), 'req_011CBBBB');
      await evaluate("document.getElementById('clear-detail-filters').click(); navigate('overview')");
      console.log('PASS query failure is explicit, exports are disabled and retry preserves filters');

      // 时间范围：总览默认 30 天；用量明细每次打开都是「今天」；回到总览还是原来的范围
      await evaluate("document.querySelector('[data-page=overview]').click()");
      assert.equal(await evaluate("String(state.days)"), '30');
      await evaluate("document.querySelector('[data-page=usage]').click()");
      assert.equal(await evaluate("String(state.days)"), '1', 'usage opens on today');
      assert.match(await evaluate("document.getElementById('range-button-label').textContent"), /今天/);
      await evaluate("document.querySelector('[data-page=overview]').click()");
      assert.equal(await evaluate("String(state.days)"), '30', 'overview keeps its own range');
      // 「一天」= 过去 24 小时：从逐条流水汇总，图表按小时
      await evaluate("document.getElementById('range-button').click(); document.querySelector('#range-presets [data-days=\"24h\"]').click()");
      await until("state.days === '24h' && analysis && !analysis.loading");
      assert.match(await evaluate("document.getElementById('range-label').textContent"), /过去 24 小时/);
      assert.match(await evaluate("document.getElementById('chart-caption').textContent"), /按小时/);
      assert.equal(await evaluate("analysis.hourly.length"), 24);
      assert.ok(await evaluate("analysis.total.tokens > 0"), 'the fixture requests fall inside the past 24 hours');
      // 数字：默认精确到个位，中文后面跟「≈X万 / 亿」；可以换成简写
      assert.match(await evaluate("document.querySelector('#tiles .stat .num').textContent"), /^\d{1,3}(,\d{3})*$/);
      assert.match(await evaluate("document.querySelector('#tiles .stat .cn-approx')?.textContent || ''"), /^≈[\d,.]+[万亿]$/);
      await evaluate("setNumberMode('compact')");
      assert.match(await evaluate("document.querySelector('#tiles .stat .num').textContent"), /^[\d.]+[KMB]?$/);
      await evaluate("setNumberMode('exact'); document.getElementById('range-button').click(); document.querySelector('#range-presets [data-days=\"30\"]').click()");
      console.log('PASS usage opens on today, 24-hour range, exact numbers with Chinese approximations');

      // 总览选「今天」：用量趋势按小时（零点到现在这一小时）
      await evaluate("applyRange(1)");
      await until("state.days === 1 && Array.isArray(analysis.hourly)");
      assert.equal(await evaluate("analysis.hourly.length"), await evaluate("new Date(current.now).getHours() + 1"), 'one bar per hour from midnight to now');
      assert.match(await evaluate("document.getElementById('chart-caption').textContent"), /按小时 · 今天/);
      // 用量明细的用量分析：分工具趋势、完整的工具 / 模型排行、时段分布，都跟着范围走
      await evaluate("navigate('usage'); applyRange(30)");
      await until("document.querySelector('#usage-insights .insight-trend svg') && document.querySelectorAll('#usage-insights .insight-models tbody tr').length > 0 && document.querySelector('#usage-insights .insight-hod svg')");
      const insights = await evaluate(`(() => {
        const models = new Set(analysis.selected.map(r => r.source + '|' + r.model)), sources = new Set(analysis.selected.map(r => r.source));
        return { rows: document.querySelectorAll('#usage-insights .insight-models tbody tr').length, models: models.size, tools: document.querySelectorAll('#usage-insights .insight-rank-row').length, sources: sources.size,
          segs: document.querySelectorAll('#usage-insights .insight-seg').length, heat: document.querySelectorAll('#usage-insights .insight-heat-cell').length,
          inlineStyle: [...document.querySelectorAll('#usage-insights [style]')].some(n => n.getAttribute('style').includes('var(') && n.tagName === 'rect' && n.getAttribute('fill')) };
      })()`);
      assert.equal(insights.rows, insights.models, '模型排行列出全部型号，不截断');
      assert.ok(insights.models > 5, `fixture has more models than the overview's top 5 (${insights.models})`);
      assert.equal(insights.tools, insights.sources);
      assert.ok(insights.segs > 0 && insights.heat === 7 * 24, JSON.stringify(insights));
      await evaluate("document.querySelector('#usage-insights [data-insight-sort=costUsd]').click()");
      await until("document.querySelector('#usage-insights [data-insight-sort=costUsd]').classList.contains('on')");
      const costs = await evaluate("[...document.querySelectorAll('#usage-insights .insight-models tbody tr')].map(tr => Number(tr.children[7].textContent.replace(/[$,<]/g, '')) || 0)");
      assert.deepEqual(costs, [...costs].sort((a, b) => b - a), 'sorting by cost');
      await evaluate("navigate('overview')");
      console.log('PASS today is hourly; usage analysis shows the full tool / model rankings, stacked trend and time-of-day distribution');
      // 外观移进了设置 → 通用：日间 / 夜间 / 跟随系统。
      await evaluate("document.getElementById('settings-open').click()");
      await until("!document.getElementById('settings').hidden");
      await evaluate("document.getElementById('pref-theme').click()");
      await until("!document.getElementById('option-menu').hidden");
      await evaluate("document.querySelector('#option-menu [data-value=dark]').click()");
      assert.equal(await evaluate("document.documentElement.dataset.theme"), 'dark');
      assert.equal(await evaluate("localStorage.getItem('tokenpulse-theme')"), 'dark');
      await evaluate("setThemeMode('system')");
      assert.equal(await evaluate("localStorage.getItem('tokenpulse-theme')"), 'system');
      assert.equal(await evaluate("document.documentElement.dataset.theme"), await evaluate("matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'"));
      await evaluate("setThemeMode('light'); document.getElementById('settings-close').click()");
      // 夜间模式下标题栏跟着变色（系统标题栏做不到）
      await evaluate("setThemeMode('dark')");
      await delay(600); // 切换主题有 0.35 秒的颜色过渡
      // 标题栏是两段渐变（左边接侧栏、右边接内容区），深色时两段都要是深色
      const titlebarBackground = await evaluate("getComputedStyle(document.getElementById('titlebar')).backgroundImage");
      assert.ok(titlebarBackground.includes('rgb(18, 20, 25)'), titlebarBackground);
      await evaluate("setThemeMode('light')");
      await delay(600);
      // 时间选择器（参照 AllAi）：输入框选自定义范围
      const today = dayKey(fixtureNow);
      await evaluate("document.getElementById('range-button').click()");
      assert.equal(await evaluate("document.getElementById('range-popover').hidden"), false);
      assert.equal(await evaluate("document.querySelectorAll('#cal-grid .cal-day').length"), 42);
      await evaluate(`const f = document.getElementById('date-from'); f.value='${today}'; f.dispatchEvent(new Event('change')); const t = document.getElementById('date-to'); t.value='${today}'; t.dispatchEvent(new Event('change')); document.getElementById('custom-range').requestSubmit()`);
      assert.equal(await evaluate("document.getElementById('range-popover').hidden"), true);
      assert.equal(await evaluate("document.querySelectorAll('#daily-chart rect.col').length"), 1);
      assert.match(await evaluate("document.getElementById('range-button-label').textContent"), /自定义/);
      // 日历点选：第一下开始、第二下结束；开始晚于结束时不能确定
      await evaluate("document.getElementById('range-button').click(); document.getElementById('range-follow').checked = false; document.getElementById('range-follow').dispatchEvent(new Event('change'))");
      await evaluate(`document.querySelector('#cal-grid [data-day="${today}"]').click()`);
      assert.equal(await evaluate("document.getElementById('range-apply').disabled"), true);
      await evaluate(`document.querySelector('#cal-grid [data-day="${today}"]').click()`);
      assert.equal(await evaluate("document.getElementById('range-apply').disabled"), false);
      assert.equal(await evaluate("[...document.querySelectorAll('#cal-grid .cal-day')].filter(d => !d.disabled && d.dataset.day > '" + today + "').length"), 0);
      await evaluate("document.getElementById('range-cancel').click()");
      // 「全部」：数据永久保存，从有记录的第一天算起；不再有 366 天上限
      await evaluate("document.querySelector('[data-days=\"all\"]').click()");
      assert.match(await evaluate("document.getElementById('range-button-label').textContent"), /全部/);
      // 界面测试会真的扫描本机会话，所以「全部」从本机最早的那条记录算起
      assert.equal(await evaluate("state.from === current.usage.reduce((min, row) => row.day < min ? row.day : min, D.dayKey(Date.now())) && analysis.daily.length === D.dayCount(state.from, state.to)"), true);
      assert.equal(await evaluate("D.analyze([], '2023-01-01', '2026-01-01').daily.length"), 1097);
      assert.equal(await evaluate("groupDaily(D.analyze([], '2026-01-01', '2026-03-01').daily).unit"), '天');
      assert.equal(await evaluate("groupDaily(D.analyze([], '2025-06-01', '2026-06-01').daily).unit"), '周');
      assert.equal(await evaluate("groupDaily(D.analyze([], '2023-01-01', '2025-12-31').daily).rows.length"), 36);
      await evaluate("document.querySelector('[data-days=\"30\"]').click()");
      assert.equal(await evaluate("document.querySelectorAll('#daily-chart rect.col').length"), 30);
      const window = BrowserWindow.fromWebContents(contents);
      window.setSize(900, 650); await delay(150);
      assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
      for (const page of ['usage', 'quota', 'overview']) {
        await evaluate(`document.querySelector('[data-page=${page}]').click()`);
        assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true, `Overflow at 900px: ${page}`);
      }
      window.setSize(1380, 920); await delay(150);
      console.log("PASS theme, title bar, AllAi-style range picker, unlimited ranges and 900px layout");
      // 额度页账号行：轻微移动仍是点击；拖过阈值才排序。多出来的标签不能把窗口撑宽。
      await evaluate("document.querySelector('[data-page=quota]').click()");
      const tabClick = await evaluate(`(() => {
        const tabs = document.getElementById('account-tabs');
        const button = tabs.querySelector('button');
        const x = button.getBoundingClientRect().left + 8;
        const y = button.getBoundingClientRect().top + 8;
        const pointer = (type, clientX) => button.dispatchEvent(new PointerEvent(type, { clientX, clientY: y, button: 0, pointerId: 3, bubbles: true }));
        pointer('pointerdown', x);
        pointer('pointermove', x + 4);
        pointer('pointerup', x + 4);
        const dragged = tabDragged;
        button.click();
        return { dragged, account: state.account, selected: button.dataset.account, sorting: tabs.classList.contains('sorting') };
      })()`);
      assert.equal(tabClick.dragged, false, 'a click with a few pixels of movement must not count as a drag');
      assert.equal(tabClick.sorting, false);
      assert.equal(tabClick.account, tabClick.selected);
      const tabOrder = await evaluate(`(() => {
        const tabs = document.getElementById('account-tabs');
        const make = (id, text) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.kind = 'chatgpt';
          button.dataset.account = id;
          button.textContent = text;
          button.style.width = '140px';
          return button;
        };
        const first = make('chatgpt:qa-a', '账号甲');
        const second = make('chatgpt:qa-b', '账号乙');
        tabs.append(first, second);
        const start = first.getBoundingClientRect();
        const pointer = (type, target, clientX) => target.dispatchEvent(new PointerEvent(type, { clientX, clientY: start.top + 8, button: 0, pointerId: 4, bubbles: true }));
        // 先在账号上按下、跑到这一行外面才松手：这一行收不到 pointerup。下一次拖动不能被这次残留的起点卡住
        pointer('pointerdown', first, start.left + 220);
        pointer('pointerup', document.body, start.left + 220);
        pointer('pointerdown', first, start.left + 10);
        pointer('pointermove', first, start.left + 220);
        pointer('pointerup', first, start.left + 220);
        const order = [...tabs.querySelectorAll('button')].map(button => button.dataset.account);
        tabs.querySelectorAll('[data-account^="chatgpt:qa-"]').forEach(button => button.remove());
        const pageFits = document.documentElement.scrollWidth <= window.innerWidth;
        return { order, pageFits };
      })()`);
      assert.ok(tabOrder.order.indexOf('chatgpt:qa-a') > tabOrder.order.indexOf('chatgpt:qa-b'), `drag should move the account later, got ${tabOrder.order.join(',')}`);
      assert.equal(tabOrder.pageFits, true, 'extra accounts must not widen the window');
      const tabBar = await evaluate(`(() => {
        const tabs = document.getElementById('account-tabs');
        const bar = document.getElementById('account-tabs-bar');
        for (let i = 0; i < 12; i++) {
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.kind = 'grok';
          button.dataset.account = 'grok:scroll-' + i;
          button.textContent = '很长的账号名 ' + i;
          tabs.append(button);
        }
        markAccountTabEdges();
        const thumb = bar.querySelector('.account-tabs-thumb');
        const rect = thumb.getBoundingClientRect();
        const pointer = (type, x) => bar.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: rect.top + 2, button: 0, pointerId: 9, bubbles: true }));
        const before = tabs.scrollLeft;
        pointer('pointerdown', rect.right);
        pointer('pointermove', rect.right + 90);
        pointer('pointerup', rect.right + 90);
        const after = tabs.scrollLeft;
        const shown = !bar.hidden;
        tabs.querySelectorAll('[data-account^="grok:scroll-"]').forEach(button => button.remove());
        markAccountTabEdges();
        return { shown, before, after, hiddenAfter: bar.hidden };
      })()`);
      assert.equal(tabBar.shown, true, 'scrollbar appears when accounts overflow');
      assert.ok(tabBar.after > tabBar.before, `scrollbar thumb should scroll the row, ${tabBar.before} -> ${tabBar.after}`);
      assert.equal(tabBar.hiddenAfter, true);
      console.log('PASS quota account click stays a click, drag reorders, scrollbar scrolls');
      // 会话管理：左边列表、右边对话；复制项目地址；回复走主进程的 sessions:reply。
      // 这里把 sessions:reply 换成假的：不真的调 CLI（会花订阅额度、改会话文件），只验证界面的流式显示和结束后的状态。
      await evaluate("document.querySelector('[data-page=sessions]').click()");
      await until("document.querySelector('.sw-items') && !document.querySelector('.sw-items').textContent.includes('正在读取')");
      assert.equal(await evaluate("document.getElementById('page-sessions').hidden"), false);
      assert.equal(await evaluate("document.body.dataset.page"), 'sessions');
      assert.equal(await evaluate("document.documentElement.scrollHeight <= window.innerHeight + 1"), true, '会话页是固定高度的双栏，整页不滚');
      if (await evaluate("document.querySelectorAll('.sw-item').length > 0")) {
        await until("document.querySelector('.sw-head') && document.querySelector('.sw-composer textarea')");
        assert.equal(await evaluate("[...document.querySelectorAll('.sw-actions .btn')].some(b => b.textContent.includes('复制项目地址'))"), true);
        assert.equal(await evaluate("[...document.querySelectorAll('.sw-actions .btn')].some(b => b.textContent.includes('回复对话'))"), true);
        // 筛选：搜不到的词列表清空，清掉恢复
        await evaluate("(() => { const s = document.querySelector('.sw-search input'); s.value = 'zz-no-such-session-qq'; s.dispatchEvent(new Event('input')); })()");
        assert.equal(await evaluate("document.querySelectorAll('.sw-item').length"), 0);
        await evaluate("(() => { const s = document.querySelector('.sw-search input'); s.value = ''; s.dispatchEvent(new Event('input')); })()");
        // 挑一个项目目录还在的会话来回复
        const target = await evaluate("(async () => { for (const item of await window.tokenpulse.sessions()) { if (item.cwd) return item.key; } return ''; })()");
        if (target) {
          await evaluate(`document.querySelector('.sw-item[data-key="${target}"]').click()`);
          await until(`document.querySelector('.sw-item.active')?.dataset.key === ${JSON.stringify(target)} && !document.querySelector('.sw-main .sw-spinner')`);
          // 不真的点复制：测试不该改掉用户的剪贴板
          assert.equal(await evaluate("document.querySelector('.sw-actions .btn').disabled"), false);
          let sent = null;
          ipcMain.removeHandler('sessions:reply');
          ipcMain.handle('sessions:reply', (event, kind, id, prompt, mode) => {
            sent = { kind, id, prompt, mode };
            const runId = 'ui-test-run';
            setTimeout(() => event.sender.send('session-reply', { runId, type: 'delta', text: 'QA 回复' }), 50);
            setTimeout(() => event.sender.send('session-reply', { runId, type: 'tool', text: 'Read' }), 80);
            setTimeout(() => event.sender.send('session-reply', { runId, type: 'delta', text: '第二段' }), 400);
            setTimeout(() => event.sender.send('session-reply', { runId, type: 'done', ok: true }), 700);
            return { runId };
          });
          await evaluate("document.querySelector('.sw-mode [data-mode=edit]').click()");
          await evaluate("(() => { const t = document.querySelector('.sw-composer textarea'); t.value = 'QA 提问'; t.dispatchEvent(new Event('input')); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()");
          await until("document.querySelector('.sw-row.pending .sw-rich')?.textContent.includes('QA 回复')");
          assert.equal(await evaluate("document.querySelector('.sw-send').textContent.includes('停止')"), true, '回复中按钮变成停止');
          await until("document.querySelector('.sw-live-tools')?.textContent.includes('Read')");
          assert.equal(await evaluate("document.querySelector('.sw-live-tools')?.textContent.includes('Read')"), true);
          assert.equal(await evaluate("document.querySelector('.sw-composer textarea').value"), '');
          await until("!document.querySelector('.sw-row.pending') && document.querySelector('.sw-send').textContent.includes('发送')");
          assert.deepEqual({ ...sent, id: undefined, kind: undefined }, { kind: undefined, id: undefined, prompt: 'QA 提问', mode: 'edit' });
          assert.equal(`${sent.kind}:${sent.id}`, target);
          ipcMain.removeHandler('sessions:reply');
        }
      }
      // 0.3.16：新对话 / 新项目。主进程的三个通道换成假的：不真的弹选文件夹对话框、不真的开终端
      {
        const started = [];
        for (const channel of ['sessions:clis', 'sessions:new', 'sessions:pick-folder']) ipcMain.removeHandler(channel);
        ipcMain.handle('sessions:clis', () => ({ claude: true, codex: true, grok: false, guarded: { claude: 'ip', codex: 'region', grok: null } }));
        ipcMain.handle('sessions:pick-folder', () => path.join(temp, 'My New ‘Project’'));
        ipcMain.handle('sessions:new', (_event, kind, folder) => { started.push([kind, folder]); return { ok: true, cwd: folder }; });
        assert.deepEqual(await evaluate("[...document.querySelectorAll('.sw-new-row [data-action]')].map(b => b.dataset.action + ':' + b.textContent.trim())"), ['new-chat:新对话', 'new-project:新项目']);
        // 新项目：先选文件夹，再选工具
        await evaluate("document.querySelector('.sw-new-row [data-action=new-project]').click()");
        await until("document.querySelector('#sw-new .sw-new-tool')");
        assert.equal(await evaluate("document.getElementById('sw-new-title').textContent"), '在新项目里开始');
        assert.equal(await evaluate("document.querySelector('#sw-new .sw-new-path').textContent"), path.join(temp, 'My New ‘Project’'));
        assert.equal(await evaluate("document.querySelector('#sw-new .sw-new-folder').selectedOptions[0].textContent"), 'My New ‘Project’', '下拉里显示文件夹名');
        assert.deepEqual(await evaluate("[...document.querySelectorAll('#sw-new .sw-new-tool')].map(b => b.dataset.kind + ':' + b.disabled + ':' + b.querySelector('small').textContent)"), ['claude:false:已安装', 'codex:false:已安装', 'grok:true:没有找到 CLI']);
        // 设了出口 IP 白名单的工具：对话框里说明启动前会先在终端里检测
        await evaluate("document.querySelector('#sw-new .sw-new-tool[data-kind=claude]').click()");
        assert.match(await evaluate("document.querySelector('#sw-new .sw-new-note').textContent"), /这个工具设了出口 IP 白名单：启动前会先在终端里检测出口 IP，不在白名单就不会启动。/);
        await evaluate("document.querySelector('#sw-new .sw-new-tool[data-kind=codex]').click()");
        assert.match(await evaluate("document.querySelector('#sw-new .sw-new-note').textContent"), /这个工具设了出口地区白名单：启动前会先在终端里检测出口地区，不在地区白名单就不会启动。/);
        assert.equal(await evaluate("document.querySelector('#sw-new .sw-new-tool.on').dataset.kind"), 'codex');
        await evaluate("document.querySelector('#sw-new [data-action=start]').click()");
        await until("!document.getElementById('sw-new')");
        assert.deepEqual(started, [['codex', path.join(temp, 'My New ‘Project’')]]);
        await until("[...document.querySelectorAll('#toast-stack .tp-toast')].some(t => t.textContent.includes('已在终端里打开 Codex CLI'))");
        // 新对话：默认是正在看的那段会话的项目和工具；Esc 关闭；失败时把原因写在对话框里
        await evaluate("document.querySelector('.sw-new-row [data-action=new-chat]').click()");
        await until("document.querySelector('#sw-new .sw-new-tool')");
        assert.equal(await evaluate("document.getElementById('sw-new-title').textContent"), '开一个新对话');
        const preset = await evaluate("(async () => { const items = await window.tokenpulse.sessions(); const active = document.querySelector('.sw-item.active')?.dataset.key; const hit = items.find(i => i.key === active); return { cwd: hit?.cwd || '', chosen: document.querySelector('#sw-new .sw-new-folder').value }; })()");
        if (preset.cwd) assert.equal(preset.chosen, preset.cwd, '默认选中正在看的会话的项目');
        ipcMain.removeHandler('sessions:new'); ipcMain.handle('sessions:new', () => { throw new Error('这个文件夹不存在：X:\\gone'); });
        if (await evaluate("!document.querySelector('#sw-new [data-action=start]').disabled")) {
          await evaluate("document.querySelector('#sw-new [data-action=start]').click()");
          await until("/这个文件夹不存在/.test(document.querySelector('#sw-new .sw-new-note').textContent)");
          assert.ok(await evaluate("Boolean(document.getElementById('sw-new'))"), '失败时对话框留着');
        }
        await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
        await until("!document.getElementById('sw-new')");
        // 夜间模式：对话框里没有默认黑字
        await evaluate("document.querySelector('.sw-new-row [data-action=new-chat]').click()"); await until("document.querySelector('#sw-new .sw-new-tool')");
        await evaluate("setThemeMode('dark')"); await new Promise(r => setTimeout(r, 200));
        assert.deepEqual(await evaluate("[...document.querySelectorAll('#sw-new *')].filter(n => [...n.childNodes].some(c => c.nodeType === 3 && c.nodeValue.trim()) && getComputedStyle(n).color === 'rgb(0, 0, 0)').map(n => n.className)"), []);
        await evaluate("setThemeMode('light')");
        await evaluate("document.querySelector('#sw-new .icon-circle').click()"); await until("!document.getElementById('sw-new')");
        for (const channel of ['sessions:clis', 'sessions:new', 'sessions:pick-folder']) ipcMain.removeHandler(channel);
        console.log('PASS 0.3.16 new chat / new project: folder picker then tool choice, uninstalled CLI disabled, start passes tool and folder, defaults to the current session, failure shown in dialog, Esc closes, dark mode');
      }
      console.log('PASS session management list, filters, copy path and streamed in-app reply');
      egressNow = Date.now();
      await evaluate("navigate('egress')");
      await until("document.querySelectorAll('#page-egress .egress-card').length === 3");
      assert.equal(await evaluate("document.getElementById('usage-summary').hidden && document.getElementById('usage-filters').hidden"), true);
      assert.equal(await evaluate("document.getElementById('egress-toggle').getAttribute('aria-checked')"), 'false');
      // 0.3.16：检测间隔自己定（5–60 秒，默认 10）
      assert.equal(await evaluate("document.getElementById('egress-interval').value"), '10');
      assert.match(await evaluate("document.getElementById('egress-status-sub').textContent"), /每 10 秒检查一次/);
      await evaluate("(() => { const i = document.getElementById('egress-interval'); i.value = '3'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
      await evaluate("document.getElementById('egress-save').click()");
      await until("/5 到 60/.test(document.getElementById('egress-message').textContent)");
      assert.equal(await evaluate("window.tokenpulse.egressState().then(s => s.config.intervalSeconds)"), 10, '不合法的间隔不保存');
      await evaluate("(() => { const i = document.getElementById('egress-interval'); i.value = '30'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
      await evaluate("document.getElementById('egress-save').click()");
      await until("window.tokenpulse.egressState().then(s => s.config.intervalSeconds === 30 && s.intervalMs === 30000)");
      await until("/每 30 秒检查一次/.test(document.getElementById('egress-status-sub').textContent)");
      assert.equal(await evaluate("document.getElementById('egress-interval').value"), '30');
      assert.equal(await evaluate("document.getElementById('page-egress').scrollWidth <= document.getElementById('page-egress').clientWidth + 1"), true, '监控页不能横向溢出');
      assert.equal(await evaluate("getComputedStyle(document.getElementById('refresh')).display"), 'none', '额度刷新按钮不出现在出口检测页');
      await evaluate("document.getElementById('egress-check').click()");
      await until("!document.getElementById('egress-check').disabled && [...document.querySelectorAll('.egress-ip')].every(n => n.textContent === '203.0.113.10')");
      // IP 数据库：三家同一个出口只查一次；归属、类型、风险、国旗都画出来
      await until("document.querySelectorAll('.egress-source').length === 6");
      assert.deepEqual(egressLookups, ['203.0.113.10'], '同一个出口 IP 只查一次数据库');
      const intelUi = await evaluate(`(() => { const card = document.querySelector('.egress-card[data-provider=chatgpt]'); return { chips: [...card.querySelectorAll('.egress-chips .egress-chip')].map(n => n.textContent), flag: card.querySelector('.egress-flag').textContent, facts: card.querySelector('.egress-facts').textContent, meter: card.querySelector('.egress-meter')?.getAttribute('aria-valuenow'), link: card.querySelector('a.egress-source-name')?.href }; })()`);
      assert.ok(intelUi.chips.includes('AS64500') && intelUi.chips.includes('机房 Hosting') && intelUi.chips.includes('风险 66'), JSON.stringify(intelUi.chips));
      assert.equal(intelUi.flag, '\u{1F1FA}\u{1F1F8}', '美国的国旗（区域指示符 U + S）');
      assert.ok(intelUi.facts.includes('Example ISP') && intelUi.meter === '66' && intelUi.link.startsWith('https://proxycheck.io/'), JSON.stringify(intelUi));
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.egress-flag')).fontFamily.includes('Twemoji Country Flags')"), true, 'Windows 上国旗要靠随包的字体');
      await evaluate("document.querySelectorAll('[data-action=allow-current]').forEach(b => b.click()); document.getElementById('egress-regions-grok').value='US'; document.getElementById('egress-regions-grok').dispatchEvent(new Event('input'))");
      egressNow += 5000;
      await evaluate("document.getElementById('egress-check').click()");
      await until("!document.getElementById('egress-check').disabled");
      assert.equal(await evaluate("document.getElementById('egress-ips-chatgpt').value"), '203.0.113.10', '后台采样不能覆盖未保存输入');
      await evaluate("document.getElementById('egress-save').click()");
      await until("window.tokenpulse.egressState().then(s => s.config.providers.grok.allowedRegions[0] === 'US')");
      await evaluate("document.getElementById('egress-toggle').click()");
      await until("document.getElementById('egress-toggle').getAttribute('aria-checked') === 'true' && !document.getElementById('egress-check').disabled");
      egressIp = '203.0.113.20'; egressRegion = 'HK'; egressNow += 5000;
      await evaluate("document.getElementById('egress-check').click()");
      await until("window.tokenpulse.egressState().then(s => !s.checking && s.providers.every(p => p.row?.ip === '203.0.113.20'))");
      assert.equal(egressNotifications.length, 0, '第一次风险不弹系统通知');
      egressNow += 5000;
      await evaluate("document.getElementById('egress-check').click()");
      await until("document.querySelectorAll('#egress-events .warning').length === 3");
      assert.equal(egressNotifications.length, 3);
      assert.equal(await evaluate("document.getElementById('nav-egress-alert').textContent"), '3');
      // 出口换了才查新 IP；同一个 IP 探测了好几轮也不重复查
      assert.deepEqual(egressLookups, ['203.0.113.10', '203.0.113.20'], JSON.stringify(egressLookups));
      assert.equal(await evaluate("document.querySelector('.egress-card[data-provider=grok] .egress-flag').textContent"), '\u{1F1ED}\u{1F1F0}', '换到香港后国旗跟着换');
      egressNow += 5000;
      await evaluate("document.getElementById('egress-check').click()");
      await until("!document.getElementById('egress-check').disabled");
      assert.equal(egressNotifications.length, 3, '持续相同风险不能重复通知');
      await evaluate("document.getElementById('egress-ips-chatgpt').value='not-an-ip'; document.getElementById('egress-ips-chatgpt').dispatchEvent(new Event('input')); document.getElementById('egress-save').click()");
      await until("document.getElementById('egress-message').getAttribute('role') === 'alert'");
      assert.equal(await evaluate("window.tokenpulse.egressState().then(s => s.config.providers.chatgpt.allowedIps[0])"), '203.0.113.10');
      await evaluate("document.getElementById('egress-toggle').click()");
      await until("document.getElementById('egress-toggle').getAttribute('aria-checked') === 'false'");
      assert.equal(await evaluate("document.getElementById('egress-ips-chatgpt').value"), 'not-an-ip', '暂停保留草稿且不被无效草稿阻止');
      await evaluate("document.querySelector('.egress-history button').click()");
      await until("document.querySelectorAll('#egress-events .egress-event').length === 0");
      await evaluate("navigate('overview')");
      console.log('PASS exit monitor navigation, three providers, drafts, allowlists, alerts, deduplication, validation and safe pause');

      // UI 回归仅使用 DOM、布局与计算样式断言，不生成或读取截图。
      ipcMain.removeHandler('refresh');
      ipcMain.handle('refresh', () => { throw new Error('Simulated scan failure'); });
      await evaluate("document.getElementById('refresh').click()");
      await until("!document.getElementById('refresh').disabled && !document.getElementById('app-status').hidden");
      assert.match(await evaluate("document.getElementById('app-status').textContent"), /刷新失败/);
      console.log('PASS failed refresh shows an error and re-enables the button');
      assert.equal(await evaluate("document.querySelector('[data-page=comparison]') === null && !window.tokenpulse.comparisonQuery"), true);
      assert.equal(await evaluate("window.tokenpulse.readPrefs().then(p => p.startMinimized)"), false,
        '--hidden must not persist startMinimized');
      clearInterval(heartbeat); clearTimeout(watchdog);
      app.exit(0);
    } catch (error) {
      console.error('FAIL', error.stack || error.message);
      app.exit(1);
    }
  });
});
if (process.env.TOKENPULSE_TEST_APP) {
  // Test the shipped ASAR with Electron, keeping login-item registration disabled.
  const icons = require(path.join(appRoot, 'build/main/icon.js'));
  const resources = path.dirname(appRoot);
  icons.trayIcon = () => nativeImage.createFromPath(path.join(resources, 'packaging/tray.png'));
  icons.windowIcon = () => nativeImage.createFromPath(path.join(resources, 'packaging/icon.png'));
}
require(path.join(appRoot, 'build/main/index.js'));
