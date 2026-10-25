// refresh() makes a live task follow its worktree's current branch: an agent
// that runs `git checkout -b other` in the worktree gets its PR found under
// `other`. Real temp git repo + worktree, fake PullRequestAccess.

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

class RecordingPullRequests implements PullRequestAccess {
  heads: string[] = [];
  async status(_repositoryId: string, head: string) {
    this.heads.push(head);
    return undefined;
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

async function fixture(pullRequests: PullRequestAccess, targetBranch?: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harbormaster-branch-follow-")),
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
  if (targetBranch) await git(["branch", targetBranch, "main"], checkout);
  // Pin codeRoot to the temp dir: without it discovery scans the real ~/Code.
  await writeFile(
    join(stateDir, "config.json"),
    JSON.stringify({ codeRoot, branchPrefix: "" }),
  );
  const core = createCore({
    stateDir,
    pullRequests,
    versions: new NoVersions(),
  });
  const [repo] = await core.commands.listRepositories();
  if (!repo) throw new Error("fixture repo not discovered");
  const task = await core.commands.createTask({
    title: "Observed",
    initialPrompt: "do it",
    repositoryId: repo.id,
    ...(targetBranch ? { targetBranch } : {}),
    start: true,
  });
  const binding = await core.commands.getTaskWorkspace(task.id);
  if (!binding?.worktreePath) throw new Error("no worktree");
  return { core, task, worktree: binding.worktreePath };
}

describe("refresh() follows the worktree's current branch", () => {
  it("adopts a branch the agent checked out and looks the PR up under it", async () => {
    const prs = new RecordingPullRequests();
    const { core, task, worktree } = await fixture(prs);
    await git(["checkout", "-q", "-b", "other"], worktree);

    await core.commands.refresh();

    expect((await core.commands.getTask(task.id))?.branch).toBe("other");
    expect((await core.commands.getTaskWorkspace(task.id))?.branch).toBe(
      "other",
    );
    expect(prs.heads).toEqual(["other"]);
  });

  it("does not adopt the target branch an agent is temporarily on", async () => {
    const prs = new RecordingPullRequests();
    const { core, task, worktree } = await fixture(prs, "release");
    await git(["checkout", "-q", "release"], worktree);

    await core.commands.refresh();

    expect((await core.commands.getTask(task.id))?.branch).toBe(task.branch);
    expect(prs.heads).toEqual([task.branch]);
  });
});
