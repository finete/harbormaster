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
  | { kind: "rule"; ruleId: string }; // a rules-engine `message` action (needs approval like any non-task sender)

/** Decided by core at send time from lineage; never supplied by the agent. */
export type MessageRoute =
  | "parent-to-child" // no approval, counts toward the loop cap
  | "child-to-parent" // no approval, a question, counts toward the loop cap
  | "approval" // everything else: needs the user's approval
  | "receipt"; // approval result back to a task sender

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

export type TaskRunState = "working" | "your-move" | "queued" | "not-running";

export interface TaskSearchResult {
  id: string;
  title: string;
  state: TaskState;
  repositoryId?: string;
  branch?: string;
  prNumber?: number;
  run: TaskRunState;
  relation: "self" | "parent" | "child" | "sibling" | "none";
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
  /** Set while a parent–child pair is at the loop cap (on both tasks). */
  loopCapReached?: { otherTaskId: string; count: number; cap: number };
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
}

/** Everything `messages.json` holds, as handed to Managers/Engines (read-only snapshot). */
export interface MessageStoreSnapshot {
  messages: TaskMessage[];
  /** Last time the user typed into each task's session (ISO). */
  userInputs: Record<string, string>;
}
