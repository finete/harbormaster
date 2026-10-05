import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Git-backed integration tests fork real processes; headroom for suite-wide load.
    testTimeout: 30_000,
  },
});
