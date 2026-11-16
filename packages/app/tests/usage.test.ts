// Unit tests for the renderer's usage display rules (src/renderer/src/lib/
// usage.ts, docs/costs.md): the board's pinned top-3, the Costs view's
// range bounds and grouping, and the CSV export.
import { describe, expect, it } from "vitest";
import type { Task, TaskUsage, TaskUsageRow } from "../src/preload/api";
import {
  csvField,
  groupUsageRows,
  subtaskRollup,
  topUsageTaskIds,
  usageCsvFileName,
  usageRangeBounds,
  usageRowsToCsv,
  usageSummary,
  usageTotals,
} from "../src/renderer/src/lib/usage";

function ready(tokens: number, extra: Partial<TaskUsage> = {}): TaskUsage {
  return {
    status: "ready",
    totals: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1 },
    byModel: [
      {
        model: "m",
        input: tokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        turns: 1,
      },
    ],
    sessions: [],
    computedAt: "2026-11-16T00:00:00.000Z",
    ...extra,
  };
}

function task(id: string, usage?: TaskUsage, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    state: "working",
    ...(usage ? { usage } : {}),
    ...extra,
  } as Task;
}

describe("topUsageTaskIds", () => {
  it("picks the three highest-token visible tasks with ready usage", () => {
    const tasks = [
      task("a", ready(10)),
      task("b", ready(500)),
      task("c", ready(300)),
      task("d", ready(400)),
      task("e", ready(9_000)), // not visible
      task("f", { ...ready(0), status: "unavailable" }),
      task("g", ready(0)),
      task("h"),
    ];
    const ids = topUsageTaskIds(
      tasks,
      tasks.filter((t) => t.id !== "e").map((t) => t.id),
    );
    expect([...ids].sort()).toEqual(["b", "c", "d"]);
  });

  it("returns fewer when fewer tasks have usage, and keeps board order on ties", () => {
    const tasks = [task("x", ready(5)), task("y", ready(5)), task("z")];
    expect([...topUsageTaskIds(tasks, ["x", "y", "z"], 1)]).toEqual(["x"]);
    expect(topUsageTaskIds(tasks, ["z"]).size).toBe(0);
  });
});

describe("usageRangeBounds", () => {
  // Wednesday 2026-11-18 15:30 local time.
  const now = new Date(2026, 10, 18, 15, 30);

  it("this week starts Monday 00:00 local", () => {
    expect(usageRangeBounds("week", now)).toEqual({
      from: new Date(2026, 10, 16).toISOString(),
    });
  });

  it("a Sunday belongs to the week that started six days before", () => {
    expect(usageRangeBounds("week", new Date(2026, 10, 22, 9))).toEqual({
      from: new Date(2026, 10, 16).toISOString(),
    });
  });

  it("this month starts on the 1st; all is unbounded", () => {
    expect(usageRangeBounds("month", now)).toEqual({
      from: new Date(2026, 10, 1).toISOString(),
    });
    expect(usageRangeBounds("all", now)).toEqual({});
  });
});

function row(extra: Partial<TaskUsageRow> & { taskId: string }): TaskUsageRow {
  return {
    title: extra.taskId,
    repository: "github.com/acme/widgets",
    harness: "pi",
    state: "done",
    usage: ready(100),
    ...extra,
  };
}

describe("usageRowsToCsv", () => {
  it("writes the header, raw numbers and RFC 4180 quoting with CRLF", () => {
    const csv = usageRowsToCsv([
      row({
        taskId: "t1",
        title: 'Fix "quotes", commas\nand lines',
        completedAt: "2026-11-16T10:00:00.000Z",
        usage: {
          status: "ready",
          totals: {
            input: 1200,
            output: 34,
            cacheRead: 5_000_000,
            cacheWrite: 7,
            turns: 3,
          },
          byModel: [
            {
              model: "claude-opus",
              input: 1200,
              output: 34,
              cacheRead: 5_000_000,
              cacheWrite: 7,
              turns: 2,
              cost: 1.5,
            },
            {
              model: "gpt-5",
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              turns: 1,
            },
          ],
          sessions: [],
          cost: 1.5,
          costSource: "pi",
          computedAt: "2026-11-16T10:00:00.000Z",
        },
        subtaskUsage: {
          input: 10,
          output: 20,
          cacheRead: 30,
          cacheWrite: 40,
          count: 2,
        },
      }),
      row({
        taskId: "t2",
        harness: "my-cli",
        repository: "",
        state: "working",
        usage: {
          status: "unavailable",
          reason: "unsupported",
          totals: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            turns: 0,
          },
          byModel: [],
          sessions: [],
          computedAt: "2026-11-16T10:00:00.000Z",
        },
      }),
    ]);
    expect(csv.split("\r\n")).toEqual([
      "taskId,title,repository,harness,state,completedAt,models,input,output,cacheRead,cacheWrite,totalTokens,turns,cost,costSource,subtaskCount,subtaskTokens",
      't1,"Fix ""quotes"", commas\nand lines",github.com/acme/widgets,pi,done,2026-11-16T10:00:00.000Z,claude-opus;gpt-5,1200,34,5000000,7,5001241,3,1.5,pi,2,100',
      "t2,t2,,my-cli,working,,,,,,,,,,,,",
      "",
    ]);
  });

  it("quotes only when needed", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("cr\rhere")).toBe('"cr\rhere"');
    expect(csvField(undefined)).toBe("");
    expect(csvField(0)).toBe("0");
  });

  it("names the file after the local date", () => {
    expect(usageCsvFileName(new Date(2026, 0, 5, 23, 59))).toBe(
      "costs-2026-01-05.csv",
    );
  });
});

describe("usage summaries and aggregation", () => {
  it("summarizes ready, pending and unavailable usage", () => {
    expect(usageSummary(ready(9_800_000))).toBe("9.8M tok");
    expect(usageSummary(ready(92_000, { cost: 23.1 }))).toBe(
      "92k tok · ~$23.10",
    );
    expect(usageSummary({ ...ready(0), status: "pending" })).toBe("…");
    expect(usageSummary({ ...ready(0), status: "unavailable" })).toBe(
      "usage n/a",
    );
  });

  it("totals own usage only and omits $ when no row has a cost", () => {
    const rows = [
      row({ taskId: "a", usage: ready(100) }),
      row({
        taskId: "b",
        usage: ready(50),
        subtaskUsage: {
          input: 999,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          count: 1,
        },
      }),
    ];
    expect(usageTotals(rows)).toEqual({ tasks: 2, tokens: 150 });
    expect(
      usageTotals([
        ...rows,
        row({ taskId: "c", usage: ready(1, { cost: 2 }) }),
      ]),
    ).toEqual({ tasks: 3, tokens: 151, cost: 2 });
  });

  it("groups by harness and by model", () => {
    const rows = [
      row({ taskId: "a", usage: ready(100, { cost: 1 }) }),
      row({ taskId: "b", harness: "claude", usage: ready(300) }),
      row({ taskId: "c", usage: ready(50, { cost: 0.5 }) }),
    ];
    expect(groupUsageRows(rows, "harness")).toEqual([
      { key: "claude", tasks: 1, tokens: 300, turns: 1 },
      { key: "pi", tasks: 2, tokens: 150, turns: 2, cost: 1.5 },
    ]);
    expect(groupUsageRows(rows, "model")).toEqual([
      { key: "m", tasks: 3, tokens: 450, turns: 3 },
    ]);
  });

  it("rolls up direct children with ready usage", () => {
    const tasks = [
      task("p", ready(1)),
      task("c1", ready(10, { cost: 1 }), { parentTaskId: "p" }),
      task("c2", ready(20, { cost: 2 }), { parentTaskId: "p" }),
      task("c3", undefined, { parentTaskId: "p" }),
    ];
    expect(subtaskRollup(tasks, "p")).toEqual({
      input: 30,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      count: 2,
      cost: 3,
    });
    expect(subtaskRollup(tasks, "c1")).toBeUndefined();
  });
});
