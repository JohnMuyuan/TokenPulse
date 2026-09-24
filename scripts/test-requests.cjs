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
  ...extra,
});
const all = (extra = {}) => queryRequests({ from: "2026-01-01", to: "2026-12-31", source: "all", status: "all", search: "", sort: "time", page: 0, pageSize: 50, all: true, ...extra });

try {
  /* ---------------- 纯规则 ---------------- */
  check("[1m]、日期后缀、Bedrock 前缀、Grok 的 -build 都算同一型号",
    normalizeModel("claude-opus-5[1m]") === "claude-opus-5" &&
    normalizeModel("claude-opus-4-8-20260315") === "claude-opus-4-8" &&
    normalizeModel("us.anthropic.claude-opus-4-8-v1:0") === "claude-opus-4-8" &&
    normalizeModel("grok-4.6-build") === "grok-4.6");
  check("不会把 gpt-5 和 gpt-5.4 当成同一个（不做模糊包含）", normalizeModel("gpt-5") !== normalizeModel("gpt-5.4"));
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
    { timestamp: at(1), type: "turn_context", payload: { model: "gpt-6-astra" } },
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
  check("Grok：请求 grok-4.6、返回 grok-4.5-fast → 型号不一致", grokRows[1]?.status === "mismatch");
  check("Grok 的工作目录从目录名解出来", grokRows[0]?.cwd === "D:\\work\\grok", grokRows[0]?.cwd);
  const codexRow = page.rows.find((row) => row.source === "Codex CLI");
  check("Codex：请求型号来自 turn_context、工作目录来自 session_meta", codexRow?.requested === "gpt-6-astra" && codexRow?.cwd === "D:\\work\\codex" && codexRow.status === "unverified");
  check("核验计数", page.counts.mismatch === 2 && page.counts.suspect === 1, JSON.stringify(page.counts));

  /* ---------------- 查询 ---------------- */
  check("按核验结论筛选，顶部计数不受影响", all({ status: "mismatch" }).rows.length === 2 && all({ status: "mismatch" }).counts.all === page.counts.all);
  check("按工具筛选", all({ source: "Codex CLI" }).rows.length === 1);
  check("关键词能搜到项目和型号", all({ search: "demo" }).rows.every((row) => row.source === "Claude Code") && all({ search: "grok-4.5" }).rows.length === 1);
  check("日期范围之外的不返回", all({ from: "2026-09-21", to: "2026-09-30" }).rows.length === 0);
  const paged = queryRequests({ from: "2026-01-01", to: "2026-12-31", source: "all", status: "all", search: "", sort: "time", page: 1, pageSize: 3 });
  check("分页", paged.rows.length === 3 && paged.pages === 3 && paged.page === 1);
  check("费用：Grok 用自报的，Claude 按单价估", grokRows[0].costUsd === 0.001 && byId[official(10)].costUsd > 0);

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
