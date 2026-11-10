/*
 * 按型号的周额度（Claude Max 的 Fable）在界面上的样子：首页 Claude 卡片多一行「Fable 周额度」，
 * 额度页的「周额度窗口」里有「按型号的周额度」，上面一排还是两张窗口卡片；英文界面整段翻完；没有这项的账号不显示。
 * 跑法：npx electron --lang=zh-CN scripts/test-model-weeks-ui.cjs（先 npm run compile）。全是演示数据，不碰真实账号。
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-model-weeks-ui-'));
Object.assign(process.env, { TOKENPULSE_DATA_DIR: path.join(root, 'data'), AGENT_SWITCH_HOME: path.join(root, 'home'), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), PI_CODING_AGENT_DIR: path.join(root, 'pi'), TOKENPULSE_DSH_HOME: path.join(root, 'dsh'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), GROK_HOME: path.join(root, 'grok'), AGENT_SWITCH_CC_DB: path.join(root, 'missing.db') });
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
write(path.join(root, 'data', 'prefs.json'), JSON.stringify({ autoLaunch: false, autoUpdate: false, closeToTray: true, startMinimized: true, language: 'zh', notifyAt: 0, notifyMismatch: false, ccSwitch: false, seenVersion: require('../package.json').version, onboarding: 'done' }));
const now = Date.now(), hour = 3600000, iso = at => new Date(at).toISOString();
const fable = pct => [{ model: 'Fable', pct, reset: iso(now + 100 * hour) }];
write(path.join(root, 'data', 'quota-history.json'), JSON.stringify({ version: 1, accounts: {
  claude: [0, 1, 2].map(i => ({ at: now - (2 - i) * hour, five: 10 + i, fiveReset: iso(now + 3 * hour), week: 2 + i, weekReset: iso(now + 100 * hour), models: fable(20 + 5 * i) })),
  // ChatGPT 没有按型号的周额度：卡片上不能多出一行
  chatgpt: [0, 1].map(i => ({ at: now - (1 - i) * hour, five: 20, fiveReset: iso(now + 3 * hour), week: 40 + i, weekReset: iso(now + 72 * hour), plan: 'plus' })),
} }));
app.setPath('userData', path.join(root, 'electron')); app.commandLine.appendSwitch('lang', 'zh-CN'); process.argv.push('--hidden');
require('../build/core/quota.js').fetchOfficialQuota = async () => ({});
const watchdog = setTimeout(() => { console.error('FAIL model weeks UI timed out'); app.exit(1); }, 60000);
app.on('web-contents-created', (_event, wc) => wc.once('did-finish-load', async () => {
  const e = code => wc.executeJavaScript(code).catch(error => { console.error('UI expression:', code); throw error; });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async code => { const end = Date.now() + 12000; while (!await e(`Promise.resolve(${code}).then(v => !!v)`)) { assert.ok(Date.now() < end, code); await pause(50); } };
  const shot = async name => { if (!process.env.TP_SHOTS) return; const dir = process.env.TP_SHOTS; fs.mkdirSync(dir, { recursive: true }); const win = BrowserWindow.fromWebContents(wc); if (!win.isVisible()) { win.setSize(1440, 900); win.showInactive(); } await pause(900); fs.writeFileSync(path.join(dir, name + '.png'), (await wc.capturePage()).toPNG()); };
  const cardText = "document.querySelector('#quota-cards .model-week[data-model=Fable]')?.textContent || ''";
  const panelText = "document.querySelector('#quota-detail .model-weeks')?.textContent || ''";
  try {
    await until("typeof navigate === 'function' && document.querySelector('#quota-cards .model-week')");
    assert.match(await e(cardText), /Fable 周额度[\s\S]*已用 30\.0%[\s\S]*后重置/);
    assert.equal(await e("document.querySelectorAll('#quota-cards .model-week').length"), 1, 'ChatGPT 卡片没有这一行');
    await shot('model-weeks-overview');
    console.log('PASS model weeks UI: the Claude card shows the Fable weekly limit, other cards do not');

    await e("state.account = (current.accounts.find(a => a.kind === 'claude') || {}).key || 'claude'; navigate('quota')");
    await until("document.querySelector('#quota-detail .model-weeks')");
    assert.match(await e(panelText), /按型号的周额度[\s\S]*Fable 周额度[\s\S]*剩余 70\.0%[\s\S]*已用 30\.0%/);
    assert.equal(await e("document.querySelectorAll('#quota-detail .quota-window-grid .panel').length"), 2, '窗口卡片还是两张');
    assert.ok(await e("!!document.querySelector('#quota-detail .quota-window-grid .panel:nth-child(2) .model-weeks') && !document.querySelector('#quota-detail .quota-window-grid .panel:nth-child(1) .model-weeks')"), '只在周额度窗口里');
    // Fable 也有预测和 Token 指标，和总窗口同一套：本窗口已用、剩余可用、整窗容量折算、预计达到上限
    const detail = await e("(() => { const d = document.querySelector('#quota-detail .model-week-row[data-model=Fable] .model-week-detail'); return d ? { line: d.querySelector('.prediction-line')?.textContent || '', labels: [...d.querySelectorAll('.metric-label')].map(n => n.textContent) } : null; })()");
    assert.ok(detail, 'Fable 那一行有详细指标');
    assert.match(detail.line, /按最近趋势|采样跨度还不够|近期没有新增用量/);
    assert.deepEqual(detail.labels, ['本窗口已用（本机）', '剩余可用（估算）', '整窗容量折算', '预计达到上限']);
    await e("document.querySelector('#quota-detail .model-weeks').scrollIntoView({ block: 'center' })");
    await shot('model-weeks-quota');
    console.log('PASS model weeks UI: the weekly window panel lists weekly limits by model');

    await e("localStorage.setItem('tokenpulse-lang', 'en'); location.reload()");
    await until("document.documentElement.lang.startsWith('en') && typeof navigate === 'function' && document.querySelector('#quota-cards .model-week')");
    await pause(300);
    const en = await e(cardText);
    assert.match(en, /Fable Weekly[\s\S]*Used 30\.0%/);
    assert.ok(!/[一-鿿]/.test(en), en);
    await e("state.account = (current.accounts.find(a => a.kind === 'claude') || {}).key || 'claude'; navigate('quota')");
    await until("document.querySelector('#quota-detail .model-weeks')");
    await pause(300);
    const enPanel = await e(panelText);
    assert.match(enPanel, /Weekly limits by model[\s\S]*Fable Weekly[\s\S]*70\.0% remaining/);
    assert.ok(!/[一-鿿]/.test(enPanel), enPanel);
    console.log('PASS model weeks UI: English labels are fully translated');
    clearTimeout(watchdog); app.exit(0);
  } catch (error) { console.error('FAIL model weeks UI', error); clearTimeout(watchdog); app.exit(1); }
}));
app.on('will-quit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
require('../build/main/index.js');
