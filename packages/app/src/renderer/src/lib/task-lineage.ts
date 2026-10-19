// Pure lineage-nesting logic shared by the board (BoardColumn.tsx) and the
// workspace sidebar (Sidebar.tsx) — see ai/prds/task-launching.md's
// "renderer: children nested under parents" line and the wave-3 task
// brief's UI decisions.
//
// One consistent rule, documented here once instead of twice: a child nests
// directly under its parent's row only when BOTH land in the very same
// *rendering group* the caller hands in (a board column's repo/awaiting
// group, or the sidebar's repo group of currently-open tasks) — nesting
// never crosses a board-column or repo-group boundary, so it can never
// fight the existing group-collapse / drag-and-drop / keyboard-selection
// grid, all of which are already scoped per group. Everywhere else (a
// different column, a different repo group, or — sidebar-only — a parent
// that isn't currently open) the child keeps its own natural position and
// gets a muted "↳ <parent title>" line instead (`parentTitle` on its row).
// This also gives "a Done parent's children stay attached to it" for free:
// the Done parent still reports its full child count (`children.count`),
// even though none of them render nested there once they're off in Dev.
import type { Task } from "../../../preload/api";

/** One task's lineage neighborhood, indexed once per render from the full (unfiltered) board. */
export interface LineageIndex {
  /** `parentTaskId` -> its children, oldest first. Includes every child anywhere on the board, any column. */
  childrenByParent: ReadonlyMap<string, Task[]>;
  /** Every known task by id (title lookups for parent/provenance lines). */
  taskById: ReadonlyMap<string, Task>;
}

export function buildLineageIndex(tasks: Iterable<Task>): LineageIndex {
  const taskById = new Map<string, Task>();
  for (const task of tasks) taskById.set(task.id, task);
  const childrenByParent = new Map<string, Task[]>();
  for (const task of taskById.values()) {
    if (!task.parentTaskId) continue;
    const bucket = childrenByParent.get(task.parentTaskId);
    if (bucket) bucket.push(task);
    else childrenByParent.set(task.parentTaskId, [task]);
  }
  for (const bucket of childrenByParent.values()) {
    bucket.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return { childrenByParent, taskById };
}

/** Anything with a `.task` the layout can key off of (a bare `Task`, a `SidebarRow`, ...). */
export interface LineageItem {
  task: Task;
}

export interface LineageChildrenChip {
  /** Total children anywhere on the board (what the "N children" chip reports). */
  count: number;
  /** Whether the caller's saved set currently hides this parent's same-group children. */
  collapsed: boolean;
  /** Whether any of those children actually render nested here (false = every child is elsewhere; the chip still shows the count but has nothing to toggle). */
  nestedHere: boolean;
}

export interface LineageRow<T extends LineageItem> {
  item: T;
  /** Rendered indented, directly under its parent's own row. */
  nested: boolean;
  /** Set only on a row that has at least one child somewhere on the board. */
  children?: LineageChildrenChip;
  /** Set when this row has a parent it is NOT nested under here — render the "↳ <parent title>" line. Absent when the parent task is unknown (deleted). */
  parentTitle?: string;
}

/**
 * Orders one rendering group's items so each child directly follows its
 * parent when both are present in `items` (see module doc); a parent whose
 * saved id is in `collapsedParents` renders its chip collapsed and omits
 * the nested rows entirely (same pattern as the board/sidebar's existing
 * group-collapse persistence).
 */
export function layoutLineageRows<T extends LineageItem>(
  items: readonly T[],
  index: LineageIndex,
  collapsedParents: ReadonlySet<string>,
): LineageRow<T>[] {
  const itemById = new Map(items.map((item) => [item.task.id, item] as const));
  const rows: LineageRow<T>[] = [];
  for (const item of items) {
    const { task } = item;
    if (task.parentTaskId && itemById.has(task.parentTaskId)) {
      continue; // rendered nested under its parent's row below, not here
    }
    const row: LineageRow<T> = { item, nested: false };
    if (task.parentTaskId) {
      const parentTitle = index.taskById.get(task.parentTaskId)?.title;
      if (parentTitle) row.parentTitle = parentTitle;
    }
    const allChildren = index.childrenByParent.get(task.id) ?? [];
    if (allChildren.length > 0) {
      const nestedChildren = allChildren.filter((child) =>
        itemById.has(child.id),
      );
      row.children = {
        count: allChildren.length,
        collapsed: collapsedParents.has(task.id),
        nestedHere: nestedChildren.length > 0,
      };
      rows.push(row);
      if (nestedChildren.length > 0 && !collapsedParents.has(task.id)) {
        for (const child of nestedChildren) {
          const childItem = itemById.get(child.id);
          if (childItem) rows.push({ item: childItem, nested: true });
        }
      }
    } else {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Task ids hidden from `items` right now because their parent is in the
 * same group and collapsed (see `layoutLineageRows`) — reused by the
 * board's keyboard-selection grid (lib/board-selection.ts) so arrow-key
 * navigation never lands on a card that isn't actually on screen.
 */
export function hiddenNestedChildIds(
  items: readonly LineageItem[],
  collapsedParents: ReadonlySet<string>,
): Set<string> {
  const idsHere = new Set(items.map((item) => item.task.id));
  const hidden = new Set<string>();
  for (const item of items) {
    const parentId = item.task.parentTaskId;
    if (parentId && idsHere.has(parentId) && collapsedParents.has(parentId)) {
      hidden.add(item.task.id);
    }
  }
  return hidden;
}
