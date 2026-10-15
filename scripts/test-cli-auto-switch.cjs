/**
 * 额度用满自动切 CLI 登录（0.3.55，core/cli-auto-switch.ts）。跑法（先 npm run compile）：
 *
 *   node scripts/test-cli-auto-switch.cjs
 *
 * 用一次性的数据目录造账号；额度、当前 CLI 账号和「切换」都是假的，不碰真实登录、不访问官方接口。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-auto-switch-"));
process.env.HOME = process.env.USERPROFILE = path.join(root, "home");
process.env.TOKENPULSE_DATA_DIR = path.join(root, "data");
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });

const build = (file) => require(path.join(__dirname, "..", "build", ...file.split("/")));
const accounts = build("core/accounts.js");
const auto = build("core/cli-auto-switch.js");
const { translate } = require(path.join(__dirname, "..", "renderer", "i18n.js"));

const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const NOW = Date.UTC(2026, 9, 15, 6);
const MIN = 60_000;
const cred = { token: "t", refreshToken: "r", expiresAt: NOW + 8 * 3600_000 };
function seed(extra = []) {
  const row = (ref, more = {}) => ({ id: `claude:${ref}`, kind: "claude", ref, email: `${ref}@example.com`, label: ref, createdAt: 1, lastSeenAt: 1, ...more });
  accounts.writeOfficialAccountStore({
    version: 2,
    active: {},
    accounts: [
      row("a"),
      row("b", { credential: cred }),
      row("dead", { credential: cred, renewFailed: "HTTP 400 invalid_grant" }),
      row("hidden", { credential: cred, hidden: true }),
      row("cli-only"),
      { id: "chatgpt:x", kind: "chatgpt", ref: "x", email: "x@example.com", label: "x", createdAt: 1, lastSeenAt: 1, credential: cred },
      ...extra.map((ref) => row(ref, { credential: cred })),
    ],
  });
}
/** used：已用百分比；week 可选。 */
const q = (fiveUsed, weekUsed = 10) => ({ five: { left: 100 - fiveUsed, resetAt: NOW + 3600_000 }, week: { left: 100 - weekUsed, resetAt: NOW + 3 * 86400_000 }, at: NOW });
let quotas = {};
let switched = [];
let switchImpl = async (id) => { switched.push(id); };
const deps = (more = {}) => ({
  now: NOW,
  rules: { claude: { on: true, at: 95 } },
  usesOfficial: () => true,
  current: (kind) => (kind === "claude" ? "claude:a" : undefined),
  quota: (id) => quotas[id] ?? null,
  switchTo: (id) => switchImpl(id),
  ...more,
});
const fresh = () => { auto.resetAutoSwitchForTests(); switched = []; switchImpl = async (id) => { switched.push(id); }; };

(async () => {
  try {
    seed();
    quotas = { "claude:a": q(97), "claude:b": q(40), "claude:dead": q(0), "claude:hidden": q(0), "claude:cli-only": q(0) };

    fresh();
    check("没开：不动", (await auto.autoSwitchCli(deps({ rules: {} }))).length === 0 && switched.length === 0);
    check("供应商只读保护开着：不动", (await auto.autoSwitchCli(deps({ readOnly: true }))).length === 0 && switched.length === 0);
    check("这家没在用官方登录（第三方供应商 / 号池）：不动", (await auto.autoSwitchCli(deps({ usesOfficial: () => false }))).length === 0 && switched.length === 0);
    check("判断是不是官方登录时出错：当作不是，不动", (await auto.autoSwitchCli(deps({ usesOfficial: () => { throw new Error("x"); } }))).length === 0);
    quotas["claude:a"] = q(80);
    check("还没到触发线：不动", (await auto.autoSwitchCli(deps())).length === 0 && switched.length === 0);
    quotas["claude:a"] = q(97);
    check("当前账号没有额度数据：不动", (await auto.autoSwitchCli(deps({ quota: (id) => (id === "claude:a" ? null : quotas[id] ?? null) }))).length === 0);

    fresh();
    let events = await auto.autoSwitchCli(deps());
    check("5 小时用到 97%：切到能切的账号（被拒的、隐藏的、没存登录的都不算）", switched.join() === "claude:b" && events[0]?.result === "switched" && events[0].to === "claude:b" && events[0].window === "five" && events[0].used === 97 && events[0].toLeft === 60, JSON.stringify(events));
    check("记进 cli-auto-switch.json", auto.readAutoSwitchEvents().at(-1)?.to === "claude:b");
    const text = auto.describeAutoSwitch(events[0]);
    check("通知说清楚切到谁、为什么、开着的会话要重开", text.title === "已把 Claude Code 切到 b@example.com" && text.body === "a@example.com 的5 小时额度已用 97%，新账号剩 60%。已经开着的会话要重新打开才会用新账号。", JSON.stringify(text));
    check("英文通知", translate(text.title) === "Switched Claude Code to b@example.com" && translate(text.body) === "a@example.com’s 5-hour quota is 97% used; the new account has 60% left. Sessions that are already open must be reopened to use the new account.", translate(text.body));

    check("刚切过：10 分钟内不再切", (await auto.autoSwitchCli(deps({ now: NOW + 5 * MIN }))).length === 0 && switched.length === 1);
    events = await auto.autoSwitchCli(deps({ now: NOW + 11 * MIN }));
    check("冷却过了还满着：再切", events[0]?.result === "switched" && switched.length === 2);

    fresh();
    quotas["claude:a"] = q(20, 99.5);
    events = await auto.autoSwitchCli(deps());
    check("每周窗口用满也算，记的是每周", events[0]?.window === "week" && events[0].used === 99.5);

    fresh();
    seed(["f"]);
    quotas = { "claude:a": q(96), "claude:b": q(60), "claude:f": q(30, 5) };
    await auto.autoSwitchCli(deps());
    check("几个都能切：挑剩得最多的（两个窗口里少的那个比）", switched.join() === "claude:f", switched.join());

    fresh();
    seed();
    quotas = { "claude:a": q(96), "claude:b": q(88) };
    events = await auto.autoSwitchCli(deps());
    check("别的号剩得不够（要比触发线多剩 10 个点）：不切，记 no-target", switched.length === 0 && events[0]?.result === "no-target");
    check("英文：没有能切的号", translate(auto.describeAutoSwitch(events[0]).title) === "Claude Code’s account is almost used up and there is no account to switch to");
    check("没有能切的号只提醒一次", (await auto.autoSwitchCli(deps({ now: NOW + 20 * MIN }))).length === 0);
    quotas["claude:a"] = q(50);
    await auto.autoSwitchCli(deps({ now: NOW + 30 * MIN }));
    quotas["claude:a"] = q(96);
    check("回到线下再满：再提醒", (await auto.autoSwitchCli(deps({ now: NOW + 40 * MIN })))[0]?.result === "no-target");
    check("别的号没有额度数据：不算能切", (await (async () => { fresh(); return auto.autoSwitchCli(deps({ quota: (id) => (id === "claude:a" ? q(99) : null) })); })())[0]?.result === "no-target");

    fresh();
    quotas = { "claude:a": q(99), "claude:b": q(10) };
    switchImpl = async () => { throw new Error("上一次切换还没完成，请稍候"); };
    events = await auto.autoSwitchCli(deps());
    check("切换失败：记 failed 和原因", events[0]?.result === "failed" && events[0].error === "上一次切换还没完成，请稍候" && events[0].to === "claude:b");
    check("失败后同样冷却，不会每分钟撞一次", (await auto.autoSwitchCli(deps({ now: NOW + MIN }))).length === 0);
    check("英文：切换失败", translate(auto.describeAutoSwitch(events[0]).body) === "Tried to switch from a@example.com to b@example.com: 上一次切换还没完成，请稍候".replace("上一次切换还没完成，请稍候", translate("上一次切换还没完成，请稍候")));

    fresh();
    quotas = { "claude:a": q(99), "claude:b": q(10) };
    let calls = 0;
    switchImpl = async (id) => { calls += 1; await new Promise((r) => setTimeout(r, 30)); switched.push(id); };
    await Promise.all([auto.autoSwitchCli(deps()), auto.autoSwitchCli(deps())]);
    check("同时触发两轮只切一次", calls === 1);

    fresh();
    check("每家分开：Codex 没开时只看 Claude", (await auto.autoSwitchCli(deps({ current: (kind) => (kind === "chatgpt" ? "chatgpt:y" : "claude:a"), quota: (id) => (id === "chatgpt:y" ? q(99) : quotas[id] ?? null) })))[0]?.kind === "claude");

    const r = auto.normalizeRule;
    check("规则校验：只认 90 / 95 / 99，其他按 95；on 必须是 true", r({ on: true, at: 99 }).at === 99 && r({ on: true, at: 50 }).at === 95 && r({ on: "yes" }).on === false && r(null).on === false && r(undefined).at === 95);

    const many = Array.from({ length: 60 }, () => ({ at: NOW, kind: "claude", result: "no-target", from: "claude:a", window: "five", used: 99 }));
    fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, "cli-auto-switch.json"), JSON.stringify({ events: many }));
    fresh();
    await auto.autoSwitchCli(deps());
    check("记录最多留 50 条", auto.readAutoSwitchEvents().length === 50);
    check("记录里没有凭据", !/"token"|refreshToken/.test(fs.readFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, "cli-auto-switch.json"), "utf8")));
  } catch (error) {
    console.error(error);
    results.push(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} 通过`);
  assert.equal(passed, results.length, "cli auto switch regression failed");
})();
