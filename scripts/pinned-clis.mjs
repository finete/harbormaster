#!/usr/bin/env node
// Prints the agent CLI packages pinned by the keyless real-CLI tier
// (`PINNED` in packages/app/tests/real-cli-smoke.test.ts), one per line,
// sorted. CI keys its npm-prefix cache on this output, so the cache key
// follows the test's pins and never drifts. The test file is read as text
// (importing it would load node-pty and core).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "app",
  "tests",
  "real-cli-smoke.test.ts",
);

/** The pinned package specs in `source`'s `export const PINNED = { … }`. */
export function pinnedClis(source) {
  const block = /export const PINNED = \{([^}]*)\}/.exec(source)?.[1];
  if (!block) throw new Error("no `export const PINNED = { … }` block");
  const specs = [...block.matchAll(/:\s*"([^"]+@[^"]+)"/g)].map((m) => m[1]);
  if (specs.length === 0) throw new Error("PINNED lists no package specs");
  return specs.sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(pinnedClis(readFileSync(TEST, "utf8")).join("\n"));
}
