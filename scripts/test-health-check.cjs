/**
 * 体检的判断和文案（0.3.55，core/health-check.ts 的 buildHealthReport）。纯函数，不读真实状态、不联网。跑法（先 npm run compile）：
 *
 *   node scripts/test-health-check.cjs
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildHealthReport } = require(path.join(__dirname, "..", "build", "core", "health-check.js"));
const { translate } = require(path.join(__dirname, "..", "renderer", "i18n.js"));

const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const NOW = new Date(2026, 9, 15, 14, 0).getTime();
const healthy = () => ({
  now: NOW,
  drift: [],
  leftovers: [],
  route: { port: 17621, running: true, listening: true, users: ["Codex（透明转发）"] },
  readOnly: false,
  accounts: [
    { kindLabel: "Claude", name: "a@example.com", inCli: true, usable: true, needsLogin: false, waitCli: false, hidden: false },
    { kindLabel: "Claude", name: "b@example.com", inCli: false, usable: true, needsLogin: false, waitCli: false, hidden: false },
  ],
  autoSwitchIdle: [],
  renewLog: [{ at: NOW - 3600_000, kindLabel: "Claude", name: "b@example.com", source: "stored", ok: true }],
  egress: { enabled: true, providers: [{ name: "Claude", ip: "203.0.113.5", region: "US" }] },
  proxy: { mode: "system", address: "127.0.0.1:7890" },
  reach: [{ name: "Claude", host: "api.anthropic.com", ok: true, status: 404, ms: 320 }],
  data: { dir: "C:\\data", writable: true, freeBytes: 50 * 1024 ** 3, tmpFiles: 0, tmpBytes: 0 },
});
const find = (report, id) => report.items.find((item) => item.id === id);

let report = buildHealthReport(healthy(), 1200);
check("全都正常：没有 bad / warn", report.summary.bad === 0 && report.summary.warn === 0 && report.ms === 1200, JSON.stringify(report.summary));
check("四组都有内容", ["tools", "accounts", "network", "data"].every((group) => report.items.some((item) => item.group === group)));
check("账号都正常：合成一条", find(report, "accounts")?.title === "2 个官方账号的凭据都正常");
check("续期都成功", find(report, "renew-log")?.title === "最近 24 小时续期 1 次，全部成功");
check("本地路由正常写出端口和谁在用", find(report, "route")?.level === "ok" && /17621/.test(find(report, "route").title) && /Codex（透明转发）/.test(find(report, "route").detail));
check("代理说明", find(report, "proxy")?.title === "访问官方走系统代理（127.0.0.1:7890）");
check("连通：拿到任何状态码都算连得上", find(report, "reach-api.anthropic.com")?.level === "ok");

const broken = healthy();
broken.drift = [{ appName: "Claude Code", expectedName: "官方登录", liveName: "relay.example.com" }];
broken.leftovers = [{ appName: "Grok CLI", kind: "route", url: "http://127.0.0.1:17621/grok/v1" }];
broken.route = { port: 17621, running: false, listening: null, users: ["Grok CLI"] };
broken.readOnly = true;
broken.accounts = [
  { kindLabel: "Claude", name: "dead@example.com", inCli: false, usable: false, needsLogin: true, waitCli: false, renewError: "HTTP 400 invalid_grant", hidden: false },
  { kindLabel: "Claude", name: "cli@example.com", inCli: true, usable: false, needsLogin: false, waitCli: true, hidden: false },
  { kindLabel: "ChatGPT", name: "shaky@example.com", inCli: false, usable: true, needsLogin: false, waitCli: false, renewError: "HTTP 401", hidden: false },
  { kindLabel: "Grok", name: "hidden@example.com", inCli: false, usable: false, needsLogin: true, waitCli: false, hidden: true },
];
broken.autoSwitchIdle = [{ cli: "Claude Code", reason: "供应商「只读保护」开着，不会自动切换" }];
broken.renewLog = [
  { at: NOW - 7200_000, kindLabel: "Claude", name: "dead@example.com", source: "stored", ok: false, status: 400, code: "invalid_grant", permanent: true },
  { at: NOW - 3600_000, kindLabel: "ChatGPT", name: "", source: "stored", ok: false, error: "curl: timed out" },
  { at: NOW - 600_000, kindLabel: "Claude", name: "cli@example.com", source: "cli", ok: true },
];
broken.egress = { enabled: true, providers: [{ name: "ChatGPT", ip: "198.51.100.7", region: "JP", blocked: "ip_mismatch" }] };
broken.proxy = { mode: "direct" };
broken.reach = [{ name: "Claude", host: "api.anthropic.com", ok: false, error: "Connection timed out after 8000 milliseconds" }, { name: "ChatGPT", host: "chatgpt.com", ok: false, skipped: true }];
broken.data = { dir: "C:\\data", writable: false, error: "EACCES", freeBytes: 300 * 1024 ** 2, tmpFiles: 2, tmpBytes: 400 * 1024 };
report = buildHealthReport(broken);

check("配置被改走：warn，写清现在连的和该连的，按钮去供应商页", find(report, "drift-0")?.level === "warn" && /relay\.example\.com/.test(find(report, "drift-0").detail) && find(report, "drift-0").action.page === "providers");
check("配置还指着本地路由、路由没跑：bad，说清常见原因", find(report, "leftover-0")?.level === "bad" && /强制结束/.test(find(report, "leftover-0").detail));
check("该走本地路由的工具连不上：bad", find(report, "route")?.level === "bad" && find(report, "route").title === "本地路由没在运行");
check("只读保护：提示", find(report, "readonly")?.level === "info");
check("需要重新登录：bad，带原因，CLI 外的号叫你重新授权", find(report, "account-0")?.level === "bad" && /invalid_grant/.test(find(report, "account-0").detail) && /重新授权/.test(find(report, "account-0").detail));
check("登在 CLI 里等 CLI 续：只是提示", find(report, "account-1")?.level === "info");
check("还能用但上次续期没成：warn", find(report, "account-2")?.level === "warn" && /HTTP 401/.test(find(report, "account-2").detail));
check("隐藏的账号不报", !report.items.some((item) => /hidden@example\.com/.test(item.title)));
const renew = find(report, "renew-log");
check("续期失败列出来（新的在前，只有状态码和错误类型），有要重新登录的就是 bad", renew?.level === "bad" && renew.lines.length === 2 && /HTTP 400 invalid_grant，需要重新登录/.test(renew.lines[1]) && /curl: timed out/.test(renew.lines[0]), JSON.stringify(renew?.lines));
check("自动切换不起作用的原因", find(report, "auto-switch-0")?.detail === "供应商「只读保护」开着，不会自动切换");
check("直连时提示怎么设代理", find(report, "proxy")?.title === "访问官方没有走代理（直连）" && /HTTPS_PROXY/.test(find(report, "proxy").detail));
check("连不上：bad，带原因", find(report, "reach-api.anthropic.com")?.level === "bad" && /timed out/.test(find(report, "reach-api.anthropic.com").detail));
check("出口不在白名单：没去测，按钮去出口监控", find(report, "reach-chatgpt.com")?.level === "info" && find(report, "reach-chatgpt.com").action.page === "egress");
check("额度查询被出口规则拦下：warn", find(report, "egress-0")?.level === "warn" && /198\.51\.100\.7（JP）/.test(find(report, "egress-0").detail));
check("数据目录写不进去：bad；磁盘不够：warn；临时文件：提示", find(report, "data-write")?.level === "bad" && find(report, "disk")?.level === "warn" && /300\.0 MB/.test(find(report, "disk").title) && find(report, "tmp")?.level === "info");
check("计数", report.summary.bad === 6, JSON.stringify(report.summary));

const empty = healthy();
empty.accounts = []; empty.renewLog = []; empty.route = { port: 17621, running: false, listening: null, users: [] }; empty.egress = { enabled: false, providers: [] };
report = buildHealthReport(empty);
check("没有账号、没人走路由、没开出口监控：都只是提示", find(report, "accounts")?.level === "info" && find(report, "route")?.level === "info" && find(report, "egress")?.level === "info" && !find(report, "renew-log"));
const listening = healthy();
listening.route.listening = false;
check("路由在跑但端口连不上：bad", buildHealthReport(listening).items.find((item) => item.id === "route").title === "本地路由的端口 17621 连不上");

// 英文：每一条标题和说明都要翻得出来（不能留中文）
const english = [buildHealthReport(healthy()), buildHealthReport(broken), buildHealthReport(empty), buildHealthReport(listening)]
  .flatMap((r) => r.items.flatMap((item) => [item.title, item.detail, item.action?.label, ...(item.lines || [])]))
  .filter(Boolean);
const untranslated = [...new Set(english.filter((text) => /[\u4e00-\u9fff]/.test(translate(text))))];
check("所有标题、说明、按钮都有英文", untranslated.length === 0, `${untranslated.length} 句没翻`);
for (const text of untranslated) console.log("    没翻：" + text);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
assert.equal(passed, results.length, "health check regression failed");
