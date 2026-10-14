// Command API input/output shapes — the inbound half of "commands in, state
// events out". Kept separate from model.ts because these are call-shape
// contracts, not persisted domain data.

import type { SessionLaunch } from "./harness.js";
import type {
  AwaitingKind,
  BoardColumn,
  Task,
  TaskKind,
  TaskState,
  WorkspaceBinding,
} from "./model.js";
import type { RepositoryInfo } from "./workspace.js";

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

export interface CreateTaskInput {
  title: string;
  initialPrompt: string;
  kind?: TaskKind;
  repositoryId?: string;
  branch?: string;
  targetBranch?: string;
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
   * its open pty panes). When the task's worktree path is in this list the
   * worktree is left in place (surfaced as `warning`, never a failure) so a
   * running shell/agent never has its cwd deleted out from under it.
   */
  protectedPaths?: string[];
  /**
   * The user's answers to a previous `ToDoneConfirmation` (pi-home's
   * "Discard uncommitted changes?" / "Delete unmerged task workspace?"):
   * `removeDirty` force-removes a worktree with uncommitted changes,
   * `deleteUnmerged` removes the worktree and force-deletes (`-D`) a branch
   * whose PR never merged. Never overrides `protectedPaths`.
   */
  force?: { removeDirty?: boolean; deleteUnmerged?: boolean };
}

/**
 * A manual Done that needs the user's say-so before destroying work; the
 * task was NOT moved. Ask, then call `toDone` again with the matching
 * `force` flag (answers accumulate: a confirmed `dirty` may be followed by
 * `unmerged`).
 */
export interface ToDoneConfirmation {
  requiresConfirmation: "dirty" | "unmerged";
  /** Human-readable context for the question (task title, worktree path). */
  detail: string;
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
   * refresh must never remove a worktree out from under (mover-driven
   * landing and the done-cleanup retry sweep both honor it).
   */
  protectedPaths?: string[];
}

export interface MoveTaskOptions {
  /** Required when moving to "awaiting"; the reason the task is blocked. */
  awaiting?: AwaitingKind;
}

export interface DeleteTaskOptions {
  /**
   * Also remove the task's git worktree (if any) and its workspace binding.
   * Removal honors dirty-refusal (see `GitWorktreeAccess.removeWorktree`);
   * a dirty worktree surfaces a clear error instead of silently skipping
   * cleanup, and the task itself is left deleted either way only once
   * worktree removal (when requested) has actually succeeded.
   */
  removeWorkspace?: boolean;
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
   * The git worktree/branch binding for a task, if one was created for it
   * (repository-backed tasks only; `undefined` for scratch tasks or tasks
   * whose binding was removed).
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
   */
  createTask(input: CreateTaskInput): Promise<Task>;
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
   * Push the task's branch, create or reuse its pull request (draft→ready
   * reuse semantics: an existing draft is marked ready, otherwise a fresh PR
   * is opened), store `task.pr`, and move the task to `awaiting` /
   * `{ kind: "review" }`. Requires a repository-backed task with a bound
   * worktree and branch.
   */
  toReview(taskId: string): Promise<Task>;
  /**
   * Move a task to `done`, cleaning up its workspace (pi-home's `complete`):
   * remove the worktree and delete the branch. Destroying work needs the
   * user's confirmation first: a worktree with uncommitted changes, or a
   * branch whose PR never merged, returns a `ToDoneConfirmation` WITHOUT
   * moving the task (answer via `options.force` on the next call). A
   * merged PR's branch is deleted with `-D` without asking. A worktree in
   * `options.protectedPaths` (a live pane's cwd) is never touched and never
   * asked about: the task lands with a `warning` and refresh retries the
   * cleanup once the pane is gone. Other failures (missing repository, git
   * errors) never block the move either; they surface as `warning`.
   */
  toDone(taskId: string, options?: ToDoneOptions): Promise<ToDoneResult>;
  /**
   * Re-fetch PR status for every repository-backed task with an open PR
   * (a few tasks concurrently), patch `task.pr` onto the task as currently
   * persisted (never a stale snapshot, so a concurrent move is never
   * clobbered), and — when `config.automation` is true — let the
   * configured movers propose at most one board move per task. Repositories
   * without an `origin` remote are skipped silently. Also retries the safe
   * worktree cleanup for done tasks whose worktree is still on disk, and
   * flags `archivedAt` on tasks that have sat in `done` for 7+ days. Emits
   * `board-changed` when anything changed. This is what the app polls; a
   * call made while another refresh is still running joins that run
   * instead of overlapping it.
   */
  refresh(options?: RefreshOptions): Promise<{ warnings: string[] }>;
}
