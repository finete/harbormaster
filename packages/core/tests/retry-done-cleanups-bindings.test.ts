// refresh()'s done-cleanup retry sweep must read the bindings file once per
// pass, not once per done task (it used to re-read and re-parse the whole
// workspace-bindings.json for every done task on every 30s tick). Also:
// a hung child process inside refresh() must not wedge the single-flight
// refresh forever (utilities/run.ts timeout).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonConfigAccess } from "../src/access/json-config-access.js";
import { JsonTaskStateAccess } from "../src/access/json-task-state-access.js";
import { JsonWorkspaceBindingAccess } from "../src/access/json-workspace-binding-access.js";
import type {
  CommitLogEntry,
  PullRequestAccess,
  PullRequestStatus,
  VersionAccess,
} from "../src/contracts/github.js";
import type { Task, WorkspaceBinding } from "../src/contracts/model.js";
import type {
  GitRepositoryAccess,
  GitWorktreeAccess,
  RepositoryInfo,
} from "../src/contracts/workspace.js";
import { CoreManager } from "../src/manager/core-manager.js";
import { SystemClock, UuidGenerator } from "../src/utilities/defaults.js";
import { CoreEventBus } from "../src/utilities/event-bus.js";
import { run } from "../src/utilities/run.js";

const REPO: RepositoryInfo = {
  id: "github.com/acme/repo",
  root: "/nonexistent/repo",
  defaultBranch: "main",
  checkouts: [{ root: "/nonexistent/repo", isPrimary: true }],
};

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

const stamp = "2026-01-01T00:00:00.000Z";
const doneTask = (i: number): Task => ({
  id: `task-${i}`,
  kind: "task",
  state: "done",
  title: `Done ${i}`,
  initialPrompt: "",
  repositoryId: REPO.id,
  branch: `branch-${i}`,
  createdAt: stamp,
  updatedAt: stamp,
  stateChangedAt: stamp,
});
const binding = (i: number, worktreePath?: string): WorkspaceBinding => ({
  id: `binding-${i}`,
  taskId: `task-${i}`,
  ...(worktreePath ? { worktreePath } : {}),
  detached: false,
  createdAt: stamp,
  updatedAt: stamp,
});

async function harness(repositories: GitRepositoryAccess) {
  const dir = await mkdtemp(join(tmpdir(), "harbormaster-retry-cleanups-"));
  dirs.push(dir);
  const tasks = new JsonTaskStateAccess(join(dir, "tasks.json"));
  const bindings = new JsonWorkspaceBindingAccess(
    join(dir, "workspace-bindings.json"),
  );
  const removeWorktree = vi.fn(async () => {});
  const worktrees = {
    removeWorktree,
    branchExists: async () => false,
    deleteBranch: async () => {},
  } as unknown as GitWorktreeAccess;
  const manager = new CoreManager({
    tasks,
    clock: new SystemClock(),
    ids: new UuidGenerator(),
    events: new CoreEventBus(),
    config: new JsonConfigAccess(join(dir, "config.json")),
    repositories,
    worktrees,
    bindings,
    sessions: {} as never,
    scratch: {} as never,
    pullRequests: new NoPullRequests(),
    versions: new NoVersions(),
  });
  return { manager, tasks, bindings, removeWorktree };
}

const fixedRepositories: GitRepositoryAccess = {
  discoverRepositories: async () => [REPO],
} as unknown as GitRepositoryAccess;

describe("retryDoneCleanups bindings reads", () => {
  it("reads the bindings once per refresh pass, however many done tasks there are", async () => {
    const { manager, tasks, bindings, removeWorktree } =
      await harness(fixedRepositories);
    for (let i = 0; i < 12; i++) {
      await tasks.createTask(doneTask(i));
      await bindings.attachBinding(binding(i));
    }
    const list = vi.spyOn(bindings, "listBindings");
    const getOne = vi.spyOn(bindings, "getBindingForTask");

    const result = await manager.refresh();

    expect(result.warnings).toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(getOne).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("still cleans up a done task whose worktree is on disk (re-reading only that binding)", async () => {
    const { manager, tasks, bindings, removeWorktree } =
      await harness(fixedRepositories);
    for (let i = 0; i < 5; i++) {
      await tasks.createTask(doneTask(i));
      await bindings.attachBinding(
        binding(i, i === 3 ? "/nonexistent/wt-3" : undefined),
      );
    }
    const list = vi.spyOn(bindings, "listBindings");
    const getOne = vi.spyOn(bindings, "getBindingForTask");

    await manager.refresh();

    expect(list).toHaveBeenCalledTimes(1);
    expect(getOne).toHaveBeenCalledTimes(1);
    expect(getOne).toHaveBeenCalledWith("task-3");
    expect(removeWorktree).toHaveBeenCalledTimes(1);
    expect(removeWorktree).toHaveBeenCalledWith(
      REPO,
      "/nonexistent/wt-3",
      false,
    );
    // Parked: the binding survives without its worktreePath.
    expect((await bindings.getBindingForTask("task-3"))?.worktreePath).toBe(
      undefined,
    );
  });
});

describe("refresh() with a hung child process", () => {
  it("settles once the child times out, and a later refresh runs again", async () => {
    let calls = 0;
    const hangingRepositories = {
      discoverRepositories: async () => {
        calls += 1;
        // Stands in for a wedged git/gh: without run()'s timeout this never
        // settles and the single-flight refresh() never frees up.
        await run("sleep", ["30"], undefined, { timeoutMs: 200 });
        return [REPO];
      },
    } as unknown as GitRepositoryAccess;
    const { manager } = await harness(hangingRepositories);

    const started = Date.now();
    await expect(manager.refresh()).resolves.toMatchObject({ warnings: [] });
    await expect(manager.refresh()).resolves.toMatchObject({ warnings: [] });
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
