// refresh() observes every live task's PR with one batched lookup per
// repository (`PullRequestAccess.statusMany`) instead of one `status` call
// (one `gh` spawn) per task, and a failed batch is reported exactly like a
// failed per-task lookup. Real temp git repos with a fake PullRequestAccess.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CommitLogEntry,
  PullRequestAccess,
  PullRequestStatus,
  VersionAccess,
} from "../src/contracts/github.js";
import { createCore } from "../src/index.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

class BatchingPullRequests implements PullRequestAccess {
  statusCalls: string[] = [];
  batchCalls: Array<{ repositoryId: string; branches: string[] }> = [];
  constructor(
    private readonly answer: (
      branch: string,
    ) => PullRequestStatus | undefined = () => undefined,
    private readonly batchError?: Error,
  ) {}
  async status(
    _repositoryId: string,
    branch: string,
  ): Promise<PullRequestStatus | undefined> {
    this.statusCalls.push(branch);
    return this.answer(branch);
  }
  async statusMany(
    repositoryId: string,
    branches: readonly string[],
  ): Promise<Map<string, PullRequestStatus | undefined>> {
    this.batchCalls.push({ repositoryId, branches: [...branches] });
    if (this.batchError) throw this.batchError;
    return new Map(branches.map((branch) => [branch, this.answer(branch)]));
  }
  async ensureOpen(): Promise<PullRequestStatus> {
    throw new Error("not used here");
  }
  async squashMerge(): Promise<PullRequestStatus> {
    throw new Error("not used here");
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

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(pullRequests: PullRequestAccess) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harbormaster-refresh-batching-")),
  );
  roots.push(root);
  const stateDir = join(root, "state");
  const codeRoot = join(root, "Code");
  await mkdir(stateDir, { recursive: true });
  await mkdir(codeRoot, { recursive: true });
  const bare = join(root, "upstream.git");
  await git(["init", "-q", "--bare", "-b", "main", bare]);
  const checkout = join(codeRoot, "repo");
  await git(["clone", "-q", bare, checkout]);
  await git(
    [
      "-c",
      "user.name=Harbormaster Test",
      "-c",
      "user.email=harbormaster-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "init",
    ],
    checkout,
  );
  await git(["push", "-q", "origin", "main"], checkout);
  // Pin discovery (and task worktrees) to this temp code root. Without it
  // the default ~/Code applies and createTask checks out a worktree of the
  // developer's first real repository on every run.
  await writeFile(join(stateDir, "config.json"), JSON.stringify({ codeRoot }));

  const core = createCore({
    stateDir,
    pullRequests,
    versions: new NoVersions(),
  });
  const [repo] = await core.commands.listRepositories();
  if (!repo) throw new Error("fixture repo not discovered");
  const tasks = [];
  for (const title of ["First", "Second", "Third"]) {
    tasks.push(
      await core.commands.createTask({
        title,
        initialPrompt: "do it",
        repositoryId: repo.id,
        start: true,
      }),
    );
  }
  return { core, repo, tasks };
}

describe("refresh() batches PR observation per repository", () => {
  it("one statusMany call covers every live task; no per-task status calls", async () => {
    let target = "";
    const pullRequests = new BatchingPullRequests((branch) =>
      branch === target
        ? {
            number: 7,
            url: "https://example.invalid/pull/7",
            state: "OPEN",
            isDraft: false,
            reviewRequested: false,
            reviewSubmitted: false,
            checkedAt: new Date(0).toISOString(),
          }
        : undefined,
    );
    const { core, repo, tasks } = await fixture(pullRequests);
    target = tasks[1]?.branch ?? "";

    const result = await core.commands.refresh();

    expect(result.warnings).toEqual([]);
    expect(pullRequests.statusCalls).toEqual([]);
    expect(pullRequests.batchCalls).toHaveLength(1);
    expect(pullRequests.batchCalls[0]?.repositoryId).toBe(repo.id);
    expect([...(pullRequests.batchCalls[0]?.branches ?? [])].sort()).toEqual(
      tasks.map((task) => task.branch).sort(),
    );
    expect((await core.commands.getTask(tasks[1]?.id ?? ""))?.pr).toMatchObject(
      { number: 7 },
    );
    expect(
      (await core.commands.getTask(tasks[0]?.id ?? ""))?.pr,
    ).toBeUndefined();
  });

  it("a failed batch is reported per task, like failed per-task lookups", async () => {
    const pullRequests = new BatchingPullRequests(
      () => undefined,
      new Error("HTTP 401: Bad credentials"),
    );
    const { core, tasks } = await fixture(pullRequests);

    const result = await core.commands.refresh();

    expect(pullRequests.statusCalls).toEqual([]);
    expect([...result.warnings].sort()).toEqual(
      tasks
        .map((task) => expect.stringContaining(`${task.title}: HTTP 401`))
        .sort(),
    );

    const offline = new BatchingPullRequests(
      () => undefined,
      new Error("error connecting to api.github.com check your internet"),
    );
    const second = await fixture(offline);
    const offlineResult = await second.core.commands.refresh();
    expect(offlineResult.warnings).toEqual([]);
    expect(offlineResult.connectivity).toEqual({
      offline: true,
      failedChecks: 3,
    });
  });
});
