/*
 * 0.3.12 思考等级的 token 消耗：没用够的组合按「最常用那一档」的实际用量，把输出乘上等级倍数推算。
 * 倍数优先级：本机实测（同型号两档各 ≥ 20 次调用）> Epoch 基准的同型号数据 > 同家族平均 > 不调整。
 * 有足够整段区间的组合仍按实测折算；用户自己加的型号没用过也能估；知识库里的等级消耗表按不可信输入校验。
 * 临时数据目录，自己写一份更新的知识库（effortUsage 用假数据）。
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-effort-'));
process.env.HOME = process.env.USERPROFILE = path.join(root, 'home'); process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
for (const k of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[k];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge', 'models.json'), 'utf8'));
const knowledge = {
  ...bundled, version: '9999.01.01',
  prices: [{ match: '^claude-qa', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, note: 'QA', auto: 'claude-qa' }, ...bundled.prices],
  effortUsage: {
    source: 'QA', sourceUrl: 'https://example.invalid', license: 'CC BY 4.0', anchor: 'medium', updatedAt: '2026-09-30',
    models: {
      'claude-qa': { basis: 'DeepSWE', perTask: { low: 10000, medium: 20000, high: 40000 } },
      'bad model!': { basis: 'x', perTask: { low: 1, medium: 2 } }, // 名字不合法：丢掉
      'claude-neg': { basis: 'x', perTask: { low: -1, medium: 2, weird: 5 } }, // 负数、未知等级：只剩一档，不够用，丢掉
    },
    families: { claude: { low: 0.5, medium: 1, high: 2, xhigh: 3, max: 5 } },
  },
};
fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'knowledge.json'), JSON.stringify(knowledge));
const { analyzeModelStudy } = require('../build/core/model-study');
const { loadKnowledge, benchmarkEffortRatio } = require('../build/core/knowledge');
const { modelCandidates, parseStudyModels, readStudyModels } = require('../build/core/model-catalog');

const now = Date.UTC(2026, 8, 28, 12), minute = 60000, account = 'claude:qa';
const query = { kind: 'claude', accountId: account, window: 'five' };
const samples = Array.from({ length: 4 }, (_, i) => ({ at: now - (3 - i) * 5 * minute, account, five: i * 2, fiveReset: new Date(now + 2 * 3600000).toISOString(), week: i * 2, weekReset: new Date(now + 3 * 86400000).toISOString(), plan: 'max' }));
// 本机只用过 claude-qa · medium：每次调用 输入 10000（其中缓存读 8000）、输出 1000
const row = (i, extra = {}) => ({ key: 'r' + i, at: now - (3 - i) * 5 * minute - minute, source: 'Claude Code', model: 'claude-qa', effort: 'medium', session: 's', input: 10000, output: 1000, cacheRead: 8000, cacheWrite: 0, reasoning: 0, tokens: 11000, costUsd: 0.039 /* 和价格表一致：2000×$5 + 8000×$0.5 + 1000×$25 */, priced: true, calls: 1, official: true, account: { id: account, label: 'QA', basis: 'timeline' }, status: 'unverified', statusLabel: 'unknown', reasons: [], channel: 'Anthropic', ...extra });
// 5 条混用区间：预算够、但没有哪个组合有「整段只用它」的区间
const records = [1, 2, 3].flatMap(i => [row(i), row(i, { key: 'x' + i, at: now - (3 - i) * 5 * minute - 30000, model: 'claude-other', effort: 'medium' })]);
const catalog = ['low', 'medium', 'high', 'xhigh'].map(effort => ({ model: 'claude-qa', effort, origins: ['docs'] })).concat([{ model: 'claude-fam', effort: 'high', origins: ['user'] }, { model: 'claude-fam', effort: 'medium', origins: ['user'] }]);
let checks = 0; const check = (name, fn) => { fn(); checks++; console.log('PASS ' + name); };

try {
  check('知识库的等级消耗表按不可信输入校验', () => {
    const k = loadKnowledge().knowledge;
    assert.equal(k.version, '9999.01.01');
    assert.deepEqual(Object.keys(k.effortUsage.models), ['claude-qa']);
    assert.equal(k.effortUsage.families.claude.high, 2);
  });
  check('基准倍数：同型号优先，其次家族平均，去掉 [1m] 和日期后缀', () => {
    assert.deepEqual(benchmarkEffortRatio('claude', 'claude-qa[1m]', 'medium', 'high'), { ratio: 2, basis: 'model', source: 'DeepSWE' });
    assert.deepEqual(benchmarkEffortRatio('claude', 'claude-qa-20260101', 'low', 'medium'), { ratio: 2, basis: 'model', source: 'DeepSWE' });
    assert.equal(benchmarkEffortRatio('claude', 'claude-qa', 'medium', 'xhigh').basis, 'family', '同型号没有这一档：家族平均');
    assert.equal(benchmarkEffortRatio('claude', 'claude-qa', 'medium', 'xhigh').ratio, 3);
    assert.equal(benchmarkEffortRatio('grok', 'grok-x', 'medium', 'high'), null, '没有数据：不编');
  });

  const d = analyzeModelStudy(query, samples, records, catalog, now);
  const cap = effort => d.capacities.find(c => c.model === 'claude-qa' && c.effort === effort);
  check('没用过的等级按基准倍数推算：高等级单价更贵、每次调用更大、能调用的次数更少', () => {
    assert.ok(d.budget.costUsd > 0, '有整窗预算');
    const low = cap('low'), med = cap('medium'), high = cap('high'), xhigh = cap('xhigh');
    assert.equal(med.effortBasis, null, '用过的那一档不调整');
    assert.equal(high.effortBasis, 'benchmark'); assert.equal(high.effortRatio, 2); assert.equal(high.effortAnchor, 'medium');
    assert.equal(xhigh.effortBasis, 'family'); assert.equal(xhigh.effortRatio, 3);
    assert.equal(low.effortRatio, 0.5);
    assert.equal(high.priceBasis, 'effort');
    // 单次调用：输入 10000 + 输出 1000 × 倍数
    assert.equal(high.tokensPerCall, 12000); assert.equal(high.tokensPerCallBasis, 'scaled');
    assert.equal(low.tokensPerCall, 10500);
    assert.equal(med.tokensPerCallBasis, 'own', '用过的按自己的实测');
    assert.ok(low.costPerMTokens < med.costPerMTokens && med.costPerMTokens < high.costPerMTokens && high.costPerMTokens < xhigh.costPerMTokens, '等级越高每百万 token 越贵（输出占比变大）');
    assert.ok(low.callsPerWindow > high.callsPerWindow && high.callsPerWindow > xhigh.callsPerWindow, '等级越高能调用的次数越少');
    // 手算：high 的单价 = (2000×5 + 8000×0.5 + 2000×25) / 12000 / 1e6
    assert.ok(Math.abs(high.costPerMTokens - (2000 * 5 + 8000 * 0.5 + 2000 * 25) / 12000) < 1e-9);
  });
  check('本机实测的等级倍数优先于基准', () => {
    // 再用过 high：每次输出 1500（本机：high 是 medium 的 1.5 倍，基准说 2 倍）；各 20 次以上调用
    const more = [...records, ...Array.from({ length: 25 }, (_, i) => row(100 + i, { key: 'm' + i, at: now - 40 * minute + i * 1000 })), ...Array.from({ length: 25 }, (_, i) => row(200 + i, { key: 'h' + i, effort: 'high', output: 1500, tokens: 11500, costUsd: 0.0515, at: now - 45 * minute + i * 1000 }))];
    const x = analyzeModelStudy(query, samples, more, catalog, now);
    const xhigh = x.capacities.find(c => c.model === 'claude-qa' && c.effort === 'xhigh');
    const high = x.capacities.find(c => c.model === 'claude-qa' && c.effort === 'high');
    assert.equal(high.effortBasis, null, 'high 自己用过了，按自己的');
    assert.equal(high.tokensPerCallBasis, 'own');
    // 起点是输出最多的那一档；xhigh 没有本机数据，只能用基准（起点 → xhigh）
    assert.ok(['benchmark', 'family'].includes(xhigh.effortBasis));
    const low = x.capacities.find(c => c.model === 'claude-qa' && c.effort === 'low');
    assert.ok(['benchmark', 'family'].includes(low.effortBasis));
    // 起点是 high（输出更多）；medium 和 high 各有 ≥20 次调用：两者之间的倍数用本机实测 1000 / 1500，而不是基准的 0.5
    const med = x.capacities.find(c => c.model === 'claude-qa' && c.effort === 'medium');
    assert.equal(med.effortBasis, 'own');
    assert.equal(med.effortAnchor, 'high');
    assert.ok(Math.abs(med.effortRatio - 1000 / 1500) < 1e-9, '本机实测倍数：' + med.effortRatio);
    assert.equal(med.tokensPerCallBasis, 'own', '单次调用也按自己的');
  });
  check('有足够整段区间的组合：排行用估计值，实测值另外保留', () => {
    const pure = [row(1), row(2), row(3)];
    const x = analyzeModelStudy(query, samples, pure, catalog, now);
    const med = x.capacities.find(c => c.model === 'claude-qa' && c.effort === 'medium');
    assert.equal(med.capacityBasis, 'cost'); assert.ok(med.estimatedTokens > 0, '实测值还在'); assert.equal(med.capacityTokens, med.derivedTokens);
    assert.equal(med.effortBasis, null);
  });
  check('用户自己加的、从没用过的型号：按家族倍数也能分出等级', () => {
    const fam = e => d.capacities.find(c => c.model === 'claude-fam' && c.effort === e);
    assert.ok(fam('medium') && fam('high'));
    assert.deepEqual(fam('high').origins, ['user']);
    assert.equal(fam('high').effortBasis, 'family');
    assert.ok(fam('high').callsPerWindow < fam('medium').callsPerWindow);
  });
  check('prefs 里的自选型号：校验、去重、不指定等级', () => {
    assert.deepEqual(parseStudyModels([{ model: 'claude-sonnet-5-5', efforts: ['high', 'bogus', 'high'] }, { model: 'claude-sonnet-5-5', efforts: ['low'] }, { model: 'bad name!', efforts: [] }, { model: 'gpt-6.1-sol' }]),
      [{ model: 'claude-sonnet-5-5', efforts: ['high'] }, { model: 'gpt-6.1-sol', efforts: ['not_supported'] }]);
    fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'prefs.json'), JSON.stringify({ studyModels: { claude: [{ model: 'claude-sonnet-5-5', efforts: ['medium', 'high'] }] } }));
    assert.deepEqual(readStudyModels('claude'), [{ model: 'claude-sonnet-5-5', efforts: ['medium', 'high'] }]);
    assert.deepEqual(readStudyModels('grok'), []);
  });
  check('添加模型的候选：这一家有单价的型号，带单价和已知等级', () => {
    const list = modelCandidates('claude', /^claude/i);
    const qa = list.find(c => c.model === 'claude-qa');
    assert.ok(qa, '知识库自动规则里的型号在候选里');
    assert.equal(qa.input, 5); assert.equal(qa.usage, true);
    assert.deepEqual([...qa.efforts].sort(), ['high', 'low', 'medium']);
    assert.ok(list.every(c => /^claude/i.test(c.model)), '只列这一家');
    assert.ok(list.some(c => c.model === 'claude-sonnet-5-5'), '真实知识库里的新型号也在');
  });
  console.log(`${checks}/${checks} effort usage checks passed`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
