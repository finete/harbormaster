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
}

const sessions = new Map<string, PtySessionRecord>();

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
  const exitDisposable = ptyProcess.onExit(({ exitCode }) =>
    callbacks.onExit(exitCode),
  );

  sessions.set(id, {
    id,
    process: ptyProcess,
    cwd: spawnCwd,
    dataDisposable,
    exitDisposable,
  });
  return { id, pid: ptyProcess.pid, fellBackToShell };
}

export function getSession(id: string): PtySessionRecord | undefined {
  return sessions.get(id);
}

export function writeToSession(id: string, data: string): void {
  sessions.get(id)?.process.write(data);
}

export function resizeSession(id: string, cols: number, rows: number): void {
  sessions.get(id)?.process.resize(cols, rows);
}

export function disposeSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  // Remove from the map first: disposing/killing can synchronously trigger
  // another onExit delivery, and we don't want a re-entrant disposeSession
  // call to find (and double-dispose) the same record.
  sessions.delete(id);
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
