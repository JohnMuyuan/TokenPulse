'use strict';
/*
 * 用量明细页的第 5 个子视图「按会话排行」（0.3.106）：
 * 按单次 Agent 对话汇总所选时间与筛选条件下的总 Tokens、参考费用、折合周额度、峰值上下文水位、
 * 上下文自动压缩次数与无人工介入连续自动调用步数，支持一键跳转到会话管理或只筛该会话的逐条请求。
 */
(() => {
  const SORTS = [
    ['tokens', 'Tokens'],
    ['cost', '费用'],
    ['quota', '额度'],
    ['context', '上下文'],
    ['auto', '连跑'],
    ['recent', '最近'],
  ];
  const PAGE = 15;
  const view = { sort: 'tokens', filter: '', limit: PAGE, key: '', page: null, loading: false, error: false, seq: 0, built: false, shown: false, warmed: false };
  const nodes = {};

  const paint = (node, props) => { for (const [k, v] of Object.entries(props)) k.startsWith('--') ? node.style.setProperty(k, v) : (node.style[k] = v); return node; };
  const pct = v => v >= 10 ? v.toFixed(1) + '%' : v >= 0.1 ? v.toFixed(1) + '%' : v > 0 ? '<0.1%' : '0%';
  const quotaPct = v => v >= 100 ? v.toFixed(0) + '%' : v >= 1 ? v.toFixed(1) + '%' : v >= 0.01 ? v.toFixed(2) + '%' : '<0.01%';
  const projName = cwd => cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd : '未记录项目';
  const shortSession = id => String(id || '').length > 14 ? String(id).slice(0, 8) + '…' : String(id || '—');
  const titleOf = s => s.title || `${projName(s.cwd)} · #${shortSession(s.session)}`;

  function visible() { return state.page === 'usage' && state.usageView === 'sessions'; }

  function load() {
    const query = requestQuery({ page: 0, pageSize: 1, sort: 'time', sessions: true });
    const key = JSON.stringify(query) + '|' + (current?.scannedAt || '');
    if (key === view.key) return;
    view.key = key; view.loading = true; view.error = false;
    const seq = ++view.seq;
    api.requests(query).then(page => {
      if (seq !== view.seq) return;
      view.loading = false;
      if (!page) { view.key = ''; if (visible()) draw(); return; }
      view.page = page;
      if (visible()) keepScroll(draw);
    }).catch(() => {
      if (seq !== view.seq) return;
      view.loading = false; view.error = true;
      if (visible()) draw();
    });
  }

  function sorted(sessions) {
    const q = view.filter.trim().toLowerCase();
    const list = sessions.filter(s => {
      if (!q) return true;
      const hay = [s.title, s.session, s.cwd, s.source, s.agentName, s.swarmTitle, s.subagentKind, ...(s.models || [])].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
    const by = {
      tokens: (a, b) => b.tokens - a.tokens || b.lastAt - a.lastAt,
      cost: (a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens,
      quota: (a, b) => (b.quota?.week || 0) - (a.quota?.week || 0) || b.tokens - a.tokens,
      context: (a, b) => b.peakInput - a.peakInput || b.tokens - a.tokens,
      auto: (a, b) => (b.maxAutoStep || 1) - (a.maxAutoStep || 1) || b.requests - a.requests || b.tokens - a.tokens,
      recent: (a, b) => b.lastAt - a.lastAt,
    }[view.sort] || ((a, b) => b.tokens - a.tokens);
    return list.sort(by);
  }

  function build(host) {
    nodes.summary = el('div', { class: 'pj-summary' });
    const search = el('input', { type: 'search', placeholder: '搜索会话标题、项目、型号或 ID…', autocomplete: 'off', 'aria-label': '搜索会话' });
    search.addEventListener('input', () => { view.filter = search.value; view.limit = PAGE; draw(); });
    const seg = el('div', { class: 'seg compact', role: 'group', 'aria-label': '会话排序' }, [
      el('span', { class: 'seg-thumb', 'aria-hidden': 'true' }),
      ...SORTS.map(([id, label]) => el('button', { type: 'button', 'data-sort': id, class: id === view.sort ? 'on' : '', 'aria-pressed': String(id === view.sort), text: label })),
    ]);
    seg.addEventListener('click', e => {
      const b = e.target.closest('[data-sort]'); if (!b || b.dataset.sort === view.sort) return;
      view.sort = b.dataset.sort; view.limit = PAGE;
      for (const x of seg.querySelectorAll('[data-sort]')) { const on = x.dataset.sort === view.sort; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); }
      syncSeg(seg); draw();
    });
    nodes.seg = seg;
    const tip = typeof infoTip === 'function'
      ? infoTip('按单个会话文件汇总当前时间与筛选范围内的请求。\n峰值上下文 = 该会话单次送入模型的最大输入 Token 数；连跑 = 用户发出一条指令后 Agent 无人工介入连续调用模型的最多步数（≥8 步标橙提醒）。', '按会话排行说明', '', 'help')
      : null;
    nodes.toolbar = el('div', { class: 'table-toolbar pj-toolbar' }, [
      el('label', { class: 'search-field' }, [icon('search'), el('span', { class: 'sr-only', text: '搜索会话' }), search]),
      el('div', { class: 'toolbar-group' }, [el('span', { class: 'pj-sort-label', text: '排序' }), seg, tip].filter(Boolean)),
    ]);
    nodes.tableWrap = el('div', { class: 'table-scroll sr-table-wrap', tabindex: '0', role: 'region', 'aria-label': '按会话排行' });
    nodes.tableWrap.addEventListener('click', onTableClick);
    nodes.more = el('div', { class: 'pj-more' });
    host.replaceChildren(nodes.summary, nodes.toolbar, nodes.tableWrap, nodes.more);
    view.built = true;
  }

  function onTableClick(e) {
    const jump = e.target.closest('[data-open-session]');
    if (jump) {
      window.PulseSessions?.open(jump.dataset.openSession);
      return;
    }
    const drill = e.target.closest('[data-filter-session]');
    if (drill && typeof window.filterRequestsBySession === 'function') {
      window.filterRequestsBySession(drill.dataset.filterSession, drill.dataset.sessionTitle || '');
    }
  }

  function summaryCell(glyph, label, value, note) {
    return el('div', { class: 'pj-stat' }, [
      el('span', { class: 'pj-stat-icon' }, [icon(glyph)]),
      el('div', {}, [el('small', { text: label }), el('b', { text: value }), el('span', { text: note })]),
    ]);
  }

  function retryButton() {
    const b = el('button', { type: 'button', class: 'btn', text: '重试' });
    b.addEventListener('click', () => { view.key = ''; load(); draw(); });
    return b;
  }

  function draw() {
    const host = $('view-sessions');
    if (!host) return;
    if (!view.built) build(host);
    host.toggleAttribute('aria-busy', view.loading);
    const page = view.page;
    if (!page) {
      nodes.summary.replaceChildren();
      nodes.tableWrap.replaceChildren(el('div', { class: view.error ? 'empty pj-error' : 'pj-skeleton' }, view.error ? [el('span', { text: '会话排行读取失败。' }), retryButton()] : [el('i'), el('i'), el('i')]));
      nodes.more.replaceChildren();
      if ($('session-rank-count')) $('session-rank-count').textContent = '';
      return;
    }
    const sessions = page.sessions || [];
    if (!view.warmed && !api.isDemo?.() && sessions.some(s => s.sessionKey && !s.title) && typeof api?.sessions === 'function') {
      view.warmed = true;
      api.sessions().then(() => { view.key = ''; if (visible()) load(); }).catch(() => {});
    }
    const list = sorted([...sessions]);
    if ($('session-rank-count')) $('session-rank-count').textContent = `${number(sessions.length)} 个会话`;

    const totalCalls = sessions.reduce((n, s) => n + s.requests, 0);
    const totalCost = sessions.reduce((n, s) => n + s.costUsd, 0);
    const peakSess = sessions.reduce((best, s) => (!best || s.peakInput > best.peakInput ? s : best), null);
    const maxAuto = sessions.reduce((m, s) => Math.max(m, s.maxAutoStep || 1), 0);
    const runawayCount = sessions.filter(s => (s.maxAutoStep || 1) >= 8).length;
    const weekQuota = sessions.reduce((n, s) => n + (s.quota?.week || 0), 0);
    const hasOfficial = sessions.some(s => (s.quota?.officialTokens || 0) > 0);

    const maxWatermark = sessions.reduce((m, s) => (s.contextLimit > 0 && s.peakInput > 0 ? Math.max(m, Math.min(100, Math.round(s.peakInput / s.contextLimit * 100))) : m), -1);
    nodes.summary.replaceChildren(
      summaryCell('sessions', '活跃会话', number(sessions.length), `${number(totalCalls)} 次模型调用`),
      summaryCell('tokens', '最高上下文峰值', peakSess ? tokens(peakSess.peakInput) : '—', maxWatermark >= 0 ? `最高水位 ${maxWatermark}%` : '单次最大输入 Tokens'),
      summaryCell('requests', '最长自动连跑', maxAuto ? `${number(maxAuto)} 步` : '—', runawayCount ? `${number(runawayCount)} 个会话出现 ≥8 步连跑` : '无 ≥8 步无人工暴走'),
      summaryCell('cost', '参考费用', money(totalCost), hasOfficial && weekQuota > 0 ? `折合周额度 ≈ ${quotaPct(weekQuota)}` : '所选范围合计'),
    );
    if (view.error) nodes.summary.append(el('div', { class: 'pj-stale', role: 'status' }, [el('span', { text: '刷新失败，显示的是上一次的结果。' }), retryButton()]));

    if (!list.length) {
      nodes.tableWrap.replaceChildren(el('div', { class: 'empty', text: sessions.length ? '没有匹配的会话。' : '这段时间、这些筛选条件下没有请求记录。' }));
      nodes.more.replaceChildren();
      syncSeg(nodes.seg);
      return;
    }

    const maxTokens = Math.max(...list.map(s => s.tokens)) || 1;
    const shown = list.slice(0, view.limit);
    const head = ['#', '会话 / 项目', '调用 / 连跑', '峰值上下文', '缓存命中率', 'Tokens', '周额度 / 费用', '操作'];
    const tbody = el('tbody', {}, shown.map((s, idx) => {
      const label = titleOf(s);
      const hitPct = s.input > 0 ? Math.min(100, (s.cacheRead / s.input) * 100) : null;
      const hitTone = hitPct == null ? 'is-empty' : hitPct >= 60 ? 'is-high' : hitPct >= 20 ? 'is-mid' : hitPct > 0 ? 'is-low' : 'is-zero';
      const ctxPct = s.contextLimit > 0 && s.peakInput > 0 ? Math.min(100, (s.peakInput / s.contextLimit) * 100) : null;
      const ctxTone = ctxPct == null ? '' : ctxPct >= 85 ? 'is-high' : ctxPct >= 65 ? 'is-warn' : 'is-ok';
      const auto = s.maxAutoStep || 1;
      const badges = [
        typeof subagentTagNode === 'function' ? subagentTagNode(s) : null,
        s.compactions > 0 ? el('span', { class: 'request-tag compact-tag', title: `该会话触发过 ${number(s.compactions)} 次上下文自动压缩`, text: `自动压缩 ×${number(s.compactions)}` }) : null,
      ].filter(Boolean);
      const modelBrief = (s.models || []).slice(0, 2).join(', ') + ((s.models?.length || 0) > 2 ? ` +${s.models.length - 2}` : '');
      const subMeta = [projName(s.cwd), modelBrief, date(s.lastAt)].filter(Boolean).join(' · ');

      return el('tr', { class: 'sr-row' }, [
        el('td', { class: 'insight-no', text: String(idx + 1) }),
        el('td', { class: 'sr-main-cell' }, [
          el('div', { class: 'sr-title-row' }, [
            miniLogo(s.source),
            el('b', { class: 'sr-title', translate: 'no', text: label, title: `${label}\n会话 ID：${s.session}${s.cwd ? `\n目录：${s.cwd}` : ''}` }),
            ...badges,
          ]),
          el('small', { class: 'sr-sub', translate: 'no', text: subMeta, title: subMeta }),
        ]),
        el('td', { class: 'n cache-cell' }, [
          el('span', { class: 'cache-read-val', text: `${number(s.requests)} 次` }),
          auto >= 2 ? el('small', { class: 'auto-step-sub' + (auto >= 8 ? ' is-warn' : ''), text: `最多连跑 ${number(auto)} 步` }) : null,
        ].filter(Boolean)),
        el('td', { class: 'n cache-cell', title: s.contextLimit ? `峰值输入 ${number(s.peakInput)} / 窗口 ${tokens(s.contextLimit)}` : `峰值输入 ${number(s.peakInput)}` }, [
          el('span', { class: 'cache-read-val' }, qty(s.peakInput)),
          ctxPct != null ? el('small', { class: `ctx-rate ${ctxTone}`, text: `水位 ${Math.round(ctxPct)}%` }) : null,
        ].filter(Boolean)),
        el('td', { class: 'n cache-cell', title: hitPct == null ? '无输入' : `缓存读取 ${number(s.cacheRead)} / 输入 ${number(s.input)}` }, [
          el('span', { class: 'cache-read-val' }, qty(s.cacheRead)),
          el('small', { class: `cache-hit-rate ${hitTone}`, text: hitPct == null ? '—' : `命中 ${pct(hitPct)}` }),
        ]),
        el('td', { class: 'n token-strong', title: number(s.tokens) }, [
          el('div', { class: 'sr-tok-wrap' }, [
            el('span', {}, qty(s.tokens)),
            el('div', { class: 'insight-bar small' }, [paint(el('i'), { width: `${Math.max(2, s.tokens / maxTokens * 100).toFixed(1)}%`, background: 'var(--accent)' })]),
          ]),
        ]),
        el('td', { class: 'n cache-cell' }, [
          el('span', { class: 'cache-read-val', text: s.priced ? money(s.costUsd) : '未定价' }),
          s.quota?.attributedTokens > 0 ? el('small', { class: 'sr-quota-sub', text: `≈ 周 ${quotaPct(s.quota.week)}` }) : null,
        ].filter(Boolean)),
        el('td', { class: 'sr-actions-cell' }, [
          el('div', { class: 'sr-actions' }, [
            s.sessionKey ? el('button', { type: 'button', class: 'btn sr-btn', 'data-open-session': s.sessionKey, title: '在会话管理中打开这段对话', text: '定位会话' }) : null,
            el('button', { type: 'button', class: 'btn sr-btn', 'data-filter-session': s.session, 'data-session-title': label, title: '切换到逐条请求并只看这个会话', text: '看请求' }),
          ].filter(Boolean)),
        ]),
      ]);
    }));

    nodes.tableWrap.replaceChildren(el('table', { class: 'sr-table' }, [
      el('thead', {}, [el('tr', {}, head.map((text, i) => el('th', { class: i >= 2 && i <= 6 ? 'n' : '', text })))]),
      tbody,
    ]));

    const rest = list.length - shown.length;
    const more = rest > 0 ? el('button', { type: 'button', class: 'btn', text: `显示更多（还有 ${number(rest)} 个）` }) : null;
    more?.addEventListener('click', () => { view.limit += PAGE; draw(); });
    nodes.more.replaceChildren(...(more ? [more] : []));
    syncSeg(nodes.seg);
  }

  function render() {
    if (!visible()) { view.shown = false; return; }
    if (!view.shown) view.shown = true;
    load();
    draw();
  }

  window.PulseUsageSessions = { render };
})();
