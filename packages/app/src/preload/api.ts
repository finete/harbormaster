// Shared type contracts for the narrow IPC surface exposed to the renderer.
// The renderer has no Node access; every call goes through these typed
// bridges in `index.ts`'s `contextBridge.exposeInMainWorld`.
//
// `@harbormaster/core` types are imported `type`-only here: fully erased at
// build time, so none of core's Node-dependent runtime code (fs, child
// processes, ...) ever ends up in the renderer's web bundle "- only its
// plain data shapes cross the bridge.
import type {
  AddonInfo,
  AuditEntry,
  AwaitingKindId,
  AwaitingKindOption,
  BoardChangedPayload,
  BoardColumn,
  CodeRootScan,
  CreateTaskActionInput,
  CreateTaskInput,
  DetectedAgent,
  GithubAuthStatus,
  HarnessModelCatalog,
  InboxItem,
  InboxPriorityInput,
  KnownLocation,
  LaunchSettings,
  LaunchTaskInput,
  ListEventsFilter,
  ListInboxOptions,
  MessageMode,
  MoveTaskOptions,
  OnboardingState,
  OrphanWorktreeReport,
  PresenceRecord,
  PullRequestPreview,
  PullRequestReference,
  ReadyToLandEntry,
  ReopenTaskInput,
  RepositoryInfo,
  ResolveInboxItemOptions,
  ResolveInboxItemResult,
  RulesCheckInput,
  RulesCheckResult,
  RulesListing,
  SetDefaultAgentInput,
  Task,
  TaskMessage,
  TaskMessagingState,
  TaskState,
  ToAwaitOptions,
  ToDoneResult,
  UpdateTaskInput,
  WorkspaceBinding,
} from "@harbormaster/core";

/** Mirrors `main/connectivity-loop.ts`'s `ConnectivityState`; kept local so the renderer never imports main-process code. */
export type ConnectivityState =
  | "online"
  | "offline"
  | "reconnecting"
  | "restored";

export type {
  AddonInfo,
  AuditActionEntry,
  AuditEntry,
  AwaitingKind,
  AwaitingKindField,
  AwaitingKindId,
  AwaitingKindOption,
  BoardChangedPayload,
  BoardColumn,
  BoardGroup,
  CodeRootScan,
  CreateTaskActionInput,
  CreateTaskInput,
  CustomAgentConfig,
  DetectedAgent,
  GithubAuthStatus,
  HarnessModel,
  HarnessModelCatalog,
  InboxButton,
  InboxItem,
  InboxPriorityInput,
  KnownLocation,
  LaunchSettings,
  LaunchTaskInput,
  MessageAttachment,
  MessageMode,
  MessageRoute,
  MessageSender,
  MessageStatus,
  MoveTaskOptions,
  OnboardingState,
  OrphanWorktreeReport,
  PresenceRecord,
  PullRequestPreview,
  PullRequestReference,
  PullRequestRole,
  ReadyToLandEntry,
  ReopenTaskInput,
  RepositoryCheckout,
  RepositoryInfo,
  ResolveInboxItemResult,
  ScannedRepository,
  SetDefaultAgentInput,
  Task,
  TaskMessage,
  TaskMessagingState,
  TaskState,
  ThinkingLevel,
  ToAwaitOptions,
  ToDoneConfirmation,
  ToDoneResult,
  UpdateTaskInput,
  WorkspaceBinding,
} from "@harbormaster/core";

/**
 * Pushed on `core:messaging-changed` whenever task messaging changes (see
 * `main/messaging-push.ts`): the messages awaiting the user's approval and
 * the derived per-task chip state (only tasks with something to report).
 */
export interface MessagingChangedPayload {
  approvals: TaskMessage[];
  states: TaskMessagingState[];
}

/** The user's answers to a previous `toDone` confirmation question. */
export interface ToDoneForce {
  /** Answers the single "Mark done?" question: Done is final, the app owns the cleanup. */
  confirmed?: boolean;
  /** Answers the `activeChildren` confirmation: complete the parent anyway, leaving its children running and nested under it. */
  leaveChildren?: boolean;
}

/**
 * On-demand liveness snapshot for one task's harness session (see
 * `@harbormaster/core`'s `PresenceStatus`), plus `ownedByApp`: whether the
 * live process is one of this app's own spawned ptys (computed in main from
 * its pty-session tracking, never from presence file data directly — see
 * `main/index.ts`). Used by the takeover guard before opening/focusing a
 * task.
 */
export interface PresenceSnapshot {
  live: boolean;
  runningTurn: boolean;
  record?: PresenceRecord;
  ownedByApp: boolean;
}

/**
 * How a task's badge was corroborated against the app's own pty registry
 * (see `main/presence-corroboration.ts`):
 * - `"record"`: the extension's record is trusted as-is (pid-matched pane,
 *   or an external session beyond this app's panes).
 * - `"pane-only"`: a pane of ours is open but its pid doesn't match the
 *   record (stale record, impersonation, pre-guard leftovers) - attached
 *   is trusted, the record's turn/outcome semantics are not.
 * - `"none"`: no pane and no trustworthy record (absent, or its process is
 *   confirmed dead).
 * Not yet rendered distinctly (no renderer redesign) - carried through so
 * a future UI pass can style a distrusted record differently.
 */
export type PresenceCorroboration = "record" | "pane-only" | "none";

/** One task's entry in the ~5s presence push. */
export interface PresenceBadge {
  live: boolean;
  runningTurn: boolean;
  /** See `PresenceCorroboration`. */
  corroboration: PresenceCorroboration;
  /** Last heartbeat of the live attachment (ISO); set only while `live`. Drives the sidebar's relative-time column. */
  heartbeatAt?: string;
  /**
   * Terminal outcome of a headless run, once reported (status/note only "-
   * the one-shot `notified` flag is main's own bookkeeping and never
   * crosses the bridge). Drives the unread dot and OS notification for a
   * "blocked" outcome (see lib/unread.ts, lib/notifications.ts).
   */
  ended?: {
    status: "done" | "blocked" | "unreported";
    note?: string;
  };
  /**
   * Live self-reported done/blocked verdict while the process is STILL
   * attached (see `PresenceRecord.outcome`) "-" distinct from `ended`,
   * which means the process is gone. Forwarded under the same
   * corroboration trust rule as `ended` (see main/presence-corroboration.ts).
   */
  outcome?: {
    status: "done" | "blocked";
    note?: string;
    /** When it was reported (ISO). */
    at?: string;
  };
  /**
   * The agent's last OSC 7501 program status (decision #18), forwarded
   * under the same trust rule as `outcome`: `blocked` is "your move",
   * `idle` / `done` are at rest, `error` is at rest with a warning
   * (`message`). See lib/task-status-lines.ts `derivePresenceActivity`.
   */
  status?: {
    state: "idle" | "working" | "blocked" | "done" | "error";
    message?: string;
    /** When the agent reported it (ISO). */
    at?: string;
  };
}

/** Pushed every poll tick (~5s) for every non-done task; badge-sized only (see Sidebar/TaskCard). */
export type PresenceChangedPayload = Record<string, PresenceBadge>;

export interface TerminalCreateOptions {
  cols: number;
  rows: number;
  /** Spawn cwd override (e.g. a task's worktree path); falls back to the app's cwd. */
  cwd?: string;
  /** The task this panel belongs to; combined with `primary`, lets main decide whether to launch pi. */
  taskId?: string;
  /**
   * Whether this is a task workspace's first terminal panel. Only a primary
   * panel on a task with a workspace binding launches pi; split-shell
   * panels (and primaries on scratch tasks) always get a plain `$SHELL`.
   */
  primary?: boolean;
}

export interface TerminalCreateResult {
  id: string;
  /** True when an agent launch was attempted but its command could not be found, and this session fell back to `$SHELL`. */
  fellBackToShell: boolean;
  /** The agent's bare command (`pi`, `claude`, ...) when `fellBackToShell`, for the warning strip. */
  missingCommand?: string;
  /**
   * True when this primary pane's task has a worktree binding but that
   * directory no longer exists on disk, so pi was not launched (spawning
   * into a dead cwd dies as a bare exit-1). The pane opened a shell in the
   * app's own cwd instead; the renderer surfaces a recover-the-worktree
   * hint.
   */
  worktreeMissing?: boolean;
}

export interface TerminalDataEvent {
  id: string;
  data: string;
}

export interface TerminalExitEvent {
  id: string;
  exitCode: number;
}

/** `terminal.attachPrimary`'s result when the task has a live, currently-unattached app-owned primary pty to rebind to this renderer. */
export interface AttachPrimaryResult {
  id: string;
  /** The background session's screen, serialized (scrollback + viewport + cursor) — write this into the pane's xterm before switching to live streaming. */
  snapshot: string;
}

export interface TerminalHostApi {
  /**
   * Resolve what to paste when the user hits Cmd+V in a terminal pane.
   * Handles image → temp-file path and Finder file → shell-escaped path (P0).
   */
  resolveClipboardPaste(): Promise<string | null>;
  /**
   * Open an http/https link in the user's default browser via the main process.
   * Returns false when the URL is not allowed (only http/https are permitted).
   */
  openLink(url: string): Promise<boolean>;
  /**
   * Resolve the absolute file-system path for a File from a drop event.
   * Uses Electron's `webUtils.getPathForFile` from the preload context.
   */
  getPathForFile(file: File): string;
}

export interface HarbormasterApi {
  shell: {
    /**
     * Open `url` in the user's default browser. Main only honors
     * https://github.com/ links (see main/external-url.ts); anything else
     * resolves `false` without launching anything.
     */
    openExternal(url: string): Promise<boolean>;
    /**
     * Reveal `path` in the OS file manager (Finder on macOS). Main
     * allowlists `path` to a directory under the configured `codeRoot` or
     * the app's own state dir (mirrors `openExternal`'s host allowlist —
     * see main/reveal-path.ts); anything else resolves `false` without
     * shelling out.
     */
    revealInFolder(path: string): Promise<boolean>;
  };
  terminal: {
    create(options: TerminalCreateOptions): Promise<TerminalCreateResult>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    /**
     * Flow control: reports that `chars` of this session's output have been
     * fully processed by the pane's terminal emulator, so main can resume a
     * pty it paused for being too far ahead of the renderer.
     */
    ack(id: string, chars: number): void;
    dispose(id: string): Promise<void>;
    /**
     * Release a pane's pty on an explicit tab close: a task primary detaches
     * back to the background (kept alive, headless screen mirror) so
     * reopening re-attaches to the same pi instead of cold-starting one, and
     * a working task's agent is not killed by closing its tab. Non-primary
     * ptys (split shells, shell fallbacks) are disposed. Prefer this
     * over `dispose` for pane unmount; `dispose` unconditionally kills.
     * `screen` is the pane's serialized last screen, replayed on reopen.
     */
    release(id: string, screen?: string): Promise<void>;
    /**
     * Subscribe to pty output. Pass `id` to receive only that session's
     * chunks (routed centrally in the preload: one IPC listener total, not
     * one per pane); omit it to receive every session's.
     */
    onData(
      listener: (event: TerminalDataEvent) => void,
      id?: string,
    ): () => void;
    /** Subscribe to pty exits; `id` filters to one session like `onData`. */
    onExit(
      listener: (event: TerminalExitEvent) => void,
      id?: string,
    ): () => void;
    /**
     * P1-1: Query whether screenReaderMode should be enabled for terminal
     * panes. Returns true when the OS reports an AT or the e2e env var
     * HARBORMASTER_TERMINAL_A11Y_MIRROR=1 is set.
     */
    getScreenReaderMode(): Promise<boolean>;
    /** Subscribe to accessibility-support-changed pushes from main. */
    onScreenReaderModeChanged(cb: (enabled: boolean) => void): () => void;
    /**
     * Rebind a task's live, currently-unattached background-launched
     * primary pty to this renderer (wave-2 task brief point 4): write the
     * returned `snapshot` into the pane's xterm first, then behave exactly
     * like a normal `create`d session (same `onData`/`onExit`/`write`/
     * `resize`/`ack`/`dispose`). Resolves `undefined` when there is no live
     * background primary for `taskId` (never launched, already exited, or
     * already attached) "-" the caller falls back to `create` exactly as it
     * would for a task launched the ordinary way. Main resizes the pty to
     * `cols`/`rows` as part of the attach (Pi redraws on resize).
     */
    attachPrimary(
      taskId: string,
      cols: number,
      rows: number,
    ): Promise<AttachPrimaryResult | undefined>;
  };
  core: {
    listBoard(): Promise<BoardColumn[]>;
    getTask(id: string): Promise<Task | undefined>;
    listRepositories(): Promise<RepositoryInfo[]>;
    /** See `CoreCommands.listLocations`. */
    listLocations(): Promise<KnownLocation[]>;
    /** See `CoreCommands.addLocation`. */
    addLocation(path: string): Promise<KnownLocation>;
    /** See `CoreCommands.listBranches`. */
    listBranches(repositoryId: string): Promise<string[]>;
    /** See `CoreCommands.listModels`. */
    listModels(): Promise<HarnessModelCatalog[]>;
    getTaskWorkspace(taskId: string): Promise<WorkspaceBinding | undefined>;
    createTask(input: CreateTaskInput): Promise<Task>;
    moveTask(
      id: string,
      state: TaskState,
      options?: MoveTaskOptions,
    ): Promise<Task>;
    /**
     * Start a parked backlog task: creates its branch + worktree + binding
     * (repository-backed tasks without one) and moves it to `dev`. See
     * `CoreCommands.startTask`.
     */
    startTask(taskId: string): Promise<Task>;
    /**
     * The registered awaiting kinds (review first), resolved against the
     * task: availability and what entering each will do. See
     * `CoreCommands.listAwaitingKinds`.
     */
    listAwaitingKinds(taskId?: string): Promise<AwaitingKindOption[]>;
    /**
     * The one "await" verb: run the kind's onEnter action (review: push +
     * open/reuse the PR; deploy: squash-merge + enter the pipeline) and move
     * the task to `awaiting` with that kind. Rejects (task unmoved) when the
     * action fails. See `CoreCommands.toAwait`.
     */
    toAwait(
      taskId: string,
      kindId: AwaitingKindId,
      options?: ToAwaitOptions,
    ): Promise<Task>;
    /**
     * Move a task to `done`. The first call comes back as the single
     * "Mark done?" question (task NOT moved; its `lines` say what will
     * happen); answer it by calling again with `force.confirmed`. On a
     * confirmed call main first closes this app's processes in the task's
     * worktree (warm session, panes), then core lands the task and owns the
     * cleanup (`task.cleanup`). See `CoreCommands.toDone`.
     */
    toDone(
      taskId: string,
      options?: { force?: ToDoneForce },
    ): Promise<ToDoneResult>;
    /** The cleanup inbox item's Retry: force the Done task's cleanup again now. See `CoreCommands.retryDoneCleanup`. */
    retryDoneCleanup(taskId: string): Promise<Task>;
    /** The cleanup inbox item's Dismiss: give up on the Done task's cleanup. See `CoreCommands.abandonDoneCleanup`. */
    abandonDoneCleanup(taskId: string): Promise<Task>;
    /**
     * Reopen a Done task as a new Dev cycle (fresh branch + worktree; the
     * previous conversation is forked into its next pi pane). A missing
     * previous conversation surfaces as `warning`. See `CoreCommands.reopenTask`.
     */
    reopenTask(
      taskId: string,
      input?: ReopenTaskInput,
    ): Promise<{ task: Task; warning?: string }>;
    /**
     * The one launch primitive (see /docs/design-decisions.md "Launching tasks from an agent"): creates a
     * task and queues it to start running in the background "-" the app's
     * background launcher (main/background-launcher.ts) starts its pty with
     * no pane open; opening the task later attaches to it (see
     * `terminal.attachPrimary`). See `CoreCommands.launchTask`.
     */
    launchTask(input: LaunchTaskInput): Promise<Task>;
    /** Every task launched as a child of `parentTaskId`, any state, oldest first. See `CoreCommands.listChildren`. */
    listChildren(parentTaskId: string): Promise<Task[]>;
    /** Current effective launch settings (concurrency cap, default model, default agent, permission bypass; repository-aware when given one), for the composer without touching config files. See `CoreCommands.getLaunchSettings`. */
    getLaunchSettings(repositoryId?: string): Promise<LaunchSettings>;
    /** Re-fetch PR status, run movers, and sweep archive flags; same command the app's 30s refresh loop calls. See `CoreCommands.refresh`. */
    refresh(): Promise<{ warnings: string[] }>;
    /** Unbound directories under the worktrees root, sized, plus a warning past the threshold. Slow; see `CoreCommands.scanOrphanWorktrees`. */
    scanOrphanWorktrees(): Promise<OrphanWorktreeReport>;
    /** Subscribes to the core's board-changed push channel; returns an unsubscribe fn. */
    onBoardChanged(
      listener: (payload: BoardChangedPayload) => void,
    ): () => void;
    /**
     * Subscribes to the main process's 30s automation-refresh push channel
     * (see `main/index.ts`'s `refreshOnce`): a single joined warning string
     * whenever `refresh()` surfaces one, deduped against the immediately
     * preceding push (never fires twice in a row with the same text).
     * Returns an unsubscribe fn.
     */
    onRefreshWarning(listener: (warning: string) => void): () => void;
    /**
     * Subscribes to the main process's offline/reconnecting/restored banner
     * push channel (see `main/connectivity-loop.ts`): one state per actual
     * transition, never a toast. Returns an unsubscribe fn.
     */
    onConnectivityChanged(
      listener: (state: ConnectivityState) => void,
    ): () => void;
    /** Cmd/Ctrl+W intercepted in main; renderer closes the focused task workspace. */
    onCloseTabShortcut(listener: () => void): () => void;
    /** On-demand liveness snapshot for the takeover guard; see `PresenceSnapshot`. */
    presence(taskId: string): Promise<PresenceSnapshot>;
    /** Subscribes to the ~5s presence poll's push channel; returns an unsubscribe fn. */
    onPresenceChanged(
      listener: (payload: PresenceChangedPayload) => void,
    ): () => void;
    /**
     * Patch a task's non-state fields (title, prompt, error) without moving
     * it "-" used by the sidebar's inline rename (Orca polish item 4). Emits
     * the same `board-changed` push every other mutation does, so the board
     * card picks up a renamed title through the normal event flow. A
     * terminal pane's pi session name/widget only reflects the new title on
     * its *next* launch (it is set once at spawn time) "-" a known, accepted
     * limitation, not a bug.
     */
    updateTaskState(id: string, patch: UpdateTaskInput): Promise<Task>;
    /** Messages awaiting the user's approval, oldest first. See `CoreCommands.listPendingApprovals`. */
    listPendingApprovals(): Promise<TaskMessage[]>;
    /**
     * Approve a message awaiting approval, optionally with the user's edited
     * text and/or switched delivery mode (sent only when changed). Rejects
     * when the message is no longer awaiting approval. See
     * `CoreCommands.approveMessage`.
     */
    approveMessage(
      messageId: string,
      edits?: { text?: string; mode?: MessageMode },
    ): Promise<TaskMessage>;
    /** Reject a message awaiting approval. See `CoreCommands.rejectMessage`. */
    rejectMessage(messageId: string): Promise<TaskMessage>;
    /** Derived per-task chip state (approvals waiting, waiting on parent, ...). See `CoreCommands.getMessagingStates`. */
    getMessagingStates(): Promise<TaskMessagingState[]>;
    /** One stored attachment copy's bytes (base64), for thumbnails. See `CoreCommands.readMessageAttachment`. */
    readMessageAttachment(
      messageId: string,
      index: number,
    ): Promise<{ mimeType?: string; base64: string }>;
    /** The message log, optionally narrowed to one task. See `CoreCommands.listMessages`. */
    listMessages(filter?: { taskId?: string }): Promise<TaskMessage[]>;
    /** Subscribes to the messaging push channel (approvals + chip states, deduped); returns an unsubscribe fn. */
    onMessagingChanged(
      listener: (payload: MessagingChangedPayload) => void,
    ): () => void;
    /** Cmd/Ctrl+Shift+ArrowUp/Down intercepted in main; renderer cycles sidebar focus. */
    onCycleTask(listener: (direction: "up" | "down") => void): () => void;
    /** Persisted inbox items (rule items), unresolved and unsnoozed unless asked. See `CoreCommands.listInbox`. */
    listInbox(options?: ListInboxOptions): Promise<InboxItem[]>;
    /** Press an item's button, dismiss it (no options), or snooze it (`snoozeUntil`). See `CoreCommands.resolveInboxItem`. */
    resolveInboxItem(
      itemId: string,
      options?: ResolveInboxItemOptions,
    ): Promise<ResolveInboxItemResult>;
    /** Priority / Other per item via the configured filter. See `CoreCommands.evaluateInboxPriority`. */
    evaluateInboxPriority(items: InboxPriorityInput[]): Promise<boolean[]>;
    /** Tasks a rule could not land ("deployed and ready to land"). See `CoreCommands.listReadyToLand`. */
    listReadyToLand(): Promise<ReadyToLandEntry[]>;
    /** The `createTask` action as a command (PR URL + role). See `CoreCommands.createTaskFromAction`. */
    createTaskFromAction(input: CreateTaskActionInput): Promise<Task>;
    /** Core's PR URL parser (`github.com/org/repo/pull/12`); `null` when it is not one. */
    parsePullRequestUrl(url: string): Promise<PullRequestReference | null>;
    /** The composer's PR card: number, title, author, head → base. See `CoreCommands.previewPullRequest`. */
    previewPullRequest(url: string): Promise<PullRequestPreview>;
    /** The rules audit log. See `CoreCommands.listEvents`. */
    listEvents(filter?: ListEventsFilter): Promise<AuditEntry[]>;
    /** Dry run of the current rules. See `CoreCommands.rulesCheck`. */
    rulesCheck(input?: RulesCheckInput): Promise<RulesCheckResult>;
    /** Every rules file as loaded. See `CoreCommands.listRules`. */
    listRules(): Promise<RulesListing>;
    /** Built-in sources and addons. See `CoreCommands.listAddons`. */
    listAddons(): Promise<AddonInfo[]>;
    /** Last lines of a paneless task's screen (main's mirror); `null` when a pane shows it or nothing runs. */
    terminalTail(taskId: string, count?: number): Promise<string | null>;
    /** Start a failed / interrupted launch again in the background (clears its error); resolves whether it started. */
    retryLaunch(taskId: string): Promise<boolean>;
    /** The inbox changed (an item was added, resolved or snoozed); re-read it. */
    onInboxChanged(listener: () => void): () => void;
  };
  terminalHost: TerminalHostApi;
  app: {
    /** Native "Open folder" dialog; `null` when cancelled. */
    pickFolder(): Promise<string | null>;
    /**
     * Ask main to show a native OS notification for `taskId` (an unread
     * transition "-" finished or blocked, see lib/notifications.ts). Main
     * owns the actual `Notification` display (and its own
     * `HARBORMASTER_NOTIFICATIONS=off` kill switch); the renderer only ever
     * decides *when* to call this, never shows anything itself. Resolves
     * once main has handled the request (shown, suppressed by a flag, or
     * skipped because the platform doesn't support notifications) "-" never
     * rejects.
     */
    notify(input: {
      taskId: string;
      title: string;
      body: string;
    }): Promise<void>;
    /**
     * Push the current unread count to the dock badge (macOS only; a no-op
     * elsewhere). The renderer owns unread state (see useUnreadTaskIds); this
     * is the one small IPC that hands the count to main, which clears the
     * badge at zero.
     */
    setBadgeCount(count: number): Promise<void>;
    /**
     * Clicking a notification focuses the window and pushes the clicked
     * task's id here, through the exact same guarded open path
     * `app:cycle-task` uses (see App.tsx's subscription, which calls the
     * same `selectTask` a sidebar row click does).
     */
    onOpenTask(listener: (taskId: string) => void): () => void;
    /**
     * A launched task's background session just started (main pushes this
     * only once its pty exists): the renderer adds it to the sidebar rail
     * without focusing it, so its pane attaches to that pty.
     */
    onTaskLaunched(listener: (taskId: string) => void): () => void;
    /** The newest release found by main's update check, or `null` (none newer, not checked yet, or checks off). */
    getUpdate(): Promise<UpdateInfo | null>;
    /** Main's update check found a newer release (startup, then every 6h). */
    onUpdateAvailable(listener: (update: UpdateInfo) => void): () => void;
    /** Writes `text` to the system clipboard via main (works without window focus). */
    copyText(text: string): Promise<void>;
    /** "Export diagnostics": asks where to save, writes the zip; resolves its path or `null` when cancelled. */
    exportDiagnostics(): Promise<string | null>;
    /**
     * The "Open in …" apps installed on this host (editors, terminals, the
     * file manager), in menu order; probed once per app run (see
     * main/open-in.ts).
     */
    openInApps(): Promise<OpenInAppInfo[]>;
    /**
     * Open the folder `path` (a task's worktree) in catalog app `appId`.
     * Main allowlists `path` exactly like `shell.revealInFolder` and
     * refuses unknown ids; never launches the OS default handler.
     */
    openIn(path: string, appId: string): Promise<OpenInResult>;
  };
  /** The first-run wizard (docs/release-plan.md "Onboarding"); every call is a core command. */
  onboarding: OnboardingApi;
}

/** See `CoreCommands`' onboarding section; probes resolve asynchronously with short timeouts. */
export interface OnboardingApi {
  /** Whether the wizard shows at startup (never finished, not skipped by the e2e env). */
  shouldShow(): Promise<boolean>;
  getState(): Promise<OnboardingState>;
  scanCodeRoot(path: string): Promise<CodeRootScan>;
  setCodeRoot(
    path: string,
    options?: { create?: boolean },
  ): Promise<CodeRootScan>;
  detectAgents(): Promise<DetectedAgent[]>;
  setDefaultAgent(input: SetDefaultAgentInput): Promise<OnboardingState>;
  githubAuthStatus(): Promise<GithubAuthStatus>;
  setSourceEnabled(sourceId: string, enabled: boolean): Promise<void>;
  ensureDefaultRules(): Promise<{ created: boolean }>;
  complete(): Promise<OnboardingState>;
  /** The "Welcome / Setup…" menu item. */
  onShow(listener: () => void): () => void;
}

/** One "Open in …" target (see main/open-in.ts's catalog). */
export interface OpenInAppInfo {
  id: string;
  label: string;
  kind: "file-manager" | "editor" | "terminal";
}

export type OpenInResult = { ok: true } | { ok: false; error: string };

/** A newer Harbormaster release (see main/update-check.ts). */
export interface UpdateInfo {
  /** Version without a leading `v`, e.g. `1.2.0`. */
  version: string;
  /** The command that upgrades the installed app (`brew upgrade --cask harbormaster`). */
  command: string;
}
