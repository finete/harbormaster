// refresh()'s connectivity split (see engines/connectivity.ts): a gh call
// that fails with a network-shaped message must never become a per-task
// warning (today's "gh laptop went to sleep" wall of toasts), while a real
// gh/API failure (auth, not found) behaves exactly as before. Real temp git
// repos (createCore's real git access) with a fake, gate-able
// PullRequestAccess: never a real gh/network call.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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

/** Fake gh whose `status()` always rejects with a configurable error. */
class FailingPullRequests implements PullRequestAccess {
  constructor(private readonly error: Error) {}
  async status(): Promise<PullRequestStatus | undefined> {
    throw this.error;
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
    await mkdtemp(join(tmpdir(), "harbormaster-refresh-connectivity-")),
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
    start: true,
  });
  return { core, task };
}

describe("refresh() connectivity split", () => {
  it("rolls a network-shaped gh failure into connectivity, never a per-task warning", async () => {
    const { core } = await fixture(
      new FailingPullRequests(
        new Error("error connecting to api.github.com check your internet"),
      ),
    );

    const result = await core.commands.refresh();

    expect(result.warnings).toEqual([]);
    expect(result.connectivity).toEqual({ offline: true, failedChecks: 1 });
  });

  it("keeps a real gh/API failure as a per-task warning, with no connectivity marker", async () => {
    const { core, task } = await fixture(
      new FailingPullRequests(new Error("HTTP 401: Bad credentials")),
    );

    const result = await core.commands.refresh();

    expect(result.warnings).toEqual([
      expect.stringContaining(`${task.title}: HTTP 401: Bad credentials`),
    ]);
    expect(result.connectivity).toBeUndefined();
  });
});
