// Shared pure time-formatting helpers for the sidebar rail (SidebarTaskRow)
// and the board's cards (TaskCard): a single relative-time formatter and a
// single "last interaction" source-of-truth, so both surfaces agree on what
// a task's time indicator means. Kept free of React/`window` so it is
// unit-testable under plain vitest (see tests/time-format.test.ts).
//
// Ported from pi-home's `relativeAge`/`withLastInteraction`
// (src/presentation/task-status.ts, src/presentation/home-controller.ts):
// pi-home's "honest last-interaction signal" is the session file's mtime,
// falling back to the task record's own timestamp when no session exists
// yet. Harbormaster has no renderer-visible session-file mtime (accessor
// separation: the renderer never does its own fs/session I/O), but it has
// the same shape of signal already flowing through the presence push: a
// live task's heartbeat (`PresenceBadge.heartbeatAt`, refreshed by the
// harness's own activity, see core's session-presence-access.ts) is the
// "we're actively talking right now" signal, falling back to
// `Task.updatedAt` exactly like pi-home falls back to the task record
// timestamp when there's no session file. No new access-layer plumbing was
// added for this phase; see AGENTS.md's accessor rule and the worker's
// final report for the tradeoff.
import type { Task } from "../../../preload/api";

/** Compact age: "now" (<1m), "3m", "2h", "5d", "4w", "7mo", "2y". */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/**
 * ISO timestamp for a task's "last interaction": the live heartbeat while
 * an agent is attached, else the task record's own `updatedAt`. Shared by
 * the sidebar rail (`sidebar-model.ts`'s `activityTimestamp`) and the
 * board's `TaskCard`.
 */
export function lastInteractionTimestamp(
  task: Pick<Task, "updatedAt">,
  presence: { live: boolean; heartbeatAt?: string } | undefined,
): string {
  return (presence?.live ? presence.heartbeatAt : undefined) ?? task.updatedAt;
}

/**
 * "waiting <duration>" sub-line fragment for an Awaiting card, ported from
 * pi-home's `awaitingSourceText` (src/presentation/home-board.ts), which
 * renders `waiting ${relativeAge(task.awaiting.since)}`. Harbormaster's
 * pruned `AwaitingKind` carries no per-entry `since`; `sinceIso` is the
 * caller's best source for "time entered the current awaiting kind" (see
 * the worker's final report for which field was chosen and its known gap).
 */
export function waitingDurationText(sinceIso: string, now: number): string {
  return `waiting ${relativeTime(sinceIso, now)}`;
}
