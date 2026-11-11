// Shared primary-session launch resolution (wave 2 task brief point 2):
// the one place that turns a task into "what command, in what cwd, with
// what env" for its *primary* pane — used identically by the
// renderer-driven `pty:create` handler (main/index.ts) and the background
// launcher (background-launcher.ts's `startSession`), so a task launches
// the exact same way whichever path started it (session resume/fork/new +
// model, initial prompt claimed exactly once).
//
// Pure glue: no pty spawning here (accessor separation — ptys are a
// frontend resource, spawned by `ptySessions.ts`). Only core/harness calls.

import type {
  BuildLaunchSpecInput,
  LaunchPermissions,
  LaunchSpec,
  SessionLaunch,
  WorkspaceBinding,
} from "@harbormaster/core";
import { commandExists, directoryExists } from "./ptySessions";

/** The slice of `CoreCommands` this module needs — structural so callers (including tests) can pass a minimal fake. */
export interface PrimaryLaunchCore {
  getTaskWorkspace(taskId: string): Promise<WorkspaceBinding | undefined>;
  claimSessionLaunch(taskId: string): Promise<SessionLaunch | undefined>;
  claimInitialPrompt(taskId: string): Promise<string | undefined>;
}

/** The slice of `HarnessAdapter` this module needs. */
export interface PrimaryLaunchHarness {
  buildLaunchSpec(input: BuildLaunchSpecInput): LaunchSpec;
  /** The bare command it launches by default, for "<command> not found" messages. */
  readonly command?: string;
}

/**
 * The task's own agent (decision R8: each task runs on the harness it was
 * created with), or a fixed one. A resolver is called once per launch.
 */
export type PrimaryLaunchHarnessSource =
  | PrimaryLaunchHarness
  | ((taskId: string) => Promise<PrimaryLaunchHarness>);

export interface PrimaryLaunchOptions {
  /**
   * Permission prompts for this launch (decision R7): `"bypass"` only for
   * a background launch of a task whose launch asked for it; an interactive
   * pane never bypasses. Default `"default"`.
   */
  permissions?: LaunchPermissions;
}

export interface PrimaryLaunchResolution {
  /** The task's workspace binding, if any (`undefined` for a scratch task with no live binding). */
  binding: WorkspaceBinding | undefined;
  /**
   * The launch spec to hand to a pty. `undefined` only when there is no
   * worktree to run in. When `commandMissing` is `true` this is the
   * *unclaimed probe spec* (the harness command isn't on PATH, so neither
   * the session slot nor the initial prompt was claimed for it) — an
   * interactive caller still hands it to `createSession`, which itself
   * detects the missing command and falls back to a shell (`fellBackToShell`);
   * a background launch must check `commandMissing` first and never do
   * that (see background-launcher.ts's `startSession`).
   */
  spec: LaunchSpec | undefined;
  /** `binding.worktreePath` existed but the harness command isn't on PATH. */
  commandMissing: boolean;
  /** The bare command of the task's agent (`pi`, `claude`, ...), when known: names it in "not found" messages. */
  agentCommand?: string;
  /**
   * The binding named a worktree, but that directory no longer exists on
   * disk (reaped, moved, or carried over from an old layout). Spawning pi
   * into it would fork-then-exit-1 with no output, so the caller must not
   * launch; `spec` is `undefined` and neither claim was burned. The branch
   * usually still exists, so the worktree is recoverable with
   * `git worktree add <path> <branch>`.
   */
  worktreeMissing: boolean;
}

/**
 * Resolve a task's primary-pane launch, claiming its session slot and
 * initial prompt along the way (both are one-shot — see
 * `CoreCommands.claimSessionLaunch`/`claimInitialPrompt` — so this must
 * only be called once per actual launch attempt, never speculatively).
 */
export async function resolvePrimaryLaunch(
  taskId: string,
  stateDir: string,
  core: PrimaryLaunchCore,
  harnessSource: PrimaryLaunchHarnessSource,
  options: PrimaryLaunchOptions = {},
): Promise<PrimaryLaunchResolution> {
  const binding = await core.getTaskWorkspace(taskId);
  if (!binding?.worktreePath) {
    return {
      binding,
      spec: undefined,
      commandMissing: false,
      worktreeMissing: false,
    };
  }
  // The binding can outlive its worktree directory (reaped on Done, deleted
  // manually, or an old `.pi-home-worktrees` path from a prior layout).
  // Catch it here — before claiming the session slot or initial prompt — so
  // the pane never spawns pi into a dead cwd (a silent exit-1) and neither
  // one-shot claim is burned on a launch that cannot happen.
  if (!directoryExists(binding.worktreePath)) {
    return {
      binding,
      spec: undefined,
      commandMissing: false,
      worktreeMissing: true,
    };
  }
  const harness =
    typeof harnessSource === "function"
      ? await harnessSource(taskId)
      : harnessSource;
  const agent = harness.command ? { agentCommand: harness.command } : {};
  const baseSpecInput: BuildLaunchSpecInput = {
    taskId,
    workspacePath: binding.worktreePath,
    stateDir,
    permissions: options.permissions ?? "default",
  };
  const probeSpec = harness.buildLaunchSpec(baseSpecInput);
  if (!commandExists(probeSpec.command)) {
    return {
      binding,
      spec: probeSpec,
      commandMissing: true,
      worktreeMissing: false,
      ...agent,
    };
  }
  // Only once pi is actually launchable (a shell fallback, or a dropped
  // background launch, must not burn either claim): core decides which
  // conversation the pane opens and hands out the task's initial prompt
  // exactly once.
  const session = await core.claimSessionLaunch(taskId).catch(() => undefined);
  const initialPrompt = await core
    .claimInitialPrompt(taskId)
    .catch(() => undefined);
  const spec = harness.buildLaunchSpec({
    ...baseSpecInput,
    ...(session ? { session } : {}),
    ...(initialPrompt ? { initialPrompt } : {}),
  });
  return {
    binding,
    spec,
    commandMissing: false,
    worktreeMissing: false,
    ...agent,
  };
}
