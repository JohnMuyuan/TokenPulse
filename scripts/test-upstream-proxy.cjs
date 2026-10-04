/*
 * 本地路由往上游发请求时走代理（src/core/upstream-proxy.ts）。
 * 起因：需要代理才能访问官方接口的机器上，本地路由一律直连，号池每个成员都连接超时、转发记录里一排 502。
 * 覆盖：按环境变量选代理、NO_PROXY、本机地址不走代理、系统代理兜底（PAC 结果解析、缓存）、
 * 明文上游经代理、https 上游用 CONNECT 建隧道（代理拒绝时的报错）、本地路由整条链路经代理转发、网络错误说明。
 * 全部用本机起的假代理和假上游，不联网。
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-upproxy-'));
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy']) delete process.env[key];
const up = require('../build/core/upstream-proxy');
const { startAgentProxy, fetchUpstreamModels, probeUrl } = require('../build/core/agent-proxy');

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });

(async () => {
  const seen = [];
  // 假代理：明文请求（绝对地址）自己回一个 JSON；CONNECT 按 connectStatus 回
  let connectStatus = 403;
  const proxy = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      seen.push({ method: req.method, url: req.url, host: req.headers.host, auth: req.headers['proxy-authorization'] || '', authorization: req.headers.authorization || '', body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url.endsWith('/models') ? JSON.stringify({ data: [{ id: 'm-1' }, { id: 'm-2' }] }) : JSON.stringify({ id: 'resp_1', output: [], usage: { input_tokens: 3, output_tokens: 2 } }));
    });
  });
  proxy.on('connect', (req, socket) => { seen.push({ method: 'CONNECT', url: req.url, host: req.headers.host, auth: req.headers['proxy-authorization'] || '' }); socket.end(`HTTP/1.1 ${connectStatus} X\r\n\r\n`); });
  const proxyPort = await listen(proxy);
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  try {
    /* ---------- 选代理 ---------- */
    const U = s => new URL(s);
    assert.equal(up.envProxyFor(U('https://api.example.com/v1'), {}), null, '没设就直连');
    assert.deepEqual(up.envProxyFor(U('https://api.example.com/v1'), { HTTPS_PROXY: 'http://127.0.0.1:7890' }), { host: '127.0.0.1', port: 7890 });
    assert.deepEqual(up.envProxyFor(U('https://api.example.com/v1'), { https_proxy: '10.0.0.2:8080' }), { host: '10.0.0.2', port: 8080 }, '小写、不带协议头也认');
    assert.deepEqual(up.envProxyFor(U('http://api.example.com/v1'), { HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2' }), { host: 'b', port: 2 }, 'http 目标看 HTTP_PROXY');
    assert.deepEqual(up.envProxyFor(U('https://api.example.com/'), { ALL_PROXY: 'http://c:3' }), { host: 'c', port: 3 }, 'ALL_PROXY 兜底');
    assert.equal(up.envProxyFor(U('https://api.example.com/'), { ALL_PROXY: 'socks5://c:3' }), null, 'SOCKS 暂不支持：直连');
    assert.equal(up.envProxyFor(U('https://api.example.com/'), { HTTPS_PROXY: 'http://user:p%40ss@h:9' }).auth, 'Basic ' + Buffer.from('user:p@ss').toString('base64'), '代理的用户名密码');
    for (const local of ['http://127.0.0.1:17621/grok/v1', 'http://localhost:8080/', 'http://[::1]:9/']) assert.equal(up.envProxyFor(U(local), { HTTP_PROXY: 'http://a:1', ALL_PROXY: 'http://a:1' }), null, '本机地址永远直连：' + local);
    for (const [noProxy, target, bypass] of [['.example.com', 'https://api.example.com/', true], ['example.com', 'https://api.example.com/', true], ['*.example.com', 'https://example.com/', true], ['other.com', 'https://api.example.com/', false], ['*', 'https://api.example.com/', true], ['api.example.com:8443', 'https://api.example.com/', false], ['api.example.com:443', 'https://api.example.com/', true]])
      assert.equal(up.envProxyFor(U(target), { HTTPS_PROXY: 'http://a:1', NO_PROXY: noProxy }) === null, bypass, `NO_PROXY=${noProxy} → ${target}`);
    assert.deepEqual(up.parsePacResult('PROXY 127.0.0.1:7890; DIRECT'), { host: '127.0.0.1', port: 7890 });
    assert.equal(up.parsePacResult('DIRECT'), null); assert.equal(up.parsePacResult('SOCKS5 127.0.0.1:1080; DIRECT'), null); assert.equal(up.parsePacResult(''), null);
    assert.deepEqual(up.parsePacResult('SOCKS 1.1.1.1:1; HTTP 2.2.2.2:3128'), { host: '2.2.2.2', port: 3128 }, '跳过不支持的，取第一个能用的');
    // 系统代理：环境变量没有时才问；结果缓存；环境变量优先
    let asked = 0;
    up.setSystemProxyResolver(async url => { asked++; return url.startsWith('https://sys.example.com') ? 'PROXY 9.9.9.9:99' : 'DIRECT'; });
    assert.deepEqual(await up.proxyFor(U('https://sys.example.com/a')), { host: '9.9.9.9', port: 99 });
    assert.deepEqual(await up.proxyFor(U('https://sys.example.com/b')), { host: '9.9.9.9', port: 99 }); assert.equal(asked, 1, '同一个主机 30 秒内只问一次');
    assert.equal(await up.proxyFor(U('https://direct.example.com/')), null);
    assert.equal(await up.proxyFor(U('http://127.0.0.1:1/')), null); assert.equal(asked, 2, '本机地址不问系统代理');
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
    assert.deepEqual(await up.proxyFor(U('https://sys.example.com/a')), { host: '127.0.0.1', port: 1 }, '环境变量优先于系统代理');
    delete process.env.HTTPS_PROXY;
    up.setSystemProxyResolver(async () => { throw new Error('boom'); });
    assert.equal(await up.proxyFor(U('https://sys2.example.com/')), null, '问系统代理出错就直连');
    // 给 curl 的 --proxy：curl 自己读环境变量、不读系统代理。环境变量里有（哪怕是 SOCKS）就不插手；没有、系统代理开着才补
    up.setSystemProxyResolver(async url => (url.includes('direct.example.com') ? 'DIRECT' : 'PROXY 10.1.1.1:8888'));
    assert.deepEqual(await up.curlProxyArgs('https://chatgpt.example.com/backend'), ['--proxy', 'http://10.1.1.1:8888'], '只开了系统代理');
    assert.deepEqual(await up.curlProxyArgs('https://direct.example.com/'), [], '系统说直连');
    assert.deepEqual(await up.curlProxyArgs('http://127.0.0.1:17621/x'), [], '本机地址');
    assert.deepEqual(await up.curlProxyArgs('not a url'), []);
    for (const [name, value] of [['HTTPS_PROXY', 'http://127.0.0.1:7890'], ['ALL_PROXY', 'socks5://127.0.0.1:1080'], ['https_proxy', 'http://127.0.0.1:7890']]) {
      process.env[name] = value; assert.deepEqual(await up.curlProxyArgs('https://chatgpt.example.com/backend'), [], name + ' 设了：curl 自己会用，不加 --proxy'); delete process.env[name];
    }
    process.env.NO_PROXY = 'chatgpt.example.com'; assert.deepEqual(await up.curlProxyArgs('https://chatgpt.example.com/backend'), [], 'NO_PROXY 里的不加'); delete process.env.NO_PROXY;
    // Node 自己发的请求：环境变量里是 SOCKS（不支持）时不改用系统代理，免得和 curl 走的路不一样
    process.env.ALL_PROXY = 'socks5://127.0.0.1:1080'; assert.equal(await up.proxyFor(U('https://chatgpt.example.com/')), null); delete process.env.ALL_PROXY;
    up.setSystemProxyResolver(null);
    assert.deepEqual(await up.curlProxyArgs('https://chatgpt.example.com/backend'), [], '没有系统代理解析器（比如工作进程里）就不加');
    pass('proxy selection: env vars like curl, NO_PROXY, loopback always direct, SOCKS skipped, system proxy fallback with cache, --proxy for curl only when just the system proxy is on');

    /* ---------- 错误说明 ---------- */
    const aggregate = Object.assign(new AggregateError([Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' })], ''), { code: 'ETIMEDOUT' });
    assert.equal(aggregate.message, '', 'Node 的这种错误 message 是空的');
    assert.match(up.describeNetError(aggregate), /^连接上游超时（没有走代理；需要代理的话，请打开系统代理或设置 HTTPS_PROXY 环境变量后重启 TokenPulse）$/);
    assert.equal(up.describeNetError(aggregate, true), '连接上游超时', '已经走了代理就不提示设代理');
    assert.match(up.describeNetError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), /DNS 解析失败/);
    assert.match(up.describeNetError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), /上游拒绝了连接/);
    assert.equal(up.describeNetError(new Error('socket hang up')), 'socket hang up');
    assert.equal(up.describeNetError(Object.assign(new AggregateError([new Error('a'), new Error('b')], ''), {})), 'a；b');
    pass('network errors are described (AggregateError with an empty message included)');

    /* ---------- 经代理发请求 ---------- */
    process.env.HTTP_PROXY = proxyUrl; process.env.HTTPS_PROXY = `http://user:secret@127.0.0.1:${proxyPort}`;
    assert.deepEqual(await fetchUpstreamModels('http://models.upstream.test/v1', 'sk-x'), ['m-1', 'm-2']);
    assert.deepEqual({ ...seen.at(-1), body: undefined }, { method: 'GET', url: 'http://models.upstream.test/v1/models', host: 'models.upstream.test', auth: '', authorization: 'Bearer sk-x', body: undefined }, '明文上游：完整地址交给代理，Host 是上游');
    // https 上游：CONNECT 上游:443，带代理的用户名密码；代理拒绝时把原因说清楚
    const probe = await probeUrl('https://secure.upstream.test/v1/models');
    assert.deepEqual(seen.at(-1), { method: 'CONNECT', url: 'secure.upstream.test:443', host: 'secure.upstream.test:443', auth: 'Basic ' + Buffer.from('user:secret').toString('base64') });
    assert.equal(probe.ok, false); assert.match(probe.error, new RegExp(`代理 127\\.0\\.0\\.1:${proxyPort} 拒绝了连接（HTTP 403）`));
    // 代理连不上
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    assert.match((await probeUrl('https://secure.upstream.test/')).error, /连不上代理 127\.0\.0\.1:9/);
    // NO_PROXY 里的上游不经代理（.invalid 域名解析失败，说明确实没去找代理）
    process.env.HTTPS_PROXY = proxyUrl; process.env.NO_PROXY = 'tokenpulse-direct.invalid';
    const before = seen.length;
    const direct = await probeUrl('https://tokenpulse-direct.invalid/');
    assert.equal(seen.length, before); assert.equal(direct.ok, false); assert.match(direct.error, /没有走代理/);
    delete process.env.NO_PROXY;
    pass('requests via proxy: absolute URI for http, CONNECT tunnel with proxy auth for https, clear errors when the proxy refuses or is unreachable, NO_PROXY bypass');

    /* ---------- 本地路由整条链路 ---------- */
    const logs = [];
    const route = startAgentProxy({ host: '127.0.0.1', port: 0, targets: () => [{ id: 'pool:a', name: '号池 · A', upstream: 'openai-responses', baseUrl: 'http://grok.upstream.test/v1', apiKey: 'token-a', model: '', pool: true }], log: entry => logs.push(entry), fail: () => {}, succeed: () => {}, open: () => false });
    const routePort = await route.listen();
    const call = () => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: routePort, method: 'POST', path: '/grok/v1/responses', headers: { 'content-type': 'application/json', authorization: 'Bearer client-key' } }, res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() })); });
      req.on('error', reject); req.end(JSON.stringify({ model: 'grok-4.6', input: 'hi' }));
    });
    let result = await call();
    assert.equal(result.status, 200, result.body); assert.match(result.body, /resp_1/);
    assert.equal(seen.at(-1).url, 'http://grok.upstream.test/v1/responses', '客户端 → 本地路由（直连本机）→ 代理 → 上游');
    assert.equal(seen.at(-1).authorization, 'Bearer token-a', '认证换成这个成员的');
    assert.equal(logs.at(-1).status, 200);
    // 没有代理、上游连不上：502，转发记录里有原因（以前是空的）
    delete process.env.HTTP_PROXY; delete process.env.HTTPS_PROXY;
    result = await call();
    assert.equal(result.status, 502);
    assert.equal(logs.at(-1).status, 502); assert.ok(logs.at(-1).error && /没有走代理/.test(logs.at(-1).error), '转发记录写明原因：' + JSON.stringify(logs.at(-1).error));
    await route.close();
    pass('local route end to end: client → route → proxy → upstream with member auth; without a proxy the 502 carries a reason');

    console.log(`${checks}/${checks} upstream proxy checks passed`);
  } catch (error) {
    console.error('FAIL', error);
    process.exitCode = 1;
  } finally {
    await close(proxy);
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
})();
