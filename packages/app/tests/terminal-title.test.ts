// Live tab-title throttle (perf sweep): a streaming agent's OSC title
// bursts collapse to at most one dockview setTitle per interval (each one
// also re-saves the workspace layout), first title immediate, latest wins,
// unchanged titles never re-applied.
import { describe, expect, it } from "vitest";
import { createTitleThrottle } from "../src/renderer/src/lib/terminal-title";

function harness(initial?: string) {
  let clock = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const applied: string[] = [];
  const throttle = createTitleThrottle((title) => applied.push(title), {
    intervalMs: 100,
    ...(initial !== undefined ? { initial } : {}),
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { at: clock + ms, fn };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const advance = (ms: number): void => {
    clock += ms;
    for (const timer of [...timers]) {
      if (timer.at <= clock) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fn();
      }
    }
  };
  return { throttle, applied, advance, pendingTimers: () => timers.length };
}

describe("createTitleThrottle", () => {
  it("applies the first title immediately", () => {
    const { throttle, applied } = harness("π");
    throttle.update("π task");
    expect(applied).toEqual(["π task"]);
  });

  it("collapses a burst to one trailing apply of the latest title", () => {
    const { throttle, applied, advance } = harness("π");
    throttle.update("t1");
    throttle.update("t2");
    throttle.update("t3");
    throttle.update("t4");
    expect(applied).toEqual(["t1"]);
    advance(99);
    expect(applied).toEqual(["t1"]);
    advance(1);
    expect(applied).toEqual(["t1", "t4"]);
  });

  it("skips titles identical to the one already shown", () => {
    const { throttle, applied, advance } = harness("π");
    throttle.update("π");
    expect(applied).toEqual([]);
    throttle.update("a");
    advance(200);
    throttle.update("a");
    advance(200);
    expect(applied).toEqual(["a"]);
  });

  it("applies immediately again after a quiet interval", () => {
    const { throttle, applied, advance } = harness();
    throttle.update("a");
    advance(150);
    throttle.update("b");
    expect(applied).toEqual(["a", "b"]);
  });

  it("dispose cancels a pending trailing apply", () => {
    const { throttle, applied, advance, pendingTimers } = harness();
    throttle.update("a");
    throttle.update("b");
    expect(pendingTimers()).toBe(1);
    throttle.dispose();
    advance(500);
    expect(applied).toEqual(["a"]);
  });
});
