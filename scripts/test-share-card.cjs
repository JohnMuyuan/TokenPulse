/*
 * 分享卡片（0.3.51）：月报、里程碑的数据（src/core/share-report.ts）和画成 PNG（src/main/share.ts + renderer/share-card.*）。
 * 全部用合成的用量，不读本机任何真实数据。TOKENPULSE_SHOT_DIR 设了就把两张图存下来看。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, nativeImage, clipboard } = require('electron');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-share-'));
process.env.TOKENPULSE_DATA_DIR = path.join(dir, 'data');
process.env.HOME = process.env.USERPROFILE = path.join(dir, 'home');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
app.setPath('userData', path.join(dir, 'electron'));
// 每张图的隐藏窗口会销毁；测试要等下一张，而不是最后一个窗口关闭就退出。
app.on('window-all-closed', () => {});
const report = require('../build/core/share-report.js');
const share = require('../build/main/share.js');
app.on('browser-window-created', (_, win) => {
  const capture = win.webContents.capturePage.bind(win.webContents);
  win.webContents.capturePage = async (...args) => {
    if (await win.webContents.executeJavaScript("document.documentElement.lang === 'en'")) {
      const text = await win.webContents.executeJavaScript("document.getElementById('stage').textContent");
      assert.ok(!/[一-鿿]/.test(text), 'English card contains untranslated Chinese: ' + text.match(/[^\n]*[一-鿿][^\n]*/g)?.join('\n'));
    }
    return capture(...args);
  };
});
let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const watchdog = setTimeout(() => { console.error('FAIL share card timed out'); app.exit(1); }, 60000);

// 合成用量：2026-05-19 起每天都有（9 月 8、22 日没用），越往后越多
const usage = [];
const day = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
for (let d = new Date('2026-05-19T12:00:00'), i = 0; d <= new Date('2026-10-13T12:00:00'); d.setDate(d.getDate() + 1), i++) {
  const key = day(d);
  if (key === '2026-09-08' || key === '2026-09-22') continue;
  const scale = Math.pow(1.03, i);
  for (const [source, model, share] of [['Claude Code', 'claude-opus-5', 0.5], ['Grok Build', 'grok-4.7', 0.35], ['Codex CLI', 'gpt-5.5', 0.15]]) {
    const tokens = Math.round(200_000 * scale * share * (key === '2026-09-18' ? 3 : 1));
    const input = Math.round(tokens * 0.97), cacheRead = Math.round(input * 0.9);
    usage.push({ day: key, source, model, input, output: tokens - input, cacheRead, cacheWrite: 0, reasoning: 0, costUsd: tokens / 1e6 * 4, requests: Math.max(1, Math.round(tokens / 60_000)), tokens, priced: true });
  }
}
const hours = Array.from({ length: 24 * 30 }, (_, i) => ({ hour: new Date('2026-09-01T00:00:00').getTime() + i * 3600_000, tokens: (i % 24 >= 22 || i % 24 < 2) ? 3000 : 1000, costUsd: 0, requests: 1, sources: {} }));
const sept = Date.parse('2026-09-10T12:00:00');
const speed = { from: 0, to: 0, bucketMs: 86400000, total: 0, lines: [
  { app: 'grok', model: 'grok-4.7', fast: false, effort: 'low', via: '', count: 40, speedCount: 40, firstCount: 40, tokensPerSec: 130, firstTokenMs: 600, lastAt: sept, buckets: [{ at: sept, tokensPerSec: 130, firstTokenMs: 600, count: 40, speedCount: 40, firstCount: 40 }] },
  { app: 'claude', model: 'claude-opus-5', fast: false, effort: 'xhigh', via: '', count: 30, speedCount: 30, firstCount: 30, tokensPerSec: 65, firstTokenMs: 2400, lastAt: sept, buckets: [{ at: sept, tokensPerSec: 65, firstTokenMs: 2400, count: 30, speedCount: 30, firstCount: 30 }] },
  { app: 'codex', model: 'gpt-5.5', fast: false, effort: 'high', via: '', count: 5, speedCount: 5, firstCount: 5, tokensPerSec: 200, firstTokenMs: 900, lastAt: sept, buckets: [{ at: sept, tokensPerSec: 200, firstTokenMs: 900, count: 5, speedCount: 5, firstCount: 5 }] },
] };

app.whenReady().then(async () => {
  try {
    const month = report.monthReport({ usage, month: '2026-09', hours, speed });
    const total = usage.filter(r => r.day.startsWith('2026-09')).reduce((s, r) => s + r.tokens, 0);
    assert.equal(month.tokens, total);
    assert.equal(month.days, 30);
    assert.equal(month.activeDays, 28);
    assert.equal(month.longestStreak, 13, '9/9–9/21');
    assert.equal(month.best.day, '2026-09-18');
    assert.deepEqual(month.tools.map(t => t.source), ['Claude Code', 'Grok Build', 'Codex CLI']);
    assert.equal(month.models[0].model, 'claude-opus-5');
    assert.ok(Math.abs(month.nightShare - (4 * 3000 + 4 * 1000) / (4 * 3000 + 20 * 1000)) < 1e-9, '22 点到 6 点（8 个小时）');
    assert.deepEqual(month.fastest.map(f => f.model), ['grok-4.7', 'claude-opus-5'], '不到 20 次的不算');
    assert.ok(month.previousTokens > 0 && month.tokens > month.previousTokens);
    assert.ok(month.cacheSavingsUsd > 0);
    assert.ok(month.analogy && month.analogy.count >= 3);
    assert.deepEqual(report.reportMonths(usage).slice(0, 2), ['2026-10', '2026-09']);
    pass('month report: totals, active days and streak, best day, tools and models, night share, fastest model (20+ samples), cache savings, analogy');

    const state = report.milestoneState(usage, Date.parse('2026-10-13T20:00:00'));
    const got = Object.fromEntries(state.list.filter(m => m.achievedAt).map(m => [m.id, m.achievedAt]));
    assert.ok(got['tokens-1e8'] && got['streak-7'] === '2026-05-25' && got['streak-30'] === '2026-06-17', JSON.stringify(got));
    assert.equal(got['streak-100'], '2026-08-26', '5/19 起第 100 天');
    assert.ok(!got['streak-365'], '9 月断过，连续 365 天没到');
    assert.equal(state.firstDay, '2026-05-19');
    assert.ok(state.speedup > 1);
    assert.ok(state.next && state.next.target > state.totals.tokens);
    assert.equal(state.companion.days, 146);
    pass('milestones: reached dates, broken streak, first day, speed-up, next goal, companion model');

    // 0.3.53：每一枚都有达成那天的样子，卡片下半部分用它，不用今天的累计
    const s7 = state.moments['streak-7'], s30 = state.moments['streak-30'], t1 = state.moments['tokens-1e8'];
    const upTo = d => usage.filter(r => r.day <= d).reduce((s, r) => s + r.tokens, 0);
    assert.equal(s7.day, '2026-05-25'); assert.equal(s7.dayIndex, 7);
    assert.equal(s7.totals.tokens, upTo('2026-05-25'), '达成那天的累计，不是今天的');
    assert.ok(s7.totals.tokens < state.totals.tokens);
    assert.deepEqual([s7.focus.streak.from, s7.focus.streak.to, s7.series.kind, s7.series.points.length], ['2026-05-19', '2026-05-25', 'daily', 7]);
    assert.deepEqual([s30.previous.label, s30.previous.gapDays], ['连续 7 天', 23]);
    assert.deepEqual([s7.next.label, s7.next.reachedAt], ['连续 30 天', '2026-06-17'], '同组下一枚后来哪天达成');
    assert.equal(t1.series.kind, 'cumulative'); assert.equal(t1.series.points.at(-1).day, t1.day, '累计曲线画到达成那天为止');
    assert.ok(t1.series.marks.some(m => m.current));
    assert.ok(!t1.series.points.some(p => p.day > t1.day));
    pass('milestone moments: totals, streak range, previous gap and next badge are as of the day each badge was reached');

    fs.mkdirSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'route-log'), { recursive: true });
    const speedRows = Array.from({ length: 20 }, (_, i) => ({ at: new Date(2026, 8, 1, 1, i).getTime(), app: 'claude', pool: true, provider: 'DEMO Pool · demo', status: 200, requestModel: 'demo-fast', tokensPerSec: 155, firstTokenMs: 500 }));
    fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'route-log', '2026-09.jsonl'), speedRows.map(JSON.stringify).join('\n'));
    const realMonth = await share.shareMonth(async () => ({ usage }), '2026-09');
    assert.equal(realMonth.report.tokens, total);
    assert.equal(realMonth.report.fastest[0].samples, 20, '月初记录不能落进跨月的周桶');
    assert.deepEqual(realMonth.report.routes, ['DEMO Pool']);
    assert.deepEqual((await share.shareMilestones(async () => ({ usage, now: Date.parse('2026-10-13T20:00:00') }))).totals, state.totals);
    pass('main share data reads the selected month and route speed with daily buckets, including the month boundary');

    month.routes = ['DEMO Pool', 'DEMO Provider'];
    for (const [kind, data, options] of [['month', month, { subscriptionUsd: 200, lang: 'zh' }], ['milestone', state, { lang: 'zh' }], ['month', month, { subscriptionUsd: 200, lang: 'en', showNames: true }], ['milestone', state, { lang: 'en' }]]) {
      const url = await share.renderShareCard(kind, data, options);
      const image = nativeImage.createFromDataURL(url);
      const { width, height } = image.getSize();
      assert.ok(width >= 1100 && height > 900, `${kind} ${width}x${height}`);
      if (process.env.TOKENPULSE_SHOT_DIR) fs.writeFileSync(path.join(process.env.TOKENPULSE_SHOT_DIR, `share-${kind}-${options.lang}.png`), image.toPNG());
    }
    await assert.rejects(share.renderShareCard('other', {}, {}), /卡片类型无效/);
    assert.equal(require('electron').BrowserWindow.getAllWindows().length, 0, '隐藏渲染窗口全部销毁');
    pass('both cards render to PNG through the hidden window; unknown kinds are refused; windows are destroyed');
    const writeClipboard = clipboard.write;
    let written;
    try {
      clipboard.write = async items => { written = items; };
      const url = await share.renderShareCard('month', month, {});
      await share.copyShareCard(url);
      assert.equal(written[0].types.includes('image/png'), true);
      await assert.rejects(share.copyShareCard('bad'), /图片无效/);
      await assert.rejects(share.saveShareCard(null, 'bad', 'test'), /图片无效/);
    } finally { clipboard.write = writeClipboard; }
    pass('clipboard gets a PNG item; malformed exports are refused before any OS action');
    clearTimeout(watchdog);
    console.log(`test-share-card: ${checks} checks passed`);
    app.exit(0);
  } catch (error) {
    clearTimeout(watchdog);
    console.error('FAIL', error);
    app.exit(1);
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
});
