// Pure helpers for the first-run wizard (components/Onboarding.tsx;
// docs/release-plan.md "Onboarding (four screens)"). Window-free so they
// are unit-testable under plain vitest. Core validates everything again
// (`CoreCommands.setDefaultAgent`); these only shape the form.

import type { CustomAgentConfig, DetectedAgent } from "../../../preload/api";

/** The built-in agents' harness ids (a custom CLI may never take one). */
export const BUILTIN_AGENT_IDS = ["pi", "claude-code"] as const;

/** The wizard's agent choice: a built-in harness, or the "Other CLI" form. */
export type AgentChoice = "pi" | "claude-code" | "custom";

export interface CustomAgentForm {
  label: string;
  command: string;
  /** One line, split like a shell would (quotes group words). */
  args: string;
  /** Pass the task's prompt as the last argument. */
  promptPositional: boolean;
}

export function emptyCustomAgentForm(): CustomAgentForm {
  return { label: "", command: "", args: "", promptPositional: true };
}

/** A harness id derived from a display label ("My Agent" → "my-agent"), never a built-in. */
export function suggestAgentId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!slug) return "custom-agent";
  return (BUILTIN_AGENT_IDS as readonly string[]).includes(slug)
    ? `${slug}-custom`
    : slug;
}

/**
 * Splits an argument line the way a shell would for plain words and quoted
 * strings (`--flag "two words" 'x'`); no expansion, and the only escape is a
 * backslash before the closing quote character.
 */
export function splitArgs(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string;
    if (quote) {
      if (char === "\\" && line[i + 1] === quote) {
        current += quote;
        i++;
      } else if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

/** The "Other CLI" form as the `agents.custom[]` entry core writes. */
export function customAgentFromForm(form: CustomAgentForm): CustomAgentConfig {
  const args = splitArgs(form.args);
  return {
    id: suggestAgentId(form.label),
    label: form.label.trim(),
    command: form.command.trim(),
    ...(args.length > 0 ? { args } : {}),
    promptArg: form.promptPositional ? "positional" : "none",
  };
}

/** What blocks "Next" on the Other CLI form (core re-validates). */
export function customAgentFormProblem(
  form: CustomAgentForm,
): string | undefined {
  if (!form.label.trim()) return "Give the agent a name.";
  if (!form.command.trim()) return "Enter the command that starts it.";
  return undefined;
}

/**
 * The radio the agent screen starts on: the configured default when it is
 * a built-in that was found (or a custom agent), else the first detected
 * built-in (Pi before Claude Code), else the configured default anyway.
 */
export function initialAgentChoice(
  configured: string,
  detected: readonly DetectedAgent[],
): AgentChoice {
  const isBuiltin = (id: string): id is "pi" | "claude-code" =>
    (BUILTIN_AGENT_IDS as readonly string[]).includes(id);
  if (!isBuiltin(configured)) return "custom";
  const found = detected.filter((agent) => agent.available);
  if (found.length === 0 || found.some((agent) => agent.id === configured)) {
    return configured;
  }
  const first = found.find((agent) => isBuiltin(agent.id));
  return first && isBuiltin(first.id) ? first.id : configured;
}
