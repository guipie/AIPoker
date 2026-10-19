// 生成一个 512x512 的纯色 PNG 图标（扑克牌风格：绿底+黑桃）
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const SIZE = 512;

// 创建像素数据（RGBA）
const pixels = Buffer.alloc(SIZE * SIZE * 4);

// 简单画一个绿底 + 中央黑色圆形 + 白色桃心
function setPixel(x, y, r, g, b, a) {
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
  const idx = (y * SIZE + x) * 4;
  pixels[idx] = r;
  pixels[idx + 1] = g;
  pixels[idx + 2] = b;
  pixels[idx + 3] = a;
}

// 绿底
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    setPixel(x, y, 26, 122, 79, 255); // #1a7a4f
  }
}

// 中央画一个白色圆形（作为扑克牌）
const cx = SIZE / 2;
const cy = SIZE / 2;
const radius = SIZE * 0.38;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = x - cx;
    const dy = y - cy;
    if (dx * dx + dy * dy <= radius * radius) {
      setPixel(x, y, 255, 255, 255, 255);
    }
  }
}

// 在圆内画一个黑桃符号（简化：用三角形 + 倒心）
// 画一个大的黑色桃心在中心
function drawSpade(cx2, cy2, size) {
  // 简化的桃心：上方两个圆 + 下方三角
  const r = size * 0.3;
  // 左圆
  for (let y = -size; y <= size; y++) {
    for (let x = -size; x <= size; x++) {
      const dx = x;
      const dy = y;
      // 桃心形状近似
      const heart = Math.pow(dx * dx + dy * dy - 1, 3) - dx * dx * dy * dy * dy;
      if (heart <= 0) {
        setPixel(cx2 + x, cy2 + y, 15, 15, 15, 255);
      }
    }
  }
}

// 画一个大的黑色桃心（旋转 180 度成黑桃）
const s = 80;
for (let y = -s; y <= s; y++) {
  for (let x = -s; x <= s; x++) {
    const nx = x / s;
    const ny = -y / s; // 翻转
    const heart = Math.pow(nx * nx + ny * ny - 1, 3) - nx * nx * ny * ny * ny;
    if (heart <= 0) {
      setPixel(cx + x, cy + y, 20, 20, 20, 255);
    }
  }
}
// 黑桃的柄
for (let y = 0; y < 40; y++) {
  for (let x = -12; x <= 12; x++) {
    setPixel(cx + x, cy + s + y, 20, 20, 20, 255);
  }
}

// 构建 PNG
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

// IDAT: 每行前面加 filter byte 0
const rawRows = [];
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 4);
  row[0] = 0; // filter none
  pixels.copy(row, 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  rawRows.push(row);
}
const raw = Buffer.concat(rawRows);
const compressed = zlib.deflateSync(raw);

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const png = Buffer.concat([
  signature,
  chunk("IHDR", ihdr),
  chunk("IDAT", compressed),
  chunk("IEND", Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, "icon-source.png");
fs.writeFileSync(outPath, png);
console.log("Generated", outPath, png.length, "bytes");
