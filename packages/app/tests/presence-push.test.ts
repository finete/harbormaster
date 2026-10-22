import { describe, expect, it } from "vitest";
import {
  createPushDedupe,
  createSingleFlight,
} from "../src/main/presence-push";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createSingleFlight", () => {
  it("never runs concurrently; calls mid-run coalesce into one trailing run", async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const gates: Array<() => void> = [];
    const poll = createSingleFlight(
      async () => {
        runs++;
        active++;
        maxActive = Math.max(maxActive, active);
        const gate = deferred();
        gates.push(gate.resolve);
        await gate.promise;
        active--;
      },
      () => {},
    );

    const first = poll();
    const second = poll();
    const third = poll();
    expect(runs).toBe(1);
    gates.shift()?.();
    await new Promise((r) => setImmediate(r));
    expect(runs).toBe(2); // exactly one trailing run for both mid-run calls
    gates.shift()?.();
    await Promise.all([first, second, third]);
    expect(runs).toBe(2);
    expect(maxActive).toBe(1);

    // Idle again: the next call starts a fresh run.
    const fourth = poll();
    expect(runs).toBe(3);
    gates.shift()?.();
    await fourth;
  });

  it("reports a failed run via onError instead of rejecting, and keeps working", async () => {
    const errors: unknown[] = [];
    let fail = true;
    let runs = 0;
    const poll = createSingleFlight(
      async () => {
        runs++;
        if (fail) throw new Error("listBoard failed");
      },
      (error) => errors.push(error),
    );
    await expect(poll()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    fail = false;
    await poll();
    expect(runs).toBe(2);
    expect(errors).toHaveLength(1);
  });
});

describe("createPushDedupe", () => {
  it("suppresses an identical payload per target, sends a changed one", () => {
    let now = 0;
    const dedupe = createPushDedupe({ maxSuppressMs: 30_000, now: () => now });
    expect(dedupe.shouldSend(1, '{"a":1}')).toBe(true);
    now += 5_000;
    expect(dedupe.shouldSend(1, '{"a":1}')).toBe(false);
    expect(dedupe.shouldSend(2, '{"a":1}')).toBe(true); // other window
    expect(dedupe.shouldSend(1, '{"a":2}')).toBe(true);
    expect(dedupe.shouldSend(1, '{"a":2}')).toBe(false);
  });

  it("re-sends after reset (a reloaded renderer) and after maxSuppressMs", () => {
    let now = 0;
    const dedupe = createPushDedupe({ maxSuppressMs: 30_000, now: () => now });
    expect(dedupe.shouldSend(1, "x")).toBe(true);
    dedupe.reset(1);
    expect(dedupe.shouldSend(1, "x")).toBe(true);
    now += 29_999;
    expect(dedupe.shouldSend(1, "x")).toBe(false);
    now += 1;
    expect(dedupe.shouldSend(1, "x")).toBe(true);
  });
});
