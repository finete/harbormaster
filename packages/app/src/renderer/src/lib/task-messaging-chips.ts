// Pure derivation of the task-messaging chips a TaskCard/SidebarTaskRow
// shows (see /docs/task-messaging.md decisions 8-10): "message awaiting
// approval", "child asked a question", "message cap reached", and the
// neutral "waiting on parent" state with its question line. Kept free of
// React so it is unit-testable without a DOM (see
// tests/task-messaging-chips.test.ts).
//
// "Waiting on parent" suppresses the amber "your move" attention styling
// while it lasts. Its deadline (`expiresAt`) is core's, but evaluated here
// against the renderer's own clock (`use-now`), so the amber state returns
// by itself the moment it passes, with no push needed.
import type { TaskMessagingState } from "../../../preload/api";

export interface MessagingChips {
  /** Messages to this task awaiting the user's approval (0 = no chip). */
  approvalsWaiting: number;
  /** On a parent: children's questions still waiting on it (0 = no chip). */
  childQuestionsWaiting: number;
  /** A parent-child pair involving this task is at the loop cap. */
  loopCapReached?: { otherTaskId: string; count: number; cap: number };
  /** Active "waiting on parent" state: the neutral badge plus the question as a muted secondary line. */
  waitingOnParent?: { question: string };
  /** True while `waitingOnParent` is active: the task must not show amber "your move". */
  suppressAttention: boolean;
}

/**
 * Whether a waiting-on-parent state is still in force at `nowMs`: no
 * deadline yet (the question is not delivered to the parent), or the
 * deadline lies in the future. An unparsable deadline counts as expired so
 * a corrupt value can never mute attention forever.
 */
export function isWaitingOnParentActive(
  waiting: NonNullable<TaskMessagingState["waitingOnParent"]>,
  nowMs: number,
): boolean {
  if (waiting.expiresAt === undefined) return true;
  const expiresMs = Date.parse(waiting.expiresAt);
  if (Number.isNaN(expiresMs)) return false;
  return expiresMs > nowMs;
}

/** The chips for one task's messaging state at `nowMs` (undefined state = nothing to show). */
export function deriveMessagingChips(
  state: TaskMessagingState | undefined,
  nowMs: number,
): MessagingChips {
  const waiting =
    state?.waitingOnParent &&
    isWaitingOnParentActive(state.waitingOnParent, nowMs)
      ? state.waitingOnParent
      : undefined;
  return {
    approvalsWaiting: state?.approvalsWaiting ?? 0,
    childQuestionsWaiting: state?.childQuestionsWaiting ?? 0,
    ...(state?.loopCapReached ? { loopCapReached: state.loopCapReached } : {}),
    ...(waiting ? { waitingOnParent: { question: waiting.question } } : {}),
    suppressAttention: waiting !== undefined,
  };
}

/** Tooltip/label text for the loop-cap chip. */
export function loopCapLabel(cap: { count: number; cap: number }): string {
  return `message cap reached (${cap.count}/${cap.cap}): ask the user`;
}
