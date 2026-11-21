import { describe, expect, it } from "vitest";
import {
  atMaxDepth,
  childLaunchRefusal,
  maxDepthMessage,
  reparentRefusal,
  treesDeeperThan,
} from "../src/engines/task-nesting.js";

interface T {
  id: string;
  title: string;
  parentTaskId?: string;
}
const t = (id: string, parentTaskId?: string): T => ({
  id,
  title: id,
  ...(parentTaskId ? { parentTaskId } : {}),
});

// A ─ B ─ C        X ─ Y
//   └ D            Z
const tasks: T[] = [
  t("A"),
  t("B", "A"),
  t("C", "B"),
  t("D", "A"),
  t("X"),
  t("Y", "X"),
  t("Z"),
];
const get = (id: string): T => tasks.find((task) => task.id === id) as T;

describe("childLaunchRefusal", () => {
  it("refuses only a launcher already at the max depth, with the agreed message", () => {
    expect(childLaunchRefusal(get("C"), tasks, 3)).toBe(maxDepthMessage(3));
    expect(maxDepthMessage(3)).toBe(
      "you're at the max nesting depth (3); do the work yourself or launch a standalone task",
    );
    expect(childLaunchRefusal(get("B"), tasks, 3)).toBeUndefined();
    expect(childLaunchRefusal(get("A"), tasks, 3)).toBeUndefined();
  });

  it("depth 1 means no children at all; a deeper tree than the max is left alone but cannot grow", () => {
    expect(childLaunchRefusal(get("Z"), tasks, 1)).toBe(maxDepthMessage(1));
    // C is at depth 3: with the setting lowered to 2 it simply cannot launch.
    expect(childLaunchRefusal(get("C"), tasks, 2)).toBe(maxDepthMessage(2));
    expect(childLaunchRefusal(get("B"), tasks, 2)).toBe(maxDepthMessage(2));
    expect(childLaunchRefusal(get("A"), tasks, 2)).toBeUndefined();
  });
});

describe("atMaxDepth", () => {
  it("is true at or past the max", () => {
    expect(atMaxDepth(3, 3)).toBe(true);
    expect(atMaxDepth(2, 3)).toBe(false);
    expect(atMaxDepth(4, 3)).toBe(true);
  });
});

describe("reparentRefusal", () => {
  it("allows a task whose subtree fits under the new parent", () => {
    // B (height 2) under X (depth 1): 1 + 2 = 3 <= 3.
    expect(reparentRefusal(get("B"), get("X"), tasks, 3)).toBeUndefined();
    // A leaf under a depth-2 task: 2 + 1 = 3.
    expect(reparentRefusal(get("Z"), get("Y"), tasks, 3)).toBeUndefined();
  });

  it("refuses when the moved subtree does not fit, naming the depths", () => {
    // A (height 3) under X: 1 + 3 = 4 > 3.
    expect(reparentRefusal(get("A"), get("X"), tasks, 3)).toMatch(
      /4 levels deep; the max nesting depth is 3/,
    );
    // B (height 2) under Y (depth 2): 2 + 2 = 4 > 3.
    expect(reparentRefusal(get("B"), get("Y"), tasks, 3)).toMatch(
      /max nesting/,
    );
    // The same move fits at max depth 4.
    expect(reparentRefusal(get("B"), get("Y"), tasks, 4)).toBeUndefined();
  });

  it("refuses a cycle: under itself or one of its own descendants", () => {
    expect(reparentRefusal(get("A"), get("A"), tasks, 4)).toMatch(
      /its own parent/,
    );
    expect(reparentRefusal(get("A"), get("C"), tasks, 4)).toMatch(
      /own subtask/,
    );
    expect(reparentRefusal(get("B"), get("C"), tasks, 4)).toMatch(
      /own subtask/,
    );
  });

  it("moving within its own tree to a shallower parent is fine at any setting that holds it", () => {
    // C (leaf) from under B to under A: depth 2, within max 2.
    expect(reparentRefusal(get("C"), get("A"), tasks, 2)).toBeUndefined();
  });
});

describe("treesDeeperThan", () => {
  it("counts each too-deep tree once, by its top-level task", () => {
    expect(treesDeeperThan(tasks, 3)).toBe(0);
    expect(treesDeeperThan(tasks, 2)).toBe(1);
    expect(treesDeeperThan(tasks, 1)).toBe(2);
  });
});
