/*
 * 托盘小面板：真的把应用跑起来，模拟在托盘图标上点右键。
 * 临时数据目录，不碰真实的 ~/.tokenpulse；面板在测试里放到屏幕外面（TOKENPULSE_TRAY_PANEL_OFFSCREEN）。
 * 只有 Windows 上右键是面板（别的平台仍是菜单），所以别的平台跳过。
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { app, BrowserWindow, Tray } = require('electron');
if (process.platform !== 'win32') { console.log('SKIP tray panel UI: 只在 Windows 上用面板'); app.exit(0); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-tray-panel-ui-'));
assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(root, 'home'); process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.TOKENPULSE_TRAY_PANEL_OFFSCREEN = '1';
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
app.setPath('userData', path.join(root, 'electron')); app.commandLine.appendSwitch('lang', 'zh-CN'); process.argv.push('--hidden');
const appRoot = process.env.TOKENPULSE_TEST_APP || path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'home'), { recursive: true }); fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'prefs.json'), JSON.stringify({ autoLaunch: false, autoUpdate: false, closeToTray: true, startMinimized: true, language: 'zh', notifyAt: 0, notifyMismatch: false, ccSwitch: false, seenVersion: require(path.join(appRoot, 'package.json')).version, onboarding: 'done', theme: 'light' }));
require(path.join(appRoot, 'build/core/quota.js')).fetchOfficialQuota = async () => ({});

// 托盘对象在主进程里不对外：从它第一次设提示文字时记下来
let tray = null, menus = 0;
const setToolTip = Tray.prototype.setToolTip, setContextMenu = Tray.prototype.setContextMenu;
Tray.prototype.setToolTip = function (...args) { tray = this; return setToolTip.apply(this, args); };
Tray.prototype.setContextMenu = function (...args) { menus++; return setContextMenu.apply(this, args); };

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (probe, label, ms = 8000) => { const end = Date.now() + ms; for (;;) { const value = await probe(); if (value) return value; if (Date.now() > end) throw new Error('等不到：' + label); await delay(60); } };
const panelOf = () => BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.getURL().includes('tray-panel.html'));
const mainOf = () => BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.getURL().includes('index.html'));
setTimeout(() => { console.error('FAIL tray panel UI timed out'); app.exit(1); }, 60000);

app.whenReady().then(async () => {
  let failed = false;
  try {
    await until(() => tray && mainOf(), '主窗口和托盘');
    await delay(1500);
    assert.equal(menus, 0, 'Windows 上不给托盘设菜单，否则收不到右键');
    assert.equal(panelOf(), undefined, '没点右键之前不建面板窗口');

    tray.emit('right-click');
    const panel = await until(() => { const w = panelOf(); return w && w.isVisible() ? w : null; }, '面板显示');
    const js = code => panel.webContents.executeJavaScript(code);
    await until(() => js("!!document.querySelector('#tp-list > *')"), '面板内容');
    assert.equal(await js('document.documentElement.dataset.theme'), 'light', '跟着主窗口现在的主题');
    assert.equal(await js("document.querySelectorAll('.tp-empty').length"), 1, '没有官方账号时给一句说明');
    assert.match(await js("document.getElementById('tp-today').textContent"), /^今日 \S+$/);
    // 旧的托盘菜单不要了：没有「菜单」按钮，右上角是刷新和退出
    assert.deepEqual(await js("['tp-open','tp-refresh','tp-quit','tp-menu'].map(id => !!document.getElementById(id))"), [true, true, true, false]);
    assert.equal(await js("document.getElementById('tp-quit').getAttribute('aria-label')"), '退出 TokenPulse');
    assert.ok(Math.abs(panel.getBounds().width - 340) <= 2, '宽度固定（缩放下可能差一个像素）');
    // 窗口高度跟着内容走
    const fits = async () => { const content = await js("Math.ceil(document.getElementById('tp').getBoundingClientRect().height)"); return Math.abs(panel.getBounds().height - content) <= 3; };
    await until(fits, '高度跟内容一致');
    // 不断言 isAlwaysOnTop()：它取决于系统当时的状态（比如前台有全屏程序时 Windows 会说 false），在同一台机器上时真时假

    // 有账号时：一张卡一个账号，每个窗口一条直线进度条（带「时间走到哪」的竖线），会在重置前用完的给一句提醒
    const now = Date.now(), H = 3600000;
    panel.webContents.send('tray-panel', { now, theme: 'dark', today: { tokens: 2500000, costUsd: 1.5 }, accounts: [
      { kind: 'claude', name: 'Claude · QA', plan: 'max', checkedAt: now, five: { used: 90, resetAt: now + 2 * H, etaAt: now + H / 2, runsOut: true, pace: 60 }, week: { used: 40, resetAt: now + 80 * H, etaAt: 0, runsOut: false, pace: -1 } },
      { kind: 'grok', name: 'Grok', plan: '', checkedAt: now - 2 * H, five: null, week: { used: 10, resetAt: now + 100 * H, etaAt: 0, runsOut: false, pace: 30 } },
    ], agents: [
      { app: 'codex', label: 'Codex', current: 'Relay B', readOnly: false, providers: [{ id: 'p-a', name: '官方登录', active: false }, { id: 'p-b', name: 'Relay B', active: true }] },
      { app: 'grok', label: 'Grok CLI', current: '', readOnly: true, providers: [{ id: 'p-c', name: 'Pool', active: false }] },
    ] });
    await until(() => js("document.querySelectorAll('.tp-card').length === 2"), '两张卡');
    const cards = await js(`[...document.querySelectorAll('.tp-card')].map(c => ({ kind: c.dataset.kind, name: c.querySelector('.tp-name b').textContent, plan: c.querySelector('.tp-plan')?.textContent || '',
      lines: [...c.querySelectorAll('.tp-line')].map(l => [l.dataset.window, l.querySelector('.tp-label').textContent, l.querySelector('b').textContent, l.querySelector('small').textContent, l.querySelector('.fill')?.getAttribute('class') || '', l.querySelector('.fill')?.getAttribute('width') || '', l.querySelector('.pace')?.getAttribute('x') || '']),
      warn: [...c.querySelectorAll('.tp-warn')].map(w => w.textContent), stale: c.classList.contains('stale'), logo: !!c.querySelector('.tp-avatar path'), rings: c.querySelectorAll('circle').length }))`);
    assert.equal(cards[0].plan, 'max'); assert.equal(cards[0].logo, true); assert.equal(cards[0].rings, 0, '不再画圆环');
    assert.deepEqual(cards[0].lines.map(l => l.slice(0, 3)), [['five', '5 小时', '90%'], ['week', '周', '40%']]);
    assert.match(cards[0].lines[0][3], /^2 小时 0 分后重置$/); assert.match(cards[0].lines[1][3], /^\d+月\d+日 \d\d:\d\d重置$/);
    assert.deepEqual(cards[0].lines.map(l => l.slice(4)), [['fill five hot', '90.00', '59.60'], ['fill week', '40.00', '']], '填充长度 = 已用；竖线在时间走到的位置，没有起止时间就不画');
    assert.match(cards[0].warn[0], /^按现在的速度，5 小时额度约 30 分钟后用完$/);
    assert.deepEqual(cards[1].lines.map(l => l.slice(0, 3)), [['week', '周', '10%']]); assert.equal(cards[1].stale, true); assert.match(cards[1].warn[0], /超过 30 分钟没有更新/);
    assert.equal(await js('document.documentElement.dataset.theme'), 'dark', '主题变了跟着变');
    assert.equal(await js("document.getElementById('tp-today').textContent"), '今日 2.5M · $1.50'); assert.match(await js("document.getElementById('tp-today').title"), /2\.5M Tokens.*\$1\.50/);
    assert.equal(await js('document.documentElement.scrollWidth <= window.innerWidth'), true, '内容不比窗口宽');
    assert.equal(await js("document.getElementById('tp-list').classList.contains('scroll')"), false, '三个以内不滚动');
    assert.deepEqual(await js("[...document.querySelectorAll('.tp-line small, .tp-name b, .tp-agent b')].filter(n => n.scrollWidth > n.clientWidth + 1).length"), 0, '文字没有被截断');
    console.log('PASS tray panel UI: right-click opens it, theme follows the app, empty state, cards with linear bars and pace marks, reset times, run-out and stale notes, height follows content');

    // 供应商：每个工具一行写着现在用的；点开列出可以换的，点一个 → 面板收起、主窗口出来并收到切换请求（和托盘菜单一样要在主窗口里确认）
    assert.deepEqual(await js("[...document.querySelectorAll('.tp-agent')].map(a => [a.dataset.app, a.querySelector('.tp-agent-app').textContent, a.querySelector('b').textContent, a.getAttribute('aria-expanded')])"), [['codex', 'Codex', 'Relay B', 'false'], ['grok', 'Grok CLI', '没有启用', 'false']]);
    assert.equal(await js("document.querySelectorAll('.tp-option').length"), 0);
    await js("document.querySelector('.tp-agent[data-app=grok]').click()");
    assert.deepEqual(await js("[...document.querySelectorAll('.tp-option')].map(o => [o.dataset.id, o.disabled])"), [['p-c', true]], '只读保护开着：不能切');
    await js("document.querySelector('.tp-agent[data-app=codex]').click()");
    assert.deepEqual(await js("[...document.querySelectorAll('.tp-option')].map(o => [o.dataset.id, o.textContent, o.classList.contains('on'), o.disabled])"), [['p-a', '官方登录', false, false], ['p-b', 'Relay B', true, true]], '一次只展开一个；正在用的打勾、不能再点');
    await until(fits, '展开后高度跟着变');
    const asked = new Promise(resolve => { const send = mainOf().webContents.send.bind(mainOf().webContents); mainOf().webContents.send = (channel, ...args) => { if (channel === 'agent-activate-request') resolve(args[0]); return send(channel, ...args); }; });
    await js("document.querySelector('.tp-option[data-id=p-a]').click()");
    assert.equal(await asked, 'p-a');
    await until(() => !panel.isVisible() && mainOf().isVisible(), '切换请求交给主窗口');
    mainOf().hide();
    await delay(350); tray.emit('right-click'); await until(() => panel.isVisible(), '再打开');
    console.log('PASS tray panel UI: providers listed per tool, expand one at a time, read-only blocks switching, picking one hands the request to the main window');

    // 账号超过三个：只露出前三个的高度，其余的在这一块里滚动，面板不会越来越高
    {
      const one = (name, used) => ({ kind: 'claude', name, plan: '', checkedAt: Date.now(), five: { used, resetAt: Date.now() + 3600000, etaAt: 0, runsOut: false, pace: 50 }, week: { used, resetAt: Date.now() + 86400000, etaAt: 0, runsOut: false, pace: 50 } });
      const send = count => panel.webContents.send('tray-panel', { now: Date.now(), theme: 'light', today: { tokens: 1, costUsd: 0 }, accounts: Array.from({ length: count }, (_, i) => one('A' + i, 10 + i)), agents: [] });
      send(3); await until(() => js("document.querySelectorAll('.tp-card').length === 3"), '三个账号'); await until(fits, '三个账号的高度');
      const three = panel.getBounds().height;
      send(6); await until(() => js("document.querySelectorAll('.tp-card').length === 6"), '六个账号'); await delay(200);
      assert.ok(Math.abs(panel.getBounds().height - three) <= 3, `六个账号和三个一样高（${panel.getBounds().height} / ${three}）`);
      assert.deepEqual(await js("(() => { const l = document.getElementById('tp-list'), c = [...l.children], box = l.getBoundingClientRect(); return [l.classList.contains('scroll'), l.scrollHeight > l.clientHeight, c[2].getBoundingClientRect().bottom <= box.bottom + 1, c[3].getBoundingClientRect().top >= box.bottom - 1]; })()"), [true, true, true, true], '前三个完整露出，第四个要滚动才看得到');
      assert.equal(await js("document.getElementById('tp-today').textContent"), '今日 1');
      console.log('PASS tray panel UI: more than three accounts scroll inside the list, the panel stays the height of three');
    }
    // 再点一次右键收起；点图标让面板失焦收起后紧跟着的那一下不能又打开
    tray.emit('right-click');
    await until(() => !panel.isVisible(), '再点一次收起');
    tray.emit('right-click');
    await delay(200);
    assert.equal(panel.isVisible(), false, '刚收起的 300 毫秒内不重开');
    await delay(250);
    tray.emit('right-click');
    await until(() => panel.isVisible(), '重新打开');
    // 「打开 TokenPulse」：面板收起，主窗口出来
    await js("document.getElementById('tp-open').click()");
    await until(() => !panel.isVisible() && mainOf().isVisible(), '打开主窗口');
    mainOf().hide();
    // Esc 收起
    await delay(350); tray.emit('right-click'); await until(() => panel.isVisible(), '第三次打开');
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    await until(() => !panel.isVisible(), 'Esc 收起');
    console.log('PASS tray panel UI: toggles on right-click, no bounce reopen, open-main-window button, Esc');
  } catch (error) { failed = true; console.error('FAIL', error.stack || error.message); }
  finally { setTimeout(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响结果 */ } app.exit(failed ? 1 : 0); }, 300); }
});
require(path.join(appRoot, 'build/main/index.js'));
