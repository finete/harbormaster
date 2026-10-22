// File-descriptor hygiene around node-pty spawns (macOS).
//
// node-pty 1.1.0's macOS spawn path (`pty_posix_spawn` in src/unix/pty.cc)
// leaks two descriptors into the *parent* process on every spawn, whatever
// later happens to the child (kill(), destroy(), or a natural exit):
//
//  - one extra `/dev/ptmx` master from its "make sure fds 0-2 are taken"
//    loop: it `posix_openpt()`s until it gets an fd >= 2, then closes every
//    collected fd except `low_fds[0]` (the loop's off-by-one), so in a normal
//    process (0-2 already open) the first and only one it opened stays open;
//  - the slave `/dev/ttysNNN` it opened to hand to the child, which is never
//    closed in the parent (it shows as `(revoked)` in lsof once the child's
//    session ends). Holding the slave open also means the master never sees
//    EIO when the child exits.
//
// Measured: 10 spawns leave 20 fds behind; a long-running app accumulated
// 28 ptmx + 14 revoked fds with only 7 live ptys. Neither fd is referenced
// by node-pty's JS side (it only keeps the master fd + the slave's path).
//
// The workaround snapshots this process's open fds right before the
// (synchronous) spawn and, right after it, closes every NEW descriptor that
// is a pty device belonging to the spawn — the slave (same rdev as the
// slave path) or another pty master (same major as the master) — except the
// master node-pty actually uses. Nothing else can open a pty concurrently
// (node-pty spawns run on the JS thread), and the device-type checks keep a
// threadpool-opened regular file that happens to land in the diff safe.
import { closeSync, fstatSync, readdirSync, statSync } from "node:fs";

/** The subset of node-pty's `UnixTerminal` internals this module reads. Untyped privates; every access is guarded. */
interface UnixTerminalInternals {
  _fd?: unknown;
  _pty?: unknown;
}

/** Only macOS has the leak (Linux uses forkpty, which closes both in the parent); everything here is a no-op elsewhere. */
const AFFECTED = process.platform === "darwin";

/** macOS `dev_t` major number (`major()` in sys/types.h). */
function major(rdev: number): number {
  return (rdev >>> 24) & 0xff;
}

/**
 * This process's open file descriptors right now, or `undefined` where the
 * leak workaround doesn't apply / `/dev/fd` is unreadable. Each listed fd is
 * fstat-verified: the listing includes the directory fd `readdir` itself
 * used, which is closed again by the time it returns — and is therefore
 * exactly the number the spawn's leaked ptmx would otherwise reuse.
 */
export function snapshotOpenFds(): Set<number> | undefined {
  if (!AFFECTED) return undefined;
  let names: string[];
  try {
    names = readdirSync("/dev/fd");
  } catch {
    return undefined;
  }
  const open = new Set<number>();
  for (const name of names) {
    const fd = Number(name);
    if (!Number.isInteger(fd)) continue;
    try {
      fstatSync(fd);
      open.add(fd);
    } catch {
      // Not open any more (readdir's own directory fd).
    }
  }
  return open;
}

/**
 * Closes the descriptors node-pty leaked while spawning `ptyProcess` (see
 * the file comment). `before` is `snapshotOpenFds()` taken immediately
 * before the spawn. Returns how many fds were closed. Never throws: a
 * failure here must never take down a working pty.
 */
export function closeLeakedSpawnFds(
  before: Set<number> | undefined,
  ptyProcess: unknown,
): number {
  if (!before) return 0;
  const internals = ptyProcess as UnixTerminalInternals;
  const masterFd = internals._fd;
  const slavePath = internals._pty;
  if (typeof masterFd !== "number" || typeof slavePath !== "string") return 0;
  let masterMajor: number;
  let slaveRdev: number;
  try {
    masterMajor = major(fstatSync(masterFd).rdev);
    slaveRdev = statSync(slavePath).rdev;
  } catch {
    return 0;
  }
  const after = snapshotOpenFds();
  if (!after) return 0;
  let closed = 0;
  for (const fd of after) {
    if (fd === masterFd || before.has(fd)) continue;
    try {
      const stat = fstatSync(fd);
      if (!stat.isCharacterDevice()) continue;
      if (stat.rdev !== slaveRdev && major(stat.rdev) !== masterMajor) {
        continue;
      }
      closeSync(fd);
      closed++;
    } catch {
      // Raced closed, or not ours to close: leave it.
    }
  }
  return closed;
}

/** Runs a synchronous node-pty spawn and closes the fds it leaked (see the file comment). */
export function spawnWithFdHygiene<T>(spawn: () => T): T {
  const before = snapshotOpenFds();
  const ptyProcess = spawn();
  closeLeakedSpawnFds(before, ptyProcess);
  return ptyProcess;
}

/**
 * Releases a pty's own resources: node-pty's `destroy()` closes the master
 * read socket and write stream right away, then SIGHUPs the child once the
 * socket has closed (plain `kill()` only signals, leaving the master open
 * until the child actually dies — forever, for a child that ignores
 * SIGHUP). Falls back to `kill()` where `destroy` is missing or throws.
 * Safe on an already-exited pty (its socket is already closed, so no
 * signal is sent to a possibly-reused pid).
 */
export function releasePty(ptyProcess: {
  kill: (signal?: string) => void;
}): void {
  const destroy = (ptyProcess as { destroy?: unknown }).destroy;
  if (typeof destroy === "function") {
    try {
      destroy.call(ptyProcess);
      return;
    } catch {
      // Fall through to the plain signal.
    }
  }
  try {
    ptyProcess.kill();
  } catch {
    // Already exited/killed — nothing left to clean up.
  }
}
