import type { PresenceRecord } from "../contracts/model.js";

// Shapes this module reads from pi-home's on-disk state, kept separate from
// Harbormaster's own `contracts/model.ts` so a name collision (both have a
// `WorkspaceBinding`, for instance) never becomes ambiguous at an import
// site. These are intentionally lenient subsets of pi-home's
// `src/contracts/model.ts` (v4 state) — the migration tool reads pi-home
// read-only and only needs the fields it maps, not full-fidelity round-trip
// validation of a program it does not own.

/** pi-home's per-repository identity, as stored on a binding/workspace. */
export interface PiHomeRepositoryRef {
  id: string;
  name: string;
  remote?: string;
  preferredCheckout: string;
  defaultBranch: string;
}

export interface PiHomePullRequestMeta {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft?: boolean;
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
  changesRequestedOnHead?: boolean;
  humanFeedbackOnHead?: boolean;
  reviewRequested?: boolean;
  reviewSubmitted?: boolean;
  headRefOid?: string;
  mergeCommit?: { oid: string; url?: string; targetBranch?: string };
  checkedAt?: string;
}

export interface PiHomeDeploymentStageRef {
  id: string;
  label: string;
}

export type PiHomeAwaitingContext =
  | {
      kind: "review";
      since: string;
      pullRequest?: { number: number; url: string };
    }
  | { kind: "slack"; since: string; url: string }
  | {
      kind: "production";
      since: string;
      stage?: PiHomeDeploymentStageRef;
      commit?: { oid: string; url?: string; targetBranch: string };
      pullRequest?: { number: number; url: string };
    };

/** Common fields shared by `RetainedWorkspaceBinding` and `SessionOnlyParkedBinding`. */
export interface PiHomeWorkspaceBinding {
  id: string;
  issueId: string;
  repository: PiHomeRepositoryRef;
  /** Absent for a `parking: "session_only"` binding (no live workspace). */
  worktreePath?: string;
  branch?: string;
  parking?: "retained" | "session_only";
  sessionPath: string;
  previousSessionPath?: string;
  pullRequest?: PiHomePullRequestMeta;
  awaiting?: PiHomeAwaitingContext;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  archivedAt?: string;
  lastError?: string;
}

/** Local-only scratch work that was never promoted to a Beads issue. */
export interface PiHomeTemporaryWorkspace {
  id: string;
  kind: "temp_task";
  state: "dev" | "awaiting" | "done";
  title: string;
  initialPrompt: string;
  repository?: PiHomeRepositoryRef;
  worktreePath?: string;
  branch?: string;
  sessionPath: string;
  previousSessionPath?: string;
  pullRequest?: PiHomePullRequestMeta;
  awaiting?: PiHomeAwaitingContext;
  createdAt: string;
  updatedAt: string;
  stateChangedAt: string;
  completedAt?: string;
  archivedAt?: string;
  lastError?: string;
}

export interface PiHomeState {
  version: number;
  workspaceBindings: PiHomeWorkspaceBinding[];
  temporaryWorkspaces: PiHomeTemporaryWorkspace[];
}

/** The slice of one `bd list --all --json` / `bd show <id> --json` issue this tool reads. */
export interface BeadsIssue {
  id: string;
  title: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  piHomeTaskId?: string;
}

export interface MigrationOptions {
  /** `~/.pi/agent/pi-home` by default. */
  piHomeDir: string;
  /** `~/.harbormaster` by default. */
  stateDir: string;
  /** Default `false`: report what would happen without writing anything. */
  apply: boolean;
  /** Bypass the live-presence refusal (the user has confirmed those panes are fine to leave be). */
  force: boolean;
}

export type MigrationItemStatus = "imported" | "skipped" | "warning";

export interface MigrationItemResult {
  /** pi-home issue id (permanent tasks) or temporary-workspace id (scratch tasks). */
  pihomeIssueId: string;
  title: string;
  status: MigrationItemStatus;
  reason?: string;
}

export interface MigrationReport {
  /** True when nothing was written (either a dry run, or `--apply` was requested but refused). */
  dryRun: boolean;
  imported: MigrationItemResult[];
  skipped: MigrationItemResult[];
  warnings: string[];
  /** Live pi-home presence records that blocked `--apply` (empty unless refused for that reason). */
  livePresenceBlocking: PresenceRecord[];
  /** Whether this run flipped `automation: false` in pi-home's config.json. */
  automationDisabledInPiHome: boolean;
}
