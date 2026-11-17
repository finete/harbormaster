// Engine: an agent CLI's detected version against its harness's floors
// (docs/harness-additions.md P7, the same mechanism as Plannotator's
// `REVIEW_MINIMUMS`): below `minVersion` → upgrade, above
// `verifiedVersion` → "newer than tested". Pure: the descriptor and the raw
// lookup / version-run outcome in, the wizard's row out. Doctor's verdict
// for the same facts is `agentCheck` in `engines/doctor.ts`.

import type { HarnessDescriptor } from "../contracts/harness.js";
import type {
  AgentVersionFloor,
  DetectedAgent,
  ProbeOutcome,
} from "../contracts/onboarding.js";
import { compareSemver } from "./review-support.js";

/** The descriptor facts the floor rules read. */
export type AgentFloors = Pick<
  HarnessDescriptor,
  "minVersion" | "verifiedVersion"
>;

/** `version` against `minVersion` / `verifiedVersion`. */
export function agentVersionFloor(
  version: string | undefined,
  floors: AgentFloors,
): AgentVersionFloor {
  if (!version) return "unknown";
  if (floors.minVersion && compareSemver(version, floors.minVersion) < 0) {
    return "below-min";
  }
  if (
    floors.verifiedVersion &&
    compareSemver(version, floors.verifiedVersion) > 0
  ) {
    return "newer-than-verified";
  }
  return "ok";
}

/**
 * Where an agent CLI was found and what its version command said (the
 * manager's lookup through `AgentCommandProbeAccess`).
 */
export interface AgentProbe {
  /** The invocation looked up, as typed (`claude`, `cursor agent`, an override path). */
  command: string;
  /** The non-shim executable it resolved to. */
  path?: string;
  /** Set when every PATH hit was a terminal-multiplexer shim (the first one). */
  shim?: string;
  /** The version run's outcome; absent when nothing was found to run. */
  outcome?: ProbeOutcome;
  /** `descriptor.parseVersion(outcome.output)` for a successful run. */
  version?: string;
}

/** The upgrade one-liner (falls back to the install one). */
export function agentUpgradeHint(
  descriptor: Pick<HarnessDescriptor, "installHint" | "upgradeHint">,
): string {
  return descriptor.upgradeHint ?? descriptor.installHint;
}

/** A failed probe in one line: shim only, timed out, not found, or its first output line. */
function probeError(probe: AgentProbe): string {
  if (probe.shim) return "only a terminal shim was found";
  const outcome = probe.outcome;
  if (!outcome || outcome.notFound) return "not found";
  if (outcome.timedOut) return "Timed out.";
  const line = outcome.output
    .split(/\r?\n/)
    .map((text) => text.trim())
    .find(Boolean);
  return line ?? "Failed.";
}

/** A built-in agent's wizard row from its descriptor and probe. */
export function detectedAgent(
  descriptor: Pick<
    HarnessDescriptor,
    | "id"
    | "label"
    | "installHint"
    | "upgradeHint"
    | "minVersion"
    | "verifiedVersion"
  >,
  probe: AgentProbe,
): DetectedAgent {
  const facts = {
    id: descriptor.id,
    label: descriptor.label,
    command: probe.command,
    ...(probe.path ? { path: probe.path } : {}),
    ...(probe.shim ? { shim: probe.shim } : {}),
    ...(descriptor.minVersion ? { minVersion: descriptor.minVersion } : {}),
    ...(descriptor.verifiedVersion
      ? { verifiedVersion: descriptor.verifiedVersion }
      : {}),
    installHint: descriptor.installHint,
    upgradeHint: agentUpgradeHint(descriptor),
  };
  if (!probe.path || !probe.outcome?.ok) {
    return { ...facts, available: false, error: probeError(probe) };
  }
  return {
    ...facts,
    available: true,
    ...(probe.version ? { version: probe.version } : {}),
    floor: agentVersionFloor(probe.version, descriptor),
  };
}
