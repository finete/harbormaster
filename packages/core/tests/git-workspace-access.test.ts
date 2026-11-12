// Integration-style tests against real temp git repos. Ported in spirit
// from pi-home's tests/integration/git-access.test.ts, reshaped around
// Harbormaster's explicit-codeRoot / cwd-driven GitRepositoryAccess and the
// fixed <codeRoot>/.harbormaster-worktrees/ task-worktree layout.

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
import {
  LocalGitRepositoryAccess,
  normalizeRemoteIdentity,
} from "../src/access/git-repository-access.js";
import {
  branchFromHead,
  LocalGitWorktreeAccess,
  TASK_WORKTREES_DIRNAME,
} from "../src/access/git-worktree-access.js";
import {
  execFileRunner,
  type ProcessRunRequest,
  setProcessRunner,
} from "../src/utilities/run.js";

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
      checkouts: [{ root: f.checkout, isPrimary: true }],
    });
  });

  it("groups several checkouts of the same remote (arnac/arnac2/arnac3) into one RepositoryInfo, primary chosen alphabetically", async () => {
    const f = await fixture();
    const second = join(f.code, "harbor-repo2");
    await git(["clone", f.bare, second]);
    await git(
      ["remote", "set-url", "origin", "git@github.com:acme/harbor-repo.git"],
      second,
    );
    const third = join(f.code, "harbor-repo3");
    await git(["clone", f.bare, third]);
    await git(
      ["remote", "set-url", "origin", "git@github.com:acme/harbor-repo.git"],
      third,
    );

    const access = new LocalGitRepositoryAccess();
    const repos = await access.discoverRepositories(f.code);
    expect(repos).toHaveLength(1);
    const repo = repos[0]!;
    expect(repo.id).toBe("github.com/acme/harbor-repo");
    // Alphabetically-first checkout wins by default: "harbor-repo" sorts
    // before "harbor-repo2"/"harbor-repo3".
    expect(repo.root).toBe(f.checkout);
    expect(repo.checkouts).toEqual([
      { root: f.checkout, isPrimary: true },
      { root: second, isPrimary: false },
      { root: third, isPrimary: false },
    ]);
  });

  it("folds a linked git-worktree checkout into its parent's group, and never selects it as primary", async () => {
    const f = await fixture();
    const linked = join(f.code, "harbor-repo-wt");
    await git(["branch", "side"], f.checkout);
    await git(["worktree", "add", linked, "side"], f.checkout);

    const access = new LocalGitRepositoryAccess();
    const repos = await access.discoverRepositories(f.code);
    expect(repos).toHaveLength(1);
    const repo = repos[0]!;
    expect(repo.root).toBe(f.checkout);
    expect(repo.checkouts).toEqual([
      { root: f.checkout, isPrimary: true },
      { root: linked, isPrimary: false },
    ]);
  });

  it("honors a valid preferredCheckout override, and falls back to the heuristic when it is invalid/missing", async () => {
    const f = await fixture();
    const second = join(f.code, "harbor-repo2");
    await git(["clone", f.bare, second]);
    await git(
      ["remote", "set-url", "origin", "git@github.com:acme/harbor-repo.git"],
      second,
    );

    const access = new LocalGitRepositoryAccess();
    const preferred = await access.discoverRepositories(f.code, {
      "github.com/acme/harbor-repo": second,
    });
    expect(preferred[0]?.root).toBe(second);
    expect(
      preferred[0]?.checkouts.find((c) => c.root === second)?.isPrimary,
    ).toBe(true);
    expect(
      preferred[0]?.checkouts.find((c) => c.root === f.checkout)?.isPrimary,
    ).toBe(false);

    // An invalid override (unknown path) is ignored; heuristic wins instead.
    const invalid = await access.discoverRepositories(f.code, {
      "github.com/acme/harbor-repo": "/not/a/real/checkout",
    });
    expect(invalid[0]?.root).toBe(f.checkout);

    // No override at all: same heuristic result.
    const none = await access.discoverRepositories(f.code);
    expect(none[0]?.root).toBe(f.checkout);
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

describe("branchFromHead", () => {
  it("parses symbolic, detached and unrecognized HEAD contents", () => {
    expect(branchFromHead("ref: refs/heads/moshe/feat-x\n")).toBe(
      "moshe/feat-x",
    );
    expect(branchFromHead(`${"a1".repeat(20)}\n`)).toBeUndefined();
    expect(branchFromHead("ref: refs/heads/.invalid\n")).toBe("unknown");
    expect(branchFromHead("ref: refs/remotes/origin/main")).toBe("unknown");
    expect(branchFromHead("")).toBe("unknown");
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
  it("currentBranch reads HEAD without spawning git: primary checkout, linked worktree, detached", async () => {
    const f = await fixture();
    const linked = join(f.root, "linked");
    await git(["worktree", "add", "-b", "task/linked", linked], f.checkout);
    const detached = join(f.root, "detached");
    await git(["worktree", "add", "--detach", detached], f.checkout);

    const spawned: ProcessRunRequest[] = [];
    setProcessRunner((request) => {
      spawned.push(request);
      return execFileRunner(request);
    });
    try {
      const worktrees = new LocalGitWorktreeAccess();
      expect(await worktrees.currentBranch(f.checkout)).toBe("main");
      expect(await worktrees.currentBranch(linked)).toBe("task/linked");
      expect(await worktrees.currentBranch(detached)).toBeUndefined();
      expect(spawned).toEqual([]);
      // A path with no readable HEAD still answers, through git.
      expect(await worktrees.currentBranch(join(linked, "README.md"))).toBe(
        undefined,
      );
      expect(spawned.map((r) => r.args.join(" "))).toEqual([
        "branch --show-current",
      ]);
    } finally {
      setProcessRunner(undefined);
    }
  });

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

  it("counts uncommitted changes; a missing folder is already removed (metadata pruned); an orphan folder surfaces 'not a git repository' and can be deleted", async () => {
    const f = await fixture();
    const repoAccess = new LocalGitRepositoryAccess();
    const repo = await repoAccess.resolveRepository(f.checkout);
    const worktrees = new LocalGitWorktreeAccess();

    const gone = await worktrees.createTaskWorktree(repo, "task/gone", "main");
    await writeFile(join(gone.path, "a.txt"), "a\n");
    await writeFile(join(gone.path, "b.txt"), "b\n");
    expect(await worktrees.uncommittedChangeCount(gone.path)).toBe(2);
    // Folder deleted out-of-band: metadata without a folder.
    await rm(gone.path, { recursive: true, force: true });
    await worktrees.removeWorktree(repo, gone.path, false);
    expect(
      (await worktrees.listWorktrees(repo)).map((w) => w.path),
    ).not.toContain(gone.path);

    const orphan = await worktrees.createTaskWorktree(
      repo,
      "task/orphan",
      "main",
    );
    // Metadata deleted: the folder's .git file points nowhere.
    await rm(join(f.checkout, ".git", "worktrees", "task-orphan"), {
      recursive: true,
      force: true,
    });
    await expect(
      worktrees.removeWorktree(repo, orphan.path, true),
    ).rejects.toThrow(/not a git repository/);
    await worktrees.deleteWorktreeDir(orphan.path);
    await worktrees.pruneWorktrees(repo);
    await expect(
      readFile(join(orphan.path, "README.md"), "utf8"),
    ).rejects.toThrow();

    // Never a full repository.
    await expect(worktrees.deleteWorktreeDir(f.checkout)).rejects.toThrow(
      /git repository/,
    );
    expect(await readFile(join(f.checkout, "README.md"), "utf8")).toBe(
      "fixture\n",
    );
  });
});

describe.skipIf(!gitAvailable)(
  "LocalGitRepositoryAccess.cloneRepository",
  () => {
    it("clones a cloneUrl into <codeRoot>/<repo-name> and resolves its RepositoryInfo", async () => {
      const f = await fixture();
      const access = new LocalGitRepositoryAccess();
      const repo = await access.cloneRepository(f.code, f.bare);
      expect(repo.root).toBe(join(f.code, "upstream"));
      expect(repo.defaultBranch).toBe("main");
    });

    it("reuses an existing clone whose origin matches the requested URL", async () => {
      const f = await fixture();
      const access = new LocalGitRepositoryAccess();
      const first = await access.cloneRepository(f.code, f.bare);
      const second = await access.cloneRepository(f.code, f.bare);
      expect(second.root).toBe(first.root);
    });

    it("rejects when the target directory already exists with a different origin", async () => {
      const f = await fixture();
      const access = new LocalGitRepositoryAccess();
      // Pre-create <codeRoot>/upstream as a checkout of a *different* remote.
      const otherBare = join(f.root, "other.git");
      await git(["init", "--bare", "-b", "main", otherBare]);
      await git(["clone", otherBare, join(f.code, "upstream")]);

      await expect(access.cloneRepository(f.code, f.bare)).rejects.toThrow(
        /different origin/,
      );
    });

    it("rejects when the target directory exists and isn't a git checkout", async () => {
      const f = await fixture();
      const access = new LocalGitRepositoryAccess();
      await mkdir(join(f.code, "upstream"));
      await writeFile(join(f.code, "upstream", "file.txt"), "not git\n");

      await expect(access.cloneRepository(f.code, f.bare)).rejects.toThrow(
        /not a Git checkout/,
      );
    });
  },
);
