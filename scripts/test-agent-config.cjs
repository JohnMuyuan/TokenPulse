'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { parseTOML, getStaticTOMLValue } = require('toml-eslint-parser');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-config-regression-'));
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
process.env.AGENT_SWITCH_HOME = path.join(root, 'initial-home'); process.env.TOKENPULSE_DATA_DIR = path.join(root, 'initial-data');
const sw = require('../build/core/agent-switch');
const config = require('../build/core/agent-config');
const toml = require('../build/core/agent-toml');
const home = (...parts) => path.join(process.env.AGENT_SWITCH_HOME, ...parts);
const data = name => path.join(process.env.TOKENPULSE_DATA_DIR, name || 'agent-switch.json');
const claude = () => home('.claude', 'settings.json');
const codex = () => home('.codex', 'config.toml');
const read = f => fs.readFileSync(f, 'utf8');
const json = f => JSON.parse(read(f));
const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const obj = (f, v) => write(f, JSON.stringify(v, null, 2) + '\n');
const input = (name, options = {}) => ({ app: 'claude', name, baseUrl: 'https://' + name + '.example/v1', apiKey: 'fixture-key-' + name, model: 'fixture-model', upstream: 'anthropic', ...options });
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function relay(app = 'claude') { await sw.setProxyPort(await freePort()); await sw.setAppProxy(app, true); }
function crashSwitch(id, mode, destination) {
  const script = "const fs=require('fs'),path=require('path'); const sw=require('./build/core/agent-switch'); const rename=fs.renameSync; fs.renameSync=(from,to)=>{rename(from,to);if(" + (mode === 'commit' ? "path.basename(to)==='agent-config-pending.json'&&JSON.parse(fs.readFileSync(to,'utf8')).committed" : 'path.resolve(to)===' + JSON.stringify(path.resolve(destination))) + ")process.exit(86);};sw.activateProvider(" + JSON.stringify(id) + ").catch(()=>process.exit(87));";
  const child = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), env: process.env, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(child.status, 86, child.stderr || 'Crash injection not reached');
}
const cases = [
  ['CC Switch metadata and proxy overrides persist and expose through view', async () => {
    const id = sw.saveProvider(input('MetaQA', { app: 'claude', websiteUrl: 'https://meta.example', category: 'partner', apiKeyField: 'ANTHROPIC_API_KEY', requestHeaders: { 'x-cc-switch': '1' }, requestBody: { temperature: 0.2 }, envOverrides: { CLAUDE_CODE_DISABLE_THINKING: '1' }, dailyLimitUsd: 3.5, monthlyLimitUsd: 50, promptCacheRouting: 'enabled' }));
    const row = sw.agentView().providers.find(p => p.id === id);
    assert.equal(row.category, 'partner'); assert.equal(row.websiteUrl, 'https://meta.example'); assert.equal(row.requestHeaders['x-cc-switch'], '1'); assert.equal(row.requestBody.temperature, 0.2); assert.equal(row.envOverrides.CLAUDE_CODE_DISABLE_THINKING, '1'); assert.equal(row.promptCacheRouting, 'enabled');
  }],

  ['Saving more than 24 models rejects without truncating the provider', async () => {
    const slots = Array.from({length:25}, (_,i) => ({role:'catalog', model:'model-'+i}));
    const original = sw.agentView();
    assert.throws(() => sw.saveProvider(input('TooMany', {app:'codex',upstream:'openai-responses',slots})), /24/);
    assert.equal(sw.agentView().providers.length, original.providers.length);
  }],
  ['Quoted dotted table names stay distinct from provider hierarchy', async () => {
    const text = 'model_provider = "foo.bar"\nmodel = "old"\n[model_providers."foo.bar"]\nbase_url = "https://original.example"\nexperimental_bearer_token = "fixture-dot"\nwire_api = "responses"\n["model_providers.tokenpulse_route"]\nkeep = "unrelated"\n';
    write(codex(), text); const imported = sw.importCurrent('codex');
    assert.equal(sw.agentView().providers.find(p => p.id === imported).baseUrl, 'https://original.example');
    await sw.activateProvider(imported); const parsed = getStaticTOMLValue(parseTOML(read(codex())));
    assert.equal(parsed['model_providers.tokenpulse_route'].keep, 'unrelated'); assert.equal(parsed.model_providers['foo.bar'].experimental_bearer_token, 'fixture-dot');
  }],
  ['CC Codex API Key in auth metadata is imported without reading OAuth material', async () => {
    const file = home('cc-fixture.db'); fs.mkdirSync(path.dirname(file), { recursive: true }); const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(file);
    try { db.exec('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, category TEXT, notes TEXT, sort_index INTEGER, meta TEXT)');
      db.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('api-auth', 'codex', 'API auth', JSON.stringify({ auth: { OPENAI_API_KEY: 'fixture-import' }, config: 'model_provider = "relay"\nmodel = "fixture"\n[model_providers.relay]\nbase_url = "https://import.example"\nwire_api = "responses"\n' }), '', '', 0, '{}');
    } finally { db.close(); }
    process.env.AGENT_SWITCH_CC_DB = file; await sw.importCcProviders(); const p = sw.agentView().providers.find(p => p.id === 'cc:codex:api-auth'); assert.equal(p.hasKey, true);
    await sw.activateProvider(p.id); const parsed = getStaticTOMLValue(parseTOML(read(codex()))); assert.equal(parsed.model_providers.tokenpulse_route.experimental_bearer_token, 'fixture-import'); assert.equal(fs.existsSync(home('.codex', 'auth.json')), false);
  }],

  ['Previously imported string types migrate without corrupting Codex config', async () => {
    const id = sw.saveProvider(input('A', { app: 'codex', upstream: 'openai-responses' }));
    const state = json(data()); state.providers.find(p => p.id === id).extra = { disable_response_storage: 'false', model_context_window: '128000' }; obj(data(), state);
    await sw.activateProvider(id); const parsed = getStaticTOMLValue(parseTOML(read(codex())));
    assert.equal(parsed.disable_response_storage, false); assert.equal(parsed.model_context_window, 128000);
  }],
  ['Invalid Claude env fails without overwriting any configuration', async () => {
    const original = '{"env":"unexpected","hooks":{"keep":true}}'; write(claude(), original);
    const id = sw.saveProvider(input('A')); const state = read(data());
    await assert.rejects(sw.activateProvider(id), /env 格式/); assert.equal(read(claude()), original); assert.equal(read(data()), state);
  }],

  ['TOML quotes, multiline values, comments and CRLF stay intact', async () => {
    const text = '# keep\r\n"model" = "old" # model comment\r\ninstructions = \'\'\'\r\n[model_providers.custom]\r\nmodel = "literal"\r\n\r\n\r\nDO_NOT_TOUCH\r\n\'\'\'\r\n[model_providers.custom]\r\nname = "User owned"\r\n[mcp_servers.x]\r\ncommand = "fixture"\r\n';
    write(codex(), text); const id = sw.saveProvider(input('A', { app: 'codex', upstream: 'openai-responses', model: 'new' })); await sw.activateProvider(id);
    const result = read(codex()), parsed = getStaticTOMLValue(parseTOML(result));
    assert.equal(parsed.model, 'new'); assert.equal(parsed.model_providers.custom.name, 'User owned'); assert.equal(parsed.mcp_servers.x.command, 'fixture');
    assert.ok(result.includes('# model comment')); assert.ok(result.includes('model = "literal"\r\n\r\n\r\nDO_NOT_TOUCH'));
  }],
  ['Malformed TOML aborts before state or catalog changes', async () => {
    write(codex(), 'model = "unterminated'); const id = sw.saveProvider(input('A', { app: 'codex', upstream: 'openai-responses' })); const original = read(data());
    await assert.rejects(sw.activateProvider(id)); assert.equal(read(data()), original); assert.equal(read(codex()), 'model = "unterminated'); assert.equal(fs.existsSync(home('.codex', 'tokenpulse-model-catalog.json')), false);
  }],
  ['Codex multi-file write failure rolls back catalog, config and state', async () => {
    write(codex(), '# original\n'); write(home('.codex', 'tokenpulse-model-catalog.json'), '{"original":true}');
    const id = sw.saveProvider(input('A', { app: 'codex', upstream: 'openai-responses' })); const original = read(data()); const rename = fs.renameSync;
    fs.renameSync = (a, b) => { if (path.resolve(b) === codex()) throw new Error('injected EPERM'); return rename(a, b); };
    try { await assert.rejects(sw.activateProvider(id), /injected EPERM/); } finally { fs.renameSync = rename; }
    assert.equal(read(data()), original); assert.equal(read(codex()), '# original\n'); assert.equal(read(home('.codex', 'tokenpulse-model-catalog.json')), '{"original":true}'); assert.equal(fs.existsSync(data('agent-config-pending.json')), false);
  }],
  ['Crash after publishing config recovers state and config together', async () => {
    const a = sw.saveProvider(input('A')), b = sw.saveProvider(input('B')); await sw.activateProvider(a); const original = read(claude()); const state = read(data());
    crashSwitch(b, 'file', claude()); assert.ok(fs.existsSync(data('agent-config-pending.json')));
    sw.agentView(); assert.equal(read(claude()), original); assert.equal(read(data()), state); assert.equal(fs.existsSync(data('agent-config.lock')), false);
  }],
  ['Crash after commit preserves the successful switch', async () => {
    const a = sw.saveProvider(input('A')), b = sw.saveProvider(input('B')); await sw.activateProvider(a);
    crashSwitch(b, 'commit'); sw.agentView(); assert.equal(json(data()).direct.claude, b); assert.equal(json(claude()).env.ANTHROPIC_AUTH_TOKEN, 'fixture-key-B'); assert.equal(fs.existsSync(data('agent-config-pending.json')), false);
  }],
  ['Recovery never overwrites an external post-crash change', async () => {
    const a = sw.saveProvider(input('A')), b = sw.saveProvider(input('B')); await sw.activateProvider(a);
    crashSwitch(b, 'file', claude()); const external = '{"env":{"ANTHROPIC_BASE_URL":"https://external.example","ANTHROPIC_AUTH_TOKEN":"fixture-external"}}'; write(claude(), external);
    sw.agentView(); assert.equal(read(claude()), external); assert.equal(json(data()).direct.claude, a);
  }],
  ['Read-to-write conflict rejects transaction and preserves external bytes', async () => {
    write(claude(), '{"original":true}');
    assert.throws(() => config.configTransaction(() => { config.configRead(claude()); config.configWrite(claude(), '{"ours":true}'); write(claude(), '{"external":true}'); }), /其他程序修改/);
    assert.equal(read(claude()), '{"external":true}');
  }],
  ['Pending log cannot redirect recovery to unrelated files', async () => {
    const unrelated = home('unrelated.txt'); write(unrelated, 'after');
    obj(data('agent-config-pending.json'), { version: 1, committed: false, files: [{ file: unrelated, before: 'before', after: 'after' }] });
    try { assert.throws(() => sw.agentView(), /拒绝修改/); assert.equal(read(unrelated), 'after'); } finally { fs.unlinkSync(data('agent-config-pending.json')); }
  }],
  ['Claude restore preserves hooks and independent model edits', async () => {
    const a = sw.saveProvider(input('A')); await sw.activateProvider(a); await relay();
    const live = json(claude()); live.hooks = { userAdded: true }; live.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'user-haiku'; obj(claude(), live);
    await sw.setAppProxy('claude', false); const restored = json(claude()); assert.equal(restored.hooks.userAdded, true); assert.equal(restored.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'user-haiku'); assert.equal(restored.env.ANTHROPIC_AUTH_TOKEN, 'fixture-key-A');
  }],
  ['Codex restore preserves added MCP and original provider table', async () => {
    const original = 'model_provider = "custom"\nmodel = "old"\n[model_providers.custom]\nbase_url = "https://old.example/v1"\nexperimental_bearer_token = "fixture-old"\nwire_api = "responses"\n'; write(codex(), original);
    sw.saveProvider(input('A', { app: 'codex', upstream: 'openai-responses' })); await relay('codex'); fs.appendFileSync(codex(), '\n[mcp_servers.user]\ncommand = "fixture"\n');
    await sw.setAppProxy('codex', false); const parsed = getStaticTOMLValue(parseTOML(read(codex()))); assert.equal(parsed.model_provider, 'custom'); assert.equal(parsed.mcp_servers.user.command, 'fixture'); assert.equal(parsed.model_providers.custom.experimental_bearer_token, 'fixture-old');
  }],
  ['Owned provider table keeps user extension fields', async () => {
    const id = sw.saveProvider(input('A', { app: 'codex', upstream: 'openai-responses' })); await sw.activateProvider(id);
    fs.appendFileSync(codex(), '\nrequest_max_retries = 9 # keep extension\n'); await sw.activateProvider(id);
    const parsed = getStaticTOMLValue(parseTOML(read(codex()))); assert.equal(parsed.model_providers.tokenpulse_route.request_max_retries, 9);
  }],
  ['Desktop external profile connection is not overwritten on shutdown', async () => {
    const dir = home('Claude-3p', 'configLibrary'), profile = path.join(dir, '00000000-0000-4000-8000-000000176210.json'), meta = path.join(dir, '_meta.json');
    sw.saveProvider(input('A', { app: 'desktop', desktopMode: 'map' })); await relay('desktop'); const live = json(profile); live.inferenceGatewayBaseUrl = 'https://external.example'; live.inferenceGatewayApiKey = 'fixture-external'; obj(profile, live); const before = read(meta);
    await sw.setAppProxy('desktop', false); assert.equal(read(meta), before); assert.equal(json(profile).inferenceGatewayBaseUrl, 'https://external.example');
  }],
  ['Repeated enable does not replace the original takeover snapshot', async () => {
    await sw.activateProvider(sw.saveProvider(input('A'))); const original = read(claude()); await relay(); await sw.setAppProxy('claude', true); await sw.setAppProxy('claude', false); assert.equal(read(claude()), original);
  }],
  ['Async mutation is exclusive and occupied port changes no state', async () => {
    const id = sw.saveProvider(input('A')); const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await sw.setProxyPort(server.address().port); const original = read(data()); const pending = sw.setAppProxy('claude', true); assert.throws(() => sw.saveProvider({ ...input('A'), id }), /正在进行/); await assert.rejects(pending); assert.equal(read(data()), original); assert.equal(fs.existsSync(claude()), false); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }],
  ['Quit then startup preserves external connection changes', async () => {
    await sw.activateProvider(sw.saveProvider(input('A'))); await relay(); sw.releaseAgentSwitch(); await sw.waitAgentProxyClosed(); const external = '{"env":{"ANTHROPIC_BASE_URL":"https://external.example","ANTHROPIC_AUTH_TOKEN":"fixture-external"}}'; write(claude(), external);
    await sw.resumeAgentProxy(); assert.equal(read(claude()), external); assert.equal(sw.agentView().proxy.running, false); assert.equal(sw.agentView().proxy.apps.claude, false);
  }],
  ['Normal quit/start recaptures and restores the same direct configuration', async () => {
    await sw.activateProvider(sw.saveProvider(input('A'))); const original = read(claude()); await relay(); sw.releaseAgentSwitch(); await sw.waitAgentProxyClosed(); assert.equal(read(claude()), original); await sw.resumeAgentProxy(); assert.equal(sw.agentView().proxy.running, true); await sw.setAppProxy('claude', false); assert.equal(read(claude()), original);
  }],
  ['Unsafe legacy proxy without snapshot refuses automatic restoration', async () => {
    await sw.activateProvider(sw.saveProvider(input('A'))); await relay(); const state = json(data()); state.restore = {}; state.proxyWritten = {}; obj(data(), state); const original = read(claude());
    await assert.rejects(sw.setAppProxy('claude', false), /缺少恢复快照/); assert.equal(read(claude()), original); assert.equal(sw.agentView().proxy.running, true);
  }],
  ['Proxy close releases active downstream and upstream connections', async () => {
    let hit; const received = new Promise(resolve => { hit = resolve; }); const upstream = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {}\n\n'); hit(); });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    let request;
    try {
      const id = sw.saveProvider(input('A', { baseUrl: 'http://127.0.0.1:' + upstream.address().port })); await sw.activateProvider(id); await relay();
      request = http.request('http://127.0.0.1:' + sw.agentView().proxy.port + '/claude/v1/messages', { method: 'POST' }, res => { res.on('error', () => {}); res.resume(); }); request.on('error', () => {}); request.end('{}'); await received;
      sw.releaseAgentSwitch(); await sw.waitAgentProxyClosed(); assert.equal(sw.agentView().proxy.running, false);
    } finally { request?.destroy(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
  }],
];
(async () => {
  let failed = 0;
  try {
    for (let i = 0; i < cases.length; i++) {
      process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(root, String(i), 'home'); process.env.TOKENPULSE_DATA_DIR = path.join(root, String(i), 'data');
      await sw.resetAgentSwitchForTests();
      try { await cases[i][1](); console.log('PASS ' + cases[i][0]); }
      catch (error) { failed++; console.error('FAIL ' + cases[i][0] + ': ' + error.message); }
      finally { await sw.resetAgentSwitchForTests(); }
    }
    console.log((cases.length - failed) + '/' + cases.length + ' configuration transaction checks passed'); process.exitCode = failed ? 1 : 0;
  } finally { await sw.resetAgentSwitchForTests(); assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('tokenpulse-config-regression-')); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
