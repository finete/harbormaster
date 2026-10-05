// Engine: pure done/backlog cleanup rules. Ported and trimmed from
// pi-home's src/engines/task-policy.ts (`shouldArchive`) and
// src/engines/completion-cleanup.ts: pi-home's durable cleanup-job/claim-
// token machinery is background-worker infrastructure Harbormaster does not
// have yet (cleanup runs synchronously inside toDone/refresh in the
// manager), so only the decision rules survive here. The manager owns the
// actual worktree-removal/branch-delete I/O sequencing (accessor separation:
// Engines are pure, Managers orchestrate).

import type { Task, TaskPullRequest } from "../contracts/model.js";

/** Done tasks older than this many days (default) are flagged archived. */
export const DEFAULT_ARCHIVE_RETENTION_DAYS = 7;

/** Whether a done task has sat long enough to flag `archivedAt` (computed on refresh; no UI reads it yet). */
export function shouldArchive(
  task: Task,
  now: Date,
  retentionDays = DEFAULT_ARCHIVE_RETENTION_DAYS,
): boolean {
  if (task.state !== "done" || task.archivedAt || !task.completedAt) {
    return false;
  }
  return (
    now.getTime() - new Date(task.completedAt).getTime() >=
    retentionDays * 86_400_000
  );
}

/** Branch deletion on the done safe-path only ever happens for a merged PR. */
export function shouldDeleteBranch(pr: TaskPullRequest | undefined): boolean {
  return pr?.state === "merged";
}
