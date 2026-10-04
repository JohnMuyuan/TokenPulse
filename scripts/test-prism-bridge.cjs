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
  } finally {
    prism.releasePrism();
    prism.onPrismChange(null);
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
