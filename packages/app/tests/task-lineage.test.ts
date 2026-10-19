import { describe, expect, it } from "vitest";
import type { Task } from "../src/preload/api";
import {
  buildLineageIndex,
  hiddenNestedChildIds,
  layoutLineageRows,
} from "../src/renderer/src/lib/task-lineage";

const T0 = "2025-01-01T00:00:00.000Z";

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    kind: "task",
    state: "dev",
    title: overrides.id,
    initialPrompt: "",
    createdAt: T0,
    updatedAt: T0,
    stateChangedAt: T0,
    ...overrides,
  };
}

describe("buildLineageIndex", () => {
  it("indexes children by parent, oldest first", () => {
    const parent = task({ id: "parent" });
    const childB = task({
      id: "child-b",
      parentTaskId: "parent",
      createdAt: "2025-01-02T00:00:00.000Z",
    });
    const childA = task({
      id: "child-a",
      parentTaskId: "parent",
      createdAt: "2025-01-01T12:00:00.000Z",
    });
    const index = buildLineageIndex([parent, childB, childA]);
    expect(index.childrenByParent.get("parent")?.map((t) => t.id)).toEqual([
      "child-a",
      "child-b",
    ]);
    expect(index.taskById.get("parent")?.title).toBe("parent");
  });

  it("ignores tasks with no parentTaskId", () => {
    const index = buildLineageIndex([task({ id: "solo" })]);
    expect(index.childrenByParent.size).toBe(0);
  });
});

describe("layoutLineageRows", () => {
  it("nests a child directly after its parent when both are in the same group", () => {
    const parent = task({ id: "parent" });
    const child = task({ id: "child", parentTaskId: "parent" });
    const other = task({ id: "other" });
    const index = buildLineageIndex([parent, child, other]);
    const items = [parent, child, other].map((t) => ({ task: t }));
    const rows = layoutLineageRows(items, index, new Set());
    expect(rows.map((r) => r.item.task.id)).toEqual([
      "parent",
      "child",
      "other",
    ]);
    expect(rows[0]?.nested).toBe(false);
    expect(rows[0]?.children).toEqual({
      count: 1,
      collapsed: false,
      nestedHere: true,
    });
    expect(rows[1]?.nested).toBe(true);
    expect(rows[1]?.parentTitle).toBeUndefined();
  });

  it("collapses a parent's nested children on request, keeping the chip", () => {
    const parent = task({ id: "parent" });
    const child = task({ id: "child", parentTaskId: "parent" });
    const index = buildLineageIndex([parent, child]);
    const items = [parent, child].map((t) => ({ task: t }));
    const rows = layoutLineageRows(items, index, new Set(["parent"]));
    expect(rows.map((r) => r.item.task.id)).toEqual(["parent"]);
    expect(rows[0]?.children).toEqual({
      count: 1,
      collapsed: true,
      nestedHere: true,
    });
  });

  it("shows a flat row with a parent-title lineage line when the parent is elsewhere (different column/group)", () => {
    const parent = task({ id: "parent", state: "done" });
    const child = task({ id: "child", parentTaskId: "parent", state: "dev" });
    // Only the child is in this rendering group (the parent is in Done).
    const index = buildLineageIndex([parent, child]);
    const items = [{ task: child }];
    const rows = layoutLineageRows(items, index, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nested).toBe(false);
    expect(rows[0]?.parentTitle).toBe("parent");
  });

  it("a Done parent still reports its total child count even with none nested there", () => {
    const parent = task({ id: "parent", state: "done" });
    const child = task({ id: "child", parentTaskId: "parent", state: "dev" });
    const index = buildLineageIndex([parent, child]);
    // Only the parent is in this rendering group (the Done column).
    const items = [{ task: parent }];
    const rows = layoutLineageRows(items, index, new Set());
    expect(rows[0]?.children).toEqual({
      count: 1,
      collapsed: false,
      nestedHere: false,
    });
  });

  it("omits the lineage line when the parent task is unknown", () => {
    const child = task({ id: "child", parentTaskId: "ghost" });
    const index = buildLineageIndex([child]);
    const rows = layoutLineageRows([{ task: child }], index, new Set());
    expect(rows[0]?.parentTitle).toBeUndefined();
  });
});

describe("hiddenNestedChildIds", () => {
  it("hides a child only when its same-group parent is collapsed", () => {
    const parent = task({ id: "parent" });
    const child = task({ id: "child", parentTaskId: "parent" });
    const items = [{ task: parent }, { task: child }];
    expect(hiddenNestedChildIds(items, new Set())).toEqual(new Set());
    expect(hiddenNestedChildIds(items, new Set(["parent"]))).toEqual(
      new Set(["child"]),
    );
  });

  it("never hides a child whose parent isn't in the same group", () => {
    const child = task({ id: "child", parentTaskId: "elsewhere" });
    expect(
      hiddenNestedChildIds([{ task: child }], new Set(["elsewhere"])),
    ).toEqual(new Set());
  });
});
