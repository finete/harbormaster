// `harbormaster doctor` contracts: the setup self-check every frontend (the
// CLI's `doctor`, the app's Setup screen "Check setup", the diagnostics
// bundle's `doctor.json`) reads, and the read-only machine probes behind it.
// Plain data only, so the result crosses the socket / IPC unchanged.

import type { AgentCommandProbeAccess, ProbeOutcome } from "./onboarding.js";

/**
 * Wall-clock limit for one local doctor probe: a command lookup, a
 * `--version`, a state file, the disk, the tool socket ping.
 */
export const LOCAL_PROBE_TIMEOUT_MS = 5_000;

/**
 * Wall-clock limit for one network doctor probe (`gh auth status`, one
 * `git ls-remote`). A remote that advertises very many refs (~100k refs,
 * ~10+ MB of listing) needs seconds to tens of seconds for any ls-remote, since git
 * downloads the whole advertisement even for `ls-remote origin HEAD`.
 */
export const NETWORK_PROBE_TIMEOUT_MS = 20_000;

/** Network probes in flight at once (the per-repository `ls-remote`s). */
export const NETWORK_PROBE_CONCURRENCY = 5;

/** Repositories `repos.remote` probes by default (the ones with active tasks). */
export const REMOTE_PROBE_CAP = 5;

/** One check's verdict. `skip`: the probe could not run (timed out, nothing to check). */
export type DoctorStatus = "ok" | "warn" | "fail" | "skip";

/** One environment check (Orca's environment-doctor / `codex doctor` shape). */
export interface DoctorCheck {
  /** Display group: `tools`, `agents`, `state`, `repos`, `disk`, `worktrees`, `socket`, `path`. */
  group: string;
  /** Stable dotted id (`tools.git`, `agents.pi`, `repos.codeRoot`, …). */
  id: string;
  status: DoctorStatus;
  /** One line: what was found. */
  summary: string;
  /** Extra facts (resolved path, failing repositories, problems), multi-line allowed. */
  detail?: string;
  /** What to do about a `warn` / `fail`. */
  remediation?: string;
  /** Wall-clock time the check took, in ms. */
  ms?: number;
  /** Per-item results under the check (`repos.remote`: one per probed repository). */
  items?: DoctorCheckItem[];
  /** For an agent CLI check (`agents.<harness id>`): the command's name, for the plain summary's `<command>: <version>` line. */
  agentCommand?: string;
}

/** One item under a check (a repository's `ls-remote`). */
export interface DoctorCheckItem {
  /** What was probed (a repository id). */
  name: string;
  status: DoctorStatus;
  /** One line: `reachable`, `Repository not found.`, `did not answer within 20 s`. */
  summary: string;
  /** Wall-clock time the probe took, in ms. */
  ms?: number;
}

/** `CoreCommands.doctor` result. */
export interface DoctorReport {
  /** ISO time the checks started. */
  checkedAt: string;
  /** Every check, in display order (grouped). */
  checks: DoctorCheck[];
  /** `DoctorInput.appVersion`, echoed for summaries. */
  appVersion?: string;
  /** `process.platform` of the host that ran the checks. */
  platform?: string;
}

/**
 * `CoreCommands.doctor` input: facts only the frontend knows. All optional;
 * a check whose fact is missing reports `skip`.
 */
export interface DoctorInput {
  /**
   * The user's login-shell PATH: the app reads it at start; the CLI passes
   * its own (shell) PATH. Compared with the PATH core resolves commands on.
   */
  loginShellPath?: string;
  /** The running app bundle / entry (informational). */
  appPath?: string;
  /** The running app's version (informational, echoed in the report). */
  appVersion?: string;
  /**
   * `repos.remote` probes every discovered repository (still
   * `NETWORK_PROBE_CONCURRENCY` at a time) instead of only the ones with an
   * active task (`harbormaster doctor --all-remotes`).
   */
  probeAllRemotes?: boolean;
}

/** Path facts for one folder (`repos.codeRoot`). */
export interface PathFacts {
  exists: boolean;
  isDirectory: boolean;
  /** The on-disk spelling (`realpath`), when it exists. */
  realPath?: string;
}

/** The installed vs bundled Harbormaster Pi extension (`agents.pi-extension`). */
export interface PiExtensionFacts {
  /** Pi's extensions directory. */
  dir: string;
  /** Where the installed extension file would be. */
  installedPath: string;
  /** Its text, when present. */
  installedText?: string;
  /** The bundled copy the host ships, when the host knows one. */
  bundledPath?: string;
  bundledText?: string;
}

/** The local tool socket as probed (`socket.tool`). */
export interface ToolSocketFacts {
  path: string;
  exists: boolean;
  /** Something answered a `ping` within the timeout. */
  responds: boolean;
  error?: string;
}

/** `git ls-remote --exit-code origin HEAD` for one checkout (raw; `engines/doctor.ts` classifies it). */
export interface RemoteProbe {
  ok: boolean;
  timedOut: boolean;
  /** The process exit code, when it exited (128: git's fatal error; 2: no matching ref). */
  exitCode?: number;
  /** First stderr/stdout line on failure (the `fatal:` / `ERROR:` line when there is one). */
  error?: string;
  /** Wall-clock time the probe took, in ms. */
  ms?: number;
}

/**
 * Resource Access for the doctor's machine probes. Every verb is read-only,
 * bounded by a short timeout, and never throws: failures come back as data.
 */
export interface EnvironmentProbeAccess extends AgentCommandProbeAccess {
  /** The PATH this process resolves commands on. */
  processPath(): string;
  /** The host platform (`darwin`, `linux`). */
  platform(): string;
  /** The tool commands the checks probe (e2e overrides included); agents come from the harness descriptors. */
  commands(): { git: string; gh: string };
  /** The absolute file `command` runs (PATH lookup for a bare name), if any. */
  resolveCommand(command: string): Promise<string | undefined>;
  /** `<command> --version`. */
  commandVersion(command: string): Promise<ProbeOutcome>;
  /** `gh auth status` (its exit code, plus network-error wording to tell "unreachable" apart). */
  githubAuthStatus(): Promise<ProbeOutcome>;
  /** The Harbormaster Pi extension, installed and bundled. */
  piExtension(): Promise<PiExtensionFacts>;
  /** Existence / realpath of a folder. */
  pathFacts(path: string): Promise<PathFacts>;
  /** The state dir's config file and whether it exists (loading a missing one would write defaults). */
  configFile(): Promise<{ path: string; exists: boolean }>;
  /** Free bytes on the volume holding the state dir. */
  stateDirFreeBytes(): Promise<{ path: string; freeBytes: number }>;
  /** `git ls-remote --exit-code origin HEAD` in `checkout`, never prompting for credentials. */
  remoteReachable(checkout: string): Promise<RemoteProbe>;
  /** The local tool socket for this state dir. */
  toolSocket(): Promise<ToolSocketFacts>;
}
