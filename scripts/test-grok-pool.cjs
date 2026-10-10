/*
 * Grok 号池的用量归到成员名下（0.3.42，src/core/usage-scan.ts、route-ledger.ts 的 routeShares、report.ts）。
 * 起因：Grok 的会话文件一整轮汇总成一条，没有响应 ID，对不上单次请求，号池成员名下一直没有用量。
 * 现在按这一轮的时间范围查转发记录，按号池交给各账号的 Token 数分摊。
 * 覆盖：routeShares 的时间范围 / 透明转发和没有用量的不算 / 第三方供应商记在空名下；
 * 一轮交给两个账号按比例拆、总量不变；一轮只交给一个账号时这条请求标上账号；没有转发记录的不归属；
 * 文件整体「不是官方」时这部分仍进账号的小时账（routedHours）。
 * 用一次性的 HOME 和数据目录，不碰真实的 ~/.grok 和 ~/.tokenpulse。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-grok-pool-'));
process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
const build = path.join(__dirname, '..', 'build', 'core');
const ledger = require(path.join(build, 'route-ledger.js'));
const { scanLocalUsage, readRollups } = require(path.join(build, 'usage-scan.js'));
const { queryRequests } = require(path.join(build, 'request-log.js'));

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const base = Date.now() - 3 * 3600_000;
const sec = n => base + n * 1000;
const forward = (at, account, input, output, extra = {}) => ledger.appendRouteLog({ at, app: 'grok', provider: account ? 'pool · ' + account : 'QA Relay', status: 200, ms: 900, input, output, ...(account ? { account } : {}), ...extra });
const userMessage = at => ({ timestamp: at / 1000, params: { update: { sessionUpdate: 'user_message_chunk', _meta: { modelId: 'grok-qa' }, content: { type: 'text', text: 'hi' } } } });
const turnDone = (at, prompt, input, output) => ({ timestamp: at / 1000, params: { update: { sessionUpdate: 'turn_completed', prompt_id: prompt, usage: { modelUsage: { 'grok-qa': { inputTokens: input, outputTokens: output, cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, costUsdTicks: 4e8, modelCalls: 4 } } } } } });

try {
  // 用号池时 Grok 的配置里是本地路由的地址：文件整体记成「不是官方」
  fs.mkdirSync(path.join(process.env.HOME, '.grok'), { recursive: true });
  fs.writeFileSync(path.join(process.env.HOME, '.grok', 'config.toml'), '[model.tokenpulse_route]\nbase_url = "http://127.0.0.1:17621/grok/v1"\n');

  // 第一轮（10s–70s）：号池交给 A 3000 Token、B 1000 Token；另有不该算的几条
  forward(sec(5), 'grok:acc-b', 9000, 0);                              // 这一轮开始之前
  forward(sec(20), 'grok:acc-a', 2000, 400);
  forward(sec(30), 'grok:acc-a', 500, 100);
  forward(sec(50), 'grok:acc-b', 900, 100);
  forward(sec(40), 'grok:acc-a', 7000, 0, { pass: true });             // 透明转发：不是号池
  forward(sec(45), 'grok:acc-a', 0, 0);                                // 没读到用量（/models 之类）
  ledger.appendRouteLog({ at: sec(46), app: 'grok', provider: 'x', status: 502, ms: 5, input: 5000, output: 0, account: 'grok:acc-b', error: 'boom' });
  ledger.appendRouteLog({ at: sec(47), app: 'codex', provider: 'x', status: 200, ms: 5, input: 5000, output: 0, account: 'chatgpt:other' });
  // 第二轮（100s–160s）：只交给 A
  forward(sec(120), 'grok:acc-a', 800, 200);
  // 第三轮（200s–260s）：A 和第三方供应商各一半
  forward(sec(220), 'grok:acc-a', 500, 0);
  forward(sec(230), '', 500, 0);
  // 第四轮（400s–460s）：没有任何转发记录

  ledger.resetRouteLedgerCache();
  assert.deepEqual([...ledger.routeShares('grok', sec(10), sec(70))].sort(), [['grok:acc-a', 3000], ['grok:acc-b', 1000]]);
  assert.deepEqual([...ledger.routeShares('grok', sec(200), sec(260))].sort(), [['', 500], ['grok:acc-a', 500]]);
  assert.equal(ledger.routeShares('grok', sec(400), sec(460)).size, 0);
  assert.equal(ledger.routeShares('chatgpt', sec(10), sec(70)).get('chatgpt:other'), 5000, '各家分开');
  pass('routeShares: tokens per pool account inside the window; pass-through, failures, no-usage rows and other tools excluded; third-party forwards under the empty key');

  const session = path.join(process.env.HOME, '.grok', 'sessions', 'D%3A%5Cqa', 'session-1', 'updates.jsonl');
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, [
    userMessage(sec(10)), turnDone(sec(70), 'p1', 4000, 400),
    userMessage(sec(100)), turnDone(sec(160), 'p2', 1000, 200),
    userMessage(sec(200)), turnDone(sec(260), 'p3', 2000, 0),
    userMessage(sec(400)), turnDone(sec(460), 'p4', 600, 60),
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const scan = scanLocalUsage();
  assert.equal(scan.records.length, 4);
  const state = Object.values(readRollups().files).find(file => file.kind === 'grok-build');
  assert.equal(state.official, false, '文件整体仍然不是官方');
  const sum = account => Object.values(state.routedHours?.[account] ?? {}).flatMap(models => Object.values(models)).reduce((total, bucket) => ({ input: total.input + bucket.input, output: total.output + bucket.output, requests: total.requests + bucket.requests, cost: total.cost + bucket.costUsd }), { input: 0, output: 0, requests: 0, cost: 0 });
  const a = sum('grok:acc-a'), b = sum('grok:acc-b');
  // 第一轮 4000/400 按 3:1 拆；第二轮 1000/200 全给 A；第三轮 2000/0 一半给 A，另一半（第三方供应商）不归任何账号
  assert.deepEqual([a.input, a.output, b.input, b.output], [3000 + 1000 + 1000, 300 + 200 + 0, 1000, 100]);
  assert.ok(Math.abs(a.cost + b.cost - (0.4 + 0.4 + 0.2)) < 1e-9, '费用按同样的比例拆');
  assert.deepEqual(Object.keys(state.routedHours).sort(), ['grok:acc-a', 'grok:acc-b'], '第三方供应商那一份和没有转发记录的那一轮不进任何账号');
  // 总量没有变：按天的账还是四轮加起来
  const day = Object.values(state.days).flatMap(sources => Object.values(sources)).flatMap(models => Object.values(models)).reduce((total, bucket) => total + bucket.input, 0);
  assert.equal(day, 4000 + 1000 + 2000 + 600);
  pass('a turn handed to two pool accounts is split by their token share, a third-party share stays unattributed, totals unchanged');

  const rows = queryRequests({ from: '2000-01-01', to: '2999-01-01', source: 'all', status: 'all', search: '', sort: 'time', page: 0, pageSize: 20 }).rows.sort((x, y) => x.at - y.at);
  assert.deepEqual(rows.map(row => [row.account?.id ?? null, row.account?.basis ?? null, row.official]), [
    [null, null, false],                              // 两个账号各占一部分：这一条不标单个账号
    ['grok:acc-a', 'route-window', true],             // 全部交给 A
    [null, null, false],                              // A 和第三方各一半
    [null, null, false],                              // 没有转发记录
  ]);
  pass('request rows: a turn served entirely by one pool account is shown under it; mixed or unknown turns are not guessed');

  // 再扫一遍不重复计算
  scanLocalUsage();
  const again = Object.values(readRollups().files).find(file => file.kind === 'grok-build');
  assert.deepEqual(again.routedHours, state.routedHours);
  pass('rescanning does not double count');

  console.log(`${checks}/${checks} grok pool checks passed`);
} catch (error) {
  console.error('FAIL', error);
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
