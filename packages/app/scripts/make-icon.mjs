#!/usr/bin/env node
// Generates the placeholder app icon, build/icon.icns (committed), with no
// image dependencies: renders a 1024px PNG with node:zlib, then lets macOS
// `sips` + `iconutil` produce the iconset and the .icns. Rerun with
// `npm run icon -w @harbormaster/app` after changing the drawing; replace the
// whole thing once there is a designed icon.
//
// The drawing: a macOS-grid rounded square (824px in a 1024 canvas) with a
// night-harbor gradient, a light "H" and a wave line under it.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SIZE = 1024;
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(appDir, "build", "icon.icns");

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function png(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Shapes in canvas coordinates; each returns true when (x, y) is inside.
const tile = { x0: 100, y0: 100, x1: 924, y1: 924, r: 185 };
function inRoundedRect({ x0, y0, x1, y1, r }, x, y) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
const letter = [
  { x0: 330, y0: 270, x1: 420, y1: 640, r: 18 }, // left post
  { x0: 604, y0: 270, x1: 694, y1: 640, r: 18 }, // right post
  { x0: 330, y0: 420, x1: 694, y1: 494, r: 18 }, // crossbar
];
function inWave(x, y) {
  if (x < 300 || x > 724) return false;
  const center = 730 + 22 * Math.sin(((x - 300) / 424) * Math.PI * 2);
  return Math.abs(y - center) <= 18;
}

function shade(x, y) {
  if (!inRoundedRect(tile, x, y)) return [0, 0, 0, 0];
  if (letter.some((rect) => inRoundedRect(rect, x, y)))
    return [236, 244, 250, 255];
  if (inWave(x, y)) return [94, 234, 212, 255];
  // Diagonal night-harbor gradient: deep navy to teal.
  const t = (x + y - 200) / 1648;
  return [
    Math.round(11 + (17 - 11) * t),
    Math.round(26 + (94 - 26) * t),
    Math.round(48 + (89 - 48) * t),
    255,
  ];
}

// 4x supersampling for smooth edges.
const pixels = Buffer.alloc(SIZE * SIZE * 4);
const offsets = [0.125, 0.375, 0.625, 0.875];
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const sum = [0, 0, 0, 0];
    for (const dy of offsets) {
      for (const dx of offsets) {
        const [r, g, b, a] = shade(x + dx, y + dy);
        sum[0] += r * a;
        sum[1] += g * a;
        sum[2] += b * a;
        sum[3] += a;
      }
    }
    const i = (y * SIZE + x) * 4;
    const alpha = sum[3] / 16;
    pixels[i] = alpha ? Math.round(sum[0] / sum[3]) : 0;
    pixels[i + 1] = alpha ? Math.round(sum[1] / sum[3]) : 0;
    pixels[i + 2] = alpha ? Math.round(sum[2] / sum[3]) : 0;
    pixels[i + 3] = Math.round(alpha);
  }
}

const work = mkdtempSync(join(tmpdir(), "harbormaster-icon-"));
try {
  const master = join(work, "icon-1024.png");
  writeFileSync(master, png(SIZE, SIZE, pixels));
  const iconset = join(work, "icon.iconset");
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale;
      const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
      execFileSync(
        "sips",
        ["-z", String(px), String(px), master, "--out", join(iconset, name)],
        {
          stdio: "ignore",
        },
      );
    }
  }
  mkdirSync(dirname(outFile), { recursive: true });
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", outFile]);
  writeFileSync(join(appDir, "build", "icon.png"), png(SIZE, SIZE, pixels));
  console.log(`[make-icon] wrote ${outFile}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
