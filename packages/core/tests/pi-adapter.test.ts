import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionPresenceAccess } from "../src/access/session-presence-access.js";
import type { Clock } from "../src/contracts/services.js";
import { PiHarnessAdapter, piSessionArgs } from "../src/harness/pi-adapter.js";

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
      expect(spec.args).toEqual(["--", "Fix the thing"]);
    });

    it("defuses Pi's own argv parsing for flag-like, @-prefixed, multiline, and blank prompts", () => {
      const adapter = new PiHarnessAdapter({ stateDir: "/state" });
      const build = (initialPrompt: string) =>
        adapter.buildLaunchSpec({
          taskId: "task-1",
          workspacePath: "/work/task-1",
          stateDir: "/state",
          initialPrompt,
        }).args;
      expect(build("--help me")).toEqual(["--", "--help me"]);
      expect(build("@src/a.ts explain")).toEqual(["--", " @src/a.ts explain"]);
      expect(build("line one\nline 'two' \"$HOME\"")).toEqual([
        "--",
        "line one\nline 'two' \"$HOME\"",
      ]);
      expect(build("   ")).toEqual([]);
    });

    it("maps each session launch mode onto Pi's session flags, before the prompt", () => {
      const adapter = new PiHarnessAdapter({ stateDir: "/state" });
      const build = (
        session: Parameters<typeof adapter.buildLaunchSpec>[0]["session"],
        initialPrompt?: string,
      ) =>
        adapter.buildLaunchSpec({
          taskId: "task-1",
          workspacePath: "/work/task-1",
          stateDir: "/state",
          ...(session ? { session } : {}),
          ...(initialPrompt ? { initialPrompt } : {}),
        }).args;

      expect(build({ mode: "new", sessionId: "s-1" }, "Do it")).toEqual([
        "--session-id",
        "s-1",
        "--",
        "Do it",
      ]);
      // A model override is mapped to `--model`, only on a brand-new session.
      expect(
        build(
          {
            mode: "new",
            sessionId: "s-1",
            model: "anthropic/claude-opus:thinking",
          },
          "Do it",
        ),
      ).toEqual([
        "--session-id",
        "s-1",
        "--model",
        "anthropic/claude-opus:thinking",
        "--",
        "Do it",
      ]);
      expect(build({ mode: "resume", sessionId: "s-1" })).toEqual([
        "--session-id",
        "s-1",
      ]);
      // A known file wins over the id: Pi opens it regardless of cwd.
      expect(
        build({
          mode: "resume",
          sessionId: "s-1",
          sessionPath: "/sessions/a_s-1.jsonl",
        }),
      ).toEqual(["--session", "/sessions/a_s-1.jsonl"]);
      expect(
        build(
          { mode: "fork", sessionId: "s-2", forkFrom: "/sessions/a_s-1.jsonl" },
          "Next step",
        ),
      ).toEqual([
        "--fork",
        "/sessions/a_s-1.jsonl",
        "--session-id",
        "s-2",
        "--",
        "Next step",
      ]);
      expect(build({ mode: "continue" })).toEqual(["--continue"]);
      expect(build(undefined)).toEqual([]);
    });

    it("never combines flags Pi rejects together (--session/--continue with --session-id, --fork with --session/--continue)", () => {
      const sessions = [
        { mode: "new", sessionId: "s" },
        { mode: "resume", sessionId: "s" },
        { mode: "resume", sessionId: "s", sessionPath: "/p.jsonl" },
        { mode: "fork", sessionId: "s", forkFrom: "/p.jsonl" },
        { mode: "continue" },
      ] as const;
      for (const session of sessions) {
        const args = piSessionArgs(session);
        const has = (flag: string) => args.includes(flag);
        expect(
          has("--session-id") && (has("--session") || has("--continue")),
        ).toBe(false);
        expect(has("--fork") && (has("--session") || has("--continue"))).toBe(
          false,
        );
      }
    });

    it("keeps session args when HARBORMASTER_PI_COMMAND overrides the command", () => {
      const previous = process.env.HARBORMASTER_PI_COMMAND;
      process.env.HARBORMASTER_PI_COMMAND = "/tmp/fake-pi";
      try {
        const spec = new PiHarnessAdapter({
          stateDir: "/state",
        }).buildLaunchSpec({
          taskId: "task-1",
          workspacePath: "/work/task-1",
          stateDir: "/state",
          session: { mode: "resume", sessionId: "s-1" },
        });
        expect(spec.command).toBe("/tmp/fake-pi");
        expect(spec.args).toEqual(["--session-id", "s-1"]);
      } finally {
        if (previous === undefined) delete process.env.HARBORMASTER_PI_COMMAND;
        else process.env.HARBORMASTER_PI_COMMAND = previous;
      }
    });

    it("honors HARBORMASTER_PI_COMMAND as a command override (e2e fake binaries)", () => {
      const previous = process.env.HARBORMASTER_PI_COMMAND;
      process.env.HARBORMASTER_PI_COMMAND = "/tmp/fake-pi";
      try {
        const adapter = new PiHarnessAdapter({ stateDir: "/state" });
        const spec = adapter.buildLaunchSpec({
          taskId: "task-1",
          workspacePath: "/work/task-1",
          stateDir: "/state",
        });
        expect(spec.command).toBe("/tmp/fake-pi");
      } finally {
        if (previous === undefined) delete process.env.HARBORMASTER_PI_COMMAND;
        else process.env.HARBORMASTER_PI_COMMAND = previous;
      }
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
        // The default pid probe (`process.kill(pid, 0)`) runs unless a test
        // overrides `isAlive`; use this process's own real pid so it reads
        // as alive.
        pid: process.pid,
        mode: "interactive",
        at: new Date().toISOString(),
      });

      const adapter = new PiHarnessAdapter({ presence });
      const status = await adapter.presence("task-1");
      expect(status.live).toBe(true);
      expect(status.record?.taskId).toBe("task-1");
    });

    it("reports not-live when the recorded pid is dead, even with a fresh heartbeat (default pid probe)", async () => {
      const presence = new SessionPresenceAccess(join(dir, "presence"));
      // A pid astronomically unlikely to be in use; the default
      // `process.kill(pid, 0)` probe reads it as dead (ESRCH).
      const deadPid = 2_147_483_647;
      await presence.register({
        taskId: "task-1",
        sessionPath: "/sessions/task-1.jsonl",
        pid: deadPid,
        mode: "interactive",
        at: new Date().toISOString(),
      });

      const adapter = new PiHarnessAdapter({ presence });
      const status = await adapter.presence("task-1");
      expect(status.live).toBe(false);
      expect(status.runningTurn).toBe(false);
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
        pid: process.pid,
        mode: "interactive",
        at: new Date().toISOString(),
      });
      await presence.setTurnActive(
        "task-1",
        process.pid,
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
      await presence.end("task-1", 123, new Date().toISOString());

      const adapter = new PiHarnessAdapter({ presence });
      const status = await adapter.presence("task-1");
      expect(status.live).toBe(false);
      expect(status.record?.ended?.status).toBe("unreported");
    });

    it("a reported outcome stays live (`ended` keeps meaning the process is gone)", async () => {
      const presence = new SessionPresenceAccess(join(dir, "presence"));
      await presence.register({
        taskId: "task-1",
        sessionPath: "/sessions/task-1.jsonl",
        pid: process.pid,
        mode: "headless",
        at: new Date().toISOString(),
      });
      await presence.reportOutcome(
        "task-1",
        process.pid,
        "done",
        undefined,
        new Date().toISOString(),
      );

      const adapter = new PiHarnessAdapter({ presence });
      const status = await adapter.presence("task-1");
      expect(status.live).toBe(true);
      expect(status.record?.outcome?.status).toBe("done");
      expect(status.record?.ended).toBeUndefined();
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
