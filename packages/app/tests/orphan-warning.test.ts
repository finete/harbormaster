import { describe, expect, it } from "vitest";
import {
  dismissOrphanWarning,
  ORPHAN_WARNING_DISMISSED_KEY,
  shouldShowOrphanWarning,
} from "../src/renderer/src/lib/orphan-warning";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
}

describe("orphan warning dismissal", () => {
  it("shows until dismissed, then only for more orphans or another root", () => {
    const storage = memoryStorage();
    const seen = { root: "/r", count: 12 };
    expect(shouldShowOrphanWarning(storage, seen)).toBe(true);
    dismissOrphanWarning(storage, seen);
    expect(shouldShowOrphanWarning(storage, seen)).toBe(false);
    expect(shouldShowOrphanWarning(storage, { root: "/r", count: 11 })).toBe(
      false,
    );
    expect(shouldShowOrphanWarning(storage, { root: "/r", count: 13 })).toBe(
      true,
    );
    expect(shouldShowOrphanWarning(storage, { root: "/s", count: 12 })).toBe(
      true,
    );
  });

  it("treats a corrupt record as not dismissed", () => {
    const storage = memoryStorage();
    storage.setItem(ORPHAN_WARNING_DISMISSED_KEY, "{nope");
    expect(shouldShowOrphanWarning(storage, { root: "/r", count: 1 })).toBe(
      true,
    );
  });
});
