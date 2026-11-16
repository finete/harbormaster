// The user-facing operations catalog (docs/release-plan.md "Inbox", "Audit
// log"): the inbox, the rules audit log, `rules check`, and the rule/addon
// listings, defined ONCE next to the agent tool catalog and dispatched over
// the same local socket (`method: "op"`). The `harbormaster` CLI is a thin
// client (`harbormaster inbox list`, `events`, `rules check`, ...); unlike
// the agent catalog these are never exposed as MCP tools: they act for the
// human (resolving inbox items, approving messages), not for an agent.
// Every op maps 1:1 onto core commands; nothing here owns logic beyond
// shaping arguments and formatting text.

import type { CoreCommands } from "../contracts/commands.js";
import type { InboxItem, InboxPriorityInput } from "../contracts/inbox.js";
import type { TaskMessage } from "../contracts/messaging.js";
import type { Task } from "../contracts/model.js";
import type { AuditEntry, RulesListing } from "../contracts/rules.js";
import type { TaskUsageQuery, TaskUsageRow } from "../contracts/usage.js";
import { formatDoctorReport } from "../engines/doctor.js";
import { totalTokens } from "../engines/usage.js";
import { formatTokenCount } from "../utilities/format-token-count.js";
import type { ToolCaller, ToolInputSchema, ToolResult } from "./catalog.js";

export interface OpDefinition {
  /** Stable snake_case name (`inbox_list`); the CLI maps its verbs onto it. */
  name: string;
  title: string;
  inputSchema: ToolInputSchema;
  handler(
    args: Record<string, unknown>,
    commands: CoreCommands,
    /** The calling session (from its launch env); task-scoped ops read `taskId` here, never from `args`. */
    caller: ToolCaller,
  ): Promise<ToolResult>;
}

/** The id prefix a message approval carries in the inbox (app and CLI). */
export const APPROVAL_ITEM_PREFIX = "approval:";

/** One inbox entry as `inbox_list` returns it (persisted rule items + approvals). */
export interface OpsInboxEntry {
  id: string;
  kind: string;
  source?: string;
  title: string;
  body?: string;
  taskId?: string;
  taskTitle?: string;
  createdAt: string;
  priority: boolean;
  /** Button ids/labels `inbox_resolve` accepts. */
  buttons: Array<{ id: string; label: string }>;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function int(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

async function taskIndex(commands: CoreCommands): Promise<Map<string, Task>> {
  const columns = await commands.listBoard();
  return new Map(
    columns.flatMap((column) =>
      column.groups.flatMap((group) =>
        group.tasks.map((task) => [task.id, task] as const),
      ),
    ),
  );
}

/** Persisted items plus message approvals, with priority applied (newest first). */
export async function listOpsInbox(
  commands: CoreCommands,
): Promise<OpsInboxEntry[]> {
  const [items, approvals, tasks] = await Promise.all([
    commands.listInbox(),
    commands.listPendingApprovals().catch((): TaskMessage[] => []),
    taskIndex(commands),
  ]);
  const entries: OpsInboxEntry[] = [
    ...items.map((item: InboxItem): OpsInboxEntry => {
      const task = item.taskId ? tasks.get(item.taskId) : undefined;
      return {
        id: item.id,
        kind: item.kind,
        ...(item.source ? { source: item.source } : {}),
        title: item.title,
        ...(item.body ? { body: item.body } : {}),
        ...(item.taskId ? { taskId: item.taskId } : {}),
        ...(task ? { taskTitle: task.title } : {}),
        createdAt: item.createdAt,
        priority: item.priority !== false,
        buttons: item.buttons.map((button) => ({
          id: button.id,
          label: button.label,
        })),
      };
    }),
    ...approvals.map((message): OpsInboxEntry => {
      const task = tasks.get(message.targetTaskId);
      return {
        id: `${APPROVAL_ITEM_PREFIX}${message.id}`,
        kind: "approval",
        source: "harbormaster",
        title: `${message.senderLabel} → ${task?.title ?? message.targetTaskId}`,
        body: message.text,
        taskId: message.targetTaskId,
        ...(task ? { taskTitle: task.title } : {}),
        createdAt: message.createdAt,
        priority: true,
        buttons: [
          { id: "approve", label: "Approve" },
          { id: "reject", label: "Reject" },
        ],
      };
    }),
  ];
  const inputs: InboxPriorityInput[] = entries.map((entry) => {
    const repo = entry.taskId
      ? tasks.get(entry.taskId)?.repositoryId
      : undefined;
    return {
      id: entry.id,
      kind: entry.kind,
      ...(entry.source ? { source: entry.source } : {}),
      ...(entry.taskId ? { taskId: entry.taskId } : {}),
      ...(repo ? { repo } : {}),
      priority: entry.priority,
    };
  });
  const priorities = await commands.evaluateInboxPriority(inputs);
  return entries
    .map((entry, index) => ({
      ...entry,
      priority: priorities[index] ?? entry.priority,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function formatInboxText(entries: readonly OpsInboxEntry[]): string {
  if (entries.length === 0) return "Inbox is empty.";
  return entries
    .map((entry) => {
      const head = `${entry.priority ? "!" : " "} ${entry.id}  ${entry.title}`;
      const context = entry.taskTitle ? `    task: ${entry.taskTitle}` : "";
      const buttons = entry.buttons.length
        ? `    buttons: ${entry.buttons.map((b) => `${b.id} (${b.label})`).join(", ")}`
        : "";
      return [head, context, buttons].filter(Boolean).join("\n");
    })
    .join("\n");
}

/** One audit entry as a single line (`harbormaster events`). */
export function formatAuditLine(entry: AuditEntry): string {
  const task = entry.taskId ? ` task/${entry.taskId}` : "";
  switch (entry.kind) {
    case "event":
      return `${entry.at} event ${entry.event.type}${task}`;
    case "action": {
      const input = entry.with ? ` ${JSON.stringify(entry.with)}` : "";
      const detail = entry.detail ? ` (${entry.detail})` : "";
      const from = entry.from
        ? ` from ${entry.from.state}${entry.from.awaitingKind ? `:${entry.from.awaitingKind}` : ""}`
        : "";
      const label = entry.ruleLabel ? ` [${entry.ruleLabel}]` : "";
      return `${entry.at} ${entry.outcome} ${entry.action}${input}${from}${task} because ${entry.eventType} matched rule ${entry.ruleId}${label} (${entry.file}:${entry.line})${detail}`;
    }
    case "warning": {
      const where = entry.ruleId
        ? ` [rule ${entry.ruleId}${entry.file ? ` ${entry.file}:${entry.line ?? "?"}` : ""}]`
        : "";
      return `${entry.at} warning${task}${where}: ${entry.message}`;
    }
  }
}

const inboxList: OpDefinition = {
  name: "inbox_list",
  title: "List inbox items (rule items + message approvals)",
  inputSchema: {
    type: "object",
    properties: {
      tab: { type: "string", enum: ["priority", "other"] },
    },
    additionalProperties: false,
  },
  async handler(args, commands) {
    const tab = str(args, "tab");
    if (tab && tab !== "priority" && tab !== "other") {
      throw new Error("tab must be priority or other");
    }
    const entries = (await listOpsInbox(commands)).filter(
      (entry) =>
        !tab || (tab === "priority" ? entry.priority : !entry.priority),
    );
    return { text: formatInboxText(entries), details: { items: entries } };
  },
};

const inboxResolve: OpDefinition = {
  name: "inbox_resolve",
  title: "Resolve an inbox item by pressing one of its buttons",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      button: { type: "string" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  async handler(args, commands) {
    const id = str(args, "id");
    if (!id) throw new Error("id is required");
    const pressed = str(args, "button")?.trim();
    if (id.startsWith(APPROVAL_ITEM_PREFIX)) {
      const messageId = id.slice(APPROVAL_ITEM_PREFIX.length);
      const verb = pressed?.toLowerCase();
      if (verb === "approve") {
        const message = await commands.approveMessage(messageId);
        return { text: `Approved (${message.status})`, details: { message } };
      }
      if (verb === "reject") {
        const message = await commands.rejectMessage(messageId);
        return { text: "Rejected", details: { message } };
      }
      throw new Error("an approval resolves with approve or reject");
    }
    const item = (
      await commands.listInbox({ includeSnoozed: true, includeResolved: true })
    ).find((candidate) => candidate.id === id);
    if (!item) throw new Error(`Inbox item not found: ${id}`);
    const button = pressed
      ? item.buttons.find(
          (candidate) =>
            candidate.id === pressed ||
            candidate.label.toLowerCase() === pressed.toLowerCase(),
        )
      : undefined;
    if (pressed && !button && pressed.toLowerCase() !== "dismiss") {
      throw new Error(
        `Inbox item ${id} has no button "${pressed}" (buttons: ${item.buttons.map((b) => `${b.id} ${b.label}`).join(", ") || "none"}; or dismiss)`,
      );
    }
    const result = await commands.resolveInboxItem(
      id,
      button ? { buttonId: button.id } : {},
    );
    const what = button ? button.label : "Dismissed";
    return {
      text: result.taskId ? `${what}: task ${result.taskId}` : what,
      details: result,
    };
  },
};

const events: OpDefinition = {
  name: "events",
  title: "The rules audit log (events and rule actions)",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string" },
      rule: { type: "string" },
      file: { type: "string" },
      since: { type: "string" },
      limit: { type: "string" },
    },
    additionalProperties: false,
  },
  async handler(args, commands) {
    const taskId = str(args, "task");
    const ruleId = str(args, "rule");
    const file = str(args, "file");
    const since = str(args, "since");
    const limit = int(args, "limit");
    const entries = await commands.listEvents({
      ...(taskId ? { taskId } : {}),
      ...(ruleId ? { ruleId } : {}),
      ...(file ? { file } : {}),
      ...(since ? { since } : {}),
      ...(limit ? { limit } : {}),
    });
    return {
      text: entries.length
        ? entries.map(formatAuditLine).join("\n")
        : "No events recorded.",
      details: { entries },
    };
  },
};

/** `rules list` text: on/off, then per file each rule's label, filter and last activity. */
export function formatRulesListing(listing: RulesListing): string {
  const head = `Rules are ${listing.enabled ? "on" : "off"}${listing.enabled ? "" : " (loaded but never run)"}; activity over the last ${listing.activityWindowDays} days.`;
  const files = listing.files.map((file) => {
    const scope = file.repositoryId ? ` (${file.repositoryId})` : "";
    const rules = file.rules.map((rule) => {
      const last = rule.activity
        ? `last ${rule.activity.lastOutcome} ${rule.activity.lastAt}${rule.activity.lastTaskId ? ` task/${rule.activity.lastTaskId}` : ""}${rule.activity.lastDetail ? ` (${rule.activity.lastDetail})` : ""}; ${rule.activity.count} action${rule.activity.count === 1 ? "" : "s"}`
        : "never fired";
      return `  ${rule.label}  [${rule.id}, line ${rule.line}]  on ${rule.on.join(", ")}\n    ${last}`;
    });
    const problems = file.problems.map((problem) => `  ! ${problem}`);
    return [`${file.file}${scope}  ${file.path}`, ...rules, ...problems].join(
      "\n",
    );
  });
  return [head, ...(files.length ? files : ["No rules files."])].join("\n");
}

const rulesList: OpDefinition = {
  name: "rules_list",
  title:
    "Every rules file as loaded, with its problems and each rule's last activity",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handler(_args, commands) {
    const listing = await commands.listRules();
    return { text: formatRulesListing(listing), details: listing };
  },
};

const rulesEnable: OpDefinition = {
  name: "rules_enable",
  title: "Turn the rules on or off (config.automation)",
  inputSchema: {
    type: "object",
    properties: { enabled: { type: "boolean" } },
    required: ["enabled"],
    additionalProperties: false,
  },
  async handler(args, commands) {
    const value = args.enabled;
    const enabled =
      value === true || value === "true"
        ? true
        : value === false || value === "false"
          ? false
          : undefined;
    if (enabled === undefined) throw new Error("enabled must be true or false");
    await commands.setRulesEnabled(enabled);
    return {
      text: enabled ? "Rules are on." : "Rules are off.",
      details: { enabled },
    };
  },
};

const rulesCheck: OpDefinition = {
  name: "rules_check",
  title: "Dry run: what the current rules would do over recorded events",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string" },
      replay: { type: "string" },
    },
    additionalProperties: false,
  },
  async handler(args, commands) {
    const taskId = str(args, "task");
    const replayFrom = str(args, "replay");
    const result = await commands.rulesCheck({
      ...(taskId ? { taskId } : {}),
      ...(replayFrom ? { replayFrom } : {}),
    });
    const lines = result.plans.map(
      (plan) =>
        `${plan.eventTime} ${plan.outcome} ${plan.action}${plan.with ? ` ${JSON.stringify(plan.with)}` : ""}${plan.taskId ? ` task/${plan.taskId}` : ""} because ${plan.eventType} matched rule ${plan.ruleId} (${plan.file}:${plan.line})${plan.detail ? ` (${plan.detail})` : ""}`,
    );
    const warnings = result.warnings.map((warning) => `! ${warning}`);
    return {
      text: [
        `Replayed ${result.events} event${result.events === 1 ? "" : "s"}; ${result.plans.length} action${result.plans.length === 1 ? "" : "s"} would run.`,
        ...lines,
        ...warnings,
      ].join("\n"),
      details: result,
    };
  },
};

const addonsList: OpDefinition = {
  name: "addons_list",
  title: "Built-in sources and installed addons",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handler(_args, commands) {
    const addons = await commands.listAddons();
    const text = addons
      .map((addon) => {
        const flags = [
          addon.builtin ? "built-in" : undefined,
          addon.loaded ? undefined : "skipped",
        ]
          .filter(Boolean)
          .join(", ");
        const sources = addon.sources.map((source) => source.id).join(", ");
        const problems = addon.problems.map((problem) => `  ! ${problem}`);
        return [
          `${addon.name} ${addon.version}${flags ? ` (${flags})` : ""}${sources ? `  sources: ${sources}` : ""}`,
          ...problems,
        ].join("\n");
      })
      .join("\n");
    return { text: text || "No addons.", details: { addons } };
  },
};

/** The calling task, or a clear error when the caller is not a task session. */
function callerTask(caller: ToolCaller, op: string): string {
  if (!caller.taskId) {
    throw new Error(
      `${op} must run inside a Harbormaster task session (HARBORMASTER_TASK_ID is not set)`,
    );
  }
  return caller.taskId;
}

const openUrl: OpDefinition = {
  name: "open_url",
  title:
    "Open a loopback URL in the calling task's Harbormaster tab (the agent's browser handler)",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
      source: { type: "string", enum: ["plannotator", "browser"] },
    },
    required: ["url"],
    additionalProperties: false,
  },
  async handler(args, commands, caller) {
    const url = str(args, "url");
    if (!url) throw new Error("url is required");
    const source = str(args, "source");
    if (source && source !== "plannotator" && source !== "browser") {
      throw new Error("source must be plannotator or browser");
    }
    const taskId = callerTask(caller, "open_url");
    await commands.openTaskUrl({
      taskId,
      url,
      ...(source ? { source: source as "plannotator" | "browser" } : {}),
    });
    return { text: `Opened ${url} in Harbormaster`, details: { taskId, url } };
  },
};

const requestReview: OpDefinition = {
  name: "request_review",
  title:
    "Start a Plannotator code review in the calling task's session (default: its PR, else local changes)",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", enum: ["local", "pr"] },
      task: { type: "string" },
    },
    additionalProperties: false,
  },
  async handler(args, commands, caller) {
    const target = str(args, "target");
    if (target && target !== "local" && target !== "pr") {
      throw new Error("target must be local or pr");
    }
    const taskId = str(args, "task") ?? callerTask(caller, "request_review");
    const result = await commands.requestReview({
      taskId,
      ...(target ? { target: target as "local" | "pr" } : {}),
    });
    return {
      text: `Sent ${JSON.stringify(result.command)} to task ${taskId}`,
      details: { taskId, ...result },
    };
  },
};

/** One `usage` row as a text line: tokens, `~$` (estimate, labelled), status, task. */
export function formatUsageLine(row: TaskUsageRow): string {
  const { usage } = row;
  const tokens =
    usage.status === "ready"
      ? `${formatTokenCount(totalTokens(usage.totals))} tok`
      : usage.status === "pending"
        ? "pending"
        : `unavailable${usage.reason ? ` (${usage.reason})` : ""}`;
  const cost =
    usage.cost !== undefined
      ? `  ~$${usage.cost.toFixed(2)} est. by ${usage.costSource ?? "harness"}`
      : "";
  const subtasks = row.subtaskUsage
    ? `  incl. ${row.subtaskUsage.count} subtask${row.subtaskUsage.count === 1 ? "" : "s"} (${formatTokenCount(totalTokens(row.subtaskUsage))} tok)`
    : "";
  return `${tokens}${cost}  ${row.harness}  ${row.taskId}  ${row.title}${subtasks}`;
}

const usageList: OpDefinition = {
  name: "usage",
  title:
    "Per-task token usage (docs/costs.md), most tokens first; $ only where the agent recorded an estimate",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "ISO time or YYYY-MM-DD" },
      to: { type: "string", description: "ISO time or YYYY-MM-DD" },
      repository: { type: "string" },
      harness: { type: "string" },
      model: { type: "string" },
      includeArchived: { type: "boolean" },
    },
    additionalProperties: false,
  },
  async handler(args, commands) {
    const raw = args.includeArchived;
    const includeArchived = raw === true || raw === "true";
    if (
      raw !== undefined &&
      raw !== null &&
      typeof raw !== "boolean" &&
      raw !== "true" &&
      raw !== "false"
    ) {
      throw new Error("includeArchived must be a boolean");
    }
    const query: TaskUsageQuery = {};
    for (const key of [
      "from",
      "to",
      "repository",
      "harness",
      "model",
    ] as const) {
      const value = str(args, key);
      if (value) query[key] = value;
    }
    if (includeArchived) query.includeArchived = true;
    const rows = await commands.listTaskUsage(query);
    return {
      text: rows.length
        ? rows.map(formatUsageLine).join("\n")
        : "No task usage recorded.",
      details: { rows },
    };
  },
};

const usageRefresh: OpDefinition = {
  name: "usage_refresh",
  title: "Recompute one task's token usage from its session files",
  inputSchema: {
    type: "object",
    properties: { task: { type: "string" } },
    required: ["task"],
    additionalProperties: false,
  },
  async handler(args, commands) {
    const taskId = str(args, "task");
    if (!taskId) throw new Error("task is required");
    const usage = await commands.refreshTaskUsage(taskId);
    return {
      text: usage
        ? `Task ${taskId}: ${usage.status === "ready" ? `${formatTokenCount(totalTokens(usage.totals))} tokens` : usage.status}`
        : `Task ${taskId}: no session recorded yet`,
      details: { taskId, ...(usage ? { usage } : {}) },
    };
  },
};

/** Every operation, in display order. */
const doctor: OpDefinition = {
  name: "doctor",
  title:
    "Read-only setup self-check: tools, agents, state files, repositories, disk, socket, PATH",
  inputSchema: {
    type: "object",
    properties: {
      loginShellPath: {
        type: "string",
        description:
          "The caller's shell PATH, compared with the PATH the app resolves commands on",
      },
      probeAllRemotes: {
        type: "boolean",
        description:
          "Probe every repository's remote (default: only repositories with an active task)",
      },
    },
    additionalProperties: false,
  },
  async handler(args, commands) {
    const loginShellPath = str(args, "loginShellPath");
    const probeAllRemotes = args.probeAllRemotes;
    if (probeAllRemotes !== undefined && typeof probeAllRemotes !== "boolean") {
      throw new Error("probeAllRemotes must be a boolean");
    }
    const report = await commands.doctor({
      ...(loginShellPath ? { loginShellPath } : {}),
      ...(probeAllRemotes ? { probeAllRemotes: true } : {}),
    });
    return { text: formatDoctorReport(report), details: report };
  },
};

export const OPS_CATALOG: readonly OpDefinition[] = [
  inboxList,
  inboxResolve,
  events,
  rulesList,
  rulesEnable,
  rulesCheck,
  addonsList,
  doctor,
  openUrl,
  requestReview,
  usageList,
  usageRefresh,
];

/** Runs one operation against the command API. */
export async function dispatchOpCall(
  commands: CoreCommands,
  name: string,
  args: unknown,
  caller: ToolCaller = {},
): Promise<ToolResult> {
  const op = OPS_CATALOG.find((candidate) => candidate.name === name);
  if (!op) {
    throw new Error(
      `Unknown operation "${name}". Available: ${OPS_CATALOG.map((o) => o.name).join(", ")}`,
    );
  }
  const record =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  return op.handler(record, commands, caller);
}
