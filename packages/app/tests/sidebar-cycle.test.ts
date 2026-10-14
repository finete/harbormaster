import { describe, expect, it } from "vitest";
import { cycleTaskId } from "../src/renderer/src/lib/sidebar-cycle";

describe("cycleTaskId", () => {
  const ids = ["a", "b", "c"];

  it("moves to the next id going down", () => {
    expect(cycleTaskId(ids, "a", "down")).toBe("b");
  });

  it("moves to the previous id going up", () => {
    expect(cycleTaskId(ids, "b", "up")).toBe("a");
  });

  it("wraps past the end going down", () => {
    expect(cycleTaskId(ids, "c", "down")).toBe("a");
  });

  it("wraps past the start going up", () => {
    expect(cycleTaskId(ids, "a", "up")).toBe("c");
  });

  it("returns undefined for an empty list", () => {
    expect(cycleTaskId([], "a", "down")).toBeUndefined();
  });

  it("returns the first id when nothing is currently focused", () => {
    expect(cycleTaskId(ids, null, "down")).toBe("a");
  });

  it("returns the first id when the focused id isn't in the list", () => {
    expect(cycleTaskId(ids, "zzz", "up")).toBe("a");
  });

  it("wraps correctly with a single-item list", () => {
    expect(cycleTaskId(["only"], "only", "down")).toBe("only");
    expect(cycleTaskId(["only"], "only", "up")).toBe("only");
  });
});
