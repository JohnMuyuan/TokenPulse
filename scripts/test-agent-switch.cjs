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
  // 限额没填（表单送来空串、或者旧数据里是 null）就是不限，不能被 Number() 变成 0；填了 0 才是 0
  {
    const limited = sw.saveProvider({ app: 'claude', name: 'Limits', baseUrl: 'https://limits.example/v1', apiKey: 'sk-l', model: 'claude-sonnet-5', upstream: 'anthropic', dailyLimitUsd: '', monthlyLimitUsd: '25' });
    const row = sw.agentView().providers.find(item => item.id === limited);
    assert.equal(row.dailyLimitUsd, null, '空限额重新读出来还是不限');
    assert.equal(row.monthlyLimitUsd, 25);
    const zero = sw.saveProvider({ id: limited, app: 'claude', name: 'Limits', baseUrl: 'https://limits.example/v1', keepKey: true, model: 'claude-sonnet-5', upstream: 'anthropic', dailyLimitUsd: '0', monthlyLimitUsd: '  ' });
    const again = sw.agentView().providers.find(item => item.id === zero);
    assert.equal(again.dailyLimitUsd, 0); assert.equal(again.monthlyLimitUsd, null);
    sw.deleteProvider(limited);
  }
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

  // 0.3.26：旧对话记着创建时的 model_provider；配置里没有那张表，Codex 就打不开旧对话（Model provider 'custom' not found）
  {
    const sessions = path.join(path.dirname(codexFile), 'sessions', '2026', '10', '01');
    fs.mkdirSync(sessions, { recursive: true }); fs.mkdirSync(path.join(path.dirname(codexFile), 'archived_sessions'), { recursive: true });
    const meta = name => JSON.stringify({ timestamp: '2026-10-01T00:00:00Z', type: 'session_meta', payload: { id: name, cwd: 'D:/x', model_provider: name } }) + '\n';
    for (const name of ['custom', 'openai', 'tokenpulse_route', 'mine']) fs.writeFileSync(path.join(sessions, `rollout-${name}.jsonl`), meta(name));
    fs.writeFileSync(path.join(path.dirname(codexFile), 'archived_sessions', 'rollout-old.jsonl'), meta('old relay'));
    fs.writeFileSync(codexFile, read(codexFile) + '\n[model_providers.mine]\nname = "Mine"\nbase_url = "https://mine.example/v1"\n');
    const table = (text, name) => (text.split(/\n(?=\[)/).find(part => part.startsWith(`[model_providers.${name}]`)) || '');
    await sw.activateProvider(codex);
    let now = read(codexFile);
    // 正在用 TokenPulse 的供应商：补的表指向同一个地址，旧对话能接着聊
    for (const name of ['custom', '"old relay"']) {
      assert.match(table(now, name), /name = "TokenPulse \(earlier chats\)"/, name);
      assert.match(table(now, name), /base_url = "https:\/\/codex\.example\/v1"/); assert.match(table(now, name), /experimental_bearer_token = "sk-codex"/); assert.match(table(now, name), /requires_openai_auth = false/);
    }
    assert.equal(table(now, 'openai'), '', '内置的不补');
    assert.match(table(now, 'mine'), /name = "Mine"\nbase_url = "https:\/\/mine\.example\/v1"/, '用户自己的表不动');
    assert.match(table(now, 'tokenpulse_route'), /name = "TokenPulse"\n/);
    await sw.activateProvider(codex);
    assert.equal(read(codexFile), now, '再切一次不会越补越多');
    // 切回官方登录：补的表改成走官方登录；tokenpulse_route 自己也有旧对话，同样补上
    await sw.activateProvider(sw.agentView().providers.find(item => item.app === 'codex' && item.official).id);
    now = read(codexFile);
    assert.doesNotMatch(now, /^model_provider\s*=/m); assert.doesNotMatch(now, /sk-codex|codex\.example/);
    for (const name of ['custom', '"old relay"', 'tokenpulse_route']) assert.match(table(now, name), /name = "TokenPulse \(earlier chats\)"\nwire_api = "responses"\nrequires_openai_auth = true/, name);
    assert.match(table(now, 'mine'), /name = "Mine"/);
    // 启动修复：表被别的工具删了会补回来；那个名字的对话都删了之后，补的表也跟着删
    fs.writeFileSync(codexFile, now.replace(table(now, 'custom'), ''));
    assert.equal(table(read(codexFile), 'custom'), '');
    assert.equal(sw.repairAgentConfigs().length, 1);
    assert.match(table(read(codexFile), 'custom'), /TokenPulse \(earlier chats\)/);
    assert.deepEqual(sw.repairAgentConfigs(), []);
    fs.rmSync(path.join(sessions, 'rollout-custom.jsonl'));
    assert.equal(sw.repairAgentConfigs().length, 1);
    assert.equal(table(read(codexFile), 'custom'), ''); assert.match(table(read(codexFile), '"old relay"'), /earlier chats/);
    // 配置被别的工具换成了它自己的中转站（表名 custom）、TokenPulse 那张表没了：启动时照抄现在生效的那张表补回来
    fs.writeFileSync(codexFile, ['model_provider = "custom"', 'model = "relay-model"', '', '[model_providers.custom]', 'name = "Relay"', 'base_url = "https://relay.example/v1"', 'wire_api = "responses"', 'experimental_bearer_token = "sk-relay"', ''].join(String.fromCharCode(10)));
    fs.writeFileSync(path.join(sessions, 'rollout-custom.jsonl'), meta('custom'));
    assert.equal(sw.repairAgentConfigs().length, 1);
    now = read(codexFile);
    assert.match(table(now, 'custom'), /name = "Relay"/, '别的工具写的表不动');
    for (const name of ['tokenpulse_route', '"old relay"']) { assert.match(table(now, name), /name = "TokenPulse \(earlier chats\)"/, name); assert.match(table(now, name), /base_url = "https:\/\/relay\.example\/v1"/); assert.match(table(now, name), /experimental_bearer_token = "sk-relay"/); assert.doesNotMatch(table(now, name), /name = "Relay"/); }
    assert.deepEqual(sw.repairAgentConfigs(), [], '补过就不再改');
    fs.rmSync(path.join(path.dirname(codexFile), 'sessions'), { recursive: true }); fs.rmSync(path.join(path.dirname(codexFile), 'archived_sessions'), { recursive: true });
    await sw.activateProvider(codex);
    assert.doesNotMatch(read(codexFile), /earlier chats/, '没有旧对话就一张都不留');
    console.log('PASS agent switch: earlier Codex chats keep a provider table (mirrors the active route, official stub, own tables untouched, repair, cleanup)');
  }

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

  const hit = { body: '', auth: '', url: '', header: '' };
  const bad = listen((_req, res) => { res.writeHead(503); res.end('nope'); });
  const good = listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      hit.body = Buffer.concat(chunks).toString('utf8');
      hit.auth = req.headers.authorization || req.headers['x-api-key'] || '';
      hit.header = req.headers['x-cc-switch'] || '';
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
  sw.saveProvider({ id: cross, app: 'claude', name: 'Chat Upstream', baseUrl: `http://127.0.0.1:${up.port}/v1`, apiKey: 'sk-up', model: 'gpt-test', upstream: 'openai-chat', requestHeaders: { 'x-cc-switch': '1' }, requestBody: { temperature: 0.2 } });
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
  assert.equal(JSON.parse(hit.body).temperature, 0.2);
  assert.equal(hit.header, '1');
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

  // 号池（0.3.9）：同一工具的多个官方账号轮流用；官方接口换成本机假上游（AGENT_SWITCH_POOL_BASE 只给测试用）
  {
    const now = Date.now();
    const account = (kind, ref, token, extra = {}) => ({ id: `${kind}:${ref}`, kind, ref, email: `${ref}@example.com`, label: ref, createdAt: now, lastSeenAt: now, credential: { token, expiresAt: now + 3_600_000, ...extra } });
    fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'official-accounts.json'), JSON.stringify({ version: 2, active: {}, accounts: [
      account('claude', 'qa-a', 'oauth-token-a'), account('claude', 'qa-b', 'oauth-token-b'), account('claude', 'qa-old', 'oauth-token-old', { expiresAt: now - 60_000 }),
      account('chatgpt', 'qa-c', 'oauth-token-c', { accountId: 'ws-qa' }), account('grok', 'qa-g', 'oauth-token-g'),
    ] }));
    const hits = [];
    const fake = await listen((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const hit = { url: req.url, auth: req.headers.authorization || '', apiKey: req.headers['x-api-key'] || '', beta: req.headers['anthropic-beta'] || '', account: req.headers['chatgpt-account-id'] || '', originator: req.headers.originator || '', body: Buffer.concat(chunks).toString('utf8') };
        hits.push(hit);
        // 账号 A 的登录失效：401，号池要换下一个成员而不是把错误还给 CLI
        if (hit.auth === 'Bearer oauth-token-a' && hits.filter(h => h.auth === hit.auth).length > 1) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"expired"}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }));
      });
    });
    process.env.AGENT_SWITCH_POOL_BASE = `http://127.0.0.1:${fake.port}`;
    try {
      assert.throws(() => sw.saveProvider({ app: 'desktop', name: 'Desk Pool', pool: { members: [{ type: 'account', id: 'claude:qa-a' }] } }), /桌面端不支持号池/);
      assert.throws(() => sw.saveProvider({ app: 'claude', name: 'Empty Pool', pool: { members: [] } }), /至少要有一个成员/);
      assert.throws(() => sw.saveProvider({ app: 'claude', name: 'Wrong Pool', pool: { members: [{ type: 'account', id: 'chatgpt:qa-c' }] } }), /找不到的官方账号/);
      assert.throws(() => sw.saveProvider({ app: 'claude', name: 'Wrong Pool', pool: { members: [{ type: 'provider', id: codex }] } }), /同一工具/);
      const pool = sw.saveProvider({ app: 'claude', name: 'Claude 号池', pool: { strategy: 'round-robin', members: [{ type: 'account', id: 'claude:qa-a' }, { type: 'account', id: 'claude:qa-old' }, { type: 'account', id: 'claude:qa-b' }] } });
      assert.throws(() => sw.saveProvider({ id: pool, app: 'claude', name: 'Claude 号池', baseUrl: 'https://x.example', apiKey: 'k', model: 'm', upstream: 'anthropic' }), /不能互相转换/);
      assert.throws(() => sw.setFailover(pool, true), /不进入备用队列/);
      await sw.activateProvider(pool);
      const live = JSON.parse(read(claudeFile));
      assert.equal(live.env.ANTHROPIC_AUTH_TOKEN, 'PROXY_MANAGED', '号池只能经本地路由');
      assert.equal(JSON.stringify(live).includes('TOKENPULSE_POOL') || JSON.stringify(live).includes('oauth-token'), false, '工具配置里不能有号池占位或账号凭据');
      const send = () => fetch(`http://127.0.0.1:${sw.agentView().proxy.port}/claude/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'PROXY_MANAGED', 'anthropic-beta': 'claude-code-20250219' }, body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }) });
      for (let i = 0; i < 2; i++) assert.equal((await send()).status, 200);
      assert.deepEqual(hits.map(h => h.auth), ['Bearer oauth-token-a', 'Bearer oauth-token-b'], '轮询：两次请求用两个账号；过期的账号跳过');
      assert.ok(hits.every(h => !h.apiKey && h.beta.split(',').includes('oauth-2025-04-20') && h.beta.includes('claude-code-20250219')), '官方账号：Bearer + 补上 OAuth beta，保留 CLI 自己的 beta，不带 x-api-key');
      assert.equal(JSON.parse(hits[0].body).model, 'claude-sonnet-5', '号池没指定模型时按 CLI 选的模型发');
      hits.length = 0;
      hits.push({ auth: 'Bearer oauth-token-a' }); // 让假上游对 A 回 401
      assert.equal((await send()).status, 200, 'A 失效时换 B，CLI 收到成功');
      assert.deepEqual(hits.slice(1).map(h => h.auth), ['Bearer oauth-token-a', 'Bearer oauth-token-b']);
      const view = sw.agentView().providers.find(item => item.id === pool);
      assert.equal(JSON.stringify(sw.agentView()).includes('oauth-token'), false, '界面数据不能带账号凭据');
      assert.deepEqual(view.pool.members.map(m => [m.id, m.usable]), [['claude:qa-a', true], ['claude:qa-old', false], ['claude:qa-b', true]]);
      assert.ok(view.pool.members[2].requests >= 2 && view.pool.members[0].lastStatus === 401);
      // 用满再换：总是从第一个能用的开始
      sw.saveProvider({ id: pool, app: 'claude', name: 'Claude 号池', pool: { strategy: 'fill-first', members: [{ type: 'account', id: 'claude:qa-b' }, { type: 'account', id: 'claude:qa-a' }] } });
      hits.length = 0;
      for (let i = 0; i < 2; i++) await send();
      assert.deepEqual(hits.map(h => h.auth), ['Bearer oauth-token-b', 'Bearer oauth-token-b']);
      // Codex：ChatGPT 的 Codex 接口没有 /v1、要工作区 id、只收流式且不存储
      const codexPool = sw.saveProvider({ app: 'codex', name: 'Codex 号池', pool: { members: [{ type: 'account', id: 'chatgpt:qa-c' }] } });
      await sw.activateProvider(codexPool);
      hits.length = 0;
      await fetch(`http://127.0.0.1:${sw.agentView().proxy.port}/codex/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer PROXY_MANAGED' }, body: JSON.stringify({ model: 'gpt-qa', input: 'hi', store: true, max_output_tokens: 5, previous_response_id: 'resp_1' }) });
      const codexHit = hits[0], codexBody = JSON.parse(codexHit.body);
      assert.equal(codexHit.url, '/codex/responses');
      assert.equal(codexHit.auth, 'Bearer oauth-token-c'); assert.equal(codexHit.account, 'ws-qa'); assert.equal(codexHit.originator, 'codex_cli_rs');
      assert.equal(codexBody.stream, true); assert.equal(codexBody.store, false); assert.equal(codexBody.instructions, '');
      assert.equal('max_output_tokens' in codexBody || 'previous_response_id' in codexBody, false);
      assert.equal(read(codexFile).includes('oauth-token'), false);
      // 0.3.29 Grok：Grok CLI 对号池（自定义模型）不让选思考等级，请求里也不带；号池里选的那一档由本地路由补上
      {
        const { applyReasoningEffort } = require('../build/core/agent-proxy');
        const apply = (body, effort = 'high') => JSON.parse(applyReasoningEffort(Buffer.from(JSON.stringify(body)), effort).toString('utf8'));
        assert.deepEqual(apply({ model: 'g', reasoning: { summary: 'concise' } }).reasoning, { summary: 'concise', effort: 'high' }, '保留 summary');
        assert.deepEqual(apply({ model: 'g', reasoning: { effort: 'low' } }).reasoning, { effort: 'low' }, '请求自己带了就不动');
        assert.equal(apply({ model: 'g', messages: [] }).reasoning_effort, 'high'); assert.equal('reasoning' in apply({ model: 'g', messages: [] }), false);
        assert.deepEqual(apply({ input: 'no model' }), { input: 'no model' });
        const grokPool = sw.saveProvider({ app: 'grok', name: 'Grok 号池', model: 'grok-qa', pool: { reasoningEffort: 'xhigh', members: [{ type: 'account', id: 'grok:qa-g' }] } });
        assert.equal(sw.agentView().providers.find(item => item.id === grokPool).pool.reasoningEffort, 'xhigh');
        assert.equal(sw.agentView().providers.find(item => item.id === codexPool).pool.reasoningEffort, undefined, '别的工具的号池没有这一项');
        await sw.activateProvider(grokPool);
        // 号池的上下文窗口：没填就不写 context_window（Grok 按 200K 算），填了就写进 Grok 的配置
        assert.doesNotMatch(read(grokFile), /context_window/);
        sw.saveProvider({ id: grokPool, app: 'grok', name: 'Grok 号池', model: 'grok-qa', contextWindow: 500000, pool: { reasoningEffort: 'xhigh', members: [{ type: 'account', id: 'grok:qa-g' }] } });
        assert.equal(sw.agentView().providers.find(item => item.id === grokPool).contextWindow, 500000);
        await sw.activateProvider(grokPool);
        assert.match(read(grokFile), /context_window = 500000/);
        const sendGrok = async body => { hits.length = 0; await fetch(`http://127.0.0.1:${sw.agentView().proxy.port}/grok/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer PROXY_MANAGED' }, body: JSON.stringify(body) }); return JSON.parse(hits[0].body); };
        assert.deepEqual((await sendGrok({ model: 'grok-qa', input: 'hi', reasoning: { summary: 'concise' } })).reasoning, { summary: 'concise', effort: 'xhigh' });
        assert.equal(hits[0].auth, 'Bearer oauth-token-g');
        assert.deepEqual((await sendGrok({ model: 'grok-qa', input: 'hi', reasoning: { effort: 'low' } })).reasoning, { effort: 'low' });
        sw.saveProvider({ id: grokPool, app: 'grok', name: 'Grok 号池', model: 'grok-qa', pool: { reasoningEffort: 'bogus', members: [{ type: 'account', id: 'grok:qa-g' }] } });
        assert.equal('reasoning' in (await sendGrok({ model: 'grok-qa', input: 'hi' })), false, '没选等级就原样转发');
        // 0.3.34 路由账本：号池成功交给了哪个官方账号都记下来（统计用量时归到它名下）；失败的、换下一个成员之前的那次不记
        const ledger = fs.readFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'route-ledger.jsonl'), 'utf8').trim().split(String.fromCharCode(10)).map(line => line.split(String.fromCharCode(9)));
        assert.ok(ledger.every(row => row.length === 3 && Number(row[0]) > Date.now() - 600000 && row[2].startsWith(row[1] + ':')), '每行：时间、哪家、账号 id');
        const byAccount = ledger.reduce((map, row) => ({ ...map, [row[2]]: (map[row[2]] || 0) + 1 }), {});
        assert.equal(byAccount['grok:qa-g'], 3, 'Grok 号池的三次请求');
        assert.equal(byAccount['chatgpt:qa-c'], 1); assert.ok(byAccount['claude:qa-b'] >= 2 && byAccount['claude:qa-a'] >= 1);
        assert.equal(Object.keys(byAccount).some(id => id.includes('qa-old')), false, '登录过期的成员没有被用到');
        assert.equal(fs.readFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'route-ledger.jsonl'), 'utf8').includes('oauth-token'), false, '账本里没有凭据');
        // 永久保存的转发记录：每一次转发（包括失败后换下一个成员的那次）一行，带转发的细节，不带内容和凭据
        const logDir = path.join(process.env.TOKENPULSE_DATA_DIR, 'route-log');
        const logText = fs.readdirSync(logDir).map(name => fs.readFileSync(path.join(logDir, name), 'utf8')).join('');
        const routeLog = logText.trim().split(String.fromCharCode(10)).map(line => JSON.parse(line));
        assert.equal(logText.includes('oauth-token') || logText.includes('PROXY_MANAGED') || logText.includes('"hi"'), false, '记录里没有凭据，也没有请求内容');
        const grokLog = routeLog.filter(row => row.app === 'grok');
        assert.equal(grokLog.length, 3);
        assert.deepEqual(Object.fromEntries(['method', 'path', 'attempt', 'pool', 'client', 'upstream', 'stream', 'requestModel', 'effort', 'status', 'account'].map(key => [key, grokLog[0][key]])),
          { method: 'POST', path: '/v1/responses', attempt: 1, pool: true, client: 'openai-responses', upstream: 'openai-responses', stream: false, requestModel: 'grok-qa', effort: 'xhigh', status: 200, account: 'grok:qa-g' }, '第一条：号池替它补上了 xhigh');
        assert.equal(grokLog[1].effort, 'low', '请求自己带的等级照实记'); assert.equal(grokLog[2].effort, undefined);
        assert.ok(grokLog.every(row => row.host && row.requestBytes > 0 && row.ms >= 0 && row.at > Date.now() - 600000 && row.providerId && row.provider));
        const retried = routeLog.filter(row => row.app === 'claude' && row.status === 401);
        assert.ok(retried.length >= 1 && retried.every(row => row.attempt === 1 && row.error && !row.account), '失败的那次也记，写明是第几次尝试和报错');
        assert.ok(routeLog.some(row => row.app === 'claude' && row.attempt === 2 && row.status === 200), '换到下一个成员成功的那次是第 2 次尝试');
        console.log('PASS agent pool: the permanent route log has one detailed line per attempt (member, model, effort, status, timing, sizes) and no content or credentials');
        console.log('PASS agent pool: every request a pool hands to an official account is written to the route ledger, without credentials');
        console.log('PASS agent pool: Grok reasoning effort added by the local route when the request has none');
      }
      console.log('PASS agent pool: round-robin, fill-first, expired accounts skipped, 401 moves on, Claude OAuth beta, Codex backend path/body/workspace, no credentials in config or view, validation');
    } finally {
      delete process.env.AGENT_SWITCH_POOL_BASE;
      sw.releaseAgentSwitch();
      await sw.setAppProxy('claude', false); await sw.setAppProxy('codex', false);
      fake.server.close();
    }
  }

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
