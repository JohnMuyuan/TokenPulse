'use strict';
/*
 * 用量明细页的「按项目」视图：每个项目文件夹被多少个 Agent 对话改过、花了多少 Token / 额度、
 * 这些 Token 由哪些「模型 × 思考等级」组成。
 *
 * 数据：和逐条请求同一套筛选（时间、工具、模型、项目、渠道、账号、核验、搜索），在 worker 里按工作目录汇总
 * （request-log.ts 的 projects）。项目按工作目录归并：Windows 路径不分大小写、去掉末尾斜杠；没记录目录的单独一组。
 * 额度：worker 按官方周额度采样分摊（request-log.ts 的 projectQuota）：额度涨了、同期本机有请求的区间，
 * 涨幅按各项目的 API 等价费用分给它们，跨几周累加成「周额度百分点」。同期本机没请求的涨幅不分；同期若在聊天会偏高。
 *
 * 依赖 app.js 的全局函数（el、icon、tokens、money、number、qty、cnApprox、miniLogo、sourceLogo、date、keepScroll、
 * requestQuery、requeryRequests、showUsageView、syncSeg、state、current、api、reducedMotion）。
 */
(() => {
  const HUES = ['#4f7fd9', '#d9774f', '#10a37f', '#8b5cf6', '#c9832f', '#e05a8a', '#0ea5a4', '#65a30d', '#7c8796'];
  const STRENGTH = { none: .42, minimal: .5, low: .6, medium: .74, high: .88, xhigh: 1, max: 1, ultra: 1 };
  const LEVEL = { none: '无推理', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '极限', adaptive: '自适应', auto: '自动', enabled: '已开启', disabled: '已关闭' };
  const SORTS = [['tokens', 'Tokens'], ['quota', '额度'], ['sessions', '对话数'], ['recent', '最近']];
  const PAGE = 12;
  const view = { sort: 'tokens', filter: '', open: new Set(), limit: PAGE, key: '', page: null, loading: false, error: false, seq: 0, built: false, animate: false };
  const nodes = {};

  const paint = (node, props) => { for (const [k, v] of Object.entries(props)) k.startsWith('--') ? node.style.setProperty(k, v) : (node.style[k] = v); return node; };
  const pct = v => v >= 10 ? v.toFixed(1) + '%' : v >= 0.1 ? v.toFixed(2) + '%' : v > 0 ? '<0.1%' : '0%';
  const quotaPct = v => v >= 100 ? v.toFixed(0) + '%' : v >= 1 ? v.toFixed(1) + '%' : v >= 0.01 ? v.toFixed(2) + '%' : '<0.01%';
  const nameOf = project => project.cwd ? project.cwd.split(/[\\/]/).filter(Boolean).pop() || project.cwd : '未记录项目';
  const levelName = effort => effort === 'unknown' ? '未记录等级' : effort;

  /* ---------------- 数据 ---------------- */

  function load() {
    const query = requestQuery({ page: 0, pageSize: 1, sort: 'time', projects: true });
    const key = JSON.stringify(query) + '|' + (current?.scannedAt || '');
    if (key === view.key) return;
    view.key = key; view.loading = true; view.error = false;
    const seq = ++view.seq;
    api.requests(query).then(page => {
      if (seq !== view.seq) return;
      view.page = page; view.loading = false;
      if (visible()) keepScroll(draw);
    }).catch(() => {
      if (seq !== view.seq) return;
      view.loading = false; view.error = true;
      if (visible()) draw();
    });
  }
  function visible() { return state.page === 'usage' && state.usageView === 'projects'; }

  /** covered：落在「额度涨了、同期有本机请求」区间里的官方用量；uncovered：没有同期采样可分摊的。 */
  function quotaOf(project) {
    const q = project.quota || { week: 0, officialTokens: 0, attributedTokens: 0 };
    return { week: q.week, covered: q.attributedTokens, uncovered: Math.max(0, q.officialTokens - q.attributedTokens), official: q.officialTokens };
  }

  /** 颜色跟着模型走：全部项目里用量最多的模型先分色，同一个模型在每个项目里颜色一致；等级用深浅区分。 */
  function colorMap(projects) {
    const total = new Map();
    for (const p of projects) for (const c of p.combos) total.set(c.model, (total.get(c.model) || 0) + c.tokens);
    const models = [...total].sort((a, b) => b[1] - a[1]).map(([m]) => m);
    return model => { const i = models.indexOf(model); return i < 0 ? HUES.at(-1) : HUES[i % (HUES.length - 1)]; };
  }
  const strength = effort => STRENGTH[effort] ?? .32;

  function sorted(projects) {
    const q = view.filter.trim().toLowerCase();
    const list = projects.filter(p => !q || (p.cwd || '未记录项目').toLowerCase().includes(q));
    const quota = new Map(list.map(p => [p.key, quotaOf(p).week]));
    const by = {
      tokens: (a, b) => b.tokens - a.tokens,
      quota: (a, b) => quota.get(b.key) - quota.get(a.key) || b.tokens - a.tokens,
      sessions: (a, b) => b.sessions - a.sessions || b.tokens - a.tokens,
      recent: (a, b) => b.lastAt - a.lastAt,
    }[view.sort];
    return list.sort(by);
  }

  /* ---------------- 骨架（只建一次，搜索框不因重画丢焦点） ---------------- */

  function build(host) {
    nodes.summary = el('div', { class: 'pj-summary' });
    const search = el('input', { type: 'search', placeholder: '搜索项目名或路径…', autocomplete: 'off', 'aria-label': '搜索项目' });
    search.addEventListener('input', () => { view.filter = search.value; view.limit = PAGE; draw(); });
    const seg = el('div', { class: 'seg compact', role: 'group', 'aria-label': '项目排序' }, [el('span', { class: 'seg-thumb', 'aria-hidden': 'true' }),
      ...SORTS.map(([id, label]) => el('button', { type: 'button', 'data-sort': id, class: id === view.sort ? 'on' : '', 'aria-pressed': String(id === view.sort), text: label }))]);
    seg.addEventListener('click', e => {
      const b = e.target.closest('[data-sort]'); if (!b || b.dataset.sort === view.sort) return;
      view.sort = b.dataset.sort; view.limit = PAGE;
      for (const x of seg.querySelectorAll('[data-sort]')) { const on = x.dataset.sort === view.sort; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); }
      syncSeg(seg); view.animate = !reducedMotion.matches; draw();
    });
    nodes.seg = seg;
    nodes.toolbar = el('div', { class: 'table-toolbar pj-toolbar' }, [
      el('label', { class: 'search-field' }, [icon('search'), el('span', { class: 'sr-only', text: '搜索项目' }), search]),
      el('div', { class: 'toolbar-group' }, [el('span', { class: 'pj-sort-label', text: '排序' }), seg])
    ]);
    nodes.list = el('div', { class: 'pj-list', role: 'list' });
    nodes.list.addEventListener('click', onListClick);
    nodes.more = el('div', { class: 'pj-more' });
    nodes.note = el('p', { class: 'pj-note', text: '一个对话 = 一个会话文件。周额度：官方周额度每次上涨时，按同一时段各项目的 API 等价费用分摊涨幅，跨几周累加；同一时段若也在聊天或用其他设备，会偏高。没有同期额度采样的用量不折算。「压缩」是 CLI 压缩上下文那一次调用，按上下文大小估算。' });
    host.replaceChildren(nodes.summary, nodes.toolbar, nodes.list, nodes.more, nodes.note);
    view.built = true;
  }

  function onListClick(e) {
    const drill = e.target.closest('[data-drill]');
    if (drill) {
      state.project = drill.dataset.drill;
      showUsageView('requests');
      requeryRequests();
      return;
    }
    const head = e.target.closest('.pj-head');
    if (!head) return;
    const card = head.closest('.pj-card'), key = card.dataset.key;
    if (view.open.has(key)) view.open.delete(key); else view.open.add(key);
    const projects = view.page?.projects || [];
    const project = projects.find(p => p.key === key);
    if (!project) return;
    const next = card_(project, Number(card.dataset.rank), totals(projects), colorMap(projects), true);
    card.replaceWith(next);
    next.querySelector('.pj-head').focus({ preventScroll: true });
  }

  /* ---------------- 画 ---------------- */

  function totals(projects) {
    return projects.reduce((t, p) => ({ tokens: t.tokens + p.tokens, sessions: t.sessions + p.sessions }), { tokens: 0, sessions: 0 });
  }

  function draw() {
    const host = $('view-projects');
    if (!host) return;
    if (!view.built) build(host);
    const page = view.page;
    host.toggleAttribute('aria-busy', view.loading);
    if (!page) {
      nodes.summary.replaceChildren();
      nodes.list.replaceChildren(el('div', { class: view.error ? 'empty pj-error' : 'pj-skeleton' }, view.error ? [el('span', { text: '项目汇总读取失败。' }), retryButton()] : [el('i'), el('i'), el('i')]));
      nodes.more.replaceChildren();
      $('project-count').textContent = '';
      return;
    }
    const projects = page.projects || [];
    const all = totals(projects);
    const list = sorted([...projects]);
    const colors = colorMap(projects);
    const quota = projects.reduce((t, p) => { const q = quotaOf(p); return { week: t.week + q.week, uncovered: t.uncovered + q.uncovered, official: t.official + q.official }; }, { week: 0, uncovered: 0, official: 0 });
    $('project-count').textContent = `${number(projects.length)} 个项目`;
    nodes.summary.replaceChildren(
      summaryCell('folder', '项目', number(projects.length), projects.some(p => !p.cwd) ? '含未记录目录的一组' : '按工作目录归并'),
      summaryCell('sessions', 'Agent 对话', number(all.sessions), `${number(projects.reduce((n, p) => n + p.records, 0))} 条请求记录`),
      summaryCell('tokens', 'Tokens', tokens(all.tokens), cnApprox(all.tokens) || '所选范围合计'),
      summaryCell('quota', '折合周额度', quota.official ? '≈ ' + quotaPct(quota.week) : '—', quota.official ? (quota.uncovered ? `${tokens(quota.uncovered)} Tokens 没有同期额度采样` : '按同期额度涨幅分摊') : '没有官方账号的用量')
    );
    if (view.error) nodes.summary.append(el('div', { class: 'pj-stale', role: 'status' }, [el('span', { text: '刷新失败，显示的是上一次的结果。' }), retryButton()]));
    const shownList = list.slice(0, view.limit);
    const animate = view.animate || entering();
    nodes.list.classList.toggle('chart-enter', animate);
    view.animate = false;
    // 入场播完就摘掉，免得展开某一张卡时整列跟着重播
    clearTimeout(view.enterTimer);
    if (animate) view.enterTimer = setTimeout(() => nodes.list.classList.remove('chart-enter'), 1400);
    nodes.list.replaceChildren(...(shownList.length
      ? shownList.map((p, i) => card_(p, i + 1, all, colors, false))
      : [el('div', { class: 'empty', text: projects.length ? '没有匹配的项目。' : '这段时间、这些筛选条件下没有请求记录。' })]));
    const rest = list.length - shownList.length;
    const more = rest > 0 ? el('button', { type: 'button', class: 'btn', text: `显示更多（还有 ${number(rest)} 个）` }) : null;
    more?.addEventListener('click', () => { view.limit += PAGE; draw(); });
    nodes.more.replaceChildren(...(more ? [more] : []));
    syncSeg(nodes.seg);
  }

  function retryButton() {
    const b = el('button', { type: 'button', class: 'btn', text: '重试' });
    b.addEventListener('click', () => { view.key = ''; load(); draw(); });
    return b;
  }

  function summaryCell(glyph, label, value, note) {
    return el('div', { class: 'pj-stat' }, [
      el('span', { class: 'pj-stat-icon' }, [icon(glyph)]),
      el('div', {}, [el('small', { text: label }), el('b', { text: value }), el('span', { text: note })])
    ]);
  }

  function mixBar(project, colors, cls = 'pj-mix') {
    const bar = el('div', { class: cls, role: 'img', 'aria-label': '模型与思考等级构成' });
    const top = project.combos.slice(0, 10), rest = project.combos.slice(10).reduce((n, c) => n + c.tokens, 0);
    for (const c of top) {
      if (!c.tokens) continue;
      const seg = el('i', { title: `${c.model} · ${levelName(c.effort)} · ${c.source}\n${number(c.tokens)} Tokens（${pct(c.tokens / project.tokens * 100)}）` });
      bar.append(paint(seg, { flexGrow: String(c.tokens), background: colors(c.model), opacity: String(strength(c.effort)) }));
    }
    if (rest) bar.append(paint(el('i', { class: 'rest', title: `其他 ${number(project.combos.length - 10)} 个组合 · ${number(rest)} Tokens` }), { flexGrow: String(rest) }));
    return bar;
  }

  function card_(project, rank, all, colors, animateOpen) {
    const open = view.open.has(project.key);
    const quota = quotaOf(project);
    const id = 'pj-detail-' + rank;
    const quotaText = quota.official ? (quota.covered ? `≈ 周额度 ${quotaPct(quota.week)}` : '额度无法折算') : '非官方账号';
    const head = el('button', { type: 'button', class: 'pj-head', 'aria-expanded': String(open), 'aria-controls': open ? id : null }, [
      el('span', { class: 'pj-rank', text: String(rank) }),
      el('span', { class: 'pj-folder' + (project.cwd ? '' : ' missing') }, [icon('folder')]),
      el('span', { class: 'pj-title' }, [
        el('b', { text: nameOf(project), translate: project.cwd ? 'no' : null, title: project.cwd || '会话里没有记下工作目录' }),
        el('small', { text: project.cwd || '会话里没有记下工作目录', translate: project.cwd ? 'no' : null, title: project.cwd || null })
      ]),
      el('span', { class: 'pj-agents' }, project.agents.map(a => el('span', { class: 'pj-agent', title: `${a.source} · ${number(a.sessions)} 个对话 · ${number(a.tokens)} Tokens` }, [miniLogo(a.source), el('b', { text: number(a.sessions) })]))),
      el('span', { class: 'pj-num' }, [
        el('strong', { title: number(project.tokens) + ' Tokens' }, [tokens(project.tokens), el('small', { text: ' Tokens' })]),
        el('small', { class: 'pj-quota' + (quota.covered ? '' : ' muted'), title: quota.official ? `官方账号用量 ${number(quota.official)} Tokens${quota.uncovered ? `，其中 ${number(quota.uncovered)} 没有同期额度采样` : ''}\n按同期官方周额度涨幅、按 API 等价费用分摊；同一时段也在聊天会偏高` : '这个项目的用量都走 API Key / 中转站，或者没对上账号' }, [quotaText, project.priced ? ` · ${money(project.costUsd)}` : ''])
      ]),
      icon('chevron', 'icon pj-chevron')
    ]);
    const meta = el('div', { class: 'pj-meta' }, [
      el('span', { text: `${number(project.sessions)} 个对话` }),
      el('span', { text: `${number(project.requests)} 次调用` }),
      el('span', { text: `占全部 ${pct(all.tokens ? project.tokens / all.tokens * 100 : 0)}` }),
      el('span', { text: `最近 ${date(project.lastAt)}` }),
      project.compaction.count ? el('span', { class: 'pj-compact', title: `CLI 压缩上下文 ${number(project.compaction.count)} 次，共约 ${number(project.compaction.tokens)} Tokens（按压缩前上下文大小估算，已计入上面的合计）` }, [`含压缩 ${number(project.compaction.count)} 次`]) : null
    ]);
    const card = el('article', { class: 'pj-card' + (open ? ' open' : ''), role: 'listitem', 'data-key': project.key, 'data-rank': rank }, [head, mixBar(project, colors), meta, open ? detail(project, colors, id, quota) : null]);
    paint(card, { '--i': String(Math.min(rank - 1, 12)) });
    if (open && animateOpen && !reducedMotion.matches) card.classList.add('opening');
    return card;
  }

  function detail(project, colors, id, quota) {
    const combos = el('section', { class: 'pj-combos' }, [
      el('h3', { text: '模型 × 思考等级' }),
      el('div', { class: 'table-scroll' }, [el('table', {}, [
        el('thead', {}, [el('tr', {}, [el('th', { text: '模型' }), el('th', { text: '思考等级' }), el('th', { text: '工具' }), el('th', { class: 'n', text: 'Tokens' }), el('th', { class: 'n', text: '占比' }), el('th', { class: 'n', text: '调用' }), el('th', { class: 'n', text: '参考费用' })])]),
        el('tbody', {}, project.combos.map(c => el('tr', {}, [
          el('td', {}, [el('span', { class: 'pj-model' }, [paint(el('i', { class: 'pj-dot' }), { background: colors(c.model), opacity: String(Math.max(.45, strength(c.effort))) }), el('b', { text: c.model, title: c.model, translate: 'no' })])]),
          el('td', {}, [el('span', { class: 'pj-level' + (c.effort === 'unknown' ? ' unknown' : ''), title: LEVEL[c.effort] || (c.effort === 'unknown' ? '日志没记录思考等级' : c.effort), text: levelName(c.effort) })]),
          el('td', {}, [el('span', { class: 'pj-tool' }, [miniLogo(c.source), c.source])]),
          el('td', { class: 'n', title: number(c.tokens) }, qty(c.tokens)),
          el('td', { class: 'n' }, [el('span', { class: 'pj-share' }, [el('span', { class: 'insight-bar small' }, [paint(el('i'), { width: (project.tokens ? c.tokens / project.tokens * 100 : 0) + '%', background: colors(c.model) })]), el('span', { text: pct(project.tokens ? c.tokens / project.tokens * 100 : 0) })])]),
          el('td', { class: 'n', text: number(c.requests) }),
          el('td', { class: 'n', text: c.priced ? money(c.costUsd) : '未定价' })
        ])))
      ])])
    ]);
    const agents = el('div', { class: 'pj-agent-list' }, project.agents.map(a => el('div', { class: 'pj-agent-row' }, [
      sourceLogo(a.source),
      el('div', {}, [el('b', { text: a.source }), el('small', { text: `${number(a.sessions)} 个对话 · ${number(a.requests)} 次调用` })]),
      el('span', { class: 'pj-agent-share' }, [el('b', { text: tokens(a.tokens) }), el('span', { class: 'insight-bar small' }, [paint(el('i'), { width: (project.tokens ? a.tokens / project.tokens * 100 : 0) + '%', background: 'var(--accent)' })])])
    ])));
    const breakdown = el('div', { class: 'pj-breakdown' }, [['输入（含缓存）', project.input], ['缓存读取', project.cacheRead], ['输出', project.output], ['推理', project.reasoning]].map(([label, value]) =>
      el('div', {}, [el('small', { text: label }), el('b', { title: number(value), text: tokens(value) })])));
    const side = el('section', { class: 'pj-side' }, [
      el('h3', { text: 'Agent 对话' }), agents,
      el('h3', { text: 'Token 构成' }), breakdown,
      el('p', { class: 'pj-range' }, [icon('clock'), `${date(project.firstAt, true)} → ${date(project.lastAt, true)}`]),
      quota.official ? el('p', { class: 'pj-range' }, [icon('quota'), quota.covered ? `折合周额度 ≈ ${quotaPct(quota.week)}${quota.uncovered ? `（另有 ${tokens(quota.uncovered)} Tokens 没有同期额度采样）` : ''}` : `官方账号用量 ${tokens(quota.official)} Tokens，没有同期额度采样`]) : null,
      project.compaction.count ? el('p', { class: 'pj-range' }, [icon('cache'), `压缩上下文 ${number(project.compaction.count)} 次 · 约 ${tokens(project.compaction.tokens)} Tokens（估算）`]) : null,
      el('button', { type: 'button', class: 'btn pj-drill', 'data-drill': project.cwd || '__missing__' }, ['查看这个项目的请求', icon('arrow')])
    ]);
    return el('div', { class: 'pj-detail', id }, [combos, side]);
  }

  /** 用量明细每次渲染时调用：不是「按项目」视图就只作废缓存键，切过来时再查。 */
  function render() {
    if (!visible()) { view.shown = false; return; }
    // 刚切到这个视图时播一次入场；之后每分钟的快照刷新不重播
    if (!view.shown) { view.shown = true; view.animate = !reducedMotion.matches; }
    load();
    draw();
  }

  window.PulseProjects = { render };
})();
