// Manager: orchestrates the task-board workflow (sequence of use cases),
// delegating storage to Resource Access and board-move rules to the
// transition Engine. This is the one and only implementation of
// `CoreCommands`; frontends never see anything beneath this layer.

import type {
  BoardMove,
  MoverHelpers,
  MoverInput,
  MoverTaskView,
} from "../contracts/addons.js";
import { DEFAULT_MOVER_ORDER } from "../contracts/addons.js";
import type {
  CoreCommands,
  CreateTaskInput,
  DeleteTaskOptions,
  MoveTaskOptions,
  UpdateTaskInput,
} from "../contracts/commands.js";
import type {
  PullRequestAccess,
  PullRequestStatus,
  VersionAccess,
} from "../contracts/github.js";
import type {
  BoardColumn,
  GlobalConfig,
  Task,
  TaskPullRequest,
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
import { shouldArchive, shouldDeleteBranch } from "../engines/cleanup.js";
import {
  arbitrateMove,
  builtinHooks,
  builtinMovers,
} from "../engines/movers/index.js";
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
  pullRequests: PullRequestAccess;
  versions: VersionAccess;
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

  async toReview(taskId: string): Promise<Task> {
    const task = await this.requireTask(taskId);
    assertAllowedTransition(task.state, "awaiting");
    if (!task.repositoryId || !task.branch) {
      throw new Error(
        `toReview requires a repository-backed task with a branch: ${taskId}`,
      );
    }
    const repo = await this.findRepository(task.repositoryId);
    const binding = await this.deps.bindings.getBindingForTask(taskId);
    if (!binding?.worktreePath) {
      throw new Error(`No worktree bound for task: ${taskId}`);
    }
    await this.deps.worktrees.pushBranch(binding.worktreePath, task.branch);
    const status = await this.deps.pullRequests.ensureOpen(
      task.repositoryId,
      task.branch,
      binding.worktreePath,
      task.title,
      task.initialPrompt,
      task.targetBranch ?? repo.defaultBranch,
    );
    const now = this.deps.clock.now().toISOString();
    const stateChanged = task.state !== "awaiting";
    const next: Task = {
      ...task,
      pr: toTaskPullRequest(status),
      state: "awaiting",
      awaiting: { kind: "review" },
      updatedAt: now,
      stateChangedAt: stateChanged ? now : task.stateChangedAt,
    };
    await this.deps.tasks.replaceTask(next);
    await this.publishTaskChange(next);
    return next;
  }

  async toDone(taskId: string): Promise<{ task: Task; warning?: string }> {
    const task = await this.requireTask(taskId);
    assertAllowedTransition(task.state, "done");
    return this.executeSafeDone(task);
  }

  async refresh(): Promise<{ warnings: string[] }> {
    const config = await this.deps.config.load();
    const tasks = await this.deps.tasks.listTasks();
    const warnings: string[] = [];
    let changed = false;

    for (const task of tasks) {
      if (
        task.kind !== "task" ||
        task.state === "backlog" ||
        task.state === "done" ||
        !task.repositoryId ||
        !task.branch
      ) {
        continue;
      }
      let current = task;
      try {
        const status = await this.deps.pullRequests.status(
          task.repositoryId,
          task.branch,
        );
        if (status) {
          const pr = toTaskPullRequest(status);
          if (!prEquals(current.pr, pr)) {
            const now = this.deps.clock.now().toISOString();
            current = { ...current, pr, updatedAt: now };
            await this.deps.tasks.replaceTask(current);
            changed = true;
          }
        }
      } catch (error) {
        warnings.push(`${task.title}: ${describeError(error)}`);
        // Errors never move anything: skip the mover step for this task too.
        continue;
      }

      if (!config.automation) continue;
      try {
        const moved = await this.applyMoverStep(current, config, warnings);
        if (moved) changed = true;
      } catch (error) {
        warnings.push(`${task.title}: ${describeError(error)}`);
      }
    }

    if (await this.archiveDoneTasks()) changed = true;
    if (changed) await this.publishBoard();
    return { warnings };
  }

  /** One addon-decided board move per task, at most, per `refresh()` call. */
  private async applyMoverStep(
    task: Task,
    config: GlobalConfig,
    warnings: string[],
  ): Promise<boolean> {
    const pipeline = task.repositoryId
      ? config.repositories?.[task.repositoryId]?.deployment
      : undefined;
    const view: MoverTaskView = {
      id: task.id,
      kind: task.kind,
      state: task.state,
      ...(task.awaiting ? { awaiting: task.awaiting } : {}),
      ...(task.branch ? { branch: task.branch } : {}),
      ...(task.repositoryId ? { repositoryId: task.repositoryId } : {}),
      ...(task.pr ? { pr: task.pr } : {}),
    };
    const input: MoverInput = { task: view, ...(pipeline ? { pipeline } : {}) };
    const helpers = this.moverHelpers(task.repositoryId);
    const order =
      config.movers.length > 0 ? config.movers : DEFAULT_MOVER_ORDER;
    const movers = order
      .map((name) => [name, builtinMovers[name]] as const)
      .filter((entry): entry is [string, (typeof builtinMovers)[string]] =>
        Boolean(entry[1]),
      );
    const decision = await arbitrateMove(input, helpers, movers);
    warnings.push(...decision.warnings);
    if (decision.move.type === "stay") return false;
    await this.executeMove(task, decision.move, warnings);
    return true;
  }

  private moverHelpers(repositoryId: string | undefined): MoverHelpers {
    const helpers: MoverHelpers = {
      fetchText: (url) => this.deps.versions.fetchText(url),
      containsCommit: (ancestorOid, descendantOid) => {
        if (!repositoryId) {
          throw new Error(
            "Commit comparison requires a repository-backed task",
          );
        }
        return this.deps.pullRequests.containsCommit(
          repositoryId,
          ancestorOid,
          descendantOid,
        );
      },
      commitLog: (startOid, limit) => {
        if (!repositoryId) {
          throw new Error("Commit history requires a repository-backed task");
        }
        return this.deps.pullRequests.commitLog(repositoryId, startOid, limit);
      },
      runHook: async (name, hookInput) => {
        const hook = builtinHooks[name];
        if (!hook) throw new Error(`Stage hook "${name}" is not registered`);
        return hook.check(hookInput, helpers);
      },
    };
    return helpers;
  }

  private async executeMove(
    task: Task,
    move: BoardMove,
    warnings: string[],
  ): Promise<void> {
    switch (move.type) {
      case "dev":
        await this.moveTask(task.id, "dev");
        return;
      case "review":
        await this.moveTask(task.id, "awaiting", {
          awaiting: { kind: "review" },
        });
        return;
      case "deploy":
        await this.moveTask(task.id, "awaiting", {
          awaiting: {
            kind: "deploy",
            stageId: move.stageId,
            stageLabel: move.stageLabel,
          },
        });
        return;
      case "done": {
        const result = await this.executeSafeDone(task);
        if (result.warning) {
          warnings.push(`${task.title}: ${result.warning}`);
        }
        return;
      }
    }
  }

  /**
   * The done safe path: remove the worktree if clean, delete the branch if
   * its PR is merged. Any refusal (dirty worktree, unmerged branch, missing
   * repository/binding) never blocks the move to `done` \u2014 it surfaces as a
   * warning in the result instead.
   */
  private async executeSafeDone(
    task: Task,
  ): Promise<{ task: Task; warning?: string }> {
    let warning: string | undefined;
    if (task.repositoryId && task.branch) {
      try {
        const repo = await this.findRepository(task.repositoryId);
        const binding = await this.deps.bindings.getBindingForTask(task.id);
        if (binding?.worktreePath) {
          try {
            await this.deps.worktrees.removeWorktree(
              repo,
              binding.worktreePath,
              false,
            );
            await this.deps.bindings.removeBinding(task.id);
          } catch (error) {
            warning = `worktree left in place: ${describeError(error)}`;
          }
          if (shouldDeleteBranch(task.pr)) {
            try {
              await this.deps.worktrees.deleteBranch(repo, task.branch, false);
            } catch (error) {
              const branchWarning = `branch left in place: ${describeError(error)}`;
              warning = warning
                ? `${warning}; ${branchWarning}`
                : branchWarning;
            }
          }
        }
      } catch (error) {
        warning = describeError(error);
      }
    }
    const now = this.deps.clock.now().toISOString();
    const next: Task = {
      ...task,
      state: "done",
      updatedAt: now,
      stateChangedAt: now,
      completedAt: task.completedAt ?? now,
    };
    delete next.awaiting;
    await this.deps.tasks.replaceTask(next);
    await this.publishTaskChange(next);
    return { task: next, ...(warning ? { warning } : {}) };
  }

  private async archiveDoneTasks(): Promise<boolean> {
    const tasks = await this.deps.tasks.listTasks();
    const now = this.deps.clock.now();
    let changed = false;
    for (const task of tasks) {
      if (shouldArchive(task, now)) {
        await this.deps.tasks.replaceTask({
          ...task,
          archivedAt: now.toISOString(),
        });
        changed = true;
      }
    }
    return changed;
  }

  private async findRepository(repositoryId: string): Promise<RepositoryInfo> {
    const config = await this.deps.config.load();
    const repos = await this.deps.repositories.discoverRepositories(
      config.codeRoot ?? "",
    );
    const repo = repos.find((candidate) => candidate.id === repositoryId);
    if (!repo) throw new Error(`Repository not found: ${repositoryId}`);
    return repo;
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

function toTaskPullRequest(status: PullRequestStatus): TaskPullRequest {
  const state: TaskPullRequest["state"] =
    status.state === "MERGED"
      ? "merged"
      : status.state === "CLOSED"
        ? "closed"
        : status.isDraft
          ? "draft"
          : "open";
  return {
    number: status.number,
    url: status.url,
    state,
    ...(status.reviewDecision ? { reviewDecision: status.reviewDecision } : {}),
    ...(status.changesRequestedOnHead === undefined
      ? {}
      : { changesRequestedOnHead: status.changesRequestedOnHead }),
    ...(status.humanFeedbackOnHead === undefined
      ? {}
      : { humanFeedbackOnHead: status.humanFeedbackOnHead }),
    reviewRequested: status.reviewRequested,
    reviewSubmitted: status.reviewSubmitted,
    ...(status.headRefOid ? { headRefOid: status.headRefOid } : {}),
    ...(status.mergeCommit
      ? {
          mergeCommit: {
            oid: status.mergeCommit.oid,
            targetBranch: status.mergeCommit.targetBranch,
          },
        }
      : {}),
  };
}

function prEquals(a: TaskPullRequest | undefined, b: TaskPullRequest): boolean {
  if (!a) return false;
  return (
    a.number === b.number &&
    a.state === b.state &&
    a.reviewDecision === b.reviewDecision &&
    a.changesRequestedOnHead === b.changesRequestedOnHead &&
    a.humanFeedbackOnHead === b.humanFeedbackOnHead &&
    a.reviewRequested === b.reviewRequested &&
    a.reviewSubmitted === b.reviewSubmitted &&
    a.headRefOid === b.headRefOid &&
    a.mergeCommit?.oid === b.mergeCommit?.oid &&
    a.mergeCommit?.targetBranch === b.mergeCommit?.targetBranch
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
