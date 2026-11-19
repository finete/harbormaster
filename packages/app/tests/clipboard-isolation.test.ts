// The developer's clipboard is never touched by tests, and the app has one
// clipboard path (main/app-clipboard.ts): a lint over the sources, like
// fake-contract-coverage.test.ts. Specs seed and read the app's private
// test clipboard through e2e/test-clipboard.ts; app code reads and writes
// through `appClipboard` (main) or `app.copyText` (renderer).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return ext.test(name) ? [path] : [];
  });
}

/** Code lines only (comments dropped), with their file:line. */
function hits(paths: string[], pattern: RegExp): string[] {
  const out: string[] = [];
  for (const path of paths) {
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "").trim();
        if (code.startsWith("*") || code.startsWith("/*")) return;
        if (pattern.test(code))
          out.push(`${relative(ROOT, path)}:${i + 1}: ${code}`);
      });
  }
  return out;
}

describe("clipboard isolation", () => {
  it("specs never use the real clipboard (Electron's or the DOM's)", () => {
    const specs = files(join(ROOT, "e2e"), /\.ts$/).filter(
      (path) =>
        !path.endsWith("test-clipboard.ts") &&
        !path.endsWith("clipboard-guard.ts"),
    );
    expect(
      hits(
        specs,
        /\{\s*clipboard\b|navigator\.clipboard|\bclipboard\.(write|read|clear)/,
      ),
    ).toEqual([]);
  });

  it("app code reaches the clipboard only through main/app-clipboard.ts", () => {
    const src = files(join(ROOT, "src"), /\.tsx?$/).filter(
      (path) => !path.endsWith("app-clipboard.ts"),
    );
    // Electron's clipboard imported anywhere else, or the renderer writing
    // through the DOM, bypasses the one path (and the e2e test clipboard).
    expect(
      hits(
        src,
        /import\s*\{[^}]*\bclipboard\b[^}]*\}\s*from\s*"electron"|navigator\.clipboard\.write/,
      ),
    ).toEqual([]);
  });
});
