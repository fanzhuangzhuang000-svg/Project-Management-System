'use strict';
/**
 * 生成安装程序图标（纯 Node，不依赖 System.Drawing 或任何图形库）
 *
 * 自己画像素 → 自己编码 PNG（zlib 内置）→ 塞进 ICO 容器。
 * 图形与系统内 Logo 一致：蓝紫渐变圆角方块 + 白色箱体。
 *
 * 用法： node tools/installer/make-icon.js
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/* ---------------- 基础绘制 ---------------- */
const SIZE = 256;
const SS = 3;                       // 3 倍超采样，边缘才不会有锯齿
const N = SIZE * SS;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

/** 点是否在圆角矩形内 */
function inRoundRect (px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r + 0.0001;
}

/** 点是否在圆环的「上半段」（画提手用） */
function inArc (px, py, cx, cy, rOut, rIn) {
  if (py > cy) return false;                       // 只要上半圈
  const dx = px - cx, dy = py - cy;
  const d2 = dx * dx + dy * dy;
  return d2 <= rOut * rOut && d2 >= rIn * rIn;
}

/* ---------------- 画一帧 ---------------- */
function render () {
  const px = new Float32Array(N * N * 4);          // RGBA，0..1

  // 圆角方形：占满整块，圆角 22%
  const pad = N * 0.02;
  const side = N - pad * 2;
  const radius = side * 0.22;

  // 白色箱体
  const bw = N * 0.50, bh = N * 0.30;
  const bx = (N - bw) / 2, by = N * 0.46;
  const br = N * 0.06;

  // 提手：以箱体顶边中点为圆心的一段圆环
  const hcx = N / 2, hcy = by + 1;
  const hrOut = N * 0.185, hrIn = hrOut - N * 0.072;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      let r = 0, g = 0, b = 0, a = 0;

      if (inRoundRect(x, y, pad, pad, side, side, radius)) {
        // 蓝 → 靛蓝 对角渐变
        const t = clamp01((x / N) * 0.5 + (y / N) * 0.5);
        r = mix(59, 99, t) / 255;
        g = mix(130, 102, t) / 255;
        b = mix(246, 241, t) / 255;
        a = 1;

        // 白色箱体
        if (inRoundRect(x, y, bx, by, bw, bh, br) || inArc(x, y, hcx, hcy, hrOut, hrIn)) {
          r = 1; g = 1; b = 1;
        }
      }
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
    }
  }

  // 降采样回 256，得到抗锯齿边缘
  const out = Buffer.alloc(SIZE * SIZE * 4);
  const area = SS * SS;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * N + (x * SS + sx)) * 4;
          const al = px[i + 3];
          // 按 alpha 加权，避免边缘发灰
          r += px[i] * al; g += px[i + 1] * al; b += px[i + 2] * al; a += al;
        }
      }
      const o = (y * SIZE + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a * 255); out[o + 1] = Math.round(g / a * 255); out[o + 2] = Math.round(b / a * 255); }
      out[o + 3] = Math.round(a / area * 255);
    }
  }
  return out;
}

/* ---------------- PNG 编码 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32 (buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk (type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng (rgba, w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;        // 位深
  ihdr[9] = 6;        // 颜色类型 RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // 每行前面加一个 filter 字节
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- ICO 容器（PNG 压缩，Vista+ 支持） ---------------- */
function encodeIco (png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type = icon
  header.writeUInt16LE(1, 4);      // 图像数
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;   // 宽（256 写 0）
  entry[1] = size >= 256 ? 0 : size;   // 高
  entry[2] = 0;                    // 调色板
  entry[3] = 0;                    // reserved
  entry.writeUInt16LE(1, 4);       // 色彩平面
  entry.writeUInt16LE(32, 6);      // 位深
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);     // 数据偏移
  return Buffer.concat([header, entry, png]);
}

/* ---------------- 输出 ---------------- */
const dir = __dirname;
const rgba = render();

// 多尺寸 ICO：Windows 在任务栏/资源管理器会用不同尺寸
const SIZES = [256, 64, 48, 32, 16];
const pngs = SIZES.map(s => {
  if (s === SIZE) return encodePng(rgba, SIZE, SIZE);
  // 简单盒式降采样
  const out = Buffer.alloc(s * s * 4);
  const f = SIZE / s;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = Math.floor(y * f); sy < Math.floor((y + 1) * f); sy++) {
        for (let sx = Math.floor(x * f); sx < Math.floor((x + 1) * f); sx++) {
          const i = (sy * SIZE + sx) * 4;
          const al = rgba[i + 3] / 255;
          r += rgba[i] * al; g += rgba[i + 1] * al; b += rgba[i + 2] * al; a += al; n++;
        }
      }
      const o = (y * s + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round(a / n * 255);
    }
  }
  return encodePng(out, s, s);
});

// 组装成 ICO
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(SIZES.length, 4);
let offset = 6 + SIZES.length * 16;
const entries = [];
for (let i = 0; i < SIZES.length; i++) {
  const s = SIZES[i];
  const e = Buffer.alloc(16);
  e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12);
  entries.push(e); offset += pngs[i].length;
}
const ico = Buffer.concat([header, ...entries, ...pngs]);

fs.writeFileSync(path.join(dir, 'app.ico'), ico);
fs.writeFileSync(path.join(dir, 'app-256.png'), pngs[0]);

console.log('  图标已生成（纯 Node 手绘 + 自编码 PNG/ICO）');
for (let i = 0; i < SIZES.length; i++) console.log(`    ${String(SIZES[i]).padStart(3)}×${String(SIZES[i]).padEnd(3)}  ${(pngs[i].length / 1024).toFixed(1)} KB`);
console.log(`    app.ico 合计 ${(ico.length / 1024).toFixed(1)} KB`);
