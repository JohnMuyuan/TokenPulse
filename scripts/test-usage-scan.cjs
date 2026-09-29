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

  // Codex 旧版本只写 event_msg / token_count：以前整份漏算。用本次（last），不用累计（total）
  {
    const tc = (min, total, last) => ({ timestamp: at(min), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: total, output_tokens: 0 }, last_token_usage: { input_tokens: last, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } } } });
    write("rollout-old.jsonl", [
      { timestamp: at(0), type: "session_meta", payload: { model_provider: "openai" } },
      { timestamp: at(1), type: "turn_context", payload: { model: "gpt-old" } },
      // 续接的会话：第一条累计就很大，本次只有 1000
      tc(2, 90000, 1000),
      tc(3, 90000, 1000), // 原样重复写了一遍：不算
      tc(4, 92000, 2000),
      // 压缩上下文后累计骤降：本次照常算
      tc(5, 3000, 3000),
      { timestamp: at(6), type: "event_msg", payload: { type: "token_count", info: null } },
    ]);
    // 中途换成新版：第一条 record 之前的 token_count 算，之后的都不算（新版两种都写，粒度不同）
    write("rollout-switch.jsonl", [
      { timestamp: at(0), type: "session_meta", payload: { model_provider: "openai" } },
      { timestamp: at(1), type: "turn_context", payload: { model: "gpt-switch" } },
      tc(2, 500, 500),
      { timestamp: at(3), type: "turn_context", payload: { model: "gpt-switch" } },
      { timestamp: at(4), type: "token_usage_record", payload: { response_id: "resp_s1", usage: { input_tokens: 700, output_tokens: 10, cached_input_tokens: 0 } } },
      tc(5, 1210, 710),
    ]);
    scanLocalUsage();
    const fileTokens = (name) => {
      const state = Object.entries(readRollups().files).find(([file]) => file.endsWith(name))?.[1];
      let tokens = 0, requests = 0;
      for (const bySource of Object.values(state?.days ?? {})) for (const b of Object.values(bySource["Codex CLI"] ?? {})) { tokens += b.input + b.output; requests += b.requests; }
      return { tokens, requests };
    };
    const old = fileTokens("rollout-old.jsonl");
    check("Codex 旧格式 token_count 计入：按本次用量、跳过重复、不受累计骤降影响", old.tokens === 6015 && old.requests === 3, JSON.stringify(old));
    const switched = fileTokens("rollout-switch.jsonl");
    check("同一文件出现 record 之后不再算 token_count", switched.tokens === 505 + 710 && switched.requests === 2, JSON.stringify(switched));

    // 从 v7 账本升级：Codex 文件整份重算，不能在旧账上再加一遍
    const file = path.join(process.env.TOKENPULSE_DATA_DIR, "usage-rollups.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const state of Object.values(saved.files)) if (state.kind === "codex") state.v = 7;
    fs.writeFileSync(file, JSON.stringify(saved));
    scanLocalUsage();
    const again = fileTokens("rollout-old.jsonl"), switchedAgain = fileTokens("rollout-switch.jsonl");
    check("v7 → v9 升级后 Codex 不重复计", again.tokens === 6015 && switchedAgain.tokens === 1215, JSON.stringify({ again, switchedAgain }));

    /*
     * 压缩上下文那一次调用（0.3.9）：
     * - Codex 旧格式（只写 token_count）远端压缩不写 usage：输入按上一次调用的输入 + 输出，输出按密文长度 × 0.17；
     * - Codex 新格式紧挨着有 token_usage_record：已经算过，不能再估一笔；
     * - 文件开头继承来的压缩（还没有任何 token_count）不是这个会话发的，不算。
     */
    const encrypted = "x".repeat(10000);
    write("rollout-compact-old.jsonl", [
      { timestamp: at(0), type: "session_meta", payload: { model_provider: "openai" } },
      { timestamp: at(1), type: "compacted", payload: { message: "", replacement_history: [{ type: "compaction", encrypted_content: "y".repeat(5000) }] } },
      { timestamp: at(2), type: "turn_context", payload: { model: "gpt-compact" } },
      tc(3, 200000, 200000),
      { timestamp: at(4), type: "compacted", payload: { message: "", replacement_history: [{ type: "message", role: "user" }, { type: "compaction", encrypted_content: encrypted }] } },
      { timestamp: at(4), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 200000, output_tokens: 5 }, last_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 12000 } } } },
    ]);
    write("rollout-compact-new.jsonl", [
      { timestamp: at(0), type: "session_meta", payload: { model_provider: "openai" } },
      { timestamp: at(1), type: "turn_context", payload: { model: "gpt-compact-new" } },
      { timestamp: at(2), type: "token_usage_record", payload: { response_id: "resp_n1", usage: { input_tokens: 1000, output_tokens: 10, cached_input_tokens: 0 } } },
      tc(2, 1010, 1000),
      { timestamp: at(3), type: "token_usage_record", payload: { response_id: "resp_n2", usage: { input_tokens: 1010, output_tokens: 300, cached_input_tokens: 0 } } },
      { timestamp: at(3), type: "compacted", payload: { message: "", replacement_history: [{ type: "compaction", encrypted_content: encrypted }] } },
    ]);
    scanLocalUsage();
    const compactOld = fileTokens("rollout-compact-old.jsonl"), compactNew = fileTokens("rollout-compact-new.jsonl");
    check("Codex 旧格式压缩补记一笔：输入 200005 + 输出 1700，继承来的压缩不算", compactOld.requests === 2 && compactOld.tokens === 200005 + 200005 + 1700, JSON.stringify(compactOld));
    check("Codex 新格式压缩已有 record，不重复估", compactNew.requests === 2 && compactNew.tokens === 1010 + 1310, JSON.stringify(compactNew));
  }

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
  // Claude Code 压缩：compact_boundary 的 preTokens 是输入（走缓存），摘要行估输出；Grok 的 auto_compact_completed 同理
  {
    const dir = path.join(process.env.HOME, ".claude", "projects", "compact-fixture");
    fs.mkdirSync(dir, { recursive: true });
    const t = (min) => new Date(Date.UTC(2026, 8, 5, 1, min)).toISOString();
    const summary = "This session is being continued. " + "a".repeat(3967) + "汉字汉字";
    const lines = [
      { type: "assistant", timestamp: t(0), cwd: "D:\\Work\\Alpha", requestId: "req_c1", message: { id: "msg_c1", model: "claude-opus-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 900000, output_tokens: 50 } } },
      { type: "system", subtype: "compact_boundary", timestamp: t(1), uuid: "boundary-1", compactMetadata: { trigger: "auto", preTokens: 950000, postTokens: 12000 } },
      { type: "user", timestamp: t(1), isCompactSummary: true, message: { role: "user", content: summary } },
      { type: "assistant", timestamp: t(2), cwd: "D:\\Work\\Alpha", requestId: "req_c2", message: { id: "msg_c2", model: "claude-opus-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 12000, output_tokens: 20 } } },
    ];
    // 摘要落在下一批：分两次写，模拟增量读正好切在分界线和摘要之间
    fs.writeFileSync(path.join(dir, "compact.jsonl"), lines.slice(0, 2).map((l) => JSON.stringify(l)).join("\n") + "\n");
    scanLocalUsage();
    fs.appendFileSync(path.join(dir, "compact.jsonl"), lines.slice(2).map((l) => JSON.stringify(l)).join("\n") + "\n");
    scanLocalUsage();
    const requestDir = path.join(process.env.TOKENPULSE_DATA_DIR, "requests");
    const records = () => fs.readdirSync(requestDir).flatMap((name) => fs.readFileSync(path.join(requestDir, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    const claudeCompact = records().filter((r) => r.kind === "claude-code" && r.compaction);
    check(
      "Claude 压缩补记：输入 = preTokens 且走缓存，输出按摘要估，型号沿用会话型号",
      claudeCompact.length === 1 && claudeCompact[0].input === 950000 && claudeCompact[0].cacheRead === 950000 && claudeCompact[0].output === 1004 && claudeCompact[0].model === "claude-opus-5-5" && claudeCompact[0].cwd === "D:\\Work\\Alpha",
      JSON.stringify(claudeCompact),
    );

    const grokDir = path.join(process.env.HOME, ".grok", "sessions", encodeURIComponent("D:\\Work\\Beta"), "grok-session-1");
    fs.mkdirSync(path.join(grokDir, "compaction_checkpoints"), { recursive: true });
    fs.writeFileSync(path.join(grokDir, "compaction_checkpoints", "cp1.json"), JSON.stringify({ compacted_history: [{ type: "system", content: "sys ".repeat(500) }, { type: "user", content: [{ type: "text", text: "This session is being continued from a previous conversation. " + "b".repeat(1938) }] }] }));
    fs.writeFileSync(path.join(process.env.HOME, ".grok", "sessions", "escape.json"), JSON.stringify({ compacted_history: [{ type: "user", content: "This session is being continued " + "c".repeat(8000) }] }));
    const ts = (min) => Math.floor(Date.UTC(2026, 8, 6, 1, min) / 1000);
    const turn = (min, id, model, input, cached) => ({ timestamp: ts(min), params: { update: { sessionUpdate: "turn_completed", prompt_id: id, usage: { modelUsage: { [model]: { inputTokens: input, outputTokens: 10, cachedReadTokens: cached, modelCalls: 1 } } } } } });
    fs.writeFileSync(path.join(grokDir, "updates.jsonl"), [
      { timestamp: ts(0), params: { update: { sessionUpdate: "auto_compact_started", tokens_used: 400000 } } },
      { timestamp: ts(1), params: { update: { sessionUpdate: "compaction_checkpoint", checkpoint_file: "compaction_checkpoints/cp1.json" } } },
      { timestamp: ts(1), params: { update: { sessionUpdate: "auto_compact_completed", tokens_before: 400000, tokens_after: 11000 } } },
      turn(2, "p1", "grok-4.7-build", 1000, 900),
      { timestamp: ts(3), params: { update: { sessionUpdate: "compaction_checkpoint", checkpoint_file: "../../escape.json" } } },
      { timestamp: ts(3), params: { update: { sessionUpdate: "auto_compact_completed", tokens_before: 300000, tokens_after: 9000 } } },
      turn(4, "p2", "grok-4.7-build", 2000, 1000),
    ].map((l) => JSON.stringify(l)).join("\n") + "\n");
    scanLocalUsage();
    const grokCompact = records().filter((r) => r.kind === "grok-build" && r.compaction).sort((a, b) => a.at - b.at);
    check(
      "Grok 压缩补记：型号取这一轮实际计费的型号，缓存按上一轮比例，检查点路径不越出会话目录",
      grokCompact.length === 2 && grokCompact.every((r) => r.model === "grok-4.7-build") && grokCompact[0].input === 400000 && grokCompact[0].cacheRead === 0 && grokCompact[0].output === 500
        && grokCompact[1].input === 300000 && grokCompact[1].cacheRead === 270000 && grokCompact[1].output === 0 && grokCompact[0].cwd === "D:\\Work\\Beta",
      JSON.stringify(grokCompact),
    );

    // v8 → v9：旧账本整份重算，压缩那笔补上但真实请求不重复计
    const file = path.join(process.env.TOKENPULSE_DATA_DIR, "usage-rollups.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const state of Object.values(saved.files)) state.v = 8;
    fs.writeFileSync(file, JSON.stringify(saved));
    scanLocalUsage();
    const claudeState = Object.entries(readRollups().files).find(([name]) => name.endsWith("compact.jsonl"))[1];
    let claudeTokens = 0, claudeRequests = 0;
    for (const bySource of Object.values(claudeState.days)) for (const b of Object.values(bySource["Claude Code"] ?? {})) { claudeTokens += b.input + b.output; claudeRequests += b.requests; }
    const unique = new Set(records().map((r) => r.kind + "|" + r.id));
    check("v8 → v9 重算后 Claude 账本 = 两次请求 + 一次压缩，流水不重复", claudeRequests === 3 && claudeTokens === 900060 + 951004 + 12030 && unique.size === records().length, JSON.stringify({ claudeTokens, claudeRequests }));
  }

} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
assert.equal(passed, results.length, "usage scan regression failed");
