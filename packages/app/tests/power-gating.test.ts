import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wirePowerGating } from "../src/main/power-gating";

/** Fake powerMonitor: captures the registered handlers so a test can fire them directly. */
function fakeEmitter() {
  const handlers: Record<string, (() => void)[]> = { suspend: [], resume: [] };
  return {
    onSuspend: (cb: () => void) => handlers.suspend.push(cb),
    onResume: (cb: () => void) => handlers.resume.push(cb),
    suspend: () => {
      for (const cb of handlers.suspend) cb();
    },
    resume: () => {
      for (const cb of handlers.resume) cb();
    },
  };
}

describe("wirePowerGating", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stops all timers immediately on suspend", () => {
    const emitter = fakeEmitter();
    const stopAll = vi.fn();
    const startAll = vi.fn();
    wirePowerGating({
      onSuspend: emitter.onSuspend,
      onResume: emitter.onResume,
      stopAll,
      startAll,
      wakeGraceMs: 3_000,
    });

    emitter.suspend();
    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(startAll).not.toHaveBeenCalled();
  });

  it("restarts all timers only after the wake grace elapses", () => {
    const emitter = fakeEmitter();
    const stopAll = vi.fn();
    const startAll = vi.fn();
    wirePowerGating({
      onSuspend: emitter.onSuspend,
      onResume: emitter.onResume,
      stopAll,
      startAll,
      wakeGraceMs: 3_000,
    });

    emitter.suspend();
    emitter.resume();
    expect(startAll).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_999);
    expect(startAll).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(startAll).toHaveBeenCalledTimes(1);
  });

  it("a second suspend before the grace elapses cancels the pending restart", () => {
    const emitter = fakeEmitter();
    const stopAll = vi.fn();
    const startAll = vi.fn();
    wirePowerGating({
      onSuspend: emitter.onSuspend,
      onResume: emitter.onResume,
      stopAll,
      startAll,
      wakeGraceMs: 3_000,
    });

    emitter.resume();
    emitter.suspend();
    vi.advanceTimersByTime(10_000);
    expect(startAll).not.toHaveBeenCalled();
    expect(stopAll).toHaveBeenCalledTimes(1);
  });

  it("defaults the wake grace to 3s when not provided", () => {
    const emitter = fakeEmitter();
    const stopAll = vi.fn();
    const startAll = vi.fn();
    wirePowerGating({
      onSuspend: emitter.onSuspend,
      onResume: emitter.onResume,
      stopAll,
      startAll,
    });

    emitter.resume();
    vi.advanceTimersByTime(2_999);
    expect(startAll).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(startAll).toHaveBeenCalledTimes(1);
  });
});
