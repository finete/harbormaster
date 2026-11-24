// Codex CLI harness adapter (docs/harness-additions.md X1-X11). Standard
// path like Claude Code: status via OSC 7501 (Codex reports without the
// probe), tools via the per-session `harbormaster mcp` server, hooks for
// session binding, turn boundaries, steer and catch-up. Everything travels
// per session as `-c key=<TOML>` overrides; nothing is written to
// `~/.codex` (Codex itself records the folder-trust answer there, X8).
//
// Verified against codex-cli 0.169.0 (`codex --help`, `codex resume|fork|
// queue --help`, real pty runs against a canned Responses-API stub and a
// logged-in account, 2026-11-17):
// - `codex [OPTIONS] [PROMPT]`, `codex [OPTIONS] resume [SESSION_ID]
//   [PROMPT]`, `codex [OPTIONS] fork [SESSION_ID] [PROMPT]`: the global
//   options (`-c`, `--enable`, `-m`, the bypass flags) go before the
//   subcommand and apply to it; `resume --last` reopens the newest session
//   recorded for the cwd. Resume and fork take an id or a session name,
//   never a rollout path (an `open` launch resumes the id in the path's
//   file name). `--` ends option parsing before the prompt, so a prompt
//   starting with "-" stays a prompt.
// - No `--session-id`: the id is learned from the `SessionStart` hook
//   (`session_id`, `transcript_path`, X3); a fork gets a new id the same way.
// - `--enable hooks --dangerously-bypass-hook-trust` runs our `-c hooks.*`
//   without a persisted trust entry (X1). Hook stdin JSON: `session_id`,
//   `transcript_path`, `cwd`, `hook_event_name`, `model`,
//   `permission_mode`, plus `turn_id` (all but SessionStart), `prompt`
//   (UserPromptSubmit), `tool_name` (PostToolUse), `stop_hook_active` +
//   `last_assistant_message` (Stop). `hookSpecificOutput.additionalContext`
//   from UserPromptSubmit / PostToolUse reaches the model as a developer
//   message (the same shape as Claude Code's).
// - `--dangerously-bypass-approvals-and-sandbox` = hook `permission_mode`
//   `bypassPermissions`; `-m <model>`; `-c model_reasoning_effort=<effort>`.
//   A resumed session keeps the permission mode it was created with.
// - The default `workspace-write` sandbox blocks the network, binding a
//   loopback port included: `-c sandbox_workspace_write.network_access=true`
//   on every launch (X12).
// - `codex queue --thread <id> --message <text>` stores a message for a
//   session; a live idle TUI runs it as its next turn (X5).
// - `-c check_for_update_on_startup=false` on every launch (X13): an
//   out-of-date Codex otherwise opens "Update available" at startup with
//   "Update now" preselected, and the first Enter typed into the pane
//   (the Review button's command) runs `npm install -g @openai/codex`.

import {
  CodexModelCatalogAccess,
  type CodexTranscriptAccess,
  codexHomeDir,
  codexSessionIdFromPath,
  LocalCodexTranscriptAccess,
} from "../access/codex-code-access.js";
import { readCodexSessionUsage } from "../access/codex-session-usage-access.js";
import { CodexSlashCommandAccess } from "../access/local-slash-command-access.js";
import type {
  BuildLaunchSpecInput,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessDeliverCommand,
  HarnessDescriptor,
  HarnessModelCatalog,
  HarnessModelCatalogAccess,
  HarnessReviewCapability,
  HarnessSlashCommandAccess,
  LaunchSpec,
  PresenceStatus,
  ReviewTarget,
  SessionLaunch,
  SlashCommand,
} from "../contracts/harness.js";
import type { HarnessMessagingCapabilities } from "../contracts/messaging.js";
import type { ThinkingLevel } from "../contracts/model.js";
import type { SessionUsage } from "../contracts/usage.js";
import {
  applyOpenUrlEnv,
  baseLaunchEnv,
  createPresenceReader,
  deliverInitialPrompt,
  mcpIdentityEnv,
  type PresenceReaderOptions,
  readPromptFileInstruction,
  SESSION_ID_ENV,
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
import { tomlLiteral, tomlOverride } from "./toml-value.js";

export const CODEX_HARNESS_ID = "codex";

/**
 * Codex's install/version facts (P2, X10). Floor 0.166.0: `queue`,
 * 7501 `done` and stable hooks; verified 0.169.0 (`codex --version` prints
 * `codex-cli 0.169.0`). cmux writes a `codex` shim too (`isShim`).
 */
export const CODEX_DESCRIPTOR: HarnessDescriptor = {
  id: CODEX_HARNESS_ID,
  label: "Codex",
  commands: [["codex"]],
  commandEnv: [harnessCommandEnvName(CODEX_HARNESS_ID)],
  installHint: "npm install -g @openai/codex",
  upgradeHint: "npm install -g @openai/codex@latest",
  versionArgs: ["--version"],
  parseVersion: parseVersionOutput,
  minVersion: "0.166.0",
  verifiedVersion: "0.169.0",
  configDir: (env, home) => codexHomeDir(env, home),
  reviewPieces: ["binary", "codex-skill"],
  isShim: isTerminalShim,
};

/**
 * Codex's capabilities (P6): the session id is learned from SessionStart;
 * 7501 without a probe (recorded fixtures under
 * tests/fixtures/status/codex/); steer through PostToolUse, follow-up and
 * idle wake-up through `codex queue` (run by the app, see
 * `deliverCommand`), catch-up through UserPromptSubmit; fresh worktrees ask
 * for folder trust.
 */
export const CODEX_CAPABILITIES: HarnessCapabilities = {
  sessionId: "learned",
  status: {
    protocol: "osc7501",
    probe: false,
    states: ["idle", "working", "blocked", "done"],
    // Each names the recorded fixture that shows it
    // (tests/fixtures/status/codex/<version>/<scenario>.txt) or says it is
    // unrecorded (asserted by the contract test).
    quirks: [
      "startup blips idle→working→idle before the first prompt (while the user's MCP servers and hooks load) [fixture: startup]",
      "blocked (kind permission) carries no message [fixture: permission]",
      "Esc (cancelling a turn or declining a permission prompt) ends in idle, not done [fixture: cancel]",
      "the folder-trust dialog reports nothing; the first idle follows the answer [fixture: startup]",
      "a turn that leaves background work running (`sleep 120 &`) still ends in done: no lingering working [fixture: background-work]",
      "the default workspace-write sandbox denies binding even a loopback port (`plannotator review` dies with 'port … already in use'): every launch adds sandbox_workspace_write.network_access=true (X12; contract row codex.sandbox.network) [unrecorded]",
      "OSC 9 '<last reply>' right before done (tui.notifications osc9): the card's message only; OSC 9 bodies '<digit>;…' are progress, ignored [fixture: turn]",
    ],
  },
  delivery: {
    steer: true,
    followUp: true,
    wakeIdle: true,
    channels: {
      steer: "PostToolUse hook",
      followUp: "codex queue",
      wakeIdle: "codex queue",
      catchUp: "UserPromptSubmit hook",
    },
  },
  trustPrompt: true,
  fork: true,
  review: true,
};

/** Text only: attachments travel as the copies' paths in the text (`codex queue` takes no files). */
export const CODEX_MESSAGING_CAPABILITIES: HarnessMessagingCapabilities = {
  receive: true,
  steer: true,
  followUp: true,
  images: false,
};

/** Plannotator's Codex skill, typed like a prompt (X9). */
export const CODEX_REVIEW_SKILL = "$plannotator-review";

/** `$plannotator-review`, with the PR URL appended for a PR review. */
export const codexSkillReview: HarnessReviewCapability = {
  command(target: ReviewTarget): string {
    return target.kind === "pr"
      ? `${CODEX_REVIEW_SKILL} ${target.url}`
      : CODEX_REVIEW_SKILL;
  },
};

/** The hook events Harbormaster registers, with the `--event` name the CLI takes. */
export const CODEX_HOOK_EVENTS = {
  SessionStart: "session-start",
  UserPromptSubmit: "user-prompt-submit",
  PostToolUse: "post-tool-use",
  Stop: "stop",
} as const;

/** Seconds Codex waits for one hook (ours reply in milliseconds, X2). */
const HOOK_TIMEOUT_SECONDS = 10;

/**
 * No startup update dialog (X13): it takes the pane's first Enter, and its
 * default is a global `npm install -g @openai/codex` (seen when an older
 * pinned Codex met a newer release). Upgrades are the user's, through
 * doctor's version check and the harness's own upgrade command.
 */
export const CODEX_STARTUP_OVERRIDES: readonly string[] = [
  tomlOverride("check_for_update_on_startup", false),
];

/** `tui.notifications` over OSC 9 (X4): the reply text arrives right before `done`. */
export const CODEX_NOTIFICATION_OVERRIDES: readonly string[] = [
  tomlOverride("tui.notifications", [
    "agent-turn-complete",
    "approval-requested",
    "plan-mode-prompt",
    "async-question",
  ]),
  tomlOverride("tui.notification_method", "osc9"),
  tomlOverride("tui.notification_condition", "always"),
];

/**
 * Sandboxed commands may use the network (X12, an R7 deviation): Codex's
 * default `workspace-write` seatbelt sandbox denies even binding a
 * loopback port, so `plannotator review` (its local server), `gh` and dev
 * servers fail in an interactive pane; Pi and Claude Code panes have no
 * such restriction. The approvals policy is unchanged.
 */
export const CODEX_SANDBOX_OVERRIDES: readonly string[] = [
  tomlOverride("sandbox_workspace_write.network_access", true),
];

/**
 * `-c hooks.<Event>=[{hooks=[{type="command",command='''<cli> hook codex
 * --event <event>''',timeout=10}]}]` per event (X1). The command is a shell
 * line (Codex runs it with `sh -c`), so the CLI path is shell-quoted, then
 * carried verbatim in a TOML literal (no escapes, spaces and quotes kept).
 */
export function codexHookOverrides(cliPath: string): string[] {
  return Object.entries(CODEX_HOOK_EVENTS).flatMap(([event, name]) => [
    "-c",
    tomlOverride(`hooks.${event}`, [
      {
        hooks: [
          {
            type: "command",
            command: tomlLiteral(
              `${shellQuote(cliPath)} hook codex --event ${name}`,
            ),
            timeout: HOOK_TIMEOUT_SECONDS,
          },
        ],
      },
    ]),
  ]);
}

/** `-c mcp_servers.harbormaster.{command,args,env,cwd}` (X6): the same entry Pi and Claude get. */
export function codexMcpOverrides(input: {
  cliPath: string;
  env: Record<string, string>;
  cwd: string;
}): string[] {
  const entry = piMcpServerConfig(input);
  const key = `mcp_servers.${HARBORMASTER_MCP_SERVER_NAME}`;
  return [
    "-c",
    tomlOverride(`${key}.command`, entry.command),
    "-c",
    tomlOverride(`${key}.args`, entry.args),
    "-c",
    tomlOverride(`${key}.env`, entry.env),
    "-c",
    tomlOverride(`${key}.cwd`, entry.cwd),
  ];
}

/** Harbormaster thinking level → `model_reasoning_effort` (`off` = Codex's own default). */
export function codexEffort(
  thinking: ThinkingLevel | undefined,
): string | undefined {
  return thinking === undefined || thinking === "off" ? undefined : thinking;
}

/**
 * Core's session decision → Codex's session words (after every option):
 *
 * - `new`: nothing (Codex picks the id; SessionStart reports it), plus
 *   `-m` / `model_reasoning_effort` (returned in `options`).
 * - `resume`: `resume <id>` when Codex has that rollout, else a fresh
 *   session (an id Codex never wrote cannot be resumed).
 * - `fork`: `fork <id>` (`forkFrom` is a rollout path or an id).
 * - `open`: `resume <id from the rollout's file name>`; `resume --last`
 *   when the name carries none.
 * - `continue`: `resume --last` (the newest session recorded for the cwd).
 */
export function codexSessionArgs(
  session: SessionLaunch | undefined,
  transcriptExists: (sessionId: string) => boolean = () => true,
): { options: string[]; subcommand: string[] } {
  if (!session) return { options: [], subcommand: [] };
  switch (session.mode) {
    case "new": {
      const effort = codexEffort(session.thinking);
      return {
        options: [
          ...(session.model ? ["-m", session.model] : []),
          ...(effort
            ? ["-c", tomlOverride("model_reasoning_effort", effort)]
            : []),
        ],
        subcommand: [],
      };
    }
    case "resume":
      return {
        options: [],
        subcommand: transcriptExists(session.sessionId)
          ? ["resume", session.sessionId]
          : [],
      };
    case "fork":
      return {
        options: [],
        subcommand: [
          "fork",
          codexSessionIdFromPath(session.forkFrom) ?? session.forkFrom,
        ],
      };
    case "open": {
      const id = codexSessionIdFromPath(session.sessionPath);
      return {
        options: [],
        subcommand: id ? ["resume", id] : ["resume", "--last"],
      };
    }
    case "continue":
      return { options: [], subcommand: ["resume", "--last"] };
  }
}

/** The prompt as Codex's positional argument, after `--` (a leading "-" stays text). */
export function codexPromptArgs(prompt: string | undefined): string[] {
  if (!prompt?.trim()) return [];
  return ["--", prompt];
}

export interface CodexHarnessAdapterOptions extends PresenceReaderOptions {
  /** Absolute path of the `harbormaster` CLI; without it sessions start without hooks or tools. */
  cliPath?: string;
  /** Model list + defaults; injectable for tests. */
  models?: HarnessModelCatalogAccess;
  /** Rollout existence (resume vs. fresh); injectable for tests. */
  transcripts?: CodexTranscriptAccess;
  /** Codex's home (`$CODEX_HOME` or `~/.codex`). */
  homeDir?: string;
  /** The composer's `/` menu; injectable for tests. */
  slashCommands?: HarnessSlashCommandAccess;
}

export class CodexHarnessAdapter implements HarnessAdapter {
  readonly id = CODEX_HARNESS_ID;
  readonly label = "Codex";
  readonly command = "codex";
  readonly descriptor: HarnessDescriptor = CODEX_DESCRIPTOR;
  readonly capabilities: HarnessCapabilities = CODEX_CAPABILITIES;
  readonly messaging: HarnessMessagingCapabilities = {
    ...CODEX_MESSAGING_CAPABILITIES,
  };
  readonly review: HarnessReviewCapability = codexSkillReview;
  private readonly readPresence: (taskId: string) => Promise<PresenceStatus>;
  private readonly models: HarnessModelCatalogAccess;
  private readonly transcripts: CodexTranscriptAccess;
  private readonly slashCommands: HarnessSlashCommandAccess;
  private readonly cliPath: string | undefined;

  constructor(options: CodexHarnessAdapterOptions = {}) {
    this.readPresence = createPresenceReader(options);
    const access = options.homeDir ? { homeDir: options.homeDir } : {};
    this.models = options.models ?? new CodexModelCatalogAccess(access);
    this.transcripts =
      options.transcripts ?? new LocalCodexTranscriptAccess(access);
    this.slashCommands =
      options.slashCommands ??
      new CodexSlashCommandAccess(
        options.homeDir ? { codexHome: options.homeDir } : {},
      );
    this.cliPath = options.cliPath;
  }

  /** Codex's skills, which a prompt names as `$name`. */
  listSlashCommands(cwd?: string): Promise<SlashCommand[]> {
    return this.slashCommands.listSlashCommands(cwd);
  }

  /** Per-model tokens from the rollout (`token_usage_record` lines); no cost. */
  readSessionUsage(sessionPath: string): Promise<SessionUsage | undefined> {
    return readCodexSessionUsage(sessionPath);
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
    // Only an id Codex already knows names this session; a new or forked
    // one is learned from SessionStart (core's id is a placeholder).
    if (input.session?.mode === "new" || input.session?.mode === "fork") {
      delete env[SESSION_ID_ENV];
    }
    const tooling: string[] = [];
    if (this.cliPath) {
      tooling.push(
        "--enable",
        "hooks",
        "--dangerously-bypass-hook-trust",
        ...codexHookOverrides(this.cliPath),
        ...codexMcpOverrides({
          cliPath: this.cliPath,
          env: mcpIdentityEnv(env),
          cwd: input.workspacePath,
        }),
      );
    }
    const session = codexSessionArgs(input.session, (id) =>
      this.transcripts.exists(id),
    );
    const prompt = deliverInitialPrompt(input, codexPromptArgs, (path) => [
      "--",
      readPromptFileInstruction(path),
    ]);
    return {
      command: harnessLaunchCommand(this),
      args: [
        ...tooling,
        ...[
          ...CODEX_SANDBOX_OVERRIDES,
          ...CODEX_NOTIFICATION_OVERRIDES,
          ...CODEX_STARTUP_OVERRIDES,
        ].flatMap((override) => ["-c", override]),
        ...(input.permissions === "bypass"
          ? ["--dangerously-bypass-approvals-and-sandbox"]
          : []),
        ...session.options,
        ...session.subcommand,
        ...prompt.args,
      ],
      cwd: input.workspacePath,
      env,
      ...(prompt.promptFile ? { promptFile: prompt.promptFile } : {}),
    };
  }

  /**
   * `codex queue --thread <id> --message <text>` (X5): the app runs it for a
   * follow-up or to wake an idle session (core never spawns). Steer stays
   * with the PostToolUse hook.
   */
  deliverCommand(
    kind: "followUp" | "wakeIdle",
    sessionId: string,
    text: string,
  ): HarnessDeliverCommand | undefined {
    if (!sessionId || !text.trim()) return undefined;
    if (kind !== "followUp" && kind !== "wakeIdle") return undefined;
    return {
      command: harnessLaunchCommand(this),
      args: ["queue", "--thread", sessionId, "--message", text],
    };
  }

  presence(taskId: string): Promise<PresenceStatus> {
    return this.readPresence(taskId);
  }

  async stopHeadless(_taskId: string): Promise<void> {
    throw new Error("CodexHarnessAdapter.stopHeadless is not implemented");
  }

  async attach(_taskId: string): Promise<void> {
    throw new Error("CodexHarnessAdapter.attach is not implemented");
  }
}
