/**
 * TokenPulse 图标生成器。
 *
 * 视觉含义：圆环 = 官方额度 / 重置周期；柱形 = token 用量；节点 = 当前进度。
 * 这比旧版的心电图折线更贴近产品，也能避免被误认为医疗软件。
 *
 * 输出：packaging/icon.png（512×512）和 tray.png（32×32）。
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "packaging");
const SS = 4;

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function canvas(size) {
  return { size, data: new Float32Array(size * size * 4) };
}

function blend(c, x, y, color, alpha = 1) {
  if (alpha <= 0 || x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  const i = (y * c.size + x) * 4;
  const dstAlpha = c.data[i + 3];
  const outAlpha = alpha + dstAlpha * (1 - alpha);
  if (!outAlpha) return;
  for (let channel = 0; channel < 3; channel++) {
    c.data[i + channel] = (color[channel] * alpha + c.data[i + channel] * dstAlpha * (1 - alpha)) / outAlpha;
  }
  c.data[i + 3] = outAlpha;
}

function roundedRect(c, x, y, width, height, radius, color, alpha = 1, gradientTo) {
  const x2 = x + width;
  const y2 = y + height;
  for (let py = Math.max(0, Math.floor(y)); py < Math.min(c.size, Math.ceil(y2)); py++) {
    for (let px = Math.max(0, Math.floor(x)); px < Math.min(c.size, Math.ceil(x2)); px++) {
      const dx = Math.max(x + radius - (px + 0.5), px + 0.5 - (x2 - radius), 0);
      const dy = Math.max(y + radius - (py + 0.5), py + 0.5 - (y2 - radius), 0);
      if (Math.hypot(dx, dy) > radius) continue;
      const t = gradientTo ? ((px - x) + (py - y)) / (width + height) : 0;
      const fill = gradientTo ? color.map((value, i) => value + (gradientTo[i] - value) * t) : color;
      blend(c, px, py, fill, alpha);
    }
  }
}

function circle(c, cx, cy, radius, color, alpha = 1) {
  for (let y = Math.floor(cy - radius - 1); y <= Math.ceil(cy + radius + 1); y++) {
    for (let x = Math.floor(cx - radius - 1); x <= Math.ceil(cx + radius + 1); x++) {
      const coverage = Math.max(0, Math.min(1, radius + 0.75 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));
      blend(c, x, y, color, alpha * coverage);
    }
  }
}

function ring(c, cx, cy, radius, width, color, alpha = 1, start = -Math.PI, end = Math.PI) {
  const half = width / 2;
  for (let y = Math.floor(cy - radius - half - 1); y <= Math.ceil(cy + radius + half + 1); y++) {
    for (let x = Math.floor(cx - radius - half - 1); x <= Math.ceil(cx + radius + half + 1); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      let angle = Math.atan2(dy, dx);
      while (angle < start) angle += Math.PI * 2;
      if (angle > end) continue;
      const coverage = Math.max(0, Math.min(1, half + 0.75 - Math.abs(Math.hypot(dx, dy) - radius)));
      blend(c, x, y, color, alpha * coverage);
    }
  }
}

function downsample(c, size) {
  const out = Buffer.alloc(size * size * 4);
  const step = c.size / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let red = 0, green = 0, blue = 0, alpha = 0;
      for (let sy = 0; sy < step; sy++) {
        for (let sx = 0; sx < step; sx++) {
          const i = ((y * step + sy) * c.size + x * step + sx) * 4;
          const a = c.data[i + 3];
          red += c.data[i] * a;
          green += c.data[i + 1] * a;
          blue += c.data[i + 2] * a;
          alpha += a;
        }
      }
      const j = (y * size + x) * 4;
      out[j] = alpha ? Math.round(red / alpha) : 0;
      out[j + 1] = alpha ? Math.round(green / alpha) : 0;
      out[j + 2] = alpha ? Math.round(blue / alpha) : 0;
      out[j + 3] = Math.round(alpha / (step * step) * 255);
    }
  }
  return out;
}

function drawAppIcon(size) {
  const n = size * SS;
  const c = canvas(n);
  const u = n / 512;

  // 外围留透明安全区，让任务栏和开始菜单里的图标不显得顶边。
  roundedRect(c, 18 * u, 18 * u, 476 * u, 476 * u, 112 * u, [34, 91, 74], 1, [13, 55, 48]);
  roundedRect(c, 26 * u, 26 * u, 460 * u, 460 * u, 104 * u, [44, 116, 92], 0.16, [8, 32, 29]);

  const cx = 256 * u;
  const cy = 258 * u;
  const radius = 157 * u;
  const ringWidth = 34 * u;
  ring(c, cx, cy, radius, ringWidth, [102, 161, 139], 0.33);
  const start = -2.15;
  const end = 0.72;
  ring(c, cx, cy, radius, ringWidth, [184, 232, 207], 1, start, end);

  for (const [x, y, width, height] of [
    [177, 278, 34, 67],
    [222, 247, 34, 98],
    [267, 211, 34, 134],
    [312, 170, 34, 175],
  ]) {
    roundedRect(c, x * u, y * u, width * u, height * u, 14 * u, [221, 247, 233], 0.96);
  }

  // 节点落在额度弧末端，表达“此刻 / 当前额度位置”。
  const nx = cx + Math.cos(end) * radius;
  const ny = cy + Math.sin(end) * radius;
  circle(c, nx, ny, 31 * u, [25, 89, 72], 1);
  circle(c, nx, ny, 16 * u, [231, 250, 239], 1);
  return downsample(c, size);
}

function drawTrayIcon(size) {
  const n = size * SS;
  const c = canvas(n);
  const u = n / 32;
  const cx = 16 * u;
  const cy = 16 * u;
  const radius = 11.2 * u;
  const start = -2.15;
  const end = 0.72;
  ring(c, cx, cy, radius, 3.2 * u, [255, 255, 255], 1, start, end);
  for (const [x, y, width, height] of [[10.5, 17, 2.7, 6], [14.7, 14, 2.7, 9], [18.9, 10.5, 2.7, 12.5]]) {
    roundedRect(c, x * u, y * u, width * u, height * u, 1.15 * u, [255, 255, 255], 1);
  }
  const nx = cx + Math.cos(end) * radius;
  const ny = cy + Math.sin(end) * radius;
  circle(c, nx, ny, 2.5 * u, [255, 255, 255], 1);
  return downsample(c, size);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "icon.png"), encodePng(512, 512, drawAppIcon(512)));
fs.writeFileSync(path.join(OUT, "tray.png"), encodePng(32, 32, drawTrayIcon(32)));
console.log("TokenPulse icon.png (512) + tray.png (32) →", OUT);
