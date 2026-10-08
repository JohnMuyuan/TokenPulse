/*
 * tokens.ci 自动上传的界面（0.3.38，renderer/tokens-ci.js）。
 * 用 scripts/fixtures/fake-tokens-cli.cjs 模拟官方工具，凭据放临时目录，不联网、不开浏览器、不碰真实的 ~/.tokenpulse 和 %APPDATA%\tokens。
 * 走一遍新用户：介绍卡 → 检查环境 → 选公开 / 隐私（不预先选中）→ 登录（显示登录码，隐私模式的只读令牌）→ 预览 → 间隔（最少 10 分钟）→ 开启并上传；
 * 状态栏、登录失效后的「重新登录」、设置里隐藏和从「设置 → 数据」重新打开。
 * TOKENPULSE_SHOT_DIR 设了的话顺便截几张图（只有测试数据）。
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { app } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-tokens-ui-'));
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.TOKENS_CONFIG_DIR = path.join(root, 'tokens');
process.env.TOKENPULSE_TOKENS_CLI = path.join(__dirname, 'fixtures', 'fake-tokens-cli.cjs');
process.env.FAKE_TOKENS_LOGIN_MS = '800';
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) delete process.env[key];
app.setPath('userData', path.join(root, 'electron')); app.commandLine.appendSwitch('lang', 'zh-CN');
const appRoot = process.env.TOKENPULSE_TEST_APP || path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'data'), { recursive: true }); fs.mkdirSync(path.join(root, 'home'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'prefs.json'), JSON.stringify({ seenVersion: require(path.join(appRoot, 'package.json')).version, onboarding: 'done' }));
require(path.join(appRoot, 'build/core/quota.js')).fetchOfficialQuota = async () => ({});
const shots = process.env.TOKENPULSE_SHOT_DIR;
const submitted = () => { try { return fs.readFileSync(path.join(root, 'tokens', 'calls.log'), 'utf8').split('\n').filter(l => l === 'SUBMITTED').length; } catch { return 0; } };
const watchdog = setTimeout(() => { console.error('FAIL tokens.ci UI timed out'); app.exit(1); }, 60000);

app.on('web-contents-created', (_, contents) => contents.once('did-finish-load', async () => {
  const evaluate = code => contents.executeJavaScript(code).catch(e => { throw new Error(e.message + ' ← ' + String(code).slice(0, 160)); }), delay = ms => new Promise(r => setTimeout(r, ms));
  const until = async (code, ms = 15000) => { const end = Date.now() + ms; while (!await evaluate('Promise.resolve(' + code + ').then(v=>!!v)')) { assert.ok(Date.now() < end, 'Timed out: ' + code); await delay(50); } };
  const click = action => evaluate(`document.querySelector('[data-action="${action}"]').click()`);
  const text = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim() ?? null`);
  const shot = async name => { if (!shots) return; await evaluate("document.getElementById('tokens-ci-dialog') || document.getElementById('tokens-ci').scrollIntoView({ block: 'center' })"); await delay(250); fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, name + '.png'), (await contents.capturePage()).toPNG()); };
  try {
    await until("document.querySelector('#tiles')");
    await evaluate("navigate('usage')");
    // 介绍卡：没设置过才有
    await until("!document.getElementById('tokens-ci').hidden && document.querySelector('.tokens-ci-intro')");
    assert.match(await text('#tokens-ci'), /把用量自动上传到 tokens\.ci.*只有 Token 数、型号和时间，不含对话内容.*开始设置.*不需要/);
    await shot('1-intro');

    // 第一步：运行环境
    await click('tokens-setup');
    await until("document.querySelector('#tokens-ci-dialog .tokens-ci-steps li.on')?.textContent.includes('运行环境')");
    assert.ok(await evaluate("document.querySelector('.workspace').inert"), '向导打开时背景不可操作');
    await until("/将使用 tokens-cli 27\\.1\\.3（固定版本/.test(document.querySelector('.tokens-ci-checks').textContent)");
    await shot('2-env');
    await click('tokens-next');

    // 第二步：账号。没登录：公开 / 隐私都不预先选中，选了才能点登录
    await until("document.querySelector('[name=tokens-privacy]')");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[name=tokens-privacy]')].map(i => i.checked)"), [false, false], '不预先选中');
    assert.equal(await evaluate("document.querySelector('[data-action=tokens-login]').disabled"), true);
    await shot('3-privacy');
    await evaluate("document.querySelector('[name=tokens-privacy][value=private]').click()");
    await until("!document.querySelector('[data-action=tokens-login]').disabled");
    await click('tokens-login');
    await until("document.querySelector('.tokens-ci-code code')?.textContent === 'WXYZ-2468'");
    assert.ok(await evaluate("!!document.querySelector('[data-action=tokens-open-auth]') && !!document.querySelector('[data-action=tokens-cancel-login]')"));
    await shot('4-code');
    await until("/已登录 tokens\\.ci · @tester/.test(document.querySelector('.tokens-ci-step').textContent)");
    assert.equal(await text('.tokens-ci-token code'), 'tkr_fakeReadToken_abcdef123456', '隐私模式：只读令牌显示一次');
    await shot('5-token');
    await click('tokens-next');
    assert.equal(await evaluate("window.PulseTokensCi.state().login"), null, '离开这一步就从内存里清掉令牌');

    // 第三步：预览（不上传）
    await until("document.querySelector('[data-action=tokens-run-preview]')");
    await click('tokens-run-preview');
    await until("/Dry run: nothing was submitted/.test(document.querySelector('.tokens-ci-output')?.textContent || '')");
    assert.equal(submitted(), 0);
    await shot('6-preview');
    await click('tokens-next');

    // 第四步：间隔最少 10 分钟、最多一天，默认 1 小时；启动时上传默认勾上
    await until("document.querySelector('[name=tokens-interval]')");
    assert.deepEqual(await evaluate("[document.querySelector('[name=tokens-interval]').value, document.querySelector('[name=tokens-unit]').value, document.querySelector('[name=tokens-launch]').checked]"), ['1', 'hour', true]);
    const setInterval = (amount, unit) => evaluate(`(() => { const u = document.querySelector('[name=tokens-unit]'); u.value = '${unit}'; const a = document.querySelector('[name=tokens-interval]'); a.value = '${amount}'; a.dispatchEvent(new Event('change')); })()`);
    await setInterval(5, 'min');
    await until("/现在是每 10 分钟/.test(document.querySelector('.tokens-ci-field small').textContent)");
    await setInterval(30, 'hour');
    await until("/现在是每天/.test(document.querySelector('.tokens-ci-field small').textContent)");
    await setInterval(2, 'hour');
    await until("/现在是每 2 小时/.test(document.querySelector('.tokens-ci-field small').textContent)");
    await shot('7-schedule');
    await click('tokens-finish');
    await until("!document.getElementById('tokens-ci-dialog')");
    await until("/上次 .+ 已上传/.test(document.querySelector('#tokens-ci .tokens-ci-status')?.textContent || '')");
    assert.equal(submitted(), 1);
    assert.match(await text('#tokens-ci .tokens-ci-status'), /每 2 小时 · 下次 /);
    assert.match(await text('#tokens-ci'), /@tester/);
    await until("[...document.querySelectorAll('#toast-stack .tp-toast')].some(t => t.textContent.includes('已上传到 tokens.ci'))");
    const settings = JSON.parse(fs.readFileSync(path.join(root, 'data', 'tokens-ci.json'), 'utf8')).settings;
    assert.deepEqual([settings.enabled, settings.intervalMin, settings.onLaunch, settings.channel, settings.version], [true, 120, true, 'pinned', '27.1.3']);
    await shot('8-strip');
    pass('new user: intro → environment → privacy (none preselected) → login code and read token → preview → interval (10 min to a day) → enabled and uploaded');

    // 设置：版本、账号、最近一次输出
    await click('tokens-settings');
    await until("document.querySelector('[name=tokens-channel][value=pinned]')?.checked");
    assert.match(await text('#tokens-ci-dialog'), /固定版本 27\.1\.3（推荐）.*已登录 tokens\.ci · @tester.*最近一次上传的输出/);
    await shot('9-settings');
    await click('tokens-close');
    await until("!document.getElementById('tokens-ci-dialog')");

    // 登录被撤销：状态栏变成「重新登录」
    fs.writeFileSync(path.join(root, 'tokens', 'revoked'), '');
    await click('tokens-upload');
    await until("document.querySelector('[data-action=tokens-relogin]')");
    assert.match(await text('#tokens-ci .tokens-ci-status'), /登录已失效，自动上传已暂停/);
    await until("[...document.querySelectorAll('#toast-stack .tp-toast.error')].some(t => t.textContent.includes('tokens.ci 上传失败'))");
    fs.rmSync(path.join(root, 'tokens', 'revoked'));
    await shot('10-relogin');
    // 重新登录（公开）：完成后直接关掉，暂停解除
    await click('tokens-relogin');
    await until("document.querySelector('[name=tokens-privacy][value=public]')");
    await evaluate("document.querySelector('[name=tokens-privacy][value=public]').click()");
    await until("!document.querySelector('[data-action=tokens-login]').disabled");
    await click('tokens-login');
    await until("document.querySelector('[data-action=tokens-next]')?.textContent.includes('完成')");
    assert.equal(await evaluate("document.querySelector('.tokens-ci-token')"), null, '公开登录没有只读令牌');
    await click('tokens-next');
    await until("!document.getElementById('tokens-ci-dialog') && document.querySelector('[data-action=tokens-upload]')");
    // 登录好了马上补传一次，状态栏不再挂着「登录已失效」
    await until("/上次 .+ 已上传/.test(document.querySelector('#tokens-ci .tokens-ci-status')?.textContent || '')");
    assert.equal(submitted(), 2);
    pass('revoked login: strip asks to sign in again; signing in (public) clears the pause and uploads right away');

    // 不在用量明细显示；设置 → 数据里还能打开
    await click('tokens-settings');
    await until("document.querySelector('[data-action=tokens-hide]')");
    await click('tokens-hide');
    await until("document.getElementById('tokens-ci').hidden");
    await evaluate("openSettings('data')");
    await until("document.getElementById('open-tokens-ci')?.offsetParent");
    await evaluate("document.getElementById('open-tokens-ci').click()");
    await until("document.getElementById('tokens-ci-dialog') && !document.getElementById('tokens-ci').hidden");
    await click('tokens-close');
    pass('hidden from usage details, reopened from Settings → Data');

    // 深色、窄窗口
    await evaluate("document.documentElement.dataset.theme = 'dark'");
    await shot('11-dark');
    console.log('tokens.ci UI checks passed');
    clearTimeout(watchdog); app.exit(0);
  } catch (e) { console.error('FAIL', e.message); clearTimeout(watchdog); app.exit(1); }
}));
function pass(name) { console.log('PASS ' + name); }
app.on('will-quit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 进程还占着就留给系统清 */ } });
require(path.join(appRoot, 'build/main/index.js'));
