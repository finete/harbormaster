// Code review via Plannotator (docs/plannotator.md), renderer side: when
// the Review button is enabled, which target it defaults to, what a review
// tab shows while it waits for a session (`reviewWaitState`), which tasks
// get the quiet "Ready to review" hint, and the shared stores behind them
// (`reviewSupport`, re-checked on window focus; idle Dev tasks' worktree
// dirtiness, read from core's refresh-tick pass on presence pushes and
// after every refresh tick).
// The decisions are pure functions (tests/review.test.ts).

import { useEffect, useRef, useSyncExternalStore } from "react";
import type {
  PresenceBadge,
  PresenceChangedPayload,
  ReviewRequestResult,
  ReviewSupport,
  ReviewSupportHarness,
  Task,
} from "../../../preload/api";
import { describeThrown, pushToast } from "../toast";
import { createSharedStore } from "./shared-store";
import { taskUrls } from "./task-urls";

/** Where the code review row lives (decision 5, Agent step of the wizard). */
export const REVIEW_SETUP_HINT = "Set up code review in Welcome / Setup…";

export type ReviewTargetKind = "local" | "pr";

/** The task's agent (tasks from before agents were recorded ran Pi). */
export function taskHarness(task: Pick<Task, "harness">): string {
  return task.harness ?? "pi";
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
    return "This agent cannot start a code review";
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
}

/**
 * What a review tab without a session URL shows:
 * - `queued`: main holds the command until the agent finishes its turn;
 * - `starting`: delivered (or in flight), waiting for the session's URL;
 * - `no-session`: nothing appeared within `REVIEW_WAIT_TIMEOUT_MS` (counted
 *   from `clockFrom`: the click, or when a queued review's agent last
 *   started/stopped working), the request failed, or there is no request
 *   at all (a tab restored without its session).
 */
export type ReviewWaitState = "queued" | "starting" | "no-session";

export function reviewWaitState(input: {
  request: ReviewRequest | undefined;
  clockFrom: number;
  now: number;
  agentWorking: boolean;
}): ReviewWaitState {
  const { request } = input;
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

/** "Idle" for the hint (decision 1): a live session at rest, not mid-turn and not asking anything. */
export function isAgentIdle(badge: PresenceBadge | undefined): boolean {
  if (!badge?.live || badge.runningTurn) return false;
  const state = badge.status?.state;
  return state === undefined || state === "idle" || state === "done";
}

/** Dev tasks whose agent is idle: the only ones whose worktree is worth checking. */
export function reviewHintCandidates(
  tasks: readonly Task[],
  presence: PresenceChangedPayload,
): string[] {
  return tasks
    .filter(
      (task) => task.state === "working" && isAgentIdle(presence[task.id]),
    )
    .map((task) => task.id);
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

let readyIds: readonly string[] = [];
const readyListeners = new Set<() => void>();
function setReady(next: readonly string[]): void {
  if (next.join("\n") === readyIds.join("\n")) return;
  readyIds = next;
  for (const listener of Array.from(readyListeners)) listener();
}

/**
 * Reads core's stored worktree pass once (`listWorktreeStatus`: the refresh
 * tick's single `git status` per Working task, the same one the rules'
 * `worktree.dirty` fact uses) and publishes the "Ready to review" set. One
 * IPC call per evaluation, never one per candidate, and no git per call.
 * A candidate list that changed while a read was in flight wins: only the
 * latest evaluation publishes.
 */
let evaluation = 0;
export function evaluateReadyToReview(candidates: readonly string[]): void {
  const run = ++evaluation;
  // Drop non-candidates right away (an agent that started working).
  setReady(readyIds.filter((id) => candidates.includes(id)));
  if (candidates.length === 0) return;
  void window.harbormaster.core
    .listWorktreeStatus()
    .then((statuses) => {
      if (run !== evaluation) return;
      setReady(candidates.filter((id) => statuses[id]?.dirty === true));
    })
    .catch(() => {});
}

/** The current "Ready to review" set (the store's snapshot). */
export function readyToReviewIds(): readonly string[] {
  return readyIds;
}

/** Task ids showing the "Ready to review" chip. */
export function useReadyToReview(): readonly string[] {
  return useSyncExternalStore((listener) => {
    readyListeners.add(listener);
    return () => readyListeners.delete(listener);
  }, readyToReviewIds);
}

/**
 * Keeps the "Ready to review" set current (App mounts it once): on every
 * presence push and after every refresh tick (the 30 s loop).
 */
export function useReadyToReviewEvaluation(
  tasks: readonly Task[],
  presence: PresenceChangedPayload,
): void {
  const candidates = useRef<string[]>([]);
  candidates.current = reviewHintCandidates(tasks, presence);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each presence push (and board change) is a re-evaluation trigger.
  useEffect(() => {
    evaluateReadyToReview(candidates.current);
  }, [presence, tasks]);
  useEffect(
    () =>
      window.harbormaster.core.onRefreshed(() =>
        evaluateReadyToReview(candidates.current),
      ),
    [],
  );
}
