// Pure logic behind the `subtask_status` catalog tool: deriving a child
// task's run state from its `launch` status and harness presence (see
// /docs/design-decisions.md "Launching tasks from an agent"), and formatting
// the per-child status text. No I/O: `catalog.ts` fetches children and
// presence through the command API and hands plain values in.

import type { PresenceStatus } from "../contracts/harness.js";
import type {
  AwaitingKind,
  AwaitingKindId,
  Task,
  TaskPullRequest,
  TaskState,
} from "../contracts/model.js";

/** Board column labels as agents read them. */
export const TASK_STATE_LABELS: Record<TaskState, string> = {
  backlog: "Backlog",
  working: "Working",
  awaiting: "Awaiting",
  done: "Done",
};

/** Short label for why an `awaiting` task is blocked; deploy stages use their own configured label. */
export function awaitingReasonLabel(awaiting: AwaitingKind): string {
  if (awaiting.kind === "review") return "review";
  if (awaiting.kind === "slack") return "slack";
  if (awaiting.kind === "author-response") return "author response";
  return awaiting.stageLabel;
}

/** A child's run state, derived from `task.launch` and its harness presence — independent of board column. */
export type ChildRunState =
  | "queued"
  | "interrupted"
  | "running"
  | "your move"
  | "not running";

/**
 * `queued`/`interrupted` come straight off `task.launch.status` (the
 * background-launch queue/run state, see `TaskLaunch`); otherwise liveness
 * decides: a live, mid-turn session is `running`, live-but-idle is `your
 * move` (a finished/blocked/asking child is exactly as attention-worthy as
 * any task), and no live presence at all is `not running`.
 */
export function deriveChildRunState(
  task: Task,
  presence: PresenceStatus,
): ChildRunState {
  if (task.launch?.status === "queued") return "queued";
  if (task.launch?.status === "interrupted") return "interrupted";
  if (presence.live) return presence.runningTurn ? "running" : "your move";
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

/** A question a child stopped to ask the user directly (the inbox's "agent asked"). */
export interface ChildOpenQuestion {
  question: string;
  at: string;
}

/**
 * The child's open question for the USER: it is live, not running a turn, and
 * its last program-status report is `blocked` with a message, with no
 * reported outcome at or after that report (an outcome supersedes it, as in
 * the inbox). `undefined` otherwise. Direct children only: callers never
 * pass a grandchild.
 */
export function deriveWaitingOnUser(
  presence: PresenceStatus,
): ChildOpenQuestion | undefined {
  if (!presence.live || presence.runningTurn) return undefined;
  const status = presence.record?.status;
  const question = status?.message?.trim();
  if (status?.state !== "blocked" || !question) return undefined;
  const outcome = presence.record?.outcome;
  if (outcome && outcome.at >= status.at) return undefined;
  return { question, at: status.at };
}

export interface ChildStatusEntry {
  id: string;
  title: string;
  state: TaskState;
  awaiting?: { kind: AwaitingKindId; label: string };
  pr?: { number: number; state: TaskPullRequest["state"]; url?: string };
  runState: ChildRunState;
  outcome?: ChildOutcome;
  /** Tasks below this child (any depth) that are not Done yet; absent when none. */
  activeBelow?: number;
  waitingOnUser?: ChildOpenQuestion;
}

/** Build one child's structured status, for both the tool's plain text and its `details`. */
export function buildChildStatusEntry(
  task: Task,
  presence: PresenceStatus,
  activeBelow = 0,
): ChildStatusEntry {
  const outcome = deriveChildOutcome(presence);
  const waitingOnUser = deriveWaitingOnUser(presence);
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
    ...(activeBelow > 0 ? { activeBelow } : {}),
    ...(waitingOnUser ? { waitingOnUser } : {}),
  };
}

/** How many of `descendants` (every task below a child, any depth) are not Done. */
export function countActiveTasks(
  descendants: readonly Pick<Task, "state">[],
): number {
  return descendants.filter((task) => task.state !== "done").length;
}

/** One child line: `"<title>" (<id>) · <column[ (awaiting <label>)]> · <run state>[ · PR #n <state> <url>][ · outcome: <status>[ — <note>]][ · N tasks below not done yet][ · waiting on the user: <question>]`. */
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
  if (entry.activeBelow) {
    parts.push(
      `${entry.activeBelow} task${entry.activeBelow === 1 ? "" : "s"} below not done yet`,
    );
  }
  if (entry.waitingOnUser) {
    parts.push(`waiting on the user: ${entry.waitingOnUser.question}`);
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
