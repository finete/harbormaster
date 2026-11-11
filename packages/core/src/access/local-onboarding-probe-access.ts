// Resource Access: the first-run wizard's machine probes (docs/release-plan.md
// "Onboarding (four screens)"). Runs `<agent> --version` and `gh auth
// status` through the shared process runner with a short timeout, so a CLI
// that hangs (a login prompt, a slow network check) never stalls the
// wizard; the outcome is raw text, parsed by `engines/onboarding.ts`.

import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import type {
  OnboardingProbeAccess,
  ProbeOutcome,
} from "../contracts/onboarding.js";
import { type RunOutcome, runOutcome } from "../utilities/run.js";

/** Per-probe wall-clock limit. */
export const ONBOARDING_PROBE_TIMEOUT_MS = 8_000;

function toProbe(outcome: RunOutcome): ProbeOutcome {
  return {
    ok: outcome.ok,
    output: [outcome.stdout, outcome.stderr]
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\n"),
    notFound: outcome.notFound,
    timedOut: outcome.timedOut,
  };
}

export interface LocalOnboardingProbeAccessOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export class LocalOnboardingProbeAccess implements OnboardingProbeAccess {
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  constructor(options: LocalOnboardingProbeAccessOptions = {}) {
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? ONBOARDING_PROBE_TIMEOUT_MS;
  }

  homeDir(): string {
    return homedir();
  }

  async isDirectory(path: string): Promise<boolean> {
    return stat(path).then(
      (info) => info.isDirectory(),
      () => false,
    );
  }

  async createDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  builtinAgentCommands(): Array<{
    id: string;
    label: string;
    command: string;
  }> {
    // The same overrides the adapters launch with (e2e fakes).
    return [
      {
        id: "pi",
        label: "Pi",
        command: this.env.HARBORMASTER_PI_COMMAND || "pi",
      },
      {
        id: "claude-code",
        label: "Claude Code",
        command: this.env.HARBORMASTER_CLAUDE_COMMAND || "claude",
      },
    ];
  }

  async cliVersion(command: string): Promise<ProbeOutcome> {
    return toProbe(
      await runOutcome(command, ["--version"], { timeoutMs: this.timeoutMs }),
    );
  }

  async githubAuthStatus(): Promise<ProbeOutcome> {
    const gh = this.env.HARBORMASTER_GH_COMMAND || "gh";
    return toProbe(
      await runOutcome(gh, ["auth", "status"], { timeoutMs: this.timeoutMs }),
    );
  }
}
