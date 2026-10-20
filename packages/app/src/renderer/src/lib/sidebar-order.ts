// Pure ordering + drag-projection logic for the workspace sidebar's fixed,
// user-owned rail order (ai/prds/sidebar-ordering.md). No React, no
// `window`: Sidebar.tsx feeds these functions and commits what they return
// once, on drop. Covered by tests/sidebar-order.test.ts.

/** Nested-row indent in px (`ml-3` + `pl-1`): the horizontal drag distance that flips attach/detach (R14). */
export const NEST_INDENT_PX = 16;

/** Sortable ids are namespaced so a task id can never collide with a group label (R7). */
export function taskSortableId(taskId: string): string {
  return `task:${taskId}`;
}
export function groupSortableId(label: string): string {
  return `group:${label}`;
}
export function parseSortableId(
  id: string | number,
): { kind: "task" | "group"; value: string } | null {
  const text = String(id);
  if (text.startsWith("task:")) return { kind: "task", value: text.slice(5) };
  if (text.startsWith("group:")) return { kind: "group", value: text.slice(6) };
  return null;
}

/**
 * Stable sort of `items` by the index of their id in `order`. Ids missing
 * from `order` sort after every known id, keeping their input order (R2/R3).
 */
export function sortByOrder<T>(
  items: readonly T[],
  order: readonly string[],
  getId: (item: T) => string,
): T[] {
  const index = new Map<string, number>();
  order.forEach((id, i) => {
    if (!index.has(id)) index.set(id, i);
  });
  return items
    .map((item, position) => ({ item, position }))
    .sort((a, b) => {
      const ai = index.get(getId(a.item));
      const bi = index.get(getId(b.item));
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      return a.position - b.position;
    })
    .map(({ item }) => item);
}

/** `order` with `id` appended unless already present (open-a-task path, R3). Returns the same array when unchanged. */
export function appendToOrder(
  order: readonly string[],
  id: string,
): readonly string[] {
  return order.includes(id) ? order : [...order, id];
}

/** `order` without `id` (close-a-task path, R4). Returns the same array when unchanged. */
export function removeFromOrder(
  order: readonly string[],
  id: string,
): readonly string[] {
  return order.includes(id) ? order.filter((entry) => entry !== id) : order;
}

/**
 * Writes a reordered subset back into the full stored order: the ids of
 * `newSequence` take over, in their new order, exactly the slots the same
 * ids occupied in the full list, so every id outside the subset (other
 * sections, stale entries) keeps its place. `present` is every currently
 * rendered id in default order; ones the store does not know yet are
 * appended first so the result is a complete list.
 */
export function mergeSectionOrder(
  stored: readonly string[],
  present: readonly string[],
  newSequence: readonly string[],
): string[] {
  const full: string[] = [];
  const seen = new Set<string>();
  for (const id of [...stored, ...present]) {
    if (seen.has(id)) continue;
    seen.add(id);
    full.push(id);
  }
  const subset = new Set(newSequence);
  const queue = newSequence.filter((id) => seen.has(id));
  const result = [...full];
  let next = 0;
  full.forEach((id, slot) => {
    if (subset.has(id)) result[slot] = queue[next++] as string;
  });
  return result;
}

/** dnd-kit-compatible `arrayMove` (remove at `from`, insert at `to`), kept local so this module stays pure. */
export function moveItem<T>(
  items: readonly T[],
  from: number,
  to: number,
): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}

export function sameSequence(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** One row of a section's fully expanded layout (collapse state ignored). */
export interface SectionRow {
  id: string;
  /** Rendered nested under its parent right now. */
  nested: boolean;
  /** The real parent task id when that parent is in this same section (nested or detached children), else undefined. */
  parentId?: string | undefined;
}

/**
 * The rows visible while `activeId` is dragged (R10/R15): every top-level
 * row, plus only the nested rows of the dragged child's own parent block.
 * The dragged row's own children and every other block are hidden, so each
 * visible row is either top-level or a sibling of the dragged child.
 */
export function dragVisibleRows(
  full: readonly SectionRow[],
  activeId: string,
): SectionRow[] {
  const ownParent = full.find((row) => row.id === activeId)?.parentId;
  return full.filter(
    (row) =>
      !row.nested || (ownParent !== undefined && row.parentId === ownParent),
  );
}

export interface TaskDropProjection {
  /** The section's new full sequence (each top-level row followed by its attached children). */
  sequence: string[];
  /** Whether the dragged row is nested under its parent after the drop; null when it has no parent in this section. */
  attached: boolean | null;
  /** False when the drop equals the current order and attachment (R19). */
  changed: boolean;
}

/**
 * Projects dropping `activeId` over `overId` (ids of rows in
 * `dragVisibleRows(full, activeId)`) with horizontal pointer offset
 * `offsetX` (R10–R15, R19). Returns null when either id is not visible.
 */
export function projectTaskDrop(
  full: readonly SectionRow[],
  activeId: string,
  overId: string,
  offsetX: number,
  indent: number = NEST_INDENT_PX,
): TaskDropProjection | null {
  const visible = dragVisibleRows(full, activeId);
  const from = visible.findIndex((row) => row.id === activeId);
  const to = visible.findIndex((row) => row.id === overId);
  if (from < 0 || to < 0) return null;
  const activeRow = visible[from] as SectionRow;
  const parent = activeRow.parentId;
  const moved = moveItem(visible, from, to);
  const prev = moved[to - 1];
  const next = moved[to + 1];

  let attached: boolean | null = null;
  if (parent !== undefined) {
    attached = false;
    const afterParentOrSibling =
      !!prev &&
      (prev.id === parent || (prev.nested && prev.parentId === parent));
    if (afterParentOrSibling) {
      const beforeSibling = !!next && next.nested && next.parentId === parent;
      if (beforeSibling) attached = true;
      else attached = activeRow.nested ? offsetX > -indent : offsetX >= indent;
    }
  }

  const movedIds = new Set(moved.map((row) => row.id));
  const sequence: string[] = [];
  for (const row of moved) {
    sequence.push(row.id);
    const isTop = row.id === activeId ? attached !== true : !row.nested;
    if (!isTop) continue;
    for (const child of full) {
      if (
        child.nested &&
        child.parentId === row.id &&
        !movedIds.has(child.id)
      ) {
        sequence.push(child.id);
      }
    }
  }
  const changed =
    !sameSequence(
      sequence,
      full.map((row) => row.id),
    ) ||
    (attached !== null && attached !== activeRow.nested);
  return { sequence, attached, changed };
}

/** Group reorder projection (R17/R19): new label order, or null for a no-op. */
export function projectGroupDrop(
  labels: readonly string[],
  activeLabel: string,
  overLabel: string,
): string[] | null {
  const from = labels.indexOf(activeLabel);
  const to = labels.indexOf(overLabel);
  if (from < 0 || to < 0 || from === to) return null;
  return moveItem(labels, from, to);
}
