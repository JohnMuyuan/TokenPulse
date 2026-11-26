'use strict';
/*
 * 桌宠高清平滑极简键鼠互动桌面（0.3.115）：
 * - 直接驱动每只宠物「原本就有的双手」，绝不凭空再长一条多余长手臂：
 *   1. Clawd 小螃蟹（及类似带左右小方块手的 SVG 主题）：直接隐藏静止侧边方块并把那两块完全同尺寸同色的珊瑚小方块手
 *      移到键盘、鼠标和眼睛上方——拍键倾斜、推鼠标滑行、输密码抬起捂眼，原汁原味零违和；
 *   2. 松鼠栗栗 / 仓鼠豆豆：藏起胸前静止小爪，直接把松鼠自己的暖棕圆爪 / 仓鼠自己的粉嫩小爪放到键鼠与眼睛上互动；
 *   3. 章鱼墨墨：藏起静止最外侧两条触手（k=0, 5），直接用它自己同配色的珊瑚粉/淡桃/灰紫触手拍键、滑鼠标、捂眼；
 *   4. 其他自定义图片/无独立手元素主题：回退为宠物主色短圆哑光小手团子。
 * - 轻盈悬浮的高清平滑微透视 60% 极简无密字键盘 + 紧贴右侧的圆润小鼠标（左薄荷绿 / 右珊瑚橙分色高亮 + 滚轮）；
 * - 宠物本体随敲键/动鼠标轻微弹簧侧移、倾身与弹跳，3D 弹性键帽飘字气泡 + LMB/RMB 微标；
 * - 密码框自动捂眼（UIA Edit+高度过滤 + Win32 ES_PASSWORD 防误报）与方案 A AI 工作融合。
 */
(function (root) {
  const W = 72, H = 56;
  const LW = 288, LH = 224; // 高清平滑逻辑画布（= 4 × 72×56）
  const U = 4;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  const ACTIVE_HOLD_MS = 2600;
  const TAP_MS = 145;
  const MOUSE_BUSY_MS = 820;
  const FLOAT_MS = 760;
  const FLOAT_REDUCED_MS = 340;
  const MAX_FLOATS = 14;

  /** 桌面点击命中范围（72×56 像素格坐标，覆盖悬浮键盘 + 右侧小鼠标）。 */
  const DESK_HIT_BOX = [5, 42, 68, 55];

  /** 内置宠物与默认眼睛位置（72×56 像素格）。 */
  const DEFAULT_EYES = {
    squirrel: { cx: 36, cy: 23, halfSpan: 5.5 },
    hamster: { cx: 36, cy: 32, halfSpan: 5.5 },
    octopus: { cx: 36, cy: 21, halfSpan: 6.5 },
    custom: { cx: 36, cy: 34, halfSpan: 7.5 },
  };

  /** 极简悬浮键盘与紧邻右侧小鼠标布局（整体以宠物中心 x=144 紧凑摆放）。 */
  const KB = {
    cx: 120,
    cy: 194,
    w: 176,
    h: 43,
    topHalfW: 83,
    botHalfW: 90,
    padX: 7.5,
    padY: 5.5,
  };
  const MOUSE = {
    baseX: 236,
    baseY: 195,
    rx: 17,
    ry: 20.5,
    rangeX: 26, // ±13 逻辑单位（同向右移清晰流畅，又紧邻宠物不拉扯）
    rangeY: 13,
  };

  function projectKb(u, v, bounceY = 0) {
    const halfH = KB.h / 2 - KB.padY;
    const halfW = lerp(KB.topHalfW - KB.padX, KB.botHalfW - KB.padX, v);
    return {
      x: KB.cx + (u * 2 - 1) * halfW,
      y: KB.cy + bounceY + (v * 2 - 1) * halfH,
      halfW,
    };
  }

  /**
   * 面向宠物视角的 180° 翻转极简 60% 键盘（r=0..3 对应原按键逻辑排，绘制时 180° 翻转）：
   * - 最上排（最贴近宠物）：宽大空格条 + 左侧方向键 + 右侧修饰键；
   * - 中上排：ZXCV 排（左右反转）；
   * - 中下排：ASDF 排（Enter 暖橙键在画面左侧 = 宠物右手边！）；
   * - 最底排（最靠近观众）：QWERTY / 数字排（Esc 在右下、Backspace 在左下）。
   */
  const ROW_LAYOUTS = [
    [
      { u0: 0.00, u1: 0.11, accent: 'mod' },
      { u0: 0.11, u1: 0.21 }, { u0: 0.21, u1: 0.31 }, { u0: 0.31, u1: 0.41 },
      { u0: 0.41, u1: 0.51 }, { u0: 0.51, u1: 0.61 }, { u0: 0.61, u1: 0.71 },
      { u0: 0.71, u1: 0.82 },
      { u0: 0.82, u1: 1.00, accent: 'mod' },
    ],
    [
      { u0: 0.00, u1: 0.12 }, { u0: 0.12, u1: 0.22 }, { u0: 0.22, u1: 0.32 },
      { u0: 0.32, u1: 0.42 }, { u0: 0.42, u1: 0.52 }, { u0: 0.52, u1: 0.62 },
      { u0: 0.62, u1: 0.72 }, { u0: 0.72, u1: 0.83 },
      { u0: 0.83, u1: 1.00, accent: 'enter' },
    ],
    [
      { u0: 0.00, u1: 0.14, accent: 'mod' }, { u0: 0.14, u1: 0.24 }, { u0: 0.24, u1: 0.34 },
      { u0: 0.34, u1: 0.44 }, { u0: 0.44, u1: 0.54 }, { u0: 0.54, u1: 0.64 },
      { u0: 0.64, u1: 0.74 }, { u0: 0.74, u1: 0.85 }, { u0: 0.85, u1: 1.00, accent: 'mod' },
    ],
    [
      { u0: 0.00, u1: 0.18, accent: 'mod' },
      { u0: 0.18, u1: 0.74, space: true },
      { u0: 0.74, u1: 0.87 },
      { u0: 0.87, u1: 1.00 },
    ],
  ];

  function slotIndexFor(row, col) {
    const r = clamp(Math.round(row || 0), 0, 3);
    const c = clamp(Math.round(col || 0), 0, 8);
    if (r === 3) {
      if (c <= 1) return 0;
      if (c <= 6) return 1;
      if (c === 7) return 2;
      return 3;
    }
    return clamp(c, 0, ROW_LAYOUTS[r].length - 1);
  }

  /** 按 180° 面向宠物视角投影键帽中心（row=3 空格排在最上方靠近宠物，左右镜像翻转）。 */
  function keyRect(row, col) {
    const r = clamp(Math.round(row || 0), 0, 3);
    const sIdx = slotIndexFor(r, col);
    const spec = ROW_LAYOUTS[r][sIdx];
    const uPet = 1 - (spec.u0 + spec.u1) * 0.5;
    const visRow = 3 - r;
    const v = (visRow + 0.5) / 4;
    const pt = projectKb(uPet, v, 0);
    return {
      x: pt.x - ((spec.u1 - spec.u0) * KB.w) * 0.45,
      y: pt.y - 4,
      w: (spec.u1 - spec.u0) * KB.w * 0.9,
      h: 8,
      cx: pt.x,
      cy: pt.y,
      r,
      sIdx,
    };
  }

  function parseColor(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const s = raw.trim();
    let m = /^#([0-9a-f]{3,4})$/i.exec(s);
    if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16)];
    m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(s);
    if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
    m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    return null;
  }
  const hex2 = n => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  const toHex = ([r, g, b]) => '#' + hex2(r) + hex2(g) + hex2(b);
  const toRgba = ([r, g, b], a) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
  const mix = (rgb, target, t) => [lerp(rgb[0], target[0], t), lerp(rgb[1], target[1], t), lerp(rgb[2], target[2], t)];

  /** 与 pet-engine.js / Clawd SVG 1:1 对齐的原生小手配色。 */
  function pawPalette(pet, mood, customColor, crabHint) {
    if (pet === 'squirrel') {
      // 完全复用 SQ：fur=#C8703A, furD=#9A4E22, o=#2B170C
      return { fill: '#C8703A', shade: '#9A4E22', stroke: '#2B170C', strokeRgb: [43, 23, 12], pad: '#F8E2BE', crab: false, tentacle: false, style: 'squirrel' };
    }
    if (pet === 'hamster') {
      // 完全复用 HAM：仓鼠原本的小手就是粉嫩嫩的 pink=#F59AAA, pinkD=#D9707F, o=#3B2416！
      return { fill: '#F59AAA', shade: '#D9707F', stroke: '#3B2416', strokeRgb: [59, 36, 22], pad: '#FDEDCF', crab: false, tentacle: false, style: 'hamster' };
    }
    if (pet === 'octopus') {
      // 完全复用 OCT_PAL：ok=#F27D90 珊瑚粉 / tight=#F3B0A6 浅桃 / empty=#ABA9C6 灰紫
      const pal = mood === 'empty'
        ? { fill: '#ABA9C6', shade: '#7F7DA0', pad: '#D8D7E8' }
        : mood === 'tight'
          ? { fill: '#F3B0A6', shade: '#D18A80', pad: '#FFE4DE' }
          : { fill: '#F27D90', shade: '#C9596E', pad: '#FFC6CE' };
      return { ...pal, stroke: '#3A1A2A', strokeRgb: [58, 26, 42], crab: false, tentacle: true, style: 'octopus' };
    }
    const rgb = parseColor(customColor) || [222, 136, 109]; // Clawd #DE886D
    const isWarmCoral = rgb[0] >= 180 && rgb[1] >= 75 && rgb[1] <= 165 && rgb[2] <= 135 && rgb[0] - rgb[2] >= 65;
    const sr = mix(rgb, [74, 30, 20], 0.48);
    return {
      rgb,
      fill: toHex(rgb),
      shade: toHex(mix(rgb, [80, 32, 22], 0.14)),
      strokeRgb: sr,
      stroke: toHex(sr),
      pad: toHex(mix(rgb, [255, 240, 234], 0.45)),
      crab: Boolean(crabHint || isWarmCoral),
      tentacle: false,
      style: 'custom',
    };
  }

  /** 5 款内置键鼠样式元数据（全部 100% 原创 Canvas 2D 矢量绘制）。 */
  const DESK_STYLES = [
    { id: 'white', name: '极简纯白', line: '纯白 60% 键盘与圆润小鼠标，清爽百搭' },
    { id: 'obsidian', name: '曜石黑', line: '哑光黑铝底座配冰蓝按压高亮，沉稳耐看' },
    { id: 'esports', name: '电竞 RGB', line: '流光霓虹灯带与彩光键帽，电竞氛围拉满' },
    { id: 'apple', name: '苹果银白', line: '纤薄阳极银铝机身、孤岛平键与无缝触控鼠标' },
    { id: 'cyber', name: '未来悬浮', line: '全息透明玻璃、能量光影底座与悬浮科技感' },
  ];
  const DESK_STYLE_IDS = DESK_STYLES.map(s => s.id);
  const DEFAULT_EFFECTS = { rgbBorder: false, hoverFloat: false, holoGrid: false, magicMouse: false, slimKeys: false, glow: 0 };

  const customImageCache = new Map();
  function getCustomImage(src, onLoad) {
    if (!src || typeof src !== 'string' || typeof Image !== 'function') return null;
    let entry = customImageCache.get(src);
    if (!entry) {
      entry = { img: new Image(), ready: false, failed: false, listeners: new Set() };
      entry.img.onload = () => {
        entry.ready = true;
        for (const fn of entry.listeners) { try { fn(); } catch { /* ignore */ } }
        entry.listeners.clear();
      };
      entry.img.onerror = () => { entry.failed = true; entry.listeners.clear(); };
      entry.img.src = src;
      customImageCache.set(src, entry);
      if (customImageCache.size > 48) {
        const firstKey = customImageCache.keys().next().value;
        if (firstKey) customImageCache.delete(firstKey);
      }
    }
    if (entry.ready && entry.img.naturalWidth > 0) return entry.img;
    if (!entry.failed && typeof onLoad === 'function') entry.listeners.add(onLoad);
    return null;
  }

  function deskPalette(theme) {
    if (theme === 'dark') {
      return {
        shadow: 'rgba(0, 0, 0, 0.36)',
        kbRim: '#11151d', kbBodyTop: '#242a36', kbBodyBot: '#1b202b', kbStroke: 'rgba(255,255,255,0.14)',
        kbWell: '#141821',
        keyTop: '#f3f6fb', keySide: '#b8c1d1', keyStroke: '',
        keyActive: '#47d6a0', keyActiveSide: '#1f8f66',
        mouseRim: '#11151d', mouseTop: '#d7dde8', mouseBot: '#bcc5d6', mouseBtnIdle: '#e3e8f2',
        mouseStroke: 'rgba(15, 20, 28, 0.78)', mouseSeam: 'rgba(24, 30, 42, 0.44)',
        mouseLeft: '#47d6a0', mouseRight: '#ff8254',
        wheelWell: '#232833', wheel: '#7d879b', mouseLabel: 'rgba(92, 100, 114, 0.52)',
        floatSide: '#141923', floatTop: '#222938', floatStroke: 'rgba(71, 214, 160, 0.75)', floatText: '#f4f7fb',
        privacyFill: 'rgba(15, 20, 32, 0.80)', privacyStroke: 'rgba(244, 114, 182, 0.55)', privacyText: '#fbcfe8',
        aiBg: 'rgba(26, 32, 44, 0.94)', aiStroke: 'rgba(148, 163, 184, 0.45)', aiAccent: '#47d6a0', aiWarn: '#f0b85a', aiDot: '#cbd5e1',
        glow: '#47d6a0',
      };
    }
    return {
      shadow: 'rgba(24, 32, 48, 0.16)',
      kbRim: '#b8bec9', kbBodyTop: '#f5f6f8', kbBodyBot: '#e5e8ee', kbStroke: 'rgba(55, 64, 80, 0.42)',
      kbWell: '#cfd4de',
      keyTop: '#ffffff', keySide: '#d0d5df', keyStroke: '',
      keyActive: '#26b984', keyActiveSide: '#15835b',
      mouseRim: '#bcc2cd', mouseTop: '#f1f3f6', mouseBot: '#e4e7ee', mouseBtnIdle: '#ffffff',
      mouseStroke: 'rgba(48, 54, 66, 0.60)', mouseSeam: 'rgba(52, 58, 70, 0.38)',
      mouseLeft: '#26b984', mouseRight: '#ff7b47',
      wheelWell: '#353a46', wheel: '#8b92a1', mouseLabel: 'rgba(92, 100, 114, 0.48)',
      floatSide: '#c6ccd6', floatTop: '#ffffff', floatStroke: 'rgba(38, 185, 132, 0.65)', floatText: '#1a202c',
      privacyFill: 'rgba(24, 30, 44, 0.78)', privacyStroke: 'rgba(244, 114, 182, 0.58)', privacyText: '#ffe4ef',
      aiBg: 'rgba(255, 255, 255, 0.95)', aiStroke: 'rgba(71, 85, 105, 0.32)', aiAccent: '#1d9b6e', aiWarn: '#d98e2b', aiDot: '#64748b',
      glow: '#26b984',
    };
  }

  function builtInPreset(styleId, theme) {
    const base = deskPalette(theme);
    if (styleId === 'obsidian') {
      return {
        dp: {
          ...base,
          shadow: 'rgba(4, 7, 14, 0.42)',
          kbRim: '#080a0f', kbBodyTop: '#242936', kbBodyBot: '#141821', kbStroke: 'rgba(255, 255, 255, 0.16)',
          kbWell: '#0c0f16',
          keyTop: '#313849', keySide: '#171c26', keyStroke: 'rgba(255, 255, 255, 0.08)',
          keyActive: '#38bdf8', keyActiveSide: '#0369a1',
          mouseRim: '#080a0f', mouseTop: '#272d3b', mouseBot: '#161a24', mouseBtnIdle: '#2e3546',
          mouseStroke: 'rgba(255, 255, 255, 0.18)', mouseSeam: 'rgba(6, 9, 14, 0.76)',
          mouseLeft: '#38bdf8', mouseRight: '#a78bfa',
          wheelWell: '#0d1018', wheel: '#cbd5e1', mouseLabel: 'rgba(226, 232, 240, 0.46)',
          floatSide: '#0e121b', floatTop: '#1e2432', floatStroke: 'rgba(56, 189, 248, 0.78)', floatText: '#f8fafc',
          glow: '#38bdf8',
        },
        effects: { ...DEFAULT_EFFECTS, glow: 0.25 },
      };
    }
    if (styleId === 'esports') {
      return {
        dp: {
          ...base,
          shadow: 'rgba(5, 6, 16, 0.48)',
          kbRim: '#070912', kbBodyTop: '#1b1f30', kbBodyBot: '#0f121e', kbStroke: '#22d3ee',
          kbWell: '#0a0d17',
          keyTop: '#262c42', keySide: '#111423', keyStroke: 'rgba(148, 163, 184, 0.14)',
          keyActive: '#00f5d4', keyActiveSide: '#0d9488',
          mouseRim: '#070912', mouseTop: '#21273b', mouseBot: '#121624', mouseBtnIdle: '#272e44',
          mouseStroke: 'rgba(34, 211, 238, 0.62)', mouseSeam: 'rgba(7, 10, 18, 0.85)',
          mouseLeft: '#00f5d4', mouseRight: '#ff2e97',
          wheelWell: '#0b0e19', wheel: '#f472b6', mouseLabel: 'rgba(226, 232, 240, 0.56)',
          floatSide: '#0d101d', floatTop: '#191e30', floatStroke: 'rgba(0, 245, 212, 0.86)', floatText: '#f8fafc',
          glow: '#00f5d4',
        },
        effects: { ...DEFAULT_EFFECTS, rgbBorder: true, glow: 0.85 },
      };
    }
    if (styleId === 'apple') {
      return {
        dp: {
          ...base,
          shadow: 'rgba(20, 28, 44, 0.15)',
          kbRim: '#9ea8b8', kbBodyTop: '#dfe5ee', kbBodyBot: '#c6cfdD', kbStroke: 'rgba(92, 106, 126, 0.48)',
          kbWell: '#b6c0d0',
          keyTop: '#ffffff', keySide: '#d7dce6', keyStroke: 'rgba(148, 163, 184, 0.36)',
          keyActive: '#007aff', keyActiveSide: '#0055c4',
          mouseRim: '#a9b3c4', mouseTop: '#ffffff', mouseBot: '#eef2f7', mouseBtnIdle: '#ffffff',
          mouseStroke: 'rgba(116, 128, 146, 0.52)', mouseSeam: 'rgba(148, 163, 184, 0.28)',
          mouseLeft: '#007aff', mouseRight: '#ff3b30',
          wheelWell: '#cbd5e1', wheel: '#e2e8f0', mouseLabel: 'rgba(100, 116, 139, 0.34)',
          floatSide: '#cbd5e1', floatTop: '#ffffff', floatStroke: 'rgba(0, 122, 255, 0.62)', floatText: '#111827',
          glow: '#007aff',
        },
        effects: { ...DEFAULT_EFFECTS, magicMouse: true, slimKeys: true, glow: 0 },
      };
    }
    if (styleId === 'cyber') {
      return {
        dp: {
          ...base,
          shadow: 'rgba(14, 165, 233, 0.28)',
          kbRim: 'rgba(6, 78, 110, 0.72)', kbBodyTop: 'rgba(10, 24, 50, 0.84)', kbBodyBot: 'rgba(6, 14, 34, 0.92)', kbStroke: '#22d3ee',
          kbWell: 'rgba(4, 12, 28, 0.66)',
          keyTop: 'rgba(34, 211, 238, 0.22)', keySide: 'rgba(14, 116, 144, 0.56)', keyStroke: 'rgba(103, 232, 249, 0.58)',
          keyActive: '#a5f3fc', keyActiveSide: '#06b6d4',
          mouseRim: 'rgba(14, 116, 144, 0.76)', mouseTop: 'rgba(12, 28, 56, 0.88)', mouseBot: 'rgba(7, 15, 34, 0.94)', mouseBtnIdle: 'rgba(34, 211, 238, 0.14)',
          mouseStroke: '#22d3ee', mouseSeam: 'rgba(56, 189, 248, 0.42)',
          mouseLeft: '#22d3ee', mouseRight: '#c084fc',
          wheelWell: 'rgba(6, 16, 36, 0.92)', wheel: '#67e8f9', mouseLabel: 'rgba(165, 243, 252, 0.62)',
          floatSide: '#082038', floatTop: 'rgba(9, 24, 48, 0.94)', floatStroke: '#22d3ee', floatText: '#e0f2fe',
          glow: '#22d3ee',
        },
        effects: { ...DEFAULT_EFFECTS, hoverFloat: true, holoGrid: true, glow: 0.9 },
      };
    }
    return { dp: base, effects: { ...DEFAULT_EFFECTS } };
  }

  /** 解析最终键鼠样式（内置 5 款 + 可选自定义样式包的颜色/特效/贴图覆盖）。 */
  function resolveStyle(styleId, deskPack, theme = 'light') {
    const pack = deskPack && typeof deskPack === 'object' ? deskPack : null;
    const baseId = pack && DESK_STYLE_IDS.includes(pack.base)
      ? pack.base
      : (DESK_STYLE_IDS.includes(styleId) ? styleId : 'white');
    const preset = builtInPreset(baseId, theme);
    const dp = { ...preset.dp };
    if (pack?.colors && typeof pack.colors === 'object') {
      for (const [k, v] of Object.entries(pack.colors)) {
        if (typeof v === 'string' && v.trim() && k in dp) dp[k] = v.trim();
      }
    }
    const effects = { ...preset.effects };
    if (pack?.effects && typeof pack.effects === 'object') {
      for (const flag of ['rgbBorder', 'hoverFloat', 'holoGrid', 'magicMouse', 'slimKeys']) {
        if (typeof pack.effects[flag] === 'boolean') effects[flag] = pack.effects[flag];
      }
      if (typeof pack.effects.glow === 'number' && Number.isFinite(pack.effects.glow)) {
        effects.glow = clamp(pack.effects.glow, 0, 1);
      }
    }
    const images = pack?.images && typeof pack.images === 'object' ? pack.images : null;
    return { id: pack?.id || baseId, base: baseId, dp, effects, images };
  }

  function isAnimatedStyle(styleId, deskPack) {
    const { effects } = resolveStyle(styleId, deskPack, 'light');
    return Boolean(effects.rgbBorder || effects.hoverFloat);
  }

  class DeskState {
    constructor() {
      this.mx = 0.5;
      this.my = 0.5;
      this.smx = 0.5;
      this.smy = 0.5;
      this.hasMousePos = false;
      this.mouseLeft = false;
      this.mouseRight = false;
      this.mouseLeftPress = 0;
      this.mouseRightPress = 0;
      this.mouseClickAt = 0;
      this.lastMouseActiveAt = -10000;
      this.passwordActive = false;
      this.manualPrivacy = false;
      this.activeUntil = 0;
      this.lastKeyAt = -10000;
      this.coverT = 0;

      // 左右原生小手的平滑坐标与拍键倾斜/弹性
      this.leftPaw = { x: 84, y: 174, tx: 84, ty: 174, rot: 0, trot: 0, squash: 0 };
      this.rightPaw = { x: 204, y: 174, tx: 204, ty: 174, rot: 0, trot: 0, squash: 0 };
      this.leftTap = null;
      this.rightTap = null;
      this.nativeRest = null; // 外部实时测量到的原生左右手默认位置

      this.bodyShiftX = 0;
      this.bodyShiftTarget = 0;
      this.bodyTilt = 0;
      this.bodyTiltTarget = 0;
      this.bodyBob = 0;
      this.kbBounce = 0;

      this.pressed = [];
      this.heldKeys = new Map();
      this.keyPress = new Map();
      this.floats = [];
      this.mouseBadges = [];
      this.lastFrameAt = 0;
    }

    get covering() {
      return this.passwordActive || this.manualPrivacy;
    }

    setPassword(active, now = Date.now()) {
      const next = Boolean(active);
      if (next === this.passwordActive) return false;
      this.passwordActive = next;
      if (next) this._clearInputs();
      this.lastFrameAt = now;
      return true;
    }

    setManualPrivacy(active, now = Date.now()) {
      const next = Boolean(active);
      if (next === this.manualPrivacy) return false;
      this.manualPrivacy = next;
      if (next) this._clearInputs();
      this.lastFrameAt = now;
      return true;
    }

    _clearInputs() {
      this.floats.length = 0;
      this.mouseBadges.length = 0;
      this.pressed.length = 0;
      this.heldKeys.clear();
      this.keyPress.clear();
      this.leftTap = null;
      this.rightTap = null;
    }

    resetInput(now = Date.now()) {
      this.passwordActive = false;
      this.mouseLeft = false;
      this.mouseRight = false;
      this.mouseLeftPress = 0;
      this.mouseRightPress = 0;
      this.activeUntil = 0;
      this._clearInputs();
      this.lastFrameAt = now;
    }

    onMouseMove(mx, my, now = Date.now()) {
      if (!Number.isFinite(mx) || !Number.isFinite(my)) return false;
      const nx = clamp(mx, 0, 1), ny = clamp(my, 0, 1);
      if (!this.hasMousePos) {
        this.hasMousePos = true;
        this.mx = this.smx = nx;
        this.my = this.smy = ny;
        return false;
      }
      const dist = Math.hypot(nx - this.mx, ny - this.my);
      this.mx = nx;
      this.my = ny;
      if (dist >= 0.015) {
        this.lastMouseActiveAt = now;
        this.activeUntil = Math.max(this.activeUntil, now + ACTIVE_HOLD_MS);
        return true;
      }
      return dist > 0.002;
    }

    onMouseButton(left, right, now = Date.now()) {
      const l = Boolean(left), r = Boolean(right);
      const lDown = l && !this.mouseLeft;
      const rDown = r && !this.mouseRight;
      const changed = l !== this.mouseLeft || r !== this.mouseRight;
      this.mouseLeft = l;
      this.mouseRight = r;
      if (lDown || rDown) {
        this.mouseClickAt = now;
        this.lastMouseActiveAt = now;
        this.activeUntil = Math.max(this.activeUntil, now + ACTIVE_HOLD_MS);
        this.rightPaw.squash = Math.max(this.rightPaw.squash, 0.72);
        this.bodyBob = Math.min(1, this.bodyBob + 0.35);
        if (!this.covering) {
          const mp = this.mousePos();
          if (lDown) this._pushMouseBadge('LMB', 'left', mp.x - 8, mp.y - 24, now);
          if (rDown) this._pushMouseBadge('RMB', 'right', mp.x + 8, mp.y - 24, now);
        }
      }
      return changed || lDown || rDown;
    }

    _pushMouseBadge(label, side, x, y, now) {
      this.mouseBadges.push({ label, side, x, y, at: now });
      if (this.mouseBadges.length > 2) this.mouseBadges.shift();
    }

    onKey(ev, now = Date.now()) {
      if (!ev || this.covering) return false;
      const label = typeof ev.key === 'string' && ev.key.trim() ? ev.key.trim().slice(0, 4) : '';
      if (!label) return false;
      const kr = keyRect(ev.row, ev.col);
      const slotKey = `${kr.r}:${kr.sIdx}`;
      const holdId = `${kr.r}:${clamp(Math.round(ev.col || 0), 0, 8)}:${label}`;
      // 长按防重：同一键已处于按住态时绝不重复弹气泡或狂敲，仅延续活跃计时
      if (ev.hold === true && this.heldKeys.has(holdId)) {
        this.activeUntil = Math.max(this.activeUntil, now + ACTIVE_HOLD_MS);
        this.keyPress.set(slotKey, 1);
        return false;
      }
      this.lastKeyAt = now;
      this.activeUntil = Math.max(this.activeUntil, now + ACTIVE_HOLD_MS);
      this.bodyBob = Math.min(1.0, this.bodyBob + 0.52);
      this.kbBounce = Math.min(1.0, this.kbBounce + 0.55);

      const normX = clamp((kr.cx - KB.cx) / (KB.w * 0.48), -1, 1);
      const mouseBusy = this.mouseLeft || this.mouseRight || (now - this.lastMouseActiveAt < MOUSE_BUSY_MS);

      this.pressed.push({ row: kr.r, col: clamp(Math.round(ev.col || 0), 0, 8), slot: kr.sIdx, at: now });
      if (this.pressed.length > 12) this.pressed.shift();
      this.keyPress.set(slotKey, 1);

      // 键盘已 180° 面向宠物：按键帽在画面上的左右区自动选同侧小手（避免双臂交叉），正在用鼠标时由画面左手代敲
      let useHand = kr.cx < KB.cx ? 'left' : 'right';
      if (mouseBusy) useHand = 'left';

      let tx, ty;
      if (useHand === 'left') {
        tx = clamp(kr.cx, 46, mouseBusy ? 168 : 132);
        ty = clamp(kr.cy - 2, 174, 204);
        if (!this.leftTap || now >= this.leftTap.at) {
          this.leftTap = { x: tx, y: ty, at: now };
          this.leftPaw.tx = tx;
          this.leftPaw.ty = ty;
          this.leftPaw.x = lerp(this.leftPaw.x, tx, 0.58);
          this.leftPaw.y = lerp(this.leftPaw.y, ty, 0.58);
          this.leftPaw.rot = -0.34;
          this.leftPaw.squash = 1.0;
        }
      } else {
        tx = clamp(kr.cx, 122, 196);
        ty = clamp(kr.cy - 2, 174, 204);
        if (!this.rightTap || now >= this.rightTap.at) {
          this.rightTap = { x: tx, y: ty, at: now };
          this.rightPaw.tx = tx;
          this.rightPaw.ty = ty;
          this.rightPaw.x = lerp(this.rightPaw.x, tx, 0.58);
          this.rightPaw.y = lerp(this.rightPaw.y, ty, 0.58);
          this.rightPaw.rot = 0.34;
          this.rightPaw.squash = 1.0;
        }
      }

      if (ev.hold === true) {
        this.heldKeys.set(holdId, { slotKey, hand: useHand, x: tx, y: ty, at: now });
      }

      if (!mouseBusy) {
        this.bodyShiftTarget = normX * 4.2;
        this.bodyTiltTarget = normX * 1.6;
      }

      const isSpace = label === '␣';
      const rot = ((this.floats.length % 3) - 1) * 0.055;
      this.floats.push({ key: label, isSpace, x: kr.cx, y: 162, rot, at: now });
      if (this.floats.length > MAX_FLOATS) this.floats.shift();
      return true;
    }

    onKeyUp(ev, now = Date.now()) {
      if (!ev || !this.heldKeys.size) return false;
      const label = typeof ev.key === 'string' && ev.key.trim() ? ev.key.trim().slice(0, 4) : '';
      if (!label) return false;
      const kr = keyRect(ev.row, ev.col);
      const holdId = `${kr.r}:${clamp(Math.round(ev.col || 0), 0, 8)}:${label}`;
      if (!this.heldKeys.delete(holdId)) return false;
      this.activeUntil = Math.max(this.activeUntil, now + 900);
      return true;
    }

    isUserActive(now = Date.now()) {
      return now < this.activeUntil || this.mouseLeft || this.mouseRight || (!this.covering && this.heldKeys.size > 0);
    }

    bodyTransform(scale = 2, now = Date.now(), reducedMotion = false) {
      if (reducedMotion) return { x: 0, y: 0, deg: 0, sx: 1, sy: 1 };
      const k = scale / 2;
      const shy = this.coverT > 0.2 ? Math.sin(now * 0.0046) * 2.2 * this.coverT : 0;
      return {
        x: Math.round(this.bodyShiftX * k * 10) / 10,
        y: Math.round(this.bodyBob * 1.4 * k * 10) / 10,
        deg: Math.round((this.bodyTilt + shy) * 10) / 10,
        sx: 1 + this.bodyBob * 0.018,
        sy: 1 - this.bodyBob * 0.015,
      };
    }

    step(now = Date.now(), reducedMotion = false) {
      const dtMs = this.lastFrameAt ? clamp(now - this.lastFrameAt, 1, 80) : 16;
      const dt = dtMs / 1000;
      this.lastFrameAt = now;

      const mk = 1 - Math.exp(-dt * 24);
      this.smx = lerp(this.smx, this.mx, mk);
      this.smy = lerp(this.smy, this.my, mk);

      const btnRate = 1 - Math.exp(-dt * 26);
      this.mouseLeftPress = lerp(this.mouseLeftPress, this.mouseLeft ? 1 : 0, btnRate);
      this.mouseRightPress = lerp(this.mouseRightPress, this.mouseRight ? 1 : 0, btnRate);
      if (this.mouseLeftPress < 0.01 && !this.mouseLeft) this.mouseLeftPress = 0;
      if (this.mouseRightPress < 0.01 && !this.mouseRight) this.mouseRightPress = 0;

      const targetCover = this.covering ? 1 : 0;
      const ck = reducedMotion ? 1 : (1 - Math.exp(-dt * 16));
      this.coverT = lerp(this.coverT, targetCover, ck);
      if (Math.abs(this.coverT - targetCover) < 0.015) this.coverT = targetCover;

      const hasHeld = !this.covering && this.heldKeys.size > 0;
      if (hasHeld) this.activeUntil = Math.max(this.activeUntil, now + ACTIVE_HOLD_MS);
      const typingNow = !this.covering && (now - this.lastKeyAt < 340 || hasHeld);
      const mouseBusy = !this.covering && (this.mouseLeft || this.mouseRight || now - this.lastMouseActiveAt < MOUSE_BUSY_MS);
      const mouseMovingNow = !this.covering && (this.mouseLeft || this.mouseRight || now - this.lastMouseActiveAt < 280);
      if (this.covering) {
        this.bodyShiftTarget = 0;
        this.bodyTiltTarget = 0;
      } else if (mouseMovingNow) {
        // 仅在主动操作鼠标时轻微侧移，保持脑袋端正不歪斜
        this.bodyShiftTarget = 4.5 + (this.smx - 0.5) * 3.2;
        this.bodyTiltTarget = 0;
      } else if (!typingNow) {
        this.bodyShiftTarget = 0;
        this.bodyTiltTarget = 0;
      }
      const bk = 1 - Math.exp(-dt * 11);
      this.bodyShiftX = lerp(this.bodyShiftX, this.bodyShiftTarget, bk);
      this.bodyTilt = lerp(this.bodyTilt, this.bodyTiltTarget, bk);
      if (Math.abs(this.bodyShiftX) < 0.05 && this.bodyShiftTarget === 0) this.bodyShiftX = 0;
      if (Math.abs(this.bodyTilt) < 0.05 && this.bodyTiltTarget === 0) this.bodyTilt = 0;
      this.bodyBob *= Math.exp(-dt * 14);
      if (this.bodyBob < 0.01) this.bodyBob = 0;
      this.kbBounce *= Math.exp(-dt * 18);
      if (this.kbBounce < 0.01) this.kbBounce = 0;

      const floatLife = reducedMotion ? FLOAT_REDUCED_MS : FLOAT_MS;
      this.pressed = this.pressed.filter(item => now - item.at < TAP_MS);
      this.floats = this.floats.filter(item => now - item.at < floatLife);
      this.mouseBadges = this.mouseBadges.filter(item => now - item.at < 520);

      const heldSlots = new Set();
      let heldLeft = null, heldRight = null;
      if (hasHeld) {
        for (const item of this.heldKeys.values()) {
          heldSlots.add(item.slotKey);
          this.keyPress.set(item.slotKey, 1);
          if (item.hand === 'left' && (!heldLeft || item.at >= heldLeft.at)) heldLeft = item;
          if (item.hand === 'right' && (!heldRight || item.at >= heldRight.at)) heldRight = item;
        }
      }

      let decayingKey = false;
      for (const [k, v] of this.keyPress) {
        const stillHeld = heldSlots.has(k);
        const stillDown = stillHeld || (!this.covering && this.pressed.some(item => `${item.row}:${item.slot}` === k));
        const next = stillDown ? 1 : v * Math.exp(-dt * 18);
        if (next < 0.02) this.keyPress.delete(k);
        else {
          this.keyPress.set(k, next);
          if (!stillHeld) decayingKey = true;
        }
      }

      if (this.leftTap && now - this.leftTap.at >= TAP_MS + 140) this.leftTap = null;
      if (this.rightTap && now - this.rightTap.at >= TAP_MS + 190) this.rightTap = null;

      const mp = this.mousePos();
      const leftActive = !this.covering && this.leftTap && now - this.leftTap.at < TAP_MS;
      const rightActive = !this.covering && this.rightTap && now - this.rightTap.at < TAP_MS;
      const rightTyping = !this.covering && ((this.rightTap && now - this.rightTap.at < TAP_MS + 180) || Boolean(heldRight));
      const rightOnMouse = !rightTyping && mouseBusy;

      // 默认待机时：尽量贴近宠物自己原本的小手位置（Clawd 就在身侧、松鼠/仓鼠在胸前桌沿）！
      const restL = this.nativeRest?.left || { x: 86 + this.bodyShiftX * 1.6, y: 170 };
      const restR = this.nativeRest?.right || { x: 186 + this.bodyShiftX * 1.6, y: 170 };

      if (leftActive) {
        this.leftPaw.tx = this.leftTap.x;
        this.leftPaw.ty = this.leftTap.y;
        this.leftPaw.trot = -0.34;
      } else if (heldLeft) {
        this.leftPaw.tx = heldLeft.x;
        this.leftPaw.ty = heldLeft.y + 0.6;
        this.leftPaw.trot = -0.22;
      } else {
        this.leftPaw.tx = restL.x;
        this.leftPaw.ty = restL.y;
        this.leftPaw.trot = 0;
      }

      if (rightOnMouse) {
        const clickDrop = Math.max(this.mouseLeftPress, this.mouseRightPress) * 2.4;
        this.rightPaw.tx = mp.x - 1;
        this.rightPaw.ty = mp.y - 4 + clickDrop;
        this.rightPaw.trot = 0.08 + (this.smx - 0.5) * 0.16;
      } else if (rightActive) {
        this.rightPaw.tx = this.rightTap.x;
        this.rightPaw.ty = this.rightTap.y;
        this.rightPaw.trot = 0.34;
      } else if (heldRight) {
        this.rightPaw.tx = heldRight.x;
        this.rightPaw.ty = heldRight.y + 0.6;
        this.rightPaw.trot = 0.22;
      } else {
        this.rightPaw.tx = restR.x;
        this.rightPaw.ty = restR.y;
        this.rightPaw.trot = 0;
      }

      const pk = reducedMotion ? 1 : (1 - Math.exp(-dt * 46));
      this.leftPaw.x = lerp(this.leftPaw.x, this.leftPaw.tx, pk);
      this.leftPaw.y = lerp(this.leftPaw.y, this.leftPaw.ty, pk);
      this.leftPaw.rot = lerp(this.leftPaw.rot, this.leftPaw.trot, pk);
      this.rightPaw.x = lerp(this.rightPaw.x, this.rightPaw.tx, pk);
      this.rightPaw.y = lerp(this.rightPaw.y, this.rightPaw.ty, pk);
      this.rightPaw.rot = lerp(this.rightPaw.rot, this.rightPaw.trot, pk);
      this.leftPaw.squash *= Math.exp(-dt * 15);
      this.rightPaw.squash *= Math.exp(-dt * 15);
      if (this.leftPaw.squash < 0.01) this.leftPaw.squash = 0;
      if (this.rightPaw.squash < 0.01) this.rightPaw.squash = 0;

      return this.floats.length > 0
        || this.mouseBadges.length > 0
        || decayingKey
        || !!this.leftTap
        || !!this.rightTap
        || Math.abs(this.smx - this.mx) > 0.004
        || Math.abs(this.smy - this.my) > 0.004
        || Math.abs(this.leftPaw.x - this.leftPaw.tx) > 0.3
        || Math.abs(this.leftPaw.y - this.leftPaw.ty) > 0.3
        || Math.abs(this.rightPaw.x - this.rightPaw.tx) > 0.3
        || Math.abs(this.rightPaw.y - this.rightPaw.ty) > 0.3
        || Math.abs(this.bodyShiftX - this.bodyShiftTarget) > 0.1
        || this.bodyBob > 0.01
        || this.kbBounce > 0.01
        || this.mouseLeftPress > 0.01
        || this.mouseRightPress > 0.01
        || (this.coverT > 0 && this.coverT < 1)
        || (this.coverT > 0.5 && !reducedMotion);
    }

    mousePos() {
      return {
        x: Math.round((MOUSE.baseX + (this.smx - 0.5) * MOUSE.rangeX) * 10) / 10,
        y: Math.round((MOUSE.baseY + (this.smy - 0.5) * MOUSE.rangeY) * 10) / 10,
      };
    }
  }

  /* ---------------- 高清平滑矢量绘图原语 ---------------- */

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function trapezoidPath(ctx, cx, cy, topHalfW, botHalfW, halfH, r) {
    const tl = [cx - topHalfW, cy - halfH];
    const tr = [cx + topHalfW, cy - halfH];
    const br = [cx + botHalfW, cy + halfH];
    const bl = [cx - botHalfW, cy + halfH];
    ctx.beginPath();
    ctx.moveTo(tl[0] + r, tl[1]);
    ctx.lineTo(tr[0] - r, tr[1]);
    ctx.quadraticCurveTo(tr[0], tr[1], tr[0] + (botHalfW - topHalfW) * 0.14, tr[1] + r);
    ctx.lineTo(br[0] - (botHalfW - topHalfW) * 0.14, br[1] - r);
    ctx.quadraticCurveTo(br[0], br[1], br[0] - r, br[1]);
    ctx.lineTo(bl[0] + r, bl[1]);
    ctx.quadraticCurveTo(bl[0], bl[1], bl[0] + (botHalfW - topHalfW) * 0.14, bl[1] - r);
    ctx.lineTo(tl[0] - (botHalfW - topHalfW) * 0.14, tl[1] + r);
    ctx.quadraticCurveTo(tl[0], tl[1], tl[0] + r, tl[1]);
    ctx.closePath();
  }

  function makeRgbGradient(ctx, x0, y0, x1, y1, hue, sat = 95, light = 60, alpha = 1) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    const stops = [0, 0.25, 0.5, 0.75, 1];
    for (const s of stops) {
      const h = (hue + s * 300) % 360;
      g.addColorStop(s, alpha < 1 ? `hsla(${h.toFixed(0)}, ${sat}%, ${light}%, ${alpha})` : `hsl(${h.toFixed(0)}, ${sat}%, ${light}%)`);
    }
    return g;
  }

  function drawKeyboard(ctx, state, resolved, en, now, reducedMotion, onImageLoad) {
    const { dp, effects, images, base } = resolved;
    const hue = reducedMotion ? 190 : (now * 0.085) % 360;
    const hoverY = effects.hoverFloat ? (reducedMotion ? -2.6 : -3.0 + Math.sin(now * 0.0032) * 1.5) : 0;
    const bounce = state.kbBounce * 2.2;
    const cy = KB.cy + bounce + hoverY;
    const halfH = KB.h / 2;
    const rimDrop = effects.slimKeys ? 1.8 : 3.0;
    const cornerR = effects.slimKeys ? 5.5 : 7;
    const glowRgb = parseColor(dp.glow) || [34, 211, 238];

    ctx.save();

    // 1. 阴影 / 悬浮投影光盘 / RGB 底边光晕
    if (effects.hoverFloat) {
      const baseShadowY = KB.cy + 8.0;
      ctx.save();
      const padGrad = ctx.createRadialGradient(KB.cx, baseShadowY + halfH - 5, 12, KB.cx, baseShadowY + halfH - 5, KB.botHalfW + 8);
      padGrad.addColorStop(0, toRgba(glowRgb, 0.34));
      padGrad.addColorStop(0.65, toRgba(glowRgb, 0.14));
      padGrad.addColorStop(1, toRgba(glowRgb, 0));
      ctx.fillStyle = padGrad;
      ctx.beginPath();
      ctx.ellipse(KB.cx, baseShadowY + halfH - 5, KB.botHalfW + 4, 8.5, 0, 0, Math.PI * 2);
      ctx.fill();
      // 悬浮能量基线
      ctx.strokeStyle = toRgba(glowRgb, 0.65);
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(KB.cx - KB.botHalfW + 18, baseShadowY + halfH - 3.5);
      ctx.lineTo(KB.cx + KB.botHalfW - 18, baseShadowY + halfH - 3.5);
      ctx.stroke();
      ctx.restore();
    } else if (effects.rgbBorder) {
      ctx.save();
      ctx.fillStyle = dp.shadow;
      trapezoidPath(ctx, KB.cx, cy + 5.2, KB.topHalfW - 1, KB.botHalfW + 1, halfH, cornerR);
      ctx.fill();
      ctx.shadowColor = `hsla(${hue.toFixed(0)}, 96%, 58%, 0.55)`;
      ctx.shadowBlur = 9;
      ctx.strokeStyle = makeRgbGradient(ctx, KB.cx - KB.botHalfW, cy, KB.cx + KB.botHalfW, cy, hue, 96, 60, 0.72);
      ctx.lineWidth = 2.6;
      trapezoidPath(ctx, KB.cx, cy + 1.8, KB.topHalfW + 0.6, KB.botHalfW + 0.6, halfH + 0.4, cornerR);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.fillStyle = dp.shadow;
      trapezoidPath(ctx, KB.cx, cy + (effects.slimKeys ? 3.8 : 5.0), KB.topHalfW - 1, KB.botHalfW + 1, halfH, cornerR);
      ctx.fill();
    }

    // 2. 底座厚度边
    ctx.fillStyle = dp.kbRim;
    trapezoidPath(ctx, KB.cx, cy + rimDrop, KB.topHalfW, KB.botHalfW, halfH, cornerR);
    ctx.fill();

    // 3. 键盘主体（支持自定义贴图覆盖）
    const customKbImg = images?.keyboard ? getCustomImage(images.keyboard, onImageLoad) : null;
    if (customKbImg) {
      ctx.save();
      trapezoidPath(ctx, KB.cx, cy, KB.topHalfW, KB.botHalfW, halfH, cornerR);
      ctx.clip();
      ctx.drawImage(customKbImg, KB.cx - KB.botHalfW, cy - halfH, KB.botHalfW * 2, KB.h);
      ctx.restore();
      ctx.strokeStyle = effects.rgbBorder
        ? makeRgbGradient(ctx, KB.cx - KB.botHalfW, cy, KB.cx + KB.botHalfW, cy, hue)
        : dp.kbStroke;
      ctx.lineWidth = effects.rgbBorder ? 1.8 : 1.35;
      trapezoidPath(ctx, KB.cx, cy, KB.topHalfW, KB.botHalfW, halfH, cornerR);
      ctx.stroke();
    } else {
      const bodyGrad = ctx.createLinearGradient(KB.cx, cy - halfH, KB.cx, cy + halfH);
      bodyGrad.addColorStop(0, dp.kbBodyTop);
      bodyGrad.addColorStop(1, dp.kbBodyBot);
      ctx.fillStyle = bodyGrad;
      trapezoidPath(ctx, KB.cx, cy, KB.topHalfW, KB.botHalfW, halfH, cornerR);
      ctx.fill();

      // 金属机身顶缘高光（苹果银铝 / 曜石黑专属细节）
      if (effects.slimKeys || base === 'obsidian') {
        ctx.save();
        ctx.strokeStyle = effects.slimKeys ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.18)';
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        ctx.moveTo(KB.cx - KB.topHalfW + cornerR + 2, cy - halfH + 1.0);
        ctx.lineTo(KB.cx + KB.topHalfW - cornerR - 2, cy - halfH + 1.0);
        ctx.stroke();
        ctx.restore();
      }

      // 机身边框（电竞 RGB 流光边框 / 未来悬浮发光边框 / 标准描边）
      ctx.save();
      if (effects.rgbBorder) {
        ctx.strokeStyle = makeRgbGradient(ctx, KB.cx - KB.botHalfW, cy, KB.cx + KB.botHalfW, cy, hue, 96, 62);
        ctx.lineWidth = 2.0;
      } else if (effects.holoGrid || effects.glow >= 0.6) {
        ctx.shadowColor = toRgba(glowRgb, 0.7);
        ctx.shadowBlur = 5;
        ctx.strokeStyle = dp.kbStroke;
        ctx.lineWidth = 1.5;
      } else {
        ctx.strokeStyle = dp.kbStroke;
        ctx.lineWidth = 1.4;
      }
      trapezoidPath(ctx, KB.cx, cy, KB.topHalfW, KB.botHalfW, halfH, cornerR);
      ctx.stroke();
      ctx.restore();

      // 键槽井
      const wellInset = effects.slimKeys ? 4.0 : 5.2;
      const wellPadH = effects.slimKeys ? 3.2 : 4.0;
      ctx.fillStyle = dp.kbWell;
      trapezoidPath(ctx, KB.cx, cy + 0.3, KB.topHalfW - wellInset, KB.botHalfW - wellInset, halfH - wellPadH, effects.slimKeys ? 3 : 4);
      ctx.fill();

      // 电竞 RGB 键槽微光底纹
      if (effects.rgbBorder) {
        ctx.save();
        trapezoidPath(ctx, KB.cx, cy + 0.3, KB.topHalfW - wellInset, KB.botHalfW - wellInset, halfH - wellPadH, 4);
        ctx.clip();
        ctx.fillStyle = makeRgbGradient(ctx, KB.cx - KB.botHalfW, cy, KB.cx + KB.botHalfW, cy, (hue + 40) % 360, 95, 58, 0.16);
        ctx.fillRect(KB.cx - KB.botHalfW, cy - halfH, KB.botHalfW * 2, KB.h);
        ctx.restore();
      }

      // 未来悬浮全息扫描线 + 四角 HUD 括号
      if (effects.holoGrid) {
        ctx.save();
        trapezoidPath(ctx, KB.cx, cy + 0.3, KB.topHalfW - wellInset, KB.botHalfW - wellInset, halfH - wellPadH, 4);
        ctx.clip();
        ctx.strokeStyle = toRgba(glowRgb, 0.14);
        ctx.lineWidth = 0.8;
        for (let sy = cy - halfH + 6; sy < cy + halfH - 4; sy += 5) {
          ctx.beginPath();
          ctx.moveTo(KB.cx - KB.botHalfW, sy);
          ctx.lineTo(KB.cx + KB.botHalfW, sy);
          ctx.stroke();
        }
        ctx.restore();

        // 四角科技描边角标
        ctx.save();
        ctx.strokeStyle = toRgba(glowRgb, 0.92);
        ctx.lineWidth = 1.6;
        ctx.lineCap = 'round';
        const txL = KB.cx - KB.topHalfW + 3, txR = KB.cx + KB.topHalfW - 3, tyT = cy - halfH + 1;
        const bxL = KB.cx - KB.botHalfW + 3, bxR = KB.cx + KB.botHalfW - 3, byB = cy + halfH - 1;
        ctx.beginPath();
        ctx.moveTo(txL, tyT + 6); ctx.lineTo(txL + 1, tyT); ctx.lineTo(txL + 8, tyT);
        ctx.moveTo(txR, tyT + 6); ctx.lineTo(txR - 1, tyT); ctx.lineTo(txR - 8, tyT);
        ctx.moveTo(bxL, byB - 6); ctx.lineTo(bxL + 1, byB); ctx.lineTo(bxL + 8, byB);
        ctx.moveTo(bxR, byB - 6); ctx.lineTo(bxR - 1, byB); ctx.lineTo(bxR - 8, byB);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 4. 键帽阵列（180° 面向宠物视角；若使用了自定义贴图，只在按键按下时叠加高亮光效）
    const padX = effects.slimKeys ? 6.0 : KB.padX;
    const padY = effects.slimKeys ? 4.6 : KB.padY;
    const innerTop = cy - halfH + padY;
    const innerH = KB.h - padY * 2;
    const rowH = innerH / 4;
    const gapX = effects.slimKeys ? 1.5 : 1.8;
    const gapY = effects.slimKeys ? 1.4 : 1.7;
    const keyR = effects.slimKeys ? 1.5 : 2.1;

    for (let r = 0; r < 4; r++) {
      // 180° 面向宠物翻转：row=3（空格排）画在最上排靠近宠物，row=0（数字/Esc）画在最下排，左右同步反转
      const visRow = 3 - r;
      const vMid = (visRow + 0.5) / 4;
      const halfW = lerp(KB.topHalfW - padX, KB.botHalfW - padX, vMid);
      const rowLeft = KB.cx - halfW;
      const rowW = halfW * 2;
      const ky = innerTop + visRow * rowH + gapY * 0.5;
      const kh = rowH - gapY;
      const row = ROW_LAYOUTS[r];

      for (let s = 0; s < row.length; s++) {
        const spec = row[s];
        const kx = rowLeft + (1 - spec.u1) * rowW + gapX * 0.5;
        const kw = (spec.u1 - spec.u0) * rowW - gapX;
        const press = state.covering ? 0 : (state.keyPress.get(`${r}:${s}`) || 0);
        const isActive = press > 0.12;

        if (customKbImg) {
          if (isActive) {
            ctx.save();
            ctx.globalAlpha = clamp(press * 0.85, 0, 0.88);
            ctx.fillStyle = effects.rgbBorder ? `hsl(${(hue + s * 34 + r * 26) % 360}, 96%, 62%)` : dp.keyActive;
            roundRect(ctx, kx, ky + 0.6, kw, kh - 0.6, keyR);
            ctx.fill();
            ctx.restore();
          }
          continue;
        }

        const sink = press * (effects.slimKeys ? 1.6 : 2.4);
        let topCol = isActive ? dp.keyActive : dp.keyTop;
        let sideCol = isActive ? dp.keyActiveSide : dp.keySide;
        if (isActive && effects.rgbBorder) {
          const khue = (hue + s * 34 + r * 26) % 360;
          topCol = `hsl(${khue.toFixed(0)}, 98%, 64%)`;
          sideCol = `hsl(${khue.toFixed(0)}, 90%, 38%)`;
        }

        // 键帽侧裙
        ctx.fillStyle = sideCol;
        roundRect(ctx, kx, ky + (effects.slimKeys ? 0.7 : 1.3), kw, kh, keyR + 0.2);
        ctx.fill();

        // 键帽顶面
        ctx.save();
        if (isActive && effects.glow > 0.35) {
          ctx.shadowColor = topCol;
          ctx.shadowBlur = 4 + effects.glow * 4;
        }
        ctx.fillStyle = topCol;
        roundRect(ctx, kx, ky + sink, kw, kh - (effects.slimKeys ? 0.6 : 1.1), keyR);
        ctx.fill();
        ctx.restore();

        // 细描边 / 电竞微光底边
        if (dp.keyStroke && !isActive) {
          ctx.strokeStyle = dp.keyStroke;
          ctx.lineWidth = effects.holoGrid ? 0.8 : 0.65;
          roundRect(ctx, kx + 0.2, ky + sink + 0.2, kw - 0.4, kh - (effects.slimKeys ? 0.9 : 1.4), keyR);
          ctx.stroke();
        }
        if (effects.rgbBorder && !isActive) {
          const edgeHue = (hue + s * 30 + r * 18) % 360;
          ctx.fillStyle = `hsla(${edgeHue.toFixed(0)}, 96%, 62%, 0.48)`;
          ctx.fillRect(kx + 1.4, ky + kh - 1.5, Math.max(2, kw - 2.8), 1.0);
        }
      }
    }

    if (state.coverT > 0.08) {
      ctx.save();
      ctx.globalAlpha = state.coverT;
      ctx.fillStyle = dp.privacyFill;
      ctx.strokeStyle = dp.privacyStroke;
      ctx.lineWidth = 1.4;
      trapezoidPath(ctx, KB.cx, cy, KB.topHalfW - 2, KB.botHalfW - 2, halfH - 1.5, 6);
      ctx.fill();
      ctx.stroke();

      ctx.font = '700 10px "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif';
      ctx.fillStyle = dp.privacyText;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(en ? '🔒 Privacy Mode' : '🔒 隐私保护中', KB.cx, cy + 0.5);
      ctx.restore();
    }

    ctx.restore();
  }

  function drawMouse(ctx, state, resolved, now, reducedMotion, onImageLoad) {
    const { dp, effects, images } = resolved;
    const hue = reducedMotion ? 190 : (now * 0.085) % 360;
    const hoverY = effects.hoverFloat ? (reducedMotion ? -2.6 : -3.0 + Math.sin(now * 0.0032 + 0.7) * 1.5) : 0;
    const glowRgb = parseColor(dp.glow) || [34, 211, 238];

    const mp = state.mousePos();
    const mx = mp.x;
    const my = mp.y + state.kbBounce * 1.4 + hoverY;
    const rx = effects.magicMouse ? 15.2 : MOUSE.rx;
    const ry = effects.magicMouse ? 20.6 : MOUSE.ry;
    const lPress = state.mouseLeftPress;
    const rPress = state.mouseRightPress;

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(0.04 + (state.smx - 0.5) * 0.08);

    // 1. 阴影 / 未来悬浮能量环 / RGB 底光
    if (effects.hoverFloat) {
      ctx.save();
      const sy = 8.2 - hoverY * 0.65;
      const mg = ctx.createRadialGradient(0, sy + ry * 0.45, 2, 0, sy + ry * 0.45, rx + 5);
      mg.addColorStop(0, toRgba(glowRgb, 0.36));
      mg.addColorStop(1, toRgba(glowRgb, 0));
      ctx.fillStyle = mg;
      ctx.beginPath();
      ctx.ellipse(0, sy + ry * 0.45, rx + 3, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = toRgba(glowRgb, 0.62);
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.ellipse(0, sy + ry * 0.45, rx * 0.72, 3.6, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.fillStyle = dp.shadow;
      ctx.beginPath();
      ctx.ellipse(0.5, effects.magicMouse ? 3.2 : 4.2, rx + 0.5, ry + 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 2. 底座厚度边
    ctx.fillStyle = dp.mouseRim;
    ctx.beginPath();
    ctx.ellipse(0, effects.magicMouse ? 1.7 : 2.3, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    const customMouseImg = images?.mouse ? getCustomImage(images.mouse, onImageLoad) : null;
    if (customMouseImg) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(customMouseImg, -rx, -ry, rx * 2, ry * 2);
      if (lPress > 0.08) {
        ctx.fillStyle = dp.mouseLeft;
        ctx.globalAlpha = 0.42 * lPress;
        ctx.fillRect(-rx - 1, -1, rx + 1, ry + 2);
      }
      if (rPress > 0.08) {
        ctx.fillStyle = dp.mouseRight;
        ctx.globalAlpha = 0.42 * rPress;
        ctx.fillRect(0, -1, rx + 1, ry + 2);
      }
      ctx.restore();
      ctx.strokeStyle = dp.mouseStroke;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      return;
    }

    // 3. 鼠标外壳
    const shellGrad = ctx.createLinearGradient(0, -ry, 0, ry);
    shellGrad.addColorStop(0, dp.mouseTop);
    shellGrad.addColorStop(1, dp.mouseBot);
    ctx.fillStyle = shellGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, rx - 0.5, ry - 0.5, 0, 0, Math.PI * 2);
    ctx.clip();

    if (effects.magicMouse) {
      // 苹果无缝触控鼠标（Magic Mouse）：极简一体玻璃顶面 + 细腻触控微标，点击时泛出柔光触控区
      if (lPress > 0.08) {
        ctx.fillStyle = dp.mouseLeft;
        ctx.globalAlpha = 0.30 * lPress;
        ctx.fillRect(-rx - 2, -1, rx + 2, ry + 3);
        ctx.globalAlpha = 1;
      }
      if (rPress > 0.08) {
        ctx.fillStyle = dp.mouseRight;
        ctx.globalAlpha = 0.30 * rPress;
        ctx.fillRect(0, -1, rx + 2, ry + 3);
        ctx.globalAlpha = 1;
      }
      // 玻璃表面柔和反光弧
      const shine = ctx.createLinearGradient(-rx, -ry, rx * 0.4, ry * 0.4);
      shine.addColorStop(0, 'rgba(255, 255, 255, 0.85)');
      shine.addColorStop(0.45, 'rgba(255, 255, 255, 0.12)');
      shine.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = shine;
      ctx.beginPath();
      ctx.ellipse(-3.5, -5.5, rx * 0.68, ry * 0.58, -0.2, 0, Math.PI * 2);
      ctx.fill();

      // 极淡触控中线提示
      ctx.strokeStyle = dp.mouseSeam;
      ctx.lineWidth = 0.9;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, 4.5);
      ctx.lineTo(0, 12.5);
      ctx.stroke();

      // 掌托微标圆点
      ctx.fillStyle = 'rgba(148, 163, 184, 0.32)';
      ctx.beginPath();
      ctx.arc(0, -8.5, 2.2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // 面向宠物视角（180° 翻转）：掌托在上（靠近宠物），左右键板与滚轮在下（朝外）
      ctx.beginPath();
      ctx.moveTo(-rx - 2, -2.2);
      ctx.quadraticCurveTo(-rx * 0.52, -0.2, 0, -0.5);
      ctx.lineTo(0, ry + 2);
      ctx.lineTo(-rx - 2, ry + 2);
      ctx.closePath();
      ctx.fillStyle = lPress > 0.08 ? dp.mouseLeft : dp.mouseBtnIdle;
      ctx.fill();
      if (lPress > 0.08) {
        ctx.fillStyle = `rgba(12, 18, 26, ${(0.18 * lPress).toFixed(3)})`;
        ctx.fillRect(-rx - 2, -2.2, rx + 2, 3.0);
      }

      ctx.beginPath();
      ctx.moveTo(0, -0.5);
      ctx.quadraticCurveTo(rx * 0.52, -0.2, rx + 2, -2.2);
      ctx.lineTo(rx + 2, ry + 2);
      ctx.lineTo(0, ry + 2);
      ctx.closePath();
      ctx.fillStyle = rPress > 0.08 ? dp.mouseRight : dp.mouseBtnIdle;
      ctx.fill();
      if (rPress > 0.08) {
        ctx.fillStyle = `rgba(12, 18, 26, ${(0.18 * rPress).toFixed(3)})`;
        ctx.fillRect(0, -2.2, rx + 2, 3.0);
      }

      // 电竞 RGB 尾部 V 型流光灯带
      if (effects.rgbBorder) {
        ctx.strokeStyle = makeRgbGradient(ctx, -rx, -ry, rx, -4, (hue + 90) % 360, 98, 64);
        ctx.lineWidth = 2.0;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-9.5, -9.5);
        ctx.quadraticCurveTo(0, -16.5, 9.5, -9.5);
        ctx.stroke();
      }

      // 未来悬浮中央能量脊椎线
      if (effects.holoGrid) {
        ctx.strokeStyle = toRgba(glowRgb, 0.72);
        ctx.lineWidth = 1.25;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(0, -14.5);
        ctx.lineTo(0, -4.5);
        ctx.stroke();
        ctx.fillStyle = toRgba(glowRgb, 0.85);
        ctx.beginPath();
        ctx.arc(0, -10.5, 2.0, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.strokeStyle = dp.mouseSeam;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-rx - 2, -2.2);
      ctx.quadraticCurveTo(0, 0.5, rx + 2, -2.2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, -0.5);
      ctx.lineTo(0, ry + 1);
      ctx.stroke();

      ctx.fillStyle = dp.wheelWell;
      roundRect(ctx, -2.4, 3.8, 4.8, 8.8, 2.4);
      ctx.fill();
      ctx.fillStyle = effects.rgbBorder ? `hsl(${((hue + 140) % 360).toFixed(0)}, 96%, 64%)` : dp.wheel;
      roundRect(ctx, -1.5, 4.8, 3.0, 6.8, 1.5);
      ctx.fill();

      ctx.font = '800 7px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = lPress > 0.15 ? '#ffffff' : dp.mouseLabel;
      ctx.fillText('L', -6.8, 12.6 + lPress * 0.8);
      ctx.fillStyle = rPress > 0.15 ? '#ffffff' : dp.mouseLabel;
      ctx.fillText('R', 6.8, 12.6 + rPress * 0.8);
    }

    ctx.restore();

    ctx.save();
    if (effects.rgbBorder) {
      ctx.strokeStyle = makeRgbGradient(ctx, -rx, -ry, rx, ry, (hue + 60) % 360, 96, 62);
      ctx.lineWidth = 1.75;
    } else if (effects.holoGrid) {
      ctx.shadowColor = toRgba(glowRgb, 0.72);
      ctx.shadowBlur = 4;
      ctx.strokeStyle = dp.mouseStroke;
      ctx.lineWidth = 1.45;
    } else {
      ctx.strokeStyle = dp.mouseStroke;
      ctx.lineWidth = 1.45;
    }
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }

  /**
   * 1. Clawd 小螃蟹原装方块小手：直接复用它原本侧边那两块同尺寸同色小方块（绝不新画长手臂！）。
   */
  function drawNativeSquareHand(ctx, x, y, w, h, rot, squash, fill, strokeRgb, covering, side) {
    const coverScale = covering ? 1.12 : 1;
    const sw = w * coverScale * (1 + squash * 0.14);
    const sh = h * coverScale * (1 - squash * 0.12);
    const angle = covering ? (side === 'left' ? 0.22 : -0.22) : rot;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // 在键盘/鼠标上时加极淡接地影；捂眼时加一层柔和同色系细边，让小方块手在珊瑚色脸庞上清清楚楚
    if (!covering) {
      ctx.fillStyle = 'rgba(18, 22, 32, 0.16)';
      ctx.fillRect(-sw / 2, sh / 2 - 1, sw, 3.5);
    }

    ctx.fillStyle = fill;
    ctx.fillRect(-sw / 2, -sh / 2, sw, sh);

    if (covering) {
      ctx.strokeStyle = toRgba(strokeRgb, 0.72);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-sw / 2 + 0.5, -sh / 2 + 0.5, sw - 1, sh - 1);
    } else {
      // 键盘/鼠标浅色背景上补一圈极淡边缘，保证方块小手轮廓利落不发虚
      ctx.strokeStyle = toRgba(strokeRgb, 0.35);
      ctx.lineWidth = 1.1;
      ctx.strokeRect(-sw / 2 + 0.5, -sh / 2 + 0.5, sw - 1, sh - 1);
    }

    ctx.restore();
  }

  /**
   * 2. 内置松鼠 / 仓鼠 / 自定义宠物：直接复用它原本小巧圆润的小手团子（零面条长臂！）。
   */
  function drawPresetPaw(ctx, x, y, rot, squash, pal, covering, side) {
    const isHam = pal.style === 'hamster';
    const rx = (covering ? (isHam ? 11.5 : 12.5) : (isHam ? 9.2 : 10.6)) * (1 + squash * 0.16);
    const ry = (covering ? (isHam ? 10.5 : 11.5) : (isHam ? 7.6 : 8.4)) * (1 - squash * 0.13);
    const angle = covering ? (side === 'left' ? 0.20 : -0.20) : rot * 0.45;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    if (!covering) {
      ctx.fillStyle = 'rgba(18, 22, 32, 0.17)';
      ctx.beginPath();
      ctx.ellipse(0, ry * 0.55, rx * 0.92, ry * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 干净哑光原画色填充 + 原画深描边（与 pet-engine.js 像素描边质感完全一致）
    ctx.fillStyle = pal.fill;
    ctx.strokeStyle = pal.stroke;
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    // 贴合 pet-engine.js shade() 的底边极淡加深
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, rx - 0.5, ry - 0.5, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = pal.shade;
    ctx.beginPath();
    ctx.ellipse(0, ry * 0.72, rx * 1.05, ry * 0.52, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = pal.stroke;
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();

    // 可爱小趾缝（捂眼时在顶部，拍键时在前缘）
    ctx.strokeStyle = toRgba(pal.strokeRgb, 0.65);
    ctx.lineWidth = 1.25;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (covering) {
      ctx.moveTo(-3.2, -ry + 2.0);
      ctx.lineTo(-3.2, -ry + 4.8);
      ctx.moveTo(3.2, -ry + 2.0);
      ctx.lineTo(3.2, -ry + 4.8);
    } else {
      ctx.moveTo(-3.0, ry - 3.6);
      ctx.lineTo(-3.0, ry - 1.0);
      ctx.moveTo(3.0, ry - 3.6);
      ctx.lineTo(3.0, ry - 1.0);
    }
    ctx.stroke();

    ctx.restore();
  }

  /**
   * 3. 内置章鱼墨墨：直接复用它原本最外侧两条触手（从章鱼下缘原生触手根部渐细柔弯而出，配色 1:1 匹配 OCT_PAL）。
   */
  function drawOctopusTentacle(ctx, sx, sy, px, py, squash, pal, covering, side) {
    const sgn = side === 'left' ? -1 : 1;
    const ctrlX = covering ? sx + sgn * 16 : sx + sgn * 6;
    const ctrlY = covering ? Math.max(sy, py) + 14 : lerp(sy, py, 0.62);

    ctx.save();
    // 沿贝塞尔曲线逐段渐细（根部粗、尖端细，完美融入章鱼另外 4 条原生触手）
    const steps = 14;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const u = i / steps, iu = 1 - u;
      pts.push({
        x: iu * iu * sx + 2 * iu * u * ctrlX + u * u * px,
        y: iu * iu * sy + 2 * iu * u * ctrlY + u * u * py,
        r: lerp(8.2, 5.6, u),
      });
    }

    // 先画深紫棕外轮廓，再填珊瑚粉/淡桃主色
    ctx.fillStyle = pal.stroke;
    for (const pt of pts) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.r + 2.0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = pal.fill;
    for (const pt of pts) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // 触手末端圆嘟嘟吸盘尖
    const rx = (covering ? 11.2 : 8.8) * (1 + squash * 0.16);
    const ry = (covering ? 10.2 : 7.6) * (1 - squash * 0.12);
    ctx.fillStyle = pal.fill;
    ctx.strokeStyle = pal.stroke;
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.ellipse(px, py, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 标志浅粉小吸盘点
    ctx.fillStyle = pal.pad;
    ctx.beginPath();
    ctx.arc(px - sgn * 2.4, py + 1.0, 2.1, 0, Math.PI * 2);
    ctx.arc(pts[9].x - sgn * 1.4, pts[9].y + 1.4, 1.8, 0, Math.PI * 2);
    ctx.arc(pts[5].x - sgn * 1.2, pts[5].y + 1.4, 1.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawAiIndicator(ctx, dp, phase, subagents, now) {
    const tick = Math.floor(now / 280);
    ctx.save();
    ctx.fillStyle = dp.aiBg;
    ctx.strokeStyle = dp.aiStroke;
    ctx.lineWidth = 1.4;
    roundRect(ctx, 224, 10, 52, 24, 12);
    ctx.fill();
    ctx.stroke();

    if (phase === 'waiting') {
      const col = tick % 2 === 0 ? dp.aiWarn : dp.aiDot;
      ctx.fillStyle = col;
      roundRect(ctx, 248.5, 15.5, 3, 8.5, 1.5);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(250, 27.5, 1.7, 0, Math.PI * 2);
      ctx.fill();
    } else if (phase === 'thinking') {
      const active = tick % 3;
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = i === active ? dp.aiAccent : dp.aiDot;
        const r = i === active ? 2.7 : 2.1;
        ctx.beginPath();
        ctx.arc(239 + i * 11, 22, r, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = tick % 2 === 0 ? dp.aiAccent : dp.aiDot;
      ctx.beginPath();
      ctx.arc(235, 22, 3.0, 0, Math.PI * 2);
      ctx.fill();
      const seg = 1 + (tick % 3);
      ctx.fillStyle = dp.aiAccent;
      roundRect(ctx, 242, 20, seg * 8, 4, 2);
      ctx.fill();
      if (subagents > 0) {
        ctx.fillStyle = dp.aiWarn;
        ctx.beginPath();
        ctx.arc(268, 16, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawBubbles(ctx, state, dp, now, reducedMotion) {
    if (state.covering) return;

    if (state.floats.length) {
      const life = reducedMotion ? FLOAT_REDUCED_MS : FLOAT_MS;
      ctx.save();
      ctx.font = '700 12.5px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (const item of state.floats) {
        const u = clamp((now - item.at) / life, 0, 1);
        const ease = 1 - Math.pow(1 - u, 2.3);
        const alpha = u < 0.72 ? 1 : clamp((1 - u) / 0.28, 0, 1);
        let sc = 1;
        if (!reducedMotion) {
          if (u < 0.14) sc = 0.62 + Math.sin((u / 0.14) * Math.PI * 0.65) * 0.44;
          else if (u > 0.76) sc = 1 - ((u - 0.76) / 0.24) * 0.10;
        }
        const lift = reducedMotion ? 26 * ease : 92 * ease;
        const cx = clamp(item.x, 22, LW - 22);
        const cy = Math.max(20, item.y - lift);

        const tw = ctx.measureText(item.key).width;
        const boxW = item.isSpace ? 40 : Math.max(24, Math.ceil(tw + 13));
        const boxH = 23;
        const bx = -boxW / 2, by = -boxH / 2;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(cx, cy);
        ctx.rotate(reducedMotion ? 0 : item.rot);
        ctx.scale(sc, sc);

        ctx.fillStyle = dp.floatSide;
        roundRect(ctx, bx, by + 2.4, boxW, boxH, 5.5);
        ctx.fill();

        ctx.fillStyle = dp.floatTop;
        ctx.strokeStyle = dp.floatStroke;
        ctx.lineWidth = 1.25;
        roundRect(ctx, bx, by, boxW, boxH - 1.2, 5.5);
        ctx.fill();
        ctx.stroke();

        if (item.isSpace) {
          ctx.strokeStyle = dp.floatText;
          ctx.lineWidth = 1.65;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(-9, -1);
          ctx.lineTo(-9, 2.4);
          ctx.lineTo(9, 2.4);
          ctx.lineTo(9, -1);
          ctx.stroke();
        } else {
          ctx.fillStyle = dp.floatText;
          ctx.fillText(item.key, 0, -0.3);
        }
        ctx.restore();
      }
      ctx.restore();
    }

    if (state.mouseBadges.length) {
      ctx.save();
      ctx.font = '800 8.5px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const b of state.mouseBadges) {
        const u = clamp((now - b.at) / 520, 0, 1);
        const alpha = u < 0.65 ? 1 : clamp((1 - u) / 0.35, 0, 1);
        const lift = (reducedMotion ? 8 : 26) * (1 - Math.pow(1 - u, 2));
        const cx = clamp(b.x, 22, LW - 22);
        const cy = Math.max(16, b.y - lift);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = b.side === 'left' ? dp.mouseLeft : dp.mouseRight;
        roundRect(ctx, cx - 15, cy - 7.5, 30, 15, 7.5);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillText(b.label, cx, cy + 0.3);
        ctx.restore();
      }
      ctx.restore();
    }
  }

  function paintDesk(canvas, state, opts) {
    if (!canvas) return;
    const {
      theme = 'light',
      style = 'white',
      deskPack = null,
      pet = 'squirrel',
      mood = 'ok',
      customColor = '',
      crabHint = false,
      eyeBox = null,
      nativeHands = null,
      showHands = true,
      aiWorking = false,
      aiPhase = null,
      subagents = 0,
      now = Date.now(),
      reducedMotion = false,
      en = false,
      onImageLoad = null,
    } = opts || {};

    // 把实时测得的宠物原生待机手位记入 state，让空闲时手自然回到它原本的位置
    if (nativeHands?.left && nativeHands?.right) {
      state.nativeRest = {
        left: { x: nativeHands.left.cx, y: nativeHands.left.cy },
        right: { x: nativeHands.right.cx, y: nativeHands.right.cy },
      };
    } else if (pet === 'squirrel') {
      const sh = state.bodyShiftX * 1.8;
      state.nativeRest = { left: { x: 132 + sh, y: 162 }, right: { x: 164 + sh, y: 162 } };
    } else if (pet === 'hamster') {
      const sh = state.bodyShiftX * 1.8;
      state.nativeRest = { left: { x: 126 + sh, y: 168 }, right: { x: 162 + sh, y: 168 } };
    } else if (pet === 'octopus') {
      const sh = state.bodyShiftX * 1.8;
      state.nativeRest = { left: { x: 96 + sh, y: 170 }, right: { x: 192 + sh, y: 170 } };
    } else {
      state.nativeRest = null;
    }

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(canvas.width / LW, canvas.height / LH);
    ctx.imageSmoothingEnabled = true;

    const resolved = resolveStyle(style, deskPack, theme);
    const dp = resolved.dp;
    const pp = pawPalette(pet, mood, customColor, crabHint);

    // 1. 悬浮极简微透视 60% 键盘 + 紧贴右侧小鼠标（按用户所选款式或自定义样式包绘制）
    drawKeyboard(ctx, state, resolved, en, now, reducedMotion, onImageLoad);
    drawMouse(ctx, state, resolved, now, reducedMotion, onImageLoad);

    // 2. 仅当桌宠处于可接管站姿（showHands=true）时绘制前景双手；随机待机或点击反应期间隐藏接管手并还原原画手，杜绝悬空手/四只手
    if (showHands) {
      const eyes = eyeBox || DEFAULT_EYES[pet] || DEFAULT_EYES.custom;
      const leftEyeX = (eyes.cx - eyes.halfSpan) * U;
      const rightEyeX = (eyes.cx + eyes.halfSpan) * U;
      const eyeY = eyes.cy * U;
      const coverT = state.coverT;
      const shyBob = coverT > 0.2 && !reducedMotion ? Math.sin(now * 0.0075) * 1.8 * coverT : 0;

      const lx = lerp(state.leftPaw.x, leftEyeX, coverT);
      const ly = lerp(state.leftPaw.y, eyeY + shyBob, coverT);
      const rx = lerp(state.rightPaw.x, rightEyeX, coverT);
      const ry = lerp(state.rightPaw.y, eyeY - shyBob, coverT);

      // 捂眼态柔和害羞腮红
      if (coverT > 0.45) {
        ctx.save();
        ctx.globalAlpha = clamp((coverT - 0.45) / 0.55, 0, 1) * 0.72;
        for (const cx of [leftEyeX - 15, rightEyeX + 15]) {
          const cy = eyeY + 13;
          const bg = ctx.createRadialGradient(cx, cy, 1, cx, cy, 12);
          bg.addColorStop(0, 'rgba(255, 114, 152, 0.72)');
          bg.addColorStop(1, 'rgba(255, 140, 174, 0)');
          ctx.fillStyle = bg;
          ctx.beginPath();
          ctx.ellipse(cx, cy, 12, 6.5, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      const covering = coverT > 0.48;
      if (nativeHands?.left && nativeHands?.right) {
        // Clawd 原装双小方块手：同尺寸同色，零多余长臂！
        const fill = nativeHands.fill || pp.fill;
        const rgb = parseColor(fill) || pp.rgb || [222, 136, 109];
        const strokeRgb = mix(rgb, [74, 30, 20], 0.52);
        drawNativeSquareHand(ctx, lx, ly, nativeHands.left.w, nativeHands.left.h, state.leftPaw.rot, coverT < 0.2 ? state.leftPaw.squash : 0, fill, strokeRgb, covering, 'left');
        drawNativeSquareHand(ctx, rx, ry, nativeHands.right.w, nativeHands.right.h, state.rightPaw.rot, coverT < 0.2 ? state.rightPaw.squash : 0, fill, strokeRgb, covering, 'right');
      } else if (pet === 'octopus') {
        // 章鱼墨墨：最外侧两条原生触手（从章鱼下缘左右根部自然伸出）
        const sh = reducedMotion ? 0 : state.bodyShiftX * 2.0;
        const bob = reducedMotion ? 0 : state.bodyBob * 2.4;
        drawOctopusTentacle(ctx, 100 + sh, 124 + bob, lx, ly, coverT < 0.2 ? state.leftPaw.squash : 0, pp, covering, 'left');
        drawOctopusTentacle(ctx, 188 + sh, 124 + bob, rx, ry, coverT < 0.2 ? state.rightPaw.squash : 0, pp, covering, 'right');
      } else {
        // 松鼠栗栗（暖棕圆爪）/ 仓鼠豆豆（粉嫩小爪）/ 自定义图片宠物
        drawPresetPaw(ctx, lx, ly, state.leftPaw.rot, coverT < 0.2 ? state.leftPaw.squash : 0, pp, covering, 'left');
        drawPresetPaw(ctx, rx, ry, state.rightPaw.rot, coverT < 0.2 ? state.rightPaw.squash : 0, pp, covering, 'right');
      }
    }

    if (aiWorking) {
      drawAiIndicator(ctx, dp, aiPhase, subagents, now);
    }

    drawBubbles(ctx, state, dp, now, reducedMotion);

    ctx.restore();
  }

  /** 设置页卡片用的紧裁键鼠预览（裁剪出键盘+鼠标区域，带 1 枚演示高亮键帽）。 */
  function paintDeskPreview(canvas, styleId, deskPack, opts) {
    if (!canvas) return;
    const { theme = 'light', now = Date.now(), reducedMotion = false, onImageLoad = null } = opts || {};
    const ctx = canvas.getContext('2d');
    const resolved = resolveStyle(styleId, deskPack, theme);
    const previewState = new DeskState();
    previewState.keyPress.set('1:3', 1);
    previewState.mouseLeftPress = 0.85;

    // 紧裁视窗覆盖键盘 (x=28..212, y=166..224) + 鼠标 (x=218..258)
    const cropX = 22, cropY = 160, cropW = 244, cropH = 68;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const sx = canvas.width / cropW, sy = canvas.height / cropH;
    const sc = Math.min(sx, sy);
    const ox = (canvas.width - cropW * sc) / 2;
    const oy = (canvas.height - cropH * sc) / 2;
    ctx.translate(ox - cropX * sc, oy - cropY * sc);
    ctx.scale(sc, sc);
    ctx.imageSmoothingEnabled = true;
    drawKeyboard(ctx, previewState, resolved, false, now, reducedMotion, onImageLoad);
    drawMouse(ctx, previewState, resolved, now, reducedMotion, onImageLoad);
    ctx.restore();
  }

  root.PulsePetDesk = {
    W,
    H,
    LW,
    LH,
    ACTIVE_HOLD_MS,
    TAP_MS,
    FLOAT_MS,
    DESK_HIT_BOX,
    DEFAULT_EYES,
    DESK_STYLES,
    keyRect,
    pawPalette,
    deskPalette,
    resolveStyle,
    isAnimatedStyle,
    DeskState,
    paintDesk,
    paintDeskPreview,
  };
})(typeof window !== 'undefined' ? window : globalThis);
