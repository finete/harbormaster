// Mover contracts — the board-automation boundary ("movers tick only in the
// app", see /docs/design-decisions.md). Ported and pruned from pi-home's
// src/contracts/addons.ts: no user-addon loading in this phase (no
// AddonModule/AddonRegistry), just the two built-in movers and the one
// built-in stage hook wired through a fixed registry (see
// engines/movers/index.ts). The shapes stay identical so a user-addon
// loading path can slot in later without changing the mover contract.

import type {
  AwaitingKind,
  DeploymentPipeline,
  TaskKind,
  TaskPullRequest,
  TaskState,
} from "../../../src/contracts/model.js";

/** Everything a stage hook may know about the task whose wait it checks. */
export interface StageHookInput {
  repositoryId: string;
  /** The squash/merge commit that entered the destination branch, once known. */
  commit?: { oid: string; targetBranch: string };
  pullRequest?: { number: number; url?: string };
  /** The task's working branch; hotfix subjects conventionally embed it. */
  branch?: string;
  stage: { id: string; label: string };
  /** Opaque per-stage options from the global config. */
  options: Record<string, unknown>;
}

export interface StageHookResult {
  satisfied: boolean;
  detail?: string;
}

/**
 * I/O helpers injected into every hook so built-in hooks share the same
 * cached transports instead of opening their own connections.
 */
export interface StageHookHelpers {
  /** GET a small text document; cached ~5 minutes per URL. */
  fetchText(url: string): Promise<string>;
  /** Whether ancestorOid is contained in descendantOid on GitHub (memoized). */
  containsCommit(ancestorOid: string, descendantOid: string): Promise<boolean>;
  /** Newest-first commits reachable from startOid (memoized; limit capped at 100). */
  commitLog(startOid: string, limit: number): Promise<CommitLogEntry[]>;
}

/** One commit reachable from a fixed starting commit. */
export interface CommitLogEntry {
  oid: string;
  subject: string;
}

/**
 * One unit of "is this wait over?" logic. A thrown error means "unknown",
 * never "satisfied": the task stays put.
 */
export interface StageHook {
  check(
    input: StageHookInput,
    helpers: StageHookHelpers,
  ): Promise<StageHookResult>;
}

/**
 * One automatic movement on the board. Movers only propose these; the
 * manager knows how to execute each one via `moveTask`/`toDone`.
 */
export type BoardMove =
  | { type: "stay" }
  | { type: "dev" }
  | { type: "review" }
  | { type: "deploy"; stageId: string; stageLabel: string }
  | { type: "done" };

/** Read-only task snapshot offered to movers. */
export interface MoverTaskView {
  id: string;
  kind: TaskKind;
  state: TaskState;
  awaiting?: AwaitingKind;
  branch?: string;
  repositoryId?: string;
  pr?: TaskPullRequest;
}

export interface MoverInput {
  task: MoverTaskView;
  /** The task repository's configured deployment pipeline, when present. */
  pipeline?: DeploymentPipeline;
}

export interface MoverHelpers extends StageHookHelpers {
  /** Run a registered stage hook by name; unknown names throw. */
  runHook(name: string, input: StageHookInput): Promise<StageHookResult>;
}

/**
 * One unit of movement logic. Active movers run in configured order each
 * refresh; the first legal non-stay move wins, so a task moves at most one
 * step per refresh. A thrown error means "stay" plus a warning.
 */
export interface TaskMover {
  decide(input: MoverInput, helpers: MoverHelpers): Promise<BoardMove>;
}

/** Active movers, in order. */
export const DEFAULT_MOVER_ORDER: readonly string[] = Object.freeze([
  "github-review",
  "deployment-pipeline",
]);
