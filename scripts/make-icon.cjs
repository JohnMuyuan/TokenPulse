/**
 * TokenPulse 图标生成器。
 *
 * 视觉含义：圆环 = 官方额度 / 重置周期；柱形 = token 用量；节点 = 当前进度。
 * 这比旧版的心电图折线更贴近产品，也能避免被误认为医疗软件。
 *
 * 输出：packaging/icon.png（512×512）、tray.png（32×32，macOS 模板图）、
 * tray-color.png / tray-color-16.png（Windows / Linux 托盘）。
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

/**
 * ICO 里的传统位图（BITMAPINFOHEADER + 自下而上的 BGRA + AND 掩码）。
 * 小尺寸不能直接塞 PNG：GDI+ 和 Electron 读窗口图标时把 PNG 当位图解，出来是满屏彩色噪点（任务栏上像「星空」）。
 * 只有 256 那张按惯例用 PNG。
 */
function encodeDib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // 高度含 AND 掩码，所以是两倍
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = ((size - 1 - y) * size + x) * 4;
      pixels[to] = rgba[from + 2];
      pixels[to + 1] = rgba[from + 1];
      pixels[to + 2] = rgba[from];
      pixels[to + 3] = rgba[from + 3];
    }
  }
  // 32 位图靠 alpha 通道，AND 掩码全 0 即可；每行按 4 字节对齐
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([header, pixels, mask]);
}

// Windows 任务栏 / 快捷方式优先读取 ICO，用多尺寸让系统按缩放比例选择清晰的一张。
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(images.length * 16);
  let offset = 6 + directory.length;
  const payloads = [];
  images.forEach(({ size, png }, index) => {
    const entry = index * 16;
    directory[entry] = size >= 256 ? 0 : size;
    directory[entry + 1] = size >= 256 ? 0 : size;
    directory[entry + 2] = 0;
    directory[entry + 3] = 0;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    payloads.push(png);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...payloads]);
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

/**
 * Windows / Linux 托盘用的彩色图标：和应用图标一样的深绿底 + 浅色圆环和柱形。
 * 以前是白色透明线稿，Windows 浅色任务栏上几乎看不见。托盘只有 16px（200% 缩放时 32px），
 * 所以底块铺满、线条加粗，只画三根柱子。
 */
function drawColorTray(size) {
  const n = size * SS;
  const c = canvas(n);
  const u = n / 32;
  roundedRect(c, 0.5 * u, 0.5 * u, 31 * u, 31 * u, 8 * u, [34, 106, 84], 1, [16, 62, 52]);
  const cx = 16 * u;
  const cy = 16.3 * u;
  const radius = 10.2 * u;
  const start = -2.15;
  const end = 0.72;
  ring(c, cx, cy, radius, 3.4 * u, [120, 178, 155], 0.55);
  ring(c, cx, cy, radius, 3.4 * u, [196, 240, 216], 1, start, end);
  for (const [x, y, width, height] of [[10.6, 16.4, 3, 5.6], [14.6, 13.4, 3, 8.6], [18.6, 10.2, 3, 11.8]]) {
    roundedRect(c, x * u, y * u, width * u, height * u, 1.2 * u, [236, 252, 243], 1);
  }
  return downsample(c, size);
}

/**
 * 16px 单独画：圆环和三根柱子挤在 16 像素里会糊成一块（实测），这里只留底块和三根对齐整像素的柱子，
 * 柱子之间留满 1 像素的缝。
 */
function drawSmallTray() {
  const size = 16;
  const n = size * SS;
  const c = canvas(n);
  const u = n / 16;
  roundedRect(c, 0, 0, 16 * u, 16 * u, 4 * u, [34, 106, 84], 1, [16, 62, 52]);
  for (const [x, y, height, color] of [[3, 9, 4, [150, 214, 186]], [7, 6, 7, [196, 240, 216]], [11, 3, 10, [236, 252, 243]]]) {
    roundedRect(c, x * u, y * u, 2 * u, height * u, 0.8 * u, color, 1);
  }
  return downsample(c, size);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "tray-color.png"), encodePng(32, 32, drawColorTray(32)));
fs.writeFileSync(path.join(OUT, "tray-color-16.png"), encodePng(16, 16, drawSmallTray()));
fs.writeFileSync(path.join(OUT, "icon.png"), encodePng(512, 512, drawAppIcon(512)));
fs.writeFileSync(path.join(OUT, "icon.ico"), encodeIco([16, 24, 32, 48, 64, 128, 256].map(size => { const rgba = drawAppIcon(size); return { size, png: size >= 256 ? encodePng(size, size, rgba) : encodeDib(size, rgba) }; })));
fs.writeFileSync(path.join(OUT, "tray.png"), encodePng(32, 32, drawTrayIcon(32)));
console.log("TokenPulse icon.png (512) + icon.ico + tray icons →", OUT);
