/**
 * 后端审计回归（Wave 2）：账号续期、OAuth、CLI 切换、额度、出口地区、余额与 tokens.ci。
 * 跑法：node scripts/test-audit-auth-quota.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-audit-w2-"));
process.env.HOME = process.env.USERPROFILE = path.join(root, "home");
process.env.TOKENPULSE_DATA_DIR = path.join(root, "data");
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "TOKENS_CONFIG_DIR"]) {
  delete process.env[k];
}
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.TOKENS_CONFIG_DIR = path.join(root, "tokens-cfg");
fs.mkdirSync(process.env.TOKENS_CONFIG_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.TOKENS_CONFIG_DIR, "credentials.json"), '{"token":"t"}');

const { regionStatus, validateConfig, defaults } = require("../build/core/egress.js");
const { analyzeAccount } = require("../build/core/quota-monitor.js");
const { relayBase, parseSub2api } = require("../build/core/relay-balance.js");
const { DeepSeekBalance } = require("../build/main/deepseek-balance.js");
const { normalizeSettings } = require("../build/core/tokens-ci.js");
const { TokensUploader } = require("../build/main/tokens-ci.js");
const {
  writeOfficialAccountStore,
  readOfficialAccountStore,
  renewStoredCredentials,
  purgeOfficialAccount,
  removeOfficialAccount,
} = require("../build/core/accounts.js");
const { switchCliAccount, writeAtomic } = require("../build/core/cli-switch.js");
const { isolatedEnv, listOfficialOAuthStatus } = require("../build/main/oauth.js");
const { curlPost } = require("../build/core/curl.js");
const { quotaIssueNotice, quotaIssueTone, fetchOfficialQuota } = require("../build/core/quota.js");

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
    // 1. Egress ISO country codes (GB, FR, RS, BJ, BF, TL) & canonicalizing UK -> GB
    await check("egress regionStatus recognizes GB, FR, RS, BJ, BF, TL and validateConfig canonicalizes UK -> GB", () => {
      const NOW = Date.UTC(2026, 9, 1);
      for (const code of ["GB", "FR", "RS", "BJ", "BF", "TL"]) {
        assert.equal(regionStatus("claude", "api.anthropic.com", code, NOW), "supported", `claude ${code}`);
      }
      for (const code of ["GB", "FR", "RS", "BJ", "BF"]) {
        assert.equal(regionStatus("chatgpt", "chatgpt.com", code, NOW), "supported", `chatgpt ${code}`);
        assert.equal(regionStatus("chatgpt", "api.openai.com", code, NOW), "supported", `openai_api ${code}`);
      }
      const cfg = defaults();
      cfg.providers.claude.allowedRegions = ["uk", "fx"];
      const validated = validateConfig(cfg);
      assert.deepEqual(validated.providers.claude.allowedRegions, ["GB", "FR"]);
    });

    // 2. quota-monitor analyzeAccount uses windowSegments glitch filtering
    await check("quota-monitor analyzeAccount filters single-frame 0% glitch instead of false runs-out", () => {
      const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
      const reset = new Date(NOW + 10 * 3600_000).toISOString();
      const samples = [
        { at: NOW - 24 * 3600_000, account: "claude:a", week: 28, weekReset: reset },
        { at: NOW - 12 * 3600_000, account: "claude:a", week: 28, weekReset: reset },
        { at: NOW - 2 * 3600_000 - 60_000, account: "claude:a", week: 0, weekReset: reset }, // 3-min API glitch
        { at: NOW - 2 * 3600_000 + 120_000, account: "claude:a", week: 28, weekReset: reset },
        { at: NOW - 300_000, account: "claude:a", week: 28, weekReset: reset },
      ];
      const report = analyzeAccount("claude", samples, [], NOW);
      assert.ok(report.trend.every((p) => p.pct === 28), "0% glitch filtered out of trend: " + JSON.stringify(report.trend));
      assert.equal(report.week.runsOutBeforeReset, false);
      assert.equal(report.health.level, "good");
    });

    // 3. relay-balance IPv6 hosts and parseSub2api unit validation
    await check("relayBase accepts IPv6 hosts and parseSub2api does not truncate CREDITS to CRE", () => {
      assert.equal(relayBase("http://[::1]:8080/v1"), "http://[::1]:8080");
      assert.equal(relayBase("https://[2001:db8::1]/v1"), "https://[2001:db8::1]");
      const parsed = parseSub2api(JSON.stringify({ isValid: true, mode: "unrestricted", remaining: 10, unit: "CREDITS" }));
      assert.equal(parsed.currency, "USD");
    });

    // 4. DeepSeekBalance multi-currency independent low-balance alerts
    await check("DeepSeekBalance alerts independently per currency on multi-currency accounts", async () => {
      const alerts = [];
      let infos = [
        { currency: "CNY", total_balance: "100.00", granted_balance: "0", topped_up_balance: "100.00" },
        { currency: "USD", total_balance: "0.00", granted_balance: "0", topped_up_balance: "0.00" },
      ];
      let t = Date.UTC(2026, 9, 10, 12);
      const bal = new DeepSeekBalance({
        now: () => (t += 10_000),
        notify: (info) => alerts.push(info.currency),
        fetcher: async () => ({ status: 200, body: JSON.stringify({ is_available: true, balance_infos: infos }) }),
      });
      const added = await bal.add({ key: "sk-1234567890abcdef1234", alertBelow: 20 });
      assert.deepEqual(alerts, ["USD"], "USD alerts initially");
      // Now CNY drops below 20 while USD stays 0
      infos = [
        { currency: "CNY", total_balance: "5.00", granted_balance: "0", topped_up_balance: "5.00" },
        { currency: "USD", total_balance: "0.00", granted_balance: "0", topped_up_balance: "0.00" },
      ];
      await bal.refresh(added.id, true, true);
      assert.deepEqual(alerts, ["USD", "CNY"], "CNY alerts independently despite USD remaining low");
      bal.stop();
    });

    // 5. tokens-ci normalizeSettings, save preserving version, cancelJob not recording failure, check ignoring non-zero output
    await check("tokens-ci normalizeSettings, save, cancelJob, and check bugs fixed", async () => {
      const base = { enabled: true, intervalMin: 30, onLaunch: false, channel: "pinned", version: "27.1.3", dismissed: false, username: "u", lastRunAt: 123456 };
      const norm = normalizeSettings({ intervalMin: "", lastRunAt: null, version: "invalid!" }, base);
      assert.equal(norm.intervalMin, 30, "empty string does not coerce to 10");
      assert.equal(norm.lastRunAt, 123456, "null does not coerce to 0");
      assert.equal(norm.version, "27.1.3", "invalid version preserves base");

      let resolveRun;
      const uploader = new TokensUploader({
        runner: (line) => {
          if (line.includes("npm view")) {
            return { done: Promise.resolve({ code: 1, output: "npm notice New version 10.8.0 available\nnpm ERR! 404", timedOut: false }), kill: () => {} };
          }
          if (line.startsWith("where") || line.startsWith("command -v")) {
            return { done: Promise.resolve({ code: 0, output: "ok", timedOut: false }), kill: () => {} };
          }
          return {
            done: new Promise((r) => { resolveRun = r; }),
            kill: () => resolveRun?.({ code: null, output: "Scanning local session data...", timedOut: false }),
          };
        },
      });
      uploader.save({ enabled: true, channel: "pinned", version: "27.1.3", intervalMin: 30 });
      const savedBad = uploader.save({ version: "not-a-version" });
      assert.equal(savedBad.settings.version, "27.1.3", "save preserves pinned version on invalid patch");

      // check() with non-zero npm view must not pick 10.8.0
      const checked = await uploader.check();
      assert.equal(checked.tools.latest, "", "non-zero npm view must not extract npm notice version");

      // cancel upload must not increment failures or write fake '退出码 null' error
      const uploadPromise = uploader.upload("manual");
      uploader.cancelJob();
      const afterCancel = await uploadPromise;
      assert.equal(afterCancel.failures, 0, "cancelJob does not increment failures");
      assert.equal(afterCancel.last, null, "cancelJob does not record fake failed run");
      uploader.stop();
    });

    // 6. renewStoredCredentials per-kind concurrency and skipping hidden accounts
    await check("renewStoredCredentials runs per-kind concurrently and skips hidden accounts", async () => {
      const now = Date.now();
      writeOfficialAccountStore({
        version: 2,
        active: {},
        accounts: [
          { id: "chatgpt:a", kind: "chatgpt", ref: "a", email: "a@e.com", label: "a", credential: { token: "t1", refreshToken: "r1", expiresAt: now - 1000 }, createdAt: now, lastSeenAt: now },
          { id: "claude:b", kind: "claude", ref: "b", email: "b@e.com", label: "b", credential: { token: "t2", refreshToken: "r2", expiresAt: now - 1000 }, createdAt: now, lastSeenAt: now },
          { id: "claude:hid", kind: "claude", ref: "hid", email: "h@e.com", label: "h", hidden: true, credential: { token: "t3", refreshToken: "r3", expiresAt: now - 1000 }, createdAt: now, lastSeenAt: now },
        ],
        removed: [],
      });
      const called = [];
      const slowRefresh = async (kind, cred) => {
        called.push(`${kind}:${cred.refreshToken}`);
        await new Promise((r) => setTimeout(r, 40));
        return { ok: true, credential: { ...cred, token: "new-" + cred.token, refreshToken: "new-" + cred.refreshToken, expiresAt: now + 3600_000 } };
      };
      const [n1, n2] = await Promise.all([
        renewStoredCredentials(now, slowRefresh, ["chatgpt"]),
        renewStoredCredentials(now, slowRefresh, ["claude"]),
      ]);
      assert.equal(n1, 1, "chatgpt renewed");
      assert.equal(n2, 1, "claude renewed concurrently");
      assert.ok(called.includes("chatgpt:r1") && called.includes("claude:r2"));
      assert.ok(!called.includes("claude:r3"), "hidden account must not be renewed");
    });

    // 7. cli-switch: does not resurrect purged/hidden accounts, preserves fresher TokenPulse cred
    await check("cli-switch respects purged/hidden outgoing accounts and fresher stored credentials", async () => {
      const now = Date.now();
      const home = path.join(root, "switch-home");
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify({
        claudeAiOauth: { accessToken: "old-cli", refreshToken: "old-rt", expiresAt: now - 5000, scopes: ["user:inference"] },
      }));
      fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
        oauthAccount: { accountUuid: "uuid-out", emailAddress: "out@example.com" },
      }));
      writeOfficialAccountStore({
        version: 2,
        active: {},
        accounts: [
          { id: "claude:uuid-in", kind: "claude", ref: "uuid-in", email: "in@example.com", label: "in", credential: { token: "in-tok", refreshToken: "in-rt", expiresAt: now + 7200_000 }, createdAt: now, lastSeenAt: now },
        ],
        removed: ["claude:uuid-out"],
      });
      await switchCliAccount("claude:uuid-in", home);
      const afterPurged = readOfficialAccountStore();
      assert.equal(afterPurged.accounts.some((a) => a.id === "claude:uuid-out"), false, "purged outgoing account must not be resurrected");

      // Now test hidden outgoing account & fresher stored credential
      fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify({
        claudeAiOauth: { accessToken: "stale-cli", refreshToken: "stale-rt", expiresAt: now - 5000, scopes: ["user:inference"] },
      }));
      fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
        oauthAccount: { accountUuid: "uuid-fresh", emailAddress: "fresh@example.com" },
      }));
      writeOfficialAccountStore({
        version: 2,
        active: {},
        accounts: [
          { id: "claude:uuid-fresh", kind: "claude", ref: "uuid-fresh", email: "fresh@example.com", label: "fresh", credential: { token: "fresh-tp", refreshToken: "fresh-rt", expiresAt: now + 7200_000 }, createdAt: now, lastSeenAt: now },
          { id: "claude:uuid-in", kind: "claude", ref: "uuid-in", email: "in@example.com", label: "in", credential: { token: "in-tok", refreshToken: "in-rt", expiresAt: now + 7200_000 }, createdAt: now, lastSeenAt: now },
        ],
        removed: [],
      });
      await switchCliAccount("claude:uuid-in", home);
      const afterFresh = readOfficialAccountStore();
      const freshAcc = afterFresh.accounts.find((a) => a.id === "claude:uuid-fresh");
      assert.equal(freshAcc.credential.token, "fresh-tp", "fresher stored TokenPulse credential not clobbered by stale CLI credential");
    });

    // 8. oauth isolatedEnv case-insensitive stripping & listOfficialOAuthStatus skipRenew/allowedKinds
    await check("oauth isolatedEnv strips mixed-case keys and listOfficialOAuthStatus respects skipRenew", async () => {
      const env = isolatedEnv(path.join(root, "tmp-oauth"), {
        openai_api_key: "sk-leak",
        Anthropic_Base_Url: "https://evil.example",
        XAI_Api_Key: "xai-leak",
        PATH: process.env.PATH,
      });
      assert.equal(Object.keys(env).some((k) => /^openai_api_key|anthropic_base_url|xai_api_key$/i.test(k)), false);
      // listOfficialOAuthStatus should accept options without throwing and skip renewal when skipRenew: true
      const now = Date.now();
      writeOfficialAccountStore({
        version: 2,
        active: {},
        accounts: [
          { id: "claude:exp", kind: "claude", ref: "exp", email: "e@e.com", label: "e", credential: { token: "t", refreshToken: "rt", expiresAt: now - 1000 }, createdAt: now, lastSeenAt: now },
        ],
        removed: [],
      });
      const list = await listOfficialOAuthStatus(now, { skipRenew: true });
      assert.equal(list.length, 3);
      assert.equal(readOfficialAccountStore().accounts[0].renewFailed, undefined, "skipRenew did not attempt renewal");
    });

    // 9. curlPost multi-byte UTF-8 split across stdout chunks
    await check("curlPost preserves multi-byte UTF-8 split across chunks", async () => {
      const emoji = "中文测试🚀".repeat(50);
      const body = JSON.stringify({ msg: emoji });
      const srv = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        const buf = Buffer.from(body, "utf8");
        let off = 0;
        const pump = () => {
          if (off >= buf.length) { res.end(); return; }
          res.write(buf.subarray(off, Math.min(buf.length, off + 35)));
          off += 35;
          setTimeout(pump, 1);
        };
        pump();
      });
      await new Promise((r) => srv.listen(0, "127.0.0.1", r));
      try {
        const res = await curlPost(`http://127.0.0.1:${srv.address().port}/t`, "{}", ["Content-Type: application/json"]);
        assert.equal(res.status, 200);
        assert.equal(res.json.msg, emoji);
      } finally {
        srv.close();
        srv.closeAllConnections?.();
      }
    });

    // 10. quota isAuthFailure does not misclassify timeout containing '401' as auth failure, and fetchOfficialQuota with pick does not emit blocked for unpicked providers
    await check("quota isAuthFailure avoids timeout 12401 false positive and fetchOfficialQuota respects pick for gate", async () => {
      const issues = [{ kind: "claude", who: "Alice", reason: "error", detail: "curl: (28) Operation timed out after 12401 milliseconds" }];
      assert.equal(quotaIssueTone(issues), "warning");
      assert.ok(!quotaIssueNotice(issues).includes("登录已失效"), "timeout 12401ms must not say expired login");

      const now = Date.now();
      writeOfficialAccountStore({
        version: 2,
        active: {},
        accounts: [
          { id: "claude:c1", kind: "claude", ref: "c1", email: "c1@e.com", label: "c1", credential: { token: "t1", expiresAt: now + 3600_000 }, createdAt: now, lastSeenAt: now },
          { id: "chatgpt:g1", kind: "chatgpt", ref: "g1", email: "g1@e.com", label: "g1", credential: { token: "t2", expiresAt: now + 3600_000 }, createdAt: now, lastSeenAt: now },
        ],
        removed: [],
      });
      const gated = [];
      const res = await fetchOfficialQuota(
        true,
        async (kind) => { gated.push(kind); return false; },
        (kind) => kind === "chatgpt",
      );
      assert.deepEqual(gated, ["chatgpt"], "only picked provider gated");
      assert.equal(res.issues.some((i) => i.kind === "claude" && i.reason === "blocked"), false, "unpicked claude not reported blocked");
    });

    console.log(`\nWave 2: ${passed}/${passed + failed} passed`);
    if (failed > 0) process.exit(1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
