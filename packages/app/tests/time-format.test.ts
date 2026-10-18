// Unit tests for the shared card/sidebar time-formatting helpers (see
// src/renderer/src/lib/time-format.ts). sidebar-model.test.ts covers the
// same relativeTime/activityTimestamp pair through sidebar-model.ts's
// re-exports; this file is the home for the helpers' own boundaries plus
// the card-only waitingDurationText fragment.
import { describe, expect, it } from "vitest";
import {
  lastInteractionTimestamp,
  relativeTime,
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
