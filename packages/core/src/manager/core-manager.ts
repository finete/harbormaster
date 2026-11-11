// Manager: orchestrates the task-board workflow (sequence of use cases),
// delegating storage to Resource Access and board-move rules to the
// transition Engine. This is the one and only implementation of
// `CoreCommands`; frontends never see anything beneath this layer.

import type {
  AwaitingKindOption,
  CoreCommands,
  CreateTaskInput,
  DeleteTaskOptions,
  KnownLocation,
  LaunchTaskInput,
  MoveTaskOptions,
  OrphanWorktreeReport,
  PresenceReport,
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
import type {
  HarnessAdapter,
  HarnessModelCatalog,
  PresenceStatus,
  SessionLaunch,
} from "../contracts/harness.js";
import type {
  InboxAccess,
  InboxItem,
  ListInboxOptions,
  ResolveInboxItemOptions,
  ResolveInboxItemResult,
} from "../contracts/inbox.js";
import type {
  ApproveMessageEdits,
  FindTasksOptions,
  MessageSender,
  MessageStoreSnapshot,
  SendTaskMessageInput,
  SendTaskMessageResult,
  TaskMessage,
  TaskMessagingState,
  TaskSearchResult,
} from "../contracts/messaging.js";
import type {
  AwaitingKindId,
  BoardColumn,
  DeploymentStageConfig,
  GlobalConfig,
  PullRequestRole,
  Task,
  TaskLaunch,
  TaskPullRequest,
  TaskState,
  ThinkingLevel,
  WorkspaceBinding,
} from "../contracts/model.js";
import {
  DEFAULT_HARNESS_ID,
  DEFAULT_LAUNCH_MAX_CONCURRENT,
  DEFAULT_MESSAGE_LOOP_CAP,
  DEFAULT_PARENT_REPLY_TIMEOUT_MINUTES,
  TASK_STATES,
} from "../contracts/model.js";
import type {
  AddonAccess,
  AddonInfo,
  AuditEntry,
  AuditLogAccess,
  CreateTaskActionInput,
  ListEventsFilter,
  RulesCheckInput,
  RulesCheckResult,
  RulesFileAccess,
  RulesListing,
  SourceStateAccess,
} from "../contracts/rules.js";
import type {
  Clock,
  ConfigAccess,
  FolderAccess,
  IdGenerator,
  MessageAccess,
  PresenceAccess,
  ScratchWorkspaceAccess,
  SessionFileAccess,
  TaskAttachmentAccess,
  TaskStateAccess,
  WorkspaceBindingAccess,
} from "../contracts/services.js";
import type {
  GitRepositoryAccess,
  GitWorktreeAccess,
  RepositoryInfo,
  WorktreeInfo,
} from "../contracts/workspace.js";
import {
  builtinAwaitingKinds,
  describeAwaitingKind,
  findAwaitingKind,
  normalizeAwaitingInputs,
} from "../engines/awaiting-kinds.js";
import { groupColumnTasks } from "../engines/board-grouping.js";
import { branchToAdopt } from "../engines/branch-adoption.js";
import {
  findOrphanDirs,
  isReviewCheckoutOf,
  orphanWorktreeWarning,
  shouldArchive,
  shouldDeleteBranch,
} from "../engines/cleanup.js";
import { isConnectivityError } from "../engines/connectivity.js";
import { buildLaunchKickoffPrompt } from "../engines/launch-kickoff.js";
import {
  buildReceiptText,
  classifyRoute,
  countLoopMessages,
  defaultMode,
  deriveMessagingStates,
  deriveRunState,
  matchTasks,
  resolveDeliveredMode,
  selectMessagesToPrune,
} from "../engines/messaging.js";
import { parsePullRequestUrl } from "../engines/pull-request-url.js";
import type { ResolvedMove } from "../engines/rules/evaluation.js";
import { effectivePipeline } from "../engines/rules/views.js";
import {
  assertAllowedTransition,
  assertMayReturnToDev,
} from "../engines/task-transitions.js";
import { deriveTaskBranch } from "../engines/task-workspace.js";
import { applyProgramStatus } from "../harness/presence-heuristics.js";
import { forEachConcurrently } from "../utilities/concurrency.js";
import type { CoreEventBus } from "../utilities/event-bus.js";
import {
  type ActionResult,
  type RuleActionExecutor,
  RulesRuntime,
} from "./rules-runtime.js";

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
  /** Scratch-directory workspace for `launchTask`'s `{ none: true }` repository-less tasks. */
  scratch: ScratchWorkspaceAccess;
  pullRequests: PullRequestAccess;
  versions: VersionAccess;
  /**
   * Task-messaging storage (log, doorbell, attachment copies). Optional so
   * hand-built managers that never message keep compiling; every messaging
   * command throws "messaging is not configured" without it (`createCore`
   * always supplies it).
   */
  messages?: MessageAccess;
  /** The harness adapter, for presence and messaging capabilities. Required alongside `messages`. */
  harness?: HarnessAdapter;
  /**
   * Folders registered outside `codeRoot` (composer "Open folder…").
   * Optional so hand-built managers keep compiling; folder commands throw
   * "folders are not configured" without it (`createCore` supplies it).
   */
  folders?: FolderAccess;
  /** Per-task copies of images pasted into a prompt; without it attachments keep their original paths. */
  attachments?: TaskAttachmentAccess;
  /** Presence registry written by `reportPresence` / `endPresence` / `reportTaskOutcome` (`createCore` supplies it). */
  presence?: PresenceAccess;
  /**
   * Rules-engine storage (rules dir, source state, audit log; addons
   * optional). Optional so hand-built managers keep compiling: without it
   * `refresh()` runs no automation and the rules commands throw "rules
   * are not configured" (`createCore` always supplies it).
   */
  rules?: {
    files: RulesFileAccess;
    state: SourceStateAccess;
    audit: AuditLogAccess;
    addons?: AddonAccess;
  };
  /** Persisted inbox; inbox commands throw "inbox is not configured" without it. */
  inbox?: InboxAccess;
}

/** Where a new task runs, resolved from a create/launch input. */
type TaskWhere =
  | { kind: "repository"; repo: RepositoryInfo }
  | { kind: "folder"; path: string }
  | { kind: "none" };

/** Agent fields stored on a new task (see `/docs/new-task-composer.md`). */
function agentFields(input: {
  harness?: string;
  model?: string;
  thinking?: ThinkingLevel;
}): Pick<Task, "harness" | "model" | "thinking"> {
  const model = input.model?.trim();
  return {
    harness: input.harness?.trim() || DEFAULT_HARNESS_ID,
    ...(model ? { model } : {}),
    ...(input.thinking ? { thinking: input.thinking } : {}),
  };
}

const COLUMN_TITLES: Record<TaskState, string> = {
  backlog: "Backlog",
  dev: "Dev",
  awaiting: "Awaiting",
  done: "Done",
};

/** How long registered folders' repository lookups are reused. */
const LOCATION_CACHE_TTL_MS = 30_000;

/** PR observations in flight at once during `refresh()` (pi-home parity). */
const REFRESH_CONCURRENCY = 4;

/** A refresh tick's batched PR answer for one task: its status (possibly none), or the batch's failure. */
type PrefetchedPullRequest =
  | { status: PullRequestStatus | undefined }
  | { error: unknown };

export class CoreManager implements CoreCommands {
  /** The running `refresh()`, joined by any call made while it runs. */
  private refreshInFlight: Promise<RefreshResult> | undefined;
  /** Last reported done-cleanup retry failure per task (dedupe). */
  private readonly cleanupWarnings = new Map<string, string>();
  /** Registered folders resolved to repositories (see `locationEntries`). */
  private locationCache:
    | { at: number; entries: Array<{ path: string; repo?: RepositoryInfo }> }
    | undefined;

  /** The rules engine's tick/check/list workflow (see manager/rules-runtime.ts). */
  private readonly rules: RulesRuntime | undefined;

  constructor(private readonly deps: CoreManagerDependencies) {
    this.rules = deps.rules
      ? new RulesRuntime({
          rules: deps.rules.files,
          state: deps.rules.state,
          audit: deps.rules.audit,
          ...(deps.rules.addons ? { addons: deps.rules.addons } : {}),
          config: deps.config,
          now: () => deps.clock.now(),
          services: {
            github: {
              containsCommit: (repositoryId, ancestor, descendant) =>
                deps.pullRequests.containsCommit(
                  repositoryId,
                  ancestor,
                  descendant,
                ),
              commitLog: (repositoryId, start, limit) =>
                deps.pullRequests.commitLog(repositoryId, start, limit),
              ...(deps.pullRequests.searchPullRequests
                ? {
                    searchPullRequests: (query: string) =>
                      deps.pullRequests.searchPullRequests?.(query) ??
                      Promise.resolve([]),
                  }
                : {}),
            },
            http: { fetchText: (url) => deps.versions.fetchText(url) },
          },
        })
      : undefined;
  }

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
    return this.allRepositories(config);
  }

  /** Repositories under `codeRoot`, then git folders registered outside it (deduplicated by identity). */
  private async allRepositories(
    config: GlobalConfig,
  ): Promise<RepositoryInfo[]> {
    const repos = await this.deps.repositories.discoverRepositories(
      config.codeRoot ?? "",
      preferredCheckoutsFromConfig(config),
    );
    const known = new Set(repos.map((repo) => repo.id));
    for (const location of await this.locationEntries()) {
      if (location.repo && !known.has(location.repo.id)) {
        known.add(location.repo.id);
        repos.push(location.repo);
      }
    }
    return repos;
  }

  /** Every registered folder that still exists, with its repository when it is a git checkout. */
  private async locationEntries(): Promise<
    Array<{ path: string; repo?: RepositoryInfo }>
  > {
    const folders = this.deps.folders;
    if (!folders) return [];
    // Cached briefly: repository lookups run on every refresh tick and
    // every `findRepository`, and each registered folder costs git spawns.
    const now = this.deps.clock.now().getTime();
    const cached = this.locationCache;
    if (cached && now - cached.at < LOCATION_CACHE_TTL_MS) {
      return structuredClone(cached.entries);
    }
    const entries: Array<{ path: string; repo?: RepositoryInfo }> = [];
    for (const path of await folders.listRegisteredFolders()) {
      if (!(await folders.isDirectory(path))) continue;
      const repo = await this.deps.repositories
        .resolveRepository(path)
        .catch(() => undefined);
      entries.push({ path, ...(repo ? { repo } : {}) });
    }
    this.locationCache = { at: now, entries: structuredClone(entries) };
    return entries;
  }

  async listLocations(): Promise<KnownLocation[]> {
    return (await this.locationEntries()).map(({ path, repo }) =>
      toKnownLocation(path, repo),
    );
  }

  async addLocation(path: string): Promise<KnownLocation> {
    const folders = this.deps.folders;
    if (!folders) throw new Error("folders are not configured");
    const resolved = await folders.registerFolder(path);
    this.locationCache = undefined;
    const repo = await this.deps.repositories
      .resolveRepository(resolved)
      .catch(() => undefined);
    return toKnownLocation(resolved, repo);
  }

  async listBranches(repositoryId: string): Promise<string[]> {
    const repo = await this.findRepository(repositoryId);
    return this.deps.repositories.listBranches(repo);
  }

  async listModels(): Promise<HarnessModelCatalog[]> {
    const harness = this.deps.harness;
    if (!harness) return [];
    const [catalog, config] = await Promise.all([
      harness.listModels(),
      this.deps.config.load(),
    ]);
    // The configured default wins over the harness's own, exactly as
    // `claimSessionLaunch` resolves it.
    const defaultModel = config.launch?.defaultModel ?? catalog.defaultModel;
    return [{ ...catalog, ...(defaultModel ? { defaultModel } : {}) }];
  }

  /**
   * Resolve a create/launch input's location. A folder is registered as a
   * known location first (so agents can target it later); a git folder
   * becomes its repository, anything else runs in place.
   */
  private async resolveWhere(
    where:
      | { repositoryId: string }
      | { cloneUrl: string }
      | { folderPath: string }
      | { none: true },
    config: GlobalConfig,
    inPlace = false,
  ): Promise<TaskWhere> {
    const resolved = await this.resolveWhereWorktree(where, config);
    // Chat mode: a repository runs in its primary checkout, no worktree.
    return inPlace && resolved.kind === "repository"
      ? { kind: "folder", path: resolved.repo.root }
      : resolved;
  }

  private async resolveWhereWorktree(
    where:
      | { repositoryId: string }
      | { cloneUrl: string }
      | { folderPath: string }
      | { none: true },
    config: GlobalConfig,
  ): Promise<TaskWhere> {
    if ("repositoryId" in where) {
      return {
        kind: "repository",
        repo: await this.findRepository(where.repositoryId, config),
      };
    }
    if ("cloneUrl" in where) {
      if (!config.codeRoot) {
        throw new Error(
          "Cloning a repository requires codeRoot to be configured",
        );
      }
      return {
        kind: "repository",
        repo: await this.deps.repositories.cloneRepository(
          config.codeRoot,
          where.cloneUrl,
        ),
      };
    }
    if ("folderPath" in where) {
      const location = await this.addLocation(where.folderPath);
      if (location.repositoryId) {
        return {
          kind: "repository",
          repo: await this.findRepository(location.repositoryId, config),
        };
      }
      return { kind: "folder", path: location.path };
    }
    return { kind: "none" };
  }

  /** Copy pasted images into the task's own state dir and point the prompt at the copies. */
  private async adoptAttachments(
    taskId: string,
    prompt: string,
    attachments: string[] | undefined,
  ): Promise<string> {
    if (!attachments?.length || !this.deps.attachments) return prompt;
    const used = attachments.filter((path) => prompt.includes(path));
    const copies = await this.deps.attachments.copyIntoTask(taskId, used);
    let next = prompt;
    for (const [from, to] of copies) next = next.replaceAll(from, to);
    return next;
  }

  /** One level only: the parent must exist and must not itself be a child. */
  private async requireParentCandidate(parentTaskId: string): Promise<Task> {
    const parent = await this.deps.tasks.getTask(parentTaskId);
    if (!parent) throw new Error(`Task not found: ${parentTaskId}`);
    if (parent.parentTaskId) {
      throw new Error(
        "A child task cannot launch further children (one level only); launch a standalone task instead",
      );
    }
    return parent;
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

    const parent = input.parentTaskId
      ? await this.requireParentCandidate(input.parentTaskId)
      : undefined;

    let branch = input.branch;
    let targetBranch = input.targetBranch;
    const config = await this.deps.config.load();
    const where = await this.resolveWhere(
      input.repositoryId !== undefined
        ? { repositoryId: input.repositoryId }
        : input.cloneUrl
          ? { cloneUrl: input.cloneUrl }
          : input.folderPath
            ? { folderPath: input.folderPath }
            : { none: true },
      config,
      input.inPlace,
    );
    const repo = where.kind === "repository" ? where.repo : undefined;
    const baseRef = repo ? input.baseRef?.trim() || undefined : undefined;

    // A PR-bound task (reviewer tasks): the PR's head branch is the task's
    // branch, and the PR is known from the start.
    let pr: TaskPullRequest | undefined;
    if (input.pullRequest !== undefined) {
      if (!repo) {
        throw new Error("A pull-request task needs a repository");
      }
      if (!this.deps.pullRequests.view) {
        throw new Error("Pull-request tasks need GitHub access");
      }
      const status = await this.deps.pullRequests.view(
        repo.id,
        input.pullRequest,
      );
      if (!status.headRefName) {
        throw new Error(
          `Pull request #${input.pullRequest} has no head branch`,
        );
      }
      branch = status.headRefName;
      pr = toTaskPullRequest(
        status,
        repo.defaultBranch,
        input.role ?? roleFromViewer(status.viewerIsAuthor) ?? "author",
      );
    }

    if (repo) {
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
      // Repository-less work is scratch ("chat") work, same as
      // `launchTask`'s `{ none: true }`.
      kind: input.kind ?? (repo ? "task" : "temp_task"),
      state: startNow ? "dev" : "backlog",
      title: input.title,
      initialPrompt: await this.adoptAttachments(
        id,
        input.initialPrompt,
        input.attachments,
      ),
      ...(repo ? { repositoryId: repo.id } : {}),
      ...(where.kind === "folder" ? { folderPath: where.path } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(targetBranch !== undefined ? { targetBranch } : {}),
      ...(baseRef ? { baseRef } : {}),
      ...(parent ? { parentTaskId: parent.id } : {}),
      ...(pr ? { pr } : {}),
      ...agentFields(input),
      createdAt: now,
      updatedAt: now,
      stateChangedAt: now,
    };

    if (startNow && repo && branch) {
      await this.provisionTaskWorkspace(
        repo,
        id,
        branch,
        now,
        {
          persist: () => this.deps.tasks.createTask(task),
          undo: () => this.deps.tasks.removeTask(id),
        },
        baseRef ?? repo.defaultBranch,
        pr?.number,
      );
    } else if (startNow && where.kind === "folder") {
      await this.provisionInPlaceWorkspace(id, where.path, now, {
        persist: () => this.deps.tasks.createTask(task),
        undo: () => this.deps.tasks.removeTask(id),
      });
    } else if (startNow && !repo) {
      // A started repository-less task still needs a workspace: without a
      // binding the app has nowhere to launch pi and falls back to a bare
      // shell in its own cwd.
      await this.provisionScratchWorkspace(id, now, {
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
    const binding = await this.deps.bindings.getBindingForTask(taskId);
    if (binding?.worktreePath) return this.moveTask(taskId, "dev");
    if (task.folderPath) {
      const now = this.deps.clock.now().toISOString();
      await this.provisionInPlaceWorkspace(taskId, task.folderPath, now, {
        persist: async () => {},
        undo: async () => {},
      });
      return this.moveTask(taskId, "dev");
    }
    if (!task.repositoryId) {
      // Parked scratch task: give it its scratch directory now, exactly
      // like a repository-backed task gets its worktree on start.
      const now = this.deps.clock.now().toISOString();
      await this.provisionScratchWorkspace(taskId, now, {
        persist: async () => {},
        undo: async () => {},
      });
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
    await this.provisionTaskWorkspace(
      repo,
      task.id,
      branch,
      now,
      {
        persist: () => this.deps.tasks.replaceTask(next),
        undo: () => this.deps.tasks.replaceTask(task),
      },
      task.baseRef ?? repo.defaultBranch,
      // A PR-bound task (created with `pullRequest`) checks its PR head out.
      task.pr && task.branch ? task.pr.number : undefined,
    );
    await this.publishTaskChange(next);
    return next;
  }

  /**
   * A non-git folder task's workspace: the binding points at the user's
   * folder itself (`inPlace: true`). Nothing is created, and nothing in core
   * ever deletes or git-touches it (Done/delete gate every git verb on
   * `task.repositoryId`, which a folder task never has).
   */
  private async provisionInPlaceWorkspace(
    taskId: string,
    folderPath: string,
    now: string,
    task: { persist: () => Promise<void>; undo: () => Promise<void> },
  ): Promise<void> {
    if (
      this.deps.folders &&
      !(await this.deps.folders.isDirectory(folderPath))
    ) {
      throw new Error(`Folder not found: ${folderPath}`);
    }
    await task.persist();
    try {
      await this.deps.bindings.attachBinding({
        id: this.deps.ids.next(),
        taskId,
        worktreePath: folderPath,
        inPlace: true,
        detached: false,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      await task.undo().catch(() => {});
      throw error;
    }
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
    /** Branch the worktree off this ref instead of the repository's default branch (`launchTask`'s `baseBranch: "parent"`). */
    baseRef: string = repo.defaultBranch,
    /** Check out this pull request's head as `branch` instead (PR-bound tasks). */
    pullRequestNumber?: number,
  ): Promise<void> {
    // Branch collision, dirty baseRef, missing repo, ... — createTaskWorktree
    // itself guarantees no leftover directory/bookkeeping on failure, so
    // there is nothing to clean up on this path beyond rethrowing.
    let worktree: WorktreeInfo;
    let createdBranch = true;
    if (pullRequestNumber !== undefined) {
      if (!this.deps.worktrees.checkoutPullRequest) {
        throw new Error("Pull-request checkouts are not supported here");
      }
      const checkout = await this.deps.worktrees.checkoutPullRequest(
        repo,
        branch,
        pullRequestNumber,
      );
      worktree = checkout.worktree;
      createdBranch = checkout.createdBranch;
    } else {
      worktree = await this.deps.worktrees.createTaskWorktree(
        repo,
        branch,
        baseRef,
      );
    }
    // Undo both halves of `git worktree add -b`: the directory and the
    // freshly-created (commit-less) branch, so a retry never collides with
    // a leftover ref. A pre-existing local branch is never deleted.
    const removeWorktree = () =>
      createdBranch
        ? this.discardTaskWorktree(repo, worktree.path, branch)
        : this.deps.worktrees
            .removeWorktree(repo, worktree.path, true)
            .catch(() => {});

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

  /**
   * Repository-less counterpart of `provisionTaskWorkspace`: a scratch
   * directory (`<stateDir>/scratch/<taskId>`) stands in for a worktree, so
   * the app's "launch pi when a binding has worktreePath" path works
   * unchanged. `persist` writes the task record; `undo` rolls it back if
   * the binding cannot be attached.
   */
  private async provisionScratchWorkspace(
    taskId: string,
    now: string,
    task: { persist: () => Promise<void>; undo: () => Promise<void> },
  ): Promise<void> {
    const scratchPath = await this.deps.scratch.ensureScratchDirectory(taskId);
    await task.persist();
    try {
      await this.deps.bindings.attachBinding({
        id: this.deps.ids.next(),
        taskId,
        worktreePath: scratchPath,
        scratch: true,
        detached: false,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      await task.undo().catch(() => {});
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
    let task = await this.requireTask(taskId);
    const binding = await this.deps.bindings.getBindingForTask(taskId);
    if (!binding?.worktreePath) return undefined;
    const now = this.deps.clock.now().toISOString();

    // A task that was `interrupted` (the app quit mid-turn) clears the
    // marker on its next session launch, resume or fresh "- it never
    // auto-resumes on its own, but opening it again means it is no longer
    // stuck "interrupted".
    if (task.launch?.status === "interrupted") {
      const launch: TaskLaunch = { ...task.launch, status: "started" };
      delete launch.interruptedAt;
      const next = await this.deps.tasks.patchTask(taskId, (fresh) =>
        fresh.launch?.status === "interrupted"
          ? { ...fresh, launch, updatedAt: now }
          : undefined,
      );
      if (next) task = next;
    }

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

    // A conversation recorded without its id (a task imported from pi-home):
    // reopen that exact file, never a fresh session next to it. It already
    // holds the task's prompt, so that is never replayed into it. The
    // harness's `recordTaskSession` call then binds its id for good.
    if (
      binding.sessionPath &&
      (await this.deps.sessions.exists(binding.sessionPath))
    ) {
      if (!task.initialPromptDeliveredAt) {
        await this.deps.tasks.patchTask(taskId, (fresh) =>
          fresh.initialPromptDeliveredAt
            ? undefined
            : { ...fresh, initialPromptDeliveredAt: now, updatedAt: now },
        );
      }
      return { mode: "open", sessionPath: binding.sessionPath };
    }

    // Legacy binding from before session binding existed: a pane already
    // ran here (its prompt was delivered), so reconnect to the most recent
    // conversation in this per-task worktree rather than starting a new
    // one. The harness's `recordTaskSession` call then binds it for good.
    if (task.initialPromptDeliveredAt) return { mode: "continue" };

    // A recorded file that is gone must not survive next to the fresh id:
    // a later resume would open it under an id it does not carry.
    const { sessionPath: _gone, ...fresh } = binding;
    const sessionId = this.deps.ids.next();
    await this.deps.bindings.replaceBinding({
      ...fresh,
      sessionId,
      updatedAt: now,
    });
    // First-ever launch: pass the task's model/thinking through to the
    // harness (the task's choice, else the configured default model), never
    // on a later resume/fork/continue. `launch.model` is where launched
    // tasks recorded their model before tasks carried one.
    let model = task.model ?? task.launch?.model;
    if (!model) {
      const config = await this.deps.config.load();
      model = config.launch?.defaultModel;
      // Record what "default" meant for this session, for display; the
      // harness's own default is only recorded, never passed.
      const sessionModel =
        model ?? (await this.deps.harness?.defaults())?.defaultModel;
      if (sessionModel) {
        const recorded = await this.deps.tasks.patchTask(taskId, (fresh) =>
          fresh.model || fresh.sessionModel
            ? undefined
            : { ...fresh, sessionModel, updatedAt: now },
        );
        if (recorded) await this.publishTaskChange(recorded);
      }
    }
    return {
      mode: "new",
      sessionId,
      ...(model ? { model } : {}),
      ...(task.thinking ? { thinking: task.thinking } : {}),
    };
  }

  async recordTaskSession(
    taskId: string,
    input: RecordTaskSessionInput,
  ): Promise<boolean> {
    if (!input.sessionId || !input.sessionPath) return false;
    const binding = await this.deps.bindings.getBindingForTask(taskId);
    if (!binding) return false;
    if (binding.sessionId) {
      if (binding.sessionId !== input.sessionId) {
        // Another conversation started inside the task's pane (e.g. Pi's
        // /new): the binding stays authoritative, like pi-home's. Unless it
        // is the bound file itself reporting a different id: then the file
        // is the conversation and the id was never written (a pi-home
        // import launched before `open` existed), so adopt the file's id.
        if (binding.sessionPath !== input.sessionPath) return false;
      } else if (binding.sessionPath === input.sessionPath) {
        return false;
      }
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
      // A folder task runs in place: point its parked binding back at the
      // folder so the reopened cycle has somewhere to run.
      const parked = task.folderPath
        ? await this.deps.bindings.getBindingForTask(taskId)
        : undefined;
      if (task.folderPath && parked && !parked.worktreePath) {
        await this.deps.bindings.replaceBinding({
          ...parked,
          worktreePath: task.folderPath,
          inPlace: true,
          updatedAt: now,
        });
      }
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
    const binding = await this.deps.bindings.getBindingForTask(id);
    // A deleted task has no reopen path: its worktree would be an orphan
    // nothing ever reaps, so delete takes it along unless asked not to.
    // Every refusal (live pane, dirty) throws before anything is touched,
    // leaving the task intact.
    if (!options?.keepWorkspace && binding?.worktreePath && task.repositoryId) {
      const repo = await this.findRepository(task.repositoryId).catch(
        () => undefined,
      );
      if (repo) {
        const path = binding.worktreePath;
        const protectedPaths = options?.protectedPaths ?? [];
        if (isProtectedPath(path, protectedPaths)) {
          throw new Error(
            `Can't delete ${task.title}: its worktree is open in a live session (${path}); close it first`,
          );
        }
        const dirty = await this.deps.worktrees
          .isWorktreeDirty(path)
          .catch(() => false);
        if (dirty && !options?.removeDirty) {
          throw new Error(
            `Refusing to delete ${task.title}: its worktree is dirty (uncommitted changes in ${path}); pass removeDirty to discard them`,
          );
        }
        await this.deps.worktrees.removeWorktree(repo, path, dirty);
        // Best-effort from here: the task's own worktree is gone, so the
        // delete goes through; leftovers surface in the orphan scan.
        await this.removeReviewCheckouts(repo, path, protectedPaths);
        if (task.branch) {
          await this.deleteMergedBranch(repo, task.branch, task.pr);
        }
      }
    }
    await this.deps.bindings.removeBinding(id).catch(() => {});
    await this.deps.tasks.removeTask(id);
    await this.publishBoard();
  }

  async scanOrphanWorktrees(): Promise<OrphanWorktreeReport> {
    const config = await this.deps.config.load();
    if (!config.codeRoot) return { root: "", orphans: [] };
    const { root, dirs } = await this.deps.worktrees.listTaskWorktreeDirs(
      config.codeRoot,
    );
    // Parked bindings carry no worktreePath, so a Done task's leftover
    // directory counts as an orphan too (its cleanup failed or never ran).
    const bound = (await this.deps.bindings.listBindings())
      .map((binding) => binding.worktreePath)
      .filter((path): path is string => Boolean(path));
    const paths = findOrphanDirs(dirs, bound);
    const orphans = await Promise.all(
      paths.map(async (path) => {
        const sizeBytes = await this.deps.worktrees.diskUsageBytes(path);
        return sizeBytes === undefined ? { path } : { path, sizeBytes };
      }),
    );
    const warning = orphanWorktreeWarning(root, orphans);
    return { root, orphans, ...(warning ? { warning } : {}) };
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
              pr: toTaskPullRequest(
                entered.pullRequest,
                entered.targetBranch,
                fresh.pr?.role,
              ),
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
        this.rules?.knownSourceIds() ?? new Set<string>(),
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

  async launchTask(input: LaunchTaskInput): Promise<Task> {
    const now = this.deps.clock.now().toISOString();
    const id = this.deps.ids.next();
    const config = await this.deps.config.load();

    let parentTaskId: string | undefined;
    let launchedFromTaskId: string | undefined;
    let parentTask: Task | undefined;
    if (input.relation === "child") {
      if (!input.fromTaskId) {
        throw new Error(
          'launchTask requires "fromTaskId" when relation is "child"',
        );
      }
      parentTask = await this.deps.tasks.getTask(input.fromTaskId);
      if (!parentTask) throw new Error(`Task not found: ${input.fromTaskId}`);
      if (parentTask.parentTaskId) {
        throw new Error(
          "A child task cannot launch further children (one level only); launch a standalone task instead",
        );
      }
      parentTaskId = parentTask.id;
    } else if (input.fromTaskId) {
      launchedFromTaskId = input.fromTaskId;
    }

    if (input.baseBranch === "parent" && input.relation !== "child") {
      throw new Error('baseBranch "parent" is only valid for a child task');
    }
    if (input.baseBranch === "parent" && input.baseRef) {
      throw new Error('baseBranch "parent" and baseRef are mutually exclusive');
    }

    if ("cloneUrl" in input.repository && !config.codeRoot) {
      throw new Error(
        "launchTask with a cloneUrl requires codeRoot to be configured",
      );
    }
    const where = await this.resolveWhere(
      input.repository,
      config,
      input.inPlace,
    );
    const repo = where.kind === "repository" ? where.repo : undefined;
    const hasRepository = where.kind === "repository";

    let baseRef: string | undefined = repo
      ? input.baseRef?.trim() || undefined
      : undefined;
    let dependencyBranch: string | undefined;
    if (input.baseBranch === "parent") {
      if (!repo || !parentTask || parentTask.repositoryId !== repo.id) {
        throw new Error(
          'baseBranch "parent" requires the child to launch in the same repository as its parent',
        );
      }
      if (!parentTask.branch) {
        throw new Error(
          "The parent task has no branch yet to base this child on",
        );
      }
      baseRef = parentTask.branch;
      dependencyBranch = parentTask.branch;
    } else if (
      repo &&
      baseRef &&
      baseRef !== repo.defaultBranch &&
      baseRef !== `origin/${repo.defaultBranch}`
    ) {
      // Based on another branch: the agent must state that dependency.
      dependencyBranch = baseRef;
    }

    const kickoff = buildLaunchKickoffPrompt({
      hasRepository,
      ...(parentTask
        ? { parent: { title: parentTask.title, id: parentTask.id } }
        : {}),
      ...(dependencyBranch ? { dependencyBranch } : {}),
    });
    const prompt = await this.adoptAttachments(
      id,
      input.prompt.trim(),
      input.attachments,
    );
    const initialPrompt = `${prompt}\n\n${kickoff}`;

    const launch: TaskLaunch = {
      status: "queued",
      requestedAt: now,
    };

    const task: Task = {
      id,
      kind: hasRepository ? "task" : "temp_task",
      state: "dev",
      title: input.title,
      initialPrompt,
      ...(repo ? { repositoryId: repo.id } : {}),
      ...(where.kind === "folder" ? { folderPath: where.path } : {}),
      ...(baseRef ? { baseRef } : {}),
      ...agentFields(input),
      ...(parentTaskId ? { parentTaskId } : {}),
      ...(launchedFromTaskId ? { launchedFromTaskId } : {}),
      launch,
      createdAt: now,
      updatedAt: now,
      stateChangedAt: now,
    };

    if (repo) {
      const branch = deriveTaskBranch(
        input.title,
        id,
        config.branchPrefix ?? "",
      );
      const next: Task = { ...task, branch, targetBranch: repo.defaultBranch };
      await this.provisionTaskWorkspace(
        repo,
        id,
        branch,
        now,
        {
          persist: () => this.deps.tasks.createTask(next),
          undo: () => this.deps.tasks.removeTask(id),
        },
        baseRef ?? repo.defaultBranch,
      );
      await this.publishTaskChange(next);
      return next;
    }

    if (where.kind === "folder") {
      await this.provisionInPlaceWorkspace(id, where.path, now, {
        persist: () => this.deps.tasks.createTask(task),
        undo: () => this.deps.tasks.removeTask(id),
      });
      await this.publishTaskChange(task);
      return task;
    }

    await this.provisionScratchWorkspace(id, now, {
      persist: () => this.deps.tasks.createTask(task),
      undo: () => this.deps.tasks.removeTask(id),
    });
    await this.publishTaskChange(task);
    return task;
  }

  async claimPendingLaunches(limit: number): Promise<Task[]> {
    if (limit <= 0) return [];
    const now = this.deps.clock.now().toISOString();
    const claimed = await this.deps.tasks.claimQueuedLaunches(limit, now);
    if (claimed.length > 0) await this.publishBoard();
    return claimed;
  }

  async markLaunchesInterrupted(taskIds: string[]): Promise<void> {
    const now = this.deps.clock.now().toISOString();
    let changed = false;
    for (const id of taskIds) {
      const result = await this.deps.tasks.patchTask(id, (task) => {
        if (task.launch?.status !== "started") return undefined;
        return {
          ...task,
          launch: { ...task.launch, status: "interrupted", interruptedAt: now },
          updatedAt: now,
        };
      });
      if (result) changed = true;
    }
    if (changed) await this.publishBoard();
  }

  async listChildren(parentTaskId: string): Promise<Task[]> {
    const tasks = await this.deps.tasks.listTasks();
    return tasks
      .filter((task) => task.parentTaskId === parentTaskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getLaunchSettings(): Promise<{
    maxConcurrent: number;
    defaultModel?: string;
  }> {
    const config = await this.deps.config.load();
    return {
      maxConcurrent:
        config.launch?.maxConcurrent ?? DEFAULT_LAUNCH_MAX_CONCURRENT,
      ...(config.launch?.defaultModel
        ? { defaultModel: config.launch.defaultModel }
        : {}),
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
    const warnings: string[] = [];
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
    // One bindings read per pass (lazy, shared by all candidates) feeds the
    // branch-follow step below; no per-task binding lookups.
    let bindingsByTask: Promise<Map<string, WorkspaceBinding>> | undefined;
    const bindingFor = (taskId: string) => {
      bindingsByTask ??= this.deps.bindings
        .listBindings()
        .then((all) => new Map(all.map((b) => [b.taskId, b])))
        .catch(() => new Map<string, WorkspaceBinding>());
      return bindingsByTask.then((byTask) => byTask.get(taskId));
    };
    // Branch-follow first (a HEAD-file read per task, no spawn), so the
    // batched PR lookup below asks about each task's current branch.
    const observed: Task[] = [];
    await forEachConcurrently(
      candidates,
      REFRESH_CONCURRENCY,
      async (listed, index) => {
        const adopted = await this.followWorktreeBranch(
          listed,
          repositories,
          await bindingFor(listed.id),
        );
        if (adopted) changed = true;
        observed[index] = adopted ?? listed;
      },
    );
    const prefetched = await this.prefetchPullRequests(observed, repositories);
    // This tick's PR observations, by task id, for the `github` source.
    const observations = new Map<string, { status?: PullRequestStatus }>();
    await forEachConcurrently(observed, REFRESH_CONCURRENCY, async (task) => {
      const patched = await this.refreshTask(
        task,
        repositories,
        warnings,
        connectivity,
        observations,
        prefetched.get(task.id),
      );
      if (patched) changed = true;
    });

    // Board automation: the rules engine (sources → events → rules →
    // actions), only with the kill switch on.
    if (config.automation && this.rules) {
      const result = await this.rules.tick({
        tasks: await this.deps.tasks.listTasks(),
        config,
        observed: observations,
        protectedPaths,
        executor: this.ruleExecutor(),
      });
      warnings.push(...result.warnings);
      for (const failure of result.sourceFailures) {
        if (isConnectivityError(failure)) connectivity.failedChecks += 1;
        else warnings.push(failure);
      }
      if (result.changed) changed = true;
    }

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
   * A task follows its worktree's current branch: an agent may `git checkout
   * -b other` inside the worktree and open its PR from there, so the PR lookup
   * by the original branch would never find it. Adopts the checked-out branch
   * onto the task and its binding (so PR lookup, PR create and Done cleanup
   * all act on it) and returns the patched task; `undefined` when nothing
   * changed. The original local branch is deliberately left alone (it is
   * never deleted here). One `git branch --show-current` per live bound task.
   */
  private async followWorktreeBranch(
    task: Task,
    repositories: Map<string, RepositoryInfo> | undefined,
    binding: WorkspaceBinding | undefined,
  ): Promise<Task | undefined> {
    if (!binding?.worktreePath) return undefined;
    try {
      const adopt = branchToAdopt({
        taskBranch: task.branch,
        currentBranch: await this.deps.worktrees.currentBranch(
          binding.worktreePath,
        ),
        targetBranch: task.targetBranch,
        defaultBranch: task.repositoryId
          ? repositories?.get(task.repositoryId)?.defaultBranch
          : undefined,
      });
      if (!adopt) return undefined;
      let applied = false;
      const patched = await this.deps.tasks.patchTask(task.id, (fresh) => {
        if (
          fresh.state === "done" ||
          fresh.state === "backlog" ||
          fresh.branch !== task.branch
        ) {
          return undefined;
        }
        applied = true;
        return {
          ...fresh,
          branch: adopt,
          updatedAt: this.deps.clock.now().toISOString(),
        };
      });
      if (!applied || !patched) return undefined;
      const freshBinding = await this.deps.bindings.getBindingForTask(task.id);
      if (freshBinding) {
        await this.deps.bindings.replaceBinding({
          ...freshBinding,
          branch: adopt,
        });
      }
      return patched;
    } catch {
      return undefined;
    }
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

  /**
   * One batched PR lookup per repository for this tick's observed tasks
   * (when the PR access supports it), keyed by task id. A failed batch
   * hands its error to each of its tasks, so `refreshTask` reports it
   * exactly as a failed per-task lookup (per-task warning or connectivity
   * count) and records no observation for the rules engine. Tasks missing from the map (no
   * batch support, no origin remote) are looked up one by one as before.
   */
  private async prefetchPullRequests(
    tasks: readonly Task[],
    repositories: Map<string, RepositoryInfo> | undefined,
  ): Promise<Map<string, PrefetchedPullRequest>> {
    const prefetched = new Map<string, PrefetchedPullRequest>();
    const pullRequests = this.deps.pullRequests;
    if (!pullRequests.statusMany) return prefetched;
    const byRepository = new Map<string, Task[]>();
    for (const task of tasks) {
      if (!task.repositoryId || !task.branch) continue;
      const repo = repositories?.get(task.repositoryId);
      if (repo && !repo.remoteUrl) continue;
      const group = byRepository.get(task.repositoryId) ?? [];
      group.push(task);
      byRepository.set(task.repositoryId, group);
    }
    await Promise.all(
      [...byRepository].map(async ([repositoryId, group]) => {
        try {
          const statuses = await pullRequests.statusMany?.(
            repositoryId,
            group.map((task) => task.branch as string),
          );
          for (const task of group) {
            prefetched.set(task.id, {
              status: statuses?.get(task.branch as string),
            });
          }
        } catch (error) {
          for (const task of group) prefetched.set(task.id, { error });
        }
      }),
    );
    return prefetched;
  }

  /**
   * Observe one task's PR and patch `task.pr`; returns whether the task
   * changed. Records the observation in `observations` for the rules
   * engine's `github` source (a failed lookup records nothing: its facts
   * stay as they were, and nothing moves on stale data).
   */
  private async refreshTask(
    snapshot: Task,
    repositories: Map<string, RepositoryInfo> | undefined,
    warnings: string[],
    connectivity: { failedChecks: number },
    observations: Map<string, { status?: PullRequestStatus }>,
    prefetched?: PrefetchedPullRequest,
  ): Promise<boolean> {
    const repositoryId = snapshot.repositoryId;
    const branch = snapshot.branch;
    if (!repositoryId || !branch) return false;
    const repo = repositories?.get(repositoryId);
    // No origin remote: nothing on GitHub to observe, and nothing to warn
    // about every tick either (pi-home's silent skip).
    if (repo && !repo.remoteUrl) return false;

    let changed = false;
    try {
      if (prefetched && "error" in prefetched) throw prefetched.error;
      const status = prefetched
        ? prefetched.status
        : await this.deps.pullRequests.status(repositoryId, branch);
      if (status) {
        // Re-read under the lock and patch only `pr`: the task may have
        // been moved, reopened onto a new branch, or completed while gh was
        // answering — never write the stale snapshot back over that.
        const current = await this.deps.tasks.patchTask(
          snapshot.id,
          (fresh) => {
            if (!sameObservation(fresh, snapshot)) return undefined;
            const pr = toTaskPullRequest(
              status,
              snapshot.targetBranch ?? repo?.defaultBranch,
              fresh.pr?.role ?? roleFromViewer(status.viewerIsAuthor),
            );
            if (prEquals(fresh.pr, pr)) return undefined;
            changed = true;
            return {
              ...fresh,
              pr,
              updatedAt: this.deps.clock.now().toISOString(),
            };
          },
        );
        if (current && sameObservation(current, snapshot)) {
          observations.set(snapshot.id, { status });
        }
      } else {
        observations.set(snapshot.id, {});
      }
    } catch (error) {
      this.recordFailure(snapshot.title, error, warnings, connectivity);
    }
    return changed;
  }

  /** Repositories by id for this refresh; `undefined` when discovery itself failed (then nothing is skipped). */
  private async repositoryIndex(
    config: GlobalConfig,
  ): Promise<Map<string, RepositoryInfo> | undefined> {
    try {
      const repos = await this.allRepositories(config);
      return new Map(repos.map((repo) => [repo.id, repo]));
    } catch {
      return undefined;
    }
  }

  /** The core commands rule actions run through (see manager/rules-runtime.ts). */
  private ruleExecutor(): RuleActionExecutor {
    return {
      move: (task, move, protectedPaths, warnings) =>
        this.executeRuleMove(task, move, protectedPaths, warnings),
      inbox: async (input, provenance) => {
        const item = await this.addInboxItem({
          kind: "rule",
          title: String(input.title),
          ...(input.body !== undefined ? { body: String(input.body) } : {}),
          buttons: (input.buttons ?? []).map((button, index) => ({
            id: `b${index}`,
            label: String(button.label),
            action: button.action,
            ...(button.with ? { with: button.with } : {}),
          })),
          ...(provenance.taskId ? { taskId: provenance.taskId } : {}),
          ruleId: provenance.ruleId,
          eventId: provenance.eventId,
        });
        return { outcome: "applied", detail: item.id };
      },
      createTask: async (input) => {
        const task = await this.createTaskFromAction(input);
        return { outcome: "applied", detail: task.id };
      },
      message: async (input, provenance) => {
        const target = input.to ?? provenance.taskId;
        if (!target) {
          throw new Error("message needs a task-bound event or `to`");
        }
        const result = await this.sendTaskMessage({
          from: { kind: "rule", ruleId: provenance.ruleId },
          targetTaskId: String(target),
          text: String(input.text),
          ...(input.mode ? { mode: input.mode } : {}),
        });
        return { outcome: "applied", detail: result.message.id };
      },
    };
  }

  /** Execute a rule's winning move; `stayed` when auto-landing was refused. */
  private async executeRuleMove(
    task: Task,
    move: ResolvedMove,
    protectedPaths: readonly string[],
    warnings: string[],
  ): Promise<ActionResult> {
    switch (move.state) {
      case "dev":
        await this.moveTask(task.id, "dev");
        return { outcome: "applied" };
      case "awaiting":
        if (move.enter && move.kind) {
          await this.toAwait(task.id, move.kind, {
            ...(move.inputs ? { inputs: move.inputs } : {}),
          });
        } else {
          await this.moveTask(task.id, "awaiting", {
            ...(move.awaiting ? { awaiting: move.awaiting } : {}),
          });
        }
        return { outcome: "applied" };
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
          return { outcome: "stayed", detail: result.warning ?? "" };
        }
        if (result.warning) warnings.push(`${task.title}: ${result.warning}`);
        return { outcome: "applied" };
      }
      default:
        return { outcome: "skipped", detail: `cannot move to ${move.state}` };
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
    // A manual Done on a parent with active children asks first (children
    // are never touched either way); auto-landing (rule-driven) never asks
    // anyone, so it skips straight past this "- and a non-empty answer never
    // blocks it.
    if (how.mode === "manual" && !how.force.leaveChildren) {
      const children = await this.listChildren(task.id);
      const active = children.filter((child) => child.state !== "done");
      if (active.length > 0) {
        return {
          confirm: {
            requiresConfirmation: "activeChildren",
            detail: `${task.title} has ${active.length} active child task${active.length === 1 ? "" : "s"}: ${active.map((child) => child.title).join(", ")}`,
          },
        };
      }
    }
    if (!task.repositoryId) {
      // Repository-less (scratch) task: there is no git here at all. The
      // scratch directory stays on disk; only park the binding, exactly
      // like a git worktree binding minus the git removal (never run
      // worktree/branch verbs against a scratch binding).
      const binding = await this.deps.bindings.getBindingForTask(task.id);
      if (binding?.worktreePath) await this.parkBinding(binding);
    }
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
          if (removed) {
            const reviewWarning = await this.removeReviewCheckouts(
              repo,
              path,
              protectedPaths,
            );
            if (reviewWarning) addWarning(reviewWarning);
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

  /**
   * Remove the clean, detached PR-review checkouts an agent made next to the
   * task's worktree (`<dir>-pr<N>` / `<dir>-prlocal`, see
   * `isReviewCheckoutOf`). Never forced and never touches a live pane's
   * cwd; returns a warning naming whatever stayed, `undefined` otherwise.
   */
  private async removeReviewCheckouts(
    repo: RepositoryInfo,
    taskWorktreePath: string,
    protectedPaths: readonly string[],
  ): Promise<string | undefined> {
    let listed: WorktreeInfo[];
    try {
      listed = await this.deps.worktrees.listWorktrees(repo);
    } catch (error) {
      return `review checkouts left in place: ${describeError(error)}`;
    }
    const failures: string[] = [];
    for (const worktree of listed) {
      if (
        !isReviewCheckoutOf(taskWorktreePath, worktree) ||
        isProtectedPath(worktree.path, protectedPaths)
      ) {
        continue;
      }
      try {
        await this.deps.worktrees.removeWorktree(repo, worktree.path, false);
      } catch (error) {
        failures.push(describeError(error));
      }
    }
    return failures.length > 0
      ? `review checkout left in place: ${failures.join("; ")}`
      : undefined;
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
    // One bindings read per pass, not one per done task: the done list only
    // grows, and each per-task lookup used to re-read the whole file.
    let bindingsByTask: Map<string, WorkspaceBinding> | undefined;
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
      if (!bindingsByTask) {
        try {
          bindingsByTask = new Map(
            (await this.deps.bindings.listBindings()).map((binding) => [
              binding.taskId,
              binding,
            ]),
          );
        } catch {
          // Unreadable bindings: nothing to retry this pass (as before,
          // when every per-task lookup failed the same way).
          return false;
        }
      }
      let binding = bindingsByTask.get(task.id);
      if (binding?.worktreePath) {
        // Rare path (a worktree is actually still on disk): re-read this one
        // binding so the cleanup below acts on, and parks, current data
        // rather than the pass-start snapshot.
        try {
          binding = await this.deps.bindings.getBindingForTask(task.id);
        } catch {
          continue;
        }
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
        const reviewFailure = await this.removeReviewCheckouts(
          repo,
          binding.worktreePath,
          protectedPaths,
        );
        const branchFailure = await this.deleteMergedBranch(
          repo,
          task.branch,
          task.pr,
        );
        failure =
          [reviewFailure, branchFailure].filter(Boolean).join("; ") ||
          undefined;
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
    const repos = await this.allRepositories(config);
    const repo = repos.find((candidate) => candidate.id === repositoryId);
    if (!repo) throw new Error(`Repository not found: ${repositoryId}`);
    return repo;
  }

  // --- Task messaging (see /docs/task-messaging.md) ---------------------

  async findTasks(
    query: string,
    options?: FindTasksOptions,
  ): Promise<TaskSearchResult[]> {
    const { harness } = this.requireMessaging();
    const tasks = await this.deps.tasks.listTasks();
    const matches = matchTasks(query, tasks, options);
    return Promise.all(
      matches.map(async ({ task, relation }): Promise<TaskSearchResult> => {
        const presence =
          task.launch?.status === "queued"
            ? { live: false, runningTurn: false }
            : await harness.presence(task.id);
        return {
          id: task.id,
          title: task.title,
          state: task.state,
          ...(task.repositoryId ? { repositoryId: task.repositoryId } : {}),
          ...(task.branch ? { branch: task.branch } : {}),
          ...(task.pr ? { prNumber: task.pr.number } : {}),
          run: deriveRunState(task, presence),
          relation,
        };
      }),
    );
  }

  async sendTaskMessage(
    input: SendTaskMessageInput,
  ): Promise<SendTaskMessageResult> {
    const { messages, harness } = this.requireMessaging();
    const text = input.text;
    if (!text.trim()) throw new Error("Message text is empty.");

    // 1. sender ≠ target.
    let senderTask: Task | undefined;
    if (input.from.kind === "task") {
      if (input.from.taskId === input.targetTaskId) {
        throw new Error("A task can't send a message to itself.");
      }
      senderTask = await this.deps.tasks.getTask(input.from.taskId);
      if (!senderTask) {
        throw new Error(`Sending task not found: ${input.from.taskId}`);
      }
    } else if (input.from.kind === "harbormaster") {
      throw new Error("Messages can't be sent as Harbormaster.");
    }

    // 2. The target exists and is not Done/Backlog.
    const target = await this.deps.tasks.getTask(input.targetTaskId);
    if (!target) throw new Error(`Task not found: ${input.targetTaskId}`);
    const unavailable =
      undeliverableReason(target) ?? (await this.noSessionReason(target));
    if (unavailable) throw new Error(unavailable);

    // 3. Route from lineage (non-task senders always need approval).
    const route = classifyRoute(input.from, senderTask, target);

    // 4. Child → parent: the parent must be live (and not Done, above) and
    //    the child's own harness must be able to receive the answer.
    if (route === "child-to-parent") {
      if (!(await harness.presence(target.id)).live) {
        throw new Error(
          "Your parent task is not running; stop and ask the user instead.",
        );
      }
      if (!harness.messaging.receive) {
        throw new Error(
          "Your harness can't receive replies, so your parent couldn't answer; stop and ask the user instead.",
        );
      }
    }

    // 5. The target's harness must be able to receive.
    if (!harness.messaging.receive) {
      throw new Error(
        `Task ${target.id}'s harness can't receive messages; tell the user instead.`,
      );
    }

    // 6. Lineage routes check the loop cap.
    const config = await this.deps.config.load();
    const cap = config.messaging?.loopCap ?? DEFAULT_MESSAGE_LOOP_CAP;
    const capCheck =
      senderTask && (route === "parent-to-child" || route === "child-to-parent")
        ? (store: MessageStoreSnapshot) => {
            const parent = route === "parent-to-child" ? senderTask : target;
            const child = route === "parent-to-child" ? target : senderTask;
            const count = countLoopMessages(
              store.messages,
              store.userInputs,
              parent.id,
              child.id,
            );
            if (count >= cap) {
              throw new Error(
                `Message cap reached between "${child.title}" and "${parent.title}" (${cap} since the user last typed); stop and ask the user.`,
              );
            }
          }
        : undefined;
    if (capCheck) capCheck(await messages.readStore());

    // 7. Attachments are validated and copied.
    const id = this.deps.ids.next();
    const attachments = await messages.copyAttachments(
      id,
      input.attachments ?? [],
    );

    const mode = input.mode ?? defaultMode(route);
    const message: TaskMessage = {
      id,
      sender: input.from,
      senderLabel: senderLabelFor(input.from, senderTask),
      targetTaskId: target.id,
      route,
      text,
      requestedMode: mode,
      attachments,
      status: route === "approval" ? "awaiting_approval" : "pending",
      createdAt: this.deps.clock.now().toISOString(),
    };
    try {
      await messages.recordMessage(message, {
        ...(capCheck ? { precondition: capCheck } : {}),
      });
    } catch (error) {
      if (attachments.length > 0) await messages.removeAttachments(id);
      throw error;
    }
    this.emitMessagesChanged([target.id, senderTask?.id]);

    if (message.status === "awaiting_approval") {
      return {
        message,
        willWake: false,
        note:
          input.from.kind === "task"
            ? "Awaiting the user's approval in the Harbormaster app; you'll get a follow-up with the result. Don't wait for it -- continue or end your turn."
            : "Awaiting the user's approval in the Harbormaster app; no result is reported back to this session.",
      };
    }
    if (target.launch?.status === "queued") {
      return {
        message,
        willWake: false,
        note: `"${target.title}" has a queued launch; the message will be delivered as soon as it starts.`,
      };
    }
    if ((await harness.presence(target.id)).live) {
      const delivered = resolveDeliveredMode(mode, harness.messaging);
      return {
        message,
        willWake: false,
        note:
          delivered === "steer"
            ? `Delivered to the inbox of "${target.title}" (steer); it arrives at its next step boundary.`
            : `Delivered to the inbox of "${target.title}" (followUp); it arrives once it finishes its pending work.`,
      };
    }
    return {
      message,
      willWake: true,
      note: `"${target.title}" isn't running; Harbormaster will wake it and deliver the message.`,
    };
  }

  async claimInboxMessages(
    taskId: string,
    options: { idle: boolean },
  ): Promise<TaskMessage[]> {
    const { messages, harness } = this.requireMessaging();
    const now = this.deps.clock.now().toISOString();
    const task = await this.deps.tasks.getTask(taskId);
    const reason = task ? undeliverableReason(task) : undefined;
    if (!task || reason) {
      const failed = await messages.failPendingForTask(
        taskId,
        now,
        reason ??
          `Task ${taskId} no longer exists; messages can't be delivered.`,
      );
      if (failed.length > 0) this.emitMessagesChanged(affectedTaskIds(failed));
      return [];
    }
    const claimed = await messages.claimDeliverable(taskId, {
      idle: options.idle,
      deliveredAt: now,
      resolveMode: (requested) =>
        resolveDeliveredMode(requested, harness.messaging),
    });
    if (claimed.length > 0) this.emitMessagesChanged(affectedTaskIds(claimed));
    return claimed;
  }

  /**
   * A target with no workspace binding (no worktree or scratch directory)
   * can never host a Harbormaster-launched session, so it could never
   * claim its inbox: reject up front instead of leaving the app to retry
   * waking it forever.
   */
  private async noSessionReason(task: Task): Promise<string | undefined> {
    const binding = await this.deps.bindings.getBindingForTask(task.id);
    return binding?.worktreePath
      ? undefined
      : `Task ${task.id} has no workspace, so it has no session to receive messages; tell the user instead.`;
  }

  subscribeInbox(taskId: string, listener: () => void): () => void {
    return this.requireMessaging().messages.watchDoorbell(taskId, listener);
  }

  async reportPresence(taskId: string, report: PresenceReport): Promise<void> {
    const presence = this.requirePresence();
    await presence.applyReport(taskId, (current) =>
      applyProgramStatus(current, {
        taskId,
        pid: report.pid,
        state: report.state,
        ...(report.message ? { message: report.message } : {}),
        at: report.at ?? this.deps.clock.now().toISOString(),
      }),
    );
  }

  async endPresence(
    taskId: string,
    input: { pid: number; at?: string },
  ): Promise<void> {
    await this.requirePresence().end(
      taskId,
      input.pid,
      input.at ?? this.deps.clock.now().toISOString(),
    );
  }

  async reportTaskOutcome(
    taskId: string,
    outcome: { status: "done" | "blocked"; note?: string },
  ): Promise<void> {
    const presence = this.requirePresence();
    const status = await this.getPresence(taskId);
    if (!status.live || !status.record) {
      throw new Error(
        "This session is not linked to a live Harbormaster task; status was not recorded.",
      );
    }
    await presence.reportOutcome(
      taskId,
      status.record.pid,
      outcome.status,
      outcome.note?.trim() || undefined,
      this.deps.clock.now().toISOString(),
    );
  }

  async getPresence(taskId: string): Promise<PresenceStatus> {
    const { harness } = this.deps;
    if (!harness) throw new Error("presence is not configured");
    return harness.presence(taskId);
  }

  private requirePresence(): PresenceAccess {
    if (!this.deps.presence) throw new Error("presence is not configured");
    return this.deps.presence;
  }

  async recordUserInput(taskId: string): Promise<void> {
    const { messages } = this.requireMessaging();
    await messages.recordUserInput(taskId, this.deps.clock.now().toISOString());
    const tasks = await this.deps.tasks.listTasks();
    const self = tasks.find((task) => task.id === taskId);
    this.emitMessagesChanged([
      taskId,
      self?.parentTaskId,
      ...tasks
        .filter((task) => task.parentTaskId === taskId)
        .map((task) => task.id),
    ]);
  }

  async listPendingApprovals(): Promise<TaskMessage[]> {
    const { messages } = this.requireMessaging();
    return (await messages.listMessages()).filter(
      (message) => message.status === "awaiting_approval",
    );
  }

  async approveMessage(
    messageId: string,
    edits?: ApproveMessageEdits,
  ): Promise<TaskMessage> {
    const { messages } = this.requireMessaging();
    const message = await this.requireAwaitingApproval(messageId);
    if (edits?.text !== undefined && !edits.text.trim()) {
      throw new Error("Message text is empty.");
    }
    const now = this.deps.clock.now().toISOString();
    const target = await this.deps.tasks.getTask(message.targetTaskId);
    const reason = target
      ? (undeliverableReason(target) ?? (await this.noSessionReason(target)))
      : `Task ${message.targetTaskId} no longer exists; messages can't be delivered.`;
    let result: TaskMessage;
    if (reason) {
      result = (await messages.failMessage(messageId, now, reason)) ?? message;
    } else {
      result = await messages.approveMessage(messageId, {
        approvedAt: now,
        ...(edits?.text !== undefined ? { text: edits.text } : {}),
        ...(edits?.mode ? { mode: edits.mode } : {}),
      });
    }
    await this.sendReceipt(result, target);
    this.emitMessagesChanged(affectedTaskIds([result]));
    return result;
  }

  async rejectMessage(messageId: string): Promise<TaskMessage> {
    const { messages } = this.requireMessaging();
    await this.requireAwaitingApproval(messageId);
    const result = await messages.rejectMessage(
      messageId,
      this.deps.clock.now().toISOString(),
    );
    await this.sendReceipt(
      result,
      await this.deps.tasks.getTask(result.targetTaskId),
    );
    this.emitMessagesChanged(affectedTaskIds([result]));
    return result;
  }

  async listTasksWithPendingMessages(): Promise<string[]> {
    const { messages } = this.requireMessaging();
    const targets = await messages.listPendingTargets();
    if (targets.length === 0) return [];
    const now = this.deps.clock.now().toISOString();
    const wake: string[] = [];
    for (const taskId of targets) {
      const task = await this.deps.tasks.getTask(taskId);
      const reason = task ? undeliverableReason(task) : "gone";
      if (task && !reason) {
        wake.push(taskId);
        continue;
      }
      const failed = await messages.failPendingForTask(
        taskId,
        now,
        reason && task
          ? reason
          : `Task ${taskId} no longer exists; messages can't be delivered.`,
      );
      if (failed.length > 0) this.emitMessagesChanged(affectedTaskIds(failed));
    }
    return wake;
  }

  async getMessagingStates(): Promise<TaskMessagingState[]> {
    const { messages, harness } = this.requireMessaging();
    const [tasks, store, config] = await Promise.all([
      this.deps.tasks.listTasks(),
      messages.readStore(),
      this.deps.config.load(),
    ]);
    const parentIds = [
      ...new Set(
        tasks.flatMap((task) => (task.parentTaskId ? [task.parentTaskId] : [])),
      ),
    ];
    const liveTaskIds = new Set<string>();
    await Promise.all(
      parentIds.map(async (parentId) => {
        if ((await harness.presence(parentId)).live) liveTaskIds.add(parentId);
      }),
    );
    return deriveMessagingStates({
      tasks,
      messages: store.messages,
      userInputs: store.userInputs,
      liveTaskIds,
      now: this.deps.clock.now(),
      parentReplyTimeoutMinutes:
        config.messaging?.parentReplyTimeoutMinutes ??
        DEFAULT_PARENT_REPLY_TIMEOUT_MINUTES,
      loopCap: config.messaging?.loopCap ?? DEFAULT_MESSAGE_LOOP_CAP,
    });
  }

  async listMessages(filter?: { taskId?: string }): Promise<TaskMessage[]> {
    return this.requireMessaging().messages.listMessages(filter);
  }

  async readMessageAttachment(
    messageId: string,
    index: number,
  ): Promise<{ mimeType?: string; base64: string }> {
    const { messages } = this.requireMessaging();
    const message = await messages.getMessage(messageId);
    if (!message) throw new Error(`Message not found: ${messageId}`);
    const attachment = message.attachments[index];
    if (!attachment) {
      throw new Error(`Message ${messageId} has no attachment ${index}.`);
    }
    if (attachment.prunedAt) {
      throw new Error("Attachment was pruned; its file is no longer stored.");
    }
    return {
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      base64: await messages.readAttachment(attachment),
    };
  }

  async pruneMessageAttachments(): Promise<number> {
    const { messages } = this.requireMessaging();
    const [store, tasks] = await Promise.all([
      messages.readStore(),
      this.deps.tasks.listTasks(),
    ]);
    const now = this.deps.clock.now();
    const eligible = selectMessagesToPrune(
      store.messages,
      new Map(tasks.map((task) => [task.id, task])),
      now,
    );
    for (const message of eligible) {
      await messages.removeAttachments(message.id);
      await messages.markAttachmentsPruned(message.id, now.toISOString());
    }
    if (eligible.length > 0)
      this.emitMessagesChanged(affectedTaskIds(eligible));
    return eligible.length;
  }

  private requireMessaging(): {
    messages: MessageAccess;
    harness: HarnessAdapter;
  } {
    const { messages, harness } = this.deps;
    if (!messages || !harness) throw new Error("messaging is not configured");
    return { messages, harness };
  }

  private async requireAwaitingApproval(
    messageId: string,
  ): Promise<TaskMessage> {
    const message =
      await this.requireMessaging().messages.getMessage(messageId);
    if (!message) throw new Error(`Message not found: ${messageId}`);
    if (message.status !== "awaiting_approval") {
      throw new Error(`Message ${messageId} is not awaiting approval.`);
    }
    return message;
  }

  /**
   * Reports an approval decision back to a task sender as a `receipt`
   * follow-up, when the sender still exists, is not Done, and its harness can
   * receive. Receipts never count toward the loop cap (route `receipt`).
   */
  private async sendReceipt(
    decided: TaskMessage,
    target: Task | undefined,
  ): Promise<void> {
    const { messages, harness } = this.requireMessaging();
    if (decided.sender.kind !== "task" || !harness.messaging.receive) return;
    const sender = await this.deps.tasks.getTask(decided.sender.taskId);
    if (!sender || sender.state === "done" || sender.state === "backlog")
      return;
    const outcome =
      decided.status === "rejected"
        ? "rejected"
        : decided.status === "failed"
          ? "failed"
          : "approved";
    await messages.recordMessage({
      id: this.deps.ids.next(),
      sender: { kind: "harbormaster" },
      senderLabel: "Harbormaster",
      targetTaskId: sender.id,
      route: "receipt",
      text: buildReceiptText({
        outcome,
        targetTitle: target?.title ?? decided.targetTaskId,
        text: decided.text,
        ...(decided.originalText !== undefined
          ? { originalText: decided.originalText }
          : {}),
        ...(decided.failureReason
          ? { failureReason: decided.failureReason }
          : {}),
      }),
      requestedMode: "followUp",
      attachments: [],
      status: "pending",
      regardingMessageId: decided.id,
      createdAt: this.deps.clock.now().toISOString(),
    });
  }

  private emitMessagesChanged(taskIds: Array<string | undefined>): void {
    this.deps.events.emit("messages-changed", {
      taskIds: [
        ...new Set(taskIds.filter((id): id is string => id !== undefined)),
      ],
    });
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

  // --- Rules engine + inbox (see manager/rules-runtime.ts) ----------------

  async listEvents(filter?: ListEventsFilter): Promise<AuditEntry[]> {
    return this.requireRules().listEvents(filter);
  }

  async rulesCheck(input?: RulesCheckInput): Promise<RulesCheckResult> {
    const [tasks, config] = await Promise.all([
      this.deps.tasks.listTasks(),
      this.deps.config.load(),
    ]);
    return this.requireRules().check(input ?? {}, tasks, config);
  }

  async listRules(): Promise<RulesListing> {
    return this.requireRules().listRules();
  }

  async listAddons(): Promise<AddonInfo[]> {
    return this.requireRules().listAddons();
  }

  async listInbox(options?: ListInboxOptions): Promise<InboxItem[]> {
    const now = this.deps.clock.now().toISOString();
    return (await this.requireInbox().list()).filter(
      (item) =>
        (options?.includeResolved || !item.resolvedAt) &&
        (options?.includeSnoozed ||
          !item.snoozedUntil ||
          item.snoozedUntil <= now),
    );
  }

  async resolveInboxItem(
    itemId: string,
    options?: ResolveInboxItemOptions,
  ): Promise<ResolveInboxItemResult> {
    const inbox = this.requireInbox();
    const existing = (await inbox.list()).find((item) => item.id === itemId);
    if (!existing) throw new Error(`Inbox item not found: ${itemId}`);
    if (existing.resolvedAt) return { item: existing };
    const button = options?.buttonId
      ? existing.buttons.find((candidate) => candidate.id === options.buttonId)
      : undefined;
    if (options?.buttonId && !button) {
      throw new Error(`Inbox item ${itemId} has no button ${options.buttonId}`);
    }
    const now = this.deps.clock.now();
    let taskId: string | undefined;
    if (button?.action === "snooze") {
      const until =
        typeof button.with?.until === "string"
          ? button.with.until
          : new Date(now.getTime() + 60 * 60_000).toISOString();
      const item = await inbox.update(itemId, (current) => ({
        ...current,
        snoozedUntil: until,
      }));
      this.deps.events.emit("inbox-changed", {});
      return { item: item ?? existing };
    }
    if (button?.action === "createTask") {
      const task = await this.createTaskFromAction(
        (button.with ?? {}) as unknown as CreateTaskActionInput,
      );
      taskId = task.id;
    } else if (button?.action === "openTask") {
      taskId =
        typeof button.with?.taskId === "string"
          ? button.with.taskId
          : existing.taskId;
    }
    const item = await inbox.update(itemId, (current) => ({
      ...current,
      resolvedAt: now.toISOString(),
      ...(button ? { resolvedBy: button.id } : {}),
    }));
    this.deps.events.emit("inbox-changed", {});
    return { item: item ?? existing, ...(taskId ? { taskId } : {}) };
  }

  /** Append an inbox item (rules' `inbox` action). */
  private async addInboxItem(
    fields: Omit<InboxItem, "id" | "createdAt">,
  ): Promise<InboxItem> {
    const item: InboxItem = {
      id: this.deps.ids.next(),
      ...fields,
      createdAt: this.deps.clock.now().toISOString(),
    };
    await this.requireInbox().add(item);
    this.deps.events.emit("inbox-changed", {});
    return item;
  }

  /**
   * The `createTask` rule action / inbox button: a PR URL (or number with
   * `repository`) makes a PR-bound task (`role: reviewer` checks out the
   * PR head and never pushes); otherwise a plain task in `repository`.
   */
  private async createTaskFromAction(
    input: CreateTaskActionInput,
  ): Promise<Task> {
    if (typeof input.title !== "string" || !input.title.trim()) {
      throw new Error("createTask needs a title");
    }
    const fromUrl =
      typeof input.pr === "string" ? parsePullRequestUrl(input.pr) : undefined;
    const pullRequest =
      fromUrl?.number ??
      (input.pr !== undefined && input.pr !== ""
        ? Number(input.pr)
        : undefined);
    if (pullRequest !== undefined && !Number.isInteger(pullRequest)) {
      throw new Error(
        `createTask: not a PR number or URL: ${String(input.pr)}`,
      );
    }
    const repositoryId = input.repository ?? fromUrl?.repositoryId;
    const role =
      input.role === "reviewer" || input.role === "author"
        ? input.role
        : undefined;
    return this.createTask({
      title: input.title.trim(),
      initialPrompt: typeof input.prompt === "string" ? input.prompt : "",
      ...(repositoryId ? { repositoryId } : {}),
      ...(pullRequest !== undefined ? { pullRequest } : {}),
      ...(role ? { role } : {}),
      start: input.start === true || String(input.start) === "true",
    });
  }

  private requireRules(): RulesRuntime {
    if (!this.rules) throw new Error("rules are not configured");
    return this.rules;
  }

  private requireInbox(): InboxAccess {
    if (!this.deps.inbox) throw new Error("inbox is not configured");
    return this.deps.inbox;
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
  role?: PullRequestRole,
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
    ...(role ? { role } : {}),
  };
}

/** The PR role GitHub's `viewerDidAuthor` implies, when it reported one. */
function roleFromViewer(
  viewerIsAuthor: boolean | undefined,
): PullRequestRole | undefined {
  if (viewerIsAuthor === undefined) return undefined;
  return viewerIsAuthor ? "author" : "reviewer";
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
    a.mergeCommit?.targetBranch === b.mergeCommit?.targetBranch &&
    a.role === b.role
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

/** Why a task can't receive messages (Done/Backlog), or `undefined` when it can. */
function undeliverableReason(task: Task): string | undefined {
  if (task.state === "done") {
    return `Task ${task.id} is Done; messages can't be delivered.`;
  }
  if (task.state === "backlog") {
    return `Task ${task.id} is in Backlog and has no session yet; messages can't be delivered.`;
  }
  return undefined;
}

/** Display snapshot of who sent a message. */
function senderLabelFor(sender: MessageSender, senderTask?: Task): string {
  if (sender.kind === "task") return senderTask?.title ?? sender.taskId;
  if (sender.kind === "session") return `Pi session in ${sender.cwd}`;
  if (sender.kind === "rule") return `Rule ${sender.ruleId}`;
  return "Harbormaster";
}

/** Task ids a message mutation touches (targets and task senders), for `messages-changed`. */
function affectedTaskIds(messages: readonly TaskMessage[]): string[] {
  return messages.flatMap((message) => [
    message.targetTaskId,
    ...(message.sender.kind === "task" ? [message.sender.taskId] : []),
  ]);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toKnownLocation(path: string, repo?: RepositoryInfo): KnownLocation {
  return {
    path,
    name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
    ...(repo ? { repositoryId: repo.id } : {}),
  };
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
