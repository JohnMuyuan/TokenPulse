/*
 * 0.3.10 工具配置被改走的检测：Grok 继续旧会话换回旧模型（直连 / 本地路由两种）、Claude 被别的工具改了地址；
 * 工具自己改无关设置不算；用户明确「切回」时本地路由能重新接上，关闭路由后恢复到接管前。
 * 临时 HOME / 数据目录，不碰真实配置。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-drift-'));
const home = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.AGENT_SWITCH_HOME = home;
process.env.AGENT_SWITCH_CC_DB = path.join(root, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
const sw = require('../build/core/agent-switch');
const grokFile = path.join(home, '.grok', 'config.toml');
const claudeFile = path.join(home, '.claude', 'settings.json');
const original = '[models]\ndefault = "mine"\ndefault_reasoning_effort = "high"\n\n[model.mine]\nmodel = "grok-4.7"\nbase_url = "https://relay.invalid"\napi_key = "sk-mine-000000"\napi_backend = "responses"\n';
fs.mkdirSync(path.dirname(grokFile), { recursive: true });
fs.writeFileSync(grokFile, original);
fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
fs.writeFileSync(claudeFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://old.invalid', ANTHROPIC_AUTH_TOKEN: 'sk-old' }, theme: 'dark' }, null, 2) + '\n');
const read = file => fs.readFileSync(file, 'utf8');
// Grok「继续旧会话」：把 [models].default 改回会话记住的模型
const resumeOld = () => fs.writeFileSync(grokFile, read(grokFile).replace(/^default = "tokenpulse_route"$/m, 'default = "mine"'));

(async () => {
  const port = await new Promise(resolve => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const v = s.address().port; s.close(() => resolve(v)); }); });
  try {
    await sw.setProxyPort(port);
    assert.deepEqual(sw.agentDrift(), [], '没切换过的工具不报');

    // ---- Grok 直连 ----
    const direct = sw.saveProvider({ app: 'grok', name: '直连 QA', baseUrl: 'https://direct.invalid/v1', apiKey: 'sk-direct-qa', model: 'grok-qa', upstream: 'openai-responses' });
    const done = await sw.activateProvider(direct);
    assert.match(done.message, /继续旧会话.*\/model tokenpulse_route/, '切换 Grok 时提示旧会话的坑');
    assert.match(read(grokFile), /^default = "tokenpulse_route"$/m);
    assert.match(read(grokFile), /^name = "TokenPulse · 直连 QA"$/m, '/model 列表里能认出 TokenPulse 的路由');
    assert.deepEqual(sw.agentDrift(), []);
    resumeOld();
    let drift = sw.agentDrift();
    assert.equal(drift.length, 1);
    assert.deepEqual({ app: drift[0].app, mode: drift[0].mode, expectedId: drift[0].expectedId, expectedName: drift[0].expectedName }, { app: 'grok', mode: 'direct', expectedId: direct, expectedName: '直连 QA' });
    assert.match(drift[0].liveName, /mine|切换前/, '说清楚现在连的是谁：' + drift[0].liveName);
    const firstKey = drift[0].key;
    assert.equal(sw.agentDrift()[0].key, firstKey, '同一次改动指纹不变（只提醒一次）');
    await sw.activateProvider(direct); // 切回
    assert.deepEqual(sw.agentDrift(), [], '切回后不再报');

    // ---- Grok 本地路由（接口格式不同，走路由）----
    const routed = sw.saveProvider({ app: 'grok', name: '路由 QA', baseUrl: 'https://route.invalid/v1', apiKey: 'sk-route-qa', model: 'grok-qa', upstream: 'openai-chat' });
    await sw.activateProvider(routed);
    assert.match(read(grokFile), new RegExp(`base_url = "http://127\\.0\\.0\\.1:${port}/grok/v1"`));
    assert.deepEqual(sw.agentDrift(), []);
    resumeOld();
    drift = sw.agentDrift();
    assert.equal(drift.length, 1); assert.equal(drift[0].mode, 'route'); assert.equal(drift[0].expectedId, routed);
    // 以前这里会报「工具连接已在外部修改，请先关闭此路由」：现在用户明确切回就重新接上
    await sw.activateProvider(routed);
    assert.match(read(grokFile), /^default = "tokenpulse_route"$/m);
    assert.deepEqual(sw.agentDrift(), []);
    // 关闭路由：恢复到这次切换之前（直连 QA 那份），不会留下路由
    await sw.setAppProxy('grok', false);
    assert.doesNotMatch(read(grokFile), /127\.0\.0\.1/);
    assert.deepEqual(sw.agentDrift(), []);

    // ---- Claude：别的工具改了地址算；Claude 自己改主题 / 权限不算 ----
    const claude = sw.saveProvider({ app: 'claude', name: 'Claude QA', baseUrl: 'https://claude.invalid', apiKey: 'sk-claude-qa', model: 'claude-qa', upstream: 'anthropic' });
    await sw.activateProvider(claude);
    assert.deepEqual(sw.agentDrift(), []);
    const settings = JSON.parse(read(claudeFile));
    settings.theme = 'light'; settings.permissions = { allow: ['Bash(ls)'] }; settings.model = 'opus';
    fs.writeFileSync(claudeFile, JSON.stringify(settings, null, 2));
    assert.deepEqual(sw.agentDrift(), [], 'Claude Code 自己改设置、/model 选模型不算被改走');
    settings.env.ANTHROPIC_BASE_URL = 'https://ccswitch.invalid';
    fs.writeFileSync(claudeFile, JSON.stringify(settings, null, 2));
    drift = sw.agentDrift();
    assert.equal(drift.length, 1); assert.equal(drift[0].app, 'claude'); assert.match(drift[0].liveName, /ccswitch\.invalid/);
    await sw.activateProvider(claude);
    assert.deepEqual(sw.agentDrift(), []);
    console.log('PASS agent drift: Grok resumed-session revert detected (direct + route), fingerprint stable, explicit switch-back re-applies route, route close restores, Grok /model name, Claude address change detected but unrelated settings ignored');
  } finally {
    await sw.resetAgentSwitchForTests?.().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error('FAIL', error); process.exit(1); });
