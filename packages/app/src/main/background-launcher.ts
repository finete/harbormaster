// Background launcher (see /ai/prds/task-launching.md and the wave-2 task
// brief): the single consumer of core's launch queue
// (`CoreCommands.claimPendingLaunches`). It decides how many queued launches
// can start right now and asks its (injected) I/O to start each one — a
// plain pty with no renderer attached (see `ptySessions.ts`'s
// `createBackgroundPrimarySession`).
//
// Kept pure where it matters (Engine-layer: see /ai/prds/architecture.md):
// `isWorking`/`computeCapacity` take plain data and a clock, no I/O of
// their own, so the concurrency-cap/grace-window/idle-children rules are
// unit-testable without Electron, node-pty, or core. `createBackgroundLauncher`
// wires that pure decision to injected async I/O and serializes passes so
// two trigger sources (board-changed, a presence tick, a pty exit, ...)
// firing back-to-back never run two overlapping claims against the same
// queue.

/** One launched (`task.launch.status === "started"`) task's working-ness inputs for one pass. */
export interface LaunchedTaskStatus {
  taskId: string;
  /** Whether this task's primary pane is a live app-owned pty right now (attached or not — see `ptySessions.lookupPanePid`). */
  hasLivePane: boolean;
  /** Whether the harness reports a turn running right now for this task. */
  runningTurn: boolean;
  /** Whether a presence record has ever been registered for this task (see `PresenceStatus.record`). */
  hasPresenceRecord: boolean;
  /** `task.launch.startedAt` (ISO), when known. */
  startedAt?: string;
}

/** Default grace window: a just-started session with no presence record yet still counts as working. */
export const DEFAULT_STARTUP_GRACE_MS = 90_000;

/**
 * Whether one launched task counts toward the concurrency cap right now.
 * Idle "your move" children (a live pane, a presence record, but no turn
 * running) do NOT count — only a live pane that is actually mid-turn, or a
 * just-started session so new the harness hasn't registered presence yet.
 */
export function isWorking(
  status: LaunchedTaskStatus,
  nowMs: number,
  graceMs: number = DEFAULT_STARTUP_GRACE_MS,
): boolean {
  if (!status.hasLivePane) return false;
  if (status.runningTurn) return true;
  // A presence record exists but no turn is running: the harness has
  // reported in and the task is idle (finished a turn, waiting on the
  // user) — never "working", no matter how recently it started.
  if (status.hasPresenceRecord) return false;
  if (!status.startedAt) return false;
  const startedMs = Date.parse(status.startedAt);
  if (Number.isNaN(startedMs)) return false;
  return nowMs - startedMs < graceMs;
}

/** `maxConcurrent` minus the number of currently-working launched tasks, floored at 0. */
export function computeCapacity(
  maxConcurrent: number,
  statuses: readonly LaunchedTaskStatus[],
  nowMs: number,
  graceMs?: number,
): number {
  const working = statuses.filter((status) =>
    isWorking(status, nowMs, graceMs),
  ).length;
  return Math.max(0, maxConcurrent - working);
}

/** Core's launch-queue task shape this module needs — kept structural so this file never imports `@harbormaster/core` itself. */
export interface LaunchQueueTask {
  id: string;
  launch?: { status: "queued" | "started" | "interrupted"; startedAt?: string };
}

export interface BackgroundLauncherDeps {
  /** Every currently-`started` launched task, for the working/capacity computation. */
  listStartedLaunches: () => Promise<LaunchQueueTask[]>;
  getLaunchSettings: () => Promise<{ maxConcurrent: number }>;
  /** The app's own pane-pid registry (see `ptySessions.lookupPanePid`); sync, no I/O. */
  hasLivePane: (taskId: string) => boolean;
  /** Harness presence for one task (see `PiHarnessAdapter.presence`). */
  getPresence: (
    taskId: string,
  ) => Promise<{ runningTurn: boolean; hasPresenceRecord: boolean }>;
  claimPendingLaunches: (limit: number) => Promise<LaunchQueueTask[]>;
  /** Actually start one claimed task's background session. Must never throw past this call — the launcher catches and logs, so one bad task never blocks the rest of the claimed batch. */
  startSession: (task: LaunchQueueTask) => Promise<void>;
  now?: () => number;
  graceMs?: number;
  /** Test/diagnostic hook: called once per failed `startSession`. */
  onStartError?: (task: LaunchQueueTask, error: unknown) => void;
}

export interface BackgroundLauncher {
  /** Run one pass (claim + start up to current capacity). Serialized: a call while a pass is already running is coalesced into exactly one rerun once it finishes, never overlapped. */
  runPass: () => Promise<void>;
}

/**
 * Wires the pure capacity decision to injected I/O, with pass
 * serialization: every trigger (app ready, board-changed, a state-file
 * watcher push, a presence poll tick, a pty exit) calls `runPass()`; a call
 * arriving while a pass is already in flight is coalesced into a single
 * rerun immediately after, so the queue is never claimed from twice
 * concurrently and a burst of triggers never runs more than one extra pass.
 */
export function createBackgroundLauncher(
  deps: BackgroundLauncherDeps,
): BackgroundLauncher {
  let running = false;
  let rerunRequested = false;

  async function runPassOnce(): Promise<void> {
    const [settings, launched] = await Promise.all([
      deps.getLaunchSettings(),
      deps.listStartedLaunches(),
    ]);
    const now = (deps.now ?? Date.now)();
    const statuses: LaunchedTaskStatus[] = await Promise.all(
      launched.map(async (task) => {
        const hasLivePane = deps.hasLivePane(task.id);
        const presence = await deps.getPresence(task.id);
        return {
          taskId: task.id,
          hasLivePane,
          runningTurn: presence.runningTurn,
          hasPresenceRecord: presence.hasPresenceRecord,
          ...(task.launch?.startedAt
            ? { startedAt: task.launch.startedAt }
            : {}),
        };
      }),
    );
    const capacity = computeCapacity(
      settings.maxConcurrent,
      statuses,
      now,
      deps.graceMs,
    );
    if (capacity <= 0) return;
    const claimed = await deps.claimPendingLaunches(capacity);
    for (const task of claimed) {
      try {
        await deps.startSession(task);
      } catch (error) {
        deps.onStartError?.(task, error);
      }
    }
  }

  async function runPass(): Promise<void> {
    if (running) {
      rerunRequested = true;
      return;
    }
    running = true;
    try {
      await runPassOnce();
    } finally {
      running = false;
      if (rerunRequested) {
        rerunRequested = false;
        // Deliberately not awaited by the caller that triggered this rerun:
        // the original `runPass()` call that found `running` true already
        // returned; this is a fresh, independent pass.
        void runPass();
      }
    }
  }

  return { runPass };
}
