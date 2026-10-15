/**
 * 0.3.54：Claude Code 没在运行时，替它续期 CLI 里登录着的账号。跑法（先 npm run compile）：
 *
 *   node scripts/test-cli-renew.cjs
 *
 * 用一次性的 HOME 和数据目录造假凭据；续期接口和「Claude Code 是否在运行」都换成假实现，不碰真实登录、不访问官方接口。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-cli-renew-"));
process.env.HOME = process.env.USERPROFILE = path.join(root, "home");
process.env.TOKENPULSE_DATA_DIR = path.join(root, "data");
for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"]) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });

const build = (file) => require(path.join(__dirname, "..", "build", ...file.split("/")));
const { renewCliCredential, isClaudeCodeProcess } = build("core/cli-renew.js");
const { readRenewLog, renewLogFile } = build("core/renew-log.js");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 15, 3);
const home = process.env.HOME;
const credFile = path.join(home, ".claude", ".credentials.json");
const extra = { mcpOAuth: { "server|abc": { accessToken: "mcp-keep" } } };
function seed(expiresAt, refreshToken = "r-old", pretty = true) {
  fs.mkdirSync(path.dirname(credFile), { recursive: true });
  const body = { claudeAiOauth: { accessToken: "a-old", refreshToken, expiresAt, scopes: ["user:inference", "user:profile"], subscriptionType: "max", rateLimitTier: "tier" }, ...extra };
  fs.writeFileSync(credFile, pretty ? JSON.stringify(body, null, 2) : JSON.stringify(body));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-cli", emailAddress: "cli@example.com" } }));
}
const read = () => JSON.parse(fs.readFileSync(credFile, "utf8"));
let calls = 0;
const ok = (raw = {}) => async (kind, credential) => {
  calls += 1;
  return { ok: true, credential: { ...credential, token: "a-new", refreshToken: "r-new", expiresAt: NOW + 8 * HOUR }, raw };
};
const idle = async () => false;
const busy = async () => true;

(async () => {
  try {
    check("CLI 没登录：什么都不做", (await renewCliCredential(NOW, { refresh: ok(), running: idle })).state === "none" && calls === 0);

    seed(NOW + 5 * HOUR);
    let r = await renewCliCredential(NOW, { refresh: ok(), running: idle });
    check("凭据还新：不续", r.state === "fresh" && r.accountId === "claude:uuid-cli" && calls === 0, JSON.stringify(r));

    seed(NOW - HOUR);
    const before = fs.readFileSync(credFile, "utf8");
    r = await renewCliCredential(NOW, { refresh: ok(), running: busy });
    check("过期了但 Claude Code 在运行：等它自己续，不碰文件", r.state === "waiting" && calls === 0 && fs.readFileSync(credFile, "utf8") === before, JSON.stringify(r));

    fs.writeFileSync(path.join(home, ".claude", ".oauth_refresh.lock"), "");
    r = await renewCliCredential(NOW, { refresh: ok(), running: idle });
    check("Claude Code 的续期锁在：也当它在运行", r.state === "waiting" && calls === 0);
    fs.rmSync(path.join(home, ".claude", ".oauth_refresh.lock"));

    r = await renewCliCredential(NOW, { refresh: ok({ refresh_token_expires_in: 30 * 24 * 3600 }), running: idle });
    const after = read();
    check("没在运行：续上，写回新的 access / refresh token 和过期时间", r.state === "renewed" && calls === 1 && after.claudeAiOauth.accessToken === "a-new" && after.claudeAiOauth.refreshToken === "r-new" && after.claudeAiOauth.expiresAt === NOW + 8 * HOUR, JSON.stringify(r));
    check("其它字段原样保留（scopes / 套餐 / MCP 登录）", after.claudeAiOauth.subscriptionType === "max" && after.claudeAiOauth.scopes.length === 2 && after.claudeAiOauth.rateLimitTier === "tier" && after.mcpOAuth["server|abc"].accessToken === "mcp-keep");
    check("官方给了 refresh token 有效期就记上", after.claudeAiOauth.refreshTokenExpiresAt === NOW + 30 * 24 * HOUR);
    check("原来是缩进格式就还写缩进格式", fs.readFileSync(credFile, "utf8").includes("\n  "));
    check("没有留下临时文件", fs.readdirSync(path.dirname(credFile)).every((name) => !name.endsWith(".tmp")));

    seed(NOW - HOUR, "r-compact", false);
    calls = 0;
    await renewCliCredential(NOW, { refresh: ok(), running: idle });
    check("原来是一行就还写一行；没给有效期就不加这个字段", !fs.readFileSync(credFile, "utf8").includes("\n") && read().claudeAiOauth.refreshTokenExpiresAt === undefined && calls === 1);

    // 续期走网络期间 Claude Code 启动、自己续过了：不能拿我们的结果覆盖
    seed(NOW - HOUR, "r-race");
    r = await renewCliCredential(NOW, {
      running: idle,
      refresh: async (kind, credential) => {
        const live = read();
        live.claudeAiOauth.refreshToken = "r-from-claude-code";
        fs.writeFileSync(credFile, JSON.stringify(live));
        return { ok: true, credential: { ...credential, token: "a-mine", refreshToken: "r-mine", expiresAt: NOW + 8 * HOUR }, raw: {} };
      },
    });
    check("期间文件被改过：不覆盖", r.state === "failed" && read().claudeAiOauth.refreshToken === "r-from-claude-code", JSON.stringify(r));

    // 官方明确拒绝：记住，不反复去试
    seed(NOW - HOUR, "r-dead");
    calls = 0;
    const deny = async () => { calls += 1; return { ok: false, permanent: true, status: 400, code: "invalid_grant", error: "HTTP 400 invalid_grant" }; };
    r = await renewCliCredential(NOW, { refresh: deny, running: idle });
    const again = await renewCliCredential(NOW + 5 * 60_000, { refresh: deny, running: idle });
    check("refresh token 被拒：标 dead，第二轮不再去试，文件不动", r.state === "failed" && r.dead && again.dead && calls === 1 && read().claudeAiOauth.refreshToken === "r-dead", JSON.stringify(again));

    seed(NOW - HOUR, "r-flaky");
    calls = 0;
    const flaky = async () => { calls += 1; return { ok: false, permanent: false, error: "curl: (28) timed out" }; };
    r = await renewCliCredential(NOW, { refresh: flaky, running: idle });
    await renewCliCredential(NOW + 5 * 60_000, { refresh: flaky, running: idle });
    check("网络失败：不算 dead，下一轮再试", r.state === "failed" && !r.dead && calls === 2);

    // 同时触发两轮只跑一次（两次同时用同一个 refresh token 会让一次作废）
    seed(NOW - HOUR, "r-once");
    calls = 0;
    const slow = async (kind, credential) => { calls += 1; await new Promise((res) => setTimeout(res, 30)); return { ok: true, credential: { ...credential, token: "a-once", refreshToken: "r-once-2", expiresAt: NOW + 8 * HOUR }, raw: {} }; };
    const both = await Promise.all([renewCliCredential(NOW, { refresh: slow, running: idle }), renewCliCredential(NOW, { refresh: slow, running: idle })]);
    check("同时触发两轮只续一次", calls === 1 && both.every((one) => one.state === "renewed"));

    check(
      "认得出 Claude Code 进程：原生版、npm 版、桌面版自带的；桌面版主程序不算",
      isClaudeCodeProcess("claude.exe", "C:\\Users\\u\\.local\\bin\\claude.exe", "") &&
        isClaudeCodeProcess("node.exe", "C:\\nodejs\\node.exe", "node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js") &&
        isClaudeCodeProcess("claude.exe", "C:\\Users\\u\\AppData\\Roaming\\Claude\\claude-code\\2.1.0\\claude.exe", "") &&
        isClaudeCodeProcess("claude.exe", "", "") &&
        !isClaudeCodeProcess("claude.exe", "C:\\Program Files\\WindowsApps\\Claude_2.3.1.0_x64__pzs8sxrjxfjjc\\app\\claude.exe", "") &&
        !isClaudeCodeProcess("claude.exe", "C:\\Users\\u\\AppData\\Local\\AnthropicClaude\\app-1.0.0\\claude.exe", "") &&
        !isClaudeCodeProcess("node.exe", "C:\\nodejs\\node.exe", "node clawd-hook.js PreCompact"),
    );

    const log = readRenewLog(100);
    const text = fs.readFileSync(renewLogFile(), "utf8");
    check("续期日志记了 CLI 的续期（成功 / 被拒 / 网络失败）", log.filter((row) => row.source === "cli").length >= 5 && log.some((row) => row.source === "cli" && row.code === "invalid_grant" && row.permanent) && log.some((row) => row.source === "cli" && /timed out/.test(row.error || "")));
    check("续期日志里没有 token 和账号原文", !/a-new|r-new|r-dead|r-once|uuid-cli|cli@example\.com/.test(text));
  } catch (error) {
    console.error(error);
    results.push(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} 通过`);
  assert.equal(passed, results.length, "cli renew regression failed");
})();
