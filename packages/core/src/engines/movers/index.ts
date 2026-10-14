// The built-in mover/hook registry. No user-addon loading in this phase
// (see contracts/addons.ts) — just a fixed lookup the manager arbitrates and
// executes against. Every default board movement below is replaceable later
// through a config `movers` list without changing the mover contract.

import type { StageHook, TaskMover } from "../../contracts/addons.js";
import { deploymentPipelineMover } from "./deployment-pipeline-mover.js";
import { githubReviewMover } from "./github-review-mover.js";
import { versionEndpointHook } from "./version-endpoint-hook.js";

export const builtinMovers: Readonly<Record<string, TaskMover>> = Object.freeze(
  {
    "github-review": githubReviewMover,
    "deployment-pipeline": deploymentPipelineMover,
  },
);

export const builtinHooks: Readonly<Record<string, StageHook>> = Object.freeze({
  "version-endpoint": versionEndpointHook,
});

/** Names the built-in registry provides, for config validation. */
export const builtinAutomationNames = Object.freeze({
  movers: new Set(Object.keys(builtinMovers)) as ReadonlySet<string>,
  hooks: new Set(Object.keys(builtinHooks)) as ReadonlySet<string>,
});

export * from "./arbiter.js";
export * from "./config.js";
export { deploymentPipelineMover, githubReviewMover, versionEndpointHook };
