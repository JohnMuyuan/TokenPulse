/** Boundary regressions: local fake upstreams and synthetic logs only. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-route-regression-'));
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.HOME = process.env.USERPROFILE = process.env.AGENT_SWITCH_HOME = path.join(root, 'home');
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
const { startAgentProxy } = require('../build/core/agent-proxy.js');
const ledger = require('../build/core/route-ledger.js');
const delay = ms => new Promise(r => setTimeout(r, ms));
const cases = [];
const check = (name, test) => cases.push([name, test]);
async function fixture(handler, target, work, pass = false) {
  const upstream = http.createServer((req, res) => { req.resume(); handler(req, res); });
  const logs = [], successes = [], failures = [];
  let proxy;
  try {
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    proxy = startAgentProxy({ host: '127.0.0.1', port: 0,
      targets: () => [{ id: 'qa', name: 'qa', upstream: 'anthropic', apiKey: 'synthetic-key', model: '', baseUrl, ...target }],
      log: row => logs.push(row), succeed: id => successes.push(id), fail: id => failures.push(id), open: () => false,
      pass: pass ? () => baseUrl : undefined });
    const port = await proxy.listen();
    await work({ port, logs, successes, failures, proxy });
  } finally {
    if (proxy) await proxy.close();
    upstream.closeAllConnections();
    await new Promise(r => upstream.close(r));
  }
}
function send(port, url = '/claude/v1/messages', headers = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const req = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, res => {
      const chunks = []; let done = false;
      const finish = aborted => { if (done) return; done = true; clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), aborted }); };
      res.on('data', c => chunks.push(c)); res.on('end', () => finish(false)); res.on('error', () => finish(true));
    });
    timer = setTimeout(() => { req.destroy(); reject(new Error('downstream did not finish within 1500ms')); }, 1500);
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.end(JSON.stringify({ model: 'qa', stream: true, messages: [{ role: 'user', content: 'synthetic-private-prompt' }] }));
  });
}
check('upstream abort releases active request and logs failure', async () => {
  await fixture((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {}\n\n'); setTimeout(() => res.destroy(), 20); }, {}, async ({ port, logs, proxy }) => {
    const got = await send(port); assert.equal(got.aborted, true); await delay(30);
    assert.equal(proxy.stats().active, 0); assert.equal(logs.length, 1); assert.equal(logs[0].status, 502); assert(logs[0].error);
  });
});
check('same-protocol gzip reply keeps encoding and reads usage', async () => {
  const body = 'data: {"type":"message_start","message":{"id":"msg_1234567890","model":"qa","usage":{"input_tokens":10,"output_tokens":1}}}\n\ndata: {"usage":{"output_tokens":40}}\n\n';
  const packed = zlib.gzipSync(body);
  await fixture((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'retry-after': '9' }); res.end(packed); }, {}, async ({ port, logs }) => {
    const got = await send(port, undefined, { 'accept-encoding': 'gzip' }); assert.equal(got.headers['content-encoding'], 'gzip'); assert.equal(got.headers['retry-after'], '9'); assert(got.body.equals(packed));
    await delay(30); assert.equal(logs[0].output, 40); assert.equal(logs[0].responseId, 'msg_1234567890');
  });
});
check('stream conversion preserves 400 and client error, counts failure', async () => {
  await fixture((_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"invalid tool schema"}}'); }, { upstream: 'openai-chat' }, async ({ port, logs, successes, failures, proxy }) => {
    const got = await send(port); assert.equal(got.status, 400); assert.match(got.body.toString(), /invalid tool schema/); await delay(30);
    assert.equal(proxy.stats().ok, 0); assert.equal(successes.length, 0); assert.equal(failures.length, 1); assert(logs[0].error);
  });
});
check('compressed converted stream decodes content and usage', async () => {
  const packed = zlib.gzipSync('data: {"id":"chatcmpl_1234567890","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":40}}\n\ndata: [DONE]\n\n');
  await fixture((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' }); res.end(packed); }, { upstream: 'openai-chat' }, async ({ port, logs }) => {
    const got = await send(port); assert.equal(got.status, 200); assert.equal(got.headers['content-encoding'], undefined); assert.match(got.body.toString(), /hello/); await delay(30); assert.equal(logs[0].output, 40, JSON.stringify(logs));
  });
});
check('client cancellation closes upstream and releases active count', async () => {
  for (const target of [{}, { upstream: 'openai-chat' }]) {
    let closed = false;
    await fixture((_req, res) => { res.on('close', () => { closed = true; }); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'); }, target, async ({ port, logs, proxy }) => {
      await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/claude/v1/messages', method: 'POST' }, res => { res.on('error', () => {}); res.once('data', () => { req.destroy(); resolve(); }); });
        req.on('error', reject); req.end(JSON.stringify({ model: 'qa', stream: true, messages: [] }));
      });
      await delay(40); assert(closed); assert.equal(proxy.stats().active, 0); assert.equal(logs.length, 1); assert.equal(logs[0].status, 499);
    });
  }
});
check('upstream error echoes reach client but never log prompt or token', async () => {
  for (const pass of [false, true]) {
    await fixture((_req, res) => { res.writeHead(pass ? 429 : 400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"synthetic-private-prompt Bearer synthetic-test-token"}}'); }, {}, async ({ port, logs }) => {
      const got = await send(port, pass ? '/pass/claude/v1/messages' : undefined); assert.match(got.body.toString(), /synthetic-private-prompt/); await delay(30);
      assert(logs[0].error); assert(!/synthetic-private-prompt|synthetic-test-token/.test(JSON.stringify(logs)));
      ledger.appendRouteLog(logs[0]);
      const saved = fs.readdirSync(ledger.routeLogDir()).map(name => fs.readFileSync(path.join(ledger.routeLogDir(), name), 'utf8')).join('');
      assert(!/synthetic-private-prompt|synthetic-test-token/.test(saved));
    }, pass);
  }
});
check('pool attribution needs exact response identity, not nearby time', async () => {
  const at = Date.UTC(2026, 9, 7, 12);
  ledger.appendRoute({ at, kind: 'chatgpt', account: 'chatgpt:a', responseId: 'resp_exact_a' });
  ledger.appendRoute({ at: at + 1, kind: 'chatgpt', account: 'chatgpt:b', responseId: 'resp_exact_b' });
  assert.equal(ledger.routeAccount('chatgpt', at + 1, 'resp_exact_a'), 'chatgpt:a');
  assert.equal(ledger.routeAccount('chatgpt', at, 'resp_exact_b'), 'chatgpt:b');
  assert.equal(ledger.routeAccount('chatgpt', at + 5), null);
  assert.equal(ledger.routeAccount('chatgpt', at, 'resp_unrelated'), null);
  ledger.appendRoute({ at, kind: 'chatgpt', account: 'chatgpt:b', responseId: 'resp_exact_a' });
  assert.equal(ledger.routeAccount('chatgpt', at, 'resp_exact_a'), null, 'conflicting response identities are not assigned');
  ledger.appendRouteLog({ at, app: 'codex', status: 200, account: 'chatgpt:history', responseId: 'resp_history' });
  assert.equal(ledger.routeAccount('chatgpt', at, 'resp_history'), 'chatgpt:history', 'old three-column ledger can recover precise identity from the permanent log');
});
check('third-party Grok usage stays third-party near a pool request', async () => {
  const at = Date.UTC(2026, 9, 7, 12); ledger.appendRoute({ at, kind: 'grok', account: 'grok:pool-a' });
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  write(path.join(process.env.HOME, '.grok', 'config.toml'), '[models]\ndefault = "thirdparty"\n[model.thirdparty]\nmodel = "grok-4.6"\nbase_url = "https://thirdparty.invalid/v1"\napi_key = "synthetic-key"\n');
  const rows = [{ method: 'session/update', params: { update: { sessionUpdate: 'user_message_chunk', _meta: { modelId: 'grok-4.6' } } } }, { method: '_x.ai/session/update', timestamp: at / 1000 + 5, params: { update: { sessionUpdate: 'turn_completed', prompt_id: 'unrelated', usage: { modelUsage: { 'grok-4.6-build': { inputTokens: 1000, outputTokens: 100, modelCalls: 1 } } } } } }];
  write(path.join(process.env.HOME, '.grok', 'sessions', 'qa', 'qa-session', 'updates.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  require('../build/core/usage-scan.js').scanLocalUsage();
  const query = require('../build/core/request-log.js').queryRequests({ from: '2026-01-01', to: '2026-12-31', source: 'all', status: 'all', search: '', sort: 'time', page: 0, pageSize: 50, all: true });
  assert.equal(query.rows.length, 1); assert.equal(query.rows[0].official, false); assert.equal(query.rows[0].account, null);
  // Old time-based attribution must not remain trusted in stored request rows or account-hour caches.
  const requests = require('../build/core/request-log.js');
  const monthFile = path.join(requests.requestDir(), fs.readdirSync(requests.requestDir())[0]);
  const oldRecord = JSON.parse(fs.readFileSync(monthFile, 'utf8').trim());
  oldRecord.routedAccount = 'grok:pool-a'; requests.appendRequests([oldRecord]); requests.compactRequests();
  const legacy = requests.queryRequests({ from: '2026-01-01', to: '2026-12-31', source: 'all', status: 'all', search: '', sort: 'time', page: 0, pageSize: 50, all: true });
  assert.equal(legacy.rows[0].official, false); assert.equal(legacy.rows[0].account, null);
  const scanner = require('../build/core/usage-scan.js');
  const rollups = scanner.readRollups();
  const state = Object.values(rollups.files)[0]; state.v = 9; state.accountHours = { 'grok:pool-a': {} };
  fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'usage-rollups.json'), JSON.stringify(rollups));
  scanner.scanLocalUsage(); const repaired = Object.values(scanner.readRollups().files)[0];
  assert.equal(repaired.v, 13); assert(!Object.hasOwn(repaired.accountHours || {}, 'grok:pool-a')); assert.equal(Object.values(Object.values(Object.values(repaired.days)[0])[0])[0].input, 1000);
});
check('pagination includes every equal-time row, with stable identity for old logs', async () => {
  const at = new Date(2025, 0, 15).getTime(); const file = path.join(ledger.routeLogDir(), '2025-01.jsonl'); fs.mkdirSync(path.dirname(file), { recursive: true });
  // Legacy rows have no id and identical metadata: file position must distinguish them.
  fs.writeFileSync(file, Array.from({ length: 102 }, () => JSON.stringify({ at, providerId: 'same', status: 200 })).join('\n') + '\n');
  const seen = []; let page = ledger.readRouteLog({ limit: 100, before: at + 1 }); seen.push(...page.rows); assert(page.nextCursor);
  page = ledger.readRouteLog({ limit: 100, cursor: page.nextCursor }); seen.push(...page.rows);
  assert.equal(seen.length, 102); assert.equal(new Set(seen.map(row => row.id)).size, 102); assert.equal(page.more, false);
  const reread = ledger.readRouteLog({ limit: 100, before: at + 1 }); assert.equal(reread.rows[0].id, seen[0].id);
});
(async () => {
  let failed = 0;
  try {
    for (const [name, test] of cases) { try { await test(); console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); } }
  } finally {
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`${cases.length - failed}/${cases.length} routing regression checks passed`); process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
