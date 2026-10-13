// Pi harness adapter — the only adapter v1 needs (see /AGENTS.md: "Agent
// harnesses are adapters" and /docs/design-decisions.md #13). Pure launch-
// spec logic plus a presence read through `SessionPresenceAccess`; no
// process spawning here (accessor separation is a hard rule — ptys are a
// frontend resource, see /ai/prds/architecture.md).

import { SessionPresenceAccess } from "../access/session-presence-access.js";
import type {
  BuildLaunchSpecInput,
  HarnessAdapter,
  LaunchSpec,
  PresenceStatus,
  SessionLaunch,
} from "../contracts/harness.js";
import type { Clock, PresenceAccess } from "../contracts/services.js";
import { SystemClock } from "../utilities/defaults.js";
import { resolveStatePaths } from "../utilities/state-paths.js";
import {
  derivePresenceStatus,
  type PresenceLivenessOptions,
} from "./presence-heuristics.js";

export interface PiHarnessAdapterOptions {
  /**
   * Per-user state directory root. Used to locate the presence registry
   * (`<stateDir>/presence`) unless `presence` is supplied directly.
   */
  stateDir?: string;
  /** Inject a presence access directly (tests, or a non-default layout). */
  presence?: PresenceAccess;
  clock?: Clock;
  /**
   * Optional process-liveness probe forwarded to the presence heuristic.
   * Defaults to a real `process.kill(pid, 0)` probe (see `defaultIsAlive`
   * below) — tests that register fake pids should override this.
   */
  isAlive?: (pid: number) => boolean;
}

/** Marker env var every launched Pi session can check to detect it is Harbormaster-hosted. */
const MARKER_ENV = "HARBORMASTER";
const TASK_ID_ENV = "HARBORMASTER_TASK_ID";
const STATE_DIR_ENV = "HARBORMASTER_STATE_DIR";
/** Overrides the launched command (and only the command) for e2e: a tiny fake binary stands in for `pi`. */
const PI_COMMAND_ENV = "HARBORMASTER_PI_COMMAND";

/**
 * Real-world default pid probe: a process that no longer exists cannot be
 * working. This is process introspection, not spawning — acceptable in the
 * harness layer (accessor separation guards resource I/O, not `kill(pid,
 * 0)`). `process.kill(pid, 0)` sends no signal; it only checks existence
 * (ESRCH -> dead) versus a permission error (EPERM -> alive, owned by
 * another user).
 */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Pi's CLI takes a first message as a positional argument (`pi [options]
 * [--] [@files...] [messages...]`), opening an interactive session that
 * immediately sends it. The pty spawns argv directly (no shell), so no shell
 * quoting is needed — only Pi's own parsing must be defused: `--` ends
 * option parsing (a prompt starting with "-" is never read as a flag), and a
 * leading "@" (Pi's file-attachment marker, honored even after `--`) is
 * shielded with a leading space. Multiline prompts pass through verbatim.
 */
export function piPromptArgs(prompt: string | undefined): string[] {
  if (!prompt?.trim()) return [];
  return ["--", prompt.startsWith("@") ? ` ${prompt}` : prompt];
}

/**
 * Map core's session decision onto Pi's CLI (verified against pi 1.0.x
 * `pi --help` and docs/cli.md):
 *
 * - `--session <path>` opens that exact file; Pi takes the cwd from the
 *   file's header (an interactive prompt offers to continue in the current
 *   cwd if that directory no longer exists).
 * - `--session-id <id>` opens the session with that exact id in the cwd's
 *   project, or creates it under that id when absent — which is how core
 *   pre-assigns a task's session before Pi ever wrote the file.
 * - `--fork <path> --session-id <id>` copies a session into a new one for
 *   the current cwd, under the chosen id (the two flags combine; `--fork`
 *   must not be combined with `--session`/`--continue`, and `--session-id`
 *   must not be combined with `--session`/`--continue`).
 * - `--continue` reopens the most recent session for the cwd.
 */
export function piSessionArgs(session: SessionLaunch | undefined): string[] {
  if (!session) return [];
  switch (session.mode) {
    case "new":
      return ["--session-id", session.sessionId];
    case "resume":
      return session.sessionPath
        ? ["--session", session.sessionPath]
        : ["--session-id", session.sessionId];
    case "fork":
      return ["--fork", session.forkFrom, "--session-id", session.sessionId];
    case "continue":
      return ["--continue"];
  }
}

export class PiHarnessAdapter implements HarnessAdapter {
  private readonly presenceAccess: PresenceAccess;
  private readonly clock: Clock;
  private readonly livenessOptions: PresenceLivenessOptions;

  constructor(options: PiHarnessAdapterOptions = {}) {
    this.presenceAccess =
      options.presence ??
      new SessionPresenceAccess(
        resolveStatePaths(options.stateDir).presenceDir,
      );
    this.clock = options.clock ?? new SystemClock();
    this.livenessOptions = { isAlive: options.isAlive ?? defaultIsAlive };
  }

  buildLaunchSpec(input: BuildLaunchSpecInput): LaunchSpec {
    const env: Record<string, string> = {
      [MARKER_ENV]: "1",
      [TASK_ID_ENV]: input.taskId,
      [STATE_DIR_ENV]: input.stateDir,
    };
    return {
      // HARBORMASTER_PI_COMMAND lets e2e point this at a tiny fake binary
      // instead of a real `pi` install; unset (the normal case) runs `pi`.
      command: process.env[PI_COMMAND_ENV] || "pi",
      args: [
        ...piSessionArgs(input.session),
        ...piPromptArgs(input.initialPrompt),
      ],
      cwd: input.workspacePath,
      env,
    };
  }

  async presence(taskId: string): Promise<PresenceStatus> {
    const record = await this.presenceAccess.read(taskId);
    return derivePresenceStatus(record, this.clock.now(), this.livenessOptions);
  }

  async stopHeadless(_taskId: string): Promise<void> {
    throw new Error(
      "PiHarnessAdapter.stopHeadless is not implemented yet (wave 4: needs frontend/process-owner cooperation)",
    );
  }

  async attach(_taskId: string): Promise<void> {
    throw new Error(
      "PiHarnessAdapter.attach is not implemented yet (wave 4: needs frontend pty cooperation)",
    );
  }
}
