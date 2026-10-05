import { defineConfig } from "@playwright/test";

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
