// Command API input/output shapes — the inbound half of "commands in, state
// events out". Kept separate from model.ts because these are call-shape
// contracts, not persisted domain data.

import type {
  AwaitingKind,
  BoardColumn,
  Task,
  TaskKind,
  TaskState,
  WorkspaceBinding,
} from "./model.js";
import type { RepositoryInfo } from "./workspace.js";

export interface CreateTaskInput {
  title: string;
  initialPrompt: string;
  kind?: TaskKind;
  repositoryId?: string;
  branch?: string;
  targetBranch?: string;
}

export interface UpdateTaskInput {
  title?: string;
  initialPrompt?: string;
  lastError?: string;
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
   * When `input.repositoryId` is set, resolves the repository, derives a
   * branch (`branchPrefix + slug(title) + "-" + first 6 chars of the task
   * id`, unless `input.branch` overrides it), creates a git worktree off the
   * repository's default branch under `.harbormaster-worktrees/`, and
   * persists a `WorkspaceBinding` alongside the task. On any git failure the
   * task is not created (or is rolled back if already persisted) and no
   * orphan worktree is left behind; the triggering error is rethrown as-is.
   */
  createTask(input: CreateTaskInput): Promise<Task>;
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
   * Move a task to `done`. Attempts the safe cleanup path first (remove the
   * worktree if clean, delete the branch if its PR is merged); any refusal
   * (dirty worktree, unmerged branch, missing repository) never blocks the
   * move — the task still lands in `done` and the refusal surfaces as
   * `warning` in the result instead of throwing.
   */
  toDone(taskId: string): Promise<{ task: Task; warning?: string }>;
  /**
   * Re-fetch PR status for every repository-backed task with an open PR,
   * update `task.pr`, and — when `config.automation` is true — let the
   * configured movers propose at most one board move per task. Also flags
   * `archivedAt` on tasks that have sat in `done` for 7+ days. Emits
   * `board-changed` when anything changed. This is what the app polls.
   */
  refresh(): Promise<{ warnings: string[] }>;
}
