// Built-in source `version-endpoint` (ported from the retired
// version-endpoint stage hook + the deployment-pipeline mover's scan). A
// deployment stage configured with `hook: version-endpoint` and
// `options.url` exposes a document like `v0.115.20+ca9bdff2`; the stage is
// deployed for a task when the task's merge commit is an ancestor of the
// deployed commit after `+`, or — because release-branch hotfixes are
// cherry-picks with rewritten SHAs — when a commit contained in the
// deployment references the task's branch or PR number in its subject
// (`options.hotfixScan: false` disables the scan, `options.hotfixDepth`
// bounds it, 1-100 commits, default 100).
//
// Facts, per task awaiting a hooked stage (subject `task/<id>`, entity
// `deployment` → `version-endpoint.deployment.*`): `stageId` (the stage it
// waits at), `satisfiedStageId` (furthest consecutive hooked stage already
// deployed, scanning back to the current one — deployments can reach a
// later environment first), `next` (the stage to enter after it, or null)
// and `land` (deployed past the last stage). A hookless (manual) stage is
// a gate the scan never crosses. Per stage (subject
// `repo/<id>/stage/<stage>`, entity `stage`): the deployed `commit` and
// `version`, refreshed whenever a task needed that stage's document.

import type {
  RuleRepoView,
  RuleStageView,
  RuleTaskView,
  Snapshot,
  Source,
  SourceContext,
} from "../../contracts/rules.js";
import {
  commitReferencesTask,
  type DeployedVersion,
  parseDeployedVersion,
} from "../deployment.js";
import { taskSubject } from "../rules/snapshot-diff.js";

export const VERSION_ENDPOINT_SOURCE_ID = "version-endpoint";

const DEFAULT_HOTFIX_DEPTH = 100;

export const versionEndpointSource: Source = {
  id: VERSION_ENDPOINT_SOURCE_ID,
  interval: 0,
  async snapshot(ctx) {
    const snapshots: Snapshot[] = [];
    const fetched = new Map<string, Promise<DeployedVersion>>();
    const stageSubjects = new Map<string, Snapshot>();
    const deployedAt = (
      repo: RuleRepoView,
      stage: RuleStageView,
    ): Promise<DeployedVersion> => {
      const url = stageUrl(stage);
      let pending = fetched.get(url);
      if (!pending) {
        pending = ctx.services.http
          .fetchText(url)
          .then((text) => parseDeployedVersion(text));
        fetched.set(url, pending);
      }
      return pending.then((version) => {
        const subject = `repo/${repo.id}/stage/${stage.id}`;
        stageSubjects.set(subject, {
          subject,
          entity: "stage",
          facts: { commit: version.commitOid, version: version.raw },
        });
        return version;
      });
    };

    for (const task of ctx.tasks) {
      const repo = task.repository
        ? ctx.repositories.find((candidate) => candidate.id === task.repository)
        : undefined;
      const waiting = hookedWait(task, repo);
      if (!waiting || !repo) continue;
      const subject = taskSubject(task.id);
      try {
        snapshots.push({
          subject,
          entity: "deployment",
          facts: await deploymentFacts(
            task,
            repo,
            waiting.index,
            ctx,
            (stage) => deployedAt(repo, stage),
          ),
        });
      } catch (error) {
        ctx.warn(
          `${task.title}: ${error instanceof Error ? error.message : String(error)}`,
        );
        snapshots.push({
          subject,
          entity: "deployment",
          facts: {},
          stale: true,
        });
      }
    }
    // Stages nobody needed this tick keep their last known deployment.
    for (const previous of ctx.previous) {
      if (previous.entity !== "stage" || stageSubjects.has(previous.subject)) {
        continue;
      }
      stageSubjects.set(previous.subject, { ...previous, stale: true });
    }
    return [...snapshots, ...stageSubjects.values()];
  },
};

/** The task's current stage when it waits at a stage this source decides. */
function hookedWait(
  task: RuleTaskView,
  repo: RuleRepoView | undefined,
): { index: number } | undefined {
  if (task.state !== "awaiting" || task.awaiting?.kind !== "deploy") {
    return undefined;
  }
  if (!repo) return undefined;
  const stages = repo.deployment.stages;
  const index = stages.findIndex(
    (stage) => stage.id === task.awaiting?.stageId,
  );
  if (index < 0 || stages[index]?.hook !== VERSION_ENDPOINT_SOURCE_ID) {
    return undefined;
  }
  return { index };
}

async function deploymentFacts(
  task: RuleTaskView,
  repo: RuleRepoView,
  currentIndex: number,
  ctx: SourceContext,
  deployedAt: (stage: RuleStageView) => Promise<DeployedVersion>,
): Promise<Record<string, unknown>> {
  const stages = repo.deployment.stages;
  const current = stages[currentIndex] as RuleStageView;
  // Scan forward through consecutive hooked stages; never past a manual gate.
  let furthest = currentIndex;
  while (
    furthest + 1 < stages.length &&
    stages[furthest + 1]?.hook === VERSION_ENDPOINT_SOURCE_ID
  ) {
    furthest += 1;
  }
  for (let index = furthest; index >= currentIndex; index -= 1) {
    const stage = stages[index];
    if (!stage) continue;
    if (!(await stageDeployed(task, repo.id, stage, ctx, deployedAt))) {
      continue;
    }
    const next = stages[index + 1];
    return {
      stageId: current.id,
      satisfiedStageId: stage.id,
      next: next ? next.id : null,
      land: !next,
    };
  }
  return {
    stageId: current.id,
    satisfiedStageId: null,
    next: null,
    land: false,
  };
}

function stageUrl(stage: RuleStageView): string {
  const url = stage.options.url;
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) {
    throw new Error(
      `version-endpoint requires an https options.url for stage ${stage.id}`,
    );
  }
  return url;
}

/** Whether `stage`'s deployment contains the task's merged work. */
export async function stageDeployed(
  task: RuleTaskView,
  repositoryId: string,
  stage: RuleStageView,
  ctx: Pick<SourceContext, "services">,
  deployedAt: (stage: RuleStageView) => Promise<DeployedVersion>,
): Promise<boolean> {
  stageUrl(stage);
  const commit = task.pr?.mergeCommit?.oid;
  if (!commit) return false;
  const version = await deployedAt(stage);
  if (
    await ctx.services.github.containsCommit(
      repositoryId,
      commit,
      version.commitOid,
    )
  ) {
    return true;
  }
  return deployedHotfix(task, repositoryId, stage, ctx, version);
}

async function deployedHotfix(
  task: RuleTaskView,
  repositoryId: string,
  stage: RuleStageView,
  ctx: Pick<SourceContext, "services">,
  version: DeployedVersion,
): Promise<boolean> {
  if (stage.options.hotfixScan === false) return false;
  const reference = {
    ...(task.pr ? { pullRequestNumber: task.pr.number } : {}),
    ...(task.branch ? { branch: task.branch } : {}),
  };
  if (reference.pullRequestNumber === undefined && !reference.branch) {
    return false;
  }
  const depth = stage.options.hotfixDepth ?? DEFAULT_HOTFIX_DEPTH;
  if (
    typeof depth !== "number" ||
    !Number.isInteger(depth) ||
    depth < 1 ||
    depth > 100
  ) {
    throw new Error(
      `version-endpoint options.hotfixDepth must be an integer between 1 and 100 for stage ${stage.id}`,
    );
  }
  // Walking history back from the deployed commit means every scanned commit
  // is already deployed; no per-commit ancestry checks are needed.
  const commits = await ctx.services.github.commitLog(
    repositoryId,
    version.commitOid,
    depth,
  );
  return commits.some((commit) =>
    commitReferencesTask(commit.subject, reference),
  );
}
