/*
 * Antigravity 整窗容量折算（main/antigravity-quota.ts 的 buildWindowInsight / weightedMedian）。
 * 1% 额度对应多少 Token 随用的型号变化很大：早几天主要用便宜的 Flash（同样 1% 多十几倍 Token），
 * 最近只用 Argon。容量只看最近几个窗口、取按百分比加权的中位数，不能被早先的窗口或个别窗口带偏。
 * 一次性数据目录，不碰真实的 ~/.tokenpulse。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-agy-capacity-'));
Object.assign(process.env, { TOKENPULSE_DATA_DIR: path.join(root, 'data'), TOKENPULSE_ANTIGRAVITY_DIR: path.join(root, 'antigravity') });
fs.mkdirSync(path.join(root, 'data'), { recursive: true });

const H = 3_600_000;
const now = Date.UTC(2026, 10, 10, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const KEY = 'Gemini 3.8 Flash|Gemini 4 Argon';
// 10 个首尾相接的 5 小时窗口，最后一个还在进行中。每个窗口用到 10%；
// 前 4 个（早几天）每 1% 约 3000 万 Token（Flash 为主），后 6 个每 1% 200 万（Argon），其中第 8 个混进一个 Flash 窗口
const tokensPerPct = [30e6, 30e6, 30e6, 30e6, 2e6, 2e6, 2e6, 30e6, 2e6, 2e6];
const firstStart = now - 9 * 5 * H - 2 * H;
const windows = tokensPerPct.map((perPct, i) => ({ start: firstStart + i * 5 * H, reset: firstStart + (i + 1) * 5 * H, perPct }));
const history = [], rows = [];
for (const w of windows) {
  for (const [offset, used] of [[10 * 60_000, 0], [2 * H, 5], [4 * H, 10]]) {
    if (w.start + offset > now) continue;
    history.push({ at: w.start + offset, groups: [{ key: KEY, used, resetAt: iso(w.reset), weekUsed: 5, weekResetAt: iso(now + 4 * 24 * H) }] });
  }
  // 窗口里的本机请求：10% 对应的 Token 分两次
  for (const at of [w.start + H, w.start + 3 * H]) if (at <= now) rows.push({ at, model: 'gemini-4-argon', effort: 'high', tokens: w.perPct * 5, costUsd: w.perPct * 5 / 1e6, calls: 1, input: w.perPct * 5, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 1, source: 'Antigravity', kind: 'antigravity' });
}
const current = windows.at(-1);
const used = 5; // 当前窗口采样到的 2 小时那一刻
fs.writeFileSync(path.join(root, 'data', 'antigravity-quota.json'), JSON.stringify({
  last: { at: now - 60_000, ok: true, plan: 'Pro', groups: [{ key: KEY, title: 'Gemini Models', models: ['Gemini 4 Argon', 'Gemini 3.8 Flash'], used, resetAt: iso(current.reset), week: { used: 5, resetAt: iso(now + 4 * 24 * H) } }] },
  history, notified: {},
}));

const mod = require('../build/main/antigravity-quota');
let checks = 0;
const pass = (name) => { checks++; console.log('PASS ' + name); };
try {
  assert.equal(mod.weightedMedian([[1, 1], [2, 1], [100, 1]]), 2, '中位数不受极端值影响');
  assert.equal(mod.weightedMedian([[1, 1], [3, 1]]), 2, '正好一半时取两边平均');
  assert.equal(mod.weightedMedian([[10, 1], [20, 5]]), 20, '按权重');
  assert.equal(mod.weightedMedian([]), 0);
  pass('weightedMedian picks the value where cumulative weight passes half');

  const q = new mod.AntigravityQuota({ now: () => now, fetcher: async () => null });
  q.recentRows = () => rows;
  const five = q.buildInsight(now).groups[0].five;
  const history5 = q.buildInsight(now).groups[0].capacityHistory.five;
  assert.ok(history5.length >= 9, `每个窗口都折算出一个点（${history5.length}）`);
  // 现在的用法：每 1% 200 万 → 整窗约 2 亿。旧算法（30 天全部窗口、总 Token ÷ 总百分比）会得到十几亿
  const full = five.capacity.fullTokens;
  assert.ok(full >= 150e6 && full <= 250e6, `整窗容量跟着最近的用法（约 2 亿），实际 ${full}`);
  const pooled = history5.reduce((s, p) => s + p.tokens, 0) / history5.reduce((s, p) => s + p.usedPct, 0) * 100;
  assert.ok(pooled > 5 * full, `对照：全部窗口合起来平均会被早先的用法带偏好几倍（${Math.round(pooled)}）`);
  assert.equal(five.capacity.intervals, 6, '只用最近 6 个 5 小时窗口');
  assert.equal(five.capacity.remainingTokens, Math.round(full * (100 - used) / 100), '剩余可用按同一个容量算');
  pass('5-hour capacity follows the recent windows and ignores older or one-off different-usage windows');

  // 组内型号随 Google 上下线变化（如新增 Carbon / Hydrogen / Orchestrator 或移除 GPT-OSS 120B）时，同池历史采样与容量趋势不断裂；无标签内部模型不伪造 medium 等级
  const evolvedKeys = [
    'Gemini 3.8 Flash|Gemini 4 Argon',
    'Gemini 3.8 Flash|Gemini 4 Argon|Gemini 4 Carbon',
    'Gemini 3.8 Flash|Gemini 4 Argon|Gemini 4 Carbon|Gemini 4 Hydrogen',
    'Gemini 3.8 Flash|Gemini 4 Argon|Gemini 4 Carbon|Gemini 4 Hydrogen|Orchestrator',
  ];
  const evolvedHistory = history.map((s, idx) => ({
    at: s.at,
    groups: [
      { ...s.groups[0], key: evolvedKeys[Math.min(evolvedKeys.length - 1, Math.floor(idx / 7))] },
      { key: idx < 14 ? 'Claude Opus 5.5|Claude Sonnet 5.5|GPT-OSS 120B' : 'Claude Opus 5.5|Claude Sonnet 5.5', used: 8, resetAt: iso(current.reset), weekUsed: 12, weekResetAt: iso(now + 4 * 24 * H) },
    ],
  }));
  const latestGeminiKey = evolvedKeys[evolvedKeys.length - 1];
  const latest3pKey = 'Claude Opus 5.5|Claude Sonnet 5.5';
  let notifyCount = 0;
  fs.writeFileSync(path.join(root, 'data', 'antigravity-quota.json'), JSON.stringify({
    last: {
      at: now - 60_000, ok: true, plan: 'Pro',
      groups: [
        { key: latestGeminiKey, title: 'Gemini Models', models: latestGeminiKey.split('|'), used, resetAt: iso(current.reset), week: { used: 5, resetAt: iso(now + 4 * 24 * H) } },
        { key: latest3pKey, title: 'Claude models', models: latest3pKey.split('|'), used: 85, resetAt: iso(current.reset), week: { used: 12, resetAt: iso(now + 4 * 24 * H) } },
      ],
    },
    history: evolvedHistory,
    notified: { 'Claude Opus 5.5|Claude Sonnet 5.5|GPT-OSS 120B': Date.parse(iso(current.reset)) },
  }));
  const qEvolved = new mod.AntigravityQuota({
    now: () => now,
    notifyAt: () => 80,
    notify: () => { notifyCount += 1; },
    fetcher: async () => null,
  });
  qEvolved.recentRows = () => [
    ...rows,
    { at: now - 30 * 60_000, model: 'gemini-3.8-flash-tiered', tokens: 50000, costUsd: 0.025, calls: 3, input: 48000, output: 2000, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 3, source: 'Antigravity', kind: 'antigravity' },
    { at: now - 40 * 60_000, model: 'claude-opus-5-5', effort: 'high', tokens: 800000, costUsd: 4.0, calls: 2, input: 750000, output: 50000, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 2, source: 'Antigravity', kind: 'antigravity' },
  ];
  const insEvolved = qEvolved.buildInsight(now);
  assert.equal(insEvolved.groups[0].capacityHistory.five.length, history5.length, 'Gemini 组增补型号后保留完整历史容量点');
  assert.ok(insEvolved.groups[1].capacityHistory.five.length >= 1, 'Claude 组移除 GPT-OSS 后仍串联同池采样');
  const tieredRow = insEvolved.modelCapacities.find((m) => m.model === 'gemini-3.8-flash-tiered');
  assert.ok(tieredRow && tieredRow.effort === '' && tieredRow.recentCalls === 3, '无标签内部模型不伪造 medium 思考等级');
  qEvolved.check(qEvolved.state().last.groups);
  assert.equal(notifyCount, 1, '首次切到 pool 标识写入提醒记录，之后同窗口换 key 不重复弹通知');
  qEvolved.check([{ key: 'Claude Opus 5.5', title: 'Claude models', models: ['Claude Opus 5.5'], used: 90, resetAt: iso(current.reset) }]);
  assert.equal(notifyCount, 1, '同一重置窗口内型号再变也不会重复通知');
  pass('pool identity bridges model additions/removals and unlabeled internal models keep empty effort');

  // 4. 家庭组共享额度防偏移（情形 A）：本机无请求时段由家庭成员产生的 +35% 额度激增自动归入 offPoints，整窗容量保持 ~2 亿不坍缩
  const famNow = current.start + 3 * H + 10 * 60_000;
  const famHistory = [
    ...history.filter((s) => s.at < current.start),
    { at: current.start + 10 * 60_000, groups: [{ key: KEY, used: 0, resetAt: iso(current.reset), weekUsed: 5, weekResetAt: iso(now + 4 * 24 * H) }] },
    { at: current.start + H, groups: [{ key: KEY, used: 5, resetAt: iso(current.reset), weekUsed: 7, weekResetAt: iso(now + 4 * 24 * H) }] },
    // [H, 2H] 本机完全空闲，家庭组成员用掉 +35%（5% → 40%）
    { at: current.start + 2 * H, groups: [{ key: KEY, used: 40, resetAt: iso(current.reset), weekUsed: 15, weekResetAt: iso(now + 4 * 24 * H) }] },
    // [2H, 3H] 家庭成员停手，本机也空闲（40% → 40%）
    { at: current.start + 3 * H, groups: [{ key: KEY, used: 40, resetAt: iso(current.reset), weekUsed: 15, weekResetAt: iso(now + 4 * 24 * H) }] },
  ];
  const famRows = [
    ...rows.filter((r) => r.at < current.start),
    // 当前窗口本机只在前半小时用了 5% 对应的 1000 万 Token（独享基准每 1% = 200 万，整窗 = 2 亿）
    { at: current.start + 30 * 60_000, model: 'gemini-4-argon', effort: 'high', tokens: 10e6, costUsd: 10, calls: 1, input: 10e6, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 1, source: 'Antigravity', kind: 'antigravity' },
  ];
  fs.writeFileSync(path.join(root, 'data', 'antigravity-quota.json'), JSON.stringify({
    last: {
      at: famNow - 60_000, ok: true, plan: 'Pro',
      groups: [{ key: KEY, title: 'Gemini Models', models: ['Gemini 4 Argon', 'Gemini 3.8 Flash'], used: 40, resetAt: iso(current.reset), week: { used: 15, resetAt: iso(now + 4 * 24 * H) } }],
    },
    history: famHistory,
    notified: {},
  }));
  const qFamIdle = new mod.AntigravityQuota({ now: () => famNow, fetcher: async () => null });
  qFamIdle.recentRows = () => famRows;
  const insFamIdle = qFamIdle.buildInsight(famNow);
  const gFamIdle = insFamIdle.groups[0].five;
  // 若不剔除家庭组涨幅，10M / 40% * 100 只有 25M（缩水 8 倍）；剔除后整窗容量稳在 ~200M
  assert.equal(gFamIdle.shared.offPoints, 35, '本机空闲时段的 +35% 被准确识别为外部消耗');
  assert.equal(gFamIdle.shared.localUsedPct, 5);
  assert.equal(gFamIdle.shared.externalUsedPct, 35);
  assert.ok(gFamIdle.capacity.fullTokens >= 180e6 && gFamIdle.capacity.fullTokens <= 220e6, `整窗容量零偏移（实际 ${gFamIdle.capacity.fullTokens}）`);
  const curCapPt = insFamIdle.groups[0].capacityHistory.five.at(-1);
  assert.ok(curCapPt.fullTokens >= 180e6 && curCapPt.fullTokens <= 220e6, `当前窗口点本身也按净本机 +5% 折算（实际 ${curCapPt.fullTokens}）`);
  assert.equal(curCapPt.excludedPct, 35);
  assert.equal(gFamIdle.etaAt, null, '家庭成员突发停止后不再按峰值速度误报耗尽');
  const tlFam = qFamIdle.timeline();
  assert.equal(tlFam['g0-five'].offMachine.points, 35, '时间线输出家庭组/他端区间供橙色条渲染');
  pass('family group idle spike (+35%) is stripped as offPoints with zero capacity or ETA drift');

  // 5. 家庭组共享额度防偏移（情形 B）：同一采样区间内本机与家庭成员同时使用，coUsedPoints 并发滤波防止单窗口容量坍缩；solo 模式可手动关闭扣除
  const coHistory = [
    ...history.filter((s) => s.at < current.start),
    { at: current.start + 10 * 60_000, groups: [{ key: KEY, used: 0, resetAt: iso(current.reset), weekUsed: 5, weekResetAt: iso(now + 4 * 24 * H) }] },
    // 同一区间本机只用了 1000 万 Token（$10，按历史独享基准约值 5%），但家庭成员同时猛刷了 +35%，合计跳到 40%
    { at: current.start + 2 * H, groups: [{ key: KEY, used: 40, resetAt: iso(current.reset), weekUsed: 15, weekResetAt: iso(now + 4 * 24 * H) }] },
  ];
  const coRows = [
    ...rows.filter((r) => r.at < current.start),
    { at: current.start + H, model: 'gemini-4-argon', effort: 'high', tokens: 10e6, costUsd: 10, calls: 1, input: 10e6, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 1, source: 'Antigravity', kind: 'antigravity' },
  ];
  fs.writeFileSync(path.join(root, 'data', 'antigravity-quota.json'), JSON.stringify({
    last: {
      at: current.start + 2 * H, ok: true, plan: 'Pro',
      groups: [{ key: KEY, title: 'Gemini Models', models: ['Gemini 4 Argon', 'Gemini 3.8 Flash'], used: 40, resetAt: iso(current.reset), week: { used: 15, resetAt: iso(now + 4 * 24 * H) } }],
    },
    history: coHistory,
    notified: {},
  }));
  const qCo = new mod.AntigravityQuota({ now: () => current.start + 2 * H + 60_000, fetcher: async () => null });
  qCo.recentRows = () => coRows;
  const insCo = qCo.buildInsight(current.start + 2 * H + 60_000);
  const gCo = insCo.groups[0].five;
  assert.ok(gCo.shared.coUsedPoints >= 30, `同期多人共用的外部涨幅被识别剥离（coUsedPoints=${gCo.shared.coUsedPoints}）`);
  const coCurPt = insCo.groups[0].capacityHistory.five.at(-1);
  assert.ok(coCurPt.fullTokens >= 150e6 && coCurPt.fullTokens <= 250e6, `并发区间容量点未坍缩到 25M（实际 ${coCurPt.fullTokens}）`);
  pass('simultaneous family co-usage spike is caught by coUsedPoints outlier guard without collapsing capacity');

  // 6. 多账号家庭组共享池自动指纹识别（detectFamilyLinks）：同秒级重置 + 同步消耗的两个家庭号自动关联，独立工作号互不干扰
  const accMod = require('../build/core/antigravity-accounts');
  const idFamA = accMod.rememberAgyAccount({ email: 'member-a@family.test', credential: { token: 't-a', refreshToken: 'r-a', expiresAt: famNow + 3600_000 } }, true, famNow);
  const idFamB = accMod.rememberAgyAccount({ email: 'member-b@family.test', credential: { token: 't-b', refreshToken: 'r-b', expiresAt: famNow + 3600_000 } }, true, famNow);
  const idWork = accMod.rememberAgyAccount({ email: 'engineer@work.test', credential: { token: 't-w', refreshToken: 'r-w', expiresAt: famNow + 3600_000 } }, true, famNow);

  const sharedGroup = [{ key: KEY, title: 'Gemini Models', models: ['Gemini 4 Argon', 'Gemini 3.8 Flash'], used: 42, resetAt: iso(current.reset), week: { used: 18, resetAt: iso(now + 4 * 24 * H) } }];
  const workGroup = [{ key: KEY, title: 'Gemini Models', models: ['Gemini 4 Argon', 'Gemini 3.8 Flash'], used: 12, resetAt: iso(current.reset + 90 * 60_000), week: { used: 4, resetAt: iso(now + 5 * 24 * H) } }];
  fs.writeFileSync(path.join(root, 'data', 'antigravity-quota.json'), JSON.stringify({
    accounts: {
      [idFamA]: { last: { at: famNow, ok: true, plan: 'Pro', groups: sharedGroup }, history: [], notified: {} },
      [idFamB]: { last: { at: famNow, ok: true, plan: 'Pro', groups: sharedGroup }, history: [], notified: {} },
      [idWork]: { last: { at: famNow, ok: true, plan: 'Ultra', groups: workGroup }, history: [], notified: {} },
    },
  }));
  const qMulti = new mod.AntigravityQuota({ now: () => famNow, fetcher: async () => null });
  qMulti.recentRows = () => [];
  const multiState = qMulti.state();
  assert.equal(multiState.multiAccount, true);
  assert.equal(multiState.accounts.length, 3);
  const stA = multiState.accounts.find((a) => a.id === idFamA);
  const stB = multiState.accounts.find((a) => a.id === idFamB);
  const stW = multiState.accounts.find((a) => a.id === idWork);
  assert.equal(stA.familyShared, true, '家庭号 A 自动识别为共享池');
  assert.equal(stB.familyShared, true, '家庭号 B 自动识别为共享池');
  assert.equal(stA.familyGroupId, stB.familyGroupId, '两个家庭号归入同一个 familyGroupId');
  assert.deepEqual(stA.familyPeers, ['member-b']);
  assert.deepEqual(stB.familyPeers, ['member-a']);
  assert.equal(stW.familyShared, false, '独立工作号不会被误判进家庭组');
  assert.equal(stW.familyGroupId, undefined);
  pass('multi-account detectFamilyLinks links shared family accounts while keeping independent accounts separate');

  // 7. 误归属历史自动追回与非破坏性混组清洗（即使先添加了别的账号、原本地账号后补登记，也不丢失老采样和套餐等级）
  const repairRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-agy-repair-'));
  const prevDataDir = process.env.TOKENPULSE_DATA_DIR;
  process.env.TOKENPULSE_DATA_DIR = repairRoot;
  try {
    const idAlt = accMod.rememberAgyAccount(
      { email: 'alt@example.com', credential: { token: 't-alt', refreshToken: 'r-alt', expiresAt: famNow + 3600_000 } },
      true,
      now - 10 * 60_000,
    );
    const idOrig = accMod.rememberAgyAccount(
      { email: 'orig-local@example.com', credential: { token: 't-orig', refreshToken: 'r-orig', expiresAt: famNow + 3600_000 } },
      true,
      now - 9 * 60_000,
    );
    fs.writeFileSync(path.join(repairRoot, 'antigravity-logins.json'), JSON.stringify({
      version: 1,
      spans: [{ from: now - 3 * 24 * H, id: idOrig }],
    }));
    const oldSamples = [
      { at: now - 48 * H, groups: [{ key: KEY, used: 12, resetAt: iso(now - 45 * H), weekUsed: 5, weekResetAt: iso(now + 4 * 24 * H) }] },
      { at: now - 24 * H, groups: [{ key: KEY, used: 24, resetAt: iso(now - 21 * H), weekUsed: 10, weekResetAt: iso(now + 4 * 24 * H) }] },
    ];
    const mixedGroup = {
      title: 'Claude and GPT models',
      models: ['Claude Opus 5.5', 'Claude Sonnet 5.5', 'GPT-OSS 120B', 'Gemini 3 Flash'],
      used: 0,
      resetAt: iso(now + 4 * H),
      week: { used: 1, resetAt: iso(now + 5 * 24 * H) },
      key: 'Claude Opus 5.5|Claude Sonnet 5.5|GPT-OSS 120B|Gemini 3 Flash',
    };
    fs.writeFileSync(path.join(repairRoot, 'antigravity-quota.json'), JSON.stringify({
      last: { at: now - 30_000, ok: true, tier: 'Google AI Ultra', plan: 'Ultra Lite', groups: [mixedGroup] },
      history: oldSamples,
      accounts: {
        [idAlt]: { last: { at: now - 30_000, ok: true, tier: 'Google AI Ultra', plan: 'Ultra Lite', groups: [mixedGroup] }, history: [...oldSamples], notified: {} },
        [idOrig]: { last: { at: now - 20_000, ok: true, tier: 'Google AI Ultra', plan: 'Ultra', groups: [mixedGroup] }, history: [{ at: now - 20_000, groups: [mixedGroup] }], notified: {} },
      },
    }));
    const qRepaired = new mod.AntigravityQuota({ now: () => now, fetcher: async () => null });
    const repairedState = qRepaired.state();
    const altState = repairedState.accounts.find((a) => a.id === idAlt);
    const origState = repairedState.accounts.find((a) => a.id === idOrig);
    assert.equal(altState.history.length, 0, '先加的副号不再占位原本机账号的老历史采样');
    assert.equal(origState.history.length, 2, '原本机账号完整找回迁移前的历史采样');
    assert.equal(origState.last.tier, 'Google AI Ultra', '混组清洗后不抹除套餐等级');
    assert.equal(origState.last.plan, 'Ultra');
    assert.equal(origState.last.groups.length, 1);
    assert.equal(origState.last.groups[0].models.some((m) => /Gemini/i.test(m)), false, '残余混组中的跨池 Gemini 已剔除，保留干净的 Claude/GPT 组');
    pass('reconcileLegacyHistory restores pre-migration history to original local account without wiping tier/plan');
  } finally {
    process.env.TOKENPULSE_DATA_DIR = prevDataDir;
    try { fs.rmSync(repairRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // 8. 锯齿抖动抗重复计数（单调高水位 + 请求单调游标）与周额度平滑跟进（不再因权重未过半锁死在旧周）
  {
    const jNow = Date.UTC(2026, 10, 19, 12, 0, 0);
    const w1Reset = jNow - 14 * 24 * H;
    const w2Reset = jNow - 7 * 24 * H;
    const w3Reset = jNow + 5 * 24 * H;
    const w3Start = w3Reset - 7 * 24 * H;
    const jHistory = [
      // 前两周：分别折算出 1.2B 和 1.0B（权重 25 和 15）
      { at: w1Reset - 3 * 24 * H, groups: [{ key: KEY, used: 0, resetAt: iso(w1Reset - 3 * 24 * H + 5 * H), weekUsed: 0, weekResetAt: iso(w1Reset) }] },
      { at: w1Reset - 2 * 24 * H, groups: [{ key: KEY, used: 0, resetAt: iso(w1Reset - 2 * 24 * H + 5 * H), weekUsed: 25, weekResetAt: iso(w1Reset) }] },
      { at: w2Reset - 3 * 24 * H, groups: [{ key: KEY, used: 0, resetAt: iso(w2Reset - 3 * 24 * H + 5 * H), weekUsed: 0, weekResetAt: iso(w2Reset) }] },
      { at: w2Reset - 2 * 24 * H, groups: [{ key: KEY, used: 0, resetAt: iso(w2Reset - 2 * 24 * H + 5 * H), weekUsed: 15, weekResetAt: iso(w2Reset) }] },
      // 本周：先上升到 10%，随后反复锯齿抖动（闲时与活跃时都有回落再回弹），最终到 20%
      { at: w3Start + 1 * H, groups: [{ key: KEY, used: 0, resetAt: iso(w3Start + 6 * H), weekUsed: 0, weekResetAt: iso(w3Reset) }] },
      { at: w3Start + 2 * H, groups: [{ key: KEY, used: 10, resetAt: iso(w3Start + 6 * H), weekUsed: 10, weekResetAt: iso(w3Reset) }] },
      // 闲时锯齿抖动 3 次（10 -> 9.2 -> 10 -> 9.0 -> 10 -> 9.3 -> 10）：不应记为外部消耗或重复本机消耗
      { at: w3Start + 2 * H + 10 * 60_000, groups: [{ key: KEY, used: 9.2, resetAt: iso(w3Start + 6 * H), weekUsed: 9.2, weekResetAt: iso(w3Reset) }] },
      { at: w3Start + 2 * H + 20 * 60_000, groups: [{ key: KEY, used: 10, resetAt: iso(w3Start + 6 * H), weekUsed: 10, weekResetAt: iso(w3Reset) }] },
      { at: w3Start + 2 * H + 30 * 60_000, groups: [{ key: KEY, used: 9.0, resetAt: iso(w3Start + 6 * H), weekUsed: 9.0, weekResetAt: iso(w3Reset) }] },
      { at: w3Start + 2 * H + 40 * 60_000, groups: [{ key: KEY, used: 10, resetAt: iso(w3Start + 6 * H), weekUsed: 10, weekResetAt: iso(w3Reset) }] },
      { at: w3Start + 2 * H + 50 * 60_000, groups: [{ key: KEY, used: 9.3, resetAt: iso(w3Start + 6 * H), weekUsed: 9.3, weekResetAt: iso(w3Reset) }] },
      // 活跃期短暂回落后继续净涨到 20%（再回落至 19.5% 收尾）
      { at: w3Start + 4 * H, groups: [{ key: KEY, used: 9.5, resetAt: iso(w3Start + 6 * H), weekUsed: 9.5, weekResetAt: iso(w3Reset) }] },
      { at: w3Start + 4 * H + 10 * 60_000, groups: [{ key: KEY, used: 9.6, resetAt: iso(w3Start + 6 * H), weekUsed: 9.6, weekResetAt: iso(w3Reset) }] },
      { at: w3Start + 4 * H + 20 * 60_000, groups: [{ key: KEY, used: 20, resetAt: iso(w3Start + 6 * H), weekUsed: 20, weekResetAt: iso(w3Reset) }] },
      { at: w3Start + 4 * H + 30 * 60_000, groups: [{ key: KEY, used: 19.5, resetAt: iso(w3Start + 6 * H), weekUsed: 19.5, weekResetAt: iso(w3Reset) }] },
    ];
    const mkRow = (at, tok) => ({ at, model: 'gemini-4-argon', effort: 'high', tokens: tok, costUsd: tok / 1e6, calls: 1, input: tok, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 1, source: 'Antigravity', kind: 'antigravity' });
    const baseRows = [
      mkRow(w1Reset - 2.5 * 24 * H, 300e6), // 300M / 25% = 1.2B
      mkRow(w2Reset - 2.5 * 24 * H, 150e6), // 150M / 15% = 1.0B
      mkRow(w3Start + 1.5 * H, 80e6),
      mkRow(w3Start + 4 * H + 3 * 60_000, 30e6),
      mkRow(w3Start + 4 * H + 15 * 60_000, 50e6),
    ];
    fs.writeFileSync(path.join(root, 'data', 'antigravity-quota.json'), JSON.stringify({
      last: { at: jNow - 60_000, ok: true, plan: 'Ultra', groups: [{ key: KEY, title: 'Gemini Models', models: ['Gemini 4 Argon', 'Gemini 3.8 Flash'], used: 19.5, resetAt: iso(w3Start + 6 * H), week: { used: 19.5, resetAt: iso(w3Reset) } }] },
      history: jHistory, notified: {},
    }));
    const qJ = new mod.AntigravityQuota({ now: () => jNow, fetcher: async () => null });
    qJ.recentRows = () => baseRows;
    const wIns1 = qJ.buildInsight(jNow).groups[0];
    const wPt1 = wIns1.capacityHistory.week.at(-1);
    assert.equal(wIns1.week.shared.offPoints, 0, '闲时锯齿抖动回弹不再被误判成家庭组/他端消耗');
    assert.ok(wPt1.usedPct <= 20.1, `本周有效点数不超过高水位 20%（实际 ${wPt1.usedPct}）`);
    assert.ok(wPt1.tokens <= 160e6, `单调游标保证本机 Token 不被重复累加（实际 ${wPt1.tokens}）`);
    // 本周进一步消耗（20% -> 28%，Token 从 160M 增至 196M → 本周折算从 800M 降到 700M），周额度整窗折算必须实时变化而非钉死在 1.0B
    const cap1 = wIns1.week.capacity.fullTokens;
    assert.ok(cap1 < 980e6, `周额度折算平滑吸收本周 800M 变化，不再锁死在旧周 1.0B（实际 ${cap1}）`);
    jHistory.push({ at: w3Start + 5 * H, groups: [{ key: KEY, used: 28, resetAt: iso(w3Start + 6 * H), weekUsed: 28, weekResetAt: iso(w3Reset) }] });
    fs.writeFileSync(path.join(root, 'data', 'antigravity-quota.json'), JSON.stringify({
      last: { at: jNow - 30_000, ok: true, plan: 'Ultra', groups: [{ key: KEY, title: 'Gemini Models', models: ['Gemini 4 Argon', 'Gemini 3.8 Flash'], used: 28, resetAt: iso(w3Start + 6 * H), week: { used: 28, resetAt: iso(w3Reset) } }] },
      history: jHistory, notified: {},
    }));
    const qJ2 = new mod.AntigravityQuota({ now: () => jNow, fetcher: async () => null });
    qJ2.recentRows = () => [...baseRows, mkRow(w3Start + 4.8 * H, 36e6)];
    const cap2 = qJ2.buildInsight(jNow).groups[0].week.capacity.fullTokens;
    assert.ok(cap2 < cap1 - 20e6, `本周继续消耗并改变折算率时，周额度整窗折算持续响应变化（${cap1} -> ${cap2}）`);
    // 极端离群旧周（如 10 倍 Flash 窗口）仍被稳健剔除
    const robust = mod.robustRecencyEstimate([{ value: 10000, weight: 20 }, { value: 900, weight: 15 }, { value: 800, weight: 25 }], 0.55);
    assert.ok(robust >= 780 && robust <= 900, `稳健近期加权剔除 10 倍离群旧周（实际 ${robust}）`);
    pass('monotonic peakUsed + row cursor prevent jitter double-counting and weekly capacity updates smoothly');
  }

  // 9. 同档位本地 Ultra 目录自动补齐云端旧版模型列表 + 整窗换算单调性、不跨池混比、防 2 次冷启动调用数爆炸
  {
    const uRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-agy-ultra-'));
    const prevDir = process.env.TOKENPULSE_DATA_DIR;
    process.env.TOKENPULSE_DATA_DIR = uRoot;
    try {
      const accMod = require('../build/core/antigravity-accounts');
      const uNow = Date.UTC(2026, 10, 21, 12, 0, 0);
      const idCloud = accMod.rememberAgyAccount({ email: 'ultra-cloud@example.com', credential: { token: 't1', refreshToken: 'r1', expiresAt: uNow + 3600_000 } }, true, uNow);
      const idLocal = accMod.rememberAgyAccount({ email: 'ultra-local@example.com', credential: { token: 't2', refreshToken: 'r2', expiresAt: uNow + 3600_000 } }, true, uNow);
      const localModels = [
        { label: 'Gemini 4 Neon (High)', family: 'Gemini 4 Neon', model: 'gemini-4-neon', effort: 'high', used: 20, resetAt: iso(uNow + 3 * H) },
        { label: 'Gemini 4 Neon (XHigh)', family: 'Gemini 4 Neon', model: 'gemini-4-neon', effort: 'xhigh', used: 20, resetAt: iso(uNow + 3 * H) },
        { label: 'Gemini 4 Neon (Medium)', family: 'Gemini 4 Neon', model: 'gemini-4-neon', effort: 'medium', used: 20, resetAt: iso(uNow + 3 * H) },
        { label: 'Gemini 4 Neon (Low)', family: 'Gemini 4 Neon', model: 'gemini-4-neon', effort: 'low', used: 20, resetAt: iso(uNow + 3 * H) },
        { label: 'Orchestrator (Neon)', family: 'Orchestrator (Neon)', model: 'orchestrator-neon', used: 20, resetAt: iso(uNow + 3 * H) },
        { label: 'Gemini 3.8 Flash (High)', family: 'Gemini 3.8 Flash', model: 'gemini-3.8-flash', effort: 'high', used: 20, resetAt: iso(uNow + 3 * H) },
        { label: 'Claude Opus 5.5 (Low)', family: 'Claude Opus 5.5', model: 'claude-opus-5-5', effort: 'low', used: 0, resetAt: iso(uNow + 4 * H) },
        { label: 'Claude Opus 5.5 (Medium)', family: 'Claude Opus 5.5', model: 'claude-opus-5-5', effort: 'medium', used: 0, resetAt: iso(uNow + 4 * H) },
        { label: 'Claude Opus 5.5 (High)', family: 'Claude Opus 5.5', model: 'claude-opus-5-5', effort: 'high', used: 0, resetAt: iso(uNow + 4 * H) },
      ];
      fs.writeFileSync(path.join(uRoot, 'antigravity-quota.json'), JSON.stringify({
        accounts: {
          [idCloud]: {
            last: {
              at: uNow - 10_000, ok: true, plan: 'Ultra', tier: 'Google AI Ultra',
              groups: [
                { key: 'Gemini 2.5 Pro|Gemini 3 Flash|Gemini 3.8 Flash', title: 'Gemini Models', models: ['Gemini 3.8 Flash', 'Gemini 2.5 Pro', 'Gemini 3 Flash'], used: 12.5, resetAt: iso(uNow + 2 * H), week: { used: 4, resetAt: iso(uNow + 5 * 24 * H) } },
                { key: 'Claude Opus 5.5', title: 'Claude and GPT models', models: ['Claude Opus 5.5'], used: 0, resetAt: iso(uNow + 4 * H) },
              ],
              models: [
                { label: 'Gemini 3.8 Flash (High)', family: 'Gemini 3.8 Flash', model: 'gemini-3.8-flash', effort: 'high', used: 12.5, resetAt: iso(uNow + 2 * H) },
                { label: 'Gemini 2.5 Pro', family: 'Gemini 2.5 Pro', model: 'gemini-2.5-pro', used: 12.5, resetAt: iso(uNow + 2 * H) },
                { label: 'Claude Opus 5.5 (Low)', family: 'Claude Opus 5.5', model: 'claude-opus-5-5', effort: 'low', used: 0, resetAt: iso(uNow + 4 * H) },
                { label: 'Claude Opus 5.5 (Medium)', family: 'Claude Opus 5.5', model: 'claude-opus-5-5', effort: 'medium', used: 0, resetAt: iso(uNow + 4 * H) },
                { label: 'Claude Opus 5.5 (High)', family: 'Claude Opus 5.5', model: 'claude-opus-5-5', effort: 'high', used: 0, resetAt: iso(uNow + 4 * H) },
              ],
            },
            history: [
              { at: uNow - 2 * H, groups: [{ key: 'Gemini 3.8 Flash', used: 0, resetAt: iso(uNow + 2 * H) }] },
              { at: uNow - 10_000, groups: [{ key: 'Gemini 3.8 Flash', used: 12.5, resetAt: iso(uNow + 2 * H) }] },
            ],
            notified: {},
          },
          [idLocal]: {
            last: {
              at: uNow - 5_000, ok: true, plan: 'Ultra Lite', tier: 'Google AI Ultra',
              groups: [
                { key: 'Gemini 3.8 Flash|Gemini 4 Neon|Orchestrator', title: 'Gemini Models', models: ['Gemini 4 Neon', 'Orchestrator', 'Gemini 3.8 Flash'], used: 20, resetAt: iso(uNow + 3 * H) },
                { key: 'Claude Opus 5.5', title: 'Claude and GPT models', models: ['Claude Opus 5.5'], used: 0, resetAt: iso(uNow + 4 * H) },
              ],
              models: localModels,
            },
            history: [],
            notified: {},
          },
        },
      }));
      fs.writeFileSync(path.join(uRoot, 'antigravity-logins.json'), JSON.stringify({ version: 1, spans: [{ from: uNow - 5 * 24 * H, id: idCloud }] }));
      const qU = new mod.AntigravityQuota({ now: () => uNow, fetcher: async () => null });
      const mkAgy = (at, model, effort, inp, out, cr, usd) => ({ at, model, effort, tokens: inp + out, input: inp, output: out, cacheRead: cr, cacheWrite: 0, reasoning: 0, costUsd: usd, calls: 1, requests: 1, source: 'Antigravity', kind: 'antigravity' });
      const uRows = [];
      for (let i = 0; i < 40; i++) uRows.push(mkAgy(uNow - H + i * 60_000, 'gemini-4-neon', 'high', 200_000, 2_000, 170_000, 0.11));
      // 2 条极短冷启动 low 请求：绝不能把 low 档调用数拉爆
      uRows.push(mkAgy(uNow - 30 * 60_000, 'gemini-4-neon', 'low', 10_000, 200, 0, 0.015));
      uRows.push(mkAgy(uNow - 29 * 60_000, 'gemini-4-neon', 'low', 10_000, 200, 0, 0.015));
      qU.recentRows = () => uRows;
      const uSt = qU.state();
      const cloudAcc = uSt.accounts.find((a) => a.id === idCloud);
      assert.ok(cloudAcc.last.groups[0].models.includes('Gemini 4 Neon') && !cloudAcc.last.groups[0].models.includes('Gemini 2.5 Pro'), '云端 Ultra 账号自动同步本机最新 Ultra 型号目录，剔除旧版 2.5 Pro');
      assert.equal(cloudAcc.last.groups[0].used, 12.5, '同步型号目录绝不覆盖该账号自己的已用百分比');
      const caps = cloudAcc.insight.modelCapacities;
      const by = (m, ef) => caps.find((r) => r.model === m && r.effort === ef);
      assert.ok(by('gemini-4-neon', 'low').fiveTokens > by('gemini-4-neon', 'medium').fiveTokens);
      assert.ok(by('gemini-4-neon', 'medium').fiveTokens > by('gemini-4-neon', 'high').fiveTokens);
      assert.ok(by('gemini-4-neon', 'high').fiveTokens > by('gemini-4-neon', 'xhigh').fiveTokens);
      assert.ok(by('gemini-4-neon', 'low').fiveCalls < by('gemini-4-neon', 'high').fiveCalls * 1.5, '2 次冷启动请求不再把 low 档调用次数拉爆到几十倍');
      const opusMed = by('claude-opus-5-5', 'medium');
      assert.equal(opusMed.relative, 1, 'Claude 池相对比例在池内独立归一化，不与 Gemini 池混比');
      pass('same-tier Ultra catalog enrichment, monotonic capacity estimates, cold-start guard, and per-pool relative scaling');
    } finally {
      process.env.TOKENPULSE_DATA_DIR = prevDir;
      try { fs.rmSync(uRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
console.log(`\n${checks}/9 antigravity capacity & family-group checks`);
