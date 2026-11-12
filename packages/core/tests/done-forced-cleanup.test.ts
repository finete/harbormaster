// "Done is final": a confirmed manual Done records `task.cleanup` (mode
// "forced") and the app owns the worktree housekeeping from there. Fake
// worktree access + a controllable clock: the forced retry and its backoff
// (1 min, 5 min, 30 min, then hourly), orphan handling ("not a git
// repository" folders deleted + pruned, ENOENT = already cleaned), the
// "needs attention" threshold behind the inbox item, Retry and Dismiss.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonConfigAccess } from "../src/access/json-config-access.js";
import { JsonTaskStateAccess } from "../src/access/json-task-state-access.js";
import { JsonWorkspaceBindingAccess } from "../src/access/json-workspace-binding-access.js";
import { isToDoneConfirmation } from "../src/contracts/commands.js";
import type {
  CommitLogEntry,
  PullRequestAccess,
  PullRequestStatus,
  VersionAccess,
} from "../src/contracts/github.js";
import type { Task } from "../src/contracts/model.js";
import type { AuditEntry } from "../src/contracts/rules.js";
import type {
  GitRepositoryAccess,
  GitWorktreeAccess,
  RepositoryInfo,
} from "../src/contracts/workspace.js";
import { cleanupNeedsAttention } from "../src/engines/cleanup.js";
import { CoreManager } from "../src/manager/core-manager.js";
import { UuidGenerator } from "../src/utilities/defaults.js";
import { CoreEventBus } from "../src/utilities/event-bus.js";

const REPO: RepositoryInfo = {
  id: "github.com/acme/repo",
  root: "/nonexistent/repo",
  defaultBranch: "main",
  checkouts: [{ root: "/nonexistent/repo", isPrimary: true }],
};
const WORKTREE = "/nonexistent/.harbormaster-worktrees/feature-abc123";

class NoPullRequests implements PullRequestAccess {
  async status(): Promise<PullRequestStatus | undefined> {
    return undefined;
  }
  async ensureOpen(): Promise<PullRequestStatus> {
    throw new Error("not used");
  }
  async squashMerge(): Promise<PullRequestStatus> {
    throw new Error("not used");
  }
  async containsCommit(): Promise<boolean> {
    return true;
  }
  async commitLog(): Promise<CommitLogEntry[]> {
    return [];
  }
}

class NoVersions implements VersionAccess {
  async fetchText(url: string): Promise<string> {
    throw new Error(`no fake document for ${url}`);
  }
}

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const START = new Date("2026-03-01T10:00:00.000Z");
const minutes = (n: number) => n * 60_000;

async function harness(
  removeWorktree: (
    repo: RepositoryInfo,
    path: string,
    force?: boolean,
  ) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "harbormaster-forced-cleanup-"));
  dirs.push(dir);
  // No rules tick: only the cleanup sweep runs in refresh().
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({ automation: false }),
  );
  const clock = { current: START, now: () => clock.current };
  const tasks = new JsonTaskStateAccess(join(dir, "tasks.json"));
  const bindings = new JsonWorkspaceBindingAccess(
    join(dir, "workspace-bindings.json"),
  );
  const audit: AuditEntry[] = [];
  const worktrees = {
    removeWorktree: vi.fn(removeWorktree),
    uncommittedChangeCount: vi.fn(async () => 3),
    isWorktreeDirty: async () => true,
    branchExists: async () => true,
    deleteBranch: vi.fn(async () => {}),
    pruneWorktrees: vi.fn(async () => {}),
    deleteWorktreeDir: vi.fn(async () => {}),
    listWorktrees: async () => [],
  };
  const manager = new CoreManager({
    tasks,
    clock,
    ids: new UuidGenerator(),
    events: new CoreEventBus(),
    config: new JsonConfigAccess(join(dir, "config.json")),
    repositories: {
      discoverRepositories: async () => [REPO],
    } as unknown as GitRepositoryAccess,
    worktrees: worktrees as unknown as GitWorktreeAccess,
    bindings,
    sessions: {} as never,
    scratch: {} as never,
    pullRequests: new NoPullRequests(),
    versions: new NoVersions(),
    rules: {
      files: {} as never,
      state: {} as never,
      audit: {
        append: async (entries) => {
          audit.push(...entries);
        },
        read: async () => audit,
      },
    },
  });
  const stamp = START.toISOString();
  const task: Task = {
    id: "task-1",
    kind: "task",
    state: "dev",
    title: "Feature",
    initialPrompt: "",
    repositoryId: REPO.id,
    branch: "feature-abc123",
    createdAt: stamp,
    updatedAt: stamp,
    stateChangedAt: stamp,
  };
  await tasks.createTask(task);
  await bindings.attachBinding({
    id: "binding-1",
    taskId: task.id,
    worktreePath: WORKTREE,
    sessionId: "session-1",
    detached: false,
    createdAt: stamp,
    updatedAt: stamp,
  });
  const at = (ms: number) => {
    clock.current = new Date(START.getTime() + ms);
  };
  const reload = async () => (await tasks.getTask(task.id)) as Task;
  return { manager, worktrees, bindings, audit, at, reload, task };
}

async function confirmDone(manager: CoreManager, taskId: string) {
  const question = await manager.toDone(taskId);
  expect(question).toMatchObject({ requiresConfirmation: "done" });
  return manager.toDone(taskId, { force: { confirmed: true } });
}

describe("confirmed Done: forced cleanup", () => {
  it("computes the one question's lines up front, without touching anything", async () => {
    const f = await harness(async () => {});
    const question = await f.manager.toDone(f.task.id, {
      protectedPaths: [WORKTREE],
    });
    expect(question).toEqual({
      requiresConfirmation: "done",
      detail: "Feature",
      lines: [
        `The worktree ${WORKTREE} will be removed.`,
        "3 uncommitted changes will be discarded.",
        "Branch feature-abc123 is not merged; the local branch will be deleted.",
        "Its terminal pane will be closed.",
      ],
      closesPane: true,
    });
    expect(f.worktrees.removeWorktree).not.toHaveBeenCalled();
    expect((await f.reload()).state).toBe("dev");
  });

  it("removes with force, parks the binding, deletes the branch and records completion", async () => {
    const f = await harness(async () => {});
    const result = await confirmDone(f.manager, f.task.id);
    if (isToDoneConfirmation(result)) throw new Error("unexpected question");
    expect(result).not.toHaveProperty("warning");
    expect(f.worktrees.removeWorktree).toHaveBeenCalledWith(
      REPO,
      WORKTREE,
      true,
    );
    expect(f.worktrees.deleteBranch).toHaveBeenCalledWith(
      REPO,
      "feature-abc123",
      true,
    );
    expect(result.task.cleanup).toEqual({
      mode: "forced",
      requestedAt: START.toISOString(),
      deleteBranch: true,
      worktreePath: WORKTREE,
      attempts: 1,
      lastAttemptAt: START.toISOString(),
      completedAt: START.toISOString(),
    });
    const binding = await f.bindings.getBindingForTask(f.task.id);
    expect(binding?.worktreePath).toBeUndefined();
    expect(binding?.sessionId).toBe("session-1");
  });

  it("lands Done even when removal fails, then retries silently with backoff (1 min, 5 min, 30 min, hourly)", async () => {
    const f = await harness(async () => {
      throw new Error("Device or resource busy");
    });
    const result = await confirmDone(f.manager, f.task.id);
    if (isToDoneConfirmation(result)) throw new Error("unexpected question");
    expect(result.task.state).toBe("done");
    expect(result).not.toHaveProperty("warning");
    expect(result.task.cleanup).toMatchObject({
      mode: "forced",
      attempts: 1,
      lastError: "Device or resource busy",
      nextAttemptAt: new Date(START.getTime() + minutes(1)).toISOString(),
    });
    // Audit-only: the "left in place" text is never a warning.
    expect(f.audit).toEqual([
      expect.objectContaining({
        kind: "warning",
        taskId: f.task.id,
        message: "worktree left in place: Device or resource busy",
      }),
    ]);

    const calls = () => f.worktrees.removeWorktree.mock.calls.length;
    // Not due yet.
    f.at(minutes(0.5));
    expect((await f.manager.refresh()).warnings).toEqual([]);
    expect(calls()).toBe(1);

    // +1 min: attempt 2, next in 5 min.
    f.at(minutes(1));
    expect((await f.manager.refresh()).warnings).toEqual([]);
    expect(calls()).toBe(2);
    expect(f.worktrees.removeWorktree).toHaveBeenLastCalledWith(
      REPO,
      WORKTREE,
      true,
    );
    expect((await f.reload()).cleanup?.nextAttemptAt).toBe(
      new Date(START.getTime() + minutes(6)).toISOString(),
    );
    expect(cleanupNeedsAttention(await f.reload())).toBe(false);

    f.at(minutes(5.5));
    await f.manager.refresh();
    expect(calls()).toBe(2);

    // +6 min: attempt 3, next in 30 min; now it needs the user.
    f.at(minutes(6));
    expect((await f.manager.refresh()).warnings).toEqual([]);
    expect(calls()).toBe(3);
    expect((await f.reload()).cleanup).toMatchObject({
      attempts: 3,
      nextAttemptAt: new Date(START.getTime() + minutes(36)).toISOString(),
    });
    expect(cleanupNeedsAttention(await f.reload())).toBe(true);

    // +36 min: attempt 4, then hourly.
    f.at(minutes(36));
    await f.manager.refresh();
    expect(calls()).toBe(4);
    expect((await f.reload()).cleanup?.nextAttemptAt).toBe(
      new Date(START.getTime() + minutes(96)).toISOString(),
    );
    f.at(minutes(95));
    await f.manager.refresh();
    expect(calls()).toBe(4);
    f.at(minutes(96));
    expect((await f.manager.refresh()).warnings).toEqual([]);
    expect(calls()).toBe(5);
    expect((await f.reload()).cleanup?.nextAttemptAt).toBe(
      new Date(START.getTime() + minutes(156)).toISOString(),
    );
  });

  it("Retry forces again now (ignoring backoff); success clears the error and the attention flag", async () => {
    let fail = true;
    const f = await harness(async () => {
      if (fail) throw new Error("Device or resource busy");
    });
    await confirmDone(f.manager, f.task.id);
    f.at(minutes(1));
    await f.manager.refresh();
    f.at(minutes(6));
    await f.manager.refresh();
    expect(cleanupNeedsAttention(await f.reload())).toBe(true);

    fail = false;
    f.at(minutes(7));
    const retried = await f.manager.retryDoneCleanup(f.task.id);
    expect(retried.cleanup).toMatchObject({ mode: "forced", attempts: 4 });
    expect(retried.cleanup?.completedAt).toBeDefined();
    expect(retried.cleanup?.lastError).toBeUndefined();
    expect(cleanupNeedsAttention(retried)).toBe(false);
    expect(
      (await f.bindings.getBindingForTask(f.task.id))?.worktreePath,
    ).toBeUndefined();

    // Completed: the sweep leaves it alone from now on.
    f.at(minutes(600));
    await f.manager.refresh();
    expect(f.worktrees.removeWorktree).toHaveBeenCalledTimes(4);
  });

  it("Dismiss abandons the cleanup: the sweep stops for good", async () => {
    const f = await harness(async () => {
      throw new Error("Device or resource busy");
    });
    await confirmDone(f.manager, f.task.id);
    const abandoned = await f.manager.abandonDoneCleanup(f.task.id);
    expect(abandoned.cleanup?.mode).toBe("abandoned");
    expect(cleanupNeedsAttention(abandoned)).toBe(false);
    f.at(minutes(600));
    expect((await f.manager.refresh()).warnings).toEqual([]);
    expect(f.worktrees.removeWorktree).toHaveBeenCalledTimes(1);
  });

  it("an orphan folder (git: not a git repository) is deleted and pruned, never asked about", async () => {
    const f = await harness(async () => {
      throw new Error(
        "git rev-parse failed: fatal: not a git repository: /nonexistent/repo/.git/worktrees/feature-abc123",
      );
    });
    const result = await confirmDone(f.manager, f.task.id);
    if (isToDoneConfirmation(result)) throw new Error("unexpected question");
    expect(f.worktrees.deleteWorktreeDir).toHaveBeenCalledWith(WORKTREE);
    expect(f.worktrees.pruneWorktrees).toHaveBeenCalledWith(REPO);
    expect(result.task.cleanup?.completedAt).toBeDefined();
    expect(result.task.cleanup?.lastError).toBeUndefined();
    expect(
      (await f.bindings.getBindingForTask(f.task.id))?.worktreePath,
    ).toBeUndefined();
  });

  it("a folder that is already gone (ENOENT) counts as cleaned: pruned, no error, nothing deleted", async () => {
    const f = await harness(async () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    });
    const result = await confirmDone(f.manager, f.task.id);
    if (isToDoneConfirmation(result)) throw new Error("unexpected question");
    expect(f.worktrees.deleteWorktreeDir).not.toHaveBeenCalled();
    expect(f.worktrees.pruneWorktrees).toHaveBeenCalledWith(REPO);
    expect(result.task.cleanup?.completedAt).toBeDefined();
    expect(result.task.cleanup?.attempts).toBe(1);
    expect(f.audit).toEqual([]);
  });

  it("reopening a Done task stops its pending cleanup", async () => {
    const f = await harness(async () => {
      throw new Error("Device or resource busy");
    });
    await confirmDone(f.manager, f.task.id);
    const moved = await f.manager.moveTask(f.task.id, "dev");
    expect(moved.cleanup).toBeUndefined();
    f.at(minutes(600));
    await f.manager.refresh();
    expect(f.worktrees.removeWorktree).toHaveBeenCalledTimes(1);
  });
});
