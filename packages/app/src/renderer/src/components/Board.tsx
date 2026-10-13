import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { JSX } from "react";
import { useRef, useState } from "react";
import type { AwaitingKind, TaskState } from "../../../preload/api";
import { flattenBoard, useBoard, usePresenceMap } from "../core-client";
import { describeThrown, pushToast } from "../toast";
import { AwaitingReasonDialog } from "./AwaitingReasonDialog";
import { BoardColumn } from "./BoardColumn";
import { NewTaskDialog } from "./NewTaskDialog";
import { Button } from "./ui/button";

/**
 * Kanban board — renders @harbormaster/core's live board projection exactly
 * as returned (columns -> groups -> tasks; see /packages/core/src/engines
 * /board-grouping.ts). The board never holds its own copy of task
 * placement: every drag just calls `moveTask` (or `startTask` for a
 * backlog -> dev drop) and waits for the
 * "board-changed" push to re-render, so there is nothing to roll back if a
 * move is rejected (e.g. an illegal transition) \u2014 the UI simply doesn't
 * change.
 */
export function Board({
  onSelectTask,
}: {
  onSelectTask: (taskId: string) => void;
}): JSX.Element {
  const columns = useBoard();
  const presence = usePresenceMap();
  const [pendingDrop, setPendingDrop] = useState<{
    taskId: string;
  } | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  // Done-column-only toggle (see BoardColumn.tsx); archived tasks are hidden
  // by default, sidebar excludes them always regardless of this.
  const [showArchived, setShowArchived] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  // dnd-kit doesn't suppress the native `click` event the browser still
  // fires on pointerup after a completed drag (it only cancels at the
  // activation-constraint level, not the DOM click). Track whether this
  // gesture actually crossed the activation distance so a real drag
  // doesn't also trigger TaskCard's onClick "select" handler; a plain
  // click (never reaching onDragStart) still selects normally.
  const draggedRef = useRef(false);

  function handleDragStart(): void {
    draggedRef.current = true;
  }

  function handleSelectTask(taskId: string): void {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    onSelectTask(taskId);
  }

  // The suppressed click (if any) is dispatched right after pointerup, i.e.
  // before a 0ms timer fires; clear the flag then, so a drop that produced
  // no click (pointer released over another element) can't swallow the
  // next genuine card click.
  function clearDraggedSoon(): void {
    setTimeout(() => {
      draggedRef.current = false;
    }, 0);
  }

  function handleDragEnd(event: DragEndEvent): void {
    clearDraggedSoon();
    const { active, over } = event;
    if (!over) return;

    const targetState = over.id as TaskState;
    const taskId = active.id as string;

    const row = flattenBoard(columns).find((r) => r.task.id === taskId);
    if (!row || row.state === targetState) return;

    if (targetState === "awaiting") {
      setPendingDrop({ taskId });
      return;
    }

    // Backlog -> Dev is "start this task" (pi-home's startBacklogIssue):
    // startTask creates the parked task's branch + worktree + binding when
    // it has a repository but no workspace yet, and degrades to a plain
    // move otherwise — so every backlog->dev drop routes through it.
    if (row.state === "backlog" && targetState === "dev") {
      void window.harbormaster.core
        .startTask(taskId)
        .catch((error: unknown) => {
          pushToast(describeThrown(error), "error");
        });
      return;
    }

    void window.harbormaster.core
      .moveTask(taskId, targetState)
      .catch((error: unknown) => {
        console.error("moveTask failed:", error);
      });
  }

  function confirmAwaiting(awaiting: AwaitingKind): void {
    const taskId = pendingDrop?.taskId;
    setPendingDrop(null);
    if (!taskId) return;
    void window.harbormaster.core
      .moveTask(taskId, "awaiting", { awaiting })
      .catch((error: unknown) => {
        console.error("moveTask failed:", error);
      });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end border-b border-border px-3 py-2">
        <Button
          size="sm"
          data-testid="board-new-task-button"
          onClick={() => setNewTaskOpen(true)}
        >
          + New task
        </Button>
      </div>
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={clearDraggedSoon}
      >
        <div className="flex h-full gap-3 overflow-x-auto p-3">
          {columns.map((column) => (
            <BoardColumn
              key={column.state}
              column={column}
              presence={presence}
              onSelectTask={handleSelectTask}
              showArchived={showArchived}
              onToggleArchived={() => setShowArchived((prev) => !prev)}
            />
          ))}
        </div>
      </DndContext>
      <AwaitingReasonDialog
        open={pendingDrop !== null}
        onCancel={() => setPendingDrop(null)}
        onConfirm={confirmAwaiting}
      />
      <NewTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        onCreate={(input) => {
          void window.harbormaster.core
            .createTask({
              title: input.title,
              initialPrompt: input.initialPrompt ?? "",
              ...(input.repositoryId
                ? { repositoryId: input.repositoryId }
                : {}),
              ...(input.start ? { start: true } : {}),
            })
            .catch((error: unknown) => {
              console.error("createTask failed:", error);
              pushToast(describeThrown(error), "error");
            });
        }}
      />
    </div>
  );
}
