// Engine: the pure rules of task messaging (see /docs/task-messaging.md).
// Route classification, default/resolved delivery mode, the loop cap, the
// derived "waiting on parent" chip state, attachment-prune eligibility and
// find-tasks matching. No I/O and no clock of its own: every time-dependent
// function takes `now`. An Engine per /docs/design-decisions.md "Layering".

import type { PresenceStatus } from "../contracts/harness.js";
import type {
  HarnessMessagingCapabilities,
  MessageMode,
  MessageRoute,
  MessageSender,
  TaskMessage,
  TaskMessagingState,
  TaskRunState,
  TaskSearchResult,
} from "../contracts/messaging.js";
import type { Task } from "../contracts/model.js";

/** Attachment files are pruned this long after both ends are Done. */
export const ATTACHMENT_RETENTION_DAYS = 30;
/** `findTasks` result cap when the caller gives none. */
export const DEFAULT_FIND_TASKS_LIMIT = 20;

/** The lineage fields the engine reads from a task. */
export type LineageTask = Pick<Task, "id" | "parentTaskId">;

/**
 * The route of a new message, from lineage (never from the agent):
 * `target.parentTaskId === sender` → parent-to-child; `sender.parentTaskId ===
 * target` → child-to-parent; everything else, and every non-task sender,
 * needs approval. `senderTask` is the sender's task when the sender is one.
 */
export function classifyRoute(
  sender: MessageSender,
  senderTask: LineageTask | undefined,
  target: LineageTask,
): Exclude<MessageRoute, "receipt"> {
  if (sender.kind !== "task" || !senderTask) return "approval";
  if (target.parentTaskId === senderTask.id) return "parent-to-child";
  if (senderTask.parentTaskId === target.id) return "child-to-parent";
  return "approval";
}

/** The delivery mode a sender gets when it does not ask for one. */
export function defaultMode(route: MessageRoute): MessageMode {
  switch (route) {
    case "parent-to-child":
      return "steer";
    case "child-to-parent":
      return "followUp";
    case "approval":
      return "steer";
    case "receipt":
      return "followUp";
  }
}

/** The mode the target harness will actually use: an unsupported `steer` falls back to `followUp`. */
export function resolveDeliveredMode(
  requested: MessageMode,
  capabilities: HarnessMessagingCapabilities,
): MessageMode {
  return requested === "steer" && !capabilities.steer ? "followUp" : requested;
}

/** Whether a route is one of the autonomous lineage routes that count toward the loop cap. */
export function isLineageRoute(route: MessageRoute): boolean {
  return route === "parent-to-child" || route === "child-to-parent";
}

function ms(iso: string | undefined): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

/**
 * Autonomous lineage messages between one parent–child pair (both
 * directions) created after the user last typed into either task, excluding
 * rejected/failed ones. Approval-route messages and receipts never count.
 */
export function countLoopMessages(
  messages: readonly TaskMessage[],
  userInputs: Readonly<Record<string, string>>,
  parentTaskId: string,
  childTaskId: string,
): number {
  const since = Math.max(
    ms(userInputs[parentTaskId]),
    ms(userInputs[childTaskId]),
  );
  let count = 0;
  for (const message of messages) {
    if (message.status === "rejected" || message.status === "failed") continue;
    if (message.sender.kind !== "task") continue;
    const from = message.sender.taskId;
    const to = message.targetTaskId;
    const inPair =
      (message.route === "parent-to-child" &&
        from === parentTaskId &&
        to === childTaskId) ||
      (message.route === "child-to-parent" &&
        from === childTaskId &&
        to === parentTaskId);
    if (inPair && ms(message.createdAt) > since) count += 1;
  }
  return count;
}

/** Whether the pair is at (or over) the cap. */
export function isLoopCapReached(
  messages: readonly TaskMessage[],
  userInputs: Readonly<Record<string, string>>,
  parentTaskId: string,
  childTaskId: string,
  cap: number,
): boolean {
  return (
    countLoopMessages(messages, userInputs, parentTaskId, childTaskId) >= cap
  );
}

export interface DeriveMessagingStatesInput {
  tasks: readonly Pick<Task, "id" | "state" | "parentTaskId">[];
  messages: readonly TaskMessage[];
  userInputs: Readonly<Record<string, string>>;
  /** Ids of tasks whose harness session is live right now (only parents' liveness is read). */
  liveTaskIds: ReadonlySet<string>;
  now: Date;
  parentReplyTimeoutMinutes: number;
  loopCap: number;
}

/**
 * Per-task chip state. `waitingOnParent` (decision 9) is the child's latest
 * child-to-parent question (not rejected/failed) until: a parent-to-child
 * message to that child is delivered after it; the user typed into the child
 * after it; the parent is Done, gone or not live; or `now >= deliveredAt +
 * timeout`. Tasks with nothing to report are omitted.
 */
export function deriveMessagingStates(
  input: DeriveMessagingStatesInput,
): TaskMessagingState[] {
  const byId = new Map(input.tasks.map((task) => [task.id, task]));
  const states = new Map<string, TaskMessagingState>();
  const stateOf = (taskId: string): TaskMessagingState => {
    let state = states.get(taskId);
    if (!state) {
      state = { taskId };
      states.set(taskId, state);
    }
    return state;
  };
  const timeoutMs = input.parentReplyTimeoutMinutes * 60_000;
  const nowMs = input.now.getTime();

  // Approvals waiting, per target.
  for (const message of input.messages) {
    if (message.status !== "awaiting_approval") continue;
    if (!byId.has(message.targetTaskId)) continue;
    const state = stateOf(message.targetTaskId);
    state.approvalsWaiting = (state.approvalsWaiting ?? 0) + 1;
  }

  for (const child of input.tasks) {
    const parentId = child.parentTaskId;
    if (!parentId) continue;
    const parent = byId.get(parentId);
    if (!parent) continue;

    // Loop cap, on both tasks of the pair.
    const count = countLoopMessages(
      input.messages,
      input.userInputs,
      parentId,
      child.id,
    );
    if (count >= input.loopCap) {
      const childState = stateOf(child.id);
      childState.loopCapReached ??= {
        otherTaskId: parentId,
        count,
        cap: input.loopCap,
      };
      const parentState = stateOf(parentId);
      parentState.loopCapReached ??= {
        otherTaskId: child.id,
        count,
        cap: input.loopCap,
      };
    }

    if (child.state === "done") continue;
    if (parent.state === "done" || !input.liveTaskIds.has(parentId)) continue;

    let question: TaskMessage | undefined;
    for (const message of input.messages) {
      if (
        message.route !== "child-to-parent" ||
        message.sender.kind !== "task" ||
        message.sender.taskId !== child.id ||
        message.targetTaskId !== parentId ||
        message.status === "rejected" ||
        message.status === "failed"
      )
        continue;
      if (!question || ms(message.createdAt) >= ms(question.createdAt)) {
        question = message;
      }
    }
    if (!question) continue;
    const askedAt = ms(question.createdAt);

    if (ms(input.userInputs[child.id]) > askedAt) continue;
    const answered = input.messages.some(
      (message) =>
        message.route === "parent-to-child" &&
        message.status === "delivered" &&
        message.targetTaskId === child.id &&
        message.sender.kind === "task" &&
        message.sender.taskId === parentId &&
        ms(message.deliveredAt) > askedAt,
    );
    if (answered) continue;

    let expiresAt: string | undefined;
    if (question.deliveredAt) {
      const deadline = ms(question.deliveredAt) + timeoutMs;
      if (nowMs >= deadline) continue;
      expiresAt = new Date(deadline).toISOString();
    }
    stateOf(child.id).waitingOnParent = {
      messageId: question.id,
      question: question.text,
      ...(question.deliveredAt ? { deliveredAt: question.deliveredAt } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
    const parentState = stateOf(parentId);
    parentState.childQuestionsWaiting =
      (parentState.childQuestionsWaiting ?? 0) + 1;
  }

  return [...states.values()];
}

/** The task fields attachment pruning reads. */
export type PrunableTask = Pick<
  Task,
  "state" | "completedAt" | "stateChangedAt"
>;

function endIsOldEnough(
  task: PrunableTask | undefined,
  now: Date,
  retentionMs: number,
): boolean {
  if (!task) return true; // deleted counts as Done long ago
  if (task.state !== "done") return false;
  const doneAt = ms(task.completedAt ?? task.stateChangedAt);
  return now.getTime() - doneAt >= retentionMs;
}

/**
 * Whether a message's attachment files may be removed (decision 12): it has
 * unpruned attachments, and both the sender task and the target task are
 * Done for at least 30 days (or deleted). A non-task sender counts as Done.
 */
export function isAttachmentPruneEligible(
  message: TaskMessage,
  tasks: ReadonlyMap<string, PrunableTask>,
  now: Date,
  retentionDays: number = ATTACHMENT_RETENTION_DAYS,
): boolean {
  if (!message.attachments.some((attachment) => !attachment.prunedAt))
    return false;
  const retentionMs = retentionDays * 24 * 60 * 60_000;
  const senderDone =
    message.sender.kind !== "task" ||
    endIsOldEnough(tasks.get(message.sender.taskId), now, retentionMs);
  return (
    senderDone &&
    endIsOldEnough(tasks.get(message.targetTaskId), now, retentionMs)
  );
}

/** The messages whose attachment files should be pruned now. */
export function selectMessagesToPrune(
  messages: readonly TaskMessage[],
  tasks: ReadonlyMap<string, PrunableTask>,
  now: Date,
): TaskMessage[] {
  return messages.filter((message) =>
    isAttachmentPruneEligible(message, tasks, now),
  );
}

/** A task's run state: a queued launch is `queued`; otherwise from harness presence. */
export function deriveRunState(
  task: Pick<Task, "launch">,
  presence: Pick<PresenceStatus, "live" | "runningTurn">,
): TaskRunState {
  if (task.launch?.status === "queued") return "queued";
  if (presence.live) return presence.runningTurn ? "working" : "your-move";
  return "not-running";
}

export type TaskRelation = TaskSearchResult["relation"];

/** How `task` relates to the searching task `from`. */
export function relationTo(
  from: LineageTask | undefined,
  task: LineageTask,
): TaskRelation {
  if (!from) return "none";
  if (from.id === task.id) return "self";
  if (from.parentTaskId === task.id) return "parent";
  if (task.parentTaskId === from.id) return "child";
  if (from.parentTaskId && from.parentTaskId === task.parentTaskId)
    return "sibling";
  return "none";
}

export type SearchableTask = Pick<
  Task,
  | "id"
  | "title"
  | "state"
  | "repositoryId"
  | "branch"
  | "pr"
  | "parentTaskId"
  | "updatedAt"
>;

export interface TaskMatch<T extends SearchableTask> {
  task: T;
  relation: TaskRelation;
  score: number;
}

export interface MatchTasksOptions {
  fromTaskId?: string;
  includeDone?: boolean;
  limit?: number;
}

function scoreToken(task: SearchableTask, token: string): number {
  const id = task.id.toLowerCase();
  const title = task.title.toLowerCase();
  const prToken = token.replace(/^#/, "");
  let best = 0;
  const consider = (score: number) => {
    if (score > best) best = score;
  };
  if (id === token) consider(100);
  else if (id.startsWith(token)) consider(80);
  if (task.pr && /^\d+$/.test(prToken) && String(task.pr.number) === prToken)
    consider(90);
  if (title.startsWith(token)) consider(60);
  else if (title.includes(token)) consider(40);
  if (task.branch?.toLowerCase().includes(token)) consider(30);
  if (task.repositoryId?.toLowerCase().includes(token)) consider(20);
  return best;
}

/**
 * Find-tasks matching: case-insensitive, every whitespace-separated word of
 * the query must match the title, repository id, branch, PR number (`#412`
 * or `412`) or the id (prefix). Done tasks are excluded unless
 * `includeDone`. Sorted by relevance, then recency (`updatedAt`), then id;
 * an empty query lists everything. Limited to `limit` (default 20).
 */
export function matchTasks<T extends SearchableTask>(
  query: string,
  tasks: readonly T[],
  options: MatchTasksOptions = {},
): TaskMatch<T>[] {
  const phrase = query.trim().toLowerCase();
  const tokens = phrase.split(/\s+/).filter(Boolean);
  const from = options.fromTaskId
    ? tasks.find((task) => task.id === options.fromTaskId)
    : undefined;
  const matches: TaskMatch<T>[] = [];
  for (const task of tasks) {
    if (task.state === "done" && !options.includeDone) continue;
    let score = 0;
    let matched = true;
    for (const token of tokens) {
      const tokenScore = scoreToken(task, token);
      if (tokenScore === 0) {
        matched = false;
        break;
      }
      score += tokenScore;
    }
    if (!matched) continue;
    if (tokens.length > 1 && task.title.toLowerCase().includes(phrase))
      score += 20;
    matches.push({ task, relation: relationTo(from, task), score });
  }
  matches.sort(
    (a, b) =>
      b.score - a.score ||
      ms(b.task.updatedAt) - ms(a.task.updatedAt) ||
      a.task.id.localeCompare(b.task.id),
  );
  return matches.slice(0, options.limit ?? DEFAULT_FIND_TASKS_LIMIT);
}

/** What happened to a task sender's approval-route message, for its receipt. */
export interface ReceiptInput {
  outcome: "approved" | "rejected" | "failed";
  /** Title of the task the message was addressed to. */
  targetTitle: string;
  /** Final text; with `originalText` it tells whether the user edited it. */
  text: string;
  originalText?: string;
  failureReason?: string;
}

/** The text of the `receipt` follow-up that reports an approval decision back to a task sender. */
export function buildReceiptText(input: ReceiptInput): string {
  const target = `"${input.targetTitle}"`;
  switch (input.outcome) {
    case "approved":
      return input.originalText !== undefined
        ? `The user approved your message to ${target} after editing it; the delivered text was: ${input.text}`
        : `The user approved your message to ${target}; it is delivered to that task.`;
    case "rejected":
      return `The user rejected your message to ${target}. Do not resend it; ask the user if you need something different.`;
    case "failed":
      return `Your message to ${target} could not be delivered: ${input.failureReason ?? "the task is no longer available"}`;
  }
}
