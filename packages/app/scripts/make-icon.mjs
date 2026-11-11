#!/usr/bin/env node
// Renders build/icon.svg (the designed lighthouse icon, source of truth) into
// build/icon.png (1024px) and build/icon.icns, both committed. Needs
// `rsvg-convert` (brew install librsvg) plus macOS `iconutil`. Rerun with
// `npm run icon -w @harbormaster/app` after editing the SVG.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svg = join(appDir, "build", "icon.svg");
const png = join(appDir, "build", "icon.png");
const icns = join(appDir, "build", "icon.icns");

function render(size, out) {
  execFileSync("rsvg-convert", [
    "-w",
    `${size}`,
    "-h",
    `${size}`,
    svg,
    "-o",
    out,
  ]);
}

render(1024, png);
const work = mkdtempSync(join(tmpdir(), "hm-icon-"));
const iconset = join(work, "icon.iconset");
mkdirSync(iconset);
for (const base of [16, 32, 128, 256, 512]) {
  render(base, join(iconset, `icon_${base}x${base}.png`));
  render(base * 2, join(iconset, `icon_${base}x${base}@2x.png`));
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns]);
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${png} and ${icns}`);
