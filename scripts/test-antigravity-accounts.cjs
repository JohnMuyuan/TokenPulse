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
    pass('automatic credential renewal and permanent invalid_grant detection');

    // 5. Cloud Code 直连配额解析与备用端点故障转移
    const endpointsHit = [];
    const cloudRes = await mod.fetchAntigravityCloudStatus(
      { token: 'tp_mock_cloud_test' },
      {
        postJson: async (url, body) => {
          endpointsHit.push(url);
          if (url.startsWith('https://cloudcode-pa.googleapis.com')) {
            return { status: 503, json: {} }; // 主端点故障，自动切 daily 备用端点
          }
          if (url.endsWith(':loadCodeAssist')) {
            return {
              status: 200,
              json: {
                cloudaicompanionProject: { id: 'agy-proj-42' },
                g1Tier: 'g1-pro-tier',
                paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro', availableCredits: [{ creditAmount: 500 }] },
              },
            };
          }
          if (url.endsWith(':fetchAvailableModels')) {
            assert.equal(JSON.parse(body).project, 'agy-proj-42');
            return {
              status: 200,
              json: {
                models: {
                  MODEL_PLACEHOLDER_M37: {
                    displayName: 'Gemini 4 Argon (High)',
                    model: 'MODEL_PLACEHOLDER_M37',
                    quotaInfo: { remainingFraction: 0.65, resetTime: '2026-11-18T12:00:00Z' },
                  },
                  MODEL_CLAUDE_OPUS: {
                    displayName: 'Claude Opus 5.5 (Thinking)',
                    model: 'MODEL_CLAUDE_OPUS',
                    quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-18T14:00:00Z' },
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
    assert.equal(cloudRes.status.tier, 'Google AI Pro');
    assert.equal(cloudRes.status.groups.length, 2);
    assert.equal(cloudRes.status.groups[0].used, 35);
    assert.equal(cloudRes.status.groups[0].week.used, 18);
    assert.equal(cloudRes.status.groups[1].used, 10);
    assert.equal(cloudRes.status.credits.availablePromptCredits, 500);
    assert.ok(endpointsHit.some((u) => u.startsWith('https://daily-cloudcode-pa.googleapis.com')), '主端点 503 时自动切换备用端点');
    pass('Cloud Code direct quota parsing, dual-window merge, and fallback endpoint failover');

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

    console.log(`\n${checks}/6 antigravity multi-account checks passed`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    if (hubServer) await new Promise((r) => hubServer.close(() => r()));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})();
