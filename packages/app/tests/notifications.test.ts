import { describe, expect, it } from "vitest";
import {
  NOTIFICATIONS_STORAGE_KEY,
  notificationsDisabled,
  notifyTransitionEvents,
} from "../src/renderer/src/lib/notifications";

describe("notifyTransitionEvents", () => {
  it("reports 'finished' for a runningTurn true -> false transition", () => {
    const events = notifyTransitionEvents({
      previous: { a: { runningTurn: true } },
      next: { a: { runningTurn: false } },
      focusedTaskId: null,
      windowFocused: true,
    });
    expect(events).toEqual([{ taskId: "a", body: "finished" }]);
  });

  it("reports the blocked note when a presence outcome arrives blocked", () => {
    const events = notifyTransitionEvents({
      previous: { a: { runningTurn: false } },
      next: {
        a: {
          runningTurn: false,
          ended: { status: "blocked", note: "needs a decision on X" },
        },
      },
      focusedTaskId: null,
      windowFocused: true,
    });
    expect(events).toEqual([{ taskId: "a", body: "needs a decision on X" }]);
  });

  it("falls back to a generic body when a blocked outcome has no note", () => {
    const events = notifyTransitionEvents({
      previous: { a: { runningTurn: false } },
      next: { a: { runningTurn: false, ended: { status: "blocked" } } },
      focusedTaskId: null,
      windowFocused: true,
    });
    expect(events).toEqual([{ taskId: "a", body: "needs your attention" }]);
  });

  it("never fires for the focused, window-focused task", () => {
    const events = notifyTransitionEvents({
      previous: { a: { runningTurn: true } },
      next: { a: { runningTurn: false } },
      focusedTaskId: "a",
      windowFocused: true,
    });
    expect(events).toEqual([]);
  });

  it("fires for the 'focused' task when the window itself is unfocused", () => {
    const events = notifyTransitionEvents({
      previous: { a: { runningTurn: true } },
      next: { a: { runningTurn: false } },
      focusedTaskId: "a",
      windowFocused: false,
    });
    expect(events).toEqual([{ taskId: "a", body: "finished" }]);
  });

  it("emits at most one event per task per push (no poll-jitter storms)", () => {
    const previous = { a: { runningTurn: true }, b: { runningTurn: true } };
    const next = { a: { runningTurn: false }, b: { runningTurn: false } };
    const first = notifyTransitionEvents({
      previous,
      next,
      focusedTaskId: null,
      windowFocused: true,
    });
    expect(first).toHaveLength(2);
    // A repeat push with no further transition (same `next` as a later
    // "previous") produces no further events — the edge already passed.
    const second = notifyTransitionEvents({
      previous: next,
      next,
      focusedTaskId: null,
      windowFocused: true,
    });
    expect(second).toEqual([]);
  });
});

describe("notificationsDisabled", () => {
  function storageOf(value: string | null): Pick<Storage, "getItem"> {
    return { getItem: () => value };
  }

  it("is false when the flag is unset", () => {
    expect(notificationsDisabled(storageOf(null))).toBe(false);
  });

  it("is true when the flag is exactly 'off'", () => {
    expect(notificationsDisabled(storageOf("off"))).toBe(true);
  });

  it("is false for any other value", () => {
    expect(notificationsDisabled(storageOf("on"))).toBe(false);
  });

  it("is false when storage is unavailable", () => {
    expect(notificationsDisabled(undefined)).toBe(false);
  });

  it("is false when storage access throws", () => {
    const throwing: Pick<Storage, "getItem"> = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(notificationsDisabled(throwing)).toBe(false);
  });

  it("uses the documented storage key", () => {
    expect(NOTIFICATIONS_STORAGE_KEY).toBe("harbormaster.notifications");
  });
});
