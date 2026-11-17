// Code review via Plannotator (docs/plannotator.md), renderer side: when
// the Review button is enabled, which target it defaults to, what a review
// tab shows while it waits for a session (`reviewWaitState`), and the
// shared `reviewSupport` store (re-checked on window focus).
// The decisions are pure functions (tests/review.test.ts).

import { useSyncExternalStore } from "react";
import type {
  ReviewRequestResult,
  ReviewSupport,
  ReviewSupportHarness,
  Task,
} from "../../../preload/api";
import { describeThrown, pushToast } from "../toast";
import { DEFAULT_HARNESS_ID } from "./harnesses";
import { createSharedStore } from "./shared-store";
import { taskUrls } from "./task-urls";

/** Where the code review row lives (decision 5, Code review step of the wizard). */
export const REVIEW_SETUP_HINT = "Set up code review in Settings → Code review";

export type ReviewTargetKind = "local" | "pr";

/** The task's agent (tasks from before agents were recorded ran Pi). */
export function taskHarness(task: Pick<Task, "harness">): string {
  return task.harness ?? DEFAULT_HARNESS_ID;
}

export function harnessSupport(
  support: ReviewSupport | null,
  harness: string,
): ReviewSupportHarness | undefined {
  return support?.harnesses.find((entry) => entry.harness === harness);
}

/** Decision 4: the task's PR when it has one, else local changes. */
export function defaultReviewTarget(task: Pick<Task, "pr">): ReviewTargetKind {
  return task.pr?.url ? "pr" : "local";
}

/**
 * Why the Review button is disabled, or `undefined` when it is enabled:
 * no support listing yet, a harness without a review command, or
 * Plannotator not ready for it. Mid-turn stays enabled: main queues the
 * review until the agent finishes its turn (docs/plannotator.md "Transport").
 */
export function reviewDisabledReason(input: {
  support: ReviewSupport | null;
  harness: string;
}): string | undefined {
  if (!input.support) return "Checking code review support…";
  const entry = harnessSupport(input.support, input.harness);
  if (!entry || entry.state === "unsupported") {
    return entry?.reason ?? "This agent cannot start a code review";
  }
  if (entry.state !== "ready") return REVIEW_SETUP_HINT;
  return undefined;
}

// --- the review tab while it waits for a session ----------------------------------

/** No `task-url-opened` this long after a request (or after a queued review's agent stopped working): "No review session appeared". */
export const REVIEW_WAIT_TIMEOUT_MS = 60_000;

/** The latest Review / Review again / Try again for a task, until its session's URL arrives. */
export interface ReviewRequest {
  /** `Date.now()` of the click. */
  at: number;
  target?: ReviewTargetKind;
  /** The task's agent (for the setup hint). */
  harness: string;
  /** How main delivered it; absent while the request is in flight. */
  delivery?: ReviewRequestResult["delivery"];
  command?: string;
  /** The request itself failed (a toast said why). */
  failed?: boolean;
  /** The agent answered "Unknown command" to the typed command (main watched its pty). */
  rejected?: boolean;
}

/**
 * What a review tab without a session URL shows:
 * - `queued`: main holds the command until the agent finishes its turn;
 * - `starting`: delivered (or in flight), waiting for the session's URL;
 * - `rejected`: the agent said it does not know the command;
 * - `no-session`: nothing appeared within `REVIEW_WAIT_TIMEOUT_MS` (counted
 *   from `clockFrom`: the click, or when a queued review's agent last
 *   started/stopped working), the request failed, or there is no request
 *   at all (a tab restored without its session).
 */
export type ReviewWaitState = "queued" | "starting" | "rejected" | "no-session";

export function reviewWaitState(input: {
  request: ReviewRequest | undefined;
  clockFrom: number;
  now: number;
  agentWorking: boolean;
}): ReviewWaitState {
  const { request } = input;
  if (request?.rejected) return "rejected";
  if (!request || request.failed) return "no-session";
  if (request.delivery === "queued" && input.agentWorking) return "queued";
  return input.now - Math.max(request.at, input.clockFrom) >=
    REVIEW_WAIT_TIMEOUT_MS
    ? "no-session"
    : "starting";
}

let requests: Readonly<Record<string, ReviewRequest>> = {};
const requestListeners = new Set<() => void>();
function setRequest(taskId: string, request: ReviewRequest): void {
  requests = { ...requests, [taskId]: request };
  for (const listener of Array.from(requestListeners)) listener();
}

/** The task's latest review request (see `ReviewRequest`). */
export function useReviewRequest(taskId: string): ReviewRequest | undefined {
  return useSyncExternalStore(
    (listener) => {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    },
    () => requests[taskId],
  );
}

/**
 * The agent rejected a typed review command (main's `core:review-rejected`):
 * marks the task's current request, if it is the one that was typed, and
 * re-probes review support so the Review button and Setup reflect it.
 * Mounted once for the app's lifetime (App).
 */
export function startReviewRejectedListener(): () => void {
  return window.harbormaster.core.onReviewRejected(({ taskId, command }) => {
    const request = requests[taskId];
    if (request && (!request.command || request.command === command)) {
      setRequest(taskId, { ...request, rejected: true });
    }
    recheckReviewSupport();
  });
}

/**
 * The one way the app starts a review (the Review button, Review again,
 * Try again): create or focus the task's review tab (decision 2), then ask
 * main, which types the command or queues it (docs/plannotator.md
 * "Transport"). The tab's placeholder follows the recorded request.
 */
export async function startReview(
  taskId: string,
  options: { target?: ReviewTargetKind; harness: string },
): Promise<void> {
  const request: ReviewRequest = {
    at: Date.now(),
    harness: options.harness,
    ...(options.target ? { target: options.target } : {}),
  };
  setRequest(taskId, request);
  taskUrls.requestReviewTab(taskId);
  try {
    const result = await window.harbormaster.core.requestReview({
      taskId,
      ...(options.target ? { target: options.target } : {}),
    });
    if (requests[taskId] === request) {
      setRequest(taskId, {
        ...request,
        delivery: result.delivery,
        command: result.command,
      });
    }
  } catch (error) {
    if (requests[taskId] === request) {
      setRequest(taskId, { ...request, failed: true });
    }
    pushToast(`Review failed: ${describeThrown(error)}`);
  }
}

// --- shared stores --------------------------------------------------------------

let reloadSupport: ((refresh: boolean) => void) | undefined;
const supportStore = createSharedStore<ReviewSupport | null>(null, (set) => {
  const load = (refresh: boolean): void => {
    void window.harbormaster.core
      .reviewSupport(refresh ? { refresh: true } : undefined)
      .then(set)
      .catch(() => {});
  };
  load(false);
  // Decision 5: re-checked when the user comes back (after installing).
  const onFocus = (): void => load(true);
  window.addEventListener("focus", onFocus);
  reloadSupport = load;
  return () => {
    reloadSupport = undefined;
    window.removeEventListener("focus", onFocus);
  };
});

/** Re-probe now (the Settings "Recheck"). */
export function recheckReviewSupport(): void {
  reloadSupport?.(true);
}

/** Per-harness Plannotator status (shared; refreshed on window focus). */
export function useReviewSupport(): ReviewSupport | null {
  return useSyncExternalStore(supportStore.subscribe, supportStore.getSnapshot);
}
