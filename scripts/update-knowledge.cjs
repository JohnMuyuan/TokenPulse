#!/usr/bin/env node
'use strict';
/*
 * 模型知识库自动更新（0.3.11）。GitHub Actions 每天跑一次（.github/workflows/knowledge.yml），也可以本地跑：
 *   node scripts/update-knowledge.cjs              只看报告，不写文件
 *   node scripts/update-knowledge.cjs --write      生成 knowledge/models.json
 *   --litellm <file> / --openrouter <file>         用本地文件代替网络（测试用）
 *   --report <file>                                 把 Markdown 报告写到文件（PR 正文用）
 *
 * knowledge/models.json = manual.pinned（手动特例）+ 自动规则（逐个型号）+ manual.fallback（按家族估的兜底），
 * 外加 manual.aliases 和 manual.capabilities（思考等级规则，0.3.11 起在线下发）。匹配从上往下，第一条命中生效。
 *
 * 自动规则的来源：LiteLLM 的公开价格表（Anthropic / OpenAI / xAI 的 Claude、GPT、o 系列、Codex、Grok），
 * 用 OpenRouter 的价格交叉核对。只在兜底规则给出的价格不一样时才加一条，文件保持精简。
 *
 * 安全规则：
 * - 和 OpenRouter 的价格差超过 25% 的型号先不用（保留原来的价格 / 兜底），列在报告里，等两边对上或在 manual.json 里手动钉住；
 * - 已有的自动规则单价变化超过 50%，或一次新增超过 60 条：report.review = true，工作流开 PR 让人确认，而不是直接推 main；
 * 永远不自动删除规则（来源里消失的型号保留原价）；收费型号给出 0 价的不收；缓存读价缺失时按输入价算（不当成免费）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const PROVIDERS = new Set(['anthropic', 'openai', 'xai']);
const FAMILY = /^(claude|gpt-|o\d|codex|grok|chatgpt)/i;
const SKIP = /(audio|realtime|transcribe|tts|image|dall-e|whisper|embedding|moderation|search-preview|computer-use|^ft:|instruct$|-batch$)/i;
const MODES = new Set(['chat', 'responses', 'completion', undefined]);
const BIG_CHANGE = 0.5, DISPUTE = 0.25, MAX_NEW = 60, MAX_ID = 60;

const round = n => Math.round(n * 1e6) / 1e6;
const perMillion = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? round(v * 1e6) : null);
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 型号 id → 正则：可带 xxx/ 前缀、Bedrock 的 us.anthropic. 前缀、日期 / -v1:0 后缀、Claude Code 的 [1m] 标记。 */
const patternOf = id => `^(?:[\\w.-]+/)?(?:[a-z]{2}\\.)?(?:(?:anthropic|openai|xai)\\.)?${escape(id)}(?:-\\d{8}|@\\d{8}|-\\d{4}-\\d{2}-\\d{2}|-v\\d+(?::\\d+)?)?(?:\\[[^\\]]*\\])?$`;
// 和 patternOf 认的日期后缀保持一致
const DATED = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
const norm = id => id.toLowerCase().replace(/^[^/]*\//, '').replace(/:.*$/, '').replace(/\./g, '-');

/** 从 LiteLLM 的表里挑出关心的型号，换成「美元 / 每百万 token」。 */
function fromLiteLLM(table) {
  const out = new Map();
  for (const [key, entry] of Object.entries(table || {})) {
    if (!entry || typeof entry !== 'object' || !PROVIDERS.has(entry.litellm_provider) || !MODES.has(entry.mode)) continue;
    const slash = key.indexOf('/');
    if (slash >= 0 && key.slice(0, slash) !== entry.litellm_provider) continue;
    const id = (slash >= 0 ? key.slice(slash + 1) : key).toLowerCase();
    if (!FAMILY.test(id) || SKIP.test(id) || id.length > MAX_ID || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) continue;
    const input = perMillion(entry.input_cost_per_token), output = perMillion(entry.output_cost_per_token);
    if (input === null || output === null) continue;
    const cacheRead = perMillion(entry.cache_read_input_token_cost) ?? input; // 没有缓存价 = 不打折，不能当成免费
    const cacheWrite = perMillion(entry.cache_creation_input_token_cost) ?? 0; // 0 = 按输入价算（OpenAI / xAI 都这样）
    const row = { id, input, output, cacheRead, cacheWrite, provider: entry.litellm_provider };
    // 不带前缀的写法优先（和带前缀的通常一样）
    if (!out.has(id) || slash < 0) out.set(id, row);
  }
  // 带日期的快照和不带日期的同价：去掉（正则已经认日期后缀）
  for (const [id, row] of out) {
    const base = id.replace(DATED, '');
    const same = out.get(base);
    if (base !== id && same && ['input', 'output', 'cacheRead', 'cacheWrite'].every(k => same[k] === row[k])) out.delete(id);
  }
  return out;
}

function fromOpenRouter(json) {
  const out = new Map();
  for (const m of (json && Array.isArray(json.data) ? json.data : [])) {
    if (typeof m?.id !== 'string' || !/^(anthropic|openai|x-ai)\//.test(m.id) || m.id.includes(':')) continue;
    const input = perMillion(Number(m.pricing?.prompt)), output = perMillion(Number(m.pricing?.completion));
    if (input === null || output === null) continue;
    out.set(norm(m.id), { input, output });
  }
  return out;
}

function firstMatch(rules, id) {
  for (const rule of rules) if (new RegExp(rule.match, 'i').test(id)) return rule;
  return null;
}
const samePrice = (a, b) => !!a && !!b && ['input', 'output', 'cacheRead', 'cacheWrite'].every(k => round(a[k]) === round(b[k]));
const relative = (a, b) => (a === 0 && b === 0 ? 0 : Math.abs(a - b) / Math.max(a, b));
const isPaid = id => !/free/.test(id);

/** 核心：合并出新的知识库和变更报告。纯函数，方便测试。 */
function build({ manual, current, litellm, openrouter, today }) {
  const source = fromLiteLLM(litellm);
  const cross = openrouter ? fromOpenRouter(openrouter) : new Map();
  const previous = new Map((current?.prices || []).filter(r => r.auto).map(r => [r.auto, r]));
  const fallbackRules = [...manual.pinned, ...manual.fallback];
  const report = { added: [], changed: [], kept: [], disputed: [], skipped: [], review: false, reasons: [] };
  const auto = new Map();

  for (const [id, row] of [...source].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (isPaid(id) && row.input === 0 && row.output === 0) { report.skipped.push({ id, why: '来源给出 0 价' }); continue; }
    const rule = { match: patternOf(id), input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, note: `自动：${id}（LiteLLM）`, auto: id };
    const old = previous.get(id);
    const other = cross.get(norm(id));
    if (other && (relative(other.input, row.input) > DISPUTE || relative(other.output, row.output) > DISPUTE)) {
      // 两个来源对不上：先不用，保留原来的（没有就走兜底）
      report.disputed.push({ id, litellm: { input: row.input, output: row.output }, openrouter: other });
      if (old) auto.set(id, old);
      continue;
    }
    if (old) {
      if (!samePrice(old, rule)) {
        const big = ['input', 'output'].some(k => relative(old[k], rule[k]) > BIG_CHANGE);
        report.changed.push({ id, from: pick(old), to: pick(rule), big });
      }
      auto.set(id, rule);
      continue;
    }
    // 兜底规则算出来一样就不用单独加一条
    if (samePrice(firstMatch(fallbackRules, id), rule)) continue;
    report.added.push({ id, to: pick(rule), fallback: pick(firstMatch(fallbackRules, id)) });
    auto.set(id, rule);
  }
  // 来源里没了的：原样保留，不自动删
  for (const [id, old] of previous) if (!auto.has(id) && !samePrice(firstMatch(fallbackRules, id), old)) { auto.set(id, old); report.kept.push(id); }

  if (report.changed.some(c => c.big)) report.reasons.push('有单价变化超过 50%');
  if (report.added.length > MAX_NEW) report.reasons.push(`一次新增 ${report.added.length} 条（超过 ${MAX_NEW}）`);
  report.review = report.reasons.length > 0;

  // 更具体（更长）的 id 排前面；锚定了整串，顺序只影响可读性
  const autoRules = [...auto.values()].sort((a, b) => b.auto.length - a.auto.length || a.auto.localeCompare(b.auto));
  const body = { prices: [...manual.pinned, ...autoRules, ...manual.fallback], aliases: manual.aliases, capabilities: manual.capabilities };
  const unchanged = current && JSON.stringify({ prices: current.prices, aliases: current.aliases, capabilities: current.capabilities }) === JSON.stringify(body);
  let version = current?.version || '';
  if (!unchanged) {
    const day = today.slice(0, 10).replace(/-/g, '.');
    const n = version.startsWith(day) ? Number(version.split('.')[3] || 0) + 1 : 0;
    version = n ? `${day}.${n}` : day;
    if (current?.version && compare(version, current.version) <= 0) version = `${day}.${Number(current.version.split('.')[3] || 0) + 1}`;
  }
  const knowledge = {
    schema: 1,
    version,
    updatedAt: unchanged ? current.updatedAt : today,
    notes: '自动生成，不要手改：改 knowledge/manual.json。' + manual.notes,
    ...body,
  };
  return { knowledge, report, changed: !unchanged };
}
function pick(r) { return r ? { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite } : null; }
function compare(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

/** 和软件里 parseKnowledge 一样的约束：不合格就不发布（老版本软件会把不合格的规则丢掉）。 */
function validate(k) {
  const errors = [];
  if (k.schema !== 1 || !/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(k.version)) errors.push('schema / version 不对');
  if (!Array.isArray(k.prices) || !k.prices.length || k.prices.length > 1000) errors.push('prices 数量不对');
  for (const r of k.prices || []) {
    if (typeof r.match !== 'string' || r.match.length > 200) errors.push('规则太长：' + r.match);
    try { new RegExp(r.match, 'i'); } catch { errors.push('正则编译不过：' + r.match); }
    for (const f of ['input', 'output', 'cacheRead', 'cacheWrite']) if (!(typeof r[f] === 'number' && Number.isFinite(r[f]) && r[f] >= 0)) errors.push(`${r.match} 的 ${f} 不对`);
  }
  for (const a of k.aliases || []) { try { new RegExp(a.match, 'i'); } catch { errors.push('别名正则编译不过'); } }
  return errors;
}

function markdown({ knowledge, report, changed }) {
  const money = p => (p ? `$${p.input} / $${p.output}（缓存读 $${p.cacheRead}，写 ${p.cacheWrite ? '$' + p.cacheWrite : '按输入价'}）` : '—');
  const lines = [`## 模型知识库自动更新 ${knowledge.version}`, '', changed ? '' : '没有变化。'];
  if (report.review) lines.push(`> ⚠️ 需要人工确认：${report.reasons.join('；')}`, '');
  if (report.added.length) lines.push(`### 新增 ${report.added.length} 个型号`, '', '| 型号 | 新单价（输入 / 输出，每百万 token） | 原来按兜底 |', '|---|---|---|', ...report.added.map(a => `| \`${a.id}\` | ${money(a.to)} | ${money(a.fallback)} |`), '');
  if (report.changed.length) lines.push('### 调价', '', '| 型号 | 原来 | 现在 |', '|---|---|---|', ...report.changed.map(c => `| \`${c.id}\`${c.big ? ' ⚠️' : ''} | ${money(c.from)} | ${money(c.to)} |`), '');
  if (report.disputed.length) lines.push('### 和 OpenRouter 对不上（先不用，保留原价格）', '', ...report.disputed.map(d => `- \`${d.id}\`：LiteLLM $${d.litellm.input} / $${d.litellm.output}，OpenRouter $${d.openrouter.input} / $${d.openrouter.output}`), '');
  if (report.kept.length) lines.push(`### 来源里没有了、按原价保留：${report.kept.map(id => '`' + id + '`').join('、')}`, '');
  if (report.skipped.length) lines.push(`### 跳过：${report.skipped.map(s => '`' + s.id + '`（' + s.why + '）').join('、')}`, '');
  lines.push('数据来源：[LiteLLM](https://github.com/BerriAI/litellm) 公开价格表，[OpenRouter](https://openrouter.ai/models) 交叉核对。');
  return lines.join('\n');
}

async function load(file, url) {
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch(url, { headers: { 'User-Agent': 'TokenPulse-knowledge-bot' }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url} 返回 ${res.status}`);
  return res.json();
}

async function main(argv) {
  const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = arg('--dir') || path.join(ROOT, 'knowledge');
  const manual = JSON.parse(fs.readFileSync(path.join(dir, 'manual.json'), 'utf8'));
  const currentFile = path.join(dir, 'models.json');
  const current = fs.existsSync(currentFile) ? JSON.parse(fs.readFileSync(currentFile, 'utf8')) : null;
  const litellm = await load(arg('--litellm'), LITELLM_URL);
  let openrouter = null;
  try { openrouter = await load(arg('--openrouter'), OPENROUTER_URL); } catch (error) { console.warn('OpenRouter 读取失败，跳过交叉核对：' + error.message); }
  const result = build({ manual, current, litellm, openrouter, today: arg('--today') || new Date().toISOString() });
  const errors = validate(result.knowledge);
  if (errors.length) { console.error('生成的知识库不合格，没有写入：\n' + errors.slice(0, 20).join('\n')); process.exitCode = 1; return; }
  const text = markdown(result);
  console.log(text);
  if (arg('--report')) fs.writeFileSync(arg('--report'), text + '\n');
  if (argv.includes('--write') && result.changed) fs.writeFileSync(currentFile, JSON.stringify(result.knowledge, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed}\nreview=${result.report.review}\nversion=${result.knowledge.version}\n`);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { build, validate, fromLiteLLM, fromOpenRouter, patternOf, markdown };
