// Resource Access: Git worktree lifecycle for task execution. Ported from
// pi-home's src/access/git-worktree-access.ts, reshaped around a single
// atomic verb for task creation (createTaskWorktree) that owns the
// <codeRoot>/.harbormaster-worktrees/ layout instead of taking a caller-
// supplied path, and with explicit dirty-refusal / safe-branch-delete
// semantics called out as separate, testable verbs.

import {
  access as fsAccess,
  mkdir,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  GitWorktreeAccess,
  RepositoryInfo,
  WorktreeInfo,
} from "../contracts/workspace.js";
import { LONG_RUN_TIMEOUT_MS, run, tryRun } from "../utilities/run.js";

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
    const preExisted = await fsAccess(path).then(
      () => true,
      () => false,
    );
    try {
      await run(
        "git",
        ["worktree", "add", "-b", branch, path, baseRef],
        repo.root,
        // Checkout of a large tree plus post-checkout hooks can be slow.
        { timeoutMs: LONG_RUN_TIMEOUT_MS },
      );
    } catch (error) {
      // Leave no orphan from *this* failed attempt (branch collision, dirty
      // baseRef, etc): git may have already created the target directory
      // and/or registered it in its worktree bookkeeping before failing.
      // Never remove a directory this call didn't create "- a path
      // collision with an already-live worktree must surface as-is, not
      // destroy the survivor.
      if (!preExisted) {
        await rm(path, { recursive: true, force: true }).catch(() => {});
      }
      await run("git", ["worktree", "prune"], repo.root).catch(() => {});
      throw error;
    }
    return this.inspect(path);
  }

  async removeWorktree(
    repo: RepositoryInfo,
    path: string,
    force = false,
  ): Promise<void> {
    if (!force && (await this.isWorktreeDirty(path))) {
      throw new Error(
        `Refusing to remove dirty worktree: ${path} (pass force to override)`,
      );
    }
    // A worktree is registered to the checkout that created it, which for
    // repos with several checkouts (or pi-home-era migrations) need not be
    // this RepositoryInfo's primary root. Resolve the owner from the worktree
    // itself; fall back to the primary when the worktree is too broken to ask.
    const ownerRoot = await this.owningCheckoutRoot(path).catch(
      () => repo.root,
    );
    try {
      await run(
        "git",
        ["worktree", "remove", ...(force ? ["--force"] : []), path],
        ownerRoot,
        // Deleting a worktree with big build/dependency dirs can be slow, and
        // killing it midway would leave a half-removed tree.
        { timeoutMs: LONG_RUN_TIMEOUT_MS },
      );
    } catch (error) {
      const stillExists = await fsAccess(path).then(
        () => true,
        () => false,
      );
      if (stillExists) throw error;
      // The worktree directory is already gone (e.g. removed out-of-band);
      // prune git's bookkeeping instead of surfacing a stale error.
      await run("git", ["worktree", "prune"], ownerRoot);
    }
  }

  /** The checkout a worktree belongs to: parent of its git common dir. */
  private async owningCheckoutRoot(worktreePath: string): Promise<string> {
    const commonDir = (
      await run(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        worktreePath,
      )
    ).trim();
    return dirname(commonDir);
  }

  async branchExists(repo: RepositoryInfo, branch: string): Promise<boolean> {
    const ref = await tryRun(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      repo.root,
    );
    return ref !== undefined;
  }

  /**
   * Polled once per live task on every refresh tick, so it reads the
   * worktree's HEAD file directly instead of spawning `git` (each spawn is
   * an exec the OS may hold for an endpoint-security check). Falls back to
   * `git branch --show-current` for any layout the file read can't vouch for.
   */
  async currentBranch(path: string): Promise<string | undefined> {
    const head = await readHeadFile(path);
    if (head !== undefined) {
      const branch = branchFromHead(head);
      if (branch !== "unknown") return branch;
    }
    const branch = await tryRun("git", ["branch", "--show-current"], path);
    return branch?.trim() || undefined;
  }

  async deleteBranch(
    repo: RepositoryInfo,
    branch: string,
    force = false,
  ): Promise<void> {
    if (!(await this.branchExists(repo, branch))) return;
    await run("git", ["branch", force ? "-D" : "-d", branch], repo.root);
  }

  async pushBranch(path: string, branch: string): Promise<void> {
    await run("git", ["push", "--set-upstream", "origin", branch], path, {
      timeoutMs: LONG_RUN_TIMEOUT_MS,
    });
  }

  async listTaskWorktreeDirs(
    codeRoot: string,
  ): Promise<{ root: string; dirs: string[] }> {
    const root = join(codeRoot, TASK_WORKTREES_DIRNAME);
    const entries = await readdir(root, { withFileTypes: true }).catch(
      () => [],
    );
    const dirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(root, entry.name))
      .sort();
    return { root, dirs };
  }

  async diskUsageBytes(path: string): Promise<number | undefined> {
    // `du -sk` walks the whole tree (seconds for a multi-GB checkout), so it
    // only runs from the rare orphan scan, never from the refresh tick.
    const out = await tryRun("du", ["-sk", path], undefined, {
      timeoutMs: LONG_RUN_TIMEOUT_MS,
    });
    const kib = Number.parseInt(out?.split(/\s/)[0] ?? "", 10);
    return Number.isFinite(kib) ? kib * 1024 : undefined;
  }

  private async inspect(path: string): Promise<WorktreeInfo> {
    const branch = await tryRun("git", ["branch", "--show-current"], path);
    const head = await run("git", ["rev-parse", "HEAD"], path);
    return { path, head, detached: !branch, ...(branch ? { branch } : {}) };
  }

  async isWorktreeDirty(path: string): Promise<boolean> {
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

/**
 * The raw contents of a checkout's HEAD file: `<path>/.git/HEAD` for a
 * primary checkout, or `<gitdir>/HEAD` where `<path>/.git` is a linked
 * worktree's `gitdir: <dir>` pointer file. `undefined` when neither exists.
 */
async function readHeadFile(path: string): Promise<string | undefined> {
  const dotGit = join(path, ".git");
  const direct = await readFile(join(dotGit, "HEAD"), "utf8").catch(
    () => undefined,
  );
  if (direct !== undefined) return direct;
  const pointer = await readFile(dotGit, "utf8").catch(() => undefined);
  const gitDir = pointer?.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
  if (!gitDir) return undefined;
  const resolved = isAbsolute(gitDir) ? gitDir : resolve(path, gitDir);
  return readFile(join(resolved, "HEAD"), "utf8").catch(() => undefined);
}

/**
 * The branch named by a HEAD file's contents: the short name for a symbolic
 * `ref: refs/heads/<branch>`, `undefined` for a detached HEAD (a bare commit
 * id), or `"unknown"` for anything else (e.g. reftable's `.invalid`
 * placeholder), which the caller resolves through `git` instead.
 */
export function branchFromHead(head: string): string | undefined | "unknown" {
  const text = head.trim();
  const symbolic = text.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (symbolic) {
    const branch = symbolic[1] ?? "";
    return branch && branch !== ".invalid" ? branch : "unknown";
  }
  if (/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(text)) return undefined;
  return "unknown";
}
