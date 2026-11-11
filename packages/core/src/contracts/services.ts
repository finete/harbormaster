// Service interfaces — the call-chain boundary between Manager/Engine and
// Resource Access (see /docs/design-decisions.md "Layering"). Managers and Engines only
// ever see these interfaces; concrete file-backed implementations live in
// access/.

import type {
  MessageAttachment,
  MessageMode,
  MessageStoreSnapshot,
  TaskMessage,
} from "./messaging.js";
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
  /**
   * Atomically replace the task's record with `next(current)` (serialized
   * with every other mutation): the write path for program-status reports,
   * whose register-or-update decision is a pure rule
   * (`applyProgramStatus`). Resolves the record written.
   */
  applyReport(
    taskId: string,
    next: (current: PresenceRecord | undefined) => PresenceRecord,
  ): Promise<PresenceRecord>;
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

/**
 * Resource Access for user folders registered outside `codeRoot` (the
 * composer's `Open folder…`; see `/docs/new-task-composer.md` "Where"). The
 * registry is core state (`<stateDir>/locations.json`), so every client and
 * the agent launch tool see the same list.
 */
export interface FolderAccess {
  /** Registered folder paths, in registration order. */
  listRegisteredFolders(): Promise<string[]>;
  /** Realpath-resolve `path`, require an existing directory, and register it (idempotent). Returns the resolved path. */
  registerFolder(path: string): Promise<string>;
  /** Whether `path` is an existing directory. Never throws. */
  isDirectory(path: string): Promise<boolean>;
}

/** Resource Access for images pasted into a task's prompt. */
export interface TaskAttachmentAccess {
  /**
   * Copy each file into `<stateDir>/task-attachments/<taskId>/` and return
   * original path -> copy path. Files that cannot be read are left out.
   */
  copyIntoTask(taskId: string, paths: string[]): Promise<Map<string, string>>;
}

/** Options for {@link MessageAccess.recordMessage}. */
export interface RecordMessageOptions {
  /**
   * Runs under the message-store lock against the store as it is right
   * before the append; throwing rejects the message without writing. This is
   * how the Manager makes rules that depend on the log (the loop cap) atomic
   * with the append.
   */
  precondition?: (store: MessageStoreSnapshot) => void;
}

/** Input to {@link MessageAccess.claimDeliverable}. */
export interface ClaimDeliverableInput {
  /** `false`: only `steer` messages are claimed; `followUp` ones stay pending. */
  idle: boolean;
  /** Stamped as `deliveredAt`. */
  deliveredAt: string;
  /** Maps a message's requested mode to the mode the harness will actually use (stamped as `deliveredMode`). */
  resolveMode: (requested: MessageMode) => MessageMode;
}

export interface ApproveMessageInput {
  approvedAt: string;
  /** Replaces the text (the original is kept as `originalText`). */
  text?: string;
  /** Replaces the requested mode. */
  mode?: MessageMode;
}

/**
 * Durable task-message storage plus the on-disk attachment copies and the
 * cross-process inbox doorbell (see `/docs/task-messaging.md`). Exposes
 * atomic business verbs, never raw CRUD: every mutation is one
 * read-modify-write under the store lock.
 */
export interface MessageAccess {
  /** A read-only copy of the whole store. */
  readStore(): Promise<MessageStoreSnapshot>;
  getMessage(id: string): Promise<TaskMessage | undefined>;
  /** Messages oldest first; `taskId` keeps those sent to or by that task. */
  listMessages(filter?: { taskId?: string }): Promise<TaskMessage[]>;
  /** Append a message (status `pending` or `awaiting_approval`; ids are unique). Rings the target's doorbell when it is deliverable. */
  recordMessage(
    message: TaskMessage,
    options?: RecordMessageOptions,
  ): Promise<void>;
  /** `awaiting_approval` → `pending`, applying the user's edits; rings the target's doorbell. Rejects any other status. */
  approveMessage(id: string, input: ApproveMessageInput): Promise<TaskMessage>;
  /** `awaiting_approval` → `rejected`. Rejects any other status. */
  rejectMessage(id: string, rejectedAt: string): Promise<TaskMessage>;
  /**
   * `awaiting_approval`/`pending` → `failed` with a reason; a message in any
   * other status is returned untouched. Resolves to the message as stored
   * (`undefined` when unknown).
   */
  failMessage(
    id: string,
    failedAt: string,
    reason: string,
  ): Promise<TaskMessage | undefined>;
  /** Fails every `pending` message addressed to `taskId`; returns them. */
  failPendingForTask(
    taskId: string,
    failedAt: string,
    reason: string,
  ): Promise<TaskMessage[]>;
  /**
   * Atomically marks the task's deliverable `pending` messages delivered
   * (oldest first) and returns them, so two concurrent claimers never get the
   * same message. `steer` messages are claimed any time, `followUp` only when
   * `input.idle`.
   */
  claimDeliverable(
    taskId: string,
    input: ClaimDeliverableInput,
  ): Promise<TaskMessage[]>;
  /** Target task ids that have `pending` messages. */
  listPendingTargets(): Promise<string[]>;
  /** The user typed into the task's session at `at`. */
  recordUserInput(taskId: string, at: string): Promise<void>;
  /** Stamp `prunedAt` on every attachment of a message (the files are removed by `removeAttachments`). */
  markAttachmentsPruned(id: string, prunedAt: string): Promise<void>;
  /**
   * Validate and copy files into `<messages>/attachments/<messageId>/`
   * (absolute, existing, regular, ≤ 10 MB each, ≤ 8 files).
   */
  copyAttachments(
    messageId: string,
    paths: readonly string[],
  ): Promise<MessageAttachment[]>;
  /** The bytes of a stored copy as base64; rejects paths outside the attachment store and pruned files. */
  readAttachment(attachment: MessageAttachment): Promise<string>;
  /** Delete a message's attachment copies (idempotent). */
  removeAttachments(messageId: string): Promise<void>;
  /** Cross-process doorbell: `listener` fires when the task's deliverable inbox changes; returns unsubscribe. Never throws; a no-op unsubscribe when watching is impossible. */
  watchDoorbell(taskId: string, listener: () => void): () => void;
}

/** Per-user global configuration storage. */
export interface ConfigAccess {
  load(): Promise<GlobalConfig>;
  save(config: GlobalConfig): Promise<void>;
  /**
   * The retired `movers` lists of a pre-rules config, for migrating them
   * into the first `rules.yaml` (optional: hand-built fakes may omit it).
   */
  legacyMoverOrders?(): Promise<LegacyMoverOrders>;
}

/** Pre-rules `movers` config lists (global and per repository). */
export interface LegacyMoverOrders {
  global?: string[];
  repositories: Record<string, string[]>;
}

export interface Clock {
  now(): Date;
}
export interface IdGenerator {
  next(): string;
}
