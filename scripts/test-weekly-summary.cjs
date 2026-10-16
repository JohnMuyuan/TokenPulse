const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-weekly-'));
process.env.TOKENPULSE_DATA_DIR = path.join(temp, 'data');
process.env.HOME = process.env.USERPROFILE = path.join(temp, 'home');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });

const report = require('../build/core/share-report.js');
const weekly = require('../build/core/weekly-summary.js');
const prefs = require('../build/main/prefs.js');
const { translate } = require('../renderer/i18n.js');
const date = (year, month, day, hour = 12, minute = 0) => new Date(year, month - 1, day, hour, minute);
const usage = [
  { day: '2026-06-01', source: 'Claude Code', model: 'claude-opus-5', input: 1000, output: 200, cacheRead: 800, cacheWrite: 0, reasoning: 0, costUsd: 1.25, requests: 2, tokens: 1200, priced: true },
  { day: '2026-06-03', source: 'Claude Code', model: 'claude-opus-5', input: 3000, output: 500, cacheRead: 2400, cacheWrite: 0, reasoning: 0, costUsd: 2.5, requests: 3, tokens: 3500, priced: true },
];
let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };

try {
  assert.equal(prefs.readPrefs().weeklySummary, true);
  prefs.writePrefs({ weeklySummary: false });
  assert.equal(prefs.readPrefs().weeklySummary, false);
  pass('weekly summary preference defaults on and persists in the isolated data directory');

  assert.equal(report.weekStartOf(date(2026, 9, 27, 23, 59)), '2026-09-21', 'Sunday at 23:59 stays in the prior Monday week');
  assert.equal(report.weekStartOf(date(2026, 9, 28, 0, 0)), '2026-09-28', 'Monday at 00:00 starts the new week');
  assert.equal(report.weekStartOf(date(2026, 11, 1)), '2026-10-26', 'week crosses a month boundary');
  assert.equal(report.weekStartOf(date(2027, 1, 1)), '2026-12-28', 'week crosses a year boundary');
  assert.equal(report.isWeek('2026-06-01'), true);
  assert.equal(report.isWeek('2026-06-02'), false);
  pass('local week boundaries and Monday validation');

  assert.equal(weekly.weeklyDue(date(2026, 6, 8, 8, 59), null, true), null);
  assert.equal(weekly.weeklyDue(date(2026, 6, 8, 9), null, true), '2026-06-01');
  assert.equal(weekly.weeklyDue(date(2026, 6, 8, 9), { week: '2026-06-01', at: 1, sent: true }, true), null);
  assert.equal(weekly.weeklyDue(date(2026, 6, 15, 9), { week: '2026-06-01', at: 1, sent: true }, true), '2026-06-08');
  assert.equal(weekly.weeklyDue(date(2026, 6, 10, 12), null, true), '2026-06-01', 'first run on Wednesday catches up the immediately prior week');
  assert.equal(weekly.weeklyDue(date(2026, 6, 10, 12), null, false), null);
  pass('weekly due time, catch-up window and deduplication');

  const empty = report.weekReport({ usage: [], week: '2026-06-01' });
  assert.equal(empty.tokens, 0);
  assert.equal(empty.cacheHitRate, null);
  const noPrevious = report.weekReport({ usage, week: '2026-06-01' });
  const sameMonth = report.monthReport({ usage, month: '2026-06' });
  assert.equal(noPrevious.previousTokens, null);
  assert.equal(noPrevious.daily.length, 7);
  assert.equal(noPrevious.daily[0].day, '2026-06-01');
  assert.equal(noPrevious.daily[6].day, '2026-06-07');
  assert.equal(noPrevious.cacheHitRate, 3200 / 4000);
  assert.equal(sameMonth.tokens, noPrevious.tokens);
  assert.equal(sameMonth.cacheSavingsUsd, noPrevious.cacheSavingsUsd);
  assert.deepEqual(report.reportWeeks(usage), ['2026-06-01']);
  assert.equal(report.weekReport({ usage: [], week: '2026-12-28' }).label, '2026 年 12 月 28 日 – 2027 年 1 月 3 日');
  const yearTurn = weekly.describeWeekly(report.weekReport({ usage: [], week: '2026-12-28' }));
  assert.equal(yearTurn.title, '上周小结 · 2026/12/28–2027/1/3');
  assert.doesNotMatch(translate(yearTurn.title), /[一-鿿]/);
  const none = weekly.describeWeekly(noPrevious);
  assert.match(none.body, /用了 .* tokens，参考费用 \$/);
  assert.doesNotMatch(none.body, /比前一周/);
  const withPrevious = weekly.describeWeekly({ ...noPrevious, previousTokens: noPrevious.tokens / 2, cacheSavingsUsd: -12.345, cacheSavingsAvailable: true });
  assert.match(withPrevious.body, /比前一周多 100%/);
  assert.match(withPrevious.body, /缓存命中 80%，缓存写入多花约 \$12\.35/);
  assert.ok(withPrevious.body.split('\n').length <= 3);
  assert.doesNotMatch(translate(withPrevious.title), /[一-鿿]/);
  assert.doesNotMatch(translate(withPrevious.body), /[一-鿿]/);
  assert.doesNotMatch(translate(none.body), /[一-鿿]/);
  pass('weekly report metrics, notification copy, negative savings and English');

  const notices = [], targets = [];
  const call = () => weekly.maybeWeeklySummary({
    now: date(2026, 6, 8, 9, 5), usage, enabled: true,
    notify: notice => notices.push(notice), openPage: target => targets.push(target),
  });
  assert.deepEqual(call(), { week: '2026-06-01', sent: true });
  assert.equal(weekly.readWeeklyState().week, '2026-06-01');
  assert.equal(weekly.readWeeklyState().sent, true);
  assert.equal(notices.length, 1);
  call();
  assert.equal(notices.length, 1, 'second pass sends no duplicate');
  notices[0].onClick();
  assert.deepEqual(targets[0], { page: 'share', tab: 'week', pick: '2026-06-01' });
  pass('atomic state write, duplicate guard and notification deep link');

  process.env.TOKENPULSE_DATA_DIR = path.join(temp, 'empty-data');
  fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
  const noUsage = weekly.maybeWeeklySummary({ now: date(2026, 6, 8, 9), usage: [], enabled: true, notify: notice => notices.push(notice), openPage: target => targets.push(target) });
  assert.deepEqual(noUsage, { week: '2026-06-01', sent: false });
  assert.equal(weekly.readWeeklyState().sent, false);
  const count = notices.length;
  weekly.maybeWeeklySummary({ now: date(2026, 6, 15, 9), usage, enabled: false, notify: notice => notices.push(notice), openPage: target => targets.push(target) });
  assert.equal(notices.length, count);
  const file = path.join(process.env.TOKENPULSE_DATA_DIR, 'weekly-summary.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { week: '2026-06-01', at: date(2026, 6, 8, 9).getTime(), sent: false });
  assert.equal(fs.readdirSync(process.env.TOKENPULSE_DATA_DIR).some(name => name.endsWith('.tmp')), false);
  pass('zero-usage weeks are recorded without notices; disabled summaries stay quiet');
  console.log(`${checks}/${checks} weekly summary checks passed`);
} catch (error) {
  console.error('FAIL weekly summary', error);
  process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
