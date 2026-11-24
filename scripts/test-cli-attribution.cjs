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
const { rememberOfficialAccount, readOfficialAccountStore, writeOfficialAccountStore } = core('accounts.js');
const { readCliAccounts } = core('credentials.js');
const logins = core('login-timeline.js');
const { scanLocalUsage, readRollups } = core('usage-scan.js');
const { queryRequests } = core('request-log.js');
const { buildSnapshot } = core('report.js');
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

    // ---- v0.3.112: Claude subagent credential_org, parent fallback & accountHours[""] recovery ----
    const subRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-subagent-attr-'));
    try {
      process.env.HOME = process.env.USERPROFILE = path.join(subRoot, 'home');
      process.env.TOKENPULSE_DATA_DIR = path.join(subRoot, 'data');
      const sHome = process.env.HOME;
      const t0 = Date.now() - 2 * 3600_000;
      const tSwitch = t0 + 1800_000;

      // 1. readCliAccounts reads organizationUuid, rememberOfficialAccount & recordCliLogins persist orgId,
      //    and accountLabels also picks up cliAuth.account.organizationUuid for OAuth-stored accounts.
      write(path.join(sHome, '.claude', '.credentials.json'), {
        claudeAiOauth: { accessToken: 'tok-a', refreshToken: 'ref-a', expiresAt: realNow() + 86400_000 },
      });
      write(path.join(sHome, '.claude.json'), {
        oauthAccount: { accountUuid: 'acc-a', emailAddress: 'alpha@example.com', organizationUuid: 'org-alpha-1111' },
      });
      const liveClaude = readCliAccounts('claude');
      check('readCliAccounts reads Claude organizationUuid into orgId', () => {
        assert.equal(liveClaude[0]?.orgId, 'org-alpha-1111');
      });
      rememberOfficialAccount(liveClaude[0], false, t0);
      // Add a second Claude account whose orgId only exists inside cliAuth.account.organizationUuid (pre-0.3.112 OAuth store)
      const st = readOfficialAccountStore();
      st.accounts.push({
        id: 'claude:acc-b',
        kind: 'claude',
        ref: 'acc-b',
        email: 'beta@example.com',
        label: 'beta@example.com',
        cliAuth: { account: { accountUuid: 'acc-b', emailAddress: 'beta@example.com', organizationUuid: 'org-beta-2222' } },
        createdAt: t0,
        lastSeenAt: t0,
      });
      writeOfficialAccountStore(st);
      check('accountLabels indexes orgId from both stored orgId and cliAuth.account.organizationUuid', () => {
        const labels = logins.accountLabels();
        assert.equal(labels.orgs.get('claude:org-alpha-1111'), 'claude:acc-a');
        assert.equal(labels.orgs.get('claude:org-beta-2222'), 'claude:acc-b');
      });

      // 2. Subagent JSONL with NO bridge-session and EMPTY session_context.context ({}), ONLY credential_org.
      //    Simulate CLI already switched to acc-b while an old acc-a process spawns a subagent at tSwitch + 5s.
      write(path.join(process.env.TOKENPULSE_DATA_DIR, 'cli-logins.json'), {
        version: 1,
        kinds: {
          claude: [
            { from: t0, id: 'claude:acc-a', email: 'alpha@example.com', label: 'alpha@example.com', orgId: 'org-alpha-1111' },
            { from: tSwitch, id: 'claude:acc-b', email: 'beta@example.com', label: 'beta@example.com', orgId: 'org-beta-2222' },
          ],
        },
      });
      const subOnlyOrg = path.join(sHome, '.claude', 'projects', 'proj', 'sess-org', 'subagents', 'agent-ared-team-1.jsonl');
      fs.mkdirSync(path.dirname(subOnlyOrg), { recursive: true });
      fs.writeFileSync(subOnlyOrg, [
        { type: 'attachment', timestamp: iso(tSwitch + 4000), attachment: { type: 'session_context', context: {} } },
        { type: 'attachment', timestamp: iso(tSwitch + 5000), attachment: { type: 'credential_org', organizationUuid: 'org-alpha-1111' } },
        request('sub-org-fresh', tSwitch + 6000),
      ].map(r => JSON.stringify(r)).join('\n') + '\n');

      // 3. Stale credential_org (before CLI switch) must NOT override the newer login span.
      const subStaleOrg = path.join(sHome, '.claude', 'projects', 'proj', 'sess-stale', 'subagents', 'agent-stale-1.jsonl');
      fs.mkdirSync(path.dirname(subStaleOrg), { recursive: true });
      fs.writeFileSync(subStaleOrg, [
        { type: 'attachment', timestamp: iso(t0 + 1000), attachment: { type: 'credential_org', organizationUuid: 'org-alpha-1111' } },
        request('sub-org-stale', tSwitch + 7000),
      ].map(r => JSON.stringify(r)).join('\n') + '\n');

      // 4. Shared Team organizationUuid (ambiguous) + subagent without email falls back to parent session userEmail.
      //    Note directory 'sess-team' sorts alphabetically BEFORE 'sess-team.jsonl' — scanLocalUsage must scan parent first.
      const st2 = readOfficialAccountStore();
      st2.accounts.push(
        { id: 'claude:team-1', kind: 'claude', ref: 'team-1', email: 't1@corp.example', label: 't1', orgId: 'org-shared-team', createdAt: t0, lastSeenAt: t0 },
        { id: 'claude:team-2', kind: 'claude', ref: 'team-2', email: 't2@corp.example', label: 't2', orgId: 'org-shared-team', createdAt: t0, lastSeenAt: t0 },
      );
      writeOfficialAccountStore(st2);
      const parentTeam = path.join(sHome, '.claude', 'projects', 'proj', 'sess-team.jsonl');
      const subTeam = path.join(sHome, '.claude', 'projects', 'proj', 'sess-team', 'subagents', 'agent-worker-1.jsonl');
      fs.mkdirSync(path.dirname(subTeam), { recursive: true });
      fs.writeFileSync(parentTeam, [
        { type: 'attachment', timestamp: iso(tSwitch + 8000), attachment: { type: 'session_context', context: { userEmail: 't2@corp.example. Use it only to identify the user.' } } },
        request('parent-team-req', tSwitch + 9000),
      ].map(r => JSON.stringify(r)).join('\n') + '\n');
      fs.writeFileSync(subTeam, [
        { type: 'attachment', timestamp: iso(tSwitch + 9500), attachment: { type: 'session_context', context: {} } },
        { type: 'attachment', timestamp: iso(tSwitch + 9600), attachment: { type: 'credential_org', organizationUuid: 'org-shared-team' } },
        request('sub-team-req', tSwitch + 10000),
      ].map(r => JSON.stringify(r)).join('\n') + '\n');

      scanLocalUsage();
      const sRows = query().rows;
      const rollupsAfter = readRollups();
      check('subagent with only credential_org attributes to matching Claude account even after CLI switch', () => {
        const row = sRows.find(r => r.requestId === 'sub-org-fresh');
        assert.equal(row?.account?.id, 'claude:acc-a');
        assert.equal(row?.account?.basis, 'session');
        assert.ok(rollupsAfter.files[subOnlyOrg]?.accountHours?.['claude:acc-a']);
        assert.equal(rollupsAfter.files[subOnlyOrg]?.accountHours?.[''], undefined);
      });
      check('stale credential_org written before login switch follows the newer login span', () => {
        const row = sRows.find(r => r.requestId === 'sub-org-stale');
        assert.equal(row?.account?.id, 'claude:acc-b');
        assert.equal(row?.account?.basis, 'timeline');
      });
      check('shared Team organizationUuid is treated as ambiguous and subagent inherits parent session email', () => {
        assert.equal(logins.accountLabels().orgs.get('claude:org-shared-team'), null);
        const row = sRows.find(r => r.requestId === 'sub-team-req');
        assert.equal(row?.account?.id, 'claude:team-2');
        assert.equal(row?.account?.basis, 'session');
        assert.ok(rollupsAfter.files[subTeam]?.accountHours?.['claude:team-2']);
      });

      // 5. Sticky accountHours[""] recovery when initially unattributed + guaranteed no infinite rescan loop.
      const retryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-retry-attr-'));
      try {
        process.env.HOME = process.env.USERPROFILE = path.join(retryRoot, 'home');
        process.env.TOKENPULSE_DATA_DIR = path.join(retryRoot, 'data');
        const rHome = process.env.HOME;
        const rSub = path.join(rHome, '.claude', 'projects', 'proj', 'sess-late', 'subagents', 'agent-late-1.jsonl');
        fs.mkdirSync(path.dirname(rSub), { recursive: true });
        const lateTs = Math.floor((Date.now() - 3600_000) / 3600_000) * 3600_000 + 20 * 60_000;
        fs.writeFileSync(rSub, [
          { type: 'attachment', timestamp: iso(lateTs - 1000), attachment: { type: 'session_context', context: {} } },
          { type: 'attachment', timestamp: iso(lateTs - 500), attachment: { type: 'credential_org', organizationUuid: 'org-late-9999' } },
          request('late-sub-req', lateTs),
        ].map(r => JSON.stringify(r)).join('\n') + '\n');

        // Scan #1: no cli-logins.json and no official accounts yet -> lands in accountHours[""]
        const firstScan = scanLocalUsage();
        const r1 = readRollups().files[rSub];
        check('initially unattributed subagent lands in accountHours[""] with unattributedSig', () => {
          assert.equal(firstScan.changed, 1);
          assert.ok(r1?.accountHours?.['']);
          assert.equal(typeof r1?.unattributedSig, 'string');
        });

        // Scan #2: nothing changed -> MUST NOT rescan (no infinite loop)
        const secondScan = scanLocalUsage();
        check('unchanged unattributed file does not trigger repeat rescan loop', () => {
          assert.equal(secondScan.changed, 0);
        });

        // Case C: logout starts at hour + 10m (before lateTs at hour + 20m); start of hour resolves to acc-x,
        // so one retry runs, still lands in "", records new unattributedSig, and the following scan skips cleanly.
        write(path.join(process.env.TOKENPULSE_DATA_DIR, 'cli-logins.json'), {
          version: 1,
          kinds: {
            claude: [
              { from: lateTs - 20 * 60_000, id: 'claude:acc-x', email: 'x@example.com', label: 'x' },
              { from: lateTs - 10 * 60_000, id: '', email: '', label: '' },
            ],
          },
        });
        scanLocalUsage();
        const postLogoutScan = scanLocalUsage();
        check('mid-hour logout span retries at most once and does not loop on subsequent scans', () => {
          assert.equal(postLogoutScan.changed, 0);
          assert.ok(readRollups().files[rSub]?.accountHours?.['']);
        });

        // Now register the matching Claude account with orgId -> next scan automatically recovers accountHours[""]!
        writeOfficialAccountStore({
          version: 2,
          active: {},
          accounts: [{
            id: 'claude:acc-late',
            kind: 'claude',
            ref: 'acc-late',
            email: 'late@example.com',
            orgId: 'org-late-9999',
            label: 'late@example.com',
            createdAt: lateTs,
            lastSeenAt: lateTs,
          }],
        });
        // Seed quota sample so buildSnapshot builds an account report for claude:acc-late
        write(path.join(process.env.TOKENPULSE_DATA_DIR, 'quota-history.json'), {
          version: 1,
          accounts: { claude: [{ at: Date.now() - 60_000, account: 'claude:acc-late', week: 10, weekReset: iso(Date.now() + 5 * 86400_000), five: 5, fiveReset: iso(Date.now() + 3 * 3600_000) }] },
        });
        const recoveredScan = scanLocalUsage();
        const rFinal = readRollups().files[rSub];
        const snap = buildSnapshot(Date.now());
        const lateAccount = snap.accounts.find(a => a.accountId === 'claude:acc-late');
        check('once orgId mapping is available, stuck accountHours[""] auto-recovers into Claude account without duplicates', () => {
          assert.equal(recoveredScan.changed, 1);
          assert.ok(rFinal?.accountHours?.['claude:acc-late']);
          assert.equal(rFinal?.accountHours?.[''], undefined);
          assert.equal(rFinal?.unattributedSig, undefined);
          assert.equal(query().rows.filter(r => r.requestId === 'late-sub-req').length, 1);
          assert.equal(query().rows.find(r => r.requestId === 'late-sub-req')?.account?.id, 'claude:acc-late');
          assert.ok(lateAccount && lateAccount.week && lateAccount.week.usedTokens >= 110);
        });
        check('subsequent scan after recovery is a clean no-op', () => {
          assert.equal(scanLocalUsage().changed, 0);
        });
      } finally {
        fs.rmSync(retryRoot, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(subRoot, { recursive: true, force: true });
    }
    if (checks.length) process.exitCode = 1;
  } finally { Date.now = realNow; fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
