import { describe, expect, it } from "vitest";
import type { PresenceRecord } from "../src/contracts/model.js";
import {
  applyProgramStatus,
  derivePresenceStatus,
  PRESENCE_STALE_MS,
  presenceIsLive,
} from "../src/harness/presence-heuristics.js";

const baseRecord = (
  overrides: Partial<PresenceRecord> = {},
): PresenceRecord => ({
  taskId: "task-1",
  sessionPath: "/sessions/task-1.jsonl",
  pid: 123,
  mode: "interactive",
  startedAt: "2026-01-01T00:00:00.000Z",
  heartbeatAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("presenceIsLive", () => {
  it("is false with no record", () => {
    expect(
      presenceIsLive(undefined, new Date("2026-01-01T00:00:00.000Z")),
    ).toBe(false);
  });

  it("is true for a fresh heartbeat", () => {
    const record = baseRecord({ heartbeatAt: "2026-01-01T00:00:00.000Z" });
    const now = new Date("2026-01-01T00:00:10.000Z");
    expect(presenceIsLive(record, now)).toBe(true);
  });

  it("is false once the heartbeat is older than the stale threshold", () => {
    const record = baseRecord({ heartbeatAt: "2026-01-01T00:00:00.000Z" });
    const now = new Date(
      new Date("2026-01-01T00:00:00.000Z").getTime() + PRESENCE_STALE_MS + 1,
    );
    expect(presenceIsLive(record, now)).toBe(false);
  });

  it("is false once the record has an ended outcome, regardless of heartbeat freshness", () => {
    const record = baseRecord({
      heartbeatAt: "2026-01-01T00:00:00.000Z",
      ended: { status: "done", at: "2026-01-01T00:00:00.000Z" },
    });
    const now = new Date("2026-01-01T00:00:01.000Z");
    expect(presenceIsLive(record, now)).toBe(false);
  });

  it("is false when an isAlive probe says the pid is gone, even with a fresh heartbeat", () => {
    const record = baseRecord({ heartbeatAt: "2026-01-01T00:00:00.000Z" });
    const now = new Date("2026-01-01T00:00:01.000Z");
    expect(presenceIsLive(record, now, { isAlive: () => false })).toBe(false);
  });

  it("with an isAlive probe, pid liveness alone decides (OSC 7501 has no heartbeat)", () => {
    const record = baseRecord({ heartbeatAt: "2026-01-01T00:00:00.000Z" });
    const muchLater = new Date("2026-01-02T00:00:00.000Z");
    expect(presenceIsLive(record, muchLater, { isAlive: () => true })).toBe(
      true,
    );
    expect(presenceIsLive(record, muchLater)).toBe(false);
  });

  it("respects a custom staleMs override", () => {
    const record = baseRecord({ heartbeatAt: "2026-01-01T00:00:00.000Z" });
    const now = new Date("2026-01-01T00:00:05.000Z");
    expect(presenceIsLive(record, now, { staleMs: 1000 })).toBe(false);
    expect(presenceIsLive(record, now, { staleMs: 10_000 })).toBe(true);
  });
});

describe("derivePresenceStatus", () => {
  it("reports live:false and runningTurn:false with no record", () => {
    const status = derivePresenceStatus(
      undefined,
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(status).toEqual({ live: false, runningTurn: false });
  });

  it("reflects runningTurn only while live", () => {
    const record = baseRecord({
      heartbeatAt: "2026-01-01T00:00:00.000Z",
      runningTurn: true,
    });
    const now = new Date("2026-01-01T00:00:01.000Z");
    expect(derivePresenceStatus(record, now)).toEqual({
      live: true,
      record,
      runningTurn: true,
    });
  });

  it("forces runningTurn false once stale even if the record says true", () => {
    const record = baseRecord({
      heartbeatAt: "2026-01-01T00:00:00.000Z",
      runningTurn: true,
    });
    const now = new Date(
      new Date("2026-01-01T00:00:00.000Z").getTime() + PRESENCE_STALE_MS + 1,
    );
    expect(derivePresenceStatus(record, now)).toEqual({
      live: false,
      record,
      runningTurn: false,
    });
  });

  it("surfaces an ended record as not-live but still returns it", () => {
    const record = baseRecord({
      ended: { status: "blocked", at: "2026-01-01T00:00:00.000Z" },
    });
    const now = new Date("2026-01-01T00:00:01.000Z");
    expect(derivePresenceStatus(record, now)).toEqual({
      live: false,
      record,
      runningTurn: false,
    });
  });
});

describe("applyProgramStatus", () => {
  const at = "2026-01-01T00:00:05.000Z";

  it("registers a fresh interactive attachment on the first report", () => {
    expect(
      applyProgramStatus(undefined, {
        taskId: "task-1",
        pid: 77,
        state: "idle",
        at,
      }),
    ).toEqual({
      taskId: "task-1",
      sessionPath: "",
      pid: 77,
      mode: "interactive",
      startedAt: at,
      heartbeatAt: at,
      runningTurn: false,
      status: { state: "idle", at },
    });
  });

  it("maps working to a running turn and every other state to at rest", () => {
    const working = applyProgramStatus(baseRecord(), {
      taskId: "task-1",
      pid: 123,
      state: "working",
      at,
    });
    expect(working.runningTurn).toBe(true);
    for (const state of ["idle", "blocked", "done", "error"] as const) {
      expect(
        applyProgramStatus(working, {
          taskId: "task-1",
          pid: 123,
          state,
          message: "why",
          at,
        }),
      ).toMatchObject({
        runningTurn: false,
        status: { state, message: "why" },
      });
    }
  });

  it("keeps the attachment for the same pid and clears a stale outcome when a turn starts", () => {
    const current = baseRecord({
      outcome: { status: "done", at: "2026-01-01T00:00:01.000Z" },
    });
    const idle = applyProgramStatus(current, {
      taskId: "task-1",
      pid: 123,
      state: "idle",
      at,
    });
    expect(idle.startedAt).toBe(current.startedAt);
    expect(idle.outcome).toEqual(current.outcome);
    const working = applyProgramStatus(idle, {
      taskId: "task-1",
      pid: 123,
      state: "working",
      at,
    });
    expect(working.outcome).toBeUndefined();
  });

  it("starts over for a different pid or an ended record", () => {
    const ended = baseRecord({
      ended: { status: "done", at: "2026-01-01T00:00:01.000Z" },
    });
    for (const [current, pid] of [
      [baseRecord(), 999],
      [ended, 123],
    ] as const) {
      const next = applyProgramStatus(current, {
        taskId: "task-1",
        pid,
        state: "working",
        at,
      });
      expect(next.startedAt).toBe(at);
      expect(next.ended).toBeUndefined();
      expect(next.pid).toBe(pid);
    }
  });
});
