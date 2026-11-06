// Generates electron/icon.png — a simple 256x256 blue rounded-square with a
// white "W" mark. Pure Node (zlib + manual PNG encoding), no native deps, so it
// runs anywhere `node` does. Run: node electron/gen-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;

// ---- tiny PNG writer (RGBA, no external deps) ----
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // rows with filter byte 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- draw ----
const px = Buffer.alloc(SIZE * SIZE * 4);
const BG = [37, 99, 235];       // blue
const BG_DARK = [29, 78, 216];  // darker blue for corners outside rounded rect
const WHITE = [255, 255, 255];

function set(x, y, rgb, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  // simple alpha blend over background already present
  const ba = px[i + 3] / 255;
  px[i]     = Math.round(rgb[0] * (a / 255) + px[i]     * ba * (1 - a / 255));
  px[i + 1] = Math.round(rgb[1] * (a / 255) + px[i + 1] * ba * (1 - a / 255));
  px[i + 2] = Math.round(rgb[2] * (a / 255) + px[i + 2] * ba * (1 - a / 255));
  px[i + 3] = 255;
}

const R = 48; // corner radius
function roundedFill(rgb) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const inX = (x >= R || y >= R) && (x < SIZE - R || y >= R) &&
                  (x >= R || y < SIZE - R) && (x < SIZE - R || y < SIZE - R);
      if (inX) { set(x, y, rgb); continue; }
      // corner regions: distance to corner center
      const cx = x < R ? R : SIZE - R;
      const cy = y < R ? R : SIZE - R;
      const d = Math.hypot(x - cx, y - cy);
      if (d <= R) set(x, y, rgb);
    }
  }
}
roundedFill(BG);

// white "W" mark as two diagonal strokes (simpler than real glyph)
function line(x0, y0, x1, y1, rgb) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    for (let dx = -9; dx <= 9; dx++)
      for (let dy = -9; dy <= 9; dy++)
        if (dx * dx + dy * dy <= 81) set(x + dx, y + dy, rgb);
  }
}
const topY = 78, botY = 178, lw = 34;
line(70, topY, 110, botY, WHITE);            // left downstroke
line(110, botY, 128, topY, WHITE);          // middle upstroke
line(128, topY, 186, botY, WHITE);          // right downstroke
// left/top serif accents
line(70, topY, 70 + lw, topY, WHITE);
line(186, topY, 186 - lw, topY, WHITE);

const out = path.join(__dirname, 'icon.png');
fs.writeFileSync(out, encodePNG(SIZE, SIZE, px));
console.log('wrote ' + out + ' (' + SIZE + 'x' + SIZE + ')');
