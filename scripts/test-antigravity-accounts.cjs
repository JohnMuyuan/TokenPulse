/*
 * Google Antigravity 多账号管理、PKCE OAuth 授权登录、自动续期与 Cloud Code 直连配额单元测试。
 * 使用一次性临时目录，不触碰真实 ~/.tokenpulse 与 ~/.gemini。
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-agy-accounts-'));
const dataDir = path.join(root, 'data');
const agyDir = path.join(root, 'antigravity');
Object.assign(process.env, {
  TOKENPULSE_DATA_DIR: dataDir,
  TOKENPULSE_ANTIGRAVITY_DIR: agyDir,
});
fs.mkdirSync(path.join(agyDir, 'daemon'), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

(async () => {
  let checks = 0;
  const pass = (name) => { checks += 1; console.log('PASS ' + name); };
  let hubServer = null;

  try {
    const mod = require('../build/core/antigravity-accounts');

    // 1. 确定性身份哈希与显示名脱敏
    const ref1 = mod.agyRefFromIdentity('Alice@Example.com ');
    const ref2 = mod.agyRefFromIdentity('alice@example.com');
    assert.equal(ref1, ref2, '邮箱忽略大小写与空白归一化');
    assert.equal(mod.agyAccountIdOf(ref1), `antigravity:${ref1}`);
    assert.deepEqual(mod.agyDisplayNames([{ email: 'alice@example.com' }]), [''], '单账号无别名时不暴露裸邮箱');
    assert.deepEqual(
      mod.agyDisplayNames([{ email: 'alice@example.com' }, { email: 'bob@example.com' }]),
      ['alice', 'bob'],
      '多账号默认取邮箱 @ 前缀',
    );
    assert.deepEqual(
      mod.agyDisplayNames([{ email: 'dev@personal.test' }, { email: 'dev@corp.test' }]),
      ['dev@personal.test', 'dev@corp.test'],
      '前缀重名时展示完整邮箱区分',
    );
    pass('identity hash normalization and privacy-aware display names');

    // 2. 本机运行中 Antigravity 账号的一键登记 + 本机登录切换时间线归属
    let currentLocalEmail = 'alice@example.com';
    hubServer = http.createServer((req, res) => {
      assert.equal(req.headers['x-codeium-csrf-token'], 'test-csrf-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.endsWith('/GetUserStatus')) {
        res.end(JSON.stringify({
          userStatus: {
            email: currentLocalEmail,
            name: 'Alice Dev',
            userTier: { name: 'Google AI Pro' },
            planStatus: { planInfo: { planName: 'Pro' } },
            cascadeModelConfigData: {
              clientModelConfigs: [
                { label: 'Gemini 4 Argon (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M37' }, quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-18T10:00:00Z' } },
              ],
            },
          },
        }));
      } else {
        res.end(JSON.stringify({ quotaSummaryGroups: [] }));
      }
    });
    await new Promise((r) => hubServer.listen(0, '127.0.0.1', r));
    const hubPort = hubServer.address().port;
    fs.writeFileSync(path.join(agyDir, 'daemon', `hub_${process.pid}.json`), JSON.stringify({
      pid: process.pid,
      httpPort: hubPort,
      csrfToken: 'test-csrf-token',
    }));

    const t0 = Date.UTC(2026, 10, 17, 8, 0, 0);
    const addedRes = await mod.addLocalAgyAccount(t0);
    assert.equal(addedRes.added, true);
    assert.equal(addedRes.status.accounts.length, 1);
    const aliceId = addedRes.status.accounts[0].id;
    assert.equal(addedRes.status.accounts[0].inLocal, true);
    assert.equal(addedRes.status.accounts[0].cloudAuth, false, '仅登记本机登录时不保存独立 OAuth 凭据');
    assert.equal(mod.readAgyAccountStore().accounts[0].credential, undefined);

    const dupRes = await mod.addLocalAgyAccount(t0 + 1000);
    assert.equal(dupRes.added, false, '同一本机账号重复添加不会产生两条记录');

    // 模拟本机切到第二个账号 bob@example.com，校验时间线把早晚请求准确归属给对应账号
    currentLocalEmail = 'bob@example.com';
    const bobRes = await mod.addLocalAgyAccount(t0 + 3600_000);
    const bobId = bobRes.status.accounts.find((a) => a.email === 'bob@example.com').id;
    const timeline = mod.readAgyLoginTimeline();
    assert.equal(timeline.length, 2);
    assert.equal(mod.resolveAgyLocalOwner(t0 + 1800_000, timeline), aliceId, '切换前的本机请求归属给 Alice');
    assert.equal(mod.resolveAgyLocalOwner(t0 + 5400_000, timeline), bobId, '切换后的本机请求归属给 Bob');
    pass('local Antigravity session adoption and login timeline request ownership');

    // 3. 运行期提取本机客户端 OAuth 配置（含多客户端企业版干扰项过滤、aicode 作用域匹配、401 密钥自动回退）+ Google OAuth 2.0 PKCE 环回授权登录
    const hostTail = ['apps', 'googleusercontent', 'com'].join('.');
    const secHead = 'GOC' + 'SPX-';
    const fakeClientId = ['123456789012-synthetictestclient00000000', hostTail].join('.');
    const fakeClientSecret = secHead + 'synthetic_unit_test_only_0000';
    const fakeAsarPath = path.join(root, 'fake-app.asar');
    fs.writeFileSync(fakeAsarPath, `/* mock bundle */ const cfg={clientId:"${fakeClientId}",clientSecret:"${fakeClientSecret}"};`);
    const extracted = mod.extractAgyOAuthClientFromFile(fakeAsarPath);
    assert.deepEqual(extracted, { clientId: fakeClientId, clientSecret: fakeClientSecret });

    // 模拟真实 Antigravity 安装目录：app.asar 先声明无 aicode 的企业版 clientId、再声明带 auth/aicode 的个人版 clientId；
    // language_server 二进制字符串表无引号拼接 3 套 clientId 与 3 套 35 字符密钥，验证不会误取第 0 个企业版 clientId（避免 403 restricted_client）
    const fakeIdeResources = path.join(root, 'fake-ide', 'resources');
    fs.mkdirSync(path.join(fakeIdeResources, 'bin'), { recursive: true });
    const bizId = ['888888888888-bizdecoywithoutaicode00000', hostTail].join('.');
    const personalId = ['111111111111-personalwithaicodescope000', hostTail].join('.');
    const driveId = ['999999999999-drivedecoyclient0000000000', hostTail].join('.');
    const bizSec = secHead + 'biz_decoy_secret_'.padEnd(28, '1');
    const personalSec = secHead + 'personal_valid_sec_'.padEnd(28, '2');
    const driveSec = secHead + 'drive_decoy_secret_'.padEnd(28, '3');

    fs.writeFileSync(
      path.join(fakeIdeResources, 'app.asar'),
      `const SIGN_IN_CLIENTS={business:{clientId:'${bizId}',scopes:['openid']},personal:{clientId:'${personalId}',scopes:['openid','https://www.googleapis.com/auth/aicode']}};`,
    );
    const mockGoBinary = path.join(fakeIdeResources, 'bin', 'language_server.exe');
    fs.writeFileSync(
      mockGoBinary,
      `rodata_head_${bizSec}middle${personalSec}tail${driveSec}end_ids:${bizId}sep${personalId}sep${driveId}_eof`,
    );
    process.env.TOKENPULSE_AGY_OAUTH_BINARY = mockGoBinary;
    mod.clearCachedAgyOAuthClient();
    try {
      const resolvedMulti = mod.resolveAntigravityOAuthClient();
      assert.ok(resolvedMulti, '应从多客户端二进制中成功解析 OAuth 客户端');
      assert.equal(resolvedMulti.clientId, personalId, '必须精准选中声明了 auth/aicode 的个人版 clientId 而非首个企业版');
      assert.equal(resolvedMulti.clientSecret, personalSec, '应优先匹配同下标个人版密钥');
      assert.equal(resolvedMulti.candidateSecrets.length, 3, '应保留全部候选密钥供自动回退');
    } finally {
      delete process.env.TOKENPULSE_AGY_OAUTH_BINARY;
      mod.clearCachedAgyOAuthClient();
    }

    // 验证候选密钥在未来版本顺序变化触发 401 invalid_client 时可自动回退并缓存正确密钥
    const fallbackClient = {
      clientId: personalId,
      clientSecret: bizSec,
      candidateSecrets: [bizSec, personalSec],
    };
    const triedSecrets = [];
    const fallbackRefresh = await mod.refreshAgyCredential(
      { token: 'old', refreshToken: 'rt_test', expiresAt: 0 },
      t0,
      {
        oauthClient: fallbackClient,
        postForm: async (_url, body) => {
          const sec = new URLSearchParams(body).get('client_secret');
          triedSecrets.push(sec);
          if (sec !== personalSec) {
            return { status: 401, json: { error: 'invalid_client' } };
          }
          return { status: 200, json: { access_token: 'tp_fallback_ok', expires_in: 3600 } };
        },
      },
    );
    assert.equal(fallbackRefresh.ok, true, '首个候选密钥返回 401 invalid_client 时应自动切换下一候选密钥成功续期');
    assert.deepEqual(triedSecrets, [bizSec, personalSec]);
    assert.equal(fallbackClient.clientSecret, personalSec, '回退成功后应原位修正生效密钥');

    let capturedVerifier = '';
    let capturedChallenge = '';
    const secretAccess = 'tp_mock_access_token_value_123456';
    const secretRefresh = 'tp_mock_refresh_token_value_654321';
    const secretCode = 'tp_mock_auth_code_999';
    const mockOAuthClient = { clientId: 'mock-agy-client-id', clientSecret: 'mock-agy-client-secret' };

    const oauthRes = await mod.loginAntigravityOAuth(aliceId, {
      oauthClient: mockOAuthClient,
      openExternal: async (authUrl) => {
        const parsed = new URL(authUrl);
        assert.equal(parsed.origin + parsed.pathname, mod.AGY_OAUTH_AUTH_URL);
        assert.equal(parsed.searchParams.get('client_id'), mockOAuthClient.clientId);
        assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(parsed.searchParams.get('access_type'), 'offline');
        assert.equal(parsed.searchParams.get('prompt'), 'consent');
        capturedChallenge = parsed.searchParams.get('code_challenge');
        const state = parsed.searchParams.get('state');
        const redirectUri = parsed.searchParams.get('redirect_uri');

        // 错误 state 应被环回服务 400 拦截，不结束等待
        const bad = await httpGet(`${redirectUri}?code=evil&state=wrong-state`);
        assert.equal(bad.status, 400);

        // 正确回调放行
        const ok = await httpGet(`${redirectUri}?code=${encodeURIComponent(secretCode)}&state=${encodeURIComponent(state)}`);
        assert.equal(ok.status, 200);
      },
      postForm: async (url, body) => {
        assert.equal(url, mod.AGY_OAUTH_TOKEN_URL);
        const params = new URLSearchParams(body);
        assert.equal(params.get('code'), secretCode);
        assert.equal(params.get('client_id'), mockOAuthClient.clientId);
        assert.equal(params.get('client_secret'), mockOAuthClient.clientSecret);
        capturedVerifier = params.get('code_verifier');
        const expectedChallenge = crypto.createHash('sha256').update(capturedVerifier).digest('base64url');
        assert.equal(expectedChallenge, capturedChallenge, 'PKCE S256 verifier 与 challenge 严格匹配');
        return {
          status: 200,
          json: {
            access_token: secretAccess,
            refresh_token: secretRefresh,
            expires_in: 3600,
          },
        };
      },
      getJson: async (url, headers) => {
        assert.equal(url, mod.AGY_USERINFO_URL);
        assert.ok(headers.some((h) => h.includes(`Bearer ${secretAccess}`)));
        return { email: 'alice@example.com', id: 'google-uid-alice', name: 'Alice' };
      },
    });
    assert.equal(oauthRes.ok, true);
    const upgradedAlice = oauthRes.status.accounts.find((a) => a.id === aliceId);
    assert.ok(upgradedAlice, '原位升级后保持相同的账号 ID');
    assert.equal(upgradedAlice.cloudAuth, true);
    assert.equal(upgradedAlice.autoRenew, true);

    const { loginLogFile } = require('../build/core/login-log');
    const logContent = fs.readFileSync(loginLogFile(), 'utf8');
    assert.ok(!logContent.includes(secretAccess) && !logContent.includes(secretRefresh) && !logContent.includes(secretCode), '登录日志不得包含任何真实令牌或授权码');
    pass('PKCE S256 loopback OAuth login, CSRF state guard, in-place upgrade, and redacted login log');

    // 4. 自动续期与永久失效标记
    const storeBeforeRenew = mod.readAgyAccountStore();
    storeBeforeRenew.accounts.find((a) => a.id === aliceId).credential.expiresAt = t0 + 60_000; // 即将过期
    mod.writeAgyAccountStore(storeBeforeRenew);

    const renewedCount = await mod.renewAgyCredentials(t0, (cred, at) =>
      mod.refreshAgyCredential(cred, at, {
        oauthClient: mockOAuthClient,
        postForm: async (_url, body) => {
          const params = new URLSearchParams(body);
          assert.equal(params.get('grant_type'), 'refresh_token');
          assert.equal(params.get('refresh_token'), secretRefresh);
          return { status: 200, json: { access_token: 'tp_mock_renewed_access_token', expires_in: 3600 } };
        },
      }),
    );
    assert.equal(renewedCount, 1);
    const afterRenew = mod.readAgyAccountStore().accounts.find((a) => a.id === aliceId);
    assert.equal(afterRenew.credential.token, 'tp_mock_renewed_access_token');
    assert.equal(afterRenew.credential.refreshToken, secretRefresh, 'Google 未轮换 refresh_token 时保留原续期令牌');

    // 模拟 400 invalid_grant 永久拒绝（切走本机当前账号以验证 needsLogin）
    afterRenew.credential.expiresAt = t0 - 1000;
    mod.writeAgyAccountStore({ version: 1, accounts: [afterRenew, mod.readAgyAccountStore().accounts.find((a) => a.id === bobId)] });
    await mod.renewAgyCredentials(t0, (cred, at) =>
      mod.refreshAgyCredential(cred, at, {
        oauthClient: mockOAuthClient,
        postForm: async () => ({ status: 400, json: { error: 'invalid_grant' } }),
      }),
    );
    const statusAfterRevoke = await mod.listAgyAccountStatus(t0, 'bob@example.com');
    const revokedAlice = statusAfterRevoke.accounts.find((a) => a.id === aliceId);
    assert.equal(revokedAlice.needsLogin, true, 'refresh_token 被拒且不在本机登录时标记 needsLogin');
    assert.equal(revokedAlice.autoRenew, false);
    const { readRenewLog } = require('../build/core/renew-log');
    const renewEntries = readRenewLog(20).filter((row) => row.kind === 'antigravity');
    assert.ok(renewEntries.some((row) => row.ok === true), 'Antigravity 续期成功写入 renew-log');
    assert.ok(renewEntries.some((row) => row.ok === false && row.status === 400 && row.code === 'invalid_grant' && row.permanent === true), 'Antigravity 续期永久拒绝写入 renew-log（供体检展示）');
    pass('automatic credential renewal and permanent invalid_grant detection');

    // 5. Cloud Code 直连配额解析（含残缺 3P 单组响应自动故障转移 + 防跨池误并入 + plan 格式化去重）
    const endpointsHit = [];
    const cloudRes = await mod.fetchAntigravityCloudStatus(
      { token: 'tp_mock_cloud_test' },
      {
        postJson: async (url, body, headers) => {
          assert.ok(headers.some((h) => /^User-Agent:\s*antigravity\/\d+\.\d+/i.test(h)), '必须携带带版本号的 Antigravity User-Agent 以免服务端裁剪 Gemini 分组');
          endpointsHit.push(url);
          if (url.startsWith('https://daily-cloudcode-pa.googleapis.com')) {
            if (url.endsWith(':loadCodeAssist')) {
              return { status: 200, json: { cloudaicompanionProject: 'agy-proj-daily', paidTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' } } };
            }
            if (url.endsWith(':fetchAvailableModels')) {
              return {
                status: 200,
                json: {
                  models: {
                    'gemini-3-flash': { displayName: 'Gemini 3 Flash', model: 'MODEL_PLACEHOLDER_M18', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-18T12:00:00Z' } },
                    'gemini-2.5-flash': { displayName: 'Gemini 3.5 Flash Lite', model: 'MODEL_GOOGLE_GEMINI_2_5_FLASH', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-18T12:00:00Z' } },
                    'gemini-3.5-flash-lite': { displayName: 'Gemini 3.5 Flash Lite', model: 'MODEL_PLACEHOLDER_M198', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-18T12:00:00Z' } },
                    'claude-opus-5-5-low': { displayName: 'Claude Opus 5.5 (Low)', model: 'MODEL_PLACEHOLDER_M400', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-18T12:00:01Z' } },
                  },
                },
              };
            }
            // 模拟残缺响应：只返 Claude and GPT models、漏掉 Gemini Models；应继续尝试备用端点而不是污染合并
            return {
              status: 200,
              json: {
                groups: [{
                  displayName: 'Claude and GPT models',
                  buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-18T12:00:01Z' }],
                }],
              },
            };
          }
          if (url.endsWith(':loadCodeAssist')) {
            return {
              status: 200,
              json: {
                cloudaicompanionProject: { id: 'agy-proj-42' },
                g1Tier: 'g1-ultra-lite-tier',
                paidTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra', availableCredits: [{ creditAmount: 500 }] },
              },
            };
          }
          if (url.endsWith(':fetchAvailableModels')) {
            assert.equal(JSON.parse(body).project, 'agy-proj-42');
            return {
              status: 200,
              json: {
                models: {
                  'claude-opus-5-5-low': {
                    displayName: 'Claude Opus 5.5 (Thinking)',
                    model: 'MODEL_CLAUDE_OPUS',
                    quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-18T14:00:00Z' },
                  },
                  'gemini-3.8-flash-high': {
                    displayName: 'Gemini 3.8 Flash (High)',
                    model: 'MODEL_PLACEHOLDER_M318',
                    quotaInfo: { remainingFraction: 0.65, resetTime: '2026-11-18T12:00:00Z' },
                  },
                  'gemini-2.5-flash': {
                    displayName: 'Gemini 3.5 Flash Lite',
                    model: 'MODEL_GOOGLE_GEMINI_2_5_FLASH',
                    quotaInfo: { remainingFraction: 0.65, resetTime: '2026-11-18T12:00:00Z' },
                  },
                  'gemini-3.5-flash-lite': {
                    displayName: 'Gemini 3.5 Flash Lite',
                    model: 'MODEL_PLACEHOLDER_M198',
                    quotaInfo: { remainingFraction: 0.65, resetTime: '2026-11-18T12:00:00Z' },
                  },
                },
              },
            };
          }
          return {
            status: 200,
            json: {
              quotaSummaryGroups: [
                {
                  groupName: 'Gemini Models',
                  fiveHourQuota: { remainingFraction: 0.65, resetTime: '2026-11-18T12:00:00Z' },
                  weeklyQuota: { remainingFraction: 0.82, resetTime: '2026-11-22T00:00:00Z' },
                },
                {
                  groupName: 'Claude and GPT models',
                  fiveHourQuota: { remainingFraction: 0.9, resetTime: '2026-11-18T14:00:00Z' },
                  weeklyQuota: { remainingFraction: 0.95, resetTime: '2026-11-23T00:00:00Z' },
                },
              ],
            },
          };
        },
      },
    );
    assert.equal(cloudRes.projectId, 'agy-proj-42');
    assert.equal(cloudRes.status.tier, 'Google AI Ultra');
    assert.equal(cloudRes.status.plan, 'Ultra Lite');
    assert.equal(cloudRes.status.groups.length, 2);
    assert.ok(cloudRes.status.groups[0].title.includes('Gemini'), 'Gemini 组始终排在首位且不被降级合并');
    assert.equal(cloudRes.status.groups[0].used, 35);
    assert.equal(cloudRes.status.groups[0].week.used, 18);
    assert.equal(cloudRes.status.groups[1].used, 10);
    assert.equal(cloudRes.status.models.filter((m) => m.family === 'Gemini 3.5 Flash Lite').length, 1, '同显示名多别名去重保留主条目');
    assert.equal(cloudRes.status.credits.availablePromptCredits, 500);
    assert.ok(endpointsHit.some((u) => u.startsWith('https://daily-cloudcode-pa.googleapis.com')) && endpointsHit.some((u) => u.startsWith('https://cloudcode-pa.googleapis.com')), '主端点返回残缺单组时自动切换备用端点补齐双组');

    // 即便 summaryGroups 缺少 Gemini 分组且两个未使用池重置时间接近，也绝不能把 Gemini 塞进 Claude 组
    const isolatedRes = mod.parseAntigravityCloudQuota(
      { paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } },
      {
        models: {
          'claude-opus-5-5-low': { displayName: 'Claude Opus 5.5 (Low)', model: 'M400', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-18T12:00:01Z' } },
          'gemini-3-flash': { displayName: 'Gemini 3 Flash', model: 'M18', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-18T12:00:00Z' } },
        },
      },
      {
        groups: [{
          displayName: 'Claude and GPT models',
          buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-18T12:00:01Z' }],
        }],
      },
    );
    assert.equal(isolatedRes.status.plan, 'Ultra');
    assert.equal(isolatedRes.status.groups.length, 2, '缺少 Gemini 摘要桶时仍保留独立的 Gemini 与 Claude 两个分组');
    assert.equal(isolatedRes.status.groups[0].models.some((m) => /Claude/i.test(m)), false);
    assert.equal(isolatedRes.status.groups[1].models.some((m) => /Gemini/i.test(m)), false);

    // 存在 agentModelSorts 时，只展示活跃列表中的非内部模型；未列出的旧版/内部模型仅保留 labels 供历史回查，不污染分组档位
    const sortedRes = mod.parseAntigravityCloudQuota(
      { paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } },
      {
        agentModelSorts: [
          { groups: [{ modelIds: ['gemini-3.8-flash-high', 'claude-opus-5-5-high'] }] },
        ],
        models: {
          'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', model: 'MODEL_PLACEHOLDER_M318', quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-18T12:00:00Z' } },
          'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)', model: 'MODEL_PLACEHOLDER_M402', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-18T14:00:00Z' } },
          'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro', model: 'MODEL_GOOGLE_GEMINI_2_5_PRO', quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-18T12:00:00Z' } },
          'gemini-3.1-flash-image': { displayName: 'Gemini 3.1 Flash Image', model: 'MODEL_PLACEHOLDER_M21', isInternal: true, quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-18T12:00:00Z' } },
        },
      },
    );
    assert.deepEqual(sortedRes.status.groups[0].models, ['Gemini 3.8 Flash'], '未列入 agentModelSorts 的旧模型不混入组内档位');
    assert.equal(sortedRes.status.models.some((m) => /2\.5 Pro|Image/i.test(m.label)), false);
    assert.equal(sortedRes.status.labels.MODEL_GOOGLE_GEMINI_2_5_PRO, 'Gemini 2.5 Pro', '旧模型标签仍保留供历史对话解析');
    pass('Cloud Code direct quota parsing, dual-window merge, incomplete-group failover, and cross-pool isolation');

    // 6. 账号排序、重命名、共享模式切换、隐藏/恢复与完全删除
    mod.reorderAgyAccounts([bobId, aliceId]);
    assert.deepEqual(mod.readAgyAccountStore().accounts.map((a) => a.id), [bobId, aliceId]);

    await mod.manageAgyAccount('rename', aliceId, '家庭主号', t0);
    await mod.manageAgyAccount('share-mode', aliceId, 'family', t0);
    let st = await mod.listAgyAccountStatus(t0, 'bob@example.com');
    assert.equal(st.accounts.find((a) => a.id === aliceId).alias, '家庭主号');
    assert.equal(st.accounts.find((a) => a.id === aliceId).shareMode, 'family');

    // Bob 当前正在本机登录：remove 只隐藏，restore 可恢复
    st = await mod.manageAgyAccount('remove', bobId, '', t0);
    assert.equal(st.accounts.find((a) => a.id === bobId).hidden, true, '本机当前登录账号普通删除时变为隐藏');
    st = await mod.manageAgyAccount('restore', bobId, '', t0);
    assert.equal(st.accounts.find((a) => a.id === bobId).hidden, false);

    // purge 彻底移除
    st = await mod.manageAgyAccount('purge', aliceId, '', t0);
    assert.equal(st.accounts.some((a) => a.id === aliceId), false);
    pass('account reorder, rename, share-mode, hide/restore, and purge');

    // 7. 用量明细请求流水多账号归属（时间线 + 推断 + 别名 + 官方渠道 + 零配置隐私回退）
    mod.rememberAgyAccount({ email: 'alice@example.com', label: 'alice@example.com', credential: { token: 'syn-tok', expiresAt: t0 + 7200_000 } }, true, t0);
    mod.renameAgyAccount(aliceId, '主号 Alice');
    const reqLog = require('../build/core/request-log');
    reqLog.appendRequests([
      { id: 'agy-pre', at: t0 - 600_000, kind: 'antigravity', file: 'conv-pre.db', model: 'gemini-4-argon', input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.01, calls: 1 },
      { id: 'agy-alice', at: t0 + 600_000, kind: 'antigravity', file: 'conv-a.db', model: 'gemini-4-argon', input: 200, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.02, calls: 1 },
      { id: 'agy-bob', at: t0 + 4200_000, kind: 'antigravity', file: 'conv-b.db', model: 'claude-opus-5-5', input: 300, output: 60, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.03, calls: 1 },
    ]);
    const dayStr = new Date(t0).toISOString().slice(0, 10);
    const reqRes = reqLog.queryRequests({ from: '2026-01-01', to: '2027-01-01', source: 'Antigravity', status: 'all', channel: 'official', search: '', sort: 'time', page: 0, pageSize: 20, all: true });
    assert.equal(reqRes.total, 3, 'Antigravity 请求按官方渠道查询全部命中');
    const rowPre = reqRes.rows.find((r) => r.key.endsWith('agy-pre'));
    const rowAlice = reqRes.rows.find((r) => r.key.endsWith('agy-alice'));
    const rowBob = reqRes.rows.find((r) => r.key.endsWith('agy-bob'));
    assert.equal(rowPre.official, true);
    assert.deepEqual(rowPre.account, { id: aliceId, label: '主号 Alice', basis: 'inferred' });
    assert.deepEqual(rowAlice.account, { id: aliceId, label: '主号 Alice', basis: 'timeline' });
    assert.deepEqual(rowBob.account, { id: bobId, label: 'bob@example.com', basis: 'timeline' });
    assert.equal(reqRes.accounts.some((a) => a.id === 'none'), false, '不再把 Antigravity 请求归进账号未知');
    const bobOnly = reqLog.queryRequests({ from: '2026-01-01', to: '2027-01-01', source: 'Antigravity', account: bobId, status: 'all', search: '', sort: 'time', page: 0, pageSize: 20, all: true });
    assert.equal(bobOnly.total, 1);
    assert.equal(bobOnly.rows[0].key, rowBob.key);
    assert.ok(dayStr);

    mod.rememberAgyAccount({ email: 'bob@example.com', label: 'bob@example.com', credential: { token: 'fixture-b', expiresAt: t0 + 7200_000 } }, true, t0);
    const { AntigravityQuota } = require('../build/main/antigravity-quota');
    const refreshed = [];
    let begin, release;
    const started = new Promise((resolve) => { begin = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    const quota = new AntigravityQuota({
      now: () => t0, fetcher: async () => null,
      cloudFetcher: async (account) => {
        refreshed.push(account.id);
        if (account.id === aliceId) { begin(); await held; }
        return { status: { plan: 'Pro', groups: [], labels: {} } };
      },
    });
    const alicePoll = quota.refresh(true, aliceId);
    await started;
    const sameAlicePoll = quota.refresh(true, aliceId);
    const bobPoll = quota.refresh(true, bobId);
    release();
    await Promise.all([alicePoll, sameAlicePoll, bobPoll]);
    assert.deepEqual(refreshed, [aliceId, bobId], '两个账号分别刷新，同一账号合并');
    pass('concurrent manual refreshes coalesce only for the same account');

    // 零配置（antigravity-accounts.json 为空）：只显示脱敏「本机 Antigravity」，不泄漏邮箱
    fs.rmSync(path.join(dataDir, 'antigravity-accounts.json'), { force: true });
    const zeroRes = reqLog.queryRequests({ from: '2026-01-01', to: '2027-01-01', source: 'Antigravity', status: 'all', search: '', sort: 'time', page: 0, pageSize: 20, all: true });
    assert.equal(zeroRes.rows.find((r) => r.key === rowBob.key).account.label, '本机 Antigravity');
    pass('Antigravity multi-account usage attribution, official channel, account filter, and zero-config privacy fallback');

    // 9. raw-fs / asarContainsFile 校验（支持标准 ASAR 二进制头、目录回退、缺失与损坏文件，无句柄残留）
    const { asarContainsFile } = require('../build/core/raw-fs');
    const makeAsar = (target, tree, payload) => {
      const headerBuf = Buffer.from(JSON.stringify({ files: tree }), 'utf8');
      const padLen = (4 - (headerBuf.length % 4)) % 4;
      const headerPicklePayload = 4 + headerBuf.length + padLen;
      const headerPickleSize = 4 + headerPicklePayload;
      const out = Buffer.alloc(8 + headerPickleSize + payload.length);
      out.writeUInt32LE(4, 0);
      out.writeUInt32LE(headerPickleSize, 4);
      out.writeUInt32LE(headerPicklePayload, 8);
      out.writeUInt32LE(headerBuf.length, 12);
      headerBuf.copy(out, 16);
      payload.copy(out, 8 + headerPickleSize);
      fs.writeFileSync(target, out);
    };
    const asarFile = path.join(root, 'sample.asar');
    const payload = Buffer.from('console.log("ok");', 'utf8');
    makeAsar(asarFile, { dsh: { files: { 'cli.js': { size: payload.length, offset: '0' } } } }, payload);
    assert.equal(asarContainsFile(asarFile, 'dsh/cli.js'), true, '能命中合法 ASAR 归档内的文件');
    assert.equal(asarContainsFile(asarFile, 'dsh\\cli.js'), true, '兼容 Windows 反斜杠路径');
    assert.equal(asarContainsFile(asarFile, 'dsh'), false, '目录节点不误判为文件');
    assert.equal(asarContainsFile(asarFile, 'dsh/missing.js'), false, '不存在的内部路径返回 false');
    const corruptAsar = path.join(root, 'corrupt.asar');
    fs.writeFileSync(corruptAsar, Buffer.from([1, 2, 3, 4, 5]));
    assert.equal(asarContainsFile(corruptAsar, 'dsh/cli.js'), false, '损坏或截断的 ASAR 安全降级');
    assert.equal(asarContainsFile(path.join(root, 'absent.asar'), 'dsh/cli.js'), false, '缺失文件安全返回 false');
    pass('raw-fs asarContainsFile handles valid archives, missing entries, and truncated files cleanly');

    // 10. Antigravity 一键切换账号（系统凭据槽写入、自动续期、抢救换下凭据、停/启桌面端、app_storage 更新与失败回滚）
    const sw = require('../build/core/antigravity-switch');
    const swAppData = path.join(root, 'roaming');
    const swAppStorage = path.join(swAppData, 'Antigravity', 'app_storage.json');
    fs.mkdirSync(path.dirname(swAppStorage), { recursive: true });
    fs.writeFileSync(swAppStorage, JSON.stringify({
      keepComputerAwake: 'true',
      'agy.onboarding.lastLoginUsername': 'local-old@example.com',
      'agy.onboarding.lastLoginIsGcpTos': 'false',
    }, null, 2));
    const swMockExe = path.join(root, 'fake-agy', 'Antigravity.exe');
    fs.mkdirSync(path.dirname(swMockExe), { recursive: true });
    fs.writeFileSync(swMockExe, 'stub');

    const tSw = Date.UTC(2026, 10, 24, 8, 0, 0);
    mod.writeAgyAccountStore({ version: 1, accounts: [] });
    const localOnlyId = mod.rememberAgyAccount({ email: 'local-old@example.com', label: 'local-old@example.com' }, false, tSw);
    const targetBId = mod.rememberAgyAccount({
      email: 'target-b@example.com',
      label: 'target-b@example.com',
      credential: { token: 'expired-b-tok', refreshToken: '1//refresh-target-b', expiresAt: tSw - 1000, projectId: 'proj-b' },
    }, true, tSw);

    // 10a. 未保存 OAuth 凭据的账号拒绝切换并给出明确提示
    let rejectedNoAuth = false;
    try {
      await sw.switchAntigravityAccount(localOnlyId, { now: () => tSw, appDataDir: swAppData, readKeyring: () => null, listProcesses: () => [] });
    } catch (err) {
      rejectedNoAuth = /重新授权/.test(err.message);
    }
    assert.equal(rejectedNoAuth, true, '未授权账号拒绝切换并引导重新授权');

    // 10b. 运行中切换：先自动续期 → 抢救换下账号凭据 → 停止进程 → 备份 → 写入并核验 → 更新 app_storage → 重启桌面端
    let memKeyring = JSON.stringify({
      token: { access_token: 'ya29.outgoing-old', token_type: 'Bearer', refresh_token: '1//refresh-outgoing-old', expiry: new Date(tSw + 3600_000).toISOString(), expires_in: 3599 },
      auth_method: 'consumer',
      id_token_email: 'local-old@example.com',
      writer_id: 'oldWriterId1234567890123456789012345678901',
    });
    const events = [];
    const switchRes = await sw.switchAntigravityAccount(targetBId, {
      now: () => tSw,
      platform: 'win32',
      appDataDir: swAppData,
      readKeyring: () => memKeyring,
      writeKeyring: (raw) => { events.push('writeKeyring'); memKeyring = raw; },
      deleteKeyring: () => { events.push('deleteKeyring'); memKeyring = null; },
      listProcesses: () => [{ pid: 999999, name: 'Antigravity.exe', executablePath: swMockExe, isDesktop: true }],
      stopProcesses: async () => { events.push('stopProcesses'); },
      findDesktopExe: () => swMockExe,
      launchDesktop: (exe) => { events.push('launch:' + exe); },
      fetchLocalEmail: async () => 'local-old@example.com',
      renewAll: async () => 0,
      refreshOne: async (cred) => {
        events.push('refreshOne');
        return { ok: true, credential: { ...cred, token: 'ya29.fresh-target-b', expiresAt: tSw + 3600_000 } };
      },
      listStatus: async (at, email) => mod.listAgyAccountStatus(at, email),
      sleep: async () => {},
    });
    assert.equal(switchRes.ok, true);
    assert.equal(switchRes.restarted, true);
    assert.equal(switchRes.email, 'target-b@example.com');
    assert.deepEqual(events, ['refreshOne', 'stopProcesses', 'writeKeyring', 'launch:' + swMockExe], '严格按续期→关进程→写凭据→重启顺序执行');
    const writtenCred = sw.parseAgyKeyringPayload(memKeyring);
    assert.equal(writtenCred.id_token_email, 'target-b@example.com');
    assert.equal(writtenCred.token.access_token, 'ya29.fresh-target-b');
    assert.equal(writtenCred.token.refresh_token, '1//refresh-target-b');
    assert.equal(writtenCred.token.token_type, 'Bearer');
    assert.equal(writtenCred.auth_method, 'consumer');
    assert.equal(writtenCred.writer_id.length, 43);
    const updatedStorage = JSON.parse(fs.readFileSync(swAppStorage, 'utf8'));
    assert.equal(updatedStorage['agy.onboarding.lastLoginUsername'], 'target-b@example.com');
    assert.equal(updatedStorage.keepComputerAwake, 'true', '保留 app_storage.json 其他键');
    const rescuedOld = mod.readAgyAccountStore().accounts.find((a) => a.id === localOnlyId);
    assert.equal(rescuedOld?.credential?.refreshToken, '1//refresh-outgoing-old', '被换下的仅本机账号自动抢救保存其 OAuth 凭据，方便随时切回');
    assert.equal(mod.readAgyLoginTimeline().at(-1)?.id, targetBId, '切换后立刻记录登录时间线边界');
    const backupDirs = fs.readdirSync(path.join(dataDir, 'backups', 'antigravity-switch'));
    assert.ok(backupDirs.length >= 1 && fs.existsSync(path.join(dataDir, 'backups', 'antigravity-switch', backupDirs[0], 'keyring.json')), '切换前生成备份');

    // 10c. 已是当前账号时不重复重启
    const sameEvents = [];
    const alreadyRes = await sw.switchAntigravityAccount(targetBId, {
      now: () => tSw + 1000,
      platform: 'win32',
      appDataDir: swAppData,
      readKeyring: () => memKeyring,
      writeKeyring: () => { sameEvents.push('write'); },
      listProcesses: () => [{ pid: 999999, name: 'Antigravity.exe', executablePath: swMockExe, isDesktop: true }],
      stopProcesses: async () => { sameEvents.push('stop'); },
      launchDesktop: () => { sameEvents.push('launch'); },
      fetchLocalEmail: async () => 'target-b@example.com',
      renewAll: async () => 0,
      listStatus: async (at, email) => mod.listAgyAccountStatus(at, email),
      sleep: async () => {},
    });
    assert.equal(alreadyRes.alreadyActive, true);
    assert.equal(alreadyRes.restarted, false);
    assert.deepEqual(sameEvents, [], '已是目标账号时不关不启不重写');

    // 10d. 写入核对失败时完整回滚系统凭据、app_storage.json 与账号库，并拉回原运行中的桌面端
    const keyringBeforeFail = memKeyring;
    let rollbackRelaunched = false;
    let rollbackThrew = false;
    try {
      await sw.switchAntigravityAccount(localOnlyId, {
        now: () => tSw + 2000,
        platform: 'win32',
        appDataDir: swAppData,
        readKeyring: () => memKeyring,
        writeKeyring: (raw) => {
          // 首次写入故意模拟脏写（验证不通过），回滚写回原串则正常保存
          if (raw === keyringBeforeFail) memKeyring = raw;
          else memKeyring = JSON.stringify({ token: { access_token: 'corrupt', refresh_token: 'wrong' }, id_token_email: 'wrong@example.com' });
        },
        listProcesses: () => [{ pid: 999999, name: 'Antigravity.exe', executablePath: swMockExe, isDesktop: true }],
        stopProcesses: async () => {},
        findDesktopExe: () => swMockExe,
        launchDesktop: () => { rollbackRelaunched = true; },
        fetchLocalEmail: async () => 'target-b@example.com',
        renewAll: async () => 0,
        listStatus: async (at, email) => mod.listAgyAccountStatus(at, email),
        sleep: async () => {},
      });
    } catch (err) {
      rollbackThrew = /已恢复原样/.test(err.message);
    }
    assert.equal(rollbackThrew, true);
    assert.equal(memKeyring, keyringBeforeFail, '失败后系统凭据回滚为原值');
    assert.equal(JSON.parse(fs.readFileSync(swAppStorage, 'utf8'))['agy.onboarding.lastLoginUsername'], 'target-b@example.com', '失败后 app_storage.json 保持原值');
    assert.equal(rollbackRelaunched, true, '失败后自动拉回原本运行中的桌面端');

    // 10e. 隔离 mock keyring 文件模式往返
    const mockKeyringPath = path.join(root, 'mock-keyring.json');
    process.env.TOKENPULSE_AGY_KEYRING_FILE = mockKeyringPath;
    try {
      sw.writeAgyKeyringRaw(keyringBeforeFail);
      assert.equal(sw.readAgyKeyringEmail(), 'target-b@example.com');
      sw.deleteAgyKeyringRaw();
      assert.equal(sw.readAgyKeyringEmail(), '');
    } finally {
      delete process.env.TOKENPULSE_AGY_KEYRING_FILE;
    }
    pass('Antigravity one-click account switch: pre-refresh, outgoing rescue, stop/write/verify/relaunch, already-active no-op, and rollback');

    console.log(`\n${checks}/10 antigravity multi-account checks passed`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    if (hubServer) await new Promise((r) => hubServer.close(() => r()));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})();
