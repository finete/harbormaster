// Pi harness adapter — the only adapter v1 needs (see /AGENTS.md: "Agent
// harnesses are adapters" and /docs/design-decisions.md #13). Pure launch-
// spec logic plus a presence read through `SessionPresenceAccess`; no
// process spawning here (accessor separation is a hard rule — ptys are a
// frontend resource, see /docs/design-decisions.md "Layering").

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PiSlashCommandAccess } from "../access/local-slash-command-access.js";
import { PiModelCatalogAccess } from "../access/pi-model-catalog-access.js";
import { readPiSessionUsage } from "../access/pi-session-usage-access.js";
import { SessionPresenceAccess } from "../access/session-presence-access.js";
import type {
  BuildLaunchSpecInput,
  ExpectedSessionFile,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessDescriptor,
  HarnessModelCatalog,
  HarnessModelCatalogAccess,
  HarnessReviewCapability,
  HarnessSlashCommandAccess,
  LaunchSpec,
  PresenceStatus,
  SessionLaunch,
  SlashCommand,
} from "../contracts/harness.js";
import type { HarnessMessagingCapabilities } from "../contracts/messaging.js";
import type { Clock, PresenceAccess } from "../contracts/services.js";
import type { SessionUsage } from "../contracts/usage.js";
import { canonicalPath } from "../utilities/canonical-path.js";
import { SystemClock } from "../utilities/defaults.js";
import {
  resolveSocketPath,
  resolveStatePaths,
} from "../utilities/state-paths.js";
import {
  applyOpenUrlEnv,
  deliverInitialPrompt,
  plannotatorSlashReview,
} from "./adapter-common.js";
import {
  harnessCommandEnvName,
  harnessLaunchCommand,
  isTerminalShim,
  parseVersionOutput,
} from "./descriptor.js";
import {
  derivePresenceStatus,
  type PresenceLivenessOptions,
} from "./presence-heuristics.js";

export interface PiHarnessAdapterOptions {
  /**
   * Per-user state directory root. Used to locate the presence registry
   * (`<stateDir>/presence`) unless `presence` is supplied directly.
   */
  stateDir?: string;
  /** Inject a presence access directly (tests, or a non-default layout). */
  presence?: PresenceAccess;
  clock?: Clock;
  /**
   * Optional process-liveness probe forwarded to the presence heuristic.
   * Defaults to a real `process.kill(pid, 0)` probe (see `defaultIsAlive`
   * below) — tests that register fake pids should override this.
   */
  isAlive?: (pid: number) => boolean;
  /** Model-catalog access (`pi --list-models` + Pi settings); injectable for tests. */
  models?: HarnessModelCatalogAccess;
  /**
   * Absolute path of the `harbormaster` CLI executable (the app's PATH is
   * not the user's shell PATH, so never a bare name). When set, every
   * launch gets the per-session MCP server (`harbormaster mcp`) in
   * `HARBORMASTER_MCP_SERVER`, which the Harbormaster Pi extension registers
   * for the pane's own session (`pi.registerMcpServer`), plus
   * `HARBORMASTER_CLI` for hooks and shells.
   */
  cliPath?: string;
  /** Pi's agent dir (sessions live in `<agentDir>/sessions`); defaults to `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, as Pi resolves it. */
  agentDir?: string;
  /** The composer's `/` menu; injectable for tests. */
  slashCommands?: HarnessSlashCommandAccess;
}

/** Marker env var every launched Pi session can check to detect it is Harbormaster-hosted. */
const MARKER_ENV = "HARBORMASTER";
const TASK_ID_ENV = "HARBORMASTER_TASK_ID";
const STATE_DIR_ENV = "HARBORMASTER_STATE_DIR";
/** The exact session this pane launched: lets the extension ignore inherited env in nested pi processes (subagent children). */
const SESSION_ID_ENV = "HARBORMASTER_SESSION_ID";
/** The exact session file this pane opened, when it opened one: identifies the pane's own session even when core does not know (or has a stale) id for it. */
const SESSION_PATH_ENV = "HARBORMASTER_SESSION_PATH";
/** The app's local tool socket (see `transport/`): what the CLI, the MCP server and the extension talk to. */
const SOCKET_ENV = "HARBORMASTER_SOCKET";
/** Absolute path of the `harbormaster` CLI. */
const CLI_ENV = "HARBORMASTER_CLI";
/** JSON `mcpServers` entry for the per-session `harbormaster mcp` server (see `piMcpServerConfig`). */
const MCP_SERVER_ENV = "HARBORMASTER_MCP_SERVER";
/** Pi reports OSC 7501 program status without waiting for the probe round-trip (decision #18). */
const PROGRAM_STATUS_ENV = "PI_PROGRAM_STATUS";

/** The MCP server name tools appear under in Pi (`mcp__harbormaster__<tool>`). */
export const HARBORMASTER_MCP_SERVER_NAME = "harbormaster";

/**
 * The per-session `mcpServers` entry for `harbormaster mcp` (Pi's `mcp.json`
 * shape, as `pi.registerMcpServer` takes it). Identity travels in the
 * server's own env, never in tool arguments; `direct` exposure declares the
 * catalog to the model like built-in tools.
 */
export function piMcpServerConfig(input: {
  cliPath: string;
  env: Record<string, string>;
  cwd: string;
}): Record<string, unknown> {
  return {
    command: input.cliPath,
    args: ["mcp"],
    env: input.env,
    cwd: input.cwd,
    exposure: "direct",
    description:
      "Harbormaster: report this task's status, launch and poll tasks, find tasks and message them.",
  };
}

/**
 * Real-world default pid probe: a process that no longer exists cannot be
 * working. This is process introspection, not spawning — acceptable in the
 * harness layer (accessor separation guards resource I/O, not `kill(pid,
 * 0)`). `process.kill(pid, 0)` sends no signal; it only checks existence
 * (ESRCH -> dead) versus a permission error (EPERM -> alive, owned by
 * another user).
 */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Pi's CLI takes a first message as a positional argument (`pi [options]
 * [--] [@files...] [messages...]`), opening an interactive session that
 * immediately sends it. The pty spawns argv directly (no shell), so no shell
 * quoting is needed — only Pi's own parsing must be defused: `--` ends
 * option parsing (a prompt starting with "-" is never read as a flag), and a
 * leading "@" (Pi's file-attachment marker, honored even after `--`) is
 * shielded with a leading space. Multiline prompts pass through verbatim.
 */
export function piPromptArgs(prompt: string | undefined): string[] {
  if (!prompt?.trim()) return [];
  return ["--", prompt.startsWith("@") ? ` ${prompt}` : prompt];
}

/**
 * A long prompt as a file Pi attaches itself (`@<path>`, read into the
 * first message: no tool call, no permission), plus the line that says
 * what it is. Verified: `pi -p -- @<file> "…"` answers from the file.
 */
export function piPromptFileArgs(path: string): string[] {
  return ["--", `@${path}`, "Follow the task brief in the attached file."];
}

/**
 * Map core's session decision onto Pi's CLI (verified against pi 1.0.x
 * `pi --help` and docs/cli.md):
 *
 * - `--session <path>` opens that exact file; Pi takes the cwd from the
 *   file's header (an interactive prompt offers to continue in the current
 *   cwd if that directory no longer exists).
 * - `--session-id <id>` opens the session with that exact id in the cwd's
 *   project, or creates it under that id when absent — which is how core
 *   pre-assigns a task's session before Pi ever wrote the file.
 * - `--fork <path> --session-id <id>` copies a session into a new one for
 *   the current cwd, under the chosen id (the two flags combine; `--fork`
 *   must not be combined with `--session`/`--continue`, and `--session-id`
 *   must not be combined with `--session`/`--continue`).
 * - `--continue` reopens the most recent session for the cwd.
 * - `open` maps to `--session <path>` as well: the file is known, its id
 *   is not (yet).
 */
export function piSessionArgs(session: SessionLaunch | undefined): string[] {
  if (!session) return [];
  switch (session.mode) {
    case "new":
      return [
        "--session-id",
        session.sessionId,
        ...(session.model ? ["--model", session.model] : []),
        ...(session.thinking ? ["--thinking", session.thinking] : []),
      ];
    case "resume":
      return session.sessionPath
        ? ["--session", session.sessionPath]
        : ["--session-id", session.sessionId];
    case "fork":
      return ["--fork", session.forkFrom, "--session-id", session.sessionId];
    case "open":
      return ["--session", session.sessionPath];
    case "continue":
      return ["--continue"];
  }
}

/**
 * The pane's own-session identity for the extension's inherited-env guard:
 * the id core assigned and, when the pane opens a specific file, that file.
 * The extension accepts a session matching either, so a recorded file whose
 * id core never knew (or knew wrongly) still counts as the pane's own.
 */
function sessionIdentityEnv(
  session: SessionLaunch | undefined,
): Record<string, string> {
  if (!session) return {};
  switch (session.mode) {
    case "new":
    case "fork":
      return { [SESSION_ID_ENV]: session.sessionId };
    case "resume":
      return {
        [SESSION_ID_ENV]: session.sessionId,
        ...(session.sessionPath
          ? { [SESSION_PATH_ENV]: session.sessionPath }
          : {}),
      };
    case "open":
      return { [SESSION_PATH_ENV]: session.sessionPath };
    case "continue":
      return {};
  }
}

/** Pi's agent dir as Pi resolves it: `$PI_CODING_AGENT_DIR` (tilde-expanded), else `~/.pi/agent`. */
export function defaultPiAgentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (fromEnv) {
    if (fromEnv === "~") return homedir();
    if (fromEnv.startsWith("~/")) return join(homedir(), fromEnv.slice(2));
    return fromEnv;
  }
  return join(homedir(), ".pi", "agent");
}

/**
 * The directory Pi keeps a cwd's sessions in (pi-coding-agent's
 * `getDefaultSessionDirPath`): `<agentDir>/sessions/--<cwd, separators as
 * dashes>--`. Session files in it are named `<timestamp>_<sessionId>.jsonl`.
 */
export function piSessionDir(cwd: string, agentDir: string): string {
  const safe = `--${resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", safe);
}

/** Pi's in-session extension can receive, steer, follow up, and inline images. */
export const PI_MESSAGING_CAPABILITIES: HarnessMessagingCapabilities = {
  receive: true,
  steer: true,
  followUp: true,
  images: true,
};

export const PI_HARNESS_ID = "pi";

/** Pi's agent dir for `env`/`home` (pure twin of `defaultPiAgentDir`). */
function piAgentDir(env: NodeJS.ProcessEnv, home: string): string {
  const fromEnv = env.PI_CODING_AGENT_DIR;
  if (!fromEnv) return join(home, ".pi", "agent");
  if (fromEnv === "~") return home;
  if (fromEnv.startsWith("~/")) return join(home, fromEnv.slice(2));
  return fromEnv;
}

const PI_INSTALL = "npm install -g @earendil-works/pi-coding-agent";

/**
 * Pi's install/version facts (P2). Floor 1.1.0: the first release that
 * speaks OSC 7501 (presence); below it a session never reads live, so idle
 * delivery, wake-up and the Review button's typing all break. Verified 1.5.2:
 * the real-CLI pin (`PINNED` in packages/app/tests/real-cli-smoke.test.ts).
 */
export const PI_DESCRIPTOR: HarnessDescriptor = {
  id: PI_HARNESS_ID,
  label: "Pi",
  commands: [["pi"]],
  // `HARBORMASTER_PI_COMMAND`: e2e points it at a tiny fake binary.
  commandEnv: [harnessCommandEnvName(PI_HARNESS_ID)],
  installHint: PI_INSTALL,
  upgradeHint: `${PI_INSTALL}@latest`,
  setupNote:
    "Pi gets Harbormaster's small inbox extension installed automatically, so messages reach its sessions.",
  versionArgs: ["--version"],
  parseVersion: parseVersionOutput,
  minVersion: "1.1.0",
  verifiedVersion: "1.5.2",
  configDir: piAgentDir,
  reviewPieces: ["pi-extension"],
  isShim: isTerminalShim,
};

/**
 * Pi's capabilities (P6): Harbormaster pre-assigns the session id
 * (`--session-id`); status is OSC 7501 without the probe round-trip
 * (`PI_PROGRAM_STATUS=1`; no dialect quirks: the recorded fixtures under
 * tests/fixtures/status/pi/ follow the spec); the Harbormaster Pi extension claims the inbox
 * and delivers steer, follow-up and idle wake-ups itself.
 */
export const PI_CAPABILITIES: HarnessCapabilities = {
  sessionId: "preassign",
  status: {
    protocol: "osc7501",
    probe: false,
    states: ["idle", "working", "blocked", "done", "error"],
    quirks: [],
  },
  delivery: {
    steer: true,
    followUp: true,
    wakeIdle: true,
    channels: {
      steer: "Harbormaster Pi extension (steer)",
      followUp: "Harbormaster Pi extension (followUp)",
      wakeIdle: "Harbormaster Pi extension (inbox poll while idle)",
    },
  },
  trustPrompt: false,
  review: true,
};

export class PiHarnessAdapter implements HarnessAdapter {
  readonly id = PI_HARNESS_ID;
  readonly label = "Pi";
  readonly command = "pi";
  readonly descriptor: HarnessDescriptor = PI_DESCRIPTOR;
  readonly capabilities: HarnessCapabilities = PI_CAPABILITIES;
  readonly messaging: HarnessMessagingCapabilities = {
    ...PI_MESSAGING_CAPABILITIES,
  };
  /** The Plannotator Pi extension's `/plannotator-review [<PR URL>]`. */
  readonly review: HarnessReviewCapability = plannotatorSlashReview;
  private readonly presenceAccess: PresenceAccess;
  private readonly models: HarnessModelCatalogAccess;
  private readonly clock: Clock;
  private readonly livenessOptions: PresenceLivenessOptions;
  private readonly cliPath: string | undefined;
  private readonly agentDir: string | undefined;
  private readonly slashCommands: HarnessSlashCommandAccess;

  constructor(options: PiHarnessAdapterOptions = {}) {
    this.presenceAccess =
      options.presence ??
      new SessionPresenceAccess(
        resolveStatePaths(options.stateDir).presenceDir,
      );
    this.clock = options.clock ?? new SystemClock();
    this.livenessOptions = { isAlive: options.isAlive ?? defaultIsAlive };
    this.models = options.models ?? new PiModelCatalogAccess();
    this.cliPath = options.cliPath;
    this.agentDir = options.agentDir;
    this.slashCommands =
      options.slashCommands ??
      new PiSlashCommandAccess(
        options.agentDir ? { agentDir: options.agentDir } : {},
      );
  }

  /** Pi's prompt templates (`/name`) and skills (`/skill:name`). */
  listSlashCommands(cwd?: string): Promise<SlashCommand[]> {
    return this.slashCommands.listSlashCommands(cwd);
  }

  /** Pi keys its session dir by its resolved cwd (`/tmp` → `/private/tmp` on macOS). */
  expectedSessionFile(cwd: string, sessionId: string): ExpectedSessionFile {
    return {
      dir: piSessionDir(
        canonicalPath(cwd),
        this.agentDir ?? defaultPiAgentDir(),
      ),
      fileSuffix: `_${sessionId}.jsonl`,
    };
  }

  /** Per-model tokens + Pi's own cost estimate (`usage.cost.total`), fork prefix from the header's `parentSession`. */
  readSessionUsage(sessionPath: string): Promise<SessionUsage | undefined> {
    return readPiSessionUsage(sessionPath);
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
    const env: Record<string, string> = {
      [MARKER_ENV]: "1",
      [TASK_ID_ENV]: input.taskId,
      [STATE_DIR_ENV]: input.stateDir,
      // Children spawned inside the pane (pi-subagents workers and the
      // like) inherit this whole environment; the extension compares its
      // actual session id against this value and stands down on mismatch,
      // so a child can never stomp the pane's presence record with its own
      // short-lived pid (the grey-dot-while-working bug).
      ...sessionIdentityEnv(input.session),
      [SOCKET_ENV]: resolveSocketPath(input.stateDir),
      [PROGRAM_STATUS_ENV]: "1",
    };
    applyOpenUrlEnv(env, input);
    if (this.cliPath) {
      env[CLI_ENV] = this.cliPath;
      const identity: Record<string, string> = {
        [TASK_ID_ENV]: input.taskId,
        [STATE_DIR_ENV]: input.stateDir,
        [SOCKET_ENV]: env[SOCKET_ENV] as string,
      };
      if (env[SESSION_ID_ENV]) identity[SESSION_ID_ENV] = env[SESSION_ID_ENV];
      env[MCP_SERVER_ENV] = JSON.stringify(
        piMcpServerConfig({
          cliPath: this.cliPath,
          env: identity,
          cwd: input.workspacePath,
        }),
      );
    }
    const prompt = deliverInitialPrompt(input, piPromptArgs, piPromptFileArgs);
    return {
      // HARBORMASTER_PI_COMMAND lets e2e point this at a tiny fake binary
      // instead of a real `pi` install; unset (the normal case) runs `pi`.
      command: harnessLaunchCommand(this),
      args: [...piSessionArgs(input.session), ...prompt.args],
      cwd: input.workspacePath,
      env,
      ...(prompt.promptFile ? { promptFile: prompt.promptFile } : {}),
    };
  }

  async presence(taskId: string): Promise<PresenceStatus> {
    const record = await this.presenceAccess.read(taskId);
    return derivePresenceStatus(record, this.clock.now(), this.livenessOptions);
  }

  async stopHeadless(_taskId: string): Promise<void> {
    throw new Error(
      "PiHarnessAdapter.stopHeadless is not implemented yet (wave 4: needs frontend/process-owner cooperation)",
    );
  }

  async attach(_taskId: string): Promise<void> {
    throw new Error(
      "PiHarnessAdapter.attach is not implemented yet (wave 4: needs frontend pty cooperation)",
    );
  }
}
