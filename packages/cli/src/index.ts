// The `harbormaster` CLI (decision #18, docs/release-plan.md "Tools: one
// catalog, two faces"): a thin client of the running app's local socket.
// It never touches state files and never hand-rolls a subset of the tool
// catalog: every catalog entry is a verb here and a tool in `harbormaster
// mcp`. With the app down, every command prints "Harbormaster is not
// running" and exits 2.
//
//   harbormaster mcp                                  MCP stdio server
//   harbormaster <tool> [--json '<args>'] [--<arg> <value>...] [--details]
//   harbormaster hook inbox --mode steer|follow-up|catch-up
//   harbormaster inbox claim --task <id> [--idle true|false]
//   harbormaster inbox list [--priority|--other] [--json]
//   harbormaster inbox resolve <id> [<button>]
//   harbormaster events [--task <id>] [--since <time>] [--limit <n>] [--json]
//   harbormaster rules list | rules check [--task <id>] [--replay <from>]
//   harbormaster addons list
//
// The inbox / events / rules / addons verbs are the core's user operations
// (`OPS_CATALOG`, tools/ops.ts) over the same socket, never hand-rolled here.

import {
  callerFromEnv,
  callOp,
  callTool,
  findTool,
  HarbormasterNotRunningError,
  type InboxClaimDetails,
  NOT_RUNNING_MESSAGE,
  socketPathFromEnv,
  TOOL_CATALOG,
  type ToolCaller,
  type ToolDefinition,
} from "@harbormaster/core";
import { serveMcpOverStdio } from "./mcp.js";

export { createMcpServer } from "./mcp.js";

/** Exit code when the app is not running. */
export const EXIT_NOT_RUNNING = 2;

export interface CliIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Starts the MCP stdio server (injectable so tests never grab real stdio). */
  serveMcp?: typeof serveMcpOverStdio;
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
    "  inbox claim --task <id> [--idle true|false]  Claim a task's inbox messages as JSON",
    "  inbox list [--priority|--other] [--json]  Items that need you (rule items, approvals)",
    "  inbox resolve <id> [<button>]             Press an item's button (default: dismiss)",
    "  events [--task <id>] [--since <t>] [--limit <n>] [--json]  The rules audit log",
    "  rules list [--json]                       Rules files as loaded, with problems",
    "  rules check [--task <id>] [--replay <from>] [--json]  Dry run over recorded events",
    "  addons list [--json]                      Built-in sources and installed addons",
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
  io.stdout(`${JSON.stringify(inboxHookOutput(mode, text))}\n`);
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
      if (kind !== "inbox")
        throw new UsageError("usage: hook inbox --mode <mode>");
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
        pick(flags, ["task", "since", "limit"]),
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
      if (verb === "check") {
        return await runOp(
          "rules_check",
          pick(flags, ["task", "replay"]),
          flags,
          socketPath,
          io,
        );
      }
      throw new UsageError("usage: rules list | rules check");
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
  });
}
