// Shared task-action rules + mutations: the pure "is this action allowed"
// checks and the IPC-calling mutations behind Start/To review/Done (see
// TaskActions.tsx), extracted so Board.tsx's single-key shortcuts (s/r/x)
// drive the exact same path the buttons do — no second implementation to
// drift out of sync.
import type { Task } from "../../../preload/api";
import { describeThrown, pushToast } from "../toast";

export function canStart(task: Pick<Task, "state">): boolean {
  return task.state === "backlog";
}

export function canReview(
  task: Pick<Task, "repositoryId" | "branch" | "state">,
): boolean {
  return (
    Boolean(task.repositoryId && task.branch) &&
    (task.state === "dev" || task.state === "awaiting")
  );
}

export function canDone(task: Pick<Task, "state">): boolean {
  return task.state !== "done";
}

/** Start: create the branch + worktree and move a backlog task to Dev. */
export async function startTaskMutation(taskId: string): Promise<void> {
  try {
    await window.harbormaster.core.startTask(taskId);
  } catch (error) {
    pushToast(describeThrown(error), "error");
  }
}

/** Move a task to the "awaiting review" column (reason defaults to plain review, same as the button). */
export async function toReviewMutation(taskId: string): Promise<void> {
  try {
    await window.harbormaster.core.toReview(taskId);
  } catch (error) {
    pushToast(describeThrown(error), "error");
  }
}

/** Move a task to Done; surfaces `toDone`'s returned warning the same way the button does. */
export async function toDoneMutation(taskId: string): Promise<void> {
  try {
    const result = await window.harbormaster.core.toDone(taskId);
    if (result.warning) pushToast(result.warning, "warning");
  } catch (error) {
    pushToast(describeThrown(error), "error");
  }
}
