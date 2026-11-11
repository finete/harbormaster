// The first-run wizard's form helpers (renderer/src/lib/onboarding.ts).
import { describe, expect, it } from "vitest";
import type { DetectedAgent } from "../src/preload/api";
import {
  customAgentFormProblem,
  customAgentFromForm,
  emptyCustomAgentForm,
  initialAgentChoice,
  splitArgs,
  suggestAgentId,
} from "../src/renderer/src/lib/onboarding";

const agent = (id: string, available: boolean): DetectedAgent => ({
  id,
  label: id,
  command: id,
  available,
});

describe("custom agent ids", () => {
  it("derives a lowercase id from the label and never takes a built-in", () => {
    expect(suggestAgentId("My Agent!")).toBe("my-agent");
    expect(suggestAgentId("  Aider ")).toBe("aider");
    expect(suggestAgentId("Pi")).toBe("pi-custom");
    expect(suggestAgentId("Claude Code")).toBe("claude-code-custom");
    expect(suggestAgentId("***")).toBe("custom-agent");
  });
});

describe("splitArgs", () => {
  it("splits plain and quoted words like a shell", () => {
    expect(splitArgs(`--model "big one" -x 'a b'  --flag`)).toEqual([
      "--model",
      "big one",
      "-x",
      "a b",
      "--flag",
    ]);
    expect(splitArgs(`--say "a \\"quoted\\" word"`)).toEqual([
      "--say",
      'a "quoted" word',
    ]);
    expect(splitArgs("  ")).toEqual([]);
    expect(splitArgs(`""`)).toEqual([""]);
  });
});

describe("the Other CLI form", () => {
  it("becomes an agents.custom[] entry", () => {
    expect(
      customAgentFromForm({
        label: "Aider",
        command: " aider ",
        args: "--yes-always --no-git",
        promptPositional: true,
      }),
    ).toEqual({
      id: "aider",
      label: "Aider",
      command: "aider",
      args: ["--yes-always", "--no-git"],
      promptArg: "positional",
    });
    expect(
      customAgentFromForm({
        label: "Bare",
        command: "/usr/local/bin/bare",
        args: "",
        promptPositional: false,
      }),
    ).toEqual({
      id: "bare",
      label: "Bare",
      command: "/usr/local/bin/bare",
      promptArg: "none",
    });
  });

  it("needs a name and a command", () => {
    expect(customAgentFormProblem(emptyCustomAgentForm())).toMatch(/name/);
    expect(
      customAgentFormProblem({ ...emptyCustomAgentForm(), label: "A" }),
    ).toMatch(/command/);
    expect(
      customAgentFormProblem({
        ...emptyCustomAgentForm(),
        label: "A",
        command: "a",
      }),
    ).toBeUndefined();
  });
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

  it("opens the Other CLI form for a configured custom agent", () => {
    expect(initialAgentChoice("aider", [agent("pi", true)])).toBe("custom");
  });
});
