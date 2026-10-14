import { describe, expect, it } from "vitest";
import type { BoardColumn, Task } from "../src/preload/api";
import {
  activityTimestamp,
  clampSidebarWidth,
  groupRows,
  matchesQuery,
  partitionPinned,
  pullRequestUrl,
  relativeTime,
  repoLabel,
  SIDEBAR_DEFAULT_WIDTH,
  type SidebarRow,
  sidebarRows,
  stateChipLabel,
  visibleTaskOrder,
} from "../src/renderer/src/components/sidebar-model";

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

function row(
  t: Task,
  presence?: SidebarRow["presence"],
  state: SidebarRow["state"] = t.state,
): SidebarRow {
  return { task: t, state, presence };
}

describe("repoLabel", () => {
  it("uses the last repository-id segment, or scratch", () => {
    expect(repoLabel({ repositoryId: "github.com/org/harbor" })).toBe("harbor");
    expect(repoLabel({})).toBe("scratch");
    expect(repoLabel({ repositoryId: "  " })).toBe("scratch");
  });
});

describe("sidebarRows", () => {
  it("flattens columns in order, keeps open archived tasks, attaches presence", () => {
    const columns: BoardColumn[] = [
      {
        state: "backlog",
        title: "Backlog",
        groups: [{ id: "g1", tasks: [task({ id: "a", state: "backlog" })] }],
      },
      {
        state: "done",
        title: "Done",
        groups: [
          {
            id: "g2",
            tasks: [
              task({ id: "b", state: "done" }),
              task({ id: "c", state: "done", archivedAt: T0 }),
            ],
          },
        ],
      },
    ];
    const rows = sidebarRows(
      columns,
      { a: { live: true, runningTurn: false } },
      new Set(["a", "b", "c"]),
    );
    // "c" is archived but OPEN: an open workspace always gets a row (cmux
    // rule), otherwise it becomes an orphan pane with no rail affordance.
    expect(rows.map((r) => [r.task.id, r.state])).toEqual([
      ["a", "backlog"],
      ["b", "done"],
      ["c", "done"],
    ]);
    expect(rows[0]?.presence?.live).toBe(true);
    expect(rows[1]?.presence).toBeUndefined();
  });

  it("excludes tasks that are not in the opened set, even if unarchived", () => {
    const columns: BoardColumn[] = [
      {
        state: "backlog",
        title: "Backlog",
        groups: [
          {
            id: "g1",
            tasks: [
              task({ id: "a", state: "backlog" }),
              task({ id: "b", state: "backlog" }),
            ],
          },
        ],
      },
    ];
    const rows = sidebarRows(columns, {}, new Set(["a"]));
    expect(rows.map((r) => r.task.id)).toEqual(["a"]);
  });
});

describe("groupRows", () => {
  it("groups by repo alphabetically with scratch last, running first then live", () => {
    const rows = [
      row(task({ id: "s1" })),
      row(task({ id: "z1", repositoryId: "github.com/o/zeta" })),
      row(task({ id: "a1", repositoryId: "github.com/o/alpha" })),
      row(task({ id: "a2", repositoryId: "github.com/o/alpha" }), {
        live: true,
        runningTurn: false,
      }),
      row(task({ id: "a3", repositoryId: "github.com/o/alpha" }), {
        live: true,
        runningTurn: true,
      }),
      row(task({ id: "a4", repositoryId: "github.com/o/alpha" })),
    ];
    const groups = groupRows(rows);
    expect(groups.map((g) => g.label)).toEqual(["alpha", "zeta", "scratch"]);
    expect(groups[0]?.rows.map((r) => r.task.id)).toEqual([
      "a3",
      "a2",
      "a1",
      "a4",
    ]);
  });
});

describe("matchesQuery", () => {
  const r = row(
    task({
      id: "x",
      title: "Fix Login Bug",
      branch: "feat/auth-flow",
      repositoryId: "github.com/acme/webapp",
    }),
  );
  it.each([
    ["", true],
    ["  ", true],
    ["login", true],
    ["AUTH-FLOW", true],
    ["webapp", true],
    ["acme", true],
    ["nope", false],
  ])("%j -> %s", (query, expected) => {
    expect(matchesQuery(r, query)).toBe(expected);
  });
});

describe("stateChipLabel", () => {
  it("names the column, or the awaiting reason/stage", () => {
    const t = task({ id: "x" });
    expect(stateChipLabel(t, "backlog")).toBe("Backlog");
    expect(stateChipLabel(t, "dev")).toBe("Dev");
    expect(stateChipLabel(t, "done")).toBe("Done");
    expect(stateChipLabel(t, "awaiting")).toBe("Awaiting");
    expect(
      stateChipLabel({ ...t, awaiting: { kind: "review" } }, "awaiting"),
    ).toBe("Review");
    expect(
      stateChipLabel({ ...t, awaiting: { kind: "slack" } }, "awaiting"),
    ).toBe("Slack");
    expect(
      stateChipLabel(
        {
          ...t,
          awaiting: {
            kind: "deploy",
            stageId: "pp",
            stageLabel: "Preprod deploy",
          },
        },
        "awaiting",
      ),
    ).toBe("Preprod deploy");
  });
});

describe("pullRequestUrl", () => {
  it("prefers the gh-reported url, else derives one for github.com repos", () => {
    expect(pullRequestUrl(task({ id: "x" }))).toBeUndefined();
    expect(
      pullRequestUrl(
        task({
          id: "x",
          pr: {
            number: 3,
            state: "open",
            url: "https://github.com/a/b/pull/3",
          },
        }),
      ),
    ).toBe("https://github.com/a/b/pull/3");
    expect(
      pullRequestUrl(
        task({
          id: "x",
          repositoryId: "github.com/a/b",
          pr: { number: 9, state: "draft" },
        }),
      ),
    ).toBe("https://github.com/a/b/pull/9");
    expect(
      pullRequestUrl(
        task({
          id: "x",
          repositoryId: "gitlab.com/a/b",
          pr: { number: 9, state: "draft" },
        }),
      ),
    ).toBeUndefined();
  });
});

describe("relativeTime / activityTimestamp", () => {
  const now = Date.parse("2025-01-10T12:00:00.000Z");
  it.each([
    ["2025-01-10T11:59:30.000Z", "now"],
    ["2025-01-10T12:00:30.000Z", "now"],
    ["2025-01-10T11:57:00.000Z", "3m"],
    ["2025-01-10T10:00:00.000Z", "2h"],
    ["2025-01-07T12:00:00.000Z", "3d"],
    ["2024-12-27T12:00:00.000Z", "2w"],
    ["2024-10-10T12:00:00.000Z", "3mo"],
    ["2022-01-10T12:00:00.000Z", "3y"],
    ["garbage", ""],
  ])("%s -> %j", (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });

  it("uses the heartbeat only while live", () => {
    const t = task({ id: "x", updatedAt: "2025-01-01T00:00:00.000Z" });
    const hb = "2025-01-10T11:59:58.000Z";
    expect(
      activityTimestamp(
        row(t, { live: true, runningTurn: false, heartbeatAt: hb }),
      ),
    ).toBe(hb);
    expect(
      activityTimestamp(
        row(t, { live: false, runningTurn: false, heartbeatAt: hb }),
      ),
    ).toBe(t.updatedAt);
    expect(activityTimestamp(row(t))).toBe(t.updatedAt);
  });
});

describe("clampSidebarWidth", () => {
  it("clamps into [220, 480] and falls back on garbage", () => {
    expect(clampSidebarWidth(100)).toBe(220);
    expect(clampSidebarWidth(900)).toBe(480);
    expect(clampSidebarWidth(300.4)).toBe(300);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe("partitionPinned", () => {
  const a = row(task({ id: "a", repositoryId: "github.com/org/repo" }));
  const b = row(task({ id: "b", repositoryId: "github.com/org/repo" }));
  const c = row(task({ id: "c" }));
  const groups = groupRows([a, b, c]);

  it("returns every group unchanged when nothing is pinned", () => {
    const { pinned, rest } = partitionPinned(groups, new Set());
    expect(pinned).toEqual([]);
    expect(rest).toBe(groups);
  });

  it("lifts pinned rows out of their group into the pinned section", () => {
    const pinnedIds = new Set(["b"]);
    const { pinned, rest } = partitionPinned(groups, pinnedIds);
    expect(pinned.map((r) => r.task.id)).toEqual(["b"]);
    const remainingIds = rest.flatMap((group) =>
      group.rows.map((r) => r.task.id),
    );
    expect(remainingIds).toEqual(["a", "c"]);
  });

  it("drops a group entirely once every one of its rows is pinned", () => {
    const { rest } = partitionPinned(groups, new Set(["c"]));
    expect(rest.some((group) => group.label === "scratch")).toBe(false);
  });
});

describe("visibleTaskOrder", () => {
  it("lists pinned rows first, then each group in order", () => {
    const a = row(task({ id: "a", repositoryId: "github.com/org/repo" }));
    const b = row(task({ id: "b", repositoryId: "github.com/org/repo" }));
    const c = row(task({ id: "c" }));
    const groups = groupRows([a, b, c]);
    const { pinned, rest } = partitionPinned(groups, new Set(["c"]));
    expect(visibleTaskOrder(pinned, rest)).toEqual(["c", "a", "b"]);
  });

  it("returns an empty list for no rows", () => {
    expect(visibleTaskOrder([], [])).toEqual([]);
  });
});
