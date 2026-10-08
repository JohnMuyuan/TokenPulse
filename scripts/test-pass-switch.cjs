/**
 * 透明转发的开关（src/core/agent-switch.ts 的 setAppPass 一组）：
 * 打开只在工具配置里加一行、关闭原样放回去、退出还原 / 启动恢复、和供应商切换互斥、仍然算官方登录。
 * 跑法（先 npm run compile）：node scripts/test-pass-switch.cjs
 * 工具配置和数据目录都在临时文件夹里，官方接口换成本机假上游。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-pass-'));
const home = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.AGENT_SWITCH_HOME = home;
process.env.AGENT_SWITCH_CC_DB = path.join(root, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[key];
process.env.NO_PROXY = '127.0.0.1,localhost';

const sw = require('../build/core/agent-switch');
const ledger = require('../build/core/route-ledger');
const NL = String.fromCharCode(10);
const read = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const claudeFile = path.join(home, '.claude', 'settings.json');
const codexFile = path.join(home, '.codex', 'config.toml');
const storeFile = path.join(process.env.TOKENPULSE_DATA_DIR, 'agent-switch.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const send = (port, url, headers, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: url, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })); });
  req.on('error', reject); req.end(body);
});
const rejects = async (work, pattern, message) => { let error; try { await work(); } catch (caught) { error = caught; } assert.ok(error && pattern.test(error.message), message + '：' + (error ? error.message : '没有报错')); };

(async () => {
  // 假的官方：记下收到了什么，回一段带用量的流式回复
  const hits = [];
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      hits.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start' + NL + 'data: {"type":"message_start","message":{"usage":{"input_tokens":900,"output_tokens":1}}}' + NL + NL);
      await delay(80);
      res.write('event: content_block_delta' + NL + 'data: {"type":"content_block_delta","delta":{"text":"hi"}}' + NL + NL);
      await delay(260);
      res.end('event: message_delta' + NL + 'data: {"type":"message_delta","usage":{"output_tokens":150}}' + NL + NL);
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  process.env.AGENT_SWITCH_PASS_BASE = `http://127.0.0.1:${upstream.address().port}`;
  try {
    await sw.resetAgentSwitchForTests();
    const port = await freePort();
    await sw.setProxyPort(port);
    // 工具配置：故意用 4 空格缩进、带别的设置和注释，看还原时是不是一个字节都不差
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true }); fs.mkdirSync(path.dirname(codexFile), { recursive: true });
    const claudeBefore = ['{', '    "permissions": { "allow": ["Bash(ls:*)"] },', '    "env": { "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "32000" },', '    "theme": "dark"', '}', ''].join(NL);
    const codexBefore = ['# my codex config', 'model = "gpt-5.5"', 'model_reasoning_effort = "high"   # keep', '', '[projects."D:\\\\work"]', 'trust_level = "trusted"', '', '[mcp_servers.demo]', 'command = "node"', ''].join(NL);
    fs.writeFileSync(claudeFile, claudeBefore); fs.writeFileSync(codexFile, codexBefore);
    assert.deepEqual(sw.agentView().pass, { claude: { on: false, connected: false, blocked: '' }, codex: { on: false, connected: false, blocked: '' }, grok: { on: false, connected: false, blocked: '' } });

    /* ---------- Claude Code：打开只加一行 ---------- */
    const opened = await sw.setAppPass('claude', true);
    assert.match(opened.message, /透明转发已打开/);
    const claudeOn = JSON.parse(read(claudeFile));
    assert.deepEqual(claudeOn, { permissions: { allow: ['Bash(ls:*)'] }, env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/pass/claude` }, theme: 'dark' }, '只多了接口地址这一个键');
    let view = sw.agentView();
    assert.deepEqual(view.pass.claude, { on: true, connected: true, blocked: '' });
    assert.equal(view.proxy.running, true);
    assert.equal(view.proxy.apps.claude, false, '不是本地路由');
    assert.equal(view.providers.find(item => item.app === 'claude' && item.active)?.official, true, '当前供应商仍然是官方登录');
    assert.deepEqual(sw.agentDrift(), [], '不算配置被改走');

    // 请求原样到官方，带着工具自己的凭据；记录里有速度，没有凭据和内容
    const body = JSON.stringify({ model: 'claude-qa', stream: true, messages: [{ role: 'user', content: 'secret-text' }] });
    const reply = await send(port, '/pass/claude/v1/messages?beta=true', { authorization: 'Bearer sk-ant-oat-TESTTOKEN', 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' }, body);
    assert.equal(reply.status, 200); assert.match(reply.body, /message_delta/);
    assert.deepEqual([hits[0].url, hits[0].headers.authorization, hits[0].headers['anthropic-beta'], hits[0].body], ['/claude/v1/messages?beta=true', 'Bearer sk-ant-oat-TESTTOKEN', 'oauth-2025-04-20', body]);
    await delay(60);
    const entry = sw.agentView().logs[0];
    assert.deepEqual([entry.pass, entry.app, entry.model, entry.status, entry.input, entry.output], [true, 'claude', 'claude-qa', 200, 900, 150]);
    assert.ok(entry.tokensPerSec > 100 && entry.firstTokenMs >= 60 && entry.firstTokenMs > entry.firstByteMs, `速度和首字延迟：${entry.tokensPerSec} / ${entry.firstTokenMs} / ${entry.firstByteMs}`);
    const speed = ledger.passSpeed(7);
    assert.deepEqual([speed.length, speed[0].app, speed[0].model, speed[0].count, speed[0].tokensPerSec, speed[0].firstTokenMs], [1, 'claude', 'claude-qa', 1, entry.tokensPerSec, entry.firstTokenMs], '按型号汇总的速度来自保存的转发记录');
    const kept = fs.readdirSync(ledger.routeLogDir()).map(name => read(path.join(ledger.routeLogDir(), name))).join('') + read(storeFile) + read(path.join(process.env.TOKENPULSE_DATA_DIR, 'agent-switch-log.json'));
    assert.equal(/TESTTOKEN|secret-text/.test(kept), false, '保存下来的东西里没有凭据和请求内容');
    // 没开的工具不转发
    assert.equal((await send(port, '/pass/codex/responses', {}, '{}')).status, 404);

    // 关闭：整个文件原样放回去，本机的监听停掉
    const closed = await sw.setAppPass('claude', false);
    assert.match(closed.message, /恢复直连/);
    assert.equal(read(claudeFile), claudeBefore, '关闭后配置和打开前一个字节都不差');
    view = sw.agentView();
    assert.deepEqual([view.pass.claude.on, view.proxy.running], [false, false]);
    console.log('PASS pass-through switch: turning it on adds one line to Claude Code, requests reach the official address with the tool own credentials, off restores the file byte for byte');

    /* ---------- Codex：顶层加一行，内置供应商不变 ---------- */
    await sw.setAppPass('codex', true);
    const codexOn = read(codexFile);
    assert.equal(codexOn, codexBefore.replace('model_reasoning_effort = "high"   # keep' + NL + NL, 'model_reasoning_effort = "high"   # keep' + NL + NL + `openai_base_url = "http://127.0.0.1:${port}/pass/codex"` + NL), '只在顶层多了一行，在第一张表之前');
    assert.doesNotMatch(codexOn, /model_provider|model_providers/, '不建自定义供应商');
    assert.deepEqual(sw.agentView().pass.codex, { on: true, connected: true, blocked: '' });
    assert.equal(sw.agentView().providers.find(item => item.app === 'codex' && item.active)?.official, true);
    await sw.setAppPass('codex', false);
    assert.equal(read(codexFile), codexBefore, 'Codex 的配置也原样放回去');

    // 开着的时候配置被别人改了：关闭时只拿掉我们加的那一行，别人的改动留着
    await sw.setAppPass('claude', true); await sw.setAppPass('codex', true);
    const edited = JSON.parse(read(claudeFile)); edited.theme = 'light'; edited.env.FOO = 'bar';
    fs.writeFileSync(claudeFile, JSON.stringify(edited, null, 4) + NL);
    fs.writeFileSync(codexFile, read(codexFile).replace('model = "gpt-5.5"', 'model = "gpt-5.6"'));
    await sw.setAppPass('claude', false); await sw.setAppPass('codex', false);
    assert.deepEqual(JSON.parse(read(claudeFile)), { permissions: { allow: ['Bash(ls:*)'] }, env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000', FOO: 'bar' }, theme: 'light' });
    assert.equal(read(codexFile), codexBefore.replace('model = "gpt-5.5"', 'model = "gpt-5.6"'));
    fs.writeFileSync(claudeFile, claudeBefore); fs.writeFileSync(codexFile, codexBefore);
    console.log('PASS pass-through switch: Codex gets one top-level line and keeps its built-in provider; edits made by others while it is on are kept');

    /* ---------- 退出还原、启动恢复 ---------- */
    await sw.setAppPass('claude', true); await sw.setAppPass('codex', true);
    sw.releaseAgentSwitch(); await sw.waitAgentProxyClosed();
    assert.deepEqual([read(claudeFile), read(codexFile)], [claudeBefore, codexBefore], '退出时恢复直连');
    assert.deepEqual(JSON.parse(read(storeFile)).pass.apps, { claude: true, codex: true }, '开关留着');
    assert.equal(sw.agentView().proxy.running, false);
    await sw.resumeAgentProxy();
    view = sw.agentView();
    assert.deepEqual([view.pass.claude, view.pass.codex, view.proxy.running], [{ on: true, connected: true, blocked: '' }, { on: true, connected: true, blocked: '' }, true], '下次启动接着开');
    assert.match(read(codexFile), /openai_base_url = "http:\/\/127\.0\.0\.1:\d+\/pass\/codex"/);
    // 退出期间工具换成了第三方：启动时不恢复，关掉并说明
    sw.releaseAgentSwitch(); await sw.waitAgentProxyClosed();
    fs.writeFileSync(codexFile, 'model_provider = "relay"' + NL + codexBefore + NL + '[model_providers.relay]' + NL + 'name = "Relay"' + NL + 'base_url = "https://relay.example/v1"' + NL);
    const codexRelay = read(codexFile);
    await sw.resumeAgentProxy();
    view = sw.agentView();
    assert.deepEqual([view.pass.claude.on, view.pass.codex.on, read(codexFile)], [true, false, codexRelay]);
    assert.match(view.notice, /Codex 的透明转发没有恢复，已关闭/);
    assert.match(view.pass.codex.blocked, /不是用官方登录/);
    await rejects(() => sw.setAppPass('codex', true), /不是用官方登录/, '用第三方供应商时不能开');
    await rejects(() => sw.setAppPass('desktop', true), /还不支持/, 'Claude 桌面端还不支持');
    fs.writeFileSync(codexFile, codexBefore);
    console.log('PASS pass-through switch: quitting restores the direct connection and the next start turns it back on; a tool that moved to a third party is left alone');

    /* ---------- 和供应商切换互斥 ---------- */
    // 直连第三方：透明转发自动关掉，配置里是供应商的地址
    const relay = sw.saveProvider({ app: 'claude', name: 'Relay', baseUrl: 'https://relay.example', apiKey: 'sk-real', model: 'claude-sonnet-5', upstream: 'anthropic' });
    await sw.activateProvider(relay);
    assert.deepEqual([JSON.parse(read(claudeFile)).env.ANTHROPIC_BASE_URL, sw.agentView().pass.claude.on], ['https://relay.example', false]);
    assert.match(sw.agentView().pass.claude.blocked, /不是用官方登录/);
    await rejects(() => sw.setAppPass('claude', true), /不是用官方登录/, '配了第三方地址时不能开');
    // 切回官方再打开；这时点一次「官方登录」（重写一遍配置）不会把它弄丢
    await sw.activateProvider('official-claude');
    await sw.setAppPass('claude', true);
    await sw.activateProvider('official-claude');
    assert.deepEqual([JSON.parse(read(claudeFile)).env.ANTHROPIC_BASE_URL, sw.agentView().pass.claude], [`http://127.0.0.1:${port}/pass/claude`, { on: true, connected: true, blocked: '' }]);
    // 走本地路由的供应商（接口格式不同）：透明转发关掉；之后关路由，配置里不留透明转发的地址
    const cross = sw.saveProvider({ app: 'claude', name: 'Chat', baseUrl: 'https://chat.example/v1', apiKey: 'sk-chat', model: 'gpt-test', upstream: 'openai-chat' });
    await sw.activateProvider(cross);
    view = sw.agentView();
    assert.deepEqual([view.pass.claude.on, view.proxy.apps.claude, JSON.parse(read(claudeFile)).env.ANTHROPIC_BASE_URL], [false, true, `http://127.0.0.1:${port}/claude`]);
    assert.match(view.pass.claude.blocked, /本地路由/);
    await sw.setAppProxy('claude', false);
    assert.equal(JSON.parse(read(claudeFile)).env?.ANTHROPIC_BASE_URL, undefined, '关掉本地路由后回到官方直连，没有残留的地址');
    assert.equal(sw.agentView().proxy.running, false);
    console.log('PASS pass-through switch: switching to a third-party provider or local routing turns it off; re-applying the official sign-in keeps it');
  } finally {
    try { sw.releaseAgentSwitch(); await sw.waitAgentProxyClosed(); } catch { /* 已经关了 */ }
    upstream.close(); upstream.closeAllConnections?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
