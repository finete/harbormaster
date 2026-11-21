// Detects the installed app being replaced under the running process (a
// `brew upgrade` while Harbormaster is open). Electron indexes app.asar once
// at startup, so a window this process opens or reloads afterwards reads the
// new archive at the old offsets and renders a slice of minified JS as text.
//
// The executable's stat is captured at launch; a different file at that path
// later means "replaced". A missing one (mid-swap, or uninstalled) does not:
// the next check looks again.
import { readFileSync, statSync } from "node:fs";
import { midTurnRestartWarning } from "../shared/mid-turn";

export interface BundleStamp {
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface BundleGuardFs {
  stat(path: string): BundleStamp;
  readFile(path: string): string;
}

export interface BundleReplacement {
  /** The version now installed on disk, when its Info.plist is readable. */
  installedVersion: string | undefined;
}

export interface AppBundleGuard {
  /** `undefined` while the installed app is still the one this process started from. */
  replacement(): BundleReplacement | undefined;
}

export function nodeBundleGuardFs(): BundleGuardFs {
  return {
    stat: (path) => {
      const { ino, size, mtimeMs } = statSync(path);
      return { ino, size, mtimeMs };
    },
    readFile: (path) => readFileSync(path, "utf8"),
  };
}

export function plistVersion(plist: string): string | undefined {
  return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(
    plist,
  )?.[1];
}

function sameStamp(a: BundleStamp, b: BundleStamp): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

export function createAppBundleGuard(input: {
  executablePath: string;
  infoPlistPath?: string | undefined;
  fs?: BundleGuardFs;
}): AppBundleGuard {
  const fs = input.fs ?? nodeBundleGuardFs();
  const stampNow = (): BundleStamp | undefined => {
    try {
      return fs.stat(input.executablePath);
    } catch {
      return undefined;
    }
  };
  const initial = stampNow();
  if (!initial) return { replacement: () => undefined };
  const installedVersion = (): string | undefined => {
    if (!input.infoPlistPath) return undefined;
    try {
      return plistVersion(fs.readFile(input.infoPlistPath));
    } catch {
      return undefined;
    }
  };
  return {
    replacement: () => {
      const current = stampNow();
      if (!current || sameStamp(initial, current)) return undefined;
      return { installedVersion: installedVersion() };
    },
  };
}

export type ReplacedAppChoice = "restart" | "quit" | "cancel";

export interface ReplacedAppPrompt {
  message: string;
  detail: string;
  buttons: string[];
  /** What each of `buttons` does, by index. */
  choices: ReplacedAppChoice[];
  defaultId: number;
  cancelId: number;
}

/**
 * The native question shown instead of loading a window from a replaced app.
 * With agents mid-turn it warns like the update card and offers Cancel, which
 * keeps them running and loads nothing.
 */
export function replacedAppPrompt(
  update: { version: string | null; runningVersion: string },
  midTurn: number,
): ReplacedAppPrompt {
  const reinstalled = update.version === update.runningVersion;
  const message = reinstalled
    ? "Harbormaster was reinstalled while it was running."
    : update.version
      ? `Harbormaster ${update.version} was installed while ${update.runningVersion} was running.`
      : "Harbormaster was updated while it was running.";
  if (midTurn > 0) {
    return {
      message,
      detail: midTurnRestartWarning(midTurn),
      buttons: ["Restart anyway", "Cancel"],
      choices: ["restart", "cancel"],
      defaultId: 1,
      cancelId: 1,
    };
  }
  return {
    message,
    detail: reinstalled
      ? "Restart to keep things working."
      : "Restart to open the new version.",
    buttons: ["Restart", "Quit"],
    choices: ["restart", "quit"],
    defaultId: 0,
    cancelId: 1,
  };
}
