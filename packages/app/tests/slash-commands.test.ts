// The composer's `/` menu logic (renderer/src/lib/slash-commands.ts; see
// docs/new-task-composer.md "Slash commands").
import { describe, expect, it } from "vitest";
import type { SlashCommand } from "../src/preload/api";
import {
  applySlashCommand,
  matchSlashCommands,
  moveSlashSelection,
  slashName,
  slashTrigger,
} from "../src/renderer/src/lib/slash-commands";

const entry = (
  command: string,
  source: SlashCommand["source"] = "user",
  description?: string,
): SlashCommand => ({
  command,
  kind: "skill",
  source,
  ...(description ? { description } : {}),
});

describe("slashTrigger", () => {
  it("opens only for a / at the very start, while the caret is in that first word", () => {
    expect(slashTrigger("/", 1)).toEqual({ query: "", end: 1 });
    expect(slashTrigger("/rev", 4)).toEqual({ query: "rev", end: 4 });
    // Caret inside the token: the query is what precedes it; a pick replaces the whole token.
    expect(slashTrigger("/review the PR", 3)).toEqual({ query: "re", end: 7 });
    // Caret past the first word, before the slash, or no leading slash.
    expect(slashTrigger("/review the PR", 8)).toBeNull();
    expect(slashTrigger("/review", 0)).toBeNull();
    expect(slashTrigger("fix /review", 11)).toBeNull();
    expect(slashTrigger(" /review", 2)).toBeNull();
    expect(slashTrigger("", 0)).toBeNull();
  });
});

describe("matchSlashCommands", () => {
  const commands = [
    entry("/plugin:review-pr", "plugin"),
    entry("/review", "user"),
    entry("/@fordefi/build:check", "plugin"),
    entry("/skill:pdf-tools", "user", "Extract text from PDFs"),
    entry("$plannotator-review", "user"),
    entry("/deploy", "project"),
  ];

  it("lists everything for an empty query: the workspace's first, then the user's, then plugins'", () => {
    expect(matchSlashCommands(commands, "").map(slashName)).toEqual([
      "deploy",
      "plannotator-review",
      "review",
      "skill:pdf-tools",
      "@fordefi/build:check",
      "plugin:review-pr",
    ]);
  });

  it("ranks a name prefix, then a namespace segment, then a word, then anywhere, then the description", () => {
    expect(matchSlashCommands(commands, "rev").map(slashName)).toEqual([
      "review",
      "plugin:review-pr",
      "plannotator-review",
    ]);
    expect(matchSlashCommands(commands, "check").map(slashName)).toEqual([
      "@fordefi/build:check",
    ]);
    expect(matchSlashCommands(commands, "PDF").map(slashName)).toEqual([
      "skill:pdf-tools",
    ]);
    expect(matchSlashCommands(commands, "tools").map(slashName)).toEqual([
      "skill:pdf-tools",
    ]);
    expect(matchSlashCommands(commands, "ploy").map(slashName)).toEqual([
      "deploy",
    ]);
    expect(matchSlashCommands(commands, "extract").map(slashName)).toEqual([
      "skill:pdf-tools",
    ]);
    // Descriptions only count from three characters.
    expect(matchSlashCommands(commands, "ex")).toEqual([]);
    expect(matchSlashCommands(commands, "tmp/x")).toEqual([]);
  });
});

describe("applySlashCommand", () => {
  it("replaces the leading token with the command and one space, caret after it", () => {
    expect(
      applySlashCommand("/rev", { query: "rev", end: 4 }, entry("/review")),
    ).toEqual({ text: "/review ", caret: 8 });
    // Text after the token is kept; an existing space is not doubled.
    expect(
      applySlashCommand(
        "/re the PR",
        { query: "re", end: 3 },
        entry("/review"),
      ),
    ).toEqual({ text: "/review the PR", caret: 8 });
    // Codex skills are `$name`.
    expect(
      applySlashCommand("/plan", { query: "plan", end: 5 }, entry("$plan-x")),
    ).toEqual({ text: "$plan-x ", caret: 8 });
    // A newline right after the token stays (multi-line prompts).
    expect(
      applySlashCommand("/\nmore", { query: "", end: 1 }, entry("/deploy")),
    ).toEqual({ text: "/deploy\nmore", caret: 8 });
  });
});

describe("moveSlashSelection", () => {
  it("wraps at both ends", () => {
    expect(moveSlashSelection(0, 3, 1)).toBe(1);
    expect(moveSlashSelection(2, 3, 1)).toBe(0);
    expect(moveSlashSelection(0, 3, -1)).toBe(2);
    expect(moveSlashSelection(0, 0, 1)).toBe(0);
  });
});
