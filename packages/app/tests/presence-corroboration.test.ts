import type {
  PresenceOutcome,
  PresenceRecord,
  PresenceStatus,
} from "@harbormaster/core";
import { describe, expect, it } from "vitest";
import { corroboratePresence } from "../src/main/presence-corroboration";

function record(overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    taskId: "task-1",
    sessionPath: "/tmp/session.jsonl",
    pid: 1111,
    mode: "interactive",
    startedAt: "2024-01-01T00:00:00.000Z",
    heartbeatAt: "2024-01-01T00:00:05.000Z",
    ...overrides,
  };
}

const ENDED_BLOCKED: PresenceOutcome = {
  status: "blocked",
  note: "needs a decision",
  at: "2024-01-01T00:00:06.000Z",
};

describe("corroboratePresence", () => {
  it("pane exists, record.pid matches the pane pid: trusts the record fully (live/runningTurn/ended as today)", () => {
    const status: PresenceStatus = {
      live: true,
      runningTurn: true,
      record: record({ pid: 4242, runningTurn: true }),
    };
    const result = corroboratePresence(status, { pid: 4242, alive: true });
    expect(result).toEqual({
      live: true,
      runningTurn: true,
      corroboration: "record",
      heartbeatAt: "2024-01-01T00:00:05.000Z",
    });
  });

  it("pane exists, record.pid matches: an ended outcome is carried through (ended-record precedence)", () => {
    const status: PresenceStatus = {
      live: false,
      runningTurn: false,
      record: record({ pid: 4242, ended: ENDED_BLOCKED }),
    };
    const result = corroboratePresence(status, { pid: 4242, alive: true });
    expect(result).toEqual({
      live: false,
      runningTurn: false,
      corroboration: "record",
      ended: ENDED_BLOCKED,
    });
  });

  it("pane exists, record.pid differs (stale record / impersonation): distrusts the record's semantics, reports attached-neutral", () => {
    const status: PresenceStatus = {
      live: true,
      runningTurn: true,
      record: record({ pid: 9999, runningTurn: true }),
    };
    const result = corroboratePresence(status, { pid: 4242, alive: true });
    expect(result).toEqual({
      live: true,
      runningTurn: false,
      corroboration: "pane-only",
    });
  });

  it("pane exists, record.pid differs: never forwards the stale record's heartbeat or ended outcome", () => {
    const status: PresenceStatus = {
      live: false,
      runningTurn: false,
      record: record({ pid: 9999, ended: ENDED_BLOCKED }),
    };
    const result = corroboratePresence(status, { pid: 4242, alive: true });
    expect(result).toEqual({
      live: true,
      runningTurn: false,
      corroboration: "pane-only",
    });
  });

  it("pane exists, no record at all: still reports attached-neutral, not offline", () => {
    const status: PresenceStatus = { live: false, runningTurn: false };
    const result = corroboratePresence(status, { pid: 4242, alive: true });
    expect(result).toEqual({
      live: true,
      runningTurn: false,
      corroboration: "pane-only",
    });
  });

  it("no pane, record's own process alive (external session): trusts the record exactly as today", () => {
    const status: PresenceStatus = {
      live: true,
      runningTurn: true,
      record: record({ pid: 5050, runningTurn: true }),
    };
    const result = corroboratePresence(status, undefined);
    expect(result).toEqual({
      live: true,
      runningTurn: true,
      corroboration: "record",
      heartbeatAt: "2024-01-01T00:00:05.000Z",
    });
  });

  it("no pane, record's own process alive and ended: carries the outcome through (external session, ended precedence)", () => {
    const status: PresenceStatus = {
      live: true,
      runningTurn: false,
      record: record({ pid: 5050 }),
    };
    const result = corroboratePresence(status, undefined);
    expect(result).toEqual({
      live: true,
      runningTurn: false,
      corroboration: "record",
      heartbeatAt: "2024-01-01T00:00:05.000Z",
    });
  });

  it("no pane, record pid confirmed dead: idle immediately regardless of heartbeat freshness (kills the staleness window)", () => {
    const status: PresenceStatus = {
      // A fresh-looking heartbeat, but the harness's own pid-liveness probe
      // already determined the process is dead -> status.live is false.
      live: false,
      runningTurn: false,
      record: record({ pid: 7777, heartbeatAt: new Date().toISOString() }),
    };
    const result = corroboratePresence(status, undefined);
    expect(result).toEqual({
      live: false,
      runningTurn: false,
      corroboration: "none",
    });
  });

  it("no pane, record pid dead, but an outcome was already reported: carries the ended outcome through (ended-record precedence)", () => {
    const status: PresenceStatus = {
      live: false,
      runningTurn: false,
      record: record({ pid: 7777, ended: ENDED_BLOCKED }),
    };
    const result = corroboratePresence(status, undefined);
    expect(result).toEqual({
      live: false,
      runningTurn: false,
      corroboration: "none",
      ended: ENDED_BLOCKED,
    });
  });

  it("no pane, no record at all: idle, nothing to corroborate", () => {
    const status: PresenceStatus = { live: false, runningTurn: false };
    const result = corroboratePresence(status, undefined);
    expect(result).toEqual({
      live: false,
      runningTurn: false,
      corroboration: "none",
    });
  });

  it("forwards the live agent's program status only when the record is trusted", () => {
    const status: PresenceStatus = {
      live: true,
      runningTurn: false,
      record: record({
        pid: 4242,
        status: { state: "error", message: "rate limited", at: "t" },
      }),
    };
    expect(
      corroboratePresence(status, { pid: 4242, alive: true }).status,
    ).toEqual({ state: "error", message: "rate limited" });
    expect(
      corroboratePresence(status, { pid: 9999, alive: true }).status,
    ).toBeUndefined();
  });
});
