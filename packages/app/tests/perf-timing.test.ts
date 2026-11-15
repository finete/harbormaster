import { afterEach, describe, expect, it } from "vitest";
import {
  debugLog,
  debugLoggingRequested,
  setDebugLoggingForTests,
} from "../src/main/debug-log";
import { createIpcTiming, formatSlowIpcLine } from "../src/main/ipc-timing";
import {
  createPassTimer,
  formatPassLine,
  shouldLogPass,
} from "../src/main/pass-timer";
import { createPtyTraffic } from "../src/main/pty-traffic";

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("pass timer", () => {
  it("formats pass lines", () => {
    expect(formatPassLine("listBoard", 12.4, 30)).toBe(
      "[pass] listBoard ms=12 items=30",
    );
    expect(formatPassLine("refresh", 5, undefined, true)).toBe(
      "[pass] refresh ms=5 failed=true",
    );
  });

  it("logs first, slow and always-logged runs; the rest go to debug", () => {
    expect(shouldLogPass({ name: "presence", ms: 1, firstRun: true })).toBe(
      true,
    );
    expect(shouldLogPass({ name: "presence", ms: 1, firstRun: false })).toBe(
      false,
    );
    expect(shouldLogPass({ name: "presence", ms: 150, firstRun: false })).toBe(
      true,
    );
    expect(shouldLogPass({ name: "refresh", ms: 1, firstRun: false })).toBe(
      true,
    );
  });

  it("times runs, tracks in-flight passes and drains per-window stats", async () => {
    const c = clock();
    const logged: string[] = [];
    const debugged: string[] = [];
    const timer = createPassTimer({
      now: c.now,
      log: (l) => logged.push(l),
      debug: (l) => debugged.push(l),
    });
    let release: () => void = () => {};
    const pending = timer.run(
      "presence",
      () =>
        new Promise<number[]>((resolve) => {
          release = () => resolve([1, 2, 3]);
        }),
      (r) => r.length,
    );
    expect(timer.running()).toEqual(["presence"]);
    c.advance(40);
    release();
    await pending;
    expect(timer.running()).toEqual([]);
    await timer.run("presence", async () => 0);
    await expect(
      timer.run("presence", async () => {
        c.advance(7);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(logged).toEqual(["[pass] presence ms=40 items=3"]);
    expect(debugged).toEqual([
      "[pass] presence ms=0",
      "[pass] presence ms=7 failed=true",
    ]);
    expect(timer.drainStats()).toEqual({
      presence: { n: 3, maxMs: 40, totalMs: 47, failed: 1 },
    });
    expect(timer.drainStats()).toEqual({});
  });
});

describe("ipc timing", () => {
  it("patches handle once, tracks in-flight channels and logs slow handlers", async () => {
    const c = clock();
    const logged: string[] = [];
    const debugged: string[] = [];
    const timing = createIpcTiming({
      now: c.now,
      log: (l) => logged.push(l),
      debug: (l) => debugged.push(l),
    });
    const registered = new Map<string, (...args: unknown[]) => unknown>();
    const target = {
      handle(channel: string, listener: (...args: unknown[]) => unknown) {
        registered.set(channel, listener);
      },
    };
    timing.install(target);
    timing.install(target); // idempotent: no double wrapping
    const releases: Array<() => void> = [];
    target.handle(
      "core:slow",
      () =>
        new Promise<string>((resolve) => {
          releases.push(() => resolve("ok"));
        }),
    );
    target.handle("core:fast", (_event: unknown, x: unknown) => x);
    target.handle("core:bad", () => {
      throw new Error("nope");
    });

    const slow1 = registered.get("core:slow")?.({});
    const slow2 = registered.get("core:slow")?.({});
    expect(timing.inFlight()).toEqual(["core:slow×2"]);
    c.advance(250);
    for (const release of releases) release();
    await Promise.all([slow1, slow2]);
    expect(timing.inFlight()).toEqual([]);
    expect(await registered.get("core:fast")?.({}, 5)).toBe(5);
    await expect(registered.get("core:bad")?.({})).rejects.toThrow("nope");

    expect(logged).toEqual([
      formatSlowIpcLine("core:slow", 250),
      formatSlowIpcLine("core:slow", 250),
    ]);
    expect(logged[0]).toBe("[ipc] slow core:slow ms=250");
    expect(debugged).toEqual(["core:fast ms=0", "core:bad ms=0 failed"]);
  });
});

describe("pty traffic", () => {
  it("totals bytes per window and ranks the top sessions", () => {
    const traffic = createPtyTraffic(() => 0);
    traffic.record("a", "t1", 100, 0);
    traffic.record("b", undefined, 500, 0);
    traffic.record("a", "t1", 50, 0);
    traffic.record("c", "t3", 10, 0);
    traffic.record("d", "t4", 1, 0);
    expect(traffic.drainWindow(3)).toEqual({
      totalBytes: 661,
      top: [
        { sessionId: "b", taskId: undefined, bytes: 500 },
        { sessionId: "a", taskId: "t1", bytes: 150 },
        { sessionId: "c", taskId: "t3", bytes: 10 },
      ],
    });
    expect(traffic.drainWindow()).toEqual({ totalBytes: 0, top: [] });
  });

  it("counts only the last second for spike lines", () => {
    const traffic = createPtyTraffic();
    traffic.record("a", undefined, 100, 10_000);
    traffic.record("a", undefined, 200, 10_550);
    expect(traffic.lastSecondBytes(10_600)).toBe(300);
    expect(traffic.lastSecondBytes(10_950)).toBe(300);
    expect(traffic.lastSecondBytes(11_050)).toBe(200);
    expect(traffic.lastSecondBytes(20_000)).toBe(0);
    // A bucket slot reused a lap later starts from zero.
    traffic.record("a", undefined, 7, 11_000);
    expect(traffic.lastSecondBytes(11_000)).toBe(207);
  });
});

describe("debug switch", () => {
  afterEach(() => setDebugLoggingForTests(undefined));

  it("reads HARBORMASTER_LOG=debug", () => {
    expect(debugLoggingRequested({ HARBORMASTER_LOG: "debug" })).toBe(true);
    expect(debugLoggingRequested({ HARBORMASTER_LOG: " DEBUG " })).toBe(true);
    expect(debugLoggingRequested({ HARBORMASTER_LOG: "info" })).toBe(false);
    expect(debugLoggingRequested({})).toBe(false);
  });

  it("is a no-op unless enabled", () => {
    const seen: unknown[][] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      seen.push(args);
    };
    try {
      setDebugLoggingForTests(false);
      debugLog("pty", "data bytes=5");
      setDebugLoggingForTests(true);
      debugLog("pty", "data bytes=6");
    } finally {
      console.log = original;
    }
    expect(seen).toEqual([["[debug:pty]", "data bytes=6"]]);
  });
});
