import {
  type Announcements,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  getClientRect,
  type MeasuringConfiguration,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TaskState } from "../../../preload/api";
import { isConfirmOpen } from "../confirm";
import {
  flattenBoard,
  useBoard,
  useManualRefresh,
  usePresenceMap,
  useUnreadTaskIds,
} from "../core-client";
import {
  boardGroupKey,
  buildSelectionGrid,
  moveSelection,
  resolveSelection,
} from "../lib/board-selection";
import { isTypingTarget } from "../lib/keyboard-guard";
import {
  readBoardCollapsedColumns,
  readBoardCollapsedGroups,
  readCollapsedLineageParents,
  storeBoardCollapsedColumns,
  storeBoardCollapsedGroups,
  storeCollapsedLineageParents,
} from "../lib/sidebar-persistence";
import { buildLineageIndex } from "../lib/task-lineage";
import {
  canAwait,
  canStart,
  moveTaskMutation,
  startTaskMutation,
  toAwaitMutation,
  toDoneMutation,
} from "../lib/task-mutations";
import { useDragGuards } from "../lib/use-drag-guards";
import { type AwaitChoice, AwaitDialog } from "./AwaitDialog";
import { BoardColumn } from "./BoardColumn";
import { BoardKeyLegend } from "./BoardKeyLegend";
import { TaskCard } from "./TaskCard";

/**
 * Column-level drops (every droppable is a whole column): the pointer's
 * column wins (`pointerWithin`, dnd-kit's multi-container recommendation —
 * it never picks a neighbour just because the wide card overlaps it more).
 * When the pointer is in a gutter between columns or the board padding,
 * fall back to the drag preview's best rect overlap (`rectIntersection`,
 * the same fallback dnd-kit's multiple-containers example uses). Unlike a
 * `closestCorners`/`closestCenter` fallback this can still return nothing,
 * so releasing over the sidebar/toolbar cancels instead of committing a
 * move — a Done drop runs the destructive worktree cleanup.
 */
const columnCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) return pointerCollisions;
  return rectIntersection(args);
};

/**
 * Droppables are re-measured on every render while dragging
 * (`MeasuringStrategy.Always`): columns scroll (auto-scroll) and groups can
 * collapse mid-drag, and stale rects would mis-target drops. Each droppable
 * node sits inside its column's cards scroller (see BoardColumn.tsx — that
 * is what lets the auto-scroller find the scroller), so `measure` resolves
 * the full column element for the hit area.
 */
const boardMeasuring: MeasuringConfiguration = {
  droppable: {
    strategy: MeasuringStrategy.Always,
    measure: (node) =>
      getClientRect(node.closest("[data-board-column]") ?? node, {
        ignoreTransform: true,
      }),
  },
};

/**
 * Kanban board — renders @harbormaster/core's live board projection exactly
 * as returned (columns -> groups -> tasks; see /packages/core/src/engines
 * /board-grouping.ts). The board never holds its own copy of task
 * placement: every drag routes through the same verb its key uses
 * (`startTask` for backlog -> dev, the Await… picker + `toAwait` for
 * Awaiting, `toDone` for Done, `moveTask` otherwise) and waits for the
 * "board-changed" push to re-render, so there is nothing to roll back if a
 * move is rejected (e.g. an illegal transition): the UI simply doesn't
 * change and the error surfaces as a toast. Cards carry no buttons.
 *
 * Also owns the pi-home-style TUI keymap (see lib/board-selection.ts):
 * arrow keys move a keyboard-selected card, Enter opens it, s/r/x drive
 * the start/await/done verbs (r opens the Await… picker with review
 * preselected), n/g/a, Escape returns to the workspace view. Only
 * live while `active` (the board is the visible view, per App.tsx) and
 * never while a dialog is open or focus is in a text field/the terminal
 * (lib/keyboard-guard.ts).
 */
export function Board({
  onSelectTask,
  onNewTask,
  active = true,
  onBackToWorkspace,
  focusedTaskId = null,
}: {
  onSelectTask: (taskId: string) => void;
  /** `n`: open/focus the new-task draft (App.tsx leaves the board for the workspace view). */
  onNewTask: () => void;
  /** Whether the board is the currently-visible view; gates the single-key TUI shortcuts. */
  active?: boolean;
  /** Escape: back to the workspace view (App.tsx owns the view switch). */
  onBackToWorkspace?: () => void;
  /** App's currently-focused task (see core-client.ts's useUnreadTaskIds); absent outside the workspace view's own tracking. */
  focusedTaskId?: string | null;
}): JSX.Element {
  const columns = useBoard();
  const presence = usePresenceMap();
  const manualRefresh = useManualRefresh();
  const unreadTaskIds = useUnreadTaskIds(focusedTaskId);
  // The task the Await… picker is open for (a drop on Awaiting, or `r`).
  const [awaitTaskId, setAwaitTaskId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // Done-column-only toggle (see BoardColumn.tsx); archived tasks are hidden
  // by default, sidebar excludes them always regardless of this.
  const [showArchived, setShowArchived] = useState(false);
  // Board group collapse (rail parity): `boardGroupKey(column, group)` ids,
  // persisted with the sidebar's localStorage pattern so it survives relaunch.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() =>
    readBoardCollapsedGroups(window.localStorage),
  );
  // Whole-column collapse (the slim rail), persisted the same way as group
  // collapse but under its own key (sidebar-persistence.ts) since it's an
  // independent axis: a column can be collapsed with its groups left alone.
  const [collapsedColumns, setCollapsedColumns] = useState<Set<TaskState>>(
    () => readBoardCollapsedColumns(window.localStorage) as Set<TaskState>,
  );
  // Columns the current drag has auto-expanded for a peek (Azure DevOps-
  // style hover-to-reveal, see BoardColumn.tsx's onAutoExpandPeek): an
  // override on top of `collapsedColumns`, cleared on drag end/cancel so
  // the column snaps back to collapsed without touching the saved state.
  const [peekedColumns, setPeekedColumns] = useState<Set<TaskState>>(new Set());
  // The card being dragged, rendered as the portaled DragOverlay preview.
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  // Lineage "N children" chip collapse state (see lib/task-lineage.ts),
  // shared with the sidebar via the same localStorage key.
  const [collapsedLineageParents, setCollapsedLineageParents] = useState<
    Set<string>
  >(() => readCollapsedLineageParents(window.localStorage));
  const lineageIndex = useMemo(
    () => buildLineageIndex(flattenBoard(columns).map((row) => row.task)),
    [columns],
  );

  function toggleLineageChildren(parentTaskId: string): void {
    setCollapsedLineageParents((current) => {
      const next = new Set(current);
      if (next.has(parentTaskId)) next.delete(parentTaskId);
      else next.add(parentTaskId);
      storeCollapsedLineageParents(window.localStorage, next);
      return next;
    });
  }

  function toggleGroup(state: TaskState, groupId: string): void {
    setCollapsedGroups((current) => {
      const key = boardGroupKey(state, groupId);
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      storeBoardCollapsedGroups(window.localStorage, next);
      return next;
    });
  }

  function toggleColumn(state: TaskState): void {
    setCollapsedColumns((current) => {
      const next = new Set(current);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      storeBoardCollapsedColumns(window.localStorage, next);
      return next;
    });
  }

  function autoExpandPeek(state: TaskState): void {
    setPeekedColumns((current) => {
      if (current.has(state)) return current;
      const next = new Set(current);
      next.add(state);
      return next;
    });
  }

  // What's actually rendered collapsed right now: saved-collapsed minus any
  // mid-drag peek override. Recomputed each render (cheap, small sets) so
  // every consumer (the grid, the column list) always agrees.
  const effectiveCollapsedColumns = new Set(
    [...collapsedColumns].filter((state) => !peekedColumns.has(state)),
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  // Click-after-drag suppression + Escape key guard (shared with the
  // sidebar, see lib/use-drag-guards.ts). A plain click (never reaching
  // onDragStart) still selects normally.
  const { dragKeyGuardRef, beginDrag, endDrag, consumeDragClick } =
    useDragGuards();

  function handleDragStart(event: DragStartEvent): void {
    beginDrag();
    setActiveTaskId(String(event.active.id));
  }

  function handleDragCancel(): void {
    setActiveTaskId(null);
    setPeekedColumns(new Set());
    endDrag();
  }

  function handleSelectTask(taskId: string): void {
    if (consumeDragClick()) return;
    onSelectTask(taskId);
  }

  function handleDragEnd(event: DragEndEvent): void {
    setActiveTaskId(null);
    setPeekedColumns(new Set());
    endDrag();
    const { active, over } = event;
    if (!over) return;

    const targetState = over.id as TaskState;
    const taskId = active.id as string;

    const row = flattenBoard(columns).find((r) => r.task.id === taskId);
    if (!row || row.state === targetState) return;

    if (targetState === "awaiting") {
      setAwaitTaskId(taskId);
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

  function confirmAwait(choice: AwaitChoice): void {
    const taskId = awaitTaskId;
    setAwaitTaskId(null);
    if (!taskId) return;
    void toAwaitMutation(taskId, choice.kindId, choice.options);
  }

  // Keyboard selection follows the live board: starts at the first card,
  // stays on the same task across re-renders (e.g. after x/r/s moves it to
  // another column), and resets to the first card if that task disappears
  // (archived-hidden, moved to a filtered-out state, etc) — see
  // lib/board-selection.ts's resolveSelection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: effectiveCollapsedColumns is derived fresh every render from collapsedColumns/peekedColumns (a new Set each time, never reference-equal); depending on those two directly is what actually governs when this needs to re-run.
  useEffect(() => {
    const grid = buildSelectionGrid(
      columns,
      showArchived,
      collapsedGroups,
      effectiveCollapsedColumns,
      collapsedLineageParents,
    );
    setSelectedTaskId((previous) => resolveSelection(grid, previous));
  }, [
    columns,
    showArchived,
    collapsedGroups,
    collapsedColumns,
    peekedColumns,
    collapsedLineageParents,
  ]);

  // Board-axis scrolling (item 12): trackpads and horizontal wheels scroll
  // the column row natively; Shift+wheel is only converted to horizontal
  // scrolling by some platforms (macOS does it in the OS, so its events
  // already arrive with deltaX). Map a purely vertical Shift+wheel onto the
  // row so it works everywhere; a non-passive native listener, since
  // React's onWheel is passive and can't stop the column's vertical scroll.
  const columnsRowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = columnsRowRef.current;
    if (!row) return;
    function onWheel(event: WheelEvent): void {
      if (!event.shiftKey || event.deltaX !== 0 || event.deltaY === 0) return;
      if (!row) return;
      event.preventDefault();
      row.scrollLeft += event.deltaY;
    }
    row.addEventListener("wheel", onWheel, { passive: false });
    return () => row.removeEventListener("wheel", onWheel);
  }, []);

  const selectedTask = flattenBoard(columns).find(
    (row) => row.task.id === selectedTaskId,
  )?.task;
  const activeTask = activeTaskId
    ? flattenBoard(columns).find((row) => row.task.id === activeTaskId)?.task
    : undefined;

  // Screen-reader announcements (item 15) in board terms — task titles and
  // column names instead of dnd-kit's default raw draggable/droppable ids.
  const taskTitle = (id: string | number): string =>
    flattenBoard(columns).find((row) => row.task.id === String(id))?.task
      .title ?? "task";
  const columnTitle = (id: string | number | undefined): string =>
    columns.find((column) => column.state === id)?.title ?? String(id);
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${taskTitle(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${taskTitle(active.id)} is over the ${columnTitle(over.id)} column.`
        : `${taskTitle(active.id)} is no longer over a column.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `${taskTitle(active.id)} dropped on the ${columnTitle(over.id)} column.`
        : `${taskTitle(active.id)} dropped outside the board; nothing moved.`,
    onDragCancel: ({ active }) =>
      `Moving ${taskTitle(active.id)} was cancelled; nothing moved.`,
  };

  // The TUI-style single-key board keymap (pi-home parity, see
  // lib/board-selection.ts and AGENTS.md's "port the spirit" brief): only
  // live while this board is the visible view, no dialog is open, and focus
  // isn't in a text field or the terminal (lib/keyboard-guard.ts) — the
  // xterm terminal must receive every keystroke verbatim when focused.
  // biome-ignore lint/correctness/useExhaustiveDependencies: collapsedColumns/peekedColumns are listed directly (not the derived effectiveCollapsedColumns the callback reads) since that Set is recreated every render and would never let this settle.
  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (awaitTaskId || isConfirmOpen()) return;
      if (dragKeyGuardRef.current) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      const grid = buildSelectionGrid(
        columns,
        showArchived,
        collapsedGroups,
        effectiveCollapsedColumns,
        collapsedLineageParents,
      );
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
          onNewTask();
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
          // Muscle-memory fast path: opens the Await… picker with review
          // preselected (r, Enter) — never a hardwired kind.
          if (selectedTask && canAwait(selectedTask)) {
            event.preventDefault();
            setAwaitTaskId(selectedTask.id);
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
    onNewTask,
    awaitTaskId,
    columns,
    showArchived,
    collapsedGroups,
    collapsedColumns,
    peekedColumns,
    collapsedLineageParents,
    selectedTaskId,
    selectedTask,
    onSelectTask,
    onBackToWorkspace,
    manualRefresh,
  ]);

  return (
    <div className="relative flex h-full flex-col">
      <BoardKeyLegend />
      <DndContext
        sensors={sensors}
        collisionDetection={columnCollisionDetection}
        measuring={boardMeasuring}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              "Drag with a pointer to move this task to another column; Escape cancels. From the keyboard, arrow keys select a card and s, r, x start, await or finish it.",
          },
        }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div
          ref={columnsRowRef}
          className="flex h-full gap-3 overflow-x-auto p-3 [justify-content:safe_center]"
          data-testid="board-columns"
        >
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
              collapsedGroups={collapsedGroups}
              onToggleGroup={(groupId) => toggleGroup(column.state, groupId)}
              dragTask={activeTask}
              collapsed={effectiveCollapsedColumns.has(column.state)}
              onToggleCollapse={() => toggleColumn(column.state)}
              onAutoExpandPeek={() => autoExpandPeek(column.state)}
              lineageIndex={lineageIndex}
              collapsedLineageParents={collapsedLineageParents}
              onToggleLineageChildren={toggleLineageChildren}
            />
          ))}
        </div>
        {/* dnd-kit's canonical drag preview, portaled out of every column's
          overflow scroller so it is never clipped and never stretches a
          scroll container (the in-flow card just dims; see TaskCard.tsx). */}
        {createPortal(
          <DragOverlay>
            {activeTask ? (
              <TaskCard
                overlay
                task={activeTask}
                presence={presence[activeTask.id]}
                unread={unreadTaskIds.has(activeTask.id)}
              />
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
      <AwaitDialog
        taskId={awaitTaskId}
        onCancel={() => setAwaitTaskId(null)}
        onConfirm={confirmAwait}
      />
    </div>
  );
}
