// Synthetic pi sessions, transactional configs, and a loopback-only upstream.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-pi-'));
Object.assign(process.env, {
  TOKENPULSE_DATA_DIR: path.join(root, 'data'), AGENT_SWITCH_HOME: path.join(root, 'home'),
  AGENT_SWITCH_CC_DB: path.join(root, 'missing.db'), PI_CODING_AGENT_DIR: path.join(root, 'pi'),
  CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'),
  GROK_HOME: path.join(root, 'grok'), TOKENPULSE_DSH_HOME: path.join(root, 'dsh'),
});
const sw = require('../build/core/agent-switch');
const config = require('../build/core/agent-config');
const sessions = require('../build/core/sessions');
const { searchSessions } = require('../build/core/session-search');
const { terminalScript, replyArgs } = require('../build/main/session-reply');
const pi = process.env.PI_CODING_AGENT_DIR;
const modelsFile = path.join(pi, 'models.json'), settingsFile = path.join(pi, 'settings.json');
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
let checks = 0;
const pass = text => { checks++; console.log('PASS pi: ' + text); };

async function runPi(cli) {
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { PI_CODING_AGENT_DIR: pi, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'local'), NO_COLOR: '1' });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--print', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--tools', '', 'Reply with pi test ok.'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 25000);
    child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (code === 0 && !timedOut) resolve(out); else reject(new Error(`isolated pi exit ${code}: ${err.slice(-1500)} ${out.slice(-500)}`)); });
  });
}

(async () => {
  let gateway;
  try {
    const sessionFile = path.join(pi, 'sessions', '--D--Demo--', '2026-10-18_pi-demo.jsonl');
    const rows = [
      { type: 'session', version: 3, id: 'pi-demo', cwd: root, timestamp: '2026-10-18T09:00:00Z' },
      { type: 'model_change', id: 'a', parentId: null, modelId: 'fake-model', provider: 'test' },
      { type: 'message', id: 'b', parentId: 'a', message: { role: 'user', content: [{ type: 'text', text: '检查 pi 测试项目' }] } },
      { type: 'message', id: 'discard', parentId: 'b', message: { role: 'assistant', content: [{ type: 'text', text: 'discarded-branch-secret' }] } },
      { type: 'message', id: 'c', parentId: 'b', message: { role: 'assistant', model: 'fake-model', content: [{ type: 'thinking', thinking: 'hidden-thinking' }, { type: 'text', text: '正在检查 synthetic-pi-content' }, { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'demo.txt' } }] } },
      { type: 'message', id: 'd', parentId: 'c', message: { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'fake tool output' }], isError: false } },
      { type: 'compaction', id: 'e', parentId: 'd', summary: 'synthetic summary' },
      { type: 'session_info', id: 'f', parentId: 'e', name: 'pi 合成会话' },
    ];
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, rows.map(r => JSON.stringify({ timestamp: '2026-10-18T09:01:00Z', ...r })).join('\n') + '\n{partial');
    const summary = sessions.listSessions().find(s => s.kind === 'pi');
    assert.equal(summary.title, 'pi 合成会话'); assert.equal(summary.turns, 1); assert.equal(summary.toolCount, 1);
    const detail = sessions.getSession('pi', 'pi-demo');
    assert.equal(detail.messages.find(m => m.role === 'tool').output, 'fake tool output');
    assert.ok(!JSON.stringify(detail).includes('discarded-branch-secret')); assert.ok(!JSON.stringify(detail).includes('hidden-thinking'));
    assert.equal(searchSessions('synthetic-pi-content', 'pi').hits[0].key, 'pi:pi-demo');
    assert.equal(searchSessions('discarded-branch-secret', 'pi').hits.length, 0);
    assert.match(terminalScript('pi', 'pi-demo', root), /'--session' 'pi-demo'/); assert.throws(() => replyArgs('pi', 'x', 'readonly'));
    pass('list/detail/search use the active branch; title/model/tool result/partial line and terminal command');

    const auth = { untouched: { type: 'api_key', key: 'fake-stored-key-never-used' } };
    write(path.join(pi, 'auth.json'), auth);
    write(settingsFile, { theme: 'dark', defaultProvider: 'original', defaultModel: 'original-model', extensions: [] });
    write(modelsFile, { providers: { original: { baseUrl: 'http://127.0.0.1:1', apiKey: 'fake-original-key', models: [{ id: 'original-model' }] } } });
    const received = [];
    gateway = http.createServer((req, res) => {
      let body = ''; req.on('data', b => body += b);
      req.on('end', () => {
        received.push({ path: req.url, auth: req.headers.authorization || req.headers['x-api-key'], body: JSON.parse(body || '{}') });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
        if (pathname.endsWith('/responses')) {
          const item = { id: 'item_fake', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'pi test ok', annotations: [] }] };
          const response = { id: 'resp_fake', object: 'response', status: 'completed', model: 'fake-model', output: [item], usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
          const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
          event('response.created', { response: { ...response, status: 'in_progress', output: [] } });
          event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
          event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
          event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'pi test ok' });
          event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: 'pi test ok' });
          event('response.output_item.done', { output_index: 0, item }); event('response.completed', { response });
        } else if (pathname.endsWith('/messages')) {
          const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
          event('message_start', { message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake-model', content: [], stop_reason: null, usage: { input_tokens: 8, output_tokens: 0 } } });
          event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
          event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'pi test ok' } });
          event('content_block_stop', { index: 0 }); event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }); event('message_stop', {});
        } else {
          const chunk = (delta, finish, usage) => res.write('data: ' + JSON.stringify({ id: 'chatcmpl_fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) }) + '\n\n');
          chunk({ role: 'assistant', content: 'pi test ok' }, null); chunk({}, 'stop', { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 }); res.write('data: [DONE]\n\n');
        }
        res.end();
      });
    });
    const port = await listen(gateway);
    const free = http.createServer(); const routePort = await listen(free); await new Promise(r => free.close(r)); await sw.setProxyPort(routePort);
    const ids = {};
    for (const [upstream, api] of [['openai-chat', 'openai-completions'], ['anthropic', 'anthropic-messages'], ['openai-responses', 'openai-responses']]) {
      const id = ids[upstream] = sw.saveProvider({ app: 'pi', name: 'Fake pi ' + api, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-fake-pi-only', model: 'fake-model', upstream, contextWindow: 64000 });
      await sw.activateProvider(id);
      const p = read(modelsFile).providers.tokenpulse_route;
      assert.equal(p.api, api); assert.equal(p.models[0].id, 'fake-model'); assert.equal(p.apiKey, 'sk-fake-pi-only');
      assert.equal(read(settingsFile).defaultProvider, 'tokenpulse_route'); assert.equal(read(settingsFile).theme, 'dark');
      assert.equal(read(modelsFile).providers.original.apiKey, 'fake-original-key'); assert.deepEqual(read(path.join(pi, 'auth.json')), auth);
      assert.equal(sw.agentView().providers.find(p => p.id === id).cross, false);
    }
    pass('all three APIs switch directly, preserve other providers/settings/auth, and appear active');
    if (process.env.TOKENPULSE_TEST_PI_CLI) {
      for (const protocol of ['openai-chat', 'anthropic', 'openai-responses']) {
        await sw.activateProvider(ids[protocol]);
        assert.match(await runPi(process.env.TOKENPULSE_TEST_PI_CLI), /pi test ok/);
        assert.ok(['Bearer sk-fake-pi-only', 'sk-fake-pi-only'].includes(received.at(-1).auth));
      }
      pass('installed pi CLI sends all three APIs with fake credentials to the fake gateway');
    }
    await sw.activateProvider(ids['anthropic']);
    await sw.setAppProxy('pi', true);
    assert.equal(read(modelsFile).providers.tokenpulse_route.api, 'openai-completions');
    const base = read(modelsFile).providers.tokenpulse_route.baseUrl;
    assert.ok(base.startsWith('http://127.0.0.1:'));
    if (process.env.TOKENPULSE_TEST_PI_CLI) assert.match(await runPi(process.env.TOKENPULSE_TEST_PI_CLI), /pi test ok/);
    else {
      const response = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer PROXY_MANAGED' }, body: JSON.stringify({ model: 'fake-model', stream: true, messages: [{ role: 'user', content: 'test only' }] }) });
      assert.equal(response.status, 200); assert.match(await response.text(), /pi test ok/);
    }
    assert.equal(received.at(-1).path, '/v1/messages'); assert.equal(received.at(-1).auth, 'sk-fake-pi-only');
    const prefs = read(settingsFile); prefs.theme = 'light'; write(settingsFile, prefs);
    await sw.setAppProxy('pi', false);
    assert.equal(read(modelsFile).providers.tokenpulse_route.api, 'anthropic-messages'); assert.equal(read(settingsFile).theme, 'light');
    pass('local route converts pi Chat to Anthropic and restores direct config while preserving external changes');
    await sw.activateProvider('official-pi');
    assert.equal(read(settingsFile).defaultProvider, 'original'); assert.equal(read(settingsFile).defaultModel, 'original-model');
    assert.equal(read(settingsFile).theme, 'light'); assert.ok(!read(modelsFile).providers.tokenpulse_route); assert.deepEqual(read(path.join(pi, 'auth.json')), auth);
    pass('restore pi original defaults without changing auth.json');
    const collision = read(modelsFile); collision.providers.tokenpulse_route = { apiKey: 'fake-user-owned' }; write(modelsFile, collision);
    await assert.rejects(sw.activateProvider(ids['openai-chat']), /同名/); assert.equal(read(modelsFile).providers.tokenpulse_route.apiKey, 'fake-user-owned');
    delete collision.providers.tokenpulse_route; write(modelsFile, collision);
    write(path.join(pi, 'auth.json'), { ...auth, tokenpulse_route: { type: 'api_key', key: 'fake-shadow-key' } });
    await assert.rejects(sw.activateProvider(ids['openai-chat']), /同名.*登录/);
    assert.ok(!read(modelsFile).providers.tokenpulse_route);
    write(path.join(pi, 'auth.json'), auth);
    const specialKey = '!fake-$KEY';
    const special = sw.saveProvider({ app: 'pi', name: 'Literal key', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: specialKey, model: 'fake-model', upstream: 'openai-chat' });
    await sw.activateProvider(special);
    assert.equal(read(modelsFile).providers.tokenpulse_route.apiKey, '$!fake-$$KEY');
    assert.equal(sw.agentView().providers.find(p => p.id === special).active, true);
    if (process.env.TOKENPULSE_TEST_PI_CLI) {
      assert.match(await runPi(process.env.TOKENPULSE_TEST_PI_CLI), /pi test ok/);
      assert.equal(received.at(-1).auth, 'Bearer ' + specialKey);
    }
    await sw.activateProvider('official-pi');
    const before = fs.readFileSync(settingsFile, 'utf8');
    const preview = await config.configPreview(() => sw.activateProvider(ids['openai-chat']));
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), before); assert.ok(preview);
    config.configureReadOnly(() => true);
    try { await assert.rejects(sw.activateProvider(ids['openai-chat']), /只读/); }
    finally { config.configureReadOnly(() => false); }
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), before);
    pass('provider/auth collisions fail safely, keys remain literal, preview and read-only protection preserve files');
    console.log(`test-pi: ${checks} checks passed`);
  } finally {
    sw.releaseAgentSwitch(); await sw.waitAgentProxyClosed();
    if (gateway) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
