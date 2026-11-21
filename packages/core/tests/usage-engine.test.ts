// The usage engine (docs/costs.md), pure: summing a task's sessions
// (per-model merge, fork-prefix subtraction, `$` only when every spending
// session was priced) and shaping `listTaskUsage` rows (filters, ranking,
// subtask roll-up).

import { describe, expect, it } from "vitest";
import type { Task } from "../src/contracts/model.js";
import type {
  ModelUsage,
  SessionUsage,
  TaskUsage,
} from "../src/contracts/usage.js";
import {
  awaitsUsageBackfill,
  buildTaskUsageRows,
  lastActivityFromStats,
  placeholderUsage,
  summarizeTaskUsage,
  usageFingerprint,
} from "../src/engines/usage.js";

function model(
  name: string,
  tokens: number,
  turns: number,
  cost?: number,
): ModelUsage {
  return {
    model: name,
    input: tokens,
    output: tokens,
    cacheRead: tokens,
    cacheWrite: tokens,
    turns,
    ...(cost !== undefined ? { cost } : {}),
  };
}

const CTX = { harness: "pi", computedAt: "2026-11-16T00:00:00.000Z" };

describe("summarizeTaskUsage", () => {
  it("merges models across sessions and sums cost when every session priced", () => {
    const usage = summarizeTaskUsage(
      [
        {
          sessionPath: "/a",
          byModel: [model("opus", 10, 2, 1), model("haiku", 1, 1, 0.01)],
          costSource: "pi",
        },
        {
          sessionPath: "/b",
          byModel: [model("opus", 5, 1, 0.5)],
          costSource: "pi",
        },
      ],
      CTX,
    );
    expect(usage.status).toBe("ready");
    expect(usage.byModel).toEqual([
      model("opus", 15, 3, 1.5),
      model("haiku", 1, 1, 0.01),
    ]);
    expect(usage.totals).toEqual({
      input: 16,
      output: 16,
      cacheRead: 16,
      cacheWrite: 16,
      turns: 4,
    });
    expect(usage.cost).toBe(1.51);
    expect(usage.costSource).toBe("pi");
    expect(usage.sessions).toEqual([
      {
        sessionPath: "/a",
        harness: "pi",
        totals: { input: 11, output: 11, cacheRead: 11, cacheWrite: 11 },
        cost: 1.01,
      },
      {
        sessionPath: "/b",
        harness: "pi",
        totals: { input: 5, output: 5, cacheRead: 5, cacheWrite: 5 },
        cost: 0.5,
      },
    ]);
  });

  it("subtracts a forked session's copied prefix (no double count with its parent)", () => {
    const parent: SessionUsage = {
      sessionPath: "/parent",
      byModel: [model("opus", 10, 2, 1)],
      costSource: "pi",
    };
    const fork: SessionUsage = {
      sessionPath: "/fork",
      byModel: [model("opus", 13, 3, 1.3), model("fable", 2, 1, 0.2)],
      forkedFrom: {
        sessionPath: "/parent",
        turns: 2,
        prefix: [model("opus", 10, 2, 1)],
      },
      costSource: "pi",
    };
    const usage = summarizeTaskUsage([parent, fork], CTX);
    expect(usage.byModel).toEqual([
      model("opus", 13, 3, 1.3),
      model("fable", 2, 1, 0.2),
    ]);
    expect(usage.cost).toBe(1.5);
    expect(usage.sessions[1]?.totals).toEqual({
      input: 5,
      output: 5,
      cacheRead: 5,
      cacheWrite: 5,
    });
  });

  it("leaves cost out when any spending session was unpriced, and never counts a path twice", () => {
    const usage = summarizeTaskUsage(
      [
        {
          sessionPath: "/a",
          byModel: [model("opus", 10, 1, 1)],
          costSource: "pi",
        },
        { sessionPath: "/b", byModel: [model("opus", 10, 1)] },
        { sessionPath: "/a", byModel: [model("opus", 10, 1, 1)] },
      ],
      CTX,
    );
    expect(usage.totals.turns).toBe(2);
    expect(usage.cost).toBeUndefined();
    expect(usage.costSource).toBeUndefined();
    expect(usage.sessions.map((session) => session.cost)).toEqual([
      1,
      undefined,
    ]);
  });

  it("ignores an empty (no-spend) session for the cost rule", () => {
    const usage = summarizeTaskUsage(
      [
        {
          sessionPath: "/a",
          byModel: [model("opus", 10, 1, 1)],
          costSource: "pi",
        },
        { sessionPath: "/empty", byModel: [model("bootstrap", 0, 1, 0)] },
      ],
      CTX,
    );
    expect(usage.cost).toBe(1);
    expect(usage.byModel.map((usage) => usage.model)).toEqual(["opus"]);
  });

  it("fingerprints session files independent of order", () => {
    const a = { sessionPath: "/a", stat: { size: 1, mtimeMs: 2.5 } };
    const b = { sessionPath: "/b", stat: undefined };
    expect(usageFingerprint([a, b])).toBe(usageFingerprint([b, a]));
    expect(usageFingerprint([a])).not.toBe(
      usageFingerprint([{ ...a, stat: { size: 2, mtimeMs: 2.5 } }]),
    );
  });
});

function ready(tokens: number, cost?: number): TaskUsage {
  return summarizeTaskUsage(
    [
      {
        sessionPath: `/s/${tokens}`,
        byModel: [
          model(cost === undefined ? "haiku" : "opus", tokens, 1, cost),
        ],
        ...(cost === undefined ? {} : { costSource: "pi" }),
      },
    ],
    CTX,
  );
}

function task(id: string, patch: Partial<Task>): Task {
  return {
    id,
    kind: "task",
    state: "done",
    title: `Task ${id}`,
    initialPrompt: "",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    stateChangedAt: "2026-11-01T00:00:00.000Z",
    ...patch,
  };
}

describe("buildTaskUsageRows", () => {
  const tasks: Task[] = [
    task("small", {
      repositoryId: "github.com/acme/a",
      completedAt: "2026-11-02T10:00:00.000Z",
      usage: ready(1, 0.1),
    }),
    task("big", {
      repositoryId: "github.com/acme/b",
      harness: "claude-code",
      completedAt: "2026-11-05T10:00:00.000Z",
      usage: ready(100),
    }),
    task("parent", {
      state: "working",
      folderPath: "/Users/me/notes",
      // Computed today by a backfill, but its spend happened on the 4th:
      // the range filter goes by `lastActivityAt`, never `computedAt`.
      usage: {
        ...ready(10, 1),
        computedAt: "2026-11-16T00:00:00.000Z",
        lastActivityAt: "2026-11-04T00:00:00.000Z",
      },
    }),
    task("child-1", {
      parentTaskId: "parent",
      completedAt: "2026-11-03T00:00:00.000Z",
      usage: ready(5, 0.5),
    }),
    task("child-2", {
      parentTaskId: "parent",
      archivedAt: "2026-11-10T00:00:00.000Z",
      completedAt: "2026-10-01T00:00:00.000Z",
      usage: ready(7, 0.7),
    }),
    task("child-missing", {
      parentTaskId: "parent",
      updatedAt: "2026-11-12T00:00:00.000Z",
      usage: placeholderUsage("unavailable", CTX.computedAt, "missing-session"),
    }),
    task("never", {}),
  ];

  it("ranks by total tokens and skips archived tasks and tasks without usage by default", () => {
    const rows = buildTaskUsageRows(tasks);
    expect(rows.map((row) => row.taskId)).toEqual([
      "big",
      "parent",
      "child-1",
      "small",
      "child-missing",
    ]);
    expect(rows[0]).toMatchObject({
      repository: "github.com/acme/b",
      harness: "claude-code",
      state: "done",
      completedAt: "2026-11-05T10:00:00.000Z",
    });
    expect(rows[1]?.repository).toBe("/Users/me/notes");
    expect(rows[3]?.harness).toBe("pi");
  });

  it("rolls children up onto their parent, whatever the filters", () => {
    const parent = buildTaskUsageRows(tasks, { harness: "pi" }).find(
      (row) => row.taskId === "parent",
    );
    expect(parent?.subtaskUsage).toEqual({
      input: 12,
      output: 12,
      cacheRead: 12,
      cacheWrite: 12,
      count: 2,
      cost: 1.2,
    });
    const rows = buildTaskUsageRows(tasks);
    expect(rows.find((row) => row.taskId === "big")?.subtaskUsage).toBe(
      undefined,
    );
  });

  it("a task's subtask total includes every task below it at any depth, each counted once", () => {
    const deep = [
      task("root", { usage: ready(10, 1) }),
      task("kid", { parentTaskId: "root", usage: ready(5, 0.5) }),
      task("grandkid", { parentTaskId: "kid", usage: ready(3, 0.3) }),
      task("grandkid-2", { parentTaskId: "kid", usage: ready(2, 0.2) }),
      task("great", { parentTaskId: "grandkid", usage: ready(1, 0.1) }),
    ];
    const rows = buildTaskUsageRows(deep);
    const sub = (id: string) =>
      rows.find((row) => row.taskId === id)?.subtaskUsage;
    // root: kid + grandkid + grandkid-2 + great, none twice.
    expect(sub("root")).toMatchObject({ input: 11, count: 4, cost: 1.1 });
    expect(sub("kid")).toMatchObject({ input: 6, count: 3, cost: 0.6 });
    expect(sub("grandkid")).toMatchObject({ input: 1, count: 1, cost: 0.1 });
    expect(sub("grandkid-2")).toBeUndefined();
    expect(sub("great")).toBeUndefined();
  });

  it("filters by repository, harness, model, range and archive", () => {
    const ids = (query: Parameters<typeof buildTaskUsageRows>[1]) =>
      buildTaskUsageRows(tasks, query)
        .map((row) => row.taskId)
        .sort();
    expect(ids({ repository: "github.com/acme/a" })).toEqual(["small"]);
    expect(ids({ harness: "claude-code" })).toEqual(["big"]);
    expect(ids({ model: "haiku" })).toEqual(["big"]);
    expect(ids({ from: "2026-11-03", to: "2026-11-04" })).toEqual([
      "child-1",
      "parent",
    ]);
    expect(ids({ to: "2026-11-02T12:00:00.000Z" })).toEqual(["small"]);
    expect(ids({ includeArchived: true, to: "2026-10-31" })).toEqual([
      "child-2",
    ]);
  });

  it("lists tasks the backfill still owes as pending zero rows, last", () => {
    const rows = buildTaskUsageRows(tasks, {}, new Set(["never", "big"]));
    expect(rows.map((row) => row.taskId)).toEqual([
      "big",
      "parent",
      "child-1",
      "small",
      "child-missing",
      "never",
    ]);
    expect(rows.at(-1)?.usage).toMatchObject({
      status: "pending",
      totals: { input: 0, turns: 0 },
      byModel: [],
    });
    // Its activity time is the task's own (updatedAt): in range.
    expect(
      buildTaskUsageRows(tasks, { from: "2026-11-01" }, new Set(["never"])).map(
        (row) => row.taskId,
      ),
    ).toContain("never");
    // A model filter can't match a task not counted yet.
    expect(
      buildTaskUsageRows(tasks, { model: "opus" }, new Set(["never"])).map(
        (row) => row.taskId,
      ),
    ).not.toContain("never");
  });
});

describe("usage backfill rules", () => {
  it("owes a first figure to Done tasks and tasks bound to a session", () => {
    const binding = (patch: Record<string, string>) => ({
      id: "b",
      taskId: "t",
      detached: false,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      ...patch,
    });
    expect(awaitsUsageBackfill(task("t", {}), undefined)).toBe(true);
    expect(
      awaitsUsageBackfill(task("t", { state: "backlog" }), undefined),
    ).toBe(false);
    expect(
      awaitsUsageBackfill(
        task("t", { state: "working" }),
        binding({ sessionId: "s" }),
      ),
    ).toBe(true);
    expect(
      awaitsUsageBackfill(
        task("t", { state: "working" }),
        binding({ worktreePath: "/w" }),
      ),
    ).toBe(false);
    expect(
      awaitsUsageBackfill(
        task("t", { usage: placeholderUsage("unavailable", CTX.computedAt) }),
        undefined,
      ),
    ).toBe(false);
  });

  it("takes the newest session mtime as the last activity", () => {
    expect(
      lastActivityFromStats([
        { stat: { mtimeMs: Date.parse("2026-11-02T00:00:00.000Z") } },
        { stat: undefined },
        { stat: { mtimeMs: Date.parse("2026-11-05T00:00:00.000Z") } },
      ]),
    ).toBe("2026-11-05T00:00:00.000Z");
    expect(lastActivityFromStats([{ stat: undefined }])).toBeUndefined();
  });
});
