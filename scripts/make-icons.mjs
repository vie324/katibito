// アプリのアイコン(PNG・SVG)を作る。デザインは起動画面のファビコンと同じ(レンズの輪 + 録画の点)。
// 使い方: node scripts/make-icons.mjs  → public/icons/ に書き出す(生成物はリポジトリに含める)

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(out, { recursive: true });

const BG = [0x14, 0x17, 0x1c];
const TEAL = [0x4f, 0xb3, 0xa5];
const AMBER = [0xe8, 0xa3, 0x3d];

/** 0〜1 の座標で色を返す(null は透明) */
function shade(x, y, { rounded, scale }) {
  const cx = 0.5, cy = 0.5;
  if (rounded) {
    // 角の丸い四角(半径 0.18)
    const r = 0.18;
    const qx = Math.max(Math.abs(x - cx) - (0.5 - r), 0);
    const qy = Math.max(Math.abs(y - cy) - (0.5 - r), 0);
    if (Math.hypot(qx, qy) > r) return null;
  }
  const d = Math.hypot(x - cx, y - cy) / scale;
  if (d <= 0.085) return AMBER;
  if (d >= 0.205 && d <= 0.275) return TEAL;
  return BG;
}

function png(size, opts) {
  const SS = 4; // 1画素を 4x4 で標本化して縁をなめらかにする
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, opts);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      const n = SS * SS;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / n) * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // ビット深度
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

writeFileSync(path.join(out, "icon-192.png"), png(192, { rounded: true, scale: 1 }));
writeFileSync(path.join(out, "icon-512.png"), png(512, { rounded: true, scale: 1 }));
// マスク可能アイコン: 端まで背景色で塗り、図柄は中央の安全領域に収める
writeFileSync(path.join(out, "maskable-512.png"), png(512, { rounded: false, scale: 0.8 }));
writeFileSync(path.join(out, "apple-touch-icon.png"), png(180, { rounded: false, scale: 0.9 }));
writeFileSync(
  path.join(out, "icon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="5.76" fill="#14171c"/><circle cx="16" cy="16" r="7.68" fill="none" stroke="#4fb3a5" stroke-width="2.24"/><circle cx="16" cy="16" r="2.72" fill="#e8a33d"/></svg>\n`,
);
console.log("icons written to", out);
