'use strict';
const api = window.tokenpulse;
const D = window.PulseData;
const BRAND = window.PulseBrand;
const $ = id => document.getElementById(id);
/** 日期格式跟着界面语言走。 */
function dateLocale() { return window.PulseI18n?.lang() === 'en' ? 'en-US' : 'zh-CN'; }
const META = {
  chatgpt: { name: 'ChatGPT', brand: 'openai', source: 'Codex CLI' },
  claude: { name: 'Claude', brand: 'claude', source: 'Claude Code' },
  grok: { name: 'Grok', brand: 'grok', source: 'Grok Build' }
};
const OAUTH_META = {
  chatgpt: { name: 'ChatGPT', brand: 'openai' },
  claude: { name: 'Claude', brand: 'claude' },
  grok: { name: 'Grok', brand: 'grok' }
};
const BRAND_OF_SOURCE = { 'Claude Code': 'claude', 'Codex CLI': 'openai', 'Grok Build': 'grok' };
const HEALTH = { good: '节奏正常', warning: '用量偏高', serious: '重置前压力较高', critical: '当前窗口紧张', unknown: '暂无数据' };
const state = { page: 'overview', days: 30, follow: false, capWindow: 'week', capMetric: 'tokens', source: 'all', metric: 'tokens', account: 'chatgpt', from: '', to: '', search: '', sort: 'day', tablePage: 0, reqStatus: 'all', reqSearch: '', reqSort: 'time', reqPage: 0, reqAccount: '', usageView: 'requests' };
const RING = 2 * Math.PI * 44;
const INNER_RING = 2 * Math.PI * 34;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let current = null;
let analysis = null;
let filteredRecords = [];
let lastFocus = null;
/** 外观模式：light / dark / system。存模式而不是最终颜色 —— 选「跟随系统」后，Windows 一切换深浅这边就要跟着变。 */
const THEME_KEY = 'tokenpulse-theme';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let themeMode = 'light';
try { const stored = localStorage.getItem(THEME_KEY); if (['light', 'dark', 'system'].includes(stored)) themeMode = stored; } catch {}

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
/** 没有官方图标的来源（OpenCode 等从 CC Switch 导入的）用首字母。 */
function letterMark(source) { return el('b', { class: 'letter-mark', text: String(source || '?').trim().charAt(0).toUpperCase() }); }
function sourceLogo(source) {
  const brand = BRAND_OF_SOURCE[source];
  return el('span', { class: 'account-avatar source-logo ' + (brand === 'claude' ? 'claude' : ''), 'aria-hidden': true }, [brand ? brandSvg(brand) : letterMark(source)]);
}
function miniLogo(source) {
  const brand = BRAND_OF_SOURCE[source];
  return el('span', { class: 'mini-logo', 'aria-hidden': true }, [brand ? brandSvg(brand) : letterMark(source)]);
}

/** 设置页的官方账号列表。数据来自主进程，不含任何凭据。 */
function renderOfficialAccounts(statuses = []) {
  const host = $('official-accounts');
  host.replaceChildren(...statuses.map(status => {
    const meta = OAUTH_META[status.kind] || { name: status.kind };
    const add = status.installed
      ? el('button', { class: 'btn btn-accent', 'data-account-action': 'login', 'data-account-kind': status.kind }, [icon('plus'), '添加账号'])
      : el('span', { class: 'oauth-card-state', text: '未检测到官方 CLI' });
    const sortable = status.accounts.length > 1;
    const rows = status.accounts.map(account => {
      const email = account.email || account.label;
      const name = account.alias || email;
      const state = account.hidden ? '已隐藏'
        : account.needsLogin ? '需重新登录'
        : !account.usable ? (account.autoRenew ? '等待自动续期' : '凭据已过期')
        : account.inCli ? 'CLI 当前登录' : '已保存';
      const tool = (action, iconName, label, extra = {}) => el('button', {
        type: 'button', class: 'btn icon-only oauth-tool' + (action === 'remove' ? ' danger' : ''), 'data-account-action': action, 'data-account-id': account.id, title: label, 'aria-label': `${label}：${name}`, ...extra
      }, [icon(iconName)]);
      const actions = account.hidden
        ? [el('button', { type: 'button', class: 'btn oauth-restore', 'data-account-action': 'restore', 'data-account-id': account.id, title: '重新查询并显示这个账号的额度' }, [icon('restore'), '恢复'])]
        : [
          tool('rename', 'edit', '重命名'),
          // CLI 还登录着的账号删不掉（下次读 CLI 又回来了），只能隐藏：提示里说清楚
          tool('remove', 'trash', account.inCli ? '隐藏（CLI 还登录着这个账号）' : '删除', { 'data-in-cli': account.inCli ? '1' : '' })
        ];
      // 拖动的把手：鼠标按住拖；键盘聚焦后用上下方向键
      const grip = sortable ? el('button', { type: 'button', class: 'oauth-grip', 'data-grip': account.id, title: '拖动调整顺序', 'aria-label': `调整顺序：${name}（按住拖动，或用上下方向键）` }, [icon('grip')])
        // 只有一个账号不用排序，但占住把手的位置，和别家的名字对齐
        : el('span', { class: 'oauth-grip placeholder', 'aria-hidden': 'true' });
      return el('div', { class: 'oauth-account' + (account.usable ? '' : ' expired') + (account.hidden ? ' hidden-account' : '') + (sortable ? ' sortable' : ''), 'data-account-row': account.id }, [
        grip,
        el('span', { class: 'oauth-account-who' }, [
          el('span', { class: 'oauth-account-name', text: name, title: name, translate: 'no', 'data-alias': account.alias || '', 'data-email': email }),
          account.alias && email ? el('small', { class: 'oauth-account-email', text: email, title: email, translate: 'no' }) : null
        ]),
        account.autoRenew && !account.hidden ? el('span', { class: 'oauth-renew', text: '自动续期', title: '在过期前自动续期，不用重新登录' }) : null,
        el('span', { class: 'oauth-card-state' + (account.hidden ? '' : account.usable ? ' ok' : ' warn'), text: state }),
        el('span', { class: 'oauth-actions' }, actions)
      ]);
    });
    return el('div', { class: 'oauth-card' }, [
      el('div', { class: 'oauth-card-head' }, [avatar(status.kind), el('span', { class: 'oauth-card-title', text: meta.name }), add]),
      rows.length ? el('div', { class: 'oauth-account-list', 'data-kind': status.kind }, rows) : el('p', { class: 'oauth-empty', text: status.installed ? '还没有登录的账号' : '安装官方 CLI 后即可添加账号' })
    ]);
  }));
}

/* ---- 拖拽排序 ----
 * 按住把手上下拖：被拖的那行跟着鼠标走，其余的行让出位置（transform 动画，不改 DOM）；松手时才真的改 DOM 顺序并保存。
 * 用 pointer 事件自己做而不用 HTML5 拖放：原生拖放拖的是一张半透明截图，别的行也不会让位，手感差。
 */
let accountDrag = null;
function rowsOf(list) { return [...list.querySelectorAll(':scope > .oauth-account')]; }
async function saveAccountOrder(list, message = '已调整顺序') {
  const ids = rowsOf(list).map(row => row.dataset.accountRow);
  try {
    renderOfficialAccounts(await api.reorderOfficialAccounts(list.dataset.kind, ids));
    $('prefs-status').textContent = message;
  } catch (error) {
    $('prefs-status').textContent = cleanRemoteError(error, '顺序没保存上，请重试');
    loadOfficialAccounts();
  }
}
function cleanRemoteError(error, fallback) {
  return String(error?.message || fallback).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || fallback;
}
$('official-accounts').addEventListener('pointerdown', event => {
  const grip = event.target.closest('[data-grip]');
  if (!grip || event.button !== 0 || accountDrag) return;
  const row = grip.closest('.oauth-account'), list = row.parentElement, rows = rowsOf(list);
  event.preventDefault();
  grip.setPointerCapture(event.pointerId);
  grip.focus({ preventScroll: true });
  const rects = rows.map(item => item.getBoundingClientRect());
  const from = rows.indexOf(row);
  accountDrag = { grip, row, list, rows, rects, from, to: from, startY: event.clientY, moved: false };
  list.classList.add('sorting');
});
$('official-accounts').addEventListener('pointermove', event => {
  const d = accountDrag; if (!d) return;
  const origin = d.rects[d.from];
  const minTop = d.rects[0].top;
  const maxTop = d.rects.at(-1).top + d.rects.at(-1).height - origin.height;
  // 只能在这一家的列表里上下拖，拖出头就停在两端。行高不统一（起了名字的行更高），不能按固定步长算落点。
  const dy = Math.max(minTop - origin.top, Math.min(maxTop - origin.top, event.clientY - d.startY));
  if (!d.moved && Math.abs(event.clientY - d.startY) < 3) return;
  if (!d.moved) { d.moved = true; d.row.classList.add('dragging'); }
  d.row.style.transform = `translateY(${dy}px)`;
  const center = origin.top + origin.height / 2 + dy;
  let to = 0;
  for (let i = 0; i < d.rects.length; i++) {
    if (i === d.from) continue;
    if (center > d.rects[i].top + d.rects[i].height / 2) to += 1;
  }
  d.to = to;
  const gap = d.rects.length > 1 ? d.rects[1].top - d.rects[0].bottom : 0;
  const slot = origin.height + gap;
  d.rows.forEach((item, i) => {
    if (item === d.row) return;
    const shift = d.from < d.to && i > d.from && i <= d.to ? -slot : d.from > d.to && i < d.from && i >= d.to ? slot : 0;
    item.style.transform = shift ? `translateY(${shift}px)` : '';
  });
});
function endAccountDrag(commit) {
  const d = accountDrag; if (!d) return;
  accountDrag = null;
  d.list.classList.remove('sorting');
  d.row.classList.remove('dragging');
  // 先关掉过渡再清 transform、改 DOM 顺序：不然各行会从让位的位置再动画回去，闪一下
  d.list.classList.add('settling');
  for (const item of d.rows) item.style.transform = '';
  const changed = commit && d.moved && d.to !== d.from;
  if (changed) {
    const others = d.rows.filter(item => item !== d.row);
    others.splice(d.to, 0, d.row);
    d.list.append(...others);
  }
  requestAnimationFrame(() => d.list.classList.remove('settling'));
  if (changed) saveAccountOrder(d.list).then(() => $('official-accounts').querySelector(`[data-grip="${CSS.escape(d.row.dataset.accountRow)}"]`)?.focus({ preventScroll: true }));
}
$('official-accounts').addEventListener('pointerup', () => endAccountDrag(true));
$('official-accounts').addEventListener('pointercancel', () => endAccountDrag(false));
$('official-accounts').addEventListener('lostpointercapture', () => endAccountDrag(true));
// 键盘：把手聚焦时上下方向键挪一位，Esc 取消正在进行的拖动
$('official-accounts').addEventListener('keydown', event => {
  if (event.key === 'Escape' && accountDrag) { event.preventDefault(); event.stopPropagation(); endAccountDrag(false); return; }
  const grip = event.target.closest('[data-grip]');
  if (!grip || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const row = grip.closest('.oauth-account'), list = row.parentElement, rows = rowsOf(list);
  const at = rows.indexOf(row), to = at + (event.key === 'ArrowUp' ? -1 : 1);
  if (to < 0 || to >= rows.length) return;
  if (to < at) rows[to].before(row); else rows[to].after(row);
  grip.focus();
  saveAccountOrder(list).then(() => $('official-accounts').querySelector(`[data-grip="${CSS.escape(row.dataset.accountRow)}"]`)?.focus());
});

/* ---- 重命名：名字原地变成输入框，回车 / 点别处保存，Esc 取消 ---- */
function startRename(button) {
  const row = button.closest('.oauth-account'), label = row.querySelector('.oauth-account-name');
  if (row.querySelector('.oauth-rename')) return;
  const id = button.dataset.accountId, email = label.dataset.email;
  const input = el('input', { class: 'oauth-rename', type: 'text', maxlength: '40', value: label.dataset.alias || '', placeholder: email || '给这个账号起个名字', 'aria-label': '账号名字（留空就显示邮箱）', translate: 'no' });
  label.replaceWith(input);
  input.focus(); input.select();
  $('prefs-status').textContent = '回车保存，Esc 取消；留空就显示邮箱。';
  let done = false;
  const finish = async save => {
    if (done) return; done = true;
    const value = input.value.trim();
    if (!save || value === (label.dataset.alias || '')) { input.replaceWith(label); $('prefs-status').textContent = ''; return; }
    input.disabled = true;
    try {
      renderOfficialAccounts(await api.manageOfficialAccount('rename', id, value));
      $('prefs-status').textContent = value ? '已改名' : '已去掉名字，显示邮箱';
      $('official-accounts').querySelector(`[data-account-row="${CSS.escape(id)}"] [data-account-action="rename"]`)?.focus();
    } catch (error) {
      input.replaceWith(label);
      $('prefs-status').textContent = cleanRemoteError(error, '改名失败，请重试');
    }
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    // 只取消改名，别把设置窗口也关了
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}
async function loadOfficialAccounts() {
  $('official-accounts').replaceChildren(el('div', { class: 'account-loading', text: '正在读取账号状态…' }));
  try { renderOfficialAccounts(await api.officialAccounts()); }
  catch { $('official-accounts').replaceChildren(el('div', { class: 'account-loading', text: '账号状态读取失败，请重新打开设置。' })); }
}


/* ---------------- 格式化 ---------------- */

function number(n) { return (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
/** 简写（图表坐标轴、句子里用）。 */
function tokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return number(n);
}
/*
 * 数字显示：卡片、表格里的 Token 和请求数默认精确到个位（3,031,245,120），设置里可以换回简写（3.03B）。
 * 中文界面在后面再跟一个小字「≈30.3亿」—— 中文读者对「亿 / 万」比对 B / M 反应快得多。图表坐标轴和句子里仍用简写。
 */
const NUMBER_KEY = 'tokenpulse-number';
let numberMode = 'exact';
try { numberMode = localStorage.getItem(NUMBER_KEY) === 'compact' ? 'compact' : 'exact'; } catch { /* 读不到就用默认 */ }
function amount(n) { return numberMode === 'compact' ? tokens(n) : number(Math.round(n || 0)); }
function cnApprox(n) {
  if (window.PulseI18n?.lang() === 'en' || !Number.isFinite(n) || n < 1e4) return '';
  const [value, unit] = n >= 1e8 ? [n / 1e8, '亿'] : [n / 1e4, '万'];
  const text = value >= 100 ? Math.round(value).toLocaleString('en-US') : String(Number(value.toPrecision(3)));
  return `≈${text}${unit}`;
}
/** 数字 + 中文小字，作为一组节点塞进卡片、表格。 */
function qty(n) {
  const approx = cnApprox(n);
  return [amount(n), approx ? el('small', { class: 'cn-approx', text: approx }) : null];
}
function money(n) { return n > 0 && n < .01 ? '<$0.01' : '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function percent(n) { return n == null || !Number.isFinite(n) ? '—' : n.toFixed(1) + '%'; }
function date(at, full = false) {
  if (!at) return '尚未采样';
  return new Date(at).toLocaleString(dateLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(full ? { year: 'numeric' } : {}), hour12: false });
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

let statusTimer = 0;
function showStatus(message, error = false) {
  const status = $('app-status');
  clearTimeout(statusTimer);
  status.textContent = message;
  status.hidden = false;
  status.setAttribute('role', error ? 'alert' : 'status');
  statusTimer = setTimeout(() => { status.hidden = true; }, error ? 6500 : 3600);
}
function empty(message) { return el('div', { class: 'empty', text: message }); }
function track(pct, warning = false, label = '已用额度', identity = '') {
  // identity：双环卡片里进度条用和环一样的身份色（5 小时 / 周），预警改由文字颜色表达；快用完（≥90%）仍然变红。
  const tone = pct >= 90 ? ' critical' : identity ? ` ${identity}` : warning ? ' warning' : '';
  const fill = el('span', { class: 'track-fill' + tone });
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  return el('div', { class: 'track', role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.min(100, Math.max(0, pct)) }, [fill]);
}
/** 最后一次查询成功的时间。采样历史数值不变时 15 分钟才记一条，不能拿它判断过期。 */
function checkedAt(account) { return account?.lastCheckedAt ?? account?.lastSampleAt; }
function isStale(account) { return !checkedAt(account) || Date.now() - checkedAt(account) > 15 * 60000; }
function waitingReset(account, window) { return window?.startAt != null && checkedAt(account) < window.startAt; }
function prediction(window, account) {
  if (!window) return '暂无窗口数据';
  if (waitingReset(account, window)) return '窗口已重置，等待新采样确认';
  if (isStale(account)) return '采样已过期，刷新后再判断';
  if (window.used >= 100) return '额度已用完，请等待重置';
  if (window.runsOutBeforeReset && window.etaAt) return `按最近趋势，预计约 ${duration(window.etaAt - Date.now())} 后达到上限`;
  if (window.ratePerH === 0) return '近期没有新增用量，暂不估计达到上限的时间';
  if (window.projectedAtReset != null) return `按最近趋势，重置时预计使用 ${percent(window.projectedAtReset)}`;
  return '采样跨度还不够，暂不估计达到上限的时间';
}

/**
 * 按「整窗容量折算」把百分比换成 Token 和费用。容量是倒推出来的估算（已用 Token ÷ 已用百分比），
 * 已用不到 2% 时没有容量，这里也就不给数。超过 100% 的预测按 100% 算：一个窗口最多就用这么多。
 */
function byCapacity(report, pct) {
  const capacity = report?.capacity;
  if (!capacity || pct == null || !Number.isFinite(pct)) return null;
  const share = Math.max(0, Math.min(100, pct)) / 100;
  return { tokens: capacity.tokens * share, costUsd: capacity.costUsd * share };
}
const CONFIDENCE = { low: '可信度较低 · 已用不到 5%', medium: '可信度中等', high: '可信度较高' };

/* ---------------- 总览：额度卡片 ---------------- */

function ring({ five, week, account } = {}) {
  const node = svg('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' });
  const both = Boolean(five && week);
  /*
   * 双环时颜色只表示「哪个窗口」（外环 5 小时、内环周），预警交给右上角的状态和「已用」文字；
   * 以前两种含义叠在一起，ChatGPT 两个环都变成橙色，外环 / 内环的图例对不上。快用完（≥90%）仍然变红。
   */
  const tone = (win) => !win || waitingReset(account, win) ? '' : win.used >= 90 ? 'critical' : !both && win.runsOutBeforeReset ? 'warning' : '';
  const add = (name, win, radius, circumference) => {
    const remaining = win && !waitingReset(account, win) ? Math.max(0, 100 - win.used) : null;
    node.append(svg('circle', { class: `ring-track ring-${name}`, cx: 50, cy: 50, r: radius }));
    if (remaining != null) {
      node.append(svg('circle', {
        class: `ring-value ring-${name} ${tone(win)}`,
        cx: 50, cy: 50, r: radius,
        'stroke-dasharray': circumference,
        'stroke-dashoffset': circumference * (1 - remaining / 100),
      }));
    }
  };
  if (both) {
    add('five', five, 44, RING);
    add('week', week, 34, INNER_RING);
  } else {
    add(five ? 'five' : 'week', five || week, 44, RING);
  }
  const wrapper = el('div', { class: 'ring' + (both ? ' double' : ''), title: both ? '外环：5 小时额度　内环：周额度' : null }, [node]);
  return wrapper;
}
/**
 * 额度卡片 / 额度页标签的排法：每个有额度采样的账号一个，按「家 → 设置里的顺序」；
 * 一个账号都没有的家也留一个位置，提示去登录。key 是账号 id（老采样没有 id 时用家名）。
 */
function quotaSlots() {
  return Object.keys(META).flatMap(kind => {
    const reports = current.accounts.filter(a => a.kind === kind);
    return reports.length ? reports.map(account => ({ kind, key: account.key || kind, account })) : [{ kind, key: kind, account: null }];
  });
}
/** 卡片和标签上的短名字。报表里已经处理过别名和重名（见 report.ts 的 displayNames）。 */
function accountWho(account) {
  return account?.displayName || '';
}
function quotaCard({ kind, key, account }) {
  const meta = META[kind];
  const who = accountWho(account);
  const stale = account && isStale(account);
  // 首页优先展示剩余最少的有效窗口，让环中心和说明都对应当前压力更高的窗口。
  const windows = [account?.five, account?.week].filter(Boolean);
  const report = windows.filter(win => !waitingReset(account, win)).sort((a, b) => b.used - a.used)[0] || windows[0];
  const waiting = report && waitingReset(account, report);
  const head = el('div', { class: 'account-head' }, [
    avatar(kind),
    el('div', { class: 'account-title' }, [
      el('span', { class: 'account-name', text: meta.name }),
      who ? el('span', { class: 'plan who', title: account.accountLabel || '', translate: 'no' }, [who, account.plan ? el('small', { text: ' · ' + account.plan }) : null])
        : el('span', { class: 'plan', text: account?.plan || meta.source })
    ]),
    el('span', { class: 'badge ' + (!stale && !waiting ? account?.health.level || '' : ''), text: !account ? '暂无采样' : waiting ? '等待新采样' : stale ? '采样已过期' : HEALTH[account.health.level] })
  ]);
  const body = [head];
  if (account && (account.five || account.week)) {
    const remainingValues = windows.filter(win => !waitingReset(account, win)).map(win => Math.max(0, 100 - win.used));
    const remainingPct = remainingValues.length ? Math.min(...remainingValues) : null;
    const value = el('div', { class: 'quota-remaining' + (remainingPct == null ? ' empty-number' : ''), text: remainingPct == null ? '—' : remainingPct.toFixed(1) }, remainingPct == null ? [] : [el('small', { text: '%' })]);
    const windowLabel = account.five && account.week ? '当前较低窗口' : report === account.week ? '周额度' : '5 小时额度';
    const hero = el('div', { class: 'quota-hero-text' }, [
      el('span', { class: 'quota-hero-label', text: `${stale ? '上次' : ''}${windowLabel}剩余` }),
      el('span', { class: 'quota-hero-value', text: waiting ? '等待新采样' : report?.resetAt ? `${duration(report.resetAt - Date.now())}后重置` : '重置时间未知' }),
      el('span', { class: 'quota-hero-sub', text: report?.resetAt && !waiting ? `${date(report.resetAt)} · 本地时间` : '旧窗口已结束' })
    ]);
    const ringNode = ring({ five: account.five, week: account.week, account });
    ringNode.append(el('div', { class: 'ring-center' }, [value]));
    body.push(el('div', { class: 'quota-hero' }, [ringNode, hero]));
    const both = Boolean(account.five && account.week);
    for (const [name, label, ring, win] of [['five', '5 小时', '外环', account.five], ['week', '周额度', '内环', account.week]]) {
      if (!win) continue;
      const pending = waitingReset(account, win);
      // 双环时标题前的圆点就是图例：颜色和对应的环一致。
      const title = both ? el('span', { class: 'mini-label' }, [el('i', { class: `win-dot ${name}`, 'aria-hidden': true }), label, el('small', { text: ring })]) : el('span', { text: label });
      const usedClass = 'num' + (!pending && win.used < 90 && win.runsOutBeforeReset ? ' warn-text' : '');
      const left = !pending && !stale ? byCapacity(win, 100 - win.used) : null;
      const usedText = el('span', { class: 'mini-used' }, [
        el('span', { class: usedClass, text: pending ? '等待确认' : `已用 ${percent(win.used)}` }),
        left ? el('span', { class: 'mini-left num', text: ` · 剩约 ${tokens(left.tokens)}`, title: `按整窗容量折算：剩余约 ${tokens(left.tokens)} Tokens · ${money(left.costUsd)}` }) : null
      ]);
      body.push(el('div', { class: 'quota-mini' }, [
        el('div', { class: 'quota-mini-head' }, [title, usedText]),
        pending ? el('div', { class: 'track' }) : track(win.used, win.runsOutBeforeReset, '已用额度', both ? name : ''),
        el('div', { class: 'mini-reset' }, [icon('clock'), pending ? '旧窗口已结束，正在等待新数据' : win.resetAt ? `${duration(win.resetAt - Date.now())}后重置 · ${date(win.resetAt)}` : '接口未提供重置时间'])
      ]));
    }
  } else {
    const ringNode = ring({});
    ringNode.append(el('div', { class: 'ring-center' }, [el('div', { class: 'quota-remaining empty-number', text: '—' })]));
    body.push(el('div', { class: 'quota-hero' }, [ringNode, el('div', { class: 'quota-hero-text' }, [el('span', { class: 'quota-hero-label', text: '额度剩余' }), el('span', { class: 'quota-hero-value', text: '尚未取得官方额度' })])]));
    body.push(el('div', { class: 'quota-missing' }, [el('p', { text: '可能尚未登录、凭据过期或网络未连通。本机用量仍正常记录。' })]));
  }
  const link = el('button', { class: 'text-btn', 'aria-label': `${who ? meta.name + ' ' + who : meta.name} 额度详情` }, ['详情', icon('arrow')]);
  link.addEventListener('click', () => { state.account = key; navigate('quota'); });
  const forecast = !stale && !waiting && report?.used >= 100 ? '额度已用完，等待重置'
    : !stale && !waiting && report?.etaAt && report.runsOutBeforeReset ? `约 ${duration(report.etaAt - Date.now())} 后达到上限`
    : !stale && !waiting && report?.ratePerH === 0 ? '近期没有新增用量，暂不估计'
    : !stale && !waiting && report?.projectedAtReset != null ? `重置时预计使用 ${percent(report.projectedAtReset)}`
    : `${date(checkedAt(account))} 更新`;
  body.push(el('div', { class: 'quota-card-foot' }, [el('span', { text: account ? forecast : `${meta.source} 本地凭据` }), link]));
  return el('article', { class: 'quota-card ' + kind }, body);
}

/* ---------------- 用量统计 ---------------- */

const PRESET_LABELS = { 1: '今天', '24h': '一天', 7: '7 天', 14: '14 天', 30: '30 天', 90: '90 天', all: '全部' };
function updateRange() {
  const today = D.dayKey(current.now);
  state.since = undefined;
  if (state.days === '24h') {
    // 滚动的 24 小时：跨两个自然日，精确的数字从逐条流水里汇总（windowAnalysis）
    state.since = current.now - 86400000;
    state.from = D.dayKey(state.since); state.to = today;
  } else if (state.days === 'all') {
    // 数据永久保存，「全部」从有记录的第一天算起。
    state.from = (current.usage || []).reduce((min, row) => row.day < min ? row.day : min, today);
    state.to = today;
  } else if (state.days !== 'custom') {
    state.to = today; state.from = D.shift(today, 1 - state.days);
  } else if (state.follow) {
    state.to = today;
  }
  $('range-label').textContent = state.days === '24h'
    ? `过去 24 小时 · ${date(state.since)} 起`
    : `${state.from.replaceAll('-', '.')} — ${state.to.replaceAll('-', '.')}`;
  $('range-button-label').textContent = state.days === 'custom'
    ? `自定义 · ${state.from.slice(5).replace('-', '/')} → ${state.follow ? '今天' : state.to.slice(5).replace('-', '/')}`
    : PRESET_LABELS[state.days];
  analysis = state.days === '24h' ? windowAnalysis() : D.analyze(current.usage || [], state.from, state.to, state.source);
}

/*
 * 「一天」= 过去 24 小时。按天记的账切不出来，改由 worker 从逐条流水里汇总：这 24 小时和再往前的 24 小时（算环比）。
 * 结果按「快照时间 + 工具」缓存；还没回来时先给一份空的，回来后重画。
 */
const windowCache = new Map();
function windowAnalysis() {
  const key = `${current.now}|${state.source}`;
  const hit = windowCache.get(key);
  if (!hit) {
    windowCache.set(key, null);
    const now = current.now, base = { source: state.source, status: 'all', search: '', sort: 'time', page: 0, pageSize: 1, aggregate: true };
    Promise.all([
      api.requests({ ...base, from: D.dayKey(now - 86400000), to: D.dayKey(now), since: now - 86400000, until: now }),
      api.requests({ ...base, from: D.dayKey(now - 2 * 86400000), to: D.dayKey(now - 86400000), since: now - 2 * 86400000, until: now - 86400000 - 1 })
    ]).then(([cur, prev]) => {
      windowCache.set(key, { cur: cur.aggregate, prev: prev.aggregate });
      while (windowCache.size > 6) windowCache.delete(windowCache.keys().next().value);
      if (state.days === '24h' && current) render(current);
    }).catch(() => { windowCache.delete(key); showStatus('过去 24 小时的数据读取失败，请重试。', true); });
  }
  const data = windowCache.get(key);
  const result = D.analyze(data?.cur.rows || [], state.from, state.to, state.source);
  result.previous = D.sum(D.select(data?.prev.rows || [], '0000-00-00', '9999-99-99', state.source));
  // 24 个整点小时，没用的小时补 0，图表才连续
  const byHour = new Map((data?.cur.hours || []).map(row => [row.hour, row]));
  // 画最近 24 个整点小时（含当前这一小时）；24 小时窗口开头那半个小时只进合计，不单独占一根柱子
  const firstHour = Math.floor(current.now / 3600000) * 3600000 - 23 * 3600000;
  result.hourly = Array.from({ length: 24 }, (_, i) => byHour.get(firstHour + i * 3600000) || { hour: firstHour + i * 3600000, tokens: 0, costUsd: 0, requests: 0 });
  result.loading = !data;
  return result;
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
    ['tokens', '总 Tokens', t.tokens, amount, delta(t.tokens, p.tokens), '输入 + 输出'],
    ['cost', '参考费用', t.costUsd, money, analysis.unpriced ? [`${number(analysis.unpriced)} 次请求未定价`] : delta(t.costUsd, p.costUsd), 'USD'],
    ['requests', '请求次数', t.requests, amount, delta(t.requests, p.requests), '次'],
    ['cache', '缓存读取占比', cache, percent, [`${tokens(t.cacheRead)} 缓存读取 / ${tokens(t.input)} 输入`], '输入口径']
  ];
  $('tiles').replaceChildren(...stats.map(([name, label, value, format, sub, unit]) => {
    const valueNode = el('span', { class: 'num' });
    countTo(valueNode, 'stat:' + name, value, format);
    const approx = format === amount ? cnApprox(value) : '';
    return el('article', { class: 'stat' }, [
      el('div', { class: 'stat-label' }, [el('span', { class: 'stat-icon' }, [icon(name)]), el('span', { text: label }), el('span', { class: 'stat-unit', text: unit })]),
      el('div', { class: 'stat-value' + (format === amount && numberMode === 'exact' && value >= 1e9 ? ' long' : ''), title: format === amount ? number(value) : '' }, [valueNode, approx ? el('small', { class: 'cn-approx', text: approx }) : null]),
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
/**
 * 选「全部」或很长的自定义范围时，按天画几百上千根柱子挤成一片：超过 120 天按周合并，超过两年按月合并。
 * 合并后的柱子带 label（悬停提示）和 tick（横轴刻度）。
 */
function groupDaily(daily) {
  if (daily.length <= 120) return { rows: daily, unit: '天' };
  const byMonth = daily.length > 730;
  const today = D.dayKey(Date.now());
  const groups = new Map();
  for (const row of daily) {
    const d = new Date(`${row.day}T12:00:00`);
    const key = byMonth ? row.day.slice(0, 7) : D.shift(row.day, -d.getDay());
    const hit = groups.get(key) || { day: row.day, tokens: 0, costUsd: 0, requests: 0, first: row.day, last: row.day };
    hit.tokens += row.tokens; hit.costUsd += row.costUsd; hit.requests += row.requests; hit.last = row.day;
    groups.set(key, hit);
  }
  const rows = [...groups.values()].map(row => ({
    ...row,
    current: row.first <= today && today <= row.last,
    label: byMonth ? row.first.slice(0, 7).replace('-', ' 年 ') + ' 月' : `${row.first} ~ ${row.last}`,
    tick: byMonth ? row.first.slice(2, 7).replace('-', '/') : row.first.slice(5)
  }));
  return { rows, unit: byMonth ? '月' : '周' };
}
function dailyChart(animate) {
  if (analysis.hourly) {
    $('chart-caption').textContent = '按小时 · 过去 24 小时';
    chart($('daily-chart'), analysis.hourly, state.metric, true, animate);
    return;
  }
  const { rows, unit } = groupDaily(analysis.daily);
  $('chart-caption').textContent = `按${unit}汇总 · 本机时间`;
  chart($('daily-chart'), rows, state.metric, false, animate);
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
    const label = hourly ? `${new Date(row.hour).getHours()}:00` : row.label || row.day;
    const text = `${hourly ? date(row.hour) : label}\n${tokens(row.tokens)} Tokens\n${money(row.costUsd)} · ${number(row.requests)} 次请求`;
    const rect = svg('rect', { class: 'col' + (row.current || row.day === today ? ' today' : ''), x, y: h - bottom - barHeight, width: barWidth, height: barHeight, rx: Math.min(4, barWidth / 2), tabindex: 0, 'aria-label': text });
    rect.style.animationDelay = `${Math.round(i * step)}ms`;
    rect.addEventListener('pointermove', e => tipAt(text, e.clientX, e.clientY));
    rect.addEventListener('pointerleave', () => { $('tip').hidden = true; });
    rect.addEventListener('focus', () => { const box = rect.getBoundingClientRect(); tipAt(text, box.x, box.y); });
    rect.addEventListener('blur', () => { $('tip').hidden = true; });
    node.append(rect);
    if (i % Math.max(1, Math.ceil(rows.length / 7)) === 0 || i === rows.length - 1) {
      const tick = svg('text', { class: 'axis', x: x + barWidth / 2, y: h - 6, 'text-anchor': 'middle' }); tick.textContent = hourly ? label : row.tick || row.day.slice(5); node.append(tick);
    }
  });
  host.append(node);
  playChart(host, animate);
}

/* ---------------- 总览 ---------------- */

function renderOverview() {
  $('quota-cards').replaceChildren(...quotaSlots().map((slot, i) => stagger(quotaCard(slot), i)));
  dailyChart(entering());
  const t = analysis.total;
  // 过去 24 小时按小时算节奏，其余按天
  const hourly = Boolean(analysis.hourly);
  const slots = hourly ? analysis.hourly : analysis.daily, n = slots.length || 1;
  const peak = [...slots].sort((a, b) => b.tokens - a.tokens)[0];
  const active = hourly ? slots.filter(row => row.requests > 0).length : analysis.activeDays;
  $('chart-summary').replaceChildren(
    el('span', {}, [hourly ? '每小时平均' : '日均', el('b', { text: tokens(t.tokens / n) + ' Tokens' })]),
    el('span', {}, [hourly ? '活跃小时' : '活跃天数', el('b', { text: hourly ? `${active} / ${n} 小时` : `${active} / ${n} 天` })]));
  const rhythms = [
    [hourly ? '每小时平均请求' : '日均请求', `${number(t.requests / n)} 次`],
    ['单次平均用量', t.requests ? `${tokens(t.tokens / t.requests)} Tokens` : '—'],
    [hourly ? '用量最高的一小时' : '用量最高的一天', peak?.tokens ? (hourly ? date(peak.hour) : peak.day.slice(5).replace('-', ' / ')) : '—'],
    ['峰值用量', peak?.tokens ? amount(peak.tokens) : '—']
  ];
  $('rhythm').replaceChildren(...rhythms.map(([label, value], i) => stagger(el('div', { class: 'rhythm-row' }, [el('span', { text: label }), el('b', { text: value })]), i)),
    el('p', { class: 'rhythm-note', text: hourly ? '过去 24 小时，按小时统计，对比再往前的 24 小时。' : '平均值包含没有使用的日期。对比上一段等长时间，今天的记录仍在累积。' }));
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
    el('div', { class: 'rank-value', title: number(row.tokens) }, [...qty(row.tokens), el('div', { class: 'rank-meta', text: row.unpriced ? '部分未定价' : money(row.costUsd) })])
  ]), i)) : [empty('所选范围还没有模型用量')]));
}
function stagger(node, i) { node.style.setProperty('--i', i); return node; }

/* ---------------- 额度详情 ---------------- */

/** 一个指标小卡片：灰色小标签、大号数字（带单位）、下面一行补充说明。tone：accent 高亮 / warn 预警。 */
function metric(label, value, { unit, sub, tone, chip, approx } = {}) {
  return el('div', { class: 'metric' + (tone ? ` ${tone}` : '') }, [
    el('span', { class: 'metric-label', text: label }),
    el('div', { class: 'metric-value' }, [el('b', { class: 'num', text: value, title: value }), unit ? el('small', { text: unit }) : null, approx ? el('small', { class: 'cn-approx', text: approx }) : null]),
    sub || chip ? el('div', { class: 'metric-sub' }, [sub ? el('span', { text: sub }) : null, chip ? el('span', { class: `metric-chip ${chip.tone}`, text: chip.text }) : null]) : null
  ]);
}
function metricGroup(title, iconName, cards, layout = '') {
  cards.forEach((card, i) => card.style.setProperty('--i', i));
  return el('section', { class: 'metric-group' }, [el('h3', {}, [icon(iconName), title]), el('div', { class: `metric-grid ${layout}`.trim() }, cards)]);
}
/** Token + 费用的卡片：折算不出来时如实写原因，不编数。 */
function tokenMetric(label, value, extra = {}) {
  if (!value) return metric(label, '—', { sub: extra.missing || '样本不足，暂无法折算' });
  return metric(label, amount(value.tokens), { unit: 'Tokens', sub: money(value.costUsd), approx: cnApprox(value.tokens), ...extra });
}
function windowPanel(label, report, account) {
  const panel = el('article', { class: 'panel window-panel' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: label }), el('span', { class: 'section-tag', text: '官方额度窗口' })])]);
  if (!report) { panel.append(empty('接口未提供此窗口')); return panel; }
  const pending = waitingReset(account, report), stale = isStale(account), unknown = stale || pending;
  panel.append(el('div', { class: 'window-number' }, [el('strong', { text: pending ? '—' : percent(Math.max(0, 100 - report.used)) }), el('span', { text: stale ? '上次采样剩余' : '剩余额度' })]));
  const bar = pending ? el('div', { class: 'track' }) : track(report.used, report.runsOutBeforeReset); bar.classList.add('window-track'); panel.append(bar);
  panel.append(el('div', { class: 'window-meta' }, [el('span', { text: pending ? '等待采样确认' : `已用 ${percent(report.used)}` }), el('span', { text: report.resetAt ? `${duration(report.resetAt - Date.now())}后重置` : '重置时间未知' })]));
  const caution = report.runsOutBeforeReset || unknown;
  panel.append(el('div', { class: 'prediction-line' + (caution ? ' caution' : '') }, [icon(caution ? 'alert' : 'trend'), prediction(report, account)]));

  const capacity = report.capacity;
  const waitText = '等待有效采样';
  panel.append(metricGroup('Token 与费用', 'tokens', [
    metric('本窗口已用（本机）', amount(report.usedTokens), { unit: 'Tokens', approx: cnApprox(report.usedTokens), sub: money(report.usedCostUsd) }),
    unknown ? metric('剩余可用（估算）', '—', { sub: waitText }) : tokenMetric('剩余可用（估算）', byCapacity(report, 100 - report.used), { tone: 'accent' }),
    unknown || !capacity ? metric('整窗容量折算', '—', { sub: unknown ? waitText : '已用不到 2%，暂无法折算' })
      : tokenMetric('整窗容量折算', byCapacity(report, 100), { chip: { tone: capacity.confidence, text: CONFIDENCE[capacity.confidence] } })
  ]));

  const willRunOut = !unknown && report.used < 100 && report.etaAt && report.runsOutBeforeReset;
  const limit = unknown ? metric('预计达到上限', '—', { sub: waitText })
    : report.used >= 100 ? metric('预计达到上限', '已用完', { sub: '等待重置', tone: 'warn' })
    : willRunOut ? metric('预计达到上限', date(report.etaAt), { sub: `约 ${duration(report.etaAt - Date.now())}后`, tone: 'warn' })
    : metric('预计达到上限', report.ratePerH === 0 ? '暂无新增' : '不会', { sub: report.ratePerH === 0 ? '近期没有新增用量' : '重置前不会达到上限' });
  panel.append(metricGroup('预测', 'trend', [
    limit,
    metric('重置时预计使用', unknown || report.projectedAtReset == null ? '—' : percent(report.projectedAtReset), { sub: unknown ? waitText : report.projectedAtReset == null ? '暂无法估计' : '按最近趋势', tone: !unknown && report.projectedAtReset >= 100 ? 'warn' : '' }),
    unknown || report.projectedAtReset == null ? metric('重置时预计用量', '—', { sub: unknown ? waitText : '暂无法估计' })
      : tokenMetric('重置时预计用量', byCapacity(report, report.projectedAtReset), report.projectedAtReset > 100 ? { chip: { tone: 'warn', text: '会用满' } } : {})
  ]));

  const speed = n => n == null || unknown ? '—' : n.toFixed(2);
  panel.append(metricGroup('速度与时间', 'clock', [
    metric('窗口平均速度', speed(report.averagePerH), { unit: report.averagePerH == null || unknown ? '' : '点 / 时', sub: '整个窗口，含休息时间' }),
    metric(label.startsWith('5') ? '最近 1 小时速度' : '最近 24 小时速度', speed(report.recentPerH), { unit: report.recentPerH == null || unknown ? '' : '点 / 时', sub: '预测主要依据' }),
    metric('窗口开始', report.startAt ? date(report.startAt) : '未知', { sub: report.startAt ? new Date(report.startAt).getFullYear() + ' 年 · 本地时间' : '' }),
    metric('重置时间', report.resetAt ? date(report.resetAt) : '未知', { sub: report.resetAt ? `${duration(report.resetAt - Date.now())}后` : '' })
  ], 'two'));
  panel.append(el('p', { class: 'quota-footnote', text: 'Token 和费用按「本机已用 ÷ 已用百分比」倒推，只统计这台电脑；在别的设备上也用这个账号时会偏低，也不是官方公布的上限。' }));
  return panel;
}
/** 历史窗口的「整窗容量」折线：看官方给的总额度有没有变。 */
function capacityChart(host, history, windowName, metric, animate) {
  host.replaceChildren();
  host.classList.toggle('week', windowName === 'week');
  const points = history?.points || [];
  if (!points.length) { host.append(empty('还没有能折算的历史窗口：需要窗口已用 ≥ 2%，并且本机在这个窗口里有用量')); return; }
  const value = p => metric === 'costUsd' ? p.capacityCostUsd : p.capacityTokens;
  const fmt = metric === 'costUsd' ? money : tokens;
  const w = Math.max(320, host.clientWidth), h = host.clientHeight || 240, left = 56, right = 24, top = 18, bottom = 30;
  const reference = points.filter(p => !p.current && p.confidence !== 'low').map(value).sort((a, b) => a - b);
  const median = reference.length ? reference[Math.floor((reference.length - 1) / 2)] : null;
  const max = Math.max(...points.map(value), median ?? 0) * 1.15 || 1;
  const from = points[0].startAt, span = Math.max(1, points.at(-1).startAt - from);
  // 两头各留 14px：点落在坐标轴上看着像被截了一半
  const x = p => points.length === 1 ? (left + w - right) / 2 : left + 14 + (p.startAt - from) / span * (w - left - right - 28);
  const y = v => top + (1 - v / max) * (h - top - bottom);
  const node = svg('svg', { viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': windowName === 'week' ? '历史周额度容量折线' : '历史 5 小时额度容量折线' });
  for (const f of [0, .5, 1]) {
    const yy = y(max * f); node.append(svg('line', { class: 'grid', x1: left, x2: w - right, y1: yy, y2: yy }));
    const label = svg('text', { class: 'axis', x: left - 9, y: yy + 4, 'text-anchor': 'end' }); label.textContent = f ? fmt(max * f) : '0'; node.append(label);
  }
  // 中位数的数值写在图下方的说明里：写在线尾会和「进行中」的点、标签撞在一起。
  if (median != null) node.append(svg('line', { class: 'cap-median', x1: left, x2: w - right, y1: y(median), y2: y(median) }));
  if (points.length > 1) node.append(svg('path', { class: 'trend-line cap-line', d: points.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${y(value(p)).toFixed(1)}`).join(' '), pathLength: 1, 'stroke-dasharray': 1 }));
  const dayLabel = at => new Date(at).toLocaleDateString(dateLocale(), { month: '2-digit', day: '2-digit' });
  points.forEach((p, i) => {
    const text = `${date(p.startAt)} → ${date(p.resetAt)}${p.current ? '（进行中）' : ''}\n最后一次采样已用 ${percent(p.pct)}\n本机用量 ${tokens(p.tokens)} Tokens · ${money(p.costUsd)}\n折算整窗约 ${tokens(p.capacityTokens)} Tokens · ${money(p.capacityCostUsd)}\n${CONFIDENCE[p.confidence]}`;
    const dot = svg('circle', { class: `cap-dot ${p.confidence === 'low' ? 'low' : 'solid'}${p.current ? ' current' : ''}`, cx: x(p), cy: y(value(p)), r: p.current ? 6 : 4.5, tabindex: 0, 'aria-label': text });
    dot.style.animationDelay = `${Math.round(600 + i * 60)}ms`;
    dot.addEventListener('pointermove', e => tipAt(text, e.clientX, e.clientY));
    dot.addEventListener('pointerleave', () => { $('tip').hidden = true; });
    dot.addEventListener('focus', () => { const box = dot.getBoundingClientRect(); tipAt(text, box.x, box.y); });
    dot.addEventListener('blur', () => { $('tip').hidden = true; });
    node.append(dot);
    if (p.current) { const tag = svg('text', { class: 'axis cap-current-label', x: x(p), y: y(value(p)) - 12, 'text-anchor': 'middle' }); tag.textContent = '进行中'; node.append(tag); }
    if (i === 0 || i === points.length - 1 || (points.length > 6 && i === Math.floor(points.length / 2))) {
      const tick = svg('text', { class: 'axis', x: x(p), y: h - 8, 'text-anchor': points.length === 1 ? 'middle' : i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle' });
      tick.textContent = dayLabel(p.startAt); node.append(tick);
    }
  });
  host.append(node);
  playChart(host, animate);
  return median == null ? null : fmt(median);
}
function capacityPanel(account) {
  const host = el('div', { class: 'chart capacity-chart' });
  const note = el('p', { class: 'sample-caption' });
  const windowSeg = el('div', { class: 'seg compact', 'aria-label': '额度窗口' }, [el('span', { class: 'seg-thumb', 'aria-hidden': true }),
    ...[['week', '周额度'], ['five', '5 小时']].map(([id, label]) => el('button', { 'data-cap-window': id, class: state.capWindow === id ? 'on' : null, text: label }))]);
  const metricSeg = el('div', { class: 'seg compact', 'aria-label': '单位' }, [el('span', { class: 'seg-thumb', 'aria-hidden': true }),
    ...[['tokens', 'Tokens'], ['costUsd', '费用']].map(([id, label]) => el('button', { 'data-cap-metric': id, class: state.capMetric === id ? 'on' : null, text: label }))]);
  const draw = animate => {
    const history = account.capacityHistory?.[state.capWindow];
    const median = capacityChart(host, history, state.capWindow, state.capMetric, animate);
    const { tooLow = 0, noLocal = 0 } = history?.skipped || {};
    const skipped = [tooLow && `${tooLow} 个已用不到 2%`, noLocal && `${noLocal} 个本机没有用量（可能用在别的设备上）`].filter(Boolean);
    note.textContent = `${median ? `已结束且较可信的窗口中位数约 ${median}（虚线）。` : ''}${skipped.length ? `未计入 ${tooLow + noLocal} 个窗口：${skipped.join('，')}。` : ''}实心点可信，空心点已用不到 5%、偏差较大。按本机用量倒推，多设备使用时会偏低。`;
  };
  const panel = el('article', { class: 'panel capacity-panel' }, [
    el('div', { class: 'panel-heading' }, [
      el('div', {}, [el('h2', { text: '额度容量趋势' }), el('p', { text: '每个历史窗口折算出的「整窗能用多少」，看官方给的总额度有没有变化' })]),
      el('div', { class: 'capacity-controls' }, [windowSeg, metricSeg])
    ]),
    host, note
  ]);
  panel.addEventListener('click', event => {
    const button = event.target.closest('[data-cap-window], [data-cap-metric]'); if (!button) return;
    if (button.dataset.capWindow) state.capWindow = button.dataset.capWindow; else state.capMetric = button.dataset.capMetric;
    for (const item of panel.querySelectorAll('[data-cap-window]')) item.classList.toggle('on', item.dataset.capWindow === state.capWindow);
    for (const item of panel.querySelectorAll('[data-cap-metric]')) item.classList.toggle('on', item.dataset.capMetric === state.capMetric);
    syncSegs();
    draw(true);
  });
  panel.draw = draw;
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
/** 额度页顶上的标签：一个账号一个。账号有变化（新登录、删除、调顺序）才重建，平时只切换选中。 */
function drawAccountTabs(slots) {
  const tabs = $('account-tabs');
  const signature = slots.map(slot => `${slot.key}:${accountWho(slot.account)}`).join('|');
  if (tabs.dataset.signature !== signature) {
    tabs.dataset.signature = signature;
    tabs.replaceChildren(el('span', { class: 'seg-thumb', 'aria-hidden': 'true' }), ...slots.map(slot => {
      const who = accountWho(slot.account);
      return el('button', { type: 'button', 'data-account': slot.key, 'data-kind': slot.kind, title: slot.account?.accountLabel || null }, [
        el('span', { class: 'brand-glyph' }, [brandSvg(META[slot.kind].brand)]), META[slot.kind].name,
        who ? el('small', { class: 'tab-who', text: who, translate: 'no' }) : null
      ]);
    }));
  }
  for (const button of tabs.querySelectorAll('button')) { button.classList.toggle('on', button.dataset.account === state.account); button.setAttribute('aria-pressed', button.dataset.account === state.account); }
  syncSeg(tabs);
  revealAccountTab();
}
/** 选中的账号如果在滚动区域外面，把它滚进可见范围。只用这一行的 scrollLeft，不带动整页。 */
function revealAccountTab() {
  const tabs = $('account-tabs');
  const on = tabs.querySelector('button.on');
  if (!on || tabs.clientWidth <= 0) { markAccountTabEdges(); return; }
  const pad = 8;
  const left = on.offsetLeft - pad;
  const right = on.offsetLeft + on.offsetWidth + pad;
  if (left < tabs.scrollLeft) tabs.scrollLeft = Math.max(0, left);
  else if (right > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = right - tabs.clientWidth;
  markAccountTabEdges();
}
/** 两端淡出，表示这一侧还有账号。提示只在「能不能滚」变化时写一次，避免和英文翻译来回改 title。 */
function markAccountTabEdges() {
  const tabs = $('account-tabs');
  const max = tabs.scrollWidth - tabs.clientWidth;
  const overflow = max > 2;
  tabs.classList.toggle('overflow-left', overflow && tabs.scrollLeft > 2);
  tabs.classList.toggle('overflow-right', overflow && max - tabs.scrollLeft > 2);
  tabs.classList.toggle('can-pan', overflow);
  const flag = overflow ? '1' : '';
  if (tabs.dataset.scrollHint !== flag) {
    tabs.dataset.scrollHint = flag;
    tabs.title = overflow ? '按住拖动，查看更多账号' : '';
  }
}
function renderQuota() {
  const host = $('quota-detail'); host.replaceChildren();
  const slots = quotaSlots();
  // state.account 可能是账号 id，也可能是家名（首页「详情」、老的默认值）：对不上账号就取这一家的第一个
  const slot = slots.find(item => item.key === state.account) || slots.find(item => item.kind === state.account) || slots[0];
  state.account = slot.key;
  drawAccountTabs(slots);
  const { account, kind } = slot, meta = META[kind], who = accountWho(account);
  const sessions = current.sessions[kind] || { included: 0, excluded: 0 };
  host.append(el('div', { class: 'quota-context' }, [
    avatar(kind),
    el('div', {}, [
      el('h2', {}, [meta.name + (account?.plan ? ' · ' + account.plan : ''), who ? el('span', { class: 'context-who', text: account.accountLabel || who, title: account.accountLabel || who, translate: 'no' }) : null]),
      el('p', { class: 'muted', text: `${(account?.siblings || 1) > 1 ? `这一家共 ${number(sessions.included)} 个官方会话，用量已按账号分开` : `${number(sessions.included)} 个官方会话`} · ${number(sessions.excluded)} 个中转 / API Key 会话未计入额度` })
    ]),
    el('div', { class: 'context-meta', text: account ? `${date(checkedAt(account))} 更新 · ${number(account.sampleCount)} 个采样点` : '尚无额度采样' })
  ]));
  if (!account) {
    host.append(el('article', { class: 'panel empty large' }, [el('h3', { text: '暂时还没有这个账号的额度数据' }), el('p', { text: `确认 ${meta.source} 已登录官方账号，然后点击「刷新数据」。` }), el('p', { text: '凭据过期或网络错误也可能导致采样失败；这不会影响本机用量统计。' })])); return;
  }
  if (isStale(account)) host.append(el('p', { class: 'stale-note' }, [icon('alert'), `最后一次成功查询是 ${date(checkedAt(account), true)}，已超过 15 分钟（可能是网络不通或凭据过期）。以下是历史记录，当前剩余额度需刷新确认。`]));
  host.append(el('div', { class: 'quota-window-grid' }, [windowPanel('5 小时窗口', account.five, account), windowPanel('周额度窗口', account.week, account)]));
  const capacity = capacityPanel(account);
  host.append(capacity);
  const hourly = el('div', { class: 'chart' });
  const history = el('article', { class: 'panel' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '最近 24 小时 · 官方会话用量' })]), hourly, el('p', { class: 'sample-caption', text: '仅统计本机归属该官方账号的会话。横轴按本地时间，含当前未结束的小时。' })]);
  const trend = el('div', { class: 'chart quota-trend' });
  const trendPanel = el('article', { class: 'panel' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '本周额度采样' })]), trend, el('p', { class: 'sample-caption', text: `手动重置次数：${account.resetCredits ?? '接口未提供'} · 活跃时间占比：${account.week?.activeShare == null ? '样本不足' : percent(account.week.activeShare * 100)}` })]);
  host.append(el('div', { class: 'quota-history-grid' }, [history, trendPanel]));
  host.append(accountRequestsPanel(account, meta));
  const animate = entering();
  chart(hourly, account.hourly, 'tokens', true, animate);
  trendChart(trend, account.trend, animate);
  capacity.draw(animate);
  syncSegs();
}

/* ---------------- 用量明细 ---------------- */

function renderRecords() {
  const q = state.search.trim().toLowerCase();
  // 过去 24 小时的「按日汇总」：行来自逐条流水（最多两天：昨天那几个小时 + 今天）
  filteredRecords = analysis.selected.filter(row => !q || `${row.model} ${row.source}`.toLowerCase().includes(q)).sort((a, b) => state.sort === 'day' ? b.day.localeCompare(a.day) || b.tokens - a.tokens : b[state.sort] - a[state.sort] || b.day.localeCompare(a.day));
  const pageSize = 15, pages = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
  state.tablePage = Math.min(state.tablePage, pages - 1);
  const visible = filteredRecords.slice(state.tablePage * pageSize, (state.tablePage + 1) * pageSize);
  $('record-count').textContent = `${number(filteredRecords.length)} 条`;
  $('export-csv').disabled = !filteredRecords.length;
  $('records').replaceChildren(...visible.map((row, i) => stagger(el('tr', {}, [
    el('td', {}, [row.day, el('small', {}, [miniLogo(row.source), row.source])]), el('td', { class: 'model-cell', text: row.model, title: row.model }),
    ...['requests', 'input', 'output', 'cacheRead', 'tokens'].map(key => el('td', { class: 'n' + (key === 'tokens' ? ' token-strong' : ''), title: number(row[key]) }, qty(row[key]))),
    el('td', { class: 'n', text: row.priced === false ? '未定价' : money(row.costUsd) })
  ]), i)));
  if (!visible.length) $('records').append(el('tr', {}, [el('td', { colspan: 8, class: 'empty', text: '没有匹配的记录，试试其他时间、工具或关键词。' })]));
  $('pagination-label').textContent = `第 ${state.tablePage + 1} / ${pages} 页 · 共 ${number(filteredRecords.length)} 条匹配明细`;
  $('prev-page').disabled = state.tablePage === 0; $('next-page').disabled = state.tablePage >= pages - 1;
}
function renderUsage() {
  const t = analysis.total;
  $('token-breakdown').replaceChildren(...[['输入 Tokens', 'input', '含缓存读取与写入'], ['输出 Tokens', 'output', '含推理 Tokens'], ['缓存读取', 'cacheRead', '输入的一部分'], ['缓存写入', 'cacheWrite', '输入的一部分'], ['推理 Tokens', 'reasoning', '输出的一部分']].map(([label, key, note]) => {
    const value = el('span', { class: 'num' });
    countTo(value, 'breakdown:' + key, t[key], amount);
    const approx = cnApprox(t[key]);
    return el('div', { class: 'breakdown-item' }, [el('small', { text: label }), el('strong', { title: number(t[key]) }, [value, approx ? el('small', { class: 'cn-approx', text: approx }) : null]), el('span', { text: note })]);
  }));
  renderRecords();
}

/* ---------------- 额度详情：这个账号的请求 ---------------- */

/**
 * 额度是「当前使用」那个账号的，这里把同一个账号发出的请求接在下面：当前 5 小时 / 周窗口里用了多少、
 * 核验结果、最近几次请求，以及这个工具下各账号的分布（多账号时）。
 * 按窗口查流水要走 worker，异步回来；结果按条件缓存，定时刷新时先用缓存画，免得面板一空一满、页面跳。
 */
const accountPanelCache = new Map();
function accountRequestsPanel(account, meta) {
  const panel = el('article', { class: 'panel account-requests' });
  const now = Date.now();
  const weekStart = account.week?.startAt ?? now - 7 * 86400000;
  const fiveStart = account.five?.startAt;
  const key = [account.kind, account.accountId, weekStart, fiveStart, current?.scannedAt].join('|');
  const draw = data => drawAccountRequests(panel, account, meta, data);
  const cached = accountPanelCache.get(key) || [...accountPanelCache.entries()].reverse().find(([k]) => k.startsWith(`${account.kind}|${account.accountId}|`))?.[1];
  draw(cached || null);
  if (accountPanelCache.has(key)) return panel;
  const base = { from: D.dayKey(Math.min(weekStart, fiveStart ?? weekStart)), to: D.dayKey(now), source: meta.source, status: 'all', search: '', sort: 'time', page: 0 };
  Promise.all([
    api.requests({ ...base, since: weekStart, pageSize: 8, account: account.accountId || 'none' }),
    fiveStart ? api.requests({ ...base, since: fiveStart, pageSize: 1, account: account.accountId || 'none' }) : Promise.resolve(null)
  ]).then(([week, five]) => {
    accountPanelCache.set(key, { week, five });
    if (accountPanelCache.size > 12) accountPanelCache.delete(accountPanelCache.keys().next().value);
    if (panel.isConnected) keepScroll(() => draw({ week, five }));
  }).catch(() => { if (panel.isConnected) panel.querySelector('.account-requests-body')?.replaceChildren(empty('请求记录读取失败，请重试。')); });
  return panel;
}
function drawAccountRequests(panel, account, meta, data) {
  const label = account.accountLabel || meta.name + ' 账号';
  const openAll = el('button', { class: 'text-btn' }, ['在请求记录里查看全部', icon('arrow')]);
  openAll.addEventListener('click', () => {
    state.reqAccount = account.accountId || ''; state.reqStatus = 'all'; state.reqPage = 0; $('request-status').value = 'all';
    showUsageView('requests');
    navigate('usage');
  });
  const heading = el('div', { class: 'panel-heading' }, [
    el('div', {}, [el('h2', {}, ['这个账号的请求 ', el('span', { class: 'section-tag', text: label })]), el('p', { text: '本机 CLI 用这个账号发出的请求，按 CLI 当时登录的账号归属。' })]),
    openAll
  ]);
  const body = el('div', { class: 'account-requests-body' });
  panel.replaceChildren(heading, body);
  if (!data) { body.append(el('p', { class: 'muted', text: '正在读取这个账号的请求…' })); return; }
  const { week, five } = data;
  const verdicts = week.counts;
  const inferred = (week.accounts.find(item => item.id === (account.accountId || 'none'))?.inferred) || 0;
  const cards = [
    five ? metric('当前 5 小时窗口', amount(five.tokens), { unit: 'Tokens', approx: cnApprox(five.tokens), sub: `${number(five.counts.all)} 次请求 · ${money(five.costUsd)}` }) : null,
    metric('当前周窗口', amount(week.tokens), { unit: 'Tokens', approx: cnApprox(week.tokens), sub: `${number(verdicts.all)} 次请求 · ${money(week.costUsd)}` }),
    metric('型号核验', number(verdicts.mismatch + verdicts.suspect), {
      unit: '次异常', tone: verdicts.mismatch + verdicts.suspect ? 'warn' : '',
      sub: `${number(verdicts.match)} 次一致 · ${number(verdicts.unverified)} 次无法核验`
    })
  ].filter(Boolean);
  body.append(metricGroup('本周窗口', 'requests', cards, cards.length === 2 ? 'two' : ''));
  if (inferred) body.append(el('p', { class: 'sample-caption', text: `其中 ${number(inferred)} 次是 TokenPulse 开始记录登录之前的请求，按最早记下的账号推断。` }));
  if (week.rows.length) {
    body.append(el('div', { class: 'table-scroll compact-table' }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, ['时间', '项目', '型号', 'Tokens', '参考费用', '核验'].map((text, i) => el('th', { class: i === 3 || i === 4 ? 'n' : '', text })))]),
      el('tbody', {}, week.rows.map(row => { const t = clock(row.at); return el('tr', { class: `request-row ${row.status}` }, [
        el('td', { class: 'request-time', title: t.full }, [el('b', { text: `${t.day} ${t.time}` })]),
        el('td', { class: 'project-cell', text: projectOf(row.cwd), title: row.cwd || '' }),
        modelCell(row),
        el('td', { class: 'n token-strong', title: number(row.tokens) }, qty(row.tokens)),
        el('td', { class: 'n', text: row.priced ? money(row.costUsd) : '未定价' }),
        el('td', {}, [el('span', { class: 'badge ' + VERIFY_TONE[row.status], text: row.statusLabel, title: row.reasons[0] || '' })])
      ]); }))
    ])]));
  } else {
    body.append(el('p', { class: 'muted account-empty', text: '当前周窗口里还没有从本机发出、归到这个账号的请求。' }));
  }
  // 这个工具下不止一个账号（或者有走中转的）：列出各账号本周的量
  const others = week.accounts.filter(item => item.source === meta.source);
  if (others.length > 1 || (others.length === 1 && others[0].id !== (account.accountId || 'none'))) {
    body.append(el('div', { class: 'account-split' }, [
      el('h3', {}, [icon('user'), `本周 ${meta.source} 各账号`]),
      ...others.map(item => el('div', { class: 'account-split-row' + (item.id === account.accountId ? ' current' : '') }, [
        el('span', { class: 'account-split-name', text: accountName(item), title: accountName(item) }),
        el('span', { text: `${number(item.requests)} 次` }),
        el('span', { text: `${tokens(item.tokens)} Tokens` }),
        el('span', { text: money(item.costUsd) })
      ]))
    ]));
  }
}

/* ---------------- 请求记录与型号核验 ---------------- */

const VERIFY_TONE = { match: 'good', mismatch: 'critical', suspect: 'warning', unverified: 'neutral' };
const REQUEST_COLUMNS = [['time', '时间'], ['source', '工具'], ['accountLabel', '账号'], ['accountBasis', '账号依据'], ['project', '项目'], ['cwd', '工作目录'], ['requested', '请求型号'], ['returned', '返回型号'], ['statusLabel', '核验'], ['reason', '核验说明'], ['channel', '响应格式'], ['input', '输入 tokens（含缓存）'], ['output', '输出 tokens'], ['cacheRead', '缓存读取'], ['cacheWrite', '缓存写入'], ['reasoning', '推理 tokens'], ['tokens', '总 tokens'], ['quotaFive', '5 小时额度占用（估算）'], ['quotaWeek', '周额度占用（估算）'], ['costUsd', '参考费用 USD'], ['responseId', '响应 ID'], ['requestId', '请求 ID'], ['session', '会话']];
let requestPage = null, requestSeq = 0, requestKey = '';
const openRequests = new Set();
function projectOf(cwd) { return cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd : '—'; }
function clock(at) {
  const d = new Date(at), pad = n => String(n).padStart(2, '0');
  return { day: `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`, full: d.toLocaleString(dateLocale(), { hour12: false }) };
}
function requestQuery(extra = {}) {
  return { from: state.from, to: state.to, since: state.since, source: state.source, status: state.reqStatus, search: state.reqSearch.trim(), sort: state.reqSort, page: state.reqPage, pageSize: 20, account: state.reqAccount || undefined, ...extra };
}
/** 流水在主进程的 worker 里查；同样的条件、账本也没更新时直接用上一次的结果重画。 */
async function loadRequests() {
  const query = requestQuery();
  const key = JSON.stringify(query) + '|' + (current?.scannedAt || '');
  if (key === requestKey && requestPage) { drawRequests(); return; }
  requestKey = key;
  const seq = ++requestSeq;
  if (!requestPage) $('request-rows').replaceChildren(el('tr', {}, [el('td', { colspan: 9, class: 'empty', text: '正在读取请求记录…' })]));
  try {
    const page = await api.requests(query);
    if (seq !== requestSeq) return;
    requestPage = page; state.reqPage = page.page;
    // 查询是异步回来的，不在 render() 的滚动锁里；定时刷新时整表重画，同样要锁
    keepScroll(drawRequests);
  } catch {
    if (seq === requestSeq) { requestKey = ''; showStatus('请求记录读取失败，请重试。', true); }
  }
}
/** 核验结论的筛选标签。和上面的用量卡片放一起时四张大卡太重复，改成一排小标签。 */
function verifyChip(status, label, value, extra = '') {
  // 不一致 / 存疑为 0 时不上色，免得一片红黄吓人
  const tone = status === 'all' || (!value && status !== 'match') ? '' : VERIFY_TONE[status];
  return el('button', { class: `verify-chip ${tone}${state.reqStatus === status ? ' on' : ''}`, 'data-verify': status, 'aria-pressed': String(state.reqStatus === status) }, [
    status === 'all' ? null : el('i', { 'aria-hidden': 'true' }),
    el('span', { text: label }), el('b', { text: number(value) }), extra ? el('small', { text: extra }) : null
  ]);
}
function modelCell(row) {
  const main = row.returned || row.requested || row.model;
  let sub = null;
  if (row.status === 'mismatch') sub = [icon('alert'), `请求的是 ${row.requested}`];
  else if (!row.returned) sub = ['返回型号未记录'];
  else if (!row.requested) sub = ['请求型号未记录'];
  // [1m] 只是 Claude Code 标的 1M 上下文，响应里本来就没有，不值得单独写一行
  else if (row.requested.replace(/\[[^\]]*\]$/, '') !== row.returned) sub = [`请求 ${row.requested}`];
  return el('td', { class: 'request-model' }, [el('b', { text: main, title: main }), sub ? el('small', {}, sub) : null].filter(Boolean));
}
/* 账号 */
const ACCOUNT_BASIS = { session: '会话记录', timeline: '登录时间线', inferred: '推断' };
const ACCOUNT_BASIS_HINT = {
  session: '会话文件里直接记下了这个账号',
  timeline: '按请求时间，对上当时 CLI 登录的账号',
  inferred: 'TokenPulse 开始记录登录之前的请求，按最早记下的账号推断'
};
/** 项目和账号放一格：上面项目，下面是发出这次请求的账号。 */
function projectAccountCell(row) {
  const account = row.account
    ? el('small', { class: 'account-line', title: `${row.account.label}\n${ACCOUNT_BASIS_HINT[row.account.basis]}` }, [icon('user'), el('span', { text: row.account.label }), row.account.basis === 'inferred' ? el('em', { text: '推断' }) : null])
    : el('small', { class: 'account-line muted', text: row.official === false ? 'API Key / 中转站' : '账号未知' });
  return el('td', { class: 'account-cell' }, [el('span', { class: 'project-name', text: projectOf(row.cwd), title: row.cwd || '' }), account]);
}

/**
 * 这次请求大约占了多少官方额度：Token ÷ 它所在窗口折算出的整窗容量（capacityHistory，按本机用量倒推）。
 * 只算走官方账号、而且就是 TokenPulse 查额度的那个账号的请求；窗口没折算出容量的（已用不到 2% 等）不编数。
 */
const KIND_OF_SOURCE = { 'Claude Code': 'claude', 'Codex CLI': 'chatgpt', 'Grok Build': 'grok' };
function quotaShare(row) {
  // 同一家可能有好几个账号在查额度：找这条请求所属账号的那份
  const reports = current?.accounts?.filter(item => item.kind === KIND_OF_SOURCE[row.source]) || [];
  const report = reports.find(item => item.accountId && item.accountId === row.account?.id) || (reports.length === 1 && !reports[0].accountId ? reports[0] : null);
  if (!report || !row.account) return null;
  const share = name => {
    const point = report.capacityHistory?.[name]?.points?.find(p => row.at >= p.startAt && row.at < p.resetAt);
    return point?.capacityTokens ? { pct: row.tokens / point.capacityTokens * 100, confidence: point.confidence } : null;
  };
  const week = share('week'), five = share('five');
  return week || five ? { week, five } : null;
}
function sharePct(value) { return value < 0.01 ? '<0.01%' : value < 1 ? value.toFixed(2) + '%' : value.toFixed(1) + '%'; }
function quotaCell(row) {
  const share = quotaShare(row);
  if (!share) return el('td', { class: 'n muted quota-share', text: '—', title: '走中转 / 没对上账号，或者这个窗口还折算不出整窗容量' });
  const lines = [share.five ? `5 小时 ${sharePct(share.five.pct)}` : null, share.week ? `周 ${sharePct(share.week.pct)}` : null].filter(Boolean);
  const low = [share.five, share.week].some(item => item && item.confidence === 'low');
  return el('td', { class: 'n quota-share' + (low ? ' low' : ''), title: `≈ 这次请求的 Token ÷ 窗口整窗容量（按本机用量倒推的估算）${low ? '\n窗口已用不到 5%，偏差较大' : ''}` },
    lines.map(text => el('span', { text: '≈ ' + text })));
}
function accountName(item) { return item.id === 'none' ? '没对上账号（中转 / API Key 等）' : item.label || item.id; }
/** 账号筛选的选项跟着数据走：当前时间和工具下出现过的账号。 */
function syncAccountOptions(page) {
  const select = $('request-account');
  const items = page.accounts || [];
  const wanted = ['', ...items.map(item => item.id)];
  if (state.reqAccount && !wanted.includes(state.reqAccount)) wanted.push(state.reqAccount);
  const have = [...select.options].map(option => option.value);
  if (wanted.join('\u0000') !== have.join('\u0000')) {
    select.replaceChildren(el('option', { value: '', text: '全部账号' }), ...wanted.slice(1).map(id => {
      const item = items.find(entry => entry.id === id);
      return el('option', { value: id, text: item ? `${accountName(item)} · ${item.source}` : id });
    }));
  }
  select.value = state.reqAccount;
}

/** request-verify.ts 里「问题」排在「说明」前面；说明都以这些开头。 */
const NOTE_PREFIX = /^(这段会话|Codex 会话|这一轮|这次请求接的是|走的是|经 |grok-|来自 CC Switch)/;
function requestDetail(row) {
  const t = clock(row.at);
  const fields = [
    ['时间', t.full], ['请求型号', row.requested || '未记录'], ['返回型号', row.returned || '未记录'], ['响应格式', row.channel],
    ['账号', row.account ? row.account.label : row.official === false ? 'API Key / 中转站' : '对不上'],
    ['账号依据', row.account ? `${ACCOUNT_BASIS[row.account.basis]}：${ACCOUNT_BASIS_HINT[row.account.basis]}` : '—'],
    ['账号类型', row.official === true ? '官方登录账号' : row.official === false ? 'API Key / 中转站' : '未知'],
    ['额度占用（估算）', (share => share ? [share.five ? `5 小时 ${sharePct(share.five.pct)}` : '', share.week ? `周 ${sharePct(share.week.pct)}` : ''].filter(Boolean).join(' · ') : '—')(quotaShare(row))],
    ['Tokens', number(row.tokens)],
    ['响应 ID', row.responseId || '—', true], ['请求 ID', row.requestId || '—', true], ['会话', row.session, true],
    ['工作目录', row.cwd || '—'], ['缓存写入', number(row.cacheWrite)], ['推理 Tokens', number(row.reasoning)],
    ...(row.calls > 1 ? [['模型调用', `${number(row.calls)} 次（Grok 按轮记录）`]] : [])
  ];
  return el('tr', { class: `request-detail ${row.status}` }, [el('td', { colspan: 9 }, [
    el('div', { class: 'detail-grid' }, fields.map(([label, value, mono]) => el('div', {}, [el('small', { text: label }), el('span', { class: mono ? 'mono' : '', text: value, title: value })]))),
    row.reasons.length ? el('div', { class: 'detail-reasons' }, row.reasons.map(reason => {
      const problem = (row.status === 'mismatch' || row.status === 'suspect') && !NOTE_PREFIX.test(reason);
      return el('p', { class: problem ? 'problem' : '' }, [icon(problem ? 'alert' : 'info'), reason]);
    })) : null
  ].filter(Boolean))]);
}
function drawRequests() {
  const page = requestPage; if (!page) return;
  const c = page.counts;
  const verifiable = c.match + c.mismatch + c.suspect;
  $('verify-tiles').replaceChildren(
    el('span', { class: 'verify-chips-label', text: '型号核验' }),
    verifyChip('all', '全部请求', c.all),
    verifyChip('match', '型号一致', c.match, verifiable ? `${(Math.floor(c.match / verifiable * 1000) / 10).toFixed(1)}%` : ''),
    verifyChip('mismatch', '型号不一致', c.mismatch),
    verifyChip('suspect', '响应存疑', c.suspect),
    verifyChip('unverified', '无法核验', c.unverified)
  );
  $('request-count').textContent = `${number(page.total)} 条`;
  syncAccountOptions(page);
  $('export-requests').disabled = !page.total;
  const rows = [];
  page.rows.forEach((row, i) => {
    const t = clock(row.at), open = openRequests.has(row.key);
    rows.push(stagger(el('tr', { class: `request-row ${row.status}${open ? ' open' : ''}`, 'data-key': row.key, tabindex: '0', 'aria-expanded': String(open) }, [
      el('td', { class: 'request-time', title: t.full }, [el('b', { text: `${t.day} ${t.time}` }), el('small', {}, [miniLogo(row.source), row.source])]),
      projectAccountCell(row),
      modelCell(row),
      el('td', { class: 'n', title: number(row.input) }, qty(row.input)),
      el('td', { class: 'n', title: number(row.output) }, qty(row.output)),
      el('td', { class: 'n', title: number(row.cacheRead) }, qty(row.cacheRead)),
      quotaCell(row),
      el('td', { class: 'n', text: row.priced ? money(row.costUsd) : '未定价' }),
      el('td', {}, [el('span', { class: 'badge ' + VERIFY_TONE[row.status], text: row.statusLabel, title: row.reasons[0] || '' })])
    ]), i));
    if (open) rows.push(requestDetail(row));
  });
  if (!rows.length) rows.push(el('tr', {}, [el('td', { colspan: 9, class: 'empty', text: c.all ? '这个核验结论下没有请求，换一个试试。' : '所选时间和工具下没有请求记录。' })]));
  $('request-rows').replaceChildren(...rows);
  $('request-pagination').textContent = `第 ${page.page + 1} / ${page.pages} 页 · 共 ${number(page.total)} 次请求`;
  $('request-prev').disabled = page.page === 0; $('request-next').disabled = page.page >= page.pages - 1;
}
/** 侧栏上的红点：最近 7 天型号不一致 / 响应存疑的次数（快照里带着，不用进页面才知道）。 */
function renderRequestAlert(snapshot) {
  const n = snapshot.requestFlags?.flagged || 0;
  $('nav-request-alert').hidden = !n;
  $('nav-request-alert').textContent = n > 99 ? '99+' : String(n);
  $('nav-request-alert').title = n ? `最近 7 天有 ${n} 次请求型号不一致或响应存疑` : '';
}
function requeryRequests(resetPage = true) {
  if (resetPage) state.reqPage = 0;
  openRequests.clear();
  if (current && requestsVisible()) loadRequests();
}

/* ---------------- 渲染与导航 ---------------- */

function render(snapshot) {
  const first = !current;
  current = snapshot;
  if (first) enter();
  /*
   * 定时刷新（每分钟推送 + 每 30 秒重绘）会把额度详情、明细表、图表整块清空再重建。
   * 清空那一刻页面变矮，浏览器把滚动位置夹到顶部附近，内容回来后也不会自己滚回去 ——
   * 看起来就是「一刷新就被拉回最上面」。重建期间锁住主区高度，重建完还原滚动位置。
   */
  keepScroll(() => renderPage(snapshot));
}
/** 重建期间锁住主区高度，重建完还原滚动位置。 */
/** 滚动的是工作区，不是整个窗口（标题栏下面那块，见 app.css 的 .workspace）。 */
const scroller = document.querySelector('.workspace');
function keepScroll(rebuild) {
  const main = $('main'), scrollY = scroller.scrollTop;
  main.style.minHeight = `${main.offsetHeight}px`;
  try { rebuild(); }
  finally {
    main.style.minHeight = '';
    if (scroller.scrollTop !== scrollY) scroller.scrollTo({ top: scrollY, behavior: 'instant' });
  }
}
function renderPage(snapshot) {
  if ($('app-status').getAttribute('role') !== 'alert') $('app-status').hidden = true;
  updateRange(); renderStats();
  if (state.page === 'overview') renderOverview();
  if (state.page === 'quota') renderQuota();
  if (state.page === 'usage') renderUsage();
  // 会话页自己管数据；只在还没读过或列表放了一阵子时重读，不跟着每分钟的快照整页重画
  if (state.page === 'sessions') window.PulseSessions?.show();
  if (requestsVisible()) loadRequests();
  renderRequestAlert(snapshot);
  syncSourceOptions(snapshot);
  $('today-label').textContent = new Date().toLocaleDateString(dateLocale(), { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  $('stamp').textContent = snapshot.scannedAt ? `${date(snapshot.scannedAt)} 已更新` : '正在扫描本地会话…';
  $('data-summary').textContent = `${number(snapshot.fileCount || 0)} 个会话文件 · ${number(snapshot.totals.all.requests)} 次历史请求 · 本机时区`;
  syncSegs();
}
/** 逐条请求在用量明细页里，是它的默认视图。 */
function requestsVisible() { return state.page === 'usage' && state.usageView === 'requests'; }
function showUsageView(view) {
  state.usageView = view === 'daily' ? 'daily' : 'requests';
  const requests = state.usageView === 'requests';
  $('view-requests').hidden = !requests; $('view-daily').hidden = requests;
  $('request-count').hidden = !requests; $('record-count').hidden = requests;
  // 标题栏上的按钮跟着视图换：说明和逐条导出只属于逐条请求
  $('verify-help').hidden = $('export-requests').hidden = !requests; $('export-csv').hidden = requests;
  $('detail-caption').textContent = requests
    ? '每一行是一次 API 请求：用了多少 Token、占了多少额度、谁发的、型号对不对。点开看详情'
    : '按日期、工具、模型聚合；费用为参考估算';
  for (const button of $('usage-view').querySelectorAll('[data-view]')) { const on = button.dataset.view === state.usageView; button.classList.toggle('on', on); button.setAttribute('aria-pressed', String(on)); }
  syncSeg($('usage-view'));
}
/**
 * 时间范围按页面各管各的：总览默认 30 天、改了会记住；用量明细每次打开都从「今天」开始（看明细一般是看今天的）。
 */
const overviewRange = { days: 30, from: '', to: '', follow: false };
function navigate(page) {
  // 以前的「请求记录」页并进了用量明细（通知、额度详情的链接还会传 requests 过来）
  if (page === 'requests') { page = 'usage'; showUsageView('requests'); }
  if (!['overview', 'quota', 'usage', 'sessions'].includes(page)) page = 'overview';
  const rangePage = state.rangePage || 'overview';
  if (page === 'usage' && state.page !== 'usage') {
    if (rangePage === 'overview') Object.assign(overviewRange, { days: state.days, from: state.from, to: state.to, follow: state.follow });
    Object.assign(state, { days: 1, follow: false, tablePage: 0, reqPage: 0 });
  }
  if (page === 'overview' && rangePage === 'usage') Object.assign(state, overviewRange, { tablePage: 0 });
  if (page === 'overview' || page === 'usage') state.rangePage = page;
  state.page = page;
  const labels = { overview: ['总览', '今天的用量与额度', '看看还剩多少额度，再安排接下来的工作。'], quota: ['额度详情', '把使用节奏，放在时间里看', '剩余额度、重置时间与达到上限的参考时间，集中在这里。'], usage: ['用量明细', '每一笔用量，每一次请求', '逐条看每一次请求用了多少 Token、占了多少额度、是哪个账号发的、型号对不对；也能按日汇总看整体。'], sessions: ['会话管理', '本机 Agent 的对话历史', '查看、复制项目地址，或者直接接着回复。'] }[page];
  ['page-label', 'page-title', 'page-description'].forEach((id, i) => { $(id).textContent = labels[i]; });
  for (const button of document.querySelectorAll('[data-page]')) { button.classList.toggle('active', button.dataset.page === page); button.setAttribute('aria-current', button.dataset.page === page ? 'page' : 'false'); }
  moveIndicator();
  for (const name of ['overview', 'quota', 'usage', 'sessions']) $('page-' + name).hidden = name !== page;
  // 会话页是占满屏幕的工作台：大标题、页脚在那一页收起来（sessions.css）
  document.body.dataset.page = page;
  $('overview-analysis').hidden = page !== 'overview';
  $('usage-filters').hidden = $('usage-summary').hidden = page === 'quota' || page === 'sessions';
  $('tip').hidden = true;
  enter();
  if (current) render(current);
  syncSegs();
  scroller.scrollTo({ top: 0, behavior: 'instant' });
}
let themeTimer = 0;
function resolvedTheme() { return themeMode === 'system' ? (darkQuery.matches ? 'dark' : 'light') : themeMode; }
function applyTheme(animate = false) {
  if (animate && !reducedMotion.matches) {
    document.documentElement.classList.add('theme-anim');
    clearTimeout(themeTimer);
    themeTimer = setTimeout(() => document.documentElement.classList.remove('theme-anim'), 450);
  }
  document.documentElement.dataset.theme = resolvedTheme();
  // 主进程据此设置窗口底色，避免拉伸窗口时露出另一种主题的底。
  api.setTheme?.(resolvedTheme()).catch(() => {});
}
function setThemeMode(mode) {
  themeMode = mode;
  try { localStorage.setItem(THEME_KEY, mode); } catch {}
  applyTheme(true);
}

/* ---------------- 选项选择器（设置页通用，参照 AllAi 的 OptionSelect） ---------------- */

let menuOwner = null;
function closeOptionMenu(restoreFocus = false) {
  const menu = $('option-menu');
  if (menu.hidden) return;
  menu.hidden = true;
  menuOwner?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) menuOwner?.focus();
  menuOwner = null;
}
function openOptionMenu(trigger, label, options, value, pick) {
  closeOptionMenu();
  const menu = $('option-menu');
  menu.setAttribute('aria-label', label);
  menu.replaceChildren(el('div', { class: 'option-menu-label', text: label }), ...options.map(option => {
    const selected = option.value === value;
    const item = el('button', { class: 'option-item', type: 'button', role: 'menuitemradio', 'aria-checked': selected, 'data-value': String(option.value), tabindex: -1 }, [
      el('span', { class: 'option-item-text' }, [el('b', { text: option.label }), option.hint ? el('small', { text: option.hint }) : null]),
      selected ? icon('check', 'icon option-check') : null
    ]);
    item.addEventListener('click', () => { closeOptionMenu(true); if (!selected) pick(option.value); });
    return item;
  }));
  menu.hidden = false;
  menuOwner = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  // 菜单挂在 body 上、按触发按钮定位：放在设置页的滚动区里会被裁掉。
  const rect = trigger.getBoundingClientRect(), width = Math.min(Math.max(rect.width, 280), window.innerWidth - 24);
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
  const height = menu.offsetHeight;
  menu.style.top = `${window.innerHeight - rect.bottom - 12 >= height ? rect.bottom + 6 : Math.max(12, rect.top - height - 6)}px`;
  (menu.querySelector('[aria-checked="true"]') || menu.querySelector('.option-item'))?.focus();
}
function optionSelect({ id, label, options, value, onChange }) {
  const text = el('span', { class: 'ui-select-text' });
  const trigger = el('button', { class: 'ui-select', id, type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, [text, icon('chevron', 'icon ui-select-chevron')]);
  const show = next => {
    value = next;
    text.textContent = options.find(option => option.value === next)?.label ?? '未选择';
    trigger.setAttribute('aria-label', `${label}：${text.textContent}`);
  };
  show(value);
  trigger.addEventListener('click', () => {
    if (menuOwner === trigger) { closeOptionMenu(); return; }
    openOptionMenu(trigger, label, options, value, async next => {
      const previous = value;
      show(next);
      // onChange 返回 false 表示没保存成功，界面退回原来的值。
      if (await onChange(next) === false) show(previous);
    });
  });
  return trigger;
}
$('option-menu').addEventListener('keydown', event => {
  const items = [...$('option-menu').querySelectorAll('.option-item')];
  const index = items.indexOf(document.activeElement);
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeOptionMenu(true); }
  else if (event.key === 'Tab') { event.preventDefault(); closeOptionMenu(true); }
  else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
});
document.addEventListener('pointerdown', event => {
  if (menuOwner && !$('option-menu').contains(event.target) && !menuOwner.contains(event.target)) closeOptionMenu();
});
window.addEventListener('scroll', event => { if (!$('option-menu').contains(event.target)) closeOptionMenu(); }, true);

/* ---------------- 设置 ---------------- */

const THEME_OPTIONS = [
  { value: 'light', label: '日间', hint: '一直用浅色' },
  { value: 'dark', label: '夜间', hint: '一直用深色' },
  { value: 'system', label: '跟随系统', hint: '跟着 Windows 的深浅色走，系统一换这边立刻跟着变' }
];
/** 存进 prefs.json 的设置项。外观不在这里：它要在读 prefs 之前就生效，存在 localStorage。 */
const PREF_ROWS = {
  general: [
    { key: 'closeToTray', title: '关闭窗口时', hint: '收进托盘后照常每分钟记录用量、每 5 分钟采样额度。真正退出请用托盘图标的右键菜单。', options: [
      { value: true, label: '收进托盘继续运行', hint: '默认。后台记录不中断' },
      { value: false, label: '直接退出', hint: '关掉窗口就结束进程，期间不记录用量' }] },
    { key: 'autoLaunch', title: '开机自启', hint: '登录电脑后自动在托盘里开始记录。只对安装版和免安装版生效，开发模式不会写入启动项。', options: [
      { value: true, label: '开机自动启动', hint: '默认。电脑开着就一直记' },
      { value: false, label: '不自动启动', hint: '需要时手动打开' }] },
    { key: 'startMinimized', title: '启动时', hint: '手动打开 TokenPulse 时是否弹出窗口。开机自启那一次总是直接进托盘。', options: [
      { value: false, label: '显示窗口', hint: '默认' },
      { value: true, label: '直接进入托盘', hint: '点托盘图标再打开窗口' }] }
  ],
  alerts: [
    { key: 'notifyAt', title: '额度提醒', hint: '任一官方额度窗口（5 小时或每周）的已用比例达到这个值时，发一条系统通知。同一个窗口只提醒一次，重置后重新计算。', custom: value => `已用 ${value}% 时提醒`, options: [
      { value: 0, label: '不提醒', hint: '关闭额度通知' },
      { value: 70, label: '已用 70% 时提醒', hint: '留出充足余量' },
      { value: 80, label: '已用 80% 时提醒' },
      { value: 85, label: '已用 85% 时提醒', hint: '默认' },
      { value: 90, label: '已用 90% 时提醒' },
      { value: 95, label: '已用 95% 时提醒', hint: '快用完才提醒' }] },
    { key: 'notifyMismatch', title: '型号核验提醒', hint: '新请求的返回型号和请求的对不上、或者响应格式不像官方时，发一条系统通知，点开直接跳到请求记录。', options: [
      { value: true, label: '发现就提醒', hint: '默认' },
      { value: false, label: '不提醒', hint: '只在请求记录页和侧栏红点里显示' }] }
  ]
};
function settingRow(title, hint, control) {
  return el('div', { class: 'setting-block' }, [el('div', { class: 'setting-title', text: title }), el('p', { class: 'setting-hint', text: hint }), control]);
}
async function savePref(key, value) {
  $('prefs-status').textContent = '正在保存…';
  try { await api.writePrefs({ [key]: value }); $('prefs-status').textContent = '设置已保存'; return true; }
  catch { $('prefs-status').textContent = '保存失败，请检查数据目录权限'; return false; }
}
function prefRow(row, prefs) {
  const value = prefs[row.key];
  // 手改过 prefs.json、值不在预设里时，把它当成一个选项显示出来，而不是显示「未选择」。
  const options = row.options.some(option => option.value === value) || !row.custom ? row.options : [...row.options, { value, label: row.custom(value), hint: '当前自定义值' }];
  return settingRow(row.title, row.hint, optionSelect({ id: 'pref-' + row.key, label: row.title, value, options, onChange: next => savePref(row.key, next) }));
}
/* ---------------- 软件更新（关于页） ---------------- */

const RELEASES_URL = 'https://github.com/JohnMuyuan/TokenPulse/releases/latest';
let updateInfo = null;
/** 更新状态卡片：一个图标 + 一句话 + 一行说明 + 进度 / 按钮。状态由主进程推送（updater.ts）。 */
function renderUpdate(info = updateInfo) {
  updateInfo = info;
  if (!info) return;
  const current = `v${info.currentVersion}`;
  const next = info.version ? `v${info.version}` : '';
  const checked = info.checkedAt ? `上次检查 ${date(info.checkedAt)}` : '';
  const view = {
    unsupported: ['info', `当前版本 ${current}`, info.reason, 'muted'],
    idle: ['update', `当前版本 ${current}`, info.autoUpdate ? '会在后台定期检查新版本' : '自动更新已关闭，可以手动检查', ''],
    checking: ['update', '正在检查更新…', '连接 GitHub 发布页', 'busy'],
    latest: ['check', `已是最新版本 ${current}`, checked, 'ok'],
    available: ['download', `发现新版本 ${next}`, '自动更新已关闭，点「下载更新」获取', 'accent'],
    downloading: ['download', `正在下载 ${next}`, `${info.progress ?? 0}% · 在后台进行，可以继续使用`, 'busy'],
    downloaded: ['check', `新版本 ${next} 已下载`, info.autoUpdate ? '窗口收进托盘或最小化后会自动安装并重启，也可以现在就更新' : '点「立即重启并更新」完成安装', 'accent'],
    error: ['alert', '检查更新失败', info.error || '稍后会自动重试', 'warn']
  }[info.status] || ['update', `当前版本 ${current}`, '', ''];
  const [iconName, title, sub, tone] = view;
  const actions = [];
  const action = (text, handler, primary = false, iconId) => {
    const button = el('button', { class: 'btn' + (primary ? ' btn-accent' : '') }, [iconId ? icon(iconId) : null, text]);
    button.addEventListener('click', async () => { button.disabled = true; try { renderUpdate(await handler()); } catch { /* 状态由主进程推送 */ } finally { button.disabled = false; } });
    return button;
  };
  if (info.status === 'unsupported') actions.push(el('a', { class: 'btn', href: RELEASES_URL, target: '_blank', rel: 'noreferrer' }, [icon('external'), '前往 GitHub 下载']));
  else if (info.status === 'downloaded') actions.push(action('立即重启并更新', () => api.installUpdate(), true, 'update'));
  else if (info.status === 'available') actions.push(action('下载更新', () => api.downloadUpdate(), true, 'download'));
  if (['idle', 'latest', 'error', 'available'].includes(info.status)) actions.push(action(info.status === 'error' ? '重试' : '检查更新', () => api.checkForUpdates(), false, 'refresh'));
  $('update-card').className = `update-card ${tone}`.trim();
  // replaceChildren 会把 null 当成文字「null」渲染出来，先滤掉。只有「检查中」的刷新图标转圈，下载箭头转起来是倒的。
  $('update-card').replaceChildren(...[
    el('span', { class: 'update-icon' + (info.status === 'checking' ? ' spinning' : '') }, [icon(iconName)]),
    el('div', { class: 'update-text' }, [
      el('b', { text: title }),
      sub ? el('span', { text: sub }) : null,
      info.status === 'downloading' ? track(info.progress ?? 0, false, '下载进度', 'five') : null
    ]),
    actions.length ? el('div', { class: 'update-actions' }, actions) : null
  ].filter(Boolean));
  // 不支持自动更新的版本（便携版 / 免安装版）不显示开关，免得误以为打开就能更新。
  if (info.status === 'unsupported') { $('update-auto').replaceChildren(); return; }
  if (!$('pref-autoUpdate')) {
    $('update-auto').replaceChildren(optionSelect({
      id: 'pref-autoUpdate', label: '自动更新', value: info.autoUpdate,
      options: [
        { value: true, label: '自动更新（推荐）', hint: '后台下载，窗口收起时静默安装并重启' },
        { value: false, label: '只提醒', hint: '发现新版本时在这里提示，由你决定何时安装' }
      ],
      onChange: next => savePref('autoUpdate', next)
    }));
  }
}
function loadUpdateState() {
  api.updateState?.().then(renderUpdate).catch(() => {});
}
api.onUpdateState?.(renderUpdate);

/* ---------------- CC Switch 导入（数据页） ---------------- */

function renderCcSwitch(status = current?.ccSwitch, prefs) {
  if (!status) return;
  let title, sub, tone = '';
  if (!status.enabled) { title = '已关闭导入'; sub = '统计里只有 TokenPulse 自己扫描到的记录'; }
  else if (!status.found) { title = '没有找到 CC Switch'; sub = `本机没有 ${status.path || '~/.cc-switch/cc-switch.db'}，装了 CC Switch 之后会自动导入`; }
  else if (status.error) { title = '读取 CC Switch 失败'; sub = status.error; tone = 'warn'; }
  else {
    const requests = status.sources.reduce((n, item) => n + item.requests, 0);
    title = requests ? `已补入 ${number(requests)} 次请求` : '没有需要补的记录';
    sub = [
      status.sources.length ? status.sources.map(item => `${item.source} ${number(item.requests)}`).join(' · ') : '',
      `${number(status.importedDays)} 个「天 × 工具」来自 CC Switch，${number(status.skippedDays)} 个本机已有、跳过`,
      status.proxyRequests ? `${number(status.proxyRequests)} 次代理请求用于型号核验` : '',
      status.syncedAt ? `${date(status.syncedAt)} 同步` : ''
    ].filter(Boolean).join('；');
    tone = 'ok';
  }
  const sync = el('button', { class: 'btn', id: 'cc-switch-sync' }, [icon('refresh'), '立即同步']);
  sync.disabled = !status.enabled;
  sync.addEventListener('click', async () => {
    sync.disabled = true; sync.classList.add('is-busy');
    try { render(await api.syncCcSwitch()); renderCcSwitch(); }
    catch { $('prefs-status').textContent = '同步失败，请重试'; }
    finally { sync.disabled = false; sync.classList.remove('is-busy'); }
  });
  $('cc-switch-card').className = `update-card ${tone}`.trim();
  $('cc-switch-card').replaceChildren(
    el('span', { class: 'update-icon' }, [icon(status.found && status.enabled && !status.error ? 'check' : 'info')]),
    el('div', { class: 'update-text' }, [el('b', { text: title }), el('span', { text: sub })]),
    el('div', { class: 'update-actions' }, [sync])
  );
  if (prefs) {
    $('cc-switch-pref').replaceChildren(optionSelect({
      id: 'pref-ccSwitch', label: '从 CC Switch 导入', value: prefs.ccSwitch !== false,
      options: [
        { value: true, label: '自动导入', hint: '默认。检测到 CC Switch 就补上缺的记录' },
        { value: false, label: '不导入', hint: '只统计 TokenPulse 自己扫描到的' }
      ],
      onChange: async next => { if (await savePref('ccSwitch', next)) { render(await api.refresh()); renderCcSwitch(); } }
    }));
  }
}

/** 工具筛选的选项跟着数据走：导入了 OpenCode 之类的才会出现。 */
function syncSourceOptions(snapshot) {
  const select = $('source-filter');
  const names = ['Claude Code', 'Codex CLI', 'Grok Build', ...(snapshot.sources || []).map(item => item.source)].filter((name, i, all) => all.indexOf(name) === i);
  const currentNames = [...select.options].slice(1).map(option => option.value);
  if (names.join('\u0000') === currentNames.join('\u0000')) return;
  select.replaceChildren(el('option', { value: 'all', text: '全部工具' }), ...names.map(name => el('option', { value: name, text: name })));
  select.value = names.includes(state.source) ? state.source : 'all';
}

/* ---------------- 模型知识库（关于页） ---------------- */

/** 知识库写的是哪天就显示哪天：按时区换算的话，东八区零点的日期在别的时区会变成前一天。 */
function knowledgeDate(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).toLocaleDateString(dateLocale(), { year: 'numeric', month: 'long', day: 'numeric' }) : '—';
}
function renderKnowledge(info) {
  if (!info) return;
  const tone = info.error ? 'warn' : info.updated ? 'accent' : '';
  const sub = [
    `${knowledgeDate(info.updatedAt)} 更新`,
    `${number(info.prices)} 条定价规则 · ${number(info.aliases)} 条型号等价规则`,
    info.source === 'downloaded' ? '已从 GitHub 更新' : '随安装包内置',
    info.error || (info.checkedAt ? `${date(info.checkedAt)} 检查过${info.updated ? '，已更新到最新' : '，已是最新'}` : '')
  ].filter(Boolean).join(' · ');
  const check = el('button', { class: 'btn', id: 'knowledge-check' }, [icon('refresh'), '检查更新']);
  check.addEventListener('click', async () => {
    check.disabled = true; check.classList.add('is-busy');
    try { renderKnowledge(await api.checkKnowledge()); }
    catch { $('prefs-status').textContent = '检查知识库失败，请重试'; }
    finally { check.disabled = false; check.classList.remove('is-busy'); }
  });
  $('knowledge-card').className = `update-card ${tone}`.trim();
  $('knowledge-card').replaceChildren(
    el('span', { class: 'update-icon' }, [icon('cost')]),
    el('div', { class: 'update-text' }, [el('b', { text: `知识库 v${info.version}` }), el('span', { text: sub })]),
    el('div', { class: 'update-actions' }, [check])
  );
  renderKnowledgeGaps();
}
/** 数据里还没有定价的型号：用户一眼就知道知识库缺什么。 */
function renderKnowledgeGaps() {
  const gaps = new Map();
  for (const row of current?.usage || []) if (row.priced === false) gaps.set(row.model, (gaps.get(row.model) || 0) + row.requests);
  const list = [...gaps].sort((a, b) => b[1] - a[1]);
  $('knowledge-gaps').hidden = !list.length;
  $('knowledge-gaps').replaceChildren(
    icon('alert'),
    el('span', { text: `${number(list.length)} 个型号还没有定价：${list.slice(0, 6).map(([model, n]) => `${model}（${number(n)} 次）`).join('、')}${list.length > 6 ? ' 等' : ''}。更新知识库后会自动重算。` })
  );
}
function loadKnowledge() { api.knowledgeState?.().then(renderKnowledge).catch(() => {}); }

const NUMBER_OPTIONS = [
  { value: 'exact', label: '精确到个位', hint: '默认。例如 3,031,245,120' },
  { value: 'compact', label: '简写', hint: '例如 3.03B、240.3M' }
];
function setNumberMode(mode) {
  numberMode = mode === 'compact' ? 'compact' : 'exact';
  try { localStorage.setItem(NUMBER_KEY, numberMode); } catch { /* 存不下就只对这次生效 */ }
  if (current) render(current);
}
const LANGUAGE_OPTIONS = [
  { value: 'system', label: '跟随系统', hint: '跟着 Windows 的显示语言走' },
  { value: 'zh', label: '简体中文' },
  { value: 'en', label: 'English' }
];
function renderSettings(prefs) {
  $('settings-general').replaceChildren(
    settingRow('外观', '深浅色。选「跟随系统」就跟着 Windows 的设置走。', optionSelect({ id: 'pref-theme', label: '外观', value: themeMode, options: THEME_OPTIONS, onChange: setThemeMode })),
    settingRow('数字显示', 'Token 和请求数怎么显示。中文界面会在数字后面再加一个小字，例如「≈30.3亿」，方便按中文习惯读。图表坐标轴始终用简写。', optionSelect({
      id: 'pref-number', label: '数字显示', value: numberMode, options: NUMBER_OPTIONS, onChange: setNumberMode
    })),
    settingRow('语言', '界面语言。切换后界面会重新加载。', optionSelect({
      id: 'pref-language', label: '语言', value: window.PulseI18n?.mode() || 'system', options: LANGUAGE_OPTIONS,
      // 主进程的托盘菜单和通知也跟着换：先存进 prefs，再重新加载界面
      onChange: async next => { await savePref('language', next); window.PulseI18n?.setMode(next); }
    })),
    ...PREF_ROWS.general.map(row => prefRow(row, prefs)));
  $('settings-alerts').replaceChildren(...PREF_ROWS.alerts.map(row => prefRow(row, prefs)));
  renderCcSwitch(current?.ccSwitch, prefs);
}
function showSettingsTab(tab) {
  closeOptionMenu();
  for (const button of $('settings-tabs').querySelectorAll('button')) {
    button.classList.toggle('on', button.dataset.settingsTab === tab);
    button.setAttribute('aria-selected', button.dataset.settingsTab === tab);
  }
  for (const panel of $('settings').querySelectorAll('.settings-panel')) panel.hidden = panel.dataset.panel !== tab;
  $('settings').querySelector('.settings-body').scrollTop = 0;
  syncSeg($('settings-tabs'));
}
async function openSettings(tab = 'general') {
  let prefs;
  try { prefs = await api.readPrefs(); }
  catch { showStatus('设置读取失败，请重试。', true); return; }
  renderSettings(prefs);
  $('prefs-status').textContent = '修改后自动保存';
  openModal('settings');
  showSettingsTab(tab);
  // 账号状态要探测 CLI，慢一点；先把设置窗口打开，列表随后填上。
  loadOfficialAccounts();
  $('update-auto').replaceChildren();
  loadUpdateState();
  loadKnowledge();
}
/* ---------------- 事件 ---------------- */

for (const slot of document.querySelectorAll('[data-brand]')) slot.append(brandSvg(slot.dataset.brand));
applyTheme();
darkQuery.addEventListener('change', () => { if (themeMode === 'system') applyTheme(true); });
moveIndicator();
api.version?.().then(version => { for (const node of document.querySelectorAll('.app-version')) node.textContent = 'v' + version; }).catch(() => {});
for (const button of document.querySelectorAll('[data-page], [data-go]')) button.addEventListener('click', () => navigate(button.dataset.page || button.dataset.go));
document.querySelector('.brand').addEventListener('click', e => { e.preventDefault(); navigate('overview'); });
const picker = { from: '', to: '', follow: false, month: '' };
function monthOf(day) { return day.slice(0, 7); }
function shiftMonth(month, n) { const [y, m] = month.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function pickerValid() { return Boolean(picker.from && picker.to && picker.from <= picker.to); }
function renderPicker() {
  const today = D.dayKey(Date.now());
  if (picker.follow) picker.to = today;
  $('date-from').value = picker.from; $('date-to').value = picker.to;
  $('date-from').max = $('date-to').max = today;
  $('date-to').disabled = picker.follow;
  $('range-follow').checked = picker.follow;
  $('range-error').hidden = !(picker.from && picker.to) || pickerValid();
  $('range-apply').disabled = !pickerValid();
  for (const button of $('range-presets').querySelectorAll('button')) button.classList.toggle('on', String(state.days) === button.dataset.days);
  const [y, m] = picker.month.split('-').map(Number);
  $('cal-title').textContent = `${y} 年 ${m} 月`;
  $('cal-next').disabled = picker.month >= monthOf(today);
  const first = new Date(y, m - 1, 1);
  $('cal-grid').replaceChildren(...Array.from({ length: 42 }, (_, i) => {
    const d = new Date(y, m - 1, 1 - first.getDay() + i), key = D.dayKey(d.getTime());
    const outside = d.getMonth() !== m - 1, future = key > today;
    const edge = !outside && (key === picker.from || key === picker.to);
    const inside = !outside && picker.from && picker.to && key > picker.from && key < picker.to;
    const cell = el('button', { type: 'button', class: 'cal-day' + (edge ? ' edge' : inside ? ' inside' : '') + (key === today ? ' today' : ''), 'data-day': key, text: d.getDate() });
    cell.disabled = outside || future;
    return cell;
  }));
}
function openPicker() {
  picker.from = state.from; picker.to = state.to; picker.follow = state.days === 'custom' ? state.follow : state.days !== 'custom' && state.to === D.dayKey(Date.now());
  picker.month = monthOf(picker.from || D.dayKey(Date.now()));
  $('range-popover').hidden = false;
  $('range-button').setAttribute('aria-expanded', 'true');
  renderPicker();
  // 按钮在页面中下部时，浮层往下展开会被窗口底边截掉：滚到能看全为止。
  // 要等弹出动画（从 92% 放大）播完再量，否则量到的高度偏小、滚得不够。
  const reveal = () => {
    const overflow = $('range-popover').getBoundingClientRect().bottom - (window.innerHeight - 16);
    if (overflow > 0) scroller.scrollBy({ top: overflow, behavior: reducedMotion.matches ? 'instant' : 'smooth' });
  };
  if (reducedMotion.matches) reveal(); else $('range-popover').addEventListener('animationend', reveal, { once: true });
}
function closePicker() {
  $('range-popover').hidden = true;
  $('range-button').setAttribute('aria-expanded', 'false');
}
function applyRange(days, from, to, follow = false) {
  state.days = days; state.tablePage = 0;
  if (days === 'custom') { state.from = from; state.to = to; state.follow = follow; }
  closePicker();
  $('app-status').hidden = true;
  if (current) { render(current); if (state.page === 'overview') playChart($('daily-chart'), true); }
}
$('range-button').addEventListener('click', () => { if ($('range-popover').hidden) openPicker(); else closePicker(); });
$('range-presets').addEventListener('click', event => {
  const button = event.target.closest('[data-days]'); if (!button) return;
  applyRange(['all', '24h'].includes(button.dataset.days) ? button.dataset.days : Number(button.dataset.days));
});
// 点日历：第一下定开始，第二下定结束；第二下早于开始就重新从这一天开始（和 AllAi 一样）。
$('cal-grid').addEventListener('click', event => {
  const key = event.target.closest('[data-day]')?.dataset.day; if (!key) return;
  if (picker.follow) picker.from = key; // 结束日期跟着今天走，点哪天就是从哪天开始
  else if (!picker.from || picker.to || key < picker.from) { picker.from = key; picker.to = ''; }
  else picker.to = key;
  renderPicker();
});
$('cal-prev').addEventListener('click', () => { picker.month = shiftMonth(picker.month, -1); renderPicker(); });
$('cal-next').addEventListener('click', () => { picker.month = shiftMonth(picker.month, 1); renderPicker(); });
$('date-from').addEventListener('change', event => { picker.from = event.target.value; if (picker.from) picker.month = monthOf(picker.from); renderPicker(); });
$('date-to').addEventListener('change', event => { picker.to = event.target.value; if (picker.to) picker.month = monthOf(picker.to); renderPicker(); });
$('range-follow').addEventListener('change', event => { picker.follow = event.target.checked; renderPicker(); });
$('range-cancel').addEventListener('click', closePicker);
$('custom-range').addEventListener('submit', event => {
  event.preventDefault();
  if (!pickerValid()) { renderPicker(); return; }
  applyRange('custom', picker.from, picker.to, picker.follow);
});
document.addEventListener('pointerdown', event => {
  if (!$('range-popover').hidden && !event.target.closest('.range-picker')) closePicker();
});
$('range-popover').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closePicker(); $('range-button').focus(); } });

/* ---------------- 标题栏（窗口 frame: false，按钮跟着主题走） ---------------- */

$('win-min').addEventListener('click', () => api.windowMinimize?.());
$('win-max').addEventListener('click', () => api.windowToggleMaximize?.());
$('win-close').addEventListener('click', () => api.windowClose?.());
function showWindowState(maximized) {
  $('win-max').replaceChildren(icon(maximized ? 'win-restore' : 'win-max'));
  $('win-max').setAttribute('aria-label', maximized ? '还原' : '最大化');
  $('win-max').title = maximized ? '还原' : '最大化';
}
api.windowState?.().then(state => showWindowState(state.maximized)).catch(() => {});
api.onWindowState?.(state => showWindowState(state.maximized));

$('source-filter').addEventListener('change', event => { state.source = event.target.value; state.tablePage = 0; state.reqPage = 0; openRequests.clear(); if (current) render(current); });
$('verify-tiles').addEventListener('click', event => {
  const tile = event.target.closest('[data-verify]'); if (!tile) return;
  // 再点一次同一张卡片 = 取消筛选
  state.reqStatus = tile.dataset.verify === state.reqStatus ? 'all' : tile.dataset.verify;
  $('request-status').value = state.reqStatus;
  requeryRequests();
});
$('request-status').addEventListener('change', event => { state.reqStatus = event.target.value; requeryRequests(); });
$('usage-view').addEventListener('click', event => {
  const button = event.target.closest('[data-view]'); if (!button || button.dataset.view === state.usageView) return;
  showUsageView(button.dataset.view);
  if (current) render(current);
});
$('request-account').addEventListener('change', event => { state.reqAccount = event.target.value; requeryRequests(); });
$('request-sort').addEventListener('change', event => { state.reqSort = event.target.value; requeryRequests(); });
let requestSearchTimer = 0;
$('request-search').addEventListener('input', event => {
  state.reqSearch = event.target.value;
  clearTimeout(requestSearchTimer);
  // 每敲一个字就起一个查询线程太浪费，停下来 250ms 再查
  requestSearchTimer = setTimeout(() => requeryRequests(), 250);
});
$('request-prev').addEventListener('click', () => { state.reqPage--; requeryRequests(false); });
$('request-next').addEventListener('click', () => { state.reqPage++; requeryRequests(false); });
/**
 * 展开 / 收起只动这一行下面的详情，不整表重画：整表 replaceChildren 时被点的那一行（刚拿到焦点）
 * 被删掉再插回来，Chromium 的滚动锚点跟着丢了，页面会往上跳好几百像素（真实鼠标点击才复现）。
 */
function toggleRequest(row) {
  const key = row.dataset.key;
  const data = requestPage?.rows.find(item => item.key === key); if (!data) return;
  const open = !openRequests.has(key);
  if (open) { openRequests.add(key); row.after(requestDetail(data)); }
  else { openRequests.delete(key); if (row.nextElementSibling?.classList.contains('request-detail')) row.nextElementSibling.remove(); }
  row.classList.toggle('open', open);
  row.setAttribute('aria-expanded', String(open));
}
$('request-rows').addEventListener('click', event => { const row = event.target.closest('.request-row'); if (row) toggleRequest(row); });
$('request-rows').addEventListener('keydown', event => {
  const row = event.target.closest('.request-row');
  if (row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggleRequest(row); }
});
$('verify-help').addEventListener('click', () => {
  const open = $('verify-method').hidden;
  $('verify-method').hidden = !open;
  $('verify-help').setAttribute('aria-expanded', String(open));
});
$('export-requests').addEventListener('click', async () => {
  const button = $('export-requests'); button.disabled = true;
  try {
    const page = await api.requests(requestQuery({ all: true }));
    const rows = page.rows.map(row => ({ ...row, time: clock(row.at).full, project: projectOf(row.cwd), reason: row.reasons.join('；'), requested: row.requested || '', returned: row.returned || '', accountLabel: row.account?.label || (row.official === false ? 'API Key / 中转站' : ''), accountBasis: row.account ? ACCOUNT_BASIS[row.account.basis] : '', ...(share => ({ quotaFive: share?.five ? share.five.pct.toFixed(4) + '%' : '', quotaWeek: share?.week ? share.week.pct.toFixed(4) + '%' : '' }))(quotaShare(row)) }));
    if (await api.exportCsv(D.csv(rows, REQUEST_COLUMNS), 'requests')) showStatus(`已导出 ${number(rows.length)} 次请求。`);
  } catch { showStatus('导出失败，请检查保存位置是否可写。', true); }
  finally { button.disabled = !requestPage?.total; }
});
$('chart-metric').addEventListener('click', event => {
  const button = event.target.closest('[data-metric]'); if (!button) return;
  state.metric = button.dataset.metric;
  for (const item of $('chart-metric').querySelectorAll('button')) { item.classList.toggle('on', item === button); item.setAttribute('aria-pressed', item === button); }
  syncSeg($('chart-metric'));
  if (analysis) dailyChart(true);
});
$('account-tabs').addEventListener('click', event => {
  if (tabDragged) { tabDragged = false; event.preventDefault(); event.stopPropagation(); return; }
  const button = event.target.closest('[data-account]'); if (!button) return;
  state.account = button.dataset.account;
  if (current) { enter(); renderQuota(); }
});
// 账号多的时候这一行横着放不下。按住左右拖来看后面的，松手时如果真的拖动过，不要当成点选了某个账号。
let tabPan = null;
let tabDragged = false;
function endTabPan(tabs, dragged) {
  if (!tabPan) return;
  tabPan = null;
  tabs.classList.remove('panning');
  tabDragged = dragged;
}
$('account-tabs').addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  const tabs = event.currentTarget;
  if (tabs.scrollWidth - tabs.clientWidth <= 1) return;
  tabPan = { id: event.pointerId, x: event.clientX, left: tabs.scrollLeft, dragged: false };
  try { tabs.setPointerCapture(event.pointerId); } catch { /* 没有真实指针时（界面测试）捕获会失败，拖动仍然走这几个监听 */ }
});
$('account-tabs').addEventListener('pointermove', event => {
  if (!tabPan || event.pointerId !== tabPan.id) return;
  const dx = event.clientX - tabPan.x;
  if (!tabPan.dragged && Math.abs(dx) < 5) return;
  tabPan.dragged = true;
  const tabs = event.currentTarget;
  tabs.classList.add('panning');
  const max = tabs.scrollWidth - tabs.clientWidth;
  tabs.scrollLeft = Math.min(max, Math.max(0, tabPan.left - dx));
  markAccountTabEdges();
});
$('account-tabs').addEventListener('pointerup', event => {
  if (!tabPan || event.pointerId !== tabPan.id) return;
  endTabPan(event.currentTarget, tabPan.dragged);
});
$('account-tabs').addEventListener('pointercancel', event => {
  if (!tabPan || event.pointerId !== tabPan.id) return;
  endTabPan(event.currentTarget, false);
});
$('account-tabs').addEventListener('scroll', markAccountTabEdges);
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
  closeOptionMenu();
  $(id).hidden = true; document.body.classList.remove('modal-open');
  document.querySelector('.workspace').inert = document.querySelector('.sidebar').inert = false;
  lastFocus?.focus();
}
$('settings-close').addEventListener('click', () => closeModal('settings'));
$('settings').addEventListener('click', event => { if (event.target === $('settings')) closeModal('settings'); });
$('settings-tabs').addEventListener('click', event => { const button = event.target.closest('[data-settings-tab]'); if (button) showSettingsTab(button.dataset.settingsTab); });
$('settings-open').addEventListener('click', () => openSettings());
// 统计口径并进了设置的「数据」页。
$('methodology-open').addEventListener('click', () => openSettings('data'));
// 官方 OAuth 登录由 CLI 打开浏览器完成；界面只拿到成功后的账号列表，不接触 token。
/** 删除要点两下：第一下按钮变成「确认删除」，几秒内再点才真的删。不弹系统对话框。 */
let removeArmed = null;
function armRemove(button) {
  clearTimeout(removeArmed?.timer);
  if (removeArmed?.button && removeArmed.button !== button) disarmRemove();
  const hide = button.dataset.inCli === '1';
  button.classList.add('armed');
  button.replaceChildren(icon('trash'), hide ? '确认隐藏' : '确认删除');
  removeArmed = { button, timer: setTimeout(disarmRemove, 4000) };
  $('prefs-status').textContent = hide
    ? 'CLI 还登录着这个账号，删不掉，只会隐藏：不查额度、不在首页和额度页显示，随时可以恢复。再点一次确认。'
    : '删除后不再查询这个账号的额度，TokenPulse 保存的凭据也会一并删掉（已有的额度历史保留）。再点一次确认。';
}
function disarmRemove() {
  if (!removeArmed) return;
  clearTimeout(removeArmed.timer);
  const { button } = removeArmed;
  removeArmed = null;
  if (button.isConnected) { button.classList.remove('armed'); button.replaceChildren(icon('trash')); }
}
const ACCOUNT_DONE = { remove: '已删除账号', hide: '已隐藏账号，可以随时恢复', restore: '已恢复账号，正在查询额度' };
$('official-accounts').addEventListener('click', async event => {
  const button = event.target.closest('[data-account-action]');
  if (!button || button.disabled) return;
  const { accountAction: action, accountKind: kind, accountId: id } = button.dataset;
  if (action === 'rename') { disarmRemove(); startRename(button); return; }
  if (action === 'remove' && removeArmed?.button !== button) { armRemove(button); return; }
  const hiding = action === 'remove' && button.dataset.inCli === '1';
  disarmRemove();
  const buttons = [...$('official-accounts').querySelectorAll('button')];
  const disabledBefore = new Set(buttons.filter(item => item.disabled));
  buttons.forEach(item => { item.disabled = true; });
  $('prefs-status').textContent = action === 'login' ? '已在浏览器打开授权页面，完成后会自动返回…' : '正在保存…';
  try {
    if (action === 'login') {
      const result = await api.loginOfficialAccount(kind);
      if (!result?.ok) throw new Error(result?.error || 'OAuth 登录失败');
      renderOfficialAccounts(result.statuses);
      // 主进程已经在后台刷新额度；这里等它的结果，好让提示和界面同步。
      render(await api.refresh());
      $('prefs-status').textContent = '登录成功，已添加账号并刷新额度';
    } else {
      // 删除、恢复：主进程会重新汇总并把新快照推过来，这里不用再等一轮额度查询
      renderOfficialAccounts(await api.manageOfficialAccount(action, id));
      $('prefs-status').textContent = ACCOUNT_DONE[hiding ? 'hide' : action];
    }
  } catch (error) {
    $('prefs-status').textContent = cleanRemoteError(error, '账号操作失败，请重试');
  } finally {
    // 列表重画过的话这些按钮已经不在了；没重画（出错）就恢复原来的可用状态
    for (const item of buttons) if (item.isConnected) item.disabled = disabledBefore.has(item);
  }
});
$('open-data').addEventListener('click', async () => { try { const error = await api.openDataDir(); if (error) $('prefs-status').textContent = '无法打开数据目录：' + error; } catch { $('prefs-status').textContent = '无法打开数据目录'; } });
document.addEventListener('keydown', event => {
  const modal = ['settings'].find(id => !$(id).hidden); if (!modal || menuOwner) return;
  if (event.key === 'Escape') { event.preventDefault(); closeModal(modal); }
  if (event.key === 'Tab') {
    const controls = [...$(modal).querySelectorAll('button:not(:disabled), input:not(:disabled), a[href]')].filter(item => item.offsetParent);
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
  }
});
let width = 0;
new ResizeObserver(() => {
  const next = $('daily-chart').clientWidth;
  if (next && Math.abs(next - width) > 2 && analysis && state.page === 'overview') { width = next; dailyChart(entering()); }
}).observe($('daily-chart'));
window.addEventListener('resize', () => { moveIndicator(); syncSegs(); closeOptionMenu(); });
api.onSnapshot(render);
api.onOpenPage?.(target => {
  if (target?.status) { state.reqStatus = target.status; $('request-status').value = target.status; state.reqPage = 0; }
  navigate(target?.page || 'overview');
});
api.onError(message => showStatus(message, true));
api.snapshot().then(render).catch(() => showStatus('本地数据读取失败，请点击刷新重试。', true));
setInterval(() => { if (current && !document.hidden) render({ ...current, now: Date.now() }); }, 30000);
