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
}
