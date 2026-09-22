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
      assert.match(await evaluate("document.querySelectorAll('.quota-card')[2].textContent"), /等待新采样/);
      await evaluate("document.getElementById('settings-open').click()");
      await until("!document.getElementById('settings').hidden");
      await evaluate("document.getElementById('settings-close').click()");
      assert.equal(await evaluate("getComputedStyle(document.getElementById('settings')).display"), 'none');
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
      assert.match(await evaluate("document.getElementById('quota-detail').textContent"), /87.5%/);
      assert.equal(await evaluate("document.querySelectorAll('#quota-detail rect.col').length"), 24);
      await evaluate("document.querySelector('[data-account=grok]').click()");
      assert.match(await evaluate("document.getElementById('quota-detail').textContent"), /历史记录/);
      await evaluate("document.querySelector('[data-account=claude]').click()");
      assert.match(await evaluate("document.getElementById('quota-detail').textContent"), /暂时还没有/);
      console.log('PASS quota predictions, reset confirmation, stale and missing accounts');
      await evaluate("document.querySelector('[data-page=overview]').click(); window.tokenpulse.snapshot().then(s => { const sample = structuredClone(s); const a = sample.accounts.find(a => a.kind === 'chatgpt'); a.five.used = 100; a.five.projectedAtReset = 235; render(sample); })");
      assert.match(await evaluate("document.querySelector('.quota-card .quota-card-foot').textContent"), /额度已用完，等待重置/);
      assert.doesNotMatch(await evaluate("document.querySelector('.quota-card .quota-card-foot').textContent"), /235/);
      console.log('PASS exhausted quota shows a reset instruction instead of a projection');
      await evaluate("document.querySelector('[data-page=usage]').click(); document.getElementById('model-search').value='QA-model'; document.getElementById('model-search').dispatchEvent(new Event('input'))");
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
      await evaluate("document.getElementById('theme-toggle').click()");
      assert.equal(await evaluate("document.documentElement.dataset.theme"), 'dark');
      assert.equal(await evaluate("localStorage.getItem('tokenpulse-theme')"), 'dark');
      await evaluate("document.getElementById('theme-toggle').click(); document.getElementById('custom-range-toggle').click()");
      await evaluate(`document.getElementById('date-from').value='${dayKey(fixtureNow)}'; document.getElementById('date-to').value='${dayKey(fixtureNow)}'; document.getElementById('custom-range').requestSubmit()`);
      assert.equal(await evaluate("document.querySelectorAll('#daily-chart rect.col').length"), 1);
      await evaluate("document.querySelector('[data-days=\"30\"]').click()");
      const window = BrowserWindow.fromWebContents(contents);
      window.setSize(900, 650); await delay(150);
      assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
      for (const page of ['usage', 'quota', 'overview']) {
        await evaluate(`document.querySelector('[data-page=${page}]').click()`);
        assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true, `Overflow at 900px: ${page}`);
      }
      window.setSize(1380, 920); await delay(150);
      console.log('PASS theme persistence, custom dates and 900px layout');
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
