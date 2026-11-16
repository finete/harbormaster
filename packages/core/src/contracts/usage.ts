// Per-task token usage (docs/costs.md). Tokens are the primary figure; `$`
// appears only when the harness itself wrote a cost into its transcript
// (Pi does, Claude Code does not). Adapters parse one session file into a
// `SessionUsage`; core sums a task's sessions into the persisted
// `TaskUsage` (engines/usage.ts) and frontends only read task state.

import type { TaskState } from "./model.js";

export interface TokenBuckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelUsage extends TokenBuckets {
  /** Harness-reported id, e.g. `"claude-opus-5-5"`. */
  model: string;
  /** Assistant turns attributed to this model. */
  turns: number;
  /** USD, only when the harness wrote it. */
  cost?: number;
}

/** What an adapter returns for one session file. */
export interface SessionUsage {
  sessionPath: string;
  /** Everything the file records, including a forked session's copied prefix (see `forkedFrom`). */
  byModel: ModelUsage[];
  /**
   * Set when this session was forked from another: usage up to `turns` of
   * `sessionPath` is already counted there.
   */
  forkedFrom?: {
    sessionPath: string;
    turns: number;
    /**
     * The copied prefix's usage per model (those `turns`, as recorded in
     * this file), which core subtracts from `byModel`: copied turns were
     * spent by the parent session, not this one. Absent = nothing to
     * subtract (the adapter could not tell the prefix apart).
     */
    prefix?: ModelUsage[];
  };
  /** Harness that priced `cost` (label source), e.g. `"pi"`. Absent when no cost. */
  costSource?: string;
}

/** Persisted on the task (`Task.usage`). */
export interface TaskUsage {
  status: "ready" | "unavailable" | "pending";
  /** Why unavailable: harness has no reader, or session files are gone. */
  reason?: "unsupported" | "missing-session";
  totals: TokenBuckets & { turns: number };
  byModel: ModelUsage[];
  sessions: Array<{
    sessionPath: string;
    harness: string;
    totals: TokenBuckets;
    cost?: number;
  }>;
  /** Sum of `cost` across sessions, only if every priced session had one. */
  cost?: number;
  costSource?: string;
  /** When this figure was computed (not when the spend happened: see `lastActivityAt`). */
  computedAt: string;
  /**
   * When the spend last happened: the newest modification time among the
   * task's session files (ISO), read from the same file stats as
   * `fingerprint`. The Costs range filter uses it. Absent when the files
   * could not be stat'ed (or on a placeholder); a `ready` usage persisted
   * before this field existed gains it on its next recompute (no re-parse
   * when the files are unchanged).
   */
  lastActivityAt?: string;
  /**
   * Core-internal change detector: the session files' size/mtime when this
   * was computed, so an unchanged session is never re-parsed. Opaque to
   * frontends.
   */
  fingerprint?: string;
}

/** `CoreCommands.listTaskUsage` filters; every field optional. */
export interface TaskUsageQuery {
  /** ISO time or `YYYY-MM-DD` (inclusive), compared with the row's activity time (`usage.lastActivityAt`, else `completedAt`, else `updatedAt`). */
  from?: string;
  /** ISO time or `YYYY-MM-DD` (inclusive: a date means the whole day, UTC). */
  to?: string;
  /** Exact `Task.repositoryId` (or `folderPath` for a folder task). */
  repository?: string;
  /** Harness id (`Task.harness`, default `"pi"`). */
  harness?: string;
  /** Keep tasks that used this model (any of `usage.byModel`). */
  model?: string;
  /** Include archived tasks (`archivedAt`); default `false`. */
  includeArchived?: boolean;
}

/** Subtasks' (`parentTaskId`) usage rolled up onto their parent's row. */
export type SubtaskUsage = TokenBuckets & { count: number; cost?: number };

/** One `listTaskUsage` row (the Costs table / CSV export / `harbormaster usage --json`). */
export interface TaskUsageRow {
  taskId: string;
  title: string;
  /** `Task.repositoryId`, else the folder path, else `""` (a scratch task). */
  repository: string;
  harness: string;
  state: TaskState;
  completedAt?: string;
  usage: TaskUsage;
  /** Present on a parent whose children (`parentTaskId`) have ready usage. */
  subtaskUsage?: SubtaskUsage;
}
