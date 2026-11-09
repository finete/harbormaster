import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// electron-vite config — three independent bundles (main / preload / renderer).
// See /AGENTS.md for the fixed UI stack this skeleton proves out.
export default defineConfig({
  main: {
    // @harbormaster/core ships ESM-only (`"type": "module"`), which an
    // externalized `require()` can't load from this CJS main bundle (Node
    // ERR_REQUIRE_ESM). Excluding it from externalization bundles it
    // through Rollup instead, which transpiles it to CJS like everything
    // else in this output — every other dependency stays externalized
    // and `require()`d from node_modules as before.
    plugins: [externalizeDepsPlugin({ exclude: ["@harbormaster/core"] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          // Utility process that runs core's git/gh spawns off the main
          // event loop (src/main/spawn-host-client.ts).
          "spawn-host": resolve(__dirname, "src/main/spawn-host.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
        },
        output: {
          // Keep heavyweight vendor code out of the app chunk; silences the
          // 500kB warning with real splitting instead of a raised limit.
          manualChunks: {
            xterm: ["@xterm/xterm", "@xterm/addon-fit"],
            dockview: ["dockview-react"],
            react: ["react", "react-dom"],
          },
        },
      },
    },
  },
});
