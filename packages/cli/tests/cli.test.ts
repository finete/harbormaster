// The `harbormaster` CLI and MCP server against a real in-process socket
// server (what the app hosts) over a temp state dir: every catalog entry is
// reachable both ways, identity comes from the env, and a missing app is
// "Harbormaster is not running" (exit 2).

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("harbormaster inbox list / resolve, events, rules, addons", () => {
  async function seedInbox(items: unknown[]): Promise<void> {
    await mkdir(join(stateDir, "inbox"), { recursive: true });
    await writeFile(
      join(stateDir, "inbox", "items.json"),
      JSON.stringify({ version: 1, items }),
    );
  }

  it("lists rule items and approvals by tab and resolves them by button", async () => {
    await seedInbox([
      {
        id: "i-review",
        kind: "rule",
        source: "github",
        title: "Review requested: Fix it",
        buttons: [
          {
            id: "b0",
            label: "Create review task",
            action: "createTask",
            with: { title: "Review: Fix it", role: "reviewer" },
          },
          { id: "b1", label: "Dismiss", action: "dismiss" },
        ],
        createdAt: "2026-11-11T10:00:00.000Z",
      },
      {
        id: "i-fyi",
        kind: "rule",
        title: "Deployed to staging",
        priority: false,
        buttons: [],
        createdAt: "2026-11-11T09:00:00.000Z",
      },
    ]);
    const sender = await launch("Sender");
    const target = await launch("Target");
    const sent = await core.commands.sendTaskMessage({
      from: { kind: "task", taskId: sender },
      targetTaskId: target,
      text: "hello",
    });

    const priority = io();
    expect(await main(["inbox", "list", "--priority"], priority)).toBe(0);
    expect(priority.out()).toContain("i-review");
    expect(priority.out()).toContain(`approval:${sent.message.id}`);
    expect(priority.out()).not.toContain("i-fyi");
    const other = io();
    expect(await main(["inbox", "list", "--other", "--json"], other)).toBe(0);
    expect(
      (JSON.parse(other.out()) as { items: Array<{ id: string }> }).items.map(
        (item) => item.id,
      ),
    ).toEqual(["i-fyi"]);

    const press = io();
    expect(
      await main(["inbox", "resolve", "i-review", "Create review task"], press),
    ).toBe(0);
    expect(press.out()).toMatch(/^Create review task: task /);
    const tasks = (await core.commands.listBoard()).flatMap((column) =>
      column.groups.flatMap((group) => group.tasks),
    );
    expect(tasks.map((task) => task.title)).toContain("Review: Fix it");

    const dismiss = io();
    expect(await main(["inbox", "resolve", "i-fyi"], dismiss)).toBe(0);
    const approve = io();
    expect(
      await main(
        ["inbox", "resolve", `approval:${sent.message.id}`, "approve"],
        approve,
      ),
    ).toBe(0);
    const empty = io();
    expect(await main(["inbox", "list"], empty)).toBe(0);
    expect(empty.out()).toBe("Inbox is empty.\n");

    const bad = io();
    expect(await main(["inbox", "resolve", "nope"], bad)).toBe(1);
    expect(bad.err()).toContain("Inbox item not found: nope");
  });

  it("applies the configured priority filter (the same one the app uses)", async () => {
    await writeFile(
      join(stateDir, "config.json"),
      JSON.stringify({
        automation: false,
        inbox: { priorityFilter: 'item.source != "github"' },
      }),
    );
    await seedInbox([
      {
        id: "i-gh",
        kind: "rule",
        source: "github",
        title: "From GitHub",
        buttons: [],
        createdAt: "2026-11-11T10:00:00.000Z",
      },
    ]);
    const other = io();
    expect(await main(["inbox", "list", "--other"], other)).toBe(0);
    expect(other.out()).toContain("i-gh");
  });

  it("prints the audit log, rules, a dry run and addons", async () => {
    const events = io();
    expect(await main(["events", "--task", "t1"], events)).toBe(0);
    expect(events.out()).toBe("No events recorded.\n");
    const check = io();
    expect(await main(["rules", "check"], check)).toBe(0);
    expect(check.out()).toMatch(/^Replayed 0 events; 0 actions would run\./);
    const rules = io();
    expect(await main(["rules", "list", "--json"], rules)).toBe(0);
    expect(JSON.parse(rules.out())).toHaveProperty("files");
    const addons = io();
    expect(await main(["addons", "list"], addons)).toBe(0);
    expect(addons.out()).toContain("built-in");
    const usage = io();
    expect(await main(["events", "--bogus", "x"], usage)).toBe(64);
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
