const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-egress-test-'));
assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
process.env.TOKENPULSE_DATA_DIR = root;
// 用空的家目录：额度查询那一项不能读到本机真实的 CLI 登录、更不能拿去问官方
process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME']) delete process.env[key];
const E = require('../build/core/egress');
const { ExitMonitor } = require('../build/main/egress-monitor');
const NOW = Date.UTC(2026, 8, 27, 12);
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS ' + name); }
const sample = (extra = {}) => ({ provider: 'claude', host: 'api.anthropic.com', ip: '203.0.113.10', region: 'US', checkedAt: NOW, latencyMs: 20, ...extra });
const config = { host: 'api.anthropic.com', allowedIps: ['203.0.113.10'], allowedRegions: [] };
(async () => {
  check('IPv4 and IPv6 canonicalization', () => {
    assert.equal(E.normalizeIp(' 203.0.113.10 '), '203.0.113.10');
    assert.equal(E.normalizeIp('2001:0db8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
    for (const ip of ['host.example', '127.0.0.1/32', 'fe80::1%eth0', '999.1.1.1']) assert.throws(() => E.normalizeIp(ip));
  });
  check('Atomic config validation and destination allowlist', () => {
    const c = E.defaults(); c.providers.claude.allowedIps = ['2001:db8::1', '2001:0db8::1']; c.providers.claude.allowedRegions = ['us', 'JP'];
    assert.equal(E.validateConfig(c).providers.claude.allowedIps.length, 1);
    assert.deepEqual(E.validateConfig(c).providers.claude.allowedRegions, ['US', 'JP']);
    c.providers.claude.host = 'localhost'; assert.throws(() => E.validateConfig(c));
    c.providers.claude.host = 'api.anthropic.com'; c.providers.claude.allowedRegions = ['XX']; assert.throws(() => E.validateConfig(c));
    c.providers.claude.allowedRegions = []; c.providers.claude.allowedIps = Array(65).fill('1.1.1.1'); assert.throws(() => E.validateConfig(c));
  });
  check('Only target-host trace supplies the egress IP', () => {
    assert.deepEqual(E.parseTrace('h=chatgpt.com\nip=203.0.113.4\nloc=US\n', 'chatgpt.com'), { ip: '203.0.113.4', region: 'US' });
    for (const text of ['<html>challenge</html>', 'h=other.com\nip=1.1.1.1', 'h=chatgpt.com\nip=nope', 'h=chatgpt.com\nip=1.1.1.1\nip=2.2.2.2']) assert.throws(() => E.parseTrace(text, 'chatgpt.com'));
    assert.equal(E.parseTrace('h=chatgpt.com\nip=1.1.1.1\nloc=XX', 'chatgpt.com').region, undefined);
  });
  check('Verified region policy, subregion caveat, unknown and stale data', () => {
    assert.equal(E.regionStatus('claude', config.host, 'US', NOW), 'supported');
    assert.equal(E.regionStatus('claude', config.host, 'HK', NOW), 'unsupported');
    assert.equal(E.regionStatus('chatgpt', 'chatgpt.com', 'HK', NOW), 'unsupported');
    assert.equal(E.regionStatus('chatgpt', 'api.openai.com', 'US', NOW), 'supported');
    assert.equal(E.regionStatus('claude', config.host, 'UA', NOW), 'partial');
    assert.equal(E.regionStatus('grok', 'grok.com', 'US', NOW), 'unknown');
    assert.equal(E.regionStatus('claude', config.host, 'US', NOW + 91 * 86400000), 'unknown');
  });
  check('Two-sample mismatch, no duplicate warnings, two-sample recovery', () => {
    const tracker = new E.EgressTracker();
    tracker.accept(sample(), config);
    let r = tracker.accept(sample({ ip: '203.0.113.20' }), config); assert.equal(r.row.confirmed, false); assert.equal(r.events.filter(e => e.type === 'warning').length, 0);
    r = tracker.accept(sample({ ip: '203.0.113.20' }), config); assert.equal(r.events.filter(e => e.type === 'warning').length, 1);
    assert.equal(tracker.accept(sample({ ip: '203.0.113.20' }), config).events.length, 0);
    assert.equal(tracker.accept(sample(), config).events.filter(e => e.type === 'recovery').length, 0);
    assert.equal(tracker.accept(sample(), config).events.filter(e => e.type === 'recovery').length, 1);
  });
  check('Probe failure stays unknown and preserves clearly marked last success', () => {
    const tracker = new E.EgressTracker(); tracker.accept(sample(), config);
    let r = tracker.accept(sample({ ip: undefined, region: undefined, error: 'tls' }), config);
    assert.equal(r.row.status, 'unknown'); assert.equal(r.row.ip, undefined); assert.equal(r.row.lastGood.ip, '203.0.113.10'); assert.deepEqual(r.row.reasons, ['probe_failed']);
    r = tracker.accept(sample({ ip: undefined, region: undefined, error: 'tls' }), config); assert.equal(r.events[0].type, 'warning');
  });
  check('Unknown geography cannot falsely clear a prior region alert', () => {
    const tracker = new E.EgressTracker();
    tracker.accept(sample({ region: 'HK' }), config); tracker.accept(sample({ region: 'HK' }), config);
    const a = tracker.accept(sample({ region: undefined }), config), b = tracker.accept(sample({ region: undefined }), config);
    assert.equal(b.row.status, 'unknown'); assert.ok(b.row.reasons.includes('region_unknown'));
    assert.equal([...a.events, ...b.events].filter(e => e.type === 'recovery').length, 0);
    const code = E.REGION_RULES.chatgpt.countries.find(c => !E.REGION_RULES.openai_api.countries.includes(c));
    assert.ok(code); assert.equal(E.regionStatus('chatgpt', 'chatgpt.com', code, NOW), 'supported');
    assert.equal(E.regionStatus('chatgpt', 'api.openai.com', code, NOW), 'unsupported');
  });
  check('Official and custom country checks do not depend on IP allowlist', () => {
    let r = new E.EgressTracker().accept(sample({ region: 'HK' }), { ...config, allowedIps: [] }); assert.ok(r.row.reasons.includes('unsupported_region'));
    r = new E.EgressTracker().accept(sample({ provider: 'grok', host: 'grok.com', region: 'HK' }), { ...config, allowedIps: [], allowedRegions: ['US'] }); assert.deepEqual(r.row.reasons, ['region_mismatch']);
    r = new E.EgressTracker().accept(sample(), { ...config, allowedIps: [] }); assert.equal(r.row.status, 'unconfigured'); assert.equal(r.events.length, 0);
  });
  let now = NOW, calls = 0; const alerts = [];
  const monitor = new ExitMonitor({ now: () => now, probe: async (provider, host) => { calls++; return sample({ provider, host, checkedAt: now }); }, notify: e => alerts.push(e) });
  monitor.start(); await monitor.check(); assert.equal(calls, 0, 'disabled does not probe');
  await monitor.check(true); assert.equal(calls, 3); await monitor.check(true); assert.equal(calls, 3, 'manual refresh obeys cooldown');
  now += 5000; await monitor.check(true); assert.equal(calls, 6); assert.equal(fs.existsSync(path.join(root, 'egress-history.json')), false, 'stable samples are not written every five seconds');
  checks++; console.log('PASS disabled mode, three independent probes, five-second cooldown and no sample disk churn');
  const bad = E.defaults(); bad.providers.chatgpt.allowedIps = ['bad']; assert.throws(() => monitor.save(bad)); assert.equal(fs.existsSync(path.join(root, 'egress-settings.json')), false);
  const next = E.defaults(); for (const p of E.PROVIDERS) next.providers[p].allowedIps = ['203.0.113.99'];
  monitor.save(next); await monitor.check(true); now += 5000; await monitor.check(true);
  assert.equal(alerts.length, 3); now += 5000; await monitor.check(true); assert.equal(alerts.length, 3); assert.equal(monitor.snapshot().events.length, 3);
  assert.equal(new ExitMonitor().snapshot().config.providers.chatgpt.allowedIps[0], '203.0.113.99');
  monitor.clearHistory(); assert.equal(monitor.snapshot().events.length, 0); monitor.stop();
  checks++; console.log('PASS persisted settings, notifications, deduplication and history clearing');
  const pending = []; let pendingCalls = 0;
  const slow = new ExitMonitor({ now: () => now, probe: (provider, host) => { pendingCalls++; return new Promise(resolve => pending.push(() => resolve(sample({ provider, host })))); } });
  const first = slow.check(true), second = slow.check(true); assert.equal(pendingCalls, 3);
  slow.save(E.defaults()); pending.forEach(resolve => resolve()); await Promise.all([first, second]);
  assert.ok(slow.snapshot().providers.every(p => p.row === null), 'configuration edits invalidate in-flight responses'); slow.stop();
  checks++; console.log('PASS overlapping requests coalesce and stale responses cannot trigger alerts');
  // ---- IP 数据库（假响应，不联网） ----
  const I = require('../build/core/ip-intel');
  const answers = ip => ({
    proxycheck: { status: 'ok', [ip]: { asn: 'AS20473', provider: 'The Constant Company, LLC', organisation: 'Vultr Holdings, LLC', isocode: 'US', region: 'New Jersey', city: 'Piscataway', risk: 66, proxy: 'no', vpn: 'yes', type: 'Hosting' } },
    'ip-api': { status: 'success', countryCode: 'US', regionName: 'New Jersey', city: 'Piscataway', isp: 'The Constant Company, LLC', org: 'Vultr Holdings, LLC', as: 'AS20473 The Constant Company, LLC', asname: 'AS-VULTR', mobile: false, proxy: false, hosting: true },
    ipinfo: { ip, hostname: `${ip}.vultrusercontent.com`, country: 'US', org: 'AS20473 The Constant Company, LLC', anycast: false },
    ipapi: { ip, company: 'Vultr Holdings, LLC', asn: 'AS20473 The Constant Company, LLC' },
  });
  const fake = (overrides = {}) => async url => {
    const ip = '198.51.100.7', key = url.includes('proxycheck') ? 'proxycheck' : url.includes('ip-api.com') ? 'ip-api' : url.includes('ipinfo') ? 'ipinfo' : 'ipapi';
    if (overrides[key] instanceof Error) throw overrides[key];
    return overrides[key] ?? answers(ip)[key];
  };
  const intel = await I.lookupIp('198.51.100.7', fake(), NOW);
  const bySource = Object.fromEntries(intel.sources.map(s => [s.id, s]));
  assert.equal(intel.countryCode, 'US'); assert.equal(intel.asn, 'AS20473'); assert.equal(intel.asName, 'AS-VULTR'); assert.equal(intel.hostname, '198.51.100.7.vultrusercontent.com');
  assert.equal(intel.type, 'hosting'); assert.equal(bySource.proxycheck.risk, 66); assert.equal(bySource.proxycheck.flags.vpn, true); assert.equal(bySource.ipapicom.flags.hosting, true);
  assert.ok(intel.sources.every(s => s.ok) && bySource.proxycheck.url.endsWith('/198.51.100.7'));
  checks++; console.log('PASS IP databases: ASN, location, line type, risk score and flags are merged');
  // proxycheck 没给类型、ip-api 只说「不是机房」：别家标了 VPN 就不能写成家宽
  const weak = await I.lookupIp('198.51.100.7', fake({ proxycheck: { status: 'ok', '198.51.100.7': { asn: 'AS979', risk: 66, proxy: 'no', vpn: 'yes' } }, 'ip-api': { ...answers('198.51.100.7')['ip-api'], hosting: false } }), NOW);
  assert.equal(weak.type, 'unknown');
  const home = await I.lookupIp('198.51.100.7', fake({ proxycheck: { status: 'ok', '198.51.100.7': { asn: 'AS7018', risk: 0, proxy: 'no', vpn: 'no' } }, 'ip-api': { ...answers('198.51.100.7')['ip-api'], hosting: false } }), NOW);
  assert.equal(home.type, 'isp');
  checks++; console.log('PASS weak "not hosting" guess never overrides VPN / proxy flags');
  // 一家挂了、一家额度用完：其余照常，标出失败
  const partial = await I.lookupIp('198.51.100.7', fake({ ipinfo: new Error('boom'), proxycheck: { status: 'denied', message: '1,000 free queries exhausted' } }), NOW);
  const failed = Object.fromEntries(partial.sources.map(s => [s.id, s]));
  assert.equal(failed.ipinfo.ok, false); assert.equal(failed.ipinfo.error, 'network'); assert.equal(failed.proxycheck.ok, false); assert.equal(partial.asn, 'AS20473'); assert.equal(failed.ipapicom.ok, true);
  await assert.rejects(I.lookupIp('not-an-ip', fake(), NOW));
  checks++; console.log('PASS one database failing or over quota does not hide the others');
  // 缓存：查全了 12 小时有效，查不全 15 分钟后重试；只保留最近的若干条
  assert.equal(I.isFresh(intel, NOW + 11 * 3600000), true); assert.equal(I.isFresh(intel, NOW + 13 * 3600000), false);
  const thin = { ...partial, sources: partial.sources.map(s => ({ ...s, ok: s.id === 'ipapiis' })) };
  assert.equal(I.isFresh(thin, NOW + 10 * 60000), true); assert.equal(I.isFresh(thin, NOW + 16 * 60000), false);
  I.storeIntel(intel); assert.equal(I.readIntelCache().entries['198.51.100.7'].asn, 'AS20473');
  checks++; console.log('PASS lookup cache keeps good results 12 h and retries thin ones after 15 min');
  // 监控：三家同一个出口只查一次；关掉数据库查询就不查；手动重新查询一分钟一次
  let lookups = 0, clock = NOW + 3600000;
  const withIntel = new ExitMonitor({ now: () => clock, probe: async (provider, host) => sample({ provider, host, checkedAt: clock, ip: '198.51.100.9' }), lookup: async ip => { lookups++; return { ...intel, ip, fetchedAt: clock }; } });
  withIntel.save({ ...E.defaults(), enabled: false });
  await withIntel.check(true); await new Promise(r => setTimeout(r, 20));
  assert.equal(lookups, 1); assert.equal(withIntel.snapshot().intel['198.51.100.9'].asn, 'AS20473');
  clock += 5000; await withIntel.check(true); await new Promise(r => setTimeout(r, 20));
  assert.equal(lookups, 1, 'same IP is not looked up again while fresh');
  withIntel.refreshIntel('198.51.100.9'); await new Promise(r => setTimeout(r, 20)); assert.equal(lookups, 2);
  assert.throws(() => withIntel.refreshIntel('198.51.100.9'), /一分钟/); assert.throws(() => withIntel.refreshIntel('203.0.113.99'));
  withIntel.stop();
  let offLookups = 0;
  const off = new ExitMonitor({ now: () => clock, probe: async (provider, host) => sample({ provider, host, checkedAt: clock, ip: '198.51.100.10' }), lookup: async ip => { offLookups++; return { ...intel, ip }; } });
  off.save({ ...E.defaults(), ipIntel: false }); clock += 5000; await off.check(true); await new Promise(r => setTimeout(r, 20));
  assert.equal(offLookups, 0, 'switched off: exit IP is not sent to databases'); off.stop();
  assert.equal(E.validateConfig({ enabled: false, notifications: true, providers: E.defaults().providers }).ipIntel, true, 'older settings without the switch default to on');
  // 0.3.16：检测间隔自己定，5 到 60 秒的整数，默认 10 秒；旧配置没有这一项就用默认
  assert.equal(E.defaults().intervalSeconds, 10);
  assert.equal(E.validateConfig({ enabled: false, notifications: true, providers: E.defaults().providers }).intervalSeconds, 10, 'older settings default to 10 seconds');
  for (const ok of [5, 10, 37, 60]) assert.equal(E.validateConfig({ ...E.defaults(), intervalSeconds: ok }).intervalSeconds, ok);
  for (const bad of [4, 61, 0, -5, 7.5, NaN, '10', null]) assert.throws(() => E.validateConfig({ ...E.defaults(), intervalSeconds: bad }), /5 到 60/, String(bad));
  {
    const realSet = global.setInterval, realClear = global.clearInterval; const timers = []; let cleared = 0;
    global.setInterval = (fn, ms) => { const t = { ms, unref() {} }; timers.push(t); return t; }; global.clearInterval = () => { cleared++; };
    try {
      let t = NOW; const m = new ExitMonitor({ now: () => t, probe: async (provider, host) => sample({ provider, host, checkedAt: t }) });
      m.save({ ...E.defaults(), intervalSeconds: 10 });
      m.start(); assert.equal(timers.at(-1).ms, 10000, 'timer follows the configured interval');
      assert.equal(m.snapshot().intervalMs, 10000);
      const snap = m.save({ ...E.defaults(), intervalSeconds: 45 });
      assert.equal(timers.at(-1).ms, 45000, 'changing the interval re-arms the timer'); assert.ok(cleared >= 1); assert.equal(snap.intervalMs, 45000); assert.equal(snap.config.intervalSeconds, 45);
      const count = timers.length; m.save({ ...E.defaults(), intervalSeconds: 45, notifications: false }); assert.equal(timers.length, count, 'same interval keeps the timer');

     
      m.save({ ...E.defaults(), enabled: true, intervalSeconds: 45 }); await m.check(true); assert.equal(m.snapshot().nextCheckAt, t + 45000, 'next automatic check is one interval after the last one');
      assert.equal(new ExitMonitor().snapshot().config.intervalSeconds, 45, 'interval is saved');
      m.stop();
    } finally { global.setInterval = realSet; global.clearInterval = realClear; }
  }
  // 0.3.16：TokenPulse 启动 CLI 之前的出口检查。没设白名单放行；设了就现测，在白名单里才放行，测不出来也不放行
  {
    let ip = '203.0.113.10', fail = false, probes = 0; const t = NOW + 9e6;
    const m = new ExitMonitor({ now: () => t, probe: async (provider, host) => { probes++; return fail ? { provider, host, checkedAt: t, latencyMs: 1, error: 'timeout' } : sample({ provider, host, checkedAt: t, ip }); } });
    m.save(E.defaults());
    assert.equal(m.launchRule('claude'), null); assert.deepEqual(await m.gateLaunch('claude', 'Claude Code'), { ok: true }); assert.equal(probes, 0, 'no allowlist: no probe');
    const cfg = E.defaults(); cfg.providers.claude.allowedIps = ['203.0.113.10']; m.save(cfg);
    assert.deepEqual(m.launchRule('claude'), { host: cfg.providers.claude.host, allowedIps: ['203.0.113.10'], allowedRegions: [] }); assert.equal(m.launchRule('chatgpt'), null);
    const before = m.snapshot().events.length;
    assert.deepEqual(await m.gateLaunch('claude', 'Claude Code'), { ok: true }); assert.deepEqual(await m.gateLaunch('claude', 'Claude Code'), { ok: true }); assert.equal(probes, 2, 'probes every time, never reuses an old result');
    ip = '198.51.100.9';
    let r = await m.gateLaunch('claude', 'Claude Code'); assert.equal(r.ok, false); assert.match(r.message, /出口 IP 198\.51\.100\.9 不在白名单里，已拒绝启动 Claude Code/);
    fail = true; r = await m.gateLaunch('claude', 'Claude Code'); assert.equal(r.ok, false); assert.match(r.message, /没能确认出口 IP，已拒绝启动 Claude Code/);
    const events = m.snapshot().events.slice(0, m.snapshot().events.length - before);
    assert.deepEqual(events.map(e => e.message), ['已拒绝启动 CLI：无法确认出口 IP', '已拒绝启动 CLI：出口 IP 不在允许列表内'], 'refusals are recorded');
    // 规则：设了 IP 白名单只看 IP（地区白名单不管）；没设 IP、设了地区白名单看地区；都没设不检测
    fail = false; ip = '203.0.113.10';
    const both = E.defaults(); both.providers.claude.allowedIps = ['203.0.113.10']; both.providers.claude.allowedRegions = ['JP']; m.save(both);
    assert.deepEqual(await m.gateLaunch('claude', 'Claude Code'), { ok: true }, 'IP matches: region list (JP, exit is US) is ignored');
    ip = '198.51.100.9'; both.providers.claude.allowedRegions = ['US']; m.save(both);
    assert.equal((await m.gateLaunch('claude', 'Claude Code')).ok, false, 'IP does not match: a matching region does not rescue it');
    const regionOnly = E.defaults(); regionOnly.providers.claude.allowedRegions = ['US']; m.save(regionOnly);
    assert.deepEqual(m.launchRule('claude'), { host: regionOnly.providers.claude.host, allowedIps: [], allowedRegions: ['US'] });
    assert.deepEqual(await m.gateLaunch('claude', 'Claude Code'), { ok: true }, 'region list only: region decides, any IP');
    regionOnly.providers.claude.allowedRegions = ['JP']; m.save(regionOnly);
    r = await m.gateLaunch('claude', 'Claude Code'); assert.equal(r.ok, false); assert.match(r.message, /出口地区 US 不在地区白名单里，已拒绝启动 Claude Code/);
    fail = true; r = await m.gateLaunch('claude', 'Claude Code'); assert.equal(r.ok, false); assert.match(r.message, /没能确认出口地区，已拒绝启动 Claude Code/);
    assert.deepEqual(m.snapshot().events.slice(0, 2).map(e => e.message), ['已拒绝启动 CLI：无法确认出口地区', '已拒绝启动 CLI：出口地区不在允许列表内']);
    m.save(E.defaults()); const n = probes; assert.deepEqual(await m.gateLaunch('claude', 'Claude Code'), { ok: true }); assert.equal(probes, n, 'neither list: start without checking');
    m.stop(); checks++; console.log('PASS CLI launch gate (IP list wins, region list when no IP list, neither = no check): no allowlist passes without probing, allowlisted exit passes, other exit or failed probe refuses and is recorded');
  }
  checks++; console.log('PASS check interval: default 10 s, 5–60 s integers only, older settings upgraded, timer re-armed on change, saved across restarts');
  checks++; console.log('PASS monitor looks each exit IP up once, respects the switch and throttles manual refresh');
  // ---- 额度查询前的出口 IP 放行检查 ----
  {
    let gateIp = '203.0.113.10', gateError, probes = 0, notified = [], gateClock = NOW + 7200000;
    const gate = new ExitMonitor({ now: () => gateClock, notify: event => notified.push(event), probe: async (provider, host) => { probes++; return gateError ? { provider, host, checkedAt: gateClock, latencyMs: 0, error: gateError } : sample({ provider, host, ip: gateIp, checkedAt: gateClock }); } });
    gate.clearHistory();
    const cfg = E.defaults(); cfg.providers.claude.allowedIps = ['203.0.113.10'];
    gate.save(cfg); // 监控没开也要检查：白名单是用户定的规矩
    assert.equal(await gate.gateQuota('chatgpt'), true, 'no allowlist: nothing to compare, allowed');
    assert.equal(probes, 0, 'no probe without an allowlist');
    assert.equal(await gate.gateQuota('claude'), true); assert.equal(probes, 1);
    gateIp = '198.51.100.99'; gateClock += 60000;
    assert.equal(await gate.gateQuota('claude'), false, 'exit IP outside the allowlist blocks the quota query');
    assert.equal(gate.snapshot().quotaBlocks.claude.ip, '198.51.100.99');
    assert.equal(notified.length, 1); assert.match(notified[0].message, /已拦截额度查询/);
    gateClock += 60000; assert.equal(await gate.gateQuota('claude'), false);
    assert.equal(notified.length, 1, 'same block alerts once, not every round');
    gateError = 'timeout'; gateClock += 60000;
    assert.equal(await gate.gateQuota('claude'), false, 'cannot confirm the exit: blocked too');
    assert.equal(notified.length, 2); assert.match(notified[1].message, /无法确认出口/);
    gateError = undefined; gateIp = '203.0.113.10'; gateClock += 60000;
    assert.equal(await gate.gateQuota('claude'), true);
    assert.equal(gate.snapshot().quotaBlocks.claude, undefined); assert.equal(gate.snapshot().events[0].type, 'recovery');
    // 10 秒内刚探测过的结果直接用，不重复探测
    await gate.check(true); const before = probes; assert.equal(await gate.gateQuota('claude'), true); assert.equal(probes, before, 'fresh probe is reused');
    gate.stop();
    // fetchOfficialQuota 只跳过被拦的那家（凭据都是空的，这里只看 gate 被问了哪几家、有没有抛错）
    const Q = require('../build/core/quota');
    const asked = [];
    await Q.fetchOfficialQuota(true, async kind => { asked.push(kind); return kind !== 'claude'; });
    assert.deepEqual(asked.sort(), ['chatgpt', 'claude', 'grok']);
    await Q.fetchOfficialQuota(true, async () => { throw new Error('boom'); });
    checks++; console.log('PASS quota queries are gated by the exit IP allowlist: block, single alert, probe failure, recovery');
  }
  console.log(`${checks}/${checks} egress checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('tokenpulse-egress-test-'));
  fs.rmSync(root, { recursive: true, force: true });
});
