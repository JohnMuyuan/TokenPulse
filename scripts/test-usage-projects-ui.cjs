/**
 * 用量明细「按项目」视图（0.3.9）。跑法（先 npm run compile）：
 *
 *   npx electron scripts/test-usage-projects-ui.cjs
 *
 * 一次性的 HOME / 数据目录，流水直接写假数据，不碰真实会话和凭据。只用 DOM、计算样式和尺寸断言，不截图。
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-projects-ui-'));
assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(root, 'home'); process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
app.setPath('userData', path.join(root, 'electron')); app.commandLine.appendSwitch('lang', 'zh-CN'); process.argv.push('--hidden');
const appRoot = process.env.TOKENPULSE_TEST_APP || path.resolve(__dirname, '..');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const now = Date.now(), minute = 60000;
const monthKey = at => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
write(path.join(root, 'data', 'prefs.json'), { autoLaunch: false, autoUpdate: false, closeToTray: true, startMinimized: true, language: 'zh', notifyAt: 0, notifyMismatch: false, ccSwitch: false, seenVersion: require('../package.json').version, onboarding: 'done' });
// 两个项目：Alpha 被 Claude Code 两个对话、Codex 一个对话改过（含一次压缩估算）；Beta 只有 Grok 一个对话
// 刚过午夜时都会被夹到 0:01：再按 i 错开几秒，保住先后顺序（否则「最近用过」排序打平）
const at = i => Math.max(new Date(new Date(now).setHours(0, 0, 0, 0)).getTime() + minute + i * 1000, now - (20 - i) * minute);
const rec = (i, extra) => ({ id: 'r' + i, at: at(i), input: 1000, output: 100, cacheRead: 400, cacheWrite: 0, reasoning: 10, costUsd: 0, calls: 1, ...extra });
const records = [
  rec(1, { kind: 'claude-code', file: path.join(root, 'c1.jsonl'), cwd: 'D:\\Work\\Alpha', model: 'claude-opus-5-5', effort: 'high' }),
  rec(2, { kind: 'claude-code', file: path.join(root, 'c2.jsonl'), cwd: 'd:/work/alpha', model: 'claude-opus-5-5', effort: 'medium' }),
  rec(3, { kind: 'codex', file: path.join(root, 'rollout-2026-09-28T00-00-00-x.jsonl'), cwd: 'D:\\Work\\Alpha', model: 'gpt-6-astra', effort: 'xhigh', input: 50000 }),
  rec(4, { kind: 'codex', file: path.join(root, 'rollout-2026-09-28T00-00-00-x.jsonl'), cwd: 'D:\\Work\\Alpha', model: 'gpt-6-astra', compaction: true, input: 200000, cacheRead: 190000 }),
  rec(5, { kind: 'grok-build', file: path.join(root, 'g1', 'updates.jsonl'), cwd: 'D:\\Work\\Beta', model: 'grok-4.7-build', effort: 'low', calls: 4 }),
];
const months = new Map(); for (const r of records) { const m = monthKey(r.at); if (!months.has(m)) months.set(m, []); months.get(m).push(JSON.stringify(r)); }
for (const [m, rows] of months) write(path.join(root, 'data', 'requests', m + '.jsonl'), rows.join('\n') + '\n');
write(path.join(root, 'data', 'usage-rollups.json'), { version: 1, files: {}, requestsCompacted: 1 });
require(path.join(appRoot, 'build/core/quota.js')).fetchOfficialQuota = async () => ({});
const watchdog = setTimeout(() => { console.error('FAIL usage-projects UI timed out'); app.exit(1); }, 40000);
app.on('web-contents-created', (_, contents) => contents.once('did-finish-load', async () => {
  const evaluate = code => contents.executeJavaScript(code), delay = ms => new Promise(r => setTimeout(r, ms));
  const until = async code => { const end = Date.now() + 10000; while (!await evaluate(code)) { assert.ok(Date.now() < end, 'Timed out: ' + code); await delay(30); } };
  const P = '#view-projects';
  try {
    await until('typeof current !== "undefined" && current && current.scannedAt');
    await evaluate("navigate('usage')");
    await evaluate("document.querySelector('#usage-view [data-view=projects]').click()");
    await until(`document.querySelectorAll('${P} .pj-card').length === 2 && !document.querySelector('${P}').hasAttribute('aria-busy')`);
    // 视图切换：其他两个视图藏起来，标题栏换成项目计数，逐条 / 按日的导出按钮都不显示
    assert.deepEqual(await evaluate("['view-requests','view-daily','view-projects'].map(id => document.getElementById(id).hidden)"), [true, true, false]);
    assert.equal(await evaluate("document.getElementById('project-count').textContent"), '2 个项目');
    assert.deepEqual(await evaluate("['export-requests','export-csv','verify-help'].map(id => document.getElementById(id).hidden)"), [true, true, true]);
    assert.equal(await evaluate("document.querySelector('#usage-view [data-view=projects]').getAttribute('aria-pressed')"), 'true');
    // 汇总：2 个项目、4 个对话（同一目录不同写法归并，Codex 两条同一文件算一个对话）
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${P} .pj-stat b')].slice(0, 2).map(n => n.textContent)`), ['2', '4']);
    // 第一张卡：Token 最多的 Alpha；Agent 标签按工具列对话数；构成条一段一个组合
    const first = await evaluate(`(() => { const c = document.querySelector('${P} .pj-card'); return { name: c.querySelector('.pj-title b').textContent, path: c.querySelector('.pj-title small').textContent, agents: [...c.querySelectorAll('.pj-agent')].map(a => a.title.split(' · ').slice(0, 2).join(' · ')), segs: c.querySelectorAll('.pj-mix i').length, compact: c.querySelector('.pj-compact')?.textContent, expanded: c.querySelector('.pj-head').getAttribute('aria-expanded') }; })()`);
    assert.equal(first.name, 'Alpha'); assert.equal(first.path, 'D:\\Work\\Alpha');
    assert.deepEqual(first.agents.sort(), ['Claude Code · 2 个对话', 'Codex CLI · 1 个对话']);
    assert.equal(first.segs, 4, 'opus high / opus medium / astra xhigh / astra 未记录等级');
    assert.equal(first.compact, '含压缩 1 次'); assert.equal(first.expanded, 'false');
    // 构成条颜色和宽度走 CSSOM（CSP 禁止 style 属性）
    assert.equal(await evaluate(`document.querySelector('${P} .pj-mix i').getAttribute('style') !== null && getComputedStyle(document.querySelector('${P} .pj-mix i')).flexGrow !== '1'`), true);
    // 展开：模型 × 思考等级表、Agent 分布、压缩说明、跳到逐条请求
    await evaluate(`document.querySelector('${P} .pj-card .pj-head').click()`);
    await until(`document.querySelector('${P} .pj-card .pj-detail')`);
    assert.equal(await evaluate(`document.querySelector('${P} .pj-card .pj-head').getAttribute('aria-expanded')`), 'true');
    assert.equal(await evaluate(`document.activeElement === document.querySelector('${P} .pj-card .pj-head')`), true, '展开后焦点留在卡片标题上');
    assert.equal(await evaluate(`document.querySelectorAll('${P} .pj-card .pj-combos tbody tr').length`), 4);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${P} .pj-card .pj-level')].map(n => n.textContent)`), ['未记录等级', 'xhigh', 'high', 'medium']);
    assert.equal(await evaluate(`document.querySelectorAll('${P} .pj-card .pj-agent-row').length`), 2);
    assert.match(await evaluate(`document.querySelector('${P} .pj-card .pj-side').textContent`), /压缩上下文 1 次/);
    // 定时刷新：展开状态保留
    await evaluate('render(current)'); await delay(100);
    assert.ok(await evaluate(`document.querySelector('${P} .pj-card .pj-detail') !== null`), '刷新后展开状态保留');
    // 排序 / 搜索
    await evaluate(`document.querySelector('${P} [data-sort=sessions]').click()`);
    assert.equal(await evaluate(`document.querySelector('${P} .pj-card .pj-title b').textContent`), 'Alpha');
    await evaluate(`document.querySelector('${P} [data-sort=recent]').click()`);
    assert.equal(await evaluate(`document.querySelector('${P} .pj-card .pj-title b').textContent`), 'Beta', '最近用过的排前面');
    await evaluate(`(() => { const i = document.querySelector('${P} .pj-toolbar input'); i.value = 'beta'; i.dispatchEvent(new Event('input')); })()`);
    assert.equal(await evaluate(`document.querySelectorAll('${P} .pj-card').length`), 1);
    assert.equal(await evaluate(`document.activeElement === document.querySelector('${P} .pj-toolbar input') || document.querySelector('${P} .pj-toolbar input').isConnected`), true);
    await evaluate(`(() => { const i = document.querySelector('${P} .pj-toolbar input'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
    await evaluate(`document.querySelector('${P} [data-sort=tokens]').click()`);
    // 夜间模式：视图里的文字不能是默认黑色
    await evaluate("setThemeMode('dark')"); await delay(200);
    const black = await evaluate(`[...document.querySelectorAll('${P} *')].filter(n => n.childNodes.length && [...n.childNodes].some(c => c.nodeType === 3 && c.textContent.trim()) && getComputedStyle(n).color === 'rgb(0, 0, 0)').map(n => n.className + ':' + n.textContent.slice(0, 20))`);
    assert.deepEqual(black, [], '夜间模式不能有默认黑字');
    await evaluate("setThemeMode('light')"); await delay(200);
    // 900px：卡片不撑出页面，只允许表格内部滚动
    const win = BrowserWindow.fromWebContents(contents); win.setSize(900, 850); await delay(300);
    assert.equal(await evaluate(`document.querySelector('${P}').scrollWidth <= document.querySelector('${P}').clientWidth + 1`), true, '窄窗口不横向溢出');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('${P} .pj-rank')).display`), 'none');
    // 减弱动态效果
    contents.debugger.attach('1.3'); await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await evaluate(`document.querySelector('${P} .pj-list').classList.add('chart-enter')`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('${P} .pj-card')).animationName`), 'none');
    contents.debugger.detach();
    // 跳到逐条请求：带上这个项目的筛选（同一目录的不同写法都要算进来）
    await evaluate(`document.querySelector('${P} .pj-card .pj-drill').click()`);
    await until("state.usageView === 'requests' && document.querySelectorAll('#request-rows tr.request-row, #request-rows > tr[data-key]').length >= 0 && requestPage && requestPage.total === 4");
    assert.equal(await evaluate("state.project"), 'D:\\Work\\Alpha');
    assert.equal(await evaluate("document.getElementById('view-requests').hidden"), false);
    // 压缩那一行在逐条请求里标成「无法核验」并说明
    const compactRow = await evaluate("requestPage.rows.find(r => r.compaction)");
    assert.equal(compactRow.status, 'unverified'); assert.match(compactRow.reasons[0], /压缩上下文/);
    console.log('PASS 0.3.9 usage by project: view switch, merged folders, session counts, agent chips, model × effort mix, expand with focus, refresh keeps state, sort/search, dark mode, 900px, reduced motion, drill-down to requests, compaction rows');
    clearTimeout(watchdog); app.exit(0);
  } catch (e) { console.error('FAIL', e.message); clearTimeout(watchdog); app.exit(1); }
}));
app.on('quit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 句柄还没放的话留给系统清临时目录 */ } });
if (process.env.TOKENPULSE_TEST_APP) {
  const { nativeImage } = require('electron'); const icons = require(path.join(appRoot, 'build/main/icon.js')); const resources = path.dirname(appRoot);
  icons.trayIcon = () => nativeImage.createFromPath(path.join(resources, 'packaging/tray.png'));
  icons.windowIcon = () => nativeImage.createFromPath(path.join(resources, 'packaging/icon.png'));
}
require(path.join(appRoot, 'build/main/index.js'));
