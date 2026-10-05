import { describe, expect, it } from "vitest";
import type { PresenceRecord } from "../src/contracts/model.js";
import {
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
