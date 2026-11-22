// Vitest setup file (every package): give each test file its own empty HOME.
//
// Core defaults codeRoot to ~/Code and the state dir to ~/.harbormaster. A
// test that forgets to pin them (no config.json in its temp stateDir) would
// otherwise discover the developer's real repositories and create real
// worktrees in them on every run — that leaked ~230 worktrees (~270 GB)
// into ~/Code/.harbormaster-worktrees before this guard. With HOME pointed
// at a throwaway dir, any such fallback lands in an empty sandbox instead
// (where discovery finds nothing and the test fails loudly).
//
// Set before any test module is imported, so import-time constants
// (DEFAULT_STATE_DIR) resolve against the sandbox too. Child processes
// (git, gh) inherit it; tests already pass identity via `git -c`.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const home = mkdtempSync(
  join(realpathSync(tmpdir()), "harbormaster-test-home-"),
);
process.env.HOME = home;
process.env.USERPROFILE = home;

// Task launches fetch `origin` (core's `resolveDefaultBase`). Fixture repos
// carry made-up remotes (`https://github.com/test/fixture.git`,
// `git@github.com:acme/...`) that must never reach the network: point git's
// HTTP proxy at a closed port and its ssh at `false`, so such a fetch fails
// at once and the launch falls back to the local branch, the same path a
// repository without a reachable origin takes. Local-path remotes
// (`file://`, bare repos on disk) are unaffected.
// Idempotent: setup files and configs load once per test file / worker.
if (!process.env.HARBORMASTER_TEST_NO_GIT_NETWORK) {
  process.env.HARBORMASTER_TEST_NO_GIT_NETWORK = "1";
  const count = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  process.env[`GIT_CONFIG_KEY_${count}`] = "http.proxy";
  process.env[`GIT_CONFIG_VALUE_${count}`] = "http://127.0.0.1:9";
  process.env.GIT_CONFIG_COUNT = String(count + 1);
  process.env.GIT_SSH_COMMAND ??= "false";
}

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
