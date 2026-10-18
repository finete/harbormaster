import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConnectivityState,
  createConnectivityLoop,
} from "../src/main/connectivity-loop";

describe("createConnectivityLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips the refresh call entirely while isOnline() is false, polling cheaply", async () => {
    const states: ConnectivityState[] = [];
    const performRefresh = vi.fn();
    const loop = createConnectivityLoop({
      isOnline: () => false,
      performRefresh,
      onStateChange: (state) => states.push(state),
      normalIntervalMs: 30_000,
      offlineIntervalMs: 10_000,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(performRefresh).not.toHaveBeenCalled();
    expect(states).toEqual(["offline"]);
    expect(loop.state()).toBe("offline");

    // Still offline 10s later: another cheap tick, no gh call, no repeated
    // "offline" announcement (dedupe on unchanged state).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(performRefresh).not.toHaveBeenCalled();
    expect(states).toEqual(["offline"]);

    loop.stop();
  });

  it("goes online -> offline -> reconnecting -> restored -> online as connectivity recovers", async () => {
    const states: ConnectivityState[] = [];
    let online = true;
    let offline = false;
    const performRefresh = vi.fn(async () => ({ offline, warnings: [] }));
    const loop = createConnectivityLoop({
      isOnline: () => online,
      performRefresh,
      onStateChange: (state) => states.push(state),
      normalIntervalMs: 30_000,
      offlineIntervalMs: 10_000,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(performRefresh).toHaveBeenCalledTimes(1);
    expect(states).toEqual([]); // healthy from the start: no "online" spam
    expect(loop.state()).toBe("online");

    // The machine goes offline: the local check short-circuits the gh call.
    online = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(states).toEqual(["offline"]);
    expect(performRefresh).toHaveBeenCalledTimes(1);

    // Local network is back, but gh itself still fails with a connectivity
    // error (core's refresh() classified it): "reconnecting" then back to
    // "offline" for this tick.
    online = true;
    offline = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states).toEqual(["offline", "reconnecting", "offline"]);

    // Next tick succeeds clean: "restored".
    offline = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states).toEqual([
      "offline",
      "reconnecting",
      "offline",
      "reconnecting",
      "restored",
    ]);
    expect(loop.state()).toBe("restored");

    loop.stop();
  });

  it("treats a thrown performRefresh as non-connectivity and keeps the normal cadence", async () => {
    const states: ConnectivityState[] = [];
    const performRefresh = vi.fn().mockRejectedValue(new Error("boom"));
    const loop = createConnectivityLoop({
      isOnline: () => true,
      performRefresh,
      onStateChange: (state) => states.push(state),
      normalIntervalMs: 30_000,
      offlineIntervalMs: 10_000,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual([]);
    expect(loop.state()).toBe("online");

    loop.stop();
  });

  it("stop() prevents any further ticks", async () => {
    const performRefresh = vi.fn(async () => ({
      offline: false,
      warnings: [],
    }));
    const loop = createConnectivityLoop({
      isOnline: () => true,
      performRefresh,
      onStateChange: () => {},
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    loop.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(performRefresh).toHaveBeenCalledTimes(1);
  });

  it("start() is idempotent", async () => {
    const performRefresh = vi.fn(async () => ({
      offline: false,
      warnings: [],
    }));
    const loop = createConnectivityLoop({
      isOnline: () => true,
      performRefresh,
      onStateChange: () => {},
    });
    loop.start();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(performRefresh).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it("runOnce() runs immediately, cancels a pending scheduled tick, and reschedules from there", async () => {
    const states: ConnectivityState[] = [];
    const performRefresh = vi
      .fn()
      .mockResolvedValueOnce({ offline: false, warnings: ["task: nope"] })
      .mockResolvedValue({ offline: false, warnings: [] });
    const loop = createConnectivityLoop({
      isOnline: () => true,
      performRefresh,
      onStateChange: (state) => states.push(state),
      normalIntervalMs: 30_000,
      offlineIntervalMs: 10_000,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(performRefresh).toHaveBeenCalledTimes(1);

    const outcome = await loop.runOnce();
    expect(outcome).toEqual({ offline: false, warnings: [] });
    expect(performRefresh).toHaveBeenCalledTimes(2);

    // The pending 30s timer from start() was cancelled by runOnce(): only
    // one more tick happens at 30s from the manual call, not two.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(performRefresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(performRefresh).toHaveBeenCalledTimes(3);

    loop.stop();
  });
});
