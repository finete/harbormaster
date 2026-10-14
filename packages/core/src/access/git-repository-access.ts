// Resource Access: Git repository discovery and identity. Ported from
// pi-home's src/access/git-repository-access.ts (remote-identity
// normalization logic from src/engines/repository-identity.ts folds in here
// as a private helper, since engines/ is out of scope for this phase). All
// git process invocations live behind this class and GitWorktreeAccess.
//
// Grouping semantics (ported from pi-home): several directory checkouts
// under a code root that share a repository identity (normalized remote,
// or git-common-dir for remoteless repos) are folded into a single
// RepositoryInfo. Exactly one checkout is the "primary" — the one task
// worktrees are always provisioned from — chosen as: an explicit, valid
// `preferredCheckout` (a known, non-linked-worktree checkout of that
// identity) if configured, else the alphabetically-first non-linked-
// worktree checkout (pi-home's actual heuristic: `checkouts.sort()[0]`,
// which happens to prefer the "plain" `arnac` over `arnac2`/`arnac3`).

import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type {
  GitRepositoryAccess,
  RepositoryCheckout,
  RepositoryInfo,
} from "../contracts/workspace.js";
import { run, tryRun } from "../utilities/run.js";

/** One directory entry under a code root, described well enough to group by identity. */
interface CheckoutDescriptor {
  /** Absolute, realpath-resolved path to this checkout. */
  root: string;
  remoteUrl: string | undefined;
  /** Realpath-resolved `git rev-parse --git-common-dir`. */
  commonDir: string;
  /** True when this checkout's own `.git` is not its common dir (a linked `git worktree add` checkout). */
  isLinkedWorktree: boolean;
}

interface RepositoryGroup {
  remoteUrl: string | undefined;
  checkouts: CheckoutDescriptor[];
}

/** `git`-shelling-out implementation of {@link GitRepositoryAccess}. */
export class LocalGitRepositoryAccess implements GitRepositoryAccess {
  async discoverRepositories(
    codeRoot: string,
    preferredCheckouts?: Record<string, string>,
  ): Promise<RepositoryInfo[]> {
    const root = resolve(codeRoot);
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const groups = new Map<string, RepositoryGroup>();
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const checkout = join(root, entry.name);
      const isWorkTree = await tryRun(
        "git",
        ["rev-parse", "--is-inside-work-tree"],
        checkout,
      );
      if (isWorkTree !== "true") continue;
      const descriptor = await this.describeCheckout(checkout);
      const id = descriptor.remoteUrl
        ? normalizeRemoteIdentity(descriptor.remoteUrl)
        : descriptor.commonDir;
      const group = groups.get(id);
      if (group) {
        // Realpath-dedupe: two directory entries that resolve to the same
        // checkout (e.g. via a symlink) count once.
        if (!group.checkouts.some((c) => c.root === descriptor.root)) {
          group.checkouts.push(descriptor);
        }
        if (!group.remoteUrl && descriptor.remoteUrl) {
          group.remoteUrl = descriptor.remoteUrl;
        }
      } else {
        groups.set(id, {
          remoteUrl: descriptor.remoteUrl,
          checkouts: [descriptor],
        });
      }
    }

    const repos: RepositoryInfo[] = [];
    for (const [id, group] of groups) {
      const pool = group.checkouts.filter((c) => !c.isLinkedWorktree);
      const candidates = (pool.length > 0 ? pool : group.checkouts)
        .map((c) => c.root)
        .sort();
      const preferred = preferredCheckouts?.[id];
      // `candidates` always has at least one entry: it is derived from
      // `group.checkouts`, which is never empty (every group is created
      // with its first checkout already pushed).
      const primaryRoot: string =
        preferred && candidates.includes(preferred)
          ? preferred
          : (candidates[0] as string);
      const defaultBranch = await this.resolveDefaultBranch(primaryRoot);
      const checkouts: RepositoryCheckout[] = [...group.checkouts]
        .map((c) => c.root)
        .sort()
        .map((checkoutRoot) => ({
          root: checkoutRoot,
          isPrimary: checkoutRoot === primaryRoot,
        }));
      repos.push({
        id,
        root: primaryRoot,
        defaultBranch,
        ...(group.remoteUrl ? { remoteUrl: group.remoteUrl } : {}),
        checkouts,
      });
    }
    return repos.sort((a, b) => a.id.localeCompare(b.id));
  }

  async resolveRepository(cwd: string): Promise<RepositoryInfo> {
    const topLevel = await tryRun("git", ["rev-parse", "--show-toplevel"], cwd);
    if (!topLevel) throw new Error(`Not inside a Git repository: ${cwd}`);
    const root = await realpath(topLevel);
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
      checkouts: [{ root, isPrimary: true }],
    };
  }

  private async describeCheckout(
    checkout: string,
  ): Promise<CheckoutDescriptor> {
    const root = await realpath(checkout);
    const remoteUrl = await tryRun(
      "git",
      ["remote", "get-url", "origin"],
      root,
    );
    const [commonDir, gitDir] = await Promise.all([
      this.resolveGitPath(root, "--git-common-dir"),
      this.resolveGitPath(root, "--git-dir"),
    ]);
    return {
      root,
      remoteUrl,
      commonDir,
      isLinkedWorktree: gitDir !== commonDir,
    };
  }

  /** Resolve a `git rev-parse <flag>` path to an absolute, realpath-resolved form. */
  private async resolveGitPath(cwd: string, flag: string): Promise<string> {
    const raw = await run("git", ["rev-parse", flag], cwd);
    const absolute = isAbsolute(raw) ? raw : resolve(cwd, raw);
    return realpath(absolute);
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
