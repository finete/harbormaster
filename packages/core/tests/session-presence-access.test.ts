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
