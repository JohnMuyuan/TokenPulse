/**
 * 额度详情里「模型速度」的数据（src/core/pass-speed.ts）：某个官方账号各模型的速度走势。
 * 跑法（先 npm run compile）：node scripts/test-pass-speed.cjs
 * 数据目录是临时文件夹，转发记录是造的。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-speed-"));
process.env.TOKENPULSE_DATA_DIR = root;
const { accountSpeed } = require(path.join(__dirname, "..", "build", "core", "pass-speed.js"));
const { routeLogDir } = require(path.join(__dirname, "..", "build", "core", "route-ledger.js"));

const HOUR = 3_600_000, DAY = 86_400_000;
// 固定在一个月中间的中午，免得跨月、跨天的边界让测试时灵时不灵
const now = new Date(2026, 9, 20, 12, 30).getTime();
const monthFile = (at) => path.join(routeLogDir(), `${new Date(at).getFullYear()}-${String(new Date(at).getMonth() + 1).padStart(2, "0")}.jsonl`);
const rows = [];
const add = (at, extra) => rows.push({ at, app: "codex", providerId: "pass-codex", model: "gpt-a", requestModel: "gpt-a", status: 200, ms: 5000, pass: true, firstByteMs: 400, firstTokenMs: 2000, tokensPerSec: 50, output: 300, ...extra });

try {
  // 账号归属：10 天前从账号 one 换成了账号 two
  fs.writeFileSync(path.join(root, "cli-logins.json"), JSON.stringify({ version: 1, kinds: { chatgpt: [{ from: now - 60 * DAY, id: "chatgpt:one", email: "one@example.com", label: "one" }, { from: now - 10 * DAY, id: "chatgpt:two", email: "two@example.com", label: "two" }] } }));
  // 今天：gpt-a 五次（速度 40 50 60 70 200，首字 1 2 3 秒…），gpt-b 一次
  [40, 50, 60, 70, 200].forEach((speed, i) => add(now - i * 60_000 - 1000, { tokensPerSec: speed, firstTokenMs: 1000 * (i + 1) }));
  add(now - 2 * HOUR, { model: "gpt-b", requestModel: "gpt-b", tokensPerSec: 120, firstTokenMs: undefined });
  // 快速模式（Codex 的 priority）：同一个型号也单独算
  add(now - 30 * 60_000, { tier: "priority", tokensPerSec: 180 }); add(now - 31 * 60_000, { tier: "fast", tokensPerSec: 200 }); add(now - 32 * 60_000, { tier: "flex", tokensPerSec: 55 });
  // 3 天前：gpt-a 两次
  add(now - 3 * DAY, { tokensPerSec: 30 }); add(now - 3 * DAY + 1000, { tokensPerSec: 34 });
  // 20 天前（那时登录的是账号 one）：gpt-a 一次；上个月也有一次
  add(now - 20 * DAY, { tokensPerSec: 90 });
  add(now - 40 * DAY, { tokensPerSec: 10 });
  // 0.3.36：号池交给官方账号的请求也量了速度，记录里写着账号——直接归到那个账号，不看当时 CLI 登录的是谁
  add(now - 4 * HOUR, { pass: undefined, provider: "pool · three", account: "chatgpt:three", model: "gpt-pool", requestModel: "gpt-pool", tokensPerSec: 88 });
  add(now - 4 * HOUR + 1000, { pass: undefined, provider: "pool · three", account: "chatgpt:three", model: "gpt-pool", requestModel: "gpt-pool", tokensPerSec: 92 });
  // 不该算进来的：报错的、没量到速度的、不是透明转发的、别的工具的
  add(now - 5000, { status: 500, error: "boom", tokensPerSec: 999 });
  add(now - 5000, { tokensPerSec: undefined });
  add(now - 5000, { pass: undefined, provider: "Relay", tokensPerSec: 999 });
  add(now - 5000, { app: "claude", model: "claude-x", requestModel: "claude-x", tokensPerSec: 77 });
  fs.mkdirSync(routeLogDir(), { recursive: true });
  const byFile = new Map();
  for (const row of rows) { const file = monthFile(row.at); byFile.set(file, [...(byFile.get(file) || []), row]); }
  for (const [file, list] of byFile) fs.writeFileSync(file, list.sort((a, b) => a.at - b.at).map((row) => JSON.stringify(row)).join("\n") + "\n");

  // 账号 two、最近 7 天：按天分桶
  const week = accountSpeed("chatgpt", "chatgpt:two", 7, now);
  assert.deepEqual([week.bucketMs, week.total, week.models.map((model) => model.model)], [DAY, 11, ["gpt-a", "gpt-a", "gpt-b"]], "按请求次数排，只有这个账号、这段时间、量到了速度的");
  assert.deepEqual(week.models.map((model) => [model.fast, model.count, model.tokensPerSec]), [[false, 8, 52.5], [true, 2, 190], [false, 1, 120]], "快速模式的请求单独一行，不把普通模式的数字带高");
  const a = week.models[0];
  assert.deepEqual([a.count, a.tokensPerSec], [8, 52.5]);
  assert.deepEqual([a.low, a.high, a.firstTokenMs, a.output], [38.5, 62.5, 2000, 2400], "中位数和四分位：个别特别快的不把数字带偏");
  assert.deepEqual(a.buckets.map((bucket) => [new Date(bucket.at).getDate(), bucket.median, bucket.count]), [[17, 32, 2], [20, 57.5, 6]], "一天一个点，取那天的中位数");
  assert.deepEqual([a.buckets[1].low, a.buckets[1].high], [51.3, 67.5]);
  assert.deepEqual([week.models[2].count, week.models[2].tokensPerSec, week.models[2].firstTokenMs], [1, 120, 400], "没有首字延迟时用第一个字节的");
  assert.equal(week.max, 195, "对比条的刻度取所有模型里最高的");
  assert.equal(new Date(week.from).getHours(), 0, "时间轴从整天开始");

  // 最近 24 小时：按小时分桶
  const dayView = accountSpeed("chatgpt", "chatgpt:two", 1, now);
  assert.deepEqual([dayView.bucketMs, dayView.models[0].buckets.length, dayView.models[0].buckets[0].count, dayView.models[1].buckets.length], [HOUR, 2, 1, 2]);
  // 账号 one：只有 20 天前和 40 天前那两次；全部 = 从最早那次算起，超过三个月才按周
  const one = accountSpeed("chatgpt", "chatgpt:one", 0, now);
  assert.deepEqual([one.total, one.bucketMs, one.models[0].buckets.map((bucket) => bucket.median)], [2, DAY, [10, 90]], "换账号之前的归到当时登录的那个账号");
  assert.deepEqual(accountSpeed("chatgpt", "chatgpt:one", 30, now).models[0].buckets.map((bucket) => bucket.median), [90]);
  // 号池成员：按记录里的账号归属；别的账号看不到它
  assert.deepEqual(accountSpeed("chatgpt", "chatgpt:three", 7, now).models.map((model) => [model.model, model.count, model.tokensPerSec]), [["gpt-pool", 2, 90]]);
  assert.equal(week.models.some((model) => model.model === "gpt-pool"), false);
  // 不分账号 = 这一家全部（经本地路由转给第三方供应商的不是官方账号的，不算）；别的家互不相干
  assert.equal(accountSpeed("chatgpt", "", 0, now).total, 15);
  assert.deepEqual(accountSpeed("claude", "", 7, now).models.map((model) => [model.model, model.tokensPerSec]), [["claude-x", 77]]);
  assert.deepEqual(accountSpeed("grok", "", 7, now).models, []);
  // 很久以前的记录也在：一年的跨度按周看
  fs.appendFileSync(monthFile(now - 300 * DAY), JSON.stringify({ at: now - 300 * DAY, app: "codex", pass: true, status: 200, requestModel: "gpt-a", tokensPerSec: 20 }) + "\n");
  const all = accountSpeed("chatgpt", "", 0, now);
  assert.deepEqual([all.bucketMs, all.total, new Date(all.models[0].buckets[0].at).getDay()], [7 * DAY, 16, 1], "一周一个点，从周一开始");
  // 供应商页的汇总：透明转发和本地路由的都在，同一个型号经不同的供应商分开
  const { passSpeed } = require(path.join(__dirname, "..", "build", "core", "route-ledger.js"));
  const real = Date.now;
  Date.now = () => now;
  try {
    const summary = passSpeed(7).filter((row) => row.app === "codex");
    assert.deepEqual(summary.map((row) => [row.model, row.fast, row.via, row.count]), [["gpt-a", false, "", 8], ["gpt-a", true, "", 2], ["gpt-pool", false, "pool · three", 2], ["gpt-a", false, "Relay", 1], ["gpt-b", false, "", 1]]);
    // 0.3.39：0 = 全部（记录永久保存，300 天前那条也算进来）；思考等级分开一行，四分位
    const plainA = (days) => passSpeed(days).filter((row) => row.app === "codex" && row.model === "gpt-a" && !row.fast && !row.via).reduce((sum, row) => sum + row.count, 0);
    assert.ok(plainA(0) > plainA(7) && plainA(7) === 8, `全部比最近 7 天多（含 300 天前那条）：${plainA(0)} / ${plainA(7)}`);
    fs.appendFileSync(monthFile(now - 1000), [[30, 3000], [32, 3400], [34, 3800]].map(([speed, first], i) => JSON.stringify({ at: now - 1000 - i, app: "codex", pass: true, status: 200, requestModel: "gpt-e", effort: "high", tokensPerSec: speed, firstTokenMs: first, output: 300 })).join("\n") + "\n"
      + JSON.stringify({ at: now - 900, app: "codex", pass: true, status: 200, requestModel: "gpt-e", effort: "low", tokensPerSec: 33, firstTokenMs: 900, output: 300 }) + "\n");
    const efforts = passSpeed(7).filter((row) => row.model === "gpt-e").map((row) => [row.effort, row.count, row.tokensPerSec, row.low, row.high, row.firstTokenMs]);
    assert.deepEqual(efforts, [["high", 3, 32, 31, 33, 3400], ["low", 1, 33, 33, 33, 900]], "同一个型号不同思考等级分开：速度差不多，首字差很多");
    // 用量明细的折线图（0.3.39）：一条线 = 工具 + 型号 + 快速 + 思考等级 + 经由，按时间分桶取中位数；0 = 全部
    const { speedSeries } = require(path.join(__dirname, "..", "build", "core", "pass-speed.js"));
    const week = speedSeries(7, now);
    assert.equal(week.bucketMs, DAY, "7 天按天");
    const lineE = week.lines.filter((line) => line.model === "gpt-e").map((line) => [line.effort, line.count, line.tokensPerSec, line.firstTokenMs, line.buckets.length, line.buckets.at(-1).tokensPerSec]);
    assert.deepEqual(lineE, [["high", 3, 32, 3400, 1, 32], ["low", 1, 33, 900, 1, 33]]);
    assert.ok(week.lines.some((line) => line.model === "gpt-a" && line.fast) && week.lines.some((line) => line.via === "Relay"), "快速模式和第三方供应商各自一条线");
    const ever = speedSeries(0, now);
    assert.deepEqual([ever.bucketMs, ever.total > week.total], [7 * DAY, true], "全部：跨度长就按周，300 天前的也在");
    assert.deepEqual(speedSeries(7, now - 400 * DAY).lines, [], "那时还没有记录");
  } finally { Date.now = real; }
  console.log("PASS pass speed: per-account, per-model speed trend from the permanent forwarding log (median and quartiles per hour / day / week, attributed by the CLI login at the time)");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
