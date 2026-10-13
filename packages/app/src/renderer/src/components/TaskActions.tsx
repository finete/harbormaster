import { Loader2, Play } from "lucide-react";
import type { JSX, MouseEvent, PointerEvent } from "react";
import { useState } from "react";
import type { Task } from "../../../preload/api";
import {
  canDone,
  canReview,
  startTaskMutation,
  toDoneMutation,
  toReviewMutation,
} from "../lib/task-mutations";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";

/**
 * Compact "Start" (backlog only) / "To review" / "Done" actions, shared by `TaskCard` (board) and
 * `TaskWorkspace`'s header (the focused task). Both call straight through
 * the IPC bridge (same pattern as `Board.tsx`/`Sidebar.tsx`'s `moveTask`
 * calls) — the board always re-renders from the next `board-changed` push,
 * never from a locally-applied result. Thrown errors and `toDone`'s returned
 * `warning` both surface as a toast (see `toast.ts`); nothing here
 * special-cases *which* failure it was.
 */
export function TaskActions({
  task,
  onPointerDownCapture,
}: {
  task: Task;
  /** Stops dnd-kit's drag-activation listeners (spread on the whole TaskCard) from treating a button press as a drag gesture start. */
  onPointerDownCapture?: (event: PointerEvent) => void;
}): JSX.Element {
  const [busy, setBusy] = useState<"start" | "review" | "done" | null>(null);

  const reviewAllowed = canReview(task);
  const doneAllowed = canDone(task);

  function stopClick(event: MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
  }

  async function handleStart(
    event: MouseEvent<HTMLButtonElement>,
  ): Promise<void> {
    stopClick(event);
    if (busy) return;
    setBusy("start");
    try {
      await startTaskMutation(task.id);
    } finally {
      setBusy(null);
    }
  }

  async function handleToReview(
    event: MouseEvent<HTMLButtonElement>,
  ): Promise<void> {
    stopClick(event);
    if (busy) return;
    setBusy("review");
    try {
      await toReviewMutation(task.id);
    } finally {
      setBusy(null);
    }
  }

  async function handleToDone(
    event: MouseEvent<HTMLButtonElement>,
  ): Promise<void> {
    stopClick(event);
    if (busy) return;
    setBusy("done");
    try {
      await toDoneMutation(task.id);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="flex items-center gap-1.5"
      data-testid={`task-actions-${task.id}`}
      onPointerDownCapture={onPointerDownCapture}
    >
      {task.state === "backlog" && (
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={handleStart}
          data-testid={`start-task-button-${task.id}`}
          title="Start: create the branch + worktree and move to Dev (s)"
        >
          {busy === "start" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Play className="h-3 w-3" />
          )}
          Start
          <Kbd>s</Kbd>
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={!reviewAllowed || busy !== null}
        onClick={handleToReview}
        data-testid={`to-review-button-${task.id}`}
        title="Move to Awaiting review (r)"
      >
        {busy === "review" && <Loader2 className="h-3 w-3 animate-spin" />}
        To review
        <Kbd>r</Kbd>
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!doneAllowed || busy !== null}
        onClick={handleToDone}
        data-testid={`to-done-button-${task.id}`}
        title="Move to Done (x)"
      >
        {busy === "done" && <Loader2 className="h-3 w-3 animate-spin" />}
        Done
        <Kbd>x</Kbd>
      </Button>
    </div>
  );
}
