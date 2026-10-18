import { describe, expect, it } from "vitest";
import type { BoardColumn, Task } from "../src/preload/api";
import {
  boardGroupKey,
  buildSelectionGrid,
  columnCountLabel,
  firstSelectableTaskId,
  isBoardGroupCollapsed,
  moveSelection,
  resolveSelection,
  visibleGroupsForColumn,
} from "../src/renderer/src/lib/board-selection";

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

/**
 * backlog: [b1, b2]
 * dev: [] (empty \u2014 left/right must skip it)
 * awaiting: [a1] split across two groups
 * done: [d1 (archived), d2]
 */
function board(): BoardColumn[] {
  return [
    {
      state: "backlog",
      title: "Backlog",
      groups: [
        {
          id: "scratch",
          tasks: [
            task({ id: "b1", state: "backlog" }),
            task({ id: "b2", state: "backlog" }),
          ],
        },
      ],
    },
    { state: "dev", title: "Dev", groups: [] },
    {
      state: "awaiting",
      title: "Awaiting",
      groups: [
        {
          id: "review",
          primaryLabel: "Review",
          tasks: [task({ id: "a1", state: "awaiting" })],
        },
        {
          id: "slack",
          primaryLabel: "Slack",
          tasks: [task({ id: "a2", state: "awaiting" })],
        },
      ],
    },
    {
      state: "done",
      title: "Done",
      groups: [
        {
          id: "scratch",
          tasks: [
            task({ id: "d1", state: "done", archivedAt: T0 }),
            task({ id: "d2", state: "done" }),
          ],
        },
      ],
    },
  ];
}

describe("visibleGroupsForColumn", () => {
  it("hides archived tasks in the done column by default", () => {
    const [, , , done] = board();
    if (!done) throw new Error("missing done column");
    const groups = visibleGroupsForColumn(done, false);
    expect(groups.flatMap((g) => g.tasks.map((t) => t.id))).toEqual(["d2"]);
  });

  it("shows archived tasks in the done column when requested", () => {
    const [, , , done] = board();
    if (!done) throw new Error("missing done column");
    const groups = visibleGroupsForColumn(done, true);
    expect(groups.flatMap((g) => g.tasks.map((t) => t.id))).toEqual([
      "d1",
      "d2",
    ]);
  });

  it("never filters non-done columns", () => {
    const [backlog] = board();
    if (!backlog) throw new Error("missing backlog column");
    expect(visibleGroupsForColumn(backlog, false)).toEqual(backlog.groups);
  });
});

describe("buildSelectionGrid", () => {
  it("flattens each column's visible groups into one ordered id list", () => {
    const grid = buildSelectionGrid(board(), false);
    expect(grid).toEqual([
      { state: "backlog", taskIds: ["b1", "b2"] },
      { state: "dev", taskIds: [] },
      { state: "awaiting", taskIds: ["a1", "a2"] },
      { state: "done", taskIds: ["d2"] },
    ]);
  });
});

describe("firstSelectableTaskId / resolveSelection", () => {
  it("picks the first card of the first non-empty column", () => {
    const grid = buildSelectionGrid(board(), false);
    expect(firstSelectableTaskId(grid)).toBe("b1");
  });

  it("returns null for a fully empty board", () => {
    expect(firstSelectableTaskId([{ state: "backlog", taskIds: [] }])).toBe(
      null,
    );
  });

  it("keeps following a task that's still present", () => {
    const grid = buildSelectionGrid(board(), false);
    expect(resolveSelection(grid, "a2")).toBe("a2");
  });

  it("falls back to the first card once the selected task vanishes", () => {
    const grid = buildSelectionGrid(board(), false);
    expect(resolveSelection(grid, "d1")).toBe("b1"); // d1 is archived-hidden
    expect(resolveSelection(grid, null)).toBe("b1");
  });
});

describe("moveSelection", () => {
  it("moves down/up within a column, clamping at the edges", () => {
    const grid = buildSelectionGrid(board(), false);
    expect(moveSelection(grid, "a1", "down")).toBe("a2");
    expect(moveSelection(grid, "a2", "down")).toBe("a2"); // clamp at bottom
    expect(moveSelection(grid, "a2", "up")).toBe("a1");
    expect(moveSelection(grid, "a1", "up")).toBe("a1"); // clamp at top
  });

  it("moves right/left, skipping empty columns", () => {
    const grid = buildSelectionGrid(board(), false);
    // backlog -> dev is empty, lands on awaiting instead.
    expect(moveSelection(grid, "b1", "right")).toBe("a1");
    // awaiting -> dev is empty, lands back on backlog.
    expect(moveSelection(grid, "a1", "left")).toBe("b1");
  });

  it("preserves row index across a horizontal move when possible", () => {
    const grid = buildSelectionGrid(board(), false);
    expect(moveSelection(grid, "b2", "right")).toBe("a2");
  });

  it("clamps the row index when the target column is shorter", () => {
    const grid = buildSelectionGrid(board(), false);
    // done only has one visible card ("d2"); row 1 (b2/a2) clamps to it.
    expect(moveSelection(grid, "a2", "right")).toBe("d2");
  });

  it("stays put when there's no adjacent non-empty column", () => {
    const grid = buildSelectionGrid(board(), false);
    expect(moveSelection(grid, "d2", "right")).toBe("d2");
    expect(moveSelection(grid, "b1", "left")).toBe("b1");
  });

  it("falls back to the first card when the current task has disappeared", () => {
    const grid = buildSelectionGrid(board(), false);
    expect(moveSelection(grid, "ghost", "right")).toBe("b1");
    expect(moveSelection(grid, null, "down")).toBe("b1");
  });
});

describe("collapsed board groups", () => {
  it("keys a group by column + group id so each column's copy is independent", () => {
    expect(boardGroupKey("backlog", "scratch")).toBe("backlog:scratch");
    const collapsed = new Set([boardGroupKey("backlog", "scratch")]);
    expect(isBoardGroupCollapsed(collapsed, "backlog", "scratch")).toBe(true);
    expect(isBoardGroupCollapsed(collapsed, "done", "scratch")).toBe(false);
    expect(isBoardGroupCollapsed(undefined, "backlog", "scratch")).toBe(false);
  });

  it("drops a collapsed group's cards from the grid, leaving the rest in order", () => {
    const grid = buildSelectionGrid(
      board(),
      false,
      new Set([boardGroupKey("awaiting", "review")]),
    );
    expect(grid).toEqual([
      { state: "backlog", taskIds: ["b1", "b2"] },
      { state: "dev", taskIds: [] },
      { state: "awaiting", taskIds: ["a2"] },
      { state: "done", taskIds: ["d2"] },
    ]);
  });

  it("only collapses the matching column's group", () => {
    // "scratch" exists in backlog and done; collapsing done's leaves backlog's.
    const grid = buildSelectionGrid(
      board(),
      false,
      new Set([boardGroupKey("done", "scratch")]),
    );
    expect(grid.find((c) => c.state === "backlog")?.taskIds).toEqual([
      "b1",
      "b2",
    ]);
    expect(grid.find((c) => c.state === "done")?.taskIds).toEqual([]);
  });

  it("arrow navigation skips cards in collapsed groups", () => {
    const grid = buildSelectionGrid(
      board(),
      false,
      new Set([boardGroupKey("awaiting", "review")]),
    );
    // a1 is hidden: down from nothing above, right from b1 lands on a2.
    expect(moveSelection(grid, "b1", "right")).toBe("a2");
    expect(moveSelection(grid, "a2", "up")).toBe("a2");
    // A fully collapsed column is skipped like an empty one.
    const allCollapsed = buildSelectionGrid(
      board(),
      false,
      new Set([
        boardGroupKey("awaiting", "review"),
        boardGroupKey("awaiting", "slack"),
      ]),
    );
    expect(moveSelection(allCollapsed, "b1", "right")).toBe("d2");
  });

  it("drops the selection back to the first card once its group collapses", () => {
    const grid = buildSelectionGrid(
      board(),
      false,
      new Set([boardGroupKey("awaiting", "slack")]),
    );
    expect(resolveSelection(grid, "a2")).toBe("b1");
  });
});

describe("collapsed columns (slim rail)", () => {
  it("drops a collapsed column's cards entirely from the grid", () => {
    const grid = buildSelectionGrid(
      board(),
      false,
      undefined,
      new Set(["backlog"]),
    );
    expect(grid).toEqual([
      { state: "backlog", taskIds: [] },
      { state: "dev", taskIds: [] },
      { state: "awaiting", taskIds: ["a1", "a2"] },
      { state: "done", taskIds: ["d2"] },
    ]);
  });

  it("left/right crosses a collapsed column to the next expanded one", () => {
    const grid = buildSelectionGrid(
      board(),
      false,
      undefined,
      new Set(["backlog"]),
    );
    // dev is empty and backlog is collapsed: right from a1 still only has
    // done beyond it; left from a1 skips both and lands nowhere, so it stays.
    expect(moveSelection(grid, "a1", "left")).toBe("a1");
    expect(moveSelection(grid, "a2", "right")).toBe("d2");
  });

  it("is independent of group collapse: both can apply to the same column", () => {
    const grid = buildSelectionGrid(
      board(),
      false,
      new Set([boardGroupKey("awaiting", "review")]),
      new Set(["backlog", "done"]),
    );
    expect(grid).toEqual([
      { state: "backlog", taskIds: [] },
      { state: "dev", taskIds: [] },
      { state: "awaiting", taskIds: ["a2"] },
      { state: "done", taskIds: [] },
    ]);
  });

  it("resolveSelection falls back to the first visible card once a column collapses", () => {
    const grid = buildSelectionGrid(
      board(),
      false,
      undefined,
      new Set(["backlog"]),
    );
    expect(resolveSelection(grid, "b1")).toBe("a1");
  });
});

describe("columnCountLabel", () => {
  it("is a plain count when nothing is filtered out", () => {
    expect(columnCountLabel(3, 0)).toEqual({ text: "3", title: "3 tasks" });
  });

  it("reads shown/total while archived cards are hidden", () => {
    expect(columnCountLabel(2, 5)).toEqual({
      text: "2/7",
      title: "2 shown · 5 archived hidden",
    });
  });
});
