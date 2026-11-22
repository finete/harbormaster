// Task-messaging contracts (see /docs/task-messaging.md): tasks steering
// tasks. Plain types at the boundary: the persisted message record, the
// shapes the commands take and return, and the capability declaration each
// harness adapter exposes. No behavior lives here.

import type { TaskState } from "./model.js";

/** How a message lands in the target session: after the current tool calls (`steer`), or once the target finished its pending work (`followUp`). */
export type MessageMode = "steer" | "followUp";

/** Who sent a message. Task senders come from the launch environment, never from tool arguments. */
export type MessageSender =
  | { kind: "task"; taskId: string }
  | { kind: "session"; cwd: string; sessionId?: string } // non-task Pi session
  | { kind: "harbormaster" } // receipts
  | { kind: "rule"; ruleId: string } // a rules-engine `message` action (needs approval like any non-task sender)
  | { kind: "user" }; // the user, from the app (e.g. the Review button): no approval

/** Decided by core at send time from lineage; never supplied by the agent. */
export type MessageRoute =
  | "parent-to-child" // no approval, counts toward the loop cap
  | "child-to-parent" // no approval, a report or (expectsReply) a question, counts toward the loop cap
  | "task-to-task" // no approval: the user's `messaging.directRoutes` setting or a pair grant allows it; counts toward the loop cap
  | "approval" // everything else: needs the user's approval
  | "receipt" // approval result back to a task sender
  | "user"; // sent by the user themself: no approval, no loop cap

export type MessageStatus =
  | "awaiting_approval"
  | "pending" // deliverable: waiting for the target session to claim it
  | "delivered"
  | "rejected" // the user rejected it
  | "failed"; // became undeliverable (target Done/deleted) before delivery

export interface MessageAttachment {
  /** Absolute path of core's copy. */
  path: string;
  originalPath: string;
  mimeType?: string;
  bytes: number;
  prunedAt?: string;
}

/** One persisted message (kept forever; attachment files are pruned, see `prunedAt`). */
export interface TaskMessage {
  id: string;
  sender: MessageSender;
  /** Display snapshot: the sender task's title, "Pi session in <cwd>", or "Harbormaster". */
  senderLabel: string;
  targetTaskId: string;
  route: MessageRoute;
  /** Final text (after any edit on approval). */
  text: string;
  /** The agent's original text when the user edited it on approval. */
  originalText?: string;
  requestedMode: MessageMode;
  /**
   * The sender asked for an answer and is waiting for it. Stored on every
   * route; only a child-to-parent message with it set is a question (the
   * child "waits on parent"). Absent on older messages and reports.
   */
  expectsReply?: boolean;
  /** What the target harness actually used; set on delivery. */
  deliveredMode?: MessageMode;
  attachments: MessageAttachment[];
  status: MessageStatus;
  /** For a receipt: the message it reports on. */
  regardingMessageId?: string;
  createdAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  deliveredAt?: string;
  failedAt?: string;
  failureReason?: string;
}

/** What a harness adapter can deliver; core resolves the actual mode from this. */
export interface HarnessMessagingCapabilities {
  receive: boolean;
  steer: boolean;
  followUp: boolean;
  images: boolean;
}

export interface SendTaskMessageInput {
  /** From the launch environment (adapter), never from tool arguments. */
  from: MessageSender;
  targetTaskId: string;
  text: string;
  mode?: MessageMode;
  /** The sender ends its turn to wait for an answer (default false: a report or result). */
  expectsReply?: boolean;
  /** Absolute file paths; copied by core at send time. */
  attachments?: string[];
}

export interface SendTaskMessageResult {
  message: TaskMessage;
  /** pending + the target has no live session: the app will wake it. */
  willWake: boolean;
  /** One-line, agent-facing explanation of what happens next. */
  note: string;
}

/**
 * What `reportTaskOutcome` did about the task's parent: a task with a
 * parent sends it the report as a child-to-parent message. A notification
 * that could not be sent never fails the report; `reason` says why.
 */
export interface ReportTaskOutcomeResult {
  /** Set only for a task with a parent. */
  parentNotice?: {
    parentTaskId: string;
    notified: boolean;
    /** Why the parent was not notified (the send's own error). */
    reason?: string;
  };
}

export type TaskRunState = "running" | "your-move" | "queued" | "not-running";

export interface TaskSearchResult {
  id: string;
  title: string;
  state: TaskState;
  repositoryId?: string;
  branch?: string;
  prNumber?: number;
  run: TaskRunState;
  relation: "self" | "parent" | "child" | "sibling" | "none";
  /**
   * How a send from the searching task would go: `direct` (delivered, no
   * approval) or `needs-approval` (waits for the user). Absent for the task
   * itself. Without a searching task (a plain session) it is always
   * `needs-approval`.
   */
  send?: "direct" | "needs-approval";
}

/** Per-task derived messaging state for chips; time-dependent fields carry their own deadline so the renderer can re-evaluate with its own clock. */
export interface TaskMessagingState {
  taskId: string;
  waitingOnParent?: {
    messageId: string;
    question: string;
    deliveredAt?: string;
    /** deliveredAt + timeout; absent while the question is not yet delivered. */
    expiresAt?: string;
  };
  /** On a parent: children's questions still waiting on it. */
  childQuestionsWaiting?: number;
  /** On a target: messages to it awaiting the user's approval. */
  approvalsWaiting?: number;
  /** Set while a pair of tasks talking directly is at the loop cap (on both tasks). */
  loopCapReached?: { otherTaskId: string; count: number; cap: number };
  /** Task ids this task has a pair grant with (direct messages both ways until either ends). */
  grantedWith?: string[];
}

/** Options for `CoreCommands.findTasks`. */
export interface FindTasksOptions {
  /** The searching task: relations (parent/child/sibling/self) are reported relative to it. */
  fromTaskId?: string;
  includeDone?: boolean;
  /** Default 20. */
  limit?: number;
}

/** Edits the user may apply when approving a message. */
export interface ApproveMessageEdits {
  text?: string;
  mode?: MessageMode;
  /**
   * "Approve and allow both ways" (docs/task-trees.md decision 15): also
   * record a pair grant so the sender and target task message each other
   * directly from now on. Only valid on a task → task approval.
   */
  allowBothWays?: boolean;
}

/** What approving returns: the approved message, plus (for "allow both ways") how many other waiting messages between the pair were released with it. */
export type ApproveMessageResult = TaskMessage & { releasedCount?: number };

/**
 * A pair grant: two tasks the user let message each other directly in both
 * directions. Unordered (`taskIds` is stored sorted). It ends when either
 * task is Done or deleted, or when the user removes it.
 */
export interface PairGrant {
  taskIds: [string, string];
  grantedAt: string;
}

/** Everything `messages.json` holds, as handed to Managers/Engines (read-only snapshot). */
export interface MessageStoreSnapshot {
  messages: TaskMessage[];
  /** Last time the user typed into each task's session (ISO). */
  userInputs: Record<string, string>;
  /** Pair grants currently on record (the Manager ignores those whose tasks ended). */
  grants: PairGrant[];
}
