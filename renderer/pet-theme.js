'use strict';
/*
 * 主题包宠物（Clawd on Desk 格式）的画法：桌宠窗口（desk-pet.js）用。
 *
 * 主进程送来收好的 theme 和每个动画（SVG 是消毒过的文字，位图是 data URL，见 core/pet-pack.ts）。
 * SVG 放进一个 Shadow DOM 里：动画自带的 CSS 只管得到它自己，眼睛、身体、影子这几个元素能直接挪（eyeTracking）。
 * 换动画就换一个节点（一次性的动画重新插进去，从头放）；同一个动画不重插。
 *
 * 坐标：主题的坐标（SVG 用户单位）按 k 倍放到舞台上，身体框（layout.contentBox）大约占满舞台、脚底线（baselineY）贴着舞台底边。
 * 舞台就是内置宠物的 72 × 56 格乘放大倍数。
 */
(function (root) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  /** 眼睛、身体、影子跟着鼠标挪时的过渡时长（毫秒）。 */
  const FOLLOW_MS = 60;

  class ThemeView {
    constructor(host) {
      this.host = host;
      this.shadow = host.attachShadow({ mode: 'open' });
      this.pack = null; this.parsed = new Map();
      this.node = null; this.file = ''; this.key = ''; this.eyes = null;
      this.stage = { w: 0, h: 0, scale: 1 }; this.k = 1; this.ox = 0; this.oy = 0;
    }

    /** 换了主题（null：不是主题宠物）。 */
    load(pack) {
      this.pack = pack && pack.kind === 'theme' && pack.theme && pack.files ? pack : null;
      this.parsed.clear(); this.key = ''; this.file = ''; this.node = null; this.eyes = null;
      this.shadow.replaceChildren();
      this.fit();
    }
    get ready() { return !!this.pack; }
    get theme() { return this.pack?.theme; }

    /** 舞台大小（CSS 像素）和放大倍数。 */
    layout(w, h, scale) {
      this.stage = { w, h, scale };
      this.host.style.width = w + 'px'; this.host.style.height = h + 'px';
      this.fit();
      if (this.node) this.place(this.node, this.file);
    }
    fit() {
      const t = this.theme;
      if (!t || !this.stage.w) return;
      const cb = t.layout.contentBox;
      this.k = Math.min(this.stage.w * 0.8 / cb.width, this.stage.h * 0.9 / cb.height);
      this.ox = this.stage.w / 2 - t.layout.centerX * this.k;
      this.oy = this.stage.h - 2 * this.stage.scale - t.layout.baselineY * this.k;
    }
    /** 主题坐标 → 舞台像素。 */
    at(x, y) { return { x: this.ox + x * this.k, y: this.oy + y * this.k }; }

    /** 这个文件的画面范围（主题坐标）：fileViewBoxes 优先，再看 SVG 自己写的 viewBox，最后用主题的。 */
    viewBoxOf(file, node) {
      const t = this.theme, own = t.fileViewBoxes?.[file];
      if (own) return own;
      const attr = node?.getAttribute?.('viewBox')?.trim().split(/[\s,]+/).map(Number);
      if (attr && attr.length === 4 && attr.every(Number.isFinite) && attr[2] > 0 && attr[3] > 0) return { x: attr[0], y: attr[1], width: attr[2], height: attr[3] };
      return t.viewBox;
    }

    /** 解析一次，之后每次复制一份用。解析不出来（不该发生，主进程消毒过）返回 null。 */
    template(file) {
      if (this.parsed.has(file)) return this.parsed.get(file);
      const item = this.pack.files[file];
      let node = null;
      if (item?.svg) {
        const doc = new DOMParser().parseFromString(item.svg, 'image/svg+xml');
        const top = doc.documentElement;
        if (top && top.nodeName === 'svg' && !doc.getElementsByTagName('parsererror').length) node = document.importNode(top, true);
      } else if (item?.src) {
        node = document.createElement('img');
        node.src = item.src; node.alt = ''; node.draggable = false;
      }
      this.parsed.set(file, node);
      return node;
    }

    place(node, file) {
      const vb = this.viewBoxOf(file, node.tagName === 'img' ? null : node), p = this.at(vb.x, vb.y);
      const s = node.style;
      s.position = 'absolute'; s.left = p.x + 'px'; s.top = p.y + 'px'; s.width = vb.width * this.k + 'px'; s.height = vb.height * this.k + 'px';
      s.overflow = 'visible'; s.pointerEvents = 'none'; s.userSelect = 'none';
      if (node.tagName === 'img') { s.objectFit = 'contain'; s.imageRendering = 'pixelated'; }
      else { node.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`); node.removeAttribute('width'); node.removeAttribute('height'); }
    }

    /**
     * 显示 file。key 一样就不动；key 变了但文件一样（同一个一次性动画又来一次）也重插，让它从头放。
     * mirror：左右翻过来放（随机待机写了 mirrorOnRightSide、宠物又在屏幕右半边）。返回真的显示出来的文件（解析失败的退回 idle）。
     */
    show(file, key = file, mirror = false) {
      if (!this.pack) return '';
      if (mirror) key += '#mirror';
      if (key === this.key && this.node) return this.file;
      let use = file, tpl = this.template(file);
      if (!tpl) { use = this.theme.states.idle[0]; tpl = this.template(use); mirror = false; }
      if (!tpl) return '';
      const node = tpl.cloneNode(true);
      this.place(node, use);
      if (mirror) node.style.transform = 'scaleX(-1)';
      this.shadow.replaceChildren(node);
      this.node = node; this.file = use; this.key = key;
      this.eyes = this.trackable(use) ? this.findEyes(node) : null;
      return use;
    }

    /** 眼睛跟随只给待机（states.idle 的第一个，也就是会看人的那个）、打盹和极简模式待着（mini-idle）的动画，主题的 eyeTracking.states 里写了才算。 */
    trackable(file) {
      const e = this.theme.eyeTracking;
      if (!e) return false;
      const t = this.theme.states, mini = this.theme.miniMode?.states;
      return (e.states.includes('idle') && t.idle?.[0] === file) || (e.states.includes('dozing') && !!t.dozing?.includes(file)) || (e.states.includes('mini-idle') && !!mini?.['mini-idle']?.includes(file));
    }
    findEyes(node) {
      if (node.tagName === 'img') return null;
      const ids = this.theme.eyeTracking.ids, get = id => node.querySelector('#' + CSS.escape(id));
      const found = { eyes: get(ids.eyes) || get(ids.dozeEyes), body: get(ids.body), shadow: get(ids.shadow) };
      if (found.shadow && this.theme.eyeTracking.shadowOrigin) found.shadow.style.transformOrigin = this.theme.eyeTracking.shadowOrigin;
      // 动画自带的 transition 多半是 0.2 秒以上，鼠标一直在动时每次都从头滑、总落后一截：换成很短的，只把一格一格的跳变抹平
      for (const el of [found.eyes, found.body, found.shadow]) if (el) el.style.transition = `transform ${FOLLOW_MS}ms ease-out`;
      return found.eyes || found.body ? found : null;
    }

    /**
     * 往哪看：x、y 是 -1 ~ 1（鼠标在左 / 右、上 / 下多远，宠物窗口按鼠标位置算）。眼睛横着最多挪 maxOffset 个单位、竖着一半，
     * 按整数单位挪（像素画）；身体跟着挪 bodyScale 倍，影子往那边拉长一点。过渡只有 FOLLOW_MS，几乎是立刻到位。
     */
    look(x, y) {
      if (!this.eyes) return;
      const e = this.theme.eyeTracking, m = e.maxOffset;
      const dx = Math.round(clamp(x, -1, 1) * m), dy = Math.round(clamp(y, -1, 1) * m * 0.5);
      const set = (el, value) => { if (el && el.style.transform !== value) el.style.transform = value; };
      set(this.eyes.eyes, `translate(${dx}px, ${dy}px)`);
      set(this.eyes.body, `translate(${dx * e.bodyScale}px, ${dy * e.bodyScale}px)`);
      set(this.eyes.shadow, `translate(${dx * e.shadowShift}px, 0px) scaleX(${1 + Math.abs(dx) / (m || 1) * e.shadowStretch})`);
      this.lookAt = { dx, dy };
    }

    /** 现在这个动画的点击范围（主题坐标）：fileHitBoxes → 宽 / 睡觉的那几个 → default → 身体框。 */
    hitBox() {
      const t = this.theme, f = this.file, hb = t.hitBoxes || {};
      const cb = t.layout.contentBox;
      return t.fileHitBoxes?.[f] || (t.wideHitboxFiles?.includes(f) && hb.wide) || (t.sleepingHitboxFiles?.includes(f) && hb.sleeping) || hb.default || { x: cb.x, y: cb.y, w: cb.width, h: cb.height };
    }
    /** 舞台坐标 (x, y) 在不在宠物身上（四周放宽一个放大倍数）。 */
    hit(x, y) {
      if (!this.pack) return false;
      const b = this.hitBox(), p = this.at(b.x, b.y), pad = this.stage.scale;
      return x >= p.x - pad && y >= p.y - pad && x <= p.x + b.w * this.k + pad && y <= p.y + b.h * this.k + pad;
    }
    /**
     * 极简模式下舞台的 left（窗口右边就是屏幕右边）：画面宽度的 miniMode.offsetRatio 藏到窗口右边外面，
     * 探出来时再往外滑 peek.offsetRatio。主题没有极简动画返回 null（照内置宠物那样歪着探头）。
     */
    miniLeft(winWidth, peeking) {
      const m = this.theme?.miniMode;
      if (!m) return null;
      const vb = this.theme.viewBox, edge = this.at(vb.x + vb.width * (1 - m.offsetRatio), 0).x;
      return Math.round(winWidth - edge - (peeking ? m.peek.offsetRatio * vb.width * this.k : 0));
    }
    /** 身体框，换成内置宠物那套格子 [左, 上, 右, 下]（极简模式探头时按它算轴心和探出多少）。 */
    bodyCells() {
      const cb = this.theme.layout.contentBox, s = this.stage.scale, a = this.at(cb.x, cb.y), b = this.at(cb.x + cb.width, cb.y + cb.height);
      return [a.x / s, a.y / s, b.x / s - 1, b.y / s - 1];
    }
  }

  /** 随机待机的动作名：idle:0、idle:1……（第几个 idleAnimations）。 */
  const IDLE_ACTION = /^idle:(\d+)$/;

  /**
   * 动作、状态 → 主题里的哪个动画。按顺序找，主题没有的往后退，最后是 idle。
   * once：一次性的（反应、庆祝、出错……），再来一次要从头放。mirror：左右翻过来放。
   *
   * s 里：action / serial / state（Controller 的）、mode / phase / asking / tasks（主进程的）、subagents（在跑的子代理数）、
   * seed（进入干活时抽的随机数：一个档位有好几个动画时挑哪个，同一段干活里不换）、right（宠物在屏幕右半边）、
   * mini（极简模式）、peek（极简模式下探出来了）、peekHold（探出来超过 mini-peek 的时长了）。
   *
   * 干活时的优先级：在问你（notification）> 有子代理（jugglingTiers / juggling）> 思考 / 干活（workingTiers 按任务数）。
   */
  function visualOf(theme, s) {
    if (s.mini && theme.miniMode) return miniOf(theme, s);
    const st = theme.states, re = theme.reactions;
    const pickOf = list => list && list.length ? list[(s.serial || 0) % list.length] : null;
    const state = name => pickOf(st[name]);
    const reaction = name => pickOf(re[name]?.files);
    const seeded = list => list && list.length ? list[(s.seed || 0) % list.length] : null;
    const tierOf = (tiers, n) => seeded(tiers.find(item => n >= item.minSessions)?.files);
    const work = () => tierOf(theme.workingTiers, s.tasks || 0) || seeded(st.working);
    const juggle = () => (s.subagents > 0 ? tierOf(theme.jugglingTiers, s.subagents) || seeded(st.juggling) : null);
    const first = (...list) => list.find(Boolean) || st.idle[0];
    const a = s.action;
    const idle = IDLE_ACTION.exec(a || '');
    if (idle) {
      const item = theme.idleAnimations[Number(idle[1])];
      return item ? { file: item.file, once: true, mirror: !!(item.mirrorOnRightSide && s.right) } : { file: st.idle[0], once: false };
    }
    if (a === 'drag') return { file: first(reaction('drag'), state('notification')), once: false };
    if (a === 'poke') return { file: first(reaction('double'), reaction('annoyed')), once: true };
    if (a === 'lookaround') return { file: first(reaction('annoyed'), reaction('double')), once: true };
    if (a === 'tapLeft' || a === 'tapRight') return { file: first(reaction(a === 'tapLeft' ? 'clickLeft' : 'clickRight')), once: true };
    if (a === 'dizzy') return { file: first(state('dizzy')), once: true };
    if (a === 'error') return { file: first(state('error')), once: true };
    if (a === 'celebrate' || a === 'restock') return { file: first(state('attention')), once: true };
    if (a === 'startle' || a === 'wake') return { file: first(state('waking')), once: false, key: 'waking' };
    if (a === 'yawn') return { file: first(state('yawning'), state('dozing')), once: true };
    if (a === 'flop') return { file: first(state('collapsing'), state('sleeping')), once: true };
    if (a === 'wave') return { file: first(state('notification'), state('attention')), once: true };
    if (s.state === 'sleep') return { file: first(st.sleeping?.[0], st.dozing?.[0]), once: false };
    if (s.state === 'doze') return { file: first(st.dozing?.[0], st.sleeping?.[0]), once: false };
    if (s.mode === 'work') {
      if (s.asking) return { file: first(st.notification?.[0], juggle(), work()), once: false };
      const busy = juggle();
      if (busy) return { file: busy, once: false };
      if (s.phase === 'thinking') return { file: first(st.thinking?.[0], work()), once: false };
      return { file: first(work(), st.thinking?.[0]), once: false };
    }
    return { file: st.idle[0], once: false };
  }

  /**
   * 极简模式（贴屏幕右边）：用 miniMode.states 的动画，没写的往 mini-idle 退。
   * 进来时放 mini-enter（睡着进来放 mini-enter-sleep）；庆祝 mini-happy；出错、在问你、吓一跳 mini-alert；
   * 鼠标移上来探头 mini-peek，放够 autoReturn 的时长后换成 mini-peek-hold（没有就回 mini-idle）；
   * 睡觉 mini-sleep（鼠标移上来时有 mini-sleep-peek 就用它）；干活 mini-working（没有就 mini-idle）。
   */
  function miniOf(theme, s) {
    const m = theme.miniMode.states, a = s.action;
    const pick = list => list && list.length ? list[(s.serial || 0) % list.length] : null;
    const one = (...names) => names.map(name => pick(m[name])).find(Boolean) || m['mini-idle'][0];
    const asleep = s.state === 'sleep' || s.state === 'doze';
    if (a === 'miniEnter') return { file: asleep ? one('mini-enter-sleep', 'mini-enter') : one('mini-enter'), once: true };
    if (a === 'celebrate' || a === 'restock') return { file: one('mini-happy', 'mini-alert'), once: true };
    if (a === 'wave' || a === 'error' || a === 'startle' || a === 'poke' || a === 'lookaround') return { file: one('mini-alert'), once: true };
    if (asleep) return { file: s.peek ? one('mini-sleep-peek', 'mini-sleep') : one('mini-sleep'), once: false };
    if (s.peek) return s.peekHold ? { file: one('mini-peek-hold'), once: false } : { file: one('mini-peek'), once: false, key: 'mini-peek' };
    if (s.mode === 'work') return { file: one('mini-working'), once: false };
    return { file: one(), once: false };
  }

  /** 主题写的动画时长换成 Controller 的帧数（每秒 10 帧）；没写的不改。随机待机 idle:N 按各自的时长。 */
  function durations(theme) {
    const frames = ms => (ms > 0 ? Math.max(5, Math.round(ms / 100)) : undefined);
    const re = theme.reactions, back = theme.timings.autoReturn || {}, miniBack = theme.miniMode?.timings?.autoReturn || {};
    const out = {
      poke: frames(re.double?.duration), lookaround: frames(re.annoyed?.duration), tapLeft: frames(re.clickLeft?.duration), tapRight: frames(re.clickRight?.duration),
      dizzy: frames(back.dizzy), error: frames(back.error), celebrate: frames(back.attention), wave: frames(back.notification),
      yawn: frames(theme.timings.yawnDuration), wake: frames(theme.timings.wakeDuration),
      miniEnter: frames(miniBack['mini-enter']) || 15,
    };
    theme.idleAnimations.forEach((item, i) => { out['idle:' + i] = frames(item.duration); });
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
  }
  /** 极简模式探出来多久后从 mini-peek 换成 mini-peek-hold（毫秒）。 */
  function peekHoldMs(theme) { return theme.miniMode?.timings?.autoReturn?.['mini-peek'] || 2000; }

  root.PulsePetTheme = { ThemeView, visualOf, durations, peekHoldMs, IDLE_ACTION };
})(typeof window !== 'undefined' ? window : globalThis);
