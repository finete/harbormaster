// Behavioral-parity fixes for refresh()/movers/done cleanup (pi-home audit):
// lost-update safety (patch-under-lock + single-flight), bounded
// parallelism, auto-done stay-put, the stage-less Production deploy wait,
// per-repo rules overrides and config warnings, the done-cleanup retry
// sweep, the awaiting(deploy)→dev block, done→dev bookkeeping, and the
// no-remote silent skip. Real temp git repos (createCore's real git access)
// with a fake, gate-able PullRequestAccess: never a real gh/network call.

import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CommitLogEntry,
  PullRequestAccess,
  PullRequestStatus,
  VersionAccess,
} from "../src/contracts/github.js";
import type { Clock, GlobalConfig, Task } from "../src/contracts/index.js";
import { PRODUCTION_STAGE } from "../src/engines/deployment.js";
import { repositoryRulesFile } from "../src/engines/rules/rule-files.js";
import { type Core, createCore } from "../src/index.js";

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
      "--allow-empty",
      "-q",
      "-m",
      message,
    ],
    cwd,
  );
}

class MutableClock implements Clock {
  constructor(public current: Date) {}
  now(): Date {
    return this.current;
  }
}

/** Fake gh: per-branch statuses, plus an optional gate that holds every `status()` call (a slow gh). */
class SlowFakePullRequests implements PullRequestAccess {
  statusByBranch = new Map<string, PullRequestStatus | undefined>();
  statusCalls: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private gate: Promise<void> | undefined;
  private openGate: (() => void) | undefined;
  private waiters: Array<() => void> = [];

  hold(): void {
    this.gate = new Promise((resolve) => {
      this.openGate = resolve;
    });
  }

  release(): void {
    this.openGate?.();
    this.gate = undefined;
  }

  /** Resolves once `count` status calls are in flight. */
  async waitForCalls(count: number): Promise<void> {
    while (this.inFlight < count) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  async status(
    _repositoryId: string,
    branch: string,
  ): Promise<PullRequestStatus | undefined> {
    this.statusCalls.push(branch);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    for (const wake of this.waiters.splice(0)) wake();
    try {
      if (this.gate) await this.gate;
      return this.statusByBranch.get(branch);
    } finally {
      this.inFlight -= 1;
    }
  }

  async ensureOpen(): Promise<PullRequestStatus> {
    throw new Error("ensureOpen not used here");
  }

  async squashMerge(): Promise<PullRequestStatus> {
    throw new Error("squashMerge not used here");
  }

  async containsCommit(): Promise<boolean> {
    return true;
  }

  async commitLog(): Promise<CommitLogEntry[]> {
    return [];
  }
}

class FakeVersions implements VersionAccess {
  documents = new Map<string, string>();
  async fetchText(url: string): Promise<string> {
    const doc = this.documents.get(url);
    if (doc === undefined) throw new Error(`no fake document for ${url}`);
    return doc;
  }
}

function pr(overrides: Partial<PullRequestStatus> = {}): PullRequestStatus {
  return {
    number: 7,
    url: "https://github.com/acme/repo/pull/7",
    state: "OPEN",
    isDraft: false,
    reviewRequested: false,
    reviewSubmitted: false,
    checkedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface Fixture {
  stateDir: string;
  codeRoot: string;
  checkout: string;
  repositoryId: string;
  core: Core;
  pullRequests: SlowFakePullRequests;
  versions: FakeVersions;
  clock: MutableClock;
  writeConfig(patch: Partial<GlobalConfig>): Promise<void>;
  startedTask(title: string, branch?: string): Promise<Task>;
}

let counter = 0;

async function fixture(): Promise<Fixture> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harbormaster-refresh-parity-")),
  );
  roots.push(root);
  const stateDir = join(root, "state");
  const codeRoot = join(root, "Code");
  await mkdir(stateDir, { recursive: true });
  await mkdir(codeRoot, { recursive: true });
  const bare = join(root, "upstream.git");
  await git(["init", "-q", "--bare", "-b", "main", bare]);
  const checkout = join(codeRoot, "repo");
  await git(["clone", "-q", bare, checkout]);
  await gitCommit(checkout, "init");
  await git(["push", "-q", "origin", "main"], checkout);

  const writeConfig = async (patch: Partial<GlobalConfig>) => {
    await writeFile(
      join(stateDir, "config.json"),
      JSON.stringify({
        automation: true,
        codeRoot,
        branchPrefix: "",
        ...patch,
      }),
    );
  };
  await writeConfig({});

  const pullRequests = new SlowFakePullRequests();
  const versions = new FakeVersions();
  const clock = new MutableClock(new Date("2026-01-01T00:00:00.000Z"));
  const core = createCore({
    stateDir,
    clock,
    ids: { next: () => `id-${(++counter).toString().padStart(8, "0")}` },
    pullRequests,
    versions,
  });
  const [repo] = await core.commands.listRepositories();
  if (!repo) throw new Error("fixture repo not discovered");
  return {
    stateDir,
    codeRoot,
    checkout,
    repositoryId: repo.id,
    core,
    pullRequests,
    versions,
    clock,
    writeConfig,
    startedTask: (title, branch) =>
      core.commands.createTask({
        title,
        initialPrompt: "do it",
        repositoryId: repo.id,
        start: true,
        ...(branch ? { branch } : {}),
      }),
  };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe("refresh lost-update safety (#8)", () => {
  it("never reverts a move made while gh was still answering", async () => {
    const f = await fixture();
    const task = await f.startedTask("Racy");
    f.pullRequests.statusByBranch.set(task.branch!, pr());
    f.pullRequests.hold();

    const refreshing = f.core.commands.refresh();
    await f.pullRequests.waitForCalls(1);
    // The user parks the task on Slack while refresh waits on gh.
    await f.core.commands.moveTask(task.id, "awaiting", {
      awaiting: { kind: "slack", permalink: "https://slack.example/p1" },
    });
    f.pullRequests.release();
    await refreshing;

    const reloaded = await f.core.commands.getTask(task.id);
    expect(reloaded?.state).toBe("awaiting");
    expect(reloaded?.awaiting).toEqual({
      kind: "slack",
      permalink: "https://slack.example/p1",
    });
    // The PR snapshot itself still landed, patched onto the moved task.
    expect(reloaded?.pr).toMatchObject({ number: 7, state: "open" });
  });

  it("drops a PR snapshot fetched for a task that was completed meanwhile", async () => {
    const f = await fixture();
    const task = await f.startedTask("Completed mid-refresh");
    f.pullRequests.statusByBranch.set(task.branch!, pr());
    f.pullRequests.hold();

    const refreshing = f.core.commands.refresh();
    await f.pullRequests.waitForCalls(1);
    await f.core.commands.toDone(task.id, { force: { confirmed: true } });
    f.pullRequests.release();
    await refreshing;

    const reloaded = await f.core.commands.getTask(task.id);
    expect(reloaded?.state).toBe("done");
    expect(reloaded?.pr).toBeUndefined();
  });

  it("joins a refresh requested while one is in flight instead of overlapping it", async () => {
    const f = await fixture();
    const task = await f.startedTask("Single flight");
    f.pullRequests.statusByBranch.set(task.branch!, pr());
    f.pullRequests.hold();

    const first = f.core.commands.refresh();
    await f.pullRequests.waitForCalls(1);
    const second = f.core.commands.refresh();
    f.pullRequests.release();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(b);
    expect(f.pullRequests.statusCalls).toEqual([task.branch]);
    // Once settled, a new refresh runs again.
    await f.core.commands.refresh();
    expect(f.pullRequests.statusCalls).toHaveLength(2);
  });
});

describe("bounded parallel refresh (#20)", () => {
  it("observes at most 4 tasks' PRs at once", async () => {
    const f = await fixture();
    for (let index = 0; index < 6; index += 1) {
      await f.startedTask(`Task ${index}`, `parallel-${index}`);
    }
    f.pullRequests.hold();
    const refreshing = f.core.commands.refresh();
    await f.pullRequests.waitForCalls(4);
    // Give a fifth worker every chance to (wrongly) start.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.pullRequests.inFlight).toBe(4);
    f.pullRequests.release();
    await refreshing;
    expect(f.pullRequests.maxInFlight).toBe(4);
    expect(f.pullRequests.statusCalls).toHaveLength(6);
  });
});

describe("stage-less Production deploy wait (#3)", () => {
  it("parks a merged PR with no pipeline under a 'Production deploy' group, never auto-lands it, and lets a manual Done land it", async () => {
    const f = await fixture();
    const task = await f.startedTask("Merged");
    f.pullRequests.statusByBranch.set(
      task.branch!,
      pr({
        state: "MERGED",
        mergeCommit: { oid: "abcdef0123456", url: "https://x/c" },
      }),
    );

    await f.core.commands.refresh();
    let reloaded = await f.core.commands.getTask(task.id);
    expect(reloaded?.awaiting).toEqual({
      kind: "deploy",
      stageId: PRODUCTION_STAGE.id,
      stageLabel: "Production deploy",
    });
    // #10: no base branch reported → the repository's default branch.
    expect(reloaded?.pr?.mergeCommit?.targetBranch).toBe("main");
    const awaiting = (await f.core.commands.listBoard()).find(
      (column) => column.state === "awaiting",
    );
    expect(awaiting?.groups.map((group) => group.primaryLabel)).toEqual([
      "Production deploy",
    ]);

    await f.core.commands.refresh();
    reloaded = await f.core.commands.getTask(task.id);
    expect(reloaded?.state).toBe("awaiting");

    const done = await f.core.commands.toDone(task.id, {
      force: { confirmed: true },
    });
    expect(done).toMatchObject({ task: { state: "done" } });
  });
});

describe("auto-done stays put when cleanup would be refused (#4, #5)", () => {
  async function landingFixture() {
    const f = await fixture();
    await f.writeConfig({
      repositories: {
        [f.repositoryId]: {
          deployment: {
            stages: [
              {
                id: "prod",
                label: "Production",
                hook: "version-endpoint",
                options: { url: "https://prod.example/version" },
              },
            ],
          },
        },
      },
    });
    f.versions.documents.set(
      "https://prod.example/version",
      "v1.0.0+dddddd1234567",
    );
    const task = await f.startedTask("Deployable");
    f.pullRequests.statusByBranch.set(
      task.branch!,
      pr({
        state: "MERGED",
        baseRefName: "main",
        mergeCommit: {
          oid: "abcdef0123456",
          targetBranch: "main",
          url: "https://x/c",
        },
      } as Partial<PullRequestStatus>),
    );
    await f.core.commands.refresh(); // → awaiting / prod
    const binding = await f.core.commands.getTaskWorkspace(task.id);
    return { f, task, worktree: binding!.worktreePath! };
  }

  it("keeps a deployed task with a dirty worktree in Awaiting with a ready-to-land warning", async () => {
    const { f, task, worktree } = await landingFixture();
    await writeFile(join(worktree, "scratch.txt"), "dirty\n");

    const { warnings } = await f.core.commands.refresh();

    const reloaded = await f.core.commands.getTask(task.id);
    expect(reloaded?.state).toBe("awaiting");
    expect(warnings).toEqual([
      expect.stringContaining("deployed and ready to land — mark it Done"),
    ]);
    expect(await exists(join(worktree, "scratch.txt"))).toBe(true);
    expect(
      (await f.core.commands.getTaskWorkspace(task.id))?.worktreePath,
    ).toBe(worktree);
  });

  it("honors refresh protectedPaths: a live pane's worktree keeps the task in place", async () => {
    const { f, task, worktree } = await landingFixture();

    const { warnings } = await f.core.commands.refresh({
      protectedPaths: [worktree],
    });

    expect((await f.core.commands.getTask(task.id))?.state).toBe("awaiting");
    expect(warnings).toEqual([
      expect.stringContaining("open in a live session"),
    ]);
    expect(await exists(worktree)).toBe(true);
  });

  it("lands a clean, unprotected deployed task and force-deletes its merged branch", async () => {
    const { f, task, worktree } = await landingFixture();

    const { warnings } = await f.core.commands.refresh();

    expect(warnings).toEqual([]);
    expect((await f.core.commands.getTask(task.id))?.state).toBe("done");
    expect(await exists(worktree)).toBe(false);
    expect(await git(["branch", "--list", task.branch!], f.checkout)).toBe("");
  });
});

describe("done-cleanup retry sweep (#6)", () => {
  it("retries a refused legacy cleanup (a Done from before task.cleanup) each refresh, warns once per reason, and removes the worktree once it is clean (binding kept)", async () => {
    const f = await fixture();
    const task = await f.startedTask("Dirty done");
    const worktree = (await f.core.commands.getTaskWorkspace(task.id))!
      .worktreePath!;
    await f.core.commands.claimSessionLaunch(task.id);
    await writeFile(join(worktree, "scratch.txt"), "dirty\n");
    // A Done recorded before the app owned cleanup: in Done, worktree kept,
    // no `cleanup` record (so the old unforced sweep applies).
    await f.core.commands.moveTask(task.id, "done");
    expect((await f.core.commands.getTask(task.id))?.cleanup).toBeUndefined();

    const r1 = await f.core.commands.refresh();
    expect(r1.warnings).toEqual([
      expect.stringContaining("Refusing to remove dirty worktree"),
    ]);
    const r2 = await f.core.commands.refresh();
    expect(r2.warnings).toEqual([]);

    // A live pane in it: skipped silently, nothing removed.
    await rm(join(worktree, "scratch.txt"));
    await f.core.commands.refresh({ protectedPaths: [worktree] });
    expect(await exists(worktree)).toBe(true);

    await f.core.commands.refresh();
    expect(await exists(worktree)).toBe(false);
    const parked = await f.core.commands.getTaskWorkspace(task.id);
    expect(parked?.worktreePath).toBeUndefined();
    // Session continuity: the binding (and its session identity) survives.
    expect(parked?.sessionId).toBeDefined();
  });
});

describe("board-transition parity (#16, #17)", () => {
  it("refuses to send a task awaiting deployment back to Dev", async () => {
    const f = await fixture();
    const task = await f.startedTask("Deploying");
    await f.core.commands.moveTask(task.id, "awaiting", {
      awaiting: { kind: "deploy", stageId: "prod", stageLabel: "Production" },
    });
    await expect(f.core.commands.moveTask(task.id, "dev")).rejects.toThrow(
      /cannot return to Dev/,
    );
    expect((await f.core.commands.getTask(task.id))?.state).toBe("awaiting");
  });

  it("clears completedAt and archivedAt when a done task moves back to Dev", async () => {
    const f = await fixture();
    const task = await f.core.commands.createTask({
      title: "Scratch",
      initialPrompt: "",
      kind: "temp_task",
      start: true,
    });
    await f.core.commands.toDone(task.id, { force: { confirmed: true } });
    f.clock.current = new Date("2026-01-09T00:00:00.000Z");
    await f.core.commands.refresh();
    expect((await f.core.commands.getTask(task.id))?.archivedAt).toBeDefined();

    const moved = await f.core.commands.moveTask(task.id, "dev");

    expect(moved.completedAt).toBeUndefined();
    expect(moved.archivedAt).toBeUndefined();
    // Leaving Done stops the app-owned cleanup too.
    expect(moved.cleanup).toBeUndefined();
  });
});

describe("rules config parity (#12, #13, #14)", () => {
  async function writeRules(f: Fixture, file: string, yaml: string) {
    const path = join(f.stateDir, "rules", file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, yaml);
  }
  const REVIEW_RULE = `rules:
  - id: review-requested-enter-review
    label: review-requested-enter-review
    on: [github.pr.*, harbormaster.task.*]
    if: task.state == "dev" && "reviewRequested" in facts.github && facts.github.reviewRequested == true
    do: [{ action: move, with: { to: await, kind: review } }]
`;

  it("a repository rules file replaces the global list ([] disables rules for that repo)", async () => {
    const f = await fixture();
    await writeRules(f, repositoryRulesFile(f.repositoryId), "rules: []\n");
    const task = await f.startedTask("Overridden");
    f.pullRequests.statusByBranch.set(
      task.branch!,
      pr({ reviewRequested: true }),
    );
    await f.core.commands.refresh();
    expect((await f.core.commands.getTask(task.id))?.state).toBe("dev");

    await writeRules(f, "rules.yaml", "rules: []\n");
    await writeRules(f, repositoryRulesFile(f.repositoryId), REVIEW_RULE);
    // Rules react to events: the next PR change is evaluated against the
    // repository's own list now.
    f.pullRequests.statusByBranch.set(
      task.branch!,
      pr({ reviewRequested: true, reviewSubmitted: true }),
    );
    await f.core.commands.refresh();
    expect((await f.core.commands.getTask(task.id))?.state).toBe("awaiting");
  });

  it("an empty global rules list disables all automatic moves", async () => {
    const f = await fixture();
    await writeRules(f, "rules.yaml", "rules: []\n");
    const task = await f.startedTask("Frozen");
    f.pullRequests.statusByBranch.set(
      task.branch!,
      pr({ reviewRequested: true }),
    );
    await f.core.commands.refresh();
    const reloaded = await f.core.commands.getTask(task.id);
    expect(reloaded?.state).toBe("dev");
    expect(reloaded?.pr).toMatchObject({ reviewRequested: true });
  });

  it("migrates a legacy `movers: []` config into an empty rules.yaml on first run", async () => {
    const f = await fixture();
    await f.writeConfig({ movers: [] } as Partial<GlobalConfig>);
    const task = await f.startedTask("Legacy frozen");
    f.pullRequests.statusByBranch.set(
      task.branch!,
      pr({ reviewRequested: true }),
    );
    await f.core.commands.refresh();
    expect((await f.core.commands.getTask(task.id))?.state).toBe("dev");
    const rules = await readFile(
      join(f.stateDir, "rules", "rules.yaml"),
      "utf8",
    );
    expect(rules).toContain("rules: []");
  });

  it("reports unregistered hook names and invalid rule files once, not every tick", async () => {
    const f = await fixture();
    await f.writeConfig({
      repositories: {
        [f.repositoryId]: {
          deployment: {
            stages: [{ id: "pre", label: "Pre", hook: "nope-hook" }],
          },
        },
      },
    });
    await writeRules(
      f,
      "rules.yaml",
      "rules:\n  - id: broken\n    label: broken\n    on: x\n",
    );
    const first = await f.core.commands.refresh();
    expect(first.warnings).toEqual([
      expect.stringContaining(
        "rules.yaml: /rules/0 must have required property 'do'",
      ),
      expect.stringContaining('unregistered hook "nope-hook"'),
    ]);
    expect((await f.core.commands.refresh()).warnings).toEqual([]);
  });

  it("an unregistered hook degrades its stage to a manual gate without per-tick warnings", async () => {
    const f = await fixture();
    await f.writeConfig({
      repositories: {
        [f.repositoryId]: {
          deployment: {
            stages: [{ id: "pre", label: "Pre", hook: "nope-hook" }],
          },
        },
      },
    });
    const task = await f.startedTask("Gated");
    await f.core.commands.moveTask(task.id, "awaiting", {
      awaiting: { kind: "deploy", stageId: "pre", stageLabel: "Pre" },
    });
    f.pullRequests.statusByBranch.set(task.branch!, pr({ state: "MERGED" }));
    await f.core.commands.refresh();
    const { warnings } = await f.core.commands.refresh();
    expect(warnings).toEqual([]);
    expect((await f.core.commands.getTask(task.id))?.awaiting).toMatchObject({
      stageId: "pre",
    });
  });
});

describe("no-remote repositories (#9)", () => {
  it("are skipped silently by refresh and rejected by toAwait(review) with a clear error", async () => {
    const f = await fixture();
    const local = join(f.codeRoot, "local-only");
    await git(["init", "-q", "-b", "main", local]);
    await gitCommit(local, "init");
    const repos = await f.core.commands.listRepositories();
    const localRoot = await realpath(local);
    const localRepo = repos.find((repo) => repo.root === localRoot);
    expect(localRepo?.remoteUrl).toBeUndefined();
    const task = await f.core.commands.createTask({
      title: "Local",
      initialPrompt: "",
      repositoryId: localRepo!.id,
      start: true,
    });

    const { warnings } = await f.core.commands.refresh();

    expect(warnings).toEqual([]);
    expect(f.pullRequests.statusCalls).not.toContain(task.branch);
    await expect(f.core.commands.toAwait(task.id, "review")).rejects.toThrow(
      /no origin remote/,
    );
  });
});
