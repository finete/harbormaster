import { afterEach, describe, expect, it, vi } from "vitest";
import { createSharedStore } from "../src/renderer/src/lib/shared-store";
import { sharedClock } from "../src/renderer/src/lib/use-now";

function fakeSource<T>() {
  const calls = { start: 0, stop: 0 };
  let emit: ((value: T) => void) | null = null;
  const start = (set: (value: T) => void) => {
    calls.start++;
    emit = set;
    return () => {
      calls.stop++;
      emit = null;
    };
  };
  return { calls, start, push: (value: T) => emit?.(value) };
}

describe("createSharedStore", () => {
  it("opens exactly one underlying subscription for N subscribers and closes at zero", () => {
    const source = fakeSource<number[]>();
    const store = createSharedStore<number[]>([], source.start);
    expect(source.calls.start).toBe(0); // lazy: nothing at creation

    const unsubs = Array.from({ length: 5 }, () => store.subscribe(() => {}));
    expect(source.calls.start).toBe(1);
    expect(store.subscriberCount()).toBe(5);

    for (const unsub of unsubs.slice(0, 4)) unsub();
    expect(source.calls.stop).toBe(0);
    unsubs[4]?.();
    expect(source.calls.stop).toBe(1);
    expect(store.subscriberCount()).toBe(0);

    // Double-unsubscribe is harmless; resubscribing restarts once.
    unsubs[4]?.();
    expect(source.calls.stop).toBe(1);
    const again = store.subscribe(() => {});
    expect(source.calls.start).toBe(2);
    again();
    expect(source.calls.stop).toBe(2);
  });

  it("notifies every subscriber on a changed payload and keeps the snapshot reference on an equal one", () => {
    const source = fakeSource<Record<string, { runningTurn: boolean }>>();
    const store = createSharedStore<Record<string, { runningTurn: boolean }>>(
      {},
      source.start,
    );
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);

    source.push({ t1: { runningTurn: true } });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    const snapshot = store.getSnapshot();

    // Structurally equal (fresh object, as every IPC push is): no notify.
    source.push({ t1: { runningTurn: true } });
    expect(a).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(snapshot);

    source.push({ t1: { runningTurn: false } });
    expect(a).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toEqual({ t1: { runningTurn: false } });
  });

  it("ignores a late value from a stopped source session", () => {
    const firstSet: Array<(value: number) => void> = [];
    const store = createSharedStore<number>(0, (set) => {
      firstSet.push(set);
      return () => {};
    });
    store.subscribe(() => {})();
    store.subscribe(() => {});
    firstSet[0]?.(42);
    expect(store.getSnapshot()).toBe(0);
    firstSet[1]?.(7);
    expect(store.getSnapshot()).toBe(7);
  });
});

describe("sharedClock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs one interval for any number of subscribers and clears it at zero", () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const clock = sharedClock(12_345);
    const listeners = [vi.fn(), vi.fn(), vi.fn()];
    const unsubs = listeners.map((l) => clock.subscribe(l));
    expect(setSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(12_345);
    for (const l of listeners) expect(l).toHaveBeenCalled();
    expect(clock.getSnapshot()).toBe(Date.now());

    unsubs[0]?.();
    unsubs[1]?.();
    expect(clearSpy).not.toHaveBeenCalled();
    unsubs[2]?.();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // Same interval -> same shared clock instance.
    expect(sharedClock(12_345)).toBe(clock);
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });
});
