/**
 * 生成应用图标：深色圆角方块 + 一条青色的脉搏线（TokenPulse 的 "pulse"）。
 *
 * 为什么自己画而不是塞一个 png 进仓库：这个图标就是几何图形，代码比二进制好改
 * （换个配色改两行），也省得仓库里躺一个没人敢动的文件。
 * 纯 Node 实现，只用 zlib —— PNG 本身就是「过滤后的像素行 + deflate」，不难写。
 *
 * 输出 packaging/icon.png（256×256）和 packaging/tray.png（32×32）。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "packaging");

/* ---------------- PNG 编码 ---------------- */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

/** RGBA 像素 → PNG 文件。每行前面加一个 0（filter: none），再整体 deflate。 */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 每通道 8 位
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------- 画 ---------------- */

/**
 * 超采样画布：所有形状先在 SS 倍的尺寸上按「覆盖率」算 alpha，最后缩下来。
 * 直接按像素判断在不在形状里会得到锯齿边，这个图标全是斜线和圆角，很难看。
 */
const SS = 4;

function canvas(size) {
  return { size, data: new Float64Array(size * size * 4) };
}

/** 往 (x,y) 上按 alpha 混一层颜色。 */
function blend(c, x, y, [r, g, b], a) {
  if (a <= 0 || x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  const i = (y * c.size + x) * 4;
  const dst = c.data[i + 3];
  const out = a + dst * (1 - a);
  if (out <= 0) return;
  c.data[i] = (r * a + c.data[i] * dst * (1 - a)) / out;
  c.data[i + 1] = (g * a + c.data[i + 1] * dst * (1 - a)) / out;
  c.data[i + 2] = (b * a + c.data[i + 2] * dst * (1 - a)) / out;
  c.data[i + 3] = out;
}

/** 圆角方块，颜色沿对角线渐变。 */
function roundedRect(c, radius, from, to) {
  const n = c.size;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // 离最近的圆角中心有多远 —— 在直边区域这个距离恒为 0。
      const dx = Math.max(radius - x, x - (n - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (n - 1 - radius), 0);
      if (Math.hypot(dx, dy) > radius) continue;
      const t = (x + y) / (2 * (n - 1));
      blend(c, x, y, [
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
        from[2] + (to[2] - from[2]) * t,
      ], 1);
    }
  }
}

/** 一条有粗细、圆头的折线。每个像素取「到线段的最短距离」来判断在不在线上。 */
function polyline(c, points, width, color, alpha = 1) {
  const half = width / 2;
  const n = c.size;
  const distToSegment = (px, py, a, b) => {
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / len2)) : 0;
    return Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let best = Infinity;
      for (let i = 1; i < points.length; i++) {
        best = Math.min(best, distToSegment(x + 0.5, y + 0.5, points[i - 1], points[i]));
        if (best <= half) break;
      }
      if (best <= half) blend(c, x, y, color, alpha);
    }
  }
}

/** 超采样画布 → 目标尺寸的 RGBA buffer（盒式滤波，SS×SS 取平均）。 */
function downsample(c, size) {
  const out = Buffer.alloc(size * size * 4);
  const step = c.size / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < step; sy++) {
        for (let sx = 0; sx < step; sx++) {
          const i = ((y * step + sy) * c.size + (x * step + sx)) * 4;
          const pa = c.data[i + 3];
          // 按 alpha 加权：透明像素的颜色是没意义的，直接平均会把边缘拖黑。
          r += c.data[i] * pa;
          g += c.data[i + 1] * pa;
          b += c.data[i + 2] * pa;
          a += pa;
        }
      }
      const j = (y * size + x) * 4;
      out[j] = a ? Math.round(r / a) : 0;
      out[j + 1] = a ? Math.round(g / a) : 0;
      out[j + 2] = a ? Math.round(b / a) : 0;
      out[j + 3] = Math.round((a / (step * step)) * 255);
    }
  }
  return out;
}

/**
 * 画一个图标。
 * `bare` = 只要那条脉搏线、不要底板：托盘图标在深色任务栏上，带底板反而糊成一团。
 */
function draw(size, bare) {
  const n = size * SS;
  const c = canvas(n);
  if (!bare) roundedRect(c, n * 0.22, [24, 28, 42], [13, 16, 26]);

  // 脉搏线：平 → 小波 → 尖峰 → 回落 → 平。坐标按 0~1 给，乘上画布尺寸。
  const shape = [
    [0.08, 0.5],
    [0.26, 0.5],
    [0.34, 0.38],
    [0.42, 0.62],
    [0.52, 0.16],
    [0.62, 0.8],
    [0.7, 0.5],
    [0.92, 0.5],
  ];
  const pad = bare ? 0 : 0.04;
  const points = shape.map(([x, y]) => [(x * (1 - pad * 2) + pad) * n, (y * (1 - pad * 2) + pad) * n]);
  const stroke = bare ? n * 0.11 : n * 0.075;
  // 先画一层半透明的粗线当辉光，再压一条实线，看起来有点发光。
  if (!bare) polyline(c, points, stroke * 2.4, [34, 211, 238], 0.22);
  polyline(c, points, stroke, bare ? [255, 255, 255] : [103, 232, 249]);
  return downsample(c, size);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "icon.png"), encodePng(256, 256, draw(256, false)));
fs.writeFileSync(path.join(OUT, "tray.png"), encodePng(32, 32, draw(32, true)));
console.log("icon.png (256) + tray.png (32) →", OUT);
