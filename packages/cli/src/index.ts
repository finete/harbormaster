// The `harbormaster` CLI (decision #18, docs/release-plan.md "Tools: one
// catalog, two faces"): a thin client of the running app's local socket.
// It never touches state files and never hand-rolls a subset of the tool
// catalog: every catalog entry is a verb here and a tool in `harbormaster
// mcp`. With the app down, every command prints "Harbormaster is not
// running" and exits 2.
//
//   harbormaster mcp                                  MCP stdio server
//   harbormaster <tool> [--json '<args>'] [--<arg> <value>...] [--details]
//   harbormaster hook inbox --mode steer|follow-up|catch-up   (also reports the turn boundary, S5)
//   harbormaster hook codex --event session-start|user-prompt-submit|post-tool-use|stop   (X1-X3)
//   harbormaster hook cursor --event session-start|before-submit-prompt|post-tool-use|stop   (C2-C5)
//   harbormaster inbox claim --task <id> [--idle true|false]
//   harbormaster inbox list [--priority|--other] [--json]
//   harbormaster inbox resolve <id> [<button>]
//   harbormaster events [--task <id>] [--rule <id> [--file <f>]] [--since <time>] [--limit <n>] [--json]
//   harbormaster rules list | rules on | rules off | rules check [--task <id>] [--replay <from>]
//   harbormaster addons list
//   harbormaster usage [--from <date>] [--to <date>] [--repository <id>] [--harness <id>] [--model <id>] [--include-archived] [--json]
//   harbormaster usage refresh <taskId> [--json]
//   harbormaster doctor [--all-remotes] [--json]
//   harbormaster open-url <url> [--source plannotator|browser]
//   harbormaster review [--local|--pr] [--task <id>]
//
// The inbox / events / rules / addons / usage verbs are the core's user operations
// (`OPS_CATALOG`, tools/ops.ts) over the same socket, never hand-rolled here.
// `doctor` is the one verb that also works with the app down: it is most
// useful exactly then, so when nothing answers on the socket it runs the
// same read-only `doctor` command on an in-process core (never while the
// app runs: one writer per state dir).
//
// `open-url` is the agent's browser handler (docs/plannotator.md
// "Transport": `harbormaster open-url "$1" || open "$1"`): it exits 1 on any
// failure (app down, not a task session, not a loopback URL) so the
// script's system-browser fallback runs.

import {
  type CursorHookEventName,
  callerFromEnv,
  callOp,
  callTool,
  createCore,
  cursorDataDir,
  cursorHookPresenceEvent,
  cursorStopUsage,
  cursorTranscriptPath,
  DEFAULT_STATE_DIR,
  type DoctorInput,
  type DoctorReport,
  doctorExitCode,
  findTool,
  formatDoctorReport,
  formatTokenCount,
  HarbormasterNotRunningError,
  type InboxClaimDetails,
  NOT_RUNNING_MESSAGE,
  REPORT_STATUS_REMINDER,
  socketPathFromEnv,
  type TaskUsage,
  type TaskUsageRow,
  TOOL_CATALOG,
  type ToolCaller,
  type ToolDefinition,
  totalTokens,
} from "@harbormaster/core";
import { serveMcpOverStdio } from "./mcp.js";

export { createMcpServer } from "./mcp.js";

/** Exit code when the app is not running. */
export const EXIT_NOT_RUNNING = 2;

/** `open-url`'s exit code for every failure, the app being down included (the handler script then falls back to `open`). */
export const EXIT_OPEN_URL_FAILED = 1;

export interface CliIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Starts the MCP stdio server (injectable so tests never grab real stdio). */
  serveMcp?: typeof serveMcpOverStdio;
  /** The hook's stdin (Codex writes its event JSON there); defaults to reading process stdin with a short deadline. */
  readStdin?: () => Promise<string>;
  /** `doctor` with the app down (injectable; defaults to an in-process core). */
  localDoctor?: (
    env: NodeJS.ProcessEnv,
    input: DoctorInput,
  ) => Promise<DoctorReport>;
}

class UsageError extends Error {}

/** Parses `--key value` / `--key=value` / `--flag` pairs after the subcommand. */
export function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] as string;
    if (!token.startsWith("--")) {
      throw new UsageError(`unexpected argument "${token}"`);
    }
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(token.slice(2), "true");
    } else {
      flags.set(token.slice(2), next);
      index++;
    }
  }
  return flags;
}

/** Tool arguments from `--json` plus per-property flags, coerced by the catalog's schema. */
export function toolArgsFromFlags(
  tool: ToolDefinition,
  flags: Map<string, string>,
): Record<string, unknown> {
  let args: Record<string, unknown> = {};
  const json = flags.get("json");
  if (json !== undefined) {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error();
      }
      args = parsed as Record<string, unknown>;
    } catch {
      throw new UsageError("--json must be a JSON object");
    }
  }
  for (const [key, raw] of flags) {
    if (key === "json" || key === "details") continue;
    const schema = tool.inputSchema.properties[key] as
      | { type?: string }
      | undefined;
    if (!schema) {
      throw new UsageError(`${tool.name} has no argument "${key}"`);
    }
    if (schema.type === "boolean") args[key] = raw === "true";
    else if (schema.type === "array") args[key] = raw.split(",");
    else args[key] = raw;
  }
  return args;
}

function usage(): string {
  const width = Math.max(...TOOL_CATALOG.map((tool) => tool.name.length));
  const tools = TOOL_CATALOG.map(
    (tool) => `  ${tool.name.padEnd(width)}  ${tool.title}`,
  ).join("\n");
  return [
    "Usage: harbormaster <command>",
    "",
    "Tools (run against the Harbormaster app; identity comes from HARBORMASTER_TASK_ID):",
    tools,
    "  harbormaster <tool> [--json '<args>'] [--<arg> <value>...] [--details]",
    "",
    "Other commands:",
    "  mcp                                       MCP stdio server exposing every tool",
    "  hook inbox --mode steer|follow-up|catch-up   Claude Code hook: deliver inbox messages",
    "  hook codex --event <event>                Codex hook: session binding, turn boundaries, inbox (session-start|user-prompt-submit|post-tool-use|stop)",
    "  hook cursor --event <event>               Cursor hook: session binding, presence, usage, inbox (session-start|before-submit-prompt|post-tool-use|stop)",
    "  inbox claim --task <id> [--idle true|false]  Claim a task's inbox messages as JSON",
    "  inbox list [--priority|--other] [--json]  Items that need you (rule items, approvals)",
    "  inbox resolve <id> [<button>]             Press an item's button (default: dismiss)",
    "  events [--task <id>] [--rule <id> [--file <f>]] [--since <t>] [--limit <n>] [--json]  The rules audit log",
    "  rules list [--json]                       Rules as loaded: label, last fired, problems",
    "  rules on | rules off                      Turn the rules on or off",
    "  rules check [--task <id>] [--replay <from>] [--json]  Dry run over recorded events",
    "  addons list [--json]                      Built-in sources and installed addons",
    "  usage [--from <date>] [--to <date>] [--repository <id>] [--harness <id>] [--model <id>] [--include-archived] [--json]",
    "                                            Per-task token usage, most tokens first (default: all time); --json exports the rows",
    "  usage refresh <taskId> [--json]           Recompute one task's token usage from its session files",
    "  doctor [--all-remotes] [--json]           Check the setup (works with the app down); exit 1 on a failure.",
    "                                            Remotes: only repositories with an active task (max 5), or all with --all-remotes",
    "  open-url <url> [--source plannotator|browser]  Show a loopback URL in this task's tab (exit 1 otherwise)",
    "  review [--local|--pr] [--task <id>]       Start a Plannotator review in the task's session (default: its PR, else local)",
    "",
  ].join("\n");
}

type HookMode = "steer" | "follow-up" | "catch-up";

/** The Claude Code hook JSON for one inbox delivery (empty object when nothing to deliver). */
export function inboxHookOutput(mode: HookMode, text: string): unknown {
  if (!text) return {};
  if (mode === "follow-up") return { decision: "block", reason: text };
  return {
    hookSpecificOutput: {
      hookEventName: mode === "steer" ? "PostToolUse" : "UserPromptSubmit",
      additionalContext: text,
    },
  };
}

/**
 * The turn boundary a hook reports to core (docs/harness-additions.md S5):
 * PostToolUse = a tool ran, UserPromptSubmit = a prompt was submitted, Stop
 * = the turn is over, unless this very hook handed Claude a follow-up
 * (`decision: block` keeps the turn going).
 */
export function hookTurnBoundary(
  mode: HookMode,
  delivered: boolean,
): "stop" | "prompt" | "tool" {
  if (mode === "steer") return "tool";
  if (mode === "catch-up") return "prompt";
  return delivered ? "prompt" : "stop";
}

/** Best effort: a boundary that can't be reported (app down, older app) never fails the hook. */
async function reportTurnBoundary(
  socketPath: string,
  caller: ToolCaller,
  kind: "stop" | "prompt" | "tool",
): Promise<void> {
  try {
    await callOp(socketPath, "turn_boundary", { kind }, caller);
  } catch {
    // Presence falls back to the program-status reports alone.
  }
}

async function runHook(
  flags: Map<string, string>,
  socketPath: string,
  caller: ToolCaller,
  io: CliIo,
): Promise<number> {
  const mode = flags.get("mode");
  if (mode !== "steer" && mode !== "follow-up" && mode !== "catch-up") {
    throw new UsageError("--mode must be steer, follow-up or catch-up");
  }
  if (!caller.taskId) {
    // Not a Harbormaster task session: nothing to deliver.
    io.stdout(`${JSON.stringify({})}\n`);
    return 0;
  }
  // A running turn is known before the claim; Stop waits for its outcome.
  const early =
    mode === "follow-up"
      ? undefined
      : reportTurnBoundary(socketPath, caller, hookTurnBoundary(mode, false));
  let text: string;
  try {
    text = (
      await callTool(
        socketPath,
        "inbox_claim",
        { idle: mode !== "steer" },
        caller,
      )
    ).text;
  } catch (error) {
    if (!(error instanceof HarbormasterNotRunningError)) throw error;
    // A hook must never wedge the agent: Claude Code treats exit 2 from a
    // Stop hook as "keep going" and would loop. Say so on stderr, deliver
    // nothing, exit 0.
    io.stderr(`${NOT_RUNNING_MESSAGE}\n`);
    text = "";
  }
  await (early ??
    reportTurnBoundary(socketPath, caller, hookTurnBoundary(mode, !!text)));
  io.stdout(`${JSON.stringify(inboxHookOutput(mode, text))}\n`);
  return 0;
}

// --- Codex hooks (docs/harness-additions.md X1-X3, X5) -------------------------

/** The `--event` names `harbormaster hook codex` takes (`CODEX_HOOK_EVENTS` in core's adapter). */
export type CodexHookEvent =
  | "session-start"
  | "user-prompt-submit"
  | "post-tool-use"
  | "stop";

const CODEX_HOOK_EVENTS: readonly CodexHookEvent[] = [
  "session-start",
  "user-prompt-submit",
  "post-tool-use",
  "stop",
];

/**
 * Codex blocks its TUI until a hook exits (X2), so every socket round trip
 * of one hook run shares this budget; past it the hook replies with what it
 * has (nothing to deliver) and exits 0.
 */
export const CODEX_HOOK_DEADLINE_MS = 2_000;

/** How long the hook waits for Codex's stdin JSON (written before the hook runs, then closed). */
const CODEX_HOOK_STDIN_MS = 500;

/** `promise`, or `fallback` once `ms` passed (the promise keeps running; the process exits after the reply). */
function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Process stdin as text, or what arrived within `ms` (never waits on an open pipe forever). */
function readProcessStdin(ms = CODEX_HOOK_STDIN_MS): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let text = "";
    const done = () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(text);
    };
    const timer = setTimeout(done, ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      text += chunk;
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

/** The hook's event JSON (`{}` when absent or not an object). */
export function parseCodexHookInput(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Codex's hook output for one event: inbox text as `additionalContext`
 * (UserPromptSubmit = catch-up, PostToolUse = steer; Codex adds it as a
 * developer message, the same shape as Claude Code's), else `{}`.
 * SessionStart and Stop never deliver: follow-ups and idle wake-ups go
 * through `codex queue`, run by the app (X5).
 */
export function codexHookOutput(event: CodexHookEvent, text: string): unknown {
  if (!text || (event !== "user-prompt-submit" && event !== "post-tool-use")) {
    return {};
  }
  return {
    hookSpecificOutput: {
      hookEventName:
        event === "post-tool-use" ? "PostToolUse" : "UserPromptSubmit",
      additionalContext: text,
    },
  };
}

/**
 * The claimed messages' text for `additionalContext`, minus any the
 * submitted prompt already is: the app's `codex queue` delivery (X5) makes
 * a message the prompt itself, and this claim is what settles it as
 * delivered; repeating it as context would hand it to the model twice. A
 * Review command travels without its inbox header (route `user`), and
 * without the report_status reminder every delivered text may end with.
 */
export function codexContextText(
  messages: readonly { text: string; details?: { route?: string } }[],
  prompt: string,
): string {
  const body = (message: { text: string; details?: { route?: string } }) =>
    (message.details?.route === "user"
      ? message.text.replace(/^\[Message from the user\]\n\n/, "")
      : message.text
    ).replace(`\n\n${REPORT_STATUS_REMINDER}`, "");
  return messages
    .filter(
      (message) => !prompt.trim() || !prompt.includes(body(message).trim()),
    )
    .map((message) => message.text)
    .join("\n\n---\n\n");
}

/** The turn boundary a Codex hook reports (S5): none for SessionStart. */
export function codexHookTurnBoundary(
  event: CodexHookEvent,
): "stop" | "prompt" | "tool" | undefined {
  switch (event) {
    case "user-prompt-submit":
      return "prompt";
    case "post-tool-use":
      return "tool";
    case "stop":
      return "stop";
    case "session-start":
      return undefined;
  }
}

async function runCodexHook(
  flags: Map<string, string>,
  socketPath: string,
  caller: ToolCaller,
  io: CliIo,
): Promise<number> {
  const started = Date.now();
  const event = flags.get("event") as CodexHookEvent | undefined;
  if (!event || !CODEX_HOOK_EVENTS.includes(event)) {
    throw new UsageError(
      `--event must be one of ${CODEX_HOOK_EVENTS.join(", ")}`,
    );
  }
  const reply = (output: unknown) => io.stdout(`${JSON.stringify(output)}\n`);
  if (!caller.taskId) {
    // Not a Harbormaster task session: nothing to bind or deliver.
    reply({});
    return 0;
  }
  const left = () => CODEX_HOOK_DEADLINE_MS - (Date.now() - started);
  const input = parseCodexHookInput(
    await withDeadline(
      (io.readStdin ?? readProcessStdin)(),
      CODEX_HOOK_STDIN_MS,
      "",
    ),
  );
  const boundary = codexHookTurnBoundary(event);
  // Delivering events claim first (the claim is the reply); the others
  // reply `{}` at once and do their socket work afterwards, still bounded.
  let text = "";
  if (event === "user-prompt-submit" || event === "post-tool-use") {
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    const claim = callTool(
      socketPath,
      "inbox_claim",
      // PostToolUse is mid-turn: steer messages only; a submitted prompt
      // may carry any pending message along (catch-up).
      { idle: event === "user-prompt-submit" },
      caller,
    ).then((result) =>
      codexContextText(
        (result.details as InboxClaimDetails | undefined)?.messages ?? [],
        prompt,
      ),
    );
    text = await withDeadline(claim, left(), "");
  }
  reply(codexHookOutput(event, text));
  const work: Promise<unknown>[] = [];
  if (boundary) work.push(reportTurnBoundary(socketPath, caller, boundary));
  if (
    event === "session-start" &&
    typeof input.session_id === "string" &&
    typeof input.transcript_path === "string"
  ) {
    work.push(
      callOp(
        socketPath,
        "session_start",
        { sessionId: input.session_id, sessionPath: input.transcript_path },
        caller,
      ).catch(() => {
        // Best effort: the binding is learned again on the next start.
      }),
    );
  }
  await withDeadline(Promise.all(work), left(), undefined);
  return 0;
}

// --- Cursor hooks (docs/harness-additions.md C2-C5) -----------------------------

/** The `--event` names `harbormaster hook cursor` takes (`CURSOR_HOOK_EVENTS` in core's adapter). */
export type CursorHookEvent = CursorHookEventName;

const CURSOR_HOOK_EVENT_NAMES: readonly CursorHookEvent[] = [
  "session-start",
  "before-submit-prompt",
  "post-tool-use",
  "stop",
];

/**
 * The follow-up guard: a stop hook hands Cursor a `followup_message` only
 * for a turn that was not itself a follow-up (`loop_count` 0), so one
 * stop never chains into another automatically; a message arriving during
 * the follow-up turn waits for the next prompt (catch-up) or stop.
 */
export const CURSOR_MAX_FOLLOWUP_LOOP = 0;

/**
 * Cursor's hook output for one event: beforeSubmitPrompt always continues
 * (claimed messages ride along as `additional_context`, catch-up), a
 * completed stop hands claimed messages over as `followup_message`
 * (follow-up); everything else `{}`.
 */
export function cursorHookOutput(
  event: CursorHookEvent,
  text: string,
): unknown {
  if (event === "before-submit-prompt") {
    return text
      ? { continue: true, additional_context: text }
      : { continue: true };
  }
  if (event === "stop" && text) return { followup_message: text };
  return {};
}

/** Whether a stop payload may carry a follow-up (a completed, non-follow-up turn). */
export function cursorStopMayFollowUp(input: Record<string, unknown>): boolean {
  const loop = typeof input.loop_count === "number" ? input.loop_count : 0;
  const status = typeof input.status === "string" ? input.status : "completed";
  return status === "completed" && loop <= CURSOR_MAX_FOLLOWUP_LOOP;
}

/**
 * The chat's transcript path: the payload's `transcript_path` when Cursor
 * gives one (it is null until the first turn ended), else where Cursor
 * writes it for the payload's first workspace root.
 */
export function cursorHookTranscriptPath(
  input: Record<string, unknown>,
  sessionId: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (typeof input.transcript_path === "string" && input.transcript_path) {
    return input.transcript_path;
  }
  const roots = Array.isArray(input.workspace_roots)
    ? input.workspace_roots
    : [];
  const workspace = typeof roots[0] === "string" ? roots[0] : undefined;
  if (!workspace) return undefined;
  return cursorTranscriptPath(cursorDataDir(env), workspace, sessionId);
}

async function runCursorHook(
  flags: Map<string, string>,
  socketPath: string,
  caller: ToolCaller,
  io: CliIo,
): Promise<number> {
  const started = Date.now();
  const event = flags.get("event") as CursorHookEvent | undefined;
  if (!event || !CURSOR_HOOK_EVENT_NAMES.includes(event)) {
    throw new UsageError(
      `--event must be one of ${CURSOR_HOOK_EVENT_NAMES.join(", ")}`,
    );
  }
  const reply = (output: unknown) => io.stdout(`${JSON.stringify(output)}\n`);
  if (!caller.taskId) {
    // Not a Harbormaster task session: nothing to report or deliver.
    reply(cursorHookOutput(event, ""));
    return 0;
  }
  const left = () => CODEX_HOOK_DEADLINE_MS - (Date.now() - started);
  const input = parseCodexHookInput(
    await withDeadline(
      (io.readStdin ?? readProcessStdin)(),
      CODEX_HOOK_STDIN_MS,
      "",
    ),
  );
  // Delivering events claim first (the claim is the reply); the others
  // reply at once and do their socket work afterwards, still bounded.
  let text = "";
  if (
    event === "before-submit-prompt" ||
    (event === "stop" && cursorStopMayFollowUp(input))
  ) {
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    const claim = callTool(
      socketPath,
      "inbox_claim",
      { idle: true },
      caller,
    ).then((result) =>
      codexContextText(
        (result.details as InboxClaimDetails | undefined)?.messages ?? [],
        prompt,
      ),
    );
    text = await withDeadline(claim, left(), "");
  }
  reply(cursorHookOutput(event, text));
  const work: Promise<unknown>[] = [];
  const presence = cursorHookPresenceEvent(event, !!text);
  const status = typeof input.status === "string" ? input.status : undefined;
  const generation =
    typeof input.generation_id === "string" ? input.generation_id : undefined;
  work.push(
    callOp(
      socketPath,
      "hook_presence",
      {
        event: presence,
        ...(presence === "stop" && status ? { status } : {}),
        ...(generation ? { generation } : {}),
      },
      caller,
    ).catch(() => {
      // Best effort: pid liveness still ends the attachment.
    }),
  );
  const sessionId =
    typeof input.conversation_id === "string"
      ? input.conversation_id
      : typeof input.session_id === "string"
        ? input.session_id
        : undefined;
  const sessionPath = sessionId
    ? cursorHookTranscriptPath(input, sessionId, io.env)
    : undefined;
  if (sessionId && sessionPath && event !== "post-tool-use") {
    // Every turn names its chat (a resume fires no sessionStart): binding
    // is idempotent in core (tool hooks, many per turn, skip it).
    work.push(
      callOp(
        socketPath,
        "session_start",
        { sessionId, sessionPath },
        caller,
      ).catch(() => {
        // Best effort: the binding is learned again on the next hook.
      }),
    );
  }
  if (event === "stop" && sessionId && generation) {
    const usage = cursorStopUsage(input);
    if (usage) {
      work.push(
        callOp(
          socketPath,
          "turn_usage",
          { sessionId, generation, ...usage },
          caller,
        ).catch(() => {
          // Best effort: this turn's tokens go uncounted.
        }),
      );
    }
  }
  await withDeadline(Promise.all(work), left(), undefined);
  return 0;
}

async function runInboxClaim(
  flags: Map<string, string>,
  socketPath: string,
  caller: ToolCaller,
  io: CliIo,
): Promise<number> {
  const taskId = flags.get("task") ?? caller.taskId;
  if (!taskId) throw new UsageError("--task <id> is required");
  const idleFlag = flags.get("idle");
  const result = await callTool(
    socketPath,
    "inbox_claim",
    { idle: idleFlag === undefined ? true : idleFlag === "true" },
    { ...caller, taskId },
  );
  const details = result.details as InboxClaimDetails;
  io.stdout(`${JSON.stringify({ messages: details.messages })}\n`);
  return 0;
}

/** The named flags as op arguments; any other flag (except --json) is a usage error. */
function pick(
  flags: Map<string, string>,
  keys: readonly string[],
): Record<string, string> {
  const args: Record<string, string> = {};
  for (const [key, value] of flags) {
    if (key === "json") continue;
    if (!keys.includes(key)) throw new UsageError(`unknown flag --${key}`);
    args[key] = value;
  }
  return args;
}

/** Runs one user operation; `--json` prints its structured details. */
async function runOp(
  op: string,
  args: Record<string, unknown>,
  flags: Map<string, string>,
  socketPath: string,
  io: CliIo,
): Promise<number> {
  const result = await callOp(socketPath, op, args);
  io.stdout(
    flags.get("json") === "true"
      ? `${JSON.stringify(result.details ?? {}, null, 2)}\n`
      : `${result.text}\n`,
  );
  return 0;
}

/** `usage`'s flags → the `usage` op's arguments. */
const USAGE_FLAGS: Record<string, string> = {
  from: "from",
  to: "to",
  repository: "repository",
  harness: "harness",
  model: "model",
  "include-archived": "includeArchived",
};

/** `$` is an estimate and never shown bare (docs/costs.md decision 3). */
function formatCost(cost: number): string {
  return `~$${cost.toFixed(2)}`;
}

/** The totals line under `usage`'s rows: tasks, tokens, and `$` only where the harness priced it. */
export function formatUsageTotals(rows: readonly TaskUsageRow[]): string {
  let tokens = 0;
  let cost: number | undefined;
  for (const row of rows) {
    if (row.usage.status === "ready") tokens += totalTokens(row.usage.totals);
    if (row.usage.cost !== undefined) cost = (cost ?? 0) + row.usage.cost;
  }
  const parts = [
    `${rows.length} task${rows.length === 1 ? "" : "s"}`,
    `${formatTokenCount(tokens)} tokens`,
  ];
  if (cost !== undefined) {
    parts.push(`${formatCost(cost)} est. at list price (not your bill)`);
  }
  return parts.join(" · ");
}

/** One task's `TaskUsage` after `usage refresh`. */
export function formatTaskUsage(
  taskId: string,
  usage: TaskUsage | undefined,
): string {
  if (!usage) return `Task ${taskId}: no session recorded`;
  if (usage.status !== "ready") {
    return `Task ${taskId}: ${usage.status}${usage.reason ? ` (${usage.reason})` : ""}`;
  }
  const { totals } = usage;
  const lines = [
    `Task ${taskId}: ${formatTokenCount(totalTokens(totals))} tokens · ${totals.turns} turn${totals.turns === 1 ? "" : "s"}${
      usage.cost !== undefined
        ? ` · ${formatCost(usage.cost)} est. by ${usage.costSource ?? "harness"} at list price (not your bill)`
        : ""
    }`,
    `  input ${formatTokenCount(totals.input)} · output ${formatTokenCount(totals.output)} · cache read ${formatTokenCount(totals.cacheRead)} · cache write ${formatTokenCount(totals.cacheWrite)}`,
  ];
  for (const model of usage.byModel) {
    lines.push(
      `  ${model.model}  ${formatTokenCount(totalTokens(model))} tok  ${model.turns} turn${model.turns === 1 ? "" : "s"}${
        model.cost !== undefined ? `  ${formatCost(model.cost)}` : ""
      }`,
    );
  }
  return lines.join("\n");
}

/** `usage [filters] [--json]` and `usage refresh <taskId>`. */
async function runUsage(
  argv: readonly string[],
  socketPath: string,
  io: CliIo,
): Promise<number> {
  const json = (flags: Map<string, string>) => flags.get("json") === "true";
  if (argv[0] === "refresh") {
    const [, taskId, ...flagArgs] = argv;
    if (!taskId || taskId.startsWith("--")) {
      throw new UsageError("usage: usage refresh <taskId> [--json]");
    }
    const flags = parseFlags(flagArgs);
    pick(flags, []);
    const result = await callOp(socketPath, "usage_refresh", { task: taskId });
    const details = (result.details ?? {}) as { usage?: TaskUsage };
    io.stdout(
      json(flags)
        ? `${JSON.stringify(details, null, 2)}\n`
        : `${formatTaskUsage(taskId, details.usage)}\n`,
    );
    return 0;
  }
  const flags = parseFlags(argv);
  const args: Record<string, unknown> = {};
  for (const [flag, value] of Object.entries(
    pick(flags, Object.keys(USAGE_FLAGS)),
  )) {
    if (flag === "include-archived") {
      if (value !== "true" && value !== "false") {
        throw new UsageError(
          "--include-archived takes no value (or true|false)",
        );
      }
      args.includeArchived = value === "true";
    } else {
      args[USAGE_FLAGS[flag] as string] = value;
    }
  }
  const result = await callOp(socketPath, "usage", args);
  const rows = ((result.details ?? {}) as { rows?: TaskUsageRow[] }).rows ?? [];
  io.stdout(
    json(flags)
      ? `${JSON.stringify(rows, null, 2)}\n`
      : `${result.text}\n${rows.length ? `${formatUsageTotals(rows)}\n` : ""}`,
  );
  return 0;
}

/** The line `doctor` prints first when the app was not running. */
export const DOCTOR_WITHOUT_APP_NOTE =
  "Harbormaster is not running: checked without the app, so app-only facts (the app's PATH vs your login shell) are not compared.";

/** `doctor` with the app down: the same read-only command on an in-process core. */
async function inProcessDoctor(
  env: NodeJS.ProcessEnv,
  input: DoctorInput,
): Promise<DoctorReport> {
  const core = createCore({
    stateDir: env.HARBORMASTER_STATE_DIR || DEFAULT_STATE_DIR,
  });
  return core.commands.doctor(input);
}

/** `harbormaster doctor`'s human output. */
export function formatDoctorOutput(
  report: DoctorReport,
  options: { viaApp: boolean },
): string {
  const body = formatDoctorReport(report);
  return options.viaApp ? body : `${DOCTOR_WITHOUT_APP_NOTE}\n\n${body}`;
}

async function runDoctor(
  flags: Map<string, string>,
  socketPath: string,
  io: CliIo,
): Promise<number> {
  pick(flags, ["all-remotes"]);
  const allRemotes = flags.get("all-remotes");
  if (allRemotes !== undefined && allRemotes !== "true") {
    throw new UsageError("--all-remotes takes no value");
  }
  const input: DoctorInput = allRemotes ? { probeAllRemotes: true } : {};
  let report: DoctorReport;
  let viaApp = true;
  try {
    // This shell's PATH is the login-shell PATH the app's is compared with.
    const result = await callOp(socketPath, "doctor", {
      ...(io.env.PATH ? { loginShellPath: io.env.PATH } : {}),
      ...input,
    });
    report = result.details as DoctorReport;
  } catch (error) {
    if (!(error instanceof HarbormasterNotRunningError)) throw error;
    viaApp = false;
    report = await (io.localDoctor ?? inProcessDoctor)(io.env, input);
  }
  io.stdout(
    flags.get("json") === "true"
      ? `${JSON.stringify({ ...report, viaApp }, null, 2)}\n`
      : `${formatDoctorOutput(report, { viaApp })}\n`,
  );
  return doctorExitCode(report);
}

/**
 * `open-url <url>`: the agent's browser handler. The task is the launch
 * env's `HARBORMASTER_TASK_ID` (a nested session inside the task's pane
 * still opens in that task); every failure exits 1, the app being down
 * included, so the handler script's `|| open "$1"` runs.
 */
async function runOpenUrl(
  argv: readonly string[],
  socketPath: string,
  caller: ToolCaller,
  io: CliIo,
): Promise<number> {
  const [url, ...flagArgs] = argv;
  if (!url || url.startsWith("--")) {
    throw new UsageError(
      "usage: open-url <url> [--source plannotator|browser]",
    );
  }
  const flags = parseFlags(flagArgs);
  const source = pick(flags, ["source"]).source;
  if (
    source !== undefined &&
    source !== "plannotator" &&
    source !== "browser"
  ) {
    throw new UsageError("--source must be plannotator or browser");
  }
  const taskId = io.env.HARBORMASTER_TASK_ID || undefined;
  if (!taskId) {
    io.stderr("open-url: not a Harbormaster task session\n");
    return EXIT_OPEN_URL_FAILED;
  }
  try {
    const result = await callOp(
      socketPath,
      "open_url",
      { url, ...(source ? { source } : {}) },
      { ...caller, taskId },
    );
    io.stdout(`${result.text}\n`);
    return 0;
  } catch (error) {
    io.stderr(
      `${error instanceof HarbormasterNotRunningError ? NOT_RUNNING_MESSAGE : error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_OPEN_URL_FAILED;
  }
}

/** `review [--local|--pr] [--task <id>]`: `requestReview` for this task (or `--task`). */
async function runReview(
  argv: readonly string[],
  socketPath: string,
  caller: ToolCaller,
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(argv);
  const picked = pick(flags, ["local", "pr", "task"]);
  if (picked.local !== undefined && picked.pr !== undefined) {
    throw new UsageError("pick one of --local / --pr");
  }
  for (const key of ["local", "pr"] as const) {
    if (picked[key] !== undefined && picked[key] !== "true") {
      throw new UsageError(`--${key} takes no value`);
    }
  }
  const target = picked.local ? "local" : picked.pr ? "pr" : undefined;
  if (!picked.task && !caller.taskId) {
    throw new UsageError(
      "--task <id> is required outside a Harbormaster task session",
    );
  }
  const result = await callOp(
    socketPath,
    "request_review",
    {
      ...(target ? { target } : {}),
      ...(picked.task ? { task: picked.task } : {}),
    },
    caller,
  );
  io.stdout(
    flags.get("json") === "true"
      ? `${JSON.stringify(result.details ?? {}, null, 2)}\n`
      : `${result.text}\n`,
  );
  return 0;
}

/** Runs one CLI invocation; resolves the exit code. */
export async function main(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  const socketPath = socketPathFromEnv(io.env);
  const caller = callerFromEnv(io.env, io.cwd);
  try {
    if (!command || command === "--help" || command === "help") {
      io.stdout(usage());
      return command ? 0 : 1;
    }
    if (command === "mcp") {
      await (io.serveMcp ?? serveMcpOverStdio)({ socketPath, caller });
      return 0;
    }
    if (command === "hook") {
      const [kind, ...flagArgs] = rest;
      if (kind === "codex") {
        return await runCodexHook(parseFlags(flagArgs), socketPath, caller, io);
      }
      if (kind === "cursor") {
        return await runCursorHook(
          parseFlags(flagArgs),
          socketPath,
          caller,
          io,
        );
      }
      if (kind !== "inbox")
        throw new UsageError(
          "usage: hook inbox --mode <mode> | hook codex --event <event> | hook cursor --event <event>",
        );
      return await runHook(parseFlags(flagArgs), socketPath, caller, io);
    }
    if (command === "inbox") {
      const [verb, ...flagArgs] = rest;
      if (verb === "claim") {
        return await runInboxClaim(
          parseFlags(flagArgs),
          socketPath,
          caller,
          io,
        );
      }
      if (verb === "list") {
        const flags = parseFlags(flagArgs);
        if (flags.has("priority") && flags.has("other")) {
          throw new UsageError("pick one of --priority / --other");
        }
        const tab = flags.has("priority")
          ? "priority"
          : flags.has("other")
            ? "other"
            : undefined;
        return await runOp(
          "inbox_list",
          tab ? { tab } : {},
          flags,
          socketPath,
          io,
        );
      }
      if (verb === "resolve") {
        const [id, button, ...extra] = flagArgs;
        if (!id || id.startsWith("--") || extra.length > 0) {
          throw new UsageError("usage: inbox resolve <id> [<button>]");
        }
        return await runOp(
          "inbox_resolve",
          { id, ...(button ? { button } : {}) },
          new Map(),
          socketPath,
          io,
        );
      }
      throw new UsageError(
        "usage: inbox claim|list|resolve (see harbormaster --help)",
      );
    }
    if (command === "events") {
      const flags = parseFlags(rest);
      return await runOp(
        "events",
        pick(flags, ["task", "rule", "file", "since", "limit"]),
        flags,
        socketPath,
        io,
      );
    }
    if (command === "rules") {
      const [verb, ...flagArgs] = rest;
      const flags = parseFlags(flagArgs);
      if (verb === "list") {
        return await runOp("rules_list", {}, flags, socketPath, io);
      }
      if (verb === "on" || verb === "off") {
        pick(flags, []);
        return await runOp(
          "rules_enable",
          { enabled: verb === "on" },
          flags,
          socketPath,
          io,
        );
      }
      if (verb === "check") {
        return await runOp(
          "rules_check",
          pick(flags, ["task", "replay"]),
          flags,
          socketPath,
          io,
        );
      }
      throw new UsageError(
        "usage: rules list | rules on | rules off | rules check",
      );
    }
    if (command === "doctor") {
      return await runDoctor(parseFlags(rest), socketPath, io);
    }
    if (command === "open-url") {
      return await runOpenUrl(rest, socketPath, caller, io);
    }
    if (command === "review") {
      return await runReview(rest, socketPath, caller, io);
    }
    if (command === "usage") {
      return await runUsage(rest, socketPath, io);
    }
    if (command === "addons") {
      const [verb, ...flagArgs] = rest;
      if (verb !== "list") throw new UsageError("usage: addons list");
      return await runOp(
        "addons_list",
        {},
        parseFlags(flagArgs),
        socketPath,
        io,
      );
    }
    const tool = findTool(command);
    if (!tool) throw new UsageError(`unknown command "${command}"`);
    const flags = parseFlags(rest);
    const result = await callTool(
      socketPath,
      tool.name,
      toolArgsFromFlags(tool, flags),
      caller,
    );
    io.stdout(
      flags.get("details") === "true"
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${result.text}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof HarbormasterNotRunningError) {
      io.stderr(`${NOT_RUNNING_MESSAGE}\n`);
      return EXIT_NOT_RUNNING;
    }
    if (error instanceof UsageError) {
      io.stderr(`harbormaster: ${error.message}\n\n${usage()}`);
      return 64;
    }
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** Process entry point (`bin/harbormaster.js`). */
export function run(): void {
  void main(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }).then((code) => {
    process.exitCode = code;
    // A Codex hook blocks Codex's TUI until it exits (X2): never linger on
    // a socket the deadline already gave up on.
    if (
      process.argv[2] === "hook" &&
      (process.argv[3] === "codex" || process.argv[3] === "cursor")
    ) {
      process.stdout.write("", () => process.exit(code));
    }
  });
}
