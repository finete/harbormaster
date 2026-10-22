// Utility: child-process exec helper. Ported from pi-home's
// src/utilities/exec.ts (same execFile + promisify shape) with the error
// path hardened to fold a failed process's stderr into the thrown message,
// so access-layer callers (git, future GitHub CLI access) get an actionable
// error without re-parsing anything. Utilities are callable from any layer;
// this one is consumed by access/ services that shell out to git.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

function execOptions(cwd: string | undefined, options: RunOptions | undefined) {
  return {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    timeout: options?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    // SIGKILL, not the default SIGTERM: a child wedged on a prompt or in
    // uninterruptible network I/O may ignore SIGTERM, and the promise only
    // settles once the child actually exits.
    killSignal: "SIGKILL" as const,
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
    const result = await execFileAsync(
      command,
      args,
      execOptions(cwd, options),
    );
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
    const result = await execFileAsync(
      command,
      args,
      execOptions(cwd, options),
    );
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
