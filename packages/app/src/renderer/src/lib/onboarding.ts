// Pure helpers for the first-run wizard (components/Onboarding.tsx;
// docs/release-plan.md "Onboarding (five screens)"). Window-free so they are unit-testable under plain vitest. Core
// validates everything again
// (`CoreCommands.setDefaultAgent`); these only shape the screens.

import type { DetectedAgent } from "../../../preload/api";

/**
 * The wizard's agent choice: a harness id. Normally a built-in; a custom
 * agent id only when it already is the configured default (config.json),
 * so reopening the wizard never silently replaces it.
 */
export type AgentChoice = string;

/** Whether `id` is one of the registered built-in agents (`builtinIds`, from core's harness descriptors). */
export function isBuiltinAgent(
  id: string,
  builtinIds: readonly string[],
): boolean {
  return builtinIds.includes(id);
}

/** The wizard's six steps, in order: id (the `data-step` value) and the verb-first label. */
export const ONBOARDING_STEPS = [
  { id: "code", label: "Pick your repositories folder" },
  { id: "agent", label: "Choose your agent" },
  { id: "review", label: "Set up code review" },
  { id: "github", label: "Connect GitHub" },
  { id: "import", label: "Bring in your recent work?" },
  { id: "concepts", label: "How it works" },
] as const;

/**
 * "found at <path> · v<version>" (either part may be missing), plus the
 * version floor when it is not plain ok ("older than the minimum 2.1.295",
 * "newer than tested (2.1.322)"), or undefined when not found.
 */
export function agentFoundLine(
  agent: DetectedAgent,
  displayPath: (path: string) => string = (path) => path,
): string | undefined {
  if (!agent.available) return undefined;
  const parts = [
    agent.path ? `found at ${displayPath(agent.path)}` : "found",
    ...(agent.version ? [`v${agent.version}`] : []),
  ];
  if (agent.floor === "below-min" && agent.minVersion) {
    parts.push(`older than the minimum ${agent.minVersion}`);
  } else if (agent.floor === "newer-than-verified" && agent.verifiedVersion) {
    parts.push(`newer than tested (${agent.verifiedVersion})`);
  }
  return parts.join(" · ");
}

/** The command a row offers: install when not found, upgrade when below the minimum, else none. */
export function agentFixCommand(
  agent: DetectedAgent,
): { kind: "install" | "upgrade"; command: string } | undefined {
  if (!agent.available) {
    return agent.installHint
      ? { kind: "install", command: agent.installHint }
      : undefined;
  }
  if (agent.floor === "below-min") {
    const command = agent.upgradeHint ?? agent.installHint;
    return command ? { kind: "upgrade", command } : undefined;
  }
  return undefined;
}

/**
 * The radio the agent screen starts on: the configured default when it is
 * a built-in that was found (or a custom agent already configured), else
 * the first detected built-in (registry order), else the
 * configured default anyway.
 */
export function initialAgentChoice(
  configured: string,
  detected: readonly DetectedAgent[],
  builtinIds: readonly string[],
): AgentChoice {
  if (!isBuiltinAgent(configured, builtinIds)) return configured;
  const found = detected.filter((agent) => agent.available);
  if (found.length === 0 || found.some((agent) => agent.id === configured)) {
    return configured;
  }
  return (
    found.find((agent) => isBuiltinAgent(agent.id, builtinIds))?.id ??
    configured
  );
}

/** What the wizard's window-level key handler should do with a keydown. */
export type WizardKeyAction =
  | "primary"
  | "back"
  | "close"
  | "flush-scan"
  | "none";

/** The parts of a keydown the wizard decides on (window-free). */
export interface WizardKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean | undefined;
}

/** The parts of the focused element the wizard decides on. */
export interface WizardKeyTarget {
  /** Upper-case tag name (`INPUT`, `BUTTON`, …); empty for none / body. */
  tag: string;
  /** `type` for an input. */
  type?: string | undefined;
  /** ARIA role, when set. */
  role?: string | null | undefined;
  contentEditable?: boolean | undefined;
  /** The code-folder path input. */
  isPathInput?: boolean | undefined;
}

export interface WizardKeyContext {
  step: number;
  /** Shown from the menu over a running app (Esc on step 1 closes). */
  closable: boolean;
  /** The code-folder scan is settled (no debounce pending, nothing in flight). */
  scanSettled: boolean;
}

/** Whether the focused element uses Enter itself (so plain Enter is not "Next"). */
function consumesEnter(target: WizardKeyTarget): boolean {
  if (target.contentEditable) return true;
  switch (target.tag) {
    case "TEXTAREA":
    case "SELECT":
    case "A":
      return true;
    // A switch toggles on Space; Enter stays "Next". Other buttons activate.
    case "BUTTON":
      return target.role !== "switch";
    case "INPUT": {
      const type = (target.type ?? "text").toLowerCase();
      if (type === "radio" || type === "checkbox") return false;
      // The path input submits; any other text field keeps Enter.
      return !target.isPathInput;
    }
    default:
      return false;
  }
}

/**
 * The wizard's keyboard path: Enter = primary unless the focused element
 * uses Enter itself (the path input waits for its scan), Cmd/Ctrl+Enter =
 * primary always, Esc = Back (on step 1: close over a running app,
 * nothing on first run).
 */
export function wizardKeyAction(
  key: WizardKey,
  target: WizardKeyTarget,
  context: WizardKeyContext,
): WizardKeyAction {
  if (key.isComposing) return "none";
  if (key.key === "Enter") {
    if (key.altKey || key.shiftKey) return "none";
    if (key.metaKey || key.ctrlKey) return "primary";
    if (consumesEnter(target)) return "none";
    if (target.isPathInput && !context.scanSettled) return "flush-scan";
    return "primary";
  }
  if (key.key === "Escape") {
    if (key.metaKey || key.ctrlKey || key.altKey || key.shiftKey) {
      return "none";
    }
    if (context.step > 0) return "back";
    return context.closable ? "close" : "none";
  }
  return "none";
}
