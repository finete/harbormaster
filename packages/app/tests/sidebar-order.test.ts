import { describe, expect, it } from "vitest";
import {
  appendToOrder,
  dragVisibleRows,
  groupSortableId,
  mergeSectionOrder,
  NEST_INDENT_PX,
  parseSortableId,
  projectGroupDrop,
  projectTaskDrop,
  removeFromOrder,
  type SectionRow,
  sortByOrder,
  taskSortableId,
} from "../src/renderer/src/lib/sidebar-order";

describe("sortByOrder", () => {
  const id = (s: string): string => s;
  it("sorts by stored index; unknown ids go after, in input order", () => {
    expect(sortByOrder(["x", "b", "y", "a"], ["a", "b"], id)).toEqual([
      "a",
      "b",
      "x",
      "y",
    ]);
  });
  it("is a no-op for an empty order", () => {
    expect(sortByOrder(["b", "a"], [], id)).toEqual(["b", "a"]);
  });
});

describe("append / remove", () => {
  it("appends an unknown id at the bottom, and is idempotent", () => {
    const order = ["a", "b"];
    expect(appendToOrder(order, "c")).toEqual(["a", "b", "c"]);
    expect(appendToOrder(order, "a")).toBe(order);
  });
  it("removes an id, so a reopen appends at the bottom again", () => {
    const order = ["a", "b", "c"];
    const closed = removeFromOrder(order, "b");
    expect(closed).toEqual(["a", "c"]);
    expect(removeFromOrder(closed, "zzz")).toBe(closed);
    expect(appendToOrder(closed, "b")).toEqual(["a", "c", "b"]);
  });
});

describe("sortable ids", () => {
  it("namespaces tasks and groups so they can never collide", () => {
    expect(taskSortableId("x")).not.toBe(groupSortableId("x"));
    expect(parseSortableId(taskSortableId("x"))).toEqual({
      kind: "task",
      value: "x",
    });
    expect(parseSortableId(groupSortableId("repo"))).toEqual({
      kind: "group",
      value: "repo",
    });
    expect(parseSortableId("plain")).toBeNull();
  });
});

describe("mergeSectionOrder", () => {
  it("puts the reordered subset back into its own slots, leaving other ids in place", () => {
    // Section {a, c} swapped; b (another section) keeps slot 1.
    expect(
      mergeSectionOrder(["a", "b", "c"], ["a", "b", "c"], ["c", "a"]),
    ).toEqual(["c", "b", "a"]);
  });
  it("appends ids the store doesn't know yet (legacy) before merging", () => {
    expect(mergeSectionOrder(["a"], ["a", "b", "c"], ["c", "b"])).toEqual([
      "a",
      "c",
      "b",
    ]);
  });
  it("keeps stale stored ids where they were", () => {
    expect(
      mergeSectionOrder(["a", "stale", "b"], ["a", "b"], ["b", "a"]),
    ).toEqual(["b", "stale", "a"]);
  });
});

// Section layout used below (fully expanded):
//   P (c1 c2 c3 nested)   X   Q (q1 nested)   Y   D (detached child of P)
const FULL: SectionRow[] = [
  { id: "P", nested: false },
  { id: "c1", nested: true, parentId: "P" },
  { id: "c2", nested: true, parentId: "P" },
  { id: "c3", nested: true, parentId: "P" },
  { id: "X", nested: false },
  { id: "Q", nested: false },
  { id: "q1", nested: true, parentId: "Q" },
  { id: "Y", nested: false },
  { id: "D", nested: false, parentId: "P" },
];
const ids = (rows: readonly SectionRow[]): string[] => rows.map((r) => r.id);

describe("dragVisibleRows (R10/R15)", () => {
  it("hides every nested block, including the dragged top-level row's own children", () => {
    expect(ids(dragVisibleRows(FULL, "P"))).toEqual(["P", "X", "Q", "Y", "D"]);
    expect(ids(dragVisibleRows(FULL, "X"))).toEqual(["P", "X", "Q", "Y", "D"]);
  });
  it("shows only the dragged child's own parent's block", () => {
    expect(ids(dragVisibleRows(FULL, "c2"))).toEqual([
      "P",
      "c1",
      "c2",
      "c3",
      "X",
      "Q",
      "Y",
      "D",
    ]);
    expect(ids(dragVisibleRows(FULL, "q1"))).toEqual([
      "P",
      "X",
      "Q",
      "q1",
      "Y",
      "D",
    ]);
  });
  it("shows a detached child's parent block too, so it can be re-attached", () => {
    expect(ids(dragVisibleRows(FULL, "D"))).toContain("c1");
    expect(ids(dragVisibleRows(FULL, "D"))).not.toContain("q1");
  });
});

describe("projectTaskDrop", () => {
  it("R10: a top-level row moves; hidden children stay with their parent block", () => {
    const result = projectTaskDrop(FULL, "X", "Y", 0);
    expect(result?.sequence).toEqual([
      "P",
      "c1",
      "c2",
      "c3",
      "Q",
      "q1",
      "Y",
      "X",
      "D",
    ]);
    expect(result?.attached).toBeNull();
    expect(result?.changed).toBe(true);
  });

  it("R10: dragging a parent moves it with its whole block", () => {
    const result = projectTaskDrop(FULL, "P", "Y", 0);
    expect(result?.sequence).toEqual([
      "X",
      "Q",
      "q1",
      "Y",
      "P",
      "c1",
      "c2",
      "c3",
      "D",
    ]);
  });

  it("R11: reorders a child among its siblings (interior slot)", () => {
    const result = projectTaskDrop(FULL, "c3", "c1", 0);
    expect(result?.sequence.slice(0, 4)).toEqual(["P", "c3", "c1", "c2"]);
    expect(result?.attached).toBe(true);
    expect(result?.changed).toBe(true);
  });

  it("R11/R14: end-of-block boundary stays attached with no horizontal offset", () => {
    const result = projectTaskDrop(FULL, "c1", "c3", 0);
    expect(result?.sequence.slice(0, 4)).toEqual(["P", "c2", "c3", "c1"]);
    expect(result?.attached).toBe(true);
  });

  it("R14: end-of-block boundary detaches when moved left by the indent", () => {
    const left = projectTaskDrop(FULL, "c1", "c3", -NEST_INDENT_PX);
    expect(left?.attached).toBe(false);
    expect(left?.sequence.slice(0, 4)).toEqual(["P", "c2", "c3", "c1"]);
    const almost = projectTaskDrop(FULL, "c1", "c3", -(NEST_INDENT_PX - 1));
    expect(almost?.attached).toBe(true);
  });

  it("R12: dropping a child outside its block detaches it at the drop position", () => {
    const result = projectTaskDrop(FULL, "c2", "Y", 0);
    expect(result?.attached).toBe(false);
    expect(result?.sequence).toEqual([
      "P",
      "c1",
      "c3",
      "X",
      "Q",
      "q1",
      "Y",
      "c2",
      "D",
    ]);
    expect(result?.changed).toBe(true);
  });

  it("R12: dropping a child above its parent detaches it", () => {
    const result = projectTaskDrop(FULL, "c1", "P", 0);
    expect(result?.attached).toBe(false);
    expect(result?.sequence[0]).toBe("c1");
  });

  it("R13: a detached child dropped inside its parent's block re-attaches", () => {
    const result = projectTaskDrop(FULL, "D", "c2", 0);
    expect(result?.attached).toBe(true);
    expect(result?.sequence.slice(0, 5)).toEqual(["P", "c1", "D", "c2", "c3"]);
  });

  it("R14: a detached child at the end-of-block boundary needs a rightward offset to attach", () => {
    expect(projectTaskDrop(FULL, "D", "X", 0)?.attached).toBe(false);
    expect(projectTaskDrop(FULL, "D", "X", NEST_INDENT_PX - 1)?.attached).toBe(
      false,
    );
    const right = projectTaskDrop(FULL, "D", "X", NEST_INDENT_PX);
    expect(right?.attached).toBe(true);
    expect(right?.sequence.slice(0, 5)).toEqual(["P", "c1", "c2", "c3", "D"]);
  });

  it("R15: a non-child can never be dropped into a block (nested rows aren't targets)", () => {
    expect(projectTaskDrop(FULL, "X", "c1", 0)).toBeNull();
    expect(projectTaskDrop(FULL, "Y", "q1", 0)).toBeNull();
  });

  it("R15: a child of another parent can never be dropped into this block", () => {
    expect(projectTaskDrop(FULL, "q1", "c1", 0)).toBeNull();
    // q1 can only detach: dropped among the top-level rows.
    const out = projectTaskDrop(FULL, "q1", "Y", 0);
    expect(out?.attached).toBe(false);
  });

  it("R19: dropping where it started is a no-op", () => {
    expect(projectTaskDrop(FULL, "X", "X", 0)?.changed).toBe(false);
    expect(projectTaskDrop(FULL, "P", "P", 0)?.changed).toBe(false);
    expect(projectTaskDrop(FULL, "c3", "c3", 0)?.changed).toBe(false);
    expect(projectTaskDrop(FULL, "D", "D", 0)?.changed).toBe(false);
  });

  it("R19/R14: dropping in place but dragged left past the indent still detaches (not a no-op)", () => {
    const result = projectTaskDrop(FULL, "c3", "c3", -NEST_INDENT_PX - 4);
    expect(result?.attached).toBe(false);
    expect(result?.changed).toBe(true);
  });

  it("returns null for ids that aren't visible", () => {
    expect(projectTaskDrop(FULL, "ghost", "X", 0)).toBeNull();
    expect(projectTaskDrop(FULL, "X", "ghost", 0)).toBeNull();
  });
});

describe("projectGroupDrop (R17/R19)", () => {
  it("moves a group to the over position", () => {
    expect(projectGroupDrop(["a", "b", "c"], "a", "c")).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(projectGroupDrop(["a", "b", "c"], "c", "a")).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
  it("is a no-op when dropped on itself or on an unknown label", () => {
    expect(projectGroupDrop(["a", "b"], "a", "a")).toBeNull();
    expect(projectGroupDrop(["a", "b"], "a", "zzz")).toBeNull();
  });
});
