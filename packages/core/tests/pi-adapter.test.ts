import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionPresenceAccess } from "../src/access/session-presence-access.js";
import type { Clock } from "../src/contracts/services.js";
import { PiHarnessAdapter } from "../src/harness/pi-adapter.js";

class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
}

describe("PiHarnessAdapter", () => {
  describe("buildLaunchSpec", () => {
    it("runs pi in the workspace path with the task/state-dir markers", () => {
      const adapter = new PiHarnessAdapter({ stateDir: "/state" });
      const spec = adapter.buildLaunchSpec({
        taskId: "task-1",
        workspacePath: "/work/task-1",
        stateDir: "/state",
      });

      expect(spec.command).toBe("pi");
      expect(spec.cwd).toBe("/work/task-1");
      expect(spec.args).toEqual([]);
      expect(spec.env.HARBORMASTER_TASK_ID).toBe("task-1");
      expect(spec.env.HARBORMASTER_STATE_DIR).toBe("/state");
      expect(spec.env.HARBORMASTER).toBe("1");
    });

    it("passes an initial prompt through as an argument", () => {
      const adapter = new PiHarnessAdapter({ stateDir: "/state" });
      const spec = adapter.buildLaunchSpec({
        taskId: "task-1",
        workspacePath: "/work/task-1",
        stateDir: "/state",
        initialPrompt: "Fix the thing",
      });
      expect(spec.args).toEqual(["Fix the thing"]);
    });
  });

  describe("presence", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "harbormaster-pi-adapter-test-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("reports not-live with no registered record", async () => {
      const adapter = new PiHarnessAdapter({ stateDir: dir });
      const status = await adapter.presence("task-1");
      expect(status).toEqual({ live: false, runningTurn: false });
    });

    it("reports live with a fresh heartbeat", async () => {
      const presence = new SessionPresenceAccess(join(dir, "presence"));
      await presence.register({
        taskId: "task-1",
        sessionPath: "/sessions/task-1.jsonl",
        pid: 123,
        mode: "interactive",
        at: new Date().toISOString(),
      });

      const adapter = new PiHarnessAdapter({ presence });
      const status = await adapter.presence("task-1");
      expect(status.live).toBe(true);
      expect(status.record?.taskId).toBe("task-1");
    });

    it("reports not-live once the heartbeat is stale, using the injected clock", async () => {
      const presence = new SessionPresenceAccess(join(dir, "presence"));
      const start = new Date("2026-01-01T00:00:00.000Z");
      await presence.register({
        taskId: "task-1",
        sessionPath: "/sessions/task-1.jsonl",
        pid: 123,
        mode: "interactive",
        at: start.toISOString(),
      });

      const later = new FixedClock(new Date(start.getTime() + 4 * 60_000));
      const adapter = new PiHarnessAdapter({ presence, clock: later });
      const status = await adapter.presence("task-1");
      expect(status.live).toBe(false);
      expect(status.runningTurn).toBe(false);
    });

    it("reflects runningTurn when a turn is active and live", async () => {
      const presence = new SessionPresenceAccess(join(dir, "presence"));
      await presence.register({
        taskId: "task-1",
        sessionPath: "/sessions/task-1.jsonl",
        pid: 123,
        mode: "interactive",
        at: new Date().toISOString(),
      });
      await presence.setTurnActive(
        "task-1",
        123,
        true,
        new Date().toISOString(),
      );

      const adapter = new PiHarnessAdapter({ presence });
      const status = await adapter.presence("task-1");
      expect(status.live).toBe(true);
      expect(status.runningTurn).toBe(true);
    });

    it("reports an ended record as not-live", async () => {
      const presence = new SessionPresenceAccess(join(dir, "presence"));
      await presence.register({
        taskId: "task-1",
        sessionPath: "/sessions/task-1.jsonl",
        pid: 123,
        mode: "headless",
        at: new Date().toISOString(),
      });
      await presence.reportOutcome(
        "task-1",
        123,
        "done",
        undefined,
        new Date().toISOString(),
      );

      const adapter = new PiHarnessAdapter({ presence });
      const status = await adapter.presence("task-1");
      expect(status.live).toBe(false);
      expect(status.record?.ended?.status).toBe("done");
    });
  });

  describe("declared-but-unimplemented methods", () => {
    it("stopHeadless throws a wave-4 error", async () => {
      const adapter = new PiHarnessAdapter({ stateDir: "/state" });
      await expect(adapter.stopHeadless("task-1")).rejects.toThrow(/wave 4/);
    });

    it("attach throws a wave-4 error", async () => {
      const adapter = new PiHarnessAdapter({ stateDir: "/state" });
      await expect(adapter.attach("task-1")).rejects.toThrow(/wave 4/);
    });
  });
});
