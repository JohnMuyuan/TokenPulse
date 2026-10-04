'use strict';
/*
 * Prism 桥的进程管理（src/core/prism-bridge.ts）。
 * 不碰真的 Prism：用本机的 python 跑一个假的 bridge.py，只验证 TokenPulse 这一侧——
 * 状态、登录后只读出账号信息、启动 / 停止、失败原因、传给子进程的环境变量。本机没有 python 时跳过。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const http = require('http');

const python = ['python', 'python3'].find(name => { try { execFileSync(name, ['-c', 'print(1)'], { stdio: 'pipe', windowsHide: true }); return true; } catch { return false; } });
if (!python) { console.log('SKIP prism bridge: 本机没有 python'); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-prism-'));
const fake = path.join(dir, 'bridge.py');
fs.writeFileSync(fake, `
import os, sys, json, time
cmd = sys.argv[1]
prof = os.environ["PRISM_PROFILE_DIR"]
if cmd == "login":
    os.makedirs(prof, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if k.startswith("PRISM_")}
    os.makedirs(os.path.dirname(os.environ["PRISM_AUTH_FILE"]), exist_ok=True)
    with open(os.environ["PRISM_AUTH_FILE"], "w") as f:
        json.dump({"cookie": "SECRET-COOKIE", "user_id": "user-abc", "plan": "plus", "expires_at": int(time.time()) + 864000, "env": env}, f)
    print("login ok", flush=True)
elif cmd == "serve":
    if os.path.exists(os.path.join(prof, "fail")):
        print("[fatal] boom", flush=True)
        sys.exit(1)
    print("[Prism Bridge] 服务已就绪！", flush=True)
    time.sleep(600)
`);
process.env.TOKENPULSE_DATA_DIR = path.join(dir, 'data');
process.env.TOKENPULSE_PRISM_SCRIPT = fake;
process.env.TOKENPULSE_PRISM_PYTHON = python;
// 外面的环境不能让桥对外开放
process.env.PRISM_HOST = '0.0.0.0';
process.env.PRISM_CALLER_OWNED_TOOLS = 'true';

const prism = require('../build/core/prism-bridge.js');
const home = path.join(process.env.TOKENPULSE_DATA_DIR, 'prism-bridge');

(async () => {
  let changes = 0;
  prism.onPrismChange(() => { changes++; });
  try {
    let state = prism.prismState();
    assert.deepEqual([state.available, state.deps, state.login, state.phase, state.task, state.port, state.autoStart], [true, true, null, 'stopped', '', 18765, false]);
    assert.equal(fs.existsSync(path.join(home, 'config.json')), false, '只看状态不写文件');
    await assert.rejects(prism.startPrism(), /请先登录/);
    console.log('PASS prism bridge: initial state');

    await prism.loginPrism();
    state = prism.prismState();
    assert.equal(state.login.userId, 'user-abc');
    assert.equal(state.login.plan, 'plus');
    assert.equal(state.login.expired, false);
    assert.equal(JSON.stringify(state).includes('SECRET-COOKIE'), false, '状态里不能带 cookie');
    const seen = JSON.parse(fs.readFileSync(path.join(home, 'profile', 'auth.json'), 'utf8')).env;
    assert.equal(seen.PRISM_HOST, '127.0.0.1', '只监听本机');
    assert.equal(seen.PRISM_CALLER_OWNED_TOOLS, undefined, '外面的 PRISM_ 开关不继承');
    assert.equal(seen.PRISM_PORT, '18765');
    assert.equal(seen.PRISM_PROFILE_DIR, path.join(home, 'login-profile'), '登录窗口用单独的浏览器数据');
    assert.ok(['chrome', 'msedge', undefined].includes(seen.PRISM_LOGIN_CHANNEL), '登录窗口只会选 Chrome / Edge / 自带的');
    console.log('     login browser:', seen.PRISM_LOGIN_CHANNEL || 'bundled Chromium');
    const endpoint = prism.prismEndpoint();
    assert.equal(endpoint.baseUrl, 'http://127.0.0.1:18765/v1');
    assert.ok(endpoint.apiKey.length >= 20 && seen.PRISM_BRIDGE_API_KEY === endpoint.apiKey, '总是带密钥，而且和供应商用的是同一个');
    assert.equal(JSON.stringify(state).includes(endpoint.apiKey), false, '状态里不能带密钥');
    console.log('PASS prism bridge: login keeps credentials out of state');

    await prism.startPrism();
    assert.equal(prism.prismState().phase, 'running');
    assert.ok(prism.prismState().logs.some(line => line.includes('服务已就绪')));
    assert.match(fs.readFileSync(path.join(home, 'bridge.log'), 'utf8'), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d .*服务已就绪/m, '日志带时间写进文件');
    assert.equal(prism.prismLogFile(), path.join(home, 'bridge.log'));
    assert.equal(prism.prismState().installed, true);

    // 0.3.20：系统里的代理会不会截走发往本机的请求。用两个假代理：一个回 502，一个回 200
    assert.equal(prism.loopbackProxy({}), '');
    assert.equal(prism.loopbackProxy({ HTTPS_PROXY: 'http://p:1' }), '', '只给 https 设的代理管不到 http://127.0.0.1');
    assert.equal(prism.loopbackProxy({ HTTP_PROXY: 'http://p:1' }), 'http://p:1');
    assert.equal(prism.loopbackProxy({ ALL_PROXY: 'socks5://p:1', NO_PROXY: 'localhost' }), 'socks5://p:1', '只排除 localhost 不够');
    assert.equal(prism.loopbackProxy({ HTTP_PROXY: 'http://p:1', NO_PROXY: 'example.com, 127.0.0.1' }), '');
    assert.equal(prism.loopbackProxy({ HTTP_PROXY: 'http://p:1', NO_PROXY: '*' }), '');
    const seenByProxy = [];
    const fakeProxy = status => new Promise(resolve => { const server = http.createServer((req, res) => { seenByProxy.push(req.url); res.writeHead(status); res.end('{}'); }); server.listen(0, '127.0.0.1', () => resolve(server)); });
    const bad = await fakeProxy(502), good = await fakeProxy(200);
    try {
      const env = { HTTP_PROXY: `http://user:pass@127.0.0.1:${bad.address().port}`, NO_PROXY: 'example.com' };
      prism.setPrismEnvForTests(env);
      await prism.checkPrismProxy();
      assert.deepEqual(prism.prismState().proxyIssue, { proxy: `http://127.0.0.1:${bad.address().port}`, certain: true }, '经代理到不了本机的服务：确定有问题，地址里的密码不交出去');
      assert.equal(seenByProxy[0], 'http://127.0.0.1:18765/health', '是真的经那个代理试了一次');
      prism.setPrismEnvForTests({ HTTP_PROXY: `http://127.0.0.1:${good.address().port}` });
      await prism.checkPrismProxy();
      assert.equal(prism.prismState().proxyIssue, null, '代理能把请求送回本机就不提醒');
      prism.setPrismEnvForTests({ ALL_PROXY: 'socks5://127.0.0.1:1080' });
      await prism.checkPrismProxy();
      assert.deepEqual(prism.prismState().proxyIssue, { proxy: 'socks5://127.0.0.1:1080', certain: false }, '试不了的代理类型只说可能');
      prism.setPrismEnvForTests(env);
      await prism.checkPrismProxy();
      await prism.fixPrismProxy();
      assert.equal(env.NO_PROXY, 'example.com,127.0.0.1,localhost,::1', '一键修复保留原来的条目');
      assert.equal(prism.prismState().proxyIssue, null);
    } finally { bad.close(); good.close(); }
    console.log('PASS prism bridge: log file, proxy interception check and fix');

    await prism.stopPrism();
    assert.equal(prism.prismState().phase, 'stopped');
    assert.equal(prism.prismState().error, '', '自己停的不算出错');
    console.log('PASS prism bridge: start and stop');

    fs.writeFileSync(path.join(home, 'profile', 'fail'), '');
    await assert.rejects(prism.startPrism(), /boom/);
    assert.equal(prism.prismState().phase, 'stopped');
    assert.match(prism.prismState().error, /boom/);
    fs.rmSync(path.join(home, 'profile', 'fail'));
    console.log('PASS prism bridge: failure reason');

    prism.setPrismAutoStart(true);
    assert.equal(prism.prismState().autoStart, true);
    assert.equal(prism.prismEndpoint().apiKey, endpoint.apiKey, '改设置不换密钥');
    prism.resumePrism();
    for (let i = 0; i < 100 && prism.prismState().phase !== 'running'; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(prism.prismState().phase, 'running', '开了跟着启动就自己起来');
    prism.releasePrism();
    for (let i = 0; i < 100 && prism.prismState().phase !== 'stopped'; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(prism.prismState().phase, 'stopped', '退出时把服务结束掉');
    assert.ok(changes > 0);
    console.log('PASS prism bridge: auto start and release');

    // 0.3.20：一键删除。服务开着也能删：先停，再把数据目录里的东西全删掉，而且不会被日志重新建出来
    await prism.startPrism();
    assert.ok(await prism.prismDiskUsage() > 0);
    await prism.removePrism();
    await new Promise(r => setTimeout(r, 300));
    const gone = prism.prismState();
    assert.deepEqual([gone.phase, gone.task, gone.login, gone.installed, gone.autoStart, gone.error], ['stopped', '', null, false, false, '']);
    assert.equal(fs.existsSync(home), false, '整个目录都删掉');
    assert.equal(await prism.prismDiskUsage(), 0);
    assert.ok(gone.logs.at(-1).includes('都已删除'));
    console.log('PASS prism bridge: remove everything');
  } finally {
    prism.releasePrism();
    prism.onPrismChange(null);
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
