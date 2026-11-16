// Pieces every harness adapter shares (decision #18: "the standard path for
// every agent"): the Harbormaster env markers a launched session carries,
// and the presence read (OSC 7501 reports recorded by core + pid liveness,
// identical for every agent). The Pi adapter predates this module and keeps
// its own copy of the same markers.

import { SessionPresenceAccess } from "../access/session-presence-access.js";
import type {
  BuildLaunchSpecInput,
  HarnessReviewCapability,
  PresenceStatus,
  ReviewTarget,
  SessionLaunch,
} from "../contracts/harness.js";
import type { Clock, PresenceAccess } from "../contracts/services.js";
import { SystemClock } from "../utilities/defaults.js";
import {
  resolveSocketPath,
  resolveStatePaths,
} from "../utilities/state-paths.js";
import { derivePresenceStatus } from "./presence-heuristics.js";

export const MARKER_ENV = "HARBORMASTER";
export const TASK_ID_ENV = "HARBORMASTER_TASK_ID";
export const STATE_DIR_ENV = "HARBORMASTER_STATE_DIR";
export const SESSION_ID_ENV = "HARBORMASTER_SESSION_ID";
export const SOCKET_ENV = "HARBORMASTER_SOCKET";
export const CLI_ENV = "HARBORMASTER_CLI";
/** Plannotator opens its session URL through this (docs/plannotator.md "Transport"). */
export const PLANNOTATOR_BROWSER_ENV = "PLANNOTATOR_BROWSER";
/** Every other browser open; set only when `captureBrowser` (config.captureAgentBrowser). */
export const BROWSER_ENV = "BROWSER";

export interface PresenceReaderOptions {
  /** Per-user state directory root (locates `<stateDir>/presence`). */
  stateDir?: string;
  /** Inject a presence access directly (tests). */
  presence?: PresenceAccess;
  clock?: Clock;
  /** Pid probe; defaults to `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
}

/** `process.kill(pid, 0)`: ESRCH = dead, EPERM = alive (another user's). */
export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A task's presence status from the shared registry (same rules as the Pi adapter). */
export function createPresenceReader(
  options: PresenceReaderOptions,
): (taskId: string) => Promise<PresenceStatus> {
  const access =
    options.presence ??
    new SessionPresenceAccess(resolveStatePaths(options.stateDir).presenceDir);
  const clock = options.clock ?? new SystemClock();
  const isAlive = options.isAlive ?? defaultIsAlive;
  return async (taskId) =>
    derivePresenceStatus(await access.read(taskId), clock.now(), { isAlive });
}

/** The session id a launch creates or reopens, when it names one. */
export function launchSessionId(
  session: SessionLaunch | undefined,
): string | undefined {
  if (!session) return undefined;
  switch (session.mode) {
    case "new":
    case "fork":
    case "resume":
      return session.sessionId;
    case "open":
    case "continue":
      return undefined;
  }
}

/**
 * The env markers every Harbormaster-launched session carries: who it is
 * (`HARBORMASTER_TASK_ID`, `HARBORMASTER_SESSION_ID`), where core lives
 * (`HARBORMASTER_STATE_DIR`, `HARBORMASTER_SOCKET`), and the absolute CLI
 * path hooks and shells run (`HARBORMASTER_CLI`).
 */
export function baseLaunchEnv(
  input: BuildLaunchSpecInput,
  cliPath: string | undefined,
): Record<string, string> {
  const sessionId = launchSessionId(input.session);
  return {
    [MARKER_ENV]: "1",
    [TASK_ID_ENV]: input.taskId,
    [STATE_DIR_ENV]: input.stateDir,
    ...(sessionId ? { [SESSION_ID_ENV]: sessionId } : {}),
    [SOCKET_ENV]: resolveSocketPath(input.stateDir),
    ...(cliPath ? { [CLI_ENV]: cliPath } : {}),
  };
}

/** The subset of the launch env the `harbormaster mcp` server needs (identity + socket). */
export function mcpIdentityEnv(
  env: Record<string, string>,
): Record<string, string> {
  const identity: Record<string, string> = {};
  for (const key of [TASK_ID_ENV, STATE_DIR_ENV, SOCKET_ENV, SESSION_ID_ENV]) {
    const value = env[key];
    if (value !== undefined) identity[key] = value;
  }
  return identity;
}

/** POSIX single-quote a word for a `sh -c` command line (hook commands). */
export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * Point the session's URL opens at the host's open-url handler (docs/
 * plannotator.md decision 6): `PLANNOTATOR_BROWSER` always (when the host
 * has a handler), `BROWSER` too when `captureBrowser`, but never over a
 * `BROWSER` the adapter already set on purpose. Mutates and returns `env`.
 */
export function applyOpenUrlEnv(
  env: Record<string, string>,
  input: Pick<BuildLaunchSpecInput, "openUrlHandler" | "captureBrowser">,
): Record<string, string> {
  const handler = input.openUrlHandler;
  if (!handler) return env;
  env[PLANNOTATOR_BROWSER_ENV] = handler;
  if (input.captureBrowser && env[BROWSER_ENV] === undefined) {
    env[BROWSER_ENV] = handler;
  }
  return env;
}

/** The Plannotator slash command Pi and Claude Code share (`/plannotator-review [<PR URL>]`). */
export const PLANNOTATOR_REVIEW_COMMAND = "/plannotator-review";

/** `/plannotator-review`, with the PR URL appended for a PR review. */
export const plannotatorSlashReview: HarnessReviewCapability = {
  command(target: ReviewTarget): string {
    return target.kind === "pr"
      ? `${PLANNOTATOR_REVIEW_COMMAND} ${target.url}`
      : PLANNOTATOR_REVIEW_COMMAND;
  },
};

/**
 * A custom agent's review command from its `reviewCommand` template:
 * `{target}` becomes the PR URL (or nothing for local changes); a template
 * without `{target}` gets the PR URL appended.
 */
export function templateReviewCommand(
  template: string,
  target: ReviewTarget,
): string {
  const value = target.kind === "pr" ? target.url : "";
  const text = template.includes("{target}")
    ? template.replaceAll("{target}", value)
    : value
      ? `${template} ${value}`
      : template;
  return text.replace(/[ \t]+/g, " ").trim();
}
