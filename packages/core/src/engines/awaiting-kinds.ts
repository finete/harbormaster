// Engine: the awaiting-kind registry. The board has exactly three workflow
// verbs (todev / toawait / todone, plus reopen); *why* a task is awaiting —
// a review, a Slack reply, a deployment — is data the one `toAwait` verb is
// parameterized with, not a verb of its own. Each kind is a declarative
// record (id, label, inputs) plus, optionally, an `onEnter` action that
// runs before the move (a throw aborts the move and leaves the task as it
// was). Ported from pi-home's per-kind workflow-manager entry points
// (`awaitReview` / `awaitSlack` / `awaitProduction`), reshaped so new kinds
// slot in as data rather than new commands.
//
// The registry itself is pure; `onEnter` actions reach external systems
// only through the Resource Access interfaces the Manager hands them
// (Engine → Access, per /ai/prds/architecture.md).

import type {
  AwaitingKindField,
  AwaitingKindOption,
} from "../contracts/commands.js";
import type {
  PullRequestAccess,
  PullRequestStatus,
} from "../contracts/github.js";
import type {
  AwaitingKind,
  AwaitingKindId,
  DeploymentStageConfig,
  Task,
} from "../contracts/model.js";
import type {
  GitWorktreeAccess,
  RepositoryInfo,
} from "../contracts/workspace.js";
import { firstStage, PRODUCTION_STAGE } from "./deployment.js";

/** What a kind's pure rules may know about the task's repository. */
export interface AwaitingKindEnvironment {
  /** The repository's effective deployment stages, in order (empty = no pipeline). */
  stages: readonly DeploymentStageConfig[];
}

/** Everything a kind's `onEnter` action may use. */
export interface AwaitingKindEnterContext extends AwaitingKindEnvironment {
  task: Task;
  /** Trimmed, non-blank input values keyed by field id. */
  inputs: Readonly<Record<string, string>>;
  /** The task's repository and bound worktree; rejects when the repository is unknown. */
  resolveWorkspace(): Promise<{ repo: RepositoryInfo; worktreePath?: string }>;
  worktrees: Pick<GitWorktreeAccess, "pushBranch">;
  pullRequests: Pick<
    PullRequestAccess,
    "ensureOpen" | "status" | "squashMerge"
  >;
}

/** What an `onEnter` action learned, to be stored with the move. */
export interface AwaitingKindEnterResult {
  /** Fresh pull-request status to store as `task.pr`. */
  pullRequest?: PullRequestStatus;
  /** Merge-target fallback for `pullRequest` (the repository default branch). */
  targetBranch?: string;
}

export interface AwaitingKindAssessment {
  available: boolean;
  reason?: string;
  notice?: string;
}

export interface AwaitingKindDefinition {
  id: AwaitingKindId;
  label: string;
  description: string;
  fields: readonly AwaitingKindField[];
  /** Pure: whether the kind applies to `task`, and what entering it will do. */
  assess(task: Task, env: AwaitingKindEnvironment): AwaitingKindAssessment;
  /** Pure: the awaiting record the task carries once entered. */
  awaitingFor(
    task: Task,
    inputs: Readonly<Record<string, string>>,
    env: AwaitingKindEnvironment,
  ): AwaitingKind;
  /** Optional side effect run before the move; a throw leaves the task unmoved. */
  onEnter?(context: AwaitingKindEnterContext): Promise<AwaitingKindEnterResult>;
}

const reviewKind: AwaitingKindDefinition = {
  id: "review",
  label: "Review",
  description: "Waiting on a pull-request review",
  fields: [],
  assess(task) {
    if (task.awaiting?.kind === "deploy") {
      return {
        available: false,
        reason: "its PR is already merged and awaiting deployment",
      };
    }
    if (task.repositoryId && !task.branch) {
      return { available: false, reason: "the task has no branch yet" };
    }
    return task.repositoryId
      ? {
          available: true,
          notice: `Pushes ${task.branch} and opens (or reuses) its pull request`,
        }
      : { available: true };
  },
  awaitingFor: () => ({ kind: "review" }),
  // pi-home's `awaitReview`: external preparation first (push, then open or
  // reuse the PR), so a GitHub failure leaves the task untouched. A
  // repository-less task has nothing to push and simply waits.
  async onEnter({ task, resolveWorkspace, worktrees, pullRequests }) {
    if (!task.repositoryId) return {};
    if (!task.branch) {
      throw new Error(
        `Review requires a repository-backed task with a branch: ${task.id}`,
      );
    }
    const { repo, worktreePath } = await resolveWorkspace();
    if (!repo.remoteUrl) {
      throw new Error(
        `Cannot open a pull request: ${repo.root} has no origin remote`,
      );
    }
    if (!worktreePath) {
      throw new Error(`No worktree bound for task: ${task.id}`);
    }
    await worktrees.pushBranch(worktreePath, task.branch);
    const targetBranch = task.targetBranch ?? repo.defaultBranch;
    const pullRequest = await pullRequests.ensureOpen(
      task.repositoryId,
      task.branch,
      worktreePath,
      task.title,
      task.initialPrompt,
      targetBranch,
    );
    return { pullRequest, targetBranch };
  },
};

const slackKind: AwaitingKindDefinition = {
  id: "slack",
  label: "Slack response",
  description: "Waiting on a reply in a Slack thread",
  fields: [
    {
      id: "permalink",
      label: "Slack permalink",
      placeholder: "https://…slack.com/archives/…",
      optional: true,
    },
  ],
  assess: () => ({ available: true }),
  // No Slack API access: the permalink is stored, never queried.
  awaitingFor: (_task, inputs) => ({
    kind: "slack",
    ...(inputs.permalink ? { permalink: inputs.permalink } : {}),
  }),
};

/** The first configured stage, or the stage-less production wait. */
function entryStage(env: AwaitingKindEnvironment): DeploymentStageConfig {
  return firstStage(env.stages) ?? PRODUCTION_STAGE;
}

const deployKind: AwaitingKindDefinition = {
  id: "deploy",
  label: "Deployment",
  description: "Merged; waiting for the change to roll out",
  fields: [],
  assess(task, env) {
    if (!task.repositoryId || !task.branch) {
      return {
        available: false,
        reason: "it needs a repository-backed task with a pull request",
      };
    }
    if (task.awaiting?.kind === "deploy") {
      return { available: false, reason: "it is already awaiting deployment" };
    }
    if (task.pr?.state === "closed") {
      return {
        available: false,
        reason: `PR #${task.pr.number} is closed without merging`,
      };
    }
    const stage = entryStage(env);
    const where =
      stage.id === PRODUCTION_STAGE.id
        ? `(${stage.label})`
        : `(first stage: ${stage.label})`;
    if (task.pr?.state === "merged") {
      return {
        available: true,
        notice: `PR #${task.pr.number} is merged; enters the deployment pipeline ${where}`,
      };
    }
    return {
      available: true,
      notice: task.pr
        ? `Squash-merges PR #${task.pr.number} and enters the deployment pipeline ${where}`
        : `Squash-merges the task's PR and enters the deployment pipeline ${where}`,
    };
  },
  awaitingFor: (_task, _inputs, env) => {
    const stage = entryStage(env);
    return { kind: "deploy", stageId: stage.id, stageLabel: stage.label };
  },
  // pi-home's `/towaitprod` (`awaitProduction`): merge a still-open PR
  // (squash), refuse anything not merged afterwards, then wait at the
  // pipeline's entry stage. Stage hooks/movers take it from there.
  async onEnter({ task, resolveWorkspace, pullRequests }) {
    if (!task.repositoryId || !task.branch) {
      throw new Error(
        `Deployment requires a repository-backed task with a branch: ${task.id}`,
      );
    }
    const { repo } = await resolveWorkspace();
    if (!repo.remoteUrl) {
      throw new Error(
        `Cannot merge a pull request: ${repo.root} has no origin remote`,
      );
    }
    const targetBranch = task.targetBranch ?? repo.defaultBranch;
    const fresh = await pullRequests.status(task.repositoryId, task.branch);
    const number = fresh?.number ?? task.pr?.number;
    if (number === undefined) {
      throw new Error("Task has no pull request to merge");
    }
    const open = fresh
      ? fresh.state === "OPEN"
      : task.pr?.state === "open" || task.pr?.state === "draft";
    if (open) {
      const merged = await pullRequests.squashMerge(
        task.repositoryId,
        number,
        task.branch,
      );
      return { pullRequest: merged, targetBranch };
    }
    const merged = fresh
      ? fresh.state === "MERGED"
      : task.pr?.state === "merged";
    if (!merged) throw new Error(`Pull request #${number} is not mergeable`);
    return fresh ? { pullRequest: fresh, targetBranch } : {};
  },
};

/** Built-in awaiting kinds, in picker order; the first is the default. */
export const builtinAwaitingKinds: readonly AwaitingKindDefinition[] =
  Object.freeze([reviewKind, slackKind, deployKind]);

/** The kind a picker preselects (the fast path). */
export const DEFAULT_AWAITING_KIND_ID: AwaitingKindId = "review";

export function findAwaitingKind(
  id: string,
  registry: readonly AwaitingKindDefinition[] = builtinAwaitingKinds,
): AwaitingKindDefinition | undefined {
  return registry.find((kind) => kind.id === id);
}

/** Trim inputs to the kind's declared fields, dropping blanks. */
export function normalizeAwaitingInputs(
  kind: AwaitingKindDefinition,
  inputs: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const field of kind.fields) {
    const value = inputs?.[field.id]?.trim();
    if (value) normalized[field.id] = value;
  }
  return normalized;
}

/** A kind as a picker shows it for `task` (or unresolved, without one). */
export function describeAwaitingKind(
  kind: AwaitingKindDefinition,
  task: Task | undefined,
  env: AwaitingKindEnvironment,
): AwaitingKindOption {
  const assessment: AwaitingKindAssessment = task
    ? kind.assess(task, env)
    : { available: true };
  return {
    id: kind.id,
    label: kind.label,
    description: kind.description,
    fields: kind.fields.map((field) => ({ ...field })),
    available: assessment.available,
    ...(assessment.reason ? { unavailableReason: assessment.reason } : {}),
    ...(assessment.notice ? { notice: assessment.notice } : {}),
  };
}
