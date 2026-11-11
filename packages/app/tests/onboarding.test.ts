// The first-run wizard's pure helpers (renderer/src/lib/onboarding.ts).
import { describe, expect, it } from "vitest";
import type { DetectedAgent } from "../src/preload/api";
import {
  AGENT_INSTALL_HINTS,
  agentFoundLine,
  initialAgentChoice,
  ONBOARDING_STEPS,
  type WizardKeyContext,
  type WizardKeyTarget,
  wizardKeyAction,
} from "../src/renderer/src/lib/onboarding";

const agent = (
  id: string,
  available: boolean,
  extra: Partial<DetectedAgent> = {},
): DetectedAgent => ({
  id,
  label: id,
  command: id,
  available,
  ...extra,
});

describe("initialAgentChoice", () => {
  it("keeps the configured agent when it was found or nothing was detected yet", () => {
    expect(initialAgentChoice("pi", [])).toBe("pi");
    expect(
      initialAgentChoice("claude-code", [
        agent("pi", true),
        agent("claude-code", true),
      ]),
    ).toBe("claude-code");
  });

  it("moves to the first detected built-in when the configured one is missing", () => {
    expect(
      initialAgentChoice("pi", [
        agent("pi", false),
        agent("claude-code", true),
      ]),
    ).toBe("claude-code");
    expect(
      initialAgentChoice("pi", [
        agent("pi", false),
        agent("claude-code", false),
      ]),
    ).toBe("pi");
  });

  it("keeps a configured custom agent (the wizard no longer offers a form for one)", () => {
    expect(initialAgentChoice("aider", [agent("pi", true)])).toBe("aider");
  });
});

describe("agent detection lines", () => {
  it("says where and which version, and nothing for a missing agent", () => {
    expect(
      agentFoundLine(
        agent("claude-code", true, {
          path: "/Users/me/.local/bin/claude",
          version: "2.1.322",
        }),
        (path) => path.replace("/Users/me", "~"),
      ),
    ).toBe("found at ~/.local/bin/claude · v2.1.322");
    expect(agentFoundLine(agent("pi", true))).toBe("found");
    expect(agentFoundLine(agent("pi", true, { version: "1.0.0" }))).toBe(
      "found · v1.0.0",
    );
    expect(agentFoundLine(agent("pi", false))).toBeUndefined();
  });

  it("has a one-line install command per built-in", () => {
    expect(AGENT_INSTALL_HINTS.pi).toBe(
      "npm install -g @earendil-works/pi-coding-agent",
    );
    expect(AGENT_INSTALL_HINTS["claude-code"]).toBe(
      "curl -fsSL https://claude.ai/install.sh | bash",
    );
  });

  it("labels the four steps verb-first", () => {
    expect(ONBOARDING_STEPS.map((step) => step.label)).toEqual([
      "Pick your code folder",
      "Choose your agent",
      "Connect GitHub",
      "How it works",
    ]);
  });
});

describe("wizardKeyAction", () => {
  const key = (name: string, mods: Partial<Record<string, boolean>> = {}) => ({
    key: name,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });
  const body: WizardKeyTarget = { tag: "" };
  const radio: WizardKeyTarget = { tag: "INPUT", type: "radio" };
  const pathInput: WizardKeyTarget = {
    tag: "INPUT",
    type: "text",
    isPathInput: true,
  };
  const ctx = (patch: Partial<WizardKeyContext> = {}): WizardKeyContext => ({
    step: 1,
    closable: false,
    scanSettled: true,
    ...patch,
  });

  it("Enter is the primary action unless the focused control uses Enter", () => {
    expect(wizardKeyAction(key("Enter"), body, ctx())).toBe("primary");
    expect(wizardKeyAction(key("Enter"), radio, ctx())).toBe("primary");
    expect(
      wizardKeyAction(
        key("Enter"),
        { tag: "BUTTON", role: "switch" },
        ctx({ step: 2 }),
      ),
    ).toBe("primary");
    expect(wizardKeyAction(key("Enter"), { tag: "BUTTON" }, ctx())).toBe(
      "none",
    );
    expect(wizardKeyAction(key("Enter"), { tag: "TEXTAREA" }, ctx())).toBe(
      "none",
    );
    expect(
      wizardKeyAction(key("Enter"), { tag: "INPUT", type: "text" }, ctx()),
    ).toBe("none");
    expect(wizardKeyAction(key("Enter", { shiftKey: true }), body, ctx())).toBe(
      "none",
    );
    expect(
      wizardKeyAction({ ...key("Enter"), isComposing: true }, body, ctx()),
    ).toBe("none");
  });

  it("the path input submits only once its scan settled", () => {
    expect(wizardKeyAction(key("Enter"), pathInput, ctx({ step: 0 }))).toBe(
      "primary",
    );
    expect(
      wizardKeyAction(
        key("Enter"),
        pathInput,
        ctx({ step: 0, scanSettled: false }),
      ),
    ).toBe("flush-scan");
  });

  it("Cmd/Ctrl+Enter is the primary action from anywhere", () => {
    for (const target of [
      { tag: "TEXTAREA" },
      { tag: "BUTTON" },
      { tag: "INPUT", type: "text" },
    ]) {
      expect(
        wizardKeyAction(key("Enter", { metaKey: true }), target, ctx()),
      ).toBe("primary");
      expect(
        wizardKeyAction(key("Enter", { ctrlKey: true }), target, ctx()),
      ).toBe("primary");
    }
  });

  it("Esc goes back; on the first step it closes the overlay and does nothing on first run", () => {
    expect(wizardKeyAction(key("Escape"), body, ctx({ step: 2 }))).toBe("back");
    expect(wizardKeyAction(key("Escape"), pathInput, ctx({ step: 0 }))).toBe(
      "none",
    );
    expect(
      wizardKeyAction(key("Escape"), body, ctx({ step: 0, closable: true })),
    ).toBe("close");
    expect(wizardKeyAction(key("a"), body, ctx())).toBe("none");
  });
});
