// The Review split button (docs/plannotator.md decision 4), beside Await… ·
// Done: the main half starts a Plannotator review of the default target
// (the task's PR when it has one, else local changes); the chevron picks
// Local changes / Pull request #N. It asks core to deliver the harness's
// review command to the session and opens (or focuses) the task's review
// tab, which the session's URL then navigates. Disabled, with the reason as
// its tooltip, when the harness has no review command, Plannotator is not
// ready for it, or the agent is mid-turn.

import {
  ChevronDown,
  GitPullRequest,
  Loader2,
  MessageSquareCode,
} from "lucide-react";
import type { JSX } from "react";
import { useState } from "react";
import type { Task } from "../../../preload/api";
import { usePresenceMap } from "../core-client";
import {
  defaultReviewTarget,
  type ReviewTargetKind,
  reviewDisabledReason,
  taskHarness,
  useReviewSupport,
} from "../lib/review";
import { taskUrls } from "../lib/task-urls";
import { describeThrown, pushToast } from "../toast";
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
  const presence = usePresenceMap();
  const [busy, setBusy] = useState(false);
  const disabledReason = reviewDisabledReason({
    support,
    harness: taskHarness(task),
    runningTurn: presence[task.id]?.runningTurn === true,
  });
  const disabled = disabledReason !== undefined || busy;
  const target = defaultReviewTarget(task);
  const prNumber = task.pr?.number;

  async function review(kind: ReviewTargetKind): Promise<void> {
    if (disabled) return;
    setBusy(true);
    // Decision 2: the button creates or focuses the review tab right away.
    taskUrls.requestReviewTab(task.id);
    try {
      await window.harbormaster.core.requestReview({
        taskId: task.id,
        target: kind,
      });
    } catch (error) {
      pushToast(`Review failed: ${describeThrown(error)}`);
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
