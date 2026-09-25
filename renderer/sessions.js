/*
 * 会话管理：左边会话列表，右边对话内容和回复框。
 *
 * 数据来自主进程（src/core/sessions.ts 读各家 CLI 的会话文件），这里只管展示；
 * 回复走 src/main/session-reply.ts：CLI 无界面模式接着原会话跑一轮，过程通过 onSessionReply 推回来，
 * 跑完重新读一遍会话文件，新的一问一答就出现在对话里。
 *
 * 用到 app.js 里的公共函数（el / icon / brandSvg / $ / api / number / showStatus / dateLocale），所以要在它后面加载。
 * 所有文字都用 textContent 放进去，会话内容里的 HTML / 脚本不会被执行。
 */
(function () {
  const S = {
    items: [], loaded: false, loading: false, listAt: 0,
    search: '', kind: 'all', project: 'all',
    key: '', detail: null, detailLoading: false,
    /** 从最后往前显示多少个「块」（一段工具调用算一块）。 */
    visible: 160,
    /** 正在进行的回复：{ runId, key, prompt, text, tools, error } */
    run: null,
    mode: 'readonly',
    drafts: {},
    openGroups: new Set()
  };
  const AGENTS = {
    claude: { name: 'Claude Code', short: 'Claude', brand: 'claude' },
    codex: { name: 'Codex CLI', short: 'Codex', brand: 'openai' },
    grok: { name: 'Grok Build', short: 'Grok', brand: 'grok' }
  };
  const DAY = 86400000;
  let built = false;
  let N = {};

  /* ---------------- 小工具 ---------------- */

  function mark(kind, cls = 'sw-mark') {
    return el('span', { class: `${cls} ${AGENTS[kind]?.brand || ''}`, 'aria-hidden': 'true' }, [brandSvg(AGENTS[kind]?.brand)]);
  }
  function dayStart(at) { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function hm(at) { return new Date(at).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', hour12: false }); }
  /** 列表里的时间：今天只写时分，今年写月日，更早带年份。 */
  function shortTime(at) {
    if (!at) return '';
    const today = dayStart(Date.now());
    if (at >= today) return hm(at);
    if (at >= today - DAY) return `昨天 ${hm(at)}`;
    const d = new Date(at);
    return d.getFullYear() === new Date().getFullYear()
      ? d.toLocaleDateString(dateLocale(), { month: '2-digit', day: '2-digit' })
      : d.toLocaleDateString(dateLocale(), { year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  function fullTime(at) { return at ? new Date(at).toLocaleString(dateLocale(), { hour12: false }) : ''; }
  function groupOf(at) {
    const today = dayStart(Date.now());
    if (!at || at >= today) return '今天';
    if (at >= today - DAY) return '昨天';
    if (at >= today - 6 * DAY) return '最近 7 天';
    if (at >= today - 29 * DAY) return '最近 30 天';
    return '更早';
  }
  function button(label, iconName, cls = 'btn', attrs = {}) {
    return el('button', { class: cls, type: 'button', ...attrs }, [iconName ? icon(iconName) : null, label ? el('span', { text: label }) : null]);
  }
  async function copy(text, done) {
    try { await api.copyText(text); showStatus(done); }
    catch { showStatus('复制失败，请重试。', true); }
  }

  /** 很轻的 Markdown：代码块、行内代码、粗体、标题行。只生成 DOM 节点，不拼 HTML。 */
  function inline(text) {
    const out = [];
    // 行内代码、粗体、链接 [文字](地址)：链接只显示文字，地址放在悬停提示里（不做成可点的，免得点开奇怪的地方）
    const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\))/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const token = m[0];
      if (token[0] === '`') out.push(el('code', { text: token.slice(1, -1) }));
      else if (token[0] === '[') { const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/); out.push(el('span', { class: 'sw-link', text: link[1], title: link[2] })); }
      else out.push(el('strong', { text: token.slice(2, -2) }));
      last = m.index + token.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  function rich(text) {
    const box = el('div', { class: 'sw-rich', translate: 'no' });
    const parts = String(text || '').split(/^```[^\n]*\n?/m);
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        box.append(el('pre', { class: 'sw-code' }, [el('code', { text: part.replace(/\n$/, '') })]));
        return;
      }
      for (const block of part.split(/\n{2,}/)) {
        const trimmed = block.replace(/^\n+|\n+$/g, '');
        if (!trimmed) continue;
        const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
        if (heading && !trimmed.includes('\n')) { box.append(el('p', { class: 'sw-h' }, inline(heading[1]))); continue; }
        // 表格行（| a | b |）和普通文字可能挤在同一段里：按行分成几截分别画。Codex / Grok 的总结很爱用表格
        let run = [], inTable = false;
        const flush = () => {
          if (run.length) box.append(inTable ? table(run) : el('p', {}, inline(run.join('\n'))));
          run = [];
        };
        for (const line of trimmed.split('\n')) {
          const isRow = /^\s*\|.*\|\s*$/.test(line);
          if (isRow !== inTable) { flush(); inTable = isRow; }
          run.push(line);
        }
        flush();
      }
    });
    return box;
  }
  function table(lines) {
    const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
    const rows = lines.filter(line => !/^\s*\|[\s:|-]+\|\s*$/.test(line)).map(cells);
    // 第二行是 |---|---| 才算有表头
    const hasHead = lines.length > 1 && /^\s*\|[\s:|-]+\|\s*$/.test(lines[1]);
    const head = hasHead ? rows.shift() : null;
    return el('div', { class: 'sw-table-wrap' }, [el('table', { class: 'sw-table' }, [
      head ? el('thead', {}, [el('tr', {}, head.map(cell => el('th', {}, inline(cell))))]) : null,
      el('tbody', {}, rows.map(row => el('tr', {}, row.map(cell => el('td', {}, inline(cell))))))
    ])]);
  }

  /* ---------------- 搭骨架（只一次） ---------------- */

  function build() {
    if (built) return;
    built = true;
    const host = $('page-sessions');
    N.search = el('input', { type: 'search', placeholder: '搜索标题、项目或内容…', autocomplete: 'off', 'aria-label': '搜索会话' });
    N.refresh = button('', 'refresh', 'btn icon-only sw-refresh', { title: '重新读取会话', 'aria-label': '重新读取会话' });
    N.kinds = el('div', { class: 'seg compact sw-kinds', role: 'group', 'aria-label': '按 Agent 筛选' }, [el('span', { class: 'seg-thumb', 'aria-hidden': 'true' })]);
    N.project = el('select', { class: 'sw-project', 'aria-label': '按项目筛选' });
    N.list = el('div', { class: 'sw-items', role: 'listbox', 'aria-label': '会话列表' });
    N.count = el('span', { class: 'section-tag' });
    const aside = el('aside', { class: 'panel sw-side' }, [
      el('div', { class: 'sw-side-head' }, [el('h2', {}, ['会话列表 ', N.count]), N.refresh]),
      el('label', { class: 'search-field sw-search' }, [icon('search'), N.search]),
      N.kinds,
      N.project,
      N.list
    ]);
    N.main = el('section', { class: 'panel sw-main', 'aria-live': 'polite' });
    host.replaceChildren(el('div', { class: 'sw' }, [aside, N.main]));

    N.search.addEventListener('input', () => { S.search = N.search.value; drawList(); });
    N.refresh.addEventListener('click', () => loadList(true));
    N.kinds.addEventListener('click', event => {
      const hit = event.target.closest('[data-kind]'); if (!hit) return;
      S.kind = hit.dataset.kind; drawList();
    });
    N.project.addEventListener('change', () => { S.project = N.project.value; drawList(); });
    N.list.addEventListener('click', event => {
      const hit = event.target.closest('[data-key]'); if (hit) select(hit.dataset.key);
    });
    N.list.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const keys = visibleItems().map(item => item.key);
      const at = keys.indexOf(S.key);
      const next = keys[Math.max(0, Math.min(keys.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (next && next !== S.key) { event.preventDefault(); select(next); N.list.querySelector(`[data-key="${CSS.escape(next)}"]`)?.focus(); }
    });
    api.onSessionReply?.(onReplyEvent);
  }

  /* ---------------- 列表 ---------------- */

  function matches(item) {
    if (S.kind !== 'all' && item.kind !== S.kind) return false;
    if (S.project !== 'all' && item.project !== S.project) return false;
    const q = S.search.trim().toLowerCase();
    if (!q) return true;
    return [item.title, item.project, item.cwd, item.preview, AGENTS[item.kind]?.name, ...(item.models || [])].filter(Boolean).join(' ').toLowerCase().includes(q);
  }
  function visibleItems() { return S.items.filter(matches); }

  function drawList() {
    const counts = { all: S.items.length, claude: 0, codex: 0, grok: 0 };
    for (const item of S.items) counts[item.kind] = (counts[item.kind] || 0) + 1;
    N.kinds.replaceChildren(el('span', { class: 'seg-thumb', 'aria-hidden': 'true' }), ...['all', 'claude', 'codex', 'grok'].map(kind =>
      el('button', { type: 'button', 'data-kind': kind, class: S.kind === kind ? 'on' : '', 'aria-pressed': String(S.kind === kind), title: `${kind === 'all' ? '全部' : AGENTS[kind].short} · ${number(counts[kind] || 0)} 个会话` }, [
        kind === 'all' ? '全部' : AGENTS[kind].short, el('small', { text: number(counts[kind] || 0) })
      ])));
    syncSeg(N.kinds);
    // 项目下拉：按会话数排序
    const projects = new Map();
    for (const item of S.items) if (S.kind === 'all' || item.kind === S.kind) projects.set(item.project, (projects.get(item.project) || 0) + 1);
    if (S.project !== 'all' && !projects.has(S.project)) S.project = 'all';
    N.project.replaceChildren(el('option', { value: 'all', text: `全部项目（${number(projects.size)}）` }),
      ...[...projects].sort((a, b) => b[1] - a[1]).map(([name, n]) => el('option', { value: name, text: `${name}（${number(n)}）`, translate: 'no' })));
    N.project.value = S.project;

    const items = visibleItems();
    N.count.textContent = number(items.length);
    if (S.loading && !S.items.length) { N.list.replaceChildren(el('div', { class: 'sw-list-note' }, [el('span', { class: 'sw-spinner' }), '正在读取本机会话…'])); return; }
    if (!S.items.length) { N.list.replaceChildren(el('div', { class: 'sw-list-note', text: S.loaded ? '还没有找到本机 Agent 的会话。' : '' })); return; }
    if (!items.length) { N.list.replaceChildren(el('div', { class: 'sw-list-note', text: '没有符合条件的会话。' })); return; }
    const nodes = [];
    let group = '';
    for (const item of items) {
      const g = groupOf(item.updatedAt);
      if (g !== group) { group = g; nodes.push(el('div', { class: 'sw-group', text: g })); }
      const active = item.key === S.key;
      const running = S.run && S.run.key === item.key;
      nodes.push(el('button', { type: 'button', class: `sw-item${active ? ' active' : ''}`, role: 'option', 'aria-selected': String(active), 'data-key': item.key }, [
        mark(item.kind),
        el('span', { class: 'sw-item-body' }, [
          el('span', { class: 'sw-item-top' }, [el('b', { text: item.title, title: item.title, translate: 'no' }), el('time', { text: shortTime(item.updatedAt) })]),
          el('span', { class: 'sw-item-meta' }, [
            el('span', { class: 'sw-item-project', text: item.project, translate: 'no' }),
            el('span', { text: `${number(item.turns)} 轮` }),
            running ? el('span', { class: 'sw-live', text: '回复中' }) : null
          ])
        ])
      ]));
    }
    N.list.replaceChildren(...nodes);
  }

  async function loadList(force = false, quiet = false) {
    if (S.loading) return;
    S.loading = true;
    if (!quiet) drawList();
    if (force) N.refresh.classList.add('is-busy');
    try {
      S.items = await api.sessions();
      S.loaded = true; S.listAt = Date.now();
      drawList();
      if (!S.key && S.items.length) select(visibleItems()[0]?.key || S.items[0].key);
      else if (S.key && force) select(S.key, true);
    } catch {
      if (!quiet) showStatus('会话读取失败，请重试。', true);
    } finally {
      S.loading = false;
      N.refresh.classList.remove('is-busy');
      drawList();
    }
  }

  /* ---------------- 详情 ---------------- */

  async function select(key, keepScroll = false) {
    if (!key) return;
    const changed = key !== S.key;
    if (changed) { saveDraft(); S.key = key; S.visible = 160; S.openGroups.clear(); }
    drawList();
    const item = S.items.find(entry => entry.key === key);
    if (!item) return;
    if (changed || !S.detail) { S.detail = null; S.detailLoading = true; drawMain(); }
    try {
      const detail = await api.sessionDetail(item.kind, item.id);
      if (S.key !== key) return;
      S.detail = detail;
    } catch {
      if (S.key === key) showStatus('这个会话读取失败，请重试。', true);
    } finally {
      if (S.key === key) { S.detailLoading = false; drawMain(!keepScroll); }
    }
  }

  function saveDraft() { if (S.key && N.input) S.drafts[S.key] = N.input.value; }

  function header(d) {
    const agent = AGENTS[d.kind];
    const chips = [
      el('span', { class: 'sw-chip', title: d.cwd || '', translate: 'no' }, [icon('folder'), d.project]),
      el('span', { class: 'sw-chip' }, [mark(d.kind, 'sw-chip-mark'), agent.name]),
      d.createdAt ? el('span', { class: 'sw-chip', title: `${fullTime(d.createdAt)} → ${fullTime(d.updatedAt)}` }, [icon('clock'), `${shortTime(d.createdAt)} → ${shortTime(d.updatedAt)}`]) : null,
      el('span', { class: 'sw-chip' }, [icon('sessions'), `${number(d.turns)} 轮对话`]),
      d.toolCount ? el('span', { class: 'sw-chip' }, [icon('terminal'), `${number(d.toolCount)} 次工具调用`]) : null,
      ...(d.models || []).slice(0, 2).map(model => el('span', { class: 'sw-chip mono', text: model }))
    ];
    const copyPath = button('复制项目地址', 'copy', 'btn', { title: d.cwd || '这个会话没有记录项目地址' });
    copyPath.disabled = !d.cwd;
    copyPath.addEventListener('click', () => copy(d.cwd, '项目地址已复制'));
    const reply = button('回复对话', 'reply', 'btn btn-accent');
    reply.addEventListener('click', () => { N.input?.focus(); N.input?.scrollIntoView({ block: 'nearest' }); });
    const more = button('', 'more', 'btn icon-only', { title: '更多', 'aria-label': '更多操作', 'aria-haspopup': 'menu' });
    more.addEventListener('click', () => openMore(more, d));
    return el('div', { class: 'sw-head' }, [
      el('div', { class: 'sw-head-top' }, [
        mark(d.kind, 'sw-mark lg'),
        el('div', { class: 'sw-head-text' }, [el('h2', { text: d.title, title: d.title, translate: 'no' }), el('div', { class: 'sw-chips' }, chips)])
      ]),
      el('div', { class: 'sw-actions' }, [copyPath, reply, more])
    ]);
  }

  /** 「更多」菜单：终端、复制信息和永久删除。借用设置里的选项菜单样式。 */
  function openMore(anchor, d) {
    openOptionMenu(anchor, '更多操作', [
      { value: 'terminal', label: '在终端里继续', hint: '打开 PowerShell，用 CLI 的交互界面接着这段会话' },
      { value: 'command', label: '复制继续命令', hint: d.resumeCommand },
      { value: 'id', label: '复制会话 ID', hint: d.id },
      { value: 'delete', label: '删除对话', hint: '永久删除这段会话，无法撤销', danger: true }
    ], null, async value => {
      if (value === 'command') copy(d.resumeCommand, '继续命令已复制');
      if (value === 'id') copy(d.id, '会话 ID 已复制');
      if (value === 'delete') await deleteConversation(d);
      if (value === 'terminal') {
        try { await api.openSessionTerminal(d.kind, d.id); showStatus('已在终端里打开这段会话。'); }
        catch (error) { showStatus(cleanError(error, '打不开终端，请确认对应的 CLI 已安装。'), true); }
      }
    });
  }

  async function deleteConversation(d) {
    const before = visibleItems();
    const oldIndex = Math.max(0, before.findIndex(item => item.key === d.key));
    try {
      const result = await api.deleteSession(d.kind, d.id);
      if (!result?.ok) return;
      delete S.drafts[d.key];
      S.items = await api.sessions();
      S.loaded = true; S.listAt = Date.now();
      S.key = ''; S.detail = null; S.detailLoading = false; S.visible = 160; S.openGroups.clear();
      drawList(); drawMain();
      const after = visibleItems();
      const next = after[Math.min(oldIndex, after.length - 1)];
      if (next) await select(next.key);
      showStatus('已删除对话。');
    } catch (error) {
      showStatus(cleanError(error, '删除对话失败，请重试。'), true);
    }
  }

  function cleanError(error, fallback) {
    return String(error?.message || fallback).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || fallback;
  }

  /** 连着的工具调用合成一块，别让几十段 JSON 把对话淹掉。 */
  function blocks(messages) {
    const out = [];
    for (const message of messages) {
      const last = out.at(-1);
      if (message.role === 'tool' && last?.role === 'tools') last.items.push(message);
      else if (message.role === 'tool') out.push({ role: 'tools', id: message.id, items: [message], at: message.at });
      else out.push(message);
    }
    return out;
  }

  function toolRow(tool) {
    const detail = el('div', { class: 'sw-tool-detail', hidden: '' }, [
      tool.input ? el('div', {}, [el('small', { text: '参数' }), el('pre', { class: 'sw-code', text: tool.input, translate: 'no' })]) : null,
      tool.output ? el('div', {}, [el('small', { text: tool.error ? '结果（出错）' : '结果' }), el('pre', { class: 'sw-code', text: tool.output, translate: 'no' })]) : null
    ]);
    const row = el('button', { type: 'button', class: `sw-tool${tool.error ? ' error' : ''}`, 'aria-expanded': 'false' }, [
      icon('chevron', 'icon sw-tool-caret'), el('b', { text: tool.name, translate: 'no' }), el('span', { class: 'sw-tool-sum', text: tool.summary || '', translate: 'no' })
    ]);
    row.addEventListener('click', () => { const open = detail.hidden; detail.hidden = !open; row.setAttribute('aria-expanded', String(open)); });
    return el('div', { class: 'sw-tool-wrap' }, [row, detail]);
  }

  function toolGroup(block) {
    const names = new Map();
    for (const tool of block.items) names.set(tool.name, (names.get(tool.name) || 0) + 1);
    const label = [...names].slice(0, 4).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join('、') + (names.size > 4 ? ' 等' : '');
    const open = S.openGroups.has(block.id);
    const list = el('div', { class: 'sw-tools', hidden: open ? null : '' }, block.items.map(toolRow));
    const head = el('button', { type: 'button', class: 'sw-tools-head', 'aria-expanded': String(open) }, [
      icon('terminal'), el('span', { text: `调用了 ${number(block.items.length)} 次工具` }), el('small', { text: label }), icon('chevron', 'icon sw-caret')
    ]);
    head.addEventListener('click', () => {
      const next = list.hidden; list.hidden = !next; head.setAttribute('aria-expanded', String(next));
      if (next) S.openGroups.add(block.id); else S.openGroups.delete(block.id);
    });
    return el('div', { class: 'sw-row tools' }, [el('div', { class: 'sw-tools-box' }, [head, list])]);
  }

  function bubble(message, kind, extraClass = '') {
    const copyBtn = el('button', { type: 'button', class: 'sw-copy', title: '复制', 'aria-label': '复制这条消息' }, [icon('copy')]);
    copyBtn.addEventListener('click', () => copy(message.text, '已复制'));
    const isUser = message.role === 'user';
    return el('div', { class: `sw-row ${message.role} ${extraClass}`.trim() }, [
      isUser ? null : mark(kind, 'sw-avatar'),
      el('div', { class: 'sw-bubble' }, [
        isUser ? el('div', { class: 'sw-plain', text: message.text, translate: 'no' }) : rich(message.text),
        el('div', { class: 'sw-bubble-foot' }, [message.at ? el('time', { text: hm(message.at), title: fullTime(message.at) }) : null, copyBtn])
      ])
    ]);
  }

  function drawMessages(d, host) {
    const all = blocks(d.messages);
    const hidden = Math.max(0, all.length - S.visible);
    const nodes = [];
    if (hidden || d.truncated) {
      const more = button(hidden ? `显示更早的 ${number(hidden)} 段` : '', 'up', 'btn sw-earlier');
      if (hidden) more.addEventListener('click', () => {
        const before = host.scrollHeight - host.scrollTop;
        S.visible += 200; drawMain(false);
        // 保持当前看到的位置不动
        N.scroller.scrollTop = N.scroller.scrollHeight - before;
      });
      nodes.push(el('div', { class: 'sw-earlier-wrap' }, [
        hidden ? more : null,
        d.truncated ? el('small', { text: `会话太长，最早的 ${number(d.truncated)} 条没有载入` }) : null
      ]));
    }
    let lastDay = 0, lastAt = 0;
    for (const block of all.slice(hidden)) {
      const at = block.at;
      if (at && (dayStart(at) !== lastDay || at - lastAt > 3 * 3600000)) {
        nodes.push(el('div', { class: 'sw-divider' }, [el('span', { text: new Date(at).toLocaleString(dateLocale(), { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) })]));
        lastDay = dayStart(at);
      }
      if (at) lastAt = at;
      if (block.role === 'tools') nodes.push(toolGroup(block));
      else if (block.role === 'event') nodes.push(el('div', { class: 'sw-row event' }, [el('span', { text: block.text })]));
      else nodes.push(bubble(block, d.kind));
    }
    // 正在进行的回复：先把自己刚发的那句和流式回来的文字接在后面
    if (S.run && S.run.key === d.key) {
      nodes.push(bubble({ role: 'user', text: S.run.prompt, at: S.run.startedAt }, d.kind, 'pending'));
      const reply = { role: 'assistant', text: S.run.text || '', at: undefined };
      const row = bubble(reply, d.kind, 'pending');
      const bubbleNode = row.querySelector('.sw-bubble');
      if (!S.run.text) bubbleNode.prepend(el('div', { class: 'sw-typing' }, [el('i'), el('i'), el('i')]));
      if (S.run.tools.length) bubbleNode.append(el('div', { class: 'sw-live-tools' }, [icon('terminal'), `正在调用：${S.run.tools.at(-1)}`, S.run.tools.length > 1 ? el('small', { text: `（共 ${S.run.tools.length} 次）` }) : null]));
      if (S.run.error) bubbleNode.append(el('div', { class: 'sw-reply-error' }, [icon('alert'), S.run.error]));
      nodes.push(row);
    }
    host.replaceChildren(...nodes);
  }

  function composer(d) {
    const running = S.run && S.run.key === d.key;
    const otherRunning = S.run && !running && !S.run.done;
    N.input = el('textarea', { rows: '1', placeholder: `回复 ${AGENTS[d.kind].short}…（Enter 发送，Shift + Enter 换行）`, 'aria-label': '回复内容' });
    N.input.value = S.drafts[d.key] || '';
    // 高度跟着内容长，超过 200px 才出滚动条
    const grow = () => { N.input.style.height = 'auto'; N.input.style.height = `${Math.min(200, N.input.scrollHeight)}px`; N.input.style.overflowY = N.input.scrollHeight > 200 ? 'auto' : 'hidden'; };
    N.input.addEventListener('input', () => { grow(); send.disabled = !N.input.value.trim() || Boolean(running); });
    N.input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!send.disabled) sendReply(); }
    });
    const mode = el('div', { class: 'seg compact sw-mode', role: 'group', 'aria-label': '回复权限' }, [
      el('span', { class: 'seg-thumb', 'aria-hidden': 'true' }),
      ...[['readonly', '只读', '只让 Agent 看和回答，不改任何文件'], ['edit', '可改文件', '允许 Agent 修改这个项目里的文件；运行命令等其他操作仍会自动拒绝']].map(([value, label, hint]) =>
        el('button', { type: 'button', 'data-mode': value, class: S.mode === value ? 'on' : '', 'aria-pressed': String(S.mode === value), title: hint, text: label }))
    ]);
    mode.addEventListener('click', event => {
      const hit = event.target.closest('[data-mode]'); if (!hit) return;
      S.mode = hit.dataset.mode;
      for (const item of mode.querySelectorAll('[data-mode]')) { const on = item.dataset.mode === S.mode; item.classList.toggle('on', on); item.setAttribute('aria-pressed', String(on)); }
      syncSeg(mode);
    });
    const send = button(running ? '' : '发送', running ? '' : 'send', 'btn btn-accent sw-send');
    if (running) { send.replaceChildren(icon('stop'), el('span', { text: '停止' })); send.classList.remove('btn-accent'); send.disabled = false; }
    else send.disabled = !N.input.value.trim() || Boolean(otherRunning);
    send.addEventListener('click', () => (S.run && S.run.key === d.key && !S.run.done ? stopReply() : sendReply()));
    const note = el('small', { class: 'sw-composer-note', text: running
      ? `${AGENTS[d.kind].short} 正在回复…`
      : otherRunning ? '另一段会话正在回复，等它结束再发'
      : !d.cwd ? '这个会话没有记录项目目录，没法在原目录里继续' : `在 ${d.project} 里继续这段会话 · 会用掉对应账号的订阅额度` });
    if (!d.cwd) { N.input.disabled = true; send.disabled = true; }
    requestAnimationFrame(() => { grow(); syncSeg(mode); });
    return el('div', { class: 'sw-composer' }, [
      el('div', { class: 'sw-input' }, [N.input, send]),
      el('div', { class: 'sw-composer-bar' }, [mode, note])
    ]);
  }

  function drawMain(toBottom = true) {
    if (!built) return;
    const item = S.items.find(entry => entry.key === S.key);
    if (!item && !S.detail) {
      N.main.replaceChildren(el('div', { class: 'sw-empty' }, [
        el('span', { class: 'sw-empty-icon' }, [icon('sessions')]),
        el('h2', { text: S.loaded ? '选择一个会话' : '正在读取会话…' }),
        el('p', { text: '左边是本机 Claude Code、Codex CLI 和 Grok Build 的对话历史。选中后可以查看完整对话、复制项目地址，或者直接回复。' })
      ]));
      return;
    }
    const d = S.detail;
    if (!d) {
      N.main.replaceChildren(header({ ...item, messages: [] }), el('div', { class: 'sw-scroll' }, [el('div', { class: 'sw-list-note' }, [el('span', { class: 'sw-spinner' }), '正在读取对话…'])]));
      return;
    }
    const previous = N.scroller;
    const offsetFromBottom = previous ? previous.scrollHeight - previous.scrollTop : 0;
    saveDraft();
    N.scroller = el('div', { class: 'sw-scroll' });
    const inner = el('div', { class: 'sw-messages' });
    N.scroller.append(inner);
    drawMessages(d, inner);
    const focused = document.activeElement === N.input;
    N.main.replaceChildren(header(d), N.scroller, composer(d));
    if (focused) N.input.focus();
    requestAnimationFrame(() => {
      N.scroller.scrollTop = toBottom ? N.scroller.scrollHeight : N.scroller.scrollHeight - offsetFromBottom;
    });
  }

  /* ---------------- 回复 ---------------- */

  async function sendReply() {
    const d = S.detail;
    const prompt = N.input?.value.trim();
    if (!d || !prompt || (S.run && !S.run.done)) return;
    S.run = { runId: '', key: d.key, prompt, text: '', tools: [], startedAt: Date.now(), done: false };
    S.drafts[d.key] = '';
    N.input.value = '';
    drawMain(true); drawList();
    try {
      const { runId } = await api.replySession(d.kind, d.id, prompt, S.mode);
      if (S.run) S.run.runId = runId;
    } catch (error) {
      S.drafts[d.key] = prompt;
      S.run = null;
      showStatus(cleanError(error, '回复没发出去，请重试。'), true);
      drawMain(true); drawList();
    }
  }

  function stopReply() {
    if (S.run?.runId) api.stopSessionReply(S.run.runId);
  }

  function onReplyEvent(event) {
    const run = S.run;
    if (!run || !event || (run.runId && event.runId !== run.runId)) return;
    if (!run.runId) run.runId = event.runId;
    if (event.type === 'delta') run.text += event.text;
    if (event.type === 'tool') run.tools.push(event.text);
    if (event.type === 'done') {
      run.done = true;
      if (!event.ok) {
        run.error = event.error === '已停止' ? '已停止' : `回复失败：${event.error || '未知原因'}`;
        if (event.error !== '已停止') S.drafts[run.key] = S.drafts[run.key] || run.prompt;
      }
      // 不管成败都重新读一遍：CLI 可能已经把这一轮写进会话文件了
      finishRun(run, event.ok);
      return;
    }
    if (S.key === run.key && S.detail) {
      const inner = N.scroller?.querySelector('.sw-messages');
      const nearBottom = N.scroller && N.scroller.scrollHeight - N.scroller.scrollTop - N.scroller.clientHeight < 120;
      if (inner) drawMessages(S.detail, inner);
      if (nearBottom) N.scroller.scrollTop = N.scroller.scrollHeight;
    }
  }

  async function finishRun(run, ok) {
    const item = S.items.find(entry => entry.key === run.key);
    try {
      const [list, detail] = await Promise.all([api.sessions(), item ? api.sessionDetail(item.kind, item.id) : null]);
      S.items = list;
      if (S.key === run.key && detail) S.detail = detail;
    } catch { /* 读不到就保留原来的 */ }
    // 成功就收起临时气泡（新消息已经在会话文件里了）；失败保留，好让人看到原因
    if (ok || run.error === '已停止') S.run = null;
    drawList();
    if (S.key === run.key) drawMain(true);
    if (ok) showStatus('已回复，新的对话已写回会话记录。');
  }

  /* ---------------- 对外 ---------------- */

  window.PulseSessions = {
    show() {
      build();
      drawList();
      if (!S.loaded) loadList();
      // 列表放了半分钟以上再悄悄刷新一遍（有索引缓存，几十毫秒）；对话区不跟着重画，免得打断阅读和输入
      else if (Date.now() - S.listAt > 30000 && !S.run) loadList(false, true);
      if (!N.drawn) { N.drawn = true; drawMain(false); }
    }
  };
})();
