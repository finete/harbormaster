// Command API input/output shapes — the inbound half of "commands in, state
// events out". Kept separate from model.ts because these are call-shape
// contracts, not persisted domain data.

import type { PullRequestPreview } from "./github.js";
import type {
  HarnessModelCatalog,
  PresenceStatus,
  SessionLaunch,
} from "./harness.js";
import type {
  InboxItem,
  InboxPriorityInput,
  ListInboxOptions,
  ReadyToLandEntry,
  ResolveInboxItemOptions,
  ResolveInboxItemResult,
} from "./inbox.js";
import type {
  ApproveMessageEdits,
  FindTasksOptions,
  SendTaskMessageInput,
  SendTaskMessageResult,
  TaskMessage,
  TaskMessagingState,
  TaskSearchResult,
} from "./messaging.js";
import type {
  AwaitingKind,
  AwaitingKindId,
  BoardColumn,
  CustomAgentConfig,
  PullRequestRole,
  Task,
  TaskKind,
  TaskState,
  ThinkingLevel,
  WorkspaceBinding,
} from "./model.js";
import type {
  CodeRootScan,
  DetectedAgent,
  GithubAuthStatus,
  OnboardingState,
  SetDefaultAgentInput,
} from "./onboarding.js";
import type {
  AddonInfo,
  AuditEntry,
  CreateTaskActionInput,
  ListEventsFilter,
  RulesCheckInput,
  RulesCheckResult,
  RulesListing,
} from "./rules.js";
import type { RepositoryInfo } from "./workspace.js";

export type { PullRequestPreview } from "./github.js";
/** One program-status report for `CoreCommands.reportPresence`. */
export interface PresenceReport {
  state: "idle" | "working" | "blocked" | "done" | "error";
  message?: string;
  /** ISO time of the report; defaults to core's clock. */
  at?: string;
  /** The reporting process (the pty's child). */
  pid: number;
}

export interface ReopenTaskInput {
  /**
   * pi-home's "What should Pi do now?" answer. When non-empty it becomes the
   * task's `initialPrompt` and is delivered (once, via `claimInitialPrompt`)
   * as the reopened session's first message; empty = open the session and
   * let the user type.
   */
  objective?: string;
}

export interface RecordTaskSessionInput {
  sessionId: string;
  sessionPath: string;
}

/**
 * Agent choice shared by `createTask` and `launchTask` (see
 * `/docs/new-task-composer.md` "Agent · Model"). Stored on the task;
 * model/thinking reach the harness only on the task's first session.
 */
export interface TaskAgentInput {
  /** Harness id (`HarnessAdapter.id`); absent = the default harness. Fixed for the task's lifetime. */
  harness?: string;
  /** Falls back to `GlobalConfig.launch.defaultModel`, then the harness default. */
  model?: string;
  thinking?: ThinkingLevel;
  /**
   * Paths of images pasted into the prompt (temp files). Core copies each
   * into the task's own state directory and rewrites the prompt to point
   * at the copy, so a parked task never holds a dead temp path.
   */
  attachments?: string[];
}

/** A registered folder outside `codeRoot` (`CoreCommands.listLocations`). */
export interface KnownLocation {
  /** Absolute, realpath-resolved folder path. */
  path: string;
  /** Last path segment, for display. */
  name: string;
  /** Set when the folder is (inside) a git repository: tasks there get a worktree. Absent = runs in place. */
  repositoryId?: string;
}

export interface CreateTaskInput extends TaskAgentInput {
  title: string;
  initialPrompt: string;
  kind?: TaskKind;
  repositoryId?: string;
  /** Clone this URL under `codeRoot` (reused when already there) and use it as the repository. */
  cloneUrl?: string;
  /**
   * A folder path (registered as a known location): a git repository gets a
   * worktree like `repositoryId`; a non-git folder runs in place.
   */
  folderPath?: string;
  /**
   * Nest under this task (`Task.parentTaskId`), like `launchTask`'s `child`
   * relation but without a background launch or kickoff contract. One level
   * only.
   */
  parentTaskId?: string;
  /** Branch the worktree off this ref instead of the repository's default branch. Kept for a parked task. */
  baseRef?: string;
  /** See `LaunchTaskInput.inPlace`. */
  inPlace?: boolean;
  branch?: string;
  targetBranch?: string;
  /**
   * Bind the task to an existing pull request (number, in `repositoryId`):
   * its head branch becomes the task's branch and starting the task
   * checks that head out (`git fetch origin pull/<n>/head`). Needs a
   * repository and GitHub access.
   */
  pullRequest?: number;
  /**
   * With `pullRequest`: `reviewer` (someone else's PR: the task checks out
   * the head and never pushes or opens a PR) or `author`. Default: from
   * GitHub (`viewerDidAuthor`), else `author`.
   */
  role?: PullRequestRole;
  /**
   * pi-home's "Start a new task" vs "Add to Backlog" choice. `true` starts
   * the task right away: it lands in `dev` and, when `repositoryId` is set,
   * its branch + worktree + binding are created now. Absent/`false` parks it
   * in `backlog` with title/prompt/repository stored but no branch or
   * worktree created yet (see `CoreCommands.startTask`).
   */
  start?: boolean;
}

export interface UpdateTaskInput {
  title?: string;
  initialPrompt?: string;
  lastError?: string;
}

export interface ToDoneOptions {
  /**
   * Absolute paths a frontend still has live processes in (e.g. the cwds of
   * its open pty panes). On the question call they decide the "Its terminal
   * pane will be closed." line; once confirmed, the frontend is expected to
   * have closed those processes (it owns them). A worktree still listed
   * here is never removed out from under a live process: the forced
   * cleanup waits for the refresh sweep instead.
   */
  protectedPaths?: string[];
  /**
   * The user's answers to a previous `ToDoneConfirmation`: `confirmed`
   * answers the single "Mark done?" question (everything its lines listed
   * is accepted: the worktree is force-removed, the local branch deleted);
   * `leaveChildren` answers the `activeChildren` question.
   */
  force?: {
    /** Answers the "Mark done?" confirmation (`requiresConfirmation: "done"`). */
    confirmed?: boolean;
    /** Answers the `activeChildren` confirmation: complete the parent anyway, leaving its children running and nested under it. */
    leaveChildren?: boolean;
  };
}

/**
 * A manual Done that needs the user's say-so; the task was NOT moved. Ask,
 * then call `toDone` again with the matching `force` flag (answers
 * accumulate: a confirmed `activeChildren` is followed by `done`).
 */
export interface ToDoneConfirmation {
  requiresConfirmation: "done" | "activeChildren";
  /** Human-readable context for the question (task title, or active-child titles/count). */
  detail: string;
  /**
   * `done` only: the dialog's body, computed up front ("The worktree <path>
   * will be removed.", "N uncommitted changes will be discarded.", "Branch
   * <name> is not merged; the local branch will be deleted.", "Its terminal
   * pane will be closed."); empty for a task without a worktree.
   */
  lines?: string[];
  /** `done` only: the task's worktree is open in a live pane the frontend must close on confirm. */
  closesPane?: boolean;
}

export type ToDoneResult =
  | { task: Task; warning?: string }
  | ToDoneConfirmation;

/** Narrow a `toDone` result to the confirmation-required case. */
export function isToDoneConfirmation(
  result: ToDoneResult,
): result is ToDoneConfirmation {
  return "requiresConfirmation" in result;
}

export interface RefreshOptions {
  /**
   * Same meaning as `ToDoneOptions.protectedPaths`: live pane cwds the
   * refresh must never remove a worktree out from under (rule-driven
   * landing and the done-cleanup retry sweep both honor it).
   */
  protectedPaths?: string[];
}

export interface MoveTaskOptions {
  /** Required when moving to "awaiting"; the reason the task is blocked. */
  awaiting?: AwaitingKind;
}

/** One free-text input an awaiting kind accepts (e.g. Slack's permalink). */
export interface AwaitingKindField {
  /** Key of this field's value in `ToAwaitOptions.inputs`. */
  id: string;
  label: string;
  placeholder?: string;
  optional: boolean;
}

/**
 * One registered awaiting kind as a picker shows it, resolved for a
 * specific task (see `CoreCommands.listAwaitingKinds`): what it is, which
 * inputs it takes, whether it applies to that task, and what entering it
 * will do. Plain data so any frontend can render the same picker.
 */
export interface AwaitingKindOption {
  id: AwaitingKindId;
  label: string;
  /** One-line explanation of the wait. */
  description: string;
  fields: AwaitingKindField[];
  /** Whether `toAwait(taskId, id)` can currently succeed for the task. */
  available: boolean;
  /** Why it is unavailable, when `available` is false. */
  unavailableReason?: string;
  /** The side effect entering it will have for this task (e.g. "Squash-merges PR #12 …"), if any. */
  notice?: string;
}

export interface ToAwaitOptions {
  /** Values for the kind's `AwaitingKindField`s, keyed by field id; blank values are ignored. */
  inputs?: Record<string, string>;
}

export interface DeleteTaskOptions {
  /**
   * Leave the task's worktree (and branch) on disk. By default delete also
   * removes the worktree, its PR-review sibling checkouts, and a merged
   * PR's branch: a deleted task has no reopen path, so anything left behind
   * would be an orphan only the orphan scan could find.
   */
  keepWorkspace?: boolean;
  /**
   * Remove the worktree even with uncommitted changes. Without it a dirty
   * worktree rejects with a clear error and the task is left intact.
   */
  removeDirty?: boolean;
  /**
   * Live pane cwds: a worktree a session still runs in is never removed;
   * the delete rejects instead (close the pane first).
   */
  protectedPaths?: readonly string[];
}

/** A directory under the worktrees root that no workspace binding owns. */
export interface OrphanWorktree {
  path: string;
  /** `undefined` when it couldn't be measured. */
  sizeBytes?: number;
}

/** `CoreCommands.scanOrphanWorktrees` result. */
export interface OrphanWorktreeReport {
  /** The scanned worktrees root (`<codeRoot>/.harbormaster-worktrees`). */
  root: string;
  orphans: OrphanWorktree[];
  /** Set once the orphans cross the count or size threshold: surface it once. */
  warning?: string;
}

/**
 * `CoreCommands.launchTask` input (see `/docs/design-decisions.md "Launching tasks from an agent"`'s "one
 * primitive"): creates a board task and queues it to start running
 * immediately in the background. `relation` must be stated explicitly, no
 * default.
 */
export interface LaunchTaskInput {
  /**
   * `child`: nests under `fromTaskId` (`parentTaskId`), pollable, and a Done
   * parent with this still active asks for confirmation. One level only "-
   * rejects when `fromTaskId`'s task itself has a `parentTaskId`.
   * `standalone`: no lineage, only display-only provenance
   * (`launchedFromTaskId`) when `fromTaskId` is given.
   */
  relation: "child" | "standalone";
  /** Required for `relation: "child"`; optional provenance for `standalone` (a non-task Pi session has none). */
  fromTaskId?: string;
  title: string;
  /** The user's objective; the kickoff contract (see `engines/launch-kickoff.ts`) is appended automatically. */
  prompt: string;
  /**
   * A discovered repository id, a clone URL (cloned under `codeRoot`, reused
   * when already present with the same remote), or `{ none: true }` for a
   * repository-less scratch task.
   */
  repository:
    | { repositoryId: string }
    | { cloneUrl: string }
    | { folderPath: string }
    | { none: true };
  /**
   * `"parent"` (stacked work) is only valid for a `child` whose repository
   * is the same as its parent's, and only once the parent has a branch;
   * the worktree branches off the parent's branch instead of the
   * repository's default branch. Never for `standalone`. Absent/`"default"`
   * branches off the repository's default branch as usual.
   */
  baseBranch?: "default" | "parent";
  /** Branch off this exact ref instead (any branch); mutually exclusive with `baseBranch: "parent"`. */
  baseRef?: string;
  /**
   * The composer's Chat mode (see `/docs/new-task-composer.md`): no
   * worktree. A repository runs in place in its primary checkout (stored as
   * a `folderPath` task with no `repositoryId`, so Done/delete/branch-follow
   * never treat the user's checkout as a task worktree); a folder runs in
   * place as usual.
   */
  inPlace?: boolean;
  /** Falls back to `GlobalConfig.launch.defaultModel`, then the harness default; passed to the harness only on the first launch. */
  model?: string;
  /** Agent (harness id); absent = the launching task's agent for a child, else the repository/global default (decision R8). */
  harness?: string;
  /**
   * Skip the agent's permission prompts in the background session
   * (decision R7); absent = `RepositoryConfig.bypassPermissions`, else
   * `GlobalConfig.launch.bypassPermissions`, else `true`.
   */
  bypassPermissions?: boolean;
  thinking?: ThinkingLevel;
  /** See `TaskAgentInput.attachments`. */
  attachments?: string[];
}

/** Effective launch settings (`CoreCommands.getLaunchSettings`). */
export interface LaunchSettings {
  maxConcurrent: number;
  defaultModel?: string;
  /** The agent a new task gets when none is chosen (decision R8): the repository's override, else the global default, else Pi. */
  defaultHarness: string;
  /** Whether a launched task skips permission prompts unless the launch says otherwise (decision R7): repository override, else global, else `true`. */
  bypassPermissions: boolean;
  /** User-configured "any CLI" agents (`GlobalConfig.agents.custom`), for the app's launch-spec registry. */
  customAgents: CustomAgentConfig[];
}

/** The typed command surface frontends call. No frontend touches state files. */
export interface CoreCommands {
  listBoard(): Promise<BoardColumn[]>;
  getTask(id: string): Promise<Task | undefined>;
  /**
   * Repositories discoverable under the configured `codeRoot` (see
   * `GlobalConfig.codeRoot`), for the task-creation repository picker.
   */
  listRepositories(): Promise<RepositoryInfo[]>;
  /**
   * Folders registered outside `codeRoot` (`addLocation`), in registration
   * order; missing folders are skipped. Git folders also appear in
   * `listRepositories`.
   */
  listLocations(): Promise<KnownLocation[]>;
  /** Register a folder (realpath-resolved, must exist) so every client can target it; idempotent. */
  addLocation(path: string): Promise<KnownLocation>;
  /** Local and remote-tracking branches of a repository, for the base-branch picker. */
  listBranches(repositoryId: string): Promise<string[]>;
  /** One catalog per registered harness, for the composer's Agent · Model picker. */
  listModels(): Promise<HarnessModelCatalog[]>;
  /**
   * The workspace binding for a task, if one was created for it: a git
   * worktree/branch for repository-backed tasks, a scratch directory
   * (`scratch: true`) for started repository-less tasks; `undefined` for
   * parked tasks or tasks whose binding was removed.
   */
  getTaskWorkspace(taskId: string): Promise<WorkspaceBinding | undefined>;
  /**
   * Create a task. With `input.start` it lands in `dev`; otherwise it is
   * parked in `backlog`. When `input.repositoryId` is set the repository is
   * always resolved (unknown ids reject), but the branch/worktree/binding
   * are only created when starting now: derives a branch (`branchPrefix +
   * slug(title) + "-" + first 6 chars of the task id`, unless `input.branch`
   * overrides it), creates a git worktree off the repository's default
   * branch under `.harbormaster-worktrees/`, and persists a
   * `WorkspaceBinding` alongside the task. On any git failure the task is
   * not created (or is rolled back if already persisted) and no orphan
   * worktree is left behind; the triggering error is rethrown as-is.
   * Without `repositoryId` the task defaults to `kind: "temp_task"` and,
   * when starting now, gets a scratch-directory binding (same as
   * `launchTask`'s `{ none: true }`) so pi has somewhere to run.
   */
  createTask(input: CreateTaskInput): Promise<Task>;
  /**
   * The one launch primitive (see `/docs/design-decisions.md "Launching tasks from an agent"`): create a
   * task and queue it to start running in the background. Lands in `dev`
   * with `launch: { status: "queued" }`; `CoreCommands.claimPendingLaunches`
   * is what actually starts it. Rejects an unknown `fromTaskId`, a `child`
   * relation from a task that already has a `parentTaskId` (one level
   * only), and an invalid `baseBranch: "parent"` (not a child, cross-
   * repository, or a parent with no branch yet). A `{ cloneUrl }`
   * repository is cloned under `GlobalConfig.codeRoot` (reused if already
   * checked out with the same remote); `{ none: true }` creates a
   * `temp_task` with a scratch-directory binding instead of a git worktree.
   * Same rollback guarantees as `createTask`/`startTask` for the
   * repository-backed path.
   */
  launchTask(input: LaunchTaskInput): Promise<Task>;
  /**
   * Flip up to `limit` queued launches to `started` (FIFO by
   * `requestedAt`), for the app's background launcher to actually start a
   * pty for. `limit <= 0` returns `[]`. Never returns a task not in `dev`.
   */
  claimPendingLaunches(limit: number): Promise<Task[]>;
  /**
   * Mark launched tasks' still-`started` sessions `interrupted` (app quit
   * mid-turn); unknown ids and tasks not currently `started` are ignored.
   * The marker clears on the task's next `claimSessionLaunch`.
   */
  markLaunchesInterrupted(taskIds: string[]): Promise<void>;
  /** Every task with `parentTaskId === parentTaskId`, any state, oldest first. */
  listChildren(parentTaskId: string): Promise<Task[]>;
  /** Current effective launch settings (`GlobalConfig.launch`, defaulted), for a frontend to show/enforce the concurrency cap without touching config files. */
  getLaunchSettings(repositoryId?: string): Promise<LaunchSettings>;
  /**
   * Start a parked backlog task: for a repository-backed task without a
   * worktree binding, create its branch + worktree + binding now (same
   * derivation and rollback guarantees as `createTask` starting now), then
   * move it to `dev`. Tasks without a repository (or already bound) simply
   * move to `dev`. Rejects for tasks not in `backlog`; on any failure the
   * task stays in `backlog` with no orphan worktree.
   */
  startTask(taskId: string): Promise<Task>;
  /**
   * Move a task to a different board column, validated against allowed
   * transitions. Moving to "awaiting" requires `options.awaiting`; moving out
   * of "awaiting" clears the task's stored reason.
   */
  moveTask(
    id: string,
    state: TaskState,
    options?: MoveTaskOptions,
  ): Promise<Task>;
  /**
   * Hand out the task's `initialPrompt` exactly once, for the first harness
   * session a frontend launches for it: returns the prompt and stamps
   * `initialPromptDeliveredAt`, or `undefined` when the prompt is empty or
   * was already claimed.
   */
  claimInitialPrompt(taskId: string): Promise<string | undefined>;
  /**
   * Decide which harness conversation the task's pane opens, for a
   * frontend that is about to launch the harness (call it only once the
   * harness command is known to be launchable). On the first launch this
   * pre-assigns and persists the session id in the task's workspace
   * binding, so every later launch resumes the same conversation; after a
   * `reopenTask` it hands out the pending fork exactly once. Returns
   * `undefined` when the task has no live worktree binding.
   */
  claimSessionLaunch(taskId: string): Promise<SessionLaunch | undefined>;
  /**
   * Called by the harness process itself on session start: record the
   * persisted session file for the task's bound session id (or adopt the
   * session outright for a legacy binding that has none). A different
   * session id (the user started another conversation in the pane) is
   * ignored — the binding stays authoritative. Returns whether anything was
   * recorded.
   */
  recordTaskSession(
    taskId: string,
    input: RecordTaskSessionInput,
  ): Promise<boolean>;
  /**
   * Reopen a Done task as a new Dev cycle (pi-home's `reopenDoneWork`): a
   * fresh branch + worktree off the repository's default branch, with the
   * previous cycle's conversation forked into the new session on its first
   * launch. If the old worktree is still on disk (cleanup was refused) it
   * is reused as-is with its session. Any failure rolls everything back
   * (no branch, worktree, binding, or state change survives). A missing
   * previous conversation is a `warning`, never a failure.
   */
  reopenTask(
    taskId: string,
    input?: ReopenTaskInput,
  ): Promise<{ task: Task; warning?: string }>;
  /** Patch a task's non-state fields (title, prompt, error) without moving it. */
  updateTaskState(id: string, patch: UpdateTaskInput): Promise<Task>;
  deleteTask(id: string, options?: DeleteTaskOptions): Promise<void>;
  /**
   * The registered awaiting kinds in picker order (the default kind,
   * `review`, first), each resolved against `taskId` when given:
   * availability and the side-effect notice. Without a task every kind is
   * reported available with no notice.
   */
  listAwaitingKinds(taskId?: string): Promise<AwaitingKindOption[]>;
  /**
   * The one "await" verb: move a task to `awaiting` with the given kind,
   * running that kind's `onEnter` action first (see
   * `engines/awaiting-kinds.ts`). Built-ins: `review` pushes the branch and
   * creates or reuses its PR (draft→ready) for a repository-backed task (a
   * repository-less task simply waits); `slack` stores the optional
   * `permalink` input; `deploy` squash-merges a still-open PR and enters the
   * repository's first deployment stage (or the stage-less production wait
   * when it has no pipeline). A failing action leaves the task unmoved.
   * Unknown kinds and illegal transitions reject.
   */
  toAwait(
    taskId: string,
    kindId: AwaitingKindId,
    options?: ToAwaitOptions,
  ): Promise<Task>;
  /**
   * Move a task to `done`; "Done" is final and the worktree housekeeping
   * is the app's. A parent task (`listChildren` non-empty) with any
   * non-done child asks first (`requiresConfirmation: "activeChildren"`)
   * unless `options.force.leaveChildren` is set; children are never touched
   * either way. Then every manual Done asks ONE question
   * (`requiresConfirmation: "done"`, its `lines` computed up front: the
   * worktree that will be removed, uncommitted changes that will be
   * discarded, an unmerged branch that will be deleted, a live pane that
   * will be closed) WITHOUT moving the task. With `force.confirmed` the task
   * moves to Done immediately and records `task.cleanup` (`mode: "forced"`):
   * the worktree is force-removed, the binding parked, review checkouts
   * removed and the local branch deleted. A failed cleanup never blocks the
   * move and never comes back as a `warning`: it is recorded on
   * `task.cleanup` (`attempts`, `lastError`) and the refresh sweep retries
   * it with backoff.
   */
  toDone(taskId: string, options?: ToDoneOptions): Promise<ToDoneResult>;
  /**
   * Run a Done task's forced cleanup (`task.cleanup.mode === "forced"`)
   * right now, ignoring the sweep's backoff (the inbox item's Retry).
   * Resolves with the task as persisted afterwards; a failure is recorded on
   * `task.cleanup`, never thrown.
   */
  retryDoneCleanup(taskId: string, options?: RefreshOptions): Promise<Task>;
  /**
   * Give up on a Done task's cleanup (the inbox item's Dismiss): marks
   * `task.cleanup.mode = "abandoned"` so the sweep stops retrying.
   */
  abandonDoneCleanup(taskId: string): Promise<Task>;
  /**
   * Re-fetch PR status for every repository-backed task with an open PR
   * (a few tasks concurrently), patch `task.pr` onto the task as currently
   * persisted (never a stale snapshot, so a concurrent move is never
   * clobbered), and — when `config.automation` is true — run one rules
   * engine tick: poll the event sources, diff their snapshots into events,
   * and execute the matching rules (`<stateDir>/rules/`; at most one move
   * per task per tick). Repositories
   * without an `origin` remote are skipped silently. Also retries the
   * forced cleanup of confirmed Done tasks (`task.cleanup`, backoff 1 min,
   * 5 min, 30 min, then hourly; silent, failures recorded on the task, never
   * a warning), retries the safe (unforced) cleanup for older done tasks
   * whose worktree is still on disk, and
   * flags `archivedAt` on tasks that have sat in `done` for 7+ days. Emits
   * `board-changed` when anything changed. This is what the app polls; a
   * call made while another refresh is still running joins that run
   * instead of overlapping it. Connectivity-shaped failures (offline, DNS
   * down, connection refused/reset — see `engines/connectivity.ts`) never
   * become per-task warnings: they roll up into `connectivity`, a single
   * marker the app turns into one neutral banner instead of a warning per
   * failed task.
   */
  refresh(options?: RefreshOptions): Promise<RefreshResult>;

  // --- Task messaging (see /docs/task-messaging.md) ---------------------
  // Every messaging command rejects with "messaging is not configured" on a
  // core built without message access (only hand-built managers in tests).

  /**
   * Find tasks by plain words for `sendTaskMessage`: case-insensitive match
   * over title, repository id, branch, PR number (`#412` or `412`) and id
   * prefix (every word of the query must match). Done tasks are left out
   * unless `includeDone`. Each result carries its relation to
   * `options.fromTaskId` and its run state. Sorted by relevance, then
   * recency; `limit` defaults to 20.
   */
  findTasks(
    query: string,
    options?: FindTasksOptions,
  ): Promise<TaskSearchResult[]>;
  /**
   * Send a message to a task (exact id). Core decides the route from
   * lineage; the rules run in order and a violation rejects with an
   * agent-actionable one-line error: sender ≠ target; the target exists and
   * is not Done/Backlog; child → parent needs a live, non-Done parent and a
   * harness that can receive; the target's harness must be able to receive;
   * lineage routes check the loop cap; attachments are validated and copied.
   * Approval-route messages (siblings, unrelated tasks, every non-task
   * sender) start `awaiting_approval`; the rest start `pending`.
   */
  sendTaskMessage(input: SendTaskMessageInput): Promise<SendTaskMessageResult>;
  /**
   * Target side: the task's pending messages, oldest first, atomically
   * marked delivered with the resolved mode (so two concurrent claimers
   * never get the same message). `options.idle=false` and a followUp → left
   * pending (the adapter claims followUps only when idle, so `deliveredAt`
   * is when the agent actually gets it). Messages for a Done/deleted task
   * are marked failed instead of returned.
   */
  claimInboxMessages(
    taskId: string,
    options: { idle: boolean },
  ): Promise<TaskMessage[]>;
  /** Cross-process doorbell for the task's inbox; returns unsubscribe. */
  subscribeInbox(taskId: string, listener: () => void): () => void;
  /** Called by the adapter when the user types into the task's session: resets the loop cap, ends "waiting on parent". */
  recordUserInput(taskId: string): Promise<void>;
  /**
   * Program status from the task's agent (OSC 7501, parsed by the pty owner;
   * decision #18). `working` = a turn is running, `blocked` = "your move",
   * `idle` / `done` = at rest, `error` = at rest with a warning. A report
   * from a new `pid` starts a fresh attachment; pid liveness is the "ended"
   * signal (see `endPresence`).
   */
  reportPresence(taskId: string, report: PresenceReport): Promise<void>;
  /** The task's agent process exited: end its attachment (a reported outcome survives as `ended`). */
  endPresence(
    taskId: string,
    input: { pid: number; at?: string },
  ): Promise<void>;
  /**
   * The agent's own done/blocked verdict (`report_status`), recorded on its
   * still-live attachment: the task shows "your move", not ended. Rejects
   * when the task has no live agent attachment.
   */
  reportTaskOutcome(
    taskId: string,
    outcome: { status: "done" | "blocked"; note?: string },
  ): Promise<void>;
  /** Liveness / turn / outcome snapshot of the task's agent session. */
  getPresence(taskId: string): Promise<PresenceStatus>;
  /** Messages awaiting the user's approval, oldest first. */
  listPendingApprovals(): Promise<TaskMessage[]>;
  /**
   * Approve a message awaiting approval (optionally editing its text/mode):
   * it becomes `pending` for the target. The target is re-checked first: a
   * Done/deleted/Backlog target makes the message `failed` (with
   * `failureReason`) instead. A task sender that can receive gets a
   * `receipt` follow-up with the result.
   */
  approveMessage(
    messageId: string,
    edits?: ApproveMessageEdits,
  ): Promise<TaskMessage>;
  /** Reject a message awaiting approval; a task sender that can receive gets a `receipt` follow-up. */
  rejectMessage(messageId: string): Promise<TaskMessage>;
  /**
   * Task ids with deliverable (pending) messages, for the app's wake pass.
   * Messages whose target is Done/deleted are marked failed along the way
   * and never listed.
   */
  listTasksWithPendingMessages(): Promise<string[]>;
  /** Derived chip state per task (only tasks with something to report), evaluated at the core clock's now. */
  getMessagingStates(): Promise<TaskMessagingState[]>;
  /** Every message oldest first; `filter.taskId` keeps those sent to or by that task. */
  listMessages(filter?: { taskId?: string }): Promise<TaskMessage[]>;
  /** The bytes of a message attachment's stored copy (rejects when pruned or out of range). */
  readMessageAttachment(
    messageId: string,
    index: number,
  ): Promise<{ mimeType?: string; base64: string }>;
  /** Removes attachment files per decision 12; returns how many messages were pruned. */
  pruneMessageAttachments(): Promise<number>;
  /**
   * Directories under `<codeRoot>/.harbormaster-worktrees` that no
   * workspace binding owns (crashed launches, deleted tasks, agent-made
   * checkouts, leaking tests), each sized with `du`. Slow (walks every
   * orphan): run it rarely, off the refresh tick. Read-only.
   */
  scanOrphanWorktrees(): Promise<OrphanWorktreeReport>;

  // --- Rules engine (see docs/release-plan.md "Rules engine") ------------

  /**
   * The rules audit log (every event and every action outcome, with rule
   * id, file and line), oldest first; `filter.taskId` keeps entries about
   * one task, `filter.since` (ISO or `YYYY-MM-DD`) bounds it, `limit`
   * (default 500) keeps the newest entries.
   */
  listEvents(filter?: ListEventsFilter): Promise<AuditEntry[]>;
  /**
   * Dry run: the current rules over recorded events (`replayFrom`, ISO or
   * `YYYY-MM-DD`; default everything retained), optionally one task's,
   * evaluated against current task state and facts. Executes nothing.
   */
  rulesCheck(input?: RulesCheckInput): Promise<RulesCheckResult>;
  /** Every rules file as currently loaded, with its problems (a file with problems contributes no rules). */
  listRules(): Promise<RulesListing>;
  /** The built-in sources (read-only) and every user addon, loaded or skipped with its problems. */
  listAddons(): Promise<AddonInfo[]>;

  // --- Inbox --------------------------------------------------------------

  /** Unresolved, unsnoozed inbox items oldest first (options include the rest). */
  listInbox(options?: ListInboxOptions): Promise<InboxItem[]>;
  /**
   * Resolve an inbox item, optionally by pressing one of its buttons:
   * `createTask` creates the pre-filled task, `openTask` returns the task to
   * open, `snooze` hides it (`with.until`, default 1 hour) without
   * resolving, `dismiss`/none just resolves. Emits `inbox-changed`.
   */
  resolveInboxItem(
    itemId: string,
    options?: ResolveInboxItemOptions,
  ): Promise<ResolveInboxItemResult>;
  /**
   * Priority / Other for each item (same order): `GlobalConfig.inbox
   * .priorityFilter` (CEL over `item`) when set, else each item's own
   * `priority`. A filter that fails or returns a non-boolean keeps the
   * default for that item. Shared so the app and `harbormaster inbox` agree.
   */
  evaluateInboxPriority(items: InboxPriorityInput[]): Promise<boolean[]>;
  /**
   * Tasks a rule tried to land (`move: done`) but could not (dirty
   * worktree, live pane): "deployed and ready to land, mark it Done".
   */
  listReadyToLand(): Promise<ReadyToLandEntry[]>;
  /**
   * The `createTask` rule action as a command (the inbox's "Create review
   * task", the composer's PR URL): a PR URL (or number with `repository`)
   * makes a PR-bound task (`role: reviewer` checks out the PR head and
   * never pushes); otherwise a plain task in `repository`.
   */
  createTaskFromAction(input: CreateTaskActionInput): Promise<Task>;
  /**
   * Look up a pasted PR URL for the new-task composer's PR card (number,
   * title, author, head → base, whether the viewer authored it) through
   * GitHub access. Rejects with a readable message when the URL is not a PR,
   * the repository has no local checkout, or GitHub cannot be reached.
   */
  previewPullRequest(url: string): Promise<PullRequestPreview>;

  // --- Onboarding (docs/release-plan.md "Onboarding (four screens)") ----

  /** What the first-run wizard starts from (and whether it was finished). */
  getOnboardingState(): Promise<OnboardingState>;
  /**
   * Git repositories directly under `path` (a candidate code root, "~"
   * expanded), plus whether it is a macOS-protected folder. Read-only.
   */
  scanCodeRoot(path: string): Promise<CodeRootScan>;
  /**
   * Save `codeRoot` (an existing folder; `options.create` makes it first,
   * for "Use ~/Code instead"); returns the scan of the saved root.
   */
  setCodeRoot(
    path: string,
    options?: { create?: boolean },
  ): Promise<CodeRootScan>;
  /** `pi --version` / `claude --version`, each with a short timeout. */
  detectAgents(): Promise<DetectedAgent[]>;
  /**
   * Save the default agent (`launch.defaultHarness`), optionally adding a
   * custom CLI agent (`agents.custom[]`, validated: an id that is not a
   * built-in) and the launch permission bypass (`launch.bypassPermissions`).
   */
  setDefaultAgent(input: SetDefaultAgentInput): Promise<OnboardingState>;
  /** `gh auth status` with a short timeout: installed, logged in, which account. */
  githubAuthStatus(): Promise<GithubAuthStatus>;
  /** Turn an event source on or off (`sources.<id>.enabled`; e.g. `github`). */
  setSourceEnabled(sourceId: string, enabled: boolean): Promise<void>;
  /** Write the default `rules.yaml` when missing (never overwrites). */
  ensureDefaultRules(): Promise<{ created: boolean }>;
  /** Stamp `onboardingCompletedAt`: the wizard does not show again. */
  completeOnboarding(): Promise<OnboardingState>;
}

export interface RefreshResult {
  warnings: string[];
  /** Present only when one or more checks this tick failed as a connectivity error. */
  connectivity?: { offline: true; failedChecks: number };
}
