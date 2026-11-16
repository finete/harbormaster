// Per-task token usage through the manager (docs/costs.md): snapshots on
// `recordTaskSession` / agent finished / `toDone`, no re-parse of an
// unchanged session, the refresh backfill (missing sessions marked
// `unavailable` exactly once, never retried), `refreshTaskUsage`,
// `listTaskUsage` (+ subtask roll-up, the `usage` op), and harnesses with
// no reader. Real JSON state files and session files in a temp dir; the
// harness is a fake that reads Pi-format files with the real Pi reader.

import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPiSessionUsage } from "../src/access/pi-session-usage-access.js";
import type {
  PullRequestAccess,
  VersionAccess,
} from "../src/contracts/github.js";
import type {
  ExpectedSessionFile,
  HarnessAdapter,
  HarnessModelCatalog,
  LaunchSpec,
  PresenceStatus,
} from "../src/contracts/harness.js";
import type { Clock, GitRepositoryAccess } from "../src/contracts/index.js";
import type { Task, WorkspaceBinding } from "../src/contracts/model.js";
import type { SessionUsage } from "../src/contracts/usage.js";
import {
  CoreEventBus,
  CoreManager,
  dispatchOpCall,
  JsonConfigAccess,
  JsonTaskStateAccess,
  JsonWorkspaceBindingAccess,
  LocalScratchWorkspaceAccess,
  LocalSessionFileAccess,
  SessionPresenceAccess,
} from "../src/index.js";

class TestClock implements Clock {
  private ms = Date.parse("2026-11-16T00:00:00.000Z");
  now(): Date {
    const current = new Date(this.ms);
    this.ms += 1000;
    return current;
  }
}

class UsageHarness implements HarnessAdapter {
  readonly id = "pi";
  readonly label = "Pi (fake)";
  readonly messaging = {
    receive: false,
    steer: false,
    followUp: false,
    images: false,
  };
  reads: string[] = [];
  readSessionUsage?: (path: string) => Promise<SessionUsage | undefined>;
  constructor(
    private readonly sessionsDir: string,
    withReader = true,
  ) {
    if (withReader) {
      this.readSessionUsage = async (path) => {
        this.reads.push(path);
        return readPiSessionUsage(path);
      };
    }
  }
  expectedSessionFile(_cwd: string, sessionId: string): ExpectedSessionFile {
    return { dir: this.sessionsDir, fileSuffix: `_${sessionId}.jsonl` };
  }
  async listModels(): Promise<HarnessModelCatalog> {
    return { harness: this.id, label: this.label, models: [] };
  }
  async defaults(): Promise<Record<string, never>> {
    return {};
  }
  async presence(): Promise<PresenceStatus> {
    return { live: false, runningTurn: false };
  }
  buildLaunchSpec(): LaunchSpec {
    throw new Error("not used");
  }
  async stopHeadless(): Promise<void> {}
  async attach(): Promise<void> {}
}

const noGithub = new Proxy({} as PullRequestAccess & VersionAccess, {
  get: () => () => {
    throw new Error("GitHub/HTTP access must not be used in these tests");
  },
});

const noRepositories = {
  discoverRepositories: async () => [],
} as unknown as GitRepositoryAccess;

/** A Pi session file: header + one assistant turn per `[model, tokens, cost]`. */
function piSession(turns: Array<[string, number, number?]>): string {
  const lines: unknown[] = [
    {
      type: "session",
      version: 3,
      id: "s",
      timestamp: "2026-11-15T00:00:00.000Z",
      cwd: "/w",
    },
    ...turns.map(([model, tokens, cost], index) =>
      assistant(model, tokens, cost, index),
    ),
  ];
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function assistant(model: string, tokens: number, cost?: number, index = 0) {
  return {
    type: "message",
    id: `a${index}`,
    timestamp: `2026-11-15T00:00:0${index + 1}.000Z`,
    message: {
      role: "assistant",
      model,
      usage: {
        input: tokens,
        output: tokens,
        cacheRead: tokens,
        cacheWrite: tokens,
        totalTokens: tokens * 4,
        ...(cost === undefined ? {} : { cost: { total: cost } }),
      },
    },
  };
}

let root: string;
let sessionsDir: string;
let tasks: JsonTaskStateAccess;
let bindings: JsonWorkspaceBindingAccess;
let events: CoreEventBus;
let harness: UsageHarness;
let manager: CoreManager;
let ids = 0;

function build(adapter: HarnessAdapter): CoreManager {
  return new CoreManager({
    tasks,
    clock: new TestClock(),
    ids: { next: () => `id-${String(++ids).padStart(4, "0")}` },
    events,
    config: new JsonConfigAccess(join(root, "config.json")),
    repositories: noRepositories,
    worktrees: {} as never,
    bindings,
    sessions: new LocalSessionFileAccess(),
    scratch: new LocalScratchWorkspaceAccess(join(root, "scratch")),
    pullRequests: noGithub,
    versions: noGithub,
    harness: adapter,
    presence: new SessionPresenceAccess(join(root, "presence")),
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harbormaster-usage-"));
  sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ automation: false, movers: [] }),
  );
  tasks = new JsonTaskStateAccess(
    join(root, "tasks.json"),
    join(root, "tasks.lock"),
  );
  bindings = new JsonWorkspaceBindingAccess(
    join(root, "bindings.json"),
    join(root, "bindings.lock"),
  );
  events = new CoreEventBus();
  harness = new UsageHarness(sessionsDir);
  manager = build(harness);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const NOW = "2026-11-01T00:00:00.000Z";
/** Done within the archive window (the test clock starts 2026-11-16). */
const RECENT = "2026-11-15T00:00:00.000Z";

async function seed(
  id: string,
  patch: Partial<Task>,
  binding?: Partial<WorkspaceBinding>,
): Promise<void> {
  await tasks.createTask({
    id,
    kind: "temp_task",
    state: "done",
    title: id,
    initialPrompt: "",
    harness: "pi",
    createdAt: NOW,
    updatedAt: NOW,
    stateChangedAt: NOW,
    ...patch,
  });
  if (binding) {
    await bindings.attachBinding({
      id: `b-${id}`,
      taskId: id,
      detached: false,
      createdAt: NOW,
      updatedAt: NOW,
      ...binding,
    });
  }
}

/** A started task with a pre-assigned session id (as the app's first launch does). */
async function startedTask(): Promise<{ taskId: string; sessionId: string }> {
  const task = await manager.createTask({
    title: "work",
    initialPrompt: "",
    start: true,
  });
  const launch = await manager.claimSessionLaunch(task.id);
  if (launch?.mode !== "new") throw new Error("expected a new launch");
  return { taskId: task.id, sessionId: launch.sessionId };
}

describe("usage snapshots", () => {
  it("is pending once the session is recorded, ready on Done (with task-changed)", async () => {
    const { taskId, sessionId } = await startedTask();
    const sessionPath = join(sessionsDir, `2026_${sessionId}.jsonl`);
    expect(
      await manager.recordTaskSession(taskId, { sessionId, sessionPath }),
    ).toBe(true);
    expect((await manager.getTask(taskId))?.usage).toMatchObject({
      status: "pending",
      sessions: [],
    });

    await writeFile(
      sessionPath,
      piSession([
        ["claude-opus-5-5", 100, 1],
        ["claude-haiku-5-5", 10, 0.01],
      ]),
    );
    const changed: Task[] = [];
    events.on("task-changed", ({ task }) => changed.push(task));
    const result = await manager.toDone(taskId, { force: { confirmed: true } });
    if (!("task" in result)) throw new Error("expected the task");
    expect(result.task.state).toBe("done");
    expect(result.task.usage).toMatchObject({
      status: "ready",
      totals: { input: 110, output: 110, turns: 2 },
      cost: 1.01,
      costSource: "pi",
      sessions: [{ sessionPath, harness: "pi" }],
    });
    expect((await manager.getTask(taskId))?.usage?.status).toBe("ready");
    expect(changed.at(-1)?.usage?.status).toBe("ready");
  });

  it("finds the bound session's file through the adapter when none was recorded, and skips unchanged files", async () => {
    const { taskId, sessionId } = await startedTask();
    const sessionPath = join(sessionsDir, `2026_${sessionId}.jsonl`);
    await writeFile(sessionPath, piSession([["claude-opus-5-5", 5, 0.5]]));

    await manager.endPresence(taskId, { pid: 1 });
    expect((await manager.getTask(taskId))?.usage?.totals.turns).toBe(1);
    expect(harness.reads).toEqual([sessionPath]);

    await manager.endPresence(taskId, { pid: 1 });
    expect(harness.reads).toHaveLength(1);

    await appendFile(
      sessionPath,
      `${JSON.stringify(assistant("claude-opus-5-5", 5, 0.5, 1))}\n`,
    );
    await manager.endPresence(taskId, { pid: 1 });
    expect(harness.reads).toHaveLength(2);
    expect((await manager.getTask(taskId))?.usage).toMatchObject({
      totals: { input: 10, turns: 2 },
      cost: 1,
    });

    // The popover's refresh always re-reads.
    await manager.refreshTaskUsage(taskId);
    expect(harness.reads).toHaveLength(3);
    await expect(manager.refreshTaskUsage("nope")).rejects.toThrow(/not found/);
  });

  it("sums the previous cycle's session and subtracts the fork prefix", async () => {
    const previous = join(sessionsDir, "previous.jsonl");
    const current = join(sessionsDir, "current.jsonl");
    await writeFile(previous, piSession([["claude-opus-5-5", 10, 1]]));
    await writeFile(
      current,
      `${[
        {
          type: "session",
          id: "c",
          timestamp: "2026-11-15T12:00:00.000Z",
          parentSession: previous,
        },
        assistant("claude-opus-5-5", 10, 1, 0),
        {
          ...assistant("claude-opus-5-5", 3, 0.3, 1),
          timestamp: "2026-11-15T13:00:00.000Z",
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
    );
    await seed(
      "reopened",
      { state: "working" },
      { sessionPath: current, previousSessionPath: previous },
    );
    const usage = await manager.refreshTaskUsage("reopened");
    expect(usage).toMatchObject({
      status: "ready",
      totals: { input: 13, turns: 2 },
      cost: 1.3,
    });
    expect(usage?.sessions.map((session) => session.sessionPath)).toEqual([
      previous,
      current,
    ]);
  });

  it("marks a harness without a reader unavailable/unsupported", async () => {
    const plain = build(new UsageHarness(sessionsDir, false));
    await seed("custom", {}, { sessionPath: join(sessionsDir, "x.jsonl") });
    expect(await plain.refreshTaskUsage("custom")).toMatchObject({
      status: "unavailable",
      reason: "unsupported",
    });
  });
});

describe("usage backfill on refresh", () => {
  it("fills tasks never computed, marks missing sessions unavailable once, never retries them", async () => {
    const gone = join(sessionsDir, "gone.jsonl");
    const kept = join(sessionsDir, "kept.jsonl");
    await writeFile(kept, piSession([["claude-opus-5-5", 50, 2]]));
    await seed("gone", {}, { sessionPath: gone });
    await seed("unbound", {});
    await seed("kept", {}, { sessionPath: kept });
    await seed("waiting", { state: "working" }, { sessionId: "zzz" });
    await seed("parked", { state: "backlog" });

    await manager.refresh();
    const usage = async (id: string) => (await manager.getTask(id))?.usage;
    expect(await usage("gone")).toMatchObject({
      status: "unavailable",
      reason: "missing-session",
    });
    expect(await usage("unbound")).toMatchObject({
      status: "unavailable",
      reason: "missing-session",
    });
    expect(await usage("kept")).toMatchObject({
      status: "ready",
      totals: { input: 50 },
      cost: 2,
    });
    expect(await usage("waiting")).toMatchObject({ status: "pending" });
    expect(await usage("parked")).toBeUndefined();
    const readsAfterFirst = harness.reads.length;
    expect(harness.reads.filter((path) => path === gone)).toHaveLength(1);

    // The file reappearing does not matter: unavailable is never retried
    // by the backfill; a ready task is not re-read either.
    await writeFile(gone, piSession([["claude-opus-5-5", 1, 0.1]]));
    await manager.refresh();
    expect(await usage("gone")).toMatchObject({ status: "unavailable" });
    expect(harness.reads).toHaveLength(readsAfterFirst);

    // A pending task is picked up once its session file shows up.
    await writeFile(
      join(sessionsDir, "2026_zzz.jsonl"),
      piSession([["claude-opus-5-5", 7, 0.7]]),
    );
    await bindings.replaceBinding({
      id: "b-waiting",
      taskId: "waiting",
      detached: false,
      sessionId: "zzz",
      worktreePath: root,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await manager.refresh();
    expect(await usage("waiting")).toMatchObject({
      status: "ready",
      totals: { input: 7 },
    });
  });
});

describe("listTaskUsage", () => {
  it("lists computed usage with subtask roll-up, and serves the usage op", async () => {
    const parentSession = join(sessionsDir, "parent.jsonl");
    const childSession = join(sessionsDir, "child.jsonl");
    await writeFile(parentSession, piSession([["claude-opus-5-5", 100, 3]]));
    await writeFile(childSession, piSession([["claude-haiku-5-5", 20, 0.2]]));
    await seed(
      "parent",
      { repositoryId: "github.com/acme/app", completedAt: RECENT },
      { sessionPath: parentSession },
    );
    await seed(
      "child",
      {
        parentTaskId: "parent",
        repositoryId: "github.com/acme/app",
        completedAt: RECENT,
      },
      { sessionPath: childSession },
    );
    await seed("archived", { archivedAt: NOW }, {});
    await manager.refresh();

    const rows = await manager.listTaskUsage({});
    expect(rows.map((row) => row.taskId)).toEqual(["parent", "child"]);
    expect(rows[0]).toMatchObject({
      repository: "github.com/acme/app",
      harness: "pi",
      state: "done",
      usage: { status: "ready", cost: 3 },
      subtaskUsage: { input: 20, count: 1, cost: 0.2 },
    });
    expect(
      (await manager.listTaskUsage({ model: "claude-haiku-5-5" })).map(
        (row) => row.taskId,
      ),
    ).toEqual(["child"]);
    expect(
      (await manager.listTaskUsage({ includeArchived: true })).map(
        (row) => row.taskId,
      ),
    ).toContain("archived");

    const op = await dispatchOpCall(manager, "usage", {
      repository: "github.com/acme/app",
    });
    expect((op.details as { rows: unknown[] }).rows).toHaveLength(2);
    expect(op.text).toContain("400 tok  ~$3.00 est. by pi");
    expect(op.text).toContain("incl. 1 subtask");
  });
});
