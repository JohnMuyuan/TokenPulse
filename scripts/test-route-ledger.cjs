/**
 * 路由账本（src/core/route-ledger.ts）：号池把请求交给了哪个官方账号，统计用量时按时间对上。
 * 跑法（先 npm run compile）：node scripts/test-route-ledger.cjs
 * 用一次性的 HOME 和数据目录，不碰用户真实的 ~/.grok 和 ~/.tokenpulse。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-route-ledger-"));
process.env.HOME = process.env.USERPROFILE = path.join(root, "home");
process.env.TOKENPULSE_DATA_DIR = path.join(root, "data");
for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME"]) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
const build = path.join(__dirname, "..", "build", "core");
const ledger = require(path.join(build, "route-ledger.js"));
const { scanLocalUsage, readRollups } = require(path.join(build, "usage-scan.js"));
const { queryRequests } = require(path.join(build, "request-log.js"));
const write = (file, rows) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n"); };

try {
  const base = Date.UTC(2026, 9, 6, 2, 0);
  /* ---------------- 账本本身 ---------------- */
  ledger.appendRoute({ at: base + 600_400, kind: "grok", account: "grok:acc-a", responseId: 'resp_grok_a' });
  ledger.appendRoute({ at: base + 900_000, kind: "grok", account: "grok:acc-b", responseId: 'resp_grok_b' });
  ledger.appendRoute({ at: base + 900_000, kind: "claude", account: "claude:acc-c", responseId: 'msg_claude_c' });
  ledger.appendRoute({ at: base, kind: "grok", account: "claude:wrong-kind" }); // 账号不是这一家的：不记
  ledger.appendRoute({ at: base, kind: "grok", account: "" });
  assert.equal(fs.readFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, "route-ledger.jsonl"), "utf8").trim().split("\n").length, 3);
  assert.equal(ledger.routeAccount("grok", base + 600_000, 'resp_grok_a'), "grok:acc-a", "响应 ID 一致才对上");
  assert.equal(ledger.routeAccount("grok", base + 629_000), null, "没有共同 ID 不猜");
  assert.equal(ledger.routeAccount("grok", base + 660_000, 'missing'), null, "不同 ID 不匹配");
  assert.equal(ledger.routeAccount("grok", base + 890_000, 'resp_grok_b'), "grok:acc-b");
  assert.equal(ledger.routeAccount("claude", base + 900_000, 'msg_claude_c'), "claude:acc-c"); assert.equal(ledger.routeAccount("chatgpt", base + 900_000, 'msg_claude_c'), null, "各家分开");
  assert.equal(ledger.routeAccount(undefined, base), null);
  console.log("PASS route ledger: exact response identity, per vendor, unidentified and unrelated entries ignored");

  /* ---------------- 用量和请求记录 ---------------- */
  // Claude 与 Codex 会话记录响应 ID；Grok 只有整轮汇总，不能用它测试精确匹配的成功路径。
  write(path.join(process.env.HOME, '.claude', 'settings.json'), []);
  fs.writeFileSync(path.join(process.env.HOME, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:17621/claude', ANTHROPIC_AUTH_TOKEN: 'PROXY_MANAGED' } }));
  ledger.appendRoute({ at: base + 600_400, kind: 'claude', account: 'claude:acc-a', responseId: 'msg_pool_first' });
  const session = path.join(process.env.HOME, '.claude', 'projects', 'qa');
  const turn = (seconds, id) => ({ type: 'assistant', timestamp: new Date(base + seconds * 1000).toISOString(), requestId: 'req_' + id, message: { id, model: 'claude-qa', usage: { input_tokens: 1000, output_tokens: 100 } } });
  write(path.join(session, 'session.jsonl'), [turn(600, 'msg_pool_first'), turn(1800, 'msg_not_pooled')]);
  const scan = scanLocalUsage();
  assert.equal(scan.records.length, 2);
  const rows = queryRequests({ from: "2026-01-01", to: "2026-12-31", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 50, all: true }).rows.sort((a, b) => a.at - b.at);
  assert.deepEqual(rows.map((row) => [row.official, row.account?.id ?? null, row.account?.basis ?? null]), [[true, "claude:acc-a", "route"], [false, null, null]], "经号池发的那条归到号池成员名下、算官方用量；没经号池的那条还是中转");
  const only = (query) => queryRequests({ from: "2026-01-01", to: "2026-12-31", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 50, all: true, ...query }).rows.length;
  assert.deepEqual([only({ channel: "official" }), only({ channel: "api" }), only({ account: "claude:acc-a" })], [1, 1, 1], "筛选跟着走");
  // 按账号的小时账（额度折算、本机以外的判断用的）：只有经号池的那条
  const state = Object.values(readRollups().files).find((item) => item.kind === "claude-code");
  assert.equal(state.official, false, "文件整体仍然记成不是官方（配置里是本地路由）");
  assert.deepEqual(Object.keys(state.accountHours || {}), ["claude:acc-a"]);
  const hours = Object.values(state.accountHours["claude:acc-a"]);
  assert.equal(hours.length, 1); assert.equal(Object.values(hours[0])[0].input, 1000);
  console.log("PASS route ledger: pool traffic counted as official under the member account in request rows, filters and per-account hours; other traffic untouched");

  // 账本只留 45 天；对上的账号扫描时已经记进请求流水，账本没了也还知道
  fs.rmSync(path.join(process.env.TOKENPULSE_DATA_DIR, "route-ledger.jsonl"));
  ledger.resetRouteLedgerCache();
  assert.equal(ledger.routeAccount("grok", base + 600_000), null);
  const later = queryRequests({ from: "2026-01-01", to: "2026-12-31", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 50, all: true }).rows.sort((a, b) => a.at - b.at);
  assert.deepEqual(later.map((row) => [row.official, row.account?.id ?? null, row.account?.basis ?? null]), [[true, "claude:acc-a", "route"], [false, null, null]]);
  console.log("PASS route ledger: the matched account is stored with the request record, so it survives the ledger being pruned");

  /* ---------------- 永久保存的转发记录 ---------------- */
  ledger.appendRouteLog({ at: new Date(2026, 9, 6, 12).getTime(), app: "grok", provider: "pool · a", status: 200, ms: 1200, account: "grok:acc-a" });
  ledger.appendRouteLog({ at: new Date(2026, 9, 31, 23, 59).getTime(), app: "grok", provider: "pool · b", status: 502, ms: 30, error: "boom" });
  ledger.appendRouteLog({ at: new Date(2026, 10, 1, 0, 1).getTime(), app: "codex", provider: "relay", status: 200, ms: 5 });
  assert.deepEqual(fs.readdirSync(ledger.routeLogDir()).sort(), ["2026-10.jsonl", "2026-11.jsonl"], "按月一个文件（本地时间）");
  const october = fs.readFileSync(path.join(ledger.routeLogDir(), "2026-10.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(october.map((row) => [row.app, row.status, row.account ?? null, row.error ?? null]), [["grok", 200, "grok:acc-a", null], ["grok", 502, null, "boom"]], "一行一条，追加，不清理");
  // 往回翻：新的在前，按页读，跨月份文件接着读
  const first = ledger.readRouteLog({ limit: 2 });
  assert.deepEqual([first.rows.map((row) => row.provider), first.more], [["relay", "pool · b"], true]);
  const second = ledger.readRouteLog({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual([second.rows.map((row) => row.provider), second.more], [["pool · a"], false]);
  assert.deepEqual(ledger.readRouteLog({ limit: 10, before: 1 }), { rows: [], more: false, nextCursor: null });
  console.log("PASS route log: every forwarded request appended to a monthly file, kept for good, and read back newest first in pages");

  /* ---------------- 查得多也不反复看文件（0.3.38） ---------------- */
  // 统计时每条请求都来查一次：以前每次都 stat 好几个文件，几万条请求要两三秒，打开软件时干等
  const realStat = fs.statSync;
  let stats = 0;
  fs.statSync = (...args) => { stats++; return realStat(...args); };
  try {
    ledger.resetRouteLedgerCache();
    for (let i = 0; i < 5000; i++) { ledger.routeReturned("resp_missing_" + i, base); ledger.routeAccount("chatgpt", base, "resp_missing_" + i); }
  } finally { fs.statSync = realStat; }
  assert.ok(stats <= 12, `5000 次查询只看了 ${stats} 次文件`);
  // 本进程写了转发记录，马上就能查到，不用等
  ledger.appendRouteLog({ at: base + 1000, app: "codex", provider: "relay", status: 200, ms: 5, responseId: "resp_fresh_1", returnedModel: "gpt-fresh" });
  assert.equal(ledger.routeReturned("resp_fresh_1", base + 1000)?.returned, "gpt-fresh");
  console.log("PASS ledger lookups: files are checked at most once a second, and own writes are visible at once");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
