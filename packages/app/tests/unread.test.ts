import { describe, expect, it } from "vitest";
import {
  applyUnreadTransition,
  clearUnread,
  unreadTransitions,
} from "../src/renderer/src/lib/unread";

describe("unreadTransitions", () => {
  it("marks a task whose runningTurn flips true -> false while unfocused", () => {
    const marked = unreadTransitions({
      previous: { a: { runningTurn: true } },
      next: { a: { runningTurn: false } },
      focusedTaskId: "b",
      windowFocused: true,
    });
    expect(marked).toEqual(["a"]);
  });

  it("does not mark the currently-focused, window-focused task", () => {
    const marked = unreadTransitions({
      previous: { a: { runningTurn: true } },
      next: { a: { runningTurn: false } },
      focusedTaskId: "a",
      windowFocused: true,
    });
    expect(marked).toEqual([]);
  });

  it("marks the focused task if the app window itself is unfocused", () => {
    const marked = unreadTransitions({
      previous: { a: { runningTurn: true } },
      next: { a: { runningTurn: false } },
      focusedTaskId: "a",
      windowFocused: false,
    });
    expect(marked).toEqual(["a"]);
  });

  it("ignores false -> true and false -> false transitions", () => {
    const marked = unreadTransitions({
      previous: { a: { runningTurn: false }, b: { runningTurn: false } },
      next: { a: { runningTurn: true }, b: { runningTurn: false } },
      focusedTaskId: null,
      windowFocused: true,
    });
    expect(marked).toEqual([]);
  });

  it("ignores a task missing from the previous snapshot (first push)", () => {
    const marked = unreadTransitions({
      previous: {},
      next: { a: { runningTurn: false } },
      focusedTaskId: null,
      windowFocused: true,
    });
    expect(marked).toEqual([]);
  });

  it("marks a task whose presence outcome just arrived blocked", () => {
    const marked = unreadTransitions({
      previous: { a: { runningTurn: false } },
      next: {
        a: { runningTurn: false, ended: { status: "blocked", note: "stuck" } },
      },
      focusedTaskId: null,
      windowFocused: true,
    });
    expect(marked).toEqual(["a"]);
  });

  it("does not re-mark a task that was already blocked (no new edge)", () => {
    const marked = unreadTransitions({
      previous: {
        a: { runningTurn: false, ended: { status: "blocked" } },
      },
      next: {
        a: { runningTurn: false, ended: { status: "blocked" } },
      },
      focusedTaskId: null,
      windowFocused: true,
    });
    expect(marked).toEqual([]);
  });

  it("does not mark a blocked outcome for the currently-focused, window-focused task", () => {
    const marked = unreadTransitions({
      previous: { a: { runningTurn: false } },
      next: { a: { runningTurn: false, ended: { status: "blocked" } } },
      focusedTaskId: "a",
      windowFocused: true,
    });
    expect(marked).toEqual([]);
  });

  it("ignores a done outcome (only blocked is unread-worthy on its own)", () => {
    const marked = unreadTransitions({
      previous: { a: { runningTurn: false } },
      next: { a: { runningTurn: false, ended: { status: "done" } } },
      focusedTaskId: null,
      windowFocused: true,
    });
    expect(marked).toEqual([]);
  });
});

describe("applyUnreadTransition", () => {
  it("unions newly-marked ids into the current set without mutating it", () => {
    const current = new Set(["x"]);
    const next = applyUnreadTransition(current, {
      previous: { a: { runningTurn: true } },
      next: { a: { runningTurn: false } },
      focusedTaskId: null,
      windowFocused: true,
    });
    expect(current).toEqual(new Set(["x"])); // unchanged
    expect(next).toEqual(new Set(["x", "a"]));
  });

  it("returns an equivalent set (not the same reference) when nothing changes", () => {
    const current = new Set(["x"]);
    const next = applyUnreadTransition(current, {
      previous: {},
      next: {},
      focusedTaskId: null,
      windowFocused: true,
    });
    expect(next).not.toBe(current);
    expect(next).toEqual(current);
  });
});

describe("clearUnread", () => {
  it("removes the given task id", () => {
    const next = clearUnread(new Set(["a", "b"]), "a");
    expect(next).toEqual(new Set(["b"]));
  });

  it("is a no-op for a task id that isn't marked", () => {
    const current = new Set(["b"]);
    const next = clearUnread(current, "a");
    expect(next).toEqual(current);
  });
});
