// Testable core of the refresh loop's offline gating. Touches no Electron
// API directly: main's wiring hands this `net.isOnline` and a refresh
// function, so the online/offline/reconnecting/restored state machine runs
// under injected fake timers in a unit test instead of needing a real
// Electron process (powerMonitor/net are main-process-only and exercised
// for real only by hand — see connectivity-loop.test.ts).
//
// Design (industry-consensus offline-state pattern, not per-operation error
// toasts): offline is one environmental state, not a warning per failed
// task. While offline the loop ticks cheaply (every `offlineIntervalMs`) so
// recovery is noticed fast without hammering gh; once online it falls back
// to the normal cadence. `runOnce()` lets a manually-triggered refresh (the
// board's "g"/Refresh button) go through the exact same state machine as
// the timer, so a manual refresh while offline shows the same banner
// instead of silently skipping connectivity classification.
export type ConnectivityState =
  | "online"
  | "offline"
  | "reconnecting"
  | "restored";

export interface RefreshOutcome {
  /** True when this tick's refresh saw a connectivity-class failure (core's `refresh().connectivity`). */
  offline: boolean;
  /** Non-connectivity warnings from this tick, if any (passed through for the manual-refresh IPC caller). */
  warnings: string[];
}

export interface ConnectivityLoopDeps {
  /** Electron's `net.isOnline()` (or a fake in tests): a fast local hint, no network round trip. */
  isOnline(): boolean;
  /** Runs one refresh tick; only called while `isOnline()` is true. */
  performRefresh(): Promise<RefreshOutcome>;
  /** Called whenever the externally-visible state changes. */
  onStateChange(state: ConnectivityState): void;
  /** Normal cadence while online and healthy (ms). Default 30_000. */
  normalIntervalMs?: number;
  /** Cheap cadence while offline, so recovery is noticed fast (ms). Default 10_000. */
  offlineIntervalMs?: number;
  /** Injectable timer fns for tests; default to the real globals. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface ConnectivityLoop {
  start(): void;
  stop(): void;
  /** Runs one tick immediately (cancels any pending scheduled tick, reschedules after), returning its outcome. */
  runOnce(): Promise<RefreshOutcome>;
  /** Current externally-visible state, for tests/inspection. */
  state(): ConnectivityState;
}

export function createConnectivityLoop(
  deps: ConnectivityLoopDeps,
): ConnectivityLoop {
  const normalIntervalMs = deps.normalIntervalMs ?? 30_000;
  const offlineIntervalMs = deps.offlineIntervalMs ?? 10_000;
  const schedule = deps.setTimeoutFn ?? setTimeout;
  const unschedule = deps.clearTimeoutFn ?? clearTimeout;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let currentState: ConnectivityState = "online";
  // Sticky until a clean tick reports restored, so a long run of offline
  // ticks (each independently "offline") still ends in exactly one
  // "restored" the moment connectivity comes back.
  let wasDisrupted = false;

  function setState(next: ConnectivityState): void {
    if (currentState === next) return;
    currentState = next;
    deps.onStateChange(next);
  }

  function clearTimer(): void {
    if (timer !== undefined) unschedule(timer);
    timer = undefined;
  }

  function scheduleNext(ms: number): void {
    clearTimer();
    if (!running) return;
    timer = schedule(() => {
      void runScheduledTick();
    }, ms);
  }

  async function runTick(): Promise<RefreshOutcome> {
    if (!deps.isOnline()) {
      wasDisrupted = true;
      setState("offline");
      return { offline: true, warnings: [] };
    }
    // A retry while we were previously offline gets its own visible state
    // ("Reconnecting…") so a successful-but-slow gh call doesn't look stuck
    // on the plain offline banner.
    if (wasDisrupted) setState("reconnecting");
    let outcome: RefreshOutcome;
    try {
      outcome = await deps.performRefresh();
    } catch {
      // A hard failure here is not connectivity-classified (those come back
      // as `{ offline: true, ... }`, never a throw) — main's own problem;
      // the loop keeps ticking at the normal cadence either way.
      outcome = { offline: false, warnings: [] };
    }
    if (outcome.offline) {
      wasDisrupted = true;
      setState("offline");
      return outcome;
    }
    if (wasDisrupted) {
      wasDisrupted = false;
      setState("restored");
    } else {
      setState("online");
    }
    return outcome;
  }

  async function runScheduledTick(): Promise<void> {
    if (!running) return;
    const outcome = await runTick();
    if (!running) return;
    scheduleNext(outcome.offline ? offlineIntervalMs : normalIntervalMs);
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      void runScheduledTick();
    },
    stop(): void {
      running = false;
      clearTimer();
    },
    async runOnce(): Promise<RefreshOutcome> {
      // A manual refresh takes over the schedule: cancel whatever was
      // pending, run right now, then resume ticking from this point.
      clearTimer();
      const outcome = await runTick();
      if (running) {
        scheduleNext(outcome.offline ? offlineIntervalMs : normalIntervalMs);
      }
      return outcome;
    },
    state(): ConnectivityState {
      return currentState;
    },
  };
}
