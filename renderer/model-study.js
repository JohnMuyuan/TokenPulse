'use strict';
/*
 * 模型 × 思考等级（0.3.8）。
 *
 * - 额度详情 · 「换一种模型，整窗能用多少」：五小时和周两个窗口一起算，全部可用的模型和等级一次列出，
 *   排行可换排序、按等级筛选。换算口径见 src/core/model-study.ts（整窗 API 等价预算 ÷ 组合单价）。
 * - 用量明细 · 「模型与思考等级时间线」：当前五小时周期和本周周期两条时间线，每个组合一条轨道，
 *   连续使用的时间段连成一段；上方叠加官方额度已用百分比。可切账号、翻到上一个周期。
 *
 * 数据：api.modelStudy({ kind, accountId, cycles }) 在 worker 里一次算出两个窗口。
 * 定时重绘（每 30 秒 / 每次快照）只在数据变了时重画，而且不重播动画；切账号、切周期、换排序才播。
 * 依赖 app.js 的全局函数：el、svg、brandSvg、tokens、money、number、qty、miniLogo、tipAt、syncSeg、playChart、
 * empty、date、META、reducedMotion、$。页面 CSP 不允许 style 属性，宽度 / 颜色一律走 CSSOM。
 */
(() => {
  const api = window.tokenpulse;
  const LEVEL = { none: '无推理', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '极限', adaptive: '自适应', auto: '自动', enabled: '已开启', disabled: '已关闭', not_supported: '无等级', unknown: '未记录' };
  const ORDER = Object.keys(LEVEL);
  /** 等级越高颜色越实：时间线上同一模型的不同等级用同一个色相、不同深浅。 */
  const STRENGTH = { none: .4, minimal: .45, low: .55, medium: .72, high: .88, xhigh: 1, max: 1, ultra: 1 };
  const HUES = ['#4f7fd9', '#d9774f', '#10a37f', '#8b5cf6', '#c9832f', '#e05a8a', '#0ea5a4', '#65a30d', '#7c8796'];
  const WINDOWS = [['five', '5 小时'], ['week', '周']];
  const SORTS = [['capacity', '参考量'], ['calls', '请求次数'], ['recent', '常用'], ['name', '名称']];
  const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const HOUR = 3600000, DAY = 86400000;

  const paint = (node, props) => { for (const [k, v] of Object.entries(props)) k.startsWith('--') ? node.style.setProperty(k, v) : (node.style[k] = v); return node; };
  const levelRank = effort => { const i = ORDER.indexOf(effort); return i < 0 ? ORDER.length : i; };
  const levelName = effort => effort === 'unknown' ? '未记录等级' : effort === 'not_supported' ? '无等级参数' : effort;
  const hideTip = () => { $('tip').hidden = true; };
  const hm = at => new Date(at).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', hour12: false });
  function levelBadge(effort) {
    const strength = STRENGTH[effort];
    return el('span', { class: 'ms-level' + (strength ? '' : ' plain'), title: LEVEL[effort] || effort, translate: LEVEL[effort] && strength ? 'no' : null, text: levelName(effort) });
  }
  function tipOn(node, text) {
    node.addEventListener('pointermove', e => tipAt(text, e.clientX, e.clientY));
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', () => { const b = node.getBoundingClientRect(); tipAt(text, b.x + Math.min(b.width, 260) / 2, b.y + b.height); });
    node.addEventListener('blur', hideTip);
    return node;
  }
  function segment(options, value, onPick) {
    const group = el('div', { class: 'seg compact', role: 'group' }, [el('span', { class: 'seg-thumb', 'aria-hidden': 'true' }),
      ...options.map(([id, label]) => el('button', { type: 'button', 'data-value': id, class: value === id ? 'on' : null, 'aria-pressed': String(value === id), text: label }))]);
    group.addEventListener('click', e => { const b = e.target.closest('button[data-value]'); if (b && b.dataset.value !== value) onPick(b.dataset.value); });
    return group;
  }

  /*
   * 请求：同一账号 + 周期 + 数据时间戳只算一次。identity（账号 + 周期）变了，旧结果立刻作废，
   * 迟到的旧请求不许覆盖；identity 没变只是数据更新时，新结果回来之前继续显示上一份，免得页面跳。
   */
  const cache = new Map();
  function fetchStudy(query, stamp) {
    const key = JSON.stringify(query) + '|' + stamp;
    if (!cache.has(key)) {
      const pending = api.modelStudy(query);
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
      while (cache.size > 12) cache.delete(cache.keys().next().value);
    }
    return cache.get(key);
  }
  function loader(host, draw) {
    const view = { seq: 0, key: '', identity: '', data: null, failed: false };
    return {
      view,
      load(identity, query, stamp) {
        const key = identity + '|' + stamp;
        if (key === view.key) return;
        const fresh = identity !== view.identity || view.failed;
        view.key = key; view.identity = identity; view.failed = false;
        if (fresh) view.data = null;
        const seq = ++view.seq;
        host.setAttribute('aria-busy', 'true');
        if (fresh) draw('loading');
        fetchStudy(query, stamp).then(data => {
          if (seq !== view.seq) return;
          view.data = data; host.removeAttribute('aria-busy'); draw(fresh ? 'enter' : 'update');
        }).catch(() => {
          if (seq !== view.seq) return;
          view.data = null; view.failed = true; host.removeAttribute('aria-busy'); draw('error');
        });
      },
      reset() { view.seq++; view.key = ''; view.identity = ''; view.data = null; view.failed = false; host.removeAttribute('aria-busy'); },
    };
  }
  const stampOf = (snapshot, report) => `${snapshot?.scannedAt ?? ''}|${report?.lastSampleAt ?? ''}|${report?.lastCheckedAt ?? ''}|${Math.floor(Date.now() / 30000)}`;
  function skeleton(rows) { return el('div', { class: 'ms-skeleton', 'aria-hidden': 'true' }, Array.from({ length: rows }, () => el('i'))); }
  function failure(message) {
    return el('div', { class: 'ms-error', role: 'alert' }, [el('span', { text: message }), el('button', { type: 'button', class: 'btn', 'data-action': 'retry-study', text: '重试' })]);
  }

  /* ================= 额度详情：换一种模型，整窗能用多少 ================= */

  const Q = { host: null, loader: null, report: null, snapshot: null, sort: 'capacity', level: 'all', animate: false };

  function quotaUpdate(snapshot, report) {
    Q.host ??= $('quota-model-study');
    if (!Q.host) return;
    Q.loader ??= loader(Q.host, mode => drawQuota(mode));
    if (Q.report?.accountId !== report?.accountId) { Q.scopeConfirmed = false; Q.calibrationMinutes = 60; Q.calibrationOpen = false; Q.calibrationMessage = ""; }
    Q.snapshot = snapshot; Q.report = report;
    if (!report?.accountId) { Q.loader.reset(); drawQuota('none'); return; }
    Q.loader.load(report.accountId, { kind: report.kind, accountId: report.accountId }, stampOf(snapshot, report));
  }

  function quotaHeading() {
    const kind = Q.report?.kind;
    return el('div', { class: 'panel-heading ms-head' }, [
      el('div', { class: 'ms-title' }, [
        kind ? avatar(kind, 'ms-brand') : null,
        el('div', {}, [
        el('h2', {}, ['换一种模型，整窗能用多少', el('span', { class: 'section-tag', text: '按最近 30 天换算' })]),
        el('p', { text: '如果整个 5 小时 / 周周期只用一种模型和思考等级，大约能用多少 Tokens、等价多少 API 费用。全部可用的模型和等级一次列出。' })
      ])]),
      segment(SORTS, Q.sort, value => { Q.sort = value; drawQuota('resort'); })
    ]);
  }

  function drawQuota(mode) {
    const host = Q.host, data = Q.loader.view.data;
    if (mode === 'none') { host.replaceChildren(quotaHeading(), empty('这个账号还没有带账号标识的官方额度采样，暂时没法换算。')); syncSegs(host); return; }
    if (mode === 'loading') { host.replaceChildren(quotaHeading(), skeleton(6)); syncSegs(host); return; }
    if (mode === 'error' || !data) {
      host.replaceChildren(quotaHeading(), failure('模型换算读取失败，没有显示旧数据。'));
      host.querySelector('[data-action=retry-study]').addEventListener('click', () => { Q.loader.reset(); quotaUpdate(Q.snapshot, Q.report); });
      syncSegs(host); return;
    }
    const before = mode === 'resort' ? positions(host) : null;
    const rows = combine(data);
    const levels = [...new Set(rows.map(r => r.effort))].sort((a, b) => levelRank(a) - levelRank(b));
    if (Q.level !== 'all' && !levels.includes(Q.level)) Q.level = 'all';
    const shown = sortRows(merge(rows.filter(r => Q.level === 'all' || r.effort === Q.level)));
    const list = el('div', { class: 'ms-rank', role: 'list' });
    const max = { five: Math.max(0, ...shown.map(r => r.five.capacityTokens || 0)), week: Math.max(0, ...shown.map(r => r.week.capacityTokens || 0)), relative: Math.max(0, ...shown.map(r => r.five.relative || 0)) };
    shown.forEach((row, i) => list.append(rankRow(row, i, max, data)));
    if (!shown.length) list.append(empty('没有符合条件的模型组合。'));
    const unknown = data.five.capacities.find(c => c.effort === 'unknown');
    const noBudget = !data.five.budget.costUsd && !data.week.budget.costUsd;
    const merged = shown.reduce((n, r) => n + r.efforts.length, 0);
    host.replaceChildren(...[
      quotaHeading(),
      calibrationPanel(data),
      el('div', { class: 'ms-budgets' }, WINDOWS.map(([w, label]) => budgetTile(w, label, data[w]))),
      highlights(merge(rows), data),
      noBudget ? el('p', { class: 'ms-note', text: '未取得可用的本机专用校准样本，暂停绝对 Token / 美元容量推算。下面的倍数仅比较 API 参考单价，不是官方额度倍数。' }) : null,
      el('div', { class: 'ms-toolbar' }, [
        el('div', { class: 'ms-chips', role: 'group', 'aria-label': '按思考等级筛选' }, [['all', '全部等级'], ...levels.map(l => [l, levelName(l)])].map(([id, label]) =>
          el('button', { type: 'button', class: 'ms-chip' + (Q.level === id ? ' on' : ''), 'data-level': id, 'aria-pressed': String(Q.level === id), translate: id === 'all' ? null : 'no' }, [label, el('small', { text: String(id === 'all' ? rows.length : rows.filter(r => r.effort === id).length) })]))),
        el('div', { class: 'ms-legend' }, [el('span', {}, [el('i', { class: 'ms-key full' }), noBudget ? 'API 价格参考' : '校准条件下整窗']), el('span', {}, [el('i', { class: 'ms-key left' }), '按官方剩余比例估算'])])
      ]),
      el('div', { class: 'ms-rank-head', 'aria-hidden': 'true' }, [el('span'), el('span', { text: '模型 · 思考等级' }), el('span', { text: '5 小时整窗' }), el('span', { text: '周整窗' })]),
      list,
      el('p', { class: 'ms-note' }, [`共 ${number(merged)} 个组合，全部列出${merged > shown.length ? `；同一模型里换算结果相同的等级合成一行（缺少等级专属数据时共享价格参考，不代表官方扣额相同）` : ''}。`, unknown?.recentCalls ? `另有 ${number(unknown.recentCalls)} 次调用没记录思考等级，不参与换算。` : '']),
      methodNote()
    ].filter(Boolean));
    host.querySelector('.ms-chips').addEventListener('click', e => { const b = e.target.closest('[data-level]'); if (b && b.dataset.level !== Q.level) { Q.level = b.dataset.level; drawQuota('resort'); } });
    syncSegs(host);
    if (mode === 'enter') playChart(list, true);
    if (before) flip(host, before);
  }

  /** 五小时、周两份排行按组合对齐成一行。未记录等级的没法「全用这一档」，不进排行。 */
  function combine(data) {
    const week = new Map(data.week.capacities.map(c => [c.key, c]));
    return data.five.capacities.filter(c => c.effort !== 'unknown' && week.has(c.key)).map(c => ({ key: c.key, model: c.model, effort: c.effort, origins: c.origins, semantics: c.semantics, five: c, week: week.get(c.key) }));
  }
  /**
   * 同一模型、没有自己用量数据的几个等级，换算出来一模一样（单价来自同模型或价格表）：合成一行，
   * 等级徽章并排列出。有自己数据（实测或单次调用大小）的等级单独一行。
   */
  function merge(rows) {
    const groups = new Map();
    for (const r of rows) {
      const own = r.five.tokensPerCall || r.five.capacityBasis === 'measured' || r.week.capacityBasis === 'measured';
      const sig = own ? r.key : ['same', r.model, Math.round(r.five.capacityTokens ?? -1), Math.round(r.week.capacityTokens ?? -1), (r.five.relative ?? -1).toFixed(4), r.five.priceBasis].join('|');
      const group = groups.get(sig);
      if (group) group.efforts.push(r.effort); else groups.set(sig, { ...r, key: sig, efforts: [r.effort] });
    }
    return [...groups.values()].map(g => ({ ...g, efforts: g.efforts.sort((a, b) => levelRank(a) - levelRank(b)), effort: g.efforts[0] }));
  }
  function sortRows(rows) {
    const cap = r => r.week.capacityTokens ?? r.five.capacityTokens ?? r.five.relative;
    const metric = { capacity: cap, calls: r => r.week.callsPerWindow ?? r.five.callsPerWindow, recent: r => r.five.recentTokens || null }[Q.sort];
    const byName = (a, b) => a.model.localeCompare(b.model) || levelRank(a.effort) - levelRank(b.effort);
    if (Q.sort === 'name') return rows.sort(byName);
    return rows.sort((a, b) => { const x = metric(a), y = metric(b); return x == null ? (y == null ? byName(a, b) : 1) : y == null ? -1 : y - x || byName(a, b); });
  }


  function attributionNote(study) {
    const a = study.attribution;
    if (!a) return null;
    const text = '官方百分比是账号总池，本机 Token 只覆盖已记录的 Code 用量。';
    const detail = a.unmatchedPoints > 0 || a.uncertainPoints > 0
      ? '已观测的额度增长中：' + a.unmatchedPoints.toFixed(2) + ' 个百分点未匹配本机日志，' + a.uncertainPoints.toFixed(2) + ' 个百分点无法归因。可能是聊天、其他设备或统计延迟，不是精确聊天消耗。'
      : '即使同一时段有 Code 请求，也无法自动排除同时聊天或其他设备消耗。';
    return el('div', { class: 'ms-attribution-note', role: 'note' }, [el('b', { text }), el('p', { text: detail })]);
  }
  function calibrationPanel(data) {
    const status = data.calibration || { sessions: [], active: null }, active = status.active;
    const blocked = new Set([...(data.five.attribution?.blockedSessionIds || []), ...(data.week.attribution?.blockedSessionIds || [])]);
    const panel = el('details', { class: 'ms-calibration', open: Q.calibrationOpen ? '' : null });
    panel.addEventListener('toggle', () => { Q.calibrationOpen = panel.open; });
    panel.append(el('summary', { text: active ? '本机校准进行中 · ' + date(active.endAt) + ' 自动结束' : '共享额度保护 · 可选：短时本机 Code 校准' }));
    panel.append(el('p', { text: '默认不把聊天等全端消耗分摊给 Code。若需要绝对容量参考，可确认所选时长内仅使用此账号的本机 Code；前 10 分钟缓冲，之后按正常工作采样，不额外发模型请求。' }));
    panel.append(el('p', { class: 'ms-note', text: '软件无法检测所有同时发生的聊天。期间用了聊天或其他设备，请作废本段；不要确认过去 30 天的混用历史。校准结果也只是当时使用结构的参考。' }));
    const actions = el('div', { class: 'ms-calibration-actions' });
    const notice = el('p', { class: 'ms-note', role: 'status', text: Q.calibrationMessage || '' });
    async function change(action, sessionId, confirmedLocalOnly) {
      if (Q.calibrationBusy) return;
      const accountId = data.accountId;
      Q.calibrationBusy = true;
      panel.querySelectorAll('button,input,select').forEach(n => { n.disabled = true; });
      try {
        await api.modelCalibration({ kind: data.kind, accountId, action, sessionId, confirmedLocalOnly, durationMinutes: Q.calibrationMinutes || 60 });
        cache.clear();
        if (Q.report?.accountId === accountId) { Q.scopeConfirmed = false; Q.calibrationMessage = '校准记录已更新。'; Q.loader.reset(); quotaUpdate(Q.snapshot, Q.report); }
        T.loader?.reset();
      } catch (error) { notice.textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''); notice.setAttribute('role', 'alert'); }
      finally {
        Q.calibrationBusy = false;
        panel.querySelectorAll('button,input').forEach(n => { n.disabled = false; });
        const start = panel.querySelector('[data-calibration-action=start]'), check = panel.querySelector('[data-calibration-confirm]');
        if (start) start.disabled = !check?.checked;
      }
    }
    if (active) {
      actions.append(el('span', { class: 'ms-badge warn', text: blocked.has(active.id) ? '本段有未匹配增长，暂不用于校准' : '用户确认时段 · 等待足够采样' }));
      const finish = el('button', { type: 'button', class: 'btn', 'data-calibration-action': 'finish', text: '结束本段' }); finish.addEventListener('click', () => change('finish', active.id)); actions.append(finish);
    } else {
      const check = el('input', { type: 'checkbox', 'data-calibration-confirm': '' }); check.checked = Boolean(Q.scopeConfirmed);
      const start = el('button', { type: 'button', class: 'btn', 'data-calibration-action': 'start', text: '开始 ' + (Q.calibrationMinutes || 60) + ' 分钟校准', disabled: Q.scopeConfirmed ? null : '' });
      const duration = el('select', { 'aria-label': '校准时长', 'data-calibration-duration': '' }, [60,120,240].map(n => el('option', { value: String(n), text: (n / 60) + ' 小时' })));
      duration.value = String(Q.calibrationMinutes || 60);
      duration.addEventListener('change', () => { Q.calibrationMinutes = Number(duration.value); Q.scopeConfirmed = false; check.checked = false; start.disabled = true; start.textContent = '开始 ' + duration.value + ' 分钟校准'; });
      actions.append(duration);
      check.addEventListener('change', () => { Q.scopeConfirmed = check.checked; start.disabled = !check.checked; });
      start.addEventListener('click', () => change('start', undefined, check.checked));
      actions.append(el('label', {}, [check, '我确认本段只使用所选账号的本机 Code']), start);
    }
    panel.append(actions, notice);
    const list = el('div', { class: 'ms-calibration-history' });
    for (const session of status.sessions) {
      const row = el('div', {}, [el('span', { text: date(session.startAt) + ' → ' + date(session.stoppedAt || session.endAt) + ' · ' + (session.discardedAt ? '已作废' : blocked.has(session.id) ? '有未匹配增长，暂不采用' : session.id === active?.id ? '进行中' : '已结束') })]);
      if (!session.discardedAt) { const discard = el('button', { type: 'button', class: 'btn', 'data-calibration-action': 'discard', text: '作废本段' }); discard.addEventListener('click', () => change('discard', session.id)); row.append(discard); }
      list.append(row);
    }
    panel.append(list); return panel;
  }

  function budgetTile(w, label, study) {
    const b = study.budget, sel = study.selected;
    const used = sel?.active && !study.quotaStale ? sel.used : null;
    const meter = el('div', { class: 'ms-budget-meter' }, [paint(el('i'), { width: `${Math.min(100, used ?? 0)}%` })]);
    const confidence = { medium: ['样本较充分', 'good'], low: ['初步参考', 'warn'], insufficient: ['样本不足', 'muted'] }[b.confidence];
    return el('div', { class: `ms-budget ${w}` }, [
      el('div', { class: 'ms-budget-top' }, [el('i', { class: 'ms-dot' }), el('b', { text: `${label}整窗` }), el('span', { class: `ms-badge ${confidence[1]}`, text: confidence[0] })]),
      el('strong', { class: 'ms-budget-value' }, b.costUsd != null ? [money(b.costUsd), el('small', { text: '本机专用样本 · API 等价参考' })] : [el('span', { text: used == null ? '—' : `${used.toFixed(1)}%` }), el('small', { text: '官方账号总池已用' })]),
      meter,
      el('p', {}, used != null
        ? [`本周期已用 ${used.toFixed(0)}%`, ` · 官方剩余 ${Math.max(0, 100 - used).toFixed(1)}%`]
        : [study.quotaStale ? '额度采样超过 30 分钟，暂不估算剩余' : '当前没有进行中的周期']),
      el('small', { text: b.intervals ? `${number(b.intervals)} 个采样区间 · 累计 ${number(Math.round(b.points))} 个百分点 · ${number(b.cycles)} 个周期` : '尚无足够的已确认本机校准区间' }),
      attributionNote(study)
    ]);
  }

  /**
   * 一眼看结论：最耐用、调用次数最多、你最常用的组合各一张卡。数字按 5 小时窗口（算不出时用周窗口）。
   * 算不出任何容量（没有整窗预算）时不显示，下面的相对排行已经说明了。
   */
  function highlights(rows, data) {
    const pick = (list, metric) => list.filter(r => metric(r) != null).sort((a, b) => metric(b) - metric(a))[0];
    const win = r => r.five.capacityTokens != null ? ['five', '5 小时'] : ['week', '周'];
    const cap = r => r.five.capacityTokens ?? r.week.capacityTokens;
    const calls = r => r.five.callsPerWindow ?? r.week.callsPerWindow;
    const cards = [];
    const most = pick(rows, cap), busy = pick(rows, calls), usual = pick(rows, r => r.five.recentTokens || null);
    if (most) { const [w, label] = win(most); cards.push(['durable', '参考容量最高', most, tokens(most[w].capacityTokens), `Tokens / ${label}整窗`]); }
    if (busy) { const [w, label] = win(busy); cards.push(['calls', '估计调用次数最多', busy, `≈ ${number(busy[w].callsPerWindow)}`, `次调用 / ${label}整窗`]); }
    if (usual) {
      const [w, label] = win(usual), left = usual[w].remainingTokens;
      cards.push(['usual', '你最常用', usual, left != null ? tokens(left) : tokens(usual[w].capacityTokens ?? 0), left != null ? `Tokens · ${label}周期还剩` : `Tokens / ${label}整窗`]);
    }
    if (!cards.length || cards.every(c => c[2][win(c[2])[0]].capacityTokens == null)) return null;
    return el('div', { class: 'ms-highlights' }, cards.map(([kind, title, r, value, unit], i) => paint(el('div', { class: `ms-highlight ${kind}` }, [
      el('div', { class: 'ms-highlight-top' }, [avatar(data.kind), el('span', { text: title })]),
      el('div', { class: 'ms-highlight-model' }, [el('b', { text: r.model, title: r.model, translate: 'no' }), ...r.efforts.slice(0, 3).map(levelBadge), r.efforts.length > 3 ? el('span', { class: 'ms-level plain', text: `+${r.efforts.length - 3}` }) : null]),
      el('div', { class: 'ms-highlight-value' }, [el('strong', { text: value }), el('small', { text: unit })])
    ]), { '--i': i })));
  }

  function capCell(c, w, max, study) {
    const cell = el('div', { class: `ms-cap ${w}` });
    if (c.capacityTokens != null) {
      cell.append(el('div', { class: 'ms-cap-num' }, [el('b', { text: tokens(c.capacityTokens) }), el('small', { text: c.callsPerWindow ? `≈ ${number(c.callsPerWindow)} 次调用` : money(c.capacityCostUsd) })]));
      const meter = el('div', { class: 'ms-meter' }, [paint(el('i', { class: 'full' }), { width: `${Math.max(1.5, c.capacityTokens / (max[w] || 1) * 100).toFixed(2)}%` })]);
      if (c.remainingTokens != null) meter.append(paint(el('i', { class: 'left' }), { width: `${Math.max(0, c.remainingTokens / (max[w] || 1) * 100).toFixed(2)}%` }));
      cell.append(meter);
    } else if (c.relative != null) {
      cell.append(el('div', { class: 'ms-cap-num' }, [el('b', { text: `×${c.relative.toFixed(2)}` }), el('small', { text: 'API 价格参考比' })]),
        el('div', { class: 'ms-meter' }, [paint(el('i', { class: 'full relative' }), { width: `${Math.max(1.5, c.relative / (max.relative || 1) * 100).toFixed(2)}%` })]));
    } else {
      cell.append(el('div', { class: 'ms-cap-num' }, [el('b', { class: 'muted', text: '—' }), el('small', { text: '价格表里没有这个型号' })]), el('div', { class: 'ms-meter' }));
    }
    return cell;
  }

  function rankRow(row, i, max, data) {
    const c5 = row.five, cw = row.week;
    const basis = cw.capacityBasis === 'measured' || c5.capacityBasis === 'measured' ? ['样本外推', 'measured'] : c5.priceBasis === 'price' ? ['价格表', 'price'] : c5.priceBasis ? ['按价模拟', 'cost'] : null;
    const meta = [
      c5.costPerMTokens != null ? `${money(c5.costPerMTokens)} / 百万 Tokens` : null,
      c5.tokensPerCall ? `单次调用约 ${tokens(c5.tokensPerCall)}` : null,
      c5.recentTokens ? `30 天用了 ${tokens(c5.recentTokens)}` : '30 天没用过'
    ].filter(Boolean);
    const node = el('div', { class: 'ms-row' + (i < 3 && Q.sort !== 'name' ? ' top' : ''), role: 'listitem', tabindex: 0, 'data-key': row.key, 'data-model': row.model, 'data-effort': row.efforts.join(' ') }, [
      el('span', { class: 'ms-no', text: String(i + 1).padStart(2, '0') }),
      el('div', { class: 'ms-name' }, [
        avatar(data.kind, 'ms-row-logo'),
        el('div', { class: 'ms-name-text' }, [
          el('div', { class: 'ms-name-top' }, [el('b', { text: row.model, title: row.model, translate: 'no' }), ...row.efforts.map(levelBadge), basis ? el('span', { class: `ms-basis ${basis[1]}`, text: basis[0] }) : null]),
          el('small', { text: meta.join(' · ') })
        ])
      ]),
      capCell(c5, 'five', max, data.five),
      capCell(cw, 'week', max, data.week)
    ]);
    paint(node, { '--i': Math.min(i, 24) });
    node.setAttribute('aria-label', detail(row, data).replaceAll('\n', '，'));
    return tipOn(node, detail(row, data));
  }

  function detail(row, data) {
    const zh = window.PulseI18n?.lang() !== 'en';
    const lines = [`${row.model} · ${row.efforts.map(e => levelName(e) + (zh && LEVEL[e] && STRENGTH[e] ? `（${LEVEL[e]}）` : '')).join(' / ')}`];
    if (row.efforts.length > 1) lines.push('这几个等级共享价格参考；缺少专属数据，不代表官方扣额相同');
    for (const [w, label] of WINDOWS) {
      const c = row[w], b = data[w].budget;
      if (c.capacityTokens != null) lines.push(`${label}整窗：约 ${number(c.capacityTokens)} Tokens${c.capacityCostUsd != null ? `（${money(c.capacityCostUsd)} API 等价）` : ''}${c.callsPerWindow ? ` · 约 ${number(c.callsPerWindow)} 次调用` : ''}${c.remainingTokens != null ? ` · 本周期还剩约 ${tokens(c.remainingTokens)}` : ''}`);
      else if (c.relative != null) lines.push(`${label}整窗：${b.costUsd == null ? '样本不足，' : ''}API 价格参考比 ×${c.relative.toFixed(2)}`);
      if (c.estimatedTokens != null) lines.push(`${label}实测：${c.intervals} 个纯区间、${c.quotaPoints.toFixed(0)} 个百分点，约 ${tokens(c.estimatedTokens)}（${c.confidence === 'medium' ? '样本较充分' : '初步参考'}）`);
    }
    if (row.five.capacityBasis === 'cost' || row.week.capacityBasis === 'cost') lines.push('按价模拟：假设扣额与 API 费用成比例，未被官方确认，不是实测额度。');
    const c = row.five;
    const basis = { combo: '这个组合自己最近 30 天的实际费用', model: '同模型其他等级的实际费用', price: '价格表 × 本账号的用量结构' }[c.priceBasis];
    if (basis) lines.push(`单价：${money(c.costPerMTokens)} / 百万 Tokens，来自${basis}`);
    if (c.tokensPerCall) lines.push(`最近 30 天：${number(c.recentCalls)} 次调用，平均每次 ${tokens(c.tokensPerCall)} Tokens`);
    if (row.semantics === 'agent_count') lines.push('这个模型的等级控制协作智能体数量');
    lines.push(`目录来源：${row.origins.map(o => ({ cache: '本机模型目录', docs: '官方文档', observed: '日志里出现过' })[o] || o).join('、')}`);
    return lines.join('\n');
  }

  function methodNote() {
    // 数据每分钟更新会重画整个专区：记住展开状态，别让用户正在看的说明自己收起来
    const node = el('details', { class: 'ms-method', open: Q.methodOpen ? '' : null });
    node.addEventListener('toggle', () => { Q.methodOpen = node.open; });
    node.append(el('summary', { text: '怎么换算的' }),
      el('ul', {}, [
        el('li', { text: '官方额度属于账号总池，可包含聊天、Code 和其他设备。0.3.9 仅使用用户前向确认的本机专用时段；前 10 分钟缓冲，有明显未匹配增长的校准段暂不采用。' }),
        el('li', { text: '优先使用已确认的同模型/等级样本。没有合格专属样本时的「按价模拟」假设扣额与 API 参考费用成比例，此假设未被官方确认，不能当作真实额度或保证。' }),
        el('li', { text: '标「样本外推」的组合：有足够多整段只用它的采样区间，直接按实测折算。即使数值接近，也不能证明官方按 API 单价扣额度。' }),
        el('li', { text: '思考等级、上下文和缓存会改变请求构成；API 单价不代表官方扣额权重，不保证较高等级一定能调用更少次数。「≈ 次调用」按这个组合最近 30 天的平均算。' }),
        el('li', { text: '其他设备的用量、长时间没有采样、跨重置卡、套餐变化都会让结果偏离；API 等价费用不是订阅余额。目录里的模型不保证这个账号都能用。' })
      ]));
    return node;
  }

  /** 换排序 / 筛选时，行从旧位置滑到新位置（FLIP）。 */
  function positions(host) { return new Map([...host.querySelectorAll('.ms-row')].map(n => [n.dataset.key, n.getBoundingClientRect().top])); }
  function flip(host, before) {
    if (reducedMotion.matches) return;
    for (const node of host.querySelectorAll('.ms-row')) {
      const from = before.get(node.dataset.key);
      if (from == null) { node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' }); continue; }
      const dy = from - node.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) node.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    }
  }
  function syncSegs(host) { for (const group of host.querySelectorAll('.seg')) syncSeg(group); }

  /* ================= 额度详情：模型与思考等级时间线（0.3.9 从用量明细移过来，跟随上方选中的账号） ================= */

  const T = { host: null, loader: null, snapshot: null, accountId: '', cycles: { five: '', week: '' }, focus: '', width: 0 };

  function timelineAccounts(snapshot) { return (snapshot?.accounts || []).filter(a => a.accountId && (a.five || a.week)); }
  function timelineUpdate(snapshot, preferred) {
    T.host ??= $('quota-model-timeline');
    if (!T.host) return;
    T.loader ??= loader(T.host, mode => drawTimeline(mode));
    if (!T.observer) { T.observer = new ResizeObserver(() => { const w = T.host.clientWidth; if (Math.abs(w - T.width) > 24 && T.loader.view.data) { T.width = w; drawTimeline('update'); } }); T.observer.observe(T.host); }
    T.snapshot = snapshot;
    const accounts = timelineAccounts(snapshot);
    const next = accounts.find(a => a.accountId === preferred)?.accountId || '';
    if (next !== T.accountId) { T.accountId = next; T.cycles = { five: '', week: '' }; T.focus = ''; }
    const report = accounts.find(a => a.accountId === T.accountId);
    if (!report) { T.loader.reset(); drawTimeline('none'); return; }
    T.loader.load(`${T.accountId}|${T.cycles.five}|${T.cycles.week}`, { kind: report.kind, accountId: report.accountId, cycles: { ...(T.cycles.five ? { five: T.cycles.five } : {}), ...(T.cycles.week ? { week: T.cycles.week } : {}) } }, stampOf(snapshot, report));
  }
  function reloadTimeline() { timelineUpdate(T.snapshot, T.accountId); }

  function timelineHeading() {
    const report = timelineAccounts(T.snapshot).find(a => a.accountId === T.accountId);
    return [el('div', { class: 'panel-heading ms-head' }, [el('div', { class: 'ms-title' }, [
      report ? avatar(report.kind, 'ms-brand') : null,
      el('div', {}, [
        el('h2', {}, ['模型与思考等级 · 时间线', el('span', { class: 'section-tag', text: '按官方周期' })]),
        el('p', { text: '每个模型 × 思考等级一条轨道，连续使用的时间段连成一段；上方曲线是全账号官方额度已用百分比（可能含聊天及其他设备）。跟随上方选中的账号，不受用量明细的日期和筛选影响。' })
      ])
    ])])];
  }

  function drawTimeline(mode) {
    const host = T.host, data = T.loader.view.data;
    if (mode === 'none') { host.replaceChildren(...timelineHeading(), empty('这个账号还没有带账号标识的官方额度周期。')); return; }
    if (mode === 'loading') { host.replaceChildren(...timelineHeading(), skeleton(4)); return; }
    if (mode === 'error' || !data) {
      host.replaceChildren(...timelineHeading(), failure('时间线读取失败，没有显示旧数据。'));
      host.querySelector('[data-action=retry-study]').addEventListener('click', () => { T.loader.reset(); reloadTimeline(); });
      return;
    }
    T.width = host.clientWidth;
    const colors = colorMap(data);
    const cards = WINDOWS.map(([w, label]) => cycleCard(w, label, data[w], colors));
    host.replaceChildren(...timelineHeading(), ...cards.map(c => c.node));
    for (const c of cards) c.draw(mode === 'enter');
    applyFocus();
  }

  /** 颜色跟着模型走（两条时间线一致）：按周期里的用量从多到少分配色相，等级用深浅区分。 */
  function colorMap(data) {
    const total = new Map();
    for (const w of ['week', 'five']) for (const b of data[w].timeline) total.set(b.model, (total.get(b.model) || 0) + b.tokens);
    const models = [...total].sort((a, b) => b[1] - a[1]).map(([m]) => m);
    return model => { const i = models.indexOf(model); return i < 0 ? HUES.at(-1) : HUES[i % (HUES.length - 1)]; };
  }

  function cycleCard(w, label, study, colors) {
    const sel = study.selected, index = sel ? study.cycles.findIndex(c => c.id === sel.id) : -1;
    const combos = summarize(study);
    const step = delta => {
      const next = study.cycles[index + delta];
      if (!next) return;
      T.cycles = { ...T.cycles, [w]: index + delta === 0 ? '' : next.id }; reloadTimeline();
    };
    const older = el('button', { type: 'button', class: 'btn ms-step', 'aria-label': `上一个${label}周期`, title: `上一个${label}周期`, disabled: index < 0 || index >= study.cycles.length - 1 ? '' : null, text: '‹' });
    const newer = el('button', { type: 'button', class: 'btn ms-step', 'aria-label': `下一个${label}周期`, title: `下一个${label}周期`, disabled: index <= 0 ? '' : null, text: '›' });
    older.addEventListener('click', () => step(1)); newer.addEventListener('click', () => step(-1));
    const status = !sel ? null : sel.active ? ['进行中', 'good'] : ['已结束', 'muted'];
    const chart = el('div', { class: 'ms-tl', 'data-window': w });
    const node = el('article', { class: `ms-cycle ${w}` }, [
      el('div', { class: 'ms-cycle-head' }, [
        el('div', { class: 'ms-cycle-title' }, [el('i', { class: 'ms-dot' }), el('b', { text: `${label}周期` }),
          sel ? el('span', { class: 'ms-range', text: `${date(sel.startAt)} → ${date(sel.endAt)}` }) : null,
          status ? el('span', { class: `ms-badge ${status[1]}`, text: status[0] }) : null,
          sel?.resetCard ? el('span', { class: 'ms-badge warn', text: '重置卡分段' }) : null]),
        el('div', { class: 'ms-cycle-nav' }, [
          el('span', { class: 'ms-cycle-stats', text: sel ? `${number(combos.length)} 个组合 · ${tokens(study.totals.tokens)} Tokens · ${number(study.totals.calls)} 次调用` : '' }),
          older, el('span', { class: 'ms-cycle-pos', text: sel ? `${index + 1} / ${study.cycles.length}` : '—' }), newer
        ])
      ]),
      attributionNote(study),
      chart,
      combos.length ? comboList(combos, study.totals.tokens, colors, study.query.kind) : null,
      study.totals.unknownEffort ? el('p', { class: 'ms-note', text: `其中 ${number(study.totals.unknownEffort)} 条请求没记录思考等级（旧日志或客户端没写），单独放在「未记录等级」轨道。` }) : null
    ]);
    return { node, draw: animate => drawLanes(chart, study, combos, colors, animate) };
  }

  /** 周期里出现过的组合，按用量从多到少。 */
  function summarize(study) {
    const map = new Map();
    for (const b of study.timeline) {
      const c = map.get(b.key) ?? { key: b.key, model: b.model, effort: b.effort, tokens: 0, calls: 0, count: 0, costUsd: 0, priced: true, bins: [] };
      c.tokens += b.tokens; c.calls += b.calls; c.count += b.count; if (b.costUsd == null) c.priced = false; else c.costUsd += b.costUsd; c.bins.push(b);
      map.set(b.key, c);
    }
    return [...map.values()].sort((a, b) => (a.effort === 'unknown') - (b.effort === 'unknown') || b.tokens - a.tokens);
  }
  /** 相邻的时间格连成一段：中间空着的不超过一格（五小时窗口至少 5 分钟，周窗口至少 45 分钟）。 */
  function runsOf(combo, binMs, w) {
    const gap = Math.max(binMs, w === 'five' ? 5 * 60000 : 45 * 60000), runs = [];
    for (const b of [...combo.bins].sort((x, y) => x.startAt - y.startAt)) {
      const last = runs.at(-1);
      if (last && b.startAt - last.endAt <= gap) { last.endAt = b.endAt; last.lastAt = b.lastAt; last.tokens += b.tokens; last.calls += b.calls; last.count += b.count; last.costUsd = last.costUsd != null && b.costUsd != null ? last.costUsd + b.costUsd : null; }
      else runs.push({ startAt: b.startAt, endAt: b.endAt, firstAt: b.firstAt, lastAt: b.lastAt, tokens: b.tokens, calls: b.calls, count: b.count, costUsd: b.costUsd });
    }
    return runs;
  }
  const colorFor = (combo, colors) => combo.effort === 'unknown' ? 'var(--faint)' : colors(combo.model);
  const alphaFor = effort => STRENGTH[effort] ?? .8;

  function drawLanes(host, study, combos, colors, animate) {
    host.replaceChildren();
    const sel = study.selected;
    if (!sel) { host.append(empty('这个账号没有这种窗口的官方周期记录。')); return; }
    const w = Math.max(560, host.clientWidth || 900), labelW = Math.min(230, Math.max(150, w * .24)), left = labelW + 14, right = w - 16;
    const bandTop = 10, bandH = 58, laneTop = bandTop + bandH + 26, laneH = 34, lanes = Math.max(1, combos.length);
    const h = laneTop + lanes * laneH + 26;
    const start = sel.startAt, end = sel.endAt, span = Math.max(1, end - start);
    const x = at => left + (Math.min(end, Math.max(start, at)) - start) / span * (right - left);
    const node = svg('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: 'group', 'aria-label': '模型与思考等级时间线' });

    // 时间刻度：五小时按整点，周按天
    const tickStep = study.query.window === 'five' ? HOUR : DAY;
    const first = new Date(start); if (tickStep === DAY) first.setHours(24, 0, 0, 0); else first.setMinutes(60, 0, 0);
    for (let at = first.getTime(); at < end; at += tickStep) {
      const tx = x(at);
      node.append(svg('line', { class: 'ms-grid', x1: tx, x2: tx, y1: bandTop, y2: h - 22 }));
      const d = new Date(at), label = svg('text', { class: 'axis', x: tx, y: h - 6, 'text-anchor': 'middle' });
      label.textContent = tickStep === DAY ? `${WEEKDAY[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}` : `${d.getHours()}:00`;
      node.append(label);
    }

    for (const interval of study.attribution?.intervals || []) {
      if (interval.kind === 'local_present') continue;
      const band = svg('rect', { x: x(interval.from), y: bandTop, width: Math.max(2, x(interval.to) - x(interval.from)), height: bandH, class: 'ms-unmatched-band', tabindex: 0, role: 'img', 'aria-label': '未匹配本机日志的额度增长' });
      tipOn(band, date(interval.from) + ' → ' + date(interval.to) + '\n官方增加 ' + interval.points.toFixed(2) + ' 个百分点\n未匹配本机日志或存在采样缺口；可能来自聊天、其他设备或统计延迟。没有从官方总已用中扣除。');
      node.append(band);
    }
    // 上方：官方额度已用百分比（阶梯线，采样之间保持上一个值）
    const y = pct => bandTop + bandH - Math.min(100, Math.max(0, pct)) / 100 * bandH;
    for (const g of [0, 50, 100]) {
      node.append(svg('line', { class: 'ms-grid faint', x1: left, x2: right, y1: y(g), y2: y(g) }));
      const t = svg('text', { class: 'axis', x: left - 8, y: y(g) + 4, 'text-anchor': 'end' }); t.textContent = `${g}%`; node.append(t);
    }
    const bandLabel = svg('text', { class: 'ms-lane-name', x: 4, y: bandTop + bandH / 2 + 4 }); bandLabel.textContent = '官方总池已用'; node.append(bandLabel);
    const track = study.track.filter(p => p.at >= start && p.at <= end);
    if (track.length) {
      let d = `M${x(start).toFixed(1)},${y(0).toFixed(1)}`;
      for (const p of track) d += ` H${x(p.at).toFixed(1)} V${y(p.pct).toFixed(1)}`;
      d += ` H${x(Math.min(end, sel.active ? study.now : track.at(-1).at)).toFixed(1)}`;
      const lastX = x(Math.min(end, sel.active ? study.now : track.at(-1).at));
      node.append(svg('path', { class: 'ms-quota-area', d: `${d} V${y(0)} Z` }), svg('path', { class: 'ms-quota-line', d, pathLength: 1, 'stroke-dasharray': 1 }));
      node.append(svg('circle', { class: 'ms-quota-dot', cx: lastX, cy: y(track.at(-1).pct), r: 3.5 }));
      const hit = svg('rect', { class: 'ms-hit', x: left, y: bandTop, width: right - left, height: bandH });
      hit.addEventListener('pointermove', e => {
        const box = node.getBoundingClientRect(), at = start + ((e.clientX - box.left) * (w / box.width) - left) / (right - left) * span;
        const p = [...track].reverse().find(q => q.at <= at) ?? track[0];
        tipAt(`${date(p.at)}\n官方额度已用 ${p.pct.toFixed(0)}%`, e.clientX, e.clientY);
      });
      hit.addEventListener('pointerleave', hideTip);
      node.append(hit);
    }

    // 轨道
    if (!combos.length) {
      const t = svg('text', { class: 'axis', x: (left + right) / 2, y: laneTop + laneH / 2 + 4, 'text-anchor': 'middle' });
      t.textContent = sel.active && study.cycles.length > 1 ? '这个周期里还没有本机官方请求，点右上角 ‹ 看上一个周期' : '这个周期里没有本机官方请求';
      node.append(t);
    }
    combos.forEach((combo, i) => {
      const cy = laneTop + i * laneH + laneH / 2, color = colorFor(combo, colors);
      const lane = svg('g', { class: 'ms-lane', 'data-key': combo.key });
      paint(lane, { '--i': i });
      // 左边：公司图标 + 模型名 + 等级
      const logo = brandSvg(META[study.query.kind].brand);
      for (const [k, val] of Object.entries({ x: 4, y: cy - 9, width: 18, height: 18, class: 'brand-svg ms-lane-logo' })) logo.setAttribute(k, val);
      const name = svg('text', { class: 'ms-lane-name', x: 30, y: cy - 2 }); name.textContent = combo.model.length > 22 ? combo.model.slice(0, 21) + '…' : combo.model;
      name.setAttribute('translate', 'no');
      const level = svg('text', { class: 'ms-lane-level', x: 30, y: cy + 12 }); level.textContent = levelName(combo.effort);
      lane.append(svg('rect', { class: 'ms-lane-bg', x: 0, y: cy - laneH / 2 + 2, width: w, height: laneH - 4, rx: 6 }), logo, name, level, svg('line', { class: 'ms-rail', x1: left, x2: right, y1: cy, y2: cy }));
      const title = svg('title'); title.textContent = combo.model; name.append(title);
      for (const run of runsOf(combo, study.binMs, study.query.window)) {
        const rx = x(run.startAt), rw = Math.max(5, x(run.endAt) - rx);
        const rect = svg('rect', { class: 'ms-run', x: rx, y: cy - 7, width: rw, height: 14, rx: Math.min(4, rw / 2), tabindex: 0 });
        paint(rect, { fill: color, fillOpacity: alphaFor(combo.effort) });
        const text = `${combo.model} · ${levelName(combo.effort)}\n${date(run.firstAt)} – ${hm(run.lastAt)}\n${number(run.count)} 条请求 · ${number(run.calls)} 次调用 · ${tokens(run.tokens)} Tokens${run.costUsd != null ? ` · ${money(run.costUsd)}` : ''}`;
        rect.setAttribute('aria-label', text.replaceAll('\n', '，'));
        lane.append(tipOn(rect, text));
      }
      lane.addEventListener('click', () => { T.focus = T.focus === combo.key ? '' : combo.key; applyFocus(); });
      node.append(lane);
    });

    if (sel.active && study.now < end) {
      const nx = x(study.now);
      node.append(svg('line', { class: 'ms-now', x1: nx, x2: nx, y1: bandTop, y2: h - 22 }));
      // 贴着左右两端时文字放到线的内侧，别压住坐标轴的百分比
      const side = nx > right - 30 ? ['end', nx - 5] : nx < left + 30 ? ['start', nx + 5] : ['middle', nx];
      const t = svg('text', { class: 'ms-now-label', x: side[1], y: laneTop - 8, 'text-anchor': side[0] }); t.textContent = '现在'; node.append(t);
    }
    host.append(node);
    playChart(host, animate);
  }

  function comboList(combos, total, colors, kind) {
    const list = el('div', { class: 'ms-combos' }, combos.map(c => {
      const item = el('button', { type: 'button', class: 'ms-combo', 'data-key': c.key, 'aria-pressed': 'false' }, [
        paint(el('i', { class: 'ms-swatch' }), { background: colorFor(c, colors), opacity: alphaFor(c.effort) }),
        el('span', { class: 'ms-combo-name' }, [miniLogo(META[kind].source), el('b', { text: c.model, translate: 'no', title: c.model }), levelBadge(c.effort)]),
        el('span', { class: 'ms-combo-bar' }, [paint(el('i'), { width: `${Math.max(1, total ? c.tokens / total * 100 : 0).toFixed(2)}%`, background: colorFor(c, colors) })]),
        el('span', { class: 'ms-combo-num' }, [el('b', { text: tokens(c.tokens) }), el('small', { text: `${total ? (c.tokens / total * 100).toFixed(1) : '0'}% · ${number(c.calls)} 次${c.priced ? ` · ${money(c.costUsd)}` : ''}` })])
      ]);
      item.addEventListener('click', () => { T.focus = T.focus === c.key ? '' : c.key; applyFocus(); });
      return item;
    }));
    return list;
  }
  /** 点一个组合：两条时间线里只亮它，其他变淡；再点一次恢复。 */
  function applyFocus() {
    const host = T.host;
    host.classList.toggle('ms-focusing', Boolean(T.focus));
    for (const n of host.querySelectorAll('.ms-lane, .ms-combo')) {
      const on = n.dataset.key === T.focus;
      n.classList.toggle('focused', on);
      if (n.classList.contains('ms-combo')) n.setAttribute('aria-pressed', String(on));
    }
  }

  window.PulseModelStudy = { quota: quotaUpdate, timeline: timelineUpdate };
})();
