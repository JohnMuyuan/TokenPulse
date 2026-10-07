'use strict';
/*
 * 托盘小面板：右键托盘图标弹出来的那张卡片。数据由主进程挑好送过来（src/main/tray-panel.ts 的 TrayPanelData），
 * 这里只负责画。CSP 不允许行内样式，进度条的长度用 SVG 属性写。
 */
(() => {
  const api = window.tokenpulse;
  const NS = 'http://www.w3.org/2000/svg';
  const $ = id => document.getElementById(id);
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) { if (value == null) continue; if (key === 'text') node.textContent = value; else node.setAttribute(key, value); }
    node.append(...children.filter(Boolean));
    return node;
  };
  const svg = (tag, attrs = {}) => { const node = document.createElementNS(NS, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); return node; };
  const NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok' };
  const BRANDS = { claude: 'claude', chatgpt: 'openai', grok: 'grok', codex: 'openai', desktop: 'claude' };
  // 带数字和时间的句子在这里直接按语言拼好（节点标 translate=no），固定的文字交给 i18n.js 的词典
  const EN = window.PulseI18n?.lang?.() === 'en';
  const L = (zh, en) => EN ? en : zh;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function tokens(value) {
    if (value >= 1e9) return (value / 1e9).toFixed(2) + 'B';
    if (value >= 1e6) return (value / 1e6).toFixed(value >= 1e8 ? 0 : 1) + 'M';
    if (value >= 1e3) return (value / 1e3).toFixed(value >= 1e5 ? 0 : 1) + 'K';
    return String(Math.round(value));
  }
  const pad = n => String(n).padStart(2, '0');
  /** 「36 分钟后」「2 小时 10 分后」「明天 14:30」「10月9日 14:30」。 */
  function until(at, now) {
    const left = at - now;
    if (!at || left <= 0) return '';
    const minutes = Math.round(left / 60000);
    if (minutes < 60) return L(`${Math.max(1, minutes)} 分钟后`, `in ${Math.max(1, minutes)} min`);
    if (minutes < 6 * 60) return L(`${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分后`, `in ${Math.floor(minutes / 60)} h ${minutes % 60} min`);
    const date = new Date(at), today = new Date(now);
    const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const days = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    if (days === 0) return L(`今天 ${clock}`, `today ${clock}`);
    if (days === 1) return L(`明天 ${clock}`, `tomorrow ${clock}`);
    return L(`${date.getMonth() + 1}月${date.getDate()}日 ${clock}`, `${MONTHS[date.getMonth()]} ${date.getDate()} ${clock}`);
  }

  function avatar(kind) {
    const spec = window.PulseBrand?.[BRANDS[kind] || kind];
    const node = svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    if (spec) { if (spec.rule) node.setAttribute('fill-rule', spec.rule); for (const path of spec.paths) node.append(svg('path', { d: path.d })); }
    return el('span', { class: `tp-avatar ${kind}` }, [node]);
  }

  /**
   * 一条额度：名字、细进度条、已用百分比、什么时候重置。
   * 进度条上那根小竖线是「时间走到哪了」：填充超过它，就是用得比时间走得快。用到 85% 变橙，满了变红。
   */
  function bar(kind, label, window, now) {
    if (!window) return null;
    const used = Math.max(0, Math.min(100, window.used));
    const track = svg('svg', { class: 'tp-bar', viewBox: '0 0 100 6', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    track.append(svg('rect', { class: 'track', x: 0, y: 1, width: 100, height: 4, rx: 2 }));
    if (used > 0) track.append(svg('rect', { class: `fill ${kind}` + (used >= 100 ? ' full' : used >= 85 ? ' hot' : ''), x: 0, y: 1, width: Math.max(1.5, used).toFixed(2), height: 4, rx: 2 }));
    if (window.pace >= 0 && window.pace < 100) track.append(svg('rect', { class: 'pace', x: Math.max(0, Math.min(99.2, window.pace - .4)).toFixed(2), y: 0, width: .8, height: 6 }));
    const reset = until(window.resetAt, now);
    const ahead = window.pace >= 0 && used > window.pace + 3;
    return el('div', { class: 'tp-line', 'data-window': kind, title: window.pace >= 0 ? L(`已用 ${Math.round(used)}%，时间过了 ${Math.round(window.pace)}%${ahead ? '：用得比时间走得快' : ''}`, `${Math.round(used)}% used, ${Math.round(window.pace)}% of the time gone${ahead ? ': using faster than time passes' : ''}`) : null }, [
      el('span', { class: 'tp-label', text: label }),
      track,
      el('b', { text: `${Math.round(used)}%`, translate: 'no' }),
      el('small', { text: reset ? L(`${reset}重置`, `resets ${reset}`) : '', translate: 'no' }),
    ]);
  }

  function card(account, now) {
    const five = account.five, week = account.week;
    // 按最近的速度，会在重置之前用完的那个窗口（两个都会就取先到的）
    const soon = [[L('5 小时', '5-hour'), five], [L('周', 'Weekly'), week]].filter(([, w]) => w && w.runsOut && w.etaAt > now).sort((a, b) => a[1].etaAt - b[1].etaAt)[0];
    const stale = account.checkedAt && now - account.checkedAt > 30 * 60000;
    return el('section', { class: 'tp-card' + (stale ? ' stale' : ''), role: 'listitem', 'data-kind': account.kind }, [
      el('div', { class: 'tp-name' }, [avatar(account.kind), el('b', { text: account.name || NAMES[account.kind] || account.kind, title: account.name, translate: 'no' }), account.plan ? el('span', { class: 'tp-plan', text: account.plan, translate: 'no' }) : null]),
      bar('five', '5 小时', five, now),
      bar('week', '周', week, now),
      soon ? el('div', { class: 'tp-warn', translate: 'no', text: L(`按现在的速度，${soon[0]}额度约 ${until(soon[1].etaAt, now)}用完`, `At this pace the ${soon[0].toLowerCase()} quota runs out ${until(soon[1].etaAt, now)}`) }) : null,
      stale ? el('div', { class: 'tp-warn', text: '额度超过 30 分钟没有更新' }) : null,
    ]);
  }

  /* 供应商：每个工具一行，写着现在用的是哪家；点开在下面列出可以换的。切换和托盘菜单里一样，要在主窗口里确认。 */
  let openApp = '';
  function agents(list) {
    if (!list?.length) return null;
    return el('section', { class: 'tp-agents', 'aria-label': '供应商' }, [
      el('div', { class: 'tp-section', text: '供应商' }),
      ...list.flatMap(agent => {
        const open = openApp === agent.app;
        const head = el('button', { type: 'button', class: 'tp-agent' + (open ? ' open' : ''), 'data-app': agent.app, 'aria-expanded': String(open) }, [
          avatar(agent.app === 'grok' ? 'grok' : agent.app === 'codex' ? 'chatgpt' : 'claude'),
          el('span', { class: 'tp-agent-app', text: agent.label, translate: 'no' }),
          el('b', { text: agent.current || L('没有启用', 'none'), title: agent.current, translate: 'no' }),
          el('i', { class: 'tp-caret', 'aria-hidden': 'true' }),
        ]);
        head.addEventListener('click', () => { openApp = open ? '' : agent.app; draw(last); });
        if (!open) return [head];
        return [head, el('div', { class: 'tp-options', role: 'group' }, agent.providers.map(item => {
          const option = el('button', { type: 'button', class: 'tp-option' + (item.active ? ' on' : ''), 'data-id': item.id, disabled: item.active || agent.readOnly ? '' : null, title: agent.readOnly && !item.active ? L('开着只读保护，不能切换', 'Read-only protection is on') : item.name }, [
            el('i', { class: 'tp-check', 'aria-hidden': 'true' }), el('span', { text: item.name, translate: 'no' }),
          ]);
          option.addEventListener('click', () => api.trayPanelActivate(item.id));
          return option;
        }))];
      }),
    ]);
  }

  const SHOWN = 3;
  let last = null;
  function draw(data) {
    if (!data) return;
    last = data;
    document.documentElement.dataset.theme = data.theme === 'dark' ? 'dark' : 'light';
    // 顶上地方小：只写「今日 48.2M · $31.40」，完整的说法放在悬停提示里
    const cost = data.today.costUsd > 0 ? `$${data.today.costUsd.toFixed(2)}` : '';
    $('tp-today').textContent = L(`今日 ${tokens(data.today.tokens)}`, `Today ${tokens(data.today.tokens)}`) + (cost ? ` · ${cost}` : '');
    $('tp-today').title = L(`今日用了 ${tokens(data.today.tokens)} Tokens`, `${tokens(data.today.tokens)} tokens today`) + (cost ? L(`，按 API 价格约 ${cost}`, `, about ${cost} at API prices`) : '');
    const list = $('tp-list');
    const top = list.scrollTop;
    list.replaceChildren(...(data.accounts.length
      ? data.accounts.map(account => card(account, data.now))
      : [el('div', { class: 'tp-empty', text: '还没有官方额度的数据。打开 TokenPulse，在「额度详情」里添加官方账号后，这里会显示 5 小时和周额度。' })]));
    // 账号多的时候只露出前 SHOWN 个的高度，其余的在这一块里滚动，面板不会越长越高
    const cards = [...list.children];
    list.style.maxHeight = cards.length > SHOWN ? `${Math.ceil(cards[SHOWN - 1].getBoundingClientRect().bottom - cards[0].getBoundingClientRect().top)}px` : '';
    list.classList.toggle('scroll', cards.length > SHOWN);
    list.scrollTop = top;
    $('tp-agents').replaceChildren(...[agents(data.agents)].filter(Boolean));
    $('tp-refresh').classList.remove('spin');
    // 内容高度告诉主进程，窗口跟着调。直接量（会触发一次排版），不等下一帧：窗口被挡住时下一帧可能迟迟不来
    api.trayPanelSize(Math.ceil($('tp').getBoundingClientRect().height));
  }

  $('tp-open').addEventListener('click', () => api.trayPanelAction('open'));
  $('tp-quit').addEventListener('click', () => api.trayPanelAction('quit'));
  $('tp-refresh').addEventListener('click', () => { $('tp-refresh').classList.add('spin'); api.trayPanelAction('refresh'); setTimeout(() => $('tp-refresh').classList.remove('spin'), 8000); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') api.trayPanelAction('close'); });
  api.onTrayPanel(draw);
  api.trayPanelData().then(draw).catch(() => undefined);
  // 开着的时候「几分钟后重置」会过时：每半分钟按当前时间重画一次
  setInterval(() => { if (last && document.visibilityState === 'visible') draw({ ...last, now: Date.now() }); }, 30000);
})();
