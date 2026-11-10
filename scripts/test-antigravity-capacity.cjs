/*
 * Antigravity 整窗容量折算（main/antigravity-quota.ts 的 buildWindowInsight / weightedMedian）。
 * 1% 额度对应多少 Token 随用的型号变化很大：早几天主要用便宜的 Flash（同样 1% 多十几倍 Token），
 * 最近只用 Argon。容量只看最近几个窗口、取按百分比加权的中位数，不能被早先的窗口或个别窗口带偏。
 * 一次性数据目录，不碰真实的 ~/.tokenpulse。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-agy-capacity-'));
Object.assign(process.env, { TOKENPULSE_DATA_DIR: path.join(root, 'data'), TOKENPULSE_ANTIGRAVITY_DIR: path.join(root, 'antigravity') });
fs.mkdirSync(path.join(root, 'data'), { recursive: true });

const H = 3_600_000;
const now = Date.UTC(2026, 10, 10, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const KEY = 'Gemini 3.8 Flash|Gemini 4 Argon';
// 10 个首尾相接的 5 小时窗口，最后一个还在进行中。每个窗口用到 10%；
// 前 4 个（早几天）每 1% 约 3000 万 Token（Flash 为主），后 6 个每 1% 200 万（Argon），其中第 8 个混进一个 Flash 窗口
const tokensPerPct = [30e6, 30e6, 30e6, 30e6, 2e6, 2e6, 2e6, 30e6, 2e6, 2e6];
const firstStart = now - 9 * 5 * H - 2 * H;
const windows = tokensPerPct.map((perPct, i) => ({ start: firstStart + i * 5 * H, reset: firstStart + (i + 1) * 5 * H, perPct }));
const history = [], rows = [];
for (const w of windows) {
  for (const [offset, used] of [[10 * 60_000, 0], [2 * H, 5], [4 * H, 10]]) {
    if (w.start + offset > now) continue;
    history.push({ at: w.start + offset, groups: [{ key: KEY, used, resetAt: iso(w.reset), weekUsed: 5, weekResetAt: iso(now + 4 * 24 * H) }] });
  }
  // 窗口里的本机请求：10% 对应的 Token 分两次
  for (const at of [w.start + H, w.start + 3 * H]) if (at <= now) rows.push({ at, model: 'gemini-4-argon', effort: 'high', tokens: w.perPct * 5, costUsd: w.perPct * 5 / 1e6, calls: 1, input: w.perPct * 5, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 1, source: 'Antigravity', kind: 'antigravity' });
}
const current = windows.at(-1);
const used = 5; // 当前窗口采样到的 2 小时那一刻
fs.writeFileSync(path.join(root, 'data', 'antigravity-quota.json'), JSON.stringify({
  last: { at: now - 60_000, ok: true, plan: 'Pro', groups: [{ key: KEY, title: 'Gemini Models', models: ['Gemini 4 Argon', 'Gemini 3.8 Flash'], used, resetAt: iso(current.reset), week: { used: 5, resetAt: iso(now + 4 * 24 * H) } }] },
  history, notified: {},
}));

const mod = require('../build/main/antigravity-quota');
let checks = 0;
const pass = (name) => { checks++; console.log('PASS ' + name); };
try {
  assert.equal(mod.weightedMedian([[1, 1], [2, 1], [100, 1]]), 2, '中位数不受极端值影响');
  assert.equal(mod.weightedMedian([[1, 1], [3, 1]]), 2, '正好一半时取两边平均');
  assert.equal(mod.weightedMedian([[10, 1], [20, 5]]), 20, '按权重');
  assert.equal(mod.weightedMedian([]), 0);
  pass('weightedMedian picks the value where cumulative weight passes half');

  const q = new mod.AntigravityQuota({ now: () => now, fetcher: async () => null });
  q.recentRows = () => rows;
  const five = q.buildInsight(now).groups[0].five;
  const history5 = q.buildInsight(now).groups[0].capacityHistory.five;
  assert.ok(history5.length >= 9, `每个窗口都折算出一个点（${history5.length}）`);
  // 现在的用法：每 1% 200 万 → 整窗约 2 亿。旧算法（30 天全部窗口、总 Token ÷ 总百分比）会得到十几亿
  const full = five.capacity.fullTokens;
  assert.ok(full >= 150e6 && full <= 250e6, `整窗容量跟着最近的用法（约 2 亿），实际 ${full}`);
  const pooled = history5.reduce((s, p) => s + p.tokens, 0) / history5.reduce((s, p) => s + p.usedPct, 0) * 100;
  assert.ok(pooled > 5 * full, `对照：全部窗口合起来平均会被早先的用法带偏好几倍（${Math.round(pooled)}）`);
  assert.equal(five.capacity.intervals, 6, '只用最近 6 个 5 小时窗口');
  assert.equal(five.capacity.remainingTokens, Math.round(full * (100 - used) / 100), '剩余可用按同一个容量算');
  pass('5-hour capacity follows the recent windows and ignores older or one-off different-usage windows');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
console.log(`\n${checks}/2 antigravity capacity checks`);
