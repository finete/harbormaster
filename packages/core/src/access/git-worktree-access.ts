// Resource Access: Git worktree lifecycle for task execution. Ported from
// pi-home's src/access/git-worktree-access.ts, reshaped around a single
// atomic verb for task creation (createTaskWorktree) that owns the
// <codeRoot>/.harbormaster-worktrees/ layout instead of taking a caller-
// supplied path, and with explicit dirty-refusal / safe-branch-delete
// semantics called out as separate, testable verbs.

import { access as fsAccess, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  GitWorktreeAccess,
  RepositoryInfo,
  WorktreeInfo,
} from "../contracts/workspace.js";
import { run, tryRun } from "../utilities/run.js";

/** Directory (sibling of every repository checkout) that holds task worktrees. */
export const TASK_WORKTREES_DIRNAME = ".harbormaster-worktrees";

/** `git`-shelling-out implementation of {@link GitWorktreeAccess}. */
export class LocalGitWorktreeAccess implements GitWorktreeAccess {
  async listWorktrees(repo: RepositoryInfo): Promise<WorktreeInfo[]> {
    const raw = await run(
      "git",
      ["worktree", "list", "--porcelain"],
      repo.root,
    );
    return parsePorcelain(raw);
  }

  async createTaskWorktree(
    repo: RepositoryInfo,
    branch: string,
    baseRef: string,
  ): Promise<WorktreeInfo> {
    const path = taskWorktreePath(repo, branch);
    await mkdir(dirname(path), { recursive: true });
    await run(
      "git",
      ["worktree", "add", "-b", branch, path, baseRef],
      repo.root,
    );
    return this.inspect(path);
  }

  async removeWorktree(
    repo: RepositoryInfo,
    path: string,
    force = false,
  ): Promise<void> {
    if (!force && (await this.isDirty(path))) {
      throw new Error(
        `Refusing to remove dirty worktree: ${path} (pass force to override)`,
      );
    }
    try {
      await run(
        "git",
        ["worktree", "remove", ...(force ? ["--force"] : []), path],
        repo.root,
      );
    } catch (error) {
      const stillExists = await fsAccess(path).then(
        () => true,
        () => false,
      );
      if (stillExists) throw error;
      // The worktree directory is already gone (e.g. removed out-of-band);
      // prune git's bookkeeping instead of surfacing a stale error.
      await run("git", ["worktree", "prune"], repo.root);
    }
  }

  async branchExists(repo: RepositoryInfo, branch: string): Promise<boolean> {
    const ref = await tryRun(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      repo.root,
    );
    return ref !== undefined;
  }

  async deleteBranch(
    repo: RepositoryInfo,
    branch: string,
    force = false,
  ): Promise<void> {
    if (!(await this.branchExists(repo, branch))) return;
    await run("git", ["branch", force ? "-D" : "-d", branch], repo.root);
  }

  private async inspect(path: string): Promise<WorktreeInfo> {
    const branch = await tryRun("git", ["branch", "--show-current"], path);
    const head = await run("git", ["rev-parse", "HEAD"], path);
    return { path, head, detached: !branch, ...(branch ? { branch } : {}) };
  }

  private async isDirty(path: string): Promise<boolean> {
    const status = await run(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      path,
    );
    return status.length > 0;
  }
}

function taskWorktreePath(repo: RepositoryInfo, branch: string): string {
  return join(dirname(repo.root), TASK_WORKTREES_DIRNAME, slugify(branch));
}

function slugify(branch: string): string {
  const slug = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "branch";
}

function parsePorcelain(raw: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let current: {
    path?: string;
    head?: string;
    branch?: string;
    detached?: boolean;
  } = {};
  const flush = () => {
    if (current.path) {
      worktrees.push({
        path: current.path,
        head: current.head ?? "",
        detached: current.detached ?? false,
        ...(current.branch ? { branch: current.branch } : {}),
      });
    }
  };
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.detached = true;
    }
  }
  flush();
  return worktrees;
}
