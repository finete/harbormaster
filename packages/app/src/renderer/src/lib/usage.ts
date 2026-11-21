// Pure display rules for per-task token usage (docs/costs.md): the
// workspace chip + popover, the board card line, the Costs view and its
// CSV export. Tokens are the primary figure; `$` is shown only where the
// harness wrote a cost (always as an estimate, `~$`), and missing evidence
// stays "n/a", never zero.
//
// `formatTokenCount` is core's own utility (a dependency-free module),
// imported by path: the package index pulls in core's Node-only runtime,
// which must never reach the renderer bundle.
import {
  childrenIndex,
  descendantsOf,
} from "@harbormaster/core/dist/engines/task-tree.js";
import { formatTokenCount } from "@harbormaster/core/dist/utilities/format-token-count.js";
import type {
  Task,
  TaskUsage,
  TaskUsageRow,
  TokenBuckets,
} from "../../../preload/api";

export { formatTokenCount };

export function totalTokens(buckets: TokenBuckets): number {
  return (
    buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite
  );
}

/** `~$23.10`: always an estimate, never a bare `$`. */
export function formatCost(cost: number): string {
  return `~$${cost.toFixed(2)}`;
}

/** The popover's cost label (decision 3): who priced it, and that it is not a bill. */
export function costLabel(costSource: string | undefined): string {
  return `est. by ${costSourceName(costSource)} at list price · not your bill`;
}

function costSourceName(costSource: string | undefined): string {
  if (!costSource) return "the agent";
  if (costSource === "pi") return "Pi";
  return costSource;
}

/** Why a task's usage is unavailable, for tooltips. */
export function unavailableReason(usage: TaskUsage): string {
  switch (usage.reason) {
    case "unsupported":
      return "This agent does not record token usage Harbormaster can read.";
    case "missing-session":
      return "The task's session files are gone, so its usage can't be counted.";
    default:
      return "Usage is unavailable for this task.";
  }
}

/** `"9.8M tok · ~$23.10"` for ready usage; `"…"` pending; `"usage n/a"` unavailable. */
export function usageSummary(usage: TaskUsage): string {
  if (usage.status === "pending") return "…";
  if (usage.status === "unavailable") return "usage n/a";
  const tokens = `${formatTokenCount(totalTokens(usage.totals))} tok`;
  return usage.cost !== undefined
    ? `${tokens} · ${formatCost(usage.cost)}`
    : tokens;
}

/** A board card's usage line (`"◔ 9.8M tok · ~$23.10"`): ready usage with tokens only. */
export function cardUsageLine(
  usage: TaskUsage | undefined,
): string | undefined {
  if (usage?.status !== "ready" || totalTokens(usage.totals) === 0) {
    return undefined;
  }
  return `◔ ${usageSummary(usage)}`;
}

/** The trailing path segment's id part of a session file, shortened (`019a…`). */
export function shortSessionId(sessionPath: string): string {
  const file = sessionPath.split(/[\\/]/).pop() ?? sessionPath;
  const stem = file.replace(/\.jsonl$/, "");
  // Pi names files `<timestamp>_<uuid>`; Claude Code `<uuid>`.
  const id = stem.includes("_") ? stem.slice(stem.lastIndexOf("_") + 1) : stem;
  return id.slice(0, 8);
}

/** Ready usage of every task below `parentTaskId` (any depth, each once) summed, like core's `subtaskUsage` (cost only if every such task with turns had one). */
export function subtaskRollup(
  tasks: readonly Task[],
  parentTaskId: string,
): (TokenBuckets & { count: number; cost?: number }) | undefined {
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let count = 0;
  let cost = 0;
  let costed = 0;
  let priced = true;
  const below = new Set(
    descendantsOf(parentTaskId, childrenIndex(tasks)).map((t) => t.id),
  );
  for (const task of tasks) {
    if (!below.has(task.id)) continue;
    const usage = task.usage;
    if (usage?.status !== "ready") continue;
    sum.input += usage.totals.input;
    sum.output += usage.totals.output;
    sum.cacheRead += usage.totals.cacheRead;
    sum.cacheWrite += usage.totals.cacheWrite;
    count += 1;
    if (usage.cost === undefined) {
      if (usage.totals.turns > 0) priced = false;
    } else {
      cost += usage.cost;
      costed += 1;
    }
  }
  if (count === 0) return undefined;
  return {
    ...sum,
    count,
    ...(priced && costed > 0 ? { cost } : {}),
  };
}

/** How many board cards always show their usage line (decision 7b). */
export const PINNED_USAGE_CARDS = 3;

/**
 * The (up to) `limit` tasks with the most tokens among `visibleTaskIds`
 * (the cards currently rendered on the board): their usage line is always
 * shown. Only ready usage with at least one token counts; ties keep the
 * board order.
 */
export function topUsageTaskIds(
  tasks: readonly Task[],
  visibleTaskIds: Iterable<string>,
  limit = PINNED_USAGE_CARDS,
): Set<string> {
  const visible = new Set(visibleTaskIds);
  return new Set(
    tasks
      .filter(
        (task) =>
          visible.has(task.id) &&
          task.usage?.status === "ready" &&
          totalTokens(task.usage.totals) > 0,
      )
      .map((task, index) => ({
        id: task.id,
        tokens: totalTokens((task.usage as TaskUsage).totals),
        index,
      }))
      .sort((a, b) => b.tokens - a.tokens || a.index - b.index)
      .slice(0, limit)
      .map((entry) => entry.id),
  );
}

// --- Costs view -----------------------------------------------------------

export type UsageRange = "week" | "month" | "all";

export const USAGE_RANGES: ReadonlyArray<{ value: UsageRange; label: string }> =
  [
    { value: "week", label: "This week" },
    { value: "month", label: "This month" },
    { value: "all", label: "All" },
  ];

/**
 * The `listTaskUsage` bounds for a range, in local time: this week starts
 * Monday 00:00, this month on the 1st 00:00; both run to now (no `to`).
 */
export function usageRangeBounds(
  range: UsageRange,
  now: Date,
): { from?: string; to?: string } {
  if (range === "all") return {};
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "week") {
    const sinceMonday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - sinceMonday);
  } else {
    start.setDate(1);
  }
  return { from: start.toISOString() };
}

export interface UsageFilter {
  repository?: string | undefined;
  harness?: string | undefined;
  model?: string | undefined;
}

/** Same semantics as core's `TaskUsageQuery` repository/harness/model filters. */
export function filterUsageRows(
  rows: readonly TaskUsageRow[],
  filter: UsageFilter,
): TaskUsageRow[] {
  return rows.filter(
    (row) =>
      (!filter.repository || row.repository === filter.repository) &&
      (!filter.harness || row.harness === filter.harness) &&
      (!filter.model ||
        row.usage.byModel.some((model) => model.model === filter.model)),
  );
}

/** Distinct, sorted filter options derived from the rows. */
export function usageFilterOptions(rows: readonly TaskUsageRow[]): {
  repositories: string[];
  harnesses: string[];
  models: string[];
} {
  const repositories = new Set<string>();
  const harnesses = new Set<string>();
  const models = new Set<string>();
  for (const row of rows) {
    if (row.repository) repositories.add(row.repository);
    harnesses.add(row.harness);
    for (const model of row.usage.byModel) models.add(model.model);
  }
  const sorted = (set: Set<string>) =>
    [...set].sort((a, b) => a.localeCompare(b));
  return {
    repositories: sorted(repositories),
    harnesses: sorted(harnesses),
    models: sorted(models),
  };
}

/** Ready tokens of a row, own usage only (0 when not ready: such rows sort last). */
export function rowTokens(row: TaskUsageRow): number {
  return row.usage.status === "ready" ? totalTokens(row.usage.totals) : 0;
}

/**
 * A row's tokens including its subtasks' roll-up (`subtaskUsage`): the
 * Costs table's primary, sorted-on figure. Equals `rowTokens` for a row
 * without subtasks; 0 when the row's own usage is not ready.
 */
export function rowInclusiveTokens(row: TaskUsageRow): number {
  if (row.usage.status !== "ready") return 0;
  return (
    rowTokens(row) + (row.subtaskUsage ? totalTokens(row.subtaskUsage) : 0)
  );
}

/** A row's `$` including its subtasks' when both are priced; else its own (possibly absent). */
export function rowInclusiveCost(row: TaskUsageRow): number | undefined {
  const own = row.usage.cost;
  const subtasks = row.subtaskUsage?.cost;
  return own !== undefined && subtasks !== undefined ? own + subtasks : own;
}

/**
 * One table cell's figure: `primary` is the inclusive figure; `own` is set
 * only when it reads differently at the displayed precision (rendered
 * `"<incl> · own <own>"`), otherwise the single figure is enough.
 */
export interface UsageFigure {
  primary: string;
  own?: string;
}

function figure(inclusive: string, own: string): UsageFigure {
  return inclusive === own
    ? { primary: inclusive }
    : { primary: inclusive, own };
}

/** The Tokens cell of a ready row (inclusive first, own muted when it differs). */
export function tokensFigure(row: TaskUsageRow): UsageFigure {
  return figure(
    formatTokenCount(rowInclusiveTokens(row)),
    formatTokenCount(rowTokens(row)),
  );
}

/** The Est. $ cell, `undefined` when the row has no own cost (`—`). */
export function costFigure(row: TaskUsageRow): UsageFigure | undefined {
  const own = row.usage.cost;
  if (own === undefined) return undefined;
  return figure(formatCost(rowInclusiveCost(row) ?? own), formatCost(own));
}

/**
 * Rows the backfill has not counted yet (`pending`): hidden from the
 * table, group-by and CSV; the totals line says "counting N more…".
 */
export function isCountingRow(row: TaskUsageRow): boolean {
  return row.usage.status === "pending";
}

/**
 * The Costs search box: case-insensitive substring over the task title,
 * repository, harness and model ids. Blank text keeps every row.
 */
export function searchUsageRows(
  rows: readonly TaskUsageRow[],
  text: string,
): TaskUsageRow[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) =>
    [
      row.title,
      row.repository,
      row.harness,
      ...row.usage.byModel.map((model) => model.model),
    ].some((value) => value.toLowerCase().includes(needle)),
  );
}

export type UsageSort = "tokens" | "cost";

/**
 * Most first by the inclusive figure (own + subtasks, what the cell shows
 * first); rows without usage (or cost, for `cost`) last, then by title.
 */
export function sortUsageRows(
  rows: readonly TaskUsageRow[],
  sort: UsageSort,
): TaskUsageRow[] {
  const ready = (row: TaskUsageRow) => (row.usage.status === "ready" ? 1 : 0);
  return [...rows].sort((a, b) => {
    if (sort === "cost") {
      const delta = (rowInclusiveCost(b) ?? -1) - (rowInclusiveCost(a) ?? -1);
      if (delta !== 0) return delta;
    }
    return (
      ready(b) - ready(a) ||
      rowInclusiveTokens(b) - rowInclusiveTokens(a) ||
      a.title.localeCompare(b.title)
    );
  });
}

export interface UsageTotals {
  tasks: number;
  tokens: number;
  /** Sum of the rows' costs; absent when no row has one. */
  cost?: number;
}

/** Tooltip on the Costs totals line. */
export const USAGE_TOTALS_TITLE = "own usage per task; subtasks counted once";

/** The totals line: own usage only (children are rows of their own), so nothing is counted twice. */
export function usageTotals(rows: readonly TaskUsageRow[]): UsageTotals {
  let tokens = 0;
  let cost = 0;
  let priced = false;
  for (const row of rows) {
    tokens += rowTokens(row);
    if (row.usage.cost !== undefined) {
      cost += row.usage.cost;
      priced = true;
    }
  }
  return { tasks: rows.length, tokens, ...(priced ? { cost } : {}) };
}

export type UsageGroupBy = "task" | "repo" | "harness" | "model";

export interface UsageGroup {
  key: string;
  /** Distinct tasks contributing. */
  tasks: number;
  tokens: number;
  turns: number;
  cost?: number;
}

/**
 * Client-side aggregation for the group-by strip (not `task`, which is the
 * plain row table). By model, each task contributes its per-model figures;
 * otherwise its totals. Only ready usage counts; most tokens first.
 */
export function groupUsageRows(
  rows: readonly TaskUsageRow[],
  by: Exclude<UsageGroupBy, "task">,
): UsageGroup[] {
  const groups = new Map<
    string,
    { tasks: Set<string>; tokens: number; turns: number; cost?: number }
  >();
  const add = (
    key: string,
    taskId: string,
    tokens: number,
    turns: number,
    cost: number | undefined,
  ) => {
    let group = groups.get(key);
    if (!group) {
      group = { tasks: new Set(), tokens: 0, turns: 0 };
      groups.set(key, group);
    }
    group.tasks.add(taskId);
    group.tokens += tokens;
    group.turns += turns;
    if (cost !== undefined) group.cost = (group.cost ?? 0) + cost;
  };
  for (const row of rows) {
    const usage = row.usage;
    if (usage.status !== "ready") continue;
    if (by === "model") {
      for (const model of usage.byModel) {
        add(
          model.model,
          row.taskId,
          totalTokens(model),
          model.turns,
          model.cost,
        );
      }
      continue;
    }
    const key =
      by === "repo" ? row.repository || "(no repository)" : row.harness;
    add(
      key,
      row.taskId,
      totalTokens(usage.totals),
      usage.totals.turns,
      usage.cost,
    );
  }
  return [...groups]
    .map(([key, group]) => ({
      key,
      tasks: group.tasks.size,
      tokens: group.tokens,
      turns: group.turns,
      ...(group.cost !== undefined ? { cost: group.cost } : {}),
    }))
    .sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
}

// --- CSV export -----------------------------------------------------------

export const USAGE_CSV_COLUMNS = [
  "taskId",
  "title",
  "repository",
  "harness",
  "state",
  "completedAt",
  "models",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "totalTokens",
  "turns",
  "cost",
  "costSource",
  "subtaskCount",
  "subtaskTokens",
] as const;

/** One RFC 4180 field: quoted when it holds a comma, quote, CR or LF. */
export function csvField(value: string | number | undefined): string {
  if (value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The Costs table as CSV (RFC 4180: CRLF line ends, header row): one flat
 * row per task, raw numbers. Token fields stay empty for usage that is not
 * ready (unavailable is never zero); `models` is `;`-separated.
 */
export function usageRowsToCsv(rows: readonly TaskUsageRow[]): string {
  const lines = [USAGE_CSV_COLUMNS.join(",")];
  for (const row of rows) {
    const usage = row.usage;
    const ready = usage.status === "ready";
    const record: Record<
      (typeof USAGE_CSV_COLUMNS)[number],
      string | number | undefined
    > = {
      taskId: row.taskId,
      title: row.title,
      repository: row.repository,
      harness: row.harness,
      state: row.state,
      completedAt: row.completedAt,
      models: usage.byModel.map((model) => model.model).join(";"),
      input: ready ? usage.totals.input : undefined,
      output: ready ? usage.totals.output : undefined,
      cacheRead: ready ? usage.totals.cacheRead : undefined,
      cacheWrite: ready ? usage.totals.cacheWrite : undefined,
      totalTokens: ready ? totalTokens(usage.totals) : undefined,
      turns: ready ? usage.totals.turns : undefined,
      cost: usage.cost,
      costSource: usage.cost !== undefined ? usage.costSource : undefined,
      subtaskCount: row.subtaskUsage?.count,
      subtaskTokens: row.subtaskUsage
        ? totalTokens(row.subtaskUsage)
        : undefined,
    };
    lines.push(
      USAGE_CSV_COLUMNS.map((column) => csvField(record[column])).join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** `costs-2026-11-16.csv` (local date). */
export function usageCsvFileName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `costs-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
}
