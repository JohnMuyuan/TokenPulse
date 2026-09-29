'use strict';
// Original audit counterexamples, now mandatory regression checks in npm test.
// Only synthetic credentials and temporary HOME/data directories are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-config-audit-'));
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
process.env.AGENT_SWITCH_HOME = path.join(root, 'initial-home');
process.env.HOME = process.env.USERPROFILE = process.env.AGENT_SWITCH_HOME;
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'initial-data');
const sw = require('../build/core/agent-switch');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const claude = () => path.join(process.env.AGENT_SWITCH_HOME, '.claude', 'settings.json');
const data = () => path.join(process.env.TOKENPULSE_DATA_DIR, 'agent-switch.json');
const provider = (name, extra = {}) => ({ app: 'claude', name, baseUrl: 'https://' + name.toLowerCase() + '.example/v1', apiKey: 'synthetic-key-' + name, model: 'test-model', upstream: 'anthropic', ...extra });
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
});
const checks = [
  ['C1-independent-save', async () => {
    const original = JSON.stringify({ hooks: { keep: true }, env: { MY_SETTING: 'keep' } }); write(claude(), original);
    sw.saveProvider(provider('A'));
    assert.equal(fs.readFileSync(claude(), 'utf8'), original, 'Inactive save must not write live');
  }],
  ['C2-hooks-and-first-backup', async () => {
    const original = JSON.stringify({ hooks: { keep: true }, permissions: { allow: ['Read'] }, env: { MY_SETTING: 'keep' } }); write(claude(), original);
    await sw.activateProvider(sw.saveProvider(provider('A')));
    assert.deepEqual(json(claude()).hooks, { keep: true }); assert.equal(json(claude()).env.MY_SETTING, 'keep');
    const dir = path.join(process.env.TOKENPULSE_DATA_DIR, 'backups', 'live-first-write');
    const copy = fs.readdirSync(dir).find(name => name.endsWith('-settings.json'));
    assert.equal(fs.readFileSync(path.join(dir, copy), 'utf8'), original);
  }],
  ['F1-same-url-current-provider', async () => {
    sw.saveProvider(provider('A', { baseUrl: 'https://shared.example/v1' }));
    const b = sw.saveProvider(provider('B', { baseUrl: 'https://shared.example/v1' })); await sw.activateProvider(b);
    assert.equal(sw.agentView().providers.find(p => p.app === 'claude' && p.active)?.id, b, 'Selected B must not be identified as A');
  }],
  ['F2-inactive-after-external-switch', async () => {
    const a = sw.saveProvider(provider('A')); await sw.activateProvider(a);
    const external = JSON.stringify({ hooks: { keep: true }, env: { ANTHROPIC_BASE_URL: 'https://external.example', ANTHROPIC_AUTH_TOKEN: 'synthetic-external' } }); write(claude(), external);
    sw.saveProvider({ ...provider('A'), id: a, notes: 'Only changing notes' });
    assert.equal(fs.readFileSync(claude(), 'utf8'), external, 'Editing stale A must not replace externally selected connection');
  }],
  ['F3-codex-unrelated-multiline', async () => {
    const file = path.join(process.env.AGENT_SWITCH_HOME, '.codex', 'config.toml');
    const untouched = "instructions = '''\n[model_providers.custom]\nDO_NOT_TOUCH_THIS_TEXT\n'''";
    write(file, untouched + '\n');
    await sw.activateProvider(sw.saveProvider(provider('Codex', { app: 'codex', upstream: 'openai-responses' })));
    assert.ok(fs.readFileSync(file, 'utf8').includes(untouched), 'TOML multiline literal must not be treated as a provider table');
  }],
  ['F4-write-failure-state-rollback', async () => {
    const a = sw.saveProvider(provider('A')); await sw.activateProvider(a); const b = sw.saveProvider(provider('B'));
    const original = fs.readFileSync(claude(), 'utf8'); const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (path.resolve(to) === path.resolve(claude())) { const error = new Error('Synthetic write failure'); error.code = 'EPERM'; throw error; } return rename(from, to); };
    try { await assert.rejects(sw.activateProvider(b), /Synthetic write failure/); } finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(claude(), 'utf8'), original);
    assert.equal(json(data()).direct.claude, a, 'Failed activation must not commit new direct pointer');
  }],
  ['F5-exit-preserves-external-change', async () => {
    await sw.activateProvider(sw.saveProvider(provider('A'))); await sw.setProxyPort(await freePort()); await sw.setAppProxy('claude', true);
    const external = JSON.stringify({ hooks: { keep: true }, env: { ANTHROPIC_BASE_URL: 'https://external.example', ANTHROPIC_AUTH_TOKEN: 'synthetic-external' } }); write(claude(), external);
    sw.releaseAgentSwitch();
    assert.equal(fs.readFileSync(claude(), 'utf8'), external, 'Exit must not overwrite connection changed by another tool');
  }],
  ['F6-import-restores-auth-field-and-roles', async () => {
    write(claude(), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://original.example', ANTHROPIC_API_KEY: 'synthetic-original', ANTHROPIC_MODEL: 'primary', ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-custom', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-custom' } }));
    const id = sw.importCurrent('claude'); await sw.activateProvider(id);
    const env = json(claude()).env;
    const preserved = { authField: env.ANTHROPIC_API_KEY === 'synthetic-original', haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'haiku-custom' };
    console.log('DETAIL F6 ' + JSON.stringify(preserved));
    assert.deepEqual(preserved, { authField: true, haiku: true });
  }],
  ['F8-codex-import-preserves-types', async () => {
    const dbFile = path.join(process.env.AGENT_SWITCH_HOME, 'cc-fixture.db'); fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(dbFile);
    try {
      db.exec('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, category TEXT, notes TEXT, sort_index INTEGER, meta TEXT)');
      const config = 'model_provider = "relay"\nmodel = "test"\ndisable_response_storage = true\nmodel_context_window = 128000\n[model_providers.relay]\nbase_url = "https://import.example/v1"\nexperimental_bearer_token = "synthetic-only"\nwire_api = "responses"\n';
      db.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('typed', 'codex', 'Typed import', JSON.stringify({ config }), '', '', 0, '{}');
    } finally { db.close(); }
    process.env.AGENT_SWITCH_CC_DB = dbFile;
    await sw.importCcProviders(); await sw.activateProvider('cc:codex:typed');
    const text = fs.readFileSync(path.join(process.env.AGENT_SWITCH_HOME, '.codex', 'config.toml'), 'utf8');
    const preserved = { boolean: /^disable_response_storage = true$/m.test(text), number: /^model_context_window = 128000$/m.test(text) };
    console.log('DETAIL F8 ' + JSON.stringify(preserved));
    assert.deepEqual(preserved, { boolean: true, number: true });
  }],
  ['F7-desktop-restores-previous-profile', async () => {
    const dir = path.join(process.env.AGENT_SWITCH_HOME, 'Claude-3p', 'configLibrary'); const meta = path.join(dir, '_meta.json');
    write(meta, JSON.stringify({ entries: [{ id: 'external-profile', name: 'External profile' }], appliedId: 'external-profile' }));
    sw.saveProvider(provider('Desktop', { app: 'desktop', desktopMode: 'map' }));
    await sw.setProxyPort(await freePort()); await sw.setAppProxy('desktop', true); await sw.setAppProxy('desktop', false);
    assert.equal(json(meta).appliedId, 'external-profile', 'Leaving proxy must restore the previous desktop profile');
  }],
];
(async () => {
  let failed = 0;
  try {
    for (let i = 0; i < checks.length; i++) {
      const [name, run] = checks[i];
      process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(root, String(i), 'home');
      process.env.TOKENPULSE_DATA_DIR = path.join(root, String(i), 'data');
      await sw.resetAgentSwitchForTests();
      try { await run(); console.log('SAFE ' + name); }
      catch (error) { failed++; console.log((error instanceof assert.AssertionError ? 'UNSAFE ' : 'ERROR ') + name); }
      finally { await sw.resetAgentSwitchForTests(); }
    }
    console.log('SUMMARY ' + (checks.length - failed) + '/' + checks.length + ' safety checks passed; ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  } finally {
    await sw.resetAgentSwitchForTests();
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('tokenpulse-config-audit-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
