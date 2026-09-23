/**
 * 官方账号：身份识别、活动账号用哪份凭据、OAuth 登录的目录隔离。跑法（先 npm run compile）：
 *
 *   node scripts/test-accounts.cjs
 *
 * 用一次性的 HOME 和数据目录造假凭据，不碰用户真实的 CLI 登录和 ~/.tokenpulse。盯的都是 0.3.0 初版踩过的坑：
 *   - Claude 凭据文件没有邮箱，所有 Claude 账号都叫 claude:default，第二个把第一个覆盖；
 *   - ChatGPT 的 account_id 是工作区 id，同一个 Team 的两个人撞成一个账号；
 *   - 活动账号只对 Grok 生效；选中的账号不在 CLI 里时悄悄回退到 CLI 当前账号；
 *   - 只改 USERPROFILE 关不住 Codex（Rust，按系统 API 找家目录），登录会覆盖用户真实的 ~/.codex；
 *   - 自动续期：只续 TokenPulse 登录的账号、轮换后的 refresh token 立刻存、不并发续期。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-accounts-"));
process.env.HOME = process.env.USERPROFILE = path.join(root, "home");
process.env.TOKENPULSE_DATA_DIR = path.join(root, "data");
for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"]) delete process.env[key];
const build = (file) => require(path.join(__dirname, "..", "build", ...file.split("/")));
const creds = build("core/credentials.js");
const accounts = build("core/accounts.js");
const { isolatedEnv } = build("main/oauth.js");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const NOW = Date.UTC(2026, 8, 22, 12);
const HOUR = 3_600_000;

/** 在某个 home 下放一份 Claude 登录。 */
function claudeHome(home, uuid, email, token, expiresAt = NOW + 8 * HOUR) {
  write(path.join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: token, refreshToken: "r-" + token, expiresAt } });
  write(path.join(home, ".claude.json"), { oauthAccount: { accountUuid: uuid, emailAddress: email } });
}
function codexHome(home, user, workspace, email, token) {
  write(path.join(home, ".codex", "auth.json"), {
    tokens: { access_token: jwt({ exp: (NOW + 24 * HOUR) / 1000 }) + token, account_id: workspace, id_token: jwt({ email, "https://api.openai.com/auth": { chatgpt_user_id: user, chatgpt_account_id: workspace } }) },
  });
}

(async () => {
try {
  // ---- 身份 ----
  const a = path.join(root, "login-a"), b = path.join(root, "login-b");
  claudeHome(a, "uuid-a", "a@example.com", "tok-a");
  claudeHome(b, "uuid-b", "b@example.com", "tok-b");
  const idA = accounts.rememberOfficialAccount(creds.readCliAccounts("claude", a)[0], true, NOW);
  const idB = accounts.rememberOfficialAccount(creds.readCliAccounts("claude", b)[0], true, NOW);
  check("两个 Claude 账号身份不同，不会互相覆盖", idA !== idB && accounts.readOfficialAccountStore().accounts.length === 2, `${idA} / ${idB}`);
  check("Claude 账号能读出邮箱", creds.readCliAccounts("claude", a)[0].email === "a@example.com");

  const t1 = path.join(root, "team-1"), t2 = path.join(root, "team-2");
  codexHome(t1, "user-1", "ws-team", "one@example.com", "1");
  codexHome(t2, "user-2", "ws-team", "two@example.com", "2");
  const [c1] = creds.readCliAccounts("chatgpt", t1), [c2] = creds.readCliAccounts("chatgpt", t2);
  check("同一个 Team 工作区的两个 ChatGPT 用户是两个账号", c1.ref !== c2.ref && c1.credential.accountId === "ws-team", `${c1.ref} / ${c2.ref}`);
  check("ChatGPT 从 id_token 读出邮箱、从 access token 读出过期时间", c1.email === "one@example.com" && c1.credential.expiresAt === NOW + 24 * HOUR);

  // ---- 活动账号用哪份凭据 ----
  const home = process.env.HOME;
  claudeHome(home, "uuid-cli", "cli@example.com", "tok-cli-fresh");
  accounts.writeOfficialAccountStore({ version: 2, accounts: [], active: {} });
  let active = accounts.resolveActiveAccount("claude", NOW);
  check("没选过活动账号时用 CLI 当前登录", active.source === "cli" && active.credential.token === "tok-cli-fresh");

  // CLI 的账号被登记过、凭据是旧的；CLI 之后自己刷新了 token —— 必须用 CLI 里的新 token
  const cliAccount = creds.readCliAccounts("claude")[0];
  accounts.rememberOfficialAccount({ ...cliAccount, credential: { token: "tok-cli-stale", expiresAt: NOW + HOUR } }, true, NOW);
  accounts.setActiveOfficialAccount("claude", accounts.accountIdOf("claude", "uuid-cli"));
  active = accounts.resolveActiveAccount("claude", NOW);
  check("活动账号正登录在 CLI 里时，用 CLI 的最新凭据而不是存的旧副本", active.credential.token === "tok-cli-fresh", active.credential.token);
  accounts.rememberOfficialAccount({ ...cliAccount, credential: { token: "tok-no-expiry" } }, true, NOW);
  check("存的那份没写过期时间时比不出新旧，用 CLI 的", accounts.resolveActiveAccount("claude", NOW).credential.token === "tok-cli-fresh");

  // 反过来：CLI 自己的凭据已经过期（CLI 很久没用、没续期），同一个账号在 TokenPulse 里重新登录过
  claudeHome(home, "uuid-cli", "cli@example.com", "tok-cli-expired", NOW - 34 * HOUR);
  accounts.rememberOfficialAccount({ ...creds.readCliAccounts("claude")[0], credential: { token: "tok-relogin", expiresAt: NOW + 6 * HOUR } }, true, NOW);
  active = accounts.resolveActiveAccount("claude", NOW);
  check("CLI 凭据已过期、TokenPulse 刚重新登录过同一个账号：用新凭据，不报过期", active.credential.token === "tok-relogin" && !active.expired && active.source === "stored", JSON.stringify({ token: active.credential.token, expired: active.expired }));
  claudeHome(home, "uuid-cli", "cli@example.com", "tok-cli-fresh");

  accounts.rememberOfficialAccount(creds.readCliAccounts("claude", a)[0], true, NOW);
  accounts.setActiveOfficialAccount("claude", idA);
  active = accounts.resolveActiveAccount("claude", NOW);
  check("切到 TokenPulse 登录的账号后，额度用它的凭据（以前 Claude 仍查 CLI 那个）", active.source === "stored" && active.credential.token === "tok-a" && active.email === "a@example.com");

  active = accounts.resolveActiveAccount("claude", NOW + 9 * HOUR);
  check("保存的凭据过期后如实报告，不回退到 CLI 当前账号", active.expired && active.id === idA, JSON.stringify({ id: active.id, expired: active.expired }));

  // ---- 不把 CLI 的凭据复制进账号库 ----
  accounts.writeOfficialAccountStore({ version: 2, accounts: [], active: {} });
  accounts.rememberOfficialAccount(creds.readCliAccounts("claude")[0], false, NOW);
  check("CLI 当前账号只记名字，不复制凭据", accounts.readOfficialAccountStore().accounts[0].credential === undefined);

  // ---- 自动续期 ----
  {
    const refresh = build("core/token-refresh.js");
    const seed = (list) => accounts.writeOfficialAccountStore({ version: 2, accounts: list.map((item, i) => ({ email: "", label: "x", createdAt: 1, lastSeenAt: 1, kind: "grok", ...item, id: item.id ?? `grok:${i}`, ref: item.ref ?? String(i) })), active: {} });
    const calls = [];
    const fake = (outcome) => async (kind, credential) => { calls.push(credential.refreshToken); await new Promise((r) => setTimeout(r, 20)); return typeof outcome === "function" ? outcome(credential) : outcome; };

    seed([
      { id: "grok:soon", credential: { token: "old", refreshToken: "r1", expiresAt: NOW + 10 * 60_000 } },
      { id: "grok:later", credential: { token: "fine", refreshToken: "r2", expiresAt: NOW + 5 * HOUR } },
      { id: "grok:cli-only" },
      { id: "grok:no-refresh", credential: { token: "t", expiresAt: NOW - HOUR } },
    ]);
    calls.length = 0;
    const renewed = await Promise.all([
      accounts.renewStoredCredentials(NOW, fake((c) => ({ ok: true, credential: { ...c, token: "new", refreshToken: "r1-rotated", expiresAt: NOW + 6 * HOUR } }))),
      accounts.renewStoredCredentials(NOW, fake({ ok: false, permanent: false, error: "should not run" })),
    ]);
    const byId = Object.fromEntries(accounts.readOfficialAccountStore().accounts.map((item) => [item.id, item]));
    check("只续期快过期（30 分钟内）且有 refresh token 的 TokenPulse 账号", calls.join(",") === "r1", calls.join(","));
    check("同时触发两轮续期只跑一轮（两轮同时用同一个 refresh token 会让新 token 作废）", renewed[0] === 1 && renewed[1] === 1);
    check("续期后立刻存下新 token 和轮换后的 refresh token", byId["grok:soon"].credential.token === "new" && byId["grok:soon"].credential.refreshToken === "r1-rotated");
    check("没存凭据的 CLI 账号从不续期", byId["grok:cli-only"].credential === undefined);

    seed([{ id: "grok:dead", credential: { token: "t", refreshToken: "revoked", expiresAt: NOW - HOUR } }]);
    await accounts.renewStoredCredentials(NOW, fake({ ok: false, permanent: true, error: "HTTP 400" }));
    check("refresh token 被官方拒绝：标记需重新登录", accounts.readOfficialAccountStore().accounts[0].renewFailed === "HTTP 400");
    calls.length = 0;
    await accounts.renewStoredCredentials(NOW, fake({ ok: true, credential: { token: "x" } }));
    check("标记后不再反复重试", calls.length === 0);
    accounts.rememberOfficialAccount({ kind: "grok", ref: "dead", email: "", label: "x", credential: { token: "relogin", refreshToken: "r-new", expiresAt: NOW + 6 * HOUR } }, true, NOW);
    check("重新登录后清掉标记", accounts.readOfficialAccountStore().accounts[0].renewFailed === undefined);

    seed([{ id: "grok:flaky", credential: { token: "t", refreshToken: "r", expiresAt: NOW + 60_000 } }]);
    await accounts.renewStoredCredentials(NOW, fake({ ok: false, permanent: false, error: "timeout" }));
    const flaky = accounts.readOfficialAccountStore().accounts[0];
    check("网络失败只是这一轮不行，不标记、凭据不动", !flaky.renewFailed && flaky.credential.token === "t");

    // 续期走网络期间用户重新登录了同一个账号：以新登录为准
    seed([{ id: "grok:race", credential: { token: "t", refreshToken: "r-old", expiresAt: NOW + 60_000 } }]);
    await accounts.renewStoredCredentials(NOW, async (kind, credential) => {
      const store = accounts.readOfficialAccountStore();
      store.accounts[0].credential = { token: "from-login", refreshToken: "r-login", expiresAt: NOW + 8 * HOUR };
      accounts.writeOfficialAccountStore(store);
      return { ok: true, credential: { ...credential, token: "from-renew" } };
    });
    check("续期期间用户重新登录过：不拿续期结果覆盖新登录", accounts.readOfficialAccountStore().accounts[0].credential.token === "from-login");

    // 官方响应 → 凭据
    const jwtExp = jwt({ exp: (NOW + 8 * HOUR) / 1000 });
    const next = refresh.credentialFromTokenResponse({ token: "old", refreshToken: "r", issuer: "https://auth.x.ai", clientId: "c" }, { access_token: jwtExp, expires_in: 60 }, NOW);
    check("响应没给新 refresh token 时沿用旧的；过期时间以 JWT 的 exp 为准；保留签发方", next.refreshToken === "r" && next.expiresAt === NOW + 8 * HOUR && next.issuer === "https://auth.x.ai");
    const opaque = refresh.credentialFromTokenResponse({ token: "old" }, { access_token: "opaque", refresh_token: "r2", expires_in: 3600 }, NOW);
    check("不是 JWT 的 token 用 expires_in 算过期时间", opaque.expiresAt === NOW + HOUR && opaque.refreshToken === "r2");
    check(
      "400 invalid_grant / 401 算永久失败，429 / 5xx 不算",
      refresh.isPermanentFailure(400, { error: "invalid_grant" }) && refresh.isPermanentFailure(401, { error: { code: "token_expired" } }) && !refresh.isPermanentFailure(429, {}) && !refresh.isPermanentFailure(503, {}),
    );
  }

  // ---- 旧版账号库 ----
  write(path.join(process.env.TOKENPULSE_DATA_DIR, "official-accounts.json"), { version: 1, accounts: [{ id: "claude:default", kind: "claude", credentialRef: "default", email: "", label: "x", createdAt: 1, lastSeenAt: 1 }], active: { claude: "claude:default" } });
  check("1 版账号库（Claude 全叫 default）直接丢弃，重新识别", accounts.readOfficialAccountStore().accounts.length === 0);

  // ---- 登录隔离 ----
  const temp = path.join(root, "oauth-temp");
  const real = { USERPROFILE: "C:\\real", APPDATA: "C:\\real\\Roaming", LOCALAPPDATA: "C:\\real\\Local" };
  const env = isolatedEnv(temp, { ...real, OPENAI_API_KEY: "sk-x", PATH: "p" });
  check(
    "OAuth 登录显式指定三家的配置目录（只改 USERPROFILE 关不住 Codex）",
    env.CODEX_HOME === path.join(temp, ".codex") && env.CLAUDE_CONFIG_DIR === path.join(temp, ".claude") && env.GROK_HOME === path.join(temp, ".grok"),
    JSON.stringify({ CODEX_HOME: env.CODEX_HOME, GROK_HOME: env.GROK_HOME }),
  );
  check("登录环境去掉 API Key，其余环境保留", env.OPENAI_API_KEY === undefined && env.PATH === "p");
  check(
    "不改 USERPROFILE / APPDATA / LOCALAPPDATA（否则浏览器开成空白配置，用不上已登录的账号）",
    env.USERPROFILE === real.USERPROFILE && env.APPDATA === real.APPDATA && env.LOCALAPPDATA === real.LOCALAPPDATA,
  );
  check("隔离目录里的凭据路径和读取路径一致", creds.authFile("chatgpt", temp) === path.join(env.CODEX_HOME, "auth.json") && creds.authFile("grok", temp) === path.join(env.GROK_HOME, "auth.json"));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
assert.equal(passed, results.length, "official accounts regression failed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
