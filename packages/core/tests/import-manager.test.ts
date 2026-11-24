// Import through the manager (docs/import.md "Manager", "External ownership",
// "Undo", "Inbox summary"): importItems creates the tasks, undoImport removes
// the untouched ones, and an External (imported) worktree survives EVERY
// cleanup path. The readers and the process table are fakes of OUR wiring;
// the stores' real formats are covered by import-readers.test.ts.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonConfigAccess } from "../src/access/json-config-access.js";
import { JsonInboxAccess } from "../src/access/json-inbox-access.js";
import { JsonTaskStateAccess } from "../src/access/json-task-state-access.js";
import { JsonWorkspaceBindingAccess } from "../src/access/json-workspace-binding-access.js";
import { isToDoneConfirmation } from "../src/contracts/commands.js";
import type {
  PullRequestAccess,
  PullRequestStatus,
  VersionAccess,
} from "../src/contracts/github.js";
import type {
  ImportSessionRecord,
  ImportSourceReader,
  RunningAgentProcess,
} from "../src/contracts/import.js";
import type { Task } from "../src/contracts/model.js";
import type { AuditEntry } from "../src/contracts/rules.js";
import type {
  GitFolderInspection,
  GitRepositoryAccess,
  GitWorktreeAccess,
  RepositoryInfo,
} from "../src/contracts/workspace.js";
import { createHarnessRegistry } from "../src/harness/registry.js";
import { CoreManager } from "../src/manager/core-manager.js";
import { CoreEventBus } from "../src/utilities/event-bus.js";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const hoursAgo = (n: number) =>
  new Date(NOW.getTime() - n * 3_600_000).toISOString();

const REPO: RepositoryInfo = {
  id: "github.com/acme/app",
  root: "/code/app",
  defaultBranch: "main",
  checkouts: [{ root: "/code/app", isPrimary: true }],
};
const WT = "/wt/feature-login";
const OTHER_REPO_MAIN = "/code/unknown";
const OTHER_WT = "/wt/unknown-feature";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    dirs
      .splice(0)
      .map((d) =>
        rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
  );
});

class FakePullRequests implements PullRequestAccess {
  statuses = new Map<string, PullRequestStatus>();
  failing = false;
  async status() {
    return undefined;
  }
  async statusMany(_repo: string, branches: readonly string[]) {
    if (this.failing) throw new Error("gh: not logged in");
    return new Map(branches.map((b) => [b, this.statuses.get(b)]));
  }
  async ensureOpen(): Promise<PullRequestStatus> {
    throw new Error("x");
  }
  async squashMerge(): Promise<PullRequestStatus> {
    throw new Error("x");
  }
  async containsCommit() {
    return true;
  }
  async commitLog() {
    return [];
  }
}
class NoVersions implements VersionAccess {
  async fetchText(url: string): Promise<string> {
    throw new Error(url);
  }
}

function record(over: Partial<ImportSessionRecord> = {}): ImportSessionRecord {
  return {
    harness: "claude-code",
    sessionId: "sess-1",
    sessionPath: "/store/sess-1.jsonl",
    cwd: WT,
    lastActiveAt: hoursAgo(2),
    userPrompts: 5,
    title: "Fix login",
    ...over,
  };
}

async function build(
  options: {
    sessions?: ImportSessionRecord[];
    running?: RunningAgentProcess[];
    existing?: string[];
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "harbormaster-import-"));
  dirs.push(dir);
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({ automation: false }),
  );
  const clock = { current: NOW, now: () => clock.current };
  const tasks = new JsonTaskStateAccess(join(dir, "tasks.json"));
  const bindings = new JsonWorkspaceBindingAccess(
    join(dir, "workspace-bindings.json"),
  );
  const inbox = new JsonInboxAccess(
    join(dir, "inbox.json"),
    join(dir, "inbox.lock"),
  );
  const audit: AuditEntry[] = [];
  const existing = new Set(
    options.existing ?? [
      WT,
      "/code/app",
      OTHER_WT,
      OTHER_REPO_MAIN,
      "/code/notes",
    ],
  );
  const registered: string[] = [];
  const state = {
    sessions: options.sessions ?? [record()],
    running: options.running ?? [],
  };
  const inspections = new Map<string, GitFolderInspection>([
    [
      WT,
      {
        kind: "worktree",
        repositoryId: REPO.id,
        mainCheckout: "/code/app",
        branch: "feature-login",
      },
    ],
    [
      OTHER_WT,
      {
        kind: "worktree",
        repositoryId: "github.com/acme/unknown",
        mainCheckout: OTHER_REPO_MAIN,
        branch: "other",
      },
    ],
    [
      "/code/app",
      {
        kind: "checkout",
        repositoryId: REPO.id,
        mainCheckout: "/code/app",
        branch: "main",
      },
    ],
  ]);
  const worktrees = {
    canonicalPath: async (path: string) => path,
    removeWorktree: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    pruneWorktrees: vi.fn(async () => {}),
    deleteWorktreeDir: vi.fn(async () => {}),
    createTaskWorktree: vi.fn(async (_r: RepositoryInfo, branch: string) => ({
      path: `/wt/new-${branch}`,
      branch,
      head: "abc",
      detached: false,
    })),
    resolveDefaultBase: async () => ({
      ref: "main",
      source: "local" as const,
      reason: "test",
    }),
    listWorktrees: vi.fn(async () => [
      { path: WT, branch: "feature-login", head: "a", detached: false },
    ]),
    uncommittedChangeCount: vi.fn(async () => 2),
    isWorktreeDirty: vi.fn(async () => true),
    branchExists: vi.fn(async () => true),
  };
  const folders = {
    isDirectory: async (p: string) => existing.has(p),
    registerFolder: vi.fn(async (p: string) => {
      registered.push(p);
      return p;
    }),
    listRegisteredFolders: async () => registered,
  };
  const repositories = {
    discoverRepositories: async () => [REPO],
    resolveRepository: async (path: string) => ({
      id: path === OTHER_REPO_MAIN ? "github.com/acme/unknown" : REPO.id,
      root: path,
      defaultBranch: "main",
      checkouts: [{ root: path, isPrimary: true }],
    }),
    inspectFolder: async (path: string) =>
      inspections.get(path) ?? { kind: "folder" as const },
  };
  const reader: ImportSourceReader = {
    id: "claude-code",
    label: "Claude Code",
    read: async () => ({ sessions: state.sessions, orchestrations: [] }),
  };
  const pullRequests = new FakePullRequests();
  const manager = new CoreManager({
    tasks,
    clock,
    ids: {
      next: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    },
    events: new CoreEventBus(),
    config: new JsonConfigAccess(join(dir, "config.json")),
    repositories: repositories as unknown as GitRepositoryAccess,
    worktrees: worktrees as unknown as GitWorktreeAccess,
    bindings,
    sessions: { exists: async () => true } as never,
    scratch: {} as never,
    pullRequests,
    versions: new NoVersions(),
    folders: folders as never,
    harnesses: createHarnessRegistry({ stateDir: dir }),
    inbox,
    importReaders: [reader],
    importProcesses: { listRunningAgents: async () => state.running },
    importHome: "/home/me",
    worktreesRoot: "/state/worktrees",
    rules: {
      files: { writeManaged: async () => {} } as never,
      state: {} as never,
      audit: {
        append: async (e: AuditEntry[]) => {
          audit.push(...e);
        },
        read: async () => audit,
      },
    },
  });
  const listing = async () => manager.listImportCandidates();
  const candidateFor = async (folder: string) =>
    (await listing()).groups
      .flatMap((g) => g.candidates)
      .find((c) => c.folderPath === folder);
  return {
    manager,
    tasks,
    bindings,
    inbox,
    worktrees,
    folders,
    registered,
    state,
    pullRequests,
    audit,
    clock,
    existing,
    candidateFor,
    listing,
  };
}

async function importWorktree(h: Awaited<ReturnType<typeof build>>) {
  const candidate = await h.candidateFor(WT);
  if (!candidate) throw new Error("no candidate");
  const result = await h.manager.importItems({
    items: [
      {
        candidateId: candidate.id,
        sessionId: candidate.defaultSessionId,
        title: "Fix login",
      },
    ],
  });
  const taskId = result.imported[0]?.taskId as string;
  return {
    result,
    taskId,
    task: (await h.tasks.getTask(taskId)) as Task,
    binding: await h.bindings.getBindingForTask(taskId),
  };
}

describe("listing", () => {
  it("lists the worktree with git facts, the PR title and the repository group", async () => {
    const h = await build();
    h.pullRequests.statuses.set("feature-login", {
      number: 7,
      url: "https://x/7",
      state: "OPEN",
      isDraft: false,
      title: "Add login",
      reviewRequested: false,
      reviewSubmitted: false,
      checkedAt: NOW.toISOString(),
    });
    const listing = await h.listing();
    expect(listing.groups).toHaveLength(1);
    const [candidate] = listing.groups[0]?.candidates ?? [];
    expect(candidate).toMatchObject({
      kind: "worktree",
      repositoryId: REPO.id,
      branch: "feature-login",
      title: "Add login",
      titleSource: "pull-request",
      preselected: true,
      pullRequest: { number: 7, state: "open", title: "Add login" },
    });
    expect(listing.sources).toEqual([
      { id: "claude-code", label: "Claude Code", found: 1 },
    ]);
  });

  it("gh failing is no PR info, never an error", async () => {
    const h = await build();
    h.pullRequests.failing = true;
    const candidate = await h.candidateFor(WT);
    expect(candidate?.pullRequest).toBeUndefined();
    expect(candidate?.title).toBe("Fix login");
  });

  it("a reader that throws is reported on its source, the rest still lists", async () => {
    const h = await build();
    const broken: ImportSourceReader = {
      id: "pi",
      label: "Pi",
      read: async () => {
        throw new Error("boom");
      },
    };
    const manager = new CoreManager({
      ...(h.manager as unknown as { deps: never }).deps,
      importReaders: [broken],
    });
    const listing = await manager.listImportCandidates();
    expect(listing.sources[0]).toMatchObject({ id: "pi", error: "boom" });
  });
});

describe("importItems", () => {
  it("creates a Working External-worktree task bound to resume the picked session", async () => {
    const h = await build();
    const { result, task, binding } = await importWorktree(h);
    expect(result.skipped).toEqual([]);
    expect(task).toMatchObject({
      kind: "task",
      state: "working",
      title: "Fix login",
      initialPrompt: "",
      repositoryId: REPO.id,
      branch: "feature-login",
      targetBranch: "main",
      harness: "claude-code",
      initialPromptDeliveredAt: NOW.toISOString(),
      startedAt: NOW.toISOString(),
      imported: {
        batchId: result.batchId,
        at: NOW.toISOString(),
        sources: ["claude-code"],
      },
    });
    expect(task.imported?.touchedAt).toBeUndefined();
    expect(binding).toMatchObject({
      worktreePath: WT,
      branch: "feature-login",
      external: true,
      sessionId: "sess-1",
      sessionPath: "/store/sess-1.jsonl",
      detached: false,
    });
    // nothing was created on disk and nothing launched
    expect(h.worktrees.createTaskWorktree).not.toHaveBeenCalled();
    expect(await h.manager.claimSessionLaunch(task.id)).toEqual({
      mode: "resume",
      sessionId: "sess-1",
      sessionPath: "/store/sess-1.jsonl",
    });
    // re-listing: the imported worktree is now "already in Harbormaster"
    expect(await h.candidateFor(WT)).toMatchObject({
      blocked: "on-board",
      onBoardTaskId: task.id,
    });
  });

  it("an edited title wins; a checkout or plain folder becomes a folder task, never External", async () => {
    const h = await build({
      sessions: [
        record({ cwd: "/code/app", sessionId: "c1" }),
        record({ cwd: "/code/notes", sessionId: "n1" }),
      ],
    });
    const listing = await h.listing();
    const all = listing.groups.flatMap((g) => g.candidates);
    const result = await h.manager.importItems({
      items: all.map((c) => ({
        candidateId: c.id,
        sessionId: c.defaultSessionId,
        title: `Edited ${c.kind}`,
      })),
    });
    expect(result.imported).toHaveLength(2);
    for (const { taskId } of result.imported) {
      const task = (await h.tasks.getTask(taskId)) as Task;
      const binding = await h.bindings.getBindingForTask(taskId);
      expect(task.repositoryId).toBeUndefined();
      expect(task.kind).toBe("temp_task");
      expect(task.title).toMatch(/^Edited (checkout|folder)$/);
      expect(task.folderPath).toBe(binding?.worktreePath);
      expect(binding).toMatchObject({ inPlace: true });
      expect(binding?.external).toBeUndefined();
    }
  });

  it("registers the main checkout of a repository Harbormaster does not know (I16)", async () => {
    const h = await build({
      sessions: [record({ cwd: OTHER_WT, sessionId: "o1" })],
    });
    const candidate = await h.candidateFor(OTHER_WT);
    const result = await h.manager.importItems({
      items: [
        { candidateId: candidate?.id as string, sessionId: "o1", title: "T" },
      ],
    });
    expect(h.registered).toEqual([OTHER_REPO_MAIN]);
    const task = (await h.tasks.getTask(
      result.imported[0]?.taskId as string,
    )) as Task;
    expect(task.repositoryId).toBe("github.com/acme/unknown");
  });

  it("skips what moved since the listing: running, on-board, folder gone, missing session; counts them as left out", async () => {
    const h = await build({
      sessions: [
        record({ cwd: "/code/notes", sessionId: "n1", harness: "pi" }),
      ],
    });
    const candidate = await h.candidateFor("/code/notes");
    const ids = {
      candidateId: candidate?.id as string,
      sessionId: "n1",
      title: "T",
    };
    h.state.running = [{ harness: "pi", pid: 9, cwd: "/code/notes" }];
    const running = await h.manager.importItems({ items: [ids] });
    expect(running.imported).toEqual([]);
    expect(running.skipped).toEqual([
      {
        candidateId: ids.candidateId,
        reason: "running",
        detail: expect.stringContaining("Running in a terminal"),
      },
    ]);
    expect(running.leftOut).toEqual({ running: 1 });
    expect(running.batchId).toBeUndefined();
    expect(await h.inbox.list()).toEqual([]);
    h.state.running = [];
    expect(
      (await h.manager.importItems({ items: [{ ...ids, sessionId: "nope" }] }))
        .skipped[0]?.reason,
    ).toBe("session-missing");
    expect(
      (
        await h.manager.importItems({
          items: [{ ...ids, candidateId: "ghost" }],
        })
      ).skipped[0]?.reason,
    ).toBe("error");
    h.existing.delete("/code/notes");
    h.state.sessions = [
      record({ cwd: "/code/notes", sessionId: "n1", harness: "pi" }),
    ];
    expect(
      (await h.manager.importItems({ items: [ids] })).skipped[0]?.reason,
    ).toBe("folder-missing");
  });

  it("Fork instead binds a fork of a running session; a Cursor row cannot fork", async () => {
    const h = await build({
      sessions: [record({ harness: "claude-code" })],
      running: [
        { harness: "claude-code", pid: 3, cwd: WT, sessionId: "sess-1" },
      ],
    });
    const candidate = await h.candidateFor(WT);
    expect(candidate).toMatchObject({ blocked: "running" });
    const refused = await h.manager.importItems({
      items: [
        {
          candidateId: candidate?.id as string,
          sessionId: "sess-1",
          title: "T",
        },
      ],
    });
    expect(refused.skipped[0]?.reason).toBe("running");
    const forked = await h.manager.importItems({
      items: [
        {
          candidateId: candidate?.id as string,
          sessionId: "sess-1",
          title: "T",
          fork: true,
        },
      ],
    });
    expect(forked.skipped).toEqual([]);
    const taskId = forked.imported[0]?.taskId as string;
    const binding = await h.bindings.getBindingForTask(taskId);
    expect(binding?.forkFromSessionPath).toBe("/store/sess-1.jsonl");
    expect(binding?.sessionId).toBeTruthy();
    expect(binding?.sessionId).not.toBe("sess-1");
    expect(binding?.sessionPath).toBeUndefined();
    expect(await h.manager.claimSessionLaunch(taskId)).toMatchObject({
      mode: "fork",
      forkFrom: "/store/sess-1.jsonl",
    });
    expect(forked.leftOut).toEqual({});

    const cursor = await build({
      sessions: [
        record({
          harness: "cursor",
          sessionId: "cu",
          sessionPath: "/chats/cu",
        }),
      ],
      running: [{ harness: "cursor", pid: 4, cwd: WT }],
    });
    const row = await cursor.candidateFor(WT);
    expect(row?.sessions[0]?.canFork).toBe(false);
    const result = await cursor.manager.importItems({
      items: [
        {
          candidateId: row?.id as string,
          sessionId: "cu",
          title: "T",
          fork: true,
        },
      ],
    });
    expect(result.skipped[0]?.reason).toBe("cannot-fork");
  });

  it("writes one summary inbox item with Show on board and Undo import (I10)", async () => {
    const h = await build({
      sessions: [
        record(),
        record({ cwd: "/code/notes", sessionId: "n1", harness: "pi" }),
      ],
      running: [{ harness: "pi", pid: 9, cwd: "/code/notes" }],
    });
    const candidate = await h.candidateFor(WT);
    const result = await h.manager.importItems({
      items: [
        {
          candidateId: candidate?.id as string,
          sessionId: "sess-1",
          title: "T",
        },
      ],
    });
    expect(result.leftOut).toEqual({ running: 1 });
    const [item] = await h.inbox.list();
    expect(item).toMatchObject({
      id: result.inboxItemId,
      kind: "import",
      source: "harbormaster",
      priority: false,
      title:
        "Imported 1 task from Claude Code · 1 left out (running elsewhere: 1)",
    });
    expect(item?.body).toContain("Running elsewhere:");
    expect(item?.body).toContain("/code/notes");
    expect(item?.buttons.map((b) => [b.action, b.with])).toEqual([
      ["showBoard", { taskIds: [result.imported[0]?.taskId] }],
      ["undoImport", { batchId: result.batchId }],
    ]);
    const shown = await h.manager.resolveInboxItem(item?.id as string, {
      buttonId: "show",
    });
    expect(shown.taskIds).toEqual([result.imported[0]?.taskId]);
    expect(shown.item.resolvedAt).toBeDefined();
  });
});

describe("undoImport", () => {
  it("removes untouched tasks, keeps touched ones, leaves folders alone, resolves the item, is a no-op twice", async () => {
    const h = await build({
      sessions: [
        record(),
        record({ cwd: "/code/notes", sessionId: "n1", harness: "pi" }),
      ],
    });
    const listing = await h.listing();
    const all = listing.groups.flatMap((g) => g.candidates);
    const result = await h.manager.importItems({
      items: all.map((c) => ({
        candidateId: c.id,
        sessionId: c.defaultSessionId,
        title: c.title,
      })),
    });
    expect(result.imported).toHaveLength(2);
    const wtTask = result.imported.find(
      (i) => i.candidateId === all.find((c) => c.folderPath === WT)?.id,
    )?.taskId as string;
    const folderTask = result.imported.find((i) => i.taskId !== wtTask)
      ?.taskId as string;
    // the user opens one of them
    await h.manager.claimSessionLaunch(folderTask);
    expect(
      ((await h.tasks.getTask(folderTask)) as Task).imported?.touchedAt,
    ).toBeDefined();

    const undone = await h.manager.undoImport(result.batchId as string);
    expect(undone.removed).toEqual([wtTask]);
    expect(undone.kept).toEqual([
      { taskId: folderTask, title: expect.any(String) },
    ]);
    expect(await h.tasks.getTask(wtTask)).toBeUndefined();
    expect(await h.bindings.getBindingForTask(wtTask)).toBeUndefined();
    expect(await h.tasks.getTask(folderTask)).toBeDefined();
    // folder, branch, session untouched
    expect(h.worktrees.removeWorktree).not.toHaveBeenCalled();
    expect(h.worktrees.deleteBranch).not.toHaveBeenCalled();
    expect((await h.inbox.list())[0]?.resolvedAt).toBeDefined();
    expect(await h.manager.undoImport(result.batchId as string)).toEqual({
      batchId: result.batchId,
      removed: [],
      kept: [],
    });
  });

  it("the inbox Undo import button runs it and returns the result", async () => {
    const h = await build();
    const { result, taskId } = await importWorktree(h);
    const [item] = await h.inbox.list();
    const resolved = await h.manager.resolveInboxItem(item?.id as string, {
      buttonId: "undo",
    });
    expect(resolved.undo).toEqual({
      batchId: result.batchId,
      removed: [taskId],
      kept: [],
    });
    expect(resolved.item.resolvedBy).toBe("undo");
    expect(await h.tasks.getTask(taskId)).toBeUndefined();
  });

  it("a user move, a title edit and an await touch the task; a rule's move does not", async () => {
    for (const touchWith of [
      (h: Awaited<ReturnType<typeof build>>, id: string) =>
        h.manager.moveTask(id, "awaiting", {
          awaiting: { kind: "review" },
        } as never),
      (h: Awaited<ReturnType<typeof build>>, id: string) =>
        h.manager.updateTaskState(id, { title: "New title" }),
    ]) {
      const h = await build();
      const { taskId } = await importWorktree(h);
      await touchWith(h, taskId);
      expect(
        ((await h.tasks.getTask(taskId)) as Task).imported?.touchedAt,
      ).toBeDefined();
    }
    const h = await build();
    const { taskId } = await importWorktree(h);
    await (
      h.manager as unknown as {
        executeRuleMove(
          t: Task,
          m: unknown,
          p: string[],
          w: string[],
        ): Promise<unknown>;
      }
    ).executeRuleMove(
      (await h.tasks.getTask(taskId)) as Task,
      { state: "working" },
      [],
      [],
    );
    expect(
      ((await h.tasks.getTask(taskId)) as Task).imported?.touchedAt,
    ).toBeUndefined();
  });
});

describe("External worktrees are never removed (I9, I14, I15)", () => {
  const untouchedGit = (h: Awaited<ReturnType<typeof build>>) => {
    expect(h.worktrees.removeWorktree).not.toHaveBeenCalled();
    expect(h.worktrees.deleteBranch).not.toHaveBeenCalled();
    expect(h.worktrees.deleteWorktreeDir).not.toHaveBeenCalled();
  };

  it("Done: the question only says the worktree is kept; confirmed, nothing is touched and the path survives", async () => {
    const h = await build();
    const { taskId } = await importWorktree(h);
    const question = await h.manager.toDone(taskId, { protectedPaths: [WT] });
    expect(isToDoneConfirmation(question) && question.lines).toEqual([
      `The worktree ${WT} isn't Harbormaster's and will be kept.`,
      "Its terminal pane will be closed.",
    ]);
    const quiet = await h.manager.toDone(taskId);
    expect(isToDoneConfirmation(quiet) && quiet.lines).toEqual([
      `The worktree ${WT} isn't Harbormaster's and will be kept.`,
    ]);
    const done = await h.manager.toDone(taskId, { force: { confirmed: true } });
    const task = ("task" in done ? done.task : undefined) as Task;
    expect(task.state).toBe("done");
    expect(task.cleanup).toMatchObject({
      mode: "forced",
      worktreePath: WT,
      completedAt: NOW.toISOString(),
    });
    expect(task.cleanup?.deleteBranch).toBeUndefined();
    const binding = await h.bindings.getBindingForTask(taskId);
    expect(binding).toMatchObject({
      worktreePath: WT,
      external: true,
      sessionId: "sess-1",
    });
    untouchedGit(h);
  });

  it("Archive of an unfinished task: the same, nothing removed", async () => {
    const h = await build();
    const { taskId } = await importWorktree(h);
    const done = await h.manager.archiveTask(taskId, {
      force: { confirmed: true },
    });
    expect("task" in done && done.task.archivedAt).toBeTruthy();
    untouchedGit(h);
  });

  it("the refresh sweep never retries a forced cleanup of an External worktree away", async () => {
    const h = await build();
    const { taskId } = await importWorktree(h);
    await h.manager.moveTask(taskId, "done");
    // a forced cleanup left unfinished (as an older run, or a manual edit of the state, would)
    await h.tasks.patchTask(taskId, (t) => ({
      ...t,
      cleanup: {
        mode: "forced",
        requestedAt: hoursAgo(5),
        attempts: 0,
        deleteBranch: true,
        worktreePath: WT,
      },
    }));
    await h.manager.refresh();
    untouchedGit(h);
    expect(
      ((await h.tasks.getTask(taskId)) as Task).cleanup?.completedAt,
    ).toBeDefined();
    expect((await h.bindings.getBindingForTask(taskId))?.worktreePath).toBe(WT);
  });

  it("the legacy safe-retry sweep (a Done task without a cleanup record) skips it", async () => {
    const h = await build();
    const { taskId } = await importWorktree(h);
    await h.manager.moveTask(taskId, "done");
    await h.manager.refresh();
    untouchedGit(h);
    expect((await h.bindings.getBindingForTask(taskId))?.worktreePath).toBe(WT);
  });

  it("a rule's landing (move: done) lands it without removing anything", async () => {
    const h = await build();
    const { taskId } = await importWorktree(h);
    const executeSafeDone = (
      h.manager as unknown as {
        executeSafeDone(
          t: Task,
          p: string[],
        ): Promise<{ task?: Task; stayed?: boolean }>;
      }
    ).executeSafeDone.bind(h.manager);
    const result = await executeSafeDone(
      (await h.tasks.getTask(taskId)) as Task,
      [],
    );
    expect(result.stayed).toBeUndefined();
    expect(result.task?.state).toBe("done");
    // even a pmerged PR does not delete the branch
    untouchedGit(h);
    expect(result.task?.imported?.touchedAt).toBeUndefined();
  });

  it("deleting the task releases it but never removes the folder or branch", async () => {
    const h = await build();
    const { taskId } = await importWorktree(h);
    await h.manager.deleteTask(taskId, { removeDirty: true });
    expect(await h.tasks.getTask(taskId)).toBeUndefined();
    untouchedGit(h);
  });

  it("the 7-day sweep only archives; the folder stays", async () => {
    const h = await build();
    const { taskId } = await importWorktree(h);
    await h.manager.toDone(taskId, { force: { confirmed: true } });
    h.clock.current = new Date(NOW.getTime() + 8 * 86_400_000);
    await h.manager.refresh();
    expect(((await h.tasks.getTask(taskId)) as Task).archivedAt).toBeDefined();
    untouchedGit(h);
  });

  it("an ordinary (non-External) worktree is still removed by Done: the guard is specific", async () => {
    const h = await build();
    const { taskId } = await importWorktree(h);
    const binding = (await h.bindings.getBindingForTask(taskId)) as NonNullable<
      Awaited<ReturnType<typeof h.bindings.getBindingForTask>>
    >;
    const { external: _e, ...plain } = binding;
    await h.bindings.replaceBinding(plain);
    await h.manager.toDone(taskId, { force: { confirmed: true } });
    expect(h.worktrees.removeWorktree).toHaveBeenCalledWith(
      expect.anything(),
      WT,
      true,
    );
  });

  it("Reopen of a Done External task resumes in its own folder (I14); if the folder is gone it reopens like any task", async () => {
    const h = await build();
    const { taskId } = await importWorktree(h);
    await h.manager.toDone(taskId, { force: { confirmed: true } });
    const reopened = await h.manager.reopenTask(taskId);
    expect(reopened.task.state).toBe("working");
    expect(h.worktrees.createTaskWorktree).not.toHaveBeenCalled();
    expect(await h.bindings.getBindingForTask(taskId)).toMatchObject({
      worktreePath: WT,
      external: true,
      sessionId: "sess-1",
    });
    expect(await h.manager.claimSessionLaunch(taskId)).toMatchObject({
      mode: "resume",
      sessionId: "sess-1",
    });

    await h.manager.toDone(taskId, { force: { confirmed: true } });
    h.existing.delete(WT);
    const gone = await h.manager.reopenTask(taskId);
    expect(h.worktrees.createTaskWorktree).toHaveBeenCalledTimes(1);
    const binding = await h.bindings.getBindingForTask(taskId);
    expect(binding?.external).toBeUndefined();
    expect(binding?.worktreePath).toMatch(/^\/wt\/new-/);
    expect(gone.task.state).toBe("working");
  });

  describe("removeExternalWorktree", () => {
    it("asks first (path, changes, branch kept), then force-removes the folder, keeps the branch, parks the binding, audits", async () => {
      const h = await build();
      const { taskId } = await importWorktree(h);
      await h.manager.toDone(taskId, { force: { confirmed: true } });
      const question = await h.manager.removeExternalWorktree(taskId, {
        protectedPaths: [WT],
      });
      expect(isToDoneConfirmation(question) && question.lines).toEqual([
        `The worktree ${WT} will be removed.`,
        "2 uncommitted changes will be discarded.",
        "The branch feature-login is kept.",
        "Its terminal pane will be closed.",
      ]);
      expect(h.worktrees.removeWorktree).not.toHaveBeenCalled();
      await expect(
        h.manager.removeExternalWorktree(taskId, {
          protectedPaths: [WT],
          force: { confirmed: true },
        }),
      ).rejects.toThrow(/live session/);
      const result = await h.manager.removeExternalWorktree(taskId, {
        force: { confirmed: true },
      });
      expect("task" in result).toBe(true);
      expect(h.worktrees.removeWorktree).toHaveBeenCalledWith(
        expect.anything(),
        WT,
        true,
      );
      expect(h.worktrees.deleteBranch).not.toHaveBeenCalled();
      const binding = await h.bindings.getBindingForTask(taskId);
      expect(binding?.worktreePath).toBeUndefined();
      expect(binding?.external).toBeUndefined();
      expect(binding?.sessionId).toBe("sess-1");
      expect(
        h.audit.some(
          (e) =>
            "message" in e &&
            /external worktree .* removed.*kept/.test(e.message),
        ),
      ).toBe(true);
    });

    it("refuses a non-External task, a folder task and an unfinished one", async () => {
      const h = await build({
        sessions: [record(), record({ cwd: "/code/notes", sessionId: "n1" })],
      });
      const all = (await h.listing()).groups.flatMap((g) => g.candidates);
      const result = await h.manager.importItems({
        items: all.map((c) => ({
          candidateId: c.id,
          sessionId: c.defaultSessionId,
          title: c.title,
        })),
      });
      const folderTask = result.imported.find(
        (i) =>
          i.candidateId === all.find((c) => c.folderPath === "/code/notes")?.id,
      )?.taskId as string;
      const wtTask = result.imported.find((i) => i.taskId !== folderTask)
        ?.taskId as string;
      await expect(
        h.manager.removeExternalWorktree(folderTask),
      ).rejects.toThrow(/not an imported worktree/);
      await expect(h.manager.removeExternalWorktree(wtTask)).rejects.toThrow(
        /Done before/,
      );
      const plain = await h.manager.createTask({
        title: "plain",
        initialPrompt: "x",
      });
      await expect(h.manager.removeExternalWorktree(plain.id)).rejects.toThrow(
        /not an imported worktree/,
      );
    });
  });
});
