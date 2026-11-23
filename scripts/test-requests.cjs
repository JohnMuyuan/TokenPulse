/**
 * 请求流水与型号核验。跑法（先 npm run compile）：
 *
 *   node scripts/test-requests.cjs
 *
 * 用一次性的 HOME 和数据目录，不碰用户真实的 ~/.claude / ~/.codex / ~/.grok 和 ~/.tokenpulse。
 * 会话文件的字段都照着本机真实文件写（只换了值）：
 *   - Claude Code：请求型号在 attachment.identity.modelId，返回型号在 message.model，
 *     官方响应 ID 是 msg_ + 24 位、请求 ID 是 req_011…；
 *   - Grok：请求型号在用户消息的 _meta.modelId，返回型号是 modelUsage 的键（grok-4.6 → grok-4.6-build 是官方变体）；
 *   - Codex：只有 response_id，不记返回型号。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-requests-"));
process.env.HOME = process.env.USERPROFILE = path.join(root, "home");
process.env.TOKENPULSE_DATA_DIR = path.join(root, "data");
const build = path.join(__dirname, "..", "build", "core");
const { scanLocalUsage, readRollups } = require(path.join(build, "usage-scan.js"));
const { queryRequests, recentAlerts, requestDir } = require(path.join(build, "request-log.js"));
const { verifyRequest, normalizeModel } = require(path.join(build, "request-verify.js"));

const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const base = Date.UTC(2026, 8, 20, 2, 0);
const at = (min) => new Date(base + min * 60_000).toISOString();
const official = (n) => `msg_01${String(n).padStart(22, "A")}`;
const req = (n) => `req_011C${String(n).padStart(20, "B")}`;
const write = (file, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
};
const claudeDir = path.join(process.env.HOME, ".claude", "projects", "D--work-demo");
const identity = (min, modelId) => ({ type: "attachment", timestamp: at(min), attachment: { type: "model", identity: { modelId } } });
const assistant = (min, model, id, requestId, extra = {}) => ({
  type: "assistant",
  timestamp: at(min),
  requestId,
  cwd: "D:\\work\\demo",
  sessionId: "s1",
  message: { id, model, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, service_tier: "standard" } },
  effort: "medium",
  ...extra,
});
const all = (extra = {}) => queryRequests({ from: "2026-01-01", to: "2026-12-31", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 50, all: true, ...extra });

try {
  /* ---------------- 纯规则 ---------------- */
  check("[1m]、日期后缀、Bedrock 前缀、Grok 的 -build 都算同一型号",
    normalizeModel("claude-opus-5[1m]") === "claude-opus-5" &&
    normalizeModel("claude-opus-4-8-20260315") === "claude-opus-4-8" &&
    normalizeModel("us.anthropic.claude-opus-4-8-v1:0") === "claude-opus-4-8" &&
    normalizeModel("grok-4.6-build") === "grok-4.6" &&
    normalizeModel("Grok 4.6 Build") === "grok-4.6" &&
    normalizeModel("grok-4.6 · TokenPulse") === "grok-4.6");
  check("不会把 gpt-5 和 gpt-5.4 当成同一个（不做模糊包含）", normalizeModel("gpt-5") !== normalizeModel("gpt-5.4"));
  const agEffort = verifyRequest({ kind: "antigravity", requested: "claude-opus-5-5", returned: "claude-opus-5-5-medium" });
  check("Antigravity：claude-opus-5-5 → claude-opus-5-5-medium 只是带了思考等级，算一致",
    agEffort.status === "match" && agEffort.reasons.some((r) => /思考等级/.test(r) && /medium/.test(r)), JSON.stringify(agEffort));
  const agGeminiEffort = verifyRequest({ kind: "antigravity", requested: "gemini-4-hydrogen", returned: "gemini-4-hydrogen-xhigh" });
  const agGptOssEffort = verifyRequest({ kind: "antigravity", requested: "gpt-oss-120b", returned: "gpt-oss-120b-medium" });
  check("Antigravity：gemini-4-hydrogen-xhigh 与 gpt-oss-120b-medium 等级后缀同样识别为一致",
    agGeminiEffort.status === "match" && agGptOssEffort.status === "match" &&
    agGeminiEffort.reasons.some((r) => /思考等级/.test(r) && /xhigh/.test(r)),
    JSON.stringify([agGeminiEffort, agGptOssEffort]));
  const agTieredHigh = verifyRequest({ kind: "antigravity", requested: "gemini-4-hydrogen", returned: "gemini-4-hydrogen-tiered-high" });
  const agTieredFlash = verifyRequest({ kind: "antigravity", requested: "gemini-3.8-flash-tiered", returned: "gemini-3.8-flash-tiered-medium" });
  const agSuffixEffort = verifyRequest({ kind: "antigravity", requested: "gemini-4-argon", returned: "gemini-4-argon-b-xhigh" });
  const agWorkerEffort = verifyRequest({ kind: "antigravity", requested: "gemini-flash", returned: "gemini-flash-worker-agy-low" });
  const agTieredWrong = verifyRequest({ kind: "antigravity", requested: "gemini-4-hydrogen", returned: "gemini-4-carbon-tiered-high" });
  check("Antigravity：动态分档叠加思考等级（如 gemini-4-hydrogen-tiered-high / -b-xhigh / -worker-agy-low）算一致，跨型号仍判不一致",
    agTieredHigh.status === "match" && agTieredHigh.reasons.some((r) => /思考等级/.test(r) && /tiered-high/.test(r)) &&
    agTieredFlash.status === "match" && agSuffixEffort.status === "match" && agWorkerEffort.status === "match" &&
    agTieredWrong.status === "mismatch",
    JSON.stringify([agTieredHigh, agTieredFlash, agSuffixEffort, agWorkerEffort, agTieredWrong]));
  check("Claude 思考等级后缀（含 thinking、叠加）都去掉，但不会把 opus 和 sonnet 混为一谈",
    normalizeModel("claude-sonnet-5-thinking") === "claude-sonnet-5" &&
    normalizeModel("claude-opus-5-5-thinking-high") === "claude-opus-5-5" &&
    normalizeModel("claude-opus-5-5-xhigh") === "claude-opus-5-5" &&
    normalizeModel("claude-opus-5-5-medium") !== normalizeModel("claude-sonnet-5-5"));
  check("别家型号不去等级后缀", normalizeModel("gpt-5.4-high") === "gpt-5.4-high");
  const agWrong = verifyRequest({ kind: "antigravity", requested: "claude-opus-5-5", returned: "claude-sonnet-5-medium" });
  check("Antigravity：请求 opus、返回 sonnet（带等级）仍判不一致", agWrong.status === "mismatch");
  const agOrchNeon = verifyRequest({ kind: "antigravity", requested: "orchestrator-neon", returned: "gemini-pro-orchestrator" });
  const agOrchCarbon = verifyRequest({ kind: "antigravity", requested: "orchestrator-carbon", returned: "gemini-pro-orchestrator" });
  const agOrchArgon = verifyRequest({ kind: "antigravity", requested: "orchestrator-argon", returned: "gemini-pro-orchestrator-high" });
  const agOrchLegacy = verifyRequest({ kind: "antigravity", requested: "orchestrator", returned: "gemini-pro-orchestrator" });
  check("Antigravity：Orchestrator (Neon / Carbon / Argon / 旧 orchestrator) → gemini-pro-orchestrator(-high) 算一致并注明内部型号名",
    agOrchNeon.status === "match" && agOrchCarbon.status === "match" && agOrchArgon.status === "match" && agOrchLegacy.status === "match" &&
    agOrchCarbon.reasons.some((r) => /内部型号名/.test(r) && /gemini-pro-orchestrator/.test(r)),
    JSON.stringify([agOrchNeon, agOrchCarbon, agOrchArgon]));
  const agWorker = verifyRequest({ kind: "antigravity", requested: "gemini-flash", returned: "gemini-flash-worker-agy" });
  check("Antigravity：gemini-flash → gemini-flash-worker-agy 算一致并注明内部型号名",
    agWorker.status === "match" && agWorker.reasons.some((r) => /内部型号名/.test(r) && /gemini-flash-worker-agy/.test(r)),
    JSON.stringify(agWorker));
  const agOrchMismatch = verifyRequest({ kind: "antigravity", requested: "orchestrator-carbon", returned: "gemini-flash-worker-agy" });
  check("Antigravity：请求 orchestrator-carbon、返回 gemini-flash-worker-agy 仍判不一致", agOrchMismatch.status === "mismatch");
  const swapped = verifyRequest({ kind: "claude-code", requested: "claude-opus-5[1m]", returned: "claude-sonnet-5", responseId: official(1), requestId: req(1), official: false });
  check("请求 opus、返回 sonnet → 型号不一致", swapped.status === "mismatch" && /claude-opus-5\[1m\].*claude-sonnet-5/.test(swapped.reasons[0]), swapped.reasons[0]);
  const disguised = verifyRequest({ kind: "claude-code", requested: "claude-opus-5", returned: "claude-opus-5", responseId: "resp_" + "0".repeat(50), official: false });
  check("型号名对得上、响应 ID 却是 OpenAI 格式 → 响应存疑", disguised.status === "suspect" && /OpenAI/.test(disguised.reasons[0]), disguised.reasons[0]);
  const noReq = verifyRequest({ kind: "claude-code", requested: "claude-opus-5", returned: "claude-opus-5", responseId: official(2), official: true });
  check("官方直连却没有 request-id → 响应存疑", noReq.status === "suspect");
  const relayOk = verifyRequest({ kind: "claude-code", requested: "claude-opus-5", returned: "claude-opus-5", responseId: official(3), requestId: req(3), official: false });
  check("中转站原样回显 → 一致，但说明「只代表没露馅」", relayOk.status === "match" && relayOk.reasons.some((r) => /没露馅/.test(r)));
  const thirdParty = verifyRequest({ kind: "claude-code", requested: "grok-4.6[1M]", returned: "grok-4.6", responseId: "0b1c2d3e-0000-4000-8000-000000000000", official: true });
  check("Claude Code 接第三方模型（AllAi 那种）不误报", thirdParty.status === "match" && /第三方模型/.test(thirdParty.reasons[0]), thirdParty.reasons[0]);
  const bedrock = verifyRequest({ kind: "claude-code", requested: "claude-opus-4-8", returned: "claude-opus-4-8", responseId: "msg_bdrk_01ABCDEFGHIJKLMNOPQRSTUV", official: false });
  check("Bedrock 的 msg_bdrk_ 属于官方云渠道，不算存疑", bedrock.status === "match" && bedrock.channel === "AWS Bedrock");
  const codex = verifyRequest({ kind: "codex", requested: "gpt-6-astra", responseId: "resp_" + "a".repeat(50), official: true });
  check("Codex 不记返回型号 → 无法核验（格式正常）", codex.status === "unverified");
  const codexBad = verifyRequest({ kind: "codex", requested: "gpt-6-astra", responseId: "chatcmpl-abc", official: false });
  check("Codex 的响应 ID 不是 resp_ 格式 → 响应存疑", codexBad.status === "suspect");
  const codexOss = verifyRequest({ kind: "codex", requested: "gpt-oss:20b", responseId: "chatcmpl-123", official: false });
  check("Codex 接 Ollama 自部署的 gpt-oss:20b → 不误报存疑", codexOss.status !== "suspect" && codexOss.reasons.some((r) => /开源或第三方模型/.test(r)), JSON.stringify(codexOss));
  const codexOss2 = verifyRequest({ kind: "codex", requested: "qwen3-coder:30b", responseId: "resp_123456", official: false });
  check("Codex 接 Ollama 的 qwen3-coder:30b（resp_ 加短数字）→ 不误报存疑", codexOss2.status !== "suspect");

  /* ---------------- 扫描 → 流水 ---------------- */
  write(path.join(claudeDir, "s1.jsonl"), [
    identity(0, "claude-opus-5[1m]"),
    assistant(1, "claude-opus-5", official(10), req(10)),
    // 同一次响应被拆成两行（相同 requestId）：只算一次
    assistant(1, "claude-opus-5", official(10), req(10)),
    assistant(2, "claude-sonnet-5", official(11), req(11)),
    assistant(3, "claude-opus-5", "resp_" + "1".repeat(50), undefined),
    // 进程重新接上会话：可能换了型号但还没写 identity，这之后的请求型号清空
    { type: "attachment", timestamp: at(4), attachment: { type: "session_context", changed: true, reason: "session_start" } },
    assistant(5, "gpt-5.6-sol", "resp_" + "2".repeat(50), undefined),
    identity(6, "gpt-5.6-sol[1m]"),
    assistant(7, "gpt-5.6-sol", "resp_" + "3".repeat(50), undefined),
    assistant(8, "<synthetic>", "x", undefined),
  ]);
  const grokSession = path.join(process.env.HOME, ".grok", "sessions", encodeURIComponent("D:\\work\\grok"), "01a0-session");
  write(path.join(grokSession, "updates.jsonl"), [
    { method: "session/update", params: { update: { sessionUpdate: "user_message_chunk", _meta: { modelId: "grok-4.6" } } } },
    { method: "_x.ai/session/update", timestamp: base / 1000 + 600, params: { update: { sessionUpdate: "turn_completed", prompt_id: "p1", usage: { modelUsage: { "grok-4.6-build": { inputTokens: 50, outputTokens: 5, modelCalls: 3, costUsdTicks: 1000000 } } } } } },
    { method: "session/update", params: { update: { sessionUpdate: "user_message_chunk", _meta: { modelId: "grok-4.6" } } } },
    { method: "_x.ai/session/update", timestamp: base / 1000 + 660, params: { update: { sessionUpdate: "turn_completed", prompt_id: "p2", usage: { modelUsage: { "grok-4.5-fast": { inputTokens: 40, outputTokens: 4, modelCalls: 1 } } } } } },
  ]);
  const codexFile = path.join(process.env.HOME, ".codex", "sessions", "2026", "09", "20", "rollout-2026-09-20T10-00-00-abc.jsonl");
  write(codexFile, [
    { timestamp: at(0), type: "session_meta", payload: { model_provider: "openai", cwd: "D:\\work\\codex" } },
    { timestamp: at(1), type: "turn_context", payload: { model: "gpt-6-astra", effort: "high" } },
    { timestamp: at(2), type: "token_usage_record", payload: { response_id: "resp_" + "c".repeat(50), usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 40 } } },
  ]);

  const scan = scanLocalUsage();
  check("每一次请求都进了流水（拆行去重、<synthetic> 不算）", scan.records.length === 5 + 2 + 1, `${scan.records.length} 条`);
  const page = all();
  const byId = Object.fromEntries(page.rows.map((row) => [row.responseId || row.key, row]));
  check("同一次请求被拆成两行，只记一条", page.rows.filter((row) => row.responseId === official(10)).length === 1);
  check("Claude：identity 写了 opus、返回 sonnet → 型号不一致", byId[official(11)]?.status === "mismatch", byId[official(11)]?.reasons[0]);
  check("Claude：返回 opus 但 ID 是 OpenAI 格式 → 响应存疑", byId["resp_" + "1".repeat(50)]?.status === "suspect");
  check("会话重新接上后请求型号清空：不误报不一致",
    byId["resp_" + "2".repeat(50)]?.status !== "mismatch" && !byId["resp_" + "2".repeat(50)]?.requested);
  check("新的 identity 写入后恢复核验", byId["resp_" + "3".repeat(50)]?.requested === "gpt-5.6-sol[1m]" && byId["resp_" + "3".repeat(50)]?.status === "match");
  const grokRows = page.rows.filter((row) => row.source === "Grok Build").sort((a, b) => a.at - b.at);
  check("Grok：grok-4.6 → grok-4.6-build 是官方变体，算一致", grokRows[0]?.status === "match" && grokRows[0]?.calls === 3, JSON.stringify(grokRows[0]?.reasons));
  const buildEcho = verifyRequest({ kind: "grok-build", requested: "grok-4.6", returned: "grok-4.6-build", proxy: { declared: "grok-4.6", returned: "grok-4.6-build", via: "tokenpulse" } });
  check("Grok：回复开头的 grok-4.6 和结束时的 grok-4.6-build 是同一个型号，不算存疑", buildEcho.status === "match", JSON.stringify(buildEcho));
  check("Grok：请求 grok-4.6、返回 grok-4.5-fast → 型号不一致", grokRows[1]?.status === "mismatch");
  check("Grok 的工作目录从目录名解出来", grokRows[0]?.cwd === "D:\\work\\grok", grokRows[0]?.cwd);
  const codexRow = page.rows.find((row) => row.source === "Codex CLI");
  check("Codex 思考等级来自当轮 turn_context", codexRow?.effort === "high" && codexRow.effortSource === "turn_context.effort");
  check("Claude 思考等级来自每响应的结构化字段", page.rows.filter(row => row.source === "Claude Code").every(row => row.effort === "medium"));
  check("Codex：请求型号来自 turn_context、工作目录来自 session_meta", codexRow?.requested === "gpt-6-astra" && codexRow?.cwd === "D:\\work\\codex" && codexRow.status === "unverified");
  check("核验计数", page.counts.mismatch === 2 && page.counts.suspect === 1, JSON.stringify(page.counts));
  {
    // 0.3.35：这次请求经 TokenPulse 转发过（透明转发 / 本地路由）→ 用转发时从上游回复里读到的型号核验，靠响应 ID 对应
    const ledger = require(path.join(__dirname, "..", "build", "core", "route-ledger.js"));
    const logFile = path.join(ledger.routeLogDir(), "2026-09.jsonl");
    const codexId = "resp_" + "c".repeat(50);
    const forwarded = (returnedModel, responseId = codexId) => { fs.mkdirSync(ledger.routeLogDir(), { recursive: true }); fs.writeFileSync(logFile, JSON.stringify({ at: base, app: "codex", pass: true, status: 200, requestModel: "gpt-6-astra", responseId, returnedModel, ms: 4200, firstByteMs: 400, firstTokenMs: 1900, tokensPerSec: 61.5, stream: true, path: "/responses", provider: "官方登录（透明转发）", tier: "priority", authorization: "Bearer never" }) +"\n"); ledger.resetRouteLedgerCache(); };
    const codexNow = () => all().rows.find((row) => row.source === "Codex CLI");
    forwarded("gpt-6-astra-2026-09-01");
    check("Codex 经 TokenPulse 转发：返回型号对得上 → 型号一致", codexNow()?.status === "match" && codexNow()?.returned === "gpt-6-astra-2026-09-01" && codexNow()?.reasons.some((text) => text.includes("经 TokenPulse 转发")), JSON.stringify(codexNow()?.reasons));
    check("经 TokenPulse 转发的请求带上延迟和速度，别的字段不带出来", JSON.stringify(codexNow()?.timing) === JSON.stringify({ ms: 4200, firstByteMs: 400, firstTokenMs: 1900, tokensPerSec: 61.5, stream: true, path: "/responses", pass: true, provider: "官方登录（透明转发）", fast: true }), JSON.stringify(codexNow()?.timing));
    forwarded("gpt-6-mini");
    check("Codex 经 TokenPulse 转发：上游回的是别的型号 → 型号不一致", codexNow()?.status === "mismatch" && codexNow()?.reasons[0] === "请求的是 gpt-6-astra，上游返回的是 gpt-6-mini", codexNow()?.reasons[0]);
    check("新请求提醒也用得上", recentAlerts(scan.records, base + 60_000, 3_600_000).some((row) => row.source === "Codex CLI" && row.status === "mismatch"));
    forwarded("gpt-6-mini", "resp_" + "d".repeat(50));
    check("响应 ID 对不上的没有延迟", codexNow()?.timing === undefined);
    check("响应 ID 对不上的不算同一次请求", codexNow()?.status === "unverified" && codexNow()?.reasons.some((text) => text.includes("透明转发")));
    fs.rmSync(ledger.routeLogDir(), { recursive: true, force: true }); ledger.resetRouteLedgerCache();
  }

  /* ---------------- 查询 ---------------- */
  check("按核验结论筛选，顶部计数不受影响", all({ status: "mismatch" }).rows.length === 2 && all({ status: "mismatch" }).counts.all === page.counts.all);
  check("按工具筛选", all({ source: "Codex CLI" }).rows.length === 1);
  check("关键词能搜到项目和型号", all({ search: "demo" }).rows.every((row) => row.source === "Claude Code") && all({ search: "grok-4.5" }).rows.length === 1);
  check("日期范围之外的不返回", all({ from: "2026-09-21", to: "2026-09-30" }).rows.length === 0);
  const paged = queryRequests({ from: "2026-01-01", to: "2026-12-31", source: "all", status: "all", search: "", sort: "time", page: 1, pageSize: 3 });
  check("分页", paged.rows.length === 3 && paged.pages === 3 && paged.page === 1);
  check("费用：Grok 用自报的，Claude 按单价估", grokRows[0].costUsd === 0.001 && byId[official(10)].costUsd > 0);

  /* ---------------- 0.3.7：精确筛选与汇总同口径 ---------------- */
  const baseline = all().rows;
  const cases = [
    [{ models: ['claude-opus-5'] }, r => r.model === 'claude-opus-5'],
    [{ models: ['claude-opus-5', 'claude-sonnet-5'] }, r => ['claude-opus-5', 'claude-sonnet-5'].includes(r.model)],
    [{ models: ['claude-opus'] }, () => false],
    [{ project: 'D:\\work\\demo' }, r => r.cwd === 'D:\\work\\demo'],
    [{ project: '__missing__' }, r => !r.cwd],
    [{ channel: 'official' }, r => r.official === true],
    [{ channel: 'api' }, r => r.official === false],
    [{ channel: 'unknown' }, r => r.official === undefined],
    [{ status: 'mismatch' }, r => r.status === 'mismatch'],
    [{ account: 'none', channel: 'unknown' }, r => !r.account && r.official === undefined],
    [{ models: ['claude-opus-5'], search: 'demo', status: 'match' }, r => r.model === 'claude-opus-5' && (r.cwd || '').includes('demo') && r.status === 'match'],
    [{ models: ['missing-model'] }, () => false],
  ];
  for (const [filter, matches] of cases) {
    const result = all({ ...filter, aggregate: true, filteredAggregate: true });
    const expected = baseline.filter(matches);
    assert.deepEqual(result.rows.map(r => r.key).sort(), expected.map(r => r.key).sort());
    const sum = (rows, field) => rows.reduce((n, r) => n + r[field], 0);
    for (const field of ['tokens', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'costUsd']) {
      assert.ok(Math.abs(sum(result.aggregate.rows, field) - sum(expected, field)) < 1e-8, field + JSON.stringify(filter));
    }
    assert.equal(sum(result.aggregate.rows, 'requests'), sum(expected, 'calls'));
    assert.equal(sum(result.aggregate.hours, 'tokens'), sum(expected, 'tokens'));
    const paged = all({ ...filter, all: false, pageSize: 1, aggregate: true, filteredAggregate: true });
    assert.equal(paged.total, expected.length);
    assert.deepEqual(paged.aggregate, result.aggregate);
    assert.deepEqual(result.facets.models, [...new Set(baseline.map(r => r.model))].sort());
    check('筛选、分页、导出与汇总一致 ' + JSON.stringify(filter), true);
  }
  const legacy = all({ search: 'not-a-real-model', aggregate: true });
  assert.ok(legacy.aggregate.rows.length > 0, '总览旧汇总口径仍不受关键词影响');

  /* ---------------- 增量、重读、去重 ---------------- */
  const again = scanLocalUsage();
  check("文件没变，第二轮不重复追加", again.records.length === 0 && all().rows.length === page.rows.length);
  // 文件被重写（变短）→ 从头重读，流水里的重复被整理掉
  write(path.join(claudeDir, "s1.jsonl"), [identity(0, "claude-opus-5[1m]"), assistant(1, "claude-opus-5", official(10), req(10))]);
  scanLocalUsage();
  const lines = fs.readdirSync(requestDir()).flatMap((name) => fs.readFileSync(path.join(requestDir(), name), "utf8").trim().split("\n"));
  const keys = lines.map((line) => { const r = JSON.parse(line); return r.kind + r.id; });
  check("会话文件被重写后流水里没有重复行", new Set(keys).size === keys.length, `${keys.length} 行`);
  check("被重写掉的请求仍然留在流水里（花过的就是花过了）", all().rows.length === page.rows.length);

  /* ---------------- 通知 ---------------- */
  const now = base + 12 * 60_000;
  const alerts = recentAlerts(scan.records, now);
  check("只通知最近 15 分钟内不一致 / 存疑的", alerts.length === 3 && alerts.every((row) => row.status !== "match"), alerts.map((a) => a.status).join(","));
  check("几个月前补进来的历史不通知", recentAlerts(scan.records, base + 90 * 86_400_000).length === 0);

  /* ---------------- 按项目汇总（0.3.9 用量明细「按项目」） ---------------- */
  {
    const { appendRequests } = require(path.join(build, "request-log.js"));
    const day = new Date(2026, 10, 3, 9, 0).getTime();
    const rec = (id, extra) => ({ id, at: day + Number(id.slice(1)) * 60_000, input: 1000, output: 100, cacheRead: 500, cacheWrite: 0, reasoning: 20, costUsd: 0, calls: 1, ...extra });
    appendRequests([
      rec("p1", { kind: "claude-code", file: path.join(root, "A.jsonl"), cwd: "D:\\Work\\Alpha", model: "claude-opus-5-5", effort: "high" }),
      rec("p2", { kind: "claude-code", file: path.join(root, "A.jsonl"), cwd: "d:/work/alpha/", model: "claude-opus-5-5", effort: "high" }),
      rec("p3", { kind: "codex", file: path.join(root, "rollout-2026-11-03T00-00-00-b.jsonl"), cwd: "D:\\Work\\Alpha", model: "gpt-6-astra", compaction: true, input: 200000, cacheRead: 150000 }),
      rec("p4", { kind: "grok-build", file: path.join(root, "s1", "updates.jsonl"), cwd: "D:\\Work\\Beta", model: "grok-4.7-build", effort: "low", calls: 3 }),
      rec("p5", { kind: "codex", file: path.join(root, "rollout-2026-11-03T00-00-00-c.jsonl"), model: "gpt-6-astra", effort: "medium" }),
    ]);
    const page = queryRequests({ from: "2026-11-03", to: "2026-11-03", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 1, projects: true });
    const alpha = page.projects?.find((p) => p.key === "d:\\work\\alpha");
    check("按项目：大小写 / 斜杠 / 末尾斜杠不同的同一目录归成一个项目，没目录的单独一组", page.projects?.length === 3 && page.projects.some((p) => p.cwd === "" && p.records === 1), JSON.stringify(page.projects?.map((p) => [p.key, p.records])));
    check("按项目：Token 最多的排第一，对话数按会话文件去重", page.projects[0] === alpha && alpha.sessions === 2 && alpha.records === 3, JSON.stringify(alpha && { sessions: alpha.sessions, records: alpha.records }));
    check(
      "按项目：Agent 分布、模型 × 思考等级组合、未记录等级、压缩上下文估算",
      alpha.agents.map((a) => `${a.source}:${a.sessions}`).join(",") === "Codex CLI:1,Claude Code:1" &&
        alpha.combos.some((c) => c.model === "claude-opus-5-5" && c.effort === "high" && c.records === 2 && c.tokens === 2200) &&
        alpha.combos.some((c) => c.model === "gpt-6-astra" && c.effort === "unknown") &&
        alpha.compaction.count === 1 && alpha.compaction.tokens === 200100,
      JSON.stringify({ agents: alpha.agents, combos: alpha.combos, compaction: alpha.compaction }),
    );
    const beta = page.projects.find((p) => p.key === "d:\\work\\beta");
    check("按项目：调用次数按模型调用算（Grok 一轮多次）", beta.requests === 3 && beta.records === 1, JSON.stringify(beta));
    const filtered = queryRequests({ from: "2026-11-03", to: "2026-11-03", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 50, project: "D:/WORK/Alpha" });
    check("项目筛选用同一套归并：换个写法也能筛出这个项目的全部请求", filtered.total === 3, String(filtered.total));
    const compactRow = filtered.rows.find((r) => r.compaction);
    check("压缩上下文估算行：核验为无法核验并说明原因", compactRow?.status === "unverified" && /压缩上下文/.test(compactRow.reasons.join("")), JSON.stringify(compactRow && { status: compactRow.status, reasons: compactRow.reasons }));
    const withoutFlag = queryRequests({ from: "2026-11-03", to: "2026-11-03", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 1 });
    check("不要 projects 时不附带项目汇总", withoutFlag.projects === undefined);

    // 周额度：官方周额度 10% → 13% 这一段里本机两个项目都有请求，涨幅按用量分给它们（没定价的型号按 Token）；
    // 没有后续采样的请求不折算。
    const q0 = new Date(2026, 10, 4, 9, 0).getTime();
    const gammaFile = path.join(root, "gamma.jsonl"), deltaFile = path.join(root, "delta.jsonl");
    const rollupFile = path.join(process.env.TOKENPULSE_DATA_DIR, "usage-rollups.json");
    const rollups = JSON.parse(fs.readFileSync(rollupFile, "utf8"));
    for (const file of [gammaFile, deltaFile]) rollups.files[file] = { size: 0, mtimeMs: 0, offset: 0, days: {}, kind: "codex", official: true };
    fs.writeFileSync(rollupFile, JSON.stringify(rollups));
    const weekReset = new Date(q0 + 5 * 86_400_000).toISOString();
    fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, "quota-history.json"), JSON.stringify({ version: 1, accounts: { chatgpt: [
      { at: q0, week: 10, weekReset, account: "chatgpt:qa" },
      { at: q0 + 10 * 60_000, week: 13, weekReset, account: "chatgpt:qa" },
    ] } }));
    const qrec = (id, file, cwd, input, minute) => ({ id, at: q0 + minute * 60_000, kind: "codex", file, cwd, model: "qa-unpriced-model", accountRef: "qa", input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, calls: 1 });
    appendRequests([qrec("q1", gammaFile, "D:\\Work\\Gamma", 3000, 3), qrec("q2", deltaFile, "D:\\Work\\Delta", 1000, 6), qrec("q3", gammaFile, "D:\\Work\\Gamma", 5000, 40)]);
    const quotaPage = queryRequests({ from: "2026-11-04", to: "2026-11-04", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 1, projects: true });
    const gamma = quotaPage.projects.find((p) => p.key === "d:\\work\\gamma"), delta = quotaPage.projects.find((p) => p.key === "d:\\work\\delta");
    check(
      "按项目周额度：同期涨幅按用量分摊，没有后续采样的不折算",
      Math.abs(gamma.quota.week - 2.25) < 1e-9 && Math.abs(delta.quota.week - 0.75) < 1e-9 && gamma.quota.officialTokens === 8000 && gamma.quota.attributedTokens === 3000,
      JSON.stringify({ gamma: gamma.quota, delta: delta.quota }),
    );
    // 只看 Gamma：分母仍是同期全部官方请求，筛选不会把涨幅全算到剩下的项目上
    const onlyGamma = queryRequests({ from: "2026-11-04", to: "2026-11-04", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 1, projects: true, project: "D:\\Work\\Gamma" });
    check("按项目周额度：筛选后分母不变", onlyGamma.projects.length === 1 && Math.abs(onlyGamma.projects[0].quota.week - 2.25) < 1e-9, JSON.stringify(onlyGamma.projects.map((p) => p.quota)));
  }

  {
    const { appendRequests, compactRequests } = require(path.join(build, "request-log.js"));
    const when = new Date(2025, 3, 10, 12).getTime();
    const make = (id, cwd) => ({ id, at: when, kind: "codex", file: "rollout-boundary.jsonl", cwd, model: "qa", input: 2, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, calls: 1 });
    const file = path.join(requestDir(), "2025-04.jsonl");
    const original = make("utf8", "测试🙂");
    const line = JSON.stringify(original);
    const prefix = Buffer.byteLength(line.slice(0, line.indexOf("测")), "utf8");
    fs.writeFileSync(file, " ".repeat(256 * 1024 - prefix - 2) + "\n" + line + "\n" + '{"id":"interrupted"');
    fs.writeFileSync(path.join(requestDir(), "2025-03.jsonl"), '{"id":"incomplete"');
    appendRequests([make("replayed", "恢复"), make("after", "下一条")]);
    compactRequests();
    const result = queryRequests({ from: "2025-04-10", to: "2025-04-10", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 20 });
    check("流水块边界跨 UTF-8 字节时保留原目录", result.rows.some((row) => row.cwd === original.cwd));
    check("流水断尾后的第一条重放记录可查询", result.rows.some((row) => row.cwd === "恢复") && result.rows.length === 3);
    check("首月只有断尾时回溯到首条有效流水", result.firstAt === when);
  }

  /* ---------------- 精确到小时和分钟的查询边界 ---------------- */
  {
    const { appendRequests } = require(path.join(build, "request-log.js"));
    const at = (h, m, s) => new Date(2026, 5, 15, h, m, s, 0).getTime();
    const rec = (id, when, model, cwd, input) => ({ id, at: when, kind: "claude-code", file: path.join(root, `hm-${id}.jsonl`), cwd, model, input, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, calls: 1 });
    appendRequests([
      rec("hm-before", at(9, 14, 59), "m-before", "D:\\Work\\Before", 1000),
      rec("hm-start", at(9, 15, 0), "m-in-1", "D:\\Work\\Inside", 2000),
      rec("hm-end", at(10, 30, 59), "m-in-2", "D:\\Work\\Inside", 3000),
      rec("hm-after", at(10, 31, 0), "m-after", "D:\\Work\\After", 4000),
    ]);
    const since = new Date(2026, 5, 15, 9, 15, 0, 0).getTime();
    const until = new Date(2026, 5, 15, 10, 30, 59, 999).getTime();
    const page = queryRequests({ from: "2026-06-15", to: "2026-06-15", since, until, source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 20, aggregate: true, projects: true, cache: true });
    check(
      "精确时分查询：包含起止分钟边界（含结束分钟的 59 秒），排除前后相邻分钟",
      page.total === 2 &&
        page.rows.map((r) => r.model).sort().join(",") === "m-in-1,m-in-2" &&
        page.aggregate.rows.reduce((n, r) => n + r.tokens, 0) === 5200 &&
        page.aggregate.hours.length === 2 &&
        page.projects.length === 1 &&
        page.projects[0].cwd === "D:\\Work\\Inside" &&
        page.cache.totals.input === 5000,
      JSON.stringify({ total: page.total, models: page.rows.map((r) => r.model), agg: page.aggregate.rows.length, hours: page.aggregate.hours.length, projects: page.projects.length, cacheInput: page.cache.totals.input }),
    );
  }

  /* ---------------- v0.3.106：上下文水位、自动连跑、按会话排行、费用拆分与三种新排序 ---------------- */
  {
    const { appendRequests } = require(path.join(build, "request-log.js"));
    const { contextWindowOf } = require(path.join(build, "model-pricing.js"));
    check(
      "上下文窗口推断：显式 [1m]、Claude 超 200K 自动升 1M、GPT-6 400K、Gemini 1M、DeepSeek 128K、未知型号返回 null",
      contextWindowOf("claude-sonnet-4-6", "claude-sonnet-4-6[1m]", 50_000) === 1_000_000 &&
        contextWindowOf("claude-opus-5-5", "claude-opus-5-5", 120_000) === 200_000 &&
        contextWindowOf("claude-opus-5-5", "claude-opus-5-5", 250_000) === 1_000_000 &&
        contextWindowOf("gpt-6-astra", "gpt-6-astra", 80_000) === 400_000 &&
        contextWindowOf("gemini-4-argon", "gemini-4-argon", 40_000) === 1_000_000 &&
        contextWindowOf("deepseek-chat", "deepseek-chat", 20_000) === 128_000 &&
        contextWindowOf("custom-unknown-xyz", "custom-unknown-xyz", 10_000) === null,
    );

    const sDay = new Date(2026, 6, 20, 10, 0).getTime();
    const sessAFile = path.join(root, "sess-alpha.jsonl");
    const sessBFile = path.join(root, "sess-beta.jsonl");
    const rollupFile = path.join(process.env.TOKENPULSE_DATA_DIR, "usage-rollups.json");
    const rollups = JSON.parse(fs.readFileSync(rollupFile, "utf8"));
    rollups.files[sessAFile] = { size: 0, mtimeMs: 0, offset: 0, days: {}, kind: "claude-code", official: true };
    rollups.files[sessBFile] = { size: 0, mtimeMs: 0, offset: 0, days: {}, kind: "claude-code", official: false };
    fs.writeFileSync(rollupFile, JSON.stringify(rollups));
    fs.writeFileSync(
      path.join(process.env.TOKENPULSE_DATA_DIR, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        files: {
          [sessAFile]: {
            size: 100,
            mtimeMs: 1,
            summary: { key: "claude:sess-alpha", kind: "claude", id: "sess-alpha", title: "重构缓存分析面板", cwd: "D:\\Work\\Pulse", file: sessAFile, startedAt: sDay, updatedAt: sDay + 180_000, turns: 2, messages: 8 },
          },
          [sessBFile]: {
            size: 100,
            mtimeMs: 1,
            summary: { key: "claude:sess-beta", kind: "claude", id: "sess-beta", title: "排查慢接口首字延迟", cwd: "D:\\Work\\Pulse", file: sessBFile, startedAt: sDay, updatedAt: sDay + 240_000, turns: 1, messages: 3 },
          },
        },
      }),
    );

    appendRequests([
      { id: "v106-1", at: sDay + 10_000, kind: "claude-code", file: sessAFile, accountRef: "qa", cwd: "D:\\Work\\Pulse", model: "claude-opus-5-5", requested: "claude-opus-5-5", returned: "claude-opus-5-5", input: 160_000, output: 2000, cacheRead: 144_000, cacheWrite: 0, reasoning: 1200, costUsd: 0.8, calls: 1, autoStep: 9, timing: { stream: true, ms: 4200, firstTokenMs: 600, tokensPerSec: 55 } },
      { id: "v106-2", at: sDay + 20_000, kind: "claude-code", file: sessAFile, accountRef: "qa", cwd: "D:\\Work\\Pulse", model: "claude-opus-5-5", compaction: true, input: 190_000, output: 800, cacheRead: 180_000, cacheWrite: 0, reasoning: 0, costUsd: 0.4, calls: 1 },
      { id: "v106-3", at: sDay + 30_000, kind: "claude-code", file: sessBFile, cwd: "D:\\Work\\Pulse", model: "claude-sonnet-4-6", requested: "claude-sonnet-4-6", returned: "claude-sonnet-4-6", input: 220_000, output: 1000, cacheRead: 11_000, cacheWrite: 0, reasoning: 200, costUsd: 0.75, calls: 1, autoStep: 2, timing: { stream: true, ms: 18_500, firstTokenMs: 6200, tokensPerSec: 28 } },
      { id: "v106-4", at: sDay + 40_000, kind: "claude-code", file: sessBFile, cwd: "D:\\Work\\Pulse", model: "claude-sonnet-4-6", requested: "claude-sonnet-4-6", returned: "claude-sonnet-4-6", input: 1200, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.01, calls: 1 },
    ]);

    const baseQ = { from: "2026-07-20", to: "2026-07-20", source: "all", status: "all", search: "", page: 0, pageSize: 20 };
    const overview106 = queryRequests({ ...baseQ, sort: "time", aggregate: true, sessions: true });
    const row1 = overview106.rows.find((r) => r.key.endsWith("v106-1"));
    check(
      "请求行附带 sessionKey / sessionTitle / contextLimit / autoStep",
      row1?.sessionKey === "claude:sess-alpha" && row1?.sessionTitle === "重构缓存分析面板" && row1?.contextLimit === 200_000 && row1?.autoStep === 9,
      JSON.stringify(row1 && { sessionKey: row1.sessionKey, sessionTitle: row1.sessionTitle, contextLimit: row1.contextLimit, autoStep: row1.autoStep }),
    );
    const sumField = (rows, k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
    check(
      "汇总拆分官方订阅等价与 API 按量实付费用",
      Math.abs(sumField(overview106.aggregate.rows, "officialCostUsd") - 1.2) < 1e-8 &&
        Math.abs(sumField(overview106.aggregate.rows, "apiCostUsd") - 0.76) < 1e-8,
      JSON.stringify(overview106.aggregate.rows),
    );
    const alphaSess = overview106.sessions?.find((s) => s.sessionKey === "claude:sess-alpha");
    check(
      "按会话排行：聚合峰值上下文、窗口上限、压缩次数与最长连续自动轮次",
      overview106.sessions?.length === 2 &&
        alphaSess?.peakInput === 190_000 &&
        alphaSess?.contextLimit === 200_000 &&
        alphaSess?.compactions === 1 &&
        alphaSess?.maxAutoStep === 9,
      JSON.stringify(overview106.sessions),
    );
    const filteredSess = queryRequests({ ...baseQ, sort: "time", session: "claude:sess-beta" });
    const filteredSessShort = queryRequests({ ...baseQ, sort: "time", session: "sess-beta" });
    check("同会话筛选支持 sessionKey 与原始 session ID", filteredSess.total === 2 && filteredSessShort.total === 2 && filteredSess.rows.every((r) => r.sessionKey === "claude:sess-beta"), String(filteredSess.total));

    const cacheLow = queryRequests({ ...baseQ, sort: "cache_low" });
    check(
      "按缓存命中率从低到高（仅看 >= 4096 大输入）：排除小输入，5% 排第一",
      cacheLow.total === 3 && cacheLow.rows[0].key.endsWith("v106-3") && cacheLow.rows.every((r) => r.input >= 4096),
      JSON.stringify(cacheLow.rows.map((r) => [r.key, r.input, r.cacheRead])),
    );
    const latencySorted = queryRequests({ ...baseQ, sort: "latency" });
    check(
      "按耗时 / 首字延迟从慢到快：最慢排第一，无测速记录排最后",
      latencySorted.rows[0].key.endsWith("v106-3") && latencySorted.rows[1].key.endsWith("v106-1") && !latencySorted.rows.at(-1).timing,
      JSON.stringify(latencySorted.rows.map((r) => [r.key, r.timing?.ms ?? null])),
    );
    const quotaSorted = queryRequests({
      ...baseQ,
      sort: "quota",
      quotaWindows: [{ account: "claude:qa", startAt: sDay, endAt: sDay + 60_000, fiveTokens: 1_000_000, weekTokens: 5_000_000 }],
    });
    check(
      "按额度占用从高到低：尽管 API 请求 v106-3 Token 更大（221K），官方有额度占用的 v106-2 / v106-1 仍排最前",
      quotaSorted.rows[0].key.endsWith("v106-2") && quotaSorted.rows[1].key.endsWith("v106-1") && quotaSorted.rows[2].key.endsWith("v106-3"),
      JSON.stringify(quotaSorted.rows.map((r) => [r.key, r.quotaPct ?? null])),
    );

    // v0.3.108：子代理 / Swarm 元信息透传至请求行与按会话排行，并支持按 agentName / swarmTitle 搜索及 DeepSeek session- 前缀兼容
    const subDay = new Date(2026, 6, 21, 10, 0).getTime();
    const agyWorkerFile = path.join(root, "antigravity", "conversations", "12345678-1111-4000-8000-000000000099.db");
    const claudeSubFile = path.join(root, "claude", "projects", "D--Pulse", "parent-1", "subagents", "agent-sub9.jsonl");
    const dshFile = path.join(root, "dsh", "sessions", "Pulse", "session-dsh-1", "session.v4.jsonl.zstd");
    fs.writeFileSync(
      path.join(process.env.TOKENPULSE_DATA_DIR, "sessions-index.json"),
      JSON.stringify({
        version: 10,
        files: {
          [agyWorkerFile]: {
            size: 100,
            mtimeMs: 2,
            summary: {
              key: "antigravity:12345678-1111-4000-8000-000000000099",
              kind: "antigravity",
              id: "12345678-1111-4000-8000-000000000099",
              title: "audit-worker · 核验缓存",
              isSubagent: true,
              parentKey: "antigravity:12345678-1111-4000-8000-000000000000",
              agentName: "audit-worker",
              subagentKind: "swarm",
              swarmTitle: "架构审查蜂群",
            },
          },
          [claudeSubFile]: {
            size: 100,
            mtimeMs: 2,
            summary: {
              key: "claude:agent-sub9",
              kind: "claude",
              id: "agent-sub9",
              title: "搜索依赖图",
              isSubagent: true,
              parentKey: "claude:parent-1",
              agentName: "Explore",
              subagentKind: "subagent",
            },
          },
          [dshFile]: {
            size: 100,
            mtimeMs: 2,
            summary: {
              key: "deepseek:session-dsh-1",
              kind: "deepseek",
              id: "session-dsh-1",
              title: "DeepSeek 审查",
            },
          },
        },
      }),
    );
    appendRequests([
      { id: "v108-agy", at: subDay + 1000, kind: "antigravity", file: agyWorkerFile, cwd: "D:\\Work\\Pulse", model: "gemini-4-argon", input: 5000, output: 400, cacheRead: 3000, cacheWrite: 0, reasoning: 100, costUsd: 0.02, calls: 1 },
      { id: "v108-claude", at: subDay + 2000, kind: "claude-code", file: claudeSubFile, cwd: "D:\\Work\\Pulse", model: "claude-opus-5-5", input: 4000, output: 300, cacheRead: 2000, cacheWrite: 0, reasoning: 0, costUsd: 0.03, calls: 1 },
      { id: "v108-dsh", at: subDay + 3000, kind: "deepseek-harness", file: dshFile, cwd: "D:\\Work\\Pulse", model: "DeepSeek-V4.1-Flash", input: 3000, output: 200, cacheRead: 1000, cacheWrite: 0, reasoning: 0, costUsd: 0.01, calls: 1 },
    ]);
    const subPage = queryRequests({ from: "2026-07-21", to: "2026-07-21", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 20, sessions: true });
    const agyRow = subPage.rows.find((r) => r.key.endsWith("v108-agy"));
    const agySess = subPage.sessions.find((s) => s.sessionKey === "antigravity:12345678-1111-4000-8000-000000000099");
    check(
      "子代理/Swarm 请求行与按会话排行透传 isSubagent / parentKey / agentName / subagentKind / swarmTitle",
      agyRow?.isSubagent === true &&
        agyRow?.parentKey === "antigravity:12345678-1111-4000-8000-000000000000" &&
        agyRow?.agentName === "audit-worker" &&
        agyRow?.subagentKind === "swarm" &&
        agyRow?.swarmTitle === "架构审查蜂群" &&
        agySess?.isSubagent === true &&
        agySess?.subagentKind === "swarm" &&
        agySess?.agentName === "audit-worker" &&
        agySess?.swarmTitle === "架构审查蜂群",
      JSON.stringify({ agyRow, agySess }),
    );
    const byAgentName = queryRequests({ from: "2026-07-21", to: "2026-07-21", source: "all", status: "all", search: "audit-worker", sort: "time", page: 0, pageSize: 20 });
    const bySwarmTitle = queryRequests({ from: "2026-07-21", to: "2026-07-21", source: "all", status: "all", search: "架构审查蜂群", sort: "time", page: 0, pageSize: 20 });
    check("请求搜索支持按 agentName 与 swarmTitle 命中", byAgentName.total === 1 && bySwarmTitle.total === 1);
    const dshRow = subPage.rows.find((r) => r.key.endsWith("v108-dsh"));
    const dshByShort = queryRequests({ from: "2026-07-21", to: "2026-07-21", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 20, session: "dsh-1" });
    const dshByFullKey = queryRequests({ from: "2026-07-21", to: "2026-07-21", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 20, session: "deepseek:session-dsh-1" });
    const dshByPrefix = queryRequests({ from: "2026-07-21", to: "2026-07-21", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 20, session: "session-dsh-1" });
    check(
      "DeepSeek 会话键保留 session- 前缀并兼容短 ID / 完整 key 筛选",
      dshRow?.session === "dsh-1" && dshRow?.sessionKey === "deepseek:session-dsh-1" && dshByShort.total === 1 && dshByFullKey.total === 1 && dshByPrefix.total === 1,
      JSON.stringify({ session: dshRow?.session, sessionKey: dshRow?.sessionKey, totals: [dshByShort.total, dshByFullKey.total, dshByPrefix.total] }),
    );
  }

  /* ---------------- 额度归属 ---------------- */
  const { buildSnapshot } = require(path.join(build, "report.js"));
  const claude = buildSnapshot(now);
  check("流水里只记元数据：没有会话正文字段", lines.every((line) => !/"content"|"message"/.test(line)));
  check("快照照常生成", Array.isArray(claude.usage) && readRollups().files);
} catch (error) {
  console.error(error);
  results.push(false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
assert.equal(passed, results.length);
