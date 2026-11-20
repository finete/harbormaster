// Unit tests for the shared card/sidebar time-formatting helpers (see
// src/renderer/src/lib/time-format.ts). sidebar-model.test.ts covers the
// same relativeTime/activityTimestamp pair through sidebar-model.ts's
// re-exports; this file is the home for the helpers' own boundaries plus
// the card-only waitingDurationText fragment.
import { describe, expect, it } from "vitest";
import {
  absoluteDateTime,
  lastInteractionTimestamp,
  relativeTime,
  taskStartMoment,
  waitingDurationText,
} from "../src/renderer/src/lib/time-format";

describe("relativeTime", () => {
  const now = Date.parse("2025-01-10T12:00:00.000Z");

  it.each([
    // <1m (including slightly-future clock skew) -> "now"
    ["2025-01-10T11:59:30.000Z", "now"],
    ["2025-01-10T12:00:30.000Z", "now"],
    // minutes
    ["2025-01-10T11:59:00.000Z", "1m"],
    ["2025-01-10T11:57:00.000Z", "3m"],
    ["2025-01-10T11:00:01.000Z", "59m"],
    // hours
    ["2025-01-10T11:00:00.000Z", "1h"],
    ["2025-01-10T10:00:00.000Z", "2h"],
    ["2025-01-09T13:00:01.000Z", "22h"],
    // days
    ["2025-01-09T12:00:00.000Z", "1d"],
    ["2025-01-07T12:00:00.000Z", "3d"],
    // weeks
    ["2025-01-03T12:00:00.000Z", "1w"],
    ["2024-12-27T12:00:00.000Z", "2w"],
    // months/years
    ["2024-10-10T12:00:00.000Z", "3mo"],
    ["2022-01-10T12:00:00.000Z", "3y"],
    // invalid input
    ["garbage", ""],
  ])("%s -> %j", (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });
});

describe("lastInteractionTimestamp", () => {
  const updatedAt = "2025-01-01T00:00:00.000Z";
  const heartbeatAt = "2025-01-10T11:59:58.000Z";

  it("prefers the live heartbeat over updatedAt", () => {
    expect(
      lastInteractionTimestamp({ updatedAt }, { live: true, heartbeatAt }),
    ).toBe(heartbeatAt);
  });

  it("falls back to updatedAt when not live", () => {
    expect(
      lastInteractionTimestamp({ updatedAt }, { live: false, heartbeatAt }),
    ).toBe(updatedAt);
  });

  it("falls back to updatedAt when live but no heartbeat recorded yet", () => {
    expect(lastInteractionTimestamp({ updatedAt }, { live: true })).toBe(
      updatedAt,
    );
  });

  it("falls back to updatedAt when there is no presence at all (no session yet)", () => {
    expect(lastInteractionTimestamp({ updatedAt }, undefined)).toBe(updatedAt);
  });
});

describe("waitingDurationText", () => {
  const now = Date.parse("2025-01-10T12:00:00.000Z");

  it.each([
    ["2025-01-10T11:59:30.000Z", "waiting now"],
    ["2025-01-10T11:13:00.000Z", "waiting 47m"],
    ["2025-01-06T12:00:00.000Z", "waiting 4d"],
  ])("%s -> %j", (sinceIso, expected) => {
    expect(waitingDurationText(sinceIso, now)).toBe(expected);
  });
});

describe("taskStartMoment", () => {
  const createdAt = "2026-11-18T09:00:00.000Z";

  it("prefers the recorded start", () => {
    expect(
      taskStartMoment({
        state: "working",
        createdAt,
        startedAt: "2026-11-19T10:00:00.000Z",
      }),
    ).toEqual({ label: "started", iso: "2026-11-19T10:00:00.000Z" });
  });

  it("a task past the backlog with no recorded start started when it was created", () => {
    expect(taskStartMoment({ state: "done", createdAt })).toEqual({
      label: "started",
      iso: createdAt,
    });
  });

  it("a parked task that never started shows when it was created", () => {
    expect(taskStartMoment({ state: "backlog", createdAt })).toEqual({
      label: "created",
      iso: createdAt,
    });
  });
});

describe("absoluteDateTime", () => {
  // Local-time constructors: the expectation holds in any test timezone.
  const at = new Date(2026, 10, 20, 14, 32).toISOString();
  const now = new Date(2026, 10, 21, 8, 0).getTime();
  // Newer ICU puts a narrow no-break space before "PM".
  const format = (nowMs: number) =>
    absoluteDateTime(at, nowMs, "en-US").replace(/\s/g, " ");

  it("shows month, day and time, without the current year", () => {
    expect(format(now)).toBe("Nov 20, 2:32 PM");
  });

  it("adds the year for another year", () => {
    expect(format(new Date(2027, 0, 2).getTime())).toBe(
      "Nov 20, 2026, 2:32 PM",
    );
  });

  it("is empty for an unparseable value", () => {
    expect(absoluteDateTime("not a date", now, "en-US")).toBe("");
  });
});
