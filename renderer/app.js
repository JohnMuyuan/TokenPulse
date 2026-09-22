'use strict';
const api = window.tokenpulse;
const D = window.PulseData;
const $ = id => document.getElementById(id);
const META = { chatgpt: { name: 'ChatGPT', letter: 'G', source: 'Codex CLI' }, claude: { name: 'Claude', letter: 'C', source: 'Claude Code' }, grok: { name: 'Grok', letter: 'X', source: 'Grok Build' } };
const HEALTH = { good: '节奏正常', warning: '留意用量', serious: '可能提前耗尽', critical: '额度紧张', unknown: '暂无数据' };
const state = { page: 'overview', days: 30, source: 'all', metric: 'tokens', account: 'chatgpt', from: '', to: '', search: '', sort: 'day', tablePage: 0 };
let current = null;
let analysis = null;
let filteredRecords = [];
let lastFocus = null;
let theme = 'light';
try { theme = localStorage.getItem('tokenpulse-theme') === 'dark' ? 'dark' : 'light'; } catch {}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) if (child != null) node.append(child);
  return node;
}
function svg(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}
function number(n) { return (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function tokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return number(n);
}
function money(n) { return n > 0 && n < .01 ? '<$0.01' : '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function percent(n) { return n == null || !Number.isFinite(n) ? '—' : n.toFixed(1) + '%'; }
function date(at, full = false) {
  if (!at) return '尚未采样';
  return new Date(at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(full ? { year: 'numeric' } : {}), hour12: false });
}
function duration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '时间未知';
  if (ms <= 0) return '等待重置确认';
  const mins = Math.ceil(ms / 60000), hours = Math.floor(mins / 60);
  if (mins < 60) return `${mins} 分钟`;
  if (hours < 24) return `${hours} 小时 ${mins % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}
function showStatus(message, error = false) { $('app-status').textContent = message; $('app-status').hidden = false; $('app-status').setAttribute('role', error ? 'alert' : 'status'); }
function empty(message) { return el('div', { class: 'empty', text: message }); }
function track(pct, warning = false, label = '已用额度') {
  const fill = el('span', { class: 'track-fill' + (pct >= 90 ? ' critical' : warning ? ' warning' : '') });
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  return el('div', { class: 'track', role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.min(100, Math.max(0, pct)) }, [fill]);
}
function isStale(account) { return !account?.lastSampleAt || Date.now() - account.lastSampleAt > 15 * 60000; }
function waitingReset(account, window) { return window?.startAt != null && account?.lastSampleAt < window.startAt; }
function avatar(kind) { return el('span', { class: 'account-avatar ' + kind, text: META[kind].letter, 'aria-hidden': true }); }
function prediction(window, account) {
  if (!window) return '暂无窗口数据';
  if (waitingReset(account, window)) return '窗口已重置，等待新采样确认';
  if (isStale(account)) return '采样已过期，刷新后再判断';
  if (window.used >= 100) return '额度已用完，请等待重置';
  if (window.runsOutBeforeReset && window.etaAt) return `按平均速度，约 ${duration(window.etaAt - Date.now())}后用完`;
  if (window.projectedAtReset != null) return `按平均速度，重置时预计已用 ${percent(window.projectedAtReset)}`;
  return '采样尚少，暂不预测耗尽时间';
}
function quotaCard(kind) {
  const account = current.accounts.find(a => a.kind === kind);
  const meta = META[kind];
  const stale = account && isStale(account);
  // 首页优先展示剩余最少的有效窗口，避免周额度充足掩盖 5 小时窗口即将耗尽。
  const windows = [account?.five, account?.week].filter(Boolean);
  const report = windows.filter(win => !waitingReset(account, win)).sort((a, b) => b.used - a.used)[0] || windows[0];
  const waiting = report && waitingReset(account, report);
  const head = el('div', { class: 'account-head' }, [avatar(kind), el('span', { class: 'account-name', text: meta.name }), account?.plan ? el('span', { class: 'plan', text: account.plan }) : null,
    el('span', { class: 'badge ' + (!stale && !waiting ? account?.health.level || '' : ''), text: !account ? '暂无采样' : waiting ? '等待新采样' : stale ? '采样已过期' : HEALTH[account.health.level] })]);
  const remaining = report && !waiting ? Math.max(0, 100 - report.used).toFixed(1) : '—';
  const value = el('div', { class: 'quota-remaining' + (!report || waiting ? ' empty-number' : ''), text: remaining }, report && !waiting ? [el('small', { text: '%' })] : []);
  const windowLabel = report && report === account?.week ? '周额度' : report ? '5 小时额度' : '额度';
  const body = [head, el('div', { class: 'quota-number-row' }, [value, el('span', { text: `${stale ? '上次' : ''}${windowLabel}剩余` })])];
  if (account && (account.five || account.week)) {
    for (const [label, win] of [['5 小时', account.five], ['周额度', account.week]]) {
      if (!win) continue;
      const pending = waitingReset(account, win);
      body.push(el('div', { class: 'quota-mini' }, [el('div', { class: 'quota-mini-head' }, [el('span', { text: label }), el('span', { class: 'num', text: pending ? '等待确认' : `已用 ${percent(win.used)}` })]),
        pending ? el('div', { class: 'track' }) : track(win.used, win.runsOutBeforeReset),
        el('div', { class: 'mini-reset', text: pending ? '旧窗口已结束，正在等待新数据' : win.resetAt ? `${duration(win.resetAt - Date.now())}后重置 · ${date(win.resetAt)}` : '接口未提供重置时间' })]));
    }
  } else {
    body.push(el('div', { class: 'quota-missing' }, [el('b', { text: '尚未取得官方额度' }), el('p', { text: '可能尚未登录、凭据过期或网络未连通。本机用量仍正常记录。' })]));
  }
  const link = el('button', { class: 'text-btn', text: '详情 →', 'aria-label': `${meta.name} 额度详情` });
  link.addEventListener('click', () => { state.account = kind; navigate('quota'); });
  const forecast = !stale && !waiting && report?.used >= 100 ? '额度已用完，等待重置' : !stale && !waiting && report?.etaAt && report.runsOutBeforeReset ? `约 ${duration(report.etaAt - Date.now())}后用完` : !stale && !waiting && report?.projectedAtReset != null ? `重置时预计已用 ${percent(report.projectedAtReset)}` : `${date(account?.lastSampleAt)} 采样`;
  body.push(el('div', { class: 'quota-card-foot' }, [el('span', { text: account ? forecast : `${meta.source} 本地凭据` }), link]));
  return el('article', { class: 'quota-card' }, body);
}
function updateRange() {
  if (state.days !== 'custom') { state.to = D.dayKey(current.now); state.from = D.shift(state.to, 1 - state.days); }
  $('range-label').textContent = `${state.from.replaceAll('-', '.')} — ${state.to.replaceAll('-', '.')}`;
  $('date-from').value = state.from; $('date-to').value = state.to;
  $('date-from').max = $('date-to').max = D.dayKey(current.now);
  analysis = D.analyze(current.usage || [], state.from, state.to, state.source);
}
function delta(now, previous) {
  if (!previous) return now ? '上一时段无记录' : '暂无变化';
  const pct = ((now - previous) / previous) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% 较上一时段`;
}
function renderStats() {
  const t = analysis.total, p = analysis.previous;
  const cache = t.input ? t.cacheRead / t.input * 100 : null;
  const stats = [
    ['总 Tokens', tokens(t.tokens), delta(t.tokens, p.tokens), '输入 + 输出'],
    ['参考费用', money(t.costUsd), analysis.unpriced ? `${number(analysis.unpriced)} 次请求未定价` : delta(t.costUsd, p.costUsd), 'USD'],
    ['请求次数', number(t.requests), delta(t.requests, p.requests), '次'],
    ['缓存读取占比', percent(cache), `${tokens(t.cacheRead)} 缓存读取 / ${tokens(t.input)} 输入`, '输入口径']
  ];
  $('tiles').replaceChildren(...stats.map(([label, value, sub, unit]) => el('article', { class: 'stat' }, [el('div', { class: 'stat-label' }, [el('span', { text: label }), el('span', { text: unit })]), el('div', { class: 'stat-value', text: value }), el('div', { class: 'stat-sub', text: sub })])));
}
function tipAt(text, x, y) {
  const tip = $('tip'); tip.textContent = text; tip.hidden = false;
  tip.style.left = `${Math.max(8, Math.min(x + 12, window.innerWidth - tip.offsetWidth - 12))}px`;
  tip.style.top = `${Math.max(8, Math.min(y + 10, window.innerHeight - tip.offsetHeight - 12))}px`;
}
function chart(host, rows, metric = 'tokens', hourly = false) {
  host.replaceChildren();
  if (!rows.length) { host.append(empty('所选范围暂无记录')); return; }
  const w = Math.max(280, host.clientWidth), h = 190, left = 43, bottom = 25, top = 12;
  const max = Math.max(1, ...rows.map(row => row[metric] || 0));
  const node = svg('svg', { viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': hourly ? '最近24小时用量柱状图' : '每日用量柱状图' });
  const fmt = metric === 'costUsd' ? money : metric === 'requests' ? number : tokens;
  for (let i = 0; i <= 2; i++) {
    const y = top + (h - top - bottom) * i / 2;
    node.append(svg('line', { class: 'grid', x1: left, x2: w - 5, y1: y, y2: y }));
    const label = svg('text', { class: 'axis', x: left - 7, y: y + 3, 'text-anchor': 'end' });
    label.textContent = max === 1 && i === 1 ? '' : fmt(max * (1 - i / 2)); node.append(label);
  }
  const slot = (w - left - 8) / rows.length, barWidth = Math.max(.5, Math.min(slot * .6, 28));
  rows.forEach((row, i) => {
    const barHeight = Math.max(row[metric] > 0 ? 2 : 0, ((row[metric] || 0) / max) * (h - top - bottom));
    const x = left + i * slot + (slot - barWidth) / 2;
    const label = hourly ? `${new Date(row.hour).getHours()}:00` : row.day;
    const text = `${hourly ? date(row.hour) : label}\n${tokens(row.tokens)} Tokens\n${money(row.costUsd)} · ${number(row.requests)} 次请求`;
    const rect = svg('rect', { class: 'col' + (row.day === D.dayKey(Date.now()) ? ' today' : ''), x, y: h - bottom - barHeight, width: barWidth, height: barHeight, rx: Math.min(3, barWidth / 2), tabindex: 0, 'aria-label': text });
    const title = svg('title'); title.textContent = text; rect.append(title);
    rect.addEventListener('pointermove', e => tipAt(text, e.clientX, e.clientY));
    rect.addEventListener('pointerleave', () => { $('tip').hidden = true; });
    rect.addEventListener('focus', () => { const box = rect.getBoundingClientRect(); tipAt(text, box.x, box.y); });
    rect.addEventListener('blur', () => { $('tip').hidden = true; });
    node.append(rect);
    if (i % Math.max(1, Math.ceil(rows.length / 7)) === 0 || i === rows.length - 1) {
      const tick = svg('text', { class: 'axis', x: x + barWidth / 2, y: h - 5, 'text-anchor': 'middle' }); tick.textContent = hourly ? label : label.slice(5); node.append(tick);
    }
  });
  host.append(node);
}
function renderOverview() {
  $('quota-cards').replaceChildren(...Object.keys(META).map(quotaCard));
  chart($('daily-chart'), analysis.daily, state.metric);
  const t = analysis.total, n = analysis.daily.length || 1;
  const peak = [...analysis.daily].sort((a, b) => b.tokens - a.tokens)[0];
  $('chart-summary').replaceChildren(el('span', {}, ['日均', el('b', { text: tokens(t.tokens / n) + ' Tokens' })]), el('span', {}, ['活跃天数', el('b', { text: `${analysis.activeDays} / ${n} 天` })]));
  const rhythms = [['日均请求', `${number(t.requests / n)} 次`], ['单次平均用量', t.requests ? `${tokens(t.tokens / t.requests)} Tokens` : '—'], ['用量最高的一天', peak?.tokens ? peak.day.slice(5).replace('-', ' / ') : '—'], ['峰值用量', peak?.tokens ? tokens(peak.tokens) : '—']];
  $('rhythm').replaceChildren(...rhythms.map(([label, value]) => el('div', { class: 'rhythm-row' }, [el('span', { text: label }), el('b', { text: value })])), el('p', { class: 'rhythm-note', text: '平均值包含没有使用的日期。对比上一段等长时间，今天的记录仍在累积。' }));
  const sources = [...analysis.sources].sort((a, b) => b.tokens - a.tokens);
  $('sources').replaceChildren(...(sources.length ? sources.map(row => {
    const share = t.tokens ? row.tokens / t.tokens * 100 : 0;
    return el('div', { class: 'source-row' }, [el('div', { class: 'source-top' }, [el('span', { text: row.source }), el('span', { class: 'share', text: percent(share) })]), track(share, false, '工具 token 占比'), el('div', { class: 'source-bottom' }, [el('span', { text: `${tokens(row.tokens)} Tokens · ${number(row.requests)} 次` }), el('span', { text: money(row.costUsd) })])]);
  }) : [empty('所选范围还没有工具用量')]));
  const models = [...analysis.models].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
  $('model-ranking').replaceChildren(...(models.length ? models.map((row, i) => el('div', { class: 'rank-row' }, [el('span', { class: 'rank-number', text: String(i + 1).padStart(2, '0') }), el('div', {}, [el('div', { class: 'rank-name', text: row.model, title: row.model }), el('div', { class: 'rank-meta', text: row.source })]), el('div', { class: 'rank-value' }, [tokens(row.tokens), el('div', { class: 'rank-meta', text: row.unpriced ? '部分未定价' : money(row.costUsd) })])])) : [empty('所选范围还没有模型用量')]));
}
function detailItem(label, value) { return el('div', { class: 'detail-item' }, [el('small', { text: label }), el('b', { class: 'num', text: value })]); }
function windowPanel(label, report, account) {
  const panel = el('article', { class: 'panel' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: label }), el('span', { class: 'section-tag', text: '官方额度窗口' })])]);
  if (!report) { panel.append(empty('接口未提供此窗口')); return panel; }
  const pending = waitingReset(account, report), stale = isStale(account);
  panel.append(el('div', { class: 'window-number' }, [el('strong', { text: pending ? '—' : percent(Math.max(0, 100 - report.used)) }), el('span', { text: stale ? '上次采样剩余' : '剩余额度' })]));
  const bar = pending ? el('div', { class: 'track' }) : track(report.used, report.runsOutBeforeReset); bar.classList.add('window-track'); panel.append(bar);
  panel.append(el('div', { class: 'source-top muted' }, [el('span', { text: pending ? '等待采样确认' : `已用 ${percent(report.used)}` }), el('span', { text: report.resetAt ? `${duration(report.resetAt - Date.now())}后重置` : '重置时间未知' })]));
  panel.append(el('div', { class: 'prediction-line' + (report.runsOutBeforeReset || stale || pending ? ' caution' : ''), text: prediction(report, account) }));
  const speed = n => n == null || stale || pending ? '—' : `${n.toFixed(2)} 百分点 / 小时`;
  const capacity = report.capacity;
  panel.append(el('div', { class: 'detail-grid' }, [
    detailItem('重置时间 · 本地时区', report.resetAt ? date(report.resetAt, true) : '未知'),
    detailItem('窗口开始', report.startAt ? date(report.startAt, true) : '未知'),
    detailItem('窗口平均消耗速度', speed(report.averagePerH)),
    detailItem(label.startsWith('5') ? '最近 1 小时速度' : '最近 24 小时速度', speed(report.recentPerH)),
    detailItem('按平均速度耗尽', stale || pending ? '等待有效采样' : report.used >= 100 ? '已用完' : report.etaAt ? `${date(report.etaAt)}${report.resetAt && report.etaAt > report.resetAt ? '（重置后）' : ''}` : '暂无法估计'),
    detailItem('按较快速度耗尽', stale || pending ? '等待有效采样' : report.etaFastAt ? date(report.etaFastAt) : '暂无法估计'),
    detailItem('本机官方会话 Tokens', tokens(report.usedTokens)),
    detailItem('本机参考费用', money(report.usedCostUsd)),
    detailItem('整窗容量折算', capacity && !stale && !pending ? `约 ${tokens(capacity.tokens)} Tokens` : '样本不足或已过期'),
    detailItem('容量折算可信度', capacity && !stale && !pending ? ({ low: '较低 · 仅供参考', medium: '中等', high: '较高' })[capacity.confidence] : '—')
  ]));
  panel.append(el('p', { class: 'quota-footnote', text: '预测按墙钟平均速度计算，包含休息时间；使用强度变化会影响结果。容量折算不是官方 token 上限。' }));
  return panel;
}
function renderQuota() {
  const host = $('quota-detail'); host.replaceChildren();
  for (const button of $('account-tabs').children) { button.classList.toggle('on', button.dataset.account === state.account); button.setAttribute('aria-pressed', button.dataset.account === state.account); }
  const account = current.accounts.find(a => a.kind === state.account), meta = META[state.account];
  const sessions = current.sessions[state.account] || { included: 0, excluded: 0 };
  host.append(el('div', { class: 'quota-context' }, [avatar(state.account), el('div', {}, [el('h2', { text: meta.name + (account?.plan ? ' · ' + account.plan : '') }), el('p', { class: 'muted', text: `${number(sessions.included)} 个官方会话 · ${number(sessions.excluded)} 个中转 / API Key 会话未计入额度` })]), el('div', { class: 'context-meta', text: account ? `${date(account.lastSampleAt)} 更新 · ${number(account.sampleCount)} 个采样点` : '尚无额度采样' })]));
  if (!account) {
    host.append(el('article', { class: 'panel empty large' }, [el('h3', { text: '暂时还没有这个账号的额度数据' }), el('p', { text: `确认 ${meta.source} 已登录官方账号，然后点击「刷新数据」。` }), el('p', { text: '凭据过期或网络错误也可能导致采样失败；这不会影响本机用量统计。' })])); return;
  }
  if (isStale(account)) host.append(el('p', { class: 'stale-note', text: `上次采样是 ${date(account.lastSampleAt, true)}，已超过 15 分钟。以下是历史记录，当前剩余额度需刷新确认。` }));
  host.append(el('div', { class: 'quota-window-grid' }, [windowPanel('5 小时窗口', account.five, account), windowPanel('周额度窗口', account.week, account)]));
  const hourly = el('div', { class: 'chart' });
  const history = el('article', { class: 'panel' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '最近 24 小时 · 官方会话用量' })]), hourly, el('p', { class: 'sample-caption', text: '仅统计本机归属该官方账号的会话。横轴按本地时间，含当前未结束的小时。' })]);
  const trend = el('div', { class: 'chart quota-trend' });
  const trendPanel = el('article', { class: 'panel' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '本周额度采样' })]), trend, el('p', { class: 'sample-caption', text: `手动重置次数：${account.resetCredits ?? '接口未提供'} · 活跃时间占比：${account.week?.activeShare == null ? '样本不足' : percent(account.week.activeShare * 100)}` })]);
  host.append(el('div', { class: 'quota-history-grid' }, [history, trendPanel]));
  chart(hourly, account.hourly, 'tokens', true);
  const points = account.trend;
  if (points.length < 3 || points.at(-1).at - points[0].at < 3600000) trend.append(empty('采样跨度不足 1 小时，继续记录后显示趋势'));
  else {
    const w = 360, h = 170, from = points[0].at, span = points.at(-1).at - from;
    const node = svg('svg', { viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': '当前周窗口的额度已用百分比' });
    for (const pct of [0, 50, 100]) {
      const y = 140 - pct * 1.2; node.append(svg('line', { class: 'grid', x1: 30, x2: 350, y1: y, y2: y }));
      const text = svg('text', { class: 'axis', x: 24, y: y + 3, 'text-anchor': 'end' }); text.textContent = pct + '%'; node.append(text);
    }
    node.append(svg('path', { d: points.map((p, i) => `${i ? 'L' : 'M'}${30 + (p.at - from) / span * 320},${140 - Math.min(100, p.pct) * 1.2}`).join(' ') }));
    for (const [at, x, anchor] of [[from, 30, 'start'], [points.at(-1).at, 350, 'end']]) { const text = svg('text', { class: 'axis', x, y: 162, 'text-anchor': anchor }); text.textContent = date(at); node.append(text); }
    trend.append(node);
  }
}
function renderRecords() {
  const q = state.search.trim().toLowerCase();
  filteredRecords = analysis.selected.filter(row => !q || `${row.model} ${row.source}`.toLowerCase().includes(q)).sort((a, b) => state.sort === 'day' ? b.day.localeCompare(a.day) || b.tokens - a.tokens : b[state.sort] - a[state.sort] || b.day.localeCompare(a.day));
  const pageSize = 15, pages = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
  state.tablePage = Math.min(state.tablePage, pages - 1);
  const visible = filteredRecords.slice(state.tablePage * pageSize, (state.tablePage + 1) * pageSize);
  $('record-count').textContent = `${number(filteredRecords.length)} 条`;
  $('export-csv').disabled = !filteredRecords.length;
  $('records').replaceChildren(...visible.map(row => el('tr', {}, [
    el('td', {}, [row.day, el('small', { text: row.source })]), el('td', { class: 'model-cell', text: row.model, title: row.model }),
    ...['requests', 'input', 'output', 'cacheRead', 'tokens'].map(key => el('td', { class: 'n' + (key === 'tokens' ? ' token-strong' : ''), text: key === 'requests' ? number(row[key]) : tokens(row[key]), title: number(row[key]) })),
    el('td', { class: 'n', text: row.priced === false ? '未定价' : money(row.costUsd) })
  ])));
  if (!visible.length) $('records').append(el('tr', {}, [el('td', { colspan: 8, class: 'empty', text: '没有匹配的记录，试试其他时间、工具或关键词。' })]));
  $('pagination-label').textContent = `第 ${state.tablePage + 1} / ${pages} 页 · 共 ${number(filteredRecords.length)} 条匹配明细`;
  $('prev-page').disabled = state.tablePage === 0; $('next-page').disabled = state.tablePage >= pages - 1;
}
function renderUsage() {
  const t = analysis.total;
  $('token-breakdown').replaceChildren(...[['输入 Tokens', 'input', '含缓存读取与写入'], ['输出 Tokens', 'output', '含推理 Tokens'], ['缓存读取', 'cacheRead', '输入的一部分'], ['缓存写入', 'cacheWrite', '输入的一部分'], ['推理 Tokens', 'reasoning', '输出的一部分']].map(([label, key, note]) => el('div', { class: 'breakdown-item' }, [el('small', { text: label }), el('strong', { text: tokens(t[key]), title: number(t[key]) }), el('span', { text: note })])));
  renderRecords();
}
function render(snapshot) {
  current = snapshot;
  if ($('app-status').getAttribute('role') !== 'alert') $('app-status').hidden = true;
  updateRange(); renderStats();
  if (state.page === 'overview') renderOverview();
  if (state.page === 'quota') renderQuota();
  if (state.page === 'usage') renderUsage();
  $('today-label').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  $('stamp').textContent = snapshot.scannedAt ? `${date(snapshot.scannedAt)} 已更新` : '正在扫描本地会话…';
  $('data-summary').textContent = `${number(snapshot.fileCount || 0)} 个会话文件 · ${number(snapshot.totals.all.requests)} 次历史请求 · 本机时区`;
}
function navigate(page) {
  if (!['overview', 'quota', 'usage'].includes(page)) page = 'overview';
  state.page = page;
  const labels = { overview: ['总览', '今天的用量与额度', '看看还剩多少额度，再安排接下来的工作。'], quota: ['额度详情', '把使用节奏，放在时间里看', '剩余额度、重置时间与耗尽预测，集中在这里。'], usage: ['用量明细', '每一笔用量，都有迹可循', '按日期、工具与模型查看消耗，找到值得关注的变化。'] }[page];
  ['page-label', 'page-title', 'page-description'].forEach((id, i) => { $(id).textContent = labels[i]; });
  for (const button of document.querySelectorAll('[data-page]')) { button.classList.toggle('active', button.dataset.page === page); button.setAttribute('aria-current', button.dataset.page === page ? 'page' : 'false'); }
  for (const name of ['overview', 'quota', 'usage']) $('page-' + name).hidden = name !== page;
  $('overview-analysis').hidden = page !== 'overview';
  $('usage-filters').hidden = $('usage-summary').hidden = page === 'quota';
  $('tip').hidden = true;
  if (current) render(current);
  window.scrollTo(0, 0);
}
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  $('theme-label').textContent = theme === 'light' ? '切换深色' : '切换浅色';
  $('theme-toggle').setAttribute('aria-label', $('theme-label').textContent);
}
applyTheme();
$('theme-toggle').addEventListener('click', () => { theme = theme === 'light' ? 'dark' : 'light'; applyTheme(); try { localStorage.setItem('tokenpulse-theme', theme); } catch {} });
for (const button of document.querySelectorAll('[data-page], [data-go]')) button.addEventListener('click', () => navigate(button.dataset.page || button.dataset.go));
document.querySelector('.brand').addEventListener('click', e => { e.preventDefault(); navigate('overview'); });
$('daily-range').addEventListener('click', event => {
  const button = event.target.closest('[data-days]'); if (!button) return;
  state.days = Number(button.dataset.days); state.tablePage = 0;
  for (const item of $('daily-range').children) { item.classList.toggle('on', item === button); item.setAttribute('aria-pressed', item === button); }
  $('custom-range').hidden = true; if (current) render(current);
});
$('custom-range-toggle').addEventListener('click', () => { $('custom-range').hidden = !$('custom-range').hidden; });
$('custom-range').addEventListener('submit', event => {
  event.preventDefault(); const from = $('date-from').value, to = $('date-to').value;
  if (!from || !to || from > to || to > D.dayKey(Date.now()) || D.dayCount(from, to) > 366) { showStatus('请选择有效日期范围，最多 366 天，结束日期不能晚于今天。', true); return; }
  state.from = from; state.to = to; state.days = 'custom'; state.tablePage = 0;
  for (const button of $('daily-range').children) button.classList.toggle('on', button.id === 'custom-range-toggle');
  $('app-status').hidden = true; if (current) render(current);
});
$('source-filter').addEventListener('change', event => { state.source = event.target.value; state.tablePage = 0; if (current) render(current); });
$('chart-metric').addEventListener('click', event => { const button = event.target.closest('[data-metric]'); if (!button) return; state.metric = button.dataset.metric; for (const item of $('chart-metric').children) { item.classList.toggle('on', item === button); item.setAttribute('aria-pressed', item === button); } if (analysis) chart($('daily-chart'), analysis.daily, state.metric); });
$('account-tabs').addEventListener('click', event => { const button = event.target.closest('[data-account]'); if (!button) return; state.account = button.dataset.account; if (current) renderQuota(); });
$('model-search').addEventListener('input', event => { state.search = event.target.value; state.tablePage = 0; if (analysis) renderRecords(); });
$('record-sort').addEventListener('change', event => { state.sort = event.target.value; state.tablePage = 0; if (analysis) renderRecords(); });
$('prev-page').addEventListener('click', () => { state.tablePage--; renderRecords(); });
$('next-page').addEventListener('click', () => { state.tablePage++; renderRecords(); });
$('export-csv').addEventListener('click', async () => {
  const button = $('export-csv'); button.disabled = true;
  try { if (await api.exportCsv(D.csv(filteredRecords))) showStatus(`已导出 ${number(filteredRecords.length)} 条明细。`); }
  catch { showStatus('导出失败，请检查保存位置是否可写。', true); }
  finally { button.disabled = !filteredRecords.length; }
});
$('refresh').addEventListener('click', async () => {
  const button = $('refresh'); button.disabled = true; button.classList.add('is-busy'); button.textContent = '正在刷新…'; button.setAttribute('aria-busy', 'true');
  $('app-status').hidden = true;
  try { const snapshot = await api.refresh(); $('app-status').setAttribute('role', 'status'); render(snapshot); }
  catch { showStatus('刷新失败，请重试并检查数据目录是否可写。', true); }
  finally { button.disabled = false; button.classList.remove('is-busy'); button.textContent = '刷新数据'; button.removeAttribute('aria-busy'); }
});
function openModal(id) {
  lastFocus = document.activeElement; $(id).hidden = false; document.body.classList.add('modal-open');
  document.querySelector('.workspace').inert = document.querySelector('.sidebar').inert = true;
  $(id + '-close').focus();
}
function closeModal(id) {
  $(id).hidden = true; document.body.classList.remove('modal-open');
  document.querySelector('.workspace').inert = document.querySelector('.sidebar').inert = false;
  lastFocus?.focus();
}
for (const id of ['settings', 'methodology']) {
  $(id + '-close').addEventListener('click', () => closeModal(id));
  $(id).addEventListener('click', event => { if (event.target === $(id)) closeModal(id); });
}
$('methodology-open').addEventListener('click', () => openModal('methodology'));
$('settings-open').addEventListener('click', async () => {
  try { const prefs = await api.readPrefs(); for (const key of ['autoLaunch', 'closeToTray', 'startMinimized']) $('pref-' + key).checked = Boolean(prefs[key]); $('pref-notifyAt').value = prefs.notifyAt; openModal('settings'); }
  catch { showStatus('设置读取失败，请重试。', true); }
});
for (const key of ['autoLaunch', 'closeToTray', 'startMinimized', 'notifyAt']) {
  $('pref-' + key).addEventListener('change', async event => {
    const input = event.target; const value = key === 'notifyAt' ? Math.min(100, Math.max(0, Number(input.value) || 0)) : input.checked;
    input.disabled = true; $('prefs-status').textContent = '正在保存…';
    try { const prefs = await api.writePrefs({ [key]: value }); if (key === 'notifyAt') input.value = prefs[key]; else input.checked = prefs[key]; $('prefs-status').textContent = '设置已保存'; }
    catch { if (key !== 'notifyAt') input.checked = !value; $('prefs-status').textContent = '保存失败，请检查数据目录权限'; }
    finally { input.disabled = false; }
  });
}
$('open-data').addEventListener('click', async () => { try { const error = await api.openDataDir(); if (error) $('prefs-status').textContent = '无法打开数据目录：' + error; } catch { $('prefs-status').textContent = '无法打开数据目录'; } });
document.addEventListener('keydown', event => {
  const modal = ['settings', 'methodology'].find(id => !$(id).hidden); if (!modal) return;
  if (event.key === 'Escape') { event.preventDefault(); closeModal(modal); }
  if (event.key === 'Tab') {
    const controls = [...$(modal).querySelectorAll('button:not(:disabled), input:not(:disabled)')];
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
  }
});
let width = 0;
new ResizeObserver(() => {
  const next = $('daily-chart').clientWidth;
  if (next && Math.abs(next - width) > 2 && analysis && state.page === 'overview') { width = next; chart($('daily-chart'), analysis.daily, state.metric); }
}).observe($('daily-chart'));
api.onSnapshot(render);
api.onError(message => showStatus(message, true));
api.snapshot().then(render).catch(() => showStatus('本地数据读取失败，请点击刷新重试。', true));
setInterval(() => { if (current && !document.hidden) render({ ...current, now: Date.now() }); }, 30000);
