// Resource Access: the machine probes behind `reviewSupport`
// (docs/plannotator.md "Minimum versions"): `plannotator --version`, the
// installed Pi extension's `package.json` under Pi's npm dir, `claude
// plugin list --json`, `claude --version` and the `plannotator-review`
// Claude skill's SKILL.md (`$CLAUDE_CONFIG_DIR` or `~/.claude`, then
// `skills/`), and the same skill where Codex reads user skills
// (`$CODEX_HOME/skills` or `~/.codex/skills`, then `~/.agents/skills`).
// Raw outputs only, parsed by
// `engines/review-support.ts`; every probe is time-boxed and never throws.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReviewSupportProbeAccess } from "../contracts/services.js";
import { type RunOutcome, runOutcome } from "../utilities/run.js";

/** Per-probe wall-clock limit (`claude plugin list` is the slow one). */
export const REVIEW_PROBE_TIMEOUT_MS = 15_000;

export interface LocalReviewSupportProbeAccessOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  timeoutMs?: number;
}

function output(outcome: RunOutcome): string | undefined {
  if (outcome.notFound || outcome.timedOut) return undefined;
  const text = [outcome.stdout, outcome.stderr]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
  return outcome.ok || text ? text : undefined;
}

export class LocalReviewSupportProbeAccess implements ReviewSupportProbeAccess {
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly timeoutMs: number;

  constructor(options: LocalReviewSupportProbeAccessOptions = {}) {
    this.env = options.env ?? process.env;
    this.home = options.home ?? homedir();
    this.timeoutMs = options.timeoutMs ?? REVIEW_PROBE_TIMEOUT_MS;
  }

  private get claude(): string {
    // The same override the Claude Code adapter launches with (e2e fakes).
    return this.env.HARBORMASTER_CLAUDE_COMMAND || "claude";
  }

  private async probe(
    command: string,
    args: string[],
  ): Promise<string | undefined> {
    try {
      return output(
        await runOutcome(command, args, { timeoutMs: this.timeoutMs }),
      );
    } catch {
      return undefined;
    }
  }

  plannotatorVersion(): Promise<string | undefined> {
    return this.probe(
      this.env.HARBORMASTER_PLANNOTATOR_COMMAND || "plannotator",
      ["--version"],
    );
  }

  async piExtensionManifest(): Promise<string | undefined> {
    // Pi's agent dir as Pi resolves it: `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`.
    const agentDir =
      this.env.PI_CODING_AGENT_DIR || join(this.home, ".pi", "agent");
    const path = join(
      agentDir,
      "npm",
      "node_modules",
      "@plannotator",
      "pi-extension",
      "package.json",
    );
    return readFile(path, "utf8").catch(() => undefined);
  }

  claudePluginList(): Promise<string | undefined> {
    return this.probe(this.claude, ["plugin", "list", "--json"]);
  }

  claudeVersion(): Promise<string | undefined> {
    return this.probe(this.claude, ["--version"]);
  }

  async claudeReviewSkill(): Promise<string | undefined> {
    // Claude Code's config dir as it resolves it: `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
    const configDir = this.env.CLAUDE_CONFIG_DIR || join(this.home, ".claude");
    const path = join(configDir, "skills", "plannotator-review", "SKILL.md");
    return readFile(path, "utf8").catch(() => undefined);
  }

  async codexReviewSkill(): Promise<string | undefined> {
    // Codex's skill roots (codex-cli 0.169.0): `$CODEX_HOME/skills`
    // ("codex-home-skills") and `~/.agents/skills` ("user-agent-skills").
    const codexHome = this.env.CODEX_HOME || join(this.home, ".codex");
    for (const root of [
      join(codexHome, "skills"),
      join(this.home, ".agents", "skills"),
    ]) {
      const text = await readFile(
        join(root, "plannotator-review", "SKILL.md"),
        "utf8",
      ).catch(() => undefined);
      if (text !== undefined) return text;
    }
    return undefined;
  }
}
