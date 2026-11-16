// Plannotator review integration (docs/plannotator.md), core side: the
// adapters' review commands and URL-handler env, `openTaskUrl`'s loopback
// rule, `requestReview`'s default target and delivery, `reviewSupport` with
// faked probes, `captureAgentBrowser`, the `agent` / `worktree.dirty` rules
// facts and their events, and `getTaskWorkspace`'s `dirty`.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { JsonTaskStateAccess } from "../src/access/json-task-state-access.js";
import type { TaskUrlOpenedPayload } from "../src/contracts/events.js";
import type { PullRequestAccess } from "../src/contracts/github.js";
import type { BuildLaunchSpecInput } from "../src/contracts/harness.js";
import type { Task } from "../src/contracts/model.js";
import type { RuleTaskView, SourceContext } from "../src/contracts/rules.js";
import type {
  PresenceAccess,
  ReviewSupportProbeAccess,
} from "../src/contracts/services.js";
import {
  claudePluginVersion,
  compareSemver,
  loopbackUrl,
  piExtensionVersion,
} from "../src/engines/review-support.js";
import { diffSnapshots } from "../src/engines/rules/snapshot-diff.js";
import { toRuleTaskView } from "../src/engines/rules/views.js";
import { harbormasterSource } from "../src/engines/sources/harbormaster-source.js";
import { templateReviewCommand } from "../src/harness/adapter-common.js";
import { ClaudeCodeHarnessAdapter } from "../src/harness/claude-code-adapter.js";
import { CustomHarnessAdapter } from "../src/harness/custom-adapter.js";
import { PiHarnessAdapter } from "../src/harness/pi-adapter.js";
import { createCore } from "../src/index.js";
import { buildInboxMessageText } from "../src/tools/inbox-format.js";

const run = promisify(execFile);

const noPresence = new Proxy({} as PresenceAccess, {
  get: (_target, key) =>
    key === "read" ? async () => undefined : async () => {},
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const PR_URL = "https://github.com/acme/widgets/pull/42";
const HANDLER =
  "/Applications/Harbormaster.app/Contents/Resources/bin/harbormaster-open-url";

describe("adapter review commands", () => {
  it("Pi and Claude Code send /plannotator-review, with the PR URL for a PR", () => {
    for (const adapter of [
      new PiHarnessAdapter({ presence: noPresence }),
      new ClaudeCodeHarnessAdapter({ presence: noPresence }),
    ]) {
      expect(adapter.review.command({ kind: "local" })).toBe(
        "/plannotator-review",
      );
      expect(adapter.review.command({ kind: "pr", url: PR_URL })).toBe(
        `/plannotator-review ${PR_URL}`,
      );
    }
  });

  it("a custom agent reviews only when its config declares reviewCommand", () => {
    const plain = new CustomHarnessAdapter(
      { id: "aider", label: "Aider", command: "aider" },
      { presence: noPresence },
    );
    expect(plain.review).toBeUndefined();
    const codex = new CustomHarnessAdapter(
      {
        id: "codex",
        label: "Codex",
        command: "codex",
        reviewCommand: "!plannotator review {target}",
      },
      { presence: noPresence },
    );
    expect(codex.review?.command({ kind: "local" })).toBe(
      "!plannotator review",
    );
    expect(codex.review?.command({ kind: "pr", url: PR_URL })).toBe(
      `!plannotator review ${PR_URL}`,
    );
    expect(templateReviewCommand("/review", { kind: "pr", url: PR_URL })).toBe(
      `/review ${PR_URL}`,
    );
  });
});

describe("launch env: PLANNOTATOR_BROWSER / BROWSER", () => {
  const base: BuildLaunchSpecInput = {
    taskId: "t1",
    workspacePath: "/w/t1",
    stateDir: "/state",
  };
  const adapters = [
    new PiHarnessAdapter({ presence: noPresence }),
    new ClaudeCodeHarnessAdapter({
      presence: noPresence,
      transcripts: { exists: () => true },
    }),
    new CustomHarnessAdapter(
      { id: "x", label: "X", command: "x" },
      { presence: noPresence },
    ),
  ];

  it("exports nothing without a handler", () => {
    for (const adapter of adapters) {
      const env = adapter.buildLaunchSpec({
        ...base,
        captureBrowser: true,
      }).env;
      expect(env.PLANNOTATOR_BROWSER).toBeUndefined();
      expect(env.BROWSER).toBeUndefined();
    }
  });

  it("exports PLANNOTATOR_BROWSER always and BROWSER only with captureBrowser", () => {
    for (const adapter of adapters) {
      const off = adapter.buildLaunchSpec({
        ...base,
        openUrlHandler: HANDLER,
      }).env;
      expect(off.PLANNOTATOR_BROWSER).toBe(HANDLER);
      expect(off.BROWSER).toBeUndefined();
      const on = adapter.buildLaunchSpec({
        ...base,
        openUrlHandler: HANDLER,
        captureBrowser: true,
      }).env;
      expect(on.PLANNOTATOR_BROWSER).toBe(HANDLER);
      expect(on.BROWSER).toBe(HANDLER);
    }
  });
});

describe("review-support parsing", () => {
  it("compares semvers numerically and reads the Pi manifest and the Claude plugin list", () => {
    expect(compareSemver("0.28.10", "0.28.9")).toBeGreaterThan(0);
    expect(compareSemver("2.1.287", "2.1.287")).toBe(0);
    expect(compareSemver("2.1.99", "2.1.287")).toBeLessThan(0);
    expect(piExtensionVersion('{"version":"0.28.35"}')).toBe("0.28.35");
    expect(piExtensionVersion("nope")).toBeUndefined();
    expect(
      claudePluginVersion(
        JSON.stringify([
          { id: "other@x", version: "9.9.9", enabled: true },
          { id: "plannotator@plannotator", version: "0.28.60", enabled: true },
        ]),
      ),
    ).toBe("0.28.60");
    expect(
      claudePluginVersion(
        "Installed plugins:\n\n  ❯ caveman@caveman\n    Version: 1.0.0\n\n  ❯ plannotator@plannotator\n    Version: 0.28.52\n    Scope: user\n",
      ),
    ).toBe("0.28.52");
    expect(claudePluginVersion("[]")).toBeUndefined();
  });

  it("accepts only http(s) loopback URLs", () => {
    expect(loopbackUrl("http://127.0.0.1:19432/review")).toBe(
      "http://127.0.0.1:19432/review",
    );
    expect(loopbackUrl("http://localhost:3000")).toBe("http://localhost:3000/");
    expect(loopbackUrl("https://[::1]:8443/x")).toBe("https://[::1]:8443/x");
    for (const bad of [
      "https://example.com",
      "http://127.0.0.2:80",
      "http://localhost.evil.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "http://user:pw@localhost/",
      "not a url",
    ]) {
      expect(loopbackUrl(bad)).toBeUndefined();
    }
  });
});

const noGithub = new Proxy({} as PullRequestAccess, {
  get: () => () => {
    throw new Error("GitHub access must not be used in these tests");
  },
});

class FakeProbes implements ReviewSupportProbeAccess {
  calls = 0;
  constructor(
    public binary?: string,
    public pi?: string,
    public plugin?: string,
    public claude?: string,
  ) {}
  async plannotatorVersion() {
    this.calls++;
    return this.binary;
  }
  async piExtensionManifest() {
    return this.pi ? JSON.stringify({ version: this.pi }) : undefined;
  }
  async claudePluginList() {
    return this.plugin
      ? JSON.stringify([
          {
            id: "plannotator@plannotator",
            version: this.plugin,
            enabled: true,
          },
        ])
      : undefined;
  }
  async claudeVersion() {
    return this.claude ? `${this.claude} (Claude Code)` : undefined;
  }
}

async function boot(
  options: {
    config?: Record<string, unknown>;
    probes?: ReviewSupportProbeAccess;
    openUrlHandler?: string;
    clock?: { now(): Date };
  } = {},
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harbormaster-plannotator-")),
  );
  roots.push(root);
  const stateDir = join(root, "state");
  await mkdir(join(root, "Code"), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, "config.json"),
    JSON.stringify({
      automation: false,
      codeRoot: join(root, "Code"),
      branchPrefix: "",
      ...options.config,
    }),
  );
  let n = 0;
  const core = createCore({
    stateDir,
    ids: { next: () => `id-${++n}` },
    pullRequests: noGithub,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.probes ? { reviewProbes: options.probes } : {}),
    ...(options.openUrlHandler
      ? { openUrlHandler: options.openUrlHandler }
      : {}),
  });
  return { core, root, stateDir };
}

describe("openTaskUrl", () => {
  it("emits task-url-opened for a loopback URL (source defaults to browser) and rejects anything else", async () => {
    const { core } = await boot();
    const task = await core.commands.createTask({
      title: "T",
      initialPrompt: "",
      start: true,
    });
    const seen: TaskUrlOpenedPayload[] = [];
    core.events.on("task-url-opened", (payload) => seen.push(payload));

    await core.commands.openTaskUrl({
      taskId: task.id,
      url: "http://127.0.0.1:5173/",
    });
    await core.commands.openTaskUrl({
      taskId: task.id,
      url: "http://localhost:19432/review",
      source: "plannotator",
    });
    await expect(
      core.commands.openTaskUrl({
        taskId: task.id,
        url: "https://github.com/acme/widgets/pull/42",
      }),
    ).rejects.toThrow(/127\.0\.0\.1, localhost or \[::1\]/);
    await expect(
      core.commands.openTaskUrl({ taskId: "nope", url: "http://localhost/" }),
    ).rejects.toThrow(/Task not found/);
    expect(seen).toEqual([
      { taskId: task.id, url: "http://127.0.0.1:5173/", source: "browser" },
      {
        taskId: task.id,
        url: "http://localhost:19432/review",
        source: "plannotator",
      },
    ]);
  });
});

describe("requestReview", () => {
  it("defaults to the PR when the task has one, else local; delivers a user steer", async () => {
    const { core, stateDir } = await boot();
    const local = await core.commands.createTask({
      title: "Local",
      initialPrompt: "",
      start: true,
    });
    const withPr = await core.commands.createTask({
      title: "With PR",
      initialPrompt: "",
      start: true,
    });
    await new JsonTaskStateAccess(join(stateDir, "tasks.json")).patchTask(
      withPr.id,
      (task): Task => ({
        ...task,
        pr: { number: 42, url: PR_URL, state: "open" },
      }),
    );

    expect(await core.commands.requestReview({ taskId: local.id })).toEqual({
      command: "/plannotator-review",
      delivered: "message",
      messageId: expect.any(String),
    });
    expect(
      await core.commands.requestReview({ taskId: withPr.id }),
    ).toMatchObject({
      command: `/plannotator-review ${PR_URL}`,
      delivered: "message",
    });
    expect(
      await core.commands.requestReview({ taskId: withPr.id, target: "local" }),
    ).toMatchObject({ command: "/plannotator-review", delivered: "message" });
    await expect(
      core.commands.requestReview({ taskId: local.id, target: "pr" }),
    ).rejects.toThrow(/no pull request/);

    const messages = await core.commands.listMessages({ taskId: local.id });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      sender: { kind: "user" },
      senderLabel: "You",
      route: "user",
      status: "pending",
      requestedMode: "steer",
      text: "/plannotator-review",
    });
    // Delivered as the user's own words: no "not from the user" trust line.
    const claimed = await core.commands.claimInboxMessages(local.id, {
      idle: true,
    });
    expect(claimed.map(buildInboxMessageText)).toEqual([
      "[Message from the user]\n\n/plannotator-review",
    ]);
  });

  it("deliver none returns the command and records nothing (the app types it)", async () => {
    const { core } = await boot();
    const task = await core.commands.createTask({
      title: "Typed",
      initialPrompt: "",
      start: true,
    });
    expect(
      await core.commands.requestReview({ taskId: task.id, deliver: "none" }),
    ).toEqual({ command: "/plannotator-review", delivered: "none" });
    expect(await core.commands.listMessages({ taskId: task.id })).toEqual([]);
  });

  it("claims only the given message ids (a queued Review the app types)", async () => {
    const { core } = await boot();
    const task = await core.commands.createTask({
      title: "Queued",
      initialPrompt: "",
      start: true,
    });
    await core.commands.sendTaskMessage({
      from: { kind: "user" },
      targetTaskId: task.id,
      text: "something else",
      mode: "steer",
    });
    const review = await core.commands.requestReview({ taskId: task.id });
    const claimed = await core.commands.claimInboxMessages(task.id, {
      idle: true,
      messageIds: [review.messageId ?? ""],
    });
    expect(claimed.map((message) => message.text)).toEqual([
      "/plannotator-review",
    ]);
    // Claimed once: a second claim (the agent's own) gets only the other one.
    const rest = await core.commands.claimInboxMessages(task.id, {
      idle: true,
    });
    expect(rest.map((message) => message.text)).toEqual(["something else"]);
  });

  it("rejects a harness without a review capability", async () => {
    const { core } = await boot({
      config: {
        agents: { custom: [{ id: "aider", label: "Aider", command: "aider" }] },
      },
    });
    const task = await core.commands.createTask({
      title: "Aider task",
      initialPrompt: "",
      start: true,
      harness: "aider",
    });
    await expect(
      core.commands.requestReview({ taskId: task.id }),
    ).rejects.toThrow(/Aider can't start a code review/);
  });
});

describe("reviewSupport", () => {
  it("reports missing pieces with install commands, and unsupported harnesses", async () => {
    const { core } = await boot({
      probes: new FakeProbes(),
      config: {
        agents: { custom: [{ id: "aider", label: "Aider", command: "aider" }] },
      },
    });
    const support = await core.commands.reviewSupport();
    const pi = support.harnesses.find((h) => h.harness === "pi");
    expect(pi).toEqual({
      harness: "pi",
      state: "missing",
      pieces: [
        expect.objectContaining({
          id: "pi-extension",
          state: "missing",
          minimum: "0.28.0",
          fix: "pi install npm:@plannotator/pi-extension",
        }),
      ],
    });
    const claude = support.harnesses.find((h) => h.harness === "claude-code");
    expect(claude?.state).toBe("missing");
    expect(claude?.pieces.map((piece) => [piece.id, piece.fix])).toEqual([
      ["binary", "curl -fsSL https://plannotator.ai/install.sh | bash"],
      [
        "claude-plugin",
        "claude plugin marketplace add backnotprop/plannotator && claude plugin install plannotator@plannotator",
      ],
      ["claude-code", expect.any(String)],
    ]);
    expect(support.harnesses.find((h) => h.harness === "aider")).toEqual({
      harness: "aider",
      state: "unsupported",
      pieces: [],
    });
  });

  it("outdated pieces get upgrade commands; the worst piece decides; Claude Code needs 2.1.287", async () => {
    const probes = new FakeProbes("0.28.1", "0.27.15", "0.28.52", "2.1.286");
    const { core } = await boot({ probes });
    const support = await core.commands.reviewSupport();
    const pi = support.harnesses.find((h) => h.harness === "pi");
    expect(pi?.state).toBe("outdated");
    expect(pi?.pieces[0]).toMatchObject({
      installed: "0.27.15",
      state: "outdated",
      fix: "pi update npm:@plannotator/pi-extension",
    });
    const claude = support.harnesses.find((h) => h.harness === "claude-code");
    expect(claude?.state).toBe("outdated");
    expect(
      claude?.pieces.map((piece) => [piece.id, piece.installed, piece.state]),
    ).toEqual([
      ["binary", "0.28.1", "ready"],
      ["claude-plugin", "0.28.52", "ready"],
      ["claude-code", "2.1.286", "outdated"],
    ]);

    // Cached for 60 s unless refreshed.
    probes.claude = "2.1.287";
    probes.pi = "0.28.0";
    const cached = await core.commands.reviewSupport();
    expect(probes.calls).toBe(1);
    expect(cached.checkedAt).toBe(support.checkedAt);
    const fresh = await core.commands.reviewSupport({ refresh: true });
    expect(probes.calls).toBe(2);
    expect(fresh.harnesses.map((h) => [h.harness, h.state])).toEqual([
      ["pi", "ready"],
      ["claude-code", "ready"],
    ]);
  });

  it("re-probes once the 60 s cache expires", async () => {
    let now = Date.parse("2026-11-14T10:00:00.000Z");
    const probes = new FakeProbes("0.28.0");
    const { core } = await boot({
      probes,
      clock: { now: () => new Date(now) },
    });
    await core.commands.reviewSupport();
    now += 59_000;
    await core.commands.reviewSupport();
    expect(probes.calls).toBe(1);
    now += 1_000;
    await core.commands.reviewSupport();
    expect(probes.calls).toBe(2);
  });
});

describe("captureAgentBrowser and the open-url handler", () => {
  it("defaults off, is switched by setCaptureAgentBrowser, and reaches getLaunchSettings with the handler", async () => {
    const { core } = await boot({ openUrlHandler: HANDLER });
    expect(await core.commands.getLaunchSettings()).toMatchObject({
      openUrlHandler: HANDLER,
      captureAgentBrowser: false,
    });
    await core.commands.setCaptureAgentBrowser(true);
    expect((await core.commands.getLaunchSettings()).captureAgentBrowser).toBe(
      true,
    );
    await core.commands.setCaptureAgentBrowser(false);
    expect((await core.commands.getLaunchSettings()).captureAgentBrowser).toBe(
      false,
    );
  });
});

describe("rules facts: agent and worktree.dirty", () => {
  const working = (id: string): RuleTaskView =>
    toRuleTaskView({
      id,
      kind: "task",
      state: "working",
      title: id,
      initialPrompt: "",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      stateChangedAt: "2026-01-01T00:00:00Z",
    });

  function context(
    tasks: RuleTaskView[],
    previous: SourceContext["previous"],
    live: {
      agent: (id: string) => Promise<string>;
      dirty: (id: string) => Promise<boolean | undefined>;
    },
  ): SourceContext {
    return {
      now: () => new Date(),
      tasks,
      repositories: [],
      settings: {},
      previous,
      cursor: undefined,
      setCursor: () => {},
      services: {
        github: {
          observed: () => undefined,
          containsCommit: async () => false,
          commitLog: async () => [],
        },
        http: { fetchText: async () => "" },
        tasks: { agent: live.agent, worktreeDirty: live.dirty },
      },
      warn: () => {},
    };
  }

  it("snapshots both facts and diffs them into agentChanged / worktree.dirtyChanged; unreadable keeps the last value", async () => {
    const tasks = [
      working("t1"),
      { ...working("t2"), state: "awaiting" as const },
    ];
    const first = await harbormasterSource.snapshot?.(
      context(tasks, [], {
        agent: async () => "working",
        dirty: async () => false,
      }),
    );
    expect(first?.[0]?.facts).toMatchObject({
      agent: "working",
      "worktree.dirty": false,
    });
    // Not Working: no dirty fact.
    expect(first?.[1]?.facts).toMatchObject({ "worktree.dirty": null });

    let ids = 0;
    const base = diffSnapshots("harbormaster", {}, first ?? [], "t", () =>
      String(++ids),
    );
    const second = await harbormasterSource.snapshot?.(
      context(
        tasks,
        Object.entries(base.subjects).map(([subject, entry]) => ({
          subject,
          entity: entry.entity,
          facts: entry.facts,
        })),
        {
          agent: async (id) => {
            if (id === "t2") throw new Error("presence unreadable");
            return "idle";
          },
          dirty: async () => true,
        },
      ),
    );
    const diff = diffSnapshots(
      "harbormaster",
      base.subjects,
      second ?? [],
      "t",
      () => String(++ids),
    );
    expect(
      diff.events.map((event) => [event.type, event.subject, event.data]),
    ).toEqual([
      [
        "harbormaster.task.agentChanged",
        "task/t1",
        { from: "working", to: "idle" },
      ],
      [
        "harbormaster.task.worktree.dirtyChanged",
        "task/t1",
        { from: false, to: true },
      ],
    ]);
  });

  it("flows through refresh: the agent fact follows presence", async () => {
    const { core } = await boot({
      config: { automation: true },
    });
    const task = await core.commands.createTask({
      title: "Scratch",
      initialPrompt: "",
      start: true,
    });
    await core.commands.reportPresence(task.id, {
      pid: process.pid,
      state: "idle",
    });
    await core.commands.refresh();
    await core.commands.reportPresence(task.id, {
      pid: process.pid,
      state: "working",
    });
    await core.commands.refresh();
    const changes = (await core.commands.listEvents({ taskId: task.id }))
      .flatMap((entry) => (entry.kind === "event" ? [entry.event] : []))
      .filter((event) => event.type === "harbormaster.task.agentChanged");
    expect(changes.map((event) => event.data)).toEqual([
      { from: "idle", to: "working" },
    ]);
  });
});

const gitAvailable = await run("git", ["--version"]).then(
  () => true,
  () => false,
);

describe.skipIf(!gitAvailable)("getTaskWorkspace dirty", () => {
  it("reports dirty for a git worktree", async () => {
    const { core, root } = await boot();
    const checkout = join(root, "Code", "widgets");
    await run("git", ["init", "-q", "-b", "main", checkout]);
    await run(
      "git",
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
      { cwd: checkout },
    );
    await run(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/widgets.git"],
      { cwd: checkout },
    );
    const task = await core.commands.createTask({
      title: "Dirty me",
      initialPrompt: "",
      start: true,
      repositoryId: "github.com/acme/widgets",
    });
    const clean = await core.commands.getTaskWorkspace(task.id);
    expect(clean?.dirty).toBe(false);
    await writeFile(join(clean?.worktreePath as string, "new.txt"), "x");
    expect((await core.commands.getTaskWorkspace(task.id))?.dirty).toBe(true);
  });

  it("listWorktreeStatus serves the refresh pass (no git per call), the same pass the rules' fact reads", async () => {
    const { core, root } = await boot({ config: { automation: true } });
    const checkout = join(root, "Code", "widgets");
    await run("git", ["init", "-q", "-b", "main", checkout]);
    await run(
      "git",
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
      { cwd: checkout },
    );
    await run(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/widgets.git"],
      { cwd: checkout },
    );
    const task = await core.commands.createTask({
      title: "Dirty me",
      initialPrompt: "",
      start: true,
      repositoryId: "github.com/acme/widgets",
    });
    const scratch = await core.commands.createTask({
      title: "No worktree",
      initialPrompt: "",
      start: true,
    });
    // Nothing until the first refresh.
    expect(await core.commands.listWorktreeStatus()).toEqual({});
    await core.commands.refresh();
    const first = await core.commands.listWorktreeStatus();
    expect(first[task.id]?.dirty).toBe(false);
    expect(first[scratch.id]).toBeUndefined();

    const worktree = (await core.commands.getTaskWorkspace(task.id))
      ?.worktreePath as string;
    await writeFile(join(worktree, "new.txt"), "x");
    // Served from the last pass: still clean until the next tick.
    expect((await core.commands.listWorktreeStatus())[task.id]?.dirty).toBe(
      false,
    );
    await core.commands.refresh();
    expect((await core.commands.listWorktreeStatus())[task.id]?.dirty).toBe(
      true,
    );
    const changes = (await core.commands.listEvents({ taskId: task.id }))
      .flatMap((entry) => (entry.kind === "event" ? [entry.event] : []))
      .filter(
        (event) => event.type === "harbormaster.task.worktree.dirtyChanged",
      );
    expect(changes.map((event) => event.data)).toEqual([
      { from: false, to: true },
    ]);
  });
});
