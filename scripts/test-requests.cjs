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
    const forwarded = (returnedModel, responseId = codexId) => { fs.mkdirSync(ledger.routeLogDir(), { recursive: true }); fs.writeFileSync(logFile, JSON.stringify({ at: base, app: "codex", pass: true, status: 200, requestModel: "gpt-6-astra", responseId, returnedModel }) + "\n"); ledger.resetRouteLedgerCache(); };
    const codexNow = () => all().rows.find((row) => row.source === "Codex CLI");
    forwarded("gpt-6-astra-2026-09-01");
    check("Codex 经 TokenPulse 转发：返回型号对得上 → 型号一致", codexNow()?.status === "match" && codexNow()?.returned === "gpt-6-astra-2026-09-01" && codexNow()?.reasons.some((text) => text.includes("经 TokenPulse 转发")), JSON.stringify(codexNow()?.reasons));
    forwarded("gpt-6-mini");
    check("Codex 经 TokenPulse 转发：上游回的是别的型号 → 型号不一致", codexNow()?.status === "mismatch" && codexNow()?.reasons[0] === "请求的是 gpt-6-astra，上游返回的是 gpt-6-mini", codexNow()?.reasons[0]);
    check("新请求提醒也用得上", recentAlerts(scan.records, base + 60_000, 3_600_000).some((row) => row.source === "Codex CLI" && row.status === "mismatch"));
    forwarded("gpt-6-mini", "resp_" + "d".repeat(50));
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
