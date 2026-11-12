// GitHub Resource Access boundary — ported from pi-home's
// src/access/github-pr-access.ts + src/contracts/services.ts
// (PullRequestAccess/VersionAccess). Reshaped around Harbormaster's
// normalized repository id ("github.com/org/repo", see
// git-repository-access.ts) instead of pi-home's RepositoryRef, so the
// GitHub access layer never needs a full repository lookup — Managers pass
// the id straight through. Managers and Engines only ever see these
// interfaces; the gh-CLI-shelling-out implementation lives in access/.

/** One commit reachable from a fixed starting commit. */
export interface CommitLogEntry {
  oid: string;
  subject: string;
}

/** GitHub's live view of one pull request, as refreshed into `Task.pr`. */
export interface PullRequestStatus {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
  /** Whether an outstanding changes-requested review targets the current PR head. */
  changesRequestedOnHead?: boolean;
  /** Whether a human reviewer submitted feedback (COMMENTED or CHANGES_REQUESTED) on the current PR head. */
  humanFeedbackOnHead?: boolean;
  reviewRequested: boolean;
  reviewSubmitted: boolean;
  headRefOid?: string;
  /** `targetBranch` is absent when GitHub did not report the PR's base branch. */
  mergeCommit?: { oid: string; targetBranch?: string; url: string };
  checkedAt: string;
  // Rules-engine facts (the `github` source); absent when the backend did
  // not report them.
  /** The PR's head branch. */
  headRefName?: string;
  mergedAt?: string;
  /** GitHub's `closed`: true for closed *and* merged PRs. */
  closed?: boolean;
  /** PR author login. */
  author?: string;
  /** Whether the authenticated `gh` user opened the PR. */
  viewerIsAuthor?: boolean;
  /** Head commit's check rollup, lowercased (`success`, `failure`, `pending`, `error`, `expected`), `none` when there are no checks. */
  checks?: string;
  /** Review threads not yet resolved. */
  unresolvedThreads?: number;
  /** Latest author activity: head commit, author comments/reviews (ISO). */
  lastAuthorActivityAt?: string;
  /** Latest human non-author review or comment (ISO). */
  lastReviewerActivityAt?: string;
  /** The PR's title. Reported by `view` only (not by the refresh lookups). */
  title?: string;
  /** The PR's base branch. Reported by `view` only (not by the refresh lookups). */
  baseRefName?: string;
}

/**
 * What the new-task composer shows for a pasted PR URL before the task is
 * created (`CoreCommands.previewPullRequest`): enough for a one-line card
 * and the role default. `viewerIsAuthor` drives Author vs Reviewer.
 */
export interface PullRequestPreview {
  /** Normalized `host/owner/repo`, a repository core knows locally. */
  repositoryId: string;
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  title?: string;
  author?: string;
  /** The branch a PR-bound task checks out. */
  headRefName?: string;
  /** The PR's base branch (the repository's default branch when GitHub did not say). */
  baseRefName: string;
  viewerIsAuthor?: boolean;
}

/** One open PR found by a GitHub search (`searchPullRequests`). */
export interface PullRequestSearchHit {
  /** Normalized `host/owner/repo`. */
  repository: string;
  number: number;
  url: string;
  title: string;
  author?: string;
  updatedAt?: string;
}

/**
 * Resource Access: GitHub pull-request status and ancestry, via the `gh`
 * CLI. All GitHub process invocations stay behind this interface — Managers
 * and Engines never shell out to `gh` directly.
 */
export interface PullRequestAccess {
  /** The PR (open or closed/merged) whose head is `branch`, if any. */
  status(
    repositoryId: string,
    branch: string,
  ): Promise<PullRequestStatus | undefined>;
  /**
   * {@link status} for many branches of one repository in as few round
   * trips as the backend allows (the refresh tick observes every live task
   * at once). Same per-branch answer as `status`; rejects as a whole.
   * Optional: without it the refresh falls back to one `status` per task.
   */
  statusMany?(
    repositoryId: string,
    branches: readonly string[],
  ): Promise<Map<string, PullRequestStatus | undefined>>;
  /**
   * Reuse an existing PR for `branch` (marking a draft ready), or push the
   * branch and open a fresh one targeting `baseBranch` otherwise.
   */
  ensureOpen(
    repositoryId: string,
    branch: string,
    worktreePath: string,
    title: string,
    body: string,
    baseBranch: string,
  ): Promise<PullRequestStatus>;
  /**
   * Squash-merge PR `pullRequestNumber` (`gh pr merge <n> --squash`) and
   * return its post-merge status; rejects unless GitHub then reports it
   * MERGED. Ported from pi-home's `squashMerge`.
   */
  squashMerge(
    repositoryId: string,
    pullRequestNumber: number,
    branch: string,
  ): Promise<PullRequestStatus>;
  /** Whether `ancestorOid` is contained in `descendantOid` on GitHub (memoized: ancestry is immutable). */
  containsCommit(
    repositoryId: string,
    ancestorOid: string,
    descendantOid: string,
  ): Promise<boolean>;
  /** Newest-first commits reachable from `startOid` (memoized; limit capped at 100). */
  commitLog(
    repositoryId: string,
    startOid: string,
    limit: number,
  ): Promise<CommitLogEntry[]>;
  /**
   * One PR by number (any state), with `headRefName` and
   * `viewerIsAuthor`: what a reviewer task needs to check out the PR head.
   * Optional: without it reviewer tasks cannot be created from a PR.
   */
  view?(
    repositoryId: string,
    pullRequestNumber: number,
  ): Promise<PullRequestStatus>;
  /** Open PRs matching a GitHub search query (e.g. `review-requested:@me`); optional. */
  searchPullRequests?(query: string): Promise<PullRequestSearchHit[]>;
}

/**
 * Resource Access: fetches small text documents over HTTPS (deployment
 * version endpoints). Ported from pi-home's VersionAccess.
 */
export interface VersionAccess {
  fetchText(url: string): Promise<string>;
}
