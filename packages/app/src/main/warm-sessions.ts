// Closed-tab task primaries kept warm for an instant reopen. Closing a task's
// tab detaches its pi (alive, paneless, headless screen mirror; see
// ptySessions.ts `detachPrimarySession`) instead of killing it, so reopening
// re-attaches to the same process instead of cold-starting one (session
// resume + MCP reconnect took several seconds).
//
// Bounded so opening and closing many tabs can't pile up pi processes (each
// also holds its MCP servers): only the most recently closed `capacity`
// stay warm, older ones are disposed (that session ends as it did before the
// keep-alive; a later reopen cold-starts). A mid-turn agent is never evicted:
// the cap may be exceeded briefly and is trimmed once it goes idle.
//
// A warm session whose task left the active set (moved to Done, deleted) is
// disposed on the next reconcile, so its pi never holds the worktree in
// `protectedPaths` and blocks Done's cleanup.
//
// Pure bookkeeping: every resource effect goes through the injected deps.

export interface WarmSessionDeps {
  /** True while the session is alive and detached (no pane attached). */
  isWarm(sessionId: string): boolean;
  /** The task a session is the primary of. */
  taskIdOf(sessionId: string): string | undefined;
  /** Whether that task's agent is mid-turn (never evicted while true). */
  isWorking(taskId: string): boolean;
  /** Kill the session's process and release it. */
  dispose(sessionId: string): void;
}

export const DEFAULT_WARM_SESSION_CAPACITY = 6;

export class WarmSessionCache {
  /** Oldest first. */
  private readonly order: string[] = [];

  constructor(
    private readonly deps: WarmSessionDeps,
    private readonly capacity = DEFAULT_WARM_SESSION_CAPACITY,
  ) {}

  /** A tab was closed and its session detached: keep it warm (most recent). */
  add(sessionId: string): void {
    this.remove(sessionId);
    this.order.push(sessionId);
    this.prune();
    this.trim();
  }

  /** The session got a pane again (reopened): no longer a warm closed tab. */
  forget(sessionId: string): void {
    this.remove(sessionId);
  }

  /** Dispose the task's warm session now, if any (e.g. the task is moving to Done). */
  disposeForTask(taskId: string): void {
    for (const id of [...this.order]) {
      if (this.deps.taskIdOf(id) === taskId) this.evict(id);
    }
  }

  /**
   * Periodic upkeep: drop dead/reattached entries, dispose sessions whose
   * task is no longer active, then trim to capacity (agents that were
   * working at close time may be idle now).
   */
  reconcile(activeTaskIds: ReadonlySet<string>): void {
    this.prune();
    for (const id of [...this.order]) {
      const taskId = this.deps.taskIdOf(id);
      if (!taskId || !activeTaskIds.has(taskId)) this.evict(id);
    }
    this.trim();
  }

  /** Current warm session ids, oldest first (diagnostics/tests). */
  ids(): readonly string[] {
    return [...this.order];
  }

  private prune(): void {
    for (const id of [...this.order]) {
      if (!this.deps.isWarm(id)) this.remove(id);
    }
  }

  private trim(): void {
    while (this.order.length > this.capacity) {
      const victim = this.order.find((id) => {
        const taskId = this.deps.taskIdOf(id);
        return !taskId || !this.deps.isWorking(taskId);
      });
      if (!victim) return;
      this.evict(victim);
    }
  }

  private evict(sessionId: string): void {
    this.remove(sessionId);
    this.deps.dispose(sessionId);
  }

  private remove(sessionId: string): void {
    const index = this.order.indexOf(sessionId);
    if (index !== -1) this.order.splice(index, 1);
  }
}
