const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../renderer/data.js');
const row = (day, source, model, tokens, costUsd = 1) => ({ day, source, model, tokens, input: tokens - 10, output: 10, cacheRead: 20, cacheWrite: 5, reasoning: 3, requests: 1, costUsd, priced: true });
test('date filters include exact calendar days and compare the previous equal interval', () => {
  const rows = [row('2026-09-15', 'Codex CLI', 'a', 100), row('2026-09-16', 'Codex CLI', 'a', 200), row('2026-09-22', 'Codex CLI', 'a', 300), row('2026-09-23', 'Codex CLI', 'a', 400)];
  const a = D.analyze(rows, '2026-09-16', '2026-09-22');
  assert.equal(a.total.tokens, 500); assert.equal(a.previous.tokens, 100);
  assert.equal(a.daily.length, 7); assert.equal(a.activeDays, 2);
  assert.equal(a.daily[1].tokens, 0);
});
test('source filtering applies to totals, comparison, rankings and daily data', () => {
  const a = D.analyze([row('2026-09-22', 'Codex CLI', 'a', 200), row('2026-09-22', 'Claude Code', 'a', 900)], '2026-09-22', '2026-09-22', 'Codex CLI');
  assert.equal(a.total.tokens, 200); assert.equal(a.models.length, 1); assert.equal(a.sources.length, 1); assert.equal(a.daily[0].tokens, 200);
});
test('cache and reasoning are subsets; grouping does not count them twice', () => {
  const rows = [row('2026-09-22', 'Codex CLI', 'shared', 200), row('2026-09-22', 'Claude Code', 'shared', 300)];
  const a = D.analyze(rows, '2026-09-22', '2026-09-22');
  assert.equal(a.total.tokens, a.total.input + a.total.output); assert.equal(a.total.cacheRead, 40); assert.equal(a.models.length, 2);
});
test('unknown pricing remains visible and CSV is quoted and formula safe', () => {
  const rows = [{ ...row('2026-09-22', 'Codex CLI', '=HYPERLINK("example")', 100, 0), priced: false }];
  assert.equal(D.analyze(rows, '2026-09-22', '2026-09-22').unpriced, 1);
  const csv = D.csv(rows); assert.ok(csv.includes('"\'=HYPERLINK(""example"")"')); assert.ok(csv.includes('"false"')); assert.equal(csv.split('\r\n').length, 2);
});
test('calendar arithmetic handles daylight saving and leap days', () => {
  assert.equal(D.shift('2024-03-01', -1), '2024-02-29');
  assert.equal(D.dayCount('2026-03-07', '2026-03-10'), 4);
  assert.equal(D.analyze([], '2026-03-07', '2026-03-10').daily.length, 4);
  assert.equal(D.shift('2026-01-01', -1), '2025-12-31');
});
test('real snapshot exports aggregated usage with matching totals and exact 7-day boundary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-report-'));
  process.env.TOKENPULSE_DATA_DIR = dir;
  const { buildSnapshot } = require('../build/core/report.js');
  const now = new Date(2026, 8, 22, 1).getTime();
  const bucket = { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, reasoning: 5, requests: 1, costUsd: 0 };
  fs.writeFileSync(path.join(dir, 'usage-rollups.json'), JSON.stringify({ version: 1, files: { fixture: { days: { '2026-09-15': { 'Codex CLI': { 'gpt-5.4': bucket } }, '2026-09-16': { 'Codex CLI': { 'gpt-5.4': bucket } }, '2026-09-22': { 'Codex CLI': { unknown: bucket } } } } } }));
  const s = buildSnapshot(now);
  assert.equal(s.totals.week.tokens, 240); assert.equal(s.totals.all.tokens, 360); assert.equal(s.usage.length, 3);
  assert.equal(D.sum(s.usage).tokens, s.totals.all.tokens); assert.equal(s.fileCount, 1);
  assert.equal(s.usage.find(r => r.model === 'unknown').priced, false);
  assert.equal(s.daily.length, 60); assert.equal(s.daily.at(-1).day, '2026-09-22');
  assert.equal(s.usage.some(r => 'path' in r || 'content' in r), false);
});
