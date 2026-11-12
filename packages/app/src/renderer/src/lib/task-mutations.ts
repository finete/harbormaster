// Shared task-action rules + mutations: the pure "is this action allowed"
// checks and the IPC-calling mutations behind the three workflow verbs
// (Start/todev, Await…/toawait, Done/todone) plus Reopen (see
// TaskActions.tsx), extracted so Board.tsx's single-key shortcuts (s/r/x)
// and drag gestures drive the exact same path the buttons do — no second
// implementation to drift out of sync. Awaiting *kinds* (review, Slack,
// deployment) are data passed to the one await verb, never verbs here.
import type {
  AwaitingKindId,
  MoveTaskOptions,
  Task,
  TaskState,
  ToAwaitOptions,
  ToDoneForce,
} from "../../../preload/api";
import { requestConfirm } from "../confirm";
import { describeThrown, pushToast } from "../toast";

export function canStart(task: Pick<Task, "state">): boolean {
  return task.state === "backlog";
}

/** Whether the Await… picker applies (which kinds fit is core's call, per kind). */
export function canAwait(task: Pick<Task, "state">): boolean {
  return task.state === "dev" || task.state === "awaiting";
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

/** Await: move a task to Awaiting with the picked kind, running that kind's onEnter action in core. */
export async function toAwaitMutation(
  taskId: string,
  kindId: AwaitingKindId,
  options?: ToAwaitOptions,
): Promise<void> {
  try {
    await window.harbormaster.core.toAwait(taskId, kindId, options);
  } catch (error) {
    pushToast(describeThrown(error), "error");
  }
}

type TaskPanesClosingListener = (taskId: string) => void;
const panesClosingListeners = new Set<TaskPanesClosingListener>();

/**
 * A confirmed Done is about to end the processes in the task's worktree:
 * the app shell (App.tsx) closes the task's workspace so no pane is left
 * attached to a killed pty. Returns the unsubscribe.
 */
export function subscribeTaskPanesClosing(
  listener: TaskPanesClosingListener,
): () => void {
  panesClosingListeners.add(listener);
  return () => {
    panesClosingListeners.delete(listener);
  };
}

/** What the single Done question looks like (title, button), body lines from core. */
export const DONE_QUESTION = {
  title: "Mark done?",
  confirmLabel: "Mark done",
} as const;

/**
 * Move a task to Done (button, `x`, a drop on Done, an inbox action). One
 * small question, its lines computed by core up front (worktree removed,
 * uncommitted changes discarded, unmerged branch deleted, pane closed);
 * Enter confirms, cancel leaves the task untouched. A parent with active
 * children is asked about them first (a separate question: it is about
 * other tasks). Once confirmed Done is final: the worktree housekeeping is
 * the app's (core records `task.cleanup` and retries it), so nothing here
 * ever warns about it.
 */
export async function toDoneMutation(taskId: string): Promise<void> {
  try {
    const force: ToDoneForce = {};
    for (;;) {
      const result = await window.harbormaster.core.toDone(taskId, { force });
      // Landed. Cleanup outcomes live on `task.cleanup` (inbox item after
      // repeated failures), never in a toast.
      if (!("requiresConfirmation" in result)) return;
      if (result.requiresConfirmation === "activeChildren") {
        // Core asks this at most once (the answer accumulates); never loop.
        if (force.leaveChildren) {
          pushToast(result.detail, "error");
          return;
        }
        const confirmed = await requestConfirm({
          title: "Complete with active children?",
          message: `They keep running and stay nested under it once it's Done. (${result.detail})`,
          confirmLabel: "Complete anyway",
        });
        if (!confirmed) return;
        force.leaveChildren = true;
        continue;
      }
      if (force.confirmed) {
        pushToast(result.detail, "error");
        return;
      }
      const confirmed = await requestConfirm({
        title: DONE_QUESTION.title,
        message: "",
        lines: result.lines ?? [],
        enterConfirms: true,
        confirmLabel: DONE_QUESTION.confirmLabel,
      });
      if (!confirmed) return;
      if (result.closesPane) {
        for (const listener of panesClosingListeners) listener(taskId);
      }
      force.confirmed = true;
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
