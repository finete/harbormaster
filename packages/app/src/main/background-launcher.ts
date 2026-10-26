// Background launcher (see /docs/design-decisions.md "Launching tasks from an agent" and the wave-2 task
// brief): the single consumer of core's launch queue
// (`CoreCommands.claimPendingLaunches`). It decides how many queued launches
// can start right now and asks its (injected) I/O to start each one — a
// plain pty with no renderer attached (see `ptySessions.ts`'s
// `createBackgroundPrimarySession`).
//
// Kept pure where it matters (Engine-layer: see /docs/design-decisions.md "Layering"):
// `isWorking`/`computeCapacity` take plain data and a clock, no I/O of
// their own, so the concurrency-cap/grace-window/idle-children rules are
// unit-testable without Electron, node-pty, or core. `createBackgroundLauncher`
// wires that pure decision to injected async I/O and serializes passes so
// two trigger sources (board-changed, a presence tick, a pty exit, ...)
// firing back-to-back never run two overlapping claims against the same
// queue.
//
// The same pass also *wakes* tasks that have deliverable task messages but no
// live session (see /docs/task-messaging.md decision 5): `selectWakeTargets`
// is the pure rule (no live pane/harness session, not a queued launch, not
// attempted recently, within capacity); the launcher tracks the tasks it
// woke so they count toward `launch.maxConcurrent` exactly like started
// launches until they go idle.

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

/** A task with deliverable messages, as the wake rule sees it. */
export interface WakeCandidate {
  taskId: string;
  /** `task.launch?.status`: a `queued` task starts via the normal queue, never a wake. */
  launchStatus?: "queued" | "started" | "interrupted";
  /** The app already owns a live pty for this task. */
  hasLivePane: boolean;
  /** The harness reports a live session (ours or an external one). */
  presenceLive: boolean;
}

/** Don't wake the same task again within this window of the last attempt (a session that dies without claiming its message must not crash-loop). */
export const DEFAULT_WAKE_COOLDOWN_MS = 60_000;

/**
 * Which tasks with pending messages to wake now (decision 5), in candidate
 * order, at most `capacity`. A task is skipped when it already has a live
 * session (an app pane or live harness presence: those deliver on their
 * own), is a queued launch (the normal queue starts it and the message
 * lands right after), is mid-wake (`inFlight`), or was woken within
 * `cooldownMs`. Pure: all I/O results are inputs.
 */
export function selectWakeTargets(input: {
  candidates: readonly WakeCandidate[];
  capacity: number;
  /** Task ids whose wake is running right now. */
  inFlight: ReadonlySet<string>;
  /** Task id -> ms timestamp of its last wake attempt. */
  lastWakeAt: ReadonlyMap<string, number>;
  nowMs: number;
  cooldownMs?: number;
}): string[] {
  const cooldownMs = input.cooldownMs ?? DEFAULT_WAKE_COOLDOWN_MS;
  const picked: string[] = [];
  for (const candidate of input.candidates) {
    if (picked.length >= input.capacity) break;
    if (picked.includes(candidate.taskId)) continue;
    if (candidate.hasLivePane || candidate.presenceLive) continue;
    if (candidate.launchStatus === "queued") continue;
    if (input.inFlight.has(candidate.taskId)) continue;
    const last = input.lastWakeAt.get(candidate.taskId);
    if (last !== undefined && input.nowMs - last < cooldownMs) continue;
    picked.push(candidate.taskId);
  }
  return picked;
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
  getPresence: (taskId: string) => Promise<{
    runningTurn: boolean;
    hasPresenceRecord: boolean;
    /** The harness reports a live session; needed by the wake rule. */
    live?: boolean;
  }>;
  claimPendingLaunches: (limit: number) => Promise<LaunchQueueTask[]>;
  /** Tasks with deliverable (pending) messages (`CoreCommands.listTasksWithPendingMessages`), resolved to their launch state; unknown/deleted ids dropped. Absent: no wakes. */
  listPendingMessageTargets?: () => Promise<LaunchQueueTask[]>;
  /** Wake one message target: resume its session in the background (the same path as a launch). Must never throw past this call. */
  wakeSession?: (taskId: string) => Promise<void>;
  /** Actually start one claimed task's background session. Must never throw past this call — the launcher catches and logs, so one bad task never blocks the rest of the claimed batch. */
  startSession: (task: LaunchQueueTask) => Promise<void>;
  now?: () => number;
  graceMs?: number;
  wakeCooldownMs?: number;
  /** Test/diagnostic hook: called once per failed `startSession`/`wakeSession`. */
  onStartError?: (task: LaunchQueueTask, error: unknown) => void;
}

export interface BackgroundLauncher {
  /** Run one pass (claim + start up to current capacity, then wake message targets with what is left). Serialized: a call while a pass is already running is coalesced into exactly one rerun once it finishes, never overlapped. */
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
  /** Tasks this launcher woke: id -> wake time (ms). Counted as working like started launches while their pane lives. */
  const woken = new Map<string, number>();
  const wakeInFlight = new Set<string>();

  async function runPassOnce(): Promise<void> {
    const [settings, launched] = await Promise.all([
      deps.getLaunchSettings(),
      deps.listStartedLaunches(),
    ]);
    const now = (deps.now ?? Date.now)();
    const cooldownMs = deps.wakeCooldownMs ?? DEFAULT_WAKE_COOLDOWN_MS;
    // A woken task whose pane is gone and whose cooldown passed is forgotten.
    for (const [taskId, wokenAt] of woken) {
      if (!deps.hasLivePane(taskId) && now - wokenAt >= cooldownMs) {
        woken.delete(taskId);
      }
    }
    const byId = new Map<string, LaunchQueueTask>();
    for (const task of launched) byId.set(task.id, task);
    for (const taskId of woken.keys()) {
      if (!byId.has(taskId)) byId.set(taskId, { id: taskId });
    }
    const statuses: LaunchedTaskStatus[] = await Promise.all(
      [...byId.values()].map(async (task) => {
        const hasLivePane = deps.hasLivePane(task.id);
        const presence = await deps.getPresence(task.id);
        const wokenAt = woken.get(task.id);
        // A woken session resumes an old conversation, so a presence record
        // from its previous run can be stale: only a *live* record means
        // the new session has reported in, and the grace window runs from
        // the wake, not from the original launch.
        const startedAt =
          wokenAt !== undefined
            ? new Date(wokenAt).toISOString()
            : task.launch?.startedAt;
        return {
          taskId: task.id,
          hasLivePane,
          runningTurn: presence.runningTurn,
          hasPresenceRecord:
            wokenAt !== undefined
              ? (presence.live ?? presence.hasPresenceRecord)
              : presence.hasPresenceRecord,
          ...(startedAt ? { startedAt } : {}),
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
    await wakeMessageTargets(capacity - claimed.length, now);
  }

  async function wakeMessageTargets(
    capacity: number,
    now: number,
  ): Promise<void> {
    if (capacity <= 0 || !deps.listPendingMessageTargets || !deps.wakeSession) {
      return;
    }
    const pending = await deps.listPendingMessageTargets();
    const candidates: WakeCandidate[] = await Promise.all(
      pending.map(async (task) => {
        const presence = await deps.getPresence(task.id);
        return {
          taskId: task.id,
          ...(task.launch ? { launchStatus: task.launch.status } : {}),
          hasLivePane: deps.hasLivePane(task.id),
          presenceLive: presence.live ?? false,
        };
      }),
    );
    const targets = selectWakeTargets({
      candidates,
      capacity,
      inFlight: wakeInFlight,
      lastWakeAt: woken,
      nowMs: now,
      ...(deps.wakeCooldownMs !== undefined
        ? { cooldownMs: deps.wakeCooldownMs }
        : {}),
    });
    for (const taskId of targets) {
      wakeInFlight.add(taskId);
      woken.set(taskId, now);
      try {
        await deps.wakeSession(taskId);
      } catch (error) {
        deps.onStartError?.({ id: taskId }, error);
      } finally {
        wakeInFlight.delete(taskId);
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
