// Integration tests: CoreManager.toAwait/toDone/refresh wired to real git
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

  squashMergeCalls: Array<{
    repositoryId: string;
    pullRequestNumber: number;
    branch: string;
  }> = [];
  squashMergeError: Error | undefined;

  async squashMerge(
    repositoryId: string,
    pullRequestNumber: number,
    branch: string,
  ): Promise<PullRequestStatus> {
    this.squashMergeCalls.push({ repositoryId, pullRequestNumber, branch });
    if (this.squashMergeError) throw this.squashMergeError;
    const merged = pr({
      number: pullRequestNumber,
      state: "MERGED",
      mergeCommit: {
        oid: "abcdef1234567",
        targetBranch: "main",
        url: "https://github.example/acme/harbor-repo/commit/abcdef1234567",
      },
    });
    this.statusByBranch.set(branch, merged);
    return merged;
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
  // the review kind's push verb needs a remote it can actually reach, and the
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

describe.skipIf(!gitAvailable)("CoreManager toAwait: review kind", () => {
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

    const result = await f.core.commands.toAwait(task.id, "review");

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
    expect(f.pullRequests.squashMergeCalls).toEqual([]);

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

    await expect(f.core.commands.toAwait(task.id, "review")).rejects.toThrow(
      "network unreachable",
    );

    const reloaded = await f.core.commands.getTask(task.id);
    expect(reloaded?.state).toBe("dev");
    expect(reloaded?.pr).toBeUndefined();
  });

  it("moves a repository-less task straight to awaiting/review: nothing to push, no PR (pi-home's scratch path)", async () => {
    const f = await fixture();
    const task = await f.core.commands.createTask({
      title: "Scratch",
      initialPrompt: "x",
      kind: "temp_task",
    });
    await f.core.commands.moveTask(task.id, "dev");
    const result = await f.core.commands.toAwait(task.id, "review");
    expect(result.state).toBe("awaiting");
    expect(result.awaiting).toEqual({ kind: "review" });
    expect(result.pr).toBeUndefined();
    expect(f.pullRequests.ensureOpenCalls).toEqual([]);
  });

  it("rejects a repository-backed backlog task (no branch yet) and unknown kinds, leaving the task unmoved", async () => {
    const f = await fixture();
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");
    const parked = await f.core.commands.createTask({
      title: "Parked",
      initialPrompt: "",
      repositoryId: repo.id,
    });
    // backlog -> awaiting is not an allowed transition at all.
    await expect(f.core.commands.toAwait(parked.id, "review")).rejects.toThrow(
      /Cannot move a task from "backlog"/,
    );
    const started = await f.core.commands.startTask(parked.id);
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid kind id.
      f.core.commands.toAwait(started.id, "carrier-pigeon" as any),
    ).rejects.toThrow("Unknown awaiting kind: carrier-pigeon");
    expect((await f.core.commands.getTask(started.id))?.state).toBe("dev");
  });
});

describe.skipIf(!gitAvailable)("CoreManager toAwait: slack kind", () => {
  it("stores the trimmed permalink without any external call; a blank permalink is omitted", async () => {
    const f = await fixture();
    const task = await f.core.commands.createTask({
      title: "Ask in Slack",
      initialPrompt: "",
      start: true,
    });
    const withLink = await f.core.commands.toAwait(task.id, "slack", {
      inputs: { permalink: "  https://acme.slack.com/archives/C1/p2  " },
    });
    expect(withLink.state).toBe("awaiting");
    expect(withLink.awaiting).toEqual({
      kind: "slack",
      permalink: "https://acme.slack.com/archives/C1/p2",
    });

    const other = await f.core.commands.createTask({
      title: "Ask again",
      initialPrompt: "",
      start: true,
    });
    const blank = await f.core.commands.toAwait(other.id, "slack", {
      inputs: { permalink: "   ", unrelated: "ignored" },
    });
    expect(blank.awaiting).toEqual({ kind: "slack" });
    expect(f.pullRequests.ensureOpenCalls).toEqual([]);
    expect(f.pullRequests.squashMergeCalls).toEqual([]);
  });
});

describe.skipIf(!gitAvailable)("CoreManager toAwait: deploy kind", () => {
  async function reviewedTask(f: Fixture) {
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");
    const task = await f.core.commands.createTask({
      title: "Ship widget",
      initialPrompt: "do it",
      repositoryId: repo.id,
      start: true,
    });
    f.pullRequests.ensureOpenResult = pr();
    await f.core.commands.toAwait(task.id, "review");
    f.pullRequests.statusByBranch.set(task.branch!, pr());
    return { repo, task };
  }

  it("squash-merges a still-open PR, then waits at the stage-less production wait when the repository has no pipeline", async () => {
    const f = await fixture();
    const { repo, task } = await reviewedTask(f);

    const result = await f.core.commands.toAwait(task.id, "deploy");

    expect(f.pullRequests.squashMergeCalls).toEqual([
      { repositoryId: repo.id, pullRequestNumber: 7, branch: task.branch },
    ]);
    expect(result.state).toBe("awaiting");
    expect(result.awaiting).toEqual({
      kind: "deploy",
      stageId: "__production",
      stageLabel: "Production deploy",
    });
    expect(result.pr).toMatchObject({
      number: 7,
      state: "merged",
      mergeCommit: { oid: "abcdef1234567", targetBranch: "main" },
    });
  });

  it("enters the first configured deployment stage", async () => {
    const f = await fixture();
    const { repo, task } = await reviewedTask(f);
    await writeConfig(f, {
      repositories: {
        [repo.id]: {
          deployment: {
            stages: [
              { id: "pre", label: "Preprod deploy" },
              { id: "prod", label: "Production" },
            ],
          },
        },
      },
    });

    const result = await f.core.commands.toAwait(task.id, "deploy");

    expect(f.pullRequests.squashMergeCalls).toHaveLength(1);
    expect(result.awaiting).toEqual({
      kind: "deploy",
      stageId: "pre",
      stageLabel: "Preprod deploy",
    });
    // The next refresh keeps it there (the movers consume the kind as data).
    await f.core.commands.refresh();
    expect((await f.core.commands.getTask(task.id))?.awaiting).toMatchObject({
      stageId: "pre",
    });
  });

  it("never merges an already-merged PR; it just enters the pipeline", async () => {
    const f = await fixture();
    const { task } = await reviewedTask(f);
    f.pullRequests.statusByBranch.set(
      task.branch!,
      pr({
        state: "MERGED",
        mergeCommit: { oid: "fedcba7654321", targetBranch: "main", url: "u" },
      }),
    );

    const result = await f.core.commands.toAwait(task.id, "deploy");

    expect(f.pullRequests.squashMergeCalls).toEqual([]);
    expect(result.awaiting).toMatchObject({ stageId: "__production" });
    expect(result.pr).toMatchObject({ state: "merged" });
  });

  it("rejects without a PR, or when the merge fails, leaving the task unmoved", async () => {
    const f = await fixture();
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");
    const task = await f.core.commands.createTask({
      title: "No PR",
      initialPrompt: "",
      repositoryId: repo.id,
      start: true,
    });
    await expect(f.core.commands.toAwait(task.id, "deploy")).rejects.toThrow(
      "Task has no pull request to merge",
    );
    expect((await f.core.commands.getTask(task.id))?.state).toBe("dev");

    const reviewed = await reviewedTask(f);
    f.pullRequests.squashMergeError = new Error("gh: merge conflict");
    await expect(
      f.core.commands.toAwait(reviewed.task.id, "deploy"),
    ).rejects.toThrow("merge conflict");
    const reloaded = await f.core.commands.getTask(reviewed.task.id);
    expect(reloaded?.awaiting).toEqual({ kind: "review" });
    expect(reloaded?.pr?.state).toBe("open");
  });

  it("refuses to re-enter the pipeline from a deployment wait (it would reset to stage 1)", async () => {
    const f = await fixture();
    const { task } = await reviewedTask(f);
    await f.core.commands.toAwait(task.id, "deploy");
    await expect(f.core.commands.toAwait(task.id, "deploy")).rejects.toThrow(
      "already awaiting deployment",
    );
    await expect(f.core.commands.toAwait(task.id, "review")).rejects.toThrow(
      "already merged",
    );
  });
});

describe.skipIf(!gitAvailable)("CoreManager listAwaitingKinds", () => {
  it("lists the built-in kinds in picker order with review first; no task = all available, no notices", async () => {
    const f = await fixture();
    const kinds = await f.core.commands.listAwaitingKinds();
    expect(kinds.map((kind) => kind.id)).toEqual(["review", "slack", "deploy"]);
    expect(kinds.every((kind) => kind.available && !kind.notice)).toBe(true);
    expect(kinds[1]?.fields).toEqual([
      expect.objectContaining({ id: "permalink", optional: true }),
    ]);
  });

  it("resolves availability and the side-effect notice for a task", async () => {
    const f = await fixture();
    const [repo] = await f.core.commands.listRepositories();
    if (!repo) throw new Error("fixture repo not discovered");
    const scratch = await f.core.commands.createTask({
      title: "Scratch",
      initialPrompt: "",
      start: true,
    });
    const scratchKinds = await f.core.commands.listAwaitingKinds(scratch.id);
    expect(scratchKinds.find((k) => k.id === "review")).toMatchObject({
      available: true,
    });
    expect(scratchKinds.find((k) => k.id === "review")?.notice).toBeUndefined();
    expect(scratchKinds.find((k) => k.id === "deploy")).toMatchObject({
      available: false,
    });

    const task = await f.core.commands.createTask({
      title: "Ship",
      initialPrompt: "",
      repositoryId: repo.id,
      start: true,
    });
    f.pullRequests.ensureOpenResult = pr({ number: 12 });
    await f.core.commands.toAwait(task.id, "review");
    await writeConfig(f, {
      repositories: {
        [repo.id]: {
          deployment: { stages: [{ id: "pre", label: "Preprod deploy" }] },
        },
      },
    });
    const kinds = await f.core.commands.listAwaitingKinds(task.id);
    expect(kinds.find((k) => k.id === "review")?.notice).toContain(
      `Pushes ${task.branch}`,
    );
    expect(kinds.find((k) => k.id === "deploy")).toMatchObject({
      available: true,
      notice:
        "Squash-merges PR #12 and enters the deployment pipeline (first stage: Preprod deploy)",
    });
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
