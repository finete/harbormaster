// Shared type contracts for the narrow IPC surface exposed to the renderer.
// The renderer has no Node access; every call goes through these typed
// bridges in `index.ts`'s `contextBridge.exposeInMainWorld`.
//
// `@harbormaster/core` types are imported `type`-only here: fully erased at
// build time, so none of core's Node-dependent runtime code (fs, child
// processes, ...) ever ends up in the renderer's web bundle "- only its
// plain data shapes cross the bridge.
import type {
  BoardChangedPayload,
  BoardColumn,
  CreateTaskInput,
  MoveTaskOptions,
  PresenceRecord,
  ReopenTaskInput,
  RepositoryInfo,
  Task,
  TaskState,
  WorkspaceBinding,
} from "@harbormaster/core";

export type {
  AwaitingKind,
  BoardChangedPayload,
  BoardColumn,
  BoardGroup,
  CreateTaskInput,
  MoveTaskOptions,
  PresenceRecord,
  ReopenTaskInput,
  RepositoryInfo,
  Task,
  TaskState,
  WorkspaceBinding,
} from "@harbormaster/core";

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
     * Push the task's branch, open/reuse its PR, and move it to
     * `awaiting`/`{ kind: "review" }`. Rejects (no warning shape) for
     * scratch tasks or tasks with no bound worktree/branch; see
     * `CoreCommands.toReview`.
     */
    toReview(taskId: string): Promise<Task>;
    /**
     * Move a task to `done`; any cleanup refusal (dirty worktree, unmerged
     * branch, a worktree still open in one of this app's panes, ...)
     * surfaces as `warning` instead of throwing. See `CoreCommands.toDone`.
     */
    toDone(taskId: string): Promise<{ task: Task; warning?: string }>;
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
    /** Cmd/Ctrl+W intercepted in main; renderer closes the focused task workspace. */
    onCloseTabShortcut(listener: () => void): () => void;
    /** On-demand liveness snapshot for the takeover guard; see `PresenceSnapshot`. */
    presence(taskId: string): Promise<PresenceSnapshot>;
    /** Subscribes to the ~5s presence poll's push channel; returns an unsubscribe fn. */
    onPresenceChanged(
      listener: (payload: PresenceChangedPayload) => void,
    ): () => void;
  };
}
