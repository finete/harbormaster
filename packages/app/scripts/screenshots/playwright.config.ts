import { defineConfig } from "@playwright/test";

// On-demand design screenshots (see design-screenshots.spec.ts); kept out
// of the e2e suite's testDir so the gate never pays for it.
process.env.HARBORMASTER_SKIP_ONBOARDING ??= "1";

export default defineConfig({
  testDir: ".",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
});
