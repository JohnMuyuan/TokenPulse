/*
 * 一键切换 CLI 登录账号（0.3.49，src/core/cli-switch.ts）。
 * 在一次性的 HOME 和数据目录里造三家 CLI 的凭据文件，不碰真实的 ~/.claude、~/.codex、~/.grok 和 ~/.tokenpulse。不联网。
 * 覆盖：写进 CLI 的是目标账号的 token 和资料、CLI 文件里别的内容不动；换下来的账号凭据收进 TokenPulse（之后由它续期），
 * 切进去的账号不再由 TokenPulse 保存凭据；有备份；没有可用登录的账号拒绝；写完读回来不对就整体还原。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-cli-switch-'));
const home = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
const build = path.join(__dirname, '..', 'build', 'core');
const accounts = require(path.join(build, 'accounts.js'));
const { readCliAccounts } = require(path.join(build, 'credentials.js'));
const { switchCliAccount } = require(path.join(build, 'cli-switch.js'));

const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const later = Date.now() + 5 * 3600_000;
const jwt = claims => 'x.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.y';
let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const acct = (kind, ref, email, credential, extra = {}) => ({ id: `${kind}:${ref}`, kind, ref, email, label: email, createdAt: 1, lastSeenAt: 1, ...(credential ? { credential } : {}), ...extra });

(async () => {
  try {
    // Claude：CLI 现在是 A；TokenPulse 存着 B 的登录和资料
    const claudeCreds = path.join(home, '.claude', '.credentials.json'), claudeJson = path.join(home, '.claude.json');
    write(claudeCreds, { claudeAiOauth: { accessToken: 'at-a', refreshToken: 'rt-a', expiresAt: later, scopes: ['user:inference'], subscriptionType: 'pro' } });
    write(claudeJson, { numStartups: 7, projects: { x: 1 }, oauthAccount: { accountUuid: 'uuid-a', emailAddress: 'a@example.com', organizationUuid: 'org-a' } });
    // Codex：CLI 现在是 C；D 只有 TokenPulse 的登录和记下的 id_token
    write(path.join(home, '.codex', 'auth.json'), { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: jwt({ email: 'c@example.com', 'https://api.openai.com/auth': { chatgpt_user_id: 'user-c', chatgpt_account_id: 'ws' } }), access_token: jwt({ exp: later / 1000 }), refresh_token: 'rt-c', account_id: 'ws' }, last_refresh: 'old' });
    const dId = jwt({ email: 'd@example.com', 'https://api.openai.com/auth': { chatgpt_user_id: 'user-d', chatgpt_account_id: 'ws' } });
    // Grok：CLI 现在是 E；F 是 TokenPulse 登录的
    write(path.join(home, '.grok', 'auth.json'), { 'https://auth.x.ai::cli': { key: 'key-e', user_id: 'grok-e', email: 'e@example.com', refresh_token: 'rt-e', expires_at: new Date(later).toISOString(), oidc_issuer: 'https://auth.x.ai', oidc_client_id: 'cli', team_id: 'team-e' } });
    accounts.writeOfficialAccountStore({ version: 2, active: {}, accounts: [
      acct('claude', 'uuid-a', 'a@example.com'),
      acct('claude', 'uuid-b', 'b@example.com', { token: 'at-b', refreshToken: 'rt-b', expiresAt: later }, { alias: '二号', cliAuth: { oauth: { scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' }, account: { accountUuid: 'uuid-b', emailAddress: 'b@example.com', organizationUuid: 'org-b' } } }),
      acct('claude', 'uuid-old', 'old@example.com'),
      acct('chatgpt', 'user-c@ws', 'c@example.com'),
      acct('chatgpt', 'user-d@ws', 'd@example.com', { token: jwt({ exp: later / 1000 }), refreshToken: 'rt-d', accountId: 'ws', expiresAt: later }, { cliAuth: { auth_mode: 'chatgpt', id_token: dId, account_id: 'ws' } }),
      acct('grok', 'grok-e', 'e@example.com'),
      acct('grok', 'grok-f', 'f@example.com', { token: 'key-f', refreshToken: 'rt-f', expiresAt: later, issuer: 'https://auth.x.ai', clientId: 'cli' }),
    ] });

    const result = await switchCliAccount('claude:uuid-b', home);
    assert.match(result.message, /二号/);
    const creds = read(claudeCreds).claudeAiOauth, profile = read(claudeJson);
    assert.equal(creds.accessToken, 'at-b'); assert.equal(creds.refreshToken, 'rt-b'); assert.equal(creds.subscriptionType, 'max');
    assert.deepEqual(creds.scopes, ['user:inference', 'user:profile']);
    assert.equal(profile.oauthAccount.organizationUuid, 'org-b'); assert.equal(profile.numStartups, 7); assert.deepEqual(profile.projects, { x: 1 });
    assert.equal(accounts.readOfficialAccountStore().accounts.find(a => a.id === 'claude:uuid-b').credential, undefined, '切进 CLI 的账号凭据归 CLI');
    const a = accounts.readOfficialAccountStore().accounts.find(x => x.id === 'claude:uuid-a');
    assert.equal(a.credential.refreshToken, 'rt-a', '换下来的账号收下 CLI 最新的凭据');
    assert.equal(a.cliAuth.account.organizationUuid, 'org-a');
    assert.equal(readCliAccounts('claude', home)[0].ref, 'uuid-b');
    assert.ok(fs.readdirSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'backups', 'cli-switch')).length >= 1, '有备份');
    pass('Claude: token and profile of the chosen account written, other .claude.json content kept, outgoing account kept by TokenPulse, incoming one handed to the CLI');

    // 再切回 A：A 现在由 TokenPulse 保存，能切
    await switchCliAccount('claude:uuid-a', home);
    assert.equal(read(claudeCreds).claudeAiOauth.accessToken, 'at-a');
    assert.equal(read(claudeJson).oauthAccount.organizationUuid, 'org-a');
    assert.equal(accounts.readOfficialAccountStore().accounts.find(x => x.id === 'claude:uuid-b').credential.refreshToken, 'rt-b');
    pass('Claude: switching back works with the credential captured on the way out');

    await assert.rejects(switchCliAccount('claude:uuid-old', home), /没有这个账号可用的登录/);
    assert.equal(read(claudeCreds).claudeAiOauth.accessToken, 'at-a', '拒绝时什么都不写');
    pass('accounts without a usable TokenPulse sign-in are refused and nothing is written');

    await switchCliAccount('chatgpt:user-d@ws', home);
    const codex = read(path.join(home, '.codex', 'auth.json'));
    assert.equal(codex.tokens.id_token, dId); assert.equal(codex.tokens.refresh_token, 'rt-d'); assert.equal(codex.tokens.account_id, 'ws');
    assert.equal(readCliAccounts('chatgpt', home)[0].ref, 'user-d@ws');
    assert.equal(accounts.readOfficialAccountStore().accounts.find(x => x.id === 'chatgpt:user-c@ws').credential.refreshToken, 'rt-c');
    pass('Codex: id_token, tokens and workspace of the chosen account written');

    await switchCliAccount('grok:grok-f', home);
    const grok = read(path.join(home, '.grok', 'auth.json'));
    assert.deepEqual(Object.keys(grok), ['https://auth.x.ai::cli']);
    assert.equal(grok['https://auth.x.ai::cli'].key, 'key-f'); assert.equal(grok['https://auth.x.ai::cli'].user_id, 'grok-f');
    assert.equal(grok['https://auth.x.ai::cli'].team_id, undefined, '上一个账号的资料不留下');
    assert.equal(readCliAccounts('grok', home)[0].ref, 'grok-f');
    const e = accounts.readOfficialAccountStore().accounts.find(x => x.id === 'grok:grok-e');
    assert.equal(e.credential.token, 'key-e'); assert.equal(e.cliAuth.row.team_id, 'team-e');
    pass('Grok: the auth.json row is replaced with the chosen account; the outgoing account and its profile are kept');

    // 写完读回来不对（目标账号的资料里身份是别人的）：CLI 文件和账号库都还原
    const before = fs.readFileSync(path.join(home, '.grok', 'auth.json'), 'utf8');
    const store = accounts.readOfficialAccountStore();
    store.accounts.find(x => x.id === 'grok:grok-e').cliAuth.row.user_id = 'someone-else';
    store.accounts.find(x => x.id === 'grok:grok-e').credential.token = 'key-not-jwt';
    accounts.writeOfficialAccountStore(store);
    const storeBefore = JSON.stringify(accounts.readOfficialAccountStore());
    const timelineBefore = fs.readFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'cli-logins.json'), 'utf8');
    await assert.rejects(switchCliAccount('grok:grok-e', home), /已恢复原样/);
    assert.equal(fs.readFileSync(path.join(home, '.grok', 'auth.json'), 'utf8'), before);
    assert.equal(JSON.stringify(accounts.readOfficialAccountStore()), storeBefore);
    assert.equal(fs.readFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'cli-logins.json'), 'utf8'), timelineBefore, '失败的切换不留下目标登录边界');
    pass('a write that does not read back as the chosen account is rolled back (CLI file and account store)');
    console.log(`test-cli-switch: ${checks} checks passed`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
