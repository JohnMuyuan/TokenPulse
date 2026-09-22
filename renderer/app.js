'use strict';
const api = window.tokenpulse;
const D = window.PulseData;
const BRAND = window.PulseBrand;
const $ = id => document.getElementById(id);
const META = {
  chatgpt: { name: 'ChatGPT', brand: 'openai', source: 'Codex CLI' },
  claude: { name: 'Claude', brand: 'claude', source: 'Claude Code' },
  grok: { name: 'Grok', brand: 'grok', source: 'Grok Build' }
};
const BRAND_OF_SOURCE = { 'Claude Code': 'claude', 'Codex CLI': 'openai', 'Grok Build': 'grok' };
const HEALTH = { good: '节奏正常', warning: '留意用量', serious: '可能提前耗尽', critical: '额度紧张', unknown: '暂无数据' };
const state = { page: 'overview', days: 30, source: 'all', metric: 'tokens', account: 'chatgpt', from: '', to: '', search: '', sort: 'day', tablePage: 0 };
const RING = 2 * Math.PI * 44;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let current = null;
let analysis = null;
let filteredRecords = [];
let lastFocus = null;
let theme = 'light';
try { theme = localStorage.getItem('tokenpulse-theme') === 'dark' ? 'dark' : 'light'; } catch {}

/* ---------------- DOM 小工具 ---------------- */

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
function icon(name, cls = 'icon') {
  const node = svg('svg', { class: cls, 'aria-hidden': 'true' });
  node.append(svg('use', { href: '#i-' + name }));
  return node;
}
/** 官方品牌图标：有自带颜色的路径保留原色（Claude 橙），其余跟随 currentColor。 */
function brandSvg(brand) {
  const spec = BRAND[brand];
  const node = svg('svg', { class: 'brand-svg', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  if (!spec) return node;
  if (spec.rule) node.setAttribute('fill-rule', spec.rule);
  for (const path of spec.paths) node.append(svg('path', path.fill ? { d: path.d, fill: path.fill } : { d: path.d }));
  return node;
}
function avatar(kind, extra = '') {
  const brand = META[kind]?.brand || kind;
  return el('span', { class: `account-avatar ${kind} ${extra}`.trim(), 'aria-hidden': true }, [brandSvg(brand)]);
}
function sourceLogo(source) {
  const brand = BRAND_OF_SOURCE[source];
  return el('span', { class: 'account-avatar source-logo ' + (brand === 'claude' ? 'claude' : ''), 'aria-hidden': true }, [brandSvg(brand)]);
}
function miniLogo(source) {
  return el('span', { class: 'mini-logo', 'aria-hidden': true }, [brandSvg(BRAND_OF_SOURCE[source])]);
}

/* ---------------- 格式化 ---------------- */

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

/* ---------------- 动效 ---------------- */

let enterTimer = 0;
/** 页面入场：只在切页和首次渲染时打开，定时重绘不会重播。 */
function enter() {
  const main = $('main');
  main.classList.remove('entering');
  void main.offsetWidth;
  main.classList.add('entering');
  clearTimeout(enterTimer);
  enterTimer = setTimeout(() => main.classList.remove('entering'), 1700);
}
function entering() { return $('main').classList.contains('entering'); }

const shown = new Map();
/** 数字从上次显示的值滚到新值；值没变就直接写，不做动画。 */
function countTo(node, key, value, format) {
  const from = shown.get(key);
  shown.set(key, value);
  if (value == null || !Number.isFinite(value) || reducedMotion.matches || from === value || (from == null && !entering())) {
    node.textContent = format(value);
    return;
  }
  const start = performance.now(), origin = Number.isFinite(from) ? from : 0, span = 750;
  const step = now => {
    if (!node.isConnected) return;
    const t = Math.min(1, (now - start) / span), eased = 1 - Math.pow(1 - t, 3);
    node.textContent = format(t >= 1 ? value : origin + (value - origin) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  node.textContent = format(origin);
  requestAnimationFrame(step);
}

/** 分段控件的滑块：移动到当前选中的按钮下面。 */
function syncSeg(group) {
  const thumb = group.querySelector('.seg-thumb');
  const on = group.querySelector('button.on');
  if (!thumb) return;
  if (!on || !on.offsetWidth) { thumb.style.opacity = on ? '' : '0'; return; }
  thumb.style.opacity = '1';
  thumb.style.width = `${on.offsetWidth}px`;
  thumb.style.transform = `translateX(${on.offsetLeft}px)`;
  if (!group.classList.contains('ready')) requestAnimationFrame(() => group.classList.add('ready'));
}
function syncSegs() { for (const group of document.querySelectorAll('.seg')) syncSeg(group); }
function moveIndicator() {
  const active = document.querySelector('#nav .nav-item.active');
  const bar = document.querySelector('.nav-indicator');
  if (!active || !bar) return;
  bar.style.height = `${active.offsetHeight}px`;
  bar.style.transform = `translateY(${active.offsetTop}px)`;
}

/* ---------------- 状态 ---------------- */

function showStatus(message, error = false) { $('app-status').textContent = message; $('app-status').hidden = false; $('app-status').setAttribute('role', error ? 'alert' : 'status'); }
function empty(message) { return el('div', { class: 'empty', text: message }); }
function track(pct, warning = false, label = '已用额度') {
  const fill = el('span', { class: 'track-fill' + (pct >= 90 ? ' critical' : warning ? ' warning' : '') });
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  return el('div', { class: 'track', role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.min(100, Math.max(0, pct)) }, [fill]);
}
function isStale(account) { return !account?.lastSampleAt || Date.now() - account.lastSampleAt > 15 * 60000; }
function waitingReset(account, window) { return window?.startAt != null && account?.lastSampleAt < window.startAt; }
function prediction(window, account) {
  if (!window) return '暂无窗口数据';
  if (waitingReset(account, window)) return '窗口已重置，等待新采样确认';
  if (isStale(account)) return '采样已过期，刷新后再判断';
  if (window.used >= 100) return '额度已用完，请等待重置';
  if (window.runsOutBeforeReset && window.etaAt) return `按平均速度，约 ${duration(window.etaAt - Date.now())}后用完`;
  if (window.projectedAtReset != null) return `按平均速度，重置时预计已用 ${percent(window.projectedAtReset)}`;
  return '采样尚少，暂不预测耗尽时间';
}

/* ---------------- 总览：额度卡片 ---------------- */

function ring(remaining, level) {
  const node = svg('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' });
  node.append(svg('circle', { class: 'ring-track', cx: 50, cy: 50, r: 44 }));
  if (remaining != null) {
    const value = Math.max(0, Math.min(100, remaining));
    node.append(svg('circle', { class: 'ring-value', cx: 50, cy: 50, r: 44, 'stroke-dasharray': RING, 'stroke-dashoffset': RING * (1 - value / 100) }));
  }
  return el('div', { class: 'ring ' + level }, [node]);
}
function quotaCard(kind) {
  const account = current.accounts.find(a => a.kind === kind);
  const meta = META[kind];
  const stale = account && isStale(account);
  // 首页优先展示剩余最少的有效窗口，避免周额度充足掩盖 5 小时窗口即将耗尽。
  const windows = [account?.five, account?.week].filter(Boolean);
  const report = windows.filter(win => !waitingReset(account, win)).sort((a, b) => b.used - a.used)[0] || windows[0];
  const waiting = report && waitingReset(account, report);
  const head = el('div', { class: 'account-head' }, [
    avatar(kind),
    el('div', { class: 'account-title' }, [el('span', { class: 'account-name', text: meta.name }), el('span', { class: 'plan', text: account?.plan || meta.source })]),
    el('span', { class: 'badge ' + (!stale && !waiting ? account?.health.level || '' : ''), text: !account ? '暂无采样' : waiting ? '等待新采样' : stale ? '采样已过期' : HEALTH[account.health.level] })
  ]);
  const body = [head];
  if (account && (account.five || account.week)) {
    const remainingPct = report && !waiting ? Math.max(0, 100 - report.used) : null;
    const level = remainingPct == null ? '' : report.used >= 90 ? 'critical' : report.runsOutBeforeReset ? 'warning' : '';
    const value = el('div', { class: 'quota-remaining' + (remainingPct == null ? ' empty-number' : ''), text: remainingPct == null ? '—' : remainingPct.toFixed(1) }, remainingPct == null ? [] : [el('small', { text: '%' })]);
    const windowLabel = report === account.week ? '周额度' : '5 小时额度';
    const hero = el('div', { class: 'quota-hero-text' }, [
      el('span', { class: 'quota-hero-label', text: `${stale ? '上次' : ''}${windowLabel}剩余` }),
      el('span', { class: 'quota-hero-value', text: waiting ? '等待新采样' : report?.resetAt ? `${duration(report.resetAt - Date.now())}后重置` : '重置时间未知' }),
      el('span', { class: 'quota-hero-sub', text: report?.resetAt && !waiting ? `${date(report.resetAt)} · 本地时间` : '旧窗口已结束' })
    ]);
    const ringNode = ring(remainingPct, level);
    ringNode.append(el('div', { class: 'ring-center' }, [value]));
    body.push(el('div', { class: 'quota-hero' }, [ringNode, hero]));
    for (const [label, win] of [['5 小时', account.five], ['周额度', account.week]]) {
      if (!win) continue;
      const pending = waitingReset(account, win);
      body.push(el('div', { class: 'quota-mini' }, [
        el('div', { class: 'quota-mini-head' }, [el('span', { text: label }), el('span', { class: 'num', text: pending ? '等待确认' : `已用 ${percent(win.used)}` })]),
        pending ? el('div', { class: 'track' }) : track(win.used, win.runsOutBeforeReset),
        el('div', { class: 'mini-reset' }, [icon('clock'), pending ? '旧窗口已结束，正在等待新数据' : win.resetAt ? `${duration(win.resetAt - Date.now())}后重置 · ${date(win.resetAt)}` : '接口未提供重置时间'])
      ]));
    }
  } else {
    const ringNode = ring(null, '');
    ringNode.append(el('div', { class: 'ring-center' }, [el('div', { class: 'quota-remaining empty-number', text: '—' })]));
    body.push(el('div', { class: 'quota-hero' }, [ringNode, el('div', { class: 'quota-hero-text' }, [el('span', { class: 'quota-hero-label', text: '额度剩余' }), el('span', { class: 'quota-hero-value', text: '尚未取得官方额度' })])]));
    body.push(el('div', { class: 'quota-missing' }, [el('p', { text: '可能尚未登录、凭据过期或网络未连通。本机用量仍正常记录。' })]));
  }
  const link = el('button', { class: 'text-btn', 'aria-label': `${meta.name} 额度详情` }, ['详情', icon('arrow')]);
  link.addEventListener('click', () => { state.account = kind; navigate('quota'); });
  const forecast = !stale && !waiting && report?.used >= 100 ? '额度已用完，等待重置'
    : !stale && !waiting && report?.etaAt && report.runsOutBeforeReset ? `约 ${duration(report.etaAt - Date.now())}后用完`
    : !stale && !waiting && report?.projectedAtReset != null ? `重置时预计已用 ${percent(report.projectedAtReset)}`
    : `${date(account?.lastSampleAt)} 采样`;
  body.push(el('div', { class: 'quota-card-foot' }, [el('span', { text: account ? forecast : `${meta.source} 本地凭据` }), link]));
  return el('article', { class: 'quota-card ' + kind }, body);
}

/* ---------------- 用量统计 ---------------- */

function updateRange() {
  if (state.days !== 'custom') { state.to = D.dayKey(current.now); state.from = D.shift(state.to, 1 - state.days); }
  $('range-label').textContent = `${state.from.replaceAll('-', '.')} — ${state.to.replaceAll('-', '.')}`;
  $('date-from').value = state.from; $('date-to').value = state.to;
  $('date-from').max = $('date-to').max = D.dayKey(current.now);
  analysis = D.analyze(current.usage || [], state.from, state.to, state.source);
}
function delta(now, previous) {
  if (!previous) return [now ? '上一时段无记录' : '暂无变化'];
  const pct = ((now - previous) / previous) * 100;
  return [el('span', { class: 'delta ' + (pct >= 0 ? 'up' : 'down'), text: `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` }), '较上一时段'];
}
function renderStats() {
  const t = analysis.total, p = analysis.previous;
  const cache = t.input ? t.cacheRead / t.input * 100 : null;
  const stats = [
    ['tokens', '总 Tokens', t.tokens, tokens, delta(t.tokens, p.tokens), '输入 + 输出'],
    ['cost', '参考费用', t.costUsd, money, analysis.unpriced ? [`${number(analysis.unpriced)} 次请求未定价`] : delta(t.costUsd, p.costUsd), 'USD'],
    ['requests', '请求次数', t.requests, number, delta(t.requests, p.requests), '次'],
    ['cache', '缓存读取占比', cache, percent, [`${tokens(t.cacheRead)} 缓存读取 / ${tokens(t.input)} 输入`], '输入口径']
  ];
  $('tiles').replaceChildren(...stats.map(([name, label, value, format, sub, unit]) => {
    const valueNode = el('div', { class: 'stat-value' });
    countTo(valueNode, 'stat:' + name, value, format);
    return el('article', { class: 'stat' }, [
      el('div', { class: 'stat-label' }, [el('span', { class: 'stat-icon' }, [icon(name)]), el('span', { text: label }), el('span', { class: 'stat-unit', text: unit })]),
      valueNode,
      el('div', { class: 'stat-sub' }, sub)
    ]);
  }));
}

/* ---------------- 图表 ---------------- */

function tipAt(text, x, y) {
  const tip = $('tip'); tip.textContent = text; tip.hidden = false;
  tip.style.left = `${Math.max(8, Math.min(x + 14, window.innerWidth - tip.offsetWidth - 12))}px`;
  tip.style.top = `${Math.max(8, Math.min(y + 12, window.innerHeight - tip.offsetHeight - 12))}px`;
}
function playChart(host, animate) {
  if (!animate || reducedMotion.matches) return;
  host.classList.remove('chart-enter'); void host.offsetWidth; host.classList.add('chart-enter');
  clearTimeout(host._enterTimer);
  host._enterTimer = setTimeout(() => host.classList.remove('chart-enter'), 2000);
}
function chart(host, rows, metric = 'tokens', hourly = false, animate = entering()) {
  host.replaceChildren();
  if (!rows.length) { host.append(empty('所选范围暂无记录')); return; }
  const w = Math.max(280, host.clientWidth), h = host.clientHeight || 220, left = 48, bottom = 28, top = 14;
  const max = Math.max(1, ...rows.map(row => row[metric] || 0));
  const node = svg('svg', { viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': hourly ? '最近24小时用量柱状图' : '每日用量柱状图' });
  const fmt = metric === 'costUsd' ? money : metric === 'requests' ? number : tokens;
  for (let i = 0; i <= 2; i++) {
    const y = top + (h - top - bottom) * i / 2;
    node.append(svg('line', { class: 'grid', x1: left, x2: w - 5, y1: y, y2: y }));
    const label = svg('text', { class: 'axis', x: left - 9, y: y + 4, 'text-anchor': 'end' });
    label.textContent = max === 1 && i === 1 ? '' : fmt(max * (1 - i / 2)); node.append(label);
  }
  const slot = (w - left - 8) / rows.length, barWidth = Math.max(.5, Math.min(slot * .62, 30));
  const step = Math.min(16, 700 / rows.length);
  const today = D.dayKey(Date.now());
  rows.forEach((row, i) => {
    const barHeight = Math.max(row[metric] > 0 ? 2 : 0, ((row[metric] || 0) / max) * (h - top - bottom));
    const x = left + i * slot + (slot - barWidth) / 2;
    const label = hourly ? `${new Date(row.hour).getHours()}:00` : row.day;
    const text = `${hourly ? date(row.hour) : label}\n${tokens(row.tokens)} Tokens\n${money(row.costUsd)} · ${number(row.requests)} 次请求`;
    const rect = svg('rect', { class: 'col' + (row.day === today ? ' today' : ''), x, y: h - bottom - barHeight, width: barWidth, height: barHeight, rx: Math.min(4, barWidth / 2), tabindex: 0, 'aria-label': text });
    rect.style.animationDelay = `${Math.round(i * step)}ms`;
    rect.addEventListener('pointermove', e => tipAt(text, e.clientX, e.clientY));
    rect.addEventListener('pointerleave', () => { $('tip').hidden = true; });
    rect.addEventListener('focus', () => { const box = rect.getBoundingClientRect(); tipAt(text, box.x, box.y); });
    rect.addEventListener('blur', () => { $('tip').hidden = true; });
    node.append(rect);
    if (i % Math.max(1, Math.ceil(rows.length / 7)) === 0 || i === rows.length - 1) {
      const tick = svg('text', { class: 'axis', x: x + barWidth / 2, y: h - 6, 'text-anchor': 'middle' }); tick.textContent = hourly ? label : label.slice(5); node.append(tick);
    }
  });
  host.append(node);
  playChart(host, animate);
}

/* ---------------- 总览 ---------------- */

function renderOverview() {
  $('quota-cards').replaceChildren(...Object.keys(META).map(quotaCard));
  chart($('daily-chart'), analysis.daily, state.metric);
  const t = analysis.total, n = analysis.daily.length || 1;
  const peak = [...analysis.daily].sort((a, b) => b.tokens - a.tokens)[0];
  $('chart-summary').replaceChildren(el('span', {}, ['日均', el('b', { text: tokens(t.tokens / n) + ' Tokens' })]), el('span', {}, ['活跃天数', el('b', { text: `${analysis.activeDays} / ${n} 天` })]));
  const rhythms = [['日均请求', `${number(t.requests / n)} 次`], ['单次平均用量', t.requests ? `${tokens(t.tokens / t.requests)} Tokens` : '—'], ['用量最高的一天', peak?.tokens ? peak.day.slice(5).replace('-', ' / ') : '—'], ['峰值用量', peak?.tokens ? tokens(peak.tokens) : '—']];
  $('rhythm').replaceChildren(...rhythms.map(([label, value], i) => stagger(el('div', { class: 'rhythm-row' }, [el('span', { text: label }), el('b', { text: value })]), i)), el('p', { class: 'rhythm-note', text: '平均值包含没有使用的日期。对比上一段等长时间，今天的记录仍在累积。' }));
  const sources = [...analysis.sources].sort((a, b) => b.tokens - a.tokens);
  $('sources').replaceChildren(...(sources.length ? sources.map((row, i) => {
    const share = t.tokens ? row.tokens / t.tokens * 100 : 0;
    return stagger(el('div', { class: 'source-row ' + (BRAND_OF_SOURCE[row.source] || '') }, [
      sourceLogo(row.source),
      el('div', {}, [
        el('div', { class: 'source-top' }, [el('span', { text: row.source }), el('span', { class: 'share', text: percent(share) })]),
        track(share, false, '工具 token 占比'),
        el('div', { class: 'source-bottom' }, [el('span', { text: `${tokens(row.tokens)} Tokens · ${number(row.requests)} 次` }), el('span', { text: money(row.costUsd) })])
      ])
    ]), i);
  }) : [empty('所选范围还没有工具用量')]));
  const models = [...analysis.models].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
  $('model-ranking').replaceChildren(...(models.length ? models.map((row, i) => stagger(el('div', { class: 'rank-row' }, [
    el('span', { class: 'rank-number', text: String(i + 1).padStart(2, '0') }),
    sourceLogo(row.source),
    el('div', { class: 'rank-body' }, [el('div', { class: 'rank-name', text: row.model, title: row.model }), el('div', { class: 'rank-meta', text: row.source })]),
    el('div', { class: 'rank-value' }, [tokens(row.tokens), el('div', { class: 'rank-meta', text: row.unpriced ? '部分未定价' : money(row.costUsd) })])
  ]), i)) : [empty('所选范围还没有模型用量')]));
}
function stagger(node, i) { node.style.setProperty('--i', i); return node; }

/* ---------------- 额度详情 ---------------- */

function detailItem(label, value) { return el('div', { class: 'detail-item' }, [el('small', { text: label }), el('b', { class: 'num', text: value })]); }
function windowPanel(label, report, account) {
  const panel = el('article', { class: 'panel' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: label }), el('span', { class: 'section-tag', text: '官方额度窗口' })])]);
  if (!report) { panel.append(empty('接口未提供此窗口')); return panel; }
  const pending = waitingReset(account, report), stale = isStale(account);
  panel.append(el('div', { class: 'window-number' }, [el('strong', { text: pending ? '—' : percent(Math.max(0, 100 - report.used)) }), el('span', { text: stale ? '上次采样剩余' : '剩余额度' })]));
  const bar = pending ? el('div', { class: 'track' }) : track(report.used, report.runsOutBeforeReset); bar.classList.add('window-track'); panel.append(bar);
  panel.append(el('div', { class: 'window-meta' }, [el('span', { text: pending ? '等待采样确认' : `已用 ${percent(report.used)}` }), el('span', { text: report.resetAt ? `${duration(report.resetAt - Date.now())}后重置` : '重置时间未知' })]));
  const caution = report.runsOutBeforeReset || stale || pending;
  panel.append(el('div', { class: 'prediction-line' + (caution ? ' caution' : '') }, [icon(caution ? 'alert' : 'trend'), prediction(report, account)]));
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
function trendChart(host, points, animate) {
  if (points.length < 3 || points.at(-1).at - points[0].at < 3600000) { host.append(empty('采样跨度不足 1 小时，继续记录后显示趋势')); return; }
  const w = 360, h = 172, from = points[0].at, span = points.at(-1).at - from;
  const node = svg('svg', { viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': '当前周窗口的额度已用百分比' });
  for (const pct of [0, 50, 100]) {
    const y = 140 - pct * 1.2; node.append(svg('line', { class: 'grid', x1: 34, x2: 350, y1: y, y2: y }));
    const text = svg('text', { class: 'axis', x: 28, y: y + 4, 'text-anchor': 'end' }); text.textContent = pct + '%'; node.append(text);
  }
  const xy = points.map(p => [34 + (p.at - from) / span * 316, 140 - Math.min(100, p.pct) * 1.2]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  node.append(svg('path', { class: 'trend-area', d: `${line} L${xy.at(-1)[0].toFixed(1)},140 L${xy[0][0].toFixed(1)},140 Z` }));
  node.append(svg('path', { class: 'trend-line', d: line, pathLength: 1, 'stroke-dasharray': 1 }));
  node.append(svg('circle', { class: 'trend-dot', cx: xy.at(-1)[0], cy: xy.at(-1)[1], r: 4 }));
  for (const [at, x, anchor] of [[from, 34, 'start'], [points.at(-1).at, 350, 'end']]) { const text = svg('text', { class: 'axis', x, y: 164, 'text-anchor': anchor }); text.textContent = date(at); node.append(text); }
  host.append(node);
  playChart(host, animate);
}
function renderQuota() {
  const host = $('quota-detail'); host.replaceChildren();
  for (const button of $('account-tabs').querySelectorAll('button')) { button.classList.toggle('on', button.dataset.account === state.account); button.setAttribute('aria-pressed', button.dataset.account === state.account); }
  syncSeg($('account-tabs'));
  const account = current.accounts.find(a => a.kind === state.account), meta = META[state.account];
  const sessions = current.sessions[state.account] || { included: 0, excluded: 0 };
  host.append(el('div', { class: 'quota-context' }, [
    avatar(state.account),
    el('div', {}, [el('h2', { text: meta.name + (account?.plan ? ' · ' + account.plan : '') }), el('p', { class: 'muted', text: `${number(sessions.included)} 个官方会话 · ${number(sessions.excluded)} 个中转 / API Key 会话未计入额度` })]),
    el('div', { class: 'context-meta', text: account ? `${date(account.lastSampleAt)} 更新 · ${number(account.sampleCount)} 个采样点` : '尚无额度采样' })
  ]));
  if (!account) {
    host.append(el('article', { class: 'panel empty large' }, [el('h3', { text: '暂时还没有这个账号的额度数据' }), el('p', { text: `确认 ${meta.source} 已登录官方账号，然后点击「刷新数据」。` }), el('p', { text: '凭据过期或网络错误也可能导致采样失败；这不会影响本机用量统计。' })])); return;
  }
  if (isStale(account)) host.append(el('p', { class: 'stale-note' }, [icon('alert'), `上次采样是 ${date(account.lastSampleAt, true)}，已超过 15 分钟。以下是历史记录，当前剩余额度需刷新确认。`]));
  host.append(el('div', { class: 'quota-window-grid' }, [windowPanel('5 小时窗口', account.five, account), windowPanel('周额度窗口', account.week, account)]));
  const hourly = el('div', { class: 'chart' });
  const history = el('article', { class: 'panel' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '最近 24 小时 · 官方会话用量' })]), hourly, el('p', { class: 'sample-caption', text: '仅统计本机归属该官方账号的会话。横轴按本地时间，含当前未结束的小时。' })]);
  const trend = el('div', { class: 'chart quota-trend' });
  const trendPanel = el('article', { class: 'panel' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '本周额度采样' })]), trend, el('p', { class: 'sample-caption', text: `手动重置次数：${account.resetCredits ?? '接口未提供'} · 活跃时间占比：${account.week?.activeShare == null ? '样本不足' : percent(account.week.activeShare * 100)}` })]);
  host.append(el('div', { class: 'quota-history-grid' }, [history, trendPanel]));
  const animate = entering();
  chart(hourly, account.hourly, 'tokens', true, animate);
  trendChart(trend, account.trend, animate);
}

/* ---------------- 用量明细 ---------------- */

function renderRecords() {
  const q = state.search.trim().toLowerCase();
  filteredRecords = analysis.selected.filter(row => !q || `${row.model} ${row.source}`.toLowerCase().includes(q)).sort((a, b) => state.sort === 'day' ? b.day.localeCompare(a.day) || b.tokens - a.tokens : b[state.sort] - a[state.sort] || b.day.localeCompare(a.day));
  const pageSize = 15, pages = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
  state.tablePage = Math.min(state.tablePage, pages - 1);
  const visible = filteredRecords.slice(state.tablePage * pageSize, (state.tablePage + 1) * pageSize);
  $('record-count').textContent = `${number(filteredRecords.length)} 条`;
  $('export-csv').disabled = !filteredRecords.length;
  $('records').replaceChildren(...visible.map((row, i) => stagger(el('tr', {}, [
    el('td', {}, [row.day, el('small', {}, [miniLogo(row.source), row.source])]), el('td', { class: 'model-cell', text: row.model, title: row.model }),
    ...['requests', 'input', 'output', 'cacheRead', 'tokens'].map(key => el('td', { class: 'n' + (key === 'tokens' ? ' token-strong' : ''), text: key === 'requests' ? number(row[key]) : tokens(row[key]), title: number(row[key]) })),
    el('td', { class: 'n', text: row.priced === false ? '未定价' : money(row.costUsd) })
  ]), i)));
  if (!visible.length) $('records').append(el('tr', {}, [el('td', { colspan: 8, class: 'empty', text: '没有匹配的记录，试试其他时间、工具或关键词。' })]));
  $('pagination-label').textContent = `第 ${state.tablePage + 1} / ${pages} 页 · 共 ${number(filteredRecords.length)} 条匹配明细`;
  $('prev-page').disabled = state.tablePage === 0; $('next-page').disabled = state.tablePage >= pages - 1;
}
function renderUsage() {
  const t = analysis.total;
  $('token-breakdown').replaceChildren(...[['输入 Tokens', 'input', '含缓存读取与写入'], ['输出 Tokens', 'output', '含推理 Tokens'], ['缓存读取', 'cacheRead', '输入的一部分'], ['缓存写入', 'cacheWrite', '输入的一部分'], ['推理 Tokens', 'reasoning', '输出的一部分']].map(([label, key, note]) => {
    const value = el('strong', { title: number(t[key]) });
    countTo(value, 'breakdown:' + key, t[key], tokens);
    return el('div', { class: 'breakdown-item' }, [el('small', { text: label }), value, el('span', { text: note })]);
  }));
  renderRecords();
}

/* ---------------- 渲染与导航 ---------------- */

function render(snapshot) {
  const first = !current;
  current = snapshot;
  if (first) enter();
  if ($('app-status').getAttribute('role') !== 'alert') $('app-status').hidden = true;
  updateRange(); renderStats();
  if (state.page === 'overview') renderOverview();
  if (state.page === 'quota') renderQuota();
  if (state.page === 'usage') renderUsage();
  $('today-label').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  $('stamp').textContent = snapshot.scannedAt ? `${date(snapshot.scannedAt)} 已更新` : '正在扫描本地会话…';
  $('data-summary').textContent = `${number(snapshot.fileCount || 0)} 个会话文件 · ${number(snapshot.totals.all.requests)} 次历史请求 · 本机时区`;
  syncSegs();
}
function navigate(page) {
  if (!['overview', 'quota', 'usage'].includes(page)) page = 'overview';
  state.page = page;
  const labels = { overview: ['总览', '今天的用量与额度', '看看还剩多少额度，再安排接下来的工作。'], quota: ['额度详情', '把使用节奏，放在时间里看', '剩余额度、重置时间与耗尽预测，集中在这里。'], usage: ['用量明细', '每一笔用量，都有迹可循', '按日期、工具与模型查看消耗，找到值得关注的变化。'] }[page];
  ['page-label', 'page-title', 'page-description'].forEach((id, i) => { $(id).textContent = labels[i]; });
  for (const button of document.querySelectorAll('[data-page]')) { button.classList.toggle('active', button.dataset.page === page); button.setAttribute('aria-current', button.dataset.page === page ? 'page' : 'false'); }
  moveIndicator();
  for (const name of ['overview', 'quota', 'usage']) $('page-' + name).hidden = name !== page;
  $('overview-analysis').hidden = page !== 'overview';
  $('usage-filters').hidden = $('usage-summary').hidden = page === 'quota';
  $('tip').hidden = true;
  enter();
  if (current) render(current);
  syncSegs();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
let themeTimer = 0;
function applyTheme(animate = false) {
  if (animate && !reducedMotion.matches) {
    document.documentElement.classList.add('theme-anim');
    clearTimeout(themeTimer);
    themeTimer = setTimeout(() => document.documentElement.classList.remove('theme-anim'), 450);
  }
  document.documentElement.dataset.theme = theme;
  $('theme-label').textContent = theme === 'light' ? '切换深色' : '切换浅色';
  $('theme-toggle').setAttribute('aria-label', $('theme-label').textContent);
  $('theme-toggle').title = $('theme-label').textContent;
  // 主进程据此设置窗口底色，避免拉伸窗口时露出另一种主题的底。
  api.setTheme?.(theme).catch(() => {});
}

/* ---------------- 事件 ---------------- */

for (const slot of document.querySelectorAll('[data-brand]')) slot.append(brandSvg(slot.dataset.brand));
applyTheme();
moveIndicator();
$('theme-toggle').addEventListener('click', () => { theme = theme === 'light' ? 'dark' : 'light'; applyTheme(true); try { localStorage.setItem('tokenpulse-theme', theme); } catch {} });
for (const button of document.querySelectorAll('[data-page], [data-go]')) button.addEventListener('click', () => navigate(button.dataset.page || button.dataset.go));
document.querySelector('.brand').addEventListener('click', e => { e.preventDefault(); navigate('overview'); });
$('daily-range').addEventListener('click', event => {
  const button = event.target.closest('[data-days]'); if (!button) return;
  state.days = Number(button.dataset.days); state.tablePage = 0;
  for (const item of $('daily-range').querySelectorAll('button')) { item.classList.toggle('on', item === button); item.setAttribute('aria-pressed', item === button); }
  $('custom-range').hidden = true;
  syncSeg($('daily-range'));
  if (current) { render(current); if (state.page === 'overview') playChart($('daily-chart'), true); }
});
$('custom-range-toggle').addEventListener('click', () => { $('custom-range').hidden = !$('custom-range').hidden; });
$('custom-range').addEventListener('submit', event => {
  event.preventDefault(); const from = $('date-from').value, to = $('date-to').value;
  if (!from || !to || from > to || to > D.dayKey(Date.now()) || D.dayCount(from, to) > 366) { showStatus('请选择有效日期范围，最多 366 天，结束日期不能晚于今天。', true); return; }
  state.from = from; state.to = to; state.days = 'custom'; state.tablePage = 0;
  for (const button of $('daily-range').querySelectorAll('button')) button.classList.toggle('on', button.id === 'custom-range-toggle');
  $('app-status').hidden = true;
  if (current) { render(current); if (state.page === 'overview') playChart($('daily-chart'), true); }
});
$('source-filter').addEventListener('change', event => { state.source = event.target.value; state.tablePage = 0; if (current) render(current); });
$('chart-metric').addEventListener('click', event => {
  const button = event.target.closest('[data-metric]'); if (!button) return;
  state.metric = button.dataset.metric;
  for (const item of $('chart-metric').querySelectorAll('button')) { item.classList.toggle('on', item === button); item.setAttribute('aria-pressed', item === button); }
  syncSeg($('chart-metric'));
  if (analysis) chart($('daily-chart'), analysis.daily, state.metric, false, true);
});
$('account-tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-account]'); if (!button) return;
  state.account = button.dataset.account;
  if (current) { enter(); renderQuota(); }
});
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
  const button = $('refresh'); button.disabled = true; button.classList.add('is-busy'); $('refresh-label').textContent = '正在刷新…'; button.setAttribute('aria-busy', 'true');
  $('app-status').hidden = true;
  try { const snapshot = await api.refresh(); $('app-status').setAttribute('role', 'status'); render(snapshot); }
  catch { showStatus('刷新失败，请重试并检查数据目录是否可写。', true); }
  finally { button.disabled = false; button.classList.remove('is-busy'); $('refresh-label').textContent = '刷新数据'; button.removeAttribute('aria-busy'); }
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
  if (next && Math.abs(next - width) > 2 && analysis && state.page === 'overview') { width = next; chart($('daily-chart'), analysis.daily, state.metric, false, entering()); }
}).observe($('daily-chart'));
window.addEventListener('resize', () => { moveIndicator(); syncSegs(); });
api.onSnapshot(render);
api.onError(message => showStatus(message, true));
api.snapshot().then(render).catch(() => showStatus('本地数据读取失败，请点击刷新重试。', true));
setInterval(() => { if (current && !document.hidden) render({ ...current, now: Date.now() }); }, 30000);
