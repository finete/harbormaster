// Inbox contracts (docs/release-plan.md "Inbox"): one persisted list of
// things that need a human. This wave stores rule-produced items
// (`inbox` action); message approvals, "your move" and failed launches join
// the same list in the UI wave. Plain types; storage in
// access/json-inbox-access.ts.

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
  title: string;
  body?: string;
  buttons: InboxButton[];
  taskId?: string;
  /** Provenance for rule items. */
  ruleId?: string;
  eventId?: string;
  createdAt: string;
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
