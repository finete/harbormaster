// Integration tests for task messaging through `createCore` (see
// /docs/task-messaging.md): every send-time rule and its error, approval
// (edit + receipt), claiming, derived chip states, find, and pruning. A temp
// state dir, a controllable clock, and a fake harness adapter stand in for
// presence and capabilities (`CoreOptions.harness`).

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  PullRequestAccess,
  VersionAccess,
} from "../src/contracts/github.js";
import type {
  HarnessAdapter,
  LaunchSpec,
  PresenceStatus,
} from "../src/contracts/harness.js";
import type { HarnessMessagingCapabilities } from "../src/contracts/messaging.js";
import type { Clock } from "../src/contracts/services.js";
import {
  type Core,
  CoreManager,
  type CoreManagerDependencies,
  createCore,
  JsonWorkspaceBindingAccess,
  resolveStatePaths,
  SessionPresenceAccess,
} from "../src/index.js";

const ALL: HarnessMessagingCapabilities = {
  receive: true,
  steer: true,
  followUp: true,
  images: true,
};

/** Advances one second per read so timestamps are strictly increasing; `jump` skips ahead. */
class TestClock implements Clock {
  private ms = Date.parse("2026-01-01T00:00:00.000Z");
  now(): Date {
    const current = new Date(this.ms);
    this.ms += 1000;
    return current;
  }
  jumpMinutes(minutes: number): void {
    this.ms += minutes * 60_000;
  }
}

class FakeHarness implements HarnessAdapter {
  messaging: HarnessMessagingCapabilities = { ...ALL };
  private readonly live = new Map<string, { runningTurn: boolean }>();
  setLive(taskId: string, runningTurn = false): void {
    this.live.set(taskId, { runningTurn });
  }
  setNotLive(taskId: string): void {
    this.live.delete(taskId);
  }
  async presence(taskId: string): Promise<PresenceStatus> {
    const entry = this.live.get(taskId);
    return { live: !!entry, runningTurn: entry?.runningTurn ?? false };
  }
  buildLaunchSpec(): LaunchSpec {
    throw new Error("not used");
  }
  async stopHeadless(): Promise<void> {}
  async attach(): Promise<void> {}
}

const noGithub = new Proxy({} as PullRequestAccess & VersionAccess, {
  get: () => () => {
    throw new Error("GitHub/HTTP access must not be used in these tests");
  },
});

let root: string;
let stateDir: string;
let core: Core;
let clock: TestClock;
let harness: FakeHarness;
let counter: number;

async function boot(config: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(stateDir, "config.json"),
    JSON.stringify({ automation: false, movers: [], ...config }),
  );
  core = createCore({
    stateDir,
    clock,
    ids: { next: () => `id-${String(++counter).padStart(4, "0")}` },
    pullRequests: noGithub,
    versions: noGithub,
    harness,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harbormaster-task-messaging-"));
  stateDir = join(root, "state");
  clock = new TestClock();
  harness = new FakeHarness();
  counter = 0;
  const { mkdir } = await import("node:fs/promises");
  await mkdir(stateDir, { recursive: true });
  await boot();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const c = () => core.commands;

/** A started Dev task with a scratch workspace (a messaging target needs a binding to host a session). */
async function mk(title: string): Promise<string> {
  const id = await unbound(title);
  await bindScratch(id);
  return id;
}
async function bindScratch(taskId: string): Promise<void> {
  const paths = resolveStatePaths(stateDir);
  const now = new Date().toISOString();
  await new JsonWorkspaceBindingAccess(
    paths.workspaceBindingsFile,
    paths.workspaceBindingsLockFile,
  ).attachBinding({
    id: `binding-${taskId}`,
    taskId,
    worktreePath: join(root, "scratch", taskId),
    scratch: true,
    detached: false,
    createdAt: now,
    updatedAt: now,
  });
}
/** A started Dev task with no workspace binding at all. */
async function unbound(title: string): Promise<string> {
  return (await c().createTask({ title, initialPrompt: "", start: true })).id;
}
async function backlog(title: string): Promise<string> {
  return (await c().createTask({ title, initialPrompt: "" })).id;
}
async function child(parentId: string, title: string): Promise<string> {
  const task = await c().launchTask({
    relation: "child",
    fromTaskId: parentId,
    title,
    prompt: "do it",
    repository: { none: true },
  });
  await c().claimPendingLaunches(50);
  return task.id;
}
const from = (taskId: string) => ({ kind: "task" as const, taskId });
const send = (sender: string, target: string, text = "hi", extra = {}) =>
  c().sendTaskMessage({
    from: from(sender),
    targetTaskId: target,
    text,
    ...extra,
  });

async function file(
  name: string,
  content: string | Buffer = "data",
): Promise<string> {
  const path = join(root, name);
  await writeFile(path, content);
  return path;
}

describe("send-time rules", () => {
  it("rejects a task messaging itself, bad senders and empty text", async () => {
    const a = await mk("A");
    await expect(send(a, a)).rejects.toThrow(
      "A task can't send a message to itself.",
    );
    await expect(send("ghost", a)).rejects.toThrow(
      "Sending task not found: ghost",
    );
    await expect(
      c().sendTaskMessage({
        from: { kind: "harbormaster" },
        targetTaskId: a,
        text: "x",
      }),
    ).rejects.toThrow(/as Harbormaster/);
    const b = await mk("B");
    await expect(send(a, b, "   ")).rejects.toThrow("Message text is empty.");
    expect(await c().listMessages()).toEqual([]);
  });

  it("checks sender ≠ target before anything else", async () => {
    const a = await mk("A");
    harness.messaging = { ...ALL, receive: false };
    await expect(send(a, a)).rejects.toThrow("can't send a message to itself");
  });

  it("rejects unknown, Done and Backlog targets", async () => {
    const a = await mk("A");
    await expect(send(a, "nope")).rejects.toThrow("Task not found: nope");
    const done = await mk("Finished");
    await c().moveTask(done, "done");
    await expect(send(a, done)).rejects.toThrow(
      `Task ${done} is Done; messages can't be delivered.`,
    );
    const parked = await backlog("Parked");
    await expect(send(a, parked)).rejects.toThrow(
      `Task ${parked} is in Backlog`,
    );
    const noWorkspace = await unbound("No workspace");
    await expect(send(a, noWorkspace)).rejects.toThrow(
      `Task ${noWorkspace} has no workspace, so it has no session to receive messages`,
    );
    await expect(
      c().sendTaskMessage({
        from: { kind: "session", cwd: "/x" },
        targetTaskId: done,
        text: "x",
      }),
    ).rejects.toThrow(/is Done/);
    expect(await c().listMessages()).toEqual([]);
  });

  it("parent → live child: pending steer, delivered to its inbox", async () => {
    const p = await mk("Parent");
    const k = await child(p, "Kid");
    harness.setLive(k, true);
    const result = await send(p, k, "use the new API");
    expect(result.message).toMatchObject({
      route: "parent-to-child",
      status: "pending",
      requestedMode: "steer",
      senderLabel: "Parent",
      targetTaskId: k,
      text: "use the new API",
      attachments: [],
    });
    expect(result.willWake).toBe(false);
    expect(result.note).toBe(
      'Delivered to the inbox of "Kid" (steer); it arrives at its next step boundary.',
    );
    expect(await c().listTasksWithPendingMessages()).toEqual([k]);
  });

  it("honors a requested mode and words the followUp note", async () => {
    const p = await mk("Parent");
    const k = await child(p, "Kid");
    harness.setLive(k);
    const result = await send(p, k, "later", { mode: "followUp" });
    expect(result.message.requestedMode).toBe("followUp");
    expect(result.note).toContain("(followUp)");
  });

  it("parent → child that is not running: willWake", async () => {
    const p = await mk("Parent");
    const k = await child(p, "Kid");
    const result = await send(p, k);
    expect(result.willWake).toBe(true);
    expect(result.note).toBe(
      `"Kid" isn't running; Harbormaster will wake it and deliver the message.`,
    );
  });

  it("parent → child with a queued launch: held until it starts", async () => {
    const p = await mk("Parent");
    const queued = await c().launchTask({
      relation: "child",
      fromTaskId: p,
      title: "Queued kid",
      prompt: "x",
      repository: { none: true },
    });
    const result = await send(p, queued.id);
    expect(result.willWake).toBe(false);
    expect(result.note).toContain("delivered as soon as it starts");
    expect(result.message.status).toBe("pending");
  });

  it("child → parent: followUp by default, needs a live parent", async () => {
    const p = await mk("Parent");
    const k = await child(p, "Kid");
    await expect(send(k, p, "which db?")).rejects.toThrow(
      "Your parent task is not running; stop and ask the user instead.",
    );
    harness.setLive(p);
    const result = await send(k, p, "which db?");
    expect(result.message).toMatchObject({
      route: "child-to-parent",
      status: "pending",
      requestedMode: "followUp",
      senderLabel: "Kid",
    });
    expect(result.willWake).toBe(false);
  });

  it("child → Done parent is rejected as Done", async () => {
    const p = await mk("Parent");
    const k = await child(p, "Kid");
    await c().moveTask(p, "done");
    harness.setLive(p);
    await expect(send(k, p)).rejects.toThrow(/is Done/);
  });

  it("fails when the harness cannot receive, before any loop-cap or attachment work", async () => {
    const p = await mk("Parent");
    const k = await child(p, "Kid");
    harness.setLive(p);
    harness.setLive(k);
    harness.messaging = { ...ALL, receive: false };
    await expect(send(k, p)).rejects.toThrow(/can't receive replies/);
    await expect(send(p, k)).rejects.toThrow(/can't receive messages/);
    const stray = await mk("Stray");
    await expect(send(stray, p)).rejects.toThrow(/can't receive messages/);
    expect(await c().listMessages()).toEqual([]);
  });

  it("siblings, unrelated tasks and a parent's non-child targets need approval", async () => {
    const p = await mk("Parent");
    const k1 = await child(p, "Kid 1");
    const k2 = await child(p, "Kid 2");
    const other = await mk("Other");
    harness.setLive(other);
    for (const [s, t] of [
      [k1, k2],
      [k1, other],
      [other, p],
      [p, other],
    ] as const) {
      const result = await send(s, t);
      expect(result.message.route).toBe("approval");
      expect(result.message.status).toBe("awaiting_approval");
      expect(result.message.requestedMode).toBe("steer");
      expect(result.willWake).toBe(false);
      expect(result.note).toBe(
        "Awaiting the user's approval in the Harbormaster app; you'll get a follow-up with the result. Don't wait for it -- continue or end your turn.",
      );
    }
    // Nothing is deliverable until approved.
    expect(await c().listTasksWithPendingMessages()).toEqual([]);
    expect(await c().listPendingApprovals()).toHaveLength(4);
  });

  it("a non-task sender always goes through approval, even to a child", async () => {
    const p = await mk("Parent");
    const k = await child(p, "Kid");
    const result = await c().sendTaskMessage({
      from: { kind: "session", cwd: "/work/repo", sessionId: "s1" },
      targetTaskId: k,
      text: "from outside",
    });
    expect(result.message).toMatchObject({
      route: "approval",
      status: "awaiting_approval",
      senderLabel: "Pi session in /work/repo",
    });
    expect(result.note).toContain("no result is reported back");
  });
});

describe("loop cap", () => {
  async function pair(): Promise<{ p: string; k: string }> {
    const p = await mk("Parent");
    const k = await child(p, "Kid");
    harness.setLive(p);
    harness.setLive(k);
    return { p, k };
  }
  async function exchange(p: string, k: string, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await (i % 2 === 0 ? send(p, k) : send(k, p));
    }
  }

  it("rejects the 9th autonomous message in both directions, and resets when the user types", async () => {
    const { p, k } = await pair();
    await exchange(p, k, 8);
    await expect(send(p, k)).rejects.toThrow(
      'Message cap reached between "Kid" and "Parent" (8 since the user last typed); stop and ask the user.',
    );
    await expect(send(k, p)).rejects.toThrow(/Message cap reached/);
    expect(
      (await c().getMessagingStates()).find((s) => s.taskId === k)
        ?.loopCapReached,
    ).toEqual({
      otherTaskId: p,
      count: 8,
      cap: 8,
    });
    await c().recordUserInput(k);
    await expect(send(p, k)).resolves.toBeDefined();
    expect(
      (await c().getMessagingStates()).find((s) => s.taskId === k)
        ?.loopCapReached,
    ).toBeUndefined();
  });

  it("a user typing into the parent also resets it", async () => {
    const { p, k } = await pair();
    await exchange(p, k, 8);
    await c().recordUserInput(p);
    await expect(send(k, p)).resolves.toBeDefined();
  });

  it("approved sends, receipts and rejected/failed messages never count; the cap is configurable", async () => {
    const { p, k } = await pair();
    const other = await mk("Other");
    harness.setLive(other);
    for (let i = 0; i < 10; i += 1) {
      const sent = await send(k, other); // approval route (sibling-ish): needs approval
      await c().approveMessage(sent.message.id); // also enqueues a receipt to k
    }
    await expect(send(p, k)).resolves.toBeDefined();
    await boot({ messaging: { loopCap: 2 } });
    await expect(send(k, p)).resolves.toBeDefined();
    await expect(send(p, k)).rejects.toThrow(/\(2 since the user last typed\)/);
  });

  it("a rejected cap does not leave attachment copies behind", async () => {
    const { p, k } = await pair();
    await boot({ messaging: { loopCap: 1 } });
    await send(p, k);
    await expect(
      send(p, k, "x", { attachments: [await file("a.png")] }),
    ).rejects.toThrow(/Message cap/);
    const { readdir } = await import("node:fs/promises");
    expect(
      await readdir(join(stateDir, "messages", "attachments")).catch(() => []),
    ).toEqual([]);
  });
});

describe("attachments", () => {
  it("copies attachments at send time and serves them back as base64", async () => {
    const a = await mk("A");
    const b = await mk("B");
    const shot = await file("shot.png", Buffer.from([9, 8, 7]));
    const { message } = await send(a, b, "look", { attachments: [shot] });
    const att = message.attachments[0];
    expect(att).toMatchObject({
      originalPath: shot,
      mimeType: "image/png",
      bytes: 3,
    });
    expect(
      att?.path.startsWith(
        join(stateDir, "messages", "attachments", message.id),
      ),
    ).toBe(true);
    expect(await c().readMessageAttachment(message.id, 0)).toEqual({
      mimeType: "image/png",
      base64: Buffer.from([9, 8, 7]).toString("base64"),
    });
    await expect(c().readMessageAttachment(message.id, 1)).rejects.toThrow(
      /no attachment 1/,
    );
    await expect(c().readMessageAttachment("nope", 0)).rejects.toThrow(
      /not found/,
    );
  });

  it("rejects invalid attachments without recording anything", async () => {
    const a = await mk("A");
    const b = await mk("B");
    await expect(
      send(a, b, "x", { attachments: ["relative.png"] }),
    ).rejects.toThrow(/absolute/);
    await expect(
      send(a, b, "x", { attachments: [join(root, "missing.png")] }),
    ).rejects.toThrow(/not found/);
    expect(await c().listMessages()).toEqual([]);
  });
});

describe("approval", () => {
  it("approve with edits: pending for the target, original kept, receipt to the task sender", async () => {
    const a = await mk("A");
    const b = await mk("B");
    harness.setLive(b);
    const sent = await send(a, b, "original text");
    const approved = await c().approveMessage(sent.message.id, {
      text: "edited text",
      mode: "followUp",
    });
    expect(approved).toMatchObject({
      status: "pending",
      text: "edited text",
      originalText: "original text",
      requestedMode: "followUp",
    });
    expect(approved.approvedAt).toBeDefined();
    expect(await c().listPendingApprovals()).toEqual([]);

    const receipts = (await c().listMessages({ taskId: a })).filter(
      (m) => m.route === "receipt",
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      sender: { kind: "harbormaster" },
      senderLabel: "Harbormaster",
      targetTaskId: a,
      requestedMode: "followUp",
      status: "pending",
      regardingMessageId: sent.message.id,
    });
    expect(receipts[0]?.text).toContain("after editing it");
    expect(await c().listTasksWithPendingMessages()).toEqual(
      expect.arrayContaining([a, b]),
    );

    // The target claims the approved message with the edited content.
    const claimed = await c().claimInboxMessages(b, { idle: true });
    expect(claimed.map((m) => m.text)).toEqual(["edited text"]);
  });

  it("approve without edits keeps text and mode", async () => {
    const a = await mk("A");
    const b = await mk("B");
    const sent = await send(a, b, "as is");
    const approved = await c().approveMessage(sent.message.id);
    expect(approved).toMatchObject({
      status: "pending",
      text: "as is",
      requestedMode: "steer",
    });
    expect(approved.originalText).toBeUndefined();
  });

  it("reject: rejected, never delivered, receipt to the task sender", async () => {
    const a = await mk("A");
    const b = await mk("B");
    const sent = await send(a, b);
    const rejected = await c().rejectMessage(sent.message.id);
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectedAt).toBeDefined();
    expect(await c().claimInboxMessages(b, { idle: true })).toEqual([]);
    const receipt = (await c().listMessages({ taskId: a })).find(
      (m) => m.route === "receipt",
    );
    expect(receipt?.text).toContain("rejected");
    await expect(c().rejectMessage(sent.message.id)).rejects.toThrow(
      /not awaiting approval/,
    );
    await expect(c().approveMessage(sent.message.id)).rejects.toThrow(
      /not awaiting approval/,
    );
  });

  it("no receipt for a non-task sender, a sender whose harness cannot receive, or a Done sender", async () => {
    const a = await mk("A");
    const b = await mk("B");
    const viaSession = await c().sendTaskMessage({
      from: { kind: "session", cwd: "/x" },
      targetTaskId: b,
      text: "hi",
    });
    await c().approveMessage(viaSession.message.id);
    const doneSender = await send(a, b);
    await c().moveTask(a, "done");
    await c().approveMessage(doneSender.message.id);
    expect(
      (await c().listMessages()).filter((m) => m.route === "receipt"),
    ).toEqual([]);

    const e = await mk("E");
    const noReceive = await send(e, b);
    harness.messaging = { ...ALL, receive: false };
    await c().rejectMessage(noReceive.message.id);
    expect(
      (await c().listMessages()).filter((m) => m.route === "receipt"),
    ).toEqual([]);
  });

  it("approving after the target is Done fails the message with a reason (and tells the sender)", async () => {
    const a = await mk("A");
    const b = await mk("B");
    const sent = await send(a, b);
    await c().moveTask(b, "done");
    const result = await c().approveMessage(sent.message.id);
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe(
      `Task ${b} is Done; messages can't be delivered.`,
    );
    expect(result.failedAt).toBeDefined();
    const receipt = (await c().listMessages({ taskId: a })).find(
      (m) => m.route === "receipt",
    );
    expect(receipt?.text).toContain("could not be delivered");
    expect(await c().claimInboxMessages(b, { idle: true })).toEqual([]);
  });

  it("approving after the target was deleted fails the message", async () => {
    const a = await mk("A");
    const b = await mk("B");
    const sent = await send(a, b);
    await c().deleteTask(b);
    const result = await c().approveMessage(sent.message.id);
    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/no longer exists/);
  });

  it("rejects an empty edit and unknown ids", async () => {
    const a = await mk("A");
    const b = await mk("B");
    const sent = await send(a, b);
    await expect(
      c().approveMessage(sent.message.id, { text: " " }),
    ).rejects.toThrow(/empty/);
    await expect(c().approveMessage("nope")).rejects.toThrow(/not found/);
    expect((await c().listPendingApprovals()).map((m) => m.id)).toEqual([
      sent.message.id,
    ]);
  });
});

describe("claiming", () => {
  it("steer claims any time; followUp only when idle; oldest first with the resolved mode", async () => {
    const p = await mk("Parent");
    const k = await child(p, "Kid");
    const follow = await send(p, k, "second", { mode: "followUp" });
    const steer = await send(p, k, "third");
    const busy = await c().claimInboxMessages(k, { idle: false });
    expect(busy.map((m) => m.id)).toEqual([steer.message.id]);
    expect(busy[0]).toMatchObject({
      status: "delivered",
      deliveredMode: "steer",
    });
    expect(busy[0]?.deliveredAt).toBeDefined();
    const idle = await c().claimInboxMessages(k, { idle: true });
    expect(idle.map((m) => m.id)).toEqual([follow.message.id]);
    expect(idle[0]?.deliveredMode).toBe("followUp");
    expect(await c().claimInboxMessages(k, { idle: true })).toEqual([]);
    expect(await c().listTasksWithPendingMessages()).toEqual([]);
  });

  it("falls steer back to followUp when the harness cannot steer (so it waits for idle)", async () => {
    const p = await mk("Parent");
    const k = await child(p, "Kid");
    harness.messaging = { ...ALL, steer: false };
    const sent = await send(p, k);
    expect(sent.message.requestedMode).toBe("steer");
    expect(sent.willWake).toBe(true);
    expect(await c().claimInboxMessages(k, { idle: false })).toEqual([]);
    const [claimed] = await c().claimInboxMessages(k, { idle: true });
    expect(claimed).toMatchObject({
      requestedMode: "steer",
      deliveredMode: "followUp",
    });
  });

  it("two concurrent claims never return the same message", async () => {
    const p = await mk("Parent");
    const k = await child(p, "Kid");
    for (let i = 0; i < 5; i += 1) await send(p, k, `m${i}`);
    const batches = await Promise.all(
      Array.from({ length: 4 }, () =>
        c().claimInboxMessages(k, { idle: true }),
      ),
    );
    const ids = batches.flat().map((m) => m.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it("only returns the asking task's messages", async () => {
    const p = await mk("Parent");
    const k1 = await child(p, "Kid 1");
    const k2 = await child(p, "Kid 2");
    await send(p, k1, "for one");
    expect(await c().claimInboxMessages(k2, { idle: true })).toEqual([]);
    expect(await c().claimInboxMessages(k1, { idle: true })).toHaveLength(1);
  });

  it("never returns a message for a Done target: marks it failed instead", async () => {
    const p = await mk("Parent");
    const k = await child(p, "Kid");
    const sent = await send(p, k);
    await c().moveTask(k, "done");
    expect(await c().claimInboxMessages(k, { idle: true })).toEqual([]);
    const [stored] = await c().listMessages({ taskId: k });
    expect(stored).toMatchObject({ id: sent.message.id, status: "failed" });
    expect(stored?.failureReason).toContain("is Done");
  });

  it("the wake pass fails messages for Done/deleted targets and lists only live candidates", async () => {
    const p = await mk("Parent");
    const k1 = await child(p, "Kid 1");
    const k2 = await child(p, "Kid 2");
    const k3 = await child(p, "Kid 3");
    await send(p, k1);
    await send(p, k2);
    await send(p, k3);
    await c().moveTask(k2, "done");
    await c().deleteTask(k3);
    expect(await c().listTasksWithPendingMessages()).toEqual([k1]);
    const statuses = Object.fromEntries(
      (await c().listMessages()).map((m) => [m.targetTaskId, m.status]),
    );
    expect(statuses).toEqual({
      [k1]: "pending",
      [k2]: "failed",
      [k3]: "failed",
    });
  });
});

describe("derived messaging states", () => {
  async function asked(): Promise<{ p: string; k: string; question: string }> {
    const p = await mk("Parent");
    const k = await child(p, "Kid");
    harness.setLive(p);
    harness.setLive(k);
    const sent = await send(k, p, "which db?");
    return { p, k, question: sent.message.id };
  }
  const stateOf = async (id: string) =>
    (await c().getMessagingStates()).find((s) => s.taskId === id);

  it("waiting on parent starts at the question (no deadline until delivered) and flags the parent", async () => {
    const { p, k, question } = await asked();
    expect((await stateOf(k))?.waitingOnParent).toEqual({
      messageId: question,
      question: "which db?",
    });
    expect((await stateOf(p))?.childQuestionsWaiting).toBe(1);
    await c().claimInboxMessages(p, { idle: true });
    const waiting = (await stateOf(k))?.waitingOnParent;
    expect(waiting?.deliveredAt).toBeDefined();
    expect(
      Date.parse(waiting?.expiresAt ?? "") -
        Date.parse(waiting?.deliveredAt ?? ""),
    ).toBe(30 * 60_000);
  });

  it("ends when the parent's reply is delivered", async () => {
    const { p, k } = await asked();
    await c().claimInboxMessages(p, { idle: true });
    await send(p, k, "use postgres");
    expect((await stateOf(k))?.waitingOnParent).toBeDefined(); // not delivered yet
    await c().claimInboxMessages(k, { idle: true });
    expect(await stateOf(k)).toBeUndefined();
    expect(await stateOf(p)).toBeUndefined();
  });

  it("ends when the user types into the child, the parent stops, or the parent is Done", async () => {
    const first = await asked();
    await c().recordUserInput(first.k);
    expect(await stateOf(first.k)).toBeUndefined();

    const second = await asked();
    harness.setNotLive(second.p);
    expect(await stateOf(second.k)).toBeUndefined();
    harness.setLive(second.p);
    expect((await stateOf(second.k))?.waitingOnParent).toBeDefined();
    await c().moveTask(second.p, "done");
    expect(await stateOf(second.k)).toBeUndefined();
  });

  it("times out 30 minutes (configurable) after delivery to the parent", async () => {
    const { p, k } = await asked();
    clock.jumpMinutes(120); // creation is long past, but the clock starts at delivery
    await c().claimInboxMessages(p, { idle: true });
    clock.jumpMinutes(29);
    expect((await stateOf(k))?.waitingOnParent).toBeDefined();
    clock.jumpMinutes(2);
    expect(await stateOf(k)).toBeUndefined();

    await boot({ messaging: { parentReplyTimeoutMinutes: 120 } });
    expect((await stateOf(k))?.waitingOnParent).toBeDefined();
  });

  it("counts approvals waiting per target", async () => {
    const a = await mk("A");
    const b = await mk("B");
    await send(a, b, "one");
    await send(a, b, "two");
    expect((await stateOf(b))?.approvalsWaiting).toBe(2);
    await c().rejectMessage(
      (await c().listPendingApprovals())[0]?.id as string,
    );
    expect((await stateOf(b))?.approvalsWaiting).toBe(1);
  });

  it("emits messages-changed with the affected tasks after every mutation", async () => {
    const a = await mk("A");
    const b = await mk("B");
    const seen: string[][] = [];
    const off = core.events.on("messages-changed", ({ taskIds }) =>
      seen.push([...taskIds].sort()),
    );
    const sent = await send(a, b);
    expect(seen.at(-1)).toEqual([a, b].sort());
    await c().approveMessage(sent.message.id);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const before = seen.length;
    await c().claimInboxMessages(b, { idle: true });
    expect(seen.length).toBe(before + 1);
    await c().claimInboxMessages(b, { idle: true }); // nothing claimed: no event
    expect(seen.length).toBe(before + 1);
    await c().recordUserInput(b);
    expect(seen.at(-1)).toContain(b);
    off();
  });
});

describe("findTasks", () => {
  it("reports run state and relation, hides Done by default", async () => {
    const p = await mk("Ship the login fix");
    const k = await child(p, "Login kid");
    const sib = await child(p, "Login sibling");
    const queued = await c().launchTask({
      relation: "child",
      fromTaskId: p,
      title: "Login queued",
      prompt: "x",
      repository: { none: true },
    });
    const done = await mk("Login archived");
    await c().moveTask(done, "done");
    harness.setLive(p, true);
    harness.setLive(k, false);

    const found = await c().findTasks("login", { fromTaskId: k });
    const byId = Object.fromEntries(found.map((r) => [r.id, r]));
    expect(Object.keys(byId).sort()).toEqual([p, k, sib, queued.id].sort());
    expect(byId[p]).toMatchObject({
      run: "working",
      relation: "parent",
      state: "dev",
      title: "Ship the login fix",
    });
    expect(byId[k]).toMatchObject({ run: "your-move", relation: "self" });
    expect(byId[sib]).toMatchObject({
      run: "not-running",
      relation: "sibling",
    });
    expect(byId[queued.id]).toMatchObject({
      run: "queued",
      relation: "sibling",
    });
    expect(
      (await c().findTasks("login", { fromTaskId: p })).find((r) => r.id === k)
        ?.relation,
    ).toBe("child");
    expect((await c().findTasks("archived")).length).toBe(0);
    expect(
      (await c().findTasks("archived", { includeDone: true })).map((r) => r.id),
    ).toEqual([done]);
    expect(await c().findTasks("login", { limit: 2 })).toHaveLength(2);
  });
});

describe("attachment pruning", () => {
  it("prunes attachment files 30 days after both ends are Done, keeping the record", async () => {
    const a = await mk("A");
    const b = await mk("B");
    const keep = await mk("Keep");
    const sent = await send(a, b, "pic", {
      attachments: [await file("p.png", "xx")],
    });
    const other = await send(a, keep, "pic2", {
      attachments: [await file("q.png", "yy")],
    });
    const path = sent.message.attachments[0]?.path as string;

    expect(await c().pruneMessageAttachments()).toBe(0);
    await c().moveTask(a, "done");
    await c().moveTask(b, "done");
    clock.jumpMinutes(29 * 24 * 60);
    expect(await c().pruneMessageAttachments()).toBe(0);
    clock.jumpMinutes(2 * 24 * 60);
    expect(await c().pruneMessageAttachments()).toBe(1);
    await expect(stat(path)).rejects.toThrow();
    const stored = await c().listMessages({ taskId: b });
    expect(stored[0]?.attachments[0]?.prunedAt).toBeDefined();
    await expect(c().readMessageAttachment(sent.message.id, 0)).rejects.toThrow(
      /pruned/,
    );
    // Idempotent, and the other message (its target still live) is untouched.
    expect(await c().pruneMessageAttachments()).toBe(0);
    expect(
      await readFile(other.message.attachments[0]?.path as string, "utf8"),
    ).toBe("yy");
  });

  it("prunes immediately-eligible messages whose tasks were deleted", async () => {
    const a = await mk("A");
    const b = await mk("B");
    await send(a, b, "pic", { attachments: [await file("p.png")] });
    await c().deleteTask(a);
    await c().deleteTask(b);
    expect(await c().pruneMessageAttachments()).toBe(1);
  });
});

describe("subscribeInbox", () => {
  it("rings the task's listener when a message becomes deliverable", async () => {
    const p = await mk("Parent");
    const k = await child(p, "Kid");
    let rung = 0;
    const off = c().subscribeInbox(k, () => {
      rung += 1;
    });
    try {
      await send(p, k);
      const deadline = Date.now() + 3000;
      while (rung === 0 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 20));
      expect(rung).toBeGreaterThan(0);
    } finally {
      off();
    }
  });
});

describe("wiring", () => {
  it("createCore's default harness reads presence from the state dir", async () => {
    const real = createCore({
      stateDir,
      clock,
      ids: { next: () => `real-${String(++counter).padStart(4, "0")}` },
      pullRequests: noGithub,
      versions: noGithub,
    });
    const p = (
      await real.commands.createTask({
        title: "P",
        initialPrompt: "",
        start: true,
      })
    ).id;
    await bindScratch(p);
    const k = (
      await real.commands.launchTask({
        relation: "child",
        fromTaskId: p,
        title: "K",
        prompt: "x",
        repository: { none: true },
      })
    ).id;
    await real.commands.claimPendingLaunches(5);
    await expect(
      real.commands.sendTaskMessage({
        from: from(k),
        targetTaskId: p,
        text: "q",
      }),
    ).rejects.toThrow(/parent task is not running/);
    // A live presence record (this process's pid, fresh heartbeat) makes the parent live.
    const presence = new SessionPresenceAccess(join(stateDir, "presence"));
    await presence.register({
      taskId: p,
      sessionPath: "/s",
      pid: process.pid,
      mode: "interactive",
      at: clock.now().toISOString(),
    });
    const sent = await real.commands.sendTaskMessage({
      from: from(k),
      targetTaskId: p,
      text: "q",
    });
    expect(sent.message.route).toBe("child-to-parent");
  });

  it("messaging commands throw a clear error on a manager built without message access", async () => {
    const bare = new CoreManager({} as unknown as CoreManagerDependencies);
    await expect(bare.findTasks("x")).rejects.toThrow(
      "messaging is not configured",
    );
    await expect(
      bare.sendTaskMessage({
        from: { kind: "harbormaster" },
        targetTaskId: "t",
        text: "x",
      }),
    ).rejects.toThrow("messaging is not configured");
    await expect(bare.claimInboxMessages("t", { idle: true })).rejects.toThrow(
      "messaging is not configured",
    );
    await expect(bare.listPendingApprovals()).rejects.toThrow(
      "messaging is not configured",
    );
    await expect(bare.getMessagingStates()).rejects.toThrow(
      "messaging is not configured",
    );
    expect(() => bare.subscribeInbox("t", () => {})).toThrow(
      "messaging is not configured",
    );
  });
});
