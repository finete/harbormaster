import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  childrenIndex,
  depthOf,
  descendantsOf,
  indexTasks,
  inSameTree,
  rootOf,
  subtreeHeight,
  type TreeTask,
} from "../src/engines/task-tree.js";

// A ─ B ─ C
//   │   └ D
//   └ E ─ F
// X
const tasks: TreeTask[] = [
  { id: "A" },
  { id: "B", parentTaskId: "A" },
  { id: "C", parentTaskId: "B" },
  { id: "D", parentTaskId: "B" },
  { id: "E", parentTaskId: "A" },
  { id: "F", parentTaskId: "E" },
  { id: "X" },
];
const byId = indexTasks(tasks);
const children = childrenIndex(tasks);
const get = (id: string): TreeTask => byId.get(id) as TreeTask;

describe("task tree", () => {
  it("walks ancestors nearest first and measures depth", () => {
    expect(ancestorsOf(get("C"), byId).map((t) => t.id)).toEqual(["B", "A"]);
    expect(depthOf(get("A"), byId)).toBe(1);
    expect(depthOf(get("F"), byId)).toBe(3);
  });

  it("finds the root and same-tree membership", () => {
    expect(rootOf(get("D"), byId).id).toBe("A");
    expect(rootOf(get("X"), byId).id).toBe("X");
    expect(inSameTree(get("C"), get("F"), byId)).toBe(true);
    expect(inSameTree(get("C"), get("X"), byId)).toBe(false);
  });

  it("lists descendants and subtree height", () => {
    expect(descendantsOf("A", children).map((t) => t.id)).toEqual([
      "B",
      "E",
      "C",
      "D",
      "F",
    ]);
    expect(descendantsOf("C", children)).toEqual([]);
    expect(subtreeHeight("A", children)).toBe(3);
    expect(subtreeHeight("E", children)).toBe(2);
    expect(subtreeHeight("C", children)).toBe(1);
  });

  it("treats a missing parent as top-level and survives a parent loop", () => {
    const orphan: TreeTask = { id: "O", parentTaskId: "gone" };
    expect(depthOf(orphan, indexTasks([orphan]))).toBe(1);
    const loop: TreeTask[] = [
      { id: "P", parentTaskId: "Q" },
      { id: "Q", parentTaskId: "P" },
    ];
    const loopById = indexTasks(loop);
    expect(depthOf(loop[0] as TreeTask, loopById)).toBe(2);
    expect(descendantsOf("P", childrenIndex(loop)).map((t) => t.id)).toEqual([
      "Q",
    ]);
    expect(subtreeHeight("P", childrenIndex(loop))).toBe(2);
  });
});
