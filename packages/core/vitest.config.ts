import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Sandbox HOME so no test can fall back to the real ~/Code or ~/.harbormaster.
    setupFiles: ["../../vitest.isolate-home.ts"],
    include: ["tests/**/*.test.ts"],
    // Git-backed integration tests fork real processes; headroom for suite-wide load.
    testTimeout: 30_000,
  },
});
