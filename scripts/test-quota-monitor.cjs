/**
 * 额度监控的计算和采样。跑法（先 npm run compile）：
 *
 *   node scripts/test-quota-monitor.cjs
 *
 * 盯的都是「看起来算出来了、其实是错的」那种：
 *   - 预测用墙钟平均（已用 ÷ 窗口已过时间），关机和睡觉的时间留在分母里；
 *   - 最近几小时的爆发只进 projectedHigh，不拿它当结论（0.17.6 就是这么把 9% 外推成 135% 的）；
 *   - 睡一觉回来最近 24 小时是 0，预测仍走平均，不能说「永远用不完」；
 *   - 窗口里百分比掉下来（重置 / 用了重置次数）之前的点不能算进速度；
 *   - 采样之后已经到点重置：按新窗口从 0 算，别拿上周的 95% 报警；
 *   - 已用不到 2% 不折算整窗额度（整数百分比误差太大）；
 *   - 采样器：没变化的 15 分钟内只记一次（重置时间的亚秒抖动不算变化）、历史永久保留。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
// tsc 已经把 core/ 编成 CommonJS 了，直接 require 编译产物，不用再 bundle 一次。
const { analyzeAccount, capacityHistory, sumRows, HOUR_MS, WEEK_MS } = require(path.join(ROOT, "build", "core", "quota-monitor.js"));

// 采样器直接写文件，得给它一个一次性的数据目录，别碰用户真实的 ~/.tokenpulse。
const data = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-quota-history-"));
process.env.TOKENPULSE_DATA_DIR = data;
const { recordQuotaSamples, readQuotaHistory, readQuotaChecks, sameReset } = require(path.join(ROOT, "build", "core", "quota-history.js"));

const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const near = (a, b, eps = 1e-6) => typeof a === "number" && Math.abs(a - b) <= eps;

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const RESET = NOW + 72 * HOUR_MS; // 还剩 3 天，窗口已经过了 96 小时

/** 每小时一个采样：从 fromPct 线性涨到 toPct，最后一个点正好在 NOW。 */
function hourlySamples(hours, fromPct, toPct, extra = {}) {
  const list = [];
  for (let i = 0; i <= hours; i++) {
    list.push({
      at: NOW - (hours - i) * HOUR_MS,
      week: fromPct + ((toPct - fromPct) * i) / hours,
      weekReset: iso(RESET),
      ...extra,
    });
  }
  return list;
}

/** 窗口开始到现在，每小时 100 万 token、$1。 */
function steadyRows(model = "claude-opus-5") {
  const rows = [];
  const start = RESET - WEEK_MS;
  for (let hour = start; hour < NOW; hour += HOUR_MS) rows.push({ hour, model, tokens: 1_000_000, costUsd: 1, requests: 2 });
  return rows;
}

try {
  // ---- 1. 最近在猛用：会提前用完 ----
  {
    const report = analyzeAccount("claude", hourlySamples(10, 40, 50), steadyRows(), NOW);
    const w = report.week;
    check("最近 24 小时每小时涨 1 个点", near(w.recentPerH, 1), String(w.recentPerH));
    // 窗口已经走了 96 小时、总共用掉 50%：墙钟平均就是 0.52%/h，哪怕最近 10 小时在猛用
    check("平均速度按墙钟算（含没采样的时间）", near(w.averagePerH, 50 / 96), String(w.averagePerH));
    check("预测优先使用最近趋势", near(w.ratePerH, 1), String(w.ratePerH));
    check("重置时按最近趋势推算 122%，并标记重置前会用完", near(w.projectedAtReset, 122) && w.runsOutBeforeReset, `${w.projectedAtReset}`);
    check("较快趋势上界也是 122%", near(w.projectedHigh, 122) && near(w.fastPerH, 1), `${w.projectedHigh} ${w.fastPerH}`);
    check("重置前会用完时显示压力较高", report.health.reason === "runs-out", JSON.stringify(report.health));
    // 96 小时 × 100 万 = 9600 万 token，已用 50% → 整周 1.92 亿；花费同理 $96 → $192
    check(
      "折算整周额度 = 窗口用量 ÷ 已用百分比",
      near(w.capacity.tokens, 192_000_000) && near(w.capacity.costUsd, 192) && w.capacity.confidence === "high",
      JSON.stringify(w.capacity),
    );
    check("24 小时都有用量时 activeShare 是 1", near(w.activeShare, 1), String(w.activeShare));
  }

  // ---- 2. 只有平台值没有持续上涨：不能拿一次累计值硬猜未来 ----
  {
    const samples = [...hourlySamples(10, 50, 50)];
    const report = analyzeAccount("claude", samples, steadyRows(), NOW);
    const w = report.week;
    check("最近 24 小时没涨，最近速度是 0", near(w.recentPerH, 0), String(w.recentPerH));
    // 已经用掉的 50% 是真金白银，不能因为最近没动就当作没用过
    check("近期没增长时不继续沿用旧平均", near(w.ratePerH, 0) && near(w.projectedAtReset, 50), `${w.ratePerH} / ${w.projectedAtReset}`);
  }

  // ---- 3. 窗口里用了一次重置：掉下来之前的点不算 ----
  {
    const samples = [
      { at: NOW - 4 * HOUR_MS, week: 90, weekReset: iso(RESET) },
      { at: NOW - 3 * HOUR_MS, week: 95, weekReset: iso(RESET) },
      { at: NOW - 2 * HOUR_MS, week: 3, weekReset: iso(RESET) },
      { at: NOW - 1 * HOUR_MS, week: 4, weekReset: iso(RESET) },
      { at: NOW, week: 5, weekReset: iso(RESET) },
    ];
    const report = analyzeAccount("claude", samples, [], NOW);
    check("曲线从掉下来那个点开始", report.trend.length === 3 && report.trend[0].pct === 3, JSON.stringify(report.trend.map((p) => p.pct)));
    check("速度只按重置之后算（2 小时涨 2 点）", near(report.week.recentPerH, 1), String(report.week.recentPerH));
  }

  // ---- 4. 采样之后已经到点重置 ----
  {
    const samples = [{ at: NOW - 5 * HOUR_MS, week: 95, weekReset: iso(NOW - HOUR_MS) }];
    const report = analyzeAccount("claude", samples, [], NOW);
    check(
      "过了重置点：按新窗口从 0 算，不报警",
      report.week.used === 0 && report.trend.length === 0 && report.week.resetAt === NOW - HOUR_MS + WEEK_MS && report.health.level === "good",
      JSON.stringify({ used: report.week.used, reset: iso(report.week.resetAt), health: report.health }),
    );
  }

  // ---- 5. 已用太少不折算 ----
  {
    const samples = hourlySamples(3, 0, 1);
    const report = analyzeAccount("claude", samples, steadyRows(), NOW);
    check("已用 1% 时不给整周额度折算", report.week.capacity === undefined, JSON.stringify(report.week.capacity));
  }

  // ---- 6. 已经用完 ----
  {
    const report = analyzeAccount("claude", [{ at: NOW, week: 100, weekReset: iso(RESET) }], [], NOW);
    check("100% 判成已用完", report.health.reason === "exhausted" && report.health.level === "critical", JSON.stringify(report.health));
  }

  // ---- 7. 5 小时窗口 ----
  {
    const fiveReset = NOW + 2 * HOUR_MS;
    const samples = [0, 1, 2, 3, 4].map((i) => ({
      at: NOW - (4 - i) * 15 * 60_000,
      five: 20 + (10 * i) / 4,
      fiveReset: iso(fiveReset),
      week: 10,
      weekReset: iso(RESET),
    }));
    const report = analyzeAccount("chatgpt", samples, [], NOW);
    check("5 小时窗口按最近 1 小时算速度（1 小时涨 10 点）", near(report.five.recentPerH, 10), String(report.five.recentPerH));
    check("5 小时窗口起点 = 重置 - 5 小时", report.five.startAt === fiveReset - 5 * HOUR_MS, iso(report.five.startAt));
  }

  // ---- 8. 每小时的涨幅、型号占比 ----
  {
    const base = Math.floor(NOW / HOUR_MS) * HOUR_MS;
    const samples = [
      { at: base - 2 * HOUR_MS, week: 10, weekReset: iso(RESET) },
      { at: base - HOUR_MS, week: 13, weekReset: iso(RESET) },
      { at: base, week: 14, weekReset: iso(RESET) },
    ];
    const rows = [
      { hour: base - 2 * HOUR_MS, model: "claude-sonnet-5", tokens: 10, costUsd: 0.5, requests: 1 },
      { hour: base - HOUR_MS, model: "claude-opus-5", tokens: 30, costUsd: 3, requests: 1 },
      { hour: base - HOUR_MS, model: "claude-sonnet-5", tokens: 5, costUsd: 0.25, requests: 1 },
      // 窗口开始之前的，不能算进占比
      { hour: RESET - WEEK_MS - 2 * HOUR_MS, model: "old-model", tokens: 999, costUsd: 99, requests: 1 },
    ];
    const report = analyzeAccount("claude", samples, rows, NOW);
    const hourBefore = report.hourly.find((h) => h.hour === base - 2 * HOUR_MS);
    const lastHour = report.hourly.find((h) => h.hour === base - HOUR_MS);
    check("每小时的额度涨幅（10 → 13）", hourBefore && near(hourBefore.pctDelta, 3), JSON.stringify(hourBefore));
    check("每小时 token 汇总", lastHour && lastHour.tokens === 35 && near(lastHour.costUsd, 3.25), JSON.stringify(lastHour));
    check("小时表正好 24 格、最后一格是当前小时", report.hourly.length === 24 && report.hourly[23].hour === base);
    check(
      "型号按花费排、窗口外的不算",
      report.models.map((m) => m.model).join(",") === "claude-opus-5,claude-sonnet-5" && report.models[1].firstHour === base - 2 * HOUR_MS,
      JSON.stringify(report.models),
    );
  }

  // ---- 9. 一天只用 8 小时：能看出休息，速度来自额度采样而非 token 活跃时长 ----
  {
    const start = RESET - WEEK_MS;
    const rows = [];
    for (let hour = start; hour < NOW; hour += HOUR_MS) {
      if (Math.floor(hour / HOUR_MS) % 24 < 8) {
        rows.push({ hour, model: "claude-opus-5", tokens: 1_000_000, costUsd: 1, requests: 2 });
      }
    }
    const report = analyzeAccount("claude", hourlySamples(10, 40, 50), rows, NOW);
    const w = report.week;
    check("大约三分之一的时间在用", near(w.activeShare, 32 / 96), String(w.activeShare));
    check("有休息时限制近期趋势的放大倍数", near(w.ratePerH, 1) && w.runsOutBeforeReset, String(w.ratePerH));
  }

  // ---- 10. 真实场景回归（2026-09-16 的 Claude 账号）----
  {
    // 窗口 09-15 起，28.8 小时里用掉 9%，还剩 139 小时才重置。
    const reset = NOW + 139 * HOUR_MS;
    const start = reset - WEEK_MS;
    const samples = [];
    for (let at = start + 0.5 * HOUR_MS; at <= NOW; at += HOUR_MS) {
      const hours = (at - start) / HOUR_MS;
      // 前 16 小时几乎没用，后面集中用掉 9%
      samples.push({ at, week: hours < 16 ? 0 : Math.round(((hours - 16) / 12.8) * 9), weekReset: iso(reset) });
    }
    const report = analyzeAccount("claude", samples, [], NOW);
    const w = report.week;
    check("集中使用后限制近期趋势的放大倍数", near(w.ratePerH, 0.62, 0.02), String(w.ratePerH));
    check("重置时约 95%，不把它直接说成必然耗尽", w.projectedAtReset > 90 && w.projectedAtReset < 100 && !w.runsOutBeforeReset, String(w.projectedAtReset));
    check("这种情况显示用量偏高", report.health.reason === "tight", JSON.stringify(report.health));
  }

  // ---- 10b. 切换账号：只看当前账号的采样 ----
  {
    const samples = [
      { at: NOW - 3 * HOUR_MS, week: 60, weekReset: iso(RESET) },
      { at: NOW - 2 * HOUR_MS, week: 62, weekReset: iso(RESET), account: "claude:a" },
      { at: NOW - HOUR_MS, week: 5, weekReset: iso(RESET), account: "claude:b" },
      { at: NOW, week: 63, weekReset: iso(RESET), account: "claude:a" },
    ];
    const report = analyzeAccount("claude", samples, [], NOW);
    check(
      "切回账号 A 时不把 B 的 5% 连进曲线（否则像一小时涨了 58 点）",
      report.trend.map((p) => p.pct).join(",") === "60,62,63" && report.sampleCount === 3,
      JSON.stringify(report.trend.map((p) => p.pct)),
    );
  }

  // ---- 10b2. 切换账号：容量和预测也只看当前账号的本机用量 ----
  {
    const samples = [
      { at: NOW - 2 * HOUR_MS, week: 10, weekReset: iso(RESET), account: "claude:a" },
      { at: NOW, week: 20, weekReset: iso(RESET), account: "claude:a" },
    ];
    const rows = [
      { hour: NOW - HOUR_MS, model: "claude-opus-5", tokens: 100, costUsd: 1, requests: 1, account: "claude:a" },
      { hour: NOW - HOUR_MS, model: "claude-opus-5", tokens: 10_000, costUsd: 100, requests: 1, account: "claude:b" },
    ];
    const report = analyzeAccount("claude", samples, rows, NOW);
    check(
      "账号 A 的额度容量只按账号 A 的本机用量折算",
      report.week.usedTokens === 100 && near(report.week.capacity.tokens, 500),
      JSON.stringify({ usedTokens: report.week.usedTokens, capacity: report.week.capacity }),
    );
  }

  // ---- 10c. 用最近趋势预测，不让整窗平均掩盖当前节奏 ----
  {
    const samples = hourlySamples(10, 40, 50);
    const report = analyzeAccount("claude", samples, [], NOW);
    const w = report.week;
    check("最近趋势作为主预测速度", near(w.ratePerH, 1, 0.05), String(w.ratePerH));
    check("按最近趋势预计 50 小时后达到上限", w.etaAt != null && near((w.etaAt - NOW) / HOUR_MS, 50, 1), String(w.etaAt && (w.etaAt - NOW) / HOUR_MS));
    check("最近趋势显示重置前会达到上限", w.runsOutBeforeReset && near(w.projectedAtReset, 122, 3), String(w.projectedAtReset));
  }

  // ---- 10d. 最近没有新增用量时，不继续输出虚假的耗尽时间 ----
  {
    const samples = hourlySamples(10, 50, 50);
    const report = analyzeAccount("claude", samples, [], NOW);
    const w = report.week;
    check("最近没有增长时速度为 0", near(w.ratePerH, 0), String(w.ratePerH));
    check("最近没有增长时不输出耗尽时间", w.etaAt == null && !w.runsOutBeforeReset, JSON.stringify({ etaAt: w.etaAt, runsOutBeforeReset: w.runsOutBeforeReset }));
  }

  // ---- 10c. 按小时用量按重叠时长折算 ----
  {
    const h0 = Date.UTC(2026, 8, 13, 4, 0, 0);
    const rows = [
      { hour: h0, model: "m", tokens: 600, costUsd: 6, requests: 1 },
      { hour: h0 + HOUR_MS, model: "m", tokens: 100, costUsd: 1, requests: 1 },
    ];
    // 窗口从 04:45 开始：04:00 这一小时只算后 15 分钟 = 600 × 1/4
    const part = sumRows(rows, h0 + 45 * 60_000, h0 + 2 * HOUR_MS);
    check("窗口边界不在整点时按重叠时长折算（以前整小时都算进去）", near(part.tokens, 250) && near(part.costUsd, 2.5), JSON.stringify(part));
    // 当前这一小时只到 now 为止：05:30 时 05:00 这一小时的用量全都已经发生了
    const live = sumRows(rows, h0, h0 + HOUR_MS + 30 * 60_000, h0 + HOUR_MS + 30 * 60_000);
    check("当前这一小时的用量全部计入（它只到现在为止）", near(live.tokens, 700), JSON.stringify(live));
  }

  // ---- 10d. 历史窗口的容量折线 ----
  {
    const r1 = NOW - 20 * HOUR_MS, r2 = NOW - 15 * HOUR_MS, r3 = NOW - 10 * HOUR_MS, r4 = NOW - 5 * HOUR_MS, r5 = NOW + 2 * HOUR_MS;
    const at = (reset, before) => reset - before;
    const samples = [
      // 窗口 1：用到 40%，重置时间带亚秒抖动也算同一个窗口
      { at: at(r1, 3 * HOUR_MS), five: 10, fiveReset: iso(r1 + 400) },
      { at: at(r1, 1 * HOUR_MS), five: 40, fiveReset: iso(r1 - 300) },
      // 窗口 2：只用到 1%，没法估
      { at: at(r2, 1 * HOUR_MS), five: 1, fiveReset: iso(r2) },
      // 窗口 3：用到 4%，但本机没有用量（用在了别的设备上）
      { at: at(r3, 1 * HOUR_MS), five: 4, fiveReset: iso(r3) },
      // 窗口 4：中途手动重置过（百分比掉下来），前后用量说不清
      { at: at(r4, 3 * HOUR_MS), five: 30, fiveReset: iso(r4) },
      { at: at(r4, 1 * HOUR_MS), five: 5, fiveReset: iso(r4) },
      // 没用过的窗口（0%，ChatGPT 每次把重置时间往后挪）：直接忽略，不计进跳过数
      { at: at(r4, 30 * 60_000) + 10 * 60_000, five: 0, fiveReset: iso(r4 + 4 * HOUR_MS) },
      // 窗口 5：进行中，用到 3%（可信度低）
      { at: NOW, five: 3, fiveReset: iso(r5) },
    ];
    // 每小时 100 万 token、$1，只有窗口 3 那 5 个小时没有本机用量
    const rows = [];
    for (let hour = r1 - 5 * HOUR_MS; hour < NOW; hour += HOUR_MS) if (hour < r3 - 5 * HOUR_MS || hour >= r3) rows.push({ hour, model: "m", tokens: 1_000_000, costUsd: 1, requests: 1 });
    const history = capacityHistory(samples, rows, "five", NOW);
    const [w1, w5] = history.points;
    check("历史容量：每个可估的窗口一个点，按重置时间归组（容忍抖动）", history.points.length === 2, JSON.stringify(history.points.map((p) => p.pct)));
    // 窗口 1 从 r1-5h 到最后一次采样 r1-1h：400 万 token，已用 40% → 整窗 1000 万
    check("容量 = 窗口开始到最后一次采样的本机用量 ÷ 那次的已用百分比", near(w1.capacityTokens, 10_000_000, 10_000) && near(w1.capacityCostUsd, 10, 0.01) && w1.confidence === "high", JSON.stringify(w1));
    check("已用不到 2% / 本机没有用量的窗口不计入，只计数；0% 的窗口直接忽略", history.skipped.tooLow === 1 && history.skipped.noLocal === 1, JSON.stringify(history.skipped));
    check("中途手动重置过的窗口不计入（前后用量说不清）", !history.points.some((p) => p.resetAt === r4));
    check("进行中的窗口标出来，已用 2–5% 标为可信度低", w5.current && w5.confidence === "low" && !w1.current, JSON.stringify({ current: w5.current, confidence: w5.confidence }));
    const report = analyzeAccount("chatgpt", samples, rows, NOW);
    check("账号报告里带上周 / 5 小时两条历史", report.capacityHistory.five.points.length === 2 && Array.isArray(report.capacityHistory.week.points));
  }

  // ---- 11. 采样器 ----
  {
    const t0 = Date.UTC(2026, 8, 13, 0, 0, 0);
    const map = (week) => ({ claude: { name: "Claude 账号", weekPct: week, fiveHourPct: 5, weekReset: iso(t0 + WEEK_MS) } });
    recordQuotaSamples(map(10), t0);
    recordQuotaSamples(map(10), t0 + 5 * 60_000);
    check("没变化的 15 分钟内只记一次", readQuotaHistory().accounts.claude.length === 1);
    // Claude 每次返回的 resets_at 有几百毫秒抖动（实测 08:19:59.398 / 08:20:00.474），不算变化
    const jittered = map(10);
    jittered.claude.weekReset = iso(t0 + WEEK_MS - 602);
    recordQuotaSamples(jittered, t0 + 10 * 60_000);
    check("重置时间只有亚秒抖动，仍算没变化", readQuotaHistory().accounts.claude.length === 1);
    check("重置时间差一小时算变化", !sameReset(iso(t0), iso(t0 + HOUR_MS)) && sameReset(iso(t0), iso(t0 + 900)));
    // 数值没变被去重时，「最后一次查询成功」照样要更新：以前拿最后一条采样判断过期，额度一不动就误报
    check("采样被去重时，查询成功时间照样更新", readQuotaChecks().claude?.at === t0 + 10 * 60_000, JSON.stringify(readQuotaChecks().claude));
    const idle = analyzeAccount("claude", readQuotaHistory().accounts.claude, [], t0 + 12 * 60_000, readQuotaChecks().claude);
    check("账号报告的 lastCheckedAt 取两者中较新的", idle.lastSampleAt === t0 && idle.lastCheckedAt === t0 + 10 * 60_000, JSON.stringify({ sample: idle.lastSampleAt, checked: idle.lastCheckedAt }));
    const other = analyzeAccount("claude", [{ at: t0, week: 10, account: "claude:a" }], [], t0 + 12 * 60_000, { at: t0 + 10 * 60_000, account: "claude:b" });
    check("切换账号后不采用上一个账号的查询时间", other.lastCheckedAt === t0);
    recordQuotaSamples(map(10), t0 + 16 * 60_000);
    check("没变化但过了 15 分钟，再记一笔「还是这么多」", readQuotaHistory().accounts.claude.length === 2);
    recordQuotaSamples(map(11), t0 + 17 * 60_000);
    check("有变化立刻记", readQuotaHistory().accounts.claude.length === 3);
    recordQuotaSamples({}, t0 + 20 * 60_000);
    check("接口什么都没返回时不写", readQuotaHistory().accounts.claude.length === 3);

    const file = path.join(data, "quota-history.json");
    const history = readQuotaHistory();
    history.accounts.claude.unshift({ at: t0 - 50 * 24 * HOUR_MS, week: 1 });
    fs.writeFileSync(file, JSON.stringify(history));
    recordQuotaSamples(map(12), t0 + 30 * 60_000);
    const after = readQuotaHistory().accounts.claude;
    check("50 天前的采样照样保留（额度历史永久保存）", after.length === 5 && after[0].at === t0 - 50 * 24 * HOUR_MS, after.map((s) => iso(s.at)).join(" / "));

    // 0.3.3：一家好几个账号同时查。采样交错排在一起，去重要跟同一个账号的上一条比
    const t1 = t0 + 60 * 60_000;
    const two = (a, b) => ({ all: [
      { kind: "grok", name: "Grok 账号", weekPct: a, weekReset: iso(t1 + WEEK_MS), accountId: "grok:a" },
      { kind: "grok", name: "Grok 账号", weekPct: b, weekReset: iso(t1 + WEEK_MS), accountId: "grok:b" },
    ] });
    recordQuotaSamples(two(10, 50), t1);
    recordQuotaSamples(two(10, 50), t1 + 5 * 60_000);
    const grok = readQuotaHistory().accounts.grok;
    check("两个账号各记一条，互不打断去重", grok.length === 2 && grok[0].account === "grok:a" && grok[1].account === "grok:b", JSON.stringify(grok.map((s) => s.account)));
    recordQuotaSamples(two(10, 51), t1 + 6 * 60_000);
    check("只有变了的那个账号多记一条", readQuotaHistory().accounts.grok.length === 3 && readQuotaHistory().accounts.grok.at(-1).account === "grok:b");
    const checks = readQuotaChecks();
    check("每个账号各自记最后一次查询成功的时间", checks.accounts["grok:a"] === t1 + 6 * 60_000 && checks.accounts["grok:b"] === t1 + 6 * 60_000);
    const onlyA = analyzeAccount("grok", readQuotaHistory().accounts.grok.filter((s) => s.account === "grok:a"), [], t1 + 7 * 60_000, { at: checks.accounts["grok:a"], account: "grok:a" });
    check("按账号分开的采样各自出报告", onlyA.accountId === "grok:a" && onlyA.week && Math.round(onlyA.week.used) === 10);
  }
} finally {
  fs.rmSync(data, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
assert.equal(passed, results.length, "quota monitor regression failed");
