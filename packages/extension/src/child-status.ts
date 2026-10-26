// Pure logic behind `harbormaster_subtask_status` and the task widget's
// children summary line: deriving a child task's run state from its
// `launch` status and harness presence (see
// /docs/design-decisions.md "Launching tasks from an agent"'s "Completion and status"), and formatting
// both the per-child status text and the widget's compact summary. Kept
// free of `@harbormaster/core`'s I/O (`PiHarnessAdapter.presence`) and the
// `pi` extension API so it is testable with plain fake `Task`/`PresenceStatus`
// values — `index.ts` is the only place that fetches children and presence
// and wires this against a real tool/widget.

import type {
  AwaitingKindId,
  PresenceStatus,
  Task,
  TaskPullRequest,
  TaskState,
} from "@harbormaster/core";
import { awaitingReasonLabel, TASK_STATE_LABELS } from "./task-widget.js";

/** A child's run state, derived from `task.launch` and its harness presence — independent of board column. */
export type ChildRunState =
  | "queued"
  | "interrupted"
  | "working"
  | "your move"
  | "not running";

/**
 * `queued`/`interrupted` come straight off `task.launch.status` (the
 * background-launch queue/run state, see `TaskLaunch`); otherwise liveness
 * decides: a live, mid-turn session is `working`, live-but-idle is `your
 * move` (a finished/blocked/asking child is exactly as attention-worthy as
 * any task), and no live presence at all is `not running`.
 */
export function deriveChildRunState(
  task: Task,
  presence: PresenceStatus,
): ChildRunState {
  if (task.launch?.status === "queued") return "queued";
  if (task.launch?.status === "interrupted") return "interrupted";
  if (presence.live) return presence.runningTurn ? "working" : "your move";
  return "not running";
}

/** Reported outcome to show for a child: the live `outcome` while attached, else the terminal `ended` verdict, if any. */
export interface ChildOutcome {
  status: "done" | "blocked" | "unreported";
  note?: string;
}

export function deriveChildOutcome(
  presence: PresenceStatus,
): ChildOutcome | undefined {
  const record = presence.record;
  if (!record) return undefined;
  if (presence.live) {
    return record.outcome
      ? {
          status: record.outcome.status,
          ...(record.outcome.note ? { note: record.outcome.note } : {}),
        }
      : undefined;
  }
  return record.ended
    ? {
        status: record.ended.status,
        ...(record.ended.note ? { note: record.ended.note } : {}),
      }
    : undefined;
}

export interface ChildStatusEntry {
  id: string;
  title: string;
  state: TaskState;
  awaiting?: { kind: AwaitingKindId; label: string };
  pr?: { number: number; state: TaskPullRequest["state"]; url?: string };
  runState: ChildRunState;
  outcome?: ChildOutcome;
}

/** Build one child's structured status, for both the tool's plain text and its `details`. */
export function buildChildStatusEntry(
  task: Task,
  presence: PresenceStatus,
): ChildStatusEntry {
  const outcome = deriveChildOutcome(presence);
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    ...(task.state === "awaiting" && task.awaiting
      ? {
          awaiting: {
            kind: task.awaiting.kind,
            label: awaitingReasonLabel(task.awaiting),
          },
        }
      : {}),
    ...(task.pr
      ? {
          pr: {
            number: task.pr.number,
            state: task.pr.state,
            ...(task.pr.url ? { url: task.pr.url } : {}),
          },
        }
      : {}),
    runState: deriveChildRunState(task, presence),
    ...(outcome ? { outcome } : {}),
  };
}

/** One child line: `"<title>" (<id>) · <column[ (awaiting <label>)]> · <run state>[ · PR #n <state> <url>][ · outcome: <status>[ — <note>]]`. */
export function formatChildStatusLine(entry: ChildStatusEntry): string {
  const parts: string[] = [`"${entry.title}" (${entry.id})`];
  const column = entry.awaiting
    ? `${TASK_STATE_LABELS[entry.state]} (awaiting ${entry.awaiting.label})`
    : TASK_STATE_LABELS[entry.state];
  parts.push(column);
  parts.push(entry.runState);
  if (entry.pr) {
    parts.push(
      `PR #${entry.pr.number} ${entry.pr.state}${entry.pr.url ? ` ${entry.pr.url}` : ""}`,
    );
  }
  if (entry.outcome) {
    parts.push(
      `outcome: ${entry.outcome.status}${entry.outcome.note ? ` — ${entry.outcome.note}` : ""}`,
    );
  }
  return parts.join(" · ");
}

/** Plain readable text for every child, one per line; `"No child tasks."` when there are none. */
export function formatChildStatusText(
  entries: readonly ChildStatusEntry[],
): string {
  if (!entries.length) return "No child tasks.";
  return entries.map(formatChildStatusLine).join("\n");
}

// --- Task widget children summary line -----------------------------------

/** Widget-summary bucket: `done` is the board column, taking precedence over an otherwise-derived run state. */
export type ChildSummaryCategory = ChildRunState | "done";

export function categorizeChildForWidget(
  task: Task,
  presence: PresenceStatus,
): ChildSummaryCategory {
  if (task.state === "done") return "done";
  return deriveChildRunState(task, presence);
}

/** Display order (pi-home parity: working children first, "done" last). */
const SUMMARY_CATEGORY_ORDER: ChildSummaryCategory[] = [
  "working",
  "your move",
  "queued",
  "interrupted",
  "not running",
  "done",
];

/**
 * The task widget's compact children line (pi-home parity, e.g. `children: 2
 * working · 1 your move · 1 queued · 1 done`); `undefined` when there are no
 * children (no line to show).
 */
export function formatChildrenSummaryLine(
  categories: readonly ChildSummaryCategory[],
): string | undefined {
  if (!categories.length) return undefined;
  const counts = new Map<ChildSummaryCategory, number>();
  for (const category of categories) {
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const parts = SUMMARY_CATEGORY_ORDER.filter((category) =>
    counts.has(category),
  ).map((category) => `${counts.get(category)} ${category}`);
  return `children: ${parts.join(" · ")}`;
}
