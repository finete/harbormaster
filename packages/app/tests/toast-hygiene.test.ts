import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  capVisibleToasts,
  dismissToast,
  isDuplicateToast,
  pushToast,
  subscribeToasts,
  TOAST_VISIBLE_CAP,
  type ToastMessage,
  WARNING_AUTO_DISMISS_MS,
} from "../src/renderer/src/toast";

function drain(): void {
  // Empty every toast currently on the module-level bus between tests —
  // there is no reset export, so dismiss whatever subscribeToasts reports.
  let current: ToastMessage[] = [];
  const unsubscribe = subscribeToasts((toasts) => {
    current = toasts;
  });
  unsubscribe();
  for (const toast of current) dismissToast(toast.id);
}

describe("isDuplicateToast", () => {
  it("is true for an identical body already present", () => {
    const existing: ToastMessage[] = [
      { id: "1", text: "offline", tone: "warning" },
    ];
    expect(isDuplicateToast(existing, "offline")).toBe(true);
    expect(isDuplicateToast(existing, "something else")).toBe(false);
  });
});

describe("capVisibleToasts", () => {
  const make = (n: number): ToastMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      id: String(i),
      text: `t${i}`,
      tone: "warning" as const,
    }));

  it("returns everything uncapped when at or under the cap", () => {
    const toasts = make(TOAST_VISIBLE_CAP);
    const { visible, overflow } = capVisibleToasts(toasts);
    expect(visible).toHaveLength(TOAST_VISIBLE_CAP);
    expect(overflow).toHaveLength(0);
  });

  it("collapses everything past the cap into overflow", () => {
    const toasts = make(TOAST_VISIBLE_CAP + 3);
    const { visible, overflow } = capVisibleToasts(toasts);
    expect(visible).toHaveLength(TOAST_VISIBLE_CAP);
    expect(overflow).toHaveLength(3);
    expect(visible).toEqual(toasts.slice(0, TOAST_VISIBLE_CAP));
    expect(overflow).toEqual(toasts.slice(TOAST_VISIBLE_CAP));
  });

  it("honors a custom cap", () => {
    const toasts = make(5);
    const { visible, overflow } = capVisibleToasts(toasts, 2);
    expect(visible).toHaveLength(2);
    expect(overflow).toHaveLength(3);
  });
});

describe("pushToast / dismissToast bus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    drain();
  });
  afterEach(() => {
    drain();
    vi.useRealTimers();
  });

  it("dedupes an identical body already visible", () => {
    const seen: ToastMessage[][] = [];
    const unsubscribe = subscribeToasts((toasts) => seen.push(toasts));
    pushToast("gh: bad credentials", "error");
    pushToast("gh: bad credentials", "error");
    unsubscribe();
    expect(seen.at(-1)).toHaveLength(1);
  });

  it("never creates a toast for a connectivity-shaped message (defense-in-depth)", () => {
    const seen: ToastMessage[][] = [];
    const unsubscribe = subscribeToasts((toasts) => seen.push(toasts));
    pushToast(
      "error connecting to api.github.com check your internet",
      "warning",
    );
    unsubscribe();
    expect(seen.at(-1)).toHaveLength(0);
  });

  it("auto-dismisses a warning after WARNING_AUTO_DISMISS_MS but never an error", () => {
    const seen: ToastMessage[][] = [];
    const unsubscribe = subscribeToasts((toasts) => seen.push(toasts));
    pushToast("a warning", "warning");
    pushToast("an error", "error");
    expect(seen.at(-1)).toHaveLength(2);

    vi.advanceTimersByTime(WARNING_AUTO_DISMISS_MS);
    expect(seen.at(-1)).toHaveLength(1);
    expect(seen.at(-1)?.[0]?.tone).toBe("error");
    unsubscribe();
  });

  it("dismissToast cancels a pending auto-dismiss timer (no double-dismiss crash)", () => {
    const seen: ToastMessage[][] = [];
    const unsubscribe = subscribeToasts((toasts) => seen.push(toasts));
    pushToast("a warning", "warning");
    const id = seen.at(-1)?.[0]?.id;
    expect(id).toBeTruthy();
    if (id) dismissToast(id);
    expect(seen.at(-1)).toHaveLength(0);

    // The auto-dismiss timer firing after manual dismissal must be a no-op.
    expect(() => vi.advanceTimersByTime(WARNING_AUTO_DISMISS_MS)).not.toThrow();
    unsubscribe();
  });
});
