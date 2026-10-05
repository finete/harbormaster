// Command API input/output shapes — the inbound half of "commands in, state
// events out". Kept separate from model.ts because these are call-shape
// contracts, not persisted domain data.

import type {
  AwaitingKind,
  BoardColumn,
  Task,
  TaskKind,
  TaskState,
} from "./model.js";

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

/** The typed command surface frontends call. No frontend touches state files. */
export interface CoreCommands {
  listBoard(): Promise<BoardColumn[]>;
  getTask(id: string): Promise<Task | undefined>;
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
  deleteTask(id: string): Promise<void>;
}
