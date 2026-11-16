// Event contracts for the command API's outbound half ("commands in, state
// events out" — see /docs/design-decisions.md). Transport-ready: no
// Electron/Node-stream-specific types leak through this boundary, so a
// future daemon can re-emit the same payloads over a socket.

import type { BoardColumn, PresenceRecord, Task } from "./model.js";

export interface BoardChangedPayload {
  columns: BoardColumn[];
}
export interface TaskChangedPayload {
  task: Task;
}
export interface PresenceChangedPayload {
  taskId: string;
  record: PresenceRecord | undefined;
}

/** The inbox changed (an item was added, resolved or snoozed); re-read it with `listInbox`. */
export type InboxChangedPayload = Record<string, never>;

export interface MessagesChangedPayload {
  /** Tasks whose messaging state may have changed (targets and task senders). */
  taskIds: string[];
}

/**
 * An agent session asked to open a URL (Plannotator via
 * `PLANNOTATOR_BROWSER`, or any `BROWSER` open when
 * `captureAgentBrowser`); see docs/plannotator.md "Transport".
 */
export interface TaskUrlOpenedPayload {
  taskId: string;
  /** Loopback only (`http(s)://127.0.0.1|localhost|[::1]`). */
  url: string;
  /** `plannotator` when the caller said so; otherwise `browser`. */
  source: "plannotator" | "browser";
}

/** Every event name the core emits, mapped to its payload shape. */
export interface CoreEventMap {
  "board-changed": BoardChangedPayload;
  "task-changed": TaskChangedPayload;
  "presence-changed": PresenceChangedPayload;
  "messages-changed": MessagesChangedPayload;
  "inbox-changed": InboxChangedPayload;
  "task-url-opened": TaskUrlOpenedPayload;
}

export type CoreEventName = keyof CoreEventMap;

/** Typed subscription surface handed to frontends; emission is internal to core. */
export interface CoreEvents {
  on<E extends CoreEventName>(
    event: E,
    listener: (payload: CoreEventMap[E]) => void,
  ): () => void;
}
