// Cursor CLI harness adapter (docs/harness-additions.md C1-C9). Cursor
// reports nothing on its pty (no 7501, no OSC 9; the title is the chat's),
// so presence comes from its hooks (`status.protocol: "hooks"`), and hooks +
// the `harbormaster mcp` server travel in a per-session plugin directory
// under Harbormaster's state dir (`--plugin-dir`), written by the launcher
// (`LaunchSpec.prepare`). Nothing is written into the worktree or Cursor's
// own directories.
//
// Verified against cursor-agent 2026.11.13-eacade1 (`--help`, its bundled
// sources, real pty runs, logged in, 2026-11-17):
// - `agent [options] [prompt...]`: `--trust` and `--approve-mcps` skip the
//   "Workspace Trust Required" and "MCP Server Approval Required" dialogs;
//   `--` ends option parsing (a prompt starting with "-" stays a prompt,
//   quotes pass verbatim); `-f` = "Run Everything"; `--model <id>`; no
//   thinking flag (effort is part of the model id, e.g. `…-high`).
// - `--plugin-dir <dir>` loads `<dir>/.cursor-plugin/plugin.json`,
//   `<dir>/hooks/hooks.json` (a `hooks.json` at the plugin root is NOT
//   loaded) and `<dir>/mcp.json`. Hooks inherit the agent's environment.
// - `sessionStart` fires when a NEW chat is created (with a command-line
//   prompt, at the same moment as `beforeSubmitPrompt`, either first);
//   `--resume=<id>` fires none. Payloads: `conversation_id` = `session_id`,
//   `generation_id`, `model`, `workspace_roots`, `transcript_path` (null
//   until the transcript exists: it is written when the first turn ends).
// - `beforeSubmitPrompt` output `{continue: true, additional_context}`
//   reaches the model (undocumented, verified: catch-up). `postToolUse`
//   `additional_context` lands inside the tool result, where the model
//   treats it as a prompt injection and ignores it: no steer.
//   `afterShellExecution` / `afterFileEdit` outputs are not read.
// - `stop` payload: `status` (`completed`, `aborted` on Esc, followed by an
//   `error` stop for the same generation), `loop_count`, per-turn tokens.
//   `{followup_message}` is submitted as the next user message without a
//   `beforeSubmitPrompt`; the follow-up turn's `stop` has `loop_count` 1.
// - `create-chat` exists (prints a new id, then does not exit), unused: ids
//   are learned (C5).

import { join } from "node:path";
import {
  CursorModelCatalogAccess,
  type CursorTranscriptAccess,
  cursorConfigDir,
  cursorDataDir,
  cursorSessionIdFromPath,
  cursorTranscriptDir,
  LocalCursorTranscriptAccess,
  resolveCursorCommand,
} from "../access/cursor-code-access.js";
import { CursorSessionUsageAccess } from "../access/cursor-session-usage-access.js";
import type {
  HarnessTurnUsage,
  HookPresenceEvent,
} from "../contracts/commands.js";
import type {
  BuildLaunchSpecInput,
  ExpectedSessionFile,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessDescriptor,
  HarnessModelCatalog,
  HarnessModelCatalogAccess,
  LaunchSpec,
  PresenceStatus,
  SessionLaunch,
} from "../contracts/harness.js";
import { PTY_TYPING_CHANNEL } from "../contracts/harness.js";
import type { HarnessMessagingCapabilities } from "../contracts/messaging.js";
import type { SessionUsage } from "../contracts/usage.js";
import { canonicalPath } from "../utilities/canonical-path.js";
import { resolveStatePaths } from "../utilities/state-paths.js";
import {
  applyOpenUrlEnv,
  baseLaunchEnv,
  createPresenceReader,
  mcpIdentityEnv,
  type PresenceReaderOptions,
  SESSION_ID_ENV,
  shellQuote,
} from "./adapter-common.js";
import { harnessCommandEnvName, isTerminalShim } from "./descriptor.js";
import { HARBORMASTER_MCP_SERVER_NAME } from "./pi-adapter.js";

export const CURSOR_HARNESS_ID = "cursor";

/** Cursor's date-stamped version (`2026.11.13-eacade1` → `2026.11.13`); anything else is not Cursor. */
export function parseCursorVersion(output: string): string | undefined {
  return /(?:^|[^\d.])(\d{4}\.\d{2}\.\d{2})(?:-[0-9a-z]+)?(?![\d.])/i.exec(
    output,
  )?.[1];
}

/**
 * Cursor's install/version facts (P2, C6, C8). `agent` is a generic name:
 * its `--version` must print Cursor's date version, else the lookup tries
 * `cursor-agent`, then the IDE's `cursor agent`. Floor 2026.06.15: the
 * first with `--plugin-dir`.
 */
export const CURSOR_DESCRIPTOR: HarnessDescriptor = {
  id: CURSOR_HARNESS_ID,
  label: "Cursor",
  commands: [["agent"], ["cursor-agent"], ["cursor", "agent"]],
  commandEnv: [harnessCommandEnvName(CURSOR_HARNESS_ID)],
  installHint: "curl https://cursor.com/install -fsS | bash",
  upgradeHint: "curl https://cursor.com/install -fsS | bash",
  versionArgs: ["--version"],
  parseVersion: parseCursorVersion,
  versionIdentifies: true,
  minVersion: "2026.06.15",
  verifiedVersion: "2026.11.13",
  configDir: (env, home) => cursorConfigDir(env, home),
  // No Plannotator integration for Cursor's CLI (C7).
  reviewPieces: [],
  reviewUnavailableReason: "Plannotator doesn't support Cursor CLI yet",
  isShim: isTerminalShim,
};

/**
 * Cursor's capabilities (P6): the chat id is learned from the hooks;
 * presence from hooks (recorded fixtures under
 * tests/fixtures/status/cursor/); follow-up through the stop hook's
 * `followup_message`, catch-up through beforeSubmitPrompt's
 * `additional_context`; no steer (C4) and no way into an idle session but
 * typing (the app types into the pane once the agent is at its prompt);
 * `--trust` skips the folder-trust dialog.
 */
export const CURSOR_CAPABILITIES: HarnessCapabilities = {
  sessionId: "learned",
  status: {
    protocol: "hooks",
    probe: false,
    states: ["idle", "working", "done", "error"],
    // Each names the recorded fixture that shows it
    // (tests/fixtures/status/cursor/<version>/<scenario>.json) or says it
    // is unrecorded (asserted by the contract test).
    quirks: [
      "nothing on the pty (no 7501, no OSC 9): presence is the hooks' (sessionStart → idle, beforeSubmitPrompt/postToolUse → working, stop → done), registered at spawn as working 'Starting…' [fixture: startup]",
      "text typed before the TUI is ready is dropped: nothing is typed before sessionStart (a resume fires none: the pty settling stands in) [fixture: startup]",
      "with a command-line prompt, sessionStart and beforeSubmitPrompt fire together, in either order: sessionStart never overrides a running turn [unrecorded]",
      "Esc fires stop 'aborted' then stop 'error' for the same generation: recorded idle, like Claude Code's and Codex's cancel [fixture: cancel]",
      "a backgrounded command (`sleep 120 &`) keeps the turn running: the agent polls its output (postToolUse Read) until it ends, then stop 'completed' = done; never a lingering working after stop [fixture: background-work]",
      "a stop hook's followup_message runs a turn with no beforeSubmitPrompt: the stop that delivered it reports working [unrecorded]",
      "a permission prompt fires no hook: blocked is never reported (open contract row cursor.status.blocked) [unrecorded]",
      "exit (Ctrl+D twice) fires none of our hooks (only sessionEnd, unregistered): pid liveness ends the attachment [fixture: exit]",
    ],
  },
  delivery: {
    steer: false,
    followUp: true,
    wakeIdle: false,
    channels: {
      followUp: "stop hook (followup_message)",
      catchUp: "beforeSubmitPrompt hook (additional_context)",
      wakeIdle: PTY_TYPING_CHANNEL,
    },
  },
  trustPrompt: false,
  review: false,
};

/** Text only: attachments travel as the copies' paths in the text. */
export const CURSOR_MESSAGING_CAPABILITIES: HarnessMessagingCapabilities = {
  receive: true,
  steer: false,
  followUp: true,
  images: false,
};

/** The hook events Harbormaster registers, with the `--event` name `harbormaster hook cursor` takes. */
export const CURSOR_HOOK_EVENTS = {
  sessionStart: "session-start",
  beforeSubmitPrompt: "before-submit-prompt",
  postToolUse: "post-tool-use",
  stop: "stop",
} as const;

/** One of Cursor's hook `--event` names. */
export type CursorHookEventName =
  (typeof CURSOR_HOOK_EVENTS)[keyof typeof CURSOR_HOOK_EVENTS];

/**
 * The hook presence event (`CoreCommands.reportHookPresence`) a Cursor
 * hook reports: a stop that handed Cursor a follow-up keeps the turn
 * running (the follow-up turn fires no beforeSubmitPrompt).
 */
export function cursorHookPresenceEvent(
  event: CursorHookEventName,
  deliveredFollowUp: boolean,
): HookPresenceEvent {
  switch (event) {
    case "session-start":
      return "start";
    case "before-submit-prompt":
      return "prompt";
    case "post-tool-use":
      return "tool";
    case "stop":
      return deliveredFollowUp ? "prompt" : "stop";
  }
}

/** Seconds Cursor waits for one hook (ours reply in milliseconds). */
const HOOK_TIMEOUT_SECONDS = 10;

/** The plugin's manifest name (`.cursor-plugin/plugin.json`). */
export const CURSOR_PLUGIN_NAME = "harbormaster";

/**
 * The per-session plugin directory's files (C2), relative to the plugin
 * root: the manifest, `hooks/hooks.json` (one command per event calling
 * the absolute CLI) and `mcp.json` (the `harbormaster mcp` server, the same
 * entry Claude Code and Codex get).
 */
export function cursorPluginFiles(input: {
  cliPath: string;
  env: Record<string, string>;
}): Record<string, string> {
  const cli = shellQuote(input.cliPath);
  const hooks = Object.fromEntries(
    Object.entries(CURSOR_HOOK_EVENTS).map(([event, name]) => [
      event,
      [
        {
          command: `${cli} hook cursor --event ${name}`,
          timeout: HOOK_TIMEOUT_SECONDS,
        },
      ],
    ]),
  );
  return {
    ".cursor-plugin/plugin.json": `${JSON.stringify(
      {
        name: CURSOR_PLUGIN_NAME,
        description:
          "Harbormaster session glue: lifecycle hooks and the harbormaster tools",
        version: "1.0.0",
      },
      null,
      2,
    )}\n`,
    "hooks/hooks.json": `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`,
    "mcp.json": `${JSON.stringify(
      {
        mcpServers: {
          [HARBORMASTER_MCP_SERVER_NAME]: {
            command: input.cliPath,
            args: ["mcp"],
            env: input.env,
          },
        },
      },
      null,
      2,
    )}\n`,
  };
}

/** `<stateDir>/cursor-plugins/<taskId>`: the task's plugin directory. */
export function cursorPluginDir(stateDir: string, taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(resolveStatePaths(stateDir).cursorPluginsDir, safe);
}

/** The prompt as Cursor's positional argument, after `--` (a leading "-" stays text). */
export function cursorPromptArgs(prompt: string | undefined): string[] {
  if (!prompt?.trim()) return [];
  return ["--", prompt];
}

/**
 * Core's session decision → Cursor's flags:
 *
 * - `new`: nothing (Cursor picks the id; the hooks report it) + `--model`.
 * - `resume`: `--resume=<id> --workspace <cwd>` when Cursor has that chat,
 *   else a fresh one.
 * - `fork`: Cursor cannot copy a chat: `--resume=<id>` continues the
 *   previous cycle's chat (its id from the transcript path); a fresh chat
 *   when there is none.
 * - `open`: `--resume=<id from the transcript path>`; `--continue` when
 *   the path names none.
 * - `continue`: `--continue` (the newest chat).
 */
export function cursorSessionArgs(
  session: SessionLaunch | undefined,
  cwd: string,
  chatExists: (sessionId: string) => boolean = () => true,
): string[] {
  if (!session) return [];
  const resume = (id: string) => [`--resume=${id}`, "--workspace", cwd];
  switch (session.mode) {
    case "new":
      return session.model ? ["--model", session.model] : [];
    case "resume":
      return chatExists(session.sessionId) ? resume(session.sessionId) : [];
    case "fork": {
      const id =
        cursorSessionIdFromPath(session.forkFrom) ??
        (chatExists(session.forkFrom) ? session.forkFrom : undefined);
      return id ? resume(id) : [];
    }
    case "open": {
      const id = cursorSessionIdFromPath(session.sessionPath);
      return id ? resume(id) : ["--continue"];
    }
    case "continue":
      return ["--continue"];
  }
}

/** Whether a launch opens an existing chat (no sessionStart will fire). */
export function cursorLaunchResumes(args: readonly string[]): boolean {
  return args.some((arg) => arg.startsWith("--resume") || arg === "--continue");
}

export interface CursorHarnessAdapterOptions extends PresenceReaderOptions {
  /** Absolute path of the `harbormaster` CLI; without it sessions start without hooks or tools. */
  cliPath?: string;
  /** Model list + defaults; injectable for tests. */
  models?: HarnessModelCatalogAccess;
  /** Chat existence (resume vs. fresh); injectable for tests. */
  transcripts?: CursorTranscriptAccess;
  /** The argv prefix that runs Cursor (C6 lookup); injectable for tests. */
  resolveCommand?: (env: NodeJS.ProcessEnv) => string[] | undefined;
  /** Cursor's data dir (`projects/`); defaults to `$CURSOR_DATA_DIR` or `~/.cursor`. */
  dataDir?: string;
  /** Per-turn token ledger; injectable for tests. */
  usage?: CursorSessionUsageAccess;
}

export class CursorHarnessAdapter implements HarnessAdapter {
  readonly id = CURSOR_HARNESS_ID;
  readonly label = "Cursor";
  readonly command = "agent";
  readonly descriptor: HarnessDescriptor = CURSOR_DESCRIPTOR;
  readonly capabilities: HarnessCapabilities = CURSOR_CAPABILITIES;
  readonly messaging: HarnessMessagingCapabilities = {
    ...CURSOR_MESSAGING_CAPABILITIES,
  };
  private readonly readPresence: (taskId: string) => Promise<PresenceStatus>;
  private readonly models: HarnessModelCatalogAccess;
  private readonly transcripts: CursorTranscriptAccess;
  private readonly cliPath: string | undefined;
  private readonly resolveCommand: (
    env: NodeJS.ProcessEnv,
  ) => string[] | undefined;
  private readonly dataDir: string | undefined;
  private readonly usage: CursorSessionUsageAccess;

  constructor(options: CursorHarnessAdapterOptions = {}) {
    this.readPresence = createPresenceReader(options);
    this.resolveCommand =
      options.resolveCommand ??
      ((env) => resolveCursorCommand(env, isTerminalShim));
    this.models =
      options.models ??
      new CursorModelCatalogAccess({ command: () => this.launchArgv() });
    this.transcripts =
      options.transcripts ??
      new LocalCursorTranscriptAccess(
        options.dataDir ? { dataDir: options.dataDir } : {},
      );
    this.cliPath = options.cliPath;
    this.dataDir = options.dataDir;
    this.usage =
      options.usage ??
      new CursorSessionUsageAccess(
        options.stateDir ? { stateDir: options.stateDir } : {},
      );
  }

  /** The argv prefix a launch runs: the override env var, else the C6 lookup, else `agent`. */
  launchArgv(env: NodeJS.ProcessEnv = process.env): string[] {
    for (const name of this.descriptor.commandEnv) {
      const value = env[name];
      if (value) return [value];
    }
    return this.resolveCommand(env) ?? ["agent"];
  }

  /** Per-model tokens the stop hooks reported (the transcript has none); no cost. */
  readSessionUsage(sessionPath: string): Promise<SessionUsage | undefined> {
    return this.usage.read(sessionPath);
  }

  recordTurnUsage(usage: HarnessTurnUsage): Promise<void> {
    return this.usage.record(usage);
  }

  expectedSessionFile(
    cwd: string,
    sessionId: string,
  ): ExpectedSessionFile | undefined {
    if (!sessionId) return undefined;
    return {
      dir: cursorTranscriptDir(
        this.dataDir ?? cursorDataDir(),
        canonicalPath(cwd),
        sessionId,
      ),
      fileSuffix: `${sessionId}.jsonl`,
    };
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
    // Only an id Cursor already knows names this session; a new one is
    // learned from the hooks (core's id is a placeholder), and so is a
    // fork's (it continues the previous cycle's chat, bound again by the
    // first hook).
    if (input.session?.mode === "new" || input.session?.mode === "fork") {
      delete env[SESSION_ID_ENV];
    }
    const session = cursorSessionArgs(
      input.session,
      input.workspacePath,
      (id) => this.transcripts.exists(input.workspacePath, id),
    );
    const pluginDir = cursorPluginDir(input.stateDir, input.taskId);
    const [command, ...prefix] = this.launchArgv();
    const tooling = this.cliPath ? ["--plugin-dir", pluginDir] : [];
    return {
      command: command as string,
      args: [
        ...prefix,
        "--trust",
        "--approve-mcps",
        ...tooling,
        ...(input.permissions === "bypass" ? ["-f"] : []),
        ...session,
        ...cursorPromptArgs(input.initialPrompt),
      ],
      cwd: input.workspacePath,
      env,
      ...(this.cliPath
        ? {
            prepare: {
              dir: pluginDir,
              files: cursorPluginFiles({
                cliPath: this.cliPath,
                env: mcpIdentityEnv(env),
              }),
            },
          }
        : {}),
      hookStatus: { ready: cursorLaunchResumes(session) ? "quiet" : "hook" },
    };
  }

  presence(taskId: string): Promise<PresenceStatus> {
    return this.readPresence(taskId);
  }

  async stopHeadless(_taskId: string): Promise<void> {
    throw new Error("CursorHarnessAdapter.stopHeadless is not implemented");
  }

  async attach(_taskId: string): Promise<void> {
    throw new Error("CursorHarnessAdapter.attach is not implemented");
  }
}
