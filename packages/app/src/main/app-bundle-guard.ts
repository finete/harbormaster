// Detects the installed app being replaced under the running process (a
// `brew upgrade` while Harbormaster is open). Electron indexes app.asar once
// at startup, so a window this process opens or reloads afterwards reads the
// new archive at the old offsets and renders a slice of minified JS as text.
//
// The executable's stat is captured at launch; any later difference (new
// inode from the swapped bundle, or the file gone) means "replaced".
import { readFileSync, statSync } from "node:fs";

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
      if (current && sameStamp(initial, current)) return undefined;
      return { installedVersion: installedVersion() };
    },
  };
}
