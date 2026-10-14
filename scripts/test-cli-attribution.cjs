// Synthetic CLI homes only: switch credentials, resume a session, and verify both ledgers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-cli-attribution-'));
process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME']) delete process.env[key];
const core = name => require(path.join(__dirname, '..', 'build', 'core', name));
const { switchCliAccount } = core('cli-switch.js');
const { writeOfficialAccountStore } = core('accounts.js');
const logins = core('login-timeline.js');
const { scanLocalUsage, readRollups } = core('usage-scan.js');
const { queryRequests } = core('request-log.js');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const home = process.env.HOME, base = Date.now() - 3600_000, switched = base + 600_000;
const file = path.join(home, '.claude', 'projects', 'fixture', 'session.jsonl');
const iso = at => new Date(at).toISOString();
const request = (id, at) => ({ type: 'assistant', timestamp: iso(at), requestId: id, message: { id, model: 'claude-opus-5', usage: { input_tokens: 100, output_tokens: 10 } } });
const checks = [];
const check = (name, fn) => { try { fn(); console.log('PASS ' + name); } catch (e) { checks.push(e); console.error('FAIL ' + name + ': ' + e.message); } };
(async () => {
  const realNow = Date.now;
  try {
    write(path.join(home, '.claude', '.credentials.json'), { claudeAiOauth: { accessToken: 'synthetic-a', refreshToken: 'synthetic-refresh-a', expiresAt: realNow() + 86400_000 } });
    write(path.join(home, '.claude.json'), { oauthAccount: { accountUuid: 'a', emailAddress: 'a@example.com' } });
    writeOfficialAccountStore({ version: 2, active: {}, accounts: ['a', 'b'].map(ref => ({ id: 'claude:' + ref, kind: 'claude', ref, email: ref + '@example.com', label: ref, createdAt: base, lastSeenAt: base, ...(ref === 'b' ? { credential: { token: 'synthetic-b', refreshToken: 'synthetic-refresh-b', expiresAt: realNow() + 86400_000 } } : {}) })) });
    logins.recordCliLogins(base);
    const rows = [
      { type: 'bridge-session', ownerAccountUuid: 'a' },
      { type: 'attachment', timestamp: iso(base), attachment: { type: 'session_context', context: { userEmail: 'a@example.com' } } },
      request('before', switched - 1), request('after', switched + 1),
    ];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    Date.now = () => switched;
    await switchCliAccount('claude:b');
    Date.now = realNow;
    check('switch immediately records the exact incoming login boundary', () => assert.equal(logins.readLoginTimeline().kinds.claude.at(-1).from, switched));
    // Even with the later polling observation, the old session email must not win.
    logins.recordCliLogins(switched + 1000);
    scanLocalUsage();
    const query = () => queryRequests({ from: '2026-01-01', to: '2027-01-01', source: 'all', status: 'all', search: '', sort: 'time', page: 0, pageSize: 50, all: true });
    const records = query().rows;
    check('old request stays with A; resumed request belongs to B despite stale email and bridge owner', () => {
      assert.equal(records.find(row => row.requestId === 'before').account.id, 'claude:a');
      assert.equal(records.find(row => row.requestId === 'after').account.id, 'claude:b');
    });
    check('account hour ledger agrees with request rows', () => {
      const hours = readRollups().files[file].accountHours;
      const count = id => Object.values(hours[id] || {}).flatMap(models => Object.values(models)).reduce((n, b) => n + b.requests, 0);
      assert.equal(count('claude:a'), 1); assert.equal(count('claude:b'), 1);
    });
    check('fresh session identity can still identify an old process using A after the switch', () => {
      const result = logins.resolveAccount('claude', switched + 5000, { ref: 'a', email: 'a@example.com', at: switched + 2000 }, logins.readLoginTimeline(), logins.accountLabels());
      assert.equal(result.id, 'claude:a');
    });
    check('bridge owner without a fresh email follows the switched login', () => assert.equal(logins.resolveAccount('claude', switched + 5000, { ref: 'a' }, logins.readLoginTimeline(), logins.accountLabels()).id, 'claude:b'));
    check('first observation preserves explicit historical identity; logout stops stale attribution', () => {
      const labels = logins.accountLabels();
      const first = { version: 1, kinds: { claude: [{ from: base, id: 'claude:b', label: 'B', email: 'b@example.com' }] } };
      assert.equal(logins.resolveAccount('claude', base + 1, { ref: 'a', email: 'a@example.com', at: base - 1 }, first, labels).id, 'claude:a');
      first.kinds.claude.push({ from: switched, id: '', label: '', email: '' });
      assert.equal(logins.resolveAccount('claude', switched + 1, { ref: 'a', email: 'a@example.com', at: base }, first, labels), null);
    });
    // Seed the previous version's wrong hour ledger and ensure unchanged files are rebuilt.
    const rollupFile = path.join(process.env.TOKENPULSE_DATA_DIR, 'usage-rollups.json');
    const saved = readRollups(); saved.files[file].v = 15; saved.files[file].accountHours = {};
    write(rollupFile, saved); scanLocalUsage();
    check('upgrade replays unchanged files without duplicating requests', () => {
      assert.ok(readRollups().files[file].accountHours['claude:b']); assert.equal(query().rows.length, 2);
    });
    if (checks.length) process.exitCode = 1;
  } finally { Date.now = realNow; fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
