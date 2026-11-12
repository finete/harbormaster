// Pure item assembly behind the inbox view (docs/release-plan.md "Inbox"):
// one list of everything that needs a human, built in the renderer from
// core's persisted inbox items (rule `inbox` actions), message approvals,
// and items derived from the board + presence (agent asked / reported /
// done / your move, ready to land, launch failed). Derived items are
// recomputed on every push, never stored; dismissing or snoozing one is
// remembered here by its id, which embeds the signal's own timestamp, so a
// new question or report shows again. Free of React (tests/inbox-items.test.ts).
import type {
  InboxItem,
  PresenceChangedPayload,
  ReadyToLandEntry,
  Task,
  TaskMessage,
  TaskState,
} from "../../../preload/api";
import { derivePresenceActivity } from "./task-status-lines";

/** What an inbox entry is; drives its glyph, buttons and default tab. */
export type InboxKind =
  | "asked"
  | "reported"
  | "approval"
  | "rule"
  | "ready-to-land"
  | "launch-failed"
  | "cleanup-failed"
  | "idle"
  | "done";

/** One action an entry offers; the first is the primary (hover/selection) button. */
export interface InboxAction {
  /** `open` | `to-done` | `mark-done` | `dismiss` | `approve` | `edit` | `reject` | `retry` | `retry-cleanup` | `reveal-worktree` | `abandon-cleanup` | `button:<id>` (a rule button). */
  id: string;
  label: string;
  /** Single-key shortcut in the inbox view. */
  key?: string;
}

export interface InboxEntry {
  /** Stable id: a persisted item's id, `approval:<messageId>`, or `<kind>:<taskId>:<signal time>`. */
  id: string;
  kind: InboxKind;
  /** `harbormaster` for derived items, the event source for rule items. */
  source: string;
  title: string;
  /** Question / report / rule body / error text for the detail pane. */
  body?: string;
  taskId?: string;
  /** ISO time the signal appeared ("time since", ordering). */
  createdAt: string;
  /** The producer's default tab (before the optional priority filter). */
  priority: boolean;
  /** D may hide it (never approvals or live questions). */
  dismissable: boolean;
  /** Stored in core (dismiss / snooze go through `resolveInboxItem`). */
  persisted: boolean;
  actions: InboxAction[];
  /** The rule item itself (rule entries). */
  item?: InboxItem;
  /** The message awaiting approval (approval entries). */
  message?: TaskMessage;
  /** The folder the entry is about (cleanup-failed: the worktree left behind). */
  path?: string;
}

export interface InboxSources {
  tasks: ReadonlyArray<{ task: Task; state: TaskState }>;
  presence: PresenceChangedPayload;
  approvals: readonly TaskMessage[];
  items: readonly InboxItem[];
  readyToLand: readonly ReadyToLandEntry[];
  /** Tasks currently "waiting on parent" (no amber, no inbox item). */
  waitingOnParent?: ReadonlySet<string>;
}

const OPEN: InboxAction = { id: "open", label: "Open", key: "O" };
const DISMISS: InboxAction = { id: "dismiss", label: "Dismiss", key: "D" };

/** Every entry, newest first, before dismiss/snooze filtering and tabs. */
export function assembleInbox(sources: InboxSources): InboxEntry[] {
  const entries: InboxEntry[] = [];
  const byId = new Map(sources.tasks.map((row) => [row.task.id, row]));

  for (const message of sources.approvals) {
    const target = byId.get(message.targetTaskId)?.task;
    entries.push({
      id: `approval:${message.id}`,
      kind: "approval",
      source: "harbormaster",
      title: `${message.senderLabel} → ${target?.title ?? "Task"}`,
      body: message.text,
      taskId: message.targetTaskId,
      createdAt: message.createdAt,
      priority: true,
      dismissable: false,
      persisted: false,
      actions: [
        { id: "approve", label: "Approve", key: "A" },
        { id: "edit", label: "Edit", key: "E" },
        { id: "reject", label: "Reject", key: "R" },
      ],
      message,
    });
  }

  for (const item of sources.items) {
    const buttons = item.buttons.map(
      (button): InboxAction => ({
        id: `button:${button.id}`,
        label: button.label,
        ...(button.action === "createTask"
          ? { key: "C" }
          : button.action === "dismiss"
            ? { key: "D" }
            : button.action === "openTask"
              ? { key: "O" }
              : {}),
      }),
    );
    const hasDismiss = item.buttons.some((b) => b.action === "dismiss");
    entries.push({
      id: item.id,
      kind: "rule",
      source: item.source ?? "rule",
      title: item.title,
      ...(item.body ? { body: item.body } : {}),
      ...(item.taskId ? { taskId: item.taskId } : {}),
      createdAt: item.createdAt,
      priority: item.priority !== false,
      dismissable: true,
      persisted: true,
      actions: hasDismiss ? buttons : [...buttons, DISMISS],
      item,
    });
  }

  const ready = new Map(sources.readyToLand.map((e) => [e.taskId, e]));
  for (const { task, state } of sources.tasks) {
    const cleanup = cleanupFailure(task, state);
    if (cleanup) entries.push(cleanup);
    if (state === "done") continue;
    const landing = ready.get(task.id);
    if (landing) {
      entries.push({
        id: `ready-to-land:${task.id}:${landing.at}`,
        kind: "ready-to-land",
        source: "harbormaster",
        title: "Deployed and ready to land",
        body: landing.detail
          ? `Landing was refused: ${landing.detail}. Mark it Done when you are ready.`
          : "Mark it Done when you are ready.",
        taskId: task.id,
        createdAt: landing.at,
        priority: true,
        dismissable: true,
        persisted: false,
        actions: [{ id: "mark-done", label: "Mark Done", key: "D" }, DISMISS],
      });
    }
    const failure = launchFailure(task);
    if (failure) {
      entries.push({
        id: `launch-failed:${task.id}:${failure.at}`,
        kind: "launch-failed",
        source: "harbormaster",
        title: failure.title,
        body: failure.error,
        taskId: task.id,
        createdAt: failure.at,
        priority: true,
        dismissable: true,
        persisted: false,
        actions: [OPEN, { id: "retry", label: "Retry", key: "R" }, DISMISS],
      });
    }
    const presenceEntry = presenceItem(
      task,
      sources.presence[task.id],
      sources.waitingOnParent?.has(task.id) ?? false,
    );
    if (presenceEntry) entries.push(presenceEntry);
  }

  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Failed attempts after which a confirmed Done's cleanup asks the user (core's `CLEANUP_INBOX_AFTER_ATTEMPTS`). */
export const CLEANUP_INBOX_AFTER_ATTEMPTS = 3;

/**
 * The one "couldn't clean up" item per Done task: its app-owned forced
 * cleanup (`task.cleanup`) failed 3+ times. Leaves on its own once the
 * cleanup succeeds; Dismiss gives up for good (core marks it abandoned).
 * Other tab: the task is Done, nothing is blocked on it.
 */
function cleanupFailure(task: Task, state: TaskState): InboxEntry | undefined {
  const cleanup = task.cleanup;
  if (
    state !== "done" ||
    cleanup?.mode !== "forced" ||
    cleanup.completedAt ||
    !cleanup.lastError ||
    cleanup.attempts < CLEANUP_INBOX_AFTER_ATTEMPTS
  ) {
    return undefined;
  }
  return {
    // Stable per Done (requestedAt): one item per task, not one per attempt.
    id: `cleanup-failed:${task.id}:${cleanup.requestedAt}`,
    kind: "cleanup-failed",
    source: "harbormaster",
    title: `Couldn't clean up ${task.title}'s worktree: ${cleanup.lastError}`,
    body: `Harbormaster tried ${cleanup.attempts} times and keeps retrying (hourly). Retry now, open the folder to look, or dismiss to stop trying and leave it as is.`,
    taskId: task.id,
    createdAt: cleanup.requestedAt,
    priority: false,
    // Dismiss here is core's "give up" (abandon), not a local hide.
    dismissable: false,
    persisted: false,
    actions: [
      { id: "retry-cleanup", label: "Retry", key: "R" },
      ...(cleanup.worktreePath
        ? [{ id: "reveal-worktree", label: "Open folder", key: "F" }]
        : []),
      { id: "abandon-cleanup", label: "Dismiss", key: "D" },
    ],
    ...(cleanup.worktreePath ? { path: cleanup.worktreePath } : {}),
  };
}

function launchFailure(
  task: Task,
): { title: string; error: string; at: string } | undefined {
  if (task.lastError?.startsWith("Launch failed")) {
    return {
      title: "Launch failed",
      error: task.lastError,
      at: task.updatedAt,
    };
  }
  if (task.launch?.status === "interrupted") {
    return {
      title: "Launch interrupted",
      error:
        task.lastError ??
        "The app quit while this launched task was mid-turn; it does not resume on its own.",
      at: task.launch.interruptedAt ?? task.updatedAt,
    };
  }
  return undefined;
}

function presenceItem(
  task: Task,
  presence: PresenceChangedPayload[string] | undefined,
  waitingOnParent: boolean,
): InboxEntry | undefined {
  // Waiting on its parent is not the user's move (task-messaging #9).
  if (waitingOnParent) return undefined;
  const activity = derivePresenceActivity(presence);
  if (!presence || !activity || activity === "working") return undefined;
  const fallbackAt = presence.heartbeatAt ?? task.updatedAt;
  const base = {
    source: "harbormaster",
    taskId: task.id,
    persisted: false,
  } as const;
  if (activity === "your-move" && presence.outcome) {
    const outcome = presence.outcome;
    const at = outcome.at ?? fallbackAt;
    const verdict = outcome.status === "done" ? "Done" : "Blocked";
    return {
      ...base,
      id: `reported:${task.id}:${at}`,
      kind: "reported",
      title: outcome.note
        ? `${verdict}: ${outcome.note}`
        : `Reported ${verdict.toLowerCase()}`,
      ...(outcome.note ? { body: outcome.note } : {}),
      createdAt: at,
      priority: true,
      dismissable: true,
      actions: [OPEN, { id: "to-done", label: "To Done" }, DISMISS],
    };
  }
  const status = presence.status;
  const at = status?.at ?? fallbackAt;
  if (activity === "your-move" && status?.state === "blocked") {
    return {
      ...base,
      id: `asked:${task.id}:${at}`,
      kind: "asked",
      title: status.message?.trim() || "Waiting for your answer",
      ...(status.message ? { body: status.message } : {}),
      createdAt: at,
      priority: true,
      // Live: leaves by itself when the agent's state changes.
      dismissable: false,
      actions: [OPEN],
    };
  }
  if (status?.state === "done") {
    return {
      ...base,
      id: `done:${task.id}:${at}`,
      kind: "done",
      title: status.message?.trim() || "Done, wants a look",
      ...(status.message ? { body: status.message } : {}),
      createdAt: at,
      priority: false,
      dismissable: true,
      actions: [OPEN, DISMISS],
    };
  }
  // Turn ended with nothing reported (incl. an `error` status: at rest
  // with a warning, said in the title).
  return {
    ...base,
    id: `idle:${task.id}:${at}`,
    kind: "idle",
    title:
      status?.state === "error"
        ? `Stopped with an error${status.message ? `: ${status.message}` : ""}`
        : "Your move",
    ...(status?.message ? { body: status.message } : {}),
    createdAt: at,
    priority: false,
    dismissable: true,
    actions: [OPEN, DISMISS],
  };
}

// --- dismiss / snooze (derived items, renderer-side) --------------------

/** Renderer-side state for derived items: dismissed ids and snoozes, keyed by entry id. */
export interface LocalInboxState {
  /** id → ISO time it was dismissed. */
  dismissed: Record<string, string>;
  /** id → ISO time it shows again. */
  snoozed: Record<string, string>;
}

export const INBOX_LOCAL_STATE_KEY = "harbormaster.inbox.local";
const LOCAL_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export function emptyLocalState(): LocalInboxState {
  return { dismissed: {}, snoozed: {} };
}

/** Entries still showing at `now`: not dismissed (derived) and not snoozed. */
export function visibleEntries(
  entries: readonly InboxEntry[],
  local: LocalInboxState,
  now: number,
): InboxEntry[] {
  return entries.filter((entry) => {
    if (!entry.persisted && local.dismissed[entry.id]) return false;
    const until = local.snoozed[entry.id];
    return !(until && Date.parse(until) > now);
  });
}

/** Drops expired snoozes and dismissals older than the retention window. */
export function pruneLocalState(
  local: LocalInboxState,
  now: number,
): LocalInboxState {
  const dismissed = Object.fromEntries(
    Object.entries(local.dismissed).filter(
      ([, at]) => now - Date.parse(at) < LOCAL_RETENTION_MS,
    ),
  );
  const snoozed = Object.fromEntries(
    Object.entries(local.snoozed).filter(
      ([, until]) => Date.parse(until) > now,
    ),
  );
  return { dismissed, snoozed };
}

export function parseLocalState(raw: string | null): LocalInboxState {
  if (!raw) return emptyLocalState();
  try {
    const value = JSON.parse(raw) as Partial<LocalInboxState>;
    const pick = (record: unknown): Record<string, string> =>
      record && typeof record === "object" && !Array.isArray(record)
        ? Object.fromEntries(
            Object.entries(record as Record<string, unknown>).filter(
              (pair): pair is [string, string] => typeof pair[1] === "string",
            ),
          )
        : {};
    return { dismissed: pick(value.dismissed), snoozed: pick(value.snoozed) };
  } catch {
    return emptyLocalState();
  }
}

// --- tabs and groups ----------------------------------------------------

export type InboxTab = "priority" | "other";

export interface InboxGroup {
  /** Task id, or `unbound` for items about no task (review requests, mentions). */
  key: string;
  taskId?: string;
  entries: InboxEntry[];
}

export const UNBOUND_GROUP = "unbound";

/** Entries of one tab, grouped by task; groups ordered by their newest entry. */
export function groupEntries(
  entries: readonly InboxEntry[],
  priorities: ReadonlyMap<string, boolean>,
  tab: InboxTab,
): InboxGroup[] {
  const groups = new Map<string, InboxGroup>();
  const sorted = [...entries].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  for (const entry of sorted) {
    const priority = priorities.get(entry.id) ?? entry.priority;
    if ((tab === "priority") !== priority) continue;
    const key = entry.taskId ?? UNBOUND_GROUP;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        ...(entry.taskId ? { taskId: entry.taskId } : {}),
        entries: [],
      };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}

/** Count of Priority entries (the sidebar badge). */
export function priorityCount(
  entries: readonly InboxEntry[],
  priorities: ReadonlyMap<string, boolean>,
): number {
  return entries.filter((entry) => priorities.get(entry.id) ?? entry.priority)
    .length;
}

/** Keyboard order: the flattened entries of a tab's groups. */
export function navigationOrder(groups: readonly InboxGroup[]): string[] {
  return groups.flatMap((group) => group.entries.map((entry) => entry.id));
}

/** J/K: the next / previous id (clamped), or the first when nothing is selected. */
export function moveSelection(
  order: readonly string[],
  current: string | null,
  delta: 1 | -1,
): string | null {
  if (order.length === 0) return null;
  const index = current ? order.indexOf(current) : -1;
  if (index === -1) return order[0] ?? null;
  const next = Math.min(order.length - 1, Math.max(0, index + delta));
  return order[next] ?? null;
}

/** After the selected entry left the list: its neighbor at the same position. */
export function selectionAfterRemoval(
  previousOrder: readonly string[],
  order: readonly string[],
  removed: string,
): string | null {
  if (order.length === 0) return null;
  const index = previousOrder.indexOf(removed);
  for (let i = index + 1; i < previousOrder.length; i++) {
    const id = previousOrder[i];
    if (id && order.includes(id)) return id;
  }
  for (let i = index - 1; i >= 0; i--) {
    const id = previousOrder[i];
    if (id && order.includes(id)) return id;
  }
  return order[0] ?? null;
}

// --- snooze presets -----------------------------------------------------

export interface SnoozePreset {
  id: "hour" | "evening" | "tomorrow" | "next-week";
  label: string;
  until: Date;
}

/** 1 hour / this evening (18:00, only before 17:00) / tomorrow 09:00 / next Monday 09:00, local time. */
export function snoozePresets(now: Date): SnoozePreset[] {
  const at = (days: number, hour: number): Date => {
    const date = new Date(now);
    date.setDate(date.getDate() + days);
    date.setHours(hour, 0, 0, 0);
    return date;
  };
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "1 hour",
      until: new Date(now.getTime() + 60 * 60 * 1000),
    },
  ];
  if (now.getHours() < 17) {
    presets.push({ id: "evening", label: "This evening", until: at(0, 18) });
  }
  presets.push({ id: "tomorrow", label: "Tomorrow morning", until: at(1, 9) });
  // Next Monday (a week from today when today is Monday).
  const toMonday = (8 - now.getDay()) % 7 || 7;
  presets.push({ id: "next-week", label: "Next week", until: at(toMonday, 9) });
  return presets;
}

/** The `priority` filter inputs core evaluates (`evaluateInboxPriority`). */
export function priorityInputs(
  entries: readonly InboxEntry[],
  repoOf: (taskId: string) => string | undefined,
): Array<{
  id: string;
  kind: string;
  source?: string;
  taskId?: string;
  repo?: string;
  priority: boolean;
}> {
  return entries.map((entry) => {
    const repo = entry.taskId ? repoOf(entry.taskId) : undefined;
    return {
      id: entry.id,
      kind: entry.kind,
      source: entry.source,
      ...(entry.taskId ? { taskId: entry.taskId } : {}),
      ...(repo ? { repo } : {}),
      priority: entry.priority,
    };
  });
}
