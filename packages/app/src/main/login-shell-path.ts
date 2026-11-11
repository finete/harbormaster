// The app's PATH is the login shell's PATH, not the launcher's.
//
// An Electron app started from the Dock (or `npm run dev` from a shell that
// didn't source the user's profile) inherits a minimal PATH, so `pi`,
// `claude` (`~/.local/bin`), `gh` and Homebrew's git all read as "not
// found" and every launch spec fails. VS Code and the other desktop dev
// tools solve this the same way: ask the user's login shell for its PATH
// once at startup and adopt it. Everything downstream (`commandExists`,
// `detectAgents`, pty env, `gh` runs) reads `process.env.PATH`, so one
// assignment before `app.whenReady` covers them all.
//
// Pure helpers here; `applyLoginShellPath` is the one with side effects.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Directories every macOS/Linux dev box tends to have but a Dock-launched PATH lacks. */
export function wellKnownBinDirs(home: string = homedir()): string[] {
  return [
    join(home, ".local", "bin"), // Claude Code's native installer
    join(home, ".pi", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".cargo", "bin"),
    join(home, "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
}

/** `shellPath` first, then the current PATH, then the well-known dirs; deduplicated, empty entries dropped. */
export function mergePath(
  shellPath: string | undefined,
  currentPath: string | undefined,
  extras: string[],
): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of [shellPath, currentPath, extras.join(delimiter)]) {
    for (const entry of (source ?? "").split(delimiter)) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
  }
  return out.join(delimiter);
}

/**
 * The PATH the user's interactive login shell ends up with, or `undefined`
 * when the shell cannot be run (timeout, no `$SHELL`, non-zero exit). The
 * marker lines keep profile noise (motd, warnings) out of the result.
 */
export function readLoginShellPath(
  shell: string | undefined,
  run: (
    file: string,
    args: string[],
    options: { timeout: number; env: NodeJS.ProcessEnv },
  ) => string = (file, args, options) =>
    execFileSync(file, args, {
      ...options,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!shell || process.platform === "win32") return undefined;
  const marker = "__HARBORMASTER_PATH__";
  try {
    const out = run(
      shell,
      ["-ilc", `printf '%s%s%s' '${marker}' "$PATH" '${marker}'`],
      {
        timeout: 5000,
        // Interactive shells that see these think they are inside another
        // tool and may print or behave differently; a clean env is safer.
        env: {
          ...env,
          ELECTRON_RUN_AS_NODE: undefined,
          DISABLE_AUTO_TITLE: "true",
        },
      },
    );
    const start = out.indexOf(marker);
    const end = out.lastIndexOf(marker);
    if (start === -1 || end <= start) return undefined;
    const value = out.slice(start + marker.length, end).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the login shell PATH and write the merged result to `process.env.PATH`. Returns what was applied. */
export function applyLoginShellPath(): string {
  const merged = mergePath(
    readLoginShellPath(process.env.SHELL),
    process.env.PATH,
    wellKnownBinDirs(),
  );
  process.env.PATH = merged;
  return merged;
}
