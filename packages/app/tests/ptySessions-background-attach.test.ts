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
  createSession,
  detachPrimarySession,
  disposeSession,
  getSession,
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

/**
 * Condition wait instead of a fixed sleep: resolves once the session's
 * headless mirror has parsed `marker` (output arrives asynchronously and can
 * lag well past a few hundred ms when the suite runs under parallel load).
 */
async function waitForMirror(id: string, marker: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const serialized = getSession(id)?.headless?.serialize.serialize() ?? "";
    if (serialized.includes(marker)) return;
    await sleep(20);
  }
  throw new Error(`mirror never showed ${JSON.stringify(marker)}`);
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

describe("detachPrimarySession (renderer reload / crash)", () => {
  it("hands an attached primary back to the background so the reloaded pane re-attaches to the SAME process", async () => {
    const taskId = `task-${randomUUID()}`;
    const { id, pid } = createBackgroundPrimarySession(
      taskId,
      shellSpec(),
      () => {},
    );
    track(id);
    const first = attachPrimarySession(taskId, 80, 24, {
      onData: () => {},
      onExit: () => {},
    });
    expect(first?.id).toBe(id);
    // While attached, a second attach must miss (that is what used to make
    // a reloaded pane spawn a duplicate pi).
    expect(
      attachPrimarySession(taskId, 80, 24, {
        onData: () => {},
        onExit: () => {},
      }),
    ).toBeUndefined();

    expect(detachPrimarySession(id)).toBe(true);
    writeToSession(id, "echo detached-marker\r");
    await sleep(300);

    const again = attachPrimarySession(taskId, 80, 24, {
      onData: () => {},
      onExit: () => {},
    });
    expect(again?.id).toBe(id);
    expect(again?.pid).toBe(pid);
    expect(again?.snapshot).toContain("detached-marker");
  });

  it("refuses non-primary sessions (the caller disposes those)", () => {
    const { id } = createSession(80, 24, {
      onData: () => {},
      onExit: () => {},
    });
    track(id);
    expect(detachPrimarySession(id)).toBe(false);
  });
});

/** A process that, like fullscreen pi, enters the alt screen, enables mouse tracking + SGR encoding, bracketed paste and hides the cursor, then idles echoing. */
function piLikeSpec(): ReturnType<typeof shellSpec> {
  return {
    command: "/bin/sh",
    args: [
      "-c",
      "printf '\\033[?1049h\\033[?1000h\\033[?1002h\\033[?1004h\\033[?1006h\\033[?2004h\\033[?25lpi-ready'; exec cat",
    ],
    cwd: process.cwd(),
    env: {},
  };
}

const noopCallbacks = { onData: () => {}, onExit: () => {} };

describe("terminal modes survive attach / detach", () => {
  it("attach snapshot restores mouse encoding and cursor visibility that addon-serialize omits", async () => {
    const taskId = `task-${randomUUID()}`;
    const { id } = createBackgroundPrimarySession(
      taskId,
      piLikeSpec(),
      () => {},
    );
    track(id);
    await waitForMirror(id, "pi-ready");
    const attached = attachPrimarySession(taskId, 80, 24, noopCallbacks);
    const snapshot = attached?.snapshot ?? "";
    expect(snapshot).toContain("pi-ready");
    expect(snapshot).toContain("\x1b[?1049h");
    expect(snapshot).toContain("\x1b[?1002h");
    expect(snapshot).toContain("\x1b[?1006h");
    expect(snapshot).toContain("\x1b[?25l");
    // Replay comes after the serialized screen.
    expect(snapshot.lastIndexOf("\x1b[?1006h")).toBeGreaterThan(
      snapshot.indexOf("pi-ready"),
    );
  });

  it("detach -> reattach keeps alt screen and mouse modes even though the new mirror starts mid-stream", async () => {
    const taskId = `task-${randomUUID()}`;
    const { id } = createBackgroundPrimarySession(
      taskId,
      piLikeSpec(),
      () => {},
    );
    track(id);
    await waitForMirror(id, "pi-ready");
    expect(attachPrimarySession(taskId, 80, 24, noopCallbacks)?.id).toBe(id);
    expect(detachPrimarySession(id)).toBe(true);
    writeToSession(id, "after-detach\r");
    await waitForMirror(id, "after-detach");
    const again = attachPrimarySession(taskId, 80, 24, noopCallbacks);
    const snapshot = again?.snapshot ?? "";
    expect(snapshot).toContain("after-detach");
    expect(snapshot).toContain("\x1b[?1049h");
    expect(snapshot).toContain("\x1b[?1002h");
    expect(snapshot).toContain("\x1b[?1006h");
    expect(snapshot).toContain("\x1b[?25l");
  });
});
