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

  /** A started task plus a detached `<worktree>-pr7` review checkout next to it. */
  async function taskWithReviewCheckout(
    f: Awaited<ReturnType<typeof fixture>>,
    title: string,
  ) {
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");
    const task = await f.core.commands.createTask({
      title,
      initialPrompt: "x",
      repositoryId: repo.id,
      start: true,
    });
    const worktreePath = (await f.core.commands.getTaskWorkspace(task.id))
      ?.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree binding");
    const review = `${worktreePath}-pr7`;
    await git(["worktree", "add", "--detach", review, "main"], f.checkout);
    return { task, worktreePath, review };
  }

  /** The registered worktree paths (exact, so `-pr7` never matches its task's path). */
  const listedWorktrees = async (f: { checkout: string }) =>
    (await git(["worktree", "list", "--porcelain"], f.checkout))
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));

  it("deleteTask with keepWorkspace leaves the worktree on disk but removes the task and binding", async () => {
    const f = await fixture();
    const { task, worktreePath } = await taskWithReviewCheckout(f, "Doomed");

    await f.core.commands.deleteTask(task.id, { keepWorkspace: true });

    expect(await f.core.commands.getTask(task.id)).toBeUndefined();
    expect(await f.core.commands.getTaskWorkspace(task.id)).toBeUndefined();
    await expect(
      readFile(join(worktreePath, "README.md")),
    ).resolves.toBeDefined();
  });

  it("deleteTask removes a clean worktree and its review checkouts by default", async () => {
    const f = await fixture();
    const { task, worktreePath, review } = await taskWithReviewCheckout(
      f,
      "Cleanable",
    );

    await f.core.commands.deleteTask(task.id);

    expect(await f.core.commands.getTask(task.id)).toBeUndefined();
    const worktrees = await listedWorktrees(f);
    expect(worktrees).not.toContain(worktreePath);
    expect(worktrees).not.toContain(review);
  });

  it("deleteTask refuses a dirty or live worktree and leaves the task intact; removeDirty overrides dirty", async () => {
    const f = await fixture();
    const { task, worktreePath } = await taskWithReviewCheckout(f, "Dirty");
    await writeFile(join(worktreePath, "scratch.txt"), "uncommitted\n");

    await expect(f.core.commands.deleteTask(task.id)).rejects.toThrow(/dirty/i);
    await expect(
      f.core.commands.deleteTask(task.id, {
        removeDirty: true,
        protectedPaths: [worktreePath],
      }),
    ).rejects.toThrow(/live session/);
    // The task and binding survive both refusals.
    expect(await f.core.commands.getTask(task.id)).toBeDefined();
    expect(await f.core.commands.getTaskWorkspace(task.id)).toBeDefined();

    await f.core.commands.deleteTask(task.id, { removeDirty: true });
    expect(await f.core.commands.getTask(task.id)).toBeUndefined();
    const left = await listedWorktrees(f);
    expect(left).not.toContain(worktreePath);
    expect(left).not.toContain(`${worktreePath}-pr7`);
  });

  it("toDone reaps clean review checkouts next to the task worktree, but not a live or dirty one", async () => {
    const f = await fixture();
    const { task, worktreePath, review } = await taskWithReviewCheckout(
      f,
      "Reviewed",
    );
    const live = `${worktreePath}-pr8`;
    const dirty = `${worktreePath}-prlocal`;
    await git(["worktree", "add", "--detach", live, "main"], f.checkout);
    await git(["worktree", "add", "--detach", dirty, "main"], f.checkout);
    await writeFile(join(dirty, "notes.txt"), "keep me\n");

    const result = await f.core.commands.toDone(task.id, {
      force: { confirmed: true },
      protectedPaths: [live],
    });

    expect("task" in result && result.task.state).toBe("done");
    // The leftover is the app's business (audit log + orphan scan), never a
    // warning back to the user.
    expect(result).not.toHaveProperty("warning");
    const worktrees = await listedWorktrees(f);
    expect(worktrees).not.toContain(worktreePath);
    expect(worktrees).not.toContain(review);
    expect(worktrees).toContain(live);
    expect(worktrees).toContain(dirty);
  });

  it("scanOrphanWorktrees lists only unbound directories under the worktrees root, sized", async () => {
    const f = await fixture();
    const { worktreePath, review } = await taskWithReviewCheckout(f, "Bound");
    const stray = join(
      f.codeRoot,
      ".harbormaster-worktrees",
      "observed-abc123",
    );
    await mkdir(stray, { recursive: true });
    await writeFile(join(stray, "blob"), "x".repeat(4096));

    const report = await f.core.commands.scanOrphanWorktrees();

    expect(report.root).toBe(join(f.codeRoot, ".harbormaster-worktrees"));
    const paths = report.orphans.map((orphan) => orphan.path).sort();
    expect(paths).toEqual([review, stray].sort());
    expect(paths).not.toContain(worktreePath);
    const strayEntry = report.orphans.find((orphan) => orphan.path === stray);
    expect(strayEntry?.sizeBytes).toBeGreaterThanOrEqual(4096);
    // Two small orphans stay under both default thresholds.
    expect(report.warning).toBeUndefined();
  });

  it("listRepositories collapses several checkouts of the same repo into one entry, and createTask always provisions off the primary", async () => {
    const f = await fixture();
    // A second checkout of the same remote, alphabetically after "harbor-repo"
    // (mirroring arnac/arnac2/arnac3) "- without a preferredCheckout override,
    // the primary stays "harbor-repo".
    const second = join(f.codeRoot, "harbor-repo2");
    await git(["clone", join(f.codeRoot, "..", "upstream.git"), second]);
    await git(
      ["remote", "set-url", "origin", "git@github.com:acme/harbor-repo.git"],
      second,
    );

    const repos = await f.core.commands.listRepositories();
    expect(repos).toHaveLength(1);
    const repo = repos[0]!;
    expect(repo.root).toBe(f.checkout);
    expect(repo.checkouts).toEqual([
      { root: f.checkout, isPrimary: true },
      { root: second, isPrimary: false },
    ]);

    const task = await f.core.commands.createTask({
      title: "Primary provisioning",
      initialPrompt: "x",
      repositoryId: repo.id,
      start: true,
    });
    const binding = await f.core.commands.getTaskWorkspace(task.id);
    if (!binding?.worktreePath) throw new Error("expected a worktree binding");
    // Each clone has its own independent git worktree bookkeeping: the
    // worktree only shows up in `git worktree list` run from whichever
    // checkout it was actually created from. Asserting it shows up for
    // f.checkout but not for `second` proves provisioning used the primary.
    const fromPrimary = await git(
      ["worktree", "list", "--porcelain"],
      f.checkout,
    );
    const fromSecond = await git(["worktree", "list", "--porcelain"], second);
    expect(fromPrimary).toContain(binding.worktreePath);
    expect(fromSecond).not.toContain(binding.worktreePath);
  });

  it("honors repositories.<id>.preferredCheckout when provisioning a worktree", async () => {
    const f = await fixture();
    const second = join(f.codeRoot, "harbor-repo2");
    await git(["clone", join(f.codeRoot, "..", "upstream.git"), second]);
    await git(
      ["remote", "set-url", "origin", "git@github.com:acme/harbor-repo.git"],
      second,
    );

    await writeFile(
      join(f.stateDir, "config.json"),
      JSON.stringify({
        automation: true,
        movers: [],
        codeRoot: f.codeRoot,
        branchPrefix: "",
        repositories: {
          "github.com/acme/harbor-repo": { preferredCheckout: second },
        },
      }),
    );

    const repos = await f.core.commands.listRepositories();
    expect(repos).toHaveLength(1);
    expect(repos[0]?.root).toBe(second);

    const task = await f.core.commands.createTask({
      title: "Preferred checkout provisioning",
      initialPrompt: "x",
      repositoryId: repos[0]!.id,
      start: true,
    });
    const binding = await f.core.commands.getTaskWorkspace(task.id);
    if (!binding?.worktreePath) throw new Error("expected a worktree binding");
    const fromSecond = await git(["worktree", "list", "--porcelain"], second);
    const fromPrimary = await git(
      ["worktree", "list", "--porcelain"],
      f.checkout,
    );
    expect(fromSecond).toContain(binding.worktreePath);
    expect(fromPrimary).not.toContain(binding.worktreePath);
  });
});
