/**
 * 后端审计回归（Round 5 · Part 2）：会话解析/搜索、用量扫描/混合计费/报告、定价、DeepSeek 分析、缓存分析、请求流水、周报、模型目录、分享卡片、SVG 消毒、活跃扫描、日志与 prefs。
 * 跑法：node scripts/test-audit-r5-usage-main.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-audit-r5b-"));
process.env.HOME = process.env.USERPROFILE = path.join(root, "home");
process.env.TOKENPULSE_DATA_DIR = path.join(root, "data");
process.env.TOKENPULSE_DSH_HOME = path.join(root, "dsh");
process.env.PI_CODING_AGENT_DIR = path.join(root, "pi");
process.env.TOKENPULSE_ANTIGRAVITY_DIR = path.join(root, "agy");
for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME"]) delete process.env[key];
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });

const { parseSessionFile, listSessions, getSession } = require("../build/core/sessions.js");
const { addUsage, emptyBucket, scanLocalUsage, readRollups, writeRollups } = require("../build/core/usage-scan.js");
const { buildSnapshot } = require("../build/core/report.js");
const { searchSessions } = require("../build/core/session-search.js");
const { exitGuardScript, terminalScript } = require("../build/main/session-reply.js");
const { priceOf, estimateCost } = require("../build/core/model-pricing.js");
const { analyzeDeepSeek, setDeepSeekMark, readDeepSeekMarks } = require("../build/core/deepseek-insight.js");
const { analyzeCache } = require("../build/core/cache-analysis.js");
const { appendRequests, queryRequests } = require("../build/core/request-log.js");
const { weeklyDue, maybeWeeklySummary, readWeeklyState } = require("../build/core/weekly-summary.js");
const { modelCandidates } = require("../build/core/model-catalog.js");
const { milestoneState } = require("../build/core/share-report.js");
const { sanitizeCss, sanitizeSvg } = require("../build/core/svg-sanitize.js");
const { ActivityScanner } = require("../build/core/agent-activity.js");
const { appendRouteLog, resetRouteLedgerCache } = require("../build/core/route-ledger.js");
const { writeJson } = require("../build/core/paths.js");
const { readPrefs } = require("../build/main/prefs.js");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("PASS " + name);
  } catch (err) {
    failed += 1;
    console.error("FAIL " + name + ": " + (err && err.stack ? err.stack : err));
  }
}

(async () => {
  try {
    // 1. sessions.ts: Codex response_id ordering + Builder.chunk single truncation suffix + stale index version guard
    await check("sessions.ts fixes Codex response_id ordering, Builder.chunk truncation, and stale index version", () => {
      const codexDir = path.join(process.env.HOME, ".codex", "sessions", "2026-10-10");
      fs.mkdirSync(codexDir, { recursive: true });
      const codexFile = path.join(codexDir, "rollout-2026-10-10T10-00-00-cid1.jsonl");
      const baseAt = Date.UTC(2026, 9, 10, 10, 0, 0);
      // Record route timing for resp-turn-1 so Tier 1 lookup verifies response_id landed on turn 1 assistant (NOT turn 2)
      appendRouteLog({ at: baseAt + 2000, app: "codex", provider: "QA", status: 200, ms: 777, firstTokenMs: 123, tokensPerSec: 88, input: 100, output: 50, returnedModel: "gpt-5.4", responseId: "resp-turn-1" });
      resetRouteLedgerCache();
      fs.writeFileSync(codexFile, [
        { timestamp: new Date(baseAt).toISOString(), type: "session_meta", payload: { id: "cid1", cwd: root } },
        { timestamp: new Date(baseAt + 500).toISOString(), type: "turn_context", payload: { model: "gpt-5.4" } },
        { timestamp: new Date(baseAt + 1000).toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "turn one" }] } },
        { timestamp: new Date(baseAt + 2000).toISOString(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer one" }] } },
        // token_usage_record arrives AFTER assistant message in turn 1
        { timestamp: new Date(baseAt + 2010).toISOString(), type: "token_usage_record", payload: { response_id: "resp-turn-1", usage: { input_tokens: 100, output_tokens: 50 } } },
        // turn 2 has no response_id in route log
        { timestamp: new Date(baseAt + 10000).toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "turn two" }] } },
        { timestamp: new Date(baseAt + 15000).toISOString(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer two" }] } },
      ].map((r) => JSON.stringify(r)).join("\n") + "\n");
      const parsed = parseSessionFile("codex", codexFile);
      assert.ok(parsed);
      const assistants = parsed.messages.filter((m) => m.role === "assistant");
      assert.equal(assistants.length, 2);
      assert.equal(assistants[0].durationMs, 777, "turn 1 assistant received post-hoc response_id Tier-1 latency");
      assert.equal(assistants[0].latencyEstimated, false);
      assert.notEqual(assistants[1].durationMs, 777, "turn 2 assistant did not inherit turn 1 response_id");

      // Builder.chunk long streaming message emits exactly one truncation suffix with accurate count
      const grokDir = path.join(process.env.HOME, ".grok", "sessions", "D%3A%5Cqa", "grok-long");
      fs.mkdirSync(grokDir, { recursive: true });
      const grokFile = path.join(grokDir, "updates.jsonl");
      const lines = [
        { timestamp: 1760090400, params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } } } },
        { timestamp: 1760090401, params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A".repeat(30_000) } } } },
        { timestamp: 1760090402, params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "B".repeat(15_000) } } } },
        { timestamp: 1760090403, params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "C".repeat(5_000) } } } },
      ];
      fs.writeFileSync(grokFile, lines.map((r) => JSON.stringify(r)).join("\n") + "\n");
      const parsedGrok = parseSessionFile("grok", grokFile);
      assert.ok(parsedGrok);
      const longMsg = parsedGrok.messages.find((m) => m.role === "assistant");
      const suffixMatches = longMsg.text.match(/…（已截断 \d+ 个字符）/g) || [];
      assert.equal(suffixMatches.length, 1, "exactly one truncation suffix");
      assert.equal(suffixMatches[0], "…（已截断 10000 个字符）", "exact omitted character count (50000 - 40000)");

      // Stale index version is ignored by filesOf/getSession (forces rebuild via listSessions)
      fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, "sessions-index.json"), JSON.stringify({ version: 1, files: { "/nonexistent/fake.jsonl": { size: 1, mtimeMs: 1, summary: { kind: "codex", id: "cid1", updatedAt: 9e12 } } } }));
      const detail = getSession("codex", "cid1");
      assert.ok(detail && detail.id === "cid1", "stale version index ignored and refreshed");
    });

    // 2. usage-scan & report: midnight-crossing Grok pool turn, DeepSeek turnStartAt cleared, mixed reported+unreported cost, cross-family filter
    await check("usage-scan & report fix midnight Grok pool split, DeepSeek turnStartAt, mixed cost, and cross-family filter", () => {
      // Mixed reported + unreported bucket
      const mix = emptyBucket();
      addUsage(mix, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 1.5, requests: 1 });
      addUsage(mix, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, requests: 1 });
      assert.ok(mix.unreported && mix.unreported.input === 1_000_000, "mixed bucket tracks unreported tokens");

      const pure = emptyBucket();
      addUsage(pure, { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, requests: 1 });
      assert.equal(pure.unreported, undefined, "pure unreported bucket does not bloat JSON");

      // Snapshot verifies mixed cost > 1.5 + cross-family model excluded from Codex/Grok official quota rows
      const now = Date.UTC(2026, 9, 12, 12, 0, 0);
      const day = new Date(now);
      const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      const hour = String(Math.floor(now / 3_600_000) * 3_600_000);
      writeRollups({
        version: 1,
        files: {
          "mixed.jsonl": {
            size: 1, mtimeMs: 1, offset: 1, kind: "codex", official: true,
            days: { [dayKey]: { "Codex CLI": { "gpt-5.4": mix } } },
            hours: { [hour]: { "gpt-5.4": pure, "deepseek-v4": { ...pure, input: 9_999_999 } } },
          },
        },
      });
      const snap = buildSnapshot(now);
      const row = snap.usage.find((u) => u.model === "gpt-5.4");
      const expected = 1.5 + estimateCost("gpt-5.4", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
      assert.ok(Math.abs(row.costUsd - expected) < 1e-6, `mixed cost ${row.costUsd} vs ${expected}`);
      assert.equal("unreported" in row, false, "unreported stripped from snapshot usage row");

      // DeepSeek turnStartAt cleared after consumption
      const dshSessDir = path.join(process.env.TOKENPULSE_DSH_HOME, "sessions", "proj", "session-dsh-t1");
      fs.mkdirSync(dshSessDir, { recursive: true });
      const t0 = Date.UTC(2026, 9, 12, 10, 0, 0);
      const dshData = [
        { type: "session", id: "dsh-t1", cwd: root, createdAt: new Date(t0).toISOString() },
        { type: "step/start", time: t0 },
        { type: "assistant/message", time: t0 + 2000, data: { message: { id: "m1", source: { model: "deepseek-chat" } }, stream: [{ time: t0 + 500 }, { time: t0 + 2000 }], usage: { inputTokens: 100, outputTokens: 20 } } },
        // Second assistant message has NO step/start before it
        { type: "assistant/message", time: t0 + 120000, data: { message: { id: "m2", source: { model: "deepseek-chat" } }, stream: [{ time: t0 + 119000 }, { time: t0 + 120000 }], usage: { inputTokens: 100, outputTokens: 20 } } },
      ].map((r) => JSON.stringify(r)).join("\n") + "\n";
      fs.writeFileSync(path.join(dshSessDir, "session.v4.jsonl.zstd"), zlib.zstdCompressSync(Buffer.from(dshData, "utf8")));
      const scan = scanLocalUsage();
      const dshRecs = scan.records.filter((r) => r.kind === "deepseek-harness").sort((a, b) => a.at - b.at);
      assert.equal(dshRecs.length, 2);
      assert.equal(dshRecs[0].timing.firstTokenMs, 500);
      assert.equal(dshRecs[1].timing.firstTokenMs, undefined, "second turn must not inherit stale turnStartAt");

      // Midnight-crossing Grok pool split
      const d1 = new Date(2026, 9, 14, 23, 55, 0).getTime();
      const d2 = new Date(2026, 9, 15, 0, 5, 0).getTime();
      const grokConfDir = path.join(process.env.HOME, ".grok");
      fs.mkdirSync(grokConfDir, { recursive: true });
      fs.writeFileSync(path.join(grokConfDir, "config.toml"), '[model.tokenpulse_route]\nbase_url = "http://127.0.0.1:17621/grok/v1"\n');
      appendRouteLog({ at: d1 + 60_000, app: "grok", provider: "pool", status: 200, ms: 500, input: 1000, output: 100, account: "grok:acc-a" });
      appendRouteLog({ at: d2 - 60_000, app: "grok", provider: "pool", status: 200, ms: 500, input: 1000, output: 100, account: "grok:acc-b" });
      resetRouteLedgerCache();
      const midDir = path.join(grokConfDir, "sessions", "D%3A%5Cqa", "mid-turn");
      fs.mkdirSync(midDir, { recursive: true });
      const midFile = path.join(midDir, "updates.jsonl");
      fs.writeFileSync(midFile, [
        { timestamp: d1 / 1000, params: { update: { sessionUpdate: "user_message_chunk", _meta: { modelId: "grok-4.6-build" }, content: { type: "text", text: "go" } } } },
        { timestamp: d2 / 1000, params: { update: { sessionUpdate: "turn_completed", prompt_id: "pm", usage: { modelUsage: { "grok-4.6-build": { inputTokens: 2000, outputTokens: 200, cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, costUsdTicks: 2e8, modelCalls: 2 } } } } } },
      ].map((r) => JSON.stringify(r)).join("\n") + "\n");
      scanLocalUsage();
      const midState = readRollups().files[midFile];
      assert.ok(midState && midState.days["2026-10-14"] && midState.days["2026-10-15"], "midnight-crossing pool turn splits days across both dates: " + JSON.stringify(Object.keys(midState?.days ?? {})));
    });

    // 3. model-pricing: grok-4.6-build / grok-4.7-build match base grok-4.6 / grok-4.7 instead of $0.20 fallback
    await check("model-pricing maps grok-4.6-build and grok-4.7-build to their base model prices", () => {
      const p46 = priceOf("grok-4.6");
      const p46b = priceOf("grok-4.6-build");
      const p47 = priceOf("grok-4.7");
      const p47b = priceOf("grok-4.7-build");
      assert.ok(p46 && p46b && p46b.input === p46.input && p46b.output === p46.output, `grok-4.6-build (${p46b?.input}) must match grok-4.6 (${p46?.input})`);
      assert.ok(p47 && p47b && p47b.input === p47.input && p47b.output === p47.output, `grok-4.7-build (${p47b?.input}) must match grok-4.7 (${p47?.input})`);
      assert.equal(priceOf("grok-build-custom")?.input, 0.2, "non-versioned grok-build still hits fallback");
    });

    // 4. deepseek-insight: multi-currency primary pick + setDeepSeekMark clears by `to`
    await check("deepseek-insight picks non-zero primary currency and clears fallback marks by to", () => {
      const now = Date.UTC(2026, 9, 12, 12, 0, 0);
      const samples = [
        { at: now - 3600_000, currency: "CNY", total: 50, granted: 0, toppedUp: 50 },
        { at: now - 3600_000, currency: "USD", total: 0, granted: 0, toppedUp: 0 },
        { at: now, currency: "CNY", total: 48, granted: 0, toppedUp: 48 },
        { at: now, currency: "USD", total: 0, granted: 0, toppedUp: 0 },
      ];
      const insight = analyzeDeepSeek({ accountId: "ds1", local: false, samples, rows: [], now });
      assert.equal(insight.currency, "CNY", "picks non-zero currency at latestAt instead of trailing 0-balance USD");

      const recentTo = Date.now() - 10_000;
      setDeepSeekMark("ds1", recentTo - 4000, recentTo, "off", "note");
      assert.equal(readDeepSeekMarks("ds1").length, 1);
      // Clear with shifted `from` but same `to`
      setDeepSeekMark("ds1", recentTo - 2000, recentTo, "auto");
      assert.equal(readDeepSeekMarks("ds1").length, 0, "mark cleared by matching `to`");
    });

    // 5. cache-analysis: sparse drop in later bucket reports insufficient instead of false volatile (0-1m)
    await check("cache-analysis reports insufficient when shorter buckets have zero samples", () => {
      const base = Date.UTC(2026, 9, 12, 12, 0, 0);
      // 4 consecutive rows spaced 20 minutes apart (bucket 3: 15-30m), 1 hit & 2 misses -> keepRate = 0.33 < 0.5, buckets 0-2 empty
      const mk = (i, cacheRead) => ({
        key: "k" + i, at: base + i * 20 * 60_000, source: "Claude Code", model: "claude-opus-5",
        session: "s1", input: 50_000, output: 100, cacheRead, cacheWrite: 0, reasoning: 0, tokens: 50_100, costUsd: 0.1, priced: true, calls: 1,
      });
      const res = analyzeCache([mk(0, 0), mk(1, 45_000), mk(2, 0), mk(3, 0)]);
      const m = res.retention.find((x) => x.model === "claude-opus-5");
      assert.ok(m, "model analyzed");
      assert.equal(m.status, "insufficient", "must not misclassify sparse 20m drops as 0-1m volatile");
      assert.equal(m.ttlMaxMs, null);
    });

    // 6. request-log: transitive cache_low sort comparator
    await check("request-log cache_low sort is strictly transitive and deterministic", () => {
      const base = Date.UTC(2026, 9, 15, 10, 0, 0);
      const recs = [
        { id: "cl1", at: base + 1000, kind: "codex", file: "f.jsonl", model: "gpt-5", input: 100_000, output: 10, cacheRead: 50_000, cacheWrite: 0, reasoning: 0, costUsd: 0, calls: 1 },
        { id: "cl2", at: base + 2000, kind: "codex", file: "f.jsonl", model: "gpt-5", input: 10_000, output: 10, cacheRead: 5_001, cacheWrite: 0, reasoning: 0, costUsd: 0, calls: 1 },
        { id: "cl3", at: base + 3000, kind: "codex", file: "f.jsonl", model: "gpt-5", input: 50_000, output: 10, cacheRead: 25_008, cacheWrite: 0, reasoning: 0, costUsd: 0, calls: 1 },
      ];
      appendRequests(recs);
      const page = queryRequests({ from: "2026-10-15", to: "2026-10-15", source: "all", status: "all", search: "", sort: "cache_low", page: 0, pageSize: 20 });
      assert.deepEqual(page.rows.map((r) => r.key), ["codex\u0000cl1", "codex\u0000cl2", "codex\u0000cl3"]);
    });

    // 7. weekly-summary: defers when scannedAt < Monday 00:00
    await check("weekly-summary defers when scannedAt predates Monday 00:00", () => {
      const mon9am = new Date(2026, 5, 8, 9, 5).getTime();
      const sun23pm = new Date(2026, 5, 7, 23, 30).getTime();
      const mon01am = new Date(2026, 5, 8, 1, 0).getTime();
      assert.equal(weeklyDue(mon9am, null, true, sun23pm), null, "stale Sunday scannedAt defers");
      assert.equal(weeklyDue(mon9am, null, true, mon01am), "2026-06-01", "fresh Monday scannedAt triggers");

      let notified = 0;
      const deferred = maybeWeeklySummary({ now: mon9am, scannedAt: sun23pm, usage: [], enabled: true, notify: () => { notified++; }, openPage: () => {} });
      assert.equal(deferred, null);
      assert.equal(readWeeklyState(), null, "deferred check must not write weekly-summary.json");
      assert.equal(notified, 0);
    });

    // 8. model-catalog: preserves Codex models_cache.json efforts + share-report DST shiftDay + session-reply env var guard
    await check("model-catalog keeps cache efforts, share-report handles DST, session-reply supports env allowlist", () => {
      const codexDir = path.join(process.env.HOME, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(path.join(codexDir, "models_cache.json"), JSON.stringify({
        fetched_at: "2026-10-10",
        models: [{ slug: "gpt-custom-cache-only", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }] }],
      }));
      const cands = modelCandidates("chatgpt", /^(gpt|codex|o\d)/i);
      const hit = cands.find((c) => c.model === "gpt-custom-cache-only");
      assert.ok(hit, "cache-only Codex model listed");
      assert.deepEqual(hit.efforts.sort(), ["low", "xhigh"], "efforts from models_cache.json preserved");

      const ms = milestoneState([{ day: "2026-03-01", source: "Codex CLI", model: "gpt-5", input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, tokens: 1100, costUsd: 0.01, requests: 1, priced: true }], new Date(2026, 2, 30, 0, 30).getTime());
      assert.equal(ms.totals.tokens, 1100);

      const envScript = exitGuardScript("codex", { host: "chatgpt.com", allowedIps: ["1.2.3.4"], allowedRegions: [] }, { allowedEnvVar: "TP_EXIT_GUARD_ALLOWED" });
      assert.ok(envScript.includes("GetEnvironmentVariable('TP_EXIT_GUARD_ALLOWED')"));
      assert.ok(envScript.includes("SetEnvironmentVariable('TP_EXIT_GUARD_ALLOWED', $null)"));
      assert.ok(terminalScript("codex", "abc", undefined, undefined, { host: "chatgpt.com", allowedIps: ["1.2.3.4"], allowedRegions: [] }).includes("'1.2.3.4'"));
    });

    // 9. svg-sanitize: deep nested @import fail-closed + CSS escape / image-set / control-char href in attributes
    await check("svg-sanitize fails closed on deep nested CSS bypass and blocks escaped url/image-set/control href", () => {
      // 12-deep nested @im@im...@namespace;port
      let nested = "@namespace;";
      for (let i = 0; i < 12; i++) nested = `@im${nested}port url(https://evil.example/${i});`;
      assert.equal(sanitizeCss(nested), "", "non-converging nested CSS fails closed to empty string");

      const badSvg = '<svg><rect fill="u\\72 l(https://evil.example/a)" stroke="image-set(url(https://evil.example/b) 1x)"/><use href="&#1;#ok"/></svg>';
      const clean = sanitizeSvg(badSvg);
      assert.ok(!clean.includes("evil.example"), "escaped url and image-set stripped: " + clean);
      assert.ok(!clean.includes("href="), "control-char prefixed href stripped: " + clean);
    });

    // 10. agent-activity: Grok subagent_finished clears subs & prevents summary.json re-attach + prefs.ts sanitizes corrupt prefs
    await check("agent-activity clears finished Grok subagent and prefs.ts normalizes corrupt JSON", async () => {
      const grokRoot = path.join(root, "act-grok");
      const ws = path.join(grokRoot, "D%3A%5Cproj");
      const parentDir = path.join(ws, "parent-1");
      const childDir = path.join(ws, "child-1");
      fs.mkdirSync(parentDir, { recursive: true });
      fs.mkdirSync(childDir, { recursive: true });
      const now = Date.now();
      fs.writeFileSync(path.join(childDir, "summary.json"), JSON.stringify({ session_kind: "subagent", parent_session_id: "parent-1", agent_name: "worker" }));
      fs.writeFileSync(path.join(childDir, "updates.jsonl"), JSON.stringify({ timestamp: now / 1000, params: { update: { sessionUpdate: "tool_call", title: "bash", toolCallId: "t1" } } }) + "\n");
      fs.writeFileSync(path.join(parentDir, "updates.jsonl"), [
        { timestamp: (now - 5000) / 1000, params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "do work" } } } },
        { timestamp: (now - 4000) / 1000, params: { update: { sessionUpdate: "subagent_spawned", child_session_id: "child-1", agent_name: "worker" } } },
      ].map((r) => JSON.stringify(r)).join("\n") + "\n");

      const scanner = new ActivityScanner({ claude: path.join(root, "none1"), codex: path.join(root, "none2"), codexIndex: path.join(root, "none3"), grok: grokRoot }, () => now);
      const s1 = await scanner.scan();
      assert.equal(s1.running.length, 1);
      assert.equal(s1.running[0].subagents, 1, "subagent tracked while running");

      // Parent receives subagent_finished + turn_completed
      fs.appendFileSync(path.join(parentDir, "updates.jsonl"), [
        { timestamp: (now - 1000) / 1000, params: { update: { sessionUpdate: "subagent_finished", child_session_id: "child-1" } } },
        { timestamp: now / 1000, params: { update: { sessionUpdate: "turn_completed", prompt_id: "p1" } } },
      ].map((r) => JSON.stringify(r)).join("\n") + "\n");
      // Also bump child file so subagent entry is reloaded too
      fs.appendFileSync(path.join(childDir, "updates.jsonl"), JSON.stringify({ timestamp: now / 1000, params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } }) + "\n");

      const s2 = await scanner.scan();
      assert.equal(s2.running.length, 0, "finished Grok subagent must not keep parent running");

      // Corrupt prefs.json normalized safely
      writeJson(path.join(process.env.TOKENPULSE_DATA_DIR, "prefs.json"), {
        autoLaunch: "yes",
        theme: 999,
        language: "fr",
        notifyAt: "NaN",
        deskPetScale: 99,
        deskPetPos: { x: "bad", y: null },
        pressureWeek: "bogus",
        localOnlyAccounts: "not-an-array",
      });
      const p = readPrefs();
      assert.equal(p.autoLaunch, true);
      assert.equal(p.theme, "light");
      assert.equal(p.language, "system");
      assert.equal(p.notifyAt, 85);
      assert.equal(p.deskPetScale, 2);
      assert.equal(p.deskPetPos, null);
      assert.equal(p.pressureWeek, "default");
      assert.deepEqual(p.localOnlyAccounts, []);

      // session-search does not poison cache on nonexistent/unreadable parse
      const sr = searchSessions("nonexistenttermxyz", "all");
      assert.deepEqual(sr.hits, []);
    });

    console.log(`\nRound 5 Part 2: ${passed}/${passed + failed} passed`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
