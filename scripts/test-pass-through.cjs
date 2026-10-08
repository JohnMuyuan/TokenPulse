/**
 * 透明转发（src/core/agent-proxy.ts 的 forwardPass）：原样转发、计时、读回复里的 Token 数。
 * 跑法（先 npm run compile）：node scripts/test-pass-through.cjs
 * 上游是本机的假服务，不连任何真实接口。
 */
const assert = require("node:assert/strict");
const http = require("node:http");
const zlib = require("node:zlib");
const path = require("node:path");
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[key];
process.env.NO_PROXY = "127.0.0.1,localhost";
const { startAgentProxy } = require(path.join(__dirname, "..", "build", "core", "agent-proxy.js"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (handler) => new Promise((resolve) => { const server = http.createServer(handler); server.listen(0, "127.0.0.1", () => resolve(server)); });
const send = (port, { method = "POST", url, headers = {}, body }) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, method, path: url, headers }, (res) => { const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); });
  req.on("error", reject); req.end(body);
});

(async () => {
  const hits = [];
  // 流式回复：先停 300 毫秒才出第一个字节，再分几段发，用量在最后；用 gzip 压着发
  const sse = ['event: message_start\ndata: {"type":"message_start","message":{"model":"claude-qa-20260101","id":"msg_01QAqaQAqaQAqaQAqaQAqaQA","usage":{"input_tokens":1200,"cache_read_input_tokens":900,"output_tokens":1}}}\n\n', 'event: content_block_delta\ndata: {"delta":{"text":"hello"}}\n\n', 'event: message_delta\ndata: {"usage":{"output_tokens":240}}\n\n'];
  const upstream = await listen((req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      if (req.url.startsWith("/v1/fail")) { res.writeHead(429, { "content-type": "application/json", "retry-after": "7", "x-upstream": "yes" }); res.end('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'); return; }
      if (req.url.startsWith("/v1/plain")) { res.writeHead(200, { "content-type": "application/json", "request-id": "req_plain" }); res.end('{"usage":{"input_tokens":5,"output_tokens":3}}'); return; }
      const gzip = zlib.createGzip();
      res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip", "request-id": "req_abc", "anthropic-ratelimit-unified-status": "allowed" });
      gzip.pipe(res);
      await delay(300);
      for (const part of sse) { gzip.write(part); gzip.flush(); await delay(150); }
      gzip.end();
    });
  });
  const logs = [];
  let on = true;
  const proxy = startAgentProxy({ host: "127.0.0.1", port: 0, targets: () => [], log: (entry) => logs.push(entry), fail: () => {}, succeed: () => {}, open: () => true,
    pass: (app) => (on && app === "claude" ? `http://127.0.0.1:${upstream.address().port}` : null) });
  const port = await proxy.listen();
  try {
    const body = Buffer.from(JSON.stringify({ model: "claude-qa", stream: true, speed: "fast", thinking: { type: "adaptive" }, output_config: { effort: "xhigh" }, messages: [{ role: "user", content: "秘密内容 secret-text" }] }));
    const headers = { authorization: "Bearer sk-ant-oat-TESTTOKEN", "anthropic-beta": "oauth-2025-04-20,x", "anthropic-version": "2023-06-01", "user-agent": "claude-cli/9.9 (external, cli)", "x-app": "cli", "x-custom-thing": "kept", "accept-encoding": "gzip, br", "content-type": "application/json", "content-length": String(body.length) };
    const reply = await send(port, { url: "/pass/claude/v1/messages?beta=true", headers, body });

    // 上游收到的和工具发出的一样：路径和查询、凭据、每一个头、正文的每一个字节
    const hit = hits[0];
    assert.equal(hit.method, "POST"); assert.equal(hit.url, "/v1/messages?beta=true");
    for (const [key, value] of Object.entries(headers)) assert.equal(hit.headers[key], value, "请求头原样带过去：" + key);
    assert.equal(hit.headers.host, `127.0.0.1:${upstream.address().port}`, "host 是上游自己的");
    assert.deepEqual(Object.keys(hit.headers).filter((key) => !(key in headers) && !["host", "connection"].includes(key)), [], "没有多加别的头");
    assert.ok(hit.body.equals(body), "正文一个字节都不动");
    // 工具收到的和上游发出的一样：状态码、头、仍然是压缩着的正文
    assert.equal(reply.status, 200);
    assert.deepEqual([reply.headers["content-type"], reply.headers["content-encoding"], reply.headers["request-id"], reply.headers["anthropic-ratelimit-unified-status"]], ["text/event-stream", "gzip", "req_abc", "allowed"]);
    assert.equal(zlib.gunzipSync(reply.body).toString("utf8"), sse.join(""), "回复原样送回（没有解压、没有改写）");
    await delay(50);
    // 记下来的：时间、型号、首字延迟、Token 数、速度；没有凭据和内容
    const log = logs[0];
    assert.deepEqual([log.pass, log.app, log.status, log.requestModel, log.stream, log.path, log.method, log.input, log.output, log.cacheRead], [true, "claude", 200, "claude-qa", true, "/v1/messages", "POST", 1200, 240, 900]);
    assert.ok(log.firstByteMs >= 280 && log.firstByteMs < 1500, "首字延迟约 300 毫秒：" + log.firstByteMs);
    assert.ok(log.ms >= log.firstByteMs + 250, "总耗时比首字延迟长");
    // 型号核验用：回复里的响应 ID 和上游实际用的型号
    assert.equal(log.tier, "fast", "快速模式记下来");
    assert.equal(log.effort, "xhigh", "Claude Code 的思考等级在 output_config.effort 里（0.3.39）");
    assert.deepEqual([log.responseId, log.returnedModel], ["msg_01QAqaQAqaQAqaQAqaQAqaQA", "claude-qa-20260101"]);
    const expected = 240 / ((log.ms - log.firstByteMs) / 1000);
    assert.ok(Math.abs(log.tokensPerSec - expected) / expected < 0.25, `速度 = 输出 ÷ 出字用的时间：${log.tokensPerSec} / ${expected.toFixed(1)}`);
    assert.equal(JSON.stringify(logs).includes("TESTTOKEN") || JSON.stringify(logs).includes("secret-text") || JSON.stringify(logs).includes("hello"), false, "记录里没有凭据、请求内容和回复内容");
    console.log("PASS pass-through: request and reply forwarded byte for byte with every header; first-byte delay, tokens and tokens per second recorded; no credentials or content kept");

    // 上游报错：状态码、头、正文原样还给工具，不重试
    const failed = await send(port, { url: "/pass/claude/v1/fail", headers, body });
    assert.deepEqual([failed.status, failed.headers["retry-after"], failed.headers["x-upstream"], JSON.parse(failed.body).error.message], [429, "7", "yes", "slow down"]);
    assert.equal(hits.filter((item) => item.url.startsWith("/v1/fail")).length, 1, "不重试");
    await delay(30);
    assert.deepEqual([logs[1].status, logs[1].tokensPerSec ?? null, logs[1].error], [429, null, 'HTTP 429']);
    // 没压缩的普通回复也能读到用量；输出太少不算速度
    const plain = await send(port, { url: "/pass/claude/v1/plain", headers, body });
    assert.equal(plain.headers["request-id"], "req_plain"); await delay(30);
    assert.deepEqual([logs[2].input, logs[2].output, logs[2].tokensPerSec ?? null, logs[2].responseId ?? null, logs[1].returnedModel ?? null], [5, 3, null, null, null], "没有响应 ID 的回复、报错的回复不记返回型号");
    // 只接 /pass/<工具>/；别的工具没开、或者整个关掉时是 404，不会转到任何地方
    const before = hits.length;
    assert.equal((await send(port, { url: "/pass/grok/v1/responses", headers, body })).status, 404);
    on = false;
    assert.equal((await send(port, { url: "/pass/claude/v1/messages", headers, body })).status, 404);
    assert.equal(hits.length, before);
    console.log("PASS pass-through: upstream errors returned as they are without retrying, plain replies read too, off means 404");

    // 0.3.36：本地路由（第三方供应商、号池）的请求本来就经过这里，同样量首字延迟和速度
    const routed = [];
    const relay = await listen(async (req, res) => {
      req.resume();
      await delay(250);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"message_start","message":{"model":"claude-relay","id":"msg_01RELAYrelayRELAYrelayRE","usage":{"input_tokens":70,"output_tokens":1}}}\n\n');
      await delay(120);
      res.write('data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n');
      await delay(300);
      res.end('data: {"type":"message_delta","usage":{"output_tokens":120}}\n\n');
    });
    const route = startAgentProxy({ host: "127.0.0.1", port: 0, log: (entry) => routed.push(entry), fail: () => {}, succeed: () => {}, open: () => false,
      targets: () => [{ id: "relay-1", name: "Relay", upstream: "anthropic", baseUrl: `http://127.0.0.1:${relay.address().port}`, apiKey: "sk-relay", model: "" }] });
    const routePort = await route.listen();
    try {
      const got = await send(routePort, { url: "/claude/v1/messages", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ model: "claude-qa", stream: true, messages: [] })) });
      assert.equal(got.status, 200);
      await delay(40);
      const entry = routed[0];
      assert.deepEqual([entry.pass ?? null, entry.provider, entry.status, entry.output, entry.returnedModel], [null, "Relay", 200, 120, "claude-relay"]);
      assert.ok(entry.firstByteMs >= 230 && entry.firstTokenMs >= entry.firstByteMs + 100, `本地路由也有首字延迟：${entry.firstByteMs} / ${entry.firstTokenMs}`);
      const speed = 120 / ((entry.ms - entry.firstByteMs) / 1000);
      assert.ok(Math.abs(entry.tokensPerSec - speed) / speed < 0.3, `本地路由也有速度：${entry.tokensPerSec} / ${speed.toFixed(1)}`);
    } finally { await route.close(); relay.close(); relay.closeAllConnections?.(); }
    console.log("PASS local routing measures first-content delay and tokens per second too");
  } finally { await proxy.close(); upstream.close(); upstream.closeAllConnections?.(); }
})().catch((error) => { console.error(error); process.exit(1); });
