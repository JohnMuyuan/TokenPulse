/*
 * 经代理连 https 上游时复用连接（0.3.38，src/core/upstream-proxy.ts）。
 * 起因：以前每个请求都重新 CONNECT + TLS 握手，经代理连官方每次约 0.6 秒，算进了透明转发的首字和总耗时。
 * 覆盖：透明转发和本地路由连续几个请求只建一条隧道、只握手一次；复用的连接刚好被关掉时换条新连接重发一次，
 * 不报 502、不算成员失败；总耗时不小于首字节。
 * 全部用本机起的假代理和假上游（测试专用的自签证书），不联网。
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-reuse-'));
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy']) delete process.env[key];
// 假上游用的是自签证书
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.removeAllListeners('warning');
const up = require('../build/core/upstream-proxy');
const { startAgentProxy } = require('../build/core/agent-proxy');

// 只给这个测试用的自签证书（CN=pass.upstream.test），不是任何真实服务的凭据
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgK/PCdWMQ2BncWJPJ
fGUDz1yvRXzRPlm/LMeMm7ZRitWhRANCAATzSSfEBBOpKlZRUfrAyqz7QMsI6Ob/
KUmifDaFNxMiancPyy0Fp9WfQOjM3vzjZd06Y1/jkCWPGFnfmqwrroTV
-----END PRIVATE KEY-----`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIBkDCCATegAwIBAgIUEfu7QijQ/3L84bHO9Ye+O8p2LmAwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwScGFzcy51cHN0cmVhbS50ZXN0MCAXDTI2MTAwODExMDU0OFoY
DzIxMjYwOTE0MTEwNTQ4WjAdMRswGQYDVQQDDBJwYXNzLnVwc3RyZWFtLnRlc3Qw
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATzSSfEBBOpKlZRUfrAyqz7QMsI6Ob/
KUmifDaFNxMiancPyy0Fp9WfQOjM3vzjZd06Y1/jkCWPGFnfmqwrroTVo1MwUTAd
BgNVHQ4EFgQUwE+Bpgx0qz+vettXW+6ltZYPgQEwHwYDVR0jBBgwFoAUwE+Bpgx0
qz+vettXW+6ltZYPgQEwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBE
AiBp+6594W6tr9ICYqxPDXXN+eni8uf/gye3X4Ozjow6sAIgcKZEMgmxxBAKBgQd
iVOpk5Z00u5petLnxhazK2YBpqo=
-----END CERTIFICATE-----`;

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });

(async () => {
  // 假上游：https，数一共握手了几次
  let handshakes = 0, served = 0;
  const upstream = https.createServer({ key: KEY, cert: CERT }, (req, res) => {
    req.resume();
    req.on('end', () => {
      served++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url.endsWith('/responses')
        ? JSON.stringify({ id: 'resp_1', object: 'response', model: 'gpt-qa', output: [], usage: { input_tokens: 3, output_tokens: 2 } })
        : JSON.stringify({ id: 'msg_1', type: 'message', model: 'claude-qa', content: [], usage: { input_tokens: 3, output_tokens: 2 } }));
    });
  });
  upstream.on('secureConnection', () => handshakes++);
  const upstreamPort = await listen(upstream);

  // 假代理：CONNECT 到哪都接到假上游。killNext 时，已有隧道上工具再发数据就直接掐断（模拟复用的连接刚好被关掉）
  const connects = [];
  let killNext = false;
  const proxy = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  proxy.on('connect', (req, client, head) => {
    connects.push(req.url);
    const server = net.connect(upstreamPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) server.write(head);
      // killNext 设上之后，第一个收到数据的一定是被复用的那条已有隧道
      client.on('data', chunk => {
        if (killNext) { killNext = false; server.destroy(); client.resetAndDestroy(); return; }
        server.write(chunk);
      });
      server.pipe(client);
    });
    server.on('error', () => client.destroy());
    client.on('error', () => server.destroy());
  });
  const proxyPort = await listen(proxy);
  process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;

  const logs = [], failed = [];
  const route = startAgentProxy({ host: '127.0.0.1', port: 0, log: entry => logs.push(entry), fail: id => failed.push(id), succeed: () => {}, open: () => false,
    targets: () => [{ id: 'pool:a', name: '号池 · A', upstream: 'openai-responses', baseUrl: 'https://route.upstream.test/v1', apiKey: 'token-a', model: '', pool: true }],
    pass: app => (app === 'claude' ? 'https://pass.upstream.test' : null) });
  const routePort = await route.listen();
  const call = (urlPath, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: routePort, method: 'POST', path: urlPath, agent: false, headers: { 'content-type': 'application/json', authorization: 'Bearer client-key' } }, res => {
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  const passCall = () => call('/pass/claude/v1/messages', { model: 'claude-qa', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  const routeCall = () => call('/grok/v1/responses', { model: 'grok-qa', input: 'hi' });

  try {
    assert.equal(up.staleReuse({ reusedSocket: true }, Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), true);
    assert.equal(up.staleReuse({ reusedSocket: false }, Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), false, '新连接上的错误照常报');
    assert.equal(up.staleReuse({ reusedSocket: true }, Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), false, '超时不重发');
    pass('staleReuse: only a reset on a reused connection counts as stale');

    /* ---------- 透明转发 ---------- */
    for (let i = 0; i < 3; i++) {
      const result = await passCall();
      assert.equal(result.status, 200, result.body); assert.match(result.body, /msg_1/);
    }
    assert.deepEqual(connects, ['pass.upstream.test:443'], '三个请求只建了一条隧道：' + JSON.stringify(connects));
    assert.equal(handshakes, 1, '只握手一次');
    for (const entry of logs) { assert.equal(entry.status, 200); assert.ok(entry.ms >= (entry.firstByteMs || 0), '总耗时不小于首字节'); }
    pass('pass-through via proxy: three requests share one CONNECT tunnel and one TLS handshake');

    killNext = true;
    let result = await passCall();
    assert.equal(result.status, 200, '复用的连接被掐断：换条新连接重发，工具拿到正常回复 ' + result.body);
    assert.equal(killNext, false, '确实掐断了一次');
    assert.equal(connects.length, 2, '重发时新建了一条隧道');
    assert.equal(logs.at(-1).status, 200); assert.equal(logs.at(-1).error, undefined);
    pass('pass-through: a reused connection that was just closed is resent once on a new one');

    /* ---------- 本地路由 ---------- */
    const before = connects.length;
    for (let i = 0; i < 2; i++) { result = await routeCall(); assert.equal(result.status, 200, result.body); }
    assert.equal(connects.length, before + 1, '本地路由两个请求也只建一条隧道');
    killNext = true;
    result = await routeCall();
    assert.equal(result.status, 200, result.body);
    assert.equal(killNext, false);
    assert.deepEqual(failed, [], '重发成功，不算成员失败');
    assert.equal(logs.at(-1).status, 200); assert.equal(logs.at(-1).attempt, 1, '还是第一次尝试，没有换成员');
    pass('local route via proxy: connections are reused, and a stale one is resent without failing the member');

    console.log(`${checks}/${checks} proxy reuse checks passed`);
  } catch (error) {
    console.error('FAIL', error);
    process.exitCode = 1;
  } finally {
    await route.close();
    await close(proxy);
    await close(upstream);
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
})();
