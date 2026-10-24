'use strict';
/*
 * 桌宠的像素画（0.3.61）。桌宠窗口（desk-pet.js）和「桌宠」设置页的预览共用。
 *
 * 72×56 的像素格，每帧按状态现画：形状用椭圆、线段拼，每一层自己描边、底边和右边自动加深；
 * 三只宠物（松鼠栗栗、仓鼠豆豆、章鱼墨墨）各有坐着的样子、干活的样子、睡觉、庆祝、受惊、被拎起来、补满额度和几个随机小动作。
 * 输入 ctx：state（idle / work / sleep）、quota（剩余百分比）、mood（ok / tight / empty，不给就按 quota 算）、tasks（在跑的任务数）、
 * t（全局帧）、action / at（正在做的动作和做到第几帧）、look（眼睛看的方向）、from（补满额度前的剩余）。
 * 动作的节奏在 Controller 里：tick() 每帧调用一次（每秒 10 帧）。
 */
(function (root) {
  const W = 72, H = 56;
  function grid() { return { c: new Array(W * H).fill(null), m: new Uint8Array(W * H) }; }
  function put(g, x, y, col, body) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = y * W + x; g.c[i] = col; if (body) g.m[i] = 1;
  }
  function ell(g, cx, cy, rx, ry, col, body = true) {
    if (rx <= 0 || ry <= 0) return;
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) put(g, x, y, col, body);
      }
  }
  function rect(g, x, y, w, h, col, body = false) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(g, x + i, y + j, col, body); }
  function line(g, x0, y0, x1, y1, col, body = false) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let k = 0; k <= n; k++) put(g, Math.round(x0 + (x1 - x0) * k / n), Math.round(y0 + (y1 - y0) * k / n), col, body);
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // Darken the bottom/right rim of each filled shape, then outline it; every layer gets its own outline so parts stay readable.
  function shade(g, map) {
    const out = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (g.m[i] !== 1) continue;
      const s = map[g.c[i]]; if (!s) continue;
      if ((y < H - 1 ? g.m[i + W] : 0) !== 1 || (x < W - 1 ? g.m[i + 1] : 0) !== 1) out.push([i, s]);
    }
    for (const [i, s] of out) g.c[i] = s;
  }
  function outline(g, col) {
    const out = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (g.m[i]) continue;
      if ((x > 0 && g.m[i - 1] === 1) || (x < W - 1 && g.m[i + 1] === 1) || (y > 0 && g.m[i - W] === 1) || (y < H - 1 && g.m[i + W] === 1)) out.push(i);
    }
    for (const i of out) { g.c[i] = col; g.m[i] = 2; }
  }
  function layer(g, ol, sh, draw) {
    const l = grid(); draw(l);
    if (sh) shade(l, sh);
    if (ol) outline(l, ol);
    for (let i = 0; i < W * H; i++) if (l.c[i]) g.c[i] = l.c[i];
  }
  function hash(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return (h ^ (h >>> 16)) >>> 0; }
  // Grow a few edge pixels outward so fur reads as fluffy instead of a perfect ellipse.
  function fluff(l, every, sx = 0, sy = 0) {
    const add = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x; if (l.m[i] !== 1) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, -1]]) {
        const j = i + dy * W + dx;
        if (!l.m[j] && hash(x - sx + dx * 7, y - sy + dy * 3) % every === 0) add.push([j, l.c[i]]);
      }
    }
    for (const [j, c] of add) { l.c[j] = c; l.m[j] = 1; }
  }
  function sprite(g, rows, pal, x, y, ol, sh) {
    layer(g, ol, sh, l => rows.forEach((r, j) => [...r].forEach((ch, i) => { if (pal[ch]) put(l, x + i, y + j, pal[ch], true); })));
  }
  function mirrorInto(g, axis, draw) {
    const T = grid(); draw(T);
    for (let i = 0; i < W * H; i++) if (T.c[i]) put(g, 2 * axis - 1 - (i % W), Math.floor(i / W), T.c[i]);
  }
  function path(l, pts, col, steps = 3) {
    for (let k = 0; k < pts.length - 1; k++) for (let s = 0; s < steps; s++) {
      const u = s / steps, a = pts[k], b = pts[k + 1], r = a[2] + (b[2] - a[2]) * u;
      ell(l, a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, r, r, col);
    }
    const e = pts[pts.length - 1]; ell(l, e[0], e[1], e[2], e[2], col);
  }
  function curveArm(l, b, c, e, r0, r1, col, t) {
    for (let j = 0; j <= 18; j++) {
      const u = j / 18, A = (1 - u) * (1 - u), B = 2 * u * (1 - u), C = u * u, r = r0 + (r1 - r0) * u;
      ell(l, A * b[0] + B * c[0] + C * e[0] + Math.sin(t * 0.9 + j * 0.6) * 0.5 * u, A * b[1] + B * c[1] + C * e[1], r, r, col);
    }
  }

  /* ---------- effects ---------- */
  const Z4 = ['1111', '0010', '0100', '1111'], Z5 = ['11111', '00010', '00100', '01000', '11111'];
  function glyph(g, rows, x, y, col) { rows.forEach((r, j) => [...r].forEach((b, i) => { if (b === '1') put(g, x + i, y + j, col); })); }
  function zzz(g, x, y, t) { const k = (t >> 2) % 5, c = '#8C97B0'; if (k < 4) glyph(g, Z4, x, y - k, c); if (k > 0) glyph(g, Z5, x + 5, y - 6 - k, c); }
  function sparkle(g, x, y, big) {
    const c = '#FFC93C'; put(g, x, y, '#FFF4C2');
    for (let k = 1; k <= (big ? 2 : 1); k++) { put(g, x + k, y, c); put(g, x - k, y, c); put(g, x, y + k, c); put(g, x, y - k, c); }
  }
  function sparkles(g, t, pts) { pts.forEach(([x, y], i) => { if ((t + i * 2) % 7 < 5) sparkle(g, x, y, (t + i * 2) % 7 < 2); }); }
  function sweat(g, x, y) {
    layer(g, '#2B6A9C', null, l => { put(l, x, y, '#9AD8FF', true); for (let i = -1; i <= 1; i++) { put(l, x + i, y + 1, '#9AD8FF', true); put(l, x + i, y + 2, '#9AD8FF', true); } put(l, x, y + 3, '#5DB2EC', true); });
    put(g, x - 1, y + 1, '#FFFFFF');
  }
  function heart(g, x, y) {
    layer(g, '#7A1F33', null, l => ['11011', '11111', '01110', '00100'].forEach((r, j) => [...r].forEach((b, i) => { if (b === '1') put(l, x + i, y + j, '#FF5C7C', true); })));
    put(g, x, y, '#FFB3C2');
  }
  function bubble(g, x, y, o) {
    layer(g, o, null, l => { rect(l, x, y, 11, 6, '#FFFFFF', true); put(l, x + 2, y + 6, '#FFFFFF', true); });
    for (let i = 0; i < 3; i++) put(g, x + 3 + i * 2, y + 3, '#6B7280');
  }
  function exclaim(g, x, y) { layer(g, '#6B4500', null, l => { rect(l, x, y, 2, 5, '#FFD84A', true); rect(l, x, y + 7, 2, 2, '#FFD84A', true); }); }
  // 东张西望时头顶的问号；被戳时的「气鼓鼓」十字
  function question(g, x, y) { layer(g, '#6B4500', null, l => ['0110', '1001', '0001', '0010', '0100', '0000', '0100'].forEach((r, j) => [...r].forEach((b, i) => { if (b === '1') put(l, x + i, y + j, '#FFD84A', true); }))); }
  function anger(g, x, y) { layer(g, '#7A1F1F', null, l => ['01010', '11011', '00000', '11011', '01010'].forEach((r, j) => [...r].forEach((b, i) => { if (b === '1') put(l, x + i, y + j, '#FF6B6B', true); }))); }
  /** 地面上的影子：身体朝鼠标那边歪的时候，影子往那边拉长一点。 */
  function shadow(g, cx, lean, y = 54.6) { ell(g, cx + lean * 1.5, y, 13 + Math.abs(lean) * 1.6, 1.7, 'rgba(20,24,32,0.18)', false); }
  function dust(g, x, y, k) { const c = '#C3C9D3'; for (const s of [-1, 1]) { put(g, x + s * (10 + k * 2), y - (k > 2 ? 1 : 0), c); put(g, x + s * (11 + k * 2), y - 1 - (k > 3 ? 1 : 0), c); if (k < 4) put(g, x + s * (9 + k), y, c); } }
  function confetti(g, at) {
    const cols = ['#FF6B8B', '#FFC93C', '#5BD08F', '#6FA8FF', '#C78BFF'];
    for (let k = 0; k < 16; k++) { const y = ((at * 1.6 + hash(k, 3) % 46) % 52) - 4; put(g, (hash(k, 7) % (W - 4)) + 2 + Math.round(Math.sin((at + k) * 0.5)), y, cols[k % 5]); }
  }
  function ring(g, x, y, r) {
    const c = '#BFE6FF';
    if (r <= 1) { put(g, x - 1, y, c); put(g, x + 1, y, c); put(g, x, y - 1, c); put(g, x, y + 1, c); return; }
    for (let yy = -3; yy <= 3; yy++) for (let xx = -3; xx <= 3; xx++) { const d = Math.hypot(xx, yy); if (d > r - 0.6 && d < r + 0.5) put(g, x + xx, y + yy, c); }
    put(g, x - 1, y - 1, '#FFFFFF');
  }
  // Eyes: x,y = top-left of a w×h eye box.
  function eye(g, x, y, w, h, mode, P) {
    switch (mode) {
      case 'open': rect(g, x, y, w, h, P.eye); put(g, x, y, P.w); if (h > 3) put(g, x, y + 1, P.w); put(g, x + w - 1, y + h - 1, P.eyeL); break;
      case 'half': rect(g, x, y + 1, w, 1, P.o); rect(g, x, y + 2, w, h - 2, P.eye); put(g, x, y + 2, P.w); break;
      case 'tired': rect(g, x, y + 1, w, 1, P.o); rect(g, x, y + 2, w, Math.max(1, h - 3), P.eye); break;
      case 'blink': rect(g, x, y + h - 2, w, 1, P.o); break;
      case 'closed': put(g, x, y + h - 2, P.o); for (let i = 1; i < w - 1; i++) put(g, x + i, y + h - 1, P.o); put(g, x + w - 1, y + h - 2, P.o); break;
      case 'happy': put(g, x, y + 2, P.o); for (let i = 1; i < w - 1; i++) put(g, x + i, y + 1, P.o); put(g, x + w - 1, y + 2, P.o); break;
      case 'wide': layer(g, P.o, null, l => ell(l, x + w / 2, y + h / 2, w / 2 + 0.8, h / 2 + 0.8, P.w)); rect(g, x + Math.floor((w - 1) / 2), y + 1, w > 3 ? 2 : 1, h - 2, P.eye); break;
      // 被戳时眯成 > <：左眼尖朝右、右眼尖朝左
      case 'squeezeL': case 'squeezeR': {
        const m = Math.max(1, Math.floor(h / 2));
        for (let i = 0; i <= m; i++) { const d = Math.round(i * (w - 1) / m), xx = mode === 'squeezeL' ? x + d : x + w - 1 - d; put(g, xx, y + i, P.o); put(g, xx, y + h - 1 - i, P.o); }
        break;
      }
    }
  }
  /** 两只眼睛一起画；squeeze 拆成左右两种。 */
  function eyes2(g, lx, rx, y, w, h, mode, P) {
    eye(g, lx, y, w, h, mode === 'squeeze' ? 'squeezeL' : mode, P);
    eye(g, rx, y, w, h, mode === 'squeeze' ? 'squeezeR' : mode, P);
  }
  function brows(g, l, r, w, y, kind, col) {
    for (let i = 0; i < w; i++) {
      const up = (i >= w / 2) === (kind === 'worry') ? 1 : 0;
      put(g, l + i, y - up, col); put(g, r + w - 1 - i, y - up, col);
    }
  }
  function mouthAt(g, F, my, kind, P, yawn, teeth) {
    const o = P.o, dots = pts => pts.forEach(([x, y]) => put(g, F + x, my + y, o));
    switch (kind) {
      case 'smile': dots([[-3, 0], [-2, 1], [-1, 0], [0, 0], [1, 1], [2, 0]]); if (teeth) { put(g, F - 1, my + 1, P.w); put(g, F, my + 1, P.w); } break;
      case 'small': dots([[-1, 0], [0, 0]]); if (teeth) { put(g, F - 1, my + 1, P.w); put(g, F, my + 1, P.w); } break;
      case 'flat': dots([[-2, 0], [-1, 0], [0, 0], [1, 0]]); break;
      case 'chew': dots([[-2, 0], [-1, 1], [0, 1], [1, 0]]); break;
      case 'frown': dots([[-2, 1], [-1, 0], [0, 0], [1, 1]]); break;
      case 'open': rect(g, F - 2, my, 4, 3, P.mouth); if (teeth) { put(g, F - 1, my, P.w); put(g, F, my, P.w); } rect(g, F - 1, my + 2, 2, 1, P.tongue); dots([[-3, 0], [2, 0], [-3, 1], [2, 1], [-2, 3], [-1, 3], [0, 3], [1, 3]]); break;
      case 'o': rect(g, F - 1, my, 2, 2, P.mouth); dots([[-2, 0], [-2, 1], [1, 0], [1, 1], [-1, 2], [0, 2], [-1, -1], [0, -1]]); break;
      case 'yawn': { const h = 1 + Math.round(yawn); rect(g, F - 2, my, 4, h, P.mouth); if (h > 2) rect(g, F - 1, my + h - 1, 2, 1, P.tongue); for (let y = 0; y < h; y++) { put(g, F - 3, my + y, o); put(g, F + 2, my + y, o); } rect(g, F - 2, my + h, 4, 1, o); break; }
    }
  }

  /* ---------- behaviour shared by the two furry pets ---------- */
  // 这些动作在干活、睡觉时也照样播（盖过干活 / 睡觉的样子）
  const OVERRIDE = new Set(['startle', 'drag', 'land', 'celebrate', 'restock', 'yawn', 'wake', 'poke', 'lookaround', 'flop', 'wave']);
  const JUMP = [0, -3, -6, -7, -7, -6, -4, -2, 0, 1, 0, 0, 0, 0];
  const moodOf = c => c.mood || (c.quota <= 0 ? 'empty' : c.quota < 25 ? 'tight' : 'ok');
  function basePose(c, mood) {
    const { state, t, action: a, at } = c, look = c.look || { x: 0, y: 0 };
    const p = { dx: 0, dy: 0, sq: Math.floor(t / 12) % 2 ? 0.4 : 0, tall: 0, hx: 0, lx: look.x, ly: look.y,
      eyes: t % 41 === 0 ? 'blink' : t % 41 === 1 ? 'half' : 'open', brows: null, mouth: 'smile', paws: 'rest', puff: 0, ears: 0,
      tailAmp: 1, tailSpeed: 0.22, wrap: false, feet: 'sit', headDrop: 0, yawn: 0, fx: [], blush: true, wink: false };
    // 待机时身体朝鼠标那边微微一歪（头挪一格），影子跟着拉长
    p.lean = state === 'idle' && !a && mood !== 'empty' ? clamp(Math.round(look.x * 0.5), -1, 1) : 0;
    p.hx = p.lean;
    // 额度紧张：平时只是皱眉；隔一阵紧张一下（c.nervous，节奏在 Controller）才冒汗、喘气、抖一抖
    if (mood === 'tight') { p.brows = 'worry'; p.mouth = 'flat'; if (c.nervous) { p.fx.push('sweat'); p.mouth = t % 6 < 3 ? 'open' : 'small'; p.sq = t % 4 < 2 ? 0.8 : 0; if (!a && t % 12 < 3) p.dx = t % 2 ? 1 : -1; } }
    if (mood === 'empty') { p.eyes = 'tired'; p.mouth = 'frown'; p.sq = 1.2; p.ears = 2; p.tailAmp = 0.2; p.fx.push('dots'); p.blush = false; }
    if (state === 'sleep' && !a) Object.assign(p, { eyes: 'closed', mouth: 'small', paws: 'none', wrap: true, feet: 'none', headDrop: 3, ears: 1, tailAmp: 0, sq: 1.4 + (Math.floor(t / 12) % 2) * 0.6, lx: 0, ly: 0, fx: ['zzz'], brows: null, dx: 0 });
    // 打盹：头一点一点往下掉，掉到底猛地抬一下，眼睛半睁半闭
    if (state === 'doze' && !a) {
      const f = t % 40, nod = f < 30 ? Math.min(3, f / 8) : 0;
      Object.assign(p, { eyes: f < 10 ? 'half' : f < 29 ? 'closed' : f < 33 ? 'open' : 'half', mouth: 'small', headDrop: Math.round(nod), sq: 0.6 + nod * 0.2, ears: 1, tailAmp: 0.3, tailSpeed: 0.12, lx: 0, ly: 0.5, brows: null, fx: f > 14 && f < 29 ? ['zsmall'] : [], dx: 0, hx: 0, lean: 0 });
    }
    switch (a) {
      case 'startle': Object.assign(p, { dy: JUMP[at] || 0, eyes: 'wide', mouth: 'o', puff: Math.max(0, 1 - at / 14), ears: -2, fx: ['exclaim'], brows: null, tailAmp: 0, dx: 0 }); break;
      case 'drag': Object.assign(p, { dy: -4 + Math.round(Math.sin(t * 0.5)), paws: 'dangle', feet: 'dangle', eyes: 'open', brows: 'worry', mouth: 'o', sq: -1.2, tailAmp: 2, tailSpeed: 0.5, fx: [], dx: 0 }); break;
      case 'land': Object.assign(p, { sq: [3, 2.2, 1.2, 0.5, 0, 0][at] ?? 0, eyes: at < 3 ? 'closed' : 'open', fx: ['dust'], mouth: 'small', dx: 0 }); break;
      case 'celebrate': { const f = at % 12; Object.assign(p, { dy: [0, 0, -3, -6, -8, -8, -6, -3, 0, 0, 0, 0][f], sq: f === 1 || f === 8 ? 1.8 : f === 9 ? 1 : 0, paws: 'up', eyes: 'happy', mouth: 'open', brows: null, tailAmp: 2.5, tailSpeed: 0.6, fx: ['confetti', 'sparkles'], dx: 0 }); break; }
      case 'yawn': { const s = Math.sin(Math.PI * Math.min(1, at / 15)); Object.assign(p, { yawn: s * 4, eyes: 'closed', mouth: 'yawn', paws: at > 3 && at < 13 ? 'stretch' : 'rest', tall: at > 3 && at < 13 ? 2 : 0, fx: [], brows: null, dx: 0 }); break; }
      case 'wake': Object.assign(p, { paws: 'eyes', eyes: at < 10 ? 'closed' : 'blink', mouth: 'small', fx: [], brows: null, dx: 0 }); break;
      case 'restock': Object.assign(p, { lx: -1.5, ly: -1.5, eyes: at > 20 ? 'happy' : 'open', mouth: 'open', ears: -1, fx: ['sparkles'], brows: null, sq: 0, dx: 0 }); break;
      case 'look': Object.assign(p, { tall: Math.max(0, Math.min(at, 3, 30 - at)), ears: -1, lx: at < 12 ? -2 : at < 24 ? 2 : 0, ly: -0.5, mouth: 'small', tailAmp: 0.3, dx: 0 }); break;
      // 双击：被戳了一下，压扁、眯成 > <、抖两下，头上冒个气鼓鼓的十字
      case 'poke': Object.assign(p, { sq: [2.6, 2.2, 1.6, 1, 0.5, 0.2, 0, 0, 0, 0, 0, 0][at] ?? 0, eyes: at < 8 ? 'squeeze' : 'open', mouth: at < 4 ? 'o' : 'frown', brows: at >= 8 ? 'worry' : null, dx: at < 6 ? (at % 2 ? 1 : -1) : 0, hx: 0, lean: 0, ears: at < 6 ? 1 : 0, fx: ['anger'], tailAmp: 2, tailSpeed: 0.7, blush: false }); break;
      // 连点四下：左看右看好几回，头顶一个问号
      case 'lookaround': Object.assign(p, { tall: Math.max(0, Math.min(at, 2, 32 - at)), ears: -1, lx: [-2, -2, 2, 2, -2, 2, -2, 0][Math.floor(at / 4)] ?? 0, ly: -0.5, mouth: 'o', brows: null, tailAmp: 1.5, hx: 0, lean: 0, fx: ['question'] }); break;
      // 困到撑不住，一头栽倒（之后就是睡觉的样子）
      case 'flop': Object.assign(p, { eyes: 'closed', mouth: 'small', sq: Math.min(1.6, at * 0.16), headDrop: Math.min(3, Math.round(at * 0.35)), dy: at < 5 ? -Math.round(at / 2) : 0, ears: 1, tailAmp: 0, lx: 0, ly: 0, brows: null, hx: 0, lean: 0, fx: at >= 9 ? ['dust'] : [] }); break;
      // 极简模式里鼠标移过来：探出身子挥挥手
      case 'wave': Object.assign(p, { paws: 'hi', eyes: 'happy', mouth: 'open', brows: null, lx: -2, ly: -0.5, tailAmp: 1.8, tailSpeed: 0.5, hx: 0, lean: 0 }); break;
    }
    return p;
  }
  function poseFx(g, p, c, at, P) {
    for (const f of p.fx) switch (f) {
      case 'sweat': sweat(g, at.sweat[0], at.sweat[1]); break;
      case 'dots': bubble(g, at.dots[0], at.dots[1], P.o); break;
      case 'exclaim': exclaim(g, at.exclaim[0], Math.max(1, at.exclaim[1])); break;
      case 'zzz': zzz(g, at.zzz[0], at.zzz[1], c.t); break;
      case 'zsmall': glyph(g, Z4, at.zzz[0], at.zzz[1] - ((c.t >> 3) % 2), '#8C97B0'); break;
      case 'dust': dust(g, at.dust[0], 53, c.action === 'flop' ? c.at - 9 : c.at); break;
      case 'question': question(g, at.exclaim[0], Math.max(1, at.exclaim[1] + ((c.t >> 2) % 2))); break;
      case 'anger': anger(g, at.exclaim[0] - 1, Math.max(1, at.exclaim[1] + 2)); break;
      case 'sparkles': sparkles(g, c.t, [[5, 8], [27, 3], [63, 5], [67, 25], [4, 27]]); break;
      case 'confetti': confetti(g, c.at); break;
    }
  }

  /* ---------- 松鼠 · 栗栗 ---------- */
  const SQ = { o: '#2B170C', fur: '#C8703A', furD: '#9A4E22', furL: '#E39257', belly: '#F8E2BE', tail: '#D4823F', tailD: '#A65C28', tailL: '#EFAE6E', tailTip: '#F7D2A3', eye: '#1A0F08', eyeL: '#4A2E1E', w: '#FFFFFF', nose: '#3A2418', noseL: '#7A5644', pink: '#F4A0A6', mouth: '#8E3434', tongue: '#F07C84', acorn: '#B07A42', acornD: '#80522A', acornL: '#D9A468', cap: '#5E3D1F', capL: '#8A6238', capD: '#3F2812', dirt: '#8A6A4A', dust: '#C3C9D3' };
  const ACORN = ['..s...', '.CcCC.', 'CCcCcC', '.AaAA.', '.AaAA.', '.AAAA.', '..AA..'];
  function acorn(g, x, y, P) { sprite(g, ACORN, { s: P.capD, C: P.cap, c: P.capL, A: P.acorn, a: P.acornL }, Math.round(x), Math.round(y), P.o, { [P.acorn]: P.acornD }); }
  const PILE = [[2, 46], [9, 46], [16, 46], [5, 38], [12, 38], [9, 30]];
  const TAIL = [[9, 48, 5], [16, 44, 6], [20, 35, 6.5], [19, 25, 6], [15, 17, 5.2], [9, 13, 4.2], [4, 15, 3]];
  const TAIL_WRAP = [[12, 47, 5], [5, 50, 5.5], [-4, 50, 5.5], [-11, 47, 5], [-14, 42, 4.2], [-13, 37, 3.2]];
  function bushyTail(g, P, base, cx, dy, t, amp, speed, puff) {
    const n = base.length - 1;
    const pts = base.map(([x, y, r], k) => [cx + x + Math.sin(t * speed - k * 0.7) * amp * (k / n), y + dy + Math.cos(t * speed - k * 0.7) * amp * 0.3 * (k / n), r + puff * 1.8]);
    layer(g, P.o, { [P.tail]: P.tailD }, l => { path(l, pts, P.tail, 3); fluff(l, puff > 0.3 ? 2 : 4, cx, Math.round(dy)); });
    tailShine(g, P, pts);
    const [ex, ey, er] = pts[n]; ell(g, ex, ey, er * 0.55, er * 0.55, P.tailTip, false);
  }
  function tailShine(g, P, pts) {
    for (let k = 1; k < pts.length - 1; k++) for (let s = 0; s < 3; s++) {
      const u = s / 3, a = pts[k], b = pts[k + 1], r = a[2] + (b[2] - a[2]) * u;
      ell(g, a[0] + (b[0] - a[0]) * u - r * 0.32, a[1] + (b[1] - a[1]) * u - r * 0.28, r * 0.34, r * 0.42, P.tailL, false);
    }
  }
  function squirrel(g, c) {
    const P = SQ, mood = moodOf(c), a = c.action, at = c.at;
    // 极简模式躲在屏幕边后面探头：橡果堆留在屏幕外，不跟着歪
    if (c.mini) { /* 不画橡果堆 */ } else if (a === 'restock') {
      const from = Math.round(clamp(c.from || 0, 0, 100) / 100 * 6);
      for (let i = 0; i < 6; i++) {
        if (i < from) { acorn(g, PILE[i][0], PILE[i][1], P); continue; }
        const k = at - (i - from) * 5; if (k < 0) continue;
        const [px, py] = PILE[i];
        acorn(g, px, k >= 8 ? py - (k === 8 ? 2 : k === 9 ? 1 : 0) : -8 + (py + 8) * (k / 8) * (k / 8), P);
      }
    } else for (let i = 0; i < Math.round(c.quota / 100 * 6); i++) acorn(g, PILE[i][0], PILE[i][1], P);
    if (mood === 'empty' && a !== 'restock' && !c.mini) { put(g, 6, 52, P.acornD); put(g, 11, 51, P.cap); put(g, 15, 52, P.acornL); put(g, 19, 52, P.acornD); }
    if (c.state === 'work' && !OVERRIDE.has(a)) return squirrelSide(g, c, mood);
    const p = basePose(c, mood);
    switch (a) {
      case 'nibble': Object.assign(p, { paws: 'mouth', mouth: (at >> 1) % 2 ? 'chew' : 'small', brows: null }); p.fx.push('crumbs'); break;
      case 'groom': Object.assign(p, { paws: 'face', eyes: 'closed', mouth: 'small' }); break;
      case 'tail': Object.assign(p, { lx: 2, hx: 1, tailAmp: 3, tailSpeed: 0.9, puff: at < 13 ? 0.7 : 0.7 * (26 - at) / 13, eyes: 'happy', mouth: 'smile' }); break;
      case 'scratch': Object.assign(p, { paws: 'ear', wink: true, hx: -1, mouth: 'smile' }); break;
    }
    squirrelSit(g, c, p);
  }
  function squirrelSit(g, c, p) {
    const P = SQ, t = c.t, at = c.at;
    const cx = 37 + p.dx, dy = p.dy, sq = p.sq;
    const A = cx + p.hx, F = A + Math.round(p.lx * 0.8), fy = Math.round(p.ly);
    const mA = x => 2 * A - 1 - x, mF = x => 2 * F - 1 - x;
    const hy = 26 + dy - p.tall + Math.max(0, sq) * 0.8 + p.headDrop;
    const by = 42 + dy + sq * 0.5, sY = 36 + dy;
    if (!p.wrap) bushyTail(g, P, TAIL, cx, dy, t, p.tailAmp, p.tailSpeed, p.puff);
    const earY = hy - 9 + p.ears, earH = 4.4 - Math.max(0, p.ears) * 0.7;
    layer(g, P.o, { [P.fur]: P.furD }, l => {
      const hz = Math.max(0, sq) * 0.3, hY = 47 + Math.min(0, dy) + hz;
      ell(l, cx - 7, hY, 5.5 + hz, 5, P.fur); ell(l, cx + 7, hY, 5.5 + hz, 5, P.fur);
      ell(l, cx, by, 10 + sq * 0.6, 10.5 - sq, P.fur);
      if (p.feet === 'sit') { const fY = 52 + Math.min(0, dy); ell(l, cx - 8, fY, 3.8, 1.6, P.fur); ell(l, cx + 8, fY, 3.8, 1.6, P.fur); }
      else if (p.feet === 'dangle') { const s = Math.sin(t * 0.8) * 1.5; ell(l, cx - 5 + s, by + 11, 2.2, 3, P.fur); ell(l, cx + 5 - s, by + 11, 2.2, 3, P.fur); }
      ell(l, A - 7, earY, 2.6, earH, P.fur); ell(l, A + 7, earY, 2.6, earH, P.fur);
      if (p.ears <= 0) { const top = Math.floor(earY - earH); [[-8, -1], [-8, -2], [-9, -3]].forEach(([x, y]) => { put(l, A + x, top + y, P.fur, true); put(l, mA(A + x), top + y, P.fur, true); }); }
      ell(l, A, hy, 10.5, 9, P.fur);
      ell(l, A - 8.5, hy + 3, 3.6, 3, P.fur); ell(l, A + 8.5, hy + 3, 3.6, 3, P.fur);
      fluff(l, 9, cx, Math.round(dy));
    });
    if (p.ears < 2) { const ih = Math.max(1, earH - 1.8); ell(g, A - 7, earY + 0.6, 1.1, ih, P.pink, false); ell(g, A + 7, earY + 0.6, 1.1, ih, P.pink, false); }
    ell(g, cx, 43 + dy + sq * 0.4, 6.5 + sq * 0.4, 8 - sq * 0.7, P.belly, false);
    const chestY = Math.round(35 + dy + sq * 0.9);
    [-4, -2, 1, 3].forEach(i => put(g, cx + i, chestY - 1, P.belly));
    ell(g, A - 3, hy - 5, 3.5, 1.6, P.furL, false);
    ell(g, F - 5.5, hy - 1 + fy, 2.9, 3.4, P.belly, false); ell(g, F + 5.5, hy - 1 + fy, 2.9, 3.4, P.belly, false);
    ell(g, F, hy + 4.5 + fy, 4.6, 3, P.belly, false);
    const ey = Math.round(hy - 3 + fy), lx = F - 7, rx = F + 4;
    if (p.wink) { eye(g, lx, ey, 3, 4, 'happy', P); eye(g, rx, ey, 3, 4, 'open', P); }
    else eyes2(g, lx, rx, ey, 3, 4, p.eyes, P);
    if (p.brows) brows(g, lx, rx, 3, ey - 2, p.brows, P.o);
    const ny = Math.round(hy + 1 + fy);
    rect(g, F - 2, ny, 4, 1, P.nose); rect(g, F - 1, ny + 1, 2, 1, P.nose); put(g, F - 2, ny, P.noseL);
    mouthAt(g, F, ny + 3, p.mouth, P, p.yawn, true);
    if (p.blush) [F - 9, F - 8].forEach(x => { put(g, x, ny + 2, P.pink); put(g, mF(x), ny + 2, P.pink); });

    const sh = { [P.fur]: P.furD }, osc = [-1, 0, 1, 0][(at >> 1) % 4];
    const arm = (l, pts) => path(l, pts, P.fur, 4);
    switch (p.paws) {
      case 'rest': layer(g, P.o, sh, l => { ell(l, cx - 3.5, 39 + dy, 2.3, 1.9, P.fur); ell(l, cx + 3.5, 39 + dy, 2.3, 1.9, P.fur); }); break;
      case 'mouth': { const ay = ny + 2 + ((at >> 1) % 2); acorn(g, F - 3, ay, P); layer(g, P.o, sh, l => { arm(l, [[cx - 6, sY, 2], [F - 4, ay + 6, 2.3]]); arm(l, [[cx + 6, sY, 2], [2 * F - (F - 4), ay + 6, 2.3]]); }); break; }
      case 'face': layer(g, P.o, sh, l => { arm(l, [[cx - 7, sY, 2], [F - 8, hy + 2 + osc, 2.3]]); arm(l, [[cx + 7, sY, 2], [F + 8, hy + 2 - osc, 2.3]]); }); break;
      case 'eyes': layer(g, P.o, sh, l => { arm(l, [[cx - 6, sY, 2], [F - 5.5, hy - 1 + osc + fy, 2.3]]); arm(l, [[cx + 6, sY, 2], [F + 5.5, hy - 1 - osc + fy, 2.3]]); }); break;
      case 'ear': layer(g, P.o, sh, l => { arm(l, [[cx - 9, sY, 2], [cx - 14, hy, 2], [A - 9, hy - 9 + (at % 2), 2.3]]); ell(l, cx + 3.5, 39 + dy, 2.3, 1.9, P.fur); }); break;
      case 'up': layer(g, P.o, sh, l => { for (const s of [-1, 1]) arm(l, [[cx + s * 8, sY, 2], [cx + s * 14, hy + 3, 2], [cx + s * 16, hy - 6, 2.4]]); }); break;
      case 'stretch': layer(g, P.o, sh, l => { for (const s of [-1, 1]) arm(l, [[cx + s * 8, sY, 2], [cx + s * 13, hy - 2, 2], [cx + s * 14, hy - 10, 2.4]]); }); break;
      case 'dangle': layer(g, P.o, sh, l => { for (const s of [-1, 1]) arm(l, [[cx + s * 8, sY, 2], [cx + s * 13, hy + 4, 2], [cx + s * 15, hy - 1, 2.4]]); }); break;
      // 左手举高左右摆（挥手），右手放着
      case 'hi': { const sway = [-2, -1, 0, 1, 2, 1, 0, -1][(c.t >> 1) % 8]; layer(g, P.o, sh, l => { arm(l, [[cx - 8, sY, 2], [cx - 13, hy + 1, 2], [cx - 14 + sway, hy - 9, 2.4]]); ell(l, cx + 3.5, 39 + dy, 2.3, 1.9, P.fur); }); break; }
    }
    if (p.wrap) bushyTail(g, P, TAIL_WRAP, cx, dy, t, 0.4, 0.15, 0);
    if (p.fx.includes('crumbs')) for (let k = 0; k < 3; k++) put(g, F - 2 + k * 2, ny + 9 + ((at + k * 3) % 9), P.acornL);
    poseFx(g, p, c, { sweat: [A + 13, hy - 9], dots: [3, 21], exclaim: [A + 13, hy - 18], zzz: [cx + 10, hy - 12], dust: [cx] }, P);
  }
  // Side view while working: hops between the pile and a stash, carrying one acorn per running task.
  function squirrelSide(g, c, mood) {
    const P = SQ, t = c.t, n = clamp(c.tasks, 1, 3);
    const hf = [8, 6, 4][n - 1], L = 42, R = 53, seg = 3 * hf, total = 2 * seg + 12, u = t % total;
    let sx, face, act = null, k;
    if (u < seg) { face = -1; k = u; sx = R - (R - L) * k / seg; }
    else if (u < seg + 6) { face = -1; sx = L; act = 'pick'; k = u - seg; }
    else if (u < 2 * seg + 6) { face = 1; k = u - seg - 6; sx = L + (R - L) * k / seg; }
    else { face = 1; sx = R; act = 'dig'; k = u - 2 * seg - 6; }
    const f8 = act ? 0 : Math.floor((k % hf) * 8 / hf);
    const hop = act ? 0 : [0, 1, 4, 6, 6, 4, 1, 0][f8], air = !act && f8 >= 2 && f8 <= 5;
    sx = Math.round(sx);
    const draw = T => drawSideSquirrel(T, P, sx, 53, hop, air, f8, act, k, n, mood, t, c.nervous);
    if (face === -1) draw(g); else mirrorInto(g, sx, draw);
  }
  function drawSideSquirrel(T, P, sx, gy, hop, air, f8, act, k, n, mood, t, nervous) {
    const by = gy - hop, bow = act === 'pick' ? Math.min(k, 3) : act === 'dig' ? 2 : 0;
    const wag = Math.sin(t * 0.6) * 1.2;
    const tail = [[7, -8, 4], [10, -14, 5], [11, -21, 5.5], [8, -28, 4.8], [3, -31, 3.8], [-1, -29, 2.8]]
      .map(([x, y, r], i) => [sx + x + wag * (i / 5) + (air ? i * 0.3 : 0), by + y + (air ? i * 0.2 : 0), r]);
    layer(T, P.o, { [P.tail]: P.tailD }, l => { path(l, tail, P.tail, 3); fluff(l, 4, sx, 0); });
    tailShine(T, P, tail);
    layer(T, P.o, { [P.fur]: P.furD }, l => {
      if (air) ell(l, sx - 8, by - 6, 2, 1.5, P.furD); else ell(l, sx - 3, gy - 2, 1.8, 2.2, P.furD);
    });
    layer(T, P.o, { [P.fur]: P.furD }, l => {
      ell(l, sx + 1, by - 8, 8.5 + (air ? 1 : 0), 6 - (air ? 0.5 : 0), P.fur);
      ell(l, sx + 6, by - 6, 5, 5, P.fur);
      if (air) ell(l, sx + 11, by - 3, 3.6, 1.4, P.fur); else ell(l, sx + 5, gy - 1, 4.2, 1.5, P.fur);
      if (act === 'dig') { const s = k % 2; ell(l, sx - 6 - s, gy - 2 + s, 1.8, 2, P.fur); }
      else if (air) ell(l, sx - 9, by - 5, 2, 1.5, P.fur); else ell(l, sx - 5, gy - 2, 1.8, 2.4, P.fur);
      ell(l, sx - 7, by - 14 + bow, 6.5, 5.6, P.fur);
      ell(l, sx - 12, by - 12 + bow, 3.4, 2.8, P.fur);
      ell(l, sx - 5, by - 20 + bow, 1.8, 3.2, P.fur);
      put(l, sx - 5, by - 24 + bow, P.fur, true); put(l, sx - 4, by - 25 + bow, P.fur, true);
      fluff(l, 10, sx, 0);
    });
    ell(T, sx, by - 4.5, 6, 2.4, P.belly, false);
    ell(T, sx - 11, by - 10.5 + bow, 2.6, 1.4, P.belly, false);
    put(T, sx - 5, by - 21 + bow, P.pink); put(T, sx - 5, by - 20 + bow, P.pink);
    ell(T, sx - 9.5, by - 15.5 + bow, 2, 2.4, P.belly, false);
    const ex = sx - 10, ey = by - 17 + bow;
    rect(T, ex, ey, 2, 3, P.eye); put(T, ex, ey, P.w);
    if (mood !== 'ok') { put(T, ex - 1, ey - 2, P.o); put(T, ex, ey - 2, P.o); put(T, ex + 1, ey - 1, P.o); }
    else if (n >= 2) { put(T, ex - 1, ey - 1, P.o); put(T, ex, ey - 2, P.o); put(T, ex + 1, ey - 2, P.o); }
    rect(T, sx - 16, by - 13 + bow, 2, 1, P.nose);
    put(T, sx - 8, by - 12 + bow, P.pink);
    acorn(T, sx - 21, by - 14 + bow, P);
    if (n >= 2) acorn(T, sx - 2, by - 21, P);
    if (n >= 3) acorn(T, sx + 5, by - 36, P);
    if (act === 'dig') for (let j = 0; j < 4; j++) { const p = (k + j * 2) % 7; put(T, sx + 2 + p * 2, gy - 2 - p + (p > 3 ? (p - 3) * 2 : 0), P.dirt); }
    if (!act && f8 === 7) { put(T, sx - 7, gy, P.dust); put(T, sx + 9, gy, P.dust); put(T, sx + 10, gy - 1, P.dust); }
    if (n >= 2 && air) { rect(T, sx + 15, by - 10, 3, 1, P.dust); rect(T, sx + 16, by - 6, 3, 1, P.dust); }
    if (mood === 'tight' && nervous) sweat(T, sx - 2, by - 30);
  }

  /* ---------- 仓鼠 · 豆豆 ---------- */
  const HAM = { o: '#3B2416', fur: '#ECA552', furD: '#C67C31', furL: '#F8C882', stripe: '#C27A33', cream: '#FDEDCF', creamD: '#EDCB98', pink: '#F59AAA', pinkD: '#D9707F', eye: '#1D120C', eyeL: '#4A3020', w: '#FFFFFF', mouth: '#9A3446', tongue: '#F07C84', seed: '#4B3A2A', seedL: '#EDE2C8', ring: '#A9B3C1', ringD: '#5E6877', ringL: '#D6DCE5', spoke: '#C3CAD4', bowl: '#9AA5B5', bowlD: '#717C8C', sweat: '#9AD8FF' };
  const SEED = ['.SS.', 'SLSS', 'SLSS', '.SS.'];
  function seed(g, x, y, P) { sprite(g, SEED, { S: P.seed, L: P.seedL }, Math.round(x), Math.round(y), P.o, null); }
  function hamster(g, c) {
    const P = HAM, mood = moodOf(c), a = c.action, at = c.at, t = c.t;
    if (c.state === 'work' && !OVERRIDE.has(a)) return hamsterRun(g, c, mood);
    const p = basePose(c, mood);
    let bonus = 0, carry = null;
    if (a === 'wash') Object.assign(p, { paws: 'face', eyes: 'closed', mouth: 'small' });
    if (a === 'stuff') {
      if (at < 10) { p.paws = 'mouth'; carry = at / 10; p.mouth = 'open'; }
      else { p.mouth = 'chew'; p.eyes = 'happy'; bonus = at < 16 ? (at - 10) * 0.45 : Math.max(0, 2.7 - (at - 16) * 0.2); }
    }
    if (a === 'stretch') { const s = Math.sin(Math.PI * at / 22); Object.assign(p, { eyes: 'closed', mouth: 'yawn', yawn: s * 3.5, paws: 'stretch', tall: Math.round(s * 3) }); }
    let q = c.quota;
    if (a === 'restock') q = (c.from || 0) + (100 - (c.from || 0)) * Math.min(1, at / 30);
    const cr = 2 + q * 0.05 + bonus;
    const cx = 36 + p.dx, dy = p.dy, sq = p.sq, puff = p.puff, curl = p.wrap;
    const A = cx + p.hx, F = A + Math.round(p.lx * 0.8), fy = Math.round(p.ly);
    const mA = x => 2 * A - 1 - x;
    const by = 40 + dy + sq * 0.5 + (curl ? 2 : 0);
    const rx = 15 + sq * 0.6 + puff * 2 - p.tall * 0.4, ry = 12.5 - sq + puff * 1.5 + p.tall * 0.8 - (curl ? 1.5 : 0);
    const top = by - ry, hy = Math.round(top + 10.5 + (curl ? 2 : 0));
    if (mood === 'empty') { layer(g, P.o, { [P.bowl]: P.bowlD }, l => ell(l, 11, 51, 7.5, 3.2, P.bowl)); ell(g, 11, 49.6, 5.6, 1.2, P.bowlD, false); }
    const earR = curl || p.ears > 0 ? 2.8 : 3.8, earY = top + 2.5 + Math.max(0, p.ears) - (p.ears < 0 ? 1 : 0);
    layer(g, P.o, { [P.fur]: P.furD, [P.pink]: P.pinkD }, l => {
      ell(l, A - 10, earY, earR, earR, P.fur); ell(l, A + 10, earY, earR, earR, P.fur);
      ell(l, cx, by, rx, ry, P.fur);
      if (p.feet === 'sit') { const fY = 52.5 + Math.min(0, dy); ell(l, cx - 8, fY, 3.6, 1.6, P.pink); ell(l, cx + 8, fY, 3.6, 1.6, P.pink); }
      if (p.feet === 'dangle') { const s = Math.sin(t * 0.8) * 1.5; ell(l, cx - 6 + s, by + ry + 1, 2.2, 2.6, P.pink); ell(l, cx + 6 - s, by + ry + 1, 2.2, 2.6, P.pink); }
      fluff(l, 10, cx, Math.round(dy));
    });
    ell(g, A - 10, earY + 0.3, earR * 0.5, earR * 0.5, P.pink, false); ell(g, A + 10, earY + 0.3, earR * 0.5, earR * 0.5, P.pink, false);
    rect(g, A - 1, Math.ceil(top) + 1, 2, 3, P.stripe);
    ell(g, A - 6, top + 4, 3, 1.3, P.furL, false);
    ell(g, cx, by + 6, 9.5, Math.max(3, 6.5 - sq * 0.5), P.cream, false);
    layer(g, P.o, { [P.furL]: P.fur }, l => { ell(l, A - 11, hy + 4, cr, cr * 0.82, P.furL); ell(l, A + 11, hy + 4, cr, cr * 0.82, P.furL); });
    ell(g, A - 11, hy + 4 + cr * 0.35, cr * 0.7, cr * 0.4, P.cream, false); ell(g, A + 11, hy + 4 + cr * 0.35, cr * 0.7, cr * 0.4, P.cream, false);
    if (cr >= 3.5 && p.blush) [A - 12, A - 11].forEach(x => { put(g, x, hy + 4, P.pink); put(g, mA(x), hy + 4, P.pink); });
    const ey = hy - 4 + fy, lx = F - 9, rxE = F + 6;
    eyes2(g, lx, rxE, ey, 3, 3, p.eyes, P);
    if (p.brows) brows(g, lx, rxE, 3, ey - 2, p.brows, P.o);
    rect(g, F - 1, hy + fy, 2, 1, P.pinkD);
    mouthAt(g, F, hy + 1 + fy, p.mouth, P, p.yawn, false);

    const paw = (l, x, y) => ell(l, x, y, 2, 1.7, P.pink);
    const arm = (l, x0, y0, x1, y1) => { path(l, [[x0, y0, 1.8], [x1, y1, 1.8]], P.fur, 4); paw(l, x1, y1); };
    const osc = [-1, 0, 1, 0][(at >> 1) % 4];
    switch (p.paws) {
      case 'rest': layer(g, P.o, null, l => { paw(l, cx - 4.5, by + 2); paw(l, cx + 4.5, by + 2); }); break;
      case 'mouth': { const sx = cx - 2 + (F - 2 - (cx - 2)) * carry, sy = by + 1 + (hy - 1 - (by + 1)) * carry; seed(g, sx, sy, P); layer(g, P.o, null, l => { paw(l, sx - 1, sy + 3); paw(l, sx + 5, sy + 3); }); break; }
      case 'face': layer(g, P.o, null, l => { paw(l, F - 8, hy - 1 + osc); paw(l, F + 8, hy - 1 - osc); }); break;
      case 'eyes': layer(g, P.o, null, l => { paw(l, F - 7.5, ey + 1 + osc); paw(l, F + 7.5, ey + 1 - osc); }); break;
      case 'up': layer(g, P.o, { [P.fur]: P.furD }, l => { for (const s of [-1, 1]) arm(l, cx + s * 12, by - 3, cx + s * 17, by - 10); }); break;
      case 'stretch': layer(g, P.o, { [P.fur]: P.furD }, l => { for (const s of [-1, 1]) arm(l, cx + s * 11, by - 6, cx + s * 14, top - 3); }); break;
      case 'dangle': layer(g, P.o, { [P.fur]: P.furD }, l => { for (const s of [-1, 1]) arm(l, cx + s * 13, by - 2, cx + s * 18, by - 6); }); break;
      case 'hi': { const sway = [-2, -1, 0, 1, 2, 1, 0, -1][(t >> 1) % 8]; layer(g, P.o, { [P.fur]: P.furD }, l => { arm(l, cx - 12, by - 3, cx - 16 + sway, by - 13); paw(l, cx + 4.5, by + 2); }); break; }
    }
    if (a === 'restock') for (let k = 0; k < 8; k++) {
      const age = at - k * 3; if (age < 0 || age >= 12) continue;
      const u = age / 12, x = F - 2 + ((k * 5) % 9 - 4) * (1 - u), y = -4 + (hy - (-4)) * u;
      seed(g, x, y, P);
    }
    poseFx(g, p, c, { sweat: [A + 16, top + 2], dots: [A + 9, top - 8], exclaim: [A + 16, top - 8], zzz: [A + 15, top - 2], dust: [cx] }, P);
  }
  function hamsterRun(g, c, mood) {
    const P = HAM, t = c.t, n = clamp(c.tasks, 1, 3), q = c.quota;
    const wx = 36, wy = 27, a0 = -t * [0.12, 0.2, 0.3][n - 1];
    layer(g, P.ringD, null, l => {
      for (const s of [-1, 1]) { line(l, wx, wy, wx + s * 13, 54, P.ringD); line(l, wx + s, wy, wx + s * 14, 54, P.ringD); }
      rect(l, 18, 54, 36, 2, P.ringD, true);
      for (let k = 0; k < 8; k++) { const ang = a0 + k * Math.PI / 4; line(l, wx, wy, Math.round(wx + Math.cos(ang) * 23), Math.round(wy + Math.sin(ang) * 23), P.spoke); }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const d = Math.hypot(x + 0.5 - wx, y + 0.5 - wy); if (d >= 23.4 && d <= 25.2) put(l, x, y, P.ring, true); }
      ell(l, wx, wy, 2.4, 2.4, P.ringD, true);
    });
    for (let k = 0; k < 40; k++) { const ang = k * Math.PI * 2 / 40; if (Math.sin(ang) < -0.25) put(g, wx + Math.cos(ang) * 24.9, wy + Math.sin(ang) * 24.9, P.ringL); }
    for (let k = 0; k < 28; k++) { const ang = a0 + k * Math.PI * 2 / 28; put(g, wx + Math.cos(ang) * 23.8, wy + Math.sin(ang) * 23.8, P.ringD); }

    const f = Math.floor(t * [0.5, 0.75, 1][n - 1]) % 4;
    const bob = [0, -1, -2, -1][f], lean = n >= 3 ? 1 : 0, hx = 36, gy = 50, by = gy - 9 + bob;
    const L = [[9, 0, -11, 0], [5, 2, -6, 1], [1, 0, -2, 0], [5, 1, -6, 2]][f];
    layer(g, P.o, null, l => { ell(l, hx + L[0] - 2, gy - 1 - L[1], 2.2, 1.6, P.pinkD); ell(l, hx + L[2] + 2, gy - 1 - L[3], 2.4, 1.7, P.pinkD); });
    layer(g, P.o, { [P.fur]: P.furD }, l => {
      ell(l, hx + L[0], gy - 1 - L[1], 2.2, 1.6, P.pink); ell(l, hx + L[2], gy - 1 - L[3], 2.6, 1.8, P.pink);
      ell(l, hx - 13.5, by - 1, 1.8, 1.5, P.fur);
      ell(l, hx - 2, by, 11.5, 8, P.fur);
      ell(l, hx + 7, by - 2 + lean, 7.5, 7, P.fur);
      if (n >= 3) ell(l, hx + 2, by - 8 + lean, 3.4, 2.2, P.fur); else ell(l, hx + 3, by - 9 + lean, 3, 3, P.fur);
      fluff(l, 11, hx, bob);
    });
    ell(g, hx - 1, by + 4, 9, 3, P.cream, false);
    ell(g, hx + 9.5, by + 1 + lean, 3.5, 3, P.cream, false);
    if (n < 3) ell(g, hx + 3, by - 9 + lean, 1.5, 1.5, P.pink, false);
    rect(g, hx + 2, by - 7 + lean, 3, 1, P.stripe);
    ell(g, hx - 6, by - 5, 3.5, 1.3, P.furL, false);
    const cr = 1.6 + q * 0.035;
    if (cr >= 2) { layer(g, P.o, { [P.furL]: P.fur }, l => ell(l, hx + 6, by + 2 + lean, cr, cr * 0.8, P.furL)); ell(g, hx + 6, by + 2 + lean + cr * 0.35, cr * 0.7, cr * 0.4, P.cream, false); }
    const ex = hx + 9, ey = by - 5 + lean;
    rect(g, ex, ey, 2, 3, P.eye); put(g, ex, ey, P.w);
    if (mood !== 'ok') { put(g, ex - 1, ey - 1, P.o); put(g, ex, ey - 2, P.o); put(g, ex + 1, ey - 2, P.o); }
    else if (n >= 2) { put(g, ex - 1, ey - 2, P.o); put(g, ex, ey - 2, P.o); put(g, ex + 1, ey - 1, P.o); }
    put(g, hx + 14, by - 2 + lean, P.pinkD); put(g, hx + 14, by - 1 + lean, P.pinkD);
    put(g, hx + 12, by + 1 + lean, P.o);
    if (cr >= 3) put(g, hx + 7, by + 1 + lean, P.pink);
    if (n >= 2) { const s = t % 2; rect(g, hx - 24 + s, by - 4, 4, 1, P.ringD); rect(g, hx - 23 - s, by + 1, 5, 1, P.ringD); if (n >= 3) rect(g, hx - 22 + s, by - 8, 3, 1, P.ringD); }
    if (n >= 3) { const k = t % 4; put(g, hx - 1 - k * 3, by - 12 + k, P.sweat); put(g, hx - 2 - k * 3, by - 12 + k, P.sweat); }
    if (mood === 'tight' && c.nervous) sweat(g, hx + 12, by - 15);
    if (mood === 'empty') bubble(g, hx + 4, by - 26, P.o);
  }

  /* ---------- 章鱼 · 墨墨 ---------- */
  const OCT = { o: '#3A1A2A', eye: '#1E1220', eyeL: '#1E1220', w: '#FFFFFF', pink: '#FF8FA8', mouth: '#B23A55', tongue: '#FF8FA8', scr: '#24303E', scrL: '#5BE38F', txt: '#C8F5D8', txt2: '#7FB6FF', key: '#A2ABB8', keyD: '#6E7887', ink: '#3A2F5E', inkL: '#5A4E86' };
  const OCT_PAL = {
    ok: { body: '#F27D90', bodyD: '#C9596E', bodyL: '#FFB4BF', spot: '#FFC6CE' },
    tight: { body: '#F3B0A6', bodyD: '#D18A80', bodyL: '#FFD9D2', spot: '#FFE4DE' },
    empty: { body: '#ABA9C6', bodyD: '#7F7DA0', bodyL: '#CDCBE0', spot: '#D8D7E8' },
    mint: { body: '#6FD3B0', bodyD: '#43A587', bodyL: '#A9EED6', spot: '#C2F4E2' },
    lilac: { body: '#B595F0', bodyD: '#8A6BC9', bodyL: '#D7C4FA', spot: '#E2D5FC' },
    gold: { body: '#F5C552', bodyD: '#CC9A2C', bodyL: '#FFE08F', spot: '#FFEBB3' },
    flash: { body: '#FFE6EA', bodyD: '#E6BFC6', bodyL: '#FFFFFF', spot: '#FFFFFF' },
  };
  const OFFS = [-11, -6.5, -2, 2, 6.5, 11];
  function laptop(g, tx, ty, t, seed, P) {
    const x = Math.round(tx) - 4, y = Math.round(ty) - 8;
    layer(g, P.o, null, l => { rect(l, x, y, 9, 6, P.scr, true); rect(l, x - 1, y + 6, 11, 2, P.key, true); });
    rect(g, x - 1, y + 7, 11, 1, P.keyD);
    const p = (t + seed * 7) % 20, n1 = Math.min(p, 6), n2 = clamp(p - 7, 0, 7), n3 = clamp(p - 14, 0, 5);
    put(g, x + 1, y + 1, P.scrL);
    for (let i = 0; i < n1; i++) put(g, x + 2 + i, y + 1, P.txt);
    for (let i = 0; i < n2; i++) put(g, x + 1 + i, y + 3, P.txt2);
    for (let i = 0; i < n3; i++) put(g, x + 1 + i, y + 4, P.txt);
    if (t % 2) { if (p < 7) put(g, x + 2 + n1, y + 1, P.scrL); else if (p < 14) put(g, x + 1 + n2, y + 3, P.scrL); else put(g, x + 1 + n3, y + 4, P.scrL); }
  }
  function octopus(g, c) {
    const mood = moodOf(c), { t, action: a, at } = c, look = c.look || { x: 0, y: 0 };
    let palKey = mood;
    if (a === 'shimmer') palKey = ['mint', 'lilac', 'gold', 'ok'][Math.floor(at / 6) % 4];
    if (a === 'startle' && at < 5) palKey = 'flash';
    if (a === 'restock') palKey = 'ok';
    const P = Object.assign({}, OCT, OCT_PAL[palKey]);
    const work = c.state === 'work' && !OVERRIDE.has(a), sleep = c.state === 'sleep' && !a;
    const n = work ? clamp(c.tasks, 1, 3) : 0, breath = Math.floor(t / 10) % 2 ? 0.5 : 0;
    let dy = Math.floor(t / 8) % 2, sq = breath, eyes = t % 41 === 0 ? 'blink' : 'open', brow = null, mouth = 'small', yawn = 0;
    let lx = look.x, ly = look.y, spread = 1, wave = 0.45, hang = false, fx = [];
    const raise = [];
    if (mood === 'tight') { brow = 'worry'; mouth = 'flat'; if (c.nervous) { fx.push('sweat'); mouth = t % 6 < 3 ? 'open' : 'small'; sq = t % 4 < 2 ? 0.8 : 0; } }
    if (mood === 'empty') { eyes = 'tired'; mouth = 'frown'; dy = 4; sq = 1.5; wave = 0.1; fx.push('puddle', 'dots'); }
    if (sleep) { eyes = 'closed'; mouth = 'small'; dy = 4; sq = 1 + breath; wave = 0; fx = ['zzz']; lx = 0; ly = 0; brow = null; }
    if (c.state === 'doze' && !a) { const f = t % 40, nod = f < 30 ? Math.min(3, f / 8) : 0; eyes = f < 10 ? 'half' : f < 29 ? 'closed' : f < 33 ? 'open' : 'half'; mouth = 'small'; dy = 1 + Math.round(nod); wave = 0.15; lx = 0; ly = 0.5; brow = null; fx = f > 14 && f < 29 ? ['zsmall'] : []; }
    if (work) { wave = 0.9; dy = Math.floor(t / 4) % 2; const w = Math.floor(t / 10) % n; lx = [-2, 2, 2][w]; ly = [-1, -1, 1.5][w]; if (n >= 2 && mood === 'ok') brow = 'focus'; }
    switch (a) {
      case 'bubbles': mouth = 'o'; fx.push('bubbles'); break;
      case 'shimmer': eyes = 'happy'; mouth = 'open'; fx.push('sparkles'); break;
      case 'wave': eyes = 'happy'; mouth = 'open'; raise.push('hi'); break;
      case 'stretch': { const s = Math.sin(Math.PI * at / 24); spread = 1 + s * 0.7; sq = -s * 1.5; eyes = 'closed'; mouth = 'yawn'; yawn = s * 3; break; }
      case 'startle': dy = JUMP[at] || 0; eyes = 'wide'; mouth = 'o'; brow = null; fx = ['exclaim', 'ink']; wave = 0.2; break;
      case 'drag': dy = -4 + Math.round(Math.sin(t * 0.5)); hang = true; eyes = 'open'; brow = 'worry'; mouth = 'o'; fx = []; break;
      case 'land': sq = [3, 2.2, 1.2, 0.5, 0, 0][at] ?? 0; dy = 0; eyes = at < 3 ? 'closed' : 'open'; fx = ['dust']; break;
      case 'celebrate': { const f = at % 12; dy = [0, 0, -3, -6, -8, -8, -6, -3, 0, 0, 0, 0][f]; sq = f === 1 || f === 8 ? 1.8 : 0; eyes = 'happy'; mouth = 'open'; brow = null; raise.push('upL', 'upR'); fx = ['hearts', 'sparkles', 'confetti']; break; }
      case 'yawn': { const s = Math.sin(Math.PI * Math.min(1, at / 15)); eyes = 'closed'; mouth = 'yawn'; yawn = s * 3; dy = Math.round(at / 18 * 4); fx = []; brow = null; break; }
      case 'wake': eyes = at < 10 ? 'closed' : 'open'; raise.push('rub'); mouth = 'small'; fx = []; dy = 4 - Math.round(at / 14 * 4); brow = null; break;
      case 'restock': eyes = at > 18 ? 'happy' : 'open'; mouth = 'open'; fx = ['sparkles']; brow = null; dy = 0; sq = 0; break;
      case 'poke': sq = [2.6, 2.2, 1.6, 1, 0.5, 0.2][at] ?? 0; eyes = at < 8 ? 'squeeze' : 'open'; mouth = at < 4 ? 'o' : 'frown'; brow = at >= 8 ? 'worry' : null; fx = ['anger']; wave = 1.2; break;
      case 'lookaround': lx = [-2, -2, 2, 2, -2, 2, -2, 0][Math.floor(at / 4)] ?? 0; ly = -0.5; mouth = 'o'; brow = null; fx = ['question']; break;
      case 'flop': eyes = 'closed'; mouth = 'small'; dy = Math.min(4, Math.round(at * 0.4)); sq = Math.min(1.5, at * 0.15); wave = 0; brow = null; fx = at >= 9 ? ['dust'] : []; break;
    }
    const shake = (mood === 'tight' && c.nervous && !a && t % 12 < 3) || (a === 'poke' && at < 6) ? (t % 2 ? 1 : -1) : 0;
    const lean = c.state === 'idle' && !a && mood !== 'empty' ? clamp(Math.round(lx * 0.4), -1, 1) : 0;
    const cx = 36 + shake + lean, cy = 21 + dy;
    const F = cx + Math.round(lx * 0.6), fy = Math.round(ly * 0.6), mF = x => 2 * F - 1 - x;
    const baseY = cy + 10 - sq, tips = [], cups = [];
    if (fx.includes('puddle')) { ell(g, 36, 53.6, 18, 2.4, P.ink, false); rect(g, 26, 53, 6, 1, P.inkL); }
    if (fx.includes('ink') && at < 12) for (const [ox, oy, rr] of [[0, 0, 1], [-4, 2, 0.7], [3, 3, 0.6]]) { const r = (2 + at * 0.45) * rr; ell(g, cx - 16 - at * 0.6 + ox, cy + 20 - at * 0.3 + oy, r, r * 0.8, at < 8 ? P.ink : P.inkL, false); }
    layer(g, P.o, { [P.body]: P.bodyD }, l => {
      OFFS.forEach((ox, k) => {
        const side = Math.sign(ox), bx = cx + ox, by = baseY;
        const slot = work ? [0, 5, 4].slice(0, n).indexOf(k) : -1;
        if (slot >= 0) {
          const tip = [[cx - 22, cy - 2], [cx + 22, cy - 2], [cx + 23, cy + 20]][slot];
          curveArm(l, [bx, by], [[cx - 20, cy + 14], [cx + 20, cy + 14], [cx + 18, cy + 26]][slot], tip, 3, 1.6, P.body, t);
          tips.push(tip); return;
        }
        if ((raise.includes('upL') && k === 0) || ((raise.includes('upR') || raise.includes('hi')) && k === 5)) {
          const sway = Math.sin(t * 0.9) * 3;
          curveArm(l, [bx, by], [cx + side * 21, cy + 10], [cx + side * 19 + (k === 5 ? sway : -sway), cy - 12], 3, 1.6, P.body, t); return;
        }
        if (raise.includes('rub') && (k === 1 || k === 4)) {
          const osc = [-1, 0, 1, 0][(at >> 1) % 4];
          curveArm(l, [bx, by], [cx + side * 14, cy + 18], [F + (k === 1 ? -6.5 : 6.5), cy + osc], 3, 1.8, P.body, t); return;
        }
        for (let j = 0; j <= 16; j++) {
          const u = j / 16;
          let x = bx + side * j * 0.22 * spread + (hang ? Math.sin(t * 0.5 + k) * u * 1.5 : Math.sin(t * wave + j * 0.5 + k * 1.3) * (0.5 + u * 1.3));
          let y = by + j * (hang ? 1.1 : 1);
          if (!hang && j > 12) { x += side * (j - 12) * 0.8; y -= (j - 12) * 0.6; }
          const r = 3 - u * 1.6;
          ell(l, x, y, r, Math.max(1.2, r * 0.8), P.body);
          if (j === 7 || j === 10 || j === 13) cups.push([x - side * 0.5, y + 0.5]);
        }
      });
      ell(l, cx, cy, 14 + Math.max(0, sq) * 0.8, 12.5 - sq, P.body);
    });
    cups.forEach(([x, y]) => put(g, x, y, P.spot));
    [[-9, -6], [-8, -7], [-7, -8], [-6, -8], [-10, -4], [-10, -5]].forEach(([x, y]) => put(g, cx + x, cy + y, P.bodyL));
    const so = Math.round(Math.max(0, sq) * 0.5);
    [[6, -8], [7, -8], [6, -7], [7, -7], [10, -3], [10, -2], [2, -10], [-3, -10], [11, 1]].forEach(([x, y]) => put(g, cx + x, cy + y + so, P.spot));
    const ey = cy - 2 + fy, lxE = F - 9, rxE = F + 5;
    if (eyes === 'open') {
      layer(g, P.o, null, l => { rect(l, lxE, ey, 4, 5, P.w, true); rect(l, rxE, ey, 4, 5, P.w, true); });
      const px = clamp(Math.round(1 + lx * 0.6), 0, 2), py = clamp(Math.round(1 + ly * 0.8), 0, 2);
      for (const x of [lxE, rxE]) { rect(g, x + px, ey + py, 2, 3, P.eye); put(g, x + px, ey + py, P.w); }
    } else eyes2(g, lxE, rxE, ey, 4, 5, eyes, P);
    if (brow) brows(g, lxE, rxE, 4, ey - 2, brow, P.o);
    mouthAt(g, F, cy + 6 + fy, mouth, P, yawn, false);
    [F - 12, F - 11].forEach(x => { put(g, x, cy + 3 + fy, P.pink); put(g, mF(x), cy + 3 + fy, P.pink); });
    tips.forEach((tip, i) => laptop(g, tip[0], tip[1], t, i, P));
    if (a === 'restock') {
      const fillY = Math.round(H - H * Math.min(1, at / 28)), src = OCT_PAL.ok, gr = OCT_PAL.empty;
      const map = { [src.body]: gr.body, [src.bodyD]: gr.bodyD, [src.bodyL]: gr.bodyL, [src.spot]: gr.spot };
      for (let i = 0; i < fillY * W; i++) if (map[g.c[i]]) g.c[i] = map[g.c[i]];
    }
    for (const f of fx) switch (f) {
      case 'sweat': sweat(g, cx + 15, cy - 10); break;
      case 'dots': bubble(g, cx + 9, cy - 20, P.o); break;
      case 'zzz': zzz(g, cx + 14, cy - 10, t); break;
      case 'zsmall': glyph(g, Z4, cx + 14, cy - 10 - ((t >> 3) % 2), '#8C97B0'); break;
      case 'exclaim': exclaim(g, cx + 17, Math.max(1, cy - 16)); break;
      case 'question': question(g, cx + 16, Math.max(1, cy - 18 + ((t >> 2) % 2))); break;
      case 'anger': anger(g, cx + 14, Math.max(1, cy - 14)); break;
      case 'bubbles': for (let b = 0; b < 3; b++) { const age = at - b * 8; if (age >= 0 && age < 20) ring(g, Math.round(F + 3 + b + Math.sin(age * 0.5) * 1.5), Math.round(cy + 6 - age * 1.3), age > 8 ? 2 : 1); } break;
      case 'hearts': heart(g, cx + 16, Math.max(1, cy - 16) + ((t >> 1) % 2)); heart(g, cx - 21, Math.max(1, cy - 10) + ((t >> 1) % 2 ? 0 : 1)); break;
      case 'sparkles': sparkles(g, t, [[6, 8], [64, 6], [66, 30], [5, 34]]); break;
      case 'confetti': confetti(g, at); break;
      case 'dust': dust(g, cx, 53, a === 'flop' ? at - 9 : at); break;
    }
  }

  const PETS = { squirrel, hamster, octopus };
  const DUR = {
    common: { startle: 14, land: 6, celebrate: 36, yawn: 18, wake: 14, restock: 40, look: 30, poke: 12, lookaround: 32, flop: 14, wave: 26 },
    squirrel: { nibble: 36, groom: 28, tail: 26, scratch: 22 },
    hamster: { wash: 28, stuff: 30, stretch: 22 },
    octopus: { bubbles: 30, shimmer: 24, wave: 26, stretch: 24 },
  };
  const FIDGETS = { squirrel: ['nibble', 'groom', 'look', 'tail', 'scratch'], hamster: ['wash', 'stuff', 'stretch', 'look'], octopus: ['bubbles', 'shimmer', 'wave', 'stretch'] };
  function durOf(name, a) { return DUR[name][a] ?? DUR.common[a] ?? 0; }
  function drawPet(name, c) {
    const g = grid(), a = c.action;
    // 影子：被拎着、贴边藏着、侧着跑来跑去（松鼠搬橡果、仓鼠跑轮子）的时候不画
    const running = c.state === 'work' && !OVERRIDE.has(a) && name !== 'octopus';
    if (a !== 'drag' && !c.mini && !running) shadow(g, name === 'squirrel' ? 37 : 36, c.state === 'idle' && !a ? clamp(Math.round((c.look?.x || 0) * 0.5), -1, 1) : 0, name === 'octopus' ? 48.6 : 54.6);
    PETS[name](g, c);
    return g;
  }

  /** 身体占的格子 [左, 上, 右, 下]（含边，不算松鼠身边的橡果堆）：极简模式探头时绕脚底中点歪、按身宽算探出去多少。 */
  const BODY = { squirrel: [23, 7, 64, 54], hamster: [18, 22, 53, 54], octopus: [15, 8, 54, 46] };

  const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const LABELS = { nibble: '啃橡果', groom: '洗脸', look: '张望', tail: '理尾巴', scratch: '挠耳朵', wash: '洗脸', stuff: '塞腮帮', stretch: '伸懒腰', bubbles: '吐泡泡', shimmer: '变色', wave: '打招呼', startle: '吓一跳', drag: '被拎起来', land: '落地', celebrate: '庆祝', yawn: '打哈欠', wake: '揉眼睛', restock: '补满额度', poke: '被戳了一下', lookaround: '东张西望', flop: '倒头就睡' };

  /*
   * 睡眠序列：电脑 DOZE_AFTER 秒没人动（键盘鼠标都算，主进程每秒报一次）→ 打哈欠 → 打盹点头 DOZE_MS → 一头栽倒 → 睡觉。
   * 一有动静：睡着的先吓一跳再揉眼睛，打盹的揉揉眼睛就醒了。有任务在跑不犯困。
   * 主进程那边电脑 5 分钟没人动会直接给 sleep（petMode），这里一样按睡着处理。
   */
  const DOZE_AFTER = 60, DOZE_MS = 30_000;

  /**
   * 点击计数：两下之间不超过 gap 毫秒算连点。第 2 下是双击（戳一下），第 4 下东张西望；
   * 只点了一下要等 gap 过去、确定不是双击才算单击（打开对话气泡）。
   */
  class Clicks {
    constructor(gap = 300) { this.gap = gap; this.n = 0; this.last = -Infinity; }
    press(now) { this.n = now - this.last <= this.gap ? this.n + 1 : 1; this.last = now; return this.n; }
    /** gap 过去之后：这一串一共点了几下（还没过 gap 返回 0）；读过就清零。 */
    settle(now) { if (!this.n || now - this.last <= this.gap) return 0; const n = this.n; this.n = 0; return n; }
  }

  /** 一只宠物的动作节奏：正在做的动作做到第几帧、下一个随机小动作还有多久、眼睛看向哪里。 */
  class Controller {
    constructor(name) {
      this.name = name; this.t = 0; this.action = null; this.at = 0; this.from = 0;
      this.look = { x: 0, y: 0 }; this.target = { x: 0, y: 0 }; this.aimedAt = 0;
      this.fidgetIn = rand(60, 140); this.fidgetIdx = rand(0, 4);
      this.now = 0; this.nervousAt = 0; this.nervousUntil = 0;
      /** awake / doze / asleep：睡眠序列走到哪了。idleSec 是主进程报来的电脑没人动的秒数（没报过就一直醒着）。 */
      this.drowse = 'awake'; this.dozeSince = 0; this.idleSec = 0; this.mode = null;
      /** 当前动作做完接着做的（吓醒之后揉眼睛）。 */
      this.queue = [];
    }
    /** 主进程报来电脑多久没人动了。秒数变小＝有人动了：犯困的醒过来。 */
    idle(seconds) {
      const active = seconds < this.idleSec || seconds < 1;
      this.idleSec = seconds;
      if (active) this.rouse();
    }
    /** 醒过来：睡着的吓一跳再揉眼睛，打盹的揉揉眼睛。 */
    rouse() {
      if (this.drowse === 'asleep') { this.trigger('startle'); this.queue = ['wake']; }
      else if (this.drowse === 'doze') this.trigger('wake');
      this.drowse = 'awake';
    }
    /** 主进程给的模式变了：idle / work / sleep。 */
    setMode(mode) {
      const prev = this.mode;
      this.mode = mode;
      if (prev == null) { if (mode === 'sleep') this.drowse = 'asleep'; return; }
      if (prev === mode) return;
      if (mode === 'sleep') { if (this.drowse !== 'asleep') { this.trigger('yawn'); this.queue = []; } this.drowse = 'asleep'; }
      else if (prev === 'sleep' || mode === 'work') this.rouse();
    }
    /** 画哪种状态：主进程说干活就干活；说睡觉或者自己已经睡着了就睡；在打盹就打盹。 */
    stateOf(ctx) {
      if (ctx.state === 'work') return 'work';
      if (ctx.state === 'sleep' || this.drowse === 'asleep') return 'sleep';
      return this.drowse === 'doze' ? 'doze' : ctx.state;
    }
    drowseTick(ctx, now) {
      if (ctx.state !== 'idle' || ctx.mini || this.action) return;
      if (this.drowse === 'awake' && this.idleSec >= DOZE_AFTER) { this.trigger('yawn'); this.drowse = 'doze'; this.dozeSince = now; }
      else if (this.drowse === 'doze' && now - this.dozeSince >= DOZE_MS) { this.trigger('flop'); this.drowse = 'asleep'; }
    }
    /**
     * 额度紧张时隔一阵紧张一下：冒汗、喘气 2～3 秒，然后恢复平静。刚变紧张时过一两秒来一次，之后每 20～40 秒一次，
     * 剩不到 10% 时 15～25 秒一次。睡觉、做动作（拖动、庆祝……）的时候不插进来。按真实时间算，「减少动画」时节奏也一样。
     */
    nervousTick(ctx, now) {
      if (moodOf(ctx) !== 'tight' || this.stateOf(ctx) === 'sleep') { this.nervousAt = this.nervousUntil = 0; return; }
      if (!this.nervousAt) this.nervousAt = now + rand(1000, 2500);
      if (now < this.nervousAt || this.action) return;
      this.nervousUntil = now + rand(2000, 3000);
      this.nervousAt = this.nervousUntil + (ctx.quota < 10 ? rand(15000, 25000) : rand(20000, 40000));
    }
    get nervous() { return this.now < this.nervousUntil && !this.action; }
    trigger(action, from) { this.action = action; this.at = 0; if (from != null) this.from = from; }
    /** 随机小动作：空闲时每 20 到 60 秒一个，几种轮着来。 */
    fidget() { const list = FIDGETS[this.name] || []; if (!list.length) return; this.trigger(list[this.fidgetIdx++ % list.length]); this.fidgetIn = rand(200, 600); }
    /** 鼠标相对宠物身体中心的位置（屏幕像素）。 */
    aim(dx, dy, now = Date.now()) { this.target = { x: clamp(dx / 110, -2, 2), y: clamp(dy / 110, -1.5, 1.5) }; this.aimedAt = now; }
    tick(ctx, now = Date.now()) {
      this.t++;
      if (this.action) {
        this.at++;
        const d = durOf(this.name, this.action);
        if (d && this.at >= d) { this.action = null; this.at = 0; if (this.queue.length) this.trigger(this.queue.shift()); }
      } else if (ctx.fidget !== false && this.stateOf(ctx) === 'idle' && !ctx.mini && moodOf(ctx) !== 'empty' && --this.fidgetIn <= 0) this.fidget();
      this.now = now;
      this.drowseTick(ctx, now);
      this.nervousTick(ctx, now);
      // 鼠标几秒没动：偶尔自己东张西望
      if (now - this.aimedAt > 4000 && this.t % 40 === 0) this.target = Math.random() < 0.5 ? { x: 0, y: 0 } : { x: Math.random() * 3 - 1.5, y: Math.random() - 0.6 };
      this.look.x += (this.target.x - this.look.x) * 0.3; this.look.y += (this.target.y - this.look.y) * 0.3;
    }
    frame(ctx) { return drawPet(this.name, { ...ctx, state: this.stateOf(ctx), t: this.t, action: this.action, at: this.at, look: this.look, from: this.from, nervous: ctx.nervous ?? this.nervous }); }
  }

  /** 把一帧画到 canvas 上：每个像素格画成 scale × scale 的方块。 */
  function paint(canvas, g, scale) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < W * H; i++) { const c = g.c[i]; if (!c) continue; ctx.fillStyle = c; ctx.fillRect((i % W) * scale, Math.floor(i / W) * scale, scale, scale); }
  }

  root.PulsePet = { W, H, BODY, drawPet, FIDGETS, OVERRIDE, LABELS, durOf, Controller, Clicks, DOZE_AFTER, DOZE_MS, paint };
})(typeof window !== 'undefined' ? window : globalThis);
