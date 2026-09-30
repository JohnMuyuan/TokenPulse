/*
 * 0.3.11 模型知识库自动更新（scripts/update-knowledge.cjs）：用假的 LiteLLM / OpenRouter 数据，不联网。
 * 覆盖：挑型号、换算单价、缓存价缺失不当免费、0 价不收、带前缀 / 日期快照、和兜底一样的不加、两边对不上先不用、
 * 调价（小的直接用、大的要确认）、来源里没了不删、一次新增太多要确认、同一天多次更新的版本号、没变化不改版本、
 * 生成的文件能被软件的 parseKnowledge 全部收下并按预期匹配、思考等级规则随知识库下发、命令行 + GITHUB_OUTPUT。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { build, validate, markdown } = require('./update-knowledge.cjs');
const { parseKnowledge } = require('../build/core/knowledge.js');

const manual = {
  notes: '测试',
  pinned: [{ match: '(^|[-_:/])free$', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, note: '免费' }],
  fallback: [
    { match: 'claude.*opus', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, note: 'Opus 兜底' },
    { match: 'claude', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, note: 'Claude 兜底' },
    { match: 'grok', input: 3, output: 15, cacheRead: 0.75, cacheWrite: 0, note: 'Grok 兜底' },
  ],
  aliases: [{ match: '\\[[^\\]]*\\]$', replace: '', note: '[1m]' }],
  capabilities: { checkedAt: '2026-09-30', claude: { source: 'x', models: ['claude-opus-9'], rules: [{ match: '^claude-opus', efforts: ['low', 'high', 'max'] }] } },
};
const M = 1e-6;
const entry = (provider, input, output, extra = {}) => ({ litellm_provider: provider, mode: 'chat', input_cost_per_token: input * M, output_cost_per_token: output * M, ...extra });
const litellm = {
  'claude-opus-9': entry('anthropic', 4, 20, { cache_read_input_token_cost: 0.4 * M, cache_creation_input_token_cost: 5 * M }),
  'claude-opus-9-20260901': entry('anthropic', 4, 20, { cache_read_input_token_cost: 0.4 * M, cache_creation_input_token_cost: 5 * M }), // 同价快照：去掉
  'claude-opus-8-20260101': entry('anthropic', 6, 30, { cache_read_input_token_cost: 0.6 * M, cache_creation_input_token_cost: 7.5 * M }), // 不同价快照：保留
  'claude-sonnet-9': entry('anthropic', 3, 15, { cache_read_input_token_cost: 0.3 * M, cache_creation_input_token_cost: 3.75 * M }), // 和兜底一样：不加
  'xai/grok-9': entry('xai', 2, 6, { cache_read_input_token_cost: 0.5 * M }),
  'gpt-9-pro': { litellm_provider: 'openai', mode: 'responses', input_cost_per_token: 30 * M, output_cost_per_token: 180 * M }, // 没缓存价：按输入价
  'gpt-9-zero': entry('openai', 0, 0), // 收费型号 0 价：不收
  'text-embedding-9': { litellm_provider: 'openai', mode: 'embedding', input_cost_per_token: 0.1 * M, output_cost_per_token: 0 },
  'gpt-9-realtime': entry('openai', 5, 20),
  'bedrock/claude-opus-9': entry('bedrock', 1, 1), // 别家渠道：不要
  'gpt-9-disputed': entry('openai', 4, 20),
};
const openrouter = { data: [{ id: 'openai/gpt-9-disputed', pricing: { prompt: String(2 * M), completion: String(10 * M) } }, { id: 'x-ai/grok-9', pricing: { prompt: String(2 * M), completion: String(6 * M) } }] };
const day = '2026-09-30T10:00:00.000Z';

// ---- 第一次生成 ----
const first = build({ manual, current: null, litellm, openrouter, today: day });
assert.equal(first.changed, true);
assert.equal(first.knowledge.version, '2026.09.30');
const ids = first.knowledge.prices.filter(r => r.auto).map(r => r.auto).sort();
assert.deepEqual(ids, ['claude-opus-8-20260101', 'claude-opus-9', 'gpt-9-pro', 'grok-9'].sort());
assert.deepEqual(first.report.disputed.map(d => d.id), ['gpt-9-disputed'], '两边对不上的先不用');
assert.deepEqual(first.report.skipped.map(s => s.id), ['gpt-9-zero']);
assert.equal(first.report.review, false);
const pro = first.knowledge.prices.find(r => r.auto === 'gpt-9-pro');
assert.equal(pro.cacheRead, 30, '没有缓存价时按输入价算，不当成免费');
assert.equal(first.knowledge.prices[0].note, '免费', 'pinned 在最前');
assert.equal(first.knowledge.prices.at(-1).note, 'Grok 兜底', 'fallback 在最后');
assert.deepEqual(validate(first.knowledge), []);

// 软件能全部收下，并按预期匹配
const parsed = parseKnowledge(JSON.parse(JSON.stringify(first.knowledge)));
assert.equal(parsed.prices.length, first.knowledge.prices.length);
assert.equal(parsed.capabilities.claude.rules[0].efforts.join(','), 'low,high,max', '思考等级规则随知识库下发');
const rules = parsed.prices.map(r => ({ t: new RegExp(r.match, 'i'), r }));
const price = id => { const hit = rules.find(x => x.t.test(id)); return hit ? `${hit.r.input}/${hit.r.output}` : null; };
assert.equal(price('claude-opus-9'), '4/20');
assert.equal(price('claude-opus-9[1m]'), '4/20', 'Claude Code 的 [1m] 标记');
assert.equal(price('claude-opus-9-20260901'), '4/20', '日期后缀');
assert.equal(price('us.anthropic.claude-opus-9-v1:0'), '4/20', 'Bedrock 写法');
assert.equal(price('anthropic/claude-opus-9'), '4/20', '带渠道前缀');
assert.equal(price('claude-opus-8-20260101'), '6/30', '不同价的快照单独一条');
assert.equal(price('claude-opus-8'), '5/25', '没有的走兜底');
assert.equal(price('claude-opus-99'), '5/25', '不会误匹配更长的型号');
assert.equal(price('grok-9'), '2/6');
assert.equal(price('grok-9-mini'), '3/15');
assert.equal(price('gpt-9-disputed'), null, '有争议的先不用（这里没有兜底）');
assert.equal(price('some-free'), '0/0');

// ---- 没变化：不改版本 ----
const again = build({ manual, current: first.knowledge, litellm, openrouter, today: '2026-10-01T00:00:00.000Z' });
assert.equal(again.changed, false);
assert.equal(again.knowledge.version, '2026.09.30');

// ---- 同一天小幅调价：直接用，版本 .1 ----
const cheaper = { ...litellm, 'claude-opus-9': entry('anthropic', 3.5, 18, { cache_read_input_token_cost: 0.35 * M, cache_creation_input_token_cost: 4.4 * M }) };
const small = build({ manual, current: first.knowledge, litellm: cheaper, openrouter, today: day });
assert.equal(small.changed, true);
assert.equal(small.knowledge.version, '2026.09.30.1');
assert.equal(small.report.review, false);
assert.equal(small.report.changed[0].id, 'claude-opus-9');

// ---- 大幅调价：要人确认 ----
const huge = build({ manual, current: first.knowledge, litellm: { ...litellm, 'claude-opus-9': entry('anthropic', 40, 200) }, openrouter, today: '2026-10-02T00:00:00.000Z' });
assert.equal(huge.report.review, true);
assert.match(huge.report.reasons.join(), /50%/);
assert.equal(huge.knowledge.version, '2026.10.02');

// ---- 来源里没了：不删 ----
const { 'grok-9': _gone, ...withoutGrok } = litellm; delete withoutGrok['xai/grok-9'];
const gone = build({ manual, current: first.knowledge, litellm: withoutGrok, openrouter, today: '2026-10-03T00:00:00.000Z' });
assert.ok(gone.knowledge.prices.some(r => r.auto === 'grok-9'), '来源里消失的型号按原价保留');
assert.deepEqual(gone.report.kept, ['grok-9']);

// ---- 一次新增太多：要人确认 ----
const many = { ...litellm };
for (let i = 0; i < 70; i++) many[`claude-opus-9-${i}x`] = entry('anthropic', 4, 20);
assert.equal(build({ manual, current: null, litellm: many, openrouter, today: day }).report.review, true);

// ---- 报告 ----
const md = markdown(small);
assert.match(md, /调价/); assert.match(md, /claude-opus-9/);
assert.match(markdown(first), /和 OpenRouter 对不上/);

// ---- 命令行：本地文件 + GITHUB_OUTPUT ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-knowledge-'));
try {
  fs.writeFileSync(path.join(dir, 'manual.json'), JSON.stringify(manual));
  fs.writeFileSync(path.join(dir, 'litellm.json'), JSON.stringify(litellm));
  fs.writeFileSync(path.join(dir, 'openrouter.json'), JSON.stringify(openrouter));
  const out = path.join(dir, 'gh-output');
  execFileSync(process.execPath, [path.join(__dirname, 'update-knowledge.cjs'), '--dir', dir, '--write', '--litellm', path.join(dir, 'litellm.json'), '--openrouter', path.join(dir, 'openrouter.json'), '--today', day, '--report', path.join(dir, 'report.md')], { env: { ...process.env, GITHUB_OUTPUT: out }, stdio: 'pipe' });
  assert.match(fs.readFileSync(out, 'utf8'), /changed=true\nreview=false\nversion=2026\.09\.30/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8')).version, '2026.09.30');
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /模型知识库自动更新/);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

// ---- 思考等级消耗（Epoch AI，0.3.12） ----
{
  const zlib = require('node:zlib');
  const { unzip, fromEpoch } = require('./update-knowledge.cjs');
  // 手写一个最小的 zip（一个 deflate、一个存储），验证解包
  const zip = entries => {
    const locals = [], centrals = []; let offset = 0;
    for (const [name, text, deflate] of entries) {
      const raw = Buffer.from(text), data = deflate ? zlib.deflateRawSync(raw) : raw, n = Buffer.from(name);
      const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
      const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(deflate ? 8 : 0, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
      locals.push(local, n, data); centrals.push(central, n); offset += 30 + n.length + data.length;
    }
    const cd = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
  };
  const deepswe = ['Model version,Harness,Reasoning effort,Mean output tokens',
    'claude-opus-9_low,mini-swe-agent,low,20000', 'claude-opus-9_medium,mini-swe-agent,medium,40000', 'claude-opus-9_high,mini-swe-agent,high,80000',
    'claude-opus-9_high,other-harness,high,999999', // 别的 harness：不要
    'gpt-9-2026-01-01_low,mini-swe-agent,low,5000', 'gpt-9-2026-01-01_medium,mini-swe-agent,medium,10000', 'gpt-9-2026-01-01_xhigh,mini-swe-agent,xhigh,30000',
    'grok-9_medium,mini-swe-agent,medium,10000', 'grok-9_high,mini-swe-agent,high,15000',
    'gemini-9_high,mini-swe-agent,high,1000', 'gemini-9_low,mini-swe-agent,low,500', // 别家：不要
  ].join('\n');
  const cursor = ['Model version,Reasoning level,Tokens per task',
    'claude-opus-9_low,Low,10000', 'claude-opus-9_medium,Medium,20000', 'claude-opus-9_high,High,41000', // 和 DeepSWE 的倍数一致
    'grok-9_medium,Medium,10000', 'grok-9_high,High,90000', // 和 DeepSWE 差 6 倍：先不用
    'claude-new-9_medium,Medium,30000', 'claude-new-9_max,Max,150000', 'claude-new-9_high,"Extra High",60000', // DeepSWE 没有：用 CursorBench 补位
  ].join('\n');
  const files = unzip(zip([['data/deepswe_external.csv', deepswe, true], ['data/cursorbench_external.csv', cursor, false], ['README.md', 'x', true]]));
  assert.equal(files.size, 3);
  const { usage, disputed } = fromEpoch(files, day);
  assert.deepEqual(usage.models['claude-opus-9'], { basis: 'DeepSWE', perTask: { low: 20000, medium: 40000, high: 80000 } });
  assert.deepEqual(usage.models['gpt-9'].perTask, { low: 5000, medium: 10000, xhigh: 30000 }, '去掉日期后缀');
  assert.equal(usage.models['claude-new-9'].basis, 'CursorBench');
  assert.equal(usage.models['claude-new-9'].perTask.xhigh, 60000, 'Extra High → xhigh');
  assert.equal(usage.models['grok-9'], undefined, '两个基准倍数差太多：先不用');
  assert.deepEqual(disputed.map(d => d.id), ['grok-9']);
  assert.ok(!Object.keys(usage.models).some(id => id.startsWith('gemini')), '只要 Claude / GPT / Grok');
  assert.equal(usage.families.claude.medium, 1); assert.equal(usage.families.claude.low, 0.5); assert.equal(usage.families.claude.high, 2);
  assert.equal(usage.families.chatgpt.xhigh, 3);
  assert.equal(usage.license, 'CC BY 4.0');

  // 生成：带上 effortUsage；Epoch 取不到就沿用上一版；某一档变化超过 50% 要人确认
  const withEpoch = build({ manual, current: first.knowledge, litellm, openrouter, epoch: files, today: day });
  assert.equal(withEpoch.changed, true);
  assert.equal(withEpoch.knowledge.effortUsage.models['claude-opus-9'].perTask.high, 80000);
  assert.deepEqual(validate(withEpoch.knowledge), []);
  assert.equal(parseKnowledge(JSON.parse(JSON.stringify(withEpoch.knowledge))).effortUsage.models['claude-opus-9'].perTask.high, 80000, '软件能收下');
  const stale = build({ manual, current: withEpoch.knowledge, litellm, openrouter, epoch: null, today: '2026-10-01T00:00:00.000Z' });
  assert.equal(stale.changed, false, 'Epoch 取不到：沿用上一版，不算变化');
  assert.equal(stale.report.effort.stale, true);
  const again2 = build({ manual, current: withEpoch.knowledge, litellm, openrouter, epoch: files, today: '2026-10-02T00:00:00.000Z' });
  assert.equal(again2.changed, false, '数据没变不改日期、不算变化');
  const jumped = build({ manual, current: withEpoch.knowledge, litellm, openrouter, epoch: unzip(zip([['deepswe_external.csv', deepswe.replace('high,80000', 'high,400000'), true]])), today: '2026-10-03T00:00:00.000Z' });
  assert.equal(jumped.report.review, true);
  assert.match(jumped.report.reasons.join(), /思考等级消耗/);
  assert.match(markdown(withEpoch), /思考等级消耗（Epoch AI）/);
}

// 仓库里的 knowledge/models.json 必须是由 manual.json 生成、软件能全部收下的
const repo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge', 'models.json'), 'utf8'));
const repoManual = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge', 'manual.json'), 'utf8'));
assert.deepEqual(validate(repo), []);
assert.equal(parseKnowledge(repo).prices.length, repo.prices.length);
assert.deepEqual(repo.prices.slice(0, repoManual.pinned.length), repoManual.pinned);
assert.deepEqual(repo.prices.slice(-repoManual.fallback.length), repoManual.fallback);
assert.deepEqual(repo.capabilities, repoManual.capabilities);
assert.ok(Object.keys(parseKnowledge(repo).effortUsage.models).length >= 5, '仓库里的知识库带着思考等级消耗');
console.log('PASS knowledge auto-update: selection, per-million prices, missing cache read not free, zero price skipped, prefixes / dated snapshots, fallback-equal skipped, disputes held back, small change auto, big change needs review, removed models kept, bulk additions need review, same-day versions, unchanged keeps version, app parser accepts all rules, capabilities shipped online, CLI + GITHUB_OUTPUT, Epoch zip / effort usage / disputes / stale / review, repo file consistent with manual.json');
