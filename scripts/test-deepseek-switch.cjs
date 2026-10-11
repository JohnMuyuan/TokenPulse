'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-dsh-'));
const home = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.AGENT_SWITCH_HOME = home;
process.env.AGENT_SWITCH_CC_DB = path.join(root, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];

const sw = require('../build/core/agent-switch');
const config = require('../build/core/agent-config');

const patch = path.join(home, '.dsh', 'cordis.patch.yml');
const cred = path.join(home, '.dsh', '.credentials.yaml');
const desktop = path.join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const userPatch = "# keep this !!js tag\n- id: ui-settings\n  name: keep-me\n  config:\n    theme: light\n";
const userCred = "version: 1\nrecords:\n  account: kept\n";
const desktopText = "# desktop\n- id: llm-pi-ai\n  name: user\n";

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}
function userPrefix(text) {
  const at = text.indexOf('# >>> TokenPulse');
  assert.ok(at > 0, '标记应该接在原有内容后面');
  return text.slice(0, at).replace(/\n+$/, '\n');
}
function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

(async () => {
  write(desktop, desktopText);
  await sw.setProxyPort(await freePort());
  const relay = {
    app: 'deepseek', name: 'Relay', baseUrl: 'https://relay.example/v1', apiKey: 'sk-test-deepseek', model: 'deepseek-flash', upstream: 'openai-chat', contextWindow: 128000,
  };
  const id = sw.saveProvider(relay);
  await sw.activateProvider(id);
  let text = read(patch);
  assert.match(text, /api: openai-completions/);
  assert.match(text, /baseURL: https:\/\/relay\.example\/v1/);
  assert.match(text, /model: deepseek-flash/);
  assert.match(text, /contextWindow: 128000/);
  assert.match(text, /apiKeyEnv: TOKENPULSE_ROUTE/);
  assert.match(read(cred), /TOKENPULSE_ROUTE: sk-test-deepseek/);
  assert.equal(read(desktop), desktopText);
  assert.match(sw.agentView().notice || '', /盖住/);
  await sw.activateProvider('official-deepseek');
  assert.equal(read(patch), null, '只有 TokenPulse 写的补丁，切回官方登录时删掉文件');
  assert.equal(read(cred), null, '凭据文件本来没有，切回官方登录时删掉');
  assert.equal(read(desktop), desktopText);
  console.log('PASS deepseek switch: new home patch and credentials are removed with the official login');

  write(patch, userPatch);
  write(cred, userCred);
  sw.saveProvider({ ...relay, id, upstream: 'openai-responses' });
  await sw.activateProvider(id);
  text = read(patch);
  assert.equal(userPrefix(text), userPatch);
  assert.match(text, /api: openai-responses/);
  assert.match(text, /!!js/);
  assert.match(read(cred), /TOKENPULSE_ROUTE: sk-test-deepseek/);
  assert.ok(read(cred).startsWith(userCred.trimEnd()), '凭据里原有的记录留在前面');
  await sw.setAppProxy('deepseek', true);
  text = read(patch);
  assert.equal(userPrefix(text), userPatch);
  assert.match(text, /api: openai-completions/);
  assert.match(text, /baseURL: http:\/\/127\.0\.0\.1:\d+\/deepseek\/v1/);
  assert.match(read(cred), /TOKENPULSE_ROUTE: PROXY_MANAGED/);
  assert.equal(read(desktop), desktopText);
  await sw.setAppProxy('deepseek', false);
  text = read(patch);
  assert.equal(userPrefix(text), userPatch);
  assert.match(text, /api: openai-responses/);
  assert.match(text, /baseURL: https:\/\/relay\.example\/v1/);
  assert.equal(read(desktop), desktopText);
  console.log('PASS deepseek switch: direct, local route, and closing the route keep the rest of the file');

  const routed = text;
  write(patch, routed.replace(/baseURL: .+/, 'baseURL: https://elsewhere.example/v1'));
  assert.ok(sw.agentDrift().some((item) => item.app === 'deepseek'), '地址被改走要提醒');
  write(patch, routed);
  const credBefore = read(cred);
  config.configureReadOnly(() => true);
  await assert.rejects(() => sw.activateProvider('official-deepseek'), /只读保护/);
  assert.equal(read(patch), routed);
  assert.equal(read(cred), credBefore);
  config.configureReadOnly(() => false);
  console.log('PASS deepseek switch: drift is reported and read-only protection writes nothing');

  await sw.activateProvider('official-deepseek');
  assert.equal(read(patch), userPatch);
  assert.equal(read(cred), userCred);
  assert.equal(read(desktop), desktopText);
  console.log('PASS deepseek switch: official login restores the original bytes');

  const other = sw.saveProvider({ app: 'deepseek', name: 'Other', baseUrl: 'https://other.example/v1', apiKey: 'sk-other', model: 'deepseek-v4', upstream: 'anthropic' });
  assert.throws(() => sw.saveProvider({ app: 'deepseek', name: 'Bad Pool', model: 'deepseek-flash', pool: { members: [{ type: 'account', id: 'deepseek:nope' }] } }), /只能放 API Key/);
  const pool = sw.saveProvider({ app: 'deepseek', name: 'Pool', model: 'deepseek-flash', pool: { strategy: 'round-robin', members: [{ type: 'provider', id }, { type: 'provider', id: other }] } });
  await sw.activateProvider(pool);
  text = read(patch);
  assert.equal(userPrefix(text), userPatch);
  assert.match(text, /api: openai-completions/);
  assert.match(text, /\/deepseek\/v1/);
  assert.match(read(cred), /PROXY_MANAGED/);
  assert.equal(read(desktop), desktopText);
  await sw.setAppProxy('deepseek', false);
  await sw.activateProvider('official-deepseek');
  assert.equal(read(patch), userPatch);
  assert.equal(read(cred), userCred);
  console.log('PASS deepseek switch: a pool only accepts API-key providers and routes locally');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
