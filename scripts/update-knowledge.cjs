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
 * 0.3.12 起还有 effortUsage：同一型号不同思考等级每个任务的输出 token（Epoch AI 基准数据，CC BY 4.0），
 * 软件用它推算没用过的等级大约多耗多少 token；本机实测过的等级永远优先。
 *   --epoch <zip 或解压后的目录>                   用本地的 Epoch 数据代替网络（测试用）
 *
 * 自动规则的来源：LiteLLM 的公开价格表（Anthropic / OpenAI / xAI 的 Claude、GPT、o 系列、Codex、Grok），
 * 用 OpenRouter 的价格交叉核对。只在兜底规则给出的价格不一样时才加一条，文件保持精简。
 *
 * 安全规则：
 * - 和 OpenRouter 的价格差超过 25%：0.3.13 起**按 LiteLLM 的用**（优惠价这类 LiteLLM 更准），规则上记下 dispute（两边的价格），
 *   软件在型号旁标「标价不同」，用户知道估值为什么和别处不一样；
 * - 每次单价变化记下 changedAt 和 previous，软件在一段时间内标出来。previousFallback = true 表示 previous 是按型号家族估算的兜底价
 *   （官方价格没变，只是换成了这个型号自己的标价），软件标「改用实际标价」；没有这个标记的才是真的调价，标「刚降价 / 刚涨价」；
 * - manual.labels：手动给型号打标签（promo 优惠价、until 到期日、note），到期自动去掉；manual.pinned 的规则也可以带 until，到期不再生效；
 * - 已有的自动规则单价变化超过 50%，或一次新增超过 60 条：report.review = true，工作流开 PR 让人确认，而不是直接推 main；
 * 永远不自动删除规则（来源里消失的型号保留原价）；收费型号给出 0 价的不收；缓存读价缺失时按输入价算（不当成免费）。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const EPOCH_URL = 'https://epoch.ai/data/benchmark_data.zip';
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

/* ---------------- 思考等级的 token 消耗（Epoch AI） ---------------- */

/** 只读 zip 里的文件（中央目录 + 本地文件头；支持存储和 deflate），不引入依赖。 */
function unzip(buffer) {
  const files = new Map();
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('不是 zip 文件');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buffer.readUInt16LE(at + 10), size = buffer.readUInt32LE(at + 20);
    const nameLen = buffer.readUInt16LE(at + 28), extraLen = buffer.readUInt16LE(at + 30), commentLen = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, zlib.inflateRawSync(data));
  }
  return files;
}
function csv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c; }
    else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
const EFFORT_NAMES = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', 'extra high': 'xhigh', xhigh: 'xhigh', max: 'max' };
const effortOf = v => EFFORT_NAMES[String(v || '').trim().toLowerCase()] || null;
/** 「gpt-5.6-sol_high」「gpt-5.4-2026-03-05_xhigh」→ 型号 id（去掉等级和日期后缀）。 */
function modelOfVersion(version) {
  const base = String(version).trim().toLowerCase().replace(/_[a-z ]+$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '');
  return FAMILY.test(base) && /^[a-z0-9][a-z0-9._-]*$/.test(base) && base.length <= MAX_ID ? base : null;
}
const familyOf = id => (/^claude/.test(id) ? 'claude' : /^grok/.test(id) ? 'grok' : 'chatgpt');
const ANCHOR = 'medium';
const RATIO_DISPUTE = 2; // 两个基准同一型号的等级倍数差 2 倍以上：先不用

/** 从 Epoch 的数据包里算出每个型号各等级每个任务的输出 token，以及各家族相对 medium 的平均倍数。 */
function fromEpoch(files, today) {
  const read = name => { const f = [...files.keys()].find(k => k.endsWith(name)); return f ? csv(files.get(f).toString('utf8')) : []; };
  const collect = (rows, pick) => {
    const out = new Map();
    for (const r of rows) {
      const got = pick(r); if (!got) continue;
      const { id, effort, tokens } = got;
      if (!id || !effort || !(tokens > 0)) continue;
      const m = out.get(id) ?? {}; m[effort] = Math.round(tokens); out.set(id, m);
    }
    return out;
  };
  // DeepSWE：只用同一个 harness（mini-swe-agent），「平均输出 token」定义清楚（含推理），做主数据
  const deep = collect(read('deepswe_external.csv'), r => (r.Harness && r.Harness !== 'mini-swe-agent') ? null : { id: modelOfVersion(r['Model version']), effort: effortOf(r['Reasoning effort']), tokens: Number(r['Mean output tokens']) });
  // CursorBench：「每个任务的 token」口径没写明，只用来核对倍数 / 在 DeepSWE 没有的型号上补位
  const cursor = collect(read('cursorbench_external.csv'), r => ({ id: modelOfVersion(r['Model version']), effort: effortOf(r['Reasoning level']), tokens: Number(r['Tokens per task']) }));
  const models = {}, disputed = [];
  for (const id of [...new Set([...deep.keys(), ...cursor.keys()])].sort()) {
    const a = deep.get(id), b = cursor.get(id);
    const common = a && b ? Object.keys(a).filter(e => b[e]) : [];
    if (common.length >= 2) {
      const anchor = common.includes(ANCHOR) ? ANCHOR : common[0];
      const worst = Math.max(...common.map(e => { const x = a[e] / a[anchor], y = b[e] / b[anchor]; return Math.max(x / y, y / x); }));
      if (worst > RATIO_DISPUTE) { disputed.push({ id, factor: Math.round(worst * 100) / 100 }); continue; }
    }
    if (a && Object.keys(a).length >= 2) models[id] = { basis: 'DeepSWE', perTask: a };
    else if (b && Object.keys(b).length >= 2) models[id] = { basis: 'CursorBench', perTask: b };
  }
  // 家族平均：各型号「这一档 ÷ medium」的几何平均
  const families = {};
  for (const fam of ['claude', 'chatgpt', 'grok']) {
    const logs = {};
    for (const [id, m] of Object.entries(models)) {
      if (familyOf(id) !== fam || !m.perTask[ANCHOR]) continue;
      for (const [e, v] of Object.entries(m.perTask)) (logs[e] ??= []).push(Math.log(v / m.perTask[ANCHOR]));
    }
    const ratios = Object.fromEntries(Object.entries(logs).filter(([, list]) => list.length).map(([e, list]) => [e, Math.round(Math.exp(list.reduce((s, x) => s + x, 0) / list.length) * 1000) / 1000]));
    if (Object.keys(ratios).length >= 2) families[fam] = ratios;
  }
  return {
    usage: { source: 'Epoch AI Benchmarking Hub（CC BY 4.0）：DeepSWE（mini-swe-agent，平均输出 token）为主，CursorBench 核对', sourceUrl: 'https://epoch.ai/data/ai-benchmarking-dashboard', license: 'CC BY 4.0', anchor: ANCHOR, updatedAt: today.slice(0, 10), models, families },
    disputed,
  };
}

/** 核心：合并出新的知识库和变更报告。纯函数，方便测试。 */
function build({ manual, current, litellm, openrouter, epoch, today }) {
  const source = fromLiteLLM(litellm);
  const cross = openrouter ? fromOpenRouter(openrouter) : new Map();
  const previous = new Map((current?.prices || []).filter(r => r.auto).map(r => [r.auto, r]));
  const day = today.slice(0, 10);
  // 到期的手动规则不再生效（软件里也会按日期跳过，这里是为了文件干净）
  const live = r => !r.until || r.until >= day;
  const pinned = (manual.pinned || []).filter(live);
  const fallbackRules = [...pinned, ...manual.fallback];
  const report = { added: [], changed: [], kept: [], disputed: [], skipped: [], review: false, reasons: [], effort: { models: 0, changed: [], disputed: [], stale: false } };
  const auto = new Map();

  for (const [id, row] of [...source].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (isPaid(id) && row.input === 0 && row.output === 0) { report.skipped.push({ id, why: '来源给出 0 价' }); continue; }
    const rule = { match: patternOf(id), input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, note: `自动：${id}（LiteLLM）`, auto: id };
    const old = previous.get(id);
    const other = cross.get(norm(id));
    if (other && (relative(other.input, row.input) > DISPUTE || relative(other.output, row.output) > DISPUTE)) {
      // 两个来源对不上：按 LiteLLM 的用，记下 OpenRouter 的价格给界面标「标价不同」
      report.disputed.push({ id, litellm: { input: row.input, output: row.output }, openrouter: other });
      rule.dispute = { openrouter: { input: other.input, output: other.output } };
    }
    const fallback = firstMatch(fallbackRules, id);
    if (old) {
      if (!samePrice(old, rule)) {
        const big = ['input', 'output'].some(k => relative(old[k], rule[k]) > BIG_CHANGE);
        report.changed.push({ id, from: pick(old), to: pick(rule), big });
        rule.changedAt = day; rule.previous = pick(old);
      } else if (old.changedAt) {
        rule.changedAt = old.changedAt; rule.previous = old.previous;
        // 0.3.16 之前没有这个标记：previous 和兜底价一样的，就是从兜底换过来的
        if (old.previousFallback || (fallback && old.previous && samePrice(fallback, old.previous))) rule.previousFallback = true;
      }
      else if (fallback && !samePrice(fallback, rule)) {
        // 0.3.11 从家族兜底换成逐个型号价格时没记日期：补上（按那一版知识库的日期）
        rule.changedAt = String(current?.updatedAt || day).slice(0, 10); rule.previous = pick(fallback); rule.previousFallback = true;
      }
      auto.set(id, rule);
      continue;
    }
    // 兜底规则算出来一样就不用单独加一条
    if (samePrice(fallback, rule)) continue;
    report.added.push({ id, to: pick(rule), fallback: pick(fallback) });
    if (fallback) { rule.changedAt = day; rule.previous = pick(fallback); rule.previousFallback = true; }
    auto.set(id, rule);
  }
  // 来源里没了的：原样保留，不自动删
  for (const [id, old] of previous) if (!auto.has(id) && !samePrice(firstMatch(fallbackRules, id), old)) { auto.set(id, old); report.kept.push(id); }

  // 思考等级消耗：Epoch 取不到就沿用上一版（不因为它让整个更新失败）；同一型号某一档变化超过 50% 要人确认
  let effortUsage = current?.effortUsage;
  if (epoch) {
    const next = fromEpoch(epoch, today);
    report.effort.disputed = next.disputed;
    for (const [id, m] of Object.entries(next.usage.models)) {
      const old = current?.effortUsage?.models?.[id]?.perTask;
      if (!old) continue;
      for (const [e, v] of Object.entries(m.perTask)) if (old[e] && relative(old[e], v) > BIG_CHANGE) report.effort.changed.push({ id, effort: e, from: old[e], to: v });
    }
    // 数据没变就不动日期，免得每天都「有变化」
    const same = current?.effortUsage && JSON.stringify({ ...current.effortUsage, updatedAt: '' }) === JSON.stringify({ ...next.usage, updatedAt: '' });
    effortUsage = same ? current.effortUsage : next.usage;
  } else report.effort.stale = true;
  report.effort.models = Object.keys(effortUsage?.models || {}).length;
  if (report.effort.changed.length) report.reasons.push('有思考等级消耗变化超过 50%');
  if (report.changed.some(c => c.big)) report.reasons.push('有单价变化超过 50%');
  if (report.added.length > MAX_NEW) report.reasons.push(`一次新增 ${report.added.length} 条（超过 ${MAX_NEW}）`);
  report.review = report.reasons.length > 0;

  // 更具体（更长）的 id 排前面；锚定了整串，顺序只影响可读性
  const autoRules = [...auto.values()].sort((a, b) => b.auto.length - a.auto.length || a.auto.localeCompare(b.auto));
  const labels = (manual.labels || []).filter(live);
  const body = { prices: [...pinned, ...autoRules, ...manual.fallback], aliases: manual.aliases, capabilities: manual.capabilities, ...(effortUsage ? { effortUsage } : {}), ...(labels.length ? { labels } : {}) };
  const unchanged = current && JSON.stringify({ prices: current.prices, aliases: current.aliases, capabilities: current.capabilities, ...(current.effortUsage ? { effortUsage: current.effortUsage } : {}), ...(current.labels?.length ? { labels: current.labels } : {}) }) === JSON.stringify(body);
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
  for (const l of k.labels || []) if (typeof l.model !== 'string' || !l.model || l.model.length > MAX_ID || (l.until && !/^\d{4}-\d{2}-\d{2}$/.test(l.until))) errors.push('标签不对：' + JSON.stringify(l));
  for (const [id, m] of Object.entries(k.effortUsage?.models || {})) {
    if (id.length > MAX_ID || !m?.perTask || Object.values(m.perTask).some(v => !(Number.isFinite(v) && v > 0))) errors.push('思考等级消耗数据不对：' + id);
  }
  return errors;
}

function markdown({ knowledge, report, changed }) {
  const money = p => (p ? `$${p.input} / $${p.output}（缓存读 $${p.cacheRead}，写 ${p.cacheWrite ? '$' + p.cacheWrite : '按输入价'}）` : '—');
  const lines = [`## 模型知识库自动更新 ${knowledge.version}`, '', changed ? '' : '没有变化。'];
  if (report.review) lines.push(`> ⚠️ 需要人工确认：${report.reasons.join('；')}`, '');
  if (report.added.length) lines.push(`### 新增 ${report.added.length} 个型号`, '', '| 型号 | 新单价（输入 / 输出，每百万 token） | 原来按兜底 |', '|---|---|---|', ...report.added.map(a => `| \`${a.id}\` | ${money(a.to)} | ${money(a.fallback)} |`), '');
  if (report.changed.length) lines.push('### 调价', '', '| 型号 | 原来 | 现在 |', '|---|---|---|', ...report.changed.map(c => `| \`${c.id}\`${c.big ? ' ⚠️' : ''} | ${money(c.from)} | ${money(c.to)} |`), '');
  if (report.disputed.length) lines.push('### 和 OpenRouter 对不上（按 LiteLLM 的价格用，软件里标「标价不同」）', '', ...report.disputed.map(d => `- \`${d.id}\`：LiteLLM $${d.litellm.input} / $${d.litellm.output}，OpenRouter $${d.openrouter.input} / $${d.openrouter.output}`), '');
  if (report.kept.length) lines.push(`### 来源里没有了、按原价保留：${report.kept.map(id => '`' + id + '`').join('、')}`, '');
  if (report.skipped.length) lines.push(`### 跳过：${report.skipped.map(s => '`' + s.id + '`（' + s.why + '）').join('、')}`, '');
  const ef = report.effort;
  if (ef) {
    lines.push(`### 思考等级消耗（Epoch AI）：${ef.models} 个型号${ef.stale ? '（这次没取到 Epoch 数据，沿用上一版）' : ''}`, '');
    if (ef.changed.length) lines.push('变化超过 50%：', ...ef.changed.map(c => `- \`${c.id}\` ${c.effort}：${c.from} → ${c.to} token / 任务`), '');
    if (ef.disputed.length) lines.push(`两个基准倍数差太多、先不用：${ef.disputed.map(d => '`' + d.id + '`（' + d.factor + '×）').join('、')}`, '');
  }
  lines.push('数据来源：[LiteLLM](https://github.com/BerriAI/litellm) 公开价格表，[OpenRouter](https://openrouter.ai/models) 交叉核对；思考等级消耗来自 [Epoch AI](https://epoch.ai/data/ai-benchmarking-dashboard)（CC BY 4.0）。');
  return lines.join('\n');
}

async function loadEpoch(target) {
  if (target && fs.statSync(target).isDirectory()) return new Map(fs.readdirSync(target).filter(n => n.endsWith('.csv')).map(n => [n, fs.readFileSync(path.join(target, n))]));
  const buffer = target ? fs.readFileSync(target) : Buffer.from(await (await fetch(EPOCH_URL, { headers: { 'User-Agent': 'TokenPulse-knowledge-bot' }, signal: AbortSignal.timeout(120_000) })).arrayBuffer());
  return unzip(buffer);
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
  let epoch = null;
  try { epoch = await loadEpoch(arg('--epoch')); } catch (error) { console.warn('Epoch AI 数据读取失败，思考等级消耗沿用上一版：' + error.message); }
  const result = build({ manual, current, litellm, openrouter, epoch, today: arg('--today') || new Date().toISOString() });
  const errors = validate(result.knowledge);
  if (errors.length) { console.error('生成的知识库不合格，没有写入：\n' + errors.slice(0, 20).join('\n')); process.exitCode = 1; return; }
  const text = markdown(result);
  console.log(text);
  if (arg('--report')) fs.writeFileSync(arg('--report'), text + '\n');
  if (argv.includes('--write') && result.changed) fs.writeFileSync(currentFile, JSON.stringify(result.knowledge, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed}\nreview=${result.report.review}\nversion=${result.knowledge.version}\n`);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { build, validate, fromLiteLLM, fromOpenRouter, fromEpoch, unzip, csv, patternOf, markdown };
