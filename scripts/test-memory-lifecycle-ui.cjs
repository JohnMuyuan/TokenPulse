// Run with Electron: verifies lazy hidden startup, utilityProcess snapshot isolation,
// idle hidden main-window destruction, and clean recreation on revealWindow().
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-mem-lifecycle-'));
const dataDir = path.join(temp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.TOKENPULSE_DATA_DIR = dataDir;
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(temp, 'home');
process.env.TOKENPULSE_ANTIGRAVITY_DIR = path.join(temp, 'no-agy');
process.env.TOKENPULSE_LAZY_WINDOW = '1';
process.env.TOKENPULSE_MAIN_IDLE_DESTROY_MS = '300';
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
app.setPath('userData', path.join(temp, 'electron'));
app.commandLine.appendSwitch('lang', 'zh-CN');
process.argv.push('--hidden');

const version = require('../package.json').version;
fs.writeFileSync(
  path.join(dataDir, 'prefs.json'),
  JSON.stringify({
    autoLaunch: false,
    autoUpdate: false,
    closeToTray: true,
    startMinimized: true,
    deskPet: false,
    language: 'zh',
    notifyAt: 0,
    notifyMismatch: false,
    ccSwitch: false,
    seenVersion: version,
    onboarding: 'done',
    theme: 'light',
  }),
);
const dayKey = require('../renderer/data.js').dayKey;
fs.writeFileSync(
  path.join(dataDir, 'usage-rollups.json'),
  JSON.stringify({
    version: 1,
    scannedAt: Date.now(),
    files: {
      'mem-fixture': {
        kind: 'codex',
        official: true,
        days: {
          [dayKey(Date.now())]: {
            'Codex CLI': { 'gpt-5': { input: 1000, output: 200, cacheRead: 500, cacheWrite: 0, reasoning: 0, costUsd: 0.05, requests: 1 } },
          },
        },
      },
    },
  }),
);

// Stub official quota fetch to avoid network access in offline tests.
require('../build/core/quota.js').fetchOfficialQuota = async () => ({});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await delay(50);
  }
  throw new Error('Timed out: ' + label);
};

const watchdog = setTimeout(() => {
  console.error('FAIL memory lifecycle UI test timed out');
  app.exit(1);
}, 40000);

require('../build/main/index.js');

app.whenReady().then(async () => {
  try {
    // 1. Lazy hidden startup: wait a moment after startup and confirm 0 BrowserWindows exist
    await delay(800);
    assert.equal(BrowserWindow.getAllWindows().length, 0, '开机/托盘延迟启动时不应预建主窗口渲染进程');
    console.log('PASS lazy hidden startup creates 0 BrowserWindows');

    // 2. Verify utilityProcess-backed loadSnapshot runs cleanly and returns our fixture
    const { loadSnapshot } = require('../build/main/snapshot.js');
    const snap = await loadSnapshot(false);
    assert.equal(snap.totals.all.tokens, 1200, 'utilityProcess 隔离扫描应返回正确快照');
    console.log('PASS utilityProcess isolated snapshot returned exact totals');

    // 3. Reveal main window via second-instance event; move offscreen so it does not flash
    app.on('browser-window-created', (_ev, w) => {
      try { w.setPosition(-20000, -20000); } catch { /* ignore */ }
    });
    app.emit('second-instance', [], process.cwd());
    await until(() => BrowserWindow.getAllWindows().length === 1, 'revealWindow creates main window');
    const win1 = BrowserWindow.getAllWindows()[0];
    await until(
      () => !win1.isDestroyed() && win1.webContents.executeJavaScript("document.querySelectorAll('#tiles .stat').length === 4").catch(() => false),
      'recreated window renders stats',
    );
    console.log('PASS revealWindow creates and hydrates main window cleanly');

    // 4. Closing to tray hides immediately and destroys renderer after idle timeout
    win1.close();
    assert.equal(win1.isDestroyed(), false, '关闭收进托盘瞬间先隐藏以便快速重开');
    assert.equal(win1.isVisible(), false, '收进托盘后窗口应隐藏');
    await until(() => BrowserWindow.getAllWindows().length === 0, 'idle hidden main window destroyed to reclaim RAM');
    console.log('PASS idle hidden main window destroyed after tray idle timeout');

    // 5. Re-opening from tray cleanly recreates main window again
    app.emit('second-instance', [], process.cwd());
    await until(() => BrowserWindow.getAllWindows().length === 1, 'second revealWindow recreates main window');
    const win2 = BrowserWindow.getAllWindows()[0];
    await until(
      () => !win2.isDestroyed() && win2.webContents.executeJavaScript("document.querySelectorAll('#tiles .stat').length === 4").catch(() => false),
      'second recreated window renders stats',
    );
    console.log('PASS main window recreates and renders cleanly after idle destruction');

    clearTimeout(watchdog);
    app.exit(0);
  } catch (error) {
    clearTimeout(watchdog);
    console.error('FAIL', error.stack || error.message);
    app.exit(1);
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
