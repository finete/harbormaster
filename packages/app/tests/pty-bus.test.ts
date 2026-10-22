/**
 * Preload pty routing: one underlying IPC listener per channel no matter how
 * many panes subscribe, chunks delivered only to their session's listeners.
 */
import { describe, expect, it, vi } from "vitest";
import { createIdRouter } from "../src/preload/pty-bus";

interface DataEvent {
  id: string;
  data: string;
}

function fakeChannel<E>() {
  const handlers = new Set<(e: E) => void>();
  const subscribe = vi.fn((dispatch: (e: E) => void) => {
    handlers.add(dispatch);
    return () => handlers.delete(dispatch);
  });
  return {
    subscribe,
    emit: (e: E) => {
      for (const h of handlers) h(e);
    },
    handlerCount: () => handlers.size,
  };
}

describe("createIdRouter", () => {
  it("holds one underlying listener regardless of subscriber count", () => {
    const ch = fakeChannel<DataEvent>();
    const router = createIdRouter<DataEvent>(ch.subscribe);
    expect(ch.handlerCount()).toBe(0); // lazy

    const unsubs = Array.from({ length: 12 }, (_, i) =>
      router.on(() => {}, `s${i % 4}`),
    );
    unsubs.push(router.on(() => {}));
    expect(ch.subscribe).toHaveBeenCalledTimes(1);
    expect(ch.handlerCount()).toBe(1);
    expect(router.listenerCount()).toBe(13);
    for (const u of unsubs) u();
  });

  it("routes each event only to its session's listeners (plus unfiltered)", () => {
    const ch = fakeChannel<DataEvent>();
    const router = createIdRouter<DataEvent>(ch.subscribe);
    const a = vi.fn();
    const a2 = vi.fn();
    const b = vi.fn();
    const all = vi.fn();
    router.on(a, "a");
    router.on(a2, "a");
    router.on(b, "b");
    router.on(all);

    ch.emit({ id: "a", data: "x" });
    expect(a).toHaveBeenCalledWith({ id: "a", data: "x" });
    expect(a2).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(all).toHaveBeenCalledTimes(1);

    ch.emit({ id: "zzz", data: "y" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(all).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe stops delivery, is idempotent, and releases the IPC listener when empty", () => {
    const ch = fakeChannel<DataEvent>();
    const router = createIdRouter<DataEvent>(ch.subscribe);
    const a = vi.fn();
    const b = vi.fn();
    const offA = router.on(a, "a");
    const offB = router.on(b, "b");

    offA();
    offA(); // idempotent: must not remove anything else
    ch.emit({ id: "a", data: "x" });
    ch.emit({ id: "b", data: "y" });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(ch.handlerCount()).toBe(1);

    offB();
    expect(ch.handlerCount()).toBe(0);
    expect(router.listenerCount()).toBe(0);

    // Re-subscribing re-attaches exactly one listener.
    const c = vi.fn();
    router.on(c, "a");
    expect(ch.subscribe).toHaveBeenCalledTimes(2);
    expect(ch.handlerCount()).toBe(1);
    ch.emit({ id: "a", data: "z" });
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("routes exit events by id the same way", () => {
    const ch = fakeChannel<{ id: string; exitCode: number }>();
    const router = createIdRouter<{ id: string; exitCode: number }>(
      ch.subscribe,
    );
    const a = vi.fn();
    const b = vi.fn();
    router.on(a, "a");
    router.on(b, "b");
    ch.emit({ id: "b", exitCode: 3 });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith({ id: "b", exitCode: 3 });
  });

  it("a listener unsubscribing during dispatch does not break delivery", () => {
    const ch = fakeChannel<DataEvent>();
    const router = createIdRouter<DataEvent>(ch.subscribe);
    const second = vi.fn();
    const off = router.on(() => off(), "a");
    router.on(second, "a");
    ch.emit({ id: "a", data: "x" });
    expect(second).toHaveBeenCalledTimes(1);
  });
});
