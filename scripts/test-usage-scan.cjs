/**
 * 会话文件扫描。跑法（先 npm run compile）：
 *
 *   node scripts/test-usage-scan.cjs
 *
 * 用一次性的 HOME 和数据目录，不碰用户真实的 ~/.codex 和 ~/.tokenpulse。
 *   - Codex 的型号：turn_context 在 usage 之前，thread_settings_applied 可能排在第一条 usage 之后，
 *     或者整个会话都没有 —— 第一轮不能落成「未知模型」。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-scan-"));
// os.homedir() 在 Windows 上读 USERPROFILE，其余平台读 HOME，两个都指过去。
process.env.HOME = process.env.USERPROFILE = path.join(root, "home");
process.env.TOKENPULSE_DATA_DIR = path.join(root, "data");
const { scanLocalUsage, readRollups } = require(path.join(__dirname, "..", "build", "core", "usage-scan.js"));

const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const at = (min) => new Date(Date.UTC(2026, 8, 4, 1, min)).toISOString();
const usage = (id, min) => ({ timestamp: at(min), type: "token_usage_record", payload: { response_id: id, usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 40 } } });
const write = (name, rows) => {
  const dir = path.join(process.env.HOME, ".codex", "sessions", "2026", "09", "04");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
};

try {
  // 实测顺序：turn_context → usage → thread_settings_applied → turn_context → usage
  write("rollout-a.jsonl", [
    { timestamp: at(0), type: "session_meta", payload: { model_provider: "openai" } },
    { timestamp: at(1), type: "turn_context", payload: { model: "codex-auto-review" } },
    usage("resp_a1", 2),
    { timestamp: at(3), type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "codex-auto-review" } } },
    { timestamp: at(4), type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    usage("resp_a2", 5),
  ]);
  // 整个会话都没有 thread_settings_applied
  write("rollout-b.jsonl", [
    { timestamp: at(0), type: "session_meta", payload: { model_provider: "openai" } },
    { timestamp: at(1), type: "turn_context", payload: { model: "gpt-6-astra" } },
    usage("resp_b1", 2),
  ]);

  scanLocalUsage();
  const models = {};
  for (const state of Object.values(readRollups().files)) {
    for (const bySource of Object.values(state.days)) {
      for (const [model, bucket] of Object.entries(bySource["Codex CLI"] ?? {})) models[model] = (models[model] ?? 0) + bucket.requests;
    }
  }
  check("第一轮按 turn_context 记型号，不是「未知模型」", !models["未知模型"] && models["codex-auto-review"] === 1, JSON.stringify(models));
  check("换型号的下一轮跟着 turn_context 走", models["gpt-5.6-sol"] === 1, JSON.stringify(models));
  check("没有 thread_settings_applied 的会话也认得型号", models["gpt-6-astra"] === 1, JSON.stringify(models));

  // 官方小时账按账号拆分：后续额度容量不能把别的账号的请求算进来。
  const loginTimeline = require(path.join(__dirname, "..", "build", "core", "login-timeline.js"));
  const claudeHome = path.join(process.env.HOME, ".claude");
  fs.mkdirSync(path.join(claudeHome, "projects", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "claude-token", refreshToken: "claude-refresh" } }));
  fs.writeFileSync(path.join(process.env.HOME, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-a", emailAddress: "a@example.com" } }));
  const claudeAt = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(
    path.join(claudeHome, "projects", "fixture", "session.jsonl"),
    JSON.stringify({ type: "assistant", timestamp: claudeAt, requestId: "req-claude-1", message: { id: "msg-claude-1", model: "claude-opus-5", usage: { input_tokens: 100, output_tokens: 10 } } }) + "\n",
  );
  loginTimeline.recordCliLogins(Date.now());
  scanLocalUsage();
  const claudeState = Object.values(readRollups().files).find((state) => state.kind === "claude-code");
  check(
    "官方小时账记录账号维度",
    claudeState?.accountHours?.["claude:uuid-a"] && Object.keys(claudeState.accountHours["claude:uuid-a"]).length === 1,
    JSON.stringify(Object.keys(claudeState?.accountHours ?? {})),
  );

  // 按账号的小时账丢了（比如文件先被当成非官方扫过）：要从头重读补回来，不能每轮都「需要补」却什么都不做
  {
    const file = path.join(process.env.TOKENPULSE_DATA_DIR, "usage-rollups.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const key = Object.keys(saved.files).find((name) => saved.files[name].kind === "claude-code");
    saved.files[key].accountHours = {};
    fs.writeFileSync(file, JSON.stringify(saved));
    scanLocalUsage();
    const repaired = readRollups().files[key];
    check("缺按账号的小时账时重读文件补回来", Object.keys(repaired.accountHours ?? {}).length === 1, JSON.stringify(Object.keys(repaired.accountHours ?? {})));
  }

  // 写了流水、账本没写完就被杀：下次从旧偏移重读会再追加一遍，必须整理掉
  {
    const requestDir = path.join(process.env.TOKENPULSE_DATA_DIR, "requests");
    const lines = () => fs.readdirSync(requestDir).flatMap((name) => fs.readFileSync(path.join(requestDir, name), "utf8").split("\n").filter(Boolean));
    const before = lines().length;
    const unique = new Set(lines().map((line) => { const r = JSON.parse(line); return r.kind + "|" + r.id; })).size;
    check("正常扫描之后流水没有重复行", before === unique, `${before} 行 / ${unique} 个请求`);
    // 模拟：流水追加了、账本还停在旧偏移、pending 标记留着
    const file = path.join(process.env.TOKENPULSE_DATA_DIR, "usage-rollups.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const key = Object.keys(saved.files).find((name) => saved.files[name].kind === "codex");
    const month = fs.readdirSync(requestDir)[0];
    const codexLines = lines().filter((line) => JSON.parse(line).kind === "codex");
    fs.appendFileSync(path.join(requestDir, month), codexLines.join("\n") + "\n");
    saved.files[key].offset = 0; saved.files[key].size = 0; saved.files[key].days = {}; saved.files[key].hours = {};
    fs.writeFileSync(file, JSON.stringify(saved));
    fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, "requests-pending"), "1");
    scanLocalUsage();
    const after = lines();
    const afterUnique = new Set(after.map((line) => { const r = JSON.parse(line); return r.kind + "|" + r.id; })).size;
    check("上一轮死在中间（pending 还在）：这一轮扫完整理掉重复行", after.length === afterUnique && afterUnique === unique, `${after.length} 行 / ${afterUnique} 个请求`);
    check("扫完删掉 pending 标记", !fs.existsSync(path.join(process.env.TOKENPULSE_DATA_DIR, "requests-pending")));
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
assert.equal(passed, results.length, "usage scan regression failed");
