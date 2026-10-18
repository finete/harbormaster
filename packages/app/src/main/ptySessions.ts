// Narrow pty resource-access wrapper for the main process.
//
// This is a *skeleton* concern, not core's harness-adapter boundary: the real
// Pi-session pty lifecycle (per /docs/design-decisions.md and
// /ai/prds/architecture.md) will live behind packages/core's Access layer
// once sessions are wired through the command API. For now this proves the
// xterm <-> node-pty <-> IPC plumbing with a plain `$SHELL` process.
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import os from "node:os";
import path, { join } from "node:path";
import * as pty from "node-pty";

export interface PtySessionCallbacks {
  onData: (data: string) => void;
  onExit: (exitCode: number) => void;
}

interface PtySessionRecord {
  id: string;
  process: pty.IPty;
  /** The directory the process was spawned in (its starting cwd). */
  cwd: string;
  dataDisposable: pty.IDisposable;
  exitDisposable: pty.IDisposable;
  /** Set only for a task workspace's primary panel (see `PtySessionOptions.taskId`/`primary`). */
  taskId?: string;
}

const sessions = new Map<string, PtySessionRecord>();

/**
 * Pane-pid registry: taskId -> the id of its one primary pty session, if
 * any is currently live. A task has at most one primary pane, so this is
 * the app's own ground truth for "which pid, right now" that presence
 * corroboration (see `main/presence-corroboration.ts`) cross-checks the
 * extension's self-reported records against. An entry is removed the
 * instant its process exits (in the `onExit` subscription below, ahead of
 * the caller's own exit callback) or `disposeSession` runs — never left
 * pointing at a dead pid.
 */
const primaryTaskSessions = new Map<string, string>();

function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC ?? "powershell.exe";
  }
  return process.env.SHELL ?? "/bin/bash";
}

/** The spec a harness adapter hands a frontend for its launch command (see `@harbormaster/core`'s `LaunchSpec`). Declared locally (not imported) to keep this module's dependency on core to types only. */
export interface LaunchSpecLike {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface PtySessionOptions {
  /** Spawn cwd override (e.g. a task's worktree path); defaults to the app's own cwd. */
  cwd?: string;
  /**
   * A harness launch spec to try first (e.g. a Pi pane). If its command
   * cannot be found on PATH, this session falls back to a plain `$SHELL` in
   * the same cwd and `fellBackToShell` is `true` in the result.
   */
  spec?: LaunchSpecLike;
  /**
   * The task this session belongs to, combined with `primary`. Registered
   * in the pane-pid registry (`lookupPanePid`) only when this session also
   * ends up actually running `spec` (a real harness launch, not a shell
   * fallback) - a "+ terminal" panel, a scratch task's shell, or a primary
   * pane that fell back to `$SHELL` because its harness command was
   * missing never has a presence record to corroborate against, and must
   * never be mistaken for one by showing a false "attached" badge.
   */
  taskId?: string;
  /** Whether this is the task's primary panel (see `taskId`). */
  primary?: boolean;
}

/**
 * Whether `command` resolves to an existing, executable file — a plain file
 * existence check (PATH lookup for bare names, direct check for paths),
 * not a spawn attempt. node-pty's `spawn` doesn't synchronously throw for a
 * missing binary (the fork succeeds; exec fails inside the child), so this
 * is checked up front instead of relying on a thrown error.
 */
export function commandExists(command: string): boolean {
  const candidates =
    command.includes("/") || command.startsWith("~")
      ? [command]
      : (process.env.PATH ?? "")
          .split(path.delimiter)
          .map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      // Not on this PATH entry — keep looking.
    }
  }
  return false;
}

export function createSession(
  cols: number,
  rows: number,
  callbacks: PtySessionCallbacks,
  options?: PtySessionOptions,
): { id: string; pid: number; fellBackToShell: boolean } {
  const id = randomUUID();
  const cwd = options?.cwd || process.cwd();
  const spec = options?.spec;
  const useSpec = !!spec && commandExists(spec.command);
  const fellBackToShell = !!spec && !useSpec;

  const spawnCwd = useSpec ? spec.cwd || cwd : cwd;
  const ptyProcess = useSpec
    ? pty.spawn(spec.command, spec.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: spawnCwd,
        env: { ...(process.env as Record<string, string>), ...spec.env },
      })
    : pty.spawn(defaultShell(), [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: process.env as Record<string, string>,
      });

  // Subscriptions are owned by the session record so `disposeSession` can
  // unsubscribe them explicitly — killing the process alone doesn't
  // guarantee node-pty won't deliver one more queued onData/onExit event to
  // a callback that (if it forwarded straight to webContents.send) could
  // throw on an already-destroyed window.
  const dataDisposable = ptyProcess.onData((data) => callbacks.onData(data));
  const exitDisposable = ptyProcess.onExit(({ exitCode }) => {
    // The OS process is confirmed dead the instant this fires (node-pty's
    // own exit event, independent of whether/when `disposeSession` is ever
    // called) — drop this session's pane-pid-registry entry right here, so
    // presence corroboration sees "no pane" immediately instead of however
    // long it takes the renderer to call `terminal.dispose()` (or the
    // window to close).
    const taskId = sessions.get(id)?.taskId;
    if (taskId && primaryTaskSessions.get(taskId) === id) {
      primaryTaskSessions.delete(taskId);
    }
    callbacks.onExit(exitCode);
  });

  // Only register a session that actually ran the harness spec (a real `pi`
  // launch, not a plain `$SHELL`) as the task's pane - a shell fallback
  // (missing `pi` binary) or a scratch task's bare terminal never gets a
  // presence record to corroborate against, and must never be mistaken for
  // one (a false "attached" badge on a task with no agent at all).
  const registerAsPane = useSpec && options?.primary && !!options?.taskId;
  sessions.set(id, {
    id,
    process: ptyProcess,
    cwd: spawnCwd,
    dataDisposable,
    exitDisposable,
    ...(registerAsPane ? { taskId: options.taskId } : {}),
  });
  if (registerAsPane && options?.taskId) {
    primaryTaskSessions.set(options.taskId, id);
  }
  return { id, pid: ptyProcess.pid, fellBackToShell };
}

export function getSession(id: string): PtySessionRecord | undefined {
  return sessions.get(id);
}

export function writeToSession(id: string, data: string): void {
  sessions.get(id)?.process.write(data);
}

export function resizeSession(id: string, cols: number, rows: number): void {
  const session = sessions.get(id);
  if (!session) return;
  try {
    session.process.resize(cols, rows);
  } catch {
    // The underlying process can die out from under this entry (a crash, an
    // OOM kill, an external `kill -9`, ...) before the renderer's own exit
    // handler or `disposeSession` ever runs - node-pty's resize ioctl
    // throws on an already-gone fd (EBADF) in that window. Same "already
    // gone, nothing left to do" guard as `disposeSession`'s own kill().
  }
}

export function disposeSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  // Remove from the map first: disposing/killing can synchronously trigger
  // another onExit delivery, and we don't want a re-entrant disposeSession
  // call to find (and double-dispose) the same record.
  sessions.delete(id);
  if (session.taskId && primaryTaskSessions.get(session.taskId) === id) {
    primaryTaskSessions.delete(session.taskId);
  }
  session.dataDisposable.dispose();
  session.exitDisposable.dispose();
  try {
    session.process.kill();
  } catch {
    // Already exited/killed — nothing left to clean up.
  }
}

export function disposeAllSessions(): void {
  for (const id of [...sessions.keys()]) {
    disposeSession(id);
  }
}

/**
 * Pids this process itself spawned, right now. Used by the takeover guard
 * (see main/index.ts) to tell "live in one of our own panes" apart from
 * "live somewhere else" without the renderer ever touching a pid directly.
 */
export function activeSessionPids(): Set<number> {
  return new Set(
    [...sessions.values()]
      .map((session) => session.process.pid)
      .filter((pid): pid is number => typeof pid === "number"),
  );
}

/**
 * Spawn cwds of every live pty right now, passed to core's `toDone` as
 * `protectedPaths` so a worktree is never removed out from under an open
 * pane. (Spawn cwd, not the shell's current cwd — a pane that `cd`s
 * elsewhere still protects the directory it was opened in.)
 */
export function activeSessionCwds(): string[] {
  return [...new Set([...sessions.values()].map((session) => session.cwd))];
}

export function hostShellLabel(): string {
  return `${defaultShell()} (${os.hostname()})`;
}

/**
 * The app's own ground truth for a task's primary pane right now: its real
 * child pid, if a primary session for `taskId` is currently live.
 * `undefined` when the task has no open primary pane (never launched,
 * closed, or its process already exited). Presence corroboration (see
 * `main/presence-corroboration.ts`) treats that as "no pane" and falls back
 * to trusting the extension's record exactly as the harness does today
 * (external sessions: ssh, a bare terminal, an adopted session).
 */
export function lookupPanePid(
  taskId: string,
): { pid: number; alive: boolean } | undefined {
  const sessionId = primaryTaskSessions.get(taskId);
  if (!sessionId) return undefined;
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  const pid = session.process.pid;
  if (typeof pid !== "number") return undefined;
  return { pid, alive: true };
}
