// Code review chips on a task's sidebar row and board card
// (docs/plannotator.md decisions 1/2): "review open" when a Plannotator
// review opened in the task's workspace without taking focus (cleared once
// the user sees the review tab), else the quiet "Ready to review" hint for
// an idle Dev task with a dirty worktree. Muted: a hint, never a call to
// action.

import type { JSX } from "react";
import { useReadyToReview } from "../lib/review";
import { useTaskUrls } from "../lib/task-urls";
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
  const reviewOpen = useTaskUrls().marked.includes(taskId);
  const ready = useReadyToReview().includes(taskId);
  if (reviewOpen) {
    return (
      <span
        data-testid="review-open-chip"
        title="A review opened in this task's workspace"
        className={cn(chipClassName, MUTED_CHIP)}
      >
        review open
      </span>
    );
  }
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
