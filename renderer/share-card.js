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
  const DAY_MS = 86400000;
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
  function week(r, options) {
    const [value, unit] = big(r.tokens);
    const change = r.previousTokens ? (r.tokens / r.previousTokens - 1) * 100 : null;
    const start = new Date(r.week + 'T12:00:00'), end = new Date(r.daily[6].day + 'T12:00:00');
    const range = english
      ? `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${start.getFullYear() !== end.getFullYear() ? `, ${start.getFullYear()}` : ''} – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${end.getFullYear()}`
      : r.label;
    const lede = el('p', { class: 'lede' }, [
      r.analogy ? analogyText(r.analogy) : english ? `${n(r.requests)} requests in total` : `一共 ${n(r.requests)} 次请求`,
      change != null ? (english ? ` · ${Math.abs(change).toFixed(0)}% ${change >= 0 ? 'more' : 'less'} than the prior week` : `，比前一周${change >= 0 ? '多' : '少'}了 ${Math.abs(change).toFixed(0)}%`) : null,
      r.analogy ? el('span', { class: 'rough', text: english ? '(rough estimate)' : '（粗略换算）' }) : null,
    ]);
    const card = el('div', { class: 'share-card weekly' }, [
      brand([english ? `${range} · Weekly report` : `${r.label} · 周报`]),
      el('p', { class: 'eyebrow', text: english ? 'This week, you and AI used' : '这周，你和 AI 一起用掉了' }),
      el('div', { class: 'big num' }, [value, el('small', { text: `${unit} Tokens`.trim() })]),
      lede,
      el('div', { class: 'hero-stats' }, [
        stat(english ? 'Reference cost' : '参考费用', usd(r.costUsd), '', english ? 'Reported by sessions or estimated at reference prices' : '会话自报的或按官方标价估的', 'accent'),
        stat(english ? 'Requests' : '请求次数', n(r.requests), english ? '' : '次', english ? `${n(r.requests / 7)} per day on average` : `每天平均 ${n(r.requests / 7)} 次`),
        stat(english ? 'Active days' : '活跃天数', String(r.activeDays), english ? '/ 7 days' : '/ 7 天', english ? `Longest streak: ${r.longestStreak} days` : `最长连续 ${r.longestStreak} 天`),
      ]),
      el('div', { class: 'row2' }, [weekDaysPanel(r), modelsPanel(r)]),
      el('div', { class: 'row3' }, [nightPanel(r), fastPanel(r), cachePanel(r)]),
      options.showNames && r.routes?.length ? el('p', { class: 'routes', text: (english ? 'Routes: ' : '经由：') + r.routes.join(' · '), translate: 'no' }) : null,
      foot(stamp()),
    ]);
    return card;
  }
  function weekDaysPanel(r) {
    const max = Math.max(1, ...r.daily.map(item => item.tokens));
    const days = el('div', { class: 'week-days' }, r.daily.map(item => {
      const bar = el('i', { class: 'week-bar' });
      bar.style.height = `${Math.max(item.tokens > 0 ? 5 : 0, item.tokens / max * 76)}px`;
      return el('div', { class: `week-day${r.best?.day === item.day ? ' best' : ''}` }, [
        el('span', { class: 'week-date', text: day(item.day) }),
        el('div', { class: 'week-track' }, [bar]),
        el('b', { class: 'num', text: item.tokens ? bigText(item.tokens) : '—' }),
      ]);
    }));
    return el('div', { class: 'panel week-panel' }, [
      el('div', { class: 'section-head' }, [el('h2', { text: english ? 'Seven-day usage' : '七天用量' }), el('span', { text: english ? 'Tokens by day' : '每天 Tokens' })]),
      days,
    ]);
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
    if (!top) return el('div', { class: 'panel mini' }, [el('h3', { text: '⚡ 最快的模型' }), el('b', { text: '—' }), el('p', { text: r.week ? '这周还没有量到速度。打开透明转发，或者用本地路由，就能量到。' : '这个月还没有量到速度。打开透明转发，或者用本地路由，就能量到。' })]);
    const max = Math.max(...r.fastest.map(item => item.tokensPerSec));
    const rows = el('div', { class: 'speeds' }, r.fastest.map((item, i) => { const bar = el('i'); bar.style.width = `${item.tokensPerSec / max * 100}%`; bar.style.background = ['var(--accent)', 'var(--week)', 'var(--claude)'][i]; return el('div', {}, [el('span', { text: item.model + (item.effort ? ` ${item.effort}` : '') }), bar, el('b', { class: 'num', text: String(item.tokensPerSec) })]); }));
    return el('div', { class: 'panel mini' }, [el('h3', { text: '⚡ 最快的模型' }), el('b', { class: 'num' }, [String(top.tokensPerSec), el('small', { text: ' Token/秒' })]), el('p', { text: top.model + (top.effort ? ` ${top.effort}` : '') + (top.firstTokenMs ? ` · 首字 ${(top.firstTokenMs / 1000).toFixed(1)} 秒` : '') }), rows]);
  }
  function cachePanel(r) {
    const share = r.week ? (r.cacheHitRate || 0) : (r.input > 0 ? r.cacheRead / r.input : 0);
    const used = el('i'); used.style.width = `${share * 100}%`;
    const fresh = el('i', { class: 'fresh' }); fresh.style.width = `${(1 - share) * 100}%`;
    const legendDot = color => { const d = el('i', { class: 'dot' }); d.style.background = color; return d; };
    if (r.week) {
      const known = r.cacheSavingsAvailable;
      const savings = r.cacheSavingsUsd;
      const saved = savings < 0 ? `-$${n(Math.abs(savings))}` : `+$${n(savings)}`;
      return el('div', { class: 'panel mini' }, [
        el('h3', { text: '♻️ 缓存净省下' }),
        el('b', { class: 'num', text: known ? saved : '—' }),
        el('p', { text: !known ? '还没有可估价的缓存用量' : savings < 0 ? `缓存命中率 ${(share * 100).toFixed(0)}% · 缓存写入成本高于读取节省` : `${(share * 100).toFixed(0)}% 的输入来自缓存读取` }),
        el('div', { class: 'cache' }, [used, fresh]),
        el('div', { class: 'cache-legend' }, [el('span', {}, [legendDot('var(--accent)'), `缓存读取 ${bigText(r.cacheRead)}`]), el('span', {}, [legendDot('#cfe7db'), `新内容 ${bigText(Math.max(0, r.input - r.cacheRead))}`])]),
      ]);
    }
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
  /** 0.3.53 起里程碑卡片的文字直接按语言出（一句话被拆成好几段，查字典翻不全）。 */
  const T = (zh, en) => english ? en : zh;
  function milestone(state, options) {
    const chosen = state.list.find(item => item.id === options?.id && item.achievedAt) || [...state.list].filter(item => item.achievedAt).sort((a, b) => b.achievedAt.localeCompare(a.achievedAt))[0];
    if (!chosen) return el('div', { class: 'share-card ms' }, [brand(['里程碑']), el('h1', { text: '还没有达成里程碑' }), foot(stamp())]);
    // 0.3.53：下半部分全部用达成那天的数字（state.moments），不用今天的；旧数据没有 moments 时退回今天的累计
    const moment = state.moments?.[chosen.id] || null;
    const [mid, small] = medalText(chosen);
    const medal = el('div', { class: 'medal' }, [el('b', { class: 'num', text: mid }), el('small', { text: small })]);
    if (mid.length > 5) medal.querySelector('b').style.fontSize = mid.length > 8 ? '50px' : '64px';
    const title = chosen.group === 'tokens' ? `累计用掉 ${mid} Tokens 🎉` : chosen.group === 'day' ? `一天用掉 ${mid} Tokens 🎉` : chosen.group === 'streak' ? `连续 ${chosen.target} 天都在用 AI 🎉` : chosen.group === 'value' ? `累计 API 价值突破 ${mid} 🎉` : `累计请求突破 ${mid} 次 🎉`;
    const card = el('div', { class: 'share-card ms ms-' + chosen.group }, [
      brand([T('达成于 ', 'Reached ') + chosen.achievedAt.replace(/-/g, '.')]),
      el('div', { class: 'burst' }, [rays(), medal]),
      el('h1', { text: title }),
      moment ? momentLede(chosen, moment, state) : legacyLede(state),
      moment ? momentStats(chosen, moment) : legacyStats(state),
      moment ? momentChart(chosen, moment) : journeyPanel(state),
      collection(state, chosen),
      foot(T(`截至当时已收集 ${state.list.filter(item => item.achievedAt && item.achievedAt <= chosen.achievedAt).length} / ${state.list.length} 枚`, `${state.list.filter(item => item.achievedAt && item.achievedAt <= chosen.achievedAt).length} / ${state.list.length} badges by then`)),
    ]);
    return card;
  }
  const dateCn = key => { const [y, m, d] = key.split('-').map(Number); return english ? new Date(key + 'T12:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : `${y} 年 ${m} 月 ${d} 日`; };
  /** 一句话：第几天达成、和上一枚隔了多久，各组再加一句自己的。 */
  function momentLede(item, m, state) {
    const parts = [];
    if (item.group === 'day' && m.focus.theDay) {
      parts.push(T(`${day(m.day)}这一天用掉了 `, `On ${day(m.day)} you used `), el('b', { text: `${bigText(m.focus.theDay.tokens)} Tokens` }));
      if (m.focus.theDay.vsAverage) parts.push(T('，是之前平均每天的 ', ', '), el('b', { text: T(`${m.focus.theDay.vsAverage.toFixed(1)} 倍`, `${m.focus.theDay.vsAverage.toFixed(1)}×`) }), T('', ' the daily average before'));
      parts.push(T('。', '.'));
    } else if (item.group === 'streak' && m.focus.streak) {
      parts.push(T(`从 ${day(m.focus.streak.from)}到 ${day(m.focus.streak.to)}，`, `From ${day(m.focus.streak.from)} to ${day(m.focus.streak.to)}, `), el('b', { text: T(`${item.target} 天`, `${item.target} days`) }), T('每天都在用，一共用掉 ', ' in a row, '), el('b', { text: `${bigText(m.focus.streak.tokens)} Tokens` }), T('。', ' in total.'));
    } else if (m.analogy) {
      parts.push(analogyText(m.analogy), el('span', { class: 'rough', text: T('（粗略换算）', ' (rough estimate)') }), el('br'));
    }
    if (state.firstDay) parts.push(item.group === 'day' || item.group === 'streak' ? el('br') : null, T(`从 ${dateCn(state.firstDay)}第一条记录算起，第 `, `Reached on day `), el('b', { text: T(`${m.dayIndex} 天`, String(m.dayIndex)) }), T('达成', ` since the first record on ${dateCn(state.firstDay)}`));
    if (m.previous) parts.push(...(english ? [', ', el('b', { text: `${m.previous.gapDays} days` }), ` after “${badgeName(m.previous)}”`] : ['，距上一枚「', m.previous.label, '」', el('b', { text: `${m.previous.gapDays} 天` })]));
    parts.push(T('。', '.'));
    return el('p', { class: 'lede' }, parts.filter(part => part != null));
  }
  function momentStats(item, m) {
    const f = m.focus, top = f.models[0];
    const modelStat = (label, model, sub) => { const node = stat(label, model ? model.model : '—', '', sub); node.querySelector('b').classList.add('word'); return node; };
    const share = model => `${(model.share * 100).toFixed(0)}%`;
    let boxes;
    if (item.group === 'day' && f.theDay) boxes = [
      stat(T('那一天按 API 标价', 'That day at API prices'), usd(f.theDay.costUsd), '', T(`那天 ${n(f.theDay.requests)} 次请求`, `${n(f.theDay.requests)} requests that day`)),
      stat(T('达成时累计', 'Total by then'), bigText(m.totals.tokens), 'Tokens', T(`第 ${m.dayIndex} 天`, `Day ${m.dayIndex}`)),
      modelStat(T('那天用得最多的模型', 'Top model that day'), top, top ? T(`占那天的 ${share(top)}`, `${share(top)} of that day`) : ''),
    ];
    else if (item.group === 'streak' && f.streak) boxes = [
      stat(T('这几天平均每天', 'Per day in the streak'), bigText(f.streak.tokens / item.target), 'Tokens', T(`按 API 标价共 ${usd(f.streak.costUsd)}`, `${usd(f.streak.costUsd)} at API prices`)),
      stat(T('最拼的一天', 'Busiest day'), f.streak.best ? day(f.streak.best.day) : '—', '', f.streak.best ? `${bigText(f.streak.best.tokens)} Tokens` : ''),
      modelStat(T('这几天用得最多的模型', 'Top model in the streak'), top, top ? T(`占 ${share(top)}`, `${share(top)} of tokens`) : ''),
    ];
    else if (item.group === 'value') boxes = [
      stat(T('达成时累计', 'Total by then'), bigText(m.totals.tokens), 'Tokens', T(`${n(m.totals.requests)} 次请求`, `${n(m.totals.requests)} requests`)),
      stat(T('平均每天', 'Per day'), usd(f.perDay.costUsd), '', T(`第 ${m.dayIndex} 天达成`, `Reached on day ${m.dayIndex}`)),
      modelStat(T('花得最多的模型', 'Biggest spender'), top, top ? T(`${usd(top.costUsd)} · 占 ${share(top)}`, `${usd(top.costUsd)} · ${share(top)}`) : ''),
    ];
    else if (item.group === 'requests') boxes = [
      stat(T('达成时累计', 'Total by then'), bigText(m.totals.tokens), 'Tokens', T(`按 API 标价 ${usd(m.totals.costUsd)}`, `${usd(m.totals.costUsd)} at API prices`)),
      stat(T('平均每天请求', 'Requests per day'), n(f.perDay.requests), english ? '' : '次', T(`第 ${m.dayIndex} 天达成`, `Reached on day ${m.dayIndex}`)),
      stat(T('请求最多的一天', 'Busiest day'), f.busiest ? day(f.busiest.day) : '—', '', f.busiest ? T(`${n(f.busiest.requests)} 次`, `${n(f.busiest.requests)} requests`) : ''),
    ];
    else boxes = [
      stat(T('达成时按 API 标价', 'At API prices by then'), usd(m.totals.costUsd), '', T(`平均每天 ${bigText(f.perDay.tokens)} Tokens`, `${bigText(f.perDay.tokens)} tokens a day`)),
      stat(T('达成时累计请求', 'Requests by then'), n(m.totals.requests), english ? '' : '次', T(`和 AI 说了 ${bigText(m.totals.requests)} 次话`, `${bigText(m.totals.requests)} conversations with AI`)),
      modelStat(T('当时陪你最久的模型', 'Longest companion then'), m.companion, m.companion ? T(`用了 ${m.companion.days} 天，占 ${(m.companion.share * 100).toFixed(0)}%`, `${m.companion.days} days, ${(m.companion.share * 100).toFixed(0)}% of usage`) : ''),
    ];
    return el('div', { class: 'ms-stats' }, boxes);
  }
  /** 下半部分的图：累计（Tokens / API 价值 / 请求）画曲线，单日和连续画每天的柱子。 */
  function momentChart(item, m) {
    const s = m.series, W = 960, H = 190, L = 58, R = 24, TOP = 22, B = 28;
    const fmt = v => s.unit === 'usd' ? usd(v) : bigText(v) || '0';
    const chart = svg('svg', { viewBox: `0 0 ${W} ${H}` });
    const points = s.points;
    const heads = english ? { tokens: ['Your journey', 'Cumulative tokens · up to that day'], value: ['Your journey', 'Cumulative API value · up to that day'], requests: ['Your journey', 'Cumulative requests · up to that day'], day: ['The 30 days up to that day', 'Tokens per day'], streak: [`These ${item.target} days`, 'Tokens per day'] }[item.group] : { tokens: ['一路走来', '累计 Tokens · 到达成那天'], value: ['一路走来', '累计 API 价值 · 到达成那天'], requests: ['一路走来', '累计请求 · 到达成那天'], day: ['那一天之前的 30 天', '每天的 Tokens'], streak: [`这 ${item.target} 天`, '每天的 Tokens'] }[item.group];
    if (points.length) {
      const max = Math.max(1, ...points.map(p => p.value)) * 1.12;
      const y = v => TOP + (1 - v / max) * (H - TOP - B);
      for (const g of [0, .25, .5, .75, 1]) { const v = max / 1.12 * g; chart.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: '#eef0f3' }), text({ x: L - 8, y: y(v) + 4, 'text-anchor': 'end', fill: '#9aa2ae', 'font-size': 11.5 }, fmt(v))); }
      if (s.kind === 'daily') {
        const slot = (W - L - R) / points.length, bar = Math.max(1.5, Math.min(22, slot * .7));
        points.forEach((p, i) => {
          const hot = s.highlight && p.day >= s.highlight.from && p.day <= s.highlight.to && (item.group !== 'day' || p.day === s.highlight.to);
          const x = L + i * slot + (slot - bar) / 2;
          chart.append(svg('rect', { x, y: y(p.value), width: bar, height: Math.max(1, y(0) - y(p.value)), rx: Math.min(4, bar / 2), fill: item.group === 'day' ? (hot ? '#d19a00' : '#cfe7db') : '#14855f', opacity: item.group === 'streak' ? .85 : 1 }));
        });
        // 横轴：头、尾、中间各一个日期
        for (const i of [0, Math.floor((points.length - 1) / 2), points.length - 1]) chart.append(text({ x: L + i * slot + slot / 2, y: H - 8, 'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle', fill: '#9aa2ae', 'font-size': 11.5 }, day(points[i].day)));
        if (item.group === 'day') { const i = points.length - 1, p = points[i]; chart.append(text({ x: L + i * slot + slot / 2 - 8, y: y(p.value) - 8, 'text-anchor': 'end', fill: '#b66d0d', 'font-size': 12.5, 'font-weight': 700 }, `${day(p.day)} · ${fmt(p.value)}`)); }
      } else {
        const t0 = Date.parse(points[0].day + 'T12:00:00'), t1 = Date.parse(points.at(-1).day + 'T12:00:00');
        const span = Math.max(DAY_MS, t1 - t0) * 1.04;
        const x = key => L + (Date.parse(key + 'T12:00:00') - t0) / span * (W - L - R);
        const defs = svg('defs'); const grad = svg('linearGradient', { id: 'jg', x1: 0, x2: 0, y1: 0, y2: 1 }); grad.append(svg('stop', { offset: 0, 'stop-color': '#14855f', 'stop-opacity': .25 }), svg('stop', { offset: 1, 'stop-color': '#14855f', 'stop-opacity': 0 })); defs.append(grad); chart.append(defs);
        chart.append(svg('path', { d: `M${x(points[0].day)},${y(0)} ` + points.map(p => `L${x(p.day)},${y(p.value)}`).join(' ') + ` L${x(points.at(-1).day)},${y(0)} Z`, fill: 'url(#jg)' }));
        chart.append(svg('polyline', { points: points.map(p => `${x(p.day)},${y(p.value)}`).join(' '), fill: 'none', stroke: '#14855f', 'stroke-width': 3, 'stroke-linejoin': 'round' }));
        const start = new Date(t0); start.setDate(1); start.setMonth(start.getMonth() + 1);
        for (let d = start; d.getTime() <= t1; d.setMonth(d.getMonth() + 1)) { const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; chart.append(text({ x: x(key), y: H - 8, 'text-anchor': 'middle', fill: '#9aa2ae', 'font-size': 11.5 }, english ? d.toLocaleDateString('en-US', { month: 'short' }) : `${d.getMonth() + 1}月`)); }
        const marks = s.marks.slice(-4);
        for (const mark of marks) {
          chart.append(svg('circle', { cx: x(mark.day), cy: y(mark.value), r: mark.current ? 8 : 5, fill: mark.current ? '#d19a00' : '#fff', stroke: mark.current ? '#fff' : '#14855f', 'stroke-width': 3 }));
          chart.append(text({ x: x(mark.day) - 10, y: y(mark.value) - 10, 'text-anchor': 'end', fill: mark.current ? '#b66d0d' : '#3f4652', 'font-size': 12.5, 'font-weight': 700 }, mark.current ? `${badgeName(mark)} · ${T(`第 ${m.dayIndex} 天`, `day ${m.dayIndex}`)}` : badgeName(mark)));
        }
      }
    }
    const next = m.next;
    const fill = el('span'); fill.style.width = `${next ? Math.max(2, next.progress * 100) : 100}%`;
    const nextLine = next
      ? el('div', { class: 'next' }, [el('span', {}, [T('同一组的下一枚：', 'Next in this set: '), el('b', { text: badgeName(next) })]), el('div', { class: 'track' }, [fill]), el('span', {}, next.reachedAt ? [T('后来在 ', 'Reached later on '), el('b', { text: day(next.reachedAt) }), T(' 达成 ✓', ' ✓')] : [T('当时完成了 ', 'Progress then: '), el('b', { text: `${(next.progress * 100).toFixed(0)}%` })])])
      : el('div', { class: 'next' }, [T('这是这一组的最后一枚 👑', 'The last badge in this set 👑')]);
    return el('div', { class: 'panel journey' }, [el('div', { class: 'section-head' }, [el('h2', { text: heads[0] }), el('span', { text: heads[1] })]), chart, nextLine]);
  }
  /** 徽章：达成那天之前拿到的亮着，这一枚高亮，之后才拿到的和还没拿到的都灰着（「当时」的收集册）。 */
  function collection(state, chosen) {
    const had = item => item.achievedAt && item.achievedAt <= chosen.achievedAt;
    const list = state.list.filter(item => had(item) || item.group === chosen.group).slice(0, 9);
    return el('div', { class: 'collection' }, list.map(item => el('span', { class: 'coin' + (item.id === chosen.id ? ' new' : had(item) ? '' : ' locked') }, [el('i', { text: item.icon }), badgeName(item) + (item.id === chosen.id ? T(' · 这一枚', ' · this one') : '')])));
  }
  /* 旧版本存下来的数据没有 moments：照以前的样子画今天的累计 */
  function legacyLede(state) {
    const since = state.firstDay ? dateCn(state.firstDay) : '';
    return el('p', { class: 'lede' }, [state.analogy ? [analogyText(state.analogy), el('span', { class: 'rough', text: '（粗略换算）' }), el('br')] : null, since ? `从 ${since}第一条记录开始，用了 ` : '', since ? el('b', { text: `${state.days} 天` }) : null, since ? '。' : ''].flat().filter(part => part != null));
  }
  function legacyStats(state) {
    return el('div', { class: 'ms-stats' }, [
      stat('累计按 API 标价', usd(state.totals.costUsd), '', `累计 ${bigText(state.totals.tokens)} Tokens`),
      stat('累计请求', n(state.totals.requests), english ? '' : '次', `和 AI 说了 ${bigText(state.totals.requests)} 次话`),
      state.companion ? (() => { const node = stat('陪你最久的模型', state.companion.model, '', `用了 ${state.companion.days} 天，占 ${(state.companion.share * 100).toFixed(0)}%`); node.querySelector('b').classList.add('word'); return node; })() : stat('陪你最久的模型', '—', '', ''),
    ]);
  }

  /** 徽章名：中文原样，英文查界面字典（label 是整串，字典里有）。 */
  function badgeName(item) { return english && window.PulseI18n ? window.PulseI18n.t(item.label) : item.label; }
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
    stage.replaceChildren(kind === 'month' ? month(data, options) : kind === 'week' ? week(data, options) : milestone(data, options));
    if (english) window.PulseI18n.apply(stage);
    return Math.ceil(document.documentElement.scrollHeight);
  };
  function analogyText(item) {
    if (!english) return item.text;
    const count = n(item.count);
    return ({ 'three-body': `Enough to read The Three-Body Problem trilogy ${count} times`, 'red-chamber': `Enough to read Dream of the Red Chamber ${count} times`, 'harry-potter': `Enough to read all seven Harry Potter books ${count} times`, code: `Roughly ${count} lines of code`, thesis: `Roughly ${count} master's theses` })[item.id] || '';
  }
})();
