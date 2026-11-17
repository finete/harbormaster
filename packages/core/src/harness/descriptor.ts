// Shared descriptor helpers (docs/harness-additions.md P2): env override
// names, terminal-shim detection, the default version parser, and the
// plain-data view of a descriptor that crosses the command API.

import type {
  HarnessAdapter,
  HarnessCapabilities,
  HarnessDescriptorInfo,
} from "../contracts/harness.js";
import type { HarnessMessagingCapabilities } from "../contracts/messaging.js";
import { parseSemver } from "../engines/review-support.js";

/** `HARBORMASTER_<ID>_COMMAND` for a harness id (`claude-code` → `HARBORMASTER_CLAUDE_CODE_COMMAND`). */
export function harnessCommandEnvName(id: string): string {
  return `HARBORMASTER_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_COMMAND`;
}

/**
 * PATH entries terminal multiplexers prepend with wrapper scripts named
 * after the agents (cmux: `$TMPDIR/cmux-cli-shims/<uuid>/{claude,codex}`).
 * A Dock-launched app inherits none of the wrapper's setup, so such a hit
 * is not the agent.
 */
export const TERMINAL_SHIM_PATTERNS: readonly RegExp[] = [/\/cmux-cli-shims\//];

/** Whether `resolvedPath` is a terminal-multiplexer shim (see `TERMINAL_SHIM_PATTERNS`). */
export function isTerminalShim(resolvedPath: string): boolean {
  return TERMINAL_SHIM_PATTERNS.some((pattern) => pattern.test(resolvedPath));
}

/** The first `x.y.z` in a `--version` output (the shared review-support parser). */
export function parseVersionOutput(output: string): string | undefined {
  return parseSemver(output);
}

/**
 * The command a harness launches with: the adapter's own alias lookup
 * (`launchArgv`), else the first override env var set, else its first
 * alias's binary (`env` is the launching process's).
 */
export function harnessLaunchCommand(
  adapter: Pick<HarnessAdapter, "descriptor" | "launchArgv">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const argv = adapter.launchArgv?.(env);
  if (argv?.[0]) return argv[0];
  for (const name of adapter.descriptor.commandEnv) {
    const value = env[name];
    if (value) return value;
  }
  return adapter.descriptor.commands[0]?.[0] ?? adapter.descriptor.id;
}

/** The descriptor's plain-data part (`CoreCommands.listHarnessDescriptors`). */
export function harnessDescriptorInfo(
  adapter: HarnessAdapter,
  builtin: boolean,
): HarnessDescriptorInfo {
  const descriptor = adapter.descriptor;
  return {
    id: descriptor.id,
    label: descriptor.label,
    commands: descriptor.commands.map((argv) => [...argv]),
    installHint: descriptor.installHint,
    ...(descriptor.upgradeHint ? { upgradeHint: descriptor.upgradeHint } : {}),
    ...(descriptor.setupNote ? { setupNote: descriptor.setupNote } : {}),
    ...(descriptor.minVersion ? { minVersion: descriptor.minVersion } : {}),
    ...(descriptor.verifiedVersion
      ? { verifiedVersion: descriptor.verifiedVersion }
      : {}),
    reviewPieces: [...descriptor.reviewPieces],
    builtin,
    review: Boolean(adapter.review),
  };
}

/**
 * The messaging capabilities a delivery declaration implies: receiving at
 * all is any channel; `images` stays the adapter's own (not a delivery fact).
 */
export function deliveryAgreesWithMessaging(
  delivery: HarnessCapabilities["delivery"],
  messaging: HarnessMessagingCapabilities,
): boolean {
  return (
    delivery.steer === messaging.steer &&
    delivery.followUp === messaging.followUp &&
    (delivery.steer || delivery.followUp || delivery.wakeIdle) ===
      messaging.receive
  );
}
