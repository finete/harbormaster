// Engine: pure mapping from pi-home's on-disk shapes to Harbormaster
// `Task`/`WorkspaceBinding` pairs. No I/O (see /ai/prds/architecture.md) —
// everything volatile (file reads, `bd` shelling-out, worktree existence
// probes) is resolved by the manager first and handed in as plain data, so
// this module is trivial to unit-test against fixtures.

import { normalizeRemoteIdentity } from "../../access/git-repository-access.js";
import type { Task, WorkspaceBinding } from "../../contracts/model.js";
import type {
  BeadsIssue,
  MigrationItemResult,
  PiHomeRepositoryRef,
  PiHomeState,
  PiHomeTemporaryWorkspace,
  PiHomeWorkspaceBinding,
} from "../contracts.js";
import {
  mapAwaitingKind,
  mapPullRequest,
  normalizeBeadsStatus,
} from "./pihome-status-mapping.js";

export interface MigrationCandidate {
  task: Task;
  /** Absent for Beads issues that never had a pi-home workspace (pure backlog ideas, long-cleaned tasks). */
  binding?: WorkspaceBinding;
}

export interface MigrationPlan {
  toImport: MigrationCandidate[];
  results: MigrationItemResult[];
}

export interface PlanMigrationInput {
  piHome: PiHomeState;
  /** Keyed by Beads issue id. */
  beadsIssuesById: Map<string, BeadsIssue>;
  /** `Task.pihomeIssueId` values already present in Harbormaster's task store. */
  alreadyImported: ReadonlySet<string>;
  /** Pre-resolved on-disk existence of every pi-home worktree path this plan references. */
  worktreeExists: ReadonlyMap<string, boolean>;
  nextId: () => string;
}

const TEMP_TITLE_SUFFIX = " [temp]";

export function planMigration(input: PlanMigrationInput): MigrationPlan {
  const toImport: MigrationCandidate[] = [];
  const results: MigrationItemResult[] = [];

  for (const binding of input.piHome.workspaceBindings) {
    const result = planPermanentTask(binding, input);
    results.push(result.result);
    if (result.candidate) toImport.push(result.candidate);
  }

  for (const workspace of input.piHome.temporaryWorkspaces) {
    const result = planTemporaryTask(workspace, input);
    results.push(result.result);
    if (result.candidate) toImport.push(result.candidate);
  }

  // Beads issues with no workspace binding at all: pure backlog ideas and
  // tasks whose binding was cleaned up long ago. They still belong on the
  // board; they just arrive without a workspace or session.
  const boundIssueIds = new Set(
    input.piHome.workspaceBindings.map((binding) => binding.issueId),
  );
  for (const issue of input.beadsIssuesById.values()) {
    if (boundIssueIds.has(issue.id)) continue;
    const result = planBindinglessIssue(issue, input);
    results.push(result.result);
    if (result.candidate) toImport.push(result.candidate);
  }

  return { toImport, results };
}

function planPermanentTask(
  binding: PiHomeWorkspaceBinding,
  input: PlanMigrationInput,
): { candidate?: MigrationCandidate; result: MigrationItemResult } {
  const marker = binding.issueId;
  if (input.alreadyImported.has(marker)) {
    return {
      result: {
        pihomeIssueId: marker,
        title: binding.issueId,
        status: "skipped",
        reason: "already imported (pihomeIssueId matches an existing task)",
      },
    };
  }

  const issue = input.beadsIssuesById.get(binding.issueId);
  if (!issue) {
    return {
      result: {
        pihomeIssueId: marker,
        title: binding.issueId,
        status: "warning",
        reason: `no Beads issue found for ${binding.issueId} — title/state live in Beads; skipped`,
      },
    };
  }

  let normalized: ReturnType<typeof normalizeBeadsStatus>;
  try {
    normalized = normalizeBeadsStatus(issue.status);
  } catch (error) {
    return {
      result: {
        pihomeIssueId: marker,
        title: issue.title,
        status: "warning",
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const repositoryId = normalizeRepository(binding.repository);
  const worktreePath =
    binding.worktreePath && input.worktreeExists.get(binding.worktreePath)
      ? binding.worktreePath
      : undefined;

  const id = input.nextId();
  const pr = mapPullRequest(binding.pullRequest);
  const task: Task = {
    id,
    kind: "task",
    state: normalized.state,
    title: issue.title,
    initialPrompt: issue.description,
    repositoryId,
    ...(binding.branch ? { branch: binding.branch } : {}),
    targetBranch: binding.repository.defaultBranch,
    ...(pr ? { pr } : {}),
    ...(normalized.state === "awaiting" && normalized.awaitingKind
      ? { awaiting: mapAwaitingKind(normalized.awaitingKind, binding.awaiting) }
      : {}),
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
    stateChangedAt: binding.updatedAt,
    ...(binding.completedAt ? { completedAt: binding.completedAt } : {}),
    ...(binding.archivedAt ? { archivedAt: binding.archivedAt } : {}),
    pihomeIssueId: marker,
  };

  const bindingOut: WorkspaceBinding = {
    id: input.nextId(),
    taskId: id,
    ...workspaceFields(worktreePath, binding.branch),
    sessionPath: binding.sessionPath,
    ...(binding.previousSessionPath
      ? { previousSessionPath: binding.previousSessionPath }
      : {}),
    detached: false,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };

  return {
    candidate: { task, binding: bindingOut },
    result: { pihomeIssueId: marker, title: issue.title, status: "imported" },
  };
}

/** Only the worktree/branch pair, and only when a verified worktree path is present. */
function workspaceFields(
  worktreePath: string | undefined,
  branch: string | undefined,
): Pick<WorkspaceBinding, "worktreePath" | "branch"> {
  if (!worktreePath) return {};
  return branch ? { worktreePath, branch } : { worktreePath };
}

function planTemporaryTask(
  workspace: PiHomeTemporaryWorkspace,
  input: PlanMigrationInput,
): { candidate?: MigrationCandidate; result: MigrationItemResult } {
  const marker = workspace.id;
  if (input.alreadyImported.has(marker)) {
    return {
      result: {
        pihomeIssueId: marker,
        title: workspace.title,
        status: "skipped",
        reason: "already imported (pihomeIssueId matches an existing task)",
      },
    };
  }

  const repositoryId = workspace.repository
    ? normalizeRepository(workspace.repository)
    : undefined;
  const worktreePath =
    workspace.worktreePath && input.worktreeExists.get(workspace.worktreePath)
      ? workspace.worktreePath
      : undefined;

  let awaitingKindForState: ReturnType<
    typeof normalizeBeadsStatus
  >["awaitingKind"];
  if (workspace.state === "awaiting" && workspace.awaiting) {
    awaitingKindForState =
      workspace.awaiting.kind === "production"
        ? "deploy"
        : workspace.awaiting.kind;
  }

  const id = input.nextId();
  const pr = mapPullRequest(workspace.pullRequest);
  const task: Task = {
    id,
    kind: "task",
    state: workspace.state,
    title: `${workspace.title}${TEMP_TITLE_SUFFIX}`,
    initialPrompt: workspace.initialPrompt,
    ...(repositoryId ? { repositoryId } : {}),
    ...(workspace.branch ? { branch: workspace.branch } : {}),
    ...(workspace.repository
      ? { targetBranch: workspace.repository.defaultBranch }
      : {}),
    ...(pr ? { pr } : {}),
    ...(workspace.state === "awaiting" && awaitingKindForState
      ? { awaiting: mapAwaitingKind(awaitingKindForState, workspace.awaiting) }
      : {}),
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    stateChangedAt: workspace.stateChangedAt,
    ...(workspace.completedAt ? { completedAt: workspace.completedAt } : {}),
    ...(workspace.archivedAt ? { archivedAt: workspace.archivedAt } : {}),
    pihomeIssueId: marker,
  };

  const bindingOut: WorkspaceBinding = {
    id: input.nextId(),
    taskId: id,
    ...workspaceFields(worktreePath, workspace.branch),
    sessionPath: workspace.sessionPath,
    ...(workspace.previousSessionPath
      ? { previousSessionPath: workspace.previousSessionPath }
      : {}),
    detached: false,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };

  return {
    candidate: { task, binding: bindingOut },
    result: {
      pihomeIssueId: marker,
      title: task.title,
      status: "imported",
    },
  };
}

function normalizeRepository(repository: PiHomeRepositoryRef): string {
  return repository.remote
    ? normalizeRemoteIdentity(repository.remote)
    : repository.id;
}

function planBindinglessIssue(
  issue: BeadsIssue,
  input: PlanMigrationInput,
): { candidate?: MigrationCandidate; result: MigrationItemResult } {
  if (input.alreadyImported.has(issue.id)) {
    return {
      result: {
        pihomeIssueId: issue.id,
        title: issue.title,
        status: "skipped",
        reason: "already imported (pihomeIssueId matches an existing task)",
      },
    };
  }
  let normalized: ReturnType<typeof normalizeBeadsStatus>;
  try {
    normalized = normalizeBeadsStatus(issue.status);
  } catch (error) {
    return {
      result: {
        pihomeIssueId: issue.id,
        title: issue.title,
        status: "warning",
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
  const task: Task = {
    id: input.nextId(),
    kind: "task",
    title: issue.title,
    initialPrompt: issue.description,
    state: normalized.state,
    ...(normalized.state === "awaiting" && normalized.awaitingKind
      ? { awaiting: mapAwaitingKind(normalized.awaitingKind, undefined) }
      : {}),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    stateChangedAt: issue.updatedAt,
    ...(issue.closedAt ? { completedAt: issue.closedAt } : {}),
    pihomeIssueId: issue.id,
  };
  return {
    candidate: { task },
    result: {
      pihomeIssueId: issue.id,
      title: issue.title,
      status: "imported",
      reason: "no pi-home workspace binding — imported without a workspace",
    },
  };
}
