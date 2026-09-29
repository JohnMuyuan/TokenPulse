const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-agent-'));
const home = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.AGENT_SWITCH_HOME = home;
process.env.AGENT_SWITCH_CC_DB = path.join(root, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];

const sw = require('../build/core/agent-switch');
const conv = require('../build/core/agent-convert');

const read = file => fs.readFileSync(file, 'utf8');
const claudeFile = path.join(home, '.claude', 'settings.json');
const codexFile = path.join(home, '.codex', 'config.toml');
const grokFile = path.join(home, '.grok', 'config.toml');

(async () => {
  const chat = conv.convertRequest('anthropic', 'openai-chat', JSON.stringify({
    model: 'claude-sonnet-5', max_tokens: 32, system: 'be brief',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    tools: [{ name: 'read', description: 'read', input_schema: { type: 'object' } }],
  }), 'gpt-test');
  assert.equal(chat.path, '/v1/chat/completions');
  assert.equal(chat.json.model, 'gpt-test');
  assert.equal(chat.json.messages[1].content, 'ping');
  assert.equal(chat.json.tools[0].function.name, 'read');
  const back = conv.convertJsonResponse('anthropic', 'openai-chat', {
    choices: [{ message: { role: 'assistant', content: 'pong', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  }, 'claude-sonnet-5');
  assert.equal(back.content[0].text, 'pong');
  assert.equal(back.content[1].name, 'read');
  assert.equal(back.content[1].input.p, 1);
  assert.equal(back.usage.output_tokens, 2);
  const bridge = new conv.StreamBridge('openai-chat', 'anthropic', 'claude-sonnet-5');
  const sse = bridge.push('data: {"choices":[{"delta":{"content":"你"}}]}\n\n') + bridge.push('data: {"choices":[{"finish_reason":"stop"}]}\n\n') + bridge.end();
  assert.match(sse, /你/);
  assert.match(sse, /message_stop/);
  const responses = conv.convertRequest('openai-responses', 'anthropic', JSON.stringify({ model: 'gpt', input: 'hello', stream: true }), 'claude-sonnet-5');
  assert.equal(responses.path, '/v1/messages');
  assert.equal(responses.json.messages[0].content[0].text, 'hello');
  console.log('PASS agent convert: anthropic/chat/responses text and tool call');
  const models = require('../build/core/agent-models');
  const roleEnv = models.claudeRoleEnv([
    { role: 'sonnet', model: 'kimi-k2', displayName: 'Kimi', oneM: true, contextWindow: null, reasoningLevels: [], defaultReasoningLevel: '' },
    { role: 'haiku', model: 'kimi-fast', displayName: '快', oneM: false, contextWindow: null, reasoningLevels: [], defaultReasoningLevel: '' },
  ], 'kimi-k2');
  assert.equal(roleEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, 'kimi-k2[1M]');
  assert.equal(roleEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'kimi-fast');
  assert.equal(roleEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'kimi-k2');
  const catalog = models.codexCatalogEntry({ role: 'catalog', model: 'deepseek-v4', displayName: 'DeepSeek', oneM: false, contextWindow: 64000, reasoningLevels: ['xhigh', 'low', 'bogus'], defaultReasoningLevel: 'xhigh' }, null, 0);
  assert.deepEqual(catalog.supported_reasoning_levels.map(item => item.effort), ['low', 'xhigh']);
  assert.equal(catalog.default_reasoning_level, 'xhigh');
  const mapped = models.desktopModelMap([
    { role: 'sonnet', model: 'kimi-k2', displayName: 'Kimi', oneM: false, contextWindow: null, reasoningLevels: [], defaultReasoningLevel: '' },
  ], 'map');
  assert.equal(mapped['claude-sonnet-5'], 'kimi-k2');
  console.log('PASS agent models: Claude roles, Codex reasoning levels, Desktop mapping');

  await sw.resetAgentSwitchForTests();
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.writeFileSync(claudeFile, JSON.stringify({ hooks: { keep: true }, permissions: { allow: ['Read'] }, env: { ANTHROPIC_API_KEY: 'old-key', ANTHROPIC_BASE_URL: 'https://old.example', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_ARTIFACT: '1' } }, null, 2));
  const first = sw.saveProvider({ app: 'claude', name: 'Relay', baseUrl: 'https://relay.example/v1', apiKey: 'sk-real', model: 'claude-sonnet-5', upstream: 'anthropic' });
  const enabled = await sw.activateProvider(first);
  assert.match(enabled.message, /Relay/);
  let claude = JSON.parse(read(claudeFile));
  assert.equal(claude.hooks.keep, true);
  assert.deepEqual(claude.permissions.allow, ['Read']);
  assert.equal(claude.env.DISABLE_TELEMETRY, '1');
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, 'sk-real');
  assert.equal(claude.env.ANTHROPIC_BASE_URL, 'https://relay.example/v1');
  assert.equal(claude.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(sw.agentView().providers.find(item => item.id === first).hasKey, true);
  assert.equal(JSON.stringify(sw.agentView()).includes('sk-real'), false, '界面数据不能带密钥');
  console.log('PASS agent switch: claude key fields replaced, hooks and user env kept');
  const beforeEdit = read(claudeFile);
  assert.throws(() => sw.saveProvider({ id: first, app: 'claude', name: 'Relay', baseUrl: 'https://relay.example/v1', keepKey: true, model: 'gpt-test', upstream: 'openai-chat' }), /本地路由/, '当前直连供应商不能静默改成不兼容协议');
  assert.equal(read(claudeFile), beforeEdit);
  assert.equal(sw.agentView().providers.find(item => item.id === first).upstream, 'anthropic');
  assert.throws(() => sw.saveProvider({ app: 'desktop', name: 'Loop', baseUrl: 'http://127.0.0.1:15721/desktop', apiKey: 'test', model: 'test', upstream: 'anthropic' }), /本地路由/);


  fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  fs.writeFileSync(codexFile, '# keep me\nmodel = "old"\n\n[mcp_servers.fetch]\ncommand = "uvx"\n');
  const codex = sw.saveProvider({ app: 'codex', name: 'Codex Relay', baseUrl: 'https://codex.example/v1', apiKey: 'sk-codex', model: 'gpt-test', upstream: 'openai-responses' });
  await sw.activateProvider(codex);
  const toml = read(codexFile);
  assert.match(toml, /# keep me/);
  assert.match(toml, /\[mcp_servers\.fetch\]/);
  assert.match(toml, /command = "uvx"/);
  assert.match(toml, /experimental_bearer_token = "sk-codex"/);
  assert.match(toml, /requires_openai_auth = false/);
  assert.doesNotMatch(toml, /auth\.json/);

  // 用户不用 Gemini：不能再加 Gemini CLI / Gemini 上游的供应商；旧数据里的 Gemini 条目读入时丢掉，也不碰 ~/.gemini
  assert.throws(() => sw.saveProvider({ app: 'gemini', name: 'Gem', baseUrl: 'https://gem.example', apiKey: 'gk', model: 'gemini-test', upstream: 'gemini' }));
  assert.throws(() => sw.saveProvider({ app: 'claude', name: 'Gem', baseUrl: 'https://gem.example', apiKey: 'gk', model: 'gemini-test', upstream: 'gemini' }));
  {
    const storeFile = path.join(process.env.TOKENPULSE_DATA_DIR, 'agent-switch.json');
    const saved = JSON.parse(read(storeFile));
    saved.providers.push(
      { id: 'old-gemini', app: 'gemini', name: 'Old Gemini', endpoint: { baseUrl: 'https://gem.example', apiKey: 'gk', model: 'g', upstream: 'gemini' } },
      { id: 'old-claude-gemini', app: 'claude', name: 'Claude via Gemini', endpoint: { baseUrl: 'https://gem.example', apiKey: 'gk', model: 'g', upstream: 'gemini' } },
    );
    saved.route = { ...saved.route, gemini: 'old-gemini' };
    saved.proxy.apps.gemini = true;
    fs.writeFileSync(storeFile, JSON.stringify(saved));
    const view = sw.agentView();
    assert.ok(!view.providers.some(item => item.app === 'gemini' || item.id === 'old-claude-gemini'), '旧的 Gemini 供应商要丢掉');
    assert.equal('gemini' in view.proxy.apps, false);
    assert.equal(fs.existsSync(path.join(home, '.gemini')), false, '不能碰 ~/.gemini');
  }

  fs.mkdirSync(path.dirname(grokFile), { recursive: true });
  fs.writeFileSync(grokFile, '[model.mine]\nmodel = "keep"\nbase_url = "https://mine.example"\n');
  const grok = sw.saveProvider({ app: 'grok', name: 'Grok Relay', baseUrl: 'https://grok.example/v1', apiKey: 'sk-grok', model: 'grok-test', upstream: 'openai-responses' });
  await sw.activateProvider(grok);
  const grokText = read(grokFile);
  assert.match(grokText, /\[model\.mine\]/);
  assert.match(grokText, /model = "keep"/);
  assert.match(grokText, /\[model\.tokenpulse_route\]/);
  assert.match(grokText, /api_key = "sk-grok"/);
  console.log('PASS agent switch: codex and grok keep unrelated config; Gemini rejected and dropped from old data');

  const hit = { body: '', auth: '', url: '' };
  const bad = listen((_req, res) => { res.writeHead(503); res.end('nope'); });
  const good = listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      hit.body = Buffer.concat(chunks).toString('utf8');
      hit.auth = req.headers.authorization || req.headers['x-api-key'] || '';
      hit.url = req.url || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] }));
    });
  });
  const [down, up] = await Promise.all([bad, good]);
  const port = await freePort();
  await sw.setProxyPort(port);
  const cross = sw.saveProvider({ app: 'claude', name: 'Chat Upstream', baseUrl: `http://127.0.0.1:${up.port}/v1`, apiKey: 'sk-up', model: 'gpt-test', upstream: 'openai-chat' });
  const spare = sw.saveProvider({ app: 'claude', name: 'Down', baseUrl: `http://127.0.0.1:${down.port}/v1`, apiKey: 'sk-down', model: 'gpt-test', upstream: 'openai-chat' });
  await sw.activateProvider(spare);
  sw.setFailover(cross, true);
  const response = await fetch(`http://127.0.0.1:${sw.agentView().proxy.port}/claude/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'PROXY_MANAGED' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.content[0].text, 'pong');
  assert.equal(hit.auth, 'Bearer sk-up');
  assert.match(hit.url, /chat\/completions/);
  assert.equal(JSON.parse(hit.body).messages.at(-1).content, 'ping');
  const live = JSON.parse(read(claudeFile));
  assert.equal(live.env.ANTHROPIC_AUTH_TOKEN, 'PROXY_MANAGED');
  assert.match(live.env.ANTHROPIC_BASE_URL, /127\.0\.0\.1/);
  assert.equal(live.hooks.keep, true);
  assert.equal(JSON.stringify(live).includes('sk-up'), false);
  sw.releaseAgentSwitch();
  const restored = JSON.parse(read(claudeFile));
  assert.equal(restored.hooks.keep, true);
  assert.equal(restored.env.ANTHROPIC_AUTH_TOKEN, 'sk-real');
  assert.equal(restored.env.ANTHROPIC_BASE_URL, 'https://relay.example/v1');
  await sw.setAppProxy('claude', false);
  const official = sw.agentView().providers.find(item => item.app === 'claude' && item.official);
  await sw.activateProvider(official.id);
  claude = JSON.parse(read(claudeFile));
  assert.equal(claude.hooks.keep, true);
  assert.equal(claude.env.DISABLE_TELEMETRY, '1');
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(claude.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(claude.env.CLAUDE_CODE_DISABLE_ARTIFACT, '1');
  down.server.close();
  up.server.close();
  console.log('PASS agent proxy: failover, format conversion, placeholder key, restore on quit');

  const dbFile = path.join(root, 'cc.db');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, category TEXT, notes TEXT, sort_index INTEGER, meta TEXT)");
  const settings = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://imported.example', ANTHROPIC_AUTH_TOKEN: 'sk-import', ANTHROPIC_MODEL: 'claude-haiku-4-5' } });
  db.prepare('INSERT INTO providers (id, app_type, name, settings_config, category, notes, sort_index, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('abc', 'claude', 'Imported', settings, '', '', 3, '{}');
  db.close();
  process.env.AGENT_SWITCH_CC_DB = dbFile;
  const imported = await sw.importCcProviders();
  assert.equal(imported.added, 1);
  const card = sw.agentView().providers.find(item => item.name === 'Imported');
  assert.equal(card.baseUrl, 'https://imported.example');
  assert.equal(card.hasKey, true);
  assert.equal(JSON.stringify(sw.agentView()).includes('sk-import'), false);
  console.log('PASS agent import: CC Switch providers copied without exposing the key');
})().catch(error => {
  console.error('FAIL', error);
  process.exit(1);
});

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
function freePort() {
  return new Promise(resolve => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
