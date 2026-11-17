// Keyless real-CLI tier, T3 (decision R15; docs/harness-additions.md P5 and
// "Test tiers"): install the pinned `claude` and `pi` into a throwaway npm
// prefix, launch each with Harbormaster's exact launch spec (core's
// adapters) in a real pty, and assert every contract row that needs no
// model (`e2e/contracts/<harness>.ts`, `needsModel: false`), one test per
// row id, so a fake and the binary that drifted apart fail on the same row.
//
// Keyless, no network model: Claude gets a fake ANTHROPIC_API_KEY and Pi a
// `models.json` provider, both pointed at a local canned Messages-API stub
// (`startMessagesStub`), so turns, hooks, transcripts and session files are
// real while no model ever answers. The `harbormaster` CLI path in the
// launch spec is a logging stand-in, so hook stdin/env and the MCP server
// spawn are observable; Pi's inbox extension (packages/extension) talks to
// a stand-in socket. Rows that need a model are listed by id in the
// skipped block at the end for the real smoke (T4).
//
// Skipped unless HARBORMASTER_REAL_CLI=1 (it downloads ~100 MB). Optional:
// HARBORMASTER_REAL_CLI_PREFIX=<dir> reuses an install. Nothing touches the
// real ~/.claude or ~/.pi: HOME is the test sandbox (vitest.isolate-home)
// and CLAUDE_CONFIG_DIR / PI_CODING_AGENT_DIR point into the temp dir.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import {
  type AddressInfo,
  createServer as createNetServer,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type BuildLaunchSpecInput,
  ClaudeCodeHarnessAdapter,
  PiHarnessAdapter,
  ProgramStatusParser,
} from "@harbormaster/core";
import * as pty from "node-pty";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLAUDE_CODE_CONTRACT } from "../e2e/contracts/claude-code";
import { PI_CONTRACT } from "../e2e/contracts/pi";
import type { ContractRow } from "../e2e/contracts/types";

/** Pinned versions (bump deliberately; the smoke is what proves a bump). Must equal each contract's `version`. */
export const PINNED = {
  claude: "@anthropic-ai/claude-code@2.1.322",
  pi: "@earendil-works/pi-coding-agent@1.5.2",
} as const;

const enabled = process.env.HARBORMASTER_REAL_CLI === "1";
const EXTENSION_SOURCE = join(
  __dirname,
  "..",
  "..",
  "extension",
  "src",
  "index.ts",
);
/** A fake key: Claude accepts it once approved in `.claude.json`; it only ever reaches the local stub. */
const FAKE_KEY = "sk-ant-api03-harbormaster-keyless-smoke-0000000000000000";
const WAIT_MS = 45_000;
const SCENARIO_MS = 240_000;

// --- shared helpers -------------------------------------------------------------

let root: string;
let prefix: string;

/** Text with escapes and every whitespace removed (TUIs move the cursor instead of printing spaces). */
function squash(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes
      .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes
      .replace(/\x1b[()][0-9A-Za-z]/g, "")
      .replace(/\s+/g, "")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `predicate` until true or `timeoutMs`; resolves whether it held (never throws: rows assert). */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = WAIT_MS,
): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await sleep(150);
  }
  return predicate();
}

function bin(name: "claude" | "pi"): string {
  return join(prefix, "node_modules", ".bin", name);
}

function sandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "USER", "SHELL"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.TERM = "xterm-256color";
  return env;
}

/** One agent process in a pty, answering OSC 7501 probes like the app's pty layer (unless told not to). */
class PtyRun {
  raw = "";
  probes = 0;
  exitCode: number | null = null;
  readonly pid: number;
  private readonly child: pty.IPty;
  private readonly parser = new ProgramStatusParser();
  private readonly pendingReplies: string[] = [];
  private answer: boolean;

  constructor(
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      answer?: boolean;
      answerDelayMs?: number;
    },
  ) {
    this.answer = options.answer ?? true;
    const delay = options.answerDelayMs ?? 0;
    this.child = pty.spawn(command, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: options.cwd,
      env: options.env,
    });
    this.pid = this.child.pid;
    this.child.onData((data) => {
      this.raw += data;
      for (const reply of this.parser.feed(data).replies) {
        this.probes += 1;
        if (!this.answer) this.pendingReplies.push(reply);
        else if (delay > 0) setTimeout(() => this.child.write(reply), delay);
        else this.child.write(reply);
      }
    });
    this.child.onExit(({ exitCode }) => {
      this.exitCode = exitCode;
    });
  }

  /** Answers probes held back so far, and every later one. */
  answerProbes(): void {
    this.answer = true;
    for (const reply of this.pendingReplies.splice(0)) this.child.write(reply);
  }

  /** Every OSC 7501 body in order (`?` is a probe). */
  bodies(): string[] {
    return [
      // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 7501 framing
      ...this.raw.matchAll(/\x1b\]7501;([^\x07\x1b]*)(?:\x07|\x1b\\)/g),
    ].map((match) => match[1] as string);
  }

  reports(): string[] {
    return this.bodies().filter((body) => body !== "?");
  }

  screen(): string {
    return squash(this.raw);
  }

  shows(text: string): boolean {
    return this.screen().includes(squash(text));
  }

  write(text: string): void {
    this.child.write(text);
  }

  /** Types a line like a user: the text, then Enter on its own (a TUI treats text+CR in one chunk as a paste). */
  async typeLine(text: string): Promise<void> {
    this.child.write(text);
    await sleep(500);
    this.child.write("\r");
  }

  async stop(): Promise<void> {
    if (this.exitCode === null) {
      try {
        this.child.kill();
      } catch {}
      await waitFor(() => this.exitCode !== null, 5_000);
    }
  }

  tail(): string {
    return this.screen().slice(-800);
  }
}

/** A Messages-API stand-in: every turn answers "OK"; a prompt containing TOOL_TRIGGER first gets one Bash tool call. */
interface MessagesStub {
  url: string;
  /** Every request body, as received. */
  bodies: string[];
  seen(text: string): boolean;
  close(): Promise<void>;
}

const TOOL_TRIGGER = "hm-use-a-tool";

async function startMessagesStub(): Promise<MessagesStub> {
  const bodies: string[] = [];
  const server = createHttpServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      bodies.push(body);
      const url = request.url ?? "";
      if (request.method !== "POST" || !url.startsWith("/v1/messages")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            type: "error",
            error: { type: "not_found_error", message: "stub" },
          }),
        );
        return;
      }
      if (url.startsWith("/v1/messages/count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      let parsed: {
        model?: string;
        stream?: boolean;
        messages?: Array<{ role: string; content: unknown }>;
        tools?: Array<{ name?: string }>;
      } = {};
      try {
        parsed = JSON.parse(body);
      } catch {}
      // Claude interleaves `system` messages; the turn's input is the last user/assistant one.
      const last = parsed.messages
        ?.filter((message) => message.role !== "system")
        .at(-1);
      const blocks = (
        Array.isArray(last?.content) ? last.content : []
      ) as Array<{ type?: string; text?: string }>;
      const lastText =
        typeof last?.content === "string"
          ? last.content
          : blocks.map((block) => block.text ?? "").join("\n");
      const useTool =
        (parsed.tools ?? []).some((tool) => tool.name === "Bash") &&
        last?.role === "user" &&
        lastText.includes(TOOL_TRIGGER) &&
        !blocks.some((block) => block.type === "tool_result");
      const block = useTool
        ? {
            type: "tool_use",
            id: `toolu_stub_${bodies.length}`,
            name: "Bash",
            input: { command: "true", description: "smoke" },
          }
        : { type: "text", text: "OK" };
      const stopReason = useTool ? "tool_use" : "end_turn";
      const message = {
        id: `msg_stub_${bodies.length}`,
        type: "message",
        role: "assistant",
        model: parsed.model ?? "stub",
        content: [] as unknown[],
        stop_reason: null as string | null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (!parsed.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ...message,
            content: [block],
            stop_reason: stopReason,
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type: string, data: Record<string, unknown>): void => {
        response.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
        );
      };
      event("message_start", { message });
      if (block.type === "tool_use") {
        event("content_block_start", {
          index: 0,
          content_block: { ...block, input: {} },
        });
        event("content_block_delta", {
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        });
      } else {
        event("content_block_start", {
          index: 0,
          content_block: { type: "text", text: "" },
        });
        event("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "OK" },
        });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", {
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 1 },
      });
      event("message_stop", {});
      response.end();
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    seen: (text) => bodies.some((body) => body.includes(text)),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** One call of the logging `harbormaster` stand-in. */
interface CliCall {
  args: string[];
  env: Record<string, string>;
  stdin: string;
}

/**
 * Writes the logging stand-in for the `harbormaster` CLI: appends
 * `{ args, env, stdin }` per call to `log`; `hook inbox --mode <mode>`
 * prints (once) the reply file `<replies>/<mode>` if present, else `{}`;
 * `mcp` exits at once.
 */
function writeCliLogger(dir: string, log: string, replies: string): string {
  const file = join(dir, "harbormaster-logger.cjs");
  writeFileSync(
    file,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'const stdin = args[0] === "hook" ? fs.readFileSync(0, "utf8") : "";',
      'const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("HARBORMASTER")));',
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env, stdin }) + "\\n");`,
      'if (args[0] === "hook") {',
      `  const reply = ${JSON.stringify(replies)} + "/" + args[args.indexOf("--mode") + 1];`,
      '  let out = "{}";',
      '  try { out = fs.readFileSync(reply, "utf8"); fs.rmSync(reply); } catch {}',
      "  process.stdout.write(out);",
      "}",
      "",
    ].join("\n"),
  );
  execFileSync("chmod", ["755", file]);
  return file;
}

function readCalls(log: string): CliCall[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CliCall);
}

function hookInputs(
  log: string,
  event: string,
): Array<Record<string, unknown>> {
  return readCalls(log)
    .filter((call) => call.args[0] === "hook")
    .map((call) => {
      try {
        return JSON.parse(call.stdin) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((input) => input.hook_event_name === event);
}

/** Registers one test per contract row; `asserted` lets the coverage test below prove every keyless row has one. */
function rowTests(contract: { rows: readonly ContractRow[] }) {
  const asserted = new Set<string>();
  const rowIt = (
    id: string,
    fn: () => void | Promise<void>,
    timeout?: number,
  ): void => {
    const row = contract.rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`T3 asserts unknown row ${id}`);
    asserted.add(id);
    it(`${id}: ${row.title}`, fn, timeout);
  };
  const everyKeylessRowAsserted = (): void => {
    it("every keyless contract row has a T3 assertion", () => {
      const missing = contract.rows
        .filter((row) => !row.needsModel && !asserted.has(row.id))
        .map((row) => row.id);
      expect(missing).toEqual([]);
    });
  };
  return { rowIt, everyKeylessRowAsserted };
}

function launchInput(
  overrides: Partial<BuildLaunchSpecInput> & {
    taskId: string;
    workspacePath: string;
  },
): BuildLaunchSpecInput {
  return {
    stateDir: join(root, "state"),
    permissions: "bypass",
    ...overrides,
  };
}

// --- the tier -------------------------------------------------------------------

describe.skipIf(!enabled)("real CLI smoke (no API key)", () => {
  let stub: MessagesStub;

  beforeAll(async () => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "hm-real-cli-"));
    mkdirSync(join(root, "state"), { recursive: true });
    prefix = process.env.HARBORMASTER_REAL_CLI_PREFIX || join(root, "prefix");
    if (!existsSync(bin("claude")) || !existsSync(bin("pi"))) {
      execFileSync(
        "npm",
        [
          "install",
          "--prefix",
          prefix,
          "--no-audit",
          "--no-fund",
          "--no-save",
          PINNED.claude,
          PINNED.pi,
        ],
        { stdio: "inherit", timeout: 600_000 },
      );
    }
    stub = await startMessagesStub();
  }, 660_000);

  afterAll(async () => {
    await stub?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("PINNED matches the contracts' versions", () => {
    expect(PINNED.claude).toBe(
      `@anthropic-ai/claude-code@${CLAUDE_CODE_CONTRACT.version}`,
    );
    expect(PINNED.pi).toBe(
      `@earendil-works/pi-coding-agent@${PI_CONTRACT.version}`,
    );
  });

  describe("Claude Code", () => {
    const C = CLAUDE_CODE_CONTRACT;
    const { rowIt, everyKeylessRowAsserted } = rowTests(C);
    const SESSION = "6f1f9a64-3f0e-4c38-9a38-6c5f3b1f2c01";
    const FORKED = "6f1f9a64-3f0e-4c38-9a38-6c5f3b1f2c02";
    const IDLE_SESSION = "6f1f9a64-3f0e-4c38-9a38-6c5f3b1f2c03";
    const TRUST_SESSION = "6f1f9a64-3f0e-4c38-9a38-6c5f3b1f2c04";
    const LATE_SESSION = "6f1f9a64-3f0e-4c38-9a38-6c5f3b1f2c05";
    const FIRST_PROMPT = `-hm-first-prompt ${TOOL_TRIGGER}`;
    const CATCH_UP = "hm-catch-up-context";
    const STEER = "hm-steer-context";
    const FOLLOW_UP = "hm-follow-up-reason";
    const BOGUS = "/hm-smoke-bogus";
    const SKILL_MARKER = "hm-skill-body-at-start";
    const LIVE_MARKER = "hm-skill-body-live";
    const TASK = "smoke-claude";

    let configDir: string;
    let workspace: string;
    let log: string;
    let replies: string;
    let cli: string;
    // Observations, filled by the scenario in beforeAll and asserted per row.
    const o = {
      version: "",
      pluginsNone: "",
      pluginsInstalled: "",
      main: undefined as PtyRun | undefined,
      mainDone: false,
      unknownReply: false,
      skillAtStartRan: false,
      skillAtStartUnknown: true,
      liveReloadRan: false,
      liveReloadUnknown: true,
      liveRemoveUnknown: false,
      resumed: undefined as PtyRun | undefined,
      resumeHistory: false,
      forked: undefined as PtyRun | undefined,
      forkHistory: false,
      idle: undefined as PtyRun | undefined,
      late: undefined as PtyRun | undefined,
      reportsBeforeAnswer: [] as string[],
      reportsAfterLateAnswer: [] as string[],
      readyAfterAnswer: false,
      trust: undefined as PtyRun | undefined,
      trustShown: false,
      reportsDuringTrust: [] as string[],
      bypassShown: false,
      readyAfterDialogs: false,
      trustConfig: "",
      brokenMcp: undefined as PtyRun | undefined,
    };

    const adapter = (cliPath = cli): ClaudeCodeHarnessAdapter =>
      new ClaudeCodeHarnessAdapter({
        cliPath,
        configDir,
        transcripts: { exists: () => true },
      });

    const claudeEnv = (config = configDir): Record<string, string> => ({
      ...sandboxEnv(),
      CLAUDE_CONFIG_DIR: config,
      ANTHROPIC_API_KEY: FAKE_KEY,
      ANTHROPIC_BASE_URL: stub.url,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    });

    /** Onboarded config with the fake key approved; `trusted` folders pre-accepted. */
    const writeConfig = (dir: string, trusted: string[], bypass: boolean) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, ".claude.json"),
        JSON.stringify({
          hasCompletedOnboarding: true,
          theme: "dark",
          customApiKeyResponses: {
            approved: [FAKE_KEY.slice(-20)],
            rejected: [],
          },
          projects: Object.fromEntries(
            trusted.map((path) => [path, { hasTrustDialogAccepted: true }]),
          ),
        }),
      );
      if (bypass) {
        writeFileSync(
          join(dir, "settings.json"),
          JSON.stringify({
            [String(C.row("claude.trust.bypass-warning").facts.persisted)]:
              true,
          }),
        );
      }
    };

    const reply = (mode: string, value: unknown): void =>
      writeFileSync(join(replies, mode), JSON.stringify(value));

    const run = (
      input: BuildLaunchSpecInput,
      options: { answer?: boolean; config?: string; cliPath?: string } = {},
      mapArgs: (args: string[]) => string[] = (args) => args,
    ): PtyRun => {
      const spec = adapter(options.cliPath).buildLaunchSpec(input);
      return new PtyRun(bin("claude"), mapArgs(spec.args), {
        cwd: spec.cwd,
        env: { ...claudeEnv(options.config), ...spec.env },
        answer: options.answer,
      });
    };

    const skill = (name: string, body: string): string => {
      const dir = join(configDir, "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: smoke\n---\n${body}\n`,
      );
      return dir;
    };

    beforeAll(async () => {
      configDir = join(root, "claude-config");
      workspace = join(root, "claude-work");
      mkdirSync(workspace, { recursive: true });
      writeConfig(configDir, [realpathSync(workspace)], true);
      log = join(root, "claude-cli.log");
      replies = join(root, "claude-replies");
      mkdirSync(replies, { recursive: true });
      cli = writeCliLogger(root, log, replies);
      const env = claudeEnv();

      // Plain commands.
      o.version = execFileSync(bin("claude"), ["--version"], {
        env,
        encoding: "utf8",
      }).trim();
      const pluginConfig = join(root, "claude-plugins");
      mkdirSync(pluginConfig, { recursive: true });
      const pluginEnv = { ...env, CLAUDE_CONFIG_DIR: pluginConfig };
      const list = C.row("claude.plugin.list-json").facts;
      o.pluginsNone = execFileSync(bin("claude"), [...list.args], {
        env: pluginEnv,
        encoding: "utf8",
      }).trim();
      const market = join(root, "plannotator-market");
      mkdirSync(join(market, ".claude-plugin"), { recursive: true });
      mkdirSync(join(market, "plannotator", ".claude-plugin"), {
        recursive: true,
      });
      writeFileSync(
        join(market, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "plannotator",
          owner: { name: "smoke" },
          plugins: [
            {
              name: "plannotator",
              source: "./plannotator",
              description: "smoke",
            },
          ],
        }),
      );
      writeFileSync(
        join(market, "plannotator", ".claude-plugin", "plugin.json"),
        JSON.stringify({
          name: "plannotator",
          version: list.plannotatorVersion,
          description: "smoke",
        }),
      );
      execFileSync(bin("claude"), ["plugin", "marketplace", "add", market], {
        env: pluginEnv,
        stdio: "ignore",
      });
      execFileSync(bin("claude"), ["plugin", "install", list.plannotatorId], {
        env: pluginEnv,
        stdio: "ignore",
      });
      o.pluginsInstalled = execFileSync(bin("claude"), [...list.args], {
        env: pluginEnv,
        encoding: "utf8",
      }).trim();

      // Main session: a new session with a prompt that makes the stub call
      // one tool, so every hook fires; inbox-style hook replies on each.
      skill("hm-smoke-skill", SKILL_MARKER);
      const gone = skill("hm-smoke-gone", "hm-skill-body-gone");
      reply("catch-up", {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: CATCH_UP,
        },
      });
      reply("steer", {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: STEER,
        },
      });
      reply("follow-up", { decision: "block", reason: FOLLOW_UP });
      const main = run(
        launchInput({
          taskId: TASK,
          workspacePath: workspace,
          session: { mode: "new", sessionId: SESSION },
          initialPrompt: FIRST_PROMPT,
        }),
      );
      o.main = main;
      const turn = C.row("claude.status.turn").facts;
      o.mainDone = await waitFor(
        () =>
          hookInputs(log, "Stop").some((input) => input.stop_hook_active) &&
          main.reports().lastIndexOf(turn.done) >
            main.reports().indexOf(turn.working),
      );
      const unknown = C.row("claude.command.unknown").facts.reply;
      await main.typeLine(BOGUS);
      o.unknownReply = await waitFor(() =>
        main.shows(`${unknown}${BOGUS.slice(1)}`),
      );
      await main.typeLine("/hm-smoke-skill");
      o.skillAtStartRan = await waitFor(() => stub.seen(SKILL_MARKER));
      o.skillAtStartUnknown = main.shows(`${unknown}hm-smoke-skill`);
      skill("hm-smoke-live", LIVE_MARKER);
      // Skills are watched, not polled on use: let the watcher see it.
      await sleep(2_000);
      await main.typeLine("/hm-smoke-live");
      o.liveReloadRan = await waitFor(() => stub.seen(LIVE_MARKER));
      o.liveReloadUnknown = main.shows(`${unknown}hm-smoke-live`);
      // A skill present at start (never used) removed mid-session.
      rmSync(gone, { recursive: true, force: true });
      await sleep(2_000);
      await main.typeLine("/hm-smoke-gone");
      o.liveRemoveUnknown = await waitFor(() =>
        main.shows(`${unknown}hm-smoke-gone`),
      );
      await main.stop();

      // Resume, then fork, the same session.
      const resumed = run(
        launchInput({
          taskId: TASK,
          workspacePath: workspace,
          session: { mode: "resume", sessionId: SESSION },
        }),
      );
      o.resumed = resumed;
      await waitFor(() => resumed.reports().length > 0);
      const stopsBefore = hookInputs(log, "Stop").length;
      await resumed.typeLine("hm-resume-prompt");
      o.resumeHistory = await waitFor(() =>
        stub.bodies.some(
          (body) =>
            body.includes("hm-resume-prompt") &&
            body.includes("hm-first-prompt"),
        ),
      );
      await waitFor(() => hookInputs(log, "Stop").length > stopsBefore);
      await resumed.stop();
      const forked = run(
        launchInput({
          taskId: TASK,
          workspacePath: workspace,
          session: { mode: "fork", forkFrom: SESSION, sessionId: FORKED },
        }),
      );
      o.forked = forked;
      await waitFor(() => forked.reports().length > 0);
      await forked.typeLine("hm-fork-prompt");
      o.forkHistory = await waitFor(() =>
        stub.bodies.some(
          (body) =>
            body.includes("hm-fork-prompt") && body.includes("hm-first-prompt"),
        ),
      );
      await waitFor(() =>
        hookInputs(log, "UserPromptSubmit").some(
          (input) => input.session_id === FORKED,
        ),
      );
      await forked.stop();

      // The probe: answered within the window → idle; answered late → nothing, ever.
      const probe = C.row("claude.status.probe").facts;
      const ready = C.row("claude.status.ready").facts.report;
      const idle = run(
        launchInput({
          taskId: TASK,
          workspacePath: workspace,
          session: { mode: "new", sessionId: IDLE_SESSION },
        }),
        { answerDelayMs: probe.answeredWithinMs },
      );
      o.idle = idle;
      o.readyAfterAnswer = await waitFor(() => idle.reports().includes(ready));
      await idle.stop();
      const late = run(
        launchInput({
          taskId: TASK,
          workspacePath: workspace,
          session: { mode: "new", sessionId: LATE_SESSION },
        }),
        { answer: false },
      );
      o.late = late;
      await waitFor(() => late.probes > 0);
      // The behavior is "nothing happens": give Claude time to (not) report.
      await sleep(probe.givesUpByMs + 1_000);
      o.reportsBeforeAnswer = late.reports();
      late.answerProbes();
      await sleep(3_000);
      o.reportsAfterLateAnswer = late.reports();
      await late.stop();

      // A never-trusted folder under a config that never accepted bypass.
      const trustConfig = join(root, "claude-config-fresh");
      writeConfig(trustConfig, [], false);
      const fresh = join(root, "claude-fresh");
      mkdirSync(fresh, { recursive: true });
      const trust = run(
        launchInput({
          taskId: TASK,
          workspacePath: fresh,
          session: { mode: "new", sessionId: TRUST_SESSION },
        }),
        { config: trustConfig },
      );
      o.trust = trust;
      const folder = C.row("claude.trust.folder").facts;
      o.trustShown = await waitFor(
        () => trust.shows(folder.question) && trust.shows(folder.accept),
      );
      await sleep(500);
      o.reportsDuringTrust = trust.reports();
      trust.write("\x1b[B");
      await sleep(400);
      trust.write("\r");
      const bypass = C.row("claude.trust.bypass-warning").facts;
      o.bypassShown = await waitFor(
        () => trust.shows(bypass.warning) && trust.shows(bypass.accept),
      );
      trust.write("\x1b[B");
      await sleep(400);
      trust.write("\r");
      o.readyAfterDialogs = await waitFor(() =>
        trust.reports().includes(ready),
      );
      await trust.stop();
      o.trustConfig = ["/.claude.json", "/settings.json"]
        .map((file) => {
          try {
            return readFileSync(trustConfig + file, "utf8");
          } catch {
            return "";
          }
        })
        .join("\n");

      // Control: a broken --mcp-config.
      const broken = run(
        launchInput({ taskId: TASK, workspacePath: workspace }),
        {},
        (args) => {
          const next = [...args];
          next[next.indexOf("--mcp-config") + 1] = "{not json";
          return next;
        },
      );
      o.brokenMcp = broken;
      await waitFor(() => broken.exitCode !== null, 20_000);
      await broken.stop();
      console.log(
        "[real-cli-smoke] claude",
        JSON.stringify({
          main: main.reports(),
          tail: main.tail(),
          hooks: readCalls(log).map((call) => call.args.join(" ")),
        }),
      );
    }, SCENARIO_MS);

    afterAll(async () => {
      for (const run of [
        o.main,
        o.resumed,
        o.forked,
        o.idle,
        o.late,
        o.trust,
        o.brokenMcp,
      ]) {
        await run?.stop();
      }
    });

    rowIt("claude.version", () => {
      const facts = C.row("claude.version").facts;
      expect(o.version).toMatch(new RegExp(facts.pattern));
      expect(o.version).toBe(facts.output);
    });

    rowIt("claude.plugin.list-json", () => {
      const facts = C.row("claude.plugin.list-json").facts;
      expect(JSON.parse(o.pluginsNone)).toEqual(JSON.parse(facts.none));
      const entries = JSON.parse(o.pluginsInstalled) as Array<
        Record<string, unknown>
      >;
      const entry = entries.find((e) => e.id === facts.plannotatorId);
      expect(entry).toBeDefined();
      for (const key of facts.entryKeys) expect(entry).toHaveProperty(key);
      expect(entry?.version).toBe(facts.plannotatorVersion);
      expect(entry?.enabled).toBe(true);
    });

    rowIt("claude.argv.session-id", () => {
      expect(o.main?.raw).toBeTruthy();
      expect(o.main?.exitCode).not.toBe(1);
      const inputs = hookInputs(log, "UserPromptSubmit");
      expect(inputs[0]?.session_id).toBe(SESSION);
    });

    rowIt("claude.argv.resume", () => {
      expect(o.resumeHistory).toBe(true);
      expect(
        hookInputs(log, "UserPromptSubmit").some(
          (input) =>
            input.session_id === SESSION && input.prompt === "hm-resume-prompt",
        ),
      ).toBe(true);
    });

    rowIt("claude.argv.fork", () => {
      expect(o.forkHistory).toBe(true);
      expect(
        hookInputs(log, "UserPromptSubmit").some(
          (input) =>
            input.session_id === FORKED && input.prompt === "hm-fork-prompt",
        ),
      ).toBe(true);
      const dir = adapter().expectedSessionFile(
        realpathSync(workspace),
        FORKED,
      );
      expect(existsSync(join(dir?.dir ?? "", dir?.fileSuffix ?? ""))).toBe(
        true,
      );
    });

    rowIt("claude.argv.bypass", () => {
      const mode = C.row("claude.argv.bypass").facts.permissionMode;
      expect(hookInputs(log, "UserPromptSubmit")[0]?.permission_mode).toBe(
        mode,
      );
    });

    rowIt("claude.argv.settings", () => {
      // Every hook in our --settings ran, and nothing was written to the config dir.
      const facts = C.row("claude.argv.settings").facts;
      for (const event of facts.hookEvents) {
        expect(hookInputs(log, event).length, event).toBeGreaterThan(0);
      }
      expect(
        readFileSync(join(configDir, "settings.json"), "utf8"),
      ).not.toContain("hook inbox");
    });

    rowIt("claude.argv.mcp-config", () => {
      const facts = C.row("claude.argv.mcp-config").facts;
      const spawned = readCalls(log).find((call) => call.args[0] === "mcp");
      expect(spawned?.env.HARBORMASTER_TASK_ID).toBe(TASK);
      expect(spawned?.env.HARBORMASTER_SESSION_ID).toBe(SESSION);
      // The control: invalid JSON is rejected and Claude exits.
      expect(o.brokenMcp?.screen()).toContain(squash(facts.invalid));
      expect(o.brokenMcp?.exitCode).not.toBeNull();
    });

    rowIt("claude.prompt.after-dashdash", () => {
      expect(hookInputs(log, "UserPromptSubmit")[0]?.prompt).toBe(FIRST_PROMPT);
      expect(stub.seen(FIRST_PROMPT)).toBe(true);
    });

    rowIt("claude.env.config-dir", () => {
      const facts = C.row("claude.env.config-dir").facts;
      // Skills came from it (claude.command.skill), transcripts land in it.
      expect(o.skillAtStartRan).toBe(true);
      expect(existsSync(join(configDir, facts.projects))).toBe(true);
    });

    rowIt("claude.status.probe", () => {
      const facts = C.row("claude.status.probe").facts;
      expect(o.idle?.raw).toContain(facts.probe);
      expect(o.idle?.bodies()[0]).toBe("?");
      // Answered within the window: reports.
      expect(o.readyAfterAnswer).toBe(true);
      // Answered too late: never reports, not even after the answer.
      expect(o.late?.probes).toBeGreaterThan(0);
      expect(o.reportsBeforeAnswer).toEqual([]);
      expect(o.reportsAfterLateAnswer).toEqual([]);
    });

    rowIt("claude.status.ready", () => {
      const facts = C.row("claude.status.ready").facts;
      expect(o.idle?.reports()[0]).toBe(facts.report);
    });

    rowIt("claude.status.turn", () => {
      const facts = C.row("claude.status.turn").facts;
      expect(o.mainDone).toBe(true);
      const reports = o.main?.reports() ?? [];
      expect(reports).toContain(facts.working);
      expect(reports.lastIndexOf(facts.done)).toBeGreaterThan(
        reports.indexOf(facts.working),
      );
    });

    rowIt("claude.hook.command-shell", () => {
      const facts = C.row("claude.hook.command-shell").facts;
      const hooks = readCalls(log).filter((call) => call.args[0] === "hook");
      expect(hooks.length).toBeGreaterThan(0);
      for (const call of hooks) {
        expect(call.env[facts.inheritedEnv]).toBe(TASK);
        const input = JSON.parse(call.stdin) as Record<string, unknown>;
        for (const key of facts.stdinKeys) expect(input).toHaveProperty(key);
      }
    });

    rowIt("claude.hook.user-prompt-submit", () => {
      const facts = C.row("claude.hook.user-prompt-submit").facts;
      const input = hookInputs(log, facts.event)[0];
      for (const key of facts.stdinKeys) expect(input).toHaveProperty(key);
      expect(stub.seen(CATCH_UP)).toBe(true);
    });

    rowIt("claude.hook.post-tool-use", () => {
      const facts = C.row("claude.hook.post-tool-use").facts;
      const input = hookInputs(log, facts.event)[0];
      for (const key of facts.stdinKeys) expect(input).toHaveProperty(key);
      expect(input?.tool_name).toBe("Bash");
      expect(stub.seen(STEER)).toBe(true);
    });

    rowIt("claude.hook.stop", () => {
      const facts = C.row("claude.hook.stop").facts;
      const input = hookInputs(log, facts.event)[0];
      for (const key of facts.stdinKeys) expect(input).toHaveProperty(key);
      expect(input?.stop_hook_active).toBe(false);
      expect(input?.session_id).toBe(SESSION);
    });

    rowIt("claude.hook.stop-block", () => {
      const facts = C.row("claude.hook.stop-block").facts;
      expect(stub.seen(FOLLOW_UP)).toBe(true);
      const stops = hookInputs(log, "Stop").filter(
        (input) => input.session_id === SESSION,
      );
      expect(stops[1]?.stop_hook_active).toBe(facts.nextActive);
    });

    rowIt("claude.command.unknown", () => {
      expect(o.unknownReply, o.main?.tail()).toBe(true);
    });

    rowIt("claude.command.skill", () => {
      expect(o.skillAtStartRan).toBe(true);
      expect(o.skillAtStartUnknown).toBe(false);
    });

    rowIt("claude.command.skill-live-reload", () => {
      expect(o.liveReloadRan).toBe(true);
      expect(o.liveReloadUnknown).toBe(false);
    });

    rowIt("claude.command.skill-live-remove", () => {
      expect(o.liveRemoveUnknown, o.main?.tail()).toBe(true);
    });

    rowIt("claude.session-file.layout", () => {
      const real = realpathSync(workspace);
      const slug = real.replace(
        new RegExp(C.row("claude.session-file.layout").facts.slugPattern, "g"),
        "-",
      );
      const file = join(configDir, "projects", slug, `${SESSION}.jsonl`);
      expect(existsSync(file)).toBe(true);
      expect(hookInputs(log, "Stop")[0]?.transcript_path).toBe(file);
      // The adapter predicts the same file for the real path.
      const expected = adapter().expectedSessionFile(real, SESSION);
      expect(join(expected?.dir ?? "", expected?.fileSuffix ?? "")).toBe(file);
      // Not written at start: the session that never got input has none.
      expect(
        existsSync(join(configDir, "projects", slug, `${IDLE_SESSION}.jsonl`)),
      ).toBe(false);
    });

    rowIt("claude.trust.folder", () => {
      const facts = C.row("claude.trust.folder").facts;
      expect(o.trustShown, o.trust?.tail()).toBe(true);
      expect(o.trust?.shows(facts.reject)).toBe(true);
      expect(o.reportsDuringTrust).toEqual([]);
      expect(o.trustConfig).toContain(`"${facts.persisted}": true`);
    });

    rowIt("claude.trust.bypass-warning", () => {
      const facts = C.row("claude.trust.bypass-warning").facts;
      expect(o.bypassShown, o.trust?.tail()).toBe(true);
      expect(o.readyAfterDialogs).toBe(true);
      expect(o.trustConfig).toContain(`"${facts.persisted}": true`);
    });

    everyKeylessRowAsserted();
  });

  describe("Pi", () => {
    const P = PI_CONTRACT;
    const { rowIt, everyKeylessRowAsserted } = rowTests(P);
    const SESSION = "6f1f9a64-3f0e-4c38-9a38-6c5f3b1f2c11";
    const FORKED = "6f1f9a64-3f0e-4c38-9a38-6c5f3b1f2c12";
    const PROBE_SESSION = "6f1f9a64-3f0e-4c38-9a38-6c5f3b1f2c13";
    const MODEL = "hmstub/stub-model";
    const FIRST_PROMPT = "@hm-pi-first";
    const INBOX = "hm-inbox-message-text";
    const BOGUS = "/hm-smoke-bogus";
    const TASK = "smoke-pi";

    let agentDir: string;
    let workspace: string;
    let log: string;
    let extLog: string;
    let cli: string;
    let socketServer: ReturnType<typeof createNetServer> | undefined;
    const socketRequests: Array<Record<string, unknown>> = [];
    const sockets: Socket[] = [];
    const o = {
      version: "",
      main: undefined as PtyRun | undefined,
      mainTurn: false,
      inboxTurn: false,
      bogusSent: false,
      commandRan: false,
      sessionFile: "",
      resumed: undefined as PtyRun | undefined,
      resumeHistory: false,
      forked: undefined as PtyRun | undefined,
      forkHistory: false,
      probe: undefined as PtyRun | undefined,
      reportsBeforeAnswer: [] as string[],
      readyAfterAnswer: false,
      atFile: undefined as PtyRun | undefined,
    };

    const adapter = (): PiHarnessAdapter =>
      new PiHarnessAdapter({
        cliPath: cli,
        agentDir,
        stateDir: join(root, "state"),
      });

    const run = (
      input: BuildLaunchSpecInput,
      options: { answer?: boolean; dropEnv?: string } = {},
      mapArgs: (args: string[]) => string[] = (args) => args,
    ): PtyRun => {
      const spec = adapter().buildLaunchSpec(input);
      const env: Record<string, string> = {
        ...sandboxEnv(),
        PI_CODING_AGENT_DIR: agentDir,
        ...spec.env,
      };
      if (options.dropEnv) delete env[options.dropEnv];
      return new PtyRun(bin("pi"), mapArgs(spec.args), {
        cwd: spec.cwd,
        env,
        answer: options.answer,
      });
    };

    const extCalls = (): Array<Record<string, unknown>> =>
      existsSync(extLog)
        ? readFileSync(extLog, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];

    const sessionFiles = (): string[] => {
      const expected = adapter().expectedSessionFile(
        realpathSync(workspace),
        SESSION,
      );
      return existsSync(expected.dir)
        ? readdirSync(expected.dir).map((name) => join(expected.dir, name))
        : [];
    };

    beforeAll(async () => {
      agentDir = join(root, "pi-agent");
      workspace = join(root, "pi-work");
      mkdirSync(join(agentDir, "extensions"), { recursive: true });
      mkdirSync(workspace, { recursive: true });
      const [provider, model] = MODEL.split("/");
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            [provider as string]: {
              baseUrl: stub.url,
              api: "anthropic-messages",
              apiKey: "stub",
              models: [{ id: model }],
            },
          },
        }),
      );
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: model }),
      );
      // Harbormaster's own inbox extension, as the app installs it.
      copyFileSync(
        EXTENSION_SOURCE,
        join(agentDir, "extensions", P.row("pi.extension.autoload").facts.file),
      );
      // A probe extension: what an extension sees, and a local command.
      extLog = join(root, "pi-ext.log");
      writeFileSync(
        join(agentDir, "extensions", "hm-smoke.ts"),
        [
          'import { appendFileSync } from "node:fs";',
          `const LOG = ${JSON.stringify(extLog)};`,
          "export default function (pi: any) {",
          '  pi.on("session_start", async (_event: any, ctx: any) => {',
          "    appendFileSync(LOG, JSON.stringify({ event: 'session_start', sessionId: ctx.sessionManager.getSessionId(), pid: process.pid, task: process.env.HARBORMASTER_TASK_ID ?? null }) + '\\n');",
          "  });",
          '  pi.registerCommand("hm-smoke-cmd", {',
          '    description: "smoke",',
          "    handler: async () => { appendFileSync(LOG, JSON.stringify({ event: 'command' }) + '\\n'); },",
          "  });",
          "}",
          "",
        ].join("\n"),
      );
      log = join(root, "pi-cli.log");
      const replies = join(root, "pi-replies");
      mkdirSync(replies, { recursive: true });
      cli = writeCliLogger(root, log, replies);

      // The app's socket, standing in: one inbox message for the first idle claim.
      const socketPath = adapter().buildLaunchSpec(
        launchInput({ taskId: TASK, workspacePath: workspace }),
      ).env.HARBORMASTER_SOCKET as string;
      mkdirSync(dirname(socketPath), { recursive: true });
      let delivered = false;
      socketServer = createNetServer((socket) => {
        sockets.push(socket);
        socket.setEncoding("utf8");
        let buffer = "";
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          let index = buffer.indexOf("\n");
          while (index !== -1) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf("\n");
            const request = JSON.parse(line) as Record<string, unknown>;
            socketRequests.push(request);
            if (request.method !== "call") continue;
            const idle = (request.args as { idle?: boolean })?.idle === true;
            const messages =
              idle && !delivered
                ? [{ content: INBOX, details: {}, deliverAs: "followUp" }]
                : [];
            if (messages.length) delivered = true;
            socket.write(
              `${JSON.stringify({ id: request.id, ok: true, result: { details: { messages } } })}\n`,
            );
          }
        });
        socket.on("error", () => {});
      });
      await new Promise<void>((resolve) =>
        socketServer?.listen(socketPath, () => resolve()),
      );

      o.version = execFileSync(bin("pi"), ["--version"], {
        env: { ...sandboxEnv(), PI_CODING_AGENT_DIR: agentDir },
        encoding: "utf8",
      }).trim();

      // Main session: a new session with an '@' prompt (shielded by the adapter).
      const main = run(
        launchInput({
          taskId: TASK,
          workspacePath: workspace,
          session: { mode: "new", sessionId: SESSION, model: MODEL },
          initialPrompt: FIRST_PROMPT,
        }),
      );
      o.main = main;
      const turn = P.row("pi.status.turn").facts;
      o.mainTurn = await waitFor(
        () =>
          stub.seen(` ${FIRST_PROMPT}`) &&
          main.reports().lastIndexOf(turn.done) >
            main.reports().indexOf(turn.working),
      );
      o.inboxTurn = await waitFor(() => stub.seen(INBOX));
      await waitFor(() => main.reports().at(-1) === turn.done);
      await main.typeLine(BOGUS);
      o.bogusSent = await waitFor(() => stub.seen(BOGUS));
      const before = stub.bodies.length;
      await main.typeLine("/hm-smoke-cmd");
      o.commandRan = await waitFor(() =>
        extCalls().some((call) => call.event === "command"),
      );
      // "No model call" is the behavior: give a stray request time to show.
      await sleep(1_500);
      o.commandRan &&= !stub.bodies
        .slice(before)
        .some((body) => body.includes("hm-smoke-cmd"));
      await main.stop();
      o.sessionFile =
        sessionFiles().find((file) => file.endsWith(`_${SESSION}.jsonl`)) ?? "";

      // Reopen the file, then fork it.
      const resumed = run(
        launchInput({
          taskId: TASK,
          workspacePath: workspace,
          session: {
            mode: "resume",
            sessionId: SESSION,
            sessionPath: o.sessionFile,
          },
          initialPrompt: "hm-pi-resume",
        }),
      );
      o.resumed = resumed;
      o.resumeHistory = await waitFor(() =>
        stub.bodies.some(
          (body) =>
            body.includes("hm-pi-resume") && body.includes(FIRST_PROMPT),
        ),
      );
      await resumed.stop();
      const forked = run(
        launchInput({
          taskId: TASK,
          workspacePath: workspace,
          session: { mode: "fork", forkFrom: o.sessionFile, sessionId: FORKED },
          initialPrompt: "hm-pi-fork",
        }),
      );
      o.forked = forked;
      o.forkHistory = await waitFor(
        () =>
          stub.bodies.some(
            (body) =>
              body.includes("hm-pi-fork") && body.includes(FIRST_PROMPT),
          ) && sessionFiles().some((file) => file.endsWith(`_${FORKED}.jsonl`)),
      );
      await forked.stop();

      // Without PI_PROGRAM_STATUS: the probe, nothing until answered.
      const probe = run(
        launchInput({
          taskId: TASK,
          workspacePath: workspace,
          session: { mode: "new", sessionId: PROBE_SESSION, model: MODEL },
        }),
        { answer: false, dropEnv: P.row("pi.env.program-status").facts.env },
      );
      o.probe = probe;
      await waitFor(() => probe.probes > 0);
      // The behavior is "nothing happens": give Pi time to (not) report.
      await sleep(3_000);
      o.reportsBeforeAnswer = probe.reports();
      probe.answerProbes();
      o.readyAfterAnswer = await waitFor(() => probe.reports().length > 0);
      await probe.stop();

      // A raw '@' prompt (not through the adapter's shield).
      const atFile = run(
        launchInput({ taskId: TASK, workspacePath: workspace }),
        {},
        () => ["--model", MODEL, "--", "@hm-no-such-file"],
      );
      o.atFile = atFile;
      await waitFor(() => atFile.exitCode !== null, 20_000);
      await atFile.stop();
      console.log(
        "[real-cli-smoke] pi",
        JSON.stringify({ main: main.reports(), tail: main.tail() }),
      );
    }, SCENARIO_MS);

    afterAll(async () => {
      for (const run of [o.main, o.resumed, o.forked, o.probe, o.atFile]) {
        await run?.stop();
      }
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) =>
        socketServer ? socketServer.close(() => resolve()) : resolve(),
      );
    });

    rowIt("pi.version", () => {
      const facts = P.row("pi.version").facts;
      expect(o.version).toMatch(new RegExp(facts.pattern));
      expect(o.version).toBe(facts.output);
    });

    rowIt("pi.argv.session-id", () => {
      const facts = P.row("pi.argv.session-id").facts;
      expect(o.main?.shows(facts.createNotice)).toBe(true);
      expect(
        extCalls().find((call) => call.event === "session_start")?.sessionId,
      ).toBe(SESSION);
      expect(o.sessionFile).not.toBe("");
    });

    rowIt("pi.argv.session", () => {
      expect(o.resumeHistory).toBe(true);
      const lines = readFileSync(o.sessionFile, "utf8");
      expect(lines).toContain("hm-pi-resume");
    });

    rowIt("pi.argv.fork", () => {
      const facts = P.row("pi.argv.fork").facts;
      expect(o.forkHistory).toBe(true);
      const file = sessionFiles().find((f) => f.endsWith(`_${FORKED}.jsonl`));
      const header = JSON.parse(
        readFileSync(file ?? "", "utf8").split("\n")[0] ?? "{}",
      ) as Record<string, string>;
      expect(header.id).toBe(FORKED);
      expect(realpathSync(header[facts.headerKey] ?? "")).toBe(
        realpathSync(o.sessionFile),
      );
    });

    rowIt("pi.prompt.after-dashdash", () => {
      expect(o.mainTurn).toBe(true);
      expect(stub.seen(` ${FIRST_PROMPT}`)).toBe(true);
    });

    rowIt("pi.prompt.at-file", () => {
      const facts = P.row("pi.prompt.at-file").facts;
      expect(o.atFile?.shows(facts.error)).toBe(true);
      expect(o.atFile?.exitCode).not.toBeNull();
      // The shielded prompt went through as text (pi.prompt.after-dashdash).
      expect(stub.seen(`${facts.shield}${FIRST_PROMPT.slice(1)}`)).toBe(true);
    });

    rowIt("pi.env.program-status", () => {
      const facts = P.row("pi.env.program-status").facts;
      expect(o.main?.probes).toBe(0);
      expect(o.main?.reports()[0]).toBe(facts.firstReport);
    });

    rowIt("pi.status.probe-when-unset", () => {
      const facts = P.row("pi.status.probe-when-unset").facts;
      expect(o.probe?.probes).toBeGreaterThan(0);
      expect(o.probe?.raw).toContain(facts.probe);
      expect(o.reportsBeforeAnswer).toEqual([]);
      expect(o.readyAfterAnswer).toBe(true);
      expect(o.probe?.reports()[0]).toBe(facts.firstReport);
    });

    rowIt("pi.status.turn", () => {
      const facts = P.row("pi.status.turn").facts;
      expect(o.mainTurn).toBe(true);
      const reports = o.main?.reports() ?? [];
      expect(reports).toContain(facts.working);
      expect(reports).toContain(facts.done);
      for (const report of reports.filter((r) => r !== "state=clear")) {
        expect(report).toContain(facts.app);
      }
    });

    rowIt("pi.process.pid", () => {
      const start = extCalls().find((call) => call.event === "session_start");
      expect(start?.pid).toBe(o.main?.pid);
    });

    rowIt("pi.extension.autoload", () => {
      const start = extCalls().find((call) => call.event === "session_start");
      expect(start?.task).toBe(TASK);
      // Harbormaster's own extension loaded too: it talked to the socket.
      expect(socketRequests.length).toBeGreaterThan(0);
    });

    rowIt("pi.extension.mcp-server", () => {
      const facts = P.row("pi.extension.mcp-server").facts;
      const spawned = readCalls(log).find(
        (call) => call.args.join(" ") === facts.args.join(" "),
      );
      expect(spawned?.env.HARBORMASTER_TASK_ID).toBe(TASK);
      expect(spawned?.env.HARBORMASTER_SESSION_ID).toBe(SESSION);
    });

    rowIt("pi.extension.inbox", () => {
      const facts = P.row("pi.extension.inbox").facts;
      expect(
        socketRequests.some(
          (request) =>
            request.method === facts.watch &&
            (request.caller as { taskId?: string })?.taskId === TASK,
        ),
      ).toBe(true);
      expect(
        socketRequests.some(
          (request) =>
            request.tool === facts.claim &&
            (request.args as { idle?: boolean })?.idle === true,
        ),
      ).toBe(true);
      expect(o.inboxTurn).toBe(true);
    });

    rowIt("pi.command.unknown-slash", () => {
      const facts = P.row("pi.command.unknown-slash").facts;
      expect(o.bogusSent).toBe(true);
      expect(o.main?.shows(facts.noReply)).toBe(false);
    });

    rowIt("pi.command.extension", () => {
      expect(o.commandRan).toBe(true);
    });

    rowIt("pi.session-file.layout", () => {
      const facts = P.row("pi.session-file.layout").facts;
      expect(o.sessionFile).toMatch(
        new RegExp(`/${facts.dir}/--[^/]+--/[^/]+_${SESSION}\\.jsonl$`),
      );
      const header = JSON.parse(
        readFileSync(o.sessionFile, "utf8").split("\n")[0] ?? "{}",
      ) as Record<string, unknown>;
      expect(header).toMatchObject({ ...facts.header, id: SESSION });
      expect(Object.keys(header)).toEqual(
        expect.arrayContaining([...facts.headerKeys]),
      );
      expect(header.cwd).toBe(realpathSync(workspace));
      // Not written at start: the session that never ran a turn has none.
      expect(
        sessionFiles().some((file) => file.endsWith(`_${PROBE_SESSION}.jsonl`)),
      ).toBe(false);
    });

    rowIt("pi.session-file.usage", () => {
      const facts = P.row("pi.session-file.usage").facts;
      const assistant = readFileSync(o.sessionFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find(
          (entry) =>
            entry.type === "message" && entry.message?.role === "assistant",
        );
      const usage = assistant?.message?.usage ?? {};
      for (const key of facts.usageKeys) expect(usage).toHaveProperty(key);
      expect(usage.cost).toHaveProperty(facts.costKey);
    });

    everyKeylessRowAsserted();
  });

  // Rows a keyless run cannot check; the real smoke (T4) owns them.
  describe.skip("needs a model: real smoke (T4)", () => {
    for (const row of [...CLAUDE_CODE_CONTRACT.rows, ...PI_CONTRACT.rows]) {
      if (row.needsModel) it(`${row.id}: ${row.title}`, () => {});
    }
  });
});
