/*
 * 0.3.9 Codex 整体上下文：一键 1M 写 config.toml 顶层 model_context_window / model_auto_compact_token_limit（整数），
 * 清空就删掉；校验范围和「压缩阈值 < 窗口」；用户自己的其他 Codex 设置不动。临时 HOME，不碰真实配置。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-codex-context-'));
const home = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.AGENT_SWITCH_HOME = home;
process.env.AGENT_SWITCH_CC_DB = path.join(root, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
const sw = require('../build/core/agent-switch');
const codexFile = path.join(home, '.codex', 'config.toml');
fs.mkdirSync(path.dirname(codexFile), { recursive: true });
fs.writeFileSync(codexFile, '# 我的设置\napproval_policy = "on-request"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n');
const base = { app: 'codex', name: 'Codex 1M', baseUrl: 'https://codex.invalid/v1', apiKey: 'sk-codex-test', model: 'gpt-qa', upstream: 'openai-responses', slots: [{ role: 'catalog', model: 'gpt-qa', displayName: 'gpt-qa', contextWindow: 1000000, reasoningLevels: ['high'], defaultReasoningLevel: 'high' }] };

(async () => {
  try {
    const id = sw.saveProvider({ ...base, codexContextWindow: 1000000, codexAutoCompact: 900000 });
    let view = sw.agentView().providers.find(p => p.id === id);
    assert.equal(view.codexContextWindow, 1000000);
    assert.equal(view.codexAutoCompact, 900000);
    await sw.activateProvider(id);
    let text = fs.readFileSync(codexFile, 'utf8');
    assert.match(text, /^model_context_window = 1000000$/m, '整数，不加引号');
    assert.match(text, /^model_auto_compact_token_limit = 900000$/m);
    assert.match(text, /# 我的设置/); assert.match(text, /approval_policy = "on-request"/); assert.match(text, /\[mcp_servers\.docs\]/);
    const catalog = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'tokenpulse-model-catalog.json'), 'utf8'));
    assert.equal(catalog.models[0].context_window, 1000000, '模型目录里的上下文也是 1M');

    // 改成自定义值
    sw.saveProvider({ ...base, id, keepKey: true, apiKey: '', codexContextWindow: 400000, codexAutoCompact: '' });
    text = fs.readFileSync(codexFile, 'utf8');
    assert.match(text, /^model_context_window = 400000$/m);
    assert.doesNotMatch(text, /model_auto_compact_token_limit/, '清空的阈值从配置里删掉');

    // 关掉：两项都不写，跟随 Codex 默认
    sw.saveProvider({ ...base, id, keepKey: true, apiKey: '', codexContextWindow: null, codexAutoCompact: null });
    text = fs.readFileSync(codexFile, 'utf8');
    assert.doesNotMatch(text, /model_context_window|model_auto_compact_token_limit/);
    view = sw.agentView().providers.find(p => p.id === id);
    assert.equal(view.codexContextWindow, null);

    // 不带这两个字段的保存（其他入口）不动原来的设置
    sw.saveProvider({ ...base, id, keepKey: true, apiKey: '', codexContextWindow: 1000000, codexAutoCompact: 900000 });
    sw.saveProvider({ ...base, id, keepKey: true, apiKey: '', name: 'Codex 1M renamed' });
    assert.equal(sw.agentView().providers.find(p => p.id === id).codexContextWindow, 1000000);

    // 校验
    assert.throws(() => sw.saveProvider({ ...base, codexContextWindow: 1000000, codexAutoCompact: 1000000 }), /小于上下文窗口/);
    assert.throws(() => sw.saveProvider({ ...base, codexContextWindow: 20000000 }), /1000 到 10000000/);
    assert.throws(() => sw.saveProvider({ ...base, codexContextWindow: 1.5e5 + 0.5 }), /整数/);
    console.log('PASS codex context: one-click 1M writes model_context_window / auto-compact as integers, custom values, clearing removes keys, other saves keep it, user settings untouched, validation');
  } finally {
    await sw.resetAgentSwitchForTests?.().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error('FAIL', error); process.exit(1); });
