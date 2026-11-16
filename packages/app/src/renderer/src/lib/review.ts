// Code review via Plannotator (docs/plannotator.md), renderer side: when
// the Review button is enabled, which target it defaults to, which tasks
// get the quiet "Ready to review" hint, and the shared stores behind them
// (`reviewSupport`, re-checked on window focus; each idle Dev task's
// worktree dirtiness, re-read on presence pushes and every refresh tick).
// The decisions are pure functions (tests/review.test.ts).

import { useEffect, useRef, useSyncExternalStore } from "react";
import type {
  PresenceBadge,
  PresenceChangedPayload,
  ReviewSupport,
  ReviewSupportHarness,
  Task,
} from "../../../preload/api";
import { createSharedStore } from "./shared-store";

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
 * no support listing yet, a harness without a review command, Plannotator
 * not ready for it, or the agent mid-turn.
 */
export function reviewDisabledReason(input: {
  support: ReviewSupport | null;
  harness: string;
  runningTurn: boolean;
}): string | undefined {
  if (!input.support) return "Checking code review support…";
  const entry = harnessSupport(input.support, input.harness);
  if (!entry || entry.state === "unsupported") {
    return "This agent cannot start a code review";
  }
  if (entry.state !== "ready") return REVIEW_SETUP_HINT;
  if (input.runningTurn) return "The agent is working; review once it is idle";
  return undefined;
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
 * Re-reads `getTaskWorkspace(id).dirty` for every candidate and publishes
 * the "Ready to review" set. A candidate list that changed while a read was
 * in flight wins: only the latest evaluation publishes.
 */
let evaluation = 0;
export function evaluateReadyToReview(candidates: readonly string[]): void {
  const run = ++evaluation;
  // Drop non-candidates right away (an agent that started working).
  setReady(readyIds.filter((id) => candidates.includes(id)));
  void Promise.all(
    candidates.map((id) =>
      window.harbormaster.core
        .getTaskWorkspace(id)
        .then((binding) => (binding?.dirty === true ? id : undefined))
        .catch(() => undefined),
    ),
  ).then((ids) => {
    if (run !== evaluation) return;
    setReady(ids.filter((id): id is string => id !== undefined));
  });
}

/** Task ids showing the "Ready to review" chip. */
export function useReadyToReview(): readonly string[] {
  return useSyncExternalStore(
    (listener) => {
      readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
    () => readyIds,
  );
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
