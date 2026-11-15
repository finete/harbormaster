// Contract: the core's operation log port. Core runs headless (in the app's
// main process today, a daemon tomorrow), so it never prints: it reports
// state transitions and timed operations through this port, and the host
// decides where lines go (the app backs it with `console`, which lands in
// `<userData>/logs/main.log`). Absent a logger, core is silent.
//
// Fields are a closed set on purpose: ids, branch/path names, durations,
// counts, outcomes and error messages only. Never prompt text, message
// bodies, environment values or tokens: a field that is not listed here
// cannot be logged.

/** Which part of core a line is about; printed as `[core:<scope>]`. */
export type CoreLogScope =
  | "worktree"
  | "git"
  | "github"
  | "done"
  | "refresh"
  | "orphans"
  | "session"
  | "state"
  | "rules"
  | "launch";

/** The closed set of timed operation names (one completion line each). */
export type CoreOperation =
  | "worktree.create"
  | "worktree.checkout-pr"
  | "worktree.remove"
  | "branch.delete"
  | "branch.push"
  | "pr.ensure-open"
  | "pr.squash-merge"
  | "task.provision-worktree"
  | "task.provision-scratch"
  | "task.provision-in-place"
  | "done.cleanup"
  | "done.forced-cleanup"
  | "done.retry-cleanup"
  | "refresh"
  | "orphans.scan";

export type CoreLogOutcome =
  | "ok"
  | "failed"
  | "skipped"
  | "queued"
  | "claimed"
  | "interrupted"
  | "done"
  | "blocked"
  | "recorded"
  | "ignored"
  | "missing";

/** Everything a core log line may carry (`undefined` fields are dropped). */
export interface CoreLogFields {
  op?: CoreOperation | undefined;
  taskId?: string | undefined;
  repositoryId?: string | undefined;
  /** A repository's display label (`repositoryLabel`). */
  repository?: string | undefined;
  branch?: string | undefined;
  worktreePath?: string | undefined;
  /** Wall time of a timed operation, in milliseconds. */
  ms?: number | undefined;
  outcome?: CoreLogOutcome | undefined;
  /** An error message, on one bounded line (`logErrorMessage`). */
  error?: string | undefined;
  count?: number | undefined;
  errors?: number | undefined;
  warnings?: number | undefined;
  bytes?: number | undefined;
  /** Launch relation (`child` / `standalone`). */
  relation?: string | undefined;
  /** Session launch mode (`new`, `resume`, `fork`, `open`, `continue`). */
  mode?: string | undefined;
  sessionId?: string | undefined;
  /** A session file path (never its content). */
  sessionFile?: string | undefined;
  /** The directory a harness is expected to create a session file in. */
  sessionDir?: string | undefined;
  /** A state/rules file path. */
  file?: string | undefined;
  ruleId?: string | undefined;
}

export interface CoreLogger {
  info(scope: CoreLogScope, message: string, fields?: CoreLogFields): void;
  warn(scope: CoreLogScope, message: string, fields?: CoreLogFields): void;
  error(scope: CoreLogScope, message: string, fields?: CoreLogFields): void;
}

/** The default: core logs nothing unless a host supplies a logger. */
export const noopCoreLogger: CoreLogger = {
  info() {},
  warn() {},
  error() {},
};
