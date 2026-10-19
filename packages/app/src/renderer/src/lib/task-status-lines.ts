// Pure derivation rules for the launch-related secondary lines/chips a
// TaskCard/SidebarTaskRow shows (see ai/prds/task-launching.md's
// "renderer" bullet and the wave-3 task brief items 2-4): standalone
// provenance, the reported-outcome secondary line, and the queued/
// interrupted launch markers. Kept free of React so they're unit-testable
// without a DOM (see tests/task-status-lines.test.ts).
import type { PresenceBadge, Task } from "../../../preload/api";

export interface OutcomeLine {
  status: "done" | "blocked";
  note: string;
}

/**
 * The muted secondary line a finished/blocked child shows, when there is
 * actually a note to show. A *live* self-report (`presence.outcome`, the
 * session is still attached) takes priority over `ended` (the process is
 * gone) — both are "the agent told us something", but `outcome` is the
 * more current of the two while both could theoretically be set. Neither
 * ever fires a new notification or unread transition on its own (see
 * lib/unread.ts / lib/notifications.ts; this module only decides what
 * text — if any — to render).
 */
export function deriveOutcomeLine(
  presence: Pick<PresenceBadge, "outcome" | "ended"> | undefined,
): OutcomeLine | undefined {
  if (!presence) return undefined;
  const live = presence.outcome;
  if (live?.note) return { status: live.status, note: live.note };
  const ended = presence.ended;
  if (
    ended &&
    (ended.status === "done" || ended.status === "blocked") &&
    ended.note
  ) {
    return { status: ended.status, note: ended.note };
  }
  return undefined;
}

export type LaunchMarker = "queued" | "interrupted";

/**
 * The launch-queue chip a launched task shows while its background session
 * hasn't started yet (`queued`) or was cut short by the app quitting
 * mid-turn (`interrupted`, clears on its own once the task's next session
 * launch flips it back to `started`). `undefined` once/unless started
 * normally — not every task has a `launch` at all (only `launchTask`-
 * created ones do).
 */
export function deriveLaunchMarker(
  task: Pick<Task, "launch">,
): LaunchMarker | undefined {
  const status = task.launch?.status;
  return status === "queued" || status === "interrupted" ? status : undefined;
}

/**
 * Display-only provenance line for a `standalone`-launched task:
 * `"launched from <title>"`, or `undefined` when the task has no
 * `launchedFromTaskId` or its source task can no longer be resolved (e.g.
 * long since deleted) — fall back to nothing, never a broken reference.
 */
export function deriveProvenanceLabel(
  task: Pick<Task, "launchedFromTaskId">,
  resolveTitle: (taskId: string) => string | undefined,
): string | undefined {
  if (!task.launchedFromTaskId) return undefined;
  const title = resolveTitle(task.launchedFromTaskId);
  return title ? `launched from ${title}` : undefined;
}
