// Timed spans around the git / GitHub verbs that change things (worktree
// create/remove, branch delete/push, PR create/merge): one completion line
// per call with `ms` and `ok|failed`, whichever caller made it. Wired once
// in `createCore`; the wrapped access behaves exactly as before (results
// and errors pass through). Only ids, branch names and paths are logged:
// never a PR title/body.

import type { PullRequestAccess } from "../contracts/github.js";
import type { CoreLogger } from "../contracts/logger.js";
import type {
  DefaultBaseResolution,
  GitWorktreeAccess,
  RepositoryInfo,
  WorktreeInfo,
} from "../contracts/workspace.js";
import { withTimedMethods } from "../utilities/timed.js";

const repoId = (repo: RepositoryInfo | undefined) => repo?.id;

export function timedWorktreeAccess(
  worktrees: GitWorktreeAccess,
  logger: CoreLogger,
): GitWorktreeAccess {
  return withTimedMethods(worktrees, logger, {
    createTaskWorktree: {
      scope: "git",
      op: "worktree.create",
      fields: (repo: RepositoryInfo, branch: string) => ({
        repositoryId: repoId(repo),
        branch,
      }),
      result: (worktree: WorktreeInfo | undefined) => ({
        worktreePath: worktree?.path,
      }),
    },
    resolveDefaultBase: {
      scope: "git",
      op: "worktree.resolve-base",
      fields: (repo: RepositoryInfo) => ({ repositoryId: repoId(repo) }),
      result: (base: DefaultBaseResolution | undefined) => ({
        base: base?.ref,
        baseReason: base?.reason,
      }),
    },
    checkoutPullRequest: {
      scope: "git",
      op: "worktree.checkout-pr",
      fields: (repo: RepositoryInfo, branch: string) => ({
        repositoryId: repoId(repo),
        branch,
      }),
      result: (checkout: { worktree?: WorktreeInfo } | undefined) => ({
        worktreePath: checkout?.worktree?.path,
      }),
    },
    removeWorktree: {
      scope: "git",
      op: "worktree.remove",
      fields: (repo: RepositoryInfo, path: string) => ({
        repositoryId: repoId(repo),
        worktreePath: path,
      }),
    },
    deleteBranch: {
      scope: "git",
      op: "branch.delete",
      fields: (repo: RepositoryInfo, branch: string) => ({
        repositoryId: repoId(repo),
        branch,
      }),
    },
    pushBranch: {
      scope: "git",
      op: "branch.push",
      fields: (path: string, branch: string) => ({
        worktreePath: path,
        branch,
      }),
    },
  });
}

export function timedPullRequestAccess(
  pullRequests: PullRequestAccess,
  logger: CoreLogger,
): PullRequestAccess {
  return withTimedMethods(pullRequests, logger, {
    ensureOpen: {
      scope: "github",
      op: "pr.ensure-open",
      // (repositoryId, branch, worktreePath, title, body, baseBranch): the
      // title and body are never logged.
      fields: (repositoryId: string, branch: string, worktreePath: string) => ({
        repositoryId,
        branch,
        worktreePath,
      }),
    },
    squashMerge: {
      scope: "github",
      op: "pr.squash-merge",
      fields: (repositoryId: string, _number: number, branch: string) => ({
        repositoryId,
        branch,
      }),
    },
  });
}
