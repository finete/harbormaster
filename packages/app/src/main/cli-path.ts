// Where the `harbormaster` CLI lives, for anything the app hands an absolute
// path to (agent hooks, MCP config, diagnostics). The app's PATH is not the
// user's shell PATH, so this never relies on a PATH lookup.
//
// - Packaged: electron-builder copies `resources/bin/harbormaster` (a shell
//   wrapper running the bundled CLI with the app's own Electron in Node
//   mode) into `Harbormaster.app/Contents/Resources/bin/` (see
//   electron-builder.yml `extraResources`). The Homebrew cask's `binary`
//   stanza links the same file onto the user's PATH.
// - Dev: the workspace's `node_modules/.bin/harbormaster` link, else the
//   `bin` entry of `packages/cli/package.json`.
// - Neither present (the CLI package not built yet): `undefined`. Callers
//   must treat that as "CLI unavailable", never crash.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface CliPathContext {
  isPackaged: boolean;
  /** `process.resourcesPath` (packaged app's Contents/Resources). */
  resourcesPath: string;
  /** `app.getAppPath()`: `packages/app` in dev. */
  appPath: string;
  /** Explicit override (`HARBORMASTER_CLI_PATH`), used as-is when it exists. */
  override?: string | undefined;
  exists?: (path: string) => boolean;
  readText?: (path: string) => string;
}

function binEntry(packageJsonText: string): string | undefined {
  try {
    const pkg = JSON.parse(packageJsonText) as {
      bin?: string | Record<string, string>;
    };
    if (typeof pkg.bin === "string") return pkg.bin;
    return pkg.bin?.harbormaster;
  } catch {
    return undefined;
  }
}

/** Walks up from `start` to the first directory holding `packages/cli`. */
function findWorkspaceRoot(
  start: string,
  exists: (path: string) => boolean,
): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (exists(join(dir, "packages", "cli", "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function resolveCliPath(context: CliPathContext): string | undefined {
  const exists = context.exists ?? existsSync;
  const readText = context.readText ?? ((path) => readFileSync(path, "utf8"));
  if (context.override && exists(context.override)) return context.override;

  if (context.isPackaged) {
    const bundled = join(context.resourcesPath, "bin", "harbormaster");
    return exists(bundled) ? bundled : undefined;
  }

  const root = findWorkspaceRoot(context.appPath, exists);
  if (!root) return undefined;
  const linked = join(root, "node_modules", ".bin", "harbormaster");
  if (exists(linked)) return linked;
  const cliDir = join(root, "packages", "cli");
  let entry: string | undefined;
  try {
    entry = binEntry(readText(join(cliDir, "package.json")));
  } catch {
    return undefined;
  }
  if (!entry) return undefined;
  const path = join(cliDir, entry);
  return exists(path) ? path : undefined;
}
