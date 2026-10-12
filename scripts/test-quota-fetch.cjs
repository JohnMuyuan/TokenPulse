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
const { fetchOfficialQuota, quotaIssueNotice, quotaIssueTone, quotaRefreshSummary } = build("core/quota.js");
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
    check("读不出额度时写出是哪家哪个账号", empty === "Claude 的 a@example.com 这次没问到最新额度，还是显示上次的数字。", empty);
    check("英文：读不出额度", translate(empty) === "Claude account a@example.com could not get the latest quota this time. Still showing the last numbers.");
    check("登录失效是红色，问不到数字是黄色", quotaIssueTone([{ kind: "claude", who: "Claude", reason: "auth" }]) === "error" && quotaIssueTone([{ kind: "claude", who: "Claude", reason: "empty" }]) === "warning");

    const blocked = quotaIssueNotice([{ kind: "claude", who: "Claude", reason: "blocked" }]);
    check("出口拦下的提示写明没查", /出口 IP 不在允许列表/.test(blocked), blocked);

    const net = quotaIssueNotice([{ kind: "claude", who: "Claude", reason: "error", detail: "not json" }]);
    check("接口内容看不懂时不把原始错误甩出来", net === "Claude 这次没问到最新额度，还是显示上次的数字。", net);
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
    check("报错提示可读", /Claude 的 a@example.com 这次没问到最新额度|没连上官方/.test(quotaIssueNotice(failed.issues)), quotaIssueNotice(failed.issues));

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
    const gated = await fetchOfficialQuota(true, async (kind) => kind !== "claude");
    check("出口拦住时不去问官方", curlCalls === 0, String(curlCalls));
    check("拦住时记 blocked", gated.issues.length === 1 && gated.issues[0].reason === "blocked", JSON.stringify(gated.issues));

    const failedCount = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failedCount}/${results.length} quota-fetch checks`);
    if (failedCount) process.exitCode = 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    curl.curlJson = origJson;
  }
})();
