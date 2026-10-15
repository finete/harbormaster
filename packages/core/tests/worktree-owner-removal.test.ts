import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LocalGitRepositoryAccess } from "../src/access/git-repository-access.js";
import { LocalGitWorktreeAccess } from "../src/access/git-worktree-access.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

describe("removeWorktree resolves the owning checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "hm-owner-removal-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("removes a worktree registered to a secondary checkout when called with the primary", async () => {
    // primary + secondary clones of one repo; worktree created by the SECONDARY.
    const bare = join(root, "origin.git");
    execFileSync("git", ["init", "--bare", bare], { stdio: "pipe" });
    const primary = join(root, "repo");
    const secondary = join(root, "repo2");
    execFileSync("git", ["clone", bare, primary], { stdio: "pipe" });
    git(primary, "config", "user.email", "t@t");
    git(primary, "config", "user.name", "t");
    git(primary, "commit", "--allow-empty", "-m", "init");
    git(primary, "push", "origin", "HEAD:main");
    execFileSync("git", ["clone", bare, secondary], { stdio: "pipe" });

    const worktreePath = join(root, "wt-from-secondary");
    git(secondary, "worktree", "add", "-b", "task/x", worktreePath);
    expect(existsSync(worktreePath)).toBe(true);

    const repos = await new LocalGitRepositoryAccess().discoverRepositories(
      root,
    );
    const repo = repos.find((r) => r.root === primary) ?? repos[0];
    if (!repo) throw new Error("fixture repo not discovered");
    // Force the primary root to simulate the migrated-task case.
    const primaryRepo = { ...repo, root: primary };

    await new LocalGitWorktreeAccess().removeWorktree(
      primaryRepo,
      worktreePath,
      true,
    );
    expect(existsSync(worktreePath)).toBe(false);
  });
});
