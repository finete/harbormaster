// Resource Access: gh-CLI-shelling-out implementation of PullRequestAccess.
// Ported from pi-home's src/access/github-pr-access.ts, reshaped around
// Harbormaster's normalized repository id ("github.com/org/repo") instead of
// a RepositoryRef with a raw remote URL — `apiPath`/`--repo` both derive
// straight from the id, so this access service needs no repository lookup of
// its own. Execute is injectable so tests fake `gh`/`git` without touching a
// network or a real remote.

import type {
  CommitLogEntry,
  PullRequestAccess,
  PullRequestStatus,
} from "../contracts/github.js";
import { run } from "../utilities/run.js";

interface GhReview {
  state?: string;
  commit?: { oid?: string } | null;
  author?: { login?: string } | null;
  authorAssociation?: string;
}
interface GhPr {
  number: number;
  url: string;
  author?: { login?: string } | null;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft?: boolean;
  reviewDecision?: PullRequestStatus["reviewDecision"];
  reviewRequests?: unknown[];
  reviews?: GhReview[];
  headRefOid?: string;
  mergeCommit?: { oid?: string } | null;
  baseRefName?: string;
}

export type Execute = (
  command: string,
  args: string[],
  cwd?: string,
) => Promise<string>;

/** Overrides the `gh` binary (and only `gh`) for e2e: a tiny fake CLI stands in for a real GitHub login. Mirrors `HARBORMASTER_PI_COMMAND` (see `harness/pi-adapter.ts`). */
const GH_COMMAND_ENV = "HARBORMASTER_GH_COMMAND";

/** `gh`-CLI-shelling-out implementation of {@link PullRequestAccess}. */
export class GithubPrAccess implements PullRequestAccess {
  /** Ancestry between two fixed commits never changes, so results memoize forever. */
  private readonly ancestry = new Map<string, boolean>();
  /** History reachable from a fixed commit is immutable; memoized forever too. */
  private readonly commitLogs = new Map<string, CommitLogEntry[]>();

  constructor(
    private readonly execute: Execute = (command, args, cwd) =>
      run(
        command === "gh" ? process.env[GH_COMMAND_ENV] || "gh" : command,
        args,
        cwd,
      ),
  ) {}

  async containsCommit(
    repositoryId: string,
    ancestorOid: string,
    descendantOid: string,
  ): Promise<boolean> {
    if (
      !/^[0-9a-f]{7,40}$/i.test(ancestorOid) ||
      !/^[0-9a-f]{7,40}$/i.test(descendantOid)
    ) {
      throw new Error("Commit comparison requires hexadecimal OIDs");
    }
    const key = `${repositoryId}:${ancestorOid.toLowerCase()}:${descendantOid.toLowerCase()}`;
    const cached = this.ancestry.get(key);
    if (cached !== undefined) return cached;
    // status describes head relative to base: base...head being "ahead" or
    // "identical" means the ancestor commit is contained in the descendant.
    const output = await this.execute("gh", [
      "api",
      `repos/${this.apiPath(repositoryId)}/compare/${ancestorOid}...${descendantOid}`,
      "--jq",
      ".status",
      ...this.hostnameArgs(repositoryId),
    ]);
    const status = output.trim();
    if (!["ahead", "behind", "identical", "diverged"].includes(status)) {
      throw new Error(
        `Unexpected GitHub compare status: ${status || "(empty)"}`,
      );
    }
    const contained = status === "ahead" || status === "identical";
    this.ancestry.set(key, contained);
    return contained;
  }

  async commitLog(
    repositoryId: string,
    startOid: string,
    limit: number,
  ): Promise<CommitLogEntry[]> {
    if (!/^[0-9a-f]{7,40}$/i.test(startOid)) {
      throw new Error("Commit log requires a hexadecimal OID");
    }
    const capped = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const key = `${repositoryId}:${startOid.toLowerCase()}:${capped}`;
    const cached = this.commitLogs.get(key);
    if (cached) return cached;
    const output = await this.execute("gh", [
      "api",
      `repos/${this.apiPath(repositoryId)}/commits?sha=${startOid}&per_page=${capped}`,
      "--jq",
      '[.[] | {oid: .sha, subject: (.commit.message | split("\n")[0])}]',
      ...this.hostnameArgs(repositoryId),
    ]);
    const parsed: unknown = JSON.parse(output);
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (entry) =>
          !entry ||
          typeof entry.oid !== "string" ||
          typeof entry.subject !== "string",
      )
    ) {
      throw new Error("Unexpected GitHub commit log payload");
    }
    const entries = parsed as CommitLogEntry[];
    this.commitLogs.set(key, entries);
    return entries;
  }

  async status(
    repositoryId: string,
    branch: string,
  ): Promise<PullRequestStatus | undefined> {
    return this.find(repositoryId, branch, "all");
  }

  async ensureOpen(
    repositoryId: string,
    branch: string,
    worktreePath: string,
    title: string,
    body: string,
    baseBranch: string,
  ): Promise<PullRequestStatus> {
    const existing = await this.find(repositoryId, branch, "open");
    if (existing) return this.markReady(repositoryId, branch, existing);

    await this.execute(
      "git",
      ["push", "--set-upstream", "origin", branch],
      worktreePath,
    );
    const createOutput = await this.execute(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        this.ghRepo(repositoryId),
        "--base",
        baseBranch,
        "--head",
        branch,
        "--title",
        title,
        "--body",
        body,
      ],
      worktreePath,
    );
    const created = await this.find(repositoryId, branch, "open");
    if (created) return this.markReady(repositoryId, branch, created);

    // GitHub's list endpoint can briefly lag behind a successful creation. gh
    // prints the canonical PR URL, so use it rather than failing the transition.
    const url = createOutput
      .trim()
      .split(/\s+/)
      .find((part) => /^https?:\/\//.test(part));
    const number = url?.match(/\/pull\/(\d+)\/?$/)?.[1];
    if (!url || !number) {
      throw new Error("Pull request was created but could not be found");
    }
    return {
      number: Number(number),
      url,
      state: "OPEN",
      isDraft: false,
      reviewRequested: false,
      reviewSubmitted: false,
      checkedAt: new Date().toISOString(),
    };
  }

  private async markReady(
    repositoryId: string,
    branch: string,
    pullRequest: PullRequestStatus,
  ): Promise<PullRequestStatus> {
    if (!pullRequest.isDraft) return pullRequest;
    await this.execute("gh", [
      "pr",
      "ready",
      String(pullRequest.number),
      "--repo",
      this.ghRepo(repositoryId),
    ]);
    const refreshed = await this.find(repositoryId, branch, "open");
    return {
      ...(refreshed ?? pullRequest),
      isDraft: false,
      checkedAt: new Date().toISOString(),
    };
  }

  private async find(
    repositoryId: string,
    branch: string,
    state: "all" | "open",
  ): Promise<PullRequestStatus | undefined> {
    const output = await this.execute("gh", [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      state,
      "--limit",
      "1",
      "--repo",
      this.ghRepo(repositoryId),
      "--json",
      "number,url,state,isDraft,author,reviewDecision,reviewRequests,reviews,headRefOid,mergeCommit,baseRefName",
    ]);
    const parsed: unknown = JSON.parse(output);
    const pr = (parsed as GhPr[])[0];
    if (!pr) return undefined;
    const changesRequestedOnHead = currentHeadChangesRequested(pr);
    const humanFeedbackOnHead = currentHeadHumanFeedback(pr);
    return {
      number: pr.number,
      url: pr.url,
      state: pr.state,
      isDraft: Boolean(pr.isDraft),
      ...(pr.reviewDecision ? { reviewDecision: pr.reviewDecision } : {}),
      ...(changesRequestedOnHead === undefined
        ? {}
        : { changesRequestedOnHead }),
      ...(humanFeedbackOnHead === undefined ? {} : { humanFeedbackOnHead }),
      reviewRequested: (pr.reviewRequests?.length ?? 0) > 0,
      reviewSubmitted: (pr.reviews?.length ?? 0) > 0,
      ...(pr.headRefOid ? { headRefOid: pr.headRefOid } : {}),
      ...(pr.state === "MERGED" && pr.mergeCommit?.oid
        ? {
            mergeCommit: {
              oid: pr.mergeCommit.oid,
              // Absent base: the manager falls back to the repository's
              // default branch (it owns the repository lookup).
              ...(pr.baseRefName ? { targetBranch: pr.baseRefName } : {}),
              url: this.commitUrl(repositoryId, pr.url, pr.mergeCommit.oid),
            },
          }
        : {}),
      checkedAt: new Date().toISOString(),
    };
  }

  /** Derive the squash-commit URL from the canonical PR URL, falling back to the normalized repository id. */
  private commitUrl(
    repositoryId: string,
    pullRequestUrl: string,
    oid: string,
  ): string {
    const base = pullRequestUrl.replace(/\/pull\/\d+\/?$/, "");
    if (base !== pullRequestUrl && /^https?:\/\//.test(base)) {
      return `${base}/commit/${oid}`;
    }
    return `https://${repositoryId}/commit/${oid}`;
  }

  /** `owner/repo`, derived from a normalized `host/owner/repo` repository id. */
  private apiPath(repositoryId: string): string {
    return this.repoParts(repositoryId).path;
  }

  /**
   * gh's `[HOST/]OWNER/REPO` form with the host kept, so GitHub Enterprise
   * repositories are never silently resolved against github.com.
   */
  private ghRepo(repositoryId: string): string {
    const { host, path } = this.repoParts(repositoryId);
    return host ? `${host}/${path}` : path;
  }

  /** `gh api` takes the host as a flag; github.com is gh's own default. */
  private hostnameArgs(repositoryId: string): string[] {
    const { host } = this.repoParts(repositoryId);
    return !host || host === "github.com" ? [] : ["--hostname", host];
  }

  private repoParts(repositoryId: string): { host: string; path: string } {
    const parts = repositoryId.split("/");
    // A local-path remote (fixtures) yields an empty host: no host flag.
    if (parts.length < 3 || !parts[1] || !parts[2]) {
      throw new Error(
        `Cannot derive owner/repo from repository id: ${repositoryId}`,
      );
    }
    return { host: parts[0] ?? "", path: parts.slice(1).join("/") };
  }
}

/**
 * GitHub can retain an aggregate CHANGES_REQUESTED decision after the author
 * pushes a replacement head. Distinguish that stale review from feedback on
 * the current head; return undefined when the CLI payload cannot prove either.
 */
function currentHeadChangesRequested(pr: GhPr): boolean | undefined {
  if (pr.reviewDecision !== "CHANGES_REQUESTED") return false;
  if (!pr.headRefOid) return undefined;
  const reviews = (pr.reviews ?? []).filter(
    (review) => review.state === "CHANGES_REQUESTED",
  );
  if (!reviews.length) return undefined;
  if (reviews.some((review) => review.commit?.oid === pr.headRefOid)) {
    return true;
  }
  return reviews.every((review) => Boolean(review.commit?.oid))
    ? false
    : undefined;
}

/**
 * Whether a human reviewer submitted feedback (a COMMENTED or
 * CHANGES_REQUESTED review) on the current PR head. Bot/app reviews and the
 * PR author's own COMMENTED reviews are excluded. Returns undefined when the
 * CLI payload cannot prove either way.
 */
function currentHeadHumanFeedback(pr: GhPr): boolean | undefined {
  if (!pr.headRefOid) return undefined;
  const feedback = (pr.reviews ?? []).filter(
    (review) =>
      (review.state === "COMMENTED" || review.state === "CHANGES_REQUESTED") &&
      !isBotReview(review) &&
      !isAuthorReview(pr, review),
  );
  if (!feedback.length) return false;
  if (feedback.some((review) => review.commit?.oid === pr.headRefOid)) {
    return true;
  }
  return feedback.every((review) => Boolean(review.commit?.oid))
    ? false
    : undefined;
}

/** A review submitted by the PR author (e.g. replying to review comments). */
function isAuthorReview(pr: GhPr, review: GhReview): boolean {
  const authorLogin = pr.author?.login;
  return Boolean(authorLogin) && review.author?.login === authorLogin;
}

/** GitHub Apps review with authorAssociation NONE; classic bot accounts end in "[bot]". */
function isBotReview(review: GhReview): boolean {
  if (review.authorAssociation === "NONE") return true;
  const login = review.author?.login ?? "";
  return login.endsWith("[bot]");
}
