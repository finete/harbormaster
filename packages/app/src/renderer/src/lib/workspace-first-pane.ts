// What a task workspace shows before its first pane exists (TaskWorkspace):
// nothing yet, the Resume empty state, or the first pane itself. Pure, so
// the empty-state-vs-pane cases (a Done task, the resume in flight, a
// restore racing the board store) are pinned by a table test.

import type { TaskState } from "../../../preload/api";

/**
 * - `wait`: show nothing yet (binding not read, or read for a state the
 *   task has since left).
 * - `resume`: a Done task with nothing to run in: the Resume empty state,
 *   kept while a resume is landing.
 * - `create`: create the first pane in `cwd` (a plain shell without one).
 */
export type FirstPane = "wait" | "resume" | "create";

export function firstPane(input: {
  /** The task's state on the board; `undefined` until the board has the task. */
  taskState: TaskState | undefined;
  /** The task state the binding was read for; `null` until the first read lands. */
  readFor: TaskState | undefined | null;
  /** The worktree that read found, if any. */
  cwd: string | undefined;
}): FirstPane {
  const { taskState, readFor, cwd } = input;
  if (readFor === null) return "wait";
  // A workspace restored at launch can read its binding before the board
  // store fills: a Done task read as "no state" must not get a shell.
  const fresh = taskState !== undefined && readFor === taskState;
  if (fresh) return !cwd && taskState === "done" ? "resume" : "create";
  // Resumed (the board says Working) but the new worktree isn't read yet:
  // keep the Resume empty state, never a shell from the Done read.
  return !cwd && readFor === "done" ? "resume" : "wait";
}
