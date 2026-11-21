// Unit tests for the pure task-messaging engine (see /docs/task-messaging.md):
// no I/O, the clock is always passed in.

import { describe, expect, it } from "vitest";
import type {
  MessageMode,
  MessageRoute,
  MessageSender,
  MessageStatus,
  PairGrant,
  TaskMessage,
} from "../src/contracts/messaging.js";
import type { MessageDirectRoutes, Task } from "../src/contracts/model.js";
import {
  buildReceiptText,
  canMessageDirectly,
  classifyRoute,
  countLoopMessages,
  defaultMode,
  deriveMessagingStates,
  deriveRunState,
  isAttachmentPruneEligible,
  isLoopCapReached,
  matchTasks,
  relationTo,
  resolveDeliveredMode,
} from "../src/engines/messaging.js";

const T0 = Date.parse("2026-03-01T12:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

let seq = 0;
function message(
  from: string | MessageSender,
  to: string,
  route: MessageRoute,
  createdMinute: number,
  extra: Partial<TaskMessage> = {},
): TaskMessage {
  seq += 1;
  const sender: MessageSender =
    typeof from === "string" ? { kind: "task", taskId: from } : from;
  return {
    id: `m${seq}`,
    sender,
    senderLabel: "x",
    targetTaskId: to,
    route,
    text: `text ${seq}`,
    requestedMode: "steer",
    attachments: [],
    status: "pending" as MessageStatus,
    createdAt: at(createdMinute),
    ...extra,
  };
}

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    kind: "task",
    state: "working",
    title: `Task ${id}`,
    initialPrompt: "",
    createdAt: at(0),
    updatedAt: at(0),
    stateChangedAt: at(0),
    ...extra,
  };
}

const ALL = { receive: true, steer: true, followUp: true, images: true };

function policyFor(
  directRoutes: MessageDirectRoutes,
  tasks: readonly Task[],
  grants: PairGrant[] = [],
) {
  return {
    directRoutes,
    tasks: new Map(tasks.map((t) => [t.id, t])),
    grants,
  };
}

describe("route classification and modes", () => {
  // root ─┬─ a ── a1
  //       └─ b ── b1        x (a separate top-level task)
  const root = task("root");
  const a = task("a", { parentTaskId: "root" });
  const b = task("b", { parentTaskId: "root" });
  const a1 = task("a1", { parentTaskId: "a" });
  const b1 = task("b1", { parentTaskId: "b" });
  const x = task("x");
  const all = [root, a, b, a1, b1, x];
  const from = (t: Task): MessageSender => ({ kind: "task", taskId: t.id });
  const route = (
    setting: MessageDirectRoutes,
    sender: Task,
    target: Task,
    grants: PairGrant[] = [],
    tasks: readonly Task[] = all,
  ) =>
    classifyRoute(
      from(sender),
      sender,
      target,
      policyFor(setting, tasks, grants),
    );

  it("a direct parent link is direct under every setting, in its own route kinds", () => {
    for (const setting of [
      "parent-and-child",
      "same-task-tree",
      "any-task",
    ] as const) {
      expect(route(setting, root, a)).toBe("parent-to-child");
      expect(route(setting, a, root)).toBe("child-to-parent");
      expect(route(setting, a, a1)).toBe("parent-to-child");
      expect(route(setting, a1, a)).toBe("child-to-parent");
    }
  });

  it("parent-and-child: everything beyond the direct link needs approval", () => {
    const setting = "parent-and-child";
    expect(route(setting, a, b)).toBe("approval"); // sibling
    expect(route(setting, root, a1)).toBe("approval"); // grandparent
    expect(route(setting, a1, root)).toBe("approval"); // grandchild
    expect(route(setting, a1, b1)).toBe("approval"); // cousin
    expect(route(setting, a, x)).toBe("approval"); // unrelated
  });

  it("same-task-tree: anything inside the tree is direct, other trees need approval", () => {
    const setting = "same-task-tree";
    expect(route(setting, a, b)).toBe("task-to-task");
    expect(route(setting, root, a1)).toBe("task-to-task");
    expect(route(setting, a1, root)).toBe("task-to-task");
    expect(route(setting, a1, b1)).toBe("task-to-task");
    expect(route(setting, a, x)).toBe("approval");
    expect(route(setting, x, root)).toBe("approval");
  });

  it("any-task: every task pair is direct", () => {
    const setting = "any-task";
    expect(route(setting, a, b)).toBe("task-to-task");
    expect(route(setting, a1, b1)).toBe("task-to-task");
    expect(route(setting, a, x)).toBe("task-to-task");
    expect(route(setting, x, b1)).toBe("task-to-task");
  });

  it("a pair grant makes that pair direct both ways, and nobody else", () => {
    const grants: PairGrant[] = [{ taskIds: ["a", "x"], grantedAt: at(0) }];
    expect(route("parent-and-child", a, x, grants)).toBe("task-to-task");
    expect(route("parent-and-child", x, a, grants)).toBe("task-to-task");
    expect(route("parent-and-child", a, b, grants)).toBe("approval");
    expect(route("parent-and-child", a1, x, grants)).toBe("approval");
  });

  it("a grant is void once either task is Done or gone", () => {
    const grants: PairGrant[] = [{ taskIds: ["a", "x"], grantedAt: at(0) }];
    const doneX = task("x", { state: "done" });
    const withDone = all.map((t) => (t.id === "x" ? doneX : t));
    expect(route("parent-and-child", a, x, grants, withDone)).toBe("approval");
    const without = all.filter((t) => t.id !== "x");
    expect(route("parent-and-child", a, x, grants, without)).toBe("approval");
  });

  it("canMessageDirectly agrees with the route (used to mark find_tasks results)", () => {
    const policy = policyFor("same-task-tree", all);
    expect(canMessageDirectly(a, b, policy)).toBe(true);
    expect(canMessageDirectly(a, x, policy)).toBe(false);
  });

  it("non-task senders (sessions, rules, Harbormaster) always need approval, even under any-task", () => {
    const policy = policyFor("any-task", all);
    expect(
      classifyRoute({ kind: "session", cwd: "/x" }, undefined, a1, policy),
    ).toBe("approval");
    expect(
      classifyRoute({ kind: "rule", ruleId: "r1" }, undefined, a, policy),
    ).toBe("approval");
    expect(
      classifyRoute({ kind: "harbormaster" }, undefined, root, policy),
    ).toBe("approval");
    expect(classifyRoute({ kind: "user" }, undefined, a, policy)).toBe("user");
  });

  it("defaults the mode by route", () => {
    expect(defaultMode("parent-to-child")).toBe("steer");
    expect(defaultMode("task-to-task")).toBe("steer");
    expect(defaultMode("child-to-parent")).toBe("followUp");
    expect(defaultMode("approval")).toBe("steer");
    expect(defaultMode("receipt")).toBe("followUp");
  });

  it("falls back from steer to followUp when the harness cannot steer", () => {
    const noSteer = { ...ALL, steer: false };
    expect(resolveDeliveredMode("steer", noSteer)).toBe("followUp");
    expect(resolveDeliveredMode("followUp", noSteer)).toBe("followUp");
    expect(resolveDeliveredMode("steer", ALL)).toBe("steer");
    expect(resolveDeliveredMode("followUp", ALL)).toBe("followUp");
  });

  it("reports relations relative to the searching task", () => {
    const parent = task("p");
    const child = task("c", { parentTaskId: "p" });
    const other = task("o");
    const sibling = task("s", { parentTaskId: "p" });
    expect(relationTo(parent, parent)).toBe("self");
    expect(relationTo(child, parent)).toBe("parent");
    expect(relationTo(parent, child)).toBe("child");
    expect(relationTo(child, sibling)).toBe("sibling");
    expect(relationTo(child, other)).toBe("none");
    expect(relationTo(other, other)).toBe("self");
    expect(relationTo(other, sibling)).toBe("none");
    expect(relationTo(undefined, other)).toBe("none");
  });
});

describe("loop cap", () => {
  it("counts lineage messages in both directions for the pair only", () => {
    const messages = [
      message("p", "c", "parent-to-child", 1),
      message("c", "p", "child-to-parent", 2),
      message("p", "c", "parent-to-child", 3),
      message("p", "other", "parent-to-child", 3),
      message("x", "y", "parent-to-child", 3),
    ];
    expect(countLoopMessages(messages, {}, "p", "c")).toBe(3);
  });

  it("counts every direct route per unordered pair, including non-lineage and granted pairs", () => {
    const messages = [
      message("a", "b", "task-to-task", 1),
      message("b", "a", "task-to-task", 2),
      message("a", "b", "task-to-task", 3),
      message("a", "c", "task-to-task", 3),
      message("c", "b", "task-to-task", 3),
    ];
    expect(countLoopMessages(messages, {}, "a", "b")).toBe(3);
    expect(countLoopMessages(messages, {}, "b", "a")).toBe(3);
    expect(isLoopCapReached(messages, {}, "a", "b", 3)).toBe(true);
    expect(isLoopCapReached(messages, {}, "a", "c", 3)).toBe(false);
    // The user typing into either side resets that pair only.
    expect(countLoopMessages(messages, { b: at(2) }, "a", "b")).toBe(1);
    expect(countLoopMessages(messages, { b: at(2) }, "a", "c")).toBe(1);
  });

  it("excludes approval, receipt, rejected and failed messages", () => {
    const messages = [
      message("p", "c", "approval", 1, { status: "delivered" }),
      message({ kind: "harbormaster" }, "c", "receipt", 1),
      message("p", "c", "parent-to-child", 1, { status: "failed" }),
      message("p", "c", "parent-to-child", 1, { status: "rejected" }),
      message("p", "c", "parent-to-child", 1, { status: "delivered" }),
    ];
    expect(countLoopMessages(messages, {}, "p", "c")).toBe(1);
  });

  it("only counts messages created after the user last typed into either task", () => {
    const messages = [
      message("p", "c", "parent-to-child", 1),
      message("c", "p", "child-to-parent", 2),
      message("p", "c", "parent-to-child", 5),
      message("c", "p", "child-to-parent", 6),
    ];
    expect(countLoopMessages(messages, { c: at(2) }, "p", "c")).toBe(2);
    expect(countLoopMessages(messages, { p: at(5) }, "p", "c")).toBe(1);
    expect(countLoopMessages(messages, { p: at(3), c: at(6) }, "p", "c")).toBe(
      0,
    );
    expect(countLoopMessages(messages, { other: at(9) }, "p", "c")).toBe(4);
  });

  it("is reached at the cap and resets on user input", () => {
    const messages = Array.from({ length: 8 }, (_, i) =>
      message(
        i % 2 ? "c" : "p",
        i % 2 ? "p" : "c",
        i % 2 ? "child-to-parent" : "parent-to-child",
        i + 1,
      ),
    );
    expect(isLoopCapReached(messages, {}, "p", "c", 8)).toBe(true);
    expect(isLoopCapReached(messages.slice(1), {}, "p", "c", 8)).toBe(false);
    expect(isLoopCapReached(messages, { c: at(20) }, "p", "c", 8)).toBe(false);
  });
});

describe("deriveMessagingStates", () => {
  const tasks = [task("p"), task("c", { parentTaskId: "p" })];
  const live = new Set(["p"]);
  const base = {
    tasks,
    userInputs: {} as Record<string, string>,
    liveTaskIds: live as ReadonlySet<string>,
    now: new Date(at(10)),
    parentReplyTimeoutMinutes: 30,
    loopCap: 8,
  };
  const question = (extra: Partial<TaskMessage> = {}) =>
    message("c", "p", "child-to-parent", 1, {
      status: "delivered",
      deliveredAt: at(2),
      text: "which db?",
      ...extra,
    });
  const state = (
    input: Partial<Parameters<typeof deriveMessagingStates>[0]> & {
      messages: TaskMessage[];
    },
    id: string,
  ) =>
    deriveMessagingStates({ ...base, ...input }).find((s) => s.taskId === id);

  it("a loop-capped pair chips both tasks, whatever the route, and only that pair", () => {
    const pairTasks = [task("a"), task("b"), task("c")];
    const messages = Array.from({ length: 3 }, (_, i) =>
      message(i % 2 ? "b" : "a", i % 2 ? "a" : "b", "task-to-task", i + 1),
    );
    const states = deriveMessagingStates({
      ...base,
      tasks: pairTasks,
      messages,
      loopCap: 3,
    });
    expect(states.find((s) => s.taskId === "a")?.loopCapReached).toEqual({
      otherTaskId: "b",
      count: 3,
      cap: 3,
    });
    expect(states.find((s) => s.taskId === "b")?.loopCapReached).toEqual({
      otherTaskId: "a",
      count: 3,
      cap: 3,
    });
    expect(states.find((s) => s.taskId === "c")).toBeUndefined();
  });

  it("reports grants in force on both tasks and drops those whose task is Done", () => {
    const grants: PairGrant[] = [
      { taskIds: ["c", "p"], grantedAt: at(0) },
      { taskIds: ["gone", "p"], grantedAt: at(0) },
    ];
    expect(state({ messages: [], grants }, "c")?.grantedWith).toEqual(["p"]);
    expect(state({ messages: [], grants }, "p")?.grantedWith).toEqual(["c"]);
    const doneTasks = [
      task("p"),
      task("c", { parentTaskId: "p", state: "done" }),
    ];
    expect(
      state({ messages: [], grants, tasks: doneTasks }, "p"),
    ).toBeUndefined();
  });

  it("a delivered question puts the child on waiting-on-parent with a deadline, and flags the parent", () => {
    const q = question();
    const child = state({ messages: [q] }, "c");
    expect(child?.waitingOnParent).toEqual({
      messageId: q.id,
      question: "which db?",
      deliveredAt: at(2),
      expiresAt: at(32),
    });
    expect(state({ messages: [q] }, "p")?.childQuestionsWaiting).toBe(1);
  });

  it("a not-yet-delivered question waits with no deadline", () => {
    const q = question({ status: "pending" });
    delete q.deliveredAt;
    const waiting = state({ messages: [q] }, "c")?.waitingOnParent;
    expect(waiting?.messageId).toBe(q.id);
    expect(waiting?.expiresAt).toBeUndefined();
    expect(waiting?.deliveredAt).toBeUndefined();
  });

  it("ends when a parent-to-child message is delivered after the question", () => {
    const reply = message("p", "c", "parent-to-child", 4, {
      status: "delivered",
      deliveredAt: at(5),
    });
    expect(state({ messages: [question(), reply] }, "c")).toBeUndefined();
    // Still pending (not delivered) or older than the question: keeps waiting.
    const pending = message("p", "c", "parent-to-child", 4);
    expect(
      state({ messages: [question(), pending] }, "c")?.waitingOnParent,
    ).toBeDefined();
    // ...but the parent replied: its "child asked a question" is over.
    expect(
      state({ messages: [question(), pending] }, "p")?.childQuestionsWaiting,
    ).toBeUndefined();
    // A failed reply answers nothing.
    const failed = message("p", "c", "parent-to-child", 4, {
      status: "failed",
    });
    expect(
      state({ messages: [question(), failed] }, "p")?.childQuestionsWaiting,
    ).toBe(1);
    const stale = message("p", "c", "parent-to-child", 0, {
      status: "delivered",
      deliveredAt: at(0.5),
    });
    expect(
      state({ messages: [question(), stale] }, "c")?.waitingOnParent,
    ).toBeDefined();
  });

  it("ends when the user typed into the child after the question", () => {
    expect(
      state({ messages: [question()], userInputs: { c: at(3) } }, "c"),
    ).toBeUndefined();
    expect(
      state({ messages: [question()], userInputs: { c: at(0.5) } }, "c")
        ?.waitingOnParent,
    ).toBeDefined();
    // Typing into the parent does not end it.
    expect(
      state({ messages: [question()], userInputs: { p: at(3) } }, "c")
        ?.waitingOnParent,
    ).toBeDefined();
  });

  it("ends when the parent is Done, not live, or gone", () => {
    const messages = [question()];
    expect(
      state(
        { messages, tasks: [task("p", { state: "done" }), tasks[1] as Task] },
        "c",
      ),
    ).toBeUndefined();
    expect(state({ messages, liveTaskIds: new Set() }, "c")).toBeUndefined();
    expect(state({ messages, tasks: [tasks[1] as Task] }, "c")).toBeUndefined();
  });

  it("ends at deliveredAt + timeout, counted from delivery not from creation", () => {
    const messages = [question({ createdAt: at(-100), deliveredAt: at(2) })];
    expect(
      state({ messages, now: new Date(at(31.9)) }, "c")?.waitingOnParent,
    ).toBeDefined();
    expect(state({ messages, now: new Date(at(32)) }, "c")).toBeUndefined();
    expect(
      state(
        { messages, now: new Date(at(32)), parentReplyTimeoutMinutes: 60 },
        "c",
      )?.waitingOnParent,
    ).toBeDefined();
  });

  it("only the latest question counts; failed/rejected ones are ignored", () => {
    const old = question();
    const latest = question({
      createdAt: at(6),
      deliveredAt: at(7),
      text: "and?",
    });
    expect(
      state({ messages: [old, latest] }, "c")?.waitingOnParent?.question,
    ).toBe("and?");
    const failed = question({ status: "failed" });
    expect(state({ messages: [failed] }, "c")).toBeUndefined();
  });

  it("a Done child no longer waits", () => {
    expect(
      state(
        {
          messages: [question()],
          tasks: [task("p"), task("c", { parentTaskId: "p", state: "done" })],
        },
        "c",
      ),
    ).toBeUndefined();
  });

  it("counts approvals waiting per target", () => {
    const messages = [
      message({ kind: "session", cwd: "/x" }, "c", "approval", 1, {
        status: "awaiting_approval",
      }),
      message("p", "c", "approval", 2, { status: "awaiting_approval" }),
      message("p", "c", "approval", 3, { status: "delivered" }),
    ];
    expect(state({ messages }, "c")?.approvalsWaiting).toBe(2);
    expect(state({ messages }, "p")).toBeUndefined();
  });

  it("flags the loop cap on both tasks of the pair", () => {
    const messages = Array.from({ length: 8 }, (_, i) =>
      i % 2
        ? message("c", "p", "child-to-parent", i + 1, { status: "delivered" })
        : message("p", "c", "parent-to-child", i + 1, { status: "delivered" }),
    );
    const cap = (id: string) => state({ messages }, id)?.loopCapReached;
    expect(cap("c")).toEqual({ otherTaskId: "p", count: 8, cap: 8 });
    expect(cap("p")).toEqual({ otherTaskId: "c", count: 8, cap: 8 });
    expect(
      state({ messages, userInputs: { p: at(30) } }, "c")?.loopCapReached,
    ).toBeUndefined();
  });
});

describe("attachment pruning", () => {
  const now = new Date(at(0));
  const days = (n: number) => new Date(T0 - n * 86_400_000).toISOString();
  const withFile = (extra: Partial<TaskMessage> = {}) =>
    message("a", "b", "approval", 0, {
      attachments: [{ path: "/p", originalPath: "/o", bytes: 1 }],
      ...extra,
    });
  const done = (daysAgo: number) =>
    task("x", { state: "done", completedAt: days(daysAgo) });

  it("needs both ends Done for 30 days (or deleted)", () => {
    const tasks = new Map([
      ["a", done(31)],
      ["b", done(30)],
    ]);
    expect(isAttachmentPruneEligible(withFile(), tasks, now)).toBe(true);
    tasks.set("b", done(29));
    expect(isAttachmentPruneEligible(withFile(), tasks, now)).toBe(false);
    tasks.set("b", task("b"));
    expect(isAttachmentPruneEligible(withFile(), tasks, now)).toBe(false);
    tasks.delete("b");
    tasks.set("a", done(1));
    expect(isAttachmentPruneEligible(withFile(), tasks, now)).toBe(false);
  });

  it("deleted tasks and non-task senders count as Done", () => {
    expect(isAttachmentPruneEligible(withFile(), new Map(), now)).toBe(true);
    const sessionMessage = withFile({ sender: { kind: "session", cwd: "/x" } });
    expect(
      isAttachmentPruneEligible(
        sessionMessage,
        new Map([["b", done(40)]]),
        now,
      ),
    ).toBe(true);
    expect(
      isAttachmentPruneEligible(
        sessionMessage,
        new Map([["b", task("b")]]),
        now,
      ),
    ).toBe(false);
  });

  it("skips messages with nothing left to prune", () => {
    expect(
      isAttachmentPruneEligible(
        message("a", "b", "approval", 0),
        new Map(),
        now,
      ),
    ).toBe(false);
    expect(
      isAttachmentPruneEligible(
        withFile({
          attachments: [
            { path: "/p", originalPath: "/o", bytes: 1, prunedAt: days(1) },
          ],
        }),
        new Map(),
        now,
      ),
    ).toBe(false);
  });
});

describe("matchTasks", () => {
  const tasks = [
    task("aaaa1111", {
      title: "Fix login redirect",
      repositoryId: "github.com/acme/web",
      branch: "fix-login",
      pr: { number: 412, state: "open" },
      updatedAt: at(5),
    }),
    task("bbbb2222", { title: "Login page redesign", updatedAt: at(9) }),
    task("cccc3333", {
      title: "Unrelated",
      repositoryId: "github.com/acme/login-tools",
      updatedAt: at(1),
    }),
    task("dddd4444", {
      title: "Old login work",
      state: "done",
      updatedAt: at(8),
    }),
    task("kid00001", { title: "Child of aaaa", parentTaskId: "aaaa1111" }),
    task("kid00002", { title: "Other child", parentTaskId: "aaaa1111" }),
  ];
  const ids = (query: string, options?: Parameters<typeof matchTasks>[2]) =>
    matchTasks(query, tasks, options).map((m) => m.task.id);

  it("matches case-insensitively over title, repository, branch, PR number and id prefix", () => {
    expect(ids("LOGIN")).toEqual(["bbbb2222", "aaaa1111", "cccc3333"]);
    expect(ids("acme/web")).toEqual(["aaaa1111"]);
    expect(ids("fix-login")).toEqual(["aaaa1111"]);
    expect(ids("#412")).toEqual(["aaaa1111"]);
    expect(ids("412")).toEqual(["aaaa1111"]);
    expect(ids("bbbb")).toEqual(["bbbb2222"]);
    expect(ids("nothing-matches")).toEqual([]);
  });

  it("requires every word to match", () => {
    expect(ids("login redirect")).toEqual(["aaaa1111"]);
    expect(ids("login zzz")).toEqual([]);
  });

  it("excludes Done unless asked", () => {
    expect(ids("old")).toEqual([]);
    expect(ids("old", { includeDone: true })).toEqual(["dddd4444"]);
  });

  it("sorts by relevance, then recency, and honors the limit", () => {
    // Title-prefix beats title-contains, which ties on recency; repository-only is last.
    expect(ids("login", { includeDone: true })).toEqual([
      "bbbb2222", // title starts with "login"
      "dddd4444", // title contains, newer than aaaa1111
      "aaaa1111",
      "cccc3333", // repository only
    ]);
    expect(ids("login", { limit: 1 })).toEqual(["bbbb2222"]);
    expect(matchTasks("", tasks)).toHaveLength(5);
    const many = Array.from({ length: 30 }, (_, i) => task(`t${i}`));
    expect(matchTasks("t", many)).toHaveLength(20);
  });

  it("reports the relation to the searching task", () => {
    const rel = (query: string, from: string) =>
      matchTasks(query, tasks, { fromTaskId: from })[0]?.relation;
    expect(rel("aaaa1111", "aaaa1111")).toBe("self");
    expect(rel("aaaa1111", "kid00001")).toBe("parent");
    expect(rel("kid00001", "aaaa1111")).toBe("child");
    expect(rel("kid00002", "kid00001")).toBe("sibling");
    expect(rel("bbbb2222", "kid00001")).toBe("none");
    expect(rel("bbbb2222", "missing")).toBe("none");
  });
});

describe("run state and receipts", () => {
  it("derives the run state", () => {
    expect(
      deriveRunState(
        { launch: { status: "queued", requestedAt: at(0) } },
        { live: false, runningTurn: false },
      ),
    ).toBe("queued");
    expect(deriveRunState({}, { live: true, runningTurn: true })).toBe(
      "running",
    );
    expect(deriveRunState({}, { live: true, runningTurn: false })).toBe(
      "your-move",
    );
    expect(deriveRunState({}, { live: false, runningTurn: false })).toBe(
      "not-running",
    );
  });

  it("words the receipts", () => {
    const mode: MessageMode = "steer";
    void mode;
    expect(
      buildReceiptText({ outcome: "approved", targetTitle: "T", text: "hi" }),
    ).toContain("approved");
    expect(
      buildReceiptText({
        outcome: "approved",
        targetTitle: "T",
        text: "new",
        originalText: "old",
      }),
    ).toContain("after editing it");
    expect(
      buildReceiptText({ outcome: "rejected", targetTitle: "T", text: "x" }),
    ).toContain("rejected");
    expect(
      buildReceiptText({
        outcome: "failed",
        targetTitle: "T",
        text: "x",
        failureReason: "Task t is Done",
      }),
    ).toContain("Task t is Done");
  });
});
