// Manager: orchestrates the task-board workflow (sequence of use cases),
// delegating storage to Resource Access and board-move rules to the
// transition Engine. This is the one and only implementation of
// `CoreCommands`; frontends never see anything beneath this layer.

import type {
  CoreCommands,
  CreateTaskInput,
  DeleteTaskOptions,
  MoveTaskOptions,
  UpdateTaskInput,
} from "../contracts/commands.js";
import type {
  BoardColumn,
  Task,
  TaskState,
  WorkspaceBinding,
} from "../contracts/model.js";
import { TASK_STATES } from "../contracts/model.js";
import type {
  Clock,
  ConfigAccess,
  IdGenerator,
  TaskStateAccess,
  WorkspaceBindingAccess,
} from "../contracts/services.js";
import type {
  GitRepositoryAccess,
  GitWorktreeAccess,
  RepositoryInfo,
} from "../contracts/workspace.js";
import { groupColumnTasks } from "../engines/board-grouping.js";
import { assertAllowedTransition } from "../engines/task-transitions.js";
import { deriveTaskBranch } from "../engines/task-workspace.js";
import type { CoreEventBus } from "../utilities/event-bus.js";

export interface CoreManagerDependencies {
  tasks: TaskStateAccess;
  clock: Clock;
  ids: IdGenerator;
  events: CoreEventBus;
  config: ConfigAccess;
  repositories: GitRepositoryAccess;
  worktrees: GitWorktreeAccess;
  bindings: WorkspaceBindingAccess;
}

const COLUMN_TITLES: Record<TaskState, string> = {
  backlog: "Backlog",
  dev: "Dev",
  awaiting: "Awaiting",
  done: "Done",
};

export class CoreManager implements CoreCommands {
  constructor(private readonly deps: CoreManagerDependencies) {}

  async listBoard(): Promise<BoardColumn[]> {
    const tasks = await this.deps.tasks.listTasks();
    return TASK_STATES.map((state) => {
      const columnTasks = tasks.filter((task) => task.state === state);
      return {
        state,
        title: COLUMN_TITLES[state],
        groups: groupColumnTasks(state, columnTasks),
      };
    });
  }

  async getTask(id: string): Promise<Task | undefined> {
    return this.deps.tasks.getTask(id);
  }

  async listRepositories(): Promise<RepositoryInfo[]> {
    const config = await this.deps.config.load();
    return this.deps.repositories.discoverRepositories(config.codeRoot ?? "");
  }

  async getTaskWorkspace(
    taskId: string,
  ): Promise<WorkspaceBinding | undefined> {
    return this.deps.bindings.getBindingForTask(taskId);
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const now = this.deps.clock.now().toISOString();
    const id = this.deps.ids.next();

    let repo: RepositoryInfo | undefined;
    let branch = input.branch;
    let targetBranch = input.targetBranch;
    let worktreePath: string | undefined;

    if (input.repositoryId !== undefined) {
      const config = await this.deps.config.load();
      const repos = await this.deps.repositories.discoverRepositories(
        config.codeRoot ?? "",
      );
      repo = repos.find((candidate) => candidate.id === input.repositoryId);
      if (!repo) {
        throw new Error(`Repository not found: ${input.repositoryId}`);
      }
      branch ??= deriveTaskBranch(input.title, id, config.branchPrefix ?? "");
      targetBranch ??= repo.defaultBranch;
      // Any failure here (branch collision, dirty baseRef, missing repo,
      // ...) must leave no task and no orphan worktree — createTaskWorktree
      // itself guarantees no leftover directory/bookkeeping on failure, so
      // there is nothing to clean up on this path beyond rethrowing.
      const worktree = await this.deps.worktrees.createTaskWorktree(
        repo,
        branch,
        repo.defaultBranch,
      );
      worktreePath = worktree.path;
    }

    const task: Task = {
      id,
      kind: input.kind ?? "task",
      state: "backlog",
      title: input.title,
      initialPrompt: input.initialPrompt,
      ...(input.repositoryId !== undefined
        ? { repositoryId: input.repositoryId }
        : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(targetBranch !== undefined ? { targetBranch } : {}),
      createdAt: now,
      updatedAt: now,
      stateChangedAt: now,
    };

    try {
      await this.deps.tasks.createTask(task);
    } catch (error) {
      if (repo && worktreePath) {
        await this.deps.worktrees
          .removeWorktree(repo, worktreePath, true)
          .catch(() => {});
      }
      throw error;
    }

    if (repo && worktreePath && branch) {
      const binding: WorkspaceBinding = {
        id: this.deps.ids.next(),
        taskId: id,
        worktreePath,
        branch,
        detached: false,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await this.deps.bindings.attachBinding(binding);
      } catch (error) {
        // Roll back the task and the worktree: no task may exist without a
        // consistent binding once a repository was involved.
        await this.deps.tasks.removeTask(id).catch(() => {});
        await this.deps.worktrees
          .removeWorktree(repo, worktreePath, true)
          .catch(() => {});
        throw error;
      }
    }

    await this.publishTaskChange(task);
    return task;
  }

  async moveTask(
    id: string,
    state: TaskState,
    options?: MoveTaskOptions,
  ): Promise<Task> {
    const task = await this.requireTask(id);
    assertAllowedTransition(task.state, state);
    if (state === "awaiting" && !options?.awaiting) {
      throw new Error(
        'Moving a task to "awaiting" requires an awaiting reason',
      );
    }
    const now = this.deps.clock.now().toISOString();
    const stateChanged = task.state !== state;
    const next: Task = {
      ...task,
      state,
      updatedAt: now,
      stateChangedAt: stateChanged ? now : task.stateChangedAt,
      ...(state === "done" ? { completedAt: task.completedAt ?? now } : {}),
    };
    if (state === "awaiting" && options?.awaiting) {
      next.awaiting = options.awaiting;
    } else {
      delete next.awaiting;
    }
    await this.deps.tasks.replaceTask(next);
    await this.publishTaskChange(next);
    return next;
  }

  async updateTaskState(id: string, patch: UpdateTaskInput): Promise<Task> {
    const task = await this.requireTask(id);
    const now = this.deps.clock.now().toISOString();
    const next: Task = { ...task, ...patch, updatedAt: now };
    await this.deps.tasks.replaceTask(next);
    await this.publishTaskChange(next);
    return next;
  }

  async deleteTask(id: string, options?: DeleteTaskOptions): Promise<void> {
    const task = await this.requireTask(id);
    if (options?.removeWorkspace) {
      const binding = await this.deps.bindings.getBindingForTask(id);
      if (binding?.worktreePath && task.repositoryId) {
        const config = await this.deps.config.load();
        const repos = await this.deps.repositories.discoverRepositories(
          config.codeRoot ?? "",
        );
        const repo = repos.find(
          (candidate) => candidate.id === task.repositoryId,
        );
        if (repo) {
          // Dirty-refusal (see GitWorktreeAccess.removeWorktree) propagates
          // as-is: the task is left intact rather than deleted out from
          // under an unremoved worktree.
          await this.deps.worktrees.removeWorktree(repo, binding.worktreePath);
        }
      }
    }
    await this.deps.bindings.removeBinding(id).catch(() => {});
    await this.deps.tasks.removeTask(id);
    await this.publishBoard();
  }

  private async requireTask(id: string): Promise<Task> {
    const task = await this.deps.tasks.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }

  private async publishTaskChange(task: Task): Promise<void> {
    this.deps.events.emit("task-changed", { task });
    await this.publishBoard();
  }

  private async publishBoard(): Promise<void> {
    const columns = await this.listBoard();
    this.deps.events.emit("board-changed", { columns });
  }
}
