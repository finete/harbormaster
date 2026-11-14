// Pure lineage-nesting logic shared by the board (BoardColumn.tsx) and the
// workspace sidebar (Sidebar.tsx) — see /docs/design-decisions.md
// "Launching tasks from an agent" and its "Lineage wins over repo within a
// column" bullet.
//
// One consistent rule, documented here once instead of twice, in two steps:
//
// 1. Grouping (`hoistChildrenIntoParentGroups`): lineage wins over
//    repository within a column. A child whose parent sits in the same
//    *scope* — the same board column (and, in Awaiting, the same awaiting
//    kind), or the sidebar's open, unpinned rows — moves into its parent's
//    repo group, whatever its own repository is. The parent's group hosts
//    the family; a group's count is the rows it then holds.
// 2. Layout (`layoutLineageRows`): within one rendering group, a child
//    nests directly under its parent's row when both are present. Nesting
//    never crosses a board-column / awaiting-kind boundary (and on the
//    sidebar never reaches a parent that isn't open, or is pinned), so it
//    can never fight the group-collapse / drag-and-drop /
//    keyboard-selection grid, all of which stay scoped per group.
//
// Everywhere else (a different column, a different awaiting kind, or —
// sidebar-only — a parent that isn't open or a user-detached child) the
// child keeps its own repo group / position and gets a muted
// "↳ <parent title>" line instead (`parentTitle` on its row). This also
// gives "a Done parent's children stay attached to it" for free: the Done
// parent still reports its full child count (`children.count`), even
// though none of them render nested there once they're off in Dev.
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

/** How `hoistChildrenIntoParentGroups` reads and rebuilds a caller's group shape. */
export interface LineageGroupAccess<G, T> {
  items(group: G): readonly T[];
  task(item: T): Task;
  withItems(group: G, items: T[]): G;
  /** Groups with different scopes never exchange children (the Awaiting column's kind). Default: one scope. */
  scope?(group: G): string;
}

/**
 * Step 1 of the module rule: moves every child whose parent is in another
 * group of the same scope into its parent's group (appended after that
 * group's own items, in input order — `layoutLineageRows` then places it
 * under the parent). Groups emptied by the move are dropped; when nothing
 * moves, `groups` is returned as-is. Pure; caller-owned group shape.
 */
export function hoistChildrenIntoParentGroups<G, T>(
  groups: readonly G[],
  access: LineageGroupAccess<G, T>,
): G[] {
  const groupOfTask = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const item of access.items(group)) {
      groupOfTask.set(access.task(item).id, index);
    }
  });
  const scopeOf = (index: number): string => {
    const group = groups[index];
    return group === undefined || !access.scope ? "" : access.scope(group);
  };
  const staying: T[][] = groups.map(() => []);
  const incoming: T[][] = groups.map(() => []);
  let moved = false;
  groups.forEach((group, index) => {
    for (const item of access.items(group)) {
      const parentId = access.task(item).parentTaskId;
      const host =
        parentId === undefined ? undefined : groupOfTask.get(parentId);
      if (
        host !== undefined &&
        host !== index &&
        scopeOf(host) === scopeOf(index)
      ) {
        incoming[host]?.push(item);
        moved = true;
      } else {
        staying[index]?.push(item);
      }
    }
  });
  if (!moved) return [...groups];
  const result: G[] = [];
  groups.forEach((group, index) => {
    const items = [...(staying[index] ?? []), ...(incoming[index] ?? [])];
    if (items.length > 0) result.push(access.withItems(group, items));
  });
  return result;
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

/** Opt-in extras for callers that own their own order (the sidebar); the board passes none. */
export interface LayoutLineageOptions {
  /** Children rendered top-level (with the "↳ parent" line) even though their parent is in the same group. */
  detachedIds?: ReadonlySet<string>;
  /** Sibling order for nested children: ids by position; unknown ids sort after, oldest first. Default: `createdAt`. */
  siblingOrder?: readonly string[];
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
  options: LayoutLineageOptions = {},
): LineageRow<T>[] {
  const itemById = new Map(items.map((item) => [item.task.id, item] as const));
  const detached = options.detachedIds;
  const isNestedHere = (task: Task): boolean =>
    !!task.parentTaskId &&
    itemById.has(task.parentTaskId) &&
    !detached?.has(task.id);
  const rows: LineageRow<T>[] = [];
  for (const item of items) {
    const { task } = item;
    if (isNestedHere(task)) {
      continue; // rendered nested under its parent's row below, not here
    }
    const row: LineageRow<T> = { item, nested: false };
    if (task.parentTaskId) {
      const parentTitle = index.taskById.get(task.parentTaskId)?.title;
      if (parentTitle) row.parentTitle = parentTitle;
    }
    const allChildren = index.childrenByParent.get(task.id) ?? [];
    if (allChildren.length > 0) {
      const nestedChildren = sortSiblings(
        allChildren.filter(
          (child) => itemById.has(child.id) && isNestedHere(child),
        ),
        options.siblingOrder,
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

function sortSiblings(
  children: Task[],
  siblingOrder: readonly string[] | undefined,
): Task[] {
  if (!siblingOrder) return children;
  const index = new Map(siblingOrder.map((id, i) => [id, i] as const));
  return children
    .map((child, position) => ({ child, position }))
    .sort((a, b) => {
      const ai = index.get(a.child.id);
      const bi = index.get(b.child.id);
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      return a.position - b.position;
    })
    .map(({ child }) => child);
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
