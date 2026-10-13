'use strict';
/*
 * 分享卡片（0.3.51）：主进程在一个看不见的窗口里打开这一页，调 renderShareCard(kind, data, options) 画好，再截图成 PNG。
 * 数据来自 src/core/share-report.ts（月报 monthReport、里程碑 milestoneState），这里只管排版。
 * 卡片上不放邮箱、账号名、项目路径，只有用量数字、工具名和模型名。
 */
(() => {
  const SVG = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'text') node.textContent = value; else if (key === 'class') node.className = value; else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) if (child != null && child !== false) node.append(child);
    return node;
  };
  const svg = (tag, attrs = {}) => { const node = document.createElementNS(SVG, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); return node; };
  const text = (attrs, value) => { const node = svg('text', attrs); node.textContent = value; return node; };
  const n = value => Math.round(value).toLocaleString('en-US');
  let english = false;
  /** 「12.3 亿」「4,860 万」；不到一万照写。 */
  const big = value => english ? value >= 1e9 ? [(value / 1e9).toFixed(1), 'B'] : value >= 1e6 ? [(value / 1e6).toFixed(1), 'M'] : value >= 1e3 ? [(value / 1e3).toFixed(1), 'K'] : [n(value), ''] : value >= 1e8 ? [(value / 1e8).toFixed(value >= 1e10 ? 0 : 1), '亿'] : value >= 1e4 ? [(value / 1e4).toFixed(value >= 1e6 ? 0 : 1), '万'] : [n(value), ''];
  const bigText = value => big(value).join(' ').trim();
  const usd = value => '$' + n(value);
  const day = key => { const [, m, d] = key.split('-').map(Number); return english ? new Date(key + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : `${m} 月 ${d} 日`; };
  const stamp = () => { const d = new Date(); return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`; };
  const TOOL_COLOR = { 'Claude Code': 'var(--claude)', 'Codex CLI': 'var(--openai)', 'Grok Build': 'var(--grok)', 'DeepSeek Harness': 'var(--deepseek)' };
  const TOOL_NAME = { 'Claude Code': 'Claude', 'Codex CLI': 'Codex', 'Grok Build': 'Grok', 'DeepSeek Harness': 'DeepSeek' };
  const toolColor = source => TOOL_COLOR[source] || 'var(--faint)';

  function brand(tags) {
    const mark = svg('svg', { viewBox: '0 0 24 24' });
    mark.append(svg('circle', { class: 't', cx: 12, cy: 12, r: 7.5 }), svg('path', { class: 'p', d: 'M7.9 5.7A7.5 7.5 0 0 1 17.6 17' }),
      svg('rect', { class: 'b', x: 7.8, y: 13.2, width: 2, height: 3.8, rx: 1 }), svg('rect', { class: 'b', x: 11, y: 10.8, width: 2, height: 6.2, rx: 1 }), svg('rect', { class: 'b', x: 14.2, y: 8, width: 2, height: 9, rx: 1 }), svg('circle', { class: 'n', cx: 17.6, cy: 17, r: 1.5 }));
    return el('div', { class: 'head' }, [
      el('div', { class: 'brand' }, [el('span', { class: 'brand-mark' }, [mark]), el('div', {}, [el('b', { text: 'TokenPulse' }), el('small', { text: 'Your AI usage, at a glance' })])]),
      el('div', { class: 'tags' }, tags.map(tag => el('span', { class: 'tag', text: tag }))),
    ]);
  }
  const foot = right => el('div', { class: 'foot' }, [el('span', {}, ['由 ', el('b', { text: 'TokenPulse' }), ' 生成 · 数据只在你的电脑上']), el('span', { text: right })]);
  const stat = (label, value, unit, sub, cls = '') => el('div', { class: 'hs ' + cls }, [el('span', { text: label }), el('b', { class: 'num' }, [value, unit ? el('small', { text: unit }) : null]), sub ? el('p', {}, sub) : null]);

  /* ---------------- 月报 ---------------- */
  function month(r, options) {
    const [value, unit] = big(r.tokens);
    const change = r.previousTokens ? (r.tokens / r.previousTokens - 1) * 100 : null;
    const [, m] = r.month.split('-').map(Number);
    const prevMonth = m === 1 ? 12 : m - 1;
    const lede = el('p', { class: 'lede' }, [
      r.analogy ? analogyText(r.analogy) : `一共 ${n(r.requests)} 次请求`,
      change != null ? english ? [`, ${Math.abs(change).toFixed(0)}% ${change >= 0 ? 'more' : 'less'} than `, new Date(2026, prevMonth - 1, 1).toLocaleDateString('en-US', { month: 'long' })] : ['，比 ', `${prevMonth} 月`, change >= 0 ? '多了 ' : '少了 ', el('b', { text: `${Math.abs(change).toFixed(0)}%` }), change >= 0 ? ' 📈' : ''] : null,
      r.analogy ? el('span', { class: 'rough', text: '（粗略换算）' }) : null,
    ].flat());
    const sub = Number(options?.subscriptionUsd) > 0 ? Number(options.subscriptionUsd) : 0;
    const card = el('div', { class: 'share-card' }, [
      brand([english ? `${r.month} · Monthly report` : `${r.label} · 月报`]),
      el('p', { class: 'eyebrow', text: '这个月，你和 AI 一起用掉了' }),
      el('div', { class: 'big num' }, [value, el('small', { text: `${unit} Tokens`.trim() })]),
      lede,
      el('div', { class: 'hero-stats' }, [
        stat('按 API 标价算', usd(r.costUsd), '', sub ? [english ? `${usd(sub)}/month, value multiple ` : `订阅一个月 ${usd(sub)}，回本 `, el('b', { text: `${(r.costUsd / sub).toFixed(r.costUsd / sub >= 10 ? 0 : 1)}${english ? '×' : ' 倍'}` })] : '会话自报的或按官方标价估的', 'accent'),
        stat('请求次数', n(r.requests), english ? '' : '次', `每天平均 ${n(r.requests / r.days)} 次`),
        stat('活跃天数', String(r.activeDays), `/ ${r.days} 天`, `最长连续 ${r.longestStreak} 天`),
      ]),
      el('div', { class: 'row2' }, [calendarPanel(r), modelsPanel(r)]),
      el('div', { class: 'row3' }, [nightPanel(r), fastPanel(r), cachePanel(r)]),
      options.showNames && r.routes?.length ? el('p', { class: 'routes', text: (english ? 'Routes: ' : '经由：') + r.routes.join(' · '), translate: 'no' }) : null,
      foot(stamp()),
    ]);
    return card;
  }
  function calendarPanel(r) {
    const levels = ['#eef0f3', '#cfe7db', '#8fcbad', '#3fa57a', '#14855f'];
    const max = Math.max(1, ...r.daily.map(item => item.tokens));
    const first = (new Date(r.month + '-01T12:00:00').getDay() + 6) % 7;
    const cal = el('div', { class: 'cal' }, (english ? ['M', 'T', 'W', 'T', 'F', 'S', 'S'] : [...'一二三四五六日']).map(d => el('span', { class: 'dow', text: d })));
    for (let i = 0; i < first; i++) cal.append(el('i', { class: 'blank' }));
    for (const item of r.daily) {
      const level = item.tokens <= 0 ? 0 : Math.min(4, 1 + Math.floor(item.tokens / max * 3.999));
      const cell = el('i', { class: r.best?.day === item.day ? 'best' : '', title: item.day });
      cell.style.background = levels[level];
      cal.append(cell);
    }
    const scale = el('span', { class: 'scale' }, ['少', ...levels.map(color => { const i = el('i'); i.style.background = color; return i; }), '多']);
    return el('div', { class: 'panel' }, [
      el('div', { class: 'section-head' }, [el('h2', { text: '每天用了多少' }), el('span', { text: '颜色越深用得越多' })]),
      cal,
      el('div', { class: 'cal-legend' }, [el('span', { text: r.best ? `🏆 最拼的一天 ${day(r.best.day)} · ${bigText(r.best.tokens)} Tokens` : '' }), scale]),
    ]);
  }
  function modelsPanel(r) {
    const rows = r.models.map((item, i) => {
      const bar = el('span'); bar.style.width = `${Math.max(1.5, item.share * 100)}%`; bar.style.background = toolColor(item.source);
      return el('div', { class: 'model' }, [el('span', { class: 'rank', text: String(i + 1) }), el('div', { class: 'name' }, [el('b', { text: item.model }), el('small', { text: TOOL_NAME[item.source] || item.source }), el('div', { class: 'bar' }, [bar])]), el('span', { class: 'pct', text: `${(item.share * 100).toFixed(item.share >= 0.1 ? 0 : 1)}%` })]);
    });
    const tools = el('div', { class: 'tools' }, r.tools.slice(0, 4).map(item => { const dot = el('i', { class: 'dot' }); dot.style.background = toolColor(item.source); return el('span', {}, [dot, TOOL_NAME[item.source] || item.source, el('b', { text: `${(item.share * 100).toFixed(0)}%` })]); }));
    return el('div', { class: 'panel' }, [el('div', { class: 'section-head' }, [el('h2', { text: '最常用的模型' }), el('span', { text: '按 Tokens' })]), ...rows, tools]);
  }
  function nightPanel(r) {
    const max = Math.max(1, ...r.hours);
    const bars = el('div', { class: 'hours' }, r.hours.map((value, hour) => { const i = el('i', { class: hour >= 22 || hour < 6 ? 'night' : '' }); i.style.height = `${6 + value / max * 48}px`; return i; }));
    return el('div', { class: 'panel mini' }, [el('h3', { text: '🦉 夜猫子指数' }), el('b', { class: 'num', text: r.nightShare == null ? '—' : `${(r.nightShare * 100).toFixed(0)}%` }), el('p', { text: '的 Tokens 发生在晚上 10 点到早上 6 点' }), bars]);
  }
  function fastPanel(r) {
    const top = r.fastest[0];
    if (!top) return el('div', { class: 'panel mini' }, [el('h3', { text: '⚡ 最快的模型' }), el('b', { text: '—' }), el('p', { text: '这个月还没有量到速度。打开透明转发，或者用本地路由，就能量到。' })]);
    const max = Math.max(...r.fastest.map(item => item.tokensPerSec));
    const rows = el('div', { class: 'speeds' }, r.fastest.map((item, i) => { const bar = el('i'); bar.style.width = `${item.tokensPerSec / max * 100}%`; bar.style.background = ['var(--accent)', 'var(--week)', 'var(--claude)'][i]; return el('div', {}, [el('span', { text: item.model + (item.effort ? ` ${item.effort}` : '') }), bar, el('b', { class: 'num', text: String(item.tokensPerSec) })]); }));
    return el('div', { class: 'panel mini' }, [el('h3', { text: '⚡ 最快的模型' }), el('b', { class: 'num' }, [String(top.tokensPerSec), el('small', { text: ' Token/秒' })]), el('p', { text: top.model + (top.effort ? ` ${top.effort}` : '') + (top.firstTokenMs ? ` · 首字 ${(top.firstTokenMs / 1000).toFixed(1)} 秒` : '') }), rows]);
  }
  function cachePanel(r) {
    const share = r.input > 0 ? r.cacheRead / r.input : 0;
    const used = el('i'); used.style.width = `${share * 100}%`;
    const fresh = el('i', { class: 'fresh' }); fresh.style.width = `${(1 - share) * 100}%`;
    const legendDot = color => { const d = el('i', { class: 'dot' }); d.style.background = color; return d; };
    return el('div', { class: 'panel mini' }, [el('h3', { text: '♻️ 缓存帮你省下' }), el('b', { class: 'num', text: usd(r.cacheSavingsUsd) }), el('p', { text: `${(share * 100).toFixed(0)}% 的输入来自缓存读取` }), el('div', { class: 'cache' }, [used, fresh]),
      el('div', { class: 'cache-legend' }, [el('span', {}, [legendDot('var(--accent)'), `缓存读取 ${bigText(r.cacheRead)}`]), el('span', {}, [legendDot('#cfe7db'), `新内容 ${bigText(Math.max(0, r.input - r.cacheRead))}`])])]);
  }

  /* ---------------- 里程碑 ---------------- */
  /** 奖章中间的大字和下面的小字。 */
  function medalText(m) {
    if (m.group === 'tokens' || m.group === 'day') { const [value, unit] = big(m.target); return [`${value}${unit ? ' ' + unit : ''}`, m.group === 'day' ? '单日 Tokens' : 'Tokens']; }
    if (m.group === 'streak') return [`${m.target} 天`, '连续使用'];
    if (m.group === 'value') return [usd(m.target), 'API 价值'];
    return [bigText(m.target), '次请求'];
  }
  function milestone(state, options) {
    const chosen = state.list.find(item => item.id === options?.id && item.achievedAt) || [...state.list].filter(item => item.achievedAt).sort((a, b) => b.achievedAt.localeCompare(a.achievedAt))[0];
    if (!chosen) return el('div', { class: 'share-card ms' }, [brand(['里程碑']), el('h1', { text: '还没有达成里程碑' }), foot(stamp())]);
    const [mid, small] = medalText(chosen);
    const medal = el('div', { class: 'medal' }, [el('b', { class: 'num', text: mid }), el('small', { text: small })]);
    if (mid.length > 6) medal.querySelector('b').style.fontSize = '64px';
    const title = chosen.group === 'tokens' ? `累计用掉 ${mid} Tokens 🎉` : chosen.group === 'day' ? `一天用掉 ${mid} Tokens 🎉` : chosen.group === 'streak' ? `连续 ${chosen.target} 天都在用 AI 🎉` : chosen.group === 'value' ? `累计 API 价值突破 ${mid} 🎉` : `累计请求突破 ${mid} 次 🎉`;
    const since = state.firstDay ? (() => { const [y, m, d] = state.firstDay.split('-').map(Number); return `${y} 年 ${m} 月 ${d} 日`; })() : '';
    const lede = el('p', { class: 'lede' }, [state.analogy ? [analogyText(state.analogy), el('span', { class: 'rough', text: '（粗略换算）' }), el('br')] : null, since ? `从 ${since}第一条记录开始，用了 ` : '', since ? el('b', { text: `${state.days} 天` }) : null, since ? '。' : '',
      state.speedup ? ['最近 30 天的速度，是第一个月的 ', el('b', { text: `${state.speedup.toFixed(1)} 倍` }), '。'] : null].flat());
    const card = el('div', { class: 'share-card ms' }, [
      brand([`新里程碑 · ${chosen.achievedAt.replace(/-/g, '.')}`]),
      el('div', { class: 'burst' }, [rays(), medal]),
      el('h1', { text: title }),
      lede,
      el('div', { class: 'ms-stats' }, [
        stat('累计按 API 标价', usd(state.totals.costUsd), '', `累计 ${bigText(state.totals.tokens)} Tokens`),
        stat('累计请求', n(state.totals.requests), english ? '' : '次', `和 AI 说了 ${bigText(state.totals.requests)} 次话`),
        state.companion ? (() => { const node = stat('陪你最久的模型', state.companion.model, '', `用了 ${state.companion.days} 天，占 ${(state.companion.share * 100).toFixed(0)}%`); node.querySelector('b').classList.add('word'); return node; })() : stat('陪你最久的模型', '—', '', ''),
      ]),
      journeyPanel(state),
      el('div', { class: 'collection' }, state.list.filter(item => item.achievedAt || item.group === chosen.group).slice(0, 8).map(item => el('span', { class: 'coin' + (item.id === chosen.id ? ' new' : item.achievedAt ? '' : ' locked') }, [el('i', { text: item.icon }), item.label + (item.id === chosen.id ? ' · 刚解锁' : '')]))),
      foot(`已收集 ${state.list.filter(item => item.achievedAt).length} / ${state.list.length} 枚`),
    ]);
    return card;
  }
  function rays() {
    const node = svg('svg', { viewBox: '0 0 420 420', 'aria-hidden': 'true' });
    for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2, r1 = 160, r2 = i % 2 ? 196 : 206; node.append(svg('line', { x1: 210 + Math.cos(a) * r1, y1: 210 + Math.sin(a) * r1, x2: 210 + Math.cos(a) * r2, y2: 210 + Math.sin(a) * r2, stroke: i % 3 ? '#14855f' : '#d19a00', 'stroke-width': i % 2 ? 3 : 5, 'stroke-linecap': 'round', opacity: i % 2 ? .35 : .7 })); }
    node.append(svg('circle', { cx: 210, cy: 210, r: 150, fill: 'none', stroke: '#14855f22', 'stroke-width': 2 }));
    for (const [x, y, c, s] of [[70, 90, '#d19a00', 9], [350, 70, '#5f70c8', 7], [380, 300, '#d97757', 8], [40, 300, '#14855f', 6], [300, 380, '#d19a00', 6], [110, 380, '#5f70c8', 7]]) node.append(svg('rect', { x, y, width: s, height: s * 1.8, rx: 2, fill: c, transform: `rotate(${x % 60} ${x} ${y})`, opacity: .8 }));
    return node;
  }
  function journeyPanel(state) {
    const W = 960, H = 190, L = 50, R = 24, T = 22, B = 28;
    const points = state.cumulative;
    const chart = svg('svg', { viewBox: `0 0 ${W} ${H}` });
    if (points.length >= 2) {
      const t0 = Date.parse(points[0].day + 'T12:00:00'), t1 = Date.parse(points.at(-1).day + 'T12:00:00');
      const span = Math.max(1, t1 - t0) * 1.06;
      const max = Math.max(points.at(-1).tokens, state.next ? Math.min(state.next.target, points.at(-1).tokens * 1.15) : 0) * 1.08;
      const x = key => L + (Date.parse(key + 'T12:00:00') - t0) / span * (W - L - R), y = v => T + (1 - v / max) * (H - T - B);
      for (const g of [0, .25, .5, .75, 1]) { const v = max / 1.08 * g; chart.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: '#eef0f3' }), text({ x: L - 8, y: y(v) + 4, 'text-anchor': 'end', fill: '#9aa2ae', 'font-size': 11.5 }, bigText(v) || '0')); }
      const defs = svg('defs'); const grad = svg('linearGradient', { id: 'jg', x1: 0, x2: 0, y1: 0, y2: 1 }); grad.append(svg('stop', { offset: 0, 'stop-color': '#14855f', 'stop-opacity': .25 }), svg('stop', { offset: 1, 'stop-color': '#14855f', 'stop-opacity': 0 })); defs.append(grad); chart.append(defs);
      chart.append(svg('path', { d: `M${x(points[0].day)},${y(0)} ` + points.map(p => `L${x(p.day)},${y(p.tokens)}`).join(' ') + ` L${x(points.at(-1).day)},${y(0)} Z`, fill: 'url(#jg)' }));
      chart.append(svg('polyline', { points: points.map(p => `${x(p.day)},${y(p.tokens)}`).join(' '), fill: 'none', stroke: '#14855f', 'stroke-width': 3, 'stroke-linejoin': 'round' }));
      // 月份刻度：每个月 1 号
      const start = new Date(t0); start.setDate(1); start.setMonth(start.getMonth() + 1);
      for (let d = start; d.getTime() <= t1; d.setMonth(d.getMonth() + 1)) { const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; chart.append(text({ x: x(key), y: H - 8, 'text-anchor': 'middle', fill: '#9aa2ae', 'font-size': 11.5 }, `${d.getMonth() + 1}月`)); }
      // 累计 Tokens 的里程碑点
      const marks = state.list.filter(item => item.group === 'tokens' && item.achievedAt);
      marks.forEach((item, i) => {
        const last = i === marks.length - 1, at = points.find(p => p.day >= item.achievedAt) || points.at(-1);
        const [v, u] = big(item.target);
        chart.append(svg('circle', { cx: x(at.day), cy: y(at.tokens), r: last ? 8 : 5, fill: last ? '#d19a00' : '#fff', stroke: last ? '#fff' : '#14855f', 'stroke-width': 3 }));
        if (last || i >= marks.length - 3) chart.append(text({ x: x(at.day) - 10, y: y(at.tokens) - 10, 'text-anchor': 'end', fill: last ? '#b66d0d' : '#3f4652', 'font-size': 12.5, 'font-weight': 700 }, `${v} ${u}`.trim()));
      });
    }
    const next = state.next;
    const progress = next ? Math.min(100, state.totals.tokens / next.target * 100) : 100;
    const fill = el('span'); fill.style.width = `${progress}%`;
    return el('div', { class: 'panel journey' }, [
      el('div', { class: 'section-head' }, [el('h2', { text: '一路走来' }), el('span', { text: '累计 Tokens' })]),
      chart,
      next ? el('div', { class: 'next' }, [el('span', {}, ['下一个：', el('b', { text: next.label })]), el('div', { class: 'track' }, [fill]), el('span', {}, next.etaDays != null ? ['照最近的速度，约 ', el('b', { text: `${next.etaDays} 天` }), ' 后'] : ['最近 30 天没有用量'])]) : el('div', { class: 'next' }, ['已经达成了全部 Tokens 里程碑 👑']),
    ]);
  }

  window.renderShareCard = (kind, data, options) => {
    english = options?.lang === 'en';
    document.documentElement.lang = english ? 'en' : 'zh-CN';
    const stage = document.getElementById('stage');
    stage.replaceChildren(kind === 'month' ? month(data, options) : milestone(data, options));
    if (english) window.PulseI18n.apply(stage);
    return Math.ceil(document.documentElement.scrollHeight);
  };
  function analogyText(item) {
    if (!english) return item.text;
    const count = n(item.count);
    return ({ 'three-body': `Enough to read The Three-Body Problem trilogy ${count} times`, 'red-chamber': `Enough to read Dream of the Red Chamber ${count} times`, 'harry-potter': `Enough to read all seven Harry Potter books ${count} times`, code: `Roughly ${count} lines of code`, thesis: `Roughly ${count} master's theses` })[item.id] || '';
  }
})();
