// Shared task-action rules + mutations: the pure "is this action allowed"
// checks and the IPC-calling mutations behind Start/To review/Done (see
// TaskActions.tsx), extracted so Board.tsx's single-key shortcuts (s/r/x)
// drive the exact same path the buttons do — no second implementation to
// drift out of sync.
import type {
  MoveTaskOptions,
  Task,
  TaskState,
  ToDoneConfirmation,
  ToDoneForce,
} from "../../../preload/api";
import { requestConfirm } from "../confirm";
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

export function canReopen(task: Pick<Task, "state">): boolean {
  return task.state === "done";
}

/** A plain column move (drag-and-drop); a rejected move surfaces as an error toast. */
export async function moveTaskMutation(
  taskId: string,
  state: TaskState,
  options?: MoveTaskOptions,
): Promise<void> {
  try {
    await window.harbormaster.core.moveTask(taskId, state, options);
  } catch (error) {
    pushToast(describeThrown(error), "error");
  }
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

/** pi-home's completion questions (presentation/flows.ts `completeWork`). */
const DONE_QUESTIONS: Record<
  ToDoneConfirmation["requiresConfirmation"],
  { title: string; confirmLabel: string; flag: keyof ToDoneForce }
> = {
  dirty: {
    title: "Discard uncommitted changes?",
    confirmLabel: "Remove anyway",
    flag: "removeDirty",
  },
  unmerged: {
    title: "Delete unmerged task workspace?",
    confirmLabel: "Delete anyway",
    flag: "deleteUnmerged",
  },
};

const DONE_MESSAGES: Record<
  ToDoneConfirmation["requiresConfirmation"],
  string
> = {
  dirty: "The worktree has uncommitted changes — remove it anyway?",
  unmerged:
    "The branch isn't merged — delete the worktree and local branch anyway?",
};

/**
 * Move a task to Done (button, `x`, or a drop on Done). Destroying work is
 * confirmed first, exactly like pi-home: core answers with a question
 * (uncommitted changes, then an unmerged branch) without moving the task;
 * each confirm re-asks with the accumulated answers, any cancel leaves the
 * task untouched. The landed result's warning surfaces as a toast.
 */
export async function toDoneMutation(taskId: string): Promise<void> {
  try {
    const force: ToDoneForce = {};
    for (;;) {
      const result = await window.harbormaster.core.toDone(taskId, { force });
      if (!("requiresConfirmation" in result)) {
        if (result.warning) pushToast(result.warning, "warning");
        return;
      }
      const question = DONE_QUESTIONS[result.requiresConfirmation];
      // The same question twice means core refused despite the answer;
      // never loop on it.
      if (force[question.flag]) {
        pushToast(result.detail, "error");
        return;
      }
      const confirmed = await requestConfirm({
        title: question.title,
        message: `${DONE_MESSAGES[result.requiresConfirmation]} (${result.detail})`,
        confirmLabel: question.confirmLabel,
      });
      if (!confirmed) return;
      force[question.flag] = true;
    }
  } catch (error) {
    pushToast(describeThrown(error), "error");
  }
}

/**
 * Reopen a Done task as a new Dev cycle (see `CoreCommands.reopenTask`):
 * failures and the "previous conversation not found" warning both surface
 * as toasts; the board updates from the next `board-changed` push.
 */
export async function reopenTaskMutation(
  taskId: string,
  objective: string,
): Promise<void> {
  try {
    const result = await window.harbormaster.core.reopenTask(
      taskId,
      objective ? { objective } : {},
    );
    if (result.warning) pushToast(result.warning, "warning");
  } catch (error) {
    pushToast(describeThrown(error), "error");
  }
}
