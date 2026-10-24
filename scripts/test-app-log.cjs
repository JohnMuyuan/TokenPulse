/**
 * 统一运行日志 + curl 请求记录 + 429 识别。跑法（先 npm run compile）：
 *
 *   node scripts/test-app-log.cjs
 *
 * 用一次性的数据目录；curl 走真实的 curl，但只请求本机临时开的 HTTP 服务，不访问任何官方接口。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-app-log-"));
process.env.TOKENPULSE_DATA_DIR = path.join(root, "data");
// 本机地址不能被用户环境里的代理接走
process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost";

const build = (file) => require(path.join(__dirname, "..", "build", ...file.split("/")));
const appLog = build("core/app-log.js");
const curl = build("core/curl.js");
const proxy = build("core/upstream-proxy.js");
proxy.setSystemProxyResolver(async () => "DIRECT");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const readLog = () => { try { return fs.readFileSync(appLog.appLogFile(), "utf8"); } catch { return ""; } };
const TOKEN = "sk-ant-oat01-" + "Q".repeat(60);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/ok") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"five_hour":{"utilization":3}}'); return; }
  if (url.pathname === "/limited") { res.writeHead(429, { "content-type": "application/json", "retry-after": "180" }); res.end('{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}'); return; }
  if (url.pathname === "/down") { res.writeHead(503, { "content-type": "text/html" }); res.end("<html>Service Unavailable</html>"); return; }
  if (url.pathname === "/html") { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>blocked by proxy</html>"); return; }
  if (url.pathname === "/auth") { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"unauthorized"}'); return; }
  res.writeHead(404); res.end();
});

(async () => {
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    // ---- 格式与脱敏 ----
    appLog.log.info("test", `第一行\n第二行 ${os.homedir()}\\x https://claude.ai/oauth/authorize?code=SECRET1 friend@example.com Authorization: Bearer abc.def ${TOKEN}`);
    const first = readLog();
    check("一行一件事：本地时间、级别、分类；多行拆成多行", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} INFO  \[test\] 第一行\n\d{4}.* INFO  \[test\] 第二行 /.test(first), first.slice(0, 120));
    check("脱敏：家目录、链接参数、邮箱、Authorization、长 token",
      first.includes("~\\x") && !first.includes(os.homedir()) && !first.includes("SECRET1") && first.includes("f***@example.com") && !first.includes("abc.def") && !first.includes("QQQQQQQQ"), first);
    check("logUrl 只留域名和路径", appLog.logUrl("https://api.example.com/v1/x?key=SECRET#frag") === "https://api.example.com/v1/x");
    check("errorText：execFile 的错误取 stderr，不带命令行", appLog.errorText(Object.assign(new Error(`Command failed: curl.exe -H Authorization: Bearer ${TOKEN}`), { stderr: "curl: (7) Failed to connect\n" })) === "curl: (7) Failed to connect");
    check("errorText：没有 stderr 也不把命令行带出来", !appLog.errorText(Object.assign(new Error(`Command failed: curl.exe ${TOKEN}`), { code: 6 })).includes("QQQQ"));

    // ---- 响应头解析 ----
    const split = curl.splitHeaders("HTTP/1.1 200 Connection established\r\n\r\nHTTP/1.1 429 Too Many Requests\r\nRetry-After: 30\r\nContent-Type: application/json\r\n\r\n{\"a\":1}");
    check("经代理时剥掉 CONNECT 那段，留最后一段响应头", split.headers["retry-after"] === "30" && split.body === '{"a":1}', JSON.stringify(split));
    check("Retry-After：秒数和 HTTP 日期都认", curl.parseRetryAfter("120") === 120_000 && curl.parseRetryAfter(new Date(Date.now() + 60_000).toUTCString()) > 50_000 && curl.parseRetryAfter("") === undefined);

    // ---- 真实 curl ----
    const headers = [`Authorization: Bearer ${TOKEN}`];
    const ok = await curl.curlJson(`${base}/ok?token=SECRET2`, headers);
    check("200 JSON 正常返回", ok.five_hour?.utilization === 3, JSON.stringify(ok));
    let limited;
    try { await curl.curlJson(`${base}/limited`, headers); } catch (error) { limited = error; }
    check("429：抛 HttpError，带状态码、Retry-After 和错误类型；message 还是 http 429",
      limited instanceof curl.HttpError && limited.status === 429 && limited.retryAfterMs === 180_000 && limited.errorType === "rate_limit_error" && limited.message === "http 429", String(limited?.stack || limited));
    let down;
    try { await curl.curlJson(`${base}/down`, headers); } catch (error) { down = error; }
    check("503 返回 HTML：按 HTTP 503 报，不当成「不是 JSON」", down instanceof curl.HttpError && down.status === 503, String(down));
    let html;
    try { await curl.curlJson(`${base}/html`, headers); } catch (error) { html = error; }
    check("200 但返回 HTML：not json", html?.message === "not json", String(html));
    let auth;
    try { await curl.curlJson(`${base}/auth`, headers); } catch (error) { auth = error; }
    check("401：还是 auth", auth?.message === "auth", String(auth));
    let refused;
    try { await curl.curlJson("http://127.0.0.1:9/nothing", headers, 8000); } catch (error) { refused = error; }
    check("连不上：照样抛出原错误", Boolean(refused));
    const post = await curl.curlPost(`${base}/limited`, `refresh_token=${TOKEN}`, ["Content-Type: application/x-www-form-urlencoded"]);
    check("curlPost 照常返回状态码和 JSON", post.status === 429 && post.json?.error?.type === "rate_limit_error");

    const text = readLog();
    const net = text.split("\n").filter((line) => line.includes("[net]"));
    check("每个请求一行：方法、地址（去参数）、状态码、耗时",
      net.some((line) => /INFO  \[net\] GET http:\/\/127\.0\.0\.1:\d+\/ok → 200（\d+ ms）$/.test(line)) && !text.includes("SECRET2"), net.join(" | "));
    check("429 记 WARN，带错误类型和 Retry-After", net.some((line) => /WARN  \[net\] GET .*\/limited → 429（\d+ ms） rate_limit_error，Retry-After 180 秒/.test(line)), net.join(" | "));
    check("返回不是 JSON 时记下类型和大小", net.some((line) => /\/html → 200.*返回的不是 JSON（text\/html/.test(line)), net.join(" | "));
    check("连不上记 curl 自己的报错", net.some((line) => /GET http:\/\/127\.0\.0\.1:9\/nothing 失败（\d+ ms）：curl: \(\d+\)/.test(line)), net.join(" | "));
    check("POST 记一行，不记请求体", net.some((line) => /POST .*\/limited → 429/.test(line)));
    check("日志里没有 token", !text.includes("QQQQQQQQ") && !text.includes("Bearer s"), "");

    // ---- upstreamRequest ----
    await new Promise((resolve, reject) => {
      const req = proxy.upstreamRequest(new URL(`${base}/down?key=SECRET3`), null, { method: "GET" }, (res) => { res.resume(); res.on("end", resolve); });
      req.on("error", reject);
      req.end();
    });
    await new Promise((resolve) => {
      const req = proxy.upstreamRequest(new URL("http://127.0.0.1:9/x"), null, { method: "POST" }, () => resolve());
      req.on("error", () => resolve());
      req.end();
    });
    const after = readLog();
    check("Node 发的上游请求也记：本机地址失败和 4xx/5xx 记 WARN、去参数",
      /WARN  \[net\] GET http:\/\/127\.0\.0\.1:\d+\/down → 503（\d+ ms 收到响应头）/.test(after) && /WARN  \[net\] POST http:\/\/127\.0\.0\.1:9\/x 失败/.test(after) && !after.includes("SECRET3"), after.split("\n").slice(-3).join(" | "));

    // ---- 轮换 ----
    // 长串会被当 token 隐藏，填充用带空格的中文；每次写一小段，和平时一样
    const chunk = Array.from({ length: 30 }, (_, i) => `填充 ${i} ${"填充内容 ".repeat(60)}`).join("\n");
    for (let i = 0; i < 400; i++) appLog.log.info("fill", chunk);
    appLog.log.info("after", "轮换之后的一行");
    const dir = appLog.appLogDir();
    const files = fs.readdirSync(dir).sort();
    const sizes = files.map((name) => fs.statSync(path.join(dir, name)).size);
    check("超过 4 MB 轮换：最多 tokenpulse.log + 两份旧的，新行在新文件里",
      files.join(",") === "tokenpulse.1.log,tokenpulse.2.log,tokenpulse.log" && sizes.every((size) => size <= 4 * 1024 * 1024 + 1024) && readLog().includes("轮换之后的一行"), files.map((name, i) => `${name}:${sizes[i]}`).join(" "));

    // ---- 数据目录被删了：下次写自己建回来 ----
    fs.rmSync(dir, { recursive: true, force: true });
    appLog.log.warn("again", "第一次失败");
    appLog.log.warn("again", "目录建回来了");
    check("数据目录被删后写日志不报错，并会重新建目录", readLog().includes("目录建回来了"));

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} 通过`);
    assert.equal(failed, 0, "app log regression failed");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
    proxy.setSystemProxyResolver(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
