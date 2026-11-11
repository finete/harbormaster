// The agent tool catalog (decision #18, docs/release-plan.md "Tools: one
// catalog, two faces"): every tool an agent session can call, defined ONCE.
// Two thin clients expose it without hand-rolling a subset: `harbormaster
// mcp` (an MCP stdio server) and the `harbormaster <tool>` CLI, both
// forwarding over the app's local socket (see `transport/`), where
// `dispatchToolCall` runs the handler against the command API.
//
// Caller identity (which task is calling) is NEVER a tool argument: it comes
// from the calling process's environment (`HARBORMASTER_TASK_ID`,
// `HARBORMASTER_SESSION_ID`, set by the harness adapter's launch spec) and
// travels as `ToolCaller` next to the arguments.

import type { CoreCommands, LaunchTaskInput } from "../contracts/commands.js";
import {
  buildChildStatusEntry,
  formatChildStatusText,
} from "./child-status.js";
import {
  type FormattedInboxMessage,
  formatInboxMessage,
} from "./inbox-format.js";
import {
  buildLaunchResultText,
  launchRepositoryLabel,
  resolveLaunchRepository,
} from "./launch-repository.js";
import {
  deriveMessageSender,
  formatTaskSearchText,
  resolveAttachmentPaths,
} from "./task-search.js";

/** Who is calling, from the calling process's environment (never from tool arguments). */
export interface ToolCaller {
  /** The task whose session is calling; absent for a plain (non-task) session. */
  taskId?: string;
  /** The harness session id the launch spec assigned. */
  sessionId?: string;
  /** The caller's working directory (relative attachment paths resolve against it). */
  cwd?: string;
}

/** A JSON Schema object describing a tool's arguments. */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** What a tool call hands back: agent-facing text plus structured details. */
export interface ToolResult {
  text: string;
  details?: unknown;
}

export interface ToolContext {
  commands: CoreCommands;
  caller: ToolCaller;
}

export interface ToolDefinition {
  /** Stable snake_case name (MCP tool name and CLI subcommand). */
  name: string;
  /** Short human title. */
  title: string;
  description: string;
  inputSchema: ToolInputSchema;
  handler(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult>;
}

/** What `inbox_claim` returns in `details`. */
export interface InboxClaimDetails {
  messages: FormattedInboxMessage[];
}

// --- argument readers -------------------------------------------------------

function readString(
  args: Record<string, unknown>,
  key: string,
  required: true,
): string;
function readString(
  args: Record<string, unknown>,
  key: string,
  required?: false,
): string | undefined;
function readString(
  args: Record<string, unknown>,
  key: string,
  required = false,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function readEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  required: boolean,
): T | undefined {
  const value = required ? readString(args, key, true) : readString(args, key);
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    throw new Error(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function readBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function readStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value as string[];
}

function requireTaskCaller(caller: ToolCaller, tool: string): string {
  if (!caller.taskId) {
    throw new Error(
      `${tool} is only available inside a Harbormaster task session.`,
    );
  }
  return caller.taskId;
}

// --- the catalog -----------------------------------------------------------

const reportStatus: ToolDefinition = {
  name: "report_status",
  title: "Harbormaster report status",
  description:
    "Report the terminal outcome of this Harbormaster task run. Call this as your FINAL action when working autonomously: status 'done' with a one-line summary of what was delivered, or 'blocked' with the concrete blocker. The session stays open after this call (it is not ended): the user sees your task as 'your move'. Only valid inside a session linked to a Harbormaster task.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["done", "blocked"],
        description:
          "done = objective delivered; blocked = cannot proceed without help",
      },
      note: {
        type: "string",
        description:
          "One-line summary (done) or the concrete blocker (blocked)",
      },
    },
    required: ["status"],
    additionalProperties: false,
  },
  async handler(args, { commands, caller }) {
    const taskId = requireTaskCaller(caller, "report_status");
    const status = readEnum(args, "status", ["done", "blocked"] as const, true);
    if (!status) throw new Error("status is required");
    const note = readString(args, "note")?.trim() || undefined;
    await commands.reportTaskOutcome(taskId, {
      status,
      ...(note ? { note } : {}),
    });
    return { text: `Recorded ${status}${note ? `: ${note}` : ""}` };
  },
};

const launchTask: ToolDefinition = {
  name: "launch_task",
  title: "Harbormaster launch task",
  description:
    'Launch a new Harbormaster task that starts running immediately in the background, in its own git worktree/branch and its own session, never in this one. `relation` is REQUIRED with no default; choose explicitly every time: "child" ONLY when the work is part of / depends on the current task (nested under it on the board; poll it with subtask_status); "standalone" for an independent fix, a different repository, or an unrelated follow-up that parts ways from this one. A "child" requires calling this from a Harbormaster task session. The launch is QUEUED: it starts in the background once the Harbormaster app picks it up, so never assume the work has begun. Call this tool once per task; call it again (with a fresh prompt) to launch several.',
  inputSchema: {
    type: "object",
    properties: {
      relation: {
        type: "string",
        enum: ["child", "standalone"],
        description:
          'No default: "child" only when the work is part of / depends on the current task; "standalone" for independent fixes, other repositories, or unrelated follow-ups.',
      },
      title: { type: "string", description: "Short task title for the board." },
      prompt: {
        type: "string",
        description:
          "Self-sufficient instructions for the launched agent: it starts a fresh session with no other context than this prompt (and, for a child, the launching task's title/id).",
      },
      repository: {
        type: "string",
        description:
          '"none" for no repository (a scratch task), a discovered repository id (e.g. "github.com/org/repo") or its unique short name, a registered folder\'s name or absolute path (a git folder gets a worktree, a plain folder runs in place), or a git clone URL to clone a new one.',
      },
      baseBranch: {
        type: "string",
        enum: ["default", "parent"],
        description:
          '"parent" (stacked work, off the parent\'s branch) is only valid for a "child" launched in the SAME repository as its parent, once the parent has a branch; never for "standalone". Omit or use "default" to branch off the repository\'s default branch.',
      },
      model: {
        type: "string",
        description:
          "Provider/model override for this task's first session; falls back to the configured default, then the harness default.",
      },
    },
    required: ["relation", "title", "prompt", "repository"],
    additionalProperties: false,
  },
  async handler(args, { commands, caller }) {
    const relation = readEnum(
      args,
      "relation",
      ["child", "standalone"] as const,
      true,
    );
    if (!relation) throw new Error("relation is required");
    const title = readString(args, "title", true);
    const prompt = readString(args, "prompt", true);
    const repositoryArg = readString(args, "repository", true);
    const baseBranch = readEnum(
      args,
      "baseBranch",
      ["default", "parent"] as const,
      false,
    );
    const model = readString(args, "model")?.trim() || undefined;
    const fromTaskId = caller.taskId;
    if (relation === "child" && !fromTaskId) {
      throw new Error(
        "child requires launching from a Harbormaster task session",
      );
    }
    const [repositories, locations] = await Promise.all([
      commands.listRepositories(),
      commands.listLocations(),
    ]);
    const repository = resolveLaunchRepository(
      repositoryArg,
      repositories,
      locations,
    );
    const input: LaunchTaskInput = {
      relation,
      ...(fromTaskId ? { fromTaskId } : {}),
      title,
      prompt,
      repository,
      ...(baseBranch ? { baseBranch } : {}),
      ...(model ? { model } : {}),
    };
    const task = await commands.launchTask(input);
    return {
      text: buildLaunchResultText({
        title: task.title,
        id: task.id,
        relation,
        repositoryLabel: launchRepositoryLabel(repository),
      }),
      details: { task },
    };
  },
};

const subtaskStatus: ToolDefinition = {
  name: "subtask_status",
  title: "Harbormaster subtask status",
  description:
    'List this task\'s child tasks (launched with relation "child"): title, id, board column (plus the awaiting reason), PR info when opened, run state (queued / interrupted / working / your move / not running), and the reported outcome. Only valid inside a Harbormaster task session.',
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handler(_args, { commands, caller }) {
    const taskId = requireTaskCaller(caller, "subtask_status");
    const children = await commands.listChildren(taskId);
    const entries = await Promise.all(
      children.map(async (child) =>
        buildChildStatusEntry(child, await commands.getPresence(child.id)),
      ),
    );
    return {
      text: formatChildStatusText(entries),
      details: { children: entries },
    };
  },
};

const findTasks: ToolDefinition = {
  name: "find_tasks",
  title: "Harbormaster find tasks",
  description:
    "Find Harbormaster tasks by plain words (title, repository, branch, PR number like #412, or id prefix; every word must match). Use it to resolve a task the user names to its exact id before send_to_task. Each match shows id, title, board column, run state, relation to this task (self / parent / child / sibling / unrelated) and repository/branch/PR when present. Finished (Done) tasks are left out unless includeDone is true.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Plain words to match, e.g. a title fragment or PR number.",
      },
      includeDone: {
        type: "boolean",
        description: "Also search Done tasks (default false).",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async handler(args, { commands, caller }) {
    const query = readString(args, "query", true);
    const includeDone = readBoolean(args, "includeDone");
    const results = await commands.findTasks(query, {
      ...(caller.taskId ? { fromTaskId: caller.taskId } : {}),
      ...(includeDone ? { includeDone: true } : {}),
    });
    return { text: formatTaskSearchText(results, query), details: { results } };
  },
};

const sendToTask: ToolDefinition = {
  name: "send_to_task",
  title: "Harbormaster send to task",
  description:
    'Send a message to another Harbormaster task\'s agent. taskId must be an EXACT task id (use find_tasks first; never guess). Messages to your own children or to your parent are delivered directly. ANY other target (sibling, unrelated task, or any send from a plain non-task session) goes to the user\'s approval in the Harbormaster app, so send those ONLY when the user explicitly asked you to. mode: "steer" lands after the target\'s current step (use for corrections); "followUp" lands after the target finishes its current work (the default for questions to your parent). After asking your parent a question, end your turn and wait for the reply; do not poll. attachments are file paths (e.g. pasted screenshots) that are copied and, for images, shown to the target; everything else is text only.',
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description:
          "Exact id of the target task (from find_tasks, launch_task or subtask_status).",
      },
      message: { type: "string", description: "The message text." },
      mode: {
        type: "string",
        enum: ["steer", "followUp"],
        description:
          "steer = after the target's current step (corrections); followUp = after it finishes its current work. Default: steer to a child, followUp to a parent.",
      },
      attachments: {
        type: "array",
        items: { type: "string" },
        description:
          "File paths to attach (relative paths resolve against the current directory).",
      },
    },
    required: ["taskId", "message"],
    additionalProperties: false,
  },
  async handler(args, { commands, caller }) {
    const targetTaskId = readString(args, "taskId", true);
    const text = readString(args, "message", true);
    const mode = readEnum(args, "mode", ["steer", "followUp"] as const, false);
    const cwd = caller.cwd ?? process.cwd();
    const attachments = resolveAttachmentPaths(
      readStringArray(args, "attachments"),
      cwd,
    );
    const result = await commands.sendTaskMessage({
      from: deriveMessageSender({
        sessionIsTask: !!caller.taskId,
        taskId: caller.taskId,
        cwd,
        ...(caller.sessionId ? { sessionId: caller.sessionId } : {}),
      }),
      targetTaskId,
      text,
      ...(mode ? { mode } : {}),
      ...(attachments ? { attachments } : {}),
    });
    return {
      text: result.note,
      details: {
        messageId: result.message.id,
        route: result.message.route,
        status: result.message.status,
        willWake: result.willWake,
      },
    };
  },
};

const inboxClaim: ToolDefinition = {
  name: "inbox_claim",
  title: "Harbormaster inbox claim",
  description:
    "Claim this task's pending inbox messages (messages other tasks sent to it), formatted for delivery. Used by the agent's inbox glue (the Pi extension, the Claude Code hooks); agents normally never need to call it. idle=false claims only messages meant to land mid-turn (steer); idle=true (default) claims everything deliverable. Only valid inside a Harbormaster task session.",
  inputSchema: {
    type: "object",
    properties: {
      idle: {
        type: "boolean",
        description:
          "Whether the session is idle (default true): followUps are only claimed when idle.",
      },
    },
    additionalProperties: false,
  },
  async handler(args, { commands, caller }) {
    const taskId = requireTaskCaller(caller, "inbox_claim");
    const idle = readBoolean(args, "idle") ?? true;
    const claimed = await commands.claimInboxMessages(taskId, { idle });
    const messages = await Promise.all(
      claimed.map((message) =>
        formatInboxMessage(message, (messageId, index) =>
          commands.readMessageAttachment(messageId, index),
        ),
      ),
    );
    const details: InboxClaimDetails = { messages };
    return {
      text: messages.map((message) => message.text).join("\n\n---\n\n"),
      details,
    };
  },
};

/** Every tool, in display order. The MCP server and the CLI enumerate exactly this. */
export const TOOL_CATALOG: readonly ToolDefinition[] = [
  reportStatus,
  launchTask,
  subtaskStatus,
  findTasks,
  sendToTask,
  inboxClaim,
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOL_CATALOG.find((tool) => tool.name === name);
}

/** Runs one catalog call against the command API; rejects with an agent-actionable message. */
export async function dispatchToolCall(
  commands: CoreCommands,
  name: string,
  args: unknown,
  caller: ToolCaller,
): Promise<ToolResult> {
  const tool = findTool(name);
  if (!tool) {
    throw new Error(
      `Unknown tool "${name}". Available: ${TOOL_CATALOG.map((t) => t.name).join(", ")}`,
    );
  }
  const record =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  return tool.handler(record, { commands, caller });
}
