// Narrow pty resource-access wrapper for the main process.
//
// This is a *skeleton* concern, not core's harness-adapter boundary: the real
// Pi-session pty lifecycle (per /docs/design-decisions.md and
// /ai/prds/architecture.md) will live behind packages/core's Access layer
// once sessions are wired through the command API. For now this proves the
// xterm <-> node-pty <-> IPC plumbing with a plain `$SHELL` process.
import { randomUUID } from "node:crypto";
import os from "node:os";
import * as pty from "node-pty";

export interface PtySessionCallbacks {
  onData: (data: string) => void;
  onExit: (exitCode: number) => void;
}

interface PtySessionRecord {
  id: string;
  process: pty.IPty;
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

export function createSession(
  cols: number,
  rows: number,
  callbacks: PtySessionCallbacks,
): { id: string } {
  const id = randomUUID();
  const shell = defaultShell();
  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.cwd(),
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

  sessions.set(id, { id, process: ptyProcess, dataDisposable, exitDisposable });
  return { id };
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

export function hostShellLabel(): string {
  return `${defaultShell()} (${os.hostname()})`;
}
