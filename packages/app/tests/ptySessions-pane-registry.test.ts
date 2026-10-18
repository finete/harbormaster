// Pane-pid registry bookkeeping (see /AGENTS.md's outside-observation
// corroboration work): createSession registers a task's primary pane only
// when it actually runs a harness spec, disposeSession/process-exit both
// clear it, and a non-primary/no-taskId/shell-fallback session is never
// registered at all. Spawns real (tiny, short-lived) `/bin/sh` processes via
// node-pty "- no mocks, this is the same spawn path the main process uses.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSession,
  disposeSession,
  lookupPanePid,
} from "../src/main/ptySessions";

/** A `LaunchSpecLike` whose command definitely exists: a no-op `true` shim via `/bin/sh -c`. */
function realSpec(): {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
} {
  return { command: "/bin/sh", args: [], cwd: process.cwd(), env: {} };
}

/** A `LaunchSpecLike` whose command can never be found on PATH, forcing a shell fallback. */
function missingSpec(): {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
} {
  return {
    command: `/definitely/not/a/real/binary-${randomUUID()}`,
    args: [],
    cwd: process.cwd(),
    env: {},
  };
}

const openSessionIds: string[] = [];

function trackedCreateSession(
  ...args: Parameters<typeof createSession>
): ReturnType<typeof createSession> {
  const result = createSession(...args);
  openSessionIds.push(result.id);
  return result;
}

afterEach(() => {
  while (openSessionIds.length > 0) {
    const id = openSessionIds.pop();
    if (id) disposeSession(id);
  }
});

describe("ptySessions pane-pid registry", () => {
  it("registers a primary session's real pid under its taskId", () => {
    const taskId = `task-${randomUUID()}`;
    const { pid } = trackedCreateSession(
      80,
      24,
      { onData: () => {}, onExit: () => {} },
      { taskId, primary: true, spec: realSpec() },
    );
    expect(lookupPanePid(taskId)).toEqual({ pid, alive: true });
  });

  it("never registers a non-primary session, even with a taskId", () => {
    const taskId = `task-${randomUUID()}`;
    trackedCreateSession(
      80,
      24,
      { onData: () => {}, onExit: () => {} },
      { taskId, primary: false, spec: realSpec() },
    );
    expect(lookupPanePid(taskId)).toBeUndefined();
  });

  it("never registers a primary session without a taskId", () => {
    trackedCreateSession(
      80,
      24,
      { onData: () => {}, onExit: () => {} },
      { primary: true, spec: realSpec() },
    );
    // Nothing to look up without a taskId; this just proves no crash and no
    // leak onto some other task's entry.
    expect(lookupPanePid("")).toBeUndefined();
  });

  it("never registers a primary session that fell back to a plain shell (missing harness command)", () => {
    const taskId = `task-${randomUUID()}`;
    const { fellBackToShell } = trackedCreateSession(
      80,
      24,
      { onData: () => {}, onExit: () => {} },
      { taskId, primary: true, spec: missingSpec() },
    );
    expect(fellBackToShell).toBe(true);
    expect(lookupPanePid(taskId)).toBeUndefined();
  });

  it("clears the registry entry on disposeSession", () => {
    const taskId = `task-${randomUUID()}`;
    const { id } = trackedCreateSession(
      80,
      24,
      { onData: () => {}, onExit: () => {} },
      { taskId, primary: true, spec: realSpec() },
    );
    expect(lookupPanePid(taskId)).toBeDefined();
    disposeSession(id);
    expect(lookupPanePid(taskId)).toBeUndefined();
  });

  it("clears the registry entry the instant the process exits on its own, ahead of any disposeSession call", async () => {
    const taskId = `task-${randomUUID()}`;
    let resolveExit: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const { id } = trackedCreateSession(
      80,
      24,
      {
        onData: () => {},
        onExit: () => {
          // By the time our own onExit callback runs, the exit subscription
          // inside ptySessions (which runs first) must have already
          // cleared the registry.
          expect(lookupPanePid(taskId)).toBeUndefined();
          resolveExit?.();
        },
      },
      {
        taskId,
        primary: true,
        spec: { ...realSpec(), args: ["-c", "exit 0"] },
      },
    );
    expect(lookupPanePid(taskId)).toBeDefined();
    await exited;
    // Already exited; disposeSession afterward is a harmless no-op for the
    // registry (nothing left to clear).
    disposeSession(id);
  });

  it("a second primary session for the same task replaces the first one's registry entry", () => {
    const taskId = `task-${randomUUID()}`;
    const first = trackedCreateSession(
      80,
      24,
      { onData: () => {}, onExit: () => {} },
      { taskId, primary: true, spec: realSpec() },
    );
    const second = trackedCreateSession(
      80,
      24,
      { onData: () => {}, onExit: () => {} },
      { taskId, primary: true, spec: realSpec() },
    );
    expect(lookupPanePid(taskId)).toEqual({ pid: second.pid, alive: true });
    // Disposing the superseded first session must not clear the second
    // session's still-current registry entry.
    disposeSession(first.id);
    expect(lookupPanePid(taskId)).toEqual({ pid: second.pid, alive: true });
  });
});
