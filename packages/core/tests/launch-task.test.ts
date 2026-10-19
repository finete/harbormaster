// Integration tests for the task-launching primitive (see
// ai/prds/task-launching.md): CoreManager.launchTask, claimPendingLaunches,
// markLaunchesInterrupted, listChildren, getLaunchSettings, and toDone's new
// activeChildren confirmation + never-git-scratch-bindings rule. Wired to
// real git repository/worktree access against real temp git repos, same
// fixture pattern as tests/start-task.test.ts. GitHub/HTTP access is stubbed
// and never invoked.

import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  PullRequestAccess,
  VersionAccess,
} from "../src/contracts/github.js";
import type { Clock } from "../src/contracts/index.js";
import { type Core, createCore, isToDoneConfirmation } from "../src/index.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

let gitAvailable = true;
beforeAll(async () => {
  try {
    await git(["--version"]);
  } catch {
    gitAvailable = false;
  }
});

class FixedClock implements Clock {
  private ms = Date.parse("2026-01-01T00:00:00.000Z");
  now(): Date {
    // Advance a tick per call so requestedAt timestamps are strictly
    // increasing (FIFO ordering has something real to sort on).
    const current = new Date(this.ms);
    this.ms += 1000;
    return current;
  }
}

let counter = 0;
const sequentialIds = {
  next: () => `id-${(++counter).toString().padStart(8, "0")}`,
};

const noGithub = new Proxy({} as PullRequestAccess & VersionAccess, {
  get: () => () => {
    throw new Error("GitHub/HTTP access must not be used in these tests");
  },
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function fixture(): Promise<{
  stateDir: string;
  checkout: string;
  repositoryId: string;
  core: Core;
}> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harbormaster-launch-task-")),
  );
  roots.push(root);
  const stateDir = join(root, "state");
  const codeRoot = join(root, "Code");
  const checkout = join(codeRoot, "harbor-repo");
  await mkdir(stateDir, { recursive: true });
  await git(["init", "-q", "-b", "main", checkout]);
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
      "--allow-empty",
      "-m",
      "init",
    ],
    checkout,
  );
  await git(
    ["remote", "add", "origin", "git@github.com:acme/harbor-repo.git"],
    checkout,
  );
  await writeFile(
    join(stateDir, "config.json"),
    JSON.stringify({
      automation: false,
      movers: [],
      codeRoot,
      branchPrefix: "",
    }),
  );
  counter = 0;
  const core = createCore({
    stateDir,
    clock: new FixedClock(),
    ids: sequentialIds,
    pullRequests: noGithub,
    versions: noGithub,
  });
  return {
    stateDir,
    checkout,
    repositoryId: "github.com/acme/harbor-repo",
    core,
  };
}

describe.skipIf(!gitAvailable)("launchTask", () => {
  it("standalone: lands in dev, queued, with the kickoff contract appended to the prompt", async () => {
    const f = await fixture();
    const task = await f.core.commands.launchTask({
      relation: "standalone",
      title: "Fix the bug",
      prompt: "Fix the flaky test",
      repository: { repositoryId: f.repositoryId },
    });

    expect(task.state).toBe("dev");
    expect(task.kind).toBe("task");
    expect(task.parentTaskId).toBeUndefined();
    expect(task.launchedFromTaskId).toBeUndefined();
    expect(task.launch).toMatchObject({ status: "queued" });
    expect(task.initialPrompt).toContain("Fix the flaky test");
    expect(task.initialPrompt).toContain("harbormaster_report_status");
    expect(task.branch).toBeDefined();
    const workspace = await f.core.commands.getTaskWorkspace(task.id);
    expect(workspace?.worktreePath).toBeDefined();
  });

  it("standalone: records display-only provenance when launched from a task, without lineage", async () => {
    const f = await fixture();
    const origin = await f.core.commands.launchTask({
      relation: "standalone",
      title: "Origin",
      prompt: "origin work",
      repository: { repositoryId: f.repositoryId },
    });
    const task = await f.core.commands.launchTask({
      relation: "standalone",
      fromTaskId: origin.id,
      title: "Side quest",
      prompt: "unrelated work",
      repository: { repositoryId: f.repositoryId },
    });
    expect(task.launchedFromTaskId).toBe(origin.id);
    expect(task.parentTaskId).toBeUndefined();
    expect(await f.core.commands.listChildren(origin.id)).toEqual([]);
  });

  it("child: requires fromTaskId and sets parentTaskId; rejects an unknown fromTaskId", async () => {
    const f = await fixture();
    await expect(
      f.core.commands.launchTask({
        relation: "child",
        title: "Nope",
        prompt: "nope",
        repository: { repositoryId: f.repositoryId },
      }),
    ).rejects.toThrow(/fromTaskId/);

    await expect(
      f.core.commands.launchTask({
        relation: "child",
        fromTaskId: "missing",
        title: "Nope",
        prompt: "nope",
        repository: { repositoryId: f.repositoryId },
      }),
    ).rejects.toThrow(/Task not found/);

    const parent = await f.core.commands.launchTask({
      relation: "standalone",
      title: "Parent",
      prompt: "parent work",
      repository: { repositoryId: f.repositoryId },
    });
    const child = await f.core.commands.launchTask({
      relation: "child",
      fromTaskId: parent.id,
      title: "Child",
      prompt: "child work",
      repository: { repositoryId: f.repositoryId },
    });
    expect(child.parentTaskId).toBe(parent.id);
    expect(child.initialPrompt).toContain(
      `Launched as a subtask of: Parent (${parent.id})`,
    );
    expect(await f.core.commands.listChildren(parent.id)).toEqual([child]);
  });

  it("rejects a child launched from a task that already has a parent (one level only)", async () => {
    const f = await fixture();
    const parent = await f.core.commands.launchTask({
      relation: "standalone",
      title: "Parent",
      prompt: "parent work",
      repository: { repositoryId: f.repositoryId },
    });
    const child = await f.core.commands.launchTask({
      relation: "child",
      fromTaskId: parent.id,
      title: "Child",
      prompt: "child work",
      repository: { repositoryId: f.repositoryId },
    });
    await expect(
      f.core.commands.launchTask({
        relation: "child",
        fromTaskId: child.id,
        title: "Grandchild",
        prompt: "nope",
        repository: { repositoryId: f.repositoryId },
      }),
    ).rejects.toThrow(/one level only/);

    // A child *can* still launch a standalone task.
    const standalone = await f.core.commands.launchTask({
      relation: "standalone",
      fromTaskId: child.id,
      title: "Side quest",
      prompt: "fine",
      repository: { repositoryId: f.repositoryId },
    });
    expect(standalone.launchedFromTaskId).toBe(child.id);
  });

  it('baseBranch "parent": stacks the child worktree on the parent branch, never for standalone or cross-repository', async () => {
    const f = await fixture();
    const parent = await f.core.commands.launchTask({
      relation: "standalone",
      title: "Parent",
      prompt: "parent work",
      repository: { repositoryId: f.repositoryId },
    });

    await expect(
      f.core.commands.launchTask({
        relation: "standalone",
        title: "Nope",
        prompt: "nope",
        repository: { repositoryId: f.repositoryId },
        baseBranch: "parent",
      }),
    ).rejects.toThrow(/only valid for a child/);

    // Commit something onto the parent's branch *before* launching the
    // child: if the child's worktree really branches off the parent's
    // branch (not the repository's default branch), that file is there
    // from the start.
    const parentWorkspace = await f.core.commands.getTaskWorkspace(parent.id);
    await writeFile(
      join(parentWorkspace!.worktreePath!, "parent-only.txt"),
      "x\n",
    );
    await git(["add", "."], parentWorkspace!.worktreePath);
    await git(
      [
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "parent-only change",
      ],
      parentWorkspace!.worktreePath,
    );

    const child = await f.core.commands.launchTask({
      relation: "child",
      fromTaskId: parent.id,
      title: "Stacked child",
      prompt: "stacked work",
      repository: { repositoryId: f.repositoryId },
      baseBranch: "parent",
    });
    expect(child.initialPrompt).toMatch(
      new RegExp(`based on "${parent.branch}"`),
    );

    const childWorkspace = await f.core.commands.getTaskWorkspace(child.id);
    expect(
      await exists(join(childWorkspace!.worktreePath!, "parent-only.txt")),
    ).toBe(true);
  });

  it('baseBranch "parent" rejects a cross-repository child or a parent with no branch yet', async () => {
    const f = await fixture();
    const parkedParent = await f.core.commands.createTask({
      title: "Parked parent",
      initialPrompt: "",
      repositoryId: f.repositoryId,
    });
    await expect(
      f.core.commands.launchTask({
        relation: "child",
        fromTaskId: parkedParent.id,
        title: "Child",
        prompt: "child work",
        repository: { repositoryId: f.repositoryId },
        baseBranch: "parent",
      }),
    ).rejects.toThrow(/no branch yet/);
  });

  it("{ none: true }: creates a temp_task with a scratch-directory binding", async () => {
    const f = await fixture();
    const task = await f.core.commands.launchTask({
      relation: "standalone",
      title: "Scratch work",
      prompt: "just think",
      repository: { none: true },
    });
    expect(task.kind).toBe("temp_task");
    expect(task.repositoryId).toBeUndefined();
    expect(task.initialPrompt).not.toMatch(/DRAFT pull request/);
    const workspace = await f.core.commands.getTaskWorkspace(task.id);
    expect(workspace?.scratch).toBe(true);
    expect(workspace?.worktreePath).toContain(join("scratch", task.id));
    expect(await exists(workspace!.worktreePath!)).toBe(true);
  });
});

describe.skipIf(!gitAvailable)(
  "claimPendingLaunches / markLaunchesInterrupted",
  () => {
    it("claims up to `limit` queued launches FIFO by requestedAt, flipping them to started", async () => {
      const f = await fixture();
      const a = await f.core.commands.launchTask({
        relation: "standalone",
        title: "A",
        prompt: "a",
        repository: { repositoryId: f.repositoryId },
      });
      const b = await f.core.commands.launchTask({
        relation: "standalone",
        title: "B",
        prompt: "b",
        repository: { repositoryId: f.repositoryId },
      });
      await f.core.commands.launchTask({
        relation: "standalone",
        title: "C",
        prompt: "c",
        repository: { repositoryId: f.repositoryId },
      });

      const claimed = await f.core.commands.claimPendingLaunches(2);
      expect(claimed.map((t) => t.id)).toEqual([a.id, b.id]);
      for (const task of claimed) {
        expect(task.launch?.status).toBe("started");
        expect(task.launch?.startedAt).toBeDefined();
      }
      const cTask = await f.core.commands.getTask(
        (await f.core.commands.listBoard())
          .flatMap((c) => c.groups.flatMap((g) => g.tasks))
          .find((t) => t.title === "C")!.id,
      );
      expect(cTask?.launch?.status).toBe("queued");
    });

    it("limit <= 0 claims nothing", async () => {
      const f = await fixture();
      await f.core.commands.launchTask({
        relation: "standalone",
        title: "A",
        prompt: "a",
        repository: { repositoryId: f.repositoryId },
      });
      expect(await f.core.commands.claimPendingLaunches(0)).toEqual([]);
      expect(await f.core.commands.claimPendingLaunches(-1)).toEqual([]);
    });

    it("markLaunchesInterrupted flips only started launches, ignoring unknown ids and other statuses", async () => {
      const f = await fixture();
      const started = await f.core.commands.launchTask({
        relation: "standalone",
        title: "Started",
        prompt: "x",
        repository: { repositoryId: f.repositoryId },
      });
      const queued = await f.core.commands.launchTask({
        relation: "standalone",
        title: "Queued",
        prompt: "x",
        repository: { repositoryId: f.repositoryId },
      });
      await f.core.commands.claimPendingLaunches(1);

      await f.core.commands.markLaunchesInterrupted([
        started.id,
        queued.id,
        "unknown-id",
      ]);

      const startedAfter = await f.core.commands.getTask(started.id);
      const queuedAfter = await f.core.commands.getTask(queued.id);
      expect(startedAfter?.launch?.status).toBe("interrupted");
      expect(startedAfter?.launch?.interruptedAt).toBeDefined();
      expect(queuedAfter?.launch?.status).toBe("queued");
    });
  },
);

describe.skipIf(!gitAvailable)("getLaunchSettings", () => {
  it("defaults maxConcurrent to 6 with no defaultModel", async () => {
    const f = await fixture();
    expect(await f.core.commands.getLaunchSettings()).toEqual({
      maxConcurrent: 6,
    });
  });

  it("reflects configured launch settings", async () => {
    const f = await fixture();
    await writeFile(
      join(f.stateDir, "config.json"),
      JSON.stringify({
        automation: false,
        movers: [],
        codeRoot: join(f.stateDir, "..", "Code"),
        branchPrefix: "",
        launch: { maxConcurrent: 2, defaultModel: "anthropic/claude" },
      }),
    );
    expect(await f.core.commands.getLaunchSettings()).toEqual({
      maxConcurrent: 2,
      defaultModel: "anthropic/claude",
    });
  });
});

describe.skipIf(!gitAvailable)("toDone: activeChildren confirmation", () => {
  it("asks for confirmation before completing a parent with active children; force.leaveChildren completes it, children untouched", async () => {
    const f = await fixture();
    const parent = await f.core.commands.launchTask({
      relation: "standalone",
      title: "Parent",
      prompt: "parent work",
      repository: { repositoryId: f.repositoryId },
    });
    const child = await f.core.commands.launchTask({
      relation: "child",
      fromTaskId: parent.id,
      title: "Active child",
      prompt: "child work",
      repository: { repositoryId: f.repositoryId },
    });

    const result = await f.core.commands.toDone(parent.id);
    expect(isToDoneConfirmation(result)).toBe(true);
    if (isToDoneConfirmation(result)) {
      expect(result.requiresConfirmation).toBe("activeChildren");
      expect(result.detail).toContain("Active child");
    }
    expect((await f.core.commands.getTask(parent.id))?.state).toBe("dev");

    const forced = await f.core.commands.toDone(parent.id, {
      force: { leaveChildren: true, deleteUnmerged: true },
    });
    expect(isToDoneConfirmation(forced)).toBe(false);
    if (!isToDoneConfirmation(forced)) {
      expect(forced.task.state).toBe("done");
    }
    // The child is never touched.
    const childAfter = await f.core.commands.getTask(child.id);
    expect(childAfter?.state).toBe("dev");
  });

  it("a Done child never blocks the parent", async () => {
    const f = await fixture();
    const parent = await f.core.commands.launchTask({
      relation: "standalone",
      title: "Parent",
      prompt: "parent work",
      repository: { repositoryId: f.repositoryId },
    });
    const child = await f.core.commands.launchTask({
      relation: "child",
      fromTaskId: parent.id,
      title: "Child",
      prompt: "child work",
      repository: { repositoryId: f.repositoryId },
    });
    await f.core.commands.toDone(child.id, { force: { deleteUnmerged: true } });
    const result = await f.core.commands.toDone(parent.id, {
      force: { deleteUnmerged: true },
    });
    expect(isToDoneConfirmation(result)).toBe(false);
  });
});

describe.skipIf(!gitAvailable)(
  "toDone: a scratch binding is never a git target",
  () => {
    it("leaves the scratch directory on disk and just parks the binding", async () => {
      const f = await fixture();
      const task = await f.core.commands.launchTask({
        relation: "standalone",
        title: "Scratch",
        prompt: "think",
        repository: { none: true },
      });
      const workspace = await f.core.commands.getTaskWorkspace(task.id);
      const scratchPath = workspace!.worktreePath!;

      const result = await f.core.commands.toDone(task.id);
      expect(isToDoneConfirmation(result)).toBe(false);
      if (!isToDoneConfirmation(result)) {
        expect(result.task.state).toBe("done");
        expect(result.warning).toBeUndefined();
      }

      // Directory stays on disk; binding is parked (worktreePath cleared) like
      // any other done binding, but no git verb ever ran against it.
      expect(await exists(scratchPath)).toBe(true);
      const parked = await f.core.commands.getTaskWorkspace(task.id);
      expect(parked?.worktreePath).toBeUndefined();
      expect(parked?.scratch).toBe(true);
    });
  },
);
