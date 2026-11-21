// Manager: orchestrates the task-board workflow (sequence of use cases),
// delegating storage to Resource Access and board-move rules to the
// transition Engine. This is the one and only implementation of
// `CoreCommands`; frontends never see anything beneath this layer.

import type {
  AwaitingKindOption,
  CoreCommands,
  CreateTaskInput,
  DeleteTaskOptions,
  HarnessTurnUsage,
  HookPresenceReport,
  KnownLocation,
  LaunchSettings,
  LaunchTaskInput,
  ListSlashCommandsInput,
  MoveTaskOptions,
  OrphanWorktreeReport,
  PresenceReport,
  RecordTaskSessionInput,
  RefreshOptions,
  RefreshResult,
  ReopenTaskInput,
  RequestReviewResult,
  ToAwaitOptions,
  ToDoneConfirmation,
  ToDoneOptions,
  ToDoneResult,
  TurnBoundaryReport,
  UpdateTaskInput,
} from "../contracts/commands.js";
import type {
  DoctorInput,
  DoctorReport,
  EnvironmentProbeAccess,
} from "../contracts/doctor.js";
import type {
  PullRequestAccess,
  PullRequestPreview,
  PullRequestStatus,
  VersionAccess,
} from "../contracts/github.js";
import type {
  HarnessAdapter,
  HarnessDeliverCommand,
  HarnessDescriptorInfo,
  HarnessModelCatalog,
  PresenceStatus,
  ProgramStatusReading,
  ReviewTarget,
  SessionLaunch,
  SlashCommandCatalog,
} from "../contracts/harness.js";
import type {
  InboxAccess,
  InboxItem,
  InboxPriorityInput,
  ListInboxOptions,
  ReadyToLandEntry,
  ResolveInboxItemOptions,
  ResolveInboxItemResult,
} from "../contracts/inbox.js";
import type { CoreLogger, CoreOperation } from "../contracts/logger.js";
import { noopCoreLogger } from "../contracts/logger.js";
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
  CustomAgentConfig,
  DeploymentStageConfig,
  GlobalConfig,
  PullRequestRole,
  ReviewSupport,
  Task,
  TaskCleanup,
  TaskLaunch,
  TaskPullRequest,
  TaskState,
  TaskWorkspace,
  ThinkingLevel,
  WorkspaceBinding,
  WorktreeStatus,
} from "../contracts/model.js";
import {
  DEFAULT_HARNESS_ID,
  DEFAULT_LAUNCH_BYPASS_PERMISSIONS,
  DEFAULT_LAUNCH_MAX_CONCURRENT,
  DEFAULT_MESSAGE_LOOP_CAP,
  DEFAULT_PARENT_REPLY_TIMEOUT_MINUTES,
  TASK_STATES,
} from "../contracts/model.js";
import type {
  CodeRootScan,
  DetectedAgent,
  GithubAuthStatus,
  OnboardingProbeAccess,
  OnboardingState,
  ProbeOutcome,
  SetDefaultAgentInput,
} from "../contracts/onboarding.js";
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
  ConfigSettingsPatch,
  FolderAccess,
  IdGenerator,
  LaunchFilesAccess,
  MessageAccess,
  PresenceAccess,
  ReviewSupportProbeAccess,
  ScratchWorkspaceAccess,
  SessionFileAccess,
  TaskAttachmentAccess,
  TaskStateAccess,
  WorkspaceBindingAccess,
} from "../contracts/services.js";
import type {
  SettingsHarnessOption,
  SettingsPatch,
  SettingsSnapshot,
} from "../contracts/settings.js";
import type {
  TaskUsage,
  TaskUsageQuery,
  TaskUsageRow,
} from "../contracts/usage.js";
import type {
  GitRepositoryAccess,
  GitWorktreeAccess,
  RepositoryInfo,
  WorktreeInfo,
} from "../contracts/workspace.js";
import { detectedAgent } from "../engines/agent-version.js";
import {
  builtinAwaitingKinds,
  describeAwaitingKind,
  findAwaitingKind,
  normalizeAwaitingInputs,
} from "../engines/awaiting-kinds.js";
import { groupColumnTasks } from "../engines/board-grouping.js";
import { branchToAdopt } from "../engines/branch-adoption.js";
import {
  classifyWorktreeRemovalError,
  type DoneConfirmationFacts,
  doneConfirmationLines,
  findOrphanDirs,
  isForcedCleanupDue,
  isReviewCheckoutOf,
  nextCleanupAttemptAt,
  orphanWorktreeWarning,
  shouldArchive,
  shouldDeleteBranch,
} from "../engines/cleanup.js";
import {
  isConnectivityError,
  isTransientError,
} from "../engines/connectivity.js";
import { applyInboxPriorityFilter } from "../engines/inbox-priority.js";
import { buildLaunchKickoffPrompt } from "../engines/launch-kickoff.js";
import {
  buildReceiptText,
  classifyRoute,
  countLoopMessages,
  defaultMode,
  deriveAgentActivity,
  deriveMessagingStates,
  deriveRunState,
  matchTasks,
  resolveDeliveredMode,
  selectMessagesToPrune,
} from "../engines/messaging.js";
import {
  codeRootCandidates,
  customAgentProblems,
  expandHome,
  fallbackCodeRoot,
  parseGhAuthStatus,
  protectedHomeFolder,
  toScannedRepositories,
} from "../engines/onboarding.js";
import { parsePullRequestUrl } from "../engines/pull-request-url.js";
import {
  claudePluginVersion,
  loopbackUrl,
  parseSemver,
  piExtensionVersion,
  type ReviewVersions,
  reviewSupportFor,
} from "../engines/review-support.js";
import type { ResolvedMove } from "../engines/rules/evaluation.js";
import { effectivePipeline } from "../engines/rules/views.js";
import { shouldWatchSessionFile } from "../engines/session-file-check.js";
import { builtinSources } from "../engines/sources/index.js";
import {
  assertAllowedTransition,
  assertMayReturnToWorking,
} from "../engines/task-transitions.js";
import { deriveTaskBranch } from "../engines/task-workspace.js";
import { awaitsUsageBackfill, buildTaskUsageRows } from "../engines/usage.js";
import { collectWorktreeStatus } from "../engines/worktree-status.js";
import { harnessDescriptorInfo } from "../harness/descriptor.js";
import {
  hookPresenceBoundary,
  hookPresenceReading,
} from "../harness/hook-presence.js";
import { applyProgramStatus } from "../harness/presence-heuristics.js";
import {
  type HarnessRegistry,
  resolveLaunchBypass,
  resolveNewTaskHarness,
} from "../harness/registry.js";
import {
  readingUnderTurnBoundary,
  type TurnTracking,
  trackBoundary,
  trackReport,
} from "../harness/turn-boundary.js";
import { forEachConcurrently } from "../utilities/concurrency.js";
import type { CoreEventBus } from "../utilities/event-bus.js";
import { normalizeRemoteIdentity } from "../utilities/remote-identity.js";
import { elapsedMs, logErrorMessage, timed } from "../utilities/timed.js";
import { probeAgentCommand } from "./agent-probe.js";
import { DoctorRuntime } from "./doctor-runtime.js";
import {
  type ActionResult,
  type RuleActionExecutor,
  RulesRuntime,
} from "./rules-runtime.js";
import { SessionFileWatch } from "./session-file-watch.js";
import {
  SettingsRuntime,
  type SettingsSourceListing,
} from "./settings-runtime.js";
import { UsageRuntime } from "./usage-runtime.js";

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
  /** Prompt files and plugin dirs launches leave for the agent; removed on Done and delete (`createCore` supplies it). */
  launchFiles?: LaunchFilesAccess;
  pullRequests: PullRequestAccess;
  versions: VersionAccess;
  /**
   * Task-messaging storage (log, doorbell, attachment copies). Optional so
   * hand-built managers that never message keep compiling; every messaging
   * command throws "messaging is not configured" without it (`createCore`
   * always supplies it).
   */
  messages?: MessageAccess;
  /**
   * The presence adapter (presence is the same for every agent: OSC 7501
   * reports + pid liveness) and the fallback for a task whose agent is not
   * in `harnesses`. Required alongside `messages`.
   */
  harness?: HarnessAdapter;
  /**
   * Every agent a task can run on (decision R8), for per-task messaging
   * capabilities, model catalogs and defaults. Absent = `harness` alone.
   */
  harnesses?: HarnessRegistry;
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
  /** The first-run wizard's machine probes; onboarding commands throw "onboarding is not configured" without it. */
  onboarding?: OnboardingProbeAccess;
  /** Operation log (`[core:<scope>]` lines); silent without it. */
  logger?: CoreLogger;
  /** `doctor`'s read-only machine probes; `doctor` throws "doctor is not configured" without it. */
  environment?: EnvironmentProbeAccess;
  /** Plannotator version probes; `reviewSupport` throws "review support is not configured" without it. */
  reviewProbes?: ReviewSupportProbeAccess;
  /** The host's open-url handler path (`createCore({ openUrlHandler })`), handed out by `getLaunchSettings`. */
  openUrlHandler?: string;
}

/** Where a new task runs, resolved from a create/launch input. */
type TaskWhere =
  | { kind: "repository"; repo: RepositoryInfo }
  | { kind: "folder"; path: string }
  | { kind: "none" };

/** Agent fields stored on a new task (see `/docs/new-task-composer.md`). */
function agentFields(
  input: {
    model?: string;
    thinking?: ThinkingLevel;
  },
  harness: string,
): Pick<Task, "harness" | "model" | "thinking"> {
  const model = input.model?.trim();
  return {
    harness,
    ...(model ? { model } : {}),
    ...(input.thinking ? { thinking: input.thinking } : {}),
  };
}

const COLUMN_TITLES: Record<TaskState, string> = {
  backlog: "Backlog",
  working: "Working",
  awaiting: "Awaiting",
  done: "Done",
};

/** How long registered folders' repository lookups are reused. */
const LOCATION_CACHE_TTL_MS = 30_000;

/**
 * Consecutive transient failures (timeout, GitHub 5xx) of one repository's
 * batched PR lookup before it becomes a warning. Earlier ones are only
 * logged: the next tick is the retry and tasks keep their last PR data. At
 * the ~30s cadence, 3 means ~1.5 minutes of failing.
 */
const TRANSIENT_PR_FAILURES_BEFORE_WARNING = 3;

/** PR observations in flight at once during `refresh()` (pi-home parity). */
const REFRESH_CONCURRENCY = 4;

/**
 * A refresh tick's batched PR answer for one task: its status (possibly
 * none), or `batchFailed` when its repository's batch failed (that failure
 * is reported once for the batch, not per task).
 */
type PrefetchedPullRequest =
  | { status: PullRequestStatus | undefined }
  | { batchFailed: true };

export class CoreManager implements CoreCommands {
  /** The running `refresh()`, joined by any call made while it runs. */
  private refreshInFlight: Promise<RefreshResult> | undefined;
  /** Consecutive transient batched-PR-lookup failures per repository id (reset on any other outcome). */
  private readonly transientPrFailures = new Map<string, number>();
  /** Last reported done-cleanup retry failure per task (dedupe). */
  private readonly cleanupWarnings = new Map<string, string>();
  /** Tasks whose forced Done cleanup is running right now (toDone vs the sweep vs Retry). */
  private readonly cleanupsInFlight = new Set<string>();
  /** Registered folders resolved to repositories (see `locationEntries`). */
  private locationCache:
    | { at: number; entries: Array<{ path: string; repo?: RepositoryInfo }> }
    | undefined;

  /** The rules engine's tick/check/list workflow (see manager/rules-runtime.ts). */
  private readonly rules: RulesRuntime | undefined;
  /** Operation log (see contracts/logger.ts). */
  private readonly log: CoreLogger;
  /** `new` session launches waiting for their session file (see session-file-watch.ts). */
  private readonly sessionFiles: SessionFileWatch;
  /** Per-task token usage (see usage-runtime.ts, docs/costs.md). */
  private readonly usage: UsageRuntime;
  /** Settings reads/writes and config change reactions (see settings-runtime.ts). */
  private readonly settings: SettingsRuntime;
  /** Tasks the running refresh observes (for its completion line). */
  private refreshTaskCount = 0;
  /** Last logged safe-Done cleanup refusal per task (log dedupe). */
  private readonly doneCleanupFailures = new Map<string, string>();
  /** Per task: the last 7501 reading and the last hook turn boundary (S5, `reportTurnBoundary`). */
  private readonly turnTracking = new Map<string, TurnTracking>();
  /**
   * The last refresh pass's worktree state per Working task (see
   * engines/worktree-status.ts): read by the rules' `worktree.dirty` fact
   * and `listWorktreeStatus`, so neither runs git per caller.
   */
  private worktreeStatus = new Map<string, WorktreeStatus>();
  /** Working tasks whose worktree git could not answer for in the last pass (and had no previous value). */
  private worktreeStatusUnreadable = new Set<string>();
  /** `reviewSupport`'s probed versions, reused for `REVIEW_SUPPORT_CACHE_MS`. */
  private reviewVersions:
    | { at: number; checkedAt: string; versions: Promise<ReviewVersions> }
    | undefined;

  constructor(private readonly deps: CoreManagerDependencies) {
    this.log = deps.logger ?? noopCoreLogger;
    this.sessionFiles = new SessionFileWatch({
      sessions: deps.sessions,
      logger: this.log,
      nowMs: () => deps.clock.now().getTime(),
    });
    this.usage = new UsageRuntime({
      tasks: deps.tasks,
      sessions: deps.sessions,
      clock: deps.clock,
      logger: this.log,
      adapterFor: (task) => this.usageAdapterFor(task),
      bindingFor: (taskId) => deps.bindings.getBindingForTask(taskId),
      publish: (task) => this.publishTaskChange(task),
    });
    this.settings = new SettingsRuntime({
      config: deps.config,
      events: deps.events,
      logger: this.log,
      harnesses: (config) => this.harnessOptions(config),
      rediscover: (config) => this.allRepositories(config),
      sources: () => this.settingsSources(),
      ...(deps.onboarding ? { folders: deps.onboarding } : {}),
    });
    this.rules = deps.rules
      ? new RulesRuntime({
          rules: deps.rules.files,
          state: deps.rules.state,
          audit: deps.rules.audit,
          ...(deps.rules.addons ? { addons: deps.rules.addons } : {}),
          config: deps.config,
          now: () => deps.clock.now(),
          logger: this.log,
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
            tasks: {
              agent: (taskId) => this.agentActivity(taskId),
              worktreeDirty: async (taskId) => this.worktreeDirtyFact(taskId),
            },
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
    if (!this.deps.harness && !this.deps.harnesses) return [];
    const config = await this.deps.config.load();
    const adapters = this.harnessList(config);
    const defaultHarness = config.launch?.defaultHarness ?? DEFAULT_HARNESS_ID;
    const catalogs = await Promise.all(
      adapters.map((adapter) => adapter.listModels()),
    );
    // The configured default model wins over the default agent's own,
    // exactly as `claimSessionLaunch` resolves it; it never applies to the
    // other agents (a Pi `provider/model` id means nothing to Claude).
    return catalogs.map((catalog) => {
      const defaultModel =
        (catalog.harness === defaultHarness
          ? config.launch?.defaultModel
          : undefined) ?? catalog.defaultModel;
      return { ...catalog, ...(defaultModel ? { defaultModel } : {}) };
    });
  }

  async listSlashCommands(
    input: ListSlashCommandsInput,
  ): Promise<SlashCommandCatalog> {
    const config = await this.deps.config.load();
    const harness = input.harness || config.launch?.defaultHarness;
    const adapter = await this.harnessFor(
      harness ? { harness } : undefined,
      config,
    );
    const empty = { harness: adapter.id, label: adapter.label, commands: [] };
    if (!adapter.listSlashCommands) return empty;
    // The workspace a task there would run in: a repository's primary
    // checkout (its worktree is cut from it), or the folder itself.
    let cwd: string | undefined;
    if (input.repositoryId) {
      cwd = (
        await this.findRepository(input.repositoryId, config).catch(
          () => undefined,
        )
      )?.root;
    } else if (input.folderPath) {
      cwd = input.folderPath;
    }
    try {
      return { ...empty, commands: await adapter.listSlashCommands(cwd) };
    } catch (error) {
      return {
        ...empty,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Every registered agent (built-ins, then the config's custom agents). */
  private harnessList(config: GlobalConfig): HarnessAdapter[] {
    if (this.deps.harnesses) {
      return this.deps.harnesses.list(config.agents?.custom ?? []);
    }
    return this.deps.harness ? [this.deps.harness] : [];
  }

  /** The built-in agents (registration order), without the config's custom ones. */
  private builtinHarnesses(): HarnessAdapter[] {
    if (this.deps.harnesses) return this.deps.harnesses.list();
    return this.deps.harness ? [this.deps.harness] : [];
  }

  async listHarnessDescriptors(): Promise<HarnessDescriptorInfo[]> {
    const config = await this.deps.config.load();
    const builtin = new Set(
      this.builtinHarnesses().map((adapter) => adapter.id),
    );
    return this.harnessList(config).map((adapter) =>
      harnessDescriptorInfo(adapter, builtin.has(adapter.id)),
    );
  }

  /** The adapter a task runs on (its `harness`, else Pi, else the presence adapter). */
  private async harnessFor(
    task: Pick<Task, "harness"> | undefined,
    config?: GlobalConfig,
  ): Promise<HarnessAdapter> {
    const fallback = this.deps.harness;
    if (!this.deps.harnesses) {
      if (!fallback) throw new Error("no agent harness is configured");
      return fallback;
    }
    const custom = (config ?? (await this.deps.config.load())).agents?.custom;
    return this.deps.harnesses.resolve(task?.harness, custom ?? []);
  }

  /**
   * The agent a new task runs on (decision R8), validated: an explicitly
   * requested agent must be registered.
   */
  private resolveTaskHarness(
    requested: string | undefined,
    parent: Task | undefined,
    repositoryId: string | undefined,
    config: GlobalConfig,
  ): string {
    const id = resolveNewTaskHarness({
      requested,
      parentHarness: parent?.harness,
      repository: repositoryId
        ? config.repositories?.[repositoryId]
        : undefined,
      config,
    });
    const known = this.harnessList(config).some((adapter) => adapter.id === id);
    if (!known && id !== DEFAULT_HARNESS_ID && this.deps.harnesses) {
      throw new Error(
        `Unknown agent "${id}". Available: ${this.harnessList(config)
          .map((adapter) => adapter.id)
          .join(", ")}`,
      );
    }
    return id;
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
      // Any checkout we already know with this remote (under the code root
      // or a registered folder) wins over a second clone.
      const wanted = normalizeRemoteIdentity(where.cloneUrl);
      const known = (await this.allRepositories(config)).find(
        (repo) => repo.id === wanted,
      );
      if (known) return { kind: "repository", repo: known };
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

  async getTaskWorkspace(taskId: string): Promise<TaskWorkspace | undefined> {
    const binding = await this.deps.bindings.getBindingForTask(taskId);
    if (!binding?.worktreePath || binding.scratch) return binding;
    const dirty = await this.deps.worktrees
      .isWorktreeDirty(binding.worktreePath)
      .catch(() => undefined);
    return dirty === undefined ? binding : { ...binding, dirty };
  }

  /** The rules' `agent` fact: what the task's agent is doing (throws when presence is unreadable). */
  private async agentActivity(taskId: string): Promise<string> {
    const { harness } = this.deps;
    if (!harness) throw new Error("presence is not configured");
    return deriveAgentActivity(await harness.presence(taskId));
  }

  /**
   * The rules' `worktree.dirty` fact, from this tick's worktree pass (no
   * git here): `undefined` without a git worktree; throws when git could
   * not answer (the source keeps the last value).
   */
  private worktreeDirtyFact(taskId: string): boolean | undefined {
    const status = this.worktreeStatus.get(taskId);
    if (status) return status.dirty;
    if (this.worktreeStatusUnreadable.has(taskId)) {
      throw new Error("git status did not answer this tick");
    }
    return undefined;
  }

  async listWorktreeStatus(): Promise<Record<string, WorktreeStatus>> {
    return Object.fromEntries(this.worktreeStatus);
  }

  /**
   * One bounded `git status` pass over every Working task with a git
   * worktree (see engines/worktree-status.ts), replacing the stored state.
   */
  private async refreshWorktreeStatus(
    tasks: readonly Task[],
    bindingFor: (taskId: string) => Promise<WorkspaceBinding | undefined>,
  ): Promise<void> {
    const targets: Array<{ taskId: string; path: string }> = [];
    for (const task of tasks) {
      if (task.archivedAt || task.state !== "working") continue;
      const binding = await bindingFor(task.id);
      if (!binding?.worktreePath || binding.scratch) continue;
      targets.push({ taskId: task.id, path: binding.worktreePath });
    }
    const pass = await collectWorktreeStatus({
      targets,
      previous: this.worktreeStatus,
      isDirty: (path, timeoutMs) =>
        this.deps.worktrees.isWorktreeDirty(path, { timeoutMs }),
      now: () => this.deps.clock.now(),
    });
    this.worktreeStatus = pass.statuses;
    this.worktreeStatusUnreadable = pass.unreadable;
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
      const bound = await this.resolvePullRequestTask(
        repo,
        input.pullRequest,
        input.role,
      );
      branch = bound.branch;
      pr = bound.pr;
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
      state: startNow ? "working" : "backlog",
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
      ...agentFields(
        input,
        this.resolveTaskHarness(input.harness, parent, repo?.id, config),
      ),
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
        pr?.role,
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

  /**
   * A PR-bound task's branch (the PR head) and PR snapshot; the role
   * defaults from GitHub (`viewerIsAuthor`), else `author`.
   */
  private async resolvePullRequestTask(
    repo: RepositoryInfo | undefined,
    pullRequest: number,
    role: PullRequestRole | undefined,
  ): Promise<{ branch: string; pr: TaskPullRequest }> {
    if (!repo) {
      throw new Error("A pull-request task needs a repository");
    }
    if (!this.deps.pullRequests.view) {
      throw new Error("Pull-request tasks need GitHub access");
    }
    const status = await this.deps.pullRequests.view(repo.id, pullRequest);
    if (!status.headRefName) {
      throw new Error(`Pull request #${pullRequest} has no head branch`);
    }
    return {
      branch: status.headRefName,
      pr: toTaskPullRequest(
        status,
        repo.defaultBranch,
        role ?? roleFromViewer(status.viewerIsAuthor) ?? "author",
      ),
    };
  }

  async startTask(taskId: string): Promise<Task> {
    const task = await this.requireTask(taskId);
    if (task.state !== "backlog") {
      throw new Error(
        `Only a backlog task can be started (task is in "${task.state}")`,
      );
    }
    const binding = await this.deps.bindings.getBindingForTask(taskId);
    if (binding?.worktreePath) return this.moveTask(taskId, "working");
    if (task.folderPath) {
      const now = this.deps.clock.now().toISOString();
      await this.provisionInPlaceWorkspace(taskId, task.folderPath, now, {
        persist: async () => {},
        undo: async () => {},
      });
      return this.moveTask(taskId, "working");
    }
    if (!task.repositoryId) {
      // Parked scratch task: give it its scratch directory now, exactly
      // like a repository-backed task gets its worktree on start.
      const now = this.deps.clock.now().toISOString();
      await this.provisionScratchWorkspace(taskId, now, {
        persist: async () => {},
        undo: async () => {},
      });
      return this.moveTask(taskId, "working");
    }

    const config = await this.deps.config.load();
    const repo = await this.findRepository(task.repositoryId, config);
    const branch =
      task.branch ??
      deriveTaskBranch(task.title, task.id, config.branchPrefix ?? "");
    const now = this.deps.clock.now().toISOString();
    const next: Task = {
      ...task,
      state: "working",
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
  private provisionInPlaceWorkspace(
    taskId: string,
    folderPath: string,
    now: string,
    task: { persist: () => Promise<void>; undo: () => Promise<void> },
  ): Promise<void> {
    return timed(
      this.log,
      "worktree",
      "task.provision-in-place",
      { taskId, worktreePath: folderPath },
      () => this.provisionInPlaceWorkspaceSteps(taskId, folderPath, now, task),
    );
  }

  private async provisionInPlaceWorkspaceSteps(
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
  private provisionTaskWorkspace(
    ...args: Parameters<CoreManager["provisionTaskWorkspaceSteps"]>
  ): Promise<void> {
    const [repo, taskId, branch] = args;
    return timed(
      this.log,
      "worktree",
      "task.provision-worktree",
      { taskId, repositoryId: repo.id, branch },
      () => this.provisionTaskWorkspaceSteps(...args),
    );
  }

  private async provisionTaskWorkspaceSteps(
    repo: RepositoryInfo,
    taskId: string,
    branch: string,
    now: string,
    task: { persist: () => Promise<void>; undo: () => Promise<void> },
    /** Branch the worktree off this ref instead of the repository's default branch (`launchTask`'s `baseBranch: "parent"`). */
    baseRef: string = repo.defaultBranch,
    /** Check out this pull request's head as `branch` instead (PR-bound tasks). */
    pullRequestNumber?: number,
    /** A reviewer's PR checkout: the head on a detached HEAD, the branch untouched (`checkoutPullRequest`'s `detached`). */
    pullRequestRole?: PullRequestRole,
  ): Promise<void> {
    // Branch collision, dirty baseRef, missing repo, ... — createTaskWorktree
    // itself guarantees no leftover directory/bookkeeping on failure, so
    // there is nothing to clean up on this path beyond rethrowing.
    let worktree: WorktreeInfo;
    let createdBranch = true;
    let detached = false;
    if (pullRequestNumber !== undefined) {
      if (!this.deps.worktrees.checkoutPullRequest) {
        throw new Error("Pull-request checkouts are not supported here");
      }
      const checkout = await this.deps.worktrees.checkoutPullRequest(
        repo,
        branch,
        pullRequestNumber,
        pullRequestRole === "reviewer" ? { detached: true } : {},
      );
      worktree = checkout.worktree;
      createdBranch = checkout.createdBranch;
      detached = checkout.detached === true;
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
      // A detached reviewer checkout never owns `branch`: Done and delete
      // must not delete it (someone else's branch, maybe checked out).
      detached,
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
  private provisionScratchWorkspace(
    taskId: string,
    now: string,
    task: { persist: () => Promise<void>; undo: () => Promise<void> },
  ): Promise<void> {
    return timed(
      this.log,
      "worktree",
      "task.provision-scratch",
      { taskId },
      () => this.provisionScratchWorkspaceSteps(taskId, now, task),
    );
  }

  private async provisionScratchWorkspaceSteps(
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

  async releaseInitialPrompt(taskId: string): Promise<boolean> {
    const task = await this.deps.tasks.getTask(taskId);
    if (!task?.initialPromptDeliveredAt || !task.initialPrompt.trim()) {
      return false;
    }
    const binding = await this.deps.bindings.getBindingForTask(taskId);
    if (!binding?.worktreePath || binding.sessionPath) return false;
    if (
      binding.sessionId &&
      (await this.sessionFileWritten(
        task,
        binding.worktreePath,
        binding.sessionId,
      ))
    ) {
      return false;
    }
    const now = this.deps.clock.now().toISOString();
    const released = await this.deps.tasks.patchTask(taskId, (fresh) => {
      if (!fresh.initialPromptDeliveredAt) return undefined;
      const { initialPromptDeliveredAt: _lost, ...rest } = fresh;
      return { ...rest, updatedAt: now };
    });
    if (!released) return false;
    // The unused id goes too: the next launch is a first launch again (a
    // fresh id, the task's model, the prompt).
    const { sessionId: _unused, ...rest } = binding;
    await this.deps.bindings.replaceBinding({ ...rest, updatedAt: now });
    this.log.warn(
      "session",
      `initial prompt never reached task ${taskId}'s session; the next launch delivers it again`,
      {
        taskId,
        ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
        outcome: "missing",
      },
    );
    return true;
  }

  /** Whether the harness already wrote `sessionId`'s file (`false` when it can't tell). */
  private async sessionFileWritten(
    task: Task,
    worktreePath: string,
    sessionId: string,
  ): Promise<boolean> {
    const sessions = this.deps.sessions;
    if (!sessions.findSessionFile) return false;
    if (!this.deps.harness && !this.deps.harnesses) return false;
    try {
      const expected = (await this.harnessFor(task)).expectedSessionFile?.(
        worktreePath,
        sessionId,
      );
      if (!expected) return false;
      return Boolean(
        await sessions.findSessionFile(expected.dir, expected.fileSuffix),
      );
    } catch {
      return false;
    }
  }

  async claimSessionLaunch(taskId: string): Promise<SessionLaunch | undefined> {
    const launch = await this.decideSessionLaunch(taskId);
    await this.logSessionLaunch(taskId, launch);
    return launch;
  }

  /**
   * `[core:session]` line for a launch decision; a prompted `new` launch
   * also names the file the harness should create and arms the follow-up
   * check (`checkPendingSessionFiles`). Never throws.
   */
  private async logSessionLaunch(
    taskId: string,
    launch: SessionLaunch | undefined,
  ): Promise<void> {
    if (!launch) return;
    try {
      const task = await this.deps.tasks.getTask(taskId);
      let expected: { dir: string; fileSuffix: string } | undefined;
      if (
        task &&
        shouldWatchSessionFile(launch, Boolean(task.initialPrompt.trim()))
      ) {
        const binding = await this.deps.bindings.getBindingForTask(taskId);
        const adapter =
          this.deps.harness || this.deps.harnesses
            ? await this.harnessFor(task, await this.deps.config.load())
            : undefined;
        expected =
          binding?.worktreePath && adapter?.expectedSessionFile
            ? adapter.expectedSessionFile(
                binding.worktreePath,
                launch.sessionId,
              )
            : undefined;
        if (expected) {
          this.sessionFiles.arm({
            taskId,
            sessionId: launch.sessionId,
            dir: expected.dir,
            fileSuffix: expected.fileSuffix,
          });
        }
      }
      this.log.info("session", `launch ${launch.mode} for task ${taskId}`, {
        taskId,
        mode: launch.mode,
        ...("sessionId" in launch ? { sessionId: launch.sessionId } : {}),
        ...("sessionPath" in launch ? { sessionFile: launch.sessionPath } : {}),
        ...(expected ? { sessionDir: expected.dir } : {}),
      });
    } catch {
      // Logging only: a lookup failure never fails the launch.
    }
  }

  async checkPendingSessionFiles(): Promise<number> {
    return this.sessionFiles.check();
  }

  async harnessDeliverCommand(
    taskId: string,
    kind: "followUp" | "wakeIdle",
    text: string,
  ): Promise<HarnessDeliverCommand | undefined> {
    const task = await this.deps.tasks.getTask(taskId);
    if (!task || (!this.deps.harness && !this.deps.harnesses)) return undefined;
    const adapter = await this.harnessFor(task);
    if (!adapter.deliverCommand) return undefined;
    const binding = await this.deps.bindings.getBindingForTask(taskId);
    // A learned id is only real once the harness reported its file.
    if (!binding?.sessionId || !binding.sessionPath) return undefined;
    return adapter.deliverCommand(kind, binding.sessionId, text);
  }

  private async decideSessionLaunch(
    taskId: string,
  ): Promise<SessionLaunch | undefined> {
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

    // A harness that picks its own session ids (Codex: `sessionId:
    // "learned"`) reports them from its session-start hook
    // (`recordTaskSession`, which always records id + file). Until then the
    // binding holds no id: a pre-assigned one would be resumed by a harness
    // that never heard of it. An id without a recorded file is such a
    // placeholder (a reopen pre-assigns one) and is ignored.
    const learned = await this.harnessLearnsSessionIds(task);
    const boundSessionId =
      learned && !binding.sessionPath ? undefined : binding.sessionId;

    // First launch after `reopenTask`: hand the pending fork out exactly
    // once, so later launches resume the forked session instead of forking
    // the previous cycle again.
    if (binding.forkFromSessionPath) {
      const forkFrom = binding.forkFromSessionPath;
      const sessionId = boundSessionId ?? this.deps.ids.next();
      const {
        forkFromSessionPath: _consumed,
        sessionId: _placeholder,
        ...rest
      } = binding;
      await this.deps.bindings.replaceBinding({
        ...rest,
        ...(learned ? {} : { sessionId }),
        updatedAt: now,
      });
      return (await this.deps.sessions.exists(forkFrom))
        ? { mode: "fork", sessionId, forkFrom }
        : { mode: "new", sessionId };
    }

    if (boundSessionId) {
      const sessionPath =
        binding.sessionPath &&
        (await this.deps.sessions.exists(binding.sessionPath))
          ? binding.sessionPath
          : undefined;
      return {
        mode: "resume",
        sessionId: boundSessionId,
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
    // a later resume would open it under an id it does not carry. A
    // harness that learns its ids gets none persisted (see above); the id
    // handed out is only a placeholder for the launch decision.
    const { sessionPath: _gone, sessionId: _placeholder, ...fresh } = binding;
    const sessionId = this.deps.ids.next();
    await this.deps.bindings.replaceBinding({
      ...fresh,
      ...(learned ? {} : { sessionId }),
      updatedAt: now,
    });
    // First-ever launch: pass the task's model/thinking through to the
    // harness (the task's choice, else the configured default model), never
    // on a later resume/fork/continue. `launch.model` is where launched
    // tasks recorded their model before tasks carried one.
    let model = task.model ?? task.launch?.model;
    if (!model) {
      const config = await this.deps.config.load();
      // The configured default model belongs to the default agent only.
      if (
        (task.harness ?? DEFAULT_HARNESS_ID) ===
        (config.launch?.defaultHarness ?? DEFAULT_HARNESS_ID)
      ) {
        model = config.launch?.defaultModel;
      }
      // Record what "default" meant for this session, for display; the
      // harness's own default is only recorded, never passed.
      const adapter =
        this.deps.harness || this.deps.harnesses
          ? await this.harnessFor(task, config)
          : undefined;
      const sessionModel = model ?? (await adapter?.defaults())?.defaultModel;
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

  /** Whether the task's harness reports its own session ids (`capabilities.sessionId === "learned"`). */
  private async harnessLearnsSessionIds(task: Task): Promise<boolean> {
    if (!this.deps.harness && !this.deps.harnesses) return false;
    try {
      return (
        (await this.harnessFor(task)).capabilities?.sessionId === "learned"
      );
    } catch {
      return false;
    }
  }

  async recordTaskSession(
    taskId: string,
    input: RecordTaskSessionInput,
  ): Promise<boolean> {
    const recorded = await this.bindReportedSession(taskId, input);
    if (input.sessionId && input.sessionPath) {
      this.sessionFiles.reported(taskId, input.sessionId, input.sessionPath);
    }
    this.log.info(
      "session",
      `${recorded ? "recorded" : "ignored"} session report for task ${taskId}`,
      {
        taskId,
        sessionId: input.sessionId,
        sessionFile: input.sessionPath,
        outcome: recorded ? "recorded" : "ignored",
      },
    );
    // Usage snapshot (docs/costs.md): usually `pending` this early, the
    // agent-finished / Done triggers fill it in.
    if (recorded) await this.usage.update(taskId);
    return recorded;
  }

  private async bindReportedSession(
    taskId: string,
    input: RecordTaskSessionInput,
  ): Promise<boolean> {
    if (!input.sessionId || !input.sessionPath) return false;
    const binding = await this.deps.bindings.getBindingForTask(taskId);
    if (!binding) return false;
    // A learned-id harness's binding id without a recorded file is a
    // placeholder (see decideSessionLaunch): the first report binds.
    const task = await this.deps.tasks.getTask(taskId);
    const placeholder =
      !!binding.sessionId &&
      !binding.sessionPath &&
      !!task &&
      (await this.harnessLearnsSessionIds(task));
    if (binding.sessionId && !placeholder) {
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
      state: "working",
      updatedAt: now,
      stateChangedAt: now,
    };
    delete reopened.completedAt;
    delete reopened.archivedAt;
    delete reopened.cleanup;
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
      assertMayReturnToWorking(task.state, task.awaiting, state);
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
        // Back in play: the app-owned Done cleanup stops (a pending retry
        // must never remove the worktree a reopened cycle runs in).
        delete moved.cleanup;
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
        if (task.branch && !binding.detached) {
          await this.deleteMergedBranch(repo, task.branch, task.pr);
        }
      }
    }
    await this.deps.bindings.removeBinding(id).catch(() => {});
    await this.deps.tasks.removeTask(id);
    await this.removeLaunchFiles(id);
    await this.publishBoard();
  }

  scanOrphanWorktrees(): Promise<OrphanWorktreeReport> {
    return timed(
      this.log,
      "orphans",
      "orphans.scan",
      {},
      () => this.findOrphanWorktrees(),
      (report) => ({
        count: report.orphans.length,
        bytes: report.orphans.reduce(
          (sum, orphan) => sum + (orphan.sizeBytes ?? 0),
          0,
        ),
      }),
    );
  }

  private async findOrphanWorktrees(): Promise<OrphanWorktreeReport> {
    const config = await this.deps.config.load();
    // Legacy (pre-0.1.2) worktrees sit in `.harbormaster-worktrees` next to
    // a checkout: under the code root, or next to any known repository.
    const repositories = await this.allRepositories(config).catch(() => []);
    const roots = await this.deps.worktrees.listTaskWorktreeDirs({
      ...(config.codeRoot ? { codeRoot: config.codeRoot } : {}),
      checkoutRoots: repositories.map((repo) => repo.root),
    });
    // Parked bindings carry no worktreePath, so a Done task's leftover
    // directory counts as an orphan too (its cleanup failed or never ran).
    // Canonicalized like the scanned dirs: a binding recorded as
    // `~/Code/...` must match a scan under a `~/code` code root.
    const bound = await Promise.all(
      (await this.deps.bindings.listBindings())
        .map((binding) => binding.worktreePath)
        .filter((path): path is string => Boolean(path))
        .map((path) => this.deps.worktrees.canonicalPath(path)),
    );
    let root = roots[0]?.root ?? "";
    let mostOrphans = 0;
    const paths: string[] = [];
    for (const group of roots) {
      const found = findOrphanDirs(group.dirs, bound);
      paths.push(...found);
      if (found.length > mostOrphans) {
        mostOrphans = found.length;
        root = group.root;
      }
    }
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
    const force = options?.force ?? {};
    const protectedPaths = options?.protectedPaths ?? [];
    // A parent with active children asks first (children are never touched
    // either way): it is about other tasks, so it stays its own question.
    if (!force.leaveChildren) {
      const children = await this.listChildren(task.id);
      const active = children.filter((child) => child.state !== "done");
      if (active.length > 0) {
        return {
          requiresConfirmation: "activeChildren",
          detail: `${task.title} has ${active.length} active child task${active.length === 1 ? "" : "s"}: ${active.map((child) => child.title).join(", ")}`,
        };
      }
    }
    // Then exactly one "Mark done?" question; once confirmed, Done is final
    // and the housekeeping is the app's (never a second question).
    if (!force.confirmed) return this.doneConfirmation(task, protectedPaths);
    // The binding as it is now: Done parks it (no worktree path left to
    // locate the session file by) before the usage snapshot runs.
    const binding = await this.deps.bindings
      .getBindingForTask(task.id)
      .catch(() => undefined);
    const landed = await this.executeConfirmedDone(task, protectedPaths);
    if (!landed) throw new Error(`Task not found: ${taskId}`);
    const usage = await this.usage.update(task.id, {
      ...(binding ? { binding } : {}),
    });
    return { task: usage ? { ...landed, usage } : landed };
  }

  async retryDoneCleanup(
    taskId: string,
    options?: RefreshOptions,
  ): Promise<Task> {
    const task = await this.requireTask(taskId);
    if (task.state !== "done" || !task.cleanup) {
      throw new Error(`${task.title} has no pending cleanup`);
    }
    if (task.cleanup.mode !== "forced" || task.cleanup.completedAt) {
      return task;
    }
    return (
      (await this.runForcedCleanup(
        taskId,
        options?.protectedPaths ?? [],
        "done.retry-cleanup",
      )) ?? task
    );
  }

  async abandonDoneCleanup(taskId: string): Promise<Task> {
    const task = await this.requireTask(taskId);
    if (!task.cleanup || task.cleanup.completedAt) return task;
    const now = this.deps.clock.now().toISOString();
    const next = await this.deps.tasks.patchTask(taskId, (fresh) => {
      if (!fresh.cleanup || fresh.cleanup.completedAt) return undefined;
      const cleanup: TaskCleanup = { ...fresh.cleanup, mode: "abandoned" };
      delete cleanup.nextAttemptAt;
      return { ...fresh, cleanup, updatedAt: now };
    });
    if (!next) return task;
    await this.appendCleanupAudit(
      taskId,
      `cleanup abandoned by the user${task.cleanup.lastError ? ` (last error: ${task.cleanup.lastError})` : ""}`,
    );
    await this.publishTaskChange(next);
    return next;
  }

  async launchTask(input: LaunchTaskInput): Promise<Task> {
    const task = await this.queueLaunchedTask(input);
    this.logLaunch(task, "queued", input.relation);
    return task;
  }

  /** `[core:launch]` state-transition line (the app's `[background-launcher]` lines cover spawning). */
  private logLaunch(
    task: Task,
    outcome: "queued" | "claimed" | "interrupted" | "done" | "blocked",
    relation?: string,
  ): void {
    const message =
      outcome === "done" || outcome === "blocked"
        ? `task ${task.id} reported ${outcome}`
        : `${outcome} task ${task.id}`;
    this.log.info("launch", message, {
      taskId: task.id,
      relation:
        relation ??
        (task.parentTaskId
          ? "child"
          : task.launchedFromTaskId
            ? "standalone"
            : undefined),
      repository:
        task.repositoryId ?? (task.folderPath ? "(folder)" : "(no repository)"),
      outcome,
    });
  }

  private async queueLaunchedTask(input: LaunchTaskInput): Promise<Task> {
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
    if (input.pullRequest !== undefined) {
      // A PR task works on the PR's own head branch: nothing to base it on,
      // and never in place.
      if (input.inPlace) {
        throw new Error("A pull-request task cannot run in place (chat)");
      }
      if (input.baseBranch === "parent" || input.baseRef) {
        throw new Error(
          "A pull-request task works on the PR's head branch: baseBranch/baseRef do not apply",
        );
      }
    }

    const where = await this.resolveWhere(
      input.repository,
      config,
      input.inPlace,
    );
    const repo = where.kind === "repository" ? where.repo : undefined;
    const hasRepository = where.kind === "repository";
    const bound =
      input.pullRequest !== undefined
        ? await this.resolvePullRequestTask(repo, input.pullRequest, input.role)
        : undefined;

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
      ...(where.kind === "folder" ? { inPlace: true } : {}),
      ...(bound?.pr
        ? {
            pullRequest: {
              number: bound.pr.number,
              role: bound.pr.role ?? "author",
            },
          }
        : {}),
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
      bypassPermissions: resolveLaunchBypass({
        requested: input.bypassPermissions,
        repository: repo ? config.repositories?.[repo.id] : undefined,
        config,
      }),
    };

    const task: Task = {
      id,
      kind: hasRepository ? "task" : "temp_task",
      state: "working",
      title: input.title,
      initialPrompt,
      ...(repo ? { repositoryId: repo.id } : {}),
      ...(where.kind === "folder" ? { folderPath: where.path } : {}),
      ...(baseRef ? { baseRef } : {}),
      ...agentFields(
        input,
        this.resolveTaskHarness(input.harness, parentTask, repo?.id, config),
      ),
      ...(parentTaskId ? { parentTaskId } : {}),
      ...(launchedFromTaskId ? { launchedFromTaskId } : {}),
      launch,
      createdAt: now,
      updatedAt: now,
      stateChangedAt: now,
    };

    if (repo) {
      const branch =
        bound?.branch ??
        deriveTaskBranch(input.title, id, config.branchPrefix ?? "");
      const next: Task = {
        ...task,
        branch,
        targetBranch: repo.defaultBranch,
        ...(bound ? { pr: bound.pr } : {}),
      };
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
        bound?.pr.number,
        bound?.pr.role,
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
    for (const task of claimed) this.logLaunch(task, "claimed");
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
      if (result) {
        changed = true;
        // patchTask hands back the unchanged task too: log real transitions only.
        if (result.launch?.interruptedAt === now) {
          this.logLaunch(result, "interrupted");
        }
      }
    }
    if (changed) await this.publishBoard();
  }

  async listChildren(parentTaskId: string): Promise<Task[]> {
    const tasks = await this.deps.tasks.listTasks();
    return tasks
      .filter((task) => task.parentTaskId === parentTaskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async setTaskParent(
    taskId: string,
    parentTaskId: string | null,
  ): Promise<Task> {
    const task = await this.requireTask(taskId);
    if ((task.parentTaskId ?? null) === parentTaskId) return task;
    const now = this.deps.clock.now().toISOString();
    if (parentTaskId === null) {
      const { parentTaskId: _dropped, ...rest } = task;
      const next: Task = { ...rest, updatedAt: now };
      await this.deps.tasks.replaceTask(next);
      await this.publishTaskChange(next);
      return next;
    }
    if (parentTaskId === taskId) {
      throw new Error("A task cannot be its own parent");
    }
    const parent = await this.deps.tasks.getTask(parentTaskId);
    if (!parent) throw new Error(`Task not found: ${parentTaskId}`);
    if (parent.parentTaskId) {
      throw new Error(
        `${parent.title} is itself a child task; tasks nest one level only`,
      );
    }
    if ((await this.listChildren(taskId)).length > 0) {
      throw new Error(
        `${task.title} has children of its own; tasks nest one level only`,
      );
    }
    const next: Task = { ...task, parentTaskId: parent.id, updatedAt: now };
    await this.deps.tasks.replaceTask(next);
    await this.publishTaskChange(next);
    return next;
  }

  async getLaunchSettings(repositoryId?: string): Promise<LaunchSettings> {
    const config = await this.deps.config.load();
    const repository = repositoryId
      ? config.repositories?.[repositoryId]
      : undefined;
    return {
      maxConcurrent:
        config.launch?.maxConcurrent ?? DEFAULT_LAUNCH_MAX_CONCURRENT,
      ...(config.launch?.defaultModel
        ? { defaultModel: config.launch.defaultModel }
        : {}),
      defaultHarness: resolveNewTaskHarness({ repository, config }),
      bypassPermissions: resolveLaunchBypass({ repository, config }),
      customAgents: config.agents?.custom ?? [],
      ...(this.deps.openUrlHandler
        ? { openUrlHandler: this.deps.openUrlHandler }
        : {}),
      captureAgentBrowser: config.captureAgentBrowser ?? false,
    };
  }

  refresh(options?: RefreshOptions): Promise<RefreshResult> {
    // Single-flight: the 30s timer and a manual refresh must never run two
    // observations of the same task side by side (each would decide moves
    // off its own reading); a call made mid-run joins the running one.
    if (this.refreshInFlight) return this.refreshInFlight;
    const run = timed(
      this.log,
      "refresh",
      "refresh",
      {},
      () => this.runRefresh(options?.protectedPaths ?? []),
      (result) => ({
        count: this.refreshTaskCount,
        warnings: result.warnings.length,
        errors: result.connectivity?.failedChecks ?? 0,
      }),
    ).finally(() => {
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
    this.refreshTaskCount = candidates.length;
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
    const prefetched = await this.prefetchPullRequests(
      observed,
      repositories,
      warnings,
      connectivity,
    );
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

    // Worktree dirtiness, once per tick for every reader (the rules'
    // `worktree.dirty` fact, the app's "Ready to review" hint), rules on or
    // off; bounded so a slow repository cannot stretch the tick.
    const liveTasks = await this.deps.tasks.listTasks();
    await this.refreshWorktreeStatus(liveTasks, bindingFor);

    // The agent guide in the rules dir is written on every start, rules on
    // or off.
    if (this.rules) warnings.push(...(await this.rules.ensureManagedFiles()));
    // Board automation: the rules engine (sources → events → rules →
    // actions), only with the kill switch on.
    if (config.automation && this.rules) {
      const result = await this.rules.tick({
        tasks: liveTasks,
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
    // Usage (docs/costs.md): still-pending tasks are re-checked on every
    // tick; tasks never computed are drained in the background (all of
    // them, in batches, one board push per batch), never blocking the
    // tick. Never on a manager without agents.
    if (this.deps.harness || this.deps.harnesses) {
      const usageChanged = await this.usage
        .recheckPending(await this.deps.tasks.listTasks(), bindingFor)
        .catch(() => false);
      if (usageChanged) changed = true;
      void this.usage.drain(
        () => this.deps.tasks.listTasks(),
        bindingFor,
        () => this.publishBoard(),
      );
    }
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
   * (when the PR access supports it), keyed by task id. A failed batch is
   * one failure with one cause: it is reported once for the repository
   * (one warning or one connectivity count, never one per task), and its
   * tasks are marked `batchFailed` so `refreshTask` records no observation
   * for the rules engine. Tasks missing from the map (no batch support, no
   * origin remote) are looked up one by one as before.
   */
  private async prefetchPullRequests(
    tasks: readonly Task[],
    repositories: Map<string, RepositoryInfo> | undefined,
    warnings: string[],
    connectivity: { failedChecks: number },
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
          this.transientPrFailures.delete(repositoryId);
        } catch (error) {
          for (const task of group) {
            prefetched.set(task.id, { batchFailed: true });
          }
          const message = describeError(error);
          if (!isConnectivityError(message) && isTransientError(message)) {
            const streak =
              (this.transientPrFailures.get(repositoryId) ?? 0) + 1;
            this.transientPrFailures.set(repositoryId, streak);
            if (streak < TRANSIENT_PR_FAILURES_BEFORE_WARNING) {
              this.log.warn("refresh", "PR status lookup failed (transient)", {
                repositoryId,
                count: streak,
                error: logErrorMessage(error),
              });
              return;
            }
          } else {
            this.transientPrFailures.delete(repositoryId);
          }
          this.recordFailure(
            `PR status for ${repositoryId} (${group.length} task${group.length === 1 ? "" : "s"})`,
            error,
            warnings,
            connectivity,
          );
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
      // Already reported once for the whole batch by prefetchPullRequests.
      if (prefetched && "batchFailed" in prefetched) return false;
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
          ...(provenance.source ? { source: provenance.source } : {}),
          ...(input.priority === false || String(input.priority) === "false"
            ? { priority: false }
            : {}),
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
      case "working":
        await this.moveTask(task.id, "working");
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
        const result = await this.executeSafeDone(task, protectedPaths);
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
   * The auto-landing done path (a rule's `move: done`). Never asks and never
   * forces: a live pane's worktree (`protectedPaths`), a dirty worktree or
   * any other refusal keeps the task where it is (`stayed: true`, nothing
   * changed) so it shows as "ready to land" for the user to mark Done.
   * Failures after the worktree is gone (review checkouts, branch) become
   * the `warning`. Manual Done is `toDone` (one confirmation, forced
   * app-owned cleanup).
   */
  private async executeSafeDone(
    task: Task,
    protectedPaths: readonly string[],
  ): Promise<{
    task?: Task;
    warning?: string;
    stayed?: boolean;
  }> {
    const start = performance.now();
    const fields = () => ({
      op: "done.cleanup" as const,
      taskId: task.id,
      repositoryId: task.repositoryId,
      branch: task.branch,
      ms: elapsedMs(start),
    });
    const failed = (error: string) => {
      // A rule retries a refused Done every tick (e.g. while a pane holds
      // the worktree): log a refusal once per distinct reason.
      if (this.doneCleanupFailures.get(task.id) === error) return;
      this.doneCleanupFailures.set(task.id, error);
      this.log.warn("done", "done.cleanup failed", {
        ...fields(),
        outcome: "failed",
        error,
      });
    };
    let result: Awaited<ReturnType<CoreManager["executeSafeDoneSteps"]>>;
    const binding = await this.deps.bindings
      .getBindingForTask(task.id)
      .catch(() => undefined);
    try {
      result = await this.executeSafeDoneSteps(task, protectedPaths);
    } catch (error) {
      failed(logErrorMessage(error));
      throw error;
    }
    if (result.stayed) {
      failed(result.warning ?? "stayed");
    } else {
      this.doneCleanupFailures.delete(task.id);
      this.log.info("done", "done.cleanup ok", {
        ...fields(),
        outcome: "ok",
        ...(result.warning ? { error: result.warning } : {}),
      });
      if (result.task) {
        const usage = await this.usage.update(task.id, {
          ...(binding ? { binding } : {}),
        });
        if (usage) result = { ...result, task: { ...result.task, usage } };
      }
    }
    return result;
  }

  private async executeSafeDoneSteps(
    task: Task,
    protectedPaths: readonly string[],
  ): Promise<{
    task?: Task;
    warning?: string;
    stayed?: boolean;
  }> {
    let warning: string | undefined;
    const addWarning = (text: string) => {
      warning = warning ? `${warning}; ${text}` : text;
    };
    if (!task.repositoryId) {
      // Repository-less (scratch) task: there is no git here at all. The
      // scratch directory stays on disk; only park the binding, exactly
      // like a git worktree binding minus the git removal (never run
      // worktree/branch verbs against a scratch binding).
      const binding = await this.deps.bindings.getBindingForTask(task.id);
      if (binding?.worktreePath) await this.parkBinding(binding);
    }
    if (task.repositoryId && task.branch) {
      let repo: RepositoryInfo;
      try {
        repo = await this.findRepository(task.repositoryId);
      } catch (error) {
        return { stayed: true, warning: describeError(error) };
      }
      const binding = await this.deps.bindings.getBindingForTask(task.id);
      if (binding?.worktreePath) {
        const path = binding.worktreePath;
        if (isProtectedPath(path, protectedPaths)) {
          // A live pane (or other process) still has this worktree as its
          // cwd: never pull it out from under it (pi-home's protectedCwd).
          return {
            stayed: true,
            warning: `worktree left in place: it is open in a live session (${path})`,
          };
        }
        try {
          await this.deps.worktrees.removeWorktree(repo, path, false);
        } catch (error) {
          return {
            stayed: true,
            warning: `worktree left in place: ${describeError(error)}`,
          };
        }
        await this.parkBinding(binding);
        const reviewWarning = await this.removeReviewCheckouts(
          repo,
          path,
          protectedPaths,
        );
        if (reviewWarning) addWarning(reviewWarning);
        if (shouldDeleteBranch(task.pr) && !binding.detached) {
          const branchWarning = await this.deleteTaskBranch(repo, task.branch);
          if (branchWarning) addWarning(branchWarning);
        }
      }
    }
    const next = await this.landInDone(task.id);
    return { ...(next ? { task: next } : {}), ...(warning ? { warning } : {}) };
  }

  /**
   * Patch the move onto the task as persisted now (cleanup can take a
   * while, and a concurrent refresh may have updated the PR snapshot
   * meanwhile), optionally recording the app-owned `cleanup`, and publish.
   */
  private async landInDone(
    taskId: string,
    cleanup?: TaskCleanup,
  ): Promise<Task | undefined> {
    const now = this.deps.clock.now().toISOString();
    const next = await this.deps.tasks.patchTask(taskId, (fresh) => {
      assertAllowedTransition(fresh.state, "done");
      const landed: Task = {
        ...fresh,
        state: "done",
        updatedAt: now,
        stateChangedAt: now,
        completedAt: fresh.completedAt ?? now,
        ...(cleanup ? { cleanup } : {}),
      };
      delete landed.awaiting;
      return landed;
    });
    if (next) await this.publishTaskChange(next);
    return next;
  }

  /** Best effort: a leftover prompt file or plugin dir is only clutter. */
  private async removeLaunchFiles(taskId: string): Promise<void> {
    await this.deps.launchFiles?.removeTaskLaunchFiles(taskId).catch(() => {});
  }

  /**
   * The single "Mark done?" question for a manual Done, its lines computed
   * up front (`doneConfirmationLines`). Read-only: nothing moves or is
   * touched until the user confirms.
   */
  private async doneConfirmation(
    task: Task,
    protectedPaths: readonly string[],
  ): Promise<ToDoneConfirmation> {
    let facts: DoneConfirmationFacts = {};
    if (task.repositoryId && task.branch) {
      const binding = await this.deps.bindings
        .getBindingForTask(task.id)
        .catch(() => undefined);
      const repo = await this.findRepository(task.repositoryId).catch(
        () => undefined,
      );
      const path = binding?.worktreePath;
      const uncommittedChanges = path
        ? await this.uncommittedChangeCount(path)
        : 0;
      const branchPresent = repo
        ? await this.deps.worktrees
            .branchExists(repo, task.branch)
            .catch(() => Boolean(path))
        : Boolean(path);
      facts = {
        ...(path ? { worktreePath: path } : {}),
        uncommittedChanges,
        ...(branchPresent && !shouldDeleteBranch(task.pr)
          ? { unmergedBranch: task.branch }
          : {}),
        closesPane: Boolean(path && isProtectedPath(path, protectedPaths)),
      };
    }
    return {
      requiresConfirmation: "done",
      detail: task.title,
      lines: doneConfirmationLines(facts),
      ...(facts.closesPane ? { closesPane: true } : {}),
    };
  }

  /** Uncommitted changes in a worktree (0 when it is missing or unreadable). */
  private async uncommittedChangeCount(path: string): Promise<number> {
    try {
      return await this.deps.worktrees.uncommittedChangeCount(path);
    } catch {
      return 0;
    }
  }

  /**
   * A confirmed manual Done: the task moves to Done right away with
   * `cleanup: { mode: "forced" }` recorded, then the first forced cleanup
   * attempt runs (`runForcedCleanup`). A failure never blocks the move and
   * never comes back as a warning: it is recorded on `task.cleanup` and the
   * refresh sweep retries it.
   */
  private async executeConfirmedDone(
    task: Task,
    protectedPaths: readonly string[],
  ): Promise<Task | undefined> {
    const binding = await this.deps.bindings
      .getBindingForTask(task.id)
      .catch(() => undefined);
    if (!task.repositoryId && binding?.worktreePath) {
      // Scratch / folder task: no git here; the directory stays, the
      // binding parks (session identity survives for a reopen).
      await this.parkBinding(binding);
    }
    const now = this.deps.clock.now().toISOString();
    const repoBacked = Boolean(task.repositoryId && task.branch);
    const cleanup: TaskCleanup = {
      mode: "forced",
      requestedAt: now,
      attempts: 0,
      ...(repoBacked
        ? {
            // The user confirmed either a merged branch or the unmerged line.
            // A detached reviewer checkout never owned the branch.
            deleteBranch: !binding?.detached,
            ...(binding?.worktreePath
              ? { worktreePath: binding.worktreePath }
              : {}),
          }
        : { completedAt: now }),
    };
    const landed = await this.landInDone(task.id, cleanup);
    if (!landed || !repoBacked) return landed;
    return (await this.runForcedCleanup(task.id, protectedPaths)) ?? landed;
  }

  /**
   * The worktree is gone; keep the binding (session identity survives for a
   * reopen — pi-home parks it the same way). The launch files go with the
   * workspace: no agent runs here anymore, and a reopen's launch writes
   * them again.
   */
  private async parkBinding(binding: WorkspaceBinding): Promise<void> {
    const { worktreePath: _removed, ...parked } = binding;
    await this.deps.bindings.replaceBinding({
      ...parked,
      updatedAt: this.deps.clock.now().toISOString(),
    });
    await this.removeLaunchFiles(binding.taskId);
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

  /**
   * One forced cleanup attempt for a confirmed Done task (`task.cleanup.mode
   * === "forced"`): force-remove the worktree (orphans and missing folders
   * handled, see `removeWorktreeForced`), park the binding, remove review
   * checkouts, delete the local branch. Records the outcome on
   * `task.cleanup` (`attempts`, `lastError`, backoff `nextAttemptAt`, or
   * `completedAt`) and in the audit log; never throws, never warns. A
   * worktree still open in a live process (`protectedPaths`) is skipped
   * without counting an attempt. Returns the task as persisted afterwards.
   */
  private async runForcedCleanup(
    taskId: string,
    protectedPaths: readonly string[],
    op: CoreOperation = "done.forced-cleanup",
  ): Promise<Task | undefined> {
    const before = await this.deps.tasks.getTask(taskId).catch(() => undefined);
    const start = performance.now();
    const after = await this.runForcedCleanupAttempt(taskId, protectedPaths);
    const cleanup = after?.cleanup;
    const attempted =
      cleanup !== undefined &&
      cleanup.attempts !== (before?.cleanup?.attempts ?? 0);
    const fields = {
      op,
      taskId,
      repositoryId: after?.repositoryId,
      branch: after?.branch,
      worktreePath: cleanup?.worktreePath,
      ms: elapsedMs(start),
      count: cleanup?.attempts,
    };
    if (!attempted) {
      // Not attempted (a live pane holds the worktree, another attempt is
      // running, nothing pending): quiet for the sweep, which would
      // otherwise repeat this every tick while a pane stays open.
      if (op === "done.retry-cleanup") {
        this.log.info("done", `${op} skipped`, {
          ...fields,
          outcome: "skipped",
        });
      }
    } else if (cleanup.completedAt) {
      this.log.info("done", `${op} ok`, { ...fields, outcome: "ok" });
    } else {
      this.log.warn("done", `${op} failed`, {
        ...fields,
        outcome: "failed",
        error: cleanup.lastError,
      });
    }
    return after;
  }

  private async runForcedCleanupAttempt(
    taskId: string,
    protectedPaths: readonly string[],
  ): Promise<Task | undefined> {
    if (this.cleanupsInFlight.has(taskId)) {
      return this.deps.tasks.getTask(taskId);
    }
    this.cleanupsInFlight.add(taskId);
    try {
      const task = await this.deps.tasks.getTask(taskId);
      if (
        task?.state !== "done" ||
        task.cleanup?.mode !== "forced" ||
        task.cleanup.completedAt
      ) {
        return task;
      }
      let failure: string | undefined;
      try {
        if (!task.repositoryId || !task.branch) {
          // Nothing git-shaped to clean (scratch / folder task).
        } else {
          const repo = await this.findRepository(task.repositoryId);
          const binding = await this.deps.bindings.getBindingForTask(task.id);
          const path = binding?.worktreePath;
          if (path && isProtectedPath(path, protectedPaths)) {
            // Still open in a live process: never pull a cwd out from under
            // it; the sweep tries again once it is gone (no attempt counted).
            return task;
          }
          if (binding && path) {
            await this.removeWorktreeForced(repo, path);
            await this.parkBinding(binding);
          }
          const reviewRoot = path ?? task.cleanup.worktreePath;
          const reviewWarning = reviewRoot
            ? await this.removeReviewCheckouts(repo, reviewRoot, protectedPaths)
            : undefined;
          if (reviewWarning) {
            // Throwaway checkouts; leftovers show in the orphan scan.
            await this.appendCleanupAudit(task.id, reviewWarning);
          }
          if (task.cleanup.deleteBranch) {
            await this.deps.worktrees.deleteBranch(repo, task.branch, true);
          }
        }
      } catch (error) {
        failure = describeError(error);
      }
      const now = this.deps.clock.now();
      const next = await this.deps.tasks.patchTask(taskId, (fresh) => {
        if (
          fresh.state !== "done" ||
          fresh.cleanup?.mode !== "forced" ||
          fresh.cleanup.completedAt
        ) {
          return undefined;
        }
        const attempts = fresh.cleanup.attempts + 1;
        const cleanup: TaskCleanup = {
          ...fresh.cleanup,
          attempts,
          lastAttemptAt: now.toISOString(),
        };
        if (failure) {
          cleanup.lastError = failure;
          cleanup.nextAttemptAt = nextCleanupAttemptAt(attempts, now);
        } else {
          delete cleanup.lastError;
          delete cleanup.nextAttemptAt;
          cleanup.completedAt = now.toISOString();
        }
        return { ...fresh, cleanup, updatedAt: now.toISOString() };
      });
      if (failure) {
        // Audit only: a confirmed Done never comes back as a toast.
        await this.appendCleanupAudit(
          taskId,
          `worktree left in place: ${failure}`,
        );
      }
      if (next) await this.publishTaskChange(next);
      return next ?? (await this.deps.tasks.getTask(taskId));
    } finally {
      this.cleanupsInFlight.delete(taskId);
    }
  }

  /**
   * `git worktree remove --force`, owning the edge cases instead of asking:
   * a folder that is already gone counts as cleaned (git's bookkeeping is
   * pruned), and a folder whose git metadata is missing ("not a git
   * repository") is deleted outright, then pruned.
   */
  private async removeWorktreeForced(
    repo: RepositoryInfo,
    path: string,
  ): Promise<void> {
    try {
      await this.deps.worktrees.removeWorktree(repo, path, true);
      return;
    } catch (error) {
      const kind = classifyWorktreeRemovalError(error);
      if (kind === "other") throw error;
      if (kind === "orphan") await this.deps.worktrees.deleteWorktreeDir(path);
    }
    await this.deps.worktrees.pruneWorktrees(repo).catch(() => {});
  }

  /** One audit-log warning line for a task's cleanup (no-op without the rules storage). */
  private async appendCleanupAudit(
    taskId: string,
    message: string,
  ): Promise<void> {
    const audit = this.deps.rules?.audit;
    if (!audit) return;
    await audit
      .append([
        {
          kind: "warning",
          at: this.deps.clock.now().toISOString(),
          taskId,
          message,
        },
      ])
      .catch(() => {});
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
   * The done-cleanup sweep. A confirmed Done (`task.cleanup.mode ===
   * "forced"`, not completed) gets a forced retry once its backoff is due
   * (1 min, 5 min, 30 min, then hourly), silently: the outcome lands on
   * `task.cleanup` and the audit log, never in `warnings`. Abandoned or
   * completed cleanups are left alone. Older done tasks without a `cleanup`
   * record keep the safe (unforced) retry for a worktree still on disk: one
   * attempt per task per refresh; a live pane's worktree is skipped
   * silently, and a repeated refusal is reported only when its reason
   * changes. After the session-continuity rework a Done task keeps its
   * binding, so "still on disk" means the binding still carries a
   * `worktreePath`.
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
    const now = this.deps.clock.now();
    for (const task of tasks) {
      if (task.state === "done" && task.cleanup) {
        if (isForcedCleanupDue(task.cleanup, now)) {
          await this.runForcedCleanup(task.id, protectedPaths);
        }
        continue;
      }
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
        const branchFailure = binding.detached
          ? undefined
          : await this.deleteMergedBranch(repo, task.branch, task.pr);
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
    const config = await this.deps.config.load();
    if (route === "child-to-parent") {
      if (!(await harness.presence(target.id)).live) {
        throw new Error(
          "Your parent task is not running; stop and ask the user instead.",
        );
      }
      if (!(await this.harnessFor(senderTask, config)).messaging.receive) {
        throw new Error(
          "Your harness can't receive replies, so your parent couldn't answer; stop and ask the user instead.",
        );
      }
    }

    // 5. The target's harness must be able to receive (decision R3: an
    //    agent without inbox glue refuses sends up front).
    const targetHarness = await this.harnessFor(target, config);
    if (!targetHarness.messaging.receive) {
      throw new Error(
        `Task ${target.id}'s harness can't receive messages: ${targetHarness.label} does not support messaging; tell the user instead.`,
      );
    }

    // 6. Lineage routes check the loop cap.
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
      const delivered = resolveDeliveredMode(mode, targetHarness.messaging);
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
    options: { idle: boolean; messageIds?: readonly string[] },
  ): Promise<TaskMessage[]> {
    const { messages } = this.requireMessaging();
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
    const capabilities = (await this.harnessFor(task)).messaging;
    const claimed = await messages.claimDeliverable(taskId, {
      idle: options.idle,
      deliveredAt: now,
      resolveMode: (requested) => resolveDeliveredMode(requested, capabilities),
      ...(options.messageIds ? { ids: options.messageIds } : {}),
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
    // The task's harness may give its own reports a different meaning
    // (Claude Code's "working" while only background work runs).
    const task = await this.deps.tasks.getTask(taskId).catch(() => undefined);
    const adapter = task
      ? await this.harnessFor(task).catch(() => undefined)
      : undefined;
    const reported: ProgramStatusReading = {
      state: report.state,
      ...(report.message ? { message: report.message } : {}),
    };
    const interpreted = adapter?.interpretProgramStatus?.(reported) ?? reported;
    const tracking = trackReport(
      this.turnTracking.get(taskId),
      report.pid,
      interpreted,
    );
    this.turnTracking.set(taskId, tracking);
    // A hook already said the turn is over: a lingering `working` is idle.
    const reading = readingUnderTurnBoundary(
      interpreted,
      tracking.lastBoundary,
    );
    await presence.applyReport(taskId, (current) =>
      applyProgramStatus(current, {
        taskId,
        pid: report.pid,
        state: reading.state,
        ...(reading.message ? { message: reading.message } : {}),
        at: report.at ?? this.deps.clock.now().toISOString(),
      }),
    );
  }

  async reportTurnBoundary(
    taskId: string,
    boundary: TurnBoundaryReport,
  ): Promise<void> {
    const before = this.turnTracking.get(taskId);
    const next = trackBoundary(before, boundary.kind);
    this.turnTracking.set(taskId, next);
    const pid = before?.pid;
    const reading = before?.reading;
    if (pid === undefined || !reading) return;
    const was = readingUnderTurnBoundary(reading, before?.lastBoundary);
    const now = readingUnderTurnBoundary(reading, next.lastBoundary);
    if (was.state === now.state) return;
    // The last report reads differently under the new boundary (`working`
    // then `stop` → idle; `stop`, `working`, then `prompt` → working).
    const presence = this.requirePresence();
    const record = await presence.read(taskId);
    if (!record || record.ended || record.pid !== pid) return;
    const at = boundary.at ?? this.deps.clock.now().toISOString();
    await presence.applyReport(taskId, (current) =>
      current && (current.ended || current.pid !== pid)
        ? current
        : applyProgramStatus(current, {
            taskId,
            pid,
            state: now.state,
            ...(now.message ? { message: now.message } : {}),
            at,
          }),
    );
  }

  async reportHookPresence(
    taskId: string,
    report: HookPresenceReport,
  ): Promise<void> {
    const presence = this.requirePresence();
    // Only the attachment the launcher registered at spawn: a hook from a
    // session the app does not own (or after its exit) records nothing.
    const record = await presence.read(taskId);
    if (!record || record.ended) return;
    const before = this.turnTracking.get(taskId);
    const tracking =
      before?.pid === record.pid ? { ...before } : { pid: record.pid };
    const boundary = hookPresenceBoundary(report.event);
    if (boundary) tracking.lastBoundary = boundary;
    const reading = hookPresenceReading(
      record.status,
      report,
      tracking.abortedGeneration,
    );
    if (report.event === "stop" && report.status === "aborted") {
      if (report.generation) tracking.abortedGeneration = report.generation;
    } else if (report.event === "prompt") {
      delete tracking.abortedGeneration;
    }
    this.turnTracking.set(taskId, tracking);
    if (!reading) return;
    const at = report.at ?? this.deps.clock.now().toISOString();
    const pid = record.pid;
    await presence.applyReport(taskId, (current) =>
      current && (current.ended || current.pid !== pid)
        ? current
        : applyProgramStatus(current, {
            taskId,
            pid,
            state: reading.state,
            ...(reading.message ? { message: reading.message } : {}),
            at,
          }),
    );
  }

  async recordTurnUsage(
    taskId: string,
    usage: HarnessTurnUsage,
  ): Promise<void> {
    const task = await this.deps.tasks.getTask(taskId).catch(() => undefined);
    if (!task) return;
    const adapter = await this.harnessFor(task).catch(() => undefined);
    if (!adapter?.recordTurnUsage) return;
    await adapter.recordTurnUsage({
      ...usage,
      at: usage.at ?? this.deps.clock.now().toISOString(),
    });
    // The ledger changed but the transcript may not have: recount.
    await this.usage.update(taskId, { force: true });
  }

  async endPresence(
    taskId: string,
    input: { pid: number; at?: string },
  ): Promise<void> {
    this.turnTracking.delete(taskId);
    await this.requirePresence().end(
      taskId,
      input.pid,
      input.at ?? this.deps.clock.now().toISOString(),
    );
    // The agent finished: snapshot its usage (docs/costs.md).
    await this.usage.update(taskId);
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
    const reported = await this.deps.tasks
      .getTask(taskId)
      .catch(() => undefined);
    if (reported) this.logLaunch(reported, outcome.status);
    await this.usage.update(taskId);
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
    const { messages } = this.requireMessaging();
    if (decided.sender.kind !== "task") return;
    const sender = await this.deps.tasks.getTask(decided.sender.taskId);
    if (!sender || sender.state === "done" || sender.state === "backlog")
      return;
    if (!(await this.harnessFor(sender)).messaging.receive) return;
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
    const rules = this.requireRules();
    const config = await this.deps.config.load();
    return rules.listRules(config.automation);
  }

  async setRulesEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") {
      throw new Error("enabled must be true or false");
    }
    await this.applySettings({ automation: enabled });
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
    if (!button && options?.snoozeUntil) {
      if (Number.isNaN(Date.parse(options.snoozeUntil))) {
        throw new Error(`Not a time: ${options.snoozeUntil}`);
      }
      const until = new Date(options.snoozeUntil).toISOString();
      const item = await inbox.update(itemId, (current) => ({
        ...current,
        snoozedUntil: until,
      }));
      this.deps.events.emit("inbox-changed", {});
      return { item: item ?? existing };
    }
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

  async evaluateInboxPriority(items: InboxPriorityInput[]): Promise<boolean[]> {
    const config = await this.deps.config.load();
    return applyInboxPriorityFilter(items, config.inbox?.priorityFilter)
      .priorities;
  }

  async listReadyToLand(): Promise<ReadyToLandEntry[]> {
    if (!this.rules) return [];
    const stayed = await this.rules.listStayedLandings();
    const tasks = new Map(
      (await this.deps.tasks.listTasks()).map((task) => [task.id, task]),
    );
    // Only while the task still sits where landing failed (not Done yet).
    return stayed.filter((entry) => {
      const task = tasks.get(entry.taskId);
      return !!task && task.state !== "done";
    });
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
  async createTaskFromAction(input: CreateTaskActionInput): Promise<Task> {
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

  async previewPullRequest(url: string): Promise<PullRequestPreview> {
    const reference =
      typeof url === "string" ? parsePullRequestUrl(url) : undefined;
    if (!reference) {
      throw new Error("Not a pull request URL (…/org/repo/pull/12)");
    }
    const repositories = await this.listRepositories();
    const repo = repositories.find(
      (candidate) => candidate.id === reference.repositoryId,
    );
    if (!repo) {
      throw new Error(
        `No local checkout of ${reference.repositoryId}: clone it under your code root or open its folder first`,
      );
    }
    if (!this.deps.pullRequests.view) {
      throw new Error("Pull-request tasks need GitHub access");
    }
    const status = await this.deps.pullRequests.view(repo.id, reference.number);
    return {
      repositoryId: repo.id,
      number: status.number,
      url: status.url,
      state: status.state,
      ...(status.title ? { title: status.title } : {}),
      ...(status.author ? { author: status.author } : {}),
      ...(status.headRefName ? { headRefName: status.headRefName } : {}),
      baseRefName: status.baseRefName ?? repo.defaultBranch,
      ...(status.viewerIsAuthor !== undefined
        ? { viewerIsAuthor: status.viewerIsAuthor }
        : {}),
    };
  }

  // --- Onboarding (docs/release-plan.md "Onboarding (four screens)") ----

  async getOnboardingState(): Promise<OnboardingState> {
    return this.onboardingState(await this.deps.config.load());
  }

  /** The first existing usual code folder (`~/Code`, `~/src`, …), else `~/harbormaster`. */
  private async suggestCodeRoot(): Promise<string> {
    const probes = this.requireOnboarding();
    const home = probes.homeDir();
    for (const candidate of codeRootCandidates(home)) {
      if (await probes.isDirectory(candidate)) return candidate;
    }
    return fallbackCodeRoot(home);
  }

  private async onboardingState(
    config: GlobalConfig,
  ): Promise<OnboardingState> {
    const probes = this.requireOnboarding();
    const suggested = await this.suggestCodeRoot();
    // An unset codeRoot loads as the legacy `~/Code` default, so before the
    // wizard is finished only a configured root that exists beats the
    // suggestion.
    const configured =
      config.codeRoot &&
      (config.onboardingCompletedAt ||
        (await probes.isDirectory(config.codeRoot)))
        ? config.codeRoot
        : undefined;
    return {
      ...(config.onboardingCompletedAt
        ? { completedAt: config.onboardingCompletedAt }
        : {}),
      codeRoot: configured ?? suggested,
      suggestedCodeRoot: suggested,
      homeDir: probes.homeDir(),
      defaultHarness: config.launch?.defaultHarness ?? DEFAULT_HARNESS_ID,
      bypassPermissions:
        config.launch?.bypassPermissions ?? DEFAULT_LAUNCH_BYPASS_PERMISSIONS,
      customAgents: config.agents?.custom ?? [],
      githubEnabled: config.sources?.github?.enabled !== false,
    };
  }

  async scanCodeRoot(path: string): Promise<CodeRootScan> {
    const probes = this.requireOnboarding();
    if (!path.trim()) throw new Error("Choose a folder for your code.");
    const home = probes.homeDir();
    const root = expandHome(path, home);
    const exists = await probes.isDirectory(root);
    const repositories = exists
      ? toScannedRepositories(
          await this.deps.repositories.discoverRepositories(root),
        )
      : [];
    const protectedFolder = protectedHomeFolder(root, home);
    return {
      root,
      exists,
      ...(protectedFolder ? { protectedFolder } : {}),
      suggestedRoot: await this.suggestCodeRoot(),
      repositories,
    };
  }

  async setCodeRoot(
    path: string,
    options?: { create?: boolean },
  ): Promise<CodeRootScan> {
    let scan = await this.scanCodeRoot(path);
    if (!scan.exists && options?.create) {
      await this.requireOnboarding().createDirectory(scan.root);
      scan = await this.scanCodeRoot(scan.root);
    }
    if (!scan.exists) throw new Error(`${scan.root} is not a folder.`);
    await this.applySettings({ codeRoot: scan.root });
    return scan;
  }

  async detectAgents(): Promise<DetectedAgent[]> {
    const probes = this.requireOnboarding();
    const config = await this.deps.config.load();
    // Custom agents (config.json `agents.custom[]`, the Settings list, S9):
    // only located on PATH; an arbitrary CLI may not answer `--version`.
    const custom = Promise.all(
      (config.agents?.custom ?? []).map(
        async (agent): Promise<DetectedAgent> => {
          const path = await probes
            .resolveCommand(agent.command)
            .catch(() => undefined);
          return {
            id: agent.id,
            label: agent.label,
            command: agent.command,
            custom: true,
            ...(path
              ? { path, available: true }
              : { available: false, error: "not found" }),
          };
        },
      ),
    );
    const builtin = Promise.all(
      this.builtinHarnesses().map(async (adapter) =>
        detectedAgent(
          adapter.descriptor,
          await probeAgentCommand(adapter.descriptor, probes),
        ),
      ),
    );
    return [...(await builtin), ...(await custom)];
  }

  async setDefaultAgent(input: SetDefaultAgentInput): Promise<OnboardingState> {
    const harness = input.harness.trim();
    if (!harness) throw new Error("Choose a default agent.");
    let customAgent: CustomAgentConfig | undefined;
    if (input.customAgent) {
      const problems = customAgentProblems(
        input.customAgent,
        this.builtinHarnesses().map((adapter) => adapter.id),
      );
      if (problems.length > 0) throw new Error(problems.join(" "));
      if (input.customAgent.id.trim() !== harness) {
        throw new Error("The default agent must be the custom agent's id.");
      }
      const args = input.customAgent.args?.filter((arg) => arg.length > 0);
      customAgent = {
        id: harness,
        label: input.customAgent.label.trim(),
        command: input.customAgent.command.trim(),
        ...(args && args.length > 0 ? { args } : {}),
        ...(input.customAgent.promptArg
          ? { promptArg: input.customAgent.promptArg }
          : {}),
      };
    } else if (
      !this.builtinHarnesses().some((adapter) => adapter.id === harness)
    ) {
      const config = await this.deps.config.load();
      if (!config.agents?.custom?.some((agent) => agent.id === harness)) {
        throw new Error(`Unknown agent "${harness}".`);
      }
    }
    const config = await this.applySettings({
      defaultHarness: harness,
      ...(customAgent ? { customAgent } : {}),
      ...(input.bypassPermissions !== undefined
        ? { bypassPermissions: input.bypassPermissions }
        : {}),
    });
    return this.onboardingState(config);
  }

  async githubAuthStatus(): Promise<GithubAuthStatus> {
    const outcome = await this.requireOnboarding().githubAuthStatus();
    if (outcome.notFound) {
      return {
        installed: false,
        authenticated: false,
        error: "The GitHub CLI (gh) is not installed.",
      };
    }
    const login = parseGhAuthStatus(outcome.output);
    if (login) {
      return {
        installed: true,
        authenticated: true,
        account: login.account,
        host: login.host,
      };
    }
    if (outcome.ok) return { installed: true, authenticated: true };
    return {
      installed: true,
      authenticated: false,
      error: probeError(outcome, "gh is not logged in"),
    };
  }

  async setSourceEnabled(sourceId: string, enabled: boolean): Promise<void> {
    const id = sourceId.trim();
    if (!id) throw new Error("A source id is required.");
    await this.applySettings({ sourceEnabled: { id, enabled } });
  }

  async ensureDefaultRules(): Promise<{ created: boolean }> {
    return this.requireRules().ensureDefaults();
  }

  async completeOnboarding(): Promise<OnboardingState> {
    const config = await this.applySettings({
      onboardingCompletedAt: this.deps.clock.now().toISOString(),
    });
    return this.onboardingState(config);
  }

  // --- Doctor (see manager/doctor-runtime.ts) -----------------------------

  async doctor(input?: DoctorInput): Promise<DoctorReport> {
    const probes = this.deps.environment;
    if (!probes) throw new Error("doctor is not configured");
    return new DoctorRuntime({
      probes,
      agents: this.builtinHarnesses().map((adapter) => adapter.descriptor),
      config: this.deps.config,
      tasks: this.deps.tasks,
      bindings: this.deps.bindings,
      ...(this.deps.rules ? { rules: this.deps.rules.files } : {}),
      now: () => this.deps.clock.now(),
      repositories: (config) => this.allRepositories(config),
      orphans: () => this.scanOrphanWorktrees(),
      versions: this.deps.versions,
    }).run(input ?? {});
  }

  private async applySettings(
    patch: ConfigSettingsPatch,
  ): Promise<GlobalConfig> {
    const config = this.deps.config;
    if (!config.applySettings) throw new Error("settings are not writable");
    return config.applySettings(patch);
  }

  private requireOnboarding(): OnboardingProbeAccess {
    if (!this.deps.onboarding) throw new Error("onboarding is not configured");
    return this.deps.onboarding;
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

  // --- Code review via Plannotator (docs/plannotator.md) -----------------

  async openTaskUrl(input: {
    taskId: string;
    url: string;
    source?: "plannotator" | "browser";
  }): Promise<void> {
    const url = loopbackUrl(input.url);
    if (!url) {
      throw new Error(
        `Only http(s) URLs on 127.0.0.1, localhost or [::1] open in Harbormaster: ${input.url}`,
      );
    }
    await this.requireTask(input.taskId);
    this.deps.events.emit("task-url-opened", {
      taskId: input.taskId,
      url,
      source: input.source === "plannotator" ? "plannotator" : "browser",
    });
  }

  async requestReview(input: {
    taskId: string;
    target?: "local" | "pr";
    deliver?: "message" | "none";
  }): Promise<RequestReviewResult> {
    const task = await this.requireTask(input.taskId);
    const harness = await this.harnessFor(task);
    if (!harness.review) {
      throw new Error(`${harness.label} can't start a code review.`);
    }
    const prUrl = task.pr?.url;
    const kind = input.target ?? (prUrl ? "pr" : "local");
    let target: ReviewTarget;
    if (kind === "pr") {
      if (!prUrl) throw new Error(`Task ${task.id} has no pull request.`);
      target = { kind: "pr", url: prUrl };
    } else {
      target = { kind: "local" };
    }
    const command = harness.review.command(target);
    // The app types it into the session's own terminal (a real slash
    // command); core never touches a pty, so it records nothing then.
    if (input.deliver === "none") return { command, delivered: "none" };
    const { message } = await this.sendTaskMessage({
      from: { kind: "user" },
      targetTaskId: task.id,
      text: command,
      mode: "steer",
    });
    return { command, delivered: "message", messageId: message.id };
  }

  async reviewSupport(options?: { refresh?: boolean }): Promise<ReviewSupport> {
    const probes = this.deps.reviewProbes;
    if (!probes) throw new Error("review support is not configured");
    const nowMs = this.deps.clock.now().getTime();
    let entry = this.reviewVersions;
    if (
      options?.refresh ||
      !entry ||
      nowMs - entry.at >= REVIEW_SUPPORT_CACHE_MS
    ) {
      const versions = probeReviewVersions(probes);
      const fresh = {
        at: nowMs,
        checkedAt: this.deps.clock.now().toISOString(),
        versions,
      };
      this.reviewVersions = fresh;
      entry = fresh;
      // A failed probe run must not stick for a minute.
      versions.catch(() => {
        if (this.reviewVersions === fresh) this.reviewVersions = undefined;
      });
    }
    const [versions, config] = await Promise.all([
      entry.versions,
      this.deps.config.load(),
    ]);
    const harnesses = this.deps.harnesses
      ? this.deps.harnesses.list(config.agents?.custom ?? [])
      : this.deps.harness
        ? [this.deps.harness]
        : [];
    return {
      harnesses: harnesses.map((harness) => ({
        ...reviewSupportFor(harness, versions),
        label: harness.label,
      })),
      checkedAt: entry.checkedAt,
    };
  }

  // --- Costs: per-task token usage (docs/costs.md) -----------------------

  async listTaskUsage(query?: TaskUsageQuery): Promise<TaskUsageRow[]> {
    const tasks = await this.deps.tasks.listTasks();
    // Tasks the backfill drain has yet to count are listed as `pending`
    // rows (the Costs view's "counting N more"); only when agents exist,
    // since otherwise no backfill ever runs.
    const uncounted = new Set<string>();
    if (
      (this.deps.harness || this.deps.harnesses) &&
      tasks.some((task) => !task.usage)
    ) {
      const bindings = new Map(
        (await this.deps.bindings.listBindings().catch(() => [])).map(
          (binding) => [binding.taskId, binding],
        ),
      );
      for (const task of tasks) {
        if (awaitsUsageBackfill(task, bindings.get(task.id))) {
          uncounted.add(task.id);
        }
      }
    }
    return buildTaskUsageRows(tasks, query ?? {}, uncounted);
  }

  /**
   * Resolves once the background usage backfill drain (started by
   * `refresh`) has finished; immediately when none runs. Not a
   * `CoreCommands` member: for hosts and tests that need to wait for it.
   */
  whenUsageBackfilled(): Promise<void> {
    return this.usage.idle();
  }

  async refreshTaskUsage(taskId: string): Promise<TaskUsage | undefined> {
    await this.requireTask(taskId);
    return this.usage.update(taskId, { force: true });
  }

  /** The adapter that reads a task's sessions (see `UsageRuntimeDeps.adapterFor`). */
  private async usageAdapterFor(
    task: Task,
  ): Promise<HarnessAdapter | "unsupported" | undefined> {
    if (!this.deps.harness && !this.deps.harnesses) return undefined;
    const config = await this.deps.config.load();
    // A task on an agent that is no longer registered (a removed custom
    // CLI) must not have its sessions read by the fallback adapter.
    if (
      this.deps.harnesses &&
      task.harness &&
      task.harness !== DEFAULT_HARNESS_ID &&
      !this.deps.harnesses.get(task.harness, config.agents?.custom ?? [])
    ) {
      return "unsupported";
    }
    return this.harnessFor(task, config);
  }

  async setCaptureAgentBrowser(enabled: boolean): Promise<void> {
    await this.applySettings({ captureAgentBrowser: enabled });
  }

  // --- Settings (docs/settings.md; see manager/settings-runtime.ts) -----

  async getSettings(): Promise<SettingsSnapshot> {
    return this.settings.get();
  }

  async updateSettings(patch: SettingsPatch): Promise<SettingsSnapshot> {
    return this.settings.update(patch);
  }

  /** Registered sources for Settings (S10): the rules runtime's built-ins and loaded add-ons. */
  private async settingsSources(): Promise<SettingsSourceListing[]> {
    if (!this.rules) {
      return builtinSources.map((source) => ({
        id: source.id,
        ...(source.title ? { title: source.title } : {}),
        ...(source.settingsSchema
          ? { settingsSchema: source.settingsSchema }
          : {}),
        builtin: true,
      }));
    }
    const addons = await this.rules.listAddons();
    return addons
      .filter((addon) => addon.loaded)
      .flatMap((addon) =>
        addon.sources.map((source) => ({
          id: source.id,
          ...(source.title ? { title: source.title } : {}),
          ...(source.settingsSchema
            ? { settingsSchema: source.settingsSchema }
            : {}),
          builtin: addon.builtin,
          ...(addon.builtin
            ? {}
            : {
                addon: {
                  name: addon.name,
                  ...(addon.description
                    ? { description: addon.description }
                    : {}),
                },
              }),
        })),
      );
  }

  /** Watch config.json for hand edits (S4); the app calls this once at start. Not part of the command API. */
  watchConfig(): void {
    this.settings.watch();
  }

  /** Shutdown: stop the config watcher and change reactions. */
  dispose(): void {
    this.settings.dispose();
  }

  /** The agents a `harness` setting may name: registered adapters, else the built-ins plus custom agents. */
  private harnessOptions(config: GlobalConfig): SettingsHarnessOption[] {
    const custom = config.agents?.custom ?? [];
    const customIds = new Set(custom.map((agent) => agent.id));
    if (this.deps.harnesses) {
      return this.harnessList(config).map((adapter) => ({
        id: adapter.id,
        label: adapter.label,
        custom: customIds.has(adapter.id),
      }));
    }
    return [
      ...this.builtinHarnesses().map((adapter) => ({
        id: adapter.id,
        label: adapter.label,
        custom: false,
      })),
      ...custom.map((agent) => ({
        id: agent.id,
        label: agent.label,
        custom: true,
      })),
    ];
  }
}

/** How long `reviewSupport`'s probed versions are reused. */
const REVIEW_SUPPORT_CACHE_MS = 60_000;

/** Runs the Plannotator probes in parallel and parses their versions. */
async function probeReviewVersions(
  probes: ReviewSupportProbeAccess,
): Promise<ReviewVersions> {
  const [binary, manifest, plugins, claude, skill, codexSkill] =
    await Promise.all([
      probes.plannotatorVersion(),
      probes.piExtensionManifest(),
      probes.claudePluginList(),
      probes.claudeVersion(),
      probes.claudeReviewSkill(),
      probes.codexReviewSkill(),
    ]);
  const versions: ReviewVersions = {};
  const found = {
    binary: parseSemver(binary),
    "pi-extension": piExtensionVersion(manifest),
    "claude-plugin": claudePluginVersion(plugins),
    "claude-code": parseSemver(claude),
    "claude-skill": skill?.trim() ? "found" : undefined,
    "codex-skill": codexSkill?.trim() ? "found" : undefined,
  } as const;
  for (const [id, version] of Object.entries(found)) {
    if (version) versions[id as keyof ReviewVersions] = version;
  }
  return versions;
}

/** A failed probe in one line: timed out, not found, or its first output line. */
function probeError(outcome: ProbeOutcome, notFound: string): string {
  if (outcome.timedOut) return "Timed out.";
  if (outcome.notFound) return notFound;
  const line = outcome.output
    .split(/\r?\n/)
    .map((text) => text.trim())
    .find(Boolean);
  return line ?? "Failed.";
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
  if (sender.kind === "user") return "You";
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
