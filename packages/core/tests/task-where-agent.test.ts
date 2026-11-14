// Integration tests for the new-task composer's core surface (see
// /docs/new-task-composer.md): agent fields (harness/model/thinking) on
// createTask/launchTask and their first-launch hand-off, registered folders
// (git repo outside codeRoot -> worktree; plain folder -> in place), the
// createTask parent link, baseRef, pasted-image adoption, listBranches and
// listModels. Real temp git repos, same fixture pattern as
// tests/launch-task.test.ts; GitHub/HTTP access is stubbed.

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
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  PullRequestAccess,
  VersionAccess,
} from "../src/contracts/github.js";
import type { Clock } from "../src/contracts/index.js";
import { PiHarnessAdapter } from "../src/harness/pi-adapter.js";
import { type Core, createCore } from "../src/index.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

const COMMIT = [
  "-c",
  "user.name=Harbormaster Test",
  "-c",
  "user.email=harbormaster-test@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "-q",
  "--allow-empty",
];

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

async function initRepo(path: string, remote: string): Promise<void> {
  await git(["init", "-q", "-b", "main", path]);
  await git([...COMMIT, "-m", "init"], path);
  await git(["remote", "add", "origin", remote], path);
}

async function fixture(config: Record<string, unknown> = {}): Promise<{
  root: string;
  stateDir: string;
  checkout: string;
  repositoryId: string;
  core: Core;
}> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harbormaster-where-agent-")),
  );
  roots.push(root);
  const stateDir = join(root, "state");
  const codeRoot = join(root, "Code");
  const checkout = join(codeRoot, "harbor-repo");
  await mkdir(stateDir, { recursive: true });
  await initRepo(checkout, "git@github.com:acme/harbor-repo.git");
  await writeFile(
    join(stateDir, "config.json"),
    JSON.stringify({
      automation: false,
      movers: [],
      codeRoot,
      branchPrefix: "",
      ...config,
    }),
  );
  counter = 0;
  const core = createCore({
    stateDir,
    clock: new FixedClock(),
    ids: sequentialIds,
    pullRequests: noGithub,
    versions: noGithub,
    harness: new PiHarnessAdapter({
      stateDir,
      models: {
        defaults: async () => ({
          defaultModel: "anthropic/opus",
          defaultThinking: "medium",
        }),
        listModels: async () => ({
          models: [
            {
              id: "anthropic/opus",
              provider: "anthropic",
              name: "opus",
              thinking: true,
            },
          ],
          defaultModel: "anthropic/opus",
          defaultThinking: "medium",
        }),
      },
    }),
  });
  return {
    root,
    stateDir,
    checkout,
    repositoryId: "github.com/acme/harbor-repo",
    core,
  };
}

describe.skipIf(!gitAvailable)("agent fields", () => {
  it("stores harness/model/thinking and hands model + thinking to the first launch only", async () => {
    const f = await fixture();
    const task = await f.core.commands.createTask({
      title: "Modeled",
      initialPrompt: "",
      repositoryId: f.repositoryId,
      start: true,
      model: "anthropic/opus",
      thinking: "high",
    });
    expect(task).toMatchObject({
      harness: "pi",
      model: "anthropic/opus",
      thinking: "high",
    });

    const first = await f.core.commands.claimSessionLaunch(task.id);
    expect(first).toMatchObject({
      mode: "new",
      model: "anthropic/opus",
      thinking: "high",
    });
    const second = await f.core.commands.claimSessionLaunch(task.id);
    expect(second?.mode).toBe("resume");
    expect(second).not.toHaveProperty("model");
    expect(second).not.toHaveProperty("thinking");
  });

  it("records the harness default as the session model when nothing was chosen, without passing it", async () => {
    const f = await fixture();
    const task = await f.core.commands.createTask({
      title: "Plain",
      initialPrompt: "",
      start: true,
    });
    const first = await f.core.commands.claimSessionLaunch(task.id);
    expect(first).not.toHaveProperty("model");
    expect((await f.core.commands.getTask(task.id))?.sessionModel).toBe(
      "anthropic/opus",
    );
  });

  it("falls back to the configured default model for any task, not only launched ones", async () => {
    const f = await fixture({ launch: { defaultModel: "openai/gpt" } });
    const task = await f.core.commands.createTask({
      title: "Defaulted",
      initialPrompt: "",
      start: true,
    });
    expect(await f.core.commands.claimSessionLaunch(task.id)).toMatchObject({
      mode: "new",
      model: "openai/gpt",
    });
  });

  it("launchTask stores the agent fields on the task", async () => {
    const f = await fixture();
    const task = await f.core.commands.launchTask({
      relation: "standalone",
      title: "Launched",
      prompt: "go",
      repository: { none: true },
      model: "anthropic/opus",
      thinking: "low",
    });
    expect(task).toMatchObject({
      harness: "pi",
      model: "anthropic/opus",
      thinking: "low",
    });
  });

  it("listModels reports the harness catalog with the configured default winning", async () => {
    const f = await fixture({ launch: { defaultModel: "openai/gpt" } });
    const [catalog] = await f.core.commands.listModels();
    expect(catalog).toMatchObject({
      harness: "pi",
      label: "Pi",
      defaultModel: "openai/gpt",
      defaultThinking: "medium",
    });
    expect(catalog?.models.map((model) => model.id)).toEqual([
      "anthropic/opus",
    ]);
  });
});

describe.skipIf(!gitAvailable)("registered folders", () => {
  it("a plain folder runs in place, is registered, and survives Done", async () => {
    const f = await fixture();
    const folder = join(f.root, "notes");
    await mkdir(folder);
    await writeFile(join(folder, "todo.md"), "keep me");

    const task = await f.core.commands.createTask({
      title: "Notes",
      initialPrompt: "",
      folderPath: folder,
      start: true,
    });
    expect(task.kind).toBe("temp_task");
    expect(task.folderPath).toBe(folder);
    expect(task.repositoryId).toBeUndefined();
    const binding = await f.core.commands.getTaskWorkspace(task.id);
    expect(binding).toMatchObject({ worktreePath: folder, inPlace: true });

    expect(await f.core.commands.listLocations()).toEqual([
      { path: folder, name: "notes" },
    ]);
    expect(
      (await f.core.commands.listRepositories()).map((repo) => repo.id),
    ).toEqual([f.repositoryId]);

    await f.core.commands.toDone(task.id, { force: { confirmed: true } });
    expect(await readFile(join(folder, "todo.md"), "utf8")).toBe("keep me");
    const parked = await f.core.commands.getTaskWorkspace(task.id);
    expect(parked?.worktreePath).toBeUndefined();

    // Reopening points the binding back at the folder.
    await f.core.commands.reopenTask(task.id);
    expect(await f.core.commands.getTaskWorkspace(task.id)).toMatchObject({
      worktreePath: folder,
      inPlace: true,
    });
  });

  it("a parked folder task gets its in-place binding when started", async () => {
    const f = await fixture();
    const folder = join(f.root, "configs");
    await mkdir(folder);
    const task = await f.core.commands.createTask({
      title: "Later",
      initialPrompt: "",
      folderPath: folder,
    });
    expect(task.state).toBe("backlog");
    expect(await f.core.commands.getTaskWorkspace(task.id)).toBeUndefined();
    await f.core.commands.startTask(task.id);
    expect(await f.core.commands.getTaskWorkspace(task.id)).toMatchObject({
      worktreePath: folder,
      inPlace: true,
    });
  });

  it("a git folder outside codeRoot becomes a repository with its own worktree", async () => {
    const f = await fixture();
    const outside = join(f.root, "elsewhere", "side-repo");
    await mkdir(join(f.root, "elsewhere"));
    await initRepo(outside, "https://github.com/acme/side-repo.git");

    const location = await f.core.commands.addLocation(outside);
    expect(location).toEqual({
      path: outside,
      name: "side-repo",
      repositoryId: "github.com/acme/side-repo",
    });
    expect(
      (await f.core.commands.listRepositories()).map((repo) => repo.id),
    ).toEqual([f.repositoryId, "github.com/acme/side-repo"]);

    const task = await f.core.commands.launchTask({
      relation: "standalone",
      title: "Side work",
      prompt: "go",
      repository: { folderPath: outside },
    });
    expect(task.repositoryId).toBe("github.com/acme/side-repo");
    const binding = await f.core.commands.getTaskWorkspace(task.id);
    // Same app-owned worktrees root as code-root repos, never next to the
    // registered folder.
    expect(binding?.worktreePath).toBe(
      join(f.stateDir, "worktrees", "side-repo", task.branch ?? ""),
    );
    expect(
      await exists(join(f.root, "elsewhere", ".harbormaster-worktrees")),
    ).toBe(false);
    expect(binding?.inPlace).toBeUndefined();

    // A clone URL for a remote we already have checked out (here outside
    // codeRoot, ssh form) reuses that checkout instead of cloning again.
    const viaUrl = await f.core.commands.launchTask({
      relation: "standalone",
      title: "Side work by URL",
      prompt: "go",
      repository: { cloneUrl: "git@github.com:acme/side-repo.git" },
    });
    expect(viaUrl.repositoryId).toBe("github.com/acme/side-repo");
    expect(await exists(join(f.root, "Code", "side-repo"))).toBe(false);
  });

  it("chat mode (inPlace) runs in the repository's own checkout, never as a task worktree", async () => {
    const f = await fixture();
    const task = await f.core.commands.createTask({
      title: "Question",
      initialPrompt: "how does X work?",
      repositoryId: f.repositoryId,
      inPlace: true,
      baseRef: "ignored",
      start: true,
    });
    expect(task.repositoryId).toBeUndefined();
    expect(task.folderPath).toBe(f.checkout);
    expect(task.kind).toBe("temp_task");
    expect(task.baseRef).toBeUndefined();
    expect(task.branch).toBeUndefined();
    expect(await f.core.commands.getTaskWorkspace(task.id)).toMatchObject({
      worktreePath: f.checkout,
      inPlace: true,
    });
    // Not registered as a folder: the repository is already known.
    expect(await f.core.commands.listLocations()).toEqual([]);

    await f.core.commands.toDone(task.id, { force: { confirmed: true } });
    expect(await git(["branch", "--show-current"], f.checkout)).toBe("main");
    expect(await exists(f.checkout)).toBe(true);

    const launched = await f.core.commands.launchTask({
      relation: "standalone",
      title: "Background question",
      prompt: "look around",
      repository: { repositoryId: f.repositoryId },
      inPlace: true,
    });
    expect(launched.folderPath).toBe(f.checkout);
    expect(await f.core.commands.getTaskWorkspace(launched.id)).toMatchObject({
      worktreePath: f.checkout,
      inPlace: true,
    });
  });

  it("rejects a folder that does not exist", async () => {
    const f = await fixture();
    await expect(
      f.core.commands.addLocation(join(f.root, "missing")),
    ).rejects.toThrow(/Folder not found/);
  });
});

describe.skipIf(!gitAvailable)("createTask parent + baseRef", () => {
  it("nests under a parent and refuses a grandchild", async () => {
    const f = await fixture();
    const parent = await f.core.commands.createTask({
      title: "Parent",
      initialPrompt: "",
    });
    const child = await f.core.commands.createTask({
      title: "Child",
      initialPrompt: "",
      parentTaskId: parent.id,
    });
    expect(child.parentTaskId).toBe(parent.id);
    expect(child.initialPrompt).toBe("");
    await expect(
      f.core.commands.createTask({
        title: "Grandchild",
        initialPrompt: "",
        parentTaskId: child.id,
      }),
    ).rejects.toThrow(/one level only/);
  });

  it("a parked task branches off its baseRef when started", async () => {
    const f = await fixture();
    await git(["checkout", "-q", "-b", "feature"], f.checkout);
    await git([...COMMIT, "-m", "feature work"], f.checkout);
    const featureHead = await git(["rev-parse", "HEAD"], f.checkout);
    await git(["checkout", "-q", "main"], f.checkout);

    expect(await f.core.commands.listBranches(f.repositoryId)).toEqual(
      expect.arrayContaining(["main", "feature"]),
    );

    const task = await f.core.commands.createTask({
      title: "Stacked",
      initialPrompt: "",
      repositoryId: f.repositoryId,
      baseRef: "feature",
    });
    expect(task.baseRef).toBe("feature");
    await f.core.commands.startTask(task.id);
    const binding = await f.core.commands.getTaskWorkspace(task.id);
    const head = await git(["rev-parse", "HEAD"], binding?.worktreePath);
    expect(head).toBe(featureHead);
  });

  it("launchTask with a non-default baseRef states the dependency in the kickoff", async () => {
    const f = await fixture();
    await git(["branch", "feature"], f.checkout);
    const task = await f.core.commands.launchTask({
      relation: "standalone",
      title: "On feature",
      prompt: "go",
      repository: { repositoryId: f.repositoryId },
      baseRef: "feature",
    });
    expect(task.initialPrompt).toContain('based on "feature"');
  });
});

describe.skipIf(!gitAvailable)("pasted images", () => {
  it("copies attachments into the task's state dir and rewrites the prompt", async () => {
    const f = await fixture();
    const pasted = join(f.root, "clipboard-1.png");
    await writeFile(pasted, "png-bytes");
    const unused = join(f.root, "clipboard-2.png");
    await writeFile(unused, "png-bytes");

    const task = await f.core.commands.createTask({
      title: "Look",
      initialPrompt: `compare ${pasted} with the design`,
      attachments: [pasted, unused],
    });
    const copy = join(
      f.stateDir,
      "task-attachments",
      task.id,
      "clipboard-1.png",
    );
    expect(task.initialPrompt).toBe(`compare ${copy} with the design`);
    expect(await readFile(copy, "utf8")).toBe("png-bytes");
    // Removed from the prompt before submit: never copied.
    expect(
      await exists(
        join(f.stateDir, "task-attachments", task.id, "clipboard-2.png"),
      ),
    ).toBe(false);
  });
});
