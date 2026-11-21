// Stopping the agents of the tasks below a task that is being marked Done
// (docs/task-trees.md decision 12). "Stop" means the agent processes only:
// the tasks stay on the board in their columns, with their worktrees and
// uncommitted changes untouched. The processes are main's (ptySessions), so
// main does it; core only names the tasks (`listDescendants`) and records
// that a mid-turn launch was interrupted (`markLaunchesInterrupted`, the
// same marker app quit uses). Dependencies are injected so the sweep is
// unit-testable without ptys.

export interface StopTaskAgentsDeps {
  /** Whether the task's agent is live, and whether it is mid-turn (harness presence). */
  presence(taskId: string): Promise<{ live: boolean; runningTurn: boolean }>;
  /** Records launched tasks' sessions as interrupted (core). */
  markInterrupted(taskIds: string[]): Promise<void>;
  /** Signals the task's live primary pty; its own exit path retires it. `false` when there is none. */
  stop(taskId: string): boolean;
}

export interface StopTaskAgentsResult {
  /** Tasks whose app-owned agent process was signalled. */
  stopped: string[];
  /** Tasks whose agent is live but not in a pty this app owns (a terminal elsewhere): left running. */
  notStopped: string[];
}

/**
 * Stops the agents of `taskIds`. Mid-turn tasks are marked interrupted first
 * (so the board shows "interrupted", not a silent stop); a failure of that
 * bookkeeping never keeps a process running. A task with no app-owned
 * process that is not live either has nothing to stop and is not reported.
 */
export async function stopTaskAgents(
  taskIds: readonly string[],
  deps: StopTaskAgentsDeps,
): Promise<StopTaskAgentsResult> {
  const live = new Set<string>();
  const midTurn: string[] = [];
  for (const taskId of taskIds) {
    const status = await deps
      .presence(taskId)
      .catch(() => ({ live: false, runningTurn: false }));
    if (status.live) live.add(taskId);
    if (status.runningTurn) midTurn.push(taskId);
  }
  if (midTurn.length > 0) {
    await deps.markInterrupted(midTurn).catch(() => {});
  }
  const stopped: string[] = [];
  const notStopped: string[] = [];
  for (const taskId of taskIds) {
    if (deps.stop(taskId)) stopped.push(taskId);
    else if (live.has(taskId)) notStopped.push(taskId);
  }
  return { stopped, notStopped };
}
