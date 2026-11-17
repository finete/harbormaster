// Manager helper: locate one agent CLI from its harness descriptor (shared
// by `detectAgents` and doctor). The override env var wins; otherwise each
// alias in lookup order, skipping PATH hits that are terminal-multiplexer
// shims; then the descriptor's version command runs on the resolved file.

import type { HarnessDescriptor } from "../contracts/harness.js";
import type { AgentCommandProbeAccess } from "../contracts/onboarding.js";
import type { AgentProbe } from "../engines/agent-version.js";

export async function probeAgentCommand(
  descriptor: HarnessDescriptor,
  probes: AgentCommandProbeAccess,
): Promise<AgentProbe> {
  const override = probes.commandOverride(descriptor.commandEnv);
  const aliases: readonly (readonly string[])[] = override
    ? [[override]]
    : descriptor.commands;
  let shim: string | undefined;
  for (const argv of aliases) {
    const [binary, ...rest] = argv;
    if (!binary) continue;
    const hits = await probes.resolveCommandAll(binary).catch(() => []);
    const path = hits.find((hit) => !descriptor.isShim(hit));
    if (!path) {
      shim ??= hits[0];
      continue;
    }
    const outcome = await probes.runVersion(path, [
      ...rest,
      ...descriptor.versionArgs,
    ]);
    const version = outcome.ok
      ? descriptor.parseVersion(outcome.output)
      : undefined;
    return {
      command: argv.join(" "),
      path,
      outcome,
      ...(version ? { version } : {}),
    };
  }
  return {
    command: aliases[0]?.join(" ") ?? descriptor.id,
    ...(shim ? { shim } : {}),
  };
}
