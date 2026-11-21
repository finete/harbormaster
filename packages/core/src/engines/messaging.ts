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
  PairGrant,
  TaskMessage,
  TaskMessagingState,
  TaskRunState,
  TaskSearchResult,
} from "../contracts/messaging.js";
import type { MessageDirectRoutes, Task } from "../contracts/model.js";
import { inSameTree } from "./task-tree.js";

/** Attachment files are pruned this long after both ends are Done. */
export const ATTACHMENT_RETENTION_DAYS = 30;
/** `findTasks` result cap when the caller gives none. */
export const DEFAULT_FIND_TASKS_LIMIT = 20;

/** The lineage fields the engine reads from a task. */
export type LineageTask = Pick<Task, "id" | "parentTaskId">;

/** The task fields routing reads: lineage for the tree walk, state for grant expiry. */
export type RoutingTask = Pick<Task, "id" | "parentTaskId" | "state">;

/** What the user's setting and grants say about who may message whom directly. */
export interface DirectRoutePolicy {
  /** `messaging.directRoutes`. */
  directRoutes: MessageDirectRoutes;
  /** Every task by id (the same-tree walk and grant expiry read it). */
  tasks: ReadonlyMap<string, RoutingTask>;
  /** Pair grants on record. */
  grants: readonly PairGrant[];
}

/**
 * A grant is in force only while both tasks exist and neither is Done
 * (docs/task-trees.md decision 15), whether or not the record has been
 * cleaned up yet.
 */
export function isPairGranted(
  policy: Pick<DirectRoutePolicy, "grants" | "tasks">,
  a: string,
  b: string,
): boolean {
  const first = policy.tasks.get(a);
  const second = policy.tasks.get(b);
  if (!first || !second || first.state === "done" || second.state === "done")
    return false;
  return policy.grants.some(
    (grant) =>
      (grant.taskIds[0] === a && grant.taskIds[1] === b) ||
      (grant.taskIds[0] === b && grant.taskIds[1] === a),
  );
}

/** Whether two tasks are joined by a direct parent link (either way). */
function isDirectLink(a: LineageTask, b: LineageTask): boolean {
  return a.parentTaskId === b.id || b.parentTaskId === a.id;
}

/**
 * Whether a task → task send between these two goes without approval: a
 * direct parent link always; any two tasks in the same tree under
 * `same-task-tree`; any two tasks under `any-task`; or a pair grant.
 */
export function canMessageDirectly(
  a: LineageTask,
  b: LineageTask,
  policy: DirectRoutePolicy,
): boolean {
  if (isDirectLink(a, b)) return true;
  switch (policy.directRoutes) {
    case "any-task":
      return true;
    case "same-task-tree":
      if (inSameTree(a, b, policy.tasks)) return true;
      break;
    case "parent-and-child":
      break;
  }
  return isPairGranted(policy, a.id, b.id);
}

/**
 * The route of a new message, from lineage, the user's setting and pair
 * grants (never from the agent): the user themself → user (no approval);
 * `target.parentTaskId === sender` → parent-to-child; `sender.parentTaskId
 * === target` → child-to-parent (both stay direct-parent-only: "waiting on
 * parent" hangs on them); any other task → task pair the policy allows →
 * task-to-task; everything else, and every non-task sender (a plain session,
 * a rule), needs approval. `senderTask` is the sender's task when the sender
 * is one.
 */
export function classifyRoute(
  sender: MessageSender,
  senderTask: LineageTask | undefined,
  target: LineageTask,
  policy: DirectRoutePolicy,
): Exclude<MessageRoute, "receipt"> {
  if (sender.kind === "user") return "user";
  if (sender.kind !== "task" || !senderTask) return "approval";
  if (target.parentTaskId === senderTask.id) return "parent-to-child";
  if (senderTask.parentTaskId === target.id) return "child-to-parent";
  return canMessageDirectly(senderTask, target, policy)
    ? "task-to-task"
    : "approval";
}

/** The delivery mode a sender gets when it does not ask for one. */
export function defaultMode(route: MessageRoute): MessageMode {
  switch (route) {
    case "parent-to-child":
    case "task-to-task":
      return "steer";
    case "child-to-parent":
      return "followUp";
    case "approval":
    case "user":
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

/** Whether a route is a direct task → task one that counts toward the loop cap (every route but approval, receipt and the user's own). */
export function isDirectRoute(route: MessageRoute): boolean {
  return (
    route === "parent-to-child" ||
    route === "child-to-parent" ||
    route === "task-to-task"
  );
}

function ms(iso: string | undefined): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

/** Whether a message is a directly delivered task → task one that counts (rejected/failed ones never do). */
function countsTowardCap(message: TaskMessage): boolean {
  return (
    message.sender.kind === "task" &&
    isDirectRoute(message.route) &&
    message.status !== "rejected" &&
    message.status !== "failed"
  );
}

/**
 * Directly delivered task → task messages between one pair of tasks (both
 * directions, whatever the route: lineage, setting or grant) created after
 * the user last typed into either task, excluding rejected/failed ones.
 * Approved (approval-route) sends and receipts never count.
 */
export function countLoopMessages(
  messages: readonly TaskMessage[],
  userInputs: Readonly<Record<string, string>>,
  taskA: string,
  taskB: string,
): number {
  const since = Math.max(ms(userInputs[taskA]), ms(userInputs[taskB]));
  let count = 0;
  for (const message of messages) {
    if (!countsTowardCap(message) || message.sender.kind !== "task") continue;
    const from = message.sender.taskId;
    const to = message.targetTaskId;
    const inPair = (from === taskA && to === taskB) || (from === taskB && to === taskA);
    if (inPair && ms(message.createdAt) > since) count += 1;
  }
  return count;
}

/** Whether the pair is at (or over) the cap. */
export function isLoopCapReached(
  messages: readonly TaskMessage[],
  userInputs: Readonly<Record<string, string>>,
  taskA: string,
  taskB: string,
  cap: number,
): boolean {
  return countLoopMessages(messages, userInputs, taskA, taskB) >= cap;
}

/** One pass over the log: the count per unordered pair, each with its own reset point. */
function countPairs(
  messages: readonly TaskMessage[],
  userInputs: Readonly<Record<string, string>>,
): Array<{ a: string; b: string; count: number }> {
  const pairs = new Map<string, { a: string; b: string; count: number }>();
  for (const message of messages) {
    if (!countsTowardCap(message) || message.sender.kind !== "task") continue;
    const [a, b] =
      message.sender.taskId < message.targetTaskId
        ? [message.sender.taskId, message.targetTaskId]
        : [message.targetTaskId, message.sender.taskId];
    const since = Math.max(ms(userInputs[a]), ms(userInputs[b]));
    if (ms(message.createdAt) <= since) continue;
    const key = `${a}\u0000${b}`;
    const entry = pairs.get(key);
    if (entry) entry.count += 1;
    else pairs.set(key, { a, b, count: 1 });
  }
  return [...pairs.values()];
}

export interface DeriveMessagingStatesInput {
  tasks: readonly Pick<Task, "id" | "state" | "parentTaskId">[];
  /** Pair grants on record (only those still in force are reported). */
  grants?: readonly PairGrant[];
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
 * timeout`. The parent's `childQuestionsWaiting` counts only questions it
 * has not replied to yet: a reply sent after the question (still pending
 * while the child finishes its turn) already answers it from the parent's
 * side. Tasks with nothing to report are omitted.
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

  // Loop cap: every pair of tasks talking directly, on both tasks.
  for (const { a, b, count } of countPairs(input.messages, input.userInputs)) {
    if (count < input.loopCap || !byId.has(a) || !byId.has(b)) continue;
    stateOf(a).loopCapReached ??= { otherTaskId: b, count, cap: input.loopCap };
    stateOf(b).loopCapReached ??= { otherTaskId: a, count, cap: input.loopCap };
  }

  // Pair grants still in force, on both tasks.
  const grants = input.grants ?? [];
  for (const grant of grants) {
    const [a, b] = grant.taskIds;
    if (!isPairGranted({ grants, tasks: byId }, a, b)) continue;
    (stateOf(a).grantedWith ??= []).push(b);
    (stateOf(b).grantedWith ??= []).push(a);
  }

  for (const child of input.tasks) {
    const parentId = child.parentTaskId;
    if (!parentId) continue;
    const parent = byId.get(parentId);
    if (!parent) continue;

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
    // Replied, not yet delivered (the child is mid-turn): the child still
    // waits for it, but the parent has nothing left to answer.
    const replied = input.messages.some(
      (message) =>
        message.route === "parent-to-child" &&
        message.targetTaskId === child.id &&
        message.sender.kind === "task" &&
        message.sender.taskId === parentId &&
        message.status !== "rejected" &&
        message.status !== "failed" &&
        ms(message.createdAt) > askedAt,
    );
    if (!replied) {
      const parentState = stateOf(parentId);
      parentState.childQuestionsWaiting =
        (parentState.childQuestionsWaiting ?? 0) + 1;
    }
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
  if (presence.live) return presence.runningTurn ? "running" : "your-move";
  return "not-running";
}

/**
 * The rules' `agent` fact (docs/plannotator.md "Rules surface"): what a
 * task's agent is doing, from harness presence. `working` while a turn
 * runs; `your-move` for a self-reported outcome, a `blocked` program status
 * or a live session that reports no status; `idle` at rest (`idle` /
 * `done`); `error` at rest after a failure; `stopped` with no live session.
 */
export type AgentActivity =
  | "working"
  | "idle"
  | "your-move"
  | "error"
  | "stopped";

export function deriveAgentActivity(presence: PresenceStatus): AgentActivity {
  if (!presence.live) return "stopped";
  if (presence.runningTurn) return "working";
  if (presence.record?.outcome) return "your-move";
  switch (presence.record?.status?.state) {
    case "error":
      return "error";
    case "idle":
    case "done":
      return "idle";
    default:
      return "your-move";
  }
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
