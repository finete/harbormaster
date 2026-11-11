// Inbox contracts (docs/release-plan.md "Inbox"): one persisted list of
// things that need a human. Core stores rule-produced items (`inbox`
// action); the app's inbox view joins them with message approvals and the
// items it derives from the board and presence (agent asked / reported,
// your move, ready to land, launch failed), which are recomputed, never
// stored. Plain types; storage in access/json-inbox-access.ts.

/** One button on an inbox item; `resolveInboxItem(id, { buttonId })` runs it. */
export interface InboxButton {
  id: string;
  label: string;
  /**
   * `openTask`: resolves the item and returns `taskId` for the frontend to open;
   * `createTask`: creates the pre-filled task (`with` = createTask action input);
   * `dismiss`: resolves the item; `snooze`: hides it until `with.until` (ISO) or 1 hour.
   */
  action: "openTask" | "createTask" | "dismiss" | "snooze";
  with?: Record<string, unknown>;
}

export interface InboxItem {
  id: string;
  /** Where it came from: `rule` today. */
  kind: string;
  /** The event source that produced it (`github`, an addon id), when known. */
  source?: string;
  title: string;
  body?: string;
  buttons: InboxButton[];
  taskId?: string;
  /** Provenance for rule items. */
  ruleId?: string;
  eventId?: string;
  createdAt: string;
  /** Priority tab (default true); a rule sets `priority: false` for Other. */
  priority?: boolean;
  /** Hidden from `listInbox` until then. */
  snoozedUntil?: string;
  resolvedAt?: string;
  /** The button that resolved it (absent = resolved without one). */
  resolvedBy?: string;
}

export interface ListInboxOptions {
  /** Include resolved items (default false). */
  includeResolved?: boolean;
  /** Include snoozed items (default false). */
  includeSnoozed?: boolean;
}

export interface ResolveInboxItemOptions {
  /** The pressed button; absent = plain dismiss. */
  buttonId?: string;
  /**
   * Snooze without a button: hide the item until this ISO time (not
   * resolved). Ignored when `buttonId` is set.
   */
  snoozeUntil?: string;
}

/**
 * One inbox item as the optional priority filter sees it (`item` in CEL,
 * `GlobalConfig.inbox.priorityFilter`). Derived items (agent asked, your
 * move, approvals, …) and persisted rule items share this shape so the app
 * and `harbormaster inbox` sort them the same way.
 */
export interface InboxPriorityInput {
  id: string;
  /** `asked` | `reported` | `approval` | `idle` | `done` | `ready-to-land` | `launch-failed` | `rule` | … */
  kind: string;
  /** `harbormaster` for derived items, the event source for rule items. */
  source?: string;
  taskId?: string;
  /** Repository id of the item's task, when it has one. */
  repo?: string;
  /** The producer's default. */
  priority: boolean;
}

/** A task a rule tried to land but could not (dirty worktree, live pane): "ready to land". */
export interface ReadyToLandEntry {
  taskId: string;
  /** The rule whose `move: done` stayed. */
  ruleId: string;
  /** Why landing was refused. */
  detail?: string;
  /** Time of the event that triggered the landing. */
  at: string;
}

export interface ResolveInboxItemResult {
  item: InboxItem;
  /** Task the frontend should open (openTask) or the task createTask made. */
  taskId?: string;
}

/** Resource Access: `<stateDir>/inbox/items.json`. */
export interface InboxAccess {
  list(): Promise<InboxItem[]>;
  add(item: InboxItem): Promise<void>;
  /** Atomic update of one item; `undefined` when it does not exist. */
  update(
    id: string,
    patch: (item: InboxItem) => InboxItem,
  ): Promise<InboxItem | undefined>;
}
