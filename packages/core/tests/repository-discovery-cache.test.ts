// LocalGitRepositoryAccess.discoverRepositories caches its result keyed on a
// cheap filesystem fingerprint (codeRoot listing + each checkout's `.git`
// stat) plus a TTL, so the 30s refresh tick stops spawning ~5 git processes
// per checkout. These tests count actual git spawns through utilities/run.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawns = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/utilities/run.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/utilities/run.js")>();
  return {
    ...actual,
    run: (...args: Parameters<typeof actual.run>) => {
      spawns.count += 1;
      return actual.run(...args);
    },
    tryRun: (...args: Parameters<typeof actual.tryRun>) => {
      spawns.count += 1;
      return actual.tryRun(...args);
    },
  };
});

const { LocalGitRepositoryAccess } = await import(
  "../src/access/git-repository-access.js"
);

const execFileAsync = promisify(execFile);
async function git(args: string[], cwd?: string): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harbormaster-discovery-cache-")),
  );
  roots.push(root);
  const code = join(root, "Code");
  await mkdir(code);
  const bare = join(root, "upstream.git");
  await git(["init", "-q", "--bare", "-b", "main", bare]);
  const alpha = join(code, "alpha");
  await git(["init", "-q", "-b", "main", alpha]);
  await git(
    ["remote", "add", "origin", "git@github.com:acme/alpha.git"],
    alpha,
  );
  const beta = join(code, "beta");
  await git(["init", "-q", "-b", "main", beta]);
  await git(["remote", "add", "origin", "git@github.com:acme/beta.git"], beta);
  await mkdir(join(code, "not-a-repo"));
  return { root, code, bare, alpha, beta };
}

describe("LocalGitRepositoryAccess discovery cache", () => {
  it("serves an unchanged code root from cache without spawning git, as fresh copies", async () => {
    const f = await fixture();
    const access = new LocalGitRepositoryAccess();
    spawns.count = 0;
    const first = await access.discoverRepositories(f.code);
    expect(spawns.count).toBeGreaterThan(0);
    expect(first.map((repo) => repo.id)).toEqual([
      "github.com/acme/alpha",
      "github.com/acme/beta",
    ]);

    spawns.count = 0;
    const second = await access.discoverRepositories(f.code);
    expect(spawns.count).toBe(0);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    // Mutating a returned result never leaks into the cache.
    (second[0] as { id: string }).id = "mutated";
    second.pop();
    expect(await access.discoverRepositories(f.code)).toEqual(first);
    expect(spawns.count).toBe(0);
  });

  it("re-discovers when a checkout's .git mtime changes (e.g. its remote was rewritten)", async () => {
    const f = await fixture();
    const access = new LocalGitRepositoryAccess();
    await access.discoverRepositories(f.code);

    // A pure mtime bump is enough to miss.
    const later = new Date(Date.now() + 60_000);
    await utimes(join(f.alpha, ".git"), later, later);
    spawns.count = 0;
    await access.discoverRepositories(f.code);
    expect(spawns.count).toBeGreaterThan(0);

    // And a real remote change is picked up on the next call.
    await git(
      ["remote", "set-url", "origin", "git@github.com:acme/gamma.git"],
      f.alpha,
    );
    const repos = await access.discoverRepositories(f.code);
    expect(repos.map((repo) => repo.id)).toEqual([
      "github.com/acme/beta",
      "github.com/acme/gamma",
    ]);
  });

  it("re-discovers when a checkout appears under the code root", async () => {
    const f = await fixture();
    const access = new LocalGitRepositoryAccess();
    await access.discoverRepositories(f.code);
    const delta = join(f.code, "delta");
    await git(["init", "-q", "-b", "main", delta]);
    await git(
      ["remote", "add", "origin", "git@github.com:acme/delta.git"],
      delta,
    );
    const repos = await access.discoverRepositories(f.code);
    expect(repos.map((repo) => repo.id)).toContain("github.com/acme/delta");
  });

  it("is invalidated by cloneRepository", async () => {
    const f = await fixture();
    const access = new LocalGitRepositoryAccess();
    await access.discoverRepositories(f.code);
    const invalidate = vi.spyOn(access, "invalidateDiscoveryCache");
    await access.cloneRepository(f.code, f.bare);
    expect(invalidate).toHaveBeenCalled();
    spawns.count = 0;
    const repos = await access.discoverRepositories(f.code);
    expect(spawns.count).toBeGreaterThan(0);
    expect(repos.map((repo) => repo.root)).toContain(join(f.code, "upstream"));
  });

  it("expires after the TTL even when the fingerprint is unchanged", async () => {
    const f = await fixture();
    let now = 1_000;
    const access = new LocalGitRepositoryAccess({
      discoveryTtlMs: 10_000,
      now: () => now,
    });
    await access.discoverRepositories(f.code);
    now += 9_000;
    spawns.count = 0;
    await access.discoverRepositories(f.code);
    expect(spawns.count).toBe(0);
    now += 2_000;
    await access.discoverRepositories(f.code);
    expect(spawns.count).toBeGreaterThan(0);
  });

  it("keys on the preferred-checkout config too", async () => {
    const f = await fixture();
    const access = new LocalGitRepositoryAccess();
    await access.discoverRepositories(f.code);
    spawns.count = 0;
    await access.discoverRepositories(f.code, {
      "github.com/acme/alpha": f.alpha,
    });
    expect(spawns.count).toBeGreaterThan(0);
  });
});
