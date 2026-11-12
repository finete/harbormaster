// Pty session lifecycle hygiene (main/ptySessions.ts + main/pty-fd-hygiene.ts):
// no file descriptors left behind per spawn (node-pty 1.1.0's macOS spawn
// leaks a spare ptmx + the slave fd into the parent; see pty-fd-hygiene.ts),
// dispose closes the master even for a child that ignores SIGHUP (destroy(),
// not just kill()), and a session whose process exits on its own is retired
// (no longer reported by activeSessionCwds/activeSessionPids, later calls on
// its id are no-ops). Real `/bin/sh` processes via node-pty, no mocks.
import { randomUUID } from "node:crypto";
import {
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeSessionCwds,
  activeSessionPids,
  attachPrimarySession,
  createBackgroundPrimarySession,
  createSession,
  disposeSession,
  disposeSessionsUnder,
  getSession,
  lookupPanePid,
  resizeSession,
  writeToSession,
} from "../src/main/ptySessions";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** macOS `dev_t` major number. */
function major(rdev: number): number {
  return (rdev >>> 24) & 0xff;
}

/** Device majors of a pty master and slave, read off a throwaway spawn. */
const ptyMajors: Set<number> = (() => {
  const probe = pty.spawn("/bin/sh", ["-c", "exit 0"], {});
  const internals = probe as unknown as { _fd: number; _pty: string };
  const majors = new Set([
    major(fstatSync(internals._fd).rdev),
    major(statSync(internals._pty).rdev),
  ]);
  probe.kill();
  return majors;
})();

/**
 * Pty-related fds this process holds right now: pty masters/slaves, plus
 * fds that no longer even fstat (a slave revoked once its child's session
 * ended shows as `(revoked)` in lsof and fstats as EBADF), minus the one
 * EBADF entry that is the `/dev/fd` listing's own directory fd. Scoped to
 * ptys on purpose: node-pty 1.1.0 also leaks its exit-watcher kqueue per
 * spawn, which no JS-side fix can safely identify (see pty-fd-hygiene.ts).
 */
function openFdCount(): number {
  let count = -1;
  for (const name of readdirSync("/dev/fd")) {
    try {
      const stat = fstatSync(Number(name));
      if (stat.isCharacterDevice() && ptyMajors.has(major(stat.rdev))) {
        count++;
      }
    } catch {
      count++;
    }
  }
  return count;
}

/** Polls until the open-fd count settles at or below `limit` (masters close asynchronously, via libuv), returning the last count seen. */
async function settledFdCount(limit: number): Promise<number> {
  let count = openFdCount();
  for (let i = 0; i < 50 && count > limit; i++) {
    await sleep(50);
    count = openFdCount();
  }
  return count;
}

function shSpec(script: string, cwd = process.cwd()) {
  return { command: "/bin/sh", args: ["-c", script], cwd, env: {} };
}

const openSessionIds: string[] = [];
const strayPids: number[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  while (openSessionIds.length > 0) {
    const id = openSessionIds.pop();
    if (id) disposeSession(id);
  }
  // Only pids this suite itself spawned (SIGHUP-ignoring children).
  while (strayPids.length > 0) {
    const pid = strayPids.pop();
    try {
      if (pid) process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tmpCwd(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hm-pty-lifecycle-"));
  tmpDirs.push(dir);
  return dir;
}

/** Resolves once `onExit` has fired and the exit handler's synchronous retire has run. */
function exitSignal(): {
  onExit: (code: number) => void;
  exited: Promise<number>;
} {
  let resolve: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => {
    resolve = r;
  });
  return {
    onExit: (code) => setImmediate(() => resolve(code)),
    exited,
  };
}

const CYCLES = 20;
// Headroom for a straggler still closing; a regression leaks 2 pty fds per
// spawn (40 over the loop).
const SLACK = 2;

describe.runIf(process.platform === "darwin")("pty fd hygiene", () => {
  it("leaves no fds behind across spawn + dispose cycles", async () => {
    const before = openFdCount();
    for (let i = 0; i < CYCLES; i++) {
      const { id } = createSession(
        80,
        24,
        { onData: () => {}, onExit: () => {} },
        { spec: shSpec("sleep 30") },
      );
      disposeSession(id);
    }
    expect(await settledFdCount(before + SLACK)).toBeLessThanOrEqual(
      before + SLACK,
    );
  });

  it("leaves no fds behind for processes that exit on their own (never disposed)", async () => {
    const before = openFdCount();
    const exits: Promise<number>[] = [];
    for (let i = 0; i < CYCLES; i++) {
      const signal = exitSignal();
      createSession(
        80,
        24,
        { onData: () => {}, onExit: signal.onExit },
        { spec: shSpec("exit 0") },
      );
      exits.push(signal.exited);
    }
    await Promise.all(exits);
    expect(await settledFdCount(before + SLACK)).toBeLessThanOrEqual(
      before + SLACK,
    );
  });

  it("leaves no fds behind for background primaries, disposed or exited", async () => {
    const before = openFdCount();
    const exits: Promise<number>[] = [];
    for (let i = 0; i < CYCLES / 2; i++) {
      const live = createBackgroundPrimarySession(
        `task-${randomUUID()}`,
        shSpec("sleep 30"),
        () => {},
      );
      disposeSession(live.id);
      const signal = exitSignal();
      createBackgroundPrimarySession(
        `task-${randomUUID()}`,
        shSpec("exit 0"),
        signal.onExit,
      );
      exits.push(signal.exited);
    }
    await Promise.all(exits);
    expect(await settledFdCount(before + SLACK)).toBeLessThanOrEqual(
      before + SLACK,
    );
  });

  it("dispose closes the master even when the child ignores SIGHUP", async () => {
    const count = 5;
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const ready = new Promise<void>((resolve) => {
        const { id, pid } = createSession(
          80,
          24,
          {
            onData: (data) => {
              if (data.includes("ready")) resolve();
            },
            onExit: () => {},
          },
          // The trap must be installed before dispose's SIGHUP arrives.
          { spec: shSpec("trap '' HUP; echo ready; sleep 30") },
        );
        ids.push(id);
        strayPids.push(pid);
      });
      await ready;
    }
    const before = openFdCount();
    for (const id of ids) disposeSession(id);
    // One master fd per session must be gone, though every child lives on.
    expect(await settledFdCount(before - count)).toBeLessThanOrEqual(
      before - count,
    );
  });
});

describe("exited sessions are retired", () => {
  it("a renderer session that exits drops out of every live-session view", async () => {
    const cwd = tmpCwd();
    const taskId = `task-${randomUUID()}`;
    const signal = exitSignal();
    const { id, pid } = createSession(
      80,
      24,
      { onData: () => {}, onExit: signal.onExit },
      { taskId, primary: true, spec: shSpec("exit 3", cwd) },
    );
    openSessionIds.push(id);
    expect(activeSessionCwds()).toContain(cwd);
    expect(await signal.exited).toBe(3);

    expect(getSession(id)).toBeUndefined();
    expect(activeSessionCwds()).not.toContain(cwd);
    expect(activeSessionPids().has(pid)).toBe(false);
    expect(lookupPanePid(taskId)).toBeUndefined();
    // Later calls on the dead id stay harmless no-ops.
    expect(() => {
      writeToSession(id, "echo hi\n");
      resizeSession(id, 100, 30);
      disposeSession(id);
    }).not.toThrow();
  });

  it("a background primary nobody ever opened is retired when it exits", async () => {
    const cwd = tmpCwd();
    const taskId = `task-${randomUUID()}`;
    const signal = exitSignal();
    const { id, pid } = createBackgroundPrimarySession(
      taskId,
      shSpec("exit 0", cwd),
      signal.onExit,
    );
    openSessionIds.push(id);
    expect(activeSessionCwds()).toContain(cwd);
    await signal.exited;

    expect(getSession(id)).toBeUndefined();
    expect(activeSessionCwds()).not.toContain(cwd);
    expect(activeSessionPids().has(pid)).toBe(false);
    expect(
      attachPrimarySession(taskId, 80, 24, {
        onData: () => {},
        onExit: () => {},
      }),
    ).toBeUndefined();
  });

  it("an attached background primary flushes its output, then exits once and is retired", async () => {
    const cwd = tmpCwd();
    const taskId = `task-${randomUUID()}`;
    let backgroundExits = 0;
    const { id } = createBackgroundPrimarySession(
      taskId,
      // Reads one line, echoes a marker, exits: deterministic ordering.
      shSpec("read line; echo done-$line; exit 5", cwd),
      () => {
        backgroundExits++;
      },
    );
    openSessionIds.push(id);
    let output = "";
    const signal = exitSignal();
    const attached = attachPrimarySession(taskId, 80, 24, {
      onData: (data) => {
        output += data;
      },
      onExit: signal.onExit,
    });
    expect(attached?.id).toBe(id);
    writeToSession(id, "x\n");
    expect(await signal.exited).toBe(5);
    expect(output).toContain("done-x");
    expect(backgroundExits).toBe(1);
    expect(getSession(id)).toBeUndefined();
    expect(activeSessionCwds()).not.toContain(cwd);
  });
});

describe("a confirmed Done ends the ptys in its worktree", () => {
  it("disposes every session whose cwd is the worktree or inside it, never a lookalike sibling", () => {
    const root = tmpCwd();
    const inside = path.join(root, "src");
    const sibling = `${root}-other`;
    for (const dir of [inside, sibling]) {
      mkdirSync(dir, { recursive: true });
    }
    const open = (cwd: string) => {
      const { id } = createSession(
        80,
        24,
        { onData: () => {}, onExit: () => {} },
        { spec: shSpec("sleep 30", cwd) },
      );
      openSessionIds.push(id);
      return id;
    };
    const atRoot = open(root);
    const nested = open(inside);
    const other = open(sibling);

    expect(disposeSessionsUnder(`${root}/`).sort()).toEqual(
      [atRoot, nested].sort(),
    );
    expect(getSession(atRoot)).toBeUndefined();
    expect(getSession(nested)).toBeUndefined();
    expect(getSession(other)).toBeDefined();
    expect(activeSessionCwds()).not.toContain(root);
    expect(activeSessionCwds()).toContain(sibling);
    // The question's view can leave out a task's warm session.
    expect(activeSessionCwds({ excludeIds: new Set([other]) })).not.toContain(
      sibling,
    );
    disposeSession(other);
    rmSync(sibling, { recursive: true, force: true });
  });
});
