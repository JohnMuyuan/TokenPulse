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
const { queryModelStudy } = require(path.join(build, 'model-study.js'));
const { listSessions } = require(path.join(build, 'sessions.js'));

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
    assert.equal(rollups.files[pureFile].piV, 2);
    assert.equal(rollups.files[mixedFile].piMixed, true, '混合会话文件标记 piMixed');
    assert.equal(rollups.files[mixedFile].official, undefined);
    assert.equal(Object.keys(rollups.files[pureFile].accountHours ?? {}).length, 0, '非三家官方账号的 pi 不写入 accountHours');
    assert.equal(Object.keys(rollups.files[mixedFile].accountHours ?? {}).length, 0, '非三家官方账号的 pi 不写入 accountHours');

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

    // buildSnapshot 与明细聚合口径完全一致：混合会话中的 google-ai-plan 也精准归入 officialCostUsd，而非整份落入 apiCostUsd
    const snap = buildSnapshot(tLogout + 3600_000);
    const piOfficialSnap = snap.usage.filter((r) => r.source === 'pi').reduce((s, r) => s + r.officialCostUsd, 0);
    const piApiSnap = snap.usage.filter((r) => r.source === 'pi').reduce((s, r) => s + r.apiCostUsd, 0);
    assert.ok(Math.abs(piOfficialSnap - 1.4) < 1e-6, `snapshot officialCostUsd=${piOfficialSnap} (expected 1.4)`);
    assert.ok(Math.abs(piApiSnap - 0.1) < 1e-6, `snapshot apiCostUsd=${piApiSnap} (expected 0.1)`);
    pass('end-to-end scan, mixed session attribution, cost split, filters, projects/sessions, and exact snapshot official/api rollup');

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

    // 9. 全量内置 pi OAuth provider 分类（openai / kimi-coding / meta 为订阅；openrouter OAuth 为 API 实付且不入时间线）
    const tAll = tLogout + 2 * 3600_000;
    writeAuth({
      openai: { type: 'oauth', access: makeJwt({ email: 'chatgpt-pi@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'ws-oa-1', chatgpt_user_id: 'user-oa-1' } }), refresh: 'rt-oa-1', expires: tAll + 3600_000 },
      'kimi-coding': { type: 'oauth', access: 'kimi-access-1', refresh: 'kimi-refresh-1', expires: tAll + 3600_000 },
      meta: { type: 'oauth', access: 'meta-key-1', refresh: 'meta-id-1', expires: tAll + 3600_000 },
      openrouter: { type: 'oauth', access: 'sk-or-v1-fake', refresh: '', expires: Number.MAX_SAFE_INTEGER },
      'github-copilot': { type: 'oauth', access: 'tid=fake;exp=1;proxy-ep=proxy.individual.githubcopilot.com', refresh: 'gho_fake_refresh_token', expires: tAll - 3600_000 },
    });
    const ghUrls = [];
    const syncAll = await piAccounts.syncPiAccounts({
      now: tAll,
      getJson: async (url) => {
        ghUrls.push(url);
        if (url === piAccounts.PI_GITHUB_USER_URL) return { id: 42, login: 'octocat', name: 'Octo Cat' };
        return {};
      },
    });
    assert.deepEqual(ghUrls, [piAccounts.PI_GITHUB_USER_URL], '仅向需要在线解析的 github-copilot 发请求（openai 已离线解出邮箱）');
    assert.ok(syncAll.resolved.includes('octocat'));
    store = piAccounts.readPiLoginStore();
    assert.equal(piAccounts.isPiProviderOfficial('openai', store), true, 'pi 的 openai OAuth 属于 ChatGPT 订阅');
    assert.equal(piAccounts.isPiProviderOfficial('kimi-coding', store), true, 'kimi-coding 属于订阅');
    assert.equal(piAccounts.isPiProviderOfficial('meta', store), true, 'meta 属于订阅');
    assert.equal(piAccounts.isPiProviderOfficial('openrouter', store), false, 'openrouter OAuth 实质是按量 API Key');
    assert.equal(store.providers.openrouter, undefined, 'openrouter 不写入订阅账号时间线');
    assert.equal(store.providers['github-copilot']?.[0]?.label, '@octocat', 'GitHub Copilot 即使短 access 过期也通过 refresh 识别出 @login');
    pass('classifies openai / kimi-coding / meta / openrouter accurately and resolves GitHub Copilot user via refresh token');

    // 10. 轮换型 refresh_token（anthropic / kimi-coding）防裂变 + 出口白名单 gate + Anthropic /api/oauth/profile 解析
    const tAnt1 = tAll + 3600_000;
    writeAuth({
      anthropic: { type: 'oauth', access: 'sk-ant-oat01-a1', refresh: 'sk-ant-ort01-r1', expires: tAnt1 + 3600_000 },
      'kimi-coding': { type: 'oauth', access: 'kimi-access-2', refresh: 'kimi-refresh-rotated-2', expires: tAnt1 + 3600_000 },
    });
    // kimi-coding 轮换了 refresh 但仍未解析出邮箱：不得裂变出第二段占位账号
    piAccounts.recordPiLogins(tAnt1);
    store = piAccounts.readPiLoginStore();
    assert.equal(store.providers['kimi-coding'].length, 1, '无离线身份的轮换型 provider 刷新时不裂变出新占位账号');

    // 出口白名单拒绝 claude 时，不得请求 Anthropic profile
    let antCalls = 0;
    await piAccounts.syncPiAccounts({
      now: tAnt1,
      gate: async (kind) => kind !== 'claude',
      getJson: async () => { antCalls += 1; return {}; },
    });
    assert.equal(antCalls, 0, '受出口白名单 gate 保护，放行失败时不发请求');

    // 出口白名单放行后解析 Anthropic profile
    await piAccounts.syncPiAccounts({
      now: tAnt1 + 1000,
      gate: async () => true,
      getJson: async (url) => {
        if (url === piAccounts.PI_ANTHROPIC_PROFILE_URL) {
          return { account: { uuid: 'acct-claude-uuid-1', email: 'claude-pro@example.com', display_name: 'Claude Pro' }, organization: { uuid: 'org-claude-1' } };
        }
        return {};
      },
    });
    store = piAccounts.readPiLoginStore();
    assert.equal(store.providers.anthropic.length, 1);
    assert.equal(store.providers.anthropic[0].email, 'claude-pro@example.com');
    assert.equal(store.providers.anthropic[0].sub, 'acct-claude-uuid-1');

    // Anthropic token 自动刷新（access & refresh 同时轮换，但仍是同一账号）：合并折叠回同一段，不裂变！
    const tAnt2 = tAnt1 + 1800_000;
    writeAuth({
      anthropic: { type: 'oauth', access: 'sk-ant-oat01-a2-rotated', refresh: 'sk-ant-ort01-r2-rotated', expires: tAnt2 + 3600_000 },
    });
    await piAccounts.syncPiAccounts({
      now: tAnt2,
      getJson: async (url) => {
        if (url === piAccounts.PI_ANTHROPIC_PROFILE_URL) {
          return { account: { uuid: 'acct-claude-uuid-1', email: 'claude-pro@example.com' }, organization: { uuid: 'org-claude-1' } };
        }
        return {};
      },
    });
    store = piAccounts.readPiLoginStore();
    assert.equal(store.providers.anthropic.length, 1, 'refresh 轮换后解析为同一账号时折叠为单段，不产生假换号');
    pass('prevents rotating-refresh account fission, enforces egress gate, and resolves Anthropic OAuth profile');

    // 11. providerTypes 时间线感知：api_key -> OAuth -> 登出(环境变量 API Key) 不回溯污染历史，登出后清掉旧 oauth 类型
    const tDual1 = tAnt2 + 1000_000;
    const tDual2 = tDual1 + 1000_000;
    const tDual3 = tDual2 + 1000_000;
    writeAuth({ xai: { type: 'api_key', key: 'xai-raw-key' } });
    piAccounts.recordPiLogins(tDual1);
    writeAuth({ xai: { type: 'oauth', access: makeJwt({ email: 'grok-pi@example.com', sub: 'xai-sub-1' }), refresh: 'rt-xai-1', expires: tDual2 + 3600_000 } });
    piAccounts.recordPiLogins(tDual2);
    writeAuth({}); // 登出，改用环境变量 XAI_API_KEY
    piAccounts.recordPiLogins(tDual3);
    store = piAccounts.readPiLoginStore();
    assert.equal(store.providerTypes.xai, undefined, '登出后清除旧 providerTypes，避免环境变量 API Key 永久被判成 oauth');
    assert.equal(piAccounts.isPiProviderOfficialAt('xai', tDual1 + 100, store), false, 'API Key 期间的历史请求不被后来 OAuth 污染');
    assert.equal(piAccounts.isPiProviderOfficialAt('xai', tDual2 + 100, store), true, 'OAuth 期间准确归为订阅');
    assert.equal(piAccounts.isPiProviderOfficialAt('xai', tDual3 + 100, store), false, '登出后走环境变量 API Key 准确归为 API 实付');
    pass('timeline-aware auth mode prevents api_key <-> oauth and post-logout env-key attribution pollution');

    // 12. 深度联动三家官方账号 + 额度容量折算 + 模型研究（Claude 账号在 pi 中消耗不再误判为本机以外）
    const nowStudy = Date.now();
    const wStart = nowStudy - 15 * 60_000;
    const wMid = nowStudy - 8 * 60_000;
    const wReset = nowStudy + 4 * 3600_000;
    const claudeOfficialId = 'claude:acct-claude-uuid-1';
    fs.writeFileSync(
      path.join(process.env.TOKENPULSE_DATA_DIR, 'official-accounts.json'),
      JSON.stringify({
        version: 2,
        accounts: [{
          id: claudeOfficialId,
          kind: 'claude',
          ref: 'acct-claude-uuid-1',
          email: 'claude-pro@example.com',
          label: 'claude-pro@example.com',
          alias: 'Claude 共享主力',
          createdAt: wStart - 86_400_000,
          lastSeenAt: nowStudy,
        }],
        active: { claude: claudeOfficialId },
      }),
    );
    fs.writeFileSync(
      path.join(process.env.TOKENPULSE_DATA_DIR, 'quota-history.json'),
      JSON.stringify({
        version: 1,
        accounts: {
          claude: [
            { at: wStart, account: claudeOfficialId, five: 0, fiveReset: new Date(wReset).toISOString(), week: 0, weekReset: new Date(nowStudy + 5 * 86_400_000).toISOString() },
            { at: nowStudy - 60_000, account: claudeOfficialId, five: 10, fiveReset: new Date(wReset).toISOString(), week: 5, weekReset: new Date(nowStudy + 5 * 86_400_000).toISOString() },
          ],
          chatgpt: [],
          grok: [],
        },
      }),
    );
    // 确保 anthropic 在该时段处于 OAuth 登录
    writeAuth({
      anthropic: { type: 'oauth', access: 'sk-ant-oat01-a2-rotated', refresh: 'sk-ant-ort01-r2-rotated', expires: nowStudy + 3600_000 },
    });
    piAccounts.recordPiLogins(wStart - 600_000);
    // 更新 anthropic 时间线首段确保覆盖 wStart（测试环境里 tAnt1 在未来 2026-11，这里以当前真实时间构造一段会话）
    const curStore = piAccounts.readPiLoginStore();
    curStore.providers.anthropic = [{ from: wStart - 600_000, id: piAccounts.piAccountIdOf('anthropic', 'claude-pro@example.com', 'acct-claude-uuid-1'), email: 'claude-pro@example.com', label: 'claude-pro@example.com', sub: 'acct-claude-uuid-1', mode: 'oauth' }];
    piAccounts.writePiLoginStore(curStore);

    const claudePiFile = path.join(sessionsDir, `${isoAt(wMid).replace(/[:.]/g, '-')}_sess-pi-claude.jsonl`);
    fs.writeFileSync(claudePiFile, lines([
      { type: 'session', version: 3, id: 'sess-pi-claude', timestamp: isoAt(wMid - 10_000), cwd: 'D:\\qa\\pi-claude' },
      { type: 'model_change', id: 'cmc1', parentId: null, timestamp: isoAt(wMid - 5_000), provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
      // 带 responseModel & providerThinkingLevel，验证模型核验和思考等级回退
      { type: 'message', id: 'ca1', parentId: 'cmc1', timestamp: isoAt(wMid), message: { role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-4-5', responseModel: 'claude-sonnet-4-5-20250929', providerThinkingLevel: 'high', responseId: 'msg_0123456789abcdefghijkl', usage: usage(50000, 10000, 20000, 0, 0.8), stopReason: 'stop' } },
      // 中间插入一条 usage 条目（provider 不同）：不得污染后续 toolResult 的 provider，且自身 requested 用自身 model
      { type: 'usage', id: 'cu1', parentId: 'ca1', timestamp: isoAt(wMid + 5_000), kind: 'cache_warm', provider: 'tokenpulse_route', model: 'deepseek-chat', usage: usage(100, 20, 0, 0, 0.01) },
      { type: 'message', id: 'ct1', parentId: 'cu1', timestamp: isoAt(wMid + 10_000), message: { role: 'toolResult', toolCallId: 'tc1', content: [], usage: usage(1000, 500, 0, 0, 0.05) } },
      // 末尾仅切换 model_change 不发请求：不得把纯文件归属改坏
      { type: 'model_change', id: 'cmc2', parentId: 'ct1', timestamp: isoAt(wMid + 20_000), provider: 'tokenpulse_route', modelId: 'deepseek-chat' },
    ]));

    scanLocalUsage();
    const afterClaudeRollup = readRollups().files[claudePiFile];
    assert.ok(afterClaudeRollup.accountHours?.[claudeOfficialId], 'pi 联动 Claude 官方账号后自动写入该官方账号的 accountHours');

    const claudePage = queryRequests({ from: '2020-01-01', to: '2030-12-31', source: 'pi', status: 'all', search: '', sort: 'time', page: 0, pageSize: 50, all: true, session: 'sess-pi-claude' });
    const ca1 = claudePage.rows.find((r) => r.key.endsWith(':ca1'));
    const cu1 = claudePage.rows.find((r) => r.key.endsWith(':cu1'));
    const ct1 = claudePage.rows.find((r) => r.key.endsWith(':ct1'));
    assert.equal(ca1.account?.id, claudeOfficialId, 'pi Anthropic 请求自动联动到 Claude 官方账号 ID');
    assert.equal(ca1.account?.label, 'Claude 共享主力', '自动复用 Claude 官方账号别名');
    assert.equal(ca1.returned, 'claude-sonnet-4-5-20250929', '读取 pi AssistantMessage.responseModel');
    assert.equal(ca1.status, 'match', '有 responseModel 时正常核验型号一致');
    assert.equal(ca1.effort, 'high', '回退读取 providerThinkingLevel');
    assert.equal(cu1.requested, 'deepseek-chat', 'usage 条目使用自身 model 作为 requested');
    assert.equal(ct1.provider, 'anthropic', 'usage 条目不污染后续 toolResult 继承的 provider');

    const capRows = queryRequests({ from: '2020-01-01', to: '2030-12-31', source: 'all', status: 'all', search: '', sort: 'time', page: 0, pageSize: 50, all: true, channel: 'official', capacityOnly: true }).rows;
    assert.ok(capRows.some((r) => r.source === 'pi' && r.account?.id === claudeOfficialId), 'capacityOnly 查询包含联动到官方账号的 pi 请求');

    const study = queryModelStudy({ kind: 'claude', accountId: claudeOfficialId });
    assert.ok(study.five.totals.records >= 2, `模型研究纳入 pi 的 Claude 请求（got ${study.five.totals.records}）`);
    assert.equal(study.five.attribution.localCoincidentPoints, 10, `pi 请求参与额度归因、不再被误判为本机以外（got ${JSON.stringify(study.five.attribution)}）`);
    assert.equal(study.five.attribution.unmatchedPoints, 0);
    const snapWithPiQuota = buildSnapshot(nowStudy);
    const claudeAccReport = snapWithPiQuota.accounts.find((a) => a.accountId === claudeOfficialId);
    assert.ok(claudeAccReport?.five?.capacity?.tokens > 0, `buildSnapshot 用 pi 的 Claude 请求成功折算整窗容量（got ${JSON.stringify(claudeAccReport?.five)}）`);
    pass('links pi Anthropic/OpenAI/xAI accounts to official quota capacity, model study, responseModel & providerThinkingLevel');

    // 13. 设置页只读视图、独立别名与删除历史记录 + PI_CODING_AGENT_SESSION_DIR 独立目录支持
    const status1 = piAccounts.listPiAccountStatus(nowStudy);
    assert.equal(status1.installed, true);
    assert.ok(status1.accounts.some((a) => a.provider === 'anthropic' && a.linkedOfficialId === claudeOfficialId));
    assert.ok(status1.accounts.some((a) => a.id === aliceId && a.inAuth === false));

    const renamed = piAccounts.renamePiAccount(aliceId, '我的 Google Ultra');
    assert.equal(renamed.accounts.find((a) => a.id === aliceId)?.alias, '我的 Google Ultra');
    const aliasedOwn = queryRequests({ from: '2026-11-01', to: '2026-11-30', source: 'pi', status: 'all', search: '', sort: 'time', page: 0, pageSize: 50, all: true, account: aliceId });
    assert.ok(aliasedOwn.rows.every((r) => r.account?.label === '我的 Google Ultra'), '独立的 pi 别名优先级高于共享别名并立即生效');

    const rawAuthPreRemove = fs.readFileSync(authPath, 'utf8');
    const removed = piAccounts.removePiAccount(aliceId);
    assert.equal(removed.accounts.some((a) => a.id === aliceId), false, '已登出历史记录可安全清理');
    assert.equal(fs.readFileSync(authPath, 'utf8'), rawAuthPreRemove, '清理历史记录绝不触碰 auth.json');

    const customSessDir = path.join(root, 'custom-pi-sessions', '--D--custom--');
    fs.mkdirSync(customSessDir, { recursive: true });
    const customSessFile = path.join(customSessDir, `${isoAt(nowStudy - 30_000).replace(/[:.]/g, '-')}_sess-custom-dir.jsonl`);
    fs.writeFileSync(customSessFile, lines([
      { type: 'session', version: 3, id: 'sess-custom-dir', timestamp: isoAt(nowStudy - 30_000), cwd: 'D:\\custom-dir' },
      { type: 'message', id: 'cd1', parentId: null, timestamp: isoAt(nowStudy - 20_000), message: { role: 'user', content: 'hello custom dir' } },
      { type: 'message', id: 'cd2', parentId: 'cd1', timestamp: isoAt(nowStudy - 15_000), message: { role: 'assistant', provider: 'kimi-coding', model: 'kimi-k2', usage: usage(200, 100, 0, 0, 0.05), stopReason: 'stop' } },
    ]));
    process.env.PI_CODING_AGENT_SESSION_DIR = path.join(root, 'custom-pi-sessions');
    try {
      const customScan = scanLocalUsage();
      assert.equal(customScan.records.length, 1, 'PI_CODING_AGENT_SESSION_DIR 覆盖生效于用量扫描');
      assert.ok(listSessions().some((s) => s.kind === 'pi' && s.id === 'sess-custom-dir'), 'PI_CODING_AGENT_SESSION_DIR 覆盖生效于会话列表');
    } finally {
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
    }
    pass('supports Settings read-only status/rename/remove and PI_CODING_AGENT_SESSION_DIR override');

    console.log(`${checks}/${checks} pi account checks passed`);
  } finally {
    piAccounts.resetPiSyncCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
