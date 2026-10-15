// Pure engine tests: feed plain fixture data into `planMigration`, assert
// the mapping per column/kind, no filesystem or process involved.

import { describe, expect, it } from "vitest";
import type {
  BeadsIssue,
  PiHomeState,
  PiHomeTemporaryWorkspace,
  PiHomeWorkspaceBinding,
} from "../../src/migration/contracts.js";
import { planMigration } from "../../src/migration/engine/migration-planner.js";

function repo(overrides: Partial<PiHomeWorkspaceBinding["repository"]> = {}) {
  return {
    id: "github.com/acme/widgets",
    name: "widgets",
    remote: "git@github.com:acme/widgets.git",
    preferredCheckout: "/Users/x/Code/widgets",
    defaultBranch: "main",
    ...overrides,
  };
}

function binding(
  overrides: Partial<PiHomeWorkspaceBinding> = {},
): PiHomeWorkspaceBinding {
  return {
    id: "binding-1",
    issueId: "pih-aaa",
    repository: repo(),
    worktreePath: "/Users/x/Code/.pi-home-worktrees/widgets/do-thing-binding1",
    branch: "moshe/do-thing-binding1",
    sessionPath: "/Users/x/.pi/agent/sessions/binding1.jsonl",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function issue(overrides: Partial<BeadsIssue> = {}): BeadsIssue {
  return {
    id: "pih-aaa",
    title: "Do the thing",
    description: "Please do the thing.",
    status: "in_progress",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function temp(
  overrides: Partial<PiHomeTemporaryWorkspace> = {},
): PiHomeTemporaryWorkspace {
  return {
    id: "temp-1",
    kind: "temp_task",
    state: "dev",
    title: "Quick scratch task",
    initialPrompt: "do a quick thing",
    sessionPath: "/Users/x/.pi/agent/sessions/temp1.jsonl",
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T01:00:00.000Z",
    stateChangedAt: "2026-02-01T01:00:00.000Z",
    ...overrides,
  };
}

function emptyState(): PiHomeState {
  return { version: 4, workspaceBindings: [], temporaryWorkspaces: [] };
}

function nextId(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

describe("planMigration — permanent (Beads-backed) tasks", () => {
  it("maps dev-column state from Beads in_progress status", () => {
    const plan = planMigration({
      piHome: { ...emptyState(), workspaceBindings: [binding()] },
      beadsIssuesById: new Map([["pih-aaa", issue({ status: "in_progress" })]]),
      alreadyImported: new Set(),
      worktreeExists: new Map(),
      nextId: nextId(),
    });

    expect(plan.results).toEqual([
      { pihomeIssueId: "pih-aaa", title: "Do the thing", status: "imported" },
    ]);
    expect(plan.toImport).toHaveLength(1);
    const { task } = plan.toImport[0]!;
    expect(task.state).toBe("dev");
    expect(task.title).toBe("Do the thing");
    expect(task.initialPrompt).toBe("Please do the thing.");
    expect(task.kind).toBe("task");
    expect(task.repositoryId).toBe("github.com/acme/widgets");
    expect(task.targetBranch).toBe("main");
    expect(task.pihomeIssueId).toBe("pih-aaa");
    expect(task.awaiting).toBeUndefined();
  });

  it("maps review/awaiting_prod/awaiting_slack to the three awaiting kinds", () => {
    const cases: Array<{ status: string; expect: object }> = [
      { status: "review", expect: { kind: "review" } },
      {
        status: "awaiting_slack",
        expect: { kind: "slack", permalink: "https://acme.slack.com/p/123" },
      },
      {
        status: "awaiting_prod",
        expect: {
          kind: "deploy",
          stageId: "prod",
          stageLabel: "Production deploy",
        },
      },
    ];

    for (const testCase of cases) {
      const awaitingContext =
        testCase.status === "awaiting_slack"
          ? ({
              kind: "slack",
              since: "2026-01-03T00:00:00.000Z",
              url: "https://acme.slack.com/p/123",
            } as const)
          : testCase.status === "awaiting_prod"
            ? ({
                kind: "production",
                since: "2026-01-03T00:00:00.000Z",
                stage: { id: "prod", label: "Production deploy" },
              } as const)
            : undefined;

      const plan = planMigration({
        piHome: {
          ...emptyState(),
          workspaceBindings: [binding({ awaiting: awaitingContext })],
        },
        beadsIssuesById: new Map([
          ["pih-aaa", issue({ status: testCase.status })],
        ]),
        alreadyImported: new Set(),
        worktreeExists: new Map(),
        nextId: nextId(),
      });

      const { task } = plan.toImport[0]!;
      expect(task.state).toBe("awaiting");
      expect(task.awaiting).toEqual(testCase.expect);
    }
  });

  it("falls back to the stage-less __production wait when the deploy context has no stage", () => {
    const plan = planMigration({
      piHome: {
        ...emptyState(),
        workspaceBindings: [
          binding({
            awaiting: { kind: "production", since: "2026-01-03T00:00:00.000Z" },
          }),
        ],
      },
      beadsIssuesById: new Map([
        ["pih-aaa", issue({ status: "awaiting_prod" })],
      ]),
      alreadyImported: new Set(),
      worktreeExists: new Map(),
      nextId: nextId(),
    });
    expect(plan.toImport[0]!.task.awaiting).toEqual({
      kind: "deploy",
      stageId: "__production",
      stageLabel: "Production deploy",
    });
  });

  it("maps closed to done and preserves completedAt/archivedAt/createdAt/updatedAt", () => {
    const plan = planMigration({
      piHome: {
        ...emptyState(),
        workspaceBindings: [
          binding({
            completedAt: "2026-01-05T00:00:00.000Z",
            archivedAt: "2026-01-10T00:00:00.000Z",
          }),
        ],
      },
      beadsIssuesById: new Map([["pih-aaa", issue({ status: "closed" })]]),
      alreadyImported: new Set(),
      worktreeExists: new Map(),
      nextId: nextId(),
    });
    const { task } = plan.toImport[0]!;
    expect(task.state).toBe("done");
    expect(task.completedAt).toBe("2026-01-05T00:00:00.000Z");
    expect(task.archivedAt).toBe("2026-01-10T00:00:00.000Z");
    expect(task.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(task.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("keeps the worktreePath only when it is verified present on disk, else omits it (binding kept)", () => {
    const present = binding({
      id: "b1",
      issueId: "pih-present",
      worktreePath: "/exists",
    });
    const gone = binding({
      id: "b2",
      issueId: "pih-gone",
      worktreePath: "/gone",
    });
    const plan = planMigration({
      piHome: { ...emptyState(), workspaceBindings: [present, gone] },
      beadsIssuesById: new Map([
        ["pih-present", issue({ id: "pih-present", status: "in_progress" })],
        ["pih-gone", issue({ id: "pih-gone", status: "in_progress" })],
      ]),
      alreadyImported: new Set(),
      worktreeExists: new Map([
        ["/exists", true],
        ["/gone", false],
      ]),
      nextId: nextId(),
    });
    const byIssue = Object.fromEntries(
      plan.toImport.map((candidate) => [
        candidate.task.pihomeIssueId,
        candidate,
      ]),
    );
    expect(byIssue["pih-present"]!.binding.worktreePath).toBe("/exists");
    expect(byIssue["pih-present"]!.binding.branch).toBe(
      "moshe/do-thing-binding1",
    );
    expect(byIssue["pih-gone"]!.binding.worktreePath).toBeUndefined();
  });

  it("copies sessionPath and previousSessionPath onto the binding for continuity", () => {
    const plan = planMigration({
      piHome: {
        ...emptyState(),
        workspaceBindings: [
          binding({
            sessionPath: "/sessions/current.jsonl",
            previousSessionPath: "/sessions/previous.jsonl",
          }),
        ],
      },
      beadsIssuesById: new Map([["pih-aaa", issue()]]),
      alreadyImported: new Set(),
      worktreeExists: new Map(),
      nextId: nextId(),
    });
    expect(plan.toImport[0]!.binding.sessionPath).toBe(
      "/sessions/current.jsonl",
    );
    expect(plan.toImport[0]!.binding.previousSessionPath).toBe(
      "/sessions/previous.jsonl",
    );
  });

  it("warns and skips a binding with no matching Beads issue", () => {
    const plan = planMigration({
      piHome: {
        ...emptyState(),
        workspaceBindings: [binding({ issueId: "pih-missing" })],
      },
      beadsIssuesById: new Map(),
      alreadyImported: new Set(),
      worktreeExists: new Map(),
      nextId: nextId(),
    });
    expect(plan.toImport).toHaveLength(0);
    expect(plan.results[0]!.status).toBe("warning");
    expect(plan.results[0]!.reason).toMatch(/no Beads issue found/);
  });

  it("is idempotent: skips a binding whose issueId is already imported", () => {
    const plan = planMigration({
      piHome: { ...emptyState(), workspaceBindings: [binding()] },
      beadsIssuesById: new Map([["pih-aaa", issue()]]),
      alreadyImported: new Set(["pih-aaa"]),
      worktreeExists: new Map(),
      nextId: nextId(),
    });
    expect(plan.toImport).toHaveLength(0);
    expect(plan.results[0]).toEqual({
      pihomeIssueId: "pih-aaa",
      title: "pih-aaa",
      status: "skipped",
      reason: "already imported (pihomeIssueId matches an existing task)",
    });
  });

  it("normalizes repositoryId from the remote the same way core's own git access does", () => {
    const plan = planMigration({
      piHome: {
        ...emptyState(),
        workspaceBindings: [
          binding({
            repository: repo({
              remote: "https://user@GitHub.com/Acme/Widgets.git",
            }),
          }),
        ],
      },
      beadsIssuesById: new Map([["pih-aaa", issue()]]),
      alreadyImported: new Set(),
      worktreeExists: new Map(),
      nextId: nextId(),
    });
    expect(plan.toImport[0]!.task.repositoryId).toBe("github.com/acme/widgets");
  });
});

describe("planMigration — temporary (scratch) tasks", () => {
  it("maps kind temp_task to task, flagging it with a [temp] title suffix", () => {
    const plan = planMigration({
      piHome: { ...emptyState(), temporaryWorkspaces: [temp()] },
      beadsIssuesById: new Map(),
      alreadyImported: new Set(),
      worktreeExists: new Map(),
      nextId: nextId(),
    });
    const { task } = plan.toImport[0]!;
    expect(task.kind).toBe("task");
    expect(task.title).toBe("Quick scratch task [temp]");
    expect(task.state).toBe("dev");
    expect(task.initialPrompt).toBe("do a quick thing");
    expect(task.pihomeIssueId).toBe("temp-1");
  });

  it("maps a done temp task and preserves its timestamps", () => {
    const plan = planMigration({
      piHome: {
        ...emptyState(),
        temporaryWorkspaces: [
          temp({
            state: "done",
            completedAt: "2026-02-02T00:00:00.000Z",
            archivedAt: "2026-02-03T00:00:00.000Z",
          }),
        ],
      },
      beadsIssuesById: new Map(),
      alreadyImported: new Set(),
      worktreeExists: new Map(),
      nextId: nextId(),
    });
    const { task } = plan.toImport[0]!;
    expect(task.state).toBe("done");
    expect(task.completedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(task.archivedAt).toBe("2026-02-03T00:00:00.000Z");
  });

  it("is idempotent: skips a temporary workspace already imported by id", () => {
    const plan = planMigration({
      piHome: { ...emptyState(), temporaryWorkspaces: [temp()] },
      beadsIssuesById: new Map(),
      alreadyImported: new Set(["temp-1"]),
      worktreeExists: new Map(),
      nextId: nextId(),
    });
    expect(plan.toImport).toHaveLength(0);
    expect(plan.results[0]!.status).toBe("skipped");
  });

  it("verifies worktree existence for a repository-backed temp task same as permanent tasks", () => {
    const plan = planMigration({
      piHome: {
        ...emptyState(),
        temporaryWorkspaces: [
          temp({
            repository: repo(),
            branch: "moshe/temp-branch",
            worktreePath:
              "/Users/x/Code/.pi-home-worktrees/widgets/temp-branch",
          }),
        ],
      },
      beadsIssuesById: new Map(),
      alreadyImported: new Set(),
      worktreeExists: new Map([
        ["/Users/x/Code/.pi-home-worktrees/widgets/temp-branch", true],
      ]),
      nextId: nextId(),
    });
    expect(plan.toImport[0]!.binding.worktreePath).toBe(
      "/Users/x/Code/.pi-home-worktrees/widgets/temp-branch",
    );
    expect(plan.toImport[0]!.task.repositoryId).toBe("github.com/acme/widgets");
  });
});

describe("bindingless Beads issues", () => {
  it("imports an open issue with no workspace binding as a plain backlog task", () => {
    const issue = {
      id: "pih-nobind",
      title: "Pure backlog idea",
      description: "just an idea",
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const plan = planMigration({
      piHome: { workspaceBindings: [], temporaryWorkspaces: [] },
      beadsIssuesById: new Map([[issue.id, issue]]),
      alreadyImported: new Set(),
      worktreeExists: new Map(),
      nextId: () => "task-1",
    });
    expect(plan.toImport).toHaveLength(1);
    const candidate = plan.toImport[0];
    expect(candidate?.binding).toBeUndefined();
    expect(candidate?.task).toMatchObject({
      title: "Pure backlog idea",
      state: "backlog",
      pihomeIssueId: "pih-nobind",
    });
  });

  it("skips bindingless issues already imported", () => {
    const issue = {
      id: "pih-nobind",
      title: "Pure backlog idea",
      description: "",
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const plan = planMigration({
      piHome: { workspaceBindings: [], temporaryWorkspaces: [] },
      beadsIssuesById: new Map([[issue.id, issue]]),
      alreadyImported: new Set(["pih-nobind"]),
      worktreeExists: new Map(),
      nextId: () => "task-1",
    });
    expect(plan.toImport).toHaveLength(0);
  });
});
