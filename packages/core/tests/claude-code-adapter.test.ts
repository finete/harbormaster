import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeModelCatalogAccess,
  LocalClaudeTranscriptAccess,
} from "../src/access/claude-code-access.js";
import type { PresenceAccess } from "../src/contracts/services.js";
import {
  ClaudeCodeHarnessAdapter,
  claudeEffort,
  claudeSessionArgs,
  interpretClaudeProgramStatus,
} from "../src/harness/claude-code-adapter.js";
import { createCore } from "../src/index.js";

const noPresence = new Proxy({} as PresenceAccess, {
  get: (_target, key) =>
    key === "read" ? async () => undefined : async () => {},
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "harbormaster-claude-"));
  dirs.push(dir);
  return dir;
}

describe("ClaudeCodeHarnessAdapter.buildLaunchSpec", () => {
  const adapter = new ClaudeCodeHarnessAdapter({
    presence: noPresence,
    cliPath: "/Applications/Harbor Master.app/bin/harbormaster",
    transcripts: { exists: (id) => id === "persisted" },
  });

  it("launches a new task: session id, model, effort, bypass, hooks, MCP, then -- prompt", () => {
    const spec = adapter.buildLaunchSpec({
      taskId: "t1",
      workspacePath: "/w/t1",
      stateDir: "/state",
      session: {
        mode: "new",
        sessionId: "s-new",
        model: "opus",
        thinking: "xhigh",
      },
      permissions: "bypass",
      initialPrompt: "Fix the bug",
    });
    expect(spec.command).toBe("claude");
    expect(spec.args.slice(0, 7)).toEqual([
      "--session-id",
      "s-new",
      "--model",
      "opus",
      "--effort",
      "xhigh",
      "--dangerously-skip-permissions",
    ]);
    expect(spec.args.slice(-2)).toEqual(["--", "Fix the bug"]);
    const settings = JSON.parse(
      spec.args[spec.args.indexOf("--settings") + 1] ?? "",
    );
    const cli = "'/Applications/Harbor Master.app/bin/harbormaster'";
    expect(settings).toEqual({
      hooks: {
        PostToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: `${cli} hook inbox --mode steer`,
                timeout: 30,
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `${cli} hook inbox --mode follow-up`,
                timeout: 30,
              },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: `${cli} hook inbox --mode catch-up`,
                timeout: 30,
              },
            ],
          },
        ],
      },
    });
    const mcp = JSON.parse(
      spec.args[spec.args.indexOf("--mcp-config") + 1] ?? "",
    );
    expect(mcp).toEqual({
      mcpServers: {
        harbormaster: {
          type: "stdio",
          command: "/Applications/Harbor Master.app/bin/harbormaster",
          args: ["mcp"],
          env: {
            HARBORMASTER_TASK_ID: "t1",
            HARBORMASTER_STATE_DIR: "/state",
            HARBORMASTER_SOCKET: "/state/harbormaster.sock",
            HARBORMASTER_SESSION_ID: "s-new",
          },
        },
      },
    });
    expect(spec.env).toEqual({
      HARBORMASTER: "1",
      HARBORMASTER_TASK_ID: "t1",
      HARBORMASTER_STATE_DIR: "/state",
      HARBORMASTER_SESSION_ID: "s-new",
      HARBORMASTER_SOCKET: "/state/harbormaster.sock",
      HARBORMASTER_CLI: "/Applications/Harbor Master.app/bin/harbormaster",
    });
  });

  it("an interactive resume keeps the user's permissions and sends no prompt", () => {
    const spec = adapter.buildLaunchSpec({
      taskId: "t1",
      workspacePath: "/w/t1",
      stateDir: "/state",
      session: { mode: "resume", sessionId: "persisted" },
      permissions: "default",
    });
    expect(spec.args.slice(0, 3)).toEqual([
      "--resume",
      "persisted",
      "--settings",
    ]);
    expect(spec.args).not.toContain("--dangerously-skip-permissions");
    expect(spec.args).not.toContain("--");
  });

  it("re-creates a session that was never persisted instead of failing to resume it", () => {
    expect(
      claudeSessionArgs({ mode: "resume", sessionId: "s-1" }, () => false),
    ).toEqual(["--session-id", "s-1"]);
  });

  it("forks with --resume --fork-session --session-id, opens transcripts, continues", () => {
    expect(
      claudeSessionArgs({ mode: "fork", sessionId: "new", forkFrom: "old" }),
    ).toEqual(["--resume", "old", "--fork-session", "--session-id", "new"]);
    expect(
      claudeSessionArgs({ mode: "open", sessionPath: "/p/s.jsonl" }),
    ).toEqual(["--resume", "/p/s.jsonl"]);
    expect(claudeSessionArgs({ mode: "continue" })).toEqual(["--continue"]);
  });

  it("maps thinking levels onto --effort", () => {
    expect(claudeEffort(undefined)).toBeUndefined();
    expect(claudeEffort("off")).toBeUndefined();
    expect(claudeEffort("minimal")).toBe("low");
    expect(claudeEffort("medium")).toBe("medium");
    expect(claudeEffort("max")).toBe("max");
  });

  it("honors HARBORMASTER_CLAUDE_COMMAND for the command only", () => {
    process.env.HARBORMASTER_CLAUDE_COMMAND = "/tmp/fake-claude";
    try {
      const spec = adapter.buildLaunchSpec({
        taskId: "t1",
        workspacePath: "/w",
        stateDir: "/state",
      });
      expect(spec.command).toBe("/tmp/fake-claude");
    } finally {
      delete process.env.HARBORMASTER_CLAUDE_COMMAND;
    }
  });
});

describe("Claude Code access", () => {
  it("reads the default model and effort from Claude's settings, never failing", async () => {
    const dir = tempDir();
    const access = new ClaudeModelCatalogAccess({ configDir: dir });
    expect(await access.defaults()).toEqual({});
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ model: "sonnet", effortLevel: "high" }),
    );
    expect(await access.defaults()).toEqual({
      defaultModel: "sonnet",
      defaultThinking: "high",
    });
    const catalog = await access.listModels();
    expect(catalog.models.map((model) => model.id)).toContain("opus");
    expect(catalog.error).toBeUndefined();
    writeFileSync(join(dir, "settings.json"), "{broken");
    expect(await access.defaults()).toEqual({});
  });

  it("finds a persisted transcript in any project", () => {
    const dir = tempDir();
    const transcripts = new LocalClaudeTranscriptAccess({ configDir: dir });
    expect(transcripts.exists("abc")).toBe(false);
    mkdirSync(join(dir, "projects", "-w-t1"), { recursive: true });
    writeFileSync(join(dir, "projects", "-w-t1", "abc.jsonl"), "{}\n");
    expect(transcripts.exists("abc")).toBe(true);
    expect(transcripts.exists("../abc")).toBe(false);
  });
});

describe("Claude Code program status", () => {
  it.each([
    "1 shell still running",
    "2 shells still running",
    "1 shell, 1 monitor still running",
    "1 background agent still running",
    "3 cloud sessions still running",
  ])("a finished turn awaiting %j is idle, not a running turn", (message) => {
    expect(interpretClaudeProgramStatus({ state: "working", message })).toEqual(
      { state: "idle", message },
    );
  });

  it.each([
    { state: "working" as const },
    { state: "working" as const, message: "Running the test suite" },
    { state: "working" as const, message: "tests are still running" },
    { state: "done" as const, message: "1 shell still running" },
    { state: "blocked" as const, message: "approve Bash" },
  ])("leaves %j as reported", (report) => {
    expect(interpretClaudeProgramStatus(report)).toEqual(report);
  });

  it("reportPresence records a Claude task's background-only report as idle; a Pi task's as running", async () => {
    const stateDir = tempDir();
    const codeRoot = join(stateDir, "Code");
    mkdirSync(codeRoot);
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ codeRoot }));
    const core = createCore({ stateDir });
    const claude = await core.commands.createTask({
      title: "Claude",
      initialPrompt: "",
      harness: "claude-code",
    });
    const pi = await core.commands.createTask({
      title: "Pi",
      initialPrompt: "",
      harness: "pi",
    });
    const report = {
      state: "working" as const,
      message: "1 shell still running",
      pid: process.pid,
    };
    await core.commands.reportPresence(claude.id, report);
    await core.commands.reportPresence(pi.id, report);

    const claudePresence = await core.commands.getPresence(claude.id);
    expect(claudePresence.runningTurn).toBe(false);
    expect(claudePresence.record?.status).toMatchObject({
      state: "idle",
      message: "1 shell still running",
    });
    expect((await core.commands.getPresence(pi.id)).runningTurn).toBe(true);
    core.close();
  });
});
