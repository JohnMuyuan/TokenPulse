'use strict';
/*
 * 桌宠窗口（0.3.61）。状态由主进程送来（src/main/desk-pet.ts 的 deskPetView）：宠物、大小、剩余额度和心情、
 * 现在是空闲 / 干活 / 睡觉、几个任务在跑。这里负责画、悬停提示、判断鼠标在不在宠物身上（不在时点击穿透到后面的窗口）、
 * 拖动和点击。动作节奏在 pet-engine.js 的 Controller 里。
 *
 * 互动：点一下（等 300 毫秒确认不是双击）打开对话气泡；双击戳一下；连点四下东张西望。
 * 拖着甩出去会滑一段、碰边弹回来（主进程算，停下来时发 landed）。极简模式（view.mini）：宠物贴在窗口右边、
 * 身子有一截在屏幕外，鼠标移上来探出来打招呼，移开缩回去。
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

  let view = null, pack = null, ctl = null, grid = null, scale = 2, pixel = 2, hovering = false, shownKey = '';
  let press = null, dragging = false, idleSec = 0, landTimer = 0, tuckTimer = 0, peeking = false, peekUntil = 0, tilt = 0, origin = { x: 0, y: 0 }, customBox = null;
  const clicks = new Pet.Clicks(300);

  function ctx() {
    return { state: view.mode, quota: view.quota ?? 100, mood: view.mood, tasks: view.tasks, mini: !!view.mini, fidget: view.fidget && !reduced.matches && BUILT_IN.includes(view.pet) };
  }

  function size() {
    scale = view.scale;
    pixel = Math.max(1, Math.round(scale * (window.devicePixelRatio || 1)));
    canvas.width = Pet.W * pixel; canvas.height = Pet.H * pixel;
    for (const node of [canvas, img]) { node.style.width = Pet.W * scale + 'px'; node.style.height = Pet.H * scale + 'px'; }
    hint.style.bottom = Pet.H * scale + 2 + 'px';
  }

  /** 宠物身体占的格子 [左, 上, 右, 下]：内置的写在 pet-engine.js；自定义的按 idle 图里不透明的范围量（还没量好先用画面中间一块）。 */
  function bodyBox() {
    return custom() ? (customBox || [18, 20, 53, 55]) : Pet.BODY[view.pet];
  }
  function measurePack() {
    customBox = null;
    const src = pack?.images?.idle;
    if (!src) return;
    const probe = new Image();
    probe.onload = () => {
      if (pack?.images?.idle !== src || !probe.naturalWidth) return;
      const c = document.createElement('canvas');
      c.width = probe.naturalWidth; c.height = probe.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(probe, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 16) { const p = (i - 3) / 4, x = p % c.width, y = Math.floor(p / c.width); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 < 0) return;
      // 图片按 object-fit: contain 贴底居中放进 Pet.W × Pet.H 格的框里
      const k = Math.min(Pet.W / c.width, Pet.H / c.height), ox = (Pet.W - c.width * k) / 2, oy = Pet.H - c.height * k;
      customBox = [ox + x0 * k, oy + y0 * k, ox + (x1 + 1) * k - 1, oy + (y1 + 1) * k - 1];
      layout();
    };
    probe.src = src;
  }

  /**
   * 摆宠物：平时在窗口底边中间。极简模式像躲在屏幕边后面探头：以身体的脚底中点为轴往左歪 tilt 度，头先探出来，
   * 探出屏幕的宽度是身宽的 show 倍（矮胖的、高瘦的都探出差不多的比例）；鼠标移上来换成 peek 的姿势，探得更出来。
   * 窗口外的部分本来就看不见。
   */
  function layout() {
    const mini = view?.mini;
    document.body.classList.toggle('mini', !!mini);
    stage.dataset.mini = mini ? (peeking ? 'peek' : 'tuck') : '';
    if (!mini) { tilt = 0; stage.style.left = ''; stage.style.transform = ''; stage.style.transformOrigin = ''; return; }
    const pose = peeking ? mini.peek : mini.tuck, [x0, y0, x1, y1] = bodyBox();
    const width = (x1 - x0 + 1) * scale, height = (y1 - y0 + 1) * scale, a = pose.tilt * Math.PI / 180;
    // 歪过去以后，身体左上角离轴有多远（最先探出屏幕的就是这个角）
    const reach = width / 2 * Math.cos(a) + height * Math.sin(a);
    origin = { x: (x0 + x1 + 1) / 2 * scale, y: (y1 + 1) * scale };
    tilt = pose.tilt;
    stage.style.transformOrigin = `${origin.x}px ${origin.y}px`;
    stage.style.left = Math.round(window.innerWidth + reach - width * pose.show - origin.x) + 'px';
    stage.style.transform = `rotate(${-pose.tilt}deg)`;
  }
  /** 极简模式下探出来；ms 毫秒后自己缩回去（鼠标还在上面、气泡还开着就不缩）。不给 ms 等鼠标移开。 */
  function peek(on, ms = 0) {
    clearTimeout(tuckTimer); tuckTimer = 0;
    peekUntil = on && ms ? Date.now() + ms : 0;
    if (on && ms) tuckTimer = setTimeout(() => peek(hovering || document.body.classList.contains('talking')), ms);
    if (peeking === on) return;
    peeking = on;
    if (on && view?.mini && ctl && !ctl.action) ctl.trigger('wave');
    layout();
  }

  function custom() { return !BUILT_IN.includes(view.pet); }
  /** 自定义宠物：按动作和状态挑一张图，没有的用 idle。 */
  function imageKey() {
    const has = key => !!pack?.images?.[key];
    const pick = (...keys) => keys.find(has) || 'idle';
    const action = ctl.action, state = ctl.stateOf(ctx());
    if (action === 'drag') return pick('drag', 'startle');
    if (action === 'startle') return pick('startle');
    if (action === 'poke') return pick('poke', 'startle');
    if (action === 'celebrate' || action === 'restock') return pick('celebrate');
    if (action === 'wave') return pick('wave');
    if (action === 'lookaround') return pick('look');
    if (state === 'sleep' || action === 'flop') return pick('sleep');
    if (state === 'doze' || action === 'yawn') return pick('doze', 'sleep');
    if (view.mini && has('peek')) return 'peek';
    if (view.mood === 'empty') return pick('empty', 'tight');
    if (view.mode === 'work') return pick('work');
    // 额度紧张：和内置宠物一样，平时照常待着，隔一阵紧张一下（ctl.nervous，两三秒）才换成 tight 图，不一直冒汗
    if (view.mood === 'tight' && ctl.nervous) return pick('tight');
    return 'idle';
  }

  function draw() {
    if (!view || !ctl) return;
    // 现在画的是哪只、在做什么：写在节点上，方便检查
    stage.dataset.pet = view.pet; stage.dataset.mode = view.mode; stage.dataset.action = ctl.action || ''; stage.dataset.state = ctl.stateOf(ctx());
    // 打盹、睡着是宠物自己走到的，不一定有新的状态送来：提示跟着画面变
    const text = hintText();
    if (hint.textContent !== text) hint.textContent = text;
    if (custom()) {
      canvas.hidden = true; img.hidden = !pack;
      const key = imageKey();
      stage.dataset.image = key;
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
    if (view.mode === 'work') {
      const asking = view.asking || 0, waiting = Math.max(0, (view.waiting || 0) - asking);
      const notes = [asking ? L(`${asking} 个在问你`, `${asking} asking you`) : '', waiting ? L(`${waiting} 个可能在等你`, `${waiting} may need you`) : ''].filter(Boolean);
      return L(`${view.tasks} 个任务进行中`, `${view.tasks} task${view.tasks === 1 ? '' : 's'} running`) + (notes.length ? L(`（${notes.join('，')}）`, ` (${notes.join(', ')})`) : '') + ' · ' + quota;
    }
    if (view.mood === 'empty') return L('额度用完了', 'Quota used up') + (view.account ? ' · ' + view.account : '');
    const state = ctl ? ctl.stateOf(ctx()) : view.mode;
    if (state === 'sleep') return L('在睡觉', 'Sleeping') + ' · ' + quota;
    if (state === 'doze') return L('在打盹', 'Dozing') + ' · ' + quota;
    return L('没有任务在跑', 'No tasks running') + ' · ' + quota;
  }

  function apply(next) {
    if (!next) return;
    const changedPet = !view || view.pet !== next.pet, changedScale = !view || view.scale !== next.scale, wasMini = !!view?.mini;
    view = next;
    document.documentElement.dataset.theme = view.theme === 'dark' ? 'dark' : 'light';
    if (changedPet || !ctl) { ctl = new Pet.Controller(BUILT_IN.includes(view.pet) ? view.pet : 'squirrel'); ctl.idleSec = idleSec; shownKey = ''; }
    if (changedScale) size();
    // 状态切换的过渡（睡前打哈欠，醒来揉眼睛）在 Controller 里
    ctl.setMode(view.mode);
    if (wasMini !== !!view.mini) { peeking = false; peekUntil = 0; clearTimeout(tuckTimer); }
    syncSounds();
    layout();
    draw();
  }

  /* 鼠标在不在宠物身上：画出来的像素（周围放宽一格）才算；自定义宠物按图片的范围算 */
  function hitAt(x, y) {
    if (!view) return false;
    const width = Pet.W * scale, height = Pet.H * scale;
    let lx, ly;
    if (tilt) {
      // 极简模式歪着：把鼠标位置绕脚底中点转回去，再按没歪的样子判断
      const a = tilt * Math.PI / 180, dx = x - (stage.offsetLeft + origin.x), dy = y - (stage.offsetTop + origin.y);
      lx = dx * Math.cos(a) - dy * Math.sin(a) + origin.x; ly = dx * Math.sin(a) + dy * Math.cos(a) + origin.y;
    } else { const box = stage.getBoundingClientRect(); lx = x - box.left; ly = y - box.top; }
    if (lx < 0 || ly < 0 || lx >= width || ly >= height) return false;
    if (custom()) return true;
    if (!grid) return false;
    const gx = Math.floor(lx / scale), gy = Math.floor(ly / scale);
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
    // 极简模式：鼠标移上来探出来，移开过一会儿缩回去（气泡开着、正在探出来庆祝的时候不缩）
    if (view?.mini) {
      if (on) peek(true);
      else if (!document.body.classList.contains('talking') && Date.now() >= peekUntil) { clearTimeout(tuckTimer); tuckTimer = setTimeout(() => { if (!hovering) peek(false); }, 700); }
    }
  }

  document.addEventListener('mousemove', event => { if (!dragging) setHover(hitAt(event.clientX, event.clientY)); });
  document.addEventListener('mouseleave', () => { if (!dragging && !press) setHover(false); });
  stage.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !hitAt(event.clientX, event.clientY)) return;
    press = { x: event.screenX, y: event.screenY };
    try { stage.setPointerCapture(event.pointerId); } catch { /* 指针已经不在了：照样按普通点击处理 */ }
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
      // 落地动作等主进程说停下来了（甩出去要滑一段）；万一没收到，3 秒后自己落地
      clearTimeout(landTimer);
      landTimer = setTimeout(() => { if (ctl?.action === 'drag') ctl.trigger('land'); }, 3000);
      api.drag('end');
    } else if (clicked) tap();
  }
  /** 提示音（设置里能关）。几件事前后脚一起来只响一声。 */
  let soundAt = 0;
  function chime(kind) {
    if (!view?.sound || view.mute?.includes(kind)) return;
    const now = Date.now();
    if (now - soundAt < 1500) return;
    soundAt = now;
    stage.dataset.sound = kind;
    window.PulsePetSound?.play(kind, (view.volume ?? 70) / 100);
  }
  /** 换成自己音频的提示音：导入时间变了（或恢复默认了）就重新要一次数据交给 pet-sound.js 解码。 */
  let loadedSounds = {};
  function syncSounds() {
    const want = view?.sounds || {}, Sound = window.PulsePetSound;
    if (!Sound) return;
    for (const kind of Sound.KINDS) {
      if (want[kind] === loadedSounds[kind]) continue;
      if (!want[kind]) Sound.setCustom(kind, null);
      else api.soundData(kind).then(data => { if (view?.sounds?.[kind] === want[kind]) return Sound.setCustom(kind, data?.data || null); }).catch(() => undefined);
    }
    loadedSounds = { ...want };
  }
  /** 点了一下：算连点的第几下。双击戳一下，四下东张西望；只点一下的，等确定不是双击再打开气泡。 */
  function tap() {
    const n = clicks.press(Date.now());
    if (n === 4) ctl?.trigger('lookaround');
    else if (n >= 2) ctl?.trigger('poke');
    draw();
    setTimeout(() => { if (clicks.settle(Date.now()) === 1) api.click(); }, clicks.gap + 20);
  }
  stage.addEventListener('pointerup', () => release(true));
  stage.addEventListener('lostpointercapture', () => release(false));
  stage.addEventListener('pointercancel', () => release(false));
  // 兜底：窗口里任何东西都不走浏览器自带的拖放
  document.addEventListener('dragstart', event => event.preventDefault());
  document.addEventListener('contextmenu', event => { event.preventDefault(); if (hitAt(event.clientX, event.clientY)) api.menu(); });

  api.onState(apply);
  api.onPack(next => { pack = next; shownKey = ''; measurePack(); draw(); });
  api.onCursor(rel => ctl?.aim(rel.x, rel.y));
  window.addEventListener('resize', layout);
  api.onIdle(seconds => { idleSec = seconds; ctl?.idle(seconds); });
  api.onEvent(event => {
    if (!event) return;
    // 对话气泡开着：悬停提示别再叠在气泡上；极简模式下探出来对着气泡
    if (event.type === 'bubble') {
      document.body.classList.toggle('talking', event.open === true);
      if (view?.mini) { if (event.open === true) peek(true); else if (!hovering) peek(false); }
      return;
    }
    if (!ctl) return;
    if (event.type === 'celebrate') { ctl.trigger('celebrate'); chime('done'); if (view?.mini) peek(true, 4000); }
    else if (event.type === 'alert') {
      // 出错停下吓一跳；在问你、可能在等你确认就挥挥手叫你；额度用完只响一声（样子已经是没精神的了）
      if (event.kind === 'error') ctl.trigger('startle');
      else if (event.kind === 'waiting' || event.kind === 'ask') ctl.trigger('wave');
      chime(event.kind);
      if (view?.mini) peek(true, 4000);
    }
    else if (event.type === 'restock') ctl.trigger('restock', event.from);
    else if (event.type === 'fly') ctl.trigger('drag');
    else if (event.type === 'landed') { clearTimeout(landTimer); ctl.trigger('land'); }
    draw();
  });
  api.ready().then(data => { pack = data?.pack || null; measurePack(); apply(data?.view); }).catch(() => undefined);

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
