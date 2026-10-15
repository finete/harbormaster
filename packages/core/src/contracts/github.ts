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
}

/**
 * Resource Access: fetches small text documents over HTTPS (deployment
 * version endpoints). Ported from pi-home's VersionAccess.
 */
export interface VersionAccess {
  fetchText(url: string): Promise<string>;
}
