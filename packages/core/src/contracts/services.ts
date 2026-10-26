// Service interfaces — the call-chain boundary between Manager/Engine and
// Resource Access (see /docs/design-decisions.md "Layering"). Managers and Engines only
// ever see these interfaces; concrete file-backed implementations live in
// access/.

import type {
  GlobalConfig,
  PresenceMode,
  PresenceRecord,
  Task,
  WorkspaceBinding,
} from "./model.js";

/**
 * Durable task storage. Exposes atomic business verbs over the task list,
 * not raw CRUD — callers never read-modify-write the array themselves.
 */
export interface TaskStateAccess {
  listTasks(): Promise<Task[]>;
  getTask(id: string): Promise<Task | undefined>;
  createTask(task: Task): Promise<void>;
  /** Replace a task's persisted fields entirely; the id must already exist. */
  replaceTask(task: Task): Promise<void>;
  /**
   * Atomic read-modify-write of one task under the state lock: `patch`
   * receives the task as currently persisted (never a caller's stale
   * snapshot) and returns its replacement, or `undefined` to leave it
   * untouched. Resolves to the task as persisted afterwards (`undefined`
   * when the task no longer exists). This is what slow callers (refresh,
   * which waits on GitHub between reading and writing) use so they only
   * ever change the fields they own and never clobber a concurrent move.
   */
  patchTask(
    id: string,
    patch: (current: Task) => Task | undefined,
  ): Promise<Task | undefined>;
  removeTask(id: string): Promise<void>;
  /**
   * Atomically flip up to `limit` queued launches (`task.launch.status ===
   * "queued"`, `task.state === "dev"`) to `started` (`startedAt`), FIFO by
   * `launch.requestedAt`, under the task-state lock "- so two concurrent
   * callers never both claim the same launch. `limit <= 0` claims nothing.
   * Returns the claimed tasks as persisted, in the order they were started.
   */
  claimQueuedLaunches(limit: number, startedAt: string): Promise<Task[]>;
}

/**
 * Workspace-binding storage (phase 2 seam). Phase 1 round-trips bindings but
 * nothing in the command API creates them yet.
 */
export interface WorkspaceBindingAccess {
  listBindings(): Promise<WorkspaceBinding[]>;
  getBindingForTask(taskId: string): Promise<WorkspaceBinding | undefined>;
  attachBinding(binding: WorkspaceBinding): Promise<void>;
  replaceBinding(binding: WorkspaceBinding): Promise<void>;
  removeBinding(taskId: string): Promise<void>;
}

export interface RegisterPresenceInput {
  taskId: string;
  sessionPath: string;
  pid: number;
  mode: PresenceMode;
  at: string;
  logPath?: string;
}

/**
 * Liveness and outcome registry for task-attached agent processes. Ported
 * from pi-home's presence access with the cmux location field dropped;
 * semantics (pid-scoped mutations from superseded processes are ignored)
 * carry over unchanged.
 */
export interface PresenceAccess {
  register(input: RegisterPresenceInput): Promise<void>;
  heartbeat(taskId: string, pid: number, at: string): Promise<void>;
  setTurnActive(
    taskId: string,
    pid: number,
    running: boolean,
    at: string,
  ): Promise<void>;
  reportOutcome(
    taskId: string,
    pid: number,
    status: "done" | "blocked",
    note: string | undefined,
    at: string,
  ): Promise<void>;
  end(taskId: string, pid: number, at: string): Promise<void>;
  read(taskId: string): Promise<PresenceRecord | undefined>;
  list(): Promise<PresenceRecord[]>;
  acknowledge(taskId: string): Promise<void>;
  markNotified(taskId: string): Promise<void>;
  clear(taskId: string): Promise<void>;
}

/**
 * Resource Access over harness session files (Pi's append-only JSONL
 * transcripts). Core never parses or creates them — the harness owns their
 * format — it only needs to know whether a recorded file is still there
 * before asking the harness to resume or fork it.
 */
export interface SessionFileAccess {
  exists(sessionPath: string): Promise<boolean>;
}

/**
 * Resource Access for a `launchTask` `{ none: true }` task's scratch
 * workspace: a plain directory (never a git worktree) that stands in for a
 * worktree so the app's existing "launch pi when a binding has
 * `worktreePath`" path works unchanged.
 */
export interface ScratchWorkspaceAccess {
  /** Create (idempotently) `<stateDir>/scratch/<taskId>` and return its absolute path. */
  ensureScratchDirectory(taskId: string): Promise<string>;
}

/** Per-user global configuration storage. */
export interface ConfigAccess {
  load(): Promise<GlobalConfig>;
  save(config: GlobalConfig): Promise<void>;
}

export interface Clock {
  now(): Date;
}
export interface IdGenerator {
  next(): string;
}
