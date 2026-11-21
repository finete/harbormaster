// Per-task token usage through the manager (docs/costs.md): snapshots on
// `recordTaskSession` / agent finished / `toDone`, no re-parse of an
// unchanged session, the refresh backfill (missing sessions marked
// `unavailable` exactly once, never retried), `refreshTaskUsage`,
// `listTaskUsage` (+ subtask roll-up, the `usage` op), and harnesses with
// no reader. Real JSON state files and session files in a temp dir; the
// harness is a fake that reads Pi-format files with the real Pi reader.

import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { noopCoreLogger } from "../src/contracts/logger.js";
import type { Task, WorkspaceBinding } from "../src/contracts/model.js";
import type { SessionUsage, TaskUsage } from "../src/contracts/usage.js";
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
import { UsageRuntime } from "../src/manager/usage-runtime.js";

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
  /** What `extraUsageFiles` lists (stand-ins for subagent transcripts). */
  extraFiles: string[] = [];
  readSessionUsage?: (path: string) => Promise<SessionUsage | undefined>;
  async extraUsageFiles(): Promise<string[]> {
    return this.extraFiles;
  }
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

/** One refresh tick, then the background backfill drain it started. */
async function refreshed(): Promise<void> {
  await manager.refresh();
  await manager.whenUsageBackfilled();
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

describe("usage while the agent keeps working", () => {
  /** Backdate `path` before the test clock: its writer has gone quiet. */
  const quiet = (path: string) => {
    const past = new Date("2026-11-15T00:00:00.000Z");
    return utimes(path, past, past);
  };
  /** A started task counted once (1 turn), its session file, and an appender. */
  async function countedTask() {
    const { taskId, sessionId } = await startedTask();
    const sessionPath = join(sessionsDir, `2026_${sessionId}.jsonl`);
    await writeFile(sessionPath, piSession([["claude-opus-5-5", 5, 0.5]]));
    await quiet(sessionPath);
    await manager.endPresence(taskId, { pid: 1 });
    expect((await manager.getTask(taskId))?.usage?.totals.turns).toBe(1);
    let turn = 0;
    const appendTurn = () =>
      appendFile(
        sessionPath,
        `${JSON.stringify(assistant("claude-opus-5-5", 5, 0.5, ++turn))}\n`,
      );
    return { taskId, sessionPath, appendTurn };
  }
  const turns = async (taskId: string) =>
    (await manager.getTask(taskId))?.usage?.totals.turns;

  it("recounts when a turn ends (a stop boundary), not on other boundaries", async () => {
    const { taskId, appendTurn } = await countedTask();
    await appendTurn();
    await manager.reportTurnBoundary(taskId, { kind: "prompt" });
    await manager.reportTurnBoundary(taskId, { kind: "tool" });
    expect(harness.reads).toHaveLength(1);

    await manager.reportTurnBoundary(taskId, { kind: "stop" });
    await vi.waitFor(async () => expect(await turns(taskId)).toBe(2));
  });

  it("recounts open tasks on the refresh tick once their files go quiet, re-parsing only changed files", async () => {
    const { taskId, sessionPath, appendTurn } = await countedTask();
    await refreshed();
    expect(harness.reads).toHaveLength(1);

    // Still being written (fresh mtime): the tick leaves the count alone.
    await appendTurn();
    await refreshed();
    expect(await turns(taskId)).toBe(1);
    expect(harness.reads).toHaveLength(1);

    await quiet(sessionPath);
    await refreshed();
    expect(await turns(taskId)).toBe(2);
    expect(harness.reads).toHaveLength(2);

    // Done is final: its own snapshot, never re-checked by the tick.
    await manager.toDone(taskId, { force: { confirmed: true } });
    const reads = harness.reads.length;
    await appendTurn();
    await quiet(sessionPath);
    await refreshed();
    expect(harness.reads).toHaveLength(reads);
  });

  it("a turn end during a quiet-gated tick run still recounts (never joins the skip)", async () => {
    const { taskId, appendTurn } = await countedTask();
    const runtime = new UsageRuntime({
      tasks,
      sessions: new LocalSessionFileAccess(),
      clock: new TestClock(),
      logger: noopCoreLogger,
      adapterFor: async () => harness,
      bindingFor: (id) => bindings.getBindingForTask(id),
      publish: async () => {},
    });
    await appendTurn();
    const tick = runtime.update(taskId, { quietMs: 15_000 });
    const stop = runtime.update(taskId);
    await tick;
    expect((await stop)?.totals.turns).toBe(2);
    // Two gated callers still share one run.
    const first = runtime.update(taskId, { quietMs: 15_000 });
    expect(runtime.update(taskId, { quietMs: 15_000 })).toBe(first);
    await first;
  });

  it("notices a change to a file the reader counts besides the session (a running subagent)", async () => {
    const subagent = join(sessionsDir, "agent-1.jsonl");
    await writeFile(subagent, "{}\n");
    harness.extraFiles = [subagent];
    await quiet(subagent);
    const { taskId } = await countedTask();
    await refreshed();
    expect(harness.reads).toHaveLength(1);

    await appendFile(subagent, "{}\n");
    await quiet(subagent);
    await refreshed();
    expect(harness.reads).toHaveLength(2);
    expect((await manager.getTask(taskId))?.usage?.fingerprint).toContain(
      subagent,
    );
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

    await refreshed();
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
    await refreshed();
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
    await refreshed();
    expect(await usage("waiting")).toMatchObject({
      status: "ready",
      totals: { input: 7 },
    });
  });
});

describe("usage backfill drain", () => {
  async function freshTasks(count: number): Promise<string[]> {
    const paths: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = `bulk-${String(index).padStart(2, "0")}`;
      const path = join(sessionsDir, `${id}.jsonl`);
      await writeFile(path, piSession([["claude-opus-5-5", index + 1, 0.1]]));
      await seed(id, {}, { sessionPath: path });
      paths.push(path);
    }
    return paths;
  }

  it("counts every never-computed task from one refresh, pushing the board per batch, without blocking the tick", async () => {
    await freshTasks(50);
    let pushes = 0;
    events.on("board-changed", () => {
      pushes += 1;
    });
    await manager.refresh();
    // The tick returned without waiting for the drain.
    const listed = await manager.listTaskUsage({});
    expect(listed).toHaveLength(50);
    expect(listed.some((row) => row.usage.status === "pending")).toBe(true);
    await manager.whenUsageBackfilled();
    const rows = await manager.listTaskUsage({});
    expect(rows).toHaveLength(50);
    expect(rows.every((row) => row.usage.status === "ready")).toBe(true);
    expect(harness.reads).toHaveLength(50);
    // 50 tasks in batches of 16: four batches, at most one push each.
    expect(pushes).toBeGreaterThan(0);
    expect(pushes).toBeLessThanOrEqual(4);
  });

  it("lists not-yet-counted tasks as pending rows until the drain reaches them", async () => {
    await freshTasks(3);
    await seed("parked", { state: "backlog" });
    const before = await manager.listTaskUsage({});
    expect(before.map((row) => row.usage.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    await refreshed();
    const after = await manager.listTaskUsage({});
    expect(after.map((row) => row.usage.status)).toEqual([
      "ready",
      "ready",
      "ready",
    ]);
  });

  it("is single-flight: a second drain while one runs is a no-op", async () => {
    await freshTasks(50);
    const runtime = new UsageRuntime({
      tasks,
      sessions: new LocalSessionFileAccess(),
      clock: new TestClock(),
      logger: noopCoreLogger,
      adapterFor: async () => harness,
      bindingFor: (taskId) => bindings.getBindingForTask(taskId),
      publish: async () => {},
    });
    const bindingFor = (taskId: string) => bindings.getBindingForTask(taskId);
    let batches = 0;
    const onBatch = async () => {
      batches += 1;
    };
    const first = runtime.drain(() => tasks.listTasks(), bindingFor, onBatch);
    const second = runtime.drain(() => tasks.listTasks(), bindingFor, onBatch);
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(harness.reads).toHaveLength(50);
    expect(new Set(harness.reads).size).toBe(50);
    expect(batches).toBe(4);
    const all = await tasks.listTasks();
    expect(all.every((task) => task.usage?.status === "ready")).toBe(true);
    // Done: a new drain finds nothing to do.
    await runtime.drain(() => tasks.listTasks(), bindingFor, onBatch);
    expect(harness.reads).toHaveLength(50);
  });

  it("records the sessions' newest mtime as lastActivityAt, and fills it in once for older usage without re-parsing", async () => {
    const path = join(sessionsDir, "old.jsonl");
    await writeFile(path, piSession([["claude-opus-5-5", 9, 0.9]]));
    const mtime = new Date("2026-10-02T03:04:05.000Z");
    await utimes(path, mtime, mtime);
    await seed(
      "old",
      { completedAt: "2026-10-03T00:00:00.000Z" },
      {
        sessionPath: path,
      },
    );
    await refreshed();
    const usage = (await manager.getTask("old"))?.usage as TaskUsage;
    expect(usage.lastActivityAt).toBe(mtime.toISOString());
    expect(harness.reads).toHaveLength(1);

    // Usage persisted before the field existed: the next drain adds it
    // from the stats alone (fingerprint unchanged → no re-parse).
    const { lastActivityAt: _dropped, ...legacy } = usage;
    await tasks.patchTask("old", (task) => ({ ...task, usage: legacy }));
    const fresh = build(harness);
    await fresh.refresh();
    await fresh.whenUsageBackfilled();
    expect((await fresh.getTask("old"))?.usage?.lastActivityAt).toBe(
      mtime.toISOString(),
    );
    expect(harness.reads).toHaveLength(1);
    expect((await stat(path)).mtime.toISOString()).toBe(mtime.toISOString());
    // The range filter goes by it, not by when it was computed (archived:
    // the refresh's sweep archived this long-Done task).
    const ids = async (from: string, to?: string) =>
      (
        await fresh.listTaskUsage({
          includeArchived: true,
          from,
          ...(to ? { to } : {}),
        })
      ).map((row) => row.taskId);
    expect(await ids("2026-11-01")).toEqual([]);
    expect(await ids("2026-10-01", "2026-10-31")).toEqual(["old"]);
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
    await refreshed();

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
