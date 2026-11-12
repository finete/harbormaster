// Design-system guard (docs/design-system.md): color in the renderer comes
// only from the tokens (`primary`, `status-*`, `muted-foreground`, …). Blue
// is gone from the product, green/teal is only ever the mint token, and
// amber exists only as the needs-you status token, so no renderer file may
// use a hardcoded Tailwind palette class from those families.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER_SRC = path.resolve(__dirname, "../src/renderer/src");

const BANNED =
  /\b(?:sky|blue|emerald|green|cyan|yellow|amber)-(?:50|[1-9]00|950)\b/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(tsx?|css|html)$/.test(name) ? [full] : [];
  });
}

function bannedHits(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return text
    .split("\n")
    .flatMap((line, index) =>
      [...line.matchAll(BANNED)].map(
        (match) =>
          `${path.relative(RENDERER_SRC, file)}:${index + 1} ${match[0]}`,
      ),
    );
}

describe("renderer design tokens", () => {
  it("the scan pattern catches palette classes", () => {
    const sample =
      "text-amber-300 bg-sky-500/10 hover:border-emerald-900 accent-blue-950";
    expect(sample.match(BANNED)).toEqual([
      "amber-300",
      "sky-500",
      "emerald-900",
      "blue-950",
    ]);
    expect("text-status-needsYou bg-primary/20".match(BANNED)).toBeNull();
  });

  it("no renderer file uses a banned Tailwind color class", () => {
    const files = sourceFiles(RENDERER_SRC);
    expect(files.length).toBeGreaterThan(20);
    const hits = files.flatMap(bannedHits);
    expect(hits).toEqual([]);
  });
});
