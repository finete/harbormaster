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
import type { PresenceRecord, ThinkingLevel } from "./model.js";

/** One model a harness can run, for the composer's Agent · Model picker. */
export interface HarnessModel {
  /** What the harness accepts as its model argument (Pi: `"provider/id"`). */
  id: string;
  /** Provider group label (e.g. `"anthropic"`). */
  provider: string;
  /** Short display name (e.g. `"claude-opus-4-8"`). */
  name: string;
  /** Whether the model accepts a thinking level. */
  thinking: boolean;
}

/** Everything a frontend needs to render one harness's group in the model picker. */
export interface HarnessModelCatalog {
  /** Stable harness id stored on tasks (`Task.harness`). */
  harness: string;
  /** Display label (e.g. `"Pi"`). */
  label: string;
  models: HarnessModel[];
  /** The model a session gets when none is chosen (config default, else the harness's own). */
  defaultModel?: string;
  /** The thinking level a session gets when none is chosen. */
  defaultThinking?: ThinkingLevel;
  /** Why `models` is empty or incomplete (e.g. the harness CLI is missing), for the picker to show. */
  error?: string;
}

/** Resource Access behind a harness's model list (spawns the harness CLI / reads its settings). */
export interface HarnessModelCatalogAccess {
  listModels(): Promise<Omit<HarnessModelCatalog, "harness" | "label">>;
}

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
 * - `open`: a conversation recorded before core knew its id (a task imported
 *   from pi-home carries the session file but no id) — reopen that exact
 *   file; the harness reports its id back through `recordTaskSession`.
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
       * `CoreCommands.claimSessionLaunch`: `task.model ?? task.launch.model ??
       * GlobalConfig.launch.defaultModel`). Never applied to a
       * resume/fork/continue "- the harness adapter maps it to `--model` only
       * here.
       */
      model?: string;
      /** Thinking-level override for this first launch only (`task.thinking`). */
      thinking?: ThinkingLevel;
    }
  | { mode: "resume"; sessionId: string; sessionPath?: string }
  | { mode: "fork"; sessionId: string; forkFrom: string }
  | { mode: "open"; sessionPath: string }
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
  /** Stable id stored on tasks (`Task.harness`), e.g. `"pi"`. */
  readonly id: string;
  /** Display label, e.g. `"Pi"`. */
  readonly label: string;

  /** The models this harness can run, for the composer's picker. Never throws: failures come back as `error`. */
  listModels(): Promise<HarnessModelCatalog>;

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
