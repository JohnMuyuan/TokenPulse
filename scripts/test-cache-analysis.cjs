const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-cache-analysis-'));
process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'TOKENPULSE_DSH_HOME']) delete process.env[key];
const build = path.join(__dirname, '..', 'build', 'core');
const { analyzeCache } = require(path.join(build, 'cache-analysis.js'));
const { cacheSavings, priceOf } = require(path.join(build, 'model-pricing.js'));
const { appendRequests, queryRequests } = require(path.join(build, 'request-log.js'));
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS  ${name}`); };
const at = Date.now() - 60_000;
const row = (session, extra = {}) => ({
  key: `${session}-${extra.at || at}`, at, source: 'Claude Code', session, model: 'gpt-6-astra', cwd: 'D:\\Demo\\cache',
  input: 10_000, output: 100, cacheRead: 8_000, cacheWrite: 500, reasoning: 0, tokens: 10_100, costUsd: 0,
  priced: true, calls: 1, official: undefined, account: null, status: 'unverified', statusLabel: '', reasons: [], channel: '', ...extra
});

try {
  check('cacheSavings returns net savings and keeps Claude cache-write premiums negative', () => {
    const price = priceOf('claude-opus-5-5');
    const result = cacheSavings('claude-opus-5-5', { input: 100, output: 0, cacheRead: 10, cacheWrite: 90 });
    assert.ok(result < 0);
    assert.equal(result, (10 * (price.input - price.cacheRead) - 90 * (price.cacheWrite - price.input)) / 1_000_000);
    assert.equal(cacheSavings('no-such-model', { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 }), null);
  });

  check('hit rate uses cache reads divided by input, and group totals include read and write tokens', () => {
    const result = analyzeCache([
      row('mix', { at, input: 10_000, cacheRead: 4_000, cacheWrite: 1_000 }),
      row('mix', { at: at + 60_000, input: 10_000, cacheRead: 5_000, cacheWrite: 500 })
    ]);
    assert.equal(result.totals.input, 20_000);
    assert.equal(result.totals.cacheRead, 9_000);
    assert.equal(result.totals.cacheWrite, 1_500);
    assert.equal(result.totals.fresh, 9_500);
    assert.equal(result.totals.hitRate, 0.45);
    assert.equal(result.daily.length, 1);
    assert.equal(result.daily[0].hitRate, 0.45);
    assert.equal(result.bySource[0].hitRate, 0.45);
    assert.equal(result.byModel[0].cacheWrite, 1_500);
  });

  check('a session first request is counted as a cold start and never as a break', () => {
    const result = analyzeCache([row('cold', { at, cacheRead: 0, cacheWrite: 700 })]);
    assert.equal(result.coldStarts.count, 1);
    assert.equal(result.coldStarts.tokens, 700);
    assert.ok(result.coldStarts.costUsd > 0);
    assert.equal(result.breaks.count, 0);
  });

  check('all five causes are detected in priority order', () => {
    const make = (session, options = {}) => {
      const prev = row(session, { at, input: 10_000, cacheRead: 8_000, cacheWrite: 0, model: options.prevModel || 'gpt-6-astra', account: options.prevAccount || null });
      const cur = row(session, { at: at + (options.gap || 60_000), input: 10_000, cacheRead: 0, cacheWrite: 0, model: options.model || 'gpt-6-astra', account: options.account || null });
      return options.compaction ? [prev, row(session, { at: at + 30_000, compaction: true, input: 999_999, cacheRead: 0 }), cur] : [prev, cur];
    };
    const acc = id => ({ id, label: id, basis: 'route' });
    const rows = [
      ...make('compaction', { compaction: true, prevModel: 'gpt-6-astra', model: 'claude-sonnet-5', prevAccount: acc('a'), account: acc('b'), gap: 9 * 60_000 }),
      ...make('model', { prevModel: 'gpt-6-astra', model: 'claude-sonnet-5', prevAccount: acc('a'), account: acc('b'), gap: 9 * 60_000 }),
      ...make('account', { prevAccount: acc('a'), account: acc('b'), gap: 9 * 60_000 }),
      ...make('idle', { gap: 6 * 60_000 }),
      ...make('unknown')
    ];
    const result = analyzeCache(rows);
    assert.equal(result.breaks.count, 5);
    assert.deepEqual(Object.fromEntries(Object.entries(result.breaks.byCause).map(([cause, value]) => [cause, value.count])), {
      compaction: 1, model: 1, account: 1, idle: 1, unknown: 1
    });
    assert.ok(result.breaks.byCause.compaction.extraUsd > 0);
    assert.equal(result.recentBreaks[0].cause, 'compaction');
  });

  check('compaction estimates count in totals like other pages, are skipped as break bases and explain the next break', () => {
    const result = analyzeCache([
      row('skip', { at, input: 10_000, cacheRead: 8_000 }),
      row('skip', { at: at + 30_000, compaction: true, input: 999_999, cacheRead: 999_999 }),
      row('skip', { at: at + 60_000, input: 10_000, cacheRead: 0 })
    ]);
    assert.equal(result.totals.input, 1_019_999);
    assert.equal(result.totals.cacheRead, 1_007_999);
    assert.equal(result.breaks.count, 1);
    assert.equal(result.breaks.byCause.compaction.count, 1);
    assert.equal(result.breaks.lostTokens, 10_000, 'the base is the previous real request, not the compaction estimate');
    assert.equal(result.sessions[0].requests, 2);
  });

  check('CC Switch imports count in totals but are not treated as one-request sessions', () => {
    const result = analyzeCache([
      row('cc-1', { key: 'cc-switch\u0000cc-1', cacheRead: 0, cacheWrite: 900 }),
      row('cc-2', { key: 'cc-switch\u0000cc-2', cacheRead: 0, cacheWrite: 900 })
    ]);
    assert.equal(result.totals.input, 20_000);
    assert.equal(result.totals.cacheWrite, 1_800);
    assert.equal(result.coldStarts.count, 0);
    assert.equal(result.breaks.count, 0);
    assert.equal(result.sessions.length, 0);
  });

  check('a base below 4096 tokens is not a break', () => {
    const result = analyzeCache([
      row('small', { at, input: 3_000, cacheRead: 2_000 }),
      row('small', { at: at + 60_000, input: 5_000, cacheRead: 0 })
    ]);
    assert.equal(result.breaks.count, 0);
  });

  check('unpriced models retain token counts without adding money', () => {
    const result = analyzeCache([
      row('unpriced', { at, model: 'unknown-model', input: 8_192, output: 50, cacheRead: 8_000, cacheWrite: 0 }),
      row('unpriced', { at: at + 60_000, model: 'unknown-model', input: 8_192, output: 50, cacheRead: 0, cacheWrite: 0 })
    ]);
    assert.equal(result.totals.unpricedTokens, 16_484);
    assert.equal(result.totals.savingsUsd, 0);
    assert.equal(result.breaks.lostTokens, 8_192);
    assert.equal(result.breaks.extraUsd, 0);
  });

  check('Claude agent-* sessions are grouped separately from their parent session', () => {
    const result = analyzeCache([
      row('parent', { at, cacheRead: 0, cacheWrite: 20 }),
      row('agent-child', { at: at + 1, cacheRead: 0, cacheWrite: 40 })
    ]);
    assert.equal(result.coldStarts.count, 2);
    assert.equal(result.coldStarts.tokens, 60);
  });

  check('queryRequests(cache: true) analyzes all filtered rows, independent of page size', () => {
    const base = at + 120_000;
    appendRequests([
      { id: 'query-a', at: base, kind: 'codex', file: path.join(root, 'rollout-2026-10-15T12-00-00-cache.jsonl'), cwd: 'D:\\Demo\\cache', model: 'gpt-6-astra', input: 10_000, output: 100, cacheRead: 8_000, cacheWrite: 0, reasoning: 0, costUsd: 0, calls: 1 },
      { id: 'query-b', at: base + 60_000, kind: 'codex', file: path.join(root, 'rollout-2026-10-15T12-00-00-cache.jsonl'), cwd: 'D:\\Demo\\cache', model: 'gpt-6-astra', input: 10_000, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, calls: 1 }
    ]);
    const date = new Date(base), day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const result = queryRequests({ from: day, to: day, source: 'all', status: 'all', search: '', sort: 'time', page: 0, pageSize: 1, cache: true });
    assert.equal(result.rows.length, 1);
    assert.equal(result.cache.breaks.count, 1);
    assert.equal(result.cache.totals.input, 20_000);
    assert.equal(result.cache.breaks.byCause.idle.count, 0);
  });

  check('empirical model cache retention estimates Gemini short/volatile, Claude ~5m cliff, GPT >=22m, short-gaps-only and exclusions', () => {
    const min = 60_000;
    const buildSeries = (session, source, model, gapsAndHits) => {
      let cursor = at;
      const out = [row(session, { at: cursor, source, model, input: 12_000, cacheRead: 0, cacheWrite: 12_000 })];
      for (const [gapMs, kept] of gapsAndHits) {
        cursor += gapMs;
        out.push(row(session, { at: cursor, source, model, input: 12_000, cacheRead: kept ? 10_800 : 0, cacheWrite: kept ? 0 : 12_000 }));
      }
      return out;
    };
    const rows = [
      // Gemini 隐式缓存：短间隔能命中，但 2–4 分钟就开始高比例掉光 -> estimated ≈ 2–3 分钟 + opportunistic
      ...buildSeries('gem-1', 'Antigravity', 'gemini-4-carbon', [
        [25_000, true], [45_000, true], [1.8 * min, true], [2.2 * min, false], [3.2 * min, false], [4.1 * min, false], [6.5 * min, false],
      ]),
      // Claude 默认 5 分钟：4.7 分钟仍保住，5.3 分钟起全掉 -> estimated ≈ 5 分钟，opportunistic = false
      ...buildSeries('claude-1', 'Claude Code', 'claude-opus-4-6', [
        [30_000, true], [2.1 * min, true], [3.6 * min, true], [4.7 * min, true], [5.3 * min, false], [7.8 * min, false],
      ]),
      // Codex 长效前缀缓存：停 22 分钟仍命中，尚未测到断崖 -> at-least 22 分钟
      ...buildSeries('gpt-1', 'Codex CLI', 'gpt-5.4', [
        [40_000, true], [4 * min, true], [12 * min, true], [22 * min, true],
      ]),
      // 只有 1 分钟内密集调用 -> short-gaps-only
      ...buildSeries('short-1', 'Claude Code', 'claude-haiku-4-5', [
        [12_000, true], [20_000, true], [38_000, true],
      ]),
      // 始终无缓存命中 -> no-cache
      ...buildSeries('nocache-1', 'pi', 'relay-raw-model', [
        [20_000, false], [90_000, false], [240_000, false],
      ]),
      // 样本不足 (<3) -> insufficient
      ...buildSeries('few-1', 'Grok Build', 'grok-4.7-build', [
        [30_000, true], [120_000, true],
      ]),
    ];
    const res = analyzeCache(rows);
    const byModel = new Map(res.retention.map(r => [r.model, r]));

    const gem = byModel.get('gemini-4-carbon');
    assert.equal(gem.status, 'estimated');
    assert.equal(gem.opportunistic, true, 'Gemini short-gap misses flag opportunistic implicit caching');
    assert.deepEqual([gem.ttlMinMs, gem.ttlMaxMs], [2 * min, 3 * min]);

    const claude = byModel.get('claude-opus-4-6');
    assert.equal(claude.status, 'estimated');
    assert.equal(claude.opportunistic, false);
    assert.deepEqual([claude.ttlMinMs, claude.ttlMaxMs], [5 * min, 5 * min]);

    const gpt = byModel.get('gpt-5.4');
    assert.equal(gpt.status, 'at-least');
    assert.equal(gpt.ttlMinMs, 22 * min);
    assert.equal(gpt.ttlMaxMs, null);

    assert.equal(byModel.get('claude-haiku-4-5').status, 'short-gaps-only');
    assert.equal(byModel.get('relay-raw-model').status, 'no-cache');
    assert.equal(byModel.get('grok-4.7-build').status, 'insufficient');
  });

  check('subagent and swarm metadata plus sessionKey propagate to cache sessions and recentBreaks', () => {
    const result = analyzeCache([
      row('worker-1', {
        at,
        source: 'Antigravity',
        sessionKey: 'antigravity:worker-1',
        sessionTitle: 'audit-worker · 检查缓存',
        isSubagent: true,
        parentKey: 'antigravity:coord-1',
        agentName: 'audit-worker',
        subagentKind: 'swarm',
        swarmTitle: '缓存审计蜂群',
        input: 12_000,
        cacheRead: 10_000,
      }),
      row('worker-1', {
        at: at + 60_000,
        source: 'Antigravity',
        sessionKey: 'antigravity:worker-1',
        sessionTitle: 'audit-worker · 检查缓存',
        isSubagent: true,
        parentKey: 'antigravity:coord-1',
        agentName: 'audit-worker',
        subagentKind: 'swarm',
        swarmTitle: '缓存审计蜂群',
        input: 12_000,
        cacheRead: 0,
      }),
    ]);
    assert.equal(result.sessions.length, 1);
    assert.deepEqual(
      [
        result.sessions[0].sessionKey,
        result.sessions[0].title,
        result.sessions[0].isSubagent,
        result.sessions[0].parentKey,
        result.sessions[0].agentName,
        result.sessions[0].subagentKind,
        result.sessions[0].swarmTitle,
      ],
      ['antigravity:worker-1', 'audit-worker · 检查缓存', true, 'antigravity:coord-1', 'audit-worker', 'swarm', '缓存审计蜂群'],
    );
    assert.equal(result.recentBreaks[0].sessionKey, 'antigravity:worker-1');
  });

  console.log(`PASS ${passed} cache analysis checks`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
