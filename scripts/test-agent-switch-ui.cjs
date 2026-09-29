const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-agent-ui-'));
const home = path.join(root, 'home');
process.env.HOME = process.env.USERPROFILE = home;
process.env.AGENT_SWITCH_HOME = home;
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.AGENT_SWITCH_CC_DB = path.join(root, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { keep: true }, env: { DISABLE_TELEMETRY: '1' } }));
fs.writeFileSync(path.join(root, 'data', 'prefs.json'), JSON.stringify({ autoLaunch: false, autoUpdate: false, closeToTray: true, startMinimized: true, language: 'zh', notifyAt: 0, notifyMismatch: false, ccSwitch: false }));
app.setPath('userData', path.join(root, 'electron'));
app.commandLine.appendSwitch('lang', 'zh-CN');
const watchdog = setTimeout(() => { console.error('FAIL agent switch UI timed out'); app.exit(1); }, 40000);
app.whenReady().then(() => {});
app.on('web-contents-created', (_event, contents) => contents.once('did-finish-load', async () => {
  const evaluate = code => contents.executeJavaScript(code);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async code => {
    const end = Date.now() + 10000;
    while (!await evaluate(`Promise.resolve(${code}).then(v => !!v)`)) {
      assert.ok(Date.now() < end, 'Timed out: ' + code);
      await delay(40);
    }
  };
  try {
    const P = '#page-providers';
    const settings = () => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    const nav = id => evaluate(`document.querySelector('${P} .pv-nav [data-section=${id}]').click()`);
    const addButton = `[...document.querySelectorAll('${P} .pv-head-actions button')].find(b => b.textContent.includes('添加供应商'))`;
    await until("document.querySelector('[data-page=providers]')");
    await evaluate("navigate('providers')");
    // 概览：二级菜单 + 三家工具卡，没有 Gemini
    await until(`document.querySelectorAll('${P} .pv-nav .pv-nav-item').length === 8 && document.querySelectorAll('${P} .pv-app-card').length === 4`);
    assert.equal(await evaluate(`document.querySelector('${P}').innerText.includes('Gemini')`), false, '页面上不能再有 Gemini');
    assert.equal(await evaluate(`document.querySelector('${P} .pv-nav-item.on').dataset.section`), 'overview');
    await nav('desktop');
    await until(`document.querySelector('${P} .pv-head h2')?.textContent === 'Claude 桌面端'`);
    assert.equal(await evaluate(`document.querySelector('${P} .pv-nav-item.on').dataset.section`), 'desktop', '点 Claude 桌面端必须留在这一页');
    await nav('overview');
    await nav('grok');
    await evaluate("[...document.querySelectorAll('#page-providers button')].find(b => b.textContent.trim() === '添加供应商').click()");
    await until("document.querySelector('#page-providers .pv-editor')");
    await evaluate("document.querySelector('#page-providers .pv-editor').requestSubmit()");
    assert.equal(await evaluate("document.querySelector('#page-providers .pv-nav-item.on').dataset.section"), 'edit-basic');
    await evaluate("document.querySelector('#page-providers .pv-editor input[name=name]').value = 'QA Grok'");
    await evaluate("document.querySelector('#page-providers .pv-editor').requestSubmit()");
    assert.equal(await evaluate("document.querySelector('#page-providers .pv-nav-item.on').dataset.section"), 'edit-connect', '隐藏的必填模型不应阻止跳到缺失连接字段');
    await evaluate("document.querySelector('#page-providers [data-section=edit-back]').click()");
    assert.equal(await evaluate("!!document.querySelector('#page-providers .pv-unsaved')"), true, '离开编辑不能静默丢失修改');
    await evaluate("[...document.querySelectorAll('#page-providers .pv-unsaved button')].find(b => b.textContent === '继续编辑').click()");
    assert.equal(await evaluate("document.querySelector('#page-providers input[name=name]').value"), 'QA Grok');
    await evaluate("document.querySelector('#page-providers [data-section=edit-back]').click()");
    await evaluate("[...document.querySelectorAll('#page-providers .pv-unsaved button')].find(b => b.textContent === '放弃修改').click()");
    await nav('overview');
    // Local models fixture: no external account, no image or screenshot APIs.
    const modelsServer = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'qa-model-a' }, { id: 'qa-model-b' }] })); });
    await new Promise(resolve => modelsServer.listen(0, '127.0.0.1', resolve));
    try {
      const modelUrl = 'http://127.0.0.1:' + modelsServer.address().port + '/v1';
      for (const tool of ['grok', 'codex']) {
        await nav(tool);
        await evaluate(addButton + '.click()');
        await until("document.querySelector('#page-providers .pv-editor')");
        await evaluate(`(() => { const form = document.querySelector('#page-providers .pv-editor'); form.elements.name.value = 'QA Models ${tool}'; form.elements.baseUrl.value = ${JSON.stringify(modelUrl)}; form.elements.apiKey.value = 'qa-key'; document.querySelector('#page-providers [data-section=edit-models]').click(); })()`);
        await evaluate("[...document.querySelectorAll('#page-providers .pv-editor button')].find(b => b.textContent === '获取模型').click()");
        await until("document.querySelectorAll('#page-providers .pv-fetched button').length === 2");
        await evaluate("document.querySelector('#page-providers .pv-fetched button').click()");
        assert.equal(await evaluate("document.querySelector('#page-providers input[name=model]').value"), 'qa-model-a');
        if (tool === 'codex') {
          await evaluate("[...document.querySelectorAll('#page-providers .pv-editor button')].find(b => b.textContent === '添加模型').click()");
          await evaluate("document.querySelectorAll('#page-providers .pv-fetched button')[1].click()");
          assert.deepEqual(await evaluate("[...document.querySelectorAll('#page-providers .pv-slot input[placeholder=\"实际请求模型\"]')].map(n => n.value)"), ['qa-model-a', 'qa-model-b'], '同角色模型必须填到第二行而不是覆盖第一行');
          await evaluate("document.querySelector('#page-providers .pv-fetched button').click()");
          assert.equal(await evaluate("document.querySelector('#page-providers input[name=model]').value"), 'qa-model-a');
          await evaluate("[...document.querySelector('#page-providers .pv-slot .pv-levels').querySelectorAll('button')].find(b => b.textContent === 'low').click()");
          assert.equal(await evaluate("[...document.querySelector('#page-providers .pv-slot .pv-levels').querySelectorAll('button')].find(b => b.textContent === 'low').getAttribute('aria-pressed')"), 'false');
          await evaluate("(() => { const select = document.querySelector('#page-providers select[aria-label=\"默认思考等级\"]'); select.value = 'medium'; select.dispatchEvent(new Event('change')); })()");
        }
        await evaluate("(() => { const form = document.querySelector('#page-providers .pv-editor'); form.requestSubmit(); form.requestSubmit(); })()");
        await until("!document.querySelector('#page-providers .pv-editor')");
        const rows = await evaluate(`window.tokenpulse.agentState().then(s => s.providers.filter(p => p.name === 'QA Models ${tool}'))`);
        assert.equal(rows.length, 1, '重复提交不能重复新增供应商');
        assert.equal(rows[0].model, 'qa-model-a');
        if (tool === 'codex') { assert.equal(rows[0].slots[1].model, 'qa-model-b'); assert.equal(rows[0].slots[0].defaultReasoningLevel, 'medium'); assert.equal(rows[0].slots[0].reasoningLevels.includes('low'), false); }
      }
    } finally { modelsServer.closeAllConnections(); await new Promise(resolve => modelsServer.close(resolve)); }
    await nav('overview');
    // 路由服务：改端口
    const port = await new Promise(resolve => {
      const server = http.createServer();
      server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
    });
    await nav('router');
    await until(`document.querySelector('${P} .pv-port')`);
    await evaluate(`(() => { const input = document.querySelector('${P} .pv-port'); input.value = '${port}'; input.dispatchEvent(new Event('change')); })()`);
    await until(`window.tokenpulse.agentState().then(state => state.proxy.port === ${port})`);
    // Claude Code：添加供应商在抽屉里
    await nav('claude');
    await until(`document.querySelector('${P} .pv-head h2')?.textContent === 'Claude Code'`);
    await evaluate(`${addButton}.click()`);
    await until(`document.querySelector('${P} .pv-editor')`);
    const fill = (name, model, key) => evaluate(`(() => { const f = document.querySelector('${P} .pv-editor'); f.elements.name.value = '${name}'; f.elements.model.value = '${model}'; f.elements.baseUrl.value = 'https://relay.example/v1'; f.elements.apiKey.value = '${key}'; f.querySelector('[type=submit]').click(); })()`);
    await fill('QA Relay', 'claude-sonnet-5', 'sk-ui-secret');
    await until(`!document.querySelector('${P} .pv-editor') && [...document.querySelectorAll('${P} .pv-row b')].some(n => n.textContent === 'QA Relay')`);
    // 启用：写进 Claude 配置，保留 hooks；界面上看不到密钥
    await evaluate(`[...document.querySelectorAll('${P} .pv-row')].find(r => r.querySelector('b').textContent === 'QA Relay').querySelector('.pv-use').click()`);
    await until(`document.querySelector('${P} .pv-current b')?.textContent === 'QA Relay'`);
    assert.equal(settings().hooks.keep, true);
    assert.equal(settings().env.DISABLE_TELEMETRY, '1');
    assert.equal(settings().env.ANTHROPIC_AUTH_TOKEN, 'sk-ui-secret');
    assert.equal(await evaluate("document.body.innerText.includes('sk-ui-secret')"), false);
    assert.match(await evaluate(`document.querySelector('${P} .pv-nav [data-section=claude] small').textContent`), /QA Relay/, '二级菜单上显示当前供应商');
    // 编辑：密钥留空就沿用原来的，只改模型
    await evaluate(`[...document.querySelectorAll('${P} .pv-current button')].find(b => b.textContent.includes('编辑')).click()`);
    await until(`document.querySelector('${P} .pv-editor')?.elements.name.value === 'QA Relay'`);
    await evaluate(`(() => { const f = document.querySelector('${P} .pv-editor'); f.elements.model.value = 'claude-opus-5'; f.querySelector('[type=submit]').click(); })()`);
    await until(`!document.querySelector('${P} .pv-editor')`);
    await until(`window.tokenpulse.agentState().then(s => s.providers.some(p => p.name === 'QA Relay' && p.model === 'claude-opus-5'))`);
    assert.equal(settings().env.ANTHROPIC_AUTH_TOKEN, 'sk-ui-secret', '编辑时不填密钥要保留原密钥');
    // Esc 关抽屉
    await evaluate(`${addButton}.click()`);
    await until(`document.querySelector('${P} .pv-editor')`);
    await evaluate(`document.querySelector('${P} .pv-editor input[name=name]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(`!document.querySelector('${P} .pv-editor')`);
    // 再加一家：键盘 Alt+↓ 调顺序；删除要点两次
    await evaluate(`${addButton}.click()`);
    await until(`document.querySelector('${P} .pv-editor')`);
    await fill('QA Backup', 'claude-sonnet-5', 'sk-backup');
    await until(`[...document.querySelectorAll('${P} .pv-row b')].some(n => n.textContent === 'QA Backup')`);
    const before = await evaluate(`[...document.querySelectorAll('${P} .pv-row b')].map(n => n.textContent).join('|')`);
    await evaluate(`document.querySelector('${P} .pv-row').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))`);
    await until(`[...document.querySelectorAll('${P} .pv-row b')].map(n => n.textContent).join('|') !== ${JSON.stringify(before)}`);
    const trash = `[...document.querySelectorAll('${P} .pv-row')].find(r => r.querySelector('b').textContent === 'QA Backup').querySelector('.pv-icon-btn.danger')`;
    await evaluate(`${trash}.click()`);
    await delay(150);
    assert.ok(await evaluate(`[...document.querySelectorAll('${P} .pv-row b')].some(n => n.textContent === 'QA Backup')`), '第一次点删除不能真删');
    await evaluate(`${trash}.click()`);
    await until(`![...document.querySelectorAll('${P} .pv-row b')].some(n => n.textContent === 'QA Backup')`);
    // 连接方式切到本地路由：配置写成占位密钥和本地地址，菜单上出现「路由」
    await evaluate(`[...document.querySelectorAll('${P} .pv-mode-seg button')].find(b => b.textContent === '本地路由').click()`);
    await until(`document.querySelector('${P} .pv-nav [data-section=claude] .pv-nav-badge.route')`);
    assert.equal(settings().env.ANTHROPIC_AUTH_TOKEN, 'PROXY_MANAGED');
    assert.match(settings().env.ANTHROPIC_BASE_URL, new RegExp(`127\\.0\\.0\\.1:${port}`));
    assert.equal(settings().hooks.keep, true);
    // 不看截图，用 DOM 查版面：夜间模式没有默认黑字；各分区里没有元素伸出页面；抽屉在窗口里
    const blackText = `[...document.querySelectorAll('${P} *')].filter(n => [...n.childNodes].some(c => c.nodeType === 3 && c.nodeValue.trim()) && getComputedStyle(n).color === 'rgb(0, 0, 0)').map(n => n.className || n.tagName)`;
    const overflow = `(() => { const box = document.querySelector('${P}').getBoundingClientRect(); return [...document.querySelectorAll('${P} .pv-main *')].filter(n => { const r = n.getBoundingClientRect(); return r.width && (r.right > box.right + 1 || r.left < box.left - 1); }).map(n => n.className || n.tagName).slice(0, 5); })()`;
    await evaluate("setThemeMode('dark')"); await delay(200);
    for (const id of ['overview', 'claude', 'desktop', 'router', 'logs', 'import']) {
      await nav(id); await delay(120);
      assert.deepEqual(await evaluate(blackText), [], `夜间模式「${id}」有黑字`);
      assert.deepEqual(await evaluate(overflow), [], `「${id}」有元素伸出页面`);
    }
    await nav('claude'); await delay(120);
    await evaluate(`${addButton}.click()`);
    await until(`document.querySelector('${P} .pv-editor')`);
    assert.deepEqual(await evaluate(blackText), [], '夜间模式抽屉有黑字');
    // 测试窗口是隐藏的，Chromium 不推进隐藏窗口里的 CSS 动画：先让动画走完再量位置
    await evaluate('document.getAnimations().forEach(a => a.finish())');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('${P} .pv-editor')).position`), 'static', '编辑页跟在菜单右边，不再是浮层');
    assert.equal(await evaluate(`document.querySelector('${P} .pv-nav [data-section=edit-models]') !== null`), true, '编辑时左侧是设置菜单');
    await evaluate(`document.querySelector('${P} .pv-editor input[name=name]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(`!document.querySelector('${P} .pv-editor')`);
    await evaluate("setThemeMode('light')"); await delay(900);
    // 窄窗口：二级菜单变成顶部一排，页面本身不横向滚动
    const win = BrowserWindow.fromWebContents(contents);
    win.setSize(900, 800);
    await delay(250);
    assert.equal((await evaluate(`getComputedStyle(document.querySelector('${P} .pv')).gridTemplateColumns`)).split(' ').length, 1);
    assert.equal(await evaluate(`document.querySelector('${P}').scrollWidth <= document.querySelector('${P}').clientWidth + 1`), true);
    contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('${P} .pv-nav-item')).transitionDuration`), '0s');
    contents.debugger.detach();
    // 关掉路由，写回直连
    await evaluate(`[...document.querySelectorAll('${P} .pv-mode-seg button')].find(b => b.textContent === '直连').click()`);
    await until(`!document.querySelector('${P} .pv-nav [data-section=claude] .pv-nav-badge.route')`);
    assert.equal(settings().env.ANTHROPIC_AUTH_TOKEN, 'sk-ui-secret');
    // A saved note must not silently take over a connection another tool changed.
    await evaluate("[...document.querySelectorAll('#page-providers .pv-current button')].find(b => b.textContent.includes('编辑')).click()");
    await until("document.querySelector('#page-providers .pv-editor')");
    const external = JSON.stringify({ hooks: { keep: true }, env: { ANTHROPIC_BASE_URL: 'https://external.example', ANTHROPIC_AUTH_TOKEN: 'fixture-external' } });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), external);
    await evaluate("(() => { const form = document.querySelector('#page-providers .pv-editor'); form.elements.notes.value = 'Metadata only'; form.requestSubmit(); })()");
    await until("!document.querySelector('#page-providers .pv-editor')");
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), external);
    await until("document.body.innerText.includes('未覆盖')");
    // Failure to restore must cancel application quit, not leave a dead proxy address.
    const backend = require('../build/core/agent-switch');
    const { dialog } = require('electron');
    const release = backend.releaseAgentSwitch, showError = dialog.showErrorBox;
    let prevented = false, warned = false;
    try {
      backend.releaseAgentSwitch = () => { throw new Error('Synthetic restore failure'); };
      dialog.showErrorBox = () => { warned = true; };
      app.emit('before-quit', { preventDefault: () => { prevented = true; } });
      assert.equal(prevented, true); assert.equal(warned, true);
    } finally { backend.releaseAgentSwitch = release; dialog.showErrorBox = showError; }
    console.log('PASS agent switch UI: field navigation, unsaved guard, Grok/Codex fetched models, explicit reasoning default, duplicate save guard, sub-menu add/edit, enable, reorder/delete, route toggle, 900px and reduced motion');
    clearTimeout(watchdog);
    app.exit(0);
  } catch (error) {
    console.error('FAIL', error);
    clearTimeout(watchdog);
    app.exit(1);
  }
}));
require('../build/main/index.js');
