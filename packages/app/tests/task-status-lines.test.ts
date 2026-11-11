import { describe, expect, it } from "vitest";
import {
  deriveLaunchMarker,
  deriveOutcomeLine,
  derivePresenceActivity,
  deriveProvenanceLabel,
} from "../src/renderer/src/lib/task-status-lines";

describe("derivePresenceActivity (OSC 7501 states)", () => {
  const live = { live: true, runningTurn: false } as const;
  it("working is a spinner, blocked is your move, idle/done are idle, error is error", () => {
    expect(
      derivePresenceActivity({
        live: true,
        runningTurn: true,
        status: { state: "working" },
      }),
    ).toBe("working");
    expect(
      derivePresenceActivity({ ...live, status: { state: "blocked" } }),
    ).toBe("your-move");
    expect(derivePresenceActivity({ ...live, status: { state: "idle" } })).toBe(
      "idle",
    );
    expect(derivePresenceActivity({ ...live, status: { state: "done" } })).toBe(
      "idle",
    );
    expect(
      derivePresenceActivity({
        ...live,
        status: { state: "error", message: "boom" },
      }),
    ).toBe("error");
  });

  it("keeps the old meaning without a status, and a reported outcome is your move", () => {
    expect(derivePresenceActivity(live)).toBe("your-move");
    expect(
      derivePresenceActivity({
        ...live,
        status: { state: "done" },
        outcome: { status: "done" },
      }),
    ).toBe("your-move");
  });

  it("waiting on the parent is idle; no agent is undefined", () => {
    expect(
      derivePresenceActivity({ ...live, status: { state: "blocked" } }, true),
    ).toBe("idle");
    expect(
      derivePresenceActivity({ live: false, runningTurn: false }),
    ).toBeUndefined();
    expect(derivePresenceActivity(undefined)).toBeUndefined();
  });
});

describe("deriveOutcomeLine", () => {
  it("is undefined with no presence", () => {
    expect(deriveOutcomeLine(undefined)).toBeUndefined();
  });

  it("prefers a live outcome over ended", () => {
    expect(
      deriveOutcomeLine({
        outcome: { status: "done", note: "Shipped it" },
        ended: { status: "blocked", note: "stale" },
      }),
    ).toEqual({ status: "done", note: "Shipped it" });
  });

  it("falls back to ended done/blocked with a note", () => {
    expect(
      deriveOutcomeLine({ ended: { status: "blocked", note: "Need a key" } }),
    ).toEqual({ status: "blocked", note: "Need a key" });
  });

  it("renders nothing for ended without a note, or unreported", () => {
    expect(deriveOutcomeLine({ ended: { status: "done" } })).toBeUndefined();
    expect(
      deriveOutcomeLine({ ended: { status: "unreported", note: "x" } }),
    ).toBeUndefined();
  });

  it("renders nothing when outcome/ended carry no note", () => {
    expect(deriveOutcomeLine({ outcome: { status: "done" } })).toBeUndefined();
  });
});

describe("deriveLaunchMarker", () => {
  it("maps queued/interrupted to the matching marker", () => {
    expect(deriveLaunchMarker({ launch: { status: "queued" } })).toBe("queued");
    expect(deriveLaunchMarker({ launch: { status: "interrupted" } })).toBe(
      "interrupted",
    );
  });

  it("is undefined once started, or with no launch at all", () => {
    expect(
      deriveLaunchMarker({ launch: { status: "started" } }),
    ).toBeUndefined();
    expect(deriveLaunchMarker({})).toBeUndefined();
  });
});

describe("deriveProvenanceLabel", () => {
  it("resolves the source task's title", () => {
    expect(
      deriveProvenanceLabel({ launchedFromTaskId: "a" }, (id) =>
        id === "a" ? "Arnac bug hunt" : undefined,
      ),
    ).toBe("launched from Arnac bug hunt");
  });

  it("falls back to nothing with no launchedFromTaskId, or a gone source task", () => {
    expect(deriveProvenanceLabel({}, () => "ignored")).toBeUndefined();
    expect(
      deriveProvenanceLabel({ launchedFromTaskId: "gone" }, () => undefined),
    ).toBeUndefined();
  });
});
