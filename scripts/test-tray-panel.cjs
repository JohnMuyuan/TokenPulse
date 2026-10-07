'use strict';
/*
 * 托盘小面板（src/main/tray-panel.ts）里不依赖窗口的两块：从快照里挑数据、算面板该放在哪。
 * 面板本身的界面在 test-tray-panel-ui.cjs（Electron）。
 */
const assert = require('node:assert/strict');
const { trayPanelData, panelBounds } = require('../build/main/tray-panel');

const now = Date.now();
const snapshot = {
  totals: { today: { tokens: 1234567, costUsd: 3.5 } },
  accounts: [
    { kind: 'claude', plan: 'max', lastCheckedAt: now - 1000, accountLabel: 'secret@example.com', five: { used: 36.4, resetAt: now + 3600000, etaAt: now + 60000, runsOutBeforeReset: true, elapsedH: 4, leftH: 1 }, week: { used: 140, resetAt: now + 86400000, runsOutBeforeReset: false } },
    { kind: 'grok', lastSampleAt: now - 5000, week: { used: -3 } },
    { kind: 'chatgpt' },
  ],
};
const agents = [{ app: 'codex', label: 'Codex', current: 'Relay', readOnly: false, providers: [{ id: 'p1', name: 'Relay', active: true }] }];
const data = trayPanelData(snapshot, 'dark', account => 'T-' + account.kind, agents);
assert.deepEqual(data.agents, agents, '供应商原样带上');
assert.equal(data.theme, 'dark');
assert.deepEqual(data.today, { tokens: 1234567, costUsd: 3.5 });
assert.deepEqual(data.accounts.map(a => a.kind), ['claude', 'grok'], '一个窗口都没有的账号不列');
assert.deepEqual(data.accounts[0], { kind: 'claude', name: 'T-claude', plan: 'max', checkedAt: now - 1000,
  // pace：时间过了 4 / (4 + 1) = 80%；没有起止时间的窗口是 -1
  five: { used: 36.4, resetAt: now + 3600000, etaAt: now + 60000, runsOut: true, pace: 80 }, week: { used: 100, resetAt: now + 86400000, etaAt: 0, runsOut: false, pace: -1 } });
assert.deepEqual(data.accounts[1], { kind: 'grok', name: 'T-grok', plan: '', checkedAt: now - 5000, five: null, week: { used: 0, resetAt: 0, etaAt: 0, runsOut: false, pace: -1 } });
assert.equal(JSON.stringify(data).includes('secret@example.com'), false, '只带名字，不带快照里别的账号字段');
assert.deepEqual(trayPanelData(null, 'light', () => '').accounts, []); assert.deepEqual(trayPanelData(null, 'light', () => '').agents, []);
console.log('PASS tray panel: data picked from the snapshot, clamped, accounts without quota skipped');

const size = { width: 340, height: 400 }, work = { x: 0, y: 0, width: 1920, height: 1040 };
// 任务栏在下：面板在图标正上方，贴着可用区域的底边
assert.deepEqual(panelBounds({ x: 1700, y: 1048, width: 24, height: 24 }, work, size), { x: 1542, y: 630, width: 340, height: 400 });
// 图标靠屏幕右边：不超出屏幕
assert.equal(panelBounds({ x: 1900, y: 1048, width: 24, height: 24 }, work, size).x, 1920 - 340 - 10);
// 任务栏在上 / 左 / 右
assert.equal(panelBounds({ x: 900, y: 4, width: 24, height: 24 }, { x: 0, y: 40, width: 1920, height: 1040 }, size).y, 50);
assert.deepEqual(panelBounds({ x: 10, y: 500, width: 24, height: 24 }, { x: 48, y: 0, width: 1872, height: 1080 }, size), { x: 58, y: 312, width: 340, height: 400 });
assert.equal(panelBounds({ x: 1890, y: 500, width: 24, height: 24 }, { x: 0, y: 0, width: 1872, height: 1080 }, size).x, 1872 - 340 - 10);
// 副屏在左边（坐标是负的）、内容比屏幕还高
assert.deepEqual(panelBounds({ x: -300, y: 1048, width: 24, height: 24 }, { x: -1920, y: 0, width: 1920, height: 1040 }, { width: 340, height: 2000 }), { x: -458, y: 10, width: 340, height: 1020 });
console.log('PASS tray panel: placed next to the tray icon on any taskbar edge, kept inside the work area');
