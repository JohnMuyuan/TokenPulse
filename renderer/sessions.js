/*
 * 会话管理：左边会话列表，右边对话内容。
 *
 * 数据来自主进程（src/core/sessions.ts 读各家 CLI / IDE 的会话文件），这里只管查看、搜索、复制地址、在终端里继续或删除；
 * 不在软件内直接向 Agent 发送回复，避免后台无头调用引发异常。
 *
 * 用到 app.js 里的公共函数（el / icon / brandSvg / $ / api / number / showStatus / dateLocale），所以要在它后面加载。
 * 所有文字都用 textContent 放进去，会话内容里的 HTML / 脚本不会被执行。
 */
(function () {
  const LIST_CHUNK = 40;
  const MSG_CHUNK = 40;
  const S = {
    items: [], loaded: false, loading: false, listAt: 0,
    search: '', kind: 'all', project: 'all',
    showSubagents: false, expandedParents: new Set(), subBarOpen: false,
    key: '', detail: null, detailLoading: false, detailSeq: 0, detailError: '', openKey: '',
    /** 会话列表当前渲染数量（分批分块渲染，初始 40 项）。 */
    listLimit: LIST_CHUNK,
    /** 从最后往前显示多少个「块」（一段工具调用算一块，初始 40 块）。 */
    visible: MSG_CHUNK,
    openGroups: new Set(),
    usageOpen: false,
    usageBasis: 'tokens',
    /**
     * 0.3.55 全文搜索：hits 是这次搜内容命中的会话（key → { count, snippets, ids }），null = 没在搜内容；
     * terms 是搜索词（高亮用）；jump 是正在看的会话里「第几处」：{ key, ids, index }，index -1 = 还没跳。
     */
    hits: null, terms: [], searching: false, searchSeq: 0, searchNote: '', jump: null
  };
  let treeCache = { items: null, data: null };
  let searchTimer = 0;
  let closeNewModal = null;
  let newModalSeq = 0;
  const AGENTS = {
    claude: { name: 'Claude Code', short: 'Claude', brand: 'claude' },
    codex: { name: 'Codex CLI', short: 'Codex', brand: 'openai' },
    grok: { name: 'Grok Build', short: 'Grok', brand: 'grok' },
    deepseek: { name: 'DeepSeek Harness', short: 'DeepSeek', brand: 'deepseek' },
    pi: { name: 'pi', short: 'pi', brand: 'pi' },
    antigravity: { name: 'Antigravity', short: 'Antigravity', brand: 'antigravity' }
  };
  /** Antigravity 不是命令行工具：不能在终端里继续、不能在这里回复，只能看、搜、删。 */
  const IDE_ONLY = new Set();
  const DAY = 86400000;
  /** 0.3.16：这一家设了出口 IP 白名单时，TokenPulse 启动的 CLI 会先测出口。 */
  const GUARD_NOTES = { ip: '启动前会先在终端里检测出口 IP，不在白名单就不会启动。', region: '启动前会先在终端里检测出口地区，不在地区白名单就不会启动。' };
  /** guarded：'ip' / 'region' / 没有（旧的布尔值 true 当作 ip）。 */
  const guardNote = mode => GUARD_NOTES[mode === true ? 'ip' : mode] || '';
  let built = false;
  let N = {};

  /* ---------------- 小工具 ---------------- */

  const MODEL_COLORS = ['#6366f1', '#14b8a6', '#f59e0b', '#ec4899', '#3b82f6', '#8b5cf6'];
  function paint(node, props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null) continue;
      if (key.startsWith('--')) node.style.setProperty(key, value);
      else node.style[key] = value;
    }
    return node;
  }
  function compact(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return number(v);
  }
  function usd(n) {
    const v = Number(n) || 0;
    return v <= 0 ? '$0.00' : v < 0.01 ? '$' + v.toFixed(4) : '$' + v.toFixed(2);
  }
  function formatLatency(ms, estimated = false) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
    const prefix = estimated ? '≈' : '';
    if (ms < 1000) return `${prefix}${Math.round(ms)}ms`;
    const sec = (ms / 1000).toFixed(1).replace(/\.0$/, '');
    return `${prefix}${sec}s`;
  }
  function formatDuration(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return (ms / 1000).toFixed(1).replace(/\.0$/, '') + 's';
    let m = Math.floor(ms / 60000);
    let s = Math.round((ms % 60000) / 1000);
    if (s >= 60) {
      m += 1;
      s = 0;
    }
    return `${m}m ${s}s`;
  }

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
    N.search = el('input', { type: 'search', placeholder: '搜索标题、项目或对话内容…', autocomplete: 'off', 'aria-label': '搜索会话', title: '同时搜对话内容：几个词用空格隔开，表示都要出现在同一段会话里' });
    N.searchNote = el('small', { class: 'sw-search-note', role: 'status', 'aria-live': 'polite' });
    N.refresh = button('', 'refresh', 'btn icon-only sw-refresh', { title: '重新读取会话', 'aria-label': '重新读取会话' });
    N.kinds = el('div', { class: 'seg compact sw-kinds', role: 'group', 'aria-label': '按 Agent 筛选' }, [el('span', { class: 'seg-thumb', 'aria-hidden': 'true' })]);
    N.project = el('select', { class: 'sw-project', 'aria-label': '按项目筛选' });
    N.subToggle = el('button', { type: 'button', class: 'btn sw-sub-toggle', 'data-action': 'toggle-subagents', 'aria-pressed': 'false', title: '开启后按时间平铺显示所有子代理与 Swarm 对话；关闭时折叠在主会话下' }, [el('span', { text: '显示子代理' })]);
    N.list = el('div', { class: 'sw-items', role: 'listbox', 'aria-label': '会话列表' });
    N.count = el('span', { class: 'section-tag' });
    // 0.3.16：新对话（在已有项目里）/ 新项目（选或新建一个文件夹）
    N.newChat = button('新对话', 'plus', 'btn btn-accent sw-new', { 'data-action': 'new-chat', title: '在一个项目里开一个新对话' });
    N.newProject = button('新项目', 'folder', 'btn sw-new', { 'data-action': 'new-project', title: '选择或新建一个项目文件夹，在里面开始第一个对话' });
    N.newChat.addEventListener('click', () => openNew());
    N.newProject.addEventListener('click', async () => {
      const folder = await api.pickProjectFolder?.(currentFolder() || undefined).catch(() => null);
      if (folder) openNew(folder);
    });
    const aside = el('aside', { class: 'panel sw-side' }, [
      el('div', { class: 'sw-side-head' }, [el('h2', {}, ['会话列表 ', N.count]), N.refresh]),
      el('div', { class: 'sw-new-row' }, [N.newChat, N.newProject]),
      el('label', { class: 'search-field sw-search' }, [icon('search'), N.search]),
      N.searchNote,
      N.kinds,
      el('div', { class: 'sw-filter-row' }, [N.project, N.subToggle]),
      N.list
    ]);
    N.main = el('section', { class: 'panel sw-main', 'aria-live': 'polite' });
    host.replaceChildren(el('div', { class: 'sw' }, [markLayout(aside, 'sessions:list'), markLayout(N.main, 'sessions:detail')]));

    N.search.addEventListener('input', () => {
      S.search = N.search.value;
      S.listLimit = LIST_CHUNK;
      drawList();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(searchContent, 350);
    });
    N.refresh.addEventListener('click', () => {
      S.listLimit = LIST_CHUNK;
      loadList(true);
    });
    N.kinds.addEventListener('click', event => {
      const hit = event.target.closest('[data-kind]'); if (!hit) return;
      S.kind = hit.dataset.kind;
      S.listLimit = LIST_CHUNK;
      drawList();
    });
    N.project.addEventListener('change', () => {
      S.project = N.project.value;
      S.listLimit = LIST_CHUNK;
      drawList();
    });
    N.subToggle.addEventListener('click', () => {
      S.showSubagents = !S.showSubagents;
      S.listLimit = LIST_CHUNK;
      drawList();
    });
    // 列表向下滚动时自动追加下一批数据（每次追加 40 项）
    N.list.addEventListener('scroll', () => {
      if (N.list.scrollTop + N.list.clientHeight >= N.list.scrollHeight - 160) {
        const total = visibleRows().length;
        if (S.listLimit < total) {
          S.listLimit = Math.min(total, S.listLimit + LIST_CHUNK);
          drawList();
        }
      }
    }, { passive: true });
    N.list.addEventListener('click', event => {
      const toggle = event.target.closest('[data-toggle-parent]');
      if (toggle) {
        event.stopPropagation();
        const pk = toggle.dataset.toggleParent;
        if (S.expandedParents.has(pk)) S.expandedParents.delete(pk);
        else S.expandedParents.add(pk);
        drawList();
        return;
      }
      const hit = event.target.closest('[data-key]'); if (hit) select(hit.dataset.key);
    });
    N.list.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        if (event.target.closest('[data-toggle-parent]')) return;
        const hit = event.target.closest('[data-key]');
        if (hit) { event.preventDefault(); select(hit.dataset.key); }
        return;
      }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        const hit = event.target.closest('[data-key]');
        const key = hit?.dataset.key;
        if (!key || S.showSubagents) return;
        const kids = buildTree().childrenByRoot.get(key) || [];
        if (!kids.length) return;
        const expand = event.key === 'ArrowRight';
        if (expand && !S.expandedParents.has(key)) { event.preventDefault(); S.expandedParents.add(key); drawList(); N.list.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus(); }
        else if (!expand && S.expandedParents.has(key)) { event.preventDefault(); S.expandedParents.delete(key); drawList(); N.list.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus(); }
        return;
      }
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const keys = visibleRows().map(row => row.item.key);
      const at = keys.indexOf(S.key);
      const next = keys[Math.max(0, Math.min(keys.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (next && next !== S.key) { event.preventDefault(); select(next); N.list.querySelector(`[data-key="${CSS.escape(next)}"]`)?.focus(); }
    });
  }

  /* ---------------- 新对话 / 新项目（0.3.16） ---------------- */

  /** 现在看着的那段会话所在的项目文件夹（没有选中就取最近一段会话的）。 */
  function currentFolder() {
    return S.detail?.cwd || S.items.find(item => item.key === S.key)?.cwd || S.items.find(item => item.cwd)?.cwd || '';
  }
  /** 本机会话里出现过的项目文件夹，最近用过的在前。 */
  function knownFolders() {
    const seen = new Map();
    for (const item of S.items) if (item.cwd && !seen.has(item.cwd.toLowerCase())) seen.set(item.cwd.toLowerCase(), { cwd: item.cwd, name: item.project });
    return [...seen.values()];
  }
  /**
   * 对话框：选项目文件夹 + 用哪个工具，然后在那个文件夹里打开终端启动 CLI。
   * folder：预先选好的文件夹（「新项目」选完文件夹后传进来）。
   */
  async function openNew(folder) {
    const seq = ++newModalSeq;
    closeNewModal?.();
    document.getElementById('sw-new')?.remove();
    const last = document.activeElement;
    let clis = {};
    try { clis = await api.sessionClis?.() || {}; } catch { /* 查不到就当都没装，下面会提示 */ }
    if (seq !== newModalSeq) return;
    const folders = knownFolders();
    let chosen = folder || currentFolder() || folders[0]?.cwd || '';
    const currentKind = S.detail?.kind || S.items.find(item => item.key === S.key)?.kind;
    let kind = [currentKind, 'claude', 'codex', 'grok', 'pi', 'antigravity'].find(k => k && clis[k]) || '';

    const select = el('select', { class: 'sw-new-folder', 'aria-label': '项目文件夹' });
    const path = el('p', { class: 'sw-new-path', translate: 'no' });
    const drawFolders = () => {
      const list = [...folders];
      if (chosen && !list.some(f => f.cwd.toLowerCase() === chosen.toLowerCase())) list.unshift({ cwd: chosen, name: chosen.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || chosen });
      select.replaceChildren(...(list.length ? list : [{ cwd: '', name: '还没有项目，点右边选一个文件夹' }]).map(f => el('option', { value: f.cwd, text: f.name, translate: 'no' })));
      select.value = chosen; path.textContent = chosen || ''; path.title = chosen;
      sync();
    };
    const browse = button('选择文件夹…', 'folder', 'btn', { 'data-action': 'browse' });
    const tools = el('div', { class: 'sw-new-tools', role: 'radiogroup', 'aria-label': '用哪个工具' });
    const drawTools = () => tools.replaceChildren(...['claude', 'codex', 'grok', 'pi', 'antigravity'].map(k => {
      const b = el('button', { type: 'button', class: 'sw-new-tool' + (kind === k ? ' on' : ''), role: 'radio', 'aria-checked': String(kind === k), 'data-kind': k, disabled: clis[k] ? null : '' }, [
        mark(k), el('b', { text: AGENTS[k].name, translate: 'no' }), el('small', { text: clis[k] ? '已安装' : '没有找到 CLI' })
      ]);
      b.addEventListener('click', () => { kind = k; drawTools(); sync(); });
      return b;
    }));
    const start = el('button', { type: 'button', class: 'btn btn-accent', 'data-action': 'start', text: '在终端里开始' });
    const cancel = el('button', { type: 'button', class: 'btn', text: '取消' });
    const close = el('button', { type: 'button', class: 'icon-circle', 'aria-label': '关闭' }, [icon('close')]);
    const note = el('p', { class: 'sw-new-note', role: 'status' });
    function sync() {
      start.disabled = !chosen || !kind;
      note.classList.remove('bad');
      note.textContent = !['claude', 'codex', 'grok', 'pi', 'antigravity'].some(k => clis[k]) ? '本机没有找到 Claude Code、Codex、Grok、pi 或 Antigravity 的命令行程序，请先安装。' : !chosen ? '先选一个项目文件夹。' : guardNote(clis.guarded?.[kind]) ? (clis.guarded[kind] === 'region' ? '这个工具设了出口地区白名单：' : '这个工具设了出口 IP 白名单：') + guardNote(clis.guarded[kind]) : '';
    }
    const card = el('section', { class: 'modal-card sw-new-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sw-new-title' }, [
      el('header', { class: 'sw-new-head' }, [el('div', {}, [
        el('h2', { id: 'sw-new-title', text: folder ? '在新项目里开始' : '开一个新对话' }),
        el('p', { text: '会打开一个终端窗口，在项目文件夹里启动所选的工具。新对话开始后会出现在会话列表里（点刷新）。' })
      ]), close]),
      el('div', { class: 'sw-new-field' }, [el('span', { class: 'sw-new-label', text: '项目文件夹' }), el('div', { class: 'sw-new-folder-row' }, [select, browse]), path]),
      el('div', { class: 'sw-new-field' }, [el('span', { class: 'sw-new-label', text: '用哪个工具' }), tools]),
      note,
      el('footer', { class: 'sw-new-foot' }, [cancel, start]),
    ]);
    const modal = el('div', { class: 'modal', id: 'sw-new' }, [card]);
    const shut = () => { if (closeNewModal === shut) closeNewModal = null; modal.remove(); document.removeEventListener('keydown', onKey, true); last?.focus?.(); };
    closeNewModal = shut;
    const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); shut(); } };
    select.addEventListener('change', () => { chosen = select.value; path.textContent = chosen; path.title = chosen; sync(); });
    browse.addEventListener('click', async () => {
      const picked = await api.pickProjectFolder?.(chosen || undefined).catch(() => null);
      if (picked) { chosen = picked; drawFolders(); }
    });
    close.addEventListener('click', shut); cancel.addEventListener('click', shut);
    modal.addEventListener('click', event => { if (event.target === modal) shut(); });
    document.addEventListener('keydown', onKey, true);
    start.addEventListener('click', async () => {
      start.disabled = true;
      try {
        const result = await api.startSession(kind, chosen);
        shut();
        showStatus(guardNote(result?.guarded) ? `已打开终端。${guardNote(result.guarded)}` : `已在终端里打开 ${AGENTS[kind].name}。发出第一条消息后，点刷新就能在列表里看到这段新对话。`);
        // 新会话要等 CLI 写出文件：过一会儿自己刷新一次
        setTimeout(() => { if (state.page === 'sessions') loadList(true, true); }, 15000);
      } catch (error) {
        note.textContent = cleanError(error, '打不开终端，请确认对应的 CLI 已安装。'); note.classList.add('bad');
        start.disabled = false;
      }
    });
    drawFolders(); drawTools(); sync();
    document.body.append(modal);
    (start.disabled ? browse : start).focus();
  }

  /* ---------------- 列表与子代理树 ---------------- */

  function subagentKindText(kind) {
    return kind === 'swarm' ? 'Swarm' : kind === 'review' ? '审查' : '子代理';
  }
  function subagentDisplayName(item) {
    if (!item) return '';
    return String(item.agentName || item.subagentRole || '').trim();
  }
  function subRoleBadge(item, extraCls = '') {
    if (!item?.isSubagent) return null;
    const isSwarm = item.subagentKind === 'swarm';
    const isReview = item.subagentKind === 'review';
    const kindText = subagentKindText(item.subagentKind);
    const name = subagentDisplayName(item);
    const cls = `sw-role-tag ${isSwarm ? 'is-swarm' : isReview ? 'is-review' : 'is-sub'} ${extraCls}`.trim();
    const tip = [item.subagentRole && item.subagentRole !== name ? item.subagentRole : '', item.swarmTitle ? `Swarm: ${item.swarmTitle}` : ''].filter(Boolean).join(' · ');
    return el('span', { class: cls, title: tip || null }, [
      el('span', { class: 'sw-role-kind', text: kindText, translate: isSwarm ? 'no' : null }),
      name ? el('span', { class: 'sw-role-sep', text: '·', translate: 'no' }) : null,
      name ? el('span', { class: 'sw-role-name', text: name, translate: 'no' }) : null,
    ].filter(Boolean));
  }

  /** 构建根会话 → 后代子代理索引（按 S.items 引用缓存，避免重绘重复遍历）。 */
  function buildTree() {
    if (treeCache.items === S.items && treeCache.data) return treeCache.data;
    const byKey = new Map();
    for (const item of S.items) byKey.set(item.key, item);
    const anchorOf = new Map();
    const descendantsByRoot = new Map();
    const childrenByRoot = new Map();
    const directChildren = new Map();
    let subagentTotal = 0;

    const resolveAnchor = item => {
      if (!item?.isSubagent) return '';
      if (item.rootKey && item.rootKey !== item.key && byKey.has(item.rootKey) && !byKey.get(item.rootKey).isSubagent) {
        return item.rootKey;
      }
      let cur = item;
      const seen = new Set([item.key]);
      let top = '';
      for (let hop = 0; hop < 8; hop++) {
        const pk = cur.parentKey;
        if (!pk || seen.has(pk) || !byKey.has(pk)) break;
        seen.add(pk);
        top = pk;
        cur = byKey.get(pk);
        if (!cur.isSubagent) break;
      }
      if (!top && item.rootKey && item.rootKey !== item.key && byKey.has(item.rootKey)) top = item.rootKey;
      return top;
    };

    for (const item of S.items) {
      if (!item.isSubagent) continue;
      subagentTotal += 1;
      if (item.parentKey && byKey.has(item.parentKey)) {
        const list = directChildren.get(item.parentKey) || [];
        list.push(item);
        directChildren.set(item.parentKey, list);
      }
      const anchor = resolveAnchor(item);
      if (anchor) {
        anchorOf.set(item.key, anchor);
        const list = descendantsByRoot.get(anchor) || [];
        list.push(item);
        descendantsByRoot.set(anchor, list);
      }
    }
    const byRecent = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
    for (const list of directChildren.values()) list.sort(byRecent);
    for (const [anchor, rawList] of descendantsByRoot) {
      const ordered = [];
      const visited = new Set([anchor]);
      const walk = parentKey => {
        const kids = directChildren.get(parentKey);
        if (!kids) return;
        for (const child of kids) {
          if (visited.has(child.key) || anchorOf.get(child.key) !== anchor) continue;
          visited.add(child.key);
          ordered.push(child);
          walk(child.key);
        }
      };
      walk(anchor);
      if (ordered.length < rawList.length) {
        const rest = rawList.filter(item => !visited.has(item.key)).sort(byRecent);
        for (const item of rest) {
          if (visited.has(item.key)) continue;
          visited.add(item.key);
          ordered.push(item);
          walk(item.key);
        }
      }
      childrenByRoot.set(anchor, ordered);
    }
    const data = { byKey, anchorOf, childrenByRoot, directChildren, subagentTotal };
    treeCache = { items: S.items, data };
    return data;
  }

  function matches(item) {
    if (S.kind !== 'all' && item.kind !== S.kind) return false;
    if (S.project !== 'all' && item.project !== S.project) return false;
    const q = S.search.trim().toLowerCase();
    if (!q) return true;
    if (S.hits?.has(item.key)) return true;
    return [
      item.title, item.project, item.cwd, item.preview,
      item.agentName, item.subagentRole, item.swarmTitle,
      item.isSubagent ? subagentKindText(item.subagentKind) : '',
      AGENTS[item.kind]?.name, ...(item.models || []),
    ].filter(Boolean).join(' ').toLowerCase().includes(q);
  }

  function visibleRows() {
    const tree = buildTree();
    const searching = Boolean(S.search.trim());
    if (S.showSubagents) {
      return S.items.filter(matches).map(item => ({
        item, isTreeChild: false, isFlatSub: Boolean(item.isSubagent), depth: 0, kids: tree.childrenByRoot.get(item.key) || [], matchedKids: [],
      }));
    }
    const rows = [];
    for (const item of S.items) {
      if (tree.anchorOf.has(item.key)) continue;
      const allKids = tree.childrenByRoot.get(item.key) || [];
      const kids = allKids.filter(child => (S.kind === 'all' || child.kind === S.kind) && (S.project === 'all' || child.project === S.project || item.project === S.project));
      if (searching) {
        const selfMatch = matches(item);
        const matchedKids = kids.filter(matches);
        if (!selfMatch && !matchedKids.length) continue;
        rows.push({ item, isTreeChild: false, isFlatSub: Boolean(item.isSubagent), depth: 0, kids, matchedKids });
        const toShow = matchedKids.length ? matchedKids : (S.expandedParents.has(item.key) ? kids : []);
        for (const child of toShow) {
          rows.push({ item: child, isTreeChild: true, isFlatSub: false, parentKey: item.key, depth: Math.min(3, Math.max(1, child.depth || 1)), kids: [], matchedKids: [] });
        }
      } else {
        if (!matches(item)) continue;
        rows.push({ item, isTreeChild: false, isFlatSub: Boolean(item.isSubagent), depth: 0, kids, matchedKids: [] });
        if (S.expandedParents.has(item.key) && kids.length) {
          for (const child of kids) {
            rows.push({ item: child, isTreeChild: true, isFlatSub: false, parentKey: item.key, depth: Math.min(3, Math.max(1, child.depth || 1)), kids: [], matchedKids: [] });
          }
        }
      }
    }
    return rows;
  }

  function visibleItems() { return visibleRows().map(row => row.item); }

  /* ---------------- 全文搜索（0.3.55） ---------------- */

  async function searchContent() {
    const q = S.search.trim();
    const seq = ++S.searchSeq;
    if (q.replace(/\s+/g, '').length < 2) {
      S.hits = null; S.terms = []; S.searching = false; S.searchNote = '';
      S.listLimit = LIST_CHUNK;
      setJump(); drawList(); drawMain(false); return;
    }
    S.searching = true; S.searchNote = '正在搜索对话内容…';
    drawList();
    try {
      const result = await api.searchSessions(q, 'all');
      if (seq !== S.searchSeq) return;
      S.hits = new Map((result?.hits || []).map(hit => [hit.key, hit]));
      S.terms = result?.terms || [];
      const messages = [...S.hits.values()].reduce((sum, hit) => sum + hit.count, 0);
      S.searchNote = S.hits.size ? `对话内容里有 ${number(S.hits.size)} 段会话命中，共 ${number(messages)} 条消息` : '对话内容里没有找到';
      if (result?.indexed > 20) S.searchNote += `（刚整理了 ${number(result.indexed)} 段会话的文字，以后会快很多）`;
    } catch {
      if (seq !== S.searchSeq) return;
      S.hits = null; S.terms = [];
      S.searchNote = '对话内容没搜成，只按标题和项目筛选';
    } finally {
      if (seq === S.searchSeq) { S.searching = false; S.listLimit = LIST_CHUNK; drawList(); setJump(); drawMain(false); }
    }
  }

  /** 正在看的会话有命中：记下命中的消息，但不自动跳（不打断正在读的位置）。 */
  function setJump(key = S.key) {
    S.quiet = '';
    const hit = S.search.trim() ? S.hits?.get(key) : null;
    S.jump = hit?.ids?.length ? { key, ids: hit.ids, index: -1 } : null;
  }

  /** 把文字里的搜索词包成 <mark>。只生成 DOM 节点。 */
  function highlight(text, terms = S.terms) {
    if (!terms.length) return [text];
    const re = new RegExp(terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
    const out = [];
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (!m[0]) { re.lastIndex += 1; continue; }
      if (m.index > last) out.push(text.slice(last, m.index));
      out.push(el('mark', { class: 'sw-hl', text: m[0] }));
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  /** 已经画好的消息里，把搜索词高亮出来（Markdown 画完以后再做，免得拆坏代码块和表格）。 */
  function highlightIn(root) {
    if (!S.terms.length || !S.search.trim() || S.quiet === S.key) return;
    for (const box of root.querySelectorAll('.sw-plain, .sw-rich, .sw-tool-sum')) {
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        const lower = node.nodeValue.toLowerCase();
        if (!S.terms.some(term => lower.includes(term))) continue;
        node.replaceWith(...highlight(node.nodeValue));
        box.closest('[data-mid]')?.classList.add('sw-hit');
      }
    }
  }

  function drawList() {
    const tree = buildTree();
    const basePool = S.showSubagents ? S.items : S.items.filter(item => !tree.anchorOf.has(item.key));
    const counts = { all: basePool.length, claude: 0, codex: 0, grok: 0, deepseek: 0, pi: 0, antigravity: 0 };
    for (const item of basePool) counts[item.kind] = (counts[item.kind] || 0) + 1;
    N.kinds.replaceChildren(el('span', { class: 'seg-thumb', 'aria-hidden': 'true' }), ...['all', 'claude', 'codex', 'grok', 'deepseek', 'pi', 'antigravity'].filter(kind => kind !== 'antigravity' || counts.antigravity > 0 || S.kind === kind).map(kind =>
      el('button', { type: 'button', 'data-kind': kind, class: S.kind === kind ? 'on' : '', 'aria-pressed': String(S.kind === kind), title: `${kind === 'all' ? '全部' : AGENTS[kind].short} · ${number(counts[kind] || 0)} 个会话` }, [
        kind === 'all' ? '全部' : AGENTS[kind].short, el('small', { text: number(counts[kind] || 0) })
      ])));
    syncSeg(N.kinds);
    // 项目下拉：按会话数排序
    const projects = new Map();
    for (const item of basePool) if (S.kind === 'all' || item.kind === S.kind) projects.set(item.project, (projects.get(item.project) || 0) + 1);
    if (S.project !== 'all' && !projects.has(S.project)) S.project = 'all';
    N.project.replaceChildren(el('option', { value: 'all', text: `全部项目（${number(projects.size)}）` }),
      ...[...projects].sort((a, b) => b[1] - a[1]).map(([name, n]) => el('option', { value: name, text: `${name}（${number(n)}）`, translate: 'no' })));
    N.project.value = S.project;
    if (N.subToggle) {
      N.subToggle.classList.toggle('on', S.showSubagents);
      N.subToggle.setAttribute('aria-pressed', String(S.showSubagents));
      N.subToggle.title = tree.subagentTotal > 0
        ? `当前共 ${number(tree.subagentTotal)} 个子代理会话；开启后按时间平铺显示，关闭时折叠在主会话下`
        : '开启后按时间平铺显示所有子代理与 Swarm 对话；关闭时折叠在主会话下';
    }

    const rows = visibleRows();
    const topCount = rows.filter(row => !row.isTreeChild).length;
    N.count.textContent = number(S.showSubagents ? rows.length : topCount);
    N.searchNote.textContent = S.search.trim() ? S.searchNote : '';
    N.searchNote.classList.toggle('busy', S.searching);
    if (S.loading && !S.items.length) { N.list.replaceChildren(el('div', { class: 'sw-list-note' }, [el('span', { class: 'sw-spinner' }), '正在读取本机会话…'])); return; }
    if (!S.items.length) { N.list.replaceChildren(el('div', { class: 'sw-list-note', text: S.loaded ? '还没有找到本机 Agent 的会话。' : '' })); return; }
    if (!rows.length) { N.list.replaceChildren(el('div', { class: 'sw-list-note', text: '没有符合条件的会话。' })); return; }
    // 若当前选中项在更靠后的位置，自适应扩展 listLimit 保证选中项立即可见
    if (S.key) {
      const activeIdx = rows.findIndex(row => row.item.key === S.key);
      if (activeIdx >= S.listLimit) {
        S.listLimit = Math.min(rows.length, Math.ceil((activeIdx + 1) / LIST_CHUNK) * LIST_CHUNK);
      }
    }
    const renderLimit = Math.min(rows.length, Math.max(LIST_CHUNK, S.listLimit));
    const searching = Boolean(S.search.trim());
    const nodes = [];
    let group = '';
    for (let i = 0; i < renderLimit; i++) {
      const row = rows[i];
      const item = row.item;
      if (!row.isTreeChild) {
        const g = groupOf(item.updatedAt);
        if (g !== group) { group = g; nodes.push(el('div', { class: 'sw-group', text: g })); }
      }
      const active = item.key === S.key;
      const hit = searching ? S.hits?.get(item.key) : null;
      const snippet = hit?.snippets?.[0];

      const hasUsage = item.usage && item.usage.tokens > 0;
      const usageBadge = hasUsage
        ? el('span', { class: 'sw-item-usage', translate: 'no', text: `${compact(item.usage.tokens)}${item.usage.costUsd > 0 ? ' · ≈' + usd(item.usage.costUsd) : ''}` })
        : el('span', { class: 'sw-item-usage unrecorded', text: '未统计用量' });

      const avgLat = item.avgRoundDurationMs || item.usage?.avgRoundDurationMs;
      const isEstLat = item.kind === 'claude' || item.kind === 'codex' || item.kind === 'grok';
      const latencyBadge = !row.isTreeChild && avgLat > 0
        ? el('span', { class: 'sw-item-latency', title: isEstLat ? '均轮耗时（估算值）' : '均轮耗时' }, [
            el('span', { class: 'sw-item-latency-icon', text: '⏱️' }),
            formatLatency(avgLat, isEstLat)
          ])
        : null;

      const primaryModel = item.models && item.models.length ? item.models[0] : '';
      const modelBadge = primaryModel
        ? el('span', { class: 'sw-item-model mono', translate: 'no', text: primaryModel, title: item.models.join(', ') })
        : null;

      const kids = row.kids || [];
      const subCount = Math.max(item.subagentCount || 0, kids.length);
      const isSwarmRoot = Boolean(item.hasSwarm || kids.some(c => c.subagentKind === 'swarm'));
      const isExpanded = (!searching && S.expandedParents.has(item.key)) || (searching && (row.matchedKids?.length > 0 || S.expandedParents.has(item.key)));
      const subBadge = !row.isTreeChild && subCount > 0
        ? (!S.showSubagents && kids.length > 0
            ? el('button', {
                type: 'button',
                class: `sw-sub-pill-toggle${isSwarmRoot ? ' is-swarm' : ''}${isExpanded ? ' open' : ''}`,
                'data-toggle-parent': item.key,
                'aria-expanded': String(isExpanded),
                title: isExpanded ? '收起子代理会话' : '展开查看子代理会话',
              }, [
                el('span', { text: isSwarmRoot ? 'Swarm' : '子代理', translate: isSwarmRoot ? 'no' : null }),
                el('span', { class: 'sw-sub-pill-dot', text: '·', translate: 'no' }),
                el('span', { text: number(subCount), translate: 'no' }),
                icon('chevron', 'icon sw-sub-caret'),
              ])
            : el('span', { class: `sw-sub-pill-static${isSwarmRoot ? ' is-swarm' : ''}` }, [
                el('span', { text: isSwarmRoot ? 'Swarm' : '子代理', translate: isSwarmRoot ? 'no' : null }),
                el('span', { class: 'sw-sub-pill-dot', text: '·', translate: 'no' }),
                el('span', { text: number(subCount), translate: 'no' }),
              ]))
        : null;

      const parentHint = (row.isTreeChild && row.depth >= 2 && item.parentKey && tree.byKey.get(item.parentKey))
        ? `上级：${subagentDisplayName(tree.byKey.get(item.parentKey)) || tree.byKey.get(item.parentKey).title}`
        : (row.isFlatSub && item.parentKey && tree.byKey.get(item.parentKey))
          ? `主会话：${tree.byKey.get(item.parentKey).title}`
          : '';
      const roleTag = (row.isTreeChild || row.isFlatSub) ? subRoleBadge(item) : null;
      if (roleTag && parentHint) roleTag.title = parentHint;
      const rowTitle = item.title || subagentDisplayName(item) || '未命名会话';

      const itemCls = [
        'sw-item',
        active ? 'active' : '',
        hit ? 'has-hit' : '',
        row.isTreeChild ? 'is-subagent' : '',
        row.isFlatSub ? 'is-subagent-flat' : '',
      ].filter(Boolean).join(' ');

      nodes.push(el('div', {
        class: itemCls,
        role: 'option',
        tabindex: '0',
        'aria-selected': String(active),
        'data-key': item.key,
        'data-depth': row.isTreeChild ? String(row.depth) : null,
        'data-parent': row.parentKey || item.parentKey || null,
      }, [
        mark(item.kind, row.isTreeChild ? 'sw-mark sm' : 'sw-mark'),
        el('span', { class: 'sw-item-body' }, [
          el('span', { class: 'sw-item-top' }, [
            roleTag,
            el('b', { text: rowTitle, title: rowTitle, translate: 'no' }),
            el('time', { text: shortTime(item.updatedAt) }),
          ].filter(Boolean)),
          el('span', { class: 'sw-item-meta' }, [
            !row.isTreeChild ? el('span', { class: 'sw-item-project', text: item.project, translate: 'no' }) : null,
            subBadge,
            modelBadge,
            el('span', { class: 'sw-item-turns', text: `${number(item.turns)} 轮` }),
            usageBadge,
            latencyBadge,
            hit ? el('span', { class: 'sw-hit-count', text: `${number(hit.count)} 处` }) : null
          ].filter(Boolean)),
          snippet ? el('span', { class: 'sw-item-snippet', translate: 'no', title: snippet.text }, [el('small', { text: snippet.role === 'user' ? '你：' : snippet.role === 'tool' ? '工具：' : 'AI：' }), ...highlight(snippet.text)]) : null
        ])
      ]));
    }
    if (renderLimit < rows.length) {
      const remaining = rows.length - renderLimit;
      const moreBtn = el('button', { type: 'button', class: 'btn sw-list-more', text: `加载更多（剩余 ${number(remaining)} 项）` });
      moreBtn.addEventListener('click', () => {
        S.listLimit = Math.min(rows.length, S.listLimit + LIST_CHUNK);
        drawList();
      });
      nodes.push(el('div', { class: 'sw-list-more-wrap' }, [moreBtn]));
    }
    const savedScroll = N.list.scrollTop;
    N.list.replaceChildren(...nodes);
    N.list.scrollTop = savedScroll;
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
      if (S.openKey) {
        const target = findOpenTarget(S.openKey); S.openKey = '';
        if (target) revealAndSelect(target);
        else showStatus('找不到这个会话', true);
      } else if (!S.key && S.items.length) select(visibleItems()[0]?.key || S.items[0].key);
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
    // 搜索结果里点的正好是现在开着的这段：直接跳到第一处
    if (!changed && S.jump?.key === key && S.jump.index < 0 && S.detail?.key === key) { S.jump.index = 0; drawMain(false); return; }
    if (changed) {
      S.key = key; S.visible = MSG_CHUNK; S.openGroups.clear(); S.subBarOpen = false;
      // 从搜索结果点进来：打开后直接跳到第一处命中
      setJump(key);
      if (S.jump && S.search.trim()) S.jump.index = 0;
    }
    drawList();
    const item = S.items.find(entry => entry.key === key);
    if (!item) return;
    const seq = ++S.detailSeq;
    S.detailError = '';
    if (changed || !S.detail) { S.detail = null; S.detailLoading = true; drawMain(); }
    try {
      const detail = await api.sessionDetail(item.kind, item.id);
      if (seq !== S.detailSeq || S.key !== key) return;
      S.detail = detail;
      if (!detail) S.detailError = '对话读取失败，请重试。';
    } catch {
      if (seq !== S.detailSeq || S.key !== key) return;
      S.detailError = '对话读取失败，请重试。';
      showStatus('这个会话读取失败，请重试。', true);
    } finally {
      if (seq === S.detailSeq && S.key === key) { S.detailLoading = false; drawMain(!keepScroll); }
    }
  }

  function usageBox(d) {
    const u = d.usage;
    const isEst = d.kind === 'claude' || d.kind === 'codex' || d.kind === 'grok';

    if (!u || !(u.tokens > 0)) {
      const avgLat = d.avgRoundDurationMs;
      const pills = el('div', { class: 'sw-usage-pills' }, [
        el('span', { class: 'sw-usage-pill faint', text: '未统计用量' }),
        avgLat > 0 ? el('span', { class: 'sw-usage-pill', text: `⏱️ 均轮 ${formatLatency(avgLat, isEst)}` }) : null
      ].filter(Boolean));

      const toggleText = el('span', { text: S.usageOpen ? '收起用量详情' : '用量详情' });
      const toggle = el('button', { type: 'button', class: 'sw-usage-toggle', 'aria-expanded': String(S.usageOpen) }, [
        toggleText,
        icon('chevron', 'icon sw-caret')
      ]);
      const bar = el('div', { class: 'sw-usage-bar' }, [
        pills,
        el('div', { class: 'sw-usage-right' }, [toggle])
      ]);

      const emptyState = el('div', { class: 'sw-usage-empty' }, [
        el('span', { class: 'sw-usage-empty-icon' }, [icon('usage')]),
        el('b', { class: 'sw-usage-empty-title', text: '该会话未记录 Token 用量' }),
        el('p', { class: 'sw-usage-empty-desc', text: '由于 CLI 记录格式或未启用用量统计，未获取到详细 Token 消耗' })
      ]);
      const panel = el('div', { class: 'sw-usage-panel', hidden: S.usageOpen ? null : '' }, [emptyState]);

      toggle.addEventListener('click', () => {
        S.usageOpen = !S.usageOpen;
        panel.hidden = !S.usageOpen;
        toggle.setAttribute('aria-expanded', String(S.usageOpen));
        toggleText.textContent = S.usageOpen ? '收起用量详情' : '用量详情';
        if (window.PulseI18n?.lang() === 'en') window.PulseI18n.apply(toggleText);
      });
      return [bar, panel];
    }

    const models = u.models || [];
    const pills = el('div', { class: 'sw-usage-pills' }, [
      el('span', { class: 'sw-usage-pill', text: `总 Token ${compact(u.tokens)}`, title: `输入 ${number(u.input)} / 输出 ${number(u.output)}${u.reasoning ? ' / 思考 ' + number(u.reasoning) : ''}` }),
      el('span', { class: 'sw-usage-pill', text: `缓存命中 ${(u.cacheHitRate || 0).toFixed(1)}%` }),
      el('span', { class: 'sw-usage-pill', text: `API 等价 ≈ ${usd(u.costUsd)}` }),
      u.cacheSavedUsd > 0.0001 ? el('span', { class: 'sw-usage-pill good', text: `缓存省下 ≈ ${usd(u.cacheSavedUsd)}` }) : null,
      u.avgRoundDurationMs ? el('span', { class: 'sw-usage-pill', text: `⏱️ 均轮 ${formatLatency(u.avgRoundDurationMs, isEst)}` }) : null
    ].filter(Boolean));

    const miniBar = models.length ? el('div', { class: 'sw-usage-mini-bar', 'aria-hidden': 'true' }, models.map((m, i) => paint(
      el('span', { class: 'sw-usage-mini-seg', title: `${m.model}: ${(m.tokenShare || 0).toFixed(1)}%` }),
      { width: `${Math.max(3, m.tokenShare || 0)}%`, background: MODEL_COLORS[i % MODEL_COLORS.length] }
    ))) : null;

    const toggleText = el('span', { text: S.usageOpen ? '收起用量详情' : '用量详情' });
    const toggle = el('button', { type: 'button', class: 'sw-usage-toggle', 'aria-expanded': String(S.usageOpen) }, [
      toggleText,
      icon('chevron', 'icon sw-caret')
    ]);
    const bar = el('div', { class: 'sw-usage-bar' }, [
      pills,
      el('div', { class: 'sw-usage-right' }, [miniBar, toggle])
    ]);

    const kpi = (label, val, sub, extra = '') => el('div', { class: `sw-usage-kpi ${extra}`.trim() }, [
      el('small', { class: 'sw-usage-kpi-label', text: label }),
      el('b', { class: 'sw-usage-kpi-val', text: val, translate: 'no' }),
      el('span', { class: 'sw-usage-kpi-sub', text: sub })
    ]);

    const avgLat = u.avgRoundDurationMs || d.avgRoundDurationMs;
    const latFormatted = avgLat > 0 ? formatLatency(avgLat, isEst) : '—';
    const speedSub = u.avgTokensPerSec
      ? `⚡ ${u.avgTokensPerSec} T/s${u.totalActiveDurationMs ? ' · 总活动 ' + formatDuration(u.totalActiveDurationMs) : ''}`
      : (u.totalActiveDurationMs ? `活动耗时 ${formatDuration(u.totalActiveDurationMs)}` : '未测得速度');

    const kpis = el('div', { class: 'sw-usage-kpis' }, [
      kpi('总 Token 消耗', compact(u.tokens), `输入 ${compact(u.input)} · 输出 ${compact(u.output)}${u.reasoning ? ` · 思考 ${compact(u.reasoning)}` : ''}`),
      kpi('缓存命中率', `${(u.cacheHitRate || 0).toFixed(1)}%`, `缓存读 ${compact(u.cacheRead)}${u.cacheWrite ? ` · 缓存写 ${compact(u.cacheWrite)}` : ''}`),
      kpi('API 等价花费', `≈ ${usd(u.costUsd)}`, `共 ${number(u.requests)} 次模型调用 · 均每轮 ${compact(Math.round(u.tokens / Math.max(1, d.turns || 1)))}`),
      kpi('缓存省下费用', `≈ ${usd(u.cacheSavedUsd)}`, `无缓存原价 ≈ ${usd(u.uncachedCostUsd)}`, u.cacheSavedUsd > 0.0001 ? 'good' : ''),
      kpi('均轮耗时与速度', latFormatted, speedSub)
    ]);

    const shareOf = m => S.usageBasis === 'requests' ? (m.requestShare || 0) : S.usageBasis === 'cost' ? (m.costShare || 0) : (m.tokenShare || 0);
    const stack = el('div', { class: 'sw-model-stack' });
    const legend = el('div', { class: 'sw-model-legend' });
    const drawStack = () => {
      stack.replaceChildren(...models.map((m, i) => paint(
        el('span', { class: 'sw-model-seg', title: `${m.model}: ${shareOf(m).toFixed(1)}%` }),
        { width: `${Math.max(2, shareOf(m))}%`, background: MODEL_COLORS[i % MODEL_COLORS.length] }
      )));
      legend.replaceChildren(...models.map((m, i) => el('span', { class: 'sw-model-legend-item', translate: 'no' }, [
        paint(el('i', { class: 'sw-model-dot' }), { background: MODEL_COLORS[i % MODEL_COLORS.length] }),
        el('span', { class: 'sw-model-name', text: m.model }),
        el('small', { text: `${shareOf(m).toFixed(1)}%` })
      ])));
    };
    drawStack();
    const basisBtns = [['tokens', '按 Token'], ['requests', '按调用次数'], ['cost', '按 API 费用']].map(([key, label]) => {
      const btn = el('button', { type: 'button', class: 'sw-basis-btn' + (S.usageBasis === key ? ' on' : ''), 'data-basis': key, 'aria-pressed': String(S.usageBasis === key), text: label });
      btn.addEventListener('click', () => {
        S.usageBasis = key;
        for (const b of basisBtns) {
          const on = b.dataset.basis === key;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', String(on));
        }
        drawStack();
      });
      return btn;
    });
    const barHead = el('div', { class: 'sw-usage-bar-head' }, [
      el('span', { class: 'sw-usage-sec-title', text: '模型占比分布' }),
      el('div', { class: 'sw-usage-basis', role: 'group', 'aria-label': '模型占比分布' }, basisBtns)
    ]);

    const tableWrap = el('div', { class: 'sw-usage-table-wrap', tabindex: '0', role: 'region', 'aria-label': '模型用量明细' }, [
      el('table', { class: 'sw-usage-table' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: '模型' }),
          el('th', { text: '调用次数 / 占比' }),
          el('th', { text: '总 Token / 占比' }),
          el('th', { text: '输入 / 输出' }),
          el('th', { text: '均轮耗时' }),
          el('th', { text: '缓存命中率' }),
          el('th', { text: 'API 等价 / 占比' }),
          el('th', { text: '缓存省下' })
        ])]),
        el('tbody', {}, models.map((m, i) => el('tr', {}, [
          el('td', { class: 'sw-usage-model-cell', translate: 'no' }, [
            paint(el('i', { class: 'sw-model-dot' }), { background: MODEL_COLORS[i % MODEL_COLORS.length] }),
            el('code', { text: m.model })
          ]),
          el('td', { text: `${number(m.requests)} 次 (${(m.requestShare || 0).toFixed(1)}%)` }),
          el('td', { text: `${compact(m.tokens)} (${(m.tokenShare || 0).toFixed(1)}%)`, translate: 'no' }),
          el('td', { text: `${compact(m.input)} / ${compact(m.output)}`, translate: 'no' }),
          el('td', { text: m.avgRoundDurationMs ? formatLatency(m.avgRoundDurationMs, isEst) : '—', translate: 'no' }),
          el('td', { text: `${(m.cacheHitRate || 0).toFixed(1)}%`, translate: 'no' }),
          el('td', { text: `≈ ${usd(m.costUsd)} (${(m.costShare || 0).toFixed(1)}%)`, translate: 'no' }),
          el('td', { class: m.cacheSavedUsd > 0.0001 ? 'good' : '', text: m.cacheSavedUsd > 0.0001 ? `≈ ${usd(m.cacheSavedUsd)}` : '—', translate: 'no' })
        ])))
      ])
    ]);

    const panel = el('div', { class: 'sw-usage-panel', hidden: S.usageOpen ? null : '' }, [
      kpis,
      models.length ? el('div', { class: 'sw-usage-models-sec' }, [barHead, stack, legend]) : null,
      models.length ? tableWrap : null
    ]);
    toggle.addEventListener('click', () => {
      S.usageOpen = !S.usageOpen;
      panel.hidden = !S.usageOpen;
      toggle.setAttribute('aria-expanded', String(S.usageOpen));
      toggleText.textContent = S.usageOpen ? '收起用量详情' : '用量详情';
      if (window.PulseI18n?.lang() === 'en') window.PulseI18n.apply(toggleText);
    });
    return [bar, panel];
  }

  function parentBar(d) {
    if (!d.isSubagent) return null;
    const tree = buildTree();
    const parentItem = (d.parentKey && tree.byKey.get(d.parentKey)) || (d.rootKey && tree.byKey.get(d.rootKey)) || null;
    const targetParentKey = parentItem?.key || d.parentKey || d.rootKey || '';
    const anchorKey = tree.anchorOf.get(d.key) || targetParentKey;
    const siblings = anchorKey ? (tree.childrenByRoot.get(anchorKey) || []) : [];

    const nodes = [subRoleBadge(d, 'lg')];
    if (d.swarmTitle) {
      nodes.push(el('span', { class: 'sw-sub-swarm-title', text: d.swarmTitle, title: d.swarmTitle, translate: 'no' }));
    }
    if (targetParentKey) {
      const backBtn = el('button', {
        type: 'button',
        class: 'btn sw-parent-btn',
        'data-action': 'open-parent',
        'data-parent-key': targetParentKey,
        title: parentItem?.title ? `返回主会话：${parentItem.title}` : '返回主会话',
      }, [
        el('span', { text: '↑', 'aria-hidden': 'true' }),
        el('span', { text: '返回主会话' }),
      ]);
      backBtn.addEventListener('click', () => {
        if (tree.byKey.has(targetParentKey)) revealAndSelect(targetParentKey);
        else window.PulseSessions?.open(targetParentKey);
      });
      nodes.push(backBtn);
    }
    if (siblings.length > 1) {
      const MAX_SIB = 4;
      if (siblings.length <= MAX_SIB) {
        const sibWrap = el('div', { class: 'sw-sib-pills', role: 'group', 'aria-label': '同组子代理' }, siblings.map(sib => {
          const isCur = sib.key === d.key;
          const label = subagentDisplayName(sib) || sib.title || sib.id.slice(0, 8);
          const btn = el('button', {
            type: 'button',
            class: `sw-sib-pill${isCur ? ' on' : ''}`,
            'aria-current': isCur ? 'true' : null,
            'data-open-sibling': sib.key,
            title: sib.title || label,
          }, [el('span', { text: label, translate: 'no' })]);
          if (!isCur) btn.addEventListener('click', () => revealAndSelect(sib.key));
          return btn;
        }));
        nodes.push(sibWrap);
      } else {
        const sibBtn = el('button', {
          type: 'button',
          class: 'btn sw-sib-menu-btn',
          'data-action': 'sibling-menu',
          'aria-haspopup': 'menu',
        }, [
          el('span', { text: `同组子代理（${number(siblings.length)}）` }),
          icon('chevron', 'icon sw-caret'),
        ]);
        sibBtn.addEventListener('click', () => {
          openOptionMenu(
            sibBtn,
            '切换同组子代理',
            siblings.map(sib => ({
              value: sib.key,
              label: subagentDisplayName(sib) || sib.title || sib.id.slice(0, 8),
              hint: sib.title && sib.title !== subagentDisplayName(sib) ? sib.title : `${number(sib.turns)} 轮`,
            })),
            d.key,
            key => { if (key && key !== d.key) revealAndSelect(key); },
          );
        });
        nodes.push(sibBtn);
      }
    }
    return el('div', { class: 'sw-parent-bar' }, nodes.filter(Boolean));
  }

  function subagentBar(d) {
    const tree = buildTree();
    const kids = tree.childrenByRoot.get(d.key) || tree.directChildren.get(d.key) || [];
    if (!kids.length && !(d.subagentCount > 0)) return null;
    const isSwarm = Boolean(d.hasSwarm || kids.some(c => c.subagentKind === 'swarm'));
    const total = Math.max(d.subagentCount || 0, kids.length);
    const MAX_COLLAPSED = 4;
    const shown = S.subBarOpen ? kids : kids.slice(0, MAX_COLLAPSED);

    const sub = d.subtreeUsage;
    const ownTokens = d.usage?.tokens || 0;
    const subtreePill = sub && sub.tokens > ownTokens
      ? el('span', {
          class: 'sw-sub-total',
          title: `主会话 ${compact(ownTokens)} + 子代理 ${compact(Math.max(0, sub.tokens - ownTokens))} · API 等价 ≈ ${usd(sub.costUsd)}`,
        }, [
          el('span', { text: '含子代理共' }),
          el('b', { text: compact(sub.tokens), translate: 'no' }),
        ])
      : null;

    const headLeft = el('div', { class: 'sw-sub-bar-left' }, [
      el('span', { class: `sw-sub-bar-title${isSwarm ? ' is-swarm' : ''}` }, [
        el('span', { text: isSwarm ? 'Swarm 成员' : '子代理会话' }),
        el('small', { text: number(total), translate: 'no' }),
      ]),
      d.swarmTitle ? el('span', { class: 'sw-sub-swarm-title', text: d.swarmTitle, title: d.swarmTitle, translate: 'no' }) : null,
      subtreePill,
    ].filter(Boolean));

    let moreBtn = null;
    if (kids.length > MAX_COLLAPSED) {
      moreBtn = el('button', {
        type: 'button',
        class: 'sw-usage-toggle sw-sub-more-btn',
        'aria-expanded': String(S.subBarOpen),
        'data-action': 'toggle-subbar',
      }, [
        el('span', { text: S.subBarOpen ? '收起' : `展开全部 ${number(kids.length)} 个` }),
        icon('chevron', 'icon sw-caret'),
      ]);
      moreBtn.addEventListener('click', () => {
        S.subBarOpen = !S.subBarOpen;
        drawMain(false);
      });
    }

    const pills = shown.map(child => {
      const label = subagentDisplayName(child) || child.title || child.id.slice(0, 8);
      const tok = child.usage?.tokens > 0 ? compact(child.usage.tokens) : '';
      const childSwarm = child.subagentKind === 'swarm';
      const btn = el('button', {
        type: 'button',
        class: `sw-sub-pill${childSwarm ? ' is-swarm' : ''}`,
        'data-open-child': child.key,
        title: `${child.title || label}${tok ? ` · ${tok} Tokens` : ''} · ${number(child.turns)} 轮`,
      }, [
        el('i', { class: 'sw-sub-dot', 'aria-hidden': 'true' }),
        el('b', { text: label, translate: 'no' }),
        tok ? el('small', { text: tok, translate: 'no' }) : null,
        el('small', { text: `${number(child.turns)} 轮` }),
      ].filter(Boolean));
      btn.addEventListener('click', () => revealAndSelect(child.key));
      return btn;
    });

    return el('div', { class: 'sw-sub-bar' }, [
      el('div', { class: 'sw-sub-bar-head' }, [headLeft, moreBtn].filter(Boolean)),
      pills.length ? el('div', { class: 'sw-sub-pills' }, pills) : null,
    ].filter(Boolean));
  }

  function header(d) {
    const item = S.items.find(entry => entry.key === d.key);
    const merged = item ? { ...item, ...d, usage: d.usage || item.usage, subtreeUsage: d.subtreeUsage || item.subtreeUsage } : d;
    const agent = AGENTS[merged.kind];

    const allModels = merged.models || [];
    const modelChips = allModels.slice(0, 2).map(model => el('span', { class: 'sw-chip mono', text: model }));
    if (allModels.length > 2) {
      const remainingModels = allModels.slice(2);
      const moreChip = el('button', { type: 'button', class: 'sw-chip mono sw-chip-more', title: remainingModels.join(', '), 'aria-label': '更多模型' }, [
        el('span', { text: `+${remainingModels.length}` })
      ]);
      moreChip.addEventListener('click', () => {
        openOptionMenu(moreChip, '涉及模型', allModels.map(m => ({ value: m, label: m })), null, () => {});
      });
      modelChips.push(moreChip);
    }

    const avgLat = merged.usage?.avgRoundDurationMs || merged.avgRoundDurationMs || item?.avgRoundDurationMs;
    const isEstLat = merged.kind === 'claude' || merged.kind === 'codex' || merged.kind === 'grok';
    const latencyChip = avgLat > 0
      ? el('span', { class: 'sw-chip sw-chip-latency', title: isEstLat ? '均轮耗时（估算值）' : '均轮耗时' }, [
          el('span', { class: 'sw-chip-icon', text: '⏱️' }),
          el('span', { text: `均轮 ${formatLatency(avgLat, isEstLat)}` })
        ])
      : null;

    const totalActiveMs = merged.usage?.totalActiveDurationMs;
    const activeChip = totalActiveMs > 0
      ? el('span', { class: 'sw-chip', title: '总活动耗时' }, [icon('clock'), el('span', { text: `活动 ${formatDuration(totalActiveMs)}` })])
      : null;

    const chips = [
      el('span', { class: 'sw-chip', title: merged.cwd || '', translate: 'no' }, [icon('folder'), merged.project]),
      el('span', { class: 'sw-chip' }, [mark(merged.kind, 'sw-chip-mark'), agent.name]),
      merged.createdAt ? el('span', { class: 'sw-chip', title: `${fullTime(merged.createdAt)} → ${fullTime(merged.updatedAt)}` }, [icon('clock'), `${shortTime(merged.createdAt)} → ${shortTime(merged.updatedAt)}`]) : null,
      el('span', { class: 'sw-chip' }, [icon('sessions'), `${number(merged.turns)} 轮对话`]),
      merged.toolCount ? el('span', { class: 'sw-chip' }, [icon('terminal'), `${number(merged.toolCount)} 次工具调用`]) : null,
      ...modelChips,
      activeChip,
      latencyChip
    ].filter(Boolean);

    const copyPath = button('复制项目地址', 'copy', 'btn', { title: merged.cwd || '这个会话没有记录项目地址' });
    copyPath.disabled = !merged.cwd;
    copyPath.addEventListener('click', () => copy(merged.cwd, '项目地址已复制'));
    const more = button('', 'more', 'btn icon-only', { title: '更多', 'aria-label': '更多操作', 'aria-haspopup': 'menu' });
    more.addEventListener('click', () => openMore(more, merged));
    return el('div', { class: 'sw-head' }, [
      parentBar(merged),
      el('div', { class: 'sw-head-top' }, [
        mark(merged.kind, 'sw-mark lg'),
        el('div', { class: 'sw-head-text' }, [el('h2', { text: merged.title, title: merged.title, translate: 'no' }), el('div', { class: 'sw-chips' }, chips)])
      ]),
      el('div', { class: 'sw-actions' }, [copyPath, more]),
      ...usageBox(merged),
      subagentBar(merged),
    ].filter(Boolean));
  }

  /** 「更多」菜单：终端、复制信息和永久删除。借用设置里的选项菜单样式。 */
  function openMore(anchor, d) {
    const canResume = d.resumable !== false && Boolean(d.resumeCommand) && d.kind !== 'deepseek' && !IDE_ONLY.has(d.kind);
    const menu = [
      canResume ? { value: 'terminal', label: '在终端里继续', hint: '打开 PowerShell，用 CLI 的交互界面接着这段会话' } : null,
      d.resumable !== false && d.resumeCommand ? { value: 'command', label: '复制继续命令', hint: d.resumeCommand } : null,
      { value: 'id', label: '复制会话 ID', hint: d.id },
      d.canDelete !== false ? { value: 'delete', label: '删除对话', hint: '永久删除这段会话，无法撤销', danger: true } : null,
    ].filter(Boolean);
    openOptionMenu(anchor, '更多操作', menu, null, async value => {
      if (value === 'command') {
        // Antigravity 桌面端的对话要先导入 CLI 的数据目录，粘贴命令才能接上历史
        if (d.kind === 'antigravity') {
          try { await api.prepareSessionResume?.(d.kind, d.id); }
          catch (error) { showStatus(cleanError(error, '没能把这段对话导入 Antigravity CLI。'), true); return; }
        }
        copy(d.resumeCommand, '继续命令已复制');
      }
      if (value === 'id') copy(d.id, '会话 ID 已复制');
      if (value === 'delete') await deleteConversation(d);
      if (value === 'terminal') {
        try {
          const result = await api.openSessionTerminal(d.kind, d.id);
          const note = result?.imported === 'imported' ? '已把桌面端的这段对话导入 Antigravity CLI，' : result?.imported === 'kept' ? 'CLI 里已接着聊过这段对话，沿用 CLI 那份，' : '';
          showStatus(guardNote(result?.guarded) ? '已打开终端。' + guardNote(result.guarded) : note ? note + '已在终端里打开。' : '已在终端里打开这段会话。');
        }
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
      S.items = await api.sessions();
      S.loaded = true; S.listAt = Date.now();
      S.key = ''; S.detail = null; S.detailLoading = false; S.visible = MSG_CHUNK; S.openGroups.clear();
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
    return el('div', { class: 'sw-tool-wrap', 'data-mid': tool.id }, [row, detail]);
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
    const footItems = [];

    if (!isUser && message.model) {
      footItems.push(el('span', { class: 'sw-bubble-model mono', translate: 'no', text: message.model }));
    }
    if (!isUser && typeof message.durationMs === 'number' && message.durationMs > 0) {
      const latText = formatLatency(message.durationMs, message.latencyEstimated);
      footItems.push(el('span', { class: 'sw-bubble-latency', title: message.latencyEstimated ? '耗时（估算值）' : '耗时' }, [
        el('span', { class: 'sw-chip-icon', text: '⏱️' }),
        latText
      ]));
    }
    if (!isUser && typeof message.tokensPerSec === 'number' && message.tokensPerSec > 0) {
      footItems.push(el('span', { class: 'sw-bubble-speed', title: '生成速度' }, [
        el('span', { class: 'sw-chip-icon', text: '⚡' }),
        `${message.tokensPerSec} T/s`
      ]));
    }
    if (message.at) {
      footItems.push(el('time', { text: hm(message.at), title: fullTime(message.at) }));
    }
    footItems.push(copyBtn);

    return el('div', { class: `sw-row ${message.role} ${extraClass}`.trim(), 'data-mid': message.id }, [
      isUser ? null : mark(kind, 'sw-avatar'),
      el('div', { class: 'sw-bubble' }, [
        isUser ? el('div', { class: 'sw-plain', text: message.text, translate: 'no' }) : rich(message.text),
        el('div', { class: 'sw-bubble-foot' }, footItems)
      ])
    ]);
  }

  function drawMessages(d, host) {
    const all = blocks(d.messages);
    const hidden = Math.max(0, all.length - S.visible);
    const nodes = [];

    // 计算每轮对话的轮次索引和耗时
    const turnMap = new Map();
    let currentTurnIndex = 0;
    let currentTurnUserBlock = null;

    for (const block of all) {
      if (block.role === 'user') {
        currentTurnIndex++;
        currentTurnUserBlock = block;
        turnMap.set(block, { index: currentTurnIndex, durationMs: undefined, estimated: false });
      } else if (block.role === 'assistant' && currentTurnUserBlock) {
        if (typeof block.durationMs === 'number' && block.durationMs > 0) {
          const entry = turnMap.get(currentTurnUserBlock);
          if (entry && !entry.durationMs) {
            entry.durationMs = block.durationMs;
            entry.estimated = Boolean(block.latencyEstimated);
          }
        }
      }
    }

    if (hidden || d.truncated) {
      const more = button(hidden ? `显示更早的 ${number(hidden)} 段` : '', 'up', 'btn sw-earlier');
      if (hidden) more.addEventListener('click', () => {
        if (!N.scroller) return;
        const scroller = N.scroller;
        const prevScrollHeight = scroller.scrollHeight;
        const prevScrollTop = scroller.scrollTop;
        S.visible = Math.min(all.length, S.visible + MSG_CHUNK);
        drawMessages(d, host);
        highlightIn(host);
        requestAnimationFrame(() => {
          if (N.scroller === scroller && scroller.isConnected) {
            const newScrollHeight = scroller.scrollHeight;
            scroller.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
          }
        });
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

      // 轮次分隔线（每轮提问前渲染清晰的轮次指示）
      if (block.role === 'user' && turnMap.has(block)) {
        const turnInfo = turnMap.get(block);
        const latTag = turnInfo.durationMs
          ? ` · 耗时 ${formatLatency(turnInfo.durationMs, turnInfo.estimated)}`
          : '';
        nodes.push(el('div', { class: 'sw-round-divider' }, [
          el('span', { class: 'sw-round-tag' }, [
            el('span', { text: `第 ${turnInfo.index} 轮${latTag}` })
          ])
        ]));
      }

      if (block.role === 'tools') nodes.push(toolGroup(block));
      else if (block.role === 'event') nodes.push(el('div', { class: 'sw-row event' }, [el('span', { text: block.text })]));
      else nodes.push(bubble(block, d.kind));
    }
    host.replaceChildren(...nodes);
  }

  function drawMain(toBottom = true) {
    if (!built) return;
    const item = S.items.find(entry => entry.key === S.key);
    if (!item && !S.detail) {
      N.main.replaceChildren(el('div', { class: 'sw-empty' }, [
        el('span', { class: 'sw-empty-icon' }, [icon('sessions')]),
        el('h2', { text: S.loaded ? '选择一个会话' : '正在读取会话…' }),
        el('p', { text: '左边是本机 Claude Code、Codex CLI、Grok Build、DeepSeek Harness、pi 和 Antigravity 的对话历史。选中后可以查看完整对话、复制项目地址或在终端里继续。' })
      ]));
      return;
    }
    const d = S.detail;
    if (!d) {
      if (!S.detailLoading && S.detailError) {
        const retry = el('button', { type: 'button', class: 'btn', text: '重试' });
        retry.addEventListener('click', () => select(S.key));
        N.main.replaceChildren(header({ ...item, messages: [] }), el('div', { class: 'sw-scroll' }, [el('div', { class: 'sw-list-note' }, [S.detailError, retry])]));
        return;
      }
      N.main.replaceChildren(header({ ...item, messages: [] }), el('div', { class: 'sw-scroll' }, [el('div', { class: 'sw-list-note' }, [el('span', { class: 'sw-spinner' }), '正在读取对话…'])]));
      return;
    }
    const previous = N.scroller;
    const offsetFromBottom = previous ? previous.scrollHeight - previous.scrollTop : 0;
    const jump = S.jump && S.jump.key === d.key ? S.jump : null;
    if (jump && jump.index >= 0) revealHit(d, jump.ids[jump.index]);
    N.scroller = el('div', { class: 'sw-scroll' });
    const inner = el('div', { class: 'sw-messages' });
    N.scroller.append(inner);
    let loadingEarlier = false;
    N.scroller.addEventListener('scroll', () => {
      if (loadingEarlier || !N.scroller) return;
      // 向上滚动接近顶部（<= 80px）时，自动触发懒加载前置更早的消息
      if (N.scroller.scrollTop <= 80) {
        const all = blocks(d.messages);
        if (S.visible < all.length) {
          loadingEarlier = true;
          const scroller = N.scroller;
          const prevScrollHeight = scroller.scrollHeight;
          const prevScrollTop = scroller.scrollTop;
          S.visible = Math.min(all.length, S.visible + MSG_CHUNK);
          drawMessages(d, inner);
          highlightIn(inner);
          requestAnimationFrame(() => {
            if (N.scroller === scroller && scroller.isConnected) {
              const newScrollHeight = scroller.scrollHeight;
              scroller.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
            }
            loadingEarlier = false;
          });
        }
      }
    }, { passive: true });
    drawMessages(d, inner);
    highlightIn(inner);
    N.main.replaceChildren(...[header(d), jump ? jumpBar(d, jump) : null, N.scroller].filter(Boolean));
    const hitNode = jump && jump.index >= 0 ? markHit(jump.ids[jump.index]) : null;
    const activeScroller = N.scroller;
    requestAnimationFrame(() => {
      if (N.scroller !== activeScroller || !activeScroller?.isConnected) return;
      if (hitNode?.isConnected) { hitNode.scrollIntoView({ block: 'center' }); return; }
      activeScroller.scrollTop = toBottom ? activeScroller.scrollHeight : activeScroller.scrollHeight - offsetFromBottom;
    });
  }

  /** 要跳到的那条在「显示更早的」后面、或者在收起的工具组里：放出来。 */
  function revealHit(d, id) {
    const all = blocks(d.messages);
    const index = all.findIndex(block => block.id === id || (block.role === 'tools' && block.items.some(tool => tool.id === id)));
    if (index < 0) return;
    if (index < all.length - S.visible) S.visible = all.length - index + 4;
    if (all[index].role === 'tools') S.openGroups.add(all[index].id);
  }
  function markHit(id) {
    const node = id && N.scroller?.querySelector(`[data-mid="${CSS.escape(id)}"]`);
    const hiddenAncestor = node?.closest('[hidden]');
    if (!node || (hiddenAncestor && N.scroller.contains(hiddenAncestor))) return null;
    N.scroller.querySelectorAll('.sw-hit-now').forEach(other => other.classList.remove('sw-hit-now'));
    node.classList.add('sw-hit-now');
    return node;
  }
  function scrollToHit(id) {
    const node = markHit(id);
    if (!node) return false;
    node.scrollIntoView({ block: 'center' });
    return true;
  }
  /** 「搜索：第 2 / 7 处」：上一处、下一处、不看了。 */
  function jumpBar(d, jump) {
    const total = jump.ids.length;
    const label = el('span', { class: 'sw-jump-label', text: jump.index >= 0 ? `「${S.search.trim()}」第 ${number(jump.index + 1)} / ${number(total)} 处` : `「${S.search.trim()}」在这段会话里有 ${number(total)} 处` });
    const go = step => {
      jump.index = jump.index < 0 ? (step > 0 ? 0 : total - 1) : (jump.index + step + total) % total;
      const id = jump.ids[jump.index];
      if (scrollToHit(id)) label.textContent = `「${S.search.trim()}」第 ${number(jump.index + 1)} / ${number(total)} 处`;
      else drawMain(false); // 在没放出来的地方：重画一次
    };
    const prev = button('', 'up', 'btn icon-only', { title: '上一处', 'aria-label': '上一处' });
    const next = button('', 'up', 'btn icon-only sw-jump-down', { title: '下一处', 'aria-label': '下一处' });
    const close = button('', 'close', 'btn icon-only', { title: '不看搜索结果了', 'aria-label': '关闭搜索定位' });
    prev.addEventListener('click', () => go(-1));
    next.addEventListener('click', () => go(1));
    close.addEventListener('click', () => { S.jump = null; S.quiet = d.key; drawMain(false); });
    return el('div', { class: 'sw-jump', role: 'toolbar', 'aria-label': '搜索结果定位' }, [icon('search'), label, prev, next, close]);
  }

  /* ---------------- 对外 ---------------- */

  function findOpenTarget(value) {
    const exact = S.items.find(item => item.key === value);
    if (exact) return exact.key;
    const split = value.indexOf(':');
    if (split <= 0) return '';
    const kind = value.slice(0, split), id = value.slice(split + 1);
    const fuzzy = S.items.find(item => item.kind === kind && (item.id === id || item.id.startsWith(id) || id.startsWith(item.id)));
    return fuzzy ? fuzzy.key : '';
  }
  function revealAndSelect(targetKey) {
    const tree = buildTree();
    const item = tree.byKey.get(targetKey);
    if (item) {
      if (S.kind !== 'all' && item.kind !== S.kind) S.kind = item.kind;
      if (S.project !== 'all' && item.project !== S.project) S.project = 'all';
      if (item.isSubagent) {
        const anchor = tree.anchorOf.get(item.key);
        if (anchor) S.expandedParents.add(anchor);
        else if (!S.showSubagents) S.showSubagents = true;
      }
      drawList();
    }
    let vis = visibleItems();
    let idx = vis.findIndex(entry => entry.key === targetKey);
    if (idx < 0 && item?.isSubagent && !S.showSubagents) {
      S.showSubagents = true;
      drawList();
      vis = visibleItems();
      idx = vis.findIndex(entry => entry.key === targetKey);
    }
    if (idx >= S.listLimit) { S.listLimit = idx + LIST_CHUNK; drawList(); }
    select(targetKey);
    requestAnimationFrame(() => N.list?.querySelector(`[data-key="${CSS.escape(targetKey)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }

  window.PulseSessions = {
    count() {
      return S.items?.length || 0;
    },
    open(key) {
      const value = String(key || ''), split = value.indexOf(':');
      const kind = split > 0 ? value.slice(0, split) : '', id = split > 0 ? value.slice(split + 1) : '';
      if (!['claude', 'codex', 'grok', 'deepseek', 'pi', 'antigravity'].includes(kind) || !id) return;
      S.kind = kind; S.project = 'all'; S.search = ''; S.hits = null; S.terms = []; S.searchSeq++; S.searching = false; S.searchNote = ''; S.jump = null; S.openKey = value;
      clearTimeout(searchTimer);
      if (N.search) N.search.value = '';
      navigate('sessions', { force: true });
      build();
      if (S.loaded) {
        drawList();
        const target = findOpenTarget(value);
        if (target) { S.openKey = ''; revealAndSelect(target); }
        else loadList(true);
      } else loadList();
    },
    hide() {
      if (N.scroller) N.scroller.replaceChildren();
      S.detail = null;
      N.drawn = false;
    },
    show() {
      build();
      drawList();
      if (!S.loaded) loadList();
      // 列表放了半分钟以上再悄悄刷新一遍（有索引缓存，几十毫秒）；对话区不跟着重画，免得打断阅读
      else if (Date.now() - S.listAt > 30000) loadList(false, true);
      if (!N.drawn) {
        N.drawn = true;
        if (S.key && !S.detail) {
          select(S.key, true);
        } else {
          drawMain(false);
        }
      }
    }
  };
})();
