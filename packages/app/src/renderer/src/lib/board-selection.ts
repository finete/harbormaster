// Pure logic for the board's keyboard selection (pi-home's TUI board keys,
// ported to a 2D card grid: columns -> cards, where "up/down" walk a
// column's cards across its group boundaries and "left/right" jump to the
// nearest adjacent non-empty column). Kept dependency-free from React so it
// is cheaply unit-testable (see tests/board-selection.test.ts).
import type { BoardColumn, BoardGroup } from "../../../preload/api";
import {
  hiddenNestedChildIds,
  hoistChildrenIntoParentGroups,
} from "./task-lineage";

export type MoveDirection = "left" | "right" | "up" | "down";

/** One column's cards, already flattened across its (possibly hidden) groups, in on-screen order. */
export interface SelectionColumn {
  state: BoardColumn["state"];
  taskIds: string[];
}

export type SelectionGrid = SelectionColumn[];

/**
 * The groups `BoardColumn.tsx` renders: the archived-task filter
 * (done-column-only, hidden unless `showArchived`), then the lineage rule
 * (lib/task-lineage.ts): a child whose parent is in this column — and, in
 * Awaiting, under the same awaiting kind — moves into the parent's repo
 * group. Extracted so the keyboard grid always matches what's actually on
 * screen. Core's own grouping (engines/board-grouping.ts) stays per-repo.
 */
export function visibleGroupsForColumn(
  column: BoardColumn,
  showArchived: boolean,
): BoardGroup[] {
  const groups =
    column.state !== "done" || showArchived
      ? column.groups
      : column.groups
          .map((group) => ({
            ...group,
            tasks: group.tasks.filter((task) => !task.archivedAt),
          }))
          .filter((group) => group.tasks.length > 0);
  return hoistChildrenIntoParentGroups(groups, {
    items: (group) => group.tasks,
    task: (task) => task,
    withItems: (group, tasks) => ({ ...group, tasks }),
    scope: (group) => group.primaryLabel ?? "",
  });
}

/**
 * Stable identity of one board group for its saved collapse state: the
 * same core group id (a repository id, "scratch", or the awaiting column's
 * `<reason>::<repo>`) can appear in several columns, and each column's copy
 * collapses independently.
 */
export function boardGroupKey(
  state: BoardColumn["state"],
  groupId: BoardGroup["id"],
): string {
  return `${state}:${groupId}`;
}

/** Whether `group` in `state`'s column is collapsed per the saved key set. */
export function isBoardGroupCollapsed(
  collapsed: ReadonlySet<string> | undefined,
  state: BoardColumn["state"],
  groupId: BoardGroup["id"],
): boolean {
  return collapsed?.has(boardGroupKey(state, groupId)) ?? false;
}

/**
 * Builds the keyboard-navigable grid from the live board, in column order.
 * Cards inside a collapsed group (see `boardGroupKey`) are off screen, so
 * the grid skips them exactly like BoardColumn.tsx hides them. A fully
 * collapsed column (the slim rail, see `boardGroupKey`'s column-level
 * sibling in sidebar-persistence.ts) contributes no cards at all, the same
 * treatment an empty column already gets from `moveSelection`'s left/right
 * skip.
 */
export function buildSelectionGrid(
  columns: BoardColumn[],
  showArchived: boolean,
  collapsedGroups?: ReadonlySet<string>,
  collapsedColumns?: ReadonlySet<BoardColumn["state"]>,
  /** Lineage "N children" collapse state (see lib/task-lineage.ts); a collapsed parent's same-group children are off screen, so they must never be selectable either. */
  collapsedLineageParents?: ReadonlySet<string>,
): SelectionGrid {
  return columns.map((column) => ({
    state: column.state,
    taskIds: collapsedColumns?.has(column.state)
      ? []
      : visibleGroupsForColumn(column, showArchived)
          .filter(
            (group) =>
              !isBoardGroupCollapsed(collapsedGroups, column.state, group.id),
          )
          .flatMap((group) => {
            const hidden = collapsedLineageParents
              ? hiddenNestedChildIds(
                  group.tasks.map((task) => ({ task })),
                  collapsedLineageParents,
                )
              : undefined;
            return group.tasks
              .filter((task) => !hidden?.has(task.id))
              .map((task) => task.id);
          }),
  }));
}

/** First card of the first non-empty column, or `null` if the whole board is empty. */
export function firstSelectableTaskId(grid: SelectionGrid): string | null {
  for (const column of grid) {
    if (column.taskIds.length > 0) return column.taskIds[0] ?? null;
  }
  return null;
}

/**
 * Keeps following a task id across board re-renders (e.g. after x/r/s moved
 * it to another column): if it's still visible anywhere in the grid, stays
 * selected; otherwise resets to the first card, same as entering the board
 * fresh.
 */
export function resolveSelection(
  grid: SelectionGrid,
  previousTaskId: string | null,
): string | null {
  if (
    previousTaskId &&
    grid.some((column) => column.taskIds.includes(previousTaskId))
  ) {
    return previousTaskId;
  }
  return firstSelectableTaskId(grid);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * One keyboard move from `currentTaskId`. Vertical moves clamp at the
 * column's top/bottom card (no wraparound, same as pi-home); horizontal
 * moves skip over empty columns and land on the closest-matching row index
 * in the target column. A direction with nowhere to go (edge column, or the
 * current task no longer present) returns the input unchanged/best-effort
 * fallback rather than `null`, so a stray keypress never clears selection.
 */
export function moveSelection(
  grid: SelectionGrid,
  currentTaskId: string | null,
  direction: MoveDirection,
): string | null {
  if (!currentTaskId) return firstSelectableTaskId(grid);

  const columnIndex = grid.findIndex((column) =>
    column.taskIds.includes(currentTaskId),
  );
  if (columnIndex === -1) return firstSelectableTaskId(grid);

  const column = grid[columnIndex];
  if (!column) return firstSelectableTaskId(grid);
  const rowIndex = column.taskIds.indexOf(currentTaskId);

  if (direction === "up" || direction === "down") {
    const delta = direction === "up" ? -1 : 1;
    const nextRow = clamp(rowIndex + delta, 0, column.taskIds.length - 1);
    return column.taskIds[nextRow] ?? currentTaskId;
  }

  const step = direction === "left" ? -1 : 1;
  for (
    let nextColumnIndex = columnIndex + step;
    nextColumnIndex >= 0 && nextColumnIndex < grid.length;
    nextColumnIndex += step
  ) {
    const candidate = grid[nextColumnIndex];
    if (candidate && candidate.taskIds.length > 0) {
      const targetRow = clamp(rowIndex, 0, candidate.taskIds.length - 1);
      return candidate.taskIds[targetRow] ?? currentTaskId;
    }
  }
  // No adjacent non-empty column in that direction: stay put.
  return currentTaskId;
}

/**
 * A column header's count, honest about filters: while the Done column
 * hides archived cards the header reads "shown/total" (with a tooltip
 * spelling it out) instead of silently reporting only the filtered number.
 */
export function columnCountLabel(
  shown: number,
  hiddenArchived: number,
): { text: string; title: string } {
  if (hiddenArchived > 0) {
    return {
      text: `${shown}/${shown + hiddenArchived}`,
      title: `${shown} shown · ${hiddenArchived} archived hidden`,
    };
  }
  return { text: String(shown), title: `${shown} tasks` };
}
