// Engine: pure review-observation math. Ported from pi-home's
// src/engines/awaiting.ts `observePullRequest`, reshaped around
// Harbormaster's `AwaitingKind`/`TaskPullRequest` shapes. Only Dev work and
// Awaiting/review work react; Slack and deploy sources are never overwritten
// by review activity. The github-review mover applies these outcomes; the
// core never moves anything on its own.

import type {
  AwaitingKind,
  TaskPullRequest,
  TaskState,
} from "../contracts/model.js";

export type PullRequestObservationOutcome =
  | "stay"
  | "enter_review"
  | "return_to_dev"
  | "merged";

export function observePullRequest(
  state: TaskState,
  awaiting: AwaitingKind | undefined,
  pr: TaskPullRequest,
): PullRequestObservationOutcome {
  if (state !== "dev" && state !== "awaiting") return "stay";
  const kind = state === "awaiting" ? awaiting?.kind : undefined;
  if (kind === "slack" || kind === "deploy") return "stay";
  if (pr.state === "merged") return "merged";
  // A draft PR is not awaiting anyone: converting to draft returns the task
  // to Dev, even though GitHub retains pending review requests on the PR.
  if (pr.state === "draft") return kind === "review" ? "return_to_dev" : "stay";
  const currentChangesRequest =
    pr.reviewDecision === "CHANGES_REQUESTED" &&
    (pr.changesRequestedOnHead ?? true);
  // A COMMENTED review from a human on the current head is feedback to act
  // on, even though it never changes GitHub's aggregate reviewDecision.
  if (kind === "review") {
    return currentChangesRequest || pr.humanFeedbackOnHead
      ? "return_to_dev"
      : "stay";
  }
  // A changes-requested or commented review is submitted review activity
  // too. Keep Dev work in Dev instead of re-entering Awaiting for the same
  // review; otherwise every observation ping-pongs the task between Dev and
  // Awaiting until a new head invalidates the feedback.
  if (currentChangesRequest || pr.humanFeedbackOnHead) return "stay";
  return pr.reviewRequested || pr.reviewSubmitted ? "enter_review" : "stay";
}
