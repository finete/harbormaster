// A new task worktree starts from the newest of the local default branch and
// `origin/<default>`: pure choice (`chooseDefaultBase`) plus the git side
// (`LocalGitWorktreeAccess.resolveDefaultBase`) against real temporary repos,
// a bare "origin" and a clone of it.

import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LocalGitWorktreeAccess } from "../src/access/git-worktree-access.js";
import type { RepositoryInfo } from "../src/contracts/workspace.js";
import { createCore } from "../src/index.js";
import { chooseDefaultBase } from "../src/utilities/default-base.js";
import {
  execFileRunner,
  type ProcessRunRequest,
  setProcessRunner,
} from "../src/utilities/run.js";
import { captureLogger } from "./fixtures/capture-logger.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function commit(cwd: string, message: string): Promise<string> {
  await writeFile(join(cwd, `${message.replace(/\W+/g, "-")}.txt`), message);
  await git(["add", "."], cwd);
  await git(
    [
      "-c",
      "user.name=Harbormaster Test",
      "-c",
      "user.email=harbormaster-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      message,
    ],
    cwd,
  );
  return git(["rev-parse", "HEAD"], cwd);
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
  setProcessRunner(undefined);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface Fixture {
  root: string;
  bare: string;
  /** The user's checkout, `main` checked out. */
  checkout: string;
  repo: RepositoryInfo;
  /** Another clone, to land commits on origin the way a merged PR does. */
  pusher: string;
  initial: string;
  access: LocalGitWorktreeAccess;
  /** A commit lands on origin/main from someone else's clone. */
  landOnOrigin(message: string): Promise<string>;
  localMain(): Promise<string>;
  originMainCached(): Promise<string>;
}

async function fixture(fetchTimeoutMs?: number): Promise<Fixture> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harbormaster-default-base-")),
  );
  roots.push(root);
  const bare = join(root, "origin.git");
  await git(["init", "--bare", "-q", "-b", "main", bare]);
  const checkout = join(root, "checkout");
  await git(["clone", "-q", bare, checkout]);
  const initial = await commit(checkout, "initial");
  await git(["push", "-q", "origin", "main"], checkout);
  const pusher = join(root, "pusher");
  await git(["clone", "-q", bare, pusher]);
  const repo: RepositoryInfo = {
    id: "example.invalid/acme/repo",
    root: checkout,
    defaultBranch: "main",
    checkouts: [{ root: checkout, isPrimary: true }],
  };
  return {
    root,
    bare,
    checkout,
    repo,
    pusher,
    initial,
    access: new LocalGitWorktreeAccess(join(root, "worktrees"), fetchTimeoutMs),
    async landOnOrigin(message) {
      await git(["pull", "-q", "--ff-only", "origin", "main"], pusher);
      const sha = await commit(pusher, message);
      await git(["push", "-q", "origin", "main"], pusher);
      return sha;
    },
    localMain: () => git(["rev-parse", "refs/heads/main"], checkout),
    originMainCached: () =>
      git(["rev-parse", "refs/remotes/origin/main"], checkout),
  };
}

describe("chooseDefaultBase", () => {
  const sha = (c: string) => c.repeat(40);
  it.each([
    ["behind", "origin"],
    ["equal", "local"],
    ["ahead", "local"],
    ["diverged", "local"],
  ] as const)(
    "fetched, local %s origin: starts from %s",
    (relation, source) => {
      expect(
        chooseDefaultBase({
          fetch: "ok",
          localSha: sha("a"),
          originSha: sha("b"),
          relation,
        }).source,
      ).toBe(source);
    },
  );

  it.each(["no-origin", "failed", "timed-out"] as const)(
    "%s: local wins when it exists, else the cached origin, else nothing",
    (fetch) => {
      const both = chooseDefaultBase({
        fetch,
        localSha: sha("a"),
        originSha: sha("b"),
        // Even a cached origin ahead of local is not trusted over local.
        relation: "behind",
      });
      expect(both.source).toBe("local");
      expect(chooseDefaultBase({ fetch, originSha: sha("b") }).source).toBe(
        "origin",
      );
      expect(chooseDefaultBase({ fetch }).source).toBe("none");
    },
  );

  it("fetched but only one side exists: that side; neither: nothing", () => {
    expect(chooseDefaultBase({ fetch: "ok", originSha: sha("b") }).source).toBe(
      "origin",
    );
    expect(chooseDefaultBase({ fetch: "ok", localSha: sha("a") }).source).toBe(
      "local",
    );
    expect(chooseDefaultBase({ fetch: "ok" }).source).toBe("none");
  });

  it("an unknown relation keeps today's behavior (local)", () => {
    expect(
      chooseDefaultBase({
        fetch: "ok",
        localSha: sha("a"),
        originSha: sha("b"),
      }).source,
    ).toBe("local");
  });
});

describe.skipIf(!gitAvailable)("resolveDefaultBase", () => {
  /** Everything about the user's checkout that must survive a launch untouched. */
  async function snapshot(f: Fixture) {
    return {
      localMain: await f.localMain(),
      head: await git(["symbolic-ref", "HEAD"], f.checkout),
      status: await git(["status", "--porcelain"], f.checkout),
      tree: await git(["rev-parse", "HEAD^{tree}"], f.checkout),
    };
  }

  it("local behind origin: starts from the fresh origin commit, local main untouched", async () => {
    const f = await fixture();
    const landed = await f.landOnOrigin("merged pull request");
    // Origin's new commit is not known locally until the launch fetches it.
    expect(await f.originMainCached()).toBe(f.initial);
    const before = await snapshot(f);

    const base = await f.access.resolveDefaultBase(f.repo);

    expect(base).toMatchObject({
      source: "origin",
      ref: landed,
      commit: landed,
      reason: "local-behind-origin; fetch ok",
    });
    expect(await f.originMainCached()).toBe(landed);
    expect(await snapshot(f)).toEqual(before);
    expect(before.localMain).toBe(f.initial);

    // The task branch is cut from it and tracks nothing.
    const worktree = await f.access.createTaskWorktree(
      f.repo,
      "task/fresh",
      base.ref,
    );
    expect(worktree.head).toBe(landed);
    expect(
      await git(
        ["config", "--get", "branch.task/fresh.remote"],
        f.checkout,
      ).catch(() => ""),
    ).toBe("");
    expect(await f.localMain()).toBe(f.initial);
  });

  it("local equals origin: local", async () => {
    const f = await fixture();
    const before = await snapshot(f);
    const base = await f.access.resolveDefaultBase(f.repo);
    expect(base).toMatchObject({
      source: "local",
      ref: "main",
      commit: f.initial,
      reason: "local-equals-origin; fetch ok",
    });
    expect(await snapshot(f)).toEqual(before);
  });

  it("local ahead of origin (unpushed work): local", async () => {
    const f = await fixture();
    const unpushed = await commit(f.checkout, "unpushed local work");
    const before = await snapshot(f);
    const base = await f.access.resolveDefaultBase(f.repo);
    expect(base).toMatchObject({
      source: "local",
      ref: "main",
      commit: unpushed,
      reason: "local-ahead-of-origin; fetch ok",
    });
    expect(await snapshot(f)).toEqual(before);
  });

  it("local diverged from origin: local", async () => {
    const f = await fixture();
    await f.landOnOrigin("origin only");
    const unpushed = await commit(f.checkout, "local only");
    const before = await snapshot(f);
    const base = await f.access.resolveDefaultBase(f.repo);
    expect(base).toMatchObject({
      source: "local",
      ref: "main",
      commit: unpushed,
      reason: "local-diverged; fetch ok",
    });
    expect(await snapshot(f)).toEqual(before);
  });

  it("no origin remote: local", async () => {
    const f = await fixture();
    await git(["remote", "remove", "origin"], f.checkout);
    const before = await snapshot(f);
    const base = await f.access.resolveDefaultBase(f.repo);
    expect(base).toMatchObject({
      source: "local",
      ref: "main",
      reason: "no origin remote; using local",
    });
    expect(await snapshot(f)).toEqual(before);
  });

  it("no local default branch: the fetched origin commit", async () => {
    const f = await fixture();
    const landed = await f.landOnOrigin("merged pull request");
    await git(["switch", "-q", "-c", "feature"], f.checkout);
    await git(["branch", "-q", "-D", "main"], f.checkout);
    const base = await f.access.resolveDefaultBase(f.repo);
    expect(base).toMatchObject({ source: "origin", ref: landed });
    expect(await git(["branch", "--list", "main"], f.checkout)).toBe("");
  });

  it("fetch fails (unreachable remote): local, no throw, even with a stale cached origin ahead", async () => {
    const f = await fixture();
    const landed = await f.landOnOrigin("merged pull request");
    // Cache the newer origin commit: local main is now behind it.
    await git(["fetch", "-q", "origin"], f.checkout);
    expect(await f.originMainCached()).toBe(landed);
    await git(
      ["remote", "set-url", "origin", join(f.root, "gone.git")],
      f.checkout,
    );
    const before = await snapshot(f);

    const base = await f.access.resolveDefaultBase(f.repo);

    expect(base).toMatchObject({
      source: "local",
      ref: "main",
      commit: f.initial,
      reason: "fetch failed; using local",
    });
    expect(await snapshot(f)).toEqual(before);
    // The launch itself still works.
    const worktree = await f.access.createTaskWorktree(
      f.repo,
      "task/offline",
      base.ref,
    );
    expect(worktree.head).toBe(f.initial);
  });

  it("fetch failed and no local branch: the cached origin commit", async () => {
    const f = await fixture();
    await git(["switch", "-q", "-c", "feature"], f.checkout);
    await git(["branch", "-q", "-D", "main"], f.checkout);
    await git(
      ["remote", "set-url", "origin", join(f.root, "gone.git")],
      f.checkout,
    );
    const base = await f.access.resolveDefaultBase(f.repo);
    expect(base).toMatchObject({ source: "origin", ref: f.initial });
  });

  it("fetch times out (hung transport): local, within the limit, never throws", async () => {
    const f = await fixture(500);
    await git(
      ["remote", "set-url", "origin", "ssh://hung.example.invalid/repo.git"],
      f.checkout,
    );
    const ssh = process.env.GIT_SSH_COMMAND;
    // A transport that never answers (shorter than the test timeout, so no
    // process outlives the run).
    process.env.GIT_SSH_COMMAND = "sleep 4 #";
    try {
      const before = await snapshot(f);
      const started = Date.now();
      const base = await f.access.resolveDefaultBase(f.repo);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(base).toMatchObject({
        source: "local",
        ref: "main",
        reason: "fetch timed out; using local",
      });
      expect(await snapshot(f)).toEqual(before);
    } finally {
      if (ssh === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = ssh;
    }
  });

  it("fetches with a 5 s limit, never prompts, and touches only the default branch's remote-tracking ref", async () => {
    const f = await fixture();
    const seen: ProcessRunRequest[] = [];
    setProcessRunner((request) => {
      seen.push(request);
      return execFileRunner(request);
    });
    await new LocalGitWorktreeAccess(join(f.root, "wt")).resolveDefaultBase(
      f.repo,
    );
    const fetches = seen.filter((r) => r.args.includes("fetch"));
    expect(fetches).toHaveLength(1);
    const [fetch] = fetches;
    expect(fetch?.timeoutMs).toBe(5_000);
    expect(fetch?.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0" });
    expect(fetch?.args.slice(-2)).toEqual([
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ]);
  });

  it("launches racing in one repository share one fetch", async () => {
    const f = await fixture();
    const landed = await f.landOnOrigin("merged pull request");
    const seen: ProcessRunRequest[] = [];
    setProcessRunner((request) => {
      seen.push(request);
      return execFileRunner(request);
    });
    const bases = await Promise.all(
      [1, 2, 3, 4].map(() => f.access.resolveDefaultBase(f.repo)),
    );
    expect(bases.map((b) => b.ref)).toEqual([landed, landed, landed, landed]);
    expect(seen.filter((r) => r.args.includes("fetch"))).toHaveLength(1);
    // The next launch fetches again: no once-a-day cache.
    await f.access.resolveDefaultBase(f.repo);
    expect(seen.filter((r) => r.args.includes("fetch"))).toHaveLength(2);
  });
});

describe.skipIf(!gitAvailable)("task launch through the manager", () => {
  async function launched() {
    const f = await fixture();
    const landed = await f.landOnOrigin("merged pull request");
    const stateDir = join(f.root, "state");
    const codeRoot = join(f.root, "Code");
    await mkdir(stateDir, { recursive: true });
    await mkdir(codeRoot, { recursive: true });
    await rename(f.checkout, join(codeRoot, "checkout"));
    const checkout = join(codeRoot, "checkout");
    await writeFile(
      join(stateDir, "config.json"),
      JSON.stringify({
        automation: false,
        movers: [],
        codeRoot,
        branchPrefix: "",
      }),
    );
    const logger = captureLogger();
    let n = 0;
    const commands = createCore({
      stateDir,
      clock: { now: () => new Date("2026-01-01T00:00:00Z") },
      ids: { next: () => `id-${String(++n).padStart(8, "0")}` },
      logger,
      pullRequests: {} as never,
      versions: {} as never,
    }).commands;
    const [repository] = await commands.listRepositories();
    if (!repository) throw new Error("repository not discovered");
    return {
      f,
      landed,
      checkout,
      commands,
      logger,
      repositoryId: repository.id,
    };
  }

  it("a task with no explicit base starts from the fresh origin tip and logs which base and why", async () => {
    const { f, landed, checkout, commands, logger, repositoryId } =
      await launched();
    const task = await commands.createTask({
      title: "Fresh start",
      initialPrompt: "",
      repositoryId,
      start: true,
    });
    const workspace = await commands.getTaskWorkspace(task.id);
    if (!workspace?.worktreePath) throw new Error("expected a worktree");
    expect(await git(["rev-parse", "HEAD"], workspace.worktreePath)).toBe(
      landed,
    );
    // The user's local main is exactly where it was.
    expect(await git(["rev-parse", "refs/heads/main"], checkout)).toBe(
      f.initial,
    );
    const [line] = logger.find(`task ${task.id} starts from`);
    expect(line).toMatchObject({
      scope: "launch",
      message: `task ${task.id} starts from origin base`,
      fields: {
        taskId: task.id,
        base: `origin/main@${landed.slice(0, 12)}`,
        baseReason: "local-behind-origin; fetch ok",
      },
    });
  });

  it("an explicit baseRef is used as given: no fetch, no resolution line", async () => {
    const { f, checkout, commands, logger, repositoryId } = await launched();
    const task = await commands.createTask({
      title: "Pinned base",
      initialPrompt: "",
      repositoryId,
      baseRef: "main",
      start: true,
    });
    const workspace = await commands.getTaskWorkspace(task.id);
    if (!workspace?.worktreePath) throw new Error("expected a worktree");
    expect(await git(["rev-parse", "HEAD"], workspace.worktreePath)).toBe(
      f.initial,
    );
    expect(logger.find("task ")).toEqual([]);
    expect(await git(["rev-parse", "refs/remotes/origin/main"], checkout)).toBe(
      f.initial,
    );
  });
});
