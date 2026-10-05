// Domain model — phase 1 (foundation only). Ported and heavily pruned from
// pi-home's src/contracts/model.ts: no Beads issues, no PRs, no deployment
// pipelines, no cmux. Those return in later phases behind the same shapes
// where it makes sense.

export const STATE_VERSION = 1 as const;

/** Permanent, repository-backed work vs. local-only scratch work. */
export type TaskKind = "task" | "temp_task";

/** Board column a task currently sits in. */
export type TaskState = "backlog" | "dev" | "awaiting" | "done";

/** Ordered list of board columns; the source of truth for board layout. */
export const TASK_STATES: readonly TaskState[] = [
  "backlog",
  "dev",
  "awaiting",
  "done",
];

/**
 * One unit of work on the board. Permanent (`"task"`) and scratch
 * (`"temp_task"`) work share a shape in phase 1; pi-home's richer
 * WorkspaceBinding/TemporaryWorkspace split (issue linkage, PR state,
 * deployment awaiting context, completion cleanup bookkeeping) returns in
 * later phases once git/GitHub access is ported.
 */
export interface Task {
  id: string;
  kind: TaskKind;
  state: TaskState;
  title: string;
  initialPrompt: string;
  /** Opaque repository identity; resolved against git access in a later phase. */
  repositoryId?: string;
  createdAt: string;
  updatedAt: string;
  stateChangedAt: string;
  completedAt?: string;
  archivedAt?: string;
  lastError?: string;
}

/** Manager-composed, never persisted: one board column and its tasks in order. */
export interface BoardColumn {
  state: TaskState;
  title: string;
  tasks: Task[];
}

/**
 * Seam for the workspace a task runs in (worktree/branch/session). Phase 1
 * stores and round-trips these records but nothing yet populates them —
 * git-worktree and Pi-session access are phase 2.
 */
export interface WorkspaceBinding {
  id: string;
  taskId: string;
  worktreePath?: string;
  branch?: string;
  sessionPath?: string;
  detached: boolean;
  createdAt: string;
  updatedAt: string;
}

/** How an agent process is attached to a task's session. */
export type PresenceMode = "interactive" | "headless";

/** Terminal outcome of one headless run, self-reported or implicit. */
export interface PresenceOutcome {
  status: "done" | "blocked" | "unreported";
  note?: string;
  at: string;
  /** One-shot toast already delivered for this outcome. */
  notified?: boolean;
}

/**
 * Liveness record for one agent process attached to a task session. Ported
 * from pi-home's presence registry with the Pi-specific `cmux` location
 * field dropped (cmux is gone; the app owns pane focus directly).
 */
export interface PresenceRecord {
  taskId: string;
  sessionPath: string;
  pid: number;
  mode: PresenceMode;
  startedAt: string;
  heartbeatAt: string;
  /** Runner log file for headless runs. */
  logPath?: string;
  /** Whether an agent turn is running right now. */
  runningTurn?: boolean;
  /** Present once the attachment ended; absence + fresh heartbeat = live. */
  ended?: PresenceOutcome;
}

/**
 * Global per-user configuration. Minimal in phase 1 — the mover/automation
 * fields are a placeholder seam for phase 2; nothing reads them yet.
 */
export interface GlobalConfig {
  /** Global kill switch for future addon-driven board moves. */
  automation: boolean;
  /** Ordered names of active movers; empty until movers exist (phase 2). */
  movers: string[];
}

export const defaultGlobalConfig = (): GlobalConfig => ({
  automation: true,
  movers: [],
});
