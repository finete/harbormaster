// Engine: pure done/backlog cleanup rules. Ported and trimmed from
// pi-home's src/engines/task-policy.ts (`shouldArchive`) and
// src/engines/completion-cleanup.ts: pi-home's durable cleanup-job/claim-
// token machinery is background-worker infrastructure Harbormaster does not
// have yet (cleanup runs synchronously inside toDone/refresh in the
// manager), so only the decision rules survive here. The manager owns the
// actual worktree-removal/branch-delete I/O sequencing (accessor separation:
// Engines are pure, Managers orchestrate).

import type { OrphanWorktree } from "../contracts/commands.js";
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

/**
 * Whether the done path deletes the branch without asking: only for a
 * merged PR (always with `-D`: squash merges look unmerged to `git branch
 * -d`). An unmerged branch is deleted only after the user confirmed it.
 */
export function shouldDeleteBranch(pr: TaskPullRequest | undefined): boolean {
  return pr?.state === "merged";
}

/**
 * Whether `candidate` is a PR-review checkout an agent made next to a task's
 * worktree: a detached worktree in the same directory named
 * `<task-worktree-dir>-pr<N>` or `<task-worktree-dir>-prlocal`. These carry
 * no binding of their own, so the task's Done cleanup reaps them alongside
 * its worktree (they are throwaway: recreated from the PR in seconds).
 */
export function isReviewCheckoutOf(
  taskWorktreePath: string,
  candidate: { path: string; detached: boolean },
): boolean {
  if (!candidate.detached) return false;
  const split = (path: string) => {
    const trimmed = path.replace(/\/+$/, "");
    const at = trimmed.lastIndexOf("/");
    return { dir: trimmed.slice(0, at), name: trimmed.slice(at + 1) };
  };
  const task = split(taskWorktreePath);
  const other = split(candidate.path);
  if (!task.name || other.dir !== task.dir) return false;
  if (!other.name.startsWith(`${task.name}-pr`)) return false;
  return /^(\d+|local)$/.test(other.name.slice(task.name.length + 3));
}

/** When the orphan count or their total size crosses either, the app warns once per scan. */
export const ORPHAN_WARN_COUNT = 10;
export const ORPHAN_WARN_BYTES = 20 * 1024 ** 3;

/** The directories under the worktrees root no binding (live or parked) points at. */
export function findOrphanDirs(
  dirs: readonly string[],
  boundPaths: readonly string[],
): string[] {
  const normalize = (value: string) => value.replace(/\/+$/, "");
  const bound = new Set(boundPaths.map(normalize));
  return dirs.filter((dir) => !bound.has(normalize(dir)));
}

/** The one-line warning for an orphan scan, or `undefined` while it stays under both thresholds. */
export function orphanWorktreeWarning(
  root: string,
  orphans: readonly OrphanWorktree[],
  limits: { count: number; bytes: number } = {
    count: ORPHAN_WARN_COUNT,
    bytes: ORPHAN_WARN_BYTES,
  },
): string | undefined {
  const total = orphans.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
  if (orphans.length < limits.count && total < limits.bytes) return undefined;
  const gb = (total / 1024 ** 3).toFixed(1);
  return `${orphans.length} worktree${orphans.length === 1 ? "" : "s"} (${gb} GB) in ${root} belong to no task`;
}
