// Engine: stateless board-transition rules. Shared by the Manager and (once
// it exists) mover automation; no I/O, no session state — pure business
// rule, which is exactly what makes it an Engine rather than Manager logic.

import type { TaskState } from "../contracts/model.js";

const ALLOWED_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  backlog: ["dev", "done"], // done from backlog = discarding a parked idea
  dev: ["backlog", "awaiting", "done"],
  awaiting: ["dev", "done"],
  done: ["dev"],
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
