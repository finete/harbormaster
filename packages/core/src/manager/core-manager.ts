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
import type {
  AwaitingKindOption,
  CoreCommands,
  CreateTaskInput,
  DeleteTaskOptions,
  MoveTaskOptions,
  RecordTaskSessionInput,
  RefreshOptions,
  RefreshResult,
  ReopenTaskInput,
  ToAwaitOptions,
  ToDoneConfirmation,
  ToDoneOptions,
  ToDoneResult,
  UpdateTaskInput,
} from "../contracts/commands.js";
import type {
  PullRequestAccess,
  PullRequestStatus,
  VersionAccess,
} from "../contracts/github.js";
import type { SessionLaunch } from "../contracts/harness.js";
import type {
  AwaitingKindId,
  BoardColumn,
  DeploymentStageConfig,
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
  SessionFileAccess,
  TaskStateAccess,
  WorkspaceBindingAccess,
} from "../contracts/services.js";
import type {
  GitRepositoryAccess,
  GitWorktreeAccess,
  RepositoryInfo,
} from "../contracts/workspace.js";
import {
  builtinAwaitingKinds,
  describeAwaitingKind,
  findAwaitingKind,
  normalizeAwaitingInputs,
} from "../engines/awaiting-kinds.js";
import { groupColumnTasks } from "../engines/board-grouping.js";
import { shouldArchive, shouldDeleteBranch } from "../engines/cleanup.js";
import { isConnectivityError } from "../engines/connectivity.js";
import {
  activeMoverOrder,
  arbitrateMove,
  automationConfigProblems,
  builtinAutomationNames,
  builtinHooks,
  builtinMovers,
  effectivePipeline,
} from "../engines/movers/index.js";
import {
  assertAllowedTransition,
  assertMayReturnToDev,
} from "../engines/task-transitions.js";
import { deriveTaskBranch } from "../engines/task-workspace.js";
import { forEachConcurrently } from "../utilities/concurrency.js";
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
  /** Existence checks for harness session files before resuming/forking them. */
  sessions: SessionFileAccess;
  pullRequests: PullRequestAccess;
  versions: VersionAccess;
}

const COLUMN_TITLES: Record<TaskState, string> = {
  backlog: "Backlog",
  dev: "Dev",
  awaiting: "Awaiting",
  done: "Done",
};

/** PR observations in flight at once during `refresh()` (pi-home parity). */
const REFRESH_CONCURRENCY = 4;

export class CoreManager implements CoreCommands {
  /** The running `refresh()`, joined by any call made while it runs. */
  private refreshInFlight: Promise<RefreshResult> | undefined;
  /** Serialized config whose problems were last reported (once per distinct config). */
  private lastValidatedConfig: string | undefined;
  /** Last reported done-cleanup retry failure per task (dedupe). */
  private readonly cleanupWarnings = new Map<string, string>();

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
    return this.deps.repositories.discoverRepositories(
      config.codeRoot ?? "",
      preferredCheckoutsFromConfig(config),
    );
  }

  async getTaskWorkspace(
    taskId: string,
  ): Promise<WorkspaceBinding | undefined> {
    return this.deps.bindings.getBindingForTask(taskId);
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const now = this.deps.clock.now().toISOString();
    const id = this.deps.ids.next();
    const startNow = input.start === true;

    let repo: RepositoryInfo | undefined;
    let branch = input.branch;
    let targetBranch = input.targetBranch;

    if (input.repositoryId !== undefined) {
      const config = await this.deps.config.load();
      repo = await this.findRepository(input.repositoryId, config);
      // A parked (backlog) task records only what it will need later: the
      // branch is derived when it is actually started (`startTask`), so a
      // parked task never reserves a git ref.
      if (startNow) {
        branch ??= deriveTaskBranch(input.title, id, config.branchPrefix ?? "");
      }
      targetBranch ??= repo.defaultBranch;
    }

    const task: Task = {
      id,
      kind: input.kind ?? "task",
      state: startNow ? "dev" : "backlog",
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

    if (startNow && repo && branch) {
      await this.provisionTaskWorkspace(repo, id, branch, now, {
        persist: () => this.deps.tasks.createTask(task),
        undo: () => this.deps.tasks.removeTask(id),
      });
    } else {
      await this.deps.tasks.createTask(task);
    }

    await this.publishTaskChange(task);
    return task;
  }

  async startTask(taskId: string): Promise<Task> {
    const task = await this.requireTask(taskId);
    if (task.state !== "backlog") {
      throw new Error(
        `Only a backlog task can be started (task is in "${task.state}")`,
      );
    }
    const binding = task.repositoryId
      ? await this.deps.bindings.getBindingForTask(taskId)
      : undefined;
    if (!task.repositoryId || binding?.worktreePath) {
      return this.moveTask(taskId, "dev");
    }

    const config = await this.deps.config.load();
    const repo = await this.findRepository(task.repositoryId, config);
    const branch =
      task.branch ??
      deriveTaskBranch(task.title, task.id, config.branchPrefix ?? "");
    const now = this.deps.clock.now().toISOString();
    const next: Task = {
      ...task,
      state: "dev",
      branch,
      targetBranch: task.targetBranch ?? repo.defaultBranch,
      updatedAt: now,
      stateChangedAt: now,
    };
    delete next.awaiting;
    await this.provisionTaskWorkspace(repo, task.id, branch, now, {
      persist: () => this.deps.tasks.replaceTask(next),
      undo: () => this.deps.tasks.replaceTask(task),
    });
    await this.publishTaskChange(next);
    return next;
  }

  /**
   * Shared by `createTask` (start now) and `startTask`: create the task's
   * branch + worktree, persist the task record (`persist`), then attach its
   * binding. Any failure leaves no orphan worktree and undoes the task
   * write (`undo`) when the binding step fails; the triggering error is
   * rethrown as-is.
   */
  private async provisionTaskWorkspace(
    repo: RepositoryInfo,
    taskId: string,
    branch: string,
    now: string,
    task: { persist: () => Promise<void>; undo: () => Promise<void> },
  ): Promise<void> {
    // Branch collision, dirty baseRef, missing repo, ... — createTaskWorktree
    // itself guarantees no leftover directory/bookkeeping on failure, so
    // there is nothing to clean up on this path beyond rethrowing.
    const worktree = await this.deps.worktrees.createTaskWorktree(
      repo,
      branch,
      repo.defaultBranch,
    );
    // Undo both halves of `git worktree add -b`: the directory and the
    // freshly-created (commit-less) branch, so a retry never collides with
    // a leftover ref.
    const removeWorktree = () =>
      this.discardTaskWorktree(repo, worktree.path, branch);

    try {
      await task.persist();
    } catch (error) {
      await removeWorktree();
      throw error;
    }

    const binding: WorkspaceBinding = {
      id: this.deps.ids.next(),
      taskId,
      worktreePath: worktree.path,
      branch,
      detached: false,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.deps.bindings.attachBinding(binding);
    } catch (error) {
      // Roll back the task write and the worktree: no started task may
      // exist without a consistent binding once a repository was involved.
      await task.undo().catch(() => {});
      await removeWorktree();
      throw error;
    }
  }

  async claimInitialPrompt(taskId: string): Promise<string | undefined> {
    const task = await this.requireTask(taskId);
    if (task.initialPromptDeliveredAt || !task.initialPrompt.trim()) {
      return undefined;
    }
    const now = this.deps.clock.now().toISOString();
    await this.deps.tasks.replaceTask({
      ...task,
      initialPromptDeliveredAt: now,
      updatedAt: now,
    });
    return task.initialPrompt;
  }

  async claimSessionLaunch(taskId: string): Promise<SessionLaunch | undefined> {
    const task = await this.requireTask(taskId);
    const binding = await this.deps.bindings.getBindingForTask(taskId);
    if (!binding?.worktreePath) return undefined;
    const now = this.deps.clock.now().toISOString();

    // First launch after `reopenTask`: hand the pending fork out exactly
    // once, so later launches resume the forked session instead of forking
    // the previous cycle again.
    if (binding.forkFromSessionPath) {
      const forkFrom = binding.forkFromSessionPath;
      const sessionId = binding.sessionId ?? this.deps.ids.next();
      const { forkFromSessionPath: _consumed, ...rest } = binding;
      await this.deps.bindings.replaceBinding({
        ...rest,
        sessionId,
        updatedAt: now,
      });
      return (await this.deps.sessions.exists(forkFrom))
        ? { mode: "fork", sessionId, forkFrom }
        : { mode: "new", sessionId };
    }

    if (binding.sessionId) {
      const sessionPath =
        binding.sessionPath &&
        (await this.deps.sessions.exists(binding.sessionPath))
          ? binding.sessionPath
          : undefined;
      return {
        mode: "resume",
        sessionId: binding.sessionId,
        ...(sessionPath ? { sessionPath } : {}),
      };
    }

    // Legacy binding from before session binding existed: a pane already
    // ran here (its prompt was delivered), so reconnect to the most recent
    // conversation in this per-task worktree rather than starting a new
    // one. The harness's `recordTaskSession` call then binds it for good.
    if (task.initialPromptDeliveredAt) return { mode: "continue" };

    const sessionId = this.deps.ids.next();
    await this.deps.bindings.replaceBinding({
      ...binding,
      sessionId,
      updatedAt: now,
    });
    return { mode: "new", sessionId };
  }

  async recordTaskSession(
    taskId: string,
    input: RecordTaskSessionInput,
  ): Promise<boolean> {
    if (!input.sessionId || !input.sessionPath) return false;
    const binding = await this.deps.bindings.getBindingForTask(taskId);
    if (!binding) return false;
    if (binding.sessionId) {
      // Another conversation started inside the task's pane (e.g. Pi's
      // /new): the binding stays authoritative, like pi-home's.
      if (binding.sessionId !== input.sessionId) return false;
      if (binding.sessionPath === input.sessionPath) return false;
    } else if (!binding.worktreePath) {
      return false;
    }
    await this.deps.bindings.replaceBinding({
      ...binding,
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      updatedAt: this.deps.clock.now().toISOString(),
    });
    return true;
  }

  async reopenTask(
    taskId: string,
    input?: ReopenTaskInput,
  ): Promise<{ task: Task; warning?: string }> {
    const task = await this.requireTask(taskId);
    if (task.state !== "done") {
      throw new Error(
        `Only a done task can be reopened (task is in "${task.state}")`,
      );
    }
    const now = this.deps.clock.now().toISOString();
    const objective = input?.objective?.trim();
    const reopened: Task = {
      ...task,
      state: "dev",
      updatedAt: now,
      stateChangedAt: now,
    };
    delete reopened.completedAt;
    delete reopened.archivedAt;
    delete reopened.awaiting;
    if (objective) {
      // Delivered once, as the reopened session's first message.
      reopened.initialPrompt = objective;
      delete reopened.initialPromptDeliveredAt;
    } else {
      // No new directive: never replay the old prompt into the new cycle.
      reopened.initialPromptDeliveredAt = task.initialPromptDeliveredAt ?? now;
    }

    if (!task.repositoryId) {
      await this.deps.tasks.replaceTask(reopened);
      await this.publishTaskChange(reopened);
      return { task: reopened };
    }

    const config = await this.deps.config.load();
    const repo = await this.findRepository(task.repositoryId, config);
    const previous = await this.deps.bindings.getBindingForTask(taskId);

    // Cleanup was refused at Done time (dirty or open in a live pane): the
    // old worktree is still there, so reopen into it with its own session
    // instead of orphaning it next to a new cycle.
    if (previous?.worktreePath) {
      const live = await this.deps.worktrees.listWorktrees(repo);
      if (live.some((worktree) => worktree.path === previous.worktreePath)) {
        await this.deps.tasks.replaceTask(reopened);
        await this.publishTaskChange(reopened);
        return { task: reopened };
      }
    }

    // New cycle (pi-home's reopenDoneWork): fresh branch + worktree off the
    // default branch; the previous conversation is forked into the new
    // session on its first launch (see claimSessionLaunch).
    let warning: string | undefined;
    const forkFrom =
      previous?.sessionPath &&
      (await this.deps.sessions.exists(previous.sessionPath))
        ? previous.sessionPath
        : undefined;
    if (!forkFrom && (previous?.sessionPath || previous?.sessionId)) {
      warning = previous.sessionPath
        ? `previous conversation not found (${previous.sessionPath}); the reopened task starts a fresh session`
        : "previous conversation was never recorded; the reopened task starts a fresh session";
    }

    const branch = deriveTaskBranch(
      task.title,
      this.deps.ids.next(),
      config.branchPrefix ?? "",
    );
    const worktree = await this.deps.worktrees.createTaskWorktree(
      repo,
      branch,
      repo.defaultBranch,
    );
    const discardWorktree = () =>
      this.discardTaskWorktree(repo, worktree.path, branch);

    const binding: WorkspaceBinding = {
      id: previous?.id ?? this.deps.ids.next(),
      taskId,
      worktreePath: worktree.path,
      branch,
      detached: false,
      // Pre-assigned like a first launch (the new cycle never inherits the
      // legacy `--continue` path): forked into when a previous conversation
      // exists, else created fresh under this id.
      sessionId: this.deps.ids.next(),
      ...(previous?.sessionPath
        ? { previousSessionPath: previous.sessionPath }
        : {}),
      ...(forkFrom ? { forkFromSessionPath: forkFrom } : {}),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    try {
      if (previous) await this.deps.bindings.replaceBinding(binding);
      else await this.deps.bindings.attachBinding(binding);
    } catch (error) {
      await discardWorktree();
      throw error;
    }

    const next: Task = {
      ...reopened,
      branch,
      targetBranch: task.targetBranch ?? repo.defaultBranch,
    };
    delete next.pr;
    try {
      await this.deps.tasks.replaceTask(next);
    } catch (error) {
      // No half-created cycle: restore the old binding, drop the new
      // worktree + branch; the task record itself was never changed.
      if (previous) {
        await this.deps.bindings.replaceBinding(previous).catch(() => {});
      } else {
        await this.deps.bindings.removeBinding(taskId).catch(() => {});
      }
      await discardWorktree();
      throw error;
    }

    await this.publishTaskChange(next);
    return { task: next, ...(warning ? { warning } : {}) };
  }

  /** Undo both halves of `git worktree add -b`, best effort: the directory and its fresh branch. */
  private async discardTaskWorktree(
    repo: RepositoryInfo,
    path: string,
    branch: string,
  ): Promise<void> {
    await this.deps.worktrees.removeWorktree(repo, path, true).catch(() => {});
    await this.deps.worktrees.deleteBranch(repo, branch, true).catch(() => {});
  }

  async moveTask(
    id: string,
    state: TaskState,
    options?: MoveTaskOptions,
  ): Promise<Task> {
    if (state === "awaiting" && !options?.awaiting) {
      throw new Error(
        'Moving a task to "awaiting" requires an awaiting reason',
      );
    }
    const now = this.deps.clock.now().toISOString();
    // Validated and written against the task as persisted under the lock,
    // so a concurrent refresh's PR patch is never overwritten.
    const next = await this.deps.tasks.patchTask(id, (task) => {
      assertAllowedTransition(task.state, state);
      assertMayReturnToDev(task.state, task.awaiting, state);
      const stateChanged = task.state !== state;
      const moved: Task = {
        ...task,
        state,
        updatedAt: now,
        stateChangedAt: stateChanged ? now : task.stateChangedAt,
        ...(state === "done" ? { completedAt: task.completedAt ?? now } : {}),
      };
      if (state === "awaiting" && options?.awaiting) {
        moved.awaiting = options.awaiting;
      } else {
        delete moved.awaiting;
      }
      // Leaving done reopens the task in place (same as `reopenTask`'s
      // bookkeeping): it is no longer completed, nor archived.
      if (task.state === "done" && state !== "done") {
        delete moved.completedAt;
        delete moved.archivedAt;
      }
      return moved;
    });
    if (!next) throw new Error(`Task not found: ${id}`);
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
          preferredCheckoutsFromConfig(config),
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

  async listAwaitingKinds(taskId?: string): Promise<AwaitingKindOption[]> {
    const task = taskId ? await this.requireTask(taskId) : undefined;
    const env = task
      ? { stages: this.deploymentStages(task, await this.deps.config.load()) }
      : { stages: [] };
    return builtinAwaitingKinds.map((kind) =>
      describeAwaitingKind(kind, task, env),
    );
  }

  async toAwait(
    taskId: string,
    kindId: AwaitingKindId,
    options?: ToAwaitOptions,
  ): Promise<Task> {
    const kind = findAwaitingKind(kindId);
    if (!kind) throw new Error(`Unknown awaiting kind: ${kindId}`);
    const task = await this.requireTask(taskId);
    assertAllowedTransition(task.state, "awaiting");
    const config = await this.deps.config.load();
    const env = { stages: this.deploymentStages(task, config) };
    const assessment = kind.assess(task, env);
    if (!assessment.available) {
      throw new Error(
        `Cannot await ${kind.label.toLowerCase()}: ${assessment.reason ?? "not available for this task"}`,
      );
    }
    const inputs = normalizeAwaitingInputs(kind, options?.inputs);
    const entered = kind.onEnter
      ? await kind.onEnter({
          task,
          inputs,
          ...env,
          resolveWorkspace: async () => {
            if (!task.repositoryId) {
              throw new Error(`Task has no repository: ${taskId}`);
            }
            const repo = await this.findRepository(task.repositoryId, config);
            const binding = await this.deps.bindings.getBindingForTask(taskId);
            return {
              repo,
              ...(binding?.worktreePath
                ? { worktreePath: binding.worktreePath }
                : {}),
            };
          },
          worktrees: this.deps.worktrees,
          pullRequests: this.deps.pullRequests,
        })
      : {};
    const awaiting = kind.awaitingFor(task, inputs, env);
    const now = this.deps.clock.now().toISOString();
    // The action (push, PR creation, merge) takes a while: apply the move
    // to the task as persisted now, not the snapshot read before it.
    const next = await this.deps.tasks.patchTask(taskId, (fresh) => {
      assertAllowedTransition(fresh.state, "awaiting");
      return {
        ...fresh,
        ...(entered.pullRequest
          ? {
              pr: toTaskPullRequest(entered.pullRequest, entered.targetBranch),
            }
          : {}),
        state: "awaiting",
        awaiting,
        updatedAt: now,
        stateChangedAt: fresh.state !== "awaiting" ? now : fresh.stateChangedAt,
      };
    });
    if (!next) throw new Error(`Task not found: ${taskId}`);
    await this.publishTaskChange(next);
    return next;
  }

  /** The task's repository's effective deployment stages (empty without a pipeline). */
  private deploymentStages(
    task: Task,
    config: GlobalConfig,
  ): readonly DeploymentStageConfig[] {
    return (
      effectivePipeline(
        task.repositoryId
          ? config.repositories?.[task.repositoryId]?.deployment
          : undefined,
        builtinAutomationNames,
      )?.stages ?? []
    );
  }

  async toDone(taskId: string, options?: ToDoneOptions): Promise<ToDoneResult> {
    const task = await this.requireTask(taskId);
    assertAllowedTransition(task.state, "done");
    const result = await this.executeSafeDone(
      task,
      options?.protectedPaths ?? [],
      { mode: "manual", force: options?.force ?? {} },
    );
    if (result.confirm) return result.confirm;
    if (!result.task) throw new Error(`Task not found: ${taskId}`);
    return {
      task: result.task,
      ...(result.warning ? { warning: result.warning } : {}),
    };
  }

  refresh(options?: RefreshOptions): Promise<RefreshResult> {
    // Single-flight: the 30s timer and a manual refresh must never run two
    // observations of the same task side by side (each would decide moves
    // off its own reading); a call made mid-run joins the running one.
    if (this.refreshInFlight) return this.refreshInFlight;
    const run = this.runRefresh(options?.protectedPaths ?? []).finally(() => {
      this.refreshInFlight = undefined;
    });
    this.refreshInFlight = run;
    return run;
  }

  private async runRefresh(
    protectedPaths: readonly string[],
  ): Promise<RefreshResult> {
    const config = await this.deps.config.load();
    const warnings: string[] = [...this.configWarningsOnce(config)];
    // Connectivity-class failures (offline, DNS down, ...) are counted here
    // instead of pushed onto `warnings`: one tick talking to a dead network
    // produces one `connectivity` marker, never a per-task warning (see
    // `engines/connectivity.ts` and `refreshTask`/`retryDoneCleanups` below).
    const connectivity = { failedChecks: 0 };
    const tasks = await this.deps.tasks.listTasks();
    const repositories = await this.repositoryIndex(config);
    let changed = false;

    const candidates = tasks.filter(
      (task) =>
        task.kind === "task" &&
        task.state !== "backlog" &&
        task.state !== "done" &&
        Boolean(task.repositoryId) &&
        Boolean(task.branch),
    );
    // Each observation is dominated by gh latency and independent of the
    // others; writes are lock-serialized field patches, so a few run at
    // once (pi-home's reconcile uses the same 4-worker pool).
    await forEachConcurrently(candidates, REFRESH_CONCURRENCY, async (task) => {
      const moved = await this.refreshTask(
        task,
        config,
        repositories,
        protectedPaths,
        warnings,
        connectivity,
      );
      if (moved) changed = true;
    });

    if (
      await this.retryDoneCleanups(
        tasks,
        repositories,
        protectedPaths,
        warnings,
        connectivity,
      )
    ) {
      changed = true;
    }
    if (await this.archiveDoneTasks()) changed = true;
    if (changed) await this.publishBoard();
    return {
      warnings,
      ...(connectivity.failedChecks > 0
        ? {
            connectivity: {
              offline: true as const,
              failedChecks: connectivity.failedChecks,
            },
          }
        : {}),
    };
  }

  /**
   * Classify one failure: connectivity-class errors increment the tick's
   * shared counter instead of ever reaching `warnings` (never a per-task
   * toast for "the laptop is offline"); anything else behaves exactly as
   * before.
   */
  private recordFailure(
    title: string,
    error: unknown,
    warnings: string[],
    connectivity: { failedChecks: number },
  ): void {
    const message = describeError(error);
    if (isConnectivityError(message)) {
      connectivity.failedChecks += 1;
      return;
    }
    warnings.push(`${title}: ${message}`);
  }

  /** Observe one task's PR and apply at most one mover step; returns whether anything changed. */
  private async refreshTask(
    snapshot: Task,
    config: GlobalConfig,
    repositories: Map<string, RepositoryInfo> | undefined,
    protectedPaths: readonly string[],
    warnings: string[],
    connectivity: { failedChecks: number },
  ): Promise<boolean> {
    const repositoryId = snapshot.repositoryId;
    const branch = snapshot.branch;
    if (!repositoryId || !branch) return false;
    const repo = repositories?.get(repositoryId);
    // No origin remote: nothing on GitHub to observe, and nothing to warn
    // about every tick either (pi-home's silent skip).
    if (repo && !repo.remoteUrl) return false;

    let changed = false;
    let current: Task | undefined = snapshot;
    try {
      const status = await this.deps.pullRequests.status(repositoryId, branch);
      if (status) {
        const pr = toTaskPullRequest(
          status,
          snapshot.targetBranch ?? repo?.defaultBranch,
        );
        // Re-read under the lock and patch only `pr`: the task may have
        // been moved, reopened onto a new branch, or completed while gh was
        // answering — never write the stale snapshot back over that.
        current = await this.deps.tasks.patchTask(snapshot.id, (fresh) => {
          if (!sameObservation(fresh, snapshot) || prEquals(fresh.pr, pr)) {
            return undefined;
          }
          changed = true;
          return {
            ...fresh,
            pr,
            updatedAt: this.deps.clock.now().toISOString(),
          };
        });
      } else {
        current = await this.deps.tasks.getTask(snapshot.id);
      }
    } catch (error) {
      this.recordFailure(snapshot.title, error, warnings, connectivity);
      // Errors never move anything: skip the mover step for this task too.
      return false;
    }

    if (!config.automation || !current || !sameObservation(current, snapshot)) {
      return changed;
    }
    try {
      const moved = await this.applyMoverStep(
        current,
        config,
        protectedPaths,
        warnings,
      );
      if (moved) changed = true;
    } catch (error) {
      this.recordFailure(snapshot.title, error, warnings, connectivity);
    }
    return changed;
  }

  /**
   * Config problems (unregistered mover/hook names, an empty mover list)
   * are reported once per distinct config, at the refresh that first loads
   * it — not on every tick.
   */
  private configWarningsOnce(config: GlobalConfig): string[] {
    const key = JSON.stringify(config);
    if (key === this.lastValidatedConfig) return [];
    this.lastValidatedConfig = key;
    return automationConfigProblems(config, builtinAutomationNames);
  }

  /** Repositories by id for this refresh; `undefined` when discovery itself failed (then nothing is skipped). */
  private async repositoryIndex(
    config: GlobalConfig,
  ): Promise<Map<string, RepositoryInfo> | undefined> {
    try {
      const repos = await this.deps.repositories.discoverRepositories(
        config.codeRoot ?? "",
        preferredCheckoutsFromConfig(config),
      );
      return new Map(repos.map((repo) => [repo.id, repo]));
    } catch {
      return undefined;
    }
  }

  /** One addon-decided board move per task, at most, per `refresh()` call. */
  private async applyMoverStep(
    task: Task,
    config: GlobalConfig,
    protectedPaths: readonly string[],
    warnings: string[],
  ): Promise<boolean> {
    const pipeline = effectivePipeline(
      task.repositoryId
        ? config.repositories?.[task.repositoryId]?.deployment
        : undefined,
      builtinAutomationNames,
    );
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
    // Unregistered names were already reported once (configWarningsOnce).
    const movers = activeMoverOrder(config, task.repositoryId)
      .map((name) => [name, builtinMovers[name]] as const)
      .filter((entry): entry is [string, (typeof builtinMovers)[string]] =>
        Boolean(entry[1]),
      );
    if (movers.length === 0) return false;
    const decision = await arbitrateMove(input, helpers, movers);
    warnings.push(...decision.warnings);
    if (decision.move.type === "stay") return false;
    return this.executeMove(task, decision.move, protectedPaths, warnings);
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

  /** Execute a mover's winning proposal; returns whether the task actually moved. */
  private async executeMove(
    task: Task,
    move: BoardMove,
    protectedPaths: readonly string[],
    warnings: string[],
  ): Promise<boolean> {
    switch (move.type) {
      case "stay":
        return false;
      case "dev":
        await this.moveTask(task.id, "dev");
        return true;
      case "review":
        await this.moveTask(task.id, "awaiting", {
          awaiting: { kind: "review" },
        });
        return true;
      case "deploy":
        await this.moveTask(task.id, "awaiting", {
          awaiting: {
            kind: "deploy",
            stageId: move.stageId,
            stageLabel: move.stageLabel,
          },
        });
        return true;
      case "done": {
        const result = await this.executeSafeDone(task, protectedPaths, {
          mode: "auto",
        });
        if (result.stayed) {
          // pi-home: auto-landing never overrides a cleanup refusal; the
          // task stays where it is until the user marks it Done.
          warnings.push(
            `${task.title}: deployed and ready to land — mark it Done (${result.warning})`,
          );
          return false;
        }
        if (result.warning) warnings.push(`${task.title}: ${result.warning}`);
        return true;
      }
    }
  }

  /**
   * The done path. A live pane's worktree (`protectedPaths`) is never
   * touched: manual Done lands with a warning, auto-landing stays put.
   * Manual Done (pi-home's `complete`) otherwise asks before destroying
   * work — uncommitted changes, then an unmerged branch — by returning
   * `confirm` without moving the task, and with the matching `force`
   * answers removes the worktree (forced when dirty) and deletes the branch
   * (`-D`). Auto-landing (`mode: "auto"`) never asks and never forces: any
   * refusal keeps the task where it is (`stayed: true`, nothing changed).
   * Failures that are not questions (missing repository, git errors) never
   * block a manual Done; they become the `warning`.
   */
  private async executeSafeDone(
    task: Task,
    protectedPaths: readonly string[],
    how:
      | { mode: "auto" }
      | {
          mode: "manual";
          force: NonNullable<ToDoneOptions["force"]>;
        },
  ): Promise<{
    task?: Task;
    warning?: string;
    stayed?: boolean;
    confirm?: ToDoneConfirmation;
  }> {
    const auto = how.mode === "auto";
    let warning: string | undefined;
    const addWarning = (text: string) => {
      warning = warning ? `${warning}; ${text}` : text;
    };
    if (task.repositoryId && task.branch) {
      let repo: RepositoryInfo | undefined;
      try {
        repo = await this.findRepository(task.repositoryId);
      } catch (error) {
        if (auto) return { stayed: true, warning: describeError(error) };
        addWarning(describeError(error));
      }
      const binding = repo
        ? await this.deps.bindings.getBindingForTask(task.id)
        : undefined;
      if (repo && binding?.worktreePath) {
        const path = binding.worktreePath;
        if (isProtectedPath(path, protectedPaths)) {
          // A live pane (or other process) still has this worktree as its
          // cwd: never pull it out from under it, and never ask (pi-home's
          // protectedCwd). The branch is still checked out there too; the
          // refresh retry sweep cleans up once the pane is gone.
          const text = `worktree left in place: it is open in a live session (${path})`;
          if (auto) return { stayed: true, warning: text };
          addWarning(text);
        } else {
          const merged = shouldDeleteBranch(task.pr);
          let forceRemove = false;
          let deleteBranch = merged;
          if (how.mode === "manual") {
            const dirty = await this.deps.worktrees
              .isWorktreeDirty(path)
              .catch(() => false);
            if (dirty && !how.force.removeDirty) {
              return {
                confirm: {
                  requiresConfirmation: "dirty",
                  detail: `${task.title}: the worktree has uncommitted changes (${path})`,
                },
              };
            }
            if (!merged && task.kind === "task" && !how.force.deleteUnmerged) {
              return {
                confirm: {
                  requiresConfirmation: "unmerged",
                  detail: `${task.title}: branch ${task.branch} isn't merged; the worktree and local branch will be deleted`,
                },
              };
            }
            forceRemove = dirty;
            deleteBranch = merged || Boolean(how.force.deleteUnmerged);
          }
          let removed = false;
          try {
            await this.deps.worktrees.removeWorktree(repo, path, forceRemove);
            removed = true;
            await this.parkBinding(binding);
          } catch (error) {
            const text = `worktree left in place: ${describeError(error)}`;
            if (auto && !removed) return { stayed: true, warning: text };
            addWarning(text);
          }
          if (deleteBranch) {
            const branchWarning = await this.deleteTaskBranch(
              repo,
              task.branch,
            );
            if (branchWarning) addWarning(branchWarning);
          }
        }
      }
    }
    const now = this.deps.clock.now().toISOString();
    // Patch the move onto the task as persisted now: the worktree removal
    // above can take a while, and a concurrent refresh may have updated
    // the PR snapshot meanwhile.
    const next = await this.deps.tasks.patchTask(task.id, (fresh) => {
      assertAllowedTransition(fresh.state, "done");
      const landed: Task = {
        ...fresh,
        state: "done",
        updatedAt: now,
        stateChangedAt: now,
        completedAt: fresh.completedAt ?? now,
      };
      delete landed.awaiting;
      return landed;
    });
    if (next) await this.publishTaskChange(next);
    return { ...(next ? { task: next } : {}), ...(warning ? { warning } : {}) };
  }

  /** The worktree is gone; keep the binding (session identity survives for a reopen — pi-home parks it the same way). */
  private async parkBinding(binding: WorkspaceBinding): Promise<void> {
    const { worktreePath: _removed, ...parked } = binding;
    await this.deps.bindings.replaceBinding({
      ...parked,
      updatedAt: this.deps.clock.now().toISOString(),
    });
  }

  /**
   * Force-delete (`-D`) the task's local branch; returns a warning on
   * failure. Only ever called for a merged PR (squash merges look unmerged
   * to `-d`) or after the user confirmed deleting an unmerged one.
   */
  private async deleteTaskBranch(
    repo: RepositoryInfo,
    branch: string,
  ): Promise<string | undefined> {
    try {
      await this.deps.worktrees.deleteBranch(repo, branch, true);
      return undefined;
    } catch (error) {
      return `branch left in place: ${describeError(error)}`;
    }
  }

  /** The retry sweep never asks: it only deletes a merged PR's branch. */
  private async deleteMergedBranch(
    repo: RepositoryInfo,
    branch: string,
    pr: TaskPullRequest | undefined,
  ): Promise<string | undefined> {
    if (!shouldDeleteBranch(pr)) return undefined;
    return this.deleteTaskBranch(repo, branch);
  }

  /**
   * Retry the safe cleanup for done tasks whose worktree is still on disk
   * (a manual Done refused it: dirty, or open in a live pane). One attempt
   * per task per refresh; a live pane's worktree is skipped silently, and a
   * repeated refusal is reported only when its reason changes. After the
   * session-continuity rework a Done task keeps its binding, so "still on
   * disk" means the binding still carries a `worktreePath`.
   */
  private async retryDoneCleanups(
    tasks: readonly Task[],
    repositories: Map<string, RepositoryInfo> | undefined,
    protectedPaths: readonly string[],
    warnings: string[],
    connectivity: { failedChecks: number },
  ): Promise<boolean> {
    for (const task of tasks) {
      if (
        task.state !== "done" ||
        task.kind !== "task" ||
        !task.repositoryId ||
        !task.branch
      ) {
        continue;
      }
      const repo = repositories?.get(task.repositoryId);
      if (!repo) continue;
      let binding: WorkspaceBinding | undefined;
      try {
        binding = await this.deps.bindings.getBindingForTask(task.id);
      } catch {
        continue;
      }
      if (!binding?.worktreePath) {
        this.cleanupWarnings.delete(task.id);
        continue;
      }
      if (isProtectedPath(binding.worktreePath, protectedPaths)) continue;
      // Narrow the race with a concurrent reopen (which reuses this very
      // worktree): only clean up a task that is still done right now.
      const fresh = await this.deps.tasks.getTask(task.id);
      if (fresh?.state !== "done") continue;
      let failure: string | undefined;
      try {
        await this.deps.worktrees.removeWorktree(
          repo,
          binding.worktreePath,
          false,
        );
        await this.parkBinding(binding);
        failure = await this.deleteMergedBranch(repo, task.branch, task.pr);
      } catch (error) {
        failure = `worktree left in place: ${describeError(error)}`;
      }
      if (!failure) {
        this.cleanupWarnings.delete(task.id);
        continue;
      }
      if (isConnectivityError(failure)) {
        // Same split as refreshTask: a dead network retrying this cleanup
        // is an environmental state, never a per-task warning.
        connectivity.failedChecks += 1;
        continue;
      }
      if (this.cleanupWarnings.get(task.id) !== failure) {
        this.cleanupWarnings.set(task.id, failure);
        warnings.push(`${task.title}: ${failure}`);
      }
    }
    // Bindings are not part of the board projection: nothing to publish.
    return false;
  }

  private async archiveDoneTasks(): Promise<boolean> {
    const tasks = await this.deps.tasks.listTasks();
    const now = this.deps.clock.now();
    let changed = false;
    for (const task of tasks) {
      if (!shouldArchive(task, now)) continue;
      await this.deps.tasks.patchTask(task.id, (fresh) => {
        if (!shouldArchive(fresh, now)) return undefined;
        changed = true;
        return { ...fresh, archivedAt: now.toISOString() };
      });
    }
    return changed;
  }

  private async findRepository(
    repositoryId: string,
    loadedConfig?: GlobalConfig,
  ): Promise<RepositoryInfo> {
    const config = loadedConfig ?? (await this.deps.config.load());
    const repos = await this.deps.repositories.discoverRepositories(
      config.codeRoot ?? "",
      preferredCheckoutsFromConfig(config),
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

/**
 * Whether a task as persisted now is still the observation `snapshot` was
 * taken for: still active, on the same repository and branch (a reopen
 * swaps the branch), so a PR snapshot fetched for it still applies.
 */
function sameObservation(current: Task, snapshot: Task): boolean {
  return (
    current.kind === "task" &&
    current.state !== "backlog" &&
    current.state !== "done" &&
    current.repositoryId === snapshot.repositoryId &&
    current.branch === snapshot.branch
  );
}

/** `fallbackTargetBranch` stands in when GitHub did not report the merged PR's base branch (pi-home: the repository default). */
function toTaskPullRequest(
  status: PullRequestStatus,
  fallbackTargetBranch?: string,
): TaskPullRequest {
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
            targetBranch:
              status.mergeCommit.targetBranch ?? fallbackTargetBranch ?? "",
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

/** Whether `path` is one of `protectedPaths` or contains one of them (a live cwd inside the worktree); trailing slashes ignored. */
function isProtectedPath(
  path: string,
  protectedPaths: readonly string[],
): boolean {
  const normalize = (value: string) => value.replace(/\/+$/, "");
  const target = normalize(path);
  return protectedPaths.some((candidate) => {
    const root = normalize(candidate);
    return (
      root.length > 0 && (target === root || root.startsWith(`${target}/`))
    );
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Repository id -> configured primary-checkout override, for `GitRepositoryAccess.discoverRepositories`. */
function preferredCheckoutsFromConfig(
  config: GlobalConfig,
): Record<string, string> {
  const preferred: Record<string, string> = {};
  for (const [id, repoConfig] of Object.entries(config.repositories ?? {})) {
    if (repoConfig.preferredCheckout)
      preferred[id] = repoConfig.preferredCheckout;
  }
  return preferred;
}
