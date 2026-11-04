/**
 * 供应商头像 + 号池界面（0.3.9）。跑法（先 npm run compile）：
 *
 *   npx electron scripts/test-provider-pool-ui.cjs
 *
 * 一次性的 HOME / 数据目录；官方账号是假凭据，不发任何真实请求。只用 DOM、计算样式和尺寸断言，不截图。
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { app, BrowserWindow } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-pool-ui-'));
const home = path.join(root, 'home');
process.env.HOME = process.env.USERPROFILE = process.env.AGENT_SWITCH_HOME = home;
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.AGENT_SWITCH_CC_DB = path.join(root, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const now = Date.now();
write(path.join(home, '.claude', 'settings.json'), { hooks: { keep: true } });
write(path.join(root, 'data', 'prefs.json'), { autoLaunch: false, autoUpdate: false, closeToTray: true, startMinimized: true, language: 'zh', notifyAt: 0, notifyMismatch: false, ccSwitch: false, seenVersion: require('../package.json').version, onboarding: 'done' });
const account = (ref, token) => ({ id: `claude:${ref}`, kind: 'claude', ref, email: `${ref}@example.com`, label: ref, createdAt: now, lastSeenAt: now, credential: { token, expiresAt: now + 3_600_000 } });
write(path.join(root, 'data', 'official-accounts.json'), { version: 2, active: {}, accounts: [account('qa-one', 'secret-oauth-one'), account('qa-two', 'secret-oauth-two')] });
// 号池「获取模型」的假官方接口：按账号的令牌给不同的模型（AGENT_SWITCH_POOL_BASE 只给测试用）
const modelHits = [];
const modelServer = http.createServer((req, res) => {
  modelHits.push({ url: req.url, auth: req.headers.authorization || '', beta: req.headers['anthropic-beta'] || '' });
  const ids = { 'Bearer secret-oauth-one': ['claude-fable-5-1', 'claude-opus-5-5'], 'Bearer secret-oauth-two': ['claude-opus-5-5', 'claude-sonnet-5-5'] }[req.headers.authorization];
  res.writeHead(ids ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(ids ? { data: ids.map(id => ({ type: 'model', id })) } : { error: 'bad' }));
});
const modelServerReady = new Promise(resolve => modelServer.listen(0, '127.0.0.1', () => { process.env.AGENT_SWITCH_POOL_BASE = `http://127.0.0.1:${modelServer.address().port}`; resolve(); }));
app.setPath('userData', path.join(root, 'electron')); app.commandLine.appendSwitch('lang', 'zh-CN'); process.argv.push('--hidden');
const appRoot = process.env.TOKENPULSE_TEST_APP || path.resolve(__dirname, '..');
require(path.join(appRoot, 'build/core/quota.js')).fetchOfficialQuota = async () => ({});
const watchdog = setTimeout(() => { console.error('FAIL provider pool UI timed out'); app.exit(1); }, 60000);
app.on('web-contents-created', (_e, contents) => contents.once('did-finish-load', async () => {
  const ev = code => contents.executeJavaScript(code), delay = ms => new Promise(r => setTimeout(r, ms));
  const until = async code => { const end = Date.now() + 10000; while (!await ev(`Promise.resolve(${code}).then(v => !!v)`)) { assert.ok(Date.now() < end, 'Timed out: ' + code); await delay(40); } };
  const P = '#page-providers';
  const click = (selector, text) => ev(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.includes(${JSON.stringify(text)})).click()`);
  try {
    // 0.3.9 起改工具配置前会弹对比确认；这个测试不是测确认框，自动点「确认写入」（确认框在 test-agent-guard-ui.cjs 里单独测）
    await until("document.readyState === 'complete'"); await ev("setInterval(() => document.querySelector('#pv-confirm .btn-accent')?.click(), 40)");
    const port = await new Promise(resolve => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const v = s.address().port; s.close(() => resolve(v)); }); });
    await until("document.querySelector('[data-page=providers]')");
    await ev(`window.tokenpulse.agentPort(${port})`);
    await ev("navigate('providers')");
    await until(`document.querySelector('${P} .pv-nav [data-section=claude]')`);
    await ev(`document.querySelector('${P} .pv-nav [data-section=claude]').click()`);
    await until(`document.querySelector('${P} .pv-head h2')?.textContent === 'Claude Code'`);
    // 桌面端没有号池入口；Claude Code 有
    assert.ok(await ev(`[...document.querySelectorAll('${P} .pv-head-actions button')].some(b => b.textContent.includes('新建号池'))`));

    // ---------- 头像：自动匹配 → 选预设 → 上传 ----------
    await click(`${P} .pv-head-actions button`, '添加供应商');
    await until(`document.querySelector('${P} .pv-avatar-grid')`);
    assert.equal(await ev(`document.querySelectorAll('${P} .pv-avatar-tile').length`), 27, '自动 + 首字母 + 25 个 AllAi 预设');
    await ev(`(() => { const f = document.querySelector('${P} .pv-editor'); f.elements.name.value = 'DeepSeek 中转'; f.elements.name.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.match(await ev(`document.querySelector('${P} .pv-avatar-now img')?.getAttribute('src') || ''`), /deepseek/, '名称里有 DeepSeek 时自动匹配');
    await ev(`document.querySelector('${P} .pv-avatar-tile[data-icon=kimi]').click()`);
    assert.equal(await ev(`document.querySelector('${P} .pv-avatar-tile[data-icon=kimi]').getAttribute('aria-checked')`), 'true');
    assert.match(await ev(`document.querySelector('${P} .pv-avatar-now img').getAttribute('src')`), /kimi/);
    const uploaded = await ev(`(async () => { const c = document.createElement('canvas'); c.width = 300; c.height = 200; c.getContext('2d').fillRect(0, 0, 300, 200); const blob = await new Promise(r => c.toBlob(r, 'image/png')); return window.PulseAvatars.readImage(new File([blob], 'a.png', { type: 'image/png' })); })()`);
    assert.match(uploaded, /^data:image\/png;base64,/, '上传的图片缩成 PNG');
    assert.ok(uploaded.length < 60000, '缩到 128px，数据量很小');
    await ev(`(async () => { const f = document.querySelector('${P} .pv-editor'); f.elements.baseUrl.value = 'https://api.deepseek.example/v1'; f.elements.apiKey.value = 'sk-avatar'; f.elements.model.value = 'deepseek-chat'; f.requestSubmit(); })()`);
    await until(`!document.querySelector('${P} .pv-editor')`);
    const saved = await ev(`window.tokenpulse.agentState().then(s => s.providers.find(p => p.name === 'DeepSeek 中转'))`);
    assert.equal(saved.icon, 'kimi'); assert.equal(saved.avatar, '');
    assert.match(await ev(`[...document.querySelectorAll('${P} .pv-row')].find(r => r.textContent.includes('DeepSeek 中转')).querySelector('.pv-mark img').getAttribute('src')`), /kimi/, '列表里用选中的预设头像');
    await ev("setThemeMode('dark')"); await delay(150);
    assert.match(await ev(`getComputedStyle([...document.querySelectorAll('${P} .pv-row')].find(r => r.textContent.includes('DeepSeek 中转')).querySelector('.pv-mark img')).filter`), /invert/, '单色线稿在夜间模式反色');
    await ev("setThemeMode('light')"); await delay(150);

    // ---------- 号池：新建 → 选成员 → 调顺序 → 保存 → 启用 ----------
    await click(`${P} .pv-head-actions button`, '新建号池');
    await until(`document.querySelector('${P} .pv-nav [data-section=edit-members]')`);
    assert.equal(await ev(`[...document.querySelectorAll('${P} .pv-nav [data-section^=edit-]')].map(n => n.dataset.section).join()`), 'edit-back,edit-basic,edit-members,edit-preview', '号池只有基本信息 / 成员 / 预览三步');
    await ev(`document.querySelector('${P} .pv-editor').requestSubmit()`);
    assert.equal(await ev(`document.querySelector('${P} .pv-nav-item.on').dataset.section`), 'edit-basic', '没填名称时停在基本信息');
    await ev(`(() => { const f = document.querySelector('${P} .pv-editor'); f.elements.name.value = 'Claude 双号'; })()`);
    await ev(`document.querySelector('${P} .pv-editor').requestSubmit()`);
    assert.equal(await ev(`document.querySelector('${P} .pv-nav-item.on').dataset.section`), 'edit-members', '没选成员时跳到成员');
    await until(`document.querySelectorAll('${P} .pv-pool-accounts .pv-pick').length === 2`);
    await ev(`document.querySelectorAll('${P} .pv-pool-accounts .pv-pick input').forEach(i => i.click())`);
    assert.deepEqual(await ev(`[...document.querySelectorAll('${P} .pv-pool-order li b')].map(n => n.textContent)`), ['qa-one@example.com', 'qa-two@example.com']);
    await ev(`document.querySelectorAll('${P} .pv-pool-order li')[1].querySelector('.pv-icon-btn').click()`);
    assert.deepEqual(await ev(`[...document.querySelectorAll('${P} .pv-pool-order li b')].map(n => n.textContent)`), ['qa-two@example.com', 'qa-one@example.com'], '往前移');
    await ev(`document.querySelector('${P} .pv-pool-editor [data-value=fill-first]').click()`);
    // 获取模型：挨个问成员（还没保存也行），全员都有的排前面，只有一个账号有的标「1/2」；点一下填进模型框
    await modelServerReady;
    await ev(`document.querySelector('${P} [data-section=edit-basic]').click()`);
    await ev(`document.querySelector('${P} [data-action=fetch-pool-models]').click()`);
    await until(`document.querySelectorAll('${P} .pv-pool-models .pv-level').length === 3`);
    assert.deepEqual(await ev(`[...document.querySelectorAll('${P} .pv-pool-models .pv-level')].map(b => [b.dataset.model, b.classList.contains('partial'), b.querySelector('small')?.textContent.trim() || ''])`),
      [['claude-opus-5-5', false, ''], ['claude-sonnet-5-5', true, '1/2'], ['claude-fable-5-1', true, '1/2']], '一样多的按成员顺序：上面把 qa-two 移到了前面');
    assert.deepEqual(modelHits.map(h => h.auth).sort(), ['Bearer secret-oauth-one', 'Bearer secret-oauth-two'], '每个成员用自己的登录问');
    assert.ok(modelHits.every(h => h.url === '/claude/v1/models?limit=1000' && h.beta === 'oauth-2025-04-20'));
    assert.equal(await ev(`document.querySelector('${P} .pv-pool-misses').hidden`), true, '都问到了就没有失败列表');
    await ev(`document.querySelector('${P} .pv-pool-models [data-model="claude-fable-5-1"]').click()`);
    assert.equal(await ev(`document.querySelector('${P} .pv-editor').elements.model.value`), 'claude-fable-5-1');
    assert.equal(await ev("document.body.innerText.includes('secret-oauth') || document.documentElement.outerHTML.includes('secret-oauth')"), false, '获取模型不能把凭据带到界面');
    await ev(`(() => { const i = document.querySelector('${P} .pv-editor').elements.model; i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await ev(`document.querySelector('${P} [data-section=edit-preview]').click()`);
    const preview = await ev(`document.querySelector('${P} .pv-preview-json').textContent`);
    assert.match(preview, /PROXY_MANAGED/); assert.match(preview, /用满再换/); assert.match(preview, /qa-two@example.com/);
    assert.equal(preview.includes('secret-oauth'), false, '预览不能有账号凭据');
    await ev(`document.querySelector('${P} .pv-editor').requestSubmit()`);
    await until(`!document.querySelector('${P} .pv-editor')`);
    const pool = await ev(`window.tokenpulse.agentState().then(s => s.providers.find(p => p.name === 'Claude 双号'))`);
    assert.deepEqual(pool.pool.members.map(m => m.id), ['claude:qa-two', 'claude:qa-one']); assert.equal(pool.pool.strategy, 'fill-first');
    const row = `[...document.querySelectorAll('${P} .pv-row')].find(r => r.textContent.includes('Claude 双号'))`;
    assert.match(await ev(`${row}.textContent`), /号池 · 2 个成员 · 用满再换/);
    assert.equal(await ev(`${row}.querySelector('.pv-mark').classList.contains('pv-pool-mark')`), true, '号池没选头像时用号池图标');
    assert.equal(await ev(`[...${row}.querySelectorAll('.pv-icon-btn')].some(b => b.title === '检测连通' || b.title.includes('备用'))`), false, '号池没有检测连通和备用');
    await ev(`${row}.querySelector('.pv-use').click()`);
    await until(`document.querySelector('${P} .pv-current b')?.textContent === 'Claude 双号'`);
    assert.equal(await ev(`document.querySelectorAll('${P} .pv-current .pv-member').length`), 2, '当前卡片列出成员');
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'PROXY_MANAGED'); assert.equal(settings.hooks.keep, true);
    assert.ok(await ev(`document.querySelector('${P} .pv-nav [data-section=claude] .pv-nav-badge.route')`), '启用号池会自动打开本地路由');
    assert.equal(await ev("document.body.innerText.includes('secret-oauth') || document.documentElement.outerHTML.includes('secret-oauth')"), false, '界面里不能出现账号凭据');
    // 配置预览入口：当前卡片上一键打开编辑页的预览步骤
    await click(`${P} .pv-current-actions button`, '配置预览');
    await until(`document.querySelector('${P} .pv-nav-item.on')?.dataset.section === 'edit-preview'`);
    assert.equal(await ev(`document.querySelector('${P} [data-pane=preview]').hidden`), false);
    await ev(`document.querySelector('${P} [data-section=edit-back]').click()`);
    await until(`!document.querySelector('${P} .pv-editor')`);
    // 普通供应商行上也有配置预览
    await ev(`[...document.querySelectorAll('${P} .pv-row')].find(r => r.textContent.includes('DeepSeek 中转')).querySelector('.pv-icon-btn[title=配置预览]').click()`);
    await until(`document.querySelector('${P} .pv-preview-json')?.textContent.includes('deepseek-chat')`);
    await ev(`document.querySelector('${P} [data-section=edit-back]').click()`);
    await until(`!document.querySelector('${P} .pv-editor')`);
    // 号池里的账号在设置里删掉以后：编辑页标出「已删除，保存时移出」，照样能保存（以前报「找不到的官方账号」，号池就改不了了）
    write(path.join(root, 'data', 'official-accounts.json'), { version: 2, active: {}, accounts: [account('qa-two', 'secret-oauth-two')] });
    await ev('window.PulseProviders.show()');
    await click(`${P} .pv-current-actions button`, '配置预览');
    await until(`document.querySelector('${P} .pv-nav-item.on')?.dataset.section === 'edit-preview'`);
    await ev(`document.querySelector('${P} [data-section=edit-members]').click()`);
    await until(`document.querySelectorAll('${P} .pv-pool-accounts .pv-pick').length === 1`);
    assert.deepEqual(await ev(`[...document.querySelectorAll('${P} .pv-pool-order li')].map(li => [li.querySelector('b').textContent, li.classList.contains('missing'), li.querySelector('.pv-member-gone')?.textContent || ''])`),
      [['qa-two@example.com', false, ''], ['已删除的账号', true, '已删除，保存时移出']]);
    assert.notEqual(await ev(`getComputedStyle(document.querySelector('${P} .pv-member-gone')).color`), 'rgb(0, 0, 0)');
    await ev(`document.querySelector('${P} .pv-pool-editor [data-value=round-robin]').click()`);
    await ev(`document.querySelector('${P} .pv-editor').requestSubmit()`);
    await until(`!document.querySelector('${P} .pv-editor')`);
    const trimmed = await ev(`window.tokenpulse.agentState().then(s => s.providers.find(p => p.name === 'Claude 双号').pool)`);
    assert.deepEqual([trimmed.strategy, trimmed.members.map(m => m.id)], ['round-robin', ['claude:qa-two']], '保存成功，删掉的账号移出号池');
    assert.equal(await ev("document.body.innerText.includes('找不到的官方账号')"), false);

    // ---------- 没有账号的工具：号池给出去设置的入口 ----------
    await ev(`document.querySelector('${P} .pv-nav [data-section=grok]').click()`);
    await click(`${P} .pv-head-actions button`, '新建号池');
    await ev(`document.querySelector('${P} [data-section=edit-members]').click()`);
    await until(`[...document.querySelectorAll('${P} .pv-pool-accounts button')].some(b => b.textContent.includes('去设置添加账号'))`);
    // 版面：夜间没有默认黑字；900px 不横向溢出
    await ev("setThemeMode('dark')"); await delay(150);
    assert.deepEqual(await ev(`[...document.querySelectorAll('${P} *')].filter(n => [...n.childNodes].some(c => c.nodeType === 3 && c.nodeValue.trim()) && getComputedStyle(n).color === 'rgb(0, 0, 0)').map(n => n.className)`), []);
    await ev("setThemeMode('light')");
    BrowserWindow.fromWebContents(contents).setSize(900, 800); await delay(300);
    assert.equal(await ev(`document.querySelector('${P}').scrollWidth <= document.querySelector('${P}').clientWidth + 1`), true);
    await ev(`document.querySelector('${P} [data-section=edit-back]').click()`);
    await ev(`window.tokenpulse.agentProxy('claude', false).then(r => r.confirm ? window.tokenpulse.agentConfirm(r.confirm.token) : r)`);
    // 转发记录页在一条记录都没有时：只有说明卡和空状态，不能把空的那一块显示成「null」（0.3.34 测试版里出过）
    await ev(`document.querySelector('${P} .pv-nav [data-section=logs]').click()`);
    await until(`document.querySelector('${P} .pv-log-keep') && document.querySelector('${P} .pv-empty')`);
    await delay(300);
    assert.equal(await ev(`document.querySelectorAll('${P} .pv-log-row').length`), 0);
    assert.equal(await ev(`/null|undefined/.test(document.querySelector('${P}').textContent)`), false, '页面上不能出现 null / undefined');
    assert.equal(await ev(`!!document.querySelector('${P} .pv-log-pager')`), false, '没有记录就没有翻页');
    console.log('PASS provider avatars and pools: auto-match, preset pick, upload downscale, dark inversion, pool steps, member order, fill-first, fetch models from members, preview without secrets, enable via local route, preview shortcuts, no-account hint, dark/900px');
    clearTimeout(watchdog); app.exit(0);
  } catch (e) { console.error('FAIL', e.stack || e.message); clearTimeout(watchdog); app.exit(1); }
}));
app.on('quit', () => { modelServer.close(); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 句柄没放完就留给系统清理 */ } });
require(path.join(appRoot, 'build/main/index.js'));
