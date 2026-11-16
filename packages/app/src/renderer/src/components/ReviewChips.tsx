// Code review hint on a task's sidebar row and board card
// (docs/plannotator.md decision 1): the quiet "Ready to review" hint for an
// idle Dev task with a dirty worktree. Muted: a hint, never a call to
// action. An open review shows only as its tab in the task's workspace
// (no "review open" chip: it outlived closed or never-started reviews).

import type { JSX } from "react";
import { useReadyToReview } from "../lib/review";
import { cn } from "../lib/utils";

const MUTED_CHIP = "border-border bg-muted text-muted-foreground";

export function ReviewChips({
  taskId,
  chipClassName,
}: {
  taskId: string;
  /** The host's chip geometry (row and card differ). */
  chipClassName: string;
}): JSX.Element | null {
  const ready = useReadyToReview().includes(taskId);
  if (!ready) return null;
  return (
    <span
      data-testid="ready-to-review-chip"
      title="The agent is idle with uncommitted changes"
      className={cn(chipClassName, MUTED_CHIP)}
    >
      Ready to review
    </span>
  );
}
