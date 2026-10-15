// Engine: pure translation of pi-home's Beads-status / awaiting-context
// vocabulary into Harbormaster's. No I/O — a status string or context
// object in, a Harbormaster shape out. Ported from the mapping table in
// pi-home's `BeadsIssueAccess.normalizeStatus`
// (src/access/beads-issue-access.ts), re-keyed onto Harbormaster's
// `AwaitingKind` ("deploy" instead of "production", decision #16: awaiting
// kinds are data, not verbs).

import type {
  AwaitingKind,
  AwaitingKindId,
  TaskPullRequest,
  TaskState,
} from "../../contracts/model.js";
import { PRODUCTION_STAGE } from "../../engines/deployment.js";
import type {
  PiHomeAwaitingContext,
  PiHomePullRequestMeta,
} from "../contracts.js";

export interface NormalizedBeadsStatus {
  state: TaskState;
  awaitingKind?: AwaitingKindId;
}

const BEADS_STATUS_MAP: Record<string, NormalizedBeadsStatus> = {
  open: { state: "backlog" },
  in_progress: { state: "dev" },
  review: { state: "awaiting", awaitingKind: "review" },
  "review:wip": { state: "awaiting", awaitingKind: "review" },
  awaiting_prod: { state: "awaiting", awaitingKind: "deploy" },
  "awaiting_prod:wip": { state: "awaiting", awaitingKind: "deploy" },
  awaiting_slack: { state: "awaiting", awaitingKind: "slack" },
  "awaiting_slack:wip": { state: "awaiting", awaitingKind: "slack" },
  closed: { state: "done" },
};

/** Throws on a status this tool has never seen, same as pi-home's own reader does. */
export function normalizeBeadsStatus(status: string): NormalizedBeadsStatus {
  const normalized = BEADS_STATUS_MAP[status];
  if (!normalized) throw new Error(`Unsupported Beads status: ${status}`);
  return normalized;
}

/**
 * Builds the `Task.awaiting` record for a task landing in the "awaiting"
 * column: the kind id drives the shape, pi-home's recorded context (slack
 * permalink, deploy stage) fills in the kind-specific details when it
 * agrees with the kind — a stale/mismatched context degrades to the
 * kind-only record (review needs no detail; deploy falls back to the
 * stage-less `__production` wait pi-home used for pipeline-less
 * repositories).
 */
export function mapAwaitingKind(
  kind: AwaitingKindId,
  context: PiHomeAwaitingContext | undefined,
): AwaitingKind {
  if (kind === "review") return { kind: "review" };
  if (kind === "slack") {
    const permalink =
      context?.kind === "slack" && context.url ? context.url : undefined;
    return permalink ? { kind: "slack", permalink } : { kind: "slack" };
  }
  const stage = context?.kind === "production" ? context.stage : undefined;
  return {
    kind: "deploy",
    stageId: stage?.id ?? PRODUCTION_STAGE.id,
    stageLabel: stage?.label ?? PRODUCTION_STAGE.label,
  };
}

/** Ported from `core-manager.ts`'s `toTaskPullRequest`, source-typed for pi-home's uppercase `PullRequestMeta.state`. */
export function mapPullRequest(
  pr: PiHomePullRequestMeta | undefined,
): TaskPullRequest | undefined {
  if (!pr) return undefined;
  const state: TaskPullRequest["state"] =
    pr.state === "MERGED"
      ? "merged"
      : pr.state === "CLOSED"
        ? "closed"
        : pr.isDraft
          ? "draft"
          : "open";
  return {
    number: pr.number,
    url: pr.url,
    state,
    ...(pr.reviewDecision ? { reviewDecision: pr.reviewDecision } : {}),
    ...(pr.changesRequestedOnHead === undefined
      ? {}
      : { changesRequestedOnHead: pr.changesRequestedOnHead }),
    ...(pr.humanFeedbackOnHead === undefined
      ? {}
      : { humanFeedbackOnHead: pr.humanFeedbackOnHead }),
    ...(pr.reviewRequested === undefined
      ? {}
      : { reviewRequested: pr.reviewRequested }),
    ...(pr.reviewSubmitted === undefined
      ? {}
      : { reviewSubmitted: pr.reviewSubmitted }),
    ...(pr.headRefOid ? { headRefOid: pr.headRefOid } : {}),
    ...(pr.mergeCommit?.oid && pr.mergeCommit.targetBranch
      ? {
          mergeCommit: {
            oid: pr.mergeCommit.oid,
            targetBranch: pr.mergeCommit.targetBranch,
          },
        }
      : {}),
  };
}
