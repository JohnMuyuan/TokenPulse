import fs from "fs";
import path from "path";
import { estimateCost } from "./model-pricing";

/**
 * 新手引导用的演示数据（0.3.9）。
 *
 * 只写进调用方给的临时目录（demo.ts 放在系统临时目录里，引导结束就删），**绝不碰用户的 ~/.tokenpulse**。
 * 一个虚构的 Claude Max 账号，过去三周多的额度采样 + 本机 Code 请求：
 * - 每周容量约 $500（API 等价），5 小时窗口约 $90，额度按请求费用真实地涨，好让「额度容量趋势」「换一种模型」算得出数；
 * - 每周有几段晚上的网页聊天（额度涨了、本机没有请求），时间线上显示成「本机以外」，其中一段已标注；
 * - 模型组合随时间变化（早几周多用 Sonnet，最近多用 Opus），时间线的轨道才有看头；
 * - 最近两小时还在用，当前 5 小时窗口有进度。
 * 数据用固定种子生成，同一时刻生成的内容一样。
 */

export const DEMO_ACCOUNT = { id: "claude:demo", kind: "claude" as const, ref: "demo", label: "演示账号" };
const WEEK = 7 * 86400000, FIVE = 5 * 3600000, MINUTE = 60000;
const WEEK_CAP = 500, FIVE_CAP = 90;
const PROJECTS = ["D:\\Demo\\web-app", "D:\\Demo\\api-server", "D:\\Demo\\docs-site"];

type Combo = { model: string; effort: string; weight: (age: number) => number };
const COMBOS: Combo[] = [
  // age：离现在多少天。越近 Opus 越多
  { model: "claude-opus-5-5", effort: "high", weight: (age) => 3 + (21 - Math.min(age, 21)) / 3 },
  { model: "claude-opus-5-5", effort: "xhigh", weight: (age) => (age < 10 ? 3 : 0.6) },
  { model: "claude-sonnet-5", effort: "medium", weight: (age) => 2 + Math.min(age, 21) / 3 },
  { model: "claude-sonnet-5", effort: "high", weight: () => 1.5 },
  { model: "claude-haiku-4-5-20251001", effort: "not_supported", weight: () => 1 },
];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
const localDay = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};

export function writeDemoData(dataDir: string, now = Date.now()) {
  const random = rng(Math.floor(now / 3600000));
  // 当前周窗口：2 天 9 小时后重置；往前三整周都是完整窗口
  const weekReset0 = now + 2 * 86400000 + 9 * 3600000;
  const start = weekReset0 - 4 * WEEK;
  const midnight = (at: number) => new Date(new Date(at).setHours(0, 0, 0, 0)).getTime();

  // 1. 本机 Code 的工作时段（本地时间）：白天两段，偶尔晚上一段；周末少一些。最后补一段「刚刚还在用」
  const sessions: Array<[number, number]> = [];
  for (let day = midnight(start); day < now; day += 86400000) {
    const weekday = new Date(day).getDay(), weekend = weekday === 0 || weekday === 6;
    if (weekend && random() < 0.6) continue;
    const blocks: Array<[number, number]> = [[9.5 + random(), 11.5 + random() * 1.2], [14 + random() * .8, 16.5 + random() * 1.8]];
    if (random() < 0.35) blocks.push([21 + random() * .5, 22.3 + random()]);
    for (const [from, to] of blocks) if (!weekend || random() < 0.5) sessions.push([day + from * 3600000, day + to * 3600000]);
  }
  sessions.push([now - 110 * MINUTE, now - 3 * MINUTE]);
  const busy = (at: number) => sessions.some(([a, b]) => at >= a - 20 * MINUTE && at <= b + 20 * MINUTE);

  // 2. 网页聊天（本机以外）：每周两三段晚上 20 点前后，和本机时段错开
  const chats: Array<{ from: number; to: number; cost: number }> = [];
  for (let day = midnight(start) + 86400000; day < now - 3600000; day += 86400000) {
    if (random() > 0.32) continue;
    const from = day + (19.5 + random() * 1.2) * 3600000, to = from + (35 + random() * 50) * MINUTE;
    if (to > now - 30 * MINUTE || busy(from) || busy(to)) continue;
    chats.push({ from, to, cost: 14 + random() * 20 });
  }
  // 保证这一周里至少两段：一段已标注（实心）、一段待标注（虚线），引导里两种都要演示
  for (const back of [1, 3]) {
    if (chats.filter((c) => c.from > weekReset0 - WEEK).length >= 2) break;
    const from = midnight(now) - back * 86400000 + 20 * 3600000;
    if (from > weekReset0 - WEEK && !chats.some((c) => Math.abs(c.from - from) < 3 * 3600000)) chats.push({ from, to: from + 50 * MINUTE, cost: 24 });
  }
  chats.sort((a, b) => a.from - b.from);

  // 3. 请求流水
  type Row = { id: string; at: number; kind: string; file: string; cwd: string; model: string; requested: string; effort?: string; effortSource?: string; accountRef: string; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; costUsd: number; calls: number };
  const rows: Row[] = [];
  sessions.forEach(([from, to], index) => {
    // 一段工作时间里主要改一个项目，偶尔切到别的项目（另开一个对话）
    const main = index % PROJECTS.length;
    for (let at = from + random() * 2 * MINUTE; at < Math.min(to, now - MINUTE); at += (1 + random() * 2.2) * MINUTE) {
      const project = random() < 0.75 ? main : Math.floor(random() * PROJECTS.length);
      const cwd = PROJECTS[project], file = `demo-session-${index}-${project}.jsonl`;
      const age = (now - at) / 86400000;
      const weights = COMBOS.map((c) => c.weight(age)), total = weights.reduce((a, b) => a + b, 0);
      let pick = random() * total, combo = COMBOS[0];
      for (let i = 0; i < COMBOS.length; i++) { pick -= weights[i]; if (pick <= 0) { combo = COMBOS[i]; break; } }
      const cacheRead = Math.round(70000 + random() * 260000), fresh = Math.round(2000 + random() * 14000), cacheWrite = Math.round(random() * 12000);
      const output = Math.round(900 + random() * (combo.effort === "xhigh" ? 12000 : 6000));
      const input = cacheRead + fresh + cacheWrite;
      const costUsd = estimateCost(combo.model, { input, output, cacheRead, cacheWrite });
      rows.push({
        id: `demo-${rows.length}`, at: Math.round(at), kind: "claude-code", file, cwd, model: combo.model, requested: combo.model,
        ...(combo.effort === "not_supported" ? {} : { effort: combo.effort, effortSource: "assistant.demo" }),
        accountRef: DEMO_ACCOUNT.ref, input, output, cacheRead, cacheWrite, reasoning: Math.round(output * 0.3), costUsd, calls: 1,
      });
    }
  });

  // 4. 额度采样：每 10 分钟一个点，按费用累计；5 小时窗口从第一笔用量开始
  type Event = { at: number; cost: number };
  const events: Event[] = [...rows.map((r) => ({ at: r.at, cost: r.costUsd }))];
  for (const chat of chats) {
    const steps = Math.max(2, Math.round((chat.to - chat.from) / (8 * MINUTE)));
    for (let i = 0; i < steps; i++) events.push({ at: chat.from + ((chat.to - chat.from) * (i + 0.5)) / steps, cost: chat.cost / steps });
  }
  events.sort((a, b) => a.at - b.at);
  const samples: Array<Record<string, unknown>> = [];
  let week = 0, weekReset = start + WEEK, five = 0, fiveReset = 0, cursor = 0;
  for (let at = start + 5 * MINUTE; at <= now; at += 10 * MINUTE) {
    for (; cursor < events.length && events[cursor].at <= at; cursor++) {
      const e = events[cursor];
      while (e.at >= weekReset) { weekReset += WEEK; week = 0; }
      if (e.at >= fiveReset) { fiveReset = e.at + FIVE; five = 0; }
      week = Math.min(100, week + (e.cost / WEEK_CAP) * 100);
      five = Math.min(100, five + (e.cost / FIVE_CAP) * 100);
    }
    while (at >= weekReset) { weekReset += WEEK; week = 0; }
    const fiveLive = at < fiveReset;
    samples.push({
      account: DEMO_ACCOUNT.id, at, plan: "max",
      five: fiveLive ? Math.round(five) : 0, fiveReset: new Date(fiveLive ? fiveReset : at + FIVE).toISOString(),
      week: Math.round(week), weekReset: new Date(weekReset).toISOString(),
    });
  }

  // 5. 按天汇总（首页趋势图、使用节奏用）
  const files: Record<string, { kind: string; official: boolean; days: Record<string, Record<string, Record<string, Record<string, number>>>> }> = {};
  for (const r of rows) {
    const f = (files[r.file] ??= { kind: "claude-code", official: true, days: {} });
    const day = ((f.days[localDay(r.at)] ??= {})["Claude Code"] ??= {});
    const u = (day[r.model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, requests: 0 });
    u.input += r.input; u.output += r.output; u.cacheRead += r.cacheRead; u.cacheWrite += r.cacheWrite; u.reasoning += r.reasoning; u.costUsd += r.costUsd; u.requests += 1;
  }

  // 6. 已标注的一段：这一周最早的那次聊天（用户说是在网页上用 Opus 聊天）；最近那段留着待标注
  const thisWeek = chats.filter((c) => c.from > weekReset0 - WEEK);
  const marked = thisWeek.length >= 2 ? thisWeek[0] : chats.find((c) => c.to < weekReset0 - WEEK);
  const marks = marked ? [{ id: "demo-mark", kind: "claude", accountId: DEMO_ACCOUNT.id, from: marked.from - 5 * MINUTE, to: marked.to + 5 * MINUTE, model: "claude-opus-5-5", effort: "high", source: "chat", note: "网页上聊天（演示）", updatedAt: now }] : [];

  fs.mkdirSync(dataDir, { recursive: true });
  write(path.join(dataDir, "prefs.json"), { ccSwitch: false, autoLaunch: false, autoUpdate: false, localOnlyAccounts: [], seenVersion: "", onboarding: "done" });
  write(path.join(dataDir, "official-accounts.json"), { version: 2, accounts: [{ id: DEMO_ACCOUNT.id, kind: "claude", ref: DEMO_ACCOUNT.ref, email: "", label: DEMO_ACCOUNT.label, alias: DEMO_ACCOUNT.label, createdAt: start, lastSeenAt: now }], active: { claude: DEMO_ACCOUNT.id }, removed: [] });
  write(path.join(dataDir, "quota-history.json"), { version: 1, accounts: { claude: samples } });
  write(path.join(dataDir, "quota-checked.json"), { accounts: { [DEMO_ACCOUNT.id]: now }, claude: { at: now, account: DEMO_ACCOUNT.id } });
  write(path.join(dataDir, "quota-offmachine.json"), { version: 1, marks });
  const months = new Map<string, string[]>();
  for (const r of rows) { const m = localDay(r.at).slice(0, 7); if (!months.has(m)) months.set(m, []); months.get(m)!.push(JSON.stringify(r)); }
  for (const [m, lines] of months) write(path.join(dataDir, "requests", m + ".jsonl"), lines.join("\n") + "\n");
  // 最近三天的请求大部分开着透明转发：有首字延迟、总耗时和速度（用量明细的「延迟」一列）。数字按序号推出来，不动上面的随机序列
  const routeLogs = new Map<string, string[]>();
  for (const [m, lines] of months) {
    const month = lines.map((line) => JSON.parse(line) as typeof rows[number] & { responseId?: string; requestId?: string; returned?: string });
    month.forEach((r) => {
      const n = Number(r.id.slice(5));
      if (now - r.at > 3 * 86400000 || n % 4 === 0) return;
      r.responseId = "msg_01" + ("Demo" + n.toString(36)).padStart(22, "A"); r.requestId = "req_011" + ("Demo" + n.toString(36)).padStart(21, "A"); r.returned = r.model;
      const speed = /haiku/.test(r.model) ? 150 + (n * 37) % 60 : /opus/.test(r.model) ? 48 + (n * 13) % 30 : 70 + (n * 29) % 40;
      const firstByteMs = 700 + (n * 211) % 1800, firstTokenMs = firstByteMs + ((n * 97) % 23 === 0 ? 14000 : (n * 53) % 2400), ms = firstTokenMs + Math.round(r.output / speed * 1000);
      const log = routeLogs.get(m) ?? []; routeLogs.set(m, log);
      log.push(JSON.stringify({ at: r.at, app: "claude", providerId: "pass-claude", provider: "官方登录（透明转发）", model: r.model, requestModel: r.model, status: 200, ms, pass: true, method: "POST", path: "/v1/messages", stream: true,
        firstByteMs, firstTokenMs, tokensPerSec: speed, input: r.input, output: r.output, responseId: r.responseId, returnedModel: r.model, ...(r.effort ? { effort: r.effort } : {}) }));
    });
    write(path.join(dataDir, "requests", m + ".jsonl"), month.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  for (const [m, lines] of routeLogs) write(path.join(dataDir, "route-log", m + ".jsonl"), lines.join("\n") + "\n");
  write(path.join(dataDir, "usage-rollups.json"), { version: 1, files, requestsCompacted: 1 });
  return { rows: rows.length, samples: samples.length, chats: chats.length, marks: marks.length };
}
