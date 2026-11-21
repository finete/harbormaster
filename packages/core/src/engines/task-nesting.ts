// Engine: the nesting-depth rules over task trees (see /docs/task-trees.md
// decisions 7 to 10). Pure: the manager hands in the task list and the
// `launch.maxNestingDepth` value, and gets back a verdict. An Engine per
// /docs/design-decisions.md "Layering".

import type { Task } from "../contracts/model.js";
import {
  childrenIndex,
  depthOf,
  descendantsOf,
  indexTasks,
  rootOf,
  subtreeHeight,
  type TreeTask,
} from "./task-tree.js";

/** The message a `child` launch gets from a task already at the max depth. */
export function maxDepthMessage(maxDepth: number): string {
  return `you're at the max nesting depth (${maxDepth}); do the work yourself or launch a standalone task`;
}

/**
 * Whether `launcher` may have a child under `maxDepth`: refused only when
 * the launcher is already at the max depth. Returns the refusal, or
 * `undefined` when allowed.
 */
export function childLaunchRefusal<T extends TreeTask>(
  launcher: T,
  tasks: readonly T[],
  maxDepth: number,
): string | undefined {
  return depthOf(launcher, indexTasks(tasks)) >= maxDepth
    ? maxDepthMessage(maxDepth)
    : undefined;
}

/** True when a task at `depth` cannot launch children under `maxDepth`. */
export function atMaxDepth(depth: number, maxDepth: number): boolean {
  return depth >= maxDepth;
}

/**
 * Whether `task` (with its whole subtree) may move under `newParent`: refused
 * when `newParent` is `task` itself or one of its descendants (a cycle), or
 * when depth(newParent) + subtreeHeight(task) would exceed `maxDepth`.
 * Returns the refusal, or `undefined` when allowed.
 */
export function reparentRefusal<
  T extends Pick<Task, "id" | "parentTaskId" | "title">,
>(
  task: T,
  newParent: T,
  tasks: readonly T[],
  maxDepth: number,
): string | undefined {
  if (newParent.id === task.id) return "A task cannot be its own parent";
  const children = childrenIndex(tasks);
  if (descendantsOf(task.id, children).some((d) => d.id === newParent.id)) {
    return `${newParent.title} is below ${task.title}; a task cannot be nested under its own subtask`;
  }
  const levels =
    depthOf(newParent, indexTasks(tasks)) + subtreeHeight(task.id, children);
  if (levels > maxDepth) {
    return `Nesting ${task.title} under ${newParent.title} would make the tree ${levels} levels deep; the max nesting depth is ${maxDepth}`;
  }
  return undefined;
}

/**
 * How many task trees are deeper than `maxDepth` (the Settings row's note,
 * decision 9). A tree is counted once, by its top-level task.
 */
export function treesDeeperThan<T extends TreeTask>(
  tasks: readonly T[],
  maxDepth: number,
): number {
  const byId = indexTasks(tasks);
  const roots = new Set<string>();
  for (const task of tasks) {
    if (depthOf(task, byId) > maxDepth) roots.add(rootOf(task, byId).id);
  }
  return roots.size;
}
