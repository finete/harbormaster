// Integration tests: CoreManager.toReview/toDone/refresh wired to real git
// repository/worktree access (createCore()'s actual wiring) against real
// temp git repos — same fixture pattern as tests/task-workspace-manager.test.ts
// — with a fake PullRequestAccess/VersionAccess injected via CoreOptions so
// GitHub/HTTP are never actually touched (HARD CONSTRAINT: no real gh/network
// calls). `git push` targets the fixture's own bare repo over the filesystem,
// never a real remote.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  CommitLogEntry,
  PullRequestAccess,
  PullRequestStatus,
  VersionAccess,
} from "../src/contracts/github.js";
import type { Clock, GlobalConfig } from "../src/contracts/index.js";
import { type Core, createCore, isToDoneConfirmation } from "../src/index.js";

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

/** Injectable fake: records calls, never shells out to `gh`. */
class FakePullRequestAccess implements PullRequestAccess {
  statusByBranch = new Map<string, PullRequestStatus | undefined>();
  statusErrorByBranch = new Map<string, Error>();
  ensureOpenCalls: Array<{
    repositoryId: string;
    branch: string;
    worktreePath: string;
    title: string;
    body: string;
    baseBranch: string;
  }> = [];
  ensureOpenResult: PullRequestStatus | undefined;
  ensureOpenError: Error | undefined;
  containsCommitResult: (
    ancestorOid: string,
    descendantOid: string,
  ) => boolean = () => true;

  async status(
    _repositoryId: string,
    branch: string,
  ): Promise<PullRequestStatus | undefined> {
    const error = this.statusErrorByBranch.get(branch);
    if (error) throw error;
    return this.statusByBranch.get(branch);
  }

  async ensureOpen(
    repositoryId: string,
    branch: string,
    worktreePath: string,
    title: string,
    body: string,
    baseBranch: string,
  ): Promise<PullRequestStatus> {
    this.ensureOpenCalls.push({
      repositoryId,
      branch,
      worktreePath,
      title,
      body,
      baseBranch,
    });
    if (this.ensureOpenError) throw this.ensureOpenError;
    if (!this.ensureOpenResult)
      throw new Error("ensureOpenResult not configured");
    return this.ensureOpenResult;
  }

  async containsCommit(
    _repositoryId: string,
    ancestorOid: string,
    descendantOid: string,
  ): Promise<boolean> {
    return this.containsCommitResult(ancestorOid, descendantOid);
  }

  async commitLog(): Promise<CommitLogEntry[]> {
    return [];
  }
}

class FakeVersionAccess implements VersionAccess {
  documents = new Map<string, string>();
  async fetchText(url: string): Promise<string> {
    const doc = this.documents.get(url);
    if (doc === undefined) throw new Error(`no fake document for ${url}`);
    return doc;
  }
}

function pr(overrides: Partial<PullRequestStatus> = {}): PullRequestStatus {
  return {
    number: 7,
    url: "https://github.example/acme/harbor-repo/pull/7",
    state: "OPEN",
    isDraft: false,
    reviewRequested: false,
    reviewSubmitted: false,
    checkedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface Fixture {
  stateDir: string;
  codeRoot: string;
  checkout: string;
  core: Core;
  pullRequests: FakePullRequestAccess;
  versions: FakeVersionAccess;
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harbormaster-github-mgr-")),
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
  // Deliberately left pointing at the local bare repo (not a GitHub URL):
  // toReview's push verb needs a remote it can actually reach, and the
  // fake PullRequestAccess never shells out to `gh`, so no real GitHub
  // identity is needed for these tests.

  await mkdir(stateDir, { recursive: true });
  // No `movers` key: the built-in default order (an explicit [] disables).
  const config: GlobalConfig = {
    automation: true,
    codeRoot,
    branchPrefix: "",
  };
  await writeFile(join(stateDir, "config.json"), JSON.stringify(config));

  counter = 0;
  const pullRequests = new FakePullRequestAccess();
  const versions = new FakeVersionAccess();
  const core = createCore({
    stateDir,
    clock: new FixedClock(new Date("2026-01-01T00:00:00.000Z")),
    ids: sequentialIds,
    pullRequests,
    versions,
  });

  return { stateDir, codeRoot, checkout, core, pullRequests, versions };
}

async function writeConfig(
  f: Fixture,
  patch: Partial<GlobalConfig>,
): Promise<void> {
  await writeFile(
    join(f.stateDir, "config.json"),
    JSON.stringify({
      automation: true,
      codeRoot: f.codeRoot,
      branchPrefix: "",
      ...patch,
    }),
  );
}

describe.skipIf(!gitAvailable)("CoreManager toReview", () => {
  it("pushes the branch, opens a PR, stores task.pr, and moves the task to awaiting/review", async () => {
    const f = await fixture();
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");
    const task = await f.core.commands.createTask({
      title: "Add widget",
      initialPrompt: "do it",
      repositoryId: repo.id,
      start: true,
    });
    await f.core.commands.moveTask(task.id, "dev");

    f.pullRequests.ensureOpenResult = pr({ reviewRequested: false });

    const result = await f.core.commands.toReview(task.id);

    expect(result.state).toBe("awaiting");
    expect(result.awaiting).toEqual({ kind: "review" });
    expect(result.pr).toMatchObject({ number: 7, state: "open" });
    expect(f.pullRequests.ensureOpenCalls).toHaveLength(1);
    expect(f.pullRequests.ensureOpenCalls[0]).toMatchObject({
      repositoryId: repo.id,
      branch: task.branch,
      title: task.title,
      baseBranch: "main",
    });

    // The branch really was pushed to the fixture's own remote.
    const remoteBranches = await git(["branch", "-r"], f.checkout);
    expect(remoteBranches).toContain(`origin/${task.branch}`);
  });

  it("leaves the task unmoved when ensureOpen fails (the branch push already happened, but no state is corrupted)", async () => {
    const f = await fixture();
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");
    const task = await f.core.commands.createTask({
      title: "Add widget",
      initialPrompt: "do it",
      repositoryId: repo.id,
      start: true,
    });
    await f.core.commands.moveTask(task.id, "dev");

    f.pullRequests.ensureOpenError = new Error("gh: network unreachable");

    await expect(f.core.commands.toReview(task.id)).rejects.toThrow(
      "network unreachable",
    );

    const reloaded = await f.core.commands.getTask(task.id);
    expect(reloaded?.state).toBe("dev");
    expect(reloaded?.pr).toBeUndefined();
  });

  it("rejects a scratch (repository-less) task", async () => {
    const f = await fixture();
    const task = await f.core.commands.createTask({
      title: "Scratch",
      initialPrompt: "x",
      kind: "temp_task",
    });
    await f.core.commands.moveTask(task.id, "dev");
    await expect(f.core.commands.toReview(task.id)).rejects.toThrow(
      "repository-backed task",
    );
  });
});

describe.skipIf(!gitAvailable)("CoreManager toDone", () => {
  it("asks before deleting an unmerged workspace; cancel leaves everything, confirming removes the worktree and -D's the branch", async () => {
    const f = await fixture();
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");
    const task = await f.core.commands.createTask({
      title: "Add widget",
      initialPrompt: "do it",
      repositoryId: repo.id,
      start: true,
    });
    const worktree = (await f.core.commands.getTaskWorkspace(task.id))!
      .worktreePath!;
    // A commit only on the task branch: `git branch -d` would refuse it.
    await writeFile(join(worktree, "feature.txt"), "feature\n");
    await git(["add", "."], worktree);
    await gitCommit(worktree, "feature work");

    const question = await f.core.commands.toDone(task.id);

    expect(question).toEqual({
      requiresConfirmation: "unmerged",
      detail: expect.stringContaining("isn't merged"),
    });
    // Not moved, nothing removed (a cancelled dialog = this state).
    expect((await f.core.commands.getTask(task.id))?.state).toBe("dev");
    expect(
      (await f.core.commands.getTaskWorkspace(task.id))?.worktreePath,
    ).toBe(worktree);
    expect(await git(["branch", "--list", task.branch!], f.checkout)).toContain(
      task.branch!,
    );

    const result = await f.core.commands.toDone(task.id, {
      force: { deleteUnmerged: true },
    });

    expect(isToDoneConfirmation(result)).toBe(false);
    expect(result).toMatchObject({ task: { state: "done" } });
    expect(result).not.toHaveProperty("warning");
    // The binding is parked (worktree cleared), not deleted: its session
    // identity survives for a later reopen.
    const parked = await f.core.commands.getTaskWorkspace(task.id);
    expect(parked).toBeDefined();
    expect(parked?.worktreePath).toBeUndefined();
    expect(
      await git(["worktree", "list", "--porcelain"], f.checkout),
    ).not.toContain(task.branch!);
    expect(await git(["branch", "--list", task.branch!], f.checkout)).toBe("");
  });

  it("asks about uncommitted changes first, then the unmerged branch; with both answers it force-removes and lands", async () => {
    const f = await fixture();
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");
    const task = await f.core.commands.createTask({
      title: "Add widget",
      initialPrompt: "do it",
      repositoryId: repo.id,
      start: true,
    });
    const worktree = (await f.core.commands.getTaskWorkspace(task.id))!
      .worktreePath!;
    await writeFile(join(worktree, "scratch.txt"), "dirty\n");

    expect(await f.core.commands.toDone(task.id)).toEqual({
      requiresConfirmation: "dirty",
      detail: expect.stringContaining("uncommitted changes"),
    });
    expect(
      await f.core.commands.toDone(task.id, { force: { removeDirty: true } }),
    ).toMatchObject({ requiresConfirmation: "unmerged" });
    // Still untouched after two questions.
    expect((await f.core.commands.getTask(task.id))?.state).toBe("dev");
    expect(await git(["status", "--porcelain"], worktree)).toContain(
      "scratch.txt",
    );

    const result = await f.core.commands.toDone(task.id, {
      force: { removeDirty: true, deleteUnmerged: true },
    });

    expect(result).toMatchObject({ task: { state: "done" } });
    expect(
      (await f.core.commands.getTaskWorkspace(task.id))?.worktreePath,
    ).toBeUndefined();
    expect(
      await git(["worktree", "list", "--porcelain"], f.checkout),
    ).not.toContain(task.branch!);
  });

  it("never asks about a worktree open in a live pane: it lands with a warning and keeps the worktree", async () => {
    const f = await fixture();
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");
    const task = await f.core.commands.createTask({
      title: "Add widget",
      initialPrompt: "do it",
      repositoryId: repo.id,
      start: true,
    });
    const worktree = (await f.core.commands.getTaskWorkspace(task.id))!
      .worktreePath!;
    await writeFile(join(worktree, "scratch.txt"), "dirty\n");

    const result = await f.core.commands.toDone(task.id, {
      protectedPaths: [worktree],
    });

    expect(result).toMatchObject({
      task: { state: "done" },
      warning: expect.stringMatching(/live session/),
    });
    expect(
      (await f.core.commands.getTaskWorkspace(task.id))?.worktreePath,
    ).toBe(worktree);
  });

  it("force-deletes (-D) a merged branch even though a squash merge left it unmerged locally", async () => {
    const f = await fixture();
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");
    const task = await f.core.commands.createTask({
      title: "Add widget",
      initialPrompt: "do it",
      repositoryId: repo.id,
      start: true,
    });
    await f.core.commands.moveTask(task.id, "dev");
    const binding = await f.core.commands.getTaskWorkspace(task.id);
    // A commit unique to the task branch, never merged into local main —
    // GitHub says merged (remotely), but the safe local delete must refuse.
    await writeFile(join(binding!.worktreePath!, "feature.txt"), "feature\n");
    await git(["add", "."], binding!.worktreePath);
    await gitCommit(binding!.worktreePath!, "feature work");

    f.pullRequests.statusByBranch.set(task.branch!, pr({ state: "MERGED" }));
    await f.core.commands.refresh();

    const result = await f.core.commands.toDone(task.id);

    expect(result.task.state).toBe("done");
    expect(result.warning).toBeUndefined();
    // The worktree itself was removed cleanly (it had no uncommitted changes).
    expect(
      (await f.core.commands.getTaskWorkspace(task.id))?.worktreePath,
    ).toBeUndefined();
    // `git branch -d` would refuse (the commit never reached local main);
    // a merged PR is proof enough, so the branch is gone.
    expect(await git(["branch", "--list", task.branch!], f.checkout)).toBe("");
  });
});

describe.skipIf(!gitAvailable)("CoreManager refresh", () => {
  it("updates task.pr and moves dev work into awaiting/review on a requested review", async () => {
    const f = await fixture();
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");
    const task = await f.core.commands.createTask({
      title: "Add widget",
      initialPrompt: "do it",
      repositoryId: repo.id,
      start: true,
    });
    await f.core.commands.moveTask(task.id, "dev");
    f.pullRequests.statusByBranch.set(
      task.branch!,
      pr({ reviewRequested: true }),
    );

    const { warnings } = await f.core.commands.refresh();

    expect(warnings).toEqual([]);
    const reloaded = await f.core.commands.getTask(task.id);
    expect(reloaded?.state).toBe("awaiting");
    expect(reloaded?.awaiting).toEqual({ kind: "review" });
    expect(reloaded?.pr).toMatchObject({ number: 7, reviewRequested: true });
  });

  it("updates task.pr but never moves anything when automation is off", async () => {
    const f = await fixture();
    await writeConfig(f, { automation: false });
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");
    const task = await f.core.commands.createTask({
      title: "Add widget",
      initialPrompt: "do it",
      repositoryId: repo.id,
      start: true,
    });
    await f.core.commands.moveTask(task.id, "dev");
    f.pullRequests.statusByBranch.set(
      task.branch!,
      pr({ reviewRequested: true }),
    );

    await f.core.commands.refresh();

    const reloaded = await f.core.commands.getTask(task.id);
    expect(reloaded?.state).toBe("dev");
    expect(reloaded?.pr).toMatchObject({ reviewRequested: true });
  });

  it("isolates a per-task error: one task's PR-status failure never blocks another task's move", async () => {
    const f = await fixture();
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");
    const broken = await f.core.commands.createTask({
      title: "Broken",
      initialPrompt: "x",
      repositoryId: repo.id,
      start: true,
    });
    await f.core.commands.moveTask(broken.id, "dev");
    const healthy = await f.core.commands.createTask({
      title: "Healthy",
      initialPrompt: "y",
      repositoryId: repo.id,
      start: true,
      branch: "healthy-branch",
    });
    await f.core.commands.moveTask(healthy.id, "dev");

    f.pullRequests.statusErrorByBranch.set(
      broken.branch!,
      new Error("gh: rate limited"),
    );
    f.pullRequests.statusByBranch.set(
      healthy.branch!,
      pr({ reviewRequested: true }),
    );

    const { warnings } = await f.core.commands.refresh();

    expect(warnings).toEqual([expect.stringContaining("rate limited")]);
    const reloadedBroken = await f.core.commands.getTask(broken.id);
    expect(reloadedBroken?.state).toBe("dev");
    expect(reloadedBroken?.pr).toBeUndefined();
    const reloadedHealthy = await f.core.commands.getTask(healthy.id);
    expect(reloadedHealthy?.state).toBe("awaiting");
  });

  it("advances a deployment pipeline exactly one stage per refresh() call", async () => {
    const f = await fixture();
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");
    await writeConfig(f, {
      repositories: {
        [repo.id]: {
          deployment: {
            stages: [
              {
                id: "pre",
                label: "Preprod",
                hook: "version-endpoint",
                options: { url: "https://pre.example/version" },
              },
              {
                id: "prod",
                label: "Production",
                hook: "version-endpoint",
                options: { url: "https://prod.example/version" },
              },
            ],
          },
        },
      },
    });
    const task = await f.core.commands.createTask({
      title: "Add widget",
      initialPrompt: "do it",
      repositoryId: repo.id,
      start: true,
    });
    await f.core.commands.moveTask(task.id, "dev");

    const mergeCommit = { oid: "abcdef0123456", targetBranch: "main" };
    f.pullRequests.statusByBranch.set(
      task.branch!,
      pr({
        state: "MERGED",
        mergeCommit: { ...mergeCommit, url: "https://x/commit/abcdef0123456" },
      }),
    );
    f.versions.documents.set(
      "https://pre.example/version",
      "v1.0.0+cccccc1234567",
    );
    f.versions.documents.set(
      "https://prod.example/version",
      "v1.0.0+dddddd1234567",
    );
    // Only the "pre" deployed commit matches the task's merge commit so far.
    f.pullRequests.containsCommitResult = (_ancestor, descendant) =>
      descendant === "cccccc1234567";

    await f.core.commands.refresh();
    let reloaded = await f.core.commands.getTask(task.id);
    expect(reloaded?.state).toBe("awaiting");
    expect(reloaded?.awaiting).toEqual({
      kind: "deploy",
      stageId: "pre",
      stageLabel: "Preprod",
    });

    await f.core.commands.refresh();
    reloaded = await f.core.commands.getTask(task.id);
    expect(reloaded?.awaiting).toEqual({
      kind: "deploy",
      stageId: "prod",
      stageLabel: "Production",
    });

    // Still stuck at "prod" until the prod deploy actually happens.
    await f.core.commands.refresh();
    reloaded = await f.core.commands.getTask(task.id);
    expect(reloaded?.awaiting).toEqual({
      kind: "deploy",
      stageId: "prod",
      stageLabel: "Production",
    });

    f.pullRequests.containsCommitResult = () => true;
    await f.core.commands.refresh();
    reloaded = await f.core.commands.getTask(task.id);
    expect(reloaded?.state).toBe("done");
  });
});
