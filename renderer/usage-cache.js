'use strict';
/* 用量明细的缓存命中和断档分析；数据来自当前筛选匹配的完整请求流水。 */
(() => {
  const CAUSES = {
    compaction: ['压缩', '上下文压缩后继续请求，缓存需要重新建立。'],
    model: ['型号变化', '请求型号变化后，缓存不能跨型号复用。'],
    account: ['账号变化', '账号变化后，缓存不能跨账号复用；号池换号会让缓存失效。'],
    idle: ['空闲过久', '距上一次请求超过 5 分钟，缓存可能已过期。'],
    unknown: ['原因不明', '日志里没有足够线索判断缓存为什么失效。']
  };
  const KIND = { 'Claude Code': 'claude', 'Codex CLI': 'codex', 'Grok Build': 'grok', 'DeepSeek Harness': 'deepseek', pi: 'pi', Antigravity: 'antigravity' };
  const BUCKET_COLS = [
    ['lt1m', '<1 分钟'],
    ['1to3m', '1–3 分钟'],
    ['3to5m', '3–5 分钟'],
    ['5to10m', '5–10 分钟'],
    ['10to30m', '10–30 分钟'],
    ['gt30m', '>30 分钟'],
  ];
  const cacheView = { key: '', page: null, loading: false, error: false, seq: 0, built: false, ttlExpanded: false };
  const nodes = {};
  const paint = (node, props) => { for (const [key, value] of Object.entries(props)) key.startsWith('--') ? node.style.setProperty(key, value) : (node.style[key] = value); return node; };
  const pct = value => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
  const projectName = value => String(value || '未记录项目');
  const projectCell = value => el('td', { class: 'cc-project', text: projectName(value), translate: value ? 'no' : null });

  function load() {
    const query = requestQuery({ page: 0, pageSize: 1, sort: 'time', cache: true });
    const key = JSON.stringify(query) + '|' + (current?.scannedAt || '');
    if (key === cacheView.key) return;
    cacheView.key = key; cacheView.loading = true; cacheView.error = false;
    const seq = ++cacheView.seq;
    api.requests(query).then(page => {
      if (seq !== cacheView.seq) return;
      cacheView.page = page; cacheView.loading = false;
      if (visible()) keepScroll(draw);
    }).catch(() => {
      if (seq !== cacheView.seq) return;
      cacheView.loading = false; cacheView.error = true;
      if (visible()) draw();
    });
  }
  function visible() { return state.page === 'usage' && state.usageView === 'cache'; }

  function section(title, note, className) {
    const body = el('div', { class: className });
    const tip = note && typeof infoTip === 'function' ? infoTip(note, `${title}说明`, '', 'help') : null;
    return { body, node: el('section', { class: 'cc-section' }, [el('div', { class: 'cc-heading' }, [el('div', { class: 'panel-title-with-tip' }, [el('h3', { text: title }), tip].filter(Boolean))]), body]) };
  }
  function build(host) {
    nodes.summary = el('div', { class: 'cc-summary' });
    const chart = section('每天的缓存命中', '缓存读取 ÷ 输入（输入含缓存读写）。\nClaude 日志不区分 5 分钟/1 小时缓存；Grok 按轮记录；费用按参考标价估算，未知型号不计金额。', 'cc-chart');
    nodes.chart = chart.body;
    const ttl = section('各模型实测缓存持续时长', '统计同一会话、同一型号、未压缩且未换号的相邻大输入请求（≥4,096 Tokens），按两次请求的停顿间隔分桶计算缓存保住率（缓存读取 ≥ 上轮输入 50%），据此推算实测有效保活时长。', 'cc-ttl-host');
    nodes.ttl = ttl.body;
    const causes = section('断档原因', '每次断档按一条最可能的原因归类。', 'cc-causes');
    nodes.causes = causes.body;
    const split = el('div', { class: 'cc-split' });
    const tools = section('按工具', '', 'cc-table-host');
    const models = section('按型号', '', 'cc-table-host');
    split.append(tools.node, models.node);
    nodes.tools = tools.body; nodes.models = models.body;
    const sessions = section('断档最多的会话', '最多显示 10 个会话，按断档次数排序。', 'cc-table-host');
    nodes.sessions = sessions.body;
    const recent = section('最近的断档', '最近 20 次。项目只显示文件夹名，会话 ID 不显示。', 'cc-table-host');
    nodes.recent = recent.body;
    nodes.unpriced = el('p', { class: 'cc-note', hidden: true });
    host.replaceChildren(nodes.summary, chart.node, ttl.node, causes.node, split, sessions.node, recent.node, nodes.unpriced);
    cacheView.built = true;
  }

  function summaryCell(title, value, detail, tip) {
    const card = el('article', { class: 'cc-stat', title: tip || null }, [
      el('small', { text: title }),
      el('b', { class: 'cc-stat-value', text: value }),
      el('span', { text: detail })
    ]);
    if (tip) card.setAttribute('aria-label', title);
    return card;
  }
  function drawSummary(data) {
    nodes.summary.replaceChildren(
      summaryCell('命中率', pct(data.totals.hitRate), '缓存读取 ÷ 输入', '输入含缓存读取和写入。'),
      summaryCell('缓存净省下', `≈ ${money(data.totals.savingsUsd)}`, '参考标价估算', '按参考标价估算，已扣除缓存写入溢价。'),
      summaryCell('缓存断档', number(data.breaks.count), `多花 ≈ ${money(data.breaks.extraUsd)}`, '断档额外花费按当前型号参考标价估算。'),
      summaryCell('冷启动', number(data.coldStarts.count), `${number(data.coldStarts.tokens)} 缓存写入 Tokens`, `写入花费 ≈ ${money(data.coldStarts.costUsd)}`)
    );
    $('cache-count').textContent = `${number(data.breaks.count)} 次断档`;
  }

  function drawChart(host, daily) {
    host.replaceChildren();
    if (!daily.length) { host.dataset.drawnWidth = ''; host.append(el('div', { class: 'empty', text: '这段时间、这些筛选条件下没有请求记录。' })); return; }
    const measured = Math.round(host.clientWidth);
    host.dataset.drawnWidth = String(measured);
    const width = Math.max(360, measured || Math.round(host.parentElement?.clientWidth || 0) || 800), height = 260, left = 52, right = 38, top = 14, bottom = 34;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const slot = plotWidth / daily.length, bar = Math.max(3, Math.min(28, slot * 0.58));
    const maxInput = Math.max(1, ...daily.map(row => row.input));
    const xAt = i => left + slot * (i + 0.5);
    const yRate = rate => top + plotHeight * (1 - (rate || 0));
    const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': '每天的缓存命中率和输入构成' });
    for (const step of [0, .5, 1]) {
      const y = top + plotHeight * step;
      chart.append(svg('line', { class: 'cc-grid', x1: left, x2: width - right, y1: y, y2: y }));
      const tokensLabel = svg('text', { class: 'cc-axis', x: left - 7, y: y + 4, 'text-anchor': 'end' });
      tokensLabel.textContent = number(maxInput * (1 - step)); chart.append(tokensLabel);
      const rateLabel = svg('text', { class: 'cc-axis', x: width - right + 7, y: y + 4, 'text-anchor': 'start' });
      rateLabel.textContent = `${Math.round((1 - step) * 100)}%`; chart.append(rateLabel);
    }
    const line = [];
    const every = Math.max(1, Math.ceil(daily.length / Math.floor(plotWidth / 64)));
    daily.forEach((row, index) => {
      const x = xAt(index), barX = x - bar / 2;
      let y = top + plotHeight;
      const pieces = [
        ['fresh', Math.max(0, row.input - row.cacheRead - row.cacheWrite), '全新输入'],
        ['write', row.cacheWrite, '缓存写入'],
        ['read', row.cacheRead, '缓存读取']
      ];
      for (const [kind, value, label] of pieces) {
        if (!value) continue;
        const h = plotHeight * value / maxInput;
        y -= h;
        chart.append(svg('rect', { class: `cc-bar cc-${kind}`, x: barX, y, width: bar, height: Math.max(.5, h) }));
      }
      const rate = row.hitRate == null ? 0 : row.hitRate;
      line.push([x, yRate(rate)]);
      if (index % every === 0 || index === daily.length - 1) {
        const label = svg('text', { class: 'cc-axis', x, y: height - 9, 'text-anchor': 'middle' });
        label.textContent = row.day.slice(5); chart.append(label);
      }
      const tip = `${row.day}\n命中率：${pct(row.hitRate)}\n输入：${number(row.input)} Tokens\n全新输入：${number(Math.max(0, row.input - row.cacheRead - row.cacheWrite))} Tokens\n缓存写入：${number(row.cacheWrite)} Tokens\n缓存读取：${number(row.cacheRead)} Tokens`;
      const hit = svg('rect', { class: 'cc-hit', x: left + index * slot, y: top, width: slot, height: plotHeight, tabindex: 0, 'aria-label': tip });
      hit.addEventListener('pointermove', event => tipAt(tip, event.clientX, event.clientY));
      hit.addEventListener('pointerleave', () => { $('tip').hidden = true; });
      hit.addEventListener('focus', () => { const box = hit.getBoundingClientRect(); tipAt(tip, box.x + box.width / 2, box.y); });
      hit.addEventListener('blur', () => { $('tip').hidden = true; });
      chart.append(hit);
    });
    const path = line.map(([x, y], index) => `${index ? 'L' : 'M'}${x},${y}`).join(' ');
    chart.append(svg('path', { class: 'cc-line', d: path }));
    line.forEach(([x, y]) => chart.append(svg('circle', { class: 'cc-point', cx: x, cy: y, r: daily.length === 1 ? 4 : 2.5 })));
    host.append(chart, el('div', { class: 'cc-legend' }, [
      legendItem('cc-fresh', '全新输入'), legendItem('cc-write', '缓存写入'), legendItem('cc-read', '缓存读取'), legendItem('cc-line-key', '命中率')
    ]));
    window.watchChartHost?.(host, () => drawChart(host, daily));
    if (!measured) requestAnimationFrame(() => {
      if (host.isConnected && Math.round(host.clientWidth) > 0 && Number(host.dataset.drawnWidth || 0) === 0) drawChart(host, daily);
    });
  }
  function legendItem(cls, text) { return el('span', { class: 'cc-legend-item' }, [el('i', { class: cls }), el('span', { text })]); }

  function drawCauses(host, data) {
    host.replaceChildren();
    const max = Math.max(1, ...Object.values(data.breaks.byCause).map(row => row.count));
    for (const key of Object.keys(CAUSES)) {
      const info = data.breaks.byCause[key], [title, description] = CAUSES[key];
      const bar = el('i', { class: 'cc-cause-bar' });
      paint(bar, { width: `${Math.max(info.count ? 2 : 0, info.count / max * 100)}%` });
      host.append(el('article', { class: 'cc-cause-row' }, [
        el('div', { class: 'cc-cause-copy' }, [el('b', { text: title }), el('p', { text: description })]),
        el('div', { class: 'cc-cause-track', role: 'img', 'aria-label': title }, [bar]),
        el('div', { class: 'cc-cause-metrics' }, [
          metric(info.count, '次'), metric(info.lostTokens, 'Tokens'), metric(info.extraUsd, 'USD', true)
        ])
      ]));
    }
  }
  function metric(value, label, usd = false) {
    return el('span', {}, [el('b', { text: usd ? money(value) : number(value) }), el('small', { text: label })]);
  }

  function ttlDurationText(ms) {
    if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
    if (ms < 10 * 60_000) return `${(ms / 60_000).toFixed(1).replace(/\.0$/, '')} 分钟`;
    if (ms < 120 * 60_000) return `${Math.round(ms / 60_000)} 分钟`;
    return `${(ms / 3_600_000).toFixed(1).replace(/\.0$/, '')} 小时`;
  }
  function ttlBadgeInfo(row) {
    if (row.status === 'insufficient') return { text: '样本不足', tone: 'is-muted', tip: '样本少于 3 次，暂不推断保活上限' };
    if (row.status === 'no-cache') return { text: '未见缓存', tone: 'is-muted', tip: '所有连续请求均未观测到缓存命中' };
    if (row.status === 'short-gaps-only') return { text: '仅短间隔', tone: 'is-mid', tip: '目前只有 1 分钟内的密集调用（均已命中），尚缺更长停顿样本来探测过期边界' };
    if (row.status === 'volatile') return { text: '< 1 分钟', tone: 'is-short', tip: '1 分钟内的连续请求已过半掉缓存，缓存极不稳定' };
    if (row.status === 'at-least') {
      const dur = ttlDurationText(row.ttlMinMs || row.maxHitGapMs || 60_000);
      return { text: `≥ ${dur}`, tone: 'is-long', tip: `实测停顿至 ${dur} 仍可保住缓存，尚未测到失效上限` };
    }
    const lo = Math.max(1, Math.round((row.ttlMinMs || 60_000) / 60_000));
    const hi = Math.max(lo, Math.round((row.ttlMaxMs || row.ttlMinMs || 60_000) / 60_000));
    const span = lo === hi ? `${lo} 分钟` : `${lo}–${hi} 分钟`;
    const tone = hi <= 4 ? 'is-short' : lo >= 12 ? 'is-long' : 'is-mid';
    return { text: `≈ ${span}`, tone, tip: `实测在 ${span} 附近开始明显过期失效` };
  }
  function drawRetention(host, list) {
    host.replaceChildren();
    const rows = Array.isArray(list) ? list : [];
    if (!rows.length) {
      host.append(el('div', { class: 'empty', text: '暂时没有满足同会话连续大输入条件（≥4,096 Tokens）的样本，继续正常使用后会自动生成各模型的实测保活曲线。' }));
      return;
    }
    const MAX_DEFAULT = 8;
    const shown = cacheView.ttlExpanded ? rows : rows.slice(0, MAX_DEFAULT);
    const head = el('thead', {}, [el('tr', {}, [
      el('th', { text: '型号' }),
      el('th', { class: 'n', text: '实测保活' }),
      el('th', { class: 'n', text: '续接样本' }),
      ...BUCKET_COLS.map(([, label]) => el('th', { class: 'n', text: label })),
    ])]);
    const body = el('tbody', {}, shown.map(row => {
      const badge = ttlBadgeInfo(row);
      const byId = new Map((row.buckets || []).map(b => [b.id, b]));
      const srcNote = (row.sources || []).join(' · ') || row.source;
      return el('tr', {}, [
        el('th', { scope: 'row', class: 'cc-ttl-rowhead' }, [
          el('div', { class: 'cc-ttl-model' }, [
            typeof miniLogo === 'function' ? miniLogo(row.source) : null,
            el('div', { class: 'cc-ttl-model-copy' }, [
              el('b', { translate: 'no', text: row.model, title: row.model }),
              srcNote ? el('small', { text: srcNote }) : null,
            ].filter(Boolean)),
          ].filter(Boolean)),
        ]),
        el('td', { class: 'n cc-ttl-est' }, [
          el('div', { class: 'cc-ttl-badges' }, [
            el('span', { class: `cc-ttl-badge ${badge.tone}`, title: badge.tip, text: badge.text }),
            row.opportunistic ? el('span', { class: 'cc-ttl-flag', title: '5 分钟内短停顿已出现较高掉缓存比例，属于机会性隐式缓存', text: '短效易掉' }) : null,
          ].filter(Boolean)),
        ]),
        el('td', { class: 'n cc-ttl-samples' }, [
          el('span', { text: `${number(row.samples)} 次` }),
          row.maxHitGapMs != null ? el('small', { class: 'cc-ttl-sub', text: `最长保活 ${ttlDurationText(row.maxHitGapMs)}` }) : null,
        ].filter(Boolean)),
        ...BUCKET_COLS.map(([id, label]) => {
          const b = byId.get(id);
          if (!b || !b.total) return el('td', { class: 'n cc-ttl-cell is-empty', text: '—' });
          const ratePct = Math.round((b.keepRate || 0) * 100);
          const tone = ratePct >= 75 ? 'is-high' : ratePct >= 40 ? 'is-mid' : 'is-low';
          const tip = `间隔 ${label}：保住 ${number(b.hits)} / ${number(b.total)} 次（${ratePct}%）`;
          return el('td', { class: 'n cc-ttl-cell', title: tip }, [
            el('span', { class: `cc-ttl-pill ${tone}`, translate: 'no', text: `${ratePct}%` }),
            el('small', { class: 'cc-ttl-count', translate: 'no', text: `${b.hits}/${b.total}` }),
          ]);
        }),
      ]);
    }));
    const wrap = el('div', { class: 'table-scroll cc-ttl-wrap', tabindex: '0', role: 'region', 'aria-label': '各模型实测缓存持续时长' }, [
      el('table', { class: 'cc-ttl-table' }, [head, body]),
    ]);
    host.append(wrap);
    if (rows.length > MAX_DEFAULT) {
      const toggle = el('button', {
        type: 'button',
        class: 'text-btn cc-ttl-toggle',
        text: cacheView.ttlExpanded ? `收起（共 ${number(rows.length)} 个型号）` : `展开全部 ${number(rows.length)} 个型号`,
      });
      toggle.addEventListener('click', () => { cacheView.ttlExpanded = !cacheView.ttlExpanded; drawRetention(nodes.ttl, rows); });
      host.append(toggle);
    }
  }

  function table(host, headers, rows, emptyText) {
    host.replaceChildren();
    if (!rows.length) { host.append(el('div', { class: 'empty', text: emptyText })); return; }
    const head = el('thead', {}, [el('tr', {}, headers.map(header => el('th', { class: header.right ? 'n' : null, text: header.label })))]);
    const body = el('tbody', {}, rows);
    host.append(el('div', { class: 'table-scroll cc-scroll' }, [el('table', {}, [head, body])]));
  }
  function sourceModelTable(host, rows, key) {
    table(host, [{ label: key === 'source' ? '工具' : '型号' }, { label: '命中率', right: true }, { label: '缓存读取', right: true }, { label: '缓存写入', right: true }, { label: '省下', right: true }], rows.map(row => el('tr', {}, [
      el('td', { class: key === 'model' ? 'cc-model' : '', text: row[key], translate: key === 'model' ? 'no' : null }),
      cell(pct(row.hitRate)), cell(number(row.cacheRead)), cell(number(row.cacheWrite)), cell(money(row.savingsUsd))
    ])), '这段时间没有请求记录。');
  }
  function cell(text) { return el('td', { class: 'n', text }); }
  /** 间隔：两小时内按分钟，两天内按小时，再长写成「几天几小时」。 */
  function gapText(ms) {
    const minutes = Math.max(0, Math.round(ms / 60000)), hours = Math.floor(minutes / 60);
    if (minutes < 120) return `${minutes} 分钟`;
    return hours < 48 ? `${hours} 小时` : `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
  }
  function drawTables(data) {
    sourceModelTable(nodes.tools, data.bySource, 'source');
    sourceModelTable(nodes.models, data.byModel, 'model');
    table(nodes.sessions,
      [{ label: '工具' }, { label: '项目' }, { label: '会话请求', right: true }, { label: '命中率', right: true }, { label: '断档', right: true }, { label: '丢掉的 Tokens', right: true }, { label: '多花', right: true }],
      data.sessions.map(row => {
        const kind = KIND[row.source];
        const source = kind ? el('button', { type: 'button', class: 'text-btn cc-open-session', text: row.source, 'data-session-key': `${kind}:${row.session}` }) : el('span', { text: row.source });
        return el('tr', {}, [el('td', {}, [source]), projectCell(row.project), cell(number(row.requests)), cell(pct(row.hitRate)), cell(number(row.breaks)), cell(number(row.lostTokens)), cell(money(row.extraUsd))]);
      }), '还没有检测到缓存断档的会话。');
    table(nodes.recent,
      [{ label: '时间' }, { label: '工具' }, { label: '项目' }, { label: '型号' }, { label: '原因' }, { label: '间隔', right: true }, { label: '丢掉的 Tokens', right: true }, { label: '多花', right: true }],
      data.recentBreaks.map(row => el('tr', {}, [
        el('td', { text: date(row.at, true) }), el('td', { text: row.source }), projectCell(row.project),
        el('td', { class: 'cc-model', text: row.model, translate: 'no' }), el('td', { text: CAUSES[row.cause][0] }),
        cell(gapText(row.gapMs)), cell(number(row.lostTokens)), cell(money(row.extraUsd))
      ])), '还没有检测到缓存断档。');
  }

  function draw() {
    const host = $('view-cache');
    if (!host) return;
    if (!cacheView.built) build(host);
    host.toggleAttribute('aria-busy', cacheView.loading);
    if (!cacheView.page) {
      nodes.summary.replaceChildren();
      const children = [el('div', { class: 'empty', text: cacheView.error ? '缓存分析读取失败，请重试。' : '正在读取缓存分析…' })];
      if (cacheView.error) {
        const retry = el('button', { type: 'button', class: 'btn', text: '重试' });
        retry.addEventListener('click', () => { cacheView.key = ''; load(); draw(); });
        children.push(retry);
      }
      nodes.chart.replaceChildren(...children);
      nodes.ttl?.replaceChildren(); nodes.causes.replaceChildren(); nodes.tools.replaceChildren(); nodes.models.replaceChildren(); nodes.sessions.replaceChildren(); nodes.recent.replaceChildren();
      $('cache-count').textContent = '';
      return;
    }
    const data = cacheView.page.cache;
    if (!data) return;
    drawSummary(data);
    drawChart(nodes.chart, data.daily);
    drawRetention(nodes.ttl, data.retention);
    drawCauses(nodes.causes, data);
    drawTables(data);
    nodes.unpriced.hidden = !data.totals.unpricedTokens;
    nodes.unpriced.textContent = data.totals.unpricedTokens ? `其中 ${number(data.totals.unpricedTokens)} Tokens 的型号没有参考标价，因此不计入省钱金额。` : '';
  }

  function render() {
    if (!visible()) return;
    load();
    draw();
  }
  $('view-cache')?.addEventListener('click', event => {
    const button = event.target.closest('[data-session-key]');
    if (button) window.PulseSessions?.open(button.dataset.sessionKey);
  });
  window.PulseCache = { render };
})();
