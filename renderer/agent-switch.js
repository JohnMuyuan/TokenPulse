'use strict';
/*
 * 供应商专区（0.3.9，Claude 重做）。
 *
 * 结构：左边二级菜单，右边一次只显示一块内容。
 *   概览 ─ 本地路由状态 + 四家工具各一张大卡（当前供应商、直连 / 路由、备用队列）
 *   工具 ─ Claude Code / Claude 桌面端 / Codex / Grok CLI：当前供应商大卡 + 其他供应商列表（拖动排序、启用、编辑、检测、备用、删除）
 *   路由 ─ 本地路由（端口、各家开关、故障转移队列）、转发记录
 *   导入 ─ 从当前配置收下、从 CC Switch 导入
 * 新增 / 编辑供应商通过左侧步骤菜单操作。
 *
 * 用户不用 Gemini。密钥只在保存时提交，界面数据里只有末四位。
 * 模型候选按工具分开：Claude 按角色填多个模型，Codex 的每一行可以勾选多个思考等级，桌面端可直连或做角色映射。
 * 依赖 app.js 的全局函数：el、icon、avatar、showStatus、playChart、reducedMotion。CSP 不允许 style 属性，颜色走 CSSOM。
 */
(() => {
  const root = document.getElementById('page-providers');
  const api = window.tokenpulse;
  if (!root || !api?.agentState) return;

  const APPS = [
    { id: 'claude', name: 'Claude Code', kind: 'claude' },
    { id: 'desktop', name: 'Claude 桌面端', kind: 'claude' },
    { id: 'codex', name: 'Codex', kind: 'chatgpt' },
    { id: 'grok', name: 'Grok CLI', kind: 'grok' },
  ];
  const NATIVE = { claude: 'anthropic', desktop: 'anthropic', codex: 'openai-responses', grok: 'openai-responses' };
  const CLAUDE_ROLES = [['sonnet', 'Sonnet', true], ['opus', 'Opus', true], ['fable', 'Fable', true], ['haiku', 'Haiku', false], ['subagent', '子代理', true]];
  const DESKTOP_ROLES = [['sonnet', 'Sonnet', true], ['opus', 'Opus', true], ['fable', 'Fable', true], ['haiku', 'Haiku', true]];
  const LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const FORMATS = [['anthropic', 'Anthropic'], ['openai-chat', 'OpenAI Chat'], ['openai-responses', 'OpenAI Responses']];
  const HUES = ['#4f7fd9', '#d9774f', '#10a37f', '#8b5cf6', '#c9832f', '#e05a8a', '#0ea5a4', '#65a30d'];
  const SECTION_KEY = 'tokenpulse-providers-section';

  const SECTIONS = ['overview', 'claude', 'desktop', 'codex', 'grok', 'router', 'logs', 'import'];
  let view = null, signature = '', section = 'overview', editor = null, editorPane = 'basic', dragging = null, entered = false;
  try { const saved = localStorage.getItem(SECTION_KEY); if (saved) section = saved; } catch { /* 读不到就从概览开始 */ }

  const appOf = id => APPS.find(a => a.id === id);
  const formatName = id => FORMATS.find(f => f[0] === id)?.[1] || id || '—';
  const paint = (node, props) => { for (const [k, v] of Object.entries(props)) k.startsWith('--') ? node.style.setProperty(k, v) : (node.style[k] = v); return node; };
  const providersOf = app => (view?.providers || []).filter(p => p.app === app);
  const currentOf = app => providersOf(app).find(p => p.active) || null;
  const routeAddress = app => `http://127.0.0.1:${view.proxy.port}/${app === 'codex' || app === 'grok' ? app + '/v1' : app}`;
  /** 故障转移的顺序：当前那家在前，后面按列表顺序排加入了备用的。 */
  const queueOf = app => { const cur = currentOf(app); return [cur, ...providersOf(app).filter(p => p.failover && p !== cur)].filter(Boolean); };
  const healthText = h => h === 'open' ? '暂时跳过（连续失败）' : h === 'degraded' ? '最近失败过' : '正常';

  function button(label, onClick, cls = 'btn', iconName) {
    const b = el('button', { type: 'button', class: cls }, [iconName ? icon(iconName) : null, label ? el('span', { text: label }) : null]);
    b.addEventListener('click', onClick);
    return b;
  }
  function iconButton(iconName, title, onClick, cls = '') {
    const b = el('button', { type: 'button', class: 'pv-icon-btn ' + cls, title, 'aria-label': title }, [icon(iconName)]);
    b.addEventListener('click', e => { e.stopPropagation(); onClick(e); });
    return b;
  }
  function appMark(app, cls = '') { return avatar(appOf(app)?.kind || app, cls); }
  /** 第三方供应商没有官方图标：用名字首字母 + 按名字固定的颜色。 */
  function providerMark(p) {
    if (p.official) return appMark(p.app, 'pv-mark');
    let h = 0; for (const c of p.name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return paint(el('span', { class: 'pv-mark pv-letter', 'aria-hidden': 'true', text: [...p.name.trim()][0]?.toUpperCase() || '?' }), { '--hue': HUES[h % HUES.length] });
  }
  function healthDot(p) {
    const h = view.health[p.id] || 'ok';
    return el('i', { class: 'pv-dot ' + h, title: healthText(h), 'aria-label': healthText(h) });
  }

  /* ---------------- 调后端 ---------------- */

  async function run(work, okText) {
    let result;
    try { result = await work(); } catch (error) { result = { ok: false, error: error?.message }; }
    if (!result?.ok) { showStatus(result?.error || '操作失败', true); return null; }
    if (result.state) { view = result.state; signature = sig(view); render(false); }
    const text = result.state?.notice || (typeof okText === 'function' ? okText(result) : okText);
    if (text) showStatus(text);
    return result;
  }
  function sig(data) {
    return JSON.stringify([data.providers.map(p => [p.id, p.name, p.active, p.direct, p.failover, p.baseUrl, p.model, p.upstream, p.keyHint, p.notes, p.sort, p.slots, p.desktopMode, p.contextWindow, p.thinking]), data.proxy.apps, data.proxy.running, data.proxy.port, data.health, (data.logs || []).length && data.logs[0]?.at]);
  }

  /* ---------------- 整体结构 ---------------- */

  function render(animate) {
    if (!view) return;
    if (!SECTIONS.includes(section)) section = 'overview';
    const main = el('div', { class: 'pv-main', role: 'tabpanel', 'aria-label': editor ? '编辑供应商' : sectionTitle() });
    if (editor) main.append(editorForm());
    else {
      const body = { overview, claude: () => appSection('claude'), desktop: () => appSection('desktop'), codex: () => appSection('codex'), grok: () => appSection('grok'), router, logs, import: importSection }[section]();
      main.append(...[].concat(body));
    }
    const layout = el('div', { class: 'pv' }, [editor ? editorNav() : nav(), main]);
    root.replaceChildren(layout);
    if (animate) playChart(main, true);
  }
  function go(next) {
    if (next === section) return;
    section = next;
    try { localStorage.setItem(SECTION_KEY, next); } catch { /* 记不住就算了 */ }
    render(true);
    root.querySelector(`.pv-nav [data-section="${next}"]`)?.focus();
  }
  function sectionTitle() {
    return { overview: '概览', router: '本地路由', logs: '转发记录', import: '导入供应商' }[section] || appOf(section)?.name || '';
  }

  /** 二级菜单：概览 / 四家工具 / 路由 / 导入。每项带一句当前状态，不用点进去也知道现在是什么情况。 */
  function nav() {
    const item = (id, label, sub, lead, badge) => {
      const b = el('button', { type: 'button', class: 'pv-nav-item' + (section === id ? ' on' : ''), 'data-section': id, role: 'tab', 'aria-selected': String(section === id) }, [
        lead,
        el('span', { class: 'pv-nav-text' }, [el('b', { text: label }), sub ? el('small', { text: sub, translate: 'no' }) : null]),
        badge || null,
      ]);
      b.addEventListener('click', () => go(id));
      return b;
    };
    const lead = name => el('span', { class: 'pv-nav-icon' }, [icon(name)]);
    const routeOn = APPS.filter(a => view.proxy.apps[a.id]).length;
    const groups = [
      [null, [item('overview', '概览', null, lead('overview'))]],
      ['工具', APPS.map(a => {
        const cur = currentOf(a.id);
        const badge = view.proxy.apps[a.id] ? el('span', { class: 'pv-nav-badge route', text: '路由' }) : null;
        return item(a.id, a.name, cur ? cur.name : '未选择', appMark(a.id, 'pv-nav-avatar'), badge);
      })],
      ['本地路由', [
        item('router', '路由服务', view.proxy.running ? `运行中 · ${routeOn} 家` : '已停止', lead('route'), el('i', { class: 'pv-dot ' + (view.proxy.running ? 'ok' : 'off') })),
        item('logs', '转发记录', null, lead('trace'), (view.logs || []).length ? el('span', { class: 'pv-nav-badge', text: String(view.logs.length) }) : null),
      ]],
      ['管理', [item('import', '导入供应商', null, lead('download'))]],
    ];
    const box = el('nav', { class: 'pv-nav', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': '供应商菜单' });
    for (const [title, items] of groups) box.append(el('div', { class: 'pv-nav-group' }, [title ? el('span', { class: 'pv-nav-title', text: title }) : null, ...items]));
    // 上下方向键在菜单里移动
    box.addEventListener('keydown', e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const list = [...box.querySelectorAll('.pv-nav-item')], i = list.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length].focus();
    });
    return box;
  }
  function head(title, sub, actions = [], lead = null) {
    return el('div', { class: 'pv-head' }, [el('div', { class: 'pv-head-title' }, [lead, el('div', {}, [el('h2', { text: title }), sub ? el('p', { text: sub }) : null])]), el('div', { class: 'pv-head-actions' }, actions)]);
  }

  /* ---------------- 概览 ---------------- */

  function overview() {
    const on = APPS.filter(a => view.proxy.apps[a.id]);
    const rate = view.proxy.requests ? Math.round(view.proxy.ok / view.proxy.requests * 100) : null;
    const status = el('section', { class: 'pv-hero' + (view.proxy.running ? ' on' : '') }, [
      el('div', { class: 'pv-hero-state' }, [el('i', { class: 'pv-pulse' }), el('div', {}, [
        el('b', { text: view.proxy.running ? '本地路由运行中' : '本地路由没有运行' }),
        el('small', { text: view.proxy.running ? `${on.map(a => a.name).join('、')} 的请求经 TokenPulse 转发` : '四家工具都直连各自的供应商' }),
      ])]),
      el('div', { class: 'pv-hero-stats' }, [
        stat('转发', String(view.proxy.requests)),
        stat('成功率', rate == null ? '—' : rate + '%'),
        stat('端口', String(view.proxy.port)),
      ]),
      button('管理路由', () => go('router'), 'btn', 'route'),
    ]);
    const cards = el('div', { class: 'pv-app-grid' }, APPS.map((a, i) => appCard(a, i)));
    return [head('概览', '四家工具现在用的是谁、走直连还是本地路由。点卡片进入管理。'), status, cards];
  }
  function stat(label, value) { return el('div', { class: 'pv-stat' }, [el('small', { text: label }), el('strong', { text: value, translate: 'no' })]); }
  function appCard(a, i) {
    const cur = currentOf(a.id), routed = !!view.proxy.apps[a.id], queue = queueOf(a.id);
    const card = el('button', { type: 'button', class: `pv-app-card ${a.id}` }, [
      el('div', { class: 'pv-app-card-top' }, [appMark(a.id), el('b', { text: a.name }), el('span', { class: 'pv-mode ' + (routed ? 'route' : 'direct'), text: routed ? '本地路由' : '直连' })]),
      el('div', { class: 'pv-app-current' }, cur
        ? [el('small', { text: '当前供应商' }), el('strong', { text: cur.name, translate: 'no' }), el('span', { translate: 'no', text: cur.official ? '官方登录' : [cur.model, formatName(cur.upstream)].filter(Boolean).join(' · ') })]
        : [el('small', { text: '当前供应商' }), el('strong', { class: 'muted', text: '没有识别到' }), el('span', { text: '工具配置里的地址没有对上任何一家' })]),
      el('div', { class: 'pv-app-card-foot' }, [
        el('span', { text: `${providersOf(a.id).length} 家供应商` }),
        routed && queue.length > 1 ? el('span', { text: `故障转移 ${queue.length - 1} 家备用` }) : null,
        el('span', { class: 'pv-go' }, [icon('arrow')]),
      ]),
    ]);
    paint(card, { '--i': i });
    card.addEventListener('click', () => go(a.id));
    return card;
  }

  /* ---------------- 单个工具 ---------------- */

  function appSection(app) {
    const a = appOf(app), cur = currentOf(app), routed = !!view.proxy.apps[app];
    const mode = el('div', { class: 'seg compact pv-mode-seg', role: 'group', 'aria-label': '连接方式' }, [el('span', { class: 'seg-thumb', 'aria-hidden': 'true' }),
      ...[['direct', '直连'], ['route', '本地路由']].map(([id, label]) => {
        const on = (id === 'route') === routed;
        const b = el('button', { type: 'button', class: on ? 'on' : null, 'aria-pressed': String(on), text: label });
        b.addEventListener('click', () => { if (!on) toggleRoute(app, id === 'route'); });
        return b;
      })]);
    const actions = [mode, button('添加供应商', () => openDrawer(app), 'btn btn-accent', 'plus')];
    const others = providersOf(app).filter(p => p !== cur);
    const list = el('div', { class: 'pv-list', role: 'list', 'aria-label': `${a.name} 的供应商` }, others.map((p, i) => providerRow(p, i)));
    if (!others.length) list.append(el('div', { class: 'pv-empty' }, [el('p', { text: '还没有别的供应商。' }), button('添加供应商', () => openDrawer(app), 'btn', 'plus')]));
    const out = [
      head(a.name, routed ? `本地路由开着：${a.name} 连 ${routeAddress(app)}，由 TokenPulse 转发给下面选中的供应商。` : `直连：${a.name} 的配置里写的就是当前供应商的地址。`, actions, appMark(app, 'pv-head-avatar')),
      cur ? currentCard(cur, routed) : el('div', { class: 'pv-current empty' }, [el('b', { text: '没有识别到当前供应商' }), el('p', { text: '工具配置里的地址没有对上下面任何一家。可以在「导入供应商」里把现在的配置收下来。' })]),
      el('div', { class: 'pv-list-head' }, [el('h3', { text: '其他供应商' }), el('small', { text: '拖动左边的把手调整顺序；本地路由的故障转移按这个顺序依次尝试加入了备用的供应商。' })]),
      list,
    ];
    requestAnimationFrame(() => syncSeg(mode));
    return out;
  }
  function currentCard(p, routed) {
    const facts = p.official
      ? [fact('登录', '使用工具自己的官方登录')]
      : [fact('请求地址', p.baseUrl, true), fact('模型', p.model || '—', true), fact('接口格式', formatName(p.upstream) + (p.cross ? '（和工具不同，经本地路由转换）' : '')), fact('密钥', p.hasKey ? `••••${p.keyHint}` : '未填', true)];
    if (routed) facts.push(fact('工具连的地址', routeAddress(p.app), true));
    return el('section', { class: 'pv-current' }, [
      el('div', { class: 'pv-current-top' }, [providerMark(p), el('div', {}, [el('small', { text: '当前供应商' }), el('b', { text: p.name, translate: 'no' })]), healthDot(p),
        el('div', { class: 'pv-current-actions' }, p.official || p.locked ? [] : [
          button('检测连通', () => probe(p), 'btn', 'refresh'),
          button('编辑', () => openDrawer(p.app, p), 'btn', 'edit'),
        ])]),
      el('div', { class: 'pv-facts' }, facts),
      p.notes ? el('p', { class: 'pv-notes', text: p.notes, translate: 'no' }) : null,
    ]);
  }
  function fact(label, value, raw) { return el('div', { class: 'pv-fact' }, [el('small', { text: label }), el('span', { text: value, translate: raw ? 'no' : null })]); }

  function providerRow(p, i) {
    const queueIndex = view.proxy.apps[p.app] ? queueOf(p.app).indexOf(p) : -1;
    const sub = p.official ? '官方登录' : p.locked ? '登录凭证由原来的工具保存' : [p.model, formatName(p.upstream), p.hasKey ? `••••${p.keyHint}` : null].filter(Boolean).join(' · ');
    const row = el('div', { class: 'pv-row', role: 'listitem', tabindex: '0', 'data-id': p.id, draggable: 'true', 'aria-label': p.name }, [
      el('span', { class: 'pv-grip', title: '拖动排序（也可以按 Alt + ↑ / ↓）', 'aria-hidden': 'true' }, [icon('grip')]),
      providerMark(p),
      el('div', { class: 'pv-row-main' }, [
        el('div', { class: 'pv-row-name' }, [el('b', { text: p.name, translate: 'no' }), healthDot(p),
          p.failover ? el('span', { class: 'pv-tag', text: queueIndex > 0 ? `备用 ${queueIndex}` : '备用' }) : null,
          p.cross ? el('span', { class: 'pv-tag warn', text: '需要本地路由' }) : null]),
        el('small', { text: sub, translate: 'no' }),
      ]),
      el('div', { class: 'pv-row-actions' }, p.locked ? [] : [
        p.official ? null : iconButton('refresh', '检测连通', () => probe(p)),
        p.official ? null : iconButton('edit', '编辑', () => openDrawer(p.app, p)),
        p.official ? null : iconButton('restore', p.failover ? '移出备用' : '加入备用', () => run(() => api.agentFailover(p.id, !p.failover), p.failover ? '已移出备用' : '已加入备用'), p.failover ? 'on' : ''),
        p.official && p.id.startsWith('official-') ? null : iconButton('trash', '删除', e => remove(p, e.currentTarget), 'danger'),
        button('启用', () => activate(p), 'btn btn-accent pv-use'),
      ]),
    ]);
    paint(row, { '--i': Math.min(i, 12) });
    row.addEventListener('keydown', e => { if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); move(p, e.key === 'ArrowUp' ? -1 : 1); } });
    dragHandlers(row, p);
    return row;
  }

  /* 拖动排序：放下时按新顺序提交；当前那家不在列表里，拼回最前面，保持它原来的位置不变 */
  function dragHandlers(row, p) {
    row.addEventListener('dragstart', e => { dragging = p.id; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', p.id); } catch { /* 有的环境不让写 */ } });
    row.addEventListener('dragend', () => { dragging = null; row.classList.remove('dragging'); root.querySelectorAll('.pv-row.drop-before, .pv-row.drop-after').forEach(n => n.classList.remove('drop-before', 'drop-after')); });
    row.addEventListener('dragover', e => {
      if (!dragging || dragging === p.id) return;
      e.preventDefault();
      const box = row.getBoundingClientRect(), after = e.clientY > box.top + box.height / 2;
      row.classList.toggle('drop-after', after); row.classList.toggle('drop-before', !after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', e => {
      e.preventDefault();
      const after = row.classList.contains('drop-after');
      row.classList.remove('drop-before', 'drop-after');
      if (!dragging || dragging === p.id) return;
      const ids = othersOf(p.app).filter(id => id !== dragging);
      ids.splice(ids.indexOf(p.id) + (after ? 1 : 0), 0, dragging);
      reorder(p.app, ids);
    });
  }
  /** 列表里显示的是「当前以外」的供应商：在这些里面调顺序，当前那家原地不动（不然按键会和看不见的当前那家交换）。 */
  function othersOf(app) { const cur = currentOf(app); return providersOf(app).filter(x => x !== cur).map(x => x.id); }
  function move(p, step) {
    const ids = othersOf(p.app), i = ids.indexOf(p.id), j = i + step;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder(p.app, ids).then(() => root.querySelector(`.pv-row[data-id="${CSS.escape(p.id)}"]`)?.focus());
  }
  function reorder(app, others) {
    const cur = currentOf(app), all = providersOf(app).map(x => x.id), ids = others.slice();
    if (cur) ids.splice(Math.min(all.indexOf(cur.id), ids.length), 0, cur.id);
    return run(() => api.agentReorder(app, ids), '已调整顺序');
  }

  async function activate(p) {
    await run(() => api.agentActivate(p.id), r => (r.result?.message || '已切换') + (r.result?.restart ? ' 换了模型的话，请重新打开这个工具。' : ''));
  }
  async function toggleRoute(app, on) {
    await run(() => api.agentProxy(app, on), on ? '本地路由已接上，TokenPulse 退出前会一直转发' : '已关闭本地路由，配置写回直连');
  }
  async function probe(p) {
    showStatus(`正在检测 ${p.name}…`);
    try {
      const r = await api.agentProbe(p.id);
      const ok = r?.result?.ok;
      showStatus(ok ? `${p.name} 能连上（HTTP ${r.result.status}）` : `${p.name} 连不上：${r?.result?.error || r?.error || '没有响应'}`, !ok);
    } catch (error) { showStatus(error?.message || '检测失败', true); }
  }
  /** 删除要点两次：第一次按钮变红提示「再点一次删除」，3 秒内再点才删（不弹系统对话框）。 */
  async function remove(p, btn) {
    if (!btn.classList.contains('confirm')) {
      btn.classList.add('confirm');
      btn.title = btn.ariaLabel = '再点一次删除';
      showStatus(`再点一次删除「${p.name}」`);
      clearTimeout(btn._reset);
      btn._reset = setTimeout(() => { btn.classList.remove('confirm'); btn.title = btn.ariaLabel = '删除'; }, 3000);
      return;
    }
    clearTimeout(btn._reset);
    await run(() => api.agentDelete(p.id), '已删除');
  }

  /* ---------------- 本地路由 ---------------- */

  function router() {
    const running = view.proxy.running;
    const port = el('input', { type: 'number', min: '1024', max: '65535', value: String(view.proxy.port), class: 'pv-port', 'aria-label': '端口', disabled: running ? '' : null });
    port.addEventListener('change', () => run(() => api.agentPort(Number(port.value)), '端口已保存'));
    const service = el('section', { class: 'pv-card' }, [
      el('div', { class: 'pv-card-row' }, [el('i', { class: 'pv-dot ' + (running ? 'ok' : 'off') }), el('div', { class: 'pv-grow' }, [el('b', { text: running ? '运行中' : '已停止' }), el('small', { text: running ? '收进托盘也会继续转发；退出 TokenPulse 时先把配置写回直连。' : '给任意一家打开本地路由，服务就会启动；全部关掉后自动停止。' })]),
        el('label', { class: 'pv-port-field' }, [el('span', { text: '端口' }), port])]),
      running ? null : el('small', { class: 'pv-hint', text: '端口只能在服务停止时修改。' }),
    ]);
    const rows = APPS.map((a, i) => {
      const on = !!view.proxy.apps[a.id], queue = queueOf(a.id);
      const toggle = el('button', { type: 'button', class: 'pv-switch' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(on), 'aria-label': `${a.name} 本地路由` }, [el('i')]);
      toggle.addEventListener('click', () => toggleRoute(a.id, !on));
      const chain = el('div', { class: 'pv-chain' }, queue.length ? queue.map((p, k) => el('span', { class: 'pv-chain-item' + (k ? '' : ' first') }, [el('small', { text: k ? `备用 ${k}` : '当前' }), el('b', { text: p.name, translate: 'no' }), healthDot(p)])) : [el('small', { class: 'muted', text: '还没有选定供应商' })]);
      return paint(el('div', { class: 'pv-route-row' + (on ? ' on' : '') }, [
        appMark(a.id),
        el('div', { class: 'pv-grow' }, [el('b', { text: a.name }), el('small', { translate: 'no', text: on ? routeAddress(a.id) : '直连，不经过 TokenPulse' }), on ? chain : null]),
        toggle,
      ]), { '--i': i });
    });
    return [
      head('路由服务', '本地路由把工具发来的请求转给你选的供应商：接口格式不同会自动转换；当前那家返回 429 / 5xx 或连不上时，按顺序换备用。'),
      service,
      el('div', { class: 'pv-list-head' }, [el('h3', { text: '各工具' }), el('small', { text: '备用顺序在各工具页面里拖动调整。' })]),
      el('div', { class: 'pv-route-list' }, rows),
    ];
  }

  /* ---------------- 转发记录 ---------------- */

  function logs() {
    const list = view.logs || [];
    const locale = window.PulseI18n?.lang() === 'en' ? 'en-US' : 'zh-CN';
    const table = list.length ? el('div', { class: 'pv-log' }, list.map((item, i) => paint(el('div', { class: 'pv-log-row' + (item.status >= 400 || item.error ? ' bad' : '') }, [
      appMark(item.app, 'pv-log-avatar'),
      el('span', { class: 'pv-log-time', translate: 'no', text: new Date(item.at).toLocaleTimeString(locale, { hour12: false }) }),
      el('b', { translate: 'no', text: item.provider }),
      el('span', { class: 'pv-log-model', translate: 'no', text: item.model || '—' }),
      el('span', { class: 'pv-log-status', translate: 'no', text: `HTTP ${item.status}` }),
      el('span', { class: 'pv-log-ms', translate: 'no', text: `${item.ms} ms` }),
      item.error ? el('small', { class: 'pv-log-error', text: item.error, translate: 'no' }) : null,
    ]), { '--i': Math.min(i, 16) }))) : el('div', { class: 'pv-empty' }, [el('p', { text: '还没有经过本地路由的请求。打开某一家的本地路由后，这里会列出最近的转发。' })]);
    return [head('转发记录', '最近经过本地路由的请求（最多 30 条）。用量统计仍按各工具自己的日志记账，不会因为转发重复计算。'), table];
  }

  /* ---------------- 导入 ---------------- */

  function importSection() {
    const live = el('section', { class: 'pv-card pv-import' }, [
      el('div', { class: 'pv-import-head' }, [el('span', { class: 'pv-nav-icon big' }, [icon('download')]), el('div', {}, [el('b', { text: '从工具现在的配置收下' }), el('small', { text: '把工具配置里正在用的第三方地址和密钥存成一家供应商。指向本地路由的配置不会被当成供应商。' })])]),
      el('div', { class: 'pv-import-apps' }, APPS.map(a => button(a.name, () => run(() => api.agentImportLive(a.id), `已收下 ${a.name} 现在的配置`), 'btn pv-import-app'))),
    ]);
    const cc = el('section', { class: 'pv-card pv-import' }, [
      el('div', { class: 'pv-import-head' }, [el('span', { class: 'pv-nav-icon big' }, [icon('route')]), el('div', {}, [el('b', { text: '从 CC Switch 导入' }), el('small', { text: '只读 ~/.cc-switch/cc-switch.db 里的供应商，不改它的数据库；已经导入过的会跳过，Gemini 的不导入。' })])]),
      button('开始导入', () => run(() => api.agentImportCc(), r => r.result?.found === false ? '没有找到 CC Switch 的数据库' : `导入了 ${r.result?.added ?? 0} 家，跳过 ${r.result?.skipped ?? 0} 家`), 'btn btn-accent'),
    ]);
    APPS.forEach((a, i) => paint(live.querySelectorAll('.pv-import-app')[i], { '--i': i }));
    return [head('导入供应商', '已有的配置可以直接收下，不用重新填写。'), live, cc];
  }

  /* ---------------- 新增 / 编辑抽屉 ---------------- */

  function blankSlot(role) {
    return { role, model: '', displayName: '', oneM: false, contextWindow: null, reasoningLevels: [], defaultReasoningLevel: '' };
  }
  function seedSlots(app, provider) {
    const saved = (provider?.slots || []).map(slot => ({ ...slot, reasoningLevels: [...(slot.reasoningLevels || [])] }));
    const roles = app === 'claude' ? CLAUDE_ROLES : app === 'desktop' ? DESKTOP_ROLES : null;
    if (roles) return roles.map(([role]) => saved.find(slot => slot.role === role) || { ...blankSlot(role), model: role === 'sonnet' ? (provider?.model || '') : '' });
    if (saved.length) return saved;
    return [{ ...blankSlot('catalog'), model: provider?.model || '', reasoningLevels: app === 'codex' ? ['low', 'medium', 'high'] : [], defaultReasoningLevel: app === 'codex' ? 'high' : '' }];
  }
  function levelChips(slot) {
    const box = el('div', { class: 'pv-levels' });
    const draw = () => {
      const choices = LEVELS.map(level => {
        const on = slot.reasoningLevels.includes(level);
        const b = el('button', { type: 'button', class: 'pv-level' + (on ? ' on' : ''), text: level, 'aria-pressed': String(on), title: on ? '取消此思考等级' : '允许此思考等级' });
        b.addEventListener('click', () => {
          slot.reasoningLevels = LEVELS.filter(item => item === level ? !on : slot.reasoningLevels.includes(item));
          if (!slot.reasoningLevels.includes(slot.defaultReasoningLevel)) slot.defaultReasoningLevel = slot.reasoningLevels.at(-1) || '';
          draw();
        });
        return b;
      });
      const select = el('select', { 'aria-label': '默认思考等级', disabled: slot.reasoningLevels.length ? null : '' },
        slot.reasoningLevels.length ? slot.reasoningLevels.map(level => el('option', { value: level, text: level })) : [el('option', { value: '', text: '未启用' })]);
      select.value = slot.defaultReasoningLevel;
      select.addEventListener('change', () => { slot.defaultReasoningLevel = select.value; });
      box.replaceChildren(...choices, el('label', { class: 'pv-default-level' }, ['默认等级', select]));
    };
    draw();
    return box;
  }
  function slotRow(slot, primary) {
    const model = el('input', { autocomplete: 'off', spellcheck: 'false', translate: 'no', value: slot.model, placeholder: '实际请求模型' });
    if (primary) model.name = 'model';
    model.addEventListener('input', () => { slot.model = model.value; });
    const name = el('input', { autocomplete: 'off', spellcheck: 'false', value: slot.displayName, placeholder: '菜单显示名' });
    name.addEventListener('input', () => { slot.displayName = name.value; });
    const row = el('div', { class: 'pv-slot', 'data-role': slot.role || 'catalog' }, [
      slot.role && slot.role !== 'catalog' ? el('b', { text: (CLAUDE_ROLES.find(item => item[0] === slot.role) || DESKTOP_ROLES.find(item => item[0] === slot.role) || [, slot.role])[1] }) : null,
      name,
      model,
    ]);
    const allowOneM = (CLAUDE_ROLES.find(item => item[0] === slot.role) || DESKTOP_ROLES.find(item => item[0] === slot.role) || [])[2];
    if (allowOneM) {
      const mark = el('button', { type: 'button', class: 'pv-level' + (slot.oneM ? ' on' : ''), text: '1M', title: '向工具声明这段上下文有 100 万' });
      mark.addEventListener('click', () => { slot.oneM = !slot.oneM; mark.classList.toggle('on', slot.oneM); });
      row.append(mark);
    }
    return row;
  }
  function modelSection(app, provider) {
    const box = el('div', { class: 'pv-models' });
    const hint = app === 'codex'
      ? '每一行是 Codex 菜单里的一个模型。点击勾选或取消思考等级，再从下拉菜单选择默认等级。'
      : app === 'desktop'
        ? '直连只接受 claude-sonnet / opus / haiku / fable 开头的模型名。映射模式把这些角色转到真实模型，请求走本地路由。'
        : app === 'grok'
          ? 'Grok CLI 用一个上游模型。上下文窗口写进它的模型表。接口是 Chat 时，可以声明上游支不支持思考。'
          : 'Claude Code 按角色用不同模型。留空的角色会沿用 Sonnet。1M 会写成模型名后面的 [1M]。';
    const head = el('div', { class: 'pv-model-head' }, [el('span', { text: app === 'codex' ? '模型目录' : '模型候选' }), el('small', { text: hint })]);
    const fetch = button('获取模型', async () => {
      const draft = editor, form = root.querySelector('.pv-editor');
      fetch.disabled = true;
      try {
        const result = await api.agentModels({ id: provider?.id, baseUrl: form?.elements.baseUrl.value, apiKey: form?.elements.apiKey.value, upstream: draft.upstream });
        if (editor !== draft || !form.isConnected) return;
        if (!result?.ok) { showStatus(result?.error || '获取模型失败', true); return; }
        draft.fetched = result.result || [];
        box.querySelector('.pv-fetched').replaceChildren(...draft.fetched.slice(0, 40).map(id => {
          const chip = el('button', { type: 'button', class: 'pv-level', text: id });
          chip.translate = false;
          chip.addEventListener('click', () => {
            if (app === 'grok') {
              const input = box.querySelector('input[name=model]');
              input.value = id;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              return;
            }
            const index = draft.slots.findIndex(slot => !slot.model);
            if (index < 0) { showStatus('没有空模型行，请先清空目标行或添加模型。', true); return; }
            const row = box.querySelectorAll('.pv-slot')[index];
            const input = row?.querySelector('input[placeholder="实际请求模型"]');
            if (input) { input.value = id; input.dispatchEvent(new Event('input', { bubbles: true })); }
            const name = row?.querySelector('input[placeholder="菜单显示名"]');
            if (name && !name.value) { name.value = id; name.dispatchEvent(new Event('input', { bubbles: true })); }
          });
          return chip;
        }));
        showStatus(draft.fetched.length ? '点击模型填入第一个空模型行（Grok 替换当前模型）' : '没有拿到模型');
      } catch (error) {
        if (editor === draft) showStatus(error?.message || '获取模型失败', true);
      } finally { fetch.disabled = false; }
    }, 'btn');
    head.append(fetch);
    box.append(head);
    if (app === 'desktop') {
      const modes = el('div', { class: 'pv-chips', role: 'radiogroup' });
      for (const [id, label] of [['direct', '直连'], ['map', '模型映射']]) {
        const b = el('button', { type: 'button', class: 'pv-chip' + (editor.desktopMode === id ? ' on' : ''), text: label });
        b.addEventListener('click', () => { editor.desktopMode = id; modes.querySelectorAll('.pv-chip').forEach(n => n.classList.toggle('on', n === b)); });
        modes.append(b);
      }
      box.append(modes);
    }
    if (app === 'grok') {
      box.append(el('label', { class: 'pv-field' }, [el('span', { text: '模型' }), el('input', { name: 'model', autocomplete: 'off', spellcheck: 'false', translate: 'no', value: provider?.model || '', required: '' })]));
      const contextInput = el('input', { type: 'number', min: '1', value: provider?.contextWindow || '', placeholder: '例如 128000' });
      contextInput.addEventListener('input', () => { editor.contextWindow = Number(contextInput.value) || null; });
      box.append(el('label', { class: 'pv-field' }, [el('span', { text: '上下文窗口' }), contextInput]));
      const thinking = el('div', { class: 'pv-levels' });
      for (const [key, label] of [['supportsThinking', '支持思考'], ['supportsEffort', '支持思考等级']]) {
        const b = el('button', { type: 'button', class: 'pv-level' + (editor.thinking[key] ? ' on' : ''), text: label });
        b.addEventListener('click', () => { editor.thinking[key] = !editor.thinking[key]; b.classList.toggle('on', editor.thinking[key]); });
        thinking.append(b);
      }
      box.append(thinking, el('div', { class: 'pv-fetched' }));
      return box;
    }
    const rows = el('div', { class: 'pv-slot-list' });
    const drawRows = () => {
      rows.replaceChildren(...editor.slots.map((slot, index) => {
        const row = slotRow(slot, index === 0);
        if (app === 'codex') {
          const context = el('input', { type: 'number', min: '1', value: slot.contextWindow || '', placeholder: '上下文' });
          context.addEventListener('input', () => { slot.contextWindow = Number(context.value) || null; });
          row.append(context, levelChips(slot));
          const remove = button('', () => { editor.slots.splice(index, 1); if (!editor.slots.length) editor.slots.push(blankSlot('catalog')); drawRows(); }, 'pv-icon-btn', 'close');
          row.append(remove);
        }
        return row;
      }));
    };
    drawRows();
    box.append(rows, el('div', { class: 'pv-fetched' }));
    if (app === 'codex') box.append(button('添加模型', () => { editor.slots.push(blankSlot('catalog')); drawRows(); }, 'btn'));
    if (app === 'claude') box.append(button('一键填到全部角色', () => {
      const value = editor.slots.find(slot => slot.model)?.model;
      if (!value) return;
      for (const slot of editor.slots) { slot.model = value; if (!slot.displayName) slot.displayName = value; }
      drawRows();
    }, 'btn'));
    return box;
  }

  function openDrawer(app, provider = null) {
    editorPane = 'basic';
    editor = { app, provider, upstream: provider?.upstream || NATIVE[app], keyField: provider?.apiKeyField || 'ANTHROPIC_AUTH_TOKEN', desktopMode: provider?.desktopMode || (app === 'desktop' ? 'map' : 'direct'), contextWindow: provider?.contextWindow || null, thinking: { supportsThinking: !!provider?.thinking?.supportsThinking, supportsEffort: !!provider?.thinking?.supportsEffort }, slots: seedSlots(app, provider), fetched: [] };
    render(true);
    editor.initial = editorFingerprint();
    showEditorPane('basic');
    requestAnimationFrame(() => root.querySelector('.pv-editor input[name=name]')?.focus());
  }
  function editorFingerprint() {
    const form = root.querySelector('.pv-editor');
    if (!editor || !form) return '';
    return JSON.stringify([Object.fromEntries(new FormData(form)), editor.upstream, editor.keyField, editor.desktopMode, editor.contextWindow, editor.thinking, editor.slots]);
  }
  function closeDrawer(force = false) {
    if (force !== true && editor && editor.initial !== editorFingerprint()) {
      const form = root.querySelector('.pv-editor');
      if (form.querySelector('.pv-unsaved')) return;
      const notice = el('div', { class: 'pv-card pv-unsaved', role: 'alert' }, [
        el('p', { text: '有尚未保存的修改，要放弃吗？' }),
        button('继续编辑', () => notice.remove()),
        button('放弃修改', () => closeDrawer(true), 'btn'),
      ]);
      form.prepend(notice);
      notice.querySelector('button')?.focus();
      return;
    }
    editor = null;
    editorPane = 'basic';
    render(false);
  }
  function showEditorPane(id) {
    editorPane = id;
    const controls = root.querySelectorAll('.pv-editor-actions > button');
    if (controls.length) { controls[0].disabled = id === 'basic'; controls[1].hidden = id === 'models'; }
    root.querySelectorAll('.pv-editor [data-pane]').forEach(node => { node.hidden = node.dataset.pane !== id; });
    root.querySelectorAll('.pv-nav [data-section^="edit-"]').forEach(node => {
      const on = node.dataset.section === `edit-${id}`;
      node.classList.toggle('on', on);
      node.setAttribute('aria-selected', String(on));
    });
    root.querySelector(`.pv-editor [data-pane="${id}"] input, .pv-editor [data-pane="${id}"] textarea`)?.focus();
  }
  function editorNav() {
    const app = appOf(editor.app);
    const item = (id, label, sub) => {
      const b = el('button', { type: 'button', class: 'pv-nav-item' + (editorPane === id ? ' on' : ''), 'data-section': `edit-${id}`, role: 'tab', 'aria-selected': String(editorPane === id) }, [
        el('span', { class: 'pv-nav-icon' }, [icon(id === 'basic' ? 'edit' : id === 'connect' ? 'route' : 'usage')]),
        el('span', { class: 'pv-nav-text' }, [el('b', { text: label }), el('small', { text: sub })]),
      ]);
      b.addEventListener('click', () => showEditorPane(id));
      return b;
    };
    const back = el('button', { type: 'button', class: 'pv-nav-item', 'data-section': 'edit-back' }, [
      el('span', { class: 'pv-nav-icon' }, [icon('left')]),
      el('span', { class: 'pv-nav-text' }, [el('b', { text: '返回' }), el('small', { text: app?.name || '供应商', translate: 'no' })]),
    ]);
    back.addEventListener('click', closeDrawer);
    const save = el('button', { type: 'button', class: 'pv-nav-item', 'data-action': 'save-provider' }, [
      el('span', { class: 'pv-nav-icon' }, [icon('check')]),
      el('span', { class: 'pv-nav-text' }, [el('b', { text: '保存' }), el('small', { text: '写回这一家' })]),
    ]);
    save.addEventListener('click', () => root.querySelector('.pv-editor')?.requestSubmit());
    const box = el('nav', { class: 'pv-nav', role: 'tablist', 'aria-label': '编辑供应商' });
    box.append(
      el('div', { class: 'pv-nav-group' }, [back]),
      el('div', { class: 'pv-nav-group' }, [el('span', { class: 'pv-nav-title', text: '设置' }), item('basic', '基本信息', '名称和备注'), item('connect', '连接', '地址和密钥'), item('models', '模型', '候选和思考等级')]),
      el('div', { class: 'pv-nav-group' }, [save, button('取消', closeDrawer, 'pv-nav-item')]),
    );
    return box;
  }
  function editorForm() {
    const { app, provider } = editor, a = appOf(app);
    const field = (name, label, attrs = {}, hint) => el('label', { class: 'pv-field' }, [el('span', { text: label }), el('input', { name, autocomplete: 'off', spellcheck: 'false', ...attrs }), hint ? el('small', { text: hint }) : null]);
    const chips = (items, value, key) => {
      const box = el('div', { class: 'pv-chips', role: 'radiogroup' }, items.map(([id, label, note]) => {
        const b = el('button', { type: 'button', class: 'pv-chip' + (value === id ? ' on' : ''), role: 'radio', 'aria-checked': String(value === id) }, [el('span', { text: label, translate: 'no' }), note ? el('small', { text: note }) : null]);
        b.addEventListener('click', () => { editor[key] = id; box.querySelectorAll('.pv-chip').forEach(n => { const on = n === b; n.classList.toggle('on', on); n.setAttribute('aria-checked', String(on)); }); });
        return b;
      }));
      return box;
    };
    const pane = (id, ...children) => {
      const node = el('div', { class: 'pv-editor-pane', 'data-pane': id }, children);
      node.hidden = editorPane !== id;
      return node;
    };
    const form = el('form', { novalidate: '', class: 'pv-editor', 'aria-label': provider ? '编辑供应商' : '添加供应商' }, [
      head(provider ? '编辑供应商' : '添加供应商', a.name, [button('取消', closeDrawer), el('button', { type: 'submit', class: 'btn btn-accent', 'data-action': 'save-provider' }, [icon('check'), el('span', { text: '保存' })])], appMark(app, 'pv-head-avatar')),
      pane('basic',
        field('name', '名称', { value: provider?.name || '', maxlength: '60' }),
        el('label', { class: 'pv-field' }, [el('span', { text: '备注' }), el('textarea', { name: 'notes', rows: '4', maxlength: '400' }, [provider?.notes || ''])]),
      ),
      pane('connect',
        el('div', { class: 'pv-field' }, [el('span', { text: '接口格式' }), chips(FORMATS.map(([id, label]) => [id, label, id === NATIVE[app] ? '原生' : '需要本地路由']), editor.upstream, 'upstream'), el('small', { text: `${a.name} 自己说的是 ${formatName(NATIVE[app])}；选别的格式时由本地路由转换。` })]),
        field('baseUrl', '请求地址', { value: provider?.baseUrl || '', placeholder: 'https://api.example.com/v1', translate: 'no' }),
        field('apiKey', 'API Key', { type: 'password', placeholder: provider?.hasKey ? `留空就用原来的密钥（••••${provider.keyHint}）` : '' }),
        app === 'claude' ? el('div', { class: 'pv-field' }, [el('span', { text: '密钥写进哪个变量' }), chips([['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', '多数中转站'], ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', '官方 API Key']], editor.keyField, 'keyField')]) : null,
      ),
      pane('models', modelSection(app, provider)),
    ]);
    const steps = ['basic', 'connect', 'models'];
    const footer = el('div', { class: 'pv-editor-actions' }, [
      button('上一步', () => showEditorPane(steps[Math.max(0, steps.indexOf(editorPane) - 1)])),
      button('下一步', () => showEditorPane(steps[Math.min(2, steps.indexOf(editorPane) + 1)])),
      el('button', { type: 'submit', class: 'btn btn-accent', 'data-action': 'save-provider', text: '保存供应商' }),
    ]);
    form.append(footer);
    form.addEventListener('invalid', e => {
      const pane = e.target.closest('[data-pane]');
      if (pane) showEditorPane(pane.dataset.pane);
    }, true);
    let saving = false;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (saving) return;
      const data = Object.fromEntries([...new FormData(form).entries()].map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
      if (!data.name || !data.baseUrl || !data.model || (!data.apiKey && !provider?.hasKey)) {
        showStatus('名称、请求地址、密钥和模型都要填。', true);
        showEditorPane(!data.name ? 'basic' : !data.baseUrl || (!data.apiKey && !provider?.hasKey) ? 'connect' : 'models');
        return;
      }
      if (!form.reportValidity()) return;
      if (editor.slots[0] && data.model) editor.slots[0].model = data.model;
      const input = { app, name: data.name, baseUrl: data.baseUrl, apiKey: data.apiKey, model: data.model, notes: data.notes, upstream: editor.upstream, apiKeyField: editor.keyField, slots: editor.slots, desktopMode: editor.desktopMode, contextWindow: editor.contextWindow, thinking: editor.thinking, ...(provider ? { id: provider.id, keepKey: !data.apiKey } : {}) };
      saving = true;
      const draft = editor;
      root.querySelectorAll('[data-action="save-provider"]').forEach(button => { button.disabled = true; });
      try {
        const done = await run(() => api.agentSave(input), provider ? '已保存' : '供应商已添加');
        if (done && editor === draft) closeDrawer(true);
      } finally {
        saving = false;
        if (editor === draft) root.querySelectorAll('[data-action="save-provider"]').forEach(button => { button.disabled = false; });
      }
    });
    form.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); }
    });
    return form;
  }

  /* ---------------- 刷新 ---------------- */

  /** 数据每次推送都会调；只有内容变了才重画，抽屉开着或正在拖动时不重画（免得把正在填的表单清掉）。 */
  async function show() {
    try { view = await api.agentState(); } catch { return; }
    const next = sig(view);
    if (editor || dragging) { signature = signature || next; return; }
    if (next === signature && root.childElementCount) return;
    signature = next;
    render(!entered);
    entered = true;
  }
  api.onAgentSwitch?.(state => {
    view = state;
    if (document.body.dataset.page !== 'providers') return;
    show().then(() => { if (state.notice) showStatus(state.notice); });
  });
  window.PulseProviders = { show };
})();
