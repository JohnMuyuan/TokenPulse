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

  const Q = { host: null, loader: null, report: null, snapshot: null, sort: 'capacity', level: 'all', animate: false, open: new Set() };

  function quotaUpdate(snapshot, report) {
    Q.host ??= $('quota-model-study');
    if (!Q.host) return;
    Q.loader ??= loader(Q.host, mode => drawQuota(mode));
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
      el('div', { class: 'ms-head-actions' }, [
        kind ? addModelButton() : null,
        segment(SORTS, Q.sort, value => { Q.sort = value; drawQuota('resort'); }),
      ]),
    ]);
  }
  function addModelButton() {
    const b = el('button', { type: 'button', class: 'btn ms-add-model', 'data-action': 'add-model' }, [icon('plus'), el('span', { text: '添加模型' })]);
    b.addEventListener('click', openAddModels);
    return b;
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
    shown.forEach((row, i) => { const node = rankRow(row, i, max, data); list.append(node); if (Q.open.has(row.key)) { node.classList.add('open'); node.setAttribute('aria-expanded', 'true'); list.append(detailPanel(row, data)); } });
    if (!shown.length) list.append(empty('没有符合条件的模型组合。'));
    const unknown = data.five.capacities.find(c => c.effort === 'unknown');
    const noBudget = !data.five.budget.costUsd && !data.week.budget.costUsd;
    const merged = shown.reduce((n, r) => n + r.efforts.length, 0);
    host.replaceChildren(...[
      quotaHeading(),
      el('div', { class: 'ms-budgets' }, WINDOWS.map(([w, label]) => budgetTile(w, label, data[w]))),
      highlights(merge(rows), data),
      noBudget ? el('p', { class: 'ms-note', text: '最近 30 天里「额度上涨、同期本机有 Code 请求」的区间还不够多，暂不折算绝对 Token / 美元容量。下面的倍数仅比较 API 参考单价，不是官方额度倍数。' }) : null,
      el('div', { class: 'ms-toolbar' }, [
        el('div', { class: 'ms-chips', role: 'group', 'aria-label': '按思考等级筛选' }, [['all', '全部等级'], ...levels.map(l => [l, levelName(l)])].map(([id, label]) =>
          el('button', { type: 'button', class: 'ms-chip' + (Q.level === id ? ' on' : ''), 'data-level': id, 'aria-pressed': String(Q.level === id), translate: id === 'all' ? null : 'no' }, [label, el('small', { text: String(id === 'all' ? rows.length : rows.filter(r => r.effort === id).length) })]))),
        el('div', { class: 'ms-legend' }, [el('span', {}, [el('i', { class: 'ms-key full' }), noBudget ? 'API 价格参考' : '按本机区间折算整窗']), el('span', {}, [el('i', { class: 'ms-key left' }), '按官方剩余比例估算'])])
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
    // 设置里声明了只在本机用 Code 的账号：官方百分比就是本机用的，不需要这段说明
    if (!a || study.localOnly) return null;
    const off = study.offMachine;
    const text = off && off.points + off.markedPoints > 0 ? `本机以外 +${(off.points + off.markedPoints).toFixed(1)}%，不计入折算` : '按本机区间折算';
    const detail = off && off.points + off.markedPoints > 0
      ? '额度涨了、同期本机没有 Code 请求的时段算作聊天或其他设备，已从折算里排除；可以在下方时间线里标注用了什么模型。'
      : '只用「额度上涨、同期本机有 Code 请求」的区间折算；同一时刻也在聊天的话分不出来，会让容量略偏小。';
    // 0.3.13：说明不常驻，收进标题旁的圆圈感叹号（悬停 / 聚焦显示）
    return infoTip([el('span', {}, [el('b', { text })]), el('span', { text: detail })], '折算口径说明', 'ms-attribution-tip');
  }
  function budgetTile(w, label, study) {
    const b = study.budget, sel = study.selected;
    const used = sel?.active && !study.quotaStale ? sel.used : null;
    const meter = el('div', { class: 'ms-budget-meter' }, [paint(el('i'), { width: `${Math.min(100, used ?? 0)}%` })]);
    const confidence = { medium: ['样本较充分', 'good'], low: ['初步参考', 'warn'], insufficient: ['样本不足', 'muted'] }[b.confidence];
    return el('div', { class: `ms-budget ${w}` }, [
      el('div', { class: 'ms-budget-top' }, [el('i', { class: 'ms-dot' }), el('b', { text: `${label}整窗` }), el('span', { class: `ms-badge ${confidence[1]}`, text: confidence[0] }), attributionNote(study)]),
      el('strong', { class: 'ms-budget-value' }, b.costUsd != null ? [money(b.costUsd), el('small', { text: '按本机区间折算 · API 等价参考' })] : [el('span', { text: used == null ? '—' : `${used.toFixed(1)}%` }), el('small', { text: '官方账号总池已用' })]),
      meter,
      el('p', {}, used != null
        ? [`本周期已用 ${used.toFixed(0)}%`, ` · 官方剩余 ${Math.max(0, 100 - used).toFixed(1)}%`]
        : [study.quotaStale ? '额度采样超过 30 分钟，暂不估算剩余' : '当前没有进行中的周期']),
      el('small', { text: b.intervals ? `${number(b.intervals)} 个采样区间 · 累计 ${number(Math.round(b.points))} 个百分点 · ${number(b.cycles)} 个周期` : '还没有「额度上涨、同期本机有请求」的区间' }),
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
      // 整窗的等价 API 费用对每个模型都一样（就是上面的整窗预算），不在格子里重复；下面一行写调用次数和还剩多少
      cell.append(el('div', { class: 'ms-cap-num' }, [el('b', { text: tokens(c.capacityTokens) })]));
      const meter = el('div', { class: 'ms-meter' }, [paint(el('i', { class: 'full' }), { width: `${Math.max(1.5, c.capacityTokens / (max[w] || 1) * 100).toFixed(2)}%` })]);
      if (c.remainingTokens != null) meter.append(paint(el('i', { class: 'left' }), { width: `${Math.max(0, c.remainingTokens / (max[w] || 1) * 100).toFixed(2)}%` }));
      cell.append(meter);
      const sub = [c.callsPerWindow ? `≈ ${number(c.callsPerWindow)} 次调用` : null, c.remainingTokens != null ? `本周期还剩 ${tokens(c.remainingTokens)}` : null].filter(Boolean);
      if (sub.length) cell.append(el('small', { class: 'ms-cap-sub', text: sub.join(' · ') }));
      // 0.3.15：Tokens 里绝大部分是每次调用重读的缓存，容易让人以为能写这么多新内容。写明其中新内容大约多少
      const fresh = freshShare(c.priceMix);
      if (fresh && fresh.cacheRead >= .5) cell.append(el('small', { class: 'ms-cap-new', title: '每次调用都会把整段对话重新读一遍（命中缓存，很便宜），这部分也算在 Tokens 里。新内容 = 新输入 + 缓存写 + 输出。', text: `其中新内容约 ${tokens(c.capacityTokens * fresh.fresh)} · ${pct1(fresh.cacheRead)} 是重读缓存` }));
    } else if (c.relative != null) {
      cell.append(el('div', { class: 'ms-cap-num' }, [el('b', { text: `×${c.relative.toFixed(2)}` }), el('small', { text: 'API 价格参考比' })]),
        el('div', { class: 'ms-meter' }, [paint(el('i', { class: 'full relative' }), { width: `${Math.max(1.5, c.relative / (max.relative || 1) * 100).toFixed(2)}%` })]));
    } else {
      cell.append(el('div', { class: 'ms-cap-num' }, [el('b', { class: 'muted', text: '—' }), el('small', { text: '价格表里没有这个型号' })]), el('div', { class: 'ms-meter' }));
    }
    return cell;
  }

  /** Token 结构里「新内容」（未命中缓存的输入 + 缓存写 + 输出）和缓存读各占多少。 */
  function freshShare(mix) {
    if (!mix) return null;
    const total = mix.fresh + mix.cacheRead + mix.cacheWrite + mix.output;
    return total > 0 ? { fresh: (mix.fresh + mix.cacheWrite + mix.output) / total, cacheRead: mix.cacheRead / total } : null;
  }
  const pct1 = share => `${(share * 100).toFixed(share > .995 || share < .005 ? 2 : 1)}%`;
  function rankRow(row, i, max, data) {
    const c5 = row.five, cw = row.week;
    const basis = cw.capacityBasis === 'measured' || c5.capacityBasis === 'measured' ? ['样本外推', 'measured'] : c5.priceBasis === 'price' ? ['价格表', 'price'] : c5.priceBasis ? ['按价模拟', 'cost'] : null;
    const lp = c5.listPrice;
    const meta = [
      lp ? `输入 ${price$(lp.input)} · 输出 ${price$(lp.output)} / 百万` : null,
      c5.costPerMTokens != null ? `综合 ${price$(c5.costPerMTokens)} / 百万 Tokens` : null,
      c5.tokensPerCall ? `单次调用${c5.tokensPerCallBasis === 'scaled' ? '≈' : '约'} ${tokens(c5.tokensPerCall)}` : null,
      c5.recentTokens ? `30 天用了 ${tokens(c5.recentTokens)}` : '30 天没用过'
    ].filter(Boolean);
    const node = el('div', { class: 'ms-row' + (i < 3 && Q.sort !== 'name' ? ' top' : ''), role: 'listitem', tabindex: 0, 'data-key': row.key, 'data-model': row.model, 'data-effort': row.efforts.join(' ') }, [
      el('span', { class: 'ms-no', text: String(i + 1).padStart(2, '0') }),
      el('div', { class: 'ms-name' }, [
        avatar(data.kind, 'ms-row-logo'),
        el('div', { class: 'ms-name-text' }, [
          el('div', { class: 'ms-name-top' }, [el('b', { text: row.model, title: row.model, translate: 'no' }), ...row.efforts.map(levelBadge), basis ? el('span', { class: `ms-basis ${basis[1]}`, text: basis[0] }) : null,
            c5.effortBasis ? el('span', { class: 'ms-basis effort ' + (c5.effortBasis === 'own' ? 'own' : 'ref'), text: c5.effortBasis === 'own' ? '等级实测' : '等级参考' }) : null,
            ...priceTags(c5.priceNotes),
            row.origins.includes('user') ? el('span', { class: 'ms-user-tag', text: '你添加的' }) : null,
            row.origins.includes('user') ? removeButton(row) : null]),
          el('small', { text: meta.join(' · ') })
        ])
      ]),
      capCell(c5, 'five', max, data.five),
      capCell(cw, 'week', max, data.week)
    ]);
    paint(node, { '--i': Math.min(i, 24) });
    // 0.3.14：悬停不再弹一大段文字；点一下（或回车 / 空格）在这一行下面展开详情
    node.setAttribute('role', 'button');
    node.setAttribute('aria-expanded', 'false');
    node.setAttribute('aria-label', `${row.model} · ${row.efforts.map(levelName).join(' / ')}，点一下看详情`);
    node.append(el('span', { class: 'ms-row-toggle', 'aria-hidden': 'true' }, [icon('chevron')]));
    const toggle = () => {
      const open = !Q.open.has(row.key);
      if (open) Q.open.add(row.key); else Q.open.delete(row.key);
      node.classList.toggle('open', open); node.setAttribute('aria-expanded', String(open));
      const next = node.nextElementSibling;
      if (next?.classList.contains('ms-detail')) next.remove();
      if (open) {
        const panel = detailPanel(row, data);
        node.after(panel);
        if (!reducedMotion.matches) panel.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'ease-out' });
      }
    };
    node.addEventListener('click', e => { if (!e.target.closest('button, a')) toggle(); });
    node.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === node) { e.preventDefault(); toggle(); } });
    return node;
  }

  /**
   * 展开的详情（0.3.14）：以前悬停弹出的那一大段文字，分成两个整窗的小卡片 + 几行「项目 / 内容」+ 注意事项。
   */
  function detailPanel(row, data) {
    const c = row.five;
    const winCard = ([w, label]) => {
      const x = row[w], b = data[w].budget;
      const body = [];
      if (x.capacityTokens != null) {
        body.push(el('div', { class: 'ms-dw-value' }, [el('strong', { text: tokens(x.capacityTokens) }), el('small', { text: 'Tokens' })]));
        if (x.capacityCostUsd != null) body.push(el('div', { class: 'ms-dw-usd' }, [el('b', { text: money(x.capacityCostUsd) }), el('small', { text: 'API 等价' })]));
        const share = freshShare(x.priceMix);
        const stats = [x.callsPerWindow ? `约 ${number(x.callsPerWindow)} 次调用` : null, x.remainingTokens != null ? `本周期还剩约 ${tokens(x.remainingTokens)}` : null, share && share.cacheRead >= .5 ? `其中新内容约 ${tokens(x.capacityTokens * share.fresh)}` : null].filter(Boolean);
        if (stats.length) body.push(el('div', { class: 'ms-dw-stats' }, stats.map(t => el('span', { text: t }))));
      } else if (x.relative != null) {
        body.push(el('div', { class: 'ms-dw-value' }, [el('strong', { text: `×${x.relative.toFixed(2)}` }), el('small', { text: 'API 价格参考比' })]));
        if (b.costUsd == null) body.push(el('div', { class: 'ms-dw-stats' }, [el('span', { text: '样本不足，暂不折算绝对容量' })]));
      } else body.push(el('div', { class: 'ms-dw-value' }, [el('strong', { class: 'muted', text: '—' }), el('small', { text: '价格表里没有这个型号' })]));
      if (x.estimatedTokens != null) body.push(el('p', { class: 'ms-dw-measured', text: `实测：${x.intervals} 个纯区间、${x.quotaPoints.toFixed(0)} 个百分点，约 ${tokens(x.estimatedTokens)}（${x.confidence === 'medium' ? '样本较充分' : '初步参考'}）` }));
      return el('div', { class: `ms-dw ${w}` }, [el('div', { class: 'ms-dw-head' }, [el('i', { class: 'ms-dot' }), el('b', { text: `${label}整窗` })]), ...body]);
    };
    const facts = [];
    const fact = (label, value, sub, extra) => facts.push(el('div', { class: 'ms-fact' }, [el('dt', { text: label }), el('dd', {}, [value ? el('span', { text: value }) : null, extra || null, sub ? el('small', { text: sub }) : null])]));
    const basis = { combo: '这个组合自己最近 30 天的实际费用', model: '同模型其他等级的实际费用', price: '价格表 × 本账号的用量结构', effort: '价格表 × 本账号的用量结构，输出部分按思考等级倍数换算' }[c.priceBasis];
    const priceBlock = priceDetail(c, data.five.priceSource, basis);
    if (priceBlock) facts.push(...priceBlock);
    const notes = priceNoteLines(c.priceNotes);
    if (notes.length) fact('单价说明', '', '', el('ul', { class: 'ms-fact-list' }, notes.map(t => el('li', { text: t }))));
    if (c.effortBasis) {
      const ratio = `${levelName(c.effortAnchor)} → ${levelName(row.effort)} 输出约 ×${c.effortRatio.toFixed(2)}`;
      fact('思考等级', ratio, c.effortBasis === 'own' ? '按你自己的用量实测' : c.effortBasis === 'benchmark' ? `参考 Epoch AI 基准（${c.effortSource}）同型号` : '参考 Epoch AI 基准的同家族平均');
    }
    if (c.tokensPerCall && c.tokensPerCallBasis !== 'scaled') fact('单次调用', `平均每次 ${tokens(c.tokensPerCall)} Tokens`, `最近 30 天 ${number(c.recentCalls)} 次调用`);
    else if (c.tokensPerCall) fact('单次调用', `约 ${tokens(c.tokensPerCall)} Tokens`, `没用过这个组合：按 ${levelName(c.effortAnchor || '')} 档的实际大小推算`);
    if (c.recentTokens) fact('最近 30 天', `用了 ${tokens(c.recentTokens)} Tokens`);
    fact('目录来源', '', '', el('span', { class: 'ms-fact-tags' }, row.origins.map(o => el('span', { class: 'ms-source-chip', text: ({ cache: '本机模型目录', docs: '官方文档', observed: '日志里出现过', user: '你添加的' })[o] || o }))));
    const cautions = [
      row.efforts.length > 1 ? '这几个等级共享价格参考；缺少专属数据，不代表官方扣额相同。' : null,
      row.five.capacityBasis === 'cost' || row.week.capacityBasis === 'cost' ? '按价模拟：假设扣额与 API 费用成比例，未被官方确认，不是实测额度。' : null,
      row.origins.includes('user') ? '你添加的：没验证这个账号能不能用，只按单价和思考等级消耗估算。' : null,
      row.semantics === 'agent_count' ? '这个模型的等级控制协作智能体数量。' : null,
    ].filter(Boolean);
    return el('div', { class: 'ms-detail', role: 'region', 'aria-label': `${row.model} 详情`, 'data-key': row.key }, [
      el('div', { class: 'ms-detail-wins' }, WINDOWS.map(winCard)),
      el('dl', { class: 'ms-facts' }, facts),
      cautions.length ? el('div', { class: 'ms-cautions' }, cautions.map(t => el('p', {}, [icon('notice'), el('span', { text: t })]))) : null,
    ]);
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
        el('li', { text: '思考等级：等级越高推理 / 输出 token 越多。没用够的组合按你最常用那一档的实际用量，把输出部分乘上等级倍数推算；倍数优先用你自己的实测（同型号两档各 20 次调用以上），其次参考 Epoch AI 基准数据（DeepSWE / CursorBench，CC BY 4.0）的同型号数据或同家族平均，标「等级参考」。' }),
        el('li', { text: '其他设备的用量、长时间没有采样、跨重置卡、套餐变化都会让结果偏离；API 等价费用不是订阅余额。目录里的模型、以及你自己添加的模型，不保证这个账号都能用。' })
      ]));
    return node;
  }

  /* ---------------- 单价明细（0.3.14）：标价四项、来源、综合单价怎么算的 ---------------- */

  /** 每百万 Token 的价格：够大写两位小数，很小的保留到有效数字（$0.075）。 */
  const price$ = n => n == null ? '—' : '$' + (n >= 1 || n === 0 ? n.toFixed(2) : n >= 0.1 ? n.toFixed(2) : Number(n.toPrecision(2)).toString());
  const PARTS = [['fresh', '输入（未命中缓存）', 'input'], ['cacheRead', '缓存读（命中）', 'cacheRead'], ['cacheWrite', '缓存写', 'cacheWrite'], ['output', '输出（含推理）', 'output']];
  function priceSourceText(lp, source) {
    const kb = source ? `模型知识库 ${source.version}（${source.source === 'downloaded' ? '已在线更新' : '随软件内置'}${source.updatedAt ? `，${String(source.updatedAt).slice(0, 10)} 生成` : ''}）` : '模型知识库';
    if (!lp) return '';
    if (lp.auto) return `LiteLLM 公开价格表的「${lp.auto}」（每天自动同步，并和 OpenRouter 交叉核对）· ${kb}`;
    return `手动维护的规则「${lp.note || lp.match}」（knowledge/manual.json：没有逐个型号的价格时按型号家族估算）· ${kb}`;
  }
  function priceDetail(c, source, basis) {
    const lp = c.listPrice, out = [];
    const fact = (label, children) => el('div', { class: 'ms-fact' }, [el('dt', { text: label }), el('dd', {}, children.filter(Boolean))]);
    if (lp) {
      const cell = (label, value, hint) => el('div', { class: 'ms-price-cell' }, [el('small', { text: label }), el('b', { text: value }), hint ? el('i', { text: hint }) : null]);
      out.push(fact('标价', [
        el('div', { class: 'ms-price-grid', role: 'list' }, [
          cell('输入', price$(lp.input)),
          cell('缓存读（命中）', price$(lp.cacheRead)),
          cell('缓存写', lp.cacheWrite > 0 ? price$(lp.cacheWrite) : price$(lp.input), lp.cacheWrite > 0 ? null : '没有单独价，按输入价'),
          cell('输出', price$(lp.output)),
        ]),
        el('small', { text: '单位：美元 / 每百万 Tokens。推理（思考）Token 按输出价计。' }),
        el('small', { class: 'ms-price-source', text: `来源：${priceSourceText(lp, source)}` }),
        priceTags(c.priceNotes).length ? el('span', { class: 'ms-fact-tags' }, priceTags(c.priceNotes)) : null,
      ]));
    } else {
      out.push(fact('标价', [el('span', { text: '价格表里没有这个型号' }), el('small', { text: '拆不出输入 / 输出单价；综合单价只能取本机日志里这个型号的实际费用。' })]));
    }
    if (c.costPerMTokens == null) return out;
    const m = c.priceMix, rows = [];
    if (m) {
      const total = m.fresh + m.cacheRead + m.cacheWrite + m.output;
      // 没有标价（价格表里没有这个型号）：只列 Token 结构，不编每一项的价格
      const unit = lp ? { fresh: lp.input, cacheRead: lp.cacheRead, cacheWrite: lp.cacheWrite > 0 ? lp.cacheWrite : lp.input, output: lp.output } : null;
      let recomputed = 0;
      const bar = el('div', { class: 'ms-mix-bar', 'aria-hidden': 'true' });
      for (const [k, label] of PARTS) {
        if (!m[k]) continue;
        const share = m[k] / total, part = unit ? share * unit[k] : 0;
        recomputed += part;
        bar.append(paint(el('i', { class: `ms-mix-${k}` }), { width: `${Math.max(.6, share * 100).toFixed(2)}%` }));
        rows.push(el('div', { class: 'ms-mix-row' }, [el('i', { class: `ms-mix-dot ms-mix-${k}` }), el('span', { text: label }), el('span', { class: 'ms-mix-share', text: `${(share * 100).toFixed(share < .001 ? 2 : 1)}%` }), unit ? el('span', { class: 'ms-mix-calc', text: `× ${price$(unit[k])} = ${price$(part)}` }) : el('span')]));
      }
      const from = { combo: `这个组合最近 30 天 ${number(m.requests)} 条请求的 Token 结构`, model: `同模型最近 30 天 ${number(m.requests)} 条请求的 Token 结构`, account: `本账号最近 30 天 ${number(m.requests)} 条请求的 Token 结构`, default: '本机还没有用量，用默认结构（大量缓存读、少量输出）', effort: `从 ${levelName(c.effortAnchor || '')} 档的实际 Token 结构出发，输出部分 ×${(c.effortRatio ?? 1).toFixed(2)}` }[m.basis];
      const actual = c.priceBasis === 'combo' || c.priceBasis === 'model';
      const differs = unit && actual && Math.abs(recomputed * 1 - c.costPerMTokens) / c.costPerMTokens > .02;
      out.push(fact('综合单价', [
        el('span', { class: 'ms-price-total', text: `${price$(c.costPerMTokens)} / 百万 Tokens` }),
        el('small', { text: actual ? '= 这些请求的实际费用合计 ÷ Tokens 合计' : '= 每一项占的比例 × 它的标价，加起来' }),
        bar,
        el('div', { class: 'ms-mix-rows' }, rows),
        el('small', { text: `比例来自${from}。` }),
        m.cacheRead / total >= .5 ? el('small', { class: 'ms-price-why', text: `为什么 Tokens 这么多：每次调用都会把整段对话重新读一遍，这部分命中缓存、按缓存读计价，也算在 Tokens 里（占 ${pct1(m.cacheRead / total)}）。真正新产生的内容（新输入 + 缓存写 + 输出）只占 ${pct1(1 - m.cacheRead / total)}。对话越长，重读的越多。` }) : null,
        differs ? el('small', { class: 'ms-price-warn', text: `按上面的标价重算是 ${price$(recomputed)}，和实际费用不一样：日志里有些请求带了客户端自报的费用，或者期间单价变过。` }) : null,
      ]));
    } else {
      out.push(fact('综合单价', [el('span', { class: 'ms-price-total', text: `${price$(c.costPerMTokens)} / 百万 Tokens` }), basis ? el('small', { text: `来自${basis}` }) : null]));
    }
    return out;
  }

  /* ---------------- 单价说明（0.3.13）：优惠价 / 标价不同 / 单价刚更新 ---------------- */

  const RECENT_DAYS = 14;
  const usd = n => '$' + (Math.round(n * 1000) / 1000);
  const recentChange = notes => {
    if (!notes?.changed) return false;
    const at = new Date(notes.changed.at + 'T00:00:00').getTime();
    return Number.isFinite(at) && Date.now() - at < RECENT_DAYS * DAY;
  };
  function priceTags(notes) {
    if (!notes) return [];
    return [
      notes.promo ? el('span', { class: 'ms-price-tag promo', text: '优惠价' }) : null,
      notes.dispute ? el('span', { class: 'ms-price-tag dispute', text: '标价不同' }) : null,
      recentChange(notes) ? el('span', { class: 'ms-price-tag changed', text: '单价刚更新' }) : null,
    ].filter(Boolean);
  }
  function priceNoteLines(notes) {
    if (!notes) return [];
    const p = notes.price, out = [];
    if (notes.promo) {
      out.push(`优惠价${notes.promo.until ? `（到 ${notes.promo.until}）` : '（结束时间未公布）'}：优惠结束后单价会变，美元估值会跟着变。`);
      if (notes.promo.note) out.push(notes.promo.note);
    }
    if (notes.dispute && p) out.push(`标价不同：LiteLLM ${usd(p.input)} / ${usd(p.output)}，OpenRouter ${usd(notes.dispute.openrouter.input)} / ${usd(notes.dispute.openrouter.output)}（每百万 token，输入 / 输出），按 LiteLLM 算。`);
    if (recentChange(notes) && p) {
      const q = notes.changed.previous, d = new Date(notes.changed.at + 'T00:00:00');
      out.push(`单价 ${d.getMonth() + 1}/${d.getDate()} 更新：${usd(q.input)} / ${usd(q.output)}（缓存读 ${usd(q.cacheRead)}）→ ${usd(p.input)} / ${usd(p.output)}（缓存读 ${usd(p.cacheRead)}）。这之前的美元估值按旧单价算，所以前后差别会比较大，Tokens 不受影响。`);
    }
    return out;
  }

  /* ---------------- 自己添加模型（0.3.12） ---------------- */

  const STUDY_FAMILY = { claude: /^claude/i, chatgpt: /^(gpt|codex|o\d)/i, grok: /^grok/i };
  const STANDARD_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  async function saveStudyModels(kind, next) {
    const prefs = await api.readPrefs();
    await api.writePrefs({ studyModels: { ...(prefs.studyModels || {}), [kind]: next } });
    cache.clear(); Q.loader.reset(); quotaUpdate(Q.snapshot, Q.report);
  }
  function removeButton(row) {
    const b = el('button', { type: 'button', class: 'ms-user-remove', 'aria-label': `从表格里移除 ${row.model}`, title: '从表格里移除' }, [icon('close')]);
    b.addEventListener('click', async e => {
      e.stopPropagation();
      const kind = Q.report?.kind; if (!kind) return;
      const prefs = await api.readPrefs();
      await saveStudyModels(kind, (prefs.studyModels?.[kind] || []).filter(m => m.model !== row.model));
      showStatus(`已移除 ${row.model}`);
    });
    return b;
  }
  async function openAddModels() {
    const kind = Q.report?.kind; if (!kind) return;
    let prefs, candidates;
    try { [prefs, candidates] = await Promise.all([api.readPrefs(), api.modelCandidates(kind)]); } catch { showStatus('候选型号读取失败，请重试。', true); return; }
    let mine = (prefs.studyModels?.[kind] || []).map(m => ({ model: m.model, efforts: [...m.efforts] }));
    const shown = new Set((Q.loader.view.data?.five.capacities || []).map(c => c.model));
    let picked = null, chosen = new Set();
    const last = document.activeElement;
    const search = el('input', { type: 'search', class: 'ms-add-search', placeholder: '搜索型号，或直接输入型号名…', 'aria-label': '搜索型号', autocomplete: 'off', spellcheck: 'false' });
    const list = el('div', { class: 'ms-add-list', role: 'listbox', 'aria-label': '候选型号' });
    const detailBox = el('div', { class: 'ms-add-detail' });
    const mineBox = el('div', { class: 'ms-add-mine' });
    const close = el('button', { type: 'button', class: 'icon-circle', 'aria-label': '关闭' }, [icon('close')]);
    const done = el('button', { type: 'button', class: 'btn btn-accent', text: '完成' });
    const card = el('section', { class: 'modal-card ms-add-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ms-add-title' }, [
      el('header', { class: 'ms-add-head' }, [el('div', {}, [el('h2', { id: 'ms-add-title', text: '添加模型到换算表' }), el('p', { text: '没用过也能按单价和思考等级消耗估算整窗大约能用多少。列表来自模型知识库（每天自动更新）；也可以直接输入型号名。' })]), close]),
      search, el('div', { class: 'ms-add-body' }, [list, detailBox]), mineBox,
      el('footer', { class: 'ms-add-foot' }, [done]),
    ]);
    const modal = el('div', { class: 'modal', id: 'ms-add' }, [card]);
    const price = c => c.input != null ? `$${c.input} / $${c.output}` : '未定价';
    const drawList = () => {
      const q = search.value.trim().toLowerCase();
      const rows = candidates.filter(c => !q || c.model.includes(q)).slice(0, 80);
      const exact = candidates.some(c => c.model === q);
      const items = rows.map(c => {
        const on = picked?.model === c.model;
        const b = el('button', { type: 'button', class: 'ms-add-item' + (on ? ' on' : ''), role: 'option', 'aria-selected': String(on), 'data-model': c.model }, [
          el('b', { text: c.model, translate: 'no' }), el('small', { text: price(c) }),
          c.usage ? el('span', { class: 'ms-add-tag', text: '有等级消耗数据' }) : null,
          shown.has(c.model) ? el('span', { class: 'ms-add-tag muted', text: '已在表里' }) : null,
        ]);
        b.addEventListener('click', () => pick(c));
        return b;
      });
      if (q && !exact && /^[a-z0-9][\w.:/@\[\]-]*$/i.test(q)) {
        const b = el('button', { type: 'button', class: 'ms-add-item custom', role: 'option', 'data-model': q }, [el('b', {}, ['自定义：', el('span', { text: q, translate: 'no' })]), el('small', { text: '知识库里没有的型号名' })]);
        b.addEventListener('click', () => pick({ model: q, input: null, output: null, efforts: [], usage: false, custom: true }));
        items.push(b); // 自定义放在最后：有真实候选时先看候选
      }
      list.replaceChildren(...(items.length ? items : [el('p', { class: 'ms-add-empty', text: '没有匹配的型号' })]));
    };
    const drawDetail = () => {
      if (!picked) { detailBox.replaceChildren(el('p', { class: 'ms-add-empty', text: '在左边选一个型号' })); return; }
      const efforts = (picked.efforts.length ? picked.efforts.filter(e => e !== 'not_supported') : STANDARD_EFFORTS).slice().sort((a, b) => levelRank(a) - levelRank(b));
      const chips = [...efforts, 'not_supported'].map(e => {
        const on = chosen.has(e);
        const b = el('button', { type: 'button', class: 'ms-chip' + (on ? ' on' : ''), 'aria-pressed': String(on), 'data-effort': e, text: e === 'not_supported' ? '不指定等级' : levelName(e), translate: e === 'not_supported' ? null : 'no' });
        b.addEventListener('click', () => { if (chosen.has(e)) chosen.delete(e); else chosen.add(e); drawDetail(); });
        return b;
      });
      const wrong = !STUDY_FAMILY[kind].test(picked.model);
      const add = el('button', { type: 'button', class: 'btn btn-accent', 'data-action': 'add-confirm', text: '添加到表格' });
      add.disabled = !chosen.size || wrong;
      add.addEventListener('click', async () => {
        const next = mine.filter(m => m.model !== picked.model).concat({ model: picked.model, efforts: [...chosen].sort((x, y) => levelRank(x) - levelRank(y)) });
        add.disabled = true;
        try { await saveStudyModels(kind, next); mine = next; shown.add(picked.model); showStatus(`已添加 ${picked.model}`); drawMine(); drawList(); }
        catch { showStatus('添加失败，请重试。', true); add.disabled = false; }
      });
      detailBox.replaceChildren(...[
        el('b', { class: 'ms-add-name', text: picked.model, translate: 'no' }),
        el('small', { text: `单价：${price(picked)}（每百万 token，输入 / 输出）${picked.usage ? ' · 有 Epoch AI 的思考等级消耗数据' : ''}` }),
        wrong ? el('p', { class: 'ms-add-warn', text: '这个型号不属于这一家，额度换算不会列出。' }) : null,
        el('div', { class: 'ms-add-label', text: '要列出的思考等级' }),
        el('div', { class: 'ms-chips' }, chips),
        add,
      ].filter(Boolean));
    };
    const drawMine = () => {
      mineBox.replaceChildren(el('div', { class: 'ms-add-label', text: mine.length ? `你添加的（${mine.length}）` : '你还没有添加模型' }), ...mine.map(m => {
        const x = el('button', { type: 'button', class: 'ms-user-remove', 'aria-label': `移除 ${m.model}` }, [icon('close')]);
        x.addEventListener('click', async () => { const next = mine.filter(n => n.model !== m.model); try { await saveStudyModels(kind, next); mine = next; shown.delete(m.model); drawMine(); drawList(); } catch { showStatus('移除失败，请重试。', true); } });
        return el('span', { class: 'ms-add-pill' }, [el('b', { text: m.model, translate: 'no' }), el('small', { text: m.efforts.map(e => e === 'not_supported' ? '不指定' : e).join(' · ') }), x]);
      }));
    };
    const pick = c => {
      picked = c;
      const existing = mine.find(m => m.model === c.model);
      const pool = c.efforts.length ? c.efforts.filter(e => e !== 'not_supported') : [];
      chosen = new Set(existing ? existing.efforts : pool.length ? pool : ['not_supported']);
      drawList(); drawDetail();
    };
    const finish = () => { document.removeEventListener('keydown', onKey, true); modal.remove(); document.querySelector('.workspace').inert = document.querySelector('.sidebar').inert = false; document.body.classList.remove('modal-open'); last?.focus?.(); };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); return; }
      if (e.key !== 'Tab') return;
      const controls = [...card.querySelectorAll('button:not(:disabled), input')].filter(n => n.offsetParent);
      if (e.shiftKey && document.activeElement === controls[0]) { e.preventDefault(); controls.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === controls.at(-1)) { e.preventDefault(); controls[0].focus(); }
    };
    search.addEventListener('input', drawList);
    close.addEventListener('click', finish); done.addEventListener('click', finish);
    modal.addEventListener('click', e => { if (e.target === modal) finish(); });
    document.addEventListener('keydown', onKey, true);
    document.querySelector('.workspace').inert = document.querySelector('.sidebar').inert = true;
    document.body.classList.add('modal-open');
    document.body.append(modal);
    drawList(); drawDetail(); drawMine();
    search.focus();
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

  /*
   * 0.3.9：本机以外的消耗。额度涨了、同期本机没有 Code 请求的时段自动标出来（「本机以外」轨道上的虚线块），
   * 用户点它补上用了什么模型、什么思考等级；标注过的时段不进容量折算，按容量表换算成等价 Token。
   * 时间线可以放大：拖动选一段 → 放大 / 标注；Ctrl + 滚轮以鼠标位置缩放；按钮缩放、回到整个周期。
   */
  const T = { host: null, loader: null, snapshot: null, accountId: '', cycles: { five: '', week: '' }, focus: '', width: 0, zoom: { five: null, week: null }, edit: null, stale: false, cards: {} };
  const MIN_SPAN = 5 * 60000;
  const SOURCES = [['chat', '网页 / App 聊天'], ['device', '其他电脑或设备'], ['other', '其他']];

  function timelineAccounts(snapshot) { return (snapshot?.accounts || []).filter(a => a.accountId && (a.five || a.week)); }
  function timelineUpdate(snapshot, preferred) {
    T.host ??= $('quota-model-timeline');
    if (!T.host) return;
    T.loader ??= loader(T.host, mode => drawTimeline(mode));
    if (!T.observer) { T.observer = new ResizeObserver(() => { const w = T.host.clientWidth; if (Math.abs(w - T.width) > 24 && T.loader.view.data) { T.width = w; for (const card of Object.values(T.cards)) card.redraw(false); } }); T.observer.observe(T.host); }
    T.snapshot = snapshot;
    const accounts = timelineAccounts(snapshot);
    const next = accounts.find(a => a.accountId === preferred)?.accountId || '';
    if (next !== T.accountId) { T.accountId = next; T.cycles = { five: '', week: '' }; T.focus = ''; T.zoom = { five: null, week: null }; T.edit = null; }
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
        el('p', { text: '每个模型 × 思考等级一条轨道，上方曲线是全账号官方额度已用百分比。额度涨了、同期本机没有 Code 请求的时段标在「本机以外」轨道上，可以补上用了什么模型。拖动选一段可放大或标注，Ctrl + 滚轮缩放。' })
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
    // 正在填标注的时候，定时刷新不能把表单冲掉：记下来，关掉编辑区后再画
    if (mode === 'update' && T.edit) { T.stale = true; return; }
    T.stale = false;
    T.width = host.clientWidth;
    const colors = colorMap(data);
    T.cards = {};
    const cards = WINDOWS.map(([w, label]) => (T.cards[w] = cycleCard(w, label, data[w], colors, data)));
    host.replaceChildren(...timelineHeading(), ...cards.map(c => c.node));
    for (const c of cards) c.redraw(mode === 'enter');
    applyFocus();
    const editing = host.querySelector('.ms-mark-editor');
    if (editing && mode !== 'update') editing.querySelector('select, input')?.focus({ preventScroll: true });
  }

  /** 颜色跟着模型走（两条时间线一致）：按周期里的用量从多到少分配色相，等级用深浅区分。 */
  function colorMap(data) {
    const total = new Map();
    for (const w of ['week', 'five']) for (const b of data[w].timeline) total.set(b.model, (total.get(b.model) || 0) + b.tokens);
    const models = [...total].sort((a, b) => b[1] - a[1]).map(([m]) => m);
    return model => { const i = models.indexOf(model); return i < 0 ? HUES.at(-1) : HUES[i % (HUES.length - 1)]; };
  }

  /** 当前显示的时间范围：放大过就是放大的那段，否则是整个周期。 */
  function viewOf(w, study) {
    const sel = study.selected, zoom = T.zoom[w];
    if (!sel) return null;
    const full = { from: sel.startAt, to: sel.endAt };
    if (!zoom) return full;
    return { from: Math.max(full.from, zoom.from), to: Math.min(full.to, zoom.to) };
  }
  function setZoom(w, study, from, to) {
    const sel = study.selected; if (!sel) return;
    const span = Math.max(MIN_SPAN, to - from), mid = (from + to) / 2;
    let a = mid - span / 2, b = mid + span / 2;
    if (a < sel.startAt) { b += sel.startAt - a; a = sel.startAt; }
    if (b > sel.endAt) { a -= b - sel.endAt; b = sel.endAt; }
    a = Math.max(sel.startAt, a);
    T.zoom[w] = b - a >= sel.endAt - sel.startAt - 1000 ? null : { from: a, to: b };
    T.cards[w]?.redraw(false);
  }
  function zoomBy(w, study, factor, center) {
    const view = viewOf(w, study); if (!view) return;
    const c = center ?? (view.from + view.to) / 2, span = (view.to - view.from) * factor;
    setZoom(w, study, c - (c - view.from) * factor, c - (c - view.from) * factor + span);
  }

  /** 时间线图例（0.3.13）：每种颜色、色块、竖条是什么，鼠标怎么用。放在周期标题旁的圆圈问号里。 */
  const LEGEND = [
    ['curve', '绿色折线：官方总池已用百分比（整个账号的，网页聊天、其他设备也算在里面）。'],
    ['uncertain', '灰色竖条：说不清来源的上涨。前后 5 分钟内本机有请求（多半是官方统计晚到）、采样隔得太久有缺口，或者刚发生还不到 5 分钟。不算本机以外，也不计入容量折算。'],
    ['offband', '橙色竖条：本机以外的上涨。额度涨了，前后 5 分钟本机都没有 Code 请求（网页聊天、其他设备）。不计入容量折算。'],
    ['detected', '「本机以外」轨道 · 虚线橙块：检测到的一段，待标注。'],
    ['pending', '虚线细框：你分割出来的一段，待标注。'],
    ['marked', '实心橙块：已标注用了什么模型和等级。'],
    ['ignored', '灰色、带删除线：你删除的一段，不算本机以外，点一下可以恢复。'],
    ['run', '模型轨道上的色块：本机的请求，颜色越深思考等级越高。轨道名下面写着「等级 · 用了多久 · 占周期多少」。'],
    ['now', '绿色竖虚线：现在。']
  ];
  function timelineHelp() {
    return infoTip([
      el('b', { text: '时间线怎么看' }),
      ...LEGEND.map(([kind, text]) => el('span', { class: 'ms-help-row' }, [el('i', { class: `ms-sw ${kind}`, 'aria-hidden': 'true' }), el('span', { text })])),
      el('b', { text: '鼠标' }),
      el('span', { text: '左键拖动左右平移（放大后）· 按住右键拖选一段（放大 / 标注）· Ctrl + 滚轮缩放 · 点色块、竖条看详情；点「本机以外」色块可以分割、删除、标注。' }),
    ], '时间线怎么看', 'ms-tl-help', 'help');
  }
  function cycleCard(w, label, study, colors, data) {
    const sel = study.selected, index = sel ? study.cycles.findIndex(c => c.id === sel.id) : -1;
    const combos = summarize(study);
    const step = delta => {
      const next = study.cycles[index + delta];
      if (!next) return;
      T.zoom[w] = null; if (T.edit?.w === w) T.edit = null;
      T.cycles = { ...T.cycles, [w]: index + delta === 0 ? '' : next.id }; reloadTimeline();
    };
    const older = el('button', { type: 'button', class: 'btn ms-step', 'aria-label': `上一个${label}周期`, title: `上一个${label}周期`, disabled: index < 0 || index >= study.cycles.length - 1 ? '' : null, text: '‹' });
    const newer = el('button', { type: 'button', class: 'btn ms-step', 'aria-label': `下一个${label}周期`, title: `下一个${label}周期`, disabled: index <= 0 ? '' : null, text: '›' });
    older.addEventListener('click', () => step(1)); newer.addEventListener('click', () => step(-1));
    const status = !sel ? null : sel.active ? ['进行中', 'good'] : ['已结束', 'muted'];
    const zoomBtn = (text, title, action) => { const b = el('button', { type: 'button', class: 'btn ms-zoom-btn', title, 'aria-label': title, text }); b.addEventListener('click', action); return b; };
    const zoomLabel = el('span', { class: 'ms-zoom-label', 'aria-live': 'polite' });
    const zoomOut = zoomBtn('−', `${label}时间线缩小`, () => zoomBy(w, study, 2));
    const zoomIn = zoomBtn('+', `${label}时间线放大`, () => zoomBy(w, study, .5));
    const zoomAll = zoomBtn('整个周期', `${label}时间线回到整个周期`, () => { T.zoom[w] = null; T.cards[w]?.redraw(false); });
    const zoom = sel ? el('div', { class: 'ms-zoom', role: 'group', 'aria-label': `${label}时间线缩放` }, [zoomLabel, zoomOut, zoomIn, zoomAll]) : null;
    const chart = el('div', { class: 'ms-tl', 'data-window': w });
    const node = el('article', { class: `ms-cycle ${w}`, 'data-window': w }, [
      el('div', { class: 'ms-cycle-head' }, [
        el('div', { class: 'ms-cycle-title' }, [el('i', { class: 'ms-dot' }), el('b', { text: `${label}周期` }),
          sel ? el('span', { class: 'ms-range', text: `${date(sel.startAt)} → ${date(sel.endAt)}` }) : null,
          status ? el('span', { class: `ms-badge ${status[1]}`, text: status[0] }) : null,
          sel?.resetCard ? el('span', { class: 'ms-badge warn', text: '重置卡分段' }) : null,
          sel ? timelineHelp() : null]),
        el('div', { class: 'ms-cycle-nav' }, [
          el('span', { class: 'ms-cycle-stats', text: sel ? `${number(combos.length)} 个组合 · ${tokens(study.totals.tokens)} Tokens · ${number(study.totals.calls)} 次调用 · 本机用了 ${durationText(activeTime(study.timeline))}（占周期 ${shareText(activeTime(study.timeline), sel.endAt - sel.startAt)}）` : '' }),
          older, el('span', { class: 'ms-cycle-pos', text: sel ? `${index + 1} / ${study.cycles.length}` : '—' }), newer
        ])
      ]),
      zoom,
      chart,
      T.pick?.w === w && sel ? offTools(w, study) : null,
      sel ? offMachineSummary(w, study, combos) : null,
      T.edit?.w === w && sel ? markEditor(w, study, data) : null,
      combos.length ? comboList(combos, study.totals.tokens, colors, study.query.kind, sel ? sel.endAt - sel.startAt : 0) : null,
      study.totals.unknownEffort ? el('p', { class: 'ms-note', text: `其中 ${number(study.totals.unknownEffort)} 条请求没记录思考等级（旧日志或客户端没写），单独放在「未记录等级」轨道。` }) : null
    ]);
    const redraw = animate => {
      const view = viewOf(w, study);
      if (view && sel) {
        const zoomed = Boolean(T.zoom[w]);
        zoomLabel.textContent = zoomed ? `显示 ${date(view.from)} – ${sameDay(view.from, view.to) ? hm(view.to) : date(view.to)}` : '整个周期';
        zoomAll.disabled = !zoomed; zoomOut.disabled = !zoomed; zoomIn.disabled = view.to - view.from <= MIN_SPAN + 1000;
      }
      drawLanes(chart, study, combos, colors, animate, w);
      applyFocus();
    };
    return { node, redraw };
  }
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

  /** 周期里出现过的组合，按用量从多到少。 */
  function summarize(study) {
    const map = new Map();
    for (const b of study.timeline) {
      const c = map.get(b.key) ?? { key: b.key, model: b.model, effort: b.effort, tokens: 0, calls: 0, count: 0, costUsd: 0, priced: true, bins: [] };
      c.tokens += b.tokens; c.calls += b.calls; c.count += b.count; if (b.costUsd == null) c.priced = false; else c.costUsd += b.costUsd; c.bins.push(b);
      map.set(b.key, c);
    }
    for (const c of map.values()) c.activeMs = activeTime(c.bins);
    return [...map.values()].sort((a, b) => (a.effort === 'unknown') - (b.effort === 'unknown') || b.tokens - a.tokens);
  }
  /*
   * 用了多久（0.3.13）：有请求的分钟格，间隔不超过 5 分钟的连成一段（中间在等模型、看输出也算在用），各段长度相加。
   * 占周期 = 用了多久 ÷ 整个周期的长度。
   */
  const ACTIVE_GAP = 5 * 60000;
  function activeTime(bins) {
    let total = 0, from = null, to = null;
    for (const b of [...bins].sort((x, y) => x.startAt - y.startAt)) {
      if (to != null && b.startAt - to <= ACTIVE_GAP) to = Math.max(to, b.endAt);
      else { if (to != null) total += to - from; from = b.startAt; to = b.endAt; }
    }
    return to != null ? total + (to - from) : 0;
  }
  function durationText(ms) {
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m} 分钟`;
    const h = Math.floor(m / 60), rest = m % 60;
    if (h < 24) return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
    const d = Math.floor(h / 24), hh = h % 24;
    return hh ? `${d} 天 ${hh} 小时` : `${d} 天`;
  }
  const shareText = (ms, span) => { const p = span > 0 ? ms / span * 100 : 0; return `${p < 10 ? p.toFixed(1) : p.toFixed(0)}%`; };
  /** 相邻的时间格连成一段：间隔按当前显示的范围定（整周看时 45 分钟以内算连续，放大后按比例缩小）。 */
  function runsOf(combo, binMs, span) {
    const gap = Math.max(binMs, Math.min(45 * 60000, span / 150)), runs = [];
    for (const b of [...combo.bins].sort((x, y) => x.startAt - y.startAt)) {
      const last = runs.at(-1);
      if (last && b.startAt - last.endAt <= gap) { last.endAt = b.endAt; last.lastAt = b.lastAt; last.tokens += b.tokens; last.calls += b.calls; last.count += b.count; last.costUsd = last.costUsd != null && b.costUsd != null ? last.costUsd + b.costUsd : null; }
      else runs.push({ startAt: b.startAt, endAt: b.endAt, firstAt: b.firstAt, lastAt: b.lastAt, tokens: b.tokens, calls: b.calls, count: b.count, costUsd: b.costUsd });
    }
    return runs;
  }
  const colorFor = (combo, colors) => combo.effort === 'unknown' ? 'var(--faint)' : colors(combo.model);
  const alphaFor = effort => STRENGTH[effort] ?? .8;
  /** 刻度：按显示范围挑一个步长，大约每 90 像素一格。 */
  const STEPS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880].map(m => m * 60000);
  function ticksFor(from, to, width) {
    const want = Math.max(2, Math.floor(width / 90)), step = STEPS.find(s => (to - from) / s <= want) ?? STEPS.at(-1);
    const first = new Date(from);
    if (step >= DAY) first.setHours(24, 0, 0, 0);
    else { first.setSeconds(0, 0); const m = first.getHours() * 60 + first.getMinutes(), s = step / 60000; first.setHours(0, Math.ceil((m + .001) / s) * s, 0, 0); }
    const out = [];
    for (let at = first.getTime(); at < to && out.length < 60; at += step) out.push(at);
    return { step, ticks: out };
  }
  function tickLabel(at, step) {
    const d = new Date(at);
    if (step >= DAY) return `${WEEKDAY[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
    if (d.getHours() === 0 && d.getMinutes() === 0) return `${d.getMonth() + 1}/${d.getDate()}`;
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  /** 某一时刻的官方已用（阶梯：取那一刻之前最后一次采样）。 */
  function pctAt(study, at) { let value = null; for (const p of study.track) { if (p.at > at) break; value = p.pct; } return value ?? study.track[0]?.pct ?? 0; }
  const growth = (study, from, to) => Math.max(0, pctAt(study, to) - pctAt(study, from));

  function drawLanes(host, study, combos, colors, animate, w) {
    host.replaceChildren();
    const sel = study.selected;
    if (!sel) { host.append(empty('这个账号没有这种窗口的官方周期记录。')); return; }
    const view = viewOf(w, study), start = view.from, end = view.to, span = Math.max(1, end - start);
    const off = study.offMachine || { detected: [], marks: [] };
    const hasOff = off.detected.length > 0 || off.marks.length > 0;
    const width = Math.max(560, host.clientWidth || 900), labelW = Math.min(230, Math.max(150, width * .24)), left = labelW + 14, right = width - 16;
    const bandTop = 10, bandH = 58, laneTop = bandTop + bandH + 26, laneH = 34, lanes = Math.max(1, combos.length) + (hasOff ? 1 : 0);
    const h = laneTop + lanes * laneH + 26;
    const x = at => left + (Math.min(end, Math.max(start, at)) - start) / span * (right - left);
    /*
     * 0.3.14：色块、竖条、曲线用 xs（不夹在视图边上，最多伸出一屏），再用 clipPath 裁掉绘图区外面的部分。
     * 以前用 x 夹在两边：平移时边上的色块被挤扁再弹开，看起来一抽一抽的。
     */
    const xs = at => left + (Math.min(end + span, Math.max(start - span, at)) - start) / span * (right - left);
    const inView = (a, b) => b > start && a < end;
    const node = svg('svg', { viewBox: `0 0 ${width} ${h}`, width, height: h, role: 'group', 'aria-label': '模型与思考等级时间线', class: 'ms-tl-svg' });
    const clipId = `ms-clip-${w}`;
    const defs = svg('defs'), clip = svg('clipPath', { id: clipId });
    clip.append(svg('rect', { x: left, y: 0, width: right - left, height: h }));
    defs.append(clip); node.append(defs);
    const plot = () => svg('g', { class: 'ms-plot', 'clip-path': `url(#${clipId})` });
    const toTime = clientX => { const box = node.getBoundingClientRect(); return start + ((clientX - box.left) * (width / box.width) - left) / (right - left) * span; };

    const { step, ticks } = ticksFor(start, end, right - left);
    for (const at of ticks) {
      const tx = x(at);
      node.append(svg('line', { class: 'ms-grid', x1: tx, x2: tx, y1: bandTop, y2: h - 22 }));
      const label = svg('text', { class: 'axis', x: tx, y: h - 6, 'text-anchor': 'middle' });
      label.textContent = tickLabel(at, step);
      node.append(label);
    }

    // 上方：采样区间里说不清的（缺口、刚发生还没下结论）灰色；本机以外的（可点）橙色
    const bands = plot(); node.append(bands);
    for (const interval of study.attribution?.intervals || []) {
      if (interval.kind === 'local_present' || !inView(interval.from, interval.to)) continue;
      const band = svg('rect', { x: xs(interval.from), y: bandTop, width: Math.max(2, xs(interval.to) - xs(interval.from)), height: bandH, class: 'ms-unmatched-band' + (interval.kind === 'unmatched' ? ' off' : ''), tabindex: 0, role: 'img', 'aria-label': interval.kind === 'unmatched' ? '本机以外的额度增长' : '说不清来源的额度增长' });
      tipOn(band, date(interval.from) + ' → ' + date(interval.to) + '\n官方增加 ' + interval.points.toFixed(2) + ' 个百分点\n' + (interval.kind === 'unmatched' ? '同期本机没有 Code 请求：算作本机以外的使用（聊天、其他设备），不计入容量折算。点下方「本机以外」轨道可以标注用了什么模型。' : '采样缺口或刚发生、还不能判断来源，不计入容量折算。'));
      bands.append(band);
    }
    const y = pct => bandTop + bandH - Math.min(100, Math.max(0, pct)) / 100 * bandH;
    for (const g of [0, 50, 100]) {
      node.append(svg('line', { class: 'ms-grid faint', x1: left, x2: right, y1: y(g), y2: y(g) }));
      const t = svg('text', { class: 'axis', x: left - 8, y: y(g) + 4, 'text-anchor': 'end' }); t.textContent = `${g}%`; node.append(t);
    }
    const bandLabel = svg('text', { class: 'ms-lane-name', x: 4, y: bandTop + bandH / 2 + 4 }); bandLabel.textContent = '官方总池已用'; node.append(bandLabel);
    // 官方已用的阶梯线：只取视图前后各一屏内的采样；从视图左边（或第一次采样）开始画
    const track = study.track.filter(p => p.at <= end + span);
    if (track.length) {
      const before = [...track].reverse().find(p => p.at <= start - span);
      const head = Math.max(start - span, track[0].at), tail = sel.active ? study.now : track.at(-1).at;
      if (tail > head) {
        const y0 = y(0).toFixed(1), x0 = xs(head).toFixed(1);
        let body = '';
        for (const p of track) if (p.at > head) body += ` H${xs(p.at).toFixed(1)} V${y(p.pct).toFixed(1)}`;
        body += ` H${xs(tail).toFixed(1)}`;
        const startY = y(before ? before.pct : track[0].pct).toFixed(1);
        // 面积从底边升起、沿着阶梯走、再落回底边（以前是连回线的起点，放大后起点高了，面积就被斜着切掉一大块）
        const curve = plot();
        const line = svg('path', { class: 'ms-quota-line', d: `M${x0},${startY}${body}` });
        // 描线动画只在第一次出现时用；动画结束就去掉虚线参数（留着的话放大到很细时线会被切掉）
        if (animate) { line.setAttribute('pathLength', '1'); line.setAttribute('stroke-dasharray', '1'); const plain = () => { line.removeAttribute('pathLength'); line.removeAttribute('stroke-dasharray'); }; line.addEventListener('animationend', plain, { once: true }); setTimeout(plain, 2000); }
        curve.append(svg('path', { class: 'ms-quota-area', d: `M${x0},${y0} V${startY}${body} V${y0} Z` }), line);
        if (tail >= start && tail <= end) curve.append(svg('circle', { class: 'ms-quota-dot', cx: xs(tail), cy: y(pctAt(study, tail)), r: 3.5 }));
        node.append(curve);
      }
    }

    // 「本机以外」轨道：检测到的（虚线，待标注）和用户标注的（实心，写着模型）
    let laneIndex = 0;
    if (hasOff) {
      const cy = laneTop + laneH / 2;
      const lane = svg('g', { class: 'ms-lane ms-off-lane' });
      const name = svg('text', { class: 'ms-lane-name', x: 4, y: cy - 2 }); name.textContent = '本机以外';
      const sub = svg('text', { class: 'ms-lane-level', x: 4, y: cy + 12 }); sub.textContent = '聊天 / 其他设备';
      const blocks = plot();
      lane.append(svg('rect', { class: 'ms-lane-bg', x: 0, y: cy - laneH / 2 + 2, width, height: laneH - 4, rx: 6 }), name, sub, svg('line', { class: 'ms-rail', x1: left, x2: right, y1: cy, y2: cy }), blocks);
      const block = (item, marked) => {
        if (!inView(item.from, item.to)) return;
        const bx = xs(item.from), bw = Math.max(8, xs(item.to) - bx);
        const state = !marked ? 'detected' : item.ignored ? 'ignored' : item.model ? 'marked' : 'pending';
        const picked = T.pick?.w === w && pickKey(T.pick.item) === pickKey(item);
        const rect = svg('rect', { class: `ms-off ${state}${picked ? ' picked' : ''}`, x: bx, y: cy - 9, width: bw, height: 18, rx: 4, tabindex: 0, role: 'button', 'data-off': marked ? item.id : `${item.from}-${item.to}` });
        const text = state === 'ignored' ? `${date(item.from)} – ${hm(item.to)}\n已删除：不算本机以外的使用\n点一下可以恢复`
          : state === 'pending' ? `${date(item.from)} – ${hm(item.to)}\n官方增加 ${item.points.toFixed(1)} 个百分点（你分割出来的一段）\n点一下标注、继续分割或删除`
          : marked
          ? `${date(item.from)} – ${hm(item.to)}\n${item.model} · ${levelName(item.effort)}（${SOURCES.find(s => s[0] === item.source)?.[1] || ''}）\n官方增加 ${item.points.toFixed(1)} 个百分点${item.equivalentTokens != null ? `\n≈ ${tokens(item.equivalentTokens)} Tokens` : ''}\n点一下修改`
          : `${date(item.from)} – ${hm(item.to)}\n官方增加 ${item.points.toFixed(1)} 个百分点，同期本机没有 Code 请求\n点一下标注用了什么模型`;
        rect.setAttribute('aria-label', text.replaceAll('\n', '，'));
        tipOn(rect, text);
        const open = () => pickOff(w, marked ? item : { from: item.from, to: item.to, points: item.points });
        rect.addEventListener('click', e => { e.stopPropagation(); if (host._dragged || T.split) return; open(); });
        rect.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
        blocks.append(rect);
        if (bw > 70) {
          const t = svg('text', { class: 'ms-off-text' + (marked ? ' marked' : ''), x: bx + 6, y: cy + 4 });
          t.textContent = state === 'marked' ? `${item.model} · ${levelName(item.effort)}` : state === 'ignored' ? '已删除' : `待标注 +${item.points.toFixed(1)}%`;
          if (state === 'marked') t.setAttribute('translate', 'no');
          if (state === 'ignored') t.classList.add('ignored');
          blocks.append(t);
        }
      };
      off.detected.forEach(item => block(item, false));
      off.marks.forEach(item => block(item, true));
      node.append(lane);
      laneIndex = 1;
    }

    // 各组合的轨道
    if (!combos.length) {
      const t = svg('text', { class: 'axis', x: (left + right) / 2, y: laneTop + laneIndex * laneH + laneH / 2 + 4, 'text-anchor': 'middle' });
      t.textContent = sel.active && study.cycles.length > 1 ? '这个周期里还没有本机官方请求，点右上角 ‹ 看上一个周期' : '这个周期里没有本机官方请求';
      node.append(t);
    }
    combos.forEach((combo, i) => {
      const cy = laneTop + (i + laneIndex) * laneH + laneH / 2, color = colorFor(combo, colors);
      const lane = svg('g', { class: 'ms-lane', 'data-key': combo.key });
      paint(lane, { '--i': i });
      const logo = brandSvg(META[study.query.kind].brand);
      for (const [k, val] of Object.entries({ x: 4, y: cy - 9, width: 18, height: 18, class: 'brand-svg ms-lane-logo' })) logo.setAttribute(k, val);
      const name = svg('text', { class: 'ms-lane-name', x: 30, y: cy - 2 }); name.textContent = combo.model.length > 22 ? combo.model.slice(0, 21) + '…' : combo.model;
      name.setAttribute('translate', 'no');
      const level = svg('text', { class: 'ms-lane-level', x: 30, y: cy + 12 }); level.textContent = `${levelName(combo.effort)} · ${durationText(combo.activeMs)} · ${shareText(combo.activeMs, sel.endAt - sel.startAt)}`;
      lane.append(svg('rect', { class: 'ms-lane-bg', x: 0, y: cy - laneH / 2 + 2, width, height: laneH - 4, rx: 6 }), logo, name, level, svg('line', { class: 'ms-rail', x1: left, x2: right, y1: cy, y2: cy }));
      const title = svg('title'); title.textContent = combo.model; name.append(title);
      const runs = plot(); lane.append(runs);
      for (const run of runsOf(combo, study.binMs, span)) {
        if (!inView(run.startAt, run.endAt)) continue;
        const rx = xs(run.startAt), rw = Math.max(5, xs(run.endAt) - rx);
        const rect = svg('rect', { class: 'ms-run', x: rx, y: cy - 7, width: rw, height: 14, rx: Math.min(4, rw / 2), tabindex: 0 });
        paint(rect, { fill: color, fillOpacity: alphaFor(combo.effort) });
        const text = `${combo.model} · ${levelName(combo.effort)}\n${date(run.firstAt)} – ${hm(run.lastAt)}\n${number(run.count)} 条请求 · ${number(run.calls)} 次调用 · ${tokens(run.tokens)} Tokens${run.costUsd != null ? ` · ${money(run.costUsd)}` : ''}`;
        rect.setAttribute('aria-label', text.replaceAll('\n', '，'));
        runs.append(tipOn(rect, text));
      }
      lane.addEventListener('click', () => { if (!host._dragged) { T.focus = T.focus === combo.key ? '' : combo.key; applyFocus(); } });
      node.append(lane);
    });

    if (sel.active && study.now < end && study.now > start) {
      const nx = x(study.now);
      node.append(svg('line', { class: 'ms-now', x1: nx, x2: nx, y1: bandTop, y2: h - 22 }));
      const side = nx > right - 30 ? ['end', nx - 5] : nx < left + 30 ? ['start', nx + 5] : ['middle', nx];
      const t = svg('text', { class: 'ms-now-label', x: side[1], y: laneTop - 8, 'text-anchor': side[0] }); t.textContent = '现在'; node.append(t);
    }

    // 悬停在上方曲线区：显示那一刻的官方已用
    const hit = svg('rect', { class: 'ms-hit', x: left, y: bandTop, width: right - left, height: bandH });
    hit.addEventListener('pointermove', e => { if (!host._dragging) tipAt(`${date(toTime(e.clientX))}\n官方额度已用 ${pctAt(study, toTime(e.clientX)).toFixed(0)}%`, e.clientX, e.clientY); });
    hit.addEventListener('pointerleave', hideTip);
    node.insertBefore(hit, node.querySelector('.ms-lane'));

    /*
     * 鼠标（0.3.13）：左键拖动 = 左右平移（放大后才有意义）；按住右键拖 = 选一段（放大 / 标注）；
     * 分割模式下左键点一下 = 在那里分割选中的那段。移动不到 5 像素当作点击（点轨道聚焦、点色块选中照旧）。
     */
    const selection = svg('rect', { class: 'ms-select', x: 0, y: bandTop, width: 0, height: h - 22 - bandTop, hidden: '' });
    node.append(selection);
    node.classList.toggle('pannable', Boolean(T.zoom[w]));
    node.addEventListener('contextmenu', e => e.preventDefault());
    const splitting = T.split && T.pick?.w === w ? T.pick.item : null;
    if (splitting) {
      node.classList.add('splitting');
      const guide = svg('line', { class: 'ms-split-line', x1: 0, x2: 0, y1: laneTop, y2: h - 22, hidden: '' });
      node.append(guide);
      const clampSplit = t => Math.min(splitting.to - 60000, Math.max(splitting.from + 60000, t));
      node.addEventListener('pointermove', e => { const t = clampSplit(toTime(e.clientX)); guide.removeAttribute('hidden'); guide.setAttribute('x1', String(x(t))); guide.setAttribute('x2', String(x(t))); tipAt(`在 ${date(t)} 分割`, e.clientX, e.clientY); });
      node.addEventListener('pointerleave', () => { guide.setAttribute('hidden', ''); hideTip(); });
      node.addEventListener('pointerdown', e => { if (e.button !== 0) return; e.preventDefault(); hideTip(); splitOff(w, study, clampSplit(toTime(e.clientX))); });
    }
    let drag = null;
    node.addEventListener('pointerdown', e => {
      if (splitting) return;
      const box = node.getBoundingClientRect(), px = (e.clientX - box.left) * (width / box.width);
      if (px < left || px > right) return;
      host.querySelector('.ms-select-actions')?.remove();
      if (e.button === 0) {
        // 左键：平移。重画会换掉整个 svg，所以在 window 上跟着鼠标
        if (!T.zoom[w]) return;
        const pan = { x0: e.clientX, view: viewOf(w, study), scale: span / (right - left) * (width / box.width), moved: false, frame: 0 };
        const move = ev => {
          const dx = ev.clientX - pan.x0;
          if (!pan.moved && Math.abs(dx) < 5) return;
          if (!pan.moved) { pan.moved = true; host._dragging = true; hideTip(); }
          pan.dx = dx;
          pan.frame ||= requestAnimationFrame(apply);
        };
        // 一帧最多重画一次；松手时把还没画的最后一步补上（窗口在后台时 requestAnimationFrame 不跑）
        const apply = () => { pan.frame = 0; setZoom(w, study, pan.view.from - pan.dx * pan.scale, pan.view.to - pan.dx * pan.scale); };
        const up = () => {
          window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
          if (pan.frame) { cancelAnimationFrame(pan.frame); apply(); }
          host._dragging = false;
          if (pan.moved) { host._dragged = true; setTimeout(() => { host._dragged = false; }, 0); }
        };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
        return;
      }
      if (e.button !== 2) return;
      drag = { x0: px, t0: toTime(e.clientX), id: e.pointerId, moved: false };
    });
    node.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const box = node.getBoundingClientRect(), px = Math.min(right, Math.max(left, (e.clientX - box.left) * (width / box.width)));
      if (!drag.moved && Math.abs(px - drag.x0) < 5) return;
      if (!drag.moved) { drag.moved = true; host._dragging = true; hideTip(); try { node.setPointerCapture(e.pointerId); } catch { /* 合成事件没有真实指针 */ } }
      selection.removeAttribute('hidden');
      selection.setAttribute('x', String(Math.min(px, drag.x0))); selection.setAttribute('width', String(Math.abs(px - drag.x0)));
      drag.t1 = toTime(e.clientX);
    });
    const finish = e => {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      const done = drag; drag = null; host._dragging = false;
      if (!done.moved) return;
      host._dragged = true; setTimeout(() => { host._dragged = false; }, 0);
      const from = Math.max(sel.startAt, Math.min(done.t0, done.t1)), to = Math.min(sel.endAt, Math.max(done.t0, done.t1));
      if (to - from < 60000) { selection.setAttribute('hidden', ''); return; }
      selectionActions(host, w, study, from, to, (x(from) + x(to)) / 2 / width, selection);
    };
    node.addEventListener('pointerup', finish);
    node.addEventListener('pointercancel', () => { drag = null; host._dragging = false; selection.setAttribute('hidden', ''); });
    // Ctrl + 滚轮：以鼠标位置为中心缩放（不按 Ctrl 的滚轮照常滚动页面）
    node.addEventListener('wheel', e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomBy(w, study, e.deltaY > 0 ? 1.5 : 1 / 1.5, Math.min(end, Math.max(start, toTime(e.clientX))));
    }, { passive: false });

    host.append(node);
    playChart(host, animate);
  }

  /** 拖选之后浮出的小工具条：放大到这段 / 标注为本机以外 / 取消。 */
  function selectionActions(host, w, study, from, to, center, selection) {
    host.querySelector('.ms-select-actions')?.remove();
    const bar = el('div', { class: 'ms-select-actions', role: 'group', 'aria-label': '所选时段' }, [
      el('span', { text: `${date(from)} – ${hm(to)} · 官方 +${growth(study, from, to).toFixed(1)}%` }),
    ]);
    const act = (text, fn, cls = 'btn') => { const b = el('button', { type: 'button', class: cls, text }); b.addEventListener('click', () => { bar.remove(); selection.setAttribute('hidden', ''); fn(); }); bar.append(b); return b; };
    const first = act('放大到这段', () => setZoom(w, study, from, to), 'btn btn-accent');
    act('标注为本机以外的使用', () => openEditor(w, study, { from, to }));
    act('取消', () => {});
    paint(bar, { left: `${Math.min(88, Math.max(12, center * 100)).toFixed(1)}%` });
    host.append(bar);
    first.focus({ preventScroll: true });
  }

  /* ---------------- 本机以外：汇总和标注 ---------------- */

  function offMachineSummary(w, study, combos) {
    const off = study.offMachine || { points: 0, markedPoints: 0, detected: [], marks: [] };
    const box = el('div', { class: 'ms-off-summary' });
    const manual = el('button', { type: 'button', class: 'btn ms-off-add', text: '手动标注一段' });
    manual.addEventListener('click', () => { const view = viewOf(w, study); const to = Math.min(view.to, study.now); openEditor(w, study, { from: Math.max(view.from, to - HOUR), to }); });
    const total = off.points + off.markedPoints;
    // 说明文字收进感叹号，常驻的只有结论（涨了多少、几段待标注）
    const head = el('div', { class: 'ms-off-head' }, [
      el('i', { class: 'ms-off-key', 'aria-hidden': 'true' }),
      el('p', {}, total > 0
        ? [el('b', { text: `本机以外 +${total.toFixed(1)}%` }), pendingCount(off) ? el('span', { class: 'ms-off-pending', text: `${pendingCount(off)} 段待标注` }) : null]
        : [el('span', { class: 'ms-off-none', text: '本机以外 · 未检测到' })]),
      infoTip(el('span', { text: total > 0
        ? '这些时段额度涨了、但同期本机没有 Code 请求（或你标注过在别处使用），不计入容量折算。点下面的时段可以标注用了什么模型。'
        : '这个周期里额度上涨时本机都有 Code 请求。在别处用过也可以手动标注。' }), '本机以外说明'),
      manual,
    ]);
    box.classList.toggle('empty', total <= 0 && !off.marks.length);
    box.append(head);
    const items = [...off.detected.map(d => ({ ...d, marked: false })), ...off.marks.filter(m => !m.ignored).map(m => ({ ...m, marked: true }))].sort((a, b) => a.from - b.from);
    if (items.length) {
      box.append(el('div', { class: 'ms-off-items' }, items.map(item => {
        const b = el('button', { type: 'button', class: 'ms-off-item' + (item.marked && item.model ? ' marked' : '') }, [
          el('span', { class: 'ms-off-time', text: `${date(item.from)} – ${sameDay(item.from, item.to) ? hm(item.to) : date(item.to)}` }),
          el('b', { text: item.marked && item.model ? `${item.model} · ${levelName(item.effort)}` : '待标注', translate: item.marked && item.model ? 'no' : null }),
          el('small', { text: `+${item.points.toFixed(1)}%${item.marked && item.equivalentTokens != null ? ` ≈ ${tokens(item.equivalentTokens)} Tokens` : ''}` }),
        ]);
        b.addEventListener('click', () => { setZoomAround(w, study, item.from, item.to); pickOff(w, item.marked ? item : { from: item.from, to: item.to, points: item.points }); });
        return b;
      })));
    }
    return box;
  }
  /* ---------------- 本机以外：像剪视频一样自己切（0.3.13） ---------------- */

  const pendingCount = off => off.detected.length + off.marks.filter(m => !m.ignored && !m.model).length;
  const pickKey = item => item.id || `${item.from}-${item.to}`;
  function pickOff(w, item) {
    T.pick = { w, item }; T.split = false; T.edit = null;
    drawTimeline('refresh');
  }
  function clearPick() { T.pick = null; T.split = false; drawTimeline(T.stale ? 'update' : 'refresh'); }
  async function offCall(study, payload, done) {
    try {
      await api.modelOffMachine({ kind: study.query.kind, accountId: study.query.accountId, ...payload });
      cache.clear(); Q.loader?.reset(); T.loader.reset();
      T.pick = null; T.split = false; T.edit = null;
      showStatus(done);
      reloadTimeline(); if (Q.report) quotaUpdate(Q.snapshot, Q.report);
    } catch (error) {
      showStatus(String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''), true);
    }
  }
  function splitOff(w, study, at) {
    const item = T.pick?.item; if (!item) return;
    offCall(study, { action: 'split', id: item.id || undefined, from: item.from, to: item.to, at }, `已在 ${hm(at)} 分割成两段`);
  }
  function offTools(w, study) {
    const item = T.pick.item, marked = Boolean(item.id), ignored = Boolean(item.ignored);
    const state = !marked ? '检测到的一段（待标注）' : ignored ? '已删除的一段' : item.model ? `${item.model} · ${levelName(item.effort)}` : '分割出来的一段（待标注）';
    const bar = el('div', { class: 'ms-off-tools', role: 'toolbar', 'aria-label': '本机以外：编辑这一段' }, [
      el('div', { class: 'ms-off-tools-info' }, [el('b', { text: `${date(item.from)} – ${sameDay(item.from, item.to) ? hm(item.to) : date(item.to)}` }), el('span', { text: state, translate: item.model ? 'no' : null })]),
    ]);
    const tool = (text, action, fn, cls = 'btn') => { const b = el('button', { type: 'button', class: cls, 'data-tool': action, text }); b.addEventListener('click', fn); bar.append(b); return b; };
    if (T.split) {
      const mid = item.from + (item.to - item.from) / 2;
      const input = el('input', { type: 'datetime-local', value: toInput(mid), 'aria-label': '分割时间', class: 'ms-split-time' });
      bar.append(el('span', { class: 'ms-off-tools-hint', text: '在时间线上点一下分割，或者填时间：' }), input);
      tool('在这里分割', 'split-confirm', () => {
        const at = fromInput(input.value);
        if (!(at > item.from && at < item.to)) { showStatus('分割点要在这一段中间。', true); return; }
        splitOff(w, study, at);
      }, 'btn btn-accent');
      tool('取消分割', 'split-cancel', () => { T.split = false; drawTimeline('refresh'); });
    } else if (ignored) {
      tool('恢复', 'restore', () => offCall(study, { action: 'restore', id: item.id }, '已恢复这一段'), 'btn btn-accent');
    } else {
      tool(item.model ? '修改标注' : '标注', 'label', () => { T.pick = null; openEditor(w, study, marked ? item : { from: item.from, to: item.to }); }, 'btn btn-accent');
      tool('分割', 'split', () => { T.split = true; drawTimeline('refresh'); });
      tool('删除', 'ignore', () => offCall(study, marked ? { action: 'ignore', id: item.id } : { action: 'ignore', from: item.from, to: item.to }, '已删除这一段（不算本机以外）；可以在时间线上点它恢复'));
      if (marked && item.model) tool('清除标注', 'unlabel', () => offCall(study, { action: 'delete', id: item.id }, '标注已清除'));
    }
    tool('完成', 'done', clearPick);
    bar.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); if (T.split) { T.split = false; drawTimeline('refresh'); } else clearPick(); } });
    return bar;
  }

  /** 打开编辑时顺便放大到那一段（两边各留一点，看得见前后的本机请求）。 */
  function setZoomAround(w, study, from, to) {
    const pad = Math.max(10 * 60000, (to - from) * .6);
    T.zoom[w] = null; setZoom(w, study, from - pad, to + pad);
  }
  function openEditor(w, study, item) {
    const models = summarize(study);
    T.edit = { w, id: item.id || '', from: item.from, to: item.to, model: item.model || models[0]?.model || '', effort: item.effort || 'unknown', source: item.source || 'chat', note: item.note || '' };
    drawTimeline('refresh');
    T.host.querySelector(`.ms-cycle[data-window="${w}"] .ms-mark-editor`)?.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  }
  function closeEditor() {
    T.edit = null;
    drawTimeline(T.stale ? 'update' : 'refresh');
  }
  const toInput = at => { const d = new Date(at); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  const fromInput = value => { const t = new Date(value).getTime(); return Number.isFinite(t) ? t : NaN; };

  function markEditor(w, study, data) {
    const e = T.edit, kind = study.query.kind;
    const catalog = (data.catalog || []).filter(c => c.model);
    const models = [...new Set([...summarize(study).map(c => c.model), ...catalog.map(c => c.model), ...(e.model ? [e.model] : [])])];
    const fromInputEl = el('input', { type: 'datetime-local', value: toInput(e.from), 'aria-label': '开始时间' });
    const toInputEl = el('input', { type: 'datetime-local', value: toInput(e.to), 'aria-label': '结束时间' });
    const source = el('select', { 'aria-label': '在哪里用的' }, SOURCES.map(([id, label]) => el('option', { value: id, text: label, selected: id === e.source ? '' : null })));
    const model = el('select', { 'aria-label': '用了什么模型' }, [...models.map(m => el('option', { value: m, text: m, selected: m === e.model ? '' : null })), el('option', { value: '__custom', text: '其他（自己填）' })]);
    model.setAttribute('translate', 'no');
    const custom = el('input', { type: 'text', placeholder: '模型名，例如 claude-opus-5', maxlength: '120', 'aria-label': '自己填写模型名', hidden: models.includes(e.model) || !e.model ? '' : null, value: models.includes(e.model) ? '' : e.model });
    const effort = el('select', { 'aria-label': '思考等级' });
    const note = el('input', { type: 'text', maxlength: '300', placeholder: '可选：例如「网页上让它改文档」', value: e.note, 'aria-label': '备注' });
    const info = el('p', { class: 'ms-mark-info', role: 'status' });
    const levelsFor = name => { const list = [...new Set(catalog.filter(c => c.model === name && c.effort && c.effort !== 'unknown').map(c => c.effort))].sort((a, b) => levelRank(a) - levelRank(b)); return list.length ? list : ['none', 'low', 'medium', 'high', 'xhigh', 'max']; };
    const syncEffort = () => {
      const name = model.value === '__custom' ? custom.value.trim() : model.value;
      const list = levelsFor(name);
      if (!list.includes(e.effort) && e.effort !== 'unknown') e.effort = 'unknown';
      effort.replaceChildren(el('option', { value: 'unknown', text: '不确定', selected: e.effort === 'unknown' ? '' : null }), ...list.map(l => el('option', { value: l, text: `${l}${LEVEL[l] ? `（${LEVEL[l]}）` : ''}`, selected: l === e.effort ? '' : null })));
    };
    const syncInfo = () => {
      const from = e.from, to = e.to;
      if (!(to > from)) { info.textContent = '结束时间要晚于开始时间。'; info.classList.add('bad'); return; }
      info.classList.remove('bad');
      const rise = growth(study, from, to);
      const cap = study.capacities.find(c => c.model === (model.value === '__custom' ? custom.value.trim() : model.value) && c.effort === e.effort && c.capacityTokens != null)
        ?? study.capacities.find(c => c.model === (model.value === '__custom' ? custom.value.trim() : model.value) && c.capacityTokens != null);
      info.textContent = `这段时间官方额度涨了 ${rise.toFixed(1)} 个百分点${cap ? `，按 ${cap.model} · ${levelName(cap.effort)} 的整窗容量约相当于 ${tokens(cap.capacityTokens * rise / 100)} Tokens` : ''}。保存后这段不计入容量折算。`;
    };
    model.addEventListener('change', () => { custom.hidden = model.value !== '__custom'; if (!custom.hidden) custom.focus(); e.model = model.value === '__custom' ? custom.value.trim() : model.value; syncEffort(); syncInfo(); });
    custom.addEventListener('input', () => { e.model = custom.value.trim(); syncEffort(); syncInfo(); });
    effort.addEventListener('change', () => { e.effort = effort.value; syncInfo(); });
    source.addEventListener('change', () => { e.source = source.value; });
    note.addEventListener('input', () => { e.note = note.value; });
    // 输入框只精确到分钟：用户改了哪个才用哪个，没改的保留检测到的精确时间（不然会把刚好在那一刻的涨幅切掉）
    fromInputEl.addEventListener('change', () => { e.from = fromInput(fromInputEl.value); syncInfo(); });
    toInputEl.addEventListener('change', () => { e.to = fromInput(toInputEl.value); syncInfo(); });
    syncEffort(); syncInfo();
    const save = el('button', { type: 'submit', class: 'btn btn-accent', text: '保存标注' });
    const cancel = el('button', { type: 'button', class: 'btn', text: '取消' });
    const remove = e.id ? el('button', { type: 'button', class: 'btn danger', text: '删除标注' }) : null;
    const form = el('form', { class: 'ms-mark-editor', 'aria-label': e.id ? '修改本机以外的使用' : '标注本机以外的使用' }, [
      el('div', { class: 'ms-mark-title' }, [el('b', { text: e.id ? '修改这段本机以外的使用' : '标注本机以外的使用' }), el('small', { text: '告诉 TokenPulse 这段时间在别处用了什么，容量折算会排除这段，并按你选的模型换算。' })]),
      el('div', { class: 'ms-mark-grid' }, [
        el('label', {}, [el('span', { text: '开始' }), fromInputEl]),
        el('label', {}, [el('span', { text: '结束' }), toInputEl]),
        el('label', {}, [el('span', { text: '在哪里用的' }), source]),
        el('label', { class: 'wide' }, [el('span', { text: '模型' }), model, custom]),
        el('label', {}, [el('span', { text: '思考等级' }), effort]),
        el('label', { class: 'wide' }, [el('span', { text: '备注' }), note]),
      ]),
      info,
      el('div', { class: 'ms-mark-actions' }, [remove, el('span', { class: 'grow' }), cancel, save].filter(Boolean)),
    ]);
    const call = async (payload, done) => {
      form.querySelectorAll('button, input, select').forEach(n => { n.disabled = true; });
      try {
        await api.modelOffMachine({ kind, accountId: study.query.accountId, ...payload });
        cache.clear(); Q.loader?.reset(); T.loader.reset();
        T.edit = null;
        showStatus(done);
        reloadTimeline(); if (Q.report) quotaUpdate(Q.snapshot, Q.report);
      } catch (error) {
        form.querySelectorAll('button, input, select').forEach(n => { n.disabled = false; });
        info.textContent = String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '');
        info.classList.add('bad');
      }
    };
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      const from = e.from, to = e.to, name = model.value === '__custom' ? custom.value.trim() : model.value;
      if (!(to > from)) { info.textContent = '结束时间要晚于开始时间。'; info.classList.add('bad'); return; }
      if (!name) { info.textContent = '请选择或填写用了什么模型。'; info.classList.add('bad'); (model.value === '__custom' ? custom : model).focus(); return; }
      call({ id: e.id || undefined, from, to, model: name, effort: effort.value, source: source.value, note: note.value.trim() }, e.id ? '标注已更新，容量已重新折算' : '已标注，这段不再计入容量折算');
    });
    cancel.addEventListener('click', closeEditor);
    remove?.addEventListener('click', () => call({ action: 'delete', id: e.id }, '标注已删除'));
    form.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.preventDefault(); closeEditor(); } });
    return form;
  }

  function comboList(combos, total, colors, kind, span) {
    const list = el('div', { class: 'ms-combos' }, combos.map(c => {
      const item = el('button', { type: 'button', class: 'ms-combo', 'data-key': c.key, 'aria-pressed': 'false' }, [
        paint(el('i', { class: 'ms-swatch' }), { background: colorFor(c, colors), opacity: alphaFor(c.effort) }),
        el('span', { class: 'ms-combo-name' }, [miniLogo(META[kind].source), el('b', { text: c.model, translate: 'no', title: c.model }), levelBadge(c.effort)]),
        el('span', { class: 'ms-combo-bar' }, [paint(el('i'), { width: `${Math.max(1, total ? c.tokens / total * 100 : 0).toFixed(2)}%`, background: colorFor(c, colors) })]),
        el('span', { class: 'ms-combo-num' }, [el('b', { text: tokens(c.tokens) }), el('small', { text: `${total ? (c.tokens / total * 100).toFixed(1) : '0'}% · ${number(c.calls)} 次${c.priced ? ` · ${money(c.costUsd)}` : ''}` })]),
        el('span', { class: 'ms-combo-time', title: '有请求的时间，相隔 5 分钟以内的连成一段' }, [el('b', { text: durationText(c.activeMs) }), el('small', { text: `占周期 ${shareText(c.activeMs, span)}` })])
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
    for (const n of host.querySelectorAll('.ms-lane[data-key], .ms-combo')) {
      const on = n.dataset.key === T.focus;
      n.classList.toggle('focused', on);
      if (n.classList.contains('ms-combo')) n.setAttribute('aria-pressed', String(on));
    }
  }

  window.PulseModelStudy = { quota: quotaUpdate, timeline: timelineUpdate };
})();
