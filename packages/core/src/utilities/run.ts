// Utility: child-process exec helper. Ported from pi-home's
// src/utilities/exec.ts (same execFile shape) with the error
// path hardened to fold a failed process's stderr into the thrown message,
// so access-layer callers (git, future GitHub CLI access) get an actionable
// error without re-parsing anything. Utilities are callable from any layer;
// this one is consumed by access/ services that shell out to git.
//
// The actual spawn goes through a swappable {@link ProcessRunner}. The
// default runs `execFile` in this process; a host whose event loop must not
// stall (the Electron main process: on macOS an endpoint-security agent can
// hold every exec inside `posix_spawn` for tens of milliseconds) installs a
// runner that spawns in a helper process instead (`setProcessRunner`).

import { execFile } from "node:child_process";

/** One child-process run, fully described as plain data (so a runner can forward it to another process). */
export interface ProcessRunRequest {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
  maxBuffer: number;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs one child process to completion. Rejects with an `Error` carrying
 * `execFile`'s failure fields (`killed`, `code`, `signal`, `stderr`) so
 * {@link run}'s error description works the same for every runner.
 */
export type ProcessRunner = (
  request: ProcessRunRequest,
) => Promise<ProcessRunResult>;

/** The default runner: `execFile` in this process, SIGKILL on timeout. */
export const execFileRunner: ProcessRunner = (request) =>
  new Promise((resolve, reject) => {
    execFile(
      request.command,
      request.args,
      {
        cwd: request.cwd,
        maxBuffer: request.maxBuffer,
        timeout: request.timeoutMs,
        // SIGKILL, not the default SIGTERM: a child wedged on a prompt or in
        // uninterruptible network I/O may ignore SIGTERM, and the promise only
        // settles once the child actually exits.
        killSignal: "SIGKILL",
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

let activeRunner: ProcessRunner = execFileRunner;

/**
 * Swap the runner every {@link run}/{@link tryRun} call uses; `undefined`
 * restores {@link execFileRunner}. Process-wide: install it once at startup,
 * before the core issues any command.
 */
export function setProcessRunner(runner: ProcessRunner | undefined): void {
  activeRunner = runner ?? execFileRunner;
}

const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Default wall-clock limit for one child process. A `gh`/`git` call that
 * stalls (network hang, credential prompt, stuck index lock) would otherwise
 * never settle, and `refresh()` is single-flight: one hung child would wedge
 * every later tick for the rest of the session. 60s is far above any healthy
 * observation call; long-running verbs (clone, push with hooks) pass
 * {@link LONG_RUN_TIMEOUT_MS} explicitly.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 60_000;

/** Limit for legitimately slow, user-initiated verbs (`git clone`, `git push` running pre-push hooks). */
export const LONG_RUN_TIMEOUT_MS = 10 * 60_000;

export interface RunOptions {
  /** Kill the child (SIGKILL) and fail after this many ms. Defaults to {@link DEFAULT_RUN_TIMEOUT_MS}. */
  timeoutMs?: number;
}

function request(
  command: string,
  args: string[],
  cwd: string | undefined,
  options: RunOptions | undefined,
): ProcessRunRequest {
  return {
    command,
    args,
    ...(cwd ? { cwd } : {}),
    maxBuffer: MAX_BUFFER,
    timeoutMs: options?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
  };
}

/**
 * Run a child process to completion in `cwd` and return its trimmed stdout.
 * Throws with the process's stderr (falling back to the raw error message)
 * folded in when the process exits nonzero or fails to spawn.
 */
export async function run(
  command: string,
  args: string[],
  cwd?: string,
  options?: RunOptions,
): Promise<string> {
  try {
    const result = await activeRunner(request(command, args, cwd, options));
    return result.stdout.trimEnd();
  } catch (error) {
    throw new Error(
      `${command} ${args.join(" ")} failed${cwd ? ` (cwd: ${cwd})` : ""}: ${describeExecError(error, options)}`,
    );
  }
}

/** Like {@link run}, but returns `undefined` instead of throwing on failure (including a timeout). */
export async function tryRun(
  command: string,
  args: string[],
  cwd?: string,
  options?: RunOptions,
): Promise<string | undefined> {
  try {
    const result = await activeRunner(request(command, args, cwd, options));
    return result.stdout.trimEnd();
  } catch {
    return undefined;
  }
}

function describeExecError(error: unknown, options?: RunOptions): string {
  if (error && typeof error === "object") {
    const { killed, code } = error as { killed?: unknown; code?: unknown };
    // Node also kills the child on a maxBuffer overflow; only a kill without
    // that code is our timeout.
    if (killed === true && code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return `timed out after ${options?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS}ms`;
    }
    const stderr =
      "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "").trim()
        : "";
    if (stderr) return stderr;
    const message =
      "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : "";
    if (message) return message;
  }
  return String(error);
}

/** What {@link runOutcome} saw: never a throw, always both streams. */
export interface RunOutcome {
  /** Exit status 0 within the time limit. */
  ok: boolean;
  stdout: string;
  stderr: string;
  /** The command could not be found / executed (`ENOENT`, `EACCES`). */
  notFound: boolean;
  timedOut: boolean;
}

/**
 * Like {@link tryRun}, but keeps both output streams and why it failed, for
 * probes whose answer lives on stderr or in a nonzero exit (`gh auth
 * status`, `<agent> --version`).
 */
export async function runOutcome(
  command: string,
  args: string[],
  options?: RunOptions,
): Promise<RunOutcome> {
  try {
    const result = await activeRunner(
      request(command, args, undefined, options),
    );
    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
      notFound: false,
      timedOut: false,
    };
  } catch (error) {
    const fields = (error ?? {}) as {
      code?: unknown;
      killed?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    return {
      ok: false,
      stdout: String(fields.stdout ?? ""),
      stderr: String(fields.stderr ?? ""),
      notFound: fields.code === "ENOENT" || fields.code === "EACCES",
      timedOut:
        fields.killed === true &&
        fields.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    };
  }
}
