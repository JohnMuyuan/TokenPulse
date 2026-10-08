const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-agent-ui-'));
const home = path.join(root, 'home');
process.env.HOME = process.env.USERPROFILE = home;
process.env.AGENT_SWITCH_HOME = home;
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.AGENT_SWITCH_CC_DB = path.join(root, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
// Prism 桥已下线，只有装过的人（数据目录还在）才看得到那一页：这里放一个空的数据目录当作「装过」
fs.mkdirSync(path.join(root, 'data', 'prism-bridge'), { recursive: true });
// 以前保存下来的转发记录（上个月 130 条）：转发记录页要能翻到它们
fs.mkdirSync(path.join(root, 'data', 'route-log'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'route-log', '2026-09.jsonl'), Array.from({ length: 130 }, (_, i) => JSON.stringify({ at: Date.UTC(2026, 8, 10), app: 'grok', providerId: 'old-' + (i % 3), provider: 'Old pool · ' + (i % 3), model: 'grok-qa', status: i === 129 ? 502 : 200, ms: 100 + i, attempt: 1, input: 1000 + i, output: 10, ...(i === 129 ? { error: 'boom' } : {}) })).join('\n') + '\n');
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { keep: true }, env: { DISABLE_TELEMETRY: '1' } }));
fs.writeFileSync(path.join(root, 'data', 'prefs.json'), JSON.stringify({ autoLaunch: false, autoUpdate: false, closeToTray: true, startMinimized: true, language: 'zh', notifyAt: 0, notifyMismatch: false, ccSwitch: false, seenVersion: require('../package.json').version, onboarding: 'done' }));
app.setPath('userData', path.join(root, 'electron'));
app.commandLine.appendSwitch('lang', 'zh-CN');
const watchdog = setTimeout(() => { console.error('FAIL agent switch UI timed out'); app.exit(1); }, 40000);
app.whenReady().then(() => {});
app.on('web-contents-created', (_event, contents) => contents.once('did-finish-load', async () => {
  const evaluate = code => contents.executeJavaScript(code).catch(error => { throw new Error(error.message + ' ← ' + String(code).slice(0, 200)); });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async code => {
    const end = Date.now() + 10000;
    while (!await evaluate(`Promise.resolve(${code}).then(v => !!v)`)) {
      assert.ok(Date.now() < end, 'Timed out: ' + code);
      await delay(40);
    }
  };
  try {
    // 0.3.9 起改工具配置前会弹对比确认；这个测试不是测确认框，自动点「确认写入」（确认框在 test-agent-guard-ui.cjs 里单独测）
    await evaluate("setInterval(() => document.querySelector('#pv-confirm .btn-accent')?.click(), 40)");
    const P = '#page-providers';
    const settings = () => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    const nav = id => evaluate(`document.querySelector('${P} .pv-nav [data-section=${id}]').click()`);
    const addButton = `[...document.querySelectorAll('${P} .pv-head-actions button')].find(b => b.textContent.includes('添加供应商'))`;
    await until("document.querySelector('[data-page=providers]')");
    await evaluate("navigate('providers')");
    // 概览：二级菜单 + 三家工具卡，没有 Gemini
    await until(`document.querySelectorAll('${P} .pv-nav .pv-nav-item').length === 11 && document.querySelectorAll('${P} .pv-app-card').length === 4`);
    assert.equal(await evaluate(`document.querySelector('${P}').innerText.includes('Gemini')`), false, '页面上不能再有 Gemini');
    assert.equal(await evaluate(`document.querySelector('${P} .pv-nav-item.on').dataset.section`), 'overview');
    // 转发记录（0.3.34）：永久保存，说明卡里能打开记录文件夹；0.3.38 起一页 20 条，翻到还没读的页再去读更早的；0.3.39 起有页码、能直接跳页
    await nav('logs');
    const pagerText = () => evaluate(`document.querySelector('${P} .pv-log-label').textContent`);
    const pageTokens = () => evaluate(`[...document.querySelectorAll('${P} .pv-log-tokens')].map(e => e.textContent)`);
    const pagerState = () => evaluate(`[...document.querySelectorAll('${P} [data-action=logs-prev], ${P} [data-action=logs-next]')].map(b => b.disabled)`);
    const pageNumbers = () => evaluate(`[...document.querySelectorAll('${P} .pv-log-pages > *')].map(e => e.classList.contains('on') ? '[' + e.textContent + ']' : e.textContent).join(' ')`);
    const atPage = (page, rows = 20) => until(`(document.querySelector('${P} .pv-log-label')?.textContent || '').startsWith('第 ${page} /') && document.querySelectorAll('${P} .pv-log-row').length === ${rows}`);
    await until(`document.querySelectorAll('${P} .pv-log-row').length === 20`);
    // 第一批就数好了一共多少条：一开始就知道共几页
    assert.equal(await pagerText(), '第 1 / 7 页 · 共 130 条转发');
    assert.deepEqual(await pagerState(), [true, false], '第一页：不能往前，可以往后');
    assert.equal(await pageNumbers(), '[1] 2 3 … 7');
    assert.match(await evaluate(`document.querySelector('${P} .pv-head p, ${P} .pv-head small')?.textContent || document.querySelector('${P}').textContent`), /一页 20 条，可以一直往前翻到最早的/);
    assert.equal((await evaluate(`document.querySelector('${P}').textContent`)).includes('最多 30 条'), false, '旧说法不能留着');
    assert.match(await evaluate(`document.querySelector('${P} .pv-log-keep').textContent`), /保存在本机.*不会自动清理.*不记请求和回复的内容.*打开记录文件夹/);
    assert.deepEqual(await evaluate(`(() => { const r = document.querySelector('${P} .pv-log-row'); return [r.classList.contains('bad'), r.querySelector('b').textContent, r.querySelector('.pv-log-tokens').textContent, r.querySelector('.pv-log-error').textContent]; })()`), [true, 'Old pool · 0', '1129 / 10', 'boom'], '最新的在最上面，带 Token 数和报错');
    const seenTokens = await pageTokens();
    // 直接跳到第 6 页：已读的只有 5 页，跳过去时接着读，读到了就显示
    await evaluate(`(() => { const input = document.querySelector('${P} .pv-log-jump-input'); input.value = '6'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await atPage(6);
    assert.equal(await pageNumbers(), '1 … 4 5 [6] 7');
    // 点页码
    await evaluate(`document.querySelector('${P} .pv-log-num[data-page="4"]').click()`);
    await atPage(4);
    await evaluate(`document.querySelector('${P} .pv-log-num[data-page="1"]').click()`);
    await atPage(1);
    // 跳的页数超出范围：落到最后一页
    await evaluate(`(() => { const input = document.querySelector('${P} .pv-log-jump-input'); input.value = '99'; document.querySelector('${P} [data-action=logs-jump]').click(); })()`);
    await atPage(7, 10);
    await evaluate(`document.querySelector('${P} .pv-log-num[data-page="1"]').click()`);
    await atPage(1);
    // 下一页一页页翻到底：130 条不漏不重
    for (let page = 2; page <= 7; page++) {
      await evaluate(`document.querySelector('${P} [data-action=logs-next]').click()`);
      await atPage(page, page === 7 ? 10 : 20);
      seenTokens.push(...await pageTokens());
    }
    assert.equal(await pagerText(), '第 7 / 7 页 · 共 130 条转发');
    assert.deepEqual(await pagerState(), [false, true], '最后一页：不能再往后');
    assert.equal(new Set(seenTokens).size, 130, '同毫秒、同供应商的旧记录不漏页，也不被去重丢掉');
    assert.equal(await evaluate(`[...document.querySelectorAll('${P} .pv-log-row .pv-log-ms')].at(-1).textContent`), '100 ms', '最后一页最下面是最早的那条');
    await evaluate(`document.querySelector('${P} [data-action=logs-prev]').click()`);
    await atPage(6);
    assert.equal(await pagerText(), '第 6 / 7 页 · 共 130 条转发');
    // 透明转发（0.3.35）：说明做什么 / 不做什么，Claude Code 和 Codex 各一个开关，默认关；下面是量到的速度
    await nav('pass');
    await until(`document.querySelectorAll('${P} .pv-route-row .pv-switch').length === 3 && document.querySelector('${P} [data-action=open-speed]')`);
    assert.match(await evaluate(`document.querySelector('${P} .pv-pass-what').textContent`), /一个字节都不动.*型号核验.*不保存、不读取登录凭据.*不保存请求和回复的内容.*只在本机.*恢复直连/);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${P} .pv-route-row')].map(r => [r.querySelector('b').textContent, r.querySelector('.pv-switch').getAttribute('aria-checked'), r.querySelector('.pv-switch').disabled, r.querySelector('small').textContent])`), [['Claude Code', 'false', false, '直连官方，没有测速。'], ['Codex', 'false', false, '直连官方，没有测速。'], ['Grok CLI', 'false', false, '直连官方，没有测速。']]);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${P} .pv-route-row')].map(r => /Remote Control/.test(r.querySelector('.pv-pass-warn')?.textContent || ''))`), [true, false, false], '只在 Claude Code 那一行提醒 Remote Control 用不了');
    assert.equal(await evaluate(`document.querySelector('${P} .pv-nav [data-section=pass] small').textContent`), '已关闭');
    // 换一个空闲端口：默认端口可能正被这台机器上在用的 TokenPulse 占着
    const passPort = await new Promise(resolve => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const v = s.address().port; s.close(() => resolve(v)); }); });
    await evaluate(`window.tokenpulse.agentPort(${passPort})`);
    await evaluate(`document.querySelector('${P} .pv-route-row .pv-switch').click()`);
    await until(`document.querySelector('${P} .pv-route-row .pv-switch').getAttribute('aria-checked') === 'true'`);
    assert.match(settings().env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+\/pass\/claude$/, '只加了接口地址');
    assert.deepEqual([settings().hooks, settings().env.DISABLE_TELEMETRY], [{ keep: true }, '1'], '别的设置不动');
    assert.match(await evaluate(`document.querySelector('${P} .pv-route-row small').textContent`), /已打开：Claude Code 连 http:\/\/127\.0\.0\.1:\d+\/pass\/claude，原样转给官方/);
    assert.equal(await evaluate(`document.querySelector('${P} .pv-nav [data-section=pass] small').textContent`), '测速中 · 1 家');
    // 仍然算官方登录：Claude Code 那一页的当前供应商是官方
    assert.equal(await evaluate(`document.querySelector('${P} .pv-nav [data-section=claude] small').textContent`), 'Claude 官方');
    // 量到的速度来自保存的转发记录（0.3.39 起在额度详情「全部模型的速度」）：放几条进去，按型号 × 思考等级取中位数
    const month = new Date(), speedFile = path.join(root, 'data', 'route-log', `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}.jsonl`);
    const speedRow = (speed, first, i, extra = {}) => JSON.stringify({ at: Date.now() - 60000 * (i + 1), app: 'claude', providerId: 'pass-claude', provider: '官方登录（透明转发）', model: 'claude-qa-5', requestModel: 'claude-qa-5', status: 200, ms: 9000, pass: true, firstByteMs: 900, firstTokenMs: first, tokensPerSec: speed, input: 100, output: 700, ...extra });
    fs.writeFileSync(speedFile, [...[[80, 1200], [100, 1500], [120, 2400]].map(([speed, first], i) => speedRow(speed, first, i)), speedRow(98, 6000, 5, { effort: 'max' }), speedRow(undefined, 800, 6, { model: 'short-only', requestModel: 'short-only', output: 5 })].join('\n') + '\n');
    // 透明转发页只留一句话和按钮，点了去用量明细的「模型速度走势」折线图
    assert.equal(await evaluate(`document.querySelector('${P} .pv-speed')`), null, '透明转发页不再放速度表');
    assert.match(await evaluate(`document.querySelector('${P} [data-action=open-speed]').closest('section').textContent`), /量到的速度在「用量明细」里.*思考等级分开一条线.*永久保存/);
    await evaluate(`document.querySelector('${P} [data-action=open-speed]').click()`);
    const SPEED = '.speed-lines-panel';
    await until(`state.page === 'usage' && document.querySelectorAll('${SPEED} .speed-lines-chip').length === 2`);
    const chips = () => evaluate(`[...document.querySelectorAll('${SPEED} .speed-lines-chip')].map(c => [c.querySelector('.speed-lines-name').textContent, c.querySelector('small').textContent, c.querySelector('b').textContent, c.getAttribute('aria-pressed')])`);
    assert.deepEqual(await chips(), [['claude-qa-5', '官方登录（透明转发）', '100', 'true'], ['claude-qa-5 · max', '官方登录（透明转发）', '98', 'true']], '思考等级分开一条线，图例写整段时间的中位速度');
    assert.equal(await evaluate(`document.querySelector('${SPEED} [data-speed-range].on').dataset.speedRange`), '0', '默认看全部');
    assert.ok(await evaluate(`document.querySelectorAll('${SPEED} .speed-lines-dot').length >= 2`), '每条线至少一个点');
    // 换成首字：图例里的数字跟着换
    await evaluate(`document.querySelector('${SPEED} [data-speed-metric=first]').click()`);
    await until(`document.querySelector('${SPEED} .speed-lines-chip b').textContent === '1.5 秒'`);
    assert.deepEqual((await chips()).map(c => c[2]), ['1.5 秒', '6 秒', '0.8 秒'], '首字独立纳入没有速度的短回复');
    assert.equal((await chips())[2][0], 'short-only');
    // 点图例关掉一条线
    await evaluate(`document.querySelectorAll('${SPEED} .speed-lines-chip')[1].click()`);
    await until(`document.querySelectorAll('${SPEED} .speed-lines-chip')[1].getAttribute('aria-pressed') === 'false'`);
    assert.match(await evaluate(`document.querySelector('${SPEED} .speed-lines-bar').textContent`), /2 \/ 3 条线/);
    await evaluate(`document.querySelectorAll('${SPEED} .speed-lines-chip')[1].click()`);
    await evaluate(`document.querySelector('${SPEED} [data-speed-metric=speed]').click()`);
    assert.equal((await chips()).length, 2, '速度图不把缺失速度显示成零');
    // 旧范围 IPC 故意延迟：新请求先返回、旧请求再返回，DOM 必须始终属于选中的 7 天。
    const ranges = [];
    let finishOld, failRange = true;
    const sample = model => { const now = Date.now(), at = now - 3600000; return { from: at, to: now, bucketMs: 3600000, total: 1, lines: [{ app: 'claude', model, via: '', effort: '', fast: false, count: 1, speedCount: 1, firstCount: 1, tokensPerSec: 42, firstTokenMs: 900, lastAt: now, buckets: [{ at, count: 1, speedCount: 1, firstCount: 1, tokensPerSec: 42, firstTokenMs: 900 }] }] }; };
    ipcMain.removeHandler('pass-speed:series');
    ipcMain.handle('pass-speed:series', (_event, days) => {
      ranges.push(days);
      if (days === 30) return new Promise(resolve => { finishOld = () => resolve(sample('ONLY_30_DAY_DATA')); });
      if (days === 1 && failRange) return null;
      return sample('ONLY_7_DAY_DATA');
    });
    try {
      await evaluate(`window.speedBeforeRange = document.querySelector('${SPEED} .speed-lines-chart svg'); window.speedHeightBefore = document.querySelector('${SPEED} .speed-lines-body').getBoundingClientRect().height`);
      await evaluate(`document.querySelector('${SPEED} [data-speed-range="30"]').click()`);
      while (!finishOld) { await delay(10); assert.ok(ranges.length <= 1); }
      assert.equal(await evaluate(`document.querySelector('${SPEED} .speed-lines-chart svg') === window.speedBeforeRange`), true, '等待新范围时保留原图，不能闪成加载占位');
      assert.equal(await evaluate(`document.querySelector('${SPEED} .speed-lines-body').getBoundingClientRect().height === window.speedHeightBefore`), true, '等待范围时面板高度不跳动');
      assert.equal(await evaluate(`document.querySelector('${SPEED} .speed-lines-body').getAttribute('aria-busy')`), 'true');
      assert.match(await evaluate(`document.querySelector('${SPEED} .speed-lines-status').textContent`), /暂显示上次结果/);
      await evaluate(`document.querySelector('${SPEED} [data-speed-range="7"]').click()`);
      await until(`document.querySelector('${SPEED} .speed-lines-name')?.textContent === 'ONLY_7_DAY_DATA'`);
      finishOld();
      // IPC ordering barrier: resolving this invoke follows delivery of the old response to this renderer.
      await evaluate('window.tokenpulse.passSpeedSeries(7)');
      await delay(80);
      assert.deepEqual(ranges.slice(0, 2), [30, 7], '新范围没有被 loading 丢弃');
      assert.equal(await evaluate(`document.querySelector('${SPEED} [data-speed-range].on').dataset.speedRange`), '7');
      assert.equal((await chips())[0][0], 'ONLY_7_DAY_DATA', '旧范围结果不能覆盖新范围');
      assert.equal(await evaluate(`document.querySelector('${SPEED} .speed-lines-body').getAttribute('aria-busy')`), 'false');
      assert.equal(await evaluate(`document.querySelector('${SPEED} .speed-lines-status span').textContent`), '');
      await evaluate(`window.speedBeforeFailure = document.querySelector('${SPEED} .speed-lines-chart svg'); document.querySelector('${SPEED} [data-speed-range="1"]').click()`);
      await until(`document.querySelector('${SPEED} .speed-lines-status').textContent.includes('失败')`);
      assert.equal(await evaluate(`document.querySelector('${SPEED} .speed-lines-chart svg') === window.speedBeforeFailure`), true, '范围读取失败保留原图');
      assert.equal((await chips())[0][0], 'ONLY_7_DAY_DATA');
      failRange = false;
      await evaluate(`document.querySelector('${SPEED} [data-action=speed-lines-retry]').click()`);
      await until(`document.querySelector('${SPEED} .speed-lines-status span').textContent === '' && document.querySelector('${SPEED} [data-action=speed-lines-retry]').hidden`);
      console.log('PASS speed graph DOM: short replies appear in first-token mode; delayed old ranges cannot replace the selected range');
    } finally {
      finishOld?.();
      ipcMain.removeHandler('pass-speed:series');
      ipcMain.handle('pass-speed:series', (_event, days) => require('../build/core/pass-speed').speedSeries(Math.max(0, Math.min(3650, Number(days) || 0))));
    }
    await evaluate(`document.querySelector('${SPEED} [data-speed-range="0"]').click()`);
    await until(`document.querySelectorAll('${SPEED} .speed-lines-chip').length === 2`);
    await evaluate("navigate('providers')"); await nav('pass');
    // 真的转发一次（官方接口换成本机假上游）：转发记录里这一行带首字延迟和速度
    const fakeOfficial = http.createServer((req, res) => { req.resume(); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":50,"output_tokens":1}}}\n\n');
      setTimeout(() => { res.write('data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n'); }, 60);
      setTimeout(() => res.end('data: {"type":"message_delta","usage":{"output_tokens":90}}\n\n'), 400);
    }); });
    await new Promise(resolve => fakeOfficial.listen(0, '127.0.0.1', resolve));
    process.env.AGENT_SWITCH_PASS_BASE = `http://127.0.0.1:${fakeOfficial.address().port}`;
    try {
      const status = await new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port: passPort, method: 'POST', path: '/pass/claude/v1/messages', headers: { 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end(JSON.stringify({ model: 'claude-live-5', stream: true })); });
      assert.equal(status, 200);
    } finally { delete process.env.AGENT_SWITCH_PASS_BASE; fakeOfficial.close(); fakeOfficial.closeAllConnections?.(); }
    await nav('logs');
    await evaluate('window.PulseProviders.show()');
    await until(`document.querySelector('${P} .pv-log-row .pv-log-speed')`);
    const liveRow = await evaluate(`(() => { const r = document.querySelector('${P} .pv-log-row'); return [r.querySelector('b').textContent, r.querySelector('.pv-log-model').textContent, r.querySelector('.pv-log-ms').textContent, r.querySelector('.pv-log-tokens').textContent, r.querySelector('.pv-log-speed').textContent]; })()`);
    assert.deepEqual(liveRow.slice(0, 2).concat(liveRow[3]), ['官方登录（透明转发）', 'claude-live-5', '50 / 90']);
    assert.match(liveRow[2], /^[\d.]+ 秒 · [\d.]+ 秒$/, '首字延迟 · 总耗时');
    assert.match(liveRow[4], /^[\d.]+ Token\/秒$/);
    // 关掉：配置回到原样
    fs.unlinkSync(speedFile);
    await nav('pass');
    await evaluate(`document.querySelector('${P} .pv-route-row .pv-switch').click()`);
    await until(`document.querySelector('${P} .pv-route-row .pv-switch').getAttribute('aria-checked') === 'false'`);
    assert.deepEqual(settings(), { hooks: { keep: true }, env: { DISABLE_TELEMETRY: '1' } }, '关闭后恢复直连');
    console.log('PASS agent switch UI: pass-through page explains what it does, switches per tool, shows measured speed per model, and the forwarding log shows delay and speed');
    // Prism 桥（0.3.19）：全新环境下四步都没做，只有「安装运行环境」和「添加到 Codex 供应商」能点；先写明风险
    await nav('prism');
    await until(`document.querySelectorAll('${P} .pv-prism-step').length === 4`);
    // 下线说明在最上面；不再写「适合谁用」
    assert.match(await evaluate(`document.querySelector('${P} [data-warn=retired]').textContent`), /已经下线.*只剩 6 Luna.*全部删除/);
    assert.equal(await evaluate(`document.querySelectorAll('${P} .pv-prism-fit-row').length`), 0);
    assert.deepEqual(await evaluate(`[document.querySelector('${P} .pv-prism-hero b').textContent, document.querySelector('${P} .pv-prism-hero .btn-accent').textContent, document.querySelector('${P} .pv-prism-step.current').dataset.step, document.querySelectorAll('${P} .pv-prism-step.later').length, document.querySelector('${P} .pv-prism-logbox').open]`), ['还没有装运行环境', '安装运行环境', 'deps', 3, false], '总状态指出下一步，当前步骤高亮，日志平时收着');
    assert.equal(await evaluate(`document.querySelectorAll('${P} .pv-prism-models .pv-member').length`), 1, '列出能用的模型');
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${P} .pv-prism-step')].map(s => [s.dataset.step, s.classList.contains('done'), [...s.querySelectorAll('button.btn')].map(b => b.disabled)])`), [['deps', false, [false]], ['login', false, [true]], ['service', false, [true]], ['provider', false, [false]]]);
    assert.equal(await evaluate(`document.querySelector('${P} .pv-nav [data-section=prism] small').textContent`), '已停止');
    await evaluate(`document.querySelector('${P} [data-step=provider] button.btn').click()`);
    await until(`[...document.querySelectorAll('${P} [data-step=provider] button.btn')].map(b => b.textContent).join('|') === '更新供应商|在 Codex 里启用'`);
    const prismStore = JSON.parse(fs.readFileSync(path.join(root, 'data', 'agent-switch.json'), 'utf8')).providers.find(p => p.name === 'Prism 桥');
    assert.deepEqual([prismStore.app, prismStore.endpoint.baseUrl, prismStore.endpoint.upstream, prismStore.endpoint.model, prismStore.slots.length], ['codex', 'http://127.0.0.1:18765/v1', 'openai-responses', 'gpt-6-luna', 1]);
    assert.ok(prismStore.endpoint.apiKey.length >= 20 && !(await evaluate(`document.querySelector('${P}').innerHTML`)).includes(prismStore.endpoint.apiKey), '密钥不出现在页面上');
    // 0.3.21：常见问题四条（额度、用量、上下文、思考强度），平时收着
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${P} .pv-prism-faq details')].map(d => [d.open, /额度|用量|上下文|思考强度/.test(d.querySelector('summary').textContent), d.querySelector('p').textContent.length > 20])`), [[false, true, true], [false, true, true], [false, true, true], [false, true, true]]);
    assert.match(await evaluate(`document.querySelector('${P} .pv-prism-faq details p').textContent`), /不扣 Codex 的额度/);
    // 0.3.20：日志文件按钮；一键删除要点两次，删完供应商和数据目录都没了，页面回到全新状态
    assert.equal(await evaluate(`document.querySelector('${P} .pv-prism-logbox summary .btn').textContent`), '打开日志文件');
    assert.equal(fs.existsSync(path.join(root, 'data', 'prism-bridge')), true);
    const removeButton = `document.querySelector('${P} .pv-prism-remove .btn')`;
    assert.match(await evaluate(`document.querySelector('${P} .pv-prism-remove').textContent`), /运行环境.*Chromium.*登录信息.*供应商.*不会动/);
    await evaluate(`${removeButton}.click()`);
    assert.equal(await evaluate(`${removeButton}.textContent`), '再点一次，确认删除', '第一次点只是要求确认');
    assert.equal(fs.existsSync(path.join(root, 'data', 'prism-bridge')), true);
    await evaluate(`${removeButton}.click()`);
    // 删完之后这一页和导航里的入口都没了，回到概览
    await until(`!document.querySelector('${P} .pv-nav [data-section=prism]') && !document.querySelector('${P} .pv-prism-remove') && document.querySelectorAll('${P} .pv-nav .pv-nav-item').length === 10`);
    assert.equal(fs.existsSync(path.join(root, 'data', 'prism-bridge')), false, '数据目录里的 prism-bridge 整个删掉');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'agent-switch.json'), 'utf8')).providers.some(p => p.name === 'Prism 桥'), false, 'Codex 里的供应商也去掉');
    await nav('desktop');
    await until(`document.querySelector('${P} .pv-head h2')?.textContent === 'Claude 桌面端'`);
    assert.equal(await evaluate(`document.querySelector('${P} .pv-nav-item.on').dataset.section`), 'desktop', '点 Claude 桌面端必须留在这一页');
    await nav('overview');
    await nav('grok');
    await evaluate("[...document.querySelectorAll('#page-providers button')].find(b => b.textContent.trim() === '添加供应商').click()");
    await until("document.querySelector('#page-providers .pv-editor')");
    await evaluate("document.querySelector('#page-providers .pv-editor').requestSubmit()");
    assert.equal(await evaluate("document.querySelector('#page-providers .pv-nav-item.on').dataset.section"), 'edit-basic');
    await evaluate("document.querySelector('#page-providers .pv-editor input[name=name]').value = 'QA Grok'");
    await evaluate("document.querySelector('#page-providers .pv-editor').requestSubmit()");
    assert.equal(await evaluate("document.querySelector('#page-providers .pv-nav-item.on').dataset.section"), 'edit-connect', '隐藏的必填模型不应阻止跳到缺失连接字段');
    await evaluate("document.querySelector('#page-providers [data-section=edit-back]').click()");
    assert.equal(await evaluate("!!document.querySelector('.tp-toast.pv-unsaved')"), true, '离开编辑不能静默丢失修改');
    await evaluate("[...document.querySelectorAll('.tp-toast.pv-unsaved button')].find(b => b.textContent === '继续编辑').click()");
    assert.equal(await evaluate("document.querySelector('#page-providers input[name=name]').value"), 'QA Grok');
    await evaluate("document.querySelector('#page-providers [data-section=edit-back]').click()");
    await evaluate("[...document.querySelectorAll('.tp-toast.pv-unsaved button')].find(b => b.textContent === '放弃修改').click()");
    await nav('overview');
    // Local models fixture: no external account, no image or screenshot APIs.
    const modelsServer = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'qa-model-a' }, { id: 'qa-model-b' }] })); });
    await new Promise(resolve => modelsServer.listen(0, '127.0.0.1', resolve));
    try {
      const modelUrl = 'http://127.0.0.1:' + modelsServer.address().port + '/v1';
      for (const tool of ['grok', 'codex']) {
        await nav(tool);
        await evaluate(addButton + '.click()');
        await until("document.querySelector('#page-providers .pv-editor')");
        await evaluate(`(() => { const form = document.querySelector('#page-providers .pv-editor'); form.elements.name.value = 'QA Models ${tool}'; form.elements.baseUrl.value = ${JSON.stringify(modelUrl)}; form.elements.apiKey.value = 'qa-key'; document.querySelector('#page-providers [data-section=edit-models]').click(); })()`);
        await evaluate("[...document.querySelectorAll('#page-providers .pv-editor button')].find(b => b.textContent === '获取模型').click()");
        await until("document.querySelectorAll('#page-providers .pv-fetched button').length === 2");
        await evaluate("document.querySelector('#page-providers .pv-fetched button').click()");
        assert.equal(await evaluate("document.querySelector('#page-providers input[name=model]').value"), 'qa-model-a');
        if (tool === 'codex') {
          await evaluate("[...document.querySelectorAll('#page-providers .pv-editor button')].find(b => b.textContent === '添加模型').click()");
          await evaluate("document.querySelectorAll('#page-providers .pv-fetched button')[1].click()");
          assert.deepEqual(await evaluate("[...document.querySelectorAll('#page-providers .pv-slot input[placeholder=\"实际请求模型\"]')].map(n => n.value)"), ['qa-model-a', 'qa-model-b'], '同角色模型必须填到第二行而不是覆盖第一行');
          await evaluate("document.querySelector('#page-providers .pv-fetched button').click()");
          assert.equal(await evaluate("document.querySelector('#page-providers input[name=model]').value"), 'qa-model-a');
          await evaluate("document.querySelector('#page-providers .pv-slot .pv-level-trigger').click();[...document.querySelectorAll('#page-providers .pv-level-option')].find(r => r.textContent.includes('low')).querySelector('input').click()");
          assert.equal(await evaluate("[...document.querySelectorAll('#page-providers .pv-level-option')].find(r => r.textContent.includes('low')).querySelector('input').checked"), false);
          await evaluate("(() => { const select = document.querySelector('#page-providers select[aria-label=\"默认思考等级\"]'); select.value = 'medium'; select.dispatchEvent(new Event('change')); })()");
          // 0.3.9 界面修复：勾选后面板不收起；面板不伸出页面；Esc 只关面板不关编辑页；Codex 模型行各列在同一行
          assert.equal(await evaluate("document.querySelector('#page-providers .pv-level-popover').hidden"), false, '勾选 / 换默认等级后面板要保持打开');
          assert.equal(await evaluate("(() => { const p = document.querySelector('#page-providers .pv-level-popover').getBoundingClientRect(), page = document.querySelector('#page-providers').getBoundingClientRect(); return p.right <= page.right + 1 && p.left >= page.left - 1; })()"), true, '等级面板不能伸出页面');
          await evaluate("document.querySelector('#page-providers .pv-level-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
          assert.equal(await evaluate("document.querySelector('#page-providers .pv-level-popover').hidden"), true, 'Esc 关掉等级面板');
          assert.ok(await evaluate("document.querySelector('#page-providers .pv-editor') !== null"), 'Esc 不能连带关掉编辑页');
          await evaluate("document.querySelector('#page-providers .pv-slot .pv-level-trigger').click()");
          await evaluate("document.querySelector('#page-providers .pv-model-head').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
          assert.equal(await evaluate("document.querySelector('#page-providers .pv-level-popover').hidden"), true, '点面板外面收起');
          assert.equal(await evaluate("(() => { const row = document.querySelector('#page-providers .pv-slot:not(.pv-slot-head)'); const tops = [...row.children].map(c => Math.round(c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2)); return Math.max(...tops) - Math.min(...tops) <= 4; })()"), true, 'Codex 模型行的输入、上下文、等级、删除在同一行');
          assert.equal(await evaluate("document.querySelectorAll('#page-providers .pv-slot-head span').length"), 5, 'Codex 模型行有列标题');
          // 快速预设只点亮对应的那一个接口格式
          await evaluate("document.querySelector('#page-providers [data-section=edit-basic]').click(); [...document.querySelectorAll('#page-providers .pv-preset-strip button')].find(b => b.textContent.includes('OpenAI Chat')).click()");
          assert.deepEqual(await evaluate("[...document.querySelectorAll('#page-providers [data-key=upstream] .pv-chip.on')].map(n => n.dataset.value)"), ['openai-chat'], '选 OpenAI Chat 预设时不能同时点亮 Responses');
          await evaluate("[...document.querySelectorAll('#page-providers .pv-preset-strip button')].find(b => b.textContent.includes('OpenAI Responses')).click()");
          assert.deepEqual(await evaluate("[...document.querySelectorAll('#page-providers [data-key=upstream] .pv-chip.on')].map(n => n.dataset.value)"), ['openai-responses']);
          // 预览跟着当前草稿走（切到预览页时重算）
          await evaluate("(() => { const input = document.querySelector('#page-providers .pv-slot:not(.pv-slot-head) input[placeholder=\"实际请求模型\"]'); input.value = 'qa-preview-model'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#page-providers [data-section=edit-preview]').click(); })()");
          assert.match(await evaluate("document.querySelector('#page-providers .pv-preview-json').textContent"), /qa-preview-model/, '预览要反映还没保存的修改');
          await evaluate("(() => { const input = document.querySelector('#page-providers .pv-slot:not(.pv-slot-head) input[placeholder=\"实际请求模型\"]'); input.value = 'qa-model-a'; input.dispatchEvent(new Event('input', { bubbles: true })); })()");
          // 高级设置：Prompt Cache 路由默认是「自动」（以前 selected=false 让所有选项都被选中，落成「关闭」）
          assert.equal(await evaluate("document.querySelector('#page-providers select[name=promptCacheRouting]').value"), 'auto');
        }
        await evaluate("(() => { const form = document.querySelector('#page-providers .pv-editor'); form.requestSubmit(); form.requestSubmit(); })()");
        await until("!document.querySelector('#page-providers .pv-editor')");
        const rows = await evaluate(`window.tokenpulse.agentState().then(s => s.providers.filter(p => p.name === 'QA Models ${tool}'))`);
        assert.equal(rows.length, 1, '重复提交不能重复新增供应商');
        assert.equal(rows[0].model, 'qa-model-a');
        assert.equal(rows[0].dailyLimitUsd, null, '没填限额不能存成 0'); assert.equal(rows[0].monthlyLimitUsd, null);
        if (tool === 'grok') assert.equal(rows[0].contextWindow, 131072, 'Grok 没改上下文时保存预设值，不写空');
        if (tool === 'codex') { assert.equal(rows[0].promptCacheRouting, 'auto'); assert.equal(rows[0].slots[1].model, 'qa-model-b'); assert.equal(rows[0].slots[0].defaultReasoningLevel, 'medium'); assert.equal(rows[0].slots[0].reasoningLevels.includes('low'), false); }
      }
    } finally { modelsServer.closeAllConnections(); await new Promise(resolve => modelsServer.close(resolve)); }
    await nav('overview');
    // 路由服务：改端口
    const port = await new Promise(resolve => {
      const server = http.createServer();
      server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
    });
    await nav('router');
    await until(`document.querySelector('${P} .pv-port')`);
    await evaluate(`(() => { const input = document.querySelector('${P} .pv-port'); input.value = '${port}'; input.dispatchEvent(new Event('change')); })()`);
    await until(`window.tokenpulse.agentState().then(state => state.proxy.port === ${port})`);
    // Claude Code：添加供应商在抽屉里
    await nav('claude');
    await until(`document.querySelector('${P} .pv-head h2')?.textContent === 'Claude Code'`);
    await evaluate(`${addButton}.click()`);
    await until(`document.querySelector('${P} .pv-editor')`);
    const fill = (name, model, key) => evaluate(`(() => { const f = document.querySelector('${P} .pv-editor'); f.elements.name.value = '${name}'; f.elements.model.value = '${model}'; f.elements.baseUrl.value = 'https://relay.example/v1'; f.elements.apiKey.value = '${key}'; f.querySelector('[type=submit]').click(); })()`);
    await fill('QA Relay', 'claude-sonnet-5', 'sk-ui-secret');
    await until(`!document.querySelector('${P} .pv-editor') && [...document.querySelectorAll('${P} .pv-row b')].some(n => n.textContent === 'QA Relay')`);
    // 启用：写进 Claude 配置，保留 hooks；界面上看不到密钥
    await evaluate(`[...document.querySelectorAll('${P} .pv-row')].find(r => r.querySelector('b').textContent === 'QA Relay').querySelector('.pv-use').click()`);
    await until(`document.querySelector('${P} .pv-current b')?.textContent === 'QA Relay'`);
    assert.equal(settings().hooks.keep, true);
    assert.equal(settings().env.DISABLE_TELEMETRY, '1');
    assert.equal(settings().env.ANTHROPIC_AUTH_TOKEN, 'sk-ui-secret');
    assert.equal(await evaluate("document.body.innerText.includes('sk-ui-secret')"), false);
    assert.match(await evaluate(`document.querySelector('${P} .pv-nav [data-section=claude] small').textContent`), /QA Relay/, '二级菜单上显示当前供应商');
    // 编辑：密钥留空就沿用原来的，只改模型
    await evaluate(`[...document.querySelectorAll('${P} .pv-current button')].find(b => b.textContent.includes('编辑')).click()`);
    await until(`document.querySelector('${P} .pv-editor')?.elements.name.value === 'QA Relay'`);
    await evaluate(`(() => { const f = document.querySelector('${P} .pv-editor'); f.elements.model.value = 'claude-opus-5'; f.querySelector('[type=submit]').click(); })()`);
    await until(`!document.querySelector('${P} .pv-editor')`);
    await until(`window.tokenpulse.agentState().then(s => s.providers.some(p => p.name === 'QA Relay' && p.model === 'claude-opus-5'))`);
    assert.equal(settings().env.ANTHROPIC_AUTH_TOKEN, 'sk-ui-secret', '编辑时不填密钥要保留原密钥');
    // Esc 关抽屉
    await evaluate(`${addButton}.click()`);
    await until(`document.querySelector('${P} .pv-editor')`);
    await evaluate(`document.querySelector('${P} .pv-editor input[name=name]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(`!document.querySelector('${P} .pv-editor')`);
    // 再加一家：键盘 Alt+↓ 调顺序；删除要点两次
    await evaluate(`${addButton}.click()`);
    await until(`document.querySelector('${P} .pv-editor')`);
    await fill('QA Backup', 'claude-sonnet-5', 'sk-backup');
    await until(`[...document.querySelectorAll('${P} .pv-row b')].some(n => n.textContent === 'QA Backup')`);
    const before = await evaluate(`[...document.querySelectorAll('${P} .pv-row b')].map(n => n.textContent).join('|')`);
    await evaluate(`document.querySelector('${P} .pv-row').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))`);
    await until(`[...document.querySelectorAll('${P} .pv-row b')].map(n => n.textContent).join('|') !== ${JSON.stringify(before)}`);
    const trash = `[...document.querySelectorAll('${P} .pv-row')].find(r => r.querySelector('b').textContent === 'QA Backup').querySelector('.pv-icon-btn.danger')`;
    await evaluate(`${trash}.click()`);
    await delay(150);
    assert.ok(await evaluate(`[...document.querySelectorAll('${P} .pv-row b')].some(n => n.textContent === 'QA Backup')`), '第一次点删除不能真删');
    await evaluate(`${trash}.click()`);
    await until(`![...document.querySelectorAll('${P} .pv-row b')].some(n => n.textContent === 'QA Backup')`);
    // 连接方式切到本地路由：配置写成占位密钥和本地地址，菜单上出现「路由」
    await evaluate(`[...document.querySelectorAll('${P} .pv-mode-seg button')].find(b => b.textContent === '本地路由').click()`);
    await until(`document.querySelector('${P} .pv-nav [data-section=claude] .pv-nav-badge.route')`);
    assert.equal(settings().env.ANTHROPIC_AUTH_TOKEN, 'PROXY_MANAGED');
    assert.match(settings().env.ANTHROPIC_BASE_URL, new RegExp(`127\\.0\\.0\\.1:${port}`));
    assert.equal(settings().hooks.keep, true);
    // 不看截图，用 DOM 查版面：夜间模式没有默认黑字；各分区里没有元素伸出页面；抽屉在窗口里
    const blackText = `[...document.querySelectorAll('${P} *')].filter(n => [...n.childNodes].some(c => c.nodeType === 3 && c.nodeValue.trim()) && getComputedStyle(n).color === 'rgb(0, 0, 0)').map(n => n.className || n.tagName)`;
    const overflow = `(() => { const box = document.querySelector('${P}').getBoundingClientRect(); return [...document.querySelectorAll('${P} .pv-main *')].filter(n => { const r = n.getBoundingClientRect(); return r.width && (r.right > box.right + 1 || r.left < box.left - 1); }).map(n => n.className || n.tagName).slice(0, 5); })()`;
    await evaluate("setThemeMode('dark')"); await delay(200);
    for (const id of ['overview', 'claude', 'desktop', 'router', 'logs', 'import']) {
      await nav(id); await delay(120);
      assert.deepEqual(await evaluate(blackText), [], `夜间模式「${id}」有黑字`);
      assert.deepEqual(await evaluate(overflow), [], `「${id}」有元素伸出页面`);
    }
    await nav('claude'); await delay(120);
    await evaluate(`${addButton}.click()`);
    await until(`document.querySelector('${P} .pv-editor')`);
    assert.deepEqual(await evaluate(blackText), [], '夜间模式抽屉有黑字');
    // 测试窗口是隐藏的，Chromium 不推进隐藏窗口里的 CSS 动画：先让动画走完再量位置
    await evaluate('document.getAnimations().forEach(a => a.finish())');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('${P} .pv-editor')).position`), 'static', '编辑页跟在菜单右边，不再是浮层');
    assert.equal(await evaluate(`document.querySelector('${P} .pv-nav [data-section=edit-models]') !== null`), true, '编辑时左侧是设置菜单');
    await evaluate(`document.querySelector('${P} .pv-editor input[name=name]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(`!document.querySelector('${P} .pv-editor')`);
    await evaluate("setThemeMode('light')"); await delay(900);
    // 窄窗口：二级菜单变成顶部一排，页面本身不横向滚动
    const win = BrowserWindow.fromWebContents(contents);
    win.setSize(900, 800);
    await delay(250);
    assert.equal((await evaluate(`getComputedStyle(document.querySelector('${P} .pv')).gridTemplateColumns`)).split(' ').length, 1);
    assert.equal(await evaluate(`document.querySelector('${P}').scrollWidth <= document.querySelector('${P}').clientWidth + 1`), true);
    contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('${P} .pv-nav-item')).transitionDuration`), '0s');
    contents.debugger.detach();
    // 关掉路由，写回直连
    await evaluate(`[...document.querySelectorAll('${P} .pv-mode-seg button')].find(b => b.textContent === '直连').click()`);
    await until(`!document.querySelector('${P} .pv-nav [data-section=claude] .pv-nav-badge.route')`);
    assert.equal(settings().env.ANTHROPIC_AUTH_TOKEN, 'sk-ui-secret');
    // A saved note must not silently take over a connection another tool changed.
    await evaluate("[...document.querySelectorAll('#page-providers .pv-current button')].find(b => b.textContent.includes('编辑')).click()");
    await until("document.querySelector('#page-providers .pv-editor')");
    const external = JSON.stringify({ hooks: { keep: true }, env: { ANTHROPIC_BASE_URL: 'https://external.example', ANTHROPIC_AUTH_TOKEN: 'fixture-external' } });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), external);
    await evaluate("(() => { const form = document.querySelector('#page-providers .pv-editor'); form.elements.notes.value = 'Metadata only'; form.requestSubmit(); })()");
    await until("!document.querySelector('#page-providers .pv-editor')");
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), external);
    await until("document.body.innerText.includes('未覆盖')");
    // 主导航：默认窄窗口图标栏，手动展开 / 收起、图标导航及刷新记忆。
    const sidebarWidth = () => evaluate("document.querySelector('.sidebar').getBoundingClientRect().width");
    assert.equal(await sidebarWidth(), 76);
    assert.equal(await evaluate("document.querySelector('#sidebar-toggle').getAttribute('aria-expanded')"), 'false');
    await evaluate("document.querySelector('#sidebar-toggle').click()");
    assert.equal(await sidebarWidth(), 236, '窄窗口也能手动展开');
    assert.equal(await evaluate("document.querySelector('#sidebar-toggle').getAttribute('aria-expanded')"), 'true');
    win.setSize(1380, 920); await delay(80);
    await evaluate("document.querySelector('#sidebar-toggle').click()");
    assert.equal(await sidebarWidth(), 76, '宽窗口也能手动收起');
    assert.equal(await evaluate("localStorage.getItem('tokenpulse-sidebar')"), 'collapsed');
    assert.equal(await evaluate("[...document.querySelectorAll('#nav .nav-item')].every(b => b.offsetWidth > 0 && b.getAttribute('title') && getComputedStyle(b.querySelector('.nav-label')).display === 'none')"), true, '保留可操作且有名称的图标');
    await evaluate("document.querySelector('#nav [data-page=usage]').click()");
    await until("state.page === 'usage'");
    await new Promise(resolve => { contents.once('did-finish-load', resolve); contents.reload(); });
    await until("document.querySelector('#sidebar-toggle')?.getAttribute('aria-expanded') === 'false' && current");
    assert.equal(await sidebarWidth(), 76, '刷新后仍记住收起');
    await evaluate("setThemeMode('dark')");
    await evaluate("document.querySelector('#sidebar-toggle').focus(); document.querySelector('#sidebar-toggle').click()");
    assert.equal(await sidebarWidth(), 236);
    assert.equal(await evaluate("document.activeElement.id"), 'sidebar-toggle', '切换保留键盘焦点');
    assert.equal(await evaluate("document.querySelector('#sidebar-toggle').title"), '收起侧栏');
    console.log('PASS sidebar: icon navigation, wide collapse, narrow expansion, reload persistence, dark theme and focus');
    // Failure to restore must cancel application quit, not leave a dead proxy address.
    const backend = require('../build/core/agent-switch');
    const { dialog } = require('electron');
    const release = backend.releaseAgentSwitch, showError = dialog.showErrorBox;
    let prevented = false, warned = false;
    try {
      backend.releaseAgentSwitch = () => { throw new Error('Synthetic restore failure'); };
      dialog.showErrorBox = () => { warned = true; };
      app.emit('before-quit', { preventDefault: () => { prevented = true; } });
      assert.equal(prevented, true); assert.equal(warned, true);
    } finally { backend.releaseAgentSwitch = release; dialog.showErrorBox = showError; }
    console.log('PASS agent switch UI: field navigation, unsaved guard, Grok/Codex fetched models, explicit reasoning default, duplicate save guard, sub-menu add/edit, enable, reorder/delete, route toggle, 900px and reduced motion');
    clearTimeout(watchdog);
    app.exit(0);
  } catch (error) {
    console.error('FAIL', error);
    clearTimeout(watchdog);
    app.exit(1);
  }
}));
require('../build/main/index.js');
