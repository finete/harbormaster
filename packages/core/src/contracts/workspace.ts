// Workspace contracts — the git repository/worktree Resource Access
// boundary (core phase 2b). Ported and reshaped from pi-home's
// src/access/git-repository-access.ts + git-worktree-access.ts: normalized
// remote identity ("github.com/org/repo") carries over unchanged, but the
// shape is explicit-codeRoot / cwd-driven verbs instead of pi-home's
// preference-map discovery, and task worktrees are scoped under a fixed
// <codeRoot>/.harbormaster-worktrees/ directory instead of pi-home's
// free-form worktree roots. Managers and Engines only ever see these
// interfaces; concrete git-shelling-out implementations live in access/.

/**
 * One known checkout of a {@link RepositoryInfo}'s identity (there may be
 * several under a code root, e.g. `arnac`, `arnac2`, `arnac3` all cloning
 * the same remote).
 */
export interface RepositoryCheckout {
  /** Absolute, realpath-resolved path to this checkout. */
  root: string;
  /** Whether this is the repository's primary checkout (`=== RepositoryInfo.root`). */
  isPrimary: boolean;
}

/**
 * One discoverable Git *repository identity* under a code root — several
 * directory checkouts of the same remote (or, for remoteless repos, the
 * same git-common-dir) are grouped into a single entry here, ported from
 * pi-home's `src/access/git-repository-access.ts` grouping. `root` always
 * points at the primary checkout (see {@link RepositoryCheckout}); task
 * worktrees are only ever provisioned from it.
 */
export interface RepositoryInfo {
  /**
   * Normalized remote identity, e.g. `"github.com/org/repo"` (ssh and https
   * remote URLs both normalize to this form, case-folded, `.git` stripped).
   * Falls back to the realpath of the checkout's git-common-dir when no
   * checkout in the group has an `origin` remote.
   */
  id: string;
  /** Absolute, realpath-resolved path to the repository's primary checkout. */
  root: string;
  /** Best-effort default branch (origin/HEAD, else main/master, else current branch), read from the primary checkout. */
  defaultBranch: string;
  /** Raw `origin` remote URL, if any checkout in the group has one configured. */
  remoteUrl?: string;
  /** Every known checkout of this repository identity, including the primary, sorted by path. */
  checkouts: RepositoryCheckout[];
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
   * dotfiles skipped), group them by repository identity (normalized remote,
   * falling back to git-common-dir for remoteless repos), and return one
   * {@link RepositoryInfo} per identity. `preferredCheckouts` (keyed by
   * repository id, from `GlobalConfig.repositories[id].preferredCheckout`)
   * honors an explicit primary-checkout choice when the path is valid (a
   * known, non-linked-worktree checkout of that identity); otherwise the
   * primary is the alphabetically-first non-linked-worktree checkout.
   */
  discoverRepositories(
    codeRoot: string,
    preferredCheckouts?: Record<string, string>,
  ): Promise<RepositoryInfo[]>;
  /** Resolve the repository whose checkout contains `cwd`. */
  resolveRepository(cwd: string): Promise<RepositoryInfo>;
  /**
   * Clone `cloneUrl` into `<codeRoot>/<repo-name>` (the last path segment of
   * the URL, `.git` stripped) for `launchTask`'s `{ cloneUrl }` repository
   * variant, then resolve and return its {@link RepositoryInfo}. Reused
   * when that directory already exists and is a git checkout whose `origin`
   * remote normalizes to the same identity as `cloneUrl`; rejects if it
   * exists with a different origin (or isn't a git checkout at all).
   */
  cloneRepository(codeRoot: string, cloneUrl: string): Promise<RepositoryInfo>;
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
  /** Whether the worktree at `path` has uncommitted changes (staged, unstaged, or untracked). */
  isWorktreeDirty(path: string): Promise<boolean>;
  branchExists(repo: RepositoryInfo, branch: string): Promise<boolean>;
  /**
   * Branch currently checked out in the worktree at `path`; `undefined` when
   * detached, the path is missing, or it is not a git directory. Never throws.
   */
  currentBranch(path: string): Promise<string | undefined>;
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
