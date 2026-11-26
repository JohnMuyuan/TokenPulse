/**
 * 后端审计回归（Round 5 · Part 1）：代理、协议转换、TOML/YAML/历史脱敏、切换器、认证/续期、额度、出口监控、余额与 Antigravity。
 * 跑法：node scripts/test-audit-r5-core.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-audit-r5a-"));
process.env.HOME = process.env.USERPROFILE = path.join(root, "home");
process.env.TOKENPULSE_DATA_DIR = path.join(root, "data");
process.env.AGENT_SWITCH_HOME = path.join(root, "home");
process.env.PI_CODING_AGENT_DIR = path.join(root, "pi");
process.env.TOKENPULSE_DSH_HOME = path.join(root, "dsh");
process.env.TOKENPULSE_ANTIGRAVITY_DIR = path.join(root, "agy");
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"]) {
  delete process.env[k];
}
process.env.NO_PROXY = "127.0.0.1,localhost";
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });

const { startAgentProxy } = require("../build/core/agent-proxy.js");
const { convertRequest, StreamBridge } = require("../build/core/agent-convert.js");
const { parseToml, dropEmptyTable, stringifyToml } = require("../build/core/agent-toml.js");
const { maskSecrets, listHistory } = require("../build/core/agent-history.js");
const { configTransaction } = require("../build/core/agent-config.js");
const agentSwitch = require("../build/core/agent-switch.js");
const { readCliAccounts } = require("../build/core/credentials.js");
const { runWithKindRenewalLock, renewStoredCredentials, readOfficialAccountStore, writeOfficialAccountStore } = require("../build/core/accounts.js");
const { autoSwitchCli, resetAutoSwitchForTests } = require("../build/core/cli-auto-switch.js");
const { quietPick, resetQuietForTests } = require("../build/core/quota-quiet.js");
const { localOnlyAccounts } = require("../build/core/quota-calibration.js");
const { readPressurePrefs } = require("../build/core/quota-pressure.js");
const { cleanCapacity } = require("../build/core/quota-offmachine.js");
const { EgressTracker } = require("../build/core/egress.js");
const { parseSub2api } = require("../build/core/relay-balance.js");
const { TokensUploader } = require("../build/main/tokens-ci.js");
const { DeepSeekBalance } = require("../build/main/deepseek-balance.js");
const { parseUnixAntigravityProcesses, findAntigravityDesktopExe } = require("../build/core/antigravity-switch.js");
const { renewAgyCredentials, readAgyAccountStore, writeAgyAccountStore, rememberAgyAccount } = require("../build/core/antigravity-accounts.js");
const { AntigravityQuota } = require("../build/main/antigravity-quota.js");

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

function rawTcpExchange(port, rawRequest) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(rawRequest));
    let out = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => { out += chunk; });
    sock.on("end", () => resolve(out));
    sock.on("close", () => resolve(out));
    sock.on("error", reject);
    sock.setTimeout(3000, () => { sock.destroy(); resolve(out); });
  });
}

(async () => {
  try {
    // 1. agent-proxy: malformed URL on HTTP & WebSocket upgrade returns 400 without crashing + BOM/whitespace JSON body
    await check("agent-proxy guards malformed URL on HTTP & WS upgrade and handles BOM/whitespace JSON body", async () => {
      let seenUpstreamBody = null;
      const upstream = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
          seenUpstreamBody = JSON.parse(raw || "{}");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "cmpl-1", object: "chat.completion", model: "gpt-5", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
        });
      });
      await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
      const upPort = upstream.address().port;

      let uncaught = null;
      const onUncaught = (e) => { uncaught = e; };
      process.on("uncaughtException", onUncaught);

      const proxy = startAgentProxy({
        host: "127.0.0.1",
        port: 0,
        targets: () => [{
          id: "t1",
          name: "mock-up",
          upstream: "openai-chat",
          baseUrl: `http://127.0.0.1:${upPort}/v1`,
          apiKey: "sk-test-key-1234567890",
          model: "gpt-5",
          modelMap: { "claude-sonnet": "gpt-5" },
          failover: false,
        }],
        log: () => {},
        fail: () => {},
        succeed: () => {},
        open: () => false,
        pass: () => `http://127.0.0.1:${upPort}`,
      });
      const proxyPort = await proxy.listen();
      try {
        const badHttp = await rawTcpExchange(proxyPort, "GET http://[::1/claude/v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        assert.match(badHttp, /^HTTP\/1\.1 400 /);

        const badWs = await rawTcpExchange(
          proxyPort,
          "GET http://[::1/pass/codex HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
        assert.match(badWs, /^HTTP\/1\.1 400 /);
        assert.equal(uncaught, null, "malformed upgrade URL must not trigger uncaughtException");

        // Leading UTF-8 BOM + whitespace JSON body still converts model
        const bomBody = Buffer.from('\uFEFF   {"model":"claude-sonnet","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}', "utf8");
        const status = await new Promise((resolve, reject) => {
          const req = http.request({ host: "127.0.0.1", port: proxyPort, path: "/claude/v1/messages", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": bomBody.length } }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          });
          req.on("error", reject);
          req.end(bomBody);
        });
        assert.equal(status, 200);
        assert.equal(seenUpstreamBody && seenUpstreamBody.model, "gpt-5", "BOM+whitespace JSON body must be parsed and converted");
      } finally {
        process.off("uncaughtException", onUncaught);
        await proxy.close();
        await new Promise((r) => upstream.close(r));
      }
    });

    // 2. agent-convert: array function_call_output, response.incomplete, anthropicEnd input_tokens, trailing SSE flush
    await check("agent-convert fixes array function_call_output, response.incomplete, anthropicEnd input_tokens, trailing SSE flush", () => {
      const req = JSON.stringify({
        model: "gpt-5",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "run tool" }] },
          { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
          { type: "function_call_output", call_id: "c1", output: [{ type: "output_text", text: "lineA" }, { type: "output_text", text: "lineB" }] },
        ],
      });
      const chat = convertRequest("openai-responses", "openai-chat", req, "gpt-5").json;
      const toolMsg = chat.messages.find((m) => m.role === "tool");
      assert.ok(toolMsg && toolMsg.content.includes("lineA") && toolMsg.content.includes("lineB"), "array output preserved: " + JSON.stringify(toolMsg));

      // response.incomplete emits max_tokens/length + usage
      const b1 = new StreamBridge("openai-responses", "openai-chat", "gpt-5");
      let out1 = b1.push('event: response.incomplete\ndata: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":42,"output_tokens":99}}}\n\n');
      out1 += b1.end();
      assert.ok(out1.includes('"finish_reason":"length"'), "response.incomplete maps to finish_reason=length");
      assert.deepEqual(b1.usage(), { input: 42, output: 99 });

      // Empty content anthropicEnd preserves input_tokens (not 0)
      const b2 = new StreamBridge("openai-chat", "anthropic", "claude-opus-4");
      let out2 = b2.push('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":321,"completion_tokens":0}}\n\n');
      out2 += b2.end();
      assert.ok(out2.includes('"input_tokens":321'), "empty anthropicEnd must preserve input_tokens: " + out2);

      // Trailing SSE frame without terminating \n\n flushed in end()
      const b3 = new StreamBridge("openai-chat", "anthropic", "claude-opus-4");
      const p3 = b3.push('data: {"choices":[{"delta":{"content":"TRAILING"}}]}');
      const e3 = b3.end();
      assert.ok((p3 + e3).includes("TRAILING"), "trailing SSE frame without \\n\\n must flush in end()");
    });

    // 3. agent-toml: dropEmptyTable removes keyless table containing comment for next table and preserves comment
    await check("agent-toml dropEmptyTable drops keyless table with comments and keeps comments", () => {
      const src = [
        'model = "gpt-5"',
        "",
        "[model_providers.tokenpulse_route]",
        "# comment for next table",
        "",
        "[projects]",
        'dir = "/tmp"',
        "",
      ].join("\n");
      const blocks = parseToml(src);
      dropEmptyTable(blocks, "model_providers.tokenpulse_route");
      const out = stringifyToml(blocks);
      assert.ok(!out.includes("[model_providers.tokenpulse_route]"), "keyless table header dropped");
      assert.ok(out.includes("# comment for next table"), "comment preserved");
      assert.ok(out.includes("[projects]"), "following table preserved");
    });

    // 4. agent-history: maskSecrets handles escaped quotes in JSON, YAML '' escapes, and quoted keys
    await check("agent-history maskSecrets masks JSON escaped quotes, YAML '' escapes, and quoted keys", () => {
      const j = maskSecrets('{"api_key":"sk-abc\\"def-secret-99887766"}');
      assert.ok(!j.includes("99887766"), "JSON escaped quote tail masked: " + j);

      const y = maskSecrets("  api_key: 'sec''ret-value-55443322'");
      assert.ok(!y.includes("55443322"), "YAML single-quote escaped tail masked: " + y);

      const qk = maskSecrets('"token": "tok-secret-11223344"');
      assert.ok(!qk.includes("11223344"), "quoted key masked: " + qk);
    });

    // 5. agent-config: rolled-back configTransaction leaves no phantom history entry
    await check("agent-config configTransaction does not record history on rollback", () => {
      const target = path.join(root, "tx-test.json");
      fs.writeFileSync(target, '{"v":1}\n', "utf8");
      const beforeCount = listHistory().length;
      assert.throws(() => {
        configTransaction("tx-rollback-test", [
          { path: target, before: '{"v":1}\n', after: '{"v":2}\n' },
          // Invalid path with NUL triggers failure after first write and forces rollback
          { path: path.join(root, "bad\u0000path.json"), before: null, after: "x" },
        ]);
      });
      assert.equal(fs.readFileSync(target, "utf8"), '{"v":1}\n', "rolled back file content");
      assert.equal(listHistory().length, beforeCount, "no phantom history recorded on rollback");
    });

    // 6. agent-switch: DeepSeek exemption + YAML quoting edge cases + BOM in refs + Codex cleanup
    await check("agent-switch handles DeepSeek non-proxy exemption, YAML edge-case quoting, and BOM restoreProxy", async () => {
      const dshDir = path.join(process.env.AGENT_SWITCH_HOME, ".dsh");
      fs.mkdirSync(dshDir, { recursive: true });
      fs.writeFileSync(path.join(dshDir, ".credentials.yaml"), "\uFEFFrefs:\n    EXISTING: keep-me\n", "utf8");
      const savedId = agentSwitch.saveProvider({
        app: "deepseek",
        name: "DS Edge",
        upstream: "openai-chat",
        baseUrl: "https://api.example.com/v1",
        apiKey: "on: -123 'quote'",
        model: "deepseek-chat",
      });
      const view = agentSwitch.agentView();
      const dshProv = view.providers.find((p) => p.id === savedId);
      assert.equal(dshProv && dshProv.cross, false, "DeepSeek must not be marked cross-protocol");
      assert.ok(savedId, "DeepSeek provider saved");
      // Check .credentials.yaml has no BOM corruption if activated
      await agentSwitch.activateProvider(savedId);
      const credYaml = fs.readFileSync(path.join(dshDir, ".credentials.yaml"), "utf8");
      assert.ok(!credYaml.startsWith("\uFEFF"), "BOM stripped cleanly");
      assert.ok(credYaml.includes("    EXISTING: keep-me"), "existing indentation preserved");
      assert.ok(credYaml.includes("    TOKENPULSE_ROUTE:"), "new ref uses existing indentation");
      assert.ok(credYaml.includes("'on: -123 ''quote'''"), "YAML special value quoted safely");
    });

    // 7. credentials BOM + accounts per-kind renewal lock & id_token persistence + cli-auto-switch filtering
    await check("credentials BOM, accounts runWithKindRenewalLock + id_token, and cli-auto-switch filtering", async () => {
      const codexDir = path.join(process.env.HOME, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      const payload = Buffer.from(JSON.stringify({ email: "bom@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct-bom" } })).toString("base64url");
      const fakeJwt = `eyJhbGciOiJub25lIn0.${payload}.sig`;
      fs.writeFileSync(path.join(codexDir, "auth.json"), "\uFEFF" + JSON.stringify({ tokens: { access_token: fakeJwt, refresh_token: "rt-bom", account_id: "acct-bom" } }), "utf8");
      const live = readCliAccounts("chatgpt");
      assert.equal(live.length, 1, "BOM-prefixed Codex auth.json parsed");

      // Serialization check for runWithKindRenewalLock
      const order = [];
      await Promise.all([
        runWithKindRenewalLock("chatgpt", async () => {
          order.push("start-1");
          await new Promise((r) => setTimeout(r, 30));
          order.push("end-1");
        }),
        runWithKindRenewalLock("chatgpt", async () => {
          order.push("start-2");
          order.push("end-2");
        }),
      ]);
      assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2"], "same-kind renewals serialize");

      // renewStoredCredentials persists raw.id_token into target.cliAuth
      const nowAcc = Date.now();
      writeOfficialAccountStore({
        version: 2,
        active: {},
        accounts: [{
          id: "chatgpt:acct-renew",
          kind: "chatgpt",
          ref: "acct-renew",
          email: "renew@example.com",
          label: "renew@example.com",
          credential: { token: "old-at", refreshToken: "old-rt", expiresAt: nowAcc - 1000 },
          createdAt: nowAcc,
          lastSeenAt: nowAcc,
        }],
      });
      await renewStoredCredentials(Date.now(), async () => ({
        ok: true,
        credential: { token: "new-at", refreshToken: "new-rt", expiresAt: Date.now() + 3600_000 },
        raw: { id_token: "fresh-id-token-123" },
      }));
      const afterStore = readOfficialAccountStore();
      assert.equal(afterStore.accounts[0].cliAuth && afterStore.accounts[0].cliAuth.id_token, "fresh-id-token-123", "id_token saved on ChatGPT renewal");

      // cli-auto-switch excludes unswitchable claude:token:* and grok without issuer/clientId
      resetAutoSwitchForTests();
      writeOfficialAccountStore({
        version: 2,
        active: {},
        accounts: [
          { id: "claude:current", kind: "claude", ref: "current", email: "c1@e.com", label: "c1", credential: { token: "t0", refreshToken: "rt0" }, createdAt: nowAcc, lastSeenAt: nowAcc },
          { id: "claude:token:abc", kind: "claude", ref: "token:abc", email: "", label: "tok", credential: { token: "t1", refreshToken: "rt1" }, createdAt: nowAcc, lastSeenAt: nowAcc },
          { id: "claude:acct-ok", kind: "claude", ref: "acct-ok", email: "c2@e.com", label: "c2", credential: { token: "t2", refreshToken: "rt2" }, createdAt: nowAcc, lastSeenAt: nowAcc },
          { id: "grok:current", kind: "grok", ref: "current", email: "g1@e.com", label: "g1", credential: { token: "g0", refreshToken: "grt0", issuer: "https://id.example", clientId: "cid" }, createdAt: nowAcc, lastSeenAt: nowAcc },
          { id: "grok:no-oidc", kind: "grok", ref: "no-oidc", email: "g2@e.com", label: "g2", credential: { token: "g1", refreshToken: "grt1" }, createdAt: nowAcc, lastSeenAt: nowAcc },
          { id: "grok:ok", kind: "grok", ref: "ok", email: "g3@e.com", label: "g3", credential: { token: "g2", refreshToken: "grt2", issuer: "https://id.example", clientId: "cid" }, createdAt: nowAcc, lastSeenAt: nowAcc },
        ],
      });
      const switched = [];
      await autoSwitchCli({
        now: nowAcc,
        readOnly: false,
        rules: { claude: { on: true, at: 95 }, grok: { on: true, at: 95 } },
        current: (kind) => `${kind}:current`,
        usesOfficial: () => true,
        quota: (id) => {
          if (id.endsWith(":current")) return { at: nowAcc, five: { left: 1, resetAt: null }, week: { left: 50, resetAt: null } };
          // Give unswitchable accounts MORE headroom (left=100) than switchable accounts (left=80) to prove they were filtered out!
          if (id === "claude:token:abc" || id === "grok:no-oidc") return { at: nowAcc, five: { left: 100, resetAt: null }, week: { left: 100, resetAt: null } };
          return { at: nowAcc, five: { left: 80, resetAt: null }, week: { left: 80, resetAt: null } };
        },
        switchTo: async (id) => { switched.push(id); },
      });
      assert.deepEqual(switched.sort(), ["claude:acct-ok", "grok:ok"], "unswitchable claude:token:* and grok without issuer/clientId skipped");
    });

    // 8. quota-quiet pure pick, prefs.json null guards, quota-offmachine clock skew, egress region_mismatch, relay-balance sub2api
    await check("quota-quiet pure pick, prefs null guards, offmachine skew, egress region_mismatch, relay-balance sub2api", () => {
      resetQuietForTests();
      const now = Date.now();
      const pick = quietPick(new Set(), { "claude:bg": now - 40 * 60_000 }, now);
      assert.equal(pick("claude", "claude:bg"), true);
      // Calling pick alone must NOT stamp checkedAt; calling again before mark still returns true
      assert.equal(pick("claude", "claude:bg"), true, "pick without mark must remain pure");
      pick.mark("claude:bg");
      assert.equal(pick("claude", "claude:bg"), false, "after mark, background account enters quiet window");

      // prefs.json containing literal null must not crash calibration/pressure readers
      fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, "prefs.json"), "null", "utf8");
      assert.deepEqual(localOnlyAccounts(), []);
      assert.deepEqual(readPressurePrefs(), { week: "default", five: "relaxed" });

      // quota-offmachine: final segment with endAt > now stays current even if startAt > now (clock skew)
      const resetIso = new Date(now + 4 * 3600_000).toISOString();
      const skewCap = cleanCapacity(
        "claude",
        [
          { at: now + 30_000, five: 10, fiveReset: resetIso, week: 10, weekReset: resetIso },
          { at: now + 60_000, five: 20, fiveReset: resetIso, week: 20, weekReset: resetIso },
        ],
        [],
        [],
        "five",
        now,
      );
      assert.ok(skewCap && skewCap.history && skewCap.history.basis === "clean", "cleanCapacity runs without throwing under skewed timestamps");

      // egress: region_mismatch still emitted even when region_unknown added due to expired verification
      const tracker = new EgressTracker();
      const { row: verdict } = tracker.accept(
        { provider: "claude", host: "claude.ai", ip: "203.0.113.10", region: "DE", checkedAt: Date.UTC(2035, 0, 1), latencyMs: 10 },
        { enabled: true, host: "claude.ai", allowedIps: [], allowedRegions: ["US"] },
      );
      assert.ok(verdict.reasons.includes("region_unknown"), "expired verified rule emits region_unknown: " + JSON.stringify(verdict.reasons));
      assert.ok(verdict.reasons.includes("region_mismatch"), "region_mismatch present even with expired verification: " + JSON.stringify(verdict.reasons));

      // relay-balance parseSub2api: negative wallet balance is overdrawn (0, unavailable), NOT unlimited
      const overdrawn = parseSub2api(JSON.stringify({ isValid: true, mode: "balance", balance: -1, unit: "USD" }));
      assert.equal(Boolean(overdrawn.extra.unlimited), false);
      assert.equal(overdrawn.available, false);
      assert.equal(overdrawn.remaining, 0);
      const trueUnlimited = parseSub2api(JSON.stringify({ isValid: true, mode: "subscription", remaining: -1, unit: "USD" }));
      assert.equal(trueUnlimited.extra.unlimited, true);
    });

    // 9. tokens-ci null JSON guard + deepseek-balance updateNow refusal on failed verify
    await check("tokens-ci handles null config JSON and DeepSeekBalance refuses invalid key update", async () => {
      fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, "tokens-ci.json"), "null", "utf8");
      const uploader = new TokensUploader({ onChange: () => {} });
      assert.equal(uploader.state().settings.enabled, false);
      uploader.stop();

      const goodKey = "sk-11112222333344445555666677778888";
      const badKey = "sk-99998888777766665555444433332222";
      let failVerify = false;
      const ds = new DeepSeekBalance({
        publish: () => {},
        fetcher: async (key) => {
          if (failVerify || key === badKey) return { status: 401, body: "{}" };
          return { status: 200, body: JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "10.00", granted_balance: "0.00", topped_up_balance: "10.00" }] }) };
        },
      });
      try {
        const added = await ds.add({ label: "DS", key: goodKey, harness: false });
        assert.equal(added.accounts.length, 1);
        const accId = added.id;
        failVerify = true;
        await assert.rejects(() => ds.update(accId, { key: badKey }), /无效|401|未修改|失败|校验/);
        // Stored key must still be goodKey (refresh succeeds once network recovers)
        failVerify = false;
        const refreshed = await ds.refresh(accId, true);
        assert.equal(refreshed.accounts[0].error, undefined, "good key preserved after rejected update");
      } finally {
        ds.stop();
      }
    });

    // 10. Antigravity: renewAgyCredentials projectId preservation, parseUnixAntigravityProcesses spaces, findAntigravityDesktopExe .app, forgetAccount active slot
    await check("Antigravity fixes projectId preservation, macOS space-safe ps/.app, and forgetAccount top-level clear", async () => {
      const now = Date.now();
      writeAgyAccountStore({ version: 1, accounts: [] });
      rememberAgyAccount({
        email: "a1@example.com",
        label: "a1@example.com",
        credential: { token: "old", refreshToken: "rt1", expiresAt: now - 1000 },
      }, true, now);
      await renewAgyCredentials(now, async () => {
        // Simulate concurrent writer adding projectId during refresh
        const s = readAgyAccountStore();
        s.accounts[0].credential.projectId = "proj-concurrent";
        writeAgyAccountStore(s);
        return { ok: true, credential: { token: "new", refreshToken: "rt2", expiresAt: now + 3600_000 } };
      });
      assert.equal(readAgyAccountStore().accounts[0].credential.projectId, "proj-concurrent", "concurrent projectId preserved");

      // macOS ps output with spaces in user path
      const psOut = [
        "101 /Users/Jane Doe/Applications/Antigravity.app/Contents/MacOS/Antigravity --user-data-dir=/tmp/x",
        "102 /Users/Jane Doe/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --csrf_token abc",
        "103 /usr/bin/grep language_server /Users/Jane Doe/antigravity.log",
        "104 /Applications/TokenPulse.app/Contents/MacOS/TokenPulse",
      ].join("\n");
      const procs = parseUnixAntigravityProcesses(psOut);
      assert.equal(procs.length, 2, "matched desktop + language_server only: " + JSON.stringify(procs));
      assert.equal(procs[0].isDesktop, true);
      assert.equal(procs[0].executablePath, "/Users/Jane Doe/Applications/Antigravity.app/Contents/MacOS/Antigravity");
      assert.equal(procs[1].isDesktop, false);
      assert.ok(procs[1].executablePath.endsWith("language_server_macos_arm"));

      // macOS .app normalization in findAntigravityDesktopExe
      const fakeBundle = path.join(root, "Antigravity.app");
      const fakeBin = path.join(fakeBundle, "Contents", "MacOS", "Antigravity");
      fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
      fs.writeFileSync(fakeBin, "");
      const foundExe = findAntigravityDesktopExe(
        [{ pid: 101, name: "Antigravity", executablePath: fakeBin.replace(/\\/g, "/"), isDesktop: true }],
        "darwin",
        process.env.HOME,
      );
      assert.ok(foundExe && foundExe.endsWith(".app"), "darwin exe normalized to .app bundle: " + foundExe);

      // AntigravityQuota forgetAccount clears top-level when forgotten account had top-level slot even if another account remains
      const aq = new AntigravityQuota({ onChange: () => {} });
      aq.stateData = {
        installed: true,
        running: false,
        email: "first@example.com",
        plan: "Pro",
        groups: [{ id: "g1", label: "G1", usedPct: 50, remainingPct: 50 }],
        accounts: [
          { accountId: "antigravity:first", email: "first@example.com", plan: "Pro", groups: [{ id: "g1", label: "G1", usedPct: 50, remainingPct: 50 }], source: "cloud" },
          { accountId: "antigravity:second", email: "second@example.com", plan: "Free", groups: [], source: "cloud" },
        ],
      };
      aq.forgetAccount("antigravity:first");
      assert.equal(aq.state().accounts.length, 1);
      assert.equal((aq.state().groups ?? []).length, 0, "stale top-level groups cleared when active slot forgotten");
      assert.notEqual(aq.state().email, "first@example.com");
      aq.stop();
    });

    console.log(`\nRound 5 Part 1: ${passed}/${passed + failed} passed`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
