/**
 * 官方额度没查到时，刷新必须带出原因。跑法（先 npm run compile）：
 *
 *   node scripts/test-quota-fetch.cjs
 *
 * 用一次性的 HOME 和数据目录造假账号，curl 换成假实现，不碰真实登录、不访问官方接口。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-quota-fetch-"));
process.env.HOME = process.env.USERPROFILE = path.join(root, "home");
process.env.TOKENPULSE_DATA_DIR = path.join(root, "data");
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });

const build = (file) => require(path.join(__dirname, "..", "build", ...file.split("/")));
const accounts = build("core/accounts.js");
const curl = build("core/curl.js");
const cliRenew = build("core/cli-renew.js");
const origCliRenew = cliRenew.renewCliCredential;
const { fetchOfficialQuota, quotaIssueNotice, quotaIssueTone, quotaRefreshSummary, rateLimitWaitMs, resetQuotaCooldowns } = build("core/quota.js");
const appLog = build("core/app-log.js");
const { translate } = require(path.join(__dirname, "..", "renderer", "i18n.js"));

const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

function seed(expiresAt) {
  accounts.writeOfficialAccountStore({
    version: 2,
    accounts: [
      {
        id: "claude:uuid-a",
        kind: "claude",
        ref: "uuid-a",
        email: "a@example.com",
        label: "Claude 账号",
        credential: { token: "tok-a", expiresAt },
        createdAt: 1,
        lastSeenAt: 1,
      },
    ],
    active: {},
  });
}

const origJson = curl.curlJson;
let curlCalls = 0;
let curlImpl = async () => ({});
curl.curlJson = async (...args) => {
  curlCalls += 1;
  return curlImpl(...args);
};

(async () => {
  try {
    const expired = quotaIssueNotice([{ kind: "claude", who: "Claude", reason: "expired" }]);
    check("过期凭据直接说重新登录", expired === "Claude 登录已失效，请重新登录。", expired);
    check("英文能翻完整句", translate(expired) === "Claude sign-in has expired. Please sign in again.");

    const auth = quotaIssueNotice([{ kind: "claude", who: "a@example.com", reason: "auth", detail: "auth" }]);
    check("官方回登录错误也说重新登录", auth === "Claude 的 a@example.com 登录已失效，请重新登录。", auth);
    check("英文写出公司和账号", translate(auth) === "Claude account a@example.com sign-in has expired. Please sign in again.");

    const empty = quotaIssueNotice([{ kind: "claude", who: "a@example.com", reason: "empty" }]);
    check("读不出额度时写出是哪家哪个账号", empty === "Claude 的 a@example.com 的额度没查到：官方返回里没有额度数字，先显示上次的数字。详细原因已记在日志（设置 →「数据」→「打开日志」）。", empty);
    const odd = quotaIssueNotice([{ kind: "claude", who: "a@example.com", reason: "error", detail: "something odd" }]);
    check("认不出的错误：用兜底句", odd.startsWith("Claude 的 a@example.com 这次没问到最新额度，还是显示上次的数字。"), odd);
    check("英文：兜底句", translate(odd).startsWith("Claude account a@example.com could not get the latest quota this time. Still showing the last numbers."), translate(odd));
    check("登录失效是红色，问不到数字是黄色", quotaIssueTone([{ kind: "claude", who: "Claude", reason: "auth" }]) === "error" && quotaIssueTone([{ kind: "claude", who: "Claude", reason: "empty" }]) === "warning");

    const blocked = quotaIssueNotice([{ kind: "claude", who: "Claude", reason: "blocked" }]);
    check("出口拦下的提示写明没查", /出口 IP 不在允许列表/.test(blocked), blocked);

    const net = quotaIssueNotice([{ kind: "claude", who: "Claude", reason: "error", detail: "not json" }]);
    check("接口内容看不懂时说清是返回的不是额度数据，并指向日志", net === "Claude 的额度没查到：官方返回的不是额度数据，可能被代理或网络拦截了，先显示上次的数字。详细原因已记在日志（设置 →「数据」→「打开日志」）。", net);
    check("英文：不是额度数据 + 日志", translate(net) === "Claude quota was not fetched: the response was not quota data (a proxy or network filter may have intercepted it). Showing the last numbers for now. The exact reason is in the log (Settings → “Data” → “Open log”).", translate(net));

    // 0.3.63 起各种「没问到」分开说：限流 / 服务器出错 / 其它 HTTP / 没有额度数字；剩下认不出的才用老的兜底句
    const at = new Date(2026, 9, 23, 20, 15).getTime();
    const limited = quotaIssueNotice([{ kind: "claude", who: "a@example.com", reason: "rate-limited", retryAt: at, detail: "http 429" }]);
    check("429：说被限流、几点再查，不指向日志、黄色", limited === "Claude 的 a@example.com 被官方限流了（HTTP 429），约 20:15 再自动查，先显示上次的数字。" && quotaIssueTone([{ kind: "claude", who: "a", reason: "rate-limited" }]) === "warning", limited);
    check("英文：429", translate(limited) === "Claude account a@example.com is rate-limited by the official API (HTTP 429). It will be checked again automatically around 20:15; showing the last numbers for now.", translate(limited));
    const server = quotaIssueNotice([{ kind: "claude", who: "a@example.com", reason: "error", detail: "http 503" }]);
    check("5xx：说官方服务器出错", server.startsWith("Claude 的 a@example.com 的额度没查到：官方服务器出错（HTTP 503），先显示上次的数字。") && /打开日志/.test(server), server);
    check("英文：5xx", translate(server).startsWith("Claude account a@example.com quota was not fetched: the official server had an error (HTTP 503)."), translate(server));
    const other = quotaIssueNotice([{ kind: "chatgpt", who: "b@example.com", reason: "error", detail: "http 404" }]);
    check("其它 4xx：写出状态码", other.startsWith("ChatGPT 的 b@example.com 的额度没查到：官方返回 HTTP 404，先显示上次的数字。"), other);
    const nothing = quotaIssueNotice([{ kind: "claude", who: "a@example.com", reason: "empty" }]);
    check("empty：说返回里没有额度数字", nothing.startsWith("Claude 的 a@example.com 的额度没查到：官方返回里没有额度数字，先显示上次的数字。"), nothing);
    check("英文：empty", translate(nothing).startsWith("Claude account a@example.com quota was not fetched: the response had no quota numbers."), translate(nothing));
    check("两个账号都被限流：两句都在", (quotaIssueNotice([{ kind: "claude", who: "a@example.com", reason: "rate-limited", retryAt: at }, { kind: "claude", who: "b@example.com", reason: "rate-limited" }]) || "").includes("b@example.com 被官方限流了（HTTP 429），过几分钟再自动查"));
    check("退避：2 分钟起翻倍、封顶 15 分钟；Retry-After 更长时听官方的", rateLimitWaitMs(1) === 120_000 && rateLimitWaitMs(2) === 240_000 && rateLimitWaitMs(9) === 900_000 && rateLimitWaitMs(1, 30_000) === 120_000 && rateLimitWaitMs(1, 1_800_000) === 1_800_000 && rateLimitWaitMs(1, 99 * 3600_000) === 3600_000);
    check("没有问题就没有这句话", quotaIssueNotice([]) === undefined && quotaIssueNotice(undefined) === undefined);

    const none = quotaRefreshSummary([{ id: "claude:a", who: "Claude", five: 40, week: 20 }], [{ id: "claude:a", who: "Claude", five: 40, week: 20 }]);
    check("额度没变时也说已刷新", none === "已刷新。官方额度没有变化。", none);
    check("英文：没有变化", translate(none) === "Refreshed. Official quota is unchanged.");
    const named = quotaRefreshSummary(
      [{ id: "claude:a", who: "a@example.com", kind: "claude", five: 80, week: 40 }],
      [{ id: "claude:a", who: "a@example.com", kind: "claude", five: 100, week: 40 }],
    );
    check("额度变化也写出公司和账号", named === "已刷新。Claude 的 a@example.com 5 小时 80.0% → 100.0%（+20.0%）。", named);
    const rose = quotaRefreshSummary([{ id: "claude:a", who: "Claude", five: 80, week: 40 }], [{ id: "claude:a", who: "Claude", five: 100, week: 40 }]);
    check("5 小时涨了要写出前后和差值", rose === "已刷新。Claude 5 小时 80.0% → 100.0%（+20.0%）。", rose);
    check("英文：5 小时变化", translate(rose) === "Refreshed. Claude 5-hour 80.0% → 100.0% (+20.0%).");
    const reset = quotaRefreshSummary([{ id: "claude:a", who: "Claude", five: 100, week: 40 }], [{ id: "claude:a", who: "Claude", five: 0, week: 40 }]);
    check("重置掉下来写成负数", reset === "已刷新。Claude 5 小时 100.0% → 0.0%（-100.0%）。", reset);
    const first = quotaRefreshSummary([], [{ id: "claude:a", who: "Claude", five: 12, week: 8 }]);
    check("第一次查到写出当前已用", first === "已刷新。Claude 5 小时已用 12.0%。Claude 周额度已用 8.0%。", first);
    check("没有官方账号时只说本机用量已更新", quotaRefreshSummary([], []) === "已刷新。本机用量已更新。");

    seed(Date.now() - 60_000);
    curlCalls = 0;
    const skipped = await fetchOfficialQuota(true);
    check("凭据过期时不去问官方", curlCalls === 0, String(curlCalls));
    check("过期账号记一条 expired", skipped.issues.length === 1 && skipped.issues[0].reason === "expired" && skipped.issues[0].who === "a@example.com", JSON.stringify(skipped.issues));
    check("过期时没有额度采样", !skipped.all?.length);

    seed(Date.now() + 8 * 3600_000);
    curlCalls = 0;
    curlImpl = async () => ({});
    const blank = await fetchOfficialQuota(true);
    check("接口空对象记一条 empty", blank.issues.length === 1 && blank.issues[0].reason === "empty", JSON.stringify(blank.issues));
    check("空结果不会编数字", !blank.claude && !blank.all?.length);

    curlCalls = 0;
    curlImpl = async () => {
      throw new Error("not json");
    };
    const failed = await fetchOfficialQuota(true);
    check("接口报错记一条 error", failed.issues.length === 1 && failed.issues[0].reason === "error", JSON.stringify(failed.issues));
    check("报错提示可读", /Claude 的 a@example.com 的额度没查到：官方返回的不是额度数据/.test(quotaIssueNotice(failed.issues)), quotaIssueNotice(failed.issues));

    // ---- 429 冷却 ----
    curlCalls = 0;
    curlImpl = async () => { throw new curl.HttpError(429, 300_000, "rate_limit_error"); };
    const hit = await fetchOfficialQuota(true);
    const cooling = hit.issues[0];
    check("429：记 rate-limited，冷却到 Retry-After（5 分钟）之后", hit.issues.length === 1 && cooling.reason === "rate-limited" && Math.abs(cooling.retryAt - Date.now() - 300_000) < 5000 && curlCalls === 1, JSON.stringify(hit.issues));
    curlImpl = async () => ({ five_hour: { utilization: 1, resets_at: "2026-10-11T14:00:00.000Z" }, seven_day: { utilization: 2, resets_at: "2026-10-14T12:00:00.000Z" } });
    const still = await fetchOfficialQuota(true);
    check("冷却中再刷新：不发请求，还是说限流、时间不变", curlCalls === 1 && still.issues[0]?.reason === "rate-limited" && still.issues[0].retryAt === cooling.retryAt, JSON.stringify(still.issues));
    resetQuotaCooldowns();
    const back = await fetchOfficialQuota(true);
    check("冷却过了就再问，查到了不报问题", curlCalls === 2 && back.issues.length === 0 && back.claude?.fiveHourPct === 1, JSON.stringify(back.issues));
    curlImpl = async () => { throw new curl.HttpError(429); };
    const twice = [await fetchOfficialQuota(true)];
    resetQuotaCooldowns();
    check("查到一次后冷却清零：再 429 从 2 分钟重新算", Math.abs(twice[0].issues[0].retryAt - Date.now() - 120_000) < 5000, JSON.stringify(twice[0].issues));
    curlImpl = async () => { throw new curl.HttpError(503); };
    const down = await fetchOfficialQuota(true);
    check("503：记 error 和状态码，不进冷却", down.issues[0]?.reason === "error" && down.issues[0].detail === "http 503" && /官方服务器出错（HTTP 503）/.test(quotaIssueNotice(down.issues)), JSON.stringify(down.issues));
    curlCalls = 0;
    await fetchOfficialQuota(true);
    check("503 之后下一轮照常问", curlCalls === 1);
    curlImpl = async () => { const error = new Error("Command failed: curl.exe -sS -H Authorization: Bearer tok-a"); error.stderr = "curl: (28) Operation timed out after 12001 milliseconds"; throw error; };
    const slow = await fetchOfficialQuota(true);
    check("curl 超时：detail 取 curl 自己的报错（不带命令行），提示没连上官方", slow.issues[0]?.detail.startsWith("curl: (28)") && !slow.issues[0].detail.includes("tok-a") && /没连上官方/.test(quotaIssueNotice(slow.issues)), JSON.stringify(slow.issues));
    const logged = fs.readFileSync(appLog.appLogFile(), "utf8");
    check("每轮结果写进统一日志：查到的数字、限流冷却、失败原因；邮箱打码、不带 token",
      /\[quota\] Claude 的 a\*\*\*@example\.com：5 小时 1\.0%，周 2\.0%/.test(logged) && /没查到（rate-limited：http 429，冷却到 \d{2}:\d{2}）/.test(logged) && /没查到（error：curl: \(28\)/.test(logged) && !logged.includes("a@example.com") && !logged.includes("tok-a"), logged.split("\n").slice(-4).join(" | "));

    curlCalls = 0;
    curlImpl = async () => ({ type: "error", error: { type: "authentication_error", message: "invalid token" } });
    const authJson = await fetchOfficialQuota(true);
    check("官方回登录错误记成 auth", authJson.issues.length === 1 && authJson.issues[0].reason === "auth", JSON.stringify(authJson.issues));
    check("登录错误提示说重新登录", quotaIssueNotice(authJson.issues) === "Claude 的 a@example.com 登录已失效，请重新登录。", quotaIssueNotice(authJson.issues));

    curlCalls = 0;
    curlImpl = async () => {
      throw new Error("auth");
    };
    const authThrow = await fetchOfficialQuota(true);
    check("HTTP 401/403 也说重新登录", authThrow.issues[0]?.reason === "auth" && /请重新登录/.test(quotaIssueNotice(authThrow.issues)), JSON.stringify(authThrow.issues));

    curlCalls = 0;
    curlImpl = async () => ({
      five_hour: { utilization: 100, resets_at: "2026-10-11T14:00:00.000Z" },
      seven_day: { utilization: 40, resets_at: "2026-10-14T12:00:00.000Z" },
    });
    const ok = await fetchOfficialQuota(true);
    check("查到了就不报问题", ok.issues.length === 0 && ok.claude?.fiveHourPct === 100, JSON.stringify({ issues: ok.issues, five: ok.claude?.fiveHourPct }));

    curlCalls = 0;
    let cliRenewCalls = 0;
    cliRenew.renewCliCredential = async () => { cliRenewCalls += 1; return { state: "none" }; };
    const gated = await fetchOfficialQuota(true, async (kind) => kind !== "claude");
    check("出口拦住时不去问官方", curlCalls === 0, String(curlCalls));
    check("拦住时记 blocked", gated.issues.length === 1 && gated.issues[0].reason === "blocked", JSON.stringify(gated.issues));
    check("出口拦住时也不替 Claude Code 续期", cliRenewCalls === 0);

    // 0.3.54：账号登录在 Claude Code 里、CLI 凭据过期（Claude Code 在运行，等它自己续）—— 不说「请重新登录」
    fs.mkdirSync(path.join(process.env.HOME, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(process.env.HOME, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok-cli", refreshToken: "r-cli", expiresAt: Date.now() - 3600_000 } }));
    fs.writeFileSync(path.join(process.env.HOME, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-a", emailAddress: "a@example.com" } }));
    accounts.writeOfficialAccountStore({ version: 2, accounts: [{ id: "claude:uuid-a", kind: "claude", ref: "uuid-a", email: "a@example.com", label: "Claude 账号", createdAt: 1, lastSeenAt: 1 }], active: {} });
    cliRenew.renewCliCredential = async () => { cliRenewCalls += 1; return { state: "waiting", accountId: "claude:uuid-a" }; };
    curlCalls = 0;
    const waiting = await fetchOfficialQuota(true);
    const waitText = quotaIssueNotice(waiting.issues);
    check("登录在 Claude Code 里、凭据过期：记 cli-wait，不去问官方", cliRenewCalls === 1 && curlCalls === 0 && waiting.issues.length === 1 && waiting.issues[0].reason === "cli-wait", JSON.stringify(waiting.issues));
    check("cli-wait 提示说等 Claude Code 续，不说重新登录、黄色", waitText === "Claude 的 a@example.com 登录在 Claude Code 里，凭据过期了，Claude Code 下次发请求时会自动续上，不用重新登录。" && quotaIssueTone(waiting.issues) === "warning", waitText);
    check("英文：cli-wait", translate(waitText) === "Claude account a@example.com is signed in to Claude Code and its credentials expired. Claude Code renews them on its next request; no need to sign in again.", translate(waitText));
    cliRenew.renewCliCredential = async () => ({ state: "failed", accountId: "claude:uuid-a", dead: true, error: "HTTP 400 invalid_grant" });
    const dead = await fetchOfficialQuota(true);
    check("CLI 的 refresh token 被官方拒了：还是说重新登录", dead.issues[0]?.reason === "expired" && /请重新登录/.test(quotaIssueNotice(dead.issues)), JSON.stringify(dead.issues));
    cliRenew.renewCliCredential = async () => {
      fs.writeFileSync(path.join(process.env.HOME, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok-cli-new", refreshToken: "r-cli-2", expiresAt: Date.now() + 8 * 3600_000 } }));
      return { state: "renewed", accountId: "claude:uuid-a" };
    };
    curlCalls = 0;
    curlImpl = async () => ({ five_hour: { utilization: 10, resets_at: "2026-10-11T14:00:00.000Z" }, seven_day: { utilization: 20, resets_at: "2026-10-14T12:00:00.000Z" } });
    const renewedCli = await fetchOfficialQuota(true);
    check("替 Claude Code 续上之后这一轮就能查额度", renewedCli.issues.length === 0 && curlCalls === 1 && renewedCli.claude?.fiveHourPct === 10, JSON.stringify(renewedCli.issues));

    // ---- 后台账号少查一点（quota-quiet.ts）：a 登录在 Claude Code 里（在用），b 只存在 TokenPulse 里（后台） ----
    const quiet = build("core/quota-quiet.js");
    const { readQuotaChecks } = build("core/quota-history.js");
    accounts.writeOfficialAccountStore({ version: 2, accounts: [
      { id: "claude:uuid-a", kind: "claude", ref: "uuid-a", email: "a@example.com", label: "Claude 账号", createdAt: 1, lastSeenAt: 1 },
      { id: "claude:uuid-b", kind: "claude", ref: "uuid-b", email: "b@example.com", label: "Claude 账号", credential: { token: "tok-b", expiresAt: Date.now() + 8 * 3600_000 }, createdAt: 2, lastSeenAt: 2 },
    ], active: {} });
    const asked = [];
    let bFails = false;
    curlImpl = async (_url, headers) => {
      const who = headers.some((h) => h.includes("tok-b")) ? "b" : "a";
      asked.push(who);
      if (who === "b" && bFails) throw new curl.HttpError(503);
      return { five_hour: { utilization: who === "b" ? 30 : 10, resets_at: "2026-10-11T14:00:00.000Z" }, seven_day: { utilization: 20, resets_at: "2026-10-14T12:00:00.000Z" } };
    };
    const round = async (at, extra = []) => {
      asked.length = 0;
      const result = await fetchOfficialQuota(true, undefined, quiet.quietPick(quiet.foregroundAccounts(extra), readQuotaChecks().accounts, at));
      return { asked: [...asked].sort().join(","), result };
    };
    quiet.resetQuietForTests();
    const fg = quiet.foregroundAccounts([]);
    check("在用的账号：CLI 当前登录的", fg.has("claude:uuid-a") && !fg.has("claude:uuid-b"), JSON.stringify([...fg]));
    const r1 = await round(Date.now());
    check("开着：后台账号还没查到过 → 这一轮也查", r1.asked === "a,b", r1.asked);
    const r2 = await round(Date.now());
    check("刚查过的后台账号这一轮不查、也不报问题；在用的照查", r2.asked === "a" && r2.result.issues.length === 0 && r2.result.all.every((q) => q.accountId === "claude:uuid-a"), r2.asked + JSON.stringify(r2.result.issues));
    const r3 = await round(Date.now() + 29 * 60_000);
    check("29 分钟后还不查", r3.asked === "a", r3.asked);
    bFails = true;
    const r4 = await round(Date.now() + 31 * 60_000);
    check("满 30 分钟再查一次（这次出错照常报出来）", r4.asked === "a,b" && r4.result.issues.some((i) => i.accountId === "claude:uuid-b" && i.reason === "error"), r4.asked + JSON.stringify(r4.result.issues));
    const r5 = await round(Date.now() + 32 * 60_000);
    check("出错了也等满 30 分钟再试，不每轮都问", r5.asked === "a", r5.asked);
    bFails = false;
    const r6 = await round(Date.now() + 33 * 60_000, ["claude:uuid-b"]);
    check("号池里 / 桌宠固定看的账号算在用，每轮照查", r6.asked === "a,b", r6.asked);
    asked.length = 0;
    await fetchOfficialQuota(true);
    check("不传挑选（开关关着、手动刷新）：全查", [...asked].sort().join(",") === "a,b", asked.join(","));

    const failedCount = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failedCount}/${results.length} quota-fetch checks`);
    if (failedCount) process.exitCode = 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    curl.curlJson = origJson;
    cliRenew.renewCliCredential = origCliRenew;
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
