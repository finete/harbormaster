// Stopping the agents of the tasks below a task that is being marked Done
// (docs/task-trees.md decision 12). "Stop" means the agent processes only:
// the tasks stay on the board in their columns, with their worktrees and
// uncommitted changes untouched. The processes are main's (ptySessions), so
// main does it; core only names the tasks (`listDescendants`) and records
// that a mid-turn launch was interrupted (`markLaunchesInterrupted`, the
// same marker app quit uses). Dependencies are injected so the sweep is
// unit-testable without ptys.

export interface StopTaskAgentsDeps {
  /** Whether the task's agent is mid-turn right now (harness presence). */
  isMidTurn(taskId: string): Promise<boolean>;
  /** Records launched tasks' sessions as interrupted (core). */
  markInterrupted(taskIds: string[]): Promise<void>;
  /** Signals the task's live primary pty; its own exit path retires it. `false` when there is none. */
  stop(taskId: string): boolean;
}

/**
 * Stops the agents of `taskIds` and returns the ids that had a live
 * process. Mid-turn tasks are marked interrupted first (so the board shows
 * "interrupted", not a silent stop); a failure of that bookkeeping never
 * keeps a process running.
 */
export async function stopTaskAgents(
  taskIds: readonly string[],
  deps: StopTaskAgentsDeps,
): Promise<string[]> {
  const midTurn: string[] = [];
  for (const taskId of taskIds) {
    if (await deps.isMidTurn(taskId).catch(() => false)) midTurn.push(taskId);
  }
  if (midTurn.length > 0) {
    await deps.markInterrupted(midTurn).catch(() => {});
  }
  return taskIds.filter((taskId) => deps.stop(taskId));
}
