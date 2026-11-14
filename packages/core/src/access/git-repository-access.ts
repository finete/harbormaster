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
import {
  access as fsAccess,
  mkdir,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type {
  GitRepositoryAccess,
  RepositoryCheckout,
  RepositoryInfo,
} from "../contracts/workspace.js";
import { normalizeRemoteIdentity } from "../utilities/remote-identity.js";
import { LONG_RUN_TIMEOUT_MS, run, tryRun } from "../utilities/run.js";

// Re-exported: callers (and tests) historically import it from here.
export { normalizeRemoteIdentity };

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

/** Default lifetime of a cached discovery result (see {@link LocalGitRepositoryAccess}). */
export const DISCOVERY_CACHE_TTL_MS = 5 * 60_000;

export interface LocalGitRepositoryAccessOptions {
  /** Max age of a cached `discoverRepositories` result; 0 disables the cache. */
  discoveryTtlMs?: number;
  /** Clock for the TTL (tests). */
  now?: () => number;
}

interface DiscoveryCacheEntry {
  key: string;
  expiresAt: number;
  repos: RepositoryInfo[];
}

/**
 * `git`-shelling-out implementation of {@link GitRepositoryAccess}.
 *
 * `discoverRepositories` is called on every refresh tick (and by several UI
 * verbs) and costs ~5 git spawns per checkout. Its result is cached, keyed
 * on a cheap filesystem fingerprint: the code root, the preferred-checkout
 * config, the root's directory listing, and a stat (mtime/ctime/inode) of
 * each entry's `.git`. Adding/removing/renaming a checkout, `git init`, or a
 * `.git/config` rewrite (remote change: git writes it via rename, bumping
 * the `.git` directory's mtime) changes the fingerprint and forces a fresh
 * discovery. What the fingerprint cannot see (e.g. `origin/HEAD` moving
 * under `.git/refs/`, which only changes the default branch) is bounded by
 * a TTL. `cloneRepository` drops the cache outright.
 */
export class LocalGitRepositoryAccess implements GitRepositoryAccess {
  private discoveryCache: DiscoveryCacheEntry | undefined;
  private readonly discoveryTtlMs: number;
  private readonly now: () => number;

  constructor(options: LocalGitRepositoryAccessOptions = {}) {
    this.discoveryTtlMs = options.discoveryTtlMs ?? DISCOVERY_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

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
    const key = await discoveryFingerprint(root, entries, preferredCheckouts);
    const cached = this.discoveryCache;
    if (cached && cached.key === key && cached.expiresAt > this.now()) {
      // Fresh copy: callers must never be able to mutate the cache.
      return structuredClone(cached.repos);
    }
    const repos = await this.discoverUncached(
      root,
      entries,
      preferredCheckouts,
    );
    if (this.discoveryTtlMs > 0) {
      this.discoveryCache = {
        key,
        expiresAt: this.now() + this.discoveryTtlMs,
        repos: structuredClone(repos),
      };
    }
    return repos;
  }

  /** Drop the cached discovery result; the next call re-runs git. */
  invalidateDiscoveryCache(): void {
    this.discoveryCache = undefined;
  }

  private async discoverUncached(
    root: string,
    entries: Dirent[],
    preferredCheckouts: Record<string, string> | undefined,
  ): Promise<RepositoryInfo[]> {
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

  async cloneRepository(
    codeRoot: string,
    cloneUrl: string,
  ): Promise<RepositoryInfo> {
    // A clone (or a failed half-clone) changes what discovery would find;
    // the fingerprint would usually notice, but never serve a stale list
    // right after an explicit clone.
    this.invalidateDiscoveryCache();
    try {
      return await this.cloneRepositoryUncached(codeRoot, cloneUrl);
    } finally {
      this.invalidateDiscoveryCache();
    }
  }

  private async cloneRepositoryUncached(
    codeRoot: string,
    cloneUrl: string,
  ): Promise<RepositoryInfo> {
    const root = resolve(codeRoot);
    const target = join(root, repoNameFromUrl(cloneUrl));
    const wantedId = normalizeRemoteIdentity(cloneUrl);
    const alreadyThere = await fsAccess(target).then(
      () => true,
      () => false,
    );
    if (alreadyThere) {
      const isWorkTree = await tryRun(
        "git",
        ["rev-parse", "--is-inside-work-tree"],
        target,
      );
      if (isWorkTree !== "true") {
        throw new Error(`"${target}" already exists and is not a Git checkout`);
      }
      const existingRemote = await tryRun(
        "git",
        ["remote", "get-url", "origin"],
        target,
      );
      if (
        !existingRemote ||
        normalizeRemoteIdentity(existingRemote) !== wantedId
      ) {
        throw new Error(
          `"${target}" already exists with a different origin (expected ${cloneUrl})`,
        );
      }
      return this.resolveRepository(target);
    }
    await mkdir(root, { recursive: true });
    await run("git", ["clone", cloneUrl, target], undefined, {
      timeoutMs: LONG_RUN_TIMEOUT_MS,
    });
    return this.resolveRepository(target);
  }

  async listBranches(repo: RepositoryInfo): Promise<string[]> {
    const output = await tryRun(
      "git",
      [
        "for-each-ref",
        "--format=%(refname)",
        "--sort=-committerdate",
        "refs/heads",
        "refs/remotes",
      ],
      repo.root,
    );
    if (!output) return [];
    const local: string[] = [];
    const remote: string[] = [];
    for (const ref of output.split("\n")) {
      if (ref.startsWith("refs/heads/")) {
        local.push(ref.slice("refs/heads/".length));
      } else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) {
        remote.push(ref.slice("refs/remotes/".length));
      }
    }
    return [...local, ...remote];
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
 * Cheap fingerprint of everything under `root` that discovery's result
 * depends on and that a stat can see: one readdir (already done by the
 * caller) plus one `stat` per directory entry, versus ~5 git spawns each.
 */
async function discoveryFingerprint(
  root: string,
  entries: Dirent[],
  preferredCheckouts: Record<string, string> | undefined,
): Promise<string> {
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  const parts = await Promise.all(
    names.map(async (name) => {
      try {
        const info = await stat(join(root, name, ".git"), { bigint: true });
        return `${name}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`;
      } catch {
        return `${name}:-`;
      }
    }),
  );
  return JSON.stringify([
    root,
    Object.entries(preferredCheckouts ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
    parts,
  ]);
}

/** The last path segment of a clone URL, `.git` stripped (`cloneRepository`'s target directory name). */
function repoNameFromUrl(url: string): string {
  const trimmed = url
    .trim()
    .replace(/\.git\/?$/i, "")
    .replace(/\/+$/, "");
  const name = trimmed.split(/[/:]/).filter(Boolean).pop();
  if (!name) throw new Error(`Cannot derive a repository name from "${url}"`);
  return name;
}
