'use strict';
/*
 * 桌宠窗口（0.3.61）。状态由主进程送来（src/main/desk-pet.ts 的 deskPetView）：宠物、大小、剩余额度和心情、
 * 现在是空闲 / 干活 / 睡觉、几个任务在跑。这里负责画、悬停提示、判断鼠标在不在宠物身上（不在时点击穿透到后面的窗口）、
 * 拖动和点击。动作节奏在 pet-engine.js 的 Controller 里。
 */
(() => {
  const api = window.tokenpulse.deskPet;
  const Pet = window.PulsePet;
  const $ = id => document.getElementById(id);
  const canvas = $('dp-canvas'), img = $('dp-img'), hint = $('dp-hint'), badge = $('dp-badge'), stage = $('dp-stage');
  const EN = window.PulseI18n?.lang?.() === 'en';
  const L = (zh, en) => EN ? en : zh;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const BUILT_IN = ['squirrel', 'hamster', 'octopus'];

  let view = null, pack = null, ctl = null, grid = null, mode = null, scale = 2, pixel = 2, hovering = false, shownKey = '';
  let press = null, dragging = false;

  function ctx() {
    return { state: view.mode, quota: view.quota ?? 100, mood: view.mood, tasks: view.tasks, fidget: view.fidget && !reduced.matches && BUILT_IN.includes(view.pet) };
  }

  function size() {
    scale = view.scale;
    pixel = Math.max(1, Math.round(scale * (window.devicePixelRatio || 1)));
    canvas.width = Pet.W * pixel; canvas.height = Pet.H * pixel;
    for (const node of [canvas, img]) { node.style.width = Pet.W * scale + 'px'; node.style.height = Pet.H * scale + 'px'; }
    hint.style.bottom = Pet.H * scale + 2 + 'px';
  }

  function custom() { return !BUILT_IN.includes(view.pet); }
  /** 自定义宠物：按动作和状态挑一张图，没有的用 idle。 */
  function imageKey() {
    const has = key => !!pack?.images?.[key];
    const pick = (...keys) => keys.find(has) || 'idle';
    const action = ctl.action;
    if (action === 'drag') return pick('drag', 'startle');
    if (action === 'startle') return pick('startle');
    if (action === 'celebrate' || action === 'restock') return pick('celebrate');
    if (view.mode === 'sleep' || action === 'yawn') return pick('sleep');
    if (view.mood === 'empty') return pick('empty', 'tight');
    if (view.mode === 'work') return pick('work');
    if (view.mood === 'tight') return pick('tight');
    return 'idle';
  }

  function draw() {
    if (!view || !ctl) return;
    // 现在画的是哪只、在做什么：写在节点上，方便检查
    stage.dataset.pet = view.pet; stage.dataset.mode = view.mode; stage.dataset.action = ctl.action || '';
    if (custom()) {
      canvas.hidden = true; img.hidden = !pack;
      const key = imageKey();
      if (pack && key !== shownKey) { shownKey = key; img.src = pack.images[key] || pack.images.idle || ''; }
      badge.hidden = !view.badge;
      if (view.badge) {
        badge.textContent = (view.quota == null ? '—' : `${view.quota}%`) + (view.tasks ? ` · ${view.tasks}` : '');
        badge.className = 'dp-badge' + (view.mood === 'ok' ? '' : ' ' + view.mood);
      }
      return;
    }
    canvas.hidden = false; img.hidden = true; badge.hidden = true;
    grid = ctl.frame(ctx());
    Pet.paint(canvas, grid, pixel);
  }

  function hintText() {
    const left = view.quota == null ? L('还没有额度数据', 'No quota data yet') : L(`剩余 ${view.quota}%`, `${view.quota}% left`);
    const quota = (view.account ? view.account + ' ' : '') + left;
    if (view.mode === 'work') return L(`${view.tasks} 个任务进行中`, `${view.tasks} task${view.tasks === 1 ? '' : 's'} running`) + (view.waiting ? L(`（${view.waiting} 个可能在等你）`, ` (${view.waiting} may need you)`) : '') + ' · ' + quota;
    if (view.mood === 'empty') return L('额度用完了', 'Quota used up') + (view.account ? ' · ' + view.account : '');
    if (view.mode === 'sleep') return L('在睡觉', 'Sleeping') + ' · ' + quota;
    return L('没有任务在跑', 'No tasks running') + ' · ' + quota;
  }

  function apply(next) {
    if (!next) return;
    const first = !view, changedPet = !view || view.pet !== next.pet, changedScale = !view || view.scale !== next.scale;
    view = next;
    document.documentElement.dataset.theme = view.theme === 'dark' ? 'dark' : 'light';
    if (changedPet || !ctl) { ctl = new Pet.Controller(BUILT_IN.includes(view.pet) ? view.pet : 'squirrel'); shownKey = ''; }
    if (changedScale) size();
    // 状态切换的过渡：睡前打哈欠，醒来揉眼睛
    if (!first && mode !== view.mode) {
      if (view.mode === 'sleep') ctl.trigger('yawn');
      else if (mode === 'sleep') ctl.trigger('wake');
    }
    mode = view.mode;
    hint.textContent = hintText();
    draw();
  }

  /* 鼠标在不在宠物身上：画出来的像素（周围放宽一格）才算；自定义宠物按图片的范围算 */
  function hitAt(x, y) {
    if (!view) return false;
    const box = stage.getBoundingClientRect();
    if (x < box.left || x >= box.right || y < box.top || y >= box.bottom) return false;
    if (custom()) return true;
    if (!grid) return false;
    const gx = Math.floor((x - box.left) / scale), gy = Math.floor((y - box.top) / scale);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = gx + dx, cy = gy + dy;
      if (cx >= 0 && cy >= 0 && cx < Pet.W && cy < Pet.H && grid.c[cy * Pet.W + cx]) return true;
    }
    return false;
  }
  function setHover(on) {
    if (on === hovering) return;
    hovering = on;
    document.body.classList.toggle('hover', on);
    api.hit(on);
  }

  document.addEventListener('mousemove', event => { if (!dragging) setHover(hitAt(event.clientX, event.clientY)); });
  document.addEventListener('mouseleave', () => { if (!dragging && !press) setHover(false); });
  stage.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !hitAt(event.clientX, event.clientY)) return;
    press = { x: event.screenX, y: event.screenY };
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', event => {
    if (!press) return;
    // 松手那一下没收到（比如在别的窗口上松开）：再动的时候已经没按着键了，按松手处理
    if (!(event.buttons & 1)) { release(false); return; }
    if (dragging) return;
    if (Math.hypot(event.screenX - press.x, event.screenY - press.y) < 5) return;
    dragging = true;
    document.body.classList.add('dragging');
    ctl?.trigger('drag');
    api.drag('start');
  });
  function release(clicked) {
    if (!press) return;
    press = null;
    if (dragging) {
      dragging = false;
      document.body.classList.remove('dragging');
      ctl?.trigger('land');
      api.drag('end');
    } else if (clicked) api.click();
  }
  stage.addEventListener('pointerup', () => release(true));
  stage.addEventListener('lostpointercapture', () => release(false));
  document.addEventListener('contextmenu', event => { event.preventDefault(); if (hitAt(event.clientX, event.clientY)) api.menu(); });

  api.onState(apply);
  api.onPack(next => { pack = next; shownKey = ''; draw(); });
  api.onCursor(rel => ctl?.aim(rel.x, rel.y));
  api.onEvent(event => {
    if (!event) return;
    // 对话气泡开着：悬停提示别再叠在气泡上
    if (event.type === 'bubble') { document.body.classList.toggle('talking', event.open === true); return; }
    if (!ctl) return;
    if (event.type === 'celebrate') ctl.trigger('celebrate');
    else if (event.type === 'restock') ctl.trigger('restock', event.from);
    draw();
  });
  api.ready().then(data => { pack = data?.pack || null; apply(data?.view); }).catch(() => undefined);

  // 每秒 10 帧；系统开了「减少动画」时每秒 2 帧、不做随机小动作。窗口被藏起来的时候不画
  let last = 0;
  setInterval(() => {
    if (!view || !ctl || document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (reduced.matches && now - last < 500) return;
    last = now;
    ctl.tick(ctx(), now);
    draw();
  }, 100);
})();
