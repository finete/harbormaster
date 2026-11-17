// The Cursor CLI adapter (docs/harness-additions.md C1-C9): launch args per
// session mode, the per-session plugin directory, the C6 alias lookup and
// date versions, the model list, transcript layout, usage from stop-hook
// payloads (the transcript has none), and hook-fed presence in core.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CursorModelCatalogAccess,
  cursorProjectSlug,
  cursorSessionIdFromPath,
  cursorTranscriptPath,
  isCursorAgentBinary,
  parseCursorModelList,
  resolveCursorCommand,
} from "../src/access/cursor-code-access.js";
import {
  CursorSessionUsageAccess,
  cursorStopUsage,
  parseCursorUsageLedger,
} from "../src/access/cursor-session-usage-access.js";
import type { SessionLaunch } from "../src/contracts/harness.js";
import { HOOK_PRESENCE_STARTING } from "../src/contracts/harness.js";
import type { PresenceAccess } from "../src/contracts/services.js";
import { agentVersionFloor } from "../src/engines/agent-version.js";
import { compareSemver } from "../src/engines/review-support.js";
import {
  CURSOR_CAPABILITIES,
  CURSOR_DESCRIPTOR,
  CursorHarnessAdapter,
  cursorHookPresenceEvent,
  cursorPluginFiles,
  cursorSessionArgs,
  parseCursorVersion,
} from "../src/harness/cursor-adapter.js";
import { harnessLaunchCommand } from "../src/harness/descriptor.js";
import {
  HOOK_STOP_ERROR_MESSAGE,
  hookPresenceReading,
} from "../src/harness/hook-presence.js";
import { createHarnessRegistry } from "../src/harness/registry.js";
import { type Core, createCore } from "../src/index.js";
import { probeAgentCommand } from "../src/manager/agent-probe.js";

const dirs: string[] = [];
const cores: Core[] = [];
afterEach(() => {
  for (const core of cores.splice(0)) core.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "harbormaster-cursor-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const noPresence = new Proxy({} as PresenceAccess, {
  get: (_target, key) =>
    key === "read" ? async () => undefined : async () => {},
});

const CLI = "/opt/Harbor Master/bin/harbormaster";
const CHAT = "8834eead-98ee-4a2d-a2a8-b2fff2192041";
const OTHER = "5218b730-8fac-426e-8a52-f041a45c88e1";

function adapter(
  options: { exists?: boolean; cliPath?: string | null } = {},
): CursorHarnessAdapter {
  return new CursorHarnessAdapter({
    presence: noPresence,
    transcripts: { exists: () => options.exists ?? true },
    resolveCommand: () => ["agent"],
    ...(options.cliPath === null ? {} : { cliPath: options.cliPath ?? CLI }),
  });
}

function launch(
  session: SessionLaunch | undefined,
  extra: { initialPrompt?: string; permissions?: "bypass" | "default" } = {},
  subject = adapter(),
) {
  return subject.buildLaunchSpec({
    taskId: "task-1",
    workspacePath: "/work/task-1",
    stateDir: "/state",
    ...(session ? { session } : {}),
    ...extra,
  });
}

describe("Cursor launch spec (C1, C2)", () => {
  it("always skips the trust and MCP dialogs and loads the task's plugin dir", () => {
    const spec = launch({ mode: "new", sessionId: "placeholder" });
    expect(spec.command).toBe("agent");
    expect(spec.args.slice(0, 4)).toEqual([
      "--trust",
      "--approve-mcps",
      "--plugin-dir",
      "/state/cursor-plugins/task-1",
    ]);
    expect(spec.prepare?.dir).toBe("/state/cursor-plugins/task-1");
    expect(Object.keys(spec.prepare?.files ?? {}).sort()).toEqual([
      ".cursor-plugin/plugin.json",
      "hooks/hooks.json",
      "mcp.json",
    ]);
    // A new chat fires sessionStart; the learned id is never passed.
    expect(spec.hookStatus).toEqual({ ready: "hook" });
    expect(spec.env.HARBORMASTER_SESSION_ID).toBeUndefined();
  });

  it("maps each session mode to Cursor's flags", () => {
    const cwd = "/work/task-1";
    expect(cursorSessionArgs(undefined, cwd)).toEqual([]);
    expect(
      cursorSessionArgs({ mode: "new", sessionId: "x", model: "gpt-5.2" }, cwd),
    ).toEqual(["--model", "gpt-5.2"]);
    expect(cursorSessionArgs({ mode: "resume", sessionId: CHAT }, cwd)).toEqual(
      [`--resume=${CHAT}`, "--workspace", cwd],
    );
    // A chat Cursor never stored cannot be resumed: a fresh one.
    expect(
      cursorSessionArgs({ mode: "resume", sessionId: CHAT }, cwd, () => false),
    ).toEqual([]);
    // No fork in Cursor: the previous cycle's chat continues.
    const transcript = `/h/.cursor/projects/work-task-1/agent-transcripts/${OTHER}/${OTHER}.jsonl`;
    expect(
      cursorSessionArgs(
        { mode: "fork", sessionId: "x", forkFrom: transcript },
        cwd,
      ),
    ).toEqual([`--resume=${OTHER}`, "--workspace", cwd]);
    expect(
      cursorSessionArgs(
        { mode: "fork", sessionId: "x", forkFrom: "/gone.jsonl" },
        cwd,
        () => false,
      ),
    ).toEqual([]);
    expect(
      cursorSessionArgs({ mode: "open", sessionPath: transcript }, cwd),
    ).toEqual([`--resume=${OTHER}`, "--workspace", cwd]);
    expect(
      cursorSessionArgs({ mode: "open", sessionPath: "/x/notes.jsonl" }, cwd),
    ).toEqual(["--continue"]);
    expect(cursorSessionArgs({ mode: "continue" }, cwd)).toEqual([
      "--continue",
    ]);
  });

  it("waits for the pty to settle on a resume (no sessionStart fires)", () => {
    const resumed = launch({ mode: "resume", sessionId: CHAT });
    expect(resumed.hookStatus).toEqual({ ready: "quiet" });
    expect(resumed.env.HARBORMASTER_SESSION_ID).toBe(CHAT);
    expect(launch({ mode: "continue" }).hookStatus).toEqual({
      ready: "quiet",
    });
    expect(
      launch(
        { mode: "resume", sessionId: CHAT },
        {},
        adapter({ exists: false }),
      ).hookStatus,
    ).toEqual({ ready: "hook" });
  });

  it("bypass = -f; the prompt is positional after --", () => {
    const bypass = launch(undefined, {
      permissions: "bypass",
      initialPrompt: '-x it\'s "fine"',
    });
    expect(bypass.args).toContain("-f");
    expect(bypass.args.slice(-2)).toEqual(["--", '-x it\'s "fine"']);
    expect(launch(undefined).args).not.toContain("-f");
    expect(launch(undefined, { initialPrompt: "  " }).args.at(-1)).not.toBe(
      "--",
    );
  });

  it("writes nothing and loads no plugin without a CLI path", () => {
    const bare = launch(undefined, {}, adapter({ cliPath: null }));
    expect(bare.prepare).toBeUndefined();
    expect(bare.args).not.toContain("--plugin-dir");
  });

  it("names the plugin, registers the four hooks on the absolute CLI and the MCP server", () => {
    const files = cursorPluginFiles({
      cliPath: CLI,
      env: { HARBORMASTER_TASK_ID: "task-1" },
    });
    expect(JSON.parse(files[".cursor-plugin/plugin.json"] ?? "")).toMatchObject(
      { name: "harbormaster" },
    );
    const hooks = JSON.parse(files["hooks/hooks.json"] ?? "") as {
      version: number;
      hooks: Record<string, Array<{ command: string; timeout: number }>>;
    };
    expect(hooks.version).toBe(1);
    expect(Object.keys(hooks.hooks)).toEqual([
      "sessionStart",
      "beforeSubmitPrompt",
      "postToolUse",
      "stop",
    ]);
    expect(hooks.hooks.sessionStart?.[0]?.command).toBe(
      "'/opt/Harbor Master/bin/harbormaster' hook cursor --event session-start",
    );
    expect(hooks.hooks.stop?.[0]?.command).toMatch(/hook cursor --event stop$/);
    expect(JSON.parse(files["mcp.json"] ?? "")).toEqual({
      mcpServers: {
        harbormaster: {
          command: CLI,
          args: ["mcp"],
          env: { HARBORMASTER_TASK_ID: "task-1" },
        },
      },
    });
  });

  it("the plugin's MCP server carries the task identity", () => {
    const spec = launch({ mode: "new", sessionId: "x" });
    const mcp = JSON.parse(spec.prepare?.files["mcp.json"] ?? "") as {
      mcpServers: { harbormaster: { env: Record<string, string> } };
    };
    expect(mcp.mcpServers.harbormaster.env).toMatchObject({
      HARBORMASTER_TASK_ID: "task-1",
      HARBORMASTER_STATE_DIR: "/state",
    });
  });

  it("is registered after Codex with the descriptor facts (C6-C8)", () => {
    const ids = createHarnessRegistry({ presence: noPresence })
      .list()
      .map((entry) => entry.id);
    expect(ids).toEqual(["pi", "claude-code", "codex", "cursor"]);
    expect(CURSOR_DESCRIPTOR.commands).toEqual([
      ["agent"],
      ["cursor-agent"],
      ["cursor", "agent"],
    ]);
    expect(CURSOR_DESCRIPTOR.reviewPieces).toEqual([]);
    expect(CURSOR_DESCRIPTOR.configDir({}, "/home/me")).toBe(
      "/home/me/.cursor",
    );
    expect(
      CURSOR_DESCRIPTOR.configDir({ CURSOR_CONFIG_DIR: "/c" }, "/home/me"),
    ).toBe("/c");
    expect(CURSOR_CAPABILITIES).toMatchObject({
      sessionId: "learned",
      status: { protocol: "hooks", probe: false },
      delivery: { steer: false, followUp: true, wakeIdle: false },
      trustPrompt: false,
      review: false,
    });
    expect(adapter().review).toBeUndefined();
  });
});

describe("Cursor versions (C6, C8)", () => {
  it("parses the date-stamped version only", () => {
    expect(parseCursorVersion("2026.11.13-eacade1\n")).toBe("2026.11.13");
    expect(parseCursorVersion("2026.06.15")).toBe("2026.06.15");
    expect(parseCursorVersion("agent 1.2.3")).toBeUndefined();
    expect(parseCursorVersion("v12026.11.13")).toBeUndefined();
  });

  it("orders date versions with the shared comparison (semver unchanged)", () => {
    expect(compareSemver("2026.06.15", "2026.11.13")).toBeLessThan(0);
    expect(compareSemver("2026.11.13", "2026.11.13")).toBe(0);
    expect(compareSemver("2027.01.02", "2026.11.13")).toBeGreaterThan(0);
    expect(compareSemver("0.166.0", "0.169.0")).toBeLessThan(0);
    expect(agentVersionFloor("2026.05.30", CURSOR_DESCRIPTOR)).toBe(
      "below-min",
    );
    expect(agentVersionFloor("2026.11.13", CURSOR_DESCRIPTOR)).toBe("ok");
    expect(agentVersionFloor("2026.12.01", CURSOR_DESCRIPTOR)).toBe(
      "newer-than-verified",
    );
  });

  it("skips an `agent` that is not Cursor (its --version does not identify it)", async () => {
    const runs: string[] = [];
    const probe = await probeAgentCommand(CURSOR_DESCRIPTOR, {
      commandOverride: () => undefined,
      resolveCommandAll: async (binary: string) =>
        binary === "agent" || binary === "cursor-agent"
          ? [`/bin/${binary}`]
          : [],
      runVersion: async (path: string) => {
        runs.push(path);
        return path === "/bin/agent"
          ? { ok: true, output: "agent 3.1.0 (some other tool)\n" }
          : { ok: true, output: "2026.11.13-eacade1\n" };
      },
    } as never);
    expect(runs).toEqual(["/bin/agent", "/bin/cursor-agent"]);
    expect(probe).toMatchObject({
      command: "cursor-agent",
      path: "/bin/cursor-agent",
      version: "2026.11.13",
    });
  });

  it("resolves the launch command: agent only when it is Cursor's, then cursor-agent, then cursor agent", () => {
    const root = tempDir();
    const versions = join(root, "share", "cursor-agent", "versions", "2026");
    mkdirSync(versions, { recursive: true });
    const real = join(versions, "cursor-agent");
    writeFileSync(real, "#!/bin/sh\n");
    chmodSync(real, 0o755);
    const bin = join(root, "bin");
    const other = join(root, "other");
    mkdirSync(bin);
    mkdirSync(other);
    writeFileSync(join(other, "agent"), "#!/bin/sh\n");
    chmodSync(join(other, "agent"), 0o755);
    writeFileSync(join(other, "cursor"), "#!/bin/sh\n");
    chmodSync(join(other, "cursor"), 0o755);
    expect(isCursorAgentBinary(join(other, "agent"))).toBe(false);
    // A foreign `agent` first on PATH: the IDE's `cursor agent`.
    expect(resolveCursorCommand({ PATH: other })).toEqual(["cursor", "agent"]);
    symlinkSync(real, join(bin, "cursor-agent"));
    expect(resolveCursorCommand({ PATH: `${other}:${bin}` })).toEqual([
      "cursor-agent",
    ]);
    symlinkSync(real, join(bin, "agent"));
    expect(isCursorAgentBinary(join(bin, "agent"))).toBe(true);
    expect(resolveCursorCommand({ PATH: `${bin}:${other}` })).toEqual([
      "agent",
    ]);
    expect(resolveCursorCommand({ PATH: join(root, "none") })).toBeUndefined();
    // The override env var wins; the launch command follows the lookup.
    const subject = new CursorHarnessAdapter({
      presence: noPresence,
      resolveCommand: () => ["cursor", "agent"],
    });
    expect(subject.launchArgv({})).toEqual(["cursor", "agent"]);
    expect(
      subject.launchArgv({ HARBORMASTER_CURSOR_COMMAND: "/x/fake" }),
    ).toEqual(["/x/fake"]);
    expect(harnessLaunchCommand(subject, {})).toBe("cursor");
    const spec = subject.buildLaunchSpec({
      taskId: "t",
      workspacePath: "/w",
      stateDir: "/s",
    });
    expect([spec.command, spec.args[0]]).toEqual(["cursor", "agent"]);
  });
});

describe("Cursor files (C5)", () => {
  it("slugs workspace paths like Cursor (verified against ~/.cursor/projects)", () => {
    expect(cursorProjectSlug("/private/tmp/hm-probe-0Etk/cursor-wt1")).toBe(
      "private-tmp-hm-probe-0Etk-cursor-wt1",
    );
    expect(cursorProjectSlug("/Users/me/My Repo/.worktrees/x__y")).toBe(
      "Users-me-My-Repo-worktrees-x-y",
    );
    expect(cursorTranscriptPath("/h/.cursor", "/w/a", CHAT)).toBe(
      `/h/.cursor/projects/w-a/agent-transcripts/${CHAT}/${CHAT}.jsonl`,
    );
    expect(
      cursorSessionIdFromPath(
        `/h/.cursor/projects/w-a/agent-transcripts/${CHAT}/${CHAT}.jsonl`,
      ),
    ).toBe(CHAT);
    expect(cursorSessionIdFromPath(`/x/${CHAT}.jsonl`)).toBeUndefined();
  });

  it("predicts the transcript of a new chat for the real cwd", () => {
    const subject = new CursorHarnessAdapter({
      presence: noPresence,
      dataDir: "/h/.cursor",
    });
    expect(subject.expectedSessionFile("/w/a", CHAT)).toEqual({
      dir: `/h/.cursor/projects/w-a/agent-transcripts/${CHAT}`,
      fileSuffix: `${CHAT}.jsonl`,
    });
  });
});

describe("Cursor models", () => {
  it("parses --list-models (default marker, zero-width spaces)", () => {
    const parsed = parseCursorModelList(
      [
        "Available models",
        "",
        "auto - Auto (current, default)",
        "gpt-5.3-codex-low - Codex 5.3 Low",
        "grok-4.7-low-fast - Grok 4.7  Low Fast\u200b\u200b",
        "",
      ].join("\n"),
    );
    expect(parsed.current).toBe("auto");
    expect(parsed.models).toEqual([
      { id: "auto", provider: "cursor", name: "Auto", thinking: false },
      {
        id: "gpt-5.3-codex-low",
        provider: "cursor",
        name: "Codex 5.3 Low",
        thinking: false,
      },
      {
        id: "grok-4.7-low-fast",
        provider: "cursor",
        name: "Grok 4.7 Low Fast",
        thinking: false,
      },
    ]);
  });

  it("lists models when logged in, else reports the login and keeps the config default", async () => {
    const root = tempDir();
    const script = join(root, "fake-agent");
    writeFileSync(
      script,
      `#!/bin/sh\nif [ -f "${root}/logged-in" ]; then printf 'Available models\\n\\nauto - Auto (current, default)\\ngpt-5.2 - GPT-5.2\\n'; else echo "Error: Authentication required. Run 'agent login'"; exit 1; fi\n`,
    );
    chmodSync(script, 0o755);
    writeFileSync(
      join(root, "cli-config.json"),
      JSON.stringify({
        model: {
          modelId: "default",
          displayModelId: "auto",
          aliases: ["auto"],
        },
      }),
    );
    const access = () =>
      new CursorModelCatalogAccess({
        command: () => [script],
        configDir: root,
      });
    const out = await access().listModels();
    expect(out.models).toEqual([]);
    expect(out.error).toMatch(/not logged in/);
    expect(out.defaultModel).toBe("auto");
    writeFileSync(join(root, "logged-in"), "");
    const ok = await access().listModels();
    expect(ok.models.map((model) => model.id)).toEqual(["auto", "gpt-5.2"]);
    expect(ok.error).toBeUndefined();
  });
});

describe("Cursor usage (C5): stop-hook tokens, the transcript has none", () => {
  const FIXTURES = join(import.meta.dirname, "fixtures", "usage", "cursor");
  const transcript = join(FIXTURES, CHAT, `${CHAT}.jsonl`);
  const stops = readFileSync(join(FIXTURES, "stop-payloads.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  it("the real transcript records no tokens or model", () => {
    const text = readFileSync(transcript, "utf8");
    expect(text).not.toMatch(/tokens|"usage"|"model"/);
    expect(text).toContain('"turn_ended"');
  });

  it("maps a stop payload: input_tokens includes cache reads and writes", () => {
    expect(cursorStopUsage(stops[0] ?? {})).toEqual({
      model: "auto-smart",
      input: 4,
      output: 4,
      cacheRead: 8325,
      cacheWrite: 12388,
    });
    expect(cursorStopUsage({ status: "aborted" })).toBeUndefined();
  });

  it("sums the real chat's three stops (incl. the follow-up turn), each generation once", async () => {
    const stateDir = tempDir();
    const access = new CursorSessionUsageAccess({ stateDir });
    await expect(access.read(transcript)).resolves.toBeUndefined();
    for (const stop of [...stops, stops[2] ?? {}]) {
      const usage = cursorStopUsage(stop);
      if (!usage) continue;
      await access.record({
        sessionId: String(stop.conversation_id),
        generation: String(stop.generation_id),
        ...usage,
      });
    }
    const usage = await access.read(transcript);
    expect(usage).toEqual({
      sessionPath: transcript,
      byModel: [
        {
          model: "auto-smart",
          input: 12,
          output: 153,
          cacheRead: 49934,
          cacheWrite: 12788,
          turns: 3,
        },
      ],
    });
    expect(parseCursorUsageLedger("x", "not json\n").byModel).toEqual([]);
  });
});

describe("hook-fed presence (C3)", () => {
  const starting = {
    state: "working" as const,
    message: HOOK_PRESENCE_STARTING,
    at: "",
  };

  it("maps hook events to readings", () => {
    expect(hookPresenceReading(starting, { event: "start" })).toEqual({
      state: "idle",
    });
    // sessionStart racing a command-line prompt never stops a running turn.
    expect(
      hookPresenceReading({ state: "working", at: "" }, { event: "start" }),
    ).toBeUndefined();
    expect(hookPresenceReading(starting, { event: "prompt" })).toEqual({
      state: "working",
    });
    expect(
      hookPresenceReading(undefined, { event: "stop", status: "completed" }),
    ).toEqual({ state: "done" });
    expect(
      hookPresenceReading(undefined, { event: "stop", status: "aborted" }),
    ).toEqual({ state: "idle" });
    expect(
      hookPresenceReading(
        undefined,
        { event: "stop", status: "error", generation: "g1" },
        "g1",
      ),
    ).toBeUndefined();
    expect(
      hookPresenceReading(undefined, {
        event: "stop",
        status: "error",
        generation: "g2",
      }),
    ).toEqual({ state: "error", message: HOOK_STOP_ERROR_MESSAGE });
    expect(cursorHookPresenceEvent("stop", true)).toBe("prompt");
    expect(cursorHookPresenceEvent("stop", false)).toBe("stop");
    expect(cursorHookPresenceEvent("post-tool-use", false)).toBe("tool");
  });

  async function cursorTask(): Promise<{ core: Core; taskId: string }> {
    const stateDir = tempDir("harbormaster-cursor-core-");
    const codeRoot = join(stateDir, "Code");
    mkdirSync(codeRoot);
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ codeRoot }));
    const core = createCore({ stateDir });
    cores.push(core);
    const task = await core.commands.createTask({
      title: "Cursor",
      initialPrompt: "",
      harness: "cursor",
    });
    return { core, taskId: task.id };
  }

  const state = async (core: Core, taskId: string) =>
    (await core.commands.getPresence(taskId)).record?.status;

  it("applies hooks to the attachment the launcher registered, never creating one", async () => {
    const { core, taskId } = await cursorTask();
    await core.commands.reportHookPresence(taskId, { event: "prompt" });
    expect(await state(core, taskId)).toBeUndefined();
    await core.commands.reportPresence(taskId, {
      state: "working",
      message: HOOK_PRESENCE_STARTING,
      pid: process.pid,
    });
    // beforeSubmitPrompt before sessionStart (a command-line prompt).
    await core.commands.reportHookPresence(taskId, { event: "prompt" });
    await core.commands.reportHookPresence(taskId, { event: "start" });
    expect(await state(core, taskId)).toMatchObject({ state: "working" });
    expect((await core.commands.getPresence(taskId)).runningTurn).toBe(true);
    await core.commands.reportHookPresence(taskId, {
      event: "stop",
      status: "completed",
      generation: "g1",
    });
    expect(await state(core, taskId)).toMatchObject({ state: "done" });
    // Esc: aborted, then error for the same generation → idle, no warning.
    await core.commands.reportHookPresence(taskId, { event: "prompt" });
    await core.commands.reportHookPresence(taskId, {
      event: "stop",
      status: "aborted",
      generation: "g2",
    });
    await core.commands.reportHookPresence(taskId, {
      event: "stop",
      status: "error",
      generation: "g2",
    });
    expect(await state(core, taskId)).toMatchObject({ state: "idle" });
    // A real error warns.
    await core.commands.reportHookPresence(taskId, { event: "prompt" });
    await core.commands.reportHookPresence(taskId, {
      event: "stop",
      status: "error",
      generation: "g3",
    });
    expect(await state(core, taskId)).toMatchObject({
      state: "error",
      message: HOOK_STOP_ERROR_MESSAGE,
    });
  });

  it("start (sessionStart or the pty settling) ends the starting state only", async () => {
    const { core, taskId } = await cursorTask();
    await core.commands.reportPresence(taskId, {
      state: "working",
      message: HOOK_PRESENCE_STARTING,
      pid: process.pid,
    });
    expect((await core.commands.getPresence(taskId)).runningTurn).toBe(true);
    await core.commands.reportHookPresence(taskId, { event: "start" });
    expect(await state(core, taskId)).toMatchObject({ state: "idle" });
    // After an exit nothing is recorded.
    await core.commands.endPresence(taskId, { pid: process.pid });
    await core.commands.reportHookPresence(taskId, { event: "prompt" });
    expect((await core.commands.getPresence(taskId)).live).toBe(false);
  });
});
