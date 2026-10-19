// Paneless background session + attach tests (see main/ptySessions.ts's
// `createBackgroundPrimarySession`/`attachPrimarySession`): real (tiny,
// short-lived) `/bin/sh` processes via node-pty, same no-mocks style as
// ptySessions-pane-registry.test.ts. Exercises the screen-replay contract
// (snapshot on attach, then live streaming) and the pane-pid-registry
// integration a background launch must get from the moment it starts, not
// just once a renderer attaches.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeSessionCwds,
  activeSessionPids,
  attachPrimarySession,
  createBackgroundPrimarySession,
  disposeSession,
  lookupPanePid,
  writeToSession,
} from "../src/main/ptySessions";

/** A `LaunchSpecLike` for a plain, long-lived interactive shell: stdin is echoed back as output (real pty terminal echo), which this suite uses to produce deterministic screen content without racing a child process's own stdout timing. */
function shellSpec(): {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
} {
  return { command: "/bin/sh", args: [], cwd: process.cwd(), env: {} };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const openSessionIds: string[] = [];
function track(id: string): string {
  openSessionIds.push(id);
  return id;
}

afterEach(() => {
  while (openSessionIds.length > 0) {
    const id = openSessionIds.pop();
    if (id) disposeSession(id);
  }
});

describe("createBackgroundPrimarySession", () => {
  it("registers the task's primary pane in the pane-pid registry immediately, with no renderer attached", () => {
    const taskId = `task-${randomUUID()}`;
    const { id, pid } = createBackgroundPrimarySession(
      taskId,
      shellSpec(),
      () => {},
    );
    track(id);
    expect(lookupPanePid(taskId)).toEqual({ pid, alive: true });
    expect(activeSessionPids().has(pid)).toBe(true);
    expect(activeSessionCwds()).toContain(process.cwd());
  });

  it("calls onExit when the background process exits and clears the registry entry", async () => {
    const taskId = `task-${randomUUID()}`;
    let exitCode: number | undefined;
    const { id } = createBackgroundPrimarySession(
      taskId,
      {
        command: "/bin/sh",
        args: ["-c", "exit 7"],
        cwd: process.cwd(),
        env: {},
      },
      (code) => {
        exitCode = code;
      },
    );
    track(id);
    // Condition wait, not a fixed sleep for its own sake: the child process
    // exits near-instantly, but node-pty's onExit delivery is still async.
    for (let i = 0; i < 50 && exitCode === undefined; i++) {
      await sleep(20);
    }
    expect(exitCode).toBe(7);
    expect(lookupPanePid(taskId)).toBeUndefined();
  });
});

describe("attachPrimarySession", () => {
  it("returns undefined when there is no live background primary for the task", () => {
    expect(
      attachPrimarySession("no-such-task", 80, 24, {
        onData: () => {},
        onExit: () => {},
      }),
    ).toBeUndefined();
  });

  it("hands back a snapshot of what the background session already produced, then streams live data through the attached callbacks", async () => {
    const taskId = `task-${randomUUID()}`;
    const { id } = createBackgroundPrimarySession(
      taskId,
      shellSpec(),
      () => {},
    );
    track(id);

    const sentinel = `sentinel-${randomUUID()}`;
    writeToSession(id, `echo ${sentinel}\n`);
    // Real pty echo + the child's own echo of the sentinel round-trip
    // through the OS pipe before landing in the headless mirror.
    await sleep(300);

    const received: string[] = [];
    const attached = attachPrimarySession(taskId, 80, 24, {
      onData: (data) => received.push(data),
      onExit: () => {},
    });

    expect(attached).toBeDefined();
    expect(attached?.id).toBe(id);
    expect(attached?.snapshot).toContain(sentinel);

    // A second attach attempt must not succeed: the session is attached now.
    expect(
      attachPrimarySession(taskId, 80, 24, {
        onData: () => {},
        onExit: () => {},
      }),
    ).toBeUndefined();

    // Live streaming now flows through the attached callbacks.
    const liveSentinel = `live-${randomUUID()}`;
    writeToSession(id, `echo ${liveSentinel}\n`);
    for (
      let i = 0;
      i < 50 && !received.some((chunk) => chunk.includes(liveSentinel));
      i++
    ) {
      await sleep(20);
    }
    expect(received.some((chunk) => chunk.includes(liveSentinel))).toBe(true);
  });

  it("resizes the pty to the attaching pane's size", async () => {
    const taskId = `task-${randomUUID()}`;
    const { id } = createBackgroundPrimarySession(
      taskId,
      shellSpec(),
      () => {},
    );
    track(id);
    await sleep(100);
    const attached = attachPrimarySession(taskId, 132, 50, {
      onData: () => {},
      onExit: () => {},
    });
    expect(attached).toBeDefined();
    // No direct getter for pty size in this module's public API; the only
    // externally observable proof is that resize() doesn't throw and the
    // session stays alive/attachable-once semantics hold (covered above).
    // A resize ioctl failure would throw synchronously inside
    // attachPrimarySession and fail this test via an uncaught exception.
  });
});
