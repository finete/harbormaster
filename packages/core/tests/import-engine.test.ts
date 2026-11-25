// The import engine (docs/import.md "Engine"): grouping, dedupe, titles,
// hidden reasons, preselect, running (I3, I13), fork capability, left-out.

import { describe, expect, it } from "vitest";
import type {
  ImportOrchestratorRecord,
  ImportPullRequestInfo,
  ImportSessionRecord,
  RunningAgentProcess,
} from "../src/contracts/import.js";
import {
  buildImportCandidates,
  countLeftOut,
  humanizeBranch,
  type ImportEngineInput,
  type ImportFolderFacts,
  importCandidateId,
  proposeTitle,
  summarizeImport,
} from "../src/engines/import.js";

const NOW = new Date("2026-11-24T12:00:00Z");
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 86_400_000).toISOString();

function session(over: Partial<ImportSessionRecord> = {}): ImportSessionRecord {
  return {
    harness: "claude-code",
    sessionId: "s1",
    sessionPath: "/store/s1.jsonl",
    cwd: "/code/app-wt",
    lastActiveAt: daysAgo(1),
    userPrompts: 5,
    ...over,
  };
}

const WORKTREE: ImportFolderFacts = {
  exists: true,
  kind: "worktree",
  repositoryId: "github.com/acme/app",
  groupLabel: "acme/app",
  branch: "feature/add-login",
};

function run(
  over: Partial<ImportEngineInput> & { sessions?: ImportSessionRecord[] },
) {
  const input: ImportEngineInput = {
    sessions: [],
    orchestrations: [],
    running: [],
    canonical: (path) => path,
    facts: () => WORKTREE,
    board: {
      folders: new Map(),
      sessionIds: new Map(),
      sessionPaths: new Map(),
    },
    pullRequest: () => undefined,
    canFork: (harness) => harness !== "cursor",
    now: NOW,
    ...over,
  };
  return buildImportCandidates(input);
}
const only = (groups: ReturnType<typeof run>) => {
  expect(groups).toHaveLength(1);
  expect(groups[0]?.candidates).toHaveLength(1);
  return groups[0]?.candidates[0] as NonNullable<
    ReturnType<typeof run>[0]
  >["candidates"][0];
};

describe("merging per folder", () => {
  it("one candidate per canonical folder across harnesses; the newest session is the default", () => {
    const groups = run({
      sessions: [
        session({ sessionId: "old", lastActiveAt: daysAgo(5) }),
        session({
          harness: "codex",
          sessionId: "new",
          lastActiveAt: daysAgo(1),
          cwd: "/link/app-wt",
        }),
      ],
      canonical: (path) => path.replace("/link", "/code"),
    });
    const candidate = only(groups);
    expect(candidate.sessions.map((s) => s.sessionId)).toEqual(["new", "old"]);
    expect(candidate.defaultSessionId).toBe("new");
    expect(candidate.sources.sort()).toEqual(["claude-code", "codex"]);
    expect(candidate.id).toBe(importCandidateId("/code/app-wt"));
    expect(candidate.kind).toBe("worktree");
    expect(candidate.branch).toBe("feature/add-login");
  });

  it("an orchestrator record joins on cwd and gives the workspace title (I7)", () => {
    const record: ImportOrchestratorRecord = {
      source: "herdr",
      orchestratorSession: "default",
      workspaceName: "Login rework",
      cwd: "/code/app-wt",
      sessions: [],
      running: false,
    };
    const candidate = only(
      run({
        sessions: [session({ title: "A session" })],
        orchestrations: [record],
      }),
    );
    expect(candidate).toMatchObject({
      title: "Login rework",
      titleSource: "herdr",
    });
    expect(candidate.sources).toContain("herdr");
  });

  it("an orchestrator record joins on a session id even when its cwd differs", () => {
    const record: ImportOrchestratorRecord = {
      source: "herdr",
      orchestratorSession: "default",
      workspaceName: "Elsewhere",
      cwd: "/somewhere/else",
      sessions: [{ agent: "claude", harness: "claude-code", sessionId: "s1" }],
      running: false,
    };
    const groups = run({ sessions: [session()], orchestrations: [record] });
    expect(only(groups).titleSource).toBe("herdr");
  });

  it("an orchestrator record alone (no sessions) makes no candidate", () => {
    const record: ImportOrchestratorRecord = {
      source: "herdr",
      orchestratorSession: "default",
      cwd: "/x",
      sessions: [],
      running: false,
    };
    expect(run({ orchestrations: [record] })).toEqual([]);
  });
});

describe("titles (I7)", () => {
  it("falls through workspace → PR → session → branch → folder", () => {
    const base = { folderPath: "/code/app-wt" };
    expect(
      proposeTitle({
        ...base,
        workspaceName: "W",
        pullRequestTitle: "P",
        sessionTitle: "S",
        branch: "b",
      }).source,
    ).toBe("herdr");
    expect(
      proposeTitle({
        ...base,
        pullRequestTitle: "P",
        sessionTitle: "S",
        branch: "b",
      }),
    ).toEqual({ title: "P", source: "pull-request" });
    expect(proposeTitle({ ...base, sessionTitle: "S", branch: "b" })).toEqual({
      title: "S",
      source: "session",
    });
    expect(proposeTitle({ ...base, branch: "feature/add-login_form" })).toEqual(
      { title: "Add login form", source: "branch" },
    );
    expect(proposeTitle({ ...base, branch: "main" })).toEqual({
      title: "app-wt",
      source: "folder",
    });
    expect(proposeTitle(base).source).toBe("folder");
    expect(humanizeBranch("fix-it")).toBe("Fix it");
  });

  it("uses the PR title for a worktree item but never for a plain folder", () => {
    const pr: ImportPullRequestInfo = {
      number: 4,
      url: "u",
      title: "Add login",
      state: "open",
    };
    expect(
      only(run({ sessions: [session()], pullRequest: () => pr })),
    ).toMatchObject({ title: "Add login", titleSource: "pull-request" });
    const folder = only(
      run({
        sessions: [session()],
        facts: () => ({ exists: true, kind: "folder" }),
        pullRequest: () => pr,
      }),
    );
    expect(folder.pullRequest).toBeUndefined();
  });
});

describe("dedupe against the board", () => {
  it("a worktree already held by a task (any state, archived included) is on-board and not selectable", () => {
    const candidate = only(
      run({
        sessions: [session()],
        board: {
          folders: new Map([["/code/app-wt", "task-1"]]),
          sessionIds: new Map(),
          sessionPaths: new Map(),
        },
      }),
    );
    expect(candidate).toMatchObject({
      blocked: "on-board",
      onBoardTaskId: "task-1",
      preselected: false,
    });
  });

  it("matches on session id and on session path too", () => {
    const byId = only(
      run({
        sessions: [session()],
        board: {
          folders: new Map(),
          sessionIds: new Map([["s1", "t2"]]),
          sessionPaths: new Map(),
        },
      }),
    );
    expect(byId.onBoardTaskId).toBe("t2");
    const byPath = only(
      run({
        sessions: [session()],
        board: {
          folders: new Map(),
          sessionIds: new Map(),
          sessionPaths: new Map([["/store/s1.jsonl", "t3"]]),
        },
      }),
    );
    expect(byPath.onBoardTaskId).toBe("t3");
  });
});

describe("hidden reasons and preselect (I5, I6)", () => {
  it("tiny: every session under 3 prompts", () => {
    expect(only(run({ sessions: [session({ userPrompts: 2 })] })).hidden).toBe(
      "tiny",
    );
    expect(
      only(
        run({
          sessions: [
            session({ userPrompts: 2 }),
            session({ sessionId: "b", userPrompts: 3 }),
          ],
        }),
      ).hidden,
    ).toBeUndefined();
  });
  it("folder-missing, not-a-project, harbormaster-leftover", () => {
    expect(
      only(
        run({
          sessions: [session()],
          facts: () => ({ ...WORKTREE, exists: false }),
        }),
      ).hidden,
    ).toBe("folder-missing");
    expect(
      only(
        run({ sessions: [session({ cwd: "/home/me" })], homeDir: "/home/me" }),
      ).hidden,
    ).toBe("not-a-project");
    expect(
      only(
        run({
          sessions: [session({ cwd: "/state/worktrees/app/x" })],
          worktreesRoot: "/state/worktrees",
        }),
      ).hidden,
    ).toBe("harbormaster-leftover");
    // a worktree a task holds is on-board, not a leftover
    const held = only(
      run({
        sessions: [session({ cwd: "/state/worktrees/app/x" })],
        worktreesRoot: "/state/worktrees",
        board: {
          folders: new Map([["/state/worktrees/app/x", "t"]]),
          sessionIds: new Map(),
          sessionPaths: new Map(),
        },
      }),
    );
    expect(held.hidden).toBeUndefined();
  });
  it("a hidden item stays selectable but is not preselected; tiny beats missing", () => {
    const candidate = only(
      run({
        sessions: [session({ userPrompts: 1 })],
        facts: () => ({ ...WORKTREE, exists: false }),
      }),
    );
    expect(candidate).toMatchObject({ hidden: "tiny", preselected: false });
    expect(candidate.blocked).toBeUndefined();
  });
  it("30-day window and `includeOlder`; 7-day preselect", () => {
    const sessions = [session({ lastActiveAt: daysAgo(40) })];
    expect(run({ sessions })).toEqual([]);
    expect(only(run({ sessions, includeOlder: true })).preselected).toBe(false);
    expect(
      only(run({ sessions: [session({ lastActiveAt: daysAgo(6) })] }))
        .preselected,
    ).toBe(true);
    expect(
      only(run({ sessions: [session({ lastActiveAt: daysAgo(8) })] }))
        .preselected,
    ).toBe(false);
  });
  it("a merged or closed PR is listed unticked with its state", () => {
    for (const state of ["merged", "closed"] as const) {
      const candidate = only(
        run({
          sessions: [session()],
          pullRequest: () => ({ number: 1, url: "u", state }),
        }),
      );
      expect(candidate.preselected).toBe(false);
      expect(candidate.pullRequest?.state).toBe(state);
    }
    expect(
      only(
        run({
          sessions: [session()],
          pullRequest: () => ({ number: 1, url: "u", state: "draft" }),
        }),
      ).preselected,
    ).toBe(true);
  });
});

describe("running elsewhere (I3, I13)", () => {
  const proc = (over: Partial<RunningAgentProcess>): RunningAgentProcess => ({
    harness: "pi",
    pid: 10,
    cwd: "/code/app-wt",
    ...over,
  });

  it("Claude with a published session id marks exactly that session", () => {
    const candidate = only(
      run({
        sessions: [
          session({ sessionId: "live" }),
          session({ sessionId: "other", lastActiveAt: daysAgo(3) }),
        ],
        running: [proc({ harness: "claude-code", sessionId: "other" })],
      }),
    );
    expect(
      candidate.sessions.find((s) => s.sessionId === "other")?.running,
    ).toMatchObject({ where: "terminal", precision: "session" });
    expect(
      candidate.sessions.find((s) => s.sessionId === "live")?.running,
    ).toBeUndefined();
    // the default (newest) session is free: the row is selectable, the picker shows the other one running
    expect(candidate.blocked).toBeUndefined();
  });

  it("Pi / Codex / Cursor are conservative: EVERY session of that harness in the folder is running", () => {
    for (const harness of ["pi", "codex", "cursor"]) {
      const candidate = only(
        run({
          sessions: [
            session({ harness, sessionId: "a" }),
            session({ harness, sessionId: "b", lastActiveAt: daysAgo(4) }),
            session({
              harness: "claude-code",
              sessionId: "c",
              lastActiveAt: daysAgo(2),
            }),
          ],
          running: [proc({ harness })],
        }),
      );
      const marked = candidate.sessions
        .filter((s) => s.running)
        .map((s) => s.sessionId)
        .sort();
      expect(marked).toEqual(["a", "b"]);
      expect(
        candidate.sessions.find((s) => s.sessionId === "a")?.running?.precision,
      ).toBe("folder");
      expect(candidate.blocked).toBe("running");
    }
  });

  it("a Claude process without a session id is folder-level for every Claude session there", () => {
    const candidate = only(
      run({
        sessions: [
          session({ sessionId: "a" }),
          session({ sessionId: "b", lastActiveAt: daysAgo(2) }),
        ],
        running: [proc({ harness: "claude-code" })],
      }),
    );
    expect(
      candidate.sessions.every((s) => s.running?.precision === "folder"),
    ).toBe(true);
  });

  it("a process in another folder marks nothing", () => {
    const candidate = only(
      run({
        sessions: [session({ harness: "pi" })],
        running: [proc({ cwd: "/code/other" })],
      }),
    );
    expect(candidate.blocked).toBeUndefined();
  });

  it("herdr says running: a ref with the session id is session-exact, a bare agent is folder-level; herdr names the place", () => {
    const record = (
      refs: ImportOrchestratorRecord["sessions"],
    ): ImportOrchestratorRecord => ({
      source: "herdr",
      orchestratorSession: "default",
      cwd: "/code/app-wt",
      sessions: refs,
      running: true,
    });
    const exact = only(
      run({
        sessions: [
          session({ harness: "pi", sessionId: "a" }),
          session({ harness: "pi", sessionId: "b", lastActiveAt: daysAgo(3) }),
        ],
        orchestrations: [
          record([{ agent: "pi", harness: "pi", sessionId: "b" }]),
        ],
      }),
    );
    expect(
      exact.sessions.find((s) => s.sessionId === "b")?.running,
    ).toMatchObject({ where: "herdr", precision: "session" });
    // the other Pi session in the folder is conservatively running too (the herdr pane's agent is a Pi)
    expect(
      exact.sessions.find((s) => s.sessionId === "a")?.running,
    ).toMatchObject({ where: "herdr", precision: "folder" });
    // herdr + a process for the same session: herdr wins as the place
    const both = only(
      run({
        sessions: [session({ harness: "pi", sessionId: "a" })],
        orchestrations: [record([])],
        running: [proc({ harness: "pi" })],
      }),
    );
    expect(both.sessions[0]?.running?.where).toBe("herdr");
    expect(both.sessions[0]?.running?.message).toContain("Running in herdr");
  });

  it("fork support comes from the capability: Cursor says close it, others offer a fork", () => {
    const cursor = only(
      run({
        sessions: [session({ harness: "cursor" })],
        running: [proc({ harness: "cursor" })],
      }),
    );
    expect(cursor.sessions[0]).toMatchObject({ canFork: false });
    expect(cursor.sessions[0]?.running?.message).not.toContain("fork");
    const pi = only(
      run({
        sessions: [session({ harness: "pi" })],
        running: [proc({ harness: "pi" })],
      }),
    );
    expect(pi.sessions[0]).toMatchObject({ canFork: true });
    expect(pi.sessions[0]?.running?.message).toContain("fork it");
    const asked: string[] = [];
    run({
      sessions: [session({ harness: "x-custom" })],
      canFork: (h) => {
        asked.push(h);
        return false;
      },
    });
    expect(asked).toEqual(["x-custom"]);
  });
});

describe("grouping, sorting, left out", () => {
  it("groups by repository, newest first; non-git folders are their own groups", () => {
    const groups = run({
      sessions: [
        session({ cwd: "/code/a-1", lastActiveAt: daysAgo(3), sessionId: "1" }),
        session({ cwd: "/code/a-2", lastActiveAt: daysAgo(1), sessionId: "2" }),
        session({
          cwd: "/code/notes",
          lastActiveAt: daysAgo(2),
          sessionId: "3",
        }),
      ],
      facts: (folder) =>
        folder === "/code/notes"
          ? { exists: true, kind: "folder" }
          : { ...WORKTREE, groupLabel: "acme/a" },
    });
    expect(groups.map((g) => g.id)).toEqual([
      "github.com/acme/app",
      "folder:/code/notes",
    ]);
    expect(groups[0]?.candidates.map((c) => c.defaultSessionId)).toEqual([
      "2",
      "1",
    ]);
    expect(groups[1]?.label).toBe("notes");
  });

  it("counts running and folder-missing as left out, never tiny / on-board; imported (forked) ones are not", () => {
    const groups = run({
      sessions: [
        session({ cwd: "/code/run", sessionId: "r", harness: "pi" }),
        session({ cwd: "/code/gone", sessionId: "g" }),
        session({ cwd: "/code/tiny", sessionId: "t", userPrompts: 1 }),
        session({ cwd: "/code/board", sessionId: "b" }),
        session({ cwd: "/code/forked", sessionId: "f", harness: "pi" }),
      ],
      running: [
        { harness: "pi", pid: 1, cwd: "/code/run" },
        { harness: "pi", pid: 2, cwd: "/code/forked" },
      ],
      facts: (folder) => ({ ...WORKTREE, exists: folder !== "/code/gone" }),
      board: {
        folders: new Map([["/code/board", "t"]]),
        sessionIds: new Map(),
        sessionPaths: new Map(),
      },
    });
    const forkedId = importCandidateId("/code/forked");
    expect(countLeftOut(groups, new Set([forkedId]), [])).toEqual({
      running: 1,
      "folder-missing": 1,
    });
    expect(
      countLeftOut(groups, new Set(), [{ candidateId: "x", reason: "error" }]),
    ).toEqual({ running: 2, "folder-missing": 1, error: 1 });
  });

  it("summary title names sources and the left-out reasons", () => {
    expect(
      summarizeImport(12, ["Claude Code", "Codex", "herdr"], {
        running: 2,
        "folder-missing": 1,
      }).title,
    ).toBe(
      "Imported 12 tasks from Claude Code, Codex and herdr · 3 left out (running elsewhere: 2, folder missing: 1)",
    );
    expect(summarizeImport(1, ["Pi"], {}).title).toBe(
      "Imported 1 task from Pi",
    );
  });
});
