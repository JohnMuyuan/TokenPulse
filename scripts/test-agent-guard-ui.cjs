'use strict';
/*
 * 0.3.9 供应商配置保护的界面：切换前的逐行对比确认（取消 / 确认）、密钥不出现在界面、只读保护拦截、
 * 配置保护页（原件、修改记录、还原）、设置里的入口、托盘切换走确认、夜间 / 900px。
 * 临时 HOME 和数据目录，不碰真实配置。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-agent-guard-ui-'));
process.env.TOKENPULSE_DATA_DIR = path.join(dir, 'data');
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(dir, 'home');
process.env.AGENT_SWITCH_CC_DB = path.join(dir, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'prefs.json'), JSON.stringify({ autoLaunch: false, autoUpdate: false, closeToTray: true, startMinimized: true, language: 'zh', notifyAt: 0, notifyMismatch: false, ccSwitch: false, seenVersion: require('../package.json').version, onboarding: 'done' }));
app.setPath('userData', path.join(dir, 'electron'));
process.argv.push('--hidden');
const claudeFile = path.join(dir, 'home', '.claude', 'settings.json');
const original = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://mine.invalid', ANTHROPIC_AUTH_TOKEN: 'sk-user-original-secret-xyz' }, theme: 'dark' }, null, 2) + '\n';
fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
fs.writeFileSync(claudeFile, original);
const sw = require('../build/core/agent-switch');
const id = sw.saveProvider({ app: 'claude', name: 'Guard QA', baseUrl: 'https://guard.invalid/v1', apiKey: 'sk-guard-provider-secret-abc', model: 'qa-model', upstream: 'anthropic' });
const secondId = sw.saveProvider({ app: 'claude', name: 'Second QA', baseUrl: 'https://second.invalid/v1', apiKey: 'sk-second-secret-def', model: 'qa-model', upstream: 'anthropic' });
const read = () => fs.readFileSync(claudeFile, 'utf8');
const watchdog = setTimeout(() => { console.error('FAIL agent guard UI timed out'); app.exit(1); }, 60000);
app.on('web-contents-created', (_event, wc) => wc.once('did-finish-load', async () => {
  const e = code => wc.executeJavaScript(code).catch(err => { throw new Error(err.message + ' ← ' + String(code).slice(0, 160)); });
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const until = async (code, ms = 8000) => { const end = Date.now() + ms; while (!await e(`Promise.resolve(${code}).then(v => !!v)`)) { assert.ok(Date.now() < end, 'Timed out: ' + code); await delay(40); } };
  const P = '#page-providers';
  const row = rid => `document.querySelector('${P} .pv-row[data-id="${rid}"]')`;
  const secretsShown = () => e(`['sk-user-original-secret-xyz', 'sk-guard-provider-secret-abc', 'sk-second-secret-def'].filter(s => document.documentElement.outerHTML.includes(s))`);
  try {
    await until("typeof navigate === 'function' && !!current");
    await e("navigate('providers')");
    await until(`document.querySelector('${P} [data-section=claude]')`);
    await e(`document.querySelector('${P} [data-section=claude]').click()`);
    await until(`${row(id)}`);

    // ---------- 切换前先看对比：取消就不写 ----------
    await e(`${row(id)}.querySelector('.pv-use').click()`);
    await until("document.querySelector('#pv-confirm .pv-confirm-card')");
    assert.match(await e("document.querySelector('#pv-confirm h2').textContent"), /确认改动工具配置/);
    assert.match(await e("document.querySelector('#pv-confirm .pv-confirm-head p').textContent"), /切换到「Guard QA」.*1 个配置文件/);
    assert.equal(await e("document.querySelector('#pv-confirm .pv-diff summary b').textContent"), 'settings.json');
    assert.equal(await e("document.querySelector('#pv-confirm .pv-diff-tool').textContent"), 'Claude Code');
    assert.ok(await e("[...document.querySelectorAll('#pv-confirm .pv-diff-line.add code')].some(n => n.textContent.includes('guard.invalid'))"), '新增行里有新地址');
    assert.ok(await e("[...document.querySelectorAll('#pv-confirm .pv-diff-line.del code')].some(n => n.textContent.includes('mine.invalid'))"), '删除行里有旧地址');
    assert.deepEqual(await secretsShown(), [], '对比里不能出现密钥原文');
    assert.equal(await e("document.activeElement?.textContent"), '取消', '默认焦点在取消');
    assert.ok(await e("document.querySelector('.workspace').inert"), '确认框打开时背景不可操作');
    await e("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await until("!document.querySelector('#pv-confirm')");
    await until(`[...document.querySelectorAll('#toast-stack .tp-toast')].some(t => t.textContent.includes('已取消'))`);
    assert.equal(read(), original, '取消后文件没变');

    // ---------- 确认写入 ----------
    await e(`${row(id)}.querySelector('.pv-use').click()`);
    await until("document.querySelector('#pv-confirm .btn-accent')");
    await e("document.querySelector('#pv-confirm .btn-accent').click()");
    await until(`document.querySelector('${P} .pv-current b')?.textContent === 'Guard QA'`);
    assert.match(read(), /guard\.invalid/);
    assert.match(read(), /"theme": "dark"/);
    assert.equal(await e("document.querySelector('.workspace').inert"), false);

    // ---------- 配置保护页：原件 + 修改记录 ----------
    await e(`document.querySelector('${P} .pv-nav [data-section=safety]').click()`);
    await until(`document.querySelectorAll('${P} .pv-backup').length >= 2`);
    assert.equal(await e(`document.querySelectorAll('${P} .pv-backup.original').length`), 1);
    assert.match(await e(`document.querySelector('${P} .pv-backup:not(.original) .pv-backup-head b').textContent`), /切换到「Guard QA」/);
    assert.ok(await e(`[...document.querySelectorAll('${P} .pv-backup.original button')].some(b => b.textContent.includes('恢复原件'))`));
    assert.deepEqual(await secretsShown(), [], '备份列表里不能出现密钥原文');

    // ---------- 只读保护：切换被拦，不弹确认框 ----------
    await e(`document.querySelector('${P} [data-action=readonly]').click()`);
    await until(`document.querySelector('${P} [data-action=readonly]')?.getAttribute('aria-checked') === 'true'`);
    await until("window.tokenpulse.readPrefs().then(p => p.agentReadOnly === true)");
    assert.equal(await e(`document.querySelector('${P} .pv-nav [data-section=safety] .pv-nav-badge').textContent`), '只读');
    await e(`document.querySelector('${P} [data-section=claude]').click()`);
    // 只读保护不在页面里插常驻提示条（只有菜单徽章），拦下时走右上角弹窗
    assert.equal(await e(`document.querySelector('${P} .pv-readonly-bar, ${P} .pv-feedback')`), null);
    const before = read();
    await e(`${row(secondId)}.querySelector('.pv-use').click()`);
    await until(`[...document.querySelectorAll('#toast-stack .tp-toast')].some(t => t.textContent.includes('只读保护'))`);
    assert.equal(await e("document.querySelector('#pv-confirm')"), null, '只读保护下不弹确认框');
    assert.equal(read(), before, '只读保护下文件没变');

    // 托盘切换：交给界面，同样被只读保护拦下
    wc.send('agent-activate-request', secondId);
    await delay(400);
    assert.equal(read(), before);

    // ---------- 只读保护下仍可以恢复原件（放回去），同样先确认 ----------
    await e(`document.querySelector('${P} .pv-nav [data-section=safety]').click()`);
    await until(`document.querySelector('${P} .pv-backup.original button')`);
    await e(`[...document.querySelectorAll('${P} .pv-backup.original button')].find(b => b.textContent.includes('恢复原件')).click()`);
    await until("document.querySelector('#pv-confirm .btn-accent')");
    assert.match(await e("document.querySelector('#pv-confirm .pv-confirm-head p').textContent"), /恢复到 TokenPulse 接管前/);
    await e("document.querySelector('#pv-confirm .btn-accent').click()");
    for (let i = 0; i < 50 && read() !== original; i++) await delay(60);
    assert.equal(read(), original, '恢复到接管前');
    await until(`document.querySelectorAll('${P} .pv-backup:not(.original)').length >= 2`);
    assert.match(await e(`document.querySelector('${P} .pv-backup:not(.original) .pv-backup-head b').textContent`), /恢复到 TokenPulse 接管前/, '还原本身也留记录');

    // 关掉只读保护
    await e(`document.querySelector('${P} [data-action=readonly]').click()`);
    await until("window.tokenpulse.readPrefs().then(p => p.agentReadOnly === false)");

    // ---------- 设置 → 数据 的入口 ----------
    await e("navigate('overview')");
    await e("openSettings('data')");
    await until("!document.getElementById('settings').hidden && document.getElementById('open-config-backups').offsetParent");
    await e("document.getElementById('open-config-backups').click()");
    await until(`document.getElementById('settings').hidden && document.body.dataset.page === 'providers' && document.querySelector('${P} .pv-nav-item.on')?.dataset.section === 'safety'`);

    // ---------- 托盘切换（没开只读）：弹确认框 ----------
    wc.send('agent-activate-request', secondId);
    await until("document.querySelector('#pv-confirm')");
    assert.match(await e("document.querySelector('#pv-confirm .pv-confirm-head p').textContent"), /切换到「Second QA」/);
    await e("document.querySelector('#pv-confirm .btn').click()");
    await until("!document.querySelector('#pv-confirm')");

    // ---------- 夜间模式、900px ----------
    await e(`${row(secondId)} || document.querySelector('${P} [data-section=claude]').click()`);
    await until(`${row(secondId)}`);
    await e(`${row(secondId)}.querySelector('.pv-use').click()`);
    await until("document.querySelector('#pv-confirm .pv-diff-line')");
    await e("setThemeMode('dark')"); await delay(150);
    assert.deepEqual(await e("[...document.querySelectorAll('#pv-confirm *')].filter(n => [...n.childNodes].some(c => c.nodeType === 3 && c.nodeValue.trim()) && getComputedStyle(n).color === 'rgb(0, 0, 0)').map(n => n.className)"), []);
    await e("setThemeMode('light')");
    BrowserWindow.fromWebContents(wc).setSize(900, 700); await delay(250);
    assert.ok(await e("(() => { const r = document.querySelector('#pv-confirm .pv-confirm-card').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight + 1; })()"), '窄窗口确认框不出界');
    await e("document.querySelector('#pv-confirm .btn').click()");
    await until("!document.querySelector('#pv-confirm')");
    await e(`document.querySelector('${P} .pv-nav [data-section=safety]').click()`);
    await until(`document.querySelector('${P} .pv-safety-card')`);
    assert.equal(await e(`document.querySelector('${P}').scrollWidth <= document.querySelector('${P}').clientWidth + 1`), true, '配置保护页 900px 不横向溢出');
    // ---------- 供应商页的提示一律走右上角弹窗，页面里没有常驻提示 ----------
    assert.equal(await e(`document.querySelector('${P} .pv-feedback, ${P} .pv-readonly-bar, ${P} .pv-unsaved')`), null, '供应商页里不插提示条');
    assert.ok(await e("document.querySelectorAll('#toast-stack .tp-toast').length > 0"), '提示在右上角');

    // ---------- Codex 一键 1M 上下文 ----------
    await e(`document.querySelector('${P} [data-section=codex]').click()`);
    await until(`[...document.querySelectorAll('${P} .pv-head-actions button')].some(b => b.textContent.includes('添加'))`);
    await e(`[...document.querySelectorAll('${P} .pv-head-actions button')].find(b => b.textContent.includes('添加')).click()`);
    await until(`document.querySelector('${P} [data-section=edit-models]')`);
    await e(`document.querySelector('${P} [data-section=edit-models]').click()`);
    await until(`document.querySelector('${P} [data-action=codex-1m]')`);
    const ctx = () => e(`[document.querySelector('${P} [name=codexContextWindow]').value, document.querySelector('${P} [name=codexAutoCompact]').value, document.querySelector('${P} [data-action=codex-1m]').getAttribute('aria-pressed'), document.querySelector('${P} .pv-slot:not(.pv-slot-head) input[placeholder=上下文]').value]`);
    assert.deepEqual(await ctx(), ['', '', 'false', '128000'], '默认不写，跟随 Codex');
    await e(`document.querySelector('${P} [data-action=codex-1m]').click()`);
    assert.deepEqual(await ctx(), ['1000000', '900000', 'true', '1000000'], '一键 1M：窗口 100 万、压缩阈值 90 万、模型行上下文跟着改');
    await e(`document.querySelector('${P} [data-section=edit-preview]').click()`);
    await until(`document.querySelector('${P} .pv-preview-json')?.textContent.includes('"model_context_window": 1000000')`);
    assert.match(await e(`document.querySelector('${P} .pv-preview-json').textContent`), /"model_auto_compact_token_limit": 900000/);
    await e(`document.querySelector('${P} [data-section=edit-models]').click()`);
    await until(`document.querySelector('${P} [data-action=codex-1m]')`);
    await e(`document.querySelector('${P} [data-action=codex-1m]').click()`);
    assert.deepEqual(await ctx(), ['', '', 'false', '128000'], '再点一次关掉，都恢复');
    await e(`(() => { const i = document.querySelector('${P} [name=codexContextWindow]'); i.value = '1000000'; i.dispatchEvent(new Event('input')); })()`);
    assert.equal(await e(`document.querySelector('${P} [data-action=codex-1m]').getAttribute('aria-pressed')`), 'true', '手动填 1000000 时开关同步亮起');
    // 有未保存的修改：离开时右上角弹窗询问（带按钮），不插进表单
    await e(`document.querySelector('${P} [data-section=edit-back]').click()`);
    await until("document.querySelector('#toast-stack .tp-toast.pv-unsaved')");
    assert.equal(await e(`document.querySelector('${P} .pv-editor .pv-unsaved')`), null);
    await e("[...document.querySelectorAll('.tp-toast.pv-unsaved button')].find(b => b.textContent === '放弃修改').click()");
    await until(`!document.querySelector('${P} .pv-editor')`);
    console.log('PASS agent config guard UI: masked diff confirm (Esc cancels, confirm writes), backups page with original + history, read-only blocks switch/tray without writing, restore original under read-only with confirm, settings entry, tray switch asks, dark/900px; all provider messages as top-right toasts; Codex one-click 1M context');
    clearTimeout(watchdog); app.exit(0);
  } catch (error) { console.error('FAIL', error.message); clearTimeout(watchdog); app.exit(1); }
}));
app.on('quit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 留给系统清理 */ } });
require('../build/main/index.js');
