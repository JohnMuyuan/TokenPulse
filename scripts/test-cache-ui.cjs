const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { priceOf } = require('../build/core/model-pricing.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-cache-ui-'));
assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'TOKENPULSE_DSH_HOME']) delete process.env[key];
app.setPath('userData', path.join(root, 'electron'));
app.commandLine.appendSwitch('lang', 'zh-CN'); process.argv.push('--hidden');
const appRoot = process.env.TOKENPULSE_TEST_APP || path.resolve(__dirname, '..');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const now = Date.now(), minute = 60_000;
const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
const firstAt = Math.max(midnight.getTime() + minute, now - 25 * minute);
const records = [];
let nextId = 0;
const rec = (session, at, extra = {}) => ({
  id: `cache-ui-${nextId++}`, at, kind: 'codex', file: path.join(root, `rollout-2026-10-15T00-00-00-${session}.jsonl`),
  cwd: 'D:\\Demo\\CacheProject', model: 'gpt-6-astra', input: 10_000, output: 100, cacheRead: 8_000, cacheWrite: 0,
  reasoning: 0, costUsd: 0, calls: 1, cacheWrite: 500, ...extra
});
const account = id => ({ routedAccount: `claude:${id}`, routedAccountBasis: 'route-window' });
const cases = [
  { session: 'cache-compaction', cause: 'compaction', gap: minute, prev: account('before'), cur: { ...account('after'), model: 'claude-opus-5-5' }, compaction: true },
  { session: 'cache-model', cause: 'model', gap: 8 * minute, prev: account('before'), cur: { ...account('after'), model: 'claude-opus-5-5' } },
  { session: 'cache-account', cause: 'account', gap: 8 * minute, prev: account('before'), cur: account('after') },
  { session: 'cache-idle', cause: 'idle', gap: 8 * minute },
  { session: 'cache-unknown', cause: 'unknown', gap: minute }
];
for (let i = 0; i < cases.length; i++) {
  const test = cases[i], prevAt = firstAt + i * 4 * minute;
  records.push(rec(test.session, prevAt, { ...test.prev, input: 10_000, cacheRead: 8_000 }));
  if (test.compaction) records.push(rec(test.session, prevAt + 30_000, { compaction: true, input: 50_000, cacheRead: 45_000 }));
  records.push(rec(test.session, prevAt + test.gap, { ...test.cur, input: 10_000, cacheRead: 0 }));
}
const months = new Map();
for (const row of records) {
  const d = new Date(row.at), month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (!months.has(month)) months.set(month, []);
  months.get(month).push(JSON.stringify(row));
}
for (const [month, rows] of months) write(path.join(root, 'data', 'requests', `${month}.jsonl`), rows.join('\n') + '\n');
write(path.join(root, 'data', 'prefs.json'), { autoLaunch: false, autoUpdate: false, closeToTray: true, startMinimized: true, language: 'zh', notifyAt: 0, notifyMismatch: false, ccSwitch: false, seenVersion: require('../package.json').version, onboarding: 'done' });
require(path.join(appRoot, 'build/core/quota.js')).fetchOfficialQuota = async () => ({});
const watchdog = setTimeout(() => { console.error('FAIL cache UI timed out'); app.exit(1); }, 45_000);
let started = false;
app.on('web-contents-created', (_, contents) => contents.once('did-finish-load', async () => {
  if (started) return;
  started = true;
  const evaluate = code => contents.executeJavaScript(code), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async code => { const end = Date.now() + 12_000; while (!await evaluate(code)) { assert.ok(Date.now() < end, 'Timed out: ' + code); await delay(35); } };
  // 自查截图（只用这里的测试数据）：窗口默认隐藏，截之前要先显示出来
  if (process.env.TP_SHOTS) { const win = BrowserWindow.fromWebContents(contents); win.setSize(1440, 900); win.showInactive(); }
  try {
    await until('typeof current !== "undefined" && current && current.scannedAt');
    await until("document.querySelector('#tiles .stat-clickable[role=button]') !== null");
    await evaluate("document.querySelector('#tiles .stat-clickable[role=button]').click()");
    await until("state.page === 'usage' && state.usageView === 'cache'");
    await until("document.querySelectorAll('#view-cache .cc-stat').length === 4 && !document.querySelector('#view-cache').hasAttribute('aria-busy') && !!window.PulseCache");
    await evaluate("document.querySelector('#usage-view [data-view=requests]').click()");
    assert.equal(await evaluate("state.usageView"), 'requests');
    await evaluate("document.querySelector('#usage-view [data-view=cache]').click()");
    await until("state.usageView === 'cache' && document.querySelectorAll('#view-cache .cc-stat').length === 4 && !document.querySelector('#view-cache').hasAttribute('aria-busy')");
    assert.deepEqual(await evaluate("['view-requests','view-daily','view-projects','view-cache'].map(id => document.getElementById(id).hidden)"), [true, true, true, false]);
    assert.deepEqual(await evaluate("['verify-help','export-requests','export-csv'].map(id => document.getElementById(id).hidden)"), [true, true, true]);
    assert.equal(await evaluate("document.querySelector('#usage-view [data-view=cache]').getAttribute('aria-pressed')"), 'true');
    const values = await evaluate("[...document.querySelectorAll('#view-cache .cc-stat-value')].map(node => node.textContent)");
    assert.equal(values.length, 4);
    const totalInput = records.reduce((sum, row) => sum + row.input, 0), totalRead = records.reduce((sum, row) => sum + row.cacheRead, 0);
    assert.equal(values[0], `${(totalRead / totalInput * 100).toFixed(1)}%`, 'cache reads divided by input, compaction estimates included like other pages');
    assert.equal(values[2], '5', 'one break per cause');
    assert.equal(values[3], '5', 'one cold start per session');
    const details = await evaluate("[...document.querySelectorAll('#view-cache .cc-stat span')].map(node => node.textContent)");
    assert.equal(details[0], '缓存读取 ÷ 输入');
    assert.equal(details[1], '参考标价估算');
    assert.equal(await evaluate("document.querySelectorAll('#view-cache .cc-cause-row').length"), 5);
    assert.equal(await evaluate("[...document.querySelectorAll('#view-cache .cc-cause-bar')].every(node => parseFloat(getComputedStyle(node).width) > 0)"), true);
    assert.equal(await evaluate("document.querySelectorAll('#view-cache .cc-chart svg').length"), 1);
    assert.equal(await evaluate("document.querySelectorAll('#view-cache .cc-chart .cc-point').length"), 1, 'single-day chart still has its rate point');
    const causeRows = await evaluate("[...document.querySelectorAll('#view-cache .cc-cause-copy b')].map(node => node.textContent)");
    assert.deepEqual(causeRows, ['压缩', '型号变化', '账号变化', '空闲过久', '原因不明']);
    const sessionSection = await evaluate("(() => { const n=[...document.querySelectorAll('#view-cache .cc-section')].find(n=>n.querySelector('h3')?.textContent==='断档最多的会话'); return n?.querySelectorAll('tbody tr').length || 0; })()");
    assert.equal(sessionSection, 5);
    assert.equal(await evaluate("(() => { const n=[...document.querySelectorAll('#view-cache .cc-section')].find(n=>n.querySelector('h3')?.textContent==='最近的断档'); return n?.querySelectorAll('tbody tr').length || 0; })()"), 5);
    assert.equal(await evaluate("document.querySelector('#view-cache .cc-chart .cc-legend').children.length"), 4);
    assert.equal(await evaluate("document.querySelector('#view-cache .cc-chart .cc-hit').getAttribute('style')"), null, 'chart interaction has no inline style attribute');
    assert.ok(await evaluate("getComputedStyle(document.querySelector('#view-cache .cc-cause-bar')).width") !== '0px');
    const expectedSavings = records.reduce((sum, row) => {
      const price = priceOf(row.model);
      const writePrice = price.cacheWrite > 0 ? price.cacheWrite : price.input;
      return sum + (row.cacheRead * (price.input - price.cacheRead) - row.cacheWrite * (writePrice - price.input)) / 1_000_000;
    }, 0);
    assert.equal(values[1], await evaluate(`'≈ ' + money(${expectedSavings})`));
    const firstBySession = new Map(), lastBySession = new Map();
    for (const row of records.filter(row => !row.compaction).sort((a, b) => a.at - b.at)) {
      if (!firstBySession.has(row.file)) firstBySession.set(row.file, row);
      lastBySession.set(row.file, row);
    }
    const coldTokens = [...firstBySession.values()].reduce((sum, row) => sum + row.cacheWrite, 0);
    const coldCost = [...firstBySession.values()].reduce((sum, row) => {
      const price = priceOf(row.model);
      return sum + row.cacheWrite * (price.cacheWrite > 0 ? price.cacheWrite : price.input) / 1_000_000;
    }, 0);
    const extraCost = [...lastBySession.values()].reduce((sum, row) => {
      const price = priceOf(row.model);
      return sum + (10_000 - row.cacheRead) * ((price.cacheWrite > 0 ? price.cacheWrite : price.input) - price.cacheRead) / 1_000_000;
    }, 0);
    assert.equal(details[2], `多花 ≈ ${await evaluate(`money(${extraCost})`)}`);
    assert.equal(details[3], `${coldTokens.toLocaleString('en-US')} 缓存写入 Tokens`);
    assert.equal(await evaluate("document.querySelector('#view-cache .cc-stat:nth-child(4)').title"), `写入花费 ≈ ${await evaluate(`money(${coldCost})`)}`);

    if (process.env.TP_SHOTS) {
      fs.mkdirSync(process.env.TP_SHOTS, { recursive: true });
      await evaluate("document.querySelector('.panel-heading:has(#usage-view)')?.scrollIntoView({ block: 'start' })");
      await delay(400);
      const image = await contents.capturePage();
      fs.writeFileSync(path.join(process.env.TP_SHOTS, 'cache-analysis.png'), image.toPNG());
    }

    const loaded = new Promise(resolve => contents.once('did-finish-load', resolve));
    await evaluate("localStorage.setItem('tokenpulse-lang', 'en'); location.reload()");
    await loaded;
    await delay(200);
    await evaluate("navigate('usage'); showUsageView('cache'); if (current) render(current)");
    await until("document.querySelectorAll('#view-cache .cc-stat').length === 4 && !document.querySelector('#view-cache').hasAttribute('aria-busy')");
    const leftovers = await evaluate("(() => { const host=document.querySelector('#view-cache'); const text=host.textContent+' '+[...host.querySelectorAll('*')].map(n=>[n.title,n.getAttribute('aria-label')].filter(Boolean).join(' ')).join(' '); return text.match(/[一-鿿]+/g) || []; })()");
    assert.deepEqual(leftovers, [], 'English cache view contains no untranslated Chinese');
    assert.equal(await evaluate("document.querySelector('#usage-view [data-view=cache]').textContent"), 'Cache');
    console.log('PASS cache UI: view switch and filters, summary values, five causes, one-day SVG chart, tool/model tables, session and recent-break rows, English copy');
    clearTimeout(watchdog); app.exit(0);
  } catch (error) {
    console.error('FAIL cache UI:', error.stack || error.message);
    clearTimeout(watchdog); app.exit(1);
  }
}));
app.on('quit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Chromium must release its temp handles first. */ } });
if (process.env.TOKENPULSE_TEST_APP) {
  const { nativeImage } = require('electron'); const icons = require(path.join(appRoot, 'build/main/icon.js')); const resources = path.dirname(appRoot);
  icons.trayIcon = () => nativeImage.createFromPath(path.join(resources, 'packaging/tray.png'));
  icons.windowIcon = () => nativeImage.createFromPath(path.join(resources, 'packaging/icon.png'));
}
require(path.join(appRoot, 'build/main/index.js'));
