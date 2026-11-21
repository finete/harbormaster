import { describe, expect, it } from "vitest";
import type { BoardColumn, Task } from "../src/preload/api";
import {
  buildSelectionGrid,
  visibleGroupsForColumn,
} from "../src/renderer/src/lib/board-selection";
import {
  buildLineageIndex,
  deeperTreesNote,
  descendantsOfTask,
  hiddenNestedChildIds,
  hoistChildrenIntoParentGroups,
  layoutLineageRows,
  parentCandidates,
  subtreeHeightOf,
  taskDepth,
  treesDeeperThan,
} from "../src/renderer/src/lib/task-lineage";

const T0 = "2025-01-01T00:00:00.000Z";

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    kind: "task",
    state: "working",
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
    const child = task({
      id: "child",
      parentTaskId: "parent",
      state: "working",
    });
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
    const child = task({
      id: "child",
      parentTaskId: "parent",
      state: "working",
    });
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
      state: "working",
      title: "Working",
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
    // Parent sits in Done; only the child is in this (Working) column.
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

describe("parentCandidates", () => {
  const parent = task({ id: "p" });
  const child = task({ id: "c", parentTaskId: "p" });
  const loose = task({ id: "l" });
  const other = task({ id: "o" });
  const archived = task({ id: "a", archivedAt: T0 });
  const pool = [parent, child, loose, other, archived];
  const index = buildLineageIndex(pool);
  const ids = (tasks: Task[]) => tasks.map((t) => t.id);

  it("offers every non-archived task that is not itself, in depth range", () => {
    // Default max 3: a child (depth 2) is a fine parent for a leaf.
    expect(ids(parentCandidates(loose, pool, index))).toEqual(["p", "c", "o"]);
  });

  it("skips a child's current parent", () => {
    expect(ids(parentCandidates(child, pool, index))).toEqual(["l", "o"]);
  });

  it("moves a task with its subtree: its own descendants are never offered and the subtree must fit", () => {
    // p (height 2): not under c (its own child); under l/o: 1 + 2 = 3 fits.
    expect(ids(parentCandidates(parent, pool, index))).toEqual(["l", "o"]);
    // With max depth 2, a height-2 subtree only fits under nothing deeper than depth 0.
    expect(ids(parentCandidates(parent, pool, index, 2))).toEqual([]);
    // A leaf under a depth-2 task needs max 3; max 2 offers only top-level tasks.
    expect(ids(parentCandidates(loose, pool, index, 2))).toEqual(["p", "o"]);
    // Max 1 means no nesting at all.
    expect(ids(parentCandidates(loose, pool, index, 1))).toEqual([]);
  });
});

describe("task trees (several levels)", () => {
  // root ─ kid ─ grand ─ great
  const root = task({ id: "root", createdAt: "2025-01-01T00:00:00.000Z" });
  const kid = task({ id: "kid", parentTaskId: "root" });
  const grand = task({ id: "grand", parentTaskId: "kid" });
  const great = task({ id: "great", parentTaskId: "grand" });
  const all = [root, kid, grand, great];
  const index = buildLineageIndex(all);
  const rowsOf = (items: Task[], collapsed: string[] = [], opts = {}) =>
    layoutLineageRows(
      items.map((t) => ({ task: t })),
      index,
      new Set(collapsed),
      opts,
    );

  it("measures depth, subtree height and counts too-deep trees once", () => {
    expect(taskDepth(root, index)).toBe(1);
    expect(taskDepth(great, index)).toBe(4);
    expect(subtreeHeightOf("root", index)).toBe(4);
    expect(subtreeHeightOf("great", index)).toBe(1);
    expect(descendantsOfTask("root", index).map((t) => t.id)).toEqual([
      "kid",
      "grand",
      "great",
    ]);
    expect(treesDeeperThan(all, 4)).toBe(0);
    expect(treesDeeperThan(all, 3)).toBe(1);
    expect(
      treesDeeperThan(
        [...all, task({ id: "x" }), task({ id: "y", parentTaskId: "x" })],
        1,
      ),
    ).toBe(2);
  });

  it("words the Settings note for deeper trees", () => {
    expect(deeperTreesNote(0)).toBeUndefined();
    expect(deeperTreesNote(1)).toBe(
      "1 task tree is deeper than this; it's left as it is",
    );
    expect(deeperTreesNote(3)).toBe(
      "3 task trees are deeper than this; they're left as they are",
    );
  });

  it("draws one indent per level, depth first", () => {
    const rows = rowsOf(all);
    expect(rows.map((r) => [r.item.task.id, r.indent])).toEqual([
      ["root", 0],
      ["kid", 1],
      ["grand", 2],
      ["great", 3],
    ]);
    expect(rows.map((r) => r.nested)).toEqual([false, true, true, true]);
    expect(rows[1]?.children).toEqual({
      count: 1,
      collapsed: false,
      nestedHere: true,
    });
    expect(rows[3]?.children).toBeUndefined();
  });

  it("keeps siblings under their own parent and the parent's subtree together", () => {
    const sib = task({ id: "sib", parentTaskId: "root" });
    const idx = buildLineageIndex([...all, sib]);
    const rows = layoutLineageRows(
      [root, sib, kid, grand, great].map((t) => ({ task: t })),
      idx,
      new Set(),
    );
    // Siblings oldest first; kid's whole subtree stays before the next sibling.
    expect(rows.map((r) => r.item.task.id)).toEqual([
      "root",
      "kid",
      "grand",
      "great",
      "sib",
    ]);
  });

  it("each parent collapses on its own: a collapsed parent hides everything below it only", () => {
    expect(rowsOf(all, ["kid"]).map((r) => r.item.task.id)).toEqual([
      "root",
      "kid",
    ]);
    const mid = rowsOf(all, ["grand"]);
    expect(mid.map((r) => r.item.task.id)).toEqual(["root", "kid", "grand"]);
    expect(mid[2]?.children?.collapsed).toBe(true);
    expect(
      hiddenNestedChildIds(
        all.map((t) => ({ task: t })),
        new Set(["kid"]),
      ),
    ).toEqual(new Set(["grand", "great"]));
  });

  it("applies the parent-elsewhere rule per link: a grandchild whose parent is in another column keeps its place with a parent line", () => {
    const rows = rowsOf([root, grand, great]);
    // `kid` is elsewhere: grand is a top-level row with "↳ kid", great nests under it.
    expect(rows.map((r) => [r.item.task.id, r.indent, r.parentTitle])).toEqual([
      ["root", 0, undefined],
      ["grand", 0, "kid"],
      ["great", 1, undefined],
    ]);
  });

  it("a detached middle task stays top-level with its parent line and still hosts its own children", () => {
    const rows = rowsOf(all, [], { detachedIds: new Set(["kid"]) });
    expect(rows.map((r) => [r.item.task.id, r.indent, r.parentTitle])).toEqual([
      ["root", 0, undefined],
      ["kid", 0, "root"],
      ["grand", 1, undefined],
      ["great", 2, undefined],
    ]);
  });

  it("caps the indent at three levels even for a deeper (corrupt) chain", () => {
    const deep = task({ id: "deep", parentTaskId: "great" });
    const idx = buildLineageIndex([...all, deep]);
    const rows = layoutLineageRows(
      [...all, deep].map((t) => ({ task: t })),
      idx,
      new Set(),
    );
    expect(rows.map((r) => r.indent)).toEqual([0, 1, 2, 3, 3]);
  });

  it("never loses rows to a parent loop", () => {
    const a = task({ id: "a", parentTaskId: "b" });
    const b = task({ id: "b", parentTaskId: "a" });
    const idx = buildLineageIndex([a, b]);
    const rows = layoutLineageRows(
      [a, b].map((t) => ({ task: t })),
      idx,
      new Set(),
    );
    expect(rows.map((r) => r.item.task.id).sort()).toEqual(["a", "b"]);
  });

  it("hoists a whole chain into the root's group, each task following its parent", () => {
    const groups = [
      { name: "alpha", tasks: [root] },
      { name: "beta", tasks: [kid] },
      { name: "gamma", tasks: [grand, great] },
    ];
    const result = hoistChildrenIntoParentGroups(groups, {
      items: (g) => g.tasks,
      task: (t) => t,
      withItems: (g, tasks) => ({ ...g, tasks }),
    });
    expect(result.map((g) => [g.name, g.tasks.map((t) => t.id)])).toEqual([
      ["alpha", ["root", "kid", "grand", "great"]],
    ]);
  });

  it("a chain broken by another scope stays apart: only same-scope links hoist", () => {
    // kid is in another scope (e.g. another Awaiting kind): grand/great follow kid, not root.
    const groups = [
      { name: "alpha", scope: "working", tasks: [root] },
      { name: "beta", scope: "review", tasks: [kid] },
      { name: "gamma", scope: "review", tasks: [grand, great] },
    ];
    const result = hoistChildrenIntoParentGroups(groups, {
      items: (g) => g.tasks,
      task: (t) => t,
      withItems: (g, tasks) => ({ ...g, tasks }),
      scope: (g) => g.scope,
    });
    expect(result.map((g) => [g.name, g.tasks.map((t) => t.id)])).toEqual([
      ["alpha", ["root"]],
      ["beta", ["kid", "grand", "great"]],
    ]);
  });
});
