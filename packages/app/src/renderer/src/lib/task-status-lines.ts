// Pure derivation rules for the launch-related secondary lines/chips a
// TaskCard/SidebarTaskRow shows (see /docs/design-decisions.md "Launching tasks from an agent"'s
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

/**
 * What a live task's agent is doing, for the dot, the activity line and
 * the amber "your move" styling (decision #18):
 * - `working`: a turn is running (spinner);
 * - `your-move`: it waits on the user: a `blocked` program status, a
 *   self-reported outcome, or a live session with no program status at
 *   all (pre-7501 records keep their old meaning);
 * - `idle`: at rest (`idle` / `done` status), or waiting on its parent;
 * - `error`: at rest after a failure (`status.message` says why).
 * `undefined` when no agent is attached.
 */
export type PresenceActivity = "working" | "your-move" | "idle" | "error";

export function derivePresenceActivity(
  presence:
    | Pick<PresenceBadge, "live" | "runningTurn" | "status" | "outcome">
    | undefined,
  waitingOnParent = false,
): PresenceActivity | undefined {
  if (presence?.runningTurn) return "working";
  if (!presence?.live) return undefined;
  if (waitingOnParent) return "idle";
  if (presence.outcome) return "your-move";
  switch (presence.status?.state) {
    case "error":
      return "error";
    case "idle":
    case "done":
      return "idle";
    default:
      return "your-move";
  }
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
