// Engine: default mover for everything after a merge. Ported from
// pi-home's src/addons/deployment-pipeline.ts and simplified for
// Harbormaster's plainer awaiting-context shape (`{ kind: "deploy", stageId,
// stageLabel }`, no separately tracked commit/pull-request snapshot — the
// task's own `pr.mergeCommit` is the single source of truth once merged).
//
// A merged PR enters the first configured deployment stage. A repository
// with no deployment pipeline configured is a deliberate simplification:
// this mover stays out of the way entirely (no pipeline => no automatic
// landing) rather than pi-home's stage-less "manual production wait", which
// Harbormaster's AwaitingKind has no slot for. Stage hooks decide
// advancement; after the last stage the task lands via `{ type: "done" }`
// (the manager's safe cleanup path). Because deployments can reach a later
// environment first (e.g. a hotfix goes to prod before pre), the mover
// checks hooked stages from the furthest one back to the current stage and
// jumps past the first satisfied one; a hookless (manual) stage is a
// deliberate gate that is never scanned past.

import type { BoardMove, TaskMover } from "../../contracts/addons.js";
import type { DeploymentStageConfig } from "../../contracts/model.js";
import { firstStage, stageAfter } from "../deployment.js";
import { observePullRequest } from "../pull-request-observation.js";

export const deploymentPipelineMover: TaskMover = {
  async decide(input, helpers) {
    const { task, pipeline } = input;
    const stages = pipeline?.stages ?? [];

    if (
      task.pr &&
      observePullRequest(task.state, task.awaiting, task.pr) === "merged"
    ) {
      const first = firstStage(stages);
      return first ? enterStage(first) : { type: "stay" };
    }
    const awaiting = task.awaiting;
    if (
      task.state !== "awaiting" ||
      awaiting?.kind !== "deploy" ||
      stages.length === 0
    ) {
      return { type: "stay" };
    }

    const currentIndex = stages.findIndex(
      (candidate) => candidate.id === awaiting.stageId,
    );
    const currentStage = stages[currentIndex];
    if (currentIndex < 0 || !currentStage?.hook) return { type: "stay" };
    if (!task.repositoryId) return { type: "stay" };

    // The scan may reach forward through consecutive hooked stages, but a
    // hookless (manual) stage is a deliberate gate that is never skipped.
    let furthest = currentIndex;
    while (furthest + 1 < stages.length && stages[furthest + 1]?.hook) {
      furthest += 1;
    }

    const commit = task.pr?.mergeCommit;
    for (let index = furthest; index >= currentIndex; index -= 1) {
      const stage = stages[index];
      if (!stage?.hook) continue;
      const result = await helpers.runHook(stage.hook, {
        repositoryId: task.repositoryId,
        ...(commit
          ? { commit: { oid: commit.oid, targetBranch: commit.targetBranch } }
          : {}),
        ...(task.pr
          ? {
              pullRequest: {
                number: task.pr.number,
                ...(task.pr.url ? { url: task.pr.url } : {}),
              },
            }
          : {}),
        ...(task.branch ? { branch: task.branch } : {}),
        stage: { id: stage.id, label: stage.label },
        options: stage.options ?? {},
      });
      if (!result.satisfied) continue;
      const next = stageAfter(stages, stage.id);
      return next ? enterStage(next) : { type: "done" };
    }
    return { type: "stay" };
  },
};

function enterStage(stage: DeploymentStageConfig): BoardMove {
  return { type: "deploy", stageId: stage.id, stageLabel: stage.label };
}
