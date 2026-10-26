// Harness adapter seam (see /docs/design-decisions.md #13 and /AGENTS.md:
// "Agent harnesses are adapters"). Anything agent-specific — session
// spawn/attach, presence, running-detection — lives behind this interface so
// core logic never imports Pi (or Claude Code, Codex, ...) directly.
//
// Wave 3b ships the pty-launch and presence halves of this seam (see
// `harness/pi-adapter.ts`): everything a frontend needs to start an
// interactive Pi session in a pty and read its liveness. Headless spawn and
// programmatic attach need frontend/process cooperation (ptys, child
// process ownership) that doesn't exist yet — those stay declared but
// unimplemented, throwing a clear "wave 4" error, so the interface remains
// honest about what it can do today.

import type { HarnessMessagingCapabilities } from "./messaging.js";
import type { PresenceRecord } from "./model.js";

/**
 * Which conversation a task pane should open, as decided by core's
 * `claimSessionLaunch` from the task's workspace binding. The adapter maps
 * each mode to its harness's own CLI flags.
 *
 * - `new`: first launch — create the session under the pre-assigned id.
 * - `resume`: reopen the bound session (by its recorded file when known
 *   and present, else by id in the task's cwd — Pi creates it under that
 *   id if it was never persisted).
 * - `fork`: first launch after a Done task was reopened — copy the
 *   previous cycle's conversation into a new session with this id.
 * - `continue`: legacy binding from before session binding existed — reopen
 *   the most recent session for the task's cwd (the worktree is per-task, so
 *   that is the task's conversation).
 */
export type SessionLaunch =
  | {
      mode: "new";
      sessionId: string;
      /**
       * Pi `--model <pattern>` override for this first launch only (see
       * `CoreCommands.claimSessionLaunch`: `task.launch.model ??
       * GlobalConfig.launch.defaultModel`). Never applied to a
       * resume/fork/continue "- the harness adapter maps it to `--model` only
       * here.
       */
      model?: string;
    }
  | { mode: "resume"; sessionId: string; sessionPath?: string }
  | { mode: "fork"; sessionId: string; forkFrom: string }
  | { mode: "continue" };

export interface BuildLaunchSpecInput {
  taskId: string;
  /** Working directory the session's process runs in (the task's worktree or workspace). */
  workspacePath: string;
  /** Per-user state directory root (presence, config, ...), so the adapter can point the harness at it. */
  stateDir: string;
  /** Seed prompt for a brand-new session; omitted when resuming/attaching to an existing one. */
  initialPrompt?: string;
  /** Which conversation to open (see `CoreCommands.claimSessionLaunch`); omitted = harness default (a fresh, unbound session). */
  session?: SessionLaunch;
}

/**
 * Everything a frontend needs to start an interactive harness session in a
 * pty. Core never spawns the process itself (accessor separation: ptys are a
 * frontend resource) — it only computes what command to run, in which
 * directory, and with which environment.
 */
export interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** Liveness snapshot for a task's harness session, derived from its presence record. */
export interface PresenceStatus {
  /** Whether the attached process is alive (fresh heartbeat, not ended). */
  live: boolean;
  /** The underlying presence record, if one has ever been registered for this task. */
  record?: PresenceRecord;
  /** Whether an agent turn is running right now (always `false` when not live). */
  runningTurn: boolean;
}

/**
 * One agent harness (Pi today; Claude Code/Codex/etc. later). Every
 * implementation is pure logic plus resource-access calls — no process
 * spawning in core (see /AGENTS.md: accessor separation is a hard rule).
 */
export interface HarnessAdapter {
  /** What this harness can deliver to a task's session (see `docs/task-messaging.md`): core resolves the actual message mode from this. */
  readonly messaging: HarnessMessagingCapabilities;

  /** Build the command/args/cwd/env a frontend should hand to a pty to start (or resume) an interactive session. */
  buildLaunchSpec(input: BuildLaunchSpecInput): LaunchSpec;

  /** Current liveness/outcome snapshot for a task's session. */
  presence(taskId: string): Promise<PresenceStatus>;

  /** Stop a headless run's process. Requires frontend/process-owner cooperation; not implemented until wave 4. */
  stopHeadless(taskId: string): Promise<void>;

  /** Attach the caller to an already-running task session. Requires frontend pty cooperation; not implemented until wave 4. */
  attach(taskId: string): Promise<void>;
}
