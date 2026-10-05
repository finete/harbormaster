// Shared PR-badge presentation logic (TaskCard, Sidebar): state-based color
// plus a "changes requested"/"approved" callout once `refresh()` has
// populated `task.pr.reviewDecision` (see /packages/core/src/contracts
// /model.ts's `TaskPullRequest`).
import type { Task } from "../../../preload/api";

type PrState = NonNullable<Task["pr"]>["state"];

const STATE_VARIANT: Record<
  PrState,
  "success" | "draft" | "merged" | "closed"
> = {
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

/** Red "closed" styling for changes-requested, state color otherwise. */
export function prBadgeVariant(
  pr: NonNullable<Task["pr"]>,
): "success" | "draft" | "merged" | "closed" {
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "closed";
  return STATE_VARIANT[pr.state];
}

export function prBadgeLabel(pr: NonNullable<Task["pr"]>): string {
  const base = `PR #${pr.number} \u00b7 ${pr.state}`;
  if (!pr.reviewDecision) return base;
  return `${base} \u00b7 ${REVIEW_DECISION_LABEL[pr.reviewDecision]}`;
}
