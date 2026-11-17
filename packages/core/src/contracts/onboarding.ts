// First-run onboarding contracts (docs/release-plan.md "Onboarding (four
// screens)", R14): the plain data the four-screen wizard reads and the
// settings it writes. Every write goes through a core command; frontends
// never touch the config file.

import type { CustomAgentConfig } from "./model.js";

/** A top-level home folder macOS guards per app (TCC), re-prompting an unsigned build after every upgrade (R12a). */
export type ProtectedHomeFolder = "Documents" | "Desktop" | "Downloads";

/** `CoreCommands.getOnboardingState`: what the wizard starts from. */
export interface OnboardingState {
  /** ISO time the wizard was finished (`config.onboardingCompletedAt`); absent = never. */
  completedAt?: string;
  /**
   * The repositories folder (absolute): the configured one, or before the
   * wizard is finished, `suggestedCodeRoot` unless the configured one exists.
   */
  codeRoot: string;
  /**
   * The first existing usual code folder (`~/Code`, `~/src`, `~/Projects`,
   * …), else `~/harbormaster`. Also offered by the protected-folder warning.
   */
  suggestedCodeRoot: string;
  /** The user's home folder, for showing paths as `~/…`. */
  homeDir: string;
  /** `launch.defaultHarness`, else Pi. */
  defaultHarness: string;
  /** `launch.bypassPermissions`, else the default (on). */
  bypassPermissions: boolean;
  /** `agents.custom[]`. */
  customAgents: CustomAgentConfig[];
  /** `sources.github.enabled !== false`. */
  githubEnabled: boolean;
}

/** One git repository found directly under a scanned code root. */
export interface ScannedRepository {
  /** Normalized repository id (`github.com/org/repo`, or the git dir for a remoteless repo). */
  id: string;
  /** Display name: the checkout folder's name. */
  name: string;
  /** Absolute path of the primary checkout. */
  root: string;
}

/** `CoreCommands.scanCodeRoot`: a candidate code root, before it is saved. */
export interface CodeRootScan {
  /** The scanned folder, absolute ("~" expanded). */
  root: string;
  /** Whether the folder exists (a missing one scans as empty). */
  exists: boolean;
  /** Set when the folder is (inside) `~/Documents`, `~/Desktop` or `~/Downloads`. */
  protectedFolder?: ProtectedHomeFolder;
  /** {@link OnboardingState.suggestedCodeRoot}, offered instead of a protected folder. */
  suggestedRoot: string;
  repositories: ScannedRepository[];
}

/** A detected version against the harness's floors (docs/harness-additions.md P7). */
export type AgentVersionFloor =
  /** Older than `minVersion`: upgrade (`upgradeHint`). */
  | "below-min"
  /** Within `[minVersion, verifiedVersion]` (or no floor declared). */
  | "ok"
  /** Newer than `verifiedVersion`: works as far as we know, not tested. */
  | "newer-than-verified"
  /** No version could be read. */
  | "unknown";

/** One agent CLI as detected on this machine (`CoreCommands.detectAgents`): the built-ins, then custom agents. */
export interface DetectedAgent {
  /** Harness id (a registered adapter's id). */
  id: string;
  label: string;
  /** The command that was probed. */
  command: string;
  /** Where `command` resolves (PATH lookup for a bare name, the path itself otherwise), when it does. */
  path?: string;
  /** Whether `<command> --version` ran successfully within the timeout. */
  available: boolean;
  /** The version it printed (first version-looking token), when available. */
  version?: string;
  /** Why it is unavailable (not found, timed out, …). */
  error?: string;
  /**
   * A custom agent from `agents.custom[]` (after the built-ins): only
   * located (`available` = `command` resolves), never run.
   */
  custom?: boolean;
  /** Set when the only PATH hit was a terminal-multiplexer shim (its path); `available` is then false. */
  shim?: string;
  /** `version` against `minVersion` / `verifiedVersion` (built-ins only). */
  floor?: AgentVersionFloor;
  minVersion?: string;
  verifiedVersion?: string;
  /** The harness's install one-liner (shown when not available). */
  installHint?: string;
  /** The harness's upgrade one-liner (shown when `floor` is `below-min`). */
  upgradeHint?: string;
}

/** `gh auth status` as seen by core (`CoreCommands.githubAuthStatus`). */
export interface GithubAuthStatus {
  /** Whether the `gh` CLI could be run at all. */
  installed: boolean;
  authenticated: boolean;
  /** The active account's login, when authenticated. */
  account?: string;
  /** The host the account is logged into (`github.com`). */
  host?: string;
  /** Why it is not authenticated / not runnable. */
  error?: string;
}

/** `CoreCommands.setDefaultAgent` input (onboarding screen 2). */
export interface SetDefaultAgentInput {
  /** The default harness id (`launch.defaultHarness`): `pi`, `claude-code`, or `customAgent.id`. */
  harness: string;
  /** Added to (or replaces the same id in) `agents.custom[]`; `harness` must equal its id. */
  customAgent?: CustomAgentConfig;
  /** `launch.bypassPermissions` (decision R7); absent = unchanged. */
  bypassPermissions?: boolean;
}

/** Raw outcome of running one probe command (`<agent> --version`, `gh auth status`). */
export interface ProbeOutcome {
  ok: boolean;
  /** stdout and stderr together (gh prints its status on either, by version). */
  output: string;
  notFound: boolean;
  timedOut: boolean;
}

/**
 * The probes behind locating an agent CLI from its descriptor (shared by
 * the wizard and doctor): env overrides, every PATH hit (so a terminal shim
 * can be skipped), and running its version command.
 */
export interface AgentCommandProbeAccess {
  /** The value of the first of `envNames` that is set (e2e fake overrides). */
  commandOverride(envNames: readonly string[]): string | undefined;
  /** Every executable file `command` resolves to, in PATH order (just the path itself for a path). */
  resolveCommandAll(command: string): Promise<string[]>;
  /** `<command> <args…>` with the probe timeout. */
  runVersion(command: string, args: readonly string[]): Promise<ProbeOutcome>;
}

/**
 * Resource Access for the wizard's machine probes: the home folder, folder
 * existence, and the agent / `gh` CLIs (each run with a short timeout, off
 * the caller's event loop where the host installed a process runner).
 */
export interface OnboardingProbeAccess extends AgentCommandProbeAccess {
  /** The user's home folder. */
  homeDir(): string;
  isDirectory(path: string): Promise<boolean>;
  /** `mkdir -p` (the wizard's "Use ~/Code instead" when it does not exist yet). */
  createDirectory(path: string): Promise<void>;
  /** The absolute file `command` runs (PATH lookup for a bare name); undefined when none is executable. */
  resolveCommand(command: string): Promise<string | undefined>;
  /** `gh auth status`. */
  githubAuthStatus(): Promise<ProbeOutcome>;
}
