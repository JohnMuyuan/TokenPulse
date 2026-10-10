/*
 * DeepSeek 账号页的分析（0.3.42，src/core/deepseek-insight.ts）和 DeepSeek Harness 出字时间的采集（usage-scan.ts）。
 * 覆盖：日志里的 step/start + stream 时间 → 首字延迟和每秒 Token 数（太短的回复不记速度）；
 * 余额历史的记法（数字没变的连续几次只留头尾）和删除；花了多少 / 日均 / 还能用几天；余额减少时本机有没有请求 → 本机 / 本机以外、
 * 实际折算率（偏离太多不采用）；余额换成每个模型高峰 / 闲时能用多少；没指定本机用量的账号；时间线和速度的结构。
 * 用一次性的 HOME 和数据目录，数字都是编的，能手算出来。不联网，不碰真实的 ~/.dsh 和 ~/.tokenpulse。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-dsi-'));
process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
const build = path.join(__dirname, '..', 'build', 'core');
const { scanLocalUsage } = require(path.join(build, 'usage-scan.js'));
const { queryRequests } = require(path.join(build, 'request-log.js'));
const insight = require(path.join(build, 'deepseek-insight.js'));

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const H = 3600_000, D = 24 * H;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

try {
  // 1. 出字时间：step/start 之后 1.7 秒来第一块，再过 4 秒结束，输出 800 Token → 首字 1700 毫秒、每秒 200 Token
  const base = Date.now() - 2 * H;
  const frame = rows => zlib.zstdCompressSync(Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n'));
  const reply = (seq, at, output, stream) => ({ type: 'assistant/message', seq, time: at, data: { turn: 1, step: seq, message: { role: 'assistant', id: 'msg-' + seq, content: [], source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } },
    usage: { inputTokens: 1000, outputTokens: output, cacheReadTokens: 4000, cacheWriteTokens: 0, totalTokens: 5000 + output }, ...(stream ? { stream: stream.map(time => ({ type: 'chunk', time, chunk: {} })) } : {}) } });
  const file = path.join(process.env.HOME, '.dsh', 'sessions', '--D-qa--', 'session-speed', 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([
    frame([{ type: 'session', version: 4, id: 'session-speed', createdAt: base, cwd: 'D:\\qa' }]),
    frame([{ type: 'request/header', seq: 1, time: base, data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } } } },
      { type: 'step/start', seq: 2, time: base + 1000, data: { turn: 1, step: 1 } }, reply(3, base + 6800, 800, [base + 2700, base + 4000, base + 6700]),
      { type: 'step/start', seq: 4, time: base + 10_000, data: { turn: 1, step: 2 } }, reply(5, base + 11_900, 10, [base + 11_500, base + 11_800]),
      reply(6, base + 20_000, 500, null)]),
  ]));
  scanLocalUsage();
  const rows = queryRequests({ from: '2000-01-01', to: '2999-01-01', source: 'DeepSeek Harness', status: 'all', search: '', sort: 'time', page: 0, pageSize: 50, all: true }).rows.sort((a, b) => a.at - b.at);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].timing, { stream: true, firstTokenMs: 1700, tokensPerSec: 200 });
  assert.deepEqual(rows[1].timing, { stream: true, firstTokenMs: 1500 }, '回复太短：只记首字，不记速度');
  assert.equal(rows[2].timing, undefined, '日志里没有 stream 的不编');
  const speed = insight.deepseekSpeed(rows, 7, Date.now());
  assert.deepEqual([speed.models.length, speed.models[0].model, speed.models[0].tokensPerSec, speed.models[0].count, speed.models[0].firstTokenMs, speed.total], [1, 'DeepSeek-V4.1-Flash', 200, 1, 1600, 1]);
  pass('first-token delay and tokens per second come from the stream times Harness logs; short replies get no speed');

  // 2. 余额历史：数字没变的连续几次只留头尾（尾巴的时间往后挪），变了才多一笔；删账号时一起删
  const info = total => [{ currency: 'CNY', total, granted: 10, toppedUp: total - 10 }];
  const t0 = Date.now() - D;
  for (const [minutes, total] of [[0, 50], [10, 50], [20, 50], [30, 50], [40, 49.5], [50, 49.5]]) insight.appendBalanceSamples('acc1', t0 + minutes * 60000, info(total));
  insight.appendBalanceSamples('acc2', t0, info(7));
  assert.deepEqual(insight.readBalanceHistory('acc1').map(s => [(s.at - t0) / 60000, s.total]), [[0, 50], [30, 50], [40, 49.5], [50, 49.5]]);
  insight.appendBalanceSamples('acc1', t0 + 5 * 60000, info(1));
  assert.equal(insight.readBalanceHistory('acc1').length, 4, '比最后一笔还早的不记');
  insight.removeBalanceHistory('acc1');
  assert.deepEqual([insight.readBalanceHistory('acc1').length, insight.readBalanceHistory('acc2').length], [0, 1]);
  pass('balance history keeps only the first and last of a run of equal values; removing an account removes its history');

  // 3. 分析。余额：9 天前 68.00 … 4 天前充 50 … 40 分钟前 110.00。每次减少前本机有 6 条请求（参考费用 = 减少的钱 ÷ 7.14），
  //    只有 5 天前（0.8）和 26 小时前（0.7）那两次本机没有请求。
  const now = Date.now();
  const STEPS = [[9 * D, 68.0, false], [8 * D, 66.5, true], [6 * D, 64.0, true], [5 * D, 63.2, false], [4 * D, 113.2, false], [3 * D, 112.4, true], [2 * D, 111.9, true], [26 * H, 111.2, false], [5 * H, 110.9, true], [3 * H, 110.4, true], [40 * 60000, 110.0, true]];
  const samples = STEPS.map(([ago, total]) => ({ at: now - ago, currency: 'CNY', total, granted: 10, toppedUp: total - 10 }));
  const local = [];
  STEPS.forEach(([ago, total, mine], i) => {
    if (!mine) return;
    const drop = STEPS[i - 1][1] - total;
    for (let n = 0; n < 6; n++) local.push({ at: now - ago - 20 * 60000 - (5 - n) * 180000, model: i === 2 ? 'DeepSeek-V4-Pro' : 'DeepSeek-V4.1-Flash', effort: 'high', input: 60000, output: 900, cacheRead: 50000, cacheWrite: 0, tokens: 60900, costUsd: drop / 7.14 / 6, calls: 1, priced: true });
  });
  local.sort((a, b) => a.at - b.at);
  const result = insight.analyzeDeepSeek({ accountId: 'acc', local: true, samples, rows: local, now });
  assert.deepEqual([result.currency, result.balance.total, result.spend.d7, result.spend.d30, result.spend.offMachine7, result.spend.offMachine30], ['CNY', 110, 6.5, 8, 1.5, 1.5]);
  near(result.spend.perDay, 6.5 / 7); near(result.spend.daysLeft, 110 / (6.5 / 7)); near(result.spend.emptyAt, now + 110 / (6.5 / 7) * D, 1000);
  assert.deepEqual([result.rate.basis, result.rate.steps, result.rate.drop], ['measured', 7, 6.5]);
  near(result.rate.perUsd, 7.14, 1e-9);
  assert.deepEqual([result.localUsage.d30.requests, result.localUsage.d30.tokens, result.days.length, result.hourly.length, result.topUps.length, result.topUps[0].amount], [42, 42 * 60900, 30, 24, 1, 50]);
  assert.equal(result.days.filter(day => day.covered).length, 10, '余额记录开始之前的天不算有数据');
  near(result.days.reduce((total, day) => total + day.spent, 0), 8);
  assert.equal(result.days.find(day => day.added > 0).added, 50);
  // 模型换算：两个型号 × 高峰 / 闲时；闲时半价所以能用两倍；Flash 比 Pro 耐用；余额 ÷ 每百万的价 = 能用多少
  assert.deepEqual(result.models.map(m => m.key).sort(), ['DeepSeek-V4-Pro|offpeak', 'DeepSeek-V4-Pro|peak', 'DeepSeek-V4.1-Flash|offpeak', 'DeepSeek-V4.1-Flash|peak']);
  const model = key => result.models.find(m => m.key === key);
  const flashPeak = model('DeepSeek-V4.1-Flash|peak'), flashOff = model('DeepSeek-V4.1-Flash|offpeak'), proPeak = model('DeepSeek-V4-Pro|peak');
  // Flash 高峰：新输入 10,000 × 0.3 + 缓存读 50,000 × 0.006 + 输出 900 × 1.2 = 4,380 美元 / 百万条 → 每 60,900 Token，每百万 Token 0.07192…
  near(flashPeak.usdPerM, (10000 * 0.3 + 50000 * 0.006 + 900 * 1.2) / 60900, 1e-9);
  near(flashOff.usdPerM, flashPeak.usdPerM / 2, 1e-12); near(flashOff.capacityTokens, flashPeak.capacityTokens * 2, 1e-3);
  near(flashPeak.capacityTokens, 110 / (flashPeak.usdPerM * 7.14) * 1e6, 1e-3);
  near(flashPeak.calls, flashPeak.capacityTokens / 60900, 1e-6);
  assert.ok(proPeak.capacityTokens < flashPeak.capacityTokens);
  assert.deepEqual(flashOff.listPrice, { input: 0.15, output: 0.6, cacheRead: 0.003 });
  near(result.current.capacityTokens, 110 / (result.localUsage.d30.costUsd / result.localUsage.d30.tokens * 7.14), 1e-3);
  pass('spend, forecast, local vs off-machine spend, the measured rate and what the balance buys per model add up');

  // 4. 折算率偏离太多（别处也在用同一个账号）不采用，退回参考比例；没有余额记录时都是空的，不编数
  const heavy = insight.analyzeDeepSeek({ accountId: 'acc', local: true, samples, rows: local.map(row => ({ ...row, costUsd: row.costUsd / 5 })), now });
  assert.deepEqual([heavy.rate.basis, heavy.rate.perUsd], ['reference', 7.2]); near(heavy.rate.measured, 35.7, 1e-6);
  const empty = insight.analyzeDeepSeek({ accountId: 'acc', local: true, samples: [], rows: [], now });
  assert.deepEqual([empty.balance, empty.since, empty.spend.perDay, empty.spend.daysLeft, empty.track.length, empty.rate.basis], [null, null, null, null, 0, 'none']);
  // 没指定本机用量的账号：只有余额那一半，本机的数字都是 0，模型按典型用法估
  const other = insight.analyzeDeepSeek({ accountId: 'acc', local: false, samples, rows: local, now });
  assert.deepEqual([other.spend.d7, other.localUsage.d30.requests, other.spend.offMachine30, other.rate.basis, other.models.length, other.models[0].mixBasis], [6.5, 0, 0, 'reference', 4, 'default']);
  assert.ok(other.models.every(m => m.capacityTokens > 0));
  pass('an implausible measured rate falls back to the reference; no history gives blanks; an account without local usage keeps only the balance side');

  // 5. 时间线（worker 入口）：按自然日 / 7 天分段，进行中的那段始终有；曲线是余额，没有官方额度那一套
  for (const sample of samples) insight.appendBalanceSamples('line', sample.at, [sample]);
  const line = insight.queryDeepSeek({ op: 'timeline', accountId: 'line', local: true });
  assert.deepEqual([line.kind, line.labels.five, line.labels.week, line.five.selected.active, line.week.selected.active], ['deepseek', '单日', '7 天', true, true]);
  assert.deepEqual([line.five.selected.endAt - line.five.selected.startAt, line.week.selected.endAt - line.week.selected.startAt], [D, 7 * D]);
  assert.equal(line.five.timeline.every(bin => bin.model === 'DeepSeek-V4.1-Flash' && bin.effort === 'high'), true);
  assert.ok(line.five.totals.tokens > 0 && line.week.track.length >= 2 && line.week.balance.currency === 'CNY' && line.week.balance.min < line.week.balance.max);
  assert.ok(line.week.track.every(point => point.pct >= 0 && point.pct <= 100 && point.value > 0));
  assert.deepEqual([line.week.offMachine.detected.length, line.week.attribution.intervals.length], [0, 0]);
  const older = insight.queryDeepSeek({ op: 'timeline', accountId: 'line', local: false });
  assert.deepEqual([older.five.timeline.length, older.five.cycles.length], [0, 1], '没指定本机用量：时间线上没有请求');
  pass('the timeline is cut by day and by 7 days, carries the balance curve and has no off-machine markup');

  console.log(`${checks}/5 deepseek insight checks passed`);
} catch (error) {
  console.error('FAIL', error.stack || error.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 留给系统清 */ }
}
