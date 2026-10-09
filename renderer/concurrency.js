'use strict';
/*
 * 并发监控页（0.3.40）。只画界面：计数、上限和历史都在主进程（src/main/concurrency-monitor.ts）。
 * 从上到下：各工具的监控范围 → 三张实时计数卡（设了上限的带进度条）→ 超限提醒 → 并发历史 → 按供应商 / 账号的明细表 → 上限与保存期限。
 * 依赖 app.js 的全局函数（icon、miniLogo）。
 */
(() => {
  const api = window.tokenpulse.concurrency, host = document.getElementById('page-concurrency');
  if (!api || !host) return;
  const metrics = { requests: '活跃 AI 请求', clients: '客户端连接', upstream: '上游连接' };
  const METRIC_NOTE = { requests: '等待上游和正在出字的请求', clients: '工具连到 TokenPulse 的连接', upstream: 'TokenPulse 连到上游的连接' };
  const METRIC_ICON = { requests: 'requests', clients: 'terminal', upstream: 'globe' };
  const APP = { claude: ['Claude Code', 'Claude Code'], desktop: ['Claude 桌面端', 'Claude Code'], codex: ['Codex', 'Codex CLI'], grok: ['Grok CLI', 'Grok Build'] };
  const KIND = { provider: '供应商', account: '账号', unattributed: '未归属', shared: '共享' };
  const t = text => window.PulseI18n?.lang?.() === 'en' ? window.PulseI18n.t(text) : text;
  const scopeLabel = row => row.id.startsWith('provider:pass-') ? row.id.slice(14) + ' · ' + t('官方透明转发') : row.kind === 'unattributed' ? (row.id.includes(':') ? row.id.split(':')[1] + ' · ' : '') + t('未归属') : t(row.label);
  const node = (tag, text, className) => { const element = document.createElement(tag); if (text != null) element.textContent = text; if (className) element.className = className; return element; };
  const field = (title, control) => { const wrap = node('div', null, 'cm-field'); wrap.append(node('span', title, 'cm-field-title'), control); if (control.tagName === 'SELECT') wrap.append(fancy(control, title)); return wrap; };
  /*
   * 下拉框：原生的 select 留着存值（界面上藏起来），旁边放一个和设置页一样的按钮，点开是应用自己的菜单（app.js 的 openOptionMenu）。
   * 选项或值变了调 syncSelects() 把按钮上的字对上。
   */
  const fancies = [];
  function fancy(control, title) {
    control.classList.add('cm-native'); control.tabIndex = -1; control.setAttribute('aria-hidden', 'true');
    const text = node('span', '', 'ui-select-text'), trigger = node('button', null, 'ui-select cm-select');
    trigger.type = 'button'; trigger.dataset.for = control.id; trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
    trigger.append(text, icon('chevron', 'icon ui-select-chevron'));
    const sync = () => { text.textContent = control.selectedOptions[0]?.textContent ?? ''; trigger.setAttribute('aria-label', t(title) + ': ' + text.textContent); };
    trigger.onclick = () => {
      if (trigger.getAttribute('aria-expanded') === 'true') { closeOptionMenu(); return; }
      openOptionMenu(trigger, t(title), [...control.options].map(option => ({ value: option.value, label: option.textContent })), control.value, next => { control.value = next; control.dispatchEvent(new Event('change')); });
    };
    control.addEventListener('change', sync);
    fancies.push(sync); sync();
    return trigger;
  }
  const syncSelects = () => { for (const sync of fancies) sync(); };
  const select = (id, items) => { const control = node('select'); control.id = id; for (const [value, label] of items) { const option = node('option', label); option.value = value; control.append(option); } return control; };
  const button = (text, action, className = 'btn') => { const control = node('button', text, className); control.type = 'button'; control.onclick = action; return control; };
  const heading = (title, note, side) => {
    const head = node('div', null, 'panel-heading cm-heading'), text = node('div');
    text.append(node('h2', title)); if (note) text.append(node('p', note));
    head.append(text); if (side) head.append(side);
    return head;
  };
  /** 用了上限的多少：没设上限是 null。 */
  const ratio = (count, limit) => limit ? count / limit : null;
  const toneOf = value => value == null ? '' : value > 1 ? 'over' : value >= 1 ? 'full' : value >= 0.8 ? 'near' : '';
  let mounted = false, visible = false, unsubscribe = null, generation = 0, state = null, busy = false, lastHistory = 0, historyTimer = 0;
  let scope, metric, days, ruleScope, retention, action, inputs, chart, status, saveStatus, cards, rows, alerts, coverage, settingsPanel;
  function mount() {
    if (mounted) return; mounted = true;
    // 监控范围：哪些工具的请求经过 TokenPulse
    const intro = node('section', null, 'panel cm-panel cm-intro');
    const introText = node('div', null, 'cm-intro-text');
    introText.append(node('b', '监控范围'), node('p', '只统计经 TokenPulse 转发的流量（本地路由、号池、透明转发）；工具直连官方时这里看不到。连接包含空闲的复用连接，活跃请求包含正在等上游的请求。', 'cm-help'));
    coverage = node('div', null, 'cm-coverage'); coverage.setAttribute('role', 'list');
    intro.append(introText, coverage); host.append(intro);
    cards = node('div', null, 'cm-cards'); host.append(cards);
    for (const [key, title] of Object.entries(metrics)) {
      const card = node('div', null, 'panel cm-card'), head = node('div', null, 'cm-card-head'), mark = node('span', null, 'cm-card-icon');
      mark.setAttribute('aria-hidden', 'true'); mark.append(icon(METRIC_ICON[key])); head.append(mark, node('span', title));
      const number = node('strong', '—'); number.dataset.metric = key;
      const meter = node('div', null, 'cm-meter'); meter.dataset.meter = key; meter.append(node('i')); meter.hidden = true;
      const limit = node('small', '未设置上限'); limit.dataset.limit = key;
      card.append(head, number, meter, limit, node('p', METRIC_NOTE[key], 'cm-card-note')); cards.append(card);
    }
    alerts = node('div', null, 'cm-alerts'); alerts.setAttribute('role', 'status'); host.append(alerts);

    const history = node('section', null, 'panel cm-panel');
    const toolbar = node('div', null, 'cm-toolbar');
    scope = select('cm-history-scope', [['global', '全部转发']]);
    metric = select('cm-metric', Object.entries(metrics)); days = select('cm-days', [['1', '24 小时'], ['7', '7 天'], ['30', '30 天'], ['90', '90 天'], ['0', '全部']]);
    toolbar.append(field('查看范围', scope), field('指标', metric), field('时间范围', days));
    for (const control of [scope, metric, days]) control.onchange = () => loadHistory();
    chart = node('div', null, 'cm-chart'); chart.setAttribute('role', 'img'); chart.setAttribute('aria-label', '并发历史');
    status = node('div', '', 'cm-status'); status.setAttribute('aria-live', 'polite');
    history.append(heading('并发历史', '图中显示每个时间段的峰值；空白表示未监控或软件没有运行。', toolbar), chart, status); host.append(history);

    const breakdown = node('section', null, 'panel cm-panel cm-breakdown');
    const scroll = node('div', null, 'table-scroll'), table = node('table', null, 'cm-table'), head = node('thead'), header = node('tr');
    for (const [i, title] of ['查看范围', ...Object.values(metrics), '拒绝次数', '上限设置'].entries()) { const th = node('th', title); if (i > 0) th.className = 'n'; header.append(th); }
    head.append(header); rows = node('tbody'); rows.id = 'cm-rows'; table.append(head, rows); scroll.append(table);
    breakdown.append(heading('供应商与账号', '每一行的数字是「当前 / 上限」。共享或归属不确定的连接不能单独设上限。'), scroll); host.append(breakdown);

    const settings = settingsPanel = node('section', null, 'panel cm-panel cm-settings');
    settings.append(heading('上限与保存期限', '留空表示不设上限。拒绝只作用于新的 AI 请求，不中断已有请求；连接上限仅提醒。共享或未归属连接不支持个别上限。'));
    ruleScope = select('cm-rule-scope', [['global', '全部转发']]);
    retention = select('cm-retention', [['7', '7 天'], ['30', '30 天'], ['90', '90 天'], ['0', '永久保存']]);
    const fields = node('div', null, 'cm-fields'); inputs = {};
    fields.append(field('查看范围', ruleScope));
    for (const [key, title] of Object.entries(metrics)) { const input = node('input'); input.id = 'cm-limit-' + key; input.type = 'number'; input.min = '1'; input.max = '1000000'; input.step = '1'; input.placeholder = t('未设置上限'); inputs[key] = input; fields.append(field(title, input)); }
    action = select('cm-action', [['warn', '仅提醒'], ['reject', '拒绝新 AI 请求']]); fields.append(field('请求超限时', action), field('保存期限', retention)); settings.append(fields);
    ruleScope.onchange = () => fillRule();
    const save = button('保存设置', async () => {
      if (busy || !state) return;
      const settings = structuredClone(state.settings), rule = { action: action.value };
      for (const [key, input] of Object.entries(inputs)) {
        if (input.value.trim()) { const value = Number(input.value); if (!Number.isInteger(value) || value < 1 || value > 1000000) { saveStatus.textContent = t('上限必须是正整数'); input.focus(); return; } if (!input.disabled) rule[key] = value; }
      }
      const original = settings.rules[ruleScope.value];
      for (const [key, input] of Object.entries(inputs)) if (input.disabled && original?.[key]) rule[key] = original[key];
      if (Object.keys(rule).length === 1) delete settings.rules[ruleScope.value]; else settings.rules[ruleScope.value] = rule;
      settings.retention = Number(retention.value); busy = true; save.disabled = true; saveStatus.textContent = t('正在保存…');
      try { draw(await api.save(settings)); fillRule(); saveStatus.textContent = t('设置已保存'); loadHistory(); }
      catch (error) { saveStatus.textContent = error.message; }
      finally { busy = false; save.disabled = false; }
    }, 'btn btn-accent');
    save.id = 'cm-save'; saveStatus = node('div', '', 'cm-status'); saveStatus.setAttribute('role', 'status');
    const foot = node('div', null, 'cm-settings-foot'); foot.append(save, saveStatus);
    settings.append(foot); host.append(settings);
  }
  function updateOptions(control, values) {
    const current = control.value, signature = JSON.stringify(values);
    if (control.dataset.signature === signature) return;
    control.dataset.signature = signature; control.replaceChildren();
    for (const [value, label] of values) { const option = node('option', label); option.value = value; control.append(option); }
    control.value = values.some(([id]) => id === current) ? current : 'global';
  }
  function fillRule() {
    const row = state?.rows.find(row => row.id === ruleScope.value), rule = state?.settings.rules[ruleScope.value];
    for (const [key, input] of Object.entries(inputs)) { input.value = rule?.[key] ?? ''; input.disabled = !row?.supported[key]; }
    action.value = rule?.action || 'warn'; syncSelects();
  }
  /** 明细表里的一格：当前 / 上限，设了上限的下面一条细进度条。 */
  function countCell(row, key) {
    const td = node('td', null, 'n'), limit = row.rule?.[key], value = ratio(row[key], limit), tone = toneOf(value);
    const line = node('span', null, 'cm-count' + (tone ? ' ' + tone : ''));
    line.append(node('b', String(row[key])));
    if (limit) line.append(node('span', ' / ' + limit));
    td.append(line);
    if (limit) { const meter = node('div', null, 'cm-meter small' + (tone ? ' ' + tone : '')), fill = node('i'); fill.style.width = Math.min(100, Math.round(value * 100)) + '%'; meter.append(fill); td.append(meter); }
    return td;
  }
  function draw(next) {
    const first = !state; state = { ...state, ...next };
    const global = state.rows.find(row => row.id === 'global');
    const monitoring = state.coverage?.some(item => item.monitored);
    for (const key of Object.keys(metrics)) {
      const count = global?.[key] ?? 0, limit = global?.rule?.[key], value = monitoring ? ratio(count, limit) : null, tone = toneOf(value);
      const number = cards.querySelector(`[data-metric=${key}]`), meter = cards.querySelector(`[data-meter=${key}]`);
      number.textContent = monitoring ? String(count) : '—';
      number.closest('.cm-card').dataset.tone = tone;
      meter.hidden = !limit; meter.className = 'cm-meter' + (tone ? ' ' + tone : '');
      meter.firstChild.style.width = value == null ? '0%' : Math.min(100, Math.round(value * 100)) + '%';
      cards.querySelector(`[data-limit=${key}]`).textContent = limit ? t('上限') + ': ' + limit : t('未设置上限');
    }
    coverage.replaceChildren(...(state.coverage || []).map(item => {
      const chip = node('span', null, 'cm-chip' + (item.monitored ? ' on' : '')), [name, source] = APP[item.app] || [item.app, item.app];
      chip.setAttribute('role', 'listitem'); chip.dataset.app = item.app;
      const label = node('b', name); label.setAttribute('translate', 'no');
      chip.append(miniLogo(source), label, node('span', t(item.monitored ? '正在监控' : '直连未监控'), 'cm-chip-state'));
      return chip;
    }));
    alerts.replaceChildren(...state.alerts.map(alert => { const item = node('div', null, 'cm-alert'); item.append(icon('alert'), node('span', `${t(alert.label)} · ${t(metrics[alert.metric])}: ${alert.count} / ${alert.limit}${alert.rejected ? ' · ' + t('已拒绝新请求') : ''}`)); return item; }));
    if (state.storageError) { const item = node('div', null, 'cm-alert'); item.append(icon('alert'), node('span', t(state.storageError))); alerts.append(item); }
    updateOptions(scope, state.rows.map(row => [row.id, scopeLabel(row)]));
    updateOptions(ruleScope, state.rows.filter(row => row.supported.requests).map(row => [row.id, scopeLabel(row)]));
    rows.replaceChildren(...state.rows.map(row => {
      const tr = node('tr'); tr.dataset.scope = row.id; if (row.id === 'global') tr.className = 'cm-total';
      const name = node('td'), wrap = node('div', null, 'cm-scope'), label = node('span', scopeLabel(row), 'cm-scope-name');
      label.title = scopeLabel(row);
      const text = node('div', null, 'cm-scope-text'); text.append(label);
      // 归属不确定的（共享、未归属）只在名字下面说一次，不在每一格里重复
      if (Object.keys(metrics).some(key => !row.supported[key])) text.append(node('small', t('归属不确定'), 'cm-uncertain'));
      wrap.append(node('span', t(row.id === 'global' ? '全部' : KIND[row.kind] || row.kind), 'section-tag cm-kind ' + (row.id === 'global' ? 'global' : row.kind)), text); name.append(wrap); tr.append(name);
      for (const key of Object.keys(metrics)) tr.append(countCell(row, key));
      const rejected = node('td', String(row.rejected), 'n' + (row.rejected ? ' cm-rejected' : ' cm-zero')); tr.append(rejected);
      const cell = node('td', null, 'n'), edit = button('设置', () => { ruleScope.value = row.id; fillRule(); settingsPanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); settingsPanel.querySelector('[data-for=cm-rule-scope]').focus({ preventScroll: true }); }); edit.disabled = !row.supported.requests; cell.append(edit); tr.append(cell); return tr;
    }));
    for (const [key, input] of Object.entries(inputs)) input.disabled = !state.rows.find(row => row.id === ruleScope.value)?.supported[key];
    if (first) { retention.value = String(state.settings.retention); fillRule(); }
    syncSelects();
  }
  async function loadHistory() {
    if (!visible) return;
    const request = ++generation; lastHistory = Date.now();
    const query = { scope: scope.value, metric: metric.value, days: Number(days.value) };
    status.textContent = t('正在读取并发历史…'); chart.setAttribute('aria-busy', 'true');
    try {
      const data = await api.history(query); if (!visible || request !== generation) return;
      renderChart(data); status.textContent = data.points.length ? t('每分钟记录峰值，历史仅保存在本机。') : t('还没有并发历史');
    } catch (error) {
      if (!visible || request !== generation) return;
      status.replaceChildren(node('span', t('并发历史读取失败') + ': ' + error.message), button('重试', loadHistory));
    } finally { if (visible && request === generation) chart.setAttribute('aria-busy', 'false'); }
  }
  function renderChart(data) {
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 900 260');
    const make = (tag, attrs) => { const item = document.createElementNS(NS, tag); for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, String(value)); return item; };
    const points = data.points || [], limit = state?.rows.find(row => row.id === data.scope)?.rule?.[data.metric] || 0;
    const peak = points.reduce((max, point) => Math.max(max, point.max), Math.max(1, limit)), tick = Math.max(1, Math.ceil(peak / 4)), axisMax = tick * 4;
    const start = Math.min(data.since || data.at || Date.now(), points[0]?.at || Infinity), end = data.at || Date.now();
    const x = at => 45 + 830 * (at - start) / Math.max(1, end - start), y = value => 220 - 190 * value / axisMax;
    for (let i = 0; i <= 4; i++) {
      svg.append(make('line', { x1: 45, x2: 875, y1: 220 - i * 47.5, y2: 220 - i * 47.5, class: i ? 'cm-axis' : 'cm-axis base' }));
      const label = make('text', { x: 36, y: 224 - i * 47.5, 'text-anchor': 'end' }); label.textContent = String(tick * i); svg.append(label);
    }
    // 设了上限的话画一条虚线，一眼看出离上限多远
    if (limit) {
      svg.append(make('line', { x1: 45, x2: 875, y1: y(limit), y2: y(limit), class: 'cm-limit' }));
      const label = make('text', { x: 875, y: y(limit) - 6, 'text-anchor': 'end', class: 'cm-limit-label' }); label.textContent = t('上限') + ' ' + limit; svg.append(label);
    }
    let segment = [], previous = null;
    const flush = () => {
      if (!segment.length) return;
      const first = segment[0].split(',')[0], last = segment.at(-1).split(',')[0];
      svg.append(make('path', { class: 'cm-area', d: `M${first},220 L${segment.join(' L')} L${last},220 Z` }));
      svg.append(make('polyline', { class: 'cm-line', points: segment.join(' ') })); segment = [];
    };
    for (const point of points) {
      if (previous && (previous.session !== point.session || point.at - previous.until > 65000)) flush();
      segment.push(`${x(point.at)},${y(point.max)}`, `${x(point.until)},${y(point.max)}`); previous = point;
    }
    flush();
    for (const [at, anchor, px] of [[start, 'start', 45], [end, 'end', 875]]) {
      const label = make('text', { x: px, y: 250, 'text-anchor': anchor }); label.textContent = new Date(at).toLocaleString(window.PulseI18n?.lang?.() === 'en' ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); svg.append(label);
    }
    chart.replaceChildren(svg); chart.setAttribute('aria-label', `${t(metrics[metric.value])} · ${t('峰值')}: ${points.reduce((max, point) => Math.max(max, point.max), 0)}`);
  }
  function hide() { visible = false; ++generation; unsubscribe?.(); unsubscribe = null; clearInterval(historyTimer); historyTimer = 0; }
  async function show() {
    mount(); if (visible) return; visible = true;
    unsubscribe = api.onState(next => { if (visible) draw(next); });
    try { const next = await api.state(); if (!visible) return; draw(next); loadHistory(); }
    catch (error) { status.replaceChildren(node('span', error.message), button('重试', () => { hide(); show(); })); }
    historyTimer = setInterval(() => { if (visible && Date.now() - lastHistory > 15000) loadHistory(); }, 15000);
  }
  const open = () => document.querySelector('#nav [data-page=concurrency]').click();
  window.PulseConcurrency = { show, hide, open };
  window.addEventListener('pagehide', hide);
})();
