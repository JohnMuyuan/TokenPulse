/**
 * 透明转发的长连接（src/core/agent-proxy.ts 的 tunnelPass + src/core/ws-sniff.ts）：
 * WebSocket 握手保留应用头；消息载荷完整转发，两端分别协商压缩；读出型号、用量、首字延迟和速度。
 * 跑法（先 npm run compile）：node scripts/test-pass-socket.cjs
 * 上游是本机的假服务，不连任何真实接口。
 */
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const path = require("node:path");
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[key];
process.env.NO_PROXY = "127.0.0.1,localhost";
const { startAgentProxy } = require(path.join(__dirname, "..", "build", "core", "agent-proxy.js"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, what) => { for (let tries = 0; tries < 200; tries++) { if (check()) return; await delay(20); } throw new Error("等不到：" + what); };

/** 拼一个 WebSocket 帧。mask = 工具发出的帧（带掩码）。 */
function frame(payload, { mask = false, opcode = 1, fin = true, rsv1 = false } = {}) {
  const body = Buffer.from(payload);
  const head = [(fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode];
  if (body.length < 126) head.push((mask ? 0x80 : 0) | body.length);
  else if (body.length < 65536) head.push((mask ? 0x80 : 0) | 126, body.length >> 8, body.length & 255);
  else { const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(body.length)); head.push((mask ? 0x80 : 0) | 127, ...size); }
  if (!mask) return Buffer.concat([Buffer.from(head), body]);
  const key = crypto.randomBytes(4), masked = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index++) masked[index] = body[index] ^ key[index & 3];
  return Buffer.concat([Buffer.from(head), key, masked]);
}
/** permessage-deflate：一条连接一个压缩器（带上下文），每条消息去掉结尾的 00 00 ff ff。 */
function deflater() {
  const stream = zlib.createDeflateRaw();
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  return (text) => new Promise((resolve) => { stream.write(Buffer.from(text)); stream.flush(zlib.constants.Z_SYNC_FLUSH, () => { const out = Buffer.concat(chunks.splice(0)); resolve(out.subarray(0, out.length - 4)); }); });
}

/** 假的官方：记下握手和收到的字节；发什么由测试决定。 */
function fakeUpstream({ extensions = "", refuse = false } = {}) {
  const state = { handshakes: [], received: Buffer.alloc(0), sent: Buffer.alloc(0), socket: null };
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on("upgrade", (req, socket) => {
    state.handshakes.push({ url: req.url, headers: req.headers });
    if (refuse) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nX-Up: no\r\nContent-Length: 27\r\n\r\n{"error":"token_expired!!"}'); return; }
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Up-Thing: Kept\r\n${extensions ? `Sec-WebSocket-Extensions: ${extensions}\r\n` : ""}\r\n`);
    state.socket = socket;
    socket.on("data", (chunk) => { state.received = Buffer.concat([state.received, chunk]); });
    socket.on("error", () => undefined);
  });
  state.send = (bytes) => { state.sent = Buffer.concat([state.sent, bytes]); state.socket.write(bytes); };
  state.listen = () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  state.close = () => { state.socket?.destroy(); server.close(); server.closeAllConnections?.(); };
  return state;
}
/** 假的工具：用裸 socket 发握手，之后收发原始字节。 */
function connect(port, url, headers) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const client = { socket, head: "", received: Buffer.alloc(0), sent: Buffer.alloc(0), closed: false };
    let raw = Buffer.alloc(0), opened = false;
    socket.on("connect", () => socket.write(`GET ${url} HTTP/1.1\r\n` + Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join("") + "\r\n"));
    socket.on("data", (chunk) => {
      if (opened) { client.received = Buffer.concat([client.received, chunk]); return; }
      raw = Buffer.concat([raw, chunk]);
      const end = raw.indexOf("\r\n\r\n");
      if (end < 0) return;
      opened = true; client.head = raw.subarray(0, end).toString("latin1"); client.received = raw.subarray(end + 4);
      resolve(client);
    });
    socket.on("close", () => { client.closed = true; });
    socket.on("error", reject);
    client.send = (bytes) => { client.sent = Buffer.concat([client.sent, bytes]); socket.write(bytes); };
  });
}

async function sameMessages(actual, expected, compressed) {
  const { WsReader } = require('../build/core/ws-sniff');
  const decode = async buffer => { const messages = []; const reader = new WsReader(compressed, m => { if (m.text) messages.push([m.head, m.tail]); }); reader.push(buffer); await delay(100); reader.stop(); return messages; };
  assert.deepEqual(await decode(actual), await decode(expected), 'application messages survive frame rebuilding and independent compression');
}
(async () => {
  const logs = [];
  let target = null;
  const seenHeaders = [];
  const proxy = startAgentProxy({ host: "127.0.0.1", port: 0, targets: () => [], log: (entry) => logs.push(entry), fail: () => {}, succeed: () => {}, open: () => true,
    pass: (app, headers) => { seenHeaders.push(headers); return app === "codex" && target ? `http://127.0.0.1:${target}/backend-api/codex` : null; } });
  const port = await proxy.listen();
  const key = crypto.randomBytes(16).toString("base64");
  const headers = { Host: `127.0.0.1:${port}`, Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13", Authorization: "Bearer eyJTESTJWT", "chatgpt-account-id": "acct-test", "OpenAI-Beta": "responses_websockets=2026-02-06", originator: "codex_cli_rs", "User-Agent": "codex_cli_rs/9.9", "x-custom-thing": "kept" };
  const request = (text, model) => JSON.stringify({ type: "response.create", model, service_tier: model === "gpt-qa-mini" ? "default" : "priority", reasoning: { effort: "high" }, input: [{ role: "user", content: [{ type: "input_text", text }] }] });
  // 回复很长（解压后二十多万字）、用量在最后：压缩连接上也要读得到
  const filler = Array.from({ length: 6000 }, (_, index) => `reply-text line ${index} ${(index * 7919).toString(36)}`).join(" ");
  const completed = (output) => JSON.stringify({ type: "response.completed", response: { id: "resp_1", tool_usage: { image_gen: { input_tokens: 0, input_tokens_details: { image_tokens: 0, text_tokens: 0 }, output_tokens: 0, output_tokens_details: { image_tokens: 0, text_tokens: 0 }, total_tokens: 0 } }, output: [{ type: "message", content: [{ type: "output_text", text: "hello reply-text " + filler }] }], usage: { input_tokens: 5000, input_tokens_details: { cached_tokens: 4000 }, output_tokens: output, output_tokens_details: { reasoning_tokens: 100 }, total_tokens: 5000 + output }, metadata: { trailing: "after-usage ".repeat(4000) } } });
  try {
    /* ---------- 不压缩 ---------- */
    const up = fakeUpstream();
    target = await up.listen();
    const client = await connect(port, "/pass/codex/responses?x=1", headers);
    // 握手：官方收到的头和工具发的一样（只有 host 是官方自己的）；工具收到的是官方的回复，一个头不差
    const shake = up.handshakes[0];
    assert.equal(shake.url, "/backend-api/codex/responses?x=1");
    for (const [name, value] of Object.entries(headers)) if (!["Host", "Sec-WebSocket-Key"].includes(name)) assert.equal(shake.headers[name.toLowerCase()], value, "握手的头原样带过去：" + name);
    assert.equal(shake.headers.host, `127.0.0.1:${target}`);
    assert.deepEqual(Object.keys(shake.headers).filter((name) => !Object.keys(headers).some((own) => own.toLowerCase() === name)), [], "握手没有多加别的头");
    assert.match(client.head, /^HTTP\/1\.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: [^\r]+\r\nX-Up-Thing: Kept$/, "官方的握手回复原样还给工具（顺序、大小写都不变）");
    assert.equal(seenHeaders[0]["chatgpt-account-id"], "acct-test", "选官方地址时能看到请求头");

    // 第一次请求：工具发一条带掩码的大消息（分两帧），官方过 300 毫秒才开始回
    const first = Buffer.from(request("秘密内容 secret-text " + "x".repeat(70000), "gpt-qa-model"));
    client.send(frame(first.subarray(0, 30000), { mask: true, fin: false }));
    client.send(frame("", { mask: true, opcode: 9 })); // 夹在分片中间的 ping
    client.send(frame(first.subarray(30000), { mask: true, opcode: 0 }));
    await until(() => up.received.length > 0, "官方收到第一次请求");
    await delay(300);
    // response.created 里带着整段系统提示词，型号排在它后面很远：也要读得到
    up.send(frame(JSON.stringify({ type: "response.created", response: { id: "resp_0a1b2c3d4e5f", object: "response", instructions: "sys ".repeat(9000), model: "gpt-qa-model-2026-01-01", output: [] } })));
    await delay(150);
    up.send(frame(JSON.stringify({ type: "response.output_item.added", item: { type: "message" } })));
    up.send(frame(JSON.stringify({ type: "response.output_text.delta", delta: "hello " })));
    await delay(250);
    up.send(frame(completed(300)));
    await until(() => logs.length === 1, "第一次请求的记录");
    const firstForwardedBytes = up.received.length;
    // 第二次请求走同一条连接；这次官方报错
    client.send(frame(request("second", "gpt-qa-mini"), { mask: true }));
    await until(() => up.received.length > firstForwardedBytes, "官方收到第二次请求");
    up.send(frame(JSON.stringify({ type: "error", status: 429, error: { type: "usage_limit_reached", message: "limit reached synthetic-private-echo Bearer synthetic-test-token" } })));
    await until(() => logs.length === 2 && client.received.length > 0, "第二次请求的记录");
    await sameMessages(up.received, client.sent, false);
    await sameMessages(client.received, up.sent, false);

    const [one, two] = logs;
    assert.deepEqual([one.pass, one.app, one.method, one.path, one.status, one.model, one.effort, one.input, one.output, one.cacheRead, one.host], [true, "codex", "WS", "/responses", 200, "gpt-qa-model", "high", 5000, 300, 4000, `127.0.0.1:${target}`]);
    assert.ok(one.firstByteMs >= 280 && one.firstByteMs < 1500, "首字节延迟约 300 毫秒：" + one.firstByteMs);
    assert.ok(one.firstTokenMs >= one.firstByteMs + 120, "第一段内容比第一个字节晚：" + one.firstTokenMs);
    // 开始出字 = 第一个 output_item.added（和第一段内容同时到），不是 response.created
    const expected = 300 / ((one.ms - one.firstTokenMs) / 1000);
    assert.ok(Math.abs(one.tokensPerSec - expected) / expected < 0.25, `速度 = 输出 ÷ 出字用的时间：${one.tokensPerSec} / ${expected.toFixed(1)}`);
    assert.ok(one.requestBytes === first.length && one.responseBytes > 100);
    assert.deepEqual([one.responseId, one.returnedModel, one.requestModel, two.responseId ?? null], ["resp_0a1b2c3d4e5f", "gpt-qa-model-2026-01-01", "gpt-qa-model", null], "响应 ID 和上游实际用的型号（型号核验用）");
    assert.deepEqual([two.status, two.model, two.error, two.tokensPerSec ?? null], [429, "gpt-qa-mini", "HTTP 429 · error", null]);
    assert.equal(/synthetic-private-echo|synthetic-test-token/.test(JSON.stringify(logs)), false, "WebSocket 错误正文的敏感回显不进入日志");
    assert.deepEqual([one.tier, two.tier ?? null], ["priority", null], "快速模式（service_tier）记下来，默认档不记");
    assert.equal(/TESTJWT|acct-test|secret-text|reply-text|second/.test(JSON.stringify(logs)), false, "记录里没有凭据、请求内容和回复内容");
    console.log("PASS pass-through socket: authentication/custom handshake headers and application messages preserved in both directions; model, tokens, delays and speed read on the side for each request on the connection");

    // 回复到一半连接断了：记一条没完成的
    const secondForwardedBytes = up.received.length;
    client.send(frame(request("third", "gpt-qa-model"), { mask: true }));
    await until(() => up.received.length > secondForwardedBytes, "官方收到第三次请求");
    up.send(frame(JSON.stringify({ type: "response.created" })));
    await delay(50);
    up.socket.destroy();
    await until(() => logs.length === 3 && client.closed, "断开的记录");
    assert.deepEqual([logs[2].status, logs[2].error], [499, "连接在回复完成前关闭"]);
    up.close();

    /* ---------- 协商了压缩（permessage-deflate） ---------- */
    logs.length = 0;
    const packed = fakeUpstream({ extensions: "permessage-deflate" });
    target = await packed.listen();
    const zipClient = await connect(port, "/pass/codex/responses", { ...headers, "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits" });
    assert.equal(packed.handshakes[0].headers["sec-websocket-extensions"], "permessage-deflate; client_max_window_bits");
    assert.match(zipClient.head, /Sec-WebSocket-Extensions: permessage-deflate/);
    const squeezeUp = deflater(), squeezeDown = deflater();
    for (const [model, output] of [["gpt-zip-a", 120], ["gpt-zip-b", 90]]) {
      const beforePackedBytes = packed.received.length;
      zipClient.send(frame(await squeezeUp(request("zip " + "y".repeat(5000), model)), { mask: true, rsv1: true }));
      await until(() => packed.received.length > beforePackedBytes, "官方收到压缩的请求");
      packed.send(frame(await squeezeDown(JSON.stringify({ type: "response.created" })), { rsv1: true }));
      await delay(260);
      packed.send(frame(await squeezeDown(completed(output)), { rsv1: true }));
      await until(() => logs.some((entry) => entry.model === model), "压缩连接的记录 " + model);
    }
    await sameMessages(packed.received, zipClient.sent, true);
    await sameMessages(zipClient.received, packed.sent, true);
    assert.deepEqual(logs.map((entry) => [entry.status, entry.model, entry.input, entry.output, entry.cacheRead, entry.tokensPerSec > 0]), [[200, "gpt-zip-a", 5000, 120, 4000, true], [200, "gpt-zip-b", 5000, 90, 4000, true]]);
    zipClient.socket.destroy(); packed.close();
    console.log("PASS pass-through socket: compressed application messages preserved with independent contexts; a reply cut short is recorded as unfinished");

    /* ---------- 官方不同意升级 / 没开 ---------- */
    logs.length = 0;
    const closed = fakeUpstream({ refuse: true });
    target = await closed.listen();
    const refused = await connect(port, "/pass/codex/responses", headers);
    await until(() => refused.closed && logs.length === 1, "被拒绝的握手");
    assert.match(refused.head, /^HTTP\/1\.1 401 Unauthorized\r\nContent-Type: application\/json\r\nX-Up: no\r\nContent-Length: 27\r\nconnection: close$/);
    assert.equal(refused.received.toString(), '{"error":"token_expired!!"}');
    assert.deepEqual([logs[0].status, logs[0].error], [401, 'HTTP 401']);
    closed.close();
    target = null;
    const off = await connect(port, "/pass/codex/responses", headers);
    assert.match(off.head, /^HTTP\/1\.1 404 Not Found/);
    const other = await connect(port, "/codex/v1/responses", headers);
    assert.match(other.head, /^HTTP\/1\.1 404 Not Found/);
    console.log("PASS pass-through socket: a refused handshake is returned as it is; off means 404");
  } finally { await proxy.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
