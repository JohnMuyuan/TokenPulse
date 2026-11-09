/*
 * 只有周额度、没有 5 小时窗口的供应商（如 SuperGrok）：额度页不放「接口未提供此窗口」的空卡，
 * 周额度窗口单独占满一行；容量趋势不给切 5 小时；时间线不画 5 小时那张空卡。有 5 小时窗口的账号（Claude）照旧两张。
 * 跑法：npx electron --lang=zh-CN scripts/test-weekly-only-ui.cjs（先 npm run compile）。全是演示数据，不碰真实账号。
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-weekly-only-ui-'));
Object.assign(process.env, { TOKENPULSE_DATA_DIR: path.join(root, 'data'), AGENT_SWITCH_HOME: path.join(root, 'home'), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), PI_CODING_AGENT_DIR: path.join(root, 'pi'), TOKENPULSE_DSH_HOME: path.join(root, 'dsh'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), GROK_HOME: path.join(root, 'grok'), AGENT_SWITCH_CC_DB: path.join(root, 'missing.db'), TOKENPULSE_ANTIGRAVITY_DIR: path.join(root, 'antigravity') });
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
write(path.join(root, 'data', 'prefs.json'), JSON.stringify({ autoLaunch: false, autoUpdate: false, closeToTray: true, startMinimized: true, language: 'zh', notifyAt: 0, notifyMismatch: false, ccSwitch: false, seenVersion: require('../package.json').version, onboarding: 'done' }));
const now = Date.now(), hour = 3600000, iso = at => new Date(at).toISOString();
write(path.join(root, 'data', 'quota-history.json'), JSON.stringify({ version: 1, accounts: {
  claude: [0, 1, 2].map(i => ({ at: now - (2 - i) * hour, account: 'claude:demo', five: 10 + i, fiveReset: iso(now + 3 * hour), week: 2 + i, weekReset: iso(now + 100 * hour) })),
  // SuperGrok：只有周额度
  grok: [0, 1, 2].map(i => ({ at: now - (2 - i) * hour, account: 'grok:demo', week: 30 + i, weekReset: iso(now + 80 * hour), weekStart: iso(now - 88 * hour) })),
} }));
app.setPath('userData', path.join(root, 'electron')); app.commandLine.appendSwitch('lang', 'zh-CN'); process.argv.push('--hidden');
require('../build/core/quota.js').fetchOfficialQuota = async () => ({});
const watchdog = setTimeout(() => { console.error('FAIL weekly-only UI timed out'); app.exit(1); }, 60000);
app.on('web-contents-created', (_event, wc) => wc.once('did-finish-load', async () => {
  const e = code => wc.executeJavaScript(code).catch(error => { console.error('UI expression:', code); throw error; });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async code => { const end = Date.now() + 12000; while (!await e(`Promise.resolve(${code}).then(v => !!v)`)) { assert.ok(Date.now() < end, code); await pause(50); } };
  const shot = async name => { if (!process.env.TP_SHOTS) return; const dir = process.env.TP_SHOTS; fs.mkdirSync(dir, { recursive: true }); const win = BrowserWindow.fromWebContents(wc); if (!win.isVisible()) { win.setSize(1440, 900); win.showInactive(); } await pause(900); fs.writeFileSync(path.join(dir, name + '.png'), (await wc.capturePage()).toPNG()); };
  const open = kind => e(`state.account = (current.accounts.find(a => a.kind === '${kind}') || {}).key || '${kind}'; navigate('quota')`);
  const grid = `(() => { const g = document.querySelector('#quota-detail .quota-window-grid'); if (!g) return null; const panels = [...g.querySelectorAll(':scope > .panel')]; return { single: g.classList.contains('single'), count: panels.length, titles: panels.map(p => p.querySelector('h2')?.textContent), full: panels.length ? Math.abs(panels[0].getBoundingClientRect().width - g.getBoundingClientRect().width) < 2 : false, text: g.textContent }; })()`;
  try {
    await until("typeof navigate === 'function' && current?.accounts?.some(a => a.kind === 'grok') && current.accounts.some(a => a.kind === 'claude')");

    await open('grok');
    await until("document.querySelector('#quota-detail .quota-window-grid')");
    const g = await e(grid);
    assert.equal(g.count, 1, 'SuperGrok 只有一张周额度窗口卡');
    assert.deepEqual(g.titles, ['周额度窗口']);
    assert.ok(g.single, '网格切成单列');
    assert.ok(g.full, '周额度窗口占满一行');
    assert.ok(!g.text.includes('接口未提供此窗口'), '没有 5 小时空卡');
    const capButtons = await e(`[...document.querySelectorAll('#quota-detail [data-cap-window]')].map(b => b.dataset.capWindow)`);
    assert.ok(!capButtons.includes('five'), `容量趋势没有 5 小时选项（${capButtons}）`);
    pass('SuperGrok: the weekly window takes the whole row, no empty 5-hour card or capacity tab');

    // 时间线：只要显示了周期卡，就不能有 5 小时那张
    await until("document.querySelector('#quota-model-timeline .ms-cycle')");
    const cards = await e(`[...document.querySelectorAll('#quota-model-timeline .ms-cycle')].map(c => c.dataset.window)`);
    assert.ok(!cards.includes('five'), `时间线没有 5 小时卡（${cards}）`);
    const study = await e(`(() => { const b = document.querySelector('#quota-model-study .ms-budgets'); return b ? { single: b.classList.contains('single'), count: b.children.length, head: document.querySelector('#quota-model-study .ms-rank-head')?.textContent || '' } : null; })()`);
    assert.deepEqual(cards, ['week'], '时间线只剩周额度一张卡');
    if (study) {
      assert.equal(study.count, 1, '整窗预算只有周额度');
      assert.ok(study.single);
      assert.ok(!study.head.includes('5 小时'), '整窗表没有 5 小时那一列');
    }
    await shot('weekly-only-grok');
    pass(`SuperGrok: the timeline and model study drop the 5-hour window (cards: ${cards.join(', ') || 'none'}; study: ${study ? 'rendered' : 'not rendered'})`);

    await open('claude');
    await until("document.querySelectorAll('#quota-detail .quota-window-grid > .panel').length === 2");
    const c = await e(grid);
    assert.deepEqual(c.titles, ['5 小时窗口', '周额度窗口']);
    assert.ok(!c.single);
    const capClaude = await e(`[...document.querySelectorAll('#quota-detail [data-cap-window]')].map(b => b.dataset.capWindow)`);
    // 共享额度保护下容量趋势没有切换按钮；有按钮时两个窗口都在
    if (capClaude.length) assert.deepEqual(capClaude.sort(), ['five', 'week']);
    await until("document.querySelector('#quota-model-timeline .ms-cycle')");
    const claudeCards = await e(`[...document.querySelectorAll('#quota-model-timeline .ms-cycle')].map(c => c.dataset.window)`);
    assert.deepEqual(claudeCards, ['five', 'week'], 'Claude 时间线两张卡都在');
    pass('Claude keeps both the 5-hour and weekly windows side by side');

    // 900px：单列不溢出
    const win = BrowserWindow.fromWebContents(wc); win.setSize(900, 800);
    await open('grok');
    await until("document.querySelector('#quota-detail .quota-window-grid.single')");
    await pause(200);
    assert.equal(await e('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, '900px 不横向溢出');
    pass('900px: the weekly-only layout does not overflow');
    clearTimeout(watchdog); done(0);
  } catch (error) { console.error('FAIL weekly-only UI', error); clearTimeout(watchdog); done(1); }
}));
let checks = 0;
function pass(name) { checks++; console.log('PASS weekly-only UI: ' + name); }
// app.exit 不触发 will-quit：先关窗口释放 userData 里的文件，再删一次性目录
function done(code) { for (const w of BrowserWindow.getAllWindows()) w.destroy(); setTimeout(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} app.exit(code); }, 300); }
require('../build/main/index.js');
