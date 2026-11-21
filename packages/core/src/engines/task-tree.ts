// Engine: pure task-tree queries over `parentTaskId` links (see
// /docs/task-trees.md). A top-level task (no `parentTaskId`) is depth 1;
// a task tree is a top-level task and everything below it. No I/O. Every
// walk is cycle-safe: a corrupt state file with a parent loop ends the walk
// instead of spinning. An Engine per /docs/design-decisions.md "Layering".

import type { Task } from "../contracts/model.js";

/** The lineage fields the tree queries read. */
export type TreeTask = Pick<Task, "id" | "parentTaskId">;

/** Lookup by id over a task list (build once, reuse across queries). */
export function indexTasks<T extends TreeTask>(
  tasks: readonly T[],
): Map<string, T> {
  return new Map(tasks.map((task) => [task.id, task]));
}

/**
 * The task's ancestors, nearest first (parent, grandparent, …). A parent id
 * that is not in `byId` ends the walk (a deleted parent). Never includes
 * the task itself.
 */
export function ancestorsOf<T extends TreeTask>(
  task: T,
  byId: ReadonlyMap<string, T>,
): T[] {
  const result: T[] = [];
  const seen = new Set<string>([task.id]);
  let parentId = task.parentTaskId;
  while (parentId !== undefined && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) break;
    result.push(parent);
    seen.add(parentId);
    parentId = parent.parentTaskId;
  }
  return result;
}

/** 1 for a top-level task, 2 for its children, and so on. */
export function depthOf<T extends TreeTask>(
  task: T,
  byId: ReadonlyMap<string, T>,
): number {
  return ancestorsOf(task, byId).length + 1;
}

/** The top-level task of the task's tree (the task itself when top-level). */
export function rootOf<T extends TreeTask>(
  task: T,
  byId: ReadonlyMap<string, T>,
): T {
  const ancestors = ancestorsOf(task, byId);
  return ancestors[ancestors.length - 1] ?? task;
}

/** True when both tasks have the same top-level ancestor. */
export function inSameTree<T extends TreeTask>(
  a: T,
  b: T,
  byId: ReadonlyMap<string, T>,
): boolean {
  return rootOf(a, byId).id === rootOf(b, byId).id;
}

/** Children by parent id (build once over the whole task list). */
export function childrenIndex<T extends TreeTask>(
  tasks: readonly T[],
): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const task of tasks) {
    if (task.parentTaskId === undefined) continue;
    const siblings = index.get(task.parentTaskId);
    if (siblings) siblings.push(task);
    else index.set(task.parentTaskId, [task]);
  }
  return index;
}

/** Every task below `taskId`, at any depth, breadth-first; never `taskId` itself. */
export function descendantsOf<T extends TreeTask>(
  taskId: string,
  children: ReadonlyMap<string, readonly T[]>,
): T[] {
  const result: T[] = [];
  const seen = new Set<string>([taskId]);
  const queue: string[] = [taskId];
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i] as string) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      result.push(child);
      queue.push(child.id);
    }
  }
  return result;
}

/**
 * Levels in the subtree rooted at `taskId`, counting the task itself: 1 for
 * a task with no children, 2 when it has children but no grandchildren, …
 */
export function subtreeHeight<T extends TreeTask>(
  taskId: string,
  children: ReadonlyMap<string, readonly T[]>,
): number {
  let height = 0;
  const seen = new Set<string>();
  let level: string[] = [taskId];
  while (level.length > 0) {
    height++;
    const next: string[] = [];
    for (const id of level) {
      seen.add(id);
      for (const child of children.get(id) ?? []) {
        if (!seen.has(child.id)) next.push(child.id);
      }
    }
    level = next;
  }
  return height;
}
