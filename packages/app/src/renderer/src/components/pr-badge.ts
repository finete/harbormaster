// Shared PR-badge presentation logic (TaskCard, Sidebar): state-based color
// plus a "changes requested"/"approved" callout once `refresh()` has
// populated `task.pr.reviewDecision` (see /packages/core/src/contracts
// /model.ts's `TaskPullRequest`). "Changes requested" gets its own amber
// variant rather than reusing the closed-red: an *open* PR that happens to
// have changes requested must not look like a closed one (the sidebar chip
// shows only the number, so a shared red reads as "closed").
import type { Task } from "../../../preload/api";

type PrState = NonNullable<Task["pr"]>["state"];

export type PrBadgeVariant =
  | "success"
  | "draft"
  | "merged"
  | "closed"
  | "changes";

const STATE_VARIANT: Record<PrState, PrBadgeVariant> = {
  open: "success",
  draft: "draft",
  merged: "merged",
  closed: "closed",
};

const REVIEW_DECISION_LABEL: Record<
  NonNullable<NonNullable<Task["pr"]>["reviewDecision"]>,
  string
> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  REVIEW_REQUIRED: "review required",
};

/**
 * Amber "changes" styling for changes-requested (distinct from closed-red so
 * an open PR never looks closed), PR-state color otherwise. Closed/merged
 * take precedence over a lingering review decision: a closed PR is closed
 * regardless of any retained CHANGES_REQUESTED aggregate.
 */
export function prBadgeVariant(pr: NonNullable<Task["pr"]>): PrBadgeVariant {
  if (
    pr.reviewDecision === "CHANGES_REQUESTED" &&
    (pr.state === "open" || pr.state === "draft")
  ) {
    return "changes";
  }
  return STATE_VARIANT[pr.state];
}

/** "PR #12 · open[ · reviewing][ · approved]": a reviewer task (someone else's PR) says so. */
export function prBadgeLabel(pr: NonNullable<Task["pr"]>): string {
  const role = pr.role === "reviewer" ? " \u00b7 reviewing" : "";
  const base = `PR #${pr.number} \u00b7 ${pr.state}${role}`;
  if (!pr.reviewDecision) return base;
  return `${base} \u00b7 ${REVIEW_DECISION_LABEL[pr.reviewDecision]}`;
}
