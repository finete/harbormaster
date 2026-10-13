// Integration tests: CoreManager.createTask/deleteTask wired to real git
// repository/worktree access (createCore()'s actual wiring), against real
// temp git repos — same fixture pattern as tests/git-workspace-access.test.ts.

import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Clock } from "../src/contracts/index.js";
import { type Core, createCore } from "../src/index.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function gitCommit(cwd: string, message: string): Promise<void> {
  await git(
    [
      "-c",
      "user.name=Harbormaster Test",
      "-c",
      "user.email=harbormaster-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      message,
    ],
    cwd,
  );
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
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
}

let counter = 0;
const sequentialIds = {
  next: () => `id-${(++counter).toString().padStart(8, "0")}`,
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** A state dir + a code root containing one seeded repository checkout. */
async function fixture(): Promise<{
  stateDir: string;
  codeRoot: string;
  checkout: string;
  core: Core;
}> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harbormaster-workspace-mgr-")),
  );
  roots.push(root);

  const stateDir = join(root, "state");
  const codeRoot = join(root, "Code");
  await mkdir(codeRoot, { recursive: true });

  const bare = join(root, "upstream.git");
  await git(["init", "--bare", "-b", "main", bare]);

  const checkout = join(codeRoot, "harbor-repo");
  await git(["clone", bare, checkout]);
  await writeFile(join(checkout, "README.md"), "fixture\n");
  await git(["add", "."], checkout);
  await gitCommit(checkout, "initial commit");
  await git(["push", "origin", "main"], checkout);
  await git(
    ["remote", "set-url", "origin", "git@github.com:acme/harbor-repo.git"],
    checkout,
  );

  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, "config.json"),
    JSON.stringify({
      automation: true,
      movers: [],
      codeRoot,
      branchPrefix: "",
    }),
  );

  counter = 0;
  const core = createCore({
    stateDir,
    clock: new FixedClock(new Date("2026-01-01T00:00:00.000Z")),
    ids: sequentialIds,
  });

  return { stateDir, codeRoot, checkout, core };
}

describe.skipIf(!gitAvailable)("CoreManager git workspace wiring", () => {
  it("listRepositories discovers the repo under the configured codeRoot", async () => {
    const f = await fixture();
    const repos = await f.core.commands.listRepositories();
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      id: "github.com/acme/harbor-repo",
      root: f.checkout,
      defaultBranch: "main",
    });
  });

  it("createTask with a repositoryId creates a worktree, persists a binding, and prefixes the branch", async () => {
    const f = await fixture();
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");

    const task = await f.core.commands.createTask({
      title: "Add Widget!",
      initialPrompt: "do it",
      repositoryId: repo.id,
      start: true,
    });

    expect(task.repositoryId).toBe(repo.id);
    expect(task.targetBranch).toBe("main");
    expect(task.branch).toMatch(/^add-widget-[a-z0-9]{6}$/);

    const binding = await f.core.commands.getTaskWorkspace(task.id);
    expect(binding).toBeDefined();
    expect(binding?.branch).toBe(task.branch);
    expect(binding?.worktreePath).toContain(".harbormaster-worktrees");

    // The worktree actually exists on disk and is checked out to the branch.
    const branchInWorktree = await git(
      ["branch", "--show-current"],
      binding?.worktreePath,
    );
    expect(branchInWorktree).toBe(task.branch);
  });

  it("honors a configured branchPrefix", async () => {
    const f = await fixture();
    await writeFile(
      join(f.stateDir, "config.json"),
      JSON.stringify({
        automation: true,
        movers: [],
        codeRoot: f.codeRoot,
        branchPrefix: "alice",
      }),
    );
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");

    const task = await f.core.commands.createTask({
      title: "Add Widget",
      initialPrompt: "do it",
      repositoryId: repo.id,
      start: true,
    });

    expect(task.branch).toMatch(/^alice\/add-widget-[a-z0-9]{6}$/);
  });

  it("rolls back cleanly when worktree creation fails (branch collision): no task, no orphan worktree", async () => {
    const f = await fixture();
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");

    // Pre-create a branch/worktree with a fixed name, then force a second
    // createTask to collide with it via an explicit `branch` override.
    const existing = await f.core.commands.createTask({
      title: "Existing",
      initialPrompt: "x",
      repositoryId: repo.id,
      start: true,
      branch: "task/collide",
    });
    expect(existing.branch).toBe("task/collide");

    await expect(
      f.core.commands.createTask({
        title: "Colliding task",
        initialPrompt: "y",
        repositoryId: repo.id,
        start: true,
        branch: "task/collide",
      }),
    ).rejects.toThrow();

    // No second task was persisted.
    const columns = await f.core.commands.listBoard();
    const titles = columns
      .flatMap((c) => c.groups.flatMap((g) => g.tasks))
      .map((t) => t.title);
    expect(titles).toEqual(["Existing"]);

    // No orphan worktree directory was left for the failed attempt, and the
    // existing worktree/binding survive untouched.
    const binding = await f.core.commands.getTaskWorkspace(existing.id);
    expect(binding?.worktreePath).toBeDefined();
    await expect(
      readFile(join(binding!.worktreePath!, "README.md")),
    ).resolves.toBeDefined();

    const worktrees = await git(
      ["worktree", "list", "--porcelain"],
      f.checkout,
    );
    expect(worktrees.match(/^worktree /gm)?.length).toBe(2); // main checkout + the one surviving task worktree
  });

  it("deleteTask without removeWorkspace leaves the worktree on disk but removes the task and binding", async () => {
    const f = await fixture();
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");

    const task = await f.core.commands.createTask({
      title: "Doomed",
      initialPrompt: "x",
      repositoryId: repo.id,
      start: true,
    });
    const binding = await f.core.commands.getTaskWorkspace(task.id);
    const worktreePath = binding?.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree binding");

    await f.core.commands.deleteTask(task.id);

    expect(await f.core.commands.getTask(task.id)).toBeUndefined();
    expect(await f.core.commands.getTaskWorkspace(task.id)).toBeUndefined();
    await expect(
      readFile(join(worktreePath, "README.md")),
    ).resolves.toBeDefined();
  });

  it("deleteTask with removeWorkspace removes a clean worktree", async () => {
    const f = await fixture();
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");

    const task = await f.core.commands.createTask({
      title: "Cleanable",
      initialPrompt: "x",
      repositoryId: repo.id,
      start: true,
    });
    const binding = await f.core.commands.getTaskWorkspace(task.id);
    const worktreePath = binding?.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree binding");

    await f.core.commands.deleteTask(task.id, { removeWorkspace: true });

    expect(await f.core.commands.getTask(task.id)).toBeUndefined();
    const worktrees = await git(
      ["worktree", "list", "--porcelain"],
      f.checkout,
    );
    expect(worktrees).not.toContain(worktreePath);
  });

  it("deleteTask with removeWorkspace propagates a dirty-refusal and leaves the task intact", async () => {
    const f = await fixture();
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");

    const task = await f.core.commands.createTask({
      title: "Dirty",
      initialPrompt: "x",
      repositoryId: repo.id,
      start: true,
    });
    const binding = await f.core.commands.getTaskWorkspace(task.id);
    const worktreePath = binding?.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree binding");
    await writeFile(join(worktreePath, "scratch.txt"), "uncommitted\n");

    await expect(
      f.core.commands.deleteTask(task.id, { removeWorkspace: true }),
    ).rejects.toThrow(/dirty/i);

    // The task and binding survive the failed cleanup attempt.
    expect(await f.core.commands.getTask(task.id)).toBeDefined();
    expect(await f.core.commands.getTaskWorkspace(task.id)).toBeDefined();
  });
});
