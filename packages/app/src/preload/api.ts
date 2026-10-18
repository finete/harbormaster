// Shared type contracts for the narrow IPC surface exposed to the renderer.
// The renderer has no Node access; every call goes through these typed
// bridges in `index.ts`'s `contextBridge.exposeInMainWorld`.
//
// `@harbormaster/core` types are imported `type`-only here: fully erased at
// build time, so none of core's Node-dependent runtime code (fs, child
// processes, ...) ever ends up in the renderer's web bundle "- only its
// plain data shapes cross the bridge.
import type {
  AwaitingKindId,
  AwaitingKindOption,
  BoardChangedPayload,
  BoardColumn,
  CreateTaskInput,
  MoveTaskOptions,
  PresenceRecord,
  ReopenTaskInput,
  RepositoryInfo,
  Task,
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
  AwaitingKind,
  AwaitingKindField,
  AwaitingKindId,
  AwaitingKindOption,
  BoardChangedPayload,
  BoardColumn,
  BoardGroup,
  CreateTaskInput,
  MoveTaskOptions,
  PresenceRecord,
  ReopenTaskInput,
  RepositoryCheckout,
  RepositoryInfo,
  Task,
  TaskState,
  ToAwaitOptions,
  ToDoneConfirmation,
  ToDoneResult,
  UpdateTaskInput,
  WorkspaceBinding,
} from "@harbormaster/core";

/** The user's answers to a previous `toDone` confirmation question. */
export interface ToDoneForce {
  removeDirty?: boolean;
  deleteUnmerged?: boolean;
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

/** One task's entry in the ~5s presence push. */
export interface PresenceBadge {
  live: boolean;
  runningTurn: boolean;
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
   * panel on a task with a workspace binding launches pi; "+ terminal"
   * panels (and primaries on scratch tasks) always get a plain `$SHELL`.
   */
  primary?: boolean;
}

export interface TerminalCreateResult {
  id: string;
  /** True when a pi launch was attempted but its command could not be found, and this session fell back to `$SHELL`. */
  fellBackToShell: boolean;
}

export interface TerminalDataEvent {
  id: string;
  data: string;
}

export interface TerminalExitEvent {
  id: string;
  exitCode: number;
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
    dispose(id: string): Promise<void>;
    onData(listener: (event: TerminalDataEvent) => void): () => void;
    onExit(listener: (event: TerminalExitEvent) => void): () => void;
  };
  core: {
    listBoard(): Promise<BoardColumn[]>;
    getTask(id: string): Promise<Task | undefined>;
    listRepositories(): Promise<RepositoryInfo[]>;
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
     * Move a task to `done`. Uncommitted changes or an unmerged branch come
     * back as a confirmation question (task NOT moved); answer it by calling
     * again with `force`. A worktree open in one of this app's panes (main
     * supplies those) is kept with a `warning`. See `CoreCommands.toDone`.
     */
    toDone(
      taskId: string,
      options?: { force?: ToDoneForce },
    ): Promise<ToDoneResult>;
    /**
     * Reopen a Done task as a new Dev cycle (fresh branch + worktree; the
     * previous conversation is forked into its next pi pane). A missing
     * previous conversation surfaces as `warning`. See `CoreCommands.reopenTask`.
     */
    reopenTask(
      taskId: string,
      input?: ReopenTaskInput,
    ): Promise<{ task: Task; warning?: string }>;
    /** Re-fetch PR status, run movers, and sweep archive flags; same command the app's 30s refresh loop calls. See `CoreCommands.refresh`. */
    refresh(): Promise<{ warnings: string[] }>;
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
    /** Cmd/Ctrl+Shift+ArrowUp/Down intercepted in main; renderer cycles sidebar focus. */
    onCycleTask(listener: (direction: "up" | "down") => void): () => void;
  };
  app: {
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
  };
}
