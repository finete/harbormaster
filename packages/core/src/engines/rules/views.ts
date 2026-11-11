// Engine: the read-only shapes rules and sources see (`task`, `repo` in
// CEL) and the config checks that go with them. Pure.

import type {
  DeploymentPipeline,
  GlobalConfig,
  Task,
} from "../../contracts/model.js";
import type { RuleRepoView, RuleTaskView } from "../../contracts/rules.js";

/** A task as rules see it: absent fields are `null` so CEL never trips on a missing key. */
export function toRuleTaskView(task: Task): RuleTaskView {
  const pr = task.pr
    ? {
        reviewDecision: null,
        changesRequestedOnHead: null,
        humanFeedbackOnHead: null,
        reviewRequested: null,
        reviewSubmitted: null,
        headRefOid: null,
        mergeCommit: null,
        url: null,
        ...task.pr,
        role: task.pr.role ?? "author",
      }
    : null;
  return {
    id: task.id,
    title: task.title,
    kind: task.kind,
    state: task.state,
    awaiting: task.awaiting
      ? ({ ...task.awaiting } as RuleTaskView["awaiting"])
      : null,
    branch: task.branch ?? null,
    repository: task.repositoryId ?? null,
    pr: pr as RuleTaskView["pr"],
    parentTaskId: task.parentTaskId ?? null,
    createdAt: task.createdAt,
    stateChangedAt: task.stateChangedAt,
  };
}

/**
 * A repository's pipeline as rules see it: a stage whose hook names no
 * registered source degrades to a manual gate (reported once by
 * `automationConfigProblems`) instead of failing every tick.
 */
export function effectivePipeline(
  pipeline: DeploymentPipeline | undefined,
  knownSources: ReadonlySet<string>,
): DeploymentPipeline | undefined {
  if (!pipeline) return undefined;
  return {
    ...pipeline,
    stages: pipeline.stages.map((stage) => {
      if (!stage.hook || knownSources.has(stage.hook)) return stage;
      const { hook: _unknown, options: _options, ...manual } = stage;
      return manual;
    }),
  };
}

/** Every configured repository as rules see it. */
export function repositoryViews(
  config: GlobalConfig,
  knownSources: ReadonlySet<string>,
): RuleRepoView[] {
  return Object.entries(config.repositories ?? {}).map(([id, entry]) =>
    toRuleRepoView(id, entry.deployment, knownSources),
  );
}

export function toRuleRepoView(
  id: string,
  pipeline: DeploymentPipeline | undefined,
  knownSources: ReadonlySet<string>,
): RuleRepoView {
  const effective = effectivePipeline(pipeline, knownSources);
  return {
    id,
    deployment: {
      stages: (effective?.stages ?? []).map((stage) => ({
        id: stage.id,
        label: stage.label,
        ...(stage.hook ? { hook: stage.hook } : {}),
        options: stage.options ?? {},
      })),
    },
  };
}

/** Human-readable problems with the automation parts of a loaded config. */
export function automationConfigProblems(
  config: GlobalConfig,
  knownSources: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  for (const [repositoryId, repository] of Object.entries(
    config.repositories ?? {},
  )) {
    for (const stage of repository.deployment?.stages ?? []) {
      if (stage.hook && !knownSources.has(stage.hook)) {
        problems.push(
          `Config repositories.${repositoryId} stage ${stage.id} uses unregistered hook "${stage.hook}" (treated as a manual stage)`,
        );
      }
    }
  }
  return problems;
}
