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

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
