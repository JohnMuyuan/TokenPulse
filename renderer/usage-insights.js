'use strict';
/*
 * 用量明细页的「用量分析」：分工具的用量趋势、工具排行、模型排行（完整，不截断）、使用时段分布。
 *
 * 数据跟着用量明细页的时间范围和筛选走，和上面的统计卡片、下面的明细表是同一份：
 * - 排行、按天趋势：analysis.selected（按「天 × 工具 × 型号」汇总的行；有筛选时来自逐条流水，没有时来自按天的账）；
 * - 今天 / 一天：analysis.hourly（逐条流水按小时汇总，每小时带各工具的分量）；
 * - 时段分布（一天中的几点、星期几）：只能从逐条流水按小时算 —— 有筛选时用 analysis.hours，没有时这里自己按范围查一次。
 *   逐条流水从 0.3.1 开始记，更早的用量只有按天的账，分布图里说明起算日期。
 *
 * 总览页的工具分布只列前几个、模型排行只列前 5；这里全部列出来。
 * 依赖 app.js 的全局函数（el、svg、icon、tokens、money、number、amount、cnApprox、miniLogo、tipAt、date、dateLocale、state、current、api）。
 */
(() => {
  const D = window.PulseData;
  const METRICS = [['tokens', 'Tokens'], ['costUsd', '费用'], ['requests', '请求']];
  const MODEL_SORT = [['tokens', 'Tokens'], ['costUsd', '费用'], ['requests', '请求']];
  const view = { metric: 'tokens', modelSort: 'tokens' };
  // 工具的颜色：三家官方用品牌色，其余（CC Switch 导入的 OpenCode 等）按出现顺序轮流取
  const BRAND = { 'Claude Code': 'var(--claude)', 'Codex CLI': 'var(--openai)', 'Grok Build': 'var(--grok)' };
  const PALETTE = ['#6d7fd6', '#c9832f', '#8b5cf6', '#0ea5a4', '#e05a8a', '#65a30d', '#d946ef'];
  const colorCache = new Map();
  function colorOf(source) {
    if (BRAND[source]) return BRAND[source];
    if (!colorCache.has(source)) colorCache.set(source, PALETTE[colorCache.size % PALETTE.length]);
    return colorCache.get(source);
  }
  const fmt = metric => metric === 'costUsd' ? money : metric === 'requests' ? (v => number(v)) : tokens;
  /** 页面的 CSP 不允许 style 属性，颜色 / 宽度一律通过 CSSOM 设（SVG 的 fill 属性也认不了 var()）。 */
  const paint = (node, props) => { for (const [k, v] of Object.entries(props)) k.startsWith('--') ? node.style.setProperty(k, v) : (node.style[k] = v); return node; };
  const share = (value, total) => total > 0 ? value / total * 100 : 0;
  const pct = v => v >= 10 ? v.toFixed(1) + '%' : v >= 0.1 ? v.toFixed(2) + '%' : v > 0 ? '<0.1%' : '0%';
  const WEEK = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  /* ---------------- 数据 ---------------- */

  /** 趋势图的桶：今天 / 一天按小时；两个月以内按天；两年以内按周（周一开始）；再长按月。每个桶带各工具的分量。 */
  function buckets(analysis) {
    if (analysis.hourly) {
      return { unit: '小时', rows: analysis.hourly.map(row => ({ key: row.hour, label: `${new Date(row.hour).getHours()}:00`, title: date(row.hour), tokens: row.tokens, costUsd: row.costUsd, requests: row.requests, sources: row.sources || {} })) };
    }
    const days = analysis.daily;
    const unit = days.length <= 62 ? '天' : days.length <= 730 ? '周' : '月';
    const keyOf = day => {
      if (unit === '天') return day;
      if (unit === '月') return day.slice(0, 7);
      const d = new Date(day + 'T00:00:00'); const back = (d.getDay() + 6) % 7; d.setDate(d.getDate() - back);
      return D.dayKey(d.getTime());
    };
    const map = new Map();
    for (const row of days) { const key = keyOf(row.day); if (!map.has(key)) map.set(key, { key, first: row.day, last: row.day, tokens: 0, costUsd: 0, requests: 0, sources: {} }); map.get(key).last = row.day; }
    for (const row of analysis.selected) {
      const bucket = map.get(keyOf(row.day)); if (!bucket) continue;
      bucket.tokens += row.tokens; bucket.costUsd += row.costUsd; bucket.requests += row.requests;
      const s = (bucket.sources[row.source] ??= { tokens: 0, costUsd: 0, requests: 0 });
      s.tokens += row.tokens; s.costUsd += row.costUsd; s.requests += row.requests;
    }
    const rows = [...map.values()].map(b => ({ ...b,
      label: unit === '天' ? b.first.slice(5) : unit === '月' ? b.first.slice(2, 7).replace('-', '/') : b.first.slice(5),
      title: unit === '天' ? b.first : unit === '月' ? b.first.slice(0, 7) : `${b.first} ~ ${b.last}` }));
    return { unit, rows };
  }

  /** 工具 / 模型的完整排行。 */
  function rankings(analysis) {
    const bySource = new Map(), byModel = new Map();
    for (const row of analysis.selected) {
      const s = bySource.get(row.source) ?? { source: row.source, tokens: 0, costUsd: 0, requests: 0, input: 0, output: 0, cacheRead: 0, models: new Set(), unpriced: 0 };
      s.tokens += row.tokens; s.costUsd += row.costUsd; s.requests += row.requests; s.input += row.input; s.output += row.output; s.cacheRead += row.cacheRead; s.models.add(row.model);
      if (row.priced === false) s.unpriced += row.requests;
      bySource.set(row.source, s);
      const key = `${row.source}\u0000${row.model}`;
      const m = byModel.get(key) ?? { source: row.source, model: row.model, tokens: 0, costUsd: 0, requests: 0, input: 0, output: 0, cacheRead: 0, reasoning: 0, days: new Set(), unpriced: 0 };
      m.tokens += row.tokens; m.costUsd += row.costUsd; m.requests += row.requests; m.input += row.input; m.output += row.output; m.cacheRead += row.cacheRead; m.reasoning += row.reasoning || 0; m.days.add(row.day);
      if (row.priced === false) m.unpriced += row.requests;
      byModel.set(key, m);
    }
    return { sources: [...bySource.values()].sort((a, b) => b.tokens - a.tokens), models: [...byModel.values()] };
  }

  /*
   * 没有筛选时，分布图要的逐小时数据在这里按范围查一次（worker 里汇总逐条流水）。
   * 按「范围 + 工具 + 快照时间」缓存；新快照的结果回来之前先用同一范围上一份，免得每分钟闪一下。
   */
  const hourCache = new Map();
  let lastHours = null;
  function rangeHours(analysis) {
    if (analysis.hours) return { hours: analysis.hours, loading: false };
    const key = `${state.from}|${state.to}|${state.since ?? ''}|${state.source}|${current.now}`;
    const scope = `${state.from}|${state.to}|${state.since ?? ''}|${state.source}`;
    if (!hourCache.has(key)) {
      hourCache.set(key, null);
      api.requests({ from: state.from, to: state.to, since: state.since, source: state.source, status: 'all', search: '', sort: 'time', page: 0, pageSize: 1, aggregate: true })
        .then(page => {
          hourCache.set(key, { hours: page.aggregate.hours, firstAt: page.firstAt });
          lastHours = { scope, hours: page.aggregate.hours, firstAt: page.firstAt };
          while (hourCache.size > 6) hourCache.delete(hourCache.keys().next().value);
          if (state.page === 'usage' && current) render(current);
        })
        .catch(() => { hourCache.set(key, { error: true }); });
    }
    const hit = hourCache.get(key) ?? (lastHours?.scope === scope ? lastHours : null);
    return hit ? { hours: hit.hours || [], firstAt: hit.firstAt, error: hit.error, loading: false } : { hours: [], loading: true };
  }

  /* ---------------- 图 ---------------- */

  function legend(sources, metric) {
    const total = sources.reduce((n, s) => n + s[metric], 0);
    return el('div', { class: 'insight-legend' }, sources.map(s => el('span', { class: 'insight-legend-item' }, [
      paint(el('i'), { background: colorOf(s.source) }), el('span', { text: s.source }), el('b', { text: pct(share(s[metric], total)) })
    ])));
  }

  /** 分工具的堆叠柱。 */
  function trendChart(host, data, order, metric, animate) {
    host.replaceChildren();
    const rows = data.rows;
    if (!rows.length || rows.every(r => !r[metric])) { host.append(empty('这段时间没有用量。')); return; }
    const w = Math.max(360, host.clientWidth || 800), h = 260, left = 58, right = 12, top = 14, bottom = 28;
    const max = Math.max(...rows.map(r => r[metric])) * 1.1 || 1;
    const slot = (w - left - right) / rows.length, bar = Math.max(2, Math.min(34, slot * 0.68));
    const y = v => top + (1 - v / max) * (h - top - bottom);
    const node = svg('svg', { viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': '分工具的用量趋势' });
    const f = fmt(metric);
    for (const g of [0, .5, 1]) {
      const yy = y(max * g); node.append(svg('line', { class: 'grid', x1: left, x2: w - right, y1: yy, y2: yy }));
      const label = svg('text', { class: 'axis', x: left - 8, y: yy + 4, 'text-anchor': 'end' }); label.textContent = g ? f(max * g) : '0'; node.append(label);
    }
    const tickEvery = Math.max(1, Math.ceil(rows.length / Math.floor((w - left - right) / 54)));
    rows.forEach((row, i) => {
      const x = left + i * slot + (slot - bar) / 2;
      let base = h - bottom;
      const lines = [row.title, `${f(row[metric])} ${METRICS.find(m => m[0] === metric)[1] === 'Tokens' ? 'Tokens' : ''}`.trim()];
      for (const source of order) {
        const v = row.sources[source]?.[metric] || 0; if (!v) continue;
        const height = Math.max(0.5, (h - top - bottom) * v / max);
        base -= height;
        node.append(paint(svg('rect', { class: 'insight-seg', x, y: base, width: bar, height }), { fill: colorOf(source) }));
        lines.push(`${source}：${f(v)}（${pct(share(v, row[metric]))}）`);
      }
      // 各工具加起来比合计少（比如没归到工具的），剩下的画成灰色
      const rest = row[metric] - order.reduce((n, s) => n + (row.sources[s]?.[metric] || 0), 0);
      if (rest > row[metric] * 0.001) { const height = (h - top - bottom) * rest / max; base -= height; node.append(svg('rect', { class: 'insight-seg rest', x, y: base, width: bar, height })); }
      const hit = svg('rect', { class: 'insight-hit', x: left + i * slot, y: top, width: slot, height: h - top - bottom, tabindex: 0, 'aria-label': lines.join('，') });
      const text = lines.join('\n');
      hit.addEventListener('pointermove', e => tipAt(text, e.clientX, e.clientY));
      hit.addEventListener('pointerleave', () => { $('tip').hidden = true; });
      hit.addEventListener('focus', () => { const b = hit.getBoundingClientRect(); tipAt(text, b.x + b.width / 2, b.y); });
      hit.addEventListener('blur', () => { $('tip').hidden = true; });
      node.append(hit);
      if (i % tickEvery === 0 || i === rows.length - 1 && rows.length <= 40) { const t = svg('text', { class: 'axis', x: x + bar / 2, y: h - 8, 'text-anchor': 'middle' }); t.textContent = row.label; node.append(t); }
    });
    host.append(node);
    playChart(host, animate);
  }

  /** 一天中的 24 个小时：这段时间里每个钟点合计用了多少。 */
  function hourOfDayChart(host, hours, metric) {
    host.replaceChildren();
    const totals = Array.from({ length: 24 }, () => ({ tokens: 0, costUsd: 0, requests: 0 }));
    for (const row of hours) { const hr = new Date(row.hour).getHours(); totals[hr].tokens += row.tokens; totals[hr].costUsd += row.costUsd; totals[hr].requests += row.requests; }
    if (totals.every(t => !t[metric])) { host.append(empty('这段时间没有逐条请求记录。')); return totals; }
    const w = Math.max(320, host.clientWidth || 520), h = 170, left = 8, right = 8, top = 8, bottom = 22;
    const max = Math.max(...totals.map(t => t[metric])) || 1, slot = (w - left - right) / 24, bar = slot * 0.7;
    const peak = totals.reduce((best, t, i) => t[metric] > totals[best][metric] ? i : best, 0);
    const node = svg('svg', { viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': '一天中各时段的用量' });
    const f = fmt(metric), all = totals.reduce((n, t) => n + t[metric], 0);
    totals.forEach((t, i) => {
      const height = Math.max(t[metric] ? 1.5 : 0, (h - top - bottom) * t[metric] / max);
      const rect = svg('rect', { class: 'insight-hour' + (i === peak ? ' peak' : ''), x: left + i * slot + (slot - bar) / 2, y: h - bottom - height, width: bar, height, rx: Math.min(3, bar / 2), tabindex: 0 });
      const text = `${i}:00 – ${i}:59\n${f(t[metric])}（${pct(share(t[metric], all))}）\n${number(t.requests)} 次请求`;
      rect.setAttribute('aria-label', text.replaceAll('\n', '，'));
      rect.addEventListener('pointermove', e => tipAt(text, e.clientX, e.clientY));
      rect.addEventListener('pointerleave', () => { $('tip').hidden = true; });
      node.append(rect);
      if (i % 3 === 0) { const tick = svg('text', { class: 'axis', x: left + i * slot + slot / 2, y: h - 6, 'text-anchor': 'middle' }); tick.textContent = `${i}`; node.append(tick); }
    });
    host.append(node);
    return totals;
  }

  /** 星期 × 时段热力图。颜色深浅按这一格的用量占最大一格的比例。 */
  function heatmap(host, hours, metric) {
    host.replaceChildren();
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ tokens: 0, costUsd: 0, requests: 0 })));
    for (const row of hours) { const d = new Date(row.hour); const cell = grid[(d.getDay() + 6) % 7][d.getHours()]; cell.tokens += row.tokens; cell.costUsd += row.costUsd; cell.requests += row.requests; }
    const max = Math.max(...grid.flat().map(c => c[metric]));
    if (!max) { host.append(empty('这段时间没有逐条请求记录。')); return; }
    const f = fmt(metric);
    const table = el('div', { class: 'insight-heat', role: 'img', 'aria-label': '按星期和时段的用量热力图' });
    grid.forEach((row, wd) => {
      table.append(el('span', { class: 'insight-heat-day', text: WEEK[wd] }));
      row.forEach((cell, hr) => {
        const level = cell[metric] ? Math.max(0.08, cell[metric] / max) : 0;
        const box = paint(el('i', { class: 'insight-heat-cell' + (level ? '' : ' zero') }), { '--v': level.toFixed(3) });
        const text = `${WEEK[wd]} ${hr}:00\n${f(cell[metric])} · ${number(cell.requests)} 次请求`;
        box.addEventListener('pointermove', e => tipAt(text, e.clientX, e.clientY));
        box.addEventListener('pointerleave', () => { $('tip').hidden = true; });
        table.append(box);
      });
    });
    table.append(el('span'), ...Array.from({ length: 24 }, (_, hr) => el('span', { class: 'insight-heat-hour', text: hr % 3 === 0 ? String(hr) : '' })));
    host.append(table);
  }

  /* ---------------- 面板 ---------------- */

  function seg(options, value, attr, onPick) {
    const group = el('div', { class: 'seg compact', role: 'group' }, [el('span', { class: 'seg-thumb', 'aria-hidden': 'true' }),
      ...options.map(([id, label]) => el('button', { type: 'button', [`data-${attr}`]: id, class: value === id ? 'on' : null, 'aria-pressed': String(value === id), text: label }))]);
    // data-insight-sort 在 dataset 里叫 insightSort
    const prop = attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    group.addEventListener('click', event => { const b = event.target.closest(`[data-${attr}]`); if (b && b.dataset[prop] !== value) onPick(b.dataset[prop]); });
    return group;
  }

  function sourceRanking(list, total) {
    if (!list.length) return empty('这段时间没有用量。');
    const max = Math.max(...list.map(s => s.tokens)) || 1;
    return el('div', { class: 'insight-rank' }, list.map((s, i) => el('div', { class: 'insight-rank-row' }, [
      el('span', { class: 'insight-rank-no', text: String(i + 1).padStart(2, '0') }),
      sourceLogo(s.source),
      el('div', { class: 'insight-rank-main' }, [
        el('div', { class: 'insight-rank-head' }, [el('b', { text: s.source }), el('span', { class: 'insight-rank-share', text: pct(share(s.tokens, total.tokens)) })]),
        el('div', { class: 'insight-bar' }, [paint(el('i'), { width: `${Math.max(1, s.tokens / max * 100).toFixed(2)}%`, background: colorOf(s.source) })]),
        el('div', { class: 'insight-rank-meta' }, [
          el('span', { title: number(s.tokens) }, [...qty(s.tokens), ' Tokens']),
          el('span', { text: `${number(s.requests)} 次请求` }),
          el('span', { text: s.requests ? `单次 ${tokens(s.tokens / s.requests)}` : '' }),
          el('span', { text: s.unpriced ? `${money(s.costUsd)} · ${number(s.unpriced)} 次未定价` : money(s.costUsd) }),
          el('span', { text: `${number(s.models.size)} 个型号` })
        ])
      ])
    ])));
  }

  function modelTable(models, total) {
    if (!models.length) return empty('这段时间没有用量。');
    const key = view.modelSort;
    const list = [...models].sort((a, b) => b[key] - a[key] || b.tokens - a.tokens);
    const max = Math.max(...list.map(m => m[key])) || 1;
    const head = ['#', '型号', '请求', '输入', '输出', '缓存读取', 'Tokens', '参考费用', '占比'];
    return el('div', { class: 'table-scroll insight-models' }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, head.map((text, i) => el('th', { class: i >= 2 ? 'n' : '', text })))]),
      el('tbody', {}, list.map((m, i) => el('tr', {}, [
        el('td', { class: 'insight-no', text: String(i + 1) }),
        // 单元格本身不能 display:flex（会把表格的行线弄断），里面再包一层
        el('td', {}, [el('div', { class: 'insight-model' }, [miniLogo(m.source), el('div', {}, [el('b', { text: m.model, title: m.model, translate: 'no' }), el('small', { text: `${m.source} · ${number(m.days.size)} 天有用量` })])])]),
        el('td', { class: 'n', title: number(m.requests), text: number(m.requests) }),
        el('td', { class: 'n', title: number(m.input) }, qty(m.input)),
        el('td', { class: 'n', title: number(m.output) }, qty(m.output)),
        el('td', { class: 'n', title: number(m.cacheRead) }, [...qty(m.cacheRead), m.input ? el('small', { class: 'insight-sub', text: `占输入 ${pct(m.cacheRead / m.input * 100)}` }) : null]),
        el('td', { class: 'n token-strong', title: number(m.tokens) }, qty(m.tokens)),
        el('td', { class: 'n', text: m.unpriced === m.requests && m.requests ? '未定价' : money(m.costUsd) }),
        el('td', { class: 'n' }, [el('div', { class: 'insight-share' }, [el('div', { class: 'insight-bar small' }, [paint(el('i'), { width: `${Math.max(1, m[key] / max * 100).toFixed(2)}%`, background: colorOf(m.source) })]), el('span', { text: pct(share(m[key], total[key])) })])])
      ])))
    ])]);
  }

  let host = null;
  function draw(analysis, animate) {
    host ??= document.getElementById('usage-insights');
    if (!host) return;
    if (analysis.loading || analysis.error) {
      host.replaceChildren(el('article', { class: 'panel insight-panel' }, [el('p', { class: 'muted', text: analysis.error ? '用量分析读取失败，请重试。' : '正在读取用量分析…' })]));
      return;
    }
    const total = analysis.total;
    const { sources, models } = rankings(analysis);
    const order = sources.map(s => s.source);
    const trend = buckets(analysis);
    const redraw = () => draw(analysis, false);

    // 1. 分工具的趋势
    const trendHost = el('div', { class: 'chart insight-trend' });
    const peak = trend.rows.reduce((best, r) => (r[view.metric] > (best?.[view.metric] ?? -1) ? r : best), null);
    const active = trend.rows.filter(r => r.requests > 0).length;
    const f = fmt(view.metric);
    const trendPanel = el('article', { class: 'panel insight-panel' }, [
      el('div', { class: 'panel-heading' }, [
        el('div', {}, [el('h2', { text: '用量趋势 · 按工具' }), el('p', { text: `按${trend.unit}汇总，每根柱子按工具分色；悬停看每个工具的数量和占比` })]),
        seg(METRICS, view.metric, 'insight-metric', value => { view.metric = value; redraw(); })
      ]),
      legend(sources, view.metric),
      trendHost,
      el('div', { class: 'insight-summary' }, [
        el('span', {}, ['合计 ', el('b', { text: f(total[view.metric]) })]),
        el('span', {}, [`每${trend.unit}平均 `, el('b', { text: f(total[view.metric] / (trend.rows.length || 1)) })]),
        el('span', {}, [`有用量的${trend.unit} `, el('b', { text: `${number(active)} / ${number(trend.rows.length)}` })]),
        el('span', {}, [`最高的一${trend.unit === '小时' ? '小时' : trend.unit} `, el('b', { text: peak?.[view.metric] ? `${peak.title} · ${f(peak[view.metric])}` : '—' })])
      ])
    ]);

    // 2. 工具排行 + 3. 分布
    const toolPanel = el('article', { class: 'panel insight-panel' }, [
      el('div', { class: 'panel-heading' }, [el('div', {}, [el('h2', {}, ['工具排行 ', el('span', { class: 'section-tag', text: `${number(sources.length)} 个工具` })]), el('p', { text: '按 Tokens 排序，占比是占这段时间全部 Tokens 的比例' })])]),
      sourceRanking(sources, total)
    ]);
    const hourData = rangeHours(analysis);
    const hodHost = el('div', { class: 'chart insight-hod' }), heatHost = el('div', { class: 'insight-heat-host' });
    const distNote = el('p', { class: 'sample-caption' });
    const distPanel = el('article', { class: 'panel insight-panel' }, [
      el('div', { class: 'panel-heading' }, [el('div', {}, [el('h2', { text: '使用时段分布' }), el('p', { text: '这段时间里，一天中各个钟点、一周中各天分别用了多少（本机时间）' })])]),
      el('h3', { class: 'insight-sub-title', text: '一天中的时段' }), hodHost,
      el('h3', { class: 'insight-sub-title', text: '星期 × 时段' }), heatHost,
      distNote
    ]);

    // 4. 模型排行
    const modelPanel = el('article', { class: 'panel insight-panel' }, [
      el('div', { class: 'panel-heading' }, [
        el('div', {}, [el('h2', {}, ['模型排行 ', el('span', { class: 'section-tag', text: `${number(models.length)} 个型号` })]), el('p', { text: '全部型号，不截断；同一型号在不同工具里分开统计' })]),
        seg(MODEL_SORT, view.modelSort, 'insight-sort', value => { view.modelSort = value; redraw(); })
      ]),
      modelTable(models, total)
    ]);

    host.replaceChildren(trendPanel, el('div', { class: 'insight-grid' }, [toolPanel, distPanel]), modelPanel);
    for (const group of host.querySelectorAll('.seg')) syncSeg(group);
    trendChart(trendHost, trend, order, view.metric, animate);
    if (hourData.loading) { hodHost.append(empty('正在读取逐条请求记录…')); distNote.textContent = ''; }
    else if (hourData.error) { hodHost.append(empty('逐条请求记录读取失败。')); }
    else {
      const totals = hourOfDayChart(hodHost, hourData.hours, view.metric);
      heatmap(heatHost, hourData.hours, view.metric);
      const busiest = totals.reduce((best, t, i) => t[view.metric] > totals[best][view.metric] ? i : best, 0);
      const since = hourData.firstAt ? `逐条请求记录从 ${new Date(hourData.firstAt).toLocaleDateString(dateLocale())} 开始，更早的用量只有按天的账，不在分布图里。` : '';
      distNote.textContent = `${totals[busiest][view.metric] ? `用得最多的是 ${busiest}:00 这个钟点。` : ''}${since}`;
    }
  }
  window.PulseInsights = { render: draw };
})();
