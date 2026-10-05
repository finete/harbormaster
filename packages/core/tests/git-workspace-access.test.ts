// Integration-style tests against real temp git repos. Ported in spirit
// from pi-home's tests/integration/git-access.test.ts, reshaped around
// Harbormaster's explicit-codeRoot / cwd-driven GitRepositoryAccess and the
// fixed <codeRoot>/.harbormaster-worktrees/ task-worktree layout.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  LocalGitRepositoryAccess,
  normalizeRemoteIdentity,
} from "../src/access/git-repository-access.js";
import {
  LocalGitWorktreeAccess,
  TASK_WORKTREES_DIRNAME,
} from "../src/access/git-worktree-access.js";

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

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** A code root containing one seeded repository checkout with a fake remote. */
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harbormaster-git-fixture-")),
  );
  roots.push(root);
  const code = join(root, "Code");
  await mkdir(code);

  const bare = join(root, "upstream.git");
  await git(["init", "--bare", "-b", "main", bare]);

  const checkout = join(code, "harbor-repo");
  await git(["clone", bare, checkout]);
  await writeFile(join(checkout, "README.md"), "fixture\n");
  await git(["add", "."], checkout);
  await gitCommit(checkout, "initial commit");
  await git(["push", "origin", "main"], checkout);
  // Fake remote URL in the ssh shorthand form pi-home normalized, so identity
  // normalization has something non-trivial to prove.
  await git(
    ["remote", "set-url", "origin", "git@github.com:acme/harbor-repo.git"],
    checkout,
  );

  return { root, code, checkout, bare };
}

describe.skipIf(!gitAvailable)("LocalGitRepositoryAccess", () => {
  it("discovers repository checkouts under a code root and normalizes remote identity", async () => {
    const f = await fixture();
    const access = new LocalGitRepositoryAccess();
    const repos = await access.discoverRepositories(f.code);
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      id: "github.com/acme/harbor-repo",
      root: f.checkout,
      defaultBranch: "main",
      remoteUrl: "git@github.com:acme/harbor-repo.git",
    });
  });

  it("returns an empty list for a code root with no checkouts, and skips dotfiles", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "harbormaster-git-empty-")),
    );
    roots.push(root);
    await mkdir(join(root, ".hidden"));
    const access = new LocalGitRepositoryAccess();
    expect(await access.discoverRepositories(root)).toEqual([]);
    expect(
      await access.discoverRepositories(join(root, "does-not-exist")),
    ).toEqual([]);
  });

  it("resolves the repository that owns a cwd, including nested subdirectories", async () => {
    const f = await fixture();
    const access = new LocalGitRepositoryAccess();
    await mkdir(join(f.checkout, "nested", "dir"), { recursive: true });
    const resolved = await access.resolveRepository(
      join(f.checkout, "nested", "dir"),
    );
    expect(resolved.id).toBe("github.com/acme/harbor-repo");
    expect(resolved.root).toBe(f.checkout);
  });

  it("rejects a cwd outside any Git repository", async () => {
    const outside = await realpath(
      await mkdtemp(join(tmpdir(), "harbormaster-git-outside-")),
    );
    roots.push(outside);
    const access = new LocalGitRepositoryAccess();
    await expect(access.resolveRepository(outside)).rejects.toThrow(
      "Not inside a Git repository",
    );
  });

  it("falls back to the repository root as identity when there is no remote", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "harbormaster-git-noremote-")),
    );
    roots.push(root);
    const checkout = join(root, "solo");
    await git(["init", "-b", "main", checkout]);
    await writeFile(join(checkout, "README.md"), "solo\n");
    await git(["add", "."], checkout);
    await gitCommit(checkout, "solo commit");
    const access = new LocalGitRepositoryAccess();
    const resolved = await access.resolveRepository(checkout);
    expect(resolved.remoteUrl).toBeUndefined();
    expect(resolved.id).toBe(checkout);
  });
});

describe("normalizeRemoteIdentity", () => {
  it("normalizes ssh, https, and authenticated https remotes to the same identity", () => {
    expect(normalizeRemoteIdentity("git@github.com:acme/harbor-repo.git")).toBe(
      "github.com/acme/harbor-repo",
    );
    expect(
      normalizeRemoteIdentity("https://github.com/acme/harbor-repo.git"),
    ).toBe("github.com/acme/harbor-repo");
    expect(
      normalizeRemoteIdentity("https://finete@github.com/acme/harbor-repo"),
    ).toBe("github.com/acme/harbor-repo");
    expect(
      normalizeRemoteIdentity("https://github.com/ACME/Harbor-Repo/"),
    ).toBe("github.com/acme/harbor-repo");
  });
});

describe.skipIf(!gitAvailable)("LocalGitWorktreeAccess", () => {
  it("creates a task worktree under <codeRoot>/.harbormaster-worktrees/ and lists it", async () => {
    const f = await fixture();
    const repoAccess = new LocalGitRepositoryAccess();
    const repo = await repoAccess.resolveRepository(f.checkout);
    const worktrees = new LocalGitWorktreeAccess();

    const info = await worktrees.createTaskWorktree(
      repo,
      "task/add-widget",
      repo.defaultBranch,
    );
    expect(info.branch).toBe("task/add-widget");
    expect(info.detached).toBe(false);
    expect(info.path).toBe(
      join(f.code, TASK_WORKTREES_DIRNAME, "task-add-widget"),
    );

    const listed = await worktrees.listWorktrees(repo);
    expect(listed.map((w) => w.path)).toContain(info.path);
    expect(listed.find((w) => w.path === info.path)?.branch).toBe(
      "task/add-widget",
    );
  });

  it("refuses to remove a dirty worktree unless forced", async () => {
    const f = await fixture();
    const repoAccess = new LocalGitRepositoryAccess();
    const repo = await repoAccess.resolveRepository(f.checkout);
    const worktrees = new LocalGitWorktreeAccess();
    const info = await worktrees.createTaskWorktree(
      repo,
      "task/dirty",
      repo.defaultBranch,
    );

    await writeFile(join(info.path, "scratch.txt"), "uncommitted\n");
    await expect(worktrees.removeWorktree(repo, info.path)).rejects.toThrow(
      "Refusing to remove dirty worktree",
    );

    await worktrees.removeWorktree(repo, info.path, true);
    const listed = await worktrees.listWorktrees(repo);
    expect(listed.map((w) => w.path)).not.toContain(info.path);
  });

  it("removes a clean worktree without forcing", async () => {
    const f = await fixture();
    const repoAccess = new LocalGitRepositoryAccess();
    const repo = await repoAccess.resolveRepository(f.checkout);
    const worktrees = new LocalGitWorktreeAccess();
    const info = await worktrees.createTaskWorktree(
      repo,
      "task/clean",
      repo.defaultBranch,
    );

    await worktrees.removeWorktree(repo, info.path);
    const listed = await worktrees.listWorktrees(repo);
    expect(listed.map((w) => w.path)).not.toContain(info.path);
  });

  it("branchExists reflects reality before and after safe branch deletion", async () => {
    const f = await fixture();
    const repoAccess = new LocalGitRepositoryAccess();
    const repo = await repoAccess.resolveRepository(f.checkout);
    const worktrees = new LocalGitWorktreeAccess();

    expect(await worktrees.branchExists(repo, "task/branch-lifecycle")).toBe(
      false,
    );
    const info = await worktrees.createTaskWorktree(
      repo,
      "task/branch-lifecycle",
      repo.defaultBranch,
    );
    expect(await worktrees.branchExists(repo, "task/branch-lifecycle")).toBe(
      true,
    );

    // A merged branch (no new commits past its base) deletes safely.
    await worktrees.removeWorktree(repo, info.path);
    await worktrees.deleteBranch(repo, "task/branch-lifecycle");
    expect(await worktrees.branchExists(repo, "task/branch-lifecycle")).toBe(
      false,
    );

    // Deleting an already-gone branch is a no-op, not an error.
    await expect(
      worktrees.deleteBranch(repo, "task/branch-lifecycle"),
    ).resolves.toBeUndefined();
  });

  it("refuses a safe delete of an unmerged branch, but allows a forced delete", async () => {
    const f = await fixture();
    const repoAccess = new LocalGitRepositoryAccess();
    const repo = await repoAccess.resolveRepository(f.checkout);
    const worktrees = new LocalGitWorktreeAccess();

    const info = await worktrees.createTaskWorktree(
      repo,
      "task/unmerged",
      repo.defaultBranch,
    );
    await writeFile(join(info.path, "feature.txt"), "wip\n");
    await git(["add", "."], info.path);
    await gitCommit(info.path, "unmerged work");
    await worktrees.removeWorktree(repo, info.path, true);

    await expect(
      worktrees.deleteBranch(repo, "task/unmerged"),
    ).rejects.toThrow();
    expect(await worktrees.branchExists(repo, "task/unmerged")).toBe(true);

    await worktrees.deleteBranch(repo, "task/unmerged", true);
    expect(await worktrees.branchExists(repo, "task/unmerged")).toBe(false);
  });
});
