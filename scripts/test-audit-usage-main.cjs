/**
 * 后端审计回归（Wave 4）：用量扫描、zstd 帧、会话解析/删除/回复、DeepSeek 归因、速度归属、定价上下文、请求流水、SVG/主题包、日志轮换、活跃扫描。
 * 跑法：node scripts/test-audit-usage-main.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-audit-w4-"));
process.env.HOME = process.env.USERPROFILE = path.join(root, "home");
process.env.TOKENPULSE_DATA_DIR = path.join(root, "data");
process.env.TOKENPULSE_DSH_HOME = path.join(root, "dsh");
process.env.PI_CODING_AGENT_DIR = path.join(root, "pi");
for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME"]) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });

const { codexUserText, parseSessionFile, deleteLocalSessionFiles } = require("../build/core/sessions.js");
const { scanLocalUsage, readRollups } = require("../build/core/usage-scan.js");
const { zstdFrames, zstdFrameEnd } = require("../build/core/zstd-frames.js");
const { analyzeDeepSeek } = require("../build/core/deepseek-insight.js");
const { accountSpeed } = require("../build/core/pass-speed.js");
const { contextWindowOf } = require("../build/core/model-pricing.js");
const { appendRequests, queryRequests } = require("../build/core/request-log.js");
const { readEvent, deleteArgs, replyArgs } = require("../build/main/session-reply.js");
const { sanitizeSvg } = require("../build/core/svg-sanitize.js");
const { readThemeFolder } = require("../build/core/pet-theme.js");
const { appLog, appLogFile, resetAppLogState } = require("../build/core/app-log.js");
const { ActivityScanner } = require("../build/core/agent-activity.js");

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
    // 1. sessions.ts: codexUserText recursion guard, parseDeepseek firstTokenMs, Builder mixed costUsd, BOM readLines, deleteLocalSessionFiles dot-dot
    await check("sessions.ts fixes codexUserText recursion, DeepSeek firstTokenMs, mixed reported+unreported cost, BOM pi session, dot-dot deletion", () => {
      assert.deepEqual(codexUserText("You are a helpful chat assistant"), { text: "You are a helpful chat assistant" });

      // DeepSeek firstTokenMs from step/start even with 1 stream chunk
      const dshFile = path.join(root, "dsh-sess.v4.jsonl.zstd");
      const dshLines = [
        JSON.stringify({ type: "session", id: "dsh-1", cwd: root, createdAt: "2026-10-10T10:00:00Z" }),
        JSON.stringify({ type: "user/message", time: 1760090400000, data: { content: [{ type: "text", text: "hi" }] } }),
        JSON.stringify({ type: "step/start", time: 1760090401000 }),
        JSON.stringify({
          type: "assistant/message",
          time: 1760090403500,
          data: {
            message: { id: "m1", source: { model: "deepseek-chat" }, content: [{ type: "text", text: "hello" }] },
            stream: [{ time: 1760090402200 }],
            usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
          },
        }),
      ].join("\n") + "\n";
      fs.writeFileSync(dshFile, zlib.zstdCompressSync(Buffer.from(dshLines, "utf8")));
      const parsedDsh = parseSessionFile("deepseek", dshFile);
      assert.ok(parsedDsh, "parsed deepseek session");
      const asst = parsedDsh.messages.find((m) => m.role === "assistant");
      assert.equal(asst.firstTokenMs, 1200, "firstTokenMs computed from step/start");

      // BOM-prefixed pi session + mixed reported cost (turn 1) & zero-cost (turn 2)
      const piFile = path.join(root, "2026-10-10_pi-bom.jsonl");
      const piBody = "\uFEFF" + [
        JSON.stringify({ type: "session", id: "pi-bom", cwd: root, timestamp: "2026-10-10T10:00:00Z" }),
        JSON.stringify({ type: "message", id: "u1", timestamp: "2026-10-10T10:00:01Z", message: { role: "user", content: "q1" } }),
        JSON.stringify({
          type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-10T10:00:02Z",
          message: { role: "assistant", model: "claude-sonnet-4-5", content: "ans1", usage: { input: 100000, output: 10000, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } },
        }),
        JSON.stringify({
          type: "message", id: "a2", parentId: "a1", timestamp: "2026-10-10T10:00:05Z",
          message: { role: "assistant", model: "claude-sonnet-4-5", content: "ans2", usage: { input: 100000, output: 10000, cacheRead: 0, cacheWrite: 0 } },
        }),
      ].join("\n") + "\n";
      fs.writeFileSync(piFile, piBody, "utf8");
      const parsedPi = parseSessionFile("pi", piFile);
      assert.ok(parsedPi, "BOM-prefixed pi session must parse");
      assert.ok(parsedPi.usage && parsedPi.usage.costUsd > 0.51, "mixed reported + unreported cost must include estimated cost for unreported turn, got " + (parsedPi.usage && parsedPi.usage.costUsd));

      assert.equal(deleteLocalSessionFiles("claude", "."), false, "reject '.' id");
      assert.equal(deleteLocalSessionFiles("claude", ".."), false, "reject '..' id");
      assert.equal(deleteLocalSessionFiles("claude", "-bad"), false, "reject leading '-' id");
    });

    // 2. zstd-frames.ts: skippable frames and reserved bit rejection
    await check("zstd-frames skips RFC 8878 skippable frames and rejects set Reserved Bit", () => {
      const payload = Buffer.from('{"ok":true}\n', "utf8");
      const realFrame = zlib.zstdCompressSync(payload);
      // Skippable frame: magic 0x184D2A50 LE, payload size 4, payload 4 bytes
      const skip = Buffer.alloc(12);
      skip.writeUInt32LE(0x184d2a50, 0);
      skip.writeUInt32LE(4, 4);
      skip.write("TEST", 8, "ascii");
      const combined = Buffer.concat([skip, realFrame]);
      const res = zstdFrames(combined);
      assert.equal(res.consumed, combined.length, "consumed skippable + real frame");
      assert.equal(res.text, '{"ok":true}\n', "decompressed real frame after skippable frame");

      // Set Reserved Bit (bit 3) in Frame_Header_Descriptor
      const bad = Buffer.from(realFrame);
      bad[4] |= 0x08;
      assert.equal(zstdFrameEnd(bad, 0), -1, "frame with Reserved Bit set must be rejected");
    });

    // 3. usage-scan.ts: Grok pass-through exemption, Codex inline comment + :port, DeepSeek zstd trailing line w/o \n & empty frame, Claude thinkingMetadata fallback
    await check("usage-scan fixes Grok pass-through, Codex TOML inline comment/port, DeepSeek zstd trailing line + empty frame, Claude thinkingMetadata", () => {
      const now = Date.UTC(2026, 9, 10, 12, 0, 0);
      const iso = (ms) => new Date(ms).toISOString();

      // Grok config pointing to local transparent pass-through
      const grokDir = path.join(process.env.HOME, ".grok");
      fs.mkdirSync(path.join(grokDir, "sessions", "proj", "g1"), { recursive: true });
      fs.writeFileSync(path.join(grokDir, "config.toml"), 'base_url = "http://127.0.0.1:38291/pass/grok"\n');
      fs.writeFileSync(path.join(grokDir, "sessions", "proj", "g1", "updates.jsonl"),
        JSON.stringify({
          timestamp: Math.floor(now / 1000),
          params: { update: { sessionUpdate: "turn_completed", prompt_id: "gp1", usage: { model: "grok-4", input_tokens: 100, output_tokens: 20 } } },
        }) + "\n",
      );

      // Codex config with inline comment and :443 port (plus ChatGPT OAuth login)
      const codexDir = path.join(process.env.HOME, ".codex");
      fs.mkdirSync(path.join(codexDir, "sessions", "2026", "10", "10"), { recursive: true });
      fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ tokens: { access_token: "tok" } }));
      fs.writeFileSync(path.join(codexDir, "config.toml"), '[model_providers.myofficial] # custom official\nbase_url = "https://api.openai.com:443/v1" # inline comment\n');
      const codexSess = path.join(codexDir, "sessions", "2026", "10", "10", "rollout-2026-10-10T12-00-00-c1.jsonl");
      fs.writeFileSync(codexSess, [
        JSON.stringify({ type: "session_meta", timestamp: iso(now - 5000), payload: { id: "c1", model_provider: "myofficial", cwd: root } }),
        JSON.stringify({ type: "turn_context", timestamp: iso(now - 4000), payload: { model: "gpt-5" } }),
        JSON.stringify({ type: "token_usage_record", timestamp: iso(now - 1000), payload: { response_id: "resp-c1", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } } }),
      ].join("\n") + "\n");

      // DeepSeek zstd with empty first frame + trailing JSON line lacking \n
      const dshSess = path.join(process.env.TOKENPULSE_DSH_HOME, "sessions", "proj", "session-d1", "session.v4.jsonl.zstd");
      fs.mkdirSync(path.dirname(dshSess), { recursive: true });
      const emptyFrame = zlib.zstdCompressSync(Buffer.alloc(0));
      const noNlFrame = zlib.zstdCompressSync(Buffer.from(JSON.stringify({
        type: "assistant/message",
        time: now,
        data: {
          message: { id: "dsh-msg-1", source: { model: "deepseek-chat" }, content: [{ type: "text", text: "ok" }] },
          usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      }), "utf8"));
      fs.writeFileSync(dshSess, Buffer.concat([emptyFrame, noNlFrame]));

      // Claude Code user.thinkingMetadata fallback
      const claudeSess = path.join(process.env.HOME, ".claude", "projects", "p1", "cl1.jsonl");
      fs.mkdirSync(path.dirname(claudeSess), { recursive: true });
      fs.writeFileSync(claudeSess, [
        JSON.stringify({ type: "user", timestamp: iso(now - 3000), thinkingMetadata: { disabled: false }, message: { content: "solve" } }),
        JSON.stringify({ type: "assistant", timestamp: iso(now - 1000), requestId: "req-cl1", message: { id: "msg-cl1", model: "claude-sonnet-4-5", usage: { input_tokens: 100, output_tokens: 50 } } }),
      ].join("\n") + "\n");

      const scanned = scanLocalUsage();
      const rollups = readRollups();
      const grokFile = path.join(grokDir, "sessions", "proj", "g1", "updates.jsonl");
      assert.equal(rollups.files[grokFile]?.official, true, "Grok pass-through base_url must count as official");
      assert.equal(rollups.files[codexSess]?.official, true, "Codex config with inline # comment and :443 must count as official");

      const dshRec = scanned.records.find((r) => r.kind === "deepseek-harness" && r.id === "dsh-msg-1");
      assert.ok(dshRec, "DeepSeek zstd empty frame + trailing line without newline must be scanned");
      assert.equal(dshRec.output, 30);

      const claudeRec = scanned.records.find((r) => r.kind === "claude-code" && r.id === "req-cl1");
      assert.ok(claudeRec, "Claude record scanned");
      assert.equal(claudeRec.effort, "enabled", "Claude user.thinkingMetadata flows into effort fallback");
      assert.ok(String(claudeRec.effortSource || "").startsWith("thinkingMetadata."), "effortSource preserves thinkingMetadata");
    });

    // 4. deepseek-insight.ts: 60s overlap double-counting + empty manual local mark must not inflate measuredRate
    await check("deepseek-insight prevents 60s overlap double-count and isolates empty manual local mark from measuredRate", () => {
      const now = Date.UTC(2026, 9, 10, 12, 0, 0);
      const M = 60_000;
      const samples = [
        { at: now - 10 * M, currency: "CNY", total: 100, granted: 0, toppedUp: 100 },
        { at: now - 9 * M, currency: "CNY", total: 99, granted: 0, toppedUp: 99 },
        { at: now - 8 * M, currency: "CNY", total: 98, granted: 0, toppedUp: 98 },
        { at: now - 7 * M, currency: "CNY", total: 97, granted: 0, toppedUp: 97 },
        { at: now - 6 * M, currency: "CNY", total: 87, granted: 0, toppedUp: 87 }, // ¥10 unmatched drop
      ];
      // Each of the 3 matched steps has 1 request of $0.14 (true rate = 1 / 0.14 ≈ 7.14 CNY/USD)
      // Req 1 sits at now - 9.5*M (within 60s of step 2's costFrom = now - 9*M!)
      const rows = [
        { at: now - 9.5 * M, source: "DeepSeek Harness", model: "deepseek-chat", input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, tokens: 1100, costUsd: 0.14, calls: 1 },
        { at: now - 8.5 * M, source: "DeepSeek Harness", model: "deepseek-chat", input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, tokens: 1100, costUsd: 0.14, calls: 1 },
        { at: now - 7.5 * M, source: "DeepSeek Harness", model: "deepseek-chat", input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, tokens: 1100, costUsd: 0.14, calls: 1 },
      ];
      const marks = [{ from: now - 7 * M, to: now - 6 * M, mode: "local", updatedAt: now }];
      const ins = analyzeDeepSeek({ accountId: "ds1", local: true, samples, rows, now, marks });
      // localCost must be 0.42 (3 * 0.14), NOT 0.70 (double-counted!)
      assert.ok(Math.abs(ins.rate.costUsd - 0.42) < 1e-6, "no overlap double-count: expected 0.42, got " + ins.rate.costUsd);
      // rate.drop stays 13 (1+1+1+10) for UI compatibility, while measuredRate uses matched drop (3 / 0.42 ≈ 7.14), NOT 13 / 0.42 ≈ 30.95!
      assert.equal(ins.rate.drop, 13, "rate.drop keeps all local drops");
      assert.ok(ins.rate.measured != null && Math.abs(ins.rate.measured - 3 / 0.42) < 0.05, "measuredRate ignores empty manual mark: got " + ins.rate.measured);
      assert.equal(ins.rate.basis, "measured", "plausible rate remains measured");
    });

    // 5. pass-speed.ts: excludes official === false rows & respects routedAccount
    await check("pass-speed accountSpeed excludes non-official rows and attributes routedAccount", () => {
      const now = Date.UTC(2026, 9, 10, 12, 0, 0);
      const relayFile = path.join(root, "relay-claude.jsonl");
      const poolFile = path.join(root, "pool-claude.jsonl");
      // Write rollups marking relayFile as official=false, poolFile as official=false (routed overrides)
      const rollupsFile = path.join(process.env.TOKENPULSE_DATA_DIR, "usage-rollups.json");
      const rollups = fs.existsSync(rollupsFile) ? JSON.parse(fs.readFileSync(rollupsFile, "utf8")) : { version: 2, files: {} };
      rollups.files[relayFile] = { size: 1, mtimeMs: now, offset: 1, kind: "claude-code", official: false, days: {} };
      rollups.files[poolFile] = { size: 1, mtimeMs: now, offset: 1, kind: "claude-code", official: false, days: {} };
      fs.writeFileSync(rollupsFile, JSON.stringify(rollups));
      // Write login timeline showing claude:cli-a was logged in
      fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, "login-timeline.json"), JSON.stringify({
        version: 1,
        accounts: { claude: [{ id: "claude:cli-a", from: now - 3600_000, to: now + 3600_000 }] },
      }));
      appendRequests([
        {
          id: "est-relay-1", at: now - 10_000, kind: "claude-code", file: relayFile,
          model: "claude-relay-only", input: 100, output: 500, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, calls: 1,
          estimate: { ms: 5000, tokensPerSec: 100 },
        },
        {
          id: "est-pool-1", at: now - 5_000, kind: "claude-code", file: poolFile,
          model: "claude-pool-only", input: 100, output: 600, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, calls: 1,
          routedAccount: "claude:pool-b", routedAccountBasis: "route-window",
          estimate: { ms: 5000, tokensPerSec: 120 },
        },
      ]);
      const spdA = accountSpeed("claude", "claude:cli-a", 7, now, true);
      assert.equal(spdA.models.find((m) => m.model === "claude-relay-only"), undefined, "relay row (official=false) excluded from accountSpeed");
      assert.equal(spdA.models.find((m) => m.model === "claude-pool-only"), undefined, "pool-routed row must not go to CLI login account");
      const spdB = accountSpeed("claude", "claude:pool-b", 7, now, true);
      assert.ok(spdB.models.find((m) => m.model === "claude-pool-only"), "pool-routed row attributed to claude:pool-b");
    });

    // 6. model-pricing.ts: contextWindowOf space boundary in combined string
    await check("model-pricing contextWindowOf recognizes -1m / -2m suffix on requestedId", () => {
      assert.equal(contextWindowOf("claude-opus-4-6", "claude-opus-4-6-1m"), 1_000_000);
      assert.equal(contextWindowOf("claude-opus-4-6", "claude-opus-4-6-2m"), 2_000_000);
    });

    // 7. request-log.ts: queryRequests last-wins dedup + cache_low does not starve analyzeCache
    await check("request-log queryRequests uses last-wins dedup and preserves small-input rows for cache analysis under sort=cache_low", () => {
      const now = Date.UTC(2026, 8, 15, 12, 0, 0); // 2026-09-15 isolated month
      appendRequests([
        {
          id: "dup-1", at: now, kind: "claude-code", file: "f.jsonl",
          model: "claude-old", input: 5000, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, calls: 1,
        },
        {
          id: "dup-1", at: now, kind: "claude-code", file: "f.jsonl",
          model: "claude-new", input: 5000, output: 200, cacheRead: 2500, cacheWrite: 0, reasoning: 0, costUsd: 0, calls: 1,
        },
        {
          id: "small-1", at: now + 1000, kind: "claude-code", file: "f.jsonl",
          model: "claude-new", input: 1000, output: 50, cacheRead: 500, cacheWrite: 0, reasoning: 0, costUsd: 0, calls: 1,
        },
      ]);
      const page = queryRequests({
        from: "2026-09-15", to: "2026-09-15", source: "all", status: "all",
        search: "", sort: "cache_low", page: 0, pageSize: 20, cache: true,
      });
      const dup = page.rows.find((r) => r.key.endsWith("dup-1"));
      assert.ok(dup, "dup-1 present");
      assert.equal(dup.model, "claude-new", "queryRequests must keep LAST duplicate record");
      assert.equal(dup.output, 200);
      // cache analysis must include small-1 (1000 input + 5000 input = 6000 total input)
      assert.equal(page.cache.totals.input, 6000, "cache analysis must include < 4096-input rows even when sort=cache_low");
    });

    // 8. session-reply.ts: deepseek final no double-emit + flag injection validation
    await check("session-reply skips deepseek final when streamed and rejects leading-dash session IDs", () => {
      assert.deepEqual(readEvent("deepseek", JSON.stringify({ type: "final", text: "hi" }), true), {}, "streamed deepseek final returns empty");
      assert.deepEqual(readEvent("deepseek", JSON.stringify({ type: "final", text: "hi" }), false), { final: "hi" }, "unstreamed deepseek final returns text");
      assert.throws(() => deleteArgs("codex", "--all"), /无效|invalid/i);
      assert.throws(() => replyArgs("claude", "--dangerously-skip-permissions", "readonly"), /无效|invalid/i);
      assert.ok(Array.isArray(replyArgs("deepseek", "", "readonly")), "deepseek allows empty id for new session");
    });

    // 9. svg-sanitize.ts: blocks comment/CDATA/nested CSS bypasses in <style>
    await check("svg-sanitize blocks fragmented and nested CSS bypasses inside <style>", () => {
      const evil = '<svg><style>@im<!---->port url("https://evil.test/a.css"); :ho<![CDATA[st]]> { fill: red; } @im@namespace;port "https://evil.test/b.css";</style></svg>';
      const clean = sanitizeSvg(evil);
      assert.ok(!/@import/i.test(clean), "stripped fragmented/nested @import: " + clean);
      assert.ok(!/:host\b/i.test(clean), "stripped fragmented :host: " + clean);
      assert.ok(!/evil\.test/i.test(clean), "stripped external url: " + clean);
    });

    // 10. pet-theme.ts: checks sanitized SVG size against limits.total & blocks symlink/junction assets dir
    await check("pet-theme enforces post-sanitization SVG size and rejects symlinked assets directory", () => {
      // Expansion test: raw SVG < 100 bytes, sanitized SVG expands (adds xmlns + xmlns:xlink + closing tags) > 120 bytes
      const expDir = path.join(root, "theme-exp");
      fs.mkdirSync(expDir, { recursive: true });
      fs.writeFileSync(path.join(expDir, "theme.json"), JSON.stringify({ name: "exp", states: { idle: ["a.svg"] } }));
      const rawSvg = "<svg><g/><g/><g/></svg>";
      fs.writeFileSync(path.join(expDir, "a.svg"), rawSvg, "utf8");
      assert.throws(
        () => readThemeFolder(expDir, { file: 1024, total: rawSvg.length + 10 }),
        /超过|20 MB|太大/,
        "sanitized SVG exceeding limits.total must be rejected",
      );

      // Symlink / junction escape test
      const outside = path.join(root, "outside-secret");
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, "idle.svg"), "<svg></svg>", "utf8");
      const symDir = path.join(root, "theme-sym");
      fs.mkdirSync(symDir, { recursive: true });
      fs.writeFileSync(path.join(symDir, "theme.json"), JSON.stringify({ name: "sym", states: { idle: ["idle.svg"] } }));
      fs.symlinkSync(outside, path.join(symDir, "assets"), process.platform === "win32" ? "junction" : "dir");
      assert.throws(() => readThemeFolder(symDir), /找不到|链接|普通/, "symlinked/junctioned assets dir must not be followed");
    });

    // 11. app-log.ts: preserves backups when active log file cannot be renamed
    await check("app-log preserves .1.log and .2.log backups when rotation rename of active log fails", () => {
      resetAppLogState();
      const logFile = appLogFile();
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const b1 = logFile.replace(/\.log$/, ".1.log");
      const b2 = logFile.replace(/\.log$/, ".2.log");
      fs.writeFileSync(logFile, "x".repeat(4 * 1024 * 1024 + 10));
      fs.writeFileSync(b1, "BACKUP_1");
      fs.writeFileSync(b2, "BACKUP_2");
      const origRename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (path.resolve(String(from)) === path.resolve(logFile)) {
          const err = new Error("EBUSY");
          err.code = "EBUSY";
          throw err;
        }
        return origRename(from, to);
      };
      try {
        appLog("INFO", "test", "trigger rotate");
      } finally {
        fs.renameSync = origRename;
      }
      assert.equal(fs.readFileSync(b1, "utf8"), "BACKUP_1", ".1.log must NOT be wiped when active log rename fails");
      assert.equal(fs.readFileSync(b2, "utf8"), "BACKUP_2", ".2.log must NOT be wiped when active log rename fails");
    });

    // 12. agent-activity.ts: transient read failure on updated session retries on next scan
    await check("agent-activity retries updated session file after transient read error", async () => {
      const claudeRoot = path.join(root, "act-claude");
      const proj = path.join(claudeRoot, "p1");
      fs.mkdirSync(proj, { recursive: true });
      const sess = path.join(proj, "s1.jsonl");
      const now = Date.now();
      fs.writeFileSync(sess, [
        JSON.stringify({ type: "user", timestamp: new Date(now - 5000).toISOString(), message: { content: "first" } }),
        JSON.stringify({ type: "assistant", timestamp: new Date(now - 4000).toISOString(), message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }),
      ].join("\n") + "\n");
      let clock = now;
      const scanner = new ActivityScanner(
        { claude: claudeRoot, codex: path.join(root, "empty1"), codexIndex: path.join(root, "empty1", "idx"), grok: path.join(root, "empty2"), deepseek: path.join(root, "empty3"), pi: path.join(root, "empty4"), antigravity: "", antigravityCli: "" },
        () => clock,
      );
      const initial = await scanner.scan();
      assert.equal(initial.running.length, 0, "initial scan sees completed turn (entry.read is now true)");
      // Append a new active user turn, then fail read on that updated file once
      fs.appendFileSync(sess, JSON.stringify({ type: "user", timestamp: new Date(now + 1000).toISOString(), message: { content: "second turn" } }) + "\n");
      const fsp = require("node:fs/promises");
      const origOpen = fsp.open;
      let failOnce = true;
      fsp.open = async (p, ...rest) => {
        if (failOnce && path.resolve(String(p)) === path.resolve(sess)) {
          failOnce = false;
          const err = new Error("EBUSY");
          err.code = "EBUSY";
          throw err;
        }
        return origOpen(p, ...rest);
      };
      try {
        clock = now + 1100;
        const first = await scanner.scan();
        assert.equal(first.running.length, 0, "scan during transient error misses update");
        clock = now + 1200;
        const second = await scanner.scan();
        assert.equal(second.running.length, 1, "next scan must retry and detect running task without needing another file mtime change");
      } finally {
        fsp.open = origOpen;
      }
    });

    console.log(`\nWave 4: ${passed}/${passed + failed} passed`);
    if (failed > 0) process.exit(1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
