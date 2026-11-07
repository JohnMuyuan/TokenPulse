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
  const LIST_CHUNK = 40;
  const MSG_CHUNK = 40;
  const S = {
    items: [], loaded: false, loading: false, listAt: 0,
    search: '', kind: 'all', project: 'all',
    key: '', detail: null, detailLoading: false, openKey: '',
    /** 会话列表当前渲染数量（分批分块渲染，初始 40 项）。 */
    listLimit: LIST_CHUNK,
    /** 从最后往前显示多少个「块」（一段工具调用算一块，初始 40 块）。 */
    visible: MSG_CHUNK,
    /** 正在进行的回复：{ runId, key, prompt, text, tools, error } */
    run: null,
    mode: 'readonly',
    drafts: {},
    openGroups: new Set(),
    usageOpen: false,
    usageBasis: 'tokens',
    /**
     * 0.3.55 全文搜索：hits 是这次搜内容命中的会话（key → { count, snippets, ids }），null = 没在搜内容；
     * terms 是搜索词（高亮用）；jump 是正在看的会话里「第几处」：{ key, ids, index }，index -1 = 还没跳。
     */
    hits: null, terms: [], searching: false, searchSeq: 0, searchNote: '', jump: null
  };
  let searchTimer = 0;
  const AGENTS = {
    claude: { name: 'Claude Code', short: 'Claude', brand: 'claude' },
    codex: { name: 'Codex CLI', short: 'Codex', brand: 'openai' },
    grok: { name: 'Grok Build', short: 'Grok', brand: 'grok' },
    deepseek: { name: 'DeepSeek Harness', short: 'DeepSeek', brand: 'deepseek' },
    pi: { name: 'pi', short: 'pi', brand: 'pi' },
    antigravity: { name: 'Antigravity', short: 'Antigravity', brand: 'antigravity' }
  };
  /** Antigravity 不是命令行工具：不能在终端里继续、不能在这里回复，只能看、搜、删。 */
  const IDE_ONLY = new Set(['antigravity']);
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
      N.project,
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
    // 列表向下滚动时自动追加下一批数据（每次追加 40 项）
    N.list.addEventListener('scroll', () => {
      if (N.list.scrollTop + N.list.clientHeight >= N.list.scrollHeight - 160) {
        const total = visibleItems().length;
        if (S.listLimit < total) {
          S.listLimit = Math.min(total, S.listLimit + LIST_CHUNK);
          drawList();
        }
      }
    }, { passive: true });
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
    document.getElementById('sw-new')?.remove();
    const last = document.activeElement;
    let clis = {};
    try { clis = await api.sessionClis?.() || {}; } catch { /* 查不到就当都没装，下面会提示 */ }
    const folders = knownFolders();
    let chosen = folder || currentFolder() || folders[0]?.cwd || '';
    const currentKind = S.detail?.kind || S.items.find(item => item.key === S.key)?.kind;
    let kind = [currentKind, 'claude', 'codex', 'grok', 'pi'].find(k => k && clis[k]) || '';

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
    const drawTools = () => tools.replaceChildren(...['claude', 'codex', 'grok', 'pi'].map(k => {
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
      note.textContent = !['claude', 'codex', 'grok', 'pi'].some(k => clis[k]) ? '本机没有找到 Claude Code、Codex、Grok 或 pi 的命令行程序，请先安装。' : !chosen ? '先选一个项目文件夹。' : guardNote(clis.guarded?.[kind]) ? (clis.guarded[kind] === 'region' ? '这个工具设了出口地区白名单：' : '这个工具设了出口 IP 白名单：') + guardNote(clis.guarded[kind]) : '';
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
    const shut = () => { modal.remove(); document.removeEventListener('keydown', onKey, true); last?.focus?.(); };
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

  /* ---------------- 列表 ---------------- */

  function matches(item) {
    if (S.kind !== 'all' && item.kind !== S.kind) return false;
    if (S.project !== 'all' && item.project !== S.project) return false;
    const q = S.search.trim().toLowerCase();
    if (!q) return true;
    if (S.hits?.has(item.key)) return true;
    return [item.title, item.project, item.cwd, item.preview, AGENTS[item.kind]?.name, ...(item.models || [])].filter(Boolean).join(' ').toLowerCase().includes(q);
  }
  function visibleItems() { return S.items.filter(matches); }

  /* ---------------- 全文搜索（0.3.55） ---------------- */

  async function searchContent() {
    const q = S.search.trim();
    const seq = ++S.searchSeq;
    if (q.replace(/\s+/g, '').length < 2) {
      S.hits = null; S.terms = []; S.searching = false; S.searchNote = '';
      S.listLimit = LIST_CHUNK;
      setJump(); drawList(); return;
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
    const counts = { all: S.items.length, claude: 0, codex: 0, grok: 0, deepseek: 0, pi: 0, antigravity: 0 };
    for (const item of S.items) counts[item.kind] = (counts[item.kind] || 0) + 1;
    N.kinds.replaceChildren(el('span', { class: 'seg-thumb', 'aria-hidden': 'true' }), ...['all', 'claude', 'codex', 'grok', 'deepseek', 'pi', 'antigravity'].filter(kind => kind !== 'antigravity' || counts.antigravity > 0 || S.kind === kind).map(kind =>
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
    N.searchNote.textContent = S.search.trim() ? S.searchNote : '';
    N.searchNote.classList.toggle('busy', S.searching);
    if (S.loading && !S.items.length) { N.list.replaceChildren(el('div', { class: 'sw-list-note' }, [el('span', { class: 'sw-spinner' }), '正在读取本机会话…'])); return; }
    if (!S.items.length) { N.list.replaceChildren(el('div', { class: 'sw-list-note', text: S.loaded ? '还没有找到本机 Agent 的会话。' : '' })); return; }
    if (!items.length) { N.list.replaceChildren(el('div', { class: 'sw-list-note', text: '没有符合条件的会话。' })); return; }
    // 若当前选中项在更靠后的位置，自适应扩展 listLimit 保证选中项立即可见
    if (S.key) {
      const activeIdx = items.findIndex(item => item.key === S.key);
      if (activeIdx >= S.listLimit) {
        S.listLimit = Math.min(items.length, Math.ceil((activeIdx + 1) / LIST_CHUNK) * LIST_CHUNK);
      }
    }
    const renderLimit = Math.min(items.length, Math.max(LIST_CHUNK, S.listLimit));
    const nodes = [];
    let group = '';
    for (let i = 0; i < renderLimit; i++) {
      const item = items[i];
      const g = groupOf(item.updatedAt);
      if (g !== group) { group = g; nodes.push(el('div', { class: 'sw-group', text: g })); }
      const active = item.key === S.key;
      const running = S.run && S.run.key === item.key;
      const hit = S.search.trim() ? S.hits?.get(item.key) : null;
      const snippet = hit?.snippets?.[0];

      const hasUsage = item.usage && item.usage.tokens > 0;
      const usageBadge = hasUsage
        ? el('span', { class: 'sw-item-usage', translate: 'no', text: `${compact(item.usage.tokens)}${item.usage.costUsd > 0 ? ' · ≈' + usd(item.usage.costUsd) : ''}` })
        : el('span', { class: 'sw-item-usage unrecorded', text: '未统计用量' });

      const avgLat = item.avgRoundDurationMs || item.usage?.avgRoundDurationMs;
      const isEstLat = item.kind === 'claude' || item.kind === 'codex' || item.kind === 'grok';
      const latencyBadge = avgLat > 0
        ? el('span', { class: 'sw-item-latency', title: isEstLat ? '均轮耗时（估算值）' : '均轮耗时' }, [
            el('span', { class: 'sw-item-latency-icon', text: '⏱️' }),
            formatLatency(avgLat, isEstLat)
          ])
        : null;

      const primaryModel = item.models && item.models.length ? item.models[0] : '';
      const modelBadge = primaryModel
        ? el('span', { class: 'sw-item-model mono', translate: 'no', text: primaryModel, title: item.models.join(', ') })
        : null;

      nodes.push(el('button', { type: 'button', class: `sw-item${active ? ' active' : ''}${hit ? ' has-hit' : ''}`, role: 'option', 'aria-selected': String(active), 'data-key': item.key }, [
        mark(item.kind),
        el('span', { class: 'sw-item-body' }, [
          el('span', { class: 'sw-item-top' }, [el('b', { text: item.title, title: item.title, translate: 'no' }), el('time', { text: shortTime(item.updatedAt) })]),
          el('span', { class: 'sw-item-meta' }, [
            el('span', { class: 'sw-item-project', text: item.project, translate: 'no' }),
            modelBadge,
            el('span', { class: 'sw-item-turns', text: `${number(item.turns)} 轮` }),
            usageBadge,
            latencyBadge,
            hit ? el('span', { class: 'sw-hit-count', text: `${number(hit.count)} 处` }) : null,
            running ? el('span', { class: 'sw-live', text: '回复中' }) : null
          ]),
          snippet ? el('span', { class: 'sw-item-snippet', translate: 'no', title: snippet.text }, [el('small', { text: snippet.role === 'user' ? '你：' : snippet.role === 'tool' ? '工具：' : 'AI：' }), ...highlight(snippet.text)]) : null
        ])
      ]));
    }
    if (renderLimit < items.length) {
      const remaining = items.length - renderLimit;
      const moreBtn = el('button', { type: 'button', class: 'btn sw-list-more', text: `加载更多（剩余 ${number(remaining)} 项）` });
      moreBtn.addEventListener('click', () => {
        S.listLimit = Math.min(items.length, S.listLimit + LIST_CHUNK);
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
        const key = S.openKey; S.openKey = '';
        if (S.items.some(item => item.key === key)) select(key);
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
      saveDraft(); S.key = key; S.visible = MSG_CHUNK; S.openGroups.clear();
      // 从搜索结果点进来：打开后直接跳到第一处命中
      setJump(key);
      if (S.jump && S.search.trim()) S.jump.index = 0;
    }
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

  function saveDraft() {
    if (S.key && N.input) {
      const keys = Object.keys(S.drafts);
      if (keys.length >= 50 && !S.drafts[S.key]) delete S.drafts[keys[0]];
      S.drafts[S.key] = N.input.value;
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

  function header(d) {
    const item = S.items.find(entry => entry.key === d.key);
    const merged = item && !d.usage ? { ...d, usage: item.usage } : d;
    const agent = AGENTS[d.kind];

    const allModels = d.models || [];
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
    const isEstLat = d.kind === 'claude' || d.kind === 'codex' || d.kind === 'grok';
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
      el('span', { class: 'sw-chip', title: d.cwd || '', translate: 'no' }, [icon('folder'), d.project]),
      el('span', { class: 'sw-chip' }, [mark(d.kind, 'sw-chip-mark'), agent.name]),
      d.createdAt ? el('span', { class: 'sw-chip', title: `${fullTime(d.createdAt)} → ${fullTime(d.updatedAt)}` }, [icon('clock'), `${shortTime(d.createdAt)} → ${shortTime(d.updatedAt)}`]) : null,
      el('span', { class: 'sw-chip' }, [icon('sessions'), `${number(d.turns)} 轮对话`]),
      d.toolCount ? el('span', { class: 'sw-chip' }, [icon('terminal'), `${number(d.toolCount)} 次工具调用`]) : null,
      ...modelChips,
      activeChip,
      latencyChip
    ].filter(Boolean);

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
      el('div', { class: 'sw-actions' }, [copyPath, d.kind === 'pi' || IDE_ONLY.has(d.kind) ? null : reply, more]),
      ...usageBox(merged)
    ]);
  }

  /** 「更多」菜单：终端、复制信息和永久删除。借用设置里的选项菜单样式。 */
  function openMore(anchor, d) {
    const menu = [
      d.kind === 'deepseek' || IDE_ONLY.has(d.kind) ? null : { value: 'terminal', label: '在终端里继续', hint: '打开 PowerShell，用 CLI 的交互界面接着这段会话' },
      d.resumeCommand ? { value: 'command', label: '复制继续命令', hint: d.resumeCommand } : null,
      { value: 'id', label: '复制会话 ID', hint: d.id },
      { value: 'delete', label: '删除对话', hint: '永久删除这段会话，无法撤销', danger: true },
    ].filter(Boolean);
    openOptionMenu(anchor, '更多操作', menu, null, async value => {
      if (value === 'command') copy(d.resumeCommand, '继续命令已复制');
      if (value === 'id') copy(d.id, '会话 ID 已复制');
      if (value === 'delete') await deleteConversation(d);
      if (value === 'terminal') {
        try { const result = await api.openSessionTerminal(d.kind, d.id); showStatus(guardNote(result?.guarded) ? '已打开终端。' + guardNote(result.guarded) : '已在终端里打开这段会话。'); }
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
        const prevScrollHeight = N.scroller.scrollHeight;
        const prevScrollTop = N.scroller.scrollTop;
        S.visible = Math.min(all.length, S.visible + MSG_CHUNK);
        drawMessages(d, host);
        highlightIn(host);
        requestAnimationFrame(() => {
          if (N.scroller) {
            const newScrollHeight = N.scroller.scrollHeight;
            N.scroller.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
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
    if (d.kind === 'pi') { N.input = null; return el('div', { class: 'sw-composer' }, [el('small', { text: 'pi 会话请在终端里继续。' })]); }
    if (IDE_ONLY.has(d.kind)) { N.input = null; return el('div', { class: 'sw-composer' }, [el('small', { text: 'Antigravity 的对话请在 Antigravity 里继续。删除时会请开着的 Antigravity 自己删。' })]); }
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
        el('p', { text: '左边是本机 Claude Code、Codex CLI、Grok Build、DeepSeek Harness 和 pi 的对话历史。选中后可以查看完整对话、复制项目地址或继续会话。' })
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
          const prevScrollHeight = N.scroller.scrollHeight;
          const prevScrollTop = N.scroller.scrollTop;
          S.visible = Math.min(all.length, S.visible + MSG_CHUNK);
          drawMessages(d, inner);
          highlightIn(inner);
          requestAnimationFrame(() => {
            if (N.scroller) {
              const newScrollHeight = N.scroller.scrollHeight;
              N.scroller.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
            }
            loadingEarlier = false;
          });
        }
      }
    }, { passive: true });
    drawMessages(d, inner);
    highlightIn(inner);
    const focused = document.activeElement === N.input;
    N.main.replaceChildren(...[header(d), jump ? jumpBar(d, jump) : null, N.scroller, composer(d)].filter(Boolean));
    if (focused) N.input?.focus();
    requestAnimationFrame(() => {
      if (jump && jump.index >= 0 && scrollToHit(jump.ids[jump.index])) return;
      N.scroller.scrollTop = toBottom ? N.scroller.scrollHeight : N.scroller.scrollHeight - offsetFromBottom;
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
  function scrollToHit(id) {
    const node = id && N.scroller?.querySelector(`[data-mid="${CSS.escape(id)}"]`);
    if (!node) return false;
    N.scroller.querySelectorAll('.sw-hit-now').forEach(other => other.classList.remove('sw-hit-now'));
    node.classList.add('sw-hit-now');
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
    count() {
      return S.items?.length || 0;
    },
    open(key) {
      const value = String(key || ''), split = value.indexOf(':');
      const kind = split > 0 ? value.slice(0, split) : '', id = split > 0 ? value.slice(split + 1) : '';
      if (!['claude', 'codex', 'grok', 'deepseek', 'pi', 'antigravity'].includes(kind) || !id) return;
      S.kind = kind; S.project = 'all'; S.search = ''; S.hits = null; S.terms = []; S.openKey = value;
      clearTimeout(searchTimer);
      if (N.search) N.search.value = '';
      navigate('sessions', { force: true });
      build();
      if (S.loaded) {
        drawList();
        if (S.items.some(item => item.key === value)) { S.openKey = ''; select(value); }
        else loadList(true);
      } else loadList();
    },
    hide() {
      saveDraft();
      if (N.scroller) N.scroller.replaceChildren();
      S.detail = null;
      N.drawn = false;
    },
    show() {
      build();
      drawList();
      if (!S.loaded) loadList();
      // 列表放了半分钟以上再悄悄刷新一遍（有索引缓存，几十毫秒）；对话区不跟着重画，免得打断阅读和输入
      else if (Date.now() - S.listAt > 30000 && !S.run) loadList(false, true);
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
