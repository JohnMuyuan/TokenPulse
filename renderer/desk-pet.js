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
  const Pet = window.PulsePet, Theme = window.PulsePetTheme, Desk = window.PulsePetDesk;
  const $ = id => document.getElementById(id);
  const canvas = $('dp-canvas'), deskCanvas = $('dp-desk'), img = $('dp-img'), hint = $('dp-hint'), badge = $('dp-badge'), stage = $('dp-stage'), svgHost = $('dp-svg');
  const isEn = () => window.PulseI18n?.lang?.() === 'en';
  const L = (zh, en) => isEn() ? en : zh;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const BUILT_IN = ['squirrel', 'hamster', 'octopus'];

  let view = null, pack = null, deskPack = null, ctl = null, grid = null, scale = 2, pixel = 2, lastDpr = window.devicePixelRatio || 1, hovering = false, shownKey = '';
  /** xf：极简模式下舞台的变换（轴 o、变换的逆矩阵），判断鼠标位置时用；平时是 null。 */
  let press = null, dragging = false, idleSec = 0, landTimer = 0, tuckTimer = 0, tapTimer = 0, peeking = false, peekUntil = 0, xf = null, customBox = null;
  let customColor = '', crabHint = false, deskTimer = 0, lastDeskPaintAt = 0, lastDeskSig = '', themeMetrics = null, lastCursorIn = null;
  const desk = Desk ? new Desk.DeskState() : null;
  const clicks = new Pet.Clicks(300);
  const themeView = new Theme.ThemeView(svgHost);
  let spin = new Pet.Spin(), pressX = 0;
  /** 主题包：进入干活时抽一次，一个档位有好几个动画时挑哪个（同一段干活里不换）；极简模式探出来的时间（mini-peek 放够了换 mini-peek-hold）。 */
  let workSeed = 0, peekAt = 0;

  function ctx(now = Date.now()) {
    // 主题包的随机待机：鼠标/键盘都静止、没悬停没拖着、且当前未在键鼠互动或密码捂眼时才允许触发
    const deskBusy = !!desk && view?.desk === true && !view.mini && (desk.isUserActive(now) || desk.covering);
    const theme = themed() ? themeView.theme : null, idleAnims = !!theme?.idleAnimations.length && !hovering && !dragging && !press;
    return { state: view.mode, phase: view.phase || null, quota: view.quota ?? 100, mood: view.mood, tasks: view.tasks, subagents: view.subagents || 0, mini: !!view.mini, fidget: !deskBusy && view.fidget && !reduced.matches && (BUILT_IN.includes(view.pet) || idleAnims), fidgetAfter: theme ? theme.timings.mouseIdleTimeout : 0 };
  }

  function size() {
    scale = view.scale;
    lastDpr = window.devicePixelRatio || 1;
    pixel = Math.max(1, Math.round(scale * lastDpr));
    canvas.width = Pet.W * pixel; canvas.height = Pet.H * pixel;
    if (deskCanvas) {
      const deskPx = Math.max(2, Math.round(scale * Math.max(2, window.devicePixelRatio || 1)));
      deskCanvas.width = Pet.W * deskPx;
      deskCanvas.height = Pet.H * deskPx;
      deskCanvas.style.width = Pet.W * scale + 'px';
      deskCanvas.style.height = Pet.H * scale + 'px';
    }
    for (const node of [canvas, img]) { node.style.width = Pet.W * scale + 'px'; node.style.height = Pet.H * scale + 'px'; }
    themeView.layout(Pet.W * scale, Pet.H * scale, scale);
    themeMetrics = null;
    lastDeskSig = '';
    hint.style.bottom = Pet.H * scale + 2 + 'px';
    // 离身体太近角度乱跳、太远就不算绕着它转了：按放大倍数算
    spin = new Pet.Spin({ minR: 12 * scale, maxR: 160 * scale });
  }

  /** 宠物身体占的格子 [左, 上, 右, 下]：内置的写在 pet-engine.js；主题包按 layout.contentBox；图片宠物按 idle 图里不透明的范围量（还没量好先用画面中间一块）。 */
  function bodyBox() {
    if (themed()) return themeView.bodyCells();
    return custom() ? (customBox || [18, 20, 53, 55]) : Pet.BODY[view.pet];
  }
  /** 从主题包（如 Clawd 珊瑚橙小螃蟹）或自定义图片里提取主色，让前景小爪/小钳子自然融入。 */
  function samplePackColor() {
    customColor = '';
    crabHint = /clawd|crab|螃蟹/i.test(pack?.name || pack?.theme?.name || '');
    if (!pack) return;
    if (pack.kind === 'theme' && pack.files) {
      const idleFile = pack.theme?.states?.idle?.[0];
      const svg = (idleFile && pack.files[idleFile]?.svg) || Object.values(pack.files).find(f => f?.svg)?.svg || '';
      if (svg) {
        // 挑出现最多的非黑白灰填充色（小螃蟹 #D97757 / #DE7356 等会自然胜出）
        const counts = new Map();
        const re = /fill\s*[:=]\s*["']?(#[0-9a-f]{3,6}|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\))/gi;
        let m;
        while ((m = re.exec(svg))) {
          const col = m[1].toLowerCase();
          const rgb = col.startsWith('#')
            ? (col.length === 4 ? [parseInt(col[1] + col[1], 16), parseInt(col[2] + col[2], 16), parseInt(col[3] + col[3], 16)] : [parseInt(col.slice(1, 3), 16), parseInt(col.slice(3, 5), 16), parseInt(col.slice(5, 7), 16)])
            : col.match(/\d+/g).map(Number);
          if (!rgb || rgb.length < 3) continue;
          const max = Math.max(rgb[0], rgb[1], rgb[2]), min = Math.min(rgb[0], rgb[1], rgb[2]);
          if (max < 45 || (min > 215 && max - min < 20) || (max - min < 14 && max < 90)) continue;
          counts.set(col, (counts.get(col) || 0) + 1);
        }
        let best = '', bestN = 0;
        for (const [col, n] of counts) if (n > bestN) { best = col; bestN = n; }
        if (best) customColor = best;
      }
      return;
    }
  }

  /** 换了自定义宠物：主题包交给 pet-theme.js，动作时长按主题写的。 */
  function setPack(next) {
    pack = next; shownKey = ''; themeMetrics = null; lastDeskSig = '';
    restoreThemeHands();
    themeView.load(pack);
    samplePackColor();
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
      // 顺手提取自定义图片的平均主色给小爪配色
      let sr = 0, sg = 0, sb = 0, sn = 0;
      for (let i = 0; i < d.length; i += 16) {
        if (d[i + 3] < 120) continue;
        const max = Math.max(d[i], d[i + 1], d[i + 2]), min = Math.min(d[i], d[i + 1], d[i + 2]);
        if (max < 40 || (min > 220 && max - min < 20)) continue;
        sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; sn++;
      }
      if (sn > 0) customColor = `rgb(${Math.round(sr / sn)},${Math.round(sg / sn)},${Math.round(sb / sn)})`;
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
    themeMetrics = null;
    lastDeskSig = '';
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

  /** 方案 A 融合：计算当前帧键鼠桌面是否显示、是否切到清爽站姿，以及前景是否接管双手（非站姿/随机待机时保留键鼠并自动隐藏接管手，杜绝悬空手）。 */
  function deskMode(now = Date.now()) {
    if (!Desk || !desk || !deskCanvas || !view || view.desk !== true || view.mini || dragging) {
      return { show: false, poseIdle: false, hands: false, aiBadge: false, state: 'hidden' };
    }
    const baseState = ctl ? ctl.stateOf(ctx(now)) : view.mode;
    const action = ctl?.action || null;
    // 睡着、打盹或正在做强覆盖动作（拖拽/庆祝/出错/挥手/转晕等）时暂不遮挡
    const blocked = baseState === 'sleep' || baseState === 'doze' || action === 'drag' || action === 'celebrate' || action === 'error' || action === 'startle' || action === 'dizzy' || action === 'flop' || action === 'yawn' || action === 'restock';
    if (blocked) return { show: false, poseIdle: false, hands: false, aiBadge: false, state: 'hidden' };
    if (desk.covering) {
      return { show: true, poseIdle: true, hands: true, aiBadge: view.mode === 'work', state: 'privacy' };
    }
    const active = desk.isUserActive(now);
    if (view.mode === 'work') {
      // 方案 A：AI 干活时，只有用户在打字/用鼠标且没有待确认提问时才弹出键鼠桌面 + 右上角 AI 忙碌微标；停手后无缝切回原生工作动画
      if (active && !view.asking) {
        return { show: true, poseIdle: true, hands: true, aiBadge: true, state: now - desk.lastKeyAt < 500 ? 'typing' : 'mouse' };
      }
      return { show: false, poseIdle: false, hands: false, aiBadge: false, state: 'hidden' };
    }
    // 空闲时键鼠常驻；正在播放随机待机动画或点击反应（poke/lookaround/wave/tapLeft/tapRight/wake/land 等）时，
    // 按方案 A 保留桌前键鼠、隐去前景接管手并还原桌宠原画自己的双手，彻底消除悬空手与四只手！
    const inFidget = Boolean(action && ctl?.isFidgetAction?.(action));
    if (active && inFidget) {
      return { show: true, poseIdle: true, hands: true, aiBadge: false, state: now - desk.lastKeyAt < 500 ? 'typing' : 'mouse' };
    }
    const hands = !action;
    return { show: true, poseIdle: false, hands, aiBadge: false, state: now - desk.lastKeyAt < 500 ? 'typing' : active ? 'mouse' : 'idle' };
  }

  /**
   * 对当前 SVG 主题节点只测量一次眼睛与原生左右小手基准坐标（按 node + scale 缓存），
   * 避免每帧反复调用 getBoundingClientRect / querySelectorAll / getComputedStyle 触发布局抖动。
   */
  function getThemeMetrics() {
    if (!themed() || !themeView.node) return null;
    if (themeMetrics && themeMetrics.node === themeView.node && themeMetrics.scale === scale) return themeMetrics;
    const prevTf = svgHost.style.transform;
    if (prevTf) svgHost.style.transform = '';
    let result = null;
    try {
      const sr = stage.getBoundingClientRect();
      if (sr.width <= 0 || sr.height <= 0) return null;
      const eyeId = themeView.theme?.eyeTracking?.ids?.eyes || 'eyes-js';
      const bodyId = themeView.theme?.eyeTracking?.ids?.body || 'body-js';
      const eyeEl = themeView.node.querySelector?.('#' + CSS.escape(eyeId));
      let eyeBox = null;
      if (eyeEl) {
        const er = eyeEl.getBoundingClientRect();
        if (er.width > 0 && er.height > 0) {
          eyeBox = {
            cx: ((er.left + er.right) / 2 - sr.left) / scale,
            cy: ((er.top + er.bottom) / 2 - sr.top) / scale,
            halfSpan: Math.max(4, Math.min(11, er.width / (2 * scale) * 0.85)),
          };
        }
      }
      if (!eyeBox) {
        const [x0, y0, x1, y1] = themeView.bodyCells();
        eyeBox = { cx: (x0 + x1) / 2, cy: y0 + (y1 - y0) * 0.44, halfSpan: Math.max(4, Math.min(8, (x1 - x0) * 0.16)) };
      }

      let hands = null;
      const bodyEl = themeView.node.querySelector?.('#' + CSS.escape(bodyId));
      if (bodyEl) {
        const rects = [...bodyEl.querySelectorAll('rect')].filter(el => !eyeEl || !eyeEl.contains(el));
        if (rects.length >= 3) {
          const items = rects.map(el => {
            const r = el.getBoundingClientRect();
            return { el, r, area: r.width * r.height, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
          }).filter(it => it.r.width > 0 && it.r.height > 0);
          const torso = items.find(it => it.el.id === 'torso') || items.reduce((a, b) => (b.area > a.area ? b : a), items[0]);
          if (torso && torso.area > 0) {
            const sideCandidates = items.filter(it =>
              it !== torso &&
              it.area < torso.area * 0.35 &&
              it.cy >= torso.r.top - torso.r.height * 0.15 &&
              it.cy <= torso.r.bottom + torso.r.height * 0.15
            );
            const leftHand = sideCandidates
              .filter(it => it.cx < torso.r.left + torso.r.width * 0.12)
              .sort((a, b) => a.cx - b.cx)[0];
            const rightHand = sideCandidates
              .filter(it => it.cx > torso.r.right - torso.r.width * 0.12)
              .sort((a, b) => b.cx - a.cx)[0];
            if (leftHand && rightHand) {
              const toLogical = it => ({
                cx: ((it.cx - sr.left) / scale) * 4,
                cy: ((it.cy - sr.top) / scale) * 4,
                w: (it.r.width / scale) * 4,
                h: (it.r.height / scale) * 4,
              });
              const fill = leftHand.el.getAttribute('fill') || getComputedStyle(leftHand.el).fill || customColor || '';
              hands = { leftEl: leftHand.el, rightEl: rightHand.el, left: toLogical(leftHand), right: toLogical(rightHand), fill };
            }
          }
        }
      }
      result = { node: themeView.node, scale, eyeBox, hands };
      themeMetrics = result;
    } finally {
      if (prevTf) svgHost.style.transform = prevTf;
    }
    return result;
  }

  /** 按缓存的主题基准坐标或自定义图片框推算捂眼对齐位置（零每帧 DOM 测量）。 */
  function measureEyeBox(bt) {
    if (!Desk) return null;
    if (themed() && themeView.node) {
      const m = getThemeMetrics();
      if (m?.eyeBox) {
        const dx = bt ? bt.x / scale : 0;
        const dy = bt ? bt.y / scale : 0;
        return dx || dy ? { cx: m.eyeBox.cx + dx, cy: m.eyeBox.cy + dy, halfSpan: m.eyeBox.halfSpan } : m.eyeBox;
      }
      const [x0, y0, x1, y1] = themeView.bodyCells();
      return { cx: (x0 + x1) / 2, cy: y0 + (y1 - y0) * 0.44, halfSpan: Math.max(4, Math.min(8, (x1 - x0) * 0.16)) };
    }
    if (custom() && customBox) {
      const [x0, y0, x1, y1] = customBox;
      return { cx: (x0 + x1) / 2, cy: y0 + (y1 - y0) * 0.38, halfSpan: Math.max(4, Math.min(7, (x1 - x0) * 0.16)) };
    }
    return Desk.DEFAULT_EYES[view?.pet] || Desk.DEFAULT_EYES.custom;
  }

  function applyBodyMotion(show, now) {
    const nodes = [svgHost, canvas, img];
    if (!show || !desk) {
      for (const el of nodes) if (el.style.transform) el.style.transform = '';
      return { x: 0, y: 0, deg: 0, sx: 1, sy: 1 };
    }
    const bt = desk.bodyTransform(scale, now, reduced.matches);
    const active = bt.x !== 0 || bt.y !== 0 || bt.deg !== 0 || bt.sx !== 1 || bt.sy !== 1;
    const tf = active ? `translate(${bt.x}px, ${bt.y}px) rotate(${bt.deg}deg) scale(${bt.sx.toFixed(4)}, ${bt.sy.toFixed(4)})` : '';
    const target = themed() ? svgHost : (custom() ? img : canvas);
    for (const el of nodes) {
      const want = el === target ? tf : '';
      if (el.style.transform !== want) el.style.transform = want;
    }
    return bt;
  }

  let hiddenThemeHands = [];

  /** 还原上次为了互动桌面临时隐藏的主题包原生小手元素。 */
  function restoreThemeHands() {
    if (!hiddenThemeHands.length) return;
    for (const el of hiddenThemeHands) {
      try { el.style.visibility = ''; } catch { /* ignore */ }
    }
    hiddenThemeHands = [];
  }

  /**
   * 复用缓存的主题原生小手引用：互动桌面显示期间临时隐藏静态小手，
   * 按 bodyTransform 数学推算最新坐标（零 DOM 读、零布局重排），离开桌面立刻无损还原。
   */
  function syncThemeHands(active, bt) {
    if (!active || !themed() || !themeView.node) {
      restoreThemeHands();
      return null;
    }
    const m = getThemeMetrics();
    const h = m?.hands;
    if (!h) {
      restoreThemeHands();
      return null;
    }
    if (hiddenThemeHands[0] !== h.leftEl || hiddenThemeHands[1] !== h.rightEl) {
      restoreThemeHands();
      h.leftEl.style.visibility = 'hidden';
      h.rightEl.style.visibility = 'hidden';
      hiddenThemeHands = [h.leftEl, h.rightEl];
    }
    const dx = bt ? (bt.x / scale) * 4 : 0;
    const dy = bt ? (bt.y / scale) * 4 : 0;
    if (!dx && !dy) return { left: h.left, right: h.right, fill: h.fill };
    return {
      left: { cx: h.left.cx + dx, cy: h.left.cy + dy, w: h.left.w, h: h.left.h },
      right: { cx: h.right.cx + dx, cy: h.right.cy + dy, w: h.right.w, h: h.right.h },
      fill: h.fill,
    };
  }

  function paintDeskLayer(dm, now = Date.now(), force = true) {
    if (!deskCanvas || !Desk || !desk) return;
    if (stage.dataset.desk !== dm.state) stage.dataset.desk = dm.state;
    const nextPriv = desk.covering ? '1' : '0';
    if (stage.dataset.privacy !== nextPriv) stage.dataset.privacy = nextPriv;
    const wantHands = dm.show && dm.hands !== false;
    const bt = applyBodyMotion(wantHands, now);
    const nativeHands = syncThemeHands(wantHands, bt);
    // 悬空手熔断保护：主题包 SVG 只要未能识别原生左右方块手（如非标准站姿 SVG），除密码捂眼外绝不画游离前景手
    const showHands = wantHands && (!themed() || Boolean(nativeHands) || desk.covering);
    const handsVal = showHands ? '1' : '0';
    if (stage.dataset.deskHands !== handsVal) stage.dataset.deskHands = handsVal;
    if (!dm.show) {
      if (!deskCanvas.hidden) deskCanvas.hidden = true;
      lastDeskSig = '';
      return;
    }
    const deskStyle = view.deskStyle || 'white';
    const animatedStyle = !reduced.matches && Desk.isAnimatedStyle?.(deskStyle, deskPack);
    const sig = `${dm.state}|${handsVal}|${dm.aiBadge ? 1 : 0}|${view.theme}|${deskStyle}|${deskPack?.id || ''}|${view.pet}|${view.mood}|${dm.aiBadge ? view.phase || '' : ''}|${dm.aiBadge ? view.subagents || 0 : 0}|${nextPriv}|${scale}|${bt.x}|${bt.y}|${nativeHands ? `${Math.round(nativeHands.left.cx)},${Math.round(nativeHands.right.cx)}` : ''}`;
    if (!force && sig === lastDeskSig && !dm.aiBadge && !desk.covering && !animatedStyle) return;
    lastDeskSig = sig;
    lastDeskPaintAt = now;
    if (deskCanvas.hidden) deskCanvas.hidden = false;
    Desk.paintDesk(deskCanvas, desk, {
      theme: view.theme,
      style: deskStyle,
      deskPack,
      pet: view.pet,
      mood: view.mood,
      customColor,
      crabHint,
      eyeBox: measureEyeBox(bt),
      nativeHands,
      showHands,
      aiWorking: dm.aiBadge,
      aiPhase: view.phase || 'tool',
      subagents: view.subagents || 0,
      now,
      reducedMotion: reduced.matches,
      en: isEn(),
      onImageLoad: () => { lastDeskSig = ''; draw(true); },
    });
  }

  /** 按 petFps 上限（默认 30 FPS，绝不在 300Hz 屏上飙到 300 FPS 拖卡 GPU/DWM）按需驱动键鼠/飘字/捂眼帧；静止时自动停止。 */
  function wakeDeskAnim() {
    if (deskTimer || !Desk || !desk) return;
    const minGap = reduced.matches ? 100 : Math.max(8, Math.round(1000 / Math.max(15, petFps)));
    const wait = Math.max(0, minGap - (Date.now() - lastDeskPaintAt));
    const step = () => {
      deskTimer = 0;
      if (!view || !ctl || document.visibilityState === 'hidden') return;
      const now = Date.now();
      const busy = desk.step(now, reduced.matches);
      const dm = deskMode(now);
      if (dm.show || !deskCanvas?.hidden) {
        // 状态切换（例如刚进入/退出方案 A、捂眼或切换接管双手）时完整重绘一次宠物本体
        const prevDeskState = stage.dataset.desk || '';
        const prevHands = stage.dataset.deskHands === '1';
        const nextShowHands = dm.show && dm.hands !== false && (!themed() || Boolean(getThemeMetrics()?.hands) || desk.covering);
        if ((prevDeskState === 'hidden') !== (!dm.show) || (prevDeskState === 'privacy') !== (dm.state === 'privacy') || prevHands !== nextShowHands) draw(true);
        else paintDeskLayer(dm, now, true);
      }
      if (busy) wakeDeskAnim();
    };
    deskTimer = setTimeout(step, wait);
  }

  function draw(deskDirty = true) {
    if (!view || !ctl) return;
    const now = Date.now();
    const dm = deskMode(now);
    const curState = ctl.stateOf(ctx(now));
    // 现在画的是哪只、在做什么：仅在变化时写属性，减少静止期 DOM 变更
    if (stage.dataset.pet !== view.pet) stage.dataset.pet = view.pet;
    if (stage.dataset.mode !== view.mode) stage.dataset.mode = view.mode;
    const phaseVal = view.phase || '';
    if (stage.dataset.phase !== phaseVal) stage.dataset.phase = phaseVal;
    const actVal = ctl.action || '';
    if (stage.dataset.action !== actVal) stage.dataset.action = actVal;
    if (stage.dataset.state !== curState) stage.dataset.state = curState;
    const subVal = String(view.subagents || 0);
    if (stage.dataset.subagents !== subVal) stage.dataset.subagents = subVal;
    // 打盹、睡着是宠物自己走到的，不一定有新的状态送来：提示跟着画面变
    const text = hintText();
    if (hint.textContent !== text) hint.textContent = text;
    if (custom()) {
      if (!canvas.hidden) canvas.hidden = true;
      if (themed()) {
        if (!img.hidden) img.hidden = true;
        if (svgHost.hidden) svgHost.hidden = false;
        const theme = themeView.theme, right = window.screenX + window.innerWidth / 2 > (screen.availLeft || 0) + screen.availWidth / 2;
        const pick = Theme.visualOf(theme, {
          action: dm.poseIdle ? null : ctl.action, serial: ctl.serial,
          state: dm.poseIdle ? 'idle' : curState,
          mode: dm.poseIdle ? 'idle' : view.mode,
          phase: dm.poseIdle ? null : view.phase,
          asking: dm.poseIdle ? 0 : view.asking,
          tasks: dm.poseIdle ? 0 : view.tasks,
          subagents: dm.poseIdle ? 0 : (view.subagents || 0),
          seed: workSeed, right, mini: themeMini(), peek: peeking, peekHold: peeking && now - peekAt >= Theme.peekHoldMs(theme),
        });
        const shownImg = themeView.show(pick.file, pick.once ? `${pick.file}#${ctl.serial}` : pick.key || pick.file, !!pick.mirror);
        if (stage.dataset.image !== shownImg) stage.dataset.image = shownImg;
        // 眼睛跟着鼠标：捂眼时先看正前方，平时跟鼠标
        if (desk?.covering) themeView.look(0, 0);
        else themeView.look(ctl.look.x / 2, ctl.look.y / 1.5);
      } else {
        if (!svgHost.hidden) svgHost.hidden = true;
        if (img.hidden !== !pack) img.hidden = !pack;
        const key = dm.poseIdle ? 'idle' : imageKey();
        if (stage.dataset.image !== key) stage.dataset.image = key;
        if (pack && key !== shownKey) { shownKey = key; img.src = pack.images[key] || pack.images.idle || ''; }
      }
      if (badge.hidden !== !view.badge) badge.hidden = !view.badge;
      if (view.badge) {
        const sub = view.subagents || 0;
        const badgeText = (view.quota == null ? '—' : `${view.quota}%`) + (view.tasks ? ` · ${view.tasks}${sub ? `+${sub}` : ''}` : '');
        const badgeClass = 'dp-badge' + (view.mood === 'ok' ? '' : ' ' + view.mood);
        if (badge.textContent !== badgeText) badge.textContent = badgeText;
        if (badge.className !== badgeClass) badge.className = badgeClass;
      }
      paintDeskLayer(dm, now, deskDirty);
      return;
    }
    if (canvas.hidden) canvas.hidden = false;
    if (!img.hidden) img.hidden = true;
    if (!svgHost.hidden) svgHost.hidden = true;
    if (!badge.hidden) badge.hidden = true;
    const baseCtx = { ...ctx(now), deskPaws: dm.show && dm.hands ? 'hide' : null };
    grid = dm.poseIdle
      ? Pet.drawPet(view.pet, { ...baseCtx, state: 'idle', phase: null, tasks: 0, subagents: 0, t: ctl.t, action: null, at: 0, look: desk?.covering ? { x: 0, y: 0 } : ctl.look, from: ctl.from, nervous: false })
      : ctl.frame(baseCtx);
    Pet.paint(canvas, grid, pixel);
    if (lastCursorIn && !dragging && !press) setHover(hitAt(lastCursorIn.x, lastCursorIn.y));
    paintDeskLayer(dm, now, deskDirty);
  }

  function hintText() {
    const left = view.quota == null ? L('还没有额度数据', 'No quota data yet') : L(`剩余 ${view.quota}%`, `${view.quota}% left`);
    const quota = (view.account ? view.account + ' ' : '') + left;
    if (view.mode === 'work') {
      const sub = view.subagents || 0;
      const asking = view.asking || 0, waiting = Math.max(0, (view.waiting || 0) - asking);
      const notes = [
        sub ? L(`含 ${sub} 个子代理`, `+${sub} subagent${sub === 1 ? '' : 's'}`) : '',
        asking ? L(`${asking} 个在问你`, `${asking} asking you`) : '',
        waiting ? L(`${waiting} 个可能在等你`, `${waiting} may need you`) : '',
      ].filter(Boolean);
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
    if (next.desk !== true || next.mini) desk?.resetInput(Date.now());
    desk?.setManualPrivacy(next.privacy === true, Date.now());
    setFrameCap(view.fps);
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
    if (themed()) {
      if (themeView.hit(lx, ly)) return true;
    } else if (lx >= 0 && ly >= 0 && lx < width && ly < height) {
      if (custom()) return true;
      if (grid) {
        const gx = Math.floor(lx / scale), gy = Math.floor(ly / scale);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const cx = gx + dx, cy = gy + dy;
          if (cx >= 0 && cy >= 0 && cx < Pet.W && cy < Pet.H && grid.c[cy * Pet.W + cx]) return true;
        }
      }
    }
    // 键鼠互动桌面开着时，点在像素桌面上也算命中宠物（方便拖走/点开气泡）
    if (Desk && deskCanvas && !deskCanvas.hidden) {
      const gx = lx / scale, gy = ly / scale;
      const [dx0, dy0, dx1, dy1] = Desk.DESK_HIT_BOX;
      if (gx >= dx0 && gx <= dx1 + 1 && gy >= dy0 && gy <= dy1 + 1) return true;
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

  document.addEventListener('mousemove', event => { lastCursorIn = { x: event.clientX, y: event.clientY }; if (!dragging) setHover(hitAt(event.clientX, event.clientY)); });
  document.addEventListener('mouseleave', () => { lastCursorIn = null; if (!dragging && !press) setHover(false); });
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
    clearTimeout(tapTimer); tapTimer = 0;
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
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      tapTimer = 0;
      if (dragging || press || clicks.settle(Date.now()) !== 1) return;
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
  api.onDeskPack?.(next => { deskPack = next || null; lastDeskSig = ''; draw(true); });
  api.onCursor(rel => {
    // 点击穿透时收不到 mousemove（主进程不再用 forward 的全局鼠标钩子）：用主进程轮询到的窗口内坐标判断鼠标在不在宠物身上。
    // 光标已经出了窗口范围（cx 为空）而还挂着 hover：漏掉的 mouseleave，补上
    if (rel.cx != null) lastCursorIn = { x: rel.cx, y: rel.cy };
    else lastCursorIn = null;
    if (!dragging && !press) {
      if (rel.cx != null) setHover(hitAt(rel.cx, rel.cy));
      else if (hovering) setHover(false);
    }
    if (!ctl) return;
    // 鼠标位置是按屏幕算的：宠物贴左边时左右翻着、倒挂时上下左右都反着，眼睛要反过来看
    const edge = edgeOf();
    const prevLookX = ctl.look.x, prevLookY = ctl.look.y;
    ctl.aim(edge === 'left' || edge === 'top' ? -rel.x : rel.x, edge === 'top' ? -rel.y : rel.y);
    let interruptedFidget = false;
    if (desk && view?.desk === true && !view.mini && rel.mx != null && rel.my != null) {
      const now = Date.now();
      if (desk.onMouseMove(rel.mx, rel.my, now)) {
        if (desk.isUserActive(now)) {
          if (ctl.isFidgetAction()) interruptedFidget = true;
          ctl.noteInput(now);
        }
        wakeDeskAnim();
      }
    }
    let dizzy = false;
    if (!canDizzy()) spin.reset();
    else if (spin.add(rel.x, rel.y)) { ctl.trigger('dizzy'); dizzy = true; }
    if (dizzy || interruptedFidget) {
      draw(true);
      return;
    }
    // 高频光标事件不再每帧同步重绘整张 #dp-desk 画布（由按 petFps 限帧的 wakeDeskAnim 驱动），
    // 仅即时更新眼睛朝向，大幅降低 300Hz 透明置顶窗的 GPU/DWM 合成开销。
    if (themed()) {
      if (desk?.covering) themeView.look(0, 0);
      else themeView.look(ctl.look.x / 2, ctl.look.y / 1.5);
    } else if (!custom() && (ctl.look.x !== prevLookX || ctl.look.y !== prevLookY)) {
      const now = Date.now();
      const dm = deskMode(now);
      const baseCtx = { ...ctx(now), deskPaws: dm.show && dm.hands ? 'hide' : null };
      grid = dm.poseIdle
        ? Pet.drawPet(view.pet, { ...baseCtx, state: 'idle', phase: null, tasks: 0, subagents: 0, t: ctl.t, action: null, at: 0, look: desk?.covering ? { x: 0, y: 0 } : ctl.look, from: ctl.from, nervous: false })
        : ctl.frame(baseCtx);
      Pet.paint(canvas, grid, pixel);
    }
  });
  api.onInput?.(event => {
    if (!event || !desk) return;
    if (view && (view.desk !== true || view.mini) && !(event.type === 'password' && !event.active)) return;
    const now = Date.now();
    let dirty = false;
    if (event.type === 'password') dirty = desk.setPassword(event.active, now);
    else if (event.type === 'key') dirty = desk.onKey(event, now);
    else if (event.type === 'keyup') dirty = desk.onKeyUp(event, now);
    else if (event.type === 'mouse') dirty = desk.onMouseButton(event.left, event.right, now);
    if (view && ctl) {
      // 任何真实键盘/鼠标点击（包括密码框期间的打字与进入密码框）都刷新活跃计时、延后并立刻打断随机待机动画
      if (event.type === 'key' || (event.type === 'mouse' && (event.left || event.right)) || (event.type === 'password' && event.active)) {
        ctl.noteInput(now);
        if (event.type !== 'password') ctl.rouse();
      }
      if (dirty) {
        draw(true);
        wakeDeskAnim();
      }
    }
  });
  window.addEventListener('resize', () => {
    if (view && (window.devicePixelRatio || 1) !== lastDpr) { size(); draw(true); }
    layout();
  });
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
  api.ready().then(data => { deskPack = data?.deskPack || null; setPack(data?.pack || null); apply(data?.view); }).catch(() => undefined);

  /*
   * CSS 动画限帧：主题包宠物的 SVG 自带无限循环的 CSS 动画（呼吸、眨眼、蹦跳），极简模式倒挂时舞台在摆，眼睛跟鼠标用很短的 transition。
   * 浏览器按显示器刷新率画这些动画：用户的屏幕是 300 Hz，这个透明、置顶的窗口就每秒重画 300 次，Windows 也要跟着每秒重新合成 300 次
   * （实测 GPU 进程常驻约 30% 单核、宠物窗口约 35%），鼠标跟着一顿一顿（2026-11-09 用户反馈，关掉桌宠就好）。
   * 这里把窗口里所有动画（含主题 SVG 所在的 Shadow DOM）接过来：一出现就暂停，再按每秒 petFps 帧手动推进时间。
   * 动画本身的节奏不变，只是每秒画的次数封顶；像素画 30 帧看不出区别。窗口藏起来时不推进。
   * 帧率在桌宠设置里选（30 / 60 / 120，默认 30），随状态一起送来（view.fps）。
   */
  const FPS_CHOICES = [30, 60, 120];
  let petFps = 30, capTimer = null;
  const adopted = new WeakMap();
  const timelineNow = () => document.timeline.currentTime ?? performance.now();
  function adopt(animation) {
    if (adopted.has(animation)) return;
    // 记下它在文档时间线上「从哪一刻开始」：之后 currentTime = 现在 - 起点，节奏和自己播放时一样
    adopted.set(animation, timelineNow() - (animation.currentTime ?? 0));
    try { animation.pause(); } catch { /* 已经被取消了 */ }
  }
  function petAnimations() {
    const list = document.getAnimations();
    const inner = svgHost.shadowRoot?.getAnimations?.() || [];
    for (const animation of inner) if (!list.includes(animation)) list.push(animation);
    return list;
  }
  function stepAnimations() {
    if (document.visibilityState === 'hidden') return;
    const now = timelineNow();
    for (const animation of petAnimations()) {
      adopt(animation);
      const at = now - adopted.get(animation);
      // 放完了的一次性动画停在最后一格，不再每格去碰它
      const end = animation.effect?.getComputedTiming?.().endTime;
      if (Number.isFinite(end) && at >= end && (animation.currentTime ?? 0) >= end) continue;
      if (animation.currentTime !== at) try { animation.currentTime = Number.isFinite(end) ? Math.min(at, end) : at; } catch { /* 已经被取消了 */ }
    }
  }
  // 新动画一出现就接过来（鼠标在动时眼睛的 transition 一直在换新的），不让它先按 300 Hz 跑到下一格
  const onAnimationStart = event => { for (const animation of event.target.getAnimations?.() || []) adopt(animation); };
  for (const target of [document, svgHost.shadowRoot].filter(Boolean)) {
    target.addEventListener('animationstart', onAnimationStart, true);
    target.addEventListener('transitionrun', onAnimationStart, true);
  }
  function setFrameCap(fps) {
    const next = FPS_CHOICES.includes(Number(fps)) ? Number(fps) : 30;
    if (capTimer && next === petFps) return;
    petFps = next;
    clearInterval(capTimer);
    capTimer = setInterval(stepAnimations, Math.round(1000 / petFps));
  }
  setFrameCap(30);
  // 测试用：看现在接管了几个动画、帧率上限多少
  window.__petFrameCap = { get fps() { return petFps; }, adopted: () => petAnimations().filter(animation => adopted.has(animation) && animation.playState === 'paused').length, total: () => petAnimations().length };

  // 每秒 10 帧；系统开了「减少动画」时每秒 2 帧、不做随机小动作。窗口被藏起来的时候不画；静止时跳过桌面重绘保持零空转
  let last = 0;
  setInterval(() => {
    if (!view || !ctl || document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (reduced.matches && now - last < 500) return;
    last = now;
    ctl.tick(ctx(), now);
    const deskBusy = desk ? desk.step(now, reduced.matches) : false;
    draw(deskBusy);
  }, 100);
  // 调试/测试用：暴露当前桌宠键鼠桌面状态快照（不含任何隐私历史，仅瞬时在屏渲染态）
  window.__petDesk = {
    state: () => ({
      visible: !!deskCanvas && !deskCanvas.hidden,
      desk: stage.dataset.desk || '',
      style: view?.deskStyle || 'white',
      deskPackId: deskPack?.id || '',
      hands: stage.dataset.deskHands === '1',
      hiddenThemeHands: hiddenThemeHands.length,
      covering: !!desk?.covering,
      passwordActive: !!desk?.passwordActive,
      manualPrivacy: !!desk?.manualPrivacy,
      floats: (desk?.floats || []).map(f => f.key),
      heldKeys: desk ? desk.heldKeys.size : 0,
      mouse: desk ? desk.mousePos() : null,
      mouseLeft: !!desk?.mouseLeft,
      mouseRight: !!desk?.mouseRight,
      customColor,
      crabHint,
    }),
  };
})();
