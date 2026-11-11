// The agent (harness adapter) contract suite (decision R15): every adapter
// the registry can hand out must pass the same checks, so adding an agent
// is "make this file green". Two layers:
//
// 1. Pure: launch-spec shape for every `SessionLaunch` mode, the env
//    markers, prompt defusing, permission bypass, messaging capabilities
//    consistent with what the launch spec wires up, and model catalogs that
//    never throw.
// 2. Process: the spec is actually exec'd (no shell, like node-pty) with
//    the adapter's command pointed at a fake CLI script that echoes its
//    argv/env as JSON, emits an OSC 7501 report, and, when the spec passes
//    Claude-style `--settings` hooks, runs the Stop hook command it was
//    given through `sh -c` (as Claude does). The output goes through the
//    real `ProgramStatusParser`.

import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  HarnessAdapter,
  HarnessModelCatalogAccess,
  LaunchSpec,
  SessionLaunch,
} from "../src/contracts/harness.js";
import type { PresenceAccess } from "../src/contracts/services.js";
import { ClaudeCodeHarnessAdapter } from "../src/harness/claude-code-adapter.js";
import { CustomHarnessAdapter } from "../src/harness/custom-adapter.js";
import { PiHarnessAdapter } from "../src/harness/pi-adapter.js";
import { createHarnessRegistry } from "../src/harness/registry.js";
import { ProgramStatusParser } from "../src/utilities/program-status.js";

const execFileAsync = promisify(execFile);

const STATE = "/state";
const WORK = "/work/task-1";
const CLI = "/opt/Harbor Master/bin/harbormaster";
const SESSION = "0b8a2f4e-0000-4000-8000-000000000001";
const OTHER = "0b8a2f4e-0000-4000-8000-000000000002";

const MODES: Record<string, SessionLaunch | undefined> = {
  none: undefined,
  new: { mode: "new", sessionId: SESSION, model: "m-1", thinking: "high" },
  resume: { mode: "resume", sessionId: SESSION },
  resumeWithPath: {
    mode: "resume",
    sessionId: SESSION,
    sessionPath: "/s/session.jsonl",
  },
  fork: { mode: "fork", sessionId: SESSION, forkFrom: OTHER },
  open: { mode: "open", sessionPath: "/s/session.jsonl" },
  continue: { mode: "continue" },
};

const noPresence = new Proxy({} as PresenceAccess, {
  get: (_target, key) =>
    key === "read" ? async () => undefined : async () => {},
});

const failingModels: HarnessModelCatalogAccess = {
  listModels: async () => {
    throw new Error("model list exploded");
  },
  defaults: async () => {
    throw new Error("settings exploded");
  },
};

interface Subject {
  name: string;
  /** Env var that swaps the launched command for a fake (custom agents use their configured command). */
  commandEnv?: string;
  /** How the adapter keeps a prompt from parsing as options: `--` before it, or nothing (generic CLIs). */
  defuse: "double-dash" | "none";
  make(options: {
    cliPath?: string;
    models?: HarnessModelCatalogAccess;
    command?: string;
  }): HarnessAdapter;
}

const SUBJECTS: Subject[] = [
  {
    name: "pi",
    commandEnv: "HARBORMASTER_PI_COMMAND",
    defuse: "double-dash",
    make: ({ cliPath, models }) =>
      new PiHarnessAdapter({
        presence: noPresence,
        ...(cliPath ? { cliPath } : {}),
        ...(models ? { models } : {}),
      }),
  },
  {
    name: "claude-code",
    commandEnv: "HARBORMASTER_CLAUDE_COMMAND",
    defuse: "double-dash",
    make: ({ cliPath, models }) =>
      new ClaudeCodeHarnessAdapter({
        presence: noPresence,
        transcripts: { exists: () => true },
        ...(cliPath ? { cliPath } : {}),
        ...(models ? { models } : {}),
      }),
  },
  {
    name: "custom",
    defuse: "none",
    make: ({ cliPath, command }) =>
      new CustomHarnessAdapter(
        {
          id: "any",
          label: "Any CLI",
          command: command ?? "any-cli",
          args: ["--flag", "x"],
        },
        { presence: noPresence, ...(cliPath ? { cliPath } : {}) },
      ),
  },
];

function spec(
  adapter: HarnessAdapter,
  session: SessionLaunch | undefined,
  extra: { initialPrompt?: string; permissions?: "bypass" | "default" } = {},
): LaunchSpec {
  return adapter.buildLaunchSpec({
    taskId: "task-1",
    workspacePath: WORK,
    stateDir: STATE,
    ...(session ? { session } : {}),
    ...extra,
  });
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe.each(SUBJECTS)("agent contract: $name", (subject) => {
  const adapter = subject.make({ cliPath: CLI });

  it("is in the registry under its id (built-ins) with a label", () => {
    expect(adapter.id).toMatch(/^[a-z0-9-]+$/);
    expect(adapter.label.length).toBeGreaterThan(0);
    if (subject.name !== "custom") {
      expect(createHarnessRegistry().get(adapter.id)?.id).toBe(adapter.id);
    }
  });

  it.each(Object.entries(MODES))(
    "builds a well-formed launch spec for session mode %s",
    (_mode, session) => {
      const built = spec(adapter, session, { initialPrompt: "do it" });
      expect(typeof built.command).toBe("string");
      expect(built.command.length).toBeGreaterThan(0);
      expect(built.cwd).toBe(WORK);
      expect(Array.isArray(built.args)).toBe(true);
      for (const arg of built.args) expect(typeof arg).toBe("string");
      for (const value of Object.values(built.env)) {
        expect(typeof value).toBe("string");
      }
      // Env markers (identity + where core lives) on every launch.
      expect(built.env).toMatchObject({
        HARBORMASTER: "1",
        HARBORMASTER_TASK_ID: "task-1",
        HARBORMASTER_STATE_DIR: STATE,
        HARBORMASTER_SOCKET: "/state/harbormaster.sock",
        HARBORMASTER_CLI: CLI,
      });
      if (session && "sessionId" in session) {
        expect(built.env.HARBORMASTER_SESSION_ID).toBe(session.sessionId);
      }
      // The prompt reaches the program exactly once.
      expect(built.args.filter((arg) => arg.includes("do it"))).toHaveLength(1);
    },
  );

  it("never offers the CLI or tools without a CLI path", () => {
    const bare = subject.make({});
    const built = spec(bare, MODES.new);
    expect(built.env.HARBORMASTER_CLI).toBeUndefined();
    expect(built.env.HARBORMASTER_MCP_SERVER).toBeUndefined();
    expect(built.args).not.toContain("--mcp-config");
    expect(built.args).not.toContain("--settings");
  });

  it("defuses prompts that look like options or attachments", () => {
    for (const prompt of [
      "-rf --help",
      "--model evil",
      "@secret.txt",
      "a\nb",
    ]) {
      const built = spec(adapter, MODES.new, { initialPrompt: prompt });
      const last = built.args.at(-1) ?? "";
      expect(last.trim()).toBe(prompt.trim());
      if (subject.defuse === "double-dash") {
        expect(built.args.at(-2)).toBe("--");
      }
    }
    // No prompt = no positional at all (and no dangling `--`).
    const none = spec(adapter, MODES.resume, { initialPrompt: "  " });
    expect(none.args.at(-1)).not.toBe("--");
  });

  it("bypasses permissions only when the launch says so", () => {
    const bypass = spec(adapter, MODES.new, { permissions: "bypass" });
    const normal = spec(adapter, MODES.new, { permissions: "default" });
    const omitted = spec(adapter, MODES.new);
    expect(normal.args).toEqual(omitted.args);
    expect(normal.args).not.toContain("--dangerously-skip-permissions");
    if (subject.name === "claude-code") {
      expect(bypass.args).toContain("--dangerously-skip-permissions");
    } else {
      // No permission system: the flag changes nothing.
      expect(bypass.args).toEqual(normal.args);
    }
  });

  it("declares messaging capabilities consistent with its inbox glue", () => {
    const { receive, steer, followUp, images } = adapter.messaging;
    if (!receive) {
      expect({ steer, followUp, images }).toEqual({
        steer: false,
        followUp: false,
        images: false,
      });
    } else {
      expect(steer || followUp).toBe(true);
    }
    const built = spec(adapter, MODES.new);
    const settings = flagValue(built.args, "--settings");
    if (settings) {
      // Hook-based glue: a hook per supported mode, nothing more.
      const hooks = (JSON.parse(settings) as { hooks: Record<string, unknown> })
        .hooks;
      expect("PostToolUse" in hooks).toBe(steer);
      expect("Stop" in hooks).toBe(followUp);
    }
    if (subject.name === "custom") expect(receive).toBe(false);
    else expect(receive).toBe(true);
  });

  it("never throws from its model catalog, even when the source fails", async () => {
    const failing = subject.make({ cliPath: CLI, models: failingModels });
    const catalog = await failing.listModels();
    expect(catalog.harness).toBe(failing.id);
    expect(catalog.label).toBe(failing.label);
    expect(Array.isArray(catalog.models)).toBe(true);
    await expect(failing.defaults()).resolves.toBeTypeOf("object");
    const real = await adapter.listModels();
    expect(Array.isArray(real.models)).toBe(true);
  });
});

// --- process level -------------------------------------------------------

let root: string;
let fakeCli: string;
let fakeHarbormaster: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "harbormaster-contract-"));
  // A stand-in `harbormaster`: answers the inbox hook like the real CLI does.
  fakeHarbormaster = join(root, "harbor master");
  writeFileSync(
    fakeHarbormaster,
    `#!/bin/sh\nprintf '{"decision":"block","reason":"inbox for %s (%s)"}' "$HARBORMASTER_TASK_ID" "$*"\n`,
  );
  chmodSync(fakeHarbormaster, 0o755);
  // The fake agent: echoes argv/env, emits OSC 7501, runs the Stop hook.
  fakeCli = join(root, "fake-agent.mjs");
  writeFileSync(
    fakeCli,
    String.raw`#!/usr/bin/env node
import { execSync } from "node:child_process";
const args = process.argv.slice(2);
let hook = null;
const at = args.indexOf("--settings");
if (at !== -1) {
  const command = JSON.parse(args[at + 1]).hooks.Stop[0].hooks[0].command;
  hook = JSON.parse(execSync(command, { shell: "/bin/sh", encoding: "utf8" }));
}
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.startsWith("HARBORMASTER")),
);
process.stdout.write("\x1b]7501;state=working\x07");
process.stdout.write(JSON.stringify({ args, cwd: process.cwd(), env, hook }));
process.stdout.write("\x1b]7501;state=blocked:kind=question\x07");
`,
  );
  chmodSync(fakeCli, 0o755);
  for (const key of [
    "HARBORMASTER_PI_COMMAND",
    "HARBORMASTER_CLAUDE_COMMAND",
  ]) {
    saved[key] = process.env[key];
    process.env[key] = fakeCli;
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe.each(SUBJECTS)("agent contract (process): $name", (subject) => {
  it("argv, env and the 7501 reports survive a real exec; hooks run", async () => {
    const adapter = subject.make({
      cliPath: fakeHarbormaster,
      command: fakeCli,
    });
    const prompt = "-n 'quoted' $HOME `x` @file\nline two";
    const built = adapter.buildLaunchSpec({
      taskId: "task-9",
      workspacePath: root,
      stateDir: root,
      session: { mode: "new", sessionId: SESSION },
      initialPrompt: prompt,
      permissions: "bypass",
    });
    expect(built.command).toBe(fakeCli);
    const { stdout } = await execFileAsync(built.command, built.args, {
      cwd: built.cwd,
      env: { PATH: process.env.PATH, ...built.env },
    });
    const parsed = new ProgramStatusParser().feed(stdout);
    expect(parsed.reports.map((report) => report.state)).toEqual([
      "working",
      "blocked",
    ]);
    const echoed = JSON.parse(parsed.output) as {
      args: string[];
      env: Record<string, string>;
      hook: { decision: string; reason: string } | null;
    };
    expect(echoed.args).toEqual(built.args);
    expect(echoed.args.at(-1)?.trim()).toBe(prompt.trim());
    expect(echoed.env.HARBORMASTER_TASK_ID).toBe("task-9");
    if (adapter.messaging.followUp && subject.name === "claude-code") {
      expect(echoed.hook).toEqual({
        decision: "block",
        reason: "inbox for task-9 (hook inbox --mode follow-up)",
      });
    } else {
      expect(echoed.hook).toBeNull();
    }
  });
});
