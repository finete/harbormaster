// Engine: pure deployment-pipeline math. Ported from pi-home's
// src/engines/deployment.ts, unchanged in behavior; `releaseBranchFor` was
// dropped (nothing in this phase derives a release-branch name from a
// parsed version — it is stored on `DeploymentPipeline.releaseBranch` for a
// later phase).

import type { DeploymentStageConfig } from "../contracts/model.js";

/** A parsed deployment version document like `v0.115.20+ca9bdff2`. */
export interface DeployedVersion {
  major: number;
  minor: number;
  patch: number;
  /** The exact deployed commit, lowercased; may be a short OID. */
  commitOid: string;
  /** The trimmed raw document, for display and diagnostics. */
  raw: string;
}

export function parseDeployedVersion(document: string): DeployedVersion {
  const raw = document.trim();
  // Accept semver (v0.115.20+sha) AND calendar/CI versions with any number
  // of numeric segments (2026.10.15.019+sha) — Fordefi switched to the latter,
  // which silently broke pi-home's stricter three-segment regex.
  const match = raw.match(/^v?(\d+(?:\.\d+)*)\+([0-9a-fA-F]{7,40})$/);
  const commitOid = match?.[2];
  if (!match || !commitOid) {
    throw new Error(
      `Unrecognized deployed version document: ${JSON.stringify(raw.slice(0, 80))}`,
    );
  }
  const segments = (match[1] ?? "").split(".").map(Number);
  return {
    major: segments[0] ?? 0,
    minor: segments[1] ?? 0,
    patch: segments[2] ?? 0,
    commitOid: commitOid.toLowerCase(),
    raw,
  };
}

/**
 * The reserved stage-less "Production deploy" wait (pi-home's manual
 * production wait): a merged PR in a repository with no deployment
 * pipeline parks here. Its id can never collide with a configured stage
 * (config stage ids must start alphanumeric), and no hook ever advances it
 * — only a manual Done lands the task.
 */
export const PRODUCTION_STAGE: Readonly<DeploymentStageConfig> = Object.freeze({
  id: "__production",
  label: "Production deploy",
});

/** Whether `stageId` is the reserved stage-less production wait. */
export function isProductionWait(stageId: string): boolean {
  return stageId === PRODUCTION_STAGE.id;
}

export function firstStage(
  stages: readonly DeploymentStageConfig[],
): DeploymentStageConfig | undefined {
  return stages[0];
}

/** The stage after `stageId`, or undefined when it is the last (landing) stage. */
export function stageAfter(
  stages: readonly DeploymentStageConfig[],
  stageId: string,
): DeploymentStageConfig | undefined {
  const index = stages.findIndex((stage) => stage.id === stageId);
  if (index < 0) throw new Error(`Unknown deployment stage: ${stageId}`);
  return stages[index + 1];
}

export interface TaskReference {
  pullRequestNumber?: number;
  branch?: string;
}

/**
 * Whether one commit subject references a task. Cherry-picked hotfixes
 * rewrite commit SHAs, so ancestry checks miss them; conventionally their
 * subjects embed the original branch name or the PR number (`… (#24161)`).
 */
export function commitReferencesTask(
  subject: string,
  reference: TaskReference,
): boolean {
  if (
    reference.pullRequestNumber !== undefined &&
    new RegExp(`(^|\\D)#${reference.pullRequestNumber}(\\D|$)`).test(subject)
  ) {
    return true;
  }
  if (
    reference.branch &&
    subject.toLowerCase().includes(reference.branch.toLowerCase())
  ) {
    return true;
  }
  return false;
}
