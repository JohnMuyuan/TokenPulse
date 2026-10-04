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
 * 依赖 app.js 的全局函数：el、icon、avatar、playChart、reducedMotion。CSP 不允许 style 属性，颜色走 CSSOM。
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

  const SECTIONS = ['overview', 'claude', 'desktop', 'codex', 'grok', 'router', 'logs', 'prism', 'import', 'safety'];
  /** 能建号池的工具（桌面端用自己的网关配置，不支持）。 */
  const POOL_APPS = ['claude', 'codex', 'grok'];
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
  const healthText = h => h === 'open' ? '暂时跳过（连续失败）' : h === 'degraded' ? '路由最近失败过' : '路由暂无失败记录（不是连通性验证）';

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
  /**
   * 供应商头像：官方用工具图标；第三方依次看上传的图片、选的预设、按名称和地址自动匹配（provider-avatars.js），
   * 都没有就用名字首字母 + 按名字固定的颜色。号池没选头像时用号池图标。
   */
  function providerMark(p, cls = 'pv-mark') {
    if (p.official) return appMark(p.app, cls);
    // 号池默认用号池图标（名字里常带「Claude」，自动匹配会和普通供应商撞成同一张图）
    if (p.pool && !p.icon && !p.avatar) return el('span', { class: cls + ' pv-pool-mark', 'aria-hidden': 'true' }, [icon('user'), icon('user')]);
    const image = window.PulseAvatars?.resolve(p);
    if (image) return el('span', { class: cls + ' pv-avatar' + (image.mono ? ' mono' : ''), 'aria-hidden': 'true' }, [el('img', { src: image.src, alt: '', draggable: 'false' })]);
    let h = 0; for (const c of p.name || '?') h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return paint(el('span', { class: cls + ' pv-letter', 'aria-hidden': 'true', text: [...(p.name || '?').trim()][0]?.toUpperCase() || '?' }), { '--hue': HUES[h % HUES.length] });
  }
  const STRATEGY = { 'round-robin': '轮询', 'fill-first': '用满再换' };
  const poolSummary = p => `号池 · ${p.pool.members.length} 个成员 · ${STRATEGY[p.pool.strategy] || '轮询'}`;
  /** 号池成员：名字 + 能不能用 + 这次运行转发过几次。 */
  function memberChips(p) {
    return el('div', { class: 'pv-members' }, p.pool.members.map(m => el('span', { class: 'pv-member' + (m.usable ? '' : ' off'), title: (m.usable ? (m.health === 'open' ? '连续失败，暂时跳过' : '可用') : m.type === 'account' ? '凭据过期或账号已删除：在设置里重新登录这个账号' : '供应商已删除或没有地址') + (m.requests ? `\n本次运行转发 ${m.requests} 次，成功 ${m.ok} 次${m.lastStatus ? '，最近 HTTP ' + m.lastStatus : ''}` : '') }, [
      el('i', { class: 'pv-dot ' + (!m.usable ? 'off' : m.health) }),
      el('span', { class: 'pv-member-kind', text: m.type === 'account' ? '账号' : 'Key' }),
      el('b', { text: m.name, translate: 'no' }),
      m.requests ? el('small', { text: `${m.ok}/${m.requests}` }) : null,
    ])));
  }
  function healthDot(p) {
    const h = view.health[p.id] || 'ok';
    return el('i', { class: 'pv-dot ' + h, title: healthText(h), 'aria-label': healthText(h) });
  }

  /* ---------------- 调后端 ---------------- */

  let pending = false, stateTicket = 0, feedback = null;
  const probes = new Map();
  /*
   * 供应商页的所有提示（进行中、成功、警告、失败）都走右上角的弹窗（app.js 的 toast），不在页面里插常驻的提示条。
   * 同一个 key：「正在切换…」原地变成「已切换」或失败原因，不叠一串。
   */
  function showFeedback(message, kind = 'success') {
    feedback = { message, kind };
    if (typeof toast === 'function') toast(message, { kind, key: 'providers' });
  }
  function clearPending() {
    if (feedback?.kind === 'pending') { feedback = null; toastKeys?.get('providers')?.dispose(); }
  }
  function lockControls() {
    const controls = [...root.querySelectorAll('button,input,select,textarea')].map(node => [node, node.disabled]);
    const rows = [...root.querySelectorAll('[draggable]')].map(node => [node, node.draggable]);
    controls.forEach(([node]) => { node.disabled = true; });
    rows.forEach(([node]) => { node.draggable = false; });
    return () => { controls.forEach(([node, disabled]) => { node.disabled = disabled; }); rows.forEach(([node, draggable]) => { node.draggable = draggable; }); };
  }
  async function run(work, okText, pendingText = '正在处理，请稍候…') {
    if (pending) return null;
    pending = true; stateTicket++;
    root.setAttribute('aria-busy', 'true');
    const focus = root.contains(document.activeElement) ? document.activeElement : null;
    const rowId = focus?.closest('[data-id]')?.dataset.id;
    const unlock = lockControls();
    const working = editor ? [...root.querySelectorAll('[data-action="save-provider"]')] : focus?.tagName === 'BUTTON' ? [focus] : [];
    working.forEach(button => { button.classList.add('pv-working'); button.setAttribute('aria-busy', 'true'); });
    showFeedback(pendingText, 'pending');
    let result, success = false;
    try {
      try { result = await work(); } catch (error) { result = { ok: false, error: error?.message }; }
      // 要改动工具配置文件：先给用户看逐行对比，确认后才真正写（main/index.ts 的 agentWrite）
      if (result?.confirm) {
        clearPending(); // 等用户确认时别在右上角转圈
        const yes = await confirmChanges(result.confirm);
        if (!yes) { showFeedback('已取消，工具配置没有改动。', 'warning'); return null; }
        showFeedback(pendingText, 'pending');
        try { result = await api.agentConfirm(result.confirm.token); } catch (error) { result = { ok: false, error: error?.message }; }
      }
      if (!result?.ok) { showFeedback(result?.error || '操作失败，请重试。', 'error'); return null; }
      success = true;
      if (result.state) { view = result.state; signature = sig(view); }
      const text = result.state?.notice || (typeof okText === 'function' ? okText(result) : okText);
      if (text) showFeedback(text, result.feedbackKind || (result.state?.notice ? 'warning' : 'success'));
      return result;
    } finally {
      clearPending();
      unlock(); pending = false; stateTicket++;
      working.forEach(button => { button.classList.remove('pv-working'); button.removeAttribute('aria-busy'); });
      const fetch = root.querySelector('[data-action=fetch-models]');
      if (fetch) fetch.disabled = !!editor?.fetching;
      root.removeAttribute('aria-busy');
      // Never recreate an editor from its saved provider while a live draft exists.
      if (success && !editor && !dragging) render(false);
      if (focus?.isConnected) focus.focus({ preventScroll: true });
      else if (focus && !editor) {
        const target = rowId ? root.querySelector('.pv-row[data-id="' + CSS.escape(rowId) + '"]') || root.querySelector('.pv-current') : root.querySelector('.pv-nav-item.on');
        if (target) { if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); }
      }
    }
  }
  function sig(data) {
    return JSON.stringify([data.readOnly, data.providers.map(p => [p.id, p.name, p.active, p.direct, p.failover, p.baseUrl, p.model, p.upstream, p.keyHint, p.notes, p.sort, p.slots, p.desktopMode, p.contextWindow, p.codexContextWindow, p.codexAutoCompact, p.thinking, p.icon, p.avatar ? p.avatar.length : 0, p.pool]), data.proxy.apps, data.proxy.running, data.proxy.port, data.health, (data.logs || []).length && data.logs[0]?.at]);
  }

  /* ---------------- 整体结构 ---------------- */

  function render(animate) {
    if (!view) return;
    if (!SECTIONS.includes(section)) section = 'overview';
    const main = el('div', { class: 'pv-main', role: 'tabpanel', 'aria-label': editor ? '编辑供应商' : sectionTitle() });
    if (editor) main.append(editorForm());
    else {
      const body = { overview, claude: () => appSection('claude'), desktop: () => appSection('desktop'), codex: () => appSection('codex'), grok: () => appSection('grok'), router, logs, prism: prismSection, import: importSection, safety: safetySection }[section]();
      main.append(...[].concat(body));
    }
    const layout = el('div', { class: 'pv' }, [editor ? editorNav() : nav(), main]);
    root.replaceChildren(layout);
    if (animate) playChart(main, true);
  }
  function go(next) {
    if (pending) return;
    if (next === section) return;
    section = next;
    try { localStorage.setItem(SECTION_KEY, next); } catch { /* 记不住就算了 */ }
    render(true);
    root.querySelector(`.pv-nav [data-section="${next}"]`)?.focus();
  }
  function sectionTitle() {
    return { overview: '概览', router: '本地路由', logs: '转发记录', prism: 'Prism 桥', import: '导入供应商', safety: '配置保护' }[section] || appOf(section)?.name || '';
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
        item('prism', 'Prism 桥', prism ? PRISM_PHASE[prism.phase] : null, lead('globe'), el('i', { class: 'pv-dot ' + (prism?.phase === 'running' ? 'ok' : prism?.phase === 'starting' ? 'degraded' : 'off') })),
      ]],
      ['管理', [item('import', '导入供应商', null, lead('download')), item('safety', '配置保护', null, lead('lock'), view.readOnly ? el('span', { class: 'pv-nav-badge guard', text: '只读' }) : null)]],
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
        ? [el('small', { text: '当前供应商' }), el('strong', { text: cur.name, translate: 'no' }), el('span', { translate: 'no', text: cur.official ? '官方登录' : cur.pool ? poolSummary(cur) : [cur.model, formatName(cur.upstream)].filter(Boolean).join(' · ') })]
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
    const actions = [mode, POOL_APPS.includes(app) ? button('新建号池', () => openDrawer(app, null, 'basic', true), 'btn', 'user') : null, button('添加供应商', () => openDrawer(app), 'btn btn-accent', 'plus')].filter(Boolean);
    const others = providersOf(app).filter(p => p !== cur);
    const list = el('div', { class: 'pv-list', role: 'list', 'aria-label': `${a.name} 的供应商` }, others.map((p, i) => providerRow(p, i)));
    if (!others.length) list.append(el('div', { class: 'pv-empty' }, [el('p', { text: '还没有别的供应商。' }), button('添加供应商', () => openDrawer(app), 'btn', 'plus')]));
    const out = [
      head(a.name, routed ? `本地路由开着：${a.name} 连 ${routeAddress(app)}，由 TokenPulse 转发给下面选中的供应商。` : `直连：${a.name} 的配置里写的就是当前供应商的地址。`, actions, appMark(app, 'pv-head-avatar')),
      cur ? currentCard(cur, routed) : el('div', { class: 'pv-current empty' }, [el('b', { text: '没有识别到当前供应商' }), el('p', { text: '工具当前连接未与已保存的地址、密钥、接口和模型匹配。可以导入现有配置，或明确启用下面的一家。' })]),
      el('div', { class: 'pv-list-head' }, [el('h3', { text: '其他供应商' }), el('small', { text: '拖动左边的把手调整顺序；本地路由的故障转移按这个顺序依次尝试加入了备用的供应商。' })]),
      list,
    ];
    requestAnimationFrame(() => syncSeg(mode));
    return out;
  }
  function currentCard(p, routed) {
    const facts = p.official
      ? [fact('登录', '使用工具自己的官方登录')]
      : p.pool
        ? [fact('号池', `${p.pool.members.length} 个成员 · ${STRATEGY[p.pool.strategy]}`), fact('模型', p.model || '由工具自己选', true), fact('可用成员', `${p.pool.members.filter(m => m.usable).length} / ${p.pool.members.length}`)]
        : [fact('请求地址', p.baseUrl, true), fact('模型', p.model || '—', true), fact('接口格式', formatName(p.upstream) + (p.cross ? '（和工具不同，经本地路由转换）' : '')), fact('密钥', p.hasKey ? `••••${p.keyHint}` : '未填', true)];
    if (routed) facts.push(fact('工具连的地址', routeAddress(p.app), true));
    if (p.category) facts.push(fact('分类', p.category));
    if (p.isFullUrl) facts.push(fact('端点', '完整 URL'));
    if (p.dailyLimitUsd != null || p.monthlyLimitUsd != null) facts.push(fact('限额', [p.dailyLimitUsd != null ? `日 ${p.dailyLimitUsd}` : '', p.monthlyLimitUsd != null ? `月 ${p.monthlyLimitUsd}` : ''].filter(Boolean).join(' · ')));
    return el('section', { class: 'pv-current' }, [
      el('div', { class: 'pv-current-top' }, [providerMark(p), el('div', {}, [el('small', { text: '当前供应商' }), el('b', { text: p.name, translate: 'no' })]), healthDot(p),
        el('div', { class: 'pv-current-actions' }, p.official || p.locked ? [] : [
          p.pool ? null : button('检测连通', () => probe(p), 'btn', 'refresh'),
          button('配置预览', () => openDrawer(p.app, p, 'preview'), 'btn', 'terminal'),
          button('编辑', () => openDrawer(p.app, p), 'btn', 'edit'),
        ])]),
      el('div', { class: 'pv-facts' }, facts),
      p.pool ? memberChips(p) : null,
      p.notes ? el('p', { class: 'pv-notes', text: p.notes, translate: 'no' }) : null,
    ]);
  }
  function fact(label, value, raw) { return el('div', { class: 'pv-fact' }, [el('small', { text: label }), el('span', { text: value, translate: raw ? 'no' : null })]); }

  function providerRow(p, i) {
    const queueIndex = view.proxy.apps[p.app] ? queueOf(p.app).indexOf(p) : -1;
    const lastProbe = probes.get(p.id);
    const sub = p.official ? '官方登录' : p.locked ? '登录凭证由原来的工具保存' : p.pool ? [poolSummary(p), p.model].filter(Boolean).join(' · ') : [p.model, formatName(p.upstream), p.hasKey ? `••••${p.keyHint}` : null].filter(Boolean).join(' · ');
    const row = el('div', { class: 'pv-row', role: 'listitem', tabindex: '0', 'data-id': p.id, draggable: 'true', 'aria-label': p.name }, [
      el('span', { class: 'pv-grip', title: '拖动排序（也可以按 Alt + ↑ / ↓）', 'aria-hidden': 'true' }, [icon('grip')]),
      providerMark(p),
      el('div', { class: 'pv-row-main' }, [
        el('div', { class: 'pv-row-name' }, [el('b', { text: p.name, translate: 'no' }), healthDot(p),
          p.failover ? el('span', { class: 'pv-tag', text: queueIndex > 0 ? `备用 ${queueIndex}` : '备用' }) : null,
          p.pool ? el('span', { class: 'pv-tag pool', text: '号池' }) : null,
          p.cross || p.pool ? el('span', { class: 'pv-tag warn', text: '需要本地路由' }) : null]),
        el('small', { text: sub, translate: 'no' }),
        lastProbe ? el('small', { class: 'pv-probe-result', text: '地址响应 HTTP ' + lastProbe + ' · 未验证密钥/模型' }) : null,
      ]),
      el('div', { class: 'pv-row-actions' }, p.locked ? [] : [
        p.official || p.pool ? null : iconButton('refresh', '检测连通', () => probe(p)),
        p.official ? null : iconButton('terminal', '配置预览', () => openDrawer(p.app, p, 'preview')),
        p.official ? null : iconButton('edit', '编辑', () => openDrawer(p.app, p)),
        p.official || p.pool ? null : iconButton('restore', p.failover ? '移出备用' : '加入备用', () => run(() => api.agentFailover(p.id, !p.failover), p.failover ? '已移出备用' : '已加入备用'), p.failover ? 'on' : ''),
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
    return run(() => api.agentReorder(app, ids), '已调整顺序', '正在保存备用顺序…');
  }

  async function activate(p) {
    await run(() => api.agentActivate(p.id), r => (r.result?.message || '已切换') + (r.result?.restart ? ' 请重新打开对应工具，让新配置生效。' : ''), '正在启用「' + p.name + '」，完成前不会重复切换…');
  }
  async function toggleRoute(app, on) {
    await run(() => api.agentProxy(app, on), on ? '本地路由已启用；关闭或退出时会按接管快照恢复。' : '本地路由已关闭；已处理配置恢复。', on ? '正在启动路由并写入工具配置…' : '正在恢复配置并关闭路由…');
  }
  async function probe(p) {
    const response = await run(async () => {
      const result = await api.agentProbe(p.id);
      if (!result?.ok) return result;
      const status = result.result?.status;
      if (!status) return { ok: false, error: result.result?.error || '地址未响应，请检查地址或网络。' };
      return { ...result, feedbackKind: status >= 400 ? 'warning' : 'success' };
    }, r => p.name + '：地址已响应（HTTP ' + r.result.status + '）。仅检测地址响应，不验证密钥或模型是否可用。', '正在检测「' + p.name + '」的地址响应…');
    if (response) { probes.set(p.id, response.result.status); if (!editor) render(false); }
  }
  /** 删除要点两次：第一次按钮变红提示「再点一次删除」，3 秒内再点才删（不弹系统对话框）。 */
  async function remove(p, btn) {
    if (!btn.classList.contains('confirm')) {
      btn.classList.add('confirm');
      btn.title = btn.ariaLabel = '再点一次删除';
      showFeedback(`再点一次删除「${p.name}」；3 秒后取消确认。`, 'warning');
      clearTimeout(btn._reset);
      btn._reset = setTimeout(() => { btn.classList.remove('confirm'); btn.title = btn.ariaLabel = '删除'; }, 3000);
      return;
    }
    clearTimeout(btn._reset);
    await run(() => api.agentDelete(p.id), '已删除「' + p.name + '」', '正在删除「' + p.name + '」…');
  }

  /* ---------------- 本地路由 ---------------- */

  function router() {
    const running = view.proxy.running;
    const port = el('input', { type: 'number', min: '1024', max: '65535', value: String(view.proxy.port), class: 'pv-port', 'aria-label': '端口', disabled: running ? '' : null });
    port.addEventListener('change', async () => {
      const value = Number(port.value);
      if (!port.value || !port.checkValidity()) { showFeedback('端口需要是 1024–65535 的整数。', 'error'); port.value = String(view.proxy.port); return; }
      const done = await run(() => api.agentPort(value), '端口已保存', '正在保存路由端口…');
      if (!done && port.isConnected) port.value = String(view.proxy.port);
    });
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

  /* ---------------- Prism 桥（0.3.19） ---------------- */

  /*
   * 随软件带的 Prism Bridge（作者 yyyllllming，MIT）：用真实浏览器登录用户自己的 Prism 账号，在本机开一个 OpenAI 兼容接口。
   * 四步：装运行环境 → 登录 → 启动服务 → 加成 Codex 供应商。安装和登录可能要几分钟，不走 run()（它会锁住整页），
   * 按主进程推过来的状态禁用按钮；只有「加成供应商」会改到工具配置，走 run() 的确认流程。
   */
  const PRISM_PHASE = { running: '运行中', starting: '启动中', stopped: '已停止' };
  let prism = null, prismLogOpen = null, prismUsage = null, prismUsageLoading = false;
  const prismKey = s => JSON.stringify([s.available, s.deps, s.login, s.phase, s.task, s.port, s.autoStart, s.error, s.provider, s.installed, s.proxyIssue]);
  const prismVisible = () => section === 'prism' && !editor && !dragging && !pending && document.body.dataset.page === 'providers';
  /** 占了多少空间：打开这一页时量一次，装完 / 删完之后重新量。 */
  function loadPrismUsage() {
    if (prismUsageLoading || !api.prismUsage) return;
    prismUsageLoading = true;
    api.prismUsage().then(bytes => { prismUsage = Number(bytes) || 0; }).catch(() => { prismUsage = 0; }).finally(() => { prismUsageLoading = false; if (prismVisible()) render(false); });
  }
  function fillPrismLog(box) {
    box.textContent = prism.logs.length ? prism.logs.join('\n') : '还没有日志。';
    box.scrollTop = box.scrollHeight;
  }
  function setPrism(state) {
    const before = prism ? prismKey(prism) : '';
    prism = state;
    if (document.body.dataset.page !== 'providers' || editor || dragging || pending || !view) return;
    if (prismKey(state) !== before) { render(false); return; }
    const box = root.querySelector('.pv-prism-log');
    if (box) fillPrismLog(box);
  }
  async function prismDo(work, okText) {
    let result;
    try { result = await work(); } catch (error) { result = { ok: false, error: error?.message }; }
    if (result?.state) setPrism(result.state);
    if (!result?.ok) showFeedback(result?.error || '操作失败，请重试。', 'error');
    else if (okText) showFeedback(okText);
    return !!result?.ok;
  }
  function prismSection() {
    const title = head('Prism 桥', 'ChatGPT 账号被降智时，换一条路用回完整的模型：经你自己的 Prism 账号，在本机给 Codex 开一个接口。');
    if (!prism) return [title, el('p', { class: 'pv-empty', text: '正在读取状态…' })];
    if (!prism.available) return [title, el('p', { class: 'pv-empty', text: '这个版本里没有带 Prism 桥的程序文件。' })];
    const s = prism, busy = !!s.task, running = s.phase !== 'stopped', signedIn = !!s.login && !s.login.expired;
    const mine = providersOf('codex').find(p => !p.official && !p.pool && (p.name === 'Prism 桥' || p.baseUrl === `http://127.0.0.1:${s.port}/v1`));
    const inUse = !!mine?.active;
    // 走到第几步了：0 装环境，1 登录，2 启动，3 接到 Codex，4 全部做完
    const stage = !s.deps ? 0 : !signedIn ? 1 : s.phase !== 'running' ? 2 : !inUse ? 3 : 4;
    const daysLeft = signedIn && s.login.expiresAt ? Math.max(0, Math.ceil((s.login.expiresAt - Date.now()) / 86400000)) : null;
    const act = (label, onClick, off, cls = 'btn') => { const b = button(label, onClick, cls); b.disabled = !!off; return b; };
    const install = async () => { await prismDo(api.prismInstall, '运行环境已经装好'); prismUsage = null; if (prismVisible()) render(false); };
    const signIn = () => prismDo(api.prismLogin, '登录成功');
    const start = () => prismDo(api.prismStart, 'Prism 桥已经启动');
    const refresh = () => api.prismState().then(setPrism).catch(() => {});
    const addProvider = async () => { await run(() => api.prismProvider(), '已保存到 Codex 的供应商列表', '正在保存供应商…'); refresh(); };
    const enable = async () => { await run(() => api.agentActivate(mine.id), 'Codex 已切换到 Prism 桥', '正在切换 Codex…'); refresh(); };

    /* 总状态：一眼看出现在到哪了、下一步点什么 */
    const [stateTitle, stateText] = s.task === 'remove' ? ['正在删除…', '停掉服务，删掉运行环境、下载的 Chromium、登录信息和设置。']
      : s.task === 'install' ? ['正在安装运行环境…', '进度看下面的日志，第一次可能要几分钟。']
      : s.task === 'login' ? ['等你在浏览器里登录…', '看到 Prism 的界面后，把那个浏览器窗口关掉。']
      : s.phase === 'starting' ? ['正在启动…', '唤醒 Chromium 和 Prism 工作区，通常 15 到 25 秒。']
      : [['还没有装运行环境', '第一次用要先装一次，之后就不用了。'], ['还没有登录 Prism', '用你电脑上的浏览器登录一次，大约十天有效。'], s.error ? ['服务没有启动成功', s.error] : ['服务没有启动', '启动后 Codex 才能通过它发请求。'], [mine ? '服务运行中，Codex 还没有切过来' : '服务运行中，还没有接到 Codex', '做完下面第 4 步就能用了。'], ['Codex 正在经 Prism 桥发请求', '想换回官方登录，到 Codex 页面启用官方那一家。']][stage];
    const next = busy || s.phase === 'starting' ? null
      : [() => act('安装运行环境', install, false, 'btn btn-accent'), () => act('登录', signIn, false, 'btn btn-accent'), () => act('启动', start, false, 'btn btn-accent'), () => mine ? act('在 Codex 里启用', enable, false, 'btn btn-accent') : act('添加到 Codex 供应商', addProvider, false, 'btn btn-accent'), () => null][stage]();
    const failed = stage === 2 && !!s.error && !busy && s.phase === 'stopped';
    const hero = el('section', { class: 'pv-hero pv-prism-hero' + (s.phase === 'running' ? ' on' : '') + (busy || s.phase === 'starting' ? ' busy' : '') + (failed ? ' failed' : '') }, [
      el('div', { class: 'pv-hero-state' }, [el('i', { class: 'pv-pulse' }), el('div', {}, [el('b', { text: stateTitle }), el('small', { text: stateText })])]),
      el('div', { class: 'pv-hero-stats' }, [
        stat('进度', `${Math.min(stage, 4)}/4`),
        stat('登录还剩', daysLeft == null ? '—' : `${daysLeft} 天`),
        stat('端口', String(s.port)),
      ]),
      next,
    ]);
    const broken = inUse && s.phase === 'stopped' && !busy ? el('section', { class: 'pv-prism-warn', role: 'alert' }, [
      icon('alert'),
      el('div', { class: 'pv-grow' }, [el('b', { text: 'Codex 现在选的是 Prism 桥，但服务没有启动' }), el('small', { text: 'Codex 这时发请求会连不上。启动服务，或者到 Codex 页面换回官方登录。' })]),
    ]) : null;

    // 0.3.20：系统里设了代理、又没把本机地址排除时，Codex 发来的请求会被代理截走（Codex 报 502，这边日志里什么都没有）
    const proxied = s.proxyIssue ? el('section', { class: 'pv-prism-warn', role: 'alert', 'data-warn': 'proxy' }, [
      icon('alert'),
      el('div', { class: 'pv-grow' }, [
        el('b', { text: s.proxyIssue.certain ? 'Codex 的请求会被代理截走，到不了 Prism 桥' : 'Codex 的请求可能会被代理截走' }),
        el('small', { text: '系统里设了代理，但没有把本机地址排除在外，Codex 会报 502 Bad Gateway，这里的日志里却什么都没有。点「一键修复」把 127.0.0.1 加进 NO_PROXY，然后把 Codex 和终端完全关掉再打开。' }),
        el('small', { translate: 'no', text: s.proxyIssue.proxy }),
      ]),
      act('一键修复', () => prismDo(api.prismFixProxy, '已经设置好。请把 Codex 和终端完全关掉再打开。'), busy),
    ]) : null;

    /* 适合谁用 + 风险：先说清楚再让人动手 */
    const fitRow = (kind, name, heading, text) => el('li', { class: 'pv-prism-fit-row ' + kind }, [el('span', { class: 'pv-prism-fit-icon', 'aria-hidden': 'true' }, [icon(name)]), el('div', {}, [el('b', { text: heading }), el('p', { text })])]);
    const fit = el('ul', { class: 'pv-card pv-prism-fit' }, [
      fitRow('yes', 'check', '适合：账号被「降智」了', '官方登录下，模型明显变笨，或者被悄悄换成了低一档的型号。走 Prism 桥拿到的是没有被降级的模型。'),
      fitRow('no', 'info', '没必要：账号是正常的', '账号没被降智就继续用官方登录：回复是边生成边显示的，没有限流等待，也不用担多余的风险。'),
      fitRow('risk', 'alert', '用之前请先知道', '这不是官方提供的用法：它用浏览器自动操作你自己的 Prism 账号，可能不符合 OpenAI 的服务条款，账号有被限制的风险，请自己决定要不要用。只给你本人在这台电脑上用，不要转售或共享。回复是整段生成完才返回的；短时间连发多轮会被限流几十秒到十几分钟，每次工具调用都算一轮。'),
    ]);

    const stepCard = (n, done, name, text, actions) => el('section', { class: 'pv-card pv-prism-step' + (done ? ' done' : '') + (stage === n - 1 ? ' current' : '') + (stage < n - 1 ? ' later' : ''), 'data-step': name }, [el('div', { class: 'pv-card-row' }, [
      el('span', { class: 'pv-prism-num', 'aria-hidden': 'true' }, [done ? icon('check') : document.createTextNode(String(n))]),
      el('div', { class: 'pv-grow' }, text),
      ...actions,
    ])]);

    const env = stepCard(1, s.deps, 'deps', [
      el('b', { text: '安装运行环境' }),
      el('small', { text: s.task === 'install' ? '正在安装，进度看下面的日志。第一次要下载约 200 MB，可能要几分钟。' : s.deps ? '已经装好：独立的 Python 环境、playwright 和 Chromium。' : '需要 Python、playwright 和一个 Chromium 浏览器。都装在 TokenPulse 的数据目录里，不影响电脑上别的 Python；电脑上没有 Python 时会先用 winget 安装。' }),
    ], [act(s.task === 'install' ? '正在安装…' : s.deps ? '重新安装' : '安装运行环境', install, busy || running)]);

    const login = stepCard(2, signedIn, 'login', [
      el('b', { text: '登录 Prism' }),
      el('small', { class: daysLeft != null && daysLeft <= 2 ? 'pv-prism-soon' : null, text: s.task === 'login' ? '请在弹出的浏览器窗口里登录，看到 Prism 的界面后把那个窗口关掉，这里会自动继续。' : !s.login ? '会用你电脑上的 Chrome 或 Edge 打开一个单独的登录窗口（不带你平时的登录状态和插件），在里面登录你自己的 OpenAI 账号。登录状态大约十天过期，过期后再登录一次。' : s.login.expired ? '登录已经过期，请重新登录。' : `已登录${s.login.plan ? ' · ' + s.login.plan : ''} · ${when(s.login.expiresAt)} 过期${daysLeft <= 2 ? '，快到期了' : ''}` }),
    ], [act(s.task === 'login' ? '等待登录…' : s.login ? '重新登录' : '登录', signIn, busy || !s.deps)]);

    const auto = el('button', { type: 'button', class: 'pv-switch' + (s.autoStart ? ' on' : ''), role: 'switch', 'aria-checked': String(!!s.autoStart), 'aria-label': '跟着 TokenPulse 启动' }, [el('i')]);
    auto.addEventListener('click', () => prismDo(() => api.prismAutoStart(!s.autoStart)));
    const service = stepCard(3, s.phase === 'running', 'service', [
      el('b', { text: '启动服务' }),
      el('small', { translate: s.phase === 'running' ? 'no' : null, text: s.phase === 'running' ? `http://127.0.0.1:${s.port}/v1` : s.phase === 'starting' ? '正在唤醒 Chromium 和 Prism 工作区，通常 15 到 25 秒。' : '启动后 Codex 才能通过它发请求。退出 TokenPulse 时服务会一起停掉。' }),
      el('label', { class: 'pv-prism-auto' }, [auto, el('span', { text: '跟着 TokenPulse 启动' })]),
    ], [running ? act('停止', () => prismDo(api.prismStop, '服务已停止'), busy) : act('启动', start, busy || !s.deps || !signedIn)]);

    const provider = stepCard(4, inUse, 'provider', [
      el('b', { text: '接到 Codex' }),
      el('small', { text: inUse ? 'Codex 现在用的就是这一家。想换回官方登录，到 Codex 页面启用官方那一家。' : mine ? '已经在 Codex 的供应商列表里，还没有启用。' : '把这个本机接口加成 Codex 的一家供应商，地址和密钥自动填好，然后启用。' }),
      el('div', { class: 'pv-prism-models' }, (s.models || []).map(name => el('span', { class: 'pv-member', translate: 'no' }, [el('b', { text: name })]))),
    ], [
      mine ? act('更新供应商', addProvider, false, 'btn') : null,
      inUse ? act('去 Codex 页面', () => go('codex')) : mine ? act('在 Codex 里启用', enable) : act('添加到 Codex 供应商', addProvider),
    ]);

    /* 日志：平时收着，安装 / 登录 / 启动中或出错时自己展开；用户点过就听用户的 */
    const pre = el('pre', { class: 'pv-prism-log', translate: 'no', tabindex: '0', 'aria-label': '日志' });
    fillPrismLog(pre);
    const openLog = act('打开日志文件', event => { event.preventDefault(); event.stopPropagation(); api.prismOpenLog(); });
    const summary = el('summary', {}, [el('b', { text: '日志' }), el('small', { text: 'Prism Bridge 由 yyyllllming 开源（MIT 协议）。' }), openLog]);
    const logBox = el('details', { class: 'pv-prism-logbox' }, [summary, pre]);
    logBox.open = prismLogOpen ?? (busy || s.phase === 'starting' || !!s.error);
    summary.addEventListener('click', () => { prismLogOpen = !logBox.open; queueMicrotask(() => { pre.scrollTop = pre.scrollHeight; }); });
    queueMicrotask(() => { pre.scrollTop = pre.scrollHeight; });

    /* 一键删除（0.3.20）：不想用了，把它留下的东西全部清掉。要点两次。 */
    let removal = null;
    if (s.installed || mine) {
      if (prismUsage == null) loadPrismUsage();
      const size = prismUsage == null ? '' : prismUsage >= 1048576 ? `现在占用约 ${Math.round(prismUsage / 1048576)} MB（另有下载的 Chromium 约 300 MB）。` : '';
      const removeAll = async event => {
        const btn = event.currentTarget;
        if (!btn.classList.contains('confirm')) {
          btn.classList.add('confirm');
          btn.querySelector('span').textContent = '再点一次，确认删除';
          clearTimeout(btn._reset);
          btn._reset = setTimeout(() => { btn.classList.remove('confirm'); btn.querySelector('span').textContent = '全部删除'; }, 4000);
          return;
        }
        clearTimeout(btn._reset);
        if (mine) {
          // Codex 正在用这一家：先切回官方登录（会改 Codex 配置，照常先确认），再把供应商删掉
          if (inUse) {
            const official = providersOf('codex').find(p => p.official);
            if (!official || !await run(() => api.agentActivate(official.id), 'Codex 已切回官方登录', '正在把 Codex 切回官方登录…')) return;
          }
          if (!await run(() => api.agentDelete(mine.id), null, '正在删除供应商…')) return;
        }
        if (await prismDo(api.prismRemove, 'Prism 桥留下的文件已经全部删除')) { prismUsage = null; prismLogOpen = null; if (prismVisible()) render(false); }
      };
      removal = el('section', { class: 'pv-card pv-prism-remove' }, [el('div', { class: 'pv-card-row' }, [
        el('div', { class: 'pv-grow' }, [
          el('b', { text: '不想用了？一键删除' }),
          el('small', { text: '删掉 Prism 桥的运行环境、下载的 Chromium、登录信息、设置和日志，并去掉 Codex 里的「Prism 桥」供应商（Codex 正在用的话先切回官方登录）。' + size }),
          el('small', { text: '不会动 TokenPulse 本身、你电脑上的 Python 和别的程序装的浏览器。以后想用，重新走一遍四步就行。' }),
        ]),
        act('全部删除', removeAll, busy || s.phase === 'starting'),
      ])]);
    }
    return [title, hero, proxied, broken, fit, el('div', { class: 'pv-prism-steps' }, [env, login, service, provider]), logBox, removal].filter(Boolean);
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

  function contextPreset(app, slot = {}) {
    if (app === 'grok') return 131072;
    if (app === 'codex') return 128000;
    return slot.oneM ? 1000000 : 200000;
  }
  function normalizeSlotContext(app, slot) {
    return { ...slot, contextWindow: Number.isInteger(Number(slot.contextWindow)) && Number(slot.contextWindow) > 0 ? Number(slot.contextWindow) : contextPreset(app, slot) };
  }
  function blankSlot(role, app = editor?.app) {
    return { role, model: '', displayName: '', oneM: false, contextWindow: contextPreset(app, { role }), reasoningLevels: [], defaultReasoningLevel: '' };
  }
  function seedSlots(app, provider) {
    const saved = (provider?.slots || []).map(slot => normalizeSlotContext(app, { ...slot, reasoningLevels: [...(slot.reasoningLevels || [])] }));
    const roles = app === 'claude' ? CLAUDE_ROLES : app === 'desktop' ? DESKTOP_ROLES : null;
    if (roles) return roles.map(([role]) => saved.find(slot => slot.role === role) || normalizeSlotContext(app, { ...blankSlot(role, app), model: role === 'sonnet' ? (provider?.model || '') : '' }));
    if (saved.length) return saved;
    return [normalizeSlotContext(app, { ...blankSlot('catalog', app), model: provider?.model || '', reasoningLevels: app === 'codex' ? ['low', 'medium', 'high'] : [], defaultReasoningLevel: app === 'codex' ? 'high' : '' })];
  }
  /** 同一时间只开一个等级面板；点面板外面或按 Esc 关掉（Esc 不再连带关闭整个编辑页）。 */
  let openLevels = null;
  function closeLevels(focusTrigger = false) {
    if (!openLevels) return;
    const current = openLevels; openLevels = null;
    current.panel.hidden = true; current.trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', current.outside, true);
    if (focusTrigger && current.trigger.isConnected) current.trigger.focus();
  }
  function levelChips(slot) {
    const box = el('div', { class: 'pv-level-picker' });
    const trigger = el('button', { type: 'button', class: 'pv-level-trigger', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' });
    const panel = el('div', { class: 'pv-level-popover', hidden: '' });
    const search = el('input', { type: 'search', class: 'pv-level-search', placeholder: '搜索思考等级…', 'aria-label': '搜索思考等级' });
    const list = el('div', { class: 'pv-level-options', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': '思考等级' });
    const defaultSelect = el('select', { class: 'pv-default-select', 'aria-label': '默认思考等级' });
    const sync = () => {
      const selected = LEVELS.filter(level => slot.reasoningLevels.includes(level));
      trigger.replaceChildren(
        el('span', { class: 'pv-level-summary', text: selected.length ? selected.join(' · ') : '选择思考等级', translate: 'no' }),
        selected.length ? el('small', { text: slot.defaultReasoningLevel ? '默认 ' + slot.defaultReasoningLevel : '默认自动', translate: 'no' }) : null);
      trigger.title = selected.length ? selected.join(', ') : '';
      defaultSelect.replaceChildren(el('option', { value: '', text: '自动选择默认等级' }), ...selected.map(level => el('option', { value: level, text: level })));
      defaultSelect.value = slot.defaultReasoningLevel || '';
      const query = search.value.trim().toLowerCase();
      list.replaceChildren(...LEVELS.filter(level => !query || level.includes(query)).map(level => {
        const checked = selected.includes(level);
        const input = el('input', { type: 'checkbox', checked: checked ? '' : null });
        const row = el('label', { class: 'pv-level-option' + (checked ? ' on' : ''), role: 'option', 'aria-selected': String(checked) }, [input, el('span', { text: level, translate: 'no' }), checked ? el('small', { text: level === slot.defaultReasoningLevel ? '默认' : '已选' }) : null]);
        input.addEventListener('change', () => {
          const next = LEVELS.filter(item => item === level ? !checked : slot.reasoningLevels.includes(item));
          slot.reasoningLevels = next;
          if (!next.includes(slot.defaultReasoningLevel)) slot.defaultReasoningLevel = next.at(-1) || '';
          sync();
          list.querySelector(`.pv-level-option:nth-child(${[...LEVELS.filter(l => !query || l.includes(query))].indexOf(level) + 1}) input`)?.focus();
        });
        return row;
      }));
    };
    search.addEventListener('input', sync);
    defaultSelect.addEventListener('change', () => { slot.defaultReasoningLevel = defaultSelect.value; sync(); });
    trigger.addEventListener('click', () => {
      if (!panel.hidden) { closeLevels(); return; }
      closeLevels();
      const outside = e => { if (!box.contains(e.target)) closeLevels(); };
      openLevels = { panel, trigger, outside };
      panel.hidden = false; trigger.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', outside, true);
      search.focus();
    });
    box.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) { e.preventDefault(); e.stopPropagation(); closeLevels(true); } });
    panel.append(search, list, el('label', { class: 'pv-default-picker' }, [el('span', { text: '默认等级' }), defaultSelect]));
    box.append(trigger, panel);
    sync();
    return box;
  }
  function slotRow(slot, primary) {
    const roleName = (CLAUDE_ROLES.find(item => item[0] === slot.role) || DESKTOP_ROLES.find(item => item[0] === slot.role) || [, ''])[1];
    const model = el('input', { autocomplete: 'off', spellcheck: 'false', translate: 'no', value: slot.model, placeholder: '实际请求模型', 'aria-label': (roleName ? roleName + ' ' : '') + '实际请求模型' });
    if (primary) model.name = 'model';
    model.addEventListener('input', () => { slot.model = model.value; });
    const name = el('input', { autocomplete: 'off', spellcheck: 'false', value: slot.displayName, placeholder: '菜单显示名', 'aria-label': (roleName ? roleName + ' ' : '') + '菜单显示名' });
    name.addEventListener('input', () => { slot.displayName = name.value; });
    const role = slot.role && slot.role !== 'catalog';
    const context = role ? el('input', { type: 'number', min: '1', value: slot.contextWindow || contextPreset(editor?.app, slot), placeholder: '上下文', 'aria-label': (roleName || '') + ' 上下文窗口' }) : null;
    context?.addEventListener('input', () => { slot.contextWindow = Number(context.value) || null; });
    const row = el('div', { class: 'pv-slot', 'data-role': slot.role || 'catalog' }, [
      role ? el('b', { text: roleName || slot.role }) : null,
      name,
      model,
      context,
    ]);
    const allowOneM = (CLAUDE_ROLES.find(item => item[0] === slot.role) || DESKTOP_ROLES.find(item => item[0] === slot.role) || [])[2];
    if (allowOneM) {
      const mark = el('button', { type: 'button', class: 'pv-level pv-onem' + (slot.oneM ? ' on' : ''), text: '1M', title: '向工具声明这段上下文有 100 万', 'aria-pressed': String(!!slot.oneM), 'aria-label': (roleName || '') + ' 1M 上下文' });
      mark.addEventListener('click', () => {
        // 上下文还是预设值时跟着 1M 一起换；用户手动改过的保留
        const preset = contextPreset(editor?.app, slot);
        slot.oneM = !slot.oneM;
        if (!slot.contextWindow || slot.contextWindow === preset) { slot.contextWindow = contextPreset(editor?.app, slot); if (context) context.value = String(slot.contextWindow); }
        mark.classList.toggle('on', slot.oneM); mark.setAttribute('aria-pressed', String(slot.oneM));
      });
      row.append(mark);
    } else if (slot.role && slot.role !== 'catalog') row.append(el('span', { class: 'pv-slot-spacer', 'aria-hidden': 'true' }));
    return row;
  }
  function presetSection(app) {
    const items = app === 'claude' || app === 'desktop' ? [['anthropic', 'Anthropic 原生', '原生 Messages API'], ['openai-chat', 'OpenAI Chat 兼容', '需要本地路由转换'], ['openai-responses', 'OpenAI Responses 兼容', '需要本地路由转换']] : [['openai-responses', 'OpenAI Responses', 'Codex / Grok 原生'], ['openai-chat', 'OpenAI Chat 兼容', '需要本地路由转换']];
    const box = el('div', { class: 'pv-preset-strip' }, [el('span', { class: 'pv-section-copy-label', text: '快速预设' }), ...items.map(([id, label, note]) => { const b = button(label, () => { editor.upstream = id; root.querySelectorAll('.pv-editor [data-key=upstream] .pv-chip').forEach(chip => { const on = chip.dataset.value === id; chip.classList.toggle('on', on); chip.setAttribute('aria-checked', String(on)); }); showFeedback(label + ' 已应用，请继续填写地址和模型。', 'success'); showEditorPane('connect'); }, 'pv-chip'); b.title = note; return b; })]);
    return box;
  }
  function previewSection(app, provider) {
    const box = el('section', { class: 'pv-preview-section' });
    const pre = el('pre', { class: 'pv-preview-json', 'aria-label': 'CLI Provider Model 预览' });
    const refresh = button('刷新预览', () => { pre.textContent = buildPreview(app); }, 'btn');
    box.append(el('div', { class: 'pv-preview-head' }, [el('div', {}, [el('b', { text: '当前 CLI Provider Model' }), el('small', { text: '这是根据当前编辑草稿生成的预览，不会直接写入工具配置。保存前先在这里检查地址、模型、接口格式和敏感字段。' })]), refresh]), pre);
    requestAnimationFrame(() => { pre.textContent = buildPreview(app); });
    return box;
  }
  function buildPreview(app) {
    const form = root.querySelector('.pv-editor'); const data = form ? Object.fromEntries(new FormData(form).entries()) : {};
    if (editor?.pool) {
      const names = editor.pool.members.map(m => ({ type: m.type === 'account' ? '官方账号' : 'API Key 供应商', name: memberName(m) }));
      return JSON.stringify({ cli: appOf(app)?.name, pool: { name: data.name || '', strategy: STRATEGY[editor.pool.strategy], members: names },
        toolConfig: { baseUrl: routeAddress(app), apiKey: 'PROXY_MANAGED（占位，真实凭据只在 TokenPulse 里）', model: data.model || '由工具自己选' },
        forwarding: app === 'codex' ? '官方账号 → https://chatgpt.com/backend-api/codex/responses（Bearer + Chatgpt-Account-Id）' : app === 'grok' ? '官方账号 → https://cli-chat-proxy.grok.com/v1（Bearer）' : '官方账号 → https://api.anthropic.com（Bearer + anthropic-beta: oauth-2025-04-20）',
        failover: '成员返回 401 / 403 / 429 / 5xx 或连不上时换下一个；连续失败 3 次暂停 60 秒' }, null, 2);
    }
    const redact = value => value ? '••••••••' : '';
    const slots = editor?.slots || [];
    const models = slots.filter(slot => slot.model).map(slot => ({ role: slot.role, displayName: slot.displayName || slot.model, model: slot.model, contextWindow: slot.contextWindow || contextPreset(app, slot), oneM: slot.oneM, reasoningLevels: slot.reasoningLevels, defaultReasoningLevel: slot.defaultReasoningLevel }));
    const common = { name: data.name || '', baseUrl: data.baseUrl || '', upstream: editor?.upstream || '', model: data.model || slots.find(slot => slot.model)?.model || '', apiKey: redact(data.apiKey || editor?.provider?.hasKey) };
    if (app === 'claude') return JSON.stringify({ cli: 'Claude Code', provider: common, env: { ANTHROPIC_BASE_URL: common.baseUrl, [editor?.keyField || 'ANTHROPIC_AUTH_TOKEN']: common.apiKey, ANTHROPIC_MODEL: common.model, roles: models }, advanced: { headers: data.requestHeaders || '{}', body: data.requestBody || '{}', envOverrides: data.envOverrides || '{}' } }, null, 2);
    if (app === 'desktop') return JSON.stringify({ cli: 'Claude Desktop', provider: common, profile: { inferenceProvider: 'gateway', inferenceGatewayBaseUrl: common.baseUrl, inferenceGatewayApiKey: common.apiKey, inferenceModels: models.map(row => ({ name: row.role === 'catalog' ? row.model : 'claude-' + row.role + '-5', labelOverride: row.displayName, supports1m: row.oneM })) }, mode: editor?.desktopMode || 'map' }, null, 2);
    if (app === 'codex') return JSON.stringify({ cli: 'Codex', provider: common, config: { model_provider: 'tokenpulse_route', model: common.model, model_reasoning_effort: models[0]?.defaultReasoningLevel || 'auto', ...(editor?.codexContextWindow ? { model_context_window: editor.codexContextWindow } : {}), ...(editor?.codexAutoCompact ? { model_auto_compact_token_limit: editor.codexAutoCompact } : {}), model_catalog: models, model_providers: { tokenpulse_route: { base_url: common.baseUrl, wire_api: editor?.upstream === 'openai-chat' ? 'chat' : 'responses', experimental_bearer_token: common.apiKey, requires_openai_auth: false } } } }, null, 2);
    return JSON.stringify({ cli: 'Grok CLI', provider: common, config: { models: { default: 'tokenpulse_route' }, model: { tokenpulse_route: { model: common.model, base_url: common.baseUrl, api_backend: editor?.upstream === 'openai-chat' ? 'chat' : 'responses', context_window: editor?.contextWindow || contextPreset('grok') } } } }, null, 2);
  }
  function advancedSection(app, provider, field) {
    const p = provider || {};
    const jsonText = value => value && Object.keys(value).length ? JSON.stringify(value, null, 2) : '';
    const textArea = (name, label, value, hint) => el('label', { class: 'pv-field' }, [el('span', { text: label }), el('textarea', { name, rows: '4', spellcheck: 'false', autocomplete: 'off' }, [value || '']), hint ? el('small', { text: hint }) : null]);
    const check = (name, label, value, hint) => el('label', { class: 'pv-check' }, [el('input', { type: 'checkbox', name, checked: value ? '' : null }), el('span', {}, [el('b', { text: label }), el('small', { text: hint })])]);
    return el('div', { class: 'pv-advanced' }, [
      el('div', { class: 'pv-section-copy' }, [el('b', { text: '高级设置' }), el('small', { text: '对齐 CC Switch 的供应商元数据、请求覆盖与限额字段；不填写的字段保持默认。' })]),
      field('websiteUrl', '官网 / 供应商页面', { type: 'url', value: p.websiteUrl || '', placeholder: 'https://provider.example' }),
      field('category', '分类', { value: p.category || 'custom', placeholder: 'custom / official / partner' }),
      el('div', { class: 'pv-advanced-checks' }, [
        check('endpointAutoSelect', '自动选择端点', p.endpointAutoSelect, '只保存开关；当前不偷偷联网测速。'),
        check('commonConfigEnabled', '应用公共配置', p.commonConfigEnabled, '沿用工具公共配置，不覆盖用户设置。'),
        check('isFullUrl', '完整 API 端点', p.isFullUrl, '防止地址被自动拼接路径。'),
        check('codexFastMode', 'Codex FAST 模式', p.codexFastMode, '写入供应商元数据，供支持的 Codex 路径使用。'),
      ]),
      el('div', { class: 'pv-advanced-grid' }, [
        field('dailyLimitUsd', '每日限额（USD）', { type: 'number', min: '0', step: '0.01', value: p.dailyLimitUsd ?? '' }),
        field('monthlyLimitUsd', '每月限额（USD）', { type: 'number', min: '0', step: '0.01', value: p.monthlyLimitUsd ?? '' }),
        field('promptCacheKey', 'Prompt Cache Key', { value: p.promptCacheKey || '', placeholder: '可选' }),
        el('label', { class: 'pv-field' }, [el('span', { text: 'Prompt Cache 路由' }), el('select', { name: 'promptCacheRouting' }, [['auto','自动'],['enabled','启用'],['disabled','关闭']].map(([id,label]) => el('option', { value: id, text: label, selected: (p.promptCacheRouting || 'auto') === id ? '' : null })))])
      ]),
      textArea('envOverrides', '额外环境变量（JSON）', jsonText(p.envOverrides), '例如 {"CLAUDE_CODE_DISABLE_THINKING":"1"}。'),
      textArea('requestHeaders', '请求头覆盖（JSON）', jsonText(p.requestHeaders), '本地路由会合并到上游请求。'),
      textArea('requestBody', '请求体覆盖（JSON）', jsonText(p.requestBody), '协议转换完成后合并；仅填写明确需要的字段。'),
    ]);
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
      if (pending || editor.fetching) return;
      const draft = editor, form = root.querySelector('.pv-editor');
      const connection = () => JSON.stringify([form.elements.baseUrl.value, form.elements.apiKey.value, draft.upstream]);
      const requestedConnection = connection();
      draft.fetching = true; fetch.disabled = true; fetch.setAttribute('aria-busy', 'true');
      showFeedback('正在获取模型候选…', 'pending');
      try {
        const result = await api.agentModels({ id: provider?.id, baseUrl: form?.elements.baseUrl.value, apiKey: form?.elements.apiKey.value, upstream: draft.upstream });
        if (editor !== draft || !form.isConnected || pending) return;
        if (connection() !== requestedConnection) { showFeedback('连接信息已改变，已忽略旧模型候选，请重新获取。', 'warning'); return; }
        if (!result?.ok) { showFeedback(result?.error || '获取模型失败', 'error'); return; }
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
            if (index < 0) { showFeedback('没有空模型行，请先清空目标行或添加模型。', 'warning'); return; }
            const row = box.querySelectorAll('.pv-slot:not(.pv-slot-head)')[index];
            const input = row?.querySelector('input[placeholder="实际请求模型"]');
            if (input) { input.value = id; input.dispatchEvent(new Event('input', { bubbles: true })); }
            const name = row?.querySelector('input[placeholder="菜单显示名"]');
            if (name && !name.value) { name.value = id; name.dispatchEvent(new Event('input', { bubbles: true })); }
          });
          return chip;
        }));
        showFeedback(draft.fetched.length ? '已获取模型候选；点击填入首个空模型行（Grok 替换当前模型）。' : '没有拿到模型，请确认接口地址。', draft.fetched.length ? 'success' : 'warning');
      } catch (error) {
        if (editor === draft && !pending && form.isConnected) showFeedback(error?.message || '获取模型失败', 'error');
      } finally {
        draft.fetching = false; fetch.disabled = pending; fetch.removeAttribute('aria-busy');
        // 中途离开编辑页等提前返回的情况：别把「正在获取」留在右上角
        if (feedback?.kind === 'pending' && feedback.message === '正在获取模型候选…') clearPending();
      }
    }, 'btn');
    fetch.dataset.action = 'fetch-models';
    head.append(fetch);
    box.append(head);
    if (app === 'desktop') {
      const modes = el('div', { class: 'pv-chips pv-mode-chips', role: 'radiogroup', 'aria-label': '桌面端连接方式' });
      for (const [id, label] of [['direct', '直连'], ['map', '模型映射']]) {
        const b = el('button', { type: 'button', class: 'pv-chip' + (editor.desktopMode === id ? ' on' : ''), text: label, role: 'radio', 'aria-checked': String(editor.desktopMode === id) });
        b.addEventListener('click', () => { editor.desktopMode = id; modes.querySelectorAll('.pv-chip').forEach(n => { n.classList.toggle('on', n === b); n.setAttribute('aria-checked', String(n === b)); }); });
        modes.append(b);
      }
      box.append(modes);
    }
    if (app === 'grok') {
      box.append(el('label', { class: 'pv-field' }, [el('span', { text: '模型' }), el('input', { name: 'model', autocomplete: 'off', spellcheck: 'false', translate: 'no', value: provider?.model || '', required: '' })]));
      const contextInput = el('input', { type: 'number', min: '1', value: provider?.contextWindow || contextPreset(app, { oneM: false }), placeholder: '例如 128000' });
      contextInput.addEventListener('input', () => { editor.contextWindow = Number(contextInput.value) || null; });
      box.append(el('label', { class: 'pv-field' }, [el('span', { text: '上下文窗口' }), contextInput]));
      const thinking = el('div', { class: 'pv-levels' });
      for (const [key, label] of [['supportsThinking', '支持思考'], ['supportsEffort', '支持思考等级']]) {
        const b = el('button', { type: 'button', class: 'pv-level' + (editor.thinking[key] ? ' on' : ''), text: label, 'aria-pressed': String(editor.thinking[key]) });
        b.addEventListener('click', () => { editor.thinking[key] = !editor.thinking[key]; b.classList.toggle('on', editor.thinking[key]); b.setAttribute('aria-pressed', String(editor.thinking[key])); });
        thinking.append(b);
      }
      box.append(thinking, el('div', { class: 'pv-fetched' }));
      return box;
    }
    const rows = el('div', { class: 'pv-slot-list', 'data-app': app });
    const columns = app === 'codex' ? ['菜单显示名', '实际请求模型', '上下文', '思考等级', ''] : ['角色', '菜单显示名', '实际请求模型', '上下文', '1M'];
    const header = el('div', { class: 'pv-slot pv-slot-head', 'data-app': app, 'aria-hidden': 'true' }, columns.map(text => el('span', { text })));
    const drawRows = () => {
      closeLevels();
      rows.replaceChildren(header, ...editor.slots.map((slot, index) => {
        const row = slotRow(slot, index === 0);
        if (app === 'codex') {
          const context = el('input', { type: 'number', min: '1', value: slot.contextWindow || contextPreset(app, slot), placeholder: '上下文', 'aria-label': '上下文窗口 ' + (index + 1) });
          context.addEventListener('input', () => { slot.contextWindow = Number(context.value) || null; });
          row.append(context, levelChips(slot));
          const remove = button('', () => { editor.slots.splice(index, 1); if (!editor.slots.length) editor.slots.push(blankSlot('catalog')); drawRows(); const left = rows.querySelectorAll('.pv-slot:not(.pv-slot-head)'); left[Math.min(index, left.length - 1)]?.querySelector('input')?.focus(); }, 'pv-icon-btn', 'close');
          remove.setAttribute('aria-label', '删除模型行 ' + (index + 1)); remove.title = '删除模型行 ' + (index + 1);
          row.append(remove);
        }
        return row;
      }));
    };
    drawRows();
    const tools = el('div', { class: 'pv-model-tools' });
    if (app === 'codex') box.append(codexContextBox(drawRows));
    box.append(rows, el('div', { class: 'pv-fetched' }), tools);
    if (app === 'codex') tools.append(button('添加模型', () => {
      if (editor.slots.length >= 24) { showFeedback('最多支持 24 个模型；请编辑已有模型行。', 'warning'); return; }
      editor.slots.push(blankSlot('catalog')); drawRows();
      rows.lastElementChild?.querySelector('input[placeholder="实际请求模型"]')?.focus();
    }, 'btn', 'plus'));
    if (app === 'claude') tools.append(button('一键填到全部角色', () => {
      const value = editor.slots.find(slot => slot.model)?.model;
      if (!value) { showFeedback('先在任意一个角色里填好模型，再一键填到全部角色。', 'warning'); return; }
      for (const slot of editor.slots) { slot.model = value; if (!slot.displayName) slot.displayName = value; }
      drawRows();
    }, 'btn'));
    return box;
  }

  /*
   * Codex 整体上下文（0.3.9）：和 CC Switch 一样，一键「1M 上下文」写 model_context_window = 1000000、
   * 自动压缩阈值没填时补 900000；也可以自己填任意值。空着就不写，跟随 Codex 默认。
   * 打开 1M 时，模型行里还是预设 128000 的上下文一起改成 100 万（手动改过的保留），关掉时再改回来。
   */
  const ONE_M = 1000000, ONE_M_COMPACT = 900000;
  function codexContextBox(redrawSlots) {
    const windowInput = el('input', { type: 'number', min: '1000', max: '10000000', step: '1000', name: 'codexContextWindow', placeholder: '不写（跟随 Codex 默认）', value: editor.codexContextWindow || '', 'aria-label': '上下文窗口 model_context_window' });
    const compactInput = el('input', { type: 'number', min: '1000', max: '10000000', step: '1000', name: 'codexAutoCompact', placeholder: '不写（跟随 Codex 默认）', value: editor.codexAutoCompact || '', 'aria-label': '自动压缩阈值 model_auto_compact_token_limit' });
    const oneM = el('button', { type: 'button', class: 'pv-level pv-onem pv-codex-onem', text: '1M 上下文', 'aria-pressed': 'false', 'data-action': 'codex-1m', title: '写入 model_context_window = 1000000，并把自动压缩阈值设为 900000' });
    const sync = () => {
      const on = editor.codexContextWindow === ONE_M;
      oneM.classList.toggle('on', on); oneM.setAttribute('aria-pressed', String(on));
      windowInput.value = editor.codexContextWindow || ''; compactInput.value = editor.codexAutoCompact || '';
    };
    const slotsTo = (from, to) => { let changed = false; for (const slot of editor.slots) if (!slot.contextWindow || slot.contextWindow === from) { slot.contextWindow = to; changed = true; } if (changed) redrawSlots(); };
    oneM.addEventListener('click', () => {
      if (editor.codexContextWindow === ONE_M) {
        editor.codexContextWindow = null; editor.codexAutoCompact = null;
        slotsTo(ONE_M, contextPreset('codex'));
      } else {
        editor.codexContextWindow = ONE_M;
        if (!editor.codexAutoCompact || editor.codexAutoCompact >= ONE_M) editor.codexAutoCompact = ONE_M_COMPACT;
        slotsTo(contextPreset('codex'), ONE_M);
      }
      sync();
    });
    windowInput.addEventListener('input', () => { editor.codexContextWindow = Number(windowInput.value) || null; oneM.classList.toggle('on', editor.codexContextWindow === ONE_M); oneM.setAttribute('aria-pressed', String(editor.codexContextWindow === ONE_M)); });
    compactInput.addEventListener('input', () => { editor.codexAutoCompact = Number(compactInput.value) || null; });
    sync();
    return el('div', { class: 'pv-codex-context' }, [
      el('div', { class: 'pv-codex-context-head' }, [
        el('div', {}, [el('b', { text: '整体上下文' }), el('small', { text: '写进 config.toml 顶层。社区常见做法是放开到 1M；上游不支持这么长时会报错，改回来就行。' })]),
        oneM,
      ]),
      el('div', { class: 'pv-codex-context-fields' }, [
        el('label', { class: 'pv-field' }, [el('span', {}, ['上下文窗口 ', el('code', { text: 'model_context_window', translate: 'no' })]), windowInput]),
        el('label', { class: 'pv-field' }, [el('span', {}, ['自动压缩阈值 ', el('code', { text: 'model_auto_compact_token_limit', translate: 'no' })]), compactInput]),
      ]),
    ]);
  }

  /** 头像：当前效果 + 自动 / 首字母 / 25 个预设 + 上传。 */
  function draftProvider() {
    const form = root.querySelector('.pv-editor');
    return { name: form?.elements.name?.value || editor?.provider?.name || '', baseUrl: form?.elements.baseUrl?.value || editor?.provider?.baseUrl || '', icon: editor?.icon || '', avatar: editor?.avatar || '', pool: editor?.pool, app: editor?.app };
  }
  function syncAvatarPreview() {
    const slot = root.querySelector('.pv-avatar-now');
    if (!slot || !editor) return;
    const draft = draftProvider(), image = window.PulseAvatars?.resolve(draft);
    slot.replaceChildren(providerMark(draft, 'pv-mark pv-avatar-big'), el('div', {}, [el('b', { text: '头像' }), el('small', { text: editor.avatar ? '自定义图片' : editor.icon === 'letter' ? '名称首字母' : editor.icon ? (window.PulseAvatars?.byId(editor.icon)?.label || editor.icon) : editor.pool ? '默认：号池图标' : image ? `自动匹配：${image.label}` : '自动匹配：没认出来，先用首字母' })]));
    root.querySelectorAll('.pv-avatar-grid [data-icon]').forEach(b => { const on = !editor.avatar && b.dataset.icon === editor.icon; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  }
  function avatarPicker() {
    const choose = value => { editor.icon = value; editor.avatar = ''; syncAvatarPreview(); };
    const tile = (value, label, content) => {
      const b = el('button', { type: 'button', class: 'pv-avatar-tile', role: 'radio', 'data-icon': value, title: label, 'aria-label': label }, content);
      b.addEventListener('click', () => choose(value));
      return b;
    };
    const grid = el('div', { class: 'pv-avatar-grid', role: 'radiogroup', 'aria-label': '选择头像' }, [
      tile('', '自动匹配', [icon('refresh')]),
      tile('letter', '名称首字母', [el('b', { text: 'Aa' })]),
      ...(window.PulseAvatars?.PRESETS || []).map(item => tile(item.id, item.label, [el('img', { src: item.src, alt: '', class: item.mono ? 'mono' : null, draggable: 'false' })])),
    ]);
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml', hidden: '', 'aria-label': '上传头像图片' });
    file.addEventListener('change', async () => {
      const picked = file.files?.[0]; file.value = '';
      if (!picked) return;
      try { editor.avatar = await window.PulseAvatars.readImage(picked); syncAvatarPreview(); showFeedback('头像已换成上传的图片，保存后生效。', 'success'); }
      catch (error) { showFeedback(error?.message || '图片读取失败', 'error'); }
    });
    const upload = button('上传图片', () => file.click(), 'btn', 'plus');
    const box = el('section', { class: 'pv-avatar-field' }, [
      el('div', { class: 'pv-avatar-head' }, [el('div', { class: 'pv-avatar-now' }), el('div', { class: 'pv-avatar-actions' }, [upload, file])]),
      grid,
    ]);
    requestAnimationFrame(syncAvatarPreview);
    return box;
  }
  function poolAccounts() {
    const kind = appOf(editor.app)?.kind, box = el('div', { class: 'pv-pool-accounts pv-pick-list' });
    if (!editor.accounts) { box.append(el('p', { class: 'pv-hint', text: '正在读取设置里的官方账号…' })); return box; }
    if (!editor.accounts.length) {
      const go = button('去设置添加账号', () => openSettings('accounts'), 'btn', 'plus');
      box.append(el('div', { class: 'pv-empty' }, [el('p', { text: `设置里还没有 ${appOf(editor.app)?.name} 能用的官方账号。在「设置 → 账号」里用官方 CLI 登录几个账号，就能加进号池。` }), go]));
      return box;
    }
    box.append(...editor.accounts.map(acc => pickRow({ type: 'account', id: acc.id }, avatar(kind, 'pv-pick-avatar'), acc.alias || acc.email || acc.label, acc.usable ? (acc.email && acc.alias ? acc.email : '凭据可用') : acc.needsLogin ? '需要重新登录' : '凭据已过期（TokenPulse 登录的会自动续期）', !acc.usable)));
    return box;
  }
  function pickRow(member, lead, name, sub, warn) {
    const on = editor.pool.members.some(m => m.type === member.type && m.id === member.id);
    const input = el('input', { type: 'checkbox', checked: on ? '' : null });
    input.addEventListener('change', () => {
      if (input.checked) editor.pool.members.push(member);
      else editor.pool.members = editor.pool.members.filter(m => !(m.type === member.type && m.id === member.id));
      root.querySelector('.pv-pool-order')?.replaceWith(poolOrder());
    });
    return el('label', { class: 'pv-pick' + (on ? ' on' : '') }, [input, lead, el('span', { class: 'pv-pick-text' }, [el('b', { text: name, translate: 'no' }), el('small', { class: warn ? 'warn' : null, text: sub })])]);
  }
  function poolOrder() {
    const list = editor.pool.members;
    const box = el('ol', { class: 'pv-pool-order', 'aria-label': '轮换顺序' });
    if (!list.length) { box.append(el('li', { class: 'pv-hint', text: '还没选成员。' })); return box; }
    list.forEach((m, i) => {
      const move = step => { const j = i + step; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; box.replaceWith(poolOrder()); root.querySelectorAll('.pv-pool-order li')[j]?.querySelector('button:not([disabled])')?.focus(); };
      const up = iconButton('up', '往前移', () => move(-1)); up.disabled = i === 0;
      const down = iconButton('up', '往后移', () => move(1), 'flip'); down.disabled = i === list.length - 1;
      box.append(el('li', {}, [el('span', { class: 'pv-order-no', text: String(i + 1) }), el('span', { class: 'pv-member-kind', text: m.type === 'account' ? '账号' : 'Key' }), el('b', { text: memberName(m), translate: 'no' }), up, down]));
    });
    return box;
  }
  function poolMembers() {
    const strategy = el('div', { class: 'pv-chips', role: 'radiogroup', 'aria-label': '轮换方式' }, [['round-robin', '轮询', '每个请求换下一个成员，用量摊平'], ['fill-first', '用满再换', '一直用第一个，出错或限流才换下一个']].map(([id, label, note]) => {
      const b = el('button', { type: 'button', class: 'pv-chip' + (editor.pool.strategy === id ? ' on' : ''), role: 'radio', 'aria-checked': String(editor.pool.strategy === id), 'data-value': id }, [el('span', { text: label }), el('small', { text: note })]);
      b.addEventListener('click', () => { editor.pool.strategy = id; strategy.querySelectorAll('.pv-chip').forEach(n => { const on = n === b; n.classList.toggle('on', on); n.setAttribute('aria-checked', String(on)); }); });
      return b;
    }));
    const keys = providersOf(editor.app).filter(p => !p.official && !p.locked && !p.pool && p.baseUrl);
    return el('div', { class: 'pv-pool-editor' }, [
      el('div', { class: 'pv-field' }, [el('span', { text: '轮换方式' }), strategy]),
      el('div', { class: 'pv-pool-group' }, [el('div', { class: 'pv-pool-group-head' }, [el('b', { text: '官方账号' }), el('small', { text: '用各账号自己的登录凭据，直接转给官方接口。是否符合各家的服务条款，请自行判断。' })]), poolAccounts()]),
      el('div', { class: 'pv-pool-group' }, [el('div', { class: 'pv-pool-group-head' }, [el('b', { text: 'API Key 供应商' }), el('small', { text: '同一工具下已保存的供应商，用它们自己的地址和密钥。' })]),
        keys.length ? el('div', { class: 'pv-pick-list' }, keys.map(p => pickRow({ type: 'provider', id: p.id }, providerMark(p, 'pv-mark pv-pick-avatar'), p.name, [p.model, formatName(p.upstream)].filter(Boolean).join(' · ')))) : el('p', { class: 'pv-hint', text: '这个工具下还没有 API Key 供应商。' })]),
      el('div', { class: 'pv-pool-group' }, [el('div', { class: 'pv-pool-group-head' }, [el('b', { text: '顺序' }), el('small', { text: '轮询从上一次的下一个开始；用满再换总是从第一个开始。' })]), poolOrder()]),
    ]);
  }

  function openDrawer(app, provider = null, pane = 'basic', newPool = false) {
    if (pending) return;
    const isPool = !!provider?.pool || newPool;
    editorPane = pane;
    editor = { app, provider, pool: isPool ? { strategy: provider?.pool?.strategy || 'round-robin', members: (provider?.pool?.members || []).map(m => ({ type: m.type, id: m.id })) } : null, icon: provider?.icon || '', avatar: provider?.avatar || '', accounts: null, upstream: provider?.upstream || NATIVE[app], keyField: provider?.apiKeyField || 'ANTHROPIC_AUTH_TOKEN', desktopMode: provider?.desktopMode || (app === 'desktop' ? 'map' : 'direct'), contextWindow: provider?.contextWindow || (app === 'grok' ? contextPreset('grok') : null), codexContextWindow: provider?.codexContextWindow || null, codexAutoCompact: provider?.codexAutoCompact || null, thinking: { supportsThinking: !!provider?.thinking?.supportsThinking, supportsEffort: !!provider?.thinking?.supportsEffort }, slots: seedSlots(app, provider), fetched: [], fetching: false };
    render(true);
    editor.initial = editorFingerprint();
    showEditorPane(pane);
    if (pane === 'basic') requestAnimationFrame(() => root.querySelector('.pv-editor input[name=name]')?.focus());
    if (isPool) loadPoolAccounts(editor);
  }
  /** 号池能选的官方账号：设置里登录过的同一家账号（界面数据里没有凭据）。 */
  async function loadPoolAccounts(draft) {
    const kind = appOf(draft.app)?.kind;
    let list = [];
    try { list = ((await api.officialAccounts()) || []).find(item => item.kind === kind)?.accounts || []; } catch { list = []; }
    if (editor !== draft) return;
    draft.accounts = list.filter(item => !item.hidden);
    root.querySelector('.pv-pool-accounts')?.replaceWith(poolAccounts());
  }
  function memberName(m) {
    if (m.type === 'provider') return providersOf(editor?.app).find(p => p.id === m.id)?.name || '已删除的供应商';
    const acc = editor?.accounts?.find(a => a.id === m.id);
    return acc ? acc.alias || acc.email || acc.label : editor?.provider?.pool?.members.find(x => x.id === m.id)?.name || m.id;
  }
  function editorFingerprint() {
    const form = root.querySelector('.pv-editor');
    if (!editor || !form) return '';
    return JSON.stringify([Object.fromEntries(new FormData(form)), editor.upstream, editor.keyField, editor.desktopMode, editor.contextWindow, editor.codexContextWindow, editor.codexAutoCompact, editor.thinking, editor.slots, editor.icon, editor.avatar, editor.pool]);
  }
  function closeDrawer(force = false) {
    if (pending) return;
    if (force !== true && editor && editor.initial !== editorFingerprint()) {
      // 离开前确认：也用右上角的弹窗（带两个按钮），不在表单里插提示
      if (document.querySelector('.tp-toast.pv-unsaved')) return;
      const note = toast('有尚未保存的修改，要放弃吗？', { kind: 'warning', key: 'providers-unsaved', cls: 'pv-unsaved', actions: [
        { label: '继续编辑', onClick: () => root.querySelector('.pv-editor input, .pv-editor button')?.focus() },
        { label: '放弃修改', onClick: () => closeDrawer(true) },
      ] });
      note.node.querySelector('.tp-toast-actions button')?.focus();
      return;
    }
    document.querySelector('.tp-toast.pv-unsaved') && toastKeys.get('providers-unsaved')?.dispose();
    if (editor?.fetching) clearPending();
    closeLevels();
    editor = null;
    editorPane = 'basic';
    render(false);
  }
  function showEditorPane(id) {
    if (pending) return;
    editorPane = id;
    const controls = root.querySelectorAll('.pv-editor-actions > button');
    if (controls.length) { controls[0].disabled = id === 'basic'; controls[1].hidden = id === (editor?.pool ? 'preview' : 'advanced'); }
    root.querySelectorAll('.pv-editor [data-pane]').forEach(node => { node.hidden = node.dataset.pane !== id; });
    root.querySelectorAll('.pv-nav [data-section^="edit-"]').forEach(node => {
      const on = node.dataset.section === `edit-${id}`;
      node.classList.toggle('on', on);
      node.setAttribute('aria-selected', String(on));
    });
    closeLevels();
    if (id === 'preview') { const pre = root.querySelector('.pv-preview-json'); if (pre && editor) pre.textContent = buildPreview(editor.app); }
    root.querySelector(`.pv-editor [data-pane="${id}"] input, .pv-editor [data-pane="${id}"] textarea`)?.focus();
  }
  function editorNav() {
    const app = appOf(editor.app);
    const item = (id, label, sub) => {
      const b = el('button', { type: 'button', class: 'pv-nav-item' + (editorPane === id ? ' on' : ''), 'data-section': `edit-${id}`, role: 'tab', 'aria-selected': String(editorPane === id) }, [
        el('span', { class: 'pv-nav-icon' }, [icon(id === 'basic' ? 'edit' : id === 'connect' ? 'route' : id === 'models' ? 'usage' : id === 'members' ? 'user' : id === 'preview' ? 'terminal' : 'settings')]),
        el('span', { class: 'pv-nav-text' }, [el('b', { text: label }), el('small', { text: sub })]),
      ]);
      b.addEventListener('click', () => showEditorPane(id));
      return b;
    };
    const back = el('button', { type: 'button', class: 'pv-nav-item', 'data-section': 'edit-back' }, [
      el('span', { class: 'pv-nav-icon' }, [icon('left')]),
      el('span', { class: 'pv-nav-text' }, [el('b', { text: '返回' }), el('small', { text: app?.name || '供应商', translate: 'no' })]),
    ]);
    back.addEventListener('click', () => closeDrawer());
    const save = el('button', { type: 'button', class: 'pv-nav-item', 'data-action': 'save-provider' }, [
      el('span', { class: 'pv-nav-icon' }, [icon('check')]),
      el('span', { class: 'pv-nav-text' }, [el('b', { text: '保存' }), el('small', { text: '写回这一家' })]),
    ]);
    save.addEventListener('click', () => root.querySelector('.pv-editor')?.requestSubmit());
    const cancel = el('button', { type: 'button', class: 'pv-nav-item', 'data-action': 'cancel-edit' }, [
      el('span', { class: 'pv-nav-icon' }, [icon('close')]),
      el('span', { class: 'pv-nav-text' }, [el('b', { text: '取消' }), el('small', { text: '不保存，回到列表' })]),
    ]);
    cancel.addEventListener('click', () => closeDrawer());
    const box = el('nav', { class: 'pv-nav', role: 'tablist', 'aria-label': '编辑供应商' });
    box.append(
      el('div', { class: 'pv-nav-group' }, [back]),
      el('div', { class: 'pv-nav-group' }, [el('span', { class: 'pv-nav-title', text: '设置' }), ...(editor.pool
        ? [item('basic', '基本信息', '名称、头像和模型'), item('members', '成员', '账号和轮换方式'), item('preview', '预览', '工具会看到的配置')]
        : [item('basic', '基本信息', '名称、头像和备注'), item('connect', '连接', '地址和密钥'), item('models', '模型', '候选和思考等级'), item('preview', '预览', '当前 CLI Provider Model'), item('advanced', '高级', '元数据与请求覆盖')])]),
      el('div', { class: 'pv-nav-group' }, [save, cancel]),
    );
    return box;
  }
  function editorForm() {
    const { app, provider } = editor, a = appOf(app);
    const field = (name, label, attrs = {}, hint) => el('label', { class: 'pv-field' }, [el('span', { text: label }), el('input', { name, autocomplete: 'off', spellcheck: 'false', ...attrs }), hint ? el('small', { text: hint }) : null]);
    const chips = (items, value, key) => {
      const box = el('div', { class: 'pv-chips', role: 'radiogroup', 'data-key': key }, items.map(([id, label, note]) => {
        const b = el('button', { type: 'button', class: 'pv-chip' + (value === id ? ' on' : ''), role: 'radio', 'aria-checked': String(value === id), 'data-value': id }, [el('span', { text: label, translate: 'no' }), note ? el('small', { text: note }) : null]);
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
    const title = editor.pool ? (provider ? '编辑号池' : '新建号池') : provider ? '编辑供应商' : '添加供应商';
    const nameInput = field('name', '名称', { value: provider?.name || '', maxlength: '60', placeholder: editor.pool ? '例如：Claude 三号轮换' : '' });
    const notes = el('label', { class: 'pv-field' }, [el('span', { text: '备注' }), el('textarea', { name: 'notes', rows: '3', maxlength: '400' }, [provider?.notes || ''])]);
    const form = el('form', { novalidate: '', class: 'pv-editor', 'aria-label': title }, [
      head(title, a.name, [button('取消', () => closeDrawer()), el('button', { type: 'submit', class: 'btn btn-accent', 'data-action': 'save-provider' }, [icon('check'), el('span', { text: '保存' })])], appMark(app, 'pv-head-avatar')),
      ...(editor.pool ? [
        pane('basic',
          avatarPicker(),
          nameInput,
          field('model', app === 'grok' ? '模型' : '默认模型（可选）', { value: provider?.model || '', translate: 'no', placeholder: app === 'grok' ? '例如 grok-4.7-build' : '留空就由工具自己选模型' }, app === 'grok' ? 'Grok CLI 的配置表必须写一个模型名。' : '留空时工具照常发自己选的模型，号池原样转给官方。'),
          notes,
        ),
        pane('members', poolMembers()),
        pane('preview', previewSection(app, provider)),
      ] : [
      pane('basic',
        avatarPicker(),
        presetSection(app),
        nameInput,
        notes,
      ),
      pane('connect',
        el('div', { class: 'pv-field' }, [el('span', { text: '接口格式' }), chips(FORMATS.map(([id, label]) => [id, label, id === NATIVE[app] ? '原生' : '需要本地路由']), editor.upstream, 'upstream'), el('small', { text: `${a.name} 自己说的是 ${formatName(NATIVE[app])}；选别的格式时由本地路由转换。` })]),
        field('baseUrl', '请求地址', { value: provider?.baseUrl || '', placeholder: 'https://api.example.com/v1', translate: 'no' }),
        field('apiKey', 'API Key', { type: 'password', placeholder: provider?.hasKey ? `留空就用原来的密钥（••••${provider.keyHint}）` : '' }),
        app === 'claude' ? el('div', { class: 'pv-field' }, [el('span', { text: '密钥写进哪个变量' }), chips([['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', '多数中转站'], ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', '官方 API Key']], editor.keyField, 'keyField')]) : null,
      ),
      pane('models', modelSection(app, provider)),
      pane('preview', previewSection(app, provider)),
      pane('advanced', advancedSection(app, provider, field)),
      ]),
    ]);
    // 头像自动匹配跟着名称 / 地址实时变
    form.addEventListener('input', e => { if ((e.target.name === 'name' || e.target.name === 'baseUrl') && !editor.icon && !editor.avatar) syncAvatarPreview(); });
    const steps = editor.pool ? ['basic', 'members', 'preview'] : ['basic', 'connect', 'models', 'preview', 'advanced'];
    const footer = el('div', { class: 'pv-editor-actions' }, [
      button('上一步', () => showEditorPane(steps[Math.max(0, steps.indexOf(editorPane) - 1)])),
      button('下一步', () => showEditorPane(steps[Math.min(steps.length - 1, steps.indexOf(editorPane) + 1)])),
      el('button', { type: 'submit', class: 'btn btn-accent', 'data-action': 'save-provider', text: '保存供应商' }),
    ]);
    form.append(el('p', { class: 'pv-hint', text: editor.pool ? 'Ctrl / ⌘ + Enter 保存。号池只能经本地路由使用：点「启用」时会自动打开这个工具的本地路由。' : 'Ctrl / ⌘ + Enter 保存。新增不会自动启用；当前供应商仅在工具配置仍由 TokenPulse 管理时同步修改。' }), footer);
    form.addEventListener('invalid', e => {
      const pane = e.target.closest('[data-pane]');
      if (pane) showEditorPane(pane.dataset.pane);
    }, true);
    let saving = false;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (saving || pending) return;
      const data = Object.fromEntries([...new FormData(form).entries()].map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
      if (editor.pool) {
        if (!data.name) { showFeedback('请填写号池名称。', 'error'); showEditorPane('basic'); return; }
        if (app === 'grok' && !data.model) { showFeedback('Grok 号池要填一个模型名。', 'error'); showEditorPane('basic'); return; }
        if (!editor.pool.members.length) { showFeedback('号池至少要选一个成员。', 'error'); showEditorPane('members'); return; }
        const poolInput = { app, name: data.name, notes: data.notes, model: data.model, icon: editor.icon, avatar: editor.avatar, iconColor: provider?.iconColor || '', pool: editor.pool, ...(provider ? { id: provider.id } : {}) };
        saving = true;
        const draft = editor;
        try {
          const done = await run(() => api.agentSave(poolInput), provider ? '号池已保存' : '号池已创建；点「启用」后，这个工具的请求会在成员之间轮流转发。', '正在保存号池…');
          if (done && editor === draft) closeDrawer(true);
        } finally { saving = false; if (editor === draft) root.querySelectorAll('[data-action="save-provider"]').forEach(b => { b.disabled = false; }); }
        return;
      }
      if (!data.name || !data.baseUrl || !data.model || (!data.apiKey && !provider?.hasKey)) {
        showFeedback('请补全名称、请求地址、密钥和模型；已定位到需要填写的步骤。', 'error');
        showEditorPane(!data.name ? 'basic' : !data.baseUrl || (!data.apiKey && !provider?.hasKey) ? 'connect' : 'models');
        return;
      }
      if (!form.reportValidity()) return;
      const parseJson = (name) => { const raw = String(data[name] || '').trim(); if (!raw) return {}; try { const value = JSON.parse(raw); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; } catch { showFeedback(name + ' 需要是 JSON 对象。', 'error'); showEditorPane('advanced'); return null; } };
      const envOverrides = parseJson('envOverrides'); const requestHeaders = parseJson('requestHeaders'); const requestBody = parseJson('requestBody');
      if (!envOverrides || !requestHeaders || !requestBody) return;
      if (editor.slots[0] && data.model) editor.slots[0].model = data.model;
      const input = { app, name: data.name, baseUrl: data.baseUrl, apiKey: data.apiKey, model: data.model, notes: data.notes, upstream: editor.upstream, apiKeyField: editor.keyField, slots: editor.slots, desktopMode: editor.desktopMode, contextWindow: editor.contextWindow, ...(app === 'codex' ? { codexContextWindow: editor.codexContextWindow, codexAutoCompact: editor.codexAutoCompact } : {}), thinking: editor.thinking, websiteUrl: data.websiteUrl, category: data.category, icon: editor.icon, avatar: editor.avatar, iconColor: provider?.iconColor || '', endpointAutoSelect: data.endpointAutoSelect === 'on', commonConfigEnabled: data.commonConfigEnabled === 'on', isFullUrl: data.isFullUrl === 'on', promptCacheKey: data.promptCacheKey, promptCacheRouting: data.promptCacheRouting, codexFastMode: data.codexFastMode === 'on', dailyLimitUsd: data.dailyLimitUsd, monthlyLimitUsd: data.monthlyLimitUsd, envOverrides, requestHeaders, requestBody, ...(provider ? { id: provider.id, keepKey: !data.apiKey } : {}) };
      saving = true;
      const draft = editor;
      try {
        const done = await run(() => api.agentSave(input), provider ? '供应商修改已保存' : '供应商已添加；点击启用才会切换工具配置。', '正在保存供应商，编辑内容暂时锁定…');
        if (done && editor === draft) closeDrawer(true);
      } finally {
        saving = false;
        if (editor === draft) root.querySelectorAll('[data-action="save-provider"]').forEach(button => { button.disabled = false; });
      }
    });
    form.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!pending) form.requestSubmit(); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); }
    });
    return form;
  }

  /* ---------------- 配置保护（0.3.9）：只读保护、改动确认、配置备份 ---------------- */

  /** 改动对比：一个文件一块，红删绿增，只留改动附近的几行；密钥在主进程里已经打码。 */
  function diffBlock(f, open = true, title = null) {
    const lines = el('div', { class: 'pv-diff-lines', role: 'table', 'aria-label': f.name + ' 的改动' }, f.lines.map(line => el('div', { class: 'pv-diff-line ' + ({ '+': 'add', '-': 'del', '…': 'gap' }[line.kind] || 'same'), role: 'row' }, [
      el('span', { class: 'pv-diff-sign', 'aria-hidden': 'true', text: line.kind === '…' ? '⋯' : line.kind === ' ' ? '' : line.kind }),
      el('code', { translate: 'no', text: line.kind === '…' ? '' : line.text || ' ' }),
    ])));
    const summary = el('summary', {}, title ? [el('span', { class: 'pv-diff-toggle', text: title })] : [
      el('span', { class: 'pv-diff-tool', text: f.tool }),
      el('b', { text: f.name, translate: 'no', title: f.file }),
      f.created ? el('span', { class: 'pv-diff-tag', text: '新建' }) : f.removed ? el('span', { class: 'pv-diff-tag del', text: '删除' }) : null,
      el('span', { class: 'pv-diff-count' }, [el('i', { class: 'add', text: '+' + f.added }), el('i', { class: 'del', text: '−' + f.deleted })]),
    ]);
    const box = el('details', { class: 'pv-diff' }, [summary, el('p', { class: 'pv-diff-path', translate: 'no', text: f.file }), f.lines.length ? lines : el('p', { class: 'pv-diff-empty', text: '内容相同' })]);
    box.open = open;
    return box;
  }

  /** 确认对话框：返回 Promise<boolean>。Esc / 取消 / 点遮罩都是不写。 */
  function confirmChanges(confirm) {
    return new Promise(resolve => {
      const last = document.activeElement;
      const cancel = el('button', { type: 'button', class: 'btn', text: '取消' });
      const ok = el('button', { type: 'button', class: 'btn btn-accent', text: '确认写入' });
      const files = confirm.files || [];
      const card = el('section', { class: 'modal-card pv-confirm-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pv-confirm-title' }, [
        el('header', { class: 'pv-confirm-head' }, [
          el('span', { class: 'pv-confirm-icon', 'aria-hidden': 'true' }, [icon('alert')]),
          el('div', {}, [
            el('h2', { id: 'pv-confirm-title', text: '确认改动工具配置' }),
            el('p', {}, [el('b', { text: confirm.reason || '这次操作' }), el('span', { text: ` 会改动 ${files.length} 个配置文件。下面是逐行对比，密钥已打码。写入前会自动备份，之后可以在「配置保护」里一键还原。` })]),
          ]),
        ]),
        el('div', { class: 'pv-confirm-body' }, files.map((f, i) => diffBlock(f, i < 3))),
        el('footer', { class: 'pv-confirm-foot' }, [cancel, ok]),
      ]);
      const modal = el('div', { class: 'modal pv-confirm', id: 'pv-confirm' }, [card]);
      const done = value => {
        document.removeEventListener('keydown', onKey, true);
        modal.remove();
        document.querySelector('.workspace').inert = document.querySelector('.sidebar').inert = false;
        document.body.classList.remove('modal-open');
        if (last?.isConnected) last.focus?.();
        resolve(value);
      };
      const onKey = event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); done(false); return; }
        if (event.key !== 'Tab') return;
        const controls = [...card.querySelectorAll('button, summary')].filter(n => n.offsetParent);
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
      };
      cancel.addEventListener('click', () => done(false));
      ok.addEventListener('click', () => done(true));
      modal.addEventListener('click', event => { if (event.target === modal) done(false); });
      document.addEventListener('keydown', onKey, true);
      document.querySelector('.workspace').inert = document.querySelector('.sidebar').inert = true;
      document.body.classList.add('modal-open');
      document.body.append(modal);
      cancel.focus();
    });
  }

  let backups = null, backupsLoading = false;
  async function loadBackups() {
    if (backupsLoading) return;
    backupsLoading = true;
    try { backups = await api.agentBackups(); } catch (error) { backups = { error: error?.message || '读取失败' }; }
    backupsLoading = false;
    if (section === 'safety' && !editor && document.body.dataset.page === 'providers') render(false);
  }
  async function restore(kind, id) {
    const done = await run(() => api.agentRestore(kind, id), r => `已还原 ${r.result || 0} 个配置文件。请重新打开对应工具，让配置生效。`, '正在还原配置…');
    if (done) { backups = null; loadBackups(); }
  }
  const when = at => new Date(at).toLocaleString(typeof dateLocale === 'function' ? dateLocale() : undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  function safetySection() {
    if (!backups && !backupsLoading) loadBackups();
    const toggle = el('button', { type: 'button', class: 'pv-switch' + (view.readOnly ? ' on' : ''), role: 'switch', 'aria-checked': String(!!view.readOnly), 'aria-label': '只读保护', 'data-action': 'readonly' }, [el('i')]);
    toggle.addEventListener('click', async () => {
      const on = !view.readOnly;
      await run(async () => ({ ok: true, state: await api.agentReadOnly(on) }), on ? '只读保护已开启：不会再改动工具配置文件。' : '只读保护已关闭：切换供应商前仍会先让你确认改动。', '正在保存…');
      render(false);
    });
    const guard = el('section', { class: 'pv-safety-card' + (view.readOnly ? ' on' : '') }, [
      el('span', { class: 'pv-safety-icon', 'aria-hidden': 'true' }, [icon('lock')]),
      el('div', {}, [
        el('b', { text: '只读保护' }),
        el('p', { text: '打开后不再改动 Claude / Codex / Grok 的配置文件，切换供应商、启用路由会被拦下；关闭路由、还原备份仍然可以做。' }),
      ]),
      toggle,
    ]);
    const rules = el('ul', { class: 'pv-safety-rules' }, [
      ['check', '每次改动前先确认', '改工具配置前先看逐行对比（密钥打码），点「确认写入」才写。'],
      ['restore', '每次改动都留备份', '最近 50 次改动都能一键还原，还原本身也能撤回。'],
      ['folder', '接管前的原件永久保留', '随时恢复到 TokenPulse 第一次改动之前的样子。'],
    ].map(([name, title, text]) => el('li', {}, [el('span', { class: 'pv-nav-icon' }, [icon(name)]), el('div', {}, [el('b', { text: title }), el('small', { text })])])));

    const list = [];
    if (!backups || backupsLoading) list.push(el('p', { class: 'pv-empty', text: '正在读取配置备份…' }));
    else if (backups.error) list.push(el('p', { class: 'pv-empty', text: '配置备份读取失败：' + backups.error }));
    else {
      list.push(el('h3', { class: 'pv-safety-title', text: '接管前的原件' }));
      if (!backups.originals.length) list.push(el('p', { class: 'pv-empty', text: 'TokenPulse 还没有改动过任何工具配置。' }));
      for (const o of backups.originals) {
        const same = !o.lines.length;
        const row = el('article', { class: 'pv-backup original', 'data-original': o.id }, [
          el('div', { class: 'pv-backup-head' }, [
            el('div', {}, [el('b', { text: `${o.tool} · ${o.name}`, translate: 'no' }), el('small', { text: same ? '和现在的文件一样' : `恢复后：+${o.added} −${o.deleted} 行` })]),
            same ? null : button('恢复原件', () => restore('original', o.id), 'btn', 'restore'),
          ]),
          same ? null : diffBlock(o, false, '查看对比'),
        ]);
        list.push(row);
      }
      list.push(el('h3', { class: 'pv-safety-title', text: `修改记录 · 最近 ${backups.entries.length} 次` }));
      if (!backups.entries.length) list.push(el('p', { class: 'pv-empty', text: '还没有修改记录。以后每次改动工具配置都会记在这里。' }));
      for (const entry of backups.entries) {
        list.push(el('article', { class: 'pv-backup', 'data-entry': entry.id }, [
          el('div', { class: 'pv-backup-head' }, [
            el('div', {}, [el('b', { text: entry.reason }), el('small', { text: `${when(entry.at)} · ${entry.files.map(f => f.tool).filter((t, i, all) => all.indexOf(t) === i).join('、')} · ${entry.files.length} 个文件` })]),
            button('还原到这次之前', () => restore('history', entry.id), 'btn', 'restore'),
          ]),
          ...entry.files.map(f => diffBlock(f, false)),
        ]));
      }
    }
    return [head('配置保护', '防止改坏工具配置：只读保护、改动前确认、每次改动都有备份。'), guard, rules, el('div', { class: 'pv-backups' }, list)];
  }

  /*
   * 工具的配置被改走了（0.3.10，main/index.ts 的 checkDrift）：右上角弹窗说清楚是谁、可能的原因，一键切回。
   * 切回走和「启用」一样的流程（先看对比再确认）；本地路由被改走时也能直接重新接上。
   */
  const DRIFT_HINT = {
    grok: '常见原因：在 Grok 里继续了旧会话，Grok 会换回那个会话记住的模型并写回配置。切回后请新开会话，或在会话里输入 /model tokenpulse_route。',
    claude: '可能是 CC Switch 等工具或手动改了 Claude Code 的 settings.json。',
    codex: '可能是 CC Switch 等工具或手动改了 Codex 的 config.toml。',
    desktop: '可能是在 Claude 桌面端里换了配置。',
  };
  function showDrift(d) {
    if (!d?.app || typeof toast !== 'function') return;
    const tool = appOf(d.app)?.name || d.app;
    toast(`${tool} 现在没在用「${d.expectedName}」，连的是「${d.liveName}」。${DRIFT_HINT[d.app] || ''}`, { kind: 'warning', key: 'drift-' + d.app, cls: 'pv-drift', actions: [
      { label: '知道了' },
      { label: `切回「${d.expectedName}」`, primary: true, onClick: () => run(() => api.agentActivate(d.expectedId), r => (r.result?.message || '已切回') + (r.result?.restart ? ' 请重新打开对应工具，让新配置生效。' : ''), `正在切回「${d.expectedName}」…`) },
    ] });
  }
  api.onAgentDrift?.(list => { for (const d of [].concat(list || [])) showDrift(d); });
  api.agentDriftNow?.().then(list => { for (const d of list || []) showDrift(d); }).catch(() => {});
  // 0.3.15：启动时自动修复了旧版本留下的坏配置（或者只读保护下没法修）：不管在哪个页面都说一声
  api.agentStartupNotice?.().then(text => { if (text && typeof toast === 'function') toast(text, { kind: text.includes('发现需要修复') ? 'warning' : 'success', key: 'agent-repair' }); }).catch(() => {});

  // 托盘里点了切换：到供应商页走同样的确认流程
  api.onAgentActivateRequest?.(async id => {
    window.navigate?.('providers');
    if (!view) { try { view = await api.agentState(); } catch { return; } }
    const p = view.providers.find(x => x.id === id);
    if (p && !p.active) activate(p);
  });
  // 设置 → 数据 里的入口
  document.getElementById('open-config-backups')?.addEventListener('click', () => {
    window.closeModal?.('settings');
    window.navigate?.('providers');
    section = 'safety';
    try { localStorage.setItem(SECTION_KEY, section); } catch { /* 记不住就算了 */ }
    backups = null;
    render(true);
  });

  /* ---------------- 刷新 ---------------- */

  /** 数据每次推送都会调；只有内容变了才重画，抽屉开着或正在拖动时不重画（免得把正在填的表单清掉）。 */
  async function show() {
    if (pending) return;
    const ticket = ++stateTicket;
    let state;
    try { state = await api.agentState(); } catch (error) {
      if (ticket === stateTicket && !pending) showFeedback(error?.message || '供应商状态读取失败，请刷新重试。', 'error');
      return;
    }
    if (ticket !== stateTicket || pending) return;
    view = state;
    const next = sig(view);
    if (editor || dragging) return;
    if (next === signature && root.querySelector('.pv')) return;
    signature = next; render(!entered); entered = true;
  }
  api.onAgentSwitch?.(state => {
    ++stateTicket;
    if (pending) return;
    view = state;
    if (document.body.dataset.page !== 'providers' || editor || dragging) return;
    const next = sig(state);
    if (next !== signature || !root.querySelector('.pv')) { signature = next; render(false); }
    if (state.notice) showFeedback(state.notice, 'warning');
  });
  api.prismState?.().then(setPrism).catch(() => {});
  api.onPrism?.(setPrism);
  window.PulseProviders = { show };
})();
