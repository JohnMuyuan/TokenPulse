'use strict';
/*
 * 桌宠窗口（0.3.61）。状态由主进程送来（src/main/desk-pet.ts 的 deskPetView）：宠物、大小、剩余额度和心情、
 * 现在是空闲 / 干活 / 睡觉、几个任务在跑。这里负责画、悬停提示、判断鼠标在不在宠物身上（不在时点击穿透到后面的窗口）、
 * 拖动和点击。动作节奏在 pet-engine.js 的 Controller 里。
 *
 * 互动：点一下（等 300 毫秒确认不是双击）打开对话气泡；双击戳一下；连点四下东张西望。
 * 拖着甩出去会滑一段、碰边弹回来（主进程算，停下来时发 landed）。极简模式（view.mini）：宠物贴在窗口右边、
 * 身子有一截在屏幕外，鼠标移上来探出来打招呼，移开缩回去。鼠标绕着宠物转两圈它会晕（Pet.Spin）。
 *
 * 自定义宠物有两种：图片宠物（pet.json，按状态换一张 <img>）和主题包宠物（Clawd on Desk 格式，pet-theme.js 画，
 * SVG 放在 #dp-svg 的 Shadow DOM 里，眼睛跟着鼠标）。
 */
(() => {
  const api = window.tokenpulse.deskPet;
  const Pet = window.PulsePet, Theme = window.PulsePetTheme;
  const $ = id => document.getElementById(id);
  const canvas = $('dp-canvas'), img = $('dp-img'), hint = $('dp-hint'), badge = $('dp-badge'), stage = $('dp-stage'), svgHost = $('dp-svg');
  const EN = window.PulseI18n?.lang?.() === 'en';
  const L = (zh, en) => EN ? en : zh;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const BUILT_IN = ['squirrel', 'hamster', 'octopus'];

  let view = null, pack = null, ctl = null, grid = null, scale = 2, pixel = 2, hovering = false, shownKey = '';
  /** xf：极简模式下舞台的变换（轴 o、变换的逆矩阵），判断鼠标位置时用；平时是 null。 */
  let press = null, dragging = false, idleSec = 0, landTimer = 0, tuckTimer = 0, peeking = false, peekUntil = 0, xf = null, customBox = null;
  const clicks = new Pet.Clicks(300);
  const themeView = new Theme.ThemeView(svgHost);
  let spin = new Pet.Spin(), pressX = 0;
  /** 主题包：进入干活时抽一次，一个档位有好几个动画时挑哪个（同一段干活里不换）；极简模式探出来的时间（mini-peek 放够了换 mini-peek-hold）。 */
  let workSeed = 0, peekAt = 0;

  function ctx() {
    // 主题包的随机待机：鼠标 mouseIdleTimeout 没动、没悬停没拖着才放
    const theme = themed() ? themeView.theme : null, idleAnims = !!theme?.idleAnimations.length && !hovering && !dragging && !press;
    return { state: view.mode, phase: view.phase || null, quota: view.quota ?? 100, mood: view.mood, tasks: view.tasks, mini: !!view.mini, fidget: view.fidget && !reduced.matches && (BUILT_IN.includes(view.pet) || idleAnims), fidgetAfter: theme ? theme.timings.mouseIdleTimeout : 0 };
  }

  function size() {
    scale = view.scale;
    pixel = Math.max(1, Math.round(scale * (window.devicePixelRatio || 1)));
    canvas.width = Pet.W * pixel; canvas.height = Pet.H * pixel;
    for (const node of [canvas, img]) { node.style.width = Pet.W * scale + 'px'; node.style.height = Pet.H * scale + 'px'; }
    themeView.layout(Pet.W * scale, Pet.H * scale, scale);
    hint.style.bottom = Pet.H * scale + 2 + 'px';
    // 离身体太近角度乱跳、太远就不算绕着它转了：按放大倍数算
    spin = new Pet.Spin({ minR: 12 * scale, maxR: 160 * scale });
  }

  /** 宠物身体占的格子 [左, 上, 右, 下]：内置的写在 pet-engine.js；主题包按 layout.contentBox；图片宠物按 idle 图里不透明的范围量（还没量好先用画面中间一块）。 */
  function bodyBox() {
    if (themed()) return themeView.bodyCells();
    return custom() ? (customBox || [18, 20, 53, 55]) : Pet.BODY[view.pet];
  }
  /** 换了自定义宠物：主题包交给 pet-theme.js，动作时长按主题写的。 */
  function setPack(next) {
    pack = next; shownKey = '';
    themeView.load(pack);
    tune();
    measurePack();
    layout();
  }
  /** 主题包宠物：动作时长按主题写的，随机小动作换成主题的随机待机（轮着放，两次之间隔 10～30 秒）。 */
  function tune() {
    if (!ctl) return;
    const theme = view && custom() && themeView.ready ? themeView.theme : null;
    ctl.dur = theme ? Theme.durations(theme) : {};
    ctl.fidgets = theme ? theme.idleAnimations.map((_, i) => 'idle:' + i) : null;
    ctl.fidgetGap = theme ? [100, 300] : [200, 600];
  }
  function measurePack() {
    customBox = null;
    const src = pack?.images?.idle;
    if (!src || pack.kind === 'theme') return;
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

  /** 极简模式贴哪条边（不在极简模式返回 ''）。 */
  function edgeOf() { return view?.mini ? view.mini.edge || 'right' : ''; }

  /**
   * 摆宠物：平时在窗口底边中间。极简模式像躲在屏幕边后面探头，窗口外的部分本来就看不见；鼠标移上来换成 peek 的姿势，探得更出来。
   * - 右边：以身体的脚底中点为轴往左歪 tilt 度，头先探出来，探出屏幕的宽度是身宽的 show 倍（矮胖的、高瘦的都探出差不多的比例）。
   *   主题包写了极简动画的不歪：动画自己画好了探头的样子，按主题写的比例藏进屏幕、探出来（ThemeView.miniLeft）。
   * - 左边：把右边的样子整个左右翻过来（以窗口中线为镜子）。
   * - 下边：脚底沉到窗口底边下面，只冒出身高的 show 倍。
   * - 上边：倒挂金钩——绕脚底中点转 180 度，脚勾在窗口顶边上面，头朝下露出身高的 show 倍；样式表让它绕脚荡来荡去。
   * 算好的变换记在 xf 里，判断鼠标在不在宠物身上时反着变回去。
   */
  function layout() {
    const mini = view?.mini, edge = edgeOf();
    document.body.classList.toggle('mini', !!mini);
    document.body.dataset.edge = edge;
    stage.dataset.mini = mini ? (peeking ? 'peek' : 'tuck') : '';
    hint.style.bottom = Pet.H * scale + 2 + 'px';
    if (!mini) { xf = null; stage.style.left = ''; stage.style.top = ''; stage.style.bottom = ''; stage.style.transform = ''; stage.style.transformOrigin = ''; return; }
    const W = window.innerWidth, H = window.innerHeight, pose = peeking ? mini.peek : mini.tuck;
    let left, top = null, transform = '', o;
    const own = (edge === 'left' || edge === 'right') && themed() ? themeView.miniLeft(W, peeking) : null;
    if (own != null) { left = own; o = { x: Pet.W * scale / 2, y: Pet.H * scale }; }
    else {
      const [x0, y0, x1, y1] = bodyBox();
      const width = (x1 - x0 + 1) * scale, height = (y1 - y0 + 1) * scale, a = pose.tilt * Math.PI / 180;
      o = { x: (x0 + x1 + 1) / 2 * scale, y: (y1 + 1) * scale };
      if (edge === 'top' || edge === 'bottom') {
        left = W / 2 - o.x;
        // 脚底（轴）在窗口里的高度：下边沉到窗口底下 (1 - show) 个身高；上边吊在窗口顶上面这么多，身子倒过来往下垂
        const hidden = height * (1 - pose.show);
        top = (edge === 'bottom' ? H + hidden : -hidden) - o.y;
        if (edge === 'top') transform = 'rotate(180deg)';
        // 提示条：下边的挨着冒出来的头顶，上边的放到窗口最下面（倒挂着的头下面）
        hint.style.bottom = (edge === 'bottom' ? Math.round(height * mini.peek.show) + 6 : 2) + 'px';
      } else {
        // 歪过去以后，身体左上角离轴有多远（最先探出屏幕的就是这个角）
        const reach = width / 2 * Math.cos(a) + height * Math.sin(a);
        left = W + reach - width * pose.show - o.x;
        transform = `rotate(${-pose.tilt}deg)`;
      }
    }
    // 左边：以窗口中线为镜子翻过来。舞台绕轴 o 翻，左边界要挪到 W - left - 2·o.x
    if (edge === 'left') { left = W - left - 2 * o.x; transform = ('scaleX(-1) ' + transform).trim(); }
    xf = { o, inverse: (transform ? new DOMMatrix(transform) : new DOMMatrix()).inverse() };
    stage.style.transformOrigin = `${o.x}px ${o.y}px`;
    stage.style.left = Math.round(left) + 'px';
    stage.style.top = top == null ? '' : Math.round(top) + 'px';
    stage.style.bottom = top == null ? '' : 'auto';
    // transform 要写 none：样式表里平时是 translateX(-50%) 居中
    stage.style.transform = transform || 'none';
  }
  /** 极简模式下探出来；ms 毫秒后自己缩回去（鼠标还在上面、气泡还开着就不缩）。不给 ms 等鼠标移开。 */
  function peek(on, ms = 0) {
    clearTimeout(tuckTimer); tuckTimer = 0;
    peekUntil = on && ms ? Date.now() + ms : 0;
    if (on && ms) tuckTimer = setTimeout(() => peek(hovering || document.body.classList.contains('talking')), ms);
    if (peeking === on) return;
    peeking = on; peekAt = on ? Date.now() : 0;
    // 主题包的极简动画自己有探头（mini-peek），不另外挥手
    if (on && view?.mini && ctl && !ctl.action && !themeMini()) ctl.trigger('wave');
    layout();
    draw();
  }
  /** 主题包自己的极简动画是照「从左右边探头」画的：只有贴左右边时用，贴上下边照平时的动画、和内置宠物一样摆。 */
  function themeMini() { const edge = edgeOf(); return (edge === 'left' || edge === 'right') && themed() && !!themeView.theme.miniMode; }

  function custom() { return !BUILT_IN.includes(view.pet); }
  function themed() { return custom() && themeView.ready; }
  /** 自定义宠物：按动作和状态挑一张图，没有的用 idle。 */
  function imageKey() {
    const has = key => !!pack?.images?.[key];
    const pick = (...keys) => keys.find(has) || 'idle';
    const action = ctl.action, state = ctl.stateOf(ctx());
    if (action === 'drag') return pick('drag', 'startle');
    if (action === 'startle') return pick('startle');
    if (action === 'dizzy') return pick('dizzy', 'startle');
    if (action === 'poke') return pick('poke', 'startle');
    if (action === 'celebrate' || action === 'restock') return pick('celebrate');
    if (action === 'wave') return pick('wave');
    if (action === 'lookaround') return pick('look');
    if (state === 'sleep' || action === 'flop') return pick('sleep');
    if (state === 'doze' || action === 'yawn') return pick('doze', 'sleep');
    if ((edgeOf() === 'left' || edgeOf() === 'right') && has('peek')) return 'peek';
    if (view.mood === 'empty') return pick('empty', 'tight');
    if (view.mode === 'work') return view.phase === 'thinking' ? pick('think', 'work') : pick('work');
    // 额度紧张：和内置宠物一样，平时照常待着，隔一阵紧张一下（ctl.nervous，两三秒）才换成 tight 图，不一直冒汗
    if (view.mood === 'tight' && ctl.nervous) return pick('tight');
    return 'idle';
  }

  function draw() {
    if (!view || !ctl) return;
    // 现在画的是哪只、在做什么：写在节点上，方便检查
    stage.dataset.pet = view.pet; stage.dataset.mode = view.mode; stage.dataset.phase = view.phase || ''; stage.dataset.action = ctl.action || ''; stage.dataset.state = ctl.stateOf(ctx());
    // 打盹、睡着是宠物自己走到的，不一定有新的状态送来：提示跟着画面变
    const text = hintText();
    if (hint.textContent !== text) hint.textContent = text;
    if (custom()) {
      canvas.hidden = true;
      if (themed()) {
        img.hidden = true; svgHost.hidden = false;
        const theme = themeView.theme, right = window.screenX + window.innerWidth / 2 > (screen.availLeft || 0) + screen.availWidth / 2;
        const pick = Theme.visualOf(theme, {
          action: ctl.action, serial: ctl.serial, state: ctl.stateOf(ctx()), mode: view.mode, phase: view.phase, asking: view.asking, tasks: view.tasks,
          subagents: view.subagents || 0, seed: workSeed, right, mini: themeMini(), peek: peeking, peekHold: peeking && Date.now() - peekAt >= Theme.peekHoldMs(theme),
        });
        stage.dataset.image = themeView.show(pick.file, pick.once ? `${pick.file}#${ctl.serial}` : pick.key || pick.file, !!pick.mirror);
        // 眼睛跟着鼠标：ctl.look 是看的方向（x -2 ~ 2，y -1.5 ~ 1.5；鼠标一动直接看过去，几秒不动时它自己慢慢东张西望）
        themeView.look(ctl.look.x / 2, ctl.look.y / 1.5);
      } else {
        svgHost.hidden = true; img.hidden = !pack;
        const key = imageKey();
        stage.dataset.image = key;
        if (pack && key !== shownKey) { shownKey = key; img.src = pack.images[key] || pack.images.idle || ''; }
      }
      badge.hidden = !view.badge;
      if (view.badge) {
        badge.textContent = (view.quota == null ? '—' : `${view.quota}%`) + (view.tasks ? ` · ${view.tasks}` : '');
        badge.className = 'dp-badge' + (view.mood === 'ok' ? '' : ' ' + view.mood);
      }
      return;
    }
    canvas.hidden = false; img.hidden = true; svgHost.hidden = true; badge.hidden = true;
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
    const changedPet = !view || view.pet !== next.pet, changedScale = !view || view.scale !== next.scale, wasEdge = edgeOf(), wasWork = view?.mode === 'work';
    view = next;
    document.documentElement.dataset.theme = view.theme === 'dark' ? 'dark' : 'light';
    if (changedPet || !ctl) {
      ctl = new Pet.Controller(BUILT_IN.includes(view.pet) ? view.pet : 'squirrel'); ctl.idleSec = idleSec; shownKey = '';
      tune();
    }
    if (changedScale) size();
    if (view.mode === 'work' && !wasWork) workSeed = Math.floor(Math.random() * 1000);
    // 状态切换的过渡（睡前打哈欠，醒来揉眼睛）在 Controller 里
    ctl.setMode(view.mode);
    if (wasEdge !== edgeOf()) {
      peeking = false; peekUntil = 0; peekAt = 0; clearTimeout(tuckTimer);
      // 主题包有极简动画：钻进屏幕边时放 mini-enter
      if (view.mini && !changedPet && themeMini()) ctl.trigger('miniEnter');
    }
    syncSounds();
    layout();
    draw();
  }

  /* 鼠标在不在宠物身上：画出来的像素（周围放宽一格）才算；自定义宠物按图片的范围算 */
  function hitAt(x, y) {
    if (!view) return false;
    const width = Pet.W * scale, height = Pet.H * scale;
    let lx, ly;
    if (xf) {
      // 极简模式歪着 / 翻着 / 倒挂着：把鼠标位置绕轴变回去，再按没变的样子判断
      const p = xf.inverse.transformPoint({ x: x - (stage.offsetLeft + xf.o.x), y: y - (stage.offsetTop + xf.o.y) });
      lx = p.x + xf.o.x; ly = p.y + xf.o.y;
    } else { const box = stage.getBoundingClientRect(); lx = x - box.left; ly = y - box.top; }
    if (themed()) return themeView.hit(lx, ly);
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
    pressX = event.clientX;
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
    const n = clicks.press(Date.now()), x = pressX;
    if (n === 4) ctl?.trigger('lookaround');
    else if (n >= 2) ctl?.trigger('poke');
    draw();
    setTimeout(() => {
      if (clicks.settle(Date.now()) !== 1) return;
      api.click();
      // 主题包写了点左边 / 右边的反应：气泡照开，宠物顺便往被点的那边缩一下
      const side = x < stage.getBoundingClientRect().left + stage.offsetWidth / 2 ? 'clickLeft' : 'clickRight';
      if (themed() && !view.mini && ctl && !ctl.action && themeView.theme.reactions[side]) { ctl.trigger(side === 'clickLeft' ? 'tapLeft' : 'tapRight'); draw(); }
    }, clicks.gap + 20);
  }
  /** 能不能转晕：平时空闲、没在做动作、没被拖着、不在极简模式；内置宠物都能，主题包和图片宠物要有晕的动画。 */
  function canDizzy() {
    if (!view || !ctl || view.mini || dragging || press || ctl.action || ctl.stateOf(ctx()) !== 'idle') return false;
    if (!custom()) return true;
    return themed() ? !!themeView.theme.states.dizzy : !!pack?.images?.dizzy;
  }
  stage.addEventListener('pointerup', () => release(true));
  stage.addEventListener('lostpointercapture', () => release(false));
  stage.addEventListener('pointercancel', () => release(false));
  // 兜底：窗口里任何东西都不走浏览器自带的拖放
  document.addEventListener('dragstart', event => event.preventDefault());
  document.addEventListener('contextmenu', event => { event.preventDefault(); if (hitAt(event.clientX, event.clientY)) api.menu(); });

  api.onState(apply);
  api.onPack(next => { setPack(next); draw(); });
  api.onCursor(rel => {
    if (!ctl) return;
    // 鼠标位置是按屏幕算的：宠物贴左边时左右翻着、倒挂时上下左右都反着，眼睛要反过来看
    const edge = edgeOf();
    ctl.aim(edge === 'left' || edge === 'top' ? -rel.x : rel.x, edge === 'top' ? -rel.y : rel.y);
    if (!canDizzy()) spin.reset();
    else if (spin.add(rel.x, rel.y)) ctl.trigger('dizzy');
    // 眼睛马上画到新位置，不等下一帧（每秒 10 帧，等下去看着慢半拍）
    draw();
  });
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
      if (event.kind === 'error') ctl.trigger(themed() ? 'error' : 'startle');
      else if (event.kind === 'waiting' || event.kind === 'ask') ctl.trigger('wave');
      chime(event.kind);
      if (view?.mini) peek(true, 4000);
    }
    else if (event.type === 'restock') ctl.trigger('restock', event.from);
    else if (event.type === 'fly') ctl.trigger('drag');
    else if (event.type === 'landed') { clearTimeout(landTimer); ctl.trigger('land'); }
    draw();
  });
  api.ready().then(data => { setPack(data?.pack || null); apply(data?.view); }).catch(() => undefined);

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
