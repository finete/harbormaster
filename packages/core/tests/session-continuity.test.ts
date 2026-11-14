// Session continuity + Done-task reopen (pi-home parity): the workspace
// binding pre-assigns the harness session id on first launch
// (`claimSessionLaunch`), records the session file the harness reports
// (`recordTaskSession`), survives `toDone` (parked, worktree cleared), and
// `reopenTask` starts a new cycle (fresh branch + worktree, previous
// conversation forked into the new session) with full rollback. Real temp
// git repos, fake session files; GitHub is never touched.

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
import type {
  Clock,
  TaskStateAccess,
  WorkspaceBindingAccess,
} from "../src/contracts/index.js";
import {
  CoreEventBus,
  CoreManager,
  isToDoneConfirmation,
  JsonConfigAccess,
  JsonTaskStateAccess,
  JsonWorkspaceBindingAccess,
  LocalGitRepositoryAccess,
  LocalGitWorktreeAccess,
  LocalScratchWorkspaceAccess,
  LocalSessionFileAccess,
  resolveStatePaths,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
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
  now(): Date {
    return new Date("2026-01-01T00:00:00.000Z");
  }
}

const noGithub = {
  status: async () => undefined,
  ensureOpen: async () => {
    throw new Error("unused");
  },
  squashMerge: async () => {
    throw new Error("unused");
  },
  containsCommit: async () => false,
  commitLog: async () => [],
  fetchText: async () => "",
} as unknown as PullRequestAccess & VersionAccess;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface Fixture {
  root: string;
  checkout: string;
  repositoryId: string;
  manager: CoreManager;
  /** Seed bindings states no command produces (pi-home imports). */
  bindings: WorkspaceBindingAccess;
  /** Arm a one-shot failure on a bindings/tasks verb (rollback tests). */
  failNext: (verb: "replaceBinding" | "attachBinding" | "replaceTask") => void;
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harbormaster-session-")),
  );
  roots.push(root);
  const stateDir = join(root, "state");
  const codeRoot = join(root, "Code");
  const checkout = join(codeRoot, "repo");
  await mkdir(stateDir, { recursive: true });
  await mkdir(codeRoot, { recursive: true });
  await git(["init", "-q", "-b", "main", checkout]);
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
      "--allow-empty",
      "-m",
      "init",
    ],
    checkout,
  );
  await git(
    ["remote", "add", "origin", "https://github.com/acme/repo.git"],
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

  const paths = resolveStatePaths(stateDir);
  const armed = new Set<string>();
  const failing = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (typeof prop === "string" && armed.delete(prop)) {
            return Promise.reject(new Error(`${prop} unavailable`));
          }
          return value.apply(obj, args);
        };
      },
    });
  const bindings: WorkspaceBindingAccess = failing(
    new JsonWorkspaceBindingAccess(
      paths.workspaceBindingsFile,
      paths.workspaceBindingsLockFile,
    ),
  );
  const tasks: TaskStateAccess = failing(
    new JsonTaskStateAccess(paths.tasksFile, paths.tasksLockFile),
  );
  let counter = 0;
  const manager = new CoreManager({
    tasks,
    clock: new FixedClock(),
    ids: { next: () => `${(++counter).toString().padStart(6, "0")}-id` },
    events: new CoreEventBus(),
    config: new JsonConfigAccess(paths.configFile),
    repositories: new LocalGitRepositoryAccess(),
    worktrees: new LocalGitWorktreeAccess(paths.worktreesDir),
    bindings,
    sessions: new LocalSessionFileAccess(),
    scratch: new LocalScratchWorkspaceAccess(join(stateDir, "scratch")),
    pullRequests: noGithub,
    versions: noGithub,
  });
  return {
    root,
    checkout,
    repositoryId: "github.com/acme/repo",
    manager,
    bindings,
    failNext: (verb) => armed.add(verb),
  };
}

async function fakeSessionFile(root: string, id: string): Promise<string> {
  const dir = join(root, "pi-sessions");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  await writeFile(
    file,
    `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
  );
  return file;
}

async function startedTask(f: Fixture, prompt = "Build it") {
  return f.manager.createTask({
    title: "Widget",
    initialPrompt: prompt,
    repositoryId: f.repositoryId,
    start: true,
  });
}

async function branches(checkout: string): Promise<string[]> {
  return (await git(["branch", "--format=%(refname:short)"], checkout))
    .split("\n")
    .filter(Boolean);
}

describe.skipIf(!gitAvailable)("claimSessionLaunch / recordTaskSession", () => {
  it("pre-assigns a session id on first launch and resumes it on every later launch", async () => {
    const f = await fixture();
    const task = await startedTask(f);

    const first = await f.manager.claimSessionLaunch(task.id);
    expect(first?.mode).toBe("new");
    const sessionId = first && "sessionId" in first ? first.sessionId : "";
    expect(sessionId).toBeTruthy();
    expect((await f.manager.getTaskWorkspace(task.id))?.sessionId).toBe(
      sessionId,
    );

    const second = await f.manager.claimSessionLaunch(task.id);
    expect(second).toEqual({ mode: "resume", sessionId });
    expect(await f.manager.claimSessionLaunch(task.id)).toEqual(second);
  });

  it("resumes by the recorded session file once the harness reported it (and it exists)", async () => {
    const f = await fixture();
    const task = await startedTask(f);
    const first = await f.manager.claimSessionLaunch(task.id);
    if (first?.mode !== "new") throw new Error("expected a new session");
    const file = await fakeSessionFile(f.root, first.sessionId);

    expect(
      await f.manager.recordTaskSession(task.id, {
        sessionId: first.sessionId,
        sessionPath: file,
      }),
    ).toBe(true);
    expect(await f.manager.claimSessionLaunch(task.id)).toEqual({
      mode: "resume",
      sessionId: first.sessionId,
      sessionPath: file,
    });

    // The file vanished: fall back to the id rather than a dead path.
    await rm(file);
    expect(await f.manager.claimSessionLaunch(task.id)).toEqual({
      mode: "resume",
      sessionId: first.sessionId,
    });
  });

  it("ignores a different session reported from the task's pane (binding stays authoritative)", async () => {
    const f = await fixture();
    const task = await startedTask(f);
    const first = await f.manager.claimSessionLaunch(task.id);
    if (first?.mode !== "new") throw new Error("expected a new session");

    expect(
      await f.manager.recordTaskSession(task.id, {
        sessionId: "someone-else",
        sessionPath: "/tmp/other.jsonl",
      }),
    ).toBe(false);
    expect(
      (await f.manager.getTaskWorkspace(task.id))?.sessionPath,
    ).toBeUndefined();
  });

  it("continues the most recent session for a legacy binding that already ran a pane, then adopts what the harness reports", async () => {
    const f = await fixture();
    const task = await startedTask(f);
    await f.manager.claimInitialPrompt(task.id); // a pre-binding launch happened

    expect(await f.manager.claimSessionLaunch(task.id)).toEqual({
      mode: "continue",
    });
    const file = await fakeSessionFile(f.root, "legacy-1");
    expect(
      await f.manager.recordTaskSession(task.id, {
        sessionId: "legacy-1",
        sessionPath: file,
      }),
    ).toBe(true);
    expect(await f.manager.claimSessionLaunch(task.id)).toEqual({
      mode: "resume",
      sessionId: "legacy-1",
      sessionPath: file,
    });
  });

  it("opens a recorded file core has no id for (a pi-home import) without replaying its prompt, then binds the id the harness reports", async () => {
    const f = await fixture();
    const task = await startedTask(f);
    const file = await fakeSessionFile(f.root, "imported-1");
    const binding = await f.manager.getTaskWorkspace(task.id);
    if (!binding) throw new Error("expected a binding");
    await f.bindings.replaceBinding({ ...binding, sessionPath: file });

    expect(await f.manager.claimSessionLaunch(task.id)).toEqual({
      mode: "open",
      sessionPath: file,
    });
    expect(await f.manager.claimInitialPrompt(task.id)).toBeUndefined();
    expect(
      await f.manager.recordTaskSession(task.id, {
        sessionId: "imported-1",
        sessionPath: file,
      }),
    ).toBe(true);
    expect(await f.manager.claimSessionLaunch(task.id)).toEqual({
      mode: "resume",
      sessionId: "imported-1",
      sessionPath: file,
    });
  });

  it("never pairs a fresh session id with a recorded file that is gone", async () => {
    const f = await fixture();
    const task = await startedTask(f);
    const binding = await f.manager.getTaskWorkspace(task.id);
    if (!binding) throw new Error("expected a binding");
    await f.bindings.replaceBinding({
      ...binding,
      sessionPath: join(f.root, "gone.jsonl"),
    });

    expect((await f.manager.claimSessionLaunch(task.id))?.mode).toBe("new");
    expect(
      (await f.manager.getTaskWorkspace(task.id))?.sessionPath,
    ).toBeUndefined();
  });

  it("heals a binding whose id was never written: the bound file reporting its own id wins", async () => {
    const f = await fixture();
    const task = await startedTask(f);
    const first = await f.manager.claimSessionLaunch(task.id);
    if (first?.mode !== "new") throw new Error("expected a new session");
    // The broken pre-fix state: a fresh id next to an imported file.
    const file = await fakeSessionFile(f.root, "real-1");
    const binding = await f.manager.getTaskWorkspace(task.id);
    if (!binding) throw new Error("expected a binding");
    await f.bindings.replaceBinding({ ...binding, sessionPath: file });

    expect(
      await f.manager.recordTaskSession(task.id, {
        sessionId: "real-1",
        sessionPath: file,
      }),
    ).toBe(true);
    expect(await f.manager.claimSessionLaunch(task.id)).toEqual({
      mode: "resume",
      sessionId: "real-1",
      sessionPath: file,
    });
  });

  it("returns undefined for a task without a live workspace (parked); a started scratch task gets a new session", async () => {
    const f = await fixture();
    const parked = await f.manager.createTask({
      title: "Parked",
      initialPrompt: "",
    });
    expect(await f.manager.claimSessionLaunch(parked.id)).toBeUndefined();
    const scratch = await f.manager.createTask({
      title: "Scratch",
      initialPrompt: "",
      start: true,
    });
    expect((await f.manager.claimSessionLaunch(scratch.id))?.mode).toBe("new");
  });
});

describe.skipIf(!gitAvailable)("toDone keeps the session identity", () => {
  it("parks the binding (worktree cleared) instead of deleting it", async () => {
    const f = await fixture();
    const task = await startedTask(f);
    const launch = await f.manager.claimSessionLaunch(task.id);
    if (launch?.mode !== "new") throw new Error("expected a new session");
    const file = await fakeSessionFile(f.root, launch.sessionId);
    await f.manager.recordTaskSession(task.id, {
      sessionId: launch.sessionId,
      sessionPath: file,
    });

    // No PR ever merged: the user confirmed the one "Mark done?" question.
    const result = await f.manager.toDone(task.id, {
      force: { confirmed: true },
    });
    expect(result).not.toHaveProperty("requiresConfirmation");
    expect(result).not.toHaveProperty("warning");
    const binding = await f.manager.getTaskWorkspace(task.id);
    expect(binding?.worktreePath).toBeUndefined();
    expect(binding?.sessionId).toBe(launch.sessionId);
    expect(binding?.sessionPath).toBe(file);
    expect(await f.manager.claimSessionLaunch(task.id)).toBeUndefined();
  });
});

describe.skipIf(!gitAvailable)("reopenTask", () => {
  async function doneTaskWithSession(f: Fixture) {
    const task = await startedTask(f);
    const oldWorktree = (await f.manager.getTaskWorkspace(task.id))
      ?.worktreePath;
    const launch = await f.manager.claimSessionLaunch(task.id);
    if (launch?.mode !== "new" || !oldWorktree)
      throw new Error("expected a new session");
    const file = await fakeSessionFile(f.root, launch.sessionId);
    await f.manager.recordTaskSession(task.id, {
      sessionId: launch.sessionId,
      sessionPath: file,
    });
    await f.manager.claimInitialPrompt(task.id);
    const result = await f.manager.toDone(task.id, {
      force: { confirmed: true },
    });
    if (isToDoneConfirmation(result)) throw new Error("unexpected question");
    const done = result.task;
    expect(await exists(oldWorktree)).toBe(false);
    return { done, file, oldWorktree, oldSessionId: launch.sessionId };
  }

  it("starts a new cycle: fresh branch + worktree in Dev, forking the previous conversation exactly once", async () => {
    const f = await fixture();
    const { done, file, oldSessionId } = await doneTaskWithSession(f);

    const result = await f.manager.reopenTask(done.id, {
      objective: "  Now add tests  ",
    });
    expect(result.warning).toBeUndefined();
    expect(result.task.state).toBe("dev");
    expect(result.task.completedAt).toBeUndefined();
    expect(result.task.branch).not.toBe(done.branch);
    expect(result.task.initialPrompt).toBe("Now add tests");
    expect(result.task.initialPromptDeliveredAt).toBeUndefined();

    const binding = await f.manager.getTaskWorkspace(done.id);
    expect(binding?.branch).toBe(result.task.branch);
    expect(binding?.worktreePath && (await exists(binding.worktreePath))).toBe(
      true,
    );
    expect(binding?.previousSessionPath).toBe(file);
    expect(binding?.sessionId).toBeTruthy();
    expect(binding?.sessionId).not.toBe(oldSessionId);
    expect(await git(["branch", "--show-current"], binding?.worktreePath)).toBe(
      result.task.branch,
    );

    const launch = await f.manager.claimSessionLaunch(done.id);
    expect(launch?.mode).toBe("fork");
    if (launch?.mode !== "fork") return;
    expect(launch.forkFrom).toBe(file);
    expect(launch.sessionId).not.toBe(oldSessionId);
    // The objective is delivered once, with that fork launch.
    expect(await f.manager.claimInitialPrompt(done.id)).toBe("Now add tests");
    // Later launches resume the forked session, never fork again.
    expect(await f.manager.claimSessionLaunch(done.id)).toEqual({
      mode: "resume",
      sessionId: launch.sessionId,
    });
  });

  it("with no objective, never replays the old prompt", async () => {
    const f = await fixture();
    const { done } = await doneTaskWithSession(f);
    const result = await f.manager.reopenTask(done.id);
    expect(result.task.initialPromptDeliveredAt).toBeTruthy();
    expect(await f.manager.claimInitialPrompt(done.id)).toBeUndefined();
  });

  it("warns (never fails) and starts a fresh session when the previous conversation file is gone", async () => {
    const f = await fixture();
    const { done, file } = await doneTaskWithSession(f);
    await rm(file);
    const result = await f.manager.reopenTask(done.id);
    expect(result.task.state).toBe("dev");
    expect(result.warning).toMatch(/previous conversation not found/);
    // A fresh session under the new cycle's pre-assigned id.
    const launch = await f.manager.claimSessionLaunch(done.id);
    expect(launch?.mode).toBe("resume");
    expect(launch && "sessionPath" in launch).toBe(false);
  });

  it("reuses a worktree that cleanup left in place, keeping its session", async () => {
    const f = await fixture();
    const task = await startedTask(f);
    const before = await f.manager.getTaskWorkspace(task.id);
    const launch = await f.manager.claimSessionLaunch(task.id);
    if (!before?.worktreePath || launch?.mode !== "new")
      throw new Error("expected a bound task");
    await writeFile(join(before.worktreePath, "dirty.txt"), "wip\n");
    // A pane still live after the confirm keeps the worktree for the sweep
    // (no warning); reopening first takes it over and stops the cleanup.
    const done = await f.manager.toDone(task.id, {
      force: { confirmed: true },
      protectedPaths: [before.worktreePath],
    });
    expect(done).not.toHaveProperty("warning");

    const result = await f.manager.reopenTask(task.id);
    expect(result.task.state).toBe("dev");
    expect(result.task.branch).toBe(task.branch);
    const after = await f.manager.getTaskWorkspace(task.id);
    expect(after?.worktreePath).toBe(before.worktreePath);
    expect(await f.manager.claimSessionLaunch(task.id)).toEqual({
      mode: "resume",
      sessionId: launch.sessionId,
    });
  });

  it("rolls back completely when the task write fails: no branch, worktree, or binding change survives", async () => {
    const f = await fixture();
    const { done } = await doneTaskWithSession(f);
    const bindingBefore = await f.manager.getTaskWorkspace(done.id);
    const branchesBefore = await branches(f.checkout);

    f.failNext("replaceTask");
    await expect(f.manager.reopenTask(done.id)).rejects.toThrow(
      "replaceTask unavailable",
    );

    expect((await f.manager.getTask(done.id))?.state).toBe("done");
    expect(await f.manager.getTaskWorkspace(done.id)).toEqual(bindingBefore);
    expect(await branches(f.checkout)).toEqual(branchesBefore);
    expect(
      (await git(["worktree", "list", "--porcelain"], f.checkout)).match(
        /^worktree /gm,
      ),
    ).toHaveLength(1);
  });

  it("rolls back the new worktree + branch when the binding write fails", async () => {
    const f = await fixture();
    const { done } = await doneTaskWithSession(f);
    const branchesBefore = await branches(f.checkout);

    f.failNext("replaceBinding");
    await expect(f.manager.reopenTask(done.id)).rejects.toThrow(
      "replaceBinding unavailable",
    );
    expect((await f.manager.getTask(done.id))?.state).toBe("done");
    expect(await branches(f.checkout)).toEqual(branchesBefore);
  });

  it("rejects tasks that are not done", async () => {
    const f = await fixture();
    const task = await startedTask(f);
    await expect(f.manager.reopenTask(task.id)).rejects.toThrow(/done task/);
  });

  it("reopens a scratch task straight into Dev", async () => {
    const f = await fixture();
    const scratch = await f.manager.createTask({
      title: "Scratch",
      initialPrompt: "",
      start: true,
    });
    await f.manager.toDone(scratch.id, { force: { confirmed: true } });
    const result = await f.manager.reopenTask(scratch.id, {
      objective: "Again",
    });
    expect(result.task.state).toBe("dev");
    expect(result.task.initialPrompt).toBe("Again");
  });
});

describe.skipIf(!gitAvailable)(
  "claimSessionLaunch: launched-task model + interrupted clearing",
  () => {
    it("passes the launch's model through on the first launch only", async () => {
      const f = await fixture();
      const task = await f.manager.launchTask({
        relation: "standalone",
        title: "Modeled",
        prompt: "do it",
        repository: { repositoryId: f.repositoryId },
        model: "anthropic/claude-opus",
      });

      const first = await f.manager.claimSessionLaunch(task.id);
      expect(first).toMatchObject({
        mode: "new",
        model: "anthropic/claude-opus",
      });

      // A later relaunch (resume) never carries the model again.
      const second = await f.manager.claimSessionLaunch(task.id);
      expect(second?.mode).toBe("resume");
      expect(second).not.toHaveProperty("model");
    });

    it("falls back to the configured default model when the launch has none", async () => {
      const f = await fixture();
      await writeFile(
        join(f.root, "state", "config.json"),
        JSON.stringify({
          automation: false,
          movers: [],
          codeRoot: join(f.root, "Code"),
          branchPrefix: "",
          launch: { defaultModel: "openai/gpt" },
        }),
      );
      const task = await f.manager.launchTask({
        relation: "standalone",
        title: "Defaulted",
        prompt: "do it",
        repository: { repositoryId: f.repositoryId },
      });
      const first = await f.manager.claimSessionLaunch(task.id);
      expect(first).toMatchObject({ mode: "new", model: "openai/gpt" });
    });

    it("passes no model when neither the task nor the config sets one", async () => {
      const f = await fixture();
      const task = await startedTask(f);
      const first = await f.manager.claimSessionLaunch(task.id);
      expect(first?.mode).toBe("new");
      expect(first).not.toHaveProperty("model");
    });

    it("clears an interrupted marker back to started on the next session launch", async () => {
      const f = await fixture();
      const task = await f.manager.launchTask({
        relation: "standalone",
        title: "Interrupted",
        prompt: "do it",
        repository: { repositoryId: f.repositoryId },
      });
      await f.manager.claimPendingLaunches(1);
      await f.manager.markLaunchesInterrupted([task.id]);
      expect((await f.manager.getTask(task.id))?.launch?.status).toBe(
        "interrupted",
      );

      await f.manager.claimSessionLaunch(task.id);

      const after = await f.manager.getTask(task.id);
      expect(after?.launch?.status).toBe("started");
      expect(after?.launch?.interruptedAt).toBeUndefined();
    });
  },
);
