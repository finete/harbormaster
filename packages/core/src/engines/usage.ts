// Engine: per-task token usage (docs/costs.md), pure. Sums the
// `SessionUsage` the harness adapters read into the `TaskUsage` persisted
// on the task, and shapes `listTaskUsage` rows. No I/O: the manager reads
// session files through the adapters and persists the result.
//
// Rules:
// - A forked session's copied prefix (`forkedFrom.prefix`) is subtracted:
//   those turns were spent by the parent session (counted there when it is
//   one of the task's sessions, and not this task's spend otherwise).
// - Per-model usage merges across sessions by model id.
// - `$` only when the harness wrote it: the task's `cost` is the sum over
//   its sessions only when every session with turns had a cost; otherwise
//   absent (never a partial sum).

import {
  DEFAULT_HARNESS_ID,
  type Task,
  type WorkspaceBinding,
} from "../contracts/model.js";
import type {
  ModelUsage,
  SessionUsage,
  SubtaskUsage,
  TaskUsage,
  TaskUsageQuery,
  TaskUsageRow,
  TokenBuckets,
} from "../contracts/usage.js";
import {
  emptyBuckets,
  ModelUsageAccumulator,
  roundCost,
  totalTokens,
} from "../utilities/usage-accumulator.js";
import { ancestorsOf, indexTasks } from "./task-tree.js";

export { totalTokens } from "../utilities/usage-accumulator.js";

/** Harness id a task runs on when it names none. */
const DEFAULT_HARNESS = DEFAULT_HARNESS_ID;

function subtractModel(
  usage: ModelUsage,
  prefix: ModelUsage | undefined,
): ModelUsage {
  if (!prefix) return usage;
  const net: ModelUsage = {
    model: usage.model,
    input: Math.max(0, usage.input - prefix.input),
    output: Math.max(0, usage.output - prefix.output),
    cacheRead: Math.max(0, usage.cacheRead - prefix.cacheRead),
    cacheWrite: Math.max(0, usage.cacheWrite - prefix.cacheWrite),
    turns: Math.max(0, usage.turns - prefix.turns),
  };
  if (usage.cost !== undefined && prefix.cost !== undefined) {
    net.cost = roundCost(Math.max(0, usage.cost - prefix.cost));
  } else if (usage.cost !== undefined && prefix.turns === 0) {
    net.cost = usage.cost;
  }
  return net;
}

/**
 * One session's own spend: `byModel` minus the fork prefix. Models left
 * with no tokens are dropped (nothing was spent: a bootstrap pseudo-model,
 * aborted turns, a fully copied prefix).
 */
export function netSessionUsage(session: SessionUsage): ModelUsage[] {
  const prefix = new Map(
    (session.forkedFrom?.prefix ?? []).map((usage) => [usage.model, usage]),
  );
  return session.byModel
    .map((usage) => subtractModel(usage, prefix.get(usage.model)))
    .filter((usage) => totalTokens(usage) > 0);
}

function sumBuckets(models: readonly ModelUsage[]): TokenBuckets {
  const sum = emptyBuckets();
  for (const usage of models) {
    sum.input += usage.input;
    sum.output += usage.output;
    sum.cacheRead += usage.cacheRead;
    sum.cacheWrite += usage.cacheWrite;
  }
  return sum;
}

/**
 * Sum a task's sessions (duplicates by path counted once) into a `ready`
 * `TaskUsage`.
 */
export function summarizeTaskUsage(
  sessions: readonly SessionUsage[],
  context: { harness: string; computedAt: string },
): TaskUsage {
  const merged = new ModelUsageAccumulator();
  const rows: TaskUsage["sessions"] = [];
  const seen = new Set<string>();
  let costSum = 0;
  let priced = true;
  let spending = 0;
  let costSource: string | undefined;
  for (const session of sessions) {
    if (seen.has(session.sessionPath)) continue;
    seen.add(session.sessionPath);
    const net = netSessionUsage(session);
    for (const usage of net) merged.addUsage(usage);
    const turns = net.reduce((sum, usage) => sum + usage.turns, 0);
    const sessionCost =
      session.costSource && net.every((usage) => usage.cost !== undefined)
        ? roundCost(net.reduce((sum, usage) => sum + (usage.cost ?? 0), 0))
        : undefined;
    if (turns > 0) {
      spending += 1;
      if (sessionCost === undefined) priced = false;
      else {
        costSum += sessionCost;
        costSource ??= session.costSource;
      }
    }
    rows.push({
      sessionPath: session.sessionPath,
      harness: context.harness,
      totals: sumBuckets(net),
      ...(sessionCost !== undefined && turns > 0 ? { cost: sessionCost } : {}),
    });
  }
  const byModel = merged.result();
  const turns = byModel.reduce((sum, usage) => sum + usage.turns, 0);
  const source = spending > 0 && priced ? costSource : undefined;
  return {
    status: "ready",
    totals: { ...sumBuckets(byModel), turns },
    byModel,
    sessions: rows,
    ...(source !== undefined
      ? { cost: roundCost(costSum), costSource: source }
      : {}),
    computedAt: context.computedAt,
  };
}

/** A usage that is not (yet) known: `pending` (session still being written) or `unavailable`. */
export function placeholderUsage(
  status: "pending" | "unavailable",
  computedAt: string,
  reason?: TaskUsage["reason"],
): TaskUsage {
  return {
    status,
    ...(reason ? { reason } : {}),
    totals: { ...emptyBuckets(), turns: 0 },
    byModel: [],
    sessions: [],
    computedAt,
  };
}

/** Change detector over a task's session files (`TaskUsage.fingerprint`). */
export function usageFingerprint(
  files: ReadonlyArray<{
    sessionPath: string;
    stat: { size: number; mtimeMs: number } | undefined;
  }>,
): string {
  return files
    .map(
      ({ sessionPath, stat }) =>
        `${sessionPath}:${stat ? `${stat.size}:${Math.floor(stat.mtimeMs)}` : "missing"}`,
    )
    .sort()
    .join("|");
}

// --- listTaskUsage --------------------------------------------------------

/** A `YYYY-MM-DD` bound means that whole (UTC) day. */
function boundMs(value: string, edge: "from" | "to"): number | undefined {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const ms = Date.parse(
    dateOnly
      ? `${value}T${edge === "from" ? "00:00:00.000" : "23:59:59.999"}Z`
      : value,
  );
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * When a row's spend happened, for the range filter: the session files'
 * newest mtime, else completion, else the last task update. Never
 * `computedAt` (a backfill computing an old task today is not spend today).
 */
export function usageActivityAt(task: Task): string | undefined {
  return task.usage?.lastActivityAt ?? task.completedAt ?? task.updatedAt;
}

/**
 * Whether the usage backfill still owes this task a first computation: no
 * usage yet, and either Done (missing sessions are then marked
 * `unavailable` once) or bound to a session.
 */
export function awaitsUsageBackfill(
  task: Task,
  binding: WorkspaceBinding | undefined,
): boolean {
  if (task.usage) return false;
  if (task.state === "done") return true;
  return Boolean(
    binding?.sessionId || binding?.sessionPath || binding?.previousSessionPath,
  );
}

/** The newest mtime among stat'ed session files (ISO), for `TaskUsage.lastActivityAt`. */
export function lastActivityFromStats(
  files: ReadonlyArray<{ stat: { mtimeMs: number } | undefined }>,
): string | undefined {
  let newest: number | undefined;
  for (const { stat } of files) {
    if (stat && Number.isFinite(stat.mtimeMs)) {
      newest =
        newest === undefined ? stat.mtimeMs : Math.max(newest, stat.mtimeMs);
    }
  }
  return newest === undefined ? undefined : new Date(newest).toISOString();
}

function taskRepository(task: Task): string {
  return task.repositoryId ?? task.folderPath ?? "";
}

function matches(task: Task, query: TaskUsageQuery): boolean {
  const usage = task.usage;
  if (!usage) return false;
  if (!query.includeArchived && task.archivedAt) return false;
  if (query.repository && taskRepository(task) !== query.repository) {
    return false;
  }
  if (query.harness && (task.harness ?? DEFAULT_HARNESS) !== query.harness) {
    return false;
  }
  if (
    query.model &&
    !usage.byModel.some((usage) => usage.model === query.model)
  ) {
    return false;
  }
  if (query.from || query.to) {
    const at = Date.parse(usageActivityAt(task) ?? "");
    if (Number.isNaN(at)) return false;
    const from = query.from ? boundMs(query.from, "from") : undefined;
    const to = query.to ? boundMs(query.to, "to") : undefined;
    if (from !== undefined && at < from) return false;
    if (to !== undefined && at > to) return false;
  }
  return true;
}

/** Ready usage of every task below each task (any depth, each task counted once per ancestor), by ancestor id. */
function subtaskRollups(tasks: readonly Task[]): Map<string, SubtaskUsage> {
  const sums = new Map<
    string,
    {
      buckets: TokenBuckets;
      count: number;
      cost: number;
      priced: boolean;
      costed: number;
    }
  >();
  const byId = indexTasks(tasks);
  for (const task of tasks) {
    if (!task.parentTaskId || task.usage?.status !== "ready") continue;
    const { totals, cost } = task.usage;
    // Every ancestor's total includes this task, once (ancestorsOf never repeats one).
    for (const ancestor of ancestorsOf(task, byId)) {
      let sum = sums.get(ancestor.id);
      if (!sum) {
        sum = {
          buckets: emptyBuckets(),
          count: 0,
          cost: 0,
          priced: true,
          costed: 0,
        };
        sums.set(ancestor.id, sum);
      }
      sum.buckets.input += totals.input;
      sum.buckets.output += totals.output;
      sum.buckets.cacheRead += totals.cacheRead;
      sum.buckets.cacheWrite += totals.cacheWrite;
      sum.count += 1;
      if (cost === undefined) {
        if (totals.turns > 0) sum.priced = false;
      } else {
        sum.cost += cost;
        sum.costed += 1;
      }
    }
  }
  return new Map(
    [...sums].map(([parentId, sum]) => [
      parentId,
      {
        ...sum.buckets,
        count: sum.count,
        ...(sum.priced && sum.costed > 0 ? { cost: roundCost(sum.cost) } : {}),
      },
    ]),
  );
}

/**
 * `listTaskUsage`: tasks with usage matching `query`, most tokens first
 * (ties: newest activity first), parents carrying their children's
 * roll-up (children are counted whatever the filters). `uncounted` names
 * tasks without usage that the backfill will still count: they are listed
 * as `pending` rows with zero totals (so a frontend can say "counting N
 * more"); other tasks without usage are left out.
 */
export function buildTaskUsageRows(
  listed: readonly Task[],
  query: TaskUsageQuery = {},
  uncounted: ReadonlySet<string> = new Set(),
): TaskUsageRow[] {
  const tasks = listed.map((task) =>
    !task.usage && uncounted.has(task.id)
      ? { ...task, usage: placeholderUsage("pending", task.updatedAt) }
      : task,
  );
  const rollups = subtaskRollups(tasks);
  const activity = new Map(
    tasks.map((task) => [task.id, usageActivityAt(task) ?? ""]),
  );
  return tasks
    .filter((task) => matches(task, query))
    .map((task): TaskUsageRow => {
      const subtaskUsage = rollups.get(task.id);
      return {
        taskId: task.id,
        title: task.title,
        repository: taskRepository(task),
        harness: task.harness ?? DEFAULT_HARNESS,
        state: task.state,
        ...(task.completedAt ? { completedAt: task.completedAt } : {}),
        usage: task.usage as TaskUsage,
        ...(subtaskUsage ? { subtaskUsage } : {}),
      };
    })
    .sort(
      (a, b) =>
        totalTokens(b.usage.totals) - totalTokens(a.usage.totals) ||
        (activity.get(b.taskId) ?? "").localeCompare(
          activity.get(a.taskId) ?? "",
        ),
    );
}
