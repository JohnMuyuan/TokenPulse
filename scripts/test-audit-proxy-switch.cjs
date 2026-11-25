/**
 * 后端审计回归（Wave 1）：代理、协议转换、供应商切换、脱敏、Prism 桥与上游代理。
 * 跑法：node scripts/test-audit-proxy-switch.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-audit-w1-"));
process.env.HOME = process.env.USERPROFILE = path.join(root, "home");
process.env.TOKENPULSE_DATA_DIR = path.join(root, "data");
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "TOKENPULSE_DSH_HOME"]) {
  delete process.env[k];
}
process.env.NO_PROXY = "127.0.0.1,localhost";

const { convertRequest, StreamBridge } = require("../build/core/agent-convert.js");
const { startAgentProxy, fetchUpstreamModels } = require("../build/core/agent-proxy.js");
const { maskSecrets } = require("../build/core/agent-history.js");
const { parseToml } = require("../build/core/agent-toml.js");
const { envProxyFor } = require("../build/core/upstream-proxy.js");
const { poolRows } = require("../build/core/pool-insight.js");
const agentSwitch = require("../build/core/agent-switch.js");

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
    // 1. SseBuffer CRLF split across chunk boundary
    await check("SseBuffer handles CRLF \\r\\n\\r + \\n split across chunks", () => {
      const bridge = new StreamBridge("openai-chat", "anthropic", "gpt-5");
      const out1 = bridge.push('data: {"choices":[{"delta":{"content":"HELLO"}}]}\r\n\r');
      const out2 = bridge.push('\ndata: {"choices":[{"delta":{"content":"WORLD"}}]}\r\n\r\n');
      const all = out1 + out2 + bridge.end();
      assert.ok(all.includes("HELLO"), "HELLO preserved");
      assert.ok(all.includes("WORLD"), "WORLD preserved");
    });

    // 2. Cross-protocol request conversion: Responses reasoning + parallel function_call -> chat & anthropic
    await check("convertRequest merges parallel function_call and ignores reasoning items", () => {
      const req = JSON.stringify({
        model: "gpt-5",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "do two things" }] },
          { type: "reasoning", id: "rs_1", summary: [] },
          { type: "function_call", call_id: "c1", name: "a", arguments: '{"x":1}' },
          { type: "function_call", call_id: "c2", name: "b", arguments: '{"y":2}' },
          { type: "function_call_output", call_id: "c1", output: "r1" },
          { type: "function_call_output", call_id: "c2", output: "r2" },
        ],
      });
      const toChat = convertRequest("openai-responses", "openai-chat", req, "gpt-5").json;
      const roles = toChat.messages.map((m) => m.role);
      assert.deepEqual(roles, ["user", "assistant", "tool", "tool"], "no phantom user from reasoning, no split assistant turns");
      assert.equal(toChat.messages[1].tool_calls.length, 2, "parallel calls merged into single assistant message");

      const toAnth = convertRequest("openai-responses", "anthropic", req, "claude-opus-4").json;
      assert.deepEqual(toAnth.messages.map((m) => m.role), ["user", "assistant", "user"], "parallel tool_results merged into single user turn");
      assert.equal(toAnth.messages[1].content.filter((b) => b.type === "tool_use").length, 2);
      assert.equal(toAnth.messages[2].content.filter((b) => b.type === "tool_result").length, 2);
    });

    // 3. Streaming from Anthropic preserves input_tokens from message_start
    await check("StreamBridge from Anthropic preserves input_tokens from message_start", () => {
      const bridge = new StreamBridge("anthropic", "openai-chat", "claude-opus-4");
      bridge.push('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1234,"output_tokens":0}}}\n\n');
      bridge.push('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n');
      bridge.push('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":56}}\n\n');
      const tail = bridge.end();
      assert.deepEqual(bridge.usage(), { input: 1234, output: 56 });
      assert.ok(tail.includes('"prompt_tokens":1234'));
    });

    // 4. Streaming openai-responses -> openai-chat parallel tool calls keeps correct index & arguments
    await check("StreamBridge openai-responses -> openai-chat routes parallel tool_call args by index/item_id", () => {
      const bridge = new StreamBridge("openai-responses", "openai-chat", "gpt-5");
      let out = "";
      out += bridge.push('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"toolA"}}\n\n');
      out += bridge.push('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"id":"fc_2","type":"function_call","call_id":"call_2","name":"toolB"}}\n\n');
      out += bridge.push('event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"{\\"a\\":1}"}\n\n');
      out += bridge.push('event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc_2","delta":"{\\"b\\":2}"}\n\n');
      out += bridge.end();
      const chunks = out.split("\n\n").filter((s) => s.startsWith("data: {")).map((s) => JSON.parse(s.slice(6)));
      const argChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments);
      assert.equal(argChunks.length, 2);
      assert.equal(argChunks[0].choices[0].delta.tool_calls[0].index, 0);
      assert.equal(argChunks[0].choices[0].delta.tool_calls[0].function.arguments, '{"a":1}');
      assert.equal(argChunks[1].choices[0].delta.tool_calls[0].index, 1);
      assert.equal(argChunks[1].choices[0].delta.tool_calls[0].function.arguments, '{"b":2}');
    });

    // 5. maskSecrets masks YAML secrets and quoted values containing '#'
    await check("maskSecrets masks YAML key: value secrets and quoted values with #", () => {
      const y1 = maskSecrets("  TOKENPULSE_ROUTE: my-relay-secret-99887766");
      const y2 = maskSecrets("  DEEPSEEK_API_KEY: 'my-secret#12345678'");
      const t1 = maskSecrets('api_key = "abc#12345678"');
      assert.ok(!y1.includes("99887766"), "YAML unquoted secret masked: " + y1);
      assert.ok(!y2.includes("12345678"), "YAML quoted secret with # masked: " + y2);
      assert.ok(!t1.includes("12345678"), "TOML quoted secret with # masked: " + t1);
    });

    // 6. parseToml handles UTF-8 BOM
    await check("parseToml strips leading UTF-8 BOM", () => {
      const blocks = parseToml('\uFEFFmodel = "gpt-5"\n');
      assert.ok(blocks.length >= 1);
    });

    // 7. upstream-proxy bypassed handles IPv6 NO_PROXY
    await check("envProxyFor NO_PROXY handles bracketed and bare IPv6", () => {
      const env = { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "[2001:db8::1]:443,2001:db8::2" };
      assert.equal(envProxyFor(new URL("https://[2001:db8::1]/v1"), env), null);
      assert.equal(envProxyFor(new URL("https://[2001:db8::2]/v1"), env), null);
      assert.ok(envProxyFor(new URL("https://[2001:db8::3]/v1"), env) !== null);
    });

    // 8. fetchUpstreamModels rejects cleanly on mid-body abort instead of hanging
    await check("fetchUpstreamModels rejects on abrupt mid-body abort", async () => {
      const srv = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"data":[{"id":"a"');
        setTimeout(() => res.socket.destroy(), 30);
      });
      await new Promise((r) => srv.listen(0, "127.0.0.1", r));
      try {
        const port = srv.address().port;
        await Promise.race([
          assert.rejects(fetchUpstreamModels(`http://127.0.0.1:${port}`, ""), /连接中断|断开|socket|ECONNRESET|hang up/),
          new Promise((_, rej) => setTimeout(() => rej(new Error("fetchUpstreamModels hung!")), 2000)),
        ]);
      } finally {
        srv.close();
        srv.closeAllConnections?.();
      }
    });

    // 9. Proxy: Content-Encoding: identity, GET /v1/models passthrough across protocols, and rewriteModel without model field
    await check("agent-proxy handles Content-Encoding: identity, cross-protocol GET /v1/models, and non-model JSON POST", async () => {
      let lastPostBody = null;
      const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          if (req.url === "/v1/models") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-4o" }] }));
            return;
          }
          if (req.url === "/v1/chat/completions") {
            res.writeHead(200, { "content-type": "application/json", "content-encoding": "identity" });
            res.end(JSON.stringify({ id: "cmpl_1", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
            return;
          }
          lastPostBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
      const upPort = upstream.address().port;
      const proxy = startAgentProxy({
        host: "127.0.0.1",
        port: 0,
        targets: (app) =>
          app === "claude"
            ? [{ id: "p1", name: "oai", upstream: "openai-chat", baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: "k", model: "gpt-4o" }]
            : [{ id: "p2", name: "same", upstream: "openai-responses", baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: "k", model: "grok-4" }],
        log: () => {},
        fail: () => {},
        succeed: () => {},
        open: () => false,
      });
      const proxyPort = await proxy.listen();
      try {
        // 9a. GET /claude/v1/models should NOT be mangled into Anthropic message
        const modelsRes = await fetch(`http://127.0.0.1:${proxyPort}/claude/v1/models`);
        assert.equal(modelsRes.status, 200);
        const modelsJson = await modelsRes.json();
        assert.equal(modelsJson.object, "list");
        assert.equal(modelsJson.data[0].id, "gpt-4o");

        // 9b. Content-Encoding: identity on converted request should succeed 200, not 502
        const msgRes = await fetch(`http://127.0.0.1:${proxyPort}/claude/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-opus-4", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(msgRes.status, 200);
        const msgJson = await msgRes.json();
        assert.equal(msgJson.content[0].text, "ok");

        // 9c. Same-protocol POST without model field should NOT have model injected
        const sigRes = await fetch(`http://127.0.0.1:${proxyPort}/grok/v1/signals`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event: "ping" }),
        });
        assert.equal(sigRes.status, 200);
        assert.equal("model" in lastPostBody, false, "should not inject model field into non-model JSON POST");
      } finally {
        await proxy.close();
        upstream.close();
        upstream.closeAllConnections?.();
      }
    });

    // 10. tunnelPass graceful WebSocket close flushes queued compressed messages
    await check("tunnelPass flushes queued permessage-deflate frames on clean upstream close", async () => {
      const wss = new WebSocket.WebSocketServer({ port: 0, host: "127.0.0.1", perMessageDeflate: true });
      await new Promise((r) => wss.once("listening", r));
      const upPort = wss.address().port;
      wss.on("connection", (ws) => {
        ws.on("message", () => {
          for (let i = 0; i < 5; i++) ws.send(JSON.stringify({ type: "response.output_text.delta", delta: `chunk-${i}-` + "x".repeat(2000) }));
          ws.send(JSON.stringify({ type: "response.completed", response: { id: "r1", usage: { input_tokens: 10, output_tokens: 20 } } }));
          ws.close(1000, "done");
        });
      });
      const proxy = startAgentProxy({
        host: "127.0.0.1",
        port: 0,
        targets: () => [],
        log: () => {},
        fail: () => {},
        succeed: () => {},
        open: () => true,
        pass: () => `http://127.0.0.1:${upPort}`,
      });
      const proxyPort = await proxy.listen();
      try {
        const received = [];
        let closeCode = 0;
        await new Promise((resolve, reject) => {
          const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/pass/codex/responses`, { perMessageDeflate: true });
          client.on("open", () => client.send(JSON.stringify({ type: "response.create", model: "gpt-5" })));
          client.on("message", (d) => received.push(JSON.parse(d.toString())));
          client.on("close", (code) => { closeCode = code; resolve(); });
          client.on("error", reject);
        });
        assert.equal(received.length, 6, "all 6 compressed frames delivered before close");
        assert.equal(received[5].type, "response.completed");
        assert.equal(closeCode, 1000, "clean close code preserved");
      } finally {
        await proxy.close();
        wss.close();
      }
    });

    // 11. agent-switch: DeepSeek refs: {}, restoreProxy preserving direct third-party config, Codex false exclusive cleanup, activateProvider stops idle pass proxy
    await check("agent-switch handles DeepSeek refs: {}, restoreProxy preserves direct config, Codex false exclusive, stops idle pass proxy", async () => {
      const dshDir = path.join(process.env.HOME, ".dsh");
      fs.mkdirSync(dshDir, { recursive: true });
      fs.writeFileSync(path.join(dshDir, ".credentials.yaml"), "refs: {}\n", "utf8");
      const dsId = agentSwitch.saveProvider({
        app: "deepseek",
        name: "MyRelay",
        baseUrl: "https://relay.example.com/v1",
        apiKey: "ds-key-12345678",
        upstream: "openai-chat",
        model: "deepseek-chat",
      });
      await agentSwitch.activateProvider(dsId);
      const cred1 = fs.readFileSync(path.join(dshDir, ".credentials.yaml"), "utf8");
      assert.ok(cred1.includes("TOKENPULSE_ROUTE: ds-key-12345678"), "wrote ref into refs: {}");

      // Enable local route, make an external edit to cordis.patch.yml and .credentials.yaml, then disable local route
      await agentSwitch.setAppProxy("deepseek", true);
      const patchFile = path.join(dshDir, "cordis.patch.yml");
      fs.writeFileSync(patchFile, fs.readFileSync(patchFile, "utf8") + "\n- id: user-plugin\n", "utf8");
      fs.writeFileSync(path.join(dshDir, ".credentials.yaml"), fs.readFileSync(path.join(dshDir, ".credentials.yaml"), "utf8") + "  OTHER_KEY: keepme\n", "utf8");
      await agentSwitch.setAppProxy("deepseek", false);
      const patchAfter = fs.readFileSync(patchFile, "utf8");
      const credAfter = fs.readFileSync(path.join(dshDir, ".credentials.yaml"), "utf8");
      assert.ok(patchAfter.includes("https://relay.example.com/v1"), "direct third-party DeepSeek block restored");
      assert.ok(patchAfter.includes("user-plugin"), "user edit kept");
      assert.ok(credAfter.includes("TOKENPULSE_ROUTE: ds-key-12345678"), "direct third-party TOKENPULSE_ROUTE restored");
      assert.ok(credAfter.includes("OTHER_KEY: keepme"), "other ref kept");

      // Codex boolean false exclusive cleanup (import existing config with model_supports_reasoning_summaries = false)
      const codexDir = path.join(process.env.HOME, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(
        path.join(codexDir, "config.toml"),
        [
          'model_provider = "myrelay"',
          'model = "gpt-5"',
          "model_supports_reasoning_summaries = false",
          "[model_providers.myrelay]",
          'name = "CodexRelay"',
          'base_url = "https://codex.example.com/v1"',
          'wire_api = "responses"',
          'experimental_bearer_token = "cx-key"',
          "requires_openai_auth = false",
          "",
        ].join("\n"),
        "utf8",
      );
      const codexId = agentSwitch.importCurrent("codex");
      await agentSwitch.activateProvider(codexId);
      const codexToml1 = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
      assert.ok(codexToml1.includes("model_supports_reasoning_summaries = false"));
      const officialCodex = agentSwitch.agentView().providers.find((p) => p.app === "codex" && p.official);
      await agentSwitch.activateProvider(officialCodex.id);
      const codexToml2 = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
      assert.ok(!codexToml2.includes("model_supports_reasoning_summaries"), "false exclusive setting removed on switch back");

      // activateProvider stops idle proxy when switching from pass-through to direct third-party
      await agentSwitch.setAppPass("claude", true);
      assert.equal(agentSwitch.agentView().proxy.running, true);
      const claudeDirectId = agentSwitch.saveProvider({
        app: "claude",
        name: "ClaudeDirect",
        baseUrl: "https://anth.example.com",
        apiKey: "ant-key",
        upstream: "anthropic",
        model: "claude-opus-4",
      });
      await agentSwitch.activateProvider(claudeDirectId);
      assert.equal(agentSwitch.agentView().proxy.running, false, "proxy stopped when pass-through disabled by direct switch");
    });

    // 12. pool-insight counts HTTP 402 as limited
    await check("poolRows counts HTTP 402 as limited", () => {
      const { routeLogDir } = require("../build/core/route-ledger.js");
      const logDir = routeLogDir();
      fs.mkdirSync(logDir, { recursive: true });
      const now = Date.now();
      const month = `${new Date(now).getFullYear()}-${String(new Date(now).getMonth() + 1).padStart(2, "0")}.jsonl`;
      fs.writeFileSync(
        path.join(logDir, month),
        JSON.stringify({ at: now - 1000, app: "grok", pool: true, poolId: "p-grok", providerId: "p-grok@acc1", provider: "Pool · A", status: 402, ms: 100, model: "grok-4" }) + "\n",
      );
      const rows = poolRows({ id: "p-grok", app: "grok", name: "Pool", strategy: "quota", members: [{ key: "p-grok@acc1", type: "account", id: "acc1", name: "A" }] }, now - 3600_000, now);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].limited, true);
    });

    // 13. prism-bridge Windows reg query string has proper backslashes
    await check("prism-bridge reg query path keeps backslashes in compiled JS", () => {
      const js = fs.readFileSync(path.join(__dirname, "..", "build", "core", "prism-bridge.js"), "utf8");
      assert.ok(js.includes("HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\Shell\\\\Associations\\\\UrlAssociations\\\\https\\\\UserChoice"), "registry path properly escaped");
    });

    console.log(`\nWave 1: ${passed}/${passed + failed} passed`);
    if (failed > 0) process.exit(1);
  } finally {
    try { agentSwitch.releaseAgentSwitch(); await agentSwitch.waitAgentProxyClosed(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
