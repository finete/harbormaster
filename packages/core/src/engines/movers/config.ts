// Engine: pure config-resolution rules for board automation. Ported from
// pi-home's workflow-manager `activeMovers` (per-repository `movers`
// override the global list) and global-config-access
// `unresolvedAddonNames` (configured names the registry does not provide).
// The config access layer only validates structure; which names exist is a
// registry (Engine) concern, so it is checked here, once per loaded config,
// instead of surfacing as a mover failure on every refresh tick.

import { DEFAULT_MOVER_ORDER } from "../../contracts/addons.js";
import type {
  DeploymentPipeline,
  GlobalConfig,
} from "../../contracts/model.js";

/** Registry names a loaded config may reference. */
export interface KnownAutomationNames {
  movers: ReadonlySet<string>;
  hooks: ReadonlySet<string>;
}

/**
 * The mover order for one task: the repository's own `movers` list when it
 * has one, else the global list, else the built-in default order. An
 * explicit empty list (either level) disables automatic moves.
 */
export function activeMoverOrder(
  config: GlobalConfig,
  repositoryId: string | undefined,
): readonly string[] {
  const repository = repositoryId
    ? config.repositories?.[repositoryId]
    : undefined;
  return repository?.movers ?? config.movers ?? DEFAULT_MOVER_ORDER;
}

/**
 * A repository's pipeline as the movers should see it: a stage whose hook
 * is not registered degrades to a manual gate (already reported once by
 * `automationConfigProblems`) instead of failing every refresh.
 */
export function effectivePipeline(
  pipeline: DeploymentPipeline | undefined,
  known: KnownAutomationNames,
): DeploymentPipeline | undefined {
  if (!pipeline) return undefined;
  if (
    pipeline.stages.every((stage) => !stage.hook || known.hooks.has(stage.hook))
  ) {
    return pipeline;
  }
  return {
    ...pipeline,
    stages: pipeline.stages.map((stage) => {
      if (!stage.hook || known.hooks.has(stage.hook)) return stage;
      const { hook: _unknown, options: _options, ...manual } = stage;
      return manual;
    }),
  };
}

/** Human-readable problems with the automation parts of a loaded config. */
export function automationConfigProblems(
  config: GlobalConfig,
  known: KnownAutomationNames,
): string[] {
  const problems: string[] = [];
  const checkMovers = (at: string, names: readonly string[] | undefined) => {
    if (!names) return;
    if (names.length === 0) {
      problems.push(
        `Config ${at} is empty: automatic board moves are disabled`,
      );
    }
    for (const name of names) {
      if (!known.movers.has(name)) {
        problems.push(`Config ${at} references unregistered mover "${name}"`);
      }
    }
  };
  checkMovers("movers", config.movers);
  for (const [repositoryId, repository] of Object.entries(
    config.repositories ?? {},
  )) {
    checkMovers(`repositories.${repositoryId}.movers`, repository.movers);
    for (const stage of repository.deployment?.stages ?? []) {
      if (stage.hook && !known.hooks.has(stage.hook)) {
        problems.push(
          `Config repositories.${repositoryId} stage ${stage.id} uses unregistered hook "${stage.hook}" (treated as a manual stage)`,
        );
      }
    }
  }
  return problems;
}
