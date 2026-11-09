import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Sandbox HOME so no test can fall back to the real ~/Code or ~/.harbormaster.
    setupFiles: ["../../vitest.isolate-home.ts"],
    include: ["tests/**/*.test.ts"],
  },
});
