// Wiring of the extension entry point against a fake pi ExtensionAPI:
// presence follows the whole agent loop (agent_start/agent_end, never
// per-turn), and the session is named after its task (pi-home's
// setSessionName). Real presence/task files in a temp state dir.

import { mkdtemp, rm } from "node:fs/promises";
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
    const paths = resolveStatePaths(dir);
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
    expect([...pi.tools.keys()]).toEqual(["harbormaster_report_status"]);
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
});
