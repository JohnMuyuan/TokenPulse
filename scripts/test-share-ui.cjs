// 分享入口、月份、徽章、导出、通知与异步竞态；数据/保存/剪贴板全部隔离。
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { app, ipcMain, BrowserWindow, nativeImage } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-share-ui-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true }); fs.mkdirSync(process.env.HOME, { recursive: true });
app.setPath('userData', path.join(root, 'electron')); app.commandLine.appendSwitch('lang', 'zh-CN'); process.argv.push('--hidden');
fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'prefs.json'), JSON.stringify({ autoLaunch: false, autoUpdate: false, startMinimized: true, ccSwitch: false, seenVersion: require('../package.json').version, onboarding: 'done', language: 'zh' }));
require('../build/core/quota').fetchOfficialQuota = async () => ({});
const reports = require('../build/core/share-report');
const usage = ['2026-08-01', '2026-09-01', '2026-09-02'].map((day, i) => ({ day, source: 'Claude Code', model: 'claude-demo', tokens: (i + 1) * 100000000, input: (i + 1) * 90000000, output: (i + 1) * 10000000, cacheRead: 0, cacheWrite: 0, requests: 120, costUsd: 20, priced: true }));
let milestones = reports.milestoneState(usage, new Date(2026, 9, 13, 12).getTime()), delayed = false, copied = 0, saved = 0;
const pngs = new Map(), renders = [], saveNames = [];
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => handle(channel,
  channel === 'share:month' ? (_event, month) => ({ months: ['2026-09', '2026-08'], report: { ...reports.monthReport({ usage, month: month || '2026-09' }), routes: ['DEMO Pool'] } })
      : channel === 'share:week' ? (_event, week) => { const weeks = reports.reportWeeks(usage).map(value => ({ week: value, label: reports.weekLabel(value) })); const pick = week || weeks[0]?.week; return { weeks, report: pick ? reports.weekReport({ usage, week: pick }) : null }; }
      : channel === 'share:milestones' ? () => milestones
      : channel === 'share:render' ? async (...args) => { const wait = delayed; delayed = false; const result = await handler(...args); renders.push(args.slice(1)); pngs.set(args[2].month || args[2].week || 'milestone', result); if (wait) await new Promise(resolve => setTimeout(resolve, 700)); return result; }
        : channel === 'share:save' ? (_event, png, name) => { assert.ok(!nativeImage.createFromDataURL(png).isEmpty()); assert.match(name, /^TokenPulse-/); saveNames.push(name); saved++; return { saved: true, file: name + '.png' }; }
          : channel === 'share:copy' ? (_event, png) => { assert.ok(!nativeImage.createFromDataURL(png).isEmpty()); copied++; return { copied: true }; } : handler);
const watchdog = setTimeout(() => { console.error('FAIL share UI timed out'); app.exit(1); }, 120000);
app.on('web-contents-created', (_, wc) => wc.once('did-finish-load', async () => {
  if (!wc.getURL().endsWith('/index.html')) return;
  const e = code => wc.executeJavaScript(code), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async code => { const end = Date.now() + 15000; while (!await e(code)) { assert.ok(Date.now() < end, code); await pause(40); } };
  const untilMain = async check => { const end = Date.now() + 15000; while (!check()) { assert.ok(Date.now() < end, 'main-process condition'); await pause(40); } };
  const click = selector => e(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const ready = () => until("document.querySelector('#share-dialog .share-preview img') && !document.querySelector('#share-dialog footer .btn-accent').disabled");
  const shot = async name => { const dir = process.env.TP_SHOTS || process.env.TOKENPULSE_SHOT_DIR; if (dir) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name + '.png'), (await wc.capturePage()).toPNG()); } };
  const shotCard = (name, dataUrl) => { const dir = process.env.TP_SHOTS || process.env.TOKENPULSE_SHOT_DIR; if (dir && dataUrl) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from(dataUrl.split(',')[1], 'base64')); } };
  try {
    await until("window.PulseShare && typeof current !== 'undefined' && current?.scannedAt");
    await click('#share-open'); await ready();
    assert.equal(await e("document.querySelector('#share-month').value"), '2026-09');
    assert.equal(await e("document.querySelector('#share-names').checked"), false);
    await e("document.querySelector('#share-subscription').value='200'; document.querySelector('#share-subscription').dispatchEvent(new Event('change'))"); await ready();
    assert.equal(renders.at(-1)[2].subscriptionUsd, 200);
    await e("document.querySelector('#share-names').click()"); await ready();
    assert.equal(renders.at(-1)[2].showNames, true);
    await shot('share-dialog-month');
    await click('#share-dialog footer .btn-accent');
    await click('#share-dialog footer .btn:not(.btn-accent):not([hidden])');
    await until("[...document.querySelectorAll('.tp-toast-message')].some(n=>n.textContent.includes('已复制'))");
    assert.equal(saved, 1); assert.equal(copied, 1);
    console.log('PASS share UI: month selection, subscription, name disclosure, PNG preview, mocked save/copy');

    await click('#share-dialog .share-tabs button:nth-child(2)'); await ready();
    assert.ok(await e("document.querySelector('#share-week') && document.querySelector('#share-dialog .share-preview img')"));
    assert.ok(await e("document.querySelector('#share-week option').textContent.includes('月')"));
    await shot('share-dialog-week');
    const firstWeek = await e("document.querySelector('#share-week').value");
    const nextWeek = await e("document.querySelector('#share-week option:nth-child(2)')?.value || document.querySelector('#share-week').value");
    await e(`document.querySelector('#share-week').value=${JSON.stringify(nextWeek)}; document.querySelector('#share-week').dispatchEvent(new Event('change'))`); await ready();
    assert.equal(renders.at(-1)[0], 'week'); assert.equal(renders.at(-1)[1].week, nextWeek);
    assert.notEqual(firstWeek, '');
    shotCard('share-week-card', pngs.get(firstWeek));
    await click('#share-dialog footer .btn-accent');
    await untilMain(() => saveNames.length === 2);
    assert.equal(saveNames.at(-1), `TokenPulse-week-${nextWeek}`);
    await click('#share-dialog .share-tabs button:nth-child(3)'); await ready();
    assert.equal(await e("document.querySelectorAll('#share-dialog .share-badge').length"), milestones.list.length);
    await e("document.querySelector('#share-dialog .share-tabs button:nth-child(3)').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))"); await ready();
    assert.ok(await e("document.querySelector('#share-dialog .share-tabs button:nth-child(1)').getAttribute('aria-selected') === 'true'"));
    await click('#share-dialog .share-tabs button:nth-child(2)'); await ready();
    await click('#share-dialog .share-tabs button:nth-child(1)'); await ready();
    console.log('PASS share UI: weekly preview, labeled week selector and three-tab keyboard cycle');

    delayed = true;
    await e("document.querySelector('#share-subscription').value='100'; document.querySelector('#share-subscription').dispatchEvent(new Event('change'))");
    await e("document.querySelector('#share-month').value='2026-08'; document.querySelector('#share-month').dispatchEvent(new Event('change'))"); await ready(); await pause(850);
    assert.equal(await e("document.querySelector('#share-dialog img').src"), pngs.get('2026-08'));
    await click('#share-dialog .share-tabs button:nth-child(3)'); await ready();
    assert.equal(await e("document.querySelectorAll('#share-dialog .share-badge').length"), milestones.list.length);
    assert.ok(await e("document.querySelector('#share-dialog .share-badge:disabled')"));
    await e("document.querySelector('#share-dialog .share-badge:not(:disabled)').click()"); await ready();
    assert.equal(renders.at(-1)[0], 'milestone'); assert.equal(renders.at(-1)[2].id, 'tokens-1e8');
    await shot('share-dialog-milestone');
    await e("document.querySelector('#share-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await until("!document.querySelector('#share-dialog')");
    assert.equal(await e("Boolean(document.querySelector('#share-dialog'))"), false);
    console.log('PASS share UI: late previews cannot replace the selected month; badge collection and Escape');

    wc.send('open-page', { page: 'share', tab: 'week', pick: '2026-07-27' });
    await ready();
    assert.equal(await e("document.querySelector('#share-week').value"), '2026-07-27');
    await e("document.querySelector('#share-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await until("!document.querySelector('#share-dialog')");
    wc.send('open-page', { page: 'settings', tab: 'alerts' });
    await until("document.querySelector('#pref-weeklySummary')");
    await click('#pref-weeklySummary');
    await click('#option-menu .option-item[data-value="false"]');
    await until("document.querySelector('#pref-weeklySummary').getAttribute('aria-label').includes('不提醒')");
    const prefsFile = path.join(process.env.TOKENPULSE_DATA_DIR, 'prefs.json');
    await untilMain(() => fs.existsSync(prefsFile) && JSON.parse(fs.readFileSync(prefsFile, 'utf8')).weeklySummary === false);
    assert.equal(JSON.parse(fs.readFileSync(prefsFile, 'utf8')).weeklySummary, false);
    console.log('PASS share UI: notification deep link opens the selected week; weekly summary preference saves false');

    await e("localStorage.removeItem('tokenpulse-share-milestones'); localStorage.removeItem('tokenpulse-share-month-seen'); window.shareClock=Date.now; window.shareOffset=120000; Date.now=()=>shareClock()+shareOffset; true;");
    await e("PulseShare.check({scannedAt:1,now:new Date(2026,9,1,12).getTime()})");
    assert.equal(await e("[...document.querySelectorAll('.tp-toast-message')].filter(n=>n.textContent.includes('新里程碑')).length"), 0);
    assert.ok(await e("[...document.querySelectorAll('.tp-toast-message')].some(n=>n.textContent.includes('月报出炉'))"));
    milestones = { ...milestones, list: milestones.list.map(item => item.id === 'streak-7' ? { ...item, achievedAt: '2026-10-01' } : item) };
    await e("shareOffset+=120000; PulseShare.check({scannedAt:2,now:new Date(2026,9,1,12).getTime()})");
    assert.equal(await e("[...document.querySelectorAll('.tp-toast-message')].filter(n=>n.textContent.includes('新里程碑')).length"), 1);
    await e("shareOffset+=120000; PulseShare.check({scannedAt:3,now:new Date(2026,9,1,12).getTime()})");
    assert.equal(await e("[...document.querySelectorAll('.tp-toast-message')].filter(n=>n.textContent.includes('新里程碑')).length"), 1);
    await e('Date.now=shareClock; true');
    console.log('PASS share UI: first milestone check is quiet, monthly prompt and newly unlocked badge deduplicate');

    const loaded = new Promise(resolve => wc.once('did-finish-load', resolve)); await e("PulseI18n.setMode('en')"); await loaded;
    await until("document.querySelector('#share-open').textContent.includes('Share cards')");
    await click('#share-open'); await ready();
    assert.ok(!/[一-鿿]/.test(await e("document.querySelector('#share-dialog').textContent")));
    const win = BrowserWindow.fromWebContents(wc); win.setSize(900, 700); await pause(200);
    assert.ok(await e("(() => {const r=document.querySelector('#share-dialog').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()"));
    assert.ok(await e("(() => {const r=document.querySelector('#share-dialog').getBoundingClientRect();return [...document.querySelectorAll('#share-dialog footer button')].filter(b=>!b.hidden).every(b=>b.getBoundingClientRect().bottom<=r.bottom)})()"), 'export buttons are fully visible');
    await shot('share-dialog-en-narrow');
    console.log('PASS share UI: English dialog and narrow layout');
    clearTimeout(watchdog); app.exit(0);
  } catch (error) { clearTimeout(watchdog); console.error('FAIL', error); app.exit(1); }
}));
require('../build/main/index.js');
