/*
 * 额度预测的「压力」显示（0.3.59）：按最近趋势只差一点点就用完的窗口不再把进度条变黄。
 * 一次性 HOME / 数据目录，两个假的 Claude 账号，采样全是编的，不联网：
 *   - qa-mild：已用 60%，每小时 0.6 点，重置前只断档约 5 小时（7%）→ pressure = watch：绿条、文字说明「距重置只差」、徽标「用量偏高」
 *   - qa-heavy：已用 50%，每小时 1 点，重置前断档约 22 小时（30%）→ pressure = high：黄条、警示文字、徽标「重置前压力较高」
 * TOKENPULSE_SHOT_DIR / TP_SHOTS 设了的话截图（只有测试数据）。
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { app } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-quota-pressure-ui-'));
const home = path.join(root, 'home'), data = path.join(root, 'data');
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = home;
process.env.TOKENPULSE_DATA_DIR = data;
process.env.AGENT_SWITCH_CC_DB = path.join(root, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) delete process.env[key];
app.setPath('userData', path.join(root, 'electron')); app.commandLine.appendSwitch('lang', 'zh-CN');
const appRoot = process.env.TOKENPULSE_TEST_APP || path.resolve(__dirname, '..');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
write(path.join(data, 'prefs.json'), { seenVersion: require(path.join(appRoot, 'package.json')).version, onboarding: 'done', ccSwitch: false });
require(path.join(appRoot, 'build/core/quota.js')).fetchOfficialQuota = async () => ({});
const shots = process.env.TP_SHOTS || process.env.TOKENPULSE_SHOT_DIR;

const NOW = Date.now(), H = 3600000;
const iso = ms => new Date(ms).toISOString();
const RESET = iso(NOW + 72 * H);
const account = ref => ({ id: `claude:${ref}`, kind: 'claude', ref, email: `${ref}@example.com`, label: ref, createdAt: NOW, lastSeenAt: NOW, credential: { token: 'fake-oauth-' + ref, expiresAt: NOW + H } });
write(path.join(data, 'official-accounts.json'), { version: 2, active: {}, accounts: [account('qa-mild'), account('qa-heavy')] });
// 窗口 4 天前开始、3 天后重置；最近 10 小时每小时一个采样
const series = (ref, from, to) => Array.from({ length: 11 }, (_, i) => ({ at: NOW - (10 - i) * H, week: from + ((to - from) * i) / 10, weekReset: RESET, weekStart: iso(NOW + 72 * H - 7 * 24 * H), account: `claude:${ref}` }));
write(path.join(data, 'quota-history.json'), { version: 1, accounts: { claude: [...series('qa-mild', 54, 60), ...series('qa-heavy', 40, 50)].sort((a, b) => a.at - b.at) } });
write(path.join(data, 'quota-checked.json'), { accounts: { 'claude:qa-mild': NOW - 30000, 'claude:qa-heavy': NOW - 30000 } });
const watchdog = setTimeout(() => { console.error('FAIL quota pressure UI timed out'); app.exit(1); }, 120000);

app.on('web-contents-created', (_, contents) => contents.once('did-finish-load', async () => {
  const evaluate = code => contents.executeJavaScript(code).catch(e => { throw new Error(e.message + ' ← ' + String(code).slice(0, 160)); }), delay = ms => new Promise(r => setTimeout(r, ms));
  const until = async (code, ms = 15000) => { const end = Date.now() + ms; while (!await evaluate('Promise.resolve(' + code + ').then(v=>!!v)')) { assert.ok(Date.now() < end, 'Timed out: ' + code); await delay(80); } };
  const text = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
  const shot = async name => { if (!shots) return; await delay(400); fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, 'quota-pressure-' + name + '.png'), (await contents.capturePage()).toPNG()); };
  const TAB = ref => `#account-tabs button[data-account="claude:${ref}"]`, DETAIL = '#quota-detail';
  const open = async ref => { await evaluate(`document.querySelector('${TAB(ref)}').click()`); await until(`document.querySelector('${DETAIL} .window-panel .track-fill')`); await delay(200); };
  const fillClass = () => evaluate(`document.querySelector('${DETAIL} .window-panel .track-fill').className`);
  try {
    if (!await evaluate("Boolean(document.querySelector('#tiles'))")) return;
    await evaluate("navigate('quota')");
    await until(`document.querySelector('${TAB('qa-mild')}') && document.querySelector('${TAB('qa-heavy')}')`);

    await open('qa-mild');
    assert.equal(await fillClass(), 'track-fill', '只差一点点就用完：进度条保持默认色');
    const mildLine = await text(`${DETAIL} .prediction-line`);
    assert.match(mildLine, /后达到上限，距重置只差 .+，稍微放慢即可/, mildLine);
    assert.equal(await evaluate(`document.querySelector('${DETAIL} .prediction-line').classList.contains('caution')`), false);
    assert.equal(await evaluate(`[...document.querySelectorAll('${DETAIL} .metric')].find(m => m.textContent.includes('预计达到上限')).classList.contains('warn')`), false);
    // 「重置时预计使用」超过 100% 但只是 watch：不用警示底色
    assert.equal(await evaluate(`[...document.querySelectorAll('${DETAIL} .metric')].find(m => m.textContent.includes('重置时预计使用')).classList.contains('warn')`), false);
    await shot('watch');
    pass('slightly running out before reset keeps the bar green and explains the small gap in text');

    await open('qa-heavy');
    assert.equal(await fillClass(), 'track-fill warning', '重置前断档三成：进度条变黄');
    const heavyLine = await text(`${DETAIL} .prediction-line`);
    assert.match(heavyLine, /按最近趋势，预计约 .+ 后达到上限$/, heavyLine);
    assert.equal(await evaluate(`document.querySelector('${DETAIL} .prediction-line').classList.contains('caution')`), true);
    await shot('high');
    pass('running out well before reset still turns the bar amber with the warning text');

    // 首页卡片：同一家只有一张卡，主角是顺位第一的 qa-mild；徽标和小进度条也按同一规则
    await evaluate("navigate('overview')");
    await until("document.querySelector('.quota-card.claude .track-fill')");
    const card = await evaluate("(c => ({ who: c.querySelector('.plan.who')?.textContent.trim(), badge: c.querySelector('.badge').textContent.trim(), fill: c.querySelector('.track-fill').className, warnText: Boolean(c.querySelector('.warn-text')), foot: c.querySelector('.quota-card-foot span').textContent.trim() }))(document.querySelector('.quota-card.claude'))");
    assert.ok(card.who.includes('qa-mild'), JSON.stringify(card));
    assert.deepEqual({ badge: card.badge, fill: card.fill, warnText: card.warnText }, { badge: '用量偏高', fill: 'track-fill', warnText: false }, JSON.stringify(card));
    assert.match(card.foot, /后达到上限/);
    await shot('overview');
    pass('the overview card follows the same rule for badge, bar colour and used-percent text');

    // 设置里把周额度改成「不变色」：快照按新口径重算，qa-heavy 也不再变黄；改回「严格」则 qa-mild 也变黄
    await evaluate("openSettings('alerts')");
    await until("document.querySelector('#pref-pressureWeek')");
    assert.equal(await evaluate("document.querySelector('#pref-pressureWeek').textContent.includes('标准')"), true, '周额度默认标准');
    assert.equal(await evaluate("document.querySelector('#pref-pressureFive').textContent.includes('宽松')"), true, '5 小时默认宽松');
    await shot('settings');
    await evaluate("api.writePrefs({ pressureWeek: 'off' })");
    await evaluate("closeModal('settings')");
    await evaluate("navigate('quota')");
    await until(`document.querySelector('${TAB('qa-heavy')}')`);
    await open('qa-heavy');
    await until(`document.querySelector('${DETAIL} .window-panel .track-fill').className === 'track-fill'`, 20000);
    assert.match(await text(`${DETAIL} .prediction-line`), /距重置只差/);
    pass('setting the weekly rule to "no colour change" recomputes the snapshot and clears the amber bar');
    await evaluate("api.writePrefs({ pressureWeek: 'strict' })");
    await open('qa-mild');
    await until(`document.querySelector('${DETAIL} .window-panel .track-fill').className === 'track-fill warning'`, 20000);
    pass('"strict" restores the previous always-warn behaviour');
    await evaluate("api.writePrefs({ pressureWeek: 'default' })");
    await open('qa-mild');
    await until(`document.querySelector('${DETAIL} .window-panel .track-fill').className === 'track-fill'`, 20000);

    const reloaded = new Promise(resolve => contents.once('did-finish-load', resolve));
    await evaluate("PulseI18n.setMode('en')"); await reloaded;
    await evaluate("navigate('quota')");
    await until(`document.querySelector('${TAB('qa-mild')}')`);
    await open('qa-mild');
    const english = await text(`${DETAIL} .prediction-line`);
    assert.ok(!/[一-鿿]/.test(english), 'untranslated prediction: ' + english);
    assert.match(english, /only .+ before the reset/);
    pass('the gentler forecast sentence is translated');

    console.log('quota pressure UI checks passed');
    clearTimeout(watchdog); app.exit(0);
  } catch (e) { console.error('FAIL', e.message); clearTimeout(watchdog); app.exit(1); }
}));
function pass(name) { console.log('PASS ' + name); }
app.on('will-quit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 进程还占着就留给系统清 */ } });
require(path.join(appRoot, 'build/main/index.js'));
