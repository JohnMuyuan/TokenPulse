/**
 * Grok 透明转发（src/core/agent-switch.ts 的 grok 分支）：
 * 打开时给会话服务和每个官方型号加一行本机地址、关闭原样放回去、用户自己的改动和第三方型号不动、
 * 重启后新出现的型号也接上、用了第三方地址时不能开。
 * 跑法（先 npm run compile）：node scripts/test-pass-grok.cjs
 * GROK_HOME 和数据目录都在临时文件夹里，官方接口换成本机假上游，不碰真实的 ~/.grok。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-pass-grok-'));
const home = path.join(root, 'home');
const grokHome = path.join(root, 'grok');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.AGENT_SWITCH_HOME = home;
process.env.AGENT_SWITCH_CC_DB = path.join(root, 'missing.db');
process.env.GROK_HOME = grokHome;
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_CLI_CHAT_PROXY_BASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[key];
process.env.NO_PROXY = '127.0.0.1,localhost';

const sw = require('../build/core/agent-switch');
const toml = require('../build/core/agent-toml');
const NL = String.fromCharCode(10);
const configFile = path.join(grokHome, 'config.toml');
const cacheFile = path.join(grokHome, 'models_cache.json');
const read = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const writeCache = ids => fs.writeFileSync(cacheFile, JSON.stringify({ models: Object.fromEntries(ids.map(id => [id, {}])) }));
// 按表名取键值（表名用 headerName 的写法，比如 model.grok-c）；没有这张表返回 undefined
const value = (text, table, key) => { const block = toml.parseToml(text).find(item => item.header && toml.headerName(item.header) === table); return block ? toml.readKey(block.lines, key) : undefined; };
const tables = text => toml.parseToml(text).filter(item => item.header).map(item => toml.headerName(item.header));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const send = (port, url, headers, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: url, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })); });
  req.on('error', reject); req.end(body);
});
const rejects = async (work, pattern, message) => { let error; try { await work(); } catch (caught) { error = caught; } assert.ok(error && pattern.test(error.message), message + '：' + (error ? error.message : '没有报错')); };

// 用户自己的配置：有注释、有第三方型号（不归透明转发管）
const original = ['# my grok config', '[models]', 'default_reasoning_effort = "high"', '', '[ui]', '# keep my theme', 'theme = "dark"', '', '[model."grok-c"]', 'base_url = "https://third.example/v1"', 'name = "mine"', ''].join(NL);
const officialUrl = port => `http://127.0.0.1:${port}/pass/grok`;

(async () => {
  // 假的官方：记下收到了什么；storage 可以切成失败
  const hits = [];
  let storageStatus = 200;
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      hits.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (req.url.endsWith('/storage') && storageStatus >= 400) { res.writeHead(storageStatus, { 'content-type': 'application/json' }); res.end('{"error":"boom"}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: response.completed' + NL + 'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":3}}}' + NL + NL);
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  process.env.AGENT_SWITCH_PASS_BASE = `http://127.0.0.1:${upstream.address().port}`;
  try {
    await sw.resetAgentSwitchForTests();
    const port = await freePort();
    await sw.setProxyPort(port);
    const url = officialUrl(port);
    fs.mkdirSync(grokHome, { recursive: true });
    fs.writeFileSync(configFile, original);
    writeCache(['grok-a', 'grok-b', 'grok-c']);
    assert.deepEqual(sw.agentView().pass.grok, { on: false, connected: false, blocked: '' });

    /* ---------- 打开：只加本机地址，用户的内容一个字不丢 ---------- */
    const opened = await sw.setAppPass('grok', true);
    assert.match(opened.message, /透明转发已打开/);
    const onText = read(configFile);
    assert.equal(value(onText, 'endpoints', 'cli_chat_proxy_base_url'), url, '会话服务地址指向本机');
    assert.equal(value(onText, 'model.grok-a', 'base_url'), url, '官方型号 grok-a 指向本机');
    assert.equal(value(onText, 'model.grok-b', 'base_url'), url, '官方型号 grok-b 指向本机');
    assert.equal(value(onText, 'model.grok-c', 'base_url'), 'https://third.example/v1', '第三方型号 grok-c 不动');
    for (const line of original.split(NL)) if (line.trim()) assert.ok(onText.includes(line), '原有内容还在：' + line);
    assert.deepEqual(sw.agentView().pass.grok, { on: true, connected: true, blocked: '' });

    /* ---------- 请求原样到官方；成功的 storage 不记，对话和失败的记 ---------- */
    const headers = { authorization: 'Bearer xai-TESTTOKEN', 'x-grok-conv-id': 'conv-1', 'content-type': 'application/json' };
    const body = JSON.stringify({ model: 'grok-a', stream: true, input: 'secret-text' });
    const reply = await send(port, '/pass/grok/responses', headers, body);
    assert.equal(reply.status, 200); assert.match(reply.body, /response\.completed/);
    assert.equal(hits.length, 1);
    assert.deepEqual([hits[0].url, hits[0].body], ['/grok/responses', body], '地址和请求体原样');
    assert.deepEqual([hits[0].headers.authorization, hits[0].headers['x-grok-conv-id']], ['Bearer xai-TESTTOKEN', 'conv-1'], '请求头原样');

    const storage = await send(port, '/pass/grok/storage', headers, '{"k":1}');
    assert.equal(storage.status, 200);
    assert.deepEqual([hits[1].url, hits[1].body], ['/grok/storage', '{"k":1}'], 'storage 也转发了');
    await delay(60);
    let view = sw.agentView();
    assert.deepEqual(view.logs.map(item => item.path), ['/responses'], '成功的 storage 没有记进日志，对话记了');
    assert.deepEqual([view.logs[0].pass, view.logs[0].app, view.logs[0].model, view.logs[0].status], [true, 'grok', 'grok-a', 200]);

    storageStatus = 500;
    const failed = await send(port, '/pass/grok/storage', headers, '{"k":2}');
    assert.equal(failed.status, 500);
    storageStatus = 200;
    await delay(60);
    view = sw.agentView();
    assert.deepEqual(view.logs.map(item => [item.path, item.status]), [['/storage', 500], ['/responses', 200]], '失败的 storage 记进日志');
    assert.equal(JSON.stringify(view.logs).includes('xai-TESTTOKEN'), false, '日志里没有凭据');

    /* ---------- 关闭：整个文件原样放回去 ---------- */
    const closed = await sw.setAppPass('grok', false);
    assert.match(closed.message, /恢复直连/);
    assert.equal(read(configFile), original, '关闭后配置和打开前一个字节都不差');
    view = sw.agentView();
    assert.deepEqual([view.pass.grok, view.proxy.running], [{ on: false, connected: false, blocked: '' }, false]);
    console.log('PASS pass-through grok: turning it on points the endpoint and official models at local, requests are forwarded byte for byte, only failed or chat requests are logged, off restores the file');

    /* ---------- 开着的时候用户改了配置：关闭只拿掉我们的行 ---------- */
    await sw.setAppPass('grok', true);
    fs.writeFileSync(configFile, read(configFile).replace('theme = "dark"' + NL, 'theme = "dark"' + NL + 'font_size = 14' + NL));
    await sw.setAppPass('grok', false);
    assert.equal(read(configFile), original.replace('theme = "dark"' + NL, 'theme = "dark"' + NL + 'font_size = 14' + NL), '用户新加的键留着，我们的表（endpoints、grok-a、grok-b）整张删掉');
    assert.deepEqual(tables(read(configFile)), ['models', 'ui', 'model.grok-c'], '第三方型号的表还在');
    console.log('PASS pass-through grok: edits made while it is on are kept when it is turned off');

    /* ---------- 被第三方占用时不能开 ---------- */
    const corp = ['[endpoints]', 'cli_chat_proxy_base_url = "https://corp.example/v1"', '', original].join(NL);
    fs.writeFileSync(configFile, corp);
    view = sw.agentView();
    assert.equal(view.pass.grok.on, false);
    assert.match(view.pass.grok.blocked, /别的会话服务地址/, '会话服务地址是第三方时给出说明');
    await rejects(() => sw.setAppPass('grok', true), /别的会话服务地址/, '会话服务地址是第三方时不能开');
    assert.equal(read(configFile), corp, '拒绝之后配置没有被改');
    assert.equal(sw.agentView().proxy.running, false, '拒绝之后没有留下本地路由');

    const mine = ['[models]', 'default = "mine"', '', '[model.mine]', 'base_url = "https://third.example/v1"', ''].join(NL);
    fs.writeFileSync(configFile, mine);
    view = sw.agentView();
    assert.match(view.pass.grok.blocked, /第三方地址/, '默认型号是第三方时给出说明');
    await rejects(() => sw.setAppPass('grok', true), /第三方地址/, '默认型号是第三方时不能开');
    assert.equal(read(configFile), mine, '拒绝之后配置没有被改');
    console.log('PASS pass-through grok: a third-party endpoint or default model blocks turning it on and the file is left alone');

    /* ---------- 重启后新出现的官方型号也接上 ---------- */
    fs.writeFileSync(configFile, original);
    await sw.setAppPass('grok', true);
    writeCache(['grok-a', 'grok-b', 'grok-c', 'grok-d']);
    sw.releaseAgentSwitch(); await sw.waitAgentProxyClosed();
    assert.equal(read(configFile), original, '退出时恢复直连');
    await sw.resumeAgentProxy();
    const resumed = read(configFile);
    assert.equal(value(resumed, 'model.grok-d', 'base_url'), url, '新型号 grok-d 重启后指向本机');
    assert.equal(value(resumed, 'model.grok-c', 'base_url'), 'https://third.example/v1', '第三方型号仍然不动');
    assert.deepEqual(sw.agentView().pass.grok, { on: true, connected: true, blocked: '' });
    await sw.setAppPass('grok', false);
    assert.equal(read(configFile), original, '关闭后仍然原样放回去');
    console.log('PASS pass-through grok: a model that appears after a restart is pointed at local too, and off still restores the original file');
  } finally {
    try { sw.releaseAgentSwitch(); await sw.waitAgentProxyClosed(); } catch { /* 已经关了 */ }
    upstream.close(); upstream.closeAllConnections?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
