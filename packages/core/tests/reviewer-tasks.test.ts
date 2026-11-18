// Reviewer tasks (docs/release-plan.md "Reviewer tasks"): a task bound to
// someone else's PR checks out the PR head (`pull/<n>/head`), never pushes
// or opens/merges a PR, waits on the `author-response` kind, and the
// default reviewer rules move it (author activity → Working, PR closed → Done).
// Real temp git repos; a fake PullRequestAccess, never a real gh.

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
} from "../src/contracts/github.js";
import { createCore } from "../src/index.js";
import { captureLogger } from "./fixtures/capture-logger.js";

const run = promisify(execFile);
const git = async (args: string[], cwd?: string) =>
  (await run("git", args, { cwd })).stdout.trim();
const commit = (cwd: string, message: string) =>
  git(
    [
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      message,
    ],
    cwd,
  );

class FakePullRequests implements PullRequestAccess {
  pr: PullRequestStatus;
  pushes = 0;
  constructor(head: string) {
    this.pr = {
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      state: "OPEN",
      isDraft: false,
      reviewRequested: true,
      reviewSubmitted: false,
      headRefOid: head,
      headRefName: "bob/feature",
      viewerIsAuthor: false,
      lastAuthorActivityAt: "2026-01-01T00:00:00Z",
      closed: false,
      checkedAt: "2026-01-01T00:00:00Z",
    };
  }
  async view(_repositoryId: string, number: number) {
    if (number !== 7) throw new Error("no such PR");
    return this.pr;
  }
  async status(_repositoryId: string, branch: string) {
    return branch === "bob/feature" ? this.pr : undefined;
  }
  async ensureOpen(): Promise<PullRequestStatus> {
    this.pushes += 1;
    throw new Error("must never be called for a reviewer task");
  }
  async squashMerge(): Promise<PullRequestStatus> {
    throw new Error("must never be called for a reviewer task");
  }
  async containsCommit() {
    return false;
  }
  async commitLog(): Promise<CommitLogEntry[]> {
    return [];
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hm-reviewer-")));
  roots.push(root);
  const stateDir = join(root, "state");
  const codeRoot = join(root, "Code");
  await mkdir(stateDir, { recursive: true });
  await mkdir(codeRoot, { recursive: true });
  const bare = join(root, "upstream.git");
  await git(["init", "-q", "--bare", "-b", "main", bare]);
  const checkout = join(codeRoot, "widgets");
  await git(["clone", "-q", bare, checkout]);
  await commit(checkout, "init");
  await git(["push", "-q", "origin", "main"], checkout);
  // Someone else's PR: only GitHub's pull/7/head ref exists upstream.
  await git(["checkout", "-q", "-b", "scratch"], checkout);
  await commit(checkout, "bob's change");
  const head = await git(["rev-parse", "HEAD"], checkout);
  await git(["push", "-q", "origin", "HEAD:refs/pull/7/head"], checkout);
  await git(["checkout", "-q", "main"], checkout);
  await git(["branch", "-q", "-D", "scratch"], checkout);
  await writeFile(
    join(stateDir, "config.json"),
    JSON.stringify({ automation: true, codeRoot, branchPrefix: "" }),
  );
  const pullRequests = new FakePullRequests(head);
  let n = 0;
  const logger = captureLogger();
  const core = createCore({
    stateDir,
    ids: { next: () => `id-${++n}` },
    pullRequests,
    versions: { fetchText: async () => "" },
    logger,
  });
  const [repo] = await core.commands.listRepositories();
  if (!repo) throw new Error("fixture repo not discovered");
  return { core, repo, head, checkout, pullRequests, logger };
}

describe("reviewer tasks", () => {
  it("check out the PR head, never push/open/merge, await the author, and follow the reviewer rules", async () => {
    const f = await fixture();
    const task = await f.core.commands.createTask({
      title: "Review bob's change",
      initialPrompt: "",
      repositoryId: f.repo.id,
      pullRequest: 7,
      start: true,
    });
    // Role defaults from GitHub: the viewer did not author it.
    expect(task.pr).toMatchObject({ number: 7, role: "reviewer" });
    expect(task.branch).toBe("bob/feature");
    const worktree = (await f.core.commands.getTaskWorkspace(task.id))
      ?.worktreePath as string;
    expect(await git(["rev-parse", "HEAD"], worktree)).toBe(f.head);
    // Detached at the PR's head: the branch itself is never taken (an
    // author's worktree may hold it) nor created locally.
    expect(await git(["branch", "--show-current"], worktree)).toBe("");
    expect(await git(["branch", "--list", "bob/feature"], f.checkout)).toBe("");
    expect((await f.core.commands.getTaskWorkspace(task.id))?.detached).toBe(
      true,
    );

    const kinds = await f.core.commands.listAwaitingKinds(task.id);
    const byId = Object.fromEntries(kinds.map((kind) => [kind.id, kind]));
    expect(byId.review?.available).toBe(false);
    expect(byId.deploy?.available).toBe(false);
    expect(byId["author-response"]?.available).toBe(true);
    await expect(f.core.commands.toAwait(task.id, "review")).rejects.toThrow(
      /Cannot await review/,
    );
    expect(f.pullRequests.pushes).toBe(0);

    await f.core.commands.refresh();
    await f.core.commands.toAwait(task.id, "author-response");
    await f.core.commands.refresh();
    expect((await f.core.commands.getTask(task.id))?.awaiting).toEqual({
      kind: "author-response",
    });

    // The author pushes: back to Working for another look.
    f.pullRequests.pr = {
      ...f.pullRequests.pr,
      lastAuthorActivityAt: "2026-01-02T00:00:00Z",
    };
    await f.core.commands.refresh();
    expect((await f.core.commands.getTask(task.id))?.state).toBe("working");

    // The PR is closed: the review is over (auto-landing, never forced).
    f.pullRequests.pr = { ...f.pullRequests.pr, state: "CLOSED", closed: true };
    const { warnings } = await f.core.commands.refresh();
    expect(warnings).toEqual([]);
    expect((await f.core.commands.getTask(task.id))?.state).toBe("done");
    const events = await f.core.commands.listEvents({ taskId: task.id });
    expect(
      events
        .filter((entry) => entry.kind === "action")
        .map((entry) => entry.kind === "action" && entry.ruleId),
    ).toEqual(["reviewer-author-activity", "reviewer-pr-closed"]);

    // The operation log: PR-head checkout, every refresh with its task
    // count, and the rule-driven Done's cleanup, each timed.
    expect(f.logger.find("worktree.checkout-pr ok")[0]?.fields).toMatchObject({
      repositoryId: f.repo.id,
      branch: "bob/feature",
      worktreePath: worktree,
    });
    expect(
      f.logger.find("task.provision-worktree ok")[0]?.fields,
    ).toMatchObject({ taskId: task.id, branch: "bob/feature" });
    const refreshes = f.logger.find("refresh ok");
    expect(refreshes).toHaveLength(4);
    expect(refreshes[0]?.fields).toMatchObject({ count: 1, warnings: 0 });
    expect(f.logger.find("done.cleanup ok")[0]?.fields).toMatchObject({
      taskId: task.id,
      outcome: "ok",
      ms: expect.any(Number),
    });
    expect(f.logger.find("worktree.remove ok")[0]?.fields.worktreePath).toBe(
      worktree,
    );
  });

  it("a reviewer checks the PR out even while the author's worktree holds its branch, and Done never deletes that branch", async () => {
    const f = await fixture();
    // The author's own task: the PR branch checked out in its worktree,
    // and behind the PR (the PR moved on since).
    await git(["branch", "-q", "bob/feature", "main"], f.checkout);
    const authorTree = join(f.checkout, "..", "author-tree");
    await git(["worktree", "add", "-q", authorTree, "bob/feature"], f.checkout);
    const local = await git(["rev-parse", "bob/feature"], f.checkout);

    const task = await f.core.commands.createTask({
      title: "Review bob's change",
      initialPrompt: "",
      repositoryId: f.repo.id,
      pullRequest: 7,
      start: true,
    });
    const worktree = (await f.core.commands.getTaskWorkspace(task.id))
      ?.worktreePath as string;
    expect(worktree).not.toBe(authorTree);
    // The PR as GitHub has it, not the stale local branch.
    expect(await git(["rev-parse", "HEAD"], worktree)).toBe(f.head);
    expect(local).not.toBe(f.head);

    await f.core.commands.refresh();
    await f.core.commands.toAwait(task.id, "author-response");
    f.pullRequests.pr = { ...f.pullRequests.pr, state: "CLOSED", closed: true };
    await f.core.commands.refresh();
    expect((await f.core.commands.getTask(task.id))?.state).toBe("done");
    // The author's branch and worktree are untouched.
    expect(await git(["rev-parse", "bob/feature"], f.checkout)).toBe(local);
    expect(await git(["branch", "--show-current"], authorTree)).toBe(
      "bob/feature",
    );
  });

  it("an explicit author role on an existing local branch checks it out as-is and keeps the branch on rollback paths", async () => {
    const f = await fixture();
    await git(["branch", "-q", "bob/feature", "main"], f.checkout);
    const local = await git(["rev-parse", "bob/feature"], f.checkout);
    const task = await f.core.commands.createTask({
      title: "Continue my PR",
      initialPrompt: "",
      repositoryId: f.repo.id,
      pullRequest: 7,
      role: "author",
      start: true,
    });
    expect(task.pr?.role).toBe("author");
    const worktree = (await f.core.commands.getTaskWorkspace(task.id))
      ?.worktreePath as string;
    // Never reset to the PR head: local commits win.
    expect(await git(["rev-parse", "HEAD"], worktree)).toBe(local);
  });

  it("parks a PR-bound task in Backlog and checks the head out on start", async () => {
    const f = await fixture();
    const parked = await f.core.commands.createTask({
      title: "Later review",
      initialPrompt: "",
      repositoryId: f.repo.id,
      pullRequest: 7,
      role: "reviewer",
    });
    expect(parked.state).toBe("backlog");
    expect(parked.branch).toBe("bob/feature");
    const started = await f.core.commands.startTask(parked.id);
    const worktree = (await f.core.commands.getTaskWorkspace(started.id))
      ?.worktreePath as string;
    expect(await git(["rev-parse", "HEAD"], worktree)).toBe(f.head);
  });

  it("launchTask binds a review to the PR head, queued, with a no-push kickoff; chat runs in place; PR launches reject in-place/base options", async () => {
    const f = await fixture();
    const parent = await f.core.commands.createTask({
      title: "Parent",
      initialPrompt: "",
      repositoryId: f.repo.id,
      start: true,
    });
    const review = await f.core.commands.launchTask({
      relation: "child",
      fromTaskId: parent.id,
      title: "Review bob's change",
      prompt: "Review it.",
      repository: { repositoryId: f.repo.id },
      pullRequest: 7,
    });
    expect(review.parentTaskId).toBe(parent.id);
    expect(review.launch?.status).toBe("queued");
    expect(review.branch).toBe("bob/feature");
    expect(review.pr).toMatchObject({ number: 7, role: "reviewer" });
    expect(review.initialPrompt).toContain("never commit, push, or open");
    expect(review.initialPrompt).not.toContain("gh pr create");
    const worktree = (await f.core.commands.getTaskWorkspace(review.id))
      ?.worktreePath as string;
    expect(await git(["rev-parse", "HEAD"], worktree)).toBe(f.head);

    const chat = await f.core.commands.launchTask({
      relation: "standalone",
      title: "Ask about widgets",
      prompt: "How does it work?",
      repository: { repositoryId: f.repo.id },
      inPlace: true,
    });
    expect(chat.repositoryId).toBeUndefined();
    expect(chat.folderPath).toBe(f.checkout);
    expect(chat.initialPrompt).toContain("directly in the user's folder");
    expect(
      (await f.core.commands.getTaskWorkspace(chat.id))?.worktreePath,
    ).toBe(f.checkout);

    const base = {
      relation: "standalone" as const,
      title: "Bad",
      prompt: "x",
      repository: { repositoryId: f.repo.id },
      pullRequest: 7,
    };
    await expect(
      f.core.commands.launchTask({ ...base, inPlace: true }),
    ).rejects.toThrow(/cannot run in place/);
    await expect(
      f.core.commands.launchTask({ ...base, baseRef: "main" }),
    ).rejects.toThrow(/baseBranch\/baseRef do not apply/);
    await expect(
      f.core.commands.launchTask({
        ...base,
        repository: { none: true },
      }),
    ).rejects.toThrow(/needs a repository/);
  });

  it("previewPullRequest: a pasted PR URL resolves to its card facts; bad URLs and unknown repositories reject readably", async () => {
    const f = await fixture();
    // A GitHub-hosted origin, so the PR URL maps onto the local checkout.
    await git(
      ["remote", "set-url", "origin", "https://github.com/acme/widgets.git"],
      f.checkout,
    );
    f.pullRequests.pr = {
      ...f.pullRequests.pr,
      title: "Bob's change",
      author: "bob",
      baseRefName: "release",
    };
    await expect(
      f.core.commands.previewPullRequest(
        "https://github.com/acme/widgets/pull/7",
      ),
    ).resolves.toEqual({
      repositoryId: "github.com/acme/widgets",
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      state: "OPEN",
      title: "Bob's change",
      author: "bob",
      headRefName: "bob/feature",
      baseRefName: "release",
      viewerIsAuthor: false,
    });
    await expect(
      f.core.commands.previewPullRequest("https://github.com/acme/widgets"),
    ).rejects.toThrow(/Not a pull request URL/);
    await expect(
      f.core.commands.previewPullRequest(
        "https://github.com/acme/other/pull/7",
      ),
    ).rejects.toThrow(/No local checkout of github.com\/acme\/other/);
  });
});
