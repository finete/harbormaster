// Engine: stateless board-transition rules. Shared by the Manager and (once
// it exists) mover automation; no I/O, no session state — pure business
// rule, which is exactly what makes it an Engine rather than Manager logic.

import type { AwaitingKind, TaskState } from "../contracts/model.js";

const ALLOWED_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  backlog: ["working", "done"], // done from backlog = discarding a parked idea
  working: ["backlog", "awaiting", "done"],
  awaiting: ["working", "done"],
  done: ["working"],
};

export function isAllowedTransition(from: TaskState, to: TaskState): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertAllowedTransition(from: TaskState, to: TaskState): void {
  if (!isAllowedTransition(from, to)) {
    throw new Error(`Cannot move a task from "${from}" to "${to}"`);
  }
}

/**
 * pi-home's `developmentDisposition`: merged work waiting on a deployment is
 * historical — sending it back to Working would re-enter the pipeline at its
 * first stage on the next refresh (the merged PR is still merged). Continuing
 * it requires a follow-up task.
 */
export function assertMayReturnToWorking(
  from: TaskState,
  awaiting: AwaitingKind | undefined,
  to: TaskState,
): void {
  if (from === "awaiting" && awaiting?.kind === "deploy" && to === "working") {
    throw new Error(
      "A task awaiting deployment cannot return to Working (its PR is already merged); create a follow-up task instead",
    );
  }
}
