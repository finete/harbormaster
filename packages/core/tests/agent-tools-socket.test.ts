// The tool catalog end to end over the local socket (decision #18): a real
// `createCore` on a temp state dir, the socket server the app hosts, and the
// client the `harbormaster` CLI / MCP server use. Caller identity travels
// next to the arguments (from the client's env), never inside them.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Core,
  callerFromEnv,
  callTool,
  createCore,
  HarbormasterNotRunningError,
  type InboxClaimDetails,
  NOT_RUNNING_MESSAGE,
  PiHarnessAdapter,
  resolveSocketPath,
  sendSocketRequest,
  startToolSocketServer,
  TOOL_CATALOG,
  type ToolSocketServer,
} from "../src/index.js";

let stateDir: string;
let core: Core;
let server: ToolSocketServer;
let socketPath: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "hm-socket-"));
  core = createCore({
    stateDir,
    harness: new PiHarnessAdapter({ stateDir, isAlive: () => true }),
  });
  socketPath = resolveSocketPath(stateDir);
  server = await startToolSocketServer({ socketPath, commands: core.commands });
});

afterEach(async () => {
  await server.close();
  await rm(stateDir, { recursive: true, force: true });
});

describe("tool catalog", () => {
  it("defines every release tool exactly once, each with an object schema", () => {
    const names = TOOL_CATALOG.map((tool) => tool.name);
    expect(names).toEqual([
      "report_status",
      "launch_task",
      "subtask_status",
      "find_tasks",
      "send_to_task",
      "inbox_claim",
    ]);
    for (const tool of TOOL_CATALOG) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });
});

describe("tool socket", () => {
  it("answers ping and reports unknown tools with the list", async () => {
    const pong = await sendSocketRequest(socketPath, { method: "ping" });
    expect(pong).toMatchObject({ ok: true, result: { text: "pong" } });
    await expect(callTool(socketPath, "nope", {}, {})).rejects.toThrow(
      /Unknown tool "nope". Available: report_status/,
    );
  });

  it("launches, finds, messages, reports and claims through the socket", async () => {
    const parent = await callTool(
      socketPath,
      "launch_task",
      {
        relation: "standalone",
        title: "Parent work",
        prompt: "do it",
        repository: "none",
      },
      {},
    );
    expect(parent.text).toContain('Launched "Parent work"');
    const parentId = (parent.details as { task: { id: string } }).task.id;

    // A child needs a task caller: identity comes from the caller, not args.
    await expect(
      callTool(
        socketPath,
        "launch_task",
        { relation: "child", title: "C", prompt: "p", repository: "none" },
        {},
      ),
    ).rejects.toThrow(
      "child requires launching from a Harbormaster task session",
    );
    const child = await callTool(
      socketPath,
      "launch_task",
      {
        relation: "child",
        title: "Child work",
        prompt: "p",
        repository: "none",
      },
      { taskId: parentId },
    );
    const childId = (child.details as { task: { id: string } }).task.id;

    const found = await callTool(
      socketPath,
      "find_tasks",
      { query: "child" },
      { taskId: parentId },
    );
    expect(found.text).toContain(`"Child work" (${childId})`);
    expect(found.text).toContain("child");

    const status = await callTool(
      socketPath,
      "subtask_status",
      {},
      {
        taskId: parentId,
      },
    );
    expect(status.text).toContain(`"Child work" (${childId})`);
    await expect(
      callTool(socketPath, "subtask_status", {}, {}),
    ).rejects.toThrow("only available inside a Harbormaster task session");

    // report_status needs a live attachment (registered by a 7501 report).
    await expect(
      callTool(
        socketPath,
        "report_status",
        { status: "done" },
        {
          taskId: childId,
        },
      ),
    ).rejects.toThrow("not linked to a live Harbormaster task");
    await core.commands.reportPresence(childId, { state: "idle", pid: 4242 });
    const reported = await callTool(
      socketPath,
      "report_status",
      { status: "blocked", note: "need a key" },
      { taskId: childId },
    );
    expect(reported.text).toBe("Recorded blocked: need a key");
    const presence = await core.commands.getPresence(childId);
    expect(presence.record?.outcome).toMatchObject({
      status: "blocked",
      note: "need a key",
    });

    // Parent -> child: delivered directly, claimed formatted.
    const sent = await callTool(
      socketPath,
      "send_to_task",
      { taskId: childId, message: "Use the new API", mode: "steer" },
      { taskId: parentId },
    );
    expect(sent.details).toMatchObject({ route: "parent-to-child" });
    const claimed = await callTool(
      socketPath,
      "inbox_claim",
      { idle: true },
      {
        taskId: childId,
      },
    );
    const { messages } = claimed.details as InboxClaimDetails;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.deliverAs).toBe("steer");
    expect(messages[0]?.text).toContain(
      '[Message from your parent task "Parent work"',
    );
    expect(claimed.text).toContain("Use the new API");
  });

  it("validates arguments with agent-readable errors", async () => {
    await expect(
      callTool(socketPath, "find_tasks", { query: 3 }, {}),
    ).rejects.toThrow("query must be a string");
    await expect(
      callTool(
        socketPath,
        "launch_task",
        { relation: "sibling", title: "t", prompt: "p", repository: "none" },
        {},
      ),
    ).rejects.toThrow("relation must be one of: child, standalone");
  });

  it("rings watch-inbox subscribers when the task's inbox changes", async () => {
    const parent = await core.commands.launchTask({
      relation: "standalone",
      title: "P",
      prompt: "p",
      repository: { none: true },
    });
    const child = await core.commands.launchTask({
      relation: "child",
      fromTaskId: parent.id,
      title: "C",
      prompt: "p",
      repository: { none: true },
    });
    const { connect } = await import("node:net");
    const socket = connect(socketPath);
    socket.setEncoding("utf8");
    const lines: string[] = [];
    socket.on("data", (chunk: string) => lines.push(...chunk.split("\n")));
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      `${JSON.stringify({ id: 7, method: "watch-inbox", caller: { taskId: child.id } })}\n`,
    );
    await expect
      .poll(() => lines.some((line) => line.includes('"watching"')))
      .toBe(true);
    await core.commands.sendTaskMessage({
      from: { kind: "task", taskId: parent.id },
      targetTaskId: child.id,
      text: "hi",
    });
    await expect
      .poll(() => lines.some((line) => line.includes('"event":"inbox"')), {
        timeout: 5000,
      })
      .toBe(true);
    socket.destroy();
  });

  it("reports not running once the server is gone", async () => {
    await server.close();
    const error = await callTool(socketPath, "find_tasks", { query: "x" }, {})
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HarbormasterNotRunningError);
    expect((error as Error).message).toBe(NOT_RUNNING_MESSAGE);
    server = await startToolSocketServer({
      socketPath,
      commands: core.commands,
    });
  });

  it("refuses to steal a socket another live host listens on", async () => {
    await expect(
      startToolSocketServer({ socketPath, commands: core.commands }),
    ).rejects.toThrow("already listens");
  });
});

describe("callerFromEnv", () => {
  it("takes the task identity from the launch env", () => {
    expect(
      callerFromEnv(
        { HARBORMASTER_TASK_ID: "t1", HARBORMASTER_SESSION_ID: "s1" },
        "/w",
      ),
    ).toEqual({ taskId: "t1", sessionId: "s1", cwd: "/w" });
  });

  it("treats a nested session that inherited the env as a plain session", () => {
    expect(
      callerFromEnv(
        {
          HARBORMASTER_TASK_ID: "t1",
          HARBORMASTER_SESSION_ID: "s1",
          PI_SESSION_ID: "other",
        },
        "/w",
      ),
    ).toEqual({ sessionId: "other", cwd: "/w" });
    expect(
      callerFromEnv(
        {
          HARBORMASTER_TASK_ID: "t1",
          HARBORMASTER_SESSION_ID: "s1",
          PI_SESSION_ID: "s1",
        },
        "/w",
      ),
    ).toEqual({ taskId: "t1", sessionId: "s1", cwd: "/w" });
  });

  it("is a plain session without a task id", () => {
    expect(callerFromEnv({}, "/w")).toEqual({ cwd: "/w" });
  });
});

describe("resolveSocketPath", () => {
  it("prefers the state dir and falls back to a short hashed path", () => {
    expect(resolveSocketPath("/Users/me/.harbormaster")).toBe(
      "/Users/me/.harbormaster/harbormaster.sock",
    );
    const long = `/var/${"x".repeat(120)}`;
    const fallback = resolveSocketPath(long);
    expect(fallback).toMatch(/harbormaster-[0-9a-f]{16}\.sock$/);
    expect(Buffer.byteLength(fallback)).toBeLessThanOrEqual(100);
    expect(resolveSocketPath(long)).toBe(fallback);
  });
});
