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
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
assert.equal(passed, results.length, "usage scan regression failed");
