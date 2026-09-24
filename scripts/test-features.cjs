/**
 * 0.3.2 的几块新功能。跑法（先 npm run compile）：
 *
 *   node scripts/test-features.cjs
 *
 * 用一次性的 HOME 和数据目录：CC Switch 的库是这里用 node:sqlite 现建的（表结构照着本机 cc-switch.db 抄），
 * 不碰用户真实的 ~/.cc-switch 和 ~/.tokenpulse。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-features-"));
process.env.HOME = process.env.USERPROFILE = path.join(root, "home");
process.env.TOKENPULSE_DATA_DIR = path.join(root, "data");
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
const build = path.join(__dirname, "..", "build", "core");
const knowledge = require(path.join(build, "knowledge.js"));
const pricing = require(path.join(build, "model-pricing.js"));
const verify = require(path.join(build, "request-verify.js"));

const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

try {
  /* ---------------- 模型知识库 ---------------- */
  const bundled = knowledge.loadKnowledge();
  check("内置知识库能读到并通过校验", bundled.source === "bundled" && bundled.knowledge.prices.length > 10, bundled.knowledge.version);
  check("单价从知识库来：Claude Opus / GPT-5.6 / 免费模型", pricing.priceOf("claude-opus-5")?.input === 5 && pricing.priceOf("gpt-5.6-sol")?.output === 30 && pricing.priceOf("nemotron-3-ultra-free")?.input === 0);
  check("认不出的型号不编价格", pricing.priceOf("totally-new-model") === null);
  check("型号等价规则从知识库来", verify.normalizeModel("claude-opus-5[1m]") === "claude-opus-5" && verify.normalizeModel("grok-4.6-build") === "grok-4.6");
  check("版本比较", knowledge.compareVersions("2026.10.01", "2026.09.24") > 0 && knowledge.compareVersions("2026.09.24.1", "2026.09.24") > 0 && knowledge.compareVersions("2026.09.24", "2026.09.24") === 0);
  check("格式不对的知识库拒收", knowledge.parseKnowledge({ schema: 2, version: "2026.09.30", prices: [] }) === null && knowledge.parseKnowledge({ schema: 1, version: "latest", prices: [] }) === null);
  const cleaned = knowledge.parseKnowledge({
    schema: 1, version: "2026.12.01", updatedAt: "2026-12-01",
    prices: [
      { match: "(unclosed", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      { match: "negative", input: -1, output: 1, cacheRead: 0, cacheWrite: 0 },
      { match: "x".repeat(500), input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      { match: "brand-new-model", input: 7, output: 21, cacheRead: 0.7, cacheWrite: 0, note: "新型号" },
    ],
    aliases: [{ match: "-preview$", replace: "", note: "预览版" }, { match: "(bad", replace: "" }],
  });
  check("下载来的规则：编不过的正则、负数、超长的都丢掉", cleaned?.prices.length === 1 && cleaned.aliases.length === 1, JSON.stringify(cleaned?.prices.map((p) => p.match)));
  const older = knowledge.acceptKnowledge({ ...cleaned, version: "2020.01.01" });
  check("比当前旧的版本不覆盖", older.updated === false && pricing.priceOf("brand-new-model") === null);
  const newer = knowledge.acceptKnowledge(cleaned);
  check("更新的版本存下来、立刻生效", newer.updated && newer.info.source === "downloaded" && pricing.priceOf("brand-new-model")?.input === 7 && fs.existsSync(knowledge.downloadedKnowledgeFile()));
  check("新的等价规则也生效", verify.normalizeModel("gpt-7-preview") === "gpt-7");
  fs.rmSync(knowledge.downloadedKnowledgeFile());
  knowledge.resetKnowledgeCache();
  check("删掉下载的就回到内置", knowledge.loadKnowledge().source === "bundled" && pricing.priceOf("brand-new-model") === null);

  /* ---------------- CC Switch 导入 ---------------- */
  const { DatabaseSync } = require("node:sqlite");
  const ccDir = path.join(process.env.HOME, ".cc-switch");
  fs.mkdirSync(ccDir, { recursive: true });
  const db = new DatabaseSync(path.join(ccDir, "cc-switch.db"));
  db.exec(`CREATE TABLE usage_daily_rollups ( date TEXT NOT NULL, app_type TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, request_model TEXT NOT NULL DEFAULT '', pricing_model TEXT NOT NULL DEFAULT '', request_count INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0, total_cost_usd TEXT NOT NULL DEFAULT '0', avg_latency_ms INTEGER NOT NULL DEFAULT 0, input_token_semantics INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (date, app_type, provider_id, model, request_model, pricing_model) );
    CREATE TABLE proxy_request_logs ( request_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, app_type TEXT NOT NULL, model TEXT NOT NULL, request_model TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0, input_cost_usd TEXT NOT NULL DEFAULT '0', output_cost_usd TEXT NOT NULL DEFAULT '0', cache_read_cost_usd TEXT NOT NULL DEFAULT '0', cache_creation_cost_usd TEXT NOT NULL DEFAULT '0', total_cost_usd TEXT NOT NULL DEFAULT '0', latency_ms INTEGER NOT NULL, first_token_ms INTEGER, duration_ms INTEGER, status_code INTEGER NOT NULL, error_message TEXT, session_id TEXT, provider_type TEXT, is_streaming INTEGER NOT NULL DEFAULT 0, cost_multiplier TEXT NOT NULL DEFAULT '1.0', created_at INTEGER NOT NULL, data_source TEXT NOT NULL DEFAULT 'proxy', pricing_model TEXT, input_token_semantics INTEGER NOT NULL DEFAULT 0);`);
  const rollup = db.prepare("INSERT INTO usage_daily_rollups (date, app_type, provider_id, model, request_count, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?)");
  rollup.run("2026-06-10", "codex", "_codex_session", "gpt-5.5", 100, 1000, 200, 9000, 0, "3.5"); // TokenPulse 没有这天 → 补
  rollup.run("2026-09-20", "codex", "_codex_session", "gpt-6-astra", 50, 500, 50, 400, 0, "1.0"); // TokenPulse 有这天 → 跳过
  rollup.run("2026-06-11", "opencode", "_opencode_session", "big-pickle", 7, 70, 7, 0, 0, "0"); // 不扫的工具 → 补
  const log = db.prepare("INSERT INTO proxy_request_logs (request_id, provider_id, app_type, model, request_model, input_tokens, output_tokens, cache_read_tokens, latency_ms, status_code, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  // 中午 12 点（UTC）：不管机器在哪个时区，本地日期都是 9 月 20 日
  const at = Date.UTC(2026, 8, 20, 12, 2) / 1000; // 和下面 Codex 会话里那次请求同一时刻
  log.run("proxy-1", "8c5c0000-uuid", "codex", "gpt-5.4-mini", "gpt-6-astra", 60, 10, 40, 900, 200, at + 30); // 代理看到上游回了别的型号
  log.run("proxy-2", "8c5c0000-uuid", "opencode", "big-pickle", "big-pickle", 10, 3, 0, 500, 200, Date.UTC(2026, 5, 12, 12) / 1000); // 汇总表没有的一天
  log.run("proxy-3", "8c5c0000-uuid", "opencode", "x", "x", 1, 1, 0, 500, 502, Date.UTC(2026, 5, 11, 13) / 1000); // 失败的不算
  db.close();

  // TokenPulse 自己有 2026-09-20 的 Codex
  const codexFile = path.join(process.env.HOME, ".codex", "sessions", "2026", "09", "20", "rollout-2026-09-20T10-00-00-abc.jsonl");
  fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  const iso = (sec) => new Date(sec * 1000).toISOString();
  fs.writeFileSync(codexFile, [
    { timestamp: iso(at - 60), type: "session_meta", payload: { model_provider: "openai", cwd: "D:\\work" } },
    { timestamp: iso(at - 30), type: "turn_context", payload: { model: "gpt-6-astra" } },
    { timestamp: iso(at), type: "token_usage_record", payload: { response_id: "resp_" + "c".repeat(50), usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 40 } } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  require(path.join(build, "usage-scan.js")).scanLocalUsage();
  const cc = require(path.join(build, "cc-switch.js"));
  const store = cc.syncCcSwitch(true);
  check("只读打开 CC Switch 的库，读到汇总和逐条记录", store.found && store.days.length === 3 && store.requests.length === 3, `${store.days.length} / ${store.requests.length}`);
  check("CC Switch 的输入不含缓存，导入时补齐到 TokenPulse 的口径", store.days.find((row) => row.day === "2026-06-10").input === 10000);
  const snapshot = require(path.join(build, "report.js")).buildSnapshot(Date.UTC(2026, 8, 21));
  const junCodex = snapshot.usage.find((row) => row.day === "2026-06-10" && row.source === "Codex CLI");
  const sepCodex = snapshot.usage.filter((row) => row.day === "2026-09-20" && row.source === "Codex CLI");
  check("TokenPulse 没有的天：补进统计（费用用 CC Switch 自己算的）", junCodex?.requests === 100 && junCodex.costUsd === 3.5);
  check("TokenPulse 自己有账的天：不重复计", sepCodex.length === 1 && sepCodex[0].requests === 1, JSON.stringify(sepCodex.map((r) => [r.model, r.requests])));
  check("不扫的工具（OpenCode）也补进来，失败的请求不算", snapshot.sources.some((s) => s.source === "OpenCode" && s.requests === 8));
  check("导入状态照实给界面", snapshot.ccSwitch.found && snapshot.ccSwitch.importedDays === 3 && snapshot.ccSwitch.skippedDays === 1 && snapshot.ccSwitch.proxyRequests === 2, JSON.stringify(snapshot.ccSwitch));
  const { queryRequests } = require(path.join(build, "request-log.js"));
  const rows = queryRequests({ from: "2026-01-01", to: "2026-12-31", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 50, all: true }).rows;
  const codexRow = rows.find((row) => row.source === "Codex CLI" && row.responseId);
  check("Codex 请求配上代理记录：返回型号补上了，对不上就标不一致（sub2api 的做法）", codexRow?.returned === "gpt-5.4-mini" && codexRow.status === "mismatch", codexRow?.reasons[0]);
  check("代理记录配过的不再单独占一行", !rows.some((row) => row.requestId === "proxy-1"));
  check("CC Switch 独有的请求单独成行", rows.some((row) => row.source === "OpenCode" && row.requestId === "proxy-2" && row.status === "match"));
  fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, "prefs.json"), JSON.stringify({ ccSwitch: false }));
  const off = require(path.join(build, "report.js")).buildSnapshot(Date.UTC(2026, 8, 21));
  check("设置里关掉导入：统计里就没有 CC Switch 的记录", !off.usage.some((row) => row.day === "2026-06-10") && off.ccSwitch.enabled === false);

  /* ---------------- 请求是哪个账号发的 ---------------- */
  fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, "prefs.json"), JSON.stringify({ ccSwitch: true }));
  const login = require(path.join(build, "login-timeline.js"));
  const fakeCli = (who) => (kind) => (kind === "chatgpt" && who ? [{ kind, ref: who, email: `${who}@example.com`, label: `${who}@example.com`, credential: { token: "secret-token" } }] : []);
  const t0 = Date.UTC(2026, 8, 20, 11, 0);
  login.recordCliLogins(t0, fakeCli("alice"));
  login.recordCliLogins(t0 + 60_000, fakeCli("alice")); // 没变不加段
  login.recordCliLogins(Date.UTC(2026, 8, 20, 13, 0), fakeCli("bob")); // 换号
  const timeline = login.readLoginTimeline();
  const raw = fs.readFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, "cli-logins.json"), "utf8");
  check("登录时间线：换号才开新段，不记任何凭据", timeline.kinds.chatgpt.length === 2 && !raw.includes("secret-token") && !/token/i.test(raw));
  const labels = login.accountLabels();
  const hourAt = (h) => Date.UTC(2026, 8, 20, h, 30);
  check("按时间对上当时登录的账号", login.resolveAccount("chatgpt", hourAt(12), {}, timeline, labels)?.id === "chatgpt:alice" && login.resolveAccount("chatgpt", hourAt(13), {}, timeline, labels)?.id === "chatgpt:bob");
  check("时间线开始之前的请求：按最早的账号推断，并标出来", login.resolveAccount("chatgpt", hourAt(8), {}, timeline, labels)?.basis === "inferred");
  check("会话里直接记了账号的以它为准", login.resolveAccount("claude", hourAt(12), { ref: "uuid-1" }, timeline, labels)?.id === "claude:uuid-1" && login.resolveAccount("chatgpt", hourAt(12), { email: "BOB@example.com" }, timeline, labels)?.id === "chatgpt:bob");
  login.recordCliLogins(Date.UTC(2026, 8, 20, 15, 0), fakeCli(null)); // 登出
  check("登出之后的请求不算到上一个账号头上", login.resolveAccount("chatgpt", hourAt(15), {}, login.readLoginTimeline(), labels) === null);
  // 本机 Codex 是 ChatGPT 登录（假凭据），它的会话才算官方账号发的；归属每轮扫描都重判
  fs.writeFileSync(path.join(process.env.HOME, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "test-only" } }));
  require(path.join(build, "usage-scan.js")).scanLocalUsage();
  const byAccount = queryRequests({ from: "2026-01-01", to: "2026-12-31", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 50, all: true });
  const codexAccount = byAccount.rows.find((row) => row.source === "Codex CLI" && row.responseId)?.account;
  check("请求记录里带上账号（Codex 那次请求在 alice 登录期间）", codexAccount?.id === "chatgpt:alice" && codexAccount.label === "alice@example.com", JSON.stringify(codexAccount));
  check("按账号汇总", byAccount.accounts.some((item) => item.id === "chatgpt:alice" && item.requests === 1));
  const onlyBob = queryRequests({ from: "2026-01-01", to: "2026-12-31", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 50, account: "chatgpt:bob" });
  check("按账号筛选（汇总不受筛选影响）", onlyBob.total === 0 && onlyBob.accounts.length === byAccount.accounts.length);
  const windowed = queryRequests({ from: "2026-01-01", to: "2026-12-31", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 50, since: Date.UTC(2026, 8, 20, 12, 3) });
  check("按窗口开始时间精确筛选", !windowed.rows.some((row) => row.at < Date.UTC(2026, 8, 20, 12, 3)));

  /* ---------------- 英文界面词典 ---------------- */
  const { translate, EN, PATTERNS } = require(path.join(__dirname, "..", "renderer", "i18n.js"));
  const samples = {
    "5 天 3 小时后重置": "Resets in 5 d 3 h",
    "第 1 / 309 页 · 共 6,174 次请求": "Page 1 of 309 · 6,174 requests",
    "请求的是 claude-opus-5[1m]，上游返回的是 claude-sonnet-5": "Requested claude-opus-5[1m], but the upstream returned claude-sonnet-5",
    "2026 年 9 月": "September 2026",
    "外观：日间": "Appearance: Light",
    "未计入 2 个窗口：2 个本机没有用量（可能用在别的设备上）。": "2 windows left out: 2 with no local usage (maybe used on another device).",
  };
  const wrong = Object.entries(samples).filter(([zh, en]) => translate(zh) !== en);
  check("带变量的句子按模板翻", !wrong.length, wrong.map(([zh]) => `${zh} → ${translate(zh)}`).join(" | "));
  check("英文词典里没有漏翻的中文", Object.values(EN).every((en) => !/[\u4e00-\u9fff]/.test(en) || /简体中文/.test(en)));
  check("不含中文的内容（型号、路径、数字）原样不动", translate("claude-opus-5 · D:\\work · 1,234") === "claude-opus-5 · D:\\work · 1,234");
  check("模板都能编译", PATTERNS.every(([re]) => re instanceof RegExp));
} catch (error) {
  console.error(error);
  results.push(false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
assert.equal(passed, results.length);
