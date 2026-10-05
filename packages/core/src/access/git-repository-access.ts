// Resource Access: Git repository discovery and identity. Ported from
// pi-home's src/access/git-repository-access.ts (remote-identity
// normalization logic from src/engines/repository-identity.ts folds in here
// as a private helper, since engines/ is out of scope for this phase). All
// git process invocations live behind this class and GitWorktreeAccess.

import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  GitRepositoryAccess,
  RepositoryInfo,
} from "../contracts/workspace.js";
import { tryRun } from "../utilities/run.js";

/** `git`-shelling-out implementation of {@link GitRepositoryAccess}. */
export class LocalGitRepositoryAccess implements GitRepositoryAccess {
  async discoverRepositories(codeRoot: string): Promise<RepositoryInfo[]> {
    const root = resolve(codeRoot);
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const repos: RepositoryInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const checkout = join(root, entry.name);
      const isWorkTree = await tryRun(
        "git",
        ["rev-parse", "--is-inside-work-tree"],
        checkout,
      );
      if (isWorkTree !== "true") continue;
      repos.push(await this.describe(checkout));
    }
    return repos.sort((a, b) => a.id.localeCompare(b.id));
  }

  async resolveRepository(cwd: string): Promise<RepositoryInfo> {
    const topLevel = await tryRun("git", ["rev-parse", "--show-toplevel"], cwd);
    if (!topLevel) throw new Error(`Not inside a Git repository: ${cwd}`);
    return this.describe(await realpath(topLevel));
  }

  private async describe(checkout: string): Promise<RepositoryInfo> {
    const root = await realpath(checkout);
    const remoteUrl = await tryRun(
      "git",
      ["remote", "get-url", "origin"],
      root,
    );
    const defaultBranch = await this.resolveDefaultBranch(root);
    const id = remoteUrl ? normalizeRemoteIdentity(remoteUrl) : root;
    return {
      id,
      root,
      defaultBranch,
      ...(remoteUrl ? { remoteUrl } : {}),
    };
  }

  private async resolveDefaultBranch(cwd: string): Promise<string> {
    const symbolic = await tryRun(
      "git",
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      cwd,
    );
    if (symbolic?.includes("/"))
      return symbolic.slice(symbolic.indexOf("/") + 1);
    for (const branch of ["main", "master"]) {
      const ref = await tryRun(
        "git",
        ["show-ref", "--verify", `refs/heads/${branch}`],
        cwd,
      );
      if (ref !== undefined) return branch;
    }
    return (await tryRun("git", ["branch", "--show-current"], cwd)) || "main";
  }
}

/**
 * Normalize an `origin` remote URL to a stable, comparable identity:
 * `git@github.com:org/repo.git`, `https://github.com/org/repo.git`, and
 * `https://user@github.com/org/repo` all normalize to `github.com/org/repo`.
 */
export function normalizeRemoteIdentity(remote: string): string {
  let value = remote
    .trim()
    .replace(/\.git\/?$/i, "")
    .replace(/\/$/, "");
  const scp = value.match(/^[^@/]+@([^:]+):(.+)$/);
  if (scp) value = `${scp[1]}/${scp[2]}`;
  else
    value = value
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
      .replace(/^[^@/]+@/, "");
  return value.toLowerCase();
}
