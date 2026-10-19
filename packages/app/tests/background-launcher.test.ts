// Pure decision-logic + pass-serialization tests for the background
// launcher (see main/background-launcher.ts). No Electron, no node-pty, no
// core — every dependency is injected so these assert the concurrency-cap,
// grace-window, idle-children, and serialization rules directly.
import { describe, expect, it } from "vitest";
import {
  computeCapacity,
  createBackgroundLauncher,
  DEFAULT_STARTUP_GRACE_MS,
  isWorking,
  type LaunchedTaskStatus,
  type LaunchQueueTask,
} from "../src/main/background-launcher";

const NOW = Date.parse("2024-06-01T00:00:00.000Z");

function status(
  overrides: Partial<LaunchedTaskStatus> = {},
): LaunchedTaskStatus {
  return {
    taskId: "task-1",
    hasLivePane: true,
    runningTurn: false,
    hasPresenceRecord: true,
    ...overrides,
  };
}

describe("isWorking", () => {
  it("no live pane: never working, regardless of runningTurn", () => {
    expect(
      isWorking(status({ hasLivePane: false, runningTurn: true }), NOW),
    ).toBe(false);
  });

  it("live pane + runningTurn: working", () => {
    expect(isWorking(status({ runningTurn: true }), NOW)).toBe(true);
  });

  it("live pane, a presence record exists, but no turn running: idle (your move), never working", () => {
    expect(
      isWorking(status({ runningTurn: false, hasPresenceRecord: true }), NOW),
    ).toBe(false);
  });

  it("live pane, no presence record yet, started just now: working (startup grace)", () => {
    expect(
      isWorking(
        status({
          runningTurn: false,
          hasPresenceRecord: false,
          startedAt: new Date(NOW - 1_000).toISOString(),
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it("live pane, no presence record, started past the grace window: not working", () => {
    expect(
      isWorking(
        status({
          runningTurn: false,
          hasPresenceRecord: false,
          startedAt: new Date(NOW - DEFAULT_STARTUP_GRACE_MS - 1).toISOString(),
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("live pane, no presence record, no startedAt: not working (nothing to grace against)", () => {
    expect(
      isWorking(status({ runningTurn: false, hasPresenceRecord: false }), NOW),
    ).toBe(false);
  });

  it("a custom grace window is honored", () => {
    const status60s = status({
      runningTurn: false,
      hasPresenceRecord: false,
      startedAt: new Date(NOW - 30_000).toISOString(),
    });
    expect(isWorking(status60s, NOW, 60_000)).toBe(true);
    expect(isWorking(status60s, NOW, 10_000)).toBe(false);
  });
});

describe("computeCapacity", () => {
  it("maxConcurrent minus the number of working statuses, floored at 0", () => {
    const statuses = [
      status({ taskId: "a", runningTurn: true }),
      status({ taskId: "b", runningTurn: false, hasPresenceRecord: true }), // idle, doesn't count
      status({ taskId: "c", runningTurn: true }),
    ];
    expect(computeCapacity(3, statuses, NOW)).toBe(1);
    expect(computeCapacity(2, statuses, NOW)).toBe(0);
    expect(computeCapacity(1, statuses, NOW)).toBe(0);
  });

  it("idle 'your move' children never shrink capacity", () => {
    const allIdle = [
      status({ taskId: "a", runningTurn: false, hasPresenceRecord: true }),
      status({ taskId: "b", runningTurn: false, hasPresenceRecord: true }),
    ];
    expect(computeCapacity(2, allIdle, NOW)).toBe(2);
  });
});

function makeTask(id: string, startedAt?: string): LaunchQueueTask {
  return {
    id,
    launch: { status: "started", ...(startedAt ? { startedAt } : {}) },
  };
}

describe("createBackgroundLauncher", () => {
  it("claims and starts up to capacity when queued launches exist", async () => {
    const claimed = [makeTask("new-1"), makeTask("new-2")];
    const started: string[] = [];
    const launcher = createBackgroundLauncher({
      listStartedLaunches: async () => [],
      getLaunchSettings: async () => ({ maxConcurrent: 2 }),
      hasLivePane: () => false,
      getPresence: async () => ({
        runningTurn: false,
        hasPresenceRecord: false,
      }),
      claimPendingLaunches: async (limit) => claimed.slice(0, limit),
      startSession: async (task) => {
        started.push(task.id);
      },
      now: () => NOW,
    });

    await launcher.runPass();
    expect(started).toEqual(["new-1", "new-2"]);
  });

  it("claims nothing when capacity is zero (every slot working)", async () => {
    let claimCalls = 0;
    const launcher = createBackgroundLauncher({
      listStartedLaunches: async () => [makeTask("busy-1")],
      getLaunchSettings: async () => ({ maxConcurrent: 1 }),
      hasLivePane: () => true,
      getPresence: async () => ({ runningTurn: true, hasPresenceRecord: true }),
      claimPendingLaunches: async (limit) => {
        claimCalls += 1;
        return Array.from({ length: limit }, (_v, i) => makeTask(`x${i}`));
      },
      startSession: async () => {},
      now: () => NOW,
    });

    await launcher.runPass();
    expect(claimCalls).toBe(0);
  });

  it("one failed startSession does not block the rest of the claimed batch, and is reported via onStartError", async () => {
    const claimed = [makeTask("bad"), makeTask("good")];
    const started: string[] = [];
    const errors: string[] = [];
    const launcher = createBackgroundLauncher({
      listStartedLaunches: async () => [],
      getLaunchSettings: async () => ({ maxConcurrent: 2 }),
      hasLivePane: () => false,
      getPresence: async () => ({
        runningTurn: false,
        hasPresenceRecord: false,
      }),
      claimPendingLaunches: async (limit) => claimed.slice(0, limit),
      startSession: async (task) => {
        if (task.id === "bad") throw new Error("boom");
        started.push(task.id);
      },
      onStartError: (task) => errors.push(task.id),
      now: () => NOW,
    });

    await launcher.runPass();
    expect(started).toEqual(["good"]);
    expect(errors).toEqual(["bad"]);
  });

  it("serializes passes: a runPass() call while one is already in flight is coalesced into exactly one rerun, never overlapped", async () => {
    let inFlight = 0;
    let maxConcurrentPasses = 0;
    let listCalls = 0;
    let resolveFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const launcher = createBackgroundLauncher({
      listStartedLaunches: async () => {
        listCalls += 1;
        inFlight += 1;
        maxConcurrentPasses = Math.max(maxConcurrentPasses, inFlight);
        if (listCalls === 1) await firstGate;
        inFlight -= 1;
        return [];
      },
      getLaunchSettings: async () => ({ maxConcurrent: 0 }),
      hasLivePane: () => false,
      getPresence: async () => ({
        runningTurn: false,
        hasPresenceRecord: false,
      }),
      claimPendingLaunches: async () => [],
      startSession: async () => {},
      now: () => NOW,
    });

    const firstPass = launcher.runPass();
    // Fires while the first pass is still awaiting listStartedLaunches:
    // must be coalesced into one rerun, not run concurrently.
    const secondPass = launcher.runPass();
    const thirdPass = launcher.runPass();

    resolveFirst?.();
    await Promise.all([firstPass, secondPass, thirdPass]);
    // Give the coalesced rerun (scheduled in runPass's `finally`) a tick to finish.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(maxConcurrentPasses).toBe(1);
    // Exactly one pass ran, plus exactly one coalesced rerun — never three.
    expect(listCalls).toBe(2);
  });

  it("passes each launched task's startedAt/taskId through to the capacity computation", async () => {
    const seenTaskIds: string[] = [];
    const launcher = createBackgroundLauncher({
      listStartedLaunches: async () => [
        makeTask("t1", new Date(NOW).toISOString()),
      ],
      getLaunchSettings: async () => ({ maxConcurrent: 1 }),
      hasLivePane: (taskId) => {
        seenTaskIds.push(taskId);
        return true;
      },
      getPresence: async () => ({ runningTurn: true, hasPresenceRecord: true }),
      claimPendingLaunches: async () => [],
      startSession: async () => {},
      now: () => NOW,
    });

    await launcher.runPass();
    expect(seenTaskIds).toEqual(["t1"]);
  });
});
