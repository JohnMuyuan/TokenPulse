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
const { analyzeAccount, HOUR_MS, WEEK_MS } = require(path.join(ROOT, "build", "core", "quota-monitor.js"));

// 采样器直接写文件，得给它一个一次性的数据目录，别碰用户真实的 ~/.tokenpulse。
const data = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-quota-history-"));
process.env.TOKENPULSE_DATA_DIR = data;
const { recordQuotaSamples, readQuotaHistory, sameReset } = require(path.join(ROOT, "build", "core", "quota-history.js"));

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
    check("预测用平均速度，不用最近的爆发", near(w.ratePerH, 50 / 96), String(w.ratePerH));
    check("重置时按平均推算 87.5%，不算提前用完", near(w.projectedAtReset, 87.5) && !w.runsOutBeforeReset, `${w.projectedAtReset}`);
    check("最近的爆发只进上限：按它推是 122%", near(w.projectedHigh, 122) && near(w.fastPerH, 1), `${w.projectedHigh} ${w.fastPerH}`);
    check("上限会超 100 时提示有点紧，而不是断言会提前用完", report.health.reason === "tight", JSON.stringify(report.health));
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
    check("仍按墙钟平均预测", near(w.ratePerH, 50 / 96) && near(w.projectedAtReset, 87.5), `${w.ratePerH} / ${w.projectedAtReset}`);
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
    check("有休息也不改用最近爆发去外推", near(w.ratePerH, 50 / 96) && !w.runsOutBeforeReset, String(w.ratePerH));
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
    check("集中使用后仍按墙钟平均算（约 0.31%/h）", near(w.ratePerH, 9 / 28.8, 0.02), String(w.ratePerH));
    check("重置时约 52%，不是「提前两天用完」", w.projectedAtReset < 60 && !w.runsOutBeforeReset, String(w.projectedAtReset));
    check("这种情况判成健康", report.health.reason === "ok", JSON.stringify(report.health));
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
  }
} finally {
  fs.rmSync(data, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
assert.equal(passed, results.length, "quota monitor regression failed");
