/*
 * tokens.ci 自动上传（0.3.38，src/core/tokens-ci.ts、src/main/tokens-ci.ts）。
 * 用 scripts/fixtures/fake-tokens-cli.cjs 模拟官方工具，临时目录放凭据，不联网、不碰真实的 %APPDATA%\tokens。
 * 覆盖：设置规整（间隔 10 分钟到一天）、命令怎么拼、输出怎么读（登录码、令牌遮挡、登录失效）、
 * 没登录时上传失败并暂停、登录（含隐私模式只读令牌只在内存里）、手动 / 定时 / 启动时上传、失败不连着重试、取消、预览。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-tokens-ci-'));
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.TOKENS_CONFIG_DIR = path.join(root, 'tokens');
process.env.TOKENPULSE_TOKENS_CLI = path.join(__dirname, 'fixtures', 'fake-tokens-cli.cjs');
for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
const core = require('../build/core/tokens-ci');
const { TokensUploader } = require('../build/main/tokens-ci');

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const calls = () => { try { return fs.readFileSync(path.join(process.env.TOKENS_CONFIG_DIR, 'calls.log'), 'utf8').trim().split('\n'); } catch { return []; } };
const until = async (check, ms = 10000) => { const end = Date.now() + ms; while (!check()) { assert.ok(Date.now() < end, 'Timed out'); await new Promise(r => setTimeout(r, 30)); } };

(async () => {
  let uploader;
  try {
    /* ---------- 设置和命令 ---------- */
    const d = core.defaultSettings();
    assert.deepEqual([d.enabled, d.intervalMin, d.onLaunch, d.channel], [false, 60, true, 'pinned'], '默认：没开，1 小时，启动时上传，固定版本');
    assert.equal(core.normalizeSettings({ intervalMin: 3 }).intervalMin, 10, '最少 10 分钟');
    assert.equal(core.normalizeSettings({ intervalMin: 5000 }).intervalMin, 1440, '最多一天');
    assert.equal(core.normalizeSettings({ intervalMin: 'x' }).intervalMin, 60);
    assert.equal(core.normalizeSettings({ channel: 'evil', version: '1.0; rm -rf /' }).channel, 'pinned');
    assert.equal(core.normalizeSettings({ version: '1.0; rm -rf /' }).version, '', '版本号只认 x.y.z');
    const env = { ...process.env, TOKENPULSE_TOKENS_CLI: '' };
    assert.equal(core.commandLine({ channel: 'pinned', version: '27.1.3' }, ['submit'], env), 'npx --yes tokens-cli@27.1.3 submit');
    assert.equal(core.commandLine({ channel: 'pinned', version: '' }, ['submit', '--dry-run'], env), 'npx --yes tokens-cli@latest submit --dry-run');
    assert.equal(core.commandLine({ channel: 'latest', version: '27.1.3' }, ['login'], env), 'npx --yes tokens-cli@latest login');
    assert.equal(core.commandLine({ channel: 'installed', version: '' }, ['login', '--private'], env), 'tokens login --private');
    assert.throws(() => core.commandLine({ channel: 'installed' }, ['submit && calc'], env), /不支持/);
    pass('settings are clamped (10 minutes to a day), commands are built from fixed words and a checked version only');

    /* ---------- 读输出 ---------- */
    const out = '\x1b[36mTokens\x1b[0m\n  Opening \x1b]8;;https://tokens.ci/device\x07https://tokens.ci/device\x1b]8;;\x07\n  Enter this code:\n  \x1b[1mABCD-1234\x1b[0m\n  Logged in as octo\n  Read token: tkr_abcDEF123456';
    assert.deepEqual(core.readLogin(out), { url: 'https://tokens.ci/device', code: 'ABCD-1234', readToken: 'tkr_abcDEF123456', username: 'octo' });
    assert.equal(core.redact('token tkr_abcDEF123456 and tk_secret_value_1'), 'token tkr_… and tk_s…');
    assert.equal(core.authProblem('\x1b[33mNot logged in.\x1b[0m'), true);
    assert.equal(core.authProblem('Error: 401 Unauthorized'), true);
    assert.equal(core.authProblem('Server error: 500'), false);
    assert.equal(core.summaryOf('a\n\x1b[32mSubmitted 2 days.\x1b[0m\n────\n'), 'Submitted 2 days.');
    pass('output: login URL / code / read token / username read, tokens masked, auth failures recognised');

    /* ---------- 主进程的调度 ---------- */
    let now = Date.UTC(2026, 9, 8, 1, 0);
    const states = [];
    uploader = new TokensUploader({ now: () => now, publish: s => states.push(s), launchDelayMs: 10, tickMs: 60_000 });
    let state = await uploader.check();
    assert.deepEqual([state.tools.checked, state.tools.npx, state.tools.latest, state.settings.version], [true, true, '27.1.3', '27.1.3'], '第一次检查：固定成查到的版本');
    assert.equal(state.loggedIn, false);

    // 没登录：手动上传失败，原因是登录失效，自动上传暂停
    state = await uploader.save({ enabled: true, intervalMin: 30 });
    state = await uploader.upload('manual');
    assert.equal(state.last.ok, false);
    assert.equal(state.last.error, 'tokens.ci 登录已失效，请重新登录');
    assert.equal(state.paused, true);
    assert.equal(state.nextAt, null, '暂停时不排下一次');

    // 登录：隐私模式；过程中界面能拿到登录码，结束后只读令牌只在内存里交给界面
    assert.rejects(() => uploader.login(undefined), /先选/);
    const login = uploader.login('private');
    await until(() => states.some(s => s.login?.code === 'WXYZ-2468'));
    assert.equal(states.find(s => s.login?.code).running, 'login');
    assert.equal(states.find(s => s.login?.code).login.url, 'https://tokens.ci/device');
    state = await login;
    assert.deepEqual([state.login.done, state.login.ok, state.login.readToken, state.settings.username, state.loggedIn, state.paused], [true, true, 'tkr_fakeReadToken_abcdef123456', 'tester', true, false]);
    assert.ok(calls().includes('login --private'));
    const saved = fs.readFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'tokens-ci.json'), 'utf8');
    assert.equal(/tkr_|tk_fake/.test(saved), false, '令牌不写进 TokenPulse 的文件');
    assert.equal(uploader.clearLogin().login, null, '界面看过就从内存里清掉');
    pass('not logged in: upload fails and pauses; login (private) shows the code while waiting, keeps the read token in memory only');

    // 手动上传成功；没到点不传，到点由定时器传；上一次之后隔够间隔
    state = await uploader.upload('manual');
    assert.deepEqual([state.last.ok, state.last.trigger, state.last.summary, state.failures], [true, 'manual', 'Submitted 2 days of usage (1.69M tokens).', 0]);
    assert.equal(state.nextAt, now + 30 * 60_000);
    const submitted = () => calls().filter(line => line === 'SUBMITTED').length;
    assert.equal(submitted(), 1);
    now += 29 * 60_000; uploader.tick(); await new Promise(r => setTimeout(r, 300));
    assert.equal(submitted(), 1, '没到点不传');
    now += 60_000; uploader.tick(); await until(() => submitted() === 2);
    await until(() => uploader.state().running === null);
    assert.equal(uploader.state().last.trigger, 'schedule');

    // 服务器出错：记一次失败，不连着重试，等下一个间隔
    fs.writeFileSync(path.join(process.env.TOKENS_CONFIG_DIR, 'fail'), '');
    now += 30 * 60_000;
    state = await uploader.upload('schedule');
    assert.deepEqual([state.last.ok, state.failures, state.paused], [false, 1, false]);
    assert.match(state.last.error, /Server error: 500/);
    uploader.tick(); await new Promise(r => setTimeout(r, 300));
    assert.equal(uploader.state().failures, 1, '失败后不马上重试');
    fs.rmSync(path.join(process.env.TOKENS_CONFIG_DIR, 'fail'));
    // 令牌被撤销：暂停，等重新登录
    fs.writeFileSync(path.join(process.env.TOKENS_CONFIG_DIR, 'revoked'), '');
    now += 30 * 60_000;
    state = await uploader.upload('schedule');
    assert.deepEqual([state.paused, state.failures, state.last.error], [true, 2, 'tokens.ci 登录已失效，请重新登录']);
    state = await uploader.upload('schedule');
    assert.equal(state.failures, 2, '暂停时定时上传不跑');
    fs.rmSync(path.join(process.env.TOKENS_CONFIG_DIR, 'revoked'));
    state = uploader.resume();
    assert.equal(state.paused, false);
    pass('manual and scheduled uploads, interval counted from the last attempt, failures not retried at once, revoked login pauses until resumed');

    // 预览：不上传
    const before = submitted();
    state = await uploader.dryRun();
    assert.equal(state.preview.ok, true);
    assert.match(state.preview.output, /claude-opus-5-5[\s\S]*Dry run: nothing was submitted\./);
    assert.equal(submitted(), before);
    pass('preview runs --dry-run and shows its output without uploading');

    // 取消登录
    process.env.FAKE_TOKENS_LOGIN_MS = '20000';
    const slow = uploader.login('public');
    await until(() => uploader.state().running === 'login' && uploader.state().login?.code);
    uploader.cancelJob();
    state = await slow;
    assert.deepEqual([state.login.done, state.login.ok, state.login.error], [true, false, '已取消登录']);
    assert.equal(state.running, null);
    delete process.env.FAKE_TOKENS_LOGIN_MS;
    pass('a login waiting for the browser can be cancelled, and its process is ended');

    // 重新启动：设置和上次结果还在；打开了「启动时上传」就先传一次
    uploader.stop();
    const reopened = new TokensUploader({ now: () => now, launchDelayMs: 10, tickMs: 60_000 });
    assert.deepEqual([reopened.state().settings.enabled, reopened.state().settings.intervalMin, reopened.state().last.trigger], [true, 30, 'schedule']);
    const count = submitted();
    reopened.start();
    await until(() => submitted() === count + 1);
    await until(() => reopened.state().running === null);
    assert.equal(reopened.state().last.trigger, 'launch');
    reopened.stop();
    // 关掉「启动时上传」就不传
    const quiet = new TokensUploader({ now: () => now, launchDelayMs: 10, tickMs: 60_000 });
    quiet.save({ onLaunch: false });
    quiet.start(); await new Promise(r => setTimeout(r, 500));
    assert.equal(submitted(), count + 1);
    quiet.stop();
    pass('settings and the last result survive a restart; upload on launch is optional');

    console.log(`${checks}/${checks} tokens.ci checks passed`);
  } catch (error) {
    console.error('FAIL', error);
    process.exitCode = 1;
  } finally {
    uploader?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
