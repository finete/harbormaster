// Engine: one refresh pass of "is each Working task's worktree dirty?"
// (`git status --porcelain`). Computed once per refresh tick and shared by
// the rules' `worktree.dirty` fact and the app's "Ready to review" hint
// (`CoreCommands.listWorktreeStatus`, docs/plannotator.md), so nothing on a
// periodic path runs git per caller.
//
// Bounded so a slow repository cannot stretch the tick: at most
// `concurrency` runs in flight, each given `timeoutMs` (the git process is
// killed at that limit, and the wait is capped there regardless). A run
// that fails or times out keeps the task's previous entry (stale, with its
// old `checkedAt`); with none it is reported as unreadable.

import type { WorktreeStatus } from "../contracts/model.js";
import { forEachConcurrently, withTimeout } from "../utilities/concurrency.js";

/** `git status` runs in flight at once. */
export const WORKTREE_STATUS_CONCURRENCY = 6;
/** Per-worktree limit for one `git status`. */
export const WORKTREE_STATUS_TIMEOUT_MS = 2_000;

export interface WorktreeStatusTarget {
  taskId: string;
  /** The task's git worktree. */
  path: string;
}

export interface WorktreeStatusPass {
  /** Fresh or (on failure) previous entries, by task id; only the pass's targets. */
  statuses: Map<string, WorktreeStatus>;
  /** Targets git could not answer for this pass, with no previous entry to keep. */
  unreadable: Set<string>;
}

export async function collectWorktreeStatus(input: {
  targets: readonly WorktreeStatusTarget[];
  previous: ReadonlyMap<string, WorktreeStatus>;
  /** Must honour `timeoutMs` (kill the git run) where it can. */
  isDirty: (path: string, timeoutMs: number) => Promise<boolean>;
  now: () => Date;
  concurrency?: number;
  timeoutMs?: number;
}): Promise<WorktreeStatusPass> {
  const timeoutMs = input.timeoutMs ?? WORKTREE_STATUS_TIMEOUT_MS;
  const statuses = new Map<string, WorktreeStatus>();
  const unreadable = new Set<string>();
  await forEachConcurrently(
    input.targets,
    input.concurrency ?? WORKTREE_STATUS_CONCURRENCY,
    async ({ taskId, path }) => {
      try {
        const dirty = await withTimeout(
          input.isDirty(path, timeoutMs),
          timeoutMs,
        );
        statuses.set(taskId, { dirty, checkedAt: input.now().toISOString() });
      } catch {
        const previous = input.previous.get(taskId);
        if (previous) statuses.set(taskId, previous);
        else unreadable.add(taskId);
      }
    },
  );
  return { statuses, unreadable };
}
