// Main-process side of the spawn host. Core shells out to `git`/`gh` many
// times per refresh tick (per task), and `child_process` spawns run
// `posix_spawn` synchronously on the calling thread. On a managed Mac an
// endpoint-security agent (Jamf Protect, XProtect) authorizes every exec
// inside that syscall, so under load each spawn froze the main process's
// event loop for 20-100ms: keystrokes and pty output (which all relay
// through main) stalled behind it. This runner forwards each spawn to a
// long-lived utility process (spawn-host.ts), so only that process waits.
//
// Failure handling: a host that exits fails its in-flight runs (never
// retried: a run may be a non-idempotent `git push`/`gh pr create`) and is
// re-forked on the next run; after repeated crashes, or when it can't be
// forked at all (e.g. before app-ready), runs fall back to the in-process
// runner so the core keeps working.

import type {
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
} from "@harbormaster/core";
import {
  deserializeRunError,
  type SpawnHostRequest,
  type SpawnHostResponse,
} from "./spawn-host-protocol";

/** The slice of Electron's `UtilityProcess` the client uses (injectable for tests). */
export interface SpawnHostProcess {
  postMessage(message: SpawnHostRequest): void;
  on(event: "message", listener: (message: SpawnHostResponse) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  kill(): boolean;
}

export interface SpawnHostRunnerOptions {
  /** Starts a host process; returns `undefined` (or throws) when one can't be started right now. */
  fork: () => SpawnHostProcess | undefined;
  /** Runs a request in-process when no host is available. */
  fallback: ProcessRunner;
  /** Host exits tolerated before giving up on it for the rest of the session. */
  maxCrashes?: number;
  /** Extra time past a request's own timeout before a silent host is presumed wedged and killed. */
  watchdogGraceMs?: number;
  log?: (message: string) => void;
}

export interface SpawnHostRunner {
  run: ProcessRunner;
  /** Kills the host and fails in-flight runs (app quit). */
  dispose(): void;
}

interface Pending {
  request: ProcessRunRequest;
  resolve: (result: ProcessRunResult) => void;
  reject: (error: Error) => void;
  watchdog: ReturnType<typeof setTimeout>;
}

export function createSpawnHostRunner(
  options: SpawnHostRunnerOptions,
): SpawnHostRunner {
  const maxCrashes = options.maxCrashes ?? 3;
  const watchdogGraceMs = options.watchdogGraceMs ?? 10_000;
  const log = options.log ?? ((message) => console.warn(message));
  const pending = new Map<number, Pending>();
  let host: SpawnHostProcess | undefined;
  let nextId = 1;
  let crashes = 0;
  let disposed = false;

  function failAll(reason: string): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.watchdog);
      pending.delete(id);
      entry.reject(
        new Error(`${reason} before ${describe(entry.request)} finished`),
      );
    }
  }

  function ensureHost(): SpawnHostProcess | undefined {
    if (host || disposed || crashes >= maxCrashes) return host;
    let started: SpawnHostProcess | undefined;
    try {
      started = options.fork();
    } catch (error) {
      log(`[spawn-host] could not start: ${String(error)}`);
      return undefined;
    }
    if (!started) return undefined;
    const current = started;
    current.on("message", (response) => {
      const entry = pending.get(response.id);
      if (!entry) return;
      clearTimeout(entry.watchdog);
      pending.delete(response.id);
      if (response.ok) entry.resolve(response.result);
      else entry.reject(deserializeRunError(response.error));
    });
    current.on("exit", (code) => {
      if (host !== current) return;
      host = undefined;
      failAll(`spawn host exited (code ${code})`);
      if (disposed) return;
      crashes += 1;
      log(
        crashes >= maxCrashes
          ? `[spawn-host] exited (code ${code}); ${crashes} exits, spawning in-process from now on`
          : `[spawn-host] exited (code ${code}); restarting on the next run`,
      );
    });
    host = current;
    return host;
  }

  const run: ProcessRunner = (request) => {
    const target = ensureHost();
    if (!target) return options.fallback(request);
    return new Promise<ProcessRunResult>((resolve, reject) => {
      const id = nextId++;
      const watchdog = setTimeout(() => {
        if (!pending.has(id)) return;
        // The host enforces the request's own timeout; silence well past it
        // means the host itself is wedged. Killing it fails every in-flight
        // run via the exit handler and the next run re-forks.
        log(
          `[spawn-host] no answer for ${describe(request)}; killing the host`,
        );
        target.kill();
      }, request.timeoutMs + watchdogGraceMs);
      pending.set(id, { request, resolve, reject, watchdog });
      try {
        target.postMessage({ id, request });
      } catch (error) {
        clearTimeout(watchdog);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  return {
    run,
    dispose() {
      disposed = true;
      const current = host;
      host = undefined;
      failAll("spawn host shut down");
      current?.kill();
    },
  };
}

function describe(request: ProcessRunRequest): string {
  return [request.command, ...request.args].join(" ");
}
