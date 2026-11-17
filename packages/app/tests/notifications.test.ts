import { describe, expect, it } from "vitest";
import {
  legacyNotificationsValue,
  NOTIFICATIONS_STORAGE_KEY,
  notificationsEnabled,
  notificationsMigration,
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

describe("legacyNotificationsValue", () => {
  function storageOf(value: string | null): Pick<Storage, "getItem"> {
    return { getItem: () => value };
  }

  it("reads the retired localStorage escape hatch", () => {
    expect(legacyNotificationsValue(storageOf(null))).toBeNull();
    expect(legacyNotificationsValue(storageOf("off"))).toBe("off");
    expect(NOTIFICATIONS_STORAGE_KEY).toBe("harbormaster.notifications");
  });

  it("is null when storage is unavailable or throws", () => {
    expect(legacyNotificationsValue(undefined)).toBeNull();
    const throwing: Pick<Storage, "getItem"> = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(legacyNotificationsValue(throwing)).toBeNull();
  });
});

describe("notificationsEnabled (notifications.enabled, S11)", () => {
  it("follows the setting", () => {
    expect(notificationsEnabled({ value: true, configured: false }, null)).toBe(
      true,
    );
    expect(notificationsEnabled({ value: false, configured: true }, null)).toBe(
      false,
    );
    // Before settings load: on, unless the legacy hatch says off.
    expect(
      notificationsEnabled({ value: undefined, configured: false }, null),
    ).toBe(true);
  });

  it("a legacy 'off' counts until migrated, unless the setting is configured", () => {
    expect(
      notificationsEnabled({ value: true, configured: false }, "off"),
    ).toBe(false);
    expect(notificationsEnabled({ value: true, configured: true }, "off")).toBe(
      true,
    );
    expect(notificationsEnabled({ value: true, configured: false }, "on")).toBe(
      true,
    );
  });
});

describe("notificationsMigration", () => {
  it("writes off and clears a legacy 'off' when the setting is unset", () => {
    expect(notificationsMigration("off", false)).toEqual({
      writeOff: true,
      clearLegacy: true,
    });
  });

  it("only clears the legacy value when the setting is set or the value is not 'off'", () => {
    expect(notificationsMigration("off", true)).toEqual({
      writeOff: false,
      clearLegacy: true,
    });
    expect(notificationsMigration("on", false)).toEqual({
      writeOff: false,
      clearLegacy: true,
    });
  });

  it("does nothing without a legacy value", () => {
    expect(notificationsMigration(null, false)).toEqual({
      writeOff: false,
      clearLegacy: false,
    });
  });
});
