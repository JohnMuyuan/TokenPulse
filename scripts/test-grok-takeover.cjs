/*
 * Grok 自己换了默认模型以后，TokenPulse 设好的供应商不能丢（0.3.48，src/core/agent-switch.ts）。
 * 起因：Grok 继续旧会话 / 用 /model 时会改写 config.toml 的 [models].default；以前这一行一变，
 * 退出时就放弃接管、下次启动也不接回本地路由，Grok 一直用别的模型（Grok 4.7 或用户自己的第三方表）。
 * 另外 Grok 的上新活动（campaigns）会把新会话默认模型换成官方新型号，切到第三方时替用户记成已关闭。
 * 用一次性的 HOME 和数据目录，不碰真实的 ~/.grok 和 ~/.tokenpulse。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-grok-takeover-'));
const home = path.join(root, 'home');
process.env.HOME = process.env.USERPROFILE = home;
process.env.AGENT_SWITCH_HOME = home;
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
const grokDir = path.join(home, '.grok');
fs.mkdirSync(grokDir, { recursive: true });
const config = path.join(grokDir, 'config.toml');
const original = '[models]\ndefault_reasoning_effort = "high"\n\n[model."grok-4.6"]\nmodel = "grok-4.6"\nbase_url = "https://mine.example"\napi_key = "sk-mine"\n\n[ui]\ntheme = "dark"\n';
fs.writeFileSync(config, original);
fs.writeFileSync(path.join(grokDir, 'settings_cache.json'), JSON.stringify({ settings: { default_model: 'grok-4.7', campaigns: [{ id: 'grok-9-launch', models: { default: 'grok-9' } }, { id: 'banner-only' }] } }));
fs.writeFileSync(path.join(grokDir, 'campaigns_state.json'), JSON.stringify({ dismissed_ids: ['old-launch'] }));

const sw = require(path.join(__dirname, '..', 'build', 'core', 'agent-switch.js'));
const read = () => fs.readFileSync(config, 'utf8');
const defaultOf = text => (text.match(/\[models\][^[]*?\ndefault\s*=\s*"([^"]*)"/) || [])[1] || '';
let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };

(async () => {
  try {
    await sw.setProxyPort(17000 + Math.floor(Math.random() * 2000));
    const relay = sw.saveProvider({ app: 'grok', name: 'QA Relay', baseUrl: 'https://relay.example/v1', apiKey: 'sk-relay', model: 'grok-qa', upstream: 'openai-chat' });
    await sw.activateProvider(relay);
    assert.equal(defaultOf(read()), 'tokenpulse_route');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(grokDir, 'campaigns_state.json'), 'utf8')).dismissed_ids, ['old-launch', 'grok-9-launch']);
    pass('switching Grok to a third-party route dismisses the campaign that overrides the default model, keeping earlier dismissals');

    // Grok 继续旧会话：把默认模型换回那个会话的
    fs.writeFileSync(config, read().replace('default = "tokenpulse_route"', 'default = "grok-4.6"'));
    sw.releaseAgentSwitch(); await sw.waitAgentProxyClosed();
    assert.equal(sw.agentView().proxy.apps.grok, true, 'route stays enabled');
    assert.ok(!read().includes('tokenpulse_route'), 'exit removes the route table');
    assert.ok(read().includes('base_url = "https://mine.example"') && read().includes('theme = "dark"'), 'user tables untouched');
    pass('exit after Grok moved the default: config restored, route switch kept');

    // TokenPulse 关着的时候 Grok 又改了一次默认模型
    fs.writeFileSync(config, read().replace('default = "grok-4.6"', 'default = "grok-4.7"'));
    await sw.resumeAgentProxy();
    assert.equal(defaultOf(read()), 'tokenpulse_route');
    assert.equal(sw.agentView().providers.find(p => p.app === 'grok' && p.active)?.id, relay);
    pass('startup takes the route back even though Grok changed [models].default while TokenPulse was closed');

    // 上次没正常退出（配置还是路由的样子）、期间 Grok 换了默认模型
    fs.writeFileSync(config, read().replace('default = "tokenpulse_route"', 'default = "grok-4.6"'));
    await sw.resumeAgentProxy();
    assert.equal(defaultOf(read()), 'tokenpulse_route');
    pass('startup after an unclean exit re-points the default back to the route');

    // 真正的外部修改（换了别的地址）仍然尊重，不接管
    sw.releaseAgentSwitch(); await sw.waitAgentProxyClosed();
    fs.writeFileSync(config, read().replace('https://mine.example', 'https://other.example'));
    await sw.resumeAgentProxy();
    assert.ok(!read().includes('tokenpulse_route'));
    assert.equal(sw.agentView().proxy.apps.grok, false);
    pass('other external edits are still respected');
    console.log(`test-grok-takeover: ${checks} checks passed`);
  } finally {
    try { sw.releaseAgentSwitch(); await sw.waitAgentProxyClosed(); } catch { /* 已经关了 */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
