/*
 * Antigravity「模型与思考等级 · 时间线」按额度池分开（main/antigravity-quota.ts 的 timeline）。
 * Gemini 组和 Claude / GPT 组各有自己的 5 小时、周额度窗口，重置时间不同：
 * 每组两张卡，周期按这一组自己的采样切，曲线是这一组的已用百分比，请求只算这一组的型号。
 * 一次性数据目录，不碰真实的 ~/.tokenpulse。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-agy-timeline-'));
Object.assign(process.env, { TOKENPULSE_DATA_DIR: path.join(root, 'data'), TOKENPULSE_ANTIGRAVITY_DIR: path.join(root, 'antigravity') });
fs.mkdirSync(path.join(root, 'data'), { recursive: true });

const HOUR = 3_600_000, DAY = 24 * HOUR;
const now = Date.UTC(2026, 10, 9, 12, 0, 0);
const iso = ms => new Date(ms).toISOString();
const G = 'Gemini 3.8 Flash|Gemini 4 Argon', C = 'Claude Opus 5.5|Claude Sonnet 5.5|GPT-OSS 120B';
// Gemini：5 小时窗口 14:00 重置、周额度 11-13 重置；Claude / GPT：5 小时 16:00 重置、周额度 11-14 重置
const gFive = now + 2 * HOUR, cFive = now + 4 * HOUR, gWeek = now + 4 * DAY, cWeek = now + 5 * DAY;
const sample = (at, g, c) => ({ at, groups: [
  { key: G, used: g[0], resetAt: iso(gFive), weekUsed: g[1], weekResetAt: iso(gWeek) },
  { key: C, used: c[0], resetAt: iso(cFive), weekUsed: c[1], weekResetAt: iso(cWeek) },
] });
const stored = {
  last: { at: now - 60_000, ok: true, plan: 'Pro', groups: [
    { key: G, title: 'Gemini Models', models: ['Gemini 4 Argon', 'Gemini 3.8 Flash'], used: 12, resetAt: iso(gFive), week: { used: 20, resetAt: iso(gWeek) } },
    { key: C, title: 'Claude and GPT models', models: ['Claude Opus 5.5', 'Claude Sonnet 5.5', 'GPT-OSS 120B'], used: 55, resetAt: iso(cFive), week: { used: 40, resetAt: iso(cWeek) } },
  ] },
  history: [sample(now - 2 * HOUR, [5, 18], [30, 35]), sample(now - HOUR, [10, 19], [50, 39]), sample(now - 10 * 60_000, [12, 20], [55, 40])],
  notified: {},
};
fs.writeFileSync(path.join(root, 'data', 'antigravity-quota.json'), JSON.stringify(stored));

const { AntigravityQuota } = require('../build/main/antigravity-quota');
const row = (at, model, tokens) => ({ at, model, effort: 'high', tokens, calls: 1, costUsd: 0, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, source: 'Antigravity', kind: 'antigravity' });
const rows = [
  row(now - 90 * 60_000, 'gemini-4-argon', 1000),
  row(now - 30 * 60_000, 'gemini-3.8-flash', 300),
  row(now - 80 * 60_000, 'claude-opus-5-5', 5000),
  row(now - 20 * 60_000, 'gpt-oss-120b', 700),
];

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
try {
  const q = new AntigravityQuota({ now: () => now, fetcher: async () => null });
  q.recentRows = () => rows;
  const t = q.timeline({});

  assert.deepEqual(t.windows.map(w => w.id), ['g0-five', 'g0-week', 'g1-five', 'g1-week']);
  assert.deepEqual(t.windows.map(w => w.label), ['Gemini Models · 5 小时', 'Gemini Models · 周额度', 'Claude and GPT models · 5 小时', 'Claude and GPT models · 周额度']);
  pass('each quota pool gets its own 5-hour and weekly card');

  const end = id => t[id].selected.endAt;
  assert.equal(end('g0-five'), gFive);
  assert.equal(end('g1-five'), cFive);
  assert.equal(end('g0-week'), gWeek);
  assert.equal(end('g1-week'), cWeek);
  pass('cycles follow each pool\'s own reset times');

  assert.deepEqual(t['g0-five'].track.map(p => p.pct), [5, 10, 12, 12]);
  assert.deepEqual(t['g1-five'].track.map(p => p.pct), [30, 50, 55, 55]);
  assert.equal(t['g1-week'].track.at(-1).pct, 40);
  assert.equal(t['g0-week'].track.at(-1).pct, 20);
  assert.equal(t['g0-five'].selected.used, 12);
  assert.equal(t['g1-five'].selected.used, 55);
  pass('used-% curve belongs to that pool only (no max across pools)');

  const models = id => [...new Set(t[id].timeline.map(b => b.model))].sort();
  assert.deepEqual(models('g0-five'), ['gemini-3.8-flash', 'gemini-4-argon']);
  // Claude / GPT 的 5 小时窗口 1 小时前才开始（16:00 重置）：80 分钟前那条 Claude 请求属于它上一个窗口，不该算进来
  assert.deepEqual(models('g1-five'), ['gpt-oss-120b']);
  assert.deepEqual(models('g1-week'), ['claude-opus-5-5', 'gpt-oss-120b']);
  assert.equal(t['g0-week'].totals.tokens, 1300);
  assert.equal(t['g1-week'].totals.tokens, 5700);
  pass('requests are split by pool model and fall into that pool\'s own window');

  // 选某一池的历史周期：只影响那一张卡
  const picked = t['g1-five'].cycles.at(-1)?.id;
  const t2 = q.timeline({ cycles: { 'g1-five': picked, 'g0-five': 'not-a-cycle' } });
  assert.equal(t2['g1-five'].selected.id, picked);
  assert.equal(t2['g0-five'].selected.id, t['g0-five'].selected.id);
  pass('cycle selection is per card and invalid ids are ignored');

  // 还没查到过分组：退回 5 小时 + 周两张卡
  fs.writeFileSync(path.join(root, 'data', 'antigravity-quota.json'), JSON.stringify({ history: [], notified: {} }));
  const empty = new AntigravityQuota({ now: () => now, fetcher: async () => null });
  empty.recentRows = () => rows;
  const t3 = empty.timeline({});
  assert.deepEqual(t3.windows.map(w => w.id), ['five', 'week']);
  pass('without quota groups it falls back to the plain 5-hour + weekly cards');

  console.log(`\n${checks}/${checks} antigravity timeline checks passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
