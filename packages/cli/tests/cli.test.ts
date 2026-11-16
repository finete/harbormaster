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
  type DoctorReport,
  doctorExitCode,
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
  DOCTOR_WITHOUT_APP_NOTE,
  EXIT_NOT_RUNNING,
  EXIT_OPEN_URL_FAILED,
  formatDoctorOutput,
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
    const listing = JSON.parse(rules.out()) as {
      files: unknown[];
      enabled: boolean;
      activityWindowDays: number;
    };
    expect(listing).toHaveProperty("files");
    expect(listing.activityWindowDays).toBe(30);
    const off = io();
    expect(await main(["rules", "off"], off)).toBe(0);
    expect(off.out()).toBe("Rules are off.\n");
    expect((await core.commands.listRules()).enabled).toBe(false);
    await mkdir(join(stateDir, "rules"), { recursive: true });
    await writeFile(
      join(stateDir, "rules", "rules.yaml"),
      "rules:\n  - id: r1\n    label: Needs changes\n    on: github.pr.*\n    do: [{ action: move, with: { to: working } }]\n",
    );
    const text = io();
    expect(await main(["rules", "list"], text)).toBe(0);
    expect(text.out()).toMatch(/^Rules are off \(loaded but never run\)/);
    expect(text.out()).toContain(
      "  Needs changes  [r1, line 2]  on github.pr.*",
    );
    expect(text.out()).toContain("    never fired");
    const on = io();
    expect(await main(["rules", "on"], on)).toBe(0);
    expect((await core.commands.listRules()).enabled).toBe(true);
    const ruleEvents = io();
    expect(
      await main(
        ["events", "--rule", "r1", "--file", "rules.yaml"],
        ruleEvents,
      ),
    ).toBe(0);
    expect(ruleEvents.out()).toBe("No events recorded.\n");
    const addons = io();
    expect(await main(["addons", "list"], addons)).toBe(0);
    expect(addons.out()).toContain("built-in");
    const usage = io();
    expect(await main(["events", "--bogus", "x"], usage)).toBe(64);
  });
});

describe("harbormaster doctor", () => {
  const canned: DoctorReport = {
    checkedAt: "2026-01-01T00:00:00.000Z",
    checks: [
      {
        group: "tools",
        id: "tools.gh-auth",
        status: "fail",
        summary: "gh is not logged in",
        remediation: "Run `gh auth login` in a terminal.",
      },
      { group: "disk", id: "disk.free", status: "ok", summary: "9.0 GiB free" },
    ],
  };

  it("formats grouped output, with the no-app note when the app was down", () => {
    const body = [
      "Tools",
      "  ✗ tools.gh-auth  gh is not logged in",
      "      → Run `gh auth login` in a terminal.",
      "",
      "Disk",
      "  ✓ disk.free  9.0 GiB free",
      "",
      "1 ok, 0 warnings, 1 failed, 0 skipped",
    ].join("\n");
    expect(formatDoctorOutput(canned, { viaApp: true })).toBe(body);
    expect(formatDoctorOutput(canned, { viaApp: false })).toBe(
      `${DOCTOR_WITHOUT_APP_NOTE}\n\n${body}`,
    );
  });

  it("runs through the app, comparing this shell's PATH with the app's", async () => {
    const run = io({ PATH: "/only/in/the/shell" });
    const code = await main(["doctor", "--json"], run);
    const report = JSON.parse(run.out()) as DoctorReport & { viaApp: boolean };
    expect(report.viaApp).toBe(true);
    expect(code).toBe(doctorExitCode(report));
    const path = report.checks.find((check) => check.id === "path.loginShell");
    expect(path).toMatchObject({
      status: "warn",
      detail: "/only/in/the/shell",
    });
    expect(
      report.checks.find((check) => check.id === "socket.tool")?.status,
    ).toBe("ok");
  }, 30_000);

  it("falls back to an in-process core when the app is down; exit 1 on a failure", async () => {
    await server?.close();
    server = undefined;
    const run = io();
    let called = 0;
    run.localDoctor = async () => {
      called++;
      return canned;
    };
    expect(await main(["doctor"], run)).toBe(1);
    expect(called).toBe(1);
    expect(run.out().startsWith(DOCTOR_WITHOUT_APP_NOTE)).toBe(true);
    expect(run.out()).toContain("✗ tools.gh-auth");
    const json = io();
    json.localDoctor = async () => ({ ...canned, checks: [] });
    expect(await main(["doctor", "--json"], json)).toBe(0);
    expect(JSON.parse(json.out())).toMatchObject({ viaApp: false, checks: [] });
  });
});

describe("harbormaster doctor --all-remotes", () => {
  const remote: DoctorReport = {
    checkedAt: "2026-01-01T00:00:00.000Z",
    checks: [
      {
        group: "repos",
        id: "repos.remote",
        status: "warn",
        summary: "1 did not answer within 20 s (of 2 probed)",
        ms: 20_012,
        items: [
          {
            name: "github.com/acme/alpha",
            status: "ok",
            summary: "reachable",
            ms: 412,
          },
          {
            name: "github.com/acme/big",
            status: "warn",
            summary: "did not answer within 20 s",
            ms: 20_000,
          },
        ],
      },
    ],
  };

  it("passes probeAllRemotes and prints one line per repository", async () => {
    await server?.close();
    server = undefined;
    const inputs: unknown[] = [];
    const run = io();
    run.localDoctor = async (_env, input) => {
      inputs.push(input);
      return remote;
    };
    expect(await main(["doctor", "--all-remotes"], run)).toBe(0);
    expect(run.out()).toContain(
      [
        "  ! repos.remote  1 did not answer within 20 s (of 2 probed)",
        "      ✓ github.com/acme/alpha  reachable (412 ms)",
        "      ! github.com/acme/big  did not answer within 20 s (20000 ms)",
      ].join("\n"),
    );
    const plain = io();
    plain.localDoctor = async (_env, input) => {
      inputs.push(input);
      return remote;
    };
    expect(await main(["doctor", "--json"], plain)).toBe(0);
    expect(inputs).toEqual([{ probeAllRemotes: true }, {}]);
    expect(JSON.parse(plain.out()).checks[0]).toMatchObject({
      ms: 20_012,
      items: [{ ms: 412 }, { ms: 20_000 }],
    });
    const both = io();
    both.localDoctor = async (_env, input) => {
      inputs.push(input);
      return remote;
    };
    expect(await main(["doctor", "--all-remotes", "--json"], both)).toBe(0);
    expect(inputs[2]).toEqual({ probeAllRemotes: true });
    expect(await main(["doctor", "--all-remotes", "yes"], io())).toBe(64);
  });
});

describe("harbormaster open-url / review", () => {
  it("open-url opens a loopback URL for the env's task and emits task-url-opened", async () => {
    const task = await launch("Reviewable");
    const opened: unknown[] = [];
    core.events.on("task-url-opened", (payload) => opened.push(payload));
    const run = io({ HARBORMASTER_TASK_ID: task });
    expect(
      await main(
        ["open-url", "http://127.0.0.1:19432/", "--source", "plannotator"],
        run,
      ),
    ).toBe(0);
    const plain = io({ HARBORMASTER_TASK_ID: task });
    expect(await main(["open-url", "http://localhost:5173/x"], plain)).toBe(0);
    expect(opened).toEqual([
      { taskId: task, url: "http://127.0.0.1:19432/", source: "plannotator" },
      { taskId: task, url: "http://localhost:5173/x", source: "browser" },
    ]);
  });

  it("open-url exits 1 (so the handler falls back to `open`) for a non-loopback URL, outside a task, or with the app down", async () => {
    const task = await launch("Reviewable");
    const remote = io({ HARBORMASTER_TASK_ID: task });
    expect(await main(["open-url", "https://example.com/"], remote)).toBe(
      EXIT_OPEN_URL_FAILED,
    );
    expect(remote.err()).toContain("127.0.0.1, localhost or [::1]");
    const noTask = io();
    expect(await main(["open-url", "http://localhost:1/"], noTask)).toBe(
      EXIT_OPEN_URL_FAILED,
    );
    await server?.close();
    server = undefined;
    const down = io({ HARBORMASTER_TASK_ID: task });
    expect(await main(["open-url", "http://localhost:1/"], down)).toBe(1);
    expect(down.err()).toBe("Harbormaster is not running\n");
  });

  it("review sends the review command to the env's task (or --task), --local/--pr picking the target", async () => {
    const task = await launch("Reviewable");
    const run = io({ HARBORMASTER_TASK_ID: task });
    expect(await main(["review"], run)).toBe(0);
    expect(run.out()).toContain('Sent "/plannotator-review"');
    const local = io();
    expect(
      await main(["review", "--local", "--task", task, "--json"], local),
    ).toBe(0);
    expect(JSON.parse(local.out())).toEqual({
      taskId: task,
      command: "/plannotator-review",
    });
    const pr = io({ HARBORMASTER_TASK_ID: task });
    expect(await main(["review", "--pr"], pr)).toBe(1);
    expect(pr.err()).toContain("has no pull request");
    const both = io({ HARBORMASTER_TASK_ID: task });
    expect(await main(["review", "--local", "--pr"], both)).toBe(64);
    const outside = io();
    expect(await main(["review"], outside)).toBe(64);
    const messages = await core.commands.listMessages({ taskId: task });
    expect(messages.map((message) => [message.sender, message.text])).toEqual([
      [{ kind: "user" }, "/plannotator-review"],
      [{ kind: "user" }, "/plannotator-review"],
    ]);
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
