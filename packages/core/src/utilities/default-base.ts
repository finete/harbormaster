// Utility: pure choice of the commit a new task worktree starts from when the
// task's base is the repository's default branch. The git I/O that gathers
// these facts lives in `LocalGitWorktreeAccess.resolveDefaultBase`.

/** How `git fetch origin <default>` ended. */
export type DefaultBaseFetch =
  /** The repository has no `origin` remote: nothing to fetch. */
  "no-origin" | "ok" | "failed" | "timed-out";

/** How the local default branch relates to `origin/<default>` (both exist). */
export type DefaultBaseRelation = "equal" | "behind" | "ahead" | "diverged";

export interface DefaultBaseFacts {
  fetch: DefaultBaseFetch;
  /** The local `<default>` branch's commit, when the branch exists. */
  localSha?: string | undefined;
  /** The remote-tracking `origin/<default>` commit, when it exists (cached or fresh). */
  originSha?: string | undefined;
  /** Only meaningful when both shas exist and the fetch succeeded. */
  relation?: DefaultBaseRelation | undefined;
}

export type DefaultBaseChoice =
  | { source: "origin"; reason: string }
  | { source: "local"; reason: string }
  /** Neither branch exists: the caller falls back to the plain branch name (git reports the error, as before). */
  | { source: "none"; reason: string };

/**
 * Newest of local `<default>` and `origin/<default>`, never skipping local
 * commits origin lacks and never failing because the fetch did not work:
 *
 * - fetched, local strictly behind origin → origin;
 * - fetched, local equal / ahead / diverged → local (unpushed work kept);
 * - no origin remote, fetch failed or timed out → local if there is one,
 *   else the cached `origin/<default>`;
 * - fetched, local branch missing → origin; origin branch missing → local.
 *
 * `reason` is a short, log-ready explanation.
 */
export function chooseDefaultBase(facts: DefaultBaseFacts): DefaultBaseChoice {
  const { fetch, localSha, originSha, relation } = facts;
  const fetchNote = fetch === "ok" ? "fetch ok" : fetchNoteFor(fetch);
  if (fetch !== "ok") {
    if (localSha)
      return { source: "local", reason: `${fetchNote}; using local` };
    if (originSha) {
      return {
        source: "origin",
        reason: `${fetchNote}; no local branch, using cached origin`,
      };
    }
    return { source: "none", reason: `${fetchNote}; no branch found` };
  }
  if (!localSha && !originSha) {
    return { source: "none", reason: `${fetchNote}; no branch found` };
  }
  if (!localSha) {
    return {
      source: "origin",
      reason: `no-local-branch; ${fetchNote}`,
    };
  }
  if (!originSha) {
    return { source: "local", reason: `no-origin-branch; ${fetchNote}` };
  }
  switch (relation) {
    case "behind":
      return { source: "origin", reason: `local-behind-origin; ${fetchNote}` };
    case "equal":
      return { source: "local", reason: `local-equals-origin; ${fetchNote}` };
    case "ahead":
      return { source: "local", reason: `local-ahead-of-origin; ${fetchNote}` };
    case "diverged":
      return { source: "local", reason: `local-diverged; ${fetchNote}` };
    default:
      // Relation unknown (a git error while comparing): today's behavior.
      return { source: "local", reason: `relation-unknown; ${fetchNote}` };
  }
}

function fetchNoteFor(fetch: Exclude<DefaultBaseFetch, "ok">): string {
  switch (fetch) {
    case "no-origin":
      return "no origin remote";
    case "failed":
      return "fetch failed";
    case "timed-out":
      return "fetch timed out";
  }
}
