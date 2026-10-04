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
fs.writeFileSync(path.join(root, 'data', 'prefs.json'), JSON.stringify({ autoLaunch: false, autoUpdate: false, closeToTray: true, startMinimized: true, language: 'zh', notifyAt: 0, notifyMismatch: false, ccSwitch: false, seenVersion: require('../package.json').version, onboarding: 'done' }));
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
    // 0.3.9 起改工具配置前会弹对比确认；这个测试不是测确认框，自动点「确认写入」（确认框在 test-agent-guard-ui.cjs 里单独测）
    await evaluate("setInterval(() => document.querySelector('#pv-confirm .btn-accent')?.click(), 40)");
    const P = '#page-providers';
    const settings = () => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    const nav = id => evaluate(`document.querySelector('${P} .pv-nav [data-section=${id}]').click()`);
    const addButton = `[...document.querySelectorAll('${P} .pv-head-actions button')].find(b => b.textContent.includes('添加供应商'))`;
    await until("document.querySelector('[data-page=providers]')");
    await evaluate("navigate('providers')");
    // 概览：二级菜单 + 三家工具卡，没有 Gemini
    await until(`document.querySelectorAll('${P} .pv-nav .pv-nav-item').length === 10 && document.querySelectorAll('${P} .pv-app-card').length === 4`);
    assert.equal(await evaluate(`document.querySelector('${P}').innerText.includes('Gemini')`), false, '页面上不能再有 Gemini');
    assert.equal(await evaluate(`document.querySelector('${P} .pv-nav-item.on').dataset.section`), 'overview');
    // Prism 桥（0.3.19）：全新环境下四步都没做，只有「安装运行环境」和「添加到 Codex 供应商」能点；先写明风险
    await nav('prism');
    await until(`document.querySelectorAll('${P} .pv-prism-step').length === 4`);
    const fit = await evaluate(`[...document.querySelectorAll('${P} .pv-prism-fit-row')].map(r => r.textContent)`);
    assert.equal(fit.length, 3);
    assert.match(fit[0], /适合.*降智/, '先说适合被降智的账号');
    assert.match(fit[1], /没必要.*正常/, '账号正常就没必要用');
    assert.match(fit[2], /服务条款.*风险/);
    assert.deepEqual(await evaluate(`[document.querySelector('${P} .pv-prism-hero b').textContent, document.querySelector('${P} .pv-prism-hero .btn-accent').textContent, document.querySelector('${P} .pv-prism-step.current').dataset.step, document.querySelectorAll('${P} .pv-prism-step.later').length, document.querySelector('${P} .pv-prism-logbox').open]`), ['还没有装运行环境', '安装运行环境', 'deps', 3, false], '总状态指出下一步，当前步骤高亮，日志平时收着');
    assert.equal(await evaluate(`document.querySelectorAll('${P} .pv-prism-models .pv-member').length`), 4, '列出能用的模型');
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${P} .pv-prism-step')].map(s => [s.dataset.step, s.classList.contains('done'), [...s.querySelectorAll('button.btn')].map(b => b.disabled)])`), [['deps', false, [false]], ['login', false, [true]], ['service', false, [true]], ['provider', false, [false]]]);
    assert.equal(await evaluate(`document.querySelector('${P} .pv-nav [data-section=prism] small').textContent`), '已停止');
    await evaluate(`document.querySelector('${P} [data-step=provider] button.btn').click()`);
    await until(`[...document.querySelectorAll('${P} [data-step=provider] button.btn')].map(b => b.textContent).join('|') === '更新供应商|在 Codex 里启用'`);
    const prismStore = JSON.parse(fs.readFileSync(path.join(root, 'data', 'agent-switch.json'), 'utf8')).providers.find(p => p.name === 'Prism 桥');
    assert.deepEqual([prismStore.app, prismStore.endpoint.baseUrl, prismStore.endpoint.upstream, prismStore.endpoint.model, prismStore.slots.length], ['codex', 'http://127.0.0.1:18765/v1', 'openai-responses', 'gpt-6.1-sol', 4]);
    assert.ok(prismStore.endpoint.apiKey.length >= 20 && !(await evaluate(`document.querySelector('${P}').innerHTML`)).includes(prismStore.endpoint.apiKey), '密钥不出现在页面上');
    // 0.3.20：日志文件按钮；一键删除要点两次，删完供应商和数据目录都没了，页面回到全新状态
    assert.equal(await evaluate(`document.querySelector('${P} .pv-prism-logbox summary .btn').textContent`), '打开日志文件');
    assert.equal(fs.existsSync(path.join(root, 'data', 'prism-bridge')), true);
    const removeButton = `document.querySelector('${P} .pv-prism-remove .btn')`;
    assert.match(await evaluate(`document.querySelector('${P} .pv-prism-remove').textContent`), /运行环境.*Chromium.*登录信息.*供应商.*不会动/);
    await evaluate(`${removeButton}.click()`);
    assert.equal(await evaluate(`${removeButton}.textContent`), '再点一次，确认删除', '第一次点只是要求确认');
    assert.equal(fs.existsSync(path.join(root, 'data', 'prism-bridge')), true);
    await evaluate(`${removeButton}.click()`);
    await until(`!document.querySelector('${P} .pv-prism-remove') && document.querySelector('${P} [data-step=provider] button.btn')?.textContent === '添加到 Codex 供应商'`);
    assert.equal(fs.existsSync(path.join(root, 'data', 'prism-bridge')), false, '数据目录里的 prism-bridge 整个删掉');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'agent-switch.json'), 'utf8')).providers.some(p => p.name === 'Prism 桥'), false, 'Codex 里的供应商也去掉');
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
    assert.equal(await evaluate("!!document.querySelector('.tp-toast.pv-unsaved')"), true, '离开编辑不能静默丢失修改');
    await evaluate("[...document.querySelectorAll('.tp-toast.pv-unsaved button')].find(b => b.textContent === '继续编辑').click()");
    assert.equal(await evaluate("document.querySelector('#page-providers input[name=name]').value"), 'QA Grok');
    await evaluate("document.querySelector('#page-providers [data-section=edit-back]').click()");
    await evaluate("[...document.querySelectorAll('.tp-toast.pv-unsaved button')].find(b => b.textContent === '放弃修改').click()");
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
          await evaluate("document.querySelector('#page-providers .pv-slot .pv-level-trigger').click();[...document.querySelectorAll('#page-providers .pv-level-option')].find(r => r.textContent.includes('low')).querySelector('input').click()");
          assert.equal(await evaluate("[...document.querySelectorAll('#page-providers .pv-level-option')].find(r => r.textContent.includes('low')).querySelector('input').checked"), false);
          await evaluate("(() => { const select = document.querySelector('#page-providers select[aria-label=\"默认思考等级\"]'); select.value = 'medium'; select.dispatchEvent(new Event('change')); })()");
          // 0.3.9 界面修复：勾选后面板不收起；面板不伸出页面；Esc 只关面板不关编辑页；Codex 模型行各列在同一行
          assert.equal(await evaluate("document.querySelector('#page-providers .pv-level-popover').hidden"), false, '勾选 / 换默认等级后面板要保持打开');
          assert.equal(await evaluate("(() => { const p = document.querySelector('#page-providers .pv-level-popover').getBoundingClientRect(), page = document.querySelector('#page-providers').getBoundingClientRect(); return p.right <= page.right + 1 && p.left >= page.left - 1; })()"), true, '等级面板不能伸出页面');
          await evaluate("document.querySelector('#page-providers .pv-level-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
          assert.equal(await evaluate("document.querySelector('#page-providers .pv-level-popover').hidden"), true, 'Esc 关掉等级面板');
          assert.ok(await evaluate("document.querySelector('#page-providers .pv-editor') !== null"), 'Esc 不能连带关掉编辑页');
          await evaluate("document.querySelector('#page-providers .pv-slot .pv-level-trigger').click()");
          await evaluate("document.querySelector('#page-providers .pv-model-head').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
          assert.equal(await evaluate("document.querySelector('#page-providers .pv-level-popover').hidden"), true, '点面板外面收起');
          assert.equal(await evaluate("(() => { const row = document.querySelector('#page-providers .pv-slot:not(.pv-slot-head)'); const tops = [...row.children].map(c => Math.round(c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2)); return Math.max(...tops) - Math.min(...tops) <= 4; })()"), true, 'Codex 模型行的输入、上下文、等级、删除在同一行');
          assert.equal(await evaluate("document.querySelectorAll('#page-providers .pv-slot-head span').length"), 5, 'Codex 模型行有列标题');
          // 快速预设只点亮对应的那一个接口格式
          await evaluate("document.querySelector('#page-providers [data-section=edit-basic]').click(); [...document.querySelectorAll('#page-providers .pv-preset-strip button')].find(b => b.textContent.includes('OpenAI Chat')).click()");
          assert.deepEqual(await evaluate("[...document.querySelectorAll('#page-providers [data-key=upstream] .pv-chip.on')].map(n => n.dataset.value)"), ['openai-chat'], '选 OpenAI Chat 预设时不能同时点亮 Responses');
          await evaluate("[...document.querySelectorAll('#page-providers .pv-preset-strip button')].find(b => b.textContent.includes('OpenAI Responses')).click()");
          assert.deepEqual(await evaluate("[...document.querySelectorAll('#page-providers [data-key=upstream] .pv-chip.on')].map(n => n.dataset.value)"), ['openai-responses']);
          // 预览跟着当前草稿走（切到预览页时重算）
          await evaluate("(() => { const input = document.querySelector('#page-providers .pv-slot:not(.pv-slot-head) input[placeholder=\"实际请求模型\"]'); input.value = 'qa-preview-model'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#page-providers [data-section=edit-preview]').click(); })()");
          assert.match(await evaluate("document.querySelector('#page-providers .pv-preview-json').textContent"), /qa-preview-model/, '预览要反映还没保存的修改');
          await evaluate("(() => { const input = document.querySelector('#page-providers .pv-slot:not(.pv-slot-head) input[placeholder=\"实际请求模型\"]'); input.value = 'qa-model-a'; input.dispatchEvent(new Event('input', { bubbles: true })); })()");
          // 高级设置：Prompt Cache 路由默认是「自动」（以前 selected=false 让所有选项都被选中，落成「关闭」）
          assert.equal(await evaluate("document.querySelector('#page-providers select[name=promptCacheRouting]').value"), 'auto');
        }
        await evaluate("(() => { const form = document.querySelector('#page-providers .pv-editor'); form.requestSubmit(); form.requestSubmit(); })()");
        await until("!document.querySelector('#page-providers .pv-editor')");
        const rows = await evaluate(`window.tokenpulse.agentState().then(s => s.providers.filter(p => p.name === 'QA Models ${tool}'))`);
        assert.equal(rows.length, 1, '重复提交不能重复新增供应商');
        assert.equal(rows[0].model, 'qa-model-a');
        assert.equal(rows[0].dailyLimitUsd, null, '没填限额不能存成 0'); assert.equal(rows[0].monthlyLimitUsd, null);
        if (tool === 'grok') assert.equal(rows[0].contextWindow, 131072, 'Grok 没改上下文时保存预设值，不写空');
        if (tool === 'codex') { assert.equal(rows[0].promptCacheRouting, 'auto'); assert.equal(rows[0].slots[1].model, 'qa-model-b'); assert.equal(rows[0].slots[0].defaultReasoningLevel, 'medium'); assert.equal(rows[0].slots[0].reasoningLevels.includes('low'), false); }
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
