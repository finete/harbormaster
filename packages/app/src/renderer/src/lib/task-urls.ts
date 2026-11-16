// Agent-opened local URLs in a task's dockview (docs/plannotator.md,
// decisions 2/3/6). Core's `task-url-opened` push and the Review button both
// queue an "open" for a task here; the task's `TaskWorkspace` applies its
// queue once it is mounted (a task whose workspace was never opened keeps
// its queue until it is). Event-driven opens never take focus or switch
// view; the review tab in the task's workspace is the only indication (no
// sidebar mark: it outlived closed or never-started reviews). Pure state transitions + a tiny module store, so the rules are
// unit-testable in node (tests/task-urls.test.ts).

import { useSyncExternalStore } from "react";
import type { TaskUrlOpenedPayload } from "../../../preload/api";

/** One queued open: the task's single review tab, or a preview tab. */
export type TaskUrlOpen =
  | {
      kind: "review";
      /** Absent: a review was just requested, the URL is not known yet. */
      url?: string;
      /** Only the Review button focuses (decision 2). */
      focus: boolean;
    }
  | { kind: "preview"; url: string };

export interface TaskUrlState {
  /** Opens not yet applied by the task's workspace, oldest first. */
  pending: Readonly<Record<string, readonly TaskUrlOpen[]>>;
}

export const EMPTY_TASK_URL_STATE: TaskUrlState = { pending: {} };

/** The dockview panel id of a task's one review tab. */
export function reviewPanelId(taskId: string): string {
  return `review:${taskId}`;
}

function enqueue(
  state: TaskUrlState,
  taskId: string,
  open: TaskUrlOpen,
): TaskUrlState["pending"] {
  return {
    ...state.pending,
    [taskId]: [...(state.pending[taskId] ?? []), open],
  };
}

/** Core's `task-url-opened`: a Plannotator URL navigates the review tab; anything else is a preview tab. */
export function applyUrlOpened(
  state: TaskUrlState,
  payload: TaskUrlOpenedPayload,
): TaskUrlState {
  if (payload.source === "plannotator") {
    return {
      pending: enqueue(state, payload.taskId, {
        kind: "review",
        url: payload.url,
        focus: false,
      }),
    };
  }
  return {
    ...state,
    pending: enqueue(state, payload.taskId, {
      kind: "preview",
      url: payload.url,
    }),
  };
}

/** The Review button: create or focus the review tab, showing "starting" until the URL arrives. */
export function applyReviewRequested(
  state: TaskUrlState,
  taskId: string,
): TaskUrlState {
  return {
    ...state,
    pending: enqueue(state, taskId, { kind: "review", focus: true }),
  };
}

/** The workspace applied the task's queue. */
export function takePending(state: TaskUrlState, taskId: string): TaskUrlState {
  if (!state.pending[taskId]) return state;
  const { [taskId]: _taken, ...rest } = state.pending;
  return { ...state, pending: rest };
}

// --- module store -------------------------------------------------------------

let current: TaskUrlState = EMPTY_TASK_URL_STATE;
const listeners = new Set<() => void>();

function set(next: TaskUrlState): void {
  if (next === current) return;
  current = next;
  for (const listener of Array.from(listeners)) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = (): TaskUrlState => current;

/**
 * Listens to core's `task-url-opened` for the app's lifetime (App mounts it
 * once). Not ref-counted on subscribers: an open for a task nobody renders
 * yet must still be queued.
 */
export function startTaskUrlListener(): () => void {
  return window.harbormaster.core.onTaskUrlOpened((payload) =>
    set(applyUrlOpened(current, payload)),
  );
}

export function useTaskUrls(): TaskUrlState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export const taskUrls = {
  requestReviewTab: (taskId: string): void =>
    set(applyReviewRequested(current, taskId)),
  take: (taskId: string): void => set(takePending(current, taskId)),
};
