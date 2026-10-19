// Pure task-widget formatting — ported from pi-home's src/presentation/
// task-status.ts (`pullRequestBadge`, `awaitingSourceText`, `taskStatusText`)
// and adapted to Harbormaster's pruned `Task` model (contracts/model.ts):
// no separate `BoardItem`/`PullRequestMeta`/`AwaitingContext` types, no
// `review`-kind PR linkage (the pruned `AwaitingKind` carries no PR
// reference of its own — line 1 reads PR info straight off `task.pr`
// instead). Everything here is pure string formatting so it is testable
// without a real `ExtensionContext`; `index.ts` is the only place that
// touches `ctx.ui`.

import { hyperlink } from "@earendil-works/pi-tui";
import type {
  AwaitingKind,
  Task,
  TaskPullRequest,
  TaskState,
} from "@harbormaster/core";

/**
 * The subset of pi's `Theme` this module needs. Accepting a narrow
 * structural type (instead of importing the concrete `Theme` class) keeps
 * this module's tests free of a real theme instance — any object with
 * `fg()` satisfies it, and a real `ctx.ui.theme` satisfies it too.
 */
export interface TaskWidgetTheme {
  fg(token: "accent" | "success" | "warning" | "error", text: string): string;
}

export const TASK_STATE_LABELS: Record<TaskState, string> = {
  backlog: "Backlog",
  dev: "Dev",
  awaiting: "Awaiting",
  done: "Done",
};

/** Short label for why an `awaiting` task is blocked; deploy stages use their own configured label. */
export function awaitingReasonLabel(awaiting: AwaitingKind): string {
  if (awaiting.kind === "review") return "review";
  if (awaiting.kind === "slack") return "slack";
  return awaiting.stageLabel;
}

/** Status word for a PR badge: terminal state wins, then the review-decision signal on an open PR. */
export function prStatusWord(pr: TaskPullRequest): string {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.state === "draft") return "draft";
  if (pr.changesRequestedOnHead || pr.reviewDecision === "CHANGES_REQUESTED")
    return "changes requested";
  if (pr.reviewDecision === "APPROVED") return "approved";
  return "open";
}

/** Theme color for a PR badge, same precedence as {@link prStatusWord}. */
export function prStatusColor(
  pr: TaskPullRequest,
): "accent" | "success" | "warning" | "error" {
  if (pr.state === "merged") return "success";
  if (pr.state === "closed") return "error";
  if (pr.changesRequestedOnHead || pr.reviewDecision === "CHANGES_REQUESTED")
    return "warning";
  if (pr.reviewDecision === "APPROVED") return "success";
  return "accent";
}

/**
 * Line 1: `<reason> · PR #N · <status>` (reason omitted outside an awaiting
 * task), colored by PR state/review-decision. The PR number links to its
 * URL — an OSC-8 hyperlink terminals that support it render as clickable;
 * terminals without support show the plain text (same degrade as
 * `@earendil-works/pi-tui`'s `hyperlink()`). Returns `undefined` when the
 * task has no PR (e.g. a task still in `dev` that has not opened one yet).
 */
export function pullRequestLine(
  task: Task,
  theme: TaskWidgetTheme,
): string | undefined {
  const pr = task.pr;
  if (!pr) return undefined;
  const reason =
    task.state === "awaiting" && task.awaiting
      ? awaitingReasonLabel(task.awaiting)
      : undefined;
  const prText = pr.url
    ? hyperlink(`PR #${pr.number}`, pr.url)
    : `PR #${pr.number}`;
  const text = reason
    ? `${reason} · ${prText} · ${prStatusWord(pr)}`
    : `${prText} · ${prStatusWord(pr)}`;
  return theme.fg(prStatusColor(pr), text);
}

/** Long-form awaiting-source headings, as in pi-home's `AWAITING_KIND_LABELS`. */
const AWAITING_SOURCE_LABELS = {
  review: "Review",
  slack: "Slack response",
} as const;

/**
 * pi-home's `awaitingSourceText`: one line naming what an Awaiting task
 * waits on, with clickable (OSC-8) references — the review PR, the Slack
 * permalink, or for a deployment wait the merged PR and the branch it
 * landed on (`#N → main`). `undefined` outside the awaiting column.
 */
export function awaitingSourceLine(
  task: Task,
  theme: TaskWidgetTheme,
): string | undefined {
  const awaiting = task.state === "awaiting" ? task.awaiting : undefined;
  if (!awaiting) return undefined;
  const pr = task.pr;
  const prLink = (label: string) =>
    pr?.url ? hyperlink(label, pr.url) : label;
  let text: string;
  if (awaiting.kind === "slack") {
    text = awaiting.permalink
      ? `${AWAITING_SOURCE_LABELS.slack} · ${hyperlink(awaiting.permalink, awaiting.permalink)}`
      : AWAITING_SOURCE_LABELS.slack;
  } else {
    const label =
      awaiting.kind === "review"
        ? AWAITING_SOURCE_LABELS.review
        : awaiting.stageLabel;
    const target = pr?.mergeCommit?.targetBranch;
    const reference = !pr
      ? undefined
      : awaiting.kind === "deploy" && target
        ? prLink(`#${pr.number} → ${target}`)
        : prLink(`PR #${pr.number}`);
    text = reference ? `${label} · ${reference}` : label;
  }
  return theme.fg("success", text);
}

/**
 * Summary line (always present when a task is shown): `<Column[ ·
 * stage/reason]> · <kind> · <title>`. `<kind>` is `task` or `temp_task`,
 * same as pi-home's `taskStatusText`, which also links the title to the PR
 * while it is open (drafts included).
 */
export function taskSummaryLine(task: Task, theme: TaskWidgetTheme): string {
  const reason =
    task.state === "awaiting" && task.awaiting
      ? ` · ${awaitingReasonLabel(task.awaiting)}`
      : "";
  const prOpen = task.pr?.state === "open" || task.pr?.state === "draft";
  const title =
    prOpen && task.pr?.url ? hyperlink(task.title, task.pr.url) : task.title;
  const text = `${TASK_STATE_LABELS[task.state]}${reason} · ${task.kind} · ${title}`;
  return theme.fg("accent", text);
}

/**
 * Full widget content for `ctx.ui.setWidget()`: the awaiting source (when
 * awaiting), the PR line (when there is a PR), the summary, then — when the
 * task has children — a compact children-run-state line (pi-home parity,
 * see `child-status.ts`'s `formatChildrenSummaryLine`) — or `undefined`
 * when there is no task to show (the task vanished from state, or the
 * extension is not Harbormaster-hosted) — passing `undefined` clears a
 * previously set widget.
 */
export function buildTaskWidgetLines(
  task: Task | undefined,
  theme: TaskWidgetTheme,
  childrenSummaryLine?: string,
): string[] | undefined {
  if (!task) return undefined;
  const lines: string[] = [];
  const sourceLine = awaitingSourceLine(task, theme);
  if (sourceLine) lines.push(sourceLine);
  const prLine = pullRequestLine(task, theme);
  if (prLine) lines.push(prLine);
  lines.push(taskSummaryLine(task, theme));
  if (childrenSummaryLine) lines.push(theme.fg("accent", childrenSummaryLine));
  return lines;
}
