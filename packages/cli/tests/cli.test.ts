// The `harbormaster` CLI and MCP server against a real in-process socket
// server (what the app hosts) over a temp state dir: every catalog entry is
// reachable both ways, identity comes from the env, and a missing app is
// "Harbormaster is not running" (exit 2).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Core,
  createCore,
  PiHarnessAdapter,
  resolveSocketPath,
  startToolSocketServer,
  TOOL_CATALOG,
  type ToolSocketServer,
} from "@harbormaster/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CliIo,
  createMcpServer,
  EXIT_NOT_RUNNING,
  inboxHookOutput,
  main,
  parseFlags,
} from "../src/index.js";

let stateDir: string;
let core: Core;
let server: ToolSocketServer | undefined;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "hm-cli-"));
  core = createCore({
    stateDir,
    harness: new PiHarnessAdapter({ stateDir, isAlive: () => true }),
  });
  server = await startToolSocketServer({
    socketPath: resolveSocketPath(stateDir),
    commands: core.commands,
  });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(stateDir, { recursive: true, force: true });
});

function io(env: NodeJS.ProcessEnv = {}): CliIo & {
  out: () => string;
  err: () => string;
} {
  let out = "";
  let err = "";
  return {
    env: { HARBORMASTER_STATE_DIR: stateDir, ...env },
    cwd: stateDir,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    out: () => out,
    err: () => err,
  };
}

async function launch(title: string, fromTaskId?: string): Promise<string> {
  const task = await core.commands.launchTask({
    relation: fromTaskId ? "child" : "standalone",
    ...(fromTaskId ? { fromTaskId } : {}),
    title,
    prompt: "p",
    repository: { none: true },
  });
  return task.id;
}

describe("harbormaster <tool>", () => {
  it("lists every catalog entry in its usage", async () => {
    const run = io();
    expect(await main(["--help"], run)).toBe(0);
    for (const tool of TOOL_CATALOG) expect(run.out()).toContain(tool.name);
  });

  it("calls a tool with flags and with --json, identity from the env", async () => {
    const parent = await launch("Parent work");
    const run = io({ HARBORMASTER_TASK_ID: parent });
    expect(
      await main(
        [
          "launch_task",
          "--relation",
          "child",
          "--title",
          "Child work",
          "--prompt",
          "go",
          "--repository",
          "none",
        ],
        run,
      ),
    ).toBe(0);
    expect(run.out()).toContain('Launched "Child work"');
    expect(run.out()).toContain("as a child task");

    const find = io({ HARBORMASTER_TASK_ID: parent });
    expect(
      await main(["find_tasks", "--json", '{"query":"child"}'], find),
    ).toBe(0);
    expect(find.out()).toContain('"Child work"');
    expect(find.out()).toContain("· child");
  });

  it("prints the tool's error and exits 1", async () => {
    const run = io();
    expect(await main(["subtask_status"], run)).toBe(1);
    expect(run.err()).toContain(
      "subtask_status is only available inside a Harbormaster task session.",
    );
  });

  it("says Harbormaster is not running and exits 2 when the app is down", async () => {
    await server?.close();
    server = undefined;
    for (const argv of [
      ["find_tasks", "--query", "x"],
      ["inbox", "claim", "--task", "t1"],
    ]) {
      const run = io();
      expect(await main(argv, run)).toBe(EXIT_NOT_RUNNING);
      expect(run.err()).toBe("Harbormaster is not running\n");
    }
    // A hook never wedges the agent: it says so on stderr and delivers nothing.
    const hook = io({ HARBORMASTER_TASK_ID: "t1" });
    expect(await main(["hook", "inbox", "--mode", "follow-up"], hook)).toBe(0);
    expect(hook.err()).toBe("Harbormaster is not running\n");
    expect(JSON.parse(hook.out())).toEqual({});
  });
});

describe("harbormaster inbox / hook", () => {
  it("claims formatted messages as JSON and as Claude Code hook output", async () => {
    const parent = await launch("Parent work");
    const child = await launch("Child work", parent);
    await core.commands.sendTaskMessage({
      from: { kind: "task", taskId: parent },
      targetTaskId: child,
      text: "first",
      mode: "steer",
    });
    const claim = io();
    expect(await main(["inbox", "claim", "--task", child], claim)).toBe(0);
    const { messages } = JSON.parse(claim.out()) as {
      messages: Array<{ text: string; deliverAs: string }>;
    };
    expect(messages).toHaveLength(1);
    expect(messages[0]?.deliverAs).toBe("steer");
    expect(messages[0]?.text).toContain("first");

    await core.commands.sendTaskMessage({
      from: { kind: "task", taskId: parent },
      targetTaskId: child,
      text: "second",
      mode: "steer",
    });
    const steer = io({ HARBORMASTER_TASK_ID: child });
    expect(await main(["hook", "inbox", "--mode", "steer"], steer)).toBe(0);
    const output = JSON.parse(steer.out());
    expect(output.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(output.hookSpecificOutput.additionalContext).toContain("second");

    const empty = io({ HARBORMASTER_TASK_ID: child });
    expect(await main(["hook", "inbox", "--mode", "follow-up"], empty)).toBe(0);
    expect(JSON.parse(empty.out())).toEqual({});
  });

  it("shapes each hook mode's JSON", () => {
    expect(inboxHookOutput("follow-up", "x")).toEqual({
      decision: "block",
      reason: "x",
    });
    expect(inboxHookOutput("catch-up", "x")).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "x",
      },
    });
    expect(inboxHookOutput("steer", "")).toEqual({});
  });
});

describe("parseFlags", () => {
  it("reads --k v, --k=v and bare flags", () => {
    expect([
      ...parseFlags(["--a", "1", "--b=2", "--c", "--d", "x"]).entries(),
    ]).toEqual([
      ["a", "1"],
      ["b", "2"],
      ["c", "true"],
      ["d", "x"],
    ]);
  });
});

describe("harbormaster mcp", () => {
  async function connect(caller: { taskId?: string }) {
    const mcp = createMcpServer({
      socketPath: resolveSocketPath(stateDir),
      caller,
    });
    const client = new Client({ name: "test", version: "0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      mcp.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return client;
  }

  it("lists exactly the catalog and forwards calls with the env identity", async () => {
    const parent = await launch("Parent work");
    const client = await connect({ taskId: parent });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      TOOL_CATALOG.map((tool) => tool.name),
    );
    const launched = await client.callTool({
      name: "launch_task",
      arguments: {
        relation: "child",
        title: "Via MCP",
        prompt: "p",
        repository: "none",
      },
    });
    expect(launched.isError).toBeFalsy();
    expect(JSON.stringify(launched.content)).toContain(
      'Launched \\"Via MCP\\"',
    );
    const children = await core.commands.listChildren(parent);
    expect(children.map((task) => task.title)).toEqual(["Via MCP"]);
    await client.close();
  });

  it("returns tool errors and a missing app as isError results", async () => {
    const client = await connect({});
    const denied = await client.callTool({
      name: "report_status",
      arguments: { status: "done" },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain(
      "only available inside a Harbormaster task session",
    );
    await server?.close();
    server = undefined;
    const down = await client.callTool({
      name: "find_tasks",
      arguments: { query: "x" },
    });
    expect(down.isError).toBe(true);
    expect(down.content).toEqual([
      { type: "text", text: "Harbormaster is not running" },
    ]);
    await client.close();
  });
});
