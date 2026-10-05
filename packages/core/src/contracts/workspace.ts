// Workspace contracts — the git repository/worktree Resource Access
// boundary (core phase 2b). Ported and reshaped from pi-home's
// src/access/git-repository-access.ts + git-worktree-access.ts: normalized
// remote identity ("github.com/org/repo") carries over unchanged, but the
// shape is explicit-codeRoot / cwd-driven verbs instead of pi-home's
// preference-map discovery, and task worktrees are scoped under a fixed
// <codeRoot>/.harbormaster-worktrees/ directory instead of pi-home's
// free-form worktree roots. Managers and Engines only ever see these
// interfaces; concrete git-shelling-out implementations live in access/.

/** One discoverable Git repository checkout under a code root. */
export interface RepositoryInfo {
  /**
   * Normalized remote identity, e.g. `"github.com/org/repo"` (ssh and https
   * remote URLs both normalize to this form, case-folded, `.git` stripped).
   * Falls back to the realpath of `root` when the checkout has no `origin`
   * remote.
   */
  id: string;
  /** Absolute, realpath-resolved path to the repository's checkout. */
  root: string;
  /** Best-effort default branch (origin/HEAD, else main/master, else current branch). */
  defaultBranch: string;
  /** Raw `origin` remote URL, if the repository has one configured. */
  remoteUrl?: string;
}

/** One Git worktree attached to a repository. */
export interface WorktreeInfo {
  path: string;
  /** Checked-out branch name, absent when the worktree is in detached-HEAD state. */
  branch?: string;
  head: string;
  detached: boolean;
}

/**
 * Resource Access: repository discovery and identity. All git process
 * invocations for repository-level operations stay behind this interface
 * (and {@link GitWorktreeAccess}) — Managers and Engines never shell out to
 * git directly.
 */
export interface GitRepositoryAccess {
  /**
   * Find every Git checkout directly under `codeRoot` (one level deep,
   * dotfiles skipped), describing each as a {@link RepositoryInfo}.
   */
  discoverRepositories(codeRoot: string): Promise<RepositoryInfo[]>;
  /** Resolve the repository whose checkout contains `cwd`. */
  resolveRepository(cwd: string): Promise<RepositoryInfo>;
}

/**
 * Resource Access: worktree lifecycle for task execution. Task worktrees
 * live under `<codeRoot>/.harbormaster-worktrees/` (one directory per
 * branch) so they are easy to find, gitignore, and garbage-collect
 * independently of a repository's own checkout tree.
 */
export interface GitWorktreeAccess {
  listWorktrees(repo: RepositoryInfo): Promise<WorktreeInfo[]>;
  /**
   * Create a branched worktree for task execution under
   * `<codeRoot>/.harbormaster-worktrees/`, branching `branch` off `baseRef`.
   */
  createTaskWorktree(
    repo: RepositoryInfo,
    branch: string,
    baseRef: string,
  ): Promise<WorktreeInfo>;
  /**
   * Remove a worktree. Refuses when the worktree has uncommitted changes
   * (staged, unstaged, or untracked) unless `force` is true.
   */
  removeWorktree(
    repo: RepositoryInfo,
    path: string,
    force?: boolean,
  ): Promise<void>;
  branchExists(repo: RepositoryInfo, branch: string): Promise<boolean>;
  /**
   * Delete a branch. Uses a safe, non-force delete (refusing branches not
   * merged into HEAD) unless `force` is true. No-op if the branch is already
   * gone.
   */
  deleteBranch(
    repo: RepositoryInfo,
    branch: string,
    force?: boolean,
  ): Promise<void>;
  /**
   * Push `branch` from the worktree at `path` to `origin`, setting upstream
   * tracking. The only git-write verb the GitHub lifecycle commands need;
   * kept here (not in GithubPrAccess) because all git I/O stays in git
   * access per the accessor-separation rule.
   */
  pushBranch(path: string, branch: string): Promise<void>;
}

// Ambient augmentation (not a textual edit of contracts/model.ts, which is
// owned by concurrent work on this branch): GlobalConfig gains the two
// workspace-discovery fields this phase needs. `codeRoot` is the absolute
// folder containing every repository checkout (default `~/Code`);
// `branchPrefix` optionally namespaces every branch Harbormaster creates
// (default `""`, meaning no prefix). json-config-access.ts validates and
// defaults both on load.
