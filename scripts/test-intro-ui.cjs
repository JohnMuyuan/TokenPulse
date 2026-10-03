/*
 * 0.3.9：新手引导 + 「新版本有什么」。
 * 全新安装（没有 prefs.json）→ 自动走引导，可以跳过 / 走完，记下 onboarding=done；
 * 从旧版本升级（seenVersion 比当前旧）→ 弹一次更新说明，关掉后记下版本，重新加载不再弹；
 * 设置 → 关于 里可以重新打开两样。临时数据目录，不碰真实的 ~/.tokenpulse。
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-intro-ui-'));
assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(root, 'home'); process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
app.setPath('userData', path.join(root, 'electron')); app.commandLine.appendSwitch('lang', 'zh-CN'); process.argv.push('--hidden');
const appRoot = process.env.TOKENPULSE_TEST_APP || path.resolve(__dirname, '..');
const version = require(path.join(appRoot, 'package.json')).version;
fs.mkdirSync(path.join(root, 'home'), { recursive: true });
// 故意不写 prefs.json：模拟全新安装
require(path.join(appRoot, 'build/core/quota.js')).fetchOfficialQuota = async () => ({});
const prefsFile = () => JSON.parse(fs.readFileSync(path.join(root, 'data', 'prefs.json'), 'utf8'));
// 真实数据目录的「指纹」：演示前后必须一样（除了 prefs.json 里记下引导走过），也不能出现演示账号
const crypto = require('node:crypto');
const fingerprint = () => {
  const out = {};
  const walk = dir => { for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); if (fs.statSync(file).isDirectory()) walk(file); else if (name !== 'prefs.json') out[path.relative(root, file)] = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); } };
  for (const dir of ['data', 'home']) if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
  return out;
};
const demoDir = () => fs.readdirSync(os.tmpdir()).filter(name => name === `tokenpulse-demo-${process.pid}`);
const watchdog = setTimeout(() => { console.error('FAIL intro UI timed out'); app.exit(1); }, 40000);
app.on('web-contents-created', (_, contents) => contents.once('did-finish-load', async () => {
  const evaluate = code => contents.executeJavaScript(code).catch(e => { throw new Error(e.message + ' ← ' + String(code).slice(0, 160)); }), delay = ms => new Promise(r => setTimeout(r, ms));
  const until = async (code, ms = 10000) => { const end = Date.now() + ms; while (!await evaluate('Promise.resolve(' + code + ').then(v=>!!v)')) { assert.ok(Date.now() < end, 'Timed out: ' + code); await delay(40); } };
  const text = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim()`);
  const reload = async () => { const loaded = new Promise(r => contents.once('did-finish-load', r)); contents.reload(); await loaded; await delay(200); };
  try {
    // 全新安装：主进程记下 pending，界面自动开始引导（不弹更新说明）
    assert.equal(prefsFile().onboarding, 'pending');
    assert.equal(prefsFile().seenVersion, version);
    await until("document.querySelector('.tour .tour-card')");
    assert.equal(await evaluate("document.querySelector('#whatsnew')"), null, '全新安装不弹更新说明');
    assert.match(await text('.tour-card h3'), /欢迎使用 TokenPulse/);
    assert.equal(await text('.tour-count'), `1 / ${await evaluate('PulseIntro.steps')}`);
    assert.ok(await evaluate("document.querySelector('.tour').classList.contains('no-target')"), '欢迎页居中、不高亮');
    assert.ok(await evaluate("document.querySelector('.workspace').inert && document.querySelector('.sidebar').inert"), '引导时背景不可操作');
    assert.ok(await evaluate("document.activeElement?.closest('.tour-card') !== null"), '焦点在引导卡片里');
    // 演示数据：换成虚构的演示账号（单独的进程、临时目录），真实数据目录不动
    const before = fingerprint();
    await until('PulseIntro.demo()');
    assert.equal(await evaluate('current.demo'), true);
    assert.equal(await evaluate('state.account'), 'claude:demo');
    assert.deepEqual(await evaluate("current.accounts.map(a => a.accountId)"), ['claude:demo']);
    assert.equal(await evaluate("document.querySelector('.tour-demo').hidden"), false, '卡片上标着「演示数据」');
    assert.equal(demoDir().length, 1, '演示数据在系统临时目录里');
    await assert.rejects(evaluate("window.tokenpulse.modelOffMachine({ action: 'delete', id: 'x' })"), /演示数据不能修改/);
    // 测试窗口是隐藏的，CSS 过渡不会走完：几何断言在「减弱动态」下做（这条路径本身也要测）
    contents.debugger.attach('1.3'); await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    // 下一步：高亮左侧导航，卡片不超出窗口、不压住高亮区域
    await evaluate("[...document.querySelectorAll('.tour-actions .btn')].at(-1).click()");
    await until("document.querySelector('.tour-count').textContent.startsWith('2 /')");
    await delay(120);
    const geo = await evaluate(`(() => { const s = document.querySelector('.tour-spot').getBoundingClientRect(), c = document.querySelector('.tour-card').getBoundingClientRect(), n = document.querySelector('#nav').getBoundingClientRect();
      return { spotCovers: s.left <= n.left && s.top <= n.top && s.right >= n.right && s.bottom >= Math.min(n.bottom, innerHeight - 4), inView: c.left >= 0 && c.top >= 0 && c.right <= innerWidth && c.bottom <= innerHeight, overlap: !(c.right <= s.left || c.left >= s.right || c.bottom <= s.top || c.top >= s.bottom), noTarget: document.querySelector('.tour').classList.contains('no-target') }; })()`);
    assert.deepEqual(geo, { spotCovers: true, inView: true, overlap: false, noTarget: false }, '高亮框住导航、卡片在窗口内且不压住它');
    // 方向键前后翻；走到额度详情的几步会切页，并等异步面板加载出来再高亮
    const go = async n => {
      for (let i = 0; i < 30; i++) {
        const at = await evaluate("parseInt(document.querySelector('.tour-count').textContent)");
        if (at === n) break;
        await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '${at < n ? 'ArrowRight' : 'ArrowLeft'}', bubbles: true }))`);
        await delay(30);
      }
      await until(`document.querySelector('.tour-count').textContent.startsWith('${n} /') && !document.querySelector('.tour').classList.contains('waiting')`, 8000);
      await delay(100);
    };
    const covers = sel => evaluate(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); if (!t) return 'missing'; const r = t.getBoundingClientRect(), s = document.querySelector('.tour-spot').getBoundingClientRect(), c = document.querySelector('.tour-card').getBoundingClientRect();
      if (document.querySelector('.tour').classList.contains('no-target')) return 'no-target';
      if (!(s.left <= r.left + 1 && s.top <= Math.max(r.top, 50) + 1 && s.right >= Math.min(r.right, innerWidth - 4) - 1)) return 'spot ' + JSON.stringify([r.left, r.top, r.right, r.bottom, s.left, s.top, s.right, s.bottom, innerWidth, innerHeight].map(Math.round));
      if (!(c.left >= 0 && c.top >= 0 && c.right <= innerWidth && c.bottom <= innerHeight)) return 'card-out';
      if (!(c.right <= s.left || c.left >= s.right || c.bottom <= s.top || c.top >= s.bottom)) return 'overlap';
      return 'ok'; })()`);
    const checks = [
      [3, 'overview', '#quota-cards', /官方额度/], [4, 'overview', '#overview-analysis .analysis-grid', /用量趋势/],
      [7, 'quota', '#quota-detail .quota-window-grid', /5 小时与周窗口/], [8, 'quota', '#quota-detail .capacity-panel', /额度容量趋势/],
      [9, 'quota', '#quota-model-study .ms-budgets', /换一种模型/], [10, 'quota', '#quota-model-study .ms-highlights', /一眼看结论/],
      [11, 'quota', '#quota-model-timeline .ms-cycle.week .ms-tl', /时间线/], [12, 'quota', '#quota-model-timeline .ms-cycle.week .ms-tl-help', /看不懂颜色？点问号/],
      [13, 'quota', '#quota-model-timeline .ms-cycle.week .ms-off-summary', /本机以外/],
      [14, 'usage', '#page-usage .breakdown-panel', /Token 构成/], [16, 'usage', '#page-usage .usage-records', /按项目/],
      // 0.3.16：出口监控的检测间隔和启动前核对、会话管理的新对话 / 新项目
      [18, 'egress', '#page-egress .egress-toolbar', /检测间隔，和启动前核对出口/], [20, 'sessions', '#page-sessions .sw-new-row', /新对话、新项目/],
    ];
    for (const [n, page, sel, heading] of checks) {
      await go(n);
      assert.equal(await evaluate('document.body.dataset.page'), page, `第 ${n} 步切到 ${page}`);
      assert.match(await text('.tour-card h3'), heading);
      assert.equal(await covers(sel), 'ok', `第 ${n} 步高亮 ${sel}`);
    }
    // 演示账号的内容是真的算出来的：容量趋势有折线、有模型换算、时间线上待标注和已标注的本机以外都有、按项目有卡片
    await go(12);
    assert.ok(await evaluate("document.querySelectorAll('#quota-detail .capacity-chart svg circle, #quota-detail .capacity-chart svg path').length > 0"), '容量趋势有图');
    assert.ok(await evaluate("document.querySelectorAll('#quota-model-study .ms-row').length >= 5"), '模型换算列出多个组合');
    assert.ok(await evaluate("document.querySelector('#quota-model-timeline .ms-cycle.week .ms-off.detected') && document.querySelector('#quota-model-timeline .ms-cycle.week .ms-off.marked')"), '时间线上待标注、已标注都有');
    await go(16);
    assert.equal(await evaluate('state.usageView'), 'projects');
    assert.ok(await evaluate("document.querySelectorAll('#view-projects .pj-card').length >= 3"), '按项目列出演示项目 ' + await evaluate("state.days + '|' + document.querySelectorAll('#view-projects .pj-card').length + '|' + document.querySelector('#view-projects').textContent.slice(0, 300)"));
    await go(4);
    assert.equal(await evaluate('document.body.dataset.page'), 'overview');
    // 900px 窄窗口：卡片仍在窗口里
    const win = BrowserWindow.fromWebContents(contents); win.setSize(900, 700); await delay(300);
    assert.ok(await evaluate("(() => { const c = document.querySelector('.tour-card').getBoundingClientRect(); return c.left >= 0 && c.top >= 0 && c.right <= innerWidth && c.bottom <= innerHeight; })()"), '窄窗口卡片不出界');
    // 跳过引导：记下 done，回到总览，背景恢复
    await evaluate("document.querySelector('.tour-skip').click()");
    await until("!document.querySelector('.tour')");
    await until("window.tokenpulse.readPrefs().then(p => p.onboarding === 'done')");
    assert.equal(await evaluate('document.body.dataset.page'), 'overview');
    assert.equal(await evaluate("document.querySelector('.workspace').inert || document.querySelector('.sidebar').inert"), false);
    // 换回真实数据：演示进程和临时目录都清掉，账号、视图恢复，真实数据目录没被改过
    assert.notEqual(await evaluate('current.demo'), true);
    assert.equal(await evaluate("current.accounts.some(a => a.accountId === 'claude:demo')"), false);
    assert.notEqual(await evaluate('state.account'), 'claude:demo');
    assert.equal(await evaluate('state.usageView'), 'requests');
    assert.equal(await evaluate('window.tokenpulse.isDemo()'), false);
    for (let i = 0; i < 50 && demoDir().length; i++) await delay(100);
    assert.equal(demoDir().length, 0, '演示临时目录已删除');
    assert.deepEqual(fingerprint(), before, '真实数据目录没有变化');
    assert.ok(!JSON.stringify(fingerprint()).includes('demo'), '真实数据目录里没有演示文件');
    // 重新加载：不再弹引导，也不弹更新说明
    await reload(); await delay(1200);
    assert.equal(await evaluate("document.querySelector('.tour, #whatsnew')"), null, '走过引导后不再自动弹');
    console.log('PASS 0.3.9 onboarding: fresh install starts tour on sandboxed demo data (capacity trend, model budgets, timeline, off-PC marks, projects), spotlight/card geometry per step, arrow keys, 900px, skip restores real data untouched, not shown again');

    // 从 0.3.8 升级：弹一次更新说明
    await evaluate("window.tokenpulse.writePrefs({ seenVersion: '0.3.8' })");
    await reload();
    await until("document.querySelector('#whatsnew .whatsnew-card')");
    assert.match(await text('#whatsnew-title'), new RegExp('v' + version.replace(/\./g, '\\.')));
    assert.ok(await evaluate("document.querySelectorAll('#whatsnew .whatsnew-list li').length >= 4"));
    // 跨版本升级（0.3.8 → 当前）：没看过的每个版本都列出来，较早的版本有分隔标题
    const older = await evaluate(`Object.keys(PulseIntro.notes).filter(v => v !== ${JSON.stringify(version)}).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(v => 'v' + v)`);
    assert.ok(older.includes('v0.3.9'));
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#whatsnew .whatsnew-version')].map(n => n.textContent)"), older, '较早版本按新到旧排，各有一个分隔标题');
    assert.ok(await evaluate("document.activeElement?.textContent === '知道了'"), '默认焦点在「知道了」');
    // 夜间模式：标题和条目文字不能是默认黑色
    await evaluate("setThemeMode('dark')"); await delay(150);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#whatsnew *')].filter(n => n.childElementCount === 0 && n.textContent.trim() && getComputedStyle(n).color === 'rgb(0, 0, 0)').map(n => n.tagName)"), []);
    await evaluate("setThemeMode('light')");
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await until("!document.querySelector('#whatsnew')");
    await until(`window.tokenpulse.readPrefs().then(p => p.seenVersion === ${JSON.stringify(version)})`);
    await reload(); await delay(1200);
    assert.equal(await evaluate("document.querySelector('#whatsnew, .tour')"), null, '看过这版说明后不再弹');
    // 更新说明里的「开始新手引导」
    await evaluate("window.tokenpulse.writePrefs({ seenVersion: '0.3.8' })");
    await reload();
    await until("document.querySelector('#whatsnew .whatsnew-card')");
    await evaluate("[...document.querySelectorAll('#whatsnew .whatsnew-foot .btn')].find(b => b.textContent === '开始新手引导').click()");
    await until("document.querySelector('.tour .tour-card') && !document.querySelector('#whatsnew')");
    assert.equal(prefsFile().seenVersion, version);
    // 一路点到「完成」
    for (let i = 0; i < 60 && await evaluate("Boolean(document.querySelector('.tour'))"); i++) { await evaluate("[...document.querySelectorAll('.tour-actions .btn')].at(-1).click()"); await delay(60); }
    await until("!document.querySelector('.tour')");
    assert.equal(prefsFile().onboarding, 'done');
    console.log('PASS 0.3.9 what\'s new: shown once after upgrade, Esc closes and saves version, not shown again, starts tour, tour completes');

    // 设置 → 关于：重新打开两样
    await evaluate("openSettings('about')");
    await until("!document.getElementById('settings').hidden && document.getElementById('intro-replay').offsetParent");
    assert.equal(await evaluate("document.getElementById('whatsnew-open').hidden"), false);
    await evaluate("document.getElementById('whatsnew-open').click()");
    await until("document.querySelector('#whatsnew') && document.getElementById('settings').hidden");
    await evaluate("document.querySelector('#whatsnew .icon-circle').click()");
    await until("!document.querySelector('#whatsnew')");
    await evaluate("openSettings('about')");
    await until("!document.getElementById('settings').hidden");
    await evaluate("document.getElementById('intro-replay').click()");
    await until("document.querySelector('.tour') && document.getElementById('settings').hidden");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.tour-spot')).transitionDuration"), '0s'); contents.debugger.detach();
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await until("!document.querySelector('.tour')");
    console.log('PASS 0.3.9 settings → about: reopen what\'s new and tour, reduced motion');
    // 引导里可能还有没回来的演示请求：结束演示进程、删掉临时目录再退出（app.exit 不走 will-quit）
    await evaluate('window.tokenpulse.demo(false)'); await delay(400);
    clearTimeout(watchdog); app.exit(0);
  } catch (e) { console.error('FAIL', e.message); clearTimeout(watchdog); app.exit(1); }
}));
if (process.env.TOKENPULSE_TEST_APP) {
  const { nativeImage } = require('electron'); const icons = require(path.join(appRoot, 'build/main/icon.js')); const resources = path.dirname(appRoot);
  icons.trayIcon = () => nativeImage.createFromPath(path.join(resources, 'packaging/tray.png'));
  icons.windowIcon = () => nativeImage.createFromPath(path.join(resources, 'packaging/icon.png'));
}
require(path.join(appRoot, 'build/main/index.js'));
