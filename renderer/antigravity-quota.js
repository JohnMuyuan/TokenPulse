/*
 * Google Antigravity 的额度（主进程见 src/main/antigravity-quota.ts）。
 *
 * 和 ChatGPT / Claude / Grok 一样，在总览「官方额度」里占一张卡片、在额度详情顶上占一个标签。
 * 不同的是 Antigravity 的额度按型号分组（几个型号共用一份，各自重置，目前约 5 小时），没有「5 小时 + 周」两个窗口：
 * 卡片和详情页按组画。额度只能问本机开着的 Antigravity，关着的时候显示最后一次查到的，并写明是什么时候的。
 * 用到 app.js 的公共函数（el / svg / icon / ring / track / avatar / duration / date / percent / tokens / number / markLayout / navigate / state），所以在它后面加载。
 */
(function () {
  const api = window.tokenpulse?.antigravityQuota;
  if (!api) return;
  const KEY = 'antigravity';
  const COLORS = ['var(--antigravity)', 'var(--claude)', '#8b5cf6', '#0ea5a4'];
  /** 超过这么久没查到就当作过期（和官方账号一样 15 分钟）。 */
  const STALE_MS = 15 * 60000;
  let quota = null;

  const demo = () => Boolean(window.tokenpulse?.isDemo?.());
  const visible = () => Boolean(quota?.installed) && !demo();
  const last = () => quota?.last;
  const groups = () => last()?.groups || [];
  const stale = () => !last()?.ok || Date.now() - (last()?.at || 0) > STALE_MS;
  /** 组名：组里的型号（不翻译）。 */
  const groupName = group => el('span', { class: 'agy-group-name', translate: 'no', text: group.models.join(' · ') });
  /** 重置时间已经过了、还没查到新的：不显示旧的百分比。 */
  const ended = group => group.resetAt && Date.parse(group.resetAt) <= Date.now();
  const resetText = group => ended(group) ? '已经重置，等待下一次查询' : group.resetAt ? `${duration(Date.parse(group.resetAt) - Date.now())}后重置 · ${date(Date.parse(group.resetAt))}` : '没有重置时间';
  const levelOf = group => ended(group) ? '' : group.used >= 100 ? 'critical' : group.used >= 90 ? 'critical' : group.used >= 75 ? 'warning' : 'good';
  const planText = () => [last()?.tier, last()?.plan && last()?.plan !== last()?.tier ? last()?.plan : ''].filter(Boolean).join(' · ');
  const updatedText = () => {
    const at = last()?.at;
    if (quota?.loading) return '正在查询…';
    if (!at) return '还没查询过';
    return `${date(at)} ${last()?.ok ? '更新' : '查询失败'}`;
  };
  /** 关着、查询失败、过期：说清楚现在看到的是什么。 */
  function notes() {
    const out = [];
    if (!quota?.running) out.push(last()?.at ? 'Antigravity 现在没有开着，下面是最后一次查到的额度。打开 Antigravity 后会自动更新。' : '打开 Antigravity 后才能查到额度：额度只能问本机开着的 Antigravity。');
    else if (last() && !last().ok) out.push([last().error || '查询失败', '下面是之前查到的额度。']);
    else if (last()?.ok && stale()) out.push('超过 15 分钟没有查到新的额度，数字可能已经变了。');
    return out;
  }
  const refresh = async () => {
    try { apply(await api.refresh()); } catch (error) { toast(error?.message || '查询失败', { kind: 'error' }); }
  };
  const refreshButton = (cls = 'btn') => {
    const b = el('button', { type: 'button', class: cls + (quota?.loading ? ' is-busy' : ''), 'data-action': 'agy-refresh', disabled: quota?.loading ? '' : null }, [icon('refresh'), el('span', { text: '刷新' })]);
    b.addEventListener('click', refresh);
    return b;
  };

  /* ---------------- 按这一窗口的采样估速度 ---------------- */

  /** 这一组在当前窗口（同一个重置时间）里的采样：算每小时用掉几个百分点，预测重置时用到多少。 */
  function forecast(group) {
    if (!group.resetAt || ended(group)) return null;
    const reset = Date.parse(group.resetAt);
    const points = (quota?.history || []).flatMap(sample => sample.groups.filter(item => item.key === group.key && item.resetAt && Math.abs(Date.parse(item.resetAt) - reset) < 10 * 60000).map(item => ({ at: sample.at, used: item.used })));
    if (points.length < 2) return null;
    const first = points[0], end = points[points.length - 1];
    const hours = (end.at - first.at) / 3600000;
    if (hours < 1 / 6) return null;
    const ratePerH = Math.max(0, (end.used - first.used) / hours);
    const left = (reset - Date.now()) / 3600000;
    const projected = Math.min(200, group.used + ratePerH * Math.max(0, left));
    const etaAt = ratePerH > 0 ? Date.now() + (100 - group.used) / ratePerH * 3600000 : null;
    return { ratePerH, projected, etaAt: etaAt && etaAt < reset ? etaAt : null };
  }
  function forecastText(group) {
    if (ended(group)) return '已经重置，等待下一次查询';
    if (group.used >= 100) return '这一组已经用完，等待重置';
    const f = forecast(group);
    if (!f) return '采样还不够，暂不估计';
    if (f.etaAt) return `按最近的速度，约 ${duration(f.etaAt - Date.now())}后用完`;
    if (f.ratePerH === 0) return '这个窗口里还没有新增用量';
    return `按最近的速度，重置时大约用到 ${percent(Math.min(100, f.projected))}`;
  }

  /* ---------------- 本机用量（扫描到的 Antigravity 会话） ---------------- */

  function localUsage() {
    if (typeof current === 'undefined' || !current?.usage) return null;
    const today = D.dayKey(current.now), week = D.shift(today, -6);
    const rows = current.usage.filter(row => row.source === 'Antigravity');
    const sum = list => list.reduce((out, row) => ({ tokens: out.tokens + (row.tokens || 0), requests: out.requests + (row.requests || 0), costUsd: out.costUsd + (row.costUsd || 0) }), { tokens: 0, requests: 0, costUsd: 0 });
    const recent = rows.filter(row => row.day >= week);
    const byModel = new Map();
    for (const row of recent) {
      const item = byModel.get(row.model) || { model: row.model, tokens: 0, requests: 0 };
      item.tokens += row.tokens || 0; item.requests += row.requests || 0;
      byModel.set(row.model, item);
    }
    return { today: sum(rows.filter(row => row.day === today)), week: sum(recent), models: [...byModel.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 6), any: rows.length > 0 };
  }

  /* ---------------- 额度详情顶上的标签 ---------------- */

  function tabs() {
    if (!visible()) return [];
    return [{ key: KEY, kind: KEY, who: planText(), title: planText() || 'Google Antigravity' }];
  }
  function tabButton(tab) {
    return el('button', { type: 'button', 'data-account': KEY, 'data-kind': KEY, 'data-antigravity': '', title: tab.title }, [
      el('span', { class: 'brand-glyph' }, [brandSvg('antigravity')]), 'Antigravity',
      tab.who ? el('small', { class: 'tab-who', text: tab.who, translate: 'no' }) : null,
    ]);
  }
  const owns = key => key === KEY && visible();

  /* ---------------- 额度详情 ---------------- */

  function groupPanel(group, index) {
    const panel = el('article', { class: 'panel window-panel agy-group', 'data-group': group.key, style: `--agy-color: ${COLORS[index % COLORS.length]}` }, [
      el('div', { class: 'panel-heading' }, [el('h2', {}, [el('i', { class: 'agy-dot', 'aria-hidden': 'true' }), groupName(group)]), el('span', { class: 'section-tag', text: '共用一份额度' })]),
    ]);
    const done = ended(group);
    panel.append(el('div', { class: 'window-number' }, [el('strong', { text: done ? '—' : percent(Math.max(0, 100 - group.used)) }), el('span', { text: stale() ? '上次查到的剩余' : '剩余额度' })]));
    const bar = done ? el('div', { class: 'track' }) : track(group.used, group.used >= 75); bar.classList.add('window-track'); panel.append(bar);
    panel.append(el('div', { class: 'window-meta' }, [el('span', { text: done ? '等待查询确认' : `已用 ${percent(group.used)}` }), el('span', { text: resetText(group) })]));
    const f = forecast(group);
    const caution = Boolean(f?.etaAt) || stale();
    panel.append(el('div', { class: 'prediction-line' + (caution ? ' caution' : '') }, [icon(caution ? 'alert' : 'trend'), stale() ? '数据不是最新的，打开 Antigravity 后再判断' : forecastText(group)]));
    panel.append(metricGroup('速度与时间', 'clock', [
      metric('最近速度', f && !stale() ? f.ratePerH.toFixed(2) : '—', { unit: f && !stale() ? '点 / 时' : '', sub: '这个窗口里的采样' }),
      metric('重置时预计使用', f && !stale() ? percent(Math.min(100, f.projected)) : '—', { sub: f ? '按最近的速度' : '采样还不够' }),
      metric('重置时间', group.resetAt ? date(Date.parse(group.resetAt)) : '未知', { sub: group.resetAt && !done ? `${duration(Date.parse(group.resetAt) - Date.now())}后` : '' }),
      metric('这一组的型号', String(group.models.length), { sub: '用哪一个都扣这一份' }),
    ], 'two'));
    return panel;
  }

  /** 最近 7 天每组的已用百分比。 */
  function historyPanel() {
    const panel = el('article', { class: 'panel agy-history' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '最近 7 天的额度' }), el('span', { class: 'section-tag', text: '已用百分比' })])]);
    const list = groups();
    const samples = quota?.history || [];
    if (samples.length < 2) { panel.append(empty('采样还不够。Antigravity 开着的时候每次查询都会记一条，过一阵就能看到走势。')); return panel; }
    const now = Date.now(), from = now - 7 * 86400000;
    const W = 700, H = 180, pad = { l: 34, r: 8, t: 8, b: 22 };
    const x = at => pad.l + (at - from) / (now - from) * (W - pad.l - pad.r);
    const y = used => pad.t + (1 - Math.min(100, Math.max(0, used)) / 100) * (H - pad.t - pad.b);
    const chart = svg('svg', { class: 'agy-chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '最近 7 天各组额度的已用百分比' });
    for (const v of [0, 50, 100]) {
      chart.append(svg('line', { class: 'agy-grid', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
      const label = svg('text', { class: 'agy-axis', x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end' }); label.textContent = v + '%'; chart.append(label);
    }
    for (let d = 0; d <= 7; d += 1) {
      const at = from + d * 86400000;
      const label = svg('text', { class: 'agy-axis', x: x(at), y: H - 6, 'text-anchor': d === 0 ? 'start' : d === 7 ? 'end' : 'middle' });
      label.textContent = new Date(at).toLocaleDateString(dateLocale(), { month: 'numeric', day: 'numeric' }); chart.append(label);
    }
    list.forEach((group, index) => {
      const points = samples.flatMap(sample => sample.groups.filter(item => item.key === group.key).map(item => [x(sample.at), y(item.used)]));
      if (!points.length) return;
      chart.append(svg('polyline', { class: 'agy-line', points: points.map(p => p.join(',')).join(' '), style: `stroke: ${COLORS[index % COLORS.length]}` }));
    });
    panel.append(chart);
    panel.append(el('div', { class: 'agy-legend' }, list.map((group, index) => el('span', { class: 'agy-legend-item', style: `--agy-color: ${COLORS[index % COLORS.length]}` }, [el('i', { class: 'agy-dot', 'aria-hidden': 'true' }), groupName(group)]))));
    return panel;
  }

  function usagePanel() {
    const local = localUsage();
    const panel = el('article', { class: 'panel agy-local' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '本机用量' }), el('span', { class: 'section-tag', text: 'Antigravity 的对话记录' })])]);
    if (!local?.any) { panel.append(empty('还没有扫到 Antigravity 的对话。用 Antigravity 聊几句，下一次扫描之后这里就有数了。')); return panel; }
    panel.append(el('div', { class: 'agy-local-figures' }, [
      metric('今天', tokens(local.today.tokens), { unit: 'Tokens', sub: `${number(local.today.requests)} 次请求` }),
      metric('最近 7 天', tokens(local.week.tokens), { unit: 'Tokens', sub: `${number(local.week.requests)} 次请求` }),
    ]));
    if (local.models.length) panel.append(el('div', { class: 'agy-models' }, local.models.map(row => el('div', { class: 'agy-model-row' }, [el('span', { class: 'agy-model', translate: 'no', text: row.model }), el('span', { class: 'num', text: `${tokens(row.tokens)} Tokens · ${number(row.requests)} 次` })]))));
    const go = el('button', { type: 'button', class: 'text-btn', 'data-action': 'agy-usage' }, [el('span', { text: '在用量明细里看每一次请求' }), icon('arrow')]);
    go.addEventListener('click', () => {
      // 和手动在「工具」里选一样：下拉框也要跟着变
      const select = document.getElementById('source-filter');
      if (select && [...select.options].some(option => option.value === 'Antigravity')) select.value = 'Antigravity';
      state.source = 'Antigravity'; state.tablePage = 0; state.reqPage = 0;
      navigate('usage');
    });
    panel.append(el('div', { class: 'agy-local-foot' }, [go]));
    return panel;
  }

  function renderQuota(host) {
    host.append(el('div', { class: 'quota-context agy-context' }, [
      avatar('antigravity'),
      el('div', {}, [
        el('h2', {}, ['Google Antigravity', planText() ? el('span', { class: 'context-who', text: planText(), translate: 'no' }) : null]),
        el('p', { class: 'muted', text: '额度按型号分组：一组里的型号共用一份，各自重置。只能问本机开着的 Antigravity。' }),
      ]),
      el('div', { class: 'context-meta agy-context-meta' }, [el('span', { text: updatedText() }), refreshButton()]),
    ]));
    // 一条说明可以是几句：分开放，翻译按句对得上
    for (const note of notes()) host.append(el('p', { class: 'stale-note agy-note' }, [icon('alert'), ...[].concat(note).map(text => el('span', { text: text + ' ' }))]));
    const list = groups();
    if (!list.length) {
      host.append(el('article', { class: 'panel empty large' }, [el('h3', { text: quota?.loading ? '正在查询额度…' : '还没有查到额度' }), el('p', { text: '打开 Antigravity，等它登录好之后点「刷新」。' })]));
    } else {
      host.append(markLayout(el('div', { class: 'quota-window-grid agy-groups' }, list.map((group, index) => groupPanel(group, index))), 'quota:agy-groups'));
      host.append(markLayout(historyPanel(), 'quota:agy-history'));
    }
    host.append(markLayout(usagePanel(), 'quota:agy-local'));
    return KEY;
  }

  /* ---------------- 总览里的卡片 ---------------- */

  function card() {
    const list = groups();
    const live = list.filter(group => !ended(group));
    const worst = live.slice().sort((a, b) => b.used - a.used)[0];
    const level = !last() ? '' : stale() ? '' : worst ? levelOf(worst) : '';
    const badge = !last()?.at ? [quota?.loading ? '正在查询…' : quota?.running ? '还没查询过' : '没有开着', '']
      : !quota?.running ? ['没有开着', ''] : !last().ok ? ['查询失败', 'critical'] : stale() ? ['采样已过期', '']
      : worst?.used >= 100 ? ['有一组用完了', 'critical'] : worst?.used >= 90 ? ['快用完了', 'critical'] : worst?.used >= 75 ? ['用量偏高', 'warning'] : ['节奏正常', 'good'];
    const body = [el('div', { class: 'account-head' }, [
      avatar('antigravity'),
      el('div', { class: 'account-title' }, [el('span', { class: 'account-name', text: 'Antigravity' }), el('span', { class: 'plan who', translate: 'no', text: planText() || 'Google' })]),
      el('span', { class: 'badge ' + badge[1], text: badge[0] }),
    ])];
    const ringNode = ring({ five: live[0] ? { used: live[0].used } : null, week: live[1] ? { used: live[1].used } : null });
    ringNode.title = live.length > 1 ? `外环：${live[0].models.join(' · ')}　内环：${live[1].models.join(' · ')}` : '';
    const left = live.length ? Math.min(...live.map(group => Math.max(0, 100 - group.used))) : null;
    ringNode.append(el('div', { class: 'ring-center' }, [el('div', { class: 'quota-remaining' + (left == null ? ' empty-number' : ''), text: left == null ? '—' : left.toFixed(1) }, left == null ? [] : [el('small', { text: '%' })])]));
    body.push(el('div', { class: 'quota-hero' }, [ringNode, el('div', { class: 'quota-hero-text' }, [
      el('span', { class: 'quota-hero-label', text: `${stale() ? '上次' : ''}${live.length > 1 ? '较低一组' : '额度'}剩余` }),
      el('span', { class: 'quota-hero-value', text: worst?.resetAt ? `${duration(Date.parse(worst.resetAt) - Date.now())}后重置` : list.length ? '重置时间未知' : '尚未取得额度' }),
      el('span', { class: 'quota-hero-sub', text: worst?.resetAt ? `${date(Date.parse(worst.resetAt))} · 本地时间` : '额度只能问本机开着的 Antigravity' }),
    ])]));
    list.forEach((group, index) => {
      const done = ended(group);
      body.push(el('div', { class: 'quota-mini agy-mini', 'data-group': group.key, style: `--agy-color: ${COLORS[index % COLORS.length]}` }, [
        el('div', { class: 'quota-mini-head' }, [el('span', { class: 'mini-label' }, [el('i', { class: 'agy-dot', 'aria-hidden': 'true' }), groupName(group)]), el('span', { class: 'mini-used' }, [el('span', { class: 'num', text: done ? '等待确认' : `已用 ${percent(group.used)}` })])]),
        done ? el('div', { class: 'track' }) : track(group.used, group.used >= 75),
        el('div', { class: 'mini-reset' }, [icon('clock'), resetText(group)]),
      ]));
    });
    if (!list.length) body.push(el('div', { class: 'quota-missing' }, [el('p', { text: [].concat(notes()[0] || '打开 Antigravity 后会自动查询。')[0] })]));
    const link = el('button', { type: 'button', class: 'text-btn', 'data-go': 'quota', 'aria-label': 'Antigravity 额度详情' }, ['详情', icon('arrow')]);
    link.hidden = typeof navHidden === 'function' && navHidden('quota');
    link.addEventListener('click', () => { state.account = KEY; navigate('quota'); });
    body.push(el('div', { class: 'quota-card-foot' }, [el('span', { text: updatedText() }), el('span', { class: 'agy-card-actions' }, [refreshButton('text-btn'), link])]));
    return el('article', { class: 'quota-card antigravity ' + level, 'data-antigravity': '' }, body);
  }
  const marked = () => { const node = card(); return window.markLayout ? window.markLayout(node, 'overview:quota:antigravity') : node; };
  function cards() { return visible() ? [marked()] : []; }
  /** 刚查到：只换总览里这一张卡片。 */
  function renderCard() {
    const host = document.getElementById('quota-cards');
    if (!host || !quota) return;
    const old = host.querySelector('[data-layout="overview:quota:antigravity"]') || host.querySelector('[data-antigravity]');
    if (!visible()) { old?.remove(); return; }
    const next = marked();
    next.style.setProperty('--i', String(old ? [...host.children].indexOf(old) : host.children.length));
    if (old) old.replaceWith(next); else if (host.children.length) host.append(next);
  }
  function render() {
    renderCard();
    if (typeof current !== 'undefined' && current && !document.getElementById('page-quota').hidden) keepScroll(() => window.renderQuota());
  }
  function apply(next) { if (!next || typeof next !== 'object') return; quota = next; render(); }

  window.AntigravityQuota = { render, cards, tabs, tabButton, owns, renderQuota, state: () => quota };
  api.onState(apply);
  api.state().then(apply).catch(() => {});
})();
