// Integration tests: pi-home's new-task timing (park in Backlog vs start
// now), `startTask` provisioning + rollback, the toDone protected-cwd
// refusal, and exactly-once initial-prompt delivery — wired to real git
// repository/worktree access against real temp git repos (same fixture
// pattern as tests/task-workspace-manager.test.ts). GitHub/HTTP access is
// stubbed and never invoked (no real gh/network calls).

import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  PullRequestAccess,
  VersionAccess,
} from "../src/contracts/github.js";
import type { Clock, WorkspaceBindingAccess } from "../src/contracts/index.js";
import {
  CoreEventBus,
  CoreManager,
  createCore,
  JsonConfigAccess,
  JsonTaskStateAccess,
  JsonWorkspaceBindingAccess,
  LocalGitRepositoryAccess,
  LocalGitWorktreeAccess,
  LocalScratchWorkspaceAccess,
  LocalSessionFileAccess,
  resolveStatePaths,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

let gitAvailable = true;
beforeAll(async () => {
  try {
    await git(["--version"]);
  } catch {
    gitAvailable = false;
  }
});

class FixedClock implements Clock {
  now(): Date {
    return new Date("2026-01-01T00:00:00.000Z");
  }
}

let counter = 0;
const sequentialIds = {
  next: () => `id-${(++counter).toString().padStart(8, "0")}`,
};

/** Never invoked by these tests; throws loudly if anything ever reaches for GitHub. */
const noGithub = new Proxy({} as PullRequestAccess & VersionAccess, {
  get: () => () => {
    throw new Error("GitHub/HTTP access must not be used in these tests");
  },
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fixture(): Promise<{
  stateDir: string;
  checkout: string;
  repositoryId: string;
  worktreesRoot: string;
}> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harbormaster-start-task-")),
  );
  roots.push(root);
  const stateDir = join(root, "state");
  const codeRoot = join(root, "Code");
  const checkout = join(codeRoot, "harbor-repo");
  await mkdir(stateDir, { recursive: true });
  await git(["init", "-q", "-b", "main", checkout]);
  await git(
    [
      "-c",
      "user.name=Harbormaster Test",
      "-c",
      "user.email=harbormaster-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
    checkout,
  );
  await git(
    ["remote", "add", "origin", "git@github.com:acme/harbor-repo.git"],
    checkout,
  );
  await writeFile(
    join(stateDir, "config.json"),
    JSON.stringify({
      automation: false,
      movers: [],
      codeRoot,
      branchPrefix: "",
    }),
  );
  counter = 0;
  return {
    stateDir,
    checkout,
    repositoryId: "github.com/acme/harbor-repo",
    worktreesRoot: join(codeRoot, ".harbormaster-worktrees"),
  };
}

function core(stateDir: string) {
  return createCore({
    stateDir,
    clock: new FixedClock(),
    ids: sequentialIds,
    pullRequests: noGithub,
    versions: noGithub,
  }).commands;
}

async function worktreeCount(checkout: string): Promise<number> {
  const list = await git(["worktree", "list", "--porcelain"], checkout);
  return list.match(/^worktree /gm)?.length ?? 0;
}

async function localBranches(checkout: string): Promise<string[]> {
  const out = await git(["branch", "--format=%(refname:short)"], checkout);
  return out.split("\n").filter(Boolean);
}

describe.skipIf(!gitAvailable)("new-task timing: park vs start now", () => {
  it("parking a repo task in Backlog stores title/prompt/repo but creates no branch, worktree, or binding", async () => {
    const f = await fixture();
    const commands = core(f.stateDir);

    const task = await commands.createTask({
      title: "Parked idea",
      initialPrompt: "think about it",
      repositoryId: f.repositoryId,
    });

    expect(task.state).toBe("backlog");
    expect(task.repositoryId).toBe(f.repositoryId);
    expect(task.initialPrompt).toBe("think about it");
    expect(task.branch).toBeUndefined();
    expect(task.targetBranch).toBe("main");
    expect(await commands.getTaskWorkspace(task.id)).toBeUndefined();
    expect(await worktreeCount(f.checkout)).toBe(1);
    expect(await localBranches(f.checkout)).toEqual(["main"]);
    expect(await exists(f.worktreesRoot)).toBe(false);
  });

  it("parking still rejects an unknown repository and creates no task", async () => {
    const f = await fixture();
    const commands = core(f.stateDir);
    await expect(
      commands.createTask({
        title: "Nowhere",
        initialPrompt: "",
        repositoryId: "github.com/acme/missing",
      }),
    ).rejects.toThrow(/Repository not found/);
    const board = await commands.listBoard();
    expect(board.flatMap((c) => c.groups.flatMap((g) => g.tasks))).toEqual([]);
  });

  it("starting now lands in dev with branch + worktree + binding", async () => {
    const f = await fixture();
    const commands = core(f.stateDir);

    const task = await commands.createTask({
      title: "Ship it",
      initialPrompt: "go",
      repositoryId: f.repositoryId,
      start: true,
    });

    expect(task.state).toBe("dev");
    expect(task.branch).toMatch(/^ship-it-[a-z0-9]{6}$/);
    const binding = await commands.getTaskWorkspace(task.id);
    expect(binding?.worktreePath).toContain(".harbormaster-worktrees");
    expect(await git(["branch", "--show-current"], binding?.worktreePath)).toBe(
      task.branch,
    );
  });

  it("starting a scratch task now lands in dev as a temp_task with a scratch-directory binding", async () => {
    const f = await fixture();
    const commands = core(f.stateDir);
    const task = await commands.createTask({
      title: "Scratch now",
      initialPrompt: "",
      start: true,
    });
    expect(task.state).toBe("dev");
    expect(task.kind).toBe("temp_task");
    const binding = await commands.getTaskWorkspace(task.id);
    expect(binding?.scratch).toBe(true);
    expect(binding?.worktreePath).toBe(join(f.stateDir, "scratch", task.id));
    expect(await exists(binding?.worktreePath ?? "")).toBe(true);
  });
});

describe.skipIf(!gitAvailable)("startTask", () => {
  it("creates the branch + worktree + binding for a parked task and moves it to dev", async () => {
    const f = await fixture();
    const commands = core(f.stateDir);
    const parked = await commands.createTask({
      title: "Later work",
      initialPrompt: "eventually",
      repositoryId: f.repositoryId,
    });

    const started = await commands.startTask(parked.id);

    expect(started.state).toBe("dev");
    expect(started.branch).toMatch(/^later-work-[a-z0-9]{6}$/);
    expect(started.targetBranch).toBe("main");
    expect((await commands.getTask(parked.id))?.state).toBe("dev");
    const binding = await commands.getTaskWorkspace(parked.id);
    expect(binding?.branch).toBe(started.branch);
    expect(binding?.worktreePath).toContain(".harbormaster-worktrees");
    expect(await git(["branch", "--show-current"], binding?.worktreePath)).toBe(
      started.branch,
    );
  });

  it("gives a parked scratch task its scratch directory when started", async () => {
    const f = await fixture();
    const commands = core(f.stateDir);
    const parked = await commands.createTask({
      title: "Note",
      initialPrompt: "",
    });
    expect(parked.kind).toBe("temp_task");
    expect(await commands.getTaskWorkspace(parked.id)).toBeUndefined();
    const started = await commands.startTask(parked.id);
    expect(started.state).toBe("dev");
    const binding = await commands.getTaskWorkspace(parked.id);
    expect(binding?.scratch).toBe(true);
    expect(binding?.worktreePath).toBe(join(f.stateDir, "scratch", parked.id));
  });

  it("rejects a task that is not in backlog", async () => {
    const f = await fixture();
    const commands = core(f.stateDir);
    const task = await commands.createTask({
      title: "Running",
      initialPrompt: "",
      repositoryId: f.repositoryId,
      start: true,
    });
    await expect(commands.startTask(task.id)).rejects.toThrow(/backlog/);
  });

  it("rolls back on a branch collision: task stays in backlog, no binding, no orphan worktree", async () => {
    const f = await fixture();
    const commands = core(f.stateDir);
    await commands.createTask({
      title: "Existing",
      initialPrompt: "",
      repositoryId: f.repositoryId,
      branch: "task/collide",
      start: true,
    });
    const parked = await commands.createTask({
      title: "Colliding",
      initialPrompt: "",
      repositoryId: f.repositoryId,
      branch: "task/collide",
    });
    expect(await worktreeCount(f.checkout)).toBe(2);

    await expect(commands.startTask(parked.id)).rejects.toThrow();

    const reloaded = await commands.getTask(parked.id);
    expect(reloaded?.state).toBe("backlog");
    expect(await commands.getTaskWorkspace(parked.id)).toBeUndefined();
    expect(await worktreeCount(f.checkout)).toBe(2);
  });

  it("rolls back when the binding cannot be attached: task restored to backlog, worktree removed", async () => {
    const f = await fixture();
    const paths = resolveStatePaths(f.stateDir);
    const realBindings = new JsonWorkspaceBindingAccess(
      paths.workspaceBindingsFile,
      paths.workspaceBindingsLockFile,
    );
    let failAttach = false;
    const bindings: WorkspaceBindingAccess = new Proxy(realBindings, {
      get(target, prop, receiver) {
        if (prop === "attachBinding" && failAttach) {
          return async () => {
            throw new Error("binding store unavailable");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const manager = new CoreManager({
      tasks: new JsonTaskStateAccess(paths.tasksFile, paths.tasksLockFile),
      clock: new FixedClock(),
      ids: sequentialIds,
      events: new CoreEventBus(),
      config: new JsonConfigAccess(paths.configFile),
      repositories: new LocalGitRepositoryAccess(),
      worktrees: new LocalGitWorktreeAccess(),
      bindings,
      sessions: new LocalSessionFileAccess(),
      scratch: new LocalScratchWorkspaceAccess(join(f.stateDir, "scratch")),
      pullRequests: noGithub,
      versions: noGithub,
    });

    const parked = await manager.createTask({
      title: "Fragile",
      initialPrompt: "",
      repositoryId: f.repositoryId,
    });
    failAttach = true;

    await expect(manager.startTask(parked.id)).rejects.toThrow(
      "binding store unavailable",
    );

    const reloaded = await manager.getTask(parked.id);
    expect(reloaded?.state).toBe("backlog");
    expect(reloaded?.branch).toBeUndefined();
    expect(await worktreeCount(f.checkout)).toBe(1);
    // The fresh branch is rolled back too, so a retry can't collide with it.
    expect(await localBranches(f.checkout)).toEqual(["main"]);

    failAttach = false;
    const retried = await manager.startTask(parked.id);
    expect(retried.state).toBe("dev");
  });
});

describe.skipIf(!gitAvailable)("toDone protectedPaths", () => {
  it("refuses to remove a worktree that is a live pane's cwd, warning instead of failing", async () => {
    const f = await fixture();
    const commands = core(f.stateDir);
    const task = await commands.createTask({
      title: "Open pane",
      initialPrompt: "",
      repositoryId: f.repositoryId,
      start: true,
    });
    const worktreePath = (await commands.getTaskWorkspace(task.id))
      ?.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree");

    const result = await commands.toDone(task.id, {
      protectedPaths: ["/somewhere/else", `${worktreePath}/`],
    });

    expect(result.task.state).toBe("done");
    expect(result.warning).toMatch(/worktree left in place/);
    expect(result.warning).toMatch(/live session/);
    expect(await exists(worktreePath)).toBe(true);
    expect(await commands.getTaskWorkspace(task.id)).toBeDefined();
  });

  it("also protects a worktree when a live cwd sits inside it", async () => {
    const f = await fixture();
    const commands = core(f.stateDir);
    const task = await commands.createTask({
      title: "Nested pane",
      initialPrompt: "",
      repositoryId: f.repositoryId,
      start: true,
    });
    const worktreePath = (await commands.getTaskWorkspace(task.id))
      ?.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree");
    const result = await commands.toDone(task.id, {
      protectedPaths: [join(worktreePath, "src")],
    });
    expect(result.warning).toMatch(/live session/);
    expect(await exists(worktreePath)).toBe(true);
  });

  it("still removes the worktree when it is not protected (prefix-only lookalikes don't count)", async () => {
    const f = await fixture();
    const commands = core(f.stateDir);
    const task = await commands.createTask({
      title: "Closed pane",
      initialPrompt: "",
      repositoryId: f.repositoryId,
      start: true,
    });
    const worktreePath = (await commands.getTaskWorkspace(task.id))
      ?.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree");
    const result = await commands.toDone(task.id, {
      protectedPaths: [`${worktreePath}-other`],
      force: { deleteUnmerged: true },
    });
    expect(result.warning).toBeUndefined();
    expect(await exists(worktreePath)).toBe(false);
  });
});

describe.skipIf(!gitAvailable)("claimInitialPrompt", () => {
  it("hands the prompt out exactly once and never for a blank prompt", async () => {
    const f = await fixture();
    const commands = core(f.stateDir);
    const task = await commands.createTask({
      title: "Kickoff",
      initialPrompt: "Fix the flaky test",
      start: true,
    });
    const blank = await commands.createTask({
      title: "Blank",
      initialPrompt: "  ",
    });

    expect(await commands.claimInitialPrompt(task.id)).toBe(
      "Fix the flaky test",
    );
    expect(await commands.claimInitialPrompt(task.id)).toBeUndefined();
    expect((await commands.getTask(task.id))?.initialPromptDeliveredAt).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(await commands.claimInitialPrompt(blank.id)).toBeUndefined();
  });
});
