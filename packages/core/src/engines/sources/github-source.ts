// Built-in source `github`: per task PR facts (subject `task/<id>`, entity
// `pr` → `github.pr.*` events), read from the PR status the refresh tick
// already observed (one batched GraphQL call per repository, see
// GithubPrAccess.statusMany), so the source adds no GitHub round trips of
// its own. Opt-in unbound facts (settings `watchReviewRequests`,
// `watchMentions`): open PRs requesting the viewer's review / mentioning
// the viewer (entities `reviewRequest` / `mention`), searched at most every
// `searchIntervalMs`. Auth is `gh`'s.

import type {
  SearchedPullRequest,
  Snapshot,
  Source,
  SourceContext,
  SourcePullRequestFacts,
} from "../../contracts/rules.js";
import { taskSubject } from "../rules/snapshot-diff.js";

export const GITHUB_SOURCE_ID = "github";

const DEFAULT_SEARCH_INTERVAL_MS = 5 * 60_000;

const UNBOUND_ENTITIES = {
  reviewRequest: "is:pr is:open review-requested:@me",
  mention: "is:pr is:open mentions:@me",
} as const;

export const githubSource: Source = {
  id: GITHUB_SOURCE_ID,
  interval: 0,
  settingsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      watchReviewRequests: {
        type: "boolean",
        description:
          "Emit github.reviewRequest.* for open PRs requesting your review.",
      },
      watchMentions: {
        type: "boolean",
        description: "Emit github.mention.* for open PRs that mention you.",
      },
      searchIntervalMs: {
        type: "integer",
        minimum: 60000,
        description: "Minimum time between review-request/mention searches.",
      },
    },
  },
  async snapshot(ctx) {
    const snapshots: Snapshot[] = [];
    const previousSubjects = new Set(
      ctx.previous.map((entry) => entry.subject),
    );
    for (const task of ctx.tasks) {
      const subject = taskSubject(task.id);
      const observed = ctx.services.github.observed(task.id);
      if (!observed) {
        // Not observed this tick (lookup failed, done task, ...): a known
        // subject keeps its facts; nothing new appears.
        if (previousSubjects.has(subject) && task.state !== "done") {
          snapshots.push({ subject, entity: "pr", facts: {}, stale: true });
        }
        continue;
      }
      if (!observed.status) continue;
      snapshots.push({
        subject,
        entity: "pr",
        facts: pullRequestFacts(observed.status),
      });
    }
    snapshots.push(...(await unboundSnapshots(ctx)));
    return snapshots;
  },
};

/** The diffable facts of one PR (absent values are `null`, never missing). */
export function pullRequestFacts(
  status: SourcePullRequestFacts,
): Record<string, unknown> {
  const state =
    status.state === "MERGED"
      ? "merged"
      : status.state === "CLOSED"
        ? "closed"
        : status.isDraft
          ? "draft"
          : "open";
  return {
    number: status.number,
    url: status.url,
    state,
    reviewDecision: status.reviewDecision
      ? status.reviewDecision.toLowerCase()
      : null,
    changesRequestedOnHead: status.changesRequestedOnHead ?? null,
    humanFeedbackOnHead: status.humanFeedbackOnHead ?? null,
    reviewRequested: status.reviewRequested,
    reviewSubmitted: status.reviewSubmitted,
    headSha: status.headRefOid ?? null,
    merged: status.state === "MERGED",
    mergedAt: status.mergedAt ?? null,
    mergeCommit: status.mergeCommit?.oid ?? null,
    closed: status.closed ?? status.state !== "OPEN",
    isDraft: status.isDraft,
    checks: status.checks ?? null,
    unresolvedThreads: status.unresolvedThreads ?? null,
    lastAuthorActivityAt: status.lastAuthorActivityAt ?? null,
    lastReviewerActivityAt: status.lastReviewerActivityAt ?? null,
    author: status.author ?? null,
    viewerIsAuthor: status.viewerIsAuthor ?? null,
  };
}

interface GithubCursor {
  lastSearchAt?: string;
}

async function unboundSnapshots(ctx: SourceContext): Promise<Snapshot[]> {
  const wanted = (
    Object.keys(UNBOUND_ENTITIES) as Array<keyof typeof UNBOUND_ENTITIES>
  ).filter((entity) =>
    entity === "reviewRequest"
      ? ctx.settings.watchReviewRequests === true
      : ctx.settings.watchMentions === true,
  );
  const search = ctx.services.github.searchPullRequests;
  if (wanted.length === 0 || !search) return [];
  const cursor = (ctx.cursor ?? {}) as GithubCursor;
  const interval =
    typeof ctx.settings.searchIntervalMs === "number"
      ? ctx.settings.searchIntervalMs
      : DEFAULT_SEARCH_INTERVAL_MS;
  const now = ctx.now();
  const due =
    !cursor.lastSearchAt ||
    now.getTime() - Date.parse(cursor.lastSearchAt) >= interval;
  const keep = (entity: string): Snapshot[] =>
    ctx.previous
      .filter((entry) => entry.entity === entity)
      .map((entry) => ({ ...entry, stale: true }));
  if (!due) return wanted.flatMap(keep);

  const snapshots: Snapshot[] = [];
  let searched = false;
  for (const entity of wanted) {
    try {
      const hits = await search(UNBOUND_ENTITIES[entity]);
      searched = true;
      for (const hit of hits) {
        snapshots.push({
          subject: `github/${entity}/${hit.repository}#${hit.number}`,
          entity,
          facts: searchFacts(hit),
        });
      }
    } catch (error) {
      ctx.warn(
        `GitHub ${entity === "reviewRequest" ? "review-request" : "mention"} search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      snapshots.push(...keep(entity));
    }
  }
  if (searched) ctx.setCursor({ lastSearchAt: now.toISOString() });
  return snapshots;
}

function searchFacts(hit: SearchedPullRequest): Record<string, unknown> {
  return {
    repository: hit.repository,
    number: hit.number,
    url: hit.url,
    title: hit.title,
    author: hit.author ?? null,
  };
}
