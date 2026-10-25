// Engine: a task follows its worktree's current branch. An agent may run
// `git checkout -b other` inside the task worktree; PR lookup by the
// originally recorded branch would then never find its PR.

export interface BranchAdoptionInput {
  /** Branch currently recorded on the task. */
  taskBranch: string | undefined;
  /** Branch checked out in the task's worktree right now (undefined: detached/unreadable). */
  currentBranch: string | undefined;
  targetBranch: string | undefined;
  defaultBranch: string | undefined;
}

/**
 * The branch the task should adopt, or `undefined` to keep its own. Never
 * adopts the target/default branch: an agent temporarily on main must not
 * hijack the task.
 */
export function branchToAdopt(input: BranchAdoptionInput): string | undefined {
  const current = input.currentBranch?.trim();
  if (!current) return undefined;
  if (current === input.taskBranch) return undefined;
  if (current === input.targetBranch || current === input.defaultBranch) {
    return undefined;
  }
  return current;
}
