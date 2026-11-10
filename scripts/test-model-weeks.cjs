/*
 * Claude 按型号的周额度（Max 的 Fable）。src/core/quota.ts 的 claudeModelWeeks / claudeTierOf / claudeTier。
 * 覆盖：只认 limits[] 里 weekly_scoped + 型号名的行；套餐以账号资料接口为准，只有 Max 及以上带出来、Pro / 免费版不带、
 * 查不到不带；没有按型号的行时不去问套餐（Pro 不多发请求）；套餐按账号缓存；资料接口失败不影响额度、日志不带令牌；
 * 采样历史记下来、只有 Fable 变了也记一条；账号报告带上 modelWeeks。
 * 用一次性的 HOME 和数据目录造假账号，curl 换成假实现，不碰真实登录、不访问官方接口。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-model-weeks-"));
process.env.HOME = process.env.USERPROFILE = path.join(root, "home");
process.env.TOKENPULSE_DATA_DIR = path.join(root, "data");
for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"]) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });

const build = (file) => require(path.join(__dirname, "..", "build", ...file.split("/")));
const accounts = build("core/accounts.js");
const curl = build("core/curl.js");
const quota = build("core/quota.js");
const history = build("core/quota-history.js");
const { analyzeAccount } = build("core/quota-monitor.js");
const appLog = build("core/app-log.js");

let checks = 0;
const pass = (name) => { checks++; console.log("PASS " + name); };

accounts.writeOfficialAccountStore({
  version: 2,
  accounts: [{ id: "claude:uuid-a", kind: "claude", ref: "uuid-a", email: "a@example.com", label: "Claude 账号", credential: { token: "tok-secret-a", expiresAt: Date.now() + 8 * 3600_000 }, createdAt: 1, lastSeenAt: 1 }],
  active: {},
});

const weekReset = new Date(Date.now() + 5 * 86400_000).toISOString();
const usage = (fable, extra = []) => ({
  five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3600_000).toISOString() },
  seven_day: { utilization: 2, resets_at: weekReset },
  limits: [
    { kind: "session", group: "x", percent: 10, severity: "normal", resets_at: weekReset, scope: null, is_active: true },
    { kind: "weekly_all", group: "x", percent: 2, severity: "normal", resets_at: weekReset, scope: null, is_active: true },
    ...(fable == null ? [] : [{ kind: "weekly_scoped", group: "x", percent: fable, severity: "normal", resets_at: weekReset, scope: { model: { display_name: "Fable" } }, is_active: true }]),
    ...extra,
  ],
});
const MAX = { account: { has_claude_max: true, has_claude_pro: false }, organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_5x" } };
const PRO = { account: { has_claude_max: false, has_claude_pro: true }, organization: { organization_type: "claude_pro", rate_limit_tier: "default_claude_ai" } };

let calls = [];
let usageBody = usage(0), profileBody = MAX;
curl.curlJson = async (url, headers) => {
  calls.push(url.includes("/profile") ? "profile" : "usage");
  assert.ok(headers.some((h) => h === "Authorization: Bearer tok-secret-a"));
  if (url.includes("/profile")) { if (profileBody instanceof Error) throw profileBody; return profileBody; }
  return usageBody;
};
const fetch = async () => { calls = []; return quota.fetchOfficialQuota(true); };

(async () => {
  try {
    // 解析：只认 weekly_scoped + 型号名，百分比不是数字的跳过
    assert.deepEqual(quota.claudeModelWeeks(usage(30, [
      { kind: "weekly_scoped", percent: "oops", scope: { model: { display_name: "Broken" } } },
      { kind: "weekly_scoped", percent: 5, scope: { surface: { display_name: "Cowork" } } },
    ])), [{ model: "Fable", pct: 30, reset: weekReset }]);
    assert.deepEqual(quota.claudeModelWeeks({}), []);
    // 套餐：Max / 团队 / 企业算「Max 及以上」，Pro / 免费版不算，认不出的不猜
    assert.equal(quota.claudeTierOf(MAX), "max");
    assert.equal(quota.claudeTierOf({ account: {}, organization: { organization_type: "claude_team" } }), "max");
    assert.equal(quota.claudeTierOf({ organization: { organization_type: "claude_enterprise" } }), "max");
    assert.equal(quota.claudeTierOf({ organization: { rate_limit_tier: "default_claude_max_20x" } }), "max");
    assert.equal(quota.claudeTierOf(PRO), "basic");
    assert.equal(quota.claudeTierOf({ organization: { organization_type: "claude_free" } }), "basic");
    assert.equal(quota.claudeTierOf({}), undefined);
    pass("only weekly_scoped model rows are read; Max, Team and Enterprise count as Max or above, Pro and Free do not");

    // Max：带出 Fable；资料接口只问一次，之后用缓存
    let got = await fetch();
    assert.deepEqual(calls, ["usage", "profile"]);
    assert.deepEqual(got.claude.modelWeeks, [{ model: "Fable", pct: 0, reset: weekReset }]);
    assert.equal(got.claude.weekPct, 2);
    usageBody = usage(12);
    got = await fetch();
    assert.deepEqual(calls, ["usage"], "套餐有缓存，不再问资料接口");
    assert.equal(got.claude.modelWeeks[0].pct, 12);
    pass("a Max account shows its Fable weekly limit; the plan is looked up once and cached");

    // 采样历史：只有 Fable 变了也记一条；账号报告带上 modelWeeks
    const samples = history.readQuotaHistory().accounts.claude;
    assert.deepEqual(samples.map((s) => s.models?.[0]?.pct), [0, 12], "五小时、周都没变，Fable 变了也要记");
    const report = analyzeAccount("claude", samples, [], Date.now());
    assert.deepEqual(report.modelWeeks.map(({ window, ...row }) => row), [{ model: "Fable", used: 12, resetAt: Date.parse(weekReset) }]);
    assert.equal(report.modelWeeks[0].window.used, 12, "按型号的周额度也有完整的窗口分析");
    assert.ok(/Fable 周 12\.0%/.test(fs.readFileSync(appLog.appLogFile(), "utf8")), "日志里有 Fable 的百分比");
    pass("Fable changes are sampled even when the 5-hour and weekly numbers stay the same; the account report carries them");

    // Fable 周额度和总窗口一样有「本机已用 / 整窗容量折算 / 剩余可用 / 预计达到上限」：只算 Fable 的请求
    {
      const H = 3600000, now = Date.UTC(2026, 10, 10, 12), reset = now + 72 * H, start = reset - 7 * 24 * H;
      const at = (h) => start + h * H;
      // 窗口过了 96 小时，Fable 从 4% 涨到 20%（最近 24 小时每小时涨 0.2 个点）；总周额度另算
      const s = [[48, 4, 10], [72, 15.2, 20], [96, 20, 30]].map(([h, fable, week]) => ({ at: at(h), account: "claude:a", week, weekReset: new Date(reset).toISOString(), models: [{ model: "Fable", pct: fable, reset: new Date(reset).toISOString() }] }));
      const rows = [
        { hour: at(50), model: "claude-fable-5-1", tokens: 300000, costUsd: 3, requests: 10, account: "claude:a" },
        { hour: at(80), model: "claude-fable-5-2", tokens: 100000, costUsd: 1, requests: 4, account: "claude:a" },
        { hour: at(81), model: "claude-opus-5-5", tokens: 900000, costUsd: 4, requests: 30, account: "claude:a" },
        { hour: at(10) - 7 * 24 * H, model: "claude-fable-5-1", tokens: 777777, costUsd: 9, requests: 9, account: "claude:a" },
      ];
      const local = analyzeAccount("claude", s, rows, now, undefined, true).modelWeeks[0].window;
      assert.equal(local.used, 20);
      assert.equal(local.usedTokens, 400000, "只算这一周里 Fable 的请求：不算 Opus、不算上一周");
      assert.equal(local.usedCostUsd, 4);
      assert.ok(local.capacity && Math.abs(local.capacity.tokens - 2000000) < 1, `整窗容量 = 400K ÷ 20% = 2M（${local.capacity?.tokens}）`);
      assert.equal(local.startAt, start, "窗口从 Fable 自己的重置时间往前推 7 天");
      assert.ok(local.projectedAtReset != null && local.projectedAtReset > 20, "有按趋势的重置时预计使用");
      assert.equal(analyzeAccount("claude", s, rows, now, undefined, true).week.usedTokens, 1300000, "总周额度照常算全部型号");
      const shared = analyzeAccount("claude", s, rows, now).modelWeeks[0].window;
      assert.equal(shared.capacity, undefined, "账号池含其他端时不倒推容量");
      assert.equal(shared.capacityReason, "unattributed");
      assert.equal(shared.usedTokens, 400000, "本机用了多少照常给");
      // 家族名匹配：显示名带 Claude / 版本号也认
      const { rowsOfModelFamily } = build("core/quota-monitor.js");
      assert.deepEqual(["Fable", "Claude Fable", "Fable 5.2"].map((name) => rowsOfModelFamily(rows, name).length), [3, 3, 3]);
      assert.equal(rowsOfModelFamily(rows, "Claude").length, 0, "只有 Claude 这个词时不乱认");
      pass("the Fable weekly window gets local usage, full-window capacity, remaining and forecast from Fable requests only");
    }

    // Pro：服务器就算返回了按型号的行也不显示
    quota.resetClaudeTiers();
    profileBody = PRO;
    got = await fetch();
    assert.deepEqual(calls, ["usage", "profile"]);
    assert.equal(got.claude.modelWeeks, undefined);
    assert.equal(got.claude.weekPct, 2, "总的额度照常");
    const proReport = analyzeAccount("claude", history.readQuotaHistory().accounts.claude, [], Date.now());
    assert.equal(proReport.modelWeeks, undefined, "最新一条没有按型号的额度，报告里也没有");
    pass("a Pro account never shows a model weekly limit");

    // 没有按型号的行：根本不去问套餐
    quota.resetClaudeTiers();
    usageBody = usage(null);
    got = await fetch();
    assert.deepEqual(calls, ["usage"]);
    assert.equal(got.claude.modelWeeks, undefined);
    pass("no model rows means no plan lookup, so Pro accounts send no extra request");

    // 资料接口失败：额度照常、不显示 Fable、不报额度问题、日志不带令牌；半小时内不再问
    quota.resetClaudeTiers();
    usageBody = usage(40);
    profileBody = Object.assign(new Error("Command failed: curl.exe -H Authorization: Bearer tok-secret-a"), { stderr: "curl: (28) Operation timed out" });
    got = await fetch();
    assert.deepEqual(calls, ["usage", "profile"]);
    assert.equal(got.claude.modelWeeks, undefined);
    assert.equal(got.issues.length, 0);
    assert.equal(got.claude.fiveHourPct, 10);
    got = await fetch();
    assert.deepEqual(calls, ["usage"], "失败后半小时内不再问");
    const logged = fs.readFileSync(appLog.appLogFile(), "utf8");
    assert.ok(/Claude 套餐没查到/.test(logged) && !logged.includes("tok-secret-a"));
    pass("a failed plan lookup hides the model row without failing the quota check or logging the token");

    console.log(`${checks}/${checks} model weekly limit checks passed`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error("FAIL", error); process.exitCode = 1; });
