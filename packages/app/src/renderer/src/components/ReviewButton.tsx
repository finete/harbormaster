// The Review split button (docs/plannotator.md decision 4), beside Await… ·
// Done: the main half starts a Plannotator review of the default target
// (the task's PR when it has one, else local changes); the chevron picks
// Local changes / Pull request #N. It opens (or focuses) the task's review
// tab and asks main to start the review (`startReview`: typed into the
// agent's terminal when it is at its prompt, else queued until its turn
// ends; docs/plannotator.md "Transport"); the session's URL then navigates
// the tab. Disabled, with the reason as its tooltip, when the harness has
// no review command or Plannotator is not ready for it.

import {
  ChevronDown,
  GitPullRequest,
  Loader2,
  MessageSquareCode,
} from "lucide-react";
import type { JSX } from "react";
import { useState } from "react";
import type { Task } from "../../../preload/api";
import {
  defaultReviewTarget,
  type ReviewTargetKind,
  reviewDisabledReason,
  startReview,
  taskHarness,
  useReviewSupport,
} from "../lib/review";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  SplitButton,
  SplitButtonMain,
  SplitButtonTrigger,
} from "./ui/split-button";

export function ReviewButton({ task }: { task: Task }): JSX.Element {
  const support = useReviewSupport();
  const [busy, setBusy] = useState(false);
  const harness = taskHarness(task);
  const disabledReason = reviewDisabledReason({ support, harness });
  const disabled = disabledReason !== undefined || busy;
  const target = defaultReviewTarget(task);
  const prNumber = task.pr?.number;

  async function review(kind: ReviewTargetKind): Promise<void> {
    if (disabled) return;
    setBusy(true);
    try {
      // Decision 2: creates or focuses the review tab right away.
      await startReview(task.id, { target: kind, harness });
    } finally {
      setBusy(false);
    }
  }

  const prLabel = prNumber ? `Pull request #${prNumber}` : "Pull request";
  return (
    <SplitButton
      variant="secondary"
      size="sm"
      data-testid={`review-button-${task.id}`}
      title={disabledReason}
    >
      <SplitButtonMain
        disabled={disabled}
        data-testid={`review-button-main-${task.id}`}
        data-target={target}
        onClick={(event) => {
          event.stopPropagation();
          void review(target);
        }}
        title={
          disabledReason ??
          (target === "pr" ? `Review ${prLabel}` : "Review local changes")
        }
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <MessageSquareCode className="h-3.5 w-3.5" />
        )}
        Review
      </SplitButtonMain>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <SplitButtonTrigger
            aria-label="Review…"
            title={disabledReason ?? "Review…"}
            data-testid={`review-button-menu-trigger-${task.id}`}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </SplitButtonTrigger>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-[12rem]"
          data-testid={`review-button-menu-${task.id}`}
        >
          <DropdownMenuItem
            data-testid="review-target-local"
            onSelect={() => void review("local")}
          >
            <MessageSquareCode />
            <span className="flex-1">Local changes</span>
          </DropdownMenuItem>
          {task.pr?.url && (
            <DropdownMenuItem
              data-testid="review-target-pr"
              onSelect={() => void review("pr")}
            >
              <GitPullRequest />
              <span className="flex-1">{prLabel}</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </SplitButton>
  );
}
