// The Codex adapter (docs/harness-additions.md X1-X11), pure parts: the
// `-c` TOML values, argv per SessionLaunch mode (verified against
// codex-cli 0.169.0's `--help` and real runs: options before the
// subcommand, `--` before the prompt), the per-session hooks/MCP/OSC 9
// overrides, the `codex queue` deliver command, Codex's own files (model
// cache, config.toml defaults, rollouts) and the usage reader on real
// rollouts (one from a logged-in run, one fork from the keyless stub).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexModelCatalogAccess,
  codexSessionIdFromPath,
  LocalCodexTranscriptAccess,
  topLevelTomlString,
} from "../src/access/codex-code-access.js";
import { parseCodexSessionUsage } from "../src/access/codex-session-usage-access.js";
import type { PresenceAccess } from "../src/contracts/services.js";
import {
  CODEX_REVIEW_SKILL,
  CodexHarnessAdapter,
  codexHookOverrides,
  codexSessionArgs,
} from "../src/harness/codex-adapter.js";
import { createHarnessRegistry } from "../src/harness/registry.js";
import {
  tomlLiteral,
  tomlOverride,
  tomlString,
  tomlValue,
} from "../src/harness/toml-value.js";

const SESSION = "01a1e9b8-423b-77b0-9d23-69f3fa042cd7";
const FIXTURES = join(import.meta.dirname, "fixtures", "usage", "codex");
const ROLLOUT = join(FIXTURES, `rollout-2026-11-17T15-35-29-${SESSION}.jsonl`);
const FORK = join(
  FIXTURES,
  "rollout-2026-11-17T18-18-04-01a1ea4d-1d67-78e3-865d-ae1f75e381e8.jsonl",
);

const noPresence = new Proxy({} as PresenceAccess, {
  get: (_target, key) =>
    key === "read" ? async () => undefined : async () => {},
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hm-codex-"));
  roots.push(root);
  return root;
}

function adapter(
  options: { cliPath?: string; exists?: boolean } = {},
): CodexHarnessAdapter {
  return new CodexHarnessAdapter({
    presence: noPresence,
    transcripts: { exists: () => options.exists ?? true },
    ...(options.cliPath ? { cliPath: options.cliPath } : {}),
  });
}

describe("tomlValue", () => {
  it("writes basic strings with every required escape", () => {
    expect(tomlString('say "hi"')).toBe('"say \\"hi\\""');
    expect(tomlString("C:\\path")).toBe('"C:\\\\path"');
    expect(tomlString("a\nb\tc\r")).toBe('"a\\nb\\tc\\r"');
    expect(tomlString("bell\x07")).toBe('"bell\\u0007"');
    expect(tomlString("ünïcode ✓")).toBe('"ünïcode ✓"');
  });

  it("writes arrays, numbers, booleans and inline tables (quoted keys when needed)", () => {
    expect(tomlValue(["a", 'b"c'])).toBe('["a","b\\"c"]');
    expect(tomlValue([])).toBe("[]");
    expect(tomlValue(10)).toBe("10");
    expect(tomlValue(false)).toBe("false");
    expect(
      tomlValue({
        HARBORMASTER_TASK_ID: "t1",
        "with space": "x",
        skip: undefined,
      }),
    ).toBe('{HARBORMASTER_TASK_ID="t1","with space"="x"}');
    expect(() => tomlValue(Number.NaN)).toThrow();
    expect(() => tomlValue(null)).toThrow();
  });

  it("writes the ''' literal form verbatim: absolute paths with spaces and shell quotes survive", () => {
    const command = `'/Applications/Harbor Master.app/bin/harbormaster' hook codex --event stop`;
    expect(tomlValue(tomlLiteral(command))).toBe(`'''${command}'''`);
    // A quote right before the closing delimiter is valid TOML.
    expect(tomlValue(tomlLiteral("it's'"))).toBe(`'''it's''''`);
    // Not representable as a literal: falls back to a basic string.
    expect(tomlValue(tomlLiteral("a'''b"))).toBe(`"a'''b"`);
    expect(tomlValue(tomlLiteral("\nleading"))).toBe('"\\nleading"');
    expect(tomlValue(tomlLiteral("bell\x07"))).toBe('"bell\\u0007"');
  });

  it("builds `key=value` overrides", () => {
    expect(tomlOverride("tui.notification_method", "osc9")).toBe(
      'tui.notification_method="osc9"',
    );
  });
});

describe("Codex launch spec", () => {
  const CLI = "/opt/Harbor Master/harbormaster";
  const input = {
    taskId: "task-1",
    workspacePath: "/work/task-1",
    stateDir: "/state",
  };

  it("passes hooks (X1), MCP (X6), network for the sandbox (X12) and OSC 9 notifications (X4) as -c overrides before everything else", () => {
    const spec = adapter({ cliPath: CLI }).buildLaunchSpec({
      ...input,
      session: { mode: "new", sessionId: "placeholder", model: "gpt-x" },
      initialPrompt: "-do it",
      permissions: "bypass",
    });
    const { args } = spec;
    expect(args.slice(0, 3)).toEqual([
      "--enable",
      "hooks",
      "--dangerously-bypass-hook-trust",
    ]);
    const overrides = args.filter((_arg, i) => args[i - 1] === "-c");
    expect(overrides).toEqual([
      `hooks.SessionStart=[{hooks=[{type="command",command='''${"'/opt/Harbor Master/harbormaster'"} hook codex --event session-start''',timeout=10}]}]`,
      `hooks.UserPromptSubmit=[{hooks=[{type="command",command='''${"'/opt/Harbor Master/harbormaster'"} hook codex --event user-prompt-submit''',timeout=10}]}]`,
      `hooks.PostToolUse=[{hooks=[{type="command",command='''${"'/opt/Harbor Master/harbormaster'"} hook codex --event post-tool-use''',timeout=10}]}]`,
      `hooks.Stop=[{hooks=[{type="command",command='''${"'/opt/Harbor Master/harbormaster'"} hook codex --event stop''',timeout=10}]}]`,
      `mcp_servers.harbormaster.command="${CLI}"`,
      'mcp_servers.harbormaster.args=["mcp"]',
      'mcp_servers.harbormaster.env={HARBORMASTER_TASK_ID="task-1",HARBORMASTER_STATE_DIR="/state",HARBORMASTER_SOCKET="/state/harbormaster.sock"}',
      'mcp_servers.harbormaster.cwd="/work/task-1"',
      "sandbox_workspace_write.network_access=true",
      'tui.notifications=["agent-turn-complete","approval-requested","plan-mode-prompt","async-question"]',
      'tui.notification_method="osc9"',
      'tui.notification_condition="always"',
    ]);
    // Bypass, model, then the prompt after `--` (a leading "-" stays text).
    expect(args.slice(-5)).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "gpt-x",
      "--",
      "-do it",
    ]);
    // The placeholder id never reaches the session (Codex picks its own).
    expect(spec.env.HARBORMASTER_SESSION_ID).toBeUndefined();
    expect(spec.command).toBe("codex");
  });

  it("maps every SessionLaunch mode to Codex's session words, after the options", () => {
    const words = (
      session: Parameters<typeof codexSessionArgs>[0],
      exists = true,
    ) => codexSessionArgs(session, () => exists);
    expect(words(undefined)).toEqual({ options: [], subcommand: [] });
    expect(
      words({ mode: "new", sessionId: "x", model: "m", thinking: "high" }),
    ).toEqual({
      options: ["-m", "m", "-c", 'model_reasoning_effort="high"'],
      subcommand: [],
    });
    expect(words({ mode: "new", sessionId: "x", thinking: "off" })).toEqual({
      options: [],
      subcommand: [],
    });
    expect(words({ mode: "resume", sessionId: SESSION })).toEqual({
      options: [],
      subcommand: ["resume", SESSION],
    });
    // A session Codex never wrote cannot be resumed: start fresh.
    expect(words({ mode: "resume", sessionId: SESSION }, false)).toEqual({
      options: [],
      subcommand: [],
    });
    expect(
      words({ mode: "fork", sessionId: "new", forkFrom: ROLLOUT }),
    ).toEqual({ options: [], subcommand: ["fork", SESSION] });
    expect(
      words({ mode: "fork", sessionId: "new", forkFrom: SESSION }),
    ).toEqual({ options: [], subcommand: ["fork", SESSION] });
    expect(words({ mode: "open", sessionPath: ROLLOUT })).toEqual({
      options: [],
      subcommand: ["resume", SESSION],
    });
    expect(words({ mode: "open", sessionPath: "/x/other.jsonl" })).toEqual({
      options: [],
      subcommand: ["resume", "--last"],
    });
    expect(words({ mode: "continue" })).toEqual({
      options: [],
      subcommand: ["resume", "--last"],
    });

    const resumed = adapter({ cliPath: CLI }).buildLaunchSpec({
      ...input,
      session: { mode: "resume", sessionId: SESSION },
      initialPrompt: "next",
    });
    expect(resumed.args.slice(-4)).toEqual(["resume", SESSION, "--", "next"]);
    expect(resumed.env.HARBORMASTER_SESSION_ID).toBe(SESSION);
    // Every option precedes the subcommand.
    const at = resumed.args.indexOf("resume");
    expect(resumed.args.slice(at).some((arg) => arg.startsWith("-c"))).toBe(
      false,
    );
  });

  it("the hook command survives shell parsing: one quoted path, then the subcommand", () => {
    const [, override] = codexHookOverrides("/a b/it's/harbormaster");
    expect(override).toContain(
      `command='''${"'/a b/it'\\''s/harbormaster'"} hook codex --event session-start'''`,
    );
  });

  it("delivers follow-ups and idle wake-ups with `codex queue` (X5), never steer", () => {
    const codex = adapter();
    expect(codex.deliverCommand("wakeIdle", SESSION, "hello")).toEqual({
      command: "codex",
      args: ["queue", "--thread", SESSION, "--message", "hello"],
    });
    expect(codex.deliverCommand("followUp", SESSION, "  ")).toBeUndefined();
    expect(codex.deliverCommand("followUp", "", "x")).toBeUndefined();
    expect(
      (
        codex.deliverCommand as (
          kind: string,
          id: string,
          text: string,
        ) => unknown
      )("steer", SESSION, "x"),
    ).toBeUndefined();
  });

  it("types the $plannotator-review skill for a review (X9)", () => {
    const codex = adapter();
    expect(codex.review.command({ kind: "local" })).toBe(CODEX_REVIEW_SKILL);
    expect(
      codex.review.command({
        kind: "pr",
        url: "https://github.com/a/b/pull/1",
      }),
    ).toBe("$plannotator-review https://github.com/a/b/pull/1");
  });

  it("is registered after Claude Code with the descriptor facts (X10)", () => {
    const ids = createHarnessRegistry({ presence: noPresence })
      .list()
      .map((entry) => entry.id);
    expect(ids).toEqual(["pi", "claude-code", "codex"]);
    const { descriptor, capabilities } = adapter();
    expect(descriptor.parseVersion("codex-cli 0.169.0")).toBe("0.169.0");
    expect(descriptor.configDir({}, "/home/me")).toBe("/home/me/.codex");
    expect(descriptor.configDir({ CODEX_HOME: "/x" }, "/home/me")).toBe("/x");
    expect(descriptor.reviewPieces).toEqual(["binary", "codex-skill"]);
    expect(descriptor.isShim("/var/folders/x/T/cmux-cli-shims/ABC/codex")).toBe(
      true,
    );
    expect(capabilities.sessionId).toBe("learned");
    expect(capabilities.status).toMatchObject({
      protocol: "osc7501",
      probe: false,
    });
  });
});

describe("Codex's own files", () => {
  it("names a rollout's session id", () => {
    expect(codexSessionIdFromPath(ROLLOUT)).toBe(SESSION);
    expect(codexSessionIdFromPath("/x/session.jsonl")).toBeUndefined();
  });

  it("finds rollouts under sessions/YYYY/MM/DD", () => {
    const home = tempRoot();
    const day = join(home, "sessions", "2026", "11", "17");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, `rollout-2026-11-17T15-35-29-${SESSION}.jsonl`),
      "",
    );
    const access = new LocalCodexTranscriptAccess({ homeDir: home });
    expect(access.exists(SESSION)).toBe(true);
    expect(access.exists("01a1e9b8-0000-0000-0000-000000000000")).toBe(false);
    expect(access.exists("../x")).toBe(false);
  });

  it("lists the cached models and reads the config.toml defaults", async () => {
    const home = tempRoot();
    const access = new CodexModelCatalogAccess({ homeDir: home });
    expect(await access.defaults()).toEqual({});
    const missing = await access.listModels();
    expect(missing.models).toEqual([]);
    expect(missing.error).toMatch(/model list/);
    writeFileSync(
      join(home, "config.toml"),
      [
        'notify = ["x"]',
        'model = "gpt-5.6-terra"',
        'model_reasoning_effort = "xhigh"',
        "",
        '[projects."/tmp/x"]',
        'model = "ignored"',
      ].join("\n"),
    );
    writeFileSync(
      join(home, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "gpt-hidden",
            visibility: "hide",
            supported_reasoning_levels: [],
          },
          {
            slug: "gpt-5.6-terra",
            visibility: "list",
            supported_reasoning_levels: [{ effort: "low" }],
          },
          { slug: "plain", visibility: "list", supported_reasoning_levels: [] },
        ],
      }),
    );
    expect(await access.listModels()).toEqual({
      models: [
        {
          id: "gpt-5.6-terra",
          provider: "openai",
          name: "gpt-5.6-terra",
          thinking: true,
        },
        { id: "plain", provider: "openai", name: "plain", thinking: false },
      ],
      defaultModel: "gpt-5.6-terra",
      defaultThinking: "xhigh",
    });
    expect(topLevelTomlString("a = 'lit'\n", "a")).toBe("lit");
    expect(topLevelTomlString('[t]\na = "x"\n', "a")).toBeUndefined();
  });
});

describe("Codex readSessionUsage (X11)", () => {
  it("sums token_usage_record lines per model on a real rollout, cached input as cache read", async () => {
    const usage = await adapter().readSessionUsage(ROLLOUT);
    expect(usage).toEqual({
      sessionPath: ROLLOUT,
      byModel: [
        {
          model: "gpt-5.6-terra",
          turns: 3,
          input: 16431 - 5888 + (16509 - 16128) + 16529,
          cacheRead: 5888 + 16128,
          cacheWrite: 0,
          output: 17,
        },
      ],
    });
  });

  it("a fork's rollout holds only its own turns (Codex references the parent's history)", async () => {
    const usage = await adapter().readSessionUsage(FORK);
    expect(usage?.forkedFrom).toBeUndefined();
    expect(usage?.byModel).toEqual([
      {
        model: "stub-model",
        turns: 1,
        input: 8,
        cacheRead: 2,
        cacheWrite: 0,
        output: 3,
      },
    ]);
  });

  it("skips records copied from another thread and falls back to token_count totals", () => {
    const line = (value: unknown) => JSON.stringify(value);
    const copied = parseCodexSessionUsage(
      "/s.jsonl",
      [
        line({ type: "session_meta", payload: { id: "me" } }),
        line({ type: "turn_context", payload: { turn_id: "t", model: "m" } }),
        line({
          type: "token_usage_record",
          payload: { thread_id: "parent", usage: { input_tokens: 99 } },
        }),
        line({
          type: "token_usage_record",
          payload: {
            thread_id: "me",
            response_id: "r1",
            turn_id: "t",
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        }),
      ].join("\n"),
    );
    expect(copied.byModel).toEqual([
      {
        model: "m",
        turns: 1,
        input: 5,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ]);
    const older = parseCodexSessionUsage(
      "/s.jsonl",
      [
        line({ type: "turn_context", payload: { model: "old" } }),
        ...[10, 10, 25].map((total, i) =>
          line({
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: { total_tokens: total },
                last_token_usage: { input_tokens: i + 1, output_tokens: 1 },
              },
            },
          }),
        ),
      ].join("\n"),
    );
    expect(older.byModel).toEqual([
      {
        model: "old",
        turns: 2,
        input: 4,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ]);
  });
});
