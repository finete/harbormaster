import { Loader2 } from "lucide-react";
import type { JSX, MouseEvent, PointerEvent } from "react";
import { useState } from "react";
import type { Task } from "../../../preload/api";
import { describeThrown, pushToast } from "../toast";
import { Button } from "./ui/button";

/**
 * Compact "To review" / "Done" action pair, shared by `TaskCard` (board) and
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
  const [busy, setBusy] = useState<"review" | "done" | null>(null);

  const canReview =
    Boolean(task.repositoryId && task.branch) &&
    (task.state === "dev" || task.state === "awaiting");
  const canDone = task.state === "dev" || task.state === "awaiting";

  function stopClick(event: MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
  }

  async function handleToReview(
    event: MouseEvent<HTMLButtonElement>,
  ): Promise<void> {
    stopClick(event);
    if (busy) return;
    setBusy("review");
    try {
      await window.harbormaster.core.toReview(task.id);
    } catch (error) {
      pushToast(describeThrown(error), "error");
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
      const result = await window.harbormaster.core.toDone(task.id);
      if (result.warning) pushToast(result.warning, "warning");
    } catch (error) {
      pushToast(describeThrown(error), "error");
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
      <Button
        size="sm"
        variant="outline"
        disabled={!canReview || busy !== null}
        onClick={handleToReview}
        data-testid={`to-review-button-${task.id}`}
      >
        {busy === "review" && <Loader2 className="h-3 w-3 animate-spin" />}
        To review
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!canDone || busy !== null}
        onClick={handleToDone}
        data-testid={`to-done-button-${task.id}`}
      >
        {busy === "done" && <Loader2 className="h-3 w-3 animate-spin" />}
        Done
      </Button>
    </div>
  );
}
