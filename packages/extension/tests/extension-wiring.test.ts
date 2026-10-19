// Wiring of the extension entry point against a fake pi ExtensionAPI:
// presence follows the whole agent loop (agent_start/agent_end, never
// per-turn), and the session is named after its task (pi-home's
// setSessionName). Real presence/task files in a temp state dir.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  JsonTaskStateAccess,
  resolveStatePaths,
  SessionPresenceAccess,
} from "@harbormaster/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import harbormasterExtension from "../src/index.js";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

function fakePi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<unknown> }
  >();
  const tools = new Map<
    string,
    { execute: (...args: unknown[]) => Promise<unknown> }
  >();
  let sessionName: string | undefined;
  const renames: string[] = [];
  const api = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    getSessionName: () => sessionName,
    setSessionName: (name: string) => {
      sessionName = name;
      renames.push(name);
    },
    registerCommand: (
      name: string,
      options: { handler: (args: string, ctx: unknown) => Promise<unknown> },
    ) => {
      commands.set(name, options);
    },
    registerTool: (tool: {
      name: string;
      execute: (...args: unknown[]) => Promise<unknown>;
    }) => {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  return { api, handlers, renames, commands, tools };
}

interface FakeUiOverrides {
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  confirm?: (title: string, message: string) => Promise<boolean>;
  input?: (title: string, placeholder?: string) => Promise<string | undefined>;
  notify?: (message: string, type?: string) => void;
}

function fakeCtx(
  sessionPath: string,
  ui: FakeUiOverrides = {},
): ExtensionContext {
  return {
    hasUI: true,
    sessionManager: {
      getSessionFile: () => sessionPath,
      getSessionId: () => "session-1",
    },
    ui: {
      setTitle: () => {},
      setWidget: () => {},
      theme: { fg: (_token: string, text: string) => text },
      select: ui.select ?? (async () => undefined),
      confirm: ui.confirm ?? (async () => false),
      input: ui.input ?? (async () => undefined),
      notify: ui.notify ?? (() => {}),
    },
  } as unknown as ExtensionContext;
}

describe("extension wiring", () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harbormaster-ext-wiring-"));
    process.env.HARBORMASTER_TASK_ID = "task-1";
    process.env.HARBORMASTER_STATE_DIR = dir;
    delete process.env.HARBORMASTER_SESSION_ID;
    const paths = resolveStatePaths(dir);
    // Deterministic, empty codeRoot: listRepositories() must never scan the
    // real $HOME/Code checked out on the machine running these tests.
    await writeFile(
      paths.configFile,
      JSON.stringify({
        automation: true,
        codeRoot: join(dir, "code"),
        branchPrefix: "",
      }),
    );
    await new JsonTaskStateAccess(
      paths.tasksFile,
      paths.tasksLockFile,
    ).createTask({
      id: "task-1",
      kind: "task",
      state: "dev",
      title: "Fix the login bug",
      initialPrompt: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      stateChangedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  afterEach(async () => {
    process.env = { ...saved };
    await rm(dir, { recursive: true, force: true });
  });

  it("tracks running state across the whole agent loop, not individual turns", async () => {
    const pi = fakePi();
    harbormasterExtension(pi.api);
    expect(pi.handlers.has("turn_start")).toBe(false);
    expect(pi.handlers.has("turn_end")).toBe(false);

    const ctx = fakeCtx(join(dir, "session.jsonl"));
    await pi.handlers.get("session_start")?.({}, ctx);
    const presence = new SessionPresenceAccess(
      resolveStatePaths(dir).presenceDir,
    );

    await pi.handlers.get("agent_start")?.({}, ctx);
    expect((await presence.read("task-1"))?.runningTurn).toBe(true);
    await pi.handlers.get("agent_end")?.({}, ctx);
    expect((await presence.read("task-1"))?.runningTurn).toBe(false);

    await pi.handlers.get("session_shutdown")?.({}, ctx);
  });

  it("names the session after its task once (no rename when already named)", async () => {
    const pi = fakePi();
    harbormasterExtension(pi.api);
    const ctx = fakeCtx(join(dir, "session.jsonl"));

    await pi.handlers.get("session_start")?.({}, ctx);
    await pi.handlers.get("session_start")?.({}, ctx);

    expect(pi.renames).toEqual(["Fix the login bug"]);
    await pi.handlers.get("session_shutdown")?.({}, ctx);
  });

  it("registers exactly /todev, /toawait, /todone and one agent tool \u2014 no kind-named commands", async () => {
    const pi = fakePi();
    harbormasterExtension(pi.api);

    expect([...pi.commands.keys()].sort()).toEqual([
      "toawait",
      "todev",
      "todone",
    ]);
    expect([...pi.tools.keys()].sort()).toEqual([
      "harbormaster_launch_task",
      "harbormaster_report_status",
      "harbormaster_subtask_status",
    ]);
  });

  it("/todev moves the task to Dev and refreshes the widget", async () => {
    const pi = fakePi();
    harbormasterExtension(pi.api);
    const paths = resolveStatePaths(dir);
    // Park the task in backlog first so todev has somewhere to move it.
    const taskState = new JsonTaskStateAccess(
      paths.tasksFile,
      paths.tasksLockFile,
    );
    await taskState.replaceTask({
      id: "task-1",
      kind: "task",
      state: "backlog",
      title: "Fix the login bug",
      initialPrompt: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      stateChangedAt: "2026-01-01T00:00:00.000Z",
    });

    const notifications: Array<{ message: string; type?: string }> = [];
    let widgetCalls = 0;
    const ctx = fakeCtx(join(dir, "session.jsonl"), {
      notify: (message, type) => notifications.push({ message, type }),
    });
    (ctx.ui as { setWidget: () => void }).setWidget = () => {
      widgetCalls += 1;
    };

    await pi.commands.get("todev")?.handler("", ctx);

    const moved = await taskState.getTask("task-1");
    expect(moved?.state).toBe("dev");
    expect(notifications).toEqual([{ message: "Moved to Dev", type: "info" }]);
    expect(widgetCalls).toBeGreaterThan(0);
  });

  it("/toawait picks a kind via ctx.ui.select and moves the task to Awaiting", async () => {
    const pi = fakePi();
    harbormasterExtension(pi.api);
    const notifications: Array<{ message: string; type?: string }> = [];
    const ctx = fakeCtx(join(dir, "session.jsonl"), {
      select: async (_title, options) => options[0],
      notify: (message, type) => notifications.push({ message, type }),
    });

    await pi.commands.get("toawait")?.handler("", ctx);

    const paths = resolveStatePaths(dir);
    const taskState = new JsonTaskStateAccess(
      paths.tasksFile,
      paths.tasksLockFile,
    );
    const moved = await taskState.getTask("task-1");
    expect(moved?.state).toBe("awaiting");
    expect(moved?.awaiting?.kind).toBe("review");
    expect(notifications).toEqual([
      { message: "Awaiting Review", type: "info" },
    ]);
  });

  it("/todone confirms destructive cleanup with the app's exact wording, then retries", async () => {
    // task-1 is repository-less (no worktree to clean up), so toDone lands
    // without any confirmation; this exercises the straight-through path.
    const pi = fakePi();
    harbormasterExtension(pi.api);
    const notifications: Array<{ message: string; type?: string }> = [];
    const ctx = fakeCtx(join(dir, "session.jsonl"), {
      notify: (message, type) => notifications.push({ message, type }),
    });

    await pi.commands.get("todone")?.handler("", ctx);

    const paths = resolveStatePaths(dir);
    const taskState = new JsonTaskStateAccess(
      paths.tasksFile,
      paths.tasksLockFile,
    );
    const moved = await taskState.getTask("task-1");
    expect(moved?.state).toBe("done");
    expect(notifications).toEqual([{ message: "Moved to Done", type: "info" }]);
  });

  it("harbormaster_report_status rejects when the session is not presence-attached", async () => {
    const pi = fakePi();
    harbormasterExtension(pi.api);
    const tool = pi.tools.get("harbormaster_report_status");
    await expect(
      tool?.execute("call-1", { status: "done", note: "shipped" }),
    ).rejects.toThrow(/not linked to a Harbormaster task/);
  });

  it("harbormaster_report_status writes the outcome through PresenceAccess once attached", async () => {
    const pi = fakePi();
    harbormasterExtension(pi.api);
    const ctx = fakeCtx(join(dir, "session.jsonl"));
    await pi.handlers.get("session_start")?.({}, ctx);

    const tool = pi.tools.get("harbormaster_report_status");
    const result = (await tool?.execute("call-1", {
      status: "blocked",
      note: "needs a decision",
    })) as { content: Array<{ type: string; text: string }> };
    expect(result.content[0]?.text).toBe("Recorded blocked: needs a decision");

    const presence = new SessionPresenceAccess(
      resolveStatePaths(dir).presenceDir,
    );
    const record = await presence.read("task-1");
    // A reported outcome keeps the session live ("your move"): it is
    // recorded as `outcome`, never as `ended` (process gone).
    expect(record?.ended).toBeUndefined();
    expect(record?.outcome).toEqual({
      status: "blocked",
      note: "needs a decision",
      at: expect.any(String),
    });

    await pi.handlers.get("session_shutdown")?.({}, ctx);
  });

  describe("harbormaster_launch_task", () => {
    it("registers even outside any Harbormaster-hosted session", () => {
      delete process.env.HARBORMASTER_TASK_ID;
      delete process.env.HARBORMASTER_STATE_DIR;
      const pi = fakePi();
      harbormasterExtension(pi.api);
      expect(pi.tools.has("harbormaster_launch_task")).toBe(true);
      // harbormaster_subtask_status also registers everywhere (it errors at
      // execution time outside a task session instead of being absent).
      expect(pi.tools.has("harbormaster_subtask_status")).toBe(true);
      // Task-session-only machinery (presence/widget/commands/report_status)
      // never registers without a task id.
      expect(pi.handlers.has("session_start")).toBe(false);
      expect(pi.tools.has("harbormaster_report_status")).toBe(false);
    });

    it("relation child rejects outside a task session (no HARBORMASTER_TASK_ID at all)", async () => {
      delete process.env.HARBORMASTER_TASK_ID;
      const pi = fakePi();
      harbormasterExtension(pi.api);
      const tool = pi.tools.get("harbormaster_launch_task");
      await expect(
        tool?.execute("call-1", {
          relation: "child",
          title: "Fix something",
          prompt: "Do the thing",
          repository: "none",
        }),
      ).rejects.toThrow(
        "child requires launching from a Harbormaster task session",
      );
    });

    it("relation child rejects when the nested-session guard treats this process as not the task", async () => {
      process.env.HARBORMASTER_SESSION_ID = "pane-session";
      const pi = fakePi();
      harbormasterExtension(pi.api);
      // A nested pi process (subagent) inherits the env but opens its own
      // session id, so the session_start guard stands down.
      const ctx = fakeCtx(join(dir, "session.jsonl"));
      await pi.handlers.get("session_start")?.({}, ctx);

      const tool = pi.tools.get("harbormaster_launch_task");
      await expect(
        tool?.execute("call-1", {
          relation: "child",
          title: "Fix something",
          prompt: "Do the thing",
          repository: "none",
        }),
      ).rejects.toThrow(
        "child requires launching from a Harbormaster task session",
      );

      const subtaskTool = pi.tools.get("harbormaster_subtask_status");
      await expect(subtaskTool?.execute("call-2", {})).rejects.toThrow(
        /only available inside a Harbormaster task session/,
      );
    });

    it("a child launch passes through to launchTask with fromTaskId set to this task", async () => {
      process.env.HARBORMASTER_SESSION_ID = "session-1";
      const pi = fakePi();
      harbormasterExtension(pi.api);
      const ctx = fakeCtx(join(dir, "session.jsonl"));
      await pi.handlers.get("session_start")?.({}, ctx);

      const tool = pi.tools.get("harbormaster_launch_task");
      const result = (await tool?.execute("call-1", {
        relation: "child",
        title: "Fix the flaky test",
        prompt: "Make the test deterministic",
        repository: "none",
      })) as {
        content: Array<{ type: string; text: string }>;
        details: { task: { id: string } };
      };

      expect(result.content[0]?.text).toContain('"Fix the flaky test"');
      expect(result.content[0]?.text).toContain("QUEUED");
      expect(result.content[0]?.text).toContain("harbormaster_subtask_status");

      const paths = resolveStatePaths(dir);
      const taskState = new JsonTaskStateAccess(
        paths.tasksFile,
        paths.tasksLockFile,
      );
      const child = await taskState.getTask(result.details.task.id);
      expect(child?.parentTaskId).toBe("task-1");
      expect(child?.launchedFromTaskId).toBeUndefined();
      expect(child?.launch?.status).toBe("queued");
    });

    it("a standalone launch records launchedFromTaskId (provenance only, no lineage) when launched from a task session", async () => {
      process.env.HARBORMASTER_SESSION_ID = "session-1";
      const pi = fakePi();
      harbormasterExtension(pi.api);
      const ctx = fakeCtx(join(dir, "session.jsonl"));
      await pi.handlers.get("session_start")?.({}, ctx);

      const tool = pi.tools.get("harbormaster_launch_task");
      const result = (await tool?.execute("call-1", {
        relation: "standalone",
        title: "Unrelated fix",
        prompt: "Do an unrelated thing",
        repository: "none",
      })) as { details: { task: { id: string } } };

      const paths = resolveStatePaths(dir);
      const taskState = new JsonTaskStateAccess(
        paths.tasksFile,
        paths.tasksLockFile,
      );
      const task = await taskState.getTask(result.details.task.id);
      expect(task?.parentTaskId).toBeUndefined();
      expect(task?.launchedFromTaskId).toBe("task-1");
    });

    it("a standalone launch from a non-task session has no provenance at all", async () => {
      delete process.env.HARBORMASTER_TASK_ID;
      const pi = fakePi();
      harbormasterExtension(pi.api);
      const tool = pi.tools.get("harbormaster_launch_task");
      const result = (await tool?.execute("call-1", {
        relation: "standalone",
        title: "Unrelated fix",
        prompt: "Do an unrelated thing",
        repository: "none",
      })) as { details: { task: { id: string } } };

      const paths = resolveStatePaths(dir);
      const taskState = new JsonTaskStateAccess(
        paths.tasksFile,
        paths.tasksLockFile,
      );
      const task = await taskState.getTask(result.details.task.id);
      expect(task?.parentTaskId).toBeUndefined();
      expect(task?.launchedFromTaskId).toBeUndefined();
    });
  });

  describe("harbormaster_subtask_status", () => {
    async function seedChild(
      dirPath: string,
      overrides: Partial<Parameters<JsonTaskStateAccess["createTask"]>[0]>,
    ) {
      const paths = resolveStatePaths(dirPath);
      const taskState = new JsonTaskStateAccess(
        paths.tasksFile,
        paths.tasksLockFile,
      );
      await taskState.createTask({
        id: "child-1",
        kind: "task",
        state: "dev",
        title: "Fix the flaky test",
        initialPrompt: "",
        parentTaskId: "task-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        stateChangedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
      });
    }

    it("reports 'No child tasks.' when there are none", async () => {
      process.env.HARBORMASTER_SESSION_ID = "session-1";
      const pi = fakePi();
      harbormasterExtension(pi.api);
      const ctx = fakeCtx(join(dir, "session.jsonl"));
      await pi.handlers.get("session_start")?.({}, ctx);

      const tool = pi.tools.get("harbormaster_subtask_status");
      const result = (await tool?.execute("call-1", {})) as {
        content: Array<{ type: string; text: string }>;
      };
      expect(result.content[0]?.text).toBe("No child tasks.");
    });

    it("formats a queued child and a done child with a reported outcome", async () => {
      await seedChild(dir, {
        id: "child-1",
        launch: { status: "queued", requestedAt: "2026-01-01T00:00:00.000Z" },
      });
      const paths = resolveStatePaths(dir);
      const taskState = new JsonTaskStateAccess(
        paths.tasksFile,
        paths.tasksLockFile,
      );
      await taskState.createTask({
        id: "child-2",
        kind: "task",
        state: "done",
        title: "Already shipped",
        initialPrompt: "",
        parentTaskId: "task-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        stateChangedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:00.000Z",
      });

      process.env.HARBORMASTER_SESSION_ID = "session-1";
      const pi = fakePi();
      harbormasterExtension(pi.api);
      const ctx = fakeCtx(join(dir, "session.jsonl"));
      await pi.handlers.get("session_start")?.({}, ctx);

      const tool = pi.tools.get("harbormaster_subtask_status");
      const result = (await tool?.execute("call-1", {})) as {
        content: Array<{ type: string; text: string }>;
        details: { children: unknown[] };
      };
      expect(result.content[0]?.text).toContain(
        '"Fix the flaky test" (child-1)',
      );
      expect(result.content[0]?.text).toContain("queued");
      expect(result.content[0]?.text).toContain('"Already shipped" (child-2)');
      expect(result.details.children).toHaveLength(2);
    });

    it("shows working/your move run state from live presence", async () => {
      await seedChild(dir, {
        id: "child-1",
        launch: { status: "started", requestedAt: "2026-01-01T00:00:00.000Z" },
      });
      const presence = new SessionPresenceAccess(
        resolveStatePaths(dir).presenceDir,
      );
      await presence.register({
        taskId: "child-1",
        sessionPath: join(dir, "child-session.jsonl"),
        pid: process.pid,
        mode: "interactive",
        at: new Date().toISOString(),
      });
      await presence.setTurnActive(
        "child-1",
        process.pid,
        true,
        new Date().toISOString(),
      );

      process.env.HARBORMASTER_SESSION_ID = "session-1";
      const pi = fakePi();
      harbormasterExtension(pi.api);
      const ctx = fakeCtx(join(dir, "session.jsonl"));
      await pi.handlers.get("session_start")?.({}, ctx);

      const tool = pi.tools.get("harbormaster_subtask_status");
      const result = (await tool?.execute("call-1", {})) as {
        content: Array<{ type: string; text: string }>;
      };
      expect(result.content[0]?.text).toContain("working");
    });

    it("rejects outside a task session", async () => {
      delete process.env.HARBORMASTER_TASK_ID;
      const pi = fakePi();
      harbormasterExtension(pi.api);
      const tool = pi.tools.get("harbormaster_subtask_status");
      await expect(tool?.execute("call-1", {})).rejects.toThrow(
        /only available inside a Harbormaster task session/,
      );
    });
  });

  describe("task widget children summary line", () => {
    it("shows a compact children run-state line when the task has children", async () => {
      const paths = resolveStatePaths(dir);
      const taskState = new JsonTaskStateAccess(
        paths.tasksFile,
        paths.tasksLockFile,
      );
      await taskState.createTask({
        id: "child-1",
        kind: "task",
        state: "dev",
        title: "Child A",
        initialPrompt: "",
        parentTaskId: "task-1",
        launch: { status: "queued", requestedAt: "2026-01-01T00:00:00.000Z" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        stateChangedAt: "2026-01-01T00:00:00.000Z",
      });
      await taskState.createTask({
        id: "child-2",
        kind: "task",
        state: "done",
        title: "Child B",
        initialPrompt: "",
        parentTaskId: "task-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        stateChangedAt: "2026-01-01T00:00:00.000Z",
      });

      process.env.HARBORMASTER_SESSION_ID = "session-1";
      const pi = fakePi();
      harbormasterExtension(pi.api);
      let widgetLines: string[] | undefined;
      const ctx = fakeCtx(join(dir, "session.jsonl"));
      (
        ctx.ui as {
          setWidget: (key: string, lines: string[] | undefined) => void;
        }
      ).setWidget = (_key, lines) => {
        widgetLines = lines;
      };

      await pi.handlers.get("session_start")?.({}, ctx);

      expect(widgetLines?.some((line) => line.includes("children:"))).toBe(
        true,
      );
      expect(
        widgetLines?.some(
          (line) => line.includes("1 queued") && line.includes("1 done"),
        ),
      ).toBe(true);
    });

    it("omits the children line entirely for a childless task", async () => {
      process.env.HARBORMASTER_SESSION_ID = "session-1";
      const pi = fakePi();
      harbormasterExtension(pi.api);
      let widgetLines: string[] | undefined;
      const ctx = fakeCtx(join(dir, "session.jsonl"));
      (
        ctx.ui as {
          setWidget: (key: string, lines: string[] | undefined) => void;
        }
      ).setWidget = (_key, lines) => {
        widgetLines = lines;
      };

      await pi.handlers.get("session_start")?.({}, ctx);

      expect(widgetLines?.some((line) => line.includes("children:"))).toBe(
        false,
      );
    });
  });
});
