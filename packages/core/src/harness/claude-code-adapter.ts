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

import { join } from "node:path";
import {
  ClaudeModelCatalogAccess,
  type ClaudeTranscriptAccess,
  claudeConfigDir,
  LocalClaudeTranscriptAccess,
} from "../access/claude-code-access.js";
import {
  claudeSubagentFiles,
  readClaudeSessionUsage,
} from "../access/claude-session-usage-access.js";
import { ClaudeSlashCommandAccess } from "../access/local-slash-command-access.js";
import {
  type BuildLaunchSpecInput,
  type ExpectedSessionFile,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessDescriptor,
  type HarnessModelCatalog,
  type HarnessModelCatalogAccess,
  type HarnessReviewCapability,
  type HarnessSlashCommandAccess,
  type LaunchSpec,
  type PresenceStatus,
  type ProgramStatusReading,
  PTY_TYPING_CHANNEL,
  type SessionLaunch,
  type SlashCommand,
} from "../contracts/harness.js";
import type { HarnessMessagingCapabilities } from "../contracts/messaging.js";
import type { ThinkingLevel } from "../contracts/model.js";
import type { SessionUsage } from "../contracts/usage.js";
import { canonicalPath } from "../utilities/canonical-path.js";
import {
  applyOpenUrlEnv,
  baseLaunchEnv,
  createPresenceReader,
  deliverInitialPrompt,
  mcpIdentityEnv,
  type PresenceReaderOptions,
  plannotatorSlashReview,
  readPromptFileInstruction,
  shellQuote,
} from "./adapter-common.js";
import {
  harnessCommandEnvName,
  harnessLaunchCommand,
  isTerminalShim,
  parseVersionOutput,
} from "./descriptor.js";
import {
  HARBORMASTER_MCP_SERVER_NAME,
  piMcpServerConfig,
} from "./pi-adapter.js";

export const CLAUDE_CODE_HARNESS_ID = "claude-code";

/**
 * Claude Code's install/version facts (P2). Floor 2.1.295: the first
 * release that speaks OSC 7501 (presence); verified 2.1.322 (this header).
 * `HARBORMASTER_CLAUDE_COMMAND` stays as the legacy e2e override name.
 */
export const CLAUDE_CODE_DESCRIPTOR: HarnessDescriptor = {
  id: CLAUDE_CODE_HARNESS_ID,
  label: "Claude Code",
  commands: [["claude"]],
  commandEnv: [
    harnessCommandEnvName(CLAUDE_CODE_HARNESS_ID),
    "HARBORMASTER_CLAUDE_COMMAND",
  ],
  // https://code.claude.com/docs/en/setup (native installer, macOS/Linux).
  installHint: "curl -fsSL https://claude.ai/install.sh | bash",
  upgradeHint: "claude update",
  versionArgs: ["--version"],
  parseVersion: parseVersionOutput,
  minVersion: "2.1.295",
  verifiedVersion: "2.1.322",
  configDir: (env, home) => env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
  reviewPieces: ["binary", "claude-plugin", "claude-skill", "claude-code"],
  isShim: isTerminalShim,
};

/**
 * Claude Code's capabilities (P6): `--session-id` pre-assigns; 7501 only
 * after the probe, with its own dialect (see `interpretClaudeProgramStatus`
 * and the recorded fixtures under tests/fixtures/status/claude-code/);
 * hooks deliver steer and follow-up but fire only mid-turn, so an idle
 * session is woken by typing into the pane; fresh worktrees ask for folder
 * trust.
 */
export const CLAUDE_CODE_CAPABILITIES: HarnessCapabilities = {
  sessionId: "preassign",
  status: {
    protocol: "osc7501",
    probe: true,
    states: ["idle", "working", "blocked", "done", "error"],
    // Each names the recorded fixture that shows it
    // (tests/fixtures/status/claude-code/<version>/<scenario>.txt) or says
    // it is unrecorded (asserted by the contract test).
    quirks: [
      "working + '<n> <kind> still running' after a turn = idle (background work; also overridden by the Stop hook) [fixture: background-work]",
      "the folder-trust dialog reports blocked (kind permission, 'trust this folder') before the first idle [fixture: startup]",
      "Esc cancel ends in idle, not done [fixture: cancel]",
      "a slash command such as /exit blips working→idle [fixture: exit]",
      "done is reported twice; done→working flicker (seen in the app, not reproduced on 2.1.326) [unrecorded]",
      "the 7501 probe must be answered within ~1 s: answered at 1 s it reports, unanswered by ~2 s it never reports in that session, not even after a late answer (contract row claude.status.probe) [unrecorded]",
    ],
  },
  delivery: {
    steer: true,
    followUp: true,
    // An idle Claude fires no hook on its own (every hook above needs a
    // turn), so the app types pending messages at its prompt instead.
    wakeIdle: false,
    channels: {
      steer: "PostToolUse hook",
      followUp: "Stop hook (block)",
      catchUp: "UserPromptSubmit hook",
      wakeIdle: PTY_TYPING_CHANNEL,
    },
  },
  trustPrompt: true,
  review: true,
};

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

/**
 * Claude's project directory name for a cwd (`~/.claude/projects/<slug>`):
 * every non-alphanumeric character becomes `-` (verified on disk:
 * `/Users/me/Code/.wt/x` → `-Users-me-Code--wt-x`). Claude shortens very
 * long slugs with a hash; those are not predicted (`undefined`).
 */
export function claudeProjectSlug(cwd: string): string | undefined {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return slug.length <= 200 ? slug : undefined;
}

/**
 * A long prompt as a file Claude inlines itself: an `@<path>` mention in
 * the prompt is read into the message (verified: `claude -p --tools "" --
 * "@<file> …"` answers from the file). A path with whitespace can't be
 * mentioned; the agent is told to read it instead.
 */
export function claudePromptFileArgs(path: string): string[] {
  return [
    "--",
    /\s/.test(path)
      ? readPromptFileInstruction(path)
      : `@${path} Follow the task brief in the attached file.`,
  ];
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

/**
 * Claude Code's message for "my turn is over, but background work I started
 * is still running" (its own wording: `1 shell still running`,
 * `2 shells, 1 monitor still running`, `1 background agent still running`,
 * `1 cloud session still running`, ...).
 */
export const CLAUDE_AWAITED_BACKGROUND =
  /^\d+ [a-z][a-z -]*(?:, \d+ [a-z][a-z -]*)* still running$/i;

/**
 * Claude Code reports OSC 7501 `working` not only during a turn but also
 * after one completed while a background shell / monitor / agent it started
 * is still running (until that finishes). It is then back at its prompt,
 * accepting input; it resumes by itself when the work reports back. Core
 * records that as `idle` with Claude's message, not as a running turn.
 */
export function interpretClaudeProgramStatus(
  report: ProgramStatusReading,
): ProgramStatusReading {
  if (
    report.state === "working" &&
    report.message !== undefined &&
    CLAUDE_AWAITED_BACKGROUND.test(report.message.trim())
  ) {
    return { state: "idle", message: report.message.trim() };
  }
  return report;
}

export interface ClaudeCodeHarnessAdapterOptions extends PresenceReaderOptions {
  /** Absolute path of the `harbormaster` CLI; without it sessions start without hooks or tools. */
  cliPath?: string;
  /** Model list + defaults; injectable for tests. */
  models?: HarnessModelCatalogAccess;
  /** Transcript existence (resume vs. re-create); injectable for tests. */
  transcripts?: ClaudeTranscriptAccess;
  /** The composer's `/` menu; injectable for tests. */
  slashCommands?: HarnessSlashCommandAccess;
  /** Claude's config directory (transcripts under `<configDir>/projects`); defaults to `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  configDir?: string;
}

export class ClaudeCodeHarnessAdapter implements HarnessAdapter {
  readonly id = CLAUDE_CODE_HARNESS_ID;
  readonly label = "Claude Code";
  readonly command = "claude";
  readonly descriptor: HarnessDescriptor = CLAUDE_CODE_DESCRIPTOR;
  readonly capabilities: HarnessCapabilities = CLAUDE_CODE_CAPABILITIES;
  readonly messaging: HarnessMessagingCapabilities = {
    ...CLAUDE_CODE_MESSAGING_CAPABILITIES,
  };
  /** The Plannotator plugin's `/plannotator-review [<PR URL>]`. */
  readonly review: HarnessReviewCapability = plannotatorSlashReview;
  private readonly readPresence: (taskId: string) => Promise<PresenceStatus>;
  private readonly models: HarnessModelCatalogAccess;
  private readonly transcripts: ClaudeTranscriptAccess;
  private readonly slashCommands: HarnessSlashCommandAccess;
  private readonly cliPath: string | undefined;
  private readonly configDir: string | undefined;

  constructor(options: ClaudeCodeHarnessAdapterOptions = {}) {
    this.readPresence = createPresenceReader(options);
    this.models = options.models ?? new ClaudeModelCatalogAccess();
    this.transcripts = options.transcripts ?? new LocalClaudeTranscriptAccess();
    this.cliPath = options.cliPath;
    this.configDir = options.configDir;
    this.slashCommands =
      options.slashCommands ??
      new ClaudeSlashCommandAccess({
        ...(options.configDir ? { configDir: options.configDir } : {}),
        command: () => harnessLaunchCommand(this),
      });
  }

  /** Claude's skills, commands and enabled plugins' (`/name`, `/plugin:name`). */
  listSlashCommands(cwd?: string): Promise<SlashCommand[]> {
    return this.slashCommands.listSlashCommands(cwd);
  }

  /** `<configDir>/projects/<slug of the resolved cwd>/<sessionId>.jsonl` (Claude slugs `process.cwd()`: `/tmp` → `/private/tmp` on macOS). */
  expectedSessionFile(
    cwd: string,
    sessionId: string,
  ): ExpectedSessionFile | undefined {
    const slug = claudeProjectSlug(canonicalPath(cwd));
    if (!slug) return undefined;
    return {
      dir: join(this.configDir ?? claudeConfigDir(), "projects", slug),
      fileSuffix: `${sessionId}.jsonl`,
    };
  }

  /**
   * Per-model tokens, each request once (`requestId` / `message.id`),
   * sidechain turns and subagent transcripts included; no cost (Claude
   * Code writes none per turn).
   */
  readSessionUsage(sessionPath: string): Promise<SessionUsage | undefined> {
    return readClaudeSessionUsage(sessionPath);
  }

  /** The subagent transcripts `readSessionUsage` also counts. */
  extraUsageFiles(sessionPath: string): Promise<string[]> {
    return claudeSubagentFiles(sessionPath);
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
    const env = applyOpenUrlEnv(baseLaunchEnv(input, this.cliPath), input);
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
    const prompt = deliverInitialPrompt(
      input,
      claudePromptArgs,
      claudePromptFileArgs,
      { keepLeadingCommand: true },
    );
    return {
      command: harnessLaunchCommand(this),
      args: [
        ...claudeSessionArgs(input.session, (id) =>
          this.transcripts.exists(id),
        ),
        ...(input.permissions === "bypass"
          ? ["--dangerously-skip-permissions"]
          : []),
        ...tooling,
        ...prompt.args,
      ],
      cwd: input.workspacePath,
      env,
      ...(prompt.promptFile ? { promptFile: prompt.promptFile } : {}),
    };
  }

  presence(taskId: string): Promise<PresenceStatus> {
    return this.readPresence(taskId);
  }

  interpretProgramStatus(report: ProgramStatusReading): ProgramStatusReading {
    return interpretClaudeProgramStatus(report);
  }

  async stopHeadless(_taskId: string): Promise<void> {
    throw new Error("ClaudeCodeHarnessAdapter.stopHeadless is not implemented");
  }

  async attach(_taskId: string): Promise<void> {
    throw new Error("ClaudeCodeHarnessAdapter.attach is not implemented");
  }
}
