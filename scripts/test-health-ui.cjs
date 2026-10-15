/*
 * 0.3.55 的两块界面：体检页、会话全文搜索。
 * 临时数据目录和临时 HOME；体检的结果换成固定的（不读真实状态、不联网），会话用临时目录里造的文件真实地搜。
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { app, ipcMain } = require('electron');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-health-ui-'));
process.env.TOKENPULSE_DATA_DIR = path.join(dir, 'data');
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(dir, 'home');
process.env.TOKENPULSE_DSH_HOME = path.join(dir, 'dsh');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
const version = require('../package.json').version;
fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'prefs.json'), JSON.stringify({ autoLaunch: false, autoUpdate: false, closeToTray: true, startMinimized: true, language: 'zh', notifyAt: 0, notifyMismatch: false, ccSwitch: false, seenVersion: version, onboarding: 'done', theme: 'light' }));
app.setPath('userData', path.join(dir, 'electron'));
app.commandLine.appendSwitch('lang', 'zh-CN');
process.argv.push('--hidden');
require('../build/core/quota.js').fetchOfficialQuota = async () => ({});

// 会话：一段 Claude Code 对话，三处提到 webpack（用户、AI、工具调用的文件路径）
const project = path.join(dir, 'Demo');
const claudeFile = path.join(process.env.HOME, '.claude', 'projects', 'D--Demo', 'qa-1.jsonl');
fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
fs.writeFileSync(claudeFile, [
  { type: 'user', uuid: 'u1', timestamp: '2026-10-14T10:00:00Z', sessionId: 'qa-1', cwd: project, message: { content: '帮我改一下 Webpack 配置' } },
  { type: 'assistant', uuid: 'a1', timestamp: '2026-10-14T10:00:02Z', message: { id: 'm1', model: 'claude-qa', content: [{ type: 'text', text: '好的，先看看 webpack.config.js。' }] } },
  { type: 'assistant', uuid: 'a2', timestamp: '2026-10-14T10:00:03Z', message: { id: 'm2', model: 'claude-qa', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'D:\\Demo\\webpack.config.js' } }] } },
  { type: 'user', uuid: 'u2', timestamp: '2026-10-14T10:00:04Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'module.exports = {}' }] } },
  { type: 'assistant', uuid: 'a3', timestamp: '2026-10-14T10:00:06Z', message: { id: 'm3', model: 'claude-qa', content: [{ type: 'text', text: '改好了。' }] } },
  { type: 'ai-title', aiTitle: 'QA 打包配置' },
].map(row => JSON.stringify(row)).join('\n') + '\n');
fs.writeFileSync(path.join(path.dirname(claudeFile), 'qa-2.jsonl'), [
  { type: 'user', uuid: 'v1', timestamp: '2026-10-13T09:00:00Z', sessionId: 'qa-2', cwd: project, message: { content: '数据库迁移' } },
  { type: 'assistant', uuid: 'v2', timestamp: '2026-10-13T09:00:02Z', message: { id: 'n1', model: 'claude-qa', content: [{ type: 'text', text: '好的。' }] } },
].map(row => JSON.stringify(row)).join('\n') + '\n');

// 体检：固定结果（有问题、建议看看、正常各几项）
const { buildHealthReport } = require('../build/core/health-check.js');
let healthCalls = 0;
const fixture = () => buildHealthReport({
  now: Date.now(),
  drift: [{ appName: 'Claude Code', expectedName: '官方登录', liveName: 'relay.example.com' }],
  leftovers: [],
  route: { port: 17621, running: true, listening: true, users: ['Codex'] },
  readOnly: false,
  accounts: [{ kindLabel: 'Claude', name: 'qa@example.com', inCli: false, usable: false, needsLogin: true, waitCli: false, renewError: 'HTTP 400 invalid_grant', hidden: false }],
  autoSwitchIdle: [],
  renewLog: [{ at: Date.now() - 3600_000, kindLabel: 'Claude', name: 'qa@example.com', source: 'stored', ok: false, status: 400, code: 'invalid_grant', permanent: true }],
  egress: { enabled: false, providers: [] },
  proxy: { mode: 'direct' },
  reach: [{ name: 'Claude', host: 'api.anthropic.com', ok: true, status: 404, ms: 120 }],
  data: { dir: 'C:\\qa-data', writable: true, freeBytes: 80 * 1024 ** 3, tmpFiles: 0, tmpBytes: 0 },
}, 900);
const registerHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => registerHandler(channel, channel === 'health:run' ? async () => { healthCalls += 1; return fixture(); } : handler);

const watchdog = setTimeout(() => { console.error('FAIL health / search UI timed out'); app.exit(1); }, 90000);
app.on('web-contents-created', (_event, wc) => wc.once('did-finish-load', async () => {
  const e = async code => { try { return await wc.executeJavaScript(code); } catch (error) { console.error('UI expression:', code); throw error; } };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async code => { const end = Date.now() + 15000; while (!await e(code)) { assert.ok(Date.now() < end, code); await pause(40); } };
  // 自查截图（只用这里的测试数据）：设了 TP_SHOTS 才截
  const shot = async name => { if (!process.env.TP_SHOTS) return; await pause(400); fs.writeFileSync(path.join(process.env.TP_SHOTS, name + '.png'), (await wc.capturePage()).toPNG()); };
  if (process.env.TP_SHOTS) { const win = require('electron').BrowserWindow.fromWebContents(wc); win.setSize(1440, 900); win.showInactive(); }
  try {
    await until("typeof navigate === 'function' && document.body.dataset.page === 'overview'");

    /* ---- 体检 ---- */
    assert.equal(await e("document.querySelector('#nav [data-page=health] .nav-label').textContent"), '体检');
    await e("document.querySelector('#nav [data-page=health]').click()");
    await until("document.body.dataset.page === 'health' && document.querySelectorAll('#page-health .hc-group').length === 4");
    assert.equal(healthCalls, 1, '打开就体检一次');
    assert.equal(await e("document.getElementById('page-title').textContent"), '一键检查哪里不对');
    assert.match(await e("document.querySelector('.hc-summary').textContent"), /有 2 项需要处理/);
    assert.deepEqual(await e("[...document.querySelectorAll('.hc-group')].map(g => g.dataset.healthGroup + ':' + g.querySelector('.hc-tag').textContent)"), ['tools:建议看看', 'accounts:有问题', 'network:提示', 'data:正常']);
    assert.equal(await e("document.querySelector('[data-health-group=accounts] .hc-item').classList.contains('bad')"), true, '组里最严重的排前面');
    assert.match(await e("document.querySelector('[data-health-item=renew-log] .hc-lines').textContent"), /HTTP 400 invalid_grant，需要重新登录/);
    assert.equal(await e("document.getElementById('nav-health-alert').hidden"), false, '有问题时侧栏亮红点');
    await shot('health');
    // 按钮带到要处理的页
    await e("document.querySelector('[data-health-item=drift-0] [data-go-page=providers]').click()");
    await until("document.body.dataset.page === 'providers'");
    await e("document.querySelector('#nav [data-page=health]').click()");
    await until("document.body.dataset.page === 'health' && document.querySelectorAll('.hc-group').length === 4");
    assert.equal(healthCalls, 1, '5 分钟内回来不重新体检');
    await e("document.querySelector('[data-health-item=account-0] [data-go-settings=accounts]').click()");
    await until("!document.getElementById('settings').hidden && document.querySelector('[data-settings-tab=accounts]').classList.contains('on')");
    await e("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await until("document.getElementById('settings').hidden");
    await e("document.querySelector('.hc-run').click()");
    await until(`${healthCalls} >= 1 && !document.querySelector('.hc-run').disabled`);
    assert.equal(healthCalls, 2, '点「重新体检」再查一次');
    console.log('PASS 0.3.55 health check page: four groups worst-first, summary, renew failures listed, nav alert, actions open the right page / settings tab, re-run only on demand');

    /* ---- 会话全文搜索 ---- */
    await e("navigate('sessions')");
    await until("document.querySelectorAll('#page-sessions .sw-item').length === 2");
    const type = text => e(`(() => { const input = document.querySelector('#page-sessions .sw-search input'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await type('webpack');
    await until("document.querySelector('#page-sessions .sw-item.has-hit')");
    assert.match(await e("document.querySelector('.sw-search-note').textContent"), /对话内容里有 1 段会话命中，共 3 条消息/);
    assert.equal(await e("document.querySelectorAll('#page-sessions .sw-item').length"), 1, '只剩命中的会话');
    assert.match(await e("document.querySelector('.sw-item.has-hit .sw-hit-count').textContent"), /3 处/);
    assert.equal(await e("document.querySelector('.sw-item.has-hit .sw-item-snippet mark.sw-hl').textContent.toLowerCase()"), 'webpack', '片段里的词高亮');
    await e("document.querySelector('.sw-item.has-hit').click()");
    await until("document.querySelector('.sw-jump') && document.querySelector('.sw-hit-now')");
    assert.match(await e("document.querySelector('.sw-jump-label').textContent"), /「webpack」第 1 \/ 3 处/);
    assert.ok(await e("document.querySelectorAll('.sw-messages mark.sw-hl').length") >= 2, '对话里的词高亮');
    await e("document.querySelector('.sw-jump-down').click()");
    assert.match(await e("document.querySelector('.sw-jump-label').textContent"), /第 2 \/ 3 处/);
    await shot('search');
    await e("document.querySelector('.sw-jump-down').click()");
    await until("document.querySelector('.sw-jump-label').textContent.includes('第 3 / 3 处')");
    assert.equal(await e("document.querySelector('.sw-hit-now').classList.contains('sw-tool-wrap')"), true, '第三处是工具调用：收起的工具组自动展开');
    await e("document.querySelector('.sw-jump [aria-label=关闭搜索定位]').click()");
    await until("!document.querySelector('.sw-jump') && !document.querySelector('.sw-messages mark.sw-hl')");
    await type('数据库 迁移');
    await until("document.querySelector('.sw-search-note').textContent.includes('1 段会话命中')");
    await type('webpack 迁移');
    await until("document.querySelector('.sw-search-note').textContent.includes('没有找到')");
    await type('');
    await until("document.querySelectorAll('#page-sessions .sw-item').length === 2 && !document.querySelector('.sw-item.has-hit')");
    console.log('PASS 0.3.55 session full-text search: hits merged into the list with count and highlighted snippet, opens at the first match, previous / next across messages and tool calls, close, multi-word AND, clearing restores the list');

    clearTimeout(watchdog);
    app.exit(0);
  } catch (error) {
    console.error('FAIL', error);
    clearTimeout(watchdog);
    app.exit(1);
  }
}));
// Electron 还占着临时目录里的文件时删不掉：等进程退出前再删
app.on('will-quit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 系统临时目录，留给系统清理 */ } });
require('../build/main/index.js');
