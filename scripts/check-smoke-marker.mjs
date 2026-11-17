#!/usr/bin/env node
// Real-smoke marker freshness (docs/harness-additions.md P4).
//
// packages/app/e2e/real-smoke.spec.ts writes <repo root>/.real-smoke-ok
// ({ commit, at, harnesses }) at the end of a fully passing run. This check
// fails unless that marker exists and its commit is at or after the last
// commit touching the harness code or its test doubles (HARNESS_PATHS), and
// those paths carry no uncommitted changes (a smoke run cannot vouch for
// code that has no commit yet: commit, rerun the smoke, then gate).
//
//   node scripts/check-smoke-marker.mjs [repo root]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER_FILE = ".real-smoke-ok";

/** Git pathspecs whose changes invalidate the real smoke. */
export const HARNESS_PATHS = [
  "packages/core/src/harness/",
  "packages/app/e2e/fake-*.ts",
  "packages/app/e2e/contracts/",
];

const RERUN =
  "run the real smoke: cd packages/app && npx electron-vite build && HARBORMASTER_REAL_SMOKE=1 npx playwright test e2e/real-smoke.spec.ts";

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitOk(root, args) {
  try {
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks the marker under `root`. Returns `{ ok, message }`; never throws
 * for an expected failure (missing, unreadable, stale marker).
 */
export function checkSmokeMarker(root) {
  const file = join(root, MARKER_FILE);
  if (!existsSync(file)) {
    return { ok: false, message: `no ${MARKER_FILE}; ${RERUN}` };
  }
  let marker;
  try {
    marker = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return {
      ok: false,
      message: `${MARKER_FILE} is not JSON (${error.message}); ${RERUN}`,
    };
  }
  const commit = typeof marker?.commit === "string" ? marker.commit : "";
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    return {
      ok: false,
      message: `${MARKER_FILE} has no commit hash; ${RERUN}`,
    };
  }
  if (!gitOk(root, ["cat-file", "-e", `${commit}^{commit}`])) {
    return {
      ok: false,
      message: `${MARKER_FILE} names ${commit.slice(0, 12)}, which is not in this repository; ${RERUN}`,
    };
  }
  const dirty = git(root, ["status", "--porcelain", "--", ...HARNESS_PATHS]);
  if (dirty) {
    return {
      ok: false,
      message: `uncommitted harness changes:\n${dirty}\ncommit them, then ${RERUN}`,
    };
  }
  const last = git(root, ["log", "-1", "--format=%H", "--", ...HARNESS_PATHS]);
  if (last && !gitOk(root, ["merge-base", "--is-ancestor", last, commit])) {
    return {
      ok: false,
      message: `${MARKER_FILE} (${commit.slice(0, 12)}, ${marker.at ?? "unknown time"}) predates the last harness change ${last.slice(0, 12)}; ${RERUN}`,
    };
  }
  const harnesses = Array.isArray(marker.harnesses)
    ? marker.harnesses.join(", ")
    : "?";
  return {
    ok: true,
    message: `real smoke ok at ${commit.slice(0, 12)} (${marker.at ?? "unknown time"}; ${harnesses})`,
  };
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const root = resolve(process.argv[2] ?? join(dirname(self), ".."));
  const result = checkSmokeMarker(root);
  (result.ok ? console.log : console.error)(
    `check-smoke-marker: ${result.message}`,
  );
  process.exit(result.ok ? 0 : 1);
}
