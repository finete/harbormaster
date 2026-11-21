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
// Trees nest more than one level (docs/task-trees.md, up to
// `launch.maxNestingDepth` = 4 levels): both steps work per link. A task
// follows its parent into the parent's final group, so a grandchild lands
// wherever its own parent does, and the layout draws one indent per level
// (`indent`, at most `MAX_LINEAGE_INDENT`), each parent collapsing on its
// own (a collapsed parent hides everything below it).
//
// Everywhere else (a different column, a different awaiting kind, or —
// sidebar-only — a parent that isn't open or a user-detached child) the
// child keeps its own repo group / position and gets a muted
// "↳ <parent title>" line instead (`parentTitle` on its row). This also
// gives "a Done parent's children stay attached to it" for free: the Done
// parent still reports its full child count (`children.count`), even
// though none of them render nested there once they're off in Working.
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

/** `launch.maxNestingDepth` default, for a caller that has not read the setting yet. */
export const DEFAULT_MAX_NESTING_DEPTH = 3;

/** The deepest indent drawn: a top-level row plus three nested levels (4 levels). */
export const MAX_LINEAGE_INDENT = 3;

/** Left margin for a row `indent` levels in (`stepPx` per level), never past `MAX_LINEAGE_INDENT` levels. */
export function lineageIndentPx(indent: number, stepPx: number): number {
  return Math.min(Math.max(indent, 0), MAX_LINEAGE_INDENT) * stepPx;
}

/** 1 for a top-level task, 2 for its children, and so on (cycle-safe; a missing parent ends the walk). */
export function taskDepth(task: Task, index: LineageIndex): number {
  let depth = 1;
  const seen = new Set<string>([task.id]);
  let parentId = task.parentTaskId;
  while (parentId && !seen.has(parentId)) {
    const parent = index.taskById.get(parentId);
    if (!parent) break;
    seen.add(parentId);
    depth++;
    parentId = parent.parentTaskId;
  }
  return depth;
}

/** Every task below `taskId`, at any depth (never `taskId` itself). */
export function descendantsOfTask(taskId: string, index: LineageIndex): Task[] {
  const result: Task[] = [];
  const seen = new Set<string>([taskId]);
  const queue = [taskId];
  for (let i = 0; i < queue.length; i++) {
    for (const child of index.childrenByParent.get(queue[i] as string) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      result.push(child);
      queue.push(child.id);
    }
  }
  return result;
}

/** Levels in the subtree rooted at `taskId`, counting itself (1 for a task with no children). */
export function subtreeHeightOf(taskId: string, index: LineageIndex): number {
  let height = 0;
  const seen = new Set<string>();
  let level = [taskId];
  while (level.length > 0) {
    height++;
    const next: string[] = [];
    for (const id of level) {
      seen.add(id);
      for (const child of index.childrenByParent.get(id) ?? []) {
        if (!seen.has(child.id)) next.push(child.id);
      }
    }
    level = next;
  }
  return height;
}

/**
 * How many task trees are deeper than `maxDepth` (Settings → Agents note,
 * docs/task-trees.md decision 9). A tree counts once, by its top-level task.
 */
export function treesDeeperThan(
  tasks: Iterable<Task>,
  maxDepth: number,
): number {
  const index = buildLineageIndex(tasks);
  const roots = new Set<string>();
  for (const task of index.taskById.values()) {
    if (taskDepth(task, index) <= maxDepth) continue;
    let root = task;
    const seen = new Set<string>([task.id]);
    while (root.parentTaskId && !seen.has(root.parentTaskId)) {
      const parent = index.taskById.get(root.parentTaskId);
      if (!parent) break;
      seen.add(parent.id);
      root = parent;
    }
    roots.add(root.id);
  }
  return roots.size;
}

/** The Settings → Agents note under "Max nesting depth" (decision 9); `undefined` when no tree is deeper. */
export function deeperTreesNote(count: number): string | undefined {
  if (count <= 0) return undefined;
  return count === 1
    ? "1 task tree is deeper than this; it's left as it is"
    : `${count} task trees are deeper than this; they're left as they are`;
}

/**
 * The tasks `task` may be re-parented under (core's `setTaskParent`), in
 * `pool` order: every non-archived task in `pool` that is not `task`, not
 * its current parent, not one of its own descendants (a cycle), and shallow
 * enough that the task's whole subtree still fits under `maxDepth`
 * (depth(candidate) + subtree height <= `maxDepth`).
 */
export function parentCandidates(
  task: Task,
  pool: Iterable<Task>,
  index: LineageIndex,
  maxDepth: number = DEFAULT_MAX_NESTING_DEPTH,
): Task[] {
  const below = new Set(descendantsOfTask(task.id, index).map((t) => t.id));
  const height = subtreeHeightOf(task.id, index);
  const candidates: Task[] = [];
  for (const other of pool) {
    if (
      other.id !== task.id &&
      other.id !== task.parentTaskId &&
      !other.archivedAt &&
      !below.has(other.id) &&
      taskDepth(other, index) + height <= maxDepth
    ) {
      candidates.push(other);
    }
  }
  return candidates;
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
  const taskOf = new Map<string, Task>();
  groups.forEach((group, index) => {
    for (const item of access.items(group)) {
      const task = access.task(item);
      groupOfTask.set(task.id, index);
      taskOf.set(task.id, task);
    }
  });
  const scopeOf = (index: number): string => {
    const group = groups[index];
    return group === undefined || !access.scope ? "" : access.scope(group);
  };
  // Where a task ends up: its parent's final group when the parent is in
  // another group of the same scope (so a grandchild follows its parent,
  // wherever that went), else its own. `visiting` stops a corrupt parent loop.
  const finalGroup = (taskId: string, visiting: Set<string>): number => {
    const own = groupOfTask.get(taskId) as number;
    const parentId = taskOf.get(taskId)?.parentTaskId;
    const parentGroup =
      parentId === undefined ? undefined : groupOfTask.get(parentId);
    if (
      parentId === undefined ||
      parentGroup === undefined ||
      visiting.has(parentId) ||
      scopeOf(parentGroup) !== scopeOf(own)
    ) {
      return own;
    }
    visiting.add(parentId);
    return finalGroup(parentId, visiting);
  };
  const staying: T[][] = groups.map(() => []);
  const incoming: T[][] = groups.map(() => []);
  let moved = false;
  groups.forEach((group, index) => {
    for (const item of access.items(group)) {
      const taskId = access.task(item).id;
      const host = finalGroup(taskId, new Set([taskId]));
      if (host !== index) {
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
  /** Direct children anywhere on the board (what the "N children" chip reports). */
  count: number;
  /** Whether the caller's saved set currently hides everything below this parent in the same group. */
  collapsed: boolean;
  /** Whether any of those children actually render nested here (false = every child is elsewhere; the chip still shows the count but has nothing to toggle). */
  nestedHere: boolean;
}

export interface LineageRow<T extends LineageItem> {
  item: T;
  /** Rendered indented, directly under its parent's own row. */
  nested: boolean;
  /** Indent levels, one per level below the group's top-level row, capped at `MAX_LINEAGE_INDENT`; 0 when not nested. */
  indent: number;
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
  const emitted = new Set<string>();
  const emit = (item: T, level: number): void => {
    const { task } = item;
    emitted.add(task.id);
    const row: LineageRow<T> = {
      item,
      nested: level > 0,
      indent: Math.min(level, MAX_LINEAGE_INDENT),
    };
    if (level === 0 && task.parentTaskId) {
      const parentTitle = index.taskById.get(task.parentTaskId)?.title;
      if (parentTitle) row.parentTitle = parentTitle;
    }
    const allChildren = index.childrenByParent.get(task.id) ?? [];
    if (allChildren.length === 0) {
      rows.push(row);
      return;
    }
    const nestedChildren = sortSiblings(
      allChildren.filter(
        (child) =>
          itemById.has(child.id) &&
          isNestedHere(child) &&
          !emitted.has(child.id),
      ),
      options.siblingOrder,
    );
    row.children = {
      count: allChildren.length,
      collapsed: collapsedParents.has(task.id),
      nestedHere: nestedChildren.length > 0,
    };
    rows.push(row);
    if (collapsedParents.has(task.id)) return;
    for (const child of nestedChildren) {
      const childItem = itemById.get(child.id);
      if (childItem) emit(childItem, level + 1);
    }
  };
  for (const item of items) {
    // Nested rows are emitted under their parent's row, not here.
    if (!isNestedHere(item.task)) emit(item, 0);
  }
  // A corrupt parent loop inside the group leaves no top-level row to hang
  // its members from: show them flat rather than lose them. (A task hidden
  // under a collapsed parent is not part of a loop and is skipped.)
  const hidden = hiddenNestedChildIds(items, collapsedParents, detached);
  for (const item of items) {
    if (!emitted.has(item.task.id) && !hidden.has(item.task.id)) emit(item, 0);
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
 * Task ids hidden from `items` right now because a parent above them in
 * the same group is collapsed (see `layoutLineageRows`) — reused by the
 * board's keyboard-selection grid (lib/board-selection.ts) so arrow-key
 * navigation never lands on a card that isn't actually on screen.
 */
export function hiddenNestedChildIds(
  items: readonly LineageItem[],
  collapsedParents: ReadonlySet<string>,
  detachedIds?: ReadonlySet<string>,
): Set<string> {
  const byId = new Map(items.map((item) => [item.task.id, item.task] as const));
  const hidden = new Set<string>();
  for (const item of items) {
    // Walk up through parents that are in this group (and not detached): any
    // collapsed one hides the task. A parent loop ends at the first repeat.
    const seen = new Set<string>([item.task.id]);
    let task: Task = item.task;
    while (
      task.parentTaskId &&
      !detachedIds?.has(task.id) &&
      !seen.has(task.parentTaskId)
    ) {
      const parent = byId.get(task.parentTaskId);
      if (!parent) break;
      if (collapsedParents.has(parent.id)) {
        hidden.add(item.task.id);
        break;
      }
      seen.add(parent.id);
      task = parent;
    }
  }
  return hidden;
}
