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
 * Run a child process to completion in `cwd` and return its trimmed stdout.
 * Throws with the process's stderr (falling back to the raw error message)
 * folded in when the process exits nonzero or fails to spawn.
 */
export async function run(
  command: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout.trimEnd();
  } catch (error) {
    throw new Error(
      `${command} ${args.join(" ")} failed${cwd ? ` (cwd: ${cwd})` : ""}: ${describeExecError(error)}`,
    );
  }
}

/** Like {@link run}, but returns `undefined` instead of throwing on failure. */
export async function tryRun(
  command: string,
  args: string[],
  cwd?: string,
): Promise<string | undefined> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout.trimEnd();
  } catch {
    return undefined;
  }
}

function describeExecError(error: unknown): string {
  if (error && typeof error === "object") {
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
