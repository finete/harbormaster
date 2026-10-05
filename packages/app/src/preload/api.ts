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

/** Pushed every poll tick (~5s) for every non-done task; badge-sized only (see Sidebar/TaskCard). */
export type PresenceChangedPayload = Record<
  string,
  { live: boolean; runningTurn: boolean }
>;

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
    /** Subscribes to the core's board-changed push channel; returns an unsubscribe fn. */
    onBoardChanged(
      listener: (payload: BoardChangedPayload) => void,
    ): () => void;
    /** On-demand liveness snapshot for the takeover guard; see `PresenceSnapshot`. */
    presence(taskId: string): Promise<PresenceSnapshot>;
    /** Subscribes to the ~5s presence poll's push channel; returns an unsubscribe fn. */
    onPresenceChanged(
      listener: (payload: PresenceChangedPayload) => void,
    ): () => void;
  };
}
