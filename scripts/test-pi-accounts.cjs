/*
 * pi OAuth 账号识别（重点：Google AI Plan / earendil-works/pi PR #12614，provider = google-ai-plan）。
 * 覆盖：
 * 1. 读取 ~/.pi/agent/auth.json（严格只读、不落盘任何原始 token / refresh / dpopKey.d）；
 * 2. 通过 Google OIDC UserInfo（及 oauth2 v2 回退）解析邮箱，并按单向指纹缓存，access 刷新/过期后零网络命中缓存；
 * 3. 首次遇到过期 access 记占位段，待 pi 刷新 access 后原地升级为真实邮箱；
 * 4. 换号、登出时间线归属、时间线前推断、离线 JWT 解析（openai-codex）；
 * 5. pi 会话扫描（含纯 google-ai-plan、混合 google-ai-plan + tokenpulse_route、toolResult/compaction 继承 provider、老账本自动补扫）；
 * 6. 查询筛选（account / channel / search / projects / sessions / sort=quota）、订阅等价 vs API 实付拆分、不写入 accountHours、Antigravity 别名共享。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-pi-accounts-'));
process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'PI_CODING_AGENT_DIR', 'AGENT_SWITCH_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });

const build = path.join(__dirname, '..', 'build', 'core');
const piAccounts = require(path.join(build, 'pi-accounts.js'));
const { scanLocalUsage, readRollups, writeRollups } = require(path.join(build, 'usage-scan.js'));
const { queryRequests } = require(path.join(build, 'request-log.js'));
const { buildSnapshot } = require(path.join(build, 'report.js'));

const piDir = path.join(process.env.HOME, '.pi', 'agent');
const authPath = path.join(piDir, 'auth.json');
const sessionsDir = path.join(piDir, 'sessions', '--D--qa-pi-plan--');

let checks = 0;
const pass = (name) => { checks += 1; console.log('PASS ' + name); };

const makeJwt = (payload) => {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
};

const writeAuth = (doc) => {
  fs.mkdirSync(piDir, { recursive: true });
  const text = JSON.stringify(doc, null, 2);
  fs.writeFileSync(authPath, text, 'utf8');
  return text;
};

const makeGoogleCred = (overrides = {}) => ({
  type: 'oauth',
  access: 'ya29.fake-access-alice-1',
  refresh: '1//fake-refresh-alice-secret',
  expires: Date.now() + 3600_000,
  dpopKey: {
    kty: 'EC',
    crv: 'P-256',
    x: 'alice-dpop-pub-x-coord-111',
    y: 'alice-dpop-pub-y-coord-222',
    d: 'alice-dpop-private-secret-ddd',
  },
  dpopNonce: 'nonce-secret-123',
  ...overrides,
});

const usage = (input, output, cacheRead = 0, cacheWrite = 0, total = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

const lines = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

(async () => {
  try {
    const t0 = Date.UTC(2026, 10, 20, 10, 0, 0);
    const isoAt = (ms) => new Date(ms).toISOString();

    // 1. 首次遇到已过期（>5 分钟）的 google-ai-plan 凭据：不发网络、记录占位段；且 auth.json 字节不变
    const expiredCred = makeGoogleCred({ access: 'ya29.expired-1', expires: t0 - 10 * 60_000 });
    const rawAuthBefore = writeAuth({ 'google-ai-plan': expiredCred });
    let calls = 0;
    let res = await piAccounts.syncPiAccounts({
      now: t0,
      getJson: async () => { calls += 1; return { email: 'should-not-call@gmail.com' }; },
    });
    assert.equal(calls, 0, '过期超过 5 分钟且非 force 时不发网络');
    assert.equal(res.resolved.length, 0);
    assert.equal(piAccounts.hasUnresolvedPiOAuth(t0), false);
    let store = piAccounts.readPiLoginStore();
    assert.equal(store.providers['google-ai-plan']?.length, 1);
    assert.equal(store.providers['google-ai-plan'][0].label, 'Google AI Plan 账号');
    assert.equal(store.providers['google-ai-plan'][0].from, t0);
    assert.equal(fs.readFileSync(authPath, 'utf8'), rawAuthBefore, 'auth.json 严格只读不改写');
    pass('expired google-ai-plan token records provisional span without network and never touches auth.json');

    // 2. 在 5 分钟安全余量内（pi 提前 5 分钟扣 expires）应允许尝试解析；OIDC 失败回退 oauth2 v2，且原地升级占位段
    const graceCred = makeGoogleCred({ access: 'ya29.grace-2', expires: t0 + 60_000 });
    writeAuth({ 'google-ai-plan': graceCred });
    const tGrace = t0 + 3 * 60_000; // 超过 expires 2 分钟，仍在 5 分钟宽限期内
    assert.equal(piAccounts.hasUnresolvedPiOAuth(tGrace), true);
    const urls = [];
    res = await piAccounts.syncPiAccounts({
      now: tGrace,
      getJson: async (url, headers) => {
        urls.push({ url, auth: headers.find((h) => h.startsWith('Authorization:')) });
        if (url === piAccounts.PI_GOOGLE_OIDC_USERINFO_URL) throw new Error('503');
        return { email: 'alice@gmail.com', name: 'Alice', id: 'google-sub-alice' };
      },
    });
    assert.deepEqual(urls.map((u) => u.url), [piAccounts.PI_GOOGLE_OIDC_USERINFO_URL, piAccounts.PI_GOOGLE_V2_USERINFO_URL]);
    assert.equal(urls[0].auth, 'Authorization: Bearer ya29.grace-2');
    assert.deepEqual(res.resolved, ['alice@gmail.com']);
    store = piAccounts.readPiLoginStore();
    assert.equal(store.providers['google-ai-plan'].length, 1, '原地升级占位段，不重复新增段');
    assert.equal(store.providers['google-ai-plan'][0].from, t0, '保留最早观察时间 from');
    assert.equal(store.providers['google-ai-plan'][0].email, 'alice@gmail.com');
    assert.equal(store.providers['google-ai-plan'][0].id, piAccounts.piAccountIdOf('google-ai-plan', 'alice@gmail.com'));
    const savedJson = fs.readFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'pi-logins.json'), 'utf8');
    for (const secret of ['ya29.grace-2', 'fake-refresh-alice-secret', 'alice-dpop-private-secret-ddd', 'nonce-secret-123']) {
      assert.equal(savedJson.includes(secret), false, `pi-logins.json 不得包含原始凭据 ${secret}`);
    }
    pass('OIDC -> v2 fallback resolves email within grace window, upgrades provisional span in-place, stores zero raw secrets');

    // 3. access 刷新、甚至 refresh 轮换但 DPoP 公钥不变，且已过期：命中缓存、零网络请求
    writeAuth({
      'google-ai-plan': makeGoogleCred({
        access: 'ya29.rotated-access-3',
        refresh: '1//rotated-refresh-3',
        expires: t0 - 999_000,
      }),
    });
    assert.equal(piAccounts.hasUnresolvedPiOAuth(t0 + 10 * 60_000), false);
    let extraCalls = 0;
    res = await piAccounts.syncPiAccounts({
      now: t0 + 10 * 60_000,
      force: true,
      getJson: async () => { extraCalls += 1; return {}; },
    });
    assert.equal(extraCalls, 0, '命中 DPoP 指纹缓存后零网络请求');
    assert.equal(res.changed, false);
    pass('DPoP fingerprint cache survives access expiry and refresh rotation with zero network calls');

    // 4. 换号（新 DPoP + 新 access）遇 401 记忆失败，避免重复请求；access 更新后重新成功并开新段
    const tSwitch = t0 + 2 * 3600_000;
    const bobDpop = { kty: 'EC', crv: 'P-256', x: 'bob-pub-x-999', y: 'bob-pub-y-888', d: 'bob-priv-ddd' };
    writeAuth({
      'google-ai-plan': {
        type: 'oauth',
        access: 'ya29.bob-stale-1',
        refresh: '1//bob-refresh',
        expires: tSwitch + 3600_000,
        dpopKey: bobDpop,
      },
    });
    let bobCalls = 0;
    await piAccounts.syncPiAccounts({
      now: tSwitch,
      getJson: async () => { bobCalls += 1; throw new Error('auth'); },
    });
    assert.equal(bobCalls, 1, '401 立刻停止，不继续尝试 v2');
    assert.equal(piAccounts.hasUnresolvedPiOAuth(tSwitch + 1000), false, '同一个失效 accessHash 不再重复请求');
    await piAccounts.syncPiAccounts({
      now: tSwitch + 1000,
      getJson: async () => { bobCalls += 1; return {}; },
    });
    assert.equal(bobCalls, 1);

    // pi 刷新了 bob 的 access token
    writeAuth({
      'google-ai-plan': {
        type: 'oauth',
        access: 'ya29.bob-fresh-2',
        refresh: '1//bob-refresh',
        expires: tSwitch + 7200_000,
        dpopKey: bobDpop,
      },
      // 同时测试离线 JWT 解析（openai-codex）和 api_key
      'openai-codex': {
        type: 'oauth',
        access: makeJwt({ email: 'codex-user@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-codex-1' } }),
        refresh: 'rt-codex',
        expires: tSwitch + 7200_000,
      },
      'custom-api': { type: 'api_key', key: 'sk-fake-key' },
    });
    assert.equal(piAccounts.hasUnresolvedPiOAuth(tSwitch + 5000), true);
    res = await piAccounts.syncPiAccounts({
      now: tSwitch + 5000,
      getJson: async () => ({ email: 'bob@gmail.com', name: 'Bob', sub: 'google-sub-bob' }),
    });
    assert.deepEqual(res.resolved, ['bob@gmail.com']);
    store = piAccounts.readPiLoginStore();
    assert.equal(store.providers['google-ai-plan'].length, 2);
    assert.equal(store.providers['google-ai-plan'][0].email, 'alice@gmail.com');
    assert.equal(store.providers['google-ai-plan'][1].email, 'bob@gmail.com');
    assert.equal(store.providers['google-ai-plan'][1].from, tSwitch, 'bob 占位段原地升级保留换号时间');
    assert.equal(store.providers['openai-codex']?.[0]?.email, 'codex-user@example.com', '离线 JWT 解析 openai-codex');
    assert.equal(store.providerTypes['custom-api'], 'api_key');
    assert.equal(piAccounts.isPiProviderOfficial('google-ai-plan', store), true);
    assert.equal(piAccounts.isPiProviderOfficial('openai-codex', store), true);
    assert.equal(piAccounts.isPiProviderOfficial('custom-api', store), false);
    assert.equal(piAccounts.isPiProviderOfficial('tokenpulse_route', store), false);
    pass('account switch, 401 backoff until token refresh, offline JWT extraction, and api_key classification');

    // 5. 登出：从 auth.json 移除 google-ai-plan 后记录空 id 退出段
    const tLogout = t0 + 4 * 3600_000;
    writeAuth({ 'custom-api': { type: 'api_key', key: 'sk-fake-key' } });
    piAccounts.recordPiLogins(tLogout);
    store = piAccounts.readPiLoginStore();
    assert.equal(store.providers['google-ai-plan'].length, 3);
    assert.equal(store.providers['google-ai-plan'][2].id, '');
    pass('removing google-ai-plan from auth.json records logout span');

    // 6. 端到端扫描 + 查询：纯 google-ai-plan 会话 + 混合会话（google-ai-plan + tokenpulse_route）
    fs.mkdirSync(sessionsDir, { recursive: true });
    const pureFile = path.join(sessionsDir, `${isoAt(t0 - 3600_000).replace(/[:.]/g, '-')}_sess-google-pure.jsonl`);
    fs.writeFileSync(pureFile, lines([
      { type: 'session', version: 3, id: 'sess-google-pure', timestamp: isoAt(t0 - 3600_000), cwd: 'D:\\qa\\pi-google' },
      { type: 'model_change', id: 'mc1', parentId: null, timestamp: isoAt(t0 - 3599_000), provider: 'google-ai-plan', modelId: 'gemini-4-hydrogen' },
      // 时间线之前的请求 → 推断归属 alice
      { type: 'message', id: 'p1', parentId: 'mc1', timestamp: isoAt(t0 - 1800_000), message: { role: 'assistant', provider: 'google-ai-plan', api: 'google-interactions', model: 'gemini-4-hydrogen', usage: usage(1000, 200, 4000, 0, 0.5), stopReason: 'stop' } },
      // alice 登录期内
      { type: 'message', id: 'p2', parentId: 'p1', timestamp: isoAt(t0 + 1800_000), message: { role: 'assistant', provider: 'google-ai-plan', api: 'google-interactions', model: 'gemini-4-neon', usage: usage(500, 100, 2000, 0, 0.25), stopReason: 'stop' } },
      // toolResult 不带 provider：沿用当前 google-ai-plan
      { type: 'message', id: 't1', parentId: 'p2', timestamp: isoAt(t0 + 1810_000), message: { role: 'toolResult', toolCallId: 'call-1', content: [], usage: usage(50, 20, 0, 0, 0.05) } },
    ]));

    const mixedFile = path.join(sessionsDir, `${isoAt(tSwitch).replace(/[:.]/g, '-')}_sess-mixed.jsonl`);
    fs.writeFileSync(mixedFile, lines([
      { type: 'session', version: 3, id: 'sess-mixed', timestamp: isoAt(tSwitch), cwd: 'D:\\qa\\pi-mixed' },
      // bob 登录期内走 google-ai-plan
      { type: 'message', id: 'm1', parentId: null, timestamp: isoAt(tSwitch + 600_000), message: { role: 'assistant', provider: 'google-ai-plan', api: 'google-interactions', model: 'gemini-4-hydrogen', usage: usage(200, 100, 0, 0, 0.4), stopReason: 'stop' } },
      // 中途切到 tokenpulse_route 中转 → official: false, account: null
      { type: 'message', id: 'm2', parentId: 'm1', timestamp: isoAt(tSwitch + 900_000), message: { role: 'assistant', provider: 'tokenpulse_route', model: 'deepseek-flash', usage: usage(300, 100, 0, 0, 0.1), stopReason: 'stop' } },
      // 登出后又跑了一条 google-ai-plan → official: true, account: null（登出后不归到 bob）
      { type: 'message', id: 'm3', parentId: 'm2', timestamp: isoAt(tLogout + 600_000), message: { role: 'assistant', provider: 'google-ai-plan', api: 'google-interactions', model: 'gemini-4-hydrogen', usage: usage(100, 50, 0, 0, 0.2), stopReason: 'stop' } },
    ]));

    const scan1 = scanLocalUsage();
    assert.equal(scan1.records.length, 6);
    const rollups = readRollups();
    assert.equal(rollups.files[pureFile].official, true, '纯 google-ai-plan 会话文件标记为 official: true');
    assert.equal(rollups.files[pureFile].piV, 1);
    assert.equal(rollups.files[mixedFile].piMixed, true, '混合会话文件标记 piMixed');
    assert.equal(rollups.files[mixedFile].official, undefined);
    assert.equal(Object.keys(rollups.files[pureFile].accountHours ?? {}).length, 0, 'pi 不写入 accountHours');
    assert.equal(Object.keys(rollups.files[mixedFile].accountHours ?? {}).length, 0, 'pi 不写入 accountHours');

    const page = queryRequests({
      from: '2026-11-01',
      to: '2026-11-30',
      source: 'pi',
      status: 'all',
      search: '',
      sort: 'time',
      page: 0,
      pageSize: 50,
      all: true,
      aggregate: true,
      projects: true,
      sessions: true,
    });
    const byId = new Map(page.rows.map((r) => [r.key.split(':').pop(), r]));
    const p1 = byId.get('p1');
    const p2 = byId.get('p2');
    const t1 = byId.get('t1');
    const m1 = byId.get('m1');
    const m2 = byId.get('m2');
    const m3 = byId.get('m3');

    assert.equal(p1.official, true);
    assert.equal(p1.provider, 'google-ai-plan');
    assert.equal(p1.channel, 'Google AI Plan');
    assert.equal(p1.account?.label, 'alice@gmail.com');
    assert.equal(p1.account?.basis, 'inferred');

    assert.equal(p2.account?.label, 'alice@gmail.com');
    assert.equal(p2.account?.basis, 'timeline');
    assert.equal(t1.provider, 'google-ai-plan', 'toolResult 继承当前 provider');
    assert.equal(t1.account?.label, 'alice@gmail.com');

    assert.equal(m1.official, true);
    assert.equal(m1.account?.label, 'bob@gmail.com');
    assert.equal(m1.account?.basis, 'timeline');

    assert.equal(m2.official, false);
    assert.equal(m2.account, null, '中转请求不归到任何官方账号');

    assert.equal(m3.official, true);
    assert.equal(m3.account, null, '登出后的请求不归到上一个账号');

    // 费用汇总拆分：google-ai-plan 进 officialCostUsd，tokenpulse_route 进 apiCostUsd
    const officialSum = page.aggregate.rows.reduce((s, r) => s + r.officialCostUsd, 0);
    const apiSum = page.aggregate.rows.reduce((s, r) => s + r.apiCostUsd, 0);
    assert.ok(Math.abs(officialSum - (0.5 + 0.25 + 0.05 + 0.4 + 0.2)) < 1e-6, `officialCostUsd=${officialSum}`);
    assert.ok(Math.abs(apiSum - 0.1) < 1e-6, `apiCostUsd=${apiSum}`);

    // 筛选器：按账号、按渠道、按搜索词、按 quota 排序均正常
    const aliceId = piAccounts.piAccountIdOf('google-ai-plan', 'alice@gmail.com');
    const onlyAlice = queryRequests({ from: '2026-11-01', to: '2026-11-30', source: 'pi', status: 'all', search: '', sort: 'quota', page: 0, pageSize: 50, all: true, account: aliceId });
    assert.equal(onlyAlice.total, 3);
    const onlyApi = queryRequests({ from: '2026-11-01', to: '2026-11-30', source: 'pi', status: 'all', search: '', sort: 'time', page: 0, pageSize: 50, all: true, channel: 'api' });
    assert.equal(onlyApi.total, 1);
    const searchPlan = queryRequests({ from: '2026-11-01', to: '2026-11-30', source: 'pi', status: 'all', search: 'google-ai-plan', sort: 'time', page: 0, pageSize: 50, all: true });
    assert.equal(searchPlan.total, 5);
    assert.equal(page.projects?.length, 2);
    assert.equal(page.sessions?.length, 2);

    // buildSnapshot 中纯 google-ai-plan 文件归入 officialCostUsd
    const snap = buildSnapshot(tLogout + 3600_000);
    const piOfficialSnap = snap.usage.filter((r) => r.source === 'pi').reduce((s, r) => s + r.officialCostUsd, 0);
    assert.ok(Math.abs(piOfficialSnap - 0.8) < 1e-6, `snapshot officialCostUsd=${piOfficialSnap}`);
    pass('end-to-end scan, mixed session attribution, cost split, filters, projects/sessions, and snapshot official rollup');

    // 7. 同邮箱别名共享：在 antigravity-accounts.json 给 alice@gmail.com 起别名后，pi 请求立即显示该别名
    fs.writeFileSync(
      path.join(process.env.TOKENPULSE_DATA_DIR, 'antigravity-accounts.json'),
      JSON.stringify({
        version: 1,
        activeId: 'antigravity:test',
        accounts: [{ id: 'antigravity:test', ref: 'test', email: 'alice@gmail.com', label: 'alice@gmail.com', alias: 'Google 主号', createdAt: t0, lastSeenAt: t0 }],
      }),
    );
    const aliased = queryRequests({ from: '2026-11-01', to: '2026-11-30', source: 'pi', status: 'all', search: '', sort: 'time', page: 0, pageSize: 50, all: true, account: aliceId });
    assert.ok(aliased.rows.every((r) => r.account?.label === 'Google 主号'), '自动复用同邮箱账号别名');
    pass('reuses user-configured alias for the same email from Antigravity/Official accounts');

    // 8. 老账本升级（缺少 piV）：自动触发一次性重扫补齐 provider 字段
    const legacy = readRollups();
    delete legacy.files[pureFile].piV;
    delete legacy.files[pureFile].provider;
    delete legacy.files[pureFile].official;
    writeRollups(legacy);
    const rescan = scanLocalUsage();
    assert.equal(rescan.records.length, 3, '缺少 piV 的老 pi 文件自动重扫一次');
    assert.ok(rescan.records.every((r) => r.provider === 'google-ai-plan'));
    assert.equal(scanLocalUsage().records.length, 0, '升级完成后不再重复扫描');
    pass('legacy pi rollups without piV rescan once automatically and stabilize');

    console.log(`${checks}/${checks} pi account checks passed`);
  } finally {
    piAccounts.resetPiSyncCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
