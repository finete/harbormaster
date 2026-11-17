// Git error wording that core logic keys on, across git versions.

/**
 * A worktree folder whose git metadata is gone: git 2.39 (Apple Git) says
 * "fatal: not a git repository: …/.git/worktrees/<name>", git 2.43+ says
 * "fatal: '<path>' is not a working tree".
 */
export const ORPHAN_WORKTREE_ERROR =
  /not a git repository|is not a working tree/i;
