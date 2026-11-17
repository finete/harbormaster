// Utility: the path a process started in `path` sees as its cwd. macOS
// symlinks `/tmp` → `/private/tmp` (and `/var` → `/private/var`); agents
// key their session directories by `process.cwd()`, which is always the
// resolved path, so a prediction from the unresolved one misses
// (expectedSessionFile, docs/harness-additions.md).

import { realpathSync } from "node:fs";

/** `realpath(path)`, or `path` itself when it does not exist (yet). */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
