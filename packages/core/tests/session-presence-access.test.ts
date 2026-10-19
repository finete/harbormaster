import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionPresenceAccess } from "../src/access/session-presence-access.js";

describe("SessionPresenceAccess", () => {
  let dir: string;
  let access: SessionPresenceAccess;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harbormaster-core-test-"));
    access = new SessionPresenceAccess(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips register/read/list", async () => {
    await access.register({
      taskId: "task-1",
      sessionPath: "/sessions/task-1.jsonl",
      pid: 123,
      mode: "interactive",
      at: "2026-01-01T00:00:00.000Z",
    });

    const record = await access.read("task-1");
    expect(record?.taskId).toBe("task-1");
    expect(record?.pid).toBe(123);
    expect(record?.runningTurn).toBe(false);

    expect(await access.list()).toEqual([record]);
  });

  it("ignores mutations from a superseded pid", async () => {
    await access.register({
      taskId: "task-1",
      sessionPath: "/s.jsonl",
      pid: 1,
      mode: "headless",
      at: "t0",
    });
    await access.heartbeat("task-1", 999, "t1");

    const record = await access.read("task-1");
    expect(record?.heartbeatAt).toBe("t0");
  });

  it("end on an interactive session removes the record", async () => {
    await access.register({
      taskId: "task-1",
      sessionPath: "/s.jsonl",
      pid: 1,
      mode: "interactive",
      at: "t0",
    });
    await access.end("task-1", 1, "t1");

    expect(await access.read("task-1")).toBeUndefined();
  });

  it("end on an interactive session keeps a reported outcome as the ended marker", async () => {
    await access.register({
      taskId: "task-1",
      sessionPath: "/s.jsonl",
      pid: 1,
      mode: "interactive",
      at: "t0",
    });
    await access.reportOutcome("task-1", 1, "blocked", "needs creds", "t1");
    await access.end("task-1", 1, "t2");

    const record = await access.read("task-1");
    expect(record?.outcome).toBeUndefined();
    expect(record?.ended).toEqual({
      status: "blocked",
      note: "needs creds",
      at: "t1",
    });
  });

  it("end on a headless session leaves an unreported marker", async () => {
    await access.register({
      taskId: "task-1",
      sessionPath: "/s.jsonl",
      pid: 1,
      mode: "headless",
      at: "t0",
    });
    await access.end("task-1", 1, "t1");

    const record = await access.read("task-1");
    expect(record?.ended).toEqual({ status: "unreported", at: "t1" });
  });

  it("reportOutcome records outcome without ending the attachment", async () => {
    await access.register({
      taskId: "task-1",
      sessionPath: "/s.jsonl",
      pid: 1,
      mode: "headless",
      at: "t0",
    });
    await access.reportOutcome("task-1", 1, "done", "all good", "t1");

    const record = await access.read("task-1");
    expect(record?.outcome).toEqual({
      status: "done",
      note: "all good",
      at: "t1",
    });
    expect(record?.ended).toBeUndefined();
    expect(record?.heartbeatAt).toBe("t1");
  });

  it("a reported outcome is cleared when the next turn starts", async () => {
    await access.register({
      taskId: "task-1",
      sessionPath: "/s.jsonl",
      pid: 1,
      mode: "interactive",
      at: "t0",
    });
    await access.reportOutcome("task-1", 1, "blocked", "need input", "t1");
    expect((await access.read("task-1"))?.outcome).toBeDefined();

    await access.setTurnActive("task-1", 1, true, "t2");

    const record = await access.read("task-1");
    expect(record?.outcome).toBeUndefined();
    expect(record?.runningTurn).toBe(true);
  });

  it("setTurnActive(false) never clears a reported outcome (the turn just ended)", async () => {
    await access.register({
      taskId: "task-1",
      sessionPath: "/s.jsonl",
      pid: 1,
      mode: "interactive",
      at: "t0",
    });
    await access.reportOutcome("task-1", 1, "done", undefined, "t1");
    await access.setTurnActive("task-1", 1, false, "t2");

    const record = await access.read("task-1");
    expect(record?.outcome?.status).toBe("done");
    expect(record?.runningTurn).toBe(false);
  });

  it("clear removes a record outright", async () => {
    await access.register({
      taskId: "task-1",
      sessionPath: "/s.jsonl",
      pid: 1,
      mode: "headless",
      at: "t0",
    });
    await access.clear("task-1");

    expect(await access.read("task-1")).toBeUndefined();
  });
});
