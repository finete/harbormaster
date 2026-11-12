import { describe, expect, it } from "vitest";
import type {
  InboxItem,
  PresenceBadge,
  Task,
  TaskMessage,
  TaskState,
} from "../src/preload/api";
import {
  assembleInbox,
  emptyLocalState,
  groupEntries,
  type InboxSources,
  moveSelection,
  navigationOrder,
  parseLocalState,
  priorityCount,
  pruneLocalState,
  selectionAfterRemoval,
  snoozePresets,
  UNBOUND_GROUP,
  visibleEntries,
} from "../src/renderer/src/lib/inbox-items";

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    kind: "task",
    state: "dev",
    title: `Task ${id}`,
    initialPrompt: "",
    createdAt: "2026-11-11T08:00:00.000Z",
    updatedAt: "2026-11-11T08:00:00.000Z",
    stateChangedAt: "2026-11-11T08:00:00.000Z",
    ...patch,
  };
}

const live = (patch: Partial<PresenceBadge>): PresenceBadge => ({
  live: true,
  runningTurn: false,
  corroboration: "record",
  ...patch,
});

function sources(patch: Partial<InboxSources> = {}): InboxSources {
  return {
    tasks: [],
    presence: {},
    approvals: [],
    items: [],
    readyToLand: [],
    ...patch,
  };
}

const rows = (...tasks: Task[]): Array<{ task: Task; state: TaskState }> =>
  tasks.map((t) => ({ task: t, state: t.state }));

const approval: TaskMessage = {
  id: "m1",
  sender: { kind: "task", taskId: "s" },
  senderLabel: "Sender",
  targetTaskId: "t3",
  route: "approval",
  text: "please rebase",
  requestedMode: "steer",
  attachments: [],
  status: "awaiting_approval",
  createdAt: "2026-11-11T09:05:00.000Z",
};

const reviewRequest: InboxItem = {
  id: "i1",
  kind: "rule",
  source: "github",
  title: "Review requested: Fix it",
  buttons: [
    {
      id: "b0",
      label: "Create review task",
      action: "createTask",
      with: { pr: "https://github.com/a/b/pull/7", role: "reviewer" },
    },
    { id: "b1", label: "Dismiss", action: "dismiss" },
  ],
  createdAt: "2026-11-11T09:01:00.000Z",
};

describe("assembleInbox", () => {
  const everything = sources({
    tasks: rows(
      task("t1"),
      task("t2"),
      task("t3"),
      task("t4"),
      task("t5", {
        lastError: "Launch failed: the pi command could not be found on PATH.",
        updatedAt: "2026-11-11T09:06:00.000Z",
      }),
      task("t6", { state: "awaiting" }),
      task("t7"),
      task("t8", { state: "done" }),
    ),
    presence: {
      t1: live({
        status: {
          state: "blocked",
          message: "Which DB?",
          at: "2026-11-11T09:00:00.000Z",
        },
      }),
      t2: live({
        outcome: {
          status: "done",
          note: "Shipped the fix",
          at: "2026-11-11T09:02:00.000Z",
        },
        status: { state: "idle", at: "2026-11-11T09:02:00.000Z" },
      }),
      t3: live({ status: { state: "idle", at: "2026-11-11T09:03:00.000Z" } }),
      t4: live({ status: { state: "done", at: "2026-11-11T09:04:00.000Z" } }),
      t7: live({ runningTurn: true, status: { state: "working" } }),
      t8: live({
        status: { state: "blocked", at: "2026-11-11T09:00:00.000Z" },
      }),
    },
    approvals: [approval],
    items: [
      reviewRequest,
      {
        ...reviewRequest,
        id: "i2",
        source: "github",
        title: "FYI",
        priority: false,
        buttons: [],
        taskId: "t3",
        createdAt: "2026-11-11T08:30:00.000Z",
      },
    ],
    readyToLand: [
      {
        taskId: "t6",
        ruleId: "deploy-land",
        detail: "dirty worktree",
        at: "2026-11-11T09:07:00.000Z",
      },
    ],
  });

  it("maps every signal to its kind and default tab (newest first)", () => {
    const entries = assembleInbox(everything);
    expect(
      entries.map((e) => [e.id, e.kind, e.priority, e.dismissable]),
    ).toEqual([
      [
        "ready-to-land:t6:2026-11-11T09:07:00.000Z",
        "ready-to-land",
        true,
        true,
      ],
      [
        "launch-failed:t5:2026-11-11T09:06:00.000Z",
        "launch-failed",
        true,
        true,
      ],
      ["approval:m1", "approval", true, false],
      ["done:t4:2026-11-11T09:04:00.000Z", "done", false, true],
      ["idle:t3:2026-11-11T09:03:00.000Z", "idle", false, true],
      ["reported:t2:2026-11-11T09:02:00.000Z", "reported", true, true],
      ["i1", "rule", true, true],
      ["asked:t1:2026-11-11T09:00:00.000Z", "asked", true, false],
      ["i2", "rule", false, true],
    ]);
    const asked = entries.find((e) => e.kind === "asked");
    expect(asked?.title).toBe("Which DB?");
    expect(asked?.actions.map((a) => a.label)).toEqual(["Open"]);
    expect(
      entries.find((e) => e.kind === "reported")?.actions.map((a) => a.label),
    ).toEqual(["Open", "To Done", "Dismiss"]);
    expect(
      entries.find((e) => e.kind === "approval")?.actions.map((a) => a.label),
    ).toEqual(["Approve", "Edit", "Reject"]);
    expect(
      entries.find((e) => e.id === "i1")?.actions.map((a) => [a.id, a.key]),
    ).toEqual([
      ["button:b0", "C"],
      ["button:b1", "D"],
    ]);
    // A rule item without its own Dismiss button still gets one.
    expect(
      entries.find((e) => e.id === "i2")?.actions.map((a) => a.id),
    ).toEqual(["dismiss"]);
    expect(
      entries
        .find((e) => e.kind === "ready-to-land")
        ?.actions.map((a) => a.label),
    ).toEqual(["Mark Done", "Dismiss"]);
    expect(
      entries
        .find((e) => e.kind === "launch-failed")
        ?.actions.map((a) => a.label),
    ).toEqual(["Open", "Retry", "Dismiss"]);
  });

  it("leaves out working agents, Done tasks and tasks waiting on their parent", () => {
    const entries = assembleInbox({
      ...everything,
      waitingOnParent: new Set(["t1"]),
    });
    expect(entries.some((e) => e.taskId === "t7")).toBe(false);
    expect(entries.some((e) => e.taskId === "t8")).toBe(false);
    expect(entries.some((e) => e.taskId === "t1")).toBe(false);
  });

  it("an interrupted launch is a launch-failed item; an error status is an idle item that says so", () => {
    const entries = assembleInbox(
      sources({
        tasks: rows(
          task("a", {
            launch: {
              status: "interrupted",
              requestedAt: "x",
              interruptedAt: "2026-11-11T10:00:00.000Z",
            },
          }),
          task("b"),
        ),
        presence: {
          b: live({
            status: {
              state: "error",
              message: "rate limited",
              at: "2026-11-11T10:01:00.000Z",
            },
          }),
        },
      }),
    );
    expect(entries.map((e) => [e.kind, e.title])).toEqual([
      ["idle", "Stopped with an error: rate limited"],
      ["launch-failed", "Launch interrupted"],
    ]);
  });
});

describe("cleanup-failed items", () => {
  const failing = (attempts: number, patch: Partial<Task> = {}): Task =>
    task("d1", {
      state: "done",
      title: "Ship it",
      cleanup: {
        mode: "forced",
        requestedAt: "2026-11-11T10:00:00.000Z",
        attempts,
        lastError: "Device or resource busy",
        worktreePath: "/code/.harbormaster-worktrees/ship-it",
      },
      ...patch,
    });

  it("shows ONE Other-tab item per Done task once its forced cleanup failed 3 times: Retry, Open folder, Dismiss", () => {
    expect(assembleInbox(sources({ tasks: rows(failing(2)) }))).toEqual([]);
    const entries = assembleInbox(sources({ tasks: rows(failing(3)) }));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "cleanup-failed:d1:2026-11-11T10:00:00.000Z",
      kind: "cleanup-failed",
      title: "Couldn't clean up Ship it's worktree: Device or resource busy",
      taskId: "d1",
      priority: false,
      path: "/code/.harbormaster-worktrees/ship-it",
    });
    expect(entries[0]?.actions.map((a) => [a.id, a.label])).toEqual([
      ["retry-cleanup", "Retry"],
      ["reveal-worktree", "Open folder"],
      ["abandon-cleanup", "Dismiss"],
    ]);
    // Same id on every later attempt: still one item, never a new one.
    expect(assembleInbox(sources({ tasks: rows(failing(7)) }))[0]?.id).toBe(
      entries[0]?.id,
    );
    expect(priorityCount(entries, new Map())).toBe(0);
  });

  it("goes away once the cleanup completed or was abandoned, or the task left Done", () => {
    const done = failing(4);
    const completed = {
      ...done,
      cleanup: { ...done.cleanup!, completedAt: "2026-11-11T11:00:00.000Z" },
    };
    const abandoned = {
      ...done,
      cleanup: { ...done.cleanup!, mode: "abandoned" as const },
    };
    for (const t of [
      completed,
      abandoned,
      { ...done, state: "dev" as const },
    ]) {
      expect(
        assembleInbox(sources({ tasks: rows(t) })).filter(
          (e) => e.kind === "cleanup-failed",
        ),
      ).toEqual([]);
    }
  });
});

describe("tabs, groups and the badge", () => {
  const entries = assembleInbox(
    sources({
      tasks: rows(task("t1"), task("t2")),
      presence: {
        t1: live({
          status: { state: "blocked", at: "2026-11-11T09:00:00.000Z" },
        }),
        t2: live({ status: { state: "idle", at: "2026-11-11T09:10:00.000Z" } }),
      },
      approvals: [
        {
          ...approval,
          targetTaskId: "t1",
          createdAt: "2026-11-11T08:00:00.000Z",
        },
      ],
      items: [reviewRequest],
    }),
  );

  it("splits Priority / Other, groups by task (newest group first) with unbound items in their own group", () => {
    const priority = groupEntries(entries, new Map(), "priority");
    expect(priority.map((g) => [g.key, g.entries.map((e) => e.kind)])).toEqual([
      [UNBOUND_GROUP, ["rule"]],
      ["t1", ["asked", "approval"]],
    ]);
    expect(groupEntries(entries, new Map(), "other").map((g) => g.key)).toEqual(
      ["t2"],
    );
    expect(priorityCount(entries, new Map())).toBe(3);
    // The priority filter's verdict wins over the default.
    const overrides = new Map([["i1", false]]);
    expect(priorityCount(entries, overrides)).toBe(2);
    expect(groupEntries(entries, overrides, "other").map((g) => g.key)).toEqual(
      ["t2", UNBOUND_GROUP],
    );
  });

  it("navigates J/K in group order and keeps a neighbor selected after removal", () => {
    const order = navigationOrder(groupEntries(entries, new Map(), "priority"));
    expect(moveSelection(order, null, 1)).toBe(order[0]);
    expect(moveSelection(order, order[0] ?? null, 1)).toBe(order[1]);
    expect(moveSelection(order, order[2] ?? null, 1)).toBe(order[2]);
    expect(moveSelection(order, order[0] ?? null, -1)).toBe(order[0]);
    expect(moveSelection([], null, 1)).toBeNull();
    const removed = order[1] as string;
    expect(
      selectionAfterRemoval(
        order,
        order.filter((id) => id !== removed),
        removed,
      ),
    ).toBe(order[2]);
    const last = order[2] as string;
    expect(selectionAfterRemoval(order, order.slice(0, 2), last)).toBe(
      order[1],
    );
  });
});

describe("dismiss / snooze state", () => {
  const now = Date.parse("2026-11-11T12:00:00.000Z");
  const entries = assembleInbox(
    sources({
      tasks: rows(task("t1"), task("t2")),
      presence: {
        t1: live({ status: { state: "idle", at: "2026-11-11T09:00:00.000Z" } }),
        t2: live({ status: { state: "idle", at: "2026-11-11T09:10:00.000Z" } }),
      },
      items: [reviewRequest],
    }),
  );

  it("hides dismissed derived items and snoozed ones until their time", () => {
    const local = {
      dismissed: {
        "idle:t1:2026-11-11T09:00:00.000Z": "2026-11-11T11:00:00.000Z",
        i1: "x",
      },
      snoozed: {
        "idle:t2:2026-11-11T09:10:00.000Z": "2026-11-11T13:00:00.000Z",
      },
    };
    // A persisted item ignores the local dismissed map (core resolves it).
    expect(visibleEntries(entries, local, now).map((e) => e.id)).toEqual([
      "i1",
    ]);
    expect(
      visibleEntries(
        entries,
        local,
        Date.parse("2026-11-11T14:00:00.000Z"),
      ).map((e) => e.id),
    ).toEqual(["idle:t2:2026-11-11T09:10:00.000Z", "i1"]);
    // A new signal (new status time) is a new item: the old dismissal does not hide it.
    const fresh = assembleInbox(
      sources({
        tasks: rows(task("t1")),
        presence: {
          t1: live({
            status: { state: "idle", at: "2026-11-11T11:30:00.000Z" },
          }),
        },
      }),
    );
    expect(visibleEntries(fresh, local, now)).toHaveLength(1);
  });

  it("prunes expired snoozes and old dismissals; parses tolerantly", () => {
    expect(
      pruneLocalState(
        {
          dismissed: {
            old: "2026-10-01T00:00:00.000Z",
            recent: "2026-11-10T00:00:00.000Z",
          },
          snoozed: {
            past: "2026-11-11T11:00:00.000Z",
            future: "2026-11-12T00:00:00.000Z",
          },
        },
        now,
      ),
    ).toEqual({
      dismissed: { recent: "2026-11-10T00:00:00.000Z" },
      snoozed: { future: "2026-11-12T00:00:00.000Z" },
    });
    expect(parseLocalState("nope")).toEqual(emptyLocalState());
    expect(
      parseLocalState(
        JSON.stringify({ dismissed: { a: "t", b: 1 }, snoozed: [] }),
      ),
    ).toEqual({
      dismissed: { a: "t" },
      snoozed: {},
    });
  });
});

describe("snoozePresets", () => {
  it("offers this evening only before 17:00, and next Monday morning", () => {
    // Wednesday 10:15 local.
    const morning = new Date(2026, 10, 11, 10, 15);
    const presets = snoozePresets(morning);
    expect(presets.map((p) => p.id)).toEqual([
      "hour",
      "evening",
      "tomorrow",
      "next-week",
    ]);
    expect(presets[0]?.until.getTime()).toBe(morning.getTime() + 3_600_000);
    expect(presets[1]?.until).toEqual(new Date(2026, 10, 11, 18, 0));
    expect(presets[2]?.until).toEqual(new Date(2026, 10, 12, 9, 0));
    expect(presets[3]?.until).toEqual(new Date(2026, 10, 16, 9, 0));
    const evening = snoozePresets(new Date(2026, 10, 16, 19, 0)); // a Monday
    expect(evening.map((p) => p.id)).toEqual(["hour", "tomorrow", "next-week"]);
    expect(evening[2]?.until).toEqual(new Date(2026, 10, 23, 9, 0));
  });
});
