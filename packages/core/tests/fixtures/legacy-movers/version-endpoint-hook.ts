// Engine: built-in stage hook. Ported from pi-home's
// src/addons/version-endpoint.ts unchanged in behavior. An environment
// exposes a version endpoint returning a raw document like
// `v0.115.20+ca9bdff2`. The stage is satisfied when the task's merge commit
// is an ancestor of the deployed commit after `+`, or — because
// release-branch hotfixes are cherry-picks with rewritten SHAs — when a
// commit contained in the deployment references the task's branch or PR
// number in its subject. Disable the scan with `options.hotfixScan: false`
// or bound it with `options.hotfixDepth` (1-100 commits, default 100).

import {
  commitReferencesTask,
  type DeployedVersion,
  parseDeployedVersion,
} from "../../../src/engines/deployment.js";
import type {
  CommitLogEntry,
  StageHook,
  StageHookHelpers,
  StageHookInput,
} from "./addons.js";

const DEFAULT_HOTFIX_DEPTH = 100;

export const versionEndpointHook: StageHook = {
  async check(input, helpers) {
    const url = input.options.url;
    if (typeof url !== "string" || !/^https:\/\//i.test(url)) {
      throw new Error(
        `version-endpoint requires an https options.url for stage ${input.stage.id}`,
      );
    }
    if (!input.commit) {
      return { satisfied: false, detail: "No merged commit recorded yet" };
    }
    const version = parseDeployedVersion(await helpers.fetchText(url));
    if (await helpers.containsCommit(input.commit.oid, version.commitOid)) {
      return {
        satisfied: true,
        detail: `${input.stage.label} is at ${version.raw}`,
      };
    }
    const hotfix = await findDeployedHotfix(input, helpers, version);
    if (hotfix) {
      return {
        satisfied: true,
        detail: `${input.stage.label} is at ${version.raw} via hotfix ${hotfix.oid.slice(0, 7)} (${hotfix.subject})`,
      };
    }
    return {
      satisfied: false,
      detail: `${input.stage.label} is at ${version.raw}`,
    };
  },
};

async function findDeployedHotfix(
  input: StageHookInput,
  helpers: StageHookHelpers,
  version: DeployedVersion,
): Promise<CommitLogEntry | undefined> {
  if (input.options.hotfixScan === false) return undefined;
  const reference = {
    ...(input.pullRequest
      ? { pullRequestNumber: input.pullRequest.number }
      : {}),
    ...(input.branch ? { branch: input.branch } : {}),
  };
  if (reference.pullRequestNumber === undefined && !reference.branch) {
    return undefined;
  }
  const depth = input.options.hotfixDepth ?? DEFAULT_HOTFIX_DEPTH;
  if (
    typeof depth !== "number" ||
    !Number.isInteger(depth) ||
    depth < 1 ||
    depth > 100
  ) {
    throw new Error(
      `version-endpoint options.hotfixDepth must be an integer between 1 and 100 for stage ${input.stage.id}`,
    );
  }
  // Walking history back from the deployed commit means every scanned commit
  // is already deployed; no per-commit ancestry checks are needed.
  const commits = await helpers.commitLog(version.commitOid, depth);
  return commits.find((commit) =>
    commitReferencesTask(commit.subject, reference),
  );
}
