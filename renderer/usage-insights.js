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
  const view = { metric: 'tokens', modelSort: 'tokens', year: 'recent', yearMetric: 'tokens' };
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
    group.addEventListener('click', event => { const b = event.target.closest(`[data-${attr}]`); if (b && b.dataset[prop] !== value) { value = b.dataset[prop]; onPick(value); } });
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

  /*
   * 全年活跃度（0.3.38，仿 tokens.ci / GitHub 的贡献图）：一格一天、一列一周（周一在上），颜色越深用得越多。
   * 不跟页面的时间范围走——就是要看一整年里哪天最努力；工具筛选照样生效。数据是快照里按天的全部账（current.usage）。
   * 深浅分五档：没用是空格，有用量的日子按四分位分四档，个别特别多的日子不会把其余的都压成最浅。
   * 点某一天，整页的时间范围就切到那一天。
   */
  const YEAR_METRICS = [['tokens', 'Tokens'], ['costUsd', '费用'], ['requests', '请求']];
  const DAY_MS = 86_400_000;
  function yearPanel() {
    const rows = (current?.usage || []).filter(row => state.source === 'all' || row.source === state.source);
    const byDay = new Map();
    for (const row of rows) {
      const day = byDay.get(row.day) ?? { tokens: 0, costUsd: 0, requests: 0, sources: {} };
      day.tokens += row.tokens || 0; day.costUsd += row.costUsd || 0; day.requests += row.requests || 0;
      day.sources[row.source] = (day.sources[row.source] || 0) + (row.tokens || 0);
      byDay.set(row.day, day);
    }
    const today = D.dayKey(current?.now || Date.now());
    const years = [...new Set([...byDay.keys()].map(day => day.slice(0, 4)))].sort().reverse();
    if (view.year !== 'recent' && !years.includes(view.year)) view.year = 'recent';
    // 范围：最近一年 = 今天往前 52 周（从那周的周一开始）；选了某一年 = 那年 1 月 1 日到 12 月 31 日（今年到今天为止）
    const at = key => new Date(key + 'T00:00:00');
    let start, end;
    if (view.year === 'recent') { end = at(today); start = new Date(end); start.setDate(start.getDate() - 364); }
    else { start = at(`${view.year}-01-01`); end = view.year === today.slice(0, 4) ? at(today) : at(`${view.year}-12-31`); }
    const first = new Date(start); first.setDate(first.getDate() - ((first.getDay() + 6) % 7));
    const metric = view.yearMetric, f = fmt(metric);
    const days = [];
    for (let d = new Date(first); d <= end; d.setDate(d.getDate() + 1)) {
      const key = D.dayKey(d.getTime());
      days.push({ key, inRange: d >= start, ...(byDay.get(key) ?? { tokens: 0, costUsd: 0, requests: 0, sources: {} }) });
    }
    const shown = days.filter(d => d.inRange);
    const active = shown.filter(d => d[metric] > 0);
    const sorted = active.map(d => d[metric]).sort((a, b) => a - b);
    const cut = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] : 0;
    const steps = [cut(0.25), cut(0.5), cut(0.75)];
    const level = value => !value ? 0 : value >= sorted.at(-1) ? 4 : value <= steps[0] ? 1 : value <= steps[1] ? 2 : value <= steps[2] ? 3 : 4;
    const best = active.reduce((top, d) => (!top || d[metric] > top[metric] ? d : top), null);
    let streak = 0, run = 0;
    for (const d of shown) { run = d.requests > 0 || d.tokens > 0 ? run + 1 : 0; streak = Math.max(streak, run); }
    const total = shown.reduce((sum, d) => sum + d[metric], 0);
    const longDate = key => at(key).toLocaleDateString(dateLocale(), { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
    const picked = state.days === 'custom' && state.from && state.from === state.to ? state.from : '';

    // 格子：按列（一周一列）排，月份标在这个月第一天所在的那一列上
    const grid = el('div', { class: 'year-grid', role: 'img', 'aria-label': `${view.year === 'recent' ? '最近一年' : view.year + ' 年'}每天的用量：${number(active.length)} 天有用量` });
    const months = el('div', { class: 'year-months', 'aria-hidden': 'true' });
    // 第一列是星期（按列排，前 7 个正好填满第一列），月份那行也空出这一列，格子才对得齐
    grid.append(...WEEK.map((name, i) => el('span', { class: 'year-day', 'aria-hidden': 'true', text: i % 2 === 0 ? name : '' })));
    months.append(el('span'));
    const weeks = Math.ceil(days.length / 7);
    paint(grid, { '--weeks': String(weeks) }); paint(months, { '--weeks': String(weeks) });
    // 月份：每月 1 号所在的列，加上范围开头那个不完整的月；开头那个离下个月太近（不到 3 列）就不写，免得叠在一起
    const labels = [];
    days.forEach((d, i) => { if (d.inRange && (d.key.endsWith('-01') || !labels.length)) labels.push({ column: Math.floor(i / 7) + 1, key: d.key }); });
    if (labels.length > 1 && labels[1].column - labels[0].column < 3) labels.shift();
    for (const { column, key } of labels) months.append(paint(el('span', { text: at(key).toLocaleDateString(dateLocale(), { month: 'short' }) }), { gridColumn: `${column + 1} / span 3` }));
    days.forEach(d => {
      if (!d.inRange) { grid.append(el('i', { class: 'year-cell out', 'aria-hidden': 'true' })); return; }
      const cell = el('i', { class: `year-cell l${level(d[metric])}` + (d.key === picked ? ' picked' : '') + (d.key === today ? ' today' : ''), 'data-day': d.key });
      const top = Object.entries(d.sources).sort((a, b) => b[1] - a[1])[0];
      const text = d.requests || d.tokens
        ? `${longDate(d.key)}\n${tokens(d.tokens)} Tokens · ${money(d.costUsd)} · ${number(d.requests)} 次请求${top && Object.keys(d.sources).length > 1 ? `\n用得最多：${top[0]}` : ''}\n点一下只看这一天`
        : `${longDate(d.key)}\n没有用量`;
      cell.addEventListener('pointermove', e => tipAt(text, e.clientX, e.clientY));
      cell.addEventListener('pointerleave', () => { $('tip').hidden = true; });
      if (d.requests || d.tokens) cell.addEventListener('click', () => { $('tip').hidden = true; applyRange('custom', d.key, d.key); });
      grid.append(cell);
    });
    const yearSelect = el('select', { class: 'year-select', 'aria-label': '看哪一年' }, [
      el('option', { value: 'recent', text: '最近一年', selected: view.year === 'recent' ? '' : null }),
      ...years.map(y => el('option', { value: y, text: `${y} 年`, selected: view.year === y ? '' : null })),
    ]);
    yearSelect.addEventListener('change', () => { view.year = yearSelect.value; draw(lastAnalysis, false); });
    const scale = el('div', { class: 'year-scale', 'aria-hidden': 'true' }, [el('span', { text: '少' }), ...[0, 1, 2, 3, 4].map(l => el('i', { class: `year-cell l${l}` })), el('span', { text: '多' })]);
    const plainDate = d => d.toLocaleDateString(dateLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
    const range = `${plainDate(start)} – ${plainDate(end)}`;
    return el('article', { class: 'panel insight-panel year-panel' }, [
      el('div', { class: 'panel-heading' }, [
        el('div', {}, [
          el('h2', {}, ['全年活跃度 ', yearSelect]),
          el('p', { text: '每一格是一天，颜色越深用得越多。不跟上面选的时间范围走，工具筛选照样生效；点某一天，整页就只看那一天。' }),
        ]),
        el('div', { class: 'year-head-side' }, [
          seg(YEAR_METRICS, metric, 'year-metric', value => { view.yearMetric = value; draw(lastAnalysis, false); }),
          el('div', { class: 'year-count' }, [el('b', { text: `${number(active.length)} 天有用量` }), el('small', { text: range })]),
        ]),
      ]),
      el('div', { class: 'year-scroll' }, [el('div', { class: 'year-body' }, [
        months,
        grid,
      ])]),
      el('div', { class: 'year-foot' }, [
        el('div', { class: 'insight-summary' }, [
          el('span', {}, ['合计 ', el('b', { text: f(total) })]),
          el('span', {}, ['最努力的一天 ', el('b', { text: best ? `${best.key} · ${f(best[metric])}` : '—' })]),
          el('span', {}, ['最长连续 ', el('b', { text: `${number(streak)} 天` })]),
        ]),
        scale,
      ]),
    ]);
  }

  /*
   * 模型速度走势（0.3.39）：经过 TokenPulse 的请求（透明转发、本地路由的号池和第三方供应商）量到的每秒 Token 数 / 首字延迟，画成折线。
   * 一条线 = 工具 + 型号 + 快速模式 + 思考等级 + 经由：同一个型号不同思考等级每秒 Token 数差不多、首字差很多，不同中转站也不一样。
   * 记录永久保存；不跟页面上面的时间范围走，自己选 24 小时 / 7 天 / 30 天 / 全部。线多了默认只画次数最多的 6 条，点图例开关。
   */
  const SPEED_RANGES = [['1', '24 小时'], ['7', '7 天'], ['30', '30 天'], ['0', '全部']];
  const SPEED_METRICS = [['speed', '速度'], ['first', '首字']];
  const LINE_COLORS = ['#2f7de1', '#e0683a', '#14a37f', '#9b5de5', '#d19a00', '#e0457b', '#0ea5a4', '#7a9a2e', '#8d6e63', '#5c6bc0', '#c2185b', '#00838f'];
  const APP_SOURCE = { claude: 'Claude Code', codex: 'Codex CLI', grok: 'Grok Build' };
  const DEFAULT_LINES = 6;
  const speedView = { range: '0', metric: 'speed', app: 'all', hidden: new Set(), picked: new Set(), data: null, key: '', at: 0, loading: false, error: false };
  const lineKey = line => [line.app, line.model, line.fast ? 'fast' : '', line.effort, line.via].join('|');
  const lineName = line => line.model + (line.fast ? ' · 快速' : '') + (line.effort ? ` · ${line.effort}` : '');
  const lineVia = line => line.via || '官方登录（透明转发）';
  const secondsText = ms => (ms >= 10000 ? Math.round(ms / 1000) : Math.round(ms / 100) / 10) + ' 秒';
  let speedBody = null;
  let speedRequest = 0;
  function loadSpeedLines(force = false) {
    if ((!force && speedView.loading && speedView.loadingRange === speedView.range) || (!force && speedView.key === speedView.range && Date.now() - speedView.at < 60_000)) return;
    const request = ++speedRequest;
    speedView.loading = true;
    const range = speedView.range;
    speedView.loadingRange = range;
    speedView.error = false;
    syncSpeedState();
    Promise.resolve(api.passSpeedSeries?.(Number(range))).then(data => { if (request !== speedRequest) return; if (data) speedView.data = data; speedView.error = !data; })
      .catch(() => { if (request === speedRequest) speedView.error = true; })
      .finally(() => {
        if (request !== speedRequest) return;
        speedView.loading = false; speedView.key = range; speedView.at = Date.now();
        // 请求失败时仍保留原图；成功时一次换上新图，不经过加载占位。
        const draw = () => speedView.error && speedView.data ? syncSpeedState() : fillSpeed();
        typeof keepScroll === "function" ? keepScroll(draw) : draw();
      });
  }
  function speedPanel() {
    speedBody = el('div', { class: 'speed-lines-body' });
    const metricSeg = seg(SPEED_METRICS, speedView.metric, 'speed-metric', value => { speedView.metric = value; fillSpeed(true); });
    const rangeSeg = seg(SPEED_RANGES, speedView.range, 'speed-range', value => { speedView.range = value; loadSpeedLines(true); syncSpeedState(true); });
    const retry = el('button', { type: 'button', class: 'text-btn', 'data-action': 'speed-lines-retry', text: '重试', hidden: '' });
    retry.addEventListener('click', () => loadSpeedLines(true));
    const panel = el('article', { class: 'panel insight-panel speed-lines-panel' }, [
      el('div', { class: 'panel-heading' }, [
        el('div', {}, [el('h2', { text: '模型速度走势' }), el('p', { text: '经过 TokenPulse 的请求（透明转发、号池、第三方供应商）量到的速度。同一个型号用不同的思考等级、经不同的供应商分开一条线；记录永久保存，不跟上面的时间范围走。' })]),
        el('div', { class: 'speed-lines-tools' }, [metricSeg, rangeSeg]),
      ]),
      el('div', { class: 'speed-lines-status', role: 'status' }, [el('span'), retry]),
      speedBody,
    ]);
    loadSpeedLines();
    // 有缓存就当场画好再交出去：不然每次整页重画时这一块先缩成「正在读取…」，下面的内容会跳一下
    fillSpeed(false, true);
    // 折线按画的那一刻的宽度算坐标：窗口宽度变了重画一次，不然会被等比缩小、两边留白
    const body = speedBody;
    let drawnWidth = 0;
    const resize = new ResizeObserver(() => {
      if (!body.isConnected) { resize.disconnect(); return; }
      const width = body.clientWidth;
      if (width && Math.abs(width - drawnWidth) > 2) { drawnWidth = width; speedView.width = width; fillSpeed(); }
    });
    resize.observe(body);
    return panel;
  }
  function syncSpeedState(resync = false) {
    const body = speedBody, panel = body?.closest('.speed-lines-panel');
    if (!panel) return;
    if (resync) for (const group of panel.querySelectorAll('.seg')) { for (const b of group.querySelectorAll('button')) { const on = b.dataset.speedMetric === speedView.metric || b.dataset.speedRange === speedView.range; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); } syncSeg(group); }
    body.setAttribute('aria-busy', String(speedView.loading));
    panel.querySelector('.speed-lines-status span').textContent = speedView.loading && speedView.data ? '正在读取所选范围，暂显示上次结果。' : speedView.error && speedView.data ? '读取所选范围失败，仍显示上次结果。' : '';
    panel.querySelector('[data-action=speed-lines-retry]').hidden = !speedView.error;
  }
  function fillSpeed(resync = false, detached = false) {
    const body = speedBody;
    if (!body || (!detached && !body.isConnected)) return;
    syncSpeedState(resync);
    const data = speedView.data;
    if (!data) { body.replaceChildren(empty(speedView.error ? '速度记录读取失败，请重试。' : '正在读取…')); return; }
    const apps = [...new Set(data.lines.map(line => line.app))];
    if (speedView.app !== 'all' && !apps.includes(speedView.app)) speedView.app = 'all';
    const first = speedView.metric === 'first';
    const sampleCount = item => (first ? item.firstCount : item.speedCount) ?? item.count;
    const all = data.lines.filter(line => (speedView.app === 'all' || line.app === speedView.app) && (first ? line.firstTokenMs != null : line.tokensPerSec != null)).sort((a, b) => sampleCount(b) - sampleCount(a) || b.lastAt - a.lastAt);
    if (!all.length) {
      const open = el('button', { type: 'button', class: 'btn', text: '去打开透明转发' });
      open.addEventListener('click', () => { navigate('providers'); window.PulseProviders?.open('pass'); });
      body.replaceChildren(el('div', { class: 'empty speed-empty' }, [el('p', { text: '这段时间还没有量到速度。在供应商页打开「透明转发」，或者用本地路由（号池、第三方供应商），用一会儿这里就有走势。' }), open]));
      return;
    }
    // 显示哪几条：用户点过的按用户的；没点过的，次数最多的前几条
    const visible = all.filter((line, i) => !speedView.hidden.has(lineKey(line)) && (i < DEFAULT_LINES || speedView.picked.has(lineKey(line))));
    const colorOfLine = new Map(all.map((line, i) => [lineKey(line), LINE_COLORS[i % LINE_COLORS.length]]));
    const valueOf = bucket => first ? (bucket.firstTokenMs == null ? null : bucket.firstTokenMs / 1000) : bucket.tokensPerSec;
    const unitText = value => first ? secondsText(value * 1000) : `${value} Token/秒`;

    // 折线
    const chartHost = el('div', { class: 'chart speed-lines-chart' });
    const w = Math.max(360, body.clientWidth || speedView.width || 800), h = 280, left = 58, right = 16, top = 14, bottom = 30;
    const end = data.from + Math.max(1, Math.ceil((data.to - data.from) / data.bucketMs)) * data.bucketMs;
    const xOf = at => left + Math.min(1, Math.max(0, (at + data.bucketMs / 2 - data.from) / (end - data.from))) * (w - left - right);
    const peak = visible.reduce((max, line) => line.buckets.reduce((value, bucket) => Math.max(value, valueOf(bucket) ?? 0), max), 0);
    const max = niceCeil(peak * 1.08);
    const yOf = value => top + (1 - value / max) * (h - top - bottom);
    const node = svg('svg', { viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': first ? '各模型的首字延迟走势' : '各模型的速度走势' });
    for (const g of [0, 0.25, 0.5, 0.75, 1]) {
      const yy = yOf(max * g);
      node.append(svg('line', { class: 'grid', x1: left, x2: w - right, y1: yy, y2: yy }));
      const label = svg('text', { class: 'axis', x: left - 8, y: yy + 4, 'text-anchor': 'end' });
      label.textContent = first ? `${Math.round(max * g * 10) / 10}s` : String(Math.round(max * g));
      node.append(label);
    }
    const stamp = at => {
      const day = new Date(at), locale = dateLocale();
      if (data.bucketMs <= 3600000) return day.toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
      const text = day.toLocaleDateString(locale, { year: day.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', month: 'numeric', day: 'numeric' });
      return data.bucketMs > 86400000 ? `${text} 起的一周` : text;
    };
    // 横轴：开头、中间、结尾几个日期
    const ticks = 5;
    for (let i = 0; i < ticks; i++) {
      const at = data.from + (end - data.from) * i / (ticks - 1) - data.bucketMs / 2;
      const t = svg('text', { class: 'axis', x: xOf(at), y: h - 8, 'text-anchor': i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle' });
      t.textContent = i === ticks - 1 ? '现在' : stamp(Math.max(data.from, at));
      node.append(t);
    }
    for (const line of visible) {
      const color = colorOfLine.get(lineKey(line));
      const points = line.buckets.map(bucket => [bucket, valueOf(bucket)]).filter(([, v]) => v != null).map(([bucket, v]) => [xOf(bucket.at), yOf(v)]);
      if (points.length > 1) node.append(paint(svg('polyline', { class: 'speed-lines-line', points: points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ') }), { stroke: color }));
      if (points.length <= 60) for (const [x, y] of points) node.append(paint(svg('circle', { class: 'speed-lines-dot', cx: x.toFixed(1), cy: y.toFixed(1), r: 3 }), { fill: color }));
      else node.append(paint(svg('circle', { class: 'speed-lines-dot', cx: points.at(-1)[0].toFixed(1), cy: points.at(-1)[1].toFixed(1), r: 3 }), { fill: color }));
    }
    // 悬停：最近的那个时间点，列出每条线在那时的数字
    const cursor = svg('line', { class: 'speed-lines-cursor', x1: 0, x2: 0, y1: top, y2: h - bottom, visibility: 'hidden' });
    const hit = svg('rect', { class: 'insight-hit', x: left, y: top, width: w - left - right, height: h - top - bottom });
    const times = [...new Set(visible.flatMap(line => line.buckets.filter(bucket => valueOf(bucket) != null).map(bucket => bucket.at)))].sort((a, b) => a - b);
    hit.addEventListener('pointermove', event => {
      if (!times.length) return;
      const box = node.getBoundingClientRect(), x = (event.clientX - box.left) / box.width * w;
      let at = times[0];
      for (const t of times) if (Math.abs(xOf(t) - x) < Math.abs(xOf(at) - x)) at = t;
      cursor.setAttribute('x1', xOf(at)); cursor.setAttribute('x2', xOf(at)); cursor.setAttribute('visibility', 'visible');
      const rows = visible.map(line => [line, line.buckets.find(bucket => bucket.at === at)]).filter(([, bucket]) => bucket && valueOf(bucket) != null)
        .sort((a, b) => valueOf(b[1]) - valueOf(a[1]));
      tipAt([stamp(at), ...rows.map(([line, bucket]) => `${lineName(line)} · ${lineVia(line)}：${unitText(valueOf(bucket))} · ${number(sampleCount(bucket))} 次`)].join('\n'), event.clientX, event.clientY);
    });
    hit.addEventListener('pointerleave', () => { $('tip').hidden = true; cursor.setAttribute('visibility', 'hidden'); });
    node.append(cursor, hit);
    chartHost.append(node);

    // 图例：每条线一个开关，带整段时间的中位数
    const legendNode = el('div', { class: 'speed-lines-legend', role: 'group', 'aria-label': '显示哪些线' }, all.map(line => {
      const key = lineKey(line), on = visible.includes(line);
      const chip = el('button', { type: 'button', class: 'speed-lines-chip' + (on ? ' on' : ''), 'aria-pressed': String(on), 'data-line': key, title: `${lineVia(line)} · ${number(sampleCount(line))} 次` }, [
        paint(el('i', { class: 'speed-lines-swatch' }), { background: colorOfLine.get(key) }),
        miniLogo(APP_SOURCE[line.app] || line.app),
        el('span', { class: 'speed-lines-name', translate: 'no', text: lineName(line) }),
        el('small', { translate: line.via ? 'no' : null, text: lineVia(line) }),
        el('b', { translate: 'no', text: first ? (line.firstTokenMs == null ? '—' : secondsText(line.firstTokenMs)) : String(line.tokensPerSec) }),
      ]);
      chip.addEventListener('click', () => {
        if (on) { speedView.hidden.add(key); speedView.picked.delete(key); } else { speedView.hidden.delete(key); speedView.picked.add(key); }
        fillSpeed();
      });
      return chip;
    }));
    const appSelect = el('select', { class: 'speed-lines-app', 'aria-label': '只看哪个工具' }, [
      el('option', { value: 'all', text: '全部工具', selected: speedView.app === 'all' ? '' : null }),
      ...apps.map(app => el('option', { value: app, text: APP_SOURCE[app] || app, selected: speedView.app === app ? '' : null })),
    ]);
    appSelect.addEventListener('change', () => { speedView.app = appSelect.value; fillSpeed(); });
    const showAll = el('button', { type: 'button', class: 'text-btn', 'data-action': 'speed-lines-all', text: visible.length < all.length ? `全部显示（${all.length} 条）` : `只看前 ${Math.min(DEFAULT_LINES, all.length)} 条` });
    showAll.addEventListener('click', () => {
      speedView.hidden.clear(); speedView.picked.clear();
      if (visible.length < all.length) for (const line of all) speedView.picked.add(lineKey(line));
      fillSpeed();
    });
    body.replaceChildren(chartHost,
      el('div', { class: 'speed-lines-bar' }, [appSelect, el('span', { class: 'muted', text: `${number(visible.length)} / ${number(all.length)} 条线 · 图例里的数字是整段时间的中位数` }), showAll]),
      legendNode,
      el('p', { class: 'sample-caption', text: `${first ? '首字 = 从请求发出到回复里第一段内容（文字、思考或工具调用）出现。' : '速度 = 输出 Token ÷ 出字用的时间（含思考）。'}每个点是那段时间（${data.bucketMs <= 3600000 ? '一小时' : data.bucketMs > 86400000 ? '一周' : '一天'}）的中位数。思考等级高的，每秒 Token 数差不多，首字会慢很多。` }));
  }
  /** 纵轴上限取个整：37 → 40，140 → 150。 */
  function niceCeil(value) {
    if (!(value > 0)) return 1;
    const base = 10 ** Math.floor(Math.log10(value));
    return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(step => step * base).find(step => step >= value) || 10 * base;
  }

  let host = null, lastAnalysis = null;
  function draw(analysis, animate) {
    lastAnalysis = analysis;
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

    host.replaceChildren(yearPanel(), trendPanel, el('div', { class: 'insight-grid' }, [toolPanel, distPanel]), modelPanel, speedPanel());
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
  // 速度记录先在后台读好：打开用量明细时折线图直接画出来，不会读完才把下面的内容往下推
  setTimeout(() => loadSpeedLines(), 1500);
})();
