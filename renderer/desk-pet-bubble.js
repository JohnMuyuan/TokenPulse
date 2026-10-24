'use strict';
/*
 * 桌宠的对话气泡（0.3.61）。数据由主进程送来（src/main/desk-pet.ts 的 DeskPetBubbleData）：
 * view = quota 是点宠物出来的那页——宠物说一句话、正在用的账号、5 小时和周额度各 10 格（剩多少亮多少）、什么时候重置、一行任务摘要；
 * view = tasks 是右键「查看任务」出来的任务列表。点任务打开会话管理。
 * 尾巴朝哪边、在哪由主进程按宠物的位置算好（place）；气泡本身的大小量好告诉主进程。鼠标不在上面 8 秒自己收起，Esc 也收起。
 */
(() => {
  const api = window.tokenpulse.deskPet;
  const $ = id => document.getElementById(id);
  const box = $('bb'), tail = $('bb-tail');
  const EN = window.PulseI18n?.lang?.() === 'en';
  const L = (zh, en) => EN ? en : zh;
  const EDGE = 6, TAIL = 12, U = 2, AUTO_CLOSE_MS = 8000;
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) { if (value == null) continue; if (key === 'text') node.textContent = value; else node.setAttribute(key, value); }
    node.append(...children.filter(Boolean));
    return node;
  };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
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
  const minutesSince = (from, now) => Math.max(0, Math.round((now - from) / 60000));

  /* ---------- 额度 ---------- */

  /** 宠物说的话：按额度的情况挑一句，每次打开换一句。 */
  function say(data) {
    const q = data.quota, pick = list => list[data.opened % list.length];
    if (q == null || !data.account) return pick([L('还没拿到额度数据呢', 'No quota data yet'), L('额度数据还在路上～', 'Quota data is on its way~')]);
    if (data.mood === 'empty') {
      const back = [data.account.five, data.account.week].filter(w => w && w.used >= 100 && w.resetAt > data.now).sort((a, b) => b.resetAt - a.resetAt)[0];
      const when = back ? until(back.resetAt, data.now) : '';
      return when ? L(`额度用完啦，${when}恢复`, `All used up, back ${when}`) : L('额度用完啦，歇一会儿吧', 'All used up, time for a break');
    }
    if (data.mood === 'tight') return pick([L('额度有点紧了，省着点用～', 'Running low, go easy~'), L(`只剩 ${q}% 了，悠着点哦`, `Only ${q}% left, take it slow`)]);
    if (q >= 60) return pick([L('额度还很充足～', 'Plenty of quota left~'), L(`还剩 ${q}%，放心用！`, `${q}% left, go for it!`)]);
    return pick([L(`还剩 ${q}% 哦`, `${q}% left`), L(`额度还剩 ${q}%～`, `Still ${q}% to go~`)]);
  }

  function meter(name, label, window, now) {
    if (!window) return [];
    const left = Math.round(100 - window.used), lit = left <= 0 ? 0 : Math.max(1, Math.round(left / 10));
    const level = left <= 0 ? 'empty' : window.high || left < 15 ? 'tight' : 'ok';
    const reset = until(window.resetAt, now);
    return [
      el('div', { class: 'bb-meter', 'data-window': name }, [
        el('span', { class: 'bb-label', text: label }),
        el('span', { class: 'bb-cells ' + level, role: 'img', 'aria-label': L(`剩 ${left}%`, `${left}% left`) }, Array.from({ length: 10 }, (_, i) => el('i', { class: i < lit ? 'on' : null }))),
        el('b', { class: 'bb-pct', text: `${left}%` }),
      ]),
      // 「2 小时 13 分后重置」连着写，「10月26日 02:59 重置」中间空一格
      reset ? el('small', { class: 'bb-reset', text: L(reset.endsWith('后') ? `${reset}重置` : `${reset} 重置`, `resets ${reset}`) }) : null,
    ];
  }

  function taskLine(data) {
    const running = data.tasks.running, waiting = running.filter(task => task.status === 'waiting').length;
    if (!data.scanned) return el('p', { class: 'bb-line none' }, [el('span', { text: L('正在看本机的会话…', 'Reading local sessions…') })]);
    if (!running.length) return el('p', { class: 'bb-line none' }, [el('i', { class: 'bb-dot done' }), el('span', { text: L('没有任务在跑', 'No tasks running') })]);
    const line = el('button', { type: 'button', class: 'bb-line', title: L('打开会话管理', 'Open Sessions') }, [
      el('i', { class: 'bb-dot' + (waiting ? ' waiting' : '') }),
      el('span', { text: L(`${running.length} 个任务在跑`, `${running.length} task${running.length === 1 ? '' : 's'} running`) + (waiting ? L(` · ${waiting} 个可能在等你`, ` · ${waiting} may need you`) : '') }),
      el('em', { text: '›', 'aria-hidden': 'true' }),
    ]);
    line.addEventListener('click', () => api.bubbleAction('sessions'));
    return line;
  }

  function quotaView(data) {
    const account = data.account, now = data.now;
    const stale = account?.checkedAt && now - account.checkedAt > 30 * 60000;
    return [
      el('p', { class: 'bb-say' + (data.mood === 'ok' || !account ? '' : ' ' + data.mood), text: say(data) }),
      account ? el('div', { class: 'bb-acc' }, [el('i', { class: 'bb-kind ' + account.kind }), el('b', { text: account.name, title: account.name }), account.plan ? el('span', { class: 'bb-plan', text: account.plan }) : null]) : null,
      ...(account ? [...meter('five', L('5 小时', '5-hour'), account.five, now), ...meter('week', L('周', 'Weekly'), account.week, now)] : [el('p', { class: 'bb-note', text: L('在 TokenPulse 里登录 Claude 或 ChatGPT 官方账号后，这里会显示额度。', 'Sign in to an official Claude or ChatGPT account in TokenPulse to see quota here.') })]),
      stale ? el('p', { class: 'bb-note', text: L('额度超过 30 分钟没有更新', 'Quota not updated for over 30 minutes') }) : null,
      taskLine(data),
    ];
  }

  /* ---------- 任务列表 ---------- */

  const STATUS = { thinking: L('思考中', 'Thinking'), tool: L('执行工具', 'Running a tool'), waiting: L('可能在等你', 'May need you'), done: L('刚完成', 'Done') };
  function taskRow(task, now) {
    const done = task.status === 'done';
    const when = done
      ? (task.doneAt ? L(`${minutesSince(task.doneAt, now) || '不到 1'} 分钟前完成`, `finished ${minutesSince(task.doneAt, now) || '<1'} min ago`) : '')
      : (task.since ? L(`已运行 ${minutesSince(task.since, now) || '不到 1'} 分钟`, `running ${minutesSince(task.since, now) || '<1'} min`) : '');
    const row = el('button', { type: 'button', class: 'bb-task' + (done ? ' done' : '') + (task.status === 'waiting' ? ' waiting' : ''), 'data-key': task.key, title: task.tool ? `${task.title} · ${task.tool}` : task.title }, [
      el('i', { class: 'bb-dot' + (done ? ' done' : task.status === 'waiting' ? ' waiting' : '') }),
      el('span', { class: 'bb-task-main' }, [el('b', { text: task.title }), el('small', { text: [task.agent, task.project, when].filter(Boolean).join(' · ') })]),
      el('i', { class: 'bb-chip', text: task.asking ? L('在问你', 'Asking you') : STATUS[task.status] || '' }),
    ]);
    row.addEventListener('click', () => api.bubbleAction('sessions', task.key));
    return row;
  }
  function tasksView(data) {
    const { running, recent } = data.tasks;
    const rows = [...running, ...recent].map(task => taskRow(task, data.now));
    const head = !data.scanned ? L('正在看本机的会话…', 'Reading local sessions…')
      : running.length ? L(`${running.length} 个任务在跑～`, `${running.length} task${running.length === 1 ? '' : 's'} running~`)
      : L('现在没有任务在跑，歇会儿～', 'Nothing running, taking a break~');
    return [
      el('p', { class: 'bb-say', text: head }),
      rows.length ? el('div', { class: 'bb-list' }, rows) : el('p', { class: 'bb-note', text: L('支持 Claude Code 和 Codex。点一条打开会话管理。', 'Claude Code and Codex are supported. Click one to open Sessions.') }),
    ];
  }

  /* ---------- 尾巴 ---------- */

  // 朝下的尾巴，一格 2 像素：第一行压在气泡的底边描边上（中间是纸色，像是从气泡里长出来），往下越来越窄，尖在左下
  const TAIL_ROWS = ['kppppk', 'kpppk', 'kppk', 'kpk', 'kk', 'k'];
  function drawTail(place) {
    const w = box.offsetWidth, h = box.offsetHeight, left = box.offsetLeft, top = box.offsetTop;
    const cells = [];
    TAIL_ROWS.forEach((row, r) => [...row].forEach((kind, c) => {
      let x, y;
      if (place.side === 'down') { x = place.at - U / 2 + c * U; y = top + h + r * U; }
      else if (place.side === 'left') { x = left - U - r * U; y = place.at - U / 2 + c * U; }
      else { x = left + w + r * U; y = place.at - U / 2 + c * U; }
      const cell = document.createElementNS(NS, 'rect');
      for (const [key, value] of Object.entries({ class: kind, x, y, width: U, height: U })) cell.setAttribute(key, value);
      cells.push(cell);
    }));
    tail.replaceChildren(...cells);
    box.style.transformOrigin = place.side === 'down' ? `${place.at - left}px ${h + TAIL}px` : place.side === 'left' ? `${-TAIL}px ${place.at - top}px` : `${w + TAIL}px ${place.at - top}px`;
  }

  /* ---------- 画 ---------- */

  let last = null, opened = -1, closeTimer = null, hovering = false;
  function report() { api.bubbleSize(box.offsetWidth, box.offsetHeight); }
  function draw(data) {
    if (!data) return;
    last = data;
    document.documentElement.dataset.theme = data.theme === 'dark' ? 'dark' : 'light';
    document.body.dataset.side = data.place.side;
    box.style.left = (data.place.side === 'left' ? EDGE + TAIL : EDGE) + 'px';
    box.classList.toggle('tasks', data.view === 'tasks');
    box.setAttribute('aria-label', data.view === 'tasks' ? L('任务', 'Tasks') : L('额度', 'Quota'));
    box.replaceChildren(...(data.view === 'tasks' ? tasksView(data) : quotaView(data)).filter(Boolean));
    drawTail(data.place);
    report();
    if (data.opened !== opened) {
      opened = data.opened;
      box.classList.remove('pop'); void box.offsetWidth; box.classList.add('pop');
      armClose();
    }
  }

  function armClose() {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = hovering ? null : setTimeout(() => api.bubbleAction('close'), AUTO_CLOSE_MS);
  }
  document.documentElement.addEventListener('mouseenter', () => { hovering = true; armClose(); });
  document.documentElement.addEventListener('mouseleave', () => { hovering = false; armClose(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') api.bubbleAction('close'); });
  // 内容换了行数（英文、长账号名）大小会变：变了就再告诉主进程
  new ResizeObserver(() => { if (last) { report(); drawTail(last.place); } }).observe(box);
  api.onBubble(draw);
  api.bubbleData().then(draw).catch(() => undefined);
  // 开着的时候「几分钟后重置」会过时：每半分钟按当前时间重画一次
  setInterval(() => { if (last && document.visibilityState !== 'hidden') draw({ ...last, now: Date.now() }); }, 30000);
})();
