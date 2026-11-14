import { describe, expect, it } from "vitest";
import type { BoardColumn, Task } from "../src/preload/api";
import {
  buildSelectionGrid,
  visibleGroupsForColumn,
} from "../src/renderer/src/lib/board-selection";
import {
  buildLineageIndex,
  hiddenNestedChildIds,
  hoistChildrenIntoParentGroups,
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

describe("layoutLineageRows opt-in options (sidebar)", () => {
  const parent = task({ id: "parent" });
  const early = task({
    id: "early",
    parentTaskId: "parent",
    createdAt: "2025-01-01T01:00:00.000Z",
  });
  const late = task({
    id: "late",
    parentTaskId: "parent",
    createdAt: "2025-01-01T02:00:00.000Z",
  });
  const index = buildLineageIndex([parent, early, late]);
  const items = [{ task: parent }, { task: early }, { task: late }];

  it("sorts nested siblings by createdAt when no options are supplied (board behaviour)", () => {
    const rows = layoutLineageRows(items, index, new Set());
    expect(rows.map((r) => r.item.task.id)).toEqual([
      "parent",
      "early",
      "late",
    ]);
  });

  it("sorts nested siblings by the supplied order, unknown ids last", () => {
    const rows = layoutLineageRows(items, index, new Set(), {
      siblingOrder: ["late"],
    });
    expect(rows.map((r) => r.item.task.id)).toEqual([
      "parent",
      "late",
      "early",
    ]);
  });

  it("renders a detached child top-level with its parent line, at its own position", () => {
    const rows = layoutLineageRows(
      [{ task: early }, { task: parent }, { task: late }],
      index,
      new Set(),
      { detachedIds: new Set(["early"]) },
    );
    expect(rows.map((r) => [r.item.task.id, r.nested])).toEqual([
      ["early", false],
      ["parent", false],
      ["late", true],
    ]);
    expect(rows[0]?.parentTitle).toBe("parent");
    expect(rows[1]?.children).toEqual({
      count: 2,
      collapsed: false,
      nestedHere: true,
    });
  });

  it("a parent whose every child is detached has nothing nested here", () => {
    const rows = layoutLineageRows(items, index, new Set(), {
      detachedIds: new Set(["early", "late"]),
    });
    expect(rows.find((r) => r.item.task.id === "parent")?.children).toEqual({
      count: 2,
      collapsed: false,
      nestedHere: false,
    });
  });
});

describe("lineage wins over repo within a column", () => {
  const ALPHA = "github.com/o/alpha";
  const BETA = "github.com/o/beta";
  const parent = task({ id: "parent", repositoryId: ALPHA });
  const betaChild = task({
    id: "beta-child",
    parentTaskId: "parent",
    repositoryId: BETA,
  });
  const betaSolo = task({ id: "beta-solo", repositoryId: BETA });
  const scratchChild = task({ id: "scratch-child", parentTaskId: "parent" });

  /** One column grouped the way core's board-grouping does (per repo). */
  function devColumn(tasks: Task[]): BoardColumn {
    const byRepo = new Map<string, Task[]>();
    for (const t of tasks) {
      const id = t.repositoryId ?? "scratch";
      byRepo.set(id, [...(byRepo.get(id) ?? []), t]);
    }
    return {
      state: "dev",
      title: "Dev",
      groups: [...byRepo.entries()].map(([id, groupTasks]) => ({
        id,
        repoLabel: id.split("/").pop() ?? id,
        tasks: groupTasks,
      })),
    };
  }

  it("moves a cross-repo child into its parent's repo group and nests it there", () => {
    const column = devColumn([parent, betaChild, betaSolo, scratchChild]);
    const groups = visibleGroupsForColumn(column, false);
    expect(groups.map((g) => [g.id, g.tasks.map((t) => t.id)])).toEqual([
      [ALPHA, ["parent", "beta-child", "scratch-child"]],
      [BETA, ["beta-solo"]],
    ]);
    // Group counts are the rows under each header.
    expect(groups.map((g) => g.tasks.length)).toEqual([3, 1]);
    const index = buildLineageIndex([
      parent,
      betaChild,
      betaSolo,
      scratchChild,
    ]);
    const rows = layoutLineageRows(
      (groups[0]?.tasks ?? []).map((t) => ({ task: t })),
      index,
      new Set(),
    );
    expect(rows.map((r) => [r.item.task.id, r.nested])).toEqual([
      ["parent", false],
      ["beta-child", true],
      ["scratch-child", true],
    ]);
    expect(rows[0]?.children).toEqual({
      count: 2,
      collapsed: false,
      nestedHere: true,
    });
  });

  it("drops a repo group the move empties", () => {
    const groups = visibleGroupsForColumn(
      devColumn([parent, betaChild]),
      false,
    );
    expect(groups.map((g) => [g.id, g.tasks.length])).toEqual([[ALPHA, 2]]);
  });

  it("leaves a child whose parent is in another column in its own repo group", () => {
    // Parent sits in Done; only the child is in this (Dev) column.
    const groups = visibleGroupsForColumn(
      devColumn([betaChild, betaSolo]),
      false,
    );
    expect(groups.map((g) => [g.id, g.tasks.map((t) => t.id)])).toEqual([
      [BETA, ["beta-child", "beta-solo"]],
    ]);
    const index = buildLineageIndex([
      { ...parent, state: "done" },
      betaChild,
      betaSolo,
    ]);
    const rows = layoutLineageRows(
      (groups[0]?.tasks ?? []).map((t) => ({ task: t })),
      index,
      new Set(),
    );
    expect(rows[0]?.nested).toBe(false);
    expect(rows[0]?.parentTitle).toBe("parent");
  });

  it("never moves a child into a parent hidden as archived", () => {
    const archivedParent = {
      ...parent,
      state: "done" as const,
      archivedAt: T0,
    };
    const doneChild = { ...betaChild, state: "done" as const };
    const column: BoardColumn = {
      ...devColumn([archivedParent, doneChild]),
      state: "done",
      title: "Done",
    };
    expect(visibleGroupsForColumn(column, false).map((g) => g.id)).toEqual([
      BETA,
    ]);
    expect(
      visibleGroupsForColumn(column, true).map((g) => [g.id, g.tasks.length]),
    ).toEqual([[ALPHA, 2]]);
  });

  it("in Awaiting, nests across repos only within the same awaiting kind", () => {
    const review = { kind: "review" as const };
    const slack = { kind: "slack" as const };
    const p = { ...parent, state: "awaiting" as const, awaiting: review };
    const sameKind = {
      ...betaChild,
      state: "awaiting" as const,
      awaiting: review,
    };
    const otherKind = {
      ...task({
        id: "slack-child",
        parentTaskId: "parent",
        repositoryId: BETA,
      }),
      state: "awaiting" as const,
      awaiting: slack,
    };
    const column: BoardColumn = {
      state: "awaiting",
      title: "Awaiting",
      groups: [
        { id: `Review::${ALPHA}`, primaryLabel: "Review", tasks: [p] },
        { id: `Review::${BETA}`, primaryLabel: "Review", tasks: [sameKind] },
        {
          id: `Slack response::${BETA}`,
          primaryLabel: "Slack response",
          tasks: [otherKind],
        },
      ],
    };
    expect(
      visibleGroupsForColumn(column, false).map((g) => [
        g.id,
        g.tasks.map((t) => t.id),
      ]),
    ).toEqual([
      [`Review::${ALPHA}`, ["parent", "beta-child"]],
      [`Slack response::${BETA}`, ["slack-child"]],
    ]);
  });

  it("keeps the keyboard grid in on-screen order, hiding a collapsed parent's hosted child", () => {
    const columns = [devColumn([betaSolo, parent, betaChild])];
    // Core order would put beta first; the hosted child follows its parent.
    expect(buildSelectionGrid(columns, false)[0]?.taskIds).toEqual([
      "beta-solo",
      "parent",
      "beta-child",
    ]);
    expect(
      buildSelectionGrid(
        columns,
        false,
        undefined,
        undefined,
        new Set(["parent"]),
      )[0]?.taskIds,
    ).toEqual(["beta-solo", "parent"]);
  });

  it("returns the groups unchanged when nothing moves", () => {
    const groups = [{ tasks: [parent] }, { tasks: [betaSolo] }];
    const result = hoistChildrenIntoParentGroups(groups, {
      items: (g) => g.tasks,
      task: (t) => t,
      withItems: (g, tasks) => ({ ...g, tasks }),
    });
    expect(result).toEqual(groups);
    expect(result[0]).toBe(groups[0]);
  });
});
