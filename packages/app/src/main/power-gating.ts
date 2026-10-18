// Testable core of sleep/wake timer gating. Touches no Electron API
// directly: main's wiring hands this `powerMonitor.on('suspend'/'resume')`
// (or a fake emitter in tests) plus the start/stop pair for whatever timers
// should pause while the machine is asleep (refresh loop, presence poll).
// The real `powerMonitor` suspend/resume events are main-process-only and
// exercised for real only by hand (sleep the laptop, see power-gating's
// callers in main/index.ts) — this module's state machine is what the unit
// test in power-gating.test.ts exercises under fake timers.
export interface PowerGatingDeps {
  /** Register a suspend handler (e.g. `powerMonitor.on("suspend", cb)`). */
  onSuspend(cb: () => void): void;
  /** Register a resume handler (e.g. `powerMonitor.on("resume", cb)`). */
  onResume(cb: () => void): void;
  /** Stop every timer this gating controls. */
  stopAll(): void;
  /** Restart every timer this gating controls. */
  startAll(): void;
  /**
   * Resume doesn't restart timers immediately: the network interface needs
   * a beat to come back up after wake, so an immediate gh call would just
   * fail the way it did before this feature existed. Default 3_000ms.
   */
  wakeGraceMs?: number;
  /** Injectable timer fns for tests; default to the real globals. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/** Wires suspend → stop, resume → stop-pending-restart then start after the wake grace. */
export function wirePowerGating(deps: PowerGatingDeps): void {
  const schedule = deps.setTimeoutFn ?? setTimeout;
  const unschedule = deps.clearTimeoutFn ?? clearTimeout;
  const wakeGraceMs = deps.wakeGraceMs ?? 3_000;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;

  deps.onSuspend(() => {
    if (resumeTimer !== undefined) {
      unschedule(resumeTimer);
      resumeTimer = undefined;
    }
    deps.stopAll();
  });

  deps.onResume(() => {
    if (resumeTimer !== undefined) unschedule(resumeTimer);
    resumeTimer = schedule(() => {
      resumeTimer = undefined;
      deps.startAll();
    }, wakeGraceMs);
  });
}
