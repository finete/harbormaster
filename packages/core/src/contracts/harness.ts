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

import type { HarnessTurnUsage } from "./commands.js";
import type { HarnessMessagingCapabilities } from "./messaging.js";
import type {
  PresenceRecord,
  ReviewSupportPiece,
  ThinkingLevel,
} from "./model.js";
import type { SessionUsage } from "./usage.js";

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
  /** Just the harness's own defaults (a settings read, no CLI spawn). */
  defaults(): Promise<
    Pick<HarnessModelCatalog, "defaultModel" | "defaultThinking">
  >;
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
  /**
   * Permission prompts (decision R7): `"bypass"` only for a launched
   * (background) task whose launch recorded `bypassPermissions`; interactive
   * panes always get `"default"` (the user's own settings). Omitted =
   * `"default"`. Adapters without a permission system ignore it.
   */
  permissions?: LaunchPermissions;
  /** Absolute path of the host's open-url handler; the adapter exports it as PLANNOTATOR_BROWSER. */
  openUrlHandler?: string;
  /** Also export it as BROWSER (config.captureAgentBrowser). */
  captureBrowser?: boolean;
}

/** What a Plannotator review covers (docs/plannotator.md): the worktree's local changes, or the task's PR. */
export type ReviewTarget = { kind: "local" } | { kind: "pr"; url: string };

/** A harness that can start a Plannotator code review in its session. */
export interface HarnessReviewCapability {
  /** The text to deliver to the session to start a Plannotator review. */
  command(target: ReviewTarget): string;
}

/** How a launched session treats the harness's permission prompts (decision R7). */
export type LaunchPermissions = "bypass" | "default";

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
  /**
   * Files the launcher writes before spawning (core never writes: accessor
   * separation): each `files` key is a path relative to `dir`, created with
   * its parent directories, overwriting what is there. Cursor's
   * per-session plugin directory (docs/harness-additions.md C2) travels
   * this way.
   */
  prepare?: LaunchPrepare;
  /**
   * A long initial prompt travels as this file, never as an argument (see
   * `MAX_LAUNCH_ARG_CHARS`): the launcher writes `text` to the absolute
   * `path` before spawning, and `args` only reference it.
   */
  promptFile?: { path: string; text: string };
  /**
   * The program reports no status on its pty; its hooks do
   * (`capabilities.status.protocol: "hooks"`, Cursor). The launcher
   * registers the attachment at spawn as `working` with
   * `HOOK_PRESENCE_STARTING` (nothing may be typed yet, C9) and reports it
   * ready (`reportHookPresence` `start`): `ready: "hook"` = a session-start
   * hook will (a new session); `ready: "quiet"` = none will (a resumed
   * one), so the launcher does once its output has been quiet for
   * `HOOK_PRESENCE_QUIET_MS`.
   */
  hookStatus?: { ready: "hook" | "quiet" };
}

/** `LaunchSpec.prepare`: files to materialize under `dir` before spawning. */
export interface LaunchPrepare {
  /** Absolute directory. */
  dir: string;
  /** Relative path → UTF-8 content. */
  files: Record<string, string>;
}

/**
 * The longest single launch argument allowed. A managed Mac's endpoint
 * security (seen: SentinelOne, Nov 2026) SIGKILLs any interpreter + script
 * file (node, python: `pi`, the npm `codex`/`cursor-agent` shims) started
 * with one argument of 943+ characters, at exec, before the program runs.
 * The launcher refuses a spec with a longer argument.
 */
export const MAX_LAUNCH_ARG_CHARS = 900;

/** Initial prompts up to this length stay on the command line; longer ones go through `LaunchSpec.promptFile`. */
export const INLINE_PROMPT_MAX_CHARS = 400;

/** The status message of a hooks-reporting attachment that is not ready for input yet. */
export const HOOK_PRESENCE_STARTING = "Starting…";

/**
 * `capabilities.delivery.channels.wakeIdle` of a harness whose idle
 * session only takes a message typed into its pane (Cursor, C4; Claude
 * Code, whose hooks all need a turn): the app types pending messages once
 * the agent is at its prompt.
 */
export const PTY_TYPING_CHANNEL = "pty typing";

/** Output quiet this long after spawn = a hooks-reporting program that fires no session-start hook is ready. */
export const HOOK_PRESENCE_QUIET_MS = 2_000;

/** Liveness snapshot for a task's harness session, derived from its presence record. */
export interface PresenceStatus {
  /** Whether the attached process is alive (fresh heartbeat, not ended). */
  live: boolean;
  /** The underlying presence record, if one has ever been registered for this task. */
  record?: PresenceRecord;
  /** Whether an agent turn is running right now (always `false` when not live). */
  runningTurn: boolean;
}

/** One program-status report's meaning: the state and its optional message. */
export interface ProgramStatusReading {
  state: "idle" | "working" | "blocked" | "done" | "error";
  message?: string;
}

/**
 * Everything outside `harness/` needs to know about an agent CLI
 * (docs/harness-additions.md P2): onboarding, doctor, diagnostics, Settings
 * labels and review support iterate the registry's descriptors instead of
 * naming agents. Plain data plus three pure functions.
 */
export interface HarnessDescriptor {
  /** Stable id stored on tasks (`Task.harness`); equals `HarnessAdapter.id`. */
  readonly id: string;
  /** Display label (`"Claude Code"`). */
  readonly label: string;
  /**
   * The CLI's invocations in lookup order, each an argv prefix: the binary
   * then any subcommand words (`["claude"]`, `["cursor", "agent"]`). Never
   * empty for a built-in.
   */
  readonly commands: readonly (readonly string[])[];
  /**
   * Env vars that replace the command (first one set wins; e2e fakes):
   * `HARBORMASTER_<ID>_COMMAND` (see `harnessCommandEnvName`), plus any
   * legacy name.
   */
  readonly commandEnv: readonly string[];
  /** Shell one-liner that installs the CLI. */
  readonly installHint: string;
  /** Shell one-liner that upgrades an installed CLI; absent = `installHint`. */
  readonly upgradeHint?: string;
  /** One sentence on what Harbormaster sets up for this agent by itself (the wizard shows it). */
  readonly setupNote?: string;
  /** Arguments appended to a command to print its version (`["--version"]`). */
  readonly versionArgs: readonly string[];
  /** The version in the `versionArgs` output (`x.y.z`), when there is one. */
  parseVersion(output: string): string | undefined;
  /**
   * The version output identifies the CLI: a hit whose output
   * `parseVersion` cannot read is another program with the same name
   * (Cursor's generic `agent`), so the lookup tries the next alias.
   */
  readonly versionIdentifies?: boolean;
  /** Oldest version Harbormaster works with; absent = no floor (custom agents). */
  readonly minVersion?: string;
  /** Newest version the real-CLI tier ran against; above it doctor says "newer than tested". */
  readonly verifiedVersion?: string;
  /** The CLI's own config/state directory (`~/.claude`), when it has one. */
  configDir(env: NodeJS.ProcessEnv, home: string): string | undefined;
  /** Review-support pieces (`engines/review-support.ts`) this harness needs for a Plannotator review, in display order; `[]` = none. */
  readonly reviewPieces: readonly ReviewSupportPiece["id"][];
  /** Why this harness cannot start a Plannotator review (shown on the disabled Review button); absent = it can, or the generic text. */
  readonly reviewUnavailableReason?: string;
  /**
   * Whether a PATH hit is a terminal-multiplexer shim (cmux writes
   * `…/cmux-cli-shims/<uuid>/claude`), not the agent itself: lookup skips
   * it and doctor reports "only a terminal shim was found".
   */
  isShim(resolvedPath: string): boolean;
}

/** The descriptor's plain-data part, as it crosses the command API (`CoreCommands.listHarnessDescriptors`). */
export interface HarnessDescriptorInfo {
  id: string;
  label: string;
  commands: string[][];
  installHint: string;
  upgradeHint?: string;
  setupNote?: string;
  minVersion?: string;
  verifiedVersion?: string;
  reviewPieces: ReviewSupportPiece["id"][];
  reviewUnavailableReason?: string;
  /** A built-in adapter (not `agents.custom[]`). */
  builtin: boolean;
  /** Whether the harness can start a Plannotator review at all. */
  review: boolean;
}

/** A delivery kind (docs/task-messaging.md): mid-turn steer, after-turn follow-up, waking an idle session, catch-up on the next prompt. */
export type HarnessDeliveryKind = "steer" | "followUp" | "wakeIdle" | "catchUp";

/**
 * What a harness does, as data (docs/harness-additions.md P6), read by the
 * contract suite and by core's refusal logic. Must agree with
 * `HarnessAdapter.messaging` (asserted by the contract test).
 */
export interface HarnessCapabilities {
  /** `preassign`: core picks the session id and passes it on launch; `learned`: the harness reports it (a hook). */
  sessionId: "preassign" | "learned";
  status: {
    /** Where presence comes from. */
    protocol: "osc7501" | "hooks" | "none";
    /** Whether it reports only after the terminal answers the 7501 probe. */
    probe: boolean;
    /** The states it actually reports. */
    states: readonly ProgramStatusReading["state"][];
    /** Where its dialect differs from the 7501 spec; `[]` when it does not. */
    quirks: readonly string[];
  };
  delivery: {
    steer: boolean;
    followUp: boolean;
    /** Whether a message reaches a session sitting idle at its prompt without typing into the pty. */
    wakeIdle: boolean;
    /** The mechanism per kind (`"PostToolUse hook"`); absent = not delivered that way. */
    channels: Partial<Record<HarnessDeliveryKind, string>>;
  };
  /** Whether a fresh worktree shows a folder-trust dialog the user answers in the pane. */
  trustPrompt: boolean;
  /** Whether it can start a Plannotator review (`HarnessAdapter.review`). */
  review: boolean;
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
  /**
   * The bare command the adapter launches by default (`"pi"`, `"claude"`),
   * for "<command> not found" messages. Optional for test fakes.
   */
  readonly command?: string;

  /** Install/version/lookup facts (P2): what doctor, onboarding and diagnostics iterate. */
  readonly descriptor: HarnessDescriptor;
  /** What this harness does, as data (P6). */
  readonly capabilities: HarnessCapabilities;

  /** The models this harness can run, for the composer's picker. Never throws: failures come back as `error`. */
  listModels(): Promise<HarnessModelCatalog>;
  /** The harness's own default model/thinking, cheaply (no CLI spawn). Never throws. */
  defaults(): Promise<
    Pick<HarnessModelCatalog, "defaultModel" | "defaultThinking">
  >;

  /** What this harness can deliver to a task's session (see `docs/task-messaging.md`): core resolves the actual message mode from this. */
  readonly messaging: HarnessMessagingCapabilities;

  /** Absent = this harness cannot start a review (button disabled). */
  readonly review?: HarnessReviewCapability;

  /**
   * The argv prefix a launch runs, when the adapter resolves it among its
   * aliases itself (Cursor: `agent`, `cursor-agent` or `cursor agent`,
   * C6); absent = the override env var, else the first alias's binary
   * (`harnessLaunchCommand`).
   */
  launchArgv?(env?: NodeJS.ProcessEnv): string[];

  /** Build the command/args/cwd/env a frontend should hand to a pty to start (or resume) an interactive session. */
  buildLaunchSpec(input: BuildLaunchSpecInput): LaunchSpec;

  /** Current liveness/outcome snapshot for a task's session. */
  presence(taskId: string): Promise<PresenceStatus>;

  /**
   * Translates one of this harness's own program-status reports (OSC 7501)
   * into core's meaning before it is recorded (`CoreCommands.reportPresence`).
   * Optional: absent = recorded as reported. Claude Code, for one, reports
   * `working` while its turn is over but a background shell still runs.
   */
  interpretProgramStatus?(report: ProgramStatusReading): ProgramStatusReading;

  /** Stop a headless run's process. Requires frontend/process-owner cooperation; not implemented until wave 4. */
  stopHeadless(taskId: string): Promise<void>;

  /** Attach the caller to an already-running task session. Requires frontend pty cooperation; not implemented until wave 4. */
  attach(taskId: string): Promise<void>;

  /**
   * Where this harness will write a `new` session's file for `cwd` (the
   * harness owns that layout), so core can confirm it appeared. Optional:
   * without it core only logs the launch decision.
   */
  expectedSessionFile?(
    cwd: string,
    sessionId: string,
  ): ExpectedSessionFile | undefined;

  /**
   * Token usage recorded in one of this harness's session files (see
   * docs/costs.md): per model, with the harness's own cost when it wrote
   * one, and the fork prefix when the session was forked. Resolves
   * `undefined` when the file is unreadable or missing. Absent = this
   * harness has no usage reader (the task's usage is `unavailable`).
   */
  readSessionUsage?(sessionPath: string): Promise<SessionUsage | undefined>;

  /**
   * Keeps one turn's tokens a hook reported (`CoreCommands.recordTurnUsage`)
   * where `readSessionUsage` finds them: for a harness that writes no
   * usage into its transcript (Cursor). Absent = such reports are ignored.
   */
  recordTurnUsage?(usage: HarnessTurnUsage): Promise<void>;

  /**
   * The CLI command that delivers `text` to the live session `sessionId`
   * from outside the agent (docs/harness-additions.md X5: Codex's `codex
   * queue`), for a follow-up or to wake an idle session. The app (the
   * process owner) runs it and confirms the delivery; core never spawns.
   * Optional: absent or `undefined` = no such channel (inbox hooks, the
   * extension or typing deliver instead).
   */
  deliverCommand?(
    kind: "followUp" | "wakeIdle",
    sessionId: string,
    text: string,
  ): HarnessDeliverCommand | undefined;
}

/** A harness CLI invocation that hands a message to a running session from outside (Codex: `codex queue`). */
export interface HarnessDeliverCommand {
  command: string;
  args: string[];
}

/** A session file's expected location: some file in `dir` whose name ends with `fileSuffix`. */
export interface ExpectedSessionFile {
  dir: string;
  fileSuffix: string;
}
