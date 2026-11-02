const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-pi-ui-'));
Object.assign(process.env, { TOKENPULSE_DATA_DIR: path.join(root, 'data'), AGENT_SWITCH_HOME: path.join(root, 'home'), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), PI_CODING_AGENT_DIR: path.join(root, 'pi'), TOKENPULSE_DSH_HOME: path.join(root, 'dsh'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), GROK_HOME: path.join(root, 'grok'), AGENT_SWITCH_CC_DB: path.join(root, 'missing.db') });
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
write(path.join(root, 'data', 'prefs.json'), JSON.stringify({ autoLaunch: false, autoUpdate: false, closeToTray: true, startMinimized: true, language: 'zh', notifyAt: 0, notifyMismatch: false, ccSwitch: false, seenVersion: require('../package.json').version, onboarding: 'done' }));
write(path.join(root, 'pi', 'sessions', '--Demo--', 'pi-ui.jsonl'), [
  { type: 'session', version: 3, id: 'pi-ui', cwd: root },
  { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: '检查 pi 合成演示项目' } },
  { type: 'message', id: 'b', parentId: 'a', message: { role: 'assistant', model: 'pi-demo-model', usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 60, cost: { total: 0.5 } }, content: [{ type: 'text', text: 'pi-search-demo：测试项目检查完成。' }] } },
].map(row => JSON.stringify({ timestamp: new Date().toISOString(), ...row }) + '\n').join(''));
process.env.TOKENPULSE_DSH_HOME = path.join(root, 'dsh');
const dshFile = path.join(root, 'dsh', 'sessions', '--Demo--', 'session-ui', 'session.v4.jsonl.zstd');
write(dshFile, require('node:zlib').zstdCompressSync(Buffer.from([
  { type: 'session', id: 'session-ui', createdAt: '2026-09-24T13:00:00Z', cwd: root },
  { type: 'user/message', time: '2026-09-24T13:00:02Z', data: { role: 'user', content: [{ type: 'text', text: 'DeepSeek 合成演示问题' }] } },
  { type: 'assistant/message', time: '2026-09-24T13:00:03Z', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'DeepSeek 合成演示回答' }] } } },
].map(row => JSON.stringify(row)).join('\n') + '\n')));
fs.utimesSync(dshFile, new Date('2026-09-24T13:00:03Z'), new Date('2026-09-24T13:00:03Z')); // 排在 pi 后面，前面的步骤点的是第一条
const piFile = path.join(root, 'pi', 'sessions', '--Demo--', 'pi-ui.jsonl');
app.setPath('userData', path.join(root, 'electron')); app.commandLine.appendSwitch('lang', 'zh-CN'); process.argv.push('--hidden');
require('../build/core/quota.js').fetchOfficialQuota = async () => ({});
const watchdog = setTimeout(() => { console.error('FAIL pi UI timed out'); app.exit(1); }, 70000);
app.on('web-contents-created', (_event, wc) => wc.once('did-finish-load', async () => {
  const e = code => wc.executeJavaScript(code).catch(error => { console.error('UI expression:', code); throw error; });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async code => { const end = Date.now() + 12000; while (!await e(`Promise.resolve(${code}).then(v => !!v)`)) { assert.ok(Date.now() < end, code); await pause(50); } };
  const shot = async name => { if (!process.env.TP_SHOTS) return; const dir = process.env.TP_SHOTS; fs.mkdirSync(dir, { recursive: true }); const win = BrowserWindow.fromWebContents(wc); if (!win.isVisible()) { win.setSize(1440, 900); win.showInactive(); } await pause(250); fs.writeFileSync(path.join(dir, name + '.png'), (await wc.capturePage()).toPNG()); };
  try {
    await until("typeof navigate === 'function'");
    await e("setInterval(() => document.querySelector('#pv-confirm .btn-accent')?.click(), 30); navigate('providers')");
    await until("document.querySelector('#page-providers [data-section=pi]')");
    await e("document.querySelector('#page-providers [data-section=pi]').click()");
    await until("[...document.querySelectorAll('#page-providers .pv-head-actions button')].some(b => b.textContent.includes('添加供应商'))");
    await e("[...document.querySelectorAll('#page-providers .pv-head-actions button')].find(b => b.textContent.includes('添加供应商')).click()");
    await until("document.querySelector('.pv-editor')");
    await e("(() => { const f=document.querySelector('.pv-editor'); f.elements.name.value='pi Demo Gateway'; f.elements.baseUrl.value='http://127.0.0.1:19999/v1'; f.elements.apiKey.value='sk-fake-pi-ui'; document.querySelector('[data-section=edit-models]').click(); })()");
    await until("document.querySelector('.pv-models input[name=model]')");
    await e("document.querySelector('.pv-models input[name=model]').value='pi-demo-model'; document.querySelector('[data-section=edit-preview]').click()");
    await until("document.querySelector('.pv-preview-json')?.textContent.includes('openai-completions')");
    assert.match(await e("document.querySelector('.pv-preview-json').textContent"), /defaultProvider/);
    assert.ok(!await e("document.querySelector('.pv-preview-json').textContent.includes('sk-fake-pi-ui')"));
    await e("document.querySelector('[data-action=save-provider]').click()");
    await until("!document.querySelector('.pv-editor') && document.querySelector('#page-providers').textContent.includes('pi Demo Gateway')");
    const saved = await e("window.tokenpulse.agentState().then(v => v.providers.find(p => p.app === 'pi' && !p.official))");
    await e(`document.querySelector('.pv-row[data-id="${saved.id}"] .pv-use').click()`);
    await until("window.tokenpulse.agentState().then(v => v.providers.some(p => p.app === 'pi' && !p.official && p.active))");
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'pi', 'settings.json'), 'utf8')).defaultModel, 'pi-demo-model');
    await e("navigate('providers', {force:true}); document.querySelector('#page-providers [data-section=pi]').click()");
    await shot('pi-providers');
    console.log('PASS pi UI: provider navigation, single model editor, pi config preview, masked key, save and activation');
    await e("navigate('sessions')");
    await until("document.querySelector('#page-sessions .sw-item')");
    assert.ok(await e("[...document.querySelectorAll('#page-sessions [data-kind]')].some(n => n.dataset.kind === 'pi')"));
    await e("document.querySelector('#page-sessions .sw-item').click()");
    await until("document.querySelector('.sw-messages')?.textContent.includes('pi-search-demo')");
    assert.equal(await e("document.querySelector('.sw-composer textarea') === null"), true);
    assert.ok(await e("document.querySelector('#page-sessions .sw-mark.pi svg path') !== null"));
    const iconPaths = [...fs.readFileSync(path.join(__dirname, '../renderer/brand/presets/pi.svg'), 'utf8').matchAll(/<path[^>]*\sd="([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(await e("[...document.querySelector('.sw-head .sw-mark.pi svg').querySelectorAll('path')].map(p => p.getAttribute('d'))"), iconPaths);
    await e("(() => { const n=document.querySelector('.sw-search input'); n.value='pi-search-demo'; n.dispatchEvent(new Event('input',{bubbles:true})); })()");
    await until("document.querySelector('.sw-item.has-hit')");
    await e("document.querySelector('.sw-item.has-hit').click()");
    await until("document.querySelector('.sw-jump')");
    await shot('pi-sessions');
    console.log('PASS pi UI: session filter, icon, detail, full-text match and jump; terminal-only continuation');
    await e("localStorage.setItem('tokenpulse-lang', 'en'); location.reload()");
    await until("document.documentElement.lang.startsWith('en')");
    await e("navigate('sessions')");
    await until("document.querySelector('#page-sessions .sw-item')");
    await e("document.querySelector('#page-sessions .sw-item').click()");
    await until("document.querySelector('.sw-composer')");
    assert.ok(await e("[...document.querySelector('.sw-main').childNodes].every(n => n.nodeType !== Node.TEXT_NODE || !n.textContent.trim())"));
    assert.equal(await e("/[\u3400-\u9fff]/.test(document.querySelector('.sw-composer').textContent)"), false);
    const win = BrowserWindow.fromWebContents(wc); win.setSize(940, 760);
    await pause(200);
    assert.ok(await e("[...document.querySelectorAll('.sw-kinds button')].every(n => n.scrollWidth <= n.clientWidth + 2)"));
    await e("setThemeMode('light'); document.documentElement.classList.remove('theme-anim')");
    await shot('pi-sessions-en');
    const lightFill = await e("getComputedStyle(document.querySelector('.sw-mark.pi svg path')).fill");
    await e("setThemeMode('dark'); document.documentElement.classList.remove('theme-anim')");
    assert.notEqual(await e("getComputedStyle(document.querySelector('.sw-mark.pi svg path')).fill"), lightFill);
    await shot('pi-sessions-dark');
    console.log('PASS pi UI: English continuation note and narrow window');
    // 用量：pi 和别家一样出现在工具筛选和用量明细里，带自己的图标
    await e("navigate('usage')");
    await until("[...document.getElementById('source-filter').options].some(o => o.value === 'pi')");
    await e("(() => { const s = document.getElementById('source-filter'); s.value = 'pi'; s.dispatchEvent(new Event('change')); })()");
    await until("document.querySelector('#records tr')?.textContent.includes('pi-demo-model')");
    assert.equal(await e("document.querySelectorAll('#records tr').length"), 1);
    assert.equal(await e("current.sources.find(s => s.source === 'pi')?.tokens"), 60, '输入 10 + 缓存读 30 + 输出 20');
    assert.ok(await e("!!document.querySelector('#records tr .brand-svg path') || !!document.querySelector('#records tr .mini-logo svg')"), 'pi 有自己的图标，不是首字母');
    await shot('pi-usage');
    console.log('PASS pi UI: pi appears in the source filter and usage details');
    await e("document.getElementById('source-filter').value = 'all'; document.getElementById('source-filter').dispatchEvent(new Event('change')); navigate('sessions')");
    await until("document.querySelector('#page-sessions .sw-item')");
    // 删除对话：确认框选取消什么都不动；选删除后文件和列表项都没了，提示没有报错
    const { dialog } = require('electron');
    const prompts = [];
    let answer = 0;
    dialog.showMessageBox = async (...args) => { prompts.push(args.at(-1)); return { response: answer }; };
    const menuDelete = async key => {
      await e(`document.querySelector('.sw-item[data-key="${key}"]').click()`);
      await until(`document.querySelector('.sw-item.active')?.dataset.key === '${key}' && document.querySelector('.sw-actions .btn.icon-only')`);
      await e("document.querySelector('.sw-actions .btn.icon-only').click()");
      await until("document.querySelector('#option-menu .option-item.danger')");
      assert.equal(await e("document.querySelector('#option-menu .option-item.danger').textContent.includes('Delete conversation')"), true);
      await e("document.querySelector('#option-menu .option-item.danger').click()");
    };
    await menuDelete('pi:pi-ui');
    await until('true');
    await pause(300);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].detail, /pi 的 \/resume 列表/, 'pi 的确认框说明删的是什么');
    assert.ok(fs.existsSync(piFile), '取消就不删');
    answer = 1;
    await menuDelete('pi:pi-ui');
    await until("!document.querySelector('.sw-item[data-key=\"pi:pi-ui\"]')");
    assert.ok(!fs.existsSync(piFile));
    await menuDelete('deepseek:session-ui');
    await until("!document.querySelector('.sw-item[data-key=\"deepseek:session-ui\"]')");
    assert.match(prompts.at(-1).detail, /DeepSeek Harness 没有删除功能/);
    assert.ok(!fs.existsSync(path.dirname(dshFile)), 'DeepSeek 的会话目录整个删掉');
    assert.equal(await e("[...document.querySelectorAll('.sw-item')].length"), 0);
    console.log('PASS pi UI: delete pi and DeepSeek conversations from the More menu');
    clearTimeout(watchdog); app.exit(0);
  } catch (error) { console.error('FAIL pi UI', error); clearTimeout(watchdog); app.exit(1); }
}));
app.on('will-quit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
require('../build/main/index.js');
