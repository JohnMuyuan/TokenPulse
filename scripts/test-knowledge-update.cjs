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

// 仓库里的 knowledge/models.json 必须是由 manual.json 生成、软件能全部收下的
const repo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge', 'models.json'), 'utf8'));
const repoManual = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge', 'manual.json'), 'utf8'));
assert.deepEqual(validate(repo), []);
assert.equal(parseKnowledge(repo).prices.length, repo.prices.length);
assert.deepEqual(repo.prices.slice(0, repoManual.pinned.length), repoManual.pinned);
assert.deepEqual(repo.prices.slice(-repoManual.fallback.length), repoManual.fallback);
assert.deepEqual(repo.capabilities, repoManual.capabilities);
console.log('PASS knowledge auto-update: selection, per-million prices, missing cache read not free, zero price skipped, prefixes / dated snapshots, fallback-equal skipped, disputes held back, small change auto, big change needs review, removed models kept, bulk additions need review, same-day versions, unchanged keeps version, app parser accepts all rules, capabilities shipped online, CLI + GITHUB_OUTPUT, repo file consistent with manual.json');
