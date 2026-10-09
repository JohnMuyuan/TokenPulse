'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { app, ipcMain, BrowserWindow } = require('electron');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-concurrency-ui-'));
process.env.TOKENPULSE_DATA_DIR = path.join(dir, 'data');
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(dir, 'home');
process.env.AGENT_SWITCH_CC_DB = path.join(dir, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'prefs.json'), JSON.stringify({ autoLaunch: false, autoUpdate: false, closeToTray: true, startMinimized: true, language: 'zh', notifyAt: 0, notifyMismatch: false, seenVersion: require('../package.json').version, onboarding: 'done' }));
app.setPath('userData', path.join(dir, 'electron'));
const { ConcurrencyService } = require('../build/main/concurrency-monitor');
const { validateConcurrencySettings } = require('../build/core/concurrency');
ConcurrencyService.prototype.start = ConcurrencyService.prototype.stop = () => {};
const counts = { requests: 3, clients: 2, upstream: 4 }, supported = { requests: 1, clients: 1, upstream: 1 };
let state = { at: Date.now(), settings: { retention: 30, rules: {} }, alerts: [], storageError: '', coverage: [{ app: 'codex', monitored: true }], rows: [
  { id: 'global', label: '全部转发', kind: 'provider', ...counts, supported, rejected: 2 },
  { id: 'provider:qa', label: 'QA Provider', kind: 'provider', ...counts, supported, rejected: 0 },
  { id: 'account:qa', label: 'QA Account', kind: 'account', ...counts, supported, rejected: 0 },
  { id: 'unattributed:codex', label: 'codex · 未归属账号', kind: 'unattributed', ...counts, supported: { requests: 0, clients: 0, upstream: 0 }, rejected: 0 },
  { id: 'shared', label: '共享连接', kind: 'shared', requests: 0, clients: 1, upstream: 1, supported: { requests: 0, clients: 0, upstream: 0 }, rejected: 0 }
] };
let saves = 0, delayed = null, failHistory = false, historyCalls = [];
const history = query => { const at = Date.now(); return { at, since: at - 600000, metric: query.metric, scope: query.scope, points: [
  { at: at - 500000, until: at - 440000, session: 'first', min: 0, max: query.days === 7 ? 7 : 3, last: 0, rejected: 0 },
  { at: at - 200000, until: at - 140000, session: 'restart', min: 0, max: 2, last: 0, rejected: 1 }
] }; };
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => handle(channel, async (...args) => {
  if (channel === 'concurrency:state') return structuredClone(state);
  if (channel === 'concurrency:save') { saves++; state.settings = validateConcurrencySettings(args[1]); state.rows.forEach(row => row.rule = state.settings.rules[row.id]); return structuredClone(state); }
  if (channel === 'concurrency:history') {
    const query = args[1]; historyCalls.push(query);
    if (query.days === 30) await new Promise(resolve => delayed = resolve);
    if (failHistory) throw Error('Synthetic history error');
    return history(query);
  }
  return handler(...args);
});
const watchdog = setTimeout(() => { console.error('FAIL concurrency UI timed out'); app.exit(1); }, 45000);
let finished = false;
app.on('web-contents-created', (_event, wc) => wc.once('did-finish-load', async () => {
  wc.on('console-message', (_event, _level, message) => console.log('RENDERER', message));
  const e = async code => { try { return await wc.executeJavaScript(code); } catch (error) { console.error('UI expression:', code); throw error; } };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async code => { const end = Date.now() + 6000; while (!await e(code)) { assert.ok(Date.now() < end, code); await pause(30); } };
  try {
    await until("typeof navigate === 'function' && !!current");
    if (await e("PulseI18n.lang()!=='zh'")) {
      const loaded = new Promise(resolve => wc.once('did-finish-load', resolve)); await e("PulseI18n.setMode('zh')"); await loaded;
      await until("typeof navigate === 'function' && !!current");
    }
    await e("navigate('concurrency')"); await until("document.querySelector('#page-concurrency svg')");
    assert.deepEqual(await e("[...document.querySelectorAll('.cm-card strong')].map(x=>x.textContent)"), ['3', '2', '4']);
    assert.equal(await e("document.querySelector('#cm-action').value"), 'warn');
    assert.equal(await e("document.querySelector('#cm-retention').value"), '30');
    assert.equal(await e("document.querySelector('#cm-limit-requests').value"), '');
    assert.equal(await e("document.querySelector('#cm-rows [data-scope=shared] button').disabled"), true);
    assert.equal(await e("document.querySelectorAll('#page-concurrency polyline').length"), 2, 'restart gap stays visible');
    await e("document.querySelector('#cm-limit-requests').value='0';document.querySelector('#cm-save').click()");
    assert.equal(saves, 0); assert.equal(await e("document.activeElement.id"), 'cm-limit-requests');
    await e("document.querySelector('#cm-limit-requests').value='4';document.querySelector('#cm-action').value='reject';document.querySelector('#cm-retention').value='0';document.querySelector('#cm-save').click()");
    await until("!document.querySelector('#cm-save').disabled"); assert.equal(saves, 1); assert.equal(state.settings.retention, 0); assert.equal(state.settings.rules.global.requests, 4);
    await e("document.querySelector('#cm-rule-scope').value='account:qa';document.querySelector('#cm-rule-scope').dispatchEvent(new Event('change'));document.querySelector('#cm-limit-clients').value='6';document.querySelector('#cm-save').click()");
    await until("!document.querySelector('#cm-save').disabled"); assert.equal(state.settings.rules['account:qa'].clients, 6); assert.equal(state.settings.rules.global.requests, 4);
    await e("document.querySelector('#cm-limit-requests').value='12';document.querySelector('#cm-limit-requests').focus()");
    state.rows[0].requests = 5; state.alerts = [{ scope: 'global', label: '全部转发', metric: 'requests', count: 5, limit: 4, rejected: true }]; wc.send('concurrency-state', state); await pause(80);
    assert.equal(await e("document.querySelector('.cm-card strong').textContent"), '5');
    assert.equal(await e("document.querySelector('#cm-limit-requests').value"), '12'); assert.equal(await e("document.activeElement.id"), 'cm-limit-requests');
    assert.match(await e("document.querySelector('.cm-alert').textContent"), /已拒绝/);
    // 0.3.40 重新设计：设了上限的卡片带进度条，超过上限变红；导航图标不再和供应商共用
    assert.deepEqual(await e("(()=>{const c=document.querySelector('.cm-card');return [c.dataset.tone,c.querySelector('.cm-meter').hidden,c.querySelector('.cm-meter i').style.width,c.querySelector('[data-limit]').textContent]})()"), ['over', false, '100%', '上限: 4']);
    assert.equal(await e("document.querySelector('#cm-rows [data-scope=global] .cm-count').textContent"), '5 / 4');
    assert.deepEqual(await e("['concurrency','providers'].map(p=>document.querySelector('#nav [data-page='+p+'] use').getAttribute('href'))"), ['#i-concurrency', '#i-route']);
    // 下拉框是应用自己的菜单：按钮上的字跟着值走，点开选一项会改到原生 select 并触发 change
    assert.deepEqual(await e("['cm-rule-scope','cm-action','cm-retention'].map(id=>document.querySelector('[data-for='+id+']').textContent)"), ['QA Account', '仅提醒', '永久保存']);
    await e("document.querySelector('[data-for=cm-metric]').scrollIntoView({block:'center'})"); await pause(700); await e("document.querySelector('[data-for=cm-metric]').click()"); await until("!document.getElementById('option-menu').hidden");
    assert.deepEqual(await e("[...document.querySelectorAll('#option-menu .option-item')].map(x=>[x.textContent,x.getAttribute('aria-checked')])"), [['活跃 AI 请求', 'true'], ['客户端连接', 'false'], ['上游连接', 'false']]);
    if (process.env.TOKENPULSE_CAPTURE_CONCURRENCY) { const w = BrowserWindow.fromWebContents(wc); w.setSize(1180, 880); w.showInactive(); await pause(250); await wc.capturePage(); await pause(100); fs.writeFileSync(path.join(process.env.TOKENPULSE_CAPTURE_CONCURRENCY, 'concurrency-menu-qa.png'), (await wc.capturePage()).toPNG()); w.hide(); }
    await e("document.querySelectorAll('#option-menu .option-item')[1].click()");
    await until("document.querySelector('#cm-metric').value==='clients' && document.querySelector('[data-for=cm-metric]').textContent==='客户端连接' && document.getElementById('option-menu').hidden");
    await e("document.querySelector('#cm-metric').value='requests';document.querySelector('#cm-metric').dispatchEvent(new Event('change'))");
    assert.equal(await e("document.querySelector('[data-for=cm-metric]').textContent"), '活跃 AI 请求');
    assert.deepEqual(await e("[...document.querySelectorAll('#cm-rows .cm-kind')].map(x=>x.textContent)"), ['全部', '供应商', '账号', '未归属', '共享']);
    await e("void(window.qaChart=document.querySelector('#page-concurrency svg'));document.querySelector('#cm-days').value='30';document.querySelector('#cm-days').dispatchEvent(new Event('change'))");
    await until("document.querySelector('.cm-chart').getAttribute('aria-busy')==='true'");
    assert.equal(await e("window.qaChart===document.querySelector('#page-concurrency svg')"), true, 'range load retains chart');
    await e("document.querySelector('#cm-days').value='7';document.querySelector('#cm-days').dispatchEvent(new Event('change'))");
    await until("document.querySelector('.cm-chart').getAttribute('aria-label').includes('7')");
    delayed(); delayed = null; await pause(80);
    assert.match(await e("document.querySelector('.cm-chart').getAttribute('aria-label')"), /7/);
    failHistory = true; await e("void(window.qaChart=document.querySelector('#page-concurrency svg'));document.querySelector('#cm-days').value='90';document.querySelector('#cm-days').dispatchEvent(new Event('change'))");
    await until("document.querySelector('.cm-status button')"); assert.equal(await e("window.qaChart===document.querySelector('#page-concurrency svg')"), true);
    failHistory = false; await e("document.querySelector('.cm-status button').click()"); await until("document.querySelector('.cm-chart').getAttribute('aria-busy')==='false'");
    await e("navigate('overview')"); state.rows[0].requests = 9; wc.send('concurrency-state', state); await pause(60); assert.equal(await e("document.querySelector('.cm-card strong').textContent"), '5', 'hidden view unsubscribes');
    state.coverage[0].monitored = false; await e("navigate('concurrency')"); await until("document.querySelector('.cm-card strong').textContent==='—'");
    assert.deepEqual(await e("[...document.querySelectorAll('.cm-coverage .cm-chip')].map(c=>[c.dataset.app,c.classList.contains('on'),c.querySelector('.cm-chip-state').textContent])"), [['codex', false, '直连未监控']]);
    await e("setThemeMode('dark');document.getAnimations().filter(a=>Number.isFinite(a.effect.getComputedTiming().endTime)).forEach(a=>a.finish())"); const win = BrowserWindow.fromWebContents(wc); win.setSize(900, 800); await pause(100);
    assert.equal(await e("document.querySelector('#page-concurrency').scrollWidth<=document.querySelector('#page-concurrency').clientWidth+1"), true);
    win.setSize(700, 800); await pause(100); assert.equal(await e("document.querySelector('#page-concurrency').scrollWidth<=document.querySelector('#page-concurrency').clientWidth+1"), true);
    wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await e("document.querySelector('#cm-rule-scope').focus()"); assert.equal(await e("document.activeElement.id"), 'cm-rule-scope'); wc.debugger.detach();
    // Reload in English with synthetic state. Locale translation must cover generated scope labels.
    const loaded = new Promise(resolve => wc.once('did-finish-load', resolve)); await e("PulseI18n.setMode('en')"); await loaded;
    await until("typeof navigate==='function' && !!current"); await e("navigate('concurrency')"); await until("document.querySelector('#page-concurrency svg')");
    assert.equal(await e("/[\u3400-\u9fff]/.test(document.querySelector('#page-concurrency').textContent)"), false, 'monitoring UI is fully English');
    assert.match(await e("document.querySelector('#page-concurrency').textContent"), /Unattributed|Shared/);
    if (process.env.TOKENPULSE_CAPTURE_CONCURRENCY) {
      state.coverage[0].monitored = true; state.rows[0].requests = 5; wc.send('concurrency-state', state);
      win.setSize(1180, 880); win.showInactive(); await pause(200); await wc.capturePage(); await pause(100);
      fs.writeFileSync(path.join(process.env.TOKENPULSE_CAPTURE_CONCURRENCY, 'concurrency-qa.png'), (await wc.capturePage()).toPNG());
      await e("setThemeMode('light');document.querySelector('.cm-breakdown').scrollIntoView({block:'start'})"); await pause(150); fs.writeFileSync(path.join(process.env.TOKENPULSE_CAPTURE_CONCURRENCY, 'concurrency-settings-qa.png'), (await wc.capturePage()).toPNG()); win.hide();
    }
    finished = true; clearTimeout(watchdog); console.log('PASS concurrency UI: navigation, live pushes/drafts, validation, independent rules, retention, retained charts/stale loads/retry, gaps, unsubscribe, unmonitored, Chinese/English, dark/narrow, keyboard/reduced motion'); app.exit(0);
  } catch (error) { clearTimeout(watchdog); console.error('FAIL', error); app.exit(1); }
}));
// Remove only this test's isolated directory after Electron releases its files.
process.on('exit', () => { if (finished && path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } });
require('../build/main/index.js');
