// Run with Electron. Quota requests deliberately stay pending while we exercise the real UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, ipcMain, nativeImage, dialog, BrowserWindow } = require('electron');
const appRoot = process.env.TOKENPULSE_TEST_APP || path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-ui-'));
process.env.TOKENPULSE_DATA_DIR = path.join(temp, 'data');
app.setPath('userData', path.join(temp, 'electron'));
// Synthetic rows are confined to the test data directory, never to the real ledger.
const fixtureNow = Date.now(), hour = 3600000;
const iso = at => new Date(at).toISOString();
const dayKey = require('../renderer/data.js').dayKey;
const dataPath = process.env.TOKENPULSE_DATA_DIR;
fs.mkdirSync(dataPath, { recursive: true });
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
      const evaluate = code => contents.executeJavaScript(code);
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
      await until("document.getElementById('prefs-status').textContent.includes('已保存')");
      assert.equal(await evaluate("window.tokenpulse.readPrefs().then(p => p.notifyAt)"), 90);
      assert.match(await evaluate("document.getElementById('pref-notifyAt').textContent"), /90%/);
      await evaluate("document.querySelector('[data-settings-tab=accounts]').click()");
      assert.equal(await evaluate("document.querySelector('[data-panel=general]').hidden"), true);
      // 账号列表在设置窗口打开后才异步加载（要探测 CLI），先等它出来。
      await until("document.querySelectorAll('#official-accounts .oauth-card').length === 3");
      assert.match(await evaluate("document.getElementById('official-accounts').textContent"), /添加账号|未检测到官方 CLI/);
      assert.doesNotMatch(await evaluate("document.getElementById('official-accounts').innerHTML"), /token|access_token|refresh/i);
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
      assert.equal(await evaluate("document.body.textContent.includes('本机 CLI') || document.body.textContent.includes('本机持续记录') || document.body.textContent.includes('数据只保存在本机')"), false);
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
      await evaluate("document.querySelector('[data-cap-window=five]').click(); document.querySelector('[data-cap-metric=costUsd]').click()");
      assert.equal(await evaluate("state.capWindow + '/' + state.capMetric"), 'five/costUsd');
      assert.equal(await evaluate("Boolean(document.querySelector('.capacity-chart svg, .capacity-chart .empty'))"), true);
      await evaluate("document.querySelector('[data-cap-window=week]').click(); document.querySelector('[data-cap-metric=tokens]').click()");
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
      await evaluate("document.getElementById('model-search').value='QA-model'; document.getElementById('model-search').dispatchEvent(new Event('input'))");
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
      assert.match(await evaluate("document.getElementById('records').textContent"), /没有匹配/);
      assert.equal(await evaluate("document.getElementById('export-csv').disabled"), true);
      await evaluate("document.getElementById('source-filter').value='all'; document.getElementById('source-filter').dispatchEvent(new Event('change')); document.getElementById('model-search').value=''; document.getElementById('model-search').dispatchEvent(new Event('input')); document.querySelector('[data-page=overview]').click()");
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
          assert.equal(await evaluate("document.querySelector('.sw-live-tools')?.textContent.includes('Read')"), true);
          assert.equal(await evaluate("document.querySelector('.sw-composer textarea').value"), '');
          await until("!document.querySelector('.sw-row.pending') && document.querySelector('.sw-send').textContent.includes('发送')");
          assert.deepEqual({ ...sent, id: undefined, kind: undefined }, { kind: undefined, id: undefined, prompt: 'QA 提问', mode: 'edit' });
          assert.equal(`${sent.kind}:${sent.id}`, target);
          ipcMain.removeHandler('sessions:reply');
        }
      }
      console.log('PASS session management list, filters, copy path and streamed in-app reply');
      if (process.env.TOKENPULSE_SCREENSHOT) {
        await delay(200);
        fs.writeFileSync(process.env.TOKENPULSE_SCREENSHOT, (await contents.capturePage()).toPNG());
      }
      ipcMain.removeHandler('refresh');
      ipcMain.handle('refresh', () => { throw new Error('Simulated scan failure'); });
      await evaluate("document.getElementById('refresh').click()");
      await until("!document.getElementById('refresh').disabled && !document.getElementById('app-status').hidden");
      assert.match(await evaluate("document.getElementById('app-status').textContent"), /刷新失败/);
      console.log('PASS failed refresh shows an error and re-enables the button');
      assert.equal(await evaluate("window.tokenpulse.readPrefs().then(p => p.startMinimized)"), false,
        '--hidden must not persist startMinimized');
      clearInterval(heartbeat); clearTimeout(watchdog);
      app.exit(0);
    } catch (error) {
      console.error('FAIL', error.message);
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
