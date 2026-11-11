#!/usr/bin/env node
// Bundles the `harbormaster` CLI (packages/cli, bin `harbormaster`) into one
// ESM file, out/cli/harbormaster.mjs, for electron-builder's extraResources
// (see electron-builder.yml). The packaged launcher
// resources/bin/harbormaster runs it with the app's Electron in Node mode,
// so the bundle must be self-contained: workspace packages
// (@harbormaster/core) and npm dependencies are inlined.
//
// Tolerates a checkout without packages/cli (the CLI lands in a separate
// wave): it then writes a stub that explains the CLI is not part of this
// build, and packaging still succeeds.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(appDir, "..", "..");
const cliDir = join(root, "packages", "cli");
const outDir = join(appDir, "out", "cli");
const outFile = join(outDir, "harbormaster.mjs");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const cliPackageFile = join(cliDir, "package.json");
if (!existsSync(cliPackageFile)) {
  writeFileSync(
    outFile,
    [
      "// Placeholder: this build was packaged without packages/cli.",
      'console.error("harbormaster: the CLI is not included in this build of Harbormaster.");',
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  console.warn(
    "[bundle-cli] packages/cli not found: packaged a stub harbormaster CLI",
  );
  process.exit(0);
}

const cliPackage = JSON.parse(readFileSync(cliPackageFile, "utf8"));
const bin =
  typeof cliPackage.bin === "string"
    ? cliPackage.bin
    : cliPackage.bin?.harbormaster;
if (!bin) {
  throw new Error(
    `${cliPackageFile} has no "bin": { "harbormaster": … } entry`,
  );
}
if (cliPackage.scripts?.build) {
  execFileSync("npm", ["run", "build"], { cwd: cliDir, stdio: "inherit" });
}
const entry = join(cliDir, bin);
if (!existsSync(entry)) {
  throw new Error(`harbormaster CLI entry ${entry} does not exist after build`);
}

// esbuild comes with vite (already a dev dependency); use vite's copy rather
// than adding a direct dependency.
const requireFromVite = createRequire(
  createRequire(import.meta.url).resolve("vite"),
);
const esbuild = requireFromVite("esbuild");

await esbuild.build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  // Electron 33 runs Node 20 (ELECTRON_RUN_AS_NODE in the launcher).
  target: "node20",
  // CommonJS dependencies inside an ESM bundle still call `require`.
  banner: {
    js: "import { createRequire as __hmCreateRequire } from 'node:module'; const require = __hmCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});
console.log(`[bundle-cli] bundled ${entry} -> ${outFile}`);
