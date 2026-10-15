// Resource Access: the one filesystem question the migration mapping needs
// that core's existing access classes don't already answer — does a
// recorded `.pi-home-worktrees` path still exist on disk? Read-only (a
// `stat`, never a write), kept separate from `LocalGitWorktreeAccess` since
// that class owns Harbormaster's own `.harbormaster-worktrees` layout and
// has no reason to know about pi-home's.

import { stat } from "node:fs/promises";

export class WorktreeProbeAccess {
  async exists(worktreePath: string | undefined): Promise<boolean> {
    if (!worktreePath) return false;
    try {
      const info = await stat(worktreePath);
      return info.isDirectory();
    } catch {
      return false;
    }
  }
}
