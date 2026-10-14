import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import type { AwaitingKind, TaskState } from "../../../preload/api";
import { isConfirmOpen } from "../confirm";
import {
  flattenBoard,
  useBoard,
  useManualRefresh,
  usePresenceMap,
  useUnreadTaskIds,
} from "../core-client";
import {
  buildSelectionGrid,
  moveSelection,
  resolveSelection,
} from "../lib/board-selection";
import { isTypingTarget } from "../lib/keyboard-guard";
import { modKeyLabel } from "../lib/platform";
import {
  canReview,
  canStart,
  moveTaskMutation,
  startTaskMutation,
  toDoneMutation,
  toReviewMutation,
} from "../lib/task-mutations";
import { AwaitingReasonDialog } from "./AwaitingReasonDialog";
import { BoardColumn } from "./BoardColumn";
import { BoardKeyLegend } from "./BoardKeyLegend";
import { NewTaskDialog, type NewTaskDialogResult } from "./NewTaskDialog";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";

/**
 * Kanban board — renders @harbormaster/core's live board projection exactly
 * as returned (columns -> groups -> tasks; see /packages/core/src/engines
 * /board-grouping.ts). The board never holds its own copy of task
 * placement: every drag routes through the same mutation its button/key
 * uses (`startTask` for backlog -> dev, `toDone` for Done, `toReview` for
 * Awaiting / Review on a branch-backed task, `moveTask` otherwise) and
 * waits for the "board-changed" push to re-render, so there is nothing to
 * roll back if a move is rejected (e.g. an illegal transition): the UI
 * simply doesn't change and the error surfaces as a toast.
 *
 * Also owns the pi-home-style TUI keymap (see lib/board-selection.ts):
 * arrow keys move a keyboard-selected card, Enter opens it, n/g/a/x/r/s
 * mirror the on-card buttons, Escape returns to the workspace view. Only
 * live while `active` (the board is the visible view, per App.tsx) and
 * never while a dialog is open or focus is in a text field/the terminal
 * (lib/keyboard-guard.ts).
 */
export function Board({
  onSelectTask,
  onCreateTask,
  active = true,
  openNewTaskSignal,
  onBackToWorkspace,
  focusedTaskId = null,
}: {
  onSelectTask: (taskId: string) => void;
  onCreateTask: (input: NewTaskDialogResult) => void;
  /** Whether the board is the currently-visible view; gates the single-key TUI shortcuts. */
  active?: boolean;
  /** Bumped by App.tsx's Cmd/Ctrl+N handler while the board is the active view; opens this board's New Task dialog. */
  openNewTaskSignal?: number;
  /** Escape: back to the workspace view (App.tsx owns the view switch). */
  onBackToWorkspace?: () => void;
  /** App's currently-focused task (see core-client.ts's useUnreadTaskIds); absent outside the workspace view's own tracking. */
  focusedTaskId?: string | null;
}): JSX.Element {
  const columns = useBoard();
  const presence = usePresenceMap();
  const manualRefresh = useManualRefresh();
  const unreadTaskIds = useUnreadTaskIds(focusedTaskId);
  const [pendingDrop, setPendingDrop] = useState<{
    taskId: string;
  } | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
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
      void startTaskMutation(taskId);
      return;
    }

    // A drop on Done is the same gesture as the Done button / `x`: the safe
    // cleanup path (worktree + merged branch) with its warning toast, never
    // a bare column move that would leave the workspace behind.
    if (targetState === "done") {
      void toDoneMutation(taskId);
      return;
    }

    void moveTaskMutation(taskId, targetState);
  }

  function confirmAwaiting(awaiting: AwaitingKind): void {
    const taskId = pendingDrop?.taskId;
    setPendingDrop(null);
    if (!taskId) return;
    const task = flattenBoard(columns).find((r) => r.task.id === taskId)?.task;
    // "Review" for a branch-backed task is the To review action (push +
    // open/reuse the PR), exactly like the button / `r`; Slack and deploy
    // reasons (and review for scratch work) are plain column moves.
    if (awaiting.kind === "review" && task && canReview(task)) {
      void toReviewMutation(taskId);
      return;
    }
    void moveTaskMutation(taskId, "awaiting", { awaiting });
  }

  // Keyboard selection follows the live board: starts at the first card,
  // stays on the same task across re-renders (e.g. after x/r/s moves it to
  // another column), and resets to the first card if that task disappears
  // (archived-hidden, moved to a filtered-out state, etc) — see
  // lib/board-selection.ts's resolveSelection.
  useEffect(() => {
    const grid = buildSelectionGrid(columns, showArchived);
    setSelectedTaskId((previous) => resolveSelection(grid, previous));
  }, [columns, showArchived]);

  // Cmd/Ctrl+N from App.tsx while this board is the active view.
  const openNewTaskSignalRef = useRef(openNewTaskSignal);
  useEffect(() => {
    if (
      openNewTaskSignal !== undefined &&
      openNewTaskSignal !== openNewTaskSignalRef.current
    ) {
      openNewTaskSignalRef.current = openNewTaskSignal;
      setNewTaskOpen(true);
    }
  }, [openNewTaskSignal]);

  const selectedTask = flattenBoard(columns).find(
    (row) => row.task.id === selectedTaskId,
  )?.task;

  // The TUI-style single-key board keymap (pi-home parity, see
  // lib/board-selection.ts and AGENTS.md's "port the spirit" brief): only
  // live while this board is the visible view, no dialog is open, and focus
  // isn't in a text field or the terminal (lib/keyboard-guard.ts) — the
  // xterm terminal must receive every keystroke verbatim when focused.
  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (newTaskOpen || pendingDrop || isConfirmOpen()) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      const grid = buildSelectionGrid(columns, showArchived);
      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          setSelectedTaskId((current) => moveSelection(grid, current, "left"));
          return;
        case "ArrowRight":
          event.preventDefault();
          setSelectedTaskId((current) => moveSelection(grid, current, "right"));
          return;
        case "ArrowUp":
          event.preventDefault();
          setSelectedTaskId((current) => moveSelection(grid, current, "up"));
          return;
        case "ArrowDown":
          event.preventDefault();
          setSelectedTaskId((current) => moveSelection(grid, current, "down"));
          return;
        case "Enter":
          if (selectedTaskId) {
            event.preventDefault();
            onSelectTask(selectedTaskId);
          }
          return;
        case "n":
          event.preventDefault();
          setNewTaskOpen(true);
          return;
        case "g":
          event.preventDefault();
          manualRefresh.refresh();
          return;
        case "a":
          event.preventDefault();
          setShowArchived((prev) => !prev);
          return;
        case "x":
          if (selectedTask) {
            event.preventDefault();
            void toDoneMutation(selectedTask.id);
          }
          return;
        case "r":
          if (selectedTask && canReview(selectedTask)) {
            event.preventDefault();
            void toReviewMutation(selectedTask.id);
          }
          return;
        case "s":
          if (selectedTask && canStart(selectedTask)) {
            event.preventDefault();
            void startTaskMutation(selectedTask.id);
          }
          return;
        case "Escape":
          if (onBackToWorkspace) {
            event.preventDefault();
            onBackToWorkspace();
          }
          return;
        default:
          return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    active,
    newTaskOpen,
    pendingDrop,
    columns,
    showArchived,
    selectedTaskId,
    selectedTask,
    onSelectTask,
    onBackToWorkspace,
    manualRefresh,
  ]);

  return (
    <div className="flex h-full flex-col">
      <BoardKeyLegend />
      <div className="flex items-center justify-end border-b border-border px-3 py-2">
        <Button
          size="sm"
          data-testid="board-new-task-button"
          onClick={() => setNewTaskOpen(true)}
        >
          + New task
          <Kbd>{`${modKeyLabel()}N`}</Kbd>
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
              selectedTaskId={selectedTaskId}
              unreadTaskIds={unreadTaskIds}
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
        onCreate={onCreateTask}
      />
    </div>
  );
}
