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
  selectWakeTargets,
  type WakeCandidate,
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

function wakeCandidate(
  taskId: string,
  overrides: Partial<WakeCandidate> = {},
): WakeCandidate {
  return { taskId, hasLivePane: false, presenceLive: false, ...overrides };
}

describe("selectWakeTargets", () => {
  const none = new Set<string>();
  const never = new Map<string, number>();

  it("wakes tasks with no live session, in order, up to capacity", () => {
    expect(
      selectWakeTargets({
        candidates: [
          wakeCandidate("a"),
          wakeCandidate("b"),
          wakeCandidate("c"),
        ],
        capacity: 2,
        inFlight: none,
        lastWakeAt: never,
        nowMs: NOW,
      }),
    ).toEqual(["a", "b"]);
  });

  it("skips a live app pane, live harness presence and a queued launch", () => {
    expect(
      selectWakeTargets({
        candidates: [
          wakeCandidate("pane", { hasLivePane: true }),
          wakeCandidate("presence", { presenceLive: true }),
          wakeCandidate("queued", { launchStatus: "queued" }),
          wakeCandidate("interrupted", { launchStatus: "interrupted" }),
          wakeCandidate("started-dead", { launchStatus: "started" }),
        ],
        capacity: 10,
        inFlight: none,
        lastWakeAt: never,
        nowMs: NOW,
      }),
    ).toEqual(["interrupted", "started-dead"]);
  });

  it("never picks a task whose wake is in flight, or woke within the cooldown", () => {
    const lastWakeAt = new Map([
      ["recent", NOW - 10_000],
      ["old", NOW - 61_000],
    ]);
    expect(
      selectWakeTargets({
        candidates: [
          wakeCandidate("busy"),
          wakeCandidate("recent"),
          wakeCandidate("old"),
        ],
        capacity: 10,
        inFlight: new Set(["busy"]),
        lastWakeAt,
        nowMs: NOW,
      }),
    ).toEqual(["old"]);
  });

  it("honors a custom cooldown, dedupes ids, and returns nothing at zero capacity", () => {
    const candidates = [wakeCandidate("a"), wakeCandidate("a")];
    expect(
      selectWakeTargets({
        candidates,
        capacity: 5,
        inFlight: none,
        lastWakeAt: new Map([["a", NOW - 5_000]]),
        nowMs: NOW,
        cooldownMs: 1_000,
      }),
    ).toEqual(["a"]);
    expect(
      selectWakeTargets({
        candidates,
        capacity: 0,
        inFlight: none,
        lastWakeAt: never,
        nowMs: NOW,
      }),
    ).toEqual([]);
  });
});

describe("createBackgroundLauncher: waking message targets", () => {
  /** A launcher over mutable fakes; `panes` is the app's live-pane set. */
  function harness(
    options: {
      maxConcurrent?: number;
      pending?: LaunchQueueTask[];
      started?: LaunchQueueTask[];
      queue?: LaunchQueueTask[];
    } = {},
  ) {
    const state = {
      now: NOW,
      pending: options.pending ?? [],
      panes: new Set<string>(),
      livePresence: new Set<string>(),
      woken: [] as string[],
      startedNow: [] as string[],
      wakeGate: undefined as Promise<void> | undefined,
    };
    const queue = [...(options.queue ?? [])];
    const launcher = createBackgroundLauncher({
      listStartedLaunches: async () => options.started ?? [],
      getLaunchSettings: async () => ({
        maxConcurrent: options.maxConcurrent ?? 4,
      }),
      hasLivePane: (taskId) => state.panes.has(taskId),
      getPresence: async (taskId) => ({
        runningTurn: false,
        hasPresenceRecord: true, // a stale record from the previous run
        live: state.livePresence.has(taskId),
      }),
      claimPendingLaunches: async (limit) => queue.splice(0, limit),
      startSession: async (task) => {
        state.startedNow.push(task.id);
        state.panes.add(task.id);
      },
      listPendingMessageTargets: async () => state.pending,
      wakeSession: async (taskId) => {
        state.woken.push(taskId);
        await state.wakeGate;
        state.panes.add(taskId);
      },
      now: () => state.now,
    });
    return { state, launcher };
  }

  it("wakes a pending target with no live session, and skips live/queued ones", async () => {
    const { state, launcher } = harness({
      pending: [
        makeTask("dead"),
        makeTask("pane"),
        makeTask("live"),
        { id: "queued", launch: { status: "queued" } },
      ],
    });
    state.panes.add("pane");
    state.livePresence.add("live");
    await launcher.runPass();
    expect(state.woken).toEqual(["dead"]);
  });

  it("does nothing when wake deps are not provided (launch-only use)", async () => {
    const launcher = createBackgroundLauncher({
      listStartedLaunches: async () => [],
      getLaunchSettings: async () => ({ maxConcurrent: 2 }),
      hasLivePane: () => false,
      getPresence: async () => ({
        runningTurn: false,
        hasPresenceRecord: false,
      }),
      claimPendingLaunches: async () => [],
      startSession: async () => {},
      now: () => NOW,
    });
    await expect(launcher.runPass()).resolves.toBeUndefined();
  });

  it("counts woken sessions toward maxConcurrent like started launches (grace, then idle frees the slot)", async () => {
    const { state, launcher } = harness({
      maxConcurrent: 1,
      pending: [makeTask("a"), makeTask("b")],
    });
    await launcher.runPass();
    expect(state.woken).toEqual(["a"]); // capacity 1: only one wake

    // Still inside the grace window, the new session not reported yet (its
    // old presence record is stale): "a" still holds the only slot.
    state.now = NOW + 10_000;
    state.pending = [makeTask("b")];
    await launcher.runPass();
    expect(state.woken).toEqual(["a"]);

    // "a" reports in live and idle: the slot frees and "b" is woken.
    state.livePresence.add("a");
    await launcher.runPass();
    expect(state.woken).toEqual(["a", "b"]);
  });

  it("a woken task past its grace window without reporting in stops counting", async () => {
    const { state, launcher } = harness({
      maxConcurrent: 1,
      pending: [makeTask("a")],
    });
    await launcher.runPass();
    state.now = NOW + DEFAULT_STARTUP_GRACE_MS + 1;
    state.pending = [makeTask("b")];
    await launcher.runPass();
    expect(state.woken).toEqual(["a", "b"]);
  });

  it("queued launches claim capacity first; wakes only get what is left", async () => {
    const { state, launcher } = harness({
      maxConcurrent: 2,
      queue: [makeTask("q1")],
      pending: [makeTask("w1"), makeTask("w2")],
    });
    await launcher.runPass();
    expect(state.startedNow).toEqual(["q1"]);
    expect(state.woken).toEqual(["w1"]);
  });

  it("a woken task also holding a launch record counts once, from the wake time", async () => {
    const { state, launcher } = harness({
      maxConcurrent: 1,
      started: [makeTask("a", new Date(NOW - 3_600_000).toISOString())],
      pending: [],
    });
    state.pending = [{ id: "a", launch: { status: "interrupted" } }];
    await launcher.runPass();
    expect(state.woken).toEqual(["a"]);
    state.pending = [makeTask("b")];
    await launcher.runPass();
    expect(state.woken).toEqual(["a"]);
  });

  it("does not re-wake a task whose session died within the cooldown, but does after it", async () => {
    const { state, launcher } = harness({ pending: [makeTask("a")] });
    await launcher.runPass();
    state.panes.delete("a"); // the session died without claiming its message
    state.now = NOW + 5_000;
    await launcher.runPass();
    expect(state.woken).toEqual(["a"]);
    state.now = NOW + 61_000;
    await launcher.runPass();
    expect(state.woken).toEqual(["a", "a"]);
  });

  it("never attempts a wake twice concurrently for one task", async () => {
    const { state, launcher } = harness({ pending: [makeTask("a")] });
    let release: (() => void) | undefined;
    state.wakeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = launcher.runPass();
    const second = launcher.runPass(); // coalesced rerun while the wake is pending
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.woken).toEqual(["a"]);
    release?.();
    await Promise.all([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.woken).toEqual(["a"]);
  });

  it("a failed wake is reported via onStartError and does not block the rest", async () => {
    const errors: string[] = [];
    const woken: string[] = [];
    const launcher = createBackgroundLauncher({
      listStartedLaunches: async () => [],
      getLaunchSettings: async () => ({ maxConcurrent: 3 }),
      hasLivePane: () => false,
      getPresence: async () => ({
        runningTurn: false,
        hasPresenceRecord: false,
        live: false,
      }),
      claimPendingLaunches: async () => [],
      startSession: async () => {},
      listPendingMessageTargets: async () => [makeTask("bad"), makeTask("ok")],
      wakeSession: async (taskId) => {
        if (taskId === "bad") throw new Error("boom");
        woken.push(taskId);
      },
      onStartError: (task) => errors.push(task.id),
      now: () => NOW,
    });
    await launcher.runPass();
    expect(errors).toEqual(["bad"]);
    expect(woken).toEqual(["ok"]);
  });
});
