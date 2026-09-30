'use strict';
/*
 * 0.3.10 工具配置被改走的提醒（界面）：外部改了 Claude Code 的地址 → 右上角弹窗说明是谁、给「切回」→ 走对比确认 → 配置恢复；
 * 「知道了」之后同一次改动不再重复提醒。窗口保持显示（不走系统通知），临时 HOME / 数据目录。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-drift-ui-'));
process.env.TOKENPULSE_DATA_DIR = path.join(dir, 'data');
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(dir, 'home');
process.env.AGENT_SWITCH_CC_DB = path.join(dir, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'prefs.json'), JSON.stringify({ autoLaunch: false, autoUpdate: false, closeToTray: false, startMinimized: false, language: 'zh', notifyAt: 0, notifyMismatch: false, ccSwitch: false, seenVersion: require('../package.json').version, onboarding: 'done' }));
app.setPath('userData', path.join(dir, 'electron'));
const claudeFile = path.join(dir, 'home', '.claude', 'settings.json');
fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
fs.writeFileSync(claudeFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://mine.invalid', ANTHROPIC_AUTH_TOKEN: 'sk-mine' } }, null, 2) + '\n');
const sw = require('../build/core/agent-switch');
const id = sw.saveProvider({ app: 'claude', name: 'Drift QA', baseUrl: 'https://drift.invalid/v1', apiKey: 'sk-drift-qa-secret', model: 'qa-model', upstream: 'anthropic' });
const read = () => JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
const watchdog = setTimeout(() => { console.error('FAIL drift UI timed out'); app.exit(1); }, 70000);
app.on('web-contents-created', (_e, wc) => wc.once('did-finish-load', async () => {
  const e = code => wc.executeJavaScript(code).catch(err => { throw new Error(err.message + ' ← ' + String(code).slice(0, 160)); });
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const until = async (code, ms = 12000) => { const end = Date.now() + ms; while (!await e(`Promise.resolve(${code}).then(v => !!v)`)) { assert.ok(Date.now() < end, 'Timed out: ' + code); await delay(80); } };
  const toastText = "[...document.querySelectorAll('#toast-stack .tp-toast.pv-drift')].map(t => t.textContent).join('|')";
  try {
    BrowserWindow.fromWebContents(wc).show();
    await until("typeof navigate === 'function' && !!current");
    // 先用 TokenPulse 切到 Drift QA（走确认）
    await e("window.tokenpulse.agentActivate(" + JSON.stringify(id) + ").then(r => r.confirm ? window.tokenpulse.agentConfirm(r.confirm.token) : r)");
    assert.equal(read().env.ANTHROPIC_BASE_URL, 'https://drift.invalid/v1');
    await delay(5600);
    assert.equal(await e(toastText), '', '切换后没有误报');
    // 别的工具改了地址
    const changed = read(); changed.env.ANTHROPIC_BASE_URL = 'https://ccswitch.invalid'; fs.writeFileSync(claudeFile, JSON.stringify(changed, null, 2));
    await until(`${toastText}.includes('没在用「Drift QA」')`);
    const text = await e(toastText);
    assert.match(text, /Claude Code/); assert.match(text, /ccswitch\.invalid/); assert.match(text, /CC Switch/);
    assert.ok(!text.includes('sk-drift-qa-secret'), '提醒里没有密钥');
    assert.ok(await e("[...document.querySelectorAll('.tp-toast.pv-drift button')].some(b => b.textContent === '切回「Drift QA」')"));
    // 知道了：同一次改动不再提醒
    await e("[...document.querySelectorAll('.tp-toast.pv-drift button')].find(b => b.textContent === '知道了').click()");
    await until(`!${toastText}`);
    await delay(6000);
    assert.equal(await e(toastText), '', '同一次改动只提醒一次');
    // 再改一次 → 再提醒；这次点「切回」→ 对比确认 → 恢复
    changed.env.ANTHROPIC_BASE_URL = 'https://other.invalid'; fs.writeFileSync(claudeFile, JSON.stringify(changed, null, 2));
    await until(`${toastText}.includes('other.invalid')`);
    await e("[...document.querySelectorAll('.tp-toast.pv-drift button')].find(b => b.textContent.startsWith('切回')).click()");
    await until("document.querySelector('#pv-confirm .btn-accent')");
    assert.match(await e("document.querySelector('#pv-confirm .pv-confirm-head p').textContent"), /切换到「Drift QA」/);
    await e("document.querySelector('#pv-confirm .btn-accent').click()");
    for (let i = 0; i < 60 && read().env.ANTHROPIC_BASE_URL !== 'https://drift.invalid/v1'; i++) await delay(100);
    assert.equal(read().env.ANTHROPIC_BASE_URL, 'https://drift.invalid/v1', '切回成功');
    await delay(5600);
    assert.equal(await e(toastText), '', '切回后不再提醒');
    // 启动时就已经被改走：界面加载时也能拿到
    assert.deepEqual(await e('window.tokenpulse.agentDriftNow()'), []);
    console.log('PASS agent drift UI: external change → toast naming tool, live endpoint and likely cause (no secrets), "知道了" suppresses repeats, new change re-alerts, "切回" goes through diff confirm and restores, no false alarm after switching');
    clearTimeout(watchdog); app.exit(0);
  } catch (error) { console.error('FAIL', error.message); clearTimeout(watchdog); app.exit(1); }
}));
app.on('quit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 留给系统 */ } });
require('../build/main/index.js');
