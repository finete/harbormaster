import type { PresenceAccess, RegisterPresenceInput } from "@harbormaster/core";
import { describe, expect, it } from "vitest";
import { PresenceReporter } from "../src/presence-reporter.js";

interface Call {
  method: string;
  args: unknown[];
}

class FakePresenceAccess implements PresenceAccess {
  calls: Call[] = [];
  registrations: RegisterPresenceInput[] = [];

  async register(input: RegisterPresenceInput): Promise<void> {
    this.calls.push({ method: "register", args: [input] });
    this.registrations.push(input);
  }
  async heartbeat(taskId: string, pid: number, at: string): Promise<void> {
    this.calls.push({ method: "heartbeat", args: [taskId, pid, at] });
  }
  async setTurnActive(
    taskId: string,
    pid: number,
    running: boolean,
    at: string,
  ): Promise<void> {
    this.calls.push({
      method: "setTurnActive",
      args: [taskId, pid, running, at],
    });
  }
  async reportOutcome(): Promise<void> {
    this.calls.push({ method: "reportOutcome", args: [] });
  }
  async end(taskId: string, pid: number, at: string): Promise<void> {
    this.calls.push({ method: "end", args: [taskId, pid, at] });
  }
  async read(): Promise<undefined> {
    return undefined;
  }
  async list(): Promise<[]> {
    return [];
  }
  async acknowledge(): Promise<void> {}
  async markNotified(): Promise<void> {}
  async clear(): Promise<void> {}
}

describe("PresenceReporter", () => {
  it("registers presence on start and is attached afterward", async () => {
    const presence = new FakePresenceAccess();
    const reporter = new PresenceReporter({
      presence,
      pid: 123,
      now: () => "t0",
    });

    await reporter.start({
      taskId: "task-1",
      sessionPath: "/sessions/task-1.jsonl",
      mode: "interactive",
    });

    expect(reporter.isAttached).toBe(true);
    expect(presence.registrations).toEqual([
      {
        taskId: "task-1",
        sessionPath: "/sessions/task-1.jsonl",
        pid: 123,
        mode: "interactive",
        at: "t0",
      },
    ]);
  });

  it("ends the prior attachment before registering a new one on re-start", async () => {
    const presence = new FakePresenceAccess();
    const reporter = new PresenceReporter({
      presence,
      pid: 123,
      now: () => "t0",
    });

    await reporter.start({
      taskId: "task-1",
      sessionPath: "/sessions/task-1.jsonl",
      mode: "interactive",
    });
    await reporter.start({
      taskId: "task-2",
      sessionPath: "/sessions/task-2.jsonl",
      mode: "headless",
    });

    const methods = presence.calls.map((c) => c.method);
    // First start: no prior attachment, so only register. Second start: end then register.
    expect(methods).toEqual(["register", "end", "register"]);
    expect(presence.calls[1]?.args).toEqual(["task-1", 123, "t0"]);
  });

  it("heartbeat is a no-op when nothing is attached", async () => {
    const presence = new FakePresenceAccess();
    const reporter = new PresenceReporter({
      presence,
      pid: 123,
      now: () => "t0",
    });

    await reporter.heartbeat();

    expect(presence.calls).toEqual([]);
  });

  it("heartbeats the current attachment", async () => {
    const presence = new FakePresenceAccess();
    const reporter = new PresenceReporter({
      presence,
      pid: 123,
      now: () => "t1",
    });

    await reporter.start({
      taskId: "task-1",
      sessionPath: "/s.jsonl",
      mode: "interactive",
    });
    await reporter.heartbeat();

    expect(presence.calls.map((c) => c.method)).toEqual([
      "register",
      "heartbeat",
    ]);
    expect(presence.calls[1]?.args).toEqual(["task-1", 123, "t1"]);
  });

  it("setTurnActive is a no-op on presence when nothing is attached, but remembers the intent", async () => {
    const presence = new FakePresenceAccess();
    const reporter = new PresenceReporter({
      presence,
      pid: 123,
      now: () => "t0",
    });

    await reporter.setTurnActive(true);
    expect(presence.calls).toEqual([]);

    await reporter.start({
      taskId: "task-1",
      sessionPath: "/s.jsonl",
      mode: "interactive",
    });

    // Registration itself re-applies the remembered turn state.
    const turnCalls = presence.calls.filter(
      (c) => c.method === "setTurnActive",
    );
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0]?.args).toEqual(["task-1", 123, true, "t0"]);
  });

  it("setTurnActive after attachment records the boundary immediately", async () => {
    const presence = new FakePresenceAccess();
    const reporter = new PresenceReporter({
      presence,
      pid: 123,
      now: () => "t2",
    });

    await reporter.start({
      taskId: "task-1",
      sessionPath: "/s.jsonl",
      mode: "interactive",
    });
    await reporter.setTurnActive(true);
    await reporter.setTurnActive(false);

    const turnCalls = presence.calls.filter(
      (c) => c.method === "setTurnActive",
    );
    expect(turnCalls.map((c) => c.args)).toEqual([
      ["task-1", 123, true, "t2"],
      ["task-1", 123, false, "t2"],
    ]);
  });

  it("end clears the attachment and is idempotent", async () => {
    const presence = new FakePresenceAccess();
    const reporter = new PresenceReporter({
      presence,
      pid: 123,
      now: () => "t0",
    });

    await reporter.start({
      taskId: "task-1",
      sessionPath: "/s.jsonl",
      mode: "interactive",
    });
    await reporter.end();
    await reporter.end();

    expect(reporter.isAttached).toBe(false);
    const endCalls = presence.calls.filter((c) => c.method === "end");
    expect(endCalls).toHaveLength(1);
  });
});
