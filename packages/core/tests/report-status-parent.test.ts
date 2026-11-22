// `report_status` from a task with a parent also tells the parent (see
// /docs/task-messaging.md "Child reports"): the same child-to-parent send as
// `send_to_task` (route checks, inbox, loop cap), as a report that never
// makes the child "wait on parent". Runs through `createCore` on the real
// default harness, so the outcome really lands on a live presence record.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  PullRequestAccess,
  VersionAccess,
} from "../src/contracts/github.js";
import type { Clock } from "../src/contracts/services.js";
import { type Core, createCore, SessionPresenceAccess } from "../src/index.js";

class TestClock implements Clock {
  private ms = Date.parse("2026-01-01T00:00:00.000Z");
  now(): Date {
    const current = new Date(this.ms);
    this.ms += 1000;
    return current;
  }
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
let presence: SessionPresenceAccess;
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
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harbormaster-report-parent-"));
  stateDir = join(root, "state");
  await mkdir(stateDir, { recursive: true });
  clock = new TestClock();
  counter = 0;
  presence = new SessionPresenceAccess(join(stateDir, "presence"));
  await boot();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const c = () => core.commands;

/** A live session for the task (this process's pid, fresh heartbeat). */
async function goLive(taskId: string): Promise<void> {
  await presence.register({
    taskId,
    sessionPath: `/s/${taskId}`,
    pid: process.pid,
    mode: "interactive",
    at: clock.now().toISOString(),
  });
}

async function parentAndChild(): Promise<{ p: string; k: string }> {
  const p = (
    await c().createTask({ title: "Parent", initialPrompt: "", start: true })
  ).id;
  const k = (
    await c().launchTask({
      relation: "child",
      fromTaskId: p,
      title: "Kid",
      prompt: "do it",
      repository: { none: true },
    })
  ).id;
  await c().claimPendingLaunches(5);
  await goLive(p);
  await goLive(k);
  return { p, k };
}

const stateOf = async (id: string) =>
  (await c().getMessagingStates()).find((s) => s.taskId === id);
const outcomeOf = async (id: string) =>
  (await c().getPresence(id)).record?.outcome;

describe("report_status tells the parent", () => {
  it("delivers the verdict and note as a follow-up report, and the outcome is recorded", async () => {
    const { p, k } = await parentAndChild();
    const result = await c().reportTaskOutcome(k, {
      status: "done",
      note: "PR #12 opened",
    });
    expect(result.parentNotice).toEqual({ parentTaskId: p, notified: true });
    expect(await outcomeOf(k)).toMatchObject({
      status: "done",
      note: "PR #12 opened",
    });

    const [message, ...rest] = await c().listMessages({ taskId: p });
    expect(rest).toEqual([]);
    expect(message).toMatchObject({
      route: "child-to-parent",
      sender: { kind: "task", taskId: k },
      senderLabel: "Kid",
      targetTaskId: p,
      requestedMode: "followUp",
      status: "pending",
    });
    expect(message?.text).toContain(
      `Your child task "Kid" (${k}) reported done: PR #12 opened`,
    );
    expect(message?.text).toMatch(/no reply is needed/i);

    // It reaches the parent's inbox like any other message.
    const claimed = await c().claimInboxMessages(p, { idle: true });
    expect(claimed.map((m) => m.id)).toEqual([message?.id]);
  });

  it("names a blocked report and copes with no note", async () => {
    const { p, k } = await parentAndChild();
    await c().reportTaskOutcome(k, { status: "blocked" });
    const [message] = await c().listMessages({ taskId: p });
    expect(message?.text).toContain(`(${k}) reported blocked.`);
  });

  it("is a report, not a question: the child does not wait on its parent", async () => {
    const { p, k } = await parentAndChild();
    await c().reportTaskOutcome(k, { status: "done", note: "all set" });
    const [message] = await c().listMessages({ taskId: p });
    expect(message?.expectsReply).toBeUndefined();
    expect(await stateOf(k)).toBeUndefined();
    expect(await stateOf(p)).toBeUndefined();
  });

  it("counts toward the loop cap, so report → reply → report cannot loop forever", async () => {
    await boot({ messaging: { loopCap: 2 } });
    const { p, k } = await parentAndChild();
    const first = await c().reportTaskOutcome(k, { status: "done" });
    expect(first.parentNotice?.notified).toBe(true);
    // The parent's reply is the second message of the pair.
    await c().sendTaskMessage({
      from: { kind: "task", taskId: p },
      targetTaskId: k,
      text: "thanks, one more thing",
    });
    const capped = await c().reportTaskOutcome(k, {
      status: "done",
      note: "again",
    });
    expect(capped.parentNotice).toMatchObject({
      parentTaskId: p,
      notified: false,
    });
    expect(capped.parentNotice?.reason).toMatch(/Message cap reached/);
    expect(await outcomeOf(k)).toMatchObject({ status: "done", note: "again" });
    expect(
      (await c().listMessages({ taskId: p })).filter(
        (m) => m.targetTaskId === p,
      ),
    ).toHaveLength(1);
    expect((await stateOf(k))?.loopCapReached).toMatchObject({ cap: 2 });

    // The user typing resets the cap, so the next report goes through.
    await c().recordUserInput(k);
    const after = await c().reportTaskOutcome(k, { status: "done" });
    expect(after.parentNotice?.notified).toBe(true);
  });

  it("a Done parent is not notified, and the report still succeeds", async () => {
    const { p, k } = await parentAndChild();
    await c().moveTask(p, "done");
    const result = await c().reportTaskOutcome(k, {
      status: "done",
      note: "finished",
    });
    expect(result.parentNotice).toMatchObject({
      parentTaskId: p,
      notified: false,
    });
    expect(result.parentNotice?.reason).toMatch(/is Done/);
    expect(await outcomeOf(k)).toMatchObject({ status: "done" });
    expect(await c().listMessages()).toEqual([]);
  });

  it("a parent that is not running is not notified, and the report still succeeds", async () => {
    const { p, k } = await parentAndChild();
    await presence.end(p, process.pid, clock.now().toISOString());
    const result = await c().reportTaskOutcome(k, { status: "blocked" });
    expect(result.parentNotice).toMatchObject({
      parentTaskId: p,
      notified: false,
    });
    expect(result.parentNotice?.reason).toMatch(/parent task is not running/);
    expect(await outcomeOf(k)).toMatchObject({ status: "blocked" });
    expect(await c().listMessages()).toEqual([]);
  });

  it("a task without a parent sends nothing and returns no notice", async () => {
    const solo = (
      await c().createTask({ title: "Solo", initialPrompt: "", start: true })
    ).id;
    await goLive(solo);
    const result = await c().reportTaskOutcome(solo, {
      status: "done",
      note: "ok",
    });
    expect(result).toEqual({});
    expect(await outcomeOf(solo)).toMatchObject({ status: "done" });
    expect(await c().listMessages()).toEqual([]);
  });

  it("still rejects a report from a session that is not live", async () => {
    const { k } = await parentAndChild();
    await presence.end(k, process.pid, clock.now().toISOString());
    await expect(c().reportTaskOutcome(k, { status: "done" })).rejects.toThrow(
      /not linked to a live Harbormaster task/,
    );
  });
});
