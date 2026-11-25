// The import tools (docs/import.md "CLI / MCP"): arg shaping onto the core
// commands, and the text for grouped / blocked / hidden / forkable items,
// dry run and undo. A fake `CoreCommands` (the contract), not the stores.

import { describe, expect, it } from "vitest";
import type { CoreCommands } from "../src/contracts/commands.js";
import type {
  ImportCandidate,
  ImportCandidateListing,
  ImportItemsInput,
  ImportItemsResult,
  UndoImportResult,
} from "../src/contracts/import.js";
import {
  dispatchToolCall,
  formatImportListText,
  formatImportResultText,
  formatUndoImportText,
  TOOL_CATALOG,
} from "../src/tools/index.js";

const NOW = "2026-11-25T12:00:00.000Z";

function candidate(
  over: Partial<ImportCandidate> & { id: string },
): ImportCandidate {
  return {
    folderPath: `/w/${over.id}`,
    kind: "worktree",
    groupLabel: "acme/app",
    title: `Title ${over.id}`,
    titleSource: "session",
    sessions: [
      {
        harness: "claude-code",
        sessionId: `s-${over.id}`,
        sessionPath: `/s/${over.id}.jsonl`,
        lastActiveAt: "2026-11-22T12:00:00.000Z",
        userPrompts: 5,
        canFork: true,
      },
    ],
    defaultSessionId: `s-${over.id}`,
    sources: ["claude-code"],
    lastActiveAt: "2026-11-22T12:00:00.000Z",
    preselected: false,
    ...over,
  };
}

const running = candidate({
  id: "run1",
  blocked: "running",
  sessions: [
    {
      harness: "cursor",
      sessionId: "s-run1",
      sessionPath: "/s/run1",
      lastActiveAt: "2026-11-24T12:00:00.000Z",
      userPrompts: 4,
      canFork: false,
      running: {
        where: "terminal",
        precision: "folder",
        message: "Running in a terminal: close it there.",
      },
    },
  ],
  defaultSessionId: "s-run1",
  sources: ["cursor"],
});

const listing: ImportCandidateListing = {
  scannedAt: NOW,
  sources: [
    { id: "claude-code", label: "Claude Code", found: 3 },
    { id: "cursor", label: "Cursor", found: 1, error: "unknown format v9" },
  ],
  groups: [
    {
      id: "repo-a",
      label: "acme/app",
      candidates: [
        candidate({
          id: "a1",
          branch: "feat/x",
          preselected: true,
          pullRequest: { number: 12, url: "u", state: "merged" },
          sessions: [
            ...candidate({ id: "a1" }).sessions,
            {
              harness: "codex",
              sessionId: "other",
              sessionPath: "/s/o",
              lastActiveAt: "2026-10-01T00:00:00.000Z",
              userPrompts: 9,
              canFork: true,
            },
          ],
        }),
        candidate({
          id: "a2",
          blocked: "on-board",
          onBoardTaskId: "t-9",
        }),
        {
          ...running,
          preselected: true,
          sessions: [
            {
              ...(running.sessions[0] as ImportCandidate["sessions"][number]),
              canFork: true,
              harness: "claude-code",
              running: {
                where: "herdr",
                precision: "session",
                message: "Running in herdr: close it there, or fork it.",
              },
            },
          ],
        },
        candidate({ id: "h1", hidden: "tiny" }),
        candidate({ id: "h2", hidden: "tiny" }),
        candidate({ id: "h3", hidden: "folder-missing" }),
      ],
    },
    {
      id: "folder:/x",
      label: "scratch",
      candidates: [
        candidate({
          id: "c1",
          kind: "folder",
          groupLabel: "scratch",
          titleSource: "herdr",
        }),
      ],
    },
  ],
};

function fake(over: Partial<CoreCommands> = {}): CoreCommands {
  return {
    listImportCandidates: async () => listing,
    importItems: async () => {
      throw new Error("importItems must not be called");
    },
    undoImport: async () => {
      throw new Error("undoImport must not be called");
    },
    ...over,
  } as unknown as CoreCommands;
}

describe("catalog", () => {
  it("lists the three import tools, warning that they import the user's sessions", () => {
    const tools = TOOL_CATALOG.filter((t) => t.name.startsWith("import_"));
    expect(tools.map((t) => t.name)).toEqual([
      "import_list",
      "import_apply",
      "import_undo",
    ]);
    for (const tool of tools.slice(0, 2)) {
      expect(tool.description).toMatch(/USER's existing agent sessions/);
      expect(tool.description).toMatch(/Only run it when the user asked/);
    }
    expect(tools[2]?.description).toMatch(/Only run it when the user asked/);
  });
});

describe("import_list", () => {
  it("groups by repository, shows source hint, PR label, other sessions, blocked reasons and the hidden footer", async () => {
    let seen: unknown;
    const result = await dispatchToolCall(
      fake({
        listImportCandidates: async (input) => {
          seen = input;
          return listing;
        },
      }),
      "import_list",
      { includeOlder: true },
      {},
    );
    expect(seen).toEqual({ includeOlder: true });
    const text = result.text;
    expect(text.indexOf("acme/app (3)")).toBeLessThan(
      text.indexOf("scratch (1)"),
    );
    expect(text).toContain("[x] a1  Title a1 (from Claude Code session title)");
    expect(text).toContain(
      "worktree · branch feat/x · PR #12 merged · last active 3d ago · +1 other session",
    );
    expect(text).toContain("[-] a2");
    expect(text).toContain("blocked: already in Harbormaster (task t-9)");
    expect(text).toContain(
      "blocked: Running in herdr: close it there, or fork it. Fork is possible: import it with --fork run1.",
    );
    expect(text).toContain("(from herdr workspace name)");
    expect(text).toContain(
      "3 hidden: tiny 2, folder missing 1 (--hidden to show)",
    );
    expect(text).not.toContain("h1");
    expect(text).toContain(
      "Note: Cursor could not be fully read: unknown format v9",
    );
    expect(result.details).toBe(listing);
  });

  it("says a running item that cannot fork must be closed there, and shows hidden items on request", () => {
    const text = formatImportListText(
      {
        ...listing,
        groups: [
          {
            id: "g",
            label: "g",
            candidates: [running, candidate({ id: "h1", hidden: "tiny" })],
          },
        ],
      },
      { includeHidden: true },
    );
    expect(text).toContain("This agent cannot fork");
    expect(text).toContain("hidden: tiny");
    expect(text).not.toContain("--hidden to show");
  });
});

describe("import_apply", () => {
  const ok: ImportItemsResult = {
    batchId: "b1",
    imported: [{ candidateId: "a1", taskId: "t-1" }],
    skipped: [{ candidateId: "c1", reason: "running", detail: "now live" }],
    leftOut: { running: 2, "folder-missing": 1 },
  };

  it("shapes preselected, titles, sessions and forks into importItems and prints the batch and undo command", async () => {
    let input: ImportItemsInput | undefined;
    const result = await dispatchToolCall(
      fake({
        importItems: async (i) => {
          input = i;
          return ok;
        },
      }),
      "import_apply",
      {
        candidateIds: ["c1", "run1"],
        preselected: true,
        titles: { c1: " Renamed " },
        sessions: { a1: "other" },
        forks: ["run1"],
      },
      {},
    );
    expect(input).toEqual({
      items: [
        { candidateId: "c1", sessionId: "s-c1", title: "Renamed" },
        {
          candidateId: "run1",
          sessionId: "s-run1",
          title: "Title run1",
          fork: true,
        },
        { candidateId: "a1", sessionId: "other", title: "Title a1" },
      ],
    });
    expect(result.text).toContain("Imported 1 task.");
    expect(result.text).toContain("Title a1 → task t-1");
    expect(result.text).toContain("Skipped 1:");
    expect(result.text).toContain("running elsewhere: now live");
    expect(result.text).toContain(
      "Left out: running elsewhere: 2, folder missing: 1.",
    );
    expect(result.text).toContain("Undo with: harbormaster import undo b1");
  });

  it("preselected alone picks only unblocked pre-ticked candidates", async () => {
    let input: ImportItemsInput | undefined;
    await dispatchToolCall(
      fake({
        importItems: async (i) => {
          input = i;
          return ok;
        },
      }),
      "import_apply",
      { preselected: true },
      {},
    );
    expect(input?.items.map((i) => i.candidateId)).toEqual(["a1"]);
  });

  it("dry run never calls importItems and states what would be created and left out", async () => {
    const result = await dispatchToolCall(
      fake(),
      "import_apply",
      { candidateIds: ["a1", "a2", "run1"], dryRun: true },
      {},
    );
    expect(result.text).toContain("Dry run: would import 1 task.");
    expect(result.text).toContain("+ a1  Title a1 (worktree, Claude Code)");
    expect(result.text).toContain("Would be left out:");
    expect(result.text).toContain("- a2  Title a2: already in Harbormaster");
    expect(result.text).toContain("- run1");
    expect(result.text).toContain("Nothing was imported");
  });

  it("dry run with fork imports a running forkable item", async () => {
    const result = await dispatchToolCall(
      fake(),
      "import_apply",
      { candidateIds: ["run1"], forks: ["run1"], dryRun: true },
      {},
    );
    expect(result.text).toContain("would import 1 task");
    expect(result.text).toContain("fork of the session");
  });

  it("rejects missing selection, unknown ids, unknown sessions and stray overrides", async () => {
    await expect(
      dispatchToolCall(fake(), "import_apply", {}, {}),
    ).rejects.toThrow(/candidateIds/);
    await expect(
      dispatchToolCall(fake(), "import_apply", { candidateIds: ["nope"] }, {}),
    ).rejects.toThrow(/Unknown candidate "nope"/);
    await expect(
      dispatchToolCall(
        fake(),
        "import_apply",
        { candidateIds: ["a1"], sessions: { a1: "zzz" } },
        {},
      ),
    ).rejects.toThrow(/no session "zzz"/);
    await expect(
      dispatchToolCall(
        fake(),
        "import_apply",
        { candidateIds: ["a1"], titles: { c1: "x" } },
        {},
      ),
    ).rejects.toThrow(/not among/);
  });
});

describe("import_undo", () => {
  it("forwards the batch id and lists removed and kept tasks", async () => {
    let batch: string | undefined;
    const result = await dispatchToolCall(
      fake({
        undoImport: async (id): Promise<UndoImportResult> => {
          batch = id;
          return {
            batchId: id,
            removed: ["t-1", "t-2"],
            kept: [{ taskId: "t-3", title: "Opened one" }],
          };
        },
      }),
      "import_undo",
      { batchId: "b1" },
      {},
    );
    expect(batch).toBe("b1");
    expect(result.text).toContain("removed 2 tasks");
    expect(result.text).toContain("removed task t-1");
    expect(result.text).toContain("kept task t-3: Opened one");
  });

  it("says when there is nothing to undo", () => {
    expect(
      formatUndoImportText({ batchId: "b", removed: [], kept: [] }),
    ).toContain("Nothing to undo");
    expect(
      formatImportResultText(
        { imported: [], skipped: [], leftOut: {} },
        new Map(),
      ),
    ).toBe("Imported 0 tasks.");
  });
});
