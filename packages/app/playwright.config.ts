import { defineConfig } from "@playwright/test";

// Enable xterm's a11y mirror for the full e2e suite so `toContainText`
// assertions read terminal text the same way in every spec, via the
// accessibility tree (stable plain text, independent of renderer markup).
// Performance specs that measure production config pass
// HARBORMASTER_TERMINAL_A11Y_MIRROR=0 in their own env to override this.
// See P1-1 in terminal-perf-checklist.md.
process.env.HARBORMASTER_TERMINAL_A11Y_MIRROR ??= "1";

// Every spec starts on a fresh state dir, which would show the first-run
// wizard (components/Onboarding.tsx) before the normal UI. Skip it suite
// wide; e2e/onboarding.spec.ts sets HARBORMASTER_SKIP_ONBOARDING=0 to
// exercise it. The packaged app never sets this.
process.env.HARBORMASTER_SKIP_ONBOARDING ??= "1";

// Every launch uses a private in-memory clipboard (main/app-clipboard.ts):
// a spec seeds and reads it through `globalThis.__harbormasterTestClipboard`
// in main, and never overwrites what the developer copied. The packaged
// app never sets it.
process.env.HARBORMASTER_E2E_FAKE_CLIPBOARD ??= "1";

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

// A run started inside a Harbormaster task session (an agent running the
// suite) inherits that session's identity markers (core's
// harness/adapter-common.ts `baseLaunchEnv`). Specs spread `process.env`
// into the CLI and agents they spawn, which would then reach the user's
// real app instead of the test app. Drop them so every run is the same
// from a task, a terminal, or CI.
for (const key of [
  "HARBORMASTER",
  "HARBORMASTER_TASK_ID",
  "HARBORMASTER_SESSION_ID",
  "HARBORMASTER_STATE_DIR",
  "HARBORMASTER_SOCKET",
  "HARBORMASTER_CLI",
]) {
  delete process.env[key];
}

// Smoke-lane e2e config for the Electron app shell. Playwright drives the
// already-built electron-vite output (`out/main/index.js`) via its Electron
// support (`_electron.launch`) — see e2e/smoke.spec.ts. `npm run build` must
// run before this; `npm test` in package.json wires that order.
export default defineConfig({
  testDir: "./e2e",
  // Warns when the real clipboard changed during the run (see the file).
  globalSetup: "./e2e/clipboard-guard.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
});
