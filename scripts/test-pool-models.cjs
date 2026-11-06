/*
 * 号池的「获取模型」（src/core/agent-switch.ts 的 listPoolModels）。
 * 覆盖：官方 Claude 账号用自己的 OAuth 令牌问 /v1/models（Bearer + oauth beta + anthropic-version、一次要全）；
 * 供应商用自己的地址和密钥；过期账号跳过、不续期；Codex 等没有模型接口的官方账号说明原因；合并按几个成员有排序；
 * 编辑页还没保存的成员也能问；已保存的号池不传成员就用自己的；一个都没问到不报错、按成员给原因；结果里没有凭据。
 * 另外：号池里的账号 / 供应商删掉后号池还能保存，删掉的成员标出来、保存时移出。
 * 用一次性的数据目录和本机假上游（AGENT_SWITCH_POOL_BASE 只给测试用），不碰真实账号。
 */
// 不读真实的 ~/.gemini/antigravity：这个测试没隔离用户目录
process.env.TOKENPULSE_ANTIGRAVITY_DIR ??= require('node:path').join(require('node:os').tmpdir(), 'tokenpulse-no-antigravity');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-pool-models-'));
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.AGENT_SWITCH_HOME = path.join(root, 'home');
process.env.AGENT_SWITCH_CC_DB = path.join(root, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
const sw = require('../build/core/agent-switch');

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const now = Date.now();
const account = (kind, ref, token, extra = {}) => ({ id: `${kind}:${ref}`, kind, ref, email: `${ref}@example.com`, label: ref, createdAt: now, lastSeenAt: now, credential: { token, expiresAt: now + 3_600_000, ...extra } });
fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'official-accounts.json'), JSON.stringify({ version: 2, active: {}, accounts: [
  account('claude', 'qa-a', 'oauth-token-a'), account('claude', 'qa-b', 'oauth-token-b'), account('claude', 'qa-old', 'oauth-token-old', { expiresAt: now - 60_000 }),
  account('chatgpt', 'qa-c', 'oauth-token-c', { accountId: 'ws-qa' }),
] }));

const MODELS = { 'Bearer oauth-token-a': ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5'], 'Bearer oauth-token-b': ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], 'Bearer relay-key': ['claude-opus-5-5', 'relay-only'] };
const hits = [];
const server = http.createServer((req, res) => {
  const hit = { url: req.url, auth: req.headers.authorization || '', beta: req.headers['anthropic-beta'] || '', version: req.headers['anthropic-version'] || '' };
  hits.push(hit);
  if (req.url.startsWith('/broken/')) { res.writeHead(500); res.end('{}'); return; }
  const ids = MODELS[hit.auth];
  if (!ids) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"bad"}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: ids.map(id => ({ type: 'model', id, display_name: id })), has_more: false }));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.AGENT_SWITCH_POOL_BASE = base;
  try {
    const relay = sw.saveProvider({ app: 'claude', name: 'QA Relay', baseUrl: `${base}/relay`, apiKey: 'relay-key', model: 'claude-opus-5-5', upstream: 'anthropic' });
    const broken = sw.saveProvider({ app: 'claude', name: 'QA Broken', baseUrl: `${base}/broken`, apiKey: 'broken-key', model: 'x', upstream: 'anthropic' });
    const members = [{ type: 'account', id: 'claude:qa-a' }, { type: 'account', id: 'claude:qa-old' }, { type: 'account', id: 'claude:qa-b' }, { type: 'provider', id: relay }, { type: 'provider', id: broken }];

    const report = await sw.listPoolModels({ app: 'claude', members });
    assert.deepEqual(report.models, [
      { id: 'claude-opus-5-5', members: 3 }, { id: 'claude-sonnet-5-5', members: 2 },
      { id: 'claude-fable-5-1', members: 1 }, { id: 'claude-haiku-5-5', members: 1 }, { id: 'relay-only', members: 1 },
    ], '按几个成员有排序，一样多的保持上游给的顺序');
    assert.equal(report.total, 3, '问到了 3 个成员');
    assert.deepEqual(report.members.map(m => [m.name, m.ok, m.count ?? m.error]), [
      ['qa-a@example.com', true, 3], ['qa-old@example.com', false, '登录已过期，先在 Claude Code 里用一次或重新登录'], ['qa-b@example.com', true, 3], ['QA Relay', true, 2], ['QA Broken', false, '获取模型失败，HTTP 500'],
    ]);
    pass('pool models merge every member: official Claude accounts, API key providers, counted per model; expired and failing members explain why');

    const official = hits.filter(h => h.url.startsWith('/claude/'));
    assert.deepEqual(official.map(h => h.auth).sort(), ['Bearer oauth-token-a', 'Bearer oauth-token-b'], '过期账号不发请求');
    assert.ok(official.every(h => h.url === '/claude/v1/models?limit=1000' && h.beta === 'oauth-2025-04-20' && h.version === '2023-06-01'), JSON.stringify(official));
    const relayHit = hits.find(h => h.url.startsWith('/relay/'));
    assert.equal(relayHit.url, '/relay/v1/models');
    assert.equal(relayHit.beta, '', '供应商不带官方 OAuth 的 beta');
    assert.equal(JSON.stringify(report).includes('token') || JSON.stringify(report).includes('relay-key'), false, '结果里没有凭据');
    pass('official accounts use their own OAuth token with the OAuth beta and fetch the full list; providers use their own key; no credential in the result');

    // 已保存的号池：不传成员就用自己的
    const pool = sw.saveProvider({ app: 'claude', name: 'QA 号池', pool: { strategy: 'round-robin', members: [{ type: 'account', id: 'claude:qa-b' }] } });
    hits.length = 0;
    const saved = await sw.listPoolModels({ id: pool });
    assert.deepEqual(saved.models.map(m => m.id), MODELS['Bearer oauth-token-b']);
    assert.equal(hits.length, 1);
    pass('a saved pool uses its own members when none are passed');

    // 没问到任何成员：不报错，按成员给原因；Codex 的官方账号没有模型接口
    const none = await sw.listPoolModels({ app: 'claude', members: [{ type: 'account', id: 'claude:qa-old' }, { type: 'account', id: 'chatgpt:qa-c' }, { type: 'provider', id: 'missing' }] });
    assert.deepEqual([none.models, none.total], [[], 0]);
    assert.deepEqual(none.members.map(m => m.error), ['登录已过期，先在 Claude Code 里用一次或重新登录', '找不到这个官方账号', '找不到这个供应商']);
    const codex = await sw.listPoolModels({ app: 'codex', members: [{ type: 'account', id: 'chatgpt:qa-c' }] });
    assert.equal(codex.members[0].error, '这家的官方账号没有可用的模型列表接口');
    await assert.rejects(sw.listPoolModels({ app: 'claude', members: [] }), /先在「成员」里加入账号或供应商/);
    pass('no answering member returns reasons per member instead of failing; accounts without a model API and empty pools are explained');

    // 号池里的账号 / 供应商被删掉以后：号池还能改，保存时把删掉的成员移出（以前报「找不到的官方账号」，号池就改不了了）
    const spare = sw.saveProvider({ app: 'claude', name: 'QA Spare', baseUrl: `${base}/relay`, apiKey: 'relay-key', model: 'm', upstream: 'anthropic' });
    const keep = [{ type: 'account', id: 'claude:qa-a' }, { type: 'account', id: 'claude:qa-gone' }, { type: 'provider', id: spare }, { type: 'provider', id: relay }];
    const accountsFile = path.join(process.env.TOKENPULSE_DATA_DIR, 'official-accounts.json');
    const store = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    fs.writeFileSync(accountsFile, JSON.stringify({ ...store, accounts: [...store.accounts, account('claude', 'qa-gone', 'oauth-token-gone')] }));
    const kept = sw.saveProvider({ app: 'claude', name: 'QA 留下的号池', pool: { strategy: 'round-robin', members: keep } });
    fs.writeFileSync(accountsFile, JSON.stringify(store)); // 设置里删掉 qa-gone
    sw.deleteProvider(spare);
    const stale = sw.agentView().providers.find(p => p.id === kept).pool.members;
    assert.deepEqual(stale.map(m => [m.id, !!m.missing]), [['claude:qa-a', false], ['claude:qa-gone', true], [spare, true], [relay, false]], '界面数据标出已删除的成员');
    sw.saveProvider({ id: kept, app: 'claude', name: 'QA 留下的号池', pool: { strategy: 'fill-first', members: keep } });
    const after = sw.agentView().providers.find(p => p.id === kept).pool;
    assert.deepEqual([after.strategy, after.members.map(m => m.id)], ['fill-first', ['claude:qa-a', relay]], '保存成功，已删除的成员移出，其余顺序不变');
    assert.throws(() => sw.saveProvider({ id: kept, app: 'claude', name: 'QA 留下的号池', pool: { members: [{ type: 'account', id: 'claude:qa-gone' }, { type: 'provider', id: spare }] } }), /号池里的成员都已删除，请在「成员」里重新选择/);
    assert.throws(() => sw.saveProvider({ id: kept, app: 'claude', name: 'QA 留下的号池', pool: { members: [{ type: 'account', id: 'claude:qa-a' }, { type: 'account', id: 'chatgpt:qa-c' }] } }), /找不到的官方账号/, '还在、但不是这家的账号照旧报错');
    assert.deepEqual(sw.agentView().providers.find(p => p.id === kept).pool.members.map(m => m.id), ['claude:qa-a', relay], '报错的保存不改号池');
    pass('a pool whose account or provider was deleted can still be edited: deleted members are flagged and dropped on save; all-deleted and wrong-kind members still fail');

    console.log(`${checks}/${checks} pool model checks passed`);
  } finally {
    delete process.env.AGENT_SWITCH_POOL_BASE;
    await sw.resetAgentSwitchForTests();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error('FAIL', error); process.exit(1); });
