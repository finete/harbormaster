// Claude Code harness adapter (decision #18, R2/R6/R7; docs/release-plan.md
// "Agents (harnesses)"). Same standard path as Pi: status via OSC 7501 (the
// app's pty layer answers Claude's probe; nothing to set here), tools via
// the per-session `harbormaster mcp` server (`--mcp-config`), session via
// CLI flags. The only Claude-specific glue is inbox delivery, through hooks
// passed per session with `--settings` (never written to `~/.claude`).
//
// Verified against Claude Code 2.1.322 (`claude --help`) and
// https://code.claude.com/docs/en/cli-reference + /hooks (2026-11-11):
// - `--session-id <uuid>` creates a session under that id ("must be a valid
//   UUID"; core's ids are UUIDs); reusing an existing id is an error.
// - `--resume <id | transcript path>` reopens one; `--session-id` combines
//   with `--resume`/`--continue` only together with `--fork-session`
//   ("--session-id can only be used with --continue or --resume if
//   --fork-session is also specified").
// - `--mcp-config <configs...>` is variadic: without `--` it swallows the
//   positional prompt as another config file. So the prompt always follows
//   `--`, which also keeps a prompt starting with "-" from parsing as a flag.
//   A leading "@" needs no defusing: it is not an argv marker for Claude, an
//   `@path` in the prompt text is an ordinary file mention.
// - `--settings <file-or-json>` merges over the user's settings for this
//   session only; hooks from all sources run.
// - `--effort low|medium|high|xhigh|max` (an unknown value is ignored with a
//   warning), `--model <alias|name>`.
// - `--dangerously-skip-permissions` = `--permission-mode bypassPermissions`.

import {
  ClaudeModelCatalogAccess,
  type ClaudeTranscriptAccess,
  LocalClaudeTranscriptAccess,
} from "../access/claude-code-access.js";
import type {
  BuildLaunchSpecInput,
  HarnessAdapter,
  HarnessModelCatalog,
  HarnessModelCatalogAccess,
  LaunchSpec,
  PresenceStatus,
  SessionLaunch,
} from "../contracts/harness.js";
import type { HarnessMessagingCapabilities } from "../contracts/messaging.js";
import type { ThinkingLevel } from "../contracts/model.js";
import {
  baseLaunchEnv,
  createPresenceReader,
  mcpIdentityEnv,
  type PresenceReaderOptions,
  shellQuote,
} from "./adapter-common.js";
import {
  HARBORMASTER_MCP_SERVER_NAME,
  piMcpServerConfig,
} from "./pi-adapter.js";

/** Overrides the launched command (and only the command) for e2e, like `HARBORMASTER_PI_COMMAND`. */
const CLAUDE_COMMAND_ENV = "HARBORMASTER_CLAUDE_COMMAND";

export const CLAUDE_CODE_HARNESS_ID = "claude-code";

/** Hooks deliver text: steer (PostToolUse), followUp (Stop block), catch-up (UserPromptSubmit). No inline images: the text names the copied file. */
export const CLAUDE_CODE_MESSAGING_CAPABILITIES: HarnessMessagingCapabilities =
  {
    receive: true,
    steer: true,
    followUp: true,
    images: false,
  };

/** Harbormaster thinking level → `--effort` value (`off` has no equivalent: omitted). */
export function claudeEffort(
  thinking: ThinkingLevel | undefined,
): string | undefined {
  switch (thinking) {
    case undefined:
    case "off":
      return undefined;
    case "minimal":
      return "low";
    default:
      return thinking;
  }
}

/**
 * Core's session decision → Claude flags.
 *
 * - `new`: `--session-id <id>` (+ `--model`, `--effort`).
 * - `resume`: `--resume <id>` when Claude persisted that session; a session
 *   that never got a first message has no transcript and can't be resumed,
 *   so it is created again under the same id (`--session-id <id>`).
 * - `fork`: `--resume <from> --fork-session --session-id <id>` (`from` is a
 *   session id or a transcript path; both are accepted).
 * - `open`: `--resume <transcript path>`.
 * - `continue`: `--continue`.
 */
export function claudeSessionArgs(
  session: SessionLaunch | undefined,
  transcriptExists: (sessionId: string) => boolean = () => true,
): string[] {
  if (!session) return [];
  switch (session.mode) {
    case "new": {
      const effort = claudeEffort(session.thinking);
      return [
        "--session-id",
        session.sessionId,
        ...(session.model ? ["--model", session.model] : []),
        ...(effort ? ["--effort", effort] : []),
      ];
    }
    case "resume":
      return transcriptExists(session.sessionId)
        ? ["--resume", session.sessionId]
        : ["--session-id", session.sessionId];
    case "fork":
      return [
        "--resume",
        session.forkFrom,
        "--fork-session",
        "--session-id",
        session.sessionId,
      ];
    case "open":
      return ["--resume", session.sessionPath];
    case "continue":
      return ["--continue"];
  }
}

/** The prompt as Claude's positional argument, always after `--` (see the header). */
export function claudePromptArgs(prompt: string | undefined): string[] {
  if (!prompt?.trim()) return [];
  return ["--", prompt];
}

/**
 * The per-session `--settings` JSON: the three inbox hooks (decision R6),
 * each running the absolute `harbormaster` CLI. The hook inherits the
 * session's env (task id, socket), so it needs no arguments beyond the mode.
 * PostToolUse has no matcher (= every tool); Stop and UserPromptSubmit take
 * none.
 */
export function claudeHookSettings(cliPath: string): {
  hooks: Record<string, unknown[]>;
} {
  const hook = (mode: string) => [
    {
      hooks: [
        {
          type: "command",
          command: `${shellQuote(cliPath)} hook inbox --mode ${mode}`,
          timeout: 30,
        },
      ],
    },
  ];
  return {
    hooks: {
      PostToolUse: hook("steer"),
      Stop: hook("follow-up"),
      UserPromptSubmit: hook("catch-up"),
    },
  };
}

/**
 * The per-session `--mcp-config` JSON: the same `harbormaster mcp` entry the
 * Pi adapter hands Pi (`piMcpServerConfig`), minus Pi-only keys (`cwd`,
 * `exposure`, `description`) Claude's stdio schema does not define.
 */
export function claudeMcpConfig(input: {
  cliPath: string;
  env: Record<string, string>;
  cwd: string;
}): { mcpServers: Record<string, unknown> } {
  const entry = piMcpServerConfig(input);
  return {
    mcpServers: {
      [HARBORMASTER_MCP_SERVER_NAME]: {
        type: "stdio",
        command: entry.command,
        args: entry.args,
        env: entry.env,
      },
    },
  };
}

export interface ClaudeCodeHarnessAdapterOptions extends PresenceReaderOptions {
  /** Absolute path of the `harbormaster` CLI; without it sessions start without hooks or tools. */
  cliPath?: string;
  /** Model list + defaults; injectable for tests. */
  models?: HarnessModelCatalogAccess;
  /** Transcript existence (resume vs. re-create); injectable for tests. */
  transcripts?: ClaudeTranscriptAccess;
}

export class ClaudeCodeHarnessAdapter implements HarnessAdapter {
  readonly id = CLAUDE_CODE_HARNESS_ID;
  readonly label = "Claude Code";
  readonly command = "claude";
  readonly messaging: HarnessMessagingCapabilities = {
    ...CLAUDE_CODE_MESSAGING_CAPABILITIES,
  };
  private readonly readPresence: (taskId: string) => Promise<PresenceStatus>;
  private readonly models: HarnessModelCatalogAccess;
  private readonly transcripts: ClaudeTranscriptAccess;
  private readonly cliPath: string | undefined;

  constructor(options: ClaudeCodeHarnessAdapterOptions = {}) {
    this.readPresence = createPresenceReader(options);
    this.models = options.models ?? new ClaudeModelCatalogAccess();
    this.transcripts = options.transcripts ?? new LocalClaudeTranscriptAccess();
    this.cliPath = options.cliPath;
  }

  async defaults(): Promise<
    Pick<HarnessModelCatalog, "defaultModel" | "defaultThinking">
  > {
    return this.models.defaults().catch(() => ({}));
  }

  async listModels(): Promise<HarnessModelCatalog> {
    try {
      return {
        harness: this.id,
        label: this.label,
        ...(await this.models.listModels()),
      };
    } catch (error) {
      return {
        harness: this.id,
        label: this.label,
        models: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  buildLaunchSpec(input: BuildLaunchSpecInput): LaunchSpec {
    const env = baseLaunchEnv(input, this.cliPath);
    const tooling: string[] = [];
    if (this.cliPath) {
      tooling.push(
        "--settings",
        JSON.stringify(claudeHookSettings(this.cliPath)),
        "--mcp-config",
        JSON.stringify(
          claudeMcpConfig({
            cliPath: this.cliPath,
            env: mcpIdentityEnv(env),
            cwd: input.workspacePath,
          }),
        ),
      );
    }
    return {
      command: process.env[CLAUDE_COMMAND_ENV] || this.command,
      args: [
        ...claudeSessionArgs(input.session, (id) =>
          this.transcripts.exists(id),
        ),
        ...(input.permissions === "bypass"
          ? ["--dangerously-skip-permissions"]
          : []),
        ...tooling,
        ...claudePromptArgs(input.initialPrompt),
      ],
      cwd: input.workspacePath,
      env,
    };
  }

  presence(taskId: string): Promise<PresenceStatus> {
    return this.readPresence(taskId);
  }

  async stopHeadless(_taskId: string): Promise<void> {
    throw new Error("ClaudeCodeHarnessAdapter.stopHeadless is not implemented");
  }

  async attach(_taskId: string): Promise<void> {
    throw new Error("ClaudeCodeHarnessAdapter.attach is not implemented");
  }
}
