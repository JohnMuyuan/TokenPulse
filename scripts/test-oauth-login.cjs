/**
 * 官方账号 OAuth 登录流程 + 登录日志。跑法（先 npm run compile）：
 *
 *   node scripts/test-oauth-login.cjs
 *
 * 用假的 claude.cmd / codex.cmd（node 脚本）走一遍 runLogin，不开浏览器、不联网、不碰用户真实的 CLI 登录和 ~/.tokenpulse。
 * 盯的坑：
 *   - 0.3.60～0.3.61：登录时 Claude 的账号资料写在 临时目录/.claude/.claude.json，却去读 临时目录/.claude.json，
 *     新登录的账号没有邮箱、身份退回 token 哈希；资料比凭据晚写时也要等它；
 *   - 只开了系统代理的机器：Claude Code 不读系统代理，换 token 直连被拒 → 要给登录子进程补 HTTPS_PROXY；
 *   - 登录失败只说「没有检测到」：CLI 的报错、退出码、临时目录里有什么都要进日志，且日志里没有 token / 授权码 / 完整邮箱。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (process.platform !== "win32") {
  console.log("SKIP  假 CLI 用 .cmd 写的，只在 Windows 上跑");
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-oauth-login-"));
const home = path.join(root, "home"), bin = path.join(root, "bin"), appData = path.join(root, "appdata");
process.env.HOME = process.env.USERPROFILE = home;
process.env.APPDATA = appData;
process.env.TOKENPULSE_DATA_DIR = path.join(root, "data");
process.env.PATH = `${bin};${process.env.PATH}`;
for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"]) {
  delete process.env[key];
  delete process.env[key.toLowerCase()];
}

// 假 CLI：按 FAKE_LOGIN_MODE 模拟成功 / 换 token 被拒
const fake = path.join(bin, "fake-cli.cjs");
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(path.join(appData, "npm"), { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(fake, `
const fs = require("fs"), path = require("path");
const [kind, ...args] = process.argv.slice(2);
const mode = process.env.FAKE_LOGIN_MODE || "ok";
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const jwt = (claims) => "x." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".y";
if (args[0] === "--version") { console.log("9.9.9 (fake " + kind + ")"); process.exit(0); }
console.log("proxy=" + (process.env.HTTPS_PROXY || "none") + " no_proxy=" + (process.env.NO_PROXY || "none"));
console.log("Opening browser to sign in: https://claude.ai/oauth/authorize?code=true&client_id=abc&state=SECRETSTATE123");
if (mode === "403") {
  console.error("\\u001b[31mOAuth error: Request failed with status code 403. Raw body: {\\"error\\":{\\"message\\":\\"Request not allowed\\"}}\\u001b[0m");
  process.exit(1);
}
if (kind === "claude") {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  put(path.join(dir, ".credentials.json"), { claudeAiOauth: { accessToken: "sk-ant-oat01-" + "A".repeat(48), refreshToken: "sk-ant-ort01-" + "B".repeat(48), expiresAt: Date.now() + 8 * 3600e3, scopes: ["user:inference"] } });
  // 资料比凭据晚一点写（真实 CLI 写完凭据还要去取账号资料）
  setTimeout(() => {
    put(path.join(dir, ".claude.json"), { oauthAccount: { accountUuid: "uuid-friend", emailAddress: "friend@example.com" } });
    console.log("Login successful for friend@example.com");
    setTimeout(() => process.exit(0), 200);
  }, 1500);
} else {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  put(path.join(process.env.CODEX_HOME, "auth.json"), { tokens: { access_token: jwt({ exp }) + "codexAccessToken", refresh_token: "rt_" + "C".repeat(40), account_id: "ws-1", id_token: jwt({ email: "codex@example.com", "https://api.openai.com/auth": { chatgpt_user_id: "user-1", chatgpt_account_id: "ws-1" } }) } });
  console.log("Successfully logged in");
}
`);
const cmd = (file, kind) => fs.writeFileSync(file, `@"${process.execPath}" "${fake}" ${kind} %*\r\n`);
cmd(path.join(bin, "claude.cmd"), "claude");
cmd(path.join(appData, "npm", "codex.cmd"), "chatgpt");

const build = (file) => require(path.join(__dirname, "..", "build", ...file.split("/")));
const creds = build("core/credentials.js");
const accounts = build("core/accounts.js");
const loginLog = build("core/login-log.js");
const proxy = build("core/upstream-proxy.js");
const { loginOfficialOAuth } = build("main/oauth.js");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readLog = () => { try { return fs.readFileSync(loginLog.loginLogFile(), "utf8"); } catch { return ""; } };
/** 一次登录的日志行（按记录器 id 过滤）。 */
const attemptLines = (marker) => {
  const text = readLog();
  const ids = [...new Set([...text.matchAll(/\[login ([a-z]+#[0-9a-f]{4})\]/g)].map((m) => m[1]))];
  const id = ids.reverse().find((one) => text.split("\n").some((line) => line.includes(`[login ${one}]`) && line.includes(marker)));
  return text.split("\n").filter((line) => id && line.includes(`[login ${id}]`)).join("\n");
};
const waitFor = async (fn, ms = 5000) => { const until = Date.now() + ms; while (Date.now() < until) { if (fn()) return true; await sleep(100); } return fn(); };

(async () => {
try {
  // ---- 脱敏 ----
  const red = loginLog.redactLoginText(`\u001b[2m${home}\\x visit https://claude.ai/oauth/authorize?code=true&state=S3 a.b@example.com sk-ant-oat01-${"Z".repeat(40)}\u001b[0m`, home);
  check("日志脱敏：家目录换成 ~、链接参数去掉、邮箱打码、长 token 隐藏、去掉终端颜色",
    red.startsWith("~\\x") && red.includes("https://claude.ai/oauth/authorize?…") && !red.includes("S3") && red.includes("a***@example.com") && !red.includes("ZZZZ") && red.includes("[已隐藏") && !red.includes("\u001b"), red);

  // ---- 系统代理补给子进程 ----
  proxy.setSystemProxyResolver(async () => "PROXY 127.0.0.1:7890; DIRECT");
  const added = await proxy.systemProxyEnv("https://platform.claude.com/v1/oauth/token", { no_proxy: "corp.local" });
  check("只开了系统代理：登录子进程补 HTTPS_PROXY / HTTP_PROXY，NO_PROXY 带上本机地址",
    added.HTTPS_PROXY === "http://127.0.0.1:7890" && added.HTTP_PROXY === "http://127.0.0.1:7890" && /corp\.local/.test(added.NO_PROXY) && /localhost/.test(added.NO_PROXY) && /127\.0\.0\.1/.test(added.NO_PROXY), JSON.stringify(added));
  check("环境变量里已经有代理：不补（尊重用户自己的设置）", Object.keys(await proxy.systemProxyEnv("https://platform.claude.com/", { HTTPS_PROXY: "http://10.0.0.1:1" })).length === 0);
  proxy.setSystemProxyResolver(async () => "DIRECT");
  check("系统代理没开：不补", Object.keys(await proxy.systemProxyEnv("https://platform.claude.com/", {})).length === 0);

  // ---- 隔离登录目录里的 Claude 资料位置 ----
  {
    const temp = path.join(root, "iso");
    fs.mkdirSync(path.join(temp, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(temp, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok-iso-123456789" } }));
    fs.writeFileSync(path.join(temp, ".claude", ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-iso", emailAddress: "iso@example.com" } }));
    const iso = creds.readCliAccounts("claude", temp, true)[0];
    const plain = creds.readCliAccounts("claude", temp)[0];
    check("登录临时目录（CLAUDE_CONFIG_DIR=临时目录/.claude）：资料从 .claude/.claude.json 读", iso?.ref === "uuid-iso" && iso?.email === "iso@example.com", JSON.stringify({ ref: iso?.ref, email: iso?.email }));
    check("普通 home 仍然不认 .claude/.claude.json（0.3.60 的修复不回退）", plain?.ref?.startsWith("token:") && plain?.email === "");
  }

  // ---- 端到端：Claude 登录成功，资料晚写 ----
  proxy.setSystemProxyResolver(null);
  process.env.FAKE_LOGIN_MODE = "ok";
  let result = await loginOfficialOAuth("claude");
  const stored = accounts.readOfficialAccountStore().accounts.find((item) => item.kind === "claude");
  check("Claude 登录成功：账号有邮箱、身份是 accountUuid（等资料写好再读）", result.ok && stored?.id === "claude:uuid-friend" && stored?.email === "friend@example.com", JSON.stringify({ ok: result.ok, error: result.error, id: stored?.id, email: stored?.email }));
  check("Claude 登录成功：记下切换 CLI 时要写回的账号资料", stored?.cliAuth?.account?.accountUuid === "uuid-friend");
  await waitFor(() => /CLI 版本：9\.9\.9/.test(attemptLines("开始登录 Claude")));
  let lines = attemptLines("开始登录 Claude");
  check("成功的登录也有日志：开始、CLI 路径和版本、CLI 输出、退出码、成功", /开始登录 Claude；TokenPulse \d/.test(lines) && /CLI：.*claude\.cmd/.test(lines) && /CLI 版本：9\.9\.9 \(fake claude\)/.test(lines) && /CLI 输出: Login successful/.test(lines) && /CLI 退出：code 0/.test(lines) && /成功（\d+ 秒）：1 个账号，有邮箱/.test(lines), lines);
  check("日志里没有 token、授权链接参数和完整邮箱", !/AAAAAAAAAA|BBBBBBBBBB|SECRETSTATE123|friend@example\.com/.test(readLog()) && /f\*\*\*@example\.com/.test(lines));
  check("没设代理时日志写明直连", /代理：没有代理/.test(lines));

  // ---- 端到端：换 token 被拒（模拟只开系统代理之外的失败），日志能看出原因 ----
  proxy.setSystemProxyResolver(async () => "PROXY 127.0.0.1:7890");
  process.env.FAKE_LOGIN_MODE = "403";
  const started = Date.now();
  result = await loginOfficialOAuth("claude");
  lines = attemptLines("CLI 报错");
  check("CLI 失败退出：提示没检测到，并指向日志", !result.ok && /没有检测到 OAuth 登录成功/.test(result.error) && /「打开日志」/.test(result.error) && Date.now() - started < 15_000, result.error);
  check("失败日志：系统代理已补给 CLI、CLI 的报错（去掉颜色）、退出码、临时目录状态",
    /按系统代理补上 HTTPS_PROXY=http:\/\/127\.0\.0\.1:7890/.test(lines) && /CLI 输出: proxy=http:\/\/127\.0\.0\.1:7890 no_proxy=.*localhost/.test(lines)
    && /CLI 报错: OAuth error: Request failed with status code 403.*Request not allowed/.test(lines) && !lines.includes("\u001b")
    && /CLI 退出：code 1/.test(lines) && /失败（\d+ 秒）：CLI 已退出，临时目录里没有读到新凭据/.test(lines) && /凭据文件 \.claude\/\.credentials\.json：不存在/.test(lines), lines);

  // ---- 端到端：Codex ----
  proxy.setSystemProxyResolver(null);
  process.env.FAKE_LOGIN_MODE = "ok";
  result = await loginOfficialOAuth("chatgpt");
  const codex = accounts.readOfficialAccountStore().accounts.find((item) => item.kind === "chatgpt");
  check("Codex 登录成功（.cmd 经 cmd.exe 启动、输出进日志）", result.ok && codex?.email === "codex@example.com" && /CLI 输出: Successfully logged in/.test(attemptLines("开始登录 ChatGPT")), result.error || "");

  // ---- 临时目录不留明文 token ----
  const leftover = await waitFor(() => !fs.readdirSync(process.env.TOKENPULSE_DATA_DIR).some((name) => name.startsWith("oauth-login-")), 8000);
  check("登录结束后临时目录都删掉了", leftover, fs.readdirSync(process.env.TOKENPULSE_DATA_DIR).join(", "));
} finally {
  proxy.setSystemProxyResolver(null);
  await sleep(300);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
assert.equal(passed, results.length, "oauth login regression failed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
