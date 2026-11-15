// Utility: the Harbormaster Pi inbox extension's identity rules, shared by
// the app's installer (packages/app/src/main/agent-tooling.ts) and the
// doctor's `agents.pi-extension` check: the file name Pi auto-loads, where
// Pi's extensions directory is, and the version marker the copies compare by.

import { join } from "node:path";

/** File name of the installed Pi inbox extension (Pi auto-loads `*.ts` in its extensions dir). */
export const PI_EXTENSION_FILE = "harbormaster-inbox.ts";

/**
 * Pi's personal extensions directory: `HARBORMASTER_PI_EXTENSIONS_DIR`
 * (tests), else `$PI_CODING_AGENT_DIR/extensions`, else
 * `<home>/.pi/agent/extensions`.
 */
export function resolvePiExtensionsDir(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  if (env.HARBORMASTER_PI_EXTENSIONS_DIR) {
    return env.HARBORMASTER_PI_EXTENSIONS_DIR;
  }
  const agentDir = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
  return join(agentDir, "extensions");
}

const VERSION_PATTERN = /HARBORMASTER_INBOX_EXTENSION_VERSION\s*=\s*(\d+)/;

/** The integer version an extension source declares (`HARBORMASTER_INBOX_EXTENSION_VERSION = N`). */
export function readExtensionVersion(source: string): number | undefined {
  const match = VERSION_PATTERN.exec(source);
  return match ? Number(match[1]) : undefined;
}

/** How an installed extension compares with the bundled one. */
export type PiExtensionComparison =
  | "missing"
  | "unversioned"
  | "stale"
  | "current"
  | "differs"
  | "newer"
  | "no-bundled";

/**
 * Installed vs bundled extension text: `stale` when the bundled copy
 * declares a newer version (the app replaces it on its next start),
 * `differs` for the same version with other content (hand-edited),
 * `newer` for a later version than the bundled copy.
 */
export function comparePiExtension(
  installed: string | undefined,
  bundled: string | undefined,
): PiExtensionComparison {
  if (installed === undefined) return "missing";
  const installedVersion = readExtensionVersion(installed);
  if (installedVersion === undefined) return "unversioned";
  if (bundled === undefined) return "no-bundled";
  const bundledVersion = readExtensionVersion(bundled);
  if (bundledVersion === undefined) return "no-bundled";
  if (bundledVersion > installedVersion) return "stale";
  if (bundledVersion < installedVersion) return "newer";
  return installed === bundled ? "current" : "differs";
}
