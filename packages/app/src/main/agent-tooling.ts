// Where the app finds the agent-facing pieces it ships (decision #18):
// the `harbormaster` CLI that agents' MCP configs and hooks run, and the
// one-file Pi inbox extension it installs into Pi's extensions directory.
// The app's PATH is not the user's shell PATH, so everything resolves to
// absolute paths. In development both come from the monorepo checkout;
// packaged builds read them from `resources/` (wired by the build wave).

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ToolingLocations {
  env: NodeJS.ProcessEnv;
  /** `app.isPackaged`. */
  isPackaged: boolean;
  /** `process.resourcesPath` (packaged builds). */
  resourcesPath: string;
  /** The main bundle's directory (`__dirname`, i.e. `packages/app/out/main` in development). */
  mainDir: string;
}

/** The monorepo's `packages/` directory, seen from the built main bundle. */
function packagesDir(mainDir: string): string {
  return join(mainDir, "..", "..", "..");
}

/** File name of the installed Pi inbox extension (Pi auto-loads `*.ts` in its extensions dir). */
export const PI_EXTENSION_FILE = "harbormaster-inbox.ts";

/** The bundled Pi inbox extension source. */
export function resolvePiExtensionSource(
  locations: ToolingLocations,
): string | undefined {
  const override = locations.env.HARBORMASTER_PI_EXTENSION_SOURCE;
  if (override) return override;
  const source = locations.isPackaged
    ? join(locations.resourcesPath, "pi-extension", PI_EXTENSION_FILE)
    : join(packagesDir(locations.mainDir), "extension", "src", "index.ts");
  return existsSync(source) ? source : undefined;
}

/**
 * Pi's personal extensions directory: `HARBORMASTER_PI_EXTENSIONS_DIR`
 * (tests), else `$PI_CODING_AGENT_DIR/extensions`, else
 * `~/.pi/agent/extensions`.
 */
export function piExtensionsDir(env: NodeJS.ProcessEnv): string {
  if (env.HARBORMASTER_PI_EXTENSIONS_DIR) {
    return env.HARBORMASTER_PI_EXTENSIONS_DIR;
  }
  const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "extensions");
}

const VERSION_PATTERN = /HARBORMASTER_INBOX_EXTENSION_VERSION\s*=\s*(\d+)/;

/** The integer version an extension source declares (`HARBORMASTER_INBOX_EXTENSION_VERSION = N`). */
export function readExtensionVersion(source: string): number | undefined {
  const match = VERSION_PATTERN.exec(source);
  return match ? Number(match[1]) : undefined;
}

export type PiExtensionInstallOutcome =
  | "installed"
  | "updated"
  | "current"
  | "no-source";

/**
 * Copies the bundled inbox extension into Pi's extensions dir when it is
 * missing or older than the bundled one (decision R13: no prompt, nothing
 * else global). Atomic (temp file + rename) so Pi never loads half a file.
 */
export function installPiExtension(input: {
  sourcePath: string | undefined;
  targetDir: string;
}): PiExtensionInstallOutcome {
  if (!input.sourcePath || !existsSync(input.sourcePath)) return "no-source";
  const bundled = readExtensionVersion(readFileSync(input.sourcePath, "utf8"));
  const target = join(input.targetDir, PI_EXTENSION_FILE);
  let installed: number | undefined;
  if (existsSync(target)) {
    installed = readExtensionVersion(readFileSync(target, "utf8")) ?? 0;
    if (bundled === undefined || installed >= bundled) return "current";
  }
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  copyFileSync(input.sourcePath, temp);
  renameSync(temp, target);
  return installed === undefined ? "installed" : "updated";
}
