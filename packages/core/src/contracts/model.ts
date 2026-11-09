// Domain model — phase 1 (foundation only). Ported and heavily pruned from
// pi-home's src/contracts/model.ts: no Beads issues, no PRs, no deployment
// pipelines, no cmux. Those return in later phases behind the same shapes
// where it makes sense.

import { DEFAULT_MOVER_ORDER } from "./addons.js";

export const STATE_VERSION = 1 as const;

/**
 * A harness-agnostic reasoning-effort level (Pi's `--thinking` values; other
 * adapters map or ignore it). See `/docs/new-task-composer.md`.
 */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** The harness every task ran on before tasks recorded one. */
export const DEFAULT_HARNESS_ID = "pi";

/** Permanent, repository-backed work vs. local-only scratch work. */
export type TaskKind = "task" | "temp_task";

/** Board column a task currently sits in. */
export type TaskState = "backlog" | "dev" | "awaiting" | "done";

/**
 * Why a task sitting in the "awaiting" column is blocked. Ported from
 * pi-home's richer AwaitingContext, pruned to the board-grouping fields this
 * phase needs: no PR metadata, Slack thread state, or deployment-pipeline
 * wiring yet (those return once git/GitHub access is ported).
 */
export type AwaitingKind =
  | { kind: "review" }
  | { kind: "slack"; permalink?: string }
  | { kind: "deploy"; stageId: string; stageLabel: string };

/**
 * Identifier of a registered awaiting kind (see
 * `engines/awaiting-kinds.ts`). Kinds are data the one `toAwait` verb is
 * parameterized with — never verbs of their own.
 */
export type AwaitingKindId = AwaitingKind["kind"];

/**
 * Pull-request linkage and GitHub review/merge snapshot for a task, as
 * refreshed by `CoreCommands.refresh()`. Ported and pruned from pi-home's
 * richer `PullRequestMeta` (src/contracts/model.ts): no Slack-thread or
 * cmux-specific fields, but the review/merge signal the movers need
 * (reviewDecision, head-tracking flags, merge commit) carries over.
 */
export interface TaskPullRequest {
  number: number;
  url?: string;
  state: "draft" | "open" | "merged" | "closed";
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
  /** Whether an outstanding changes-requested review targets the current PR head. */
  changesRequestedOnHead?: boolean;
  /** Whether a human reviewer submitted feedback (COMMENTED or CHANGES_REQUESTED) on the current PR head. */
  humanFeedbackOnHead?: boolean;
  reviewRequested?: boolean;
  reviewSubmitted?: boolean;
  headRefOid?: string;
  /** The exact squash/merge commit that entered the destination branch, once merged. */
  mergeCommit?: { oid: string; targetBranch: string };
}

/**
 * One configured deployment-pipeline stage for a repository. A stage without
 * a hook is a manual gate: movers enter it but never advance past it on
 * their own. Ported from pi-home's `DeploymentStageConfig`.
 */
export interface DeploymentStageConfig {
  id: string;
  label: string;
  /** Registry name of the built-in stage hook that decides when this stage's wait is over. */
  hook?: string;
  /** Opaque options passed to the hook (e.g. `{ url, hotfixScan, hotfixDepth }`). */
  options?: Record<string, unknown>;
}

/** Declarative deployment pipeline for one repository, from the global config. */
export interface DeploymentPipeline {
  /** Display template with `{major}`/`{minor}`/`{patch}` placeholders; stored but not yet interpreted in this phase. */
  releaseBranch?: string;
  /** Ordered stages; a merged PR enters the first and lands (done) after the last. */
  stages: DeploymentStageConfig[];
}

/** Per-repository settings from the global config, keyed by normalized repository id. */
export interface RepositoryConfig {
  deployment?: DeploymentPipeline;
  /** Mover order for this repository's tasks; overrides the global `movers` (an empty list disables automatic moves here). */
  movers?: string[];
  /**
   * Explicit primary-checkout override for a repository with several
   * checkouts under `codeRoot` (e.g. `arnac`, `arnac2`, `arnac3`). Validated
   * leniently at config-load time (must be a non-empty string); whether the
   * path is actually a known, non-linked-worktree checkout of this
   * repository is checked by `GitRepositoryAccess.discoverRepositories` at
   * discovery time, not here.
   */
  preferredCheckout?: string;
}

/** Ordered list of board columns; the source of truth for board layout. */
export const TASK_STATES: readonly TaskState[] = [
  "backlog",
  "dev",
  "awaiting",
  "done",
];

/**
 * One unit of work on the board. Permanent (`"task"`) and scratch
 * (`"temp_task"`) work share a shape in phase 1; pi-home's richer
 * WorkspaceBinding/TemporaryWorkspace split (issue linkage, PR state,
 * deployment awaiting context, completion cleanup bookkeeping) returns in
 * later phases once git/GitHub access is ported.
 */
export interface Task {
  id: string;
  kind: TaskKind;
  state: TaskState;
  title: string;
  initialPrompt: string;
  /**
   * When `initialPrompt` was handed to the task's first harness session
   * (see `CoreCommands.claimInitialPrompt`); unset until then, so the prompt
   * kicks off exactly one session, never every re-opened pane.
   */
  initialPromptDeliveredAt?: string;
  /** Opaque repository identity; resolved against git access in a later phase. Normalized like "github.com/org/repo". */
  repositoryId?: string;
  /**
   * A non-git folder the task runs in place (no worktree, no branch); set
   * instead of `repositoryId`. See `/docs/new-task-composer.md` "Where".
   */
  folderPath?: string;
  /**
   * Ref the task's worktree branches off when it is started (any branch,
   * e.g. the parent's branch for stacked work); absent = the repository's
   * default branch.
   */
  baseRef?: string;
  /**
   * Agent harness this task runs on (e.g. `"pi"`); fixed for the task's
   * lifetime. Absent = `DEFAULT_HARNESS_ID` (tasks created before this
   * field existed).
   */
  harness?: string;
  /** Model for the task's first session; falls back to `GlobalConfig.launch.defaultModel`, then the harness default. */
  model?: string;
  /** Thinking level for the task's first session; absent = the harness default. */
  thinking?: ThinkingLevel;
  /**
   * The model the task's first session started with when the task chose
   * none (`model` unset): the configured default, else the harness's own
   * default at that moment. Recorded by `claimSessionLaunch`, for display.
   */
  sessionModel?: string;
  /** Working branch for this task's worktree, once bound. */
  branch?: string;
  /** Branch this task's work will land on (e.g. "main"). */
  targetBranch?: string;
  /** Pull-request linkage, once opened; kept current by `CoreCommands.refresh()`. */
  pr?: TaskPullRequest;
  /** Opaque reference to a tracked issue (Beads/GitHub), resolved in a later phase. */
  issueRef?: string;
  /**
   * Idempotency marker set by `migration/` when this task was imported from
   * pi-home: the source pi-home Beads issue id (permanent tasks) or
   * temporary-workspace id (scratch tasks). Re-running the migration tool
   * matches on this to skip already-imported tasks. Unset for tasks created
   * natively in Harbormaster.
   */
  pihomeIssueId?: string;
  /** Set only while `state === "awaiting"`; cleared on any move out of it. */
  awaiting?: AwaitingKind;
  createdAt: string;
  updatedAt: string;
  stateChangedAt: string;
  completedAt?: string;
  archivedAt?: string;
  lastError?: string;
  /**
   * Set for a `child`-launched task (see `CoreCommands.launchTask`): the
   * launching task's id. Nested under the parent on the board; the parent
   * can poll it (`listChildren`) and a Done parent with active children
   * asks for confirmation (`toDone`'s `activeChildren` case). One level
   * only — a task with `parentTaskId` set can never itself become a parent
   * (`launchTask` rejects a `child` relation from it).
   */
  parentTaskId?: string;
  /**
   * Display-only provenance for a `standalone`-launched task: the task (if
   * any) whose session called `launchTask`. Unlike `parentTaskId` this
   * creates no lineage — no nesting, no Done confirmation, no polling.
   */
  launchedFromTaskId?: string;
  /** Present only for a task created by `launchTask`: its background-launch queue/run state. */
  launch?: TaskLaunch;
}

/**
 * A `launchTask`-created task's background-launch state (see
 * `/docs/design-decisions.md "Launching tasks from an agent"`): queued until the app's launcher claims it
 * (`CoreCommands.claimPendingLaunches`), then started once its session pty
 * is actually running. `interrupted` means the app quit mid-turn; it clears
 * back to `started` on the task's next session launch
 * (`CoreCommands.claimSessionLaunch`), never auto-resuming on its own.
 */
export interface TaskLaunch {
  status: "queued" | "started" | "interrupted";
  requestedAt: string;
  startedAt?: string;
  interruptedAt?: string;
  /** Legacy: launched tasks recorded their model here before `Task.model` existed; still honored as a fallback. */
  model?: string;
}

/**
 * One cluster of tasks within a board column, grouped by the rules in
 * `engines/board-grouping.ts`. Manager-composed, never persisted.
 */
export interface BoardGroup {
  id: string;
  /** Awaiting-reason heading ("Review", "Slack response", a deploy stage label); unset outside the awaiting column. */
  primaryLabel?: string;
  /** Short repository name (last path segment), or "scratch" for repository-less tasks. */
  repoLabel?: string;
  tasks: Task[];
}

/** Manager-composed, never persisted: one board column and its grouped tasks in order. */
export interface BoardColumn {
  state: TaskState;
  title: string;
  groups: BoardGroup[];
}

/**
 * Seam for the workspace a task runs in (worktree/branch/session). Phase 1
 * stores and round-trips these records but nothing yet populates them —
 * git-worktree and Pi-session access are phase 2.
 */
export interface WorkspaceBinding {
  id: string;
  taskId: string;
  /**
   * The task's live worktree. Cleared (binding kept) when `toDone` removes
   * the worktree, so the session identity below survives for a reopen —
   * pi-home parks its binding the same way instead of deleting it.
   */
  worktreePath?: string;
  branch?: string;
  /**
   * Harness session identity assigned by core before the task's first pane
   * launch (`claimSessionLaunch`), so every later pane reopens the same
   * conversation. pi-home's equivalent is the session file it creates up
   * front (`PiSessionAccess.create`) and stores as `sessionPath`.
   */
  sessionId?: string;
  /**
   * The persisted session file for `sessionId`, once the harness reported it
   * (`recordTaskSession`, called by the extension on session start).
   */
  sessionPath?: string;
  /** The previous cycle's session file, kept when a Done task is reopened (pi-home parity). */
  previousSessionPath?: string;
  /**
   * Set by `reopenTask`: the next pane launch forks this session file into
   * the new cycle's session instead of starting blank. Consumed (cleared) by
   * the first `claimSessionLaunch` that hands it out.
   */
  forkFromSessionPath?: string;
  detached: boolean;
  /**
   * A non-git scratch workspace (a `launchTask` task with `repository: {
   * none: true }`): `worktreePath` points at a plain directory under
   * `<stateDir>/scratch/<taskId>`, never a git worktree. `toDone` and the
   * done-cleanup retry sweep must never run worktree/branch git verbs
   * against it — they park the binding (clear `worktreePath`) and leave the
   * directory on disk, exactly like a git worktree binding minus the git
   * removal.
   */
  scratch?: boolean;
  /**
   * A user folder the task runs in place (a `folderPath` task):
   * `worktreePath` is that folder itself. Like `scratch`, never touched by
   * git verbs, and never deleted: Done/delete only park the binding.
   */
  inPlace?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** How an agent process is attached to a task's session. */
export type PresenceMode = "interactive" | "headless";

/** Terminal outcome of one headless run, self-reported or implicit. */
export interface PresenceOutcome {
  status: "done" | "blocked" | "unreported";
  note?: string;
  at: string;
  /** One-shot toast already delivered for this outcome. */
  notified?: boolean;
}

/**
 * Liveness record for one agent process attached to a task session. Ported
 * from pi-home's presence registry with the Pi-specific `cmux` location
 * field dropped (cmux is gone; the app owns pane focus directly).
 */
export interface PresenceRecord {
  taskId: string;
  sessionPath: string;
  pid: number;
  mode: PresenceMode;
  startedAt: string;
  heartbeatAt: string;
  /** Runner log file for headless runs. */
  logPath?: string;
  /** Whether an agent turn is running right now. */
  runningTurn?: boolean;
  /**
   * Self-reported done/blocked verdict from `harbormaster_report_status`
   * while the process is STILL LIVE (see `PresenceAccess.reportOutcome`):
   * recorded without ending the attachment, so the task stays live ("your
   * move" for a finished/blocked child) and the card can show the note as
   * a secondary line. Cleared when the next turn starts (`setTurnActive`
   * with `running: true`) — a stale verdict from before the user's reply
   * must never linger. Unrelated to `ended`, which keeps its original
   * meaning: the process is gone.
   */
  outcome?: { status: "done" | "blocked"; note?: string; at: string };
  /** Present once the attachment ended; absence + fresh heartbeat = live. */
  ended?: PresenceOutcome;
}

/**
 * Global per-user configuration. Minimal in phase 1 — the mover/automation
 * fields are a placeholder seam for phase 2; nothing reads them yet.
 */
export interface GlobalConfig {
  /** Global kill switch for future addon-driven board moves. */
  automation: boolean;
  /**
   * Ordered names of active movers. Absent = the built-in default order;
   * an explicit empty list disables automatic moves (pi-home semantics).
   */
  movers?: string[];
  /** Folder containing all repository checkouts (absolute; "~" expanded on load). */
  codeRoot?: string;
  /** Git namespace for new task branches (e.g. "alice/"); may be empty. */
  branchPrefix?: string;
  /** Per-repository settings (deployment pipelines today), keyed by normalized repository id. */
  repositories?: Record<string, RepositoryConfig>;
  /** Background-task-launch settings (see `/docs/design-decisions.md "Launching tasks from an agent"`). */
  launch?: { maxConcurrent?: number; defaultModel?: string };
  /** Task-messaging settings (see `/docs/task-messaging.md`); defaults apply at read time. */
  messaging?: { parentReplyTimeoutMinutes?: number; loopCap?: number };
}

/** `launch.maxConcurrent` default when unset: launched tasks that are *working* (see `GlobalConfig.launch`). */
export const DEFAULT_LAUNCH_MAX_CONCURRENT = 6;

/** `messaging.parentReplyTimeoutMinutes` default: how long a child's question may wait on its parent (counted from delivery) before the child shows amber. */
export const DEFAULT_PARENT_REPLY_TIMEOUT_MINUTES = 30;

/** `messaging.loopCap` default: autonomous parent↔child messages per pair since the user last typed into either task. */
export const DEFAULT_MESSAGE_LOOP_CAP = 8;

/** Written to a fresh config file: the built-in movers, spelled out so users see what they can reorder or drop. */
export const defaultGlobalConfig = (): GlobalConfig => ({
  automation: true,
  movers: [...DEFAULT_MOVER_ORDER],
});
