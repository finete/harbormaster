import { defineConfig } from "@playwright/test";

// Enable xterm's a11y mirror for the full e2e suite so `toContainText`
// assertions read terminal text the same way in every spec, via the
// accessibility tree (stable plain text, independent of renderer markup).
// Performance specs that measure production config pass
// HARBORMASTER_TERMINAL_A11Y_MIRROR=0 in their own env to override this.
// See P1-1 in terminal-perf-checklist.md.
process.env.HARBORMASTER_TERMINAL_A11Y_MIRROR ??= "1";

// Smoke-lane e2e config for the Electron app shell. Playwright drives the
// already-built electron-vite output (`out/main/index.js`) via its Electron
// support (`_electron.launch`) — see e2e/smoke.spec.ts. `npm run build` must
// run before this; `npm test` in package.json wires that order.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
});
