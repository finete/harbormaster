import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.ts"],
    environment: "node",
    // Git-backed integration tests fork real processes; headroom for suite-wide load.
    testTimeout: 30_000,
  },
});
